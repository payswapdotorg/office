import { describe, expect, it } from 'vitest';
import {
  parseCommandEnvelope,
  parseDomainEventEnvelope,
  parseEntityKind,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, EntityId, EntityRef, Timestamp } from '@office/contracts';
import { capability } from '@office/authz';
import {
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
  createInMemoryEventSink,
  createdRefs,
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
  approvalPayloadOf,
} from './events';
import type { TaskAssignedPayload } from './events';
import {
  WORKFLOW_DEFINITION_KIND,
  WORKFLOW_INSTANCE_KIND,
  assignWorkflowTaskState,
  createWorkflowDefinitionState,
  createWorkflowInstanceState,
  decideWorkflowApprovalState,
  failWorkflowTaskState,
  publishWorkflowDefinitionState,
  startWorkflowTaskState,
  submitWorkflowApprovalState,
  completeWorkflowTaskState,
  transitionWorkflowInstanceState,
  escalateWorkflowInstanceState,
} from './state';
import type { WorkflowInstanceState } from './state';
import { CHANGE_ORDER_MODEL, PROJECT_1, TENANT_A, expectOk, projectScopeOf, unwrap } from './test-support';
import type { TaskState, ApprovalState } from './state';

// OFF-016 workflow engine — the audit event vocabulary, the envelope builder
// (self-checked through the contracts parser), the payload builders derived
// from the pure transition results, and the EventSink port implementations
// (in-memory recorder + failing sink). Deterministic: fixed envelopes,
// injected timestamps, no I/O.

const DEFINITION_ID = 'office-ent-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9' as EntityId;
const INSTANCE_ID = 'office-ent-v1-2a2b3c4d5e6f708192a3b4c5d6e7f8a9' as EntityId;
const ASSIGNEE = 'office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4' as EntityId;
const SUPERVISOR = 'office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3' as EntityId;
const ACTOR_ID = 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1' as EntityId;
const SCOPE = projectScopeOf(PROJECT_1, TENANT_A);
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const subject: EntityRef = {
  entityKind: unwrap(parseEntityKind('change-order')),
  entityId: 'office-ent-v1-f60718293a4b5c6d7e8f9a1b2c3d4e5' as EntityId,
};

const command: CommandEnvelope = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'workflows.assignTask',
    scope: SCOPE,
    actor: { kind: 'user', actorId: ACTOR_ID },
    idempotencyKey: 'idem-4f9d2c81a7e3',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: {},
  }),
);

const definition = expectOk(publishWorkflowDefinitionState(
  expectOk(createWorkflowDefinitionState(
    {
      definitionId: DEFINITION_ID,
      key: 'change-order-approval',
      definitionVersion: 1,
      title: 'Change order approval',
      model: CHANGE_ORDER_MODEL,
      now: NOW,
    },
    SCOPE,
  )),
  NOW,
));

const instance = (): WorkflowInstanceState =>
  expectOk(createWorkflowInstanceState(
    definition,
    { instanceId: INSTANCE_ID, subject, now: NOW },
    SCOPE,
  ));

const inReview = (): WorkflowInstanceState =>
  expectOk(transitionWorkflowInstanceState(CHANGE_ORDER_MODEL, instance(), 'submit-for-review', [], NOW)).state;

/** Fixture guard: the committed task of a fixture instance (fails loud). */
const taskOf = (state: WorkflowInstanceState, key: string): TaskState => {
  const task = state.tasks.find((t) => t.key === key);
  if (task === undefined) throw new Error(`task '${key}' not found on fixture instance`);
  return task;
};

/** Fixture guard: the committed approval of a fixture instance (fails loud). */
const approvalOf = (state: WorkflowInstanceState, key: string): ApprovalState => {
  const approval = state.approvals.find((a) => a.key === key);
  if (approval === undefined) throw new Error(`approval '${key}' not found on fixture instance`);
  return approval;
};

/** The canonical task-assigned audit payload (shared fixture). */
const taskAssignedPayload: TaskAssignedPayload = {
  instanceId: INSTANCE_ID,
  taskKey: 'verify-docs',
  assignee: ASSIGNEE,
  assignedAt: NOW,
  dueAt: null,
  slaMinutes: null,
  status: 'assigned',
  version: 2,
  updatedAt: NOW,
};

// ----- the event name vocabulary ---------------------------------------------------------

describe('workflow audit event vocabulary', () => {
  it('declares the eighteen workflow event names, distinct and correctly namespaced', () => {
    expect(WORKFLOW_EVENT_NAMES).toHaveLength(18);
    expect(new Set(WORKFLOW_EVENT_NAMES).size).toBe(18);
    for (const name of WORKFLOW_EVENT_NAMES) {
      expect(name.startsWith('workflows.')).toBe(true);
    }
  });

  it('carries the canonical names of every emission group', () => {
    expect(DEFINITION_CREATED_EVENT).toBe('workflows.definitionCreated');
    expect(DEFINITION_UPDATED_EVENT).toBe('workflows.definitionUpdated');
    expect(DEFINITION_PUBLISHED_EVENT).toBe('workflows.definitionPublished');
    expect(INSTANCE_STARTED_EVENT).toBe('workflows.instanceStarted');
    expect(TRANSITION_EXECUTED_EVENT).toBe('workflows.transitionExecuted');
    expect(TASK_ASSIGNED_EVENT).toBe('workflows.taskAssigned');
    expect(TASK_STARTED_EVENT).toBe('workflows.taskStarted');
    expect(TASK_COMPLETED_EVENT).toBe('workflows.taskCompleted');
    expect(TASK_SKIPPED_EVENT).toBe('workflows.taskSkipped');
    expect(TASK_FAILED_EVENT).toBe('workflows.taskFailed');
    expect(TASK_RETRIED_EVENT).toBe('workflows.taskRetried');
    expect(TASK_ESCALATED_EVENT).toBe('workflows.taskEscalated');
    expect(APPROVAL_SUBMITTED_EVENT).toBe('workflows.approvalSubmitted');
    expect(APPROVAL_APPROVED_EVENT).toBe('workflows.approvalApproved');
    expect(APPROVAL_REJECTED_EVENT).toBe('workflows.approvalRejected');
    expect(APPROVAL_DENIED_EVENT).toBe('workflows.approvalDenied');
    expect(INSTANCE_COMPLETED_EVENT).toBe('workflows.instanceCompleted');
    expect(INSTANCE_FAILED_EVENT).toBe('workflows.instanceFailed');
  });
});

// ----- entity reference helpers ----------------------------------------------------------

describe('entity reference helpers (A3 before/after refs)', () => {
  it('createdRefs carries before = null and after = the created aggregate', () => {
    expect(createdRefs(instance())).toStrictEqual({
      before: null,
      after: { entityKind: WORKFLOW_INSTANCE_KIND, entityId: INSTANCE_ID },
    });
  });

  it('updatedRefs carries the same entity on both sides', () => {
    const before = instance();
    const after = expectOk(transitionWorkflowInstanceState(CHANGE_ORDER_MODEL, before, 'submit-for-review', [], NOW)).state;
    expect(updatedRefs(before, after)).toStrictEqual({
      before: { entityKind: WORKFLOW_INSTANCE_KIND, entityId: INSTANCE_ID },
      after: { entityKind: WORKFLOW_INSTANCE_KIND, entityId: INSTANCE_ID },
    });
  });

  it('unchangedRefs carries the SAME unchanged aggregate on both sides (audit-only events)', () => {
    expect(unchangedRefs(instance())).toStrictEqual({
      before: { entityKind: WORKFLOW_INSTANCE_KIND, entityId: INSTANCE_ID },
      after: { entityKind: WORKFLOW_INSTANCE_KIND, entityId: INSTANCE_ID },
    });
  });

  it('workflowEntityRef addresses an aggregate by kind and id', () => {
    expect(workflowEntityRef(WORKFLOW_DEFINITION_KIND, DEFINITION_ID)).toStrictEqual({
      entityKind: WORKFLOW_DEFINITION_KIND,
      entityId: DEFINITION_ID,
    });
  });
});

// ----- the envelope builder ----------------------------------------------------------------

describe('workflowEventEnvelope (self-checked through the contracts parser)', () => {
  const envelope = workflowEventEnvelope({
    command,
    eventName: TASK_ASSIGNED_EVENT,
    scope: SCOPE,
    occurredAt: NOW,
    entityRefs: createdRefs(instance()),
    payload: taskAssignedPayload,
  });

  it('builds a contract-valid event envelope (round-trips through parseDomainEventEnvelope)', () => {
    const checked = parseDomainEventEnvelope(envelope);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value).toStrictEqual(envelope);
  });

  it('derives causality from the command: the command idempotency key is the causation id', () => {
    expect(envelope.causality.causationId).toBe(command.idempotencyKey);
    expect(envelope.causality.correlationId).toBe(command.causality.correlationId);
  });

  it('carries the actor, the domain source, the schema version, and the occurred-at', () => {
    expect(envelope.actor).toStrictEqual(command.actor);
    expect(envelope.source).toBe('domain');
    expect(envelope.schemaVersion).toBe(command.schemaVersion);
    expect(envelope.occurredAt).toBe(NOW);
    expect(envelope.eventName).toBe(TASK_ASSIGNED_EVENT);
    expect(envelope.scope).toStrictEqual(SCOPE);
  });

  it('is deterministic: same inputs → the identical envelope', () => {
    const again = workflowEventEnvelope({
      command,
      eventName: TASK_ASSIGNED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: createdRefs(instance()),
      payload: taskAssignedPayload,
    });
    expect(again).toStrictEqual(envelope);
  });

  it('throws loudly when handed an invalid event name (never a silent drop)', () => {
    expect(() =>
      workflowEventEnvelope({
        command,
        eventName: 'not-a-workflow-event' as never,
        scope: SCOPE,
        occurredAt: NOW,
        entityRefs: createdRefs(instance()),
        payload: taskAssignedPayload,
      }),
    ).toThrow(TypeError);
  });
});

// ----- payload builders ----------------------------------------------------------------------

describe('transitionPayloadsOf / transitionEventNamesOf (aligned audit groups)', () => {
  const prepared = (): WorkflowInstanceState => {
    let state = inReview();
    state = expectOk(completeWorkflowTaskState(
      expectOk(startWorkflowTaskState(
        expectOk(assignWorkflowTaskState(state, 'verify-docs', ASSIGNEE, 60, NOW)),
        'verify-docs',
        NOW,
      )),
      'verify-docs',
      NOW,
    ));
    return expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(state, 'manager', null, NOW)),
      'manager',
      'approved',
      null,
      null,
      NOW,
    ));
  };

  it('a completing transition emits transition-executed, task-skipped per settled task, instance-completed', () => {
    const before = prepared();
    const result = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      before,
      'approve-change',
      [],
      NOW,
    ));
    const names = transitionEventNamesOf(result);
    const payloads = transitionPayloadsOf(result, before);
    expect(names).toStrictEqual([
      TRANSITION_EXECUTED_EVENT,
      TASK_SKIPPED_EVENT, // notify-parties was still open in 'review'
      INSTANCE_COMPLETED_EVENT,
    ]);
    expect(payloads).toHaveLength(names.length);
    const transitionPayload = payloads[0];
    expect(transitionPayload).toMatchObject({
      instanceId: INSTANCE_ID,
      transitionKey: 'approve-change',
      from: 'review',
      to: 'approved',
    });
    const skippedPayload = payloads[1];
    expect(skippedPayload).toMatchObject({
      taskKey: 'notify-parties',
      outcome: 'skipped',
      reason: 'workflow-left-state-review',
    });
    const completedPayload = payloads[2];
    expect(completedPayload).toMatchObject({
      instanceId: INSTANCE_ID,
      currentState: 'approved',
    });
  });

  it('a plain transition emits only transition-executed', () => {
    const result = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      instance(),
      'submit-for-review',
      [],
      NOW,
    ));
    expect(transitionEventNamesOf(result)).toStrictEqual([TRANSITION_EXECUTED_EVENT]);
    expect(transitionPayloadsOf(result, instance())).toHaveLength(1);
  });

  it('a failing transition emits transition-executed, task-skipped per settled task, instance-failed', () => {
    const decided = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview(), 'manager', null, NOW)),
      'manager',
      'rejected',
      null,
      'terms',
      NOW,
    ));
    const result = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      decided,
      'reject-change',
      [capability('contracts.write')],
      NOW,
    ));
    // Both review tasks were still open (created) → settled as skipped.
    expect(transitionEventNamesOf(result)).toStrictEqual([
      TRANSITION_EXECUTED_EVENT,
      TASK_SKIPPED_EVENT,
      TASK_SKIPPED_EVENT,
      INSTANCE_FAILED_EVENT,
    ]);
    expect(transitionPayloadsOf(result, decided)).toHaveLength(4);
  });
});

describe('taskPayloadOf (task-level audit payloads)', () => {
  it('assigned: derives the SLA window from the committed timestamps', () => {
    const assigned = expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, NOW));
    const payload = taskPayloadOf(assigned, taskOf(assigned, 'verify-docs'), { maxAttempts: 2 });
    expect(payload).toStrictEqual({
      instanceId: INSTANCE_ID,
      taskKey: 'verify-docs',
      assignee: ASSIGNEE,
      assignedAt: NOW,
      dueAt: '2026-09-12T11:15:31.000Z',
      slaMinutes: 60,
      status: 'assigned',
      version: assigned.version,
      updatedAt: NOW,
    });
  });

  it('in-progress: carries the attempt count', () => {
    const started = expectOk(startWorkflowTaskState(
      expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, NOW)),
      'verify-docs',
      NOW,
    ));
    const payload = taskPayloadOf(started, taskOf(started, 'verify-docs'), { maxAttempts: 2 });
    expect(payload).toMatchObject({ taskKey: 'verify-docs', attempts: 1, status: 'in-progress' });
  });

  it('completed: carries the terminal outcome and timestamp', () => {
    const completed = expectOk(completeWorkflowTaskState(
      expectOk(startWorkflowTaskState(
        expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, NOW)),
        'verify-docs',
        NOW,
      )),
      'verify-docs',
      NOW,
    ));
    const payload = taskPayloadOf(completed, taskOf(completed, 'verify-docs'), { maxAttempts: 2 });
    expect(payload).toMatchObject({ taskKey: 'verify-docs', outcome: 'completed', completedAt: NOW });
  });

  it('failed: carries the reason, the backoff gate, and the bounded policy', () => {
    const failed = expectOk(failWorkflowTaskState(
      expectOk(startWorkflowTaskState(
        expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, NOW)),
        'verify-docs',
        NOW,
      )),
      'verify-docs',
      'adapter timeout',
      CHANGE_ORDER_MODEL.retryPolicy,
      NOW,
    ));
    const payload = taskPayloadOf(failed, taskOf(failed, 'verify-docs'), { maxAttempts: 2 });
    expect(payload).toMatchObject({
      taskKey: 'verify-docs',
      outcome: 'failed',
      reason: 'adapter timeout',
      retryNotBefore: '2026-09-12T10:16:31.000Z',
      attempts: 1,
      maxAttempts: 2,
    });
  });

  it("a 'created' task emits no audit payload (loud)", () => {
    const fresh = instance();
    expect(() => taskPayloadOf(fresh, taskOf(fresh, 'verify-docs'), { maxAttempts: 2 })).toThrow(TypeError);
  });
});

describe('approvalPayloadOf (approval-level audit payloads)', () => {
  it('submitted: carries the submitter', () => {
    const submitted = expectOk(submitWorkflowApprovalState(inReview(), 'manager', ASSIGNEE, NOW));
    const payload = approvalPayloadOf(submitted, approvalOf(submitted, 'manager'));
    expect(payload).toMatchObject({
      approvalKey: 'manager',
      submittedBy: ASSIGNEE,
      submittedAt: NOW,
      status: 'submitted',
    });
  });

  it('approved: carries the decision plus THE required capability and policy reference', () => {
    const approved = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview(), 'manager', null, NOW)),
      'manager',
      'approved',
      ACTOR_ID,
      'documents verified',
      NOW,
    ));
    const payload = approvalPayloadOf(approved, approvalOf(approved, 'manager'));
    expect(payload).toMatchObject({
      approvalKey: 'manager',
      decidedBy: ACTOR_ID,
      decisionNote: 'documents verified',
      requiredCapability: 'cost.write',
      policyRef: 'policy/change-orders@3',
    });
  });

  it('rejected: carries the rejection reason', () => {
    const rejected = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview(), 'manager', null, NOW)),
      'manager',
      'rejected',
      ACTOR_ID,
      'commercial terms',
      NOW,
    ));
    const payload = approvalPayloadOf(rejected, approvalOf(rejected, 'manager'));
    expect(payload).toMatchObject({
      approvalKey: 'manager',
      rejectionReason: 'commercial terms',
      requiredCapability: 'cost.write',
    });
  });

  it("a 'pending' approval emits no audit payload (loud)", () => {
    const fresh = instance();
    expect(() => approvalPayloadOf(fresh, approvalOf(fresh, 'manager'))).toThrow(TypeError);
  });
});

describe('escalationPayloadOf (SLA escalation audit payload)', () => {
  it('carries the reassignment (from → to) and the breached deadline', () => {
    const assigned = expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, NOW));
    const dueAt = taskOf(assigned, 'verify-docs').dueAt ?? NOW;
    const result = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, assigned, dueAt));
    const record = result.escalatedTasks[0];
    expect(record).toBeDefined();
    if (record) {
      const payload = escalationPayloadOf(result.state, record);
      expect(payload).toStrictEqual({
        instanceId: INSTANCE_ID,
        taskKey: 'verify-docs',
        from: ASSIGNEE,
        to: SUPERVISOR,
        dueAt,
        escalatedAt: result.state.updatedAt,
        version: result.state.version,
        updatedAt: result.state.updatedAt,
      });
    }
  });
});

// ----- the EventSink port implementations -----------------------------------------------

describe('createInMemoryEventSink (the deterministic recorder)', () => {
  it('records every append in order and flattens the events', async () => {
    const sink = createInMemoryEventSink();
    const first = workflowEventEnvelope({
      command,
      eventName: INSTANCE_STARTED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: createdRefs(instance()),
      payload: {
        instanceId: INSTANCE_ID,
        definitionId: DEFINITION_ID,
        definitionKey: 'change-order-approval',
        definitionVersion: 1,
        subject,
        currentState: 'draft',
        status: 'running',
        taskCount: 2,
        approvalCount: 1,
        version: 1,
        startedAt: NOW,
      },
    });
    const second = workflowEventEnvelope({
      command,
      eventName: DEFINITION_PUBLISHED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: updatedRefs(definition, definition),
      payload: {
        definitionId: DEFINITION_ID,
        key: 'change-order-approval',
        definitionVersion: 1,
        publishedAt: NOW,
        version: definition.version,
        updatedAt: NOW,
      },
    });
    const appendedFirst = await sink.appendEvents(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      [first],
    );
    const appendedSecond = await sink.appendEvents(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      [second, first],
    );
    expect(appendedFirst).toStrictEqual({ ok: true, value: true });
    expect(appendedSecond).toStrictEqual({ ok: true, value: true });
    expect(sink.appends).toHaveLength(2);
    expect(sink.events).toHaveLength(3);
    expect(sink.events[0]).toStrictEqual(first);
    expect(sink.events[1]).toStrictEqual(second);
  });

  it('an empty batch records an empty append', async () => {
    const sink = createInMemoryEventSink();
    const appended = await sink.appendEvents(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      [],
    );
    expect(appended.ok).toBe(true);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.events).toStrictEqual([]);
    expect(sink.events).toStrictEqual([]);
  });
});

describe('failingEventSink / eventSinkFailure (typed sink failures)', () => {
  it('always fails with the typed invariant-violation', async () => {
    const sink = failingEventSink('ledger unavailable');
    const result = await sink.appendEvents(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
      expect(result.error.message).toContain('ledger unavailable');
    }
  });

  it('eventSinkFailure builds the typed domain failure', () => {
    const error = eventSinkFailure('outbox full');
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('event-sink-rejected');
  });
});
