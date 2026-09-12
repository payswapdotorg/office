// Office events — public surface (OFF-005).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-007+ domain command handlers, OFF-013 relationships, OFF-016
// workflows) consume the package only through its root entry point, never
// through deeper paths. Anything not re-exported here is package-internal
// and may change without notice.
//
// The package builds on the merged foundations and imports exactly three
// workspace dependencies — @office/contracts (envelope + causality
// contracts), @office/domain-kernel (Result/DomainError), and
// @office/persistence (SqlExecutor/Transaction/TransactionRunner, scoped
// statement composition, migration conventions, the test harness) — plus
// node builtins. No new external dependencies.
//
// Surface summary:
// - identity:     LedgerEventId, LedgerSequence, ConsumerName (+parse/is/
//                 format helpers), ledgerEventIdOf (deterministic id
//                 derivation), causationIdOf, grammars
// - migrations:   EVENTS_MIGRATIONS_DIR (0003_event_ledger.sql,
//                 0004_outbox.sql — apply with @office/persistence's
//                 migrator conventions)
// - ledger:       LedgerEvent, AppendEventInput, appendEvent,
//                 readEventById, readAggregateEvents, causedByCommand,
//                 causedByEvent
// - outbox:       OutboxRecord, OutboxEntry, OutboxState,
//                 enqueueOutbox, fetchPendingOutbox, markDispatched,
//                 recordDispatchFailure (+ options types)
// - consumer:     ConsumerCursor, ConsumptionOutcome,
//                 ConsumeIdempotentlyInput, consumeIdempotently,
//                 readConsumerCursor

// Ledger identity vocabulary (branded, fail-closed parsing, deterministic).
export {
  CONSUMER_NAME_GRAMMAR,
  LEDGER_EVENT_ID_GRAMMAR,
  LEDGER_SEQUENCE_GRAMMAR,
  causationIdOf,
  formatLedgerEventId,
  isConsumerName,
  isLedgerEventId,
  isLedgerSequence,
  ledgerEventIdOf,
  parseConsumerName,
  parseLedgerEventId,
  parseLedgerSequence,
} from './identity';
export type {
  ConsumerName,
  LedgerEventId,
  LedgerKey,
  LedgerSequence,
} from './identity';

// The package's migrations directory (apply via @office/persistence's
// migrator; see README for the canonical chain composition).
export { EVENTS_MIGRATIONS_DIR } from './migrations';

// The append-only event ledger.
export {
  appendEvent,
  causedByCommand,
  causedByEvent,
  readAggregateEvents,
  readEventById,
} from './ledger';
export type { AppendEventInput, LedgerEvent } from './ledger';

// The transactional outbox.
export {
  enqueueOutbox,
  fetchPendingOutbox,
  markDispatched,
  recordDispatchFailure,
} from './outbox';
export type {
  EnqueueOutboxOptions,
  FetchPendingOutboxOptions,
  MarkDispatchedOptions,
  OutboxEntry,
  OutboxRecord,
  OutboxState,
  RecordDispatchFailureOptions,
} from './outbox';

// The idempotent consumer cursor.
export { consumeIdempotently, readConsumerCursor } from './consumer';
export type {
  ConsumeIdempotentlyInput,
  ConsumerCursor,
  ConsumptionOutcome,
} from './consumer';
