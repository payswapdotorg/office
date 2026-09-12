// Office cost domain — aggregate states, invariants, transitions (OFF-011).
//
// THE canonical commercial model of the Construction Project Graph (freeze
// A1/A2): budgets, cost items, commitments, invoices and payment references —
// the recorded commercial truth OFF-014's margin engine computes impacts
// from. Provider-independent by construction (freeze A5): purchase orders and
// subcontracts are CANONICAL commitment kinds, never provider document types;
// money is integer minor units + a canonical currency code (no floating
// point, ever — every stored figure is an exact integer).
//
// THREE project-scoped aggregate roots:
//
//   * Budget — ONE per project (a project owns exactly one canonical budget):
//     a working set of cost items (code, description, unit, quantity in
//     integer milli-units, integer unit rate; the extension is the EXACT
//     quantity × rate product) plus a chain of immutable budget REVISIONS.
//     A revision is a FULL snapshot of the budget lines at a point in time;
//     revising appends a new revision (supersedes -> the prior tip) and never
//     mutates a landed one. Committed/invoiced balances are computed against
//     the CURRENT revision (the chain tip), deterministically.
//   * Commitment — a contractual obligation to pay, as a canonical kind
//     (purchase order or subcontract). Its lines reference budget cost items
//     through TYPED EntityId links (never object references — the budget is a
//     sibling aggregate). Amendments append immutable line sets to an
//     append-only chain: the CURRENT commitment is the chain tip, and the
//     committed amount is computed from it (never stored). Closing is
//     terminal: a closed commitment cannot be amended.
//   * Invoice — a billing record referencing ONE commitment through a typed
//     EntityId link. Invoice lines are immutable once recorded (there is no
//     mutating transition). Payment references append against the invoice,
//     bounded by the not-overpaid invariant (total referenced can never
//     exceed the invoice total).
//
// WHY one root per family: each family is its own consistency unit. The whole
// commercial stream of one commitment (amendments) and of one invoice (its
// payment references) is guarded by that aggregate's optimistic-concurrency
// version — interleaved amendments and recordings against the same budget
// stay exactly consistent because (a) every mutation is version-guarded (a
// stale write is a typed concurrency-conflict, never a silent overwrite) and
// (b) balances are DETERMINISTIC pure functions of the recorded state (see
// balances.ts) — they cannot drift because they are never stored.
//
// This module is PURE DOMAIN: no SQL, no repository, no wall clock, no
// randomness — `now` and canonical ids are injected by the caller. State
// transitions are total functions returning typed Results; failures never
// mutate the input state (callers deep-compare to prove it).
//
// Revision/line-set immutability (acceptance gate): a landed budget revision
// or invoice line can never be edited or deleted — no mutating transition
// exists, and the explicit guards below encode that absence as always-failing
// typed `forbidden` results. Change flows through new revisions, new line
// sets and new payment references only.
import { parseEntityKind } from '@office/contracts';
import { parseFail, parseOk } from '@office/contracts';
import type { EntityId, EntityKind, ParseResult, Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import type { Aggregate, AggregateVersion, DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { domainError, entityNotFound, fail, invariantViolation, ok } from '@office/domain-kernel';
import { compareTimestamps } from './parse';

// ----- entity kinds -------------------------------------------------------------

const parsedKind = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    // Trusted-path literal: a violation means this module is malformed.
    throw new TypeError(
      `invalid cost-domain entity kind literal: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
};

/** Canonical entity kind of the Budget aggregate root. */
export const BUDGET_KIND: EntityKind = parsedKind('budget');
/** Canonical entity kind of a CostItem (a budget line). */
export const COST_ITEM_KIND: EntityKind = parsedKind('cost-item');
/** Canonical entity kind of an immutable BudgetRevision snapshot. */
export const BUDGET_REVISION_KIND: EntityKind = parsedKind('budget-revision');
/** Canonical entity kind of the Commitment aggregate root. */
export const COMMITMENT_KIND: EntityKind = parsedKind('commitment');
/** Canonical entity kind of a commitment line inside a line set. */
export const COMMITMENT_LINE_KIND: EntityKind = parsedKind('commitment-line');
/** Canonical entity kind of one immutable commitment amendment line set. */
export const COMMITMENT_AMENDMENT_KIND: EntityKind = parsedKind('commitment-amendment');
/** Canonical entity kind of the Invoice aggregate root. */
export const INVOICE_KIND: EntityKind = parsedKind('invoice');
/** Canonical entity kind of an immutable invoice line. */
export const INVOICE_LINE_KIND: EntityKind = parsedKind('invoice-line');
/** Canonical entity kind of one append-only payment reference. */
export const PAYMENT_REFERENCE_KIND: EntityKind = parsedKind('payment-reference');

// ----- commercial vocabulary ------------------------------------------------------

declare const currencyBrand: unique symbol;

/**
 * A canonical currency code: exactly three uppercase letters (ISO-aligned,
 * provider-independent). Branded so a plain string can never pose as one —
 * build values through {@link parseCurrencyCode} (fail-closed).
 */
export type CurrencyCode = string & { readonly [currencyBrand]: 'CurrencyCode' };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CURRENCY_GRAMMAR = 'a canonical currency code: exactly three uppercase letters';

/** Parse an untrusted value as a canonical currency code (total, fail-closed). */
export function parseCurrencyCode(raw: unknown): ParseResult<CurrencyCode> {
  if (typeof raw !== 'string' || !CURRENCY_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', CURRENCY_GRAMMAR, JSON.stringify(raw));
  }
  return parseOk(raw as CurrencyCode);
}

/**
 * The closed canonical commitment-kind vocabulary (Office-canonical,
 * provider-independent): a purchase order or a subcontract. Both are
 * commitments — contractual obligations to pay — differing only in kind.
 */
export type CommitmentKind = 'purchase-order' | 'subcontract';

/** All commitment kinds, in canonical order. */
export const COMMITMENT_KINDS: readonly CommitmentKind[] = [
  'purchase-order',
  'subcontract',
] as const;

/** Parse an untrusted value as a canonical commitment kind (total, fail-closed). */
export function parseCommitmentKind(raw: unknown): ParseResult<CommitmentKind> {
  if (raw === 'purchase-order' || raw === 'subcontract') {
    return parseOk(raw);
  }
  return parseFail(
    'invalid-value',
    '',
    "commitment kind: one of 'purchase-order', 'subcontract'",
    JSON.stringify(raw),
  );
}

/** The closed commitment status vocabulary: an obligation is active or closed. */
export type CommitmentStatus = 'active' | 'closed';

// ----- money bounds (integer minor units — never floats) -------------------------

/** Largest representable money amount: 10^12 integer minor units per line. */
export const AMOUNT_MINOR_MAX = 1_000_000_000_000;
/** Largest quantity: 10^9 integer milli-units (i.e. 1,000,000.000 units). */
export const QUANTITY_MILLI_MAX = 1_000_000_000;
/** Largest unit rate: 10^12 integer minor units per whole unit. */
export const UNIT_RATE_MINOR_MAX = 1_000_000_000_000;
/** Maximum number of cost items / lines in one budget or line set. */
export const LINE_COUNT_MAX = 10_000;

const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 500;
const NUMBER_MAX_LENGTH = 64;
const REFERENCE_MAX_LENGTH = 128;
const NUMBER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

const isAmountMinor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= AMOUNT_MINOR_MAX;

/**
 * The EXACT cost-item extension: quantity (integer milli-units) × unit rate
 * (integer minor units per whole unit), which must land on a whole integer
 * minor amount. Deterministic and fail-closed: a product that is not exactly
 * representable in integer minor units is a typed invariant-violation — the
 * canonical model never rounds money, so a commercial line whose extension
 * does not divide evenly must be re-expressed (a different quantity, rate, or
 * unit) rather than silently rounded.
 */
export function extensionMinorOf(
  quantityMilli: number,
  unitRateMinor: number,
  context?: DomainErrorContext,
): Result<number, DomainError> {
  const product = quantityMilli * unitRateMinor;
  if (!Number.isSafeInteger(product)) {
    return fail(
      invariantViolation(
        {
          name: 'cost-item-extension-representable',
          statement: `quantity ${quantityMilli} milli-units at unit rate ${unitRateMinor} minor units exceeds the exactly representable amount range`,
        },
        context,
      ),
    );
  }
  if (product % 1000 !== 0) {
    return fail(
      invariantViolation(
        {
          name: 'cost-item-extension-exact',
          statement: `quantity ${quantityMilli} milli-units at unit rate ${unitRateMinor} minor units does not extend to a whole minor amount (the canonical model never rounds money)`,
        },
        context,
      ),
    );
  }
  const amountMinor = product / 1000;
  if (amountMinor > AMOUNT_MINOR_MAX) {
    return fail(
      invariantViolation(
        {
          name: 'cost-item-amount-bounded',
          statement: `the extension ${amountMinor} minor units exceeds the maximum ${AMOUNT_MINOR_MAX}`,
        },
        context,
      ),
    );
  }
  return ok(amountMinor);
}

// ----- entity models --------------------------------------------------------------

/**
 * One canonical budget line. `quantityMilli` is the quantity in integer
 * milli-units (quantity × 1000 — three decimal places at most); `unitRateMinor`
 * is the integer unit rate in minor units per WHOLE unit; `amountMinor` is the
 * EXACT extension (see {@link extensionMinorOf}). Amounts are integers by
 * construction; there is no rounding anywhere in the model.
 */
export interface CostItemState {
  readonly entityId: EntityId;
  /** Unique cost-item code within the budget (1..64 chars, stable identity for humans). */
  readonly code: string;
  /** What the line buys (1..500 characters). */
  readonly description: string;
  /** Unit of measure label (1..32 characters, e.g. 'm3', 'lot'). */
  readonly unit: string;
  /** Quantity in integer milli-units (1..10^9): quantity × 1000. */
  readonly quantityMilli: number;
  /** Unit rate: integer minor units per whole unit (0..10^12). */
  readonly unitRateMinor: number;
  /** The exact extension: quantityMilli × unitRateMinor / 1000 (integer). */
  readonly amountMinor: number;
  readonly createdAt: Timestamp;
}

/**
 * One immutable budget revision: a FULL snapshot of the budget's cost items
 * at revision time, sorted by code (byte-stable read-back regardless of the
 * working set's insertion order). The chain works like document revisions and
 * schedule baselines: each revision carries `supersedes` pointing BACKWARD to
 * the revision it replaced; the budget root carries `currentRevisionId`. Old
 * revisions are never mutated — revising appends a new snapshot only.
 */
export interface BudgetRevisionState {
  readonly entityId: EntityId;
  /** Dense sequence (1, 2, 3, …) in revision-creation order. */
  readonly sequence: number;
  /** Human label (defaults deterministically to `Revision N`). */
  readonly label: string;
  /** The revision this one supersedes, or null for the first revision. */
  readonly supersedes: EntityId | null;
  /** The full cost-item snapshot, sorted by code. Immutable once landed. */
  readonly costItems: readonly CostItemState[];
  /** The acting actor's canonical id, or null for the system actor. */
  readonly createdBy: EntityId | null;
  readonly createdAt: Timestamp;
}

/**
 * THE Budget aggregate state: a project's canonical budget. The scope is
 * always the budget's OWN project scope ({ kind: 'project', tenantId,
 * projectId }); every mutation anywhere inside the budget (cost item
 * recorded, revision landed) bumps the root version — optimistic concurrency
 * guards the budget as a whole.
 */
export interface BudgetState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** Budget display name (1..200 characters). */
  readonly name: string;
  /** The single currency of this budget's commercial model (3 uppercase letters). */
  readonly currency: CurrencyCode;
  /** The CURRENT working set of cost items, keyed by canonical entity id. */
  readonly costItems: Readonly<Record<string, CostItemState>>;
  /** Immutable budget revisions keyed by canonical entity id. */
  readonly revisions: Readonly<Record<string, BudgetRevisionState>>;
  /** The current (chain-tip) revision id, or null before the first revision. */
  readonly currentRevisionId: EntityId | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * One commitment line: a committed amount against ONE budget cost item,
 * referenced through its canonical EntityId (a typed link — the budget is a
 * sibling aggregate, never an object reference).
 */
export interface CommitmentLineState {
  readonly entityId: EntityId;
  /** TYPED link to the referenced budget cost item. */
  readonly costItemId: EntityId;
  /** Line description (1..500 characters). */
  readonly description: string;
  /** Committed amount for this line, integer minor units (0..10^12). */
  readonly amountMinor: number;
}

/**
 * One immutable commitment line set: the FULL set of commitment lines that
 * became current at creation (sequence 1) or with one amendment (sequence
 * 2+), sorted by cost item id (byte-stable read-back). The chain is
 * append-only — amendments never rewrite a landed line set, and the CURRENT
 * commitment is always the chain tip (see {@link currentLineSetOf}).
 */
export interface CommitmentLineSetState {
  readonly entityId: EntityId;
  /** Dense sequence (1, 2, 3, …): 1 = creation, 2+ = amendments. */
  readonly sequence: number;
  /** Why the line set changed (1..500 characters), or null for the creation set. */
  readonly reason: string | null;
  /** The full line set, sorted by referenced cost item id. Immutable once landed. */
  readonly lines: readonly CommitmentLineState[];
  /** The acting actor's canonical id, or null for the system actor. */
  readonly recordedBy: EntityId | null;
  readonly recordedAt: Timestamp;
}

/**
 * THE Commitment aggregate state: a contractual obligation to pay, as a
 * canonical kind (purchase order or subcontract). Project-scoped; amendments
 * append line sets (version bumps); closing is terminal.
 */
export interface CommitmentState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The canonical commitment kind (never a provider document type). */
  readonly commitmentKind: CommitmentKind;
  /** Unique commitment number within the project (1..64 chars, e.g. 'PO-0001'). */
  readonly number: string;
  /** What the obligation covers (1..500 characters). */
  readonly description: string;
  /** active until closed; closed is terminal (no amendment after closing). */
  readonly status: CommitmentStatus;
  /** The commitment's currency — must match the referenced budget's currency. */
  readonly currency: CurrencyCode;
  /** Append-only line-set chain: [0] = creation, each amendment appends. */
  readonly lineSets: readonly CommitmentLineSetState[];
  /** The close reason, or null while active. */
  readonly closeReason: string | null;
  /** The injected-clock instant closing landed, or null while active. */
  readonly closedAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * One immutable invoice line: a billed amount. Invoice lines are recorded
 * once with the invoice and never change (no mutating transition exists).
 */
export interface InvoiceLineState {
  readonly entityId: EntityId;
  /** What is being billed on this line (1..500 characters). */
  readonly description: string;
  /** Billed amount for this line, integer minor units (0..10^12). */
  readonly amountMinor: number;
}

/**
 * One append-only payment reference: a record that `amountMinor` was paid
 * against the owning invoice, identified by an external payment reference
 * string. Payment references are never edited or deleted (no such transition
 * exists); the paid amount is COMPUTED from them (never stored as a counter).
 */
export interface PaymentReferenceState {
  readonly entityId: EntityId;
  /** External payment reference (1..128 chars, e.g. a trace or check number). */
  readonly reference: string;
  /** Amount paid by this reference, integer minor units (1..10^12). */
  readonly amountMinor: number;
  /** The instant the payment itself happened (never after it was recorded). */
  readonly paidAt: Timestamp;
  /** The injected-clock instant this reference was recorded. */
  readonly recordedAt: Timestamp;
}

/**
 * THE Invoice aggregate state: a billing record against ONE commitment,
 * referenced through its canonical EntityId (a typed link — the commitment is
 * a sibling aggregate, never an object reference). Lines are immutable once
 * recorded; payment references append against the invoice, bounded by the
 * not-overpaid invariant.
 */
export interface InvoiceState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** TYPED link to the commitment this invoice is billed against. */
  readonly commitmentId: EntityId;
  /** Unique invoice number within the project (1..64 chars, e.g. 'INV-0001'). */
  readonly number: string;
  /** What the invoice covers (1..500 characters). */
  readonly description: string;
  /** The invoice's currency — must match the referenced commitment's currency. */
  readonly currency: CurrencyCode;
  /** The invoice's lines — immutable once recorded. */
  readonly lines: readonly InvoiceLineState[];
  /** Issue date of the invoice, or null. */
  readonly issuedOn: Timestamp | null;
  /** Due date of the invoice, or null; must not precede the issue date. */
  readonly dueOn: Timestamp | null;
  /** Append-only payment references, oldest first. */
  readonly paymentReferences: readonly PaymentReferenceState[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

// ----- shared validation helpers (pure, deterministic) -----------------------------

const values = <T>(record: Readonly<Record<string, T>>): T[] => Object.values(record);

const sortedByCode = (items: readonly CostItemState[]): CostItemState[] =>
  [...items].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

const sortedByCostItemId = (items: readonly CommitmentLineState[]): CommitmentLineState[] =>
  [...items].sort((a, b) =>
    a.costItemId < b.costItemId ? -1 : a.costItemId > b.costItemId ? 1 : 0,
  );

/** Validate the reference integrity of one budget working set / revision snapshot. */
const costItemSetErrors = (
  costItems: readonly CostItemState[],
): { readonly name: string; readonly statement: string }[] => {
  const violations: { readonly name: string; readonly statement: string }[] = [];
  const codes = new Set<string>();
  for (const item of costItems) {
    if (codes.has(item.code)) {
      violations.push({
        name: 'cost-item-codes-unique',
        statement: `cost item code '${item.code}' is used more than once`,
      });
    }
    codes.add(item.code);
  }
  return violations;
};

/** Validate the shape of one commitment line set (unique cost-item links, bounded amounts). */
const commitmentLineSetErrors = (
  lineSet: CommitmentLineSetState,
): { readonly name: string; readonly statement: string }[] => {
  const violations: { readonly name: string; readonly statement: string }[] = [];
  const linked = new Set<string>();
  for (const line of lineSet.lines) {
    if (linked.has(line.costItemId)) {
      violations.push({
        name: 'commitment-lines-unique-cost-items',
        statement: `line set ${lineSet.entityId} references cost item ${line.costItemId} more than once`,
      });
    }
    linked.add(line.costItemId);
    if (!isAmountMinor(line.amountMinor)) {
      violations.push({
        name: 'commitment-line-amount-bounded',
        statement: `line ${line.entityId} of line set ${lineSet.entityId} carries an out-of-range amount`,
      });
    }
  }
  return violations;
};

// ----- declarative invariants ------------------------------------------------------

/**
 * Declarative invariants over any BudgetState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 * These re-validate, on every NEXT state, everything the pure transitions
 * guarantee structurally: vocabulary bounds, cost-item reference integrity,
 * revision-chain shape (dense sequences, backward supersedes, tip =
 * currentRevisionId), and immutable snapshot shape.
 */
export const BUDGET_INVARIANTS = [
  defineInvariant<BudgetState>(
    'budget-name-nonempty',
    'a budget name is 1..200 characters',
    (state) => state.name.length >= 1 && state.name.length <= NAME_MAX_LENGTH,
  ),
  defineInvariant<BudgetState>(
    'budget-is-project-scoped',
    'a budget is owned by exactly one project (project scope; the second authorization boundary)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<BudgetState>(
    'budget-version-is-monotonic',
    'a budget version is a positive integer (starts at 1, +1 per mutation of the budget)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
  defineInvariant<BudgetState>(
    'budget-currency-canonical',
    'a budget carries exactly one canonical three-letter currency code',
    (state) => CURRENCY_PATTERN.test(state.currency),
  ),
  defineInvariant<BudgetState>(
    'budget-cost-items-well-formed',
    'every cost item is bounded (code, unit, quantity, rate, exact integer amount) and codes are unique',
    (state) => {
      for (const item of values(state.costItems)) {
        if (
          item.code.length < 1 ||
          item.code.length > NUMBER_MAX_LENGTH ||
          !NUMBER_PATTERN.test(item.code) ||
          item.description.length < 1 ||
          item.description.length > DESCRIPTION_MAX_LENGTH ||
          item.unit.length < 1 ||
          item.unit.length > 32 ||
          !Number.isInteger(item.quantityMilli) ||
          item.quantityMilli < 1 ||
          item.quantityMilli > QUANTITY_MILLI_MAX ||
          !isAmountMinor(item.unitRateMinor) ||
          item.unitRateMinor > UNIT_RATE_MINOR_MAX ||
          !isAmountMinor(item.amountMinor)
        ) {
          return false;
        }
      }
      return costItemSetErrors(values(state.costItems)).length === 0;
    },
  ),
  defineInvariant<BudgetState>(
    'budget-revision-chain-well-formed',
    'revisions form a dense backward-supersedes chain whose tip is the current revision',
    (state) => {
      const revisions = values(state.revisions);
      const sequences = new Set<number>();
      for (const revision of revisions) {
        if (!Number.isInteger(revision.sequence) || revision.sequence < 1) return false;
        if (sequences.has(revision.sequence)) return false;
        sequences.add(revision.sequence);
        if (revision.supersedes !== null && state.revisions[revision.supersedes] === undefined) {
          return false;
        }
        if (
          revision.supersedes !== null &&
          state.revisions[revision.supersedes] !== undefined &&
          state.revisions[revision.supersedes]!.sequence >= revision.sequence
        ) {
          return false;
        }
        if (revision.costItems.length > LINE_COUNT_MAX) return false;
        if (costItemSetErrors(revision.costItems).length > 0) return false;
      }
      if (revisions.length !== sequences.size) return false;
      if (revisions.length === 0) return state.currentRevisionId === null;
      const maxSequence = Math.max(...revisions.map((revision) => revision.sequence));
      if (maxSequence !== revisions.length) return false;
      const tip = revisions.find((revision) => revision.sequence === maxSequence);
      return tip !== undefined && state.currentRevisionId === tip.entityId;
    },
  ),
] as const;

/**
 * Declarative invariants over any CommitmentState, in declaration order:
 * vocabulary bounds, append-only line-set chain shape (dense sequences), and
 * the closed-is-terminal shape (closedAt/closeReason present exactly when
 * closed).
 */
export const COMMITMENT_INVARIANTS = [
  defineInvariant<CommitmentState>(
    'commitment-is-project-scoped',
    'a commitment is owned by exactly one project (project scope; the second authorization boundary)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<CommitmentState>(
    'commitment-version-is-monotonic',
    'a commitment version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
  defineInvariant<CommitmentState>(
    'commitment-kind-canonical',
    "a commitment kind is one of 'purchase-order', 'subcontract'",
    (state) => COMMITMENT_KINDS.includes(state.commitmentKind),
  ),
  defineInvariant<CommitmentState>(
    'commitment-number-canonical',
    'a commitment number is 1..64 characters (alphanumeric, dot, underscore, colon, dash)',
    (state) =>
      state.number.length >= 1 &&
      state.number.length <= NUMBER_MAX_LENGTH &&
      NUMBER_PATTERN.test(state.number),
  ),
  defineInvariant<CommitmentState>(
    'commitment-currency-canonical',
    'a commitment carries exactly one canonical three-letter currency code',
    (state) => CURRENCY_PATTERN.test(state.currency),
  ),
  defineInvariant<CommitmentState>(
    'commitment-line-sets-append-only',
    'line sets form a dense append-only chain (at least the creation set), each referencing unique bounded cost items',
    (state) => {
      if (state.lineSets.length === 0) return false;
      let expected = 1;
      for (const lineSet of state.lineSets) {
        if (lineSet.sequence !== expected) return false;
        expected += 1;
        if (lineSet.lines.length > LINE_COUNT_MAX) return false;
        if (commitmentLineSetErrors(lineSet).length > 0) return false;
      }
      return true;
    },
  ),
  defineInvariant<CommitmentState>(
    'commitment-closed-is-terminal',
    'a closed commitment carries its close reason and instant; an active one carries neither',
    (state) => {
      if (state.status === 'closed') {
        return state.closedAt !== null && state.closeReason !== null;
      }
      return state.closedAt === null && state.closeReason === null;
    },
  ),
] as const;

/**
 * Declarative invariants over any InvoiceState, in declaration order:
 * vocabulary bounds, immutable line shape, chronological issue/due dates, the
 * append-only payment-reference log, and THE commercial bound — the total
 * referenced paid amount can never exceed the invoice total (structural
 * not-overpaid; the paid total itself is always COMPUTED, never stored).
 */
export const INVOICE_INVARIANTS = [
  defineInvariant<InvoiceState>(
    'invoice-is-project-scoped',
    'an invoice is owned by exactly one project (project scope; the second authorization boundary)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<InvoiceState>(
    'invoice-version-is-monotonic',
    'an invoice version is a positive integer (starts at 1, +1 per payment reference)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
  defineInvariant<InvoiceState>(
    'invoice-number-canonical',
    'an invoice number is 1..64 characters (alphanumeric, dot, underscore, colon, dash)',
    (state) =>
      state.number.length >= 1 &&
      state.number.length <= NUMBER_MAX_LENGTH &&
      NUMBER_PATTERN.test(state.number),
  ),
  defineInvariant<InvoiceState>(
    'invoice-currency-canonical',
    'an invoice carries exactly one canonical three-letter currency code',
    (state) => CURRENCY_PATTERN.test(state.currency),
  ),
  defineInvariant<InvoiceState>(
    'invoice-lines-immutable-shape',
    'invoice lines are recorded once (1..10000), each with a description and a bounded integer amount',
    (state) => {
      if (state.lines.length < 1 || state.lines.length > LINE_COUNT_MAX) return false;
      for (const line of state.lines) {
        if (
          line.description.length < 1 ||
          line.description.length > DESCRIPTION_MAX_LENGTH ||
          !isAmountMinor(line.amountMinor)
        ) {
          return false;
        }
      }
      return true;
    },
  ),
  defineInvariant<InvoiceState>(
    'invoice-dates-chronological',
    'an invoice due date never precedes its issue date',
    (state) =>
      state.issuedOn === null ||
      state.dueOn === null ||
      compareTimestamps(state.dueOn, state.issuedOn) >= 0,
  ),
  defineInvariant<InvoiceState>(
    'invoice-payment-references-append-only',
    'payment references are bounded, identified, and never recorded before the payment happened',
    (state) => {
      for (const payment of state.paymentReferences) {
        if (
          payment.reference.length < 1 ||
          payment.reference.length > REFERENCE_MAX_LENGTH ||
          !Number.isInteger(payment.amountMinor) ||
          payment.amountMinor < 1 ||
          payment.amountMinor > AMOUNT_MINOR_MAX ||
          compareTimestamps(payment.paidAt, payment.recordedAt) > 0
        ) {
          return false;
        }
      }
      return true;
    },
  ),
  defineInvariant<InvoiceState>(
    'invoice-not-overpaid',
    'the total referenced paid amount never exceeds the invoice total (computed, never stored)',
    (state) => paidAmountMinorOf(state) <= invoicedAmountMinorOf(state),
  ),
] as const;

// ----- pure transitions ------------------------------------------------------------

const checkBudget = (
  state: BudgetState,
  context?: DomainErrorContext,
): Result<BudgetState, DomainError> => checkInvariants(state, BUDGET_INVARIANTS, context);

const checkCommitment = (
  state: CommitmentState,
  context?: DomainErrorContext,
): Result<CommitmentState, DomainError> => checkInvariants(state, COMMITMENT_INVARIANTS, context);

const checkInvoice = (
  state: InvoiceState,
  context?: DomainErrorContext,
): Result<InvoiceState, DomainError> => checkInvariants(state, INVOICE_INVARIANTS, context);

/** Parts of a newly created budget (the canonical id is issued inside the handler). */
export interface NewBudget {
  readonly budgetId: EntityId;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly created budget (trusted path — the
 * payload was validated fail-closed upstream): an empty working set, no
 * revisions. The scope MUST be project scope; the invariant list enforces it.
 */
export function createBudgetState(
  input: NewBudget,
  scope: Scope,
  context?: DomainErrorContext,
): Result<BudgetState, DomainError> {
  const state: BudgetState = {
    entityKind: BUDGET_KIND,
    entityId: input.budgetId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    name: input.name,
    currency: input.currency,
    costItems: {},
    revisions: {},
    currentRevisionId: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkBudget(state, context);
}

/** Parts of a newly recorded cost item (the canonical id is issued inside the handler). */
export interface NewCostItem {
  readonly costItemId: EntityId;
  readonly code: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityMilli: number;
  readonly unitRateMinor: number;
  readonly now: Timestamp;
}

/**
 * Pure transition: record one cost item into the budget's CURRENT working
 * set. Rejects duplicate codes and non-exact extensions BEFORE any state
 * lands (typed invariant-violation; the input state is untouched). Recording
 * a cost item never touches a landed revision — revisions are snapshots.
 */
export function recordCostItemState(
  current: BudgetState,
  input: NewCostItem,
  context?: DomainErrorContext,
): Result<BudgetState, DomainError> {
  for (const item of values(current.costItems)) {
    if (item.code === input.code) {
      return fail(
        invariantViolation(
          {
            name: 'cost-item-codes-unique',
            statement: `cost item code '${input.code}' is already used by cost item ${item.entityId} of budget ${current.entityId}`,
          },
          context,
        ),
      );
    }
  }
  const amount = extensionMinorOf(input.quantityMilli, input.unitRateMinor, context);
  if (!amount.ok) return amount;
  const item: CostItemState = {
    entityId: input.costItemId,
    code: input.code,
    description: input.description,
    unit: input.unit,
    quantityMilli: input.quantityMilli,
    unitRateMinor: input.unitRateMinor,
    amountMinor: amount.value,
    createdAt: input.now,
  };
  const next: BudgetState = {
    ...current,
    costItems: { ...current.costItems, [input.costItemId]: item },
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkBudget(next, context);
}

/** Parts of a newly landed budget revision (the canonical id is issued inside the handler). */
export interface NewBudgetRevision {
  readonly revisionId: EntityId;
  readonly label?: string;
  readonly createdBy: EntityId | null;
  readonly now: Timestamp;
}

/**
 * Pure transition: revise the budget — snapshot the CURRENT working set into
 * a new immutable revision that supersedes the chain tip. The prior revision
 * is never mutated (there is no mutating transition for landed revisions;
 * see the always-forbidden guards below). The label defaults deterministically
 * to `Revision N`.
 */
export function reviseBudgetState(
  current: BudgetState,
  input: NewBudgetRevision,
  context?: DomainErrorContext,
): Result<BudgetState, DomainError> {
  const sequence = values(current.revisions).length + 1;
  const revision: BudgetRevisionState = {
    entityId: input.revisionId,
    sequence,
    label: input.label ?? `Revision ${sequence}`,
    supersedes: current.currentRevisionId,
    costItems: sortedByCode(values(current.costItems)),
    createdBy: input.createdBy,
    createdAt: input.now,
  };
  const next: BudgetState = {
    ...current,
    revisions: { ...current.revisions, [input.revisionId]: revision },
    currentRevisionId: input.revisionId,
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkBudget(next, context);
}

/**
 * Always-forbidden guard (acceptance: budget revisions are immutable): there
 * is no mutating transition for a landed revision, and this guard encodes
 * that absence as a typed `forbidden` result. Change flows through new
 * revisions only.
 */
export function updateBudgetRevisionState(
  current: BudgetState,
  revisionId: EntityId,
  context?: DomainErrorContext,
): Result<BudgetState, DomainError> {
  return fail(
    domainError(
      'forbidden',
      `revision ${revisionId} of budget ${current.entityId} cannot be edited: budget revisions are immutable once landed (revise the budget again instead)`,
      [
        {
          code: 'budget-revision-immutable',
          message: `attempted to edit revision ${revisionId}`,
          path: null,
        },
      ],
      context,
    ),
  );
}

/**
 * Always-forbidden guard (acceptance: budget revisions are immutable): a
 * landed revision can never be removed from the chain.
 */
export function removeBudgetRevisionState(
  current: BudgetState,
  revisionId: EntityId,
  context?: DomainErrorContext,
): Result<BudgetState, DomainError> {
  return fail(
    domainError(
      'forbidden',
      `revision ${revisionId} of budget ${current.entityId} cannot be removed: budget revisions are immutable once landed`,
      [
        {
          code: 'budget-revision-immutable',
          message: `attempted to remove revision ${revisionId}`,
          path: null,
        },
      ],
      context,
    ),
  );
}

/** One line of a new commitment line set (the canonical line id is issued inside the handler). */
export interface NewCommitmentLine {
  readonly lineId: EntityId;
  readonly costItemId: EntityId;
  readonly description: string;
  readonly amountMinor: number;
}

/** Parts of a newly created commitment (the canonical id is issued inside the handler). */
export interface NewCommitment {
  readonly commitmentId: EntityId;
  readonly number: string;
  readonly commitmentKind: CommitmentKind;
  readonly description: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly NewCommitmentLine[];
  readonly now: Timestamp;
  /** The acting actor's canonical id, or null for the system actor. */
  readonly createdBy: EntityId | null;
}

/**
 * Build the initial state of a newly created commitment (trusted path): the
 * creation line set (sequence 1) is the chain's first entry; the committed
 * amount is computed from the chain tip forever after. The scope MUST be
 * project scope; the invariant list enforces it.
 */
export function createCommitmentState(
  input: NewCommitment,
  scope: Scope,
  context?: DomainErrorContext,
): Result<CommitmentState, DomainError> {
  const lineSet: CommitmentLineSetState = {
    entityId: input.commitmentId,
    sequence: 1,
    reason: null,
    lines: sortedByCostItemId(
      input.lines.map((line) => ({
        entityId: line.lineId,
        costItemId: line.costItemId,
        description: line.description,
        amountMinor: line.amountMinor,
      })),
    ),
    recordedBy: input.createdBy,
    recordedAt: input.now,
  };
  const state: CommitmentState = {
    entityKind: COMMITMENT_KIND,
    entityId: input.commitmentId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    commitmentKind: input.commitmentKind,
    number: input.number,
    description: input.description,
    status: 'active',
    currency: input.currency,
    lineSets: [lineSet],
    closeReason: null,
    closedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkCommitment(state, context);
}

/** Parts of one commitment amendment (the canonical id is issued inside the handler). */
export interface NewCommitmentAmendment {
  readonly amendmentId: EntityId;
  readonly reason: string | null;
  readonly lines: readonly NewCommitmentLine[];
  readonly now: Timestamp;
  /** The acting actor's canonical id, or null for the system actor. */
  readonly amendedBy: EntityId | null;
}

/**
 * Pure transition: amend the commitment — append a new immutable line set
 * (the FULL replacement line set) to the append-only chain. Landed line sets
 * are never rewritten; the CURRENT commitment is the chain tip. Rejects a
 * closed commitment (closing is terminal) BEFORE any state lands.
 */
export function amendCommitmentState(
  current: CommitmentState,
  input: NewCommitmentAmendment,
  context?: DomainErrorContext,
): Result<CommitmentState, DomainError> {
  if (current.status === 'closed') {
    return fail(
      invariantViolation(
        {
          name: 'commitment-closed-is-terminal',
          statement: `commitment ${current.entityId} is closed and cannot be amended`,
        },
        context,
      ),
    );
  }
  const lineSet: CommitmentLineSetState = {
    entityId: input.amendmentId,
    sequence: current.lineSets.length + 1,
    reason: input.reason,
    lines: sortedByCostItemId(
      input.lines.map((line) => ({
        entityId: line.lineId,
        costItemId: line.costItemId,
        description: line.description,
        amountMinor: line.amountMinor,
      })),
    ),
    recordedBy: input.amendedBy,
    recordedAt: input.now,
  };
  const next: CommitmentState = {
    ...current,
    lineSets: [...current.lineSets, lineSet],
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkCommitment(next, context);
}

/** Parts of a commitment close. */
export interface NewCommitmentClose {
  readonly reason: string;
  readonly now: Timestamp;
}

/**
 * Pure transition: close the commitment (terminal). Rejects an already-closed
 * commitment BEFORE any state lands. A closed commitment keeps its whole
 * line-set chain readable — closing ends the obligation, not the history.
 */
export function closeCommitmentState(
  current: CommitmentState,
  input: NewCommitmentClose,
  context?: DomainErrorContext,
): Result<CommitmentState, DomainError> {
  if (current.status === 'closed') {
    return fail(
      invariantViolation(
        {
          name: 'commitment-closed-is-terminal',
          statement: `commitment ${current.entityId} is already closed`,
        },
        context,
      ),
    );
  }
  const next: CommitmentState = {
    ...current,
    status: 'closed',
    closeReason: input.reason,
    closedAt: input.now,
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkCommitment(next, context);
}

/** One line of a new invoice (the canonical line id is issued inside the handler). */
export interface NewInvoiceLine {
  readonly lineId: EntityId;
  readonly description: string;
  readonly amountMinor: number;
}

/** Parts of a newly recorded invoice (the canonical id is issued inside the handler). */
export interface NewInvoice {
  readonly invoiceId: EntityId;
  readonly commitmentId: EntityId;
  readonly number: string;
  readonly description: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly NewInvoiceLine[];
  readonly issuedOn: Timestamp | null;
  readonly dueOn: Timestamp | null;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly recorded invoice (trusted path): the
 * typed commitment link, the immutable line set, no payment references yet.
 * The scope MUST be project scope; the invariant list enforces it.
 */
export function createInvoiceState(
  input: NewInvoice,
  scope: Scope,
  context?: DomainErrorContext,
): Result<InvoiceState, DomainError> {
  const state: InvoiceState = {
    entityKind: INVOICE_KIND,
    entityId: input.invoiceId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    commitmentId: input.commitmentId,
    number: input.number,
    description: input.description,
    currency: input.currency,
    lines: input.lines.map((line) => ({
      entityId: line.lineId,
      description: line.description,
      amountMinor: line.amountMinor,
    })),
    issuedOn: input.issuedOn,
    dueOn: input.dueOn,
    paymentReferences: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvoice(state, context);
}

/**
 * Always-forbidden guard (acceptance: invoice lines are immutable): there is
 * no mutating transition for a recorded invoice line, and this guard encodes
 * that absence as a typed `forbidden` result.
 */
export function updateInvoiceLineState(
  current: InvoiceState,
  lineId: EntityId,
  context?: DomainErrorContext,
): Result<InvoiceState, DomainError> {
  return fail(
    domainError(
      'forbidden',
      `line ${lineId} of invoice ${current.entityId} cannot be edited: invoice lines are immutable once recorded`,
      [
        {
          code: 'invoice-line-immutable',
          message: `attempted to edit invoice line ${lineId}`,
          path: null,
        },
      ],
      context,
    ),
  );
}

/** Parts of one new payment reference (the canonical id is issued inside the handler). */
export interface NewPaymentReference {
  readonly paymentReferenceId: EntityId;
  readonly reference: string;
  readonly amountMinor: number;
  readonly paidAt: Timestamp;
  readonly now: Timestamp;
}

/**
 * Pure transition: append one payment reference to the invoice. Rejects an
 * over-paying reference (typed invariant-violation — the computed paid total
 * may never exceed the invoice total) BEFORE any state lands; the input state
 * is untouched on failure. Payment references are never edited or deleted
 * (no such transition exists).
 */
export function referencePaymentState(
  current: InvoiceState,
  input: NewPaymentReference,
  context?: DomainErrorContext,
): Result<InvoiceState, DomainError> {
  const total = invoicedAmountMinorOf(current);
  const paid = paidAmountMinorOf(current);
  if (paid + input.amountMinor > total) {
    return fail(
      invariantViolation(
        {
          name: 'invoice-not-overpaid',
          statement: `referencing payment ${input.amountMinor} minor units would raise the paid total to ${paid + input.amountMinor}, above the invoice total ${total} of invoice ${current.entityId}`,
        },
        context,
      ),
    );
  }
  const payment: PaymentReferenceState = {
    entityId: input.paymentReferenceId,
    reference: input.reference,
    amountMinor: input.amountMinor,
    paidAt: input.paidAt,
    recordedAt: input.now,
  };
  const next: InvoiceState = {
    ...current,
    paymentReferences: [...current.paymentReferences, payment],
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkInvoice(next, context);
}

// ----- deterministic derived reads (never stored as truth) ---------------------------

/**
 * The budget's current working-set cost items, sorted by code (byte-stable
 * order regardless of insertion order — deterministic reads).
 */
export const currentCostItemsOf = (budget: BudgetState): readonly CostItemState[] =>
  sortedByCode(values(budget.costItems));

/**
 * THE budget basis of record for balance computation: the CURRENT revision
 * (the immutable chain tip). Before the first revision lands there is no
 * revision — the working set is then the budget of record (it is exactly the
 * snapshot the first revision will anchor). Deterministic either way.
 */
export const budgetBasisOf = (budget: BudgetState): readonly CostItemState[] => {
  const revision = currentRevisionOf(budget);
  return revision === null ? currentCostItemsOf(budget) : revision.costItems;
};

/**
 * The budget's CURRENT revision (the chain tip), or null before the first
 * revision. Committed/invoiced balances are computed against THIS revision.
 */
export const currentRevisionOf = (
  budget: BudgetState,
): BudgetRevisionState | null => {
  if (budget.currentRevisionId === null) return null;
  return budget.revisions[budget.currentRevisionId] ?? null;
};

/** The commitment's CURRENT line set (the append-only chain's tip). */
export const currentLineSetOf = (
  commitment: CommitmentState,
): CommitmentLineSetState => {
  const tip = commitment.lineSets[commitment.lineSets.length - 1];
  if (tip === undefined) {
    throw new TypeError(
      `commitment ${commitment.entityId} has no line set (malformed state)`,
    );
  }
  return tip;
};

/** The commitment's CURRENT committed amount: the exact sum of the chain-tip line set. */
export const committedAmountMinorOf = (commitment: CommitmentState): number =>
  currentLineSetOf(commitment).lines.reduce(
    (sum, line) => sum + line.amountMinor,
    0,
  );

/** The invoice's total: the exact sum of its immutable lines. */
export const invoicedAmountMinorOf = (invoice: InvoiceState): number =>
  invoice.lines.reduce((sum, line) => sum + line.amountMinor, 0);

/** The total paid against the invoice: the exact sum of its payment references. */
export const paidAmountMinorOf = (invoice: InvoiceState): number =>
  invoice.paymentReferences.reduce((sum, payment) => sum + payment.amountMinor, 0);

/**
 * The commitment's outstanding invoiced amount: the exact sum over the
 * invoices referencing it (passed by the caller — the read layer loads them),
 * minus the paid totals. Deterministic pure fold of the recorded state.
 */
export const outstandingInvoicedMinorOf = (
  invoices: readonly InvoiceState[],
): number =>
  invoices.reduce(
    (sum, invoice) => sum + (invoicedAmountMinorOf(invoice) - paidAmountMinorOf(invoice)),
    0,
  );

/** Typed not-found for a budget (store backstop reads). */
export const budgetNotFound = (
  budgetId: EntityId,
  context?: DomainErrorContext,
): DomainError =>
  entityNotFound({ entityKind: BUDGET_KIND, entityId: budgetId }, context);

/** Typed not-found for a commitment (store backstop reads). */
export const commitmentNotFound = (
  commitmentId: EntityId,
  context?: DomainErrorContext,
): DomainError =>
  entityNotFound({ entityKind: COMMITMENT_KIND, entityId: commitmentId }, context);

/** Typed not-found for an invoice (store backstop reads). */
export const invoiceNotFound = (
  invoiceId: EntityId,
  context?: DomainErrorContext,
): DomainError =>
  entityNotFound({ entityKind: INVOICE_KIND, entityId: invoiceId }, context);
