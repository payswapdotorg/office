import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, CommandName, ParseResult, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  AMEND_COMMITMENT_COMMAND,
  CLOSE_COMMITMENT_COMMAND,
  CREATE_BUDGET_COMMAND,
  CREATE_COMMITMENT_COMMAND,
  RECORD_COST_ITEM_COMMAND,
  RECORD_INVOICE_COMMAND,
  REFERENCE_PAYMENT_COMMAND,
  REVISE_BUDGET_COMMAND,
  createCostCommands,
  parseAmendCommitmentPayload,
  parseCloseCommitmentPayload,
  parseCreateBudgetPayload,
  parseCreateCommitmentPayload,
  parseRecordCostItemPayload,
  parseRecordInvoicePayload,
  parseReferencePaymentPayload,
  parseReviseBudgetPayload,
} from './commands';
import type { CostCommandDeps, CostCommands } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryCostStore } from './store';
import type { InMemoryCostStore } from './store';

// OFF-011 cost domain — command payload parsing (fail-closed), the
// command-name guard, the authorization gates (including the DISTINCT
// stronger budget-revision capability), the A12 scope rules, optimistic
// concurrency, and the cross-aggregate commercial gates. All against the
// deterministic in-memory store: denied commands never open a transaction;
// failed mutations never change state.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const TENANT_B = formatTenantId({ version: 'v1', opaque: '9f8e7d6c5b4a30291827364554637281' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const OTHER_PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const ENTITY_ID = 'office-ent-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9' as const;
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const PAID_AT: Timestamp = unwrap(parseTimestamp('2026-09-12T09:00:00.000Z'));

const PROJECT_SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };
const TENANT_A_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_A };
const TENANT_B_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_B };
const OTHER_PROJECT_SCOPE: Scope = {
  kind: 'project',
  tenantId: TENANT_A,
  projectId: OTHER_PROJECT_ID,
};

let idempotencyCounter = 0;
const envelope = (
  payload: unknown,
  commandName: CommandName,
  scope: Scope = PROJECT_SCOPE,
): CommandEnvelope<unknown> => {
  idempotencyCounter += 1;
  return unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope,
      actor: { kind: 'user', actorId: ACTOR_ID },
      idempotencyKey: `idem-${String(idempotencyCounter).padStart(12, '0')}`,
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );
};

// The cost-area write gate every cost mutation requires: the rule scopes the
// cost.write capability to the cost domain's entity kinds (the closed
// resource vocabulary the handlers authorize against).
const COST_AREA_KINDS = [
  'budget',
  'cost-item',
  'budget-revision',
  'commitment',
  'commitment-amendment',
  'invoice',
  'payment-reference',
] as const;
const COST_WRITE_POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['cost.write'],
    actions: ['write'],
    resourceKinds: [...COST_AREA_KINDS],
  },
]);
// The DISTINCT stronger project-area write gate budget revisioning
// additionally requires (resource kind 'project').
const PROJECT_WRITE_POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['projects.write'],
    actions: ['write'],
    resourceKinds: ['project'],
  },
]);
const FULL_POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['cost.write'],
    actions: ['write'],
    resourceKinds: [...COST_AREA_KINDS],
  },
  {
    effect: 'allow',
    capabilities: ['projects.write'],
    actions: ['write'],
    resourceKinds: ['project'],
  },
]);

const costWriter = { policy: COST_WRITE_POLICY, capabilities: ['cost.write'] };
const budgetReviser = {
  policy: FULL_POLICY,
  capabilities: ['cost.write', 'projects.write'],
};

interface Harness {
  readonly store: InMemoryCostStore;
  readonly sink: InMemoryEventSink;
  readonly commands: CostCommands;
}

const makeHarness = (): Harness => {
  const store = createInMemoryCostStore();
  const sink = createInMemoryEventSink();
  let issued = 0;
  const deps: CostCommandDeps = {
    store,
    eventSink: sink,
    now: () => NOW,
    newOpaqueId: () => {
      issued += 1;
      return `c${String(issued).padStart(15, '0')}`;
    },
  };
  return { store, sink, commands: createCostCommands(deps) };
};

const createdBudget = async (harness: Harness): Promise<string> => {
  const result = await harness.commands.createBudget(
    envelope({ name: 'Riverside budget', currency: 'USD' }, CREATE_BUDGET_COMMAND),
    costWriter,
  );
  if (!result.ok) throw new Error(`createBudget failed: ${JSON.stringify(result.error)}`);
  return result.value.entityId;
};

const recordedCostItems = async (
  harness: Harness,
  budgetId: string,
): Promise<{ readonly conc: string; readonly steel: string }> => {
  let version = 1;
  const ids: string[] = [];
  for (const code of ['CONC', 'STEEL']) {
    const result = await harness.commands.recordCostItem(
      envelope(
        {
          budgetId,
          expectedVersion: version,
          code,
          description: `Cost item ${code}`,
          unit: 'lot',
          quantityMilli: 1000,
          unitRateMinor: 250000,
        },
        RECORD_COST_ITEM_COMMAND,
      ),
      costWriter,
    );
    if (!result.ok) {
      throw new Error(`recordCostItem failed: ${JSON.stringify(result.error)}`);
    }
    version = result.value.version;
    const id = Object.values(result.value.costItems).find((item) => item.code === code)?.entityId;
    if (id === undefined) throw new Error(`cost item ${code} missing`);
    ids.push(id);
  }
  const [conc, steel] = ids;
  if (conc === undefined || steel === undefined) throw new Error('cost item ids missing');
  return { conc, steel };
};

const createdCommitment = async (
  harness: Harness,
  budgetId: string,
  costItemIds: readonly string[],
): Promise<string> => {
  const result = await harness.commands.createCommitment(
    envelope(
      {
        budgetId,
        number: 'PO-0001',
        commitmentKind: 'purchase-order',
        description: 'Foundations package',
        currency: 'USD',
        lines: costItemIds.map((costItemId) => ({
          costItemId,
          description: 'Committed works',
          amountMinor: 100000,
        })),
      },
      CREATE_COMMITMENT_COMMAND,
    ),
    costWriter,
  );
  if (!result.ok) {
    throw new Error(`createCommitment failed: ${JSON.stringify(result.error)}`);
  }
  return result.value.entityId;
};

const recordedInvoice = async (
  harness: Harness,
  commitmentId: string,
): Promise<string> => {
  const result = await harness.commands.recordInvoice(
    envelope(
      {
        commitmentId,
        number: 'INV-0001',
        description: 'Foundations billing',
        currency: 'USD',
        lines: [{ description: 'Progress billing 1', amountMinor: 100000 }],
      },
      RECORD_INVOICE_COMMAND,
    ),
    costWriter,
  );
  if (!result.ok) throw new Error(`recordInvoice failed: ${JSON.stringify(result.error)}`);
  return result.value.entityId;
};

// ----- payload parsing (fail-closed) ---------------------------------------------------

describe('createBudget payload parsing (fail-closed)', () => {
  it('parses a minimal valid payload', () => {
    const result = parseCreateBudgetPayload({ name: 'Riverside budget', currency: 'USD' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual({ name: 'Riverside budget', currency: 'USD' });
    }
  });

  it('parses an explicit projectId', () => {
    const result = parseCreateBudgetPayload({
      name: 'Riverside budget',
      currency: 'USD',
      projectId: PROJECT_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.projectId).toBe(PROJECT_ID);
  });

  it('rejects a malformed currency (fail-closed, three uppercase letters)', () => {
    for (const currency of ['usd', 'US', 'USDD', 42]) {
      const result = parseCreateBudgetPayload({ name: 'X', currency });
      expect(result.ok, `currency ${JSON.stringify(currency)}`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-value');
    }
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseCreateBudgetPayload({ name: 'X', currency: 'USD', code: 'B-01' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects a non-object payload root', () => {
    const result = parseCreateBudgetPayload('budget');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });
});

describe('recordCostItem payload parsing (fail-closed)', () => {
  const valid = {
    budgetId: ENTITY_ID,
    expectedVersion: 1,
    code: 'CONC',
    description: 'Concrete works',
    unit: 'lot',
    quantityMilli: 1000,
    unitRateMinor: 250000,
  };

  it('parses a valid payload', () => {
    const result = parseRecordCostItemPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.code).toBe('CONC');
  });

  it('rejects a non-integer quantity (money never floats)', () => {
    const result = parseRecordCostItemPayload({ ...valid, quantityMilli: 2.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a non-integer unit rate', () => {
    const result = parseRecordCostItemPayload({ ...valid, unitRateMinor: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a malformed budget id', () => {
    const result = parseRecordCostItemPayload({ ...valid, budgetId: 'not-canonical' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a missing field', () => {
    const result = parseRecordCostItemPayload({ ...valid, unit: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

describe('reviseBudget payload parsing (fail-closed)', () => {
  it('parses without a label (label undefined, deterministic default later)', () => {
    const result = parseReviseBudgetPayload({ budgetId: ENTITY_ID, expectedVersion: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.label).toBeUndefined();
  });

  it('parses an explicit label', () => {
    const result = parseReviseBudgetPayload({
      budgetId: ENTITY_ID,
      expectedVersion: 3,
      label: 'Owner change order',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.label).toBe('Owner change order');
  });

  it('rejects an empty label', () => {
    const result = parseReviseBudgetPayload({
      budgetId: ENTITY_ID,
      expectedVersion: 3,
      label: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('createCommitment payload parsing (fail-closed)', () => {
  const valid = {
    budgetId: ENTITY_ID,
    number: 'PO-0001',
    commitmentKind: 'purchase-order',
    description: 'Foundations package',
    currency: 'USD',
    lines: [{ costItemId: ENTITY_ID, description: 'Concrete', amountMinor: 100000 }],
  };

  it('parses a valid payload', () => {
    const result = parseCreateCommitmentPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commitmentKind).toBe('purchase-order');
      expect(result.value.lines).toHaveLength(1);
    }
  });

  it('rejects a commitment kind outside the closed canonical vocabulary', () => {
    for (const commitmentKind of ['framework-order', 'change-order', 'po']) {
      const result = parseCreateCommitmentPayload({ ...valid, commitmentKind });
      expect(result.ok, `commitmentKind '${commitmentKind}'`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-value');
    }
  });

  it('rejects a non-array lines field', () => {
    const result = parseCreateCommitmentPayload({ ...valid, lines: 'none' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });

  it('rejects an empty lines array (a commitment commits at least one line)', () => {
    const result = parseCreateCommitmentPayload({ ...valid, lines: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an unknown key inside a line object (nested strict keys)', () => {
    const result = parseCreateCommitmentPayload({
      ...valid,
      lines: [{ costItemId: ENTITY_ID, description: 'Concrete', amountMinor: 1, rate: 2 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('amendCommitment payload parsing (fail-closed)', () => {
  const valid = {
    commitmentId: ENTITY_ID,
    expectedVersion: 2,
    budgetId: ENTITY_ID,
    reason: 'Scope added',
    lines: [{ costItemId: ENTITY_ID, description: 'Concrete', amountMinor: 100000 }],
  };

  it('parses a valid payload with a nullable reason', () => {
    const result = parseAmendCommitmentPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBe('Scope added');
  });

  it('parses an absent reason as null', () => {
    const result = parseAmendCommitmentPayload({
      commitmentId: ENTITY_ID,
      expectedVersion: 2,
      budgetId: ENTITY_ID,
      lines: valid.lines,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBeNull();
  });

  it('rejects a missing budgetId (the cross-aggregate gate needs it)', () => {
    const result = parseAmendCommitmentPayload({
      commitmentId: ENTITY_ID,
      expectedVersion: 2,
      lines: valid.lines,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

describe('closeCommitment payload parsing (fail-closed)', () => {
  it('parses a valid payload', () => {
    const result = parseCloseCommitmentPayload({
      commitmentId: ENTITY_ID,
      expectedVersion: 3,
      reason: 'Cancelled by owner',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBe('Cancelled by owner');
  });

  it('rejects a missing reason', () => {
    const result = parseCloseCommitmentPayload({
      commitmentId: ENTITY_ID,
      expectedVersion: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

describe('recordInvoice payload parsing (fail-closed)', () => {
  const valid = {
    commitmentId: ENTITY_ID,
    number: 'INV-0001',
    description: 'Foundations billing',
    currency: 'USD',
    lines: [{ description: 'Progress billing 1', amountMinor: 100000 }],
  };

  it('parses a valid payload with optional dates', () => {
    const result = parseRecordInvoicePayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.issuedOn).toBeNull();
      expect(result.value.dueOn).toBeNull();
    }
  });

  it('parses issue/due dates and accepts a null due date', () => {
    const result = parseRecordInvoicePayload({
      ...valid,
      issuedOn: '2026-09-12T10:15:31.000Z',
      dueOn: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dueOn).toBeNull();
  });

  it('rejects a due date before the issue date', () => {
    const result = parseRecordInvoicePayload({
      ...valid,
      issuedOn: '2026-09-13T09:00:00.000Z',
      dueOn: '2026-09-12T09:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('dueOn');
    }
  });

  it('rejects a malformed timestamp', () => {
    const result = parseRecordInvoicePayload({
      ...valid,
      issuedOn: '2026-09-12 10:15',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('referencePayment payload parsing (fail-closed)', () => {
  const valid = {
    invoiceId: ENTITY_ID,
    expectedVersion: 1,
    reference: 'CHK-1001',
    amountMinor: 100000,
    paidAt: '2026-09-12T09:00:00.000Z',
  };

  it('parses a valid payload', () => {
    const result = parseReferencePaymentPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reference).toBe('CHK-1001');
  });

  it('rejects a zero paid amount (a payment reference records money moved)', () => {
    const result = parseReferencePaymentPayload({ ...valid, amountMinor: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a malformed reference string', () => {
    const result = parseReferencePaymentPayload({ ...valid, reference: '#1001' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a malformed paidAt timestamp', () => {
    const result = parseReferencePaymentPayload({ ...valid, paidAt: 'yesterday' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

// ----- command-name guard + authorization ----------------------------------------------

describe('command-name guard (trusted path, loud)', () => {
  it('rejects an envelope of another command kind with a TypeError', async () => {
    const harness = makeHarness();
    const wrongEnvelope = envelope(
      { name: 'Riverside budget', currency: 'USD' },
      RECORD_COST_ITEM_COMMAND,
    );
    await expect(
      harness.commands.createBudget(wrongEnvelope, costWriter),
    ).rejects.toThrow(TypeError);
    expect(harness.store.transactionCount).toBe(0);
  });
});

describe('authorization (deny-by-default, before any transaction)', () => {
  it('denies without the required capability and never opens a transaction', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope({ name: 'Riverside budget', currency: 'USD' }, CREATE_BUDGET_COMMAND),
      { policy: definePolicy([]), capabilities: [] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
      expect(result.error.scope).toStrictEqual(PROJECT_SCOPE);
    }
    expect(harness.store.transactionCount).toBe(0);
    expect(harness.store.budgets).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(0);
  });

  it('denies through an explicit deny rule even with the capability granted', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope({ name: 'Riverside budget', currency: 'USD' }, CREATE_BUDGET_COMMAND),
      {
        policy: definePolicy([
          {
            effect: 'deny',
            capabilities: ['cost.write'],
            actions: ['write'],
            resourceKinds: ['budget'],
          },
          {
            effect: 'allow',
            capabilities: ['cost.write'],
            actions: ['write'],
            resourceKinds: ['budget'],
          },
        ]),
        capabilities: ['cost.write'],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
    expect(harness.store.transactionCount).toBe(0);
  });

  it('rejects an undeclared capability name loudly (trusted path)', async () => {
    const harness = makeHarness();
    await expect(
      harness.commands.createBudget(
        envelope({ name: 'Riverside budget', currency: 'USD' }, CREATE_BUDGET_COMMAND),
        { policy: definePolicy([]), capabilities: ['cost.administer'] },
      ),
    ).rejects.toThrow(TypeError);
    expect(harness.store.transactionCount).toBe(0);
  });

  it('succeeds WITH the required capability (typed result, stored state)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope({ name: 'Riverside budget', currency: 'USD' }, CREATE_BUDGET_COMMAND),
      costWriter,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('Riverside budget');
      expect(result.value.scope).toStrictEqual(PROJECT_SCOPE);
      expect(result.value.version).toBe(1);
    }
    expect(harness.store.budgets).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(1);
  });
});

describe('budget-revision authorization (a DISTINCT stronger capability)', () => {
  const withItems = async (harness: Harness): Promise<string> => {
    const budgetId = await createdBudget(harness);
    await recordedCostItems(harness, budgetId);
    return budgetId;
  };

  it('denies revising to an actor holding only the cost-write capability', async () => {
    const harness = makeHarness();
    const budgetId = await withItems(harness);
    const eventsBefore = harness.sink.events.length;
    const transactionsBefore = harness.store.transactionCount;
    const result = await harness.commands.reviseBudget(
      envelope({ budgetId, expectedVersion: 3 }, REVISE_BUDGET_COMMAND),
      // Both authorization gates run BEFORE the transaction opens; the
      // second (project-area write) gate rejects the cost-only actor.
      { policy: FULL_POLICY, capabilities: ['cost.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
    // A denied command never opens a transaction and never mutates.
    expect(harness.store.transactionCount).toBe(transactionsBefore);
    expect(harness.store.budgets[0]?.currentRevisionId).toBeNull();
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });

  it('denies revising when the cost gate alone passes but the project gate is absent', async () => {
    const harness = makeHarness();
    const budgetId = await withItems(harness);
    const result = await harness.commands.reviseBudget(
      envelope({ budgetId, expectedVersion: 3 }, REVISE_BUDGET_COMMAND),
      // The policy grants only the cost area; the projects.write gate has no
      // matching rule for this actor.
      { policy: COST_WRITE_POLICY, capabilities: ['cost.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(harness.store.budgets[0]?.currentRevisionId).toBeNull();
  });

  it('succeeds with BOTH capabilities while payments need only the cost one', async () => {
    const harness = makeHarness();
    const budgetId = await withItems(harness);
    const budget = harness.store.budgets[0];
    if (budget === undefined) throw new Error('budget missing');
    const concId = Object.values(budget.costItems).find((item) => item.code === 'CONC')?.entityId;
    if (concId === undefined) throw new Error('CONC missing');

    const commitmentId = await createdCommitment(harness, budgetId, [concId]);
    const invoiceId = await recordedInvoice(harness, commitmentId);

    // Payment referencing: the cost-write capability alone is sufficient.
    const payment = await harness.commands.referencePayment(
      envelope(
        {
          invoiceId,
          expectedVersion: 1,
          reference: 'CHK-1001',
          amountMinor: 100000,
          paidAt: PAID_AT,
        },
        REFERENCE_PAYMENT_COMMAND,
      ),
      costWriter,
    );
    expect(payment.ok).toBe(true);

    // Budget revision: BOTH gates must pass.
    const revised = await harness.commands.reviseBudget(
      envelope(
        { budgetId, expectedVersion: budget.version, label: 'Owner change order' },
        REVISE_BUDGET_COMMAND,
      ),
      budgetReviser,
    );
    expect(revised.ok).toBe(true);
    if (revised.ok) {
      expect(revised.value.currentRevisionId).not.toBeNull();
      expect(Object.keys(revised.value.revisions)).toHaveLength(1);
    }
  });

  it('an actor with only the project-write capability cannot mutate the cost model', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const result = await harness.commands.recordCostItem(
      envelope(
        {
          budgetId,
          expectedVersion: 1,
          code: 'CONC',
          description: 'Concrete works',
          unit: 'lot',
          quantityMilli: 1000,
          unitRateMinor: 250000,
        },
        RECORD_COST_ITEM_COMMAND,
      ),
      { policy: PROJECT_WRITE_POLICY, capabilities: ['projects.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden');
    expect(harness.store.budgets[0]?.costItems ?? {}).toStrictEqual({});
  });
});

describe('command name constants', () => {
  it('declares the eight mutation command names', () => {
    expect(CREATE_BUDGET_COMMAND).toBe('cost.createBudget');
    expect(RECORD_COST_ITEM_COMMAND).toBe('cost.recordCostItem');
    expect(REVISE_BUDGET_COMMAND).toBe('cost.reviseBudget');
    expect(CREATE_COMMITMENT_COMMAND).toBe('cost.createCommitment');
    expect(AMEND_COMMITMENT_COMMAND).toBe('cost.amendCommitment');
    expect(CLOSE_COMMITMENT_COMMAND).toBe('cost.closeCommitment');
    expect(RECORD_INVOICE_COMMAND).toBe('cost.recordInvoice');
    expect(REFERENCE_PAYMENT_COMMAND).toBe('cost.referencePayment');
  });
});

// ----- createBudget scope rules --------------------------------------------------------

describe('createBudget scope rules (one budget per project)', () => {
  it('requires a projectId under tenant scope', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope({ name: 'Unnamed budget', currency: 'USD' }, CREATE_BUDGET_COMMAND, TENANT_A_SCOPE),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
    }
    expect(harness.store.budgets).toHaveLength(0);
  });

  it('creates under tenant scope with an explicit projectId', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope(
        { name: 'Riverside budget', currency: 'USD', projectId: PROJECT_ID },
        CREATE_BUDGET_COMMAND,
        TENANT_A_SCOPE,
      ),
      costWriter,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scope).toStrictEqual(PROJECT_SCOPE);
  });

  it('rejects a project-scoped create naming a DIFFERENT project (typed unauthorized)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope(
        { name: 'Foreign budget', currency: 'USD', projectId: OTHER_PROJECT_ID },
        CREATE_BUDGET_COMMAND,
        PROJECT_SCOPE,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-violation');
    }
    expect(harness.store.budgets).toHaveLength(0);
  });

  it('rejects a SECOND budget for the same project (one canonical budget)', async () => {
    const harness = makeHarness();
    await createdBudget(harness);
    const result = await harness.commands.createBudget(
      envelope({ name: 'Duplicate budget', currency: 'USD' }, CREATE_BUDGET_COMMAND, PROJECT_SCOPE),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('budget-project-has-one-budget');
    }
    expect(harness.store.budgets).toHaveLength(1);
  });
});

// ----- malformed payload through the command path --------------------------------------

describe('malformed payloads through the command path (fail-closed)', () => {
  it('a malformed payload is a typed invariant-violation and never mutates', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope({ name: 'X', currency: 'DOLLARS' }, CREATE_BUDGET_COMMAND),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
      expect(result.error.message).toContain('cost.createBudget');
    }
    expect(harness.store.budgets).toHaveLength(0);
    expect(harness.store.transactionCount).toBe(0);
  });

  it('an unknown payload key is rejected typed (strict keys)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createBudget(
      envelope(
        { name: 'X', currency: 'USD', exchangeRate: 1.2 },
        CREATE_BUDGET_COMMAND,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
    }
    expect(harness.store.budgets).toHaveLength(0);
  });
});

// ----- cross-aggregate commercial gates ------------------------------------------------

describe('cross-aggregate commercial gates (typed invariant-violations)', () => {
  it('rejects a commitment line referencing an unknown cost item', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const result = await harness.commands.createCommitment(
      envelope(
        {
          budgetId,
          number: 'PO-0001',
          commitmentKind: 'purchase-order',
          description: 'Foundations package',
          currency: 'USD',
          lines: [
            { costItemId: ENTITY_ID, description: 'Unknown item', amountMinor: 100000 },
          ],
        },
        CREATE_COMMITMENT_COMMAND,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('commitment-line-cost-item-exists');
    }
    expect(harness.store.commitments).toHaveLength(0);
  });

  it('rejects a commitment whose currency does not match the budget', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const items = await recordedCostItems(harness, budgetId);
    const result = await harness.commands.createCommitment(
      envelope(
        {
          budgetId,
          number: 'PO-0001',
          commitmentKind: 'purchase-order',
          description: 'Foundations package',
          currency: 'EUR',
          lines: [
            { costItemId: items.conc, description: 'Concrete', amountMinor: 100000 },
          ],
        },
        CREATE_COMMITMENT_COMMAND,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('cost-currency-consistent');
    }
    expect(harness.store.commitments).toHaveLength(0);
  });

  it('rejects an invoice against a CLOSED commitment (closed is terminal)', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const items = await recordedCostItems(harness, budgetId);
    const commitmentId = await createdCommitment(harness, budgetId, [items.conc]);
    const closed = await harness.commands.closeCommitment(
      envelope(
        { commitmentId, expectedVersion: 1, reason: 'Cancelled by owner' },
        CLOSE_COMMITMENT_COMMAND,
      ),
      costWriter,
    );
    expect(closed.ok).toBe(true);

    const result = await harness.commands.recordInvoice(
      envelope(
        {
          commitmentId,
          number: 'INV-0001',
          description: 'Late billing',
          currency: 'USD',
          lines: [{ description: 'Billing', amountMinor: 100000 }],
        },
        RECORD_INVOICE_COMMAND,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('invoice-commitment-active');
    }
    expect(harness.store.invoices).toHaveLength(0);
  });

  it('rejects an over-paying payment reference (not-overpaid, state unchanged)', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const items = await recordedCostItems(harness, budgetId);
    const commitmentId = await createdCommitment(harness, budgetId, [items.conc]);
    const invoiceId = await recordedInvoice(harness, commitmentId);
    const eventsBefore = harness.sink.events.length;

    // The invoice total is 100000; referencing 100001 overpays it.
    const result = await harness.commands.referencePayment(
      envelope(
        {
          invoiceId,
          expectedVersion: 1,
          reference: 'CHK-1001',
          amountMinor: 100001,
          paidAt: PAID_AT,
        },
        REFERENCE_PAYMENT_COMMAND,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('invoice-not-overpaid');
    }
    expect(harness.store.invoices[0]?.paymentReferences ?? []).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });

  it('rejects a payment instant in the future relative to the recording instant', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const items = await recordedCostItems(harness, budgetId);
    const commitmentId = await createdCommitment(harness, budgetId, [items.conc]);
    const invoiceId = await recordedInvoice(harness, commitmentId);
    const result = await harness.commands.referencePayment(
      envelope(
        {
          invoiceId,
          expectedVersion: 1,
          reference: 'CHK-FUTURE',
          amountMinor: 1000,
          paidAt: '2026-09-12T11:00:00.000Z',
        },
        REFERENCE_PAYMENT_COMMAND,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('payment-referenced-not-future');
    }
    expect(harness.store.invoices[0]?.paymentReferences ?? []).toHaveLength(0);
  });
});

// ----- A12 isolation through the scoped store ------------------------------------------

describe('cross-tenant and cross-project isolation (A12, both directions)', () => {
  const harnessWithCostModel = async (): Promise<{
    readonly harness: Harness;
    readonly budgetId: string;
    readonly commitmentId: string;
    readonly invoiceId: string;
  }> => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const items = await recordedCostItems(harness, budgetId);
    const commitmentId = await createdCommitment(harness, budgetId, [items.conc]);
    const invoiceId = await recordedInvoice(harness, commitmentId);
    return { harness, budgetId, commitmentId, invoiceId };
  };

  it('a foreign tenant sees the budget as a typed not-found (no existence oracle)', async () => {
    const { harness, budgetId } = await harnessWithCostModel();
    const eventsBefore = harness.sink.events.length;
    const result = await harness.commands.recordCostItem(
      envelope(
        {
          budgetId,
          expectedVersion: 3,
          code: 'NEW',
          description: 'Foreign item',
          unit: 'lot',
          quantityMilli: 1000,
          unitRateMinor: 100000,
        },
        RECORD_COST_ITEM_COMMAND,
        TENANT_B_SCOPE,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('entity-not-found');
    }
    // The mutation was rolled back: state and event log unchanged.
    expect(harness.store.budgets).toHaveLength(1);
    expect(Object.keys(harness.store.budgets[0]?.costItems ?? {})).toHaveLength(2);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });

  it('a foreign tenant sees the commitment and invoice as typed not-found', async () => {
    const { harness, commitmentId, invoiceId } = await harnessWithCostModel();
    const amend = await harness.commands.amendCommitment(
      envelope(
        {
          commitmentId,
          expectedVersion: 1,
          budgetId: harness.store.budgets[0]?.entityId ?? 'missing',
          lines: [
            {
              costItemId: Object.values(harness.store.budgets[0]?.costItems ?? {})[0]?.entityId ?? 'missing',
              description: 'Amended',
              amountMinor: 50000,
            },
          ],
        },
        AMEND_COMMITMENT_COMMAND,
        TENANT_B_SCOPE,
      ),
      costWriter,
    );
    expect(amend.ok).toBe(false);
    if (!amend.ok) expect(amend.error.code).toBe('not-found');

    const payment = await harness.commands.referencePayment(
      envelope(
        {
          invoiceId,
          expectedVersion: 1,
          reference: 'CHK-1001',
          amountMinor: 1000,
          paidAt: PAID_AT,
        },
        REFERENCE_PAYMENT_COMMAND,
        TENANT_B_SCOPE,
      ),
      costWriter,
    );
    expect(payment.ok).toBe(false);
    if (!payment.ok) expect(payment.error.code).toBe('not-found');
    expect(harness.store.commitments[0]?.lineSets ?? []).toHaveLength(1);
    expect(harness.store.invoices[0]?.paymentReferences ?? []).toHaveLength(0);
  });

  it('a foreign project under the SAME tenant sees the budget as a typed not-found', async () => {
    const { harness, budgetId } = await harnessWithCostModel();
    const result = await harness.commands.reviseBudget(
      envelope({ budgetId, expectedVersion: 3 }, REVISE_BUDGET_COMMAND, OTHER_PROJECT_SCOPE),
      budgetReviser,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    expect(harness.store.budgets[0]?.currentRevisionId).toBeNull();
  });

  it('the REVERSE direction: tenant A cannot see tenant B\'s budget either', async () => {
    // Tenant B builds its own budget under its own project.
    const harness = makeHarness();
    const tenantBProject = formatProjectId({
      version: 'v1',
      opaque: '7777666688889999aaaa8888ccccdddd',
    });
    const tenantBProjectScope: Scope = {
      kind: 'project',
      tenantId: TENANT_B,
      projectId: tenantBProject,
    };
    const created = await harness.commands.createBudget(
      envelope(
        { name: 'Competitor budget', currency: 'USD' },
        CREATE_BUDGET_COMMAND,
        tenantBProjectScope,
      ),
      costWriter,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('tenant B createBudget failed');
    const foreignBudgetId = created.value.entityId;

    // Tenant A, holding the same capability, reads it as not-found.
    const result = await harness.commands.recordCostItem(
      envelope(
        {
          budgetId: foreignBudgetId,
          expectedVersion: 1,
          code: 'SPY',
          description: 'Cross-tenant probe',
          unit: 'lot',
          quantityMilli: 1000,
          unitRateMinor: 100000,
        },
        RECORD_COST_ITEM_COMMAND,
        PROJECT_SCOPE,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('entity-not-found');
    }
    expect(Object.keys(harness.store.budgets[0]?.costItems ?? {})).toHaveLength(0);
  });

  it('a commitment cannot be created against a foreign budget through a project-scoped command', async () => {
    const { harness, budgetId } = await harnessWithCostModel();
    const result = await harness.commands.createCommitment(
      envelope(
        {
          budgetId,
          number: 'PO-0002',
          commitmentKind: 'subcontract',
          description: 'Foreign commitment',
          currency: 'USD',
          lines: [
            {
              costItemId: Object.values(harness.store.budgets[0]?.costItems ?? {})[0]?.entityId ?? 'missing',
              description: 'Line',
              amountMinor: 1000,
            },
          ],
        },
        CREATE_COMMITMENT_COMMAND,
        OTHER_PROJECT_SCOPE,
      ),
      costWriter,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    expect(harness.store.commitments).toHaveLength(1);
  });
});

// ----- optimistic concurrency ------------------------------------------------------------

describe('optimistic concurrency (stale versions never overwrite the commercial state)', () => {
  it('rejects a stale expected version with a typed concurrency-conflict', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const first = await harness.commands.recordCostItem(
      envelope(
        {
          budgetId,
          expectedVersion: 1,
          code: 'CONC',
          description: 'Concrete works',
          unit: 'lot',
          quantityMilli: 1000,
          unitRateMinor: 250000,
        },
        RECORD_COST_ITEM_COMMAND,
      ),
      costWriter,
    );
    if (!first.ok) throw new Error('first recordCostItem failed');
    const eventsBefore = harness.sink.events.length;

    // A second writer holding the STALE version 1 (the first writer already
    // moved the root to version 2).
    const stale = await harness.commands.recordCostItem(
      envelope(
        {
          budgetId,
          expectedVersion: 1,
          code: 'STEEL',
          description: 'Steel supply',
          unit: 'ton',
          quantityMilli: 1000,
          unitRateMinor: 50000,
        },
        RECORD_COST_ITEM_COMMAND,
      ),
      costWriter,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('concurrency-conflict');
      expect(stale.error.details[0]?.code).toBe('stale-aggregate-version');
    }
    // State unchanged; no partial overwrite; no event appended.
    expect(harness.store.budgets[0]?.version).toBe(2);
    expect(Object.keys(harness.store.budgets[0]?.costItems ?? {})).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });

  it('rejects a stale commitment amendment the same typed way', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const items = await recordedCostItems(harness, budgetId);
    const commitmentId = await createdCommitment(harness, budgetId, [items.conc]);
    const amended = await harness.commands.amendCommitment(
      envelope(
        {
          commitmentId,
          expectedVersion: 1,
          budgetId,
          lines: [
            { costItemId: items.steel, description: 'Steel', amountMinor: 50000 },
          ],
        },
        AMEND_COMMITMENT_COMMAND,
      ),
      costWriter,
    );
    expect(amended.ok).toBe(true);
    // The amendment moved the commitment to version 2; a second writer
    // still holding version 1 is a typed concurrency-conflict.
    const stale = await harness.commands.amendCommitment(
      envelope(
        {
          commitmentId,
          expectedVersion: 1,
          budgetId,
          lines: [
            { costItemId: items.conc, description: 'Concrete again', amountMinor: 60000 },
          ],
        },
        AMEND_COMMITMENT_COMMAND,
      ),
      costWriter,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('concurrency-conflict');
      expect(stale.error.details[0]?.code).toBe('stale-aggregate-version');
    }
    expect(harness.store.commitments[0]?.lineSets ?? []).toHaveLength(2);
    expect(harness.store.commitments[0]?.version).toBe(2);
  });

  it('accepts the mutation at the current version after the conflict', async () => {
    const harness = makeHarness();
    const budgetId = await createdBudget(harness);
    const retry = await harness.commands.recordCostItem(
      envelope(
        {
          budgetId,
          expectedVersion: 1,
          code: 'CONC',
          description: 'Concrete works',
          unit: 'lot',
          quantityMilli: 1000,
          unitRateMinor: 250000,
        },
        RECORD_COST_ITEM_COMMAND,
      ),
      costWriter,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.version).toBe(2);
  });
});
