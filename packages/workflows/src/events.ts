// Office workflow engine — audit events + the EventSink port (OFF-016).
//
// Freeze A3: every consequential domain mutation emits an immutable domain
// event carrying event name, tenant/project scope, actor, source, correlation
// and causation ids, schema version, occurred-at, and before/after entity
// references. This module defines the workflow event vocabulary (definition
// created/updated/published; instance started; transition executed; task
// assigned/started/completed/skipped/failed/retried/escalated; approval
// submitted/approved/rejected/denied; instance completed/failed) and the
// builder that turns a command envelope + the resulting state into a
// DomainEventEnvelope.
//
// `workflows.approvalDenied` is AUDIT-ONLY: it records a denied approval
// decision attempt (missing required capability, or a policy denial) WITHOUT
// mutating the aggregate — before/after reference the same unchanged
// instance. Freeze A8 (AI execution boundary): the audit trail proves an
// approval-requiring action cannot bypass policy, including on the
// idempotency/retry paths.
//
// THE EventSink PORT (mirrored byte-for-byte in shape from the landed
// @office/domain-* modules — no domain-to-domain imports, dependency rule):
// command handlers hand their envelope(s) to an injected sink TOGETHER with
// the state writes, inside the SAME transaction — the sink receives the
// transaction's SqlExecutor so a real implementation (the OFF-005 event
// ledger, wired by the runtime or the ledger-backed adapter in this package's
// ledger-sink.ts) writes the ledger rows in that transaction and the whole
// mutation is atomic. This package ships an in-memory sink for tests and a
// failing sink for failure-path tests. Any transactional EventSink
// implementation satisfies this port structurally.
import {
  CURRENT_SCHEMA_VERSION,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEventName,
} from '@office/contracts';
import type {
  CommandEnvelope,
  Causality,
  DomainEventEnvelope,
  EntityId,
  EntityKind,
  EntityRef,
  EntityRefs,
  EventName,
  Scope,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type {
  ApprovalState,
  TaskState,
  WorkflowDefinitionState,
  WorkflowInstanceState,
  WorkflowTransitionResult,
} from './state';
import type { EscalatedTaskRecord } from './state';
import { timestampEpochMs } from './state';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid workflow event name literal: ${name}`);
  }
  return parsed.value;
};

// ----- event name vocabulary (freeze A3 audit) ---------------------------------------

/** Event name of the definition-created event (a new draft definition row). */
export const DEFINITION_CREATED_EVENT: EventName = eventNameOf('workflows.definitionCreated');
/** Event name of the definition-updated event (draft model replacement). */
export const DEFINITION_UPDATED_EVENT: EventName = eventNameOf('workflows.definitionUpdated');
/** Event name of the definition-published event (the freeze). */
export const DEFINITION_PUBLISHED_EVENT: EventName = eventNameOf(
  'workflows.definitionPublished',
);
/** Event name of the instance-started event (workflow started). */
export const INSTANCE_STARTED_EVENT: EventName = eventNameOf('workflows.instanceStarted');
/** Event name of the transition-executed event (the deterministic machine step). */
export const TRANSITION_EXECUTED_EVENT: EventName = eventNameOf(
  'workflows.transitionExecuted',
);
/** Event name of the task-assigned event. */
export const TASK_ASSIGNED_EVENT: EventName = eventNameOf('workflows.taskAssigned');
/** Event name of the task-started event (an attempt begins). */
export const TASK_STARTED_EVENT: EventName = eventNameOf('workflows.taskStarted');
/** Event name of the task-completed event. */
export const TASK_COMPLETED_EVENT: EventName = eventNameOf('workflows.taskCompleted');
/** Event name of the task-skipped event. */
export const TASK_SKIPPED_EVENT: EventName = eventNameOf('workflows.taskSkipped');
/** Event name of the task-failed event (retryable or exhausted). */
export const TASK_FAILED_EVENT: EventName = eventNameOf('workflows.taskFailed');
/** Event name of the task-retried event (a new attempt after backoff). */
export const TASK_RETRIED_EVENT: EventName = eventNameOf('workflows.taskRetried');
/** Event name of the task-escalated event (SLA breach, reassignment). */
export const TASK_ESCALATED_EVENT: EventName = eventNameOf('workflows.taskEscalated');
/** Event name of the approval-submitted event. */
export const APPROVAL_SUBMITTED_EVENT: EventName = eventNameOf('workflows.approvalSubmitted');
/** Event name of the approval-approved event. */
export const APPROVAL_APPROVED_EVENT: EventName = eventNameOf('workflows.approvalApproved');
/** Event name of the approval-rejected event. */
export const APPROVAL_REJECTED_EVENT: EventName = eventNameOf('workflows.approvalRejected');
/**
 * Event name of the approval-denied event — AUDIT-ONLY (a capability/policy
 * denial of a decision attempt; the aggregate never changes).
 */
export const APPROVAL_DENIED_EVENT: EventName = eventNameOf('workflows.approvalDenied');
/** Event name of the instance-completed event (a 'success' state was reached). */
export const INSTANCE_COMPLETED_EVENT: EventName = eventNameOf('workflows.instanceCompleted');
/** Event name of the instance-failed event (a 'failure' state was reached). */
export const INSTANCE_FAILED_EVENT: EventName = eventNameOf('workflows.instanceFailed');

/** Every event name this module emits, in emission-group order. */
export const WORKFLOW_EVENT_NAMES: readonly EventName[] = [
  DEFINITION_CREATED_EVENT,
  DEFINITION_UPDATED_EVENT,
  DEFINITION_PUBLISHED_EVENT,
  INSTANCE_STARTED_EVENT,
  TRANSITION_EXECUTED_EVENT,
  TASK_ASSIGNED_EVENT,
  TASK_STARTED_EVENT,
  TASK_COMPLETED_EVENT,
  TASK_SKIPPED_EVENT,
  TASK_FAILED_EVENT,
  TASK_RETRIED_EVENT,
  TASK_ESCALATED_EVENT,
  APPROVAL_SUBMITTED_EVENT,
  APPROVAL_APPROVED_EVENT,
  APPROVAL_REJECTED_EVENT,
  APPROVAL_DENIED_EVENT,
  INSTANCE_COMPLETED_EVENT,
  INSTANCE_FAILED_EVENT,
] as const;

// ----- audit payloads (typed) ----------------------------------------------------------

/** Audit payload of `workflows.definitionCreated`. */
export interface DefinitionCreatedPayload {
  readonly definitionId: EntityId;
  readonly key: string;
  readonly definitionVersion: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `workflows.definitionUpdated` (draft model replacement). */
export interface DefinitionUpdatedPayload {
  readonly definitionId: EntityId;
  readonly key: string;
  readonly definitionVersion: number;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.definitionPublished` (the freeze). */
export interface DefinitionPublishedPayload {
  readonly definitionId: EntityId;
  readonly key: string;
  readonly definitionVersion: number;
  readonly publishedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.instanceStarted`. */
export interface InstanceStartedPayload {
  readonly instanceId: EntityId;
  readonly definitionId: EntityId;
  readonly definitionKey: string;
  readonly definitionVersion: number;
  readonly subject: EntityRef;
  readonly currentState: string;
  readonly status: string;
  readonly taskCount: number;
  readonly approvalCount: number;
  readonly version: number;
  readonly startedAt: Timestamp;
}

/** Audit payload of `workflows.transitionExecuted`. */
export interface TransitionExecutedPayload {
  readonly instanceId: EntityId;
  readonly definitionId: EntityId;
  readonly transitionKey: string;
  readonly from: string;
  readonly to: string;
  readonly requiredCapabilities: readonly string[];
  readonly skippedTaskKeys: readonly string[];
  readonly status: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.taskAssigned`. */
export interface TaskAssignedPayload {
  readonly instanceId: EntityId;
  readonly taskKey: string;
  readonly assignee: EntityId | null;
  readonly assignedAt: Timestamp;
  readonly dueAt: Timestamp | null;
  readonly slaMinutes: number | null;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.taskStarted` (an attempt begins). */
export interface TaskStartedPayload {
  readonly instanceId: EntityId;
  readonly taskKey: string;
  readonly assignee: EntityId | null;
  readonly attempts: number;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.taskCompleted`. */
export interface TaskCompletedPayload {
  readonly instanceId: EntityId;
  readonly taskKey: string;
  readonly outcome: string;
  readonly completedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.taskSkipped`. */
export interface TaskSkippedPayload {
  readonly instanceId: EntityId;
  readonly taskKey: string;
  readonly outcome: string;
  readonly reason: string;
  readonly skippedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.taskFailed` (retryable or exhausted). */
export interface TaskFailedPayload {
  readonly instanceId: EntityId;
  readonly taskKey: string;
  readonly outcome: string;
  readonly reason: string;
  readonly failedAt: Timestamp;
  readonly retryNotBefore: Timestamp | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.taskRetried` (a new attempt after backoff). */
export interface TaskRetriedPayload {
  readonly instanceId: EntityId;
  readonly taskKey: string;
  readonly attempts: number;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.taskEscalated` (SLA breach, reassignment). */
export interface TaskEscalatedPayload {
  readonly instanceId: EntityId;
  readonly taskKey: string;
  readonly from: EntityId | null;
  readonly to: EntityId;
  readonly dueAt: Timestamp;
  readonly escalatedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.approvalSubmitted`. */
export interface ApprovalSubmittedPayload {
  readonly instanceId: EntityId;
  readonly approvalKey: string;
  readonly submittedBy: EntityId | null;
  readonly submittedAt: Timestamp;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.approvalApproved`. */
export interface ApprovalApprovedPayload {
  readonly instanceId: EntityId;
  readonly approvalKey: string;
  readonly decidedBy: EntityId | null;
  readonly decidedAt: Timestamp;
  readonly decisionNote: string | null;
  readonly requiredCapability: string;
  readonly policyRef: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.approvalRejected`. */
export interface ApprovalRejectedPayload {
  readonly instanceId: EntityId;
  readonly approvalKey: string;
  readonly decidedBy: EntityId | null;
  readonly decidedAt: Timestamp;
  readonly rejectionReason: string;
  readonly requiredCapability: string;
  readonly policyRef: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/**
 * Audit payload of `workflows.approvalDenied` (AUDIT-ONLY — the aggregate is
 * unchanged; before/after reference the same instance at the same version).
 */
export interface ApprovalDeniedPayload {
  readonly instanceId: EntityId;
  readonly approvalKey: string;
  /** The decision that was attempted ('approve' | 'reject'). */
  readonly attemptedDecision: string;
  /** THE capability the approval requires (the gate that denied). */
  readonly requiredCapability: string;
  readonly policyRef: string;
  /** Why the attempt was denied: 'missing-required-capability' or 'policy-denied'. */
  readonly denialCode: string;
  readonly denialMessage: string;
  /** The aggregate version at denial time — unchanged by the denial. */
  readonly version: number;
}

/** Audit payload of `workflows.instanceCompleted`. */
export interface InstanceCompletedPayload {
  readonly instanceId: EntityId;
  readonly definitionId: EntityId;
  readonly currentState: string;
  readonly completedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `workflows.instanceFailed`. */
export interface InstanceFailedPayload {
  readonly instanceId: EntityId;
  readonly definitionId: EntityId;
  readonly currentState: string;
  readonly failedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** The union of every workflow audit payload. */
export type WorkflowAuditPayload =
  | DefinitionCreatedPayload
  | DefinitionUpdatedPayload
  | DefinitionPublishedPayload
  | InstanceStartedPayload
  | TransitionExecutedPayload
  | TaskAssignedPayload
  | TaskStartedPayload
  | TaskCompletedPayload
  | TaskSkippedPayload
  | TaskFailedPayload
  | TaskRetriedPayload
  | TaskEscalatedPayload
  | ApprovalSubmittedPayload
  | ApprovalApprovedPayload
  | ApprovalRejectedPayload
  | ApprovalDeniedPayload
  | InstanceCompletedPayload
  | InstanceFailedPayload;

// ----- envelope builder ----------------------------------------------------------------

/**
 * Derive the event causality from the command envelope (the OFF-005 ledger
 * convention, identical to the landed domain modules): the correlation id of
 * the causal chain is carried over; the causation id of the resulting event is
 * the COMMAND's idempotency key — the id of the message that caused this
 * mutation. Trusted path: the envelope was already validated (the
 * idempotency-key grammar is exactly the causation-id grammar), so a parse
 * failure here is a loud TypeError, never a silent drop.
 */
const causalityOf = (command: CommandEnvelope<unknown>): Causality => {
  const causationId = parseCausationId(command.idempotencyKey);
  if (!causationId.ok) {
    throw new TypeError(
      `command idempotency key is not a valid causation id: ${command.idempotencyKey}`,
    );
  }
  return {
    correlationId: command.causality.correlationId,
    causationId: causationId.value,
  };
};

/**
 * Build one workflow audit event envelope (trusted path; self-checked
 * through the contracts parser so an emitted event can never be invalid):
 * source is 'domain' by definition, scope is the aggregate's owning project
 * scope, actor and causal chain come from the command, occurredAt from the
 * injected clock, and entityRefs carry before/after per the transition kind
 * (creation events carry before = null).
 */
export function workflowEventEnvelope(parts: {
  readonly command: CommandEnvelope<unknown>;
  readonly eventName: EventName;
  readonly scope: Scope;
  readonly occurredAt: Timestamp;
  readonly entityRefs: EntityRefs;
  readonly payload: WorkflowAuditPayload;
}): DomainEventEnvelope<WorkflowAuditPayload> {
  const envelope = {
    kind: 'event',
    eventName: parts.eventName,
    scope: parts.scope,
    actor: parts.command.actor,
    source: 'domain',
    causality: causalityOf(parts.command),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: parts.occurredAt,
    entityRefs: parts.entityRefs,
    payload: parts.payload,
  } as const satisfies DomainEventEnvelope;
  const checked = parseDomainEventEnvelope(envelope);
  if (!checked.ok) {
    throw new TypeError(
      `workflow event envelope failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<WorkflowAuditPayload>;
}

/** Entity reference of an aggregate state (before/after refs, A3). */
export const workflowEntityRef = (
  entityKind: EntityKind,
  entityId: EntityId,
): EntityRef => ({ entityKind, entityId });

/** The before/after refs of a creation transition (before = null, A3). */
export const createdRefs = (
  state: WorkflowDefinitionState | WorkflowInstanceState,
): EntityRefs => ({
  before: null,
  after: workflowEntityRef(state.entityKind, state.entityId),
});

/** The before/after refs of an update transition (same entity, changed payload). */
export const updatedRefs = (
  before: WorkflowDefinitionState | WorkflowInstanceState,
  after: WorkflowDefinitionState | WorkflowInstanceState,
): EntityRefs => ({
  before: workflowEntityRef(before.entityKind, before.entityId),
  after: workflowEntityRef(after.entityKind, after.entityId),
});

/**
 * The before/after refs of an AUDIT-ONLY event (same unchanged aggregate on
 * both sides — e.g. the approval-denied denial record).
 */
export const unchangedRefs = (state: WorkflowInstanceState): EntityRefs => ({
  before: workflowEntityRef(state.entityKind, state.entityId),
  after: workflowEntityRef(state.entityKind, state.entityId),
});

// ----- payload builders (package-internal convenience over the pure results) ----------

/** Build the audit payloads of one executed machine transition (in order). */
export const transitionPayloadsOf = (
  result: WorkflowTransitionResult,
  before: WorkflowInstanceState,
): readonly WorkflowAuditPayload[] => {
  const { state, transition, skippedTasks } = result;
  const payloads: WorkflowAuditPayload[] = [
    {
      instanceId: state.entityId,
      definitionId: state.definitionId,
      transitionKey: transition.key,
      from: before.currentState,
      to: state.currentState,
      requiredCapabilities: transition.requiredCapabilities as readonly string[],
      skippedTaskKeys: skippedTasks.map((task) => task.key),
      status: state.status,
      version: state.version,
      updatedAt: state.updatedAt,
    },
  ];
  // Task-skipped payloads are read off the COMMITTED tasks (the skippedTasks
  // snapshots predate the transition — their outcome/skipReason/skippedAt are
  // still null — so the audit trail would otherwise lose the deterministic
  // 'workflow-left-state-<state>' reason the machine records).
  for (const skipped of skippedTasks) {
    const committed = state.tasks.find((task) => task.key === skipped.key) ?? skipped;
    payloads.push({
      instanceId: state.entityId,
      taskKey: committed.key,
      outcome: committed.outcome ?? 'skipped',
      reason: committed.skipReason ?? '',
      skippedAt: committed.skippedAt ?? state.updatedAt,
      version: state.version,
      updatedAt: state.updatedAt,
    });
  }
  if (state.status === 'completed') {
    payloads.push({
      instanceId: state.entityId,
      definitionId: state.definitionId,
      currentState: state.currentState,
      completedAt: state.completedAt ?? state.updatedAt,
      version: state.version,
      updatedAt: state.updatedAt,
    });
  }
  if (state.status === 'failed') {
    payloads.push({
      instanceId: state.entityId,
      definitionId: state.definitionId,
      currentState: state.currentState,
      failedAt: state.failedAt ?? state.updatedAt,
      version: state.version,
      updatedAt: state.updatedAt,
    });
  }
  return payloads;
};

/** The event names matching {@link transitionPayloadsOf} (in order). */
export const transitionEventNamesOf = (
  result: WorkflowTransitionResult,
): readonly EventName[] => {
  const names: EventName[] = [TRANSITION_EXECUTED_EVENT];
  for (const task of result.skippedTasks) {
    void task;
    names.push(TASK_SKIPPED_EVENT);
  }
  if (result.state.status === 'completed') names.push(INSTANCE_COMPLETED_EVENT);
  if (result.state.status === 'failed') names.push(INSTANCE_FAILED_EVENT);
  return names;
};

/** The audit payload of one escalated task record. */
export const escalationPayloadOf = (
  instance: WorkflowInstanceState,
  record: EscalatedTaskRecord,
): TaskEscalatedPayload => ({
  instanceId: instance.entityId,
  taskKey: record.key,
  from: record.from,
  to: record.to,
  dueAt: record.dueAt,
  escalatedAt: instance.updatedAt,
  version: instance.version,
  updatedAt: instance.updatedAt,
});

/** The audit payload of a task-level event, read off the committed task. */
export const taskPayloadOf = (
  instance: WorkflowInstanceState,
  task: TaskState,
  options: { readonly maxAttempts: number },
):
  | TaskAssignedPayload
  | TaskStartedPayload
  | TaskCompletedPayload
  | TaskSkippedPayload
  | TaskFailedPayload
  | TaskRetriedPayload => {
  switch (task.status) {
    case 'created':
      throw new TypeError('a created task emits no audit payload');
    case 'assigned': {
      const slaMinutes =
        task.dueAt !== null && task.assignedAt !== null
          ? Math.round(
              (timestampEpochMs(task.dueAt) - timestampEpochMs(task.assignedAt)) / 60_000,
            )
          : null;
      return {
        instanceId: instance.entityId,
        taskKey: task.key,
        assignee: task.assignee,
        assignedAt: task.assignedAt ?? instance.updatedAt,
        dueAt: task.dueAt,
        slaMinutes,
        status: task.status,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
    }
    case 'in-progress':
      return {
        instanceId: instance.entityId,
        taskKey: task.key,
        assignee: task.assignee,
        attempts: task.attempts,
        status: task.status,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
    case 'completed':
      return {
        instanceId: instance.entityId,
        taskKey: task.key,
        outcome: task.outcome ?? 'completed',
        completedAt: task.completedAt ?? instance.updatedAt,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
    case 'skipped':
      return {
        instanceId: instance.entityId,
        taskKey: task.key,
        outcome: task.outcome ?? 'skipped',
        reason: task.skipReason ?? '',
        skippedAt: task.skippedAt ?? instance.updatedAt,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
    case 'failed':
      return {
        instanceId: instance.entityId,
        taskKey: task.key,
        outcome: task.outcome ?? 'failed',
        reason: task.failureReason ?? '',
        failedAt: task.failedAt ?? instance.updatedAt,
        retryNotBefore: task.retryNotBefore,
        attempts: task.attempts,
        maxAttempts: options.maxAttempts,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
  }
};

/** The audit payload of an approval-level event, read off the committed approval. */
export const approvalPayloadOf = (
  instance: WorkflowInstanceState,
  approval: ApprovalState,
): ApprovalSubmittedPayload | ApprovalApprovedPayload | ApprovalRejectedPayload => {
  switch (approval.status) {
    case 'submitted':
      return {
        instanceId: instance.entityId,
        approvalKey: approval.key,
        submittedBy: approval.submittedBy,
        submittedAt: approval.submittedAt ?? instance.updatedAt,
        status: approval.status,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
    case 'approved':
      return {
        instanceId: instance.entityId,
        approvalKey: approval.key,
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt ?? instance.updatedAt,
        decisionNote: approval.decisionNote,
        requiredCapability: approval.requiredCapability,
        policyRef: approval.policyRef,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
    case 'rejected':
      return {
        instanceId: instance.entityId,
        approvalKey: approval.key,
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt ?? instance.updatedAt,
        rejectionReason: approval.decisionNote ?? '',
        requiredCapability: approval.requiredCapability,
        policyRef: approval.policyRef,
        version: instance.version,
        updatedAt: instance.updatedAt,
      };
    case 'pending':
      throw new TypeError('a pending approval emits no audit payload');
  }
};

// ----- THE EventSink port (mirrors the landed domain modules byte-for-byte) ------------

/**
 * THE EventSink port (minimal, by design): append audit events using the
 * caller's open transaction executor, so a real implementation writes them
 * atomically with the mutation that produced them. The in-memory sink below
 * records instead of writing; the OFF-005 ledger (via this package's
 * ledger-backed adapter or the runtime's own wiring) implements this port.
 */
export interface EventSink {
  /**
   * Append `events` inside the transaction of `executor`. A failure result
   * MUST abort the surrounding mutation (handlers roll the mutation back),
   * so a partially-applied mutation can never commit.
   */
  appendEvents(
    executor: SqlExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedEventAppend {
  /** The executor the sink was handed (the open transaction in handlers). */
  readonly executor: SqlExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory EventSink: records appends instead of writing (tests). */
export interface InMemoryEventSink extends EventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedEventAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory EventSink for deterministic tests. */
export function createInMemoryEventSink(): InMemoryEventSink {
  const appends: RecordedEventAppend[] = [];
  return {
    appends,
    get events(): readonly DomainEventEnvelope[] {
      return appends.flatMap((append) => append.events);
    },
    appendEvents: async (executor, events) => {
      appends.push({ executor, events: [...events] });
      return ok(true);
    },
  };
}

/** Build a typed sink failure (for tests and wiring guards). */
export const eventSinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `event sink rejected the append: ${reason}`,
    [{ code: 'event-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingEventSink = (reason: string): EventSink => ({
  appendEvents: async () => fail(eventSinkFailure(reason)),
});
