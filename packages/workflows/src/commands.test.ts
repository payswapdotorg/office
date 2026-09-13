import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '@office/contracts';
import type { EntityId, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import { createInMemoryIdempotencyRegistry, fail, ok } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import {
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
import type { WorkflowCommandAuthorization, WorkflowCommandDeps } from './commands';
import { createInMemoryEventSink, eventSinkFailure, timestampEpochMs } from './index';
import type { EventSink } from './index';
import { createInMemoryWorkflowStore } from './store';
import {
  ASSIGNEE,
  CHANGE_ORDER_MODEL_RAW,
  CORRELATION_ID,
  MANAGER,
  PROJECT_1,
  PROJECT_2,
  SIMPLE_MODEL_RAW,
  SUBJECT_ID,
  SUPERVISOR,
  TENANT_A,
  TENANT_B,
  USER,
  envelope,
  expectOk,
  explicitDenyGrant,
  makeHarness,
  managerGrant,
  nextKey,
  noAllowRuleGrant,
  noGrant,
  operatorGrant,
  projectScopeOf,
  unwrap,
} from './test-support';
import type { Harness } from './test-support';

// OFF-016 workflow engine — the command layer: fail-closed payload parsing,
// THE capability-gated approval seam (no bypass path, audited denials, not
// even through idempotency), A12 tenant/project isolation (denied commands
// never mutate), optimistic concurrency, idempotent replays, bounded retry
// exhaustion, SLA escalation against the injected clock, and end-to-end
// determinism of the committed states and audit events.

const FAKE_EXECUTOR: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };
const TENANT_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_A };
const B_SCOPE = projectScopeOf(PROJECT_1, TENANT_B);
const OTHER_PROJECT_SCOPE = projectScopeOf(PROJECT_2, TENANT_A);

/** Holds workflows.write AND contracts.write (the reject-change gate). */
const contractsWriter: WorkflowCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['workflows.write'], actions: ['write'] }]),
  capabilities: ['workflows.write', 'contracts.write'],
};

const subjectRef = { entityKind: 'change-order', entityId: SUBJECT_ID };

/** The v2 model of the change-order workflow (escalation retargeted). */
const CHANGE_ORDER_MODEL_V2_RAW = {
  ...CHANGE_ORDER_MODEL_RAW,
  escalationRules: [{ task: 'verify-docs', reassignTo: MANAGER }],
};

// ----- command payload parsing (fail-closed) --------------------------------------------

describe('command payload parsing (fail-closed)', () => {
  it('parses a valid create-definition payload', () => {
    const result = parseCreateDefinitionPayload({
      key: 'change-order-approval',
      title: 'Change order approval',
      model: CHANGE_ORDER_MODEL_RAW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.key).toBe('change-order-approval');
  });

  it('rejects a create-definition payload with an unknown key (strict keys)', () => {
    const result = parseCreateDefinitionPayload({
      key: 'change-order-approval',
      title: 'T',
      model: CHANGE_ORDER_MODEL_RAW,
      owner: USER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects a create-definition payload with a malformed model', () => {
    const result = parseCreateDefinitionPayload({
      key: 'change-order-approval',
      title: 'T',
      model: { ...CHANGE_ORDER_MODEL_RAW, states: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('parses update/publish definition payloads and rejects a non-integer version', () => {
    const update = parseUpdateDefinitionPayload({
      definitionId: SUBJECT_ID,
      expectedVersion: 1,
      model: SIMPLE_MODEL_RAW,
    });
    expect(update.ok).toBe(true);
    const publish = parsePublishDefinitionPayload({ definitionId: SUBJECT_ID, expectedVersion: 2 });
    expect(publish.ok).toBe(true);
    const bad = parsePublishDefinitionPayload({ definitionId: SUBJECT_ID, expectedVersion: 1.5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid-value');
  });

  it('parses a start-instance payload with a typed subject reference', () => {
    const result = parseStartInstancePayload({
      definitionId: SUBJECT_ID,
      subject: subjectRef,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.subject).toStrictEqual(subjectRef);
  });

  it('rejects a start-instance payload with a malformed subject', () => {
    const result = parseStartInstancePayload({ definitionId: SUBJECT_ID, subject: { entityKind: 'x' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });

  it('parses execute-transition / assign / task / reason / approval / escalate payloads', () => {
    expect(
      parseExecuteTransitionPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, transitionKey: 'go' }).ok,
    ).toBe(true);
    expect(
      parseAssignTaskPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, taskKey: 'work', assignee: ASSIGNEE }).ok,
    ).toBe(true);
    expect(
      parseTaskCommandPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, taskKey: 'work' }).ok,
    ).toBe(true);
    expect(
      parseTaskReasonPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, taskKey: 'work', reason: 'blocked' }).ok,
    ).toBe(true);
    expect(
      parseSubmitApprovalPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, approvalKey: 'manager' }).ok,
    ).toBe(true);
    expect(
      parseApproveApprovalPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, approvalKey: 'manager', note: 'ok' }).ok,
    ).toBe(true);
    expect(
      parseRejectApprovalPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, approvalKey: 'manager', reason: 'no' }).ok,
    ).toBe(true);
    expect(
      parseEscalateInstancePayload({ instanceId: SUBJECT_ID, expectedVersion: 3 }).ok,
    ).toBe(true);
  });

  it('rejects a non-kebab task key and a non-object root (strict, fail-closed)', () => {
    expect(parseTaskCommandPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, taskKey: 'Task Key' }).ok).toBe(false);
    expect(parseTaskReasonPayload('nope').ok).toBe(false);
    expect(parseApproveApprovalPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, approvalKey: 'manager', note: '' }).ok).toBe(false);
    expect(parseRejectApprovalPayload({ instanceId: SUBJECT_ID, expectedVersion: 3, approvalKey: 'manager', reason: '' }).ok).toBe(false);
  });

  it('a non-object payload root is a typed invalid-type', () => {
    for (const parse of [parseCreateDefinitionPayload, parseUpdateDefinitionPayload, parsePublishDefinitionPayload]) {
      const result = parse(42);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-type');
    }
  });
});

// ----- command name guard ------------------------------------------------------------------

describe('command name guard (trusted-path wiring)', () => {
  it('a handler rejects an envelope of another command kind (loud TypeError)', async () => {
    const harness = makeHarness();
    await expect(
      harness.commands.definitions.publishDefinition(
        envelope({}, CREATE_DEFINITION_COMMAND),
        operatorGrant,
      ),
    ).rejects.toThrow(TypeError);
  });
});

// ----- the definition lifecycle (immutability + versioning) --------------------------------

describe('definition commands (draft → publish freeze; a change is a NEW version)', () => {
  it('creates a draft definition row and audits definition-created', async () => {
    const harness = makeHarness();
    const result = await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.replayed).toBe(false);
      expect(result.value.state.status).toBe('draft');
      expect(result.value.state.definitionVersion).toBe(1);
      expect(result.value.state.version).toBe(1);
    }
    expect(harness.sink.events.map((event) => event.eventName)).toStrictEqual([
      'workflows.definitionCreated',
    ]);
  });

  it('updates the model of a draft (full re-validation) and audits definition-updated', async () => {
    const harness = makeHarness();
    const created = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    ));
    const updated = await harness.commands.definitions.updateDefinition(
      envelope(
        { definitionId: created.state.entityId, expectedVersion: 1, model: SIMPLE_MODEL_RAW },
        UPDATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.state.model.states.map((state) => state.name)).toStrictEqual([
        'start',
        'middle',
        'done',
      ]);
      expect(updated.value.state.version).toBe(2);
    }
    expect(harness.sink.events.map((event) => event.eventName)).toStrictEqual([
      'workflows.definitionCreated',
      'workflows.definitionUpdated',
    ]);
  });

  it('publishing freezes the definition: update and re-publish are typed rejections', async () => {
    const harness = makeHarness();
    const created = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    ));
    const definitionId = created.state.entityId;
    const published = expectOk(await harness.commands.definitions.publishDefinition(
      envelope({ definitionId, expectedVersion: 1 }, PUBLISH_DEFINITION_COMMAND),
      operatorGrant,
    ));
    expect(published.state.status).toBe('published');
    expect(published.state.publishedAt).not.toBeNull();

    const eventsBefore = harness.sink.events.length;
    const updated = await harness.commands.definitions.updateDefinition(
      envelope({ definitionId, expectedVersion: 2, model: SIMPLE_MODEL_RAW }, UPDATE_DEFINITION_COMMAND),
      operatorGrant,
    );
    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.error.code).toBe('invariant-violation');
      expect(updated.error.details[0]?.code).toBe('workflow-definition-published-immutable');
    }

    const republished = await harness.commands.definitions.publishDefinition(
      envelope({ definitionId, expectedVersion: 2 }, PUBLISH_DEFINITION_COMMAND),
      operatorGrant,
    );
    expect(republished.ok).toBe(false);
    if (!republished.ok) {
      expect(republished.error.details[0]?.code).toBe('workflow-definition-already-published');
    }
    // Neither rejection mutated anything or emitted anything.
    expect(harness.sink.events.length).toBe(eventsBefore);
    expect(harness.store.definitions()[0]?.version).toBe(2);
  });

  it('a definition change is a NEW version row; instances pin their version and stay unaffected', async () => {
    const harness = makeHarness();
    // v1 published; an instance pins it.
    const v1 = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    ));
    expectOk(await harness.commands.definitions.publishDefinition(
      envelope({ definitionId: v1.state.entityId, expectedVersion: 1 }, PUBLISH_DEFINITION_COMMAND),
      operatorGrant,
    ));
    const instance = expectOk(await harness.commands.instances.startInstance(
      envelope({ definitionId: v1.state.entityId, subject: subjectRef }, START_INSTANCE_COMMAND),
      operatorGrant,
    ));
    expect(instance.state.definitionVersion).toBe(1);
    expect(instance.state.definitionId).toBe(v1.state.entityId);

    // A change: same key, different model → a NEW version row (v2, draft).
    const v2 = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval v2', model: CHANGE_ORDER_MODEL_V2_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    ));
    expect(v2.state.definitionVersion).toBe(2);
    expect(v2.state.entityId).not.toBe(v1.state.entityId);
    expectOk(await harness.commands.definitions.publishDefinition(
      envelope({ definitionId: v2.state.entityId, expectedVersion: 1 }, PUBLISH_DEFINITION_COMMAND),
      operatorGrant,
    ));
    // Both rows exist; v1 stays frozen and untouched.
    expect(harness.store.definitions().map((row) => row.definitionVersion)).toStrictEqual([1, 2]);
    expect(harness.store.definitions()[0]?.model).toStrictEqual(v1.state.model);

    // The OLD instance still executes its PINNED v1: its escalation rule
    // (reassign to SUPERVISOR) applies, not the v2 rule (reassign to MANAGER).
    const instanceId = instance.state.entityId;
    expectOk(await harness.commands.instances.executeTransition(
      envelope({ instanceId, expectedVersion: 1, transitionKey: 'submit-for-review' }, EXECUTE_TRANSITION_COMMAND),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.assignTask(
      envelope({ instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND),
      operatorGrant,
    ));
    // Jump the injected clock past the task's SLA deadline (offset computed
    // from the committed timestamps — never a wall clock).
    const epoch0 = timestampEpochMs(harness.store.definitions()[0]?.createdAt ?? instance.state.createdAt);
    const dueAt = harness.store.instances()[0]?.tasks.find((t) => t.key === 'verify-docs')?.dueAt;
    if (dueAt === undefined || dueAt === null) throw new Error('expected an SLA deadline');
    harness.setClock((timestampEpochMs(dueAt) - epoch0) / 1000 + 7);
    const escalated = expectOk(await harness.commands.instances.escalateInstance(
      envelope({ instanceId, expectedVersion: 3 }, ESCALATE_INSTANCE_COMMAND),
      operatorGrant,
    ));
    const task = escalated.state.tasks.find((t) => t.key === 'verify-docs');
    expect(task?.assignee).toBe(SUPERVISOR);
    expect(task?.escalated).toBe(true);
    // And the audit event records the v1-driven reassignment.
    const escalatedEvents = harness.sink.events.filter((event) => event.eventName === 'workflows.taskEscalated');
    expect(escalatedEvents).toHaveLength(1);
    expect(escalatedEvents[0]?.payload).toMatchObject({
      taskKey: 'verify-docs',
      from: ASSIGNEE,
      to: SUPERVISOR,
    });
  });

  it('instances start only from PUBLISHED definitions (typed rejection, no mutation)', async () => {
    const harness = makeHarness();
    const created = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    ));
    const result = await harness.commands.instances.startInstance(
      envelope({ definitionId: created.state.entityId, subject: subjectRef }, START_INSTANCE_COMMAND),
      operatorGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('workflow-definition-not-published');
    }
    expect(harness.store.instances()).toStrictEqual([]);
    expect(harness.sink.events.map((event) => event.eventName)).toStrictEqual([
      'workflows.definitionCreated', // the draft row was legitimately created
    ]);
  });
});

// ----- instances + the deterministic machine (command level) -------------------------------

describe('instance and transition commands', () => {
  it('starts an instance in the initial state and audits instance-started', async () => {
    const harness = makeHarness();
    const definitionId = await publishedDefinitionOf(harness);
    const result = await harness.commands.instances.startInstance(
      envelope({ definitionId, subject: subjectRef }, START_INSTANCE_COMMAND),
      operatorGrant,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state.currentState).toBe('draft');
      expect(result.value.state.status).toBe('running');
      expect(result.value.state.tasks).toHaveLength(2);
      expect(result.value.state.approvals).toHaveLength(1);
    }
    expect(harness.sink.events.map((event) => event.eventName)).toStrictEqual([
      'workflows.definitionCreated',
      'workflows.definitionPublished',
      'workflows.instanceStarted',
    ]);
  });

  it('executes a guarded transition to completion with the full audit group', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await taskLifecycle(harness, instanceId);
    await submitApproval(harness, instanceId);
    await approvalApproved(harness, instanceId);
    const result = await harness.commands.instances.executeTransition(
      envelope(
        { instanceId, expectedVersion: currentVersion(harness, instanceId), transitionKey: 'approve-change' },
        EXECUTE_TRANSITION_COMMAND,
      ),
      operatorGrant,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state.currentState).toBe('approved');
      expect(result.value.state.status).toBe('completed');
      // The still-open notify-parties task was settled by the leave-state cascade.
      const notify = result.value.state.tasks.find((task) => task.key === 'notify-parties');
      expect(notify?.status).toBe('skipped');
    }
    expect(harness.sink.events.map((event) => event.eventName)).toStrictEqual([
      'workflows.definitionCreated',
      'workflows.definitionPublished',
      'workflows.instanceStarted',
      'workflows.transitionExecuted',
      'workflows.taskAssigned',
      'workflows.taskStarted',
      'workflows.taskCompleted',
      'workflows.approvalSubmitted',
      'workflows.approvalApproved',
      'workflows.transitionExecuted',
      'workflows.taskSkipped',
      'workflows.instanceCompleted',
    ]);
  });

  it('rejects an unknown transition key (typed; the machine only executes declared transitions)', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const result = await harness.commands.instances.executeTransition(
      envelope({ instanceId, expectedVersion: 2, transitionKey: 'teleport' }, EXECUTE_TRANSITION_COMMAND),
      operatorGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('workflow-transition-unknown');
    }
    expect(harness.store.instances()[0]?.currentState).toBe('review');
  });

  it('a transition requiring an extra capability is typed-denied without mutation', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await approvalRejected(harness, instanceId);
    const before = harness.store.instances()[0];
    const expectedVersion = currentVersion(harness, instanceId);
    const denied = await harness.commands.instances.executeTransition(
      envelope({ instanceId, expectedVersion, transitionKey: 'reject-change' }, EXECUTE_TRANSITION_COMMAND),
      managerGrant, // holds workflows.write + cost.write, NOT contracts.write
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('forbidden');
      expect(denied.error.details[0]?.code).toBe('missing-required-capability');
      expect(denied.error.details[0]?.message).toContain('contracts.write');
    }
    expect(harness.store.instances()[0]).toStrictEqual(before);
    expect(harness.sink.events.filter((event) => event.eventName === 'workflows.transitionExecuted')).toHaveLength(1);

    // With the capability the same transition executes.
    const allowed = await harness.commands.instances.executeTransition(
      envelope({ instanceId, expectedVersion, transitionKey: 'reject-change' }, EXECUTE_TRANSITION_COMMAND),
      contractsWriter,
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.state.status).toBe('failed');
  });

  it('skips an open task with a recorded reason and audits task-skipped', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const result = await harness.commands.tasks.skipTask(
      envelope(
        { instanceId, expectedVersion: 2, taskKey: 'notify-parties', reason: 'not needed' },
        SKIP_TASK_COMMAND,
      ),
      operatorGrant,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const task = result.value.state.tasks.find((t) => t.key === 'notify-parties');
      expect(task?.status).toBe('skipped');
      expect(task?.outcome).toBe('skipped');
      expect(task?.skipReason).toBe('not needed');
      expect(result.value.state.version).toBe(3);
    }
    const skippedEvents = harness.sink.events.filter((event) => event.eventName === 'workflows.taskSkipped');
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0]?.payload).toMatchObject({
      instanceId,
      taskKey: 'notify-parties',
      reason: 'not needed',
    });
  });
});

// ----- THE capability-gated approval seam (no bypass path) ----------------------------------

describe('THE approval gate: approval-required actions cannot bypass policy', () => {
  it('an approval decision WITHOUT the required capability is typed-denied, audited, and never mutates', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await submitApproval(harness, instanceId);

    const before = harness.store.instances()[0];
    const eventsBefore = harness.sink.events.length;
    const lookupsBefore = harness.registryStats.lookups;
    const recordsBefore = harness.registryStats.records;
    const result = await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND),
      operatorGrant, // workflows.write only — NOT the required cost.write
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('missing-required-capability');
      expect(result.error.message).toContain('cost.write');
    }
    // The aggregate never advanced: same version, same approval status.
    expect(harness.store.instances()[0]).toStrictEqual(before);
    // The AUDIT-ONLY denial event records the gate that denied.
    const denial = harness.sink.events[harness.sink.events.length - 1];
    if (denial === undefined) throw new Error('expected an approval-denied audit event');
    expect(denial.eventName).toBe('workflows.approvalDenied');
    expect(denial.payload).toMatchObject({
      instanceId,
      approvalKey: 'manager',
      attemptedDecision: 'approve',
      requiredCapability: 'cost.write',
      policyRef: 'policy/change-orders@3',
      denialCode: 'missing-required-capability',
      version: before?.version,
    });
    expect(denial.entityRefs.before).toStrictEqual(denial.entityRefs.after);
    // The denial stays causally tied to the denied command's correlation id.
    expect(denial.causality.correlationId).toBe(CORRELATION_ID);
    expect(harness.sink.events.length).toBe(eventsBefore + 1);
    // The gate runs BEFORE the idempotency registry: nothing was recorded.
    expect(harness.registryStats.lookups).toBe(lookupsBefore);
    expect(harness.registryStats.records).toBe(recordsBefore);
  });

  it('a policy denial blocks the decision and is audited with denialCode policy-denied', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await submitApproval(harness, instanceId);
    const before = harness.store.instances()[0];
    const lookupsBefore = harness.registryStats.lookups;

    // (a) capability held, but no allow rule in the policy.
    const noAllow = await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND),
      noAllowRuleGrant,
    );
    expect(noAllow.ok).toBe(false);
    if (!noAllow.ok) {
      expect(noAllow.error.code).toBe('forbidden');
      expect(noAllow.error.details[0]?.code).toBe('no-allow-rule');
    }
    // (b) capability held, but an explicit deny rule forbids the actor.
    const explicit = await harness.commands.approvals.rejectApproval(
      envelope(
        { instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager', reason: 'terms' },
        REJECT_APPROVAL_COMMAND,
        { actorId: MANAGER },
      ),
      explicitDenyGrant,
    );
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) {
      expect(explicit.error.code).toBe('forbidden');
      expect(explicit.error.details[0]?.code).toBe('explicit-deny');
    }
    const denials = harness.sink.events.filter((event) => event.eventName === 'workflows.approvalDenied');
    expect(denials).toHaveLength(2);
    for (const denial of denials) {
      expect(denial.payload).toMatchObject({
        approvalKey: 'manager',
        requiredCapability: 'cost.write',
        denialCode: 'policy-denied',
      });
    }
    expect(harness.store.instances()[0]).toStrictEqual(before);
    expect(harness.registryStats.lookups).toBe(lookupsBefore);
  });

  it('NO idempotency bypass: a denial is never recorded, so the same key re-runs the gate', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await submitApproval(harness, instanceId);
    const key = nextKey();

    // First attempt: unauthorized → denied, gate ran, registry untouched.
    const expectedVersion = currentVersion(harness, instanceId);
    const lookupsBefore = harness.registryStats.lookups;
    const recordsBefore = harness.registryStats.records;
    const denied = await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion, approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND, { key }),
      operatorGrant,
    );
    expect(denied.ok).toBe(false);
    expect(harness.registryStats.lookups).toBe(lookupsBefore);
    expect(harness.registryStats.records).toBe(recordsBefore);

    // Retry under the SAME key, now authorized → the gate re-runs and passes.
    const approved = await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion, approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND, { key }),
      managerGrant,
    );
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.value.replayed).toBe(false);
      expect(approved.value.state.approvals[0]?.status).toBe('approved');
    }
  });

  it('NO replay bypass: even a RECORDED success under a key cannot be replayed by an unauthorized actor', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await submitApproval(harness, instanceId);
    const key = nextKey();

    // Authorized execution succeeds and is recorded under the key.
    const approved = await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND, { key }),
      managerGrant,
    );
    expect(approved.ok).toBe(true);
    const committed = approved.ok ? approved.value.state : null;
    expect(committed?.approvals[0]?.status).toBe('approved');

    // The SAME envelope (same key, same fingerprint) replayed by an actor
    // WITHOUT the capability: the gate runs BEFORE the registry, so the
    // denial wins — the recorded outcome is not handed out.
    const replay = await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND, { key }),
      operatorGrant,
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.details[0]?.code).toBe('missing-required-capability');
    }
    const denials = harness.sink.events.filter((event) => event.eventName === 'workflows.approvalDenied');
    expect(denials).toHaveLength(1);
    expect(harness.store.instances()[0]).toStrictEqual(committed);
  });

  it('a decided approval cannot be decided again (typed status guard; no mutation)', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await submitApproval(harness, instanceId);
    const approved = expectOk(await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND),
      managerGrant,
    ));
    const second = await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND),
      managerGrant,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.details[0]?.code).toBe('workflow-approval-status-guard');
    }
    expect(harness.store.instances()[0]).toStrictEqual(approved.state);
  });

  it('the reject path is gated by the same required capability', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    await submitApproval(harness, instanceId);
    const before = harness.store.instances()[0];
    const denied = await harness.commands.approvals.rejectApproval(
      envelope(
        { instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager', reason: 'terms' },
        REJECT_APPROVAL_COMMAND,
      ),
      operatorGrant, // no cost.write
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.details[0]?.code).toBe('missing-required-capability');
    expect(harness.sink.events.filter((event) => event.eventName === 'workflows.approvalDenied')).toHaveLength(1);
    expect(harness.store.instances()[0]).toStrictEqual(before);

    // Authorized rejection settles the step terminally.
    const rejected = await harness.commands.approvals.rejectApproval(
      envelope(
        { instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager', reason: 'commercial terms' },
        REJECT_APPROVAL_COMMAND,
      ),
      managerGrant,
    );
    expect(rejected.ok).toBe(true);
    if (rejected.ok) {
      expect(rejected.value.state.approvals[0]?.status).toBe('rejected');
      expect(rejected.value.state.approvals[0]?.decisionNote).toBe('commercial terms');
    }
  });
});

// ----- A12 tenant/project isolation (denied commands never mutate) --------------------------

describe('A12 scope isolation (cross-tenant and cross-project typed-rejected)', () => {
  it('a foreign tenant cannot see or act on an instance (typed not-found, both directions)', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const before = harness.store.instances()[0];
    const eventsBefore = harness.sink.events.length;

    // Tenant A aggregate, tenant B command.
    const fromB = await harness.commands.tasks.assignTask(
      envelope(
        { instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE },
        ASSIGN_TASK_COMMAND,
        { scope: B_SCOPE },
      ),
      operatorGrant,
    );
    expect(fromB.ok).toBe(false);
    if (!fromB.ok) {
      expect(fromB.error.code).toBe('not-found');
      expect(fromB.error.details[0]?.code).toBe('entity-not-found');
    }
    expect(harness.store.instances()[0]).toStrictEqual(before);
    expect(harness.sink.events.length).toBe(eventsBefore);

    // Reverse: a tenant-B aggregate is invisible to a tenant-A command.
    const bDefinition = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'B workflow', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
        { scope: B_SCOPE },
      ),
      operatorGrant,
    ));
    expectOk(await harness.commands.definitions.publishDefinition(
      envelope(
        { definitionId: bDefinition.state.entityId, expectedVersion: 1 },
        PUBLISH_DEFINITION_COMMAND,
        { scope: B_SCOPE },
      ),
      operatorGrant,
    ));
    const bInstance = expectOk(await harness.commands.instances.startInstance(
      envelope(
        { definitionId: bDefinition.state.entityId, subject: subjectRef },
        START_INSTANCE_COMMAND,
        { scope: B_SCOPE },
      ),
      operatorGrant,
    ));
    const fromA = await harness.commands.tasks.assignTask(
      envelope(
        {
          instanceId: bInstance.state.entityId,
          expectedVersion: 1,
          taskKey: 'verify-docs',
          assignee: ASSIGNEE,
        },
        ASSIGN_TASK_COMMAND,
      ),
      operatorGrant,
    );
    expect(fromA.ok).toBe(false);
    if (!fromA.ok) expect(fromA.error.code).toBe('not-found');
    expect(harness.store.instances()).toHaveLength(2); // both tenants' rows exist, isolated
  });

  it('a same-tenant wrong-project command is a typed project-scope-violation (never mutates)', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const before = harness.store.instances()[0];
    const result = await harness.commands.tasks.assignTask(
      envelope(
        { instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE },
        ASSIGN_TASK_COMMAND,
        { scope: OTHER_PROJECT_SCOPE },
      ),
      operatorGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-violation');
    }
    expect(harness.store.instances()[0]).toStrictEqual(before);
    expect(harness.sink.events.filter((event) => event.eventName === 'workflows.taskAssigned')).toHaveLength(0);
  });

  it('a tenant-scoped command is a typed project-scope-required denial (the second boundary)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'T', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
        { scope: TENANT_SCOPE },
      ),
      operatorGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-required');
    }
    expect(harness.store.definitions()).toStrictEqual([]);
    expect(harness.sink.events).toStrictEqual([]);
  });

  it('an unauthorized actor is denied before ANY effect (no event, no registry, no mutation)', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const before = harness.store.instances()[0];
    const eventsBefore = harness.sink.events.length;
    const lookupsBefore = harness.registryStats.lookups;
    const recordsBefore = harness.registryStats.records;
    const result = await harness.commands.tasks.assignTask(
      envelope(
        { instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE },
        ASSIGN_TASK_COMMAND,
      ),
      noGrant, // deny-by-default: no capabilities granted
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
    expect(harness.store.instances()[0]).toStrictEqual(before);
    expect(harness.sink.events.length).toBe(eventsBefore);
    expect(harness.registryStats.lookups).toBe(lookupsBefore);
    expect(harness.registryStats.records).toBe(recordsBefore);
  });
});

// ----- optimistic concurrency ---------------------------------------------------------------

describe('optimistic concurrency (stale version → typed conflict, state unchanged)', () => {
  it('rejects a stale instance version and never silently overwrites', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    // Version is now 2 (started v1, transition v2).
    expectOk(await harness.commands.tasks.assignTask(
      envelope({ instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND),
      operatorGrant,
    ));
    const after = harness.store.instances()[0];
    const stale = await harness.commands.tasks.assignTask(
      envelope({ instanceId, expectedVersion: 2, taskKey: 'notify-parties', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND),
      operatorGrant,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('concurrency-conflict');
      expect(stale.error.details[0]?.code).toBe('stale-aggregate-version');
    }
    expect(harness.store.instances()[0]).toStrictEqual(after);
  });

  it('rejects a stale definition version on update and publish', async () => {
    const harness = makeHarness();
    const created = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    ));
    const definitionId = created.state.entityId;
    const staleUpdate = await harness.commands.definitions.updateDefinition(
      envelope({ definitionId, expectedVersion: 99, model: SIMPLE_MODEL_RAW }, UPDATE_DEFINITION_COMMAND),
      operatorGrant,
    );
    expect(staleUpdate.ok).toBe(false);
    if (!staleUpdate.ok) expect(staleUpdate.error.code).toBe('concurrency-conflict');
    const stalePublish = await harness.commands.definitions.publishDefinition(
      envelope({ definitionId, expectedVersion: 99 }, PUBLISH_DEFINITION_COMMAND),
      operatorGrant,
    );
    expect(stalePublish.ok).toBe(false);
    if (!stalePublish.ok) expect(stalePublish.error.code).toBe('concurrency-conflict');
    expect(harness.store.definitions()[0]?.version).toBe(1);
  });
});

// ----- idempotency ---------------------------------------------------------------------------

describe('idempotency (same key → no duplicate execution)', () => {
  it('replays the recorded outcome with exactly-once effects', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const key = nextKey();
    const command = envelope(
      { instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE },
      ASSIGN_TASK_COMMAND,
      { key },
    );
    const first = await harness.commands.tasks.assignTask(command, operatorGrant);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.replayed).toBe(false);

    const idsBefore = harness.ids.issued;
    const eventsBefore = harness.sink.events.length;
    const recordsBefore = harness.registryStats.records;
    const replay = await harness.commands.tasks.assignTask(command, operatorGrant);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.state).toStrictEqual(first.ok ? first.value.state : null);
    }
    // No second effect: no new ids, no new events, no new registry record
    // (the replay is a lookup hit — the original record already exists).
    expect(harness.ids.issued).toBe(idsBefore);
    expect(harness.sink.events.length).toBe(eventsBefore);
    expect(harness.registryStats.records).toBe(recordsBefore);
  });

  it('a DIFFERENT payload under the same key is a typed idempotency-conflict', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const key = nextKey();
    expectOk(await harness.commands.tasks.assignTask(
      envelope(
        { instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE },
        ASSIGN_TASK_COMMAND,
        { key },
      ),
      operatorGrant,
    ));
    const conflict = await harness.commands.tasks.assignTask(
      envelope(
        { instanceId, expectedVersion: 3, taskKey: 'verify-docs', assignee: ASSIGNEE },
        ASSIGN_TASK_COMMAND,
        { key },
      ),
      operatorGrant,
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('idempotency-conflict');
      expect(conflict.error.details[0]?.code).toBe('idempotency-key-reuse');
    }
  });

  it('a FAILED execution is never recorded, so the same key stays retryable', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    const key = nextKey();
    // A stale version fails — and must not consume the key.
    const recordsBefore = harness.registryStats.records;
    const failed = await harness.commands.tasks.assignTask(
      envelope(
        { instanceId, expectedVersion: 99, taskKey: 'verify-docs', assignee: ASSIGNEE },
        ASSIGN_TASK_COMMAND,
        { key },
      ),
      operatorGrant,
    );
    expect(failed.ok).toBe(false);
    expect(harness.registryStats.records).toBe(recordsBefore);
    // The same key now succeeds with the correct version.
    const retry = await harness.commands.tasks.assignTask(
      envelope(
        { instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE },
        ASSIGN_TASK_COMMAND,
        { key },
      ),
      operatorGrant,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.replayed).toBe(false);
  });
});

// ----- bounded retries ------------------------------------------------------------------------

describe('bounded retries (deterministic backoff, typed terminal exhaustion)', () => {
  it('a retryable failure re-runs only after the backoff gate, then exhausts terminally', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    expectOk(await harness.commands.tasks.assignTask(
      envelope({ instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.startTask(
      envelope({ instanceId, expectedVersion: 3, taskKey: 'verify-docs' }, START_TASK_COMMAND),
      operatorGrant,
    ));
    // First failure: attempts 1 < maxAttempts 2 → retryable, backoff gate +60s.
    const failed = expectOk(await harness.commands.tasks.failTask(
      envelope({ instanceId, expectedVersion: 4, taskKey: 'verify-docs', reason: 'adapter timeout' }, FAIL_TASK_COMMAND),
      operatorGrant,
    ));
    let task = failed.state.tasks.find((t) => t.key === 'verify-docs');
    expect(task?.outcome).toBe('failed');
    const gate = task?.retryNotBefore ?? null;
    expect(gate).not.toBeNull();

    // Retrying immediately (auto-ticking clock is far from the gate) → typed rejection.
    const early = await harness.commands.tasks.retryTask(
      envelope({ instanceId, expectedVersion: 5, taskKey: 'verify-docs' }, RETRY_TASK_COMMAND),
      operatorGrant,
    );
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.error.details[0]?.code).toBe('workflow-task-retry-backoff-not-elapsed');
    }
    expect(harness.store.instances()[0]?.tasks.find((t) => t.key === 'verify-docs')?.attempts).toBe(1);

    // Jump the injected clock past the gate, then retry: attempts 2.
    const createdAt = harness.store.definitions()[0]?.createdAt;
    if (createdAt === undefined) throw new Error('expected the definition row');
    if (gate === null) throw new Error('expected a retry backoff gate');
    const epoch0 = timestampEpochMs(createdAt);
    const gateOffset = (timestampEpochMs(gate) - epoch0) / 1000;
    harness.setClock(gateOffset + 7);
    const retried = expectOk(await harness.commands.tasks.retryTask(
      envelope({ instanceId, expectedVersion: 5, taskKey: 'verify-docs' }, RETRY_TASK_COMMAND),
      operatorGrant,
    ));
    task = retried.state.tasks.find((t) => t.key === 'verify-docs');
    expect(task?.attempts).toBe(2);
    expect(task?.status).toBe('in-progress');
    expect(harness.sink.events.map((event) => event.eventName)).toContain('workflows.taskRetried');

    // Second failure: attempts 2 == maxAttempts → the typed TERMINAL outcome.
    const exhausted = expectOk(await harness.commands.tasks.failTask(
      envelope({ instanceId, expectedVersion: 6, taskKey: 'verify-docs', reason: 'still timing out' }, FAIL_TASK_COMMAND),
      operatorGrant,
    ));
    task = exhausted.state.tasks.find((t) => t.key === 'verify-docs');
    expect(task?.outcome).toBe('exhausted');
    expect(task?.retryNotBefore).toBeNull();

    // No retry path out of the exhausted terminal state.
    harness.setClock(gateOffset + 10_000);
    const blocked = await harness.commands.tasks.retryTask(
      envelope({ instanceId, expectedVersion: 7, taskKey: 'verify-docs' }, RETRY_TASK_COMMAND),
      operatorGrant,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.details[0]?.code).toBe('workflow-task-retries-exhausted');
    }
    expect(harness.store.instances()[0]?.tasks.find((t) => t.key === 'verify-docs')?.attempts).toBe(2);
  });

  it('retry attempts are idempotent: the same key never double-executes', async () => {
    const harness = makeHarness();
    const { instanceId } = await runningReviewInstance(harness);
    expectOk(await harness.commands.tasks.assignTask(
      envelope({ instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.startTask(
      envelope({ instanceId, expectedVersion: 3, taskKey: 'verify-docs' }, START_TASK_COMMAND),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.failTask(
      envelope({ instanceId, expectedVersion: 4, taskKey: 'verify-docs', reason: 'flake' }, FAIL_TASK_COMMAND),
      operatorGrant,
    ));
    const task = harness.store.instances()[0]?.tasks.find((t) => t.key === 'verify-docs');
    if (task === undefined) throw new Error('expected the verify-docs task');
    if (task.retryNotBefore === null) throw new Error('expected a retry backoff gate');
    const createdAt = harness.store.definitions()[0]?.createdAt;
    if (createdAt === undefined) throw new Error('expected the definition row');
    const epoch0 = timestampEpochMs(createdAt);
    const gateOffset = (timestampEpochMs(task.retryNotBefore) - epoch0) / 1000;
    harness.setClock(gateOffset + 7);
    const key = nextKey();
    const first = await harness.commands.tasks.retryTask(
      envelope({ instanceId, expectedVersion: 5, taskKey: 'verify-docs' }, RETRY_TASK_COMMAND, { key }),
      operatorGrant,
    );
    expect(first.ok).toBe(true);
    const eventsBefore = harness.sink.events.length;
    const replay = await harness.commands.tasks.retryTask(
      envelope({ instanceId, expectedVersion: 5, taskKey: 'verify-docs' }, RETRY_TASK_COMMAND, { key }),
      operatorGrant,
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.state.tasks.find((t) => t.key === 'verify-docs')?.attempts).toBe(2);
    }
    expect(harness.sink.events.filter((event) => event.eventName === 'workflows.taskRetried')).toHaveLength(1);
    expect(harness.sink.events.length).toBe(eventsBefore);
  });
});

// ----- SLA escalation (injected clock exactness) ------------------------------------------------

describe('SLA escalation (fires exactly at the breach; reassigns per the definition; auditable)', () => {
  interface TimedHarness {
    readonly commands: ReturnType<typeof createWorkflowCommands>;
    readonly store: ReturnType<typeof createInMemoryWorkflowStore>;
    readonly sink: EventSink;
    readonly setNow: (timestamp: Timestamp) => void;
  }

  const timedHarness = (sink: EventSink = createInMemoryEventSink()): TimedHarness => {
    const store = createInMemoryWorkflowStore();
    const registry = createInMemoryIdempotencyRegistry();
    let current: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
    let issued = 0;
    const deps: WorkflowCommandDeps = {
      store,
      eventSink: sink,
      idempotencyRegistry: registry,
      now: () => current,
      newOpaqueId: () => {
        issued += 1;
        return `w${String(issued).padStart(15, '0')}`;
      },
      executor: FAKE_EXECUTOR,
    };
    return {
      commands: createWorkflowCommands(deps),
      store,
      sink,
      setNow: (timestamp) => {
        current = timestamp;
      },
    };
  };

  const reviewWithSlaTask = async (harness: TimedHarness): Promise<{ instanceId: EntityId; dueAt: Timestamp }> => {
    const definition = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
      ),
      operatorGrant,
    ));
    expectOk(await harness.commands.definitions.publishDefinition(
      envelope({ definitionId: definition.state.entityId, expectedVersion: 1 }, PUBLISH_DEFINITION_COMMAND),
      operatorGrant,
    ));
    const instance = expectOk(await harness.commands.instances.startInstance(
      envelope({ definitionId: definition.state.entityId, subject: subjectRef }, START_INSTANCE_COMMAND),
      operatorGrant,
    ));
    const instanceId = instance.state.entityId;
    expectOk(await harness.commands.instances.executeTransition(
      envelope({ instanceId, expectedVersion: 1, transitionKey: 'submit-for-review' }, EXECUTE_TRANSITION_COMMAND),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.assignTask(
      envelope({ instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND),
      operatorGrant,
    ));
    const dueAt = harness.store.instances()[0]?.tasks.find((t) => t.key === 'verify-docs')?.dueAt ?? null;
    if (dueAt === null) throw new Error('expected an SLA deadline');
    return { instanceId, dueAt };
  };

  it('one second before the deadline nothing happens; AT the deadline the escalation fires', async () => {
    const sink = createInMemoryEventSink();
    const harness = timedHarness(sink);
    const { instanceId, dueAt } = await reviewWithSlaTask(harness);
    const before = harness.store.instances()[0];

    harness.setNow(unwrap(parseTimestamp('2026-09-12T11:15:30.000Z'))); // dueAt − 1s
    const early = expectOk(await harness.commands.instances.escalateInstance(
      envelope({ instanceId, expectedVersion: 3 }, ESCALATE_INSTANCE_COMMAND),
      operatorGrant,
    ));
    expect(early.state).toStrictEqual(before); // no version bump, no reassignment
    expect(sink.events.filter((event) => event.eventName === 'workflows.taskEscalated')).toHaveLength(0);

    harness.setNow(dueAt); // EXACTLY the SLA breach
    const atBreach = expectOk(await harness.commands.instances.escalateInstance(
      envelope({ instanceId, expectedVersion: 3 }, ESCALATE_INSTANCE_COMMAND),
      operatorGrant,
    ));
    const task = atBreach.state.tasks.find((t) => t.key === 'verify-docs');
    expect(task?.assignee).toBe(SUPERVISOR); // definition-driven reassignment
    expect(task?.escalated).toBe(true);
    expect(task?.escalatedAt).toBe(dueAt);
    expect(atBreach.state.version).toBe(4);
    expect(sink.events.filter((event) => event.eventName === 'workflows.taskEscalated')).toHaveLength(1);
  });

  it('escalation is one-shot and auditable through the task-escalated event', async () => {
    const sink = createInMemoryEventSink();
    const harness = timedHarness(sink);
    const { instanceId, dueAt } = await reviewWithSlaTask(harness);
    harness.setNow(dueAt);
    const first = expectOk(await harness.commands.instances.escalateInstance(
      envelope({ instanceId, expectedVersion: 3 }, ESCALATE_INSTANCE_COMMAND),
      operatorGrant,
    ));
    const escalatedEvents = sink.events.filter((event) => event.eventName === 'workflows.taskEscalated');
    expect(escalatedEvents).toHaveLength(1);
    expect(escalatedEvents[0]?.payload).toMatchObject({
      instanceId,
      taskKey: 'verify-docs',
      from: ASSIGNEE,
      to: SUPERVISOR,
      dueAt,
    });
    expect(escalatedEvents[0]?.entityRefs.after?.entityId).toBe(instanceId);

    // A later sweep does nothing (one-shot).
    harness.setNow(unwrap(parseTimestamp('2026-09-12T23:00:00.000Z')));
    const second = expectOk(await harness.commands.instances.escalateInstance(
      envelope({ instanceId, expectedVersion: 4 }, ESCALATE_INSTANCE_COMMAND),
      operatorGrant,
    ));
    expect(second.state).toStrictEqual(first.state);
    expect(sink.events.filter((event) => event.eventName === 'workflows.taskEscalated')).toHaveLength(1);
  });

  it('a sink failure aborts the whole escalation mutation (state unchanged)', async () => {
    // The setup commands must legitimately commit their audit events first;
    // only the ESCALATION append (the mutation under test) fails.
    const failOnEscalation: EventSink = {
      appendEvents: (executor, events) =>
        Promise.resolve(
          events.some((event) => event.eventName === 'workflows.taskEscalated')
            ? fail(eventSinkFailure('ledger down'))
            : ok(true),
        ),
    };
    const harness = timedHarness(failOnEscalation);
    const { instanceId, dueAt } = await reviewWithSlaTask(harness);
    harness.setNow(dueAt);
    const result = await harness.commands.instances.escalateInstance(
      envelope({ instanceId, expectedVersion: 3 }, ESCALATE_INSTANCE_COMMAND),
      operatorGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    // The store was never mutated by the aborted mutation.
    expect(harness.store.instances()[0]?.tasks.find((t) => t.key === 'verify-docs')?.escalated).toBe(false);
    expect(harness.store.instances()[0]?.version).toBe(3);
  });
});

// ----- end-to-end determinism ---------------------------------------------------------------

describe('end-to-end determinism (same commands → same states, same events)', () => {
  const runFlow = async (harness: Harness): Promise<void> => {
    const definition = expectOk(await harness.commands.definitions.createDefinition(
      envelope(
        { key: 'det-flow', title: 'Determinism flow', model: CHANGE_ORDER_MODEL_RAW },
        CREATE_DEFINITION_COMMAND,
        { key: 'det-0001' },
      ),
      operatorGrant,
    ));
    expectOk(await harness.commands.definitions.publishDefinition(
      envelope({ definitionId: definition.state.entityId, expectedVersion: 1 }, PUBLISH_DEFINITION_COMMAND, { key: 'det-0002' }),
      operatorGrant,
    ));
    const instance = expectOk(await harness.commands.instances.startInstance(
      envelope({ definitionId: definition.state.entityId, subject: subjectRef }, START_INSTANCE_COMMAND, { key: 'det-0003' }),
      operatorGrant,
    ));
    const instanceId = instance.state.entityId;
    expectOk(await harness.commands.instances.executeTransition(
      envelope({ instanceId, expectedVersion: 1, transitionKey: 'submit-for-review' }, EXECUTE_TRANSITION_COMMAND, { key: 'det-0004' }),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.assignTask(
      envelope({ instanceId, expectedVersion: 2, taskKey: 'verify-docs', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND, { key: 'det-0005' }),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.startTask(
      envelope({ instanceId, expectedVersion: 3, taskKey: 'verify-docs' }, START_TASK_COMMAND, { key: 'det-0006' }),
      operatorGrant,
    ));
    expectOk(await harness.commands.tasks.completeTask(
      envelope({ instanceId, expectedVersion: 4, taskKey: 'verify-docs' }, COMPLETE_TASK_COMMAND, { key: 'det-0007' }),
      operatorGrant,
    ));
    expectOk(await harness.commands.approvals.submitApproval(
      envelope({ instanceId, expectedVersion: 5, approvalKey: 'manager' }, SUBMIT_APPROVAL_COMMAND, { key: 'det-0008' }),
      operatorGrant,
    ));
    expectOk(await harness.commands.approvals.approveApproval(
      envelope({ instanceId, expectedVersion: 6, approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND, { key: 'det-0009' }),
      managerGrant,
    ));
    expectOk(await harness.commands.instances.executeTransition(
      envelope({ instanceId, expectedVersion: 7, transitionKey: 'approve-change' }, EXECUTE_TRANSITION_COMMAND, { key: 'det-0010' }),
      operatorGrant,
    ));
  };

  it('two independent harnesses produce identical committed states and identical audit events', async () => {
    const first = makeHarness();
    const second = makeHarness();
    await runFlow(first);
    await runFlow(second);

    expect(second.store.definitions()).toStrictEqual(first.store.definitions());
    expect(second.store.instances()).toStrictEqual(first.store.instances());
    expect(second.sink.events).toStrictEqual(first.sink.events);
    // The completed instance reached the success terminal state deterministically.
    expect(first.store.instances()[0]?.status).toBe('completed');
    expect(first.store.instances()[0]?.currentState).toBe('approved');
    // The full audit sequence of the flow.
    expect(first.sink.events.map((event) => event.eventName)).toStrictEqual([
      'workflows.definitionCreated',
      'workflows.definitionPublished',
      'workflows.instanceStarted',
      'workflows.transitionExecuted',
      'workflows.taskAssigned',
      'workflows.taskStarted',
      'workflows.taskCompleted',
      'workflows.approvalSubmitted',
      'workflows.approvalApproved',
      'workflows.transitionExecuted',
      'workflows.taskSkipped',
      'workflows.instanceCompleted',
    ]);
    // Every event of the flow is causally tied to its command's idempotency key.
    expect(first.sink.events.map((event) => event.causality.causationId)).toStrictEqual([
      'det-0001',
      'det-0002',
      'det-0003',
      'det-0004',
      'det-0005',
      'det-0006',
      'det-0007',
      'det-0008',
      'det-0009',
      'det-0010',
      'det-0010',
      'det-0010',
    ]);
  });
});

// ----- shared flow helpers --------------------------------------------------------------------

/** The committed aggregate version of an instance in the harness store. */
const currentVersion = (harness: Harness, instanceId: EntityId): number =>
  harness.store.instances().find((row) => row.entityId === instanceId)?.version ?? 1;

async function publishedDefinitionOf(harness: Harness): Promise<EntityId> {
  const created = expectOk(await harness.commands.definitions.createDefinition(
    envelope(
      { key: 'change-order-approval', title: 'Change order approval', model: CHANGE_ORDER_MODEL_RAW },
      CREATE_DEFINITION_COMMAND,
    ),
    operatorGrant,
  ));
  const definitionId = created.state.entityId;
  expectOk(await harness.commands.definitions.publishDefinition(
    envelope({ definitionId, expectedVersion: 1 }, PUBLISH_DEFINITION_COMMAND),
    operatorGrant,
  ));
  return definitionId;
}

async function runningReviewInstance(harness: Harness): Promise<{ instanceId: EntityId; version: number }> {
  const definitionId = await publishedDefinitionOf(harness);
  const instance = expectOk(await harness.commands.instances.startInstance(
    envelope({ definitionId, subject: subjectRef }, START_INSTANCE_COMMAND),
    operatorGrant,
  ));
  const instanceId = instance.state.entityId;
  expectOk(await harness.commands.instances.executeTransition(
    envelope({ instanceId, expectedVersion: 1, transitionKey: 'submit-for-review' }, EXECUTE_TRANSITION_COMMAND),
    operatorGrant,
  ));
  return { instanceId, version: 2 };
}

async function taskLifecycle(harness: Harness, instanceId: EntityId): Promise<void> {
  expectOk(await harness.commands.tasks.assignTask(
    envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), taskKey: 'verify-docs', assignee: ASSIGNEE }, ASSIGN_TASK_COMMAND),
    operatorGrant,
  ));
  expectOk(await harness.commands.tasks.startTask(
    envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), taskKey: 'verify-docs' }, START_TASK_COMMAND),
    operatorGrant,
  ));
  expectOk(await harness.commands.tasks.completeTask(
    envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), taskKey: 'verify-docs' }, COMPLETE_TASK_COMMAND),
    operatorGrant,
  ));
}

async function submitApproval(harness: Harness, instanceId: EntityId): Promise<void> {
  expectOk(await harness.commands.approvals.submitApproval(
    envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, SUBMIT_APPROVAL_COMMAND),
    operatorGrant,
  ));
}

async function approvalApproved(harness: Harness, instanceId: EntityId): Promise<void> {
  expectOk(await harness.commands.approvals.approveApproval(
    envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager' }, APPROVE_APPROVAL_COMMAND),
    managerGrant,
  ));
}

async function approvalRejected(harness: Harness, instanceId: EntityId): Promise<void> {
  await submitApproval(harness, instanceId);
  expectOk(await harness.commands.approvals.rejectApproval(
    envelope({ instanceId, expectedVersion: currentVersion(harness, instanceId), approvalKey: 'manager', reason: 'terms' }, REJECT_APPROVAL_COMMAND),
    managerGrant,
  ));
}
