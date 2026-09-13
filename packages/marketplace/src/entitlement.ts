// Office marketplace — tenant entitlements (OFF-027).
//
// The explicit, typed, revocable record of WHICH tenant may install WHICH
// app at WHICH release range (ADR-003: "Paid apps may use a platform
// entitlement contract" — the entitlement record itself is the platform's
// typed metadata; billing stays outside). No entitlement, no install: the
// install gate resolves the tenant's ACTIVE entitlements covering the
// release's version (`satisfiesVersion`). Revocation is TERMINAL and
// IDEMPOTENT (the A9 convention) and a revoked entitlement stops covering
// installs immediately; a re-grant after revocation mints a NEW
// deterministic record (the grant ordinal in the derived id), never a
// last-write-wins resurrection.
import { parseActor, parseFail, parseOk, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseAppId, parseVersionRange, satisfiesVersion } from '@office/app-sdk';
import type { AppId, AppVersion, VersionRange } from '@office/app-sdk';
import { entitlementIdOf, parseEntitlementId } from './identity';
import type { EntitlementId } from './identity';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';

/** Lifecycle state of an entitlement (revocation is terminal). */
export type EntitlementState = 'active' | 'revoked';

/** Both entitlement states, in vocabulary order. */
export const ENTITLEMENT_STATES: readonly EntitlementState[] = ['active', 'revoked'] as const;

/** Grammar description used in parse failures. */
export const ENTITLEMENT_STATE_GRAMMAR = "'active' | 'revoked' (revoked is terminal)";

/** Grammar description used in parse failures. */
export const ENTITLEMENT_GRAMMAR =
  "Entitlement: { kind: 'app-entitlement', entitlementId, tenantId, appId, versionRange, state, grantedAt, grantedBy, revokedAt, revokedBy }";

const ENTITLEMENT_KEYS = [
  'kind',
  'entitlementId',
  'tenantId',
  'appId',
  'versionRange',
  'state',
  'grantedAt',
  'grantedBy',
  'revokedAt',
  'revokedBy',
] as const;

/** Parse an untrusted value as an EntitlementState (total, fail-closed). */
export function parseEntitlementState(raw: unknown): ParseResult<EntitlementState> {
  if (typeof raw !== 'string' || !(ENTITLEMENT_STATES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', ENTITLEMENT_STATE_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as EntitlementState);
}

/** Type guard for structurally valid EntitlementState values. */
export function isEntitlementState(raw: unknown): raw is EntitlementState {
  return parseEntitlementState(raw).ok;
}

/**
 * The tenant-scoped install permission: tenant X may install app Y's
 * releases in `versionRange`. The derived entitlement id keys on
 * (tenant, app, range, grant ordinal) — re-granting the same range after a
 * revocation mints a new deterministic identity (ordinal + 1).
 */
export interface Entitlement {
  readonly kind: 'app-entitlement';
  /** The derived, deterministic entitlement identity. */
  readonly entitlementId: EntitlementId;
  /** The tenant that may install (A12 — the record's owning tenant). */
  readonly tenantId: TenantId;
  /** The app the entitlement covers. */
  readonly appId: AppId;
  /** The release range the entitlement covers (exact or caret). */
  readonly versionRange: VersionRange;
  /** The lifecycle position (revocation is terminal). */
  readonly state: EntitlementState;
  /** When the entitlement was granted (injected clock). */
  readonly grantedAt: Timestamp;
  /** The actor that granted the entitlement. */
  readonly grantedBy: Actor;
  /** When the entitlement was revoked; non-null exactly when revoked. */
  readonly revokedAt: Timestamp | null;
  /** The actor that revoked the entitlement; non-null exactly when revoked. */
  readonly revokedBy: Actor | null;
}

/** Parse an untrusted value as an Entitlement (total, fail-closed, strict keys). */
export function parseEntitlement(raw: unknown): ParseResult<Entitlement> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ENTITLEMENT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ENTITLEMENT_KEYS, '', ENTITLEMENT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-entitlement']);
  if (!kind.ok) return kind;
  const entitlementId = requireFieldWith(raw, 'entitlementId', '', parseEntitlementId);
  if (!entitlementId.ok) return entitlementId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const versionRange = requireFieldWith(raw, 'versionRange', '', parseVersionRange);
  if (!versionRange.ok) return versionRange;
  const state = requireFieldWith(raw, 'state', '', parseEntitlementState);
  if (!state.ok) return state;
  const grantedAt = requireFieldWith(raw, 'grantedAt', '', parseTimestamp);
  if (!grantedAt.ok) return grantedAt;
  const grantedBy = requireFieldWith(raw, 'grantedBy', '', parseActor);
  if (!grantedBy.ok) return grantedBy;
  const revokedAt = requireNullableFieldWith(raw, 'revokedAt', '', parseTimestamp);
  if (!revokedAt.ok) return revokedAt;
  const revokedBy = requireNullableFieldWith(raw, 'revokedBy', '', parseActor);
  if (!revokedBy.ok) return revokedBy;
  if (state.value === 'revoked' && (revokedAt.value === null || revokedBy.value === null)) {
    return parseFail(
      'invalid-value',
      'revokedAt',
      'revocation instant and actor non-null exactly when state is revoked',
      'revoked entitlement without revocation provenance',
    );
  }
  if (state.value === 'active' && (revokedAt.value !== null || revokedBy.value !== null)) {
    return parseFail(
      'invalid-value',
      'revokedAt',
      'revocation instant and actor null exactly when state is active',
      'active entitlement carrying revocation provenance',
    );
  }
  return parseOk({
    kind: 'app-entitlement',
    entitlementId: entitlementId.value,
    tenantId: tenantId.value,
    appId: appId.value,
    versionRange: versionRange.value,
    state: state.value,
    grantedAt: grantedAt.value,
    grantedBy: grantedBy.value,
    revokedAt: revokedAt.value,
    revokedBy: revokedBy.value,
  } satisfies Entitlement);
}

/** Type guard for structurally valid Entitlement values. */
export function isEntitlement(raw: unknown): raw is Entitlement {
  return parseEntitlement(raw).ok;
}

/** The canonical string form of a version range (derivation input). */
export const versionRangeKey = (range: VersionRange): string =>
  `${range.kind === 'caret' ? '^' : ''}${range.version}`;

/**
 * Compose a fresh entitlement record (trusted path; loud TypeError): state
 * 'active', no revocation fields. The entitlement id is DERIVED from
 * (tenant, app, range, grant ordinal) — deterministic identity keyed by the
 * store's ordinal counter, never caller-minted.
 */
export function grantEntitlement(parts: {
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly versionRange: VersionRange;
  readonly grantOrdinal: number;
  readonly grantedAt: Timestamp;
  readonly grantedBy: Actor;
}): Entitlement {
  const entitlement: Entitlement = {
    kind: 'app-entitlement',
    entitlementId: entitlementIdOf({
      tenantId: parts.tenantId,
      appId: parts.appId,
      versionRange: versionRangeKey(parts.versionRange),
      ordinal: parts.grantOrdinal,
    }),
    tenantId: parts.tenantId,
    appId: parts.appId,
    versionRange: parts.versionRange,
    state: 'active',
    grantedAt: parts.grantedAt,
    grantedBy: parts.grantedBy,
    revokedAt: null,
    revokedBy: null,
  };
  const parsed = parseEntitlement(entitlement);
  if (!parsed.ok) {
    throw new TypeError(`invalid app entitlement: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Revoke the entitlement (TERMINAL and IDEMPOTENT — the A9 convention): a
 * revoked entitlement stops covering installs immediately; revoking an
 * already-revoked entitlement returns it unchanged with the ORIGINAL
 * revocation instant and actor preserved. The audit trail (engine level)
 * records only the actual transition.
 */
export function revokeEntitlement(
  entitlement: Entitlement,
  parts: { readonly at: Timestamp; readonly by: Actor },
): Entitlement {
  if (entitlement.state === 'revoked') return entitlement;
  const revoked: Entitlement = {
    ...entitlement,
    state: 'revoked',
    revokedAt: parts.at,
    revokedBy: parts.by,
  };
  const parsed = parseEntitlement(revoked);
  if (!parsed.ok) {
    throw new TypeError(`invalid revoked entitlement: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Does the ACTIVE entitlement cover the given release version? */
export function entitlesRelease(entitlement: Entitlement, version: AppVersion): boolean {
  return (
    entitlement.state === 'active' &&
    satisfiesVersion(entitlement.versionRange, version)
  );
}
