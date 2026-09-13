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
  adapterAuthorizationContext,
  applyWebhook,
  createFakeWebhookVerifier,
  createInMemoryConflictStore,
  createInMemorySourceMappingStore,
  createInMemorySyncCursorStore,
  providerObjectId,
  providerSystemId,
  runSync,
  sourceCoordinate,
  syncStream,
} from '@office/adapters-sdk';
import type { AdapterAuthorization, SyncEngineDeps } from '@office/adapters-sdk';
import {
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
} from './vocabulary';
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
import type { SeededScheduleProvider } from './provider-fixture';
import { runScheduleSync } from './sync';

// OFF-023 adapter-schedule — the multi-stream sync driver over the SDK engine:
// schedule hierarchy stream order (parents map before children), replay-safe
// paging (positional cursors, idempotent re-runs), THE typed conflict rules
// layered in (the engine's concurrent-activity-change divergences AND the
// pre-flight quarantine of dependency-cycle introductions and in-place
// re-baselining attempts — explicit Conflict records with both sides, never
// auto-resolved), and webhook ingest per the SDK discipline. Deterministic:
// fixed clock, sequential office-issued ids, fixed fixture state.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-11-10T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-11-12T10:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-11-13T11:00:00.000Z'));
const NOW_4: Timestamp = unwrap(parseTimestamp('2026-11-14T12:00:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `sch${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));

const AUTHORIZATION: AdapterAuthorization = {
  context: adapterAuthorizationContext({
    actorId: entity(90),
    scope: { kind: 'tenant', tenantId: TENANT_A },
    capabilities: ['schedule.write'],
  }),
  policy: { rules: [{ effect: 'allow', actorKinds: ['adapter'] }] },
};

const coordinate = (objectType: string, objectId: string) =>
  sourceCoordinate({
    adapterKind: SCHEDULE_ADAPTER_KIND,
    systemId: SCHEDULE_SYSTEM_ID,
    objectType: objectType as never,
    objectId: providerObjectId(objectId),
  });

/** Deterministic engine state: fixed clock, sequential office-issued ids. */
const engine = (now: () => Timestamp) => {
  let nextId = 1;
  const versions = new Map<string, AggregateVersion | null>();
  const deps: SyncEngineDeps = {
    mappings: createInMemorySourceMappingStore(),
    cursors: createInMemorySyncCursorStore(),
    conflicts: createInMemoryConflictStore(),
    canonicalVersionOf: async (tenantId, canonical) => {
      if (tenantId !== TENANT_A) return { ok: true as const, value: null };
      return { ok: true as const, value: versions.get(canonical.entityId) ?? null };
    },
    now,
    nextCanonicalId: () => entity(nextId++),
  };
  return { deps, versions };
};

/** One runScheduleSync pass over the provider's CURRENT state. */
const syncOnce = (provider: SeededScheduleProvider, deps: SyncEngineDeps) =>
  runScheduleSync(
    {
      authorization: AUTHORIZATION,
      adapter: provider.adapter,
      translator: provider.translator,
      systemId: SCHEDULE_SYSTEM_ID,
      limit: 10,
      divergenceView: provider.divergenceView,
    },
    deps,
  );

/** Establish the whole seeded world: sync every stream, execute the creates. */
const establishedWorld = async (now: () => Timestamp) => {
  const provider = createSeededScheduleProvider();
  const world = engine(now);
  const first = unwrap(await syncOnce(provider, world.deps));
  // The host executed every create command: all seven aggregates exist at v1.
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    world.versions.set(entity(n), version(1));
  }
  return { provider, ...world, first };
};

describe('runScheduleSync — the multi-stream hierarchy driver', () => {
  it('syncs the four streams in schedule hierarchy order, parents before children', async () => {
    const { deps, first } = await establishedWorld(() => NOW_1);
    expect(first.streams.map((stream) => stream.objectKind)).toStrictEqual([
      'project-schedule',
      'activity',
      'activity-dependency',
      'baseline',
    ]);
    // Every application mapped a new object (nothing replayed on a fresh world).
    expect(first.streams.map((stream) => stream.applications.length)).toStrictEqual([1, 3, 2, 1]);
    for (const stream of first.streams) {
      for (const application of stream.applications) {
        expect(application.outcome).toBe('mapped-created');
        expect(application.command).not.toBeNull();
      }
    }
    // Commands were proposed in stream + provider order.
    expect(first.commands.map((command) => command.commandName)).toStrictEqual([
      'schedule.createSchedule',
      'schedule.addActivity',
      'schedule.addActivity',
      'schedule.addActivity',
      'schedule.addDependency',
      'schedule.addDependency',
      'schedule.setBaseline',
    ]);
    // A10/A11: provider ids are never primary keys — every mapping binds an
    // office-issued canonical id, issued in deterministic sequence.
    const structure = await deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('activity', STRUCTURE_ACTIVITY_ID),
    );
    expect(structure?.canonical).toStrictEqual({ entityKind: 'activity', entityId: entity(3) });
    expect(structure?.providerVersion).toBe('v1');
    const schedule = await deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('project-schedule', TOWER_SCHEDULE_ID),
    );
    expect(schedule?.canonical).toStrictEqual({ entityKind: 'schedule', entityId: entity(1) });
    const baseline = await deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('baseline', SEPTEMBER_BASELINE_ID),
    );
    expect(baseline?.canonical).toStrictEqual({ entityKind: 'baseline', entityId: entity(7) });
    // No divergences over the clean seeded world: no conflicts, no rules.
    expect(first.conflicts).toStrictEqual([]);
    expect(first.conflictRules).toStrictEqual([]);
  });

  it('proposes the activity command with full typed CPM data + provenance', async () => {
    const { first } = await establishedWorld(() => NOW_1);
    const structureCommand = first.commands.find(
      (command) =>
        command.commandName === 'schedule.addActivity' &&
        command.payload['activityId'] === entity(3),
    );
    expect(structureCommand).toBeDefined();
    expect(structureCommand?.payload).toMatchObject({
      activityId: entity(3),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 35,
      parentActivityProviderId: FOUNDATIONS_ACTIVITY_ID,
      plannedStart: '2026-09-21',
      plannedFinish: '2026-11-04',
    });
    // The dependency proposal carries the typed CPM link data (FS + lag).
    const lagCommand = first.commands.find(
      (command) =>
        command.commandName === 'schedule.addDependency' &&
        command.payload['dependencyId'] === entity(6),
    );
    expect(lagCommand?.payload).toMatchObject({
      dependencyId: entity(6),
      predecessorProviderId: STRUCTURE_ACTIVITY_ID,
      successorProviderId: ENVELOPE_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 3,
    });
    // The command's idempotency key is the SourceRef-derived sync key: the
    // same provider object version never proposes twice.
    expect(structureCommand?.idempotencyKey).toMatch(/^office-sync-v1-[0-9a-z]{32,}$/u);
  });

  it('propagates engine failures typed (a foreign provider system stops the run)', async () => {
    const provider = createSeededScheduleProvider();
    const { deps } = engine(() => NOW_1);
    const result = await runScheduleSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: providerSystemId('schedule-instance-99'),
        limit: 10,
        divergenceView: provider.divergenceView,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('provider-system-mismatch');
    }
  });
});

describe('runScheduleSync — replay safety (A11: same SourceRef + version is a no-op)', () => {
  it('re-runs the whole sync without duplicate mappings or commands', async () => {
    const world = await establishedWorld(() => NOW_1);
    const second = unwrap(await syncOnce(world.provider, world.deps));
    // Everything already applied at the same provider versions: idempotent.
    for (const stream of second.streams) {
      for (const application of stream.applications) {
        expect(application.outcome).toBe('replay-no-op');
        expect(application.command).toBeNull();
      }
    }
    expect(second.commands).toStrictEqual([]);
    expect(second.conflicts).toStrictEqual([]);
    // Exactly one mapping per provider object — no duplicates anywhere.
    const structure = await world.deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('activity', STRUCTURE_ACTIVITY_ID),
    );
    expect(structure?.canonical.entityId).toBe(entity(3));
    const bound = await world.deps.mappings.listByCanonical(
      TENANT_A,
      ref('activity', entity(3)),
    );
    expect(bound).toHaveLength(1);
  });

  it('applies a provider activity update on the next run and then replays it (applied-update → canonical-ahead → no-op)', async () => {
    const world = await establishedWorld(() => NOW_1);
    // The provider mutates the structure activity's dates (bumps to v2).
    world.provider.updateActivity(STRUCTURE_ACTIVITY_ID, {
      displayName: 'Structure framing',
      data: {
        scheduleId: TOWER_SCHEDULE_ID,
        code: 'A4020',
        name: 'Structure framing',
        plannedDuration: 38,
        parentActivityId: FOUNDATIONS_ACTIVITY_ID,
        plannedStart: '2026-09-24',
        plannedFinish: '2026-11-09',
      },
    });
    const second = unwrap(await syncOnce(world.provider, world.deps));
    const structureApplication = second.streams
      .find((stream) => stream.objectKind === 'activity')
      ?.applications.find(
        (application) => application.snapshot.source.objectId === STRUCTURE_ACTIVITY_ID,
      );
    expect(structureApplication?.outcome).toBe('applied-update');
    expect(structureApplication?.command?.commandName).toBe('schedule.updateActivity');
    expect(structureApplication?.command?.payload['plannedStart']).toBe('2026-09-24');
    expect(structureApplication?.command?.payload['expectedVersion']).toBe(1);
    // Exactly one proposal: THE activity-date change (THE flow's trigger).
    expect(second.commands).toHaveLength(1);
    // The canonical aggregate executed the update: the next run sees the
    // canonical side ahead of the mapping bookkeeping (provider quiet), and
    // the run AFTER that is the pure replay no-op.
    world.versions.set(entity(3), version(2));
    const third = unwrap(await syncOnce(world.provider, world.deps));
    const structureThird = third.streams
      .find((stream) => stream.objectKind === 'activity')
      ?.applications.find(
        (application) => application.snapshot.source.objectId === STRUCTURE_ACTIVITY_ID,
      );
    expect(structureThird?.outcome).toBe('canonical-ahead');
    expect(structureThird?.command).toBeNull();
    const fourth = unwrap(await syncOnce(world.provider, world.deps));
    for (const stream of fourth.streams) {
      for (const application of stream.applications) {
        expect(application.outcome).toBe('replay-no-op');
      }
    }
  });
});

describe('runScheduleSync — THE typed conflict rules (never last-write-wins)', () => {
  it('rule 1: records the concurrent activity-date change conflict with both sides + typed classification', async () => {
    const world = await establishedWorld(() => NOW_1);
    // The provider mutates the structure activity's dates (v2)…
    world.provider.updateActivity(STRUCTURE_ACTIVITY_ID, {
      displayName: 'Structure framing',
      data: {
        scheduleId: TOWER_SCHEDULE_ID,
        code: 'A4020',
        name: 'Structure framing',
        plannedDuration: 40,
        parentActivityId: FOUNDATIONS_ACTIVITY_ID,
        plannedStart: '2026-09-28',
        plannedFinish: '2026-11-16',
      },
    });
    // …and an office-side edit lands in the same window (canonical at v2).
    world.versions.set(entity(3), version(2));
    const divergent = unwrap(await syncOnce(world.provider, world.deps));
    const structureApplication = divergent.streams
      .find((stream) => stream.objectKind === 'activity')
      ?.applications.find(
        (application) => application.snapshot.source.objectId === STRUCTURE_ACTIVITY_ID,
      );
    expect(structureApplication?.outcome).toBe('conflict-detected');
    expect(structureApplication?.command).toBeNull();
    expect(divergent.conflicts).toHaveLength(1);
    expect(divergent.conflicts[0]).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'schedule-pm',
        systemId: 'schedule-instance-01',
        objectType: 'activity',
        objectId: STRUCTURE_ACTIVITY_ID,
        version: 'v2',
      },
      canonical: { entityKind: 'activity', entityId: entity(3) },
      canonicalVersion: 2,
      state: 'detected',
      resolution: null,
    });
    // BOTH SIDES carried, typed rule classification, engine-detected (not
    // quarantined), and NO auto-resolution anywhere.
    expect(divergent.conflictRules).toStrictEqual([
      {
        conflictId: divergent.conflicts[0]?.conflictId,
        kind: 'concurrent-activity-change',
        quarantined: false,
      },
    ]);
    // Re-running the divergent sync re-detects the SAME conflict — an
    // idempotent append, no duplicate record, still no command.
    const reDetected = unwrap(await syncOnce(world.provider, world.deps));
    expect(reDetected.conflicts[0]).toStrictEqual(divergent.conflicts[0]);
    expect(reDetected.commands).toStrictEqual([]);
    const recorded = await world.deps.conflicts.listBySource(
      TENANT_A,
      coordinate('activity', STRUCTURE_ACTIVITY_ID),
    );
    expect(recorded).toHaveLength(1);
  });

  it('rule 2: quarantines a dependency-cycle introduction (typed conflict, no command, no mapping)', async () => {
    const world = await establishedWorld(() => NOW_1);
    // A NEW provider dependency link that would close the network cycle
    // foundations → structure → envelope → foundations.
    world.provider.introduceDependency({
      objectId: 'dep-403-401',
      predecessorId: ENVELOPE_ACTIVITY_ID,
      successorId: FOUNDATIONS_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 0,
    });
    const divergent = unwrap(await syncOnce(world.provider, world.deps));
    // The introducer is QUARANTINED: filtered from the activity-dependency
    // stream — no application, no mapping, and NO command ever proposed for
    // it (the canonical network stays acyclic).
    const dependencyApplications = divergent.streams
      .find((stream) => stream.objectKind === 'activity-dependency')
      ?.applications ?? [];
    expect(
      dependencyApplications.some(
        (application) => application.snapshot.source.objectId === 'dep-403-401',
      ),
    ).toBe(false);
    expect(divergent.commands).toStrictEqual([]);
    const introduced = await world.deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('activity-dependency', 'dep-403-401'),
    );
    expect(introduced).toBeNull();
    // The explicit Conflict record: BOTH sides — the introducer's full
    // SourceRef (with its version) against the OWNING SCHEDULE aggregate.
    expect(divergent.conflicts).toHaveLength(1);
    expect(divergent.conflicts[0]).toMatchObject({
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
    expect(divergent.conflictRules).toStrictEqual([
      {
        conflictId: divergent.conflicts[0]?.conflictId,
        kind: 'dependency-cycle-introduction',
        quarantined: true,
      },
    ]);
    // Re-detection is idempotent: the same conflict id, no duplicates.
    const reDetected = unwrap(await syncOnce(world.provider, world.deps));
    expect(reDetected.conflicts).toStrictEqual(divergent.conflicts);
    expect(reDetected.commands).toStrictEqual([]);
  });

  it('rule 3: quarantines an in-place re-baselining attempt against the protected baseline', async () => {
    const world = await establishedWorld(() => NOW_1);
    // The provider mutates the PROTECTED September baseline object IN PLACE
    // (bumps to v2) — the named re-baselining attempt.
    world.provider.attemptRebaseline(SEPTEMBER_BASELINE_ID, {
      label: 'baseline-2026-10-01',
    });
    const divergent = unwrap(await syncOnce(world.provider, world.deps));
    // The attempt is QUARANTINED: filtered from the baseline stream — no
    // application, no command, and the immutable baseline record is NEVER
    // mutated (its mapping still carries provider version v1).
    const baselineApplications =
      divergent.streams.find((stream) => stream.objectKind === 'baseline')?.applications ?? [];
    expect(baselineApplications).toStrictEqual([]);
    expect(divergent.commands).toStrictEqual([]);
    const baselineMapping = await world.deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('baseline', SEPTEMBER_BASELINE_ID),
    );
    expect(baselineMapping?.providerVersion).toBe('v1');
    expect(baselineMapping?.canonical).toStrictEqual({ entityKind: 'baseline', entityId: entity(7) });
    // The explicit Conflict record: BOTH sides — the attempt's full SourceRef
    // (with its version) against the immutable baseline's canonical record.
    expect(divergent.conflicts).toHaveLength(1);
    expect(divergent.conflicts[0]).toMatchObject({
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
    expect(divergent.conflictRules).toStrictEqual([
      {
        conflictId: divergent.conflicts[0]?.conflictId,
        kind: 'baseline-rebaselining',
        quarantined: true,
      },
    ]);
    // Re-detection is idempotent: the same conflict id, still no mutation.
    const reDetected = unwrap(await syncOnce(world.provider, world.deps));
    expect(reDetected.conflicts).toStrictEqual(divergent.conflicts);
    expect(reDetected.commands).toStrictEqual([]);
  });

  it('a re-baseline done properly is a NEW canonical baseline record, never a mutation', async () => {
    const world = await establishedWorld(() => NOW_1);
    // A NEW provider baseline object superseding the September one: the
    // immutable-baseline discipline's happy path.
    world.provider.registerBaseline({
      objectId: 'bl-2026-10',
      label: 'baseline-2026-10-01',
      supersedes: SEPTEMBER_BASELINE_ID,
      protected: false,
    });
    const outcome = unwrap(await syncOnce(world.provider, world.deps));
    // No divergence was detected: the new object is a new record.
    expect(outcome.conflicts).toStrictEqual([]);
    expect(outcome.conflictRules).toStrictEqual([]);
    // The new baseline mapped as a NEW canonical record (its own office id)…
    const newBaseline = await world.deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('baseline', 'bl-2026-10'),
    );
    expect(newBaseline?.canonical).toStrictEqual({ entityKind: 'baseline', entityId: entity(8) });
    // …and a setBaseline command was proposed for it, superseding the old one.
    expect(outcome.commands).toHaveLength(1);
    expect(outcome.commands[0]?.commandName).toBe('schedule.setBaseline');
    expect(outcome.commands[0]?.payload).toMatchObject({
      baselineId: entity(8),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      label: 'baseline-2026-10-01',
      supersedesProviderId: SEPTEMBER_BASELINE_ID,
    });
    // The September baseline record itself is untouched (still mapped, still
    // at its own provider version — never mutated).
    const september = await world.deps.mappings.findByCoordinate(
      TENANT_A,
      coordinate('baseline', SEPTEMBER_BASELINE_ID),
    );
    expect(september?.canonical.entityId).toBe(entity(7));
    expect(september?.providerVersion).toBe('v1');
  });
});

describe('cursor restart safety (positional cursors, per-stream)', () => {
  it('resumes an interrupted activity stream from the persisted cursor', async () => {
    const provider = createSeededScheduleProvider();
    const { deps, versions } = engine(() => NOW_1);
    const stream = await syncStream({
      tenantId: TENANT_A,
      adapterKind: SCHEDULE_ADAPTER_KIND,
      systemId: SCHEDULE_SYSTEM_ID,
      objectKind: ACTIVITY_OBJECT_KIND,
    });
    // Page 1: the first two activities map.
    const pageOne = unwrap(
      await runSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: SCHEDULE_SYSTEM_ID,
          objectKind: ACTIVITY_OBJECT_KIND,
          cursor: null,
          limit: 2,
        },
        deps,
      ),
    );
    expect(pageOne.applications).toHaveLength(2);
    expect(pageOne.applications[0]?.snapshot.source.objectId).toBe(FOUNDATIONS_ACTIVITY_ID);
    expect(pageOne.hasMore).toBe(true);
    const saved = await deps.cursors.load(stream);
    expect(saved?.token).toBe('2');

    // "Restart": a NEW engine call resumes from the persisted cursor.
    versions.set(entity(2), version(1));
    versions.set(entity(3), version(1));
    const pageTwo = unwrap(
      await runSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: SCHEDULE_SYSTEM_ID,
          objectKind: ACTIVITY_OBJECT_KIND,
          cursor: saved,
          limit: 2,
        },
        deps,
      ),
    );
    // Nothing checkpointed is re-delivered: only the envelope activity applies.
    expect(pageTwo.applications).toHaveLength(1);
    expect(pageTwo.applications[0]?.snapshot.source.objectId).toBe(ENVELOPE_ACTIVITY_ID);
    expect(pageTwo.hasMore).toBe(false);
    // No duplicate mappings for the checkpointed prefix.
    const bound = await deps.mappings.listByCanonical(TENANT_A, ref('activity', entity(2)));
    expect(bound).toHaveLength(1);
  });

  it('rejects resuming one stream with another stream cursor (typed)', async () => {
    const provider = createSeededScheduleProvider();
    const { deps } = engine(() => NOW_1);
    // Establish a persisted cursor on the ACTIVITY stream (two of three
    // objects paged, so a continuation token survives)…
    unwrap(
      await runSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: SCHEDULE_SYSTEM_ID,
          objectKind: ACTIVITY_OBJECT_KIND,
          cursor: null,
          limit: 2,
        },
        deps,
      ),
    );
    const activityStreamCursor = await deps.cursors.load(
      syncStream({
        tenantId: TENANT_A,
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: ACTIVITY_OBJECT_KIND,
      }),
    );
    expect(activityStreamCursor).not.toBeNull();
    // …and try to resume the ACTIVITY-DEPENDENCY stream with it: typed
    // rejection (the schedule hierarchy streams never share cursors).
    const result = await runSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: ACTIVITY_DEPENDENCY_OBJECT_KIND,
        cursor: activityStreamCursor,
        limit: 10,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('cursor-stream-mismatch');
    }
  });

  it('pages every stream to exhaustion at limit 1 (7 applications, 7 commands)', async () => {
    const provider = createSeededScheduleProvider();
    const { deps } = engine(() => NOW_1);
    const outcome = unwrap(
      await runScheduleSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: SCHEDULE_SYSTEM_ID,
          limit: 1,
          divergenceView: provider.divergenceView,
        },
        deps,
      ),
    );
    expect(outcome.streams.map((stream) => stream.applications.length)).toStrictEqual([1, 3, 2, 1]);
    expect(outcome.commands).toHaveLength(7);
    expect(outcome.streams.every((stream) => stream.hasMore === false)).toBe(true);
  });
});

describe('webhook ingest per the SDK discipline', () => {
  const world = async (): Promise<{
    readonly provider: SeededScheduleProvider;
    readonly deps: SyncEngineDeps;
    readonly versions: Map<string, AggregateVersion | null>;
  }> => {
    const established = await establishedWorld(() => NOW_1);
    return {
      provider: established.provider,
      deps: established.deps,
      versions: established.versions,
    };
  };

  it('applies an inbound activity update webhook and replays it idempotently', async () => {
    const { provider, deps } = await world();
    // The provider pushes an envelope activity update (bumps to v2).
    provider.updateActivity(ENVELOPE_ACTIVITY_ID, {
      displayName: 'Envelope',
      data: {
        scheduleId: TOWER_SCHEDULE_ID,
        code: 'A4030',
        name: 'Envelope',
        plannedDuration: 28,
        parentActivityId: STRUCTURE_ACTIVITY_ID,
        plannedStart: '2026-11-16',
        plannedFinish: '2026-12-21',
      },
    });
    const raw = provider.emitWebhook('updated', ENVELOPE_ACTIVITY_ID);
    const applied = unwrap(
      await applyWebhook({
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        verifier: createFakeWebhookVerifier(),
        deps: {
          mappings: deps.mappings,
          canonicalVersionOf: deps.canonicalVersionOf,
          now: () => NOW_2,
          nextCanonicalId: () => entity(99),
        },
        raw,
      }),
    );
    expect(applied.outcome).toBe('source-updated');
    expect(applied.command?.commandName).toBe('schedule.updateActivity');
    expect(applied.command?.payload).toMatchObject({
      activityId: entity(4),
      plannedDuration: 28,
      plannedStart: '2026-11-16',
      plannedFinish: '2026-12-21',
      expectedVersion: 1,
    });
    expect(applied.mapping?.canonical.entityId).toBe(entity(4));
    expect(applied.mapping?.providerVersion).toBe('v2');

    // The same raw event redelivered VERBATIM is a typed replay no-op.
    const replay = unwrap(
      await applyWebhook({
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        verifier: createFakeWebhookVerifier(),
        deps: {
          mappings: deps.mappings,
          canonicalVersionOf: deps.canonicalVersionOf,
          now: () => NOW_3,
          nextCanonicalId: () => entity(99),
        },
        raw,
      }),
    );
    expect(replay.outcome).toBe('replay-no-op');
    expect(replay.command).toBeNull();
  });

  it('rejects a webhook with a bad signature (typed unauthorized)', async () => {
    const { provider, deps } = await world();
    const raw = provider.emitWebhook('updated', STRUCTURE_ACTIVITY_ID);
    const result = await applyWebhook({
      authorization: AUTHORIZATION,
      adapter: provider.adapter,
      translator: provider.translator,
      verifier: createFakeWebhookVerifier(),
      deps: {
        mappings: deps.mappings,
        canonicalVersionOf: deps.canonicalVersionOf,
        now: () => NOW_4,
        nextCanonicalId: () => entity(99),
      },
      raw: { ...raw, headers: {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('webhook-signature-invalid');
    }
  });

  it('fails closed on an update for an unmapped source (run a targeted sync first)', async () => {
    const { provider, deps } = await world();
    const raw = provider.emitWebhook('updated', STRUCTURE_ACTIVITY_ID);
    const result = await applyWebhook({
      authorization: AUTHORIZATION,
      adapter: provider.adapter,
      translator: provider.translator,
      verifier: createFakeWebhookVerifier(),
      deps: {
        mappings: createInMemorySourceMappingStore(),
        canonicalVersionOf: deps.canonicalVersionOf,
        now: () => NOW_4,
        nextCanonicalId: () => entity(99),
      },
      raw,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('source-mapping-not-found');
    }
  });
});

describe('determinism of the sync driver (re-sync → the same canonical ids)', () => {
  it('produces identical outcomes — conflicts, rules, and commands — across two fully independent worlds', async () => {
    const run = async (): Promise<string> => {
      const world = await establishedWorld(() => NOW_1);
      // One composite divergence scenario: a concurrent activity-date change,
      // a dependency-cycle introduction, and an in-place re-baselining attempt.
      world.provider.updateActivity(STRUCTURE_ACTIVITY_ID, {
        displayName: 'Structure framing',
        data: {
          scheduleId: TOWER_SCHEDULE_ID,
          code: 'A4020',
          name: 'Structure framing',
          plannedDuration: 40,
          parentActivityId: FOUNDATIONS_ACTIVITY_ID,
          plannedStart: '2026-09-28',
          plannedFinish: '2026-11-16',
        },
      });
      world.versions.set(entity(3), version(2));
      world.provider.introduceDependency({
        objectId: 'dep-403-401',
        predecessorId: ENVELOPE_ACTIVITY_ID,
        successorId: FOUNDATIONS_ACTIVITY_ID,
        linkType: 'fs',
        lagDays: 0,
      });
      world.provider.attemptRebaseline(SEPTEMBER_BASELINE_ID, {
        label: 'baseline-2026-10-01',
      });
      const divergent = unwrap(await syncOnce(world.provider, world.deps));
      return JSON.stringify({
        streams: divergent.streams.map((stream) => ({
          objectKind: stream.objectKind,
          applications: stream.applications.map((application) => ({
            objectId: application.snapshot.source.objectId,
            outcome: application.outcome,
          })),
          conflicts: stream.conflicts,
        })),
        commands: divergent.commands.map((command) => ({
          commandName: command.commandName,
          idempotencyKey: command.idempotencyKey,
          payload: command.payload,
        })),
        conflicts: divergent.conflicts,
        conflictRules: divergent.conflictRules,
      });
    };
    expect(await run()).toStrictEqual(await run());
  });

  it('re-syncs a fresh world into the SAME canonical ids (provider ids are never keys)', async () => {
    const first = await establishedWorld(() => NOW_1);
    const second = await establishedWorld(() => NOW_1);
    for (const [objectType, objectId] of [
      ['project-schedule', TOWER_SCHEDULE_ID],
      ['activity', FOUNDATIONS_ACTIVITY_ID],
      ['activity', STRUCTURE_ACTIVITY_ID],
      ['activity', ENVELOPE_ACTIVITY_ID],
      ['activity-dependency', FOUNDATIONS_STRUCTURE_DEPENDENCY_ID],
      ['activity-dependency', STRUCTURE_ENVELOPE_DEPENDENCY_ID],
      ['baseline', SEPTEMBER_BASELINE_ID],
    ] as const) {
      const firstMapping = await first.deps.mappings.findByCoordinate(
        TENANT_A,
        coordinate(objectType, objectId),
      );
      const secondMapping = await second.deps.mappings.findByCoordinate(
        TENANT_A,
        coordinate(objectType, objectId),
      );
      expect(firstMapping?.canonical).toStrictEqual(secondMapping?.canonical);
      expect(firstMapping?.providerVersion).toBe(secondMapping?.providerVersion);
    }
    expect(first.first.commands).toStrictEqual(second.first.commands);
  });
});
