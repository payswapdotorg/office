import { describe, expect, it } from 'vitest';
import { formatEntityId, formatProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, Scope, Timestamp } from '@office/contracts';
import type { Result } from '@office/domain-kernel';
import { committedVsBudget, costPosition, invoicedVsCommitted } from './balances';
import type { CostPosition } from './balances';
import {
  amendCommitmentState,
  createBudgetState,
  createCommitmentState,
  createInvoiceState,
  parseCurrencyCode,
  recordCostItemState,
  referencePaymentState,
  reviseBudgetState,
} from './state';
import type {
  BudgetState,
  CommitmentState,
  InvoiceState,
  NewCommitmentLine,
  NewInvoiceLine,
} from './state';

// OFF-011 cost domain — the deterministic balance computations (THE canonical
// balance rule: committed-vs-budget and invoiced-vs-committed are pure
// functions of the recorded state — never stored counters that can drift).
// Every test asserts the run-twice determinism gate and the input-order
// independence (shuffled commitments/invoices yield byte-identical rows),
// plus the current-revision basis and the over-commitment signal for cost
// items the current revision no longer contains.

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };
const USD = unwrap(parseCurrencyCode('USD'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));
const NOW_4: Timestamp = unwrap(parseTimestamp('2026-09-15T09:00:00.000Z'));

const id = (prefix: string, n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

const BUDGET_ID = id('bud', 1);
const ITEM_CONC = id('cit', 1);
const ITEM_STEEL = id('cit', 2);
const REV_1 = id('brv', 1);
const COMMITMENT_1 = id('cmt', 1);
const COMMITMENT_2 = id('cmt', 2);
const AMENDMENT_1 = id('cam', 1);
const C1_LINE_1 = id('cml', 11);
const C1_LINE_2 = id('cml', 12);
const C2_LINE_1 = id('cml', 21);
const INVOICE_1 = id('inv', 1);
const INVOICE_2 = id('inv', 2);
const INV_LINE_1 = id('inl', 1);
const INV_LINE_2 = id('inl', 2);
const PAYMENT_1 = id('pay', 1);

/**
 * The canonical recorded scenario: a budget whose CURRENT revision anchors
 * CONC (500,000) + STEEL (250,000); commitment 1 committed 600,000 over CONC
 * + 50,000 over STEEL (an over-commitment on CONC), commitment 2 committed
 * 100,000 over CONC; one invoice of 300,000 against commitment 1 (200,000
 * paid), one invoice of 75,000 against commitment 2 (unpaid).
 */
const recordedState = (): {
  readonly budget: BudgetState;
  readonly commitments: readonly CommitmentState[];
  readonly invoices: readonly InvoiceState[];
} => {
  let budget = unwrap(
    createBudgetState(
      { budgetId: BUDGET_ID, name: 'Riverside budget', currency: USD, now: NOW_1 },
      SCOPE,
    ),
  );
  budget = unwrap(
    recordCostItemState(budget, {
      costItemId: ITEM_CONC,
      code: 'CONC',
      description: 'Concrete works',
      unit: 'lot',
      quantityMilli: 2000,
      unitRateMinor: 250000,
      now: NOW_1,
    }),
  );
  budget = unwrap(
    recordCostItemState(budget, {
      costItemId: ITEM_STEEL,
      code: 'STEEL',
      description: 'Steel supply',
      unit: 'ton',
      quantityMilli: 5000,
      unitRateMinor: 50000,
      now: NOW_1,
    }),
  );
  budget = unwrap(
    reviseBudgetState(budget, { revisionId: REV_1, createdBy: null, now: NOW_2 }),
  );

  const commitment1Lines: readonly NewCommitmentLine[] = [
    { lineId: C1_LINE_1, costItemId: ITEM_CONC, description: 'Concrete', amountMinor: 600000 },
    { lineId: C1_LINE_2, costItemId: ITEM_STEEL, description: 'Steel', amountMinor: 50000 },
  ];
  const commitment1 = unwrap(
    createCommitmentState(
      {
        commitmentId: COMMITMENT_1,
        number: 'PO-0001',
        commitmentKind: 'purchase-order',
        description: 'Foundations package',
        currency: USD,
        lines: commitment1Lines,
        now: NOW_2,
        createdBy: null,
      },
      SCOPE,
    ),
  );
  const commitment2 = unwrap(
    createCommitmentState(
      {
        commitmentId: COMMITMENT_2,
        number: 'SC-0001',
        commitmentKind: 'subcontract',
        description: 'Electrical subcontract',
        currency: USD,
        lines: [
          { lineId: C2_LINE_1, costItemId: ITEM_CONC, description: 'Sleeves', amountMinor: 100000 },
        ],
        now: NOW_2,
        createdBy: null,
      },
      SCOPE,
    ),
  );

  const invoice1Lines: readonly NewInvoiceLine[] = [
    { lineId: INV_LINE_1, description: 'Billing 1', amountMinor: 300000 },
  ];
  const invoice2Lines: readonly NewInvoiceLine[] = [
    { lineId: INV_LINE_2, description: 'Billing 1', amountMinor: 75000 },
  ];
  let invoice1 = unwrap(
    createInvoiceState(
      {
        invoiceId: INVOICE_1,
        commitmentId: COMMITMENT_1,
        number: 'INV-0001',
        description: 'Foundations billing',
        currency: USD,
        lines: invoice1Lines,
        issuedOn: NOW_3,
        dueOn: NOW_4,
        now: NOW_3,
      },
      SCOPE,
    ),
  );
  invoice1 = unwrap(
    referencePaymentState(invoice1, {
      paymentReferenceId: PAYMENT_1,
      reference: 'CHK-1001',
      amountMinor: 200000,
      paidAt: NOW_4,
      now: NOW_4,
    }),
  );
  const invoice2 = unwrap(
    createInvoiceState(
      {
        invoiceId: INVOICE_2,
        commitmentId: COMMITMENT_2,
        number: 'INV-0002',
        description: 'Electrical billing',
        currency: USD,
        lines: invoice2Lines,
        issuedOn: NOW_3,
        dueOn: NOW_4,
        now: NOW_3,
      },
      SCOPE,
    ),
  );

  return {
    budget,
    commitments: [commitment1, commitment2],
    invoices: [invoice1, invoice2],
  };
};

const fail = (): never => {
  throw new Error('commitment missing');
};

describe('committedVsBudget (deterministic pure function)', () => {
  it('folds the CURRENT revision against the chain-tip commitment line sets', () => {
    const { budget, commitments } = recordedState();
    const balance = committedVsBudget(budget, commitments);
    expect(balance.budgetId).toBe(BUDGET_ID);
    expect(balance.currentRevisionId).toBe(REV_1);
    expect(balance.currency).toBe('USD');
    // Rows sorted by code: CONC (budgeted 500000, committed 700000) then
    // STEEL (budgeted 250000, committed 50000).
    expect(balance.perCostItem).toHaveLength(2);
    const conc = balance.perCostItem[0];
    const steel = balance.perCostItem[1];
    if (conc === undefined || steel === undefined) throw new Error('rows missing');
    expect(conc).toStrictEqual({
      costItemId: ITEM_CONC,
      code: 'CONC',
      budgetedMinor: 500000,
      committedMinor: 700000,
      varianceMinor: 200000,
    });
    expect(steel).toStrictEqual({
      costItemId: ITEM_STEEL,
      code: 'STEEL',
      budgetedMinor: 250000,
      committedMinor: 50000,
      varianceMinor: -200000,
    });
    expect(balance.totalBudgetedMinor).toBe(750000);
    expect(balance.totalCommittedMinor).toBe(750000);
    expect(balance.totalVarianceMinor).toBe(0);
  });

  it('shows the over-commitment signal for cost items the current revision no longer contains', () => {
    const { commitments } = recordedState();
    // A budget whose CURRENT revision anchors only CONC (value engineering
    // moved the project on): the commitment — recorded against an earlier
    // working set that carried STEEL — still counts as committed money, and
    // its row shows ZERO current budget against it (the exact over-
    // commitment signal the commercial model must expose deterministically).
    let reduced = unwrap(
      createBudgetState(
        { budgetId: BUDGET_ID, name: 'Riverside budget', currency: USD, now: NOW_1 },
        SCOPE,
      ),
    );
    reduced = unwrap(
      recordCostItemState(reduced, {
        costItemId: ITEM_CONC,
        code: 'CONC',
        description: 'Concrete works',
        unit: 'lot',
        quantityMilli: 2000,
        unitRateMinor: 250000,
        now: NOW_1,
      }),
    );
    reduced = unwrap(
      reviseBudgetState(reduced, { revisionId: REV_1, createdBy: null, now: NOW_2 }),
    );

    const balance = committedVsBudget(reduced, commitments);
    expect(balance.currentRevisionId).toBe(REV_1);
    expect(balance.totalBudgetedMinor).toBe(500000);
    expect(balance.totalCommittedMinor).toBe(750000);
    expect(balance.totalVarianceMinor).toBe(250000);
    // STEEL: budgeted 0, committed 50000 — the over-commitment row.
    const steelRow = balance.perCostItem.find((row) => row.costItemId === ITEM_STEEL);
    if (steelRow === undefined) throw new Error('steel row missing');
    expect(steelRow.budgetedMinor).toBe(0);
    expect(steelRow.code).toBe('');
    expect(steelRow.committedMinor).toBe(50000);
    expect(steelRow.varianceMinor).toBe(50000);
  });

  it('is deterministic: run-twice and shuffled commitment input order are byte-identical', () => {
    const { budget, commitments } = recordedState();
    const first = committedVsBudget(budget, commitments);
    const second = committedVsBudget(budget, commitments);
    const shuffled = committedVsBudget(budget, [commitments[1] ?? fail(), commitments[0] ?? fail()]);
    expect(first).toStrictEqual(second);
    expect(first).toStrictEqual(shuffled);
  });
});

describe('invoicedVsCommitted (deterministic pure function)', () => {
  it('folds each commitment against its invoices and payment references', () => {
    const { commitments, invoices } = recordedState();
    const balance = invoicedVsCommitted(commitments, invoices);
    // Rows sorted by commitment id.
    expect(balance.perCommitment).toHaveLength(2);
    const row1 = balance.perCommitment[0];
    const row2 = balance.perCommitment[1];
    if (row1 === undefined || row2 === undefined) throw new Error('rows missing');
    expect(row1).toStrictEqual({
      commitmentId: COMMITMENT_1,
      committedMinor: 650000,
      invoicedMinor: 300000,
      paidMinor: 200000,
      invoicedVarianceMinor: -350000,
      outstandingMinor: 100000,
    });
    expect(row2).toStrictEqual({
      commitmentId: COMMITMENT_2,
      committedMinor: 100000,
      invoicedMinor: 75000,
      paidMinor: 0,
      invoicedVarianceMinor: -25000,
      outstandingMinor: 75000,
    });
    expect(balance.totalCommittedMinor).toBe(750000);
    expect(balance.totalInvoicedMinor).toBe(375000);
    expect(balance.totalPaidMinor).toBe(200000);
    expect(balance.totalOutstandingMinor).toBe(175000);
    expect(balance.totalInvoicedVarianceMinor).toBe(-375000);
  });

  it('follows an AMENDMENT: the committed amount is the chain-tip line set', () => {
    const { commitments, invoices } = recordedState();
    const commitment1 = commitments[0];
    if (commitment1 === undefined) throw new Error('commitment missing');
    const amended = unwrap(
      amendCommitmentState(commitment1, {
        amendmentId: AMENDMENT_1,
        reason: 'Scope reduction',
        lines: [
          { lineId: C1_LINE_1, costItemId: ITEM_CONC, description: 'Concrete', amountMinor: 500000 },
          { lineId: C1_LINE_2, costItemId: ITEM_STEEL, description: 'Steel', amountMinor: 50000 },
        ],
        now: NOW_4,
        amendedBy: null,
      }),
    );
    const balance = invoicedVsCommitted([amended], invoices);
    const row = balance.perCommitment[0];
    if (row === undefined) throw new Error('row missing');
    expect(row.committedMinor).toBe(550000);
    // The invoices against commitment 1 did not change.
    expect(row.invoicedMinor).toBe(300000);
    expect(balance.totalInvoicedVarianceMinor).toBe(-250000);
  });

  it('is deterministic: run-twice and shuffled inputs are byte-identical', () => {
    const { commitments, invoices } = recordedState();
    const first = invoicedVsCommitted(commitments, invoices);
    const second = invoicedVsCommitted(commitments, invoices);
    const shuffled = invoicedVsCommitted(
      [commitments[1] ?? fail(), commitments[0] ?? fail()],
      [invoices[1] ?? fail(), invoices[0] ?? fail()],
    );
    expect(first).toStrictEqual(second);
    expect(first).toStrictEqual(shuffled);
  });
});

describe('costPosition (THE cost-impact read model OFF-014 consumes)', () => {
  it('snapshot the whole commercial position deterministically', () => {
    const { budget, commitments, invoices } = recordedState();
    const position: CostPosition = costPosition(budget, commitments, invoices);
    expect(position.budgetId).toBe(BUDGET_ID);
    expect(position.currency).toBe('USD');
    expect(position.currentRevisionId).toBe(REV_1);
    expect(position.budgetedMinor).toBe(750000);
    expect(position.committedMinor).toBe(750000);
    expect(position.invoicedMinor).toBe(375000);
    expect(position.paidMinor).toBe(200000);
    expect(position.remainingBudgetMinor).toBe(0);
    expect(position.committedVarianceMinor).toBe(0);
    expect(position.invoicedVarianceMinor).toBe(-375000);
    expect(position.outstandingMinor).toBe(175000);
    expect(position.overCommittedCostItemIds).toStrictEqual([ITEM_CONC]);
    expect(position.overInvoicedCommitmentIds).toStrictEqual([]);
    // The breakdowns are embedded whole.
    expect(position.committedVsBudget.perCostItem).toHaveLength(2);
    expect(position.invoicedVsCommitted.perCommitment).toHaveLength(2);
  });

  it('flags over-invoiced commitments and stays deterministic under input shuffling', () => {
    const { budget, commitments } = recordedState();
    // An invoice of 150,000 against commitment 2 (committed 100,000) — the
    // over-invoiced signal, still within the deterministic fold.
    const overInvoice = unwrap(
      createInvoiceState(
        {
          invoiceId: INVOICE_2,
          commitmentId: COMMITMENT_2,
          number: 'INV-0002',
          description: 'Electrical billing',
          currency: USD,
          lines: [{ lineId: INV_LINE_2, description: 'Billing 1', amountMinor: 150000 }],
          issuedOn: NOW_3,
          dueOn: NOW_4,
          now: NOW_3,
        },
        SCOPE,
      ),
    );
    const position = costPosition(budget, commitments, [overInvoice]);
    expect(position.overInvoicedCommitmentIds).toStrictEqual([COMMITMENT_2]);
    expect(position.overCommittedCostItemIds).toStrictEqual([ITEM_CONC]);

    // Run-twice + shuffled: byte-identical.
    const again = costPosition(budget, commitments, [overInvoice]);
    const shuffled = costPosition(
      budget,
      [commitments[1] ?? fail(), commitments[0] ?? fail()],
      [overInvoice],
    );
    expect(position).toStrictEqual(again);
    expect(position).toStrictEqual(shuffled);
  });
});
