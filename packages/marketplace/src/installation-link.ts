// Office marketplace — installation metadata linkage (OFF-027).
//
// The marketplace's metadata link between an app-runtime installation and
// the release/entitlement it resulted from: WHICH canonical installation id
// (the app-runtime's AppInstallation identity — TYPE-ONLY consumption, the
// marketplace never constructs or executes the runtime) was installed from
// WHICH release under WHICH entitlement. The link is METADATA ONLY (freeze
// A7/A11): it records provenance and the currently-pinned release version
// (updates/rollback move this pin), it never dispatches, grants, or executes
// anything. Uninstall SEVERS the linkage (terminal, idempotent — the
// uninstall record severs the entitlement→installation linkage auditable).
import { parseActor, parseEntityId, parseFail, parseOk, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, EntityId, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseAppId, parseAppVersion } from '@office/app-sdk';
import type { AppId, AppVersion } from '@office/app-sdk';
import type { AppInstallation, AppLifecycleState } from '@office/app-runtime';
import { installationLinkIdOf, parseEntitlementId, parseInstallationLinkId, parseReleaseId } from './identity';
import type { EntitlementId, InstallationLinkId, ReleaseId } from './identity';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';

/**
 * The lifecycle states of an installation link: 'linked' until uninstall
 * severs it; 'unlinked' is terminal (a severed installation never re-links —
 * a new installation is a new link).
 */
export type InstallationLinkState = 'linked' | 'unlinked';

/** Both link states, in vocabulary order. */
export const INSTALLATION_LINK_STATES: readonly InstallationLinkState[] = [
  'linked',
  'unlinked',
] as const;

/** Grammar description used in parse failures. */
export const INSTALLATION_LINK_STATE_GRAMMAR = "'linked' | 'unlinked' (unlinked is terminal)";

/** Grammar description used in parse failures. */
export const INSTALLATION_LINK_GRAMMAR =
  "InstallationLink: { kind: 'installation-link', linkId, installationId, tenantId, appId, releaseId, currentVersion, entitlementId, runtimeLifecycle, state, linkedAt, linkedBy, updatedAt, updatedBy, unlinkedAt, unlinkedBy }";

const INSTALLATION_LINK_KEYS = [
  'kind',
  'linkId',
  'installationId',
  'tenantId',
  'appId',
  'releaseId',
  'currentVersion',
  'entitlementId',
  'runtimeLifecycle',
  'state',
  'linkedAt',
  'linkedBy',
  'updatedAt',
  'updatedBy',
  'unlinkedAt',
  'unlinkedBy',
] as const;

/** The app-runtime lifecycle states a link may snapshot (NAMES only). */
const RUNTIME_LIFECYCLE_STATES: readonly AppLifecycleState[] = [
  'installing',
  'active',
  'suspended',
  'revoked',
  'uninstalled',
] as const;

/** Parse an untrusted value as an InstallationLinkState (total, fail-closed). */
export function parseInstallationLinkState(raw: unknown): ParseResult<InstallationLinkState> {
  if (
    typeof raw !== 'string' ||
    !(INSTALLATION_LINK_STATES as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', INSTALLATION_LINK_STATE_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as InstallationLinkState);
}

/** Type guard for structurally valid InstallationLinkState values. */
export function isInstallationLinkState(raw: unknown): raw is InstallationLinkState {
  return parseInstallationLinkState(raw).ok;
}

/** Parse an untrusted value as a runtime lifecycle snapshot (fail-closed). */
export function parseRuntimeLifecycleSnapshot(
  raw: unknown,
): ParseResult<AppLifecycleState> {
  if (
    typeof raw !== 'string' ||
    !(RUNTIME_LIFECYCLE_STATES as readonly string[]).includes(raw)
  ) {
    return parseFail(
      'invalid-value',
      'runtimeLifecycle',
      "the app-runtime installation lifecycle state at link time ('installing' | 'active' | 'suspended' | 'revoked' | 'uninstalled')",
      describeValue(raw),
    );
  }
  return parseOk(raw as AppLifecycleState);
}

/**
 * The installation metadata linkage: the marketplace's record that the
 * canonical installation `installationId` (the app-runtime AppInstallation
 * identity) was installed from release `releaseId` under entitlement
 * `entitlementId`, now pinned at `currentVersion` (update/rollback move the
 * pin — the release records themselves never change). The derived link id
 * keys on (tenant, installation id): one marketplace link per installation.
 */
export interface InstallationLink {
  readonly kind: 'installation-link';
  /** The derived, deterministic link identity. */
  readonly linkId: InstallationLinkId;
  /** The canonical app-runtime installation identity (metadata only). */
  readonly installationId: EntityId;
  /** The tenant the installation (and link) live in (A12). */
  readonly tenantId: TenantId;
  /** The installed app. */
  readonly appId: AppId;
  /** The release the installation currently runs. */
  readonly releaseId: ReleaseId;
  /** The pinned manifest version the installation currently runs. */
  readonly currentVersion: AppVersion;
  /** The entitlement the installation resulted from. */
  readonly entitlementId: EntitlementId;
  /** The runtime lifecycle state snapshotted at link time (metadata). */
  readonly runtimeLifecycle: AppLifecycleState;
  /** The link lifecycle (uninstall severs; terminal). */
  readonly state: InstallationLinkState;
  /** When the link was created (injected clock). */
  readonly linkedAt: Timestamp;
  /** The actor that created the link (the host install flow). */
  readonly linkedBy: Actor;
  /** When the pinned release last moved (update/rollback); null until then. */
  readonly updatedAt: Timestamp | null;
  /** The actor that last moved the pin; null until then. */
  readonly updatedBy: Actor | null;
  /** When the link was severed; non-null exactly when unlinked. */
  readonly unlinkedAt: Timestamp | null;
  /** The actor that severed the link; non-null exactly when unlinked. */
  readonly unlinkedBy: Actor | null;
}

/** Parse an untrusted value as an InstallationLink (total, fail-closed, strict keys). */
export function parseInstallationLink(raw: unknown): ParseResult<InstallationLink> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', INSTALLATION_LINK_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, INSTALLATION_LINK_KEYS, '', INSTALLATION_LINK_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['installation-link']);
  if (!kind.ok) return kind;
  const linkId = requireFieldWith(raw, 'linkId', '', parseInstallationLinkId);
  if (!linkId.ok) return linkId;
  const installationId = requireFieldWith(raw, 'installationId', '', parseEntityId);
  if (!installationId.ok) return installationId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const releaseId = requireFieldWith(raw, 'releaseId', '', parseReleaseId);
  if (!releaseId.ok) return releaseId;
  const currentVersion = requireFieldWith(raw, 'currentVersion', '', parseAppVersion);
  if (!currentVersion.ok) return currentVersion;
  const entitlementId = requireFieldWith(raw, 'entitlementId', '', parseEntitlementId);
  if (!entitlementId.ok) return entitlementId;
  const runtimeLifecycle = requireFieldWith(raw, 'runtimeLifecycle', '', parseRuntimeLifecycleSnapshot);
  if (!runtimeLifecycle.ok) return runtimeLifecycle;
  const state = requireFieldWith(raw, 'state', '', parseInstallationLinkState);
  if (!state.ok) return state;
  const linkedAt = requireFieldWith(raw, 'linkedAt', '', parseTimestamp);
  if (!linkedAt.ok) return linkedAt;
  const linkedBy = requireFieldWith(raw, 'linkedBy', '', parseActor);
  if (!linkedBy.ok) return linkedBy;
  const updatedAt = requireNullableFieldWith(raw, 'updatedAt', '', parseTimestamp);
  if (!updatedAt.ok) return updatedAt;
  const updatedBy = requireNullableFieldWith(raw, 'updatedBy', '', parseActor);
  if (!updatedBy.ok) return updatedBy;
  const unlinkedAt = requireNullableFieldWith(raw, 'unlinkedAt', '', parseTimestamp);
  if (!unlinkedAt.ok) return unlinkedAt;
  const unlinkedBy = requireNullableFieldWith(raw, 'unlinkedBy', '', parseActor);
  if (!unlinkedBy.ok) return unlinkedBy;
  if (state.value === 'unlinked' && (unlinkedAt.value === null || unlinkedBy.value === null)) {
    return parseFail(
      'invalid-value',
      'unlinkedAt',
      'severance instant and actor non-null exactly when state is unlinked',
      'unlinked link without severance provenance',
    );
  }
  if (state.value === 'linked' && (unlinkedAt.value !== null || unlinkedBy.value !== null)) {
    return parseFail(
      'invalid-value',
      'unlinkedAt',
      'severance instant and actor null exactly when state is linked',
      'linked link carrying severance provenance',
    );
  }
  return parseOk({
    kind: 'installation-link',
    linkId: linkId.value,
    installationId: installationId.value,
    tenantId: tenantId.value,
    appId: appId.value,
    releaseId: releaseId.value,
    currentVersion: currentVersion.value,
    entitlementId: entitlementId.value,
    runtimeLifecycle: runtimeLifecycle.value,
    state: state.value,
    linkedAt: linkedAt.value,
    linkedBy: linkedBy.value,
    updatedAt: updatedAt.value,
    updatedBy: updatedBy.value,
    unlinkedAt: unlinkedAt.value,
    unlinkedBy: unlinkedBy.value,
  } satisfies InstallationLink);
}

/** Type guard for structurally valid InstallationLink values. */
export function isInstallationLink(raw: unknown): raw is InstallationLink {
  return parseInstallationLink(raw).ok;
}

/** The runtime lifecycle states that cannot be newly linked (terminal). */
export const UNLINKABLE_RUNTIME_STATES: readonly AppLifecycleState[] = [
  'revoked',
  'uninstalled',
] as const;

/**
 * Compose a fresh installation link (trusted path; loud TypeError): state
 * 'linked', no update/severance fields. The link id is DERIVED from
 * (tenant, installation id) — deterministic identity, and the app-runtime
 * installation record is cross-checked for consistency with the release and
 * entitlement the host claims (same tenant, same app, same pinned manifest
 * version — the runtime's own installation parser guarantees the record's
 * internal consistency).
 */
export function linkInstallation(parts: {
  readonly installation: AppInstallation;
  readonly releaseId: ReleaseId;
  readonly releaseVersion: AppVersion;
  readonly entitlementId: EntitlementId;
  readonly linkedAt: Timestamp;
  readonly linkedBy: Actor;
}): InstallationLink {
  const link: InstallationLink = {
    kind: 'installation-link',
    linkId: installationLinkIdOf({
      tenantId: parts.installation.tenantId,
      installationId: parts.installation.installationId,
    }),
    installationId: parts.installation.installationId,
    tenantId: parts.installation.tenantId,
    appId: parts.installation.appId,
    releaseId: parts.releaseId,
    currentVersion: parts.releaseVersion,
    entitlementId: parts.entitlementId,
    runtimeLifecycle: parts.installation.state,
    state: 'linked',
    linkedAt: parts.linkedAt,
    linkedBy: parts.linkedBy,
    updatedAt: null,
    updatedBy: null,
    unlinkedAt: null,
    unlinkedBy: null,
  };
  const parsed = parseInstallationLink(link);
  if (!parsed.ok) {
    throw new TypeError(`invalid installation link: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Move the link's pinned release (update apply / rollback): the pin moves
 * to the given release/version with fresh provenance. The RELEASE records
 * never change — only the link's pin does (rollback is an explicit typed
 * command producing an auditable transition, never a mutation of the prior
 * release).
 */
export function moveInstallationLink(
  link: InstallationLink,
  parts: {
    readonly toReleaseId: ReleaseId;
    readonly toVersion: AppVersion;
    readonly at: Timestamp;
    readonly by: Actor;
  },
): InstallationLink {
  if (link.state !== 'linked') {
    throw new TypeError('cannot move the pin of a severed installation link');
  }
  const moved: InstallationLink = {
    ...link,
    releaseId: parts.toReleaseId,
    currentVersion: parts.toVersion,
    updatedAt: parts.at,
    updatedBy: parts.by,
  };
  const parsed = parseInstallationLink(moved);
  if (!parsed.ok) {
    throw new TypeError(`invalid moved installation link: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Sever the link (uninstall — TERMINAL and IDEMPOTENT, the A9 convention):
 * the entitlement→installation linkage is severed and the record keeps the
 * original severance instant and actor on re-severance. The audit trail
 * (engine level) records only the actual transition.
 */
export function unlinkInstallation(
  link: InstallationLink,
  parts: { readonly at: Timestamp; readonly by: Actor },
): InstallationLink {
  if (link.state === 'unlinked') return link;
  const severed: InstallationLink = {
    ...link,
    state: 'unlinked',
    unlinkedAt: parts.at,
    unlinkedBy: parts.by,
  };
  const parsed = parseInstallationLink(severed);
  if (!parsed.ok) {
    throw new TypeError(`invalid severed installation link: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}
