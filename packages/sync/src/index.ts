// Office sync — public surface (OFF-028).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-029 sync engine, OFF-030/031/032 clients) consume the package only
// through its root entry point, never through deeper paths. Anything not
// re-exported here is package-internal and may change without notice.
//
// The package imports exactly four workspace dependencies — @office/contracts
// (envelope/scope/identity contracts), @office/domain-kernel
// (Result/DomainError), @office/authz (deny-by-default authorization for the
// A9 grants), and @office/events (the ledger read vocabulary: LedgerEvent,
// ledger event ids/sequences) — plus node:crypto (sha256 digests only). No
// new external dependencies. No transport, no network I/O, no SQL, no
// migrations: the broker is the deterministic in-memory reference
// implementation of the protocol; the app layer wires real transports and
// the ledger-backed slice source against these ports later.
//
// Surface summary:
// - identity:     SubscriptionId, SubscriptionGrantId, OperationId,
//                 ConflictRecordId (+parse/is/format helpers, grammars) and
//                 the deterministic derivations subscriptionIdOf,
//                 subscriptionGrantIdOf, operationIdOf, conflictRecordIdOf
// - version:      ProtocolVersion, KNOWN/CURRENT_PROTOCOL_VERSION,
//                 parse/isProtocolVersion (fail-closed)
// - grant:        SubscriptionGrant, GrantState, GrantVersion (+parse/is,
//                 grantSubscription, upgradeGrantProtocol, revokeGrant,
//                 isGrantActive) — the A9 permission backing a subscription
// - subscription: Subscription, SubscriptionFilter (+parse/is/compose),
//                 eventMatchesFilter, filterSliceEntries
// - slice:        SlicePosition, SliceCursor, SliceEntry, ProjectSlice,
//                 ProjectSliceSource (+parse/is/compose, the deterministic
//                 ordering rule orderSliceEntries, buildProjectSlice,
//                 sliceEntriesAfter, headPositionOf, checkSliceContinuity,
//                 checkCursorSubscription, parseLedgerEvent) and the
//                 deterministic in-memory source
// - messages:     the five typed stream messages (event-delivered,
//                 slice-catchup, grant-revoked, conflict-notified,
//                 protocol-error) + parseStreamMessage and per-kind parses
// - operations:   ClientOperation, OperationKind, OperationDigest,
//                 operationDigestOf (+parse/is/compose),
//                 OperationRegistry, createInMemoryOperationRegistry
// - conflict:     ConflictRecord, ConflictResolution (+parse/is),
//                 detectConflict, resolveConflict — explicit, never
//                 auto-resolved
// - broker:       createSubscriptionBroker, SubscriptionBroker,
//                 LiveSubscription, SUBSCRIPTION_READ_CAPABILITY

// Protocol identity vocabulary (branded, fail-closed, deterministic).
export {
  conflictRecordIdOf,
  formatConflictRecordId,
  formatOperationId,
  formatSubscriptionGrantId,
  formatSubscriptionId,
  isConflictRecordId,
  isOperationId,
  isSubscriptionGrantId,
  isSubscriptionId,
  operationIdOf,
  parseConflictRecordId,
  parseOperationId,
  parseSubscriptionGrantId,
  parseSubscriptionId,
  subscriptionGrantIdOf,
  subscriptionIdOf,
} from './identity';
export type {
  ConflictRecordId,
  ConflictRecordKey,
  OperationId,
  OperationKey,
  SubscriptionGrantId,
  SubscriptionGrantKey,
  SubscriptionId,
  SubscriptionKey,
} from './identity';
export {
  CONFLICT_RECORD_ID_GRAMMAR,
  OPERATION_ID_GRAMMAR,
  SUBSCRIPTION_GRANT_ID_GRAMMAR,
  SUBSCRIPTION_ID_GRAMMAR,
} from './identity';

// Fail-closed subscription protocol versioning.
export {
  CURRENT_PROTOCOL_VERSION,
  KNOWN_PROTOCOL_VERSIONS,
  isProtocolVersion,
  parseProtocolVersion,
} from './version';
export type { ProtocolVersion, SemverString } from './version';
export { PROTOCOL_VERSION_GRAMMAR } from './version';

// The A9 subscription grant (explicit, versioned, revocable).
export {
  GRANT_VERSION_GRAMMAR,
  SUBSCRIPTION_GRANT_GRAMMAR,
  grantSubscription,
  isGrantActive,
  isGrantVersion,
  isSubscriptionGrant,
  parseGrantVersion,
  parseSubscriptionGrant,
  revokeGrant,
  upgradeGrantProtocol,
} from './grant';
export type { GrantState, GrantVersion, SubscriptionGrant } from './grant';

// The versioned subscription contract.
export {
  SUBSCRIPTION_FILTER_GRAMMAR,
  SUBSCRIPTION_GRAMMAR,
  eventMatchesFilter,
  filterSliceEntries,
  isSubscription,
  isSubscriptionFilter,
  parseSubscription,
  parseSubscriptionFilter,
  subscription,
  subscriptionFilter,
} from './subscription';
export type { Subscription, SubscriptionFilter } from './subscription';

// Project slices, cursors, and the ledger read port.
export {
  MAX_SLICE_READ_LIMIT,
  SLICE_CURSOR_GRAMMAR,
  SLICE_POSITION_GRAMMAR,
  buildProjectSlice,
  checkCursorSubscription,
  checkSliceContinuity,
  createInMemorySliceSource,
  eventInSliceScope,
  headPositionOf,
  isLedgerEvent,
  isProjectScope,
  isSliceCursor,
  isSlicePosition,
  orderSliceEntries,
  parseLedgerEvent,
  parseProjectScope,
  parseSliceCursor,
  parseSlicePosition,
  sliceCursor,
  sliceEntriesAfter,
} from './slice';
export type {
  InMemorySliceSource,
  ProjectSlice,
  ProjectSliceSource,
  SliceCursor,
  SliceEntry,
  SlicePosition,
} from './slice';

// The typed stream protocol messages.
export {
  CONFLICT_NOTIFIED_GRAMMAR,
  EVENT_DELIVERED_GRAMMAR,
  GRANT_REVOKED_GRAMMAR,
  PROTOCOL_ERROR_GRAMMAR,
  SLICE_CATCHUP_GRAMMAR,
  isStreamMessage,
  parseConflictNotifiedMessage,
  parseEventDeliveredMessage,
  parseGrantRevokedMessage,
  parseProtocolErrorMessage,
  parseSliceCatchupMessage,
  parseSliceEntry,
  parseStreamMessage,
} from './messages';
export type {
  ConflictNotifiedMessage,
  EventDeliveredMessage,
  GrantRevokedMessage,
  ProtocolErrorCode,
  ProtocolErrorMessage,
  SliceCatchupMessage,
  StreamMessage,
} from './messages';

// Deterministic client operations + typed deduplication.
export {
  CLIENT_OPERATION_GRAMMAR,
  OPERATION_DIGEST_GRAMMAR,
  OPERATION_KIND_GRAMMAR,
  clientOperation,
  createInMemoryOperationRegistry,
  isClientOperation,
  isOperationDigest,
  isOperationKind,
  operationDigestOf,
  parseClientOperation,
  parseOperationDigest,
  parseOperationKind,
} from './operations';
export type {
  ClientOperation,
  OperationDigest,
  OperationKind,
  OperationOutcome,
  OperationRegistry,
} from './operations';

// Explicit conflict records (never auto-resolved).
export {
  CONFLICT_RECORD_GRAMMAR,
  CONFLICT_RESOLUTION_GRAMMAR,
  detectConflict,
  isConflictRecord,
  isConflictResolution,
  parseConflictRecord,
  parseConflictResolution,
  resolveConflict,
} from './conflict';
export type {
  ConflictRecord,
  ConflictRecordState,
  ConflictResolution,
  ConflictResolutionStrategy,
} from './conflict';

// The deterministic in-memory subscription broker.
export {
  SUBSCRIPTION_READ_CAPABILITY,
  createSubscriptionBroker,
} from './broker';
export type { LiveSubscription, SubscriptionBroker } from './broker';
