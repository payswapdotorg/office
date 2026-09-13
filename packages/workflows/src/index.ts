// Office workflow engine — public surface (OFF-016).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-017 action gateway, OFF-018 agent runtime, OFF-019 control tower,
// OFF-025/026/030/031/036 consumers) consume the package only through this
// root entry point, never through deeper paths. Anything not re-exported
// here is package-internal and may change without notice.
//
// The package imports exactly five workspace dependencies — @office/contracts
// (envelopes + canonical ids), @office/domain-kernel (Result/DomainError,
// aggregate versioning + concurrency, invariants, the IdempotencyRegistry),
// @office/authz (the deny-by-default authorize() evaluator + the Capability
// vocabulary), @office/persistence (the SqlExecutor type of the EventSink
// port), and @office/events (the ledger-backed EventSink adapter only) — plus
// node builtins in tests. No external dependencies; the domain packages are
// deliberately NOT imported (no domain-to-domain imports, dependency rule —
// the EventSink port is mirrored in shape, which any transactional
// implementation satisfies structurally).
//
// Surface summary:
// - definition:  WorkflowModel (+ state/transition/task/approval/retry/
//                escalation types, the closed condition vocabulary,
//                parseWorkflowModel, retryBackoffSeconds, the bound
//                constants)
// - state:       WorkflowDefinitionState (+ statuses, invariants,
//                create/update/publish transitions, nextDefinitionVersionOf),
//                WorkflowInstanceState (+ TaskState/ApprovalState, statuses,
//                invariants, the deterministic machine transitions incl.
//                task lifecycle, approvals, retries, SLA escalation,
//                conditionHolds), the pure timestamp arithmetic helpers
// - store:       WorkflowStore, createInMemoryWorkflowStore (the pure-domain
//                aggregate keeper with A12 visibility semantics)
// - events:      EventSink, InMemoryEventSink, createInMemoryEventSink,
//                failingEventSink, the eighteen WORKFLOW_*_EVENT name
//                constants, WORKFLOW_EVENT_NAMES, workflowEventEnvelope,
//                createdRefs/updatedRefs/unchangedRefs, the payload builders
//                (+ payload types)
// - ledger-sink: createLedgerEventSink (+ options) — the transactional
//                appendEvent + enqueueOutbox implementation of the port
// - commands:    WorkflowCommands (+ the three command groups),
//                createWorkflowCommands, WorkflowCommandDeps,
//                WorkflowCommandAuthorization, WorkflowCommandOutcome, the
//                fifteen *_COMMAND name constants (+ payload types and their
//                fail-closed parsers)

// The versioned workflow definition model (typed, fail-closed, closed table).
export {
  APPROVAL_DECISIONS,
  ASSIGNABLE_ACTOR_KINDS,
  CONDITION_KINDS,
  MAX_BACKOFF_BASE_SECONDS,
  MAX_BACKOFF_MAX_SECONDS,
  MAX_RETRY_ATTEMPTS,
  MAX_SLA_MINUTES,
  TASK_OUTCOMES,
  WORKFLOW_STATE_KINDS,
  isWorkflowModel,
  parseDefinitionDescription,
  parseDefinitionKey,
  parseDefinitionTitle,
  parseTaskAssignment,
  parseTransitionCondition,
  parseWorkflowApprovalDefinition,
  parseWorkflowEscalationRule,
  parseWorkflowModel,
  parseWorkflowRetryPolicy,
  parseWorkflowStateDefinition,
  parseWorkflowTaskDefinition,
  parseWorkflowTransitionDefinition,
  retryBackoffSeconds,
} from './definition';
export type {
  ApprovalDecision,
  TaskAssignment,
  TaskOutcome,
  TransitionCondition,
  WorkflowApprovalDefinition,
  WorkflowEscalationRule,
  WorkflowModel,
  WorkflowRetryPolicy,
  WorkflowStateDefinition,
  WorkflowStateKind,
  WorkflowTaskDefinition,
  WorkflowTransitionDefinition,
} from './definition';

// Aggregate states, invariants, and pure lifecycle transitions (the
// deterministic machine: guard evaluation → capability check → state
// transition → task lifecycle updates).
export {
  APPROVAL_STATUSES,
  TASK_STATUSES,
  WORKFLOW_DEFINITION_INVARIANTS,
  WORKFLOW_DEFINITION_KIND,
  WORKFLOW_DEFINITION_STATUSES,
  WORKFLOW_INSTANCE_INVARIANTS,
  WORKFLOW_INSTANCE_KIND,
  WORKFLOW_INSTANCE_STATUSES,
  addSecondsToTimestamp,
  assignWorkflowTaskState,
  compareTimestamps,
  completeWorkflowTaskState,
  conditionHolds,
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
  timestampEpochMs,
  transitionWorkflowInstanceState,
  updateWorkflowDefinitionModelState,
} from './state';
export type {
  ApprovalState,
  ApprovalStatus,
  EscalatedTaskRecord,
  NewWorkflowDefinition,
  NewWorkflowInstance,
  TaskState,
  TaskStatus,
  WorkflowDefinitionState,
  WorkflowDefinitionStatus,
  WorkflowEscalationResult,
  WorkflowInstanceState,
  WorkflowInstanceStatus,
  WorkflowTransitionResult,
} from './state';

// The pure-domain aggregate keeper (A12 visibility by construction).
export { createInMemoryWorkflowStore } from './store';
export type { WorkflowStore } from './store';

// Audit events + THE EventSink port (minimal; the ledger-backed adapter
// below implements it transactionally over @office/events).
export {
  APPROVAL_APPROVED_EVENT,
  APPROVAL_DENIED_EVENT,
  APPROVAL_REJECTED_EVENT,
  APPROVAL_SUBMITTED_EVENT,
  DEFINITION_CREATED_EVENT,
  DEFINITION_PUBLISHED_EVENT,
  DEFINITION_UPDATED_EVENT,
  INSTANCE_COMPLETED_EVENT,
  INSTANCE_FAILED_EVENT,
  INSTANCE_STARTED_EVENT,
  TASK_ASSIGNED_EVENT,
  TASK_COMPLETED_EVENT,
  TASK_ESCALATED_EVENT,
  TASK_FAILED_EVENT,
  TASK_RETRIED_EVENT,
  TASK_SKIPPED_EVENT,
  TASK_STARTED_EVENT,
  TRANSITION_EXECUTED_EVENT,
  WORKFLOW_EVENT_NAMES,
  approvalPayloadOf,
  createdRefs,
  createInMemoryEventSink,
  escalationPayloadOf,
  eventSinkFailure,
  failingEventSink,
  taskPayloadOf,
  transitionEventNamesOf,
  transitionPayloadsOf,
  unchangedRefs,
  updatedRefs,
  workflowEntityRef,
  workflowEventEnvelope,
} from './events';
export type {
  ApprovalApprovedPayload,
  ApprovalDeniedPayload,
  ApprovalRejectedPayload,
  ApprovalSubmittedPayload,
  DefinitionCreatedPayload,
  DefinitionPublishedPayload,
  DefinitionUpdatedPayload,
  EventSink,
  InMemoryEventSink,
  InstanceCompletedPayload,
  InstanceFailedPayload,
  InstanceStartedPayload,
  RecordedEventAppend,
  TaskAssignedPayload,
  TaskCompletedPayload,
  TaskEscalatedPayload,
  TaskFailedPayload,
  TaskRetriedPayload,
  TaskSkippedPayload,
  TaskStartedPayload,
  TransitionExecutedPayload,
  WorkflowAuditPayload,
} from './events';

// The transactional ledger-backed EventSink adapter.
export { createLedgerEventSink } from './ledger-sink';
export type { LedgerEventSinkOptions } from './ledger-sink';

// Command handlers (parse → project-scope → authorize → idempotency → load
// → concurrency → invariant-checked pure transition → sink append + store
// commit; the approval commands resolve their capability gate from the
// pinned definition before the registry — audited denials, no bypass path).
export {
  APPROVE_APPROVAL_COMMAND,
  ASSIGN_TASK_COMMAND,
  COMPLETE_TASK_COMMAND,
  CREATE_DEFINITION_COMMAND,
  ESCALATE_INSTANCE_COMMAND,
  EXECUTE_TRANSITION_COMMAND,
  FAIL_TASK_COMMAND,
  PUBLISH_DEFINITION_COMMAND,
  REJECT_APPROVAL_COMMAND,
  RETRY_TASK_COMMAND,
  SKIP_TASK_COMMAND,
  START_INSTANCE_COMMAND,
  START_TASK_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
  UPDATE_DEFINITION_COMMAND,
  createWorkflowCommands,
  parseApproveApprovalPayload,
  parseAssignTaskPayload,
  parseCreateDefinitionPayload,
  parseEscalateInstancePayload,
  parseExecuteTransitionPayload,
  parsePublishDefinitionPayload,
  parseRejectApprovalPayload,
  parseStartInstancePayload,
  parseSubmitApprovalPayload,
  parseTaskCommandPayload,
  parseTaskReasonPayload,
  parseUpdateDefinitionPayload,
} from './commands';
export type {
  ApprovalCommands,
  ApproveApprovalPayload,
  AssignTaskPayload,
  CreateDefinitionPayload,
  DefinitionCommands,
  EscalateInstancePayload,
  ExecuteTransitionPayload,
  InstanceCommands,
  PublishDefinitionPayload,
  RejectApprovalPayload,
  StartInstancePayload,
  SubmitApprovalPayload,
  TaskCommandPayload,
  TaskCommands,
  TaskReasonPayload,
  UpdateDefinitionPayload,
  WorkflowCommandAuthorization,
  WorkflowCommandDeps,
  WorkflowCommandOutcome,
  WorkflowCommands,
} from './commands';
