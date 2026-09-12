import { describe, expect, it } from 'vitest';
import { formatEntityId, formatProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION } from '@office/domain-kernel';
import type { Result } from '@office/domain-kernel';
import {
  amendCommitmentState,
  closeCommitmentState,
  committedAmountMinorOf,
  createBudgetState,
  createCommitmentState,
  createInvoiceState,
  currentCostItemsOf,
  currentLineSetOf,
  currentRevisionOf,
  budgetBasisOf,
  extensionMinorOf,
  invoicedAmountMinorOf,
  outstandingInvoicedMinorOf,
  paidAmountMinorOf,
  parseCurrencyCode,
  recordCostItemState,
  referencePaymentState,
  removeBudgetRevisionState,
  reviseBudgetState,
  updateBudgetRevisionState,
  updateInvoiceLineState,
} from './state';
import type {
  BudgetState,
  CommitmentState,
  InvoiceState,
  NewCommitmentLine,
  NewInvoiceLine,
} from './state';

// OFF-011 cost domain — aggregate states, invariants, and pure commercial
// transitions. Everything is deterministic: fixed canonical ids, fixed
// timestamps, no I/O. The budget-revision immutability chain (snapshot +
// byte-identical read-back), the exact-integer money rule (no rounding,
// ever), the append-only commitment line-set chain with its closed-is-terminal
// rule, immutable invoice lines, and the not-overpaid payment-reference bound
// are the acceptance surface under test here.

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
const ITEM_A = id('cit', 1);
const ITEM_B = id('cit', 2);
const REV_1 = id('brv', 1);
const REV_2 = id('brv', 2);
const COMMITMENT_ID = id('cmt', 1);
const AMENDMENT_ID = id('cam', 1);
const COMMITMENT_LINE_1 = id('cml', 1);
const COMMITMENT_LINE_2 = id('cml', 2);
const INVOICE_ID = id('inv', 1);
const INVOICE_LINE_1 = id('inl', 1);
const INVOICE_LINE_2 = id('inl', 2);
const PAYMENT_1 = id('pay', 1);
const PAYMENT_2 = id('pay', 2);
const ACTOR_ID = id('usr', 1);

const budget = (): BudgetState =>
  unwrap(
    createBudgetState(
      { budgetId: BUDGET_ID, name: 'Riverside budget', currency: USD, now: NOW_1 },
      SCOPE,
    ),
  );

const withItem = (
  state: BudgetState,
  costItemId: EntityId,
  code: string,
  quantityMilli = 1000,
  unitRateMinor = 250000,
  now: Timestamp = NOW_1,
): BudgetState =>
  unwrap(
    recordCostItemState(
      state,
      {
        costItemId,
        code,
        description: `Cost item ${code}`,
        unit: 'lot',
        quantityMilli,
        unitRateMinor,
        now,
      },
    ),
  );

const commitmentLines = (): readonly NewCommitmentLine[] => [
  { lineId: COMMITMENT_LINE_1, costItemId: ITEM_A, description: 'Concrete works', amountMinor: 200000 },
  { lineId: COMMITMENT_LINE_2, costItemId: ITEM_B, description: 'Steel supply', amountMinor: 150000 },
];

const invoiceLines = (): readonly NewInvoiceLine[] => [
  { lineId: INVOICE_LINE_1, description: 'Progress billing 1', amountMinor: 100000 },
  { lineId: INVOICE_LINE_2, description: 'Retained materials', amountMinor: 25000 },
];

// ----- budget root ------------------------------------------------------------------

describe('budget state creation', () => {
  it('creates an empty budget at version 1 owning its project scope', () => {
    const state = budget();
    expect(state.entityId).toBe(BUDGET_ID);
    expect(state.scope).toStrictEqual(SCOPE);
    expect(state.version).toBe(INITIAL_AGGREGATE_VERSION);
    expect(state.name).toBe('Riverside budget');
    expect(state.currency).toBe('USD');
    expect(state.costItems).toStrictEqual({});
    expect(state.revisions).toStrictEqual({});
    expect(state.currentRevisionId).toBeNull();
    expect(state.createdAt).toBe(NOW_1);
    expect(state.updatedAt).toBe(NOW_1);
  });

  it('rejects a tenant scope (a budget is owned by exactly one project, A12)', () => {
    const result = createBudgetState(
      { budgetId: BUDGET_ID, name: 'Orphan', currency: USD, now: NOW_1 },
      { kind: 'tenant', tenantId: TENANT_A },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('budget-is-project-scoped');
    }
  });

  it('rejects an empty name (invariant backstop behind the parse layer)', () => {
    const result = createBudgetState(
      { budgetId: BUDGET_ID, name: '', currency: USD, now: NOW_1 },
      SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('budget-name-nonempty');
  });

  it('rejects a malformed currency (branded type, fail-closed parse)', () => {
    expect(parseCurrencyCode('usd').ok).toBe(false);
    expect(parseCurrencyCode('US').ok).toBe(false);
    expect(parseCurrencyCode('USDD').ok).toBe(false);
    expect(parseCurrencyCode(42).ok).toBe(false);
    expect(parseCurrencyCode('USD').ok).toBe(true);
  });
});

// ----- exact money (no rounding, ever) -----------------------------------------------

describe('extensionMinorOf (the EXACT extension rule)', () => {
  it('computes the exact integer extension of quantity × rate', () => {
    // 12.5 units at 2,500.00 per unit = 31,250.00 = 3,125,000 minor units.
    expect(unwrap(extensionMinorOf(12500, 250000))).toBe(3125000);
    // Zero rate extends to zero.
    expect(unwrap(extensionMinorOf(1000, 0))).toBe(0);
  });

  it('rejects an extension that does not divide evenly (never rounds money)', () => {
    // 0.001 units at 1 minor unit per unit = 0.001 minor units — not exact.
    const result = extensionMinorOf(1, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('cost-item-extension-exact');
    }
  });

  it('rejects a product beyond the exactly representable range', () => {
    const result = extensionMinorOf(1_000_000_000, 1_000_000_000_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('cost-item-extension-representable');
    }
  });
});

// ----- cost items --------------------------------------------------------------------

describe('recordCostItem transition', () => {
  it('records a cost item into the working set and bumps the ROOT version', () => {
    const next = withItem(budget(), ITEM_A, 'CONC', 1000, 250000);
    expect(Object.keys(next.costItems)).toStrictEqual([ITEM_A]);
    expect(next.costItems[ITEM_A]?.code).toBe('CONC');
    expect(next.costItems[ITEM_A]?.quantityMilli).toBe(1000);
    expect(next.costItems[ITEM_A]?.unitRateMinor).toBe(250000);
    expect(next.costItems[ITEM_A]?.amountMinor).toBe(250000);
    expect(next.version).toBe(2);
    expect(next.scope).toStrictEqual(SCOPE);
  });

  it('rejects a duplicate code (typed, state untouched)', () => {
    const state = withItem(budget(), ITEM_A, 'CONC');
    const result = recordCostItemState(state, {
      costItemId: ITEM_B,
      code: 'CONC',
      description: 'Duplicate code',
      unit: 'lot',
      quantityMilli: 500,
      unitRateMinor: 100000,
      now: NOW_2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('cost-item-codes-unique');
    }
    expect(state.costItems[ITEM_B]).toBeUndefined();
    expect(state.version).toBe(2);
  });

  it('rejects a non-exact extension BEFORE any state lands', () => {
    const state = budget();
    const result = recordCostItemState(state, {
      costItemId: ITEM_A,
      code: 'ODD',
      description: 'Not representable',
      unit: 'lot',
      quantityMilli: 1,
      unitRateMinor: 1,
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('cost-item-extension-exact');
    }
    expect(state.costItems).toStrictEqual({});
    expect(state.version).toBe(1);
  });
});

// ----- budget revisions (immutable snapshots) -----------------------------------------

describe('reviseBudget transition (immutable revision chain)', () => {
  const revisedOnce = (): BudgetState =>
    unwrap(
      reviseBudgetState(withItem(budget(), ITEM_A, 'CONC'), {
        revisionId: REV_1,
        createdBy: ACTOR_ID,
        now: NOW_2,
      }),
    );

  it('snapshots the working set into a new immutable revision', () => {
    const next = revisedOnce();
    expect(Object.keys(next.revisions)).toStrictEqual([REV_1]);
    const revision = next.revisions[REV_1];
    if (revision === undefined) throw new Error('revision missing');
    expect(revision.sequence).toBe(1);
    expect(revision.label).toBe('Revision 1');
    expect(revision.supersedes).toBeNull();
    expect(revision.createdBy).toBe(ACTOR_ID);
    expect(revision.createdAt).toBe(NOW_2);
    expect(revision.costItems.map((item) => item.code)).toStrictEqual(['CONC']);
    expect(next.currentRevisionId).toBe(REV_1);
    expect(next.version).toBe(3);
  });

  it('snapshots items sorted by code regardless of insertion order (byte-stable)', () => {
    let state = budget();
    state = withItem(state, ITEM_B, 'ZZ-CODE', 1000, 100000, NOW_1);
    state = withItem(state, ITEM_A, 'A-CODE', 2000, 200000, NOW_1);
    const next = unwrap(
      reviseBudgetState(state, { revisionId: REV_1, createdBy: null, now: NOW_2 }),
    );
    const revision = next.revisions[REV_1];
    if (revision === undefined) throw new Error('revision missing');
    expect(revision.costItems.map((item) => item.code)).toStrictEqual(['A-CODE', 'ZZ-CODE']);
    // The derived working-set read sorts identically.
    expect(currentCostItemsOf(next).map((item) => item.code)).toStrictEqual([
      'A-CODE',
      'ZZ-CODE',
    ]);
  });

  it('appends a second revision superseding the first; the prior revision reads back byte-identical', () => {
    const first = revisedOnce();
    const firstSnapshot = first.revisions[REV_1];
    if (firstSnapshot === undefined) throw new Error('first revision missing');

    // More working-set changes land AFTER the revision — the landed snapshot
    // cannot see them (deep copy, never a live reference).
    let state = first;
    state = withItem(state, ITEM_B, 'STEEL', 1000, 150000, NOW_3);
    const second = unwrap(
      reviseBudgetState(state, {
        revisionId: REV_2,
        label: 'Owner change order',
        createdBy: ACTOR_ID,
        now: NOW_4,
      }),
    );

    expect(Object.keys(second.revisions)).toStrictEqual([REV_1, REV_2]);
    const revision2 = second.revisions[REV_2];
    if (revision2 === undefined) throw new Error('second revision missing');
    expect(revision2.sequence).toBe(2);
    expect(revision2.supersedes).toBe(REV_1);
    expect(revision2.label).toBe('Owner change order');
    expect(second.currentRevisionId).toBe(REV_2);

    // THE acceptance gate: the prior revision is byte-identical after the
    // whole later history (new item + new revision).
    expect(second.revisions[REV_1]).toStrictEqual(firstSnapshot);
    expect(second.revisions[REV_1]).toBe(firstSnapshot); // frozen object identity preserved
    expect(revision2.costItems.map((item) => item.code)).toStrictEqual(['CONC', 'STEEL']);
    // The FIRST revision still shows only the one item it anchored.
    expect(firstSnapshot.costItems.map((item) => item.code)).toStrictEqual(['CONC']);
  });

  it('derives the basis of record from the CURRENT revision once one exists', () => {
    const first = revisedOnce();
    // Pre-revision: the working set is the basis.
    expect(budgetBasisOf(withItem(budget(), ITEM_A, 'CONC')).map((i) => i.code)).toStrictEqual([
      'CONC',
    ]);
    // Post-revision: the chain tip is the basis — later working-set edits are
    // drafts until the next revision lands.
    let state = withItem(first, ITEM_B, 'STEEL', 1000, 150000, NOW_3);
    state = unwrap(
      reviseBudgetState(state, { revisionId: REV_2, createdBy: null, now: NOW_4 }),
    );
    expect(budgetBasisOf(state).map((i) => i.code)).toStrictEqual(['CONC', 'STEEL']);
    expect(currentRevisionOf(state)?.entityId).toBe(REV_2);
    expect(currentRevisionOf(budget())).toBeNull();
  });
});

const revisedBudget = (): BudgetState =>
  unwrap(
    reviseBudgetState(withItem(budget(), ITEM_A, 'CONC'), {
      revisionId: REV_1,
      createdBy: ACTOR_ID,
      now: NOW_2,
    }),
  );

describe('budget revision immutability guards (always forbidden)', () => {
  it('updateBudgetRevisionState is always a typed forbidden result', () => {
    const state = revisedBudget();
    const result = updateBudgetRevisionState(state, REV_1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('budget-revision-immutable');
    }
    expect(state.revisions[REV_1]).toBeDefined();
  });

  it('removeBudgetRevisionState is always a typed forbidden result', () => {
    const state = revisedBudget();
    const result = removeBudgetRevisionState(state, REV_1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('budget-revision-immutable');
    }
    expect(Object.keys(state.revisions)).toStrictEqual([REV_1]);
  });
});

// ----- commitments --------------------------------------------------------------------

describe('commitment lifecycle transitions', () => {
  const commitment = (): CommitmentState =>
    unwrap(
      createCommitmentState(
        {
          commitmentId: COMMITMENT_ID,
          number: 'PO-0001',
          commitmentKind: 'purchase-order',
          description: 'Foundations package',
          currency: USD,
          lines: commitmentLines(),
          now: NOW_2,
          createdBy: ACTOR_ID,
        },
        SCOPE,
      ),
    );

  it('creates the commitment with the creation line set as chain tip', () => {
    const state = commitment();
    expect(state.entityId).toBe(COMMITMENT_ID);
    expect(state.scope).toStrictEqual(SCOPE);
    expect(state.version).toBe(INITIAL_AGGREGATE_VERSION);
    expect(state.commitmentKind).toBe('purchase-order');
    expect(state.status).toBe('active');
    expect(state.currency).toBe('USD');
    expect(state.closeReason).toBeNull();
    expect(state.closedAt).toBeNull();
    expect(state.lineSets).toHaveLength(1);
    const creation = state.lineSets[0];
    if (creation === undefined) throw new Error('creation line set missing');
    expect(creation.sequence).toBe(1);
    expect(creation.reason).toBeNull();
    expect(creation.recordedBy).toBe(ACTOR_ID);
    // Lines are sorted by referenced cost item id (byte-stable read-back).
    expect(creation.lines.map((line) => line.costItemId)).toStrictEqual([
      ITEM_A,
      ITEM_B,
    ]);
    expect(committedAmountMinorOf(state)).toBe(350000);
  });

  it('accepts the subcontract kind from the closed canonical vocabulary', () => {
    const state = unwrap(
      createCommitmentState(
        {
          commitmentId: COMMITMENT_ID,
          number: 'SC-0001',
          commitmentKind: 'subcontract',
          description: 'Electrical subcontract',
          currency: USD,
          lines: commitmentLines(),
          now: NOW_2,
          createdBy: null,
        },
        SCOPE,
      ),
    );
    expect(state.commitmentKind).toBe('subcontract');
    expect(currentLineSetOf(state).recordedBy).toBeNull();
  });

  it('amends by APPENDING a full replacement line set (landed sets never rewritten)', () => {
    const state = commitment();
    const amended = unwrap(
      amendCommitmentState(state, {
        amendmentId: AMENDMENT_ID,
        reason: 'Scope added',
        lines: [
          { lineId: COMMITMENT_LINE_1, costItemId: ITEM_A, description: 'Concrete works', amountMinor: 300000 },
        ],
        now: NOW_3,
        amendedBy: ACTOR_ID,
      }),
    );
    expect(amended.lineSets).toHaveLength(2);
    const tip = currentLineSetOf(amended);
    expect(tip.entityId).toBe(AMENDMENT_ID);
    expect(tip.sequence).toBe(2);
    expect(tip.reason).toBe('Scope added');
    expect(committedAmountMinorOf(amended)).toBe(300000);
    expect(amended.version).toBe(2);
    // The creation line set is untouched (append-only chain).
    expect(amended.lineSets[0]).toStrictEqual(state.lineSets[0]);
    expect(amended.lineSets[0]).toBe(state.lineSets[0]);
  });

  it('closes the commitment terminally (close fields present)', () => {
    const state = commitment();
    const closed = unwrap(
      closeCommitmentState(state, { reason: 'Cancelled by owner', now: NOW_3 }),
    );
    expect(closed.status).toBe('closed');
    expect(closed.closeReason).toBe('Cancelled by owner');
    expect(closed.closedAt).toBe(NOW_3);
    expect(closed.version).toBe(2);
    // The whole line-set chain stays readable — closing ends the obligation,
    // not the history.
    expect(closed.lineSets).toHaveLength(1);
  });

  it('rejects amending a CLOSED commitment (closed is terminal, state untouched)', () => {
    const closed = unwrap(
      closeCommitmentState(commitment(), { reason: 'Cancelled by owner', now: NOW_3 }),
    );
    const result = amendCommitmentState(closed, {
      amendmentId: AMENDMENT_ID,
      reason: 'Late change',
      lines: commitmentLines(),
      now: NOW_4,
      amendedBy: ACTOR_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('commitment-closed-is-terminal');
    }
    expect(closed.lineSets).toHaveLength(1);
    expect(closed.version).toBe(2);
  });

  it('rejects closing an already-closed commitment', () => {
    const closed = unwrap(
      closeCommitmentState(commitment(), { reason: 'Cancelled by owner', now: NOW_3 }),
    );
    const result = closeCommitmentState(closed, { reason: 'Again', now: NOW_4 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('commitment-closed-is-terminal');
    }
  });
});

// ----- invoices ------------------------------------------------------------------------

describe('invoice transitions (immutable lines, bounded payments)', () => {
  const invoice = (): InvoiceState =>
    unwrap(
      createInvoiceState(
        {
          invoiceId: INVOICE_ID,
          commitmentId: COMMITMENT_ID,
          number: 'INV-0001',
          description: 'Foundations billing 1',
          currency: USD,
          lines: invoiceLines(),
          issuedOn: NOW_2,
          dueOn: NOW_3,
          now: NOW_2,
        },
        SCOPE,
      ),
    );

  it('records the invoice with its typed commitment link and immutable lines', () => {
    const state = invoice();
    expect(state.entityId).toBe(INVOICE_ID);
    expect(state.scope).toStrictEqual(SCOPE);
    expect(state.commitmentId).toBe(COMMITMENT_ID);
    expect(state.version).toBe(INITIAL_AGGREGATE_VERSION);
    expect(state.lines.map((line) => line.amountMinor)).toStrictEqual([100000, 25000]);
    expect(invoicedAmountMinorOf(state)).toBe(125000);
    expect(state.paymentReferences).toStrictEqual([]);
    expect(paidAmountMinorOf(state)).toBe(0);
  });

  it('rejects a due date before the issue date (invariant backstop)', () => {
    const result = createInvoiceState(
      {
        invoiceId: INVOICE_ID,
        commitmentId: COMMITMENT_ID,
        number: 'INV-0001',
        description: 'Backwards dates',
        currency: USD,
        lines: invoiceLines(),
        issuedOn: NOW_3,
        dueOn: NOW_2,
        now: NOW_2,
      },
      SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('invoice-dates-chronological');
    }
  });

  it('updateInvoiceLineState is always a typed forbidden result', () => {
    const state = invoice();
    const result = updateInvoiceLineState(state, INVOICE_LINE_1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('invoice-line-immutable');
    }
    expect(state.lines).toHaveLength(2);
  });

  it('appends payment references append-only and computes the paid total', () => {
    let state = invoice();
    state = unwrap(
      referencePaymentState(state, {
        paymentReferenceId: PAYMENT_1,
        reference: 'CHK-1001',
        amountMinor: 100000,
        paidAt: NOW_3,
        now: NOW_3,
      }),
    );
    state = unwrap(
      referencePaymentState(state, {
        paymentReferenceId: PAYMENT_2,
        reference: 'CHK-1002',
        amountMinor: 25000,
        paidAt: NOW_4,
        now: NOW_4,
      }),
    );
    expect(state.paymentReferences.map((p) => p.reference)).toStrictEqual([
      'CHK-1001',
      'CHK-1002',
    ]);
    expect(paidAmountMinorOf(state)).toBe(125000);
    expect(state.version).toBe(3);
    expect(outstandingInvoicedMinorOf([state])).toBe(0);
  });

  it('rejects an over-paying reference BEFORE any state lands (not-overpaid)', () => {
    let state = invoice();
    state = unwrap(
      referencePaymentState(state, {
        paymentReferenceId: PAYMENT_1,
        reference: 'CHK-1001',
        amountMinor: 120000,
        paidAt: NOW_3,
        now: NOW_3,
      }),
    );
    // 120000 + 10000 > 125000 — the overpay is rejected typed.
    const result = referencePaymentState(state, {
      paymentReferenceId: PAYMENT_2,
      reference: 'CHK-1002',
      amountMinor: 10000,
      paidAt: NOW_4,
      now: NOW_4,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invoice-not-overpaid');
    }
    // The input state is untouched: still exactly one payment reference.
    expect(state.paymentReferences).toHaveLength(1);
    expect(paidAmountMinorOf(state)).toBe(120000);
    expect(state.version).toBe(2);
  });

  it('rejects a payment instant after the recording instant', () => {
    const state = invoice();
    const result = referencePaymentState(state, {
      paymentReferenceId: PAYMENT_1,
      reference: 'FUTURE',
      amountMinor: 1000,
      paidAt: NOW_4,
      now: NOW_3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe(
        'invoice-payment-references-append-only',
      );
    }
    expect(state.paymentReferences).toHaveLength(0);
  });
});
