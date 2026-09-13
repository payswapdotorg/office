// Office adapter-construction — public surface (OFF-021).
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
// builtins for the deterministic webhook signature/checksum conventions. No
// new external dependencies; no I/O, no SQL, no clock, no randomness
// (injected ports everywhere).
//
// Surface summary:
// - vocabulary:         the generic construction/CDE identity vocabulary
//                       (adapter kind 'construction-cde', system
//                       'cde-instance-01', object kinds document/rfi/
//                       change-event/observation), the canonical kinds they
//                       map into, the landed canonical command names, the
//                       object MAPPING TABLE, and the validated
//                       AdapterCapabilities declaration
// - parse:              (internal — not re-exported)
// - provider-fixture:   the deterministic in-memory construction provider
//                       store (documents with revisions, RFIs, change
//                       events, observations; monotonic versions;
//                       tombstones; wire-format webhook emission;
//                       degrade/recover for the health surface)
// - snapshot-translation: provider object → ProviderSnapshot (the neutral
//                       observation seam) + the shared per-kind provider-data
//                       view (extension bag / webhook payload)
// - mapping:            the AdapterCommandTranslator implementation —
//                       document/RFI/change-event/observation → typed
//                       canonical command proposals, with fail-closed
//                       per-kind provider-data parsers
// - adapter:            the Adapter implementation over one injected provider
//                       store (capabilities declaration, typed lifecycle
//                       transitions, positional replay-safe sync paging)
// - sync:               runConstructionSync — every declared object-kind
//                       stream paged to exhaustion through the SDK engine,
//                       resuming from persisted cursors
// - webhook-ingest:     the CDE wire format + signature conventions, the
//                       fail-closed wire → ProviderWebhookBody translation,
//                       and ingestCdeWebhook (signature → translation →
//                       divergence conflict records → SDK intake engine)

// The generic construction/CDE vocabulary + the object mapping table.
export {
  CHANGE_EVENT_CANONICAL_KIND,
  CHANGE_EVENT_CREATE_COMMAND,
  CHANGE_EVENT_OBJECT_KIND,
  CHANGE_EVENT_UPDATE_COMMAND,
  CONSTRUCTION_ADAPTER_KIND,
  CONSTRUCTION_CAPABILITIES,
  CONSTRUCTION_CAPABILITY_NAMES,
  CONSTRUCTION_OBJECT_KINDS,
  CONSTRUCTION_OBJECT_MAPPINGS,
  CONSTRUCTION_SYSTEM_ID,
  DOCUMENT_CANONICAL_KIND,
  DOCUMENT_CREATE_COMMAND,
  DOCUMENT_DELETE_COMMAND,
  DOCUMENT_OBJECT_KIND,
  DOCUMENT_UPDATE_COMMAND,
  OBSERVATION_CANONICAL_KIND,
  OBSERVATION_CREATE_COMMAND,
  OBSERVATION_DELETE_COMMAND,
  OBSERVATION_OBJECT_KIND,
  OBSERVATION_UPDATE_COMMAND,
  RFI_CANONICAL_KIND,
  RFI_CREATE_COMMAND,
  RFI_DELETE_COMMAND,
  RFI_OBJECT_KIND,
  RFI_UPDATE_COMMAND,
  constructionObjectMappingOf,
} from './vocabulary';
export type { ConstructionObjectMapping } from './vocabulary';

// The deterministic in-memory construction provider fixture.
export {
  createConstructionProviderStore,
} from './provider-fixture';
export type {
  ConstructionChangeEventObject,
  ConstructionCostImpact,
  ConstructionDocumentObject,
  ConstructionDocumentRevision,
  ConstructionEvidenceReference,
  ConstructionObservationObject,
  ConstructionProviderObject,
  ConstructionProviderStore,
  ConstructionRfiObject,
  CdeEventKind,
} from './provider-fixture';

// The snapshot translation seam.
export { constructionObjectViewOf, constructionSnapshotOf } from './snapshot-translation';
export type { ConstructionObjectView } from './snapshot-translation';

// The object mapping + command translation.
export {
  createConstructionTranslator,
  parseChangeEventProviderData,
  parseDocumentProviderData,
  parseObservationProviderData,
  parseRfiProviderData,
} from './mapping';
export type {
  ChangeEventCostImpact,
  ChangeEventProviderData,
  DocumentProviderData,
  ObservationEvidenceReference,
  ObservationProviderData,
  RfiProviderData,
} from './mapping';

// The Adapter implementation.
export { createConstructionAdapter } from './adapter';
export type { ConstructionAdapterParts } from './adapter';

// The multi-stream construction sync.
export { runConstructionSync } from './sync';
export type {
  ConstructionStreamReport,
  ConstructionSyncDeps,
  ConstructionSyncReport,
  ConstructionSyncRequest,
} from './sync';

// The CDE webhook ingest.
export {
  CDE_TRANSLATION_CHECKSUM_HEADER,
  CDE_WEBHOOK_SIGNATURE_HEADER,
  cdeTranslationChecksum,
  cdeWebhookSignature,
  createCdeTranslationVerifier,
  createCdeWebhookVerifier,
  ingestCdeWebhook,
  translateCdeWebhookBody,
} from './webhook-ingest';
export type {
  CdeWebhookEngineDeps,
  CdeWebhookOutcome,
  CdeWebhookOutcomeKind,
} from './webhook-ingest';
