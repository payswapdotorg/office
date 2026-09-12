import { describe, expect, it } from 'vitest';
import { formatEntityId, parseEntityKind, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, TenantId, Timestamp } from '@office/contracts';
import { parseLedgerEventId } from '@office/events';
import { parseAggregateVersion } from '@office/domain-kernel';
import {
  conflictId,
  conflictIdOf,
  createInMemoryConflictStore,
  detectedConflict,
  isConflict,
  isConflictId,
  isConflictResolution,
  parseConflict,
  parseConflictId,
  parseConflictResolution,
  resolveConflict,
} from './conflict';
import type { Conflict } from './conflict';
import { adapterKind, providerObjectKind, providerObjectId, providerSystemId, providerVersion } from './identity';
import { sourceRef } from './source-ref';
import type { ConflictSides } from './conflict';

// OFF-020 adapters-sdk — explicit conflict records. A detected divergence
// lands in the 'detected' state with BOTH sides' refs/versions recorded and
// stays there: no destructive automatic resolution (frozen anti-pattern for
// material commercial state). Resolution is an explicit command citing at
// least one ledger event (the audit trail of the reconciliation performed
// BEFORE the resolution is recorded); resolving twice identically is an
// idempotent replay, resolving differently is a typed violation. Conflict
// ids derive deterministically from both sides, so re-detecting the same
// divergence is an idempotent append. Deterministic: fixed ids/instants.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160504f3e2d1c0b'));

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));

const entity = (n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `org${String(n).padStart(13, '0')}` });

const ACTOR = { kind: 'adapter', actorId: entity(90) } as const;
const RESOLVER = { kind: 'user', actorId: entity(91) } as const;

const auditRef = (n: number) =>
  unwrap(parseLedgerEventId(`office-evt-v1-${'a'.repeat(31)}${String(n).padStart(1, '0')}`));

const SOURCE_V2 = sourceRef({
  adapterKind: adapterKind('fake-crm'),
  systemId: providerSystemId('fake-instance-01'),
  objectType: providerObjectKind('contact'),
  objectId: providerObjectId('c-1'),
  version: providerVersion('v2'),
});
const SOURCE_V3 = { ...SOURCE_V2, version: providerVersion('v3') };
const ORGANIZATION = unwrap(parseEntityKind('organization'));
const version = (n: number) => unwrap(parseAggregateVersion(n));
const CANONICAL = { entityKind: ORGANIZATION, entityId: entity(1) };

const sides = (overrides?: Partial<ConflictSides>): ConflictSides => ({
  tenantId: TENANT_A,
  source: SOURCE_V2,
  canonical: CANONICAL,
  canonicalVersion: version(2),
  ...overrides,
});

describe('conflict id derivation (deterministic from both sides)', () => {
  it('derives the same id for the same divergence pair', () => {
    expect(conflictIdOf(sides())).toBe(conflictIdOf(sides()));
  });

  it('derives a NEW id when either side moves (a conflict pins its pair)', () => {
    expect(conflictIdOf(sides({ source: SOURCE_V3 }))).not.toBe(conflictIdOf(sides()));
    expect(conflictIdOf(sides({ canonicalVersion: version(3) }))).not.toBe(conflictIdOf(sides()));
    expect(
      conflictIdOf(sides({ canonical: { entityKind: ORGANIZATION, entityId: entity(2) } })),
    ).not.toBe(conflictIdOf(sides()));
    expect(conflictIdOf(sides({ tenantId: TENANT_B }))).not.toBe(conflictIdOf(sides()));
  });

  it('parses derived ids and rejects malformed ones fail-closed', () => {
    const id = conflictIdOf(sides());
    expect(parseConflictId(id).ok).toBe(true);
    expect(isConflictId(id)).toBe(true);
    for (const raw of [
      '',
      'office-cfl-v1-',
      'office-cfl-v1-short',
      'office-cfl-v1-ABCDEF0123456789ABCDEF0123456789',
      'office-whk-v1-abcdef0123456789abcdef0123456789',
      7,
      null,
    ]) {
      expect(parseConflictId(raw).ok, `raw: ${String(raw)}`).toBe(false);
      expect(isConflictId(raw)).toBe(false);
    }
    expect(() => conflictId('office-cfl-v1-noupper')).toThrow(TypeError);
  });
});

describe('detected conflicts (both sides recorded, never auto-resolved)', () => {
  it('builds a detected record carrying both sides and no resolution', () => {
    const conflict = detectedConflict({
      tenantId: TENANT_A,
      source: SOURCE_V2,
      canonical: CANONICAL,
      canonicalVersion: version(2),
      detectedAt: NOW_1,
      detectedBy: ACTOR,
    });
    expect(conflict.kind).toBe('source-conflict');
    expect(conflict.conflictId).toBe(conflictIdOf(sides()));
    expect(conflict.tenantId).toBe(TENANT_A);
    expect(conflict.source).toStrictEqual(SOURCE_V2);
    expect(conflict.canonical).toStrictEqual(CANONICAL);
    expect(conflict.canonicalVersion).toBe(2);
    expect(conflict.detectedAt).toBe(NOW_1);
    expect(conflict.detectedBy).toStrictEqual(ACTOR);
    expect(conflict.state).toBe('detected');
    expect(conflict.resolution).toBeNull();
    // Round-trips strict parsing.
    const parsed = parseConflict(conflict);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(conflict);
    expect(isConflict(conflict)).toBe(true);
  });

  it('rejects malformed conflict records fail-closed (state/resolution pairing)', () => {
    const detected = detectedConflict({
      tenantId: TENANT_A,
      source: SOURCE_V2,
      canonical: CANONICAL,
      canonicalVersion: version(2),
      detectedAt: NOW_1,
      detectedBy: ACTOR,
    });
    for (const raw of [
      null,
      'conflict',
      { ...detected, kind: 'other-conflict' },
      { ...detected, unknown: 'field' },
      { ...detected, state: 'merged' },
      // detected state with a resolution present is structurally invalid
      {
        ...detected,
        resolution: {
          kind: 'conflict-resolution',
          strategy: 'merge',
          resolvedBy: RESOLVER,
          resolvedAt: NOW_1,
          auditEventRefs: [auditRef(1)],
        },
      },
    ]) {
      expect(parseConflict(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isConflict(raw)).toBe(false);
    }
  });
});

describe('the conflict store (append idempotence, tenant scoping)', () => {
  it('appends a detected conflict once — re-detection is an idempotent no-op', async () => {
    const store = createInMemoryConflictStore();
    const first = detectedConflict({
      tenantId: TENANT_A,
      source: SOURCE_V2,
      canonical: CANONICAL,
      canonicalVersion: version(2),
      detectedAt: NOW_1,
      detectedBy: ACTOR,
    });
    const appended = unwrap(await store.append(first));
    expect(appended).toStrictEqual(first);
    // The same divergence pair detected again (a re-run of the same sync
    // page) appends nothing new: the existing record comes back.
    const again = unwrap(await store.append(first));
    expect(again).toStrictEqual(first);
    expect(
      await store.listBySource(TENANT_A, {
        adapterKind: SOURCE_V2.adapterKind,
        systemId: SOURCE_V2.systemId,
        objectType: SOURCE_V2.objectType,
        objectId: SOURCE_V2.objectId,
      }),
    ).toHaveLength(1);
  });

  it('records separate conflicts for separate divergence pairs', async () => {
    const store = createInMemoryConflictStore();
    unwrap(
      await store.append(
        detectedConflict({
          tenantId: TENANT_A,
          source: SOURCE_V2,
          canonical: CANONICAL,
          canonicalVersion: version(2),
          detectedAt: NOW_1,
          detectedBy: ACTOR,
        }),
      ),
    );
    const moved = unwrap(
      await store.append(
        detectedConflict({
          tenantId: TENANT_A,
          source: SOURCE_V3,
          canonical: CANONICAL,
          canonicalVersion: version(3),
          detectedAt: NOW_2,
          detectedBy: ACTOR,
        }),
      ),
    );
    const coordinate = {
      adapterKind: SOURCE_V2.adapterKind,
      systemId: SOURCE_V2.systemId,
      objectType: SOURCE_V2.objectType,
      objectId: SOURCE_V2.objectId,
    };
    const listed = await store.listBySource(TENANT_A, coordinate);
    expect(listed).toHaveLength(2);
    expect(listed[1]?.conflictId).toBe(moved.conflictId);
  });

  it('typed-rejects a different pair recorded under an existing id', async () => {
    const store = createInMemoryConflictStore();
    const first = detectedConflict({
      tenantId: TENANT_A,
      source: SOURCE_V2,
      canonical: CANONICAL,
      canonicalVersion: version(2),
      detectedAt: NOW_1,
      detectedBy: ACTOR,
    });
    unwrap(await store.append(first));
    // Same derived id, different sides: impossible through detectedConflict
    // (ids derive from sides) — presented directly it must fail closed.
    const forged: Conflict = { ...first, canonicalVersion: version(9) };
    const collision = await store.append(forged);
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.error.code).toBe('invariant-violation');
      expect(collision.error.details[0]?.code).toBe('conflict-id-collision');
    }
  });

  it('scopes findById by tenant — a foreign tenant sees no existence oracle', async () => {
    const store = createInMemoryConflictStore();
    const conflict = unwrap(
      await store.append(
        detectedConflict({
          tenantId: TENANT_A,
          source: SOURCE_V2,
          canonical: CANONICAL,
          canonicalVersion: version(2),
          detectedAt: NOW_1,
          detectedBy: ACTOR,
        }),
      ),
    );
    expect(await store.findById(TENANT_A, conflict.conflictId)).toStrictEqual(conflict);
    expect(await store.findById(TENANT_B, conflict.conflictId)).toBeNull();
    expect(await store.listBySource(TENANT_B, {
      adapterKind: SOURCE_V2.adapterKind,
      systemId: SOURCE_V2.systemId,
      objectType: SOURCE_V2.objectType,
      objectId: SOURCE_V2.objectId,
    })).toStrictEqual([]);
  });
});

describe('explicit resolution (the only resolution path)', () => {
  const detected = detectedConflict({
    tenantId: TENANT_A,
    source: SOURCE_V2,
    canonical: CANONICAL,
    canonicalVersion: version(2),
    detectedAt: NOW_1,
    detectedBy: ACTOR,
  });

  it('resolves a detected conflict with strategy, actor, and audit event refs', async () => {
    const store = createInMemoryConflictStore();
    unwrap(await store.append(detected));
    const resolved = unwrap(
      await resolveConflict({
        store,
        conflict: detected,
        strategy: 'provider-wins',
        resolvedBy: RESOLVER,
        auditEventRefs: [auditRef(1), auditRef(2)],
        now: NOW_2,
      }),
    );
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolution).not.toBeNull();
    if (resolved.resolution !== null) {
      expect(resolved.resolution.strategy).toBe('provider-wins');
      expect(resolved.resolution.resolvedBy).toStrictEqual(RESOLVER);
      expect(resolved.resolution.resolvedAt).toBe(NOW_2);
      expect(resolved.resolution.auditEventRefs).toStrictEqual([auditRef(1), auditRef(2)]);
      // The resolution itself round-trips strict parsing.
      expect(parseConflictResolution(resolved.resolution).ok).toBe(true);
      expect(isConflictResolution(resolved.resolution)).toBe(true);
    }
    // Both sides stay recorded on the resolved record.
    expect(resolved.source).toStrictEqual(SOURCE_V2);
    expect(resolved.canonical).toStrictEqual(CANONICAL);
    expect(resolved.canonicalVersion).toBe(2);
    // The store carries the resolved record now.
    expect((await store.findById(TENANT_A, detected.conflictId))?.state).toBe('resolved');
    // The full resolved record round-trips strict parsing.
    expect(parseConflict(resolved).ok).toBe(true);
  });

  it('typed-rejects a resolution without an audit trail (>= 1 ledger event)', async () => {
    const store = createInMemoryConflictStore();
    unwrap(await store.append(detected));
    const noAudit = await resolveConflict({
      store,
      conflict: detected,
      strategy: 'merge',
      resolvedBy: RESOLVER,
      auditEventRefs: [],
      now: NOW_2,
    });
    expect(noAudit.ok).toBe(false);
    if (!noAudit.ok) {
      expect(noAudit.error.code).toBe('invariant-violation');
      expect(noAudit.error.details[0]?.code).toBe('conflict-resolution-invalid-value');
    }
    // Duplicated audit refs are rejected too (set-like evidence).
    const duplicated = await resolveConflict({
      store,
      conflict: detected,
      strategy: 'merge',
      resolvedBy: RESOLVER,
      auditEventRefs: [auditRef(1), auditRef(1)],
      now: NOW_2,
    });
    expect(duplicated.ok).toBe(false);
    // The conflict is untouched — still detected.
    expect((await store.findById(TENANT_A, detected.conflictId))?.state).toBe('detected');
  });

  it('is idempotent for the identical resolution and typed-rejects a different one', async () => {
    const store = createInMemoryConflictStore();
    unwrap(await store.append(detected));
    const resolved = unwrap(
      await resolveConflict({
        store,
        conflict: detected,
        strategy: 'canonical-wins',
        resolvedBy: RESOLVER,
        auditEventRefs: [auditRef(1)],
        now: NOW_2,
      }),
    );
    // Replaying the exact same resolution is an idempotent no-op.
    const replay = unwrap(
      await resolveConflict({
        store,
        conflict: resolved,
        strategy: 'canonical-wins',
        resolvedBy: RESOLVER,
        auditEventRefs: [auditRef(1)],
        now: NOW_2,
      }),
    );
    expect(replay).toStrictEqual(resolved);
    // A DIFFERENT resolution of the same conflict is a typed violation.
    const different = await resolveConflict({
      store,
      conflict: resolved,
      strategy: 'provider-wins',
      resolvedBy: RESOLVER,
      auditEventRefs: [auditRef(1)],
      now: NOW_2,
    });
    expect(different.ok).toBe(false);
    if (!different.ok) {
      expect(different.error.code).toBe('invariant-violation');
      expect(different.error.details[0]?.code).toBe('conflict-already-resolved');
    }
  });

  it('typed-rejects resolving a divergence pair the store never detected', async () => {
    const store = createInMemoryConflictStore();
    const result = await resolveConflict({
      store,
      conflict: detected,
      strategy: 'merge',
      resolvedBy: RESOLVER,
      auditEventRefs: [auditRef(1)],
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('conflict-not-found');
    }
  });
});
