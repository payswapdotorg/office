// Office app-sdk — public surface (OFF-025).
//
// src/index.ts is the package's WHOLE public surface: marketplace apps
// (apps/sample-app is the reference), the app runtime (OFF-026), and the
// marketplace (OFF-027) consume the package only through this root entry
// point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package imports exactly three workspace dependencies at RUNTIME —
// @office/contracts (ids/scope/actor/envelopes/parse plumbing),
// @office/authz (the closed capability vocabulary), and @office/domain-kernel
// (Result/DomainError) — plus node builtins (crypto digests for the
// deterministic permission ids). @office/actions is consumed TYPE-ONLY
// (the frozen-A8 ActionClass vocabulary; the action registry satisfies the
// validation port structurally), so an importing app's runtime graph stays
// contracts/authz/domain-kernel: no domain, intelligence, sync, adapters,
// agents, or client-sync packages, no SQL, no persistence, no I/O. The
// sample app (apps/sample-app) proves the boundary.
//
// Surface summary:
// - identity:      AppId, AppVersion, ViewId, AppHandlerId, PermissionId,
//                  PermissionVersion (+parse/is/builders, grammars),
//                  permissionIdOf (deterministic derivation), VersionRange
//                  (+parse/is/builder), compareAppVersions, satisfiesVersion
// - permissions:   PermissionSpec (the A9 declaration: capability + scope
//                  kind + version), Permission (the A9 runtime record),
//                  PermissionState (granted → versioned → revoked),
//                  grantPermission, upgradePermission, revokePermission,
//                  isPermissionActive (+parse/is, grammars)
// - bindings:      AppHandler, CommandBinding, BINDABLE_ACTION_CLASSES
//                  (+parse/is, grammars)
// - subscriptions: EventSubscription, EventSubscriptionFilter (+parse/is,
//                  grammars)
// - ui-extensions: EXTENSION_POINTS, ExtensionPointId, ViewElement,
//                  ViewDescriptor, UiExtension, VIEW_MAX_ELEMENTS
//                  (+parse/is, grammars)
// - manifest:      AppDependency, AppManifest, appManifest (trusted
//                  builder), parse/isAppManifest (+grammars)
// - validation:    KnownAction, ActionDescriptorSource, AppCatalogSource,
//                  AppValidationDeps, actionDescriptorSource,
//                  validateAppManifest, reviewAppManifest, ManifestReview
// - registry:      AppRegistry, createInMemoryAppRegistry (in-memory
//                  reference for tests; satisfies AppCatalogSource)
// - vocabulary:    the closed authz capability vocabulary this package's
//                  manifests declare against (CAPABILITIES, capability,
//                  parse/isCapability, Capability) — re-exported so an app
//                  imports ONLY @office/app-sdk (+ @office/contracts)

// App identity, versioning, and the deterministic permission ids.
export {
  APP_HANDLER_ID_GRAMMAR,
  APP_ID_GRAMMAR,
  APP_VERSION_GRAMMAR,
  PERMISSION_ID_GRAMMAR,
  PERMISSION_VERSION_GRAMMAR,
  VERSION_RANGE_GRAMMAR,
  VIEW_ID_GRAMMAR,
  appId,
  appHandlerId,
  appVersion,
  compareAppVersions,
  formatPermissionId,
  isAppHandlerId,
  isAppId,
  isAppVersion,
  isPermissionId,
  isPermissionVersion,
  isVersionRange,
  isViewId,
  parseAppHandlerId,
  parseAppId,
  parseAppVersion,
  parsePermissionId,
  parsePermissionVersion,
  parseVersionRange,
  parseViewId,
  permissionIdOf,
  satisfiesVersion,
  versionRange,
  viewId,
} from './identity';
export type {
  AppHandlerId,
  AppId,
  AppVersion,
  PermissionId,
  PermissionKey,
  PermissionVersion,
  VersionRange,
  ViewId,
} from './identity';

// The A9 permission declarations and lifecycle records.
export {
  PERMISSION_GRAMMAR,
  PERMISSION_SCOPE_KIND_GRAMMAR,
  PERMISSION_SPEC_GRAMMAR,
  grantPermission,
  isPermission,
  isPermissionScopeKind,
  isPermissionSpec,
  isPermissionActive,
  parsePermission,
  parsePermissionScopeKind,
  parsePermissionSpec,
  revokePermission,
  upgradePermission,
} from './permissions';
export type {
  Permission,
  PermissionScopeKind,
  PermissionSpec,
  PermissionState,
} from './permissions';

// Command bindings (typed command + symbolic handler contract + class).
export {
  APP_HANDLER_GRAMMAR,
  BINDABLE_ACTION_CLASSES,
  COMMAND_BINDING_GRAMMAR,
  isAppHandler,
  isCommandBinding,
  parseAppHandler,
  parseCommandBinding,
} from './bindings';
export type { AppHandler, CommandBinding } from './bindings';

// Event subscriptions (canonical event names + typed filters).
export {
  EVENT_SUBSCRIPTION_FILTER_GRAMMAR,
  EVENT_SUBSCRIPTION_GRAMMAR,
  isEventSubscription,
  isEventSubscriptionFilter,
  parseEventSubscription,
  parseEventSubscriptionFilter,
} from './subscriptions';
export type { EventSubscription, EventSubscriptionFilter } from './subscriptions';

// The extension UI contract (closed extension points + typed views).
export {
  EXTENSION_POINT_GRAMMAR,
  EXTENSION_POINTS,
  UI_EXTENSION_GRAMMAR,
  VIEW_DESCRIPTOR_GRAMMAR,
  VIEW_ELEMENT_GRAMMAR,
  VIEW_MAX_ELEMENTS,
  isExtensionPointId,
  isUiExtension,
  isViewDescriptor,
  isViewElement,
  parseExtensionPointId,
  parseUiExtension,
  parseViewDescriptor,
} from './ui-extensions';
export type {
  ExtensionPointId,
  UiExtension,
  ViewDescriptor,
  ViewElement,
} from './ui-extensions';

// THE AppManifest model.
export {
  APP_DEPENDENCY_GRAMMAR,
  APP_MANIFEST_GRAMMAR,
  appManifest,
  isAppDependency,
  isAppManifest,
  parseAppDependency,
  parseAppManifest,
} from './manifest';
export type { AppDependency, AppManifest } from './manifest';

// Cross-reference validation against the real action/app vocabularies.
export {
  actionDescriptorSource,
  reviewAppManifest,
  validateAppManifest,
} from './validation';
export type {
  ActionDescriptorSource,
  AppCatalogSource,
  AppValidationDeps,
  KnownAction,
  ManifestReview,
} from './validation';

// The in-memory manifest registry (test reference; a catalog source).
export { createInMemoryAppRegistry } from './registry';
export type { AppRegistry } from './registry';

// The closed capability vocabulary manifests declare against (authz
// re-export so an app imports only this package + @office/contracts).
export { CAPABILITIES, capability, isCapability, parseCapability } from '@office/authz';
export type { Capability } from '@office/authz';

// The frozen-A8 action class vocabulary command bindings declare against
// (TYPE-ONLY re-export from @office/actions — no runtime import).
export type { ActionClass } from '@office/actions';
