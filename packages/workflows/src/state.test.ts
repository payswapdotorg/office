import { describe, expect, it } from 'vitest';
import { parseEntityKind, parseTimestamp } from '@office/contracts';
import type { EntityId, EntityRef, Timestamp } from '@office/contracts';
import { capability } from '@office/authz';
import {
  addSecondsToTimestamp,
  compareTimestamps,
  conditionHolds,
  createWorkflowDefinitionState,
  createWorkflowInstanceState,
  decideWorkflowApprovalState,
  escalateWorkflowInstanceState,
  failWorkflowTaskState,
  nextDefinitionVersionOf,
  publishWorkflowDefinitionState,
  retryWorkflowTaskState,
  timestampEpochMs,
  transitionWorkflowInstanceState,
  updateWorkflowDefinitionModelState,
  assignWorkflowTaskState,
  completeWorkflowTaskState,
  skipWorkflowTaskState,
  startWorkflowTaskState,
  submitWorkflowApprovalState,
} from './state';
import type { WorkflowDefinitionState, WorkflowInstanceState } from './state';
import { CHANGE_ORDER_MODEL, PROJECT_1, SIMPLE_MODEL, TENANT_A, expectOk, projectScopeOf, unwrap } from './test-support';
import type { WorkflowModel } from './definition';

// OFF-016 workflow engine — the aggregate states and the PURE deterministic
// state machine: definition lifecycle (draft → publish = freeze; a change is
// a NEW version), instance creation pinning its definition version, the
// transition table (guard → capability → state → task lifecycle), the typed
// task lifecycle with bounded retries + deterministic backoff, the approval
// lifecycle, and the SLA escalation sweep — all against injected timestamps
// (no wall clock, no randomness).

const DEFINITION_ID = 'office-ent-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9' as EntityId;
const INSTANCE_ID = 'office-ent-v1-2a2b3c4d5e6f708192a3b4c5d6e7f8a9' as EntityId;
const ASSIGNEE = 'office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4' as EntityId;
const SUPERVISOR = 'office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3' as EntityId;
const SCOPE = projectScopeOf(PROJECT_1, TENANT_A);

const T0: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const T1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:20:00.000Z'));
const T2: Timestamp = unwrap(parseTimestamp('2026-09-12T11:00:00.000Z'));

const subject: EntityRef = {
  entityKind: unwrap(parseEntityKind('change-order')),
  entityId: 'office-ent-v1-f60718293a4b5c6d7e8f9a1b2c3d4e5' as EntityId,
};

const makeDefinition = (
  model: WorkflowModel = CHANGE_ORDER_MODEL,
  definitionVersion = 1,
): WorkflowDefinitionState =>
  expectOk(createWorkflowDefinitionState(
    {
      definitionId: DEFINITION_ID,
      key: 'change-order-approval',
      definitionVersion,
      title: 'Change order approval',
      model,
      now: T0,
    },
    SCOPE,
  ));

const publishedDefinition = (
  model: WorkflowModel = CHANGE_ORDER_MODEL,
  definitionVersion = 1,
): WorkflowDefinitionState =>
  expectOk(publishWorkflowDefinitionState(makeDefinition(model, definitionVersion), T1));

const makeInstance = (
  model: WorkflowModel = CHANGE_ORDER_MODEL,
  instanceId: EntityId = INSTANCE_ID,
): WorkflowInstanceState =>
  expectOk(createWorkflowInstanceState(
    publishedDefinition(model),
    { instanceId, subject, now: T1 },
    SCOPE,
  ));

const taskOf = (instance: WorkflowInstanceState, key: string) => {
  const task = instance.tasks.find((t) => t.key === key);
  if (task === undefined) throw new Error(`task ${key} not found`);
  return task;
};

const approvalOf = (instance: WorkflowInstanceState, key: string) => {
  const approval = instance.approvals.find((a) => a.key === key);
  if (approval === undefined) throw new Error(`approval ${key} not found`);
  return approval;
};

// ----- pure timestamp arithmetic ---------------------------------------------------------

describe('pure timestamp arithmetic (no host Date, no wall clock)', () => {
  it('converts canonical timestamps to epoch milliseconds deterministically', () => {
    expect(timestampEpochMs(T0)).toBe(Date.UTC(2026, 8, 12, 10, 15, 31, 0));
    expect(timestampEpochMs('2026-09-12T10:15:31.500Z' as Timestamp)).toBe(
      Date.UTC(2026, 8, 12, 10, 15, 31, 500),
    );
  });

  it('adds whole seconds across calendar boundaries', () => {
    expect(addSecondsToTimestamp(T0, 60)).toBe('2026-09-12T10:16:31.000Z');
    expect(addSecondsToTimestamp(T0, 3600)).toBe('2026-09-12T11:15:31.000Z');
    expect(addSecondsToTimestamp('2026-12-31T23:59:59.000Z' as Timestamp, 1)).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(addSecondsToTimestamp('2024-02-28T23:59:59.000Z' as Timestamp, 86400)).toBe(
      '2024-02-29T23:59:59.000Z',
    );
  });

  it('throws loudly on non-integer seconds', () => {
    expect(() => addSecondsToTimestamp(T0, 0.5)).toThrow(TypeError);
  });

  it('compares timestamps at millisecond precision', () => {
    expect(compareTimestamps(T0, T1)).toBeLessThan(0);
    expect(compareTimestamps(T1, T1)).toBe(0);
    expect(compareTimestamps(T2, T1)).toBeGreaterThan(0);
  });
});

// ----- the WorkflowDefinition lifecycle --------------------------------------------------

describe('WorkflowDefinitionState lifecycle (immutability by publication)', () => {
  it('creates a draft definition at version 1 with paired timestamps', () => {
    const state = makeDefinition();
    expect(state.status).toBe('draft');
    expect(state.version).toBe(1);
    expect(state.publishedAt).toBeNull();
    expect(state.createdAt).toBe(T0);
    expect(state.updatedAt).toBe(T0);
    expect(state.model).toStrictEqual(CHANGE_ORDER_MODEL);
  });

  it('replaces the model of a draft and bumps the aggregate version', () => {
    const draft = makeDefinition();
    const updated = expectOk(updateWorkflowDefinitionModelState(draft, SIMPLE_MODEL, T1));
    expect(updated.status).toBe('draft');
    expect(updated.model).toStrictEqual(SIMPLE_MODEL);
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).toBe(T1);
    expect(updated.definitionVersion).toBe(1);
  });

  it('publishing freezes the definition (one-way)', () => {
    const published = expectOk(publishWorkflowDefinitionState(makeDefinition(), T1));
    expect(published.status).toBe('published');
    expect(published.publishedAt).toBe(T1);
    expect(published.version).toBe(2);
  });

  it('a PUBLISHED definition has no update path — typed invariant-violation', () => {
    const published = publishedDefinition();
    const result = updateWorkflowDefinitionModelState(published, SIMPLE_MODEL, T2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('workflow-definition-published-immutable');
    }
  });

  it('publishing an already-published definition is a typed invariant-violation', () => {
    const published = publishedDefinition();
    const result = publishWorkflowDefinitionState(published, T2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('workflow-definition-already-published');
    }
  });

  it('nextDefinitionVersionOf issues the next version deterministically from the existing rows', () => {
    expect(nextDefinitionVersionOf([])).toBe(1);
    expect(nextDefinitionVersionOf([makeDefinition(CHANGE_ORDER_MODEL, 1)])).toBe(2);
    expect(
      nextDefinitionVersionOf([
        makeDefinition(CHANGE_ORDER_MODEL, 1),
        makeDefinition(CHANGE_ORDER_MODEL, 2),
        makeDefinition(CHANGE_ORDER_MODEL, 5),
      ]),
    ).toBe(6);
  });
});

// ----- instance creation -----------------------------------------------------------------

describe('createWorkflowInstanceState (instances pin their definition version)', () => {
  it('rejects instances from a DRAFT definition (drafts are not executable blueprints)', () => {
    const result = createWorkflowInstanceState(
      makeDefinition(),
      { instanceId: INSTANCE_ID, subject, now: T1 },
      SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('workflow-definition-not-published');
    }
  });

  it('starts in the initial state and instantiates tasks/approvals from the pinned model', () => {
    const instance = makeInstance();
    expect(instance.entityId).toBe(INSTANCE_ID);
    expect(instance.currentState).toBe('draft');
    expect(instance.status).toBe('running');
    expect(instance.version).toBe(1);
    expect(instance.tasks.map((task) => task.key)).toStrictEqual(['verify-docs', 'notify-parties']);
    expect(taskOf(instance, 'verify-docs').status).toBe('created');
    expect(taskOf(instance, 'verify-docs').attempts).toBe(0);
    expect(approvalOf(instance, 'manager').status).toBe('pending');
    expect(approvalOf(instance, 'manager').requiredCapability).toBe('cost.write');
    expect(approvalOf(instance, 'manager').policyRef).toBe('policy/change-orders@3');
  });

  it('pins the exact definition row (id, key, version)', () => {
    const instance = makeInstance();
    expect(instance.definitionId).toBe(DEFINITION_ID);
    expect(instance.definitionKey).toBe('change-order-approval');
    expect(instance.definitionVersion).toBe(1);
  });
});

// ----- THE deterministic transition machine ----------------------------------------------

describe('transitionWorkflowInstanceState (THE deterministic machine)', () => {
  const toReview = (instance: WorkflowInstanceState): WorkflowInstanceState =>
    expectOk(transitionWorkflowInstanceState(CHANGE_ORDER_MODEL, instance, 'submit-for-review', [], T1))
      .state;

  it('executes a declared transition from its source state', () => {
    const instance = makeInstance();
    const result = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      instance,
      'submit-for-review',
      [],
      T1,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state.currentState).toBe('review');
      expect(result.value.state.status).toBe('running');
      expect(result.value.state.version).toBe(2);
      expect(result.value.transition.key).toBe('submit-for-review');
    }
  });

  it('is PURE: same definition + same state + same command → the same resulting state and events', () => {
    // Prepare a state in which the 'approve-change' guard holds: the task is
    // completed and the manager approval is approved.
    const prepared = (): WorkflowInstanceState => {
      const inReview = toReview(makeInstance());
      const withTask = expectOk(completeWorkflowTaskState(
        expectOk(startWorkflowTaskState(
          expectOk(assignWorkflowTaskState(inReview, 'verify-docs', ASSIGNEE, 60, T1)),
          'verify-docs',
          T1,
        )),
        'verify-docs',
        T1,
      ));
      return expectOk(decideWorkflowApprovalState(
        expectOk(submitWorkflowApprovalState(withTask, 'manager', null, T1)),
        'manager',
        'approved',
        null,
        null,
        T1,
      ));
    };
    const instance = prepared();
    const first = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      instance,
      'approve-change',
      [capability('cost.write')],
      T2,
    );
    const second = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      instance,
      'approve-change',
      [capability('cost.write')],
      T2,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // The full structured results (state + transition + skipped tasks) and
    // their canonical JSON are identical — the machine is deterministic.
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // Same inputs on a structurally equal twin instance: identical outcome.
    const twin = prepared();
    const twinResult = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      { ...twin, entityId: instance.entityId },
      'approve-change',
      [capability('cost.write')],
      T2,
    );
    expect(twinResult).toStrictEqual(first);
  });

  it('rejects an unknown transition key (typed; the machine only executes declared transitions)', () => {
    const result = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'teleport',
      [],
      T1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('workflow-transition-unknown');
    }
  });

  it('rejects a transition whose source state is not the current state', () => {
    const result = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'approve-change',
      [],
      T1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('workflow-transition-not-from-current-state');
    }
  });

  it('rejects a transition whose guard is not satisfied', () => {
    const inReview = toReview(makeInstance());
    // 'approve-change' requires task verify-docs=completed AND manager=approved.
    const result = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      inReview,
      'approve-change',
      [],
      T2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('workflow-transition-guard-not-satisfied');
    }
  });

  it('rejects a transition when the actor lacks a required capability (typed forbidden)', () => {
    // Guard first, capability second: prepare the rejected decision so the
    // 'reject-change' guard holds, then withhold its required capability.
    const inReview = toReview(makeInstance());
    const withDecision = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview, 'manager', null, T1)),
      'manager',
      'rejected',
      null,
      'commercial terms',
      T1,
    ));
    const result = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      withDecision,
      'reject-change',
      [],
      T2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('missing-required-capability');
      expect(result.error.details[0]?.message).toContain('contracts.write');
    }
  });

  it('never enters an undefined state: an undeclared target is refused even in a hand-built model (defense in depth)', () => {
    // Bypass the parser deliberately: a model whose transition targets an
    // undeclared state. The machine re-checks the target and typed-rejects.
    const ghostModel = {
      ...CHANGE_ORDER_MODEL,
      transitions: [
        ...CHANGE_ORDER_MODEL.transitions.filter((t) => t.key !== 'submit-for-review'),
        { key: 'submit-for-review', from: 'draft', to: 'ghost-state', conditions: [{ kind: 'always' }], requiredCapabilities: [] },
      ],
    } as unknown as WorkflowModel;
    const result = transitionWorkflowInstanceState(ghostModel, makeInstance(), 'submit-for-review', [], T1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('workflow-transition-target-undeclared');
      expect(result.error.message).toContain('ghost-state');
    }
  });

  it('settles still-open tasks of the departed state as skipped', () => {
    const inReview = toReview(makeInstance());
    // Complete verify-docs; approve the manager step; notify-parties stays open.
    const withTask = expectOk(completeWorkflowTaskState(
      expectOk(startWorkflowTaskState(
        expectOk(assignWorkflowTaskState(inReview, 'verify-docs', ASSIGNEE, 60, T1)),
        'verify-docs',
        T1,
      )),
      'verify-docs',
      T1,
    ));
    const withDecision = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(withTask, 'manager', null, T1)),
      'manager',
      'approved',
      null,
      null,
      T1,
    ));
    const result = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      withDecision,
      'approve-change',
      [],
      T2,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // notify-parties (bound to 'review', still 'created') was settled.
      expect(result.value.skippedTasks.map((task) => task.key)).toStrictEqual(['notify-parties']);
      expect(taskOf(result.value.state, 'notify-parties').status).toBe('skipped');
      expect(taskOf(result.value.state, 'notify-parties').outcome).toBe('skipped');
      expect(taskOf(result.value.state, 'notify-parties').skipReason).toBe(
        'workflow-left-state-review',
      );
    }
  });

  it('reaching a success state completes the instance terminally (terminal instances never change)', () => {
    const inReview = toReview(makeInstance());
    const withTask = expectOk(completeWorkflowTaskState(
      expectOk(startWorkflowTaskState(
        expectOk(assignWorkflowTaskState(inReview, 'verify-docs', ASSIGNEE, 60, T1)),
        'verify-docs',
        T1,
      )),
      'verify-docs',
      T1,
    ));
    const withDecision = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(withTask, 'manager', null, T1)),
      'manager',
      'approved',
      null,
      null,
      T1,
    ));
    const completed = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      withDecision,
      'approve-change',
      [],
      T2,
    ));
    expect(completed.state.status).toBe('completed');
    expect(completed.state.completedAt).toBe(T2);
    expect(completed.state.currentState).toBe('approved');

    // Every further machine function typed-rejects on the terminal instance.
    const rejected = transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      completed.state,
      'submit-for-review',
      [],
      T2,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.details[0]?.code).toBe('workflow-instance-terminal');
    }
  });

  it('reaching a failure state fails the instance terminally', () => {
    const inReview = toReview(makeInstance());
    const withDecision = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview, 'manager', null, T1)),
      'manager',
      'rejected',
      null,
      'commercial terms',
      T1,
    ));
    const failed = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      withDecision,
      'reject-change',
      [capability('contracts.write')],
      T2,
    ));
    expect(failed.state.status).toBe('failed');
    expect(failed.state.failedAt).toBe(T2);
    expect(failed.state.currentState).toBe('rejected');
  });
});

// ----- conditionHolds (the closed guard vocabulary) ---------------------------------------

describe('conditionHolds (closed guard vocabulary, deterministic)', () => {
  it("'always' holds unconditionally", () => {
    expect(conditionHolds({ kind: 'always' }, makeInstance())).toBe(true);
  });

  it("'task-outcome' matches the task's typed outcome", () => {
    const inReview = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'submit-for-review',
      [],
      T1,
    )).state;
    expect(
      conditionHolds({ kind: 'task-outcome', task: 'verify-docs', outcome: 'completed' }, inReview),
    ).toBe(false);
    const done = expectOk(completeWorkflowTaskState(
      expectOk(startWorkflowTaskState(
        expectOk(assignWorkflowTaskState(inReview, 'verify-docs', ASSIGNEE, 60, T1)),
        'verify-docs',
        T1,
      )),
      'verify-docs',
      T1,
    ));
    expect(
      conditionHolds({ kind: 'task-outcome', task: 'verify-docs', outcome: 'completed' }, done),
    ).toBe(true);
    expect(
      conditionHolds({ kind: 'task-outcome', task: 'verify-docs', outcome: 'failed' }, done),
    ).toBe(false);
  });

  it("'approval-decision' matches the approval's decision status", () => {
    const inReview = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'submit-for-review',
      [],
      T1,
    )).state;
    expect(
      conditionHolds({ kind: 'approval-decision', approval: 'manager', decision: 'approved' }, inReview),
    ).toBe(false);
    const decided = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview, 'manager', null, T1)),
      'manager',
      'approved',
      null,
      null,
      T1,
    ));
    expect(
      conditionHolds({ kind: 'approval-decision', approval: 'manager', decision: 'approved' }, decided),
    ).toBe(true);
    expect(
      conditionHolds({ kind: 'approval-decision', approval: 'manager', decision: 'rejected' }, decided),
    ).toBe(false);
  });

  it("'all-tasks-settled' holds exactly when every task of the state is completed or skipped", () => {
    const inReview = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'submit-for-review',
      [],
      T1,
    )).state;
    // Two open tasks bound to 'review' → not settled.
    expect(conditionHolds({ kind: 'all-tasks-settled', state: 'review' }, inReview)).toBe(false);
    const bothDone = expectOk(skipWorkflowTaskState(
      expectOk(completeWorkflowTaskState(
        expectOk(startWorkflowTaskState(
          expectOk(assignWorkflowTaskState(inReview, 'verify-docs', ASSIGNEE, 60, T1)),
          'verify-docs',
          T1,
        )),
        'verify-docs',
        T1,
      )),
      'notify-parties',
      'not needed',
      T1,
    ));
    expect(conditionHolds({ kind: 'all-tasks-settled', state: 'review' }, bothDone)).toBe(true);
  });
});

// ----- the task lifecycle (bounded retries, deterministic backoff) ------------------------

describe('task lifecycle (assignment, attempts, bounded retries)', () => {
  const inReview = (): WorkflowInstanceState =>
    expectOk(transitionWorkflowInstanceState(CHANGE_ORDER_MODEL, makeInstance(), 'submit-for-review', [], T1))
      .state;

  it('assigns a created task and computes the SLA deadline from the injected now', () => {
    const assigned = expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, T1));
    const task = taskOf(assigned, 'verify-docs');
    expect(task.status).toBe('assigned');
    expect(task.assignee).toBe(ASSIGNEE);
    expect(task.assignedAt).toBe(T1);
    expect(task.dueAt).toBe('2026-09-12T11:20:00.000Z');
    expect(assigned.version).toBe(3); // submit-for-review (v2) + assignment (v3)
  });

  it('an SLA-less task has no deadline', () => {
    const assigned = expectOk(assignWorkflowTaskState(inReview(), 'notify-parties', ASSIGNEE, null, T1));
    expect(taskOf(assigned, 'notify-parties').dueAt).toBeNull();
  });

  it('rejects assignment of an already-assigned task (one-way from created)', () => {
    const assigned = expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, T1));
    const result = assignWorkflowTaskState(assigned, 'verify-docs', ASSIGNEE, 60, T2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('workflow-task-status-guard');
  });

  it('rejects an unknown task key (typed not-found)', () => {
    const result = assignWorkflowTaskState(inReview(), 'ghost-task', ASSIGNEE, 60, T1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('start counts the first attempt; complete settles the outcome', () => {
    const started = expectOk(startWorkflowTaskState(
      expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, T1)),
      'verify-docs',
      T1,
    ));
    expect(taskOf(started, 'verify-docs').status).toBe('in-progress');
    expect(taskOf(started, 'verify-docs').attempts).toBe(1);
    const completed = expectOk(completeWorkflowTaskState(started, 'verify-docs', T2));
    expect(taskOf(completed, 'verify-docs').status).toBe('completed');
    expect(taskOf(completed, 'verify-docs').outcome).toBe('completed');
    expect(taskOf(completed, 'verify-docs').completedAt).toBe(T2);
  });

  it('skip settles an open task with the recorded reason', () => {
    const skipped = expectOk(skipWorkflowTaskState(inReview(), 'notify-parties', 'not needed', T2));
    const task = taskOf(skipped, 'notify-parties');
    expect(task.status).toBe('skipped');
    expect(task.outcome).toBe('skipped');
    expect(task.skipReason).toBe('not needed');
    expect(task.skippedAt).toBe(T2);
  });

  it('exhausts the bounded retry policy into the typed terminal outcome', () => {
    // CHANGE_ORDER retry policy: maxAttempts 2, base 60s, ceiling 600s.
    let instance = expectOk(startWorkflowTaskState(
      expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, T1)),
      'verify-docs',
      T1,
    ));
    // First failure at T1: attempts 1 < 2 → retryable, backoff(1) = 60s.
    instance = expectOk(failWorkflowTaskState(instance, 'verify-docs', 'timeout', CHANGE_ORDER_MODEL.retryPolicy, T1));
    expect(taskOf(instance, 'verify-docs').status).toBe('failed');
    expect(taskOf(instance, 'verify-docs').outcome).toBe('failed');
    expect(taskOf(instance, 'verify-docs').retryNotBefore).toBe('2026-09-12T10:21:00.000Z');

    // Backoff gate: one second early → typed rejection, state untouched.
    const early = retryWorkflowTaskState(instance, 'verify-docs', CHANGE_ORDER_MODEL.retryPolicy, '2026-09-12T10:20:59.000Z' as Timestamp);
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.error.details[0]?.code).toBe('workflow-task-retry-backoff-not-elapsed');
    }
    expect(taskOf(instance, 'verify-docs').attempts).toBe(1);

    // Retry at the gate (T1+60s): attempts 2, back in progress.
    instance = expectOk(retryWorkflowTaskState(instance, 'verify-docs', CHANGE_ORDER_MODEL.retryPolicy, '2026-09-12T10:21:00.000Z' as Timestamp));
    expect(taskOf(instance, 'verify-docs').attempts).toBe(2);
    expect(taskOf(instance, 'verify-docs').status).toBe('in-progress');

    // Second failure at attempts 2 == maxAttempts → typed TERMINAL 'exhausted'.
    instance = expectOk(failWorkflowTaskState(instance, 'verify-docs', 'timeout again', CHANGE_ORDER_MODEL.retryPolicy, T2));
    const task = taskOf(instance, 'verify-docs');
    expect(task.outcome).toBe('exhausted');
    expect(task.retryNotBefore).toBeNull();

    // No retry path exists out of the exhausted terminal state.
    const exhausted = retryWorkflowTaskState(instance, 'verify-docs', CHANGE_ORDER_MODEL.retryPolicy, '2026-09-13T10:00:00.000Z' as Timestamp);
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) {
      expect(exhausted.error.details[0]?.code).toBe('workflow-task-retries-exhausted');
    }
    expect(taskOf(instance, 'verify-docs').attempts).toBe(2);
  });

  it('the backoff gate is deterministic arithmetic: same failure instant → same gate', () => {
    const failed = expectOk(failWorkflowTaskState(
      expectOk(startWorkflowTaskState(
        expectOk(assignWorkflowTaskState(inReview(), 'verify-docs', ASSIGNEE, 60, T1)),
        'verify-docs',
        T1,
      )),
      'verify-docs',
      'timeout',
      CHANGE_ORDER_MODEL.retryPolicy,
      T1,
    ));
    expect(taskOf(failed, 'verify-docs').retryNotBefore).toBe(
      addSecondsToTimestamp(T1, 60),
    );
  });
});

// ----- the approval lifecycle -------------------------------------------------------------

describe('approval lifecycle (submit → capability-gated decide)', () => {
  const inReview = (): WorkflowInstanceState =>
    expectOk(transitionWorkflowInstanceState(CHANGE_ORDER_MODEL, makeInstance(), 'submit-for-review', [], T1))
      .state;

  it('submits a pending approval and records the submitter', () => {
    const submitted = expectOk(submitWorkflowApprovalState(inReview(), 'manager', ASSIGNEE, T1));
    const approval = approvalOf(submitted, 'manager');
    expect(approval.status).toBe('submitted');
    expect(approval.submittedBy).toBe(ASSIGNEE);
    expect(approval.submittedAt).toBe(T1);
  });

  it('decides a submitted approval terminally (approved)', () => {
    const decided = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview(), 'manager', null, T1)),
      'manager',
      'approved',
      ASSIGNEE,
      'documents verified',
      T2,
    ));
    const approval = approvalOf(decided, 'manager');
    expect(approval.status).toBe('approved');
    expect(approval.decidedBy).toBe(ASSIGNEE);
    expect(approval.decidedAt).toBe(T2);
    expect(approval.decisionNote).toBe('documents verified');
  });

  it('deciding twice is a typed status-guard rejection', () => {
    const decided = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview(), 'manager', null, T1)),
      'manager',
      'approved',
      null,
      null,
      T1,
    ));
    const result = decideWorkflowApprovalState(decided, 'manager', 'rejected', null, null, T2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('workflow-approval-status-guard');
    }
  });

  it('deciding a pending (unsubmitted) approval is a typed rejection', () => {
    const result = decideWorkflowApprovalState(inReview(), 'manager', 'approved', null, null, T1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('workflow-approval-status-guard');
  });

  it('an unknown approval key is a typed not-found', () => {
    const result = submitWorkflowApprovalState(inReview(), 'ghost-approval', null, T1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});

// ----- SLA escalation ----------------------------------------------------------------------

describe('escalateWorkflowInstanceState (SLA breach against the injected clock)', () => {
  const reviewWithBreachedTask = (): { instance: WorkflowInstanceState; dueAt: Timestamp } => {
    const inReview = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'submit-for-review',
      [],
      T1,
    )).state;
    const assigned = expectOk(assignWorkflowTaskState(inReview, 'verify-docs', ASSIGNEE, 60, T1));
    return { instance: assigned, dueAt: taskOf(assigned, 'verify-docs').dueAt ?? T1 };
  };

  it('fires EXACTLY at the SLA breach (one millisecond before: nothing; at the deadline: reassignment)', () => {
    const { instance, dueAt } = reviewWithBreachedTask();
    const justBefore = addSecondsToTimestamp(dueAt, -1);

    const before = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, instance, justBefore));
    expect(before.escalatedTasks).toStrictEqual([]);
    expect(before.state).toStrictEqual(instance); // unchanged, no version bump

    const atBreach = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, instance, dueAt));
    expect(atBreach.escalatedTasks.map((record) => record.key)).toStrictEqual(['verify-docs']);
    const escalated = taskOf(atBreach.state, 'verify-docs');
    expect(escalated.assignee).toBe(SUPERVISOR); // definition-driven reassignment
    expect(escalated.escalated).toBe(true);
    expect(escalated.escalatedAt).toBe(dueAt);
    expect(atBreach.state.version).toBe(instance.version + 1);
  });

  it('records the structured escalation record for the audit event', () => {
    const { instance, dueAt } = reviewWithBreachedTask();
    const result = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, instance, dueAt));
    const record = result.escalatedTasks[0];
    expect(record).toBeDefined();
    if (record) {
      expect(record.from).toBe(ASSIGNEE);
      expect(record.to).toBe(SUPERVISOR);
      expect(record.dueAt).toBe(dueAt);
    }
  });

  it('escalation is one-shot: a second sweep after the first does nothing', () => {
    const { instance, dueAt } = reviewWithBreachedTask();
    const first = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, instance, dueAt));
    const later = addSecondsToTimestamp(dueAt, 3600);
    const second = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, first.state, later));
    expect(second.escalatedTasks).toStrictEqual([]);
    expect(second.state).toStrictEqual(first.state);
  });

  it('does not escalate an unbreached task, a settled task, or a task without a rule', () => {
    const inReview = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'submit-for-review',
      [],
      T1,
    )).state;
    // notify-parties has an SLA of null (no rule and no deadline).
    const assigned = expectOk(assignWorkflowTaskState(inReview, 'notify-parties', ASSIGNEE, null, T1));
    const swept = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, assigned, addSecondsToTimestamp(T2, 100_000)));
    expect(swept.escalatedTasks).toStrictEqual([]);

    // A settled task never escalates even past its deadline.
    const { instance } = reviewWithBreachedTask();
    const completed = expectOk(completeWorkflowTaskState(
      expectOk(startWorkflowTaskState(instance, 'verify-docs', T1)),
      'verify-docs',
      T1,
    ));
    const sweptCompleted = expectOk(escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, completed, addSecondsToTimestamp(T2, 100_000)));
    expect(sweptCompleted.escalatedTasks).toStrictEqual([]);
  });

  it('terminal instances never escalate (typed rejection)', () => {
    const inReview = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      makeInstance(),
      'submit-for-review',
      [],
      T1,
    )).state;
    const withDecision = expectOk(decideWorkflowApprovalState(
      expectOk(submitWorkflowApprovalState(inReview, 'manager', null, T1)),
      'manager',
      'rejected',
      null,
      'terms',
      T1,
    ));
    const failed = expectOk(transitionWorkflowInstanceState(
      CHANGE_ORDER_MODEL,
      withDecision,
      'reject-change',
      [capability('contracts.write')],
      T2,
    ));
    const result = escalateWorkflowInstanceState(CHANGE_ORDER_MODEL, failed.state, addSecondsToTimestamp(T2, 100_000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('workflow-instance-terminal');
  });
});
