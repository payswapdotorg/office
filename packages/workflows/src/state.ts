// Office workflow engine — aggregate states, invariants, transitions (OFF-016).
//
// The two aggregates of the Workflow & Approvals bounded context (freeze A1,
// context 12):
//
// * WorkflowDefinitionState — a versioned workflow DEFINITION. Draft
//   definitions may replace their model; PUBLISHING freezes them (there is
//   no mutating path afterwards — the model of a published definition is
//   immutable by construction). A definition change is a NEW definition row:
//   the next definitionVersion of the same key, created in 'draft' again.
//   Every instance pins the exact definition row it was started from, so old
//   instances are unaffected by later versions.
//
// * WorkflowInstanceState — a deterministic state machine over the pinned
//   definition's typed transition table. The machine functions in this
//   module are PURE: same definition + same instance state + same command
//   inputs → same resulting state, always; invalid transitions are
//   typed-rejected and the machine can never enter an undefined state (the
//   transition table is validated closed at definition parse time — every
//   target is a declared state — and every execution re-checks the source
//   state, the guard, and the required capabilities before moving).
//
// Transition execution order (the frozen discipline of this package):
//   guard evaluation → capability check → state transition → task lifecycle
//   updates → audit event (the event itself is built by events.ts from the
//   pure result — this module never touches a sink).
//
// Task lifecycle: created → assigned → in-progress → completed / skipped /
// failed, with typed terminal outcomes ('completed', 'skipped', 'failed'
// retryable, 'exhausted' terminal after the bounded retry policy is spent).
// Retries are deterministic: the backoff schedule is pure arithmetic on the
// definition's retry policy parameters — no wall clock, no randomness; `now`
// and canonical ids are always injected.
//
// Approvals: pending → submitted → approved / rejected. The capability gate
// (the approval's required capability + the caller's policy) is enforced by
// the command layer BEFORE decideWorkflowApprovalState runs — an
// approval-requiring action cannot bypass policy (freeze A8); this module's
// decide transition is reachable only through that gate.
//
// Escalation: SLA breach is measured against the INJECTED clock (never a
// wall clock) — escalateWorkflowInstanceState reassigns breached tasks per
// the definition's escalation rules and is auditable through the emitted
// event (the command layer derives it from the structured result).
//
// Timestamp arithmetic is pure civil-time integer math (no host Date
// parsing): timestamps convert to epoch milliseconds through the canonical
// UTC calendar, seconds are added as integers, and comparisons run at
// millisecond precision. Deterministic by construction.
import { parseEntityKind } from '@office/contracts';
import type { EntityId, EntityKind, EntityRef, Scope, Timestamp } from '@office/contracts';
import type { Capability } from '@office/authz';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { domainError, fail, invariantViolation, mapOk, ok } from '@office/domain-kernel';
import type {
  Aggregate,
  AggregateVersion,
  DomainError,
  DomainErrorContext,
  Result,
} from '@office/domain-kernel';
import { isWorkflowModel, retryBackoffSeconds } from './definition';
import type {
  ApprovalDecision,
  TaskOutcome,
  TransitionCondition,
  WorkflowEscalationRule,
  WorkflowModel,
  WorkflowRetryPolicy,
  WorkflowStateDefinition,
  WorkflowTransitionDefinition,
} from './definition';

const parsedKind = (literal: string, module: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    // Trusted-path literal: a violation means this module is malformed.
    throw new TypeError(
      `invalid ${module} entity kind literal: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
};

/** Canonical entity kind of the WorkflowDefinition aggregate. */
export const WORKFLOW_DEFINITION_KIND: EntityKind = parsedKind(
  'workflow-definition',
  'workflow definition',
);
/** Canonical entity kind of the WorkflowInstance aggregate. */
export const WORKFLOW_INSTANCE_KIND: EntityKind = parsedKind(
  'workflow-instance',
  'workflow instance',
);

// ----- pure timestamp arithmetic (no host Date, no wall clock) ------------------------

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** Days since 1970-01-01 of a civil (proleptic Gregorian) date (pure). */
const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
};

/** Civil date of a days-since-1970-01-01 count (pure). */
const civilFromDays = (days: number): { y: number; m: number; d: number } => {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) /
      365,
  );
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { y: month <= 2 ? year + 1 : year, m: month, d: day };
};

interface TimestampParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const timestampParts = (value: Timestamp): TimestampParts => {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    // Trusted path: the value was validated by parseTimestamp upstream.
    throw new TypeError(`invalid canonical timestamp: ${String(value)}`);
  }
  const fraction = match[7] ?? '';
  const millisecond =
    fraction === '' ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    millisecond,
  };
};

/**
 * Epoch milliseconds of a canonical Timestamp (pure civil-time arithmetic;
 * sub-millisecond digits are truncated — comparisons run at millisecond
 * precision, deterministically).
 */
export const timestampEpochMs = (value: Timestamp): number => {
  const parts = timestampParts(value);
  return (
    daysFromCivil(parts.year, parts.month, parts.day) * 86_400_000 +
    parts.hour * 3_600_000 +
    parts.minute * 60_000 +
    parts.second * 1000 +
    parts.millisecond
  );
};

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

const epochMsToTimestamp = (epochMs: number): Timestamp => {
  const days = Math.floor(epochMs / 86_400_000);
  const remainder = epochMs - days * 86_400_000;
  const { y, m, d } = civilFromDays(days);
  const hour = Math.floor(remainder / 3_600_000);
  const minute = Math.floor((remainder % 3_600_000) / 60_000);
  const second = Math.floor((remainder % 60_000) / 1000);
  const millisecond = remainder % 1000;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(
    second,
    2,
  )}.${pad(millisecond, 3)}Z` as Timestamp;
};

/**
 * Add whole seconds to a canonical Timestamp (pure; integer seconds only —
 * SLA minutes and backoff parameters are integers by definition). Throws
 * TypeError on a non-integer second count (loud, never silent).
 */
export const addSecondsToTimestamp = (value: Timestamp, seconds: number): Timestamp => {
  if (!Number.isInteger(seconds)) {
    throw new TypeError(`seconds must be an integer: ${String(seconds)}`);
  }
  return epochMsToTimestamp(timestampEpochMs(value) + seconds * 1000);
};

/**
 * Compare two canonical timestamps at millisecond precision: negative when
 * `a` is before `b`, 0 when equal, positive when after (pure, deterministic).
 */
export const compareTimestamps = (a: Timestamp, b: Timestamp): number =>
  timestampEpochMs(a) - timestampEpochMs(b);

// ----- WorkflowDefinition -----------------------------------------------------------

/** Lifecycle status of a workflow definition. `published` is frozen forever. */
export type WorkflowDefinitionStatus = 'draft' | 'published';

/** All workflow definition statuses, in canonical order. */
export const WORKFLOW_DEFINITION_STATUSES: readonly WorkflowDefinitionStatus[] = [
  'draft',
  'published',
] as const;

/**
 * The WorkflowDefinition aggregate state. `definitionVersion` is the workflow
 * MODEL version: a new version is a NEW definition row of the same key, so
 * the row itself is append-only in spirit — once published it never changes.
 */
export interface WorkflowDefinitionState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The workflow key (tenant/project-unique per version, e.g. 'change-order-approval'). */
  readonly key: string;
  /** The workflow model version of this row (1..N, monotonically issued). */
  readonly definitionVersion: number;
  /** Human-readable title (1..200 characters). */
  readonly title: string;
  /** Optional description (up to 2000 characters). */
  readonly description: string | null;
  /** Lifecycle status; 'published' means the model below is FROZEN. */
  readonly status: WorkflowDefinitionStatus;
  /** The typed workflow model (states/transitions/tasks/approvals/retry/escalation). */
  readonly model: WorkflowModel;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** When the definition was published; null while draft. */
  readonly publishedAt: Timestamp | null;
}

/**
 * Declarative invariants over any WorkflowDefinitionState, in declaration
 * order. checkInvariants stops at the first violation — deterministic.
 */
export const WORKFLOW_DEFINITION_INVARIANTS = [
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-key-grammar',
    'a workflow definition key is 1..64 lowercase kebab-case characters',
    (state) => /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/.test(state.key),
  ),
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-title-nonempty',
    'a workflow definition title is 1..200 characters',
    (state) => state.title.length >= 1 && state.title.length <= 200,
  ),
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-version-positive',
    'a workflow definition version is a positive integer',
    (state) => Number.isInteger(state.definitionVersion) && state.definitionVersion >= 1,
  ),
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-status-vocabulary',
    "a workflow definition status is 'draft' or 'published'",
    (state) =>
      (WORKFLOW_DEFINITION_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-published-timestamp-pairs-with-status',
    "publishedAt is non-null exactly while status is 'published'",
    (state) =>
      (state.status === 'draft' && state.publishedAt === null) ||
      (state.status === 'published' && state.publishedAt !== null),
  ),
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-model-structurally-valid',
    'the workflow model passes its own closed-table structural validation',
    (state) => isWorkflowModel(state.model),
  ),
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-is-project-scoped',
    'a workflow definition is owned by exactly one project scope (the second boundary, A12)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<WorkflowDefinitionState>(
    'workflow-definition-version-is-monotonic',
    'a workflow definition aggregate version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/** Parts of a newly created workflow definition (the canonical id is issued inside the handler). */
export interface NewWorkflowDefinition {
  readonly definitionId: EntityId;
  readonly key: string;
  readonly definitionVersion: number;
  readonly title: string;
  readonly description?: string | null;
  readonly model: WorkflowModel;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a new workflow definition (trusted path — the
 * key/title/model were validated fail-closed upstream). Returns the state
 * checked against every invariant.
 */
export function createWorkflowDefinitionState(
  input: NewWorkflowDefinition,
  scope: Scope,
  context?: DomainErrorContext,
): Result<WorkflowDefinitionState, DomainError> {
  const state: WorkflowDefinitionState = {
    entityKind: WORKFLOW_DEFINITION_KIND,
    entityId: input.definitionId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    key: input.key,
    definitionVersion: input.definitionVersion,
    title: input.title,
    description: input.description ?? null,
    status: 'draft',
    model: input.model,
    createdAt: input.now,
    updatedAt: input.now,
    publishedAt: null,
  };
  return checkInvariants(state, WORKFLOW_DEFINITION_INVARIANTS, context);
}

/**
 * Pure transition: replace the model of a DRAFT definition. A PUBLISHED
 * definition is immutable — there is no update path once published (typed
 * invariant-violation; a change is a NEW definition version instead).
 */
export function updateWorkflowDefinitionModelState(
  current: WorkflowDefinitionState,
  model: WorkflowModel,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowDefinitionState, DomainError> {
  if (current.status !== 'draft') {
    return fail(
      invariantViolation(
        {
          name: 'workflow-definition-published-immutable',
          statement: `workflow definition ${current.entityId} (${current.key} v${current.definitionVersion}) is '${current.status}'; published definitions are immutable — create the next version as a new definition`,
        },
        context,
      ),
    );
  }
  const next: WorkflowDefinitionState = {
    ...current,
    model,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, WORKFLOW_DEFINITION_INVARIANTS, context);
}

/**
 * Pure transition: publish a DRAFT definition — the freeze. The model never
 * changes after this; a definition change is a new version row. Publishing
 * an already-published definition is a typed invariant-violation.
 */
export function publishWorkflowDefinitionState(
  current: WorkflowDefinitionState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowDefinitionState, DomainError> {
  if (current.status !== 'draft') {
    return fail(
      invariantViolation(
        {
          name: 'workflow-definition-already-published',
          statement: `workflow definition ${current.entityId} (${current.key} v${current.definitionVersion}) is already published; publishing is a one-way freeze`,
        },
        context,
      ),
    );
  }
  const next: WorkflowDefinitionState = {
    ...current,
    status: 'published',
    publishedAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, WORKFLOW_DEFINITION_INVARIANTS, context);
}

/**
 * The next definition version of a key, deterministically from the existing
 * rows of that key in scope: max(definitionVersion) + 1, or 1 for a new key
 * (trusted path — the rows were validated on save).
 */
export function nextDefinitionVersionOf(
  existing: readonly WorkflowDefinitionState[],
): number {
  let max = 0;
  for (const row of existing) {
    if (row.definitionVersion > max) max = row.definitionVersion;
  }
  return max + 1;
}

// ----- WorkflowInstance: task + approval states --------------------------------------

/** Lifecycle status of an instance task. */
export type TaskStatus =
  | 'created'
  | 'assigned'
  | 'in-progress'
  | 'completed'
  | 'skipped'
  | 'failed';

/** All task statuses, in canonical lifecycle order. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'created',
  'assigned',
  'in-progress',
  'completed',
  'skipped',
  'failed',
] as const;

/** Lifecycle status of an instance approval step. */
export type ApprovalStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

/** All approval statuses, in canonical lifecycle order. */
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'submitted',
  'approved',
  'rejected',
] as const;

/**
 * One task of a workflow instance, instantiated from the pinned definition.
 * `attempts` counts STARTED attempts (start + retry); the bounded retry
 * policy of the definition caps it. `dueAt` is assignedAt + the definition's
 * SLA minutes (injected-clock arithmetic); `retryNotBefore` gates the
 * deterministic backoff; `escalated`/`escalatedAt` record the one-shot SLA
 * escalation.
 */
export interface TaskState {
  /** Task key, unique within the instance (from the pinned definition). */
  readonly key: string;
  /** Human-readable title (from the pinned definition). */
  readonly title: string;
  /** The workflow state this task belongs to (from the pinned definition). */
  readonly state: string;
  /** Lifecycle status; 'completed'/'skipped'/failed-exhausted are terminal. */
  readonly status: TaskStatus;
  /** Current assignee (null until assigned). */
  readonly assignee: EntityId | null;
  /** When the task was assigned; null while 'created'. */
  readonly assignedAt: Timestamp | null;
  /** SLA deadline (assignedAt + SLA minutes); null when no SLA or unassigned. */
  readonly dueAt: Timestamp | null;
  /** Count of started attempts (start + retries). */
  readonly attempts: number;
  /** When the task completed; null unless 'completed'. */
  readonly completedAt: Timestamp | null;
  /** When the task was skipped; null unless 'skipped'. */
  readonly skippedAt: Timestamp | null;
  /** When the task last failed; null unless 'failed'. */
  readonly failedAt: Timestamp | null;
  /** Typed terminal outcome; null while the task is unsettled. */
  readonly outcome: TaskOutcome | null;
  /** Reason recorded when the task was skipped. */
  readonly skipReason: string | null;
  /** Reason recorded at the last failure. */
  readonly failureReason: string | null;
  /** Earliest retry instant (failure instant + deterministic backoff); null outside 'failed' (retryable). */
  readonly retryNotBefore: Timestamp | null;
  /** Whether the one-shot SLA escalation has fired for this task. */
  readonly escalated: boolean;
  /** When the SLA escalation fired; null while not escalated. */
  readonly escalatedAt: Timestamp | null;
}

/**
 * One approval step of a workflow instance, instantiated from the pinned
 * definition. `requiredCapability` is THE gate: the step can only be decided
 * through the command layer's capability + policy check (freeze A8 — there
 * is no bypass path; see commands.ts).
 */
export interface ApprovalState {
  /** Approval key, unique within the instance (from the pinned definition). */
  readonly key: string;
  /** Human-readable title (from the pinned definition). */
  readonly title: string;
  /** The workflow state this approval belongs to (from the pinned definition). */
  readonly state: string;
  /** Lifecycle status; 'approved'/'rejected' are terminal. */
  readonly status: ApprovalStatus;
  /** THE required capability (from the pinned definition — the decision gate). */
  readonly requiredCapability: Capability;
  /** Policy reference governing the step (from the pinned definition). */
  readonly policyRef: string;
  /** Who submitted the approval request; null while 'pending'. */
  readonly submittedBy: EntityId | null;
  /** When the request was submitted; null while 'pending'. */
  readonly submittedAt: Timestamp | null;
  /** Who decided; null until decided. */
  readonly decidedBy: EntityId | null;
  /** When the decision was recorded; null until decided. */
  readonly decidedAt: Timestamp | null;
  /** Optional note recorded with the decision. */
  readonly decisionNote: string | null;
}

/** Lifecycle status of a workflow instance; terminal states never change. */
export type WorkflowInstanceStatus = 'running' | 'completed' | 'failed';

/** All workflow instance statuses, in canonical order. */
export const WORKFLOW_INSTANCE_STATUSES: readonly WorkflowInstanceStatus[] = [
  'running',
  'completed',
  'failed',
] as const;

/**
 * The WorkflowInstance aggregate state: the deterministic machine over the
 * PINNED definition (definitionId + key + version recorded; old instances
 * are unaffected by later definition versions). `currentState` is always a
 * declared state of the pinned model — the machine can never enter an
 * undefined state (closed table + typed rejections).
 */
export interface WorkflowInstanceState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The pinned definition row this instance executes. */
  readonly definitionId: EntityId;
  /** The pinned definition's key (readable pin). */
  readonly definitionKey: string;
  /** The pinned definition's model version (readable pin). */
  readonly definitionVersion: number;
  /** The subject this workflow is about (typed EntityRef, never copied). */
  readonly subject: EntityRef;
  /** The machine's current state (a declared state of the pinned model). */
  readonly currentState: string;
  /** Instance lifecycle; 'completed'/'failed' are terminal. */
  readonly status: WorkflowInstanceStatus;
  /** The instance's tasks, in definition order. */
  readonly tasks: readonly TaskState[];
  /** The instance's approval steps, in definition order. */
  readonly approvals: readonly ApprovalState[];
  readonly startedAt: Timestamp;
  /** When the machine reached a 'success' state; null unless 'completed'. */
  readonly completedAt: Timestamp | null;
  /** When the machine reached a 'failure' state; null unless 'failed'. */
  readonly failedAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

const taskKeyList = (state: WorkflowInstanceState): readonly string[] =>
  state.tasks.map((task) => task.key);

const approvalKeyList = (state: WorkflowInstanceState): readonly string[] =>
  state.approvals.map((approval) => approval.key);

const hasDuplicates = (values: readonly string[]): boolean =>
  new Set(values).size !== values.length;

/** Is a task settled (lifecycle reached a terminal-or-recorded outcome)? */
const isTaskSettled = (task: TaskState): boolean =>
  task.status === 'completed' || task.status === 'skipped';

/**
 * Declarative invariants over any WorkflowInstanceState, in declaration
 * order. The machine's structural safety lives here: unique task/approval
 * keys, statuses from the closed vocabularies, outcome/timestamp pairing,
 * SLA/assignment pairing, and the terminal-instance pairing.
 */
export const WORKFLOW_INSTANCE_INVARIANTS = [
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-pins-definition',
    'a workflow instance pins a definition row (id, key, positive version)',
    (state) =>
      state.definitionVersion >= 1 &&
      state.definitionKey.length >= 1 &&
      state.definitionKey.length <= 64,
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-status-vocabulary',
    "a workflow instance status is 'running', 'completed', or 'failed'",
    (state) =>
      (WORKFLOW_INSTANCE_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-current-state-named',
    'the machine always sits in a named (kebab-case) state of its pinned model',
    (state) => /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/.test(state.currentState),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-completion-timestamps-pair-with-status',
    'completedAt/failedAt are non-null exactly for their terminal statuses',
    (state) =>
      (state.status === 'running' && state.completedAt === null && state.failedAt === null) ||
      (state.status === 'completed' && state.completedAt !== null && state.failedAt === null) ||
      (state.status === 'failed' && state.failedAt !== null && state.completedAt === null),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-task-keys-unique',
    'task keys are unique within the instance',
    (state) => !hasDuplicates(taskKeyList(state)),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-approval-keys-unique',
    'approval keys are unique within the instance',
    (state) => !hasDuplicates(approvalKeyList(state)),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-task-statuses-vocabulary',
    'every task status is from the closed lifecycle vocabulary',
    (state) =>
      state.tasks.every((task) => (TASK_STATUSES as readonly string[]).includes(task.status)),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-approval-statuses-vocabulary',
    'every approval status is from the closed lifecycle vocabulary',
    (state) =>
      state.approvals.every((approval) =>
        (APPROVAL_STATUSES as readonly string[]).includes(approval.status),
      ),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-task-outcome-pairs-with-status',
    "a task outcome is null exactly while its status is 'created', 'assigned', or 'in-progress'",
    (state) =>
      state.tasks.every(
        (task) =>
          (['created', 'assigned', 'in-progress'] as readonly string[]).includes(task.status) ===
          (task.outcome === null),
      ),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-task-attempts-bounded',
    'task attempts are non-negative integers bounded by a sane ceiling',
    (state) =>
      state.tasks.every(
        (task) =>
          Number.isInteger(task.attempts) && task.attempts >= 0 && task.attempts <= 1000,
      ),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-task-sla-pairs-with-assignment',
    'a task dueAt/assignment/escalation timestamps pair with their lifecycle fields (a task may settle as skipped without ever being assigned)',
    (state) =>
      state.tasks.every(
        (task) => {
          // 'assigned'/'in-progress'/'completed'/'failed' all require an
          // assignee; 'created' never has one; 'skipped' may have been
          // settled straight from 'created' (no assignment) or later.
          const requiresAssignee =
            task.status === 'assigned' ||
            task.status === 'in-progress' ||
            task.status === 'completed' ||
            task.status === 'failed';
          return (
            (task.assignedAt !== null || !requiresAssignee) &&
            (task.status !== 'created' || task.assignedAt === null) &&
            (task.dueAt !== null ? task.assignedAt !== null : true) &&
            (task.escalated ? task.escalatedAt !== null : task.escalatedAt === null)
          );
        },
      ),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-approval-timestamps-pair-with-status',
    "approval submittedAt is non-null exactly from 'submitted' onwards; decidedAt exactly once decided",
    (state) =>
      state.approvals.every(
        (approval) =>
          (approval.status === 'pending') === (approval.submittedAt === null) &&
          (['approved', 'rejected'] as readonly string[]).includes(approval.status) ===
            (approval.decidedAt !== null),
      ),
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-is-project-scoped',
    'a workflow instance is owned by exactly one project scope (the second boundary, A12)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<WorkflowInstanceState>(
    'workflow-instance-version-is-monotonic',
    'a workflow instance version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

// ----- instance creation --------------------------------------------------------------

/** Parts of a newly started workflow instance. */
export interface NewWorkflowInstance {
  readonly instanceId: EntityId;
  /** The typed subject EntityRef this workflow is about (never copied). */
  readonly subject: EntityRef;
  readonly now: Timestamp;
}

/** Find the initial state of a model (trusted path — exactly one by validation). */
const initialStateOf = (model: WorkflowModel): WorkflowStateDefinition => {
  const initial = model.states.find((state) => state.kind === 'initial');
  if (initial === undefined) {
    throw new TypeError('workflow model has no initial state (validated at parse)');
  }
  return initial;
};

/**
 * Build the initial state of a workflow instance from its PINNED definition:
 * the machine starts in the definition's initial state; tasks are
 * instantiated 'created' (attempt 0, no SLA yet); approvals are instantiated
 * 'pending'. Only PUBLISHED definitions can start instances (typed
 * invariant-violation otherwise — drafts are not executable blueprints).
 */
export function createWorkflowInstanceState(
  definition: WorkflowDefinitionState,
  input: NewWorkflowInstance,
  scope: Scope,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  if (definition.status !== 'published') {
    return fail(
      invariantViolation(
        {
          name: 'workflow-definition-not-published',
          statement: `workflow definition ${definition.entityId} (${definition.key} v${definition.definitionVersion}) is '${definition.status}'; instances start only from published definitions`,
        },
        context,
      ),
    );
  }
  const state: WorkflowInstanceState = {
    entityKind: WORKFLOW_INSTANCE_KIND,
    entityId: input.instanceId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    definitionId: definition.entityId,
    definitionKey: definition.key,
    definitionVersion: definition.definitionVersion,
    subject: input.subject,
    currentState: initialStateOf(definition.model).name,
    status: 'running',
    tasks: definition.model.tasks.map(
      (task): TaskState => ({
        key: task.key,
        title: task.title,
        state: task.state,
        status: 'created',
        assignee: null,
        assignedAt: null,
        dueAt: null,
        attempts: 0,
        completedAt: null,
        skippedAt: null,
        failedAt: null,
        outcome: null,
        skipReason: null,
        failureReason: null,
        retryNotBefore: null,
        escalated: false,
        escalatedAt: null,
      }),
    ),
    approvals: definition.model.approvals.map(
      (approval): ApprovalState => ({
        key: approval.key,
        title: approval.title,
        state: approval.state,
        status: 'pending',
        requiredCapability: approval.requiredCapability,
        policyRef: approval.policyRef,
        submittedBy: null,
        submittedAt: null,
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      }),
    ),
    startedAt: input.now,
    completedAt: null,
    failedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(state, WORKFLOW_INSTANCE_INVARIANTS, context);
}

// ----- shared lookup/guard helpers (package-internal) ---------------------------------

const requireRunning = (
  current: WorkflowInstanceState,
  context?: DomainErrorContext,
): Result<true, DomainError> => {
  if (current.status === 'running') return ok(true);
  return fail(
    invariantViolation(
      {
        name: 'workflow-instance-terminal',
        statement: `workflow instance ${current.entityId} is '${current.status}' (terminal since ${
          current.completedAt ?? current.failedAt ?? current.updatedAt
        }); terminal instances never change`,
      },
      context,
    ),
  );
};

const findTask = (current: WorkflowInstanceState, taskKey: string): TaskState | undefined =>
  current.tasks.find((task) => task.key === taskKey);

const findApproval = (
  current: WorkflowInstanceState,
  approvalKey: string,
): ApprovalState | undefined =>
  current.approvals.find((approval) => approval.key === approvalKey);

const taskNotFound = (
  instance: WorkflowInstanceState,
  taskKey: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'not-found',
    `task '${taskKey}' not found on workflow instance ${instance.entityId} (pinned definition ${instance.definitionKey} v${instance.definitionVersion})`,
    [{ code: 'task-not-found', message: `task key '${taskKey}'`, path: 'taskKey' }],
    context,
  );

const approvalNotFound = (
  instance: WorkflowInstanceState,
  approvalKey: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'not-found',
    `approval '${approvalKey}' not found on workflow instance ${instance.entityId} (pinned definition ${instance.definitionKey} v${instance.definitionVersion})`,
    [{ code: 'approval-not-found', message: `approval key '${approvalKey}'`, path: 'approvalKey' }],
    context,
  );

const wrongTaskStatus = (
  task: TaskState,
  expected: readonly TaskStatus[],
  action: string,
  context?: DomainErrorContext,
): DomainError =>
  invariantViolation(
    {
      name: 'workflow-task-status-guard',
      statement: `task '${task.key}' on workflow instance is '${task.status}'; ${action} requires ${expected
        .map((status) => `'${status}'`)
        .join(' or ')}`,
    },
    context,
  );

const wrongApprovalStatus = (
  approval: ApprovalState,
  expected: readonly ApprovalStatus[],
  action: string,
  context?: DomainErrorContext,
): DomainError =>
  invariantViolation(
    {
      name: 'workflow-approval-status-guard',
      statement: `approval '${approval.key}' on workflow instance is '${approval.status}'; ${action} requires ${expected
        .map((status) => `'${status}'`)
        .join(' or ')}`,
    },
    context,
  );

/** Map the tasks of an instance (positional — definition order is stable). */
const mapTasks = (
  current: WorkflowInstanceState,
  update: (task: TaskState) => TaskState,
): WorkflowInstanceState => ({
  ...current,
  tasks: current.tasks.map(update),
});

// ----- task lifecycle transitions -----------------------------------------------------

/**
 * Pure transition: assign a 'created' task to an actor. Assignment is one-way
 * from 'created' (reassignment is the definition-driven escalation path);
 * the SLA deadline is assignedAt + the definition's SLA minutes, computed
 * with pure timestamp arithmetic from the INJECTED now.
 */
export function assignWorkflowTaskState(
  current: WorkflowInstanceState,
  taskKey: string,
  assignee: EntityId,
  slaMinutes: number | null,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const task = findTask(current, taskKey);
  if (task === undefined) return fail(taskNotFound(current, taskKey, context));
  if (task.status !== 'created') {
    return fail(wrongTaskStatus(task, ['created'], 'assignment', context));
  }
  const assignedAt = now;
  const dueAt =
    slaMinutes === null ? null : addSecondsToTimestamp(assignedAt, slaMinutes * 60);
  const mapped = mapTasks(current, (task): TaskState =>
    task.key === taskKey
      ? { ...task, status: 'assigned', assignee, assignedAt, dueAt }
      : task,
  );
  return checkInvariants(
    { ...mapped, version: nextAggregateVersion(current.version), updatedAt: now },
    WORKFLOW_INSTANCE_INVARIANTS,
    context,
  );
}

/**
 * Pure transition: start a 'assigned' task — the first attempt
 * (attempts becomes 1). Only an assigned task can start.
 */
export function startWorkflowTaskState(
  current: WorkflowInstanceState,
  taskKey: string,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const task = findTask(current, taskKey);
  if (task === undefined) return fail(taskNotFound(current, taskKey, context));
  if (task.status !== 'assigned') {
    return fail(wrongTaskStatus(task, ['assigned'], 'start', context));
  }
  const mapped = mapTasks(current, (task): TaskState =>
    task.key === taskKey ? { ...task, status: 'in-progress', attempts: task.attempts + 1 } : task,
  );
  return checkInvariants(
    { ...mapped, version: nextAggregateVersion(current.version), updatedAt: now },
    WORKFLOW_INSTANCE_INVARIANTS,
    context,
  );
}

/**
 * Pure transition: complete an 'in-progress' task — the terminal success of
 * the task lifecycle (outcome 'completed').
 */
export function completeWorkflowTaskState(
  current: WorkflowInstanceState,
  taskKey: string,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const task = findTask(current, taskKey);
  if (task === undefined) return fail(taskNotFound(current, taskKey, context));
  if (task.status !== 'in-progress') {
    return fail(wrongTaskStatus(task, ['in-progress'], 'completion', context));
  }
  const mapped = mapTasks(current, (task): TaskState =>
    task.key === taskKey
      ? { ...task, status: 'completed', completedAt: now, outcome: 'completed' }
      : task,
  );
  return checkInvariants(
    { ...mapped, version: nextAggregateVersion(current.version), updatedAt: now },
    WORKFLOW_INSTANCE_INVARIANTS,
    context,
  );
}

/**
 * Pure transition: skip an open task ('created', 'assigned', or
 * 'in-progress') with a required reason — outcome 'skipped'. Used both by
 * operators and by the machine's deterministic leave-state cascade.
 */
export function skipWorkflowTaskState(
  current: WorkflowInstanceState,
  taskKey: string,
  reason: string,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const task = findTask(current, taskKey);
  if (task === undefined) return fail(taskNotFound(current, taskKey, context));
  if (
    task.status !== 'created' &&
    task.status !== 'assigned' &&
    task.status !== 'in-progress'
  ) {
    return fail(
      wrongTaskStatus(task, ['created', 'assigned', 'in-progress'], 'skip', context),
    );
  }
  const mapped = mapTasks(current, (task): TaskState =>
    task.key === taskKey
      ? {
          ...task,
          status: 'skipped',
          skippedAt: now,
          outcome: 'skipped',
          skipReason: reason,
        }
      : task,
  );
  return checkInvariants(
    { ...mapped, version: nextAggregateVersion(current.version), updatedAt: now },
    WORKFLOW_INSTANCE_INVARIANTS,
    context,
  );
}

/**
 * Pure transition: record the failure of an 'in-progress' task attempt. When
 * the started attempts have NOT yet exhausted the definition's bounded retry
 * policy, the task stays retryable: outcome 'failed' with a deterministic
 * backoff gate (retryNotBefore = failure instant + backoff(attempts), pure
 * arithmetic on the definition's parameters). When the attempts ARE spent,
 * the task reaches the typed terminal state: outcome 'exhausted'.
 */
export function failWorkflowTaskState(
  current: WorkflowInstanceState,
  taskKey: string,
  reason: string,
  retryPolicy: WorkflowRetryPolicy,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const task = findTask(current, taskKey);
  if (task === undefined) return fail(taskNotFound(current, taskKey, context));
  if (task.status !== 'in-progress') {
    return fail(wrongTaskStatus(task, ['in-progress'], 'failure', context));
  }
  const exhausted = task.attempts >= retryPolicy.maxAttempts;
  const mapped = mapTasks(current, (t): TaskState =>
    t.key === taskKey
      ? {
          ...t,
          status: 'failed',
          failedAt: now,
          outcome: exhausted ? 'exhausted' : 'failed',
          failureReason: reason,
          retryNotBefore: exhausted
            ? null
            : addSecondsToTimestamp(now, retryBackoffSeconds(retryPolicy, t.attempts)),
        }
      : t,
  );
  return checkInvariants(
    { ...mapped, version: nextAggregateVersion(current.version), updatedAt: now },
    WORKFLOW_INSTANCE_INVARIANTS,
    context,
  );
}

/**
 * Pure transition: retry a retryable 'failed' task — a new attempt
 * (attempts + 1, back to 'in-progress'). Guarded three ways, typed:
 * the task must not be exhausted (the bounded policy is spent → terminal),
 * and the deterministic backoff gate must have elapsed
 * (now >= retryNotBefore — injected clock, never wall clock).
 */
export function retryWorkflowTaskState(
  current: WorkflowInstanceState,
  taskKey: string,
  retryPolicy: WorkflowRetryPolicy,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const task = findTask(current, taskKey);
  if (task === undefined) return fail(taskNotFound(current, taskKey, context));
  if (task.status !== 'failed') {
    return fail(wrongTaskStatus(task, ['failed'], 'retry', context));
  }
  if (task.outcome === 'exhausted') {
    return fail(
      invariantViolation(
        {
          name: 'workflow-task-retries-exhausted',
          statement: `task '${task.key}' has exhausted its bounded retry policy (${retryPolicy.maxAttempts} attempts) and is terminally failed; no retry path exists`,
        },
        context,
      ),
    );
  }
  if (task.retryNotBefore === null || compareTimestamps(now, task.retryNotBefore) < 0) {
    return fail(
      invariantViolation(
        {
          name: 'workflow-task-retry-backoff-not-elapsed',
          statement: `task '${task.key}' cannot retry before its deterministic backoff gate ${String(
            task.retryNotBefore,
          )} (now ${String(now)})`,
        },
        context,
      ),
    );
  }
  if (task.attempts >= retryPolicy.maxAttempts) {
    return fail(
      invariantViolation(
        {
          name: 'workflow-task-retries-exhausted',
          statement: `task '${task.key}' has started ${task.attempts} of ${retryPolicy.maxAttempts} allowed attempts; the retry policy is exhausted`,
        },
        context,
      ),
    );
  }
  // The attempt re-opens the task lifecycle: outcome/failure fields reset
  // (the task is unsettled again — the outcome invariant pairs null outcomes
  // with open statuses), while the audit trail of the failure and the retry
  // lives in the TASK_FAILED / TASK_RETRIED events, never in the aggregate.
  const mapped = mapTasks(current, (task): TaskState =>
    task.key === taskKey
      ? {
          ...task,
          status: 'in-progress',
          attempts: task.attempts + 1,
          failedAt: null,
          outcome: null,
          failureReason: null,
          retryNotBefore: null,
        }
      : task,
  );
  return checkInvariants(
    { ...mapped, version: nextAggregateVersion(current.version), updatedAt: now },
    WORKFLOW_INSTANCE_INVARIANTS,
    context,
  );
}

// ----- approval lifecycle transitions -------------------------------------------------

/**
 * Pure transition: submit a 'pending' approval request for decision (the
 * request phase — the decision phase is capability-gated in commands.ts).
 */
export function submitWorkflowApprovalState(
  current: WorkflowInstanceState,
  approvalKey: string,
  submittedBy: EntityId | null,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const approval = findApproval(current, approvalKey);
  if (approval === undefined) return fail(approvalNotFound(current, approvalKey, context));
  if (approval.status !== 'pending') {
    return fail(wrongApprovalStatus(approval, ['pending'], 'submission', context));
  }
  const next: WorkflowInstanceState = {
    ...current,
    approvals: current.approvals.map((a) =>
      a.key === approvalKey
        ? { ...a, status: 'submitted', submittedBy, submittedAt: now }
        : a,
    ),
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, WORKFLOW_INSTANCE_INVARIANTS, context);
}

/**
 * Pure transition: record the DECISION of a 'submitted' approval — approved
 * or rejected, with the deciding actor and an optional note. Reachable only
 * through the command layer's capability + policy gate (the required
 * capability is carried ON the approval so every reader can verify what
 * should have been held); this function itself never re-derives policy.
 */
export function decideWorkflowApprovalState(
  current: WorkflowInstanceState,
  approvalKey: string,
  decision: ApprovalDecision,
  decidedBy: EntityId | null,
  note: string | null,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowInstanceState, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;
  const approval = findApproval(current, approvalKey);
  if (approval === undefined) return fail(approvalNotFound(current, approvalKey, context));
  if (approval.status !== 'submitted') {
    return fail(wrongApprovalStatus(approval, ['submitted'], `decision (${decision})`, context));
  }
  const next: WorkflowInstanceState = {
    ...current,
    approvals: current.approvals.map((a) =>
      a.key === approvalKey
        ? {
            ...a,
            status: decision,
            decidedBy,
            decidedAt: now,
            decisionNote: note,
          }
        : a,
    ),
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, WORKFLOW_INSTANCE_INVARIANTS, context);
}

// ----- THE deterministic transition machine -------------------------------------------

/** The structured result of one machine transition (for audit events). */
export interface WorkflowTransitionResult {
  /** The committed next instance state. */
  readonly state: WorkflowInstanceState;
  /** The transition definition that executed (guard/capabilities carried). */
  readonly transition: WorkflowTransitionDefinition;
  /** Open tasks of the departed state the machine settled as 'skipped'. */
  readonly skippedTasks: readonly TaskState[];
}

/**
 * Evaluate one guard condition against an instance state (pure; the closed
 * vocabulary of definition.ts — 'task-outcome' matches the task's typed
 * outcome, 'approval-decision' the approval's decision, 'all-tasks-settled'
 * every task of a state being completed/skipped).
 */
export function conditionHolds(
  condition: TransitionCondition,
  instance: WorkflowInstanceState,
): boolean {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'task-outcome':
      return findTask(instance, condition.task)?.outcome === condition.outcome;
    case 'approval-decision':
      return findApproval(instance, condition.approval)?.status === condition.decision;
    case 'all-tasks-settled': {
      const bound = instance.tasks.filter((task) => task.state === condition.state);
      return bound.length > 0 && bound.every(isTaskSettled);
    }
  }
}

const describeCondition = (condition: TransitionCondition): string => {
  switch (condition.kind) {
    case 'always':
      return 'always';
    case 'task-outcome':
      return `task-outcome ${condition.task}=${condition.outcome}`;
    case 'approval-decision':
      return `approval-decision ${condition.approval}=${condition.decision}`;
    case 'all-tasks-settled':
      return `all-tasks-settled ${condition.state}`;
  }
};

/**
 * THE deterministic transition execution (pure): same definition + same
 * instance state + same granted capabilities + same now → same resulting
 * state, always. Execution order (frozen): guard evaluation → capability
 * check → state transition → task lifecycle updates. Every failure is typed
 * and leaves the machine untouched — it can never enter an undefined state
 * (targets are declared states by validated definitions, re-checked here).
 */
export function transitionWorkflowInstanceState(
  model: WorkflowModel,
  current: WorkflowInstanceState,
  transitionKey: string,
  grantedCapabilities: readonly Capability[],
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowTransitionResult, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;

  const transition = model.transitions.find((t) => t.key === transitionKey);
  if (transition === undefined) {
    return fail(
      invariantViolation(
        {
          name: 'workflow-transition-unknown',
          statement: `transition '${transitionKey}' is not declared by the pinned definition (pinned ${current.definitionKey} v${current.definitionVersion}); the machine only executes declared transitions`,
        },
        context,
      ),
    );
  }

  if (transition.from !== current.currentState) {
    return fail(
      invariantViolation(
        {
          name: 'workflow-transition-not-from-current-state',
          statement: `transition '${transitionKey}' starts from state '${transition.from}' but the machine is in '${current.currentState}'`,
        },
        context,
      ),
    );
  }

  for (const condition of transition.conditions) {
    if (!conditionHolds(condition, current)) {
      return fail(
        invariantViolation(
          {
            name: 'workflow-transition-guard-not-satisfied',
            statement: `transition '${transitionKey}' guard not satisfied: ${describeCondition(
              condition,
            )} does not hold in state '${current.currentState}'`,
          },
          context,
        ),
      );
    }
  }

  for (const required of transition.requiredCapabilities) {
    if (!grantedCapabilities.includes(required)) {
      return fail(
        domainError(
          'forbidden',
          `transition '${transitionKey}' requires capability '${required}' which the actor does not hold`,
          [
            {
              code: 'missing-required-capability',
              message: `transition '${transitionKey}' requires '${required}'`,
              path: 'transitionKey',
            },
          ],
          context,
        ),
      );
    }
  }

  const targetState = model.states.find((state) => state.name === transition.to);
  if (targetState === undefined) {
    // Defense in depth: validated definitions cannot reach this — a machine
    // can NEVER enter an undefined state (loud, never silent).
    return fail(
      invariantViolation(
        {
          name: 'workflow-transition-target-undeclared',
          statement: `transition '${transitionKey}' targets state '${transition.to}' which is not declared by the pinned definition; refusing to enter an undefined state`,
        },
        context,
      ),
    );
  }

  // Task lifecycle updates: leaving a state settles its still-open tasks.
  const skippedTasks = current.tasks.filter(
    (task) =>
      task.state === transition.from &&
      (task.status === 'created' || task.status === 'assigned' || task.status === 'in-progress'),
  );
  const tasks = current.tasks.map((task): TaskState => {
    if (skippedTasks.some((skipped) => skipped.key === task.key)) {
      return {
        ...task,
        status: 'skipped',
        skippedAt: now,
        outcome: 'skipped' as TaskOutcome,
        skipReason: `workflow-left-state-${transition.from}`,
      };
    }
    return task;
  });

  const next: WorkflowInstanceState = {
    ...current,
    currentState: transition.to,
    tasks,
    status:
      targetState.kind === 'success'
        ? 'completed'
        : targetState.kind === 'failure'
          ? 'failed'
          : current.status,
    completedAt: targetState.kind === 'success' ? now : current.completedAt,
    failedAt: targetState.kind === 'failure' ? now : current.failedAt,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return mapOk(checkInvariants(next, WORKFLOW_INSTANCE_INVARIANTS, context), (state) => ({
    state,
    transition,
    skippedTasks,
  }));
}

// ----- SLA escalation ------------------------------------------------------------------

/** One executed SLA escalation (for the audit event). */
export interface EscalatedTaskRecord {
  /** The escalated task's key. */
  readonly key: string;
  /** The assignee before escalation (null when unassigned). */
  readonly from: EntityId | null;
  /** The definition-driven reassignment target. */
  readonly to: EntityId;
  /** The breached SLA deadline. */
  readonly dueAt: Timestamp;
}

/** The structured result of one escalation sweep. */
export interface WorkflowEscalationResult {
  /** The committed next instance state (the input unchanged when nothing escalated). */
  readonly state: WorkflowInstanceState;
  /** The escalations that fired, in task order (for the audit events). */
  readonly escalatedTasks: readonly EscalatedTaskRecord[];
}

const matchingEscalationRule = (
  rules: readonly WorkflowEscalationRule[],
  taskKey: string,
): WorkflowEscalationRule | undefined =>
  rules.find((rule) => rule.task === taskKey || rule.task === '*');

/**
 * Pure SLA-escalation sweep over one instance, measured against the INJECTED
 * clock: a task escalates exactly when its SLA deadline has been reached
 * (now >= dueAt, millisecond precision), it is still open ('assigned' or
 * 'in-progress'), it has not escalated before (one-shot), and the pinned
 * definition carries an escalation rule for it (task key or '*').
 * Escalation REASSIGNS the task per the definition rule — the machine never
 * invents an assignee. Tasks without a breached SLA (or without a rule) are
 * untouched; when nothing escalates the instance is returned unchanged (no
 * version bump, no event).
 */
export function escalateWorkflowInstanceState(
  model: WorkflowModel,
  current: WorkflowInstanceState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<WorkflowEscalationResult, DomainError> {
  const running = requireRunning(current, context);
  if (!running.ok) return running;

  const escalatedTasks: EscalatedTaskRecord[] = [];
  const tasks = current.tasks.map((task): TaskState => {
    if (
      task.dueAt === null ||
      task.escalated ||
      (task.status !== 'assigned' && task.status !== 'in-progress') ||
      compareTimestamps(now, task.dueAt) < 0
    ) {
      return task;
    }
    const rule = matchingEscalationRule(model.escalationRules, task.key);
    if (rule === undefined) return task;
    escalatedTasks.push({
      key: task.key,
      from: task.assignee,
      to: rule.reassignTo,
      dueAt: task.dueAt,
    });
    return { ...task, assignee: rule.reassignTo, escalated: true, escalatedAt: now };
  });

  if (escalatedTasks.length === 0) {
    return ok({ state: current, escalatedTasks });
  }
  const next: WorkflowInstanceState = {
    ...current,
    tasks,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return mapOk(checkInvariants(next, WORKFLOW_INSTANCE_INVARIANTS, context), (state) => ({
    state,
    escalatedTasks,
  }));
}
