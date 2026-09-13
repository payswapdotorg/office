import { describe, expect, it } from 'vitest';
import {
  appManifest,
  isAppDependency,
  isAppManifest,
  parseAppDependency,
  parseAppManifest,
} from './manifest';
import { SAMPLE_MANIFEST, SAMPLE_MANIFEST_RAW, unwrap } from './test-support';
import { appVersion, compareAppVersions } from './identity';
import { CURRENT_SCHEMA_VERSION } from '@office/contracts';

// OFF-025 — the AppManifest structural parse: versioned (schema version +
// manifest version), strict keys, every field validated, and manifest-level
// uniqueness rules. The malformed-manifest acceptance matrix lives in
// malformed.test.ts; this suite pins the structural surface.

// Deterministic deep clone of fixture data (mutable records for mutation).
const clone = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

describe('the valid sample manifest', () => {
  it('parses unchanged (deep round trip)', () => {
    const parsed = unwrap(parseAppManifest(SAMPLE_MANIFEST_RAW));
    // The parse normalizes exactly one field: a dependency's version range
    // ('^2.1.0' → { kind: 'caret', version: '2.1.0' }); everything else is
    // byte-identical to the raw — SAMPLE_MANIFEST is that typed oracle.
    expect(parsed).toStrictEqual(SAMPLE_MANIFEST);
    expect(unwrap(parseAppManifest(clone(SAMPLE_MANIFEST_RAW)))).toStrictEqual(parsed);
    // The typed form itself re-parses (the round trip is idempotent).
    expect(isAppManifest(parsed)).toBe(true);
    expect(isAppManifest(SAMPLE_MANIFEST_RAW)).toBe(true);
    expect(isAppManifest(clone(SAMPLE_MANIFEST_RAW))).toBe(true);
  });

  it('is versioned twice: schema version and manifest version', () => {
    const parsed = unwrap(parseAppManifest(SAMPLE_MANIFEST_RAW));
    expect(parsed.schemaVersion).toBe('1.0.0');
    expect(parsed.manifestVersion).toBe('1.4.0');
    expect(compareAppVersions(parsed.manifestVersion, appVersion('1.4.0'))).toBe(0);
  });
});

describe('the trusted manifest builder', () => {
  it('composes from parts, injecting kind/schemaVersion/description defaults', () => {
    const parsed = unwrap(parseAppManifest(SAMPLE_MANIFEST_RAW));
    // explicit parts round-trip through the builder unchanged
    const built = appManifest({
      appId: parsed.appId,
      manifestVersion: parsed.manifestVersion,
      title: parsed.title,
      description: parsed.description,
      schemaVersion: parsed.schemaVersion,
      permissions: parsed.permissions,
      bindings: parsed.bindings,
      subscriptions: parsed.subscriptions,
      uiExtensions: parsed.uiExtensions,
      dependencies: parsed.dependencies,
    });
    expect(built).toStrictEqual(parsed);

    // omitted kind/schemaVersion/description are injected with their defaults
    const defaulted = appManifest({
      appId: parsed.appId,
      manifestVersion: parsed.manifestVersion,
      title: parsed.title,
      permissions: parsed.permissions,
      bindings: parsed.bindings,
      subscriptions: parsed.subscriptions,
      uiExtensions: parsed.uiExtensions,
      dependencies: parsed.dependencies,
    });
    expect(defaulted.description).toBeNull();
    expect(defaulted.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(defaulted.kind).toBe('app-manifest');
  });

  it('fails loud on invalid parts (never a silent repair)', () => {
    const parsed = unwrap(parseAppManifest(SAMPLE_MANIFEST_RAW));
    const [first] = parsed.permissions;
    if (first === undefined) throw new Error('fixture must declare permissions');
    // a duplicate permission declaration is type-valid data the parse rejects
    expect(() =>
      appManifest({
        appId: parsed.appId,
        manifestVersion: parsed.manifestVersion,
        title: parsed.title,
        permissions: [...parsed.permissions, first],
        bindings: parsed.bindings,
        subscriptions: parsed.subscriptions,
        uiExtensions: parsed.uiExtensions,
        dependencies: parsed.dependencies,
      }),
    ).toThrow(TypeError);
  });
});

describe('field-level structural rejections (every field)', () => {
  const cases: readonly { readonly name: string; readonly mutate: (raw: Record<string, unknown>) => void }[] = [
    { name: 'kind', mutate: (raw) => { raw['kind'] = 'manifest'; } },
    { name: 'kind missing', mutate: (raw) => { delete raw['kind']; } },
    { name: 'schemaVersion unknown', mutate: (raw) => { raw['schemaVersion'] = '2.0.0'; } },
    { name: 'schemaVersion malformed', mutate: (raw) => { raw['schemaVersion'] = '1.0'; } },
    { name: 'schemaVersion missing', mutate: (raw) => { delete raw['schemaVersion']; } },
    { name: 'appId malformed', mutate: (raw) => { raw['appId'] = 'Field Progress'; } },
    { name: 'appId wildcard', mutate: (raw) => { raw['appId'] = '*'; } },
    { name: 'appId missing', mutate: (raw) => { delete raw['appId']; } },
    { name: 'manifestVersion bad version', mutate: (raw) => { raw['manifestVersion'] = '1.4'; } },
    { name: 'manifestVersion leading zero', mutate: (raw) => { raw['manifestVersion'] = '01.4.0'; } },
    { name: 'manifestVersion missing', mutate: (raw) => { delete raw['manifestVersion']; } },
    { name: 'title empty', mutate: (raw) => { raw['title'] = ''; } },
    { name: 'title too long', mutate: (raw) => { raw['title'] = 'x'.repeat(201); } },
    { name: 'title wrong type', mutate: (raw) => { raw['title'] = 42; } },
    { name: 'title missing', mutate: (raw) => { delete raw['title']; } },
    { name: 'description too long', mutate: (raw) => { raw['description'] = 'x'.repeat(2001); } },
    { name: 'description wrong type', mutate: (raw) => { raw['description'] = 7; } },
    { name: 'permissions not an array', mutate: (raw) => { raw['permissions'] = 'all'; } },
    { name: 'permissions element malformed', mutate: (raw) => { raw['permissions'] = [{ kind: 'app-permission' }]; } },
    { name: 'permissions missing', mutate: (raw) => { delete raw['permissions']; } },
    { name: 'bindings not an array', mutate: (raw) => { raw['bindings'] = {}; } },
    { name: 'bindings element malformed', mutate: (raw) => { raw['bindings'] = [{ kind: 'command-binding' }]; } },
    { name: 'bindings missing', mutate: (raw) => { delete raw['bindings']; } },
    { name: 'subscriptions not an array', mutate: (raw) => { raw['subscriptions'] = null; } },
    { name: 'subscriptions element malformed', mutate: (raw) => { raw['subscriptions'] = ['work.progressRecorded']; } },
    { name: 'subscriptions missing', mutate: (raw) => { delete raw['subscriptions']; } },
    { name: 'uiExtensions not an array', mutate: (raw) => { raw['uiExtensions'] = 'panel'; } },
    { name: 'uiExtensions element malformed', mutate: (raw) => { raw['uiExtensions'] = [{ extensionPoint: 'project.overview.panel' }]; } },
    { name: 'uiExtensions missing', mutate: (raw) => { delete raw['uiExtensions']; } },
    { name: 'dependencies not an array', mutate: (raw) => { raw['dependencies'] = 'cost-insights'; } },
    { name: 'dependencies element malformed', mutate: (raw) => { raw['dependencies'] = [{ appId: 'cost-insights' }]; } },
    { name: 'dependencies missing', mutate: (raw) => { delete raw['dependencies']; } },
    { name: 'unknown root key', mutate: (raw) => { raw['entrypoint'] = 'main.js'; } },
    { name: 'unknown root key (code)', mutate: (raw) => { raw['code'] = 'module.exports = 1'; } },
  ];

  it('rejects every malformed variant fail-closed with a typed error', () => {
    for (const { name, mutate } of cases) {
      const raw = clone(SAMPLE_MANIFEST_RAW);
      mutate(raw);
      const result = parseAppManifest(raw);
      expect(result.ok, `manifest case '${name}'`).toBe(false);
      if (!result.ok) {
        expect(typeof result.error.code).toBe('string');
        expect(typeof result.error.path).toBe('string');
        expect(typeof result.error.expected).toBe('string');
        expect(typeof result.error.received).toBe('string');
      }
      expect(isAppManifest(raw)).toBe(false);
    }
  });

  it('rejects non-object roots', () => {
    for (const bad of [null, undefined, 42, 'manifest', [], true]) {
      expect(parseAppManifest(bad).ok, `root ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('rejects an unknown schema version with the typed unknown-schema-version code', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    raw['schemaVersion'] = '2.0.0';
    const result = parseAppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-schema-version');
      expect(result.error.path).toBe('schemaVersion');
    }
  });
});

describe('manifest-level uniqueness rules', () => {
  it('rejects duplicate permission declarations per (capability, scope kind)', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    (raw['permissions'] as unknown[]).push({
      kind: 'app-permission',
      capability: 'work.write',
      scopeKind: 'project',
      version: 2,
    });
    const result = parseAppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('permissions[2]');
    }
  });

  it('allows the same capability at different scope kinds', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    (raw['permissions'] as unknown[]).push({
      kind: 'app-permission',
      capability: 'work.write',
      scopeKind: 'tenant',
      version: 1,
    });
    expect(parseAppManifest(raw).ok).toBe(true);
  });

  it('rejects duplicate bindings per command name', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    (raw['bindings'] as unknown[]).push((raw['bindings'] as unknown[])[0]);
    const result = parseAppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe('bindings[1]');
    }
  });

  it('rejects duplicate subscriptions per event name', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    (raw['subscriptions'] as unknown[]).push({
      kind: 'event-subscription',
      eventName: 'work.progressRecorded',
      filter: { kind: 'all' },
    });
    const result = parseAppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe('subscriptions[1]');
    }
  });

  it('rejects duplicate view ids across extensions', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    (raw['uiExtensions'] as unknown[]).push({
      kind: 'ui-extension',
      extensionPoint: 'project.cost.panel',
      view: {
        kind: 'view',
        viewId: 'progress-summary',
        title: 'Progress (cost)',
        elements: [{ kind: 'text', text: 'A second view reusing the id.' }],
      },
    });
    const result = parseAppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe('uiExtensions[1]');
    }
  });

  it('rejects duplicate dependencies per app id', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    (raw['dependencies'] as unknown[]).push({
      kind: 'app-dependency',
      appId: 'cost-insights',
      versionRange: '3.0.0',
    });
    const result = parseAppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe('dependencies[1]');
    }
  });

  it('rejects a self-dependency', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW);
    (raw['dependencies'] as unknown[])[0] = {
      kind: 'app-dependency',
      appId: 'field-progress-tracker',
      versionRange: '^1.0.0',
    };
    const result = parseAppManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.received).toContain('self-dependency');
    }
  });
});

describe('app dependencies (AppDependency)', () => {
  it('parses exact and caret ranges', () => {
    expect(
      unwrap(parseAppDependency({ kind: 'app-dependency', appId: 'cost-insights', versionRange: '^2.1.0' })),
    ).toStrictEqual({ kind: 'app-dependency', appId: 'cost-insights', versionRange: { kind: 'caret', version: '2.1.0' } });
    expect(
      unwrap(parseAppDependency({ kind: 'app-dependency', appId: 'cost-insights', versionRange: '2.1.0' })),
    ).toStrictEqual({ kind: 'app-dependency', appId: 'cost-insights', versionRange: { kind: 'exact', version: '2.1.0' } });
    expect(isAppDependency({ kind: 'app-dependency', appId: 'cost-insights', versionRange: '2.1.0' })).toBe(true);
  });

  it('rejects malformed dependencies fail-closed', () => {
    for (const bad of [
      null,
      'dependency',
      { kind: 'dependency', appId: 'cost-insights', versionRange: '2.1.0' },
      { kind: 'app-dependency', appId: 'Cost Insights', versionRange: '2.1.0' },
      { kind: 'app-dependency', appId: 'cost-insights', versionRange: '~2.1.0' },
      { kind: 'app-dependency', appId: 'cost-insights', versionRange: '*' },
      { kind: 'app-dependency', appId: 'cost-insights' },
      { kind: 'app-dependency', appId: 'cost-insights', versionRange: '2.1.0', extra: 1 },
    ]) {
      expect(parseAppDependency(bad).ok, `dependency ${JSON.stringify(bad)}`).toBe(false);
      expect(isAppDependency(bad)).toBe(false);
    }
  });
});
