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
  createInMemoryConflictStore,
  createInMemorySourceMappingStore,
  detectedConflict,
  providerObjectId,
  providerVersion,
  recordSourceMapping,
  sourceCoordinate,
  sourceRef,
} from '@office/adapters-sdk';
import {
  ACTIVITY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
} from './vocabulary';
import {
  classifyScheduleConflict,
  detectDependencyCycle,
  detectScheduleDivergences,
  parseDependencyCycle,
  parseScheduleConflictKind,
} from './conflict-rules';
import type {
  DetectedScheduleDivergence,
  ScheduleDivergenceView,
} from './conflict-rules';
import {
  ENVELOPE_ACTIVITY_ID,
  FOUNDATIONS_ACTIVITY_ID,
  FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
  SEPTEMBER_BASELINE_ID,
  STRUCTURE_ACTIVITY_ID,
  STRUCTURE_ENVELOPE_DEPENDENCY_ID,
  TOWER_SCHEDULE_ID,
  createSeededScheduleProvider,
} from './provider-fixture';

// OFF-023 adapter-schedule — THE typed conflict rules (the named focus):
// the pure dependency-cycle detection, the typed classification of Conflict
// records by rule kind, and the pre-flight divergence pass that composes
// explicit Conflict records carrying BOTH sides. Detection never resolves;
// re-detection is idempotent (ids derive from both sides).

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-11-10T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-11-14T08:15:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `sch${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));

const actor = { kind: 'adapter', actorId: entity(90) } as const;

const SCHEDULE_REF = ref('schedule', entity(1));
const STRUCTURE_REF = ref('activity', entity(3));
const BASELINE_REF = ref('baseline', entity(7));

const edge = (predecessorId: string, successorId: string) => ({ predecessorId, successorId });

describe('detectDependencyCycle (pure, deterministic DFS)', () => {
  it('returns null for acyclic networks and forward extensions', () => {
    const network = [edge('act-401', 'act-402'), edge('act-402', 'act-403')];
    expect(detectDependencyCycle(network, edge('act-403', 'act-404'))).toBeNull();
    expect(detectDependencyCycle(network, edge('act-401', 'act-404'))).toBeNull();
    expect(detectDependencyCycle([], edge('act-401', 'act-402'))).toBeNull();
  });

  it('detects the closing edge of a cycle with the full path', () => {
    const network = [edge('act-401', 'act-402'), edge('act-402', 'act-403')];
    const cycle = detectDependencyCycle(network, edge('act-403', 'act-401'));
    expect(cycle).not.toBeNull();
    expect(cycle?.kind).toBe('dependency-cycle');
    expect(cycle?.introducedBy).toStrictEqual({ predecessorId: 'act-403', successorId: 'act-401' });
    expect(cycle?.path).toStrictEqual(['act-403', 'act-401', 'act-402', 'act-403']);
  });

  it('detects two-node cycles and self-loops', () => {
    const twoNode = detectDependencyCycle([edge('act-401', 'act-402')], edge('act-402', 'act-401'));
    expect(twoNode?.path).toStrictEqual(['act-402', 'act-401', 'act-402']);
    const selfLoop = detectDependencyCycle([], edge('act-401', 'act-401'));
    expect(selfLoop?.path).toStrictEqual(['act-401', 'act-401']);
  });

  it('does not flag edges that merely touch a cyclic network elsewhere', () => {
    // A cycle exists WITHOUT the candidate; adding an unrelated edge does
    // not make the candidate an introducer of it.
    const cyclic = [edge('act-401', 'act-402'), edge('act-402', 'act-401')];
    expect(detectDependencyCycle(cyclic, edge('act-401', 'act-403'))).toBeNull();
  });

  it('round-trips the cycle through its fail-closed parse', () => {
    const cycle = detectDependencyCycle(
      [edge('act-401', 'act-402'), edge('act-402', 'act-403')],
      edge('act-403', 'act-401'),
    );
    if (cycle === null) throw new Error('expected a cycle');
    expect(unwrap(parseDependencyCycle(cycle))).toStrictEqual(cycle);
    expect(parseDependencyCycle({ kind: 'dependency-cycle' }).ok).toBe(false);
    expect(parseDependencyCycle(null).ok).toBe(false);
    expect(parseDependencyCycle({ kind: 'other', introducedBy: { predecessorId: 'a', successorId: 'b' }, path: ['a', 'b'] }).ok).toBe(false);
    expect(parseDependencyCycle({ kind: 'dependency-cycle', introducedBy: { predecessorId: 'a', successorId: 'b' }, path: ['a'] }).ok).toBe(false);
  });
});

describe('classifyScheduleConflict (typed rule kinds, total over the family)', () => {
  const base = {
    tenantId: TENANT_A,
    canonicalVersion: version(2),
    detectedAt: NOW_1,
    detectedBy: actor,
  } as const;

  it('classifies by the source side’s object family', () => {
    const activityConflict = detectedConflict({
      ...base,
      source: sourceRef({
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        objectType: ACTIVITY_OBJECT_KIND,
        objectId: providerObjectId(STRUCTURE_ACTIVITY_ID),
        version: providerVersion('v2'),
      }),
      canonical: STRUCTURE_REF,
    });
    expect(unwrap(classifyScheduleConflict(activityConflict))).toBe('concurrent-activity-change');

    const baselineConflict = detectedConflict({
      ...base,
      source: sourceRef({
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        objectType: BASELINE_OBJECT_KIND,
        objectId: providerObjectId(SEPTEMBER_BASELINE_ID),
        version: providerVersion('v2'),
      }),
      canonical: BASELINE_REF,
    });
    expect(unwrap(classifyScheduleConflict(baselineConflict))).toBe('baseline-rebaselining');
  });

  it('fails closed for conflicts recorded outside the schedule object family', () => {
    const foreign = detectedConflict({
      ...base,
      source: sourceRef({
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        objectType: 'model' as never,
        objectId: providerObjectId('m-1'),
        version: providerVersion('v1'),
      }),
      canonical: ref('model', entity(9)),
    });
    const result = classifyScheduleConflict(foreign);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-conflict-kind-unknown');
    }
  });

  it('parses the closed rule-kind vocabulary fail-closed', () => {
    for (const kind of [
      'concurrent-activity-change',
      'dependency-cycle-introduction',
      'baseline-rebaselining',
      'concurrent-schedule-change',
    ] as const) {
      expect(unwrap(parseScheduleConflictKind(kind))).toBe(kind);
    }
    expect(parseScheduleConflictKind('last-write-wins').ok).toBe(false);
    expect(parseScheduleConflictKind(null).ok).toBe(false);
  });
});

describe('detectScheduleDivergences (the pre-flight pass over the provider view)', () => {
  /** Establish the seeded world's mappings (schedule + dependencies + baseline). */
  const establishedMappings = async () => {
    const mappings = createInMemorySourceMappingStore();
    const base = {
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor,
      now: NOW_1,
    } as const;
    unwrap(
      await recordSourceMapping({
        store: mappings,
        tenantId: TENANT_A,
        coordinate: sourceCoordinate({
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: 'project-schedule' as never,
          objectId: providerObjectId(TOWER_SCHEDULE_ID),
        }),
        canonical: SCHEDULE_REF,
        ...base,
      }),
    );
    for (const [n, dependencyId] of [
      [5, FOUNDATIONS_STRUCTURE_DEPENDENCY_ID],
      [6, STRUCTURE_ENVELOPE_DEPENDENCY_ID],
    ] as const) {
      unwrap(
        await recordSourceMapping({
          store: mappings,
          tenantId: TENANT_A,
          coordinate: sourceCoordinate({
            adapterKind: SCHEDULE_ADAPTER_KIND,
            systemId: SCHEDULE_SYSTEM_ID,
            objectType: 'activity-dependency' as never,
            objectId: providerObjectId(dependencyId),
          }),
          canonical: ref('dependency', entity(n)),
          ...base,
        }),
      );
    }
    unwrap(
      await recordSourceMapping({
        store: mappings,
        tenantId: TENANT_A,
        coordinate: sourceCoordinate({
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: 'baseline' as never,
          objectId: providerObjectId(SEPTEMBER_BASELINE_ID),
        }),
        canonical: BASELINE_REF,
        ...base,
      }),
    );
    return mappings;
  };

  const canonicalVersionOf = async (
    tenantId: TenantId,
    canonical: EntityRef,
  ): Promise<{ ok: true; value: AggregateVersion | null } | { ok: false; error: never }> => {
    if (tenantId !== TENANT_A) return { ok: true, value: null };
    if (canonical.entityId === entity(1)) return { ok: true, value: version(1) };
    if (canonical.entityId === entity(7)) return { ok: true, value: version(1) };
    return { ok: true, value: null };
  };

  it('returns no divergence over the clean seeded world', async () => {
    const provider = createSeededScheduleProvider();
    const divergences = unwrap(
      await detectScheduleDivergences({
        tenantId: TENANT_A,
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        view: provider.divergenceView,
        mappings: await establishedMappings(),
        canonicalVersionOf,
        actor,
        now: NOW_1,
      }),
    );
    expect(divergences).toStrictEqual([]);
  });

  it('detects a dependency-cycle introduction with both sides against the schedule aggregate', async () => {
    const provider = createSeededScheduleProvider();
    // The provider introduces a BACKWARD link: envelope → foundations closes
    // the foundations → structure → envelope cycle.
    provider.introduceDependency({
      objectId: 'dep-403-401',
      predecessorId: ENVELOPE_ACTIVITY_ID,
      successorId: FOUNDATIONS_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 0,
    });
    const divergences = unwrap(
      await detectScheduleDivergences({
        tenantId: TENANT_A,
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        view: provider.divergenceView,
        mappings: await establishedMappings(),
        canonicalVersionOf,
        actor,
        now: NOW_1,
      }),
    );
    expect(divergences).toHaveLength(1);
    const divergence: DetectedScheduleDivergence | undefined = divergences[0];
    expect(divergence?.rule).toBe('dependency-cycle-introduction');
    expect(divergence?.quarantinedObjectKind).toBe('activity-dependency');
    expect(divergence?.quarantinedObjectId).toBe('dep-403-401');
    // BOTH SIDES: the provider's exact object version vs the canonical
    // schedule aggregate + its version.
    expect(divergence?.conflict).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'schedule-pm',
        systemId: 'schedule-instance-01',
        objectType: 'activity-dependency',
        objectId: 'dep-403-401',
        version: 'v1',
      },
      canonical: { entityKind: 'schedule', entityId: entity(1) },
      canonicalVersion: 1,
      state: 'detected',
      resolution: null,
    });
    expect(divergence?.cycle?.path).toContain(ENVELOPE_ACTIVITY_ID);
    expect(divergence?.cycle?.path).toContain(FOUNDATIONS_ACTIVITY_ID);
    // No auto-resolution: the record lands detected and stays there.
    expect(divergence?.conflict.detectedBy).toStrictEqual(actor);
    expect(divergence?.conflict.detectedAt).toBe(NOW_1);
  });

  it('detects an in-place re-baselining attempt against the protected baseline', async () => {
    const provider = createSeededScheduleProvider();
    provider.attemptRebaseline(SEPTEMBER_BASELINE_ID, { label: 'baseline-2026-09-01-revised' });
    const divergences = unwrap(
      await detectScheduleDivergences({
        tenantId: TENANT_A,
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        view: provider.divergenceView,
        mappings: await establishedMappings(),
        canonicalVersionOf,
        actor,
        now: NOW_2,
      }),
    );
    expect(divergences).toHaveLength(1);
    const divergence: DetectedScheduleDivergence | undefined = divergences[0];
    expect(divergence?.rule).toBe('baseline-rebaselining');
    expect(divergence?.quarantinedObjectKind).toBe('baseline');
    expect(divergence?.quarantinedObjectId).toBe(SEPTEMBER_BASELINE_ID);
    // BOTH SIDES: the mutated provider object (v2) vs the immutable
    // canonical baseline record at its current version.
    expect(divergence?.conflict).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'schedule-pm',
        systemId: 'schedule-instance-01',
        objectType: 'baseline',
        objectId: SEPTEMBER_BASELINE_ID,
        version: 'v2',
      },
      canonical: { entityKind: 'baseline', entityId: entity(7) },
      canonicalVersion: 1,
      state: 'detected',
      resolution: null,
    });
  });

  it('does NOT flag a properly registered new baseline (a new record, not a divergence)', async () => {
    const provider = createSeededScheduleProvider();
    provider.registerBaseline({
      objectId: 'bl-2026-10',
      label: 'baseline-2026-10-01',
      supersedes: SEPTEMBER_BASELINE_ID,
    });
    const divergences = unwrap(
      await detectScheduleDivergences({
        tenantId: TENANT_A,
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        view: provider.divergenceView,
        mappings: await establishedMappings(),
        canonicalVersionOf,
        actor,
        now: NOW_2,
      }),
    );
    expect(divergences).toStrictEqual([]);
  });

  it('re-detection is idempotent in the conflict store (same sides → same id)', async () => {
    const provider = createSeededScheduleProvider();
    provider.attemptRebaseline(SEPTEMBER_BASELINE_ID, { label: 'baseline-2026-09-01-revised' });
    const view: ScheduleDivergenceView = provider.divergenceView;
    const mappings = await establishedMappings();
    const store = createInMemoryConflictStore();
    const detect = () =>
      detectScheduleDivergences({
        tenantId: TENANT_A,
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        view,
        mappings,
        canonicalVersionOf,
        actor,
        now: NOW_2,
      });
    const first = unwrap(await detect());
    const appendedFirst = unwrap(await store.append(first[0]?.conflict ?? fail()));
    // A later run (even at a different injected instant) re-detects the SAME
    // divergence: the id is derived from both sides, so the append is a
    // no-op returning the existing record.
    const second = unwrap(await detect());
    const appendedSecond = unwrap(await store.append(second[0]?.conflict ?? fail()));
    expect(appendedSecond.conflictId).toBe(appendedFirst.conflictId);
    const listed = await store.listBySource(TENANT_A, {
      adapterKind: SCHEDULE_ADAPTER_KIND,
      systemId: SCHEDULE_SYSTEM_ID,
      objectType: 'baseline' as never,
      objectId: providerObjectId(SEPTEMBER_BASELINE_ID),
    });
    expect(listed).toHaveLength(1);
  });

  it('fails closed when the owning schedule is unmapped (sync the schedule first)', async () => {
    const provider = createSeededScheduleProvider();
    provider.introduceDependency({
      objectId: 'dep-403-401',
      predecessorId: ENVELOPE_ACTIVITY_ID,
      successorId: FOUNDATIONS_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 0,
    });
    const result = await detectScheduleDivergences({
      tenantId: TENANT_A,
      adapterKind: SCHEDULE_ADAPTER_KIND,
      systemId: SCHEDULE_SYSTEM_ID,
      view: provider.divergenceView,
      mappings: createInMemorySourceMappingStore(),
      canonicalVersionOf,
      actor,
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('schedule-parent-unmapped');
    }
  });
});

/** Local: a loud failure value for test wiring (never a silent undefined). */
function fail(): never {
  throw new Error('expected the divergence conflict');
}
