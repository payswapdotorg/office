// Office adapters-sdk — source identity mapping (OFF-020).
//
// The SourceMapping record binds a provider object coordinate (adapter kind,
// provider system, object type, object id — provider ids are NEVER canonical
// primary keys, freeze anti-pattern) to the office-issued canonical EntityRef
// it translates into. The mapping is a first-class, queryable, TENANT-SCOPED
// record (freeze A12): every store operation is keyed by tenant first, so a
// foreign tenant's mapping is invisible — a cross-tenant lookup is
// indistinguishable from absence (typed not-found, no existence oracle),
// mirroring the landed scoped-store convention.
//
// Bijection invariants (enforced by the store, never silently repaired):
//   forward — within a tenant, one provider coordinate maps to exactly one
//   canonical EntityRef; re-pointing a coordinate at a different canonical id
//   is a typed collision, never an overwrite;
//   reverse — within one (tenant, adapter kind, system, object type), one
//   canonical EntityRef binds at most one provider object; a second provider
//   object claiming an already-bound canonical id is a typed collision.
//
// Version bookkeeping: `providerVersion` is the provider version last
// PROPOSED through this mapping (by the sync or webhook engine), and
// `canonicalVersion` is the canonical aggregate version observed at that
// proposal — the pair the conflict detector (conflict.ts, sync.ts) compares
// against the live provider version and the live canonical version to detect
// divergent updates on both sides.
import {
  parseActor,
  parseEntityRef,
  parseFail,
  parseOk,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { Actor, EntityRef, ParseResult, TenantId, Timestamp } from '@office/contracts';
import {
  domainError,
  fail,
  ok,
  parseAggregateVersion,
} from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { describeValue, isPlainObject, requireFieldWith, unknownKeyFailure } from './parse';
import { parseProviderVersion } from './identity';
import type { ProviderVersion } from './identity';
import { parseSourceCoordinate, sourceCoordinateKeyOf } from './source-ref';
import type { SourceCoordinate } from './source-ref';

/** The tenant-scoped identity binding: provider coordinate ↔ canonical entity. */
export interface SourceMapping {
  readonly kind: 'source-mapping';
  /** Owning tenant (freeze A12 — every persisted entity is tenant-scoped). */
  readonly tenantId: TenantId;
  /** The provider object's stable identity (version-less). */
  readonly coordinate: SourceCoordinate;
  /** The office-issued canonical entity this provider object translates into. */
  readonly canonical: EntityRef;
  /** Provider version last proposed through this mapping (never null). */
  readonly providerVersion: ProviderVersion;
  /** Canonical aggregate version observed at that proposal (starts at 1). */
  readonly canonicalVersion: AggregateVersion;
  /** The adapter actor that established the mapping. */
  readonly actor: Actor;
  /** When the binding was first recorded. */
  readonly mappedAt: Timestamp;
  /** When the binding was last advanced (version bookkeeping). */
  readonly lastSyncedAt: Timestamp;
}

/** Shape description used in parse failures. */
export const SOURCE_MAPPING_GRAMMAR =
  'SourceMapping: { kind, tenantId, coordinate, canonical, providerVersion, canonicalVersion, actor, mappedAt, lastSyncedAt }';

const SOURCE_MAPPING_KEYS = [
  'kind',
  'tenantId',
  'coordinate',
  'canonical',
  'providerVersion',
  'canonicalVersion',
  'actor',
  'mappedAt',
  'lastSyncedAt',
] as const;

/** Parse an untrusted value as a SourceMapping (total, fail-closed, strict keys). */
export function parseSourceMapping(raw: unknown): ParseResult<SourceMapping> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SOURCE_MAPPING_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SOURCE_MAPPING_KEYS, '', SOURCE_MAPPING_GRAMMAR);
  if (unknownKey) return unknownKey;
  if (raw['kind'] !== 'source-mapping') {
    return parseFail('invalid-value', 'kind', "'source-mapping'", describeValue(raw['kind']));
  }
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const coordinate = requireFieldWith(raw, 'coordinate', '', parseSourceCoordinate);
  if (!coordinate.ok) return coordinate;
  const canonical = requireFieldWith(raw, 'canonical', '', parseEntityRef);
  if (!canonical.ok) return canonical;
  const providerVersion = requireFieldWith(raw, 'providerVersion', '', parseProviderVersion);
  if (!providerVersion.ok) return providerVersion;
  const canonicalVersion = requireFieldWith(raw, 'canonicalVersion', '', parseAggregateVersion);
  if (!canonicalVersion.ok) return canonicalVersion;
  const actor = requireFieldWith(raw, 'actor', '', parseActor);
  if (!actor.ok) return actor;
  const mappedAt = requireFieldWith(raw, 'mappedAt', '', parseTimestamp);
  if (!mappedAt.ok) return mappedAt;
  const lastSyncedAt = requireFieldWith(raw, 'lastSyncedAt', '', parseTimestamp);
  if (!lastSyncedAt.ok) return lastSyncedAt;
  return parseOk(
    {
      kind: 'source-mapping',
      tenantId: tenantId.value,
      coordinate: coordinate.value,
      canonical: canonical.value,
      providerVersion: providerVersion.value,
      canonicalVersion: canonicalVersion.value,
      actor: actor.value,
      mappedAt: mappedAt.value,
      lastSyncedAt: lastSyncedAt.value,
    } satisfies SourceMapping,
  );
}

/** Type guard for structurally valid SourceMapping values. */
export function isSourceMapping(raw: unknown): raw is SourceMapping {
  return parseSourceMapping(raw).ok;
}

/** Compose a SourceMapping from validated parts (trusted path; loud TypeError). */
export function sourceMapping(parts: {
  readonly tenantId: TenantId;
  readonly coordinate: SourceCoordinate;
  readonly canonical: EntityRef;
  readonly providerVersion: ProviderVersion;
  readonly canonicalVersion: AggregateVersion;
  readonly actor: Actor;
  readonly mappedAt: Timestamp;
  readonly lastSyncedAt: Timestamp;
}): SourceMapping {
  const parsed = parseSourceMapping({ ...parts, kind: 'source-mapping' });
  if (!parsed.ok) {
    throw new TypeError(`invalid source mapping: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Storage port for source mappings. Implementations MUST key every operation
 * by tenant first (A12: foreign tenants' mappings are invisible — a
 * cross-tenant lookup is indistinguishable from absence) and MUST enforce the
 * forward/reverse bijection invariants on save (typed collisions, never
 * overwrites). The SQL implementation belongs to the runtime, not this SDK.
 */
export interface SourceMappingStore {
  /** The tenant's mapping for one provider coordinate, or null when none. */
  findByCoordinate(
    tenantId: TenantId,
    coordinate: SourceCoordinate,
  ): Promise<SourceMapping | null>;
  /** The tenant's mappings bound to one canonical entity (0..n, insertion order). */
  listByCanonical(tenantId: TenantId, canonical: EntityRef): Promise<readonly SourceMapping[]>;
  /**
   * Persist a mapping. Re-saving the same (tenant, coordinate, canonical)
   * triple advances the version bookkeeping; a coordinate re-pointed at a
   * different canonical id, or a second provider object claiming a bound
   * canonical id within the same system+type, is a typed collision.
   */
  save(mapping: SourceMapping): Promise<Result<SourceMapping, DomainError>>;
}

/** Deterministic in-memory SourceMappingStore (the SDK's test fixture). */
export function createInMemorySourceMappingStore(): SourceMappingStore {
  const forward = new Map<string, SourceMapping>();
  const reverse = new Map<string, SourceMapping[]>();
  const forwardKey = (tenantId: TenantId, coordinate: SourceCoordinate): string =>
    `${tenantId}|${sourceCoordinateKeyOf(coordinate)}`;
  const reverseKey = (tenantId: TenantId, canonical: EntityRef): string =>
    `${tenantId}|${canonical.entityKind}|${canonical.entityId}`;
  const sameCanonical = (a: EntityRef, b: EntityRef): boolean =>
    a.entityKind === b.entityKind && a.entityId === b.entityId;
  return {
    async findByCoordinate(tenantId, coordinate) {
      return forward.get(forwardKey(tenantId, coordinate)) ?? null;
    },
    async listByCanonical(tenantId, canonical) {
      return [...(reverse.get(reverseKey(tenantId, canonical)) ?? [])];
    },
    async save(mapping) {
      const existing = forward.get(forwardKey(mapping.tenantId, mapping.coordinate));
      if (existing !== undefined && !sameCanonical(existing.canonical, mapping.canonical)) {
        return fail(forwardCollision(mapping, existing));
      }
      // Reverse invariant: within (tenant, adapter kind, system, object type),
      // a canonical EntityRef binds at most one provider object.
      const bound = reverse.get(reverseKey(mapping.tenantId, mapping.canonical)) ?? [];
      const conflicting = bound.find(
        (candidate) =>
          candidate.coordinate.adapterKind === mapping.coordinate.adapterKind &&
          candidate.coordinate.systemId === mapping.coordinate.systemId &&
          candidate.coordinate.objectType === mapping.coordinate.objectType &&
          candidate.coordinate.objectId !== mapping.coordinate.objectId,
      );
      if (conflicting !== undefined) {
        return fail(reverseCollision(mapping, conflicting));
      }
      // A re-save of the same (tenant, coordinate, canonical) binding keeps
      // the ORIGINAL mappedAt: the field records when the binding was first
      // established, and no write path — engine or direct — may rewrite that
      // history (only lastSyncedAt advances).
      const stored: SourceMapping =
        existing !== undefined ? { ...mapping, mappedAt: existing.mappedAt } : mapping;
      forward.set(forwardKey(mapping.tenantId, mapping.coordinate), stored);
      const key = reverseKey(mapping.tenantId, mapping.canonical);
      const list = reverse.get(key) ?? [];
      const withoutThisCoordinate = list.filter(
        (candidate) =>
          sourceCoordinateKeyOf(candidate.coordinate) !==
          sourceCoordinateKeyOf(mapping.coordinate),
      );
      reverse.set(key, [...withoutThisCoordinate, stored]);
      return ok(stored);
    },
  };
}

/**
 * Build and persist a mapping in one step (the engines' write path). The
 * canonical id MUST be office-issued (the caller's injected supplier) —
 * provider ids never reach this field.
 */
export async function recordSourceMapping(parts: {
  readonly store: SourceMappingStore;
  readonly tenantId: TenantId;
  readonly coordinate: SourceCoordinate;
  readonly canonical: EntityRef;
  readonly providerVersion: ProviderVersion;
  readonly canonicalVersion: AggregateVersion;
  readonly actor: Actor;
  readonly now: Timestamp;
}): Promise<Result<SourceMapping, DomainError>> {
  const record = sourceMapping({
    tenantId: parts.tenantId,
    coordinate: parts.coordinate,
    canonical: parts.canonical,
    providerVersion: parts.providerVersion,
    canonicalVersion: parts.canonicalVersion,
    actor: parts.actor,
    mappedAt: parts.now,
    lastSyncedAt: parts.now,
  });
  return parts.store.save(record);
}

/**
 * Typed A12 guard for PRESENTED mapping records (e.g. decoded from
 * persistence by the runtime): a mapping bound to another tenant is a typed
 * unauthorized rejection, never usable data.
 */
export function assertMappingTenant(
  mapping: SourceMapping,
  tenantId: TenantId,
): Result<true, DomainError> {
  if (mapping.tenantId === tenantId) return ok(true);
  return fail(
    domainError(
      'unauthorized',
      `mapping belongs to tenant ${mapping.tenantId} and cannot be used under tenant ${tenantId}`,
      [
        {
          code: 'tenant-scope-violation',
          message: `${mapping.tenantId} vs ${tenantId}`,
          path: null,
        },
      ],
      { scope: { kind: 'tenant', tenantId } },
    ),
  );
}

const forwardCollision = (attempted: SourceMapping, existing: SourceMapping): DomainError =>
  domainError(
    'invariant-violation',
    `provider object ${sourceCoordinateKeyOf(attempted.coordinate)} already maps to canonical ${existing.canonical.entityKind} ${existing.canonical.entityId}; re-pointing it at ${attempted.canonical.entityKind} ${attempted.canonical.entityId} is an explicit conflict, never an overwrite`,
    [
      {
        code: 'source-mapping-collision',
        message: `${existing.canonical.entityId} → ${attempted.canonical.entityId}`,
        path: 'canonical',
      },
    ],
    { scope: { kind: 'tenant', tenantId: attempted.tenantId } },
  );

const reverseCollision = (attempted: SourceMapping, bound: SourceMapping): DomainError =>
  domainError(
    'invariant-violation',
    `canonical ${attempted.canonical.entityKind} ${attempted.canonical.entityId} is already bound to provider object ${sourceCoordinateKeyOf(bound.coordinate)} in the same system; binding a second provider object is an explicit conflict, never an overwrite`,
    [
      {
        code: 'canonical-binding-collision',
        message: `${bound.coordinate.objectId} vs ${attempted.coordinate.objectId}`,
        path: 'coordinate',
      },
    ],
    { scope: { kind: 'tenant', tenantId: attempted.tenantId } },
  );
