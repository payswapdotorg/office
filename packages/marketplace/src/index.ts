// Office marketplace — public surface (OFF-027).
//
// src/index.ts is the package's WHOLE public surface: OFF-035 (system-
// coverage analysis) and OFF-038 (release gates) consume the package only
// through this root entry point, never through deeper paths. Anything not
// re-exported here is package-internal and may change without notice.
//
// The package imports exactly four workspace dependencies at RUNTIME —
// @office/app-sdk (manifests, permission specs, version ranges, the
// validation/review ports, AppCatalogSource), @office/contracts (ids, actor,
// timestamps, the fail-closed parse plumbing), @office/domain-kernel
// (Result/DomainError), and @office/authz (the closed capability vocabulary
// the fresh-grant confirmations validate against) — plus the TYPE-ONLY
// installation surface of @office/app-runtime (AppInstallation and
// AppLifecycleState: the marketplace LINKS to installation identities, it
// never constructs or executes the runtime). NO domain, intelligence, sync,
// adapters, agents, client-sync, events, workflows, or persistence
// packages; no SQL; no network; no app code execution (A7); no canonical
// state mutation (A11) and no canonical events.
//
// Surface summary:
// - identity:      PublisherId, ReleaseId, EntitlementId,
//                  InstallationLinkId, UpdateId, AuditRecordId
//                  (+parse/is/format, grammars) and the deterministic
//                  derivations publisherIdOf / releaseIdOf /
//                  entitlementIdOf / installationLinkIdOf / updateIdOf /
//                  auditRecordIdOf
// - audit:         MarketplaceTransition (+ MARKETPLACE_TRANSITIONS),
//                  MarketplaceAuditDetail, MarketplaceAuditRecord,
//                  marketplaceAuditRecord, EMPTY_AUDIT_DETAIL, THE
//                  MarketplaceAuditSink port, createInMemoryMarketplaceAuditSink,
//                  failingMarketplaceAuditSink, auditSinkFailure
// - canonical:     CanonicalStateSnapshot, CanonicalStatePort (the A11 probe)
// - publisher:     Publisher, PublisherState (+parse/is, grammars),
//                  registerPublisher, revokePublisher, isPublisherActive,
//                  mayPublishApp
// - release:       AppRelease (+parse/is, grammar), publishReleaseRecord
// - catalog:       CatalogEntry, EntitledCatalogEntry, catalogSnapshotOf,
//                  catalogEntryOf, catalogSourceOf, entitledCatalogOf,
//                  coveringEntitlements
// - entitlement:   Entitlement, EntitlementState (+parse/is, grammars),
//                  grantEntitlement, revokeEntitlement, entitlesRelease,
//                  versionRangeKey
// - link:          InstallationLink, InstallationLinkState,
//                  UNLINKABLE_RUNTIME_STATES (+parse/is, grammars),
//                  linkInstallation, moveInstallationLink, unlinkInstallation,
//                  parseRuntimeLifecycleSnapshot
// - update:        PermissionDelta, permissionDeltaOf, addsCapability,
//                  PermissionConfirmation (+parse/is), confirmationsCover,
//                  InstallationUpdate, UpdateState (+parse/is, grammars),
//                  stageInstallationUpdate, applyStagedUpdate,
//                  rollBackAppliedUpdate, permissionSummary,
//                  confirmationSummary
// - store:         the five record-store ports + InMemoryMarketplaceStore,
//                  createInMemoryMarketplaceStore
// - engine:        Marketplace, MarketplaceDeps, AppliedUpdate,
//                  createMarketplace (THE composed engine)

// The branded identity vocabulary + the deterministic derivations.
export {
  AUDIT_RECORD_ID_GRAMMAR,
  ENTITLEMENT_ID_GRAMMAR,
  INSTALLATION_LINK_ID_GRAMMAR,
  PUBLISHER_ID_GRAMMAR,
  RELEASE_ID_GRAMMAR,
  UPDATE_ID_GRAMMAR,
  auditRecordIdOf,
  entitlementIdOf,
  formatAuditRecordId,
  formatEntitlementId,
  formatInstallationLinkId,
  formatPublisherId,
  formatReleaseId,
  formatUpdateId,
  installationLinkIdOf,
  isAuditRecordId,
  isEntitlementId,
  isInstallationLinkId,
  isPublisherId,
  isReleaseId,
  isUpdateId,
  parseAuditRecordId,
  parseEntitlementId,
  parseInstallationLinkId,
  parsePublisherId,
  parseReleaseId,
  parseUpdateId,
  publisherIdOf,
  releaseIdOf,
  updateIdOf,
} from './identity';
export type {
  AuditRecordId,
  EntitlementId,
  InstallationLinkId,
  PublisherId,
  ReleaseId,
  UpdateId,
} from './identity';
export type { AuditRecordKey, EntitlementKey, InstallationLinkKey, PublisherKey, ReleaseKey, UpdateKey } from './identity';

// THE typed audit ledger.
export {
  EMPTY_AUDIT_DETAIL,
  MARKETPLACE_AUDIT_DETAIL_GRAMMAR,
  MARKETPLACE_AUDIT_RECORD_GRAMMAR,
  MARKETPLACE_TRANSITIONS,
  MARKETPLACE_TRANSITION_GRAMMAR,
  auditRecordToJson,
  auditSinkFailure,
  createInMemoryMarketplaceAuditSink,
  failingMarketplaceAuditSink,
  isMarketplaceAuditRecord,
  marketplaceAuditRecord,
  parseMarketplaceAuditDetail,
  parseMarketplaceAuditRecord,
} from './audit';
export type {
  InMemoryMarketplaceAuditSink,
  MarketplaceAuditDetail,
  MarketplaceAuditRecord,
  MarketplaceAuditSink,
  MarketplaceTransition,
  RecordedMarketplaceAppend,
} from './audit';

// The canonical-state observation port (the A11 boundary proof).
export type { CanonicalStatePort, CanonicalStateSnapshot } from './canonical-state';

// Publisher registration & revocation.
export {
  PUBLISHER_GRAMMAR,
  PUBLISHER_STATES,
  PUBLISHER_STATE_GRAMMAR,
  isPublisher,
  isPublisherState,
  mayPublishApp,
  parsePublisher,
  parsePublisherState,
  registerPublisher,
  revokePublisher,
} from './publisher';
export type { Publisher, PublisherState } from './publisher';

// App releases (immutable once published).
export { APP_RELEASE_GRAMMAR, isAppRelease, parseAppRelease, publishReleaseRecord } from './release';
export type { AppRelease } from './release';

// The catalog projections.
export {
  catalogEntryOf,
  catalogSnapshotOf,
  catalogSourceOf,
  coveringEntitlements,
  entitledCatalogOf,
} from './catalog';
export type { CatalogEntry, EntitledCatalogEntry } from './catalog';

// Tenant entitlements.
export {
  ENTITLEMENT_GRAMMAR,
  ENTITLEMENT_STATES,
  ENTITLEMENT_STATE_GRAMMAR,
  entitlesRelease,
  grantEntitlement,
  isEntitlement,
  isEntitlementState,
  parseEntitlement,
  parseEntitlementState,
  revokeEntitlement,
  versionRangeKey,
} from './entitlement';
export type { Entitlement, EntitlementState } from './entitlement';

// Installation metadata linkage.
export {
  INSTALLATION_LINK_GRAMMAR,
  INSTALLATION_LINK_STATES,
  INSTALLATION_LINK_STATE_GRAMMAR,
  UNLINKABLE_RUNTIME_STATES,
  isInstallationLink,
  isInstallationLinkState,
  linkInstallation,
  moveInstallationLink,
  parseInstallationLink,
  parseInstallationLinkState,
  parseRuntimeLifecycleSnapshot,
  unlinkInstallation,
} from './installation-link';
export type { InstallationLink, InstallationLinkState } from './installation-link';

// Updates with permission-delta review.
export {
  INSTALLATION_UPDATE_GRAMMAR,
  PERMISSION_CONFIRMATION_GRAMMAR,
  PERMISSION_DELTA_GRAMMAR,
  UPDATE_STATES,
  UPDATE_STATE_GRAMMAR,
  addsCapability,
  applyStagedUpdate,
  confirmationSummary,
  confirmationsCover,
  isInstallationUpdate,
  isPermissionConfirmation,
  isPermissionDelta,
  parseInstallationUpdate,
  parsePermissionConfirmation,
  parsePermissionDelta,
  permissionDeltaOf,
  permissionSummary,
  rollBackAppliedUpdate,
  stageInstallationUpdate,
} from './update';
export type {
  InstallationUpdate,
  PermissionConfirmation,
  PermissionDelta,
  UpdateState,
} from './update';

// The record stores (in-memory deterministic reference).
export { createInMemoryMarketplaceStore } from './store';
export type {
  EntitlementStore,
  InstallationLinkStore,
  InMemoryMarketplaceStore,
  PublisherStore,
  ReleaseStore,
  UpdateStore,
} from './store';

// THE composed engine.
export { createMarketplace } from './engine';
export type { AppliedUpdate, Marketplace, MarketplaceDeps } from './engine';
