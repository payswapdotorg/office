// Office workflow engine — the versioned workflow DEFINITION model (OFF-016).
//
// A WorkflowDefinition is the immutable-by-publication blueprint of a
// workflow: typed states, typed transitions (guarded by a closed condition
// vocabulary + required capabilities), task definitions (assignment actor
// kinds/roles, SLA windows), approval steps (required capability + policy
// reference), a typed bounded retry policy, and SLA escalation rules with
// definition-driven reassignment.
//
// Versioning + immutability (THE definition acceptance):
// - a definition is identified by (key, definitionVersion) within its scope;
// - a DRAFT definition may be updated (model replacement) — every replacement
//   is a full re-validation, fail-closed;
// - PUBLISHING freezes it: once 'published', the model can never change (a
//   typed invariant-violation — there is no mutating path at all);
// - a definition CHANGE is therefore a NEW definition row (the next
//   definitionVersion of the same key), created in 'draft' again;
// - workflow INSTANCES pin the exact definition row they were started from
//   (see state.ts) — old instances are unaffected by later versions.
//
// This module holds ONLY the typed model + its fail-closed parsers and
// structural validation. The aggregate states and pure lifecycle transitions
// of definitions and instances live in state.ts; command orchestration lives
// in commands.ts.
//
// The transition table is DATA, never code: guards are a closed vocabulary of
// declarative conditions evaluated deterministically against the instance
// state (see state.ts conditionHolds), and required capabilities are declared
// capability names checked against the granted capability set. The table is
// validated CLOSED at parse time: every from/to is a declared state, terminal
// states have no outgoing transitions, the initial state is never re-entered,
// every referenced task/approval/state key is declared — so the machine can
// never be handed a definition through which it could enter an undefined
// state.
import { parseEntityId } from '@office/contracts';
import type { EntityId, ParseResult } from '@office/contracts';
import { parseCapability } from '@office/authz';
import type { Capability } from '@office/authz';
import { parseFail, parseOk } from '@office/contracts';
import {
  describeValue,
  isPlainObject,
  optionalNullableFieldWith,
  optionalSelfPathedField,
  parseBoundedInteger,
  parseLiteralOf,
  parseStringLike,
  parseValueArrayWith,
  requireFieldWith,
  requireSelfPathedField,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { StringRule } from './parse';

// ----- vocabularies ----------------------------------------------------------------

/** Lifecycle kinds of a workflow state in a definition. */
export type WorkflowStateKind = 'initial' | 'normal' | 'success' | 'failure';

/** All workflow state kinds, in canonical order. */
export const WORKFLOW_STATE_KINDS: readonly WorkflowStateKind[] = [
  'initial',
  'normal',
  'success',
  'failure',
] as const;

/** Typed terminal outcomes of a task lifecycle. */
export type TaskOutcome = 'completed' | 'skipped' | 'failed' | 'exhausted';

/** All task outcomes, in canonical order. */
export const TASK_OUTCOMES: readonly TaskOutcome[] = [
  'completed',
  'skipped',
  'failed',
  'exhausted',
] as const;

/** The decisions an approval step can carry. */
export type ApprovalDecision = 'approved' | 'rejected';

/** All approval decisions, in canonical order. */
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  'approved',
  'rejected',
] as const;

/** The closed condition vocabulary of transition guards. */
export const CONDITION_KINDS: readonly string[] = [
  'always',
  'task-outcome',
  'approval-decision',
  'all-tasks-settled',
] as const;

/** The actor-kind vocabulary task assignments may declare (contracts Actor). */
export const ASSIGNABLE_ACTOR_KINDS: readonly string[] = [
  'user',
  'agent',
  'app',
  'adapter',
  'system',
] as const;

/** Upper bound of SLA windows (minutes) — one calendar year. */
export const MAX_SLA_MINUTES = 525_600;
/** Upper bound of retry attempts per task. */
export const MAX_RETRY_ATTEMPTS = 20;
/** Upper bound of the retry backoff base (seconds) — one day. */
export const MAX_BACKOFF_BASE_SECONDS = 86_400;
/** Upper bound of the retry backoff ceiling (seconds) — one week. */
export const MAX_BACKOFF_MAX_SECONDS = 604_800;

// ----- string rules ------------------------------------------------------------------

const NAME_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case name (state/transition/task/approval key)',
};
const TITLE_RULE: StringRule = { min: 1, max: 200, description: 'title' };
const DESCRIPTION_RULE: StringRule = { min: 1, max: 2000, description: 'description' };
const ROLE_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case role name',
};
const POLICY_REF_RULE: StringRule = { min: 1, max: 200, description: 'policy reference' };

const parseStateKind = parseLiteralOf(WORKFLOW_STATE_KINDS, 'workflow state kind');
const parseTaskOutcomeLiteral = parseLiteralOf(TASK_OUTCOMES, 'task outcome');
const parseApprovalDecisionLiteral = parseLiteralOf(APPROVAL_DECISIONS, 'approval decision');
const parseActorKindLiteral = parseLiteralOf(ASSIGNABLE_ACTOR_KINDS, 'assignable actor kind');

// ----- model shapes ------------------------------------------------------------------

/** One typed state of the workflow machine. */
export interface WorkflowStateDefinition {
  /** State name, unique within the definition (lowercase kebab-case). */
  readonly name: string;
  /** Lifecycle kind; 'initial' exactly once, 'success'/'failure' are terminal. */
  readonly kind: WorkflowStateKind;
}

/**
 * One typed, guarded transition of the workflow machine. Execution order per
 * transition (see state.ts): guard evaluation → capability check → state
 * transition → task lifecycle updates → audit event.
 */
export interface WorkflowTransitionDefinition {
  /** Transition key, unique within the definition (lowercase kebab-case). */
  readonly key: string;
  /** The state the machine must be in (typed precondition). */
  readonly from: string;
  /** The declared target state — validated to exist; never the initial state. */
  readonly to: string;
  /** Conjunctive guard conditions (at least one; 'always' is explicit). */
  readonly conditions: readonly TransitionCondition[];
  /** Capabilities the executing actor must additionally hold (may be empty). */
  readonly requiredCapabilities: readonly Capability[];
}

/**
 * One declarative guard condition — a CLOSED vocabulary, evaluated
 * deterministically against the instance state (never arbitrary code).
 */
export type TransitionCondition =
  | { readonly kind: 'always' }
  | { readonly kind: 'task-outcome'; readonly task: string; readonly outcome: TaskOutcome }
  | {
      readonly kind: 'approval-decision';
      readonly approval: string;
      readonly decision: ApprovalDecision;
    }
  | { readonly kind: 'all-tasks-settled'; readonly state: string };

/** Task assignment rules: who may be assigned the task. */
export interface TaskAssignment {
  /** Actor kinds eligible for assignment (non-empty, from the contracts vocabulary). */
  readonly actorKinds: readonly string[];
  /** Role names eligible for assignment (may be empty = kind-only). */
  readonly roles: readonly string[];
}

/** One task definition bound to a (non-terminal) workflow state. */
export interface WorkflowTaskDefinition {
  /** Task key, unique within the definition (lowercase kebab-case). */
  readonly key: string;
  /** Human-readable title (1..200 characters). */
  readonly title: string;
  /** The workflow state this task belongs to (non-terminal, declared). */
  readonly state: string;
  /** Assignment rules (actor kinds / roles). */
  readonly assignment: TaskAssignment;
  /** SLA window in minutes from assignment; null = no SLA. */
  readonly slaMinutes: number | null;
}

/** One approval step definition — the capability-gated decision point. */
export interface WorkflowApprovalDefinition {
  /** Approval key, unique within the definition (lowercase kebab-case). */
  readonly key: string;
  /** Human-readable title (1..200 characters). */
  readonly title: string;
  /** The workflow state this approval belongs to (non-terminal, declared). */
  readonly state: string;
  /**
   * THE required capability: an approval step can ONLY be decided (approved
   * or rejected) by an actor holding this capability through a policy that
   * allows the decision — there is no bypass path (freeze A8).
   */
  readonly requiredCapability: Capability;
  /** Reference to the organization policy governing this approval step. */
  readonly policyRef: string;
}

/** The typed bounded retry policy of a definition (deterministic, no wall-clock). */
export interface WorkflowRetryPolicy {
  /** Maximum started attempts per task (1..20). */
  readonly maxAttempts: number;
  /** Backoff base in seconds: attempt n waits base * 2^(n-1), capped. */
  readonly backoffBaseSeconds: number;
  /** Backoff ceiling in seconds (>= base). */
  readonly backoffMaxSeconds: number;
}

/** One SLA escalation rule: what to do when a task's SLA breaches. */
export interface WorkflowEscalationRule {
  /** Task key the rule applies to, or '*' for every task. */
  readonly task: string;
  /** The actor the breached task is reassigned to (definition-driven). */
  readonly reassignTo: EntityId;
}

/** The complete typed workflow model carried by a definition. */
export interface WorkflowModel {
  /** The typed states of the machine (>= 1; exactly one 'initial'; >= 1 terminal). */
  readonly states: readonly WorkflowStateDefinition[];
  /** The typed, guarded transitions (closed table; unique keys). */
  readonly transitions: readonly WorkflowTransitionDefinition[];
  /** Task definitions bound to non-terminal states. */
  readonly tasks: readonly WorkflowTaskDefinition[];
  /** Approval step definitions bound to non-terminal states. */
  readonly approvals: readonly WorkflowApprovalDefinition[];
  /** The bounded retry policy applied to every task of the workflow. */
  readonly retryPolicy: WorkflowRetryPolicy;
  /** SLA escalation rules (reassignment on breach). */
  readonly escalationRules: readonly WorkflowEscalationRule[];
}

// ----- sub-parsers -------------------------------------------------------------------

const STATE_KEYS = ['name', 'kind'] as const;
const STATE_GRAMMAR =
  "WorkflowStateDefinition: { name: kebab (1..64), kind: 'initial' | 'normal' | 'success' | 'failure' }";

/** Parse one workflow state definition (total, fail-closed, strict keys). */
export function parseWorkflowStateDefinition(
  raw: unknown,
): ParseResult<WorkflowStateDefinition> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', STATE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, STATE_KEYS, '', STATE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const kind = requireFieldWith(raw, 'kind', '', parseStateKind);
  if (!kind.ok) return kind;
  return parseOk({ name: name.value, kind: kind.value } satisfies WorkflowStateDefinition);
}

const CONDITION_GRAMMAR =
  "TransitionCondition: { kind: 'always' } | { kind: 'task-outcome', task, outcome } | { kind: 'approval-decision', approval, decision } | { kind: 'all-tasks-settled', state }";

/** Parse one transition guard condition (closed vocabulary, strict keys). */
export function parseTransitionCondition(raw: unknown): ParseResult<TransitionCondition> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONDITION_GRAMMAR, describeValue(raw));
  }
  const kind = raw['kind'];
  if (kind === undefined) {
    return parseFail('missing-field', 'kind', CONDITION_GRAMMAR, 'undefined');
  }
  switch (kind) {
    case 'always': {
      const unknownKey = unknownKeyFailure(raw, ['kind'], '', CONDITION_GRAMMAR);
      if (unknownKey) return unknownKey;
      return parseOk({ kind: 'always' } satisfies TransitionCondition);
    }
    case 'task-outcome': {
      const unknownKey = unknownKeyFailure(
        raw,
        ['kind', 'task', 'outcome'],
        '',
        CONDITION_GRAMMAR,
      );
      if (unknownKey) return unknownKey;
      const task = requireString(raw, 'task', '', NAME_RULE);
      if (!task.ok) return task;
      const outcome = requireFieldWith(raw, 'outcome', '', parseTaskOutcomeLiteral);
      if (!outcome.ok) return outcome;
      return parseOk({
        kind: 'task-outcome',
        task: task.value,
        outcome: outcome.value,
      } satisfies TransitionCondition);
    }
    case 'approval-decision': {
      const unknownKey = unknownKeyFailure(
        raw,
        ['kind', 'approval', 'decision'],
        '',
        CONDITION_GRAMMAR,
      );
      if (unknownKey) return unknownKey;
      const approval = requireString(raw, 'approval', '', NAME_RULE);
      if (!approval.ok) return approval;
      const decision = requireFieldWith(raw, 'decision', '', parseApprovalDecisionLiteral);
      if (!decision.ok) return decision;
      return parseOk({
        kind: 'approval-decision',
        approval: approval.value,
        decision: decision.value,
      } satisfies TransitionCondition);
    }
    case 'all-tasks-settled': {
      const unknownKey = unknownKeyFailure(raw, ['kind', 'state'], '', CONDITION_GRAMMAR);
      if (unknownKey) return unknownKey;
      const state = requireString(raw, 'state', '', NAME_RULE);
      if (!state.ok) return state;
      return parseOk({
        kind: 'all-tasks-settled',
        state: state.value,
      } satisfies TransitionCondition);
    }
    default:
      return parseFail(
        'invalid-value',
        'kind',
        `one of: ${CONDITION_KINDS.join(' | ')} (transition condition kind)`,
        describeValue(kind),
      );
  }
}

const TRANSITION_KEYS = ['key', 'from', 'to', 'conditions', 'requiredCapabilities'] as const;
const TRANSITION_GRAMMAR =
  "WorkflowTransitionDefinition: { key: kebab (1..64), from: state name, to: state name, conditions: TransitionCondition[] (>= 1), requiredCapabilities?: Capability[] }";

/** Parse one workflow transition definition (total, fail-closed, strict keys). */
export function parseWorkflowTransitionDefinition(
  raw: unknown,
): ParseResult<WorkflowTransitionDefinition> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', TRANSITION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, TRANSITION_KEYS, '', TRANSITION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const key = requireString(raw, 'key', '', NAME_RULE);
  if (!key.ok) return key;
  const from = requireString(raw, 'from', '', NAME_RULE);
  if (!from.ok) return from;
  const to = requireString(raw, 'to', '', NAME_RULE);
  if (!to.ok) return to;
  const conditions = requireSelfPathedField(raw, 'conditions', (value, field) =>
    parseValueArrayWith(value, field, parseTransitionCondition, 'transition conditions'),
  );
  if (!conditions.ok) return conditions;
  if (conditions.value.length < 1) {
    return parseFail(
      'invalid-value',
      'conditions',
      'at least one transition condition (use { kind: "always" } for an unconditional guard)',
      'array of length 0',
    );
  }
  const requiredCapabilities = optionalSelfPathedField(raw, 'requiredCapabilities', (value, field) =>
    parseValueArrayWith(value, field, parseCapability, 'declared capability names'),
  );
  if (!requiredCapabilities.ok) return requiredCapabilities;
  return parseOk({
    key: key.value,
    from: from.value,
    to: to.value,
    conditions: conditions.value,
    requiredCapabilities: requiredCapabilities.value ?? [],
  } satisfies WorkflowTransitionDefinition);
}

const ASSIGNMENT_KEYS = ['actorKinds', 'roles'] as const;
const ASSIGNMENT_GRAMMAR =
  "TaskAssignment: { actorKinds: ('user' | 'agent' | 'app' | 'adapter' | 'system')[] (>= 1, unique), roles?: kebab[] (unique) }";

/** Parse a task assignment rule (total, fail-closed, strict keys). */
export function parseTaskAssignment(raw: unknown): ParseResult<TaskAssignment> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ASSIGNMENT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ASSIGNMENT_KEYS, '', ASSIGNMENT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const actorKinds = requireSelfPathedField(raw, 'actorKinds', (value, field) =>
    parseValueArrayWith(value, field, parseActorKindLiteral, 'assignable actor kinds'),
  );
  if (!actorKinds.ok) return actorKinds;
  if (actorKinds.value.length < 1) {
    return parseFail(
      'invalid-value',
      'actorKinds',
      'at least one assignable actor kind',
      'array of length 0',
    );
  }
  if (new Set(actorKinds.value).size !== actorKinds.value.length) {
    return parseFail(
      'invalid-value',
      'actorKinds',
      'unique assignable actor kinds (no duplicates)',
      'array with duplicates',
    );
  }
  const roles = optionalSelfPathedField(raw, 'roles', (value, field) =>
    parseValueArrayWith(
      value,
      field,
      (element) => parseStringLike(element, ROLE_RULE),
      'role names',
    ),
  );
  if (!roles.ok) return roles;
  const roleValues = roles.value ?? [];
  if (new Set(roleValues).size !== roleValues.length) {
    return parseFail(
      'invalid-value',
      'roles',
      'unique role names (no duplicates)',
      'array with duplicates',
    );
  }
  return parseOk({
    actorKinds: actorKinds.value,
    roles: roleValues,
  } satisfies TaskAssignment);
}

const TASK_KEYS = ['key', 'title', 'state', 'assignment', 'slaMinutes'] as const;
const TASK_GRAMMAR =
  'WorkflowTaskDefinition: { key: kebab (1..64), title: string (1..200), state: state name, assignment: TaskAssignment, slaMinutes?: integer 1..525600 (absent or null = no SLA) }';

/** Parse one task definition (total, fail-closed, strict keys). */
export function parseWorkflowTaskDefinition(
  raw: unknown,
): ParseResult<WorkflowTaskDefinition> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', TASK_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, TASK_KEYS, '', TASK_GRAMMAR);
  if (unknownKey) return unknownKey;
  const key = requireString(raw, 'key', '', NAME_RULE);
  if (!key.ok) return key;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const state = requireString(raw, 'state', '', NAME_RULE);
  if (!state.ok) return state;
  const assignment = requireFieldWith(raw, 'assignment', '', parseTaskAssignment);
  if (!assignment.ok) return assignment;
  // Absent OR explicit null means "no SLA". The parsed value carries
  // slaMinutes: null, so accepting null keeps the parser total over its OWN
  // output (round-trip idempotent) — the definition-state invariant
  // re-validates the stored model through this parser.
  const slaMinutes = optionalNullableFieldWith(raw, 'slaMinutes', '', (value) =>
    parseBoundedInteger(value, 1, MAX_SLA_MINUTES, 'SLA minutes'),
  );
  if (!slaMinutes.ok) return slaMinutes;
  return parseOk({
    key: key.value,
    title: title.value,
    state: state.value,
    assignment: assignment.value,
    slaMinutes: slaMinutes.value ?? null,
  } satisfies WorkflowTaskDefinition);
}

const APPROVAL_KEYS = ['key', 'title', 'state', 'requiredCapability', 'policyRef'] as const;
const APPROVAL_GRAMMAR =
  'WorkflowApprovalDefinition: { key: kebab (1..64), title: string (1..200), state: state name, requiredCapability: declared capability, policyRef: string (1..200) }';

/** Parse one approval step definition (total, fail-closed, strict keys). */
export function parseWorkflowApprovalDefinition(
  raw: unknown,
): ParseResult<WorkflowApprovalDefinition> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APPROVAL_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APPROVAL_KEYS, '', APPROVAL_GRAMMAR);
  if (unknownKey) return unknownKey;
  const key = requireString(raw, 'key', '', NAME_RULE);
  if (!key.ok) return key;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const state = requireString(raw, 'state', '', NAME_RULE);
  if (!state.ok) return state;
  const requiredCapability = requireFieldWith(raw, 'requiredCapability', '', parseCapability);
  if (!requiredCapability.ok) return requiredCapability;
  const policyRef = requireString(raw, 'policyRef', '', POLICY_REF_RULE);
  if (!policyRef.ok) return policyRef;
  return parseOk({
    key: key.value,
    title: title.value,
    state: state.value,
    requiredCapability: requiredCapability.value,
    policyRef: policyRef.value,
  } satisfies WorkflowApprovalDefinition);
}

const RETRY_POLICY_KEYS = ['maxAttempts', 'backoffBaseSeconds', 'backoffMaxSeconds'] as const;
const RETRY_POLICY_GRAMMAR =
  'WorkflowRetryPolicy: { maxAttempts: integer 1..20, backoffBaseSeconds: integer 1..86400, backoffMaxSeconds: integer (base..604800) }';

/** Parse the typed bounded retry policy (total, fail-closed, strict keys). */
export function parseWorkflowRetryPolicy(raw: unknown): ParseResult<WorkflowRetryPolicy> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RETRY_POLICY_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RETRY_POLICY_KEYS, '', RETRY_POLICY_GRAMMAR);
  if (unknownKey) return unknownKey;
  const maxAttempts = requireFieldWith(raw, 'maxAttempts', '', (value) =>
    parseBoundedInteger(value, 1, MAX_RETRY_ATTEMPTS, 'retry attempts'),
  );
  if (!maxAttempts.ok) return maxAttempts;
  const backoffBaseSeconds = requireFieldWith(raw, 'backoffBaseSeconds', '', (value) =>
    parseBoundedInteger(value, 1, MAX_BACKOFF_BASE_SECONDS, 'backoff base seconds'),
  );
  if (!backoffBaseSeconds.ok) return backoffBaseSeconds;
  const backoffMaxSeconds = requireFieldWith(raw, 'backoffMaxSeconds', '', (value) =>
    parseBoundedInteger(value, 1, MAX_BACKOFF_MAX_SECONDS, 'backoff max seconds'),
  );
  if (!backoffMaxSeconds.ok) return backoffMaxSeconds;
  if (backoffMaxSeconds.value < backoffBaseSeconds.value) {
    return parseFail(
      'invalid-value',
      'backoffMaxSeconds',
      `integer (${backoffBaseSeconds.value}..${MAX_BACKOFF_MAX_SECONDS}) — the backoff ceiling must not be below the base`,
      `number ${String(backoffMaxSeconds.value)}`,
    );
  }
  return parseOk({
    maxAttempts: maxAttempts.value,
    backoffBaseSeconds: backoffBaseSeconds.value,
    backoffMaxSeconds: backoffMaxSeconds.value,
  } satisfies WorkflowRetryPolicy);
}

const ESCALATION_KEYS = ['task', 'reassignTo'] as const;
const ESCALATION_GRAMMAR =
  "WorkflowEscalationRule: { task: kebab (1..64) or '*', reassignTo: EntityId }";

/** Parse one escalation rule (total, fail-closed, strict keys). */
export function parseWorkflowEscalationRule(
  raw: unknown,
): ParseResult<WorkflowEscalationRule> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ESCALATION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ESCALATION_KEYS, '', ESCALATION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const task = raw['task'];
  if (task === undefined) {
    return parseFail('missing-field', 'task', ESCALATION_GRAMMAR, 'undefined');
  }
  if (task !== '*' && typeof task === 'string') {
    const checked = parseStringLike(task, NAME_RULE);
    if (!checked.ok) return checked;
  } else if (typeof task !== 'string') {
    return parseFail('invalid-value', 'task', ESCALATION_GRAMMAR, describeValue(task));
  }
  const reassignTo = requireFieldWith(raw, 'reassignTo', '', parseEntityId);
  if (!reassignTo.ok) return reassignTo;
  return parseOk({
    task: task as string,
    reassignTo: reassignTo.value,
  } satisfies WorkflowEscalationRule);
}

const MODEL_KEYS = [
  'states',
  'transitions',
  'tasks',
  'approvals',
  'retryPolicy',
  'escalationRules',
] as const;
const MODEL_GRAMMAR =
  'WorkflowModel: { states: WorkflowStateDefinition[] (>= 1, unique names, exactly one initial, >= 1 terminal), transitions: WorkflowTransitionDefinition[] (unique keys, closed table), tasks: WorkflowTaskDefinition[] (unique keys), approvals: WorkflowApprovalDefinition[] (unique keys), retryPolicy: WorkflowRetryPolicy, escalationRules: WorkflowEscalationRule[] }';

// ----- structural validation helpers (package-internal) ------------------------------

const duplicateKeysOf = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const value of values) {
    if (seen.has(value)) duplicates.push(value);
    seen.add(value);
  }
  return duplicates;
};

/**
 * Parse the complete workflow model (total, fail-closed, strict keys) AND
 * validate the transition table closed:
 * - exactly one 'initial' state; at least one terminal state;
 * - unique state names / transition keys / task keys / approval keys;
 * - every transition's from/to is a declared state;
 * - no transition leaves a terminal state; none re-enters the initial state;
 * - no self-transition;
 * - every condition's task/approval/state reference is declared;
 * - tasks and approvals bind to declared NON-terminal states;
 * - escalation rules address declared task keys (or '*').
 */
export function parseWorkflowModel(raw: unknown): ParseResult<WorkflowModel> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', MODEL_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, MODEL_KEYS, '', MODEL_GRAMMAR);
  if (unknownKey) return unknownKey;
  const states = requireSelfPathedField(raw, 'states', (value, field) =>
    parseValueArrayWith(value, field, parseWorkflowStateDefinition, 'workflow states'),
  );
  if (!states.ok) return states;
  const transitions = requireSelfPathedField(raw, 'transitions', (value, field) =>
    parseValueArrayWith(
      value,
      field,
      parseWorkflowTransitionDefinition,
      'workflow transitions',
    ),
  );
  if (!transitions.ok) return transitions;
  const tasks = requireSelfPathedField(raw, 'tasks', (value, field) =>
    parseValueArrayWith(value, field, parseWorkflowTaskDefinition, 'workflow tasks'),
  );
  if (!tasks.ok) return tasks;
  const approvals = requireSelfPathedField(raw, 'approvals', (value, field) =>
    parseValueArrayWith(value, field, parseWorkflowApprovalDefinition, 'workflow approvals'),
  );
  if (!approvals.ok) return approvals;
  const retryPolicy = requireFieldWith(raw, 'retryPolicy', '', parseWorkflowRetryPolicy);
  if (!retryPolicy.ok) return retryPolicy;
  const escalationRules = requireSelfPathedField(raw, 'escalationRules', (value, field) =>
    parseValueArrayWith(value, field, parseWorkflowEscalationRule, 'escalation rules'),
  );
  if (!escalationRules.ok) return escalationRules;

  // --- closed-table structural validation (fail-closed, dotted paths) ---
  const stateNames = states.value.map((state) => state.name);
  if (stateNames.length < 1) {
    return parseFail(
      'invalid-value',
      'states',
      'at least one workflow state (exactly one initial; at least one terminal)',
      'array of length 0',
    );
  }
  const duplicateStates = duplicateKeysOf(stateNames);
  if (duplicateStates.length > 0) {
    return parseFail(
      'invalid-value',
      'states',
      'unique workflow state names (no duplicates)',
      `duplicate state name(s): ${duplicateStates.join(', ')}`,
    );
  }
  const initialState = states.value.filter((state) => state.kind === 'initial');
  if (initialState.length !== 1) {
    return parseFail(
      'invalid-value',
      'states',
      'exactly one state with kind "initial"',
      `${String(initialState.length)} initial state(s)`,
    );
  }
  const terminalStates = states.value.filter(
    (state) => state.kind === 'success' || state.kind === 'failure',
  );
  if (terminalStates.length < 1) {
    return parseFail(
      'invalid-value',
      'states',
      "at least one terminal state (kind 'success' or 'failure')",
      'no terminal state',
    );
  }
  const stateNameSet = new Set(stateNames);
  const terminalNames = new Set(terminalStates.map((state) => state.name));
  const initialName = initialState[0]?.name ?? '';

  const transitionKeys = transitions.value.map((transition) => transition.key);
  const duplicateTransitions = duplicateKeysOf(transitionKeys);
  if (duplicateTransitions.length > 0) {
    return parseFail(
      'invalid-value',
      'transitions',
      'unique workflow transition keys (no duplicates)',
      `duplicate transition key(s): ${duplicateTransitions.join(', ')}`,
    );
  }
  const taskKeys = tasks.value.map((task) => task.key);
  const duplicateTasks = duplicateKeysOf(taskKeys);
  if (duplicateTasks.length > 0) {
    return parseFail(
      'invalid-value',
      'tasks',
      'unique workflow task keys (no duplicates)',
      `duplicate task key(s): ${duplicateTasks.join(', ')}`,
    );
  }
  const approvalKeys = approvals.value.map((approval) => approval.key);
  const duplicateApprovals = duplicateKeysOf(approvalKeys);
  if (duplicateApprovals.length > 0) {
    return parseFail(
      'invalid-value',
      'approvals',
      'unique workflow approval keys (no duplicates)',
      `duplicate approval key(s): ${duplicateApprovals.join(', ')}`,
    );
  }
  const taskKeySet = new Set(taskKeys);
  const approvalKeySet = new Set(approvalKeys);

  for (const [index, transition] of transitions.value.entries()) {
    const path = `transitions[${index}]`;
    if (!stateNameSet.has(transition.from)) {
      return parseFail(
        'invalid-value',
        `${path}.from`,
        'a declared state name of this definition',
        `undeclared state '${transition.from}'`,
      );
    }
    if (!stateNameSet.has(transition.to)) {
      return parseFail(
        'invalid-value',
        `${path}.to`,
        'a declared state name of this definition',
        `undeclared state '${transition.to}'`,
      );
    }
    if (terminalNames.has(transition.from)) {
      return parseFail(
        'invalid-value',
        `${path}.from`,
        'a non-terminal state (terminal states have no outgoing transitions)',
        `terminal state '${transition.from}'`,
      );
    }
    if (transition.to === initialName) {
      return parseFail(
        'invalid-value',
        `${path}.to`,
        'a non-initial state (the machine never re-enters its initial state)',
        `initial state '${transition.to}'`,
      );
    }
    if (transition.from === transition.to) {
      return parseFail(
        'invalid-value',
        `${path}.to`,
        'a state different from "from" (no self-transitions)',
        `self-transition '${transition.to}'`,
      );
    }
    for (const [conditionIndex, condition] of transition.conditions.entries()) {
      const conditionPath = `${path}.conditions[${String(conditionIndex)}]`;
      if (condition.kind === 'task-outcome' && !taskKeySet.has(condition.task)) {
        return parseFail(
          'invalid-value',
          `${conditionPath}.task`,
          'a declared task key of this definition',
          `undeclared task '${condition.task}'`,
        );
      }
      if (condition.kind === 'approval-decision' && !approvalKeySet.has(condition.approval)) {
        return parseFail(
          'invalid-value',
          `${conditionPath}.approval`,
          'a declared approval key of this definition',
          `undeclared approval '${condition.approval}'`,
        );
      }
      if (condition.kind === 'all-tasks-settled' && !stateNameSet.has(condition.state)) {
        return parseFail(
          'invalid-value',
          `${conditionPath}.state`,
          'a declared state name of this definition',
          `undeclared state '${condition.state}'`,
        );
      }
    }
  }

  for (const [index, task] of tasks.value.entries()) {
    if (!stateNameSet.has(task.state)) {
      return parseFail(
        'invalid-value',
        `tasks[${index}].state`,
        'a declared state name of this definition',
        `undeclared state '${task.state}'`,
      );
    }
    if (terminalNames.has(task.state)) {
      return parseFail(
        'invalid-value',
        `tasks[${index}].state`,
        'a non-terminal state (tasks settle before the machine reaches a terminal state)',
        `terminal state '${task.state}'`,
      );
    }
  }

  for (const [index, approval] of approvals.value.entries()) {
    if (!stateNameSet.has(approval.state)) {
      return parseFail(
        'invalid-value',
        `approvals[${index}].state`,
        'a declared state name of this definition',
        `undeclared state '${approval.state}'`,
      );
    }
    if (terminalNames.has(approval.state)) {
      return parseFail(
        'invalid-value',
        `approvals[${index}].state`,
        'a non-terminal state (approvals are decided before the machine reaches a terminal state)',
        `terminal state '${approval.state}'`,
      );
    }
  }

  for (const [index, rule] of escalationRules.value.entries()) {
    if (rule.task !== '*' && !taskKeySet.has(rule.task)) {
      return parseFail(
        'invalid-value',
        `escalationRules[${index}].task`,
        "a declared task key of this definition, or '*' for every task",
        `undeclared task '${rule.task}'`,
      );
    }
  }

  return parseOk({
    states: states.value,
    transitions: transitions.value,
    tasks: tasks.value,
    approvals: approvals.value,
    retryPolicy: retryPolicy.value,
    escalationRules: escalationRules.value,
  } satisfies WorkflowModel);
}

/** Type guard for structurally valid WorkflowModel values. */
export function isWorkflowModel(raw: unknown): raw is WorkflowModel {
  return parseWorkflowModel(raw).ok;
}

// ----- definition key/description payload helpers -----------------------------------

const DEFINITION_KEY_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case workflow definition key',
};

/** Parse a workflow definition key (total, fail-closed). */
export const parseDefinitionKey = (raw: unknown): ParseResult<string> =>
  parseStringLike(raw, DEFINITION_KEY_RULE);

/** Parse a workflow definition title (total, fail-closed). */
export const parseDefinitionTitle = (raw: unknown): ParseResult<string> =>
  parseStringLike(raw, TITLE_RULE);

/** Parse a workflow definition description (total, fail-closed). */
export const parseDefinitionDescription = (raw: unknown): ParseResult<string> =>
  parseStringLike(raw, DESCRIPTION_RULE);

/**
 * The deterministic backoff seconds of retry attempt `attempt` under a retry
 * policy: base * 2^(attempt-1), capped at the ceiling (attempt >= 1). Pure
 * arithmetic on definition parameters — no wall clock, no randomness.
 */
export function retryBackoffSeconds(
  policy: WorkflowRetryPolicy,
  attempt: number,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError(`invalid retry attempt: ${String(attempt)}`);
  }
  const exponential = policy.backoffBaseSeconds * 2 ** (attempt - 1);
  return Math.min(exponential, policy.backoffMaxSeconds);
}
