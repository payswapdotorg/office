// Office schedule domain — deterministic current-vs-baseline variance (OFF-010).
//
// Comparing the current schedule against the current baseline yields
// deterministic variance data: the margin/impact engine (OFF-014) and the
// control tower consume it. The comparison recomputes BOTH forecasts — the
// current network with its progress (the remaining-work model) and the
// baseline's planned network (progress-free, from the immutable snapshot) —
// and derives the deltas. It is a PURE derived read (freeze A3: projections
// are never stored as truth): same schedule state → same variance, every
// call. The baseline itself is never touched, read-only here.
import type { EntityId } from '@office/contracts';
import { fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { ScheduleState } from './state';
import { forecastOfBaseline, forecastOfSchedule } from './forecast';

/** The per-activity variance of the current plan against the current baseline. */
export interface ActivityVariance {
  readonly activityId: EntityId;
  readonly code: string;
  /** False when the activity was added after the baseline was captured. */
  readonly inBaseline: boolean;
  /** The baseline's planned duration for this activity, or null when not in the baseline. */
  readonly baselineDuration: number | null;
  /** The current planned duration of this activity. */
  readonly currentDuration: number | null;
  /** currentDuration - baselineDuration (positive = work added), or null when not in the baseline. */
  readonly durationDelta: number | null;
  /** The baseline network's forecast finish day for this activity, or null when not in the baseline. */
  readonly baselineForecastFinish: number | null;
  /** The current forecast finish day for this activity. */
  readonly currentForecastFinish: number | null;
  /** currentForecastFinish - baselineForecastFinish (positive = later), or null when not in the baseline. */
  readonly forecastFinishDelta: number | null;
  /** Current latest percent complete (0 while unstarted). */
  readonly percentComplete: number;
  /** Current latest remaining duration (planned duration while unstarted). */
  readonly remainingDuration: number;
}

/** The schedule-level variance against the current baseline. */
export interface ScheduleVariance {
  /** The baseline the current schedule is compared against, or null before the first baseline. */
  readonly baselineId: EntityId | null;
  /** The baseline's dense sequence number, or null before the first baseline. */
  readonly baselineSequence: number | null;
  /** The baseline network's forecast project duration, or null before the first baseline. */
  readonly baselineProjectDuration: number | null;
  /** The current forecast project duration. */
  readonly currentProjectDuration: number;
  /** currentProjectDuration - baselineProjectDuration (positive = program extends), or null before the first baseline. */
  readonly projectDurationDelta: number | null;
  /** Per-activity variances, sorted by activity code. */
  readonly activities: readonly ActivityVariance[];
}

/**
 * Compute the deterministic current-vs-baseline variance of a schedule.
 * Before the first baseline the variance carries null baseline fields (no
 * reference has been established yet). With a baseline set, both networks
 * are re-forecast and compared activity by activity (by canonical id);
 * activities added after the baseline report inBaseline=false with null
 * baseline-side fields. Activities are never removed from a schedule, so
 * every baseline activity has a current counterpart.
 */
export function scheduleVariance(
  state: ScheduleState,
  context?: DomainErrorContext,
): Result<ScheduleVariance, DomainError> {
  const current = forecastOfSchedule(state, context);
  if (!current.ok) return current;

  const currentPlannedDuration = new Map<string, number>();
  for (const activity of Object.values(state.activities)) {
    currentPlannedDuration.set(activity.entityId, activity.plannedDuration);
  }

  if (state.currentBaselineId === null) {
    return ok({
      baselineId: null,
      baselineSequence: null,
      baselineProjectDuration: null,
      currentProjectDuration: current.value.projectDuration,
      projectDurationDelta: null,
      activities: current.value.activities.map(
        (row): ActivityVariance => ({
          activityId: row.activityId,
          code: row.code,
          inBaseline: false,
          baselineDuration: null,
          currentDuration: currentPlannedDuration.get(row.activityId) ?? null,
          durationDelta: null,
          baselineForecastFinish: null,
          currentForecastFinish: row.earlyFinish,
          forecastFinishDelta: null,
          percentComplete: row.percentComplete,
          remainingDuration: row.remainingDuration,
        }),
      ),
    } satisfies ScheduleVariance);
  }

  const baseline = state.baselines[state.currentBaselineId];
  if (baseline === undefined) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-current-baseline-exists',
          statement: `schedule ${state.entityId} names current baseline ${state.currentBaselineId}, which does not exist`,
        },
        context,
      ),
    );
  }

  const baselineForecast = forecastOfBaseline(baseline, context);
  if (!baselineForecast.ok) return baselineForecast;

  const baselineActivities = new Map<
    string,
    { readonly duration: number; readonly finish: number }
  >();
  for (const row of baselineForecast.value.activities) {
    baselineActivities.set(row.activityId, { duration: row.duration, finish: row.earlyFinish });
  }

  const rows: ActivityVariance[] = current.value.activities.map((row): ActivityVariance => {
    const baselineRow = baselineActivities.get(row.activityId);
    const currentDuration = currentPlannedDuration.get(row.activityId) ?? null;
    return {
      activityId: row.activityId,
      code: row.code,
      inBaseline: baselineRow !== undefined,
      baselineDuration: baselineRow?.duration ?? null,
      currentDuration,
      durationDelta:
        baselineRow !== undefined && currentDuration !== null
          ? currentDuration - baselineRow.duration
          : null,
      baselineForecastFinish: baselineRow?.finish ?? null,
      currentForecastFinish: row.earlyFinish,
      forecastFinishDelta:
        baselineRow !== undefined ? row.earlyFinish - baselineRow.finish : null,
      percentComplete: row.percentComplete,
      remainingDuration: row.remainingDuration,
    };
  });
  rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return ok({
    baselineId: baseline.entityId,
    baselineSequence: baseline.sequence,
    baselineProjectDuration: baselineForecast.value.projectDuration,
    currentProjectDuration: current.value.projectDuration,
    projectDurationDelta:
      current.value.projectDuration - baselineForecast.value.projectDuration,
    activities: rows,
  } satisfies ScheduleVariance);
}
