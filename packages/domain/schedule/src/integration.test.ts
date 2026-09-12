import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import type { DomainEventEnvelope } from '@office/contracts';
import {
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  ADD_MILESTONE_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  RECORD_PROGRESS_COMMAND,
  REMOVE_DEPENDENCY_COMMAND,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  createScheduleCommands,
} from './commands';
import type { ScheduleCommandDeps, ScheduleCommands } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { forecastOfSchedule } from './forecast';
import type { ScheduleForecast } from './forecast';
import { createInMemoryScheduleStore } from './store';
import type { InMemoryScheduleStore } from './store';
import type { ScheduleState } from './state';

// OFF-010 schedule domain — the full in-memory acceptance suite: the whole
// mutation lifecycle through the command service (create -> activities ->
// dependencies -> milestone -> baseline -> progress -> update -> remove),
// audit events through the EventSink on every mutation (scope, actor, source
// 'domain', correlation/causation propagated from the command envelope,
// before/after entity refs), optimistic concurrency, cycle rejection with the
// network unchanged, the failing-sink abort, baseline immutability under
// progress, the deterministic forecast recomputation after each progress
// event, and deterministic end-to-end replay of the identical command
// sequence. No I/O, fixed clock and id suppliers.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const unwrapResult = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const PROJECT_SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };

// Kind-scoped policy: schedule.write over the schedule entity kinds, plus the
// distinct stronger projects.write gate baselining requires.
const POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['schedule.write'],
    actions: ['write'],
    resourceKinds: ['schedule', 'activity', 'dependency', 'milestone', 'baseline', 'progress-update'],
  },
  {
    effect: 'allow',
    capabilities: ['projects.write'],
    actions: ['write'],
    resourceKinds: ['project'],
  },
]);
const SCHEDULER = { policy: POLICY, capabilities: ['schedule.write'] };
const BASELINER = { policy: POLICY, capabilities: ['schedule.write', 'projects.write'] };

interface Harness {
  readonly store: InMemoryScheduleStore;
  readonly sink: InMemoryEventSink;
  readonly commands: ScheduleCommands;
}

const makeHarness = (): Harness => {
  const store = createInMemoryScheduleStore();
  const sink = createInMemoryEventSink();
  let issued = 0;
  const deps: ScheduleCommandDeps = {
    store,
    eventSink: sink,
    now: () => NOW,
    newOpaqueId: () => {
      issued += 1;
      return `a${String(issued).padStart(15, '0')}`;
    },
  };
  return { store, sink, commands: createScheduleCommands(deps) };
};

let envelopeCounter = 0;
const envelope = (
  payload: unknown,
  commandName: CommandName,
  scope: Scope = PROJECT_SCOPE,
): CommandEnvelope<unknown> => {
  envelopeCounter += 1;
  return unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope,
      actor: { kind: 'user', actorId: ACTOR_ID },
      idempotencyKey: `idem-${String(envelopeCounter).padStart(12, '0')}`,
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );
};

const mustSucceed = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }, what: string): T => {
  if (!result.ok) {
    throw new Error(`${what} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

/** The canonical lifecycle: one command per mutation, expected versions chained. */
const runLifecycleAsync = async (
  harness: Harness,
): Promise<{ scheduleId: string; final: ScheduleState }> => {
  const created = mustSucceed(
    await harness.commands.createSchedule(
      envelope({ name: 'Riverside program of work' }, CREATE_SCHEDULE_COMMAND),
      SCHEDULER,
    ),
    'createSchedule',
  );
  const scheduleId = created.entityId;
  let version = created.version;

  const addActivity = async (code: string, name: string, plannedDuration: number) => {
    const state = mustSucceed(
      await harness.commands.addActivity(
        envelope(
          { scheduleId, expectedVersion: version, code, name, plannedDuration },
          ADD_ACTIVITY_COMMAND,
        ),
        SCHEDULER,
      ),
      `addActivity ${code}`,
    );
    version = state.version;
    return state;
  };

  let state = await addActivity('A', 'Foundations', 3);
  state = await addActivity('B', 'Structure', 2);
  state = await addActivity('C', 'Finishes', 4);

  const activityIdOf = (code: string): string => {
    const activity = Object.values(state.activities).find((a) => a.code === code);
    if (activity === undefined) throw new Error(`activity ${code} missing`);
    return activity.entityId;
  };
  const actA = activityIdOf('A');
  const actB = activityIdOf('B');
  const actC = activityIdOf('C');

  const withDependency = mustSucceed(
    await harness.commands.addDependency(
      envelope(
        {
          scheduleId,
          expectedVersion: version,
          predecessorId: actA,
          successorId: actB,
          linkType: 'FS',
          lagDays: 0,
        },
        ADD_DEPENDENCY_COMMAND,
      ),
      SCHEDULER,
    ),
    'addDependency A->B',
  );
  version = withDependency.version;

  const withSecondDependency = mustSucceed(
    await harness.commands.addDependency(
      envelope(
        {
          scheduleId,
          expectedVersion: version,
          predecessorId: actB,
          successorId: actC,
          linkType: 'FS',
          lagDays: 1,
        },
        ADD_DEPENDENCY_COMMAND,
      ),
      SCHEDULER,
    ),
    'addDependency B->C',
  );
  version = withSecondDependency.version;

  const withMilestone = mustSucceed(
    await harness.commands.addMilestone(
      envelope(
        {
          scheduleId,
          expectedVersion: version,
          code: 'M-FINISH',
          name: 'Program finishes',
          boundActivityId: actC,
        },
        ADD_MILESTONE_COMMAND,
      ),
      SCHEDULER,
    ),
    'addMilestone',
  );
  version = withMilestone.version;

  const withBaseline = mustSucceed(
    await harness.commands.setBaseline(
      envelope({ scheduleId, expectedVersion: version, label: 'Plan A' }, SET_BASELINE_COMMAND),
      BASELINER,
    ),
    'setBaseline',
  );
  version = withBaseline.version;

  const withProgress = mustSucceed(
    await harness.commands.recordProgress(
      envelope(
        {
          scheduleId,
          activityId: actA,
          expectedVersion: version,
          percentComplete: 100,
          remainingDuration: 0,
          actualStart: '2026-09-12T10:15:31.000Z',
          actualFinish: '2026-09-13T09:00:00.000Z',
        },
        RECORD_PROGRESS_COMMAND,
      ),
      SCHEDULER,
    ),
    'recordProgress A',
  );
  version = withProgress.version;

  const withUpdate = mustSucceed(
    await harness.commands.updateActivity(
      envelope(
        {
          scheduleId,
          activityId: actC,
          expectedVersion: version,
          plannedDuration: 6,
        },
        UPDATE_ACTIVITY_COMMAND,
      ),
      SCHEDULER,
    ),
    'updateActivity C',
  );
  version = withUpdate.version;

  const dependencyId = Object.keys(withUpdate.dependencies).find(
    (id) => withUpdate.dependencies[id]?.predecessorId === actB,
  );
  if (dependencyId === undefined) throw new Error('dependency B->C missing');

  const withRemoval = mustSucceed(
    await harness.commands.removeDependency(
      envelope(
        { scheduleId, dependencyId, expectedVersion: version },
        REMOVE_DEPENDENCY_COMMAND,
      ),
      SCHEDULER,
    ),
    'removeDependency',
  );

  return { scheduleId, final: withRemoval };
};

describe('the full mutation lifecycle (in-memory, one event per mutation)', () => {
  it('executes every command, bumps the root version per mutation, and appends exactly one audit event each', async () => {
    const harness = makeHarness();
    const { final } = await runLifecycleAsync(harness);

    // Final aggregate: 3 activities, 1 dependency left (A->B; B->C removed),
    // 1 milestone, 1 baseline, 1 progress entry — version 11 (one per mutation).
    expect(Object.keys(final.activities)).toHaveLength(3);
    expect(Object.keys(final.dependencies)).toHaveLength(1);
    expect(Object.keys(final.milestones)).toHaveLength(1);
    expect(Object.keys(final.baselines)).toHaveLength(1);
    expect(final.progressUpdates).toHaveLength(1);
    expect(final.version).toBe(11);
    expect(final.currentBaselineId).not.toBeNull();
    expect(final.scope).toStrictEqual(PROJECT_SCOPE);

    // One audit event per mutation, in mutation order.
    const names = harness.sink.events.map((event) => event.eventName);
    expect(names).toStrictEqual([
      'schedule.scheduleCreated',
      'schedule.activityAdded',
      'schedule.activityAdded',
      'schedule.activityAdded',
      'schedule.dependencyAdded',
      'schedule.dependencyAdded',
      'schedule.milestoneAdded',
      'schedule.baselineSet',
      'schedule.progressRecorded',
      'schedule.activityUpdated',
      'schedule.dependencyRemoved',
    ]);
    expect(harness.sink.appends).toHaveLength(11);
    expect(harness.sink.events).toHaveLength(11);
  });

  it('every event carries the aggregate scope, actor, source domain, propagated causality, and before/after refs', async () => {
    const counterAtStart = envelopeCounter;
    const harness = makeHarness();
    const { scheduleId } = await runLifecycleAsync(harness);

    const events = harness.sink.events as readonly DomainEventEnvelope[];
    // The command envelopes used consecutive idempotency keys starting at the
    // test's own counter value; every event's causation id is its command's
    // idempotency key and the correlation id carries over from the chain.
    for (const [index, event] of events.entries()) {
      expect(event.kind).toBe('event');
      expect(event.scope).toStrictEqual(PROJECT_SCOPE);
      expect(event.actor).toStrictEqual({ kind: 'user', actorId: ACTOR_ID });
      expect(event.source).toBe('domain');
      expect(event.causality.correlationId).toBe('corr-0f1e2d3c4b5a');
      expect(event.causality.causationId).toBe(
        `idem-${String(counterAtStart + index + 1).padStart(12, '0')}`,
      );
      expect(event.schemaVersion).toBe('1.0.0');
      expect(event.occurredAt).toBe(NOW);
      // Every schedule event payload carries the owning schedule id (the
      // ledger aggregate stream key).
      expect((event.payload as { scheduleId?: unknown }).scheduleId).toBe(scheduleId);
    }

    // Before/after refs follow the transition kinds.
    const created = events[0];
    expect(created?.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: 'schedule', entityId: scheduleId },
    });
    const activityAdded = events[1];
    expect(activityAdded?.entityRefs?.before).toBeNull();
    expect(activityAdded?.entityRefs?.after?.entityKind).toBe('activity');
    const dependencyAdded = events[4];
    expect(dependencyAdded?.entityRefs?.after?.entityKind).toBe('dependency');
    const milestoneAdded = events[6];
    expect(milestoneAdded?.entityRefs?.after?.entityKind).toBe('milestone');
    const baselineSet = events[7];
    expect(baselineSet?.entityRefs?.after?.entityKind).toBe('baseline');
    const progressRecorded = events[8];
    expect(progressRecorded?.entityRefs?.before?.entityKind).toBe('activity');
    expect(progressRecorded?.entityRefs?.after?.entityKind).toBe('activity');
    const activityUpdated = events[9];
    expect(activityUpdated?.entityRefs?.before?.entityKind).toBe('activity');
    expect(activityUpdated?.entityRefs?.after?.entityKind).toBe('activity');
    const dependencyRemoved = events[10];
    expect(dependencyRemoved?.entityRefs?.before?.entityKind).toBe('dependency');
    expect(dependencyRemoved?.entityRefs?.after).toBeNull();

    // The baseline-set payload records the consequential decision's shape.
    expect(baselineSet?.payload).toStrictEqual({
      scheduleId,
      baselineId: final(harness).currentBaselineId,
      sequence: 1,
      label: 'Plan A',
      supersedes: null,
      activityCount: 3,
      dependencyCount: 2,
      milestoneCount: 1,
      version: 8,
      createdAt: NOW,
    });
  });

  it('records progress as events with the full update payload', async () => {
    const harness = makeHarness();
    await runLifecycleAsync(harness);
    const progressEvent = harness.sink.events[8];
    const activityA = Object.values(
      harness.store.schedules[0]?.activities ?? {},
    ).find((activity) => activity.code === 'A');
    expect(progressEvent?.payload).toStrictEqual({
      scheduleId: harness.store.schedules[0]?.entityId,
      progressUpdateId: harness.store.schedules[0]?.progressUpdates[0]?.entityId,
      activityId: activityA?.entityId,
      percentComplete: 100,
      remainingDuration: 0,
      actualStart: '2026-09-12T10:15:31.000Z',
      actualFinish: '2026-09-13T09:00:00.000Z',
      version: 9,
    });
  });
});

const final = (harness: Harness): ScheduleState => {
  const state = harness.store.schedules[0];
  if (state === undefined) throw new Error('no committed schedule');
  return state;
};

describe('baseline immutability under the command path', () => {
  it('progress and plan changes flow through events; every landed baseline stays bit-identical', async () => {
    const harness = makeHarness();
    const { final: state } = await runLifecycleAsync(harness);
    const baselineId = state.currentBaselineId;
    if (baselineId === null) throw new Error('baseline missing');
    const baseline = state.baselines[baselineId];
    if (baseline === undefined) throw new Error('baseline missing');

    // The snapshot captured the pre-progress plan: A duration 3, C duration 4,
    // two dependencies (A->B, B->C lag 1), one milestone.
    expect(baseline.snapshot.activities.find((a) => a.code === 'A')?.plannedDuration).toBe(3);
    expect(baseline.snapshot.activities.find((a) => a.code === 'C')?.plannedDuration).toBe(4);
    expect(baseline.snapshot.dependencies).toHaveLength(2);
    expect(baseline.snapshot.milestones).toHaveLength(1);
    // The snapshot does NOT carry the progress log (the plan, not the log).
    expect('progressUpdates' in (baseline.snapshot as object)).toBe(false);

    // Re-baseline after the divergence: APPENDS a second baseline, chain intact.
    const rebase = mustSucceed(
      await harness.commands.setBaseline(
        envelope(
          { scheduleId: state.entityId, expectedVersion: state.version },
          SET_BASELINE_COMMAND,
        ),
        BASELINER,
      ),
      'setBaseline 2',
    );
    expect(Object.keys(rebase.baselines)).toHaveLength(2);
    expect(rebase.currentBaselineId).not.toBe(baselineId);
    const second = rebase.baselines[rebase.currentBaselineId ?? ''];
    expect(second?.supersedes).toBe(baselineId);
    expect(second?.sequence).toBe(2);
    // The first baseline is untouched by the re-baseline.
    expect(rebase.baselines[baselineId]).toStrictEqual(baseline);
  });
});

describe('the failing EventSink aborts the mutation (atomicity)', () => {
  it('a create whose event append fails leaves NO schedule behind', async () => {
    const store = createInMemoryScheduleStore();
    const failing = createInMemoryEventSink();
    // Replace the sink behavior with a failure on the first append.
    const sink: InMemoryEventSink = {
      ...failing,
      appendEvents: async () => {
        return { ok: false as const, error: {
          kind: 'domain-error' as const,
          code: 'invariant-violation' as const,
          message: 'event sink rejected the append: ledger unavailable',
          scope: null,
          correlationId: null,
          details: [{ code: 'event-sink-rejected', message: 'ledger unavailable', path: null }],
        } };
      },
    };
    const commands = createScheduleCommands({
      store,
      eventSink: sink,
      now: () => NOW,
      newOpaqueId: () => 'a000000000000009',
    });
    const result = await commands.createSchedule(
      envelope({ name: 'Riverside program of work' }, CREATE_SCHEDULE_COMMAND),
      SCHEDULER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    expect(store.schedules).toHaveLength(0);
    expect(store.transactionCount).toBe(1);
  });

  it('a mutation whose event append fails leaves the aggregate UNCHANGED', async () => {
    const harness = makeHarness();
    const { scheduleId, final: state } = await runLifecycleAsync(harness);
    const eventsBefore = harness.sink.events.length;

    // Re-wire the SAME store with a failing sink.
    const failingCommands = createScheduleCommands({
      store: harness.store,
      eventSink: {
        appendEvents: async () => {
          return { ok: false as const, error: {
            kind: 'domain-error' as const,
            code: 'invariant-violation' as const,
            message: 'event sink rejected the append: ledger unavailable',
            scope: null,
            correlationId: null,
            details: [{ code: 'event-sink-rejected', message: 'ledger unavailable', path: null }],
          } };
        },
      },
      now: () => NOW,
      newOpaqueId: () => 'a000000000000009',
    });
    const result = await failingCommands.addActivity(
      envelope(
        {
          scheduleId,
          expectedVersion: state.version,
          code: 'D',
          name: 'Late activity',
          plannedDuration: 1,
        },
        ADD_ACTIVITY_COMMAND,
      ),
      SCHEDULER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    // The rolled-back write never committed.
    expect(final(harness).version).toBe(state.version);
    expect(Object.keys(final(harness).activities)).toHaveLength(3);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });
});

describe('dependency cycles are rejected through the command path too', () => {
  it('the cycle-closing command fails typed and the committed network is unchanged', async () => {
    const harness = makeHarness();
    const created = mustSucceed(
      await harness.commands.createSchedule(
        envelope({ name: 'Riverside program of work' }, CREATE_SCHEDULE_COMMAND),
        SCHEDULER,
      ),
      'createSchedule',
    );
    const scheduleId = created.entityId;
    let version = created.version;
    const ids: string[] = [];
    for (const code of ['A', 'B']) {
      const state = mustSucceed(
        await harness.commands.addActivity(
          envelope(
            { scheduleId, expectedVersion: version, code, name: `Activity ${code}`, plannedDuration: 2 },
            ADD_ACTIVITY_COMMAND,
          ),
          SCHEDULER,
        ),
        `addActivity ${code}`,
      );
      version = state.version;
      const id = Object.values(state.activities).find((a) => a.code === code)?.entityId;
      if (id === undefined) throw new Error('activity id missing');
      ids.push(id);
    }
    const [actA, actB] = ids;
    const withLink = mustSucceed(
      await harness.commands.addDependency(
        envelope(
          { scheduleId, expectedVersion: version, predecessorId: actA, successorId: actB, linkType: 'FS' },
          ADD_DEPENDENCY_COMMAND,
        ),
        SCHEDULER,
      ),
      'addDependency A->B',
    );
    version = withLink.version;
    const eventsBefore = harness.sink.events.length;

    // The cycle-closing link.
    const result = await harness.commands.addDependency(
      envelope(
        { scheduleId, expectedVersion: version, predecessorId: actB, successorId: actA, linkType: 'FS' },
        ADD_DEPENDENCY_COMMAND,
      ),
      SCHEDULER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('schedule-dependency-graph-acyclic');
    }
    expect(final(harness).version).toBe(version);
    expect(Object.keys(final(harness).dependencies)).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });
});

describe('the forecast recomputes cleanly after each progress event', () => {
  it('each recorded progress event shifts the deterministic remaining-work forecast', async () => {
    const harness = makeHarness();
    const created = mustSucceed(
      await harness.commands.createSchedule(
        envelope({ name: 'Riverside program of work' }, CREATE_SCHEDULE_COMMAND),
        SCHEDULER,
      ),
      'createSchedule',
    );
    const scheduleId = created.entityId;
    let version = created.version;
    const ids: string[] = [];
    for (const [code, duration] of [
      ['A', 5],
      ['B', 3],
    ] as const) {
      const state = mustSucceed(
        await harness.commands.addActivity(
          envelope(
            { scheduleId, expectedVersion: version, code, name: `Activity ${code}`, plannedDuration: duration },
            ADD_ACTIVITY_COMMAND,
          ),
          SCHEDULER,
        ),
        `addActivity ${code}`,
      );
      version = state.version;
      const id = Object.values(state.activities).find((a) => a.code === code)?.entityId;
      if (id === undefined) throw new Error('activity id missing');
      ids.push(id);
    }
    const [actA, actB] = ids;
    const withLink = mustSucceed(
      await harness.commands.addDependency(
        envelope(
          { scheduleId, expectedVersion: version, predecessorId: actA, successorId: actB, linkType: 'FS' },
          ADD_DEPENDENCY_COMMAND,
        ),
        SCHEDULER,
      ),
      'addDependency',
    );
    version = withLink.version;

    const forecastOf = (): ScheduleForecast =>
      unwrapResult(forecastOfSchedule(final(harness)));
    const rowOf = (forecast: ScheduleForecast, code: string) => {
      const row = forecast.activities.find((candidate) => candidate.code === code);
      if (row === undefined) throw new Error(`row ${code} missing`);
      return row;
    };

    // No progress yet: A(5) -> B(3), program 8 days.
    expect(forecastOf().projectDuration).toBe(8);
    expect(rowOf(forecastOf(), 'B').earlyStart).toBe(5);

    // Progress 40% on A: 3 days of work remain -> program 6 days.
    const partial = mustSucceed(
      await harness.commands.recordProgress(
        envelope(
          {
            scheduleId,
            activityId: actA,
            expectedVersion: version,
            percentComplete: 40,
            remainingDuration: 3,
          },
          RECORD_PROGRESS_COMMAND,
        ),
        SCHEDULER,
      ),
      'recordProgress 40',
    );
    version = partial.version;
    expect(forecastOf().projectDuration).toBe(6);
    expect(rowOf(forecastOf(), 'A').remainingDuration).toBe(3);
    expect(rowOf(forecastOf(), 'B').earlyStart).toBe(3);

    // Progress 100% on A: B starts at the origin -> program 3 days.
    const complete = mustSucceed(
      await harness.commands.recordProgress(
        envelope(
          {
            scheduleId,
            activityId: actA,
            expectedVersion: version,
            percentComplete: 100,
            remainingDuration: 0,
            actualStart: '2026-09-12T10:15:31.000Z',
            actualFinish: '2026-09-13T09:00:00.000Z',
          },
          RECORD_PROGRESS_COMMAND,
        ),
        SCHEDULER,
      ),
      'recordProgress 100',
    );
    version = complete.version;
    expect(forecastOf().projectDuration).toBe(3);
    expect(rowOf(forecastOf(), 'B').earlyStart).toBe(0);

    // The forecast stays deterministic across repeated recomputation.
    expect(forecastOf()).toStrictEqual(forecastOf());
  });
});

describe('deterministic end-to-end replay', () => {
  it('the identical command sequence on a fresh harness reproduces the identical state and event stream', async () => {
    // Two harnesses with the SAME injected clock and the SAME id-supplier
    // sequence (both start their opaque counters at 1).
    const first = makeHarness();
    const second = makeHarness();
    // Envelope idempotency counters must be reset so both runs issue the
    // same command envelopes; isolate by snapshotting the current value.
    const counterBefore = envelopeCounter;
    envelopeCounter = 0;
    const runOne = await runLifecycleAsync(first);
    const eventsOne = [...first.sink.events];
    envelopeCounter = 0;
    const runTwo = await runLifecycleAsync(second);
    const eventsTwo = [...second.sink.events];
    envelopeCounter = counterBefore;

    // Identical canonical ids (same opaque sequence) and identical states.
    expect(runOne.scheduleId).toBe(runTwo.scheduleId);
    expect(runOne.final).toStrictEqual(runTwo.final);
    // Identical audit event streams (names, scopes, actors, causality, refs,
    // payloads — including the issued activity/dependency/milestone/baseline/
    // progress-update ids).
    expect(eventsOne).toStrictEqual(eventsTwo);
  });
});
