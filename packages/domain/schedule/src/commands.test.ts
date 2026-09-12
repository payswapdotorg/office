import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, CommandName, ParseResult, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
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
  parseAddActivityPayload,
  parseAddDependencyPayload,
  parseAddMilestonePayload,
  parseCreateSchedulePayload,
  parseRecordProgressPayload,
  parseRemoveDependencyPayload,
  parseSetBaselinePayload,
  parseUpdateActivityPayload,
} from './commands';
import type { ScheduleCommandDeps, ScheduleCommands } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryScheduleStore } from './store';
import type { InMemoryScheduleStore } from './store';

// OFF-010 schedule domain — command payload parsing (fail-closed), the
// command-name guard, the authorization gates (including the DISTINCT
// stronger baseline capability), the A12 scope rules, and optimistic
// concurrency. All against the deterministic in-memory store: denied
// commands never open a transaction; failed mutations never change state.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const TENANT_B = formatTenantId({ version: 'v1', opaque: '9f8e7d6c5b4a30291827364554637281' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const OTHER_PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const ENTITY_ID = 'office-ent-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9' as const;
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const PROJECT_SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };
const TENANT_A_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_A };
const TENANT_B_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_B };
const OTHER_PROJECT_SCOPE: Scope = {
  kind: 'project',
  tenantId: TENANT_A,
  projectId: OTHER_PROJECT_ID,
};

let idempotencyCounter = 0;
const envelope = (
  payload: unknown,
  commandName: CommandName,
  scope: Scope = PROJECT_SCOPE,
): CommandEnvelope<unknown> => {
  idempotencyCounter += 1;
  return unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope,
      actor: { kind: 'user', actorId: ACTOR_ID },
      idempotencyKey: `idem-${String(idempotencyCounter).padStart(12, '0')}`,
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );
};

// The schedule-area write gate every schedule mutation requires: the rule
// scopes the schedule.write capability to the schedule domain's entity kinds
// (the closed resource vocabulary the handlers authorize against).
const SCHEDULE_AREA_KINDS = [
  'schedule',
  'activity',
  'dependency',
  'milestone',
  'baseline',
  'progress-update',
] as const;
const SCHEDULE_WRITE_POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['schedule.write'],
    actions: ['write'],
    resourceKinds: [...SCHEDULE_AREA_KINDS],
  },
]);
// The DISTINCT stronger project-area write gate baselining additionally
// requires (resource kind 'project').
const PROJECT_WRITE_POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['projects.write'],
    actions: ['write'],
    resourceKinds: ['project'],
  },
]);
const FULL_POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['schedule.write'],
    actions: ['write'],
    resourceKinds: [...SCHEDULE_AREA_KINDS],
  },
  {
    effect: 'allow',
    capabilities: ['projects.write'],
    actions: ['write'],
    resourceKinds: ['project'],
  },
]);

const scheduleWriter = { policy: SCHEDULE_WRITE_POLICY, capabilities: ['schedule.write'] };
const baselineWriter = {
  policy: FULL_POLICY,
  capabilities: ['schedule.write', 'projects.write'],
};

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

const createdSchedule = async (harness: Harness): Promise<string> => {
  const result = await harness.commands.createSchedule(
    envelope({ name: 'Riverside program' }, CREATE_SCHEDULE_COMMAND),
    scheduleWriter,
  );
  if (!result.ok) throw new Error(`createSchedule failed: ${JSON.stringify(result.error)}`);
  return result.value.entityId;
};

// ----- payload parsing (fail-closed) ---------------------------------------------------

describe('createSchedule payload parsing (fail-closed)', () => {
  it('parses a minimal valid payload', () => {
    const result = parseCreateSchedulePayload({ name: 'Riverside program' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual({ name: 'Riverside program' });
  });

  it('parses an explicit projectId', () => {
    const result = parseCreateSchedulePayload({
      name: 'Riverside program',
      projectId: PROJECT_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.projectId).toBe(PROJECT_ID);
  });

  it('rejects a missing name', () => {
    const result = parseCreateSchedulePayload({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseCreateSchedulePayload({ name: 'X', code: 'RT-01' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects a non-object payload root', () => {
    const result = parseCreateSchedulePayload('schedule');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });
});

describe('addActivity payload parsing (fail-closed)', () => {
  const valid = {
    scheduleId: ENTITY_ID,
    expectedVersion: 1,
    code: 'A',
    name: 'Activity A',
    plannedDuration: 3,
  };

  it('parses a valid payload with defaulted optional fields', () => {
    const result = parseAddActivityPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plannedStart).toBeNull();
      expect(result.value.plannedFinish).toBeNull();
      expect(result.value.parentActivityId).toBeNull();
      expect(result.value.plannedDuration).toBe(3);
    }
  });

  it('parses optional planned dates and parent', () => {
    const result = parseAddActivityPayload({
      ...valid,
      plannedStart: '2026-09-12T10:15:31.000Z',
      parentActivityId: ENTITY_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plannedStart).toBe('2026-09-12T10:15:31.000Z');
      expect(result.value.parentActivityId).toBe(ENTITY_ID);
    }
  });

  it('rejects a non-integer planned duration', () => {
    const result = parseAddActivityPayload({ ...valid, plannedDuration: 2.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a malformed schedule id', () => {
    const result = parseAddActivityPayload({ ...valid, scheduleId: 'not-canonical' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseAddActivityPayload({ ...valid, wbs: '1.2' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('updateActivity payload parsing (fail-closed)', () => {
  it('parses change fields into the changes object', () => {
    const result = parseUpdateActivityPayload({
      scheduleId: ENTITY_ID,
      activityId: ENTITY_ID,
      expectedVersion: 2,
      name: 'A revised',
      plannedDuration: 7,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changes).toStrictEqual({ name: 'A revised', plannedDuration: 7 });
    }
  });

  it('rejects a payload with no change field', () => {
    const result = parseUpdateActivityPayload({
      scheduleId: ENTITY_ID,
      activityId: ENTITY_ID,
      expectedVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a non-positive expected version', () => {
    const result = parseUpdateActivityPayload({
      scheduleId: ENTITY_ID,
      activityId: ENTITY_ID,
      expectedVersion: 0,
      name: 'A revised',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('addDependency payload parsing (fail-closed)', () => {
  it('parses a valid link and defaults the lag to zero', () => {
    const result = parseAddDependencyPayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 3,
      predecessorId: ENTITY_ID,
      successorId: ENTITY_ID,
      linkType: 'FS',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lagDays).toBe(0);
  });

  it('parses an explicit signed lag', () => {
    const result = parseAddDependencyPayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 3,
      predecessorId: ENTITY_ID,
      successorId: ENTITY_ID,
      linkType: 'SS',
      lagDays: -2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lagDays).toBe(-2);
  });

  it('rejects a link type outside the closed FS/SS/FF/SF vocabulary', () => {
    for (const linkType of ['fs', 'FinishToStart', 'FF ', 'XX']) {
      const result = parseAddDependencyPayload({
        scheduleId: ENTITY_ID,
        expectedVersion: 3,
        predecessorId: ENTITY_ID,
        successorId: ENTITY_ID,
        linkType,
      });
      expect(result.ok, `linkType '${linkType}'`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-value');
    }
  });

  it('rejects an out-of-range lag', () => {
    const result = parseAddDependencyPayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 3,
      predecessorId: ENTITY_ID,
      successorId: ENTITY_ID,
      linkType: 'FS',
      lagDays: 4000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a missing link type', () => {
    const result = parseAddDependencyPayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 3,
      predecessorId: ENTITY_ID,
      successorId: ENTITY_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

describe('removeDependency payload parsing (fail-closed)', () => {
  it('parses a valid payload', () => {
    const result = parseRemoveDependencyPayload({
      scheduleId: ENTITY_ID,
      dependencyId: ENTITY_ID,
      expectedVersion: 4,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dependencyId).toBe(ENTITY_ID);
  });

  it('rejects a missing dependency id', () => {
    const result = parseRemoveDependencyPayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 4,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

describe('addMilestone payload parsing (fail-closed)', () => {
  it('parses a valid payload (bound activity optional)', () => {
    const result = parseAddMilestonePayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 5,
      code: 'M-COMPLETE',
      name: 'Completion',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.boundActivityId).toBeNull();
  });

  it('rejects a malformed bound activity id', () => {
    const result = parseAddMilestonePayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 5,
      code: 'M-COMPLETE',
      name: 'Completion',
      boundActivityId: 42,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });
});

describe('setBaseline payload parsing (fail-closed)', () => {
  it('parses a valid payload (label optional)', () => {
    const result = parseSetBaselinePayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 6,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.label).toBeUndefined();
  });

  it('rejects an empty label', () => {
    const result = parseSetBaselinePayload({
      scheduleId: ENTITY_ID,
      expectedVersion: 6,
      label: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('recordProgress payload parsing (fail-closed)', () => {
  const valid = {
    scheduleId: ENTITY_ID,
    activityId: ENTITY_ID,
    expectedVersion: 7,
    percentComplete: 40,
    remainingDuration: 2,
  };

  it('parses a valid in-progress update', () => {
    const result = parseRecordProgressPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.actualStart).toBeNull();
      expect(result.value.actualFinish).toBeNull();
    }
  });

  it('parses a completion update with actual dates', () => {
    const result = parseRecordProgressPayload({
      ...valid,
      percentComplete: 100,
      remainingDuration: 0,
      actualStart: '2026-09-12T10:15:31.000Z',
      actualFinish: '2026-09-13T09:00:00.000Z',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a percent complete outside 0..100', () => {
    const result = parseRecordProgressPayload({ ...valid, percentComplete: 101 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a negative remaining duration', () => {
    const result = parseRecordProgressPayload({ ...valid, remainingDuration: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a malformed actual start timestamp', () => {
    const result = parseRecordProgressPayload({
      ...valid,
      actualStart: '2026-09-12 10:15',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

// ----- command-name guard + authorization ----------------------------------------------

describe('command-name guard (trusted path, loud)', () => {
  it('rejects an envelope of another command kind with a TypeError', async () => {
    const harness = makeHarness();
    const wrongEnvelope = envelope(
      { name: 'Riverside program' },
      UPDATE_ACTIVITY_COMMAND,
    );
    await expect(
      harness.commands.createSchedule(wrongEnvelope, scheduleWriter),
    ).rejects.toThrow(TypeError);
    expect(harness.store.transactionCount).toBe(0);
  });
});

describe('authorization (deny-by-default, before any transaction)', () => {
  it('denies without the required capability and never opens a transaction', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createSchedule(
      envelope({ name: 'Riverside program' }, CREATE_SCHEDULE_COMMAND),
      { policy: definePolicy([]), capabilities: [] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
      expect(result.error.scope).toStrictEqual(PROJECT_SCOPE);
    }
    expect(harness.store.transactionCount).toBe(0);
    expect(harness.store.schedules).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(0);
  });

  it('denies through an explicit deny rule even with the capability granted', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createSchedule(
      envelope({ name: 'Riverside program' }, CREATE_SCHEDULE_COMMAND),
      {
        policy: definePolicy([
          {
            effect: 'deny',
            capabilities: ['schedule.write'],
            actions: ['write'],
            resourceKinds: ['schedule'],
          },
          {
            effect: 'allow',
            capabilities: ['schedule.write'],
            actions: ['write'],
            resourceKinds: ['schedule'],
          },
        ]),
        capabilities: ['schedule.write'],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
    expect(harness.store.transactionCount).toBe(0);
  });

  it('rejects an undeclared capability name loudly (trusted path)', async () => {
    const harness = makeHarness();
    await expect(
      harness.commands.createSchedule(
        envelope({ name: 'Riverside program' }, CREATE_SCHEDULE_COMMAND),
        { policy: definePolicy([]), capabilities: ['schedule.administer'] },
      ),
    ).rejects.toThrow(TypeError);
    expect(harness.store.transactionCount).toBe(0);
  });

  it('succeeds WITH the required capability (typed result, stored state)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createSchedule(
      envelope({ name: 'Riverside program' }, CREATE_SCHEDULE_COMMAND),
      scheduleWriter,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Riverside program');
      expect(result.value.scope).toStrictEqual(PROJECT_SCOPE);
      expect(result.value.version).toBe(1);
    }
    expect(harness.store.schedules).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(1);
  });
});

describe('baseline authorization (a DISTINCT stronger capability)', () => {
  const addActivities = async (harness: Harness): Promise<string> => {
    const scheduleId = await createdSchedule(harness);
    let version = 1;
    for (const code of ['A', 'B']) {
      const result = await harness.commands.addActivity(
        envelope(
          {
            scheduleId,
            expectedVersion: version,
            code,
            name: `Activity ${code}`,
            plannedDuration: 3,
          },
          ADD_ACTIVITY_COMMAND,
        ),
        scheduleWriter,
      );
      if (!result.ok) throw new Error(`addActivity failed: ${JSON.stringify(result.error)}`);
      version = result.value.version;
    }
    return scheduleId;
  };

  it('denies baselining to an actor holding only the schedule-write capability', async () => {
    const harness = makeHarness();
    const scheduleId = await addActivities(harness);
    const eventsBefore = harness.sink.events.length;
    const transactionsBefore = harness.store.transactionCount;
    const result = await harness.commands.setBaseline(
      envelope({ scheduleId, expectedVersion: 3 }, SET_BASELINE_COMMAND),
      // Both authorization gates run BEFORE the transaction opens; the
      // second (project-area write) gate rejects the schedule-only actor.
      { policy: FULL_POLICY, capabilities: ['schedule.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
    // A denied command never opens a transaction and never mutates.
    expect(harness.store.transactionCount).toBe(transactionsBefore);
    expect(harness.store.schedules[0]?.currentBaselineId).toBeNull();
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });

  it('denies baselining when the schedule gate alone passes but the project gate is absent', async () => {
    const harness = makeHarness();
    const scheduleId = await addActivities(harness);
    const result = await harness.commands.setBaseline(
      envelope({ scheduleId, expectedVersion: 3 }, SET_BASELINE_COMMAND),
      // The policy grants only the schedule area; the projects.write gate
      // has no matching rule for this actor.
      { policy: SCHEDULE_WRITE_POLICY, capabilities: ['schedule.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(harness.store.schedules[0]?.currentBaselineId).toBeNull();
  });

  it('succeeds with BOTH capabilities while progress needs only the schedule one', async () => {
    const harness = makeHarness();
    const scheduleId = await addActivities(harness);
    const activityId = Object.keys(harness.store.schedules[0]?.activities ?? {})[0];
    if (activityId === undefined) throw new Error('activity missing');

    // Progress recording: the schedule-write capability alone is sufficient.
    const progress = await harness.commands.recordProgress(
      envelope(
        {
          scheduleId,
          activityId,
          expectedVersion: 3,
          percentComplete: 100,
          remainingDuration: 0,
          actualStart: '2026-09-12T10:15:31.000Z',
          actualFinish: '2026-09-13T09:00:00.000Z',
        },
        RECORD_PROGRESS_COMMAND,
      ),
      scheduleWriter,
    );
    expect(progress.ok).toBe(true);

    // Baseline: BOTH gates must pass.
    const baseline = await harness.commands.setBaseline(
      envelope(
        { scheduleId: scheduleId, expectedVersion: 4, label: 'Plan A' },
        SET_BASELINE_COMMAND,
      ),
      baselineWriter,
    );
    expect(baseline.ok).toBe(true);
    if (baseline.ok) {
      expect(baseline.value.currentBaselineId).not.toBeNull();
      expect(Object.keys(baseline.value.baselines)).toHaveLength(1);
    }
  });

  it('an actor with only the project-write capability cannot mutate the schedule', async () => {
    const harness = makeHarness();
    const scheduleId = await createdSchedule(harness);
    const result = await harness.commands.addActivity(
      envelope(
        {
          scheduleId,
          expectedVersion: 1,
          code: 'A',
          name: 'Activity A',
          plannedDuration: 3,
        },
        ADD_ACTIVITY_COMMAND,
      ),
      { policy: PROJECT_WRITE_POLICY, capabilities: ['projects.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(harness.store.schedules[0]?.activities ?? {}).toStrictEqual({});
  });
});

describe('command name constants', () => {
  it('declares the eight mutation command names', () => {
    expect(CREATE_SCHEDULE_COMMAND).toBe('schedule.createSchedule');
    expect(ADD_ACTIVITY_COMMAND).toBe('schedule.addActivity');
    expect(UPDATE_ACTIVITY_COMMAND).toBe('schedule.updateActivity');
    expect(ADD_DEPENDENCY_COMMAND).toBe('schedule.addDependency');
    expect(REMOVE_DEPENDENCY_COMMAND).toBe('schedule.removeDependency');
    expect(ADD_MILESTONE_COMMAND).toBe('schedule.addMilestone');
    expect(SET_BASELINE_COMMAND).toBe('schedule.setBaseline');
    expect(RECORD_PROGRESS_COMMAND).toBe('schedule.recordProgress');
  });
});

// ----- createSchedule scope rules ------------------------------------------------------

describe('createSchedule scope rules (one program of work per project)', () => {
  it('requires a projectId under tenant scope', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createSchedule(
      envelope({ name: 'Unnamed project program' }, CREATE_SCHEDULE_COMMAND, TENANT_A_SCOPE),
      scheduleWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
    }
    expect(harness.store.schedules).toHaveLength(0);
  });

  it('creates under tenant scope with an explicit projectId', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createSchedule(
      envelope(
        { name: 'Riverside program', projectId: PROJECT_ID },
        CREATE_SCHEDULE_COMMAND,
        TENANT_A_SCOPE,
      ),
      scheduleWriter,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scope).toStrictEqual(PROJECT_SCOPE);
    }
  });

  it('rejects a project-scoped create naming a DIFFERENT project (typed unauthorized)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createSchedule(
      envelope(
        { name: 'Foreign program', projectId: OTHER_PROJECT_ID },
        CREATE_SCHEDULE_COMMAND,
        PROJECT_SCOPE,
      ),
      scheduleWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-violation');
    }
    expect(harness.store.schedules).toHaveLength(0);
  });

  it('rejects a SECOND schedule for the same project (one program of work)', async () => {
    const harness = makeHarness();
    await createdSchedule(harness);
    const result = await harness.commands.createSchedule(
      envelope({ name: 'Duplicate program' }, CREATE_SCHEDULE_COMMAND, PROJECT_SCOPE),
      scheduleWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe(
        'schedule-project-has-one-program-of-work',
      );
    }
    expect(harness.store.schedules).toHaveLength(1);
  });
});

// ----- A12 isolation through the scoped store -------------------------------------------

describe('cross-tenant and cross-project isolation (A12)', () => {
  const harnessWithScheduleAndActivity = async (): Promise<Harness> => {
    const harness = makeHarness();
    const scheduleId = await createdSchedule(harness);
    const added = await harness.commands.addActivity(
      envelope(
        {
          scheduleId,
          expectedVersion: 1,
          code: 'A',
          name: 'Activity A',
          plannedDuration: 3,
        },
        ADD_ACTIVITY_COMMAND,
      ),
      scheduleWriter,
    );
    if (!added.ok) throw new Error('addActivity failed');
    return harness;
  };

  it('a foreign tenant sees the schedule as a typed not-found (no existence oracle)', async () => {
    const harness = await harnessWithScheduleAndActivity();
    const scheduleId = harness.store.schedules[0]?.entityId;
    if (scheduleId === undefined) throw new Error('schedule missing');
    const eventsBefore = harness.sink.events.length;
    const result = await harness.commands.addActivity(
      envelope(
        {
          scheduleId,
          expectedVersion: 2,
          code: 'B',
          name: 'Activity B',
          plannedDuration: 2,
        },
        ADD_ACTIVITY_COMMAND,
        TENANT_B_SCOPE,
      ),
      scheduleWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('entity-not-found');
    }
    // The mutation was rolled back: state and event log unchanged.
    expect(harness.store.schedules).toHaveLength(1);
    expect(Object.keys(harness.store.schedules[0]?.activities ?? {})).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });

  it('a foreign project under the same tenant sees the schedule as a typed not-found', async () => {
    const harness = await harnessWithScheduleAndActivity();
    const scheduleId = harness.store.schedules[0]?.entityId;
    if (scheduleId === undefined) throw new Error('schedule missing');
    const result = await harness.commands.recordProgress(
      envelope(
        {
          scheduleId,
          activityId: Object.keys(harness.store.schedules[0]?.activities ?? {})[0],
          expectedVersion: 2,
          percentComplete: 50,
          remainingDuration: 2,
        },
        RECORD_PROGRESS_COMMAND,
        OTHER_PROJECT_SCOPE,
      ),
      scheduleWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    expect(harness.store.schedules[0]?.progressUpdates ?? []).toHaveLength(0);
  });
});

// ----- optimistic concurrency -------------------------------------------------------------

describe('optimistic concurrency (stale versions never overwrite the network)', () => {
  it('rejects a stale expected version with a typed concurrency-conflict', async () => {
    const harness = makeHarness();
    const scheduleId = await createdSchedule(harness);
    const first = await harness.commands.addActivity(
      envelope(
        {
          scheduleId,
          expectedVersion: 1,
          code: 'A',
          name: 'Activity A',
          plannedDuration: 3,
        },
        ADD_ACTIVITY_COMMAND,
      ),
      scheduleWriter,
    );
    if (!first.ok) throw new Error('first addActivity failed');
    const eventsBefore = harness.sink.events.length;

    // A second writer holding the STALE version 1 (the first writer already
    // moved the root to version 2).
    const stale = await harness.commands.addActivity(
      envelope(
        {
          scheduleId,
          expectedVersion: 1,
          code: 'B',
          name: 'Activity B',
          plannedDuration: 2,
        },
        ADD_ACTIVITY_COMMAND,
      ),
      scheduleWriter,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('concurrency-conflict');
      expect(stale.error.details[0]?.code).toBe('stale-aggregate-version');
    }
    // State unchanged; no partial network overwrite; no event appended.
    expect(harness.store.schedules[0]?.version).toBe(2);
    expect(Object.keys(harness.store.schedules[0]?.activities ?? {})).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });

  it('accepts the mutation at the current version after the conflict', async () => {
    const harness = makeHarness();
    const scheduleId = await createdSchedule(harness);
    const retry = await harness.commands.addActivity(
      envelope(
        {
          scheduleId,
          expectedVersion: 1,
          code: 'A',
          name: 'Activity A',
          plannedDuration: 3,
        },
        ADD_ACTIVITY_COMMAND,
      ),
      scheduleWriter,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.version).toBe(2);
  });
});
