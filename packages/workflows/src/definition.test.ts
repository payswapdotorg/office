import { describe, expect, it } from 'vitest';
import {
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
import type { WorkflowRetryPolicy } from './definition';
import { CHANGE_ORDER_MODEL, CHANGE_ORDER_MODEL_RAW, SIMPLE_MODEL, SIMPLE_MODEL_RAW, unwrap } from './test-support';

// OFF-016 workflow engine — the versioned workflow DEFINITION model: total
// fail-closed parsing of every sub-shape and the CLOSED-TABLE structural
// validation (the parse-time half of "the machine can never enter an
// undefined state"), plus the pure deterministic backoff arithmetic.

const VALID_STATE = { name: 'draft', kind: 'initial' };
const VALID_TRANSITION = {
  key: 'submit-for-review',
  from: 'draft',
  to: 'review',
  conditions: [{ kind: 'always' }],
};
const VALID_ASSIGNMENT = { actorKinds: ['user'], roles: ['reviewer'] };
const VALID_TASK = {
  key: 'verify-docs',
  title: 'Verify change order documents',
  state: 'review',
  assignment: { actorKinds: ['user'], roles: ['reviewer'] },
};
const VALID_APPROVAL = {
  key: 'manager',
  title: 'Commercial manager approval',
  state: 'review',
  requiredCapability: 'cost.write',
  policyRef: 'policy/change-orders@3',
};
const VALID_RETRY_POLICY = { maxAttempts: 2, backoffBaseSeconds: 60, backoffMaxSeconds: 600 };
const VALID_ESCALATION_RULE = { task: 'verify-docs', reassignTo: 'office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3' };

const minimalModel = () => ({
  states: [
    { name: 'start', kind: 'initial' },
    { name: 'done', kind: 'success' },
  ],
  transitions: [{ key: 'go', from: 'start', to: 'done', conditions: [{ kind: 'always' }] }],
  tasks: [],
  approvals: [],
  retryPolicy: { maxAttempts: 1, backoffBaseSeconds: 30, backoffMaxSeconds: 300 },
  escalationRules: [],
});

// ----- vocabularies --------------------------------------------------------------------

describe('workflow vocabularies', () => {
  it('declares the closed state-kind vocabulary', () => {
    expect(WORKFLOW_STATE_KINDS).toStrictEqual(['initial', 'normal', 'success', 'failure']);
  });

  it('declares the closed task-outcome vocabulary', () => {
    expect(TASK_OUTCOMES).toStrictEqual(['completed', 'skipped', 'failed', 'exhausted']);
  });

  it('declares the closed condition vocabulary', () => {
    expect(CONDITION_KINDS).toStrictEqual([
      'always',
      'task-outcome',
      'approval-decision',
      'all-tasks-settled',
    ]);
  });

  it('declares the bound constants', () => {
    expect(MAX_SLA_MINUTES).toBe(525_600);
    expect(MAX_RETRY_ATTEMPTS).toBe(20);
    expect(MAX_BACKOFF_BASE_SECONDS).toBe(86_400);
    expect(MAX_BACKOFF_MAX_SECONDS).toBe(604_800);
  });
});

// ----- sub-parsers (fail-closed) ---------------------------------------------------------

describe('parseWorkflowStateDefinition', () => {
  it('parses a valid state definition', () => {
    const result = parseWorkflowStateDefinition(VALID_STATE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual(VALID_STATE);
  });

  it('rejects a non-object root', () => {
    const result = parseWorkflowStateDefinition('draft');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });

  it('rejects an unknown key (strict keys)', () => {
    const result = parseWorkflowStateDefinition({ name: 'draft', kind: 'initial', icon: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects an undeclared state kind', () => {
    const result = parseWorkflowStateDefinition({ name: 'draft', kind: 'archived' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a non-kebab state name', () => {
    const result = parseWorkflowStateDefinition({ name: 'Draft State', kind: 'initial' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('parseTransitionCondition (closed vocabulary)', () => {
  it('parses each condition kind', () => {
    expect(unwrap(parseTransitionCondition({ kind: 'always' }))).toStrictEqual({ kind: 'always' });
    expect(
      unwrap(parseTransitionCondition({ kind: 'task-outcome', task: 'verify-docs', outcome: 'completed' })),
    ).toStrictEqual({ kind: 'task-outcome', task: 'verify-docs', outcome: 'completed' });
    expect(
      unwrap(parseTransitionCondition({ kind: 'approval-decision', approval: 'manager', decision: 'approved' })),
    ).toStrictEqual({ kind: 'approval-decision', approval: 'manager', decision: 'approved' });
    expect(
      unwrap(parseTransitionCondition({ kind: 'all-tasks-settled', state: 'review' })),
    ).toStrictEqual({ kind: 'all-tasks-settled', state: 'review' });
  });

  it('rejects an unknown condition kind (closed vocabulary)', () => {
    const result = parseTransitionCondition({ kind: 'expression', code: 'true' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an unknown extra key inside a condition', () => {
    const result = parseTransitionCondition({ kind: 'always', unless: 'weekend' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects an undeclared task outcome', () => {
    const result = parseTransitionCondition({ kind: 'task-outcome', task: 'verify-docs', outcome: 'cancelled' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('parseWorkflowTransitionDefinition', () => {
  it('parses a valid transition and defaults requiredCapabilities to empty', () => {
    const result = parseWorkflowTransitionDefinition(VALID_TRANSITION);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.requiredCapabilities).toStrictEqual([]);
  });

  it('parses declared required capabilities', () => {
    const result = parseWorkflowTransitionDefinition({
      ...VALID_TRANSITION,
      requiredCapabilities: ['contracts.write'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.requiredCapabilities).toStrictEqual(['contracts.write']);
  });

  it('rejects an undeclared capability name (closed vocabulary)', () => {
    const result = parseWorkflowTransitionDefinition({
      ...VALID_TRANSITION,
      requiredCapabilities: ['rocket-science.write'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an empty conditions array (at least one guard is required)', () => {
    const result = parseWorkflowTransitionDefinition({ ...VALID_TRANSITION, conditions: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a missing conditions field', () => {
    const { conditions: _conditions, ...withoutConditions } = VALID_TRANSITION;
    const result = parseWorkflowTransitionDefinition(withoutConditions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });

  it('nests element failure paths (transitions are validated inside the model)', () => {
    const model = {
      ...minimalModel(),
      transitions: [
        { key: 'go', from: 'start', to: 'done', conditions: [{ kind: 'nope' }] },
      ],
    };
    const result = parseWorkflowModel(model);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('transitions[0].conditions[0].kind');
    }
  });
});

describe('parseTaskAssignment', () => {
  it('parses actor kinds and roles', () => {
    const result = parseTaskAssignment(VALID_ASSIGNMENT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual(VALID_ASSIGNMENT);
  });

  it('defaults roles to empty', () => {
    const result = parseTaskAssignment({ actorKinds: ['user'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.roles).toStrictEqual([]);
  });

  it('rejects an empty actorKinds array', () => {
    const result = parseTaskAssignment({ actorKinds: [], roles: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects duplicate actor kinds', () => {
    const result = parseTaskAssignment({ actorKinds: ['user', 'user'], roles: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects duplicate roles', () => {
    const result = parseTaskAssignment({ actorKinds: ['user'], roles: ['reviewer', 'reviewer'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an actor kind outside the contracts vocabulary', () => {
    const result = parseTaskAssignment({ actorKinds: ['robot'], roles: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('parseWorkflowTaskDefinition', () => {
  it('parses a valid task with an SLA window', () => {
    const result = parseWorkflowTaskDefinition({ ...VALID_TASK, slaMinutes: 60 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.slaMinutes).toBe(60);
  });

  it('defaults slaMinutes to null (no SLA)', () => {
    const result = parseWorkflowTaskDefinition(VALID_TASK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.slaMinutes).toBeNull();
  });

  it('rejects a zero SLA window (SLA minutes are 1..525600)', () => {
    const result = parseWorkflowTaskDefinition({ ...VALID_TASK, slaMinutes: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an SLA window above the bound', () => {
    const result = parseWorkflowTaskDefinition({ ...VALID_TASK, slaMinutes: MAX_SLA_MINUTES + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('parseWorkflowApprovalDefinition', () => {
  it('parses a valid approval step carrying THE required capability', () => {
    const result = parseWorkflowApprovalDefinition(VALID_APPROVAL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiredCapability).toBe('cost.write');
      expect(result.value.policyRef).toBe('policy/change-orders@3');
    }
  });

  it('rejects an undeclared required capability', () => {
    const result = parseWorkflowApprovalDefinition({
      ...VALID_APPROVAL,
      requiredCapability: 'approvals.super',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an empty policy reference', () => {
    const result = parseWorkflowApprovalDefinition({ ...VALID_APPROVAL, policyRef: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a missing requiredCapability', () => {
    const { requiredCapability: _cap, ...withoutCapability } = VALID_APPROVAL;
    const result = parseWorkflowApprovalDefinition(withoutCapability);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

describe('parseWorkflowRetryPolicy (typed, bounded)', () => {
  it('parses a valid policy', () => {
    const result = parseWorkflowRetryPolicy(VALID_RETRY_POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual(VALID_RETRY_POLICY);
  });

  it('rejects zero attempts', () => {
    const result = parseWorkflowRetryPolicy({ ...VALID_RETRY_POLICY, maxAttempts: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects attempts above the bound', () => {
    const result = parseWorkflowRetryPolicy({ ...VALID_RETRY_POLICY, maxAttempts: MAX_RETRY_ATTEMPTS + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a ceiling below the base', () => {
    const result = parseWorkflowRetryPolicy({
      ...VALID_RETRY_POLICY,
      backoffBaseSeconds: 600,
      backoffMaxSeconds: 60,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('backoffMaxSeconds');
    }
  });

  it('rejects a non-integer backoff base', () => {
    const result = parseWorkflowRetryPolicy({ ...VALID_RETRY_POLICY, backoffBaseSeconds: 0.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });
});

describe('parseWorkflowEscalationRule', () => {
  it('parses a task-specific rule', () => {
    const result = parseWorkflowEscalationRule(VALID_ESCALATION_RULE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.task).toBe('verify-docs');
  });

  it("parses the '*' wildcard rule (every task)", () => {
    const result = parseWorkflowEscalationRule({ ...VALID_ESCALATION_RULE, task: '*' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.task).toBe('*');
  });

  it('rejects a malformed reassignment target', () => {
    const result = parseWorkflowEscalationRule({ ...VALID_ESCALATION_RULE, reassignTo: 'not-an-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a non-string task', () => {
    const result = parseWorkflowEscalationRule({ ...VALID_ESCALATION_RULE, task: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('definition key/title/description parsing', () => {
  it('parses a kebab-case definition key', () => {
    expect(unwrap(parseDefinitionKey('change-order-approval'))).toBe('change-order-approval');
  });

  it('rejects an uppercase definition key', () => {
    expect(parseDefinitionKey('ChangeOrder').ok).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(parseDefinitionTitle('').ok).toBe(false);
  });

  it('rejects a title above 200 characters', () => {
    expect(parseDefinitionTitle('x'.repeat(201)).ok).toBe(false);
  });

  it('rejects an empty description', () => {
    expect(parseDefinitionDescription('').ok).toBe(false);
  });
});

// ----- the closed-table structural validation --------------------------------------------

describe('parseWorkflowModel (closed-table structural validation)', () => {
  it('parses the canonical change-order model', () => {
    const result = parseWorkflowModel(CHANGE_ORDER_MODEL_RAW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual(CHANGE_ORDER_MODEL);
  });

  it('parses the canonical minimal model', () => {
    const result = parseWorkflowModel(SIMPLE_MODEL_RAW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual(SIMPLE_MODEL);
  });

  it('isWorkflowModel agrees with parseWorkflowModel', () => {
    expect(isWorkflowModel(CHANGE_ORDER_MODEL_RAW)).toBe(true);
    expect(isWorkflowModel({ ...minimalModel(), states: [] })).toBe(false);
  });

  it('is round-trip idempotent: a parsed model re-parses to an equal value (stored models re-validate)', () => {
    // The definition-state invariant re-validates the STORED (parsed) model
    // through this parser — a parser not total over its own output would
    // make every definition creation fail its invariants.
    const first = unwrap(parseWorkflowModel(CHANGE_ORDER_MODEL_RAW));
    const second = unwrap(parseWorkflowModel(first));
    expect(second).toStrictEqual(first);
    expect(isWorkflowModel(first)).toBe(true);
    expect(isWorkflowModel(unwrap(parseWorkflowModel(SIMPLE_MODEL)))).toBe(true);
  });

  it('rejects a non-object root', () => {
    const result = parseWorkflowModel('workflow');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });

  it('rejects an unknown top-level key (strict keys)', () => {
    const result = parseWorkflowModel({ ...minimalModel(), version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects zero states', () => {
    const result = parseWorkflowModel({ ...minimalModel(), states: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects duplicate state names', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      states: [
        { name: 'start', kind: 'initial' },
        { name: 'start', kind: 'normal' },
        { name: 'done', kind: 'success' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects two initial states', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      states: [
        { name: 'start', kind: 'initial' },
        { name: 'alt-start', kind: 'initial' },
        { name: 'done', kind: 'success' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a model without a terminal state', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      states: [
        { name: 'start', kind: 'initial' },
        { name: 'middle', kind: 'normal' },
      ],
      transitions: [{ key: 'go', from: 'start', to: 'middle', conditions: [{ kind: 'always' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects duplicate transition keys', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      transitions: [
        { key: 'go', from: 'start', to: 'done', conditions: [{ kind: 'always' }] },
        { key: 'go', from: 'done', to: 'start', conditions: [{ kind: 'always' }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a transition from an undeclared state', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      transitions: [{ key: 'go', from: 'ghost', to: 'done', conditions: [{ kind: 'always' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('transitions[0].from');
    }
  });

  it('rejects a transition to an UNDECLARED state (the machine can never enter an undefined state)', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      transitions: [{ key: 'go', from: 'start', to: 'ghost', conditions: [{ kind: 'always' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('transitions[0].to');
      expect(result.error.received).toContain('ghost');
    }
  });

  it('rejects an outgoing transition of a terminal state', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      transitions: [
        { key: 'go', from: 'start', to: 'done', conditions: [{ kind: 'always' }] },
        { key: 'revive', from: 'done', to: 'start', conditions: [{ kind: 'always' }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('transitions[1].from');
    }
  });

  it('rejects a transition re-entering the initial state', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      states: [
        { name: 'start', kind: 'initial' },
        { name: 'middle', kind: 'normal' },
        { name: 'done', kind: 'success' },
      ],
      transitions: [
        { key: 'go', from: 'start', to: 'middle', conditions: [{ kind: 'always' }] },
        { key: 'back', from: 'middle', to: 'start', conditions: [{ kind: 'always' }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('transitions[1].to');
      expect(result.error.received).toContain('initial state');
    }
  });

  it('rejects a self-transition', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      states: [
        { name: 'start', kind: 'initial' },
        { name: 'middle', kind: 'normal' },
        { name: 'done', kind: 'success' },
      ],
      transitions: [
        { key: 'go', from: 'start', to: 'middle', conditions: [{ kind: 'always' }] },
        { key: 'loop', from: 'middle', to: 'middle', conditions: [{ kind: 'always' }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('transitions[1].to');
    }
  });

  it('rejects a condition referencing an undeclared task', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      transitions: [
        {
          key: 'go',
          from: 'start',
          to: 'done',
          conditions: [{ kind: 'task-outcome', task: 'ghost-task', outcome: 'completed' }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('transitions[0].conditions[0].task');
    }
  });

  it('rejects a condition referencing an undeclared approval', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      transitions: [
        {
          key: 'go',
          from: 'start',
          to: 'done',
          conditions: [
            { kind: 'approval-decision', approval: 'ghost-approval', decision: 'approved' },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('transitions[0].conditions[0].approval');
  });

  it('rejects an all-tasks-settled condition referencing an undeclared state', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      transitions: [
        {
          key: 'go',
          from: 'start',
          to: 'done',
          conditions: [{ kind: 'all-tasks-settled', state: 'ghost-state' }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('transitions[0].conditions[0].state');
  });

  it('rejects duplicate task keys', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      tasks: [VALID_TASK, { ...VALID_TASK, slaMinutes: 30 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects duplicate approval keys', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      approvals: [VALID_APPROVAL, { ...VALID_APPROVAL, title: 'Second manager' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a task bound to an undeclared state', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      tasks: [{ ...VALID_TASK, state: 'ghost' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('tasks[0].state');
  });

  it('rejects a task bound to a terminal state (tasks settle before the machine terminates)', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      tasks: [{ ...VALID_TASK, state: 'done' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('tasks[0].state');
  });

  it('rejects an approval bound to a terminal state', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      approvals: [{ ...VALID_APPROVAL, state: 'done' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('approvals[0].state');
  });

  it('rejects an escalation rule addressing an undeclared task', () => {
    const result = parseWorkflowModel({
      ...minimalModel(),
      tasks: [{ ...VALID_TASK, state: 'start' }],
      escalationRules: [{ task: 'ghost-task', reassignTo: VALID_ESCALATION_RULE.reassignTo }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('escalationRules[0].task');
  });
});

// ----- the deterministic backoff arithmetic ----------------------------------------------

describe('retryBackoffSeconds (pure arithmetic on definition parameters)', () => {
  const policy: WorkflowRetryPolicy = {
    maxAttempts: 4,
    backoffBaseSeconds: 60,
    backoffMaxSeconds: 600,
  };

  it('doubles exponentially per attempt', () => {
    expect(retryBackoffSeconds(policy, 1)).toBe(60);
    expect(retryBackoffSeconds(policy, 2)).toBe(120);
    expect(retryBackoffSeconds(policy, 3)).toBe(240);
  });

  it('caps at the ceiling', () => {
    expect(retryBackoffSeconds(policy, 4)).toBe(480);
    expect(retryBackoffSeconds({ ...policy, backoffMaxSeconds: 100 }, 3)).toBe(100);
    expect(retryBackoffSeconds({ ...policy, backoffMaxSeconds: 100 }, 2)).toBe(100);
  });

  it('is deterministic: same policy + same attempt → the same seconds', () => {
    expect(retryBackoffSeconds(policy, 2)).toBe(retryBackoffSeconds(policy, 2));
  });

  it('throws loudly on a non-positive attempt (never silent)', () => {
    expect(() => retryBackoffSeconds(policy, 0)).toThrow(TypeError);
    expect(() => retryBackoffSeconds(policy, 1.5)).toThrow(TypeError);
  });
});
