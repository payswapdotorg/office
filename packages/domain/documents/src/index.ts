// Office documents domain — public surface (OFF-008).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-009 field, OFF-012 contracts/change, OFF-013 relationships, OFF-016
// workflows, OFF-021/022 adapters) consume the package only through its root
// entry point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package is PURE DOMAIN: aggregates, commands, and ports only — no SQL,
// no migrations, no repository layer. It imports exactly four workspace
// dependencies — @office/contracts (envelopes + canonical ids),
// @office/domain-kernel (Result/DomainError, aggregate versioning +
// concurrency, invariants, idempotency), @office/authz (the deny-by-default
// authorize() evaluator), and @office/persistence (the SqlExecutor TYPE of
// the EventSink port only) — plus node builtins. No external dependencies;
// @office/events is deliberately NOT imported (the EventSink port below is
// the seam the event ledger implements, wired by the persistence/app layers).
//
// Surface summary:
// - state:       DocumentState, DocumentStatus, DOCUMENT_STATUSES,
//                DOCUMENT_KIND, DOCUMENT_INVARIANTS, NewDocument,
//                DocumentRevisionState, REVISION_KIND, REVISION_INVARIANTS,
//                NewDocumentRevision, EvidenceReferenceState,
//                EVIDENCE_REFERENCE_KIND, EVIDENCE_REFERENCE_INVARIANTS,
//                NewEvidenceReference, createDocumentState,
//                archiveDocumentState, attachRevisionState,
//                supersedeRevisionState, createDocumentRevisionState,
//                createEvidenceReferenceState
// - storage:     RevisionHash, StorageKey (+ grammars, parse/is/format/split
//                helpers), CONTENT_BASE64_RULE/GRAMMAR, decodeBase64,
//                ObjectStorage, InMemoryObjectStorage, InMemoryStoredObject,
//                createInMemoryObjectStorage, failingObjectStorage,
//                contentAddressMismatch, objectNotFound
// - events:      EventSink, InMemoryEventSink, RecordedEventAppend,
//                createInMemoryEventSink, failingEventSink, eventSinkFailure,
//                DOCUMENT_REGISTERED_EVENT, DOCUMENT_ARCHIVED_EVENT,
//                REVISION_ATTACHED_EVENT, REVISION_SUPERSEDED_EVENT,
//                EVIDENCE_REFERENCED_EVENT, documentsEventEnvelope, entityRefOf
//                (+ payload types)
// - store:       DocumentsStore, DocumentsUnitOfWork, InMemoryDocumentsStore,
//                InMemoryStoreCounters, createInMemoryDocumentsStore
// - commands:    DocumentsCommands, createDocumentsCommands,
//                DocumentsCommandDeps, DocumentsCommandAuthorization,
//                RevisionMutationResult, REGISTER/ARCHIVE_DOCUMENT_COMMAND,
//                ATTACH/SUPERSEDE_REVISION_COMMAND, REFERENCE_EVIDENCE_COMMAND
//                (+ payload types and their fail-closed parsers)

// Aggregate states, invariants, and pure lifecycle/revision/evidence transitions.
export {
  DOCUMENT_INVARIANTS,
  DOCUMENT_KIND,
  DOCUMENT_STATUSES,
  EVIDENCE_REFERENCE_INVARIANTS,
  EVIDENCE_REFERENCE_KIND,
  REVISION_INVARIANTS,
  REVISION_KIND,
  archiveDocumentState,
  attachRevisionState,
  createDocumentRevisionState,
  createDocumentState,
  createEvidenceReferenceState,
  supersedeRevisionState,
} from './state';
export type {
  DocumentRevisionState,
  DocumentState,
  DocumentStatus,
  EvidenceReferenceState,
  NewDocument,
  NewDocumentRevision,
  NewEvidenceReference,
} from './state';

// The provider-neutral, content-addressed object-storage port (+ in-memory fake).
export {
  CONTENT_BASE64_GRAMMAR,
  CONTENT_BASE64_RULE,
  REVISION_HASH_GRAMMAR,
  STORAGE_KEY_GRAMMAR,
  contentAddressMismatch,
  createInMemoryObjectStorage,
  decodeBase64,
  failingObjectStorage,
  formatStorageKey,
  isRevisionHash,
  isStorageKey,
  objectNotFound,
  parseRevisionHash,
  parseStorageKey,
  storageKeyParts,
} from './storage';
export type {
  InMemoryObjectStorage,
  InMemoryStoredObject,
  ObjectStorage,
  RevisionHash,
  StorageKey,
  StorageKeyParts,
} from './storage';

// Audit events + THE EventSink port (minimal; OFF-005's ledger implements it).
export {
  DOCUMENT_ARCHIVED_EVENT,
  DOCUMENT_REGISTERED_EVENT,
  EVIDENCE_REFERENCED_EVENT,
  REVISION_ATTACHED_EVENT,
  REVISION_SUPERSEDED_EVENT,
  createInMemoryEventSink,
  documentsEventEnvelope,
  entityRefOf,
  eventSinkFailure,
  failingEventSink,
} from './events';
export type {
  DocumentArchivedPayload,
  DocumentRegisteredPayload,
  DocumentsEventPayload,
  EvidenceReferencedPayload,
  EventSink,
  InMemoryEventSink,
  RecordedEventAppend,
  RevisionAttachedPayload,
  RevisionSupersededPayload,
} from './events';

// The documents store port (pure-domain unit of work) + in-memory store.
export { createInMemoryDocumentsStore } from './store';
export type {
  DocumentsStore,
  DocumentsUnitOfWork,
  InMemoryDocumentsStore,
  InMemoryStoreCounters,
} from './store';

// Command handlers (authorize → idempotency → unit of work: load →
// concurrency → transition → blob put + staged writes + event append).
export {
  ARCHIVE_DOCUMENT_COMMAND,
  ATTACH_REVISION_COMMAND,
  REFERENCE_EVIDENCE_COMMAND,
  REGISTER_DOCUMENT_COMMAND,
  SUPERSEDE_REVISION_COMMAND,
  createDocumentsCommands,
  parseArchiveDocumentPayload,
  parseAttachRevisionPayload,
  parseReferenceEvidencePayload,
  parseRegisterDocumentPayload,
  parseSupersedeRevisionPayload,
} from './commands';
export type {
  ArchiveDocumentPayload,
  AttachRevisionPayload,
  DocumentsCommandAuthorization,
  DocumentsCommandDeps,
  DocumentsCommands,
  ReferenceEvidencePayload,
  RegisterDocumentPayload,
  RevisionMutationResult,
  SupersedeRevisionPayload,
} from './commands';
