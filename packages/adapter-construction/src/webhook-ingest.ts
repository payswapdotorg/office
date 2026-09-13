// Office adapter-construction — CDE webhook ingest (OFF-021).
//
// What comes BACK from the construction provider: the CDE pushes events in
// its OWN WIRE FORMAT — { kind: 'cde-webhook-event', eventType:
// '<object-kind>.<created|updated|deleted>', objectId, revisionTag,
// occurredAt, payload } — signed with the provider's signature header. This
// module owns that provider-specific format (all of it lives HERE, freeze
// A6: no provider shape ever reaches a core package) and maps it into the
// SDK's provider-neutral ProviderWebhookBody before the SDK's intake engine
// runs.
//
// The intake pipeline (ingestCdeWebhook), layered over the SDK engine:
//   1. JSON-exactness — the wire body must parse as an adapter JSON value;
//   2. PROVIDER SIGNATURE — the injected WebhookSignatureVerifier checks the
//      provider's header over the WIRE body (the bytes the provider signed —
//      authenticity is established at the provider boundary, BEFORE any
//      translation);
//   3. TRANSLATION — the wire body maps fail-closed into the SDK's
//      ProviderWebhookBody (strict keys, eventType grammar, declared object
//      kinds only);
//   4. DIVERGENCE PRE-CHECK — if the source is already mapped, the webhook
//      carries a NEW provider version, AND the canonical aggregate moved
//      independently since the last synchronized point, an explicit Conflict
//      record (both sides) is appended and NO command is proposed (the SDK's
//      webhook engine has no conflict store; this package composes one over
//      the SDK's detectedConflict + ConflictStore — never a silent
//      last-write-wins, the frozen anti-pattern);
//   5. SDK ENGINE — otherwise the translated body plus the translation
//      layer's integrity checksum header go to applyWebhook: SourceRef
//      resolution, mapping bookkeeping, and the typed command proposal. The
//      translation-integrity verifier injected there checks that the body
//      the SDK normalizes is EXACTLY the body this translation produced
//      (integrity binding; authenticity was already established in step 2 —
//      the runtime replaces both deterministic conventions with its real
//      crypto policy at the port).
//
// Determinism: the signature and checksum conventions are pure sha256
// derivations (like the SDK's fake fixture); same webhook → same dedup key,
// and the same command idempotency key the sync path derives for the same
// provider object version (cross-path convergence).
import { createHash } from 'node:crypto';
import { parseFail, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, ParseResult, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  applyWebhook,
  detectedConflict,
  isAdapterJsonObject,
  parseAdapterJsonValue,
  parseProviderObjectId,
  parseProviderVersion,
  sourceCoordinate,
  sourceRef,
} from '@office/adapters-sdk';
import type {
  Adapter,
  AdapterAuthorization,
  AdapterCommandTranslator,
  AdapterJsonObject,
  AdapterJsonValue,
  Conflict,
  ConflictStore,
  NormalizedWebhook,
  ProviderWebhookBody,
  RawWebhook,
  SourceMapping,
  WebhookEngineDeps,
  WebhookOutcome,
  WebhookSignatureVerifier,
} from '@office/adapters-sdk';
import { CONSTRUCTION_OBJECT_KINDS } from './vocabulary';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';

// ---- the CDE wire format + signature conventions ---------------------------

/** The header carrying the provider's signature over the WIRE body. */
export const CDE_WEBHOOK_SIGNATURE_HEADER = 'x-cde-signature';

/** The header carrying the translation layer's integrity checksum. */
export const CDE_TRANSLATION_CHECKSUM_HEADER = 'x-cde-translation';

const SIGNATURE_PREFIX = 'sha256=';

/** The CDE event-kind wire vocabulary (the closed push semantics). */
const WIRE_EVENT_KINDS = ['created', 'updated', 'deleted'] as const;

/** Shape description used in parse failures. */
export const CDE_WEBHOOK_WIRE_GRAMMAR =
  "CDE webhook wire body: { kind: 'cde-webhook-event', eventType: '<declared-object-kind>.<created|updated|deleted>', objectId, revisionTag, occurredAt: Timestamp | null, payload: JSON object }";

const WIRE_BODY_KEYS = [
  'kind',
  'eventType',
  'objectId',
  'revisionTag',
  'occurredAt',
  'payload',
] as const;

const WIRE_EVENT_TYPE_RULE = {
  min: 3,
  max: 129,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}\.[a-z]+$/,
  description: "eventType '<object-kind>.<created|updated|deleted>'",
};

/**
 * The deterministic signature of a CDE wire body (the fixture's stand-in for
 * the provider's real signature scheme — an injected PORT, like production).
 */
export const cdeWebhookSignature = (body: unknown): string =>
  `${SIGNATURE_PREFIX}${createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')}`;

/**
 * The deterministic integrity checksum of a TRANSLATED body (what the
 * translation layer hands the SDK engine): binds the SDK's normalization
 * input to exactly the value this translation produced.
 */
export const cdeTranslationChecksum = (body: unknown): string =>
  `${SIGNATURE_PREFIX}${createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')}`;

/**
 * The CDE provider-signature verifier (the injected port's test double):
 * accepts a webhook exactly when the signature header matches the
 * deterministic signature of the parsed body it is handed.
 */
export function createCdeWebhookVerifier(): WebhookSignatureVerifier {
  return {
    verify(input) {
      const provided = input.headers[CDE_WEBHOOK_SIGNATURE_HEADER];
      const expected = cdeWebhookSignature(input.body);
      if (provided === expected) return ok(true);
      return fail(
        domainError(
          'unauthorized',
          `CDE webhook signature verification failed for adapter '${input.adapterKind}' system '${input.systemId}'`,
          [{ code: 'webhook-signature-invalid', message: 'header mismatch', path: null }],
        ),
      );
    },
  };
}

/**
 * The translation-integrity verifier for the SDK-facing surface: accepts
 * exactly the translated body whose checksum the translation layer recorded
 * (authenticity was established over the provider's WIRE body before the
 * translation ran — see ingestCdeWebhook's step 2).
 */
export function createCdeTranslationVerifier(): WebhookSignatureVerifier {
  return {
    verify(input) {
      const provided = input.headers[CDE_TRANSLATION_CHECKSUM_HEADER];
      const expected = cdeTranslationChecksum(input.body);
      if (provided === expected) return ok(true);
      return fail(
        domainError(
          'unauthorized',
          `CDE webhook translation integrity check failed for adapter '${input.adapterKind}' system '${input.systemId}' — the body does not match the translated value`,
          [{ code: 'translation-integrity-invalid', message: 'header mismatch', path: null }],
        ),
      );
    },
  };
}

// ---- the wire → ProviderWebhookBody translation -----------------------------

/** The wire body's occurredAt: a contracts timestamp, or null. */
const parseWireOccurredAt = (value: unknown): ParseResult<Timestamp> => {
  if (typeof value !== 'string') {
    return parseFail('invalid-type', '', 'an ISO-8601 UTC timestamp or null', describeValue(value));
  }
  return parseTimestamp(value);
};

/** Translate one CDE wire body into the SDK's ProviderWebhookBody (fail-closed). */
export function translateCdeWebhookBody(raw: unknown): Result<ProviderWebhookBody, DomainError> {
  if (!isPlainObject(raw)) {
    return wireFailure('invalid-type', '', 'an object', raw);
  }
  const unknownKey = unknownKeyFailure(raw, WIRE_BODY_KEYS, '', CDE_WEBHOOK_WIRE_GRAMMAR);
  if (unknownKey) return wireFailureOf(unknownKey.error);
  const kind = requireLiteral(raw, 'kind', '', ['cde-webhook-event']);
  if (!kind.ok) return wireFailureOf(kind.error);
  const eventType = requireString(raw, 'eventType', '', WIRE_EVENT_TYPE_RULE);
  if (!eventType.ok) return wireFailureOf(eventType.error);
  const [objectTypeRaw, eventKindRaw] = eventType.value.split('.');
  const declared = CONSTRUCTION_OBJECT_KINDS.find((entry) => entry === objectTypeRaw);
  if (declared === undefined) {
    return wireFailure(
      'invalid-value',
      'eventType',
      `an eventType of one of the declared object kinds (${CONSTRUCTION_OBJECT_KINDS.join(', ')})`,
      eventType.value,
    );
  }
  const eventKind = WIRE_EVENT_KINDS.find((entry) => entry === eventKindRaw);
  if (eventKind === undefined) {
    return wireFailure(
      'invalid-value',
      'eventType',
      "an event kind of 'created' | 'updated' | 'deleted'",
      eventType.value,
    );
  }
  const objectId = requireFieldWith(raw, 'objectId', '', parseProviderObjectId);
  if (!objectId.ok) return wireFailureOf(objectId.error);
  const version = requireFieldWith(raw, 'revisionTag', '', parseProviderVersion);
  if (!version.ok) return wireFailureOf(version.error);
  const occurredAt = requireNullableFieldWith(raw, 'occurredAt', '', parseWireOccurredAt);
  if (!occurredAt.ok) return wireFailureOf(occurredAt.error);
  const payload = raw['payload'];
  if (!isAdapterJsonObject(payload)) {
    return wireFailure('invalid-type', 'payload', 'a JSON object', payload);
  }
  return ok({
    kind: 'provider-webhook-body',
    eventKind,
    objectType: declared,
    objectId: objectId.value,
    version: version.value,
    occurredAt: occurredAt.value,
    data: payload as AdapterJsonObject,
  } satisfies ProviderWebhookBody);
}

// ---- the intake engine ------------------------------------------------------

/** Injected dependencies of the CDE webhook intake (the SDK ports + conflicts). */
export interface CdeWebhookEngineDeps extends WebhookEngineDeps {
  /** The conflict store divergence records land in (the SDK engine has none). */
  readonly conflicts: ConflictStore;
}

/** The per-webhook CDE intake outcome vocabulary. */
export type CdeWebhookOutcomeKind = WebhookOutcome['outcome'] | 'conflict-detected';

/** The result of applying one CDE webhook end to end. */
export interface CdeWebhookOutcome {
  readonly kind: 'cde-webhook-outcome';
  /** The normalized envelope the SDK engine composed (null on the conflict branch). */
  readonly envelope: NormalizedWebhook | null;
  /** The source mapping AFTER intake (null only for deletion of unknown sources). */
  readonly mapping: SourceMapping | null;
  /** The proposed canonical command, or null for the no-op/conflict outcomes. */
  readonly command: CommandEnvelope<AdapterJsonObject> | null;
  /** The explicit conflict record, exactly when divergence was detected. */
  readonly conflict: Conflict | null;
  /** Which intake branch ran. */
  readonly outcome: CdeWebhookOutcomeKind;
}

/**
 * Ingest one raw CDE webhook push end to end: JSON-exactness → provider
 * signature over the WIRE body → fail-closed translation → divergence
 * pre-check (explicit conflict record, both sides, no command) → the SDK's
 * applyWebhook intake (SourceRef resolution + typed command proposal).
 * Every failure is a typed DomainError value.
 */
export async function ingestCdeWebhook(request: {
  readonly authorization: AdapterAuthorization;
  readonly adapter: Adapter;
  readonly translator: AdapterCommandTranslator;
  /** The injected provider-signature verifier (checks the WIRE body). */
  readonly verifier: WebhookSignatureVerifier;
  readonly deps: CdeWebhookEngineDeps;
  /** The raw push exactly as the runtime received it (wire-format body). */
  readonly raw: RawWebhook;
}): Promise<Result<CdeWebhookOutcome, DomainError>> {
  const tenantId = request.authorization.context.scope.tenantId;
  const scope = { kind: 'tenant', tenantId } as const;
  const now = request.deps.now();

  // Routing: the push must belong to THIS adapter family.
  if (request.raw.adapterKind !== request.adapter.kind) {
    return fail(
      domainError(
        'invariant-violation',
        `webhook routed to adapter '${request.raw.adapterKind}' but presented to adapter '${request.adapter.kind}'`,
        [{ code: 'adapter-kind-mismatch', message: request.raw.adapterKind, path: 'adapterKind' }],
        { scope },
      ),
    );
  }

  // 1. JSON-exactness of the wire body.
  const wireBody = parseAdapterJsonValue(request.raw.body, 'body');
  if (!wireBody.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `CDE webhook wire body is not JSON-exact: ${wireBody.error.code} at '${wireBody.error.path === '' ? '<root>' : wireBody.error.path}'`,
        [
          {
            code: `webhook-body-${wireBody.error.code}`,
            message: wireBody.error.received,
            path: wireBody.error.path === '' ? null : wireBody.error.path,
          },
        ],
        { scope },
      ),
    );
  }

  // 2. The PROVIDER signature over the WIRE body (authenticity boundary).
  const verified = request.verifier.verify({
    adapterKind: request.raw.adapterKind,
    systemId: request.raw.systemId,
    headers: request.raw.headers,
    body: wireBody.value,
  });
  if (!verified.ok) return verified;

  // 3. Fail-closed translation into the SDK's provider-neutral body.
  const translated = translateCdeWebhookBody(wireBody.value);
  if (!translated.ok) return translated;
  const body = translated.value;
  const source = sourceRef({
    adapterKind: request.raw.adapterKind,
    systemId: request.raw.systemId,
    objectType: body.objectType,
    objectId: body.objectId,
    version: body.version,
  });

  // 4. Divergence pre-check: BOTH sides moved since the last synchronized
  //    point → an explicit conflict record, no command, never last-write-wins.
  const mapping = await request.deps.mappings.findByCoordinate(
    tenantId,
    sourceCoordinate({
      adapterKind: source.adapterKind,
      systemId: source.systemId,
      objectType: source.objectType,
      objectId: source.objectId,
    }),
  );
  if (mapping !== null) {
    const current = await request.deps.canonicalVersionOf(tenantId, mapping.canonical);
    if (!current.ok) return current;
    const providerMoved = body.version !== mapping.providerVersion;
    const canonicalMoved = current.value !== null && current.value !== mapping.canonicalVersion;
    if (providerMoved && canonicalMoved) {
      const conflict = detectedConflict({
        tenantId,
        source,
        canonical: mapping.canonical,
        canonicalVersion: current.value,
        detectedAt: now,
        detectedBy: request.authorization.context.actor,
      });
      const appended = await request.deps.conflicts.append(conflict);
      if (!appended.ok) return appended;
      return ok({
        kind: 'cde-webhook-outcome',
        envelope: null,
        mapping,
        command: null,
        conflict: appended.value,
        outcome: 'conflict-detected',
      } satisfies CdeWebhookOutcome);
    }
  }

  // 5. The SDK's intake engine over the translated body, with the
  //    translation-integrity verifier binding the body it normalizes to
  //    exactly the value this translation produced.
  const applied = await applyWebhook({
    authorization: request.authorization,
    adapter: request.adapter,
    translator: request.translator,
    verifier: createCdeTranslationVerifier(),
    deps: request.deps,
    raw: {
      kind: 'raw-webhook',
      adapterKind: request.raw.adapterKind,
      systemId: request.raw.systemId,
      headers: {
        ...request.raw.headers,
        [CDE_TRANSLATION_CHECKSUM_HEADER]: cdeTranslationChecksum(body),
      },
      // The translated value is JSON-exact by construction (composed from
      // the parsed wire body's own validated parts).
      body: body as unknown as AdapterJsonValue,
    },
  });
  if (!applied.ok) return applied;
  return ok({
    kind: 'cde-webhook-outcome',
    envelope: applied.value.envelope,
    mapping: applied.value.mapping,
    command: applied.value.command,
    conflict: null,
    outcome: applied.value.outcome,
  } satisfies CdeWebhookOutcome);
}

// ---- local failure constructors ---------------------------------------------

/** The wire-body parse error shape (code/path/expected/received). */
interface WireParseError {
  readonly code: string;
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

const wireFailure = (
  code: string,
  path: string,
  expected: string,
  received: unknown,
): Result<never, DomainError> =>
  fail(
    domainError(
      'invariant-violation',
      `CDE webhook wire body failed fail-closed parsing: ${code} at '${path === '' ? '<root>' : path}'`,
      [
        {
          code: `cde-webhook-${code}`,
          message: typeof received === 'string' ? received : describeValue(received),
          path: path === '' ? null : path,
        },
      ],
    ),
  );

const wireFailureOf = (error: WireParseError): Result<never, DomainError> =>
  wireFailure(error.code, error.path, error.expected, error.received);
