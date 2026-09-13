// Office app-runtime — the composed runtime engine (OFF-026).
//
// The wiring layer over the pure modules: ONE engine that owns an
// in-memory store (installations, A9 permission grants, the command/event
// namespace) and performs the audited operations —
//
//   install   → the installation record ('installing') + the manifest's
//               permission grants + the namespace entries (bindings and
//               subscriptions registered under their derived identities,
//               collisions typed-rejected) + the on-install hook + audit;
//   activate / suspend / revoke / uninstall → the typed lifecycle
//               transitions with their hooks, each audited;
//   dispatchCommand / dispatchEvent / dispatchEventToSubscribers → the
//               dispatch engines over the store's records;
//   revokePermission / upgradePermission → the A9 grant lifecycle with the
//               ownership discipline.
//
// Every operation is a typed Result; every lifecycle transition and every
// dispatch decision is audited through the AppEventSink port. The engine
// holds NO canonical entities (A11 — it composes the canonical graph only:
// commands travel to the gateway, events travel to typed delivery records)
// and executes NO app code (A7/A8 — hooks are symbolic descriptors the
// HOST invokes).
import type {
  Actor,
  CausationId,
  CorrelationId,
  DomainEventEnvelope,
  EntityId,
  TenantId,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type {
  AppManifest,
  Permission,
  PermissionId,
  PermissionSpec,
} from '@office/app-sdk';
import type { AppLifecycleHook, LifecycleHookInvocation } from './hooks';
import { lifecycleHookInvocationOf } from './hooks';
import {
  activateInstallation,
  installInstallation,
  installationActor,
  revokeInstallation,
  suspendInstallation,
  uninstallInstallation,
} from './installation';
import type { AppInstallation, LifecycleTransition } from './installation';
import {
  grantManifestPermissions,
  revokeInstallationPermission,
  upgradeInstallationPermission,
} from './permissions';
import type {
  AppCommandNamespaceEntry,
  AppEventNamespaceEntry,
} from './namespace';
import {
  createInMemoryAppRuntimeStore,
} from './registry';
import type { InMemoryAppRuntimeStore } from './registry';
import {
  appCommandDispatch,
  appEventDispatch,
} from './dispatch';
import type {
  AppCommandDispatchInput,
  AppCommandDispatchRecord,
  AppDispatchDeps,
  AppEventDeliveryRecord,
} from './dispatch';
import {
  APP_ACTIVATED_EVENT,
  APP_INSTALLED_EVENT,
  APP_REVOKED_EVENT,
  APP_SUSPENDED_EVENT,
  APP_UNINSTALLED_EVENT,
  appRuntimeEventEnvelope,
} from './audit-events';
import type { AppRuntimeAuditPayload } from './audit-events';

/** The wiring dependencies of the composed runtime engine. */
export interface AppRuntimeDeps extends AppDispatchDeps {
  /** Injected canonical installation-id supplier (fresh installations). */
  readonly newInstallationId: () => EntityId;
}

/** The input of one install operation. */
export interface AppInstallInput {
  /** The validated manifest being installed (typed, already reviewed). */
  readonly manifest: AppManifest;
  /** The tenant the installation lives in (A12). */
  readonly tenantId: TenantId;
  /** The declared lifecycle hooks (optional — descriptor records). */
  readonly hooks?: readonly AppLifecycleHook[];
  /** The canonical installation id (defaults to the injected supplier). */
  readonly installationId?: EntityId;
  /** The actor performing the install (also grants the permissions). */
  readonly installedBy: Actor;
  /** The correlation id of the install chain (audit causality). */
  readonly correlationId: CorrelationId;
  /** The causation id of the install operation, or null (chain root). */
  readonly causationId?: CausationId | null;
}

/** The typed result of one install operation. */
export interface AppInstallRecord {
  readonly installation: AppInstallation;
  readonly permissions: readonly Permission[];
  readonly commands: readonly AppCommandNamespaceEntry[];
  readonly events: readonly AppEventNamespaceEntry[];
  readonly invokedHooks: readonly LifecycleHookInvocation[];
}

/** The input of one lifecycle operation (activate/suspend/revoke/uninstall). */
export interface AppLifecycleInput {
  readonly installationId: EntityId;
  /** The acting operator (suspend/revoke/uninstall; ignored by activate). */
  readonly by?: Actor;
  /** The correlation id of the operation's chain (audit causality). */
  readonly correlationId: CorrelationId;
  /** The causation id, or null (chain root). */
  readonly causationId?: CausationId | null;
}

/** The input of one engine-mediated command dispatch. */
export interface AppCommandDispatchRequest extends AppCommandDispatchInput {
  readonly installationId: EntityId;
}

/** The input of one engine-mediated event dispatch. */
export interface AppEventDispatchRequest {
  readonly installationId: EntityId;
  readonly event: DomainEventEnvelope;
}

/** The composed app runtime engine (see the module comment). */
export interface AppRuntime {
  /** Install one validated manifest for one tenant (audited). */
  install(input: AppInstallInput): Promise<Result<AppInstallRecord, DomainError>>;
  /** Activate an installation (audited; on-activate hook). */
  activate(input: AppLifecycleInput): Promise<Result<LifecycleTransition, DomainError>>;
  /** Suspend an installation — it stops receiving commands AND events. */
  suspend(input: AppLifecycleInput): Promise<Result<LifecycleTransition, DomainError>>;
  /** Revoke an installation (terminal, one-way; on-revoke hook). */
  revoke(input: AppLifecycleInput): Promise<Result<LifecycleTransition, DomainError>>;
  /** Uninstall an installation (terminal; canonical state preserved). */
  uninstall(input: AppLifecycleInput): Promise<Result<LifecycleTransition, DomainError>>;
  /** Dispatch one app command through the gateway (audited). */
  dispatchCommand(
    request: AppCommandDispatchRequest,
  ): Promise<Result<AppCommandDispatchRecord, DomainError>>;
  /** Deliver one event to one installation's subscription (audited). */
  dispatchEvent(
    request: AppEventDispatchRequest,
  ): Promise<Result<AppEventDeliveryRecord, DomainError>>;
  /**
   * Deliver one event to EVERY installation subscribed to its name (the
   * fan-out), in namespace registration order — each subscription's typed
   * outcome, delivered or rejected.
   */
  dispatchEventToSubscribers(
    event: DomainEventEnvelope,
  ): Promise<readonly Result<AppEventDeliveryRecord, DomainError>[]>;
  /** Revoke one permission grant of one installation (A9, terminal). */
  revokePermission(parts: {
    readonly installationId: EntityId;
    readonly permissionId: PermissionId;
    readonly revokedBy: Actor;
  }): Promise<Result<Permission, DomainError>>;
  /** Upgrade one permission grant of one installation (A9, versioned). */
  upgradePermission(parts: {
    readonly installationId: EntityId;
    readonly permissionId: PermissionId;
    readonly spec: PermissionSpec;
  }): Promise<Result<Permission, DomainError>>;
  /** The engine's store (tests/host introspection; the marketplace's). */
  readonly store: InMemoryAppRuntimeStore;
}

const notFound = (what: string, key: string): Result<never, DomainError> =>
  fail(
    domainError('not-found', `${what} '${key}' is not registered in the app runtime store`, [
      { code: 'unknown-installation', message: key, path: null },
    ]),
  );

/** The lifecycle audit payload of one transition. */
const lifecyclePayloadOf = (
  installation: AppInstallation,
  decision: AppRuntimeAuditPayload['decision'],
  invokedHooks: readonly LifecycleHookInvocation[],
): AppRuntimeAuditPayload => ({
  installationId: installation.installationId,
  appId: installation.appId,
  tenantId: installation.tenantId,
  installationState: installation.state,
  decision,
  commandName: null,
  handlerId: null,
  idempotencyKey: null,
  eventName: null,
  reason: null,
  deliveryId: null,
  invokedHooks: invokedHooks.map((invocation) => ({
    hook: invocation.hook,
    handlerId: invocation.handlerId,
  })),
});

/**
 * Create the composed app runtime engine over an in-memory store (the
 * deterministic reference — the marketplace and the real runtime swap the
 * store for persistence-backed ports with the same shapes).
 */
export function createAppRuntime(
  deps: AppRuntimeDeps,
  store: InMemoryAppRuntimeStore = createInMemoryAppRuntimeStore(),
): AppRuntime {
  const auditTransition = async (
    installation: AppInstallation,
    decision: AppRuntimeAuditPayload['decision'],
    eventName: Parameters<typeof appRuntimeEventEnvelope>[0]['eventName'],
    invokedHooks: readonly LifecycleHookInvocation[],
    correlationId: CorrelationId,
    causationId: CausationId | null,
  ): Promise<Result<true, DomainError>> =>
    deps.sink.appendEvents(deps.executor, [
      appRuntimeEventEnvelope({
        eventName,
        payload: lifecyclePayloadOf(installation, decision, invokedHooks),
        actor: installationActor(installation),
        tenantId: installation.tenantId,
        correlationId,
        causationId,
        occurredAt: deps.now(),
      }),
    ]);

  const transition = async (
    input: AppLifecycleInput,
    eventName: Parameters<typeof appRuntimeEventEnvelope>[0]['eventName'],
    decision: AppRuntimeAuditPayload['decision'],
    perform: (installation: AppInstallation) => Result<LifecycleTransition, DomainError>,
    needsActor: boolean,
  ): Promise<Result<LifecycleTransition, DomainError>> => {
    const installation = store.installations.find(input.installationId);
    if (installation === null) {
      return notFound('installation', input.installationId);
    }
    if (needsActor && input.by === undefined) {
      return fail(
        domainError(
          'invariant-violation',
          `the lifecycle transition needs an acting operator ('by')`,
          [{ code: 'operator-required', message: input.installationId, path: 'by' }],
        ),
      );
    }
    const result = perform(installation);
    if (!result.ok) return result;
    // Audit BEFORE the store mutation: a sink failure leaves the store
    // untouched (the operation is all-or-nothing).
    const appended = await auditTransition(
      result.value.installation,
      decision,
      eventName,
      result.value.invokedHooks,
      input.correlationId,
      input.causationId ?? null,
    );
    if (!appended.ok) return appended;
    store.installations.put(result.value.installation);
    return ok(result.value);
  };

  return {
    store,

    install: async (input) => {
      const installationId = input.installationId ?? deps.newInstallationId();

      if (store.installations.find(installationId) !== null) {
        return fail(
          domainError(
            'concurrency-conflict',
            `installation '${installationId}' already exists — re-install after revocation is a NEW installation`,
            [{ code: 'installation-exists', message: installationId, path: 'installationId' }],
          ),
        );
      }
      const at = deps.now();
      const installation = installInstallation({
        installationId,
        tenantId: input.tenantId,
        appId: input.manifest.appId,
        manifestVersion: input.manifest.manifestVersion,
        hooks: input.hooks ?? [],
        installedAt: at,
        installedBy: input.installedBy,
      });
      const permissions = grantManifestPermissions(installation, input.manifest, {
        grantedAt: at,
        grantedBy: input.installedBy,
      });
      // Compose the namespace entries; collisions typed-rejected BEFORE
      // anything is stored (the operation is all-or-nothing).
      const commands: AppCommandNamespaceEntry[] = input.manifest.bindings.map(
        (binding) =>
          ({
            kind: 'app-command-namespace',
            installationId,
            appId: input.manifest.appId,
            commandName: binding.commandName,
            binding,
          }) satisfies AppCommandNamespaceEntry,
      );
      const events: AppEventNamespaceEntry[] = input.manifest.subscriptions.map(
        (subscription) =>
          ({
            kind: 'app-event-namespace',
            installationId,
            appId: input.manifest.appId,
            eventName: subscription.eventName,
            subscription,
          }) satisfies AppEventNamespaceEntry,
      );
      for (const entry of commands) {
        if (store.namespace.findCommand(entry.installationId, entry.commandName) !== null) {
          return fail(
            domainError(
              'concurrency-conflict',
              `the app command namespace already registers '${entry.commandName}' for installation ${installationId} — collisions are typed-rejected`,
              [
                {
                  code: 'namespace-command-collision',
                  message: entry.commandName,
                  path: 'commandName',
                },
              ],
            ),
          );
        }
      }
      for (const entry of events) {
        if (store.namespace.findEvent(entry.installationId, entry.eventName) !== null) {
          return fail(
            domainError(
              'concurrency-conflict',
              `the app event namespace already registers '${entry.eventName}' for installation ${installationId} — collisions are typed-rejected`,
              [
                {
                  code: 'namespace-event-collision',
                  message: entry.eventName,
                  path: 'eventName',
                },
              ],
            ),
          );
        }
      }
      const invokedHooks = [lifecycleHookInvocationOf(installation, 'on-install', at)].filter(
        (invocation): invocation is LifecycleHookInvocation => invocation !== null,
      );
      // Audit BEFORE the store mutations: a sink failure leaves the store
      // untouched (the operation is all-or-nothing).
      const appended = await auditTransition(
        installation,
        'installed',
        APP_INSTALLED_EVENT,
        invokedHooks,
        input.correlationId,
        input.causationId ?? null,
      );
      if (!appended.ok) return appended;
      store.installations.put(installation);
      for (const permission of permissions) {
        store.permissions.put(permission);
      }
      for (const entry of commands) {
        const registered = store.namespace.registerCommand(entry);
        if (!registered.ok) return registered;
      }
      for (const entry of events) {
        const registered = store.namespace.registerEvent(entry);
        if (!registered.ok) return registered;
      }
      return ok({ installation, permissions, commands, events, invokedHooks } satisfies AppInstallRecord);
    },

    activate: (input) =>
      transition(
        input,
        APP_ACTIVATED_EVENT,
        'activated',
        (installation) => activateInstallation(installation, { at: deps.now() }),
        false,
      ),

    suspend: (input) =>
      transition(
        input,
        APP_SUSPENDED_EVENT,
        'suspended',
        (installation) =>
          suspendInstallation(installation, {
            by: input.by as Actor,
            at: deps.now(),
          }),
        true,
      ),

    revoke: (input) =>
      transition(
        input,
        APP_REVOKED_EVENT,
        'revoked',
        (installation) =>
          revokeInstallation(installation, {
            by: input.by as Actor,
            at: deps.now(),
          }),
        true,
      ),

    uninstall: (input) =>
      transition(
        input,
        APP_UNINSTALLED_EVENT,
        'uninstalled',
        (installation) =>
          uninstallInstallation(installation, {
            by: input.by as Actor,
            at: deps.now(),
          }),
        true,
      ),

    dispatchCommand: async (request) => {
      const installation = store.installations.find(request.installationId);
      if (installation === null) {
        return notFound('installation', request.installationId);
      }
      const entry = store.namespace.findCommand(
        request.installationId,
        request.command.commandName,
      );
      if (entry === null) {
        return fail(
          domainError(
            'not-found',
            `command '${request.command.commandName}' is not registered in installation ${request.installationId}'s namespace`,
            [
              {
                code: 'unknown-binding',
                message: request.command.commandName,
                path: 'command.commandName',
              },
            ],
          ),
        );
      }
      const permissions = store.permissions.ofInstallation(request.installationId);
      return appCommandDispatch(
        deps,
        installation,
        permissions,
        entry.binding,
        request,
      );
    },

    dispatchEvent: async (request) => {
      const installation = store.installations.find(request.installationId);
      if (installation === null) {
        return notFound('installation', request.installationId);
      }
      const entry = store.namespace.findEvent(
        request.installationId,
        request.event.eventName,
      );
      if (entry === null) {
        return fail(
          domainError(
            'not-found',
            `event '${request.event.eventName}' is not subscribed to by installation ${request.installationId}`,
            [
              {
                code: 'unknown-subscription',
                message: request.event.eventName,
                path: 'event.eventName',
              },
            ],
          ),
        );
      }
      const permissions = store.permissions.ofInstallation(request.installationId);
      return appEventDispatch(deps, installation, permissions, entry.subscription, request.event);
    },

    dispatchEventToSubscribers: async (event) => {
      const entries = store.namespace.subscriptionsByEvent(event.eventName);
      const outcomes: Result<AppEventDeliveryRecord, DomainError>[] = [];
      for (const entry of entries) {
        const installation = store.installations.find(entry.installationId);
        if (installation === null) {
          outcomes.push(notFound('installation', entry.installationId));
          continue;
        }
        const permissions = store.permissions.ofInstallation(entry.installationId);
        outcomes.push(
          await appEventDispatch(deps, installation, permissions, entry.subscription, event),
        );
      }
      return outcomes;
    },

    revokePermission: async (parts) => {
      const installation = store.installations.find(parts.installationId);
      if (installation === null) {
        return notFound('installation', parts.installationId);
      }
      const permission = store.permissions.find(parts.permissionId);
      if (permission === null) {
        return fail(
          domainError(
            'not-found',
            `permission '${parts.permissionId}' is not registered in the app runtime store`,
            [{ code: 'unknown-permission', message: parts.permissionId, path: 'permissionId' }],
          ),
        );
      }
      const revoked = revokeInstallationPermission(installation, permission, {
        revokedBy: parts.revokedBy,
        now: deps.now(),
      });
      if (!revoked.ok) return revoked;
      store.permissions.put(revoked.value);
      return ok(revoked.value);
    },

    upgradePermission: async (parts) => {
      const installation = store.installations.find(parts.installationId);
      if (installation === null) {
        return notFound('installation', parts.installationId);
      }
      const permission = store.permissions.find(parts.permissionId);
      if (permission === null) {
        return fail(
          domainError(
            'not-found',
            `permission '${parts.permissionId}' is not registered in the app runtime store`,
            [{ code: 'unknown-permission', message: parts.permissionId, path: 'permissionId' }],
          ),
        );
      }
      const upgraded = upgradeInstallationPermission(installation, permission, {
        spec: parts.spec,
        now: deps.now(),
      });
      if (!upgraded.ok) return upgraded;
      store.permissions.put(upgraded.value);
      return ok(upgraded.value);
    },
  };
}
