// Office app-sdk — A9 permission declarations & lifecycle records (OFF-025).
//
// Marketplace permissions are EXPLICIT, VERSIONED, REVOCABLE (the A9
// discipline, mirroring the landed sync subscription grants — freeze A7
// carries the marketplace decision: apps declare capabilities/permissions
// and can be suspended or revoked without deleting canonical state).
//
// Two records, deliberately distinct:
//
// - `PermissionSpec` — the DECLARATION inside an AppManifest: exactly one
//   declared capability (validated against the CLOSED @office/authz
//   vocabulary — an undeclared or wildcard capability can never parse), one
//   explicit scope kind ('tenant' | 'project' — never '*'), and a
//   declaration version. No wildcards of any kind can be expressed.
//
// - `Permission` — the RUNTIME record the app runtime (OFF-026) and the
//   marketplace (OFF-027) own INSTANCES of; this SDK defines the typed
//   record and the lifecycle semantics contract:
//
//     granted → versioned → revoked
//
//   'granted' is the explicitly issued record (lifecycle version 1);
//   'versioned' records an explicit spec upgrade (the lifecycle version
//   bumps — a stale pin is the marketplace's permission-delta review, never
//   a silent expansion); 'revoked' is TERMINAL: the record stops conferring
//   the capability, and revocation is idempotent (revoking a revoked
//   permission returns it unchanged). The runtime re-checks every live
//   permission before any gateway call — a revoked permission denies, it
//   never partially executes.
import {
  parseActor,
  parseEntityId,
  parseFail,
  parseOk,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { Actor, EntityId, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseCapability } from '@office/authz';
import type { Capability } from '@office/authz';
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
import {
  parseAppId,
  parsePermissionId,
  parsePermissionVersion,
  permissionIdOf,
} from './identity';
import type { AppId, PermissionId, PermissionVersion } from './identity';

/** The scope kinds a permission may be granted at (explicit; never a wildcard). */
export type PermissionScopeKind = 'tenant' | 'project';

/** Lifecycle state of a runtime permission (A9: granted → versioned → revoked). */
export type PermissionState = 'granted' | 'versioned' | 'revoked';

/** Grammar description used in parse failures. */
export const PERMISSION_SCOPE_KIND_GRAMMAR = "'tenant' | 'project' (explicit scope kind — no wildcards)";

/** Grammar description used in parse failures. */
export const PERMISSION_SPEC_GRAMMAR =
  "PermissionSpec: { kind: 'app-permission', capability, scopeKind: 'tenant' | 'project', version } — capability must be one of the declared authz capabilities; no wildcards";

/** Grammar description used in parse failures. */
export const PERMISSION_GRAMMAR =
  "Permission: { kind: 'app-permission-grant', permissionId, tenantId, installationId, appId, spec, version, grantedAt, grantedBy, state: 'granted' | 'versioned' | 'revoked', revokedAt, revokedBy }";

const PERMISSION_SPEC_KEYS = ['kind', 'capability', 'scopeKind', 'version'] as const;

const PERMISSION_KEYS = [
  'kind',
  'permissionId',
  'tenantId',
  'installationId',
  'appId',
  'spec',
  'version',
  'grantedAt',
  'grantedBy',
  'state',
  'revokedAt',
  'revokedBy',
] as const;

const SCOPE_KINDS: readonly PermissionScopeKind[] = ['tenant', 'project'];
const PERMISSION_STATES: readonly PermissionState[] = ['granted', 'versioned', 'revoked'];

/**
 * Parse an untrusted value as a PermissionScopeKind (total, fail-closed).
 * Anything but the two explicit literals — including '*' — is rejected.
 */
export function parsePermissionScopeKind(raw: unknown): ParseResult<PermissionScopeKind> {
  if (typeof raw !== 'string' || !(SCOPE_KINDS as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', PERMISSION_SCOPE_KIND_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as PermissionScopeKind);
}

/** Type guard for declared PermissionScopeKind values. */
export function isPermissionScopeKind(raw: unknown): raw is PermissionScopeKind {
  return parsePermissionScopeKind(raw).ok;
}

/**
 * The A9 permission DECLARATION an app manifest carries: one declared
 * capability (closed authz vocabulary), one explicit scope kind, and the
 * declaration version. Bumping the version is a manifest-level permission
 * change — the marketplace reviews the delta and the runtime re-grants
 * against the new spec; an app can NEVER silently expand a permission at
 * runtime (freeze anti-pattern).
 */
export interface PermissionSpec {
  readonly kind: 'app-permission';
  /** The declared capability — must be one of CAPABILITIES (@office/authz). */
  readonly capability: Capability;
  /** The scope kind the permission is requested at (A12 tenant/project). */
  readonly scopeKind: PermissionScopeKind;
  /** Declaration version (>= 1); a change bumps it. */
  readonly version: PermissionVersion;
}

/**
 * Parse an untrusted value as a PermissionSpec (total, fail-closed, strict
 * keys). The capability is validated against the CLOSED authz vocabulary:
 * unknown areas, malformed names, and wildcard-looking values ('projects.*',
 * '*') are all typed-rejected here.
 */
export function parsePermissionSpec(raw: unknown): ParseResult<PermissionSpec> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PERMISSION_SPEC_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PERMISSION_SPEC_KEYS, '', PERMISSION_SPEC_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-permission']);
  if (!kind.ok) return kind;
  const capability = requireFieldWith(raw, 'capability', '', parseCapability);
  if (!capability.ok) return capability;
  const scopeKind = requireFieldWith(raw, 'scopeKind', '', parsePermissionScopeKind);
  if (!scopeKind.ok) return scopeKind;
  const version = requireFieldWith(raw, 'version', '', parsePermissionVersion);
  if (!version.ok) return version;
  return parseOk(
    {
      kind: 'app-permission',
      capability: capability.value,
      scopeKind: scopeKind.value,
      version: version.value,
    } satisfies PermissionSpec,
  );
}

/** Type guard for structurally valid PermissionSpec values. */
export function isPermissionSpec(raw: unknown): raw is PermissionSpec {
  return parsePermissionSpec(raw).ok;
}

/**
 * The A9 runtime permission record: WHO holds WHAT — the tenant-scoped app
 * installation the permission belongs to (freeze A7: installation creates a
 * tenant-scoped app installation), the granted spec, and the lifecycle
 * position. The app runtime (OFF-026) and marketplace (OFF-027) own the
 * instances; this SDK owns the typed record + the lifecycle semantics
 * below. A permission NEVER widens silently: every change is an explicit
 * lifecycle transition returning a new immutable record.
 */
export interface Permission {
  readonly kind: 'app-permission-grant';
  /** Deterministic permission identity (derived from the permission key). */
  readonly permissionId: PermissionId;
  /** The tenant that issued the permission (freeze A12). */
  readonly tenantId: TenantId;
  /** The tenant-scoped app installation the permission belongs to. */
  readonly installationId: EntityId;
  /** The app the permission was granted to. */
  readonly appId: AppId;
  /** The granted declaration (capability + scope kind + declaration version). */
  readonly spec: PermissionSpec;
  /** Lifecycle version (1 when granted; bumped per explicit upgrade). */
  readonly version: PermissionVersion;
  /** When the permission was issued (injected clock — never wall time). */
  readonly grantedAt: Timestamp;
  /** The actor that issued the permission. */
  readonly grantedBy: Actor;
  /** Lifecycle position (granted → versioned → revoked). */
  readonly state: PermissionState;
  /** When the permission was revoked, exactly when state === 'revoked' (else null). */
  readonly revokedAt: Timestamp | null;
  /** The actor that revoked the permission, exactly when state === 'revoked' (else null). */
  readonly revokedBy: Actor | null;
}

/**
 * Parse an untrusted value as a Permission (total, fail-closed, strict
 * keys). Lifecycle consistency is enforced fail-closed: a live permission
 * (granted/versioned) carries no revocation fields, a revoked one carries
 * both, 'granted' means lifecycle version 1, and 'versioned' means at least
 * one explicit upgrade (version >= 2).
 */
export function parsePermission(raw: unknown): ParseResult<Permission> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PERMISSION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PERMISSION_KEYS, '', PERMISSION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-permission-grant']);
  if (!kind.ok) return kind;
  const permissionId = requireFieldWith(raw, 'permissionId', '', parsePermissionId);
  if (!permissionId.ok) return permissionId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const installationId = requireFieldWith(raw, 'installationId', '', parseEntityId);
  if (!installationId.ok) return installationId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const spec = requireFieldWith(raw, 'spec', '', parsePermissionSpec);
  if (!spec.ok) return spec;
  const version = requireFieldWith(raw, 'version', '', parsePermissionVersion);
  if (!version.ok) return version;
  const grantedAt = requireFieldWith(raw, 'grantedAt', '', parseTimestamp);
  if (!grantedAt.ok) return grantedAt;
  const grantedBy = requireFieldWith(raw, 'grantedBy', '', parseActor);
  if (!grantedBy.ok) return grantedBy;
  const state = requireLiteral(raw, 'state', '', PERMISSION_STATES);
  if (!state.ok) return state;
  const revokedAt = requireNullableFieldWith(raw, 'revokedAt', '', parseTimestamp);
  if (!revokedAt.ok) return revokedAt;
  const revokedBy = requireNullableFieldWith(raw, 'revokedBy', '', parseActor);
  if (!revokedBy.ok) return revokedBy;

  const permissionState = state.value as PermissionState;
  if (permissionState === 'revoked') {
    if (revokedAt.value === null || revokedBy.value === null) {
      return parseFail(
        'invalid-value',
        'revokedAt',
        'a revoked permission carries both revokedAt and revokedBy',
        'null',
      );
    }
  } else if (revokedAt.value !== null || revokedBy.value !== null) {
    return parseFail(
      'invalid-value',
      'revokedAt',
      "null unless state === 'revoked'",
      describeValue(revokedAt.value),
    );
  }
  if (permissionState === 'granted' && version.value !== 1) {
    return parseFail(
      'invalid-value',
      'version',
      "1 when state === 'granted' (the issued permission has not been upgraded)",
      describeValue(version.value),
    );
  }
  if (permissionState === 'versioned' && version.value < 2) {
    return parseFail(
      'invalid-value',
      'version',
      ">= 2 when state === 'versioned' (versioned means explicitly upgraded at least once)",
      describeValue(version.value),
    );
  }
  return parseOk(
    {
      kind: 'app-permission-grant',
      permissionId: permissionId.value,
      tenantId: tenantId.value,
      installationId: installationId.value,
      appId: appId.value,
      spec: spec.value,
      version: version.value,
      grantedAt: grantedAt.value,
      grantedBy: grantedBy.value,
      state: permissionState,
      revokedAt: revokedAt.value,
      revokedBy: revokedBy.value,
    } satisfies Permission,
  );
}

/** Type guard for structurally valid Permission values. */
export function isPermission(raw: unknown): raw is Permission {
  return parsePermission(raw).ok;
}

const permissionContext = (permission: {
  readonly tenantId: TenantId;
}): DomainErrorContext => ({
  scope: { kind: 'tenant', tenantId: permission.tenantId },
});

/**
 * Compose the initial issued permission from validated parts (trusted path;
 * loud TypeError): state 'granted', lifecycle version 1, no revocation
 * fields, and the permission id DERIVED from the permission key — the same
 * installation/capability/scope-kind always maps to the same identity.
 */
export function grantPermission(parts: {
  readonly permissionId?: PermissionId;
  readonly tenantId: TenantId;
  readonly installationId: EntityId;
  readonly appId: AppId;
  readonly spec: PermissionSpec;
  readonly grantedAt: Timestamp;
  readonly grantedBy: Actor;
}): Permission {
  const permissionId =
    parts.permissionId ??
    permissionIdOf({
      tenantId: parts.tenantId,
      installationId: parts.installationId,
      capability: parts.spec.capability,
      scopeKind: parts.spec.scopeKind,
    });
  const parsed = parsePermission({
    kind: 'app-permission-grant',
    permissionId,
    tenantId: parts.tenantId,
    installationId: parts.installationId,
    appId: parts.appId,
    spec: parts.spec,
    version: 1,
    grantedAt: parts.grantedAt,
    grantedBy: parts.grantedBy,
    state: 'granted',
    revokedAt: null,
    revokedBy: null,
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid permission: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Explicitly upgrade a permission's spec (trusted lifecycle transition
 * granted/versioned → versioned). The lifecycle version bumps and the state
 * becomes 'versioned': holders pinned to the previous lifecycle version are
 * stale — the marketplace's permission-delta review re-grants them against
 * the new spec. Upgrading a REVOKED permission, or re-upgrading to the SAME
 * spec, is a typed invariant-violation: revocation is terminal and an
 * upgrade must change something. The new spec may not silently widen either
 * — changing the capability or scope kind is a NEW permission (a new key),
 * so only the declaration version may move.
 */
export function upgradePermission(
  permission: Permission,
  parts: { readonly spec: PermissionSpec; readonly now: Timestamp },
): Result<Permission, DomainError> {
  if (permission.state === 'revoked') {
    return fail(
      domainError(
        'invariant-violation',
        `permission ${permission.permissionId} is revoked and cannot be upgraded`,
        [{ code: 'permission-revoked', message: permission.permissionId, path: 'state' }],
        permissionContext(permission),
      ),
    );
  }
  const sameSpec =
    permission.spec.capability === parts.spec.capability &&
    permission.spec.scopeKind === parts.spec.scopeKind &&
    permission.spec.version === parts.spec.version;
  if (sameSpec) {
    return fail(
      domainError(
        'invariant-violation',
        `permission ${permission.permissionId} already carries spec ${permission.spec.capability}@${permission.spec.version}`,
        [
          {
            code: 'permission-spec-unchanged',
            message: `${permission.spec.capability}@${permission.spec.version}`,
            path: 'spec',
          },
        ],
        permissionContext(permission),
      ),
    );
  }
  const widened =
    parts.spec.capability !== permission.spec.capability ||
    parts.spec.scopeKind !== permission.spec.scopeKind;
  if (widened) {
    return fail(
      domainError(
        'invariant-violation',
        `permission ${permission.permissionId} cannot change capability or scope kind in place — grant a new permission instead`,
        [
          {
            code: 'permission-widening-forbidden',
            message: `${permission.spec.capability}/${permission.spec.scopeKind} → ${parts.spec.capability}/${parts.spec.scopeKind}`,
            path: 'spec',
          },
        ],
        permissionContext(permission),
      ),
    );
  }
  return ok({
    ...permission,
    spec: parts.spec,
    version: (permission.version + 1) as PermissionVersion,
    state: 'versioned',
  } satisfies Permission);
}

/**
 * Explicitly revoke a permission (terminal lifecycle transition). Revoking
 * an already-revoked permission is an idempotent no-op returning the record
 * unchanged (the original revocation instant and actor are preserved) —
 * mirroring the workspace conflict-resolution idempotency convention.
 */
export function revokePermission(
  permission: Permission,
  parts: { readonly revokedBy: Actor; readonly now: Timestamp },
): Result<Permission, DomainError> {
  if (permission.state === 'revoked') {
    return ok(permission);
  }
  const revoked = parsePermission({
    ...permission,
    state: 'revoked',
    revokedAt: parts.now,
    revokedBy: parts.revokedBy,
  });
  if (!revoked.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `permission ${permission.permissionId} could not be revoked: ${revoked.error.code}`,
        [{ code: 'permission-revocation-invalid', message: revoked.error.received, path: 'state' }],
        permissionContext(permission),
      ),
    );
  }
  return ok(revoked.value);
}

/** Is the permission live (not revoked)? Revoked permissions deny everything. */
export function isPermissionActive(permission: Permission): boolean {
  return permission.state !== 'revoked';
}
