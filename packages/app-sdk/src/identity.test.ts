import { describe, expect, it } from 'vitest';
import {
  appId,
  appVersion,
  compareAppVersions,
  formatPermissionId,
  isAppHandlerId,
  isAppId,
  isAppVersion,
  isPermissionId,
  isPermissionVersion,
  isVersionRange,
  isViewId,
  parseAppHandlerId,
  parseAppId,
  parseAppVersion,
  parsePermissionId,
  parsePermissionVersion,
  parseVersionRange,
  parseViewId,
  permissionIdOf,
  satisfiesVersion,
  versionRange,
  viewId,
} from './identity';
import { unwrap } from './test-support';

// OFF-025 — the app-sdk identity & versioning vocabulary: total fail-closed
// parses, loud trusted builders, deterministic derived permission ids, and
// pure semver math for the dependency ranges. Deterministic fixtures only.

describe('app identity (AppId)', () => {
  it('parses valid slugs and rejects malformed or wildcard-shaped ids', () => {
    expect(unwrap(parseAppId('field-progress-tracker'))).toBe('field-progress-tracker');
    expect(unwrap(parseAppId('cost-insights'))).toBe('cost-insights');
    expect(isAppId('field-progress-tracker')).toBe(true);
    for (const bad of [
      '', // too short
      'ab', // too short
      'Field-Progress', // uppercase
      '-field-progress', // leading hyphen
      'field-progress-', // trailing hyphen
      'field--progress', // double hyphen
      'field_progress', // underscore
      'a'.repeat(64), // too long
      'apps.*', // wildcard shape
      '*', // wildcard
      42, // wrong type
      null,
    ]) {
      expect(parseAppId(bad).ok, `app id ${JSON.stringify(bad)}`).toBe(false);
      expect(isAppId(bad)).toBe(false);
    }
  });

  it('accepts hyphenated segments but not double hyphens (pattern-exact)', () => {
    expect(isAppId('a-b-c')).toBe(true);
    expect(isAppId('a--b')).toBe(false);
    expect(isAppId('a1b2c3')).toBe(true);
  });

  it('composes through the trusted builder and fails loud on invalid ids', () => {
    expect(appId('cost-insights')).toBe('cost-insights');
    expect(() => appId('Cost Insights')).toThrow(TypeError);
  });
});

describe('app versions (AppVersion)', () => {
  it('parses well-formed semantic versions and rejects malformed ones', () => {
    expect(unwrap(parseAppVersion('1.4.0'))).toBe('1.4.0');
    expect(unwrap(parseAppVersion('0.0.1'))).toBe('0.0.1');
    expect(isAppVersion('2.10.3')).toBe(true);
    for (const bad of ['1.4', 'v1.4.0', '1.4.0.0', '01.4.0', '1.04.0', '1.4.-0', 'x.y.z', '', 1, null]) {
      expect(parseAppVersion(bad).ok, `version ${JSON.stringify(bad)}`).toBe(false);
      expect(isAppVersion(bad)).toBe(false);
    }
  });

  it('composes through the trusted builder and fails loud', () => {
    expect(appVersion('1.4.0')).toBe('1.4.0');
    expect(() => appVersion('1.4')).toThrow(TypeError);
  });

  it('compares versions lexicographically over the triple (pure, total)', () => {
    expect(compareAppVersions(appVersion('1.4.0'), appVersion('1.4.0'))).toBe(0);
    expect(compareAppVersions(appVersion('1.4.0'), appVersion('1.10.0'))).toBe(-1);
    expect(compareAppVersions(appVersion('1.10.0'), appVersion('1.4.0'))).toBe(1);
    expect(compareAppVersions(appVersion('2.0.0'), appVersion('1.99.99'))).toBe(1);
    expect(compareAppVersions(appVersion('0.0.2'), appVersion('0.0.10'))).toBe(-1);
  });
});

describe('dependency version ranges', () => {
  it('parses exact and caret ranges and rejects malformed ones', () => {
    expect(unwrap(parseVersionRange('2.1.0'))).toStrictEqual({ kind: 'exact', version: '2.1.0' });
    expect(unwrap(parseVersionRange('^2.1.0'))).toStrictEqual({ kind: 'caret', version: '2.1.0' });
    expect(unwrap(parseVersionRange('^0.2.3'))).toStrictEqual({ kind: 'caret', version: '0.2.3' });
    expect(isVersionRange('1.0.0')).toBe(true);
    for (const bad of ['~1.2.3', '>=1.2.3', '1.2.*', '^1.2', '^01.2.3', '1.2.3-beta', '', null, 7]) {
      expect(parseVersionRange(bad).ok, `range ${JSON.stringify(bad)}`).toBe(false);
      expect(isVersionRange(bad)).toBe(false);
    }
  });

  it('accepts the typed object form (a parsed manifest round-trips unchanged)', () => {
    expect(unwrap(parseVersionRange({ kind: 'exact', version: '2.1.0' }))).toStrictEqual({
      kind: 'exact',
      version: '2.1.0',
    });
    expect(unwrap(parseVersionRange({ kind: 'caret', version: '0.2.3' }))).toStrictEqual({
      kind: 'caret',
      version: '0.2.3',
    });
    for (const bad of [
      { kind: 'tilde', version: '1.2.3' },
      { kind: 'caret' },
      { kind: 'caret', version: '01.2.3' },
      { kind: 'caret', version: '~1.2.3' },
      { kind: 'exact', version: '1.2.3', extra: 1 },
      { kind: 'caret', version: 2 },
      { version: '1.2.3' },
      ['^1.2.3'],
    ]) {
      expect(parseVersionRange(bad).ok, `range ${JSON.stringify(bad)}`).toBe(false);
      expect(isVersionRange(bad)).toBe(false);
    }
  });

  it('composes through the trusted builder and fails loud', () => {
    expect(versionRange('^2.1.0')).toStrictEqual({ kind: 'caret', version: '2.1.0' });
    expect(() => versionRange('~2.1.0')).toThrow(TypeError);
  });

  it('satisfies exact ranges only on equality', () => {
    const exact = unwrap(parseVersionRange('2.1.0'));
    expect(satisfiesVersion(exact, appVersion('2.1.0'))).toBe(true);
    expect(satisfiesVersion(exact, appVersion('2.1.1'))).toBe(false);
    expect(satisfiesVersion(exact, appVersion('2.0.0'))).toBe(false);
  });

  it('satisfies caret ranges with the semver caret semantics', () => {
    const caret = unwrap(parseVersionRange('^2.1.0'));
    expect(satisfiesVersion(caret, appVersion('2.1.0'))).toBe(true);
    expect(satisfiesVersion(caret, appVersion('2.3.1'))).toBe(true);
    expect(satisfiesVersion(caret, appVersion('2.99.0'))).toBe(true);
    expect(satisfiesVersion(caret, appVersion('3.0.0'))).toBe(false);
    expect(satisfiesVersion(caret, appVersion('2.0.9'))).toBe(false);

    const zeroMinor = unwrap(parseVersionRange('^0.2.3'));
    expect(satisfiesVersion(zeroMinor, appVersion('0.2.3'))).toBe(true);
    expect(satisfiesVersion(zeroMinor, appVersion('0.2.9'))).toBe(true);
    expect(satisfiesVersion(zeroMinor, appVersion('0.3.0'))).toBe(false);
    expect(satisfiesVersion(zeroMinor, appVersion('1.0.0'))).toBe(false);

    const zeroZero = unwrap(parseVersionRange('^0.0.3'));
    expect(satisfiesVersion(zeroZero, appVersion('0.0.3'))).toBe(true);
    expect(satisfiesVersion(zeroZero, appVersion('0.0.4'))).toBe(true);
    expect(satisfiesVersion(zeroZero, appVersion('0.1.0'))).toBe(false);
  });
});

describe('view and handler ids', () => {
  it('parses valid slugs and rejects malformed ones', () => {
    expect(unwrap(parseViewId('progress-summary'))).toBe('progress-summary');
    expect(unwrap(parseAppHandlerId('record-progress-handler'))).toBe('record-progress-handler');
    expect(isViewId('progress-summary')).toBe(true);
    expect(isAppHandlerId('record-progress-handler')).toBe(true);
    for (const bad of ['', 'x', 'Progress', 'progress summary', 'progress-', '-progress', null]) {
      expect(parseViewId(bad).ok, `view id ${JSON.stringify(bad)}`).toBe(false);
      expect(parseAppHandlerId(bad).ok, `handler id ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(() => viewId('Bad View')).toThrow(TypeError);
  });
});

describe('permission ids (deterministic derivation)', () => {
  it('parses only office-prm-v1 derived ids', () => {
    const id = permissionIdOf({
      tenantId: 'office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
      capability: 'work.write',
      scopeKind: 'project',
    });
    expect(id.startsWith('office-prm-v1-')).toBe(true);
    expect(id).toHaveLength('office-prm-v1-'.length + 32);
    expect(unwrap(parsePermissionId(id))).toBe(id);
    expect(isPermissionId(id)).toBe(true);
    expect(() => formatPermissionId('office-prm-v1-SHORT')).toThrow(TypeError);
    for (const bad of [
      'office-prm-v2-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      'office-grt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      'office-prm-v1-0A1B2C3D4E5F60718293A4B5C6D7E8F9',
      'office-prm-v1-',
      '',
      null,
    ]) {
      expect(parsePermissionId(bad).ok, `permission id ${JSON.stringify(bad)}`).toBe(false);
      expect(isPermissionId(bad)).toBe(false);
    }
  });

  it('derives identical ids for identical logical keys and distinct ids otherwise', () => {
    const key = {
      tenantId: 'office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
      capability: 'work.write',
      scopeKind: 'project' as const,
    };
    expect(permissionIdOf(key)).toBe(permissionIdOf({ ...key }));
    expect(permissionIdOf(key)).not.toBe(permissionIdOf({ ...key, capability: 'work.read' }));
    expect(permissionIdOf(key)).not.toBe(
      permissionIdOf({ ...key, tenantId: 'office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a' }),
    );
    expect(permissionIdOf(key)).not.toBe(
      permissionIdOf({ ...key, installationId: 'office-ent-v1-9d8c7b6a5f4e3d2c1b0a9988776655443322' }),
    );
    expect(permissionIdOf(key)).not.toBe(permissionIdOf({ ...key, scopeKind: 'tenant' as const }));
  });
});

describe('permission versions', () => {
  it('parses positive integers only', () => {
    expect(unwrap(parsePermissionVersion(1))).toBe(1);
    expect(unwrap(parsePermissionVersion(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(isPermissionVersion(2)).toBe(true);
    for (const bad of [0, -1, 1.5, NaN, Infinity, '1', null, undefined]) {
      expect(parsePermissionVersion(bad).ok, `version ${JSON.stringify(bad)}`).toBe(false);
      expect(isPermissionVersion(bad)).toBe(false);
    }
  });
});
