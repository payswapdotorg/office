import { describe, expect, it } from 'vitest';
import {
  auditRecordIdOf,
  entitlementIdOf,
  formatPublisherId,
  installationLinkIdOf,
  parseAuditRecordId,
  parseEntitlementId,
  parseInstallationLinkId,
  parsePublisherId,
  parseReleaseId,
  parseUpdateId,
  publisherIdOf,
  releaseIdOf,
  updateIdOf,
} from './identity';
import { TENANT_A, TENANT_B, unwrap, V1, V2 } from './test-support';

// OFF-027 marketplace — the branded identity vocabulary: every id parses
// fail-closed against its grammar, every derivation is DETERMINISTIC (the
// same logical key always reproduces the same identity — the run-twice
// audit-ledger determinism), and distinct logical keys never collide.
describe('marketplace identity vocabulary (OFF-027)', () => {
  it('parses a valid derived publisher id and rejects malformed ones', () => {
    const id = publisherIdOf({
      tenantId: TENANT_A,
      displayName: 'publisher-01',
      apps: ['progress-recorder'],
    });
    expect(unwrap(parsePublisherId(id))).toBe(id);
    expect(parsePublisherId('office-pub-v1-short').ok).toBe(false);
    expect(parsePublisherId('office-rel-v1-0123456789abcdef0123456789abcdef').ok).toBe(false);
    expect(parsePublisherId('office-pub-v1-ABCDEF0123456789abcdef0123456789').ok).toBe(false);
    expect(parsePublisherId(123).ok).toBe(false);
    expect(parsePublisherId(null).ok).toBe(false);
  });

  it('derives the same publisher id from the same logical key, regardless of app order', () => {
    const a = publisherIdOf({
      tenantId: TENANT_A,
      displayName: 'publisher-01',
      apps: ['progress-recorder', 'timesheet-logger'],
    });
    const b = publisherIdOf({
      tenantId: TENANT_A,
      displayName: 'publisher-01',
      apps: ['timesheet-logger', 'progress-recorder'],
    });
    expect(a).toBe(b);
  });

  it('derives distinct publisher ids for distinct keys', () => {
    const a = publisherIdOf({
      tenantId: TENANT_A,
      displayName: 'publisher-01',
      apps: ['progress-recorder'],
    });
    const b = publisherIdOf({
      tenantId: TENANT_B,
      displayName: 'publisher-01',
      apps: ['progress-recorder'],
    });
    const c = publisherIdOf({
      tenantId: TENANT_A,
      displayName: 'publisher-02',
      apps: ['progress-recorder'],
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('formatPublisherId throws loudly on an invalid id', () => {
    expect(() => formatPublisherId('not-an-id')).toThrow(TypeError);
  });

  it('parses a valid derived release id and rejects malformed ones', () => {
    const id = releaseIdOf({ appId: 'progress-recorder', manifestVersion: V1 });
    expect(unwrap(parseReleaseId(id))).toBe(id);
    expect(parseReleaseId('office-rel-v2-0123456789abcdef0123456789abcdef').ok).toBe(false);
    expect(parseReleaseId('office-rel-v1-').ok).toBe(false);
    expect(parseReleaseId('x').ok).toBe(false);
  });

  it('derives release ids keyed on (app, manifest version) deterministically', () => {
    const a = releaseIdOf({ appId: 'progress-recorder', manifestVersion: V1 });
    const b = releaseIdOf({ appId: 'progress-recorder', manifestVersion: V1 });
    const c = releaseIdOf({ appId: 'progress-recorder', manifestVersion: V2 });
    const d = releaseIdOf({ appId: 'timesheet-logger', manifestVersion: V1 });
    expect(a).toBe(b);
    expect(new Set([a, c, d]).size).toBe(3);
  });

  it('parses a valid derived entitlement id and rejects malformed ones', () => {
    const id = entitlementIdOf({
      tenantId: TENANT_A,
      appId: 'progress-recorder',
      versionRange: '^1.4.0',
      ordinal: 1,
    });
    expect(unwrap(parseEntitlementId(id))).toBe(id);
    expect(parseEntitlementId('office-etl-v1-0').ok).toBe(false);
    expect(parseEntitlementId('office-etl-v1-UPPERCASE0123456789abcdef').ok).toBe(false);
  });

  it('derives distinct entitlement ids per grant ordinal (re-grant after revocation)', () => {
    const key = {
      tenantId: TENANT_A,
      appId: 'progress-recorder',
      versionRange: '^1.4.0',
    };
    const first = entitlementIdOf({ ...key, ordinal: 1 });
    const second = entitlementIdOf({ ...key, ordinal: 2 });
    const same = entitlementIdOf({ ...key, ordinal: 1 });
    expect(first).toBe(same);
    expect(first).not.toBe(second);
  });

  it('entitlementIdOf throws loudly on a non-integer ordinal', () => {
    expect(() =>
      entitlementIdOf({
        tenantId: TENANT_A,
        appId: 'progress-recorder',
        versionRange: '^1.4.0',
        ordinal: 1.5,
      }),
    ).toThrow(TypeError);
    expect(() =>
      entitlementIdOf({
        tenantId: TENANT_A,
        appId: 'progress-recorder',
        versionRange: '^1.4.0',
        ordinal: -1,
      }),
    ).toThrow(TypeError);
  });

  it('parses a valid derived installation-link id and rejects malformed ones', () => {
    const id = installationLinkIdOf({
      tenantId: TENANT_A,
      installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
    });
    expect(unwrap(parseInstallationLinkId(id))).toBe(id);
    expect(parseInstallationLinkId('office-lnk-v1-0123456789abcde').ok).toBe(false);
  });

  it('derives distinct link ids across installations of the same tenant', () => {
    const a = installationLinkIdOf({
      tenantId: TENANT_A,
      installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
    });
    const b = installationLinkIdOf({
      tenantId: TENANT_A,
      installationId: 'office-ent-v1-9d8c7b6a5f4e3d2c1b0a9988776655443322',
    });
    expect(a).not.toBe(b);
  });

  it('derives link ids keyed on (tenant, installation) — no cross-tenant collision', () => {
    const a = installationLinkIdOf({
      tenantId: TENANT_A,
      installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
    });
    const b = installationLinkIdOf({
      tenantId: TENANT_B,
      installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
    });
    expect(a).not.toBe(b);
  });

  it('parses a valid derived update id and rejects malformed ones', () => {
    const id = updateIdOf({
      linkId: 'office-lnk-v1-0123456789abcdef0123456789abcdef',
      fromReleaseId: 'office-rel-v1-0123456789abcdef0123456789abcdef',
      toReleaseId: 'office-rel-v1-fedcba9876543210fedcba9876543210',
    });
    expect(unwrap(parseUpdateId(id))).toBe(id);
    expect(parseUpdateId('office-upd-v1-zzz').ok).toBe(false);
  });

  it('derives update ids keyed on the (link, from, to) triple deterministically', () => {
    const key = {
      linkId: 'office-lnk-v1-0123456789abcdef0123456789abcdef',
      fromReleaseId: 'office-rel-v1-0123456789abcdef0123456789abcdef',
      toReleaseId: 'office-rel-v1-fedcba9876543210fedcba9876543210',
    };
    expect(updateIdOf(key)).toBe(updateIdOf(key));
    expect(updateIdOf(key)).not.toBe(
      updateIdOf({ ...key, toReleaseId: key.fromReleaseId }),
    );
  });

  it('parses a valid derived audit record id and rejects malformed ones', () => {
    const id = auditRecordIdOf({
      transition: 'release-published',
      subject: 'office-rel-v1-0123456789abcdef0123456789abcdef',
      at: '2026-09-12T10:15:31.000Z',
    });
    expect(unwrap(parseAuditRecordId(id))).toBe(id);
    expect(parseAuditRecordId('office-mka-v1-####').ok).toBe(false);
  });

  it('derives audit record ids keyed on (transition, subject, instant) deterministically', () => {
    const key = {
      transition: 'release-published',
      subject: 'office-rel-v1-0123456789abcdef0123456789abcdef',
      at: '2026-09-12T10:15:31.000Z',
    };
    expect(auditRecordIdOf(key)).toBe(auditRecordIdOf(key));
    expect(auditRecordIdOf(key)).not.toBe(auditRecordIdOf({ ...key, at: '2026-09-12T10:15:32.000Z' }));
    expect(auditRecordIdOf(key)).not.toBe(
      auditRecordIdOf({ ...key, transition: 'entitlement-granted' }),
    );
  });

  it('the branded id families never collide with each other', () => {
    const ids = [
      publisherIdOf({ tenantId: TENANT_A, displayName: 'x', apps: ['progress-recorder'] }),
      releaseIdOf({ appId: 'progress-recorder', manifestVersion: V1 }),
      entitlementIdOf({
        tenantId: TENANT_A,
        appId: 'progress-recorder',
        versionRange: '^1.4.0',
        ordinal: 1,
      }),
      installationLinkIdOf({
        tenantId: TENANT_A,
        installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
      }),
      updateIdOf({
        linkId: 'office-lnk-v1-0123456789abcdef0123456789abcdef',
        fromReleaseId: 'office-rel-v1-0123456789abcdef0123456789abcdef',
        toReleaseId: 'office-rel-v1-fedcba9876543210fedcba9876543210',
      }),
      auditRecordIdOf({
        transition: 'release-published',
        subject: 'office-rel-v1-0123456789abcdef0123456789abcdef',
        at: '2026-09-12T10:15:31.000Z',
      }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
