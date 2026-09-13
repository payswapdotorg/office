// Office adapter-schedule — public surface (OFF-023).
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
// of the relationship engine is ever imported, per the frozen OFF-023
// boundary) — plus node builtins (crypto digests). No new external
// dependencies; no I/O, no SQL, no clock, no randomness (ports and injected
// suppliers everywhere); no real vendor SDK.
//
// Surface summary:
// - vocabulary:   the schedule adapter family ('schedule-pm' /
//                 'schedule-instance-01'), the four schedule object kinds +
//                 their canonical kinds, the capability block, the
//                 schedules-area command + event names, the CPM link-type
//                 vocabulary (FS/SS/FF/SF) + lag/duration bounds, the ISO
//                 calendar date vocabulary (+parse/is), the provider
//                 payload string rules
// - references:   THE schedule reference contracts —
//                 recordScheduleObjectMapping (kind + hierarchy discipline:
//                 activities/dependencies/baselines over their schedule,
//                 dependencies over BOTH endpoint activities),
//                 assertScheduleObjectMapping, resolveScheduleObject,
//                 resolveOwningSchedule, resolveDependencyEndpoints,
//                 scheduleProviderCoordinateOf, compareEntityRef
// - change-mapping: createScheduleTranslator (provider mutations → canonical
//                 command proposals; baselines/dependencies immutable,
//                 history append-only), the schedules-area event payload
//                 contracts + parses, scheduleEventEnvelope and the concrete
//                 envelope builders (the host-side execution seam)
// - notification: THE downstream impact-notification flow —
//                 ScheduleEventId/scheduleEventIdOf (the source event id),
//                 edgesOfScheduleEvent, projectScheduleRelationships (the
//                 deterministic relationship projection deriving the
//                 expected affected edges at every activity update),
//                 impactedEntitiesOfActivity, and notificationsOfScheduleEvent
//                 (the notification records, each referencing the source
//                 event id with full causality)
// - conflict-rules: THE typed conflict rules (the named focus) —
//                 ScheduleConflictKind, classifyScheduleConflict,
//                 detectDependencyCycle, parseDependencyCycle,
//                 detectScheduleDivergences (the pre-flight divergence pass
//                 composing explicit Conflict records with both sides)
// - adapter:      createScheduleAdapter (the Adapter implementation) + the
//                 ScheduleProviderObject/ScheduleProviderStore port
// - fixture:      createScheduleProviderStore + createSeededScheduleProvider
//                 (the deterministic in-memory provider: a schedule with
//                 three activities, two FS dependencies with lag, one
//                 protected baseline, mutation streams incl. the divergence
//                 scenarios, the divergence view, webhook emission)
// - sync:         runScheduleSync (the multi-stream driver in schedule
//                 hierarchy order, over the SDK's engine, with the
//                 pre-flight conflict-rule pass and quarantine)

// The schedule vocabulary (generic names only — the provider specifics live
// inside this package by design).
export {
  ACTIVITY_CODE_RULE,
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  BASELINE_LABEL_RULE,
  BASELINE_OBJECT_KIND,
  CREATE_SCHEDULE_COMMAND,
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  LAG_DAYS_BOUNDS,
  LAG_DAYS_DESCRIPTION,
  PLANNED_DURATION_BOUNDS,
  PLANNED_DURATION_DESCRIPTION,
  PROJECT_SCHEDULE_OBJECT_KIND,
  PROVIDER_ID_RULE,
  REMOVE_DEPENDENCY_COMMAND,
  SCHEDULE_ADAPTER_CAPABILITIES,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_CREATED_EVENT,
  SCHEDULE_EVENT_NAMES,
  SCHEDULE_LINK_TYPE_GRAMMAR,
  SCHEDULE_NAME_RULE,
  SCHEDULE_OBJECT_FAMILY,
  SCHEDULE_SYNC_CAPABILITY_NAME,
  SCHEDULE_SYSTEM_ID,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_UPDATED_EVENT,
  BASELINE_SET_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  canonicalKindOfScheduleObjectKind,
  isScheduleDate,
  isScheduleEventName,
  isScheduleLinkType,
  isScheduleObjectKind,
  parseNullableProviderId,
  parseProviderDependencyPair,
  parseProviderIdField,
  parseScheduleDate,
  parseScheduleEventName,
  parseScheduleLinkType,
  parseScheduleObjectKind,
} from './vocabulary';
export type {
  ScheduleDate,
  ScheduleLinkType,
} from './vocabulary';
export {
  PROVIDER_DEPENDENCY_PAIR_GRAMMAR,
  SCHEDULE_DATE_GRAMMAR,
  SCHEDULE_EVENT_NAME_GRAMMAR,
  SCHEDULE_OBJECT_KIND_GRAMMAR,
} from './vocabulary';

// THE schedule reference contracts.
export {
  assertScheduleObjectMapping,
  compareEntityRef,
  recordScheduleObjectMapping,
  resolveDependencyEndpoints,
  resolveOwningSchedule,
  resolveScheduleObject,
  scheduleProviderCoordinateOf,
} from './references';
export type {
  RecordScheduleObjectMappingParts,
  ScheduleObjectCoordinate,
  ScheduleObjectParents,
} from './references';

// The change-event mapping (translator + canonical event contracts).
export {
  activityAddedEnvelope,
  activityUpdatedEnvelope,
  baselineSetEnvelope,
  createScheduleTranslator,
  dependencyAddedEnvelope,
  dependencyRemovedEnvelope,
  parseActivityAddedPayload,
  parseActivityDependencyProviderData,
  parseActivityProviderData,
  parseActivityUpdatedPayload,
  parseBaselineProviderData,
  parseBaselineSetPayload,
  parseDependencyAddedPayload,
  parseDependencyRemovedPayload,
  parseProjectScheduleProviderData,
  parseScheduleCreatedPayload,
  parseScheduleEventPayload,
  scheduleCreatedEnvelope,
  scheduleEventEnvelope,
} from './change-mapping';
export type {
  ActivityAddedEnvelopeParts,
  ActivityAddedPayload,
  ActivityDependencyProviderData,
  ActivityProviderData,
  ActivityUpdatedEnvelopeParts,
  ActivityUpdatedPayload,
  BaselineProviderData,
  BaselineSetEnvelopeParts,
  BaselineSetPayload,
  DependencyAddedEnvelopeParts,
  DependencyAddedPayload,
  DependencyRemovedEnvelopeParts,
  DependencyRemovedPayload,
  ProjectScheduleProviderData,
  ScheduleCreatedEnvelopeParts,
  ScheduleCreatedPayload,
  ScheduleEventEnvelopeParts,
  ScheduleEventPayloads,
  ScheduleEventProvenance,
} from './change-mapping';

// THE downstream impact-notification flow.
export {
  compareScheduleEntityNode,
  compareScheduleRelationshipEdge,
  edgesOfScheduleEvent,
  impactedEntitiesOfActivity,
  isScheduleEventId,
  notificationsOfScheduleEvent,
  parseScheduleEventId,
  projectScheduleRelationships,
  scheduleEventIdOf,
  scheduleEventReferenceOf,
} from './notification';
export type {
  RelationshipNotification,
  ScheduleDerivationMetadata,
  ScheduleEventId,
  ScheduleEventReference,
  ScheduleNotificationId,
  ScheduleRelationshipEdge,
  ScheduleRelationshipIndex,
} from './notification';
export { SCHEDULE_EVENT_ID_GRAMMAR, SCHEDULE_NOTIFICATION_ID_GRAMMAR } from './notification';

// THE typed conflict rules (the named focus).
export {
  classifyScheduleConflict,
  detectDependencyCycle,
  detectScheduleDivergences,
  parseDependencyCycle,
  parseScheduleConflictKind,
} from './conflict-rules';
export type {
  DetectedScheduleDivergence,
  DependencyCycle,
  DetectScheduleDivergencesParts,
  ProviderBaselineState,
  ProviderDependencyEdge,
  ScheduleConflictKind,
  ScheduleDependencyEdge,
  ScheduleDivergenceView,
} from './conflict-rules';
export {
  DEPENDENCY_CYCLE_GRAMMAR,
  SCHEDULE_CONFLICT_KIND_GRAMMAR,
} from './conflict-rules';

// The Adapter implementation + the provider-data port.
export { createScheduleAdapter } from './adapter';
export type { ScheduleProviderObject, ScheduleProviderStore } from './adapter';

// The deterministic in-memory schedule provider fixture.
export {
  ACTIVITIES_UPDATED_AT,
  BASELINE_UPDATED_AT,
  DEPENDENCIES_UPDATED_AT,
  ENVELOPE_ACTIVITY_ID,
  FOUNDATIONS_ACTIVITY_ID,
  FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
  SEPTEMBER_BASELINE_ID,
  STRUCTURE_ACTIVITY_ID,
  STRUCTURE_ENVELOPE_DEPENDENCY_ID,
  TOWER_SCHEDULE_ID,
  TOWER_SCHEDULE_UPDATED_AT,
  createScheduleProviderStore,
  createSeededScheduleProvider,
} from './provider-fixture';
export type { SeededScheduleProvider } from './provider-fixture';

// The multi-stream sync driver (with the pre-flight conflict-rule pass).
export { MAX_SYNC_PAGES_PER_STREAM, runScheduleSync } from './sync';
export type {
  ScheduleConflictClassification,
  ScheduleSyncOutcome,
  ScheduleSyncStreamOutcome,
} from './sync';
