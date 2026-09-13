// Office app-runtime — per-installation A9 permission enforcement (OFF-026).
//
// The RUNTIME side of the marketplace permission discipline: an installation
// holds Permission records (the @office/app-sdk typed record — explicit,
// versioned, revocable), granted FROM the manifest's declared
// PermissionSpecs at install time. This module owns:
//
// - issuing the initial grants for a validated manifest
//   (grantManifestPermissions — one deterministic Permission per declared
//   spec, ids derived through the SDK's permissionIdOf);
// - the dispatch-time A9 gate (checkInstallationCapabilities): every
//   required capability of the dispatched action must be covered by a LIVE
//   grant THAT BELONGS TO THE INSTALLATION — a foreign permission record
//   (another tenant, installation, or app) is a typed wiring defect, never
//   a usable grant: an app can never borrow another installation's grant;
// - the event-side capability derivation (requiredCapabilityOfEvent): an
//   event subscription delivers only when the installation holds the read
//   capability of the event's area — 'work.progressRecorded' requires
//   'work.read'. Events from areas outside the closed capability vocabulary
//   (e.g. the gateway's own 'actions.*' audit events) are NEVER delivered
//   to apps (fail-closed);
// - typed revoke/upgrade wrappers with the same ownership discipline.
//
// The gate runs BEFORE the gateway on every command dispatch, and is
// re-checked on every event dispatch — a revoked permission denies, never
// partially executes (the SDK's terminal-revocation semantics).
import type { Actor, EntityId, EventName, TenantId, Timestamp } from '@office/contracts';
import { parseCapability } from '@office/authz';
import type { Capability } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import {
  grantPermission,
  isPermissionActive,
  parsePermission,
  revokePermission,
  upgradePermission,
} from '@office/app-sdk';
import type { AppManifest, Permission, PermissionSpec } from '@office/app-sdk';
import type { AppInstallation } from './installation';

const installationContext = (installation: {
  readonly tenantId: TenantId;
  readonly installationId: EntityId;
}): DomainErrorContext => ({
  scope: { kind: 'tenant', tenantId: installation.tenantId },
});

/** Failure builder carrying the installation's tenant context. */
const permissionFailure = (
  installation: AppInstallation,
  code: Parameters<typeof domainError>[0],
  message: string,
  detailCode: string,
  path: string,
): Result<never, DomainError> =>
  fail(
    domainError(
      code,
      message,
      [{ code: detailCode, message: installation.installationId, path }],
      installationContext(installation),
    ),
  );

/**
 * Issue the installation's initial grants from a validated manifest's
 * declared permissions (trusted path; loud TypeError through the SDK
 * builder): exactly one Permission per declared PermissionSpec, granted by
 * the issuing actor at the injected instant, ids derived deterministically
 * (the SDK's permissionIdOf) — the same installation/spec key always maps
 * to the same permission identity.
 */
export function grantManifestPermissions(
  installation: AppInstallation,
  manifest: Pick<AppManifest, 'appId' | 'permissions'>,
  parts: { readonly grantedAt: Timestamp; readonly grantedBy: Actor },
): readonly Permission[] {
  if (manifest.appId !== installation.appId) {
    throw new TypeError(
      `manifest app '${manifest.appId}' does not match installation app '${installation.appId}'`,
    );
  }
  return manifest.permissions.map((spec) =>
    grantPermission({
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      appId: installation.appId,
      spec,
      grantedAt: parts.grantedAt,
      grantedBy: parts.grantedBy,
    }),
  );
}

/**
 * The typed view of one installation's permission records: validated for
 * OWNERSHIP (every record must belong to this installation — tenant,
 * installation id, AND app), then partitioned into live and revoked grants.
 * A foreign record is a typed wiring defect ('permission-foreign'): the
 * runtime never lets an installation dispatch on a grant it does not own.
 */
export function installationGrantView(
  installation: AppInstallation,
  permissions: readonly Permission[],
): Result<
  { readonly live: readonly Permission[]; readonly revoked: readonly Permission[] },
  DomainError
> {
  const live: Permission[] = [];
  const revoked: Permission[] = [];
  for (const permission of permissions) {
    if (
      permission.tenantId !== installation.tenantId ||
      permission.installationId !== installation.installationId ||
      permission.appId !== installation.appId
    ) {
      return permissionFailure(
        installation,
        'invariant-violation',
        `permission ${permission.permissionId} does not belong to installation ${installation.installationId} (tenant/installation/app mismatch) — the runtime never dispatches on a foreign grant`,
        'permission-foreign',
        'permissions',
      );
    }
    if (isPermissionActive(permission)) {
      live.push(permission);
    } else {
      revoked.push(permission);
    }
  }
  return ok({ live, revoked });
}

/**
 * THE A9 dispatch gate: every required capability must be covered by a LIVE
 * grant of THIS installation. Returns the live capability names (the exact
 * authorization the gateway will re-check — defense in depth) on success;
 * a missing or revoked capability is a typed 'forbidden' failure BEFORE the
 * gateway is ever reached. Foreign permission records fail closed through
 * installationGrantView.
 */
export function checkInstallationCapabilities(
  installation: AppInstallation,
  permissions: readonly Permission[],
  required: readonly Capability[],
): Result<readonly Capability[], DomainError> {
  const view = installationGrantView(installation, permissions);
  if (!view.ok) return view;
  const granted = new Set<string>(view.value.live.map((permission) => permission.spec.capability));
  for (const capability of required) {
    if (!granted.has(capability)) {
      const revoked = view.value.revoked.some(
        (permission) => permission.spec.capability === capability,
      );
      return permissionFailure(
        installation,
        'forbidden',
        `installation ${installation.installationId} of app '${installation.appId}' does not hold a live grant for capability '${capability}' (A9: permissions are explicit and revocable — ${
          revoked ? 'the grant was revoked' : 'the capability was never granted'
        })`,
        revoked ? 'capability-revoked' : 'capability-not-granted',
        'permissions',
      );
    }
  }
  return ok(
    view.value.live.map((permission) => permission.spec.capability) as readonly Capability[],
  );
}

/**
 * The read capability an event subscription of `eventName` requires:
 * '<area>.read' derived from the event name's first segment, validated
 * against the CLOSED capability vocabulary. Fail-closed: an event whose
 * area has no declared read capability (platform-internal vocabularies such
 * as the gateway's own 'actions.*' audit events) can never be delivered to
 * an app installation.
 */
export function requiredCapabilityOfEvent(eventName: EventName): Result<Capability, DomainError> {
  const area = (eventName as string).split('.')[0] ?? '';
  const parsed = parseCapability(`${area}.read`);
  if (!parsed.ok) {
    return fail(
      domainError(
        'forbidden',
        `event '${eventName}' belongs to area '${area}', which has no declared read capability — events of undeclared areas are never delivered to app installations`,
        [
          {
            code: 'event-area-capability-unknown',
            message: eventName,
            path: 'eventName',
          },
        ],
      ),
    );
  }
  return ok(parsed.value);
}

/**
 * Revoke one permission OF THIS INSTALLATION (typed wrapper over the SDK's
 * revokePermission with the ownership discipline): a permission belonging
 * to another installation is typed-rejected, never revoked through this
 * installation's surface. Revocation is terminal and idempotent (the SDK's
 * semantics).
 */
export function revokeInstallationPermission(
  installation: AppInstallation,
  permission: Permission,
  parts: { readonly revokedBy: Actor; readonly now: Timestamp },
): Result<Permission, DomainError> {
  const owned = installationGrantView(installation, [permission]);
  if (!owned.ok) return owned;
  return revokePermission(permission, parts);
}

/**
 * Upgrade one permission OF THIS INSTALLATION to an explicitly re-declared
 * spec (typed wrapper over the SDK's upgradePermission with the ownership
 * discipline). The lifecycle version bumps and the state becomes
 * 'versioned'; widening (capability/scope-kind changes) is rejected by the
 * SDK — a new key is a NEW permission.
 */
export function upgradeInstallationPermission(
  installation: AppInstallation,
  permission: Permission,
  parts: { readonly spec: PermissionSpec; readonly now: Timestamp },
): Result<Permission, DomainError> {
  const owned = installationGrantView(installation, [permission]);
  if (!owned.ok) return owned;
  return upgradePermission(permission, parts);
}

/**
 * Parse an untrusted value as one of the installation's Permission records
 * (total, fail-closed — the SDK's own parser, re-exported for the runtime's
 * boundary convenience).
 */
export const parseInstallationPermission = parsePermission;
