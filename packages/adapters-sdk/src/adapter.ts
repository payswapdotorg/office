// Office adapters-sdk — the provider-neutral Adapter contract (OFF-020).
//
// THE interface every provider adapter (the OFF-021+ packages) implements.
// An adapter is a TRANSLATOR, never an owner of canonical semantics (freeze
// A5): it declares what object kinds it can sync (and which canonical kind
// and capability each maps to), exposes a connection lifecycle
// (connect/health-check/disconnect — no I/O in the SDK itself, the real
// adapters do I/O against these contracts), and pulls sync pages of
// provider-neutral snapshots. Inbound provider pushes travel the webhook
// normalization path (webhook.ts), not this interface.
//
// Authorization (freeze A12 + the authz consumption seam): adapter engines
// execute under an AuthorizationContext whose actor is the ADAPTER actor
// kind; requireAdapterActor typed-rejects every other actor kind, and the
// sync/webhook engines authorize the declared capability through authz's
// deny-by-default authorize() before anything moves. adapterAuthorization()
// composes the context on the trusted path.
//
// The SDK performs NO I/O: fetch/HTTP/secrets belong to the runtime wiring
// and the real adapter packages. Credentials never appear in any SDK type —
// the runtime holds them; ConnectRequest names only the provider system.
import { parseEntityKind, parseFail, parseOk, parseTimestamp } from '@office/contracts';
import type {
  EntityId,
  EntityKind,
  ParseResult,
  Scope,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { authorizationContext, parseCapability } from '@office/authz';
import type { AuthorizationContext, Capability } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  describeValue,
  isPlainObject,
  parseValueArray,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import { parseProviderObjectKind, parseProviderSystemId } from './identity';
import type { AdapterKind, ProviderObjectKind, ProviderSystemId } from './identity';
import { parseSyncCheckpoint, parseSyncCursorToken } from './cursor';
import type { SyncCheckpoint, SyncCursor, SyncCursorToken } from './cursor';
import { parseProviderSnapshot } from './snapshot';
import type { ProviderSnapshot } from './snapshot';

/** One declared sync surface: a provider object kind this adapter translates. */
export interface AdapterObjectCapability {
  /** The provider's own object type name, e.g. 'contact'. */
  readonly objectKind: ProviderObjectKind;
  /** The canonical entity kind those objects map into, e.g. 'organization'. */
  readonly canonicalKind: EntityKind;
  /** The capability required to sync this kind (deny-by-default authorized). */
  readonly capability: Capability;
}

/** What this adapter can sync: the declared object-kind surfaces, unique. */
export interface AdapterCapabilities {
  readonly objectKinds: readonly AdapterObjectCapability[];
}

/** Shape description used in parse failures. */
export const ADAPTER_OBJECT_CAPABILITY_GRAMMAR =
  'AdapterObjectCapability: { objectKind, canonicalKind, capability: declared capability }';

/** Shape description used in parse failures. */
export const ADAPTER_CAPABILITIES_GRAMMAR =
  'AdapterCapabilities: { objectKinds: AdapterObjectCapability[] (unique objectKind, >= 1) }';

const ADAPTER_OBJECT_CAPABILITY_KEYS = ['objectKind', 'canonicalKind', 'capability'] as const;
const ADAPTER_CAPABILITIES_KEYS = ['objectKinds'] as const;

/** Parse an untrusted value as an AdapterObjectCapability (strict keys). */
export function parseAdapterObjectCapability(
  raw: unknown,
): ParseResult<AdapterObjectCapability> {
  if (!isPlainObject(raw)) {
    return parseFail(
      'invalid-type',
      '',
      ADAPTER_OBJECT_CAPABILITY_GRAMMAR,
      describeValue(raw),
    );
  }
  const unknownKey = unknownKeyFailure(
    raw,
    ADAPTER_OBJECT_CAPABILITY_KEYS,
    '',
    ADAPTER_OBJECT_CAPABILITY_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const objectKind = requireFieldWith(raw, 'objectKind', '', parseProviderObjectKind);
  if (!objectKind.ok) return objectKind;
  const canonicalKind = requireFieldWith(raw, 'canonicalKind', '', parseEntityKind);
  if (!canonicalKind.ok) return canonicalKind;
  const capability = requireFieldWith(raw, 'capability', '', parseCapability);
  if (!capability.ok) return capability;
  return parseOk(
    {
      objectKind: objectKind.value,
      canonicalKind: canonicalKind.value,
      capability: capability.value,
    } satisfies AdapterObjectCapability,
  );
}

/** Type guard for structurally valid AdapterObjectCapability values. */
export function isAdapterObjectCapability(raw: unknown): raw is AdapterObjectCapability {
  return parseAdapterObjectCapability(raw).ok;
}

/** Parse an untrusted value as AdapterCapabilities (strict, unique kinds). */
export function parseAdapterCapabilities(raw: unknown): ParseResult<AdapterCapabilities> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ADAPTER_CAPABILITIES_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ADAPTER_CAPABILITIES_KEYS, '', ADAPTER_CAPABILITIES_GRAMMAR);
  if (unknownKey) return unknownKey;
  const objectKinds = parseValueArray(
    raw['objectKinds'],
    'objectKinds',
    parseAdapterObjectCapability,
    'array of declared object-kind capabilities (unique objectKind, >= 1)',
  );
  if (!objectKinds.ok) return objectKinds;
  if (objectKinds.value.length < 1) {
    return parseFail(
      'invalid-value',
      'objectKinds',
      'at least one declared object kind (an adapter that syncs nothing is not an adapter)',
      'empty array',
    );
  }
  const seen = new Set<string>();
  for (const entry of objectKinds.value) {
    if (seen.has(entry.objectKind)) {
      return parseFail(
        'invalid-value',
        'objectKinds',
        'unique objectKind declarations (one capability per provider object kind)',
        `duplicate objectKind '${entry.objectKind}'`,
      );
    }
    seen.add(entry.objectKind);
  }
  return parseOk({ objectKinds: objectKinds.value } satisfies AdapterCapabilities);
}

/** Type guard for structurally valid AdapterCapabilities values. */
export function isAdapterCapabilities(raw: unknown): raw is AdapterCapabilities {
  return parseAdapterCapabilities(raw).ok;
}

/**
 * The established connection to one provider system (a value, not a socket):
 * implementations carry their own handle fields on top of this shape.
 */
export interface AdapterConnection {
  readonly kind: 'adapter-connection';
  /** The provider system this connection reaches. */
  readonly systemId: ProviderSystemId;
  /** When the connection was established (injected clock). */
  readonly establishedAt: Timestamp;
}

/** Shape description used in parse failures. */
export const ADAPTER_CONNECTION_GRAMMAR =
  "AdapterConnection: { kind: 'adapter-connection', systemId, establishedAt }";

const ADAPTER_CONNECTION_KEYS = ['kind', 'systemId', 'establishedAt'] as const;

/** Parse an untrusted value as an AdapterConnection (strict keys). */
export function parseAdapterConnection(raw: unknown): ParseResult<AdapterConnection> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ADAPTER_CONNECTION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ADAPTER_CONNECTION_KEYS, '', ADAPTER_CONNECTION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['adapter-connection']);
  if (!kind.ok) return kind;
  const systemId = requireFieldWith(raw, 'systemId', '', parseProviderSystemId);
  if (!systemId.ok) return systemId;
  const establishedAt = requireFieldWith(raw, 'establishedAt', '', parseTimestamp);
  if (!establishedAt.ok) return establishedAt;
  return parseOk(
    {
      kind: 'adapter-connection',
      systemId: systemId.value,
      establishedAt: establishedAt.value,
    } satisfies AdapterConnection,
  );
}

/** Type guard for structurally valid AdapterConnection values. */
export function isAdapterConnection(raw: unknown): raw is AdapterConnection {
  return parseAdapterConnection(raw).ok;
}

/** Lifecycle request: connect to one provider system (credentials never appear here). */
export interface ConnectRequest {
  readonly kind: 'connect-request';
  readonly systemId: ProviderSystemId;
  /** The injected clock's instant for establishedAt. */
  readonly now: Timestamp;
}

/** Observed health of a connection. */
export interface AdapterHealth {
  readonly kind: 'adapter-health';
  readonly status: 'healthy' | 'degraded' | 'unavailable';
  readonly checkedAt: Timestamp;
  /** Human-readable diagnostic, or null when fully healthy. */
  readonly detail: string | null;
}

/** Result of an explicit disconnect. */
export interface AdapterDisconnected {
  readonly kind: 'adapter-disconnected';
  readonly disconnectedAt: Timestamp;
}

/** One sync page request: which stream, from which position, how much. */
export interface SyncRequest {
  readonly kind: 'sync-request';
  /** The tenant whose sync this is (snapshots are tenant-stamped with it). */
  readonly tenantId: TenantId;
  /** The provider system being synced (must match the stream's). */
  readonly systemId: ProviderSystemId;
  /** The object-kind stream being synced. */
  readonly objectKind: ProviderObjectKind;
  /** The resume position, or null for a fresh start. */
  readonly cursor: SyncCursor | null;
  /** Maximum snapshots to return (integer 1..1000 — the engine validates). */
  readonly limit: number;
  /** The injected clock's instant for observedAt stamps. */
  readonly now: Timestamp;
}

/** One sync page result: snapshots plus the next resume position. */
export interface SyncResult {
  readonly kind: 'sync-result';
  /** The observed provider objects, in provider stream order. */
  readonly snapshots: readonly ProviderSnapshot[];
  /**
   * The continuation token after this page, or null when the stream is
   * exhausted (nothing more after this position right now).
   */
  readonly nextCursorToken: SyncCursorToken | null;
  /** The checkpoint metadata at that position. */
  readonly checkpoint: SyncCheckpoint;
  /** Whether more items exist past the returned position. */
  readonly hasMore: boolean;
}

/** Shape description used in parse failures. */
export const SYNC_RESULT_GRAMMAR =
  'SyncResult: { kind, snapshots: ProviderSnapshot[], nextCursorToken: SyncCursorToken | null, checkpoint, hasMore: boolean }';

const SYNC_RESULT_KEYS = [
  'kind',
  'snapshots',
  'nextCursorToken',
  'checkpoint',
  'hasMore',
] as const;

/**
 * Parse an untrusted value as a SyncResult (total, fail-closed, strict
 * keys) — the engine's boundary check on adapter output.
 */
export function parseSyncResult(raw: unknown): ParseResult<SyncResult> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SYNC_RESULT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SYNC_RESULT_KEYS, '', SYNC_RESULT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['sync-result']);
  if (!kind.ok) return kind;
  const snapshots = parseValueArray(
    raw['snapshots'],
    'snapshots',
    parseProviderSnapshot,
    'array of provider snapshots (the observed page)',
  );
  if (!snapshots.ok) return snapshots;
  const nextCursorToken = requireNullableFieldWith(
    raw,
    'nextCursorToken',
    '',
    parseSyncCursorToken,
  );
  if (!nextCursorToken.ok) return nextCursorToken;
  const checkpoint = requireFieldWith(raw, 'checkpoint', '', parseSyncCheckpoint);
  if (!checkpoint.ok) return checkpoint;
  const hasMore = raw['hasMore'];
  if (typeof hasMore !== 'boolean') {
    return parseFail('invalid-value', 'hasMore', 'a boolean', describeValue(hasMore));
  }
  return parseOk(
    {
      kind: 'sync-result',
      snapshots: snapshots.value,
      nextCursorToken: nextCursorToken.value,
      checkpoint: checkpoint.value,
      hasMore,
    } satisfies SyncResult,
  );
}

/** Type guard for structurally valid SyncResult values. */
export function isSyncResult(raw: unknown): raw is SyncResult {
  return parseSyncResult(raw).ok;
}

/**
 * The provider-neutral Adapter contract (OFF-021+ implement this). All
 * methods are typed Results — expected failures are values, never throws —
 * and every timestamp comes from the request's injected clock.
 */
export interface Adapter {
  /** The adapter family kind, e.g. 'fake-crm' (adapter packages own real names). */
  readonly kind: AdapterKind;
  /** What this adapter can sync (declared object-kind surfaces). */
  readonly capabilities: AdapterCapabilities;
  /** Establish a connection to one provider system. */
  connect(request: ConnectRequest): Promise<Result<AdapterConnection, DomainError>>;
  /** Observe a connection's health. */
  healthCheck(request: {
    readonly connection: AdapterConnection;
    readonly now: Timestamp;
  }): Promise<Result<AdapterHealth, DomainError>>;
  /** Explicitly close a connection. */
  disconnect(request: {
    readonly connection: AdapterConnection;
    readonly now: Timestamp;
  }): Promise<Result<AdapterDisconnected, DomainError>>;
  /** Pull one page of one object-kind stream. */
  sync(request: SyncRequest): Promise<Result<SyncResult, DomainError>>;
}

/**
 * Typed guard: adapter engines execute only under the ADAPTER actor kind —
 * any other actor (user, agent, app, system) is a typed forbidden rejection
 * before anything moves.
 */
export function requireAdapterActor(
  context: AuthorizationContext,
): Result<true, DomainError> {
  if (context.actor.kind === 'adapter') return ok(true);
  return fail(
    domainError(
      'forbidden',
      `adapter operations require an adapter actor, received actor kind '${context.actor.kind}'`,
      [{ code: 'adapter-actor-required', message: context.actor.kind, path: 'actor.kind' }],
      { scope: context.scope },
    ),
  );
}

/**
 * Compose the adapter service context on the trusted path (loud TypeError on
 * invalid parts — same convention as authz's authorizationContext): the
 * adapter actor kind plus the granted capabilities, under the execution
 * scope.
 */
export function adapterAuthorizationContext(parts: {
  readonly actorId: EntityId;
  readonly scope: Scope;
  readonly capabilities: readonly string[];
}): AuthorizationContext {
  return authorizationContext({
    actor: { kind: 'adapter', actorId: parts.actorId },
    scope: parts.scope,
    capabilities: parts.capabilities,
  });
}

/** Parse an untrusted value as AdapterHealth (strict keys; engine boundary). */
export function parseAdapterHealth(raw: unknown): ParseResult<AdapterHealth> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'AdapterHealth: { kind, status, checkedAt, detail: string | null }', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['kind', 'status', 'checkedAt', 'detail'], '', 'AdapterHealth: { kind, status, checkedAt, detail: string | null }');
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['adapter-health']);
  if (!kind.ok) return kind;
  const status = requireLiteral(raw, 'status', '', ['healthy', 'degraded', 'unavailable']);
  if (!status.ok) return status;
  const checkedAt = requireFieldWith(raw, 'checkedAt', '', parseTimestamp);
  if (!checkedAt.ok) return checkedAt;
  const detail = requireNullableDetail(raw);
  if (!detail.ok) return detail;
  return parseOk(
    {
      kind: 'adapter-health',
      status: status.value as AdapterHealth['status'],
      checkedAt: checkedAt.value,
      detail: detail.value,
    } satisfies AdapterHealth,
  );
}

/** Type guard for structurally valid AdapterHealth values. */
export function isAdapterHealth(raw: unknown): raw is AdapterHealth {
  return parseAdapterHealth(raw).ok;
}

const requireNullableDetail = (raw: Record<string, unknown>): ParseResult<string | null> => {
  const value = raw['detail'];
  if (value === null) return parseOk(null);
  const result = requireString(raw, 'detail', '', {
    min: 0,
    max: 512,
    description: 'human-readable health diagnostic (null when fully healthy)',
  });
  if (!result.ok) return result;
  return parseOk(result.value);
};
