// Office sync — deterministic client operations (OFF-028, freeze A9).
//
// Client operations carry DETERMINISTIC ids: the idempotency key of a client
// operation is composed from (subscription, cursor position, operation kind)
// via sha256 — so the same client, at the same observed cursor, composing
// the same kind of operation, always derives the SAME id (operationIdOf in
// identity.ts). A retry after a reconnect is a typed DUPLICATE, never a
// second effect; a different cursor basis or a different kind derives a
// different id (a genuinely new operation).
//
// The payload itself is domain-typed data owned by the domain packages; the
// protocol carries its canonical DIGEST (sha256 over canonical JSON: object
// keys sorted recursively, arrays in order — the same canonicalization rule
// as the domain kernel's command fingerprints). The digest is what makes
// duplicate detection sound: same id + same digest = replay (no-op); same id
// + different digest = typed idempotency-conflict — an operation id never
// silently switches payloads.
import { createHash } from 'node:crypto';
import { parseActor, parseEntityRef, parseFail, parseOk } from '@office/contracts';
import type { Actor, EntityRef, ParseResult, ProjectScope } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { parseOperationId, parseSubscriptionId } from './identity';
import type { OperationId, SubscriptionId } from './identity';
import { parseProjectScope, parseSlicePosition } from './slice';
import type { SlicePosition } from './slice';
import { describeValue, isPlainObject, parseToken, requireFieldWith, requireLiteral, unknownKeyFailure } from './parse';

declare const operationKindBrand: unique symbol;
declare const operationDigestBrand: unique symbol;

/**
 * The kind of a client operation — a kebab-case token whose VOCABULARY is
 * owned by the domain packages (e.g. a schedule domain might declare
 * 'record-progress'); the protocol constrains the grammar only.
 */
export type OperationKind = string & { readonly [operationKindBrand]: 'OperationKind' };

/** Grammar description used in parse failures. */
export const OPERATION_KIND_GRAMMAR =
  'lowercase kebab-case operation kind of 1..64 characters (vocabulary owned by the domain packages)';

const OPERATION_KIND_RULE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/**
 * Canonical digest of an operation's payload: sha256 hex (64 lowercase hex
 * characters) over the canonical JSON of the payload.
 */
export type OperationDigest = string & { readonly [operationDigestBrand]: 'OperationDigest' };

/** Grammar description used in parse failures. */
export const OPERATION_DIGEST_GRAMMAR = '64 lowercase hexadecimal characters (sha256 of the canonical payload JSON)';

const OPERATION_DIGEST_RULE = /^[0-9a-f]{64}$/;

/** One client operation composed against a subscription's observed cursor. */
export interface ClientOperation {
  readonly kind: 'client-operation';
  /** Deterministic operation identity (subscription + cursor + kind). */
  readonly operationId: OperationId;
  /** The subscription the operation was composed under. */
  readonly subscriptionId: SubscriptionId;
  /** The slice position the client had observed when it composed the operation. */
  readonly position: SlicePosition;
  /** The operation kind (domain-owned vocabulary). */
  readonly operationKind: OperationKind;
  /** The client actor composing the operation. */
  readonly actor: Actor;
  /** The project scope of the slice the operation targets (freeze A12). */
  readonly scope: ProjectScope;
  /** The canonical entity the operation addresses. */
  readonly target: EntityRef;
  /** Canonical digest of the domain payload (never the payload itself). */
  readonly payloadDigest: OperationDigest;
}

/** Shape description used in parse failures. */
export const CLIENT_OPERATION_GRAMMAR =
  'ClientOperation: { kind, operationId, subscriptionId, position, operationKind, actor, scope, target, payloadDigest }';

const CLIENT_OPERATION_KEYS = [
  'kind',
  'operationId',
  'subscriptionId',
  'position',
  'operationKind',
  'actor',
  'scope',
  'target',
  'payloadDigest',
] as const;

/**
 * Canonical JSON: object keys sorted recursively, arrays in order, JSON
 * scalars verbatim — the same rule as the domain kernel's command
 * fingerprints (structurally equal payloads digest identically regardless
 * of key order). Throws TypeError for values JSON cannot represent: a loud
 * programming error, never a silent digest collision.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON cannot serialize non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalJson(item)))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot serialize ${typeof value}`);
};

/**
 * Derive the canonical digest of an operation payload (deterministic, pure):
 * sha256 over the payload's canonical JSON. The same logical payload always
 * digests identically — retry metadata (timestamps, causality) belongs in
 * the envelope, not the payload, exactly as the kernel's command
 * fingerprints exclude retry metadata.
 */
export function operationDigestOf(payload: unknown): OperationDigest {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex') as OperationDigest;
}

/** Parse an untrusted value as an OperationKind (total, fail-closed). */
export function parseOperationKind(raw: unknown): ParseResult<OperationKind> {
  const result = parseToken(raw, '', OPERATION_KIND_RULE, OPERATION_KIND_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as OperationKind);
}

/** Type guard for structurally valid OperationKind values. */
export function isOperationKind(raw: unknown): raw is OperationKind {
  return parseOperationKind(raw).ok;
}

/** Parse an untrusted value as an OperationDigest (total, fail-closed). */
export function parseOperationDigest(raw: unknown): ParseResult<OperationDigest> {
  const result = parseToken(raw, '', OPERATION_DIGEST_RULE, OPERATION_DIGEST_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as OperationDigest);
}

/** Type guard for structurally valid OperationDigest values. */
export function isOperationDigest(raw: unknown): raw is OperationDigest {
  return parseOperationDigest(raw).ok;
}

/** Parse an untrusted value as a ClientOperation (total, fail-closed, strict keys). */
export function parseClientOperation(raw: unknown): ParseResult<ClientOperation> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CLIENT_OPERATION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CLIENT_OPERATION_KEYS, '', CLIENT_OPERATION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['client-operation']);
  if (!kind.ok) return kind;
  const operationId = requireFieldWith(raw, 'operationId', '', parseOperationId);
  if (!operationId.ok) return operationId;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const position = requireFieldWith(raw, 'position', '', parseSlicePosition);
  if (!position.ok) return position;
  const operationKind = requireFieldWith(raw, 'operationKind', '', parseOperationKind);
  if (!operationKind.ok) return operationKind;
  const actor = requireFieldWith(raw, 'actor', '', parseActor);
  if (!actor.ok) return actor;
  const scope = requireFieldWith(raw, 'scope', '', parseProjectScope);
  if (!scope.ok) return scope;
  const target = requireFieldWith(raw, 'target', '', parseEntityRef);
  if (!target.ok) return target;
  const payloadDigest = requireFieldWith(raw, 'payloadDigest', '', parseOperationDigest);
  if (!payloadDigest.ok) return payloadDigest;
  return parseOk(
    {
      kind: 'client-operation',
      operationId: operationId.value,
      subscriptionId: subscriptionId.value,
      position: position.value,
      operationKind: operationKind.value,
      actor: actor.value,
      scope: scope.value,
      target: target.value,
      payloadDigest: payloadDigest.value,
    } satisfies ClientOperation,
  );
}

/** Type guard for structurally valid ClientOperation values. */
export function isClientOperation(raw: unknown): raw is ClientOperation {
  return parseClientOperation(raw).ok;
}

/** Compose a ClientOperation from validated parts (trusted path; loud TypeError). */
export function clientOperation(operation: {
  readonly operationId: OperationId;
  readonly subscriptionId: SubscriptionId;
  readonly position: SlicePosition;
  readonly operationKind: OperationKind;
  readonly actor: Actor;
  readonly scope: ClientOperation['scope'];
  readonly target: EntityRef;
  readonly payloadDigest: OperationDigest;
}): ClientOperation {
  const parsed = parseClientOperation({ ...operation, kind: 'client-operation' });
  if (!parsed.ok) {
    throw new TypeError(`invalid client operation: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Outcome of one operation registration: first execution, or a typed duplicate. */
export type OperationOutcome =
  | { readonly status: 'recorded' }
  | { readonly status: 'duplicate' };

/**
 * Key-registry contract for typed operation deduplication, keyed by
 * OperationId. The in-memory implementation below is the protocol's test
 * fixture; a durable implementation (same semantics, transactional with the
 * mutation) belongs to the sync engine (OFF-029) and the runtime.
 */
export interface OperationRegistry {
  /**
   * Register one operation: 'recorded' on first sight; 'duplicate' when the
   * SAME operation id arrives again with the SAME payload digest (a typed
   * clean no-op — duplicates are deduplicated, never re-executed); a typed
   * idempotency-conflict when the same id arrives with a DIFFERENT digest
   * (an operation id never silently switches payloads).
   */
  register(operation: ClientOperation): Promise<Result<OperationOutcome, DomainError>>;
}

/** Deterministic in-memory OperationRegistry (the protocol's test fixture). */
export function createInMemoryOperationRegistry(): OperationRegistry {
  const operations = new Map<string, ClientOperation>();
  return {
    async register(operation) {
      const existing = operations.get(operation.operationId);
      if (existing === undefined) {
        operations.set(operation.operationId, operation);
        return ok({ status: 'recorded' } satisfies OperationOutcome);
      }
      if (existing.payloadDigest !== operation.payloadDigest) {
        return fail(
          domainError(
            'idempotency-conflict',
            `operation id ${operation.operationId} was already recorded with a different payload digest`,
            [
              {
                code: 'operation-id-reuse',
                message: `${existing.payloadDigest} recorded, ${operation.payloadDigest} presented`,
                path: 'payloadDigest',
              },
            ],
            { scope: operation.scope },
          ),
        );
      }
      return ok({ status: 'duplicate' } satisfies OperationOutcome);
    },
  };
}
