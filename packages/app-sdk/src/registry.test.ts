import { describe, expect, it } from 'vitest';
import { createInMemoryAppRegistry } from './registry';
import { appVersion, appId } from './identity';
import { reviewAppManifest } from './validation';
import { parseAppManifest } from './manifest';
import { fakeActionSource } from './test-support';
import { SAMPLE_ACTION, SAMPLE_MANIFEST_RAW, unwrap } from './test-support';

// OFF-025 — the in-memory manifest registry: the deterministic reference
// store for tests (and the structural shape OFF-026/OFF-027 replace with
// real persistence). It satisfies the AppCatalogSource port structurally,
// so the dependency validation runs against it directly.

const sampleManifest = () => unwrap(parseAppManifest(SAMPLE_MANIFEST_RAW));

const otherManifest = (appId: string, version: string) =>
  unwrap(
    parseAppManifest({
      ...SAMPLE_MANIFEST_RAW,
      appId,
      manifestVersion: version,
      dependencies: [],
    }),
  );

describe('the in-memory app registry', () => {
  it('registers, finds, and lists manifests in registration order', () => {
    const registry = createInMemoryAppRegistry()
      .register(sampleManifest())
      .register(otherManifest('cost-insights', '2.1.0'))
      .register(otherManifest('cost-insights', '2.3.1'));
    expect(registry.manifests()).toStrictEqual([
      sampleManifest(),
      otherManifest('cost-insights', '2.1.0'),
      otherManifest('cost-insights', '2.3.1'),
    ]);
    expect(registry.find(appId('cost-insights'), appVersion('2.3.1'))).toStrictEqual(otherManifest('cost-insights', '2.3.1'));
    expect(registry.find(appId('cost-insights'), appVersion('2.0.0'))).toBeNull();
    expect(registry.find(appId('mystery-app'), appVersion('2.3.1'))).toBeNull();
  });

  it('exposes published versions per app and null for unknown apps (the catalog port)', () => {
    const registry = createInMemoryAppRegistry()
      .register(otherManifest('cost-insights', '2.1.0'))
      .register(otherManifest('cost-insights', '2.3.1'))
      .register(sampleManifest());
    expect(registry.versions(appId('cost-insights'))).toStrictEqual(['2.1.0', '2.3.1']);
    expect(registry.versions(appId('field-progress-tracker'))).toStrictEqual(['1.4.0']);
    expect(registry.versions(appId('mystery-app'))).toBeNull();
  });

  it('rejects duplicate (appId, manifestVersion) registrations loudly', () => {
    const registry = createInMemoryAppRegistry().register(sampleManifest());
    expect(() => registry.register(sampleManifest())).toThrow(TypeError);
    // a different version of the same app is fine
    expect(() => registry.register(otherManifest('field-progress-tracker', '1.5.0'))).not.toThrow();
  });

  it('serves as the app catalog of a full manifest review (structural satisfaction)', () => {
    const registry = createInMemoryAppRegistry()
      .register(otherManifest('cost-insights', '1.9.0'))
      .register(otherManifest('cost-insights', '2.3.1'));
    const review = reviewAppManifest(SAMPLE_MANIFEST_RAW, {
      actions: fakeActionSource([SAMPLE_ACTION]),
      apps: registry,
    });
    expect(review.ok).toBe(true);
    // the ^2.1.0 range is satisfied by 2.3.1 but not by 1.9.0 alone
    const onlyOld = createInMemoryAppRegistry().register(otherManifest('cost-insights', '1.9.0'));
    const rejected = reviewAppManifest(SAMPLE_MANIFEST_RAW, {
      actions: fakeActionSource([SAMPLE_ACTION]),
      apps: onlyOld,
    });
    expect(rejected.ok).toBe(false);
  });
});
