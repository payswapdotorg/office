// Office adapters-sdk — webhook normalization + intake engine (OFF-020).
//
// What comes BACK from providers: an inbound provider push is verified,
// parsed, and normalized into ONE typed envelope — the NormalizedWebhook —
// carrying (SourceRef, event kind, payload) plus the deterministic replay
// deduplication key and the receivedAt instant from the injected clock.
//
// The signature check is an injected PORT (WebhookSignatureVerifier): the SDK
// performs no crypto policy of its own — the runtime injects the real
// verifier for its provider, the fake fixture injects the deterministic test
// verifier. Verification runs over the parsed JSON body plus the original
// headers, fail-closed: a rejected signature is a typed unauthorized.
//
// Adapters NEVER write the graph (freeze A8/A11): applyWebhook resolves the
// source mapping, then asks the ADAPTER's command translator to propose the
// canonical command, and returns a full typed CommandEnvelope for the Action
// Gateway / application layer to execute. The proposed command's idempotency
// key is derived deterministically from the SourceRef (source-ref.ts), so a
// redelivered webhook — or the same provider version arriving later through
// a sync page — converges on one command per provider object version instead
// of double-applying.
import { createHash } from 'node:crypto';
import { parseFail, parseOk, parseTimestamp } from '@office/contracts';
import type {
  CommandEnvelope,
  ParseResult,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { authorize, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy } from '@office/authz';
import type { AdapterJsonObject, AdapterJsonValue } from './json';
import { parseAdapterJsonObject, parseAdapterJsonValue } from './json';
import type { Adapter } from './adapter';
import { requireAdapterActor } from './adapter';
import {
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
  describeValue,
} from './parse';
import {
  parseProviderObjectKind,
  parseProviderObjectId,
  parseProviderVersion,
} from './identity';
import type {
  AdapterKind,
  ProviderObjectKind,
  ProviderObjectId,
  ProviderSystemId,
  ProviderVersion,
} from './identity';
import { coordinateOf, sourceCorrelationId, sourceRef } from './source-ref';
import type { SourceRef } from './source-ref';
import {
  assertMappingTenant,
  recordSourceMapping,
  sourceMapping,
} from './mapping';
import type { SourceMapping, SourceMappingStore } from './mapping';
import {
  adapterCommandEnvelope,
  causationIdOfWebhook,
  checkCommandEnvelopeRoundTrip,
} from './commands';
import type {
  AdapterCommandInput,
  AdapterCommandTranslator,
  CanonicalVersionLookup,
  EngineClock,
  CanonicalIdSupplier,
} from './commands';


declare const webhookDeduplicationKeyBrand: unique symbol;

/** The deterministic replay-deduplication key of one provider webhook event. */
export type WebhookDeduplicationKey = string & {
  readonly [webhookDeduplicationKeyBrand]: 'WebhookDeduplicationKey';
};

/** Grammar description used in parse failures. */
export const WEBHOOK_DEDUPLICATION_KEY_GRAMMAR =
  'office-whk-v1-<opaque: 16..64 lowercase alphanumeric> (derived deterministically from the provider event identity)';

const WEBHOOK_DEDUPLICATION_KEY_PREFIX = 'office-whk-v1-';
const WEBHOOK_DEDUPLICATION_KEY_PATTERN = /^[0-9a-z]{16,64}$/;
const DERIVED_OPAQUE_LENGTH = 32;

/** Parse an untrusted value as a WebhookDeduplicationKey (total, fail-closed). */
export function parseWebhookDeduplicationKey(
  raw: unknown,
): ParseResult<WebhookDeduplicationKey> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(WEBHOOK_DEDUPLICATION_KEY_PREFIX) ||
    !WEBHOOK_DEDUPLICATION_KEY_PATTERN.test(
      raw.slice(WEBHOOK_DEDUPLICATION_KEY_PREFIX.length),
    )
  ) {
    return parseFail('invalid-value', '', WEBHOOK_DEDUPLICATION_KEY_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as WebhookDeduplicationKey);
}

/** Type guard for structurally valid WebhookDeduplicationKey values. */
export function isWebhookDeduplicationKey(raw: unknown): raw is WebhookDeduplicationKey {
  return parseWebhookDeduplicationKey(raw).ok;
}

/** The closed provider event-kind vocabulary (inbound push semantics). */
export type ProviderEventKind = 'created' | 'updated' | 'deleted';

/**
 * The raw inbound webhook as the runtime hands it to the SDK: the routing
 * identity (adapter kind + provider system), the original headers (for the
 * injected signature verifier), and the parsed JSON body. Adapters translate
 * their provider's wire format into this shape before normalization; the
 * verifier checks the headers against the parsed body.
 */
export interface RawWebhook {
  readonly kind: 'raw-webhook';
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * The signature-check PORT (injected): verify one inbound webhook's
 * authenticity. The input is exactly what the runtime received; a rejected
 * signature is a typed unauthorized failure. The SDK defines the port — the
 * runtime and real adapters own the crypto.
 */
export interface WebhookSignatureVerifier {
  verify(input: WebhookSignatureInput): Result<true, DomainError>;
}

/** What a verifier sees: routing identity, original headers, parsed body. */
export interface WebhookSignatureInput {
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed JSON body (JSON-exact — see normalizeWebhook's order). */
  readonly body: AdapterJsonValue;
}

/**
 * The adapter-side normalized webhook body — the contract every adapter maps
 * its provider's push payload into before the SDK normalizes further.
 * Strict keys; `data` is the provider's event payload (extension bag).
 */
export interface ProviderWebhookBody {
  readonly kind: 'provider-webhook-body';
  readonly eventKind: ProviderEventKind;
  readonly objectType: ProviderObjectKind;
  readonly objectId: ProviderObjectId;
  readonly version: ProviderVersion;
  /** The provider's own instant for the event, or null when it has none. */
  readonly occurredAt: Timestamp | null;
  readonly data: AdapterJsonObject;
}

/** Shape description used in parse failures. */
export const PROVIDER_WEBHOOK_BODY_GRAMMAR =
  "ProviderWebhookBody: { kind: 'provider-webhook-body', eventKind: 'created' | 'updated' | 'deleted', objectType, objectId, version, occurredAt: Timestamp | null, data: JSON object }";

const PROVIDER_WEBHOOK_BODY_KEYS = [
  'kind',
  'eventKind',
  'objectType',
  'objectId',
  'version',
  'occurredAt',
  'data',
] as const;

/** Parse an untrusted value as a ProviderWebhookBody (strict keys). */
export function parseProviderWebhookBody(raw: unknown): ParseResult<ProviderWebhookBody> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PROVIDER_WEBHOOK_BODY_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    PROVIDER_WEBHOOK_BODY_KEYS,
    '',
    PROVIDER_WEBHOOK_BODY_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['provider-webhook-body']);
  if (!kind.ok) return kind;
  const eventKind = requireLiteral(raw, 'eventKind', '', ['created', 'updated', 'deleted']);
  if (!eventKind.ok) return eventKind;
  const objectType = requireFieldWith(raw, 'objectType', '', parseProviderObjectKind);
  if (!objectType.ok) return objectType;
  const objectId = requireFieldWith(raw, 'objectId', '', parseProviderObjectId);
  if (!objectId.ok) return objectId;
  const version = requireFieldWith(raw, 'version', '', parseProviderVersion);
  if (!version.ok) return version;
  const occurredAt = requireNullableFieldWith(raw, 'occurredAt', '', parseTimestamp);
  if (!occurredAt.ok) return occurredAt;
  const data = requireFieldWith(raw, 'data', '', parseAdapterJsonObject);
  if (!data.ok) return data;
  return parseOk(
    {
      kind: 'provider-webhook-body',
      eventKind: eventKind.value as ProviderEventKind,
      objectType: objectType.value,
      objectId: objectId.value,
      version: version.value,
      occurredAt: occurredAt.value,
      data: data.value,
    } satisfies ProviderWebhookBody,
  );
}

/** Type guard for structurally valid ProviderWebhookBody values. */
export function isProviderWebhookBody(raw: unknown): raw is ProviderWebhookBody {
  return parseProviderWebhookBody(raw).ok;
}

/** The normalized, tenant-stamped inbound webhook envelope. */
export interface NormalizedWebhook {
  readonly kind: 'normalized-webhook';
  /** The tenant whose adapter received the webhook. */
  readonly tenantId: TenantId;
  /** Provenance: the provider object's full identity at this version. */
  readonly source: SourceRef;
  /** The provider event kind (closed vocabulary). */
  readonly eventKind: ProviderEventKind;
  /** The provider's own instant for the event, or null. */
  readonly occurredAt: Timestamp | null;
  /** The provider's event payload (open-keyed extension bag). */
  readonly data: AdapterJsonObject;
  /** When office received the webhook (injected clock). */
  readonly receivedAt: Timestamp;
  /** The deterministic replay-deduplication key of this provider event. */
  readonly deduplicationKey: WebhookDeduplicationKey;
}

/**
 * Derive the replay-deduplication key of one provider webhook event
 * (deterministic, pure): `office-whk-v1-<sha256 prefix>` over the event's
 * identity (adapter, system, event kind, object type/id, version, occurred
 * instant). A redelivered webhook derives the SAME key; the runtime's
 * dedup registry no-ops on it before the engine runs.
 */
export function webhookDeduplicationKey(parts: {
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly eventKind: ProviderEventKind;
  readonly objectType: ProviderObjectKind;
  readonly objectId: ProviderObjectId;
  readonly version: ProviderVersion;
  readonly occurredAt: Timestamp | null;
}): WebhookDeduplicationKey {
  const material = JSON.stringify([
    parts.adapterKind,
    parts.systemId,
    parts.eventKind,
    parts.objectType,
    parts.objectId,
    parts.version,
    parts.occurredAt,
  ]);
  const digest = createHash('sha256')
    .update(`office-adapter-webhook-dedup|${material}`, 'utf8')
    .digest('hex')
    .slice(0, DERIVED_OPAQUE_LENGTH);
  const candidate = `${WEBHOOK_DEDUPLICATION_KEY_PREFIX}${digest}`;
  const parsed = parseWebhookDeduplicationKey(candidate);
  if (!parsed.ok) {
    // Pure derivation over validated inputs — a violation is a module defect.
    throw new TypeError(`derived webhook deduplication key is not valid: ${candidate}`);
  }
  return parsed.value;
}

/** Inputs of normalizeWebhook: the raw webhook, routing, verifier, and clock. */
export interface NormalizeWebhookRequest {
  readonly raw: RawWebhook;
  readonly tenantId: TenantId;
  readonly verifier: WebhookSignatureVerifier;
  /** The injected clock's instant recorded as receivedAt. */
  readonly now: Timestamp;
}

/**
 * Normalize one raw inbound webhook (verify → parse → envelope):
 *   1. the raw body must be JSON (fail-closed typed invariant-violation);
 *   2. the injected signature verifier must accept it (typed unauthorized);
 *   3. the body must parse as a ProviderWebhookBody (strict keys);
 *   4. the envelope carries the SourceRef, the deterministic dedup key, and
 *      the injected clock's receivedAt.
 */
export function normalizeWebhook(
  request: NormalizeWebhookRequest,
): Result<NormalizedWebhook, DomainError> {
  const scope = { kind: 'tenant', tenantId: request.tenantId } as const;
  const jsonBody = parseAdapterJsonValue(request.raw.body, 'body');
  if (!jsonBody.ok) {
    return fail(webhookBodyError(jsonBody.error.code, jsonBody.error.path, jsonBody.error.received, scope));
  }
  const verified = request.verifier.verify({
    adapterKind: request.raw.adapterKind,
    systemId: request.raw.systemId,
    headers: request.raw.headers,
    body: jsonBody.value,
  });
  if (!verified.ok) return verified;
  const body = parseProviderWebhookBody(jsonBody.value);
  if (!body.ok) {
    return fail(
      webhookBodyError(body.error.code, body.error.path, body.error.received, scope),
    );
  }
  const source = sourceRef({
    adapterKind: request.raw.adapterKind,
    systemId: request.raw.systemId,
    objectType: body.value.objectType,
    objectId: body.value.objectId,
    version: body.value.version,
  });
  return ok(
    {
      kind: 'normalized-webhook',
      tenantId: request.tenantId,
      source,
      eventKind: body.value.eventKind,
      occurredAt: body.value.occurredAt,
      data: body.value.data,
      receivedAt: request.now,
      deduplicationKey: webhookDeduplicationKey({
        adapterKind: request.raw.adapterKind,
        systemId: request.raw.systemId,
        eventKind: body.value.eventKind,
        objectType: body.value.objectType,
        objectId: body.value.objectId,
        version: body.value.version,
        occurredAt: body.value.occurredAt,
      }),
    } satisfies NormalizedWebhook,
  );
}

const webhookBodyError = (
  code: string,
  path: string,
  received: string,
  scope: { readonly kind: 'tenant'; readonly tenantId: TenantId },
): DomainError =>
  domainError(
    'invariant-violation',
    `webhook body failed fail-closed parsing: ${code} at '${path === '' ? '<root>' : path}'`,
    [{ code: `webhook-body-${code}`, message: received, path: path === '' ? null : path }],
    { scope },
  );

/** The per-webhook intake outcome vocabulary. */
export type WebhookOutcomeKind =
  | 'source-created'
  | 'source-updated'
  | 'source-deleted'
  | 'replay-no-op'
  | 'deletion-no-op';

/** The result of applying one webhook end to end. */
export interface WebhookOutcome {
  /** The normalized envelope (dedup key included). */
  readonly envelope: NormalizedWebhook;
  /** The source mapping AFTER intake (null only for deletion of unknown sources). */
  readonly mapping: SourceMapping | null;
  /** The proposed canonical command, or null for the no-op outcomes. */
  readonly command: CommandEnvelope<AdapterJsonObject> | null;
  /** Which intake branch ran (replay/deletion no-ops carry no command). */
  readonly outcome: WebhookOutcomeKind;
}

/** Authorization inputs of an adapter engine run (same shape for sync). */
export interface AdapterAuthorization {
  /** The adapter actor context (requireAdapterActor gates the actor kind). */
  readonly context: AuthorizationContext;
  /** The caller-supplied deny-by-default policy (authorize() evaluates it). */
  readonly policy: Policy;
}

/** Injected dependencies of the webhook engine (determinism rule). */
export interface WebhookEngineDeps {
  readonly mappings: SourceMappingStore;
  /** Lookup of the canonical aggregate version (the runtime owns the graph). */
  readonly canonicalVersionOf: CanonicalVersionLookup;
  /** Injected clock — the canonical 'now' of each intake. */
  readonly now: EngineClock;
  /** Injected office-issued canonical id supplier (never a provider id). */
  readonly nextCanonicalId: CanonicalIdSupplier;
}

/**
 * Apply one inbound webhook end to end (the intake engine): normalize
 * (verify + parse + dedup key), authorize the declared capability through
 * authz's deny-by-default evaluator, resolve the source mapping, and ask the
 * adapter's translator to propose the canonical command. Adapters NEVER
 * write the graph here — the returned CommandEnvelope goes to the Action
 * Gateway / application layer.
 *
 * Intake branches (all deterministic):
 *   - 'created' with no mapping → issue a canonical id (injected supplier),
 *     record the mapping, propose the create command;
 *   - 'created'/'updated' with a mapping at the SAME provider version →
 *     'replay-no-op' (no duplicate mapping, no duplicate command);
 *   - 'created'/'updated' with a mapping at a NEW provider version → update
 *     the mapping's version bookkeeping, propose the update command;
 *   - 'updated' with no mapping → typed not-found (fail closed: the runtime
 *     should run a targeted sync to establish the identity first);
 *   - 'deleted' with a mapping → propose the delete command;
 *   - 'deleted' with no mapping → 'deletion-no-op' (nothing to delete).
 */
export async function applyWebhook(request: {
  readonly authorization: AdapterAuthorization;
  readonly adapter: Adapter;
  readonly translator: AdapterCommandTranslator;
  readonly verifier: WebhookSignatureVerifier;
  readonly deps: WebhookEngineDeps;
  readonly raw: RawWebhook;
}): Promise<Result<WebhookOutcome, DomainError>> {
  const actorCheck = requireAdapterActor(request.authorization.context);
  if (!actorCheck.ok) return actorCheck;
  const tenantId = request.authorization.context.scope.tenantId;
  const scope = { kind: 'tenant', tenantId } as const;

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

  const now = request.deps.now();
  const normalized = normalizeWebhook({
    raw: request.raw,
    tenantId,
    verifier: request.verifier,
    now,
  });
  if (!normalized.ok) return normalized;
  const envelope = normalized.value;

  const declaration = request.adapter.capabilities.objectKinds.find(
    (entry) => entry.objectKind === envelope.source.objectType,
  );
  if (declaration === undefined) {
    return fail(
      domainError(
        'invariant-violation',
        `adapter '${request.adapter.kind}' does not declare object kind '${envelope.source.objectType}'`,
        [
          {
            code: 'object-kind-not-declared',
            message: envelope.source.objectType,
            path: 'objectType',
          },
        ],
        { scope },
      ),
    );
  }

  const decision = authorize(
    request.authorization.policy,
    request.authorization.context,
    resourceScope({
      scope,
      resourceKind: declaration.canonicalKind,
      resourceId: null,
      ownerId: null,
    }),
    'write',
    { scope, correlationId: sourceCorrelationId(coordinateOf(envelope.source)) },
  );
  if (!decision.ok) return decision;

  const mapping = await request.deps.mappings.findByCoordinate(
    tenantId,
    coordinateOf(envelope.source),
  );

  if (envelope.eventKind === 'deleted') {
    if (mapping === null) {
      return ok({
        envelope,
        mapping: null,
        command: null,
        outcome: 'deletion-no-op',
      } satisfies WebhookOutcome);
    }
    return propose(request, envelope, mapping, 'deleted', now);
  }

  if (mapping === null) {
    if (envelope.eventKind === 'updated') {
      return fail(
        domainError(
          'not-found',
          `no source mapping for provider object ${envelope.source.objectType} ${envelope.source.objectId} — run a targeted sync to establish the identity before applying updates`,
          [
            {
              code: 'source-mapping-not-found',
              message: envelope.source.objectId,
              path: null,
            },
          ],
          { scope },
        ),
      );
    }
    const canonical = {
      entityKind: declaration.canonicalKind,
      entityId: request.deps.nextCanonicalId(),
    };
    const current = await request.deps.canonicalVersionOf(tenantId, canonical);
    if (!current.ok) return current;
    const recorded = await recordSourceMapping({
      store: request.deps.mappings,
      tenantId,
      coordinate: coordinateOf(envelope.source),
      canonical,
      providerVersion: envelope.source.version,
      canonicalVersion: current.value ?? INITIAL_AGGREGATE_VERSION,
      actor: request.authorization.context.actor,
      now,
    });
    if (!recorded.ok) return recorded;
    return propose(request, envelope, recorded.value, 'created', now);
  }

  const tenant = assertMappingTenant(mapping, tenantId);
  if (!tenant.ok) return tenant;

  if (mapping.providerVersion === envelope.source.version) {
    return ok({
      envelope,
      mapping,
      command: null,
      outcome: 'replay-no-op',
    } satisfies WebhookOutcome);
  }

  const current = await request.deps.canonicalVersionOf(tenantId, mapping.canonical);
  if (!current.ok) return current;
  const advanced = sourceMapping({
    ...mapping,
    providerVersion: envelope.source.version,
    canonicalVersion: current.value ?? mapping.canonicalVersion,
    lastSyncedAt: now,
  });
  const saved = await request.deps.mappings.save(advanced);
  if (!saved.ok) return saved;
  return propose(request, envelope, saved.value, 'updated', now);
}

/** Propose + envelope one command for the resolved mapping (local helper). */
const propose = (
  request: {
    readonly authorization: AdapterAuthorization;
    readonly adapter: Adapter;
    readonly translator: AdapterCommandTranslator;
    readonly verifier: WebhookSignatureVerifier;
    readonly deps: WebhookEngineDeps;
    readonly raw: RawWebhook;
  },
  envelope: NormalizedWebhook,
  mapping: SourceMapping,
  changeKind: AdapterCommandInput['changeKind'],
  now: Timestamp,
): Result<WebhookOutcome, DomainError> => {
  const proposal = request.translator.proposeCommand({
    origin: 'webhook',
    tenantId: envelope.tenantId,
    source: envelope.source,
    canonical: mapping.canonical,
    canonicalVersion: mapping.canonicalVersion,
    changeKind,
    displayName: null,
    data: envelope.data,
  });
  if (!proposal.ok) return proposal;
  const command = adapterCommandEnvelope({
    proposal: proposal.value,
    context: request.authorization.context,
    source: envelope.source,
    causationId: causationIdOfWebhook(envelope.deduplicationKey),
    now,
  });
  const roundTrip = checkCommandEnvelopeRoundTrip(command, envelope.tenantId);
  if (!roundTrip.ok) return roundTrip;
  return ok({
    envelope,
    mapping,
    command,
    outcome:
      changeKind === 'created'
        ? 'source-created'
        : changeKind === 'deleted'
          ? 'source-deleted'
          : 'source-updated',
  } satisfies WebhookOutcome);
};
