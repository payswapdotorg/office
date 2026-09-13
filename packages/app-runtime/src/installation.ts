// Office app-runtime — THE AppInstallation model + lifecycle (OFF-026).
//
// The tenant-scoped app identity (freeze A7: "installation creates a
// tenant-scoped app installation"): one installation instantiates ONE
// published manifest version of ONE app for ONE tenant. The installation —
// not the app — is the actor identity ('app' kind, actorId = the
// installation id) every dispatched command carries, and the tenant scope
// every dispatched command and delivered event must stay inside (A12).
//
// The lifecycle state machine (typed, one-way revocation):
//
//   installing ──activate──▶ active ──suspend──▶ suspended
//        ▲                      │  ▲                │
//        └──────────────────────┘  └── reactivate ──┘
//                                 │
//              revoke ────────────┼────────────▶ revoked     (TERMINAL)
//              uninstall ─────────┴────────────▶ uninstalled (TERMINAL)
//
// - 'installing' → 'active': the host finished the install flow (grants
//   issued, namespace registered) and activated the installation.
// - 'active' ⇄ 'suspended': suspension is reversible — RE-ACTIVATION
//   restores dispatch (A7: an app can be suspended without deleting
//   canonical state).
// - 'revoked' / 'uninstalled' are TERMINAL: a revoked installation can
//   never re-activate — re-install is a NEW installation; revocation is
//   IDEMPOTENT (revoking a revoked installation returns it unchanged, the
//   original revocation instant and actor preserved — the permission
//   lifecycle convention).
//
// Transitions return typed Results; the pure state machine never touches the
// audit trail (runtime.ts wires the audited operations). Deterministic:
// instants come from the injected clock; ids are caller-injected canonical
// EntityIds.
import { parseActor, parseEntityId, parseFail, parseOk, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, EntityId, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseAppId, parseAppVersion } from '@office/app-sdk';
import type { AppId, AppVersion } from '@office/app-sdk';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';
import { parseAppLifecycleHooks } from './hooks';
import type { AppLifecycleHook, LifecycleHookInvocation, LifecycleHookName } from './hooks';
import { lifecycleHookInvocationOf } from './hooks';

/**
 * The lifecycle states of an app installation (installing → active →
 * suspended → revoked / uninstalled; revoked and uninstalled are terminal).
 */
export type AppLifecycleState = 'installing' | 'active' | 'suspended' | 'revoked' | 'uninstalled';

/** Every lifecycle state, in vocabulary order. */
export const APP_LIFECYCLE_STATES: readonly AppLifecycleState[] = [
  'installing',
  'active',
  'suspended',
  'revoked',
  'uninstalled',
] as const;

/** Grammar description used in parse failures. */
export const APP_LIFECYCLE_GRAMMAR =
  "AppLifecycleState: 'installing' | 'active' | 'suspended' | 'revoked' | 'uninstalled' (revoked and uninstalled are terminal)";

/** Grammar description used in parse failures. */
export const APP_INSTALLATION_GRAMMAR =
  "AppInstallation: { kind: 'app-installation', installationId, tenantId, appId, manifestVersion, state, hooks, installedAt, installedBy, activatedAt, suspendedAt, suspendedBy, revokedAt, revokedBy, uninstalledAt, uninstalledBy }";

const APP_INSTALLATION_KEYS = [
  'kind',
  'installationId',
  'tenantId',
  'appId',
  'manifestVersion',
  'state',
  'hooks',
  'installedAt',
  'installedBy',
  'activatedAt',
  'suspendedAt',
  'suspendedBy',
  'revokedAt',
  'revokedBy',
  'uninstalledAt',
  'uninstalledBy',
] as const;

/** Parse an untrusted value as an AppLifecycleState (total, fail-closed). */
export function parseAppLifecycleState(raw: unknown): ParseResult<AppLifecycleState> {
  if (typeof raw !== 'string' || !(APP_LIFECYCLE_STATES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', APP_LIFECYCLE_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as AppLifecycleState);
}

/** Type guard for valid AppLifecycleState values. */
export function isAppLifecycleState(raw: unknown): raw is AppLifecycleState {
  return parseAppLifecycleState(raw).ok;
}

/**
 * THE tenant-scoped app installation: the app identity commands and events
 * are dispatched under. The pinned manifest version is recorded — an
 * installation never floats to a newer release (the marketplace's update
// flow re-installs); the declared lifecycle hooks snapshot with it.
 */
export interface AppInstallation {
  readonly kind: 'app-installation';
  /** The canonical installation identity (also the 'app' actor id). */
  readonly installationId: EntityId;
  /** The tenant the installation lives in (freeze A12). */
  readonly tenantId: TenantId;
  /** The installed app. */
  readonly appId: AppId;
  /** The pinned manifest version this installation instantiates. */
  readonly manifestVersion: AppVersion;
  /** The lifecycle position. */
  readonly state: AppLifecycleState;
  /** The declared lifecycle hooks (descriptor records — see hooks.ts). */
  readonly hooks: readonly AppLifecycleHook[];
  /** When the installation record was created (injected clock). */
  readonly installedAt: Timestamp;
  /** The actor that created the installation. */
  readonly installedBy: Actor;
  /** When the installation was (last) activated; null until then. */
  readonly activatedAt: Timestamp | null;
  /** When the installation was suspended; non-null exactly when suspended. */
  readonly suspendedAt: Timestamp | null;
  /** The actor that suspended the installation; non-null exactly when suspended. */
  readonly suspendedBy: Actor | null;
  /** When the installation was revoked; non-null exactly when revoked. */
  readonly revokedAt: Timestamp | null;
  /** The actor that revoked the installation; non-null exactly when revoked. */
  readonly revokedBy: Actor | null;
  /** When the installation was uninstalled; non-null exactly when uninstalled. */
  readonly uninstalledAt: Timestamp | null;
  /** The actor that uninstalled the installation; non-null exactly when uninstalled. */
  readonly uninstalledBy: Actor | null;
}

/**
 * Parse an untrusted value as an AppInstallation (total, fail-closed, strict
 * keys). Lifecycle consistency is enforced fail-closed on the state machine's
 * invariants:
 * - 'installing' — nothing has happened yet: every transition field null.
 * - 'active' — activatedAt set, no suspension/revocation/uninstall fields.
 * - 'suspended' — activatedAt + suspendedAt + suspendedBy set; terminal
 *   fields null.
 * - 'revoked' — activatedAt + revokedAt + revokedBy set; suspension and
 *   uninstall fields null (revocation clears the suspension snapshot; the
 *   history lives on the audit trail).
 * - 'uninstalled' — activatedAt + uninstalledAt + uninstalledBy set;
 *   revocation and suspension fields null.
 */
export function parseAppInstallation(raw: unknown): ParseResult<AppInstallation> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APP_INSTALLATION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APP_INSTALLATION_KEYS, '', APP_INSTALLATION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-installation']);
  if (!kind.ok) return kind;
  const installationId = requireFieldWith(raw, 'installationId', '', parseEntityId);
  if (!installationId.ok) return installationId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const manifestVersion = requireFieldWith(raw, 'manifestVersion', '', parseAppVersion);
  if (!manifestVersion.ok) return manifestVersion;
  const state = requireFieldWith(raw, 'state', '', parseAppLifecycleState);
  if (!state.ok) return state;
  const hooks = requireFieldWith(raw, 'hooks', '', (value) =>
    parseAppLifecycleHooks(value),
  );
  if (!hooks.ok) return hooks;
  const installedAt = requireFieldWith(raw, 'installedAt', '', parseTimestamp);
  if (!installedAt.ok) return installedAt;
  const installedBy = requireFieldWith(raw, 'installedBy', '', parseActor);
  if (!installedBy.ok) return installedBy;
  const activatedAt = requireNullableFieldWith(raw, 'activatedAt', '', parseTimestamp);
  if (!activatedAt.ok) return activatedAt;
  const suspendedAt = requireNullableFieldWith(raw, 'suspendedAt', '', parseTimestamp);
  if (!suspendedAt.ok) return suspendedAt;
  const suspendedBy = requireNullableFieldWith(raw, 'suspendedBy', '', parseActor);
  if (!suspendedBy.ok) return suspendedBy;
  const revokedAt = requireNullableFieldWith(raw, 'revokedAt', '', parseTimestamp);
  if (!revokedAt.ok) return revokedAt;
  const revokedBy = requireNullableFieldWith(raw, 'revokedBy', '', parseActor);
  if (!revokedBy.ok) return revokedBy;
  const uninstalledAt = requireNullableFieldWith(raw, 'uninstalledAt', '', parseTimestamp);
  if (!uninstalledAt.ok) return uninstalledAt;
  const uninstalledBy = requireNullableFieldWith(raw, 'uninstalledBy', '', parseActor);
  if (!uninstalledBy.ok) return uninstalledBy;

  // --- lifecycle consistency (fail-closed) ---
  const lifecycle = state.value;
  if (lifecycle === 'installing') {
    if (
      activatedAt.value !== null ||
      suspendedAt.value !== null ||
      suspendedBy.value !== null ||
      revokedAt.value !== null ||
      revokedBy.value !== null ||
      uninstalledAt.value !== null ||
      uninstalledBy.value !== null
    ) {
      return parseFail(
        'invalid-value',
        'activatedAt',
        "null in every field while state === 'installing' (nothing has transitioned yet)",
        describeValue(activatedAt.value),
      );
    }
  } else if (activatedAt.value === null) {
    return parseFail(
      'invalid-value',
      'activatedAt',
      "a timestamp once state !== 'installing' (every non-installing state was activated)",
      'null',
    );
  }
  if (lifecycle === 'active' || lifecycle === 'revoked' || lifecycle === 'uninstalled') {
    if (suspendedAt.value !== null || suspendedBy.value !== null) {
      return parseFail(
        'invalid-value',
        'suspendedAt',
        "null unless state === 'suspended' (revocation and uninstall clear the suspension snapshot)",
        describeValue(suspendedAt.value),
      );
    }
  }
  if (lifecycle === 'suspended' && (suspendedAt.value === null || suspendedBy.value === null)) {
    return parseFail(
      'invalid-value',
      'suspendedAt',
      "both suspendedAt and suspendedBy when state === 'suspended'",
      'null',
    );
  }
  if (lifecycle !== 'revoked' && (revokedAt.value !== null || revokedBy.value !== null)) {
    return parseFail(
      'invalid-value',
      'revokedAt',
      "both null unless state === 'revoked'",
      describeValue(revokedAt.value),
    );
  }
  if (lifecycle === 'revoked' && (revokedAt.value === null || revokedBy.value === null)) {
    return parseFail(
      'invalid-value',
      'revokedAt',
      "both revokedAt and revokedBy when state === 'revoked'",
      'null',
    );
  }
  if (
    lifecycle !== 'uninstalled' &&
    (uninstalledAt.value !== null || uninstalledBy.value !== null)
  ) {
    return parseFail(
      'invalid-value',
      'uninstalledAt',
      "both null unless state === 'uninstalled'",
      describeValue(uninstalledAt.value),
    );
  }
  if (
    lifecycle === 'uninstalled' &&
    (uninstalledAt.value === null || uninstalledBy.value === null)
  ) {
    return parseFail(
      'invalid-value',
      'uninstalledAt',
      "both uninstalledAt and uninstalledBy when state === 'uninstalled'",
      'null',
    );
  }

  return parseOk(
    {
      kind: 'app-installation',
      installationId: installationId.value,
      tenantId: tenantId.value,
      appId: appId.value,
      manifestVersion: manifestVersion.value,
      state: lifecycle,
      hooks: hooks.value,
      installedAt: installedAt.value,
      installedBy: installedBy.value,
      activatedAt: activatedAt.value,
      suspendedAt: suspendedAt.value,
      suspendedBy: suspendedBy.value,
      revokedAt: revokedAt.value,
      revokedBy: revokedBy.value,
      uninstalledAt: uninstalledAt.value,
      uninstalledBy: uninstalledBy.value,
    } satisfies AppInstallation,
  );
}

/** Type guard for structurally valid AppInstallation values. */
export function isAppInstallation(raw: unknown): raw is AppInstallation {
  return parseAppInstallation(raw).ok;
}

/** The installation's own actor identity: every dispatched command's actor. */
export const installationActor = (installation: {
  readonly installationId: EntityId;
}): Actor => ({ kind: 'app', actorId: installation.installationId });

/** Is the installation dispatchable (commands AND events)? Active only. */
export function isInstallationDispatchable(installation: {
  readonly state: AppLifecycleState;
}): boolean {
  return installation.state === 'active';
}

const installationContext = (installation: {
  readonly tenantId: TenantId;
  readonly installationId: EntityId;
}): DomainErrorContext => ({
  scope: { kind: 'tenant', tenantId: installation.tenantId },
});

const lifecycleFailure = (
  installation: AppInstallation,
  message: string,
  detailCode: string,
): Result<never, DomainError> =>
  fail(
    domainError(
      'invariant-violation',
      `installation ${installation.installationId} of app '${installation.appId}' cannot transition: ${message}`,
      [
        {
          code: detailCode,
          message: `state '${installation.state}'`,
          path: 'state',
        },
      ],
      installationContext(installation),
    ),
  );

/** The typed result of one lifecycle transition. */
export interface LifecycleTransition {
  /** The installation after the transition (immutable record, new snapshot). */
  readonly installation: AppInstallation;
  /** The hooks this transition invokes (null-less: absent hooks emit nothing). */
  readonly invokedHooks: readonly LifecycleHookInvocation[];
}

const withHooks = (
  installation: AppInstallation,
  hook: LifecycleHookName,
  at: Timestamp,
): LifecycleTransition => ({
  installation,
  invokedHooks: compact([lifecycleHookInvocationOf(installation, hook, at)]),
});

const compact = (values: readonly (LifecycleHookInvocation | null)[]): readonly LifecycleHookInvocation[] =>
  values.filter((value): value is LifecycleHookInvocation => value !== null);

/**
 * Compose a fresh installation record (trusted path; loud TypeError): state
 * 'installing', no transition fields. The caller (the marketplace install
 * flow / the runtime engine) supplies the canonical installation id, the
 * tenant, the pinned manifest identity, the declared hooks, and the injected
 * creation instant and actor.
 */
export function installInstallation(parts: {
  readonly installationId: EntityId;
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly manifestVersion: AppVersion;
  readonly hooks?: readonly AppLifecycleHook[];
  readonly installedAt: Timestamp;
  readonly installedBy: Actor;
}): AppInstallation {
  const parsed = parseAppInstallation({
    kind: 'app-installation',
    installationId: parts.installationId,
    tenantId: parts.tenantId,
    appId: parts.appId,
    manifestVersion: parts.manifestVersion,
    state: 'installing',
    hooks: parts.hooks ?? [],
    installedAt: parts.installedAt,
    installedBy: parts.installedBy,
    activatedAt: null,
    suspendedAt: null,
    suspendedBy: null,
    revokedAt: null,
    revokedBy: null,
    uninstalledAt: null,
    uninstalledBy: null,
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid app installation: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Activate the installation (installing → active, or suspended → active on
 * re-activation). Re-activation RESTORES dispatch. Activating an active
 * installation is a typed no-op error (the state machine never silently
 * re-stamps the activation instant); activating a revoked or uninstalled
 * installation is the one-way-revocation rejection (re-install is a NEW
 * installation).
 */
export function activateInstallation(
  installation: AppInstallation,
  parts: { readonly at: Timestamp },
): Result<LifecycleTransition, DomainError> {
  if (installation.state === 'active') {
    return lifecycleFailure(installation, 'it is already active', 'already-active');
  }
  if (installation.state === 'revoked') {
    return lifecycleFailure(
      installation,
      'revocation is one-way — a revoked installation can never re-activate (re-install as a new installation)',
      'revocation-terminal',
    );
  }
  if (installation.state === 'uninstalled') {
    return lifecycleFailure(
      installation,
      'uninstallation is terminal — re-install as a new installation',
      'uninstallation-terminal',
    );
  }
  const activated: AppInstallation = {
    ...installation,
    state: 'active',
    activatedAt: parts.at,
    suspendedAt: null,
    suspendedBy: null,
  };
  return ok(withHooks(activated, 'on-activate', parts.at));
}

/**
 * Suspend the installation (active → suspended): the STOP sign of the
 * runtime — a suspended installation receives NO commands and NO events.
 * Suspending a suspended installation is a typed no-op error; suspending a
 * non-live installation (installing/revoked/uninstalled) is typed-rejected.
 */
export function suspendInstallation(
  installation: AppInstallation,
  parts: { readonly by: Actor; readonly at: Timestamp },
): Result<LifecycleTransition, DomainError> {
  if (installation.state === 'suspended') {
    return lifecycleFailure(installation, 'it is already suspended', 'already-suspended');
  }
  if (installation.state !== 'active') {
    return lifecycleFailure(
      installation,
      'only an active installation can be suspended',
      'not-suspendable',
    );
  }
  const suspended: AppInstallation = {
    ...installation,
    state: 'suspended',
    suspendedAt: parts.at,
    suspendedBy: parts.by,
  };
  return ok(withHooks(suspended, 'on-suspend', parts.at));
}

/**
 * Revoke the installation (active | suspended → revoked, TERMINAL): the app
 * stops receiving commands and events FOREVER — re-activation is
// typed-rejected and re-install is a NEW installation (the marketplace's
 * concern). Revoking an already-revoked installation is IDEMPOTENT: the
 * record returns unchanged, the original revocation instant and actor
 * preserved. Revoking an 'installing' or 'uninstalled' installation is
 * typed-rejected (installing has nothing to revoke — activate or uninstall
 * first; uninstalled is already terminal).
 */
export function revokeInstallation(
  installation: AppInstallation,
  parts: { readonly by: Actor; readonly at: Timestamp },
): Result<LifecycleTransition, DomainError> {
  if (installation.state === 'revoked') {
    // Terminal idempotent revocation — the permission lifecycle convention.
    return ok({ installation, invokedHooks: [] });
  }
  if (installation.state === 'uninstalled') {
    return lifecycleFailure(
      installation,
      'uninstallation is terminal — an uninstalled installation cannot be revoked',
      'uninstallation-terminal',
    );
  }
  if (installation.state === 'installing') {
    return lifecycleFailure(
      installation,
      'an installation that was never activated cannot be revoked (activate or uninstall it)',
      'not-revocable',
    );
  }
  const revoked: AppInstallation = {
    ...installation,
    state: 'revoked',
    suspendedAt: null,
    suspendedBy: null,
    revokedAt: parts.at,
    revokedBy: parts.by,
  };
  return ok(withHooks(revoked, 'on-revoke', parts.at));
}

/**
 * Uninstall the installation (active | suspended → uninstalled, TERMINAL):
 * the installation record leaves the live world WITHOUT deleting any
 * canonical project state (freeze A7) — the marketplace's uninstall flow.
 * Uninstalling an already-uninstalled installation is IDEMPOTENT (the record
 * returns unchanged). Uninstalling an 'installing' or 'revoked' installation
 * is typed-rejected (activate first, or it is already terminal).
 */
export function uninstallInstallation(
  installation: AppInstallation,
  parts: { readonly by: Actor; readonly at: Timestamp },
): Result<LifecycleTransition, DomainError> {
  if (installation.state === 'uninstalled') {
    // Terminal idempotent uninstall — same convention as revocation.
    return ok({ installation, invokedHooks: [] });
  }
  if (installation.state === 'revoked') {
    return lifecycleFailure(
      installation,
      'revocation is terminal — a revoked installation cannot be uninstalled',
      'revocation-terminal',
    );
  }
  if (installation.state === 'installing') {
    return lifecycleFailure(
      installation,
      'an installation that was never activated cannot be uninstalled (activate or keep it inert)',
      'not-uninstallable',
    );
  }
  const uninstalled: AppInstallation = {
    ...installation,
    state: 'uninstalled',
    suspendedAt: null,
    suspendedBy: null,
    uninstalledAt: parts.at,
    uninstalledBy: parts.by,
  };
  return ok({ installation: uninstalled, invokedHooks: [] });
}
