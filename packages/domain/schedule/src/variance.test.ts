import { describe, expect, it } from 'vitest';
import { formatEntityId, formatProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, Scope, Timestamp } from '@office/contracts';
import type { Result } from '@office/domain-kernel';
import { scheduleVariance } from './variance';
import {
  addActivityState,
  addDependencyState,
  createScheduleState,
  recordProgressState,
  setBaselineState,
} from './state';
import type { ScheduleState } from './state';

// OFF-010 schedule domain — deterministic current-vs-baseline variance. Both
// sides are recomputed from stored truth (the current network + progress log,
// and the immutable baseline snapshot), so the same state always yields the
// same variance. The baseline itself is read-only here.

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
const BASELINE_1 = id('bas', 1);

const withActivity = (
  state: ScheduleState,
  activityId: EntityId,
  code: string,
  plannedDuration: number,
): ScheduleState =>
  unwrap(
    addActivityState(state, {
      activityId,
      code,
      name: `Activity ${code}`,
      plannedDuration,
      now: NOW_1,
    }),
  );

/** A(3) -FS-> B(2), baselined, then A recorded 100% complete. */
const progressedAgainstBaseline = (): ScheduleState => {
  let state = unwrap(
    createScheduleState(
      { scheduleId: SCHEDULE_ID, name: 'Riverside program', now: NOW_1 },
      SCOPE,
    ),
  );
  state = withActivity(state, ACT_A, 'A', 3);
  state = withActivity(state, ACT_B, 'B', 2);
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
  state = unwrap(setBaselineState(state, { baselineId: BASELINE_1, now: NOW_2 }));
  state = unwrap(
    recordProgressState(state, {
      progressUpdateId: id('prg', 1),
      activityId: ACT_A,
      percentComplete: 100,
      remainingDuration: 0,
      actualStart: NOW_1,
      actualFinish: NOW_2,
      now: NOW_3,
    }),
  );
  return state;
};

describe('scheduleVariance before the first baseline', () => {
  it('carries null baseline fields (no reference established yet)', () => {
    let state = unwrap(
      createScheduleState(
        { scheduleId: SCHEDULE_ID, name: 'Riverside program', now: NOW_1 },
        SCOPE,
      ),
    );
    state = withActivity(state, ACT_A, 'A', 3);
    const variance = unwrap(scheduleVariance(state));
    expect(variance.baselineId).toBeNull();
    expect(variance.baselineSequence).toBeNull();
    expect(variance.baselineProjectDuration).toBeNull();
    expect(variance.projectDurationDelta).toBeNull();
    expect(variance.currentProjectDuration).toBe(3);
    expect(variance.activities).toHaveLength(1);
    const row = variance.activities[0];
    expect(row?.inBaseline).toBe(false);
    expect(row?.baselineDuration).toBeNull();
    expect(row?.durationDelta).toBeNull();
    expect(row?.baselineForecastFinish).toBeNull();
    expect(row?.forecastFinishDelta).toBeNull();
    expect(row?.currentForecastFinish).toBe(3);
  });
});

describe('scheduleVariance against the current baseline', () => {
  it('recomputes both networks and derives per-activity and program deltas', () => {
    const variance = unwrap(scheduleVariance(progressedAgainstBaseline()));
    expect(variance.baselineId).toBe(BASELINE_1);
    expect(variance.baselineSequence).toBe(1);
    // Baseline plan: A(3) finishes day 3, B finishes day 5.
    expect(variance.baselineProjectDuration).toBe(5);
    // Current remaining-work forecast: A done, B finishes day 2.
    expect(variance.currentProjectDuration).toBe(2);
    expect(variance.projectDurationDelta).toBe(-3);

    // Rows sorted by activity code.
    expect(variance.activities.map((row) => row.code)).toStrictEqual(['A', 'B']);
    const a = variance.activities[0];
    expect(a).toMatchObject({
      inBaseline: true,
      baselineDuration: 3,
      currentDuration: 3,
      durationDelta: 0,
      baselineForecastFinish: 3,
      currentForecastFinish: 0,
      forecastFinishDelta: -3,
      percentComplete: 100,
      remainingDuration: 0,
    });
    const b = variance.activities[1];
    expect(b).toMatchObject({
      inBaseline: true,
      baselineDuration: 2,
      currentDuration: 2,
      durationDelta: 0,
      baselineForecastFinish: 5,
      currentForecastFinish: 2,
      forecastFinishDelta: -3,
    });
  });

  it('activities added after the baseline report out-of-baseline with null deltas', () => {
    const state = withActivity(progressedAgainstBaseline(), ACT_C, 'C', 4);
    const variance = unwrap(scheduleVariance(state));
    const c = variance.activities.find((row) => row.code === 'C');
    expect(c).toMatchObject({
      inBaseline: false,
      baselineDuration: null,
      durationDelta: null,
      baselineForecastFinish: null,
      forecastFinishDelta: null,
      currentDuration: 4,
      currentForecastFinish: 4,
    });
    // C now drives the program: 4 days against the baseline's 5.
    expect(variance.currentProjectDuration).toBe(4);
    expect(variance.projectDurationDelta).toBe(-1);
  });

  it('is deterministic: the same state yields the same variance on every call', () => {
    const state = progressedAgainstBaseline();
    expect(unwrap(scheduleVariance(state))).toStrictEqual(unwrap(scheduleVariance(state)));
  });
});
