// Office adapters-sdk — explicit conflict records (OFF-020).
//
// A Conflict is the explicit, auditable record created when a provider's
// state and the canonical state diverge in incompatible ways — detected by
// the sync engine when BOTH sides advanced since the last synchronized point
// (provider version moved AND the canonical aggregate version moved
// independently). It carries BOTH sides' refs and versions: the provider
// SourceRef (version included) and the canonical EntityRef + aggregate
// version at detection.
//
// NO destructive automatic resolution (frozen anti-pattern: material
// commercial state is never silently last-write-wins'd): the record lands in
// the 'detected' state and stays there. Resolution is an explicit command —
// resolveConflict() — that must cite the ledger events proving the
// reconciliation (audit event refs, at least one). The three strategies are
// the closed vocabulary: merge, canonical-wins, provider-wins. Resolving an
// already-resolved conflict identically is an idempotent no-op; resolving it
// differently is a typed invariant-violation.
//
// Conflict ids are DERIVED deterministically from both sides (tenant,
// source ref, canonical ref, canonical version) — re-detecting the same
// divergence yields the same id, and appending it again is an idempotent
// no-op (no duplicate records). If either side moves, that is a NEW
// divergence pair and a new record: a Conflict pins the exact pair it
// detected.
import { createHash } from 'node:crypto';
import {
  parseActor,
  parseEntityRef,
  parseFail,
  parseOk,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { Actor, EntityRef, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseLedgerEventId } from '@office/events';
import type { LedgerEventId } from '@office/events';
import { domainError, fail, ok, parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import {
  describeValue,
  isPlainObject,
  parseValueArray,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';
import { parseSourceRef, sourceRefKeyOf } from './source-ref';
import type { SourceRef } from './source-ref';
import type { SourceCoordinate } from './source-ref';

declare const conflictIdBrand: unique symbol;

/** Deterministic identity of one conflict record: office-cfl-v1-<opaque>. */
export type ConflictId = string & { readonly [conflictIdBrand]: 'ConflictId' };

/** Grammar description used in parse failures. */
export const CONFLICT_ID_GRAMMAR =
  'office-cfl-v1-<opaque: 16..64 lowercase alphanumeric> (derived deterministically from both sides)';

/** The closed resolution-strategy vocabulary. */
export type ConflictResolutionStrategy = 'merge' | 'canonical-wins' | 'provider-wins';

/** Lifecycle state of a conflict record. */
export type ConflictState = 'detected' | 'resolved';

/** The explicit resolution of a conflict: strategy, actor, time, and audit evidence. */
export interface ConflictResolution {
  readonly kind: 'conflict-resolution';
  /** How the divergence was reconciled (closed vocabulary). */
  readonly strategy: ConflictResolutionStrategy;
  /** The actor that explicitly resolved the conflict. */
  readonly resolvedBy: Actor;
  /** When the resolution was recorded (injected clock). */
  readonly resolvedAt: Timestamp;
  /**
   * Ledger events proving the reconciliation — at least one, no duplicates.
   * A resolution without an audit trail is typed-rejected, never accepted.
   */
  readonly auditEventRefs: readonly LedgerEventId[];
}

/** The explicit divergence record: both sides' refs/versions + resolution state. */
export interface Conflict {
  readonly kind: 'source-conflict';
  /** Deterministic identity (derived from both sides — see conflictIdOf). */
  readonly conflictId: ConflictId;
  /** Owning tenant (freeze A12). */
  readonly tenantId: TenantId;
  /** The provider side: full source ref INCLUDING the provider version. */
  readonly source: SourceRef;
  /** The canonical side: the office entity the source maps to. */
  readonly canonical: EntityRef;
  /** The canonical aggregate version at detection (the canonical side's version). */
  readonly canonicalVersion: AggregateVersion;
  /** When the divergence was detected (injected clock of the detecting sync). */
  readonly detectedAt: Timestamp;
  /** The adapter actor whose sync detected the divergence. */
  readonly detectedBy: Actor;
  /** Lifecycle state: conflicts land 'detected' and are resolved only explicitly. */
  readonly state: ConflictState;
  /** The resolution, exactly when state === 'resolved' (else null). */
  readonly resolution: ConflictResolution | null;
}

/** Shape description used in parse failures. */
export const CONFLICT_RESOLUTION_GRAMMAR =
  "ConflictResolution: { kind: 'conflict-resolution', strategy: 'merge' | 'canonical-wins' | 'provider-wins', resolvedBy, resolvedAt, auditEventRefs: LedgerEventId[] (>= 1, no duplicates) }";

/** Shape description used in parse failures. */
export const CONFLICT_GRAMMAR =
  'Conflict: { kind, conflictId, tenantId, source, canonical, canonicalVersion, detectedAt, detectedBy, state, resolution }';

const CONFLICT_RESOLUTION_KEYS = [
  'kind',
  'strategy',
  'resolvedBy',
  'resolvedAt',
  'auditEventRefs',
] as const;
const CONFLICT_KEYS = [
  'kind',
  'conflictId',
  'tenantId',
  'source',
  'canonical',
  'canonicalVersion',
  'detectedAt',
  'detectedBy',
  'state',
  'resolution',
] as const;

const CONFLICT_ID_PREFIX = 'office-cfl-v1-';
const CONFLICT_ID_PATTERN = /^[0-9a-z]{16,64}$/;
const DERIVED_OPAQUE_LENGTH = 32;

/** Parse an untrusted value as a ConflictId (total, fail-closed). */
export function parseConflictId(raw: unknown): ParseResult<ConflictId> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(CONFLICT_ID_PREFIX) ||
    !CONFLICT_ID_PATTERN.test(raw.slice(CONFLICT_ID_PREFIX.length))
  ) {
    return parseFail('invalid-value', '', CONFLICT_ID_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as ConflictId);
}

/** Type guard for structurally valid ConflictId values. */
export function isConflictId(raw: unknown): raw is ConflictId {
  return parseConflictId(raw).ok;
}

/** Compose a ConflictId from validated parts (trusted path). */
export function conflictId(raw: string): ConflictId {
  const parsed = parseConflictId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid conflict id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/**
 * Both sides of one divergence — the derivation input of a conflict id.
 * Identical sides derive identical ids (re-detection is idempotent); a moved
 * version on either side derives a NEW id (a Conflict pins the exact pair).
 */
export interface ConflictSides {
  readonly tenantId: TenantId;
  readonly source: SourceRef;
  readonly canonical: EntityRef;
  readonly canonicalVersion: AggregateVersion;
}

/**
 * Derive the conflict id of a divergence pair (deterministic, pure): the
 * first 32 hex characters of sha256 over
 * `tenant|sourceRefKey|canonicalKind|canonicalId|canonicalVersion`.
 */
export function conflictIdOf(sides: ConflictSides): ConflictId {
  const digest = createHash('sha256')
    .update(
      `${sides.tenantId}|${sourceRefKeyOf(sides.source)}|${sides.canonical.entityKind}|${sides.canonical.entityId}|${sides.canonicalVersion}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, DERIVED_OPAQUE_LENGTH);
  return conflictId(`${CONFLICT_ID_PREFIX}${digest}`);
}

/** Parse an untrusted value as a ConflictResolution (total, fail-closed, strict keys). */
export function parseConflictResolution(raw: unknown): ParseResult<ConflictResolution> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONFLICT_RESOLUTION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    CONFLICT_RESOLUTION_KEYS,
    '',
    CONFLICT_RESOLUTION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['conflict-resolution']);
  if (!kind.ok) return kind;
  const strategy = requireLiteral(raw, 'strategy', '', [
    'merge',
    'canonical-wins',
    'provider-wins',
  ]);
  if (!strategy.ok) return strategy;
  const resolvedBy = requireFieldWith(raw, 'resolvedBy', '', parseActor);
  if (!resolvedBy.ok) return resolvedBy;
  const resolvedAt = requireFieldWith(raw, 'resolvedAt', '', parseTimestamp);
  if (!resolvedAt.ok) return resolvedAt;
  const auditEventRefs = parseValueArray(
    raw['auditEventRefs'],
    'auditEventRefs',
    parseLedgerEventId,
    'array of ledger event ids proving the reconciliation (>= 1, no duplicates)',
  );
  if (!auditEventRefs.ok) return auditEventRefs;
  if (auditEventRefs.value.length < 1) {
    return parseFail(
      'invalid-value',
      'auditEventRefs',
      'at least one ledger event id (a resolution without an audit trail is rejected)',
      'empty array',
    );
  }
  return parseOk(
    {
      kind: 'conflict-resolution',
      strategy: strategy.value as ConflictResolutionStrategy,
      resolvedBy: resolvedBy.value,
      resolvedAt: resolvedAt.value,
      auditEventRefs: auditEventRefs.value,
    } satisfies ConflictResolution,
  );
}

/** Type guard for structurally valid ConflictResolution values. */
export function isConflictResolution(raw: unknown): raw is ConflictResolution {
  return parseConflictResolution(raw).ok;
}

/** Parse an untrusted value as a Conflict (total, fail-closed, strict keys). */
export function parseConflict(raw: unknown): ParseResult<Conflict> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONFLICT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CONFLICT_KEYS, '', CONFLICT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['source-conflict']);
  if (!kind.ok) return kind;
  const conflictIdResult = requireFieldWith(raw, 'conflictId', '', parseConflictId);
  if (!conflictIdResult.ok) return conflictIdResult;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const source = requireFieldWith(raw, 'source', '', parseSourceRef);
  if (!source.ok) return source;
  const canonical = requireFieldWith(raw, 'canonical', '', parseEntityRef);
  if (!canonical.ok) return canonical;
  const canonicalVersion = requireFieldWith(raw, 'canonicalVersion', '', parseAggregateVersion);
  if (!canonicalVersion.ok) return canonicalVersion;
  const detectedAt = requireFieldWith(raw, 'detectedAt', '', parseTimestamp);
  if (!detectedAt.ok) return detectedAt;
  const detectedBy = requireFieldWith(raw, 'detectedBy', '', parseActor);
  if (!detectedBy.ok) return detectedBy;
  const state = requireLiteral(raw, 'state', '', ['detected', 'resolved']);
  if (!state.ok) return state;
  const resolution = requireNullableFieldWith(raw, 'resolution', '', parseConflictResolution);
  if (!resolution.ok) return resolution;
  if ((state.value === 'resolved') !== (resolution.value !== null)) {
    return parseFail(
      'invalid-value',
      'resolution',
      'present exactly when state is resolved (null otherwise)',
      `state '${state.value}' with resolution ${resolution.value === null ? 'null' : 'present'}`,
    );
  }
  return parseOk(
    {
      kind: 'source-conflict',
      conflictId: conflictIdResult.value,
      tenantId: tenantId.value,
      source: source.value,
      canonical: canonical.value,
      canonicalVersion: canonicalVersion.value,
      detectedAt: detectedAt.value,
      detectedBy: detectedBy.value,
      state: state.value as ConflictState,
      resolution: resolution.value,
    } satisfies Conflict,
  );
}

/** Type guard for structurally valid Conflict values. */
export function isConflict(raw: unknown): raw is Conflict {
  return parseConflict(raw).ok;
}

/**
 * Build the DETECTED conflict record of a divergence pair (trusted path; the
 * engines use this — detection never resolves). The id is derived from the
 * sides; state is 'detected'; resolution is null.
 */
export function detectedConflict(parts: {
  readonly tenantId: TenantId;
  readonly source: SourceRef;
  readonly canonical: EntityRef;
  readonly canonicalVersion: AggregateVersion;
  readonly detectedAt: Timestamp;
  readonly detectedBy: Actor;
}): Conflict {
  return {
    kind: 'source-conflict',
    conflictId: conflictIdOf(parts),
    tenantId: parts.tenantId,
    source: parts.source,
    canonical: parts.canonical,
    canonicalVersion: parts.canonicalVersion,
    detectedAt: parts.detectedAt,
    detectedBy: parts.detectedBy,
    state: 'detected',
    resolution: null,
  };
}

/** The exact parts of a conflict its id was derived from (identity check). */
const sidesOf = (conflict: Conflict): ConflictSides => ({
  tenantId: conflict.tenantId,
  source: conflict.source,
  canonical: conflict.canonical,
  canonicalVersion: conflict.canonicalVersion,
});

/** Do two records describe the same divergence pair (id derivation input)? */
const sameSides = (a: Conflict, b: Conflict): boolean =>
  conflictIdOf(sidesOf(a)) === conflictIdOf(sidesOf(b)) &&
  a.tenantId === b.tenantId &&
  sourceRefKeyOf(a.source) === sourceRefKeyOf(b.source) &&
  a.canonical.entityKind === b.canonical.entityKind &&
  a.canonical.entityId === b.canonical.entityId &&
  a.canonicalVersion === b.canonicalVersion;

/** Do two resolutions carry the same explicit decision (idempotent replay)? */
const sameResolution = (a: ConflictResolution, b: ConflictResolution): boolean =>
  a.strategy === b.strategy &&
  JSON.stringify(a.resolvedBy) === JSON.stringify(b.resolvedBy) &&
  a.auditEventRefs.length === b.auditEventRefs.length &&
  a.auditEventRefs.every((ref, index) => ref === b.auditEventRefs[index]);

/**
 * Resolve a conflict EXPLICITLY (the only resolution path — no engine ever
 * calls this): build the resolved record citing the ledger events that prove
 * the reconciliation, then persist it through the store. Requirements, all
 * typed-rejected otherwise: the conflict is in the 'detected' state (or
 * already resolved IDENTICALLY — an idempotent replay); the strategy is from
 * the closed vocabulary; the audit refs cite at least one ledger event with
 * no duplicates. The actual reconciliation happens through canonical
 * commands BEFORE the resolution is recorded — the refs are its evidence.
 */
export async function resolveConflict(parts: {
  readonly store: ConflictStore;
  readonly conflict: Conflict;
  readonly strategy: ConflictResolutionStrategy;
  readonly resolvedBy: Actor;
  readonly auditEventRefs: readonly LedgerEventId[];
  readonly now: Timestamp;
}): Promise<Result<Conflict, DomainError>> {
  const resolutionInput = {
    kind: 'conflict-resolution',
    strategy: parts.strategy,
    resolvedBy: parts.resolvedBy,
    resolvedAt: parts.now,
    auditEventRefs: parts.auditEventRefs,
  } satisfies ConflictResolution;
  const parsed = parseConflictResolution(resolutionInput);
  if (!parsed.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `invalid conflict resolution: ${parsed.error.code} at '${parsed.error.path}'`,
        [{ code: `conflict-resolution-${parsed.error.code}`, message: parsed.error.received, path: parsed.error.path }],
        { scope: { kind: 'tenant', tenantId: parts.conflict.tenantId } },
      ),
    );
  }
  if (parts.conflict.state === 'resolved') {
    const existing = parts.conflict.resolution;
    if (existing !== null && sameResolution(existing, parsed.value)) {
      return ok(parts.conflict); // idempotent replay of the identical resolution
    }
    return fail(alreadyResolved(parts.conflict));
  }
  const resolved: Conflict = {
    ...parts.conflict,
    state: 'resolved',
    resolution: parsed.value,
  };
  return parts.store.recordResolution(resolved);
}

/**
 * Storage port for conflict records. Implementations MUST key by tenant
 * (A12 — foreign tenants' conflicts are invisible, no existence oracle) and
 * MUST keep append idempotent per divergence pair.
 */
export interface ConflictStore {
  /**
   * Append a detected conflict. Appending the SAME divergence pair again is
   * an idempotent no-op returning the existing record; appending a different
   * pair under an existing id is a typed invariant-violation.
   */
  append(conflict: Conflict): Promise<Result<Conflict, DomainError>>;
  /** The tenant's conflict by id, or null when absent (tenant-scoped). */
  findById(tenantId: TenantId, conflictId: ConflictId): Promise<Conflict | null>;
  /** The tenant's conflicts for one provider coordinate, insertion order. */
  listBySource(tenantId: TenantId, coordinate: SourceCoordinate): Promise<readonly Conflict[]>;
  /** Persist an explicitly resolved record (see resolveConflict). */
  recordResolution(resolved: Conflict): Promise<Result<Conflict, DomainError>>;
}

/** Deterministic in-memory ConflictStore (the SDK's test fixture). */
export function createInMemoryConflictStore(): ConflictStore {
  const byId = new Map<string, Conflict>();
  const bySource = new Map<string, Conflict[]>();
  const sourceKey = (tenantId: TenantId, coordinate: SourceCoordinate): string =>
    `${tenantId}|${coordinate.adapterKind}|${coordinate.systemId}|${coordinate.objectType}|${coordinate.objectId}`;
  const index = (conflict: Conflict): void => {
    const key = sourceKey(conflict.tenantId, conflict.source);
    const list = bySource.get(key) ?? [];
    const withoutThisId = list.filter((entry) => entry.conflictId !== conflict.conflictId);
    bySource.set(key, [...withoutThisId, conflict]);
  };
  return {
    async append(conflict) {
      const existing = byId.get(conflict.conflictId);
      if (existing !== undefined) {
        if (sameSides(existing, conflict)) return ok(existing);
        return fail(
          domainError(
            'invariant-violation',
            `conflict id ${conflict.conflictId} already records a different divergence pair — ids are derived from both sides`,
            [{ code: 'conflict-id-collision', message: conflict.conflictId, path: 'conflictId' }],
            { scope: { kind: 'tenant', tenantId: conflict.tenantId } },
          ),
        );
      }
      byId.set(conflict.conflictId, conflict);
      index(conflict);
      return ok(conflict);
    },
    async findById(tenantId, conflictId) {
      const found = byId.get(conflictId);
      return found !== undefined && found.tenantId === tenantId ? found : null;
    },
    async listBySource(tenantId, coordinate) {
      return [...(bySource.get(sourceKey(tenantId, coordinate)) ?? [])];
    },
    async recordResolution(resolved) {
      const existing = byId.get(resolved.conflictId);
      if (existing === undefined || !sameSides(existing, resolved)) {
        return fail(
          domainError(
            'not-found',
            `conflict ${resolved.conflictId} is not recorded for this divergence pair — resolve detects, never invents`,
            [{ code: 'conflict-not-found', message: resolved.conflictId, path: 'conflictId' }],
            { scope: { kind: 'tenant', tenantId: resolved.tenantId } },
          ),
        );
      }
      if (existing.state === 'resolved') {
        if (
          existing.resolution !== null &&
          resolved.resolution !== null &&
          sameResolution(existing.resolution, resolved.resolution)
        ) {
          return ok(existing); // idempotent replay
        }
        return fail(alreadyResolved(existing));
      }
      byId.set(resolved.conflictId, resolved);
      index(resolved);
      return ok(resolved);
    },
  };
}

const alreadyResolved = (conflict: Conflict): DomainError =>
  domainError(
    'invariant-violation',
    `conflict ${conflict.conflictId} is already resolved (${conflict.resolution?.strategy ?? 'unknown'} strategy) — a conflict is resolved exactly once`,
    [{ code: 'conflict-already-resolved', message: conflict.conflictId, path: 'state' }],
    { scope: { kind: 'tenant', tenantId: conflict.tenantId } },
  );
