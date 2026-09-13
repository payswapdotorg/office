// OFF-017 acceptance — the ActionDescriptor model: total fail-closed parsing
// with the structural class rules (an invalid descriptor never enters a
// registry), and the trusted-path defineActionDescriptor.
import { describe, expect, it } from 'vitest';
import {
  COMMIT_BUDGET_REVISION,
  LIST_COST_ITEMS,
  PURGE_COST_LEDGER,
  RECORD_PROGRESS,
  SUBMIT_DAILY_LOG,
} from './test-support';
import { defineActionDescriptor, parseActionDescriptor } from './descriptor';

const baseDescriptor = {
  commandName: 'cost.listCostItems',
  title: 'List cost items',
  actionClass: 'read',
  actorKinds: ['user', 'agent'],
  requiredCapabilities: ['cost.read'],
  policyRef: 'policy/cost-queries@1',
  evidenceRequirements: [],
  requiredConfidence: 'low',
  resourceKind: 'cost-item',
  compensatingCommand: null,
  approval: null,
} as const;

describe('ActionDescriptor parsing (fail-closed, strict keys)', () => {
  it('parses the canonical read descriptor', () => {
    const parsed = parseActionDescriptor(baseDescriptor);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.commandName).toBe('cost.listCostItems');
      expect(parsed.value.actionClass).toBe('read');
      expect(parsed.value.compensatingCommand).toBeNull();
      expect(parsed.value.approval).toBeNull();
      expect(parsed.value.description).toBeNull();
    }
  });

  it('parses every canonical fixture of the acceptance vocabulary', () => {
    for (const descriptor of [
      LIST_COST_ITEMS,
      RECORD_PROGRESS,
      SUBMIT_DAILY_LOG,
      COMMIT_BUDGET_REVISION,
      PURGE_COST_LEDGER,
    ]) {
      const parsed = parseActionDescriptor(descriptor);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value).toEqual(descriptor);
      }
    }
  });

  it('rejects a non-object root', () => {
    const parsed = parseActionDescriptor('nope');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('invalid-type');
  });

  it('rejects unknown keys (strict shape)', () => {
    const parsed = parseActionDescriptor({ ...baseDescriptor, extra: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('unknown-field');
      expect(parsed.error.path).toBe('extra');
    }
  });

  it('rejects a missing required field with the dotted path', () => {
    const { policyRef: _omit, ...withoutPolicy } = baseDescriptor;
    void _omit;
    const parsed = parseActionDescriptor(withoutPolicy);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('missing-field');
      expect(parsed.error.path).toBe('policyRef');
    }
  });

  it('rejects a command name outside the grammar', () => {
    const parsed = parseActionDescriptor({ ...baseDescriptor, commandName: 'not-a-name' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('invalid-value');
  });

  it('rejects an action class outside the closed vocabulary', () => {
    const parsed = parseActionDescriptor({ ...baseDescriptor, actionClass: 'undoable' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.path).toBe('actionClass');
    }
  });

  it('rejects an actor kind outside the contracts vocabulary', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actorKinds: ['user', 'robot'],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('actorKinds[1]');
  });

  it('rejects duplicate actor kinds', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actorKinds: ['user', 'user'],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.received).toContain('user');
    }
  });

  it('rejects an undeclared capability (closed vocabulary)', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      requiredCapabilities: ['cost.read', 'teleport.write'],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('requiredCapabilities[1]');
  });

  it('rejects duplicate capabilities', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      requiredCapabilities: ['cost.read', 'cost.read'],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.received).toContain('cost.read');
    }
  });

  it('rejects a confidence level outside the closed vocabulary', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      requiredConfidence: 'absolute',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('requiredConfidence');
  });

  it('rejects an invalid resource kind', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      resourceKind: 'Cost Item',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('resourceKind');
  });

  it('rejects duplicate evidence requirement slots', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      evidenceRequirements: [
        { slot: 'justification', description: 'Why.' },
        { slot: 'justification', description: 'Again.' },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.received).toContain('justification');
    }
  });
});

describe('ActionDescriptor structural class rules (fail-closed)', () => {
  it('rejects an empty actor-kind list for a non-prohibited class', () => {
    const parsed = parseActionDescriptor({ ...baseDescriptor, actorKinds: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.path).toBe('actorKinds');
    }
  });

  it("rejects a non-empty actor-kind list for a 'prohibited' action", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'prohibited',
      actorKinds: ['user'],
      requiredCapabilities: [],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.path).toBe('actorKinds');
    }
  });

  it('rejects an empty capability list for a non-prohibited class', () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      requiredCapabilities: [],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('requiredCapabilities');
  });

  it("rejects a write capability on a 'read' action", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      requiredCapabilities: ['cost.read', 'cost.write'],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.received).toContain('cost.write');
    }
  });

  it("rejects a 'reversible' action without a write capability", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'reversible',
      requiredCapabilities: ['cost.read'],
      compensatingCommand: 'cost.correctEntry',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.received).toContain('no write capability');
    }
  });

  it("rejects an 'approval-required' action without a write capability", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'approval-required',
      requiredCapabilities: ['cost.read'],
      approval: {
        definitionKey: 'action-approval',
        approvalKey: 'action',
        requiredCapability: 'cost.write',
        policyRef: 'policy/budget-revisions@2',
      },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.received).toContain('no write capability');
  });

  it("rejects a 'reversible' action without a compensating command", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'reversible',
      requiredCapabilities: ['cost.write'],
      compensatingCommand: null,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('compensatingCommand');
  });

  it("rejects a compensating command on a 'read' action", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      compensatingCommand: 'cost.correctEntry',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('compensatingCommand');
  });

  it("rejects a compensating command on a 'prohibited' action", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'prohibited',
      actorKinds: [],
      requiredCapabilities: [],
      compensatingCommand: 'cost.correctEntry',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('compensatingCommand');
  });

  it("rejects an 'approval-required' action without approval routing", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'approval-required',
      requiredCapabilities: ['cost.write'],
      approval: null,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('approval');
  });

  it('rejects approval routing on every other class', () => {
    for (const actionClass of ['read', 'reversible', 'prohibited'] as const) {
      const parsed = parseActionDescriptor({
        ...baseDescriptor,
        actionClass,
        ...(actionClass === 'prohibited'
          ? { actorKinds: [] as readonly string[], requiredCapabilities: [] as readonly string[] }
          : {}),
        ...(actionClass === 'reversible'
          ? { requiredCapabilities: ['cost.write'], compensatingCommand: 'cost.correctEntry' }
          : {}),
        approval: {
          definitionKey: 'action-approval',
          approvalKey: 'action',
          requiredCapability: 'cost.write',
          policyRef: 'policy/budget-revisions@2',
        },
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.path).toBe('approval');
    }
  });

  it("rejects approval routing with an undeclared required capability", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'approval-required',
      requiredCapabilities: ['cost.write'],
      approval: {
        definitionKey: 'action-approval',
        approvalKey: 'action',
        requiredCapability: 'teleport.write',
        policyRef: 'policy/budget-revisions@2',
      },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('approval.requiredCapability');
  });

  it("accepts an 'approval-required' action with a compensating command", () => {
    const parsed = parseActionDescriptor({
      ...baseDescriptor,
      actionClass: 'approval-required',
      requiredCapabilities: ['cost.write'],
      compensatingCommand: 'cost.revertBudgetRevision',
      approval: {
        definitionKey: 'action-approval',
        approvalKey: 'action',
        requiredCapability: 'cost.write',
        policyRef: 'policy/budget-revisions@2',
      },
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('defineActionDescriptor (trusted path)', () => {
  it('returns the validated descriptor for valid input', () => {
    const descriptor = defineActionDescriptor(baseDescriptor);
    expect(descriptor.commandName).toBe('cost.listCostItems');
  });

  it('throws a loud TypeError for invalid input', () => {
    expect(() =>
      defineActionDescriptor({ ...baseDescriptor, actionClass: 'mystery' }),
    ).toThrow(TypeError);
  });
});
