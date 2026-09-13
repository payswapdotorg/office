// Office app-sdk — the in-memory manifest registry (OFF-025).
//
// The deterministic in-memory reference of the app registry the SDK ships
// for tests (and the shape OFF-026/OFF-027 replace with the real
// persistence-backed stores): it holds ALREADY-VALIDATED manifests — the
// caller runs parseAppManifest + validateAppManifest first; registration
// enforces uniqueness of (appId, manifestVersion) with a loud TypeError,
// never a silent override of one app release by another. The registry
// satisfies AppCatalogSource structurally (versions(appId) → the published
// contract versions, or null for an unknown app), so it plugs directly
// into reviewAppManifest's dependency validation.
import type { AppId, AppVersion } from './identity';
import type { AppManifest } from './manifest';

/**
 * The registry of validated app manifests: the test/marketplace surface for
 * storing and resolving app releases by (appId, manifestVersion).
 */
export interface AppRegistry {
  /** Register a validated manifest; duplicate (appId, version) is a loud TypeError. */
  register(manifest: AppManifest): AppRegistry;
  /** The registered manifest of an exact (appId, manifestVersion), or null. */
  find(appId: AppId, manifestVersion: AppVersion): AppManifest | null;
  /** The published contract versions of an app, or null when the app is unknown. */
  versions(appId: AppId): readonly AppVersion[] | null;
  /** Every registered manifest, in registration order. */
  manifests(): readonly AppManifest[];
}

/**
 * Create the in-memory app manifest registry. Deterministic: registration
 * order is preserved, lookups are pure map reads, no clock, no randomness.
 * `register` returns the registry itself so registrations can chain.
 */
export function createInMemoryAppRegistry(): AppRegistry {
  const byKey = new Map<string, AppManifest>();
  const byApp = new Map<string, AppVersion[]>();
  const ordered: AppManifest[] = [];
  const registry: AppRegistry = {
    register: (manifest) => {
      const key = `${manifest.appId}@${manifest.manifestVersion}`;
      if (byKey.has(key)) {
        throw new TypeError(`duplicate app manifest registration for '${key}'`);
      }
      byKey.set(key, manifest);
      const versions = byApp.get(manifest.appId) ?? [];
      versions.push(manifest.manifestVersion);
      byApp.set(manifest.appId, versions);
      ordered.push(manifest);
      return registry;
    },
    find: (appId, manifestVersion) => byKey.get(`${appId}@${manifestVersion}`) ?? null,
    versions: (appId) => {
      const versions = byApp.get(appId);
      return versions === undefined ? null : [...versions];
    },
    manifests: () => [...ordered],
  };
  return registry;
}
