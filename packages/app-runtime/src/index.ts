// Office app-runtime — public surface (OFF-026).
//
// src/index.ts is the package's WHOLE public surface: the marketplace
// (OFF-027), the web/desktop clients (OFF-030/031), the release gate
// (OFF-036) consume the package only through this root entry point, never
// through deeper paths. Anything not re-exported here is package-internal
// and may change without notice.
//
// The package imports exactly five workspace dependencies at RUNTIME —
// @office/app-sdk (the manifest/permission records + the validation ports),
// @office/actions (THE action gateway: actionProposal + executeAction —
// the only mutation path), @office/contracts (envelopes, Actor, parse
// plumbing), @office/authz (the closed capability vocabulary + Policy), and
// @office/domain-kernel (Result/DomainError) — plus the TYPE-ONLY
// SqlExecutor surface of @office/persistence (the AppEventSink port
// signature). NO domain, intelligence, sync, adapters, agents, or
// client-sync packages; no SQL; no provider vocabulary; NO arbitrary app
// code execution — the runtime mediates COMMANDS and EVENTS for declared
// apps, the host executes typed handlers.
//
// Surface summary:
// - installation:  AppInstallation, AppLifecycleState (+ the state list,
//                  parse/is, grammars), installInstallation (trusted
//                  builder), activate/suspend/revoke/uninstallInstallation
//                  (the typed lifecycle state machine), installationActor
//                  (the 'app' actor of an installation),
//                  isInstallationDispatchable, LifecycleTransition
// - hooks:         LIFECYCLE_HOOKS, LifecycleHookName, AppLifecycleHook,
//                  LifecycleHookInvocation (+parse/is, grammars),
//                  appLifecycleHooks (trusted builder),
//                  lifecycleHookInvocationOf
// - permissions:   grantManifestPermissions, installationGrantView,
//                  checkInstallationCapabilities (THE A9 dispatch gate),
//                  requiredCapabilityOfEvent,
//                  revokeInstallationPermission,
//                  upgradeInstallationPermission
// - namespace:     AppCommandNamespaceEntry, AppEventNamespaceEntry,
//                  AppCommandNamespaceId, AppEventNamespaceId
//                  (+parse/is, grammars, derivations, formats),
//                  namespaceIdOf
// - dispatch:      appCommandDispatch, appEventDispatch (THE two engines),
//                  matchEventSubscription, AppDispatchDeps,
//                  AppCommandDispatchInput/Record/Outcome,
//                  AppEventDeliveryRecord, the closed rejection-reason
//                  vocabularies
// - audit events:  the nine APP_*_EVENT name constants,
//                  APP_RUNTIME_EVENT_NAMES, AppRuntimeDecision/
//                  APP_RUNTIME_DECISIONS, AppRuntimeAuditPayload,
//                  appRuntimeEventEnvelope, commandCausationIdOf,
//                  THE AppEventSink port, InMemoryAppEventSink/
//                  createInMemoryAppEventSink, failingAppEventSink,
//                  appSinkFailure
// - registry:      AppInstallationStore, AppPermissionStore,
//                  AppNamespaceStore, InMemoryAppRuntimeStore,
//                  createInMemoryAppRuntimeStore
// - runtime:       createAppRuntime (the composed engine),
//                  AppRuntime/AppRuntimeDeps, AppInstallInput/Record,
//                  AppLifecycleInput, AppCommandDispatchRequest,
//                  AppEventDispatchRequest

// THE AppInstallation model + the typed lifecycle state machine.
export {
  APP_INSTALLATION_GRAMMAR,
  APP_LIFECYCLE_GRAMMAR,
  APP_LIFECYCLE_STATES,
  activateInstallation,
  installInstallation,
  installationActor,
  isAppInstallation,
  isAppLifecycleState,
  isInstallationDispatchable,
  parseAppInstallation,
  parseAppLifecycleState,
  revokeInstallation,
  suspendInstallation,
  uninstallInstallation,
} from './installation';
export type {
  AppInstallation,
  AppLifecycleState,
  LifecycleTransition,
} from './installation';

// The declared lifecycle hooks (descriptor records the host invokes).
export {
  LIFECYCLE_HOOKS,
  LIFECYCLE_HOOK_GRAMMAR,
  LIFECYCLE_HOOK_INVOCATION_GRAMMAR,
  appLifecycleHooks,
  isAppLifecycleHook,
  isLifecycleHookInvocation,
  lifecycleHookInvocationOf,
  parseAppLifecycleHook,
  parseAppLifecycleHooks,
  parseLifecycleHookInvocation,
} from './hooks';
export type {
  AppLifecycleHook,
  LifecycleHookInvocation,
  LifecycleHookName,
} from './hooks';

// The per-installation A9 permission enforcement.
export {
  checkInstallationCapabilities,
  grantManifestPermissions,
  installationGrantView,
  parseInstallationPermission,
  requiredCapabilityOfEvent,
  revokeInstallationPermission,
  upgradeInstallationPermission,
} from './permissions';

// The per-installation app command/event namespace.
export {
  APP_COMMAND_NAMESPACE_GRAMMAR,
  APP_COMMAND_NAMESPACE_ID_GRAMMAR,
  APP_EVENT_NAMESPACE_GRAMMAR,
  APP_EVENT_NAMESPACE_ID_GRAMMAR,
  appCommandNamespaceIdOf,
  appEventNamespaceIdOf,
  formatAppCommandNamespaceId,
  formatAppEventNamespaceId,
  isAppCommandNamespaceEntry,
  isAppCommandNamespaceId,
  isAppEventNamespaceEntry,
  isAppEventNamespaceId,
  namespaceIdOf,
  parseAppCommandNamespaceEntry,
  parseAppCommandNamespaceId,
  parseAppEventNamespaceEntry,
  parseAppEventNamespaceId,
} from './namespace';
export type {
  AppCommandNamespaceEntry,
  AppCommandNamespaceId,
  AppEventNamespaceEntry,
  AppEventNamespaceId,
} from './namespace';

// THE two dispatch engines + the typed records.
export {
  APP_COMMAND_REJECTION_REASONS,
  APP_EVENT_REJECTION_REASONS,
  appCommandDispatch,
  appEventDispatch,
  matchEventSubscription,
} from './dispatch';
export type {
  AppCommandDispatchInput,
  AppCommandDispatchRecord,
  AppCommandOutcome,
  AppCommandRejectionReason,
  AppDispatchDeps,
  AppEventDeliveryRecord,
  AppEventRejectionReason,
} from './dispatch';

// The runtime's own audit events + THE AppEventSink port.
export {
  APP_ACTIVATED_EVENT,
  APP_COMMAND_DISPATCHED_EVENT,
  APP_COMMAND_REJECTED_EVENT,
  APP_EVENT_DELIVERED_EVENT,
  APP_EVENT_REJECTED_EVENT,
  APP_INSTALLED_EVENT,
  APP_REVOKED_EVENT,
  APP_RUNTIME_DECISIONS,
  APP_RUNTIME_EVENT_NAMES,
  APP_SUSPENDED_EVENT,
  APP_UNINSTALLED_EVENT,
  appRuntimeEventEnvelope,
  appSinkFailure,
  commandCausationIdOf,
  createInMemoryAppEventSink,
  failingAppEventSink,
} from './audit-events';
export type {
  AppEventSink,
  AppLifecycleDecision,
  AppRuntimeAuditPayload,
  AppRuntimeDecision,
  InMemoryAppEventSink,
  RecordedAppEventAppend,
} from './audit-events';

// The in-memory installation registry (the deterministic reference).
export { createInMemoryAppRuntimeStore } from './registry';
export type {
  AppInstallationStore,
  AppNamespaceStore,
  AppPermissionStore,
  InMemoryAppRuntimeStore,
} from './registry';

// The composed runtime engine.
export { createAppRuntime } from './runtime';
export type {
  AppCommandDispatchRequest,
  AppEventDispatchRequest,
  AppInstallInput,
  AppInstallRecord,
  AppLifecycleInput,
  AppRuntime,
  AppRuntimeDeps,
} from './runtime';
