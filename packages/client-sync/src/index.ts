// Office client-sync — public surface (OFF-029).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-030/031/032 clients, the app layer) consume the package only through
// its root entry point, never through deeper paths. Anything not re-exported
// here is package-internal and may change without notice.
//
// The package imports exactly five workspace dependencies — @office/sync
// (THE foundation: grants, subscriptions, project slices, operation registry,
// conflict records, the broker), @office/contracts (envelope/scope/identity
// contracts), @office/domain-kernel (Result/DomainError,
// CommandFingerprint/idempotency semantics), @office/authz (the A9/A12
// authorization the replay re-checks), and @office/events (the ledger event
// vocabulary: LedgerEvent, ledger event ids) — plus node:crypto (sha256
// digests only). No new external dependencies. No transport, no network I/O,
// no SQL, no migrations: the engine is the deterministic in-memory reference
// implementation of the offline protocol; the app layer wires real transports,
// durable queue stores, and the ledger-backed slice source against these ports
// later.
//
// Surface summary:
// - identity:     LocalSequence (+parse/is, grammar, bounds),
//                 OfflineOperationKey, offlineOperationIdOf (THE deterministic
//                 offline id rule), OfflineCommandIdentity,
//                 offlineCommandFingerprint
// - queue:        ProtectionClass (+parse/is), QueueEntryState,
//                 QueueEntry (+parse/is, grammars), clientOperationOf,
//                 OfflineMutation, LocalQueue, DEFAULT_QUEUE_CAPACITY,
//                 createLocalQueue (THE bounded disconnected mutation queue)
// - tokens:       CausalToken, addressesTarget, DivergenceAssessment,
//                 assessTargetDivergence (the server-side base-vs-actual check)
// - conflict:     AppliedOperation, OperationJournal,
//                 createInMemoryOperationJournal, ConflictLog,
//                 createInMemoryConflictLog, autoResolveOpenConflict (OPEN
//                 state only — never protected), ConflictResolutionCommand
//                 (THE typed explicit resolution)
// - replay:       CommandPathContext, CommandPathOutcome, TypedCommandPath,
//                 authorizeQueuedMutation, DrainEntryOutcome, DrainReport,
//                 DrainDeps, drainLocalQueue (THE exactly-once queue drain)
// - audit:        the five sync audit event names, SyncAuditSinkExecutor,
//                 SyncEventSink, InMemorySyncEventSink,
//                 createInMemorySyncEventSink, syncSinkFailure,
//                 failingSyncEventSink, failAfterSyncEventSink, and the
//                 envelope builders (mutation replayed/rejected, conflict
//                 surfaced/auto-resolved/resolved)
// - engine:       SyncEngine, SyncEngineParts, OfflineCapture,
//                 OnlineSubmission, OnlineSubmissionOutcome, ReconnectReport,
//                 ConflictResolutionReport, createSyncEngine (the composed
//                 in-memory engine)

// Deterministic offline operation identity (A9 offline id rule + A8 key rule).
export {
  LOCAL_SEQUENCE_GRAMMAR,
  MAX_LOCAL_SEQUENCE,
  isLocalSequence,
  offlineCommandFingerprint,
  offlineOperationIdOf,
  parseLocalSequence,
} from './identity';
export type {
  LocalSequence,
  OfflineCommandIdentity,
  OfflineOperationKey,
} from './identity';

// The bounded disconnected mutation queue (freeze A9) + entry lifecycle.
export {
  DEFAULT_QUEUE_CAPACITY,
  PROTECTION_CLASS_GRAMMAR,
  QUEUE_ENTRY_GRAMMAR,
  QUEUE_ENTRY_STATE_GRAMMAR,
  clientOperationOf,
  createLocalQueue,
  isProtectionClass,
  isQueueEntry,
  isQueueEntryState,
  parseProtectionClass,
  parseQueueEntry,
  parseQueueEntryState,
} from './queue';
export type {
  AppliedEntryState,
  ConflictedEntryState,
  LocalQueue,
  OfflineMutation,
  ProtectionClass,
  QueueEntry,
  QueueEntryState,
  SupersededEntryState,
} from './queue';

// Causal/version tokens + the server-side divergence check.
export { addressesTarget, assessTargetDivergence } from './tokens';
export type { CausalToken, DivergenceAssessment } from './tokens';

// Protection policy, conflict surfacing, and the server-side sync records.
export {
  autoResolveOpenConflict,
  createInMemoryConflictLog,
  createInMemoryOperationJournal,
} from './conflict';
export type {
  AppliedOperation,
  ConflictLog,
  ConflictResolutionCommand,
  OperationJournal,
} from './conflict';

// The replay protocol: the typed command path port + the exactly-once drain.
export { authorizeQueuedMutation, drainLocalQueue } from './replay';
export type {
  CommandPathContext,
  CommandPathOutcome,
  DrainDeps,
  DrainEntryOutcome,
  DrainReport,
  TypedCommandPath,
} from './replay';

// The audit discipline (freeze A3) + the EventSink port.
export {
  CONFLICT_AUTO_RESOLVED_EVENT,
  CONFLICT_RESOLVED_EVENT,
  CONFLICT_SURFACED_EVENT,
  MUTATION_REJECTED_EVENT,
  MUTATION_REPLAYED_EVENT,
  SYNC_AUDIT_EVENT_NAMES,
  conflictAutoResolvedEnvelope,
  conflictResolvedEnvelope,
  conflictSurfacedEnvelope,
  createInMemorySyncEventSink,
  failAfterSyncEventSink,
  failingSyncEventSink,
  mutationRejectedEnvelope,
  mutationReplayedEnvelope,
  syncSinkFailure,
} from './audit';
export type {
  ConflictAutoResolvedAudit,
  ConflictResolvedAudit,
  ConflictSurfacedAudit,
  InMemorySyncEventSink,
  MutationRejectedAudit,
  MutationReplayedAudit,
  RecordedSyncAppend,
  SyncAuditSinkExecutor,
  SyncEventSink,
} from './audit';

// The composed in-memory SyncEngine.
export { createSyncEngine } from './engine';
export type {
  ConflictResolutionReport,
  OfflineCapture,
  OnlineSubmission,
  OnlineSubmissionOutcome,
  ReconnectReport,
  SyncEngine,
  SyncEngineParts,
} from './engine';
