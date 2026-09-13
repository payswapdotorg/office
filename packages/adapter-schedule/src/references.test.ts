import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseEntityRef,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import {
  createInMemorySourceMappingStore,
  providerObjectId,
  providerVersion,
  recordSourceMapping,
  sourceCoordinate,
} from '@office/adapters-sdk';
import {
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
} from './vocabulary';
import {
  assertScheduleObjectMapping,
  compareEntityRef,
  recordScheduleObjectMapping,
  resolveDependencyEndpoints,
  resolveOwningSchedule,
  resolveScheduleObject,
  scheduleProviderCoordinateOf,
} from './references';
import type { ScheduleObjectParents } from './references';

// OFF-023 adapter-schedule — THE schedule reference contracts: the A10
// mapping discipline (provider ids never primary keys; the binding is the
// tenant-scoped record), the kind discipline (canonical kind must equal the
// declared one for the object kind), and the schedule hierarchy discipline
// (activities/dependencies/baselines over their schedule; dependencies over
// BOTH endpoint activities). Deterministic: injected ids/clock, fixed state.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160504f3e2d1c0b'));
const NOW: Timestamp = unwrap(parseTimestamp('2026-10-06T09:00:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `sch${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));

const actor = { kind: 'adapter', actorId: entity(90) } as const;

const coordinate = (objectType: string, objectId: string) =>
  sourceCoordinate({
    adapterKind: SCHEDULE_ADAPTER_KIND,
    systemId: SCHEDULE_SYSTEM_ID,
    objectType: objectType as never,
    objectId: providerObjectId(objectId),
  });

const noParents = (): ScheduleObjectParents => ({
  schedule: null,
  predecessorActivity: null,
  successorActivity: null,
});

const scheduleParents = (schedule: string): ScheduleObjectParents => ({
  schedule,
  predecessorActivity: null,
  successorActivity: null,
});

describe('the kind discipline (canonical kind must equal the declared one)', () => {
  it('accepts a mapping whose canonical kind is the declared one', async () => {
    const mapping = unwrap(
      await recordSourceMapping({
        store: createInMemorySourceMappingStore(),
        tenantId: TENANT_A,
        coordinate: coordinate('activity', 'act-401'),
        canonical: ref('activity', entity(2)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor,
        now: NOW,
      }),
    );
    expect(assertScheduleObjectMapping(mapping).ok).toBe(true);
  });

  it('rejects an out-of-family coordinate and a kind-mismatched binding (typed)', async () => {
    const store = createInMemorySourceMappingStore();
    const foreign = unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('model', 'm-tower-a'),
        canonical: ref('model', entity(1)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor,
        now: NOW,
      }),
    );
    const foreignTyped = assertScheduleObjectMapping(foreign);
    expect(foreignTyped.ok).toBe(false);
    if (!foreignTyped.ok) {
      expect(foreignTyped.error.details[0]?.code).toBe('schedule-object-kind-unknown');
    }

    const mismatched = unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('activity', 'act-402'),
        canonical: ref('baseline', entity(3)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor,
        now: NOW,
      }),
    );
    const mismatchedTyped = assertScheduleObjectMapping(mismatched);
    expect(mismatchedTyped.ok).toBe(false);
    if (!mismatchedTyped.ok) {
      expect(mismatchedTyped.error.details[0]?.code).toBe('schedule-mapping-kind-mismatch');
      expect(mismatchedTyped.error.message).toContain('activity');
    }
  });

  it('rejects a kind-mismatched binding at record time too (never silently used)', async () => {
    const store = createInMemorySourceMappingStore();
    const result = await recordScheduleObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('baseline', 'bl-2026-09'),
      canonical: ref('activity', entity(4)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW,
      parents: scheduleParents('sch-tower-a'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-mapping-kind-mismatch');
    }
  });
});

describe('the schedule hierarchy discipline (parents before children)', () => {
  it('records the schedule root, then children over it, then dependencies over both activities', async () => {
    const store = createInMemorySourceMappingStore();
    const base = {
      store,
      tenantId: TENANT_A,
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW,
    } as const;
    unwrap(
      await recordScheduleObjectMapping({
        ...base,
        coordinate: coordinate('project-schedule', 'sch-tower-a'),
        canonical: ref('schedule', entity(1)),
        parents: noParents(),
      }),
    );
    unwrap(
      await recordScheduleObjectMapping({
        ...base,
        coordinate: coordinate('activity', 'act-401'),
        canonical: ref('activity', entity(2)),
        parents: scheduleParents('sch-tower-a'),
      }),
    );
    unwrap(
      await recordScheduleObjectMapping({
        ...base,
        coordinate: coordinate('activity', 'act-402'),
        canonical: ref('activity', entity(3)),
        parents: scheduleParents('sch-tower-a'),
      }),
    );
    unwrap(
      await recordScheduleObjectMapping({
        ...base,
        coordinate: coordinate('activity-dependency', 'dep-401-402'),
        canonical: ref('dependency', entity(4)),
        parents: {
          schedule: 'sch-tower-a',
          predecessorActivity: 'act-401',
          successorActivity: 'act-402',
        },
      }),
    );
    const dependency = await resolveScheduleObject(
      store,
      TENANT_A,
      coordinate('activity-dependency', 'dep-401-402'),
    );
    expect(dependency).toStrictEqual(ref('dependency', entity(4)));
  });

  it('fails closed when the owning schedule is unmapped (typed not-found)', async () => {
    const store = createInMemorySourceMappingStore();
    const result = await recordScheduleObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('activity', 'act-401'),
      canonical: ref('activity', entity(2)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW,
      parents: scheduleParents('sch-unmapped'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('schedule-parent-unmapped');
      expect(result.error.message).toContain('project-schedule');
    }
  });

  it('requires the schedule parent id for non-root kinds (typed invariant)', async () => {
    const store = createInMemorySourceMappingStore();
    const result = await recordScheduleObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('baseline', 'bl-2026-09'),
      canonical: ref('baseline', entity(7)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW,
      parents: noParents(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-parent-required');
    }
  });

  it('fails closed when either endpoint activity of a dependency is unmapped', async () => {
    const store = createInMemorySourceMappingStore();
    const base = {
      store,
      tenantId: TENANT_A,
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW,
    } as const;
    unwrap(
      await recordScheduleObjectMapping({
        ...base,
        coordinate: coordinate('project-schedule', 'sch-tower-a'),
        canonical: ref('schedule', entity(1)),
        parents: noParents(),
      }),
    );
    unwrap(
      await recordScheduleObjectMapping({
        ...base,
        coordinate: coordinate('activity', 'act-401'),
        canonical: ref('activity', entity(2)),
        parents: scheduleParents('sch-tower-a'),
      }),
    );
    // The SUCCESSOR activity is missing: the dependency must not dangle.
    const result = await recordScheduleObjectMapping({
      ...base,
      coordinate: coordinate('activity-dependency', 'dep-401-402'),
      canonical: ref('dependency', entity(4)),
      parents: {
        schedule: 'sch-tower-a',
        predecessorActivity: 'act-401',
        successorActivity: 'act-402',
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      // The missing SUCCESSOR endpoint is named by its role and its id.
      expect(result.error.message).toContain('successorActivity');
      expect(result.error.message).toContain('act-402');
    }
    // Missing endpoint ids entirely: typed invariant, not a guess.
    const malformed = await recordScheduleObjectMapping({
      ...base,
      coordinate: coordinate('activity-dependency', 'dep-402-403'),
      canonical: ref('dependency', entity(5)),
      parents: {
        schedule: 'sch-tower-a',
        predecessorActivity: null,
        successorActivity: null,
      },
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.details[0]?.code).toBe('schedule-parent-required');
    }
  });

  it('propagates the SDK store’s typed remapping collision (no last-write-wins)', async () => {
    const store = createInMemorySourceMappingStore();
    const base = {
      store,
      tenantId: TENANT_A,
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW,
    } as const;
    unwrap(
      await recordScheduleObjectMapping({
        ...base,
        coordinate: coordinate('project-schedule', 'sch-tower-a'),
        canonical: ref('schedule', entity(1)),
        parents: noParents(),
      }),
    );
    // Re-pointing the SAME coordinate at a DIFFERENT canonical id: the SDK
    // store's typed collision (explicit conflict, never an overwrite).
    const remapped = await recordScheduleObjectMapping({
      ...base,
      coordinate: coordinate('project-schedule', 'sch-tower-a'),
      canonical: ref('schedule', entity(9)),
      parents: noParents(),
    });
    expect(remapped.ok).toBe(false);
  });
});

describe('tenant scoping (A12: foreign tenants are invisible)', () => {
  it('resolves within the owning tenant only and hides foreign mappings', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('activity', 'act-401'),
        canonical: ref('activity', entity(2)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor,
        now: NOW,
      }),
    );
    expect(await resolveScheduleObject(store, TENANT_A, coordinate('activity', 'act-401'))).toStrictEqual(
      ref('activity', entity(2)),
    );
    // The same coordinate under a foreign tenant is indistinguishable from
    // absence — no existence oracle across tenants.
    expect(await resolveScheduleObject(store, TENANT_B, coordinate('activity', 'act-401'))).toBeNull();
  });

  it('resolves the owning schedule and dependency endpoints within the tenant', async () => {
    const store = createInMemorySourceMappingStore();
    const base = {
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW,
    } as const;
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('project-schedule', 'sch-tower-a'),
        canonical: ref('schedule', entity(1)),
        ...base,
      }),
    );
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('activity', 'act-401'),
        canonical: ref('activity', entity(2)),
        ...base,
      }),
    );
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('activity', 'act-402'),
        canonical: ref('activity', entity(3)),
        ...base,
      }),
    );

    const schedule = unwrap(
      await resolveOwningSchedule(store, TENANT_A, {
        referencing: coordinate('activity', 'act-402'),
        scheduleProviderObjectId: 'sch-tower-a',
      }),
    );
    expect(schedule).toStrictEqual(ref('schedule', entity(1)));

    const endpoints = unwrap(
      await resolveDependencyEndpoints(store, TENANT_A, {
        dependency: coordinate('activity-dependency', 'dep-401-402'),
        predecessorProviderObjectId: 'act-401',
        successorProviderObjectId: 'act-402',
      }),
    );
    expect(endpoints).toStrictEqual({
      predecessor: ref('activity', entity(2)),
      successor: ref('activity', entity(3)),
    });

    // Fail-closed: an unmapped schedule reference is a typed not-found.
    const unmapped = await resolveOwningSchedule(store, TENANT_A, {
      referencing: coordinate('activity', 'act-402'),
      scheduleProviderObjectId: 'sch-other',
    });
    expect(unmapped.ok).toBe(false);
    if (!unmapped.ok) {
      expect(unmapped.error.details[0]?.code).toBe('schedule-parent-unmapped');
    }
  });

  it('reverse-resolves the schedule provider coordinate of a canonical entity', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('project-schedule', 'sch-tower-a'),
        canonical: ref('schedule', entity(1)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor,
        now: NOW,
      }),
    );
    const coordinateOf = await scheduleProviderCoordinateOf(store, TENANT_A, ref('schedule', entity(1)));
    expect(coordinateOf?.objectId).toBe('sch-tower-a');
    expect(coordinateOf?.objectType).toBe('project-schedule');
    expect(await scheduleProviderCoordinateOf(store, TENANT_B, ref('schedule', entity(1)))).toBeNull();
  });
});

describe('the canonical entity-reference order', () => {
  it('orders by entity kind, then id', () => {
    expect(compareEntityRef(ref('activity', entity(2)), ref('baseline', entity(1)))).toBe(-1);
    expect(compareEntityRef(ref('baseline', entity(1)), ref('activity', entity(2)))).toBe(1);
    expect(compareEntityRef(ref('activity', entity(2)), ref('activity', entity(3)))).toBe(-1);
    expect(compareEntityRef(ref('activity', entity(2)), ref('activity', entity(2)))).toBe(0);
  });
});
