// Office cost domain — deterministic balance computation + the cost-impact
// read model (OFF-011).
//
// THE canonical balance rule (acceptance): committed-vs-budget and
// invoiced-vs-committed balances are DETERMINISTIC pure functions of the
// recorded state — they are NEVER stored as mutable counters that can drift
// from the recorded lines. Every function here is a total fold over the
// recorded aggregates (loaded by the caller through the scope-guarded
// store); run it twice, run it over shuffled input order, and the answer is
// byte-identical, because every output row is sorted by a canonical key.
//
// Budget side: balances compute against the budget's CURRENT revision (the
// immutable chain tip) — that is the anchored commercial baseline. The
// working set (unrevised lines) is deliberately NOT the balance basis: an
// unrevised edit is a draft, not the budget of record.
//
// Commitment side: the committed amount is the chain-tip line set of each
// commitment. A commitment line may reference a cost item that the CURRENT
// revision no longer contains (the budget moved on after the commitment
// landed): such commitment still counts as committed money — the row simply
// shows zero budget against it, which is exactly the over-commitment signal
// the commercial model must expose deterministically.
//
// Invoice side: the invoiced amount is the immutable line total of each
// invoice referencing the commitment; the paid amount is the fold over the
// append-only payment references.
//
// The `CostPosition` at the bottom is the cost-impact interface OFF-014's
// margin engine consumes: one deterministic snapshot of the whole project
// commercial position, derived only from recorded state.
import type { EntityId } from '@office/contracts';
import type {
  BudgetState,
  CommitmentState,
  InvoiceState,
} from './state';
import {
  budgetBasisOf,
  committedAmountMinorOf,
  currentLineSetOf,
  currentRevisionOf,
  invoicedAmountMinorOf,
  paidAmountMinorOf,
} from './state';

/** One committed-vs-budget row: everything recorded against ONE budget cost item. */
export interface CostItemBalance {
  /** TYPED link: the budget cost item this row is about. */
  readonly costItemId: EntityId;
  /** The cost item's code in the current revision ('' when the item is not in the current revision). */
  readonly code: string;
  /** Budgeted amount from the CURRENT revision (0 when absent there). */
  readonly budgetedMinor: number;
  /** Committed amount: the sum of current commitment lines referencing this item. */
  readonly committedMinor: number;
  /** committed − budgeted (positive = over-committed). */
  readonly varianceMinor: number;
}

/** The committed-vs-budget balance of one project (computed against the budget basis of record — the current revision). */
export interface CommittedVsBudget {
  readonly budgetId: EntityId;
  /** The current revision the budget side was computed from, or null when the working set is the basis (pre-revision). */
  readonly currentRevisionId: EntityId | null;
  readonly currency: string;
  /** Rows per cost item (current-revision items plus every committed foreign item), sorted by code then id. */
  readonly perCostItem: readonly CostItemBalance[];
  readonly totalBudgetedMinor: number;
  readonly totalCommittedMinor: number;
  /** totalCommitted − totalBudgeted (positive = over-committed overall). */
  readonly totalVarianceMinor: number;
}

/** One invoiced-vs-committed row: everything recorded against ONE commitment. */
export interface CommitmentBalance {
  /** TYPED link: the commitment this row is about. */
  readonly commitmentId: EntityId;
  /** Committed amount: the chain-tip line-set total. */
  readonly committedMinor: number;
  /** Invoiced amount: the sum of invoice totals referencing this commitment. */
  readonly invoicedMinor: number;
  /** Paid amount: the sum of payment references across those invoices. */
  readonly paidMinor: number;
  /** invoiced − committed (positive = over-invoiced). */
  readonly invoicedVarianceMinor: number;
  /** invoiced − paid (what is still owed on recorded invoices). */
  readonly outstandingMinor: number;
}

/** The invoiced-vs-committed balance over a set of commitments (plus their invoices). */
export interface InvoicedVsCommitted {
  /** Rows per commitment, sorted by commitment id. */
  readonly perCommitment: readonly CommitmentBalance[];
  readonly totalCommittedMinor: number;
  readonly totalInvoicedMinor: number;
  readonly totalPaidMinor: number;
  readonly totalOutstandingMinor: number;
  readonly totalInvoicedVarianceMinor: number;
}

/**
 * THE committed-vs-budget balance (deterministic pure function): folds the
 * budget's BASIS OF RECORD — the CURRENT revision (the immutable chain tip;
 * before the first revision, the working set, which is exactly what the first
 * revision will anchor) — against the CURRENT (chain-tip) line set of every
 * commitment. Order-independent: rows are sorted by code then cost item id,
 * so the same recorded state always yields the byte-identical answer
 * regardless of commitment input order.
 */
export function committedVsBudget(
  budget: BudgetState,
  commitments: readonly CommitmentState[],
): CommittedVsBudget {
  const revision = currentRevisionOf(budget);
  const basis = budgetBasisOf(budget);
  const budgetedByItem = new Map<string, { code: string; amountMinor: number }>();
  for (const item of basis) {
    budgetedByItem.set(item.entityId, {
      code: item.code,
      amountMinor: item.amountMinor,
    });
  }
  const committedByItem = new Map<string, number>();
  for (const commitment of commitments) {
    for (const line of currentLineSetOf(commitment).lines) {
      committedByItem.set(
        line.costItemId,
        (committedByItem.get(line.costItemId) ?? 0) + line.amountMinor,
      );
    }
  }
  const rowOf = (costItemId: string): CostItemBalance => {
    const budgeted = budgetedByItem.get(costItemId);
    const committed = committedByItem.get(costItemId) ?? 0;
    const budgetedMinor = budgeted?.amountMinor ?? 0;
    return {
      costItemId: costItemId as EntityId,
      code: budgeted?.code ?? '',
      budgetedMinor,
      committedMinor: committed,
      varianceMinor: committed - budgetedMinor,
    };
  };
  const ids = new Set<string>([...budgetedByItem.keys(), ...committedByItem.keys()]);
  const rows = [...ids].map(rowOf).sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.costItemId < b.costItemId ? -1 : a.costItemId > b.costItemId ? 1 : 0;
  });
  const totalBudgetedMinor = [...budgetedByItem.values()].reduce(
    (sum, entry) => sum + entry.amountMinor,
    0,
  );
  const totalCommittedMinor = [...committedByItem.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  );
  return {
    budgetId: budget.entityId,
    currentRevisionId: revision?.entityId ?? null,
    currency: budget.currency,
    perCostItem: rows,
    totalBudgetedMinor,
    totalCommittedMinor,
    totalVarianceMinor: totalCommittedMinor - totalBudgetedMinor,
  };
}

/**
 * THE invoiced-vs-committed balance (deterministic pure function): folds each
 * commitment's CURRENT committed amount against the invoices referencing it
 * (their immutable totals and their payment references). Order-independent:
 * rows are sorted by commitment id; the invoice input order never matters.
 */
export function invoicedVsCommitted(
  commitments: readonly CommitmentState[],
  invoices: readonly InvoiceState[],
): InvoicedVsCommitted {
  const invoicesByCommitment = new Map<string, InvoiceState[]>();
  for (const invoice of invoices) {
    const bucket = invoicesByCommitment.get(invoice.commitmentId);
    if (bucket === undefined) {
      invoicesByCommitment.set(invoice.commitmentId, [invoice]);
    } else {
      bucket.push(invoice);
    }
  }
  const rows = [...commitments]
    .sort((a, b) =>
      a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0,
    )
    .map((commitment): CommitmentBalance => {
      const committed = committedAmountMinorOf(commitment);
      const own = invoicesByCommitment.get(commitment.entityId) ?? [];
      const invoiced = own.reduce((sum, invoice) => sum + invoicedAmountMinorOf(invoice), 0);
      const paid = own.reduce((sum, invoice) => sum + paidAmountMinorOf(invoice), 0);
      return {
        commitmentId: commitment.entityId,
        committedMinor: committed,
        invoicedMinor: invoiced,
        paidMinor: paid,
        invoicedVarianceMinor: invoiced - committed,
        outstandingMinor: invoiced - paid,
      };
    });
  const totalCommittedMinor = rows.reduce((sum, row) => sum + row.committedMinor, 0);
  const totalInvoicedMinor = rows.reduce((sum, row) => sum + row.invoicedMinor, 0);
  const totalPaidMinor = rows.reduce((sum, row) => sum + row.paidMinor, 0);
  return {
    perCommitment: rows,
    totalCommittedMinor,
    totalInvoicedMinor,
    totalPaidMinor,
    totalOutstandingMinor: totalInvoicedMinor - totalPaidMinor,
    totalInvoicedVarianceMinor: totalInvoicedMinor - totalCommittedMinor,
  };
}

/**
 * THE cost-impact read model OFF-014's margin engine consumes: one
 * deterministic snapshot of a project's whole commercial position, derived
 * ONLY from the recorded aggregates (budget + commitments + invoices). Never
 * stored, never cached as truth — recomputing from the same recorded state
 * yields the byte-identical position.
 */
export interface CostPosition {
  readonly budgetId: EntityId;
  readonly currency: string;
  /** The current revision the budget side is anchored to (null before the first revision). */
  readonly currentRevisionId: EntityId | null;
  /** Budget of record: the current revision's total. */
  readonly budgetedMinor: number;
  /** Current committed total (chain-tip line sets). */
  readonly committedMinor: number;
  /** Recorded invoice totals against those commitments. */
  readonly invoicedMinor: number;
  /** Referenced payment totals across those invoices. */
  readonly paidMinor: number;
  /** budgeted − committed: the uncommitted budget headroom (negative when over-committed). */
  readonly remainingBudgetMinor: number;
  /** committed − budgeted (positive = over-committed). */
  readonly committedVarianceMinor: number;
  /** invoiced − committed (positive = over-invoiced). */
  readonly invoicedVarianceMinor: number;
  /** invoiced − paid: what is still owed on recorded invoices. */
  readonly outstandingMinor: number;
  /** Cost items whose committed amount exceeds their current-revision budget. */
  readonly overCommittedCostItemIds: readonly EntityId[];
  /** Commitments whose invoiced total exceeds their committed amount. */
  readonly overInvoicedCommitmentIds: readonly EntityId[];
  /** The full committed-vs-budget breakdown. */
  readonly committedVsBudget: CommittedVsBudget;
  /** The full invoiced-vs-committed breakdown. */
  readonly invoicedVsCommitted: InvoicedVsCommitted;
}

/**
 * Compute the deterministic cost position of one project's recorded
 * commercial state. Pure: same recorded state in, byte-identical position
 * out — regardless of the order the aggregates are passed in.
 */
export function costPosition(
  budget: BudgetState,
  commitments: readonly CommitmentState[],
  invoices: readonly InvoiceState[],
): CostPosition {
  const committed = committedVsBudget(budget, commitments);
  const invoiced = invoicedVsCommitted(commitments, invoices);
  return {
    budgetId: budget.entityId,
    currency: budget.currency,
    currentRevisionId: committed.currentRevisionId,
    budgetedMinor: committed.totalBudgetedMinor,
    committedMinor: committed.totalCommittedMinor,
    invoicedMinor: invoiced.totalInvoicedMinor,
    paidMinor: invoiced.totalPaidMinor,
    remainingBudgetMinor: committed.totalBudgetedMinor - committed.totalCommittedMinor,
    committedVarianceMinor: committed.totalVarianceMinor,
    invoicedVarianceMinor: invoiced.totalInvoicedVarianceMinor,
    outstandingMinor: invoiced.totalOutstandingMinor,
    overCommittedCostItemIds: committed.perCostItem
      .filter((row) => row.varianceMinor > 0)
      .map((row) => row.costItemId),
    overInvoicedCommitmentIds: invoiced.perCommitment
      .filter((row) => row.invoicedVarianceMinor > 0)
      .map((row) => row.commitmentId),
    committedVsBudget: committed,
    invoicedVsCommitted: invoiced,
  };
}
