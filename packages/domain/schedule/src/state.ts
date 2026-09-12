// Office schedule domain — aggregate state, invariants, transitions (OFF-010).
//
// THE canonical program-of-work model of the Construction Project Graph
// (freeze A1/A6): one project-scoped Schedule aggregate root per project,
// owning the WHOLE activity network — activities (WBS-ish hierarchy, planned
// dates + calendar-free integer durations), typed dependencies (FS/SS/FF/SF
// links with integer lag), milestones (zero-duration markers bound to
// activity completion), baselines (immutable snapshots chained through
// `supersedes`, like document revisions), and the append-only progress log.
//
// WHY one root: the whole network is a single consistency unit. Dependency
// validation (deadlock/cycle detection, missing references, duplicates) and
// the deterministic CPM forecast are WHOLE-network questions — the schedule
// root is the boundary that keeps them transactional and pure. Activities,
// dependencies, milestones, baselines and progress updates are entity models
// INSIDE the root, each carrying its own canonical EntityId + EntityKind so
// events, relationships (OFF-013) and impact analysis (OFF-014) can reference
// them individually. Every mutation of anything inside the root bumps the
// ROOT's version — optimistic concurrency guards the network as a whole
// (never a last-write-wins partial-network overwrite, freeze anti-pattern).
//
// This module is PURE DOMAIN (provider-independent by freeze A5/A6): no SQL,
// no repository, no wall clock, no randomness — `now` and canonical ids are
// injected by the caller. State transitions are total functions returning
// typed Results; failures never mutate the input state (callers deep-compare
// to prove it). Durations are WORKING-DAY-FREE integers: calendar logic is
// deliberately out of scope at this layer (see README).
//
// Baseline protection (acceptance gate): a baseline, once set, can never be
// edited or deleted — there is no mutating transition, and the two explicit
// guards below (`updateBaselineState`/`removeBaselineState`) encode that
// absence as always-failing typed `forbidden` results. Change flows through
// progress updates and re-baselines only; a re-baseline appends a NEW
// snapshot pointing backward via `supersedes` and never touches the old one.
import { parseEntityKind } from '@office/contracts';
import type { EntityId, EntityKind, Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import type { Aggregate, AggregateVersion, DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { domainError, entityNotFound, fail, invariantViolation } from '@office/domain-kernel';
import { compareTimestamps } from './parse';

// ----- entity kinds -------------------------------------------------------------

const parsedKind = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    // Trusted-path literal: a violation means this module is malformed.
    throw new TypeError(
      `invalid schedule-domain entity kind literal: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
};

/** Canonical entity kind of the Schedule aggregate root. */
export const SCHEDULE_KIND: EntityKind = parsedKind('schedule');
/** Canonical entity kind of an Activity inside the schedule root. */
export const ACTIVITY_KIND: EntityKind = parsedKind('activity');
/** Canonical entity kind of a typed Dependency link. */
export const DEPENDENCY_KIND: EntityKind = parsedKind('dependency');
/** Canonical entity kind of a Milestone marker. */
export const MILESTONE_KIND: EntityKind = parsedKind('milestone');
/** Canonical entity kind of an immutable Baseline snapshot. */
export const BASELINE_KIND: EntityKind = parsedKind('baseline');
/** Canonical entity kind of one append-only Progress update record. */
export const PROGRESS_UPDATE_KIND: EntityKind = parsedKind('progress-update');

// ----- vocabulary ---------------------------------------------------------------

/**
 * The closed typed link vocabulary (Office-canonical, provider-independent):
 * FS = finish-to-start, SS = start-to-start, FF = finish-to-finish,
 * SF = start-to-finish.
 */
export type DependencyLinkType = 'FS' | 'SS' | 'FF' | 'SF';

/** All dependency link types, in canonical order. */
export const DEPENDENCY_LINK_TYPES: readonly DependencyLinkType[] = [
  'FS',
  'SS',
  'FF',
  'SF',
];

const CODE_RULE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const NAME_MAX_LENGTH = 200;
const DURATION_MAX = 10_000;
const LAG_ABS_MAX = 3_650;

// ----- entity models ------------------------------------------------------------

/**
 * One activity of the program of work. `plannedDuration` is a calendar-free
 * integer in working units (days at this layer); `plannedStart`/`plannedFinish`
 * are optional pinned calendar instants of the CURRENT plan (the forecast
 * never derives from them — it is computed from the network); the WBS-ish
 * hierarchy is a plain parent reference inside the project.
 */
export interface ActivityState {
  readonly entityId: EntityId;
  /** Unique activity code within the schedule (1..64 chars, stable identity for humans). */
  readonly code: string;
  /** Display name (1..200 characters). */
  readonly name: string;
  /** Planned duration: positive integer working units (calendar-free). */
  readonly plannedDuration: number;
  /** Pinned planned start of the current plan, or null. */
  readonly plannedStart: Timestamp | null;
  /** Pinned planned finish of the current plan, or null. */
  readonly plannedFinish: Timestamp | null;
  /** Parent activity id (WBS-ish hierarchy within the project), or null for a root. */
  readonly parentActivityId: EntityId | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * One typed dependency link between two activities of the same schedule.
 * `lagDays` is a signed integer (calendar-free working units): the successor
 * is pushed by +lag / pulled earlier by -lag relative to the link semantics.
 */
export interface DependencyState {
  readonly entityId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: DependencyLinkType;
  readonly lagDays: number;
  readonly createdAt: Timestamp;
}

/**
 * One milestone: a zero-duration marker bound to activity completion logic.
 * A bound milestone is achieved exactly when its bound activity's LATEST
 * progress update records 100% completion; a project-level milestone
 * (boundActivityId null) is achieved when every activity is complete.
 * Achievement is a DERIVED read (see forecast.ts) — never stored as truth.
 */
export interface MilestoneState {
  readonly entityId: EntityId;
  /** Unique milestone code within the schedule. */
  readonly code: string;
  /** Display name (1..200 characters). */
  readonly name: string;
  /** The activity whose completion achieves this milestone, or null (project-level). */
  readonly boundActivityId: EntityId | null;
  readonly createdAt: Timestamp;
}

/**
 * The immutable network snapshot a baseline captures: deep copies of the
 * activities, dependencies and milestones as they stood at baseline time.
 * Snapshots never change after creation (no mutating transition exists), and
 * forecast/variance recompute from them deterministically (A3: projections
 * are derived, never stored as truth).
 */
export interface BaselineSnapshot {
  readonly activities: readonly ActivityState[];
  readonly dependencies: readonly DependencyState[];
  readonly milestones: readonly MilestoneState[];
}

/**
 * One baseline of the schedule. The chain works like document revisions:
 * each new baseline carries `supersedes` pointing BACKWARD to the baseline it
 * replaced; the schedule root carries `currentBaselineId`. Old baselines are
 * never mutated — re-baselining appends a new snapshot only.
 */
export interface BaselineState {
  readonly entityId: EntityId;
  /** Dense sequence (1, 2, 3, …) in baseline-creation order. */
  readonly sequence: number;
  /** Human label (defaults deterministically to `Baseline N`). */
  readonly label: string;
  /** The baseline this one supersedes, or null for the first baseline. */
  readonly supersedes: EntityId | null;
  /** Immutable network snapshot captured at baseline creation. */
  readonly snapshot: BaselineSnapshot;
  /** The acting actor's canonical id, or null for the system actor. */
  readonly createdBy: EntityId | null;
  readonly createdAt: Timestamp;
}

/**
 * One append-only progress update applied to an activity. The log is the
 * stored truth; an activity's CURRENT progress is the LATEST entry for it
 * (derived read — see latestProgressByActivity). Entries are never edited or
 * deleted (no such transition exists).
 */
export interface ProgressUpdateState {
  readonly entityId: EntityId;
  readonly activityId: EntityId;
  /** Percent complete: integer 0..100. */
  readonly percentComplete: number;
  /** Remaining duration: integer working units; zero exactly when complete. */
  readonly remainingDuration: number;
  /** Actual start instant, or null while not started. */
  readonly actualStart: Timestamp | null;
  /** Actual finish instant; required exactly when percentComplete is 100. */
  readonly actualFinish: Timestamp | null;
  /** Injected-clock instant this update was recorded. */
  readonly recordedAt: Timestamp;
}

/**
 * THE Schedule aggregate state: the project's whole program of work. The
 * scope is always the schedule's OWN project scope ({ kind: 'project',
 * tenantId, projectId }); every mutation anywhere inside the network bumps
 * the root version (optimistic concurrency over the network as a whole).
 */
export interface ScheduleState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** Program-of-work display name (1..200 characters). */
  readonly name: string;
  /** Activities keyed by canonical entity id. */
  readonly activities: Readonly<Record<string, ActivityState>>;
  /** Typed dependency links keyed by canonical entity id. */
  readonly dependencies: Readonly<Record<string, DependencyState>>;
  /** Milestones keyed by canonical entity id. */
  readonly milestones: Readonly<Record<string, MilestoneState>>;
  /** Immutable baselines keyed by canonical entity id. */
  readonly baselines: Readonly<Record<string, BaselineState>>;
  /** The current (chain-tip) baseline id, or null before the first baseline. */
  readonly currentBaselineId: EntityId | null;
  /** Append-only progress history, oldest first. */
  readonly progressUpdates: readonly ProgressUpdateState[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

// ----- shared validation helpers (pure, deterministic) ---------------------------

const values = <T>(record: Readonly<Record<string, T>>): T[] => Object.values(record);

const sortedByCode = <T extends { readonly code: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

/**
 * Does the directed predecessor→successor graph over `activities` contain a
 * cycle? Kahn's algorithm (deterministic; order-independent answer). A cycle
 * is a deadlock: no valid program of work can schedule it — the acceptance
 * gate rejects the whole mutation before any state lands.
 */
const dependencyGraphHasCycle = (
  activities: Readonly<Record<string, ActivityState>>,
  dependencies: Readonly<Record<string, DependencyState>>,
): boolean => {
  const nodes = new Set<string>(Object.keys(activities));
  const indegree = new Map<string, number>();
  for (const id of nodes) indegree.set(id, 0);
  const successors = new Map<string, string[]>();
  for (const id of nodes) successors.set(id, []);
  for (const dependency of values(dependencies)) {
    const from = dependency.predecessorId;
    const to = dependency.successorId;
    if (!nodes.has(from) || !nodes.has(to)) continue;
    const list = successors.get(from);
    const degree = indegree.get(to);
    if (list === undefined || degree === undefined) continue;
    list.push(to);
    indegree.set(to, degree + 1);
  }
  const queue: string[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }
  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    processed += 1;
    for (const next of successors.get(current) ?? []) {
      const degree = indegree.get(next);
      if (degree === undefined) continue;
      const reduced = degree - 1;
      indegree.set(next, reduced);
      if (reduced === 0) queue.push(next);
    }
  }
  return processed !== nodes.size;
};

/**
 * Does the parent-reference forest over `activities` contain a cycle?
 * Deterministic walk with a visited set per start node.
 */
const parentGraphHasCycle = (activities: Readonly<Record<string, ActivityState>>): boolean => {
  const ids = new Set<string>(Object.keys(activities));
  for (const start of ids) {
    const seen = new Set<string>([start]);
    let current: string | null = start;
    while (current !== null) {
      const activity: ActivityState | undefined = activities[current];
      const parent: EntityId | null = activity?.parentActivityId ?? null;
      if (parent === null) break;
      if (seen.has(parent)) return true;
      seen.add(parent);
      current = parent;
    }
  }
  return false;
};

/** Validate the reference integrity of one network (shared by current state and baseline snapshots). */
const networkReferenceErrors = (
  activities: Readonly<Record<string, ActivityState>>,
  dependencies: Readonly<Record<string, DependencyState>>,
  milestones: Readonly<Record<string, MilestoneState>>,
): { readonly name: string; readonly statement: string }[] => {
  const violations: { readonly name: string; readonly statement: string }[] = [];
  const codes = new Set<string>();
  for (const activity of values(activities)) {
    if (codes.has(activity.code)) {
      violations.push({
        name: 'schedule-activity-codes-unique',
        statement: `activity code '${activity.code}' is used more than once`,
      });
    }
    codes.add(activity.code);
  }
  const milestoneCodes = new Set<string>();
  for (const milestone of values(milestones)) {
    if (milestoneCodes.has(milestone.code)) {
      violations.push({
        name: 'schedule-milestone-codes-unique',
        statement: `milestone code '${milestone.code}' is used more than once`,
      });
    }
    milestoneCodes.add(milestone.code);
    if (
      milestone.boundActivityId !== null &&
      activities[milestone.boundActivityId] === undefined
    ) {
      violations.push({
        name: 'schedule-milestone-activity-exists',
        statement: `milestone ${milestone.entityId} is bound to activity ${milestone.boundActivityId}, which does not exist`,
      });
    }
  }
  const links = new Set<string>();
  for (const dependency of values(dependencies)) {
    if (activities[dependency.predecessorId] === undefined) {
      violations.push({
        name: 'schedule-dependency-predecessor-exists',
        statement: `dependency ${dependency.entityId} names predecessor ${dependency.predecessorId}, which does not exist`,
      });
    }
    if (activities[dependency.successorId] === undefined) {
      violations.push({
        name: 'schedule-dependency-successor-exists',
        statement: `dependency ${dependency.entityId} names successor ${dependency.successorId}, which does not exist`,
      });
    }
    if (dependency.predecessorId === dependency.successorId) {
      violations.push({
        name: 'schedule-dependency-no-self-reference',
        statement: `dependency ${dependency.entityId} links activity ${dependency.predecessorId} to itself`,
      });
    }
    const link = `${dependency.predecessorId}|${dependency.successorId}|${dependency.linkType}`;
    if (links.has(link)) {
      violations.push({
        name: 'schedule-dependency-no-duplicates',
        statement: `dependency ${dependency.entityId} duplicates the ${dependency.linkType} link ${dependency.predecessorId} -> ${dependency.successorId}`,
      });
    }
    links.add(link);
  }
  return violations;
};

// ----- declarative invariants ----------------------------------------------------

/**
 * Declarative invariants over any ScheduleState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 * These re-validate, on every NEXT state, everything the pure transitions
 * guarantee structurally: vocabulary bounds, reference integrity, graph
 * acyclicity (current network AND every baseline snapshot), baseline chain
 * shape, and progress-log consistency.
 */
export const SCHEDULE_INVARIANTS = [
  defineInvariant<ScheduleState>(
    'schedule-name-nonempty',
    'a schedule name is 1..200 characters',
    (state) => state.name.length >= 1 && state.name.length <= NAME_MAX_LENGTH,
  ),
  defineInvariant<ScheduleState>(
    'schedule-is-project-scoped',
    'a schedule is owned by exactly one project (project scope; the second authorization boundary)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<ScheduleState>(
    'schedule-version-is-monotonic',
    'a schedule version is a positive integer (starts at 1, +1 per mutation of the network)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
  defineInvariant<ScheduleState>(
    'schedule-activity-codes-unique',
    'activity codes are unique within the schedule and match the code grammar',
    (state) =>
      values(state.activities).every(
        (activity) =>
          CODE_RULE.test(activity.code) &&
          activity.code.length >= 1 &&
          activity.code.length <= 64 &&
          activity.name.length >= 1 &&
          activity.name.length <= NAME_MAX_LENGTH &&
          Number.isInteger(activity.plannedDuration) &&
          activity.plannedDuration >= 1 &&
          activity.plannedDuration <= DURATION_MAX,
      ) &&
      new Set(values(state.activities).map((activity) => activity.code)).size ===
        Object.keys(state.activities).length,
  ),
  defineInvariant<ScheduleState>(
    'schedule-activity-parents-exist',
    'every activity parent reference is null, an existing activity, and never the activity itself; the WBS hierarchy is a forest',
    (state) =>
      values(state.activities).every((activity) => {
        if (activity.parentActivityId === null) return true;
        if (activity.parentActivityId === activity.entityId) return false;
        return state.activities[activity.parentActivityId] !== undefined;
      }) && !parentGraphHasCycle(state.activities),
  ),
  defineInvariant<ScheduleState>(
    'schedule-activity-planned-dates-ordered',
    'a pinned planned finish is never earlier than its planned start',
    (state) =>
      values(state.activities).every(
        (activity) =>
          activity.plannedStart === null ||
          activity.plannedFinish === null ||
          compareTimestamps(activity.plannedFinish, activity.plannedStart) >= 0,
      ),
  ),
  defineInvariant<ScheduleState>(
    'schedule-dependencies-reference-activities',
    'every dependency references two existing distinct activities with no duplicate link and a bounded lag',
    (state) => {
      const violations = networkReferenceErrors(
        state.activities,
        state.dependencies,
        state.milestones,
      );
      return (
        violations.length === 0 &&
        values(state.dependencies).every(
          (dependency) =>
            Number.isInteger(dependency.lagDays) &&
            Math.abs(dependency.lagDays) <= LAG_ABS_MAX,
        )
      );
    },
  ),
  defineInvariant<ScheduleState>(
    'schedule-dependency-graph-acyclic',
    'the dependency graph over the current network is acyclic (a cycle is a deadlock)',
    (state) => !dependencyGraphHasCycle(state.activities, state.dependencies),
  ),
  defineInvariant<ScheduleState>(
    'schedule-milestone-codes-unique',
    'milestone codes are unique within the schedule and match the code grammar',
    (state) =>
      values(state.milestones).every(
        (milestone) =>
          CODE_RULE.test(milestone.code) &&
          milestone.name.length >= 1 &&
          milestone.name.length <= NAME_MAX_LENGTH,
      ) &&
      new Set(values(state.milestones).map((milestone) => milestone.code)).size ===
        Object.keys(state.milestones).length,
  ),
  defineInvariant<ScheduleState>(
    'schedule-baseline-chain-well-formed',
    'baselines carry dense sequences, a backward supersedes chain with no forks, and the current baseline is the chain tip',
    (state) => {
      const baselines = values(state.baselines);
      const sequences = baselines.map((baseline) => baseline.sequence);
      if (
        sequences.length !== Object.keys(state.baselines).length ||
        new Set(sequences).size !== sequences.length
      ) {
        return false;
      }
      const expected = Array.from({ length: sequences.length }, (_, index) => index + 1);
      const sorted = [...sequences].sort((a, b) => a - b);
      if (sorted.length !== expected.length || sorted.some((value, index) => value !== expected[index])) {
        return false;
      }
      if (state.currentBaselineId !== null && state.baselines[state.currentBaselineId] === undefined) {
        return false;
      }
      const superseded = new Set<string>();
      for (const baseline of baselines) {
        if (baseline.supersedes === null) {
          if (baseline.sequence !== 1) return false;
          continue;
        }
        const predecessor = state.baselines[baseline.supersedes];
        if (predecessor === undefined) return false;
        if (predecessor.sequence >= baseline.sequence) return false;
        if (superseded.has(baseline.supersedes)) return false;
        superseded.add(baseline.supersedes);
        if (baseline.sequence === 1) return false;
      }
      if (state.currentBaselineId !== null && superseded.has(state.currentBaselineId)) {
        return false;
      }
      return true;
    },
  ),
  defineInvariant<ScheduleState>(
    'schedule-baseline-snapshots-valid',
    'every baseline snapshot is internally consistent: unique codes, existing references, no self-links, and an acyclic dependency graph',
    (state) => {
      for (const baseline of values(state.baselines)) {
        const activities: Record<string, ActivityState> = {};
        for (const activity of baseline.snapshot.activities) {
          activities[activity.entityId] = activity;
        }
        const dependencies: Record<string, DependencyState> = {};
        for (const dependency of baseline.snapshot.dependencies) {
          dependencies[dependency.entityId] = dependency;
        }
        const milestones: Record<string, MilestoneState> = {};
        for (const milestone of baseline.snapshot.milestones) {
          milestones[milestone.entityId] = milestone;
        }
        if (networkReferenceErrors(activities, dependencies, milestones).length > 0) {
          return false;
        }
        if (dependencyGraphHasCycle(activities, dependencies)) return false;
        if (parentGraphHasCycle(activities)) return false;
      }
      return true;
    },
  ),
  defineInvariant<ScheduleState>(
    'schedule-progress-log-consistent',
    'every progress update addresses an existing activity with consistent completion semantics, and the log is append-only-shaped (unique entry ids)',
    (state) => {
      const entryIds = new Set<string>();
      for (const entry of state.progressUpdates) {
        if (state.activities[entry.activityId] === undefined) return false;
        if (entryIds.has(entry.entityId)) return false;
        entryIds.add(entry.entityId);
        if (
          !Number.isInteger(entry.percentComplete) ||
          entry.percentComplete < 0 ||
          entry.percentComplete > 100
        ) {
          return false;
        }
        if (!Number.isInteger(entry.remainingDuration) || entry.remainingDuration < 0) {
          return false;
        }
        const complete = entry.percentComplete === 100;
        if (complete !== (entry.remainingDuration === 0)) return false;
        if (complete && entry.actualFinish === null) return false;
        if (!complete && entry.actualFinish !== null) return false;
        if (entry.actualFinish !== null && entry.actualStart === null) return false;
        if (
          entry.actualStart !== null &&
          entry.actualFinish !== null &&
          compareTimestamps(entry.actualFinish, entry.actualStart) < 0
        ) {
          return false;
        }
      }
      return true;
    },
  ),
] as const;

// ----- pure transitions ----------------------------------------------------------

const checkState = (
  state: ScheduleState,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> => checkInvariants(state, SCHEDULE_INVARIANTS, context);

/** Parts of a newly created schedule (the canonical id is issued inside the handler). */
export interface NewSchedule {
  readonly scheduleId: EntityId;
  readonly name: string;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly created schedule (trusted path — the
 * payload was validated fail-closed upstream): an empty activity network, no
 * baselines, an empty progress log. The scope MUST be project scope; the
 * invariant list enforces it (a tenant-scope schedule state cannot exist).
 */
export function createScheduleState(
  input: NewSchedule,
  scope: Scope,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  const state: ScheduleState = {
    entityKind: SCHEDULE_KIND,
    entityId: input.scheduleId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    name: input.name,
    activities: {},
    dependencies: {},
    milestones: {},
    baselines: {},
    currentBaselineId: null,
    progressUpdates: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkState(state, context);
}

/** Parts of a newly added activity (the canonical id is issued inside the handler). */
export interface NewActivity {
  readonly activityId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  readonly plannedStart?: Timestamp | null;
  readonly plannedFinish?: Timestamp | null;
  readonly parentActivityId?: EntityId | null;
  readonly now: Timestamp;
}

/**
 * Pure transition: add one activity to the network. Rejects duplicate codes
 * and unknown parents BEFORE any state lands (typed invariant-violation; the
 * input state is untouched).
 */
export function addActivityState(
  current: ScheduleState,
  input: NewActivity,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  for (const activity of values(current.activities)) {
    if (activity.code === input.code) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-activity-codes-unique',
            statement: `activity code '${input.code}' is already used by activity ${activity.entityId} of schedule ${current.entityId}`,
          },
          context,
        ),
      );
    }
  }
  if (input.parentActivityId !== null && input.parentActivityId !== undefined) {
    if (input.parentActivityId === input.activityId) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-activity-parent-not-self',
            statement: `activity ${input.activityId} cannot be its own WBS parent`,
          },
          context,
        ),
      );
    }
    if (current.activities[input.parentActivityId] === undefined) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-activity-parent-exists',
            statement: `activity ${input.activityId} names parent ${input.parentActivityId}, which does not exist in schedule ${current.entityId}`,
          },
          context,
        ),
      );
    }
  }
  const activity: ActivityState = {
    entityId: input.activityId,
    code: input.code,
    name: input.name,
    plannedDuration: input.plannedDuration,
    plannedStart: input.plannedStart ?? null,
    plannedFinish: input.plannedFinish ?? null,
    parentActivityId: input.parentActivityId ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const next: ScheduleState = {
    ...current,
    activities: { ...current.activities, [input.activityId]: activity },
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkState(next, context);
}

/** Field changes for an activity update; at least one field must be present. */
export interface ActivityChanges {
  readonly code?: string;
  readonly name?: string;
  readonly plannedDuration?: number;
  readonly plannedStart?: Timestamp | null;
  readonly plannedFinish?: Timestamp | null;
  readonly parentActivityId?: EntityId | null;
}

/**
 * Pure transition: update one activity's current-plan data (code, name,
 * planned duration/dates, WBS parent). The CURRENT plan keeps evolving after
 * a baseline — that divergence is exactly what variance measures; baselines
 * themselves are never touched here. Rejects unknown activities (typed
 * not-found), duplicate codes, unknown/self parents, and parent cycles.
 */
export function updateActivityState(
  current: ScheduleState,
  activityId: EntityId,
  changes: ActivityChanges,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  const existing = current.activities[activityId];
  if (existing === undefined) {
    return fail(
      entityNotFound(
        { entityKind: ACTIVITY_KIND, entityId: activityId },
        context,
      ),
    );
  }
  if (changes.code !== undefined && changes.code !== existing.code) {
    for (const activity of values(current.activities)) {
      if (activity.entityId !== activityId && activity.code === changes.code) {
        return fail(
          invariantViolation(
            {
              name: 'schedule-activity-codes-unique',
              statement: `activity code '${changes.code}' is already used by activity ${activity.entityId} of schedule ${current.entityId}`,
            },
            context,
          ),
        );
      }
    }
  }
  if (changes.parentActivityId !== undefined && changes.parentActivityId !== null) {
    if (changes.parentActivityId === activityId) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-activity-parent-not-self',
            statement: `activity ${activityId} cannot be its own WBS parent`,
          },
          context,
        ),
      );
    }
    if (current.activities[changes.parentActivityId] === undefined) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-activity-parent-exists',
            statement: `activity ${activityId} names parent ${changes.parentActivityId}, which does not exist in schedule ${current.entityId}`,
          },
          context,
        ),
      );
    }
    // WBS cycle: walking up from the new parent must never reach this activity.
    let ancestor: EntityId | null = changes.parentActivityId;
    while (ancestor !== null) {
      if (ancestor === activityId) {
        return fail(
          invariantViolation(
            {
              name: 'schedule-activity-parent-acyclic',
              statement: `setting the parent of activity ${activityId} to ${changes.parentActivityId} would create a WBS hierarchy cycle`,
            },
            context,
          ),
        );
      }
      ancestor = current.activities[ancestor]?.parentActivityId ?? null;
    }
  }
  const updated: ActivityState = {
    ...existing,
    ...(changes.code !== undefined ? { code: changes.code } : {}),
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.plannedDuration !== undefined
      ? { plannedDuration: changes.plannedDuration }
      : {}),
    ...(changes.plannedStart !== undefined ? { plannedStart: changes.plannedStart } : {}),
    ...(changes.plannedFinish !== undefined ? { plannedFinish: changes.plannedFinish } : {}),
    ...(changes.parentActivityId !== undefined
      ? { parentActivityId: changes.parentActivityId }
      : {}),
    updatedAt: now,
  };
  const activities = { ...current.activities, [activityId]: updated };
  const next: ScheduleState = {
    ...current,
    activities,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkState(next, context);
}

/** Parts of a newly added dependency link (the canonical id is issued inside the handler). */
export interface NewDependency {
  readonly dependencyId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: DependencyLinkType;
  readonly lagDays?: number;
  readonly now: Timestamp;
}

/**
 * Pure transition: add one typed dependency link. THE dependency-graph
 * validation gate (acceptance): missing predecessor/successor references,
 * self-dependency, duplicate links, and CYCLES (deadlocks — including cycles
 * that only close through the new link, over any link type) are all rejected
 * as typed invariant-violations BEFORE any state lands; the input state is
 * returned untouched on failure. Deterministic: the same network + link
 * always yields the same verdict.
 */
export function addDependencyState(
  current: ScheduleState,
  input: NewDependency,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  if (current.activities[input.predecessorId] === undefined) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-dependency-predecessor-exists',
          statement: `dependency of schedule ${current.entityId} names predecessor ${input.predecessorId}, which does not exist`,
        },
        context,
      ),
    );
  }
  if (current.activities[input.successorId] === undefined) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-dependency-successor-exists',
          statement: `dependency of schedule ${current.entityId} names successor ${input.successorId}, which does not exist`,
        },
        context,
      ),
    );
  }
  if (input.predecessorId === input.successorId) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-dependency-no-self-reference',
          statement: `activity ${input.predecessorId} cannot depend on itself (dependency ${input.dependencyId})`,
        },
        context,
      ),
    );
  }
  for (const dependency of values(current.dependencies)) {
    if (
      dependency.predecessorId === input.predecessorId &&
      dependency.successorId === input.successorId &&
      dependency.linkType === input.linkType
    ) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-dependency-no-duplicates',
            statement: `the ${input.linkType} link ${input.predecessorId} -> ${input.successorId} already exists as dependency ${dependency.entityId}`,
          },
          context,
        ),
      );
    }
  }
  const lagDays = input.lagDays ?? 0;
  const dependency: DependencyState = {
    entityId: input.dependencyId,
    predecessorId: input.predecessorId,
    successorId: input.successorId,
    linkType: input.linkType,
    lagDays,
    createdAt: input.now,
  };
  const wouldBeDependencies = { ...current.dependencies, [input.dependencyId]: dependency };
  if (dependencyGraphHasCycle(current.activities, wouldBeDependencies)) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-dependency-graph-acyclic',
          statement: `adding the ${input.linkType} link ${input.predecessorId} -> ${input.successorId} would close a dependency cycle (a deadlock); schedule ${current.entityId} is unchanged`,
        },
        context,
      ),
    );
  }
  const next: ScheduleState = {
    ...current,
    dependencies: wouldBeDependencies,
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkState(next, context);
}

/**
 * Pure transition: remove one dependency link (the ONLY removable entity of
 * the model — activity/milestone/progress/baseline history is append-only;
 * dependencies express plan logic that may legitimately be re-modeled).
 * Unknown dependency ids are typed not-found; the network stays valid.
 */
export function removeDependencyState(
  current: ScheduleState,
  dependencyId: EntityId,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  const existing = current.dependencies[dependencyId];
  if (existing === undefined) {
    return fail(
      entityNotFound(
        { entityKind: DEPENDENCY_KIND, entityId: dependencyId },
        context,
      ),
    );
  }
  const dependencies = { ...current.dependencies };
  delete dependencies[dependencyId];
  const next: ScheduleState = {
    ...current,
    dependencies,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkState(next, context);
}

/** Parts of a newly added milestone (the canonical id is issued inside the handler). */
export interface NewMilestone {
  readonly milestoneId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly boundActivityId?: EntityId | null;
  readonly now: Timestamp;
}

/**
 * Pure transition: add one zero-duration milestone marker. Rejects duplicate
 * codes and a bound activity that does not exist (typed
 * invariant-violation, state untouched). Milestones are append-only markers;
 * achievement is always a derived read over the progress log.
 */
export function addMilestoneState(
  current: ScheduleState,
  input: NewMilestone,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  for (const milestone of values(current.milestones)) {
    if (milestone.code === input.code) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-milestone-codes-unique',
            statement: `milestone code '${input.code}' is already used by milestone ${milestone.entityId} of schedule ${current.entityId}`,
          },
          context,
        ),
      );
    }
  }
  if (input.boundActivityId !== null && input.boundActivityId !== undefined) {
    if (current.activities[input.boundActivityId] === undefined) {
      return fail(
        invariantViolation(
          {
            name: 'schedule-milestone-activity-exists',
            statement: `milestone ${input.milestoneId} is bound to activity ${input.boundActivityId}, which does not exist in schedule ${current.entityId}`,
          },
          context,
        ),
      );
    }
  }
  const milestone: MilestoneState = {
    entityId: input.milestoneId,
    code: input.code,
    name: input.name,
    boundActivityId: input.boundActivityId ?? null,
    createdAt: input.now,
  };
  const next: ScheduleState = {
    ...current,
    milestones: { ...current.milestones, [input.milestoneId]: milestone },
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkState(next, context);
}

/** Parts of a new baseline (the canonical id is issued inside the handler). */
export interface NewBaseline {
  readonly baselineId: EntityId;
  readonly label?: string;
  /** The acting actor's canonical id, or null for the system actor. */
  readonly createdBy?: EntityId | null;
  readonly now: Timestamp;
}

/** Deep-copy the current network into an isolated immutable snapshot (deterministic orderings). */
const snapshotOf = (state: ScheduleState): BaselineSnapshot => ({
  activities: sortedByCode(values(state.activities)).map((activity) => ({ ...activity })),
  dependencies: values(state.dependencies)
    .map((dependency) => ({ ...dependency }))
    .sort((a, b) => {
      const byPredecessor = a.predecessorId < b.predecessorId ? -1 : a.predecessorId > b.predecessorId ? 1 : 0;
      if (byPredecessor !== 0) return byPredecessor;
      const bySuccessor = a.successorId < b.successorId ? -1 : a.successorId > b.successorId ? 1 : 0;
      if (bySuccessor !== 0) return bySuccessor;
      return a.linkType < b.linkType ? -1 : 1;
    }),
  milestones: sortedByCode(values(state.milestones)).map((milestone) => ({ ...milestone })),
});

/**
 * Pure transition: BASELINE the schedule — the explicit, consequential event
 * that freezes the current network as a new immutable snapshot. The new
 * baseline supersedes the current one (backward `supersedes` pointer, like
 * document revisions); the superseded baseline is NOT mutated — re-baselining
 * appends only. Progress history is deliberately NOT part of a snapshot: a
 * baseline captures the planned network, and variance compares deterministic
 * recomputations against it.
 */
export function setBaselineState(
  current: ScheduleState,
  input: NewBaseline,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  const sequence = Object.keys(current.baselines).length + 1;
  const baseline: BaselineState = {
    entityId: input.baselineId,
    sequence,
    label: input.label ?? `Baseline ${sequence}`,
    supersedes: current.currentBaselineId,
    snapshot: snapshotOf(current),
    createdBy: input.createdBy ?? null,
    createdAt: input.now,
  };
  const next: ScheduleState = {
    ...current,
    baselines: { ...current.baselines, [input.baselineId]: baseline },
    currentBaselineId: input.baselineId,
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkState(next, context);
}

/** Parts of a new progress update (the canonical id is issued inside the handler). */
export interface NewProgressUpdate {
  readonly progressUpdateId: EntityId;
  readonly activityId: EntityId;
  readonly percentComplete: number;
  readonly remainingDuration: number;
  readonly actualStart?: Timestamp | null;
  readonly actualFinish?: Timestamp | null;
  readonly now: Timestamp;
}

/**
 * Pure transition: record one progress update against an activity —
 * APPEND-ONLY. The entry is added to the log; no earlier entry is ever
 * edited or deleted, and baselines are never touched (progress diverges the
 * CURRENT view from the baseline; that divergence is the variance).
 * Consistency rules (typed invariant-violations, state untouched): the
 * activity must exist; remainingDuration is zero exactly when complete;
 * actualFinish is present exactly when complete and never precedes
 * actualStart.
 */
export function recordProgressState(
  current: ScheduleState,
  input: NewProgressUpdate,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  if (current.activities[input.activityId] === undefined) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-progress-activity-exists',
          statement: `progress update ${input.progressUpdateId} addresses activity ${input.activityId}, which does not exist in schedule ${current.entityId}`,
        },
        context,
      ),
    );
  }
  const complete = input.percentComplete === 100;
  if (complete !== (input.remainingDuration === 0)) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-progress-completion-consistency',
          statement: `progress update ${input.progressUpdateId} for activity ${input.activityId} records ${input.percentComplete}% complete with remaining duration ${input.remainingDuration}; remaining duration must be zero exactly when work is 100% complete`,
        },
        context,
      ),
    );
  }
  if (complete !== (input.actualFinish !== null && input.actualFinish !== undefined)) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-progress-finish-pairs-with-completion',
          statement: `progress update ${input.progressUpdateId} for activity ${input.activityId} must carry an actual finish instant exactly when work is 100% complete`,
        },
        context,
      ),
    );
  }
  if (
    input.actualFinish !== null &&
    input.actualFinish !== undefined &&
    (input.actualStart === null || input.actualStart === undefined)
  ) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-progress-finish-requires-start',
          statement: `progress update ${input.progressUpdateId} for activity ${input.activityId} records an actual finish without an actual start`,
        },
        context,
      ),
    );
  }
  if (
    input.actualStart !== null &&
    input.actualStart !== undefined &&
    input.actualFinish !== null &&
    input.actualFinish !== undefined &&
    compareTimestamps(input.actualFinish, input.actualStart) < 0
  ) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-progress-actual-dates-ordered',
          statement: `progress update ${input.progressUpdateId} for activity ${input.activityId} records an actual finish earlier than its actual start`,
        },
        context,
      ),
    );
  }
  const entry: ProgressUpdateState = {
    entityId: input.progressUpdateId,
    activityId: input.activityId,
    percentComplete: input.percentComplete,
    remainingDuration: input.remainingDuration,
    actualStart: input.actualStart ?? null,
    actualFinish: input.actualFinish ?? null,
    recordedAt: input.now,
  };
  const next: ScheduleState = {
    ...current,
    progressUpdates: [...current.progressUpdates, entry],
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkState(next, context);
}

// ----- protected-baseline guards (acceptance: baselines are immutable) ------------

/**
 * THE baseline protection guard: editing a baseline is IMPOSSIBLE. There is
 * no edit transition on baselines; this total function encodes that absence
 * explicitly and always fails with a typed `forbidden` — a baseline, once
 * set, cannot be edited or deleted, and plan changes flow through activity
 * updates, progress updates and re-baselines only (each of which leaves
 * every existing baseline snapshot bit-identical).
 */
export function updateBaselineState(
  current: ScheduleState,
  baselineId: EntityId,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  return fail(
    domainError(
      'forbidden',
      `baseline ${baselineId} of schedule ${current.entityId} cannot be edited: baselines are immutable once set (supersede via a new baseline instead)`,
      [
        {
          code: 'schedule-baseline-immutable',
          message: `attempted to edit baseline ${baselineId}`,
          path: null,
        },
      ],
      context,
    ),
  );
}

/**
 * THE baseline protection guard: deleting a baseline is IMPOSSIBLE (deleted
 * history is a freeze anti-pattern). Always fails with a typed `forbidden`.
 */
export function removeBaselineState(
  current: ScheduleState,
  baselineId: EntityId,
  context?: DomainErrorContext,
): Result<ScheduleState, DomainError> {
  return fail(
    domainError(
      'forbidden',
      `baseline ${baselineId} of schedule ${current.entityId} cannot be deleted: baselines are immutable once set (supersede via a new baseline instead)`,
      [
        {
          code: 'schedule-baseline-immutable',
          message: `attempted to delete baseline ${baselineId}`,
          path: null,
        },
      ],
      context,
    ),
  );
}

// ----- derived reads (pure; never stored as truth) --------------------------------

/** The latest progress update recorded against an activity, or null. */
export const latestProgressFor = (
  state: ScheduleState,
  activityId: EntityId,
): ProgressUpdateState | null => {
  let latest: ProgressUpdateState | null = null;
  for (const entry of state.progressUpdates) {
    if (entry.activityId === activityId) latest = entry;
  }
  return latest;
};

/**
 * The current progress view per activity (deterministic derived read): the
 * LATEST log entry per activity. This is the progress input the forecast
 * consumes — projections are recomputed, never stored (freeze A3).
 */
export const latestProgressByActivity = (
  state: ScheduleState,
): Readonly<Record<string, ProgressUpdateState>> => {
  const byActivity: Record<string, ProgressUpdateState> = {};
  for (const entry of state.progressUpdates) {
    byActivity[entry.activityId] = entry;
  }
  return byActivity;
};
