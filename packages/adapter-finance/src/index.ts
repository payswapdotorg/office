// Office adapter-finance — public surface (OFF-024).
//
// src/index.ts is the package's WHOLE public surface: the adapter runtime
// (OFF-037 integration fabric), the SDK engines, and tests consume the
// package only through its root entry point, never through deeper paths.
// Anything not re-exported here is package-internal and may change without
// notice.
//
// The package imports exactly three workspace dependencies —
// @office/adapters-sdk (THE Adapter contract, engines, and ports it
// implements), @office/contracts (ids/scope/timestamps/command names), and
// @office/domain-kernel (Result/DomainError) — plus the node:crypto digest
// builtin for the deterministic webhook signature/checksum and conflict-id
// derivations. No new external dependencies; no I/O, no SQL, no clock, no
// randomness (injected ports everywhere).
//
// Surface summary:
// - vocabulary:         the generic ERP/finance identity vocabulary (adapter
//                       kind 'erp-finance', system 'erp-instance-01', object
//                       kinds account/cost-code/commitment/invoice/payment),
//                       the canonical kinds they map into, the landed
//                       canonical command names, the object MAPPING TABLE,
//                       and the validated AdapterCapabilities declaration
// - parse:              (internal — not re-exported)
// - provider-fixture:   the deterministic in-memory ERP provider store
//                       (accounts, cost codes, commitments, invoices with
//                       revision history, payments; monotonic versions;
//                       tombstones; wire-format webhook emission;
//                       degrade/recover for the health surface)
// - snapshot-translation: provider object → ProviderSnapshot (the neutral
//                       observation seam) + the shared per-kind provider-data
//                       view (extension bag / webhook payload)
// - mappings:           financial reference mapping (provider ids → canonical
//                       EntityIds; tenant-scoped; remaps are typed collisions)
//                       + the AdapterCommandTranslator implementation —
//                       account/cost-code/commitment/invoice/payment → typed
//                       canonical command proposals, with fail-closed
//                       per-kind provider-data parsers
// - adapter:            the Adapter implementation over one injected provider
//                       store (capabilities declaration, typed lifecycle
//                       transitions, positional replay-safe sync paging)
// - sync:               runFinanceSync + THE source-version ledger — the
//                       source-version-mapped, NON-DUPLICATING financial
//                       synchronization (the named acceptance) and its
//                       counted, typed-deduplicated duplicate surface
// - reconciliation:     the reconciliation interfaces — the pure deterministic
//                       projection comparing provider balance facts against
//                       canonical balance facts into typed discrepancy records
// - conflict-discipline: the explicit finance conflict discipline — records
//                       carrying BOTH sides for material commercial state
//                       (amount mismatch / concurrent edit / reference remap),
//                       with exactly ONE explicit resolution path and NO
//                       auto-resolution anywhere
// - webhook-ingest:     the ERP wire format + signature conventions, the
//                       fail-closed wire → ProviderWebhookBody translation,
//                       and ingestErpWebhook (signature → translation →
//                       source-version dedup → divergence conflict records →
//                       SDK intake engine → ledger closure)

// The generic ERP/finance vocabulary + the object mapping table.
export {
  ACCOUNT_CANONICAL_KIND,
  ACCOUNT_CREATE_COMMAND,
  ACCOUNT_OBJECT_KIND,
  ACCOUNT_UPDATE_COMMAND,
  COMMITMENT_CANONICAL_KIND,
  COMMITMENT_CREATE_COMMAND,
  COMMITMENT_DELETE_COMMAND,
  COMMITMENT_OBJECT_KIND,
  COMMITMENT_UPDATE_COMMAND,
  COST_CODE_CANONICAL_KIND,
  COST_CODE_CREATE_COMMAND,
  COST_CODE_OBJECT_KIND,
  FINANCE_ADAPTER_KIND,
  FINANCE_CAPABILITIES,
  FINANCE_CAPABILITY_NAMES,
  FINANCE_OBJECT_KINDS,
  FINANCE_OBJECT_MAPPINGS,
  FINANCE_SYSTEM_ID,
  INVOICE_CANONICAL_KIND,
  INVOICE_CREATE_COMMAND,
  INVOICE_OBJECT_KIND,
  PAYMENT_CANONICAL_KIND,
  PAYMENT_CREATE_COMMAND,
  PAYMENT_OBJECT_KIND,
  financeObjectMappingOf,
} from './vocabulary';
export type { FinanceObjectMapping } from './vocabulary';

// The deterministic in-memory ERP provider fixture.
export { createErpProviderStore } from './provider-fixture';
export type {
  ErpAccountObject,
  ErpCommitmentLine,
  ErpCommitmentObject,
  ErpCostCodeObject,
  ErpEventKind,
  ErpInvoiceLine,
  ErpInvoiceObject,
  ErpPaymentObject,
  ErpProviderObject,
  ErpProviderStore,
} from './provider-fixture';

// The snapshot translation seam.
export { financeObjectViewOf, financeSnapshotOf } from './snapshot-translation';
export type { FinanceObjectView } from './snapshot-translation';

// The financial reference mapping + the command translation.
export {
  bindFinanceReference,
  createFinanceTranslator,
  parseAccountProviderData,
  parseCommitmentProviderData,
  parseCostCodeProviderData,
  parseInvoiceProviderData,
  parsePaymentProviderData,
  resolveFinanceReference,
} from './mappings';
export type {
  AccountProviderData,
  CommitmentLineData,
  CommitmentProviderData,
  CostCodeProviderData,
  InvoiceLineData,
  InvoiceProviderData,
  PaymentProviderData,
} from './mappings';

// The Adapter implementation.
export { createFinanceAdapter } from './adapter';
export type { FinanceAdapterParts } from './adapter';

// THE source-version-mapped, non-duplicating financial sync.
export {
  MAX_SYNC_PAGES_PER_STREAM,
  createInMemoryProviderVersionLedger,
  createVersionMappedSyncAdapter,
  runFinanceSync,
} from './sync';
export type {
  DuplicateObservationReason,
  DuplicateVersionObservation,
  FinanceSyncCounts,
  FinanceSyncDeps,
  FinanceSyncReport,
  FinanceSyncRequest,
  FinanceStreamReport,
  ProviderVersionLedger,
  VersionLedgerEntry,
  VersionMappedAdapter,
} from './sync';

// The reconciliation interfaces.
export { reconcileFinanceBalances } from './reconciliation';
export type {
  BalanceComparison,
  CanonicalBalanceFact,
  FinanceDiscrepancy,
  FinanceDiscrepancyKind,
  FinanceReconciliationCounts,
  FinanceReconciliationReport,
  ProviderBalanceFact,
} from './reconciliation';

// The explicit conflict discipline (no auto-resolution, ever).
export {
  FINANCIAL_CONFLICT_GRAMMAR,
  FINANCIAL_CONFLICT_ID_GRAMMAR,
  FINANCIAL_CONFLICT_RESOLUTION_GRAMMAR,
  amountMismatchConflictsOf,
  createInMemoryFinancialConflictStore,
  detectedAmountMismatchConflict,
  detectedConcurrentEditConflict,
  detectedReferenceRemapConflict,
  financialConflictId,
  financialConflictIdOf,
  isFinancialConflict,
  isFinancialConflictId,
  isFinancialConflictResolution,
  parseFinancialConflict,
  parseFinancialConflictId,
  parseFinancialConflictResolution,
  resolveFinancialConflict,
} from './conflict-discipline';
export type {
  FinancialConflict,
  FinancialConflictCanonicalSide,
  FinancialConflictId,
  FinancialConflictProviderSide,
  FinancialConflictReason,
  FinancialConflictResolution,
  FinancialConflictResolutionStrategy,
  FinancialConflictSides,
  FinancialConflictState,
  FinancialConflictStore,
} from './conflict-discipline';

// The ERP webhook ingest.
export {
  ERP_TRANSLATION_CHECKSUM_HEADER,
  ERP_WEBHOOK_SIGNATURE_HEADER,
  ERP_WEBHOOK_WIRE_GRAMMAR,
  createErpTranslationVerifier,
  createErpWebhookVerifier,
  erpTranslationChecksum,
  erpWebhookSignature,
  ingestErpWebhook,
  translateErpWebhookBody,
} from './webhook-ingest';
export type {
  ErpWebhookEngineDeps,
  ErpWebhookOutcome,
  ErpWebhookOutcomeKind,
} from './webhook-ingest';
