import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, Timestamp } from '@office/contracts';
import type { SqlExecutor } from '@office/persistence';
import {
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_UPDATED_EVENT,
  BASELINE_SET_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  MILESTONE_ADDED_EVENT,
  PROGRESS_RECORDED_EVENT,
  SCHEDULE_CREATED_EVENT,
  activityRef,
  baselineRef,
  createInMemoryEventSink,
  dependencyRef,
  eventSinkFailure,
  failingEventSink,
  milestoneRef,
  progressUpdateRef,
  scheduleEventEnvelope,
  scheduleRef,
} from './events';
import type { EventSink } from './events';
import {
  ACTIVITY_KIND,
  BASELINE_KIND,
  DEPENDENCY_KIND,
  MILESTONE_KIND,
  PROGRESS_UPDATE_KIND,
  SCHEDULE_KIND,
  addActivityState,
  addDependencyState,
  addMilestoneState,
  createScheduleState,
  recordProgressState,
  setBaselineState,
  updateActivityState,
} from './state';
import type { ScheduleState } from './state';

// OFF-010 schedule domain — audit events + the EventSink port. Unit tests: the
// event vocabulary parses, the envelope builder propagates actor/scope/source/
// causality from the command envelope and carries before/after entity refs,
// and the in-memory sink records appends for deterministic assertions. No
// I/O, fixed everything.

const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const id = (prefix: string, n: number) =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

const SCHEDULE_ID = id('sch', 1);
const ACT_A = id('act', 1);
const ACT_B = id('act', 2);
const DEP_1 = id('dep', 1);
const MILESTONE_1 = id('mil', 1);
const BASELINE_1 = id('bas', 1);
const PROGRESS_1 = id('prg', 1);

const SCOPE = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID } as const;

const command: CommandEnvelope<unknown> = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'schedule.addActivity',
    scope: { kind: 'tenant', tenantId: TENANT_A },
    actor: { kind: 'user', actorId: ACTOR_ID },
    idempotencyKey: 'idem-4f9d2c81a7e3',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: {},
  }),
);

const network = (): ScheduleState => {
  let state = unwrap(
    createScheduleState(
      { scheduleId: SCHEDULE_ID, name: 'Riverside program', now: NOW },
      SCOPE,
    ),
  );
  state = unwrap(
    addActivityState(state, {
      activityId: ACT_A,
      code: 'A',
      name: 'Activity A',
      plannedDuration: 3,
      now: NOW,
    }),
  );
  state = unwrap(
    addActivityState(state, {
      activityId: ACT_B,
      code: 'B',
      name: 'Activity B',
      plannedDuration: 2,
      now: NOW,
    }),
  );
  state = unwrap(
    addDependencyState(state, {
      dependencyId: DEP_1,
      predecessorId: ACT_A,
      successorId: ACT_B,
      linkType: 'FS',
      lagDays: 0,
      now: NOW,
    }),
  );
  return state;
};

describe('schedule event vocabulary', () => {
  it('declares the eight audit event names', () => {
    expect(SCHEDULE_CREATED_EVENT).toBe('schedule.scheduleCreated');
    expect(ACTIVITY_ADDED_EVENT).toBe('schedule.activityAdded');
    expect(ACTIVITY_UPDATED_EVENT).toBe('schedule.activityUpdated');
    expect(DEPENDENCY_ADDED_EVENT).toBe('schedule.dependencyAdded');
    expect(DEPENDENCY_REMOVED_EVENT).toBe('schedule.dependencyRemoved');
    expect(MILESTONE_ADDED_EVENT).toBe('schedule.milestoneAdded');
    expect(BASELINE_SET_EVENT).toBe('schedule.baselineSet');
    expect(PROGRESS_RECORDED_EVENT).toBe('schedule.progressRecorded');
  });
});

describe('schedule event envelope construction (A3)', () => {
  it('propagates actor, causality and the aggregate scope from the command', () => {
    const event = scheduleEventEnvelope({
      command,
      eventName: ACTIVITY_ADDED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: {
        before: null,
        after: { entityKind: ACTIVITY_KIND, entityId: ACT_A },
      },
      payload: {
        scheduleId: SCHEDULE_ID,
        activityId: ACT_A,
        code: 'A',
        name: 'Activity A',
        plannedDuration: 3,
        parentActivityId: null,
        version: 2,
      },
    });
    expect(event.kind).toBe('event');
    expect(event.eventName).toBe('schedule.activityAdded');
    // The audit event carries the aggregate's OWN project scope.
    expect(event.scope).toStrictEqual(SCOPE);
    expect(event.actor).toStrictEqual({ kind: 'user', actorId: ACTOR_ID });
    expect(event.source).toBe('domain');
    // The correlation id carries over from the command's causal chain; the
    // causation id of the event is the COMMAND's idempotency key (the
    // ledger convention).
    expect(event.causality).toStrictEqual({
      correlationId: 'corr-0f1e2d3c4b5a',
      causationId: 'idem-4f9d2c81a7e3',
    });
    expect(event.schemaVersion).toBe('1.0.0');
    expect(event.occurredAt).toBe(NOW);
    expect(event.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: ACTIVITY_KIND, entityId: ACT_A },
    });
    expect(event.payload).toStrictEqual({
      scheduleId: SCHEDULE_ID,
      activityId: ACT_A,
      code: 'A',
      name: 'Activity A',
      plannedDuration: 3,
      parentActivityId: null,
      version: 2,
    });
  });

  it('carries before/after entity refs for update-kind events', () => {
    const ref = { entityKind: ACTIVITY_KIND, entityId: ACT_A };
    const event = scheduleEventEnvelope({
      command,
      eventName: ACTIVITY_UPDATED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: { before: ref, after: ref },
      payload: {
        scheduleId: SCHEDULE_ID,
        activityId: ACT_A,
        code: 'A',
        plannedDuration: 5,
        version: 3,
        updatedAt: NOW,
      },
    });
    expect(event.entityRefs).toStrictEqual({ before: ref, after: ref });
  });

  it('carries a before ref and a null after ref for removal events', () => {
    const event = scheduleEventEnvelope({
      command,
      eventName: DEPENDENCY_REMOVED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: {
        before: { entityKind: DEPENDENCY_KIND, entityId: DEP_1 },
        after: null,
      },
      payload: {
        scheduleId: SCHEDULE_ID,
        dependencyId: DEP_1,
        predecessorId: ACT_A,
        successorId: ACT_B,
        linkType: 'FS',
        version: 4,
      },
    });
    expect(event.entityRefs).toStrictEqual({
      before: { entityKind: DEPENDENCY_KIND, entityId: DEP_1 },
      after: null,
    });
  });
});

describe('entity ref builders', () => {
  it('builds canonical refs for every entity model of the root', () => {
    let state = network();
    state = unwrap(
      addMilestoneState(state, {
        milestoneId: MILESTONE_1,
        code: 'M',
        name: 'Milestone',
        boundActivityId: ACT_A,
        now: NOW,
      }),
    );
    state = unwrap(setBaselineState(state, { baselineId: BASELINE_1, now: NOW }));
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_1,
        activityId: ACT_A,
        percentComplete: 100,
        remainingDuration: 0,
        actualStart: NOW,
        actualFinish: NOW,
        now: NOW,
      }),
    );
    state = unwrap(updateActivityState(state, ACT_A, { name: 'A2' }, NOW));

    expect(scheduleRef(state)).toStrictEqual({
      entityKind: SCHEDULE_KIND,
      entityId: SCHEDULE_ID,
    });
    expect(activityRef(state.activities[ACT_A] as never)).toStrictEqual({
      entityKind: ACTIVITY_KIND,
      entityId: ACT_A,
    });
    expect(dependencyRef(state.dependencies[DEP_1] as never)).toStrictEqual({
      entityKind: DEPENDENCY_KIND,
      entityId: DEP_1,
    });
    expect(milestoneRef(state.milestones[MILESTONE_1] as never)).toStrictEqual({
      entityKind: MILESTONE_KIND,
      entityId: MILESTONE_1,
    });
    expect(baselineRef(state.baselines[BASELINE_1] as never)).toStrictEqual({
      entityKind: BASELINE_KIND,
      entityId: BASELINE_1,
    });
    expect(progressUpdateRef(state.progressUpdates[0] as never)).toStrictEqual({
      entityKind: PROGRESS_UPDATE_KIND,
      entityId: PROGRESS_1,
    });
  });
});

describe('EventSink port', () => {
  const executor: SqlExecutor = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };

  const envelope = () =>
    scheduleEventEnvelope({
      command,
      eventName: SCHEDULE_CREATED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: {
        before: null,
        after: { entityKind: SCHEDULE_KIND, entityId: SCHEDULE_ID },
      },
      payload: {
        scheduleId: SCHEDULE_ID,
        name: 'Riverside program',
        version: 1,
        createdAt: NOW,
      },
    });

  it('the in-memory sink records appends with the executor it was handed', async () => {
    const sink = createInMemoryEventSink();
    const event = envelope();
    const result = await sink.appendEvents(executor, [event]);
    expect(result.ok).toBe(true);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.executor).toBe(executor);
    expect(sink.events).toStrictEqual([event]);
  });

  it('flattens multiple appends into one ordered event stream', async () => {
    const sink = createInMemoryEventSink();
    const first = envelope();
    const second = envelope();
    await sink.appendEvents(executor, [first]);
    await sink.appendEvents(executor, [second]);
    expect(sink.appends).toHaveLength(2);
    expect(sink.events).toStrictEqual([first, second]);
  });

  it('a failing sink returns a typed DomainError failure', async () => {
    const sink: EventSink = failingEventSink('ledger unavailable');
    const result = await sink.appendEvents(executor, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
      expect(eventSinkFailure('ledger unavailable').message).toContain(
        'ledger unavailable',
      );
    }
  });

  it('the port is structural: any appendEvents(executor, events) object satisfies it', () => {
    const implementation = createInMemoryEventSink();
    const asPort: EventSink = implementation;
    expect(typeof asPort.appendEvents).toBe('function');
  });
});
