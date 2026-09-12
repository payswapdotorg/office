import { describe, expect, it } from 'vitest';
import { formatEntityId, formatProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  addActivityState,
  addDependencyState,
  addMilestoneState,
  createScheduleState,
  latestProgressByActivity,
  latestProgressFor,
  recordProgressState,
  removeBaselineState,
  removeDependencyState,
  setBaselineState,
  updateActivityState,
  updateBaselineState,
} from './state';
import type { ScheduleState } from './state';

// OFF-010 schedule domain — aggregate state, invariants, and pure network
// transitions. Everything is deterministic: fixed canonical ids, fixed
// timestamps, no I/O. The dependency-graph validation gate (cycles,
// self-links, missing references, duplicates), the baseline protection
// guards, and the append-only progress log are the acceptance surface under
// test here.

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));

const id = (prefix: string, n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

const SCHEDULE_ID = id('sch', 1);
const ACT_A = id('act', 1);
const ACT_B = id('act', 2);
const ACT_C = id('act', 3);
const DEP_1 = id('dep', 1);
const DEP_2 = id('dep', 2);
const DEP_3 = id('dep', 3);
const MILESTONE_1 = id('mil', 1);
const BASELINE_1 = id('bas', 1);
const BASELINE_2 = id('bas', 2);
const PROGRESS_1 = id('prg', 1);
const PROGRESS_2 = id('prg', 2);

const schedule = (): ScheduleState =>
  unwrap(
    createScheduleState(
      { scheduleId: SCHEDULE_ID, name: 'Riverside program of work', now: NOW_1 },
      SCOPE,
    ),
  );

const withActivity = (
  state: ScheduleState,
  activityId: EntityId,
  code: string,
  plannedDuration = 3,
  now: Timestamp = NOW_1,
): ScheduleState =>
  unwrap(
    addActivityState(state, {
      activityId,
      code,
      name: `Activity ${code}`,
      plannedDuration,
      now,
    }),
  );

const chain = (): ScheduleState => {
  let state = schedule();
  state = withActivity(state, ACT_A, 'A', 3);
  state = withActivity(state, ACT_B, 'B', 2);
  state = withActivity(state, ACT_C, 'C', 4);
  return state;
};

const withDependency = (
  state: ScheduleState,
  dependencyId: EntityId,
  predecessorId: EntityId,
  successorId: EntityId,
  linkType: 'FS' | 'SS' | 'FF' | 'SF' = 'FS',
  lagDays = 0,
  now: Timestamp = NOW_2,
): ScheduleState =>
  unwrap(
    addDependencyState(state, {
      dependencyId,
      predecessorId,
      successorId,
      linkType,
      lagDays,
      now,
    }),
  );

// ----- schedule root ----------------------------------------------------------------

describe('schedule state creation', () => {
  it('creates an empty network at version 1 owning its project scope', () => {
    const state = schedule();
    expect(state.entityId).toBe(SCHEDULE_ID);
    expect(state.scope).toStrictEqual(SCOPE);
    expect(state.version).toBe(INITIAL_AGGREGATE_VERSION);
    expect(state.name).toBe('Riverside program of work');
    expect(state.activities).toStrictEqual({});
    expect(state.dependencies).toStrictEqual({});
    expect(state.milestones).toStrictEqual({});
    expect(state.baselines).toStrictEqual({});
    expect(state.currentBaselineId).toBeNull();
    expect(state.progressUpdates).toStrictEqual([]);
    expect(state.createdAt).toBe(NOW_1);
    expect(state.updatedAt).toBe(NOW_1);
  });

  it('rejects a tenant scope (a schedule is owned by exactly one project, A12)', () => {
    const result = createScheduleState(
      { scheduleId: SCHEDULE_ID, name: 'Orphan', now: NOW_1 },
      { kind: 'tenant', tenantId: TENANT_A },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('schedule-is-project-scoped');
    }
  });

  it('rejects an empty name (invariant backstop behind the parse layer)', () => {
    const result = createScheduleState(
      { scheduleId: SCHEDULE_ID, name: '', now: NOW_1 },
      SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('schedule-name-nonempty');
  });
});

// ----- activities -------------------------------------------------------------------

describe('addActivity transition', () => {
  it('adds an activity and bumps the ROOT version (whole-network concurrency)', () => {
    const next = withActivity(schedule(), ACT_A, 'A', 5);
    expect(Object.keys(next.activities)).toStrictEqual([ACT_A]);
    expect(next.activities[ACT_A]?.code).toBe('A');
    expect(next.activities[ACT_A]?.plannedDuration).toBe(5);
    expect(next.activities[ACT_A]?.parentActivityId).toBeNull();
    expect(next.version).toBe(2);
    expect(next.scope).toStrictEqual(SCOPE);
  });

  it('supports the WBS-ish hierarchy within the project', () => {
    let state = withActivity(schedule(), ACT_A, 'A');
    state = withActivity(state, ACT_B, 'B', 2);
    const nested = unwrap(
      addActivityState(state, {
        activityId: ACT_C,
        code: 'C',
        name: 'Child of A',
        plannedDuration: 1,
        parentActivityId: ACT_A,
        now: NOW_2,
      }),
    );
    expect(nested.activities[ACT_C]?.parentActivityId).toBe(ACT_A);
    expect(nested.version).toBe(4);
  });

  it('rejects a duplicate activity code (typed, state untouched)', () => {
    const state = withActivity(schedule(), ACT_A, 'A');
    const result = addActivityState(state, {
      activityId: ACT_B,
      code: 'A',
      name: 'Duplicate',
      plannedDuration: 2,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('schedule-activity-codes-unique');
    }
    expect(state.activities[ACT_B]).toBeUndefined();
    expect(state.version).toBe(2);
  });

  it('rejects an unknown WBS parent', () => {
    const result = addActivityState(schedule(), {
      activityId: ACT_A,
      code: 'A',
      name: 'Orphan child',
      plannedDuration: 2,
      parentActivityId: ACT_B,
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-activity-parent-exists');
    }
  });

  it('rejects an activity as its own parent', () => {
    const result = addActivityState(schedule(), {
      activityId: ACT_A,
      code: 'A',
      name: 'Self parent',
      plannedDuration: 2,
      parentActivityId: ACT_A,
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-activity-parent-not-self');
    }
  });

  it('rejects a non-positive planned duration through the invariant backstop', () => {
    const result = addActivityState(schedule(), {
      activityId: ACT_A,
      code: 'A',
      name: 'Zero duration',
      plannedDuration: 0,
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
    }
  });
});

describe('updateActivity transition', () => {
  it('updates the current plan with a version bump (baselines untouched)', () => {
    const state = withActivity(schedule(), ACT_A, 'A', 3);
    const next = unwrap(
      updateActivityState(state, ACT_A, { plannedDuration: 7, name: 'A revised' }, NOW_2),
    );
    expect(next.activities[ACT_A]?.plannedDuration).toBe(7);
    expect(next.activities[ACT_A]?.name).toBe('A revised');
    expect(next.activities[ACT_A]?.updatedAt).toBe(NOW_2);
    expect(next.version).toBe(3);
    expect(state.activities[ACT_A]?.plannedDuration).toBe(3);
  });

  it('rejects an unknown activity with a typed not-found', () => {
    const result = updateActivityState(schedule(), ACT_A, { name: 'Ghost' }, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('rejects a WBS parent change that would create a hierarchy cycle', () => {
    // B is a child of A; re-parenting A under B closes the parent cycle.
    let state = withActivity(schedule(), ACT_A, 'A');
    state = unwrap(
      addActivityState(state, {
        activityId: ACT_B,
        code: 'B',
        name: 'Child of A',
        plannedDuration: 2,
        parentActivityId: ACT_A,
        now: NOW_1,
      }),
    );
    const result = updateActivityState(state, ACT_A, { parentActivityId: ACT_B }, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-activity-parent-acyclic');
    }
  });

  it('rejects a code change that collides with another activity', () => {
    let state = withActivity(schedule(), ACT_A, 'A');
    state = withActivity(state, ACT_B, 'B', 2);
    const result = updateActivityState(state, ACT_B, { code: 'A' }, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-activity-codes-unique');
    }
  });
});

// ----- THE dependency-graph validation gate -------------------------------------------

describe('addDependency transition (the dependency-graph gate)', () => {
  it('adds a typed link with lag and bumps the root version', () => {
    const state = chain();
    const next = withDependency(state, DEP_1, ACT_A, ACT_B, 'FS', 2);
    expect(Object.keys(next.dependencies)).toStrictEqual([DEP_1]);
    expect(next.dependencies[DEP_1]?.linkType).toBe('FS');
    expect(next.dependencies[DEP_1]?.lagDays).toBe(2);
    expect(next.version).toBe(5);
    expect(next.activities).toStrictEqual(state.activities);
  });

  it('rejects a dependency on a missing predecessor', () => {
    const result = addDependencyState(chain(), {
      dependencyId: DEP_1,
      predecessorId: id('act', 99),
      successorId: ACT_B,
      linkType: 'FS',
      lagDays: 0,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('schedule-dependency-predecessor-exists');
    }
  });

  it('rejects a dependency on a missing successor', () => {
    const result = addDependencyState(chain(), {
      dependencyId: DEP_1,
      predecessorId: ACT_A,
      successorId: id('act', 99),
      linkType: 'FS',
      lagDays: 0,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-dependency-successor-exists');
    }
  });

  it('rejects a self-dependency', () => {
    const result = addDependencyState(chain(), {
      dependencyId: DEP_1,
      predecessorId: ACT_A,
      successorId: ACT_A,
      linkType: 'FS',
      lagDays: 0,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-dependency-no-self-reference');
    }
  });

  it('rejects a duplicate link (same pair + type)', () => {
    const state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    const result = addDependencyState(state, {
      dependencyId: DEP_2,
      predecessorId: ACT_A,
      successorId: ACT_B,
      linkType: 'FS',
      lagDays: 5,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-dependency-no-duplicates');
    }
  });

  it('allows the same pair with a different link type (distinct semantics)', () => {
    const state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    const next = withDependency(state, DEP_2, ACT_A, ACT_B, 'SS');
    expect(Object.keys(next.dependencies)).toStrictEqual([DEP_1, DEP_2]);
  });

  it('rejects the link that closes a two-activity cycle, leaving the network unchanged', () => {
    const state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    const snapshot = structuredClone(state);
    const result = addDependencyState(state, {
      dependencyId: DEP_2,
      predecessorId: ACT_B,
      successorId: ACT_A,
      linkType: 'FS',
      lagDays: 0,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('schedule-dependency-graph-acyclic');
    }
    // The mutation is total-failure: the input network is bit-identical.
    expect(state).toStrictEqual(snapshot);
  });

  it('rejects the link that closes a three-activity cycle over mixed link types', () => {
    let state = chain();
    state = withDependency(state, DEP_1, ACT_A, ACT_B, 'FS');
    state = withDependency(state, DEP_2, ACT_B, ACT_C, 'SS');
    const snapshot = structuredClone(state);
    const result = addDependencyState(state, {
      dependencyId: DEP_3,
      predecessorId: ACT_C,
      successorId: ACT_A,
      linkType: 'FF',
      lagDays: 0,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-dependency-graph-acyclic');
    }
    expect(state).toStrictEqual(snapshot);
  });
});

describe('removeDependency transition (the only removable entity)', () => {
  it('removes an existing link and bumps the root version', () => {
    const state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    const next = unwrap(removeDependencyState(state, DEP_1, NOW_2));
    expect(next.dependencies).toStrictEqual({});
    expect(next.version).toBe(6);
    expect(next.activities).toStrictEqual(state.activities);
  });

  it('rejects an unknown dependency id with a typed not-found', () => {
    const result = removeDependencyState(chain(), DEP_1, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('keeps the network consistent: the same link can be re-modeled after removal', () => {
    const state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    const removed = unwrap(removeDependencyState(state, DEP_1, NOW_2));
    // Re-adding the identical FS link is legal again (a NEW link entity).
    const readded = withDependency(removed, DEP_2, ACT_A, ACT_B, 'FS');
    expect(Object.keys(readded.dependencies)).toStrictEqual([DEP_2]);
    expect(readded.version).toBe(7);
    // The whole-network invariant set still holds on the re-modeled state.
    const failing = addDependencyState(readded, {
      dependencyId: DEP_3,
      predecessorId: ACT_B,
      successorId: ACT_A,
      linkType: 'FS',
      lagDays: 0,
      now: NOW_3,
    });
    expect(failing.ok).toBe(false);
  });
});

// ----- milestones -------------------------------------------------------------------

describe('addMilestone transition', () => {
  it('adds a zero-duration marker bound to an activity', () => {
    const state = chain();
    const next = unwrap(
      addMilestoneState(state, {
        milestoneId: MILESTONE_1,
        code: 'M-COMPLETE',
        name: 'C complete',
        boundActivityId: ACT_C,
        now: NOW_2,
      }),
    );
    expect(next.milestones[MILESTONE_1]?.code).toBe('M-COMPLETE');
    expect(next.milestones[MILESTONE_1]?.boundActivityId).toBe(ACT_C);
    expect(next.version).toBe(5);
  });

  it('rejects a duplicate milestone code', () => {
    const state = unwrap(
      addMilestoneState(chain(), {
        milestoneId: MILESTONE_1,
        code: 'M-1',
        name: 'First',
        boundActivityId: ACT_A,
        now: NOW_2,
      }),
    );
    const result = addMilestoneState(state, {
      milestoneId: id('mil', 2),
      code: 'M-1',
      name: 'Second',
      boundActivityId: null,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-milestone-codes-unique');
    }
  });

  it('rejects a milestone bound to a missing activity', () => {
    const result = addMilestoneState(chain(), {
      milestoneId: MILESTONE_1,
      code: 'M-GHOST',
      name: 'Ghost',
      boundActivityId: id('act', 99),
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-milestone-activity-exists');
    }
  });
});

// ----- baselines (protected) -----------------------------------------------------------

describe('setBaseline transition', () => {
  it('freezes the current network as an immutable snapshot (sequence 1, no predecessor)', () => {
    const state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    const next = unwrap(
      setBaselineState(state, { baselineId: BASELINE_1, now: NOW_2 }),
    );
    expect(next.currentBaselineId).toBe(BASELINE_1);
    expect(Object.keys(next.baselines)).toStrictEqual([BASELINE_1]);
    const baseline = next.baselines[BASELINE_1];
    expect(baseline?.sequence).toBe(1);
    expect(baseline?.label).toBe('Baseline 1');
    expect(baseline?.supersedes).toBeNull();
    expect(baseline?.snapshot.activities).toHaveLength(3);
    expect(baseline?.snapshot.dependencies).toHaveLength(1);
    expect(baseline?.snapshot.milestones).toHaveLength(0);
    expect(next.version).toBe(6);
  });

  it('re-baselines by APPENDING: dense sequence, backward supersedes chain', () => {
    let state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    state = unwrap(setBaselineState(state, { baselineId: BASELINE_1, now: NOW_2 }));
    const firstSnapshot = structuredClone(state.baselines[BASELINE_1]?.snapshot);
    state = unwrap(
      setBaselineState(state, {
        baselineId: BASELINE_2,
        label: 'Recovery plan',
        now: NOW_3,
      }),
    );
    expect(state.currentBaselineId).toBe(BASELINE_2);
    expect(Object.keys(state.baselines)).toStrictEqual([BASELINE_1, BASELINE_2]);
    expect(state.baselines[BASELINE_2]?.sequence).toBe(2);
    expect(state.baselines[BASELINE_2]?.label).toBe('Recovery plan');
    expect(state.baselines[BASELINE_2]?.supersedes).toBe(BASELINE_1);
    // The superseded baseline is NOT mutated by the re-baseline.
    expect(state.baselines[BASELINE_1]?.snapshot).toStrictEqual(firstSnapshot);
  });

  it('snapshots are isolated deep copies: later plan edits never leak into them', () => {
    let state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    state = unwrap(setBaselineState(state, { baselineId: BASELINE_1, now: NOW_2 }));
    const snapshot = state.baselines[BASELINE_1]?.snapshot;
    state = unwrap(
      updateActivityState(state, ACT_A, { plannedDuration: 99 }, NOW_3),
    );
    expect(state.activities[ACT_A]?.plannedDuration).toBe(99);
    expect(snapshot?.activities.find((a) => a.entityId === ACT_A)?.plannedDuration).toBe(3);
    expect(state.baselines[BASELINE_1]?.snapshot.activities.find((a) => a.entityId === ACT_A)?.plannedDuration).toBe(3);
  });
});

describe('baseline protection guards (baselines are immutable once set)', () => {
  it('editing a baseline is IMPOSSIBLE: typed forbidden, always', () => {
    const state = unwrap(
      setBaselineState(chain(), { baselineId: BASELINE_1, now: NOW_2 }),
    );
    const result = updateBaselineState(state, BASELINE_1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error: DomainError = result.error;
      expect(error.kind).toBe('domain-error');
      expect(error.code).toBe('forbidden');
      expect(error.details[0]?.code).toBe('schedule-baseline-immutable');
    }
  });

  it('deleting a baseline is IMPOSSIBLE: typed forbidden, always', () => {
    const state = unwrap(
      setBaselineState(chain(), { baselineId: BASELINE_1, now: NOW_2 }),
    );
    const result = removeBaselineState(state, BASELINE_1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('schedule-baseline-immutable');
    }
    expect(state.baselines[BASELINE_1]).toBeDefined();
    expect(state.currentBaselineId).toBe(BASELINE_1);
  });
});

// ----- progress (append-only) -----------------------------------------------------------

describe('recordProgress transition', () => {
  it('appends one entry to the log and bumps the root version', () => {
    const state = chain();
    const next = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_1,
        activityId: ACT_A,
        percentComplete: 40,
        remainingDuration: 2,
        actualStart: NOW_2,
        actualFinish: null,
        now: NOW_2,
      }),
    );
    expect(next.progressUpdates).toHaveLength(1);
    expect(next.progressUpdates[0]?.activityId).toBe(ACT_A);
    expect(next.progressUpdates[0]?.percentComplete).toBe(40);
    expect(next.version).toBe(5);
  });

  it('keeps the WHOLE history: entries are appended, never replaced', () => {
    let state = chain();
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_1,
        activityId: ACT_A,
        percentComplete: 40,
        remainingDuration: 2,
        actualStart: NOW_2,
        now: NOW_2,
      }),
    );
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_2,
        activityId: ACT_A,
        percentComplete: 100,
        remainingDuration: 0,
        actualStart: NOW_2,
        actualFinish: NOW_3,
        now: NOW_3,
      }),
    );
    expect(state.progressUpdates.map((entry) => entry.entityId)).toStrictEqual([
      PROGRESS_1,
      PROGRESS_2,
    ]);
  });

  it('rejects progress for a missing activity', () => {
    const result = recordProgressState(chain(), {
      progressUpdateId: PROGRESS_1,
      activityId: id('act', 99),
      percentComplete: 10,
      remainingDuration: 3,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-progress-activity-exists');
    }
  });

  it('rejects inconsistent completion semantics (remaining must be zero exactly when complete)', () => {
    const result = recordProgressState(chain(), {
      progressUpdateId: PROGRESS_1,
      activityId: ACT_A,
      percentComplete: 100,
      remainingDuration: 2,
      actualStart: NOW_2,
      actualFinish: NOW_3,
      now: NOW_3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-progress-completion-consistency');
    }
  });

  it('rejects an actual finish while work is incomplete', () => {
    const result = recordProgressState(chain(), {
      progressUpdateId: PROGRESS_1,
      activityId: ACT_A,
      percentComplete: 50,
      remainingDuration: 2,
      actualStart: NOW_2,
      actualFinish: NOW_3,
      now: NOW_3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe(
        'schedule-progress-finish-pairs-with-completion',
      );
    }
  });

  it('rejects an actual finish without an actual start', () => {
    const result = recordProgressState(chain(), {
      progressUpdateId: PROGRESS_1,
      activityId: ACT_A,
      percentComplete: 100,
      remainingDuration: 0,
      actualStart: null,
      actualFinish: NOW_3,
      now: NOW_3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-progress-finish-requires-start');
    }
  });

  it('rejects an actual finish earlier than its actual start', () => {
    const result = recordProgressState(chain(), {
      progressUpdateId: PROGRESS_1,
      activityId: ACT_A,
      percentComplete: 100,
      remainingDuration: 0,
      actualStart: NOW_3,
      actualFinish: NOW_2,
      now: NOW_3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-progress-actual-dates-ordered');
    }
  });

  it('rejects an out-of-range percent through the invariant backstop', () => {
    const result = recordProgressState(chain(), {
      progressUpdateId: PROGRESS_1,
      activityId: ACT_A,
      percentComplete: 150,
      remainingDuration: 5,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('schedule-progress-log-consistent');
    }
  });

  it('progress updates NEVER mutate a baseline: snapshots stay bit-identical', () => {
    let state = withDependency(chain(), DEP_1, ACT_A, ACT_B, 'FS');
    state = unwrap(setBaselineState(state, { baselineId: BASELINE_1, now: NOW_2 }));
    const snapshot = structuredClone(state.baselines[BASELINE_1]?.snapshot);
    const baselineBefore = structuredClone(state.baselines[BASELINE_1]);
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_1,
        activityId: ACT_A,
        percentComplete: 100,
        remainingDuration: 0,
        actualStart: NOW_2,
        actualFinish: NOW_3,
        now: NOW_3,
      }),
    );
    state = unwrap(
      updateActivityState(state, ACT_C, { plannedDuration: 8 }, NOW_3),
    );
    expect(state.baselines[BASELINE_1]?.snapshot).toStrictEqual(snapshot);
    expect(state.baselines[BASELINE_1]).toStrictEqual(baselineBefore);
    expect(state.progressUpdates).toHaveLength(1);
  });
});

// ----- derived progress reads -----------------------------------------------------------

describe('derived progress reads', () => {
  it('latestProgressFor returns the LAST entry for an activity', () => {
    let state = chain();
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_1,
        activityId: ACT_A,
        percentComplete: 40,
        remainingDuration: 2,
        now: NOW_2,
      }),
    );
    expect(latestProgressFor(state, ACT_A)?.percentComplete).toBe(40);
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_2,
        activityId: ACT_A,
        percentComplete: 80,
        remainingDuration: 1,
        now: NOW_3,
      }),
    );
    expect(latestProgressFor(state, ACT_A)?.percentComplete).toBe(80);
    expect(latestProgressFor(state, ACT_A)?.entityId).toBe(PROGRESS_2);
    expect(latestProgressFor(state, ACT_B)).toBeNull();
  });

  it('latestProgressByActivity collapses the log to the current view', () => {
    let state = chain();
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_1,
        activityId: ACT_A,
        percentComplete: 40,
        remainingDuration: 2,
        now: NOW_2,
      }),
    );
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: PROGRESS_2,
        activityId: ACT_A,
        percentComplete: 100,
        remainingDuration: 0,
        actualStart: NOW_2,
        actualFinish: NOW_3,
        now: NOW_3,
      }),
    );
    const view = latestProgressByActivity(state);
    expect(Object.keys(view)).toStrictEqual([ACT_A]);
    expect(view[ACT_A]?.entityId).toBe(PROGRESS_2);
  });
});

// ----- typed failure surface -------------------------------------------------------------

describe('typed failure surface', () => {
  it('transitions return DomainError values, never throw', () => {
    const failure = addDependencyState(chain(), {
      dependencyId: DEP_1,
      predecessorId: ACT_A,
      successorId: ACT_A,
      linkType: 'FS',
      lagDays: 0,
      now: NOW_2,
    });
    if (!failure.ok) {
      const error: DomainError = failure.error;
      expect(error.kind).toBe('domain-error');
      expect(error.code).toBe('invariant-violation');
    } else {
      throw new Error('expected a typed failure');
    }
  });
});
