// Office sync — the A9 subscription grant (OFF-028).
//
// A subscription is PERMISSIONED (freeze A9: explicit, versioned, revocable):
// every Subscription is backed by exactly one SubscriptionGrant, and the
// grant — not the subscription — is the permission. The grant records WHO
// may subscribe (the AuthorizationContext: actor, execution scope, and
// capabilities the grant confers), under WHICH protocol version, and its
// lifecycle position:
//
//   granted → versioned → revoked
//
// - 'granted'    the initial, explicitly issued grant (version 1);
// - 'versioned'  the grant has been explicitly upgraded to a newer pinned
//                 protocol version (lifecycle version bumped); older
//                 subscriptions pinned to the previous grant version are
//                 stale and typed-rejected at (re)subscribe — the client
//                 re-subscribes against the upgraded grant;
// - 'revoked'    terminal: live streams stop with the typed grant-revoked
//                 message, new subscribes are typed-denied. Revocation is
//                 idempotent (revoking a revoked grant returns it unchanged).
//
// The grant is re-checked at EVERY stream read (see broker.ts): a revoked
// grant stops the stream typed-cleanly — whole messages only, never a
// partial or corrupt event mid-delivery.
import {
  parseActor,
  parseEntityId,
  parseFail,
  parseOk,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { Actor, EntityId, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseAuthorizationContext } from '@office/authz';
import type { AuthorizationContext } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { parseSubscriptionGrantId } from './identity';
import type { SubscriptionGrantId } from './identity';
import { parseProtocolVersion } from './version';
import type { ProtocolVersion } from './version';
import { describeValue, isPlainObject, requireFieldWith, requireLiteral, requireNullableFieldWith, unknownKeyFailure } from './parse';

declare const grantVersionBrand: unique symbol;

/**
 * Lifecycle version of a grant: 1 when issued, bumped by each explicit
 * protocol upgrade. Subscriptions pin the grant version they were composed
 * against; a stale pin is typed-rejected.
 */
export type GrantVersion = number & { readonly [grantVersionBrand]: 'GrantVersion' };

/** Grammar description used in parse failures. */
export const GRANT_VERSION_GRAMMAR = `integer version in 1..${Number.MAX_SAFE_INTEGER} (1 when issued, bumped per upgrade)`;

/** Lifecycle state of a subscription grant (A9: granted → versioned → revoked). */
export type GrantState = 'granted' | 'versioned' | 'revoked';

/** The A9 permission backing a subscription. */
export interface SubscriptionGrant {
  readonly kind: 'subscription-grant';
  /** Deterministic grant identity (derived from the grant key). */
  readonly grantId: SubscriptionGrantId;
  /** The tenant that issued the grant (freeze A12). */
  readonly tenantId: TenantId;
  /** The subscribing client's canonical identity the grant backs. */
  readonly subscriberId: EntityId;
  /** WHO may subscribe: actor, execution scope, and conferred capabilities. */
  readonly context: AuthorizationContext;
  /** The protocol version this grant pins its subscriptions to. */
  readonly protocolVersion: ProtocolVersion;
  /** Lifecycle version (1 when issued; bumped per explicit upgrade). */
  readonly version: GrantVersion;
  /** When the grant was issued (injected clock). */
  readonly grantedAt: Timestamp;
  /** The actor that issued the grant. */
  readonly grantedBy: Actor;
  /** Lifecycle position (granted → versioned → revoked). */
  readonly state: GrantState;
  /** When the grant was revoked, exactly when state === 'revoked' (else null). */
  readonly revokedAt: Timestamp | null;
  /** The actor that revoked the grant, exactly when state === 'revoked' (else null). */
  readonly revokedBy: Actor | null;
}

/** Shape description used in parse failures. */
export const SUBSCRIPTION_GRANT_GRAMMAR =
  "SubscriptionGrant: { kind: 'subscription-grant', grantId, tenantId, subscriberId, context, protocolVersion, version, grantedAt, grantedBy, state: 'granted' | 'versioned' | 'revoked', revokedAt, revokedBy }";

const SUBSCRIPTION_GRANT_KEYS = [
  'kind',
  'grantId',
  'tenantId',
  'subscriberId',
  'context',
  'protocolVersion',
  'version',
  'grantedAt',
  'grantedBy',
  'state',
  'revokedAt',
  'revokedBy',
] as const;

const GRANT_STATES: readonly GrantState[] = ['granted', 'versioned', 'revoked'];

/** Parse an untrusted value as a GrantVersion (total, fail-closed). */
export function parseGrantVersion(raw: unknown): ParseResult<GrantVersion> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > Number.MAX_SAFE_INTEGER) {
    return parseFail('invalid-value', '', GRANT_VERSION_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as GrantVersion);
}

/** Type guard for structurally valid GrantVersion values. */
export function isGrantVersion(raw: unknown): raw is GrantVersion {
  return parseGrantVersion(raw).ok;
}

const grantContext = (grant: { readonly tenantId: TenantId }): DomainErrorContext => ({
  scope: { kind: 'tenant', tenantId: grant.tenantId },
});

/**
 * Parse an untrusted value as a SubscriptionGrant (total, fail-closed,
 * strict keys). Lifecycle consistency is enforced fail-closed: a live grant
 * (granted/versioned) carries no revocation fields, a revoked grant carries
 * both, 'granted' means lifecycle version 1, and 'versioned' means at least
 * one explicit upgrade (version >= 2).
 */
export function parseSubscriptionGrant(raw: unknown): ParseResult<SubscriptionGrant> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SUBSCRIPTION_GRANT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SUBSCRIPTION_GRANT_KEYS, '', SUBSCRIPTION_GRANT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['subscription-grant']);
  if (!kind.ok) return kind;
  const grantId = requireFieldWith(raw, 'grantId', '', parseSubscriptionGrantId);
  if (!grantId.ok) return grantId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const subscriberId = requireFieldWith(raw, 'subscriberId', '', parseEntityId);
  if (!subscriberId.ok) return subscriberId;
  const context = requireFieldWith(raw, 'context', '', parseAuthorizationContext);
  if (!context.ok) return context;
  const protocolVersion = requireFieldWith(raw, 'protocolVersion', '', parseProtocolVersion);
  if (!protocolVersion.ok) return protocolVersion;
  const version = requireFieldWith(raw, 'version', '', parseGrantVersion);
  if (!version.ok) return version;
  const grantedAt = requireFieldWith(raw, 'grantedAt', '', parseTimestamp);
  if (!grantedAt.ok) return grantedAt;
  const grantedBy = requireFieldWith(raw, 'grantedBy', '', parseActor);
  if (!grantedBy.ok) return grantedBy;
  const state = requireLiteral(raw, 'state', '', GRANT_STATES);
  if (!state.ok) return state;
  const revokedAt = requireNullableFieldWith(raw, 'revokedAt', '', parseTimestamp);
  if (!revokedAt.ok) return revokedAt;
  const revokedBy = requireNullableFieldWith(raw, 'revokedBy', '', parseActor);
  if (!revokedBy.ok) return revokedBy;

  const grantState = state.value as GrantState;
  if (grantState === 'revoked') {
    if (revokedAt.value === null || revokedBy.value === null) {
      return parseFail(
        'invalid-value',
        'revokedAt',
        'a revoked grant carries both revokedAt and revokedBy',
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
  if (grantState === 'granted' && version.value !== 1) {
    return parseFail(
      'invalid-value',
      'version',
      "1 when state === 'granted' (the issued grant has not been upgraded)",
      describeValue(version.value),
    );
  }
  if (grantState === 'versioned' && version.value < 2) {
    return parseFail(
      'invalid-value',
      'version',
      ">= 2 when state === 'versioned' (versioned means explicitly upgraded at least once)",
      describeValue(version.value),
    );
  }
  return parseOk(
    {
      kind: 'subscription-grant',
      grantId: grantId.value,
      tenantId: tenantId.value,
      subscriberId: subscriberId.value,
      context: context.value,
      protocolVersion: protocolVersion.value,
      version: version.value,
      grantedAt: grantedAt.value,
      grantedBy: grantedBy.value,
      state: grantState,
      revokedAt: revokedAt.value,
      revokedBy: revokedBy.value,
    } satisfies SubscriptionGrant,
  );
}

/** Type guard for structurally valid SubscriptionGrant values. */
export function isSubscriptionGrant(raw: unknown): raw is SubscriptionGrant {
  return parseSubscriptionGrant(raw).ok;
}

/**
 * Compose the initial issued grant from validated parts (trusted path; loud
 * TypeError): state 'granted', lifecycle version 1, no revocation fields.
 */
export function grantSubscription(parts: {
  readonly grantId: SubscriptionGrantId;
  readonly tenantId: TenantId;
  readonly subscriberId: EntityId;
  readonly context: AuthorizationContext;
  readonly protocolVersion: ProtocolVersion;
  readonly grantedAt: Timestamp;
  readonly grantedBy: Actor;
}): SubscriptionGrant {
  const parsed = parseSubscriptionGrant({
    ...parts,
    kind: 'subscription-grant',
    version: 1,
    state: 'granted',
    revokedAt: null,
    revokedBy: null,
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid subscription grant: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Explicitly upgrade a grant's pinned protocol version (trusted lifecycle
 * transition granted/versioned → versioned). The lifecycle version bumps and
 * the state becomes 'versioned'; subscriptions pinned to the previous grant
 * version are stale (typed-rejected at (re)subscribe — they must be
 * recomposed against the upgraded grant). Upgrading a REVOKED grant, or
 * re-upgrading to the SAME protocol version, is a typed
 * invariant-violation: revocation is terminal and upgrades must change
 * something.
 */
export function upgradeGrantProtocol(
  grant: SubscriptionGrant,
  parts: { readonly protocolVersion: ProtocolVersion; readonly now: Timestamp },
): Result<SubscriptionGrant, DomainError> {
  if (grant.state === 'revoked') {
    return fail(
      domainError(
        'invariant-violation',
        `subscription grant ${grant.grantId} is revoked and cannot be upgraded`,
        [{ code: 'grant-revoked', message: grant.grantId, path: 'state' }],
        grantContext(grant),
      ),
    );
  }
  if (grant.protocolVersion === parts.protocolVersion) {
    return fail(
      domainError(
        'invariant-violation',
        `subscription grant ${grant.grantId} already pins protocol version ${parts.protocolVersion}`,
        [
          {
            code: 'grant-version-unchanged',
            message: parts.protocolVersion,
            path: 'protocolVersion',
          },
        ],
        grantContext(grant),
      ),
    );
  }
  return ok({
    ...grant,
    protocolVersion: parts.protocolVersion,
    version: (grant.version + 1) as GrantVersion,
    state: 'versioned',
  } satisfies SubscriptionGrant);
}

/**
 * Explicitly revoke a grant (terminal lifecycle transition). Revoking an
 * already-revoked grant is an idempotent no-op returning the grant unchanged
 * (the original revocation instant and actor are preserved) — mirroring the
 * workspace conflict-resolution idempotency convention.
 */
export function revokeGrant(
  grant: SubscriptionGrant,
  parts: { readonly revokedBy: Actor; readonly now: Timestamp },
): Result<SubscriptionGrant, DomainError> {
  if (grant.state === 'revoked') {
    return ok(grant);
  }
  const upgraded = parseSubscriptionGrant({
    ...grant,
    state: 'revoked',
    revokedAt: parts.now,
    revokedBy: parts.revokedBy,
  });
  if (!upgraded.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `subscription grant ${grant.grantId} could not be revoked: ${upgraded.error.code}`,
        [{ code: 'grant-revocation-invalid', message: upgraded.error.received, path: 'state' }],
        grantContext(grant),
      ),
    );
  }
  return ok(upgraded.value);
}

/** Is the grant live (not revoked)? Revoked grants stop streams and deny new subscribes. */
export function isGrantActive(grant: SubscriptionGrant): boolean {
  return grant.state !== 'revoked';
}
