import { describe, expect, it } from 'vitest';
import { parseAppId, parseAppManifest, reviewAppManifest } from '@office/app-sdk';
import { isAppRelease, parseAppRelease, publishReleaseRecord } from './release';
import {
  adminActor,
  knownFixtureActions,
  rawManifestV1,
  rawManifestV2,
  T0,
  TENANT_A,
  unwrap,
  V1,
} from './test-support';
import { registerPublisher } from './publisher';
import { publisherIdOf } from './identity';

// OFF-027 marketplace — app releases: a release pins ONE validated manifest
// (through the SDK's reviewAppManifest), the record is immutable data, and
// the parse is fail-closed (strict keys + manifest/release consistency).
describe('marketplace app releases (OFF-027)', () => {
  const publisherId = publisherIdOf({
    tenantId: TENANT_A,
    displayName: 'publisher-01',
    apps: ['progress-recorder'],
  });

  /** The reviewed v1 manifest (the trusted form a release pins). */
  const manifestV1 = () =>
    unwrap(
      reviewAppManifest(rawManifestV1, {
        actions: knownFixtureActions(),
        apps: { versions: () => null },
      }),
    );

  const release = () =>
    publishReleaseRecord({
      manifest: manifestV1(),
      publisherId,
      tenantId: TENANT_A,
      publishedAt: T0,
      publishedBy: adminActor(),
    });

  it('pins the validated manifest verbatim with a derived release id', () => {
    const record = release();
    expect(record.kind).toBe('app-release');
    expect(record.appId).toBe('progress-recorder');
    expect(record.manifestVersion).toBe(V1);
    expect(record.manifest).toEqual(manifestV1());
    expect(record.publisherId).toBe(publisherId);
    expect(record.publishedAt).toBe(T0);
    expect(record.publishedBy).toEqual(adminActor());
    expect(record.releaseId.startsWith('office-rel-v1-')).toBe(true);
    expect(release().releaseId).toBe(release().releaseId);
  });

  it('derives distinct release ids per manifest version', () => {
    const manifestV2 = unwrap(
      reviewAppManifest(rawManifestV2, {
        actions: knownFixtureActions(),
        apps: { versions: () => null },
      }),
    );
    const other = publishReleaseRecord({
      manifest: manifestV2,
      publisherId,
      tenantId: TENANT_A,
      publishedAt: T0,
      publishedBy: adminActor(),
    });
    expect(other.releaseId).not.toBe(release().releaseId);
    expect(other.manifestVersion).toBe('1.5.0');
  });

  it('parses a release record round-trip and rejects malformed ones', () => {
    const record = release();
    expect(unwrap(parseAppRelease(record))).toEqual(record);
    expect(isAppRelease(record)).toBe(true);
    expect(parseAppRelease({ ...record, extra: true }).ok).toBe(false);
    expect(parseAppRelease({ ...record, manifestVersion: '9.9.9' }).ok).toBe(false);
    expect(parseAppRelease({ ...record, appId: 'timesheet-logger' }).ok).toBe(false);
    expect(parseAppRelease({ ...record, releaseId: 'office-rel-v1-nope' }).ok).toBe(false);
    expect(parseAppRelease(null).ok).toBe(false);
    expect(parseAppRelease([]).ok).toBe(false);
  });

  it('rejects a release whose pinned manifest is not the release itself', () => {
    const record = release();
    const manifestV2 = unwrap(
      reviewAppManifest(rawManifestV2, {
        actions: knownFixtureActions(),
        apps: { versions: () => null },
      }),
    );
    // the manifest describes a different version than the release claims
    expect(parseAppRelease({ ...record, manifest: manifestV2 }).ok).toBe(false);
    // the manifest describes a different app than the release claims
    const swappedApp = parseAppManifest({ ...rawManifestV1, appId: 'timesheet-logger' });
    expect(swappedApp.ok).toBe(true);
    if (swappedApp.ok) {
      expect(
        parseAppRelease({
          ...record,
          appId: 'timesheet-logger',
          manifest: swappedApp.value,
        }).ok,
      ).toBe(true);
      expect(parseAppRelease({ ...record, manifest: swappedApp.value }).ok).toBe(false);
    }
  });

  it('publishReleaseRecord throws loudly on an unvalidated manifest shape', () => {
    expect(() =>
      publishReleaseRecord({
        manifest: { kind: 'not-a-manifest' } as unknown as ReturnType<typeof manifestV1>,
        publisherId,
        tenantId: TENANT_A,
        publishedAt: T0,
        publishedBy: adminActor(),
      }),
    ).toThrow(TypeError);
  });

  it('the registered publisher key derives the same publisher id as the record', () => {
    const publisher = registerPublisher({
      tenantId: TENANT_A,
      displayName: 'publisher-01',
      apps: [unwrap(parseAppId('progress-recorder'))],
      registeredAt: T0,
      registeredBy: adminActor(),
    });
    expect(publisher.publisherId).toBe(publisherId);
  });
});
