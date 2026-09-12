import { describe, expect, it } from 'vitest';
import { formatEntityId, formatProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, Scope, Timestamp } from '@office/contracts';
import type { Result } from '@office/domain-kernel';
import { forecastOfBaseline, forecastOfSchedule, forecastSchedule } from './forecast';
import type { ForecastNetworkInput, ScheduleForecast } from './forecast';
import {
  addActivityState,
  addDependencyState,
  addMilestoneState,
  createScheduleState,
  recordProgressState,
  setBaselineState,
} from './state';
import type { ScheduleState } from './state';

// OFF-010 schedule domain — the deterministic CPM forecast engine. The
// forward/backward pass, floats, the critical path and milestone days are a
// PURE function of (activities, dependencies, progress): the same input
// yields the same forecast on every run (proven by running twice, and by
// shuffling the input arrays). Successor dates derive from predecessors +
// durations + link semantics + lag — the network drives the timeline.

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

const id = (prefix: string, n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

const SCHEDULE_ID = id('sch', 1);
const ACT_A = id('act', 1);
const ACT_B = id('act', 2);
const ACT_C = id('act', 3);
const DEP_1 = id('dep', 1);
const MILESTONE_1 = id('mil', 1);
const MILESTONE_2 = id('mil', 2);
const BASELINE_1 = id('bas', 1);

const activity = (activityId: EntityId, code: string, plannedDuration: number) => ({
  activityId,
  code,
  plannedDuration,
});
const dependency = (
  predecessorId: EntityId,
  successorId: EntityId,
  linkType: 'FS' | 'SS' | 'FF' | 'SF' = 'FS',
  lagDays = 0,
) => ({ predecessorId, successorId, linkType, lagDays });

const rowOf = (forecast: ScheduleForecast, code: string) => {
  const row = forecast.activities.find((candidate) => candidate.code === code);
  if (row === undefined) throw new Error(`no forecast row for activity '${code}'`);
  return row;
};

const milestoneRowOf = (forecast: ScheduleForecast, code: string) => {
  const row = forecast.milestones.find((candidate) => candidate.code === code);
  if ( row === undefined) throw new Error(`no forecast row for milestone '${code}'`);
  return row;
};

// ----- the pass -----------------------------------------------------------------------

describe('forecastSchedule: forward/backward pass over the network', () => {
  it('forecasts an empty network as a zero-duration program', () => {
    const forecast = unwrap(forecastSchedule({ activities: [], dependencies: [] }));
    expect(forecast.projectDuration).toBe(0);
    expect(forecast.activities).toStrictEqual([]);
    expect(forecast.milestones).toStrictEqual([]);
    expect(forecast.criticalPath).toStrictEqual([]);
  });

  it('forecasts a single activity: early/late coincide, zero float, critical', () => {
    const forecast = unwrap(
      forecastSchedule({ activities: [activity(ACT_A, 'A', 5)], dependencies: [] }),
    );
    expect(forecast.projectDuration).toBe(5);
    const row = rowOf(forecast, 'A');
    expect(row.earlyStart).toBe(0);
    expect(row.earlyFinish).toBe(5);
    expect(row.lateStart).toBe(0);
    expect(row.lateFinish).toBe(5);
    expect(row.totalFloat).toBe(0);
    expect(row.critical).toBe(true);
    expect(forecast.criticalPath).toStrictEqual([ACT_A]);
  });

  it('forecasts a multi-activity chain with the known critical path A -> B -> C', () => {
    const forecast = unwrap(
      forecastSchedule({
        activities: [
          activity(ACT_A, 'A', 3),
          activity(ACT_B, 'B', 2),
          activity(ACT_C, 'C', 4),
        ],
        dependencies: [
          dependency(ACT_A, ACT_B, 'FS'),
          dependency(ACT_B, ACT_C, 'FS'),
        ],
      }),
    );
    expect(forecast.projectDuration).toBe(9);
    // Successor dates derive from predecessors + durations.
    expect(rowOf(forecast, 'A')).toMatchObject({
      earlyStart: 0,
      earlyFinish: 3,
      lateStart: 0,
      lateFinish: 3,
      totalFloat: 0,
      critical: true,
    });
    expect(rowOf(forecast, 'B')).toMatchObject({
      earlyStart: 3,
      earlyFinish: 5,
      lateStart: 3,
      lateFinish: 5,
      totalFloat: 0,
      critical: true,
    });
    expect(rowOf(forecast, 'C')).toMatchObject({
      earlyStart: 5,
      earlyFinish: 9,
      lateStart: 5,
      lateFinish: 9,
      totalFloat: 0,
      critical: true,
    });
    expect(forecast.criticalPath).toStrictEqual([ACT_A, ACT_B, ACT_C]);
  });

  it('picks the driving branch as the critical path; the parallel branch floats', () => {
    const forecast = unwrap(
      forecastSchedule({
        activities: [
          activity(ACT_A, 'A', 3),
          activity(ACT_B, 'B', 2),
          activity(ACT_C, 'C', 7),
        ],
        dependencies: [
          dependency(ACT_A, ACT_B, 'FS'),
          dependency(ACT_A, ACT_C, 'FS'),
        ],
      }),
    );
    expect(forecast.projectDuration).toBe(10);
    expect(rowOf(forecast, 'B')).toMatchObject({
      earlyStart: 3,
      earlyFinish: 5,
      totalFloat: 5,
      critical: false,
    });
    expect(rowOf(forecast, 'C')).toMatchObject({
      earlyStart: 3,
      earlyFinish: 10,
      totalFloat: 0,
      critical: true,
    });
    expect(forecast.criticalPath).toStrictEqual([ACT_A, ACT_C]);
  });

  it('applies positive and negative FS lag between predecessor and successor', () => {
    const pushed = unwrap(
      forecastSchedule({
        activities: [activity(ACT_A, 'A', 3), activity(ACT_B, 'B', 2)],
        dependencies: [dependency(ACT_A, ACT_B, 'FS', 2)],
      }),
    );
    expect(rowOf(pushed, 'B').earlyStart).toBe(5);
    expect(pushed.projectDuration).toBe(7);

    const pulled = unwrap(
      forecastSchedule({
        activities: [activity(ACT_A, 'A', 3), activity(ACT_B, 'B', 2)],
        dependencies: [dependency(ACT_A, ACT_B, 'FS', -1)],
      }),
    );
    expect(rowOf(pulled, 'B').earlyStart).toBe(2);
    expect(pulled.projectDuration).toBe(4);
  });

  it('applies SS, FF and SF link semantics as start bounds on the successor', () => {
    const ss = unwrap(
      forecastSchedule({
        activities: [activity(ACT_A, 'A', 3), activity(ACT_B, 'B', 2)],
        dependencies: [dependency(ACT_A, ACT_B, 'SS', 1)],
      }),
    );
    // ES(B) >= ES(A) + lag = 1.
    expect(rowOf(ss, 'B').earlyStart).toBe(1);
    expect(rowOf(ss, 'B').earlyFinish).toBe(3);

    const ff = unwrap(
      forecastSchedule({
        activities: [activity(ACT_A, 'A', 3), activity(ACT_B, 'B', 2)],
        dependencies: [dependency(ACT_A, ACT_B, 'FF', 0)],
      }),
    );
    // EF(B) >= EF(A) ⟺ ES(B) >= EF(A) - d(B) = 1.
    expect(rowOf(ff, 'B').earlyStart).toBe(1);
    expect(rowOf(ff, 'B').earlyFinish).toBe(3);

    const sf = unwrap(
      forecastSchedule({
        activities: [activity(ACT_A, 'A', 3), activity(ACT_B, 'B', 2)],
        dependencies: [dependency(ACT_A, ACT_B, 'SF', 0)],
      }),
    );
    // EF(B) >= ES(A) ⟺ ES(B) >= ES(A) - d(B) = -2, floored at the origin.
    expect(rowOf(sf, 'B').earlyStart).toBe(0);
    expect(rowOf(sf, 'B').earlyFinish).toBe(2);
  });
});

// ----- progress semantics (the remaining-work model) ------------------------------------

describe('forecastSchedule: recorded progress drives the remaining work', () => {
  it('a completed activity contributes zero duration; successors start at its finish', () => {
    const forecast = unwrap(
      forecastSchedule({
        activities: [activity(ACT_A, 'A', 5), activity(ACT_B, 'B', 3)],
        dependencies: [dependency(ACT_A, ACT_B, 'FS')],
        progress: [
          { activityId: ACT_A, percentComplete: 100, remainingDuration: 0 },
        ],
      }),
    );
    expect(rowOf(forecast, 'A')).toMatchObject({
      duration: 0,
      percentComplete: 100,
      remainingDuration: 0,
      earlyStart: 0,
      earlyFinish: 0,
    });
    expect(rowOf(forecast, 'B')).toMatchObject({ earlyStart: 0, earlyFinish: 3 });
    expect(forecast.projectDuration).toBe(3);
  });

  it('a partially complete activity contributes only its remaining duration', () => {
    const forecast = unwrap(
      forecastSchedule({
        activities: [activity(ACT_A, 'A', 5), activity(ACT_B, 'B', 3)],
        dependencies: [dependency(ACT_A, ACT_B, 'FS')],
        progress: [
          { activityId: ACT_A, percentComplete: 40, remainingDuration: 3 },
        ],
      }),
    );
    expect(rowOf(forecast, 'A')).toMatchObject({
      duration: 3,
      percentComplete: 40,
      remainingDuration: 3,
      earlyFinish: 3,
    });
    expect(rowOf(forecast, 'B').earlyStart).toBe(3);
    expect(forecast.projectDuration).toBe(6);
  });
});

// ----- determinism (acceptance gate) ----------------------------------------------------

describe('forecastSchedule is deterministic', () => {
  const network = (): ForecastNetworkInput => ({
    activities: [
      activity(ACT_A, 'A', 3),
      activity(ACT_B, 'B', 2),
      activity(ACT_C, 'C', 4),
    ],
    dependencies: [
      dependency(ACT_A, ACT_B, 'FS'),
      dependency(ACT_B, ACT_C, 'FS', 1),
    ],
    progress: [{ activityId: ACT_B, percentComplete: 50, remainingDuration: 1 }],
    milestones: [
      { milestoneId: MILESTONE_1, code: 'M-C', boundActivityId: ACT_C },
      { milestoneId: MILESTONE_2, code: 'M-PROJ', boundActivityId: null },
    ],
  });

  it('the same network + progress yields the identical forecast on every run', () => {
    const first = unwrap(forecastSchedule(network()));
    const second = unwrap(forecastSchedule(network()));
    expect(first).toStrictEqual(second);
    expect(first.criticalPath).toStrictEqual(second.criticalPath);
  });

  it('the forecast is independent of input array ordering', () => {
    const input = network();
    const shuffled: ForecastNetworkInput = {
      activities: [...input.activities].reverse(),
      dependencies: [...input.dependencies].reverse(),
      progress: [...(input.progress ?? [])].reverse(),
      milestones: [...(input.milestones ?? [])].reverse(),
    };
    expect(unwrap(forecastSchedule(shuffled))).toStrictEqual(
      unwrap(forecastSchedule(input)),
    );
  });
});

// ----- milestones -----------------------------------------------------------------------

describe('forecastSchedule: milestone achievement is derived, forecast days deterministic', () => {
  it('a bound milestone forecasts its bound activity finish; an unbound one the project finish', () => {
    const forecast = unwrap(
      forecastSchedule({
        activities: [
          activity(ACT_A, 'A', 3),
          activity(ACT_B, 'B', 2),
          activity(ACT_C, 'C', 4),
        ],
        dependencies: [dependency(ACT_A, ACT_B, 'FS'), dependency(ACT_B, ACT_C, 'FS')],
        milestones: [
          { milestoneId: MILESTONE_1, code: 'M-C', boundActivityId: ACT_C },
          { milestoneId: MILESTONE_2, code: 'M-PROJ', boundActivityId: null },
        ],
      }),
    );
    expect(milestoneRowOf(forecast, 'M-C')).toMatchObject({
      boundActivityId: ACT_C,
      forecastDay: 9,
      achieved: false,
    });
    expect(milestoneRowOf(forecast, 'M-PROJ')).toMatchObject({
      boundActivityId: null,
      forecastDay: 9,
      achieved: false,
    });
  });

  it('a bound milestone flips to achieved exactly when its activity records 100%', () => {
    const forecast = unwrap(
      forecastSchedule({
        activities: [activity(ACT_C, 'C', 4)],
        dependencies: [],
        milestones: [{ milestoneId: MILESTONE_1, code: 'M-C', boundActivityId: ACT_C }],
        progress: [{ activityId: ACT_C, percentComplete: 100, remainingDuration: 0 }],
      }),
    );
    expect(milestoneRowOf(forecast, 'M-C').achieved).toBe(true);
  });
});

// ----- fail-closed validation -------------------------------------------------------------

describe('forecastSchedule input validation (fail-closed)', () => {
  it('rejects a cyclic network (no forward pass exists)', () => {
    const result = forecastSchedule({
      activities: [activity(ACT_A, 'A', 1), activity(ACT_B, 'B', 1)],
      dependencies: [
        dependency(ACT_A, ACT_B, 'FS'),
        dependency(ACT_B, ACT_A, 'SS'),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('forecast-network-acyclic');
    }
  });

  it('rejects a dependency referencing an unknown activity', () => {
    const result = forecastSchedule({
      activities: [activity(ACT_A, 'A', 1)],
      dependencies: [dependency(ACT_A, ACT_B, 'FS')],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('forecast-dependency-references-activity');
    }
  });

  it('rejects a self-dependency', () => {
    const result = forecastSchedule({
      activities: [activity(ACT_A, 'A', 1)],
      dependencies: [dependency(ACT_A, ACT_A, 'FS')],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('forecast-dependency-no-self-reference');
    }
  });

  it('rejects a duplicate link', () => {
    const result = forecastSchedule({
      activities: [activity(ACT_A, 'A', 1), activity(ACT_B, 'B', 1)],
      dependencies: [
        dependency(ACT_A, ACT_B, 'FS'),
        dependency(ACT_A, ACT_B, 'FS'),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('forecast-dependency-no-duplicates');
    }
  });

  it('rejects duplicate activity ids and duplicate activity codes', () => {
    const byId = forecastSchedule({
      activities: [activity(ACT_A, 'A', 1), activity(ACT_A, 'B', 1)],
      dependencies: [],
    });
    expect(byId.ok).toBe(false);
    if (!byId.ok) {
      expect(byId.error.details[0]?.code).toBe('forecast-activity-ids-unique');
    }
    const byCode = forecastSchedule({
      activities: [activity(ACT_A, 'A', 1), activity(ACT_B, 'A', 1)],
      dependencies: [],
    });
    expect(byCode.ok).toBe(false);
    if (!byCode.ok) {
      expect(byCode.error.details[0]?.code).toBe('forecast-activity-codes-unique');
    }
  });

  it('rejects a non-positive planned duration', () => {
    const result = forecastSchedule({
      activities: [activity(ACT_A, 'A', 0)],
      dependencies: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('forecast-activity-duration-bounded');
    }
  });

  it('rejects progress for an unknown activity, duplicated progress, and inconsistent progress', () => {
    const unknown = forecastSchedule({
      activities: [activity(ACT_A, 'A', 2)],
      dependencies: [],
      progress: [{ activityId: ACT_B, percentComplete: 10, remainingDuration: 2 }],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.details[0]?.code).toBe('forecast-progress-references-activity');
    }

    const duplicated = forecastSchedule({
      activities: [activity(ACT_A, 'A', 2)],
      dependencies: [],
      progress: [
        { activityId: ACT_A, percentComplete: 10, remainingDuration: 2 },
        { activityId: ACT_A, percentComplete: 20, remainingDuration: 1 },
      ],
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error.details[0]?.code).toBe('forecast-progress-unique-per-activity');
    }

    const inconsistent = forecastSchedule({
      activities: [activity(ACT_A, 'A', 2)],
      dependencies: [],
      progress: [{ activityId: ACT_A, percentComplete: 100, remainingDuration: 1 }],
    });
    expect(inconsistent.ok).toBe(false);
    if (!inconsistent.ok) {
      expect(inconsistent.error.details[0]?.code).toBe('forecast-progress-consistent');
    }
  });

  it('rejects a milestone bound to an unknown activity', () => {
    const result = forecastSchedule({
      activities: [activity(ACT_A, 'A', 2)],
      dependencies: [],
      milestones: [{ milestoneId: MILESTONE_1, code: 'M', boundActivityId: ACT_B }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('forecast-milestone-references-activity');
    }
  });
});

// ----- derived reads over stored state ----------------------------------------------------

describe('forecastOfSchedule and forecastOfBaseline (derived reads)', () => {
  const scheduleWithProgress = (): ScheduleState => {
    let state = unwrap(
      createScheduleState(
        { scheduleId: SCHEDULE_ID, name: 'Riverside program', now: NOW_1 },
        SCOPE,
      ),
    );
    state = unwrap(
      addActivityState(state, {
        activityId: ACT_A,
        code: 'A',
        name: 'A',
        plannedDuration: 5,
        now: NOW_1,
      }),
    );
    state = unwrap(
      addActivityState(state, {
        activityId: ACT_B,
        code: 'B',
        name: 'B',
        plannedDuration: 3,
        now: NOW_1,
      }),
    );
    state = unwrap(
      addDependencyState(state, {
        dependencyId: DEP_1,
        predecessorId: ACT_A,
        successorId: ACT_B,
        linkType: 'FS',
        lagDays: 0,
        now: NOW_1,
      }),
    );
    state = unwrap(
      addMilestoneState(state, {
        milestoneId: MILESTONE_1,
        code: 'M-B',
        name: 'B complete',
        boundActivityId: ACT_B,
        now: NOW_1,
      }),
    );
    // Two log entries for A: only the LATEST drives the forecast.
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: id('prg', 1),
        activityId: ACT_A,
        percentComplete: 40,
        remainingDuration: 3,
        actualStart: NOW_1,
        now: NOW_1,
      }),
    );
    state = unwrap(
      recordProgressState(state, {
        progressUpdateId: id('prg', 2),
        activityId: ACT_A,
        percentComplete: 100,
        remainingDuration: 0,
        actualStart: NOW_1,
        actualFinish: NOW_2,
        now: NOW_2,
      }),
    );
    return state;
  };

  it('forecastOfSchedule recomputes from the current network + LATEST progress', () => {
    const forecast = unwrap(forecastOfSchedule(scheduleWithProgress()));
    expect(rowOf(forecast, 'A')).toMatchObject({
      duration: 0,
      percentComplete: 100,
      earlyFinish: 0,
    });
    expect(rowOf(forecast, 'B').earlyStart).toBe(0);
    expect(rowOf(forecast, 'B').earlyFinish).toBe(3);
    expect(forecast.projectDuration).toBe(3);
    expect(milestoneRowOf(forecast, 'M-B').forecastDay).toBe(3);
  });

  it('forecastOfSchedule is deterministic across repeated reads of the same state', () => {
    const state = scheduleWithProgress();
    expect(unwrap(forecastOfSchedule(state))).toStrictEqual(
      unwrap(forecastOfSchedule(state)),
    );
  });

  it('forecastOfBaseline forecasts the frozen plan progress-free', () => {
    let state = scheduleWithProgress();
    state = unwrap(
      setBaselineState(state, { baselineId: BASELINE_1, now: NOW_2 }),
    );
    const baseline = state.baselines[BASELINE_1];
    if (baseline === undefined) throw new Error('baseline missing');
    // The baseline captured A at its planned duration 5 (progress-free).
    const forecast = unwrap(forecastOfBaseline(baseline));
    expect(rowOf(forecast, 'A')).toMatchObject({
      duration: 5,
      percentComplete: 0,
      earlyFinish: 5,
    });
    expect(rowOf(forecast, 'B').earlyStart).toBe(5);
    expect(forecast.projectDuration).toBe(8);
    expect(unwrap(forecastOfBaseline(baseline))).toStrictEqual(forecast);
  });
});
