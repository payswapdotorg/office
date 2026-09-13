// Office adapter-model — public surface (OFF-022).
//
// src/index.ts is the package's WHOLE public surface: the integration
// fabric (OFF-037) and tests consume the package only through its root
// entry point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package imports exactly four workspace dependencies —
// @office/adapters-sdk (THE adapter contract: Adapter, SourceRef, mapping
// records, cursors, conflicts, snapshots, webhook normalization, the sync
// engine), @office/contracts (ids/scope/actor/envelopes/parse plumbing),
// @office/domain-kernel (Result/DomainError/aggregate versions), and
// @office/intelligence-relationships (THE relationship/edge vocabulary —
// CONSUMED AS TYPES ONLY: every import from it is `import type`; no logic
// of the relationship engine is ever imported, per the frozen OFF-022
// boundary) — plus node builtins (crypto digests). No new external
// dependencies; no I/O, no SQL, no clock, no randomness (ports and injected
// suppliers everywhere); no real vendor SDK.
//
// Surface summary:
// - vocabulary:   the model adapter family ('model-cde' / 'model-instance-01'),
//                 the four model object kinds + their canonical kinds, the
//                 capability block, the models-area command + event names,
//                 the element classification/quantity/discipline/change
//                 vocabularies, provider link refs (+parse/is)
// - references:   THE model reference contracts — recordModelObjectMapping
//                 (kind + hierarchy discipline), assertModelObjectMapping,
//                 resolveModelObject, resolveElementParentChain,
//                 modelProviderCoordinateOf, resolveProviderLink(s),
//                 compareEntityRef
// - change-mapping: createModelTranslator (provider mutations → canonical
//                 command proposals), the models-area event payload
//                 contracts + parses, modelEventEnvelope /
//                 elementChangedEnvelope / elementRetiredEnvelope (the
//                 host-side execution seam)
// - notification: THE affected-relationship notification flow —
//                 ModelEventId/modelEventIdOf (the source event id),
//                 edgesOfModelEvent, projectModelRelationships (the
//                 deterministic relationship projection), and
//                 notificationsOfModelEvent (the notification records,
//                 each referencing the source event id with full causality)
// - adapter:      createModelAdapter (the Adapter implementation) + the
//                 ModelProviderObject/ModelProviderStore port
// - fixture:      createModelProviderStore + createSeededModelProvider (the
//                 deterministic in-memory provider: a model with two
//                 immutable versions, elements with classifications and
//                 linked activity/document refs, mutation streams, webhook
//                 emission)
// - sync:         runModelSync (the multi-stream driver in model hierarchy
//                 order, over the SDK's engine)

// The model vocabulary (generic names only — the provider specifics live
// inside this package by design).
export {
  ELEMENT_CANONICAL_KIND,
  ELEMENT_CHANGED_EVENT,
  ELEMENT_CLASSIFICATION_CANONICAL_KIND,
  ELEMENT_CLASSIFICATIONS,
  ELEMENT_CLASSIFICATION_OBJECT_KIND,
  ELEMENT_OBJECT_KIND,
  ELEMENT_QUANTITY_UNITS,
  ELEMENT_RETIRED_EVENT,
  MODEL_ADAPTER_CAPABILITIES,
  MODEL_ADAPTER_KIND,
  MODEL_CANONICAL_KIND,
  MODEL_DISCIPLINES,
  MODEL_EVENT_NAMES,
  MODEL_OBJECT_FAMILY,
  MODEL_OBJECT_KIND,
  MODEL_SYNC_CAPABILITY_NAME,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_CANONICAL_KIND,
  MODEL_VERSION_OBJECT_KIND,
  MODEL_VERSION_REGISTERED_EVENT,
  RECORD_ELEMENT_CHANGE_COMMAND,
  REGISTER_CLASSIFICATION_COMMAND,
  REGISTER_MODEL_COMMAND,
  REGISTER_MODEL_VERSION_COMMAND,
  RETIRE_ELEMENT_COMMAND,
  UPDATE_CLASSIFICATION_COMMAND,
  UPDATE_MODEL_COMMAND,
  canonicalKindOfModelObjectKind,
  isElementClassification,
  isElementQuantity,
  isElementQuantityUnit,
  isModelDiscipline,
  isModelElementChangeKind,
  isModelEventName,
  isModelObjectKind,
  isProviderLinkRef,
  parentObjectKindOf,
  parseElementClassification,
  parseElementQuantity,
  parseElementQuantityUnit,
  parseModelDiscipline,
  parseModelElementChangeKind,
  parseModelEventName,
  parseModelObjectKind,
  parseProviderLinkRef,
  providerLinkRefKeyOf,
} from './vocabulary';
export type {
  ElementClassification,
  ElementQuantity,
  ElementQuantityUnit,
  ModelDiscipline,
  ModelElementChangeKind,
  ProviderLinkRef,
} from './vocabulary';
export {
  ELEMENT_CLASSIFICATION_GRAMMAR,
  ELEMENT_QUANTITY_GRAMMAR,
  ELEMENT_QUANTITY_UNIT_GRAMMAR,
  MODEL_DISCIPLINE_GRAMMAR,
  MODEL_ELEMENT_CHANGE_KIND_GRAMMAR,
  MODEL_EVENT_NAME_GRAMMAR,
  MODEL_OBJECT_KIND_GRAMMAR,
  PROVIDER_LINK_REF_GRAMMAR,
} from './vocabulary';

// THE model reference contracts.
export {
  assertModelObjectMapping,
  compareEntityRef,
  modelProviderCoordinateOf,
  recordModelObjectMapping,
  resolveElementParentChain,
  resolveModelObject,
  resolveProviderLink,
  resolveProviderLinks,
} from './references';
export type {
  ElementParentChain,
  ModelObjectCoordinate,
  RecordModelObjectMappingParts,
} from './references';

// The change-event mapping (translator + canonical event contracts).
export {
  createModelTranslator,
  elementChangedEnvelope,
  elementRetiredEnvelope,
  modelEventEnvelope,
  parseClassificationProviderData,
  parseElementChangedPayload,
  parseElementRetiredPayload,
  parseModelEventPayload,
  parseModelProviderData,
  parseModelRegisteredPayload,
  parseModelUpdatedPayload,
  parseModelVersionProviderData,
  parseModelVersionRegisteredPayload,
  parseClassificationRegisteredPayload,
  parseClassificationUpdatedPayload,
} from './change-mapping';
export type {
  ClassificationProviderData,
  ClassificationRegisteredPayload,
  ClassificationUpdatedPayload,
  ElementChangedEnvelopeParts,
  ElementChangedPayload,
  ElementProviderData,
  ElementRetiredEnvelopeParts,
  ElementRetiredPayload,
  ModelEventEnvelopeParts,
  ModelEventProvenance,
  ModelEventPayloads,
  ModelProviderData,
  ModelRegisteredPayload,
  ModelUpdatedPayload,
  ModelVersionProviderData,
  ModelVersionRegisteredPayload,
} from './change-mapping';

// THE affected-relationship notification flow.
export {
  compareModelEntityNode,
  compareModelRelationshipEdge,
  edgesOfModelEvent,
  isModelEventId,
  modelEventIdOf,
  modelEventReferenceOf,
  notificationsOfModelEvent,
  parseModelEventId,
  projectModelRelationships,
} from './notification';
export type {
  ModelDerivationMetadata,
  ModelEventId,
  ModelEventReference,
  ModelNotificationId,
  ModelRelationshipEdge,
  ModelRelationshipIndex,
  RelationshipNotification,
} from './notification';
export { MODEL_EVENT_ID_GRAMMAR, MODEL_NOTIFICATION_ID_GRAMMAR } from './notification';

// The Adapter implementation + the provider-data port.
export { createModelAdapter } from './adapter';
export type { ModelProviderObject, ModelProviderStore } from './adapter';

// The deterministic in-memory model provider fixture.
export {
  CLASSIFICATION_UPDATED_AT,
  COLUMN_CLASSIFICATION_ID,
  COLUMN_ELEMENT_ID,
  ELEMENTS_UPDATED_AT,
  LINKED_ACTIVITY_REF,
  LINKED_DOCUMENT_REF,
  TOWER_MODEL_ID,
  TOWER_MODEL_UPDATED_AT,
  TOWER_MODEL_V1_ID,
  TOWER_MODEL_V1_UPDATED_AT,
  TOWER_MODEL_V2_ID,
  TOWER_MODEL_V2_UPDATED_AT,
  WALL_CLASSIFICATION_ID,
  WALL_ELEMENT_ID,
  createModelProviderStore,
  createSeededModelProvider,
} from './provider-fixture';
export type { SeededModelProvider } from './provider-fixture';

// The multi-stream sync driver.
export { MAX_SYNC_PAGES_PER_STREAM, runModelSync } from './sync';
export type { ModelSyncOutcome, ModelSyncStreamOutcome } from './sync';
