// Office workflow engine — command handlers (OFF-016).
//
// THE canonical mutation path of the workflow engine (freeze "cross-view
// mutation" + the OFF-003 kernel contract + the landed identity-module
// pattern), executed for every command:
//
//   1. validate the command name + parse the payload fail-closed (a malformed
//      payload is a typed invariant-violation — never a silent default);
//   2. require PROJECT scope (freeze A12 second boundary: workflow
//      definitions and instances are project-bound, so a tenant-scoped
//      command is a typed unauthorized 'project-scope-required' denial);
//   3. authorize the mutation with the CALLER-SUPPLIED policy through
//      @office/authz's deny-by-default authorize() (structural A12 isolation
//      first, then explicit deny, then allow, then default deny) — a denied
//      command never mutates anything at all (no store write, no event, no
//      idempotency record);
//   4. deduplicate through the domain-kernel IdempotencyRegistry keyed by
//      (scope, idempotency key) (freeze A8/A9): a replay of the same command
//      (same key, same fingerprint) returns the recorded outcome with
//      exactly-once effects; a DIFFERENT payload under the same key is a
//      typed idempotency-conflict; a failed execution is never recorded, so
//      transient failures stay retryable;
//   5. load the aggregate(s) through the scoped store (foreign tenant →
//      typed not-found, no existence oracle; wrong project → typed
//      unauthorized project-scope-violation) and re-check scope coverage
//      (kernel A12 backstop, defense in depth);
//   6. check optimistic concurrency (stale version → typed
//      concurrency-conflict, the state is NEVER silently overwritten);
//   7. apply the invariant-checked PURE transition (state.ts — the
//      deterministic machine: guard evaluation → capability check → state
//      transition → task lifecycle updates);
//   8. append the audit event(s) through the injected EventSink AND commit
//      the store write — the sink append precedes the store commit, so a
//      sink failure MUST abort the whole mutation (state unchanged);
//   9. return the committed aggregate state as a typed Result (replays carry
//      replayed: true and the ORIGINAL outcome).
//
// THE APPROVAL GATE (freeze A8 — the named acceptance of this package): the
// approve/reject commands resolve their authorization INPUT from the pinned
// instance BEFORE the idempotency registry (the required capability is
// declared BY the definition, so it cannot be known earlier — the documented
// ordering deviation, mirrored nowhere else): the addressed approval must
// exist, the actor must hold the approval's REQUIRED capability, and the
// caller-supplied policy must allow the decision. A denial emits the
// AUDIT-ONLY `workflows.approvalDenied` event (the aggregate is NEVER
// advanced or version-bumped by a denial) and returns a typed 'forbidden'
// failure — there is NO path that advances an approval step without
// authorization, including through the idempotency/retry paths (a denied
// execution is never recorded, so every retry re-runs the gate).
//
// Determinism (kernel rule): handlers read NO wall clock and NO randomness —
// `now` and the canonical-id opaque parts come from the injected suppliers
// (fixed sequences in tests; wall clock / crypto randomness in production
// wiring). SLA deadlines and retry backoff gates are pure arithmetic on the
// definition's parameters against that injected `now`.
import { formatEntityId, parseCommandName } from '@office/contracts';
import { parseEntityId, parseEntityRef, parseFail, parseOk } from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  EntityId,
  EntityKind,
  EntityRef,
  ParseResult,
  ProjectScope,
  Scope,
  Timestamp,
} from '@office/contracts';
import { authorize, authorizationContext, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy } from '@office/authz';
import {
  checkConcurrency,
  checkScopeCovers,
  domainError,
  parseAggregateVersion,
  withIdempotency,
} from '@office/domain-kernel';
import type {
  AggregateVersion,
  CommandResult,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
  IdempotencyRegistry,
  Result,
} from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { EventSink } from './events';
import {
  APPROVAL_APPROVED_EVENT,
  APPROVAL_DENIED_EVENT,
  APPROVAL_REJECTED_EVENT,
  APPROVAL_SUBMITTED_EVENT,
  DEFINITION_CREATED_EVENT,
  DEFINITION_PUBLISHED_EVENT,
  DEFINITION_UPDATED_EVENT,
  INSTANCE_STARTED_EVENT,
  TASK_ASSIGNED_EVENT,
  TASK_COMPLETED_EVENT,
  TASK_ESCALATED_EVENT,
  TASK_FAILED_EVENT,
  TASK_RETRIED_EVENT,
  TASK_SKIPPED_EVENT,
  TASK_STARTED_EVENT,
  approvalPayloadOf,
  escalationPayloadOf,
  taskPayloadOf,
  transitionEventNamesOf,
  transitionPayloadsOf,
  updatedRefs,
  unchangedRefs,
  createdRefs,
  workflowEventEnvelope,
} from './events';
import type { WorkflowAuditPayload } from './events';
import type { WorkflowStore } from './store';
import type {
  ApprovalState,
  WorkflowDefinitionState,
  WorkflowInstanceState,
} from './state';
import {
  WORKFLOW_DEFINITION_KIND,
  WORKFLOW_INSTANCE_KIND,
  assignWorkflowTaskState,
  completeWorkflowTaskState,
  createWorkflowDefinitionState,
  createWorkflowInstanceState,
  decideWorkflowApprovalState,
  escalateWorkflowInstanceState,
  failWorkflowTaskState,
  nextDefinitionVersionOf,
  publishWorkflowDefinitionState,
  retryWorkflowTaskState,
  skipWorkflowTaskState,
  startWorkflowTaskState,
  submitWorkflowApprovalState,
  transitionWorkflowInstanceState,
  updateWorkflowDefinitionModelState,
} from './state';
import {
  parseDefinitionDescription,
  parseDefinitionKey,
  parseDefinitionTitle,
  parseWorkflowModel,
} from './definition';
import type { WorkflowModel } from './definition';
import {
  isPlainObject,
  optionalFieldWith,
  parseStringLike,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { StringRule } from './parse';

// ----- command names -------------------------------------------------------------------

const commandNameOf = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid workflow command name literal: ${name}`);
  }
  return parsed.value;
};

/** Command name executed by {@link DefinitionCommands.createDefinition}. */
export const CREATE_DEFINITION_COMMAND: CommandName = commandNameOf('workflows.createDefinition');
/** Command name executed by {@link DefinitionCommands.updateDefinition}. */
export const UPDATE_DEFINITION_COMMAND: CommandName = commandNameOf('workflows.updateDefinition');
/** Command name executed by {@link DefinitionCommands.publishDefinition}. */
export const PUBLISH_DEFINITION_COMMAND: CommandName = commandNameOf(
  'workflows.publishDefinition',
);
/** Command name executed by {@link InstanceCommands.startInstance}. */
export const START_INSTANCE_COMMAND: CommandName = commandNameOf('workflows.startInstance');
/** Command name executed by {@link InstanceCommands.executeTransition}. */
export const EXECUTE_TRANSITION_COMMAND: CommandName = commandNameOf(
  'workflows.executeTransition',
);
/** Command name executed by {@link InstanceCommands.escalateInstance}. */
export const ESCALATE_INSTANCE_COMMAND: CommandName = commandNameOf(
  'workflows.escalateInstance',
);
/** Command name executed by {@link TaskCommands.assignTask}. */
export const ASSIGN_TASK_COMMAND: CommandName = commandNameOf('workflows.assignTask');
/** Command name executed by {@link TaskCommands.startTask}. */
export const START_TASK_COMMAND: CommandName = commandNameOf('workflows.startTask');
/** Command name executed by {@link TaskCommands.completeTask}. */
export const COMPLETE_TASK_COMMAND: CommandName = commandNameOf('workflows.completeTask');
/** Command name executed by {@link TaskCommands.skipTask}. */
export const SKIP_TASK_COMMAND: CommandName = commandNameOf('workflows.skipTask');
/** Command name executed by {@link TaskCommands.failTask}. */
export const FAIL_TASK_COMMAND: CommandName = commandNameOf('workflows.failTask');
/** Command name executed by {@link TaskCommands.retryTask}. */
export const RETRY_TASK_COMMAND: CommandName = commandNameOf('workflows.retryTask');
/** Command name executed by {@link ApprovalCommands.submitApproval}. */
export const SUBMIT_APPROVAL_COMMAND: CommandName = commandNameOf('workflows.submitApproval');
/** Command name executed by {@link ApprovalCommands.approveApproval}. */
export const APPROVE_APPROVAL_COMMAND: CommandName = commandNameOf('workflows.approveApproval');
/** Command name executed by {@link ApprovalCommands.rejectApproval}. */
export const REJECT_APPROVAL_COMMAND: CommandName = commandNameOf('workflows.rejectApproval');

/**
 * Guard: a handler executes exactly its own command kind. Handing another
 * command's envelope to a handler is a trusted-path wiring error — loud.
 */
const requireCommandName = (
  command: CommandEnvelope<unknown>,
  expected: CommandName,
): void => {
  if (command.commandName !== expected) {
    throw new TypeError(
      `workflow command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) ---------------------------------------

const REASON_RULE: StringRule = { min: 1, max: 2000, description: 'reason' };
const NOTE_RULE: StringRule = { min: 1, max: 2000, description: 'note' };
const TASK_KEY_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case task key',
};
const APPROVAL_KEY_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case approval key',
};
const TRANSITION_KEY_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case transition key',
};

const describePayload = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (Array.isArray(raw)) return `array (length ${raw.length})`;
  return typeof raw;
};

/** Validated payload of `workflows.createDefinition` (a new draft version row). */
export interface CreateDefinitionPayload {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly model: WorkflowModel;
}

const CREATE_DEFINITION_KEYS = ['key', 'title', 'description', 'model'] as const;
const CREATE_DEFINITION_GRAMMAR =
  'CreateDefinitionPayload: { key: kebab (1..64), title: string (1..200), description?: string (1..2000), model: WorkflowModel }';

/** Parse the create-definition payload (total, fail-closed, strict keys). */
export function parseCreateDefinitionPayload(
  raw: unknown,
): ParseResult<CreateDefinitionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CREATE_DEFINITION_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    CREATE_DEFINITION_KEYS,
    '',
    CREATE_DEFINITION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const key = requireFieldWith(raw, 'key', '', parseDefinitionKey);
  if (!key.ok) return key;
  const title = requireFieldWith(raw, 'title', '', parseDefinitionTitle);
  if (!title.ok) return title;
  const description = optionalFieldWith(raw, 'description', '', parseDefinitionDescription);
  if (!description.ok) return description;
  const model = requireFieldWith(raw, 'model', '', parseWorkflowModel);
  if (!model.ok) return model;
  return parseOk({
    key: key.value,
    title: title.value,
    ...(description.value !== undefined ? { description: description.value } : {}),
    model: model.value,
  });
}

/** Validated payload of `workflows.updateDefinition` (draft model replacement). */
export interface UpdateDefinitionPayload {
  readonly definitionId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly model: WorkflowModel;
}

const UPDATE_DEFINITION_KEYS = ['definitionId', 'expectedVersion', 'model'] as const;
const UPDATE_DEFINITION_GRAMMAR =
  'UpdateDefinitionPayload: { definitionId: EntityId, expectedVersion: number (>= 1), model: WorkflowModel }';

/** Parse the update-definition payload (total, fail-closed, strict keys). */
export function parseUpdateDefinitionPayload(
  raw: unknown,
): ParseResult<UpdateDefinitionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', UPDATE_DEFINITION_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    UPDATE_DEFINITION_KEYS,
    '',
    UPDATE_DEFINITION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const definitionId = requireFieldWith(raw, 'definitionId', '', parseEntityId);
  if (!definitionId.ok) return definitionId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const model = requireFieldWith(raw, 'model', '', parseWorkflowModel);
  if (!model.ok) return model;
  return parseOk({
    definitionId: definitionId.value,
    expectedVersion: expectedVersion.value,
    model: model.value,
  });
}

/** Validated payload of `workflows.publishDefinition` (the freeze). */
export interface PublishDefinitionPayload {
  readonly definitionId: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const PUBLISH_DEFINITION_KEYS = ['definitionId', 'expectedVersion'] as const;
const PUBLISH_DEFINITION_GRAMMAR =
  'PublishDefinitionPayload: { definitionId: EntityId, expectedVersion: number (>= 1) }';

/** Parse the publish-definition payload (total, fail-closed, strict keys). */
export function parsePublishDefinitionPayload(
  raw: unknown,
): ParseResult<PublishDefinitionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PUBLISH_DEFINITION_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    PUBLISH_DEFINITION_KEYS,
    '',
    PUBLISH_DEFINITION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const definitionId = requireFieldWith(raw, 'definitionId', '', parseEntityId);
  if (!definitionId.ok) return definitionId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({ definitionId: definitionId.value, expectedVersion: expectedVersion.value });
}

/** Validated payload of `workflows.startInstance` (from a pinned published definition). */
export interface StartInstancePayload {
  readonly definitionId: EntityId;
  readonly subject: EntityRef;
}

const START_INSTANCE_KEYS = ['definitionId', 'subject'] as const;
const START_INSTANCE_GRAMMAR =
  'StartInstancePayload: { definitionId: EntityId, subject: { entityKind: EntityKind, entityId: EntityId } }';

/** Parse the start-instance payload (total, fail-closed, strict keys). */
export function parseStartInstancePayload(
  raw: unknown,
): ParseResult<StartInstancePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', START_INSTANCE_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, START_INSTANCE_KEYS, '', START_INSTANCE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const definitionId = requireFieldWith(raw, 'definitionId', '', parseEntityId);
  if (!definitionId.ok) return definitionId;
  const subject = requireFieldWith(raw, 'subject', '', parseEntityRef);
  if (!subject.ok) return subject;
  return parseOk({ definitionId: definitionId.value, subject: subject.value });
}

/** Validated payload of `workflows.executeTransition`. */
export interface ExecuteTransitionPayload {
  readonly instanceId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly transitionKey: string;
}

const EXECUTE_TRANSITION_KEYS = ['instanceId', 'expectedVersion', 'transitionKey'] as const;
const EXECUTE_TRANSITION_GRAMMAR =
  'ExecuteTransitionPayload: { instanceId: EntityId, expectedVersion: number (>= 1), transitionKey: kebab (1..64) }';

/** Parse the execute-transition payload (total, fail-closed, strict keys). */
export function parseExecuteTransitionPayload(
  raw: unknown,
): ParseResult<ExecuteTransitionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EXECUTE_TRANSITION_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    EXECUTE_TRANSITION_KEYS,
    '',
    EXECUTE_TRANSITION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const transitionKey = requireString(raw, 'transitionKey', '', TRANSITION_KEY_RULE);
  if (!transitionKey.ok) return transitionKey;
  return parseOk({
    instanceId: instanceId.value,
    expectedVersion: expectedVersion.value,
    transitionKey: transitionKey.value,
  });
}

/** Validated payload of `workflows.assignTask`. */
export interface AssignTaskPayload {
  readonly instanceId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly taskKey: string;
  readonly assignee: EntityId;
}

const ASSIGN_TASK_KEYS = ['instanceId', 'expectedVersion', 'taskKey', 'assignee'] as const;
const ASSIGN_TASK_GRAMMAR =
  'AssignTaskPayload: { instanceId: EntityId, expectedVersion: number (>= 1), taskKey: kebab (1..64), assignee: EntityId }';

/** Parse the assign-task payload (total, fail-closed, strict keys). */
export function parseAssignTaskPayload(raw: unknown): ParseResult<AssignTaskPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ASSIGN_TASK_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ASSIGN_TASK_KEYS, '', ASSIGN_TASK_GRAMMAR);
  if (unknownKey) return unknownKey;
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const taskKey = requireString(raw, 'taskKey', '', TASK_KEY_RULE);
  if (!taskKey.ok) return taskKey;
  const assignee = requireFieldWith(raw, 'assignee', '', parseEntityId);
  if (!assignee.ok) return assignee;
  return parseOk({
    instanceId: instanceId.value,
    expectedVersion: expectedVersion.value,
    taskKey: taskKey.value,
    assignee: assignee.value,
  });
}

/** The shared shape of every single-task command payload (besides assignment). */
export interface TaskCommandPayload {
  readonly instanceId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly taskKey: string;
}

const TASK_COMMAND_KEYS = ['instanceId', 'expectedVersion', 'taskKey'] as const;
const TASK_COMMAND_GRAMMAR =
  'TaskCommandPayload: { instanceId: EntityId, expectedVersion: number (>= 1), taskKey: kebab (1..64) }';

/** Parse the shared task-command payload shape (total, fail-closed, strict keys). */
export function parseTaskCommandPayload(raw: unknown): ParseResult<TaskCommandPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', TASK_COMMAND_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, TASK_COMMAND_KEYS, '', TASK_COMMAND_GRAMMAR);
  if (unknownKey) return unknownKey;
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const taskKey = requireString(raw, 'taskKey', '', TASK_KEY_RULE);
  if (!taskKey.ok) return taskKey;
  return parseOk({
    instanceId: instanceId.value,
    expectedVersion: expectedVersion.value,
    taskKey: taskKey.value,
  });
}

/** Validated payload of `workflows.skipTask` / `workflows.failTask` (with a reason). */
export interface TaskReasonPayload extends TaskCommandPayload {
  readonly reason: string;
}

const TASK_REASON_KEYS = ['instanceId', 'expectedVersion', 'taskKey', 'reason'] as const;
const TASK_REASON_GRAMMAR =
  'TaskReasonPayload: { instanceId: EntityId, expectedVersion: number (>= 1), taskKey: kebab (1..64), reason: string (1..2000) }';

/** Parse the task-with-reason payload (total, fail-closed, strict keys). */
export function parseTaskReasonPayload(raw: unknown): ParseResult<TaskReasonPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', TASK_REASON_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, TASK_REASON_KEYS, '', TASK_REASON_GRAMMAR);
  if (unknownKey) return unknownKey;
  // NOTE: the shared task-command parser CANNOT be delegated to here — its
  // own strict-keys check would reject the 'reason' key this shape adds.
  // The fields are parsed directly (same rules, same fail-closed paths).
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const taskKey = requireString(raw, 'taskKey', '', TASK_KEY_RULE);
  if (!taskKey.ok) return taskKey;
  const reason = requireString(raw, 'reason', '', REASON_RULE);
  if (!reason.ok) return reason;
  return parseOk({
    instanceId: instanceId.value,
    expectedVersion: expectedVersion.value,
    taskKey: taskKey.value,
    reason: reason.value,
  } satisfies TaskReasonPayload);
}

/** Validated payload of `workflows.submitApproval`. */
export interface SubmitApprovalPayload {
  readonly instanceId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly approvalKey: string;
}

const SUBMIT_APPROVAL_KEYS = ['instanceId', 'expectedVersion', 'approvalKey'] as const;
const SUBMIT_APPROVAL_GRAMMAR =
  'SubmitApprovalPayload: { instanceId: EntityId, expectedVersion: number (>= 1), approvalKey: kebab (1..64) }';

/** Parse the submit-approval payload (total, fail-closed, strict keys). */
export function parseSubmitApprovalPayload(
  raw: unknown,
): ParseResult<SubmitApprovalPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SUBMIT_APPROVAL_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SUBMIT_APPROVAL_KEYS, '', SUBMIT_APPROVAL_GRAMMAR);
  if (unknownKey) return unknownKey;
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const approvalKey = requireString(raw, 'approvalKey', '', APPROVAL_KEY_RULE);
  if (!approvalKey.ok) return approvalKey;
  return parseOk({
    instanceId: instanceId.value,
    expectedVersion: expectedVersion.value,
    approvalKey: approvalKey.value,
  });
}

/** Validated payload of `workflows.approveApproval` (optional note). */
export interface ApproveApprovalPayload {
  readonly instanceId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly approvalKey: string;
  readonly note?: string;
}

const APPROVE_APPROVAL_KEYS = [
  'instanceId',
  'expectedVersion',
  'approvalKey',
  'note',
] as const;
const APPROVE_APPROVAL_GRAMMAR =
  'ApproveApprovalPayload: { instanceId: EntityId, expectedVersion: number (>= 1), approvalKey: kebab (1..64), note?: string (1..2000) }';

/** Parse the approve-approval payload (total, fail-closed, strict keys). */
export function parseApproveApprovalPayload(
  raw: unknown,
): ParseResult<ApproveApprovalPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APPROVE_APPROVAL_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APPROVE_APPROVAL_KEYS, '', APPROVE_APPROVAL_GRAMMAR);
  if (unknownKey) return unknownKey;
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const approvalKey = requireString(raw, 'approvalKey', '', APPROVAL_KEY_RULE);
  if (!approvalKey.ok) return approvalKey;
  const note = optionalFieldWith(raw, 'note', '', (value) => parseStringLike(value, NOTE_RULE));
  if (!note.ok) return note;
  return parseOk({
    instanceId: instanceId.value,
    expectedVersion: expectedVersion.value,
    approvalKey: approvalKey.value,
    ...(note.value !== undefined ? { note: note.value } : {}),
  });
}

/** Validated payload of `workflows.rejectApproval` (required reason). */
export interface RejectApprovalPayload {
  readonly instanceId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly approvalKey: string;
  readonly reason: string;
}

const REJECT_APPROVAL_KEYS = [
  'instanceId',
  'expectedVersion',
  'approvalKey',
  'reason',
] as const;
const REJECT_APPROVAL_GRAMMAR =
  'RejectApprovalPayload: { instanceId: EntityId, expectedVersion: number (>= 1), approvalKey: kebab (1..64), reason: string (1..2000) }';

/** Parse the reject-approval payload (total, fail-closed, strict keys). */
export function parseRejectApprovalPayload(
  raw: unknown,
): ParseResult<RejectApprovalPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REJECT_APPROVAL_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, REJECT_APPROVAL_KEYS, '', REJECT_APPROVAL_GRAMMAR);
  if (unknownKey) return unknownKey;
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const approvalKey = requireString(raw, 'approvalKey', '', APPROVAL_KEY_RULE);
  if (!approvalKey.ok) return approvalKey;
  const reason = requireString(raw, 'reason', '', REASON_RULE);
  if (!reason.ok) return reason;
  return parseOk({
    instanceId: instanceId.value,
    expectedVersion: expectedVersion.value,
    approvalKey: approvalKey.value,
    reason: reason.value,
  });
}

/** Validated payload of `workflows.escalateInstance` (the SLA sweep). */
export interface EscalateInstancePayload {
  readonly instanceId: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const ESCALATE_INSTANCE_KEYS = ['instanceId', 'expectedVersion'] as const;
const ESCALATE_INSTANCE_GRAMMAR =
  'EscalateInstancePayload: { instanceId: EntityId, expectedVersion: number (>= 1) }';

/** Parse the escalate-instance payload (total, fail-closed, strict keys). */
export function parseEscalateInstancePayload(
  raw: unknown,
): ParseResult<EscalateInstancePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ESCALATE_INSTANCE_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    ESCALATE_INSTANCE_KEYS,
    '',
    ESCALATE_INSTANCE_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const instanceId = requireFieldWith(raw, 'instanceId', '', parseEntityId);
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({ instanceId: instanceId.value, expectedVersion: expectedVersion.value });
}

// ----- command service ------------------------------------------------------------------

/**
 * Wiring dependencies of the workflow command service. `now` and
 * `newOpaqueId` are the injected suppliers (determinism rule): fixed values
 * in tests, wall clock / crypto randomness in production wiring. `executor`
 * is the transaction handle handed to the EventSink with every append — the
 * runtime's open transaction executor when the sink is transactional (the
 * ledger-backed adapter), any opaque handle for in-memory sinks.
 */
export interface WorkflowCommandDeps {
  /** The aggregate-keeper port (in-memory reference implementation shipped). */
  readonly store: WorkflowStore;
  /** The audit-event sink (in-memory and ledger-backed implementations shipped). */
  readonly eventSink: EventSink;
  /** The idempotency registry keyed by (scope, idempotency key). */
  readonly idempotencyRegistry: IdempotencyRegistry;
  /** Injected clock: the canonical 'now' of each execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier (composed via formatEntityId). */
  readonly newOpaqueId: () => string;
  /** The executor (transaction handle) the sink appends with. */
  readonly executor: SqlExecutor;
}

/**
 * Caller-supplied authorization inputs for one command execution: the
 * deny-by-default policy (static, data-driven) and the capabilities granted
 * to the command's actor for THIS request (e.g. the expansion of a user's
 * roles, an app installation's manifest capabilities, an agent run's grant).
 */
export interface WorkflowCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/**
 * The typed outcome of a workflow command: the committed aggregate state,
 * plus whether this execution REPLAYED a prior one (same (scope,
 * idempotency key) had already executed — the original outcome is returned,
 * no second effect).
 */
export interface WorkflowCommandOutcome<T> {
  /** True when the recorded outcome of a prior execution was replayed. */
  readonly replayed: boolean;
  /** The committed aggregate state (the ORIGINAL outcome on replay). */
  readonly state: T;
}

/** The workflow-definition command surface. */
export interface DefinitionCommands {
  /** Create a NEW definition version row of a key, in 'draft' (the immutability rule: a change is a new version). */
  createDefinition(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowDefinitionState>>>;
  /** Replace the model of a DRAFT definition (published definitions are immutable — typed rejection). */
  updateDefinition(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowDefinitionState>>>;
  /** Publish a DRAFT definition — the one-way freeze. */
  publishDefinition(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowDefinitionState>>>;
}

/** The workflow-instance command surface. */
export interface InstanceCommands {
  /** Start an instance from a PINNED PUBLISHED definition + a typed subject EntityRef. */
  startInstance(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /** Execute one typed, guarded transition of the deterministic machine. */
  executeTransition(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /** Run the SLA escalation sweep at the injected now (reassigns per the pinned definition). */
  escalateInstance(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
}

/** The task command surface. */
export interface TaskCommands {
  /** Assign a 'created' task (the SLA clock starts). */
  assignTask(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /** Start an 'assigned' task (the first attempt). */
  startTask(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /** Complete an 'in-progress' task (terminal outcome 'completed'). */
  completeTask(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /** Skip an open task with a required reason (outcome 'skipped'). */
  skipTask(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /** Record the failure of an 'in-progress' attempt (retryable, or 'exhausted' when the policy is spent). */
  failTask(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /** Retry a retryable 'failed' task after the deterministic backoff gate elapsed. */
  retryTask(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
}

/** The approval command surface (THE capability-gated seam, freeze A8). */
export interface ApprovalCommands {
  /** Submit a 'pending' approval request for decision. */
  submitApproval(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /**
   * Approve a 'submitted' approval — requires the approval's REQUIRED
   * capability through a policy that allows the decision (no bypass path).
   */
  approveApproval(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
  /**
   * Reject a 'submitted' approval with a required reason — requires the same
   * REQUIRED capability (a rejection is a consequential decision too).
   */
  rejectApproval(
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
  ): Promise<CommandResult<WorkflowCommandOutcome<WorkflowInstanceState>>>;
}

/** The workflow command surface: three aggregate command groups. */
export interface WorkflowCommands {
  readonly definitions: DefinitionCommands;
  readonly instances: InstanceCommands;
  readonly tasks: TaskCommands;
  readonly approvals: ApprovalCommands;
}

/** Create the workflow command service. */
export function createWorkflowCommands(deps: WorkflowCommandDeps): WorkflowCommands {
  const errorContextOf = (command: CommandEnvelope<unknown>): DomainErrorContext => ({
    scope: command.scope,
    correlationId: command.causality.correlationId,
  });

  /** Translate a payload parse failure into the typed domain failure. */
  const invalidPayload = (
    error: { readonly code: string; readonly path: string; readonly expected: string; readonly received: string },
    command: CommandEnvelope<unknown>,
  ): DomainError =>
    domainError(
      'invariant-violation',
      `invalid command payload for '${command.commandName}': ${error.code} at '${
        error.path === '' ? '<root>' : error.path
      }' — expected ${error.expected}, received ${error.received}`,
      [
        {
          code: 'invalid-command-payload',
          message: `${error.code}: expected ${error.expected}, received ${error.received}`,
          path: error.path === '' ? null : error.path,
        },
      ],
      errorContextOf(command),
    );

  /** Build the request's AuthorizationContext from the command envelope. */
  const contextOf = (
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
    scope: Scope,
  ): AuthorizationContext =>
    authorizationContext({
      actor: command.actor,
      scope,
      capabilities: authorization.capabilities,
    });

  /**
   * Every workflow command requires PROJECT scope (freeze A12 second
   * boundary): definitions and instances are project-bound, so a
   * tenant-scoped command cannot address one — typed unauthorized
   * 'project-scope-required'.
   */
  const requireProjectScope = (
    command: CommandEnvelope<unknown>,
  ): Result<ProjectScope, DomainError> => {
    if (command.scope.kind === 'project') return { ok: true, value: command.scope };
    return {
      ok: false,
      error: domainError(
        'unauthorized',
        `workflow command '${command.commandName}' requires project scope (the second authorization boundary, freeze A12); received ${command.scope.kind} scope`,
        [
          {
            code: 'project-scope-required',
            message: `received ${command.scope.kind} scope`,
            path: 'scope',
          },
        ],
        errorContextOf(command),
      ),
    };
  };

  /** The write authorization of one workflow mutation (deny-by-default). */
  const authorizeWrite = (
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
    projectScope: ProjectScope,
    resourceKind: EntityKind,
    resourceId: EntityId | null,
  ): Result<unknown, DomainError> =>
    authorize(
      authorization.policy,
      contextOf(command, authorization, projectScope),
      resourceScope({
        scope: projectScope,
        resourceKind,
        resourceId,
        ownerId: null,
      }),
      'write',
      errorContextOf(command),
    );

  /**
   * Execute one command idempotently through the registry: the first
   * execution records its outcome under (scope, idempotency key); a
   * same-fingerprint replay returns the ORIGINAL outcome with replayed:
   * true; a different fingerprint is a typed idempotency-conflict; failures
   * are never recorded (retryable).
   */
  const runIdempotent = async <T>(
    command: CommandEnvelope<unknown>,
    execute: () => Promise<Result<T, DomainError>> | Result<T, DomainError>,
  ): Promise<CommandResult<WorkflowCommandOutcome<T>>> => {
    const executed = await withIdempotency(deps.idempotencyRegistry, command, execute);
    if (!executed.ok) return executed;
    return {
      ok: true,
      value: { replayed: executed.value.replayed, state: executed.value.value },
    };
  };

  /** The optimistic-concurrency token of an addressed aggregate. */
  const tokenOf = (
    entityKind: EntityKind,
    entityId: EntityId,
    version: AggregateVersion,
  ): ConcurrencyToken => ({
    kind: 'concurrency-token',
    entityKind,
    entityId,
    version,
  });

  /** Issue one fresh canonical EntityId from the injected supplier. */
  const newEntityId = (): EntityId =>
    formatEntityId({ version: 'v1', opaque: deps.newOpaqueId() });

  /** The actor's canonical id when identified (null for the system actor). */
  const actorIdOf = (command: CommandEnvelope<unknown>): EntityId | null =>
    command.actor.kind === 'system' ? null : command.actor.actorId;

  /** Append audit events through the sink (typed failure passthrough). */
  const appendEvents = (
    envelopes: readonly ReturnType<typeof workflowEventEnvelope>[],
  ): Promise<Result<true, DomainError>> =>
    deps.eventSink.appendEvents(deps.executor, envelopes);

  /**
   * Load an instance AND its pinned definition through the scoped store with
   * the kernel A12 backstop (defense in depth for alternative stores).
   */
  const loadInstanceWithDefinition = (
    scope: Scope,
    instanceId: EntityId,
    context?: DomainErrorContext,
  ): Result<{ instance: WorkflowInstanceState; definition: WorkflowDefinitionState }, DomainError> => {
    const instance = deps.store.findInstance(scope, instanceId, context);
    if (!instance.ok) return instance;
    const definition = deps.store.findDefinition(scope, instance.value.definitionId, context);
    if (!definition.ok) return definition;
    const coverage = checkScopeCovers(scope, definition.value.scope, context);
    if (!coverage.ok) return coverage;
    return { ok: true, value: { instance: instance.value, definition: definition.value } };
  };

  /** The concurrency check of one addressed aggregate. */
  const checkVersion = (
    entityKind: EntityKind,
    entityId: EntityId,
    expected: AggregateVersion,
    actual: { readonly version: AggregateVersion },
    context?: DomainErrorContext,
  ): Result<true, DomainError> =>
    checkConcurrency(tokenOf(entityKind, entityId, expected), {
      kind: 'concurrency-token',
      entityKind,
      entityId,
      version: actual.version,
    }, context);

  /** The task-of-instance not-found error (typed; state untouched). */
  const taskNotFoundOf = (
    instance: WorkflowInstanceState,
    taskKey: string,
    context?: DomainErrorContext,
  ): DomainError =>
    domainError(
      'not-found',
      `task '${taskKey}' not found on workflow instance ${instance.entityId}`,
      [{ code: 'task-not-found', message: `task key '${taskKey}'`, path: 'taskKey' }],
      context,
    );

  /** The approval-of-instance not-found error (typed; state untouched). */
  const approvalNotFoundOf = (
    instance: WorkflowInstanceState,
    approvalKey: string,
    context?: DomainErrorContext,
  ): DomainError =>
    domainError(
      'not-found',
      `approval '${approvalKey}' not found on workflow instance ${instance.entityId}`,
      [{ code: 'approval-not-found', message: `approval key '${approvalKey}'`, path: 'approvalKey' }],
      context,
    );

  /**
   * THE approval gate (freeze A8): resolve the addressed approval from the
   * loaded instance, verify the actor holds the REQUIRED capability, and
   * check the caller-supplied policy allows the decision. Every denial emits
   * the AUDIT-ONLY approvalDenied event and returns a typed 'forbidden'
   * failure — the aggregate is never advanced by a denial.
   */
  const approvalGate = async (
    command: CommandEnvelope<unknown>,
    authorization: WorkflowCommandAuthorization,
    instance: WorkflowInstanceState,
    approvalKey: string,
    attemptedDecision: 'approve' | 'reject',
  ): Promise<Result<ApprovalState, DomainError>> => {
    const context = errorContextOf(command);
    const approval = instance.approvals.find((a) => a.key === approvalKey);
    if (approval === undefined) {
      return {
        ok: false,
        error: domainError(
          'not-found',
          `approval '${approvalKey}' not found on workflow instance ${instance.entityId}`,
          [
            {
              code: 'approval-not-found',
              message: `approval key '${approvalKey}'`,
              path: 'approvalKey',
            },
          ],
          context,
        ),
      };
    }

    // Gate 1 — the REQUIRED capability (declared by the pinned definition).
    if (!authorization.capabilities.includes(approval.requiredCapability)) {
      const denial = domainError(
        'forbidden',
        `approval '${approvalKey}' on workflow instance ${instance.entityId} requires capability '${approval.requiredCapability}' which the actor does not hold; the decision is denied`,
        [
          {
            code: 'missing-required-capability',
            message: `approval '${approvalKey}' requires '${approval.requiredCapability}'`,
            path: 'approvalKey',
          },
        ],
        context,
      );
      const appended = await appendEvents([
        workflowEventEnvelope({
          command,
          eventName: APPROVAL_DENIED_EVENT,
          scope: instance.scope,
          occurredAt: deps.now(),
          entityRefs: unchangedRefs(instance),
          payload: {
            instanceId: instance.entityId,
            approvalKey,
            attemptedDecision,
            requiredCapability: approval.requiredCapability,
            policyRef: approval.policyRef,
            denialCode: 'missing-required-capability',
            denialMessage: `actor does not hold '${approval.requiredCapability}'`,
            version: instance.version,
          },
        }),
      ]);
      if (!appended.ok) return appended;
      return { ok: false, error: denial };
    }

    // Gate 2 — the caller-supplied policy must allow the decision
    // (deny-by-default: explicit deny wins; no allow rule denies).
    if (command.scope.kind !== 'project') {
      // Unreachable behind requireProjectScope; kept total for type safety.
      return {
        ok: false,
        error: domainError(
          'unauthorized',
          `workflow command '${command.commandName}' requires project scope`,
          [{ code: 'project-scope-required', message: 'non-project scope', path: 'scope' }],
          context,
        ),
      };
    }
    const decision = authorize(
      authorization.policy,
      contextOf(command, authorization, command.scope),
      resourceScope({
        scope: command.scope,
        resourceKind: WORKFLOW_INSTANCE_KIND,
        resourceId: instance.entityId,
        ownerId: null,
      }),
      'write',
      context,
    );
    if (!decision.ok) {
      const denialCode =
        decision.error.details[0]?.code === 'explicit-deny' ? 'explicit-deny' : 'no-allow-rule';
      const appended = await appendEvents([
        workflowEventEnvelope({
          command,
          eventName: APPROVAL_DENIED_EVENT,
          scope: instance.scope,
          occurredAt: deps.now(),
          entityRefs: unchangedRefs(instance),
          payload: {
            instanceId: instance.entityId,
            approvalKey,
            attemptedDecision,
            requiredCapability: approval.requiredCapability,
            policyRef: approval.policyRef,
            denialCode: 'policy-denied',
            denialMessage: `policy denial (${denialCode}) blocks the decision`,
            version: instance.version,
          },
        }),
      ]);
      if (!appended.ok) return appended;
      return decision;
    }

    return { ok: true, value: approval };
  };

  return {
    definitions: {
      createDefinition: async (command, authorization) => {
        requireCommandName(command, CREATE_DEFINITION_COMMAND);
        const payload = parseCreateDefinitionPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_DEFINITION_KIND,
          null,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const scope: Scope = projectScope.value;
          const context = errorContextOf(command);
          const definitionId = newEntityId();

          const existing = deps.store.findDefinitionsByKey(scope, payload.value.key, context);
          if (!existing.ok) return existing;
          const definitionVersion = nextDefinitionVersionOf(existing.value);

          const initial = createWorkflowDefinitionState(
            {
              definitionId,
              key: payload.value.key,
              definitionVersion,
              title: payload.value.title,
              ...(payload.value.description !== undefined
                ? { description: payload.value.description }
                : {}),
              model: payload.value.model,
              now,
            },
            scope,
            context,
          );
          if (!initial.ok) return initial;

          const event = workflowEventEnvelope({
            command,
            eventName: DEFINITION_CREATED_EVENT,
            scope,
            occurredAt: now,
            entityRefs: createdRefs(initial.value),
            payload: {
              definitionId: initial.value.entityId,
              key: initial.value.key,
              definitionVersion: initial.value.definitionVersion,
              title: initial.value.title,
              description: initial.value.description,
              status: initial.value.status,
              version: initial.value.version,
              createdAt: initial.value.createdAt,
            },
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveDefinition(initial.value);
          return { ok: true, value: initial.value };
        });
      },

      updateDefinition: async (command, authorization) => {
        requireCommandName(command, UPDATE_DEFINITION_COMMAND);
        const payload = parseUpdateDefinitionPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_DEFINITION_KIND,
          payload.value.definitionId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findDefinition(command.scope, payload.value.definitionId, context);
          if (!loaded.ok) return loaded;
          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkVersion(
            WORKFLOW_DEFINITION_KIND,
            payload.value.definitionId,
            payload.value.expectedVersion,
            loaded.value,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = updateWorkflowDefinitionModelState(
            loaded.value,
            payload.value.model,
            now,
            context,
          );
          if (!next.ok) return next;

          const event = workflowEventEnvelope({
            command,
            eventName: DEFINITION_UPDATED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              definitionId: next.value.entityId,
              key: next.value.key,
              definitionVersion: next.value.definitionVersion,
              status: next.value.status,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveDefinition(next.value);
          return { ok: true, value: next.value };
        });
      },

      publishDefinition: async (command, authorization) => {
        requireCommandName(command, PUBLISH_DEFINITION_COMMAND);
        const payload = parsePublishDefinitionPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_DEFINITION_KIND,
          payload.value.definitionId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findDefinition(command.scope, payload.value.definitionId, context);
          if (!loaded.ok) return loaded;
          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkVersion(
            WORKFLOW_DEFINITION_KIND,
            payload.value.definitionId,
            payload.value.expectedVersion,
            loaded.value,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = publishWorkflowDefinitionState(loaded.value, now, context);
          if (!next.ok) return next;

          const event = workflowEventEnvelope({
            command,
            eventName: DEFINITION_PUBLISHED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              definitionId: next.value.entityId,
              key: next.value.key,
              definitionVersion: next.value.definitionVersion,
              publishedAt: next.value.publishedAt ?? now,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveDefinition(next.value);
          return { ok: true, value: next.value };
        });
      },
    },

    instances: {
      startInstance: async (command, authorization) => {
        requireCommandName(command, START_INSTANCE_COMMAND);
        const payload = parseStartInstancePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          null,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const scope: Scope = projectScope.value;
          const context = errorContextOf(command);
          const instanceId = newEntityId();

          const definition = deps.store.findDefinition(
            scope,
            payload.value.definitionId,
            context,
          );
          if (!definition.ok) return definition;
          const coverage = checkScopeCovers(scope, definition.value.scope, context);
          if (!coverage.ok) return coverage;

          const initial = createWorkflowInstanceState(
            definition.value,
            { instanceId, subject: payload.value.subject, now },
            scope,
            context,
          );
          if (!initial.ok) return initial;

          const event = workflowEventEnvelope({
            command,
            eventName: INSTANCE_STARTED_EVENT,
            scope,
            occurredAt: now,
            entityRefs: createdRefs(initial.value),
            payload: {
              instanceId: initial.value.entityId,
              definitionId: initial.value.definitionId,
              definitionKey: initial.value.definitionKey,
              definitionVersion: initial.value.definitionVersion,
              subject: initial.value.subject,
              currentState: initial.value.currentState,
              status: initial.value.status,
              taskCount: initial.value.tasks.length,
              approvalCount: initial.value.approvals.length,
              version: initial.value.version,
              startedAt: initial.value.startedAt,
            },
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(initial.value);
          return { ok: true, value: initial.value };
        });
      },

      executeTransition: async (command, authorization) => {
        requireCommandName(command, EXECUTE_TRANSITION_COMMAND);
        const payload = parseExecuteTransitionPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const transition = transitionWorkflowInstanceState(
            definition.model,
            instance,
            payload.value.transitionKey,
            contextOf(command, authorization, command.scope).capabilities,
            now,
            context,
          );
          if (!transition.ok) return transition;

          const names = transitionEventNamesOf(transition.value);
          const payloads = transitionPayloadsOf(transition.value, instance);
          const envelopes = names.map((eventName, index) =>
            workflowEventEnvelope({
              command,
              eventName,
              scope: transition.value.state.scope,
              occurredAt: now,
              entityRefs: updatedRefs(instance, transition.value.state),
              payload: payloads[index] as WorkflowAuditPayload,
            }),
          );
          const appended = await appendEvents(envelopes);
          if (!appended.ok) return appended;

          deps.store.saveInstance(transition.value.state);
          return { ok: true, value: transition.value.state };
        });
      },

      escalateInstance: async (command, authorization) => {
        requireCommandName(command, ESCALATE_INSTANCE_COMMAND);
        const payload = parseEscalateInstancePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const escalation = escalateWorkflowInstanceState(
            definition.model,
            instance,
            now,
            context,
          );
          if (!escalation.ok) return escalation;

          if (escalation.value.escalatedTasks.length === 0) {
            // Nothing breached: no event, no version bump, state unchanged.
            return { ok: true, value: escalation.value.state };
          }

          const envelopes = escalation.value.escalatedTasks.map((record) =>
            workflowEventEnvelope({
              command,
              eventName: TASK_ESCALATED_EVENT,
              scope: escalation.value.state.scope,
              occurredAt: now,
              entityRefs: updatedRefs(instance, escalation.value.state),
              payload: escalationPayloadOf(escalation.value.state, record),
            }),
          );
          const appended = await appendEvents(envelopes);
          if (!appended.ok) return appended;

          deps.store.saveInstance(escalation.value.state);
          return { ok: true, value: escalation.value.state };
        });
      },
    },

    tasks: {
      assignTask: async (command, authorization) => {
        requireCommandName(command, ASSIGN_TASK_COMMAND);
        const payload = parseAssignTaskPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;
          const taskDefinition = definition.model.tasks.find(
            (task) => task.key === payload.value.taskKey,
          );
          if (taskDefinition === undefined) {
            return { ok: false, error: taskNotFoundOf(instance, payload.value.taskKey, context) };
          }

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = assignWorkflowTaskState(
            instance,
            payload.value.taskKey,
            payload.value.assignee,
            taskDefinition.slaMinutes,
            now,
            context,
          );
          if (!next.ok) return next;

          const task = next.value.tasks.find((t) => t.key === payload.value.taskKey);
          if (task === undefined) {
            return { ok: false, error: taskNotFoundOf(next.value, payload.value.taskKey, context) };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: TASK_ASSIGNED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: taskPayloadOf(next.value, task, {
              maxAttempts: definition.model.retryPolicy.maxAttempts,
            }),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },

      startTask: async (command, authorization) => {
        requireCommandName(command, START_TASK_COMMAND);
        const payload = parseTaskCommandPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = startWorkflowTaskState(
            instance,
            payload.value.taskKey,
            now,
            context,
          );
          if (!next.ok) return next;

          const task = next.value.tasks.find((t) => t.key === payload.value.taskKey);
          if (task === undefined) {
            return { ok: false, error: taskNotFoundOf(next.value, payload.value.taskKey, context) };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: TASK_STARTED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: taskPayloadOf(next.value, task, {
              maxAttempts: definition.model.retryPolicy.maxAttempts,
            }),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },

      completeTask: async (command, authorization) => {
        requireCommandName(command, COMPLETE_TASK_COMMAND);
        const payload = parseTaskCommandPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = completeWorkflowTaskState(
            instance,
            payload.value.taskKey,
            now,
            context,
          );
          if (!next.ok) return next;

          const task = next.value.tasks.find((t) => t.key === payload.value.taskKey);
          if (task === undefined) {
            return { ok: false, error: taskNotFoundOf(next.value, payload.value.taskKey, context) };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: TASK_COMPLETED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: taskPayloadOf(next.value, task, {
              maxAttempts: definition.model.retryPolicy.maxAttempts,
            }),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },

      skipTask: async (command, authorization) => {
        requireCommandName(command, SKIP_TASK_COMMAND);
        const payload = parseTaskReasonPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = skipWorkflowTaskState(
            instance,
            payload.value.taskKey,
            payload.value.reason,
            now,
            context,
          );
          if (!next.ok) return next;

          const task = next.value.tasks.find((t) => t.key === payload.value.taskKey);
          if (task === undefined) {
            return { ok: false, error: taskNotFoundOf(next.value, payload.value.taskKey, context) };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: TASK_SKIPPED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: taskPayloadOf(next.value, task, {
              maxAttempts: definition.model.retryPolicy.maxAttempts,
            }),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },

      failTask: async (command, authorization) => {
        requireCommandName(command, FAIL_TASK_COMMAND);
        const payload = parseTaskReasonPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = failWorkflowTaskState(
            instance,
            payload.value.taskKey,
            payload.value.reason,
            definition.model.retryPolicy,
            now,
            context,
          );
          if (!next.ok) return next;

          const task = next.value.tasks.find((t) => t.key === payload.value.taskKey);
          if (task === undefined) {
            return { ok: false, error: taskNotFoundOf(next.value, payload.value.taskKey, context) };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: TASK_FAILED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: taskPayloadOf(next.value, task, {
              maxAttempts: definition.model.retryPolicy.maxAttempts,
            }),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },

      retryTask: async (command, authorization) => {
        requireCommandName(command, RETRY_TASK_COMMAND);
        const payload = parseTaskCommandPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance, definition } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = retryWorkflowTaskState(
            instance,
            payload.value.taskKey,
            definition.model.retryPolicy,
            now,
            context,
          );
          if (!next.ok) return next;

          const task = next.value.tasks.find((t) => t.key === payload.value.taskKey);
          if (task === undefined) {
            return { ok: false, error: taskNotFoundOf(next.value, payload.value.taskKey, context) };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: TASK_RETRIED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: taskPayloadOf(next.value, task, {
              maxAttempts: definition.model.retryPolicy.maxAttempts,
            }),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },
    },

    approvals: {
      submitApproval: async (command, authorization) => {
        requireCommandName(command, SUBMIT_APPROVAL_COMMAND);
        const payload = parseSubmitApprovalPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          WORKFLOW_INSTANCE_KIND,
          payload.value.instanceId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = loadInstanceWithDefinition(
            command.scope,
            payload.value.instanceId,
            context,
          );
          if (!loaded.ok) return loaded;
          const { instance } = loaded.value;

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = submitWorkflowApprovalState(
            instance,
            payload.value.approvalKey,
            actorIdOf(command),
            now,
            context,
          );
          if (!next.ok) return next;

          const approval = next.value.approvals.find(
            (a) => a.key === payload.value.approvalKey,
          );
          if (approval === undefined) {
            return {
              ok: false,
              error: approvalNotFoundOf(next.value, payload.value.approvalKey, context),
            };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: APPROVAL_SUBMITTED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: approvalPayloadOf(next.value, approval),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },

      approveApproval: async (command, authorization) => {
        requireCommandName(command, APPROVE_APPROVAL_COMMAND);
        const payload = parseApproveApprovalPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;

        // THE approval gate runs BEFORE the idempotency registry: the
        // required capability is declared by the pinned definition, so the
        // addressed instance must be resolved first (the documented ordering
        // deviation of this package — a denied decision never consults the
        // registry, never mutates, and is audited).
        const loaded = loadInstanceWithDefinition(
          command.scope,
          payload.value.instanceId,
          errorContextOf(command),
        );
        if (!loaded.ok) return loaded;
        const { instance } = loaded.value;

        const gate = await approvalGate(
          command,
          authorization,
          instance,
          payload.value.approvalKey,
          'approve',
        );
        if (!gate.ok) return gate;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = decideWorkflowApprovalState(
            instance,
            payload.value.approvalKey,
            'approved',
            actorIdOf(command),
            payload.value.note ?? null,
            now,
            context,
          );
          if (!next.ok) return next;

          const approval = next.value.approvals.find(
            (a) => a.key === payload.value.approvalKey,
          );
          if (approval === undefined) {
            return {
              ok: false,
              error: approvalNotFoundOf(next.value, payload.value.approvalKey, context),
            };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: APPROVAL_APPROVED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: approvalPayloadOf(next.value, approval),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },

      rejectApproval: async (command, authorization) => {
        requireCommandName(command, REJECT_APPROVAL_COMMAND);
        const payload = parseRejectApprovalPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;

        // THE approval gate (same as approve — a rejection is a consequential
        // decision requiring the same capability): before idempotency, audited.
        const loaded = loadInstanceWithDefinition(
          command.scope,
          payload.value.instanceId,
          errorContextOf(command),
        );
        if (!loaded.ok) return loaded;
        const { instance } = loaded.value;

        const gate = await approvalGate(
          command,
          authorization,
          instance,
          payload.value.approvalKey,
          'reject',
        );
        if (!gate.ok) return gate;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const concurrency = checkVersion(
            WORKFLOW_INSTANCE_KIND,
            payload.value.instanceId,
            payload.value.expectedVersion,
            instance,
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = decideWorkflowApprovalState(
            instance,
            payload.value.approvalKey,
            'rejected',
            actorIdOf(command),
            payload.value.reason,
            now,
            context,
          );
          if (!next.ok) return next;

          const approval = next.value.approvals.find(
            (a) => a.key === payload.value.approvalKey,
          );
          if (approval === undefined) {
            return {
              ok: false,
              error: approvalNotFoundOf(next.value, payload.value.approvalKey, context),
            };
          }
          const event = workflowEventEnvelope({
            command,
            eventName: APPROVAL_REJECTED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(instance, next.value),
            payload: approvalPayloadOf(next.value, approval),
          });
          const appended = await appendEvents([event]);
          if (!appended.ok) return appended;

          deps.store.saveInstance(next.value);
          return { ok: true, value: next.value };
        });
      },
    },
  };
}
