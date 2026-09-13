// Office marketplace — the catalog (OFF-027).
//
// The queryable projection over published releases: the global app catalog
// (deterministic listing/detail lookups, versions in semver order via the
// SDK's `compareAppVersions`), the `AppCatalogSource` view the SDK's
// `reviewAppManifest` dependency validation consumes, and the tenant-scoped
// ENTITLED catalog (the catalog as a tenant may install it — the A12 query
// surface). Catalog entries are pure projections: they are recomputed from
// the immutable release records on every query and never stored, so the
// catalog can never drift from the releases it projects (freeze A11 —
// catalog metadata, never project truth).
import { compareAppVersions, satisfiesVersion } from '@office/app-sdk';
import type { AppCatalogSource, AppId, AppVersion } from '@office/app-sdk';
import type { AppRelease } from './release';
import type { Entitlement } from './entitlement';

/**
 * One catalog entry: the app's published versions (semver ascending) and
 * the display fields of its NEWEST release (the catalog always presents the
 * latest published surface; older releases remain installed/pinned through
 * the update/rollback flow, never re-cataloged).
 */
export interface CatalogEntry {
  /** The cataloged app. */
  readonly appId: AppId;
  /** The app's title (from its newest release's manifest). */
  readonly title: string;
  /** The app's description (from its newest release's manifest). */
  readonly description: string | null;
  /** The newest published version (the entry's headline). */
  readonly latestVersion: AppVersion;
  /** Every published version, in semver ascending order. */
  readonly versions: readonly AppVersion[];
  /** The publisher of the newest release. */
  readonly publisherId: string;
}

/**
 * One ENTITLED catalog entry: the catalog entry plus the tenant's ACTIVE
 * entitlements covering it — the tenant-scoped projection of the catalog
 * (which apps THIS tenant may install, and at which versions).
 */
export interface EntitledCatalogEntry {
  /** The cataloged app. */
  readonly appId: AppId;
  /** The app's title (from its newest release's manifest). */
  readonly title: string;
  /** The app's description (from its newest release's manifest). */
  readonly description: string | null;
  /** The newest published version. */
  readonly latestVersion: AppVersion;
  /** Every published version, in semver ascending order. */
  readonly versions: readonly AppVersion[];
  /** The tenant's ACTIVE entitlements over this app. */
  readonly entitlements: readonly Entitlement[];
}

/** The semver-descending comparator (newest first). */
const byVersionDescending = (a: AppVersion, b: AppVersion): number => -compareAppVersions(a, b);

/** Sort a version list semver ascending (returns a fresh array). */
const versionsAscending = (versions: readonly AppVersion[]): AppVersion[] =>
  [...versions].sort(compareAppVersions);

/**
 * The global catalog snapshot over published releases: one entry per app,
 * entries ordered by app id ascending, versions semver ascending, display
 * fields from each app's NEWEST release. Pure and deterministic: the same
 * release set always projects to the same snapshot.
 */
export function catalogSnapshotOf(releases: readonly AppRelease[]): readonly CatalogEntry[] {
  const byApp = new Map<string, AppRelease[]>();
  for (const release of releases) {
    const ofApp = byApp.get(release.appId) ?? [];
    ofApp.push(release);
    byApp.set(release.appId, ofApp);
  }
  const entries: CatalogEntry[] = [];
  const appIds = [...byApp.keys()].sort();
  for (const appId of appIds) {
    const ofApp = byApp.get(appId) ?? [];
    const newest = [...ofApp].sort((a, b) => byVersionDescending(a.manifestVersion, b.manifestVersion))[0];
    if (newest === undefined) continue;
    entries.push({
      appId: newest.appId,
      title: newest.manifest.title,
      description: newest.manifest.description,
      latestVersion: newest.manifestVersion,
      versions: versionsAscending(ofApp.map((release) => release.manifestVersion)),
      publisherId: newest.publisherId,
    });
  }
  return entries;
}

/**
 * The catalog detail of one app: its entry, or a typed 'not-found' failure
 * when no release of the app is published. Pure and deterministic.
 */
export function catalogEntryOf(
  releases: readonly AppRelease[],
  appId: AppId,
): CatalogEntry | null {
  const ofApp = releases.filter((release) => release.appId === appId);
  if (ofApp.length === 0) return null;
  const newest = [...ofApp].sort((a, b) =>
    byVersionDescending(a.manifestVersion, b.manifestVersion),
  )[0];
  if (newest === undefined) return null;
  return {
    appId: newest.appId,
    title: newest.manifest.title,
    description: newest.manifest.description,
    latestVersion: newest.manifestVersion,
    versions: versionsAscending(ofApp.map((release) => release.manifestVersion)),
    publisherId: newest.publisherId,
  };
}

/**
 * The `AppCatalogSource` view of the catalog (satisfies the SDK's port
 * shape structurally): the published contract versions of an app in semver
 * ascending order, or null when the app is unknown to the catalog. This is
 * the source the marketplace's own `publishRelease` intake feeds into
 * `reviewAppManifest`, so a release's app dependencies resolve against the
 * marketplace's real catalog.
 */
export function catalogSourceOf(releases: readonly AppRelease[]): AppCatalogSource {
  return {
    versions: (appId: AppId): readonly AppVersion[] | null => {
      const ofApp = releases.filter((release) => release.appId === appId);
      if (ofApp.length === 0) return null;
      return versionsAscending(ofApp.map((release) => release.manifestVersion));
    },
  };
}

/**
 * The tenant-scoped ENTITLED catalog over published releases and the
 * tenant's entitlements: every cataloged app the tenant holds at least one
 * ACTIVE entitlement for, with those entitlements attached. Pure and
 * deterministic: entries by app id ascending, entitlements in grant order.
 */
export function entitledCatalogOf(
  releases: readonly AppRelease[],
  entitlements: readonly Entitlement[],
  tenantId: string,
): readonly EntitledCatalogEntry[] {
  const snapshot = catalogSnapshotOf(releases);
  const entries: EntitledCatalogEntry[] = [];
  for (const entry of snapshot) {
    const active = entitlements.filter(
      (entitlement) =>
        entitlement.tenantId === tenantId &&
        entitlement.state === 'active' &&
        entitlement.appId === entry.appId,
    );
    if (active.length === 0) continue;
    entries.push({
      appId: entry.appId,
      title: entry.title,
      description: entry.description,
      latestVersion: entry.latestVersion,
      versions: entry.versions,
      entitlements: active,
    });
  }
  return entries;
}

/**
 * Which of the tenant's ACTIVE entitlements cover a given release version
 * (the install gate: no covering entitlement, no install).
 */
export function coveringEntitlements(
  entitlements: readonly Entitlement[],
  tenantId: string,
  appId: AppId,
  version: AppVersion,
): readonly Entitlement[] {
  return entitlements.filter(
    (entitlement) =>
      entitlement.tenantId === tenantId &&
      entitlement.state === 'active' &&
      entitlement.appId === appId &&
      satisfiesVersion(entitlement.versionRange, version),
  );
}
