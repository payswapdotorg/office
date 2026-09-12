// Office cost domain — public surface (OFF-011).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-012 contracts/change, OFF-013 relationships, OFF-014 margin/impact,
// OFF-016 workflows, OFF-019 exception detection, OFF-020+/OFF-024 financial
// adapters) consume the package only through its root entry point, never
// through deeper paths. Anything not re-exported here is package-internal
// and may change without notice.
//
// The package imports exactly five workspace dependencies — @office/contracts
// (envelopes + canonical ids), @office/domain-kernel (Result/DomainError,
// aggregate versioning + concurrency, invariants), @office/authz (the
// deny-by-default authorize() evaluator), @office/events (the thin
// ledger-backed EventSink adapter only — the aggregates, commands and tests
// never touch it), and @office/persistence (the SqlExecutor type of the
// mirrored EventSink port) — plus node builtins. No external dependencies;
// no domain-to-domain imports (the EventSink port is shape-mirrored from the
// identity modules, never imported from them); no provider vocabulary — the
// commercial contract is Office-canonical and provider-independent (freeze
// A5; provider import happens in adapter packages owned elsewhere).
//
// Surface summary:
// - state:       BudgetState, CostItemState, BudgetRevisionState,
//                CommitmentState, CommitmentLineState,
//                CommitmentLineSetState, InvoiceState, InvoiceLineState,
//                PaymentReferenceState, CurrencyCode, CommitmentKind,
//                CommitmentStatus, the nine entity-kind constants, the
//                money/line bounds, BUDGET/COMMITMENT/INVOICE_INVARIANTS,
//                the New* input types, extensionMinorOf, the pure
//                transitions (create/record/revise/amend/close/reference),
//                the always-forbidden immutability guards, and the derived
//                reads (currentCostItemsOf, budgetBasisOf, currentRevisionOf,
//                currentLineSetOf, committedAmountMinorOf,
//                invoicedAmountMinorOf, paidAmountMinorOf,
//                outstandingInvoicedMinorOf)
// - events:      EventSink, InMemoryEventSink, RecordedEventAppend,
//                createInMemoryEventSink, failingEventSink, eventSinkFailure,
//                the 8 event-name constants, costEventEnvelope, the ref
//                builders (+ payload types, CostEventPayloads)
// - store:       CostStore, CostStoreTransaction, createInMemoryCostStore,
//                InMemoryCostStore
// - balances:    CostItemBalance, CommittedVsBudget, CommitmentBalance,
//                InvoicedVsCommitted, CostPosition, committedVsBudget,
//                invoicedVsCommitted, costPosition (THE cost-impact
//                interface OFF-014 consumes)
// - commands:    CostCommands, createCostCommands, CostCommandDeps,
//                CostCommandAuthorization, the 8 command-name constants
//                (+ payload types, line-input types, and their fail-closed
//                parsers)
// - ledger-sink: createLedgerEventSink (the thin OFF-005-backed EventSink)

// Aggregate state, invariants, and pure commercial transitions (including
// the revision/line-set immutability guards and the deterministic derived
// reads).
export {
  AMOUNT_MINOR_MAX,
  BUDGET_INVARIANTS,
  BUDGET_KIND,
  BUDGET_REVISION_KIND,
  COMMITMENT_AMENDMENT_KIND,
  COMMITMENT_INVARIANTS,
  COMMITMENT_KIND,
  COMMITMENT_KINDS,
  COMMITMENT_LINE_KIND,
  COST_ITEM_KIND,
  INVOICE_INVARIANTS,
  INVOICE_KIND,
  INVOICE_LINE_KIND,
  LINE_COUNT_MAX,
  PAYMENT_REFERENCE_KIND,
  QUANTITY_MILLI_MAX,
  UNIT_RATE_MINOR_MAX,
  amendCommitmentState,
  budgetBasisOf,
  budgetNotFound,
  closeCommitmentState,
  committedAmountMinorOf,
  commitmentNotFound,
  createBudgetState,
  createCommitmentState,
  createInvoiceState,
  currentCostItemsOf,
  currentLineSetOf,
  currentRevisionOf,
  extensionMinorOf,
  invoicedAmountMinorOf,
  invoiceNotFound,
  outstandingInvoicedMinorOf,
  paidAmountMinorOf,
  parseCommitmentKind,
  parseCurrencyCode,
  recordCostItemState,
  referencePaymentState,
  removeBudgetRevisionState,
  reviseBudgetState,
  updateBudgetRevisionState,
  updateInvoiceLineState,
} from './state';
export type {
  BudgetRevisionState,
  BudgetState,
  CommitmentKind,
  CommitmentLineSetState,
  CommitmentLineState,
  CommitmentState,
  CommitmentStatus,
  CostItemState,
  CurrencyCode,
  InvoiceLineState,
  InvoiceState,
  NewBudget,
  NewBudgetRevision,
  NewCommitment,
  NewCommitmentAmendment,
  NewCommitmentClose,
  NewCommitmentLine,
  NewCostItem,
  NewInvoice,
  NewInvoiceLine,
  NewPaymentReference,
  PaymentReferenceState,
} from './state';

// Audit events + THE EventSink port (minimal; mirrored from the identity
// modules; the OFF-005 ledger implements it directly or via ledger-sink.ts).
export {
  BUDGET_CREATED_EVENT,
  BUDGET_REVISED_EVENT,
  COMMITMENT_AMENDED_EVENT,
  COMMITMENT_CLOSED_EVENT,
  COMMITMENT_CREATED_EVENT,
  COST_ITEM_RECORDED_EVENT,
  INVOICE_RECORDED_EVENT,
  PAYMENT_REFERENCED_EVENT,
  budgetRef,
  budgetRevisionRef,
  commitmentAmendmentRef,
  commitmentRef,
  costEventEnvelope,
  costItemRef,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  invoiceRef,
  paymentReferenceRef,
} from './events';
export type {
  BudgetCreatedPayload,
  BudgetRevisedPayload,
  BudgetEventPayload,
  CommitmentAmendedPayload,
  CommitmentClosedPayload,
  CommitmentCreatedPayload,
  CostEventPayloads,
  CostItemRecordedPayload,
  EventSink,
  InMemoryEventSink,
  InvoiceRecordedPayload,
  PaymentReferencedPayload,
  RecordedEventAppend,
} from './events';

// The pure-domain transactional store port + the in-memory implementation.
export { createInMemoryCostStore } from './store';
export type {
  CostStore,
  CostStoreTransaction,
  InMemoryCostStore,
} from './store';

// The deterministic balance computations + THE cost-impact read model.
export {
  committedVsBudget,
  costPosition,
  invoicedVsCommitted,
} from './balances';
export type {
  CommitmentBalance,
  CommittedVsBudget,
  CostItemBalance,
  CostPosition,
  InvoicedVsCommitted,
} from './balances';

// Mutation command handlers (parse → authorize → load scoped → concurrency →
// pure transition → store write + event append inside ONE transaction).
export {
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
export type {
  AmendCommitmentPayload,
  CloseCommitmentPayload,
  CommitmentLineInput,
  CostCommandAuthorization,
  CostCommandDeps,
  CostCommands,
  CreateBudgetPayload,
  CreateCommitmentPayload,
  InvoiceLineInput,
  RecordCostItemPayload,
  RecordInvoicePayload,
  ReferencePaymentPayload,
  ReviseBudgetPayload,
} from './commands';

// The thin ledger-backed EventSink adapter (appendEvent + enqueueOutbox per
// envelope, inside the caller's transaction).
export { createLedgerEventSink } from './ledger-sink';
