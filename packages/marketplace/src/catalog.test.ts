import { describe, expect, it } from 'vitest';
import { parseAppId, parseAppVersion, reviewAppManifest, versionRange } from '@office/app-sdk';
import { parseTimestamp } from '@office/contracts';
import {
  catalogEntryOf,
  catalogSnapshotOf,
  catalogSourceOf,
  coveringEntitlements,
  entitledCatalogOf,
} from './catalog';
import { publishReleaseRecord } from './release';
import { grantEntitlement, revokeEntitlement } from './entitlement';
import { publisherIdOf } from './identity';
import type { AppRelease } from './release';
import type { Entitlement } from './entitlement';
import {
  adminActor,
  knownFixtureActions,
  operatorActor,
  rawManifestPatch,
  rawManifestV1,
  rawManifestV2,
  T0,
  TENANT_A,
  TENANT_B,
  unwrap,
} from './test-support';

// OFF-027 marketplace — the catalog projections: deterministic listing and
// detail lookups over the immutable releases (versions in semver order),
// the AppCatalogSource view (the SDK port shape), and the tenant-scoped
// entitled catalog.
describe('marketplace catalog (OFF-027)', () => {
  const publisherId = publisherIdOf({
    tenantId: TENANT_A,
    displayName: 'publisher-01',
    apps: ['progress-recorder'],
  });

  const reviewed = (raw: unknown) =>
    unwrap(
      reviewAppManifest(raw, { actions: knownFixtureActions(), apps: { versions: () => null } }),
    );

  const releases = (): AppRelease[] => {
    const published: AppRelease[] = [];
    for (const manifest of [rawManifestV1, rawManifestV2, rawManifestPatch].map(reviewed)) {
      published.push(
        publishReleaseRecord({
          manifest,
          publisherId,
          tenantId: TENANT_A,
          publishedAt: T0,
          publishedBy: adminActor(),
        }),
      );
    }
    return published;
  };

  it('projects one entry per app with versions in semver ascending order', () => {
    const snapshot = catalogSnapshotOf(releases());
    expect(snapshot).toHaveLength(1);
    const entry = snapshot[0];
    expect(entry?.appId).toBe('progress-recorder');
    expect(entry?.versions).toEqual(['1.4.0', '1.4.1', '1.5.0']);
    expect(entry?.latestVersion).toBe('1.5.0');
    expect(entry?.title).toBe('Progress Recorder');
    expect(entry?.description).toBe('Records daily field progress and reads cost context.');
    expect(entry?.publisherId).toBe(publisherId);
  });

  it('orders entries by app id ascending across multiple apps', () => {
    const other = reviewed({ ...rawManifestV1, appId: 'aaa-timesheet-logger' });
    const all: AppRelease[] = [
      ...releases(),
      publishReleaseRecord({
        manifest: other,
        publisherId,
        tenantId: TENANT_A,
        publishedAt: T0,
        publishedBy: adminActor(),
      }),
    ];
    const snapshot = catalogSnapshotOf(all);
    expect(snapshot.map((entry) => entry.appId)).toEqual([
      'aaa-timesheet-logger',
      'progress-recorder',
    ]);
  });

  it('is a pure deterministic projection: same releases, same snapshot', () => {
    expect(catalogSnapshotOf(releases())).toEqual(catalogSnapshotOf(releases()));
  });

  it('catalogEntryOf resolves an app detail and returns null for unknown apps', () => {
    const entry = catalogEntryOf(releases(), unwrap(parseAppId('progress-recorder')));
    expect(entry?.latestVersion).toBe('1.5.0');
    expect(catalogEntryOf(releases(), unwrap(parseAppId('unknown-app')))).toBeNull();
  });

  it('catalogSourceOf satisfies the SDK AppCatalogSource port shape', () => {
    const source = catalogSourceOf(releases());
    expect(source.versions(unwrap(parseAppId('progress-recorder')))).toEqual([
      '1.4.0',
      '1.4.1',
      '1.5.0',
    ]);
    expect(source.versions(unwrap(parseAppId('unknown-app')))).toBeNull();
  });

  it('entitledCatalogOf lists only apps the tenant holds ACTIVE entitlements for', () => {
    const entitlements: Entitlement[] = [
      grantEntitlement({
        tenantId: TENANT_A,
        appId: unwrap(parseAppId('progress-recorder')),
        versionRange: versionRange('^1.4.0'),
        grantOrdinal: 1,
        grantedAt: T0,
        grantedBy: adminActor(),
      }),
      grantEntitlement({
        tenantId: TENANT_B,
        appId: unwrap(parseAppId('progress-recorder')),
        versionRange: versionRange('^1.5.0'),
        grantOrdinal: 1,
        grantedAt: T0,
        grantedBy: adminActor(),
      }),
    ];
    const forA = entitledCatalogOf(releases(), entitlements, TENANT_A);
    expect(forA).toHaveLength(1);
    expect(forA[0]?.appId).toBe('progress-recorder');
    expect(forA[0]?.entitlements).toHaveLength(1);
    expect(forA[0]?.entitlements[0]?.tenantId).toBe(TENANT_A);

    const revoked = revokeEntitlement(
      entitlements[0] as Entitlement,
      { at: unwrap(parseTimestamp('2026-09-12T12:00:00.000Z')), by: operatorActor() },
    );
    const afterRevoke = entitledCatalogOf(releases(), [revoked, entitlements[1] as Entitlement], TENANT_A);
    expect(afterRevoke).toHaveLength(0);
  });

  it('coveringEntitlements resolves the ACTIVE entitlements that cover a release version', () => {
    const wide = grantEntitlement({
      tenantId: TENANT_A,
      appId: unwrap(parseAppId('progress-recorder')),
      versionRange: versionRange('^1.4.0'),
      grantOrdinal: 1,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    const exact = grantEntitlement({
      tenantId: TENANT_A,
      appId: unwrap(parseAppId('progress-recorder')),
      versionRange: versionRange('1.5.0'),
      grantOrdinal: 1,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    const other = grantEntitlement({
      tenantId: TENANT_B,
      appId: unwrap(parseAppId('progress-recorder')),
      versionRange: versionRange('^1.4.0'),
      grantOrdinal: 1,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    const all: Entitlement[] = [wide, exact, other];
    const covering = coveringEntitlements(
      all,
      TENANT_A,
      unwrap(parseAppId('progress-recorder')),
      unwrap(parseAppVersion('1.5.0')),
    );
    expect(covering).toHaveLength(2);
    const none = coveringEntitlements(
      all,
      TENANT_A,
      unwrap(parseAppId('progress-recorder')),
      unwrap(parseAppVersion('2.0.0')),
    );
    expect(none).toHaveLength(0);
  });
});
