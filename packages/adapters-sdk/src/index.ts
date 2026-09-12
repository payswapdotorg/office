// Office adapters-sdk — public surface (OFF-020).
//
// src/index.ts is the package's WHOLE public surface: the provider adapters
// (OFF-021+), the adapter runtime, and tests consume the package only
// through its root entry point, never through deeper paths. Anything not
// re-exported here is package-internal and may change without notice.
//
// The package imports exactly four workspace dependencies — @office/contracts
// (ids/scope/actor/envelopes/parse plumbing), @office/domain-kernel
// (Result/DomainError/aggregate versions), @office/authz (authorization
// contexts, capabilities, the deny-by-default evaluator), and @office/events
// (the ledger event id of conflict-resolution audit refs) — plus node
// builtins (crypto digests). No new external dependencies; no I/O, no SQL,
// no clock, no randomness (injected ports everywhere).
//
// Surface summary:
// - json:        AdapterJsonValue/AdapterJsonObject (+bounds), parse/is
// - identity:    AdapterKind, ProviderSystemId, ProviderObjectKind,
//                ProviderObjectId, ProviderVersion (+parse/is/builders)
// - source-ref:  SourceCoordinate, SourceRef (+parse/is/builders),
//                sourceRefKeyOf/sourceCoordinateKeyOf, syncIdempotencyKey,
//                sourceCorrelationId
// - mapping:     SourceMapping, SourceMappingStore (port) +
//                createInMemorySourceMappingStore, recordSourceMapping,
//                assertMappingTenant
// - cursor:      SyncStream, SyncCheckpoint, SyncCursor, SyncCursorToken
//                (+parse/is/builders), syncStreamKeyOf, checkCursorStream,
//                nextCursor, SyncCursorStore (port) + in-memory
// - conflict:    Conflict, ConflictId, ConflictResolution (strategy
//                vocabulary), conflictIdOf, detectedConflict, resolveConflict,
//                ConflictStore (port) + in-memory
// - snapshot:    ProviderSnapshot, ProviderObjectStatus (+parse/is/builder)
// - adapter:     Adapter (the contract), AdapterCapabilities, lifecycle
//                types, SyncRequest/SyncResult (+parse), requireAdapterActor,
//                adapterAuthorizationContext
// - webhook:     RawWebhook, ProviderWebhookBody, NormalizedWebhook,
//                WebhookSignatureVerifier (port), webhookDeduplicationKey,
//                normalizeWebhook, applyWebhook (intake engine)
// - commands:    AdapterCommandInput/Proposal/Translator (ports),
//                adapterCommandEnvelope, causationIdOfWebhook
// - sync:        runSync (the sync engine), SyncEngineDeps/Outcome/Application
// - fake:        the deterministic fake-provider fixture + fake verifier

// Provider payload JSON values (the extension-bag model).
export {
  ADAPTER_JSON_MAX_ARRAY_ITEMS,
  ADAPTER_JSON_MAX_DEPTH,
  ADAPTER_JSON_MAX_OBJECT_KEYS,
  ADAPTER_JSON_MAX_STRING_LENGTH,
  isAdapterJsonObject,
  isAdapterJsonValue,
  parseAdapterJsonObject,
  parseAdapterJsonValue,
} from './json';
export type { AdapterJsonObject, AdapterJsonPrimitive, AdapterJsonValue } from './json';

// Provider-side identity vocabulary.
export {
  ADAPTER_KIND_GRAMMAR,
  PROVIDER_OBJECT_ID_GRAMMAR,
  PROVIDER_OBJECT_KIND_GRAMMAR,
  PROVIDER_SYSTEM_ID_GRAMMAR,
  PROVIDER_VERSION_GRAMMAR,
  adapterKind,
  isAdapterKind,
  isProviderObjectId,
  isProviderObjectKind,
  isProviderSystemId,
  isProviderVersion,
  parseAdapterKind,
  parseProviderObjectId,
  parseProviderObjectKind,
  parseProviderSystemId,
  parseProviderVersion,
  providerObjectId,
  providerObjectKind,
  providerSystemId,
  providerVersion,
} from './identity';
export type {
  AdapterKind,
  ProviderObjectId,
  ProviderObjectKind,
  ProviderSystemId,
  ProviderVersion,
} from './identity';

// The source identity reference and its deterministic derivations.
export {
  SOURCE_COORDINATE_GRAMMAR,
  SOURCE_REF_GRAMMAR,
  coordinateOf,
  isSourceCoordinate,
  isSourceRef,
  parseSourceCoordinate,
  parseSourceRef,
  sourceCoordinateKeyOf,
  sourceCoordinate,
  sourceCorrelationId,
  sourceRef,
  sourceRefKeyOf,
  syncIdempotencyKey,
} from './source-ref';
export type { SourceCoordinate, SourceRef } from './source-ref';

// Source identity mapping (provider ids → canonical office ids).
export {
  SOURCE_MAPPING_GRAMMAR,
  assertMappingTenant,
  createInMemorySourceMappingStore,
  isSourceMapping,
  parseSourceMapping,
  recordSourceMapping,
  sourceMapping,
} from './mapping';
export type { SourceMapping, SourceMappingStore } from './mapping';

// Resumable, replay-safe sync cursors.
export {
  SYNC_CHECKPOINT_GRAMMAR,
  SYNC_CURSOR_GRAMMAR,
  SYNC_CURSOR_TOKEN_GRAMMAR,
  SYNC_STREAM_GRAMMAR,
  checkCursorStream,
  createInMemorySyncCursorStore,
  isSyncCheckpoint,
  isSyncCursor,
  isSyncCursorToken,
  isSyncStream,
  nextCursor,
  parseSyncCheckpoint,
  parseSyncCursor,
  parseSyncCursorToken,
  parseSyncStream,
  syncCursor,
  syncCursorToken,
  syncStream,
  syncStreamKeyOf,
} from './cursor';
export type {
  SyncCheckpoint,
  SyncCursor,
  SyncCursorStore,
  SyncCursorToken,
  SyncStream,
} from './cursor';

// Explicit conflict records (no destructive automatic resolution).
export {
  CONFLICT_GRAMMAR,
  CONFLICT_ID_GRAMMAR,
  CONFLICT_RESOLUTION_GRAMMAR,
  conflictId,
  conflictIdOf,
  createInMemoryConflictStore,
  detectedConflict,
  isConflict,
  isConflictId,
  isConflictResolution,
  parseConflict,
  parseConflictId,
  parseConflictResolution,
  resolveConflict,
} from './conflict';
export type {
  Conflict,
  ConflictId,
  ConflictResolution,
  ConflictResolutionStrategy,
  ConflictSides,
  ConflictState,
  ConflictStore,
} from './conflict';

// The provider-neutral object snapshot.
export {
  PROVIDER_SNAPSHOT_GRAMMAR,
  isProviderSnapshot,
  parseProviderSnapshot,
  providerSnapshot,
} from './snapshot';
export type { ProviderObjectStatus, ProviderSnapshot } from './snapshot';

// The provider-neutral Adapter contract.
export {
  ADAPTER_CAPABILITIES_GRAMMAR,
  ADAPTER_CONNECTION_GRAMMAR,
  ADAPTER_OBJECT_CAPABILITY_GRAMMAR,
  SYNC_RESULT_GRAMMAR,
  adapterAuthorizationContext,
  isAdapterCapabilities,
  isAdapterConnection,
  isAdapterHealth,
  isAdapterObjectCapability,
  isSyncResult,
  parseAdapterCapabilities,
  parseAdapterConnection,
  parseAdapterHealth,
  parseAdapterObjectCapability,
  parseSyncResult,
  requireAdapterActor,
} from './adapter';
export type {
  Adapter,
  AdapterCapabilities,
  AdapterConnection,
  AdapterDisconnected,
  AdapterHealth,
  AdapterObjectCapability,
  ConnectRequest,
  SyncRequest,
  SyncResult,
} from './adapter';

// Webhook normalization + the intake engine.
export {
  PROVIDER_WEBHOOK_BODY_GRAMMAR,
  WEBHOOK_DEDUPLICATION_KEY_GRAMMAR,
  applyWebhook,
  isProviderWebhookBody,
  isWebhookDeduplicationKey,
  normalizeWebhook,
  parseProviderWebhookBody,
  parseWebhookDeduplicationKey,
  webhookDeduplicationKey,
} from './webhook';
export type {
  AdapterAuthorization,
  NormalizedWebhook,
  ProviderEventKind,
  ProviderWebhookBody,
  RawWebhook,
  WebhookDeduplicationKey,
  WebhookEngineDeps,
  WebhookOutcome,
  WebhookOutcomeKind,
  WebhookSignatureInput,
  WebhookSignatureVerifier,
} from './webhook';

// The canonical command translation seam.
export {
  adapterCommandEnvelope,
  causationIdOfWebhook,
  checkCommandEnvelopeRoundTrip,
  requireCanonicalTarget,
} from './commands';
export type {
  AdapterChangeKind,
  AdapterCommandEnvelopeParts,
  AdapterCommandInput,
  AdapterCommandOrigin,
  AdapterCommandProposal,
  AdapterCommandTranslator,
  CanonicalIdSupplier,
  CanonicalVersionLookup,
  EngineClock,
} from './commands';

// The sync engine.
export { SYNC_MAX_LIMIT, runSync } from './sync';
export type {
  RunSyncRequest,
  SyncApplication,
  SyncApplicationOutcome,
  SyncEngineDeps,
  SyncOutcome,
} from './sync';

// The deterministic fake-provider fixture (generic vocabulary only).
export {
  FAKE_ADAPTER_KIND,
  FAKE_ARCHIVE_COMMAND,
  FAKE_CANONICAL_KIND,
  FAKE_CREATE_COMMAND,
  FAKE_OBJECT_KIND,
  FAKE_SYNC_CAPABILITY,
  FAKE_SYSTEM_ID,
  FAKE_UPDATE_COMMAND,
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  createFakeProvider,
  createFakeWebhookVerifier,
  fakeAuditEventRef,
  fakeWebhookSignature,
} from './fake-provider';
export type { FakeProvider, FakeProviderObject } from './fake-provider';
