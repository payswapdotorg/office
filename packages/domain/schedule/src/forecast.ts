// Office schedule domain — the deterministic CPM forecast engine (OFF-010).
//
// THE forecast calculation: a PURE deterministic function over the activity
// network (activities + typed dependencies + lag) and the recorded progress.
// It runs the classic critical-path-method forward/backward pass over
// CALENDAR-FREE integer working units (durations are working-day-free at
// this layer — calendars, holidays and working-time mapping are out of
// scope; see README) and produces early/late start/finish day offsets, total
// float, the critical path, and milestone forecast days.
//
// Determinism (acceptance gate): same inputs → same outputs, every run. The
// pass results are max/min reductions (processing-order independent), the
// output collections are sorted canonically (by activity code), and the
// critical-path reconstruction breaks ties deterministically (smallest
// predecessor code, then link type, then lag). No clock, no randomness, no
// stored projections: forecasts are DERIVED READS recomputed on demand
// (freeze A3 — projections are not canonical truth).
//
// Progress semantics (the remaining-work model): an activity's forecast
// duration is its LATEST recorded remaining duration (work still to do);
// an activity with no progress entries contributes its full planned
// duration. Completed activities (100%, zero remaining) contribute zero
// duration — the network still carries their links, so successors of
// finished work start from the forecast origin plus lag constraints.
// The forecast timeline is RELATIVE: day 0 is the forecast origin ("data
// date"); early/late values are day offsets from it, never calendar dates.
import type { EntityId } from '@office/contracts';
import { fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type {
  BaselineState,
  DependencyLinkType,
  ScheduleState,
} from './state';
import { latestProgressByActivity } from './state';

// ----- inputs (plain, reusable over current state AND baseline snapshots) --------

/** One activity of the network to forecast. */
export interface ForecastActivityInput {
  readonly activityId: EntityId;
  readonly code: string;
  /** Planned duration in calendar-free integer working units (>= 1). */
  readonly plannedDuration: number;
}

/** One typed dependency link of the network to forecast. */
export interface ForecastDependencyInput {
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: DependencyLinkType;
  readonly lagDays: number;
}

/** The latest recorded progress of one activity (the derived current view). */
export interface ForecastProgressInput {
  readonly activityId: EntityId;
  /** Percent complete: integer 0..100. */
  readonly percentComplete: number;
  /** Remaining duration: integer working units (zero exactly when complete). */
  readonly remainingDuration: number;
}

/** One milestone marker of the network to forecast. */
export interface ForecastMilestoneInput {
  readonly milestoneId: EntityId;
  readonly code: string;
  /** The activity whose completion achieves this milestone, or null (project-level). */
  readonly boundActivityId: EntityId | null;
}

/** The complete forecast input: (activities + dependencies + progress + milestones). */
export interface ForecastNetworkInput {
  readonly activities: readonly ForecastActivityInput[];
  readonly dependencies: readonly ForecastDependencyInput[];
  readonly progress?: readonly ForecastProgressInput[];
  readonly milestones?: readonly ForecastMilestoneInput[];
}

// ----- outputs --------------------------------------------------------------------

/** The deterministic forecast of one activity. */
export interface ForecastActivity {
  readonly activityId: EntityId;
  readonly code: string;
  /** Forecast duration: latest remaining duration (planned duration while unstarted). */
  readonly duration: number;
  /** Latest recorded percent complete (0 while unstarted). */
  readonly percentComplete: number;
  /** Latest recorded remaining duration (planned duration while unstarted). */
  readonly remainingDuration: number;
  /** Early start: day offset from the forecast origin. */
  readonly earlyStart: number;
  /** Early finish: earlyStart + duration. */
  readonly earlyFinish: number;
  /** Late start: latest day offset that still finishes the network on time. */
  readonly lateStart: number;
  /** Late finish: lateStart + duration. */
  readonly lateFinish: number;
  /** Total float: lateStart - earlyStart (<= 0 counts as critical). */
  readonly totalFloat: number;
  /** True when totalFloat <= 0 (zero float drives the network; negative float is behind). */
  readonly critical: boolean;
}

/** The deterministic forecast of one milestone. */
export interface ForecastMilestone {
  readonly milestoneId: EntityId;
  readonly code: string;
  readonly boundActivityId: EntityId | null;
  /** Forecast achievement day: the bound activity's early finish (project finish when unbound). */
  readonly forecastDay: number;
  /** True when the completion logic is already satisfied (derived from progress). */
  readonly achieved: boolean;
}

/** The complete deterministic forecast of a network. */
export interface ScheduleForecast {
  /** Forecast project duration: the maximum early finish (0 for an empty network). */
  readonly projectDuration: number;
  /** Per-activity forecasts, sorted by activity code. */
  readonly activities: readonly ForecastActivity[];
  /** Per-milestone forecasts, sorted by milestone code. */
  readonly milestones: readonly ForecastMilestone[];
  /**
   * The critical path: the driving chain from the network start to the
   * forecast terminal activity, in forward order. Deterministic tie-breaks
   * (smallest code) pick one chain when parallel branches tie.
   */
  readonly criticalPath: readonly EntityId[];
}

// ----- validation (fail-closed, deterministic) -------------------------------------

const LINK_TYPE_ORDER: readonly DependencyLinkType[] = ['FS', 'FF', 'SF', 'SS'];

const validateNetwork = (
  input: ForecastNetworkInput,
  context?: DomainErrorContext,
): Result<true, DomainError> => {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const activity of input.activities) {
    if (ids.has(activity.activityId)) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-activity-ids-unique',
            statement: `activity id ${activity.activityId} appears more than once in the forecast input`,
          },
          context,
        ),
      );
    }
    if (codes.has(activity.code)) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-activity-codes-unique',
            statement: `activity code '${activity.code}' appears more than once in the forecast input`,
          },
          context,
        ),
      );
    }
    ids.add(activity.activityId);
    codes.add(activity.code);
    if (!Number.isInteger(activity.plannedDuration) || activity.plannedDuration < 1) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-activity-duration-bounded',
            statement: `activity ${activity.activityId} carries a non-positive planned duration ${activity.plannedDuration}`,
          },
          context,
        ),
      );
    }
  }
  const links = new Set<string>();
  for (const dependency of input.dependencies) {
    for (const [label, id] of [
      ['predecessor', dependency.predecessorId],
      ['successor', dependency.successorId],
    ] as const) {
      if (!ids.has(id)) {
        return fail(
          invariantViolation(
            {
              name: 'forecast-dependency-references-activity',
              statement: `the ${dependency.linkType} link names ${label} ${id}, which is not an activity of the forecast input`,
            },
            context,
          ),
        );
      }
    }
    if (dependency.predecessorId === dependency.successorId) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-dependency-no-self-reference',
            statement: `activity ${dependency.predecessorId} cannot depend on itself`,
          },
          context,
        ),
      );
    }
    const link = `${dependency.predecessorId}|${dependency.successorId}|${dependency.linkType}`;
    if (links.has(link)) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-dependency-no-duplicates',
            statement: `the ${dependency.linkType} link ${dependency.predecessorId} -> ${dependency.successorId} appears more than once in the forecast input`,
          },
          context,
        ),
      );
    }
    links.add(link);
  }
  const progressed = new Set<string>();
  for (const entry of input.progress ?? []) {
    if (!ids.has(entry.activityId)) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-progress-references-activity',
            statement: `progress for activity ${entry.activityId}, which is not an activity of the forecast input`,
          },
          context,
        ),
      );
    }
    if (progressed.has(entry.activityId)) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-progress-unique-per-activity',
            statement: `progress for activity ${entry.activityId} appears more than once in the forecast input`,
          },
          context,
        ),
      );
    }
    progressed.add(entry.activityId);
    if (
      !Number.isInteger(entry.percentComplete) ||
      entry.percentComplete < 0 ||
      entry.percentComplete > 100 ||
      !Number.isInteger(entry.remainingDuration) ||
      entry.remainingDuration < 0 ||
      (entry.percentComplete === 100) !== (entry.remainingDuration === 0)
    ) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-progress-consistent',
            statement: `progress for activity ${entry.activityId} is inconsistent (percent complete ${entry.percentComplete}, remaining duration ${entry.remainingDuration})`,
          },
          context,
        ),
      );
    }
  }
  for (const milestone of input.milestones ?? []) {
    if (milestone.boundActivityId !== null && !ids.has(milestone.boundActivityId)) {
      return fail(
        invariantViolation(
          {
            name: 'forecast-milestone-references-activity',
            statement: `milestone ${milestone.milestoneId} is bound to activity ${milestone.boundActivityId}, which is not an activity of the forecast input`,
          },
          context,
        ),
      );
    }
  }
  return ok(true);
};

// ----- the pass ---------------------------------------------------------------------

/**
 * THE deterministic CPM forecast. Pure: same input network + progress → the
 * same early/late day offsets, floats, critical path and milestone days on
 * every call, independent of input array ordering.
 */
export function forecastSchedule(
  input: ForecastNetworkInput,
  context?: DomainErrorContext,
): Result<ScheduleForecast, DomainError> {
  const valid = validateNetwork(input, context);
  if (!valid.ok) return valid;

  // Deterministic working order: activities by code, dependencies by a
  // stable key. (The pass itself is order-independent; canonical order keeps
  // tie-break behavior and debugging deterministic.)
  const activities = [...input.activities].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  const dependencies = [...input.dependencies].sort((a, b) => {
    const byPredecessor =
      a.predecessorId < b.predecessorId ? -1 : a.predecessorId > b.predecessorId ? 1 : 0;
    if (byPredecessor !== 0) return byPredecessor;
    const bySuccessor =
      a.successorId < b.successorId ? -1 : a.successorId > b.successorId ? 1 : 0;
    if (bySuccessor !== 0) return bySuccessor;
    return LINK_TYPE_ORDER.indexOf(a.linkType) - LINK_TYPE_ORDER.indexOf(b.linkType);
  });

  const progressOf = new Map<string, ForecastProgressInput>();
  for (const entry of input.progress ?? []) {
    progressOf.set(entry.activityId, entry);
  }

  // Remaining-work model: forecast duration = latest remaining duration when
  // progress exists, else the full planned duration.
  const durationOf = new Map<string, number>();
  const percentOf = new Map<string, number>();
  for (const activity of activities) {
    const entry = progressOf.get(activity.activityId);
    durationOf.set(activity.activityId, entry?.remainingDuration ?? activity.plannedDuration);
    percentOf.set(activity.activityId, entry?.percentComplete ?? 0);
  }

  // Topological order (Kahn's algorithm over predecessor -> successor edges).
  const successorsOf = new Map<string, string[]>();
  const indegreeOf = new Map<string, number>();
  for (const activity of activities) {
    successorsOf.set(activity.activityId, []);
    indegreeOf.set(activity.activityId, 0);
  }
  for (const dependency of dependencies) {
    const list = successorsOf.get(dependency.predecessorId);
    const degree = indegreeOf.get(dependency.successorId);
    if (list === undefined || degree === undefined) continue;
    list.push(dependency.successorId);
    indegreeOf.set(dependency.successorId, degree + 1);
  }
  const topoOrder: string[] = [];
  const frontier: string[] = activities
    .filter((activity) => (indegreeOf.get(activity.activityId) ?? 0) === 0)
    .map((activity) => activity.activityId);
  while (frontier.length > 0) {
    const current = frontier.shift();
    if (current === undefined) break;
    topoOrder.push(current);
    for (const next of successorsOf.get(current) ?? []) {
      const degree = indegreeOf.get(next);
      if (degree === undefined) continue;
      const reduced = degree - 1;
      indegreeOf.set(next, reduced);
      if (reduced === 0) frontier.push(next);
    }
  }
  if (topoOrder.length !== activities.length) {
    return fail(
      invariantViolation(
        {
          name: 'forecast-network-acyclic',
          statement: 'the forecast input contains a dependency cycle (a deadlock); no forward pass exists',
        },
        context,
      ),
    );
  }

  // Incoming links per successor (for the forward pass and path walking).
  const incomingOf = new Map<string, ForecastDependencyInput[]>();
  for (const activity of activities) incomingOf.set(activity.activityId, []);
  for (const dependency of dependencies) {
    const list = incomingOf.get(dependency.successorId);
    if (list === undefined) continue;
    list.push(dependency);
  }

  // Forward pass: early start/finish day offsets.
  // Link semantics as start bounds on the successor:
  //   FS: ES(s) >= EF(p) + lag          SS: ES(s) >= ES(p) + lag
  //   FF: EF(s) >= EF(p) + lag ⟺ ES(s) >= EF(p) + lag - d(s)
  //   SF: EF(s) >= ES(p) + lag ⟺ ES(s) >= ES(p) + lag - d(s)
  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();
  for (const id of topoOrder) {
    const duration = durationOf.get(id) ?? 0;
    let bound = 0;
    for (const link of incomingOf.get(id) ?? []) {
      const predecessorEarlyStart = earlyStart.get(link.predecessorId) ?? 0;
      const predecessorEarlyFinish = earlyFinish.get(link.predecessorId) ?? 0;
      const candidate =
        link.linkType === 'FS'
          ? predecessorEarlyFinish + link.lagDays
          : link.linkType === 'SS'
            ? predecessorEarlyStart + link.lagDays
            : link.linkType === 'FF'
              ? predecessorEarlyFinish + link.lagDays - duration
              : predecessorEarlyStart + link.lagDays - duration;
      if (candidate > bound) bound = candidate;
    }
    earlyStart.set(id, bound);
    earlyFinish.set(id, bound + duration);
  }

  const projectDuration =
    activities.length === 0
      ? 0
      : Math.max(...activities.map((activity) => earlyFinish.get(activity.activityId) ?? 0));

  // Outgoing links per predecessor (for the backward pass).
  const outgoingOf = new Map<string, ForecastDependencyInput[]>();
  for (const activity of activities) outgoingOf.set(activity.activityId, []);
  for (const dependency of dependencies) {
    const list = outgoingOf.get(dependency.predecessorId);
    if (list === undefined) continue;
    list.push(dependency);
  }

  // Backward pass: late finish/start day offsets.
  // Link semantics as finish bounds on the predecessor:
  //   FS: EF(p) <= LS(s) - lag           SS: ES(p) <= LS(s) - lag ⟺ EF(p) <= LS(s) - lag + d(p)
  //   FF: EF(p) <= LF(s) - lag           SF: ES(p) <= LF(s) - lag ⟺ EF(p) <= LF(s) - lag + d(p)
  const lateFinish = new Map<string, number>();
  const lateStart = new Map<string, number>();
  for (const id of [...topoOrder].reverse()) {
    const duration = durationOf.get(id) ?? 0;
    let bound = projectDuration;
    for (const link of outgoingOf.get(id) ?? []) {
      const successorLateStart = lateStart.get(link.successorId) ?? projectDuration;
      const successorLateFinish = lateFinish.get(link.successorId) ?? projectDuration;
      const candidate =
        link.linkType === 'FS'
          ? successorLateStart - link.lagDays
          : link.linkType === 'SS'
            ? successorLateStart - link.lagDays + duration
            : link.linkType === 'FF'
              ? successorLateFinish - link.lagDays
              : successorLateFinish - link.lagDays + duration;
      if (candidate < bound) bound = candidate;
    }
    lateFinish.set(id, bound);
    lateStart.set(id, bound - duration);
  }

  // Per-activity forecast rows (code order).
  const rows: ForecastActivity[] = activities.map((activity) => {
    const id = activity.activityId;
    const es = earlyStart.get(id) ?? 0;
    const ef = earlyFinish.get(id) ?? 0;
    const ls = lateStart.get(id) ?? 0;
    const lf = lateFinish.get(id) ?? 0;
    const totalFloat = ls - es;
    return {
      activityId: id,
      code: activity.code,
      duration: durationOf.get(id) ?? activity.plannedDuration,
      percentComplete: percentOf.get(id) ?? 0,
      remainingDuration: durationOf.get(id) ?? activity.plannedDuration,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      totalFloat,
      critical: totalFloat <= 0,
    };
  });

  // Milestone forecasts (code order): bound -> the bound activity's early
  // finish; unbound -> project finish. Achievement is derived progress logic.
  const milestoneRows: ForecastMilestone[] = [...(input.milestones ?? [])]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((milestone) => {
      const bound = milestone.boundActivityId;
      const allComplete =
        activities.length > 0 &&
        activities.every((activity) => (percentOf.get(activity.activityId) ?? 0) === 100);
      return {
        milestoneId: milestone.milestoneId,
        code: milestone.code,
        boundActivityId: bound,
        forecastDay: bound === null ? projectDuration : (earlyFinish.get(bound) ?? 0),
        achieved: bound === null ? allComplete : (percentOf.get(bound) ?? 0) === 100,
      };
    });

  // Critical path reconstruction: walk the DRIVING chain backward from the
  // forecast terminal (max early finish; ties -> smallest code), through the
  // incoming link that drove each node's early constraint (ties -> smallest
  // predecessor code, then link type, then lag), and emit it forward.
  const criticalPath: EntityId[] = [];
  if (activities.length > 0) {
    const terminal = activities.reduce((best, candidate) => {
      const bestFinish = earlyFinish.get(best.activityId) ?? 0;
      const candidateFinish = earlyFinish.get(candidate.activityId) ?? 0;
      if (candidateFinish > bestFinish) return candidate;
      if (candidateFinish === bestFinish && candidate.code < best.code) return candidate;
      return best;
    });
    const codeOf = new Map<string, string>();
    for (const activity of activities) codeOf.set(activity.activityId, activity.code);
    let current: EntityId | null = terminal.activityId;
    const chain: EntityId[] = [];
    while (current !== null) {
      chain.push(current);
      const duration = durationOf.get(current) ?? 0;
      const es = earlyStart.get(current) ?? 0;
      const ef = earlyFinish.get(current) ?? 0;
      const candidates: ForecastDependencyInput[] = (incomingOf.get(current) ?? [])
        .filter((link) => {
          const predecessorEarlyStart = earlyStart.get(link.predecessorId) ?? 0;
          const predecessorEarlyFinish = earlyFinish.get(link.predecessorId) ?? 0;
          const bound =
            link.linkType === 'FS'
              ? predecessorEarlyFinish + link.lagDays
              : link.linkType === 'SS'
                ? predecessorEarlyStart + link.lagDays
                : link.linkType === 'FF'
                  ? predecessorEarlyFinish + link.lagDays - duration
                  : predecessorEarlyStart + link.lagDays - duration;
          if (link.linkType === 'FS' || link.linkType === 'SS') return bound === es;
          return bound + duration === ef;
        })
        .sort((a, b) => {
          const byCode =
            (codeOf.get(a.predecessorId) ?? '') < (codeOf.get(b.predecessorId) ?? '')
              ? -1
              : (codeOf.get(a.predecessorId) ?? '') > (codeOf.get(b.predecessorId) ?? '')
                ? 1
                : 0;
          if (byCode !== 0) return byCode;
          const byType =
            LINK_TYPE_ORDER.indexOf(a.linkType) - LINK_TYPE_ORDER.indexOf(b.linkType);
          if (byType !== 0) return byType;
          return a.lagDays - b.lagDays;
        });
      const driving: ForecastDependencyInput | undefined = candidates[0];
      current = driving === undefined ? null : driving.predecessorId;
    }
    criticalPath.push(...[...chain].reverse());
  }

  return ok({
    projectDuration,
    activities: rows,
    milestones: milestoneRows,
    criticalPath,
  });
}

// ----- derived-read conveniences (recompute on demand; never stored truth) --------

/**
 * Forecast the CURRENT schedule: the current activity network with the
 * latest per-activity progress (the remaining-work model). Pure derived read
 * of the stored state — recomputed on every call, never persisted.
 */
export function forecastOfSchedule(
  state: ScheduleState,
  context?: DomainErrorContext,
): Result<ScheduleForecast, DomainError> {
  const latest = latestProgressByActivity(state);
  const input: ForecastNetworkInput = {
    activities: Object.values(state.activities).map((activity) => ({
      activityId: activity.entityId,
      code: activity.code,
      plannedDuration: activity.plannedDuration,
    })),
    dependencies: Object.values(state.dependencies).map((dependency) => ({
      predecessorId: dependency.predecessorId,
      successorId: dependency.successorId,
      linkType: dependency.linkType,
      lagDays: dependency.lagDays,
    })),
    milestones: Object.values(state.milestones).map((milestone) => ({
      milestoneId: milestone.entityId,
      code: milestone.code,
      boundActivityId: milestone.boundActivityId,
    })),
    progress: Object.values(latest).map((entry) => ({
      activityId: entry.activityId,
      percentComplete: entry.percentComplete,
      remainingDuration: entry.remainingDuration,
    })),
  };
  return forecastSchedule(input, context);
}

/**
 * Forecast ONE baseline's planned network: the snapshot's activities and
 * dependencies with NO progress (a baseline captures the plan; its forecast
 * is the deterministic recomputation variance compares against). Pure
 * derived read of the immutable snapshot.
 */
export function forecastOfBaseline(
  baseline: BaselineState,
  context?: DomainErrorContext,
): Result<ScheduleForecast, DomainError> {
  const input: ForecastNetworkInput = {
    activities: baseline.snapshot.activities.map((activity) => ({
      activityId: activity.entityId,
      code: activity.code,
      plannedDuration: activity.plannedDuration,
    })),
    dependencies: baseline.snapshot.dependencies.map((dependency) => ({
      predecessorId: dependency.predecessorId,
      successorId: dependency.successorId,
      linkType: dependency.linkType,
      lagDays: dependency.lagDays,
    })),
    milestones: baseline.snapshot.milestones.map((milestone) => ({
      milestoneId: milestone.entityId,
      code: milestone.code,
      boundActivityId: milestone.boundActivityId,
    })),
  };
  return forecastSchedule(input, context);
}
