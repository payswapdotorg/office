import { describe, expect, it } from 'vitest';
import { formatEntityId, parseEntityKind, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import {
  assertMappingTenant,
  createInMemorySourceMappingStore,
  isSourceMapping,
  parseSourceMapping,
  recordSourceMapping,
  sourceMapping,
} from './mapping';
import { adapterKind, providerObjectKind, providerObjectId, providerSystemId, providerVersion } from './identity';
import { coordinateOf, sourceRef } from './source-ref';
import type { SourceCoordinate } from './source-ref';

// OFF-020 adapters-sdk — source identity mapping (the A10/A12 seam). The
// SourceMapping record binds a provider object coordinate to an office-issued
// canonical EntityRef: tenant-scoped in BOTH directions (a foreign tenant's
// mapping is indistinguishable from absence — no existence oracle),
// deterministic (the same provider object re-synced resolves to the SAME
// canonical id), and bijective within (tenant, adapter kind, system, object
// type): re-pointing or double-binding is an explicit typed collision, never
// a silent overwrite. Deterministic: fixed tenants/ids/timestamps, in-memory
// store, no I/O.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160504f3e2d1c0b'));

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));

const entity = (n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `org${String(n).padStart(13, '0')}` });

const ACTOR = { kind: 'adapter', actorId: entity(90) } as const;

const KIND = adapterKind('fake-crm');
const SYSTEM = providerSystemId('fake-instance-01');
const TYPE = providerObjectKind('contact');

const coordinateOfObjectId = (objectId: string, systemId = SYSTEM): SourceCoordinate =>
  coordinateOf(
    sourceRef({
      adapterKind: KIND,
      systemId,
      objectType: TYPE,
      objectId: providerObjectId(objectId),
      version: providerVersion('v1'),
    }),
  );

const COORD_C1 = coordinateOfObjectId('c-1');
const COORD_C2 = coordinateOfObjectId('c-2');
const COORD_C1_OTHER_SYSTEM = coordinateOfObjectId('c-1', providerSystemId('fake-instance-02'));

const ORGANIZATION = unwrap(parseEntityKind('organization'));
const version = (n: number) => unwrap(parseAggregateVersion(n));
const canonical = (n: number) => ({ entityKind: ORGANIZATION, entityId: entity(n) });

describe('source mapping records (parse/compose)', () => {
  it('round-trips a mapping through strict fail-closed parsing', async () => {
    const mapping = unwrap(
      await recordSourceMapping({
        store: createInMemorySourceMappingStore(),
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    const parsed = parseSourceMapping(mapping);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(mapping);
    expect(isSourceMapping(mapping)).toBe(true);

    for (const raw of [
      null,
      { ...mapping, kind: 'other-mapping' },
      { ...mapping, unknown: 'field' },
      { ...mapping, canonicalVersion: 0 },
      { ...mapping, providerVersion: null },
    ]) {
      expect(parseSourceMapping(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isSourceMapping(raw)).toBe(false);
    }
  });

  it('composes on the trusted path and throws loudly on bad parts', () => {
    expect(() =>
      sourceMapping({
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        mappedAt: NOW_1,
        lastSyncedAt: NOW_1,
      }),
    ).not.toThrow();
    expect(() =>
      sourceMapping({
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion(''),
        canonicalVersion: version(1),
        actor: ACTOR,
        mappedAt: NOW_1,
        lastSyncedAt: NOW_1,
      }),
    ).toThrow(TypeError);
  });
});

describe('tenant scoping is structural (freeze A12, both directions)', () => {
  it('hides tenant A mappings from tenant B forwards (no existence oracle)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    // Forward lookup under the foreign tenant is indistinguishable from
    // absence: null, exactly as for a never-mapped coordinate.
    expect(await store.findByCoordinate(TENANT_B, COORD_C1)).toBeNull();
    expect(await store.findByCoordinate(TENANT_A, COORD_C2)).toBeNull();
  });

  it('hides tenant A mappings from tenant B in reverse (no existence oracle)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    expect(await store.listByCanonical(TENANT_A, canonical(1))).toHaveLength(1);
    expect(await store.listByCanonical(TENANT_B, canonical(1))).toStrictEqual([]);
  });

  it('typed-rejects a presented foreign-tenant mapping (assertMappingTenant)', async () => {
    const store = createInMemorySourceMappingStore();
    const mapping = unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    const own = assertMappingTenant(mapping, TENANT_A);
    expect(own.ok).toBe(true);
    const foreign = assertMappingTenant(mapping, TENANT_B);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('unauthorized');
      expect(foreign.error.details[0]?.code).toBe('tenant-scope-violation');
    }
  });
});

describe('deterministic identity (the same provider object maps to the same canonical id)', () => {
  it('resolves a re-synced provider object to the SAME canonical id', async () => {
    const store = createInMemorySourceMappingStore();
    const first = unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(7),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    // The provider advances the object (v2) and office re-syncs it: the
    // mapping ADVANCES its bookkeeping but the canonical binding is stable.
    const advanced = unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(7),
        providerVersion: providerVersion('v2'),
        canonicalVersion: version(3),
        actor: ACTOR,
        now: NOW_2,
      }),
    );
    expect(advanced.canonical.entityId).toBe(first.canonical.entityId);
    expect(advanced.providerVersion).toBe('v2');
    expect(advanced.canonicalVersion).toBe(3);
    expect(advanced.mappedAt).toBe(NOW_1);
    expect(advanced.lastSyncedAt).toBe(NOW_2);

    const resolved = await store.findByCoordinate(TENANT_A, COORD_C1);
    expect(resolved?.canonical.entityId).toBe(first.canonical.entityId);
    // Exactly one mapping exists — no duplicates from the re-sync.
    expect(await store.listByCanonical(TENANT_A, canonical(7))).toHaveLength(1);
  });

  it('re-resolves the same mapping inputs to the same stored record', async () => {
    const store = createInMemorySourceMappingStore();
    const first = unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(7),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    const replay = unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(7),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    expect(replay).toStrictEqual(first);
  });
});

describe('mapping collisions are explicit, never silent overwrites', () => {
  it('typed-rejects re-pointing a coordinate at a different canonical id (forward)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    const rePointed = await recordSourceMapping({
      store,
      tenantId: TENANT_A,
      coordinate: COORD_C1,
      canonical: canonical(2),
      providerVersion: providerVersion('v2'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW_2,
    });
    expect(rePointed.ok).toBe(false);
    if (!rePointed.ok) {
      expect(rePointed.error.code).toBe('invariant-violation');
      expect(rePointed.error.details[0]?.code).toBe('source-mapping-collision');
    }
    // The original binding is intact — no silent overwrite.
    const stored = await store.findByCoordinate(TENANT_A, COORD_C1);
    expect(stored?.canonical.entityId).toBe(canonical(1).entityId);
    expect(stored?.providerVersion).toBe('v1');
  });

  it('typed-rejects a second provider object claiming a bound canonical id (reverse)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    const second = await recordSourceMapping({
      store,
      tenantId: TENANT_A,
      coordinate: COORD_C2,
      canonical: canonical(1),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW_2,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invariant-violation');
      expect(second.error.details[0]?.code).toBe('canonical-binding-collision');
    }
    // The second coordinate was never recorded.
    expect(await store.findByCoordinate(TENANT_A, COORD_C2)).toBeNull();
    // And the first binding is intact.
    expect(await store.listByCanonical(TENANT_A, canonical(1))).toHaveLength(1);
  });

  it('still binds the same provider object id across a DIFFERENT provider system', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    // The reverse invariant is scoped to (tenant, adapter, system, object
    // type): a second connected provider system may feed the same canonical
    // entity — that is federation, not a collision.
    const federated = await recordSourceMapping({
      store,
      tenantId: TENANT_A,
      coordinate: COORD_C1_OTHER_SYSTEM,
      canonical: canonical(1),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW_3,
    });
    expect(federated.ok).toBe(true);
    expect(await store.listByCanonical(TENANT_A, canonical(1))).toHaveLength(2);
  });

  it('scopes collisions per tenant (the same ids may bind independently in two tenants)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: COORD_C1,
        canonical: canonical(1),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW_1,
      }),
    );
    // Tenant B is an independent scope: the same coordinate and canonical id
    // bind without interference from tenant A's records.
    const other = await recordSourceMapping({
      store,
      tenantId: TENANT_B,
      coordinate: COORD_C1,
      canonical: canonical(1),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW_2,
    });
    expect(other.ok).toBe(true);
  });
});
