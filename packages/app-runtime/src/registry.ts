// Office app-runtime — the in-memory installation registry (OFF-026).
//
// The deterministic in-memory reference of the app runtime's stores: the
// installation records (lifecycle snapshots), the per-installation
// permission grants (the A9 records the dispatch engines check), and the
// per-installation command/event namespace (bindings and subscriptions
// registered under their derived, collision-rejecting identities). The
// marketplace (OFF-027) and the real runtime replace these with
// persistence-backed stores satisfying the same ports; tests use them
// directly.
//
// Everything here is plain in-memory bookkeeping over ALREADY-VALIDATED
// typed records (parse before storing): no canonical entities are stored
// (A11 — the runtime composes the canonical graph only; it never forks
// app-private state), no SQL, no I/O. Deterministic: insertion order is
// preserved, ids are derived, no clock, no randomness.
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { CommandName, EntityId, EventName, TenantId } from '@office/contracts';
import type { AppId, Permission, PermissionId } from '@office/app-sdk';
import type { AppInstallation } from './installation';
import type { AppCommandNamespaceEntry, AppEventNamespaceEntry } from './namespace';
import { appCommandNamespaceIdOf, appEventNamespaceIdOf } from './namespace';

// ----- installations ----------------------------------------------------------------------

/** The store of app installation records (lifecycle snapshots). */
export interface AppInstallationStore {
  /** Store one installation record (replaces the same installation id). */
  put(installation: AppInstallation): void;
  /** The installation record of an id, or null. */
  find(installationId: EntityId): AppInstallation | null;
  /** The installations of one (tenant, app), in insertion order. */
  findByApp(tenantId: TenantId, appId: AppId): readonly AppInstallation[];
  /** Every installation, in insertion order. */
  installations(): readonly AppInstallation[];
}

// ----- permissions ------------------------------------------------------------------------

/** The store of per-installation permission grants (A9 records). */
export interface AppPermissionStore {
  /** Store one permission record (replaces the same permission id). */
  put(permission: Permission): void;
  /** Every permission of one installation, in grant order. */
  ofInstallation(installationId: EntityId): readonly Permission[];
  /** The permission record of an id, or null. */
  find(permissionId: PermissionId): Permission | null;
}

// ----- namespace --------------------------------------------------------------------------

/** The store of the per-installation command/event namespace. */
export interface AppNamespaceStore {
  /**
   * Register one command namespace entry. Collisions are TYPED-REJECTED:
   * the (installation, command) key already maps to an entry — never a
   * silent override of one app binding by another.
   */
  registerCommand(entry: AppCommandNamespaceEntry): Result<AppCommandNamespaceEntry, DomainError>;
  /**
   * Register one event namespace entry. Collisions are TYPED-REJECTED:
   * the (installation, event) key already maps to an entry.
   */
  registerEvent(entry: AppEventNamespaceEntry): Result<AppEventNamespaceEntry, DomainError>;
  /** The command entry of (installation, command), or null. */
  findCommand(installationId: EntityId, commandName: CommandName): AppCommandNamespaceEntry | null;
  /** The event entry of (installation, event), or null. */
  findEvent(installationId: EntityId, eventName: EventName): AppEventNamespaceEntry | null;
  /** Every command entry of one installation, in registration order. */
  commandsOf(installationId: EntityId): readonly AppCommandNamespaceEntry[];
  /** Every event entry of one installation, in registration order. */
  eventsOf(installationId: EntityId): readonly AppEventNamespaceEntry[];
  /**
   * Every event entry subscribed to an event name (the fan-out lookup),
   * across installations, in registration order.
   */
  subscriptionsByEvent(eventName: EventName): readonly AppEventNamespaceEntry[];
}

// ----- the combined in-memory store -------------------------------------------------------

/** The combined in-memory store of the app runtime. */
export interface InMemoryAppRuntimeStore {
  readonly installations: AppInstallationStore;
  readonly permissions: AppPermissionStore;
  readonly namespace: AppNamespaceStore;
}

/**
 * Create the deterministic in-memory app runtime store (installations +
 * permission grants + namespace). Pure bookkeeping: typed records in,
 * typed records out, insertion order preserved.
 */
export function createInMemoryAppRuntimeStore(): InMemoryAppRuntimeStore {
  // --- installations ---
  const installationsById = new Map<string, AppInstallation>();
  const installationsOrdered: AppInstallation[] = [];
  const installationStore: AppInstallationStore = {
    put: (installation) => {
      const key = installation.installationId as string;
      if (!installationsById.has(key)) {
        installationsOrdered.push(installation);
      } else {
        const index = installationsOrdered.findIndex(
          (candidate) => (candidate.installationId as string) === key,
        );
        if (index >= 0) installationsOrdered[index] = installation;
      }
      installationsById.set(key, installation);
    },
    find: (installationId) => installationsById.get(installationId as string) ?? null,
    findByApp: (tenantId, appId) =>
      installationsOrdered.filter(
        (installation) =>
          (installation.tenantId as string) === (tenantId as string) &&
          (installation.appId as string) === (appId as string),
      ),
    installations: () => [...installationsOrdered],
  };

  // --- permissions ---
  const permissionsById = new Map<string, Permission>();
  const permissionsOrdered: Permission[] = [];
  const permissionStore: AppPermissionStore = {
    put: (permission) => {
      const key = permission.permissionId as string;
      if (!permissionsById.has(key)) {
        permissionsOrdered.push(permission);
      } else {
        const index = permissionsOrdered.findIndex(
          (candidate) => (candidate.permissionId as string) === key,
        );
        if (index >= 0) permissionsOrdered[index] = permission;
      }
      permissionsById.set(key, permission);
    },
    ofInstallation: (installationId) =>
      permissionsOrdered.filter(
        (permission) => (permission.installationId as string) === (installationId as string),
      ),
    find: (permissionId) => permissionsById.get(permissionId as string) ?? null,
  };

  // --- namespace ---
  const commandsByKey = new Map<string, AppCommandNamespaceEntry>();
  const commandsOrdered: AppCommandNamespaceEntry[] = [];
  const eventsByKey = new Map<string, AppEventNamespaceEntry>();
  const eventsOrdered: AppEventNamespaceEntry[] = [];
  const commandKey = (installationId: EntityId, commandName: CommandName): string =>
    appCommandNamespaceIdOf({ installationId, commandName }) as string;
  const eventKey = (installationId: EntityId, eventName: EventName): string =>
    appEventNamespaceIdOf({ installationId, eventName }) as string;
  const collision = (
    kind: 'command' | 'event',
    name: string,
  ): Result<never, DomainError> =>
    fail(
      domainError(
        'concurrency-conflict',
        `the app ${kind} namespace already registers '${name}' for this installation — collisions are typed-rejected, never silently overridden`,
        [
          {
            code: kind === 'command' ? 'namespace-command-collision' : 'namespace-event-collision',
            message: name,
            path: kind === 'command' ? 'commandName' : 'eventName',
          },
        ],
      ),
    );
  const namespaceStore: AppNamespaceStore = {
    registerCommand: (entry) => {
      const key = commandKey(entry.installationId, entry.commandName);
      if (commandsByKey.has(key)) return collision('command', entry.commandName);
      commandsByKey.set(key, entry);
      commandsOrdered.push(entry);
      return ok(entry);
    },
    registerEvent: (entry) => {
      const key = eventKey(entry.installationId, entry.eventName);
      if (eventsByKey.has(key)) return collision('event', entry.eventName);
      eventsByKey.set(key, entry);
      eventsOrdered.push(entry);
      return ok(entry);
    },
    findCommand: (installationId, commandName) =>
      commandsByKey.get(commandKey(installationId, commandName)) ?? null,
    findEvent: (installationId, eventName) =>
      eventsByKey.get(eventKey(installationId, eventName)) ?? null,
    commandsOf: (installationId) =>
      commandsOrdered.filter(
        (entry) => (entry.installationId as string) === (installationId as string),
      ),
    eventsOf: (installationId) =>
      eventsOrdered.filter(
        (entry) => (entry.installationId as string) === (installationId as string),
      ),
    subscriptionsByEvent: (eventName) =>
      eventsOrdered.filter((entry) => (entry.eventName as string) === (eventName as string)),
  };

  return {
    installations: installationStore,
    permissions: permissionStore,
    namespace: namespaceStore,
  };
}
