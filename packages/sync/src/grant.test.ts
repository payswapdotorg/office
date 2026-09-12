import { describe, expect, it } from 'vitest';
import {
  GRANT_VERSION_GRAMMAR,
  grantSubscription,
  isGrantActive,
  isGrantVersion,
  isSubscriptionGrant,
  parseGrantVersion,
  parseSubscriptionGrant,
  revokeGrant,
  upgradeGrantProtocol,
} from './grant';
import { subscriptionGrantIdOf } from './identity';
import type { SubscriptionGrant } from './grant';
import {
  ACTOR_A,
  ACTOR_ADMIN,
  ACTOR_B,
  NOW_1,
  NOW_2,
  NOW_3,
  TENANT_A,
  CLIENT_A,
  readerContext,
  unwrap,
} from './test-support';
import { CURRENT_PROTOCOL_VERSION } from './version';

// OFF-028 — the A9 subscription grant: explicit (backed by a full
// AuthorizationContext), versioned (pinned protocol version + lifecycle
// version, upgraded only explicitly), revocable (terminal, idempotent). The
// lifecycle is granted → versioned → revoked, enforced fail-closed by the
// parse boundary and typed Results on the transitions.

const grantId = () => subscriptionGrantIdOf({ tenantId: TENANT_A, subscriberId: CLIENT_A, serial: 1 });

const issuedGrant = (): SubscriptionGrant =>
  grantSubscription({
    grantId: grantId(),
    tenantId: TENANT_A,
    subscriberId: CLIENT_A,
    context: readerContext(ACTOR_A, { kind: 'tenant', tenantId: TENANT_A }),
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    grantedAt: NOW_1,
    grantedBy: ACTOR_ADMIN,
  });

describe('grant lifecycle model (OFF-028, freeze A9)', () => {
  it('issues the initial grant: state granted, lifecycle version 1, no revocation fields', () => {
    const grant = issuedGrant();
    expect(grant.state).toBe('granted');
    expect(grant.version).toBe(1);
    expect(grant.revokedAt).toBeNull();
    expect(grant.revokedBy).toBeNull();
    expect(grant.context.capabilities).toContain('projects.read');
    expect(isGrantActive(grant)).toBe(true);
    expect(isSubscriptionGrant(grant)).toBe(true);
  });

  it('upgrades the pinned protocol version explicitly: granted → versioned, version bumps', () => {
    const grant = issuedGrant();
    const upgraded = unwrap(upgradeGrantProtocol(grant, { protocolVersion: '1.1.0', now: NOW_2 }));
    expect(upgraded.state).toBe('versioned');
    expect(upgraded.version).toBe(2);
    expect(upgraded.protocolVersion).toBe('1.1.0');
    expect(isGrantActive(upgraded)).toBe(true);
  });

  it('re-upgrading to the SAME protocol version is a typed invariant-violation', () => {
    const grant = issuedGrant();
    const failed = upgradeGrantProtocol(grant, { protocolVersion: CURRENT_PROTOCOL_VERSION, now: NOW_2 });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invariant-violation');
      expect(failed.error.details[0]?.code).toBe('grant-version-unchanged');
    }
  });

  it('revokes explicitly and terminally (idempotent on re-revocation)', () => {
    const grant = issuedGrant();
    const revoked = unwrap(revokeGrant(grant, { revokedBy: ACTOR_ADMIN, now: NOW_3 }));
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokedAt).toBe(NOW_3);
    expect(revoked.revokedBy).toEqual(ACTOR_ADMIN);
    expect(isGrantActive(revoked)).toBe(false);
    const again = unwrap(revokeGrant(revoked, { revokedBy: ACTOR_B, now: NOW_1 }));
    expect(again).toEqual(revoked); // idempotent: original revocation preserved
  });

  it('refuses to upgrade a REVOKED grant (revocation is terminal)', () => {
    const revoked = unwrap(revokeGrant(issuedGrant(), { revokedBy: ACTOR_ADMIN, now: NOW_3 }));
    const failed = upgradeGrantProtocol(revoked, { protocolVersion: '1.1.0', now: NOW_2 });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invariant-violation');
      expect(failed.error.details[0]?.code).toBe('grant-revoked');
    }
  });
});

describe('grant parse boundary (fail-closed, strict keys)', () => {
  it('round-trips the issued grant through parseSubscriptionGrant', () => {
    const grant = issuedGrant();
    expect(unwrap(parseSubscriptionGrant(grant))).toEqual(grant);
  });

  it('round-trips an upgraded and a revoked grant', () => {
    const upgraded = unwrap(upgradeGrantProtocol(issuedGrant(), { protocolVersion: '1.1.0', now: NOW_2 }));
    expect(unwrap(parseSubscriptionGrant(upgraded))).toEqual(upgraded);
    const revoked = unwrap(revokeGrant(upgraded, { revokedBy: ACTOR_ADMIN, now: NOW_3 }));
    expect(unwrap(parseSubscriptionGrant(revoked))).toEqual(revoked);
  });

  it('rejects unknown fields, missing fields, and non-object values', () => {
    const grant = issuedGrant() as unknown as Record<string, unknown>;
    expect(parseSubscriptionGrant({ ...grant, extra: 1 }).ok).toBe(false);
    expect(parseSubscriptionGrant({ ...grant, version: undefined }).ok).toBe(false);
    expect(parseSubscriptionGrant(null).ok).toBe(false);
    expect(parseSubscriptionGrant('grant').ok).toBe(false);
    expect(parseSubscriptionGrant([]).ok).toBe(false);
  });

  it('enforces lifecycle consistency fail-closed', () => {
    const grant = issuedGrant() as unknown as Record<string, unknown>;
    // granted must be version 1
    expect(parseSubscriptionGrant({ ...grant, version: 2, state: 'granted' }).ok).toBe(false);
    // versioned must be version >= 2
    expect(parseSubscriptionGrant({ ...grant, version: 1, state: 'versioned' }).ok).toBe(false);
    // revoked must carry both revocation fields
    expect(parseSubscriptionGrant({ ...grant, state: 'revoked', revokedAt: null, revokedBy: null }).ok).toBe(false);
    expect(
      parseSubscriptionGrant({ ...grant, state: 'revoked', revokedAt: NOW_3, revokedBy: null }).ok,
    ).toBe(false);
    // live grants carry no revocation fields
    expect(
      parseSubscriptionGrant({ ...grant, state: 'granted', revokedAt: NOW_3, revokedBy: ACTOR_ADMIN }).ok,
    ).toBe(false);
    // unknown state
    expect(parseSubscriptionGrant({ ...grant, state: 'expired' }).ok).toBe(false);
  });

  it('parses grant versions fail-closed', () => {
    expect(unwrap(parseGrantVersion(1))).toBe(1);
    expect(unwrap(parseGrantVersion(7))).toBe(7);
    expect(isGrantVersion(1)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(parseGrantVersion(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    const failed = parseGrantVersion(0);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.expected).toBe(GRANT_VERSION_GRAMMAR);
    }
  });
});
