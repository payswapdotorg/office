import { describe, expect, it } from 'vitest';
import { parseAppVersion, versionRange } from '@office/app-sdk';
import { parseTimestamp } from '@office/contracts';
import {
  entitlesRelease,
  grantEntitlement,
  isEntitlement,
  parseEntitlement,
  parseEntitlementState,
  revokeEntitlement,
  versionRangeKey,
} from './entitlement';
import {
  adminActor,
  operatorActor,
  PROGRESS_APP_ID,
  T0,
  TENANT_A,
  unwrap,
  V1,
  V2,
} from './test-support';

// OFF-027 marketplace — tenant entitlements: the explicit, typed, revocable
// install permission over an app release range; terminal idempotent
// revocation; and the fail-closed parse.
describe('marketplace entitlements (OFF-027)', () => {
  const entitlement = () =>
    grantEntitlement({
      tenantId: TENANT_A,
      appId: PROGRESS_APP_ID,
      versionRange: versionRange('^1.4.0'),
      grantOrdinal: 1,
      grantedAt: T0,
      grantedBy: adminActor(),
    });

  it('grants an active entitlement with a derived id and the range verbatim', () => {
    const record = entitlement();
    expect(record.kind).toBe('app-entitlement');
    expect(record.state).toBe('active');
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.appId).toBe(PROGRESS_APP_ID);
    expect(record.versionRange).toEqual({ kind: 'caret', version: V1 });
    expect(record.revokedAt).toBeNull();
    expect(record.revokedBy).toBeNull();
    expect(record.entitlementId.startsWith('office-etl-v1-')).toBe(true);
  });

  it('derives distinct ids per grant ordinal (revocation never resurrects)', () => {
    const first = entitlement();
    const second = grantEntitlement({
      tenantId: TENANT_A,
      appId: PROGRESS_APP_ID,
      versionRange: versionRange('^1.4.0'),
      grantOrdinal: 2,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    expect(first.entitlementId).not.toBe(second.entitlementId);
  });

  it('revokes terminally and idempotently, preserving the original provenance', () => {
    const record = entitlement();
    const revoked = revokeEntitlement(record, {
      at: unwrap(parseTimestamp('2026-09-12T11:00:00.000Z')),
      by: operatorActor(),
    });
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokedAt).toBe('2026-09-12T11:00:00.000Z');
    const again = revokeEntitlement(revoked, {
      at: unwrap(parseTimestamp('2026-09-12T12:00:00.000Z')),
      by: adminActor(),
    });
    expect(again).toBe(revoked);
    expect(again.revokedAt).toBe('2026-09-12T11:00:00.000Z');
  });

  it('entitlesRelease follows the range while active and stops when revoked', () => {
    const record = entitlement();
    expect(entitlesRelease(record, V1)).toBe(true);
    expect(entitlesRelease(record, V2)).toBe(true);
    expect(entitlesRelease(record, unwrap(parseAppVersion('2.0.0')))).toBe(false);
    const revoked = revokeEntitlement(record, { at: T0, by: operatorActor() });
    expect(entitlesRelease(revoked, V1)).toBe(false);
  });

  it('exact ranges cover exactly one version', () => {
    const exact = grantEntitlement({
      tenantId: TENANT_A,
      appId: PROGRESS_APP_ID,
      versionRange: versionRange('1.5.0'),
      grantOrdinal: 1,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    expect(entitlesRelease(exact, V2)).toBe(true);
    expect(entitlesRelease(exact, V1)).toBe(false);
  });

  it('versionRangeKey renders the canonical derivation form', () => {
    expect(versionRangeKey(versionRange('^1.4.0'))).toBe('^1.4.0');
    expect(versionRangeKey(versionRange('1.5.0'))).toBe('1.5.0');
  });

  it('parses an entitlement record round-trip and rejects malformed ones', () => {
    const record = entitlement();
    expect(unwrap(parseEntitlement(record))).toEqual(record);
    expect(isEntitlement(record)).toBe(true);
    expect(parseEntitlement({ ...record, extra: 1 }).ok).toBe(false);
    expect(parseEntitlement({ ...record, state: 'expired' }).ok).toBe(false);
    expect(parseEntitlement({ ...record, appId: 'bad app' }).ok).toBe(false);
    expect(parseEntitlement({ ...record, versionRange: '~1.4.0' }).ok).toBe(false);
    expect(parseEntitlement({ ...record, entitlementId: 'office-etl-v1-short' }).ok).toBe(false);
    expect(parseEntitlement(undefined).ok).toBe(false);
  });

  it('rejects state/provenance inconsistencies fail-closed', () => {
    const record = entitlement();
    const revoked = revokeEntitlement(record, { at: T0, by: operatorActor() });
    expect(
      parseEntitlement({ ...record, revokedAt: T0, revokedBy: operatorActor() }).ok,
    ).toBe(false);
    expect(parseEntitlement({ ...revoked, revokedAt: null, revokedBy: null }).ok).toBe(false);
    expect(parseEntitlement({ ...revoked, revokedBy: null }).ok).toBe(false);
  });

  it('parses entitlement states fail-closed', () => {
    expect(unwrap(parseEntitlementState('active'))).toBe('active');
    expect(unwrap(parseEntitlementState('revoked'))).toBe('revoked');
    expect(parseEntitlementState('suspended').ok).toBe(false);
    expect(parseEntitlementState(null).ok).toBe(false);
  });

  it('grantEntitlement throws loudly on an invalid logical key', () => {
    expect(() =>
      grantEntitlement({
        tenantId: TENANT_A,
        appId: PROGRESS_APP_ID,
        versionRange: versionRange('^1.4.0'),
        grantOrdinal: -1,
        grantedAt: T0,
        grantedBy: adminActor(),
      }),
    ).toThrow(TypeError);
  });
});
