import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  DomainEventEnvelope,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import { committedVsBudget, costPosition } from './balances';
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
} from './commands';
import type { CostCommandDeps, CostCommands } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryCostStore } from './store';
import type { InMemoryCostStore } from './store';
import type { BudgetState, CommitmentState } from './state';

// OFF-011 cost domain — the full in-memory acceptance suite: the whole
// commercial mutation lifecycle through the command service (budget → cost
// items → revision → commitments → amendment → invoice → payment → close),
// audit events through the EventSink on every mutation (scope, actor, source
// 'domain', correlation/causation propagated from the command envelope,
// before/after entity refs, owning aggregate-root id in every payload),
// budget-revision immutability under later history, the failing-sink abort,
// deterministic balance recomputation from the CURRENT revision, and
// deterministic end-to-end replay of the identical command sequence. No I/O,
// fixed clock and id suppliers.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const mustSucceed = <T, E>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
  what: string,
): T => {
  if (!result.ok) {
    throw new Error(`${what} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const PAID_AT: Timestamp = unwrap(parseTimestamp('2026-09-11T09:00:00.000Z'));

const PROJECT_SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };

// Kind-scoped policy: cost.write over the cost entity kinds, plus the
// distinct stronger projects.write gate budget revisioning requires.
const POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['cost.write'],
    actions: ['write'],
    resourceKinds: [
      'budget',
      'cost-item',
      'budget-revision',
      'commitment',
      'commitment-amendment',
      'invoice',
      'payment-reference',
    ],
  },
  {
    effect: 'allow',
    capabilities: ['projects.write'],
    actions: ['write'],
    resourceKinds: ['project'],
  },
]);
const COST_MANAGER = { policy: POLICY, capabilities: ['cost.write'] };
const BUDGET_REVISER = { policy: POLICY, capabilities: ['cost.write', 'projects.write'] };

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

let envelopeCounter = 0;
const envelope = (
  payload: unknown,
  commandName: CommandName,
  scope: Scope = PROJECT_SCOPE,
): CommandEnvelope<unknown> => {
  envelopeCounter += 1;
  return unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope,
      actor: { kind: 'user', actorId: ACTOR_ID },
      idempotencyKey: `idem-${String(envelopeCounter).padStart(12, '0')}`,
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );
};

/**
 * The canonical commercial lifecycle: one command per mutation, expected
 * versions chained. Ten mutations — budget, two cost items, a budget
 * revision, two commitments (one amended), an invoice, a payment reference,
 * and a close.
 */
const runLifecycleAsync = async (
  harness: Harness,
): Promise<{
  readonly budgetId: string;
  readonly concItemId: string;
  readonly steelItemId: string;
  readonly purchaseOrderId: string;
  readonly finalBudget: BudgetState;
  readonly finalPurchaseOrder: CommitmentState;
}> => {
  const created = mustSucceed(
    await harness.commands.createBudget(
      envelope({ name: 'Riverside budget', currency: 'USD' }, CREATE_BUDGET_COMMAND),
      COST_MANAGER,
    ),
    'createBudget',
  );
  const budgetId = created.entityId;
  let budgetVersion = created.version;

  const recordItem = async (code: string, quantityMilli: number, unitRateMinor: number) => {
    const state = mustSucceed(
      await harness.commands.recordCostItem(
        envelope(
          {
            budgetId,
            expectedVersion: budgetVersion,
            code,
            description: `Cost item ${code}`,
            unit: 'lot',
            quantityMilli,
            unitRateMinor,
          },
          RECORD_COST_ITEM_COMMAND,
        ),
        COST_MANAGER,
      ),
      `recordCostItem ${code}`,
    );
    budgetVersion = state.version;
    const itemId = Object.values(state.costItems).find((item) => item.code === code)?.entityId;
    if (itemId === undefined) throw new Error(`cost item ${code} id missing`);
    return itemId;
  };

  const concItemId = await recordItem('CONC', 1000, 250000);
  const steelItemId = await recordItem('STEEL', 5000, 10000);

  // The consequential re-anchoring decision: land revision 1.
  const revised = mustSucceed(
    await harness.commands.reviseBudget(
      envelope(
        { budgetId, expectedVersion: budgetVersion, label: 'Tender baseline' },
        REVISE_BUDGET_COMMAND,
      ),
      BUDGET_REVISER,
    ),
    'reviseBudget',
  );
  budgetVersion = revised.version;

  const purchaseOrder = mustSucceed(
    await harness.commands.createCommitment(
      envelope(
        {
          budgetId,
          number: 'PO-0001',
          commitmentKind: 'purchase-order',
          description: 'Foundations package',
          currency: 'USD',
          lines: [
            { costItemId: concItemId, description: 'Concrete works', amountMinor: 200000 },
            { costItemId: steelItemId, description: 'Steel supply', amountMinor: 30000 },
          ],
        },
        CREATE_COMMITMENT_COMMAND,
      ),
      COST_MANAGER,
    ),
    'createCommitment PO-0001',
  );
  const purchaseOrderId = purchaseOrder.entityId;

  const amended = mustSucceed(
    await harness.commands.amendCommitment(
      envelope(
        {
          commitmentId: purchaseOrderId,
          expectedVersion: purchaseOrder.version,
          budgetId,
          reason: 'Scope added after site survey',
          lines: [
            { costItemId: concItemId, description: 'Concrete works', amountMinor: 250000 },
            { costItemId: steelItemId, description: 'Steel supply', amountMinor: 40000 },
          ],
        },
        AMEND_COMMITMENT_COMMAND,
      ),
      COST_MANAGER,
    ),
    'amendCommitment PO-0001',
  );

  const invoice = mustSucceed(
    await harness.commands.recordInvoice(
      envelope(
        {
          commitmentId: purchaseOrderId,
          number: 'INV-0001',
          description: 'Foundations billing 1',
          currency: 'USD',
          issuedOn: '2026-09-12T10:15:31.000Z',
          dueOn: '2026-10-12T10:15:31.000Z',
          lines: [
            { description: 'Progress billing 1', amountMinor: 60000 },
            { description: 'Delivered materials', amountMinor: 40000 },
          ],
        },
        RECORD_INVOICE_COMMAND,
      ),
      COST_MANAGER,
    ),
    'recordInvoice INV-0001',
  );
  const invoiceId = invoice.entityId;

  mustSucceed(
    await harness.commands.referencePayment(
      envelope(
        {
          invoiceId,
          expectedVersion: invoice.version,
          reference: 'CHK-1001',
          amountMinor: 60000,
          paidAt: PAID_AT,
        },
        REFERENCE_PAYMENT_COMMAND,
      ),
      COST_MANAGER,
    ),
    'referencePayment',
  );

  const subcontract = mustSucceed(
    await harness.commands.createCommitment(
      envelope(
        {
          budgetId,
          number: 'SC-0001',
          commitmentKind: 'subcontract',
          description: 'Electrical subcontract',
          currency: 'USD',
          lines: [
            { costItemId: steelItemId, description: 'Sleeves and supports', amountMinor: 10000 },
          ],
        },
        CREATE_COMMITMENT_COMMAND,
      ),
      COST_MANAGER,
    ),
    'createCommitment SC-0001',
  );

  mustSucceed(
    await harness.commands.closeCommitment(
      envelope(
        {
          commitmentId: subcontract.entityId,
          expectedVersion: subcontract.version,
          reason: 'Back-charged and closed',
        },
        CLOSE_COMMITMENT_COMMAND,
      ),
      COST_MANAGER,
    ),
    'closeCommitment SC-0001',
  );

  const finalBudget = harness.store.budgets[0];
  if (finalBudget === undefined) throw new Error('final budget missing');

  return {
    budgetId,
    concItemId,
    steelItemId,
    purchaseOrderId,
    finalBudget,
    finalPurchaseOrder: amended,
  };
};

describe('the full commercial lifecycle (in-memory, one event per mutation)', () => {
  it('executes every command, bumps the ROOT versions per mutation, and appends exactly one audit event each', async () => {
    const harness = makeHarness();
    const { finalBudget, finalPurchaseOrder } = await runLifecycleAsync(harness);

    // Final budget: 2 working-set items + 1 landed revision; version 4 (one
    // per budget mutation: create + 2 items + 1 revision).
    expect(Object.keys(finalBudget.costItems)).toHaveLength(2);
    expect(Object.keys(finalBudget.revisions)).toHaveLength(1);
    expect(finalBudget.version).toBe(4);
    expect(finalBudget.currentRevisionId).not.toBeNull();
    expect(finalBudget.scope).toStrictEqual(PROJECT_SCOPE);

    // The purchase order carries its append-only chain: creation + amendment.
    expect(finalPurchaseOrder.lineSets).toHaveLength(2);
    expect(finalPurchaseOrder.version).toBe(2);
    expect(finalPurchaseOrder.status).toBe('active');

    // The subcontract is closed with its history intact.
    const subcontract = harness.store.commitments[1];
    if (subcontract === undefined) throw new Error('subcontract missing');
    expect(subcontract.status).toBe('closed');
    expect(subcontract.closeReason).toBe('Back-charged and closed');
    expect(subcontract.lineSets).toHaveLength(1);

    // The invoice carries one payment reference.
    const invoice = harness.store.invoices[0];
    if (invoice === undefined) throw new Error('invoice missing');
    expect(invoice.paymentReferences).toHaveLength(1);
    expect(invoice.paymentReferences[0]?.reference).toBe('CHK-1001');

    // One audit event per mutation, in mutation order.
    const names = harness.sink.events.map((event) => event.eventName);
    expect(names).toStrictEqual([
      'cost.budgetCreated',
      'cost.costItemRecorded',
      'cost.costItemRecorded',
      'cost.budgetRevised',
      'cost.commitmentCreated',
      'cost.commitmentAmended',
      'cost.invoiceRecorded',
      'cost.paymentReferenced',
      'cost.commitmentCreated',
      'cost.commitmentClosed',
    ]);
    expect(harness.sink.appends).toHaveLength(10);
    expect(harness.sink.events).toHaveLength(10);
  });

  it('every event carries the aggregate scope, actor, source domain, propagated causality, and before/after refs', async () => {
    const counterAtStart = envelopeCounter;
    const harness = makeHarness();
    const { budgetId, purchaseOrderId } = await runLifecycleAsync(harness);

    const events = harness.sink.events as readonly DomainEventEnvelope[];
    // The command envelopes used consecutive idempotency keys starting at the
    // test's own counter value; every event's causation id is its command's
    // idempotency key and the correlation id carries over from the chain.
    for (const [index, event] of events.entries()) {
      expect(event.kind).toBe('event');
      expect(event.scope).toStrictEqual(PROJECT_SCOPE);
      expect(event.actor).toStrictEqual({ kind: 'user', actorId: ACTOR_ID });
      expect(event.source).toBe('domain');
      expect(event.causality.correlationId).toBe('corr-0f1e2d3c4b5a');
      expect(event.causality.causationId).toBe(
        `idem-${String(counterAtStart + index + 1).padStart(12, '0')}`,
      );
      expect(event.schemaVersion).toBe('1.0.0');
      expect(event.occurredAt).toBe(NOW);
    }

    // Every cost event payload carries the OWNING aggregate-root id (the
    // ledger aggregate stream key): budget events the budgetId, commitment
    // events the commitmentId, invoice events the invoiceId.
    const budgetEvents = events.filter(
      (event) =>
        event.eventName === 'cost.budgetCreated' ||
        event.eventName === 'cost.costItemRecorded' ||
        event.eventName === 'cost.budgetRevised',
    );
    for (const event of budgetEvents) {
      expect((event.payload as { budgetId?: unknown }).budgetId).toBe(budgetId);
    }
    const commitmentEvents = events.filter(
      (event) =>
        event.eventName === 'cost.commitmentCreated' ||
        event.eventName === 'cost.commitmentAmended' ||
        event.eventName === 'cost.commitmentClosed',
    );
    for (const event of commitmentEvents) {
      expect((event.payload as { commitmentId?: unknown }).commitmentId).toBeDefined();
    }
    const invoiceEvents = events.filter(
      (event) =>
        event.eventName === 'cost.invoiceRecorded' ||
        event.eventName === 'cost.paymentReferenced',
    );
    for (const event of invoiceEvents) {
      expect((event.payload as { invoiceId?: unknown }).invoiceId).toBeDefined();
    }

    // Before/after refs follow the transition kinds.
    expect(events[0]?.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: 'budget', entityId: budgetId },
    });
    expect(events[1]?.entityRefs?.before).toBeNull();
    expect(events[1]?.entityRefs?.after?.entityKind).toBe('cost-item');
    expect(events[3]?.entityRefs?.after?.entityKind).toBe('budget-revision');
    expect(events[4]?.entityRefs?.after?.entityKind).toBe('commitment');
    expect(events[5]?.entityRefs?.after?.entityKind).toBe('commitment-amendment');
    expect(events[6]?.entityRefs?.after?.entityKind).toBe('invoice');
    expect(events[7]?.entityRefs?.after?.entityKind).toBe('payment-reference');
    // The close carries before AND after refs of the same root.
    expect(events[9]?.entityRefs?.before?.entityKind).toBe('commitment');
    expect(events[9]?.entityRefs?.after?.entityKind).toBe('commitment');

    // The commitment-created payload records the consequential decision's
    // shape (committed amount from the chain-tip line set).
    expect(events[4]?.payload).toStrictEqual({
      commitmentId: purchaseOrderId,
      budgetId,
      number: 'PO-0001',
      commitmentKind: 'purchase-order',
      description: 'Foundations package',
      lineCount: 2,
      committedAmountMinor: 230000,
      version: 1,
      createdAt: NOW,
    });

    // The payment-referenced payload carries both owning ids + the payment.
    const invoice = harness.store.invoices[0];
    if (invoice === undefined) throw new Error('invoice missing');
    expect(events[7]?.payload).toStrictEqual({
      invoiceId: invoice.entityId,
      commitmentId: purchaseOrderId,
      paymentReferenceId: invoice.paymentReferences[0]?.entityId,
      reference: 'CHK-1001',
      amountMinor: 60000,
      paidAt: PAID_AT,
      version: 2,
      recordedAt: NOW,
    });
  });
});

describe('budget-revision immutability under the command path', () => {
  it('later history never touches a landed revision; re-revising appends and the prior revision stays byte-identical', async () => {
    const harness = makeHarness();
    const { finalBudget, budgetId } = await runLifecycleAsync(harness);
    const revisionId = finalBudget.currentRevisionId;
    if (revisionId === null) throw new Error('revision missing');
    const revision = finalBudget.revisions[revisionId];
    if (revision === undefined) throw new Error('revision missing');

    // The snapshot anchored the two items at revision time.
    expect(revision.costItems.map((item) => item.code)).toStrictEqual(['CONC', 'STEEL']);
    expect(revision.label).toBe('Tender baseline');
    expect(revision.sequence).toBe(1);
    expect(revision.supersedes).toBeNull();

    // MORE history lands after the revision: a new cost item + a re-revision.
    const withDraftItem = mustSucceed(
      await harness.commands.recordCostItem(
        envelope(
          {
            budgetId,
            expectedVersion: finalBudget.version,
            code: 'GLAZ',
            description: 'Glazing',
            unit: 'lot',
            quantityMilli: 1000,
            unitRateMinor: 100000,
          },
          RECORD_COST_ITEM_COMMAND,
        ),
        COST_MANAGER,
      ),
      'recordCostItem GLAZ',
    );
    const reRevised = mustSucceed(
      await harness.commands.reviseBudget(
        envelope(
          { budgetId, expectedVersion: withDraftItem.version, label: 'Owner change order' },
          REVISE_BUDGET_COMMAND,
        ),
        BUDGET_REVISER,
      ),
      'reviseBudget 2',
    );

    // APPENDS a second revision; the chain is intact.
    expect(Object.keys(reRevised.revisions)).toHaveLength(2);
    expect(reRevised.currentRevisionId).not.toBe(revisionId);
    const second = reRevised.revisions[reRevised.currentRevisionId ?? ''];
    if (second === undefined) throw new Error('second revision missing');
    expect(second.supersedes).toBe(revisionId);
    expect(second.sequence).toBe(2);
    expect(second.costItems.map((item) => item.code)).toStrictEqual(['CONC', 'GLAZ', 'STEEL']);

    // THE acceptance gate: the prior revision is byte-identical after the
    // whole later history (new item + new revision).
    expect(reRevised.revisions[revisionId]).toStrictEqual(revision);
    expect(reRevised.revisions[revisionId]).toBe(revision);
    expect(revision.costItems.map((item) => item.code)).toStrictEqual(['CONC', 'STEEL']);
  });
});

describe('the failing EventSink aborts the mutation (atomicity)', () => {
  const sinkFailure = () => ({
    ok: false as const,
    error: {
      kind: 'domain-error' as const,
      code: 'invariant-violation' as const,
      message: 'event sink rejected the append: ledger unavailable',
      scope: null,
      correlationId: null,
      details: [{ code: 'event-sink-rejected', message: 'ledger unavailable', path: null }],
    },
  });

  it('a create whose event append fails leaves NO budget behind', async () => {
    const store = createInMemoryCostStore();
    const commands = createCostCommands({
      store,
      eventSink: { appendEvents: async () => sinkFailure() },
      now: () => NOW,
      newOpaqueId: () => 'c000000000000009',
    });
    const result = await commands.createBudget(
      envelope({ name: 'Riverside budget', currency: 'USD' }, CREATE_BUDGET_COMMAND),
      COST_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    expect(store.budgets).toHaveLength(0);
    expect(store.commitments).toHaveLength(0);
    expect(store.invoices).toHaveLength(0);
    expect(store.transactionCount).toBe(1);
  });

  it('a mutation whose event append fails leaves the aggregate UNCHANGED (zero partial state)', async () => {
    const harness = makeHarness();
    const { budgetId, finalBudget } = await runLifecycleAsync(harness);
    const eventsBefore = harness.sink.events.length;

    // Re-wire the SAME store with a failing sink.
    const failingCommands = createCostCommands({
      store: harness.store,
      eventSink: { appendEvents: async () => sinkFailure() },
      now: () => NOW,
      newOpaqueId: () => 'c000000000000009',
    });
    const result = await failingCommands.recordCostItem(
      envelope(
        {
          budgetId,
          expectedVersion: finalBudget.version,
          code: 'LATE',
          description: 'Late item',
          unit: 'lot',
          quantityMilli: 1000,
          unitRateMinor: 100000,
        },
        RECORD_COST_ITEM_COMMAND,
      ),
      COST_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    // The rolled-back write never committed: state and event log unchanged.
    const committed = harness.store.budgets[0];
    if (committed === undefined) throw new Error('budget missing');
    expect(committed.version).toBe(finalBudget.version);
    expect(Object.keys(committed.costItems)).toHaveLength(2);
    expect(harness.sink.events).toHaveLength(eventsBefore);
  });
});

describe('deterministic balances from the CURRENT revision (run-twice)', () => {
  it('recomputes the identical committed-vs-budget and cost position from the recorded state', async () => {
    const harness = makeHarness();
    const { finalBudget } = await runLifecycleAsync(harness);

    const first = committedVsBudget(finalBudget, harness.store.commitments);
    const second = committedVsBudget(finalBudget, harness.store.commitments);
    expect(first).toStrictEqual(second);
    expect(first.currentRevisionId).toBe(finalBudget.currentRevisionId);
    expect(first.currency).toBe('USD');
    // CONC budgeted 250000 / committed 250000; STEEL budgeted 50000 /
    // committed 50000 (PO amendment 40000 + closed SC 10000 — closing ends
    // the obligation, not the committed history).
    expect(first.totalBudgetedMinor).toBe(300000);
    expect(first.totalCommittedMinor).toBe(300000);
    expect(first.totalVarianceMinor).toBe(0);
    expect(first.perCostItem.map((row) => [row.code, row.budgetedMinor, row.committedMinor])).toStrictEqual([
      ['CONC', 250000, 250000],
      ['STEEL', 50000, 50000],
    ]);

    // The cost-impact read model recomputes identically too.
    const positionFirst = costPosition(finalBudget, harness.store.commitments, harness.store.invoices);
    const positionSecond = costPosition(finalBudget, harness.store.commitments, harness.store.invoices);
    expect(positionFirst).toStrictEqual(positionSecond);
    expect(positionFirst.budgetedMinor).toBe(300000);
    expect(positionFirst.committedMinor).toBe(300000);
    expect(positionFirst.invoicedMinor).toBe(100000);
    expect(positionFirst.paidMinor).toBe(60000);
    expect(positionFirst.outstandingMinor).toBe(40000);
    expect(positionFirst.overCommittedCostItemIds).toStrictEqual([]);
    expect(positionFirst.overInvoicedCommitmentIds).toStrictEqual([]);
  });
});

describe('deterministic end-to-end replay', () => {
  it('the identical command sequence on a fresh harness reproduces the identical state and event stream', async () => {
    // Two harnesses with the SAME injected clock and the SAME id-supplier
    // sequence (both start their opaque counters at 1).
    const first = makeHarness();
    const second = makeHarness();
    // Envelope idempotency counters must be reset so both runs issue the
    // same command envelopes; isolate by snapshotting the current value.
    const counterBefore = envelopeCounter;
    envelopeCounter = 0;
    const runOne = await runLifecycleAsync(first);
    const eventsOne = [...first.sink.events];
    envelopeCounter = 0;
    const runTwo = await runLifecycleAsync(second);
    const eventsTwo = [...second.sink.events];
    envelopeCounter = counterBefore;

    // Identical canonical ids (same opaque sequence) and identical states —
    // across ALL THREE aggregate families.
    expect(runOne.budgetId).toBe(runTwo.budgetId);
    expect(runOne.concItemId).toBe(runTwo.concItemId);
    expect(runOne.purchaseOrderId).toBe(runTwo.purchaseOrderId);
    expect(runOne.finalBudget).toStrictEqual(runTwo.finalBudget);
    expect(first.store.commitments).toStrictEqual(second.store.commitments);
    expect(first.store.invoices).toStrictEqual(second.store.invoices);
    // Identical audit event streams (names, scopes, actors, causality, refs,
    // payloads — including the issued cost-item/revision/line/invoice/
    // payment ids).
    expect(eventsOne).toStrictEqual(eventsTwo);

    // The deterministic balances are identical across the two replays too
    // (computed state, never stored — they cannot drift).
    expect(
      committedVsBudget(runOne.finalBudget, first.store.commitments),
    ).toStrictEqual(committedVsBudget(runTwo.finalBudget, second.store.commitments));
  });
});
