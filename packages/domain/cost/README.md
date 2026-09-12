# @office/domain-cost

The Office cost/budget/commitment domain module (OFF-011): the canonical,
**provider-independent** commercial model of a construction project — one
project-scoped `Budget` aggregate with immutable budget **revisions**,
`Commitment` aggregates (purchase orders and subcontracts as canonical kinds),
`Invoice` models with immutable lines and append-only payment references, and
**deterministic** committed-vs-budget / invoiced-vs-committed balance
computation. Pure domain: no SQL, no wall clock, no randomness, no provider
vocabulary — provider import (accounting/ERP tools) happens in adapter
packages owned elsewhere, never here. This module is the recorded commercial
truth OFF-014's margin engine computes impacts from.

## Why this package exists

Freeze A1/A2 make the commercial model a first-class part of the Construction
Project Graph: budgets, cost items, commitments, invoices and payments are the
recorded facts every cost question (committed vs budgeted, invoiced vs
committed, over-commitment, over-invoicing, outstanding) is answered from —
deterministically, from the recorded state, never from stored counters that
can drift. Three project-scoped aggregate roots own that truth:

- **Budget** — ONE per project: a working set of cost items plus a chain of
  immutable budget REVISIONS (full snapshots chained backward through
  `supersedes`; the root carries `currentRevisionId`).
- **Commitment** — a contractual obligation to pay (purchase order or
  subcontract), whose line sets form an append-only chain; the CURRENT
  commitment is the chain tip.
- **Invoice** — a billing record against ONE commitment (typed link), with
  immutable lines and an append-only payment-reference log bounded by the
  not-overpaid invariant.

## Public surface

`src/index.ts` is the package's whole public surface — consume the package
only through its root entry point, never through deeper paths.

| Area | Exports |
| --- | --- |
| State | `BudgetState`, `CostItemState`, `BudgetRevisionState`, `CommitmentState`, `CommitmentLineState`, `CommitmentLineSetState`, `InvoiceState`, `InvoiceLineState`, `PaymentReferenceState`, `CurrencyCode`, `CommitmentKind`, `CommitmentStatus`, the nine entity-kind constants, the money/line bounds (`AMOUNT_MINOR_MAX`, `QUANTITY_MILLI_MAX`, `UNIT_RATE_MINOR_MAX`, `LINE_COUNT_MAX`), `BUDGET_INVARIANTS`, `COMMITMENT_INVARIANTS`, `INVOICE_INVARIANTS`, the `New*` input types, `extensionMinorOf`, the pure transitions (`createBudgetState`, `recordCostItemState`, `reviseBudgetState`, `createCommitmentState`, `amendCommitmentState`, `closeCommitmentState`, `createInvoiceState`, `referencePaymentState`), the always-failing immutability guards (`updateBudgetRevisionState`, `removeBudgetRevisionState`, `updateInvoiceLineState`), the typed not-found builders, and the derived reads (`currentCostItemsOf`, `budgetBasisOf`, `currentRevisionOf`, `currentLineSetOf`, `committedAmountMinorOf`, `invoicedAmountMinorOf`, `paidAmountMinorOf`, `outstandingInvoicedMinorOf`) |
| Events | `EventSink` (the port), `InMemoryEventSink`, `RecordedEventAppend`, `createInMemoryEventSink`, `failingEventSink`, `eventSinkFailure`, the 8 event-name constants, `costEventEnvelope`, the ref builders (`budgetRef`, `budgetRevisionRef`, `costItemRef`, `commitmentRef`, `commitmentAmendmentRef`, `invoiceRef`, `paymentReferenceRef`) and the payload types (`CostEventPayloads`) |
| Store | `CostStore`, `CostStoreTransaction`, `createInMemoryCostStore`, `InMemoryCostStore` |
| Balances | `committedVsBudget`, `invoicedVsCommitted`, `costPosition` (THE cost-impact interface OFF-014 consumes) and their row/total types (`CommittedVsBudget`, `CostItemBalance`, `InvoicedVsCommitted`, `CommitmentBalance`, `CostPosition`) |
| Commands | `CostCommands`, `createCostCommands`, `CostCommandDeps`, `CostCommandAuthorization`, the 8 command-name constants, the payload types and their fail-closed parsers |
| Ledger sink | `createLedgerEventSink` (the thin OFF-005-backed EventSink adapter) |

Dependencies: exactly five workspace packages — `@office/contracts`,
`@office/domain-kernel`, `@office/authz`, `@office/events` (the ledger-backed
EventSink adapter only) and `@office/persistence` (the `SqlExecutor` type of
the mirrored EventSink port) — plus node builtins. No external dependencies;
no domain-to-domain imports (cross-entity references are TYPED `EntityId`
links — the EventSink port is shape-mirrored from the identity modules, never
imported from them); no provider vocabulary (freeze A5: purchase orders and
subcontracts are Office-canonical commitment kinds, never provider document
types).

## The canonical commercial contract

- **Money is integer minor units** plus a canonical three-letter currency
  code — never floating point. A cost item carries a quantity in integer
  milli-units (quantity × 1000) and an integer unit rate (minor units per
  whole unit); its amount is the EXACT extension
  (`quantityMilli × unitRateMinor / 1000`). An extension that does not divide
  evenly is a typed `invariant-violation` — the model never rounds money.
- **Commitment kinds** are the closed canonical vocabulary
  `'purchase-order' | 'subcontract'` — contractual obligations to pay that
  differ only in kind, never provider document types.
- **Commitment lines** reference budget cost items through TYPED `EntityId`
  links (the budget is a sibling aggregate, never an object reference); every
  line must reference a cost item of the addressed budget's current working
  set, and the commitment's currency must match the budget's — checked
  BEFORE any state lands.

## Budget-revision semantics (immutable revisions)

A revision is a FULL snapshot of the budget's cost items at revision time,
sorted by code (byte-stable read-back regardless of insertion order), carrying
a dense sequence (1, 2, 3, …) and a backward `supersedes` pointer. Revising
APPENDS a new revision that supersedes the chain tip and moves
`currentRevisionId`; a landed revision is never edited or deleted — no
mutating transition exists, and the explicit guards
`updateBudgetRevisionState` / `removeBudgetRevisionState` encode that absence
as always-failing typed `forbidden` results. Change flows through working-set
edits (draft) + new revisions (anchor) only.

## Commitment, invoice, and payment semantics

- **Commitments**: creation lands line-set 1 (the creation set); amending
  APPENDS a full replacement line set (sequence 2, 3, …) — landed sets are
  never rewritten, and the CURRENT commitment is always the chain tip.
  Closing is TERMINAL: a closed commitment keeps its whole line-set chain
  readable (closing ends the obligation, not the history) and rejects
  further amendments typed.
- **Invoices**: recorded once against an ACTIVE commitment (a closed
  commitment cannot be billed) whose currency matches; lines are immutable
  (the `updateInvoiceLineState` guard is always-forbidden); issue/due dates
  are chronological.
- **Payment references**: append-only records that `amountMinor` was paid
  against the invoice under an external reference string; the paid instant
  can never be after the recording instant, and the total referenced can
  never exceed the invoice total (the not-overpaid invariant — the paid
  total is always COMPUTED from the references, never stored).

## Computed balances (never stored counters)

THE canonical balance rule: committed-vs-budget and invoiced-vs-committed
balances are DETERMINISTIC pure functions of the recorded state — they are
never stored as mutable counters that can drift from the recorded lines.

- `committedVsBudget(budget, commitments)` folds the budget's BASIS OF RECORD
  — the CURRENT revision (the immutable chain tip; before the first
  revision, the working set, which is exactly what the first revision will
  anchor) — against the chain-tip line set of every commitment. Rows are
  sorted by code then cost-item id, so shuffled commitment input yields the
  byte-identical answer. A commitment line referencing a cost item the
  current revision no longer contains still counts as committed money: its
  row shows zero budget — the over-commitment signal.
- `invoicedVsCommitted(commitments, invoices)` folds each commitment's
  current committed amount against the invoices referencing it (their
  immutable totals, their payment references). Rows are sorted by commitment
  id; invoice input order never matters.
- `costPosition(budget, commitments, invoices)` is THE cost-impact read model
  OFF-014's margin engine consumes: one deterministic snapshot of the
  project's whole commercial position (budgeted/committed/invoiced/paid,
  remaining budget, variances, outstanding, over-committed cost items,
  over-invoiced commitments) plus both full breakdowns.

Run any of them twice, or over shuffled inputs: byte-identical output.

## Commands, authorization, and concurrency

Every mutation runs the canonical path: parse the payload **fail-closed**
(strict keys; malformed input is a typed `invariant-violation`, never a
silent default) → authorize through `@office/authz`'s deny-by-default
`authorize()` (structural A12 isolation first, explicit deny, allow, default
deny — a denied command never opens a transaction) → load through the
scope-guarded store → optimistic concurrency (`expectedVersion`; stale →
typed `concurrency-conflict`, the recorded commercial state is never silently
overwritten) → the invariant-checked pure transition (including the
cross-aggregate commercial gates) → store write + event append inside ONE
transaction (a failure anywhere rolls everything back — zero partial state).

**Budget-revision authorization** (acceptance): revising the budget passes a
SECOND, distinct, stronger gate — the project-area write capability
(`projects.write`) in addition to the cost-area write capability
(`cost.write`): re-anchoring a project's whole budget of record is a
high-impact commercial decision, and an actor holding only the cost
capability can record items, commitments, invoices and payments but is
denied revising with a typed `forbidden`.

**A12 isolation**: the store is scope-guarded — a foreign tenant's or foreign
project's budget/commitment/invoice loads as a typed `not-found` (invisible,
no existence oracle) in BOTH directions, and a tenant-scoped create must name
its project while a project-scoped create initializes exactly its own project
(a payload naming another project is a typed `unauthorized` second-boundary
violation). One budget per project; commitment and invoice numbers are
unique per project.

## Audit events + the EventSink port

Every mutation emits exactly one `DomainEventEnvelope` (freeze A3) through the
injected **EventSink port** — `appendEvents(executor, events)` inside the SAME
transaction as the store write, so a sink failure aborts the mutation with
zero partial state (proven by tests): event name, the aggregate's OWN project
scope, actor, `source: 'domain'`, the correlation id carried over from the
command's causal chain with the causation id = the command's idempotency key
(the OFF-005 ledger convention), schema version, occurred-at (injected
clock), and before/after `EntityRef`s per transition kind. Every cost event
payload carries the OWNING aggregate-root id — budget events the `budgetId`,
commitment events the `commitmentId`, invoice events the `invoiceId` — the
ledger aggregate stream keys of the three roots (payloads may ADDITIONALLY
reference a sibling root: a commitment-created event names its budget; an
invoice event names its commitment).

The port is minimal and shape-mirrored from the landed identity modules. This
package ships three implementations:

- `createInMemoryEventSink()` — records appends instead of writing (tests);
- `failingEventSink(reason)` — a typed always-failing sink (failure-path
  tests/limits);
- `createLedgerEventSink()` — the REAL thin adapter over `@office/events`:
  appends each event to the OFF-005 event ledger and enqueues its
  transactional-outbox record, per envelope, inside the caller's transaction.
  It derives each event's ledger aggregate stream from the payload's owning
  root id (invoice, then commitment, then budget — owning root wins over the
  sibling references) and fails closed (typed `invariant-violation`) when
  handed an envelope that carries none.

## Storage

This package is PURE DOMAIN: it ships NO migrations and NO SQL. The
`CostStore` port (with the in-memory implementation) is the transactional
seam a later wiring implements over PostgreSQL; the in-memory store's
transactions refuse SQL by design (wire the ledger sink to a real persistence
transaction). A production wiring composes: a SQL-backed `CostStore`, the
ledger event sink, the migrator, and the id/clock suppliers (wall clock +
crypto randomness there; fixed values in tests).

## Tests

The suite is deterministic and in-memory (no database, no `DATABASE_URL`):

```bash
pnpm test                                  # whole workspace, includes this package
pnpm vitest run packages/domain/cost       # this package only
```

- `src/state.test.ts` — the exact-integer money rule (no rounding, ever),
  cost-item recording (duplicate codes, non-exact extensions), the immutable
  budget-revision chain (append + byte-identical read-back of prior
  revisions), the always-forbidden immutability guards, the commitment
  lifecycle (append-only line sets, closed-is-terminal), immutable invoice
  lines, the not-overpaid payment bound, and the derived reads.
- `src/balances.test.ts` — the deterministic balance folds: current-revision
  basis, the over-commitment signal for cost items absent from the current
  revision, amendment-following committed amounts, run-twice + shuffled-input
  byte-identity, and the cost-impact read model.
- `src/events.test.ts` — the envelope builder (scope/actor/source/causality
  propagation, before/after refs), the event vocabulary, the ref builders,
  and the in-memory/failing sink ports.
- `src/commands.test.ts` — fail-closed payload parsing for all eight
  commands, the command-name guard, authorization (default deny, explicit
  deny, undeclared capability; the DISTINCT stronger budget-revision
  capability), create-scope rules (one budget per project), A12 cross-tenant
  and cross-project typed not-found in BOTH directions, optimistic
  concurrency, malformed payloads, and the cross-aggregate commercial gates.
- `src/integration.test.ts` — the full in-memory commercial lifecycle (one
  audit event per mutation with complete envelope assertions),
  budget-revision immutability + re-revision chain, the failing-sink abort
  (state + ledger atomicity, zero partial state), deterministic run-twice
  balances from the current revision, and deterministic end-to-end replay of
  the identical command sequence (identical states AND event streams).
- `src/ledger-sink.test.ts` — the ledger-backed EventSink adapter at the
  shape level against a fake executor (per-envelope sequence upsert + ledger
  insert + outbox insert in the caller's transaction; the owning-root stream
  derivation incl. the sibling-reference precedence; the fail-closed payload
  guard; typed outbox-failure mapping).
- `src/boundary.test.ts` — the package boundary self-gate: exactly the five
  allowed workspace dependencies, no domain-to-domain imports, no provider
  vocabulary, no migrations/SQL, source entry point only.
