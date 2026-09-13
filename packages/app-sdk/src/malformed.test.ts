import { describe, expect, it } from 'vitest';
import { reviewAppManifest } from './validation';
import type { AppValidationDeps } from './validation';
import {
  SAMPLE_MANIFEST,
  SAMPLE_MANIFEST_RAW,
  expectOk,
  expectParseFail,
  expectValidationFail,
  fakeCatalog,
  sampleDeps,
} from './test-support';

// OFF-025 — THE malformed-manifest acceptance matrix (the named acceptance
// gate): malformed manifests — bad capability, wildcard permission, unknown
// extension point, undeclared dependency, bad version — are ALL
// typed-rejected through the single reviewAppManifest entry point, with the
// typed error surface (code + path) asserted per case. Every case is
// deterministic data; no case is ever thrown or silently repaired.

// Deterministic deep clone of fixture data (mutable records for mutation).
const clone = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

type Mutation = (raw: Record<string, unknown>) => void;

const review = (mutate: Mutation, deps?: AppValidationDeps) => {
  const raw = clone(SAMPLE_MANIFEST_RAW);
  mutate(raw);
  return reviewAppManifest(raw, deps ?? sampleDeps());
};

describe('the malformed-manifest acceptance matrix (OFF-025)', () => {
  it('accepts the untouched sample manifest (the control case)', () => {
    // The reviewed manifest is the PARSED (typed) form of the raw — the
    // dependency version range normalizes '^2.1.0' → { kind: 'caret', … }.
    expect(expectOk(review(() => undefined))).toStrictEqual(SAMPLE_MANIFEST);
  });

  it('rejects a bad capability (outside the closed authz vocabulary)', () => {
    for (const capability of ['telepathy.read', 'notAnArea.write', 'work.readx', 'WORK.READ', 42]) {
      const result = review((raw) => {
        (raw['permissions'] as Record<string, unknown>[])[0]!['capability'] = capability;
      });
      const error = expectParseFail(result);
      expect(['invalid-type', 'invalid-value']).toContain(error.code);
      expect(error.path).toBe('permissions[0].capability');
    }
  });

  it('rejects wildcard permissions (capability and scope-kind wildcards)', () => {
    for (const capability of ['*', 'work.*', '*.read', 'apps.*']) {
      const result = review((raw) => {
        (raw['permissions'] as Record<string, unknown>[])[0]!['capability'] = capability;
      });
      const error = expectParseFail(result);
      expect(error.code).toBe('invalid-value');
      expect(error.path).toBe('permissions[0].capability');
    }
    const scopeWildcard = review((raw) => {
      (raw['permissions'] as Record<string, unknown>[])[0]!['scopeKind'] = '*';
    });
    const scopeError = expectParseFail(scopeWildcard);
    expect(scopeError.code).toBe('invalid-value');
    expect(scopeError.path).toBe('permissions[0].scopeKind');
  });

  it('rejects an unknown extension point', () => {
    const result = review((raw) => {
      (raw['uiExtensions'] as Record<string, unknown>[])[0]!['extensionPoint'] = 'project.map.panel';
    });
    const error = expectParseFail(result);
    expect(error.code).toBe('invalid-value');
    expect(error.path).toBe('uiExtensions[0].extensionPoint');
    expect(error.received).toContain('project.map.panel');
  });

  it('rejects an undeclared dependency (unknown to the app catalog)', () => {
    const result = review((raw) => {
      (raw['dependencies'] as Record<string, unknown>[])[0]!['appId'] = 'mystery-app';
    });
    const error = expectValidationFail(result);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('unknown-dependency-app');
    expect(error.details[0]?.message).toBe('mystery-app');
    expect(error.details[0]?.path).toBe('dependencies[0].appId');
  });

  it('rejects a dependency range no published version satisfies', () => {
    const result = review(
      (raw) => {
        (raw['dependencies'] as Record<string, unknown>[])[0]!['versionRange'] = '^9.0.0';
      },
      {
        actions: sampleDeps().actions,
        apps: fakeCatalog({ 'cost-insights': ['2.3.1'] }),
      },
    );
    const error = expectValidationFail(result);
    expect(error.details[0]?.code).toBe('dependency-version-unsatisfied');
  });

  it('rejects bad versions (manifest version, dependency range, schema version)', () => {
    // the app's own version
    const manifestVersion = review((raw) => {
      raw['manifestVersion'] = '1.4';
    });
    const versionError = expectParseFail(manifestVersion);
    expect(versionError.code).toBe('invalid-value');
    expect(versionError.path).toBe('manifestVersion');

    // the dependency range
    const dependencyRange = review((raw) => {
      (raw['dependencies'] as Record<string, unknown>[])[0]!['versionRange'] = '~2.1.0';
    });
    const rangeError = expectParseFail(dependencyRange);
    expect(rangeError.code).toBe('invalid-value');
    expect(rangeError.path).toBe('dependencies[0].versionRange');

    // the permission declaration version
    const permissionVersion = review((raw) => {
      (raw['permissions'] as Record<string, unknown>[])[0]!['version'] = 0;
    });
    const permissionError = expectParseFail(permissionVersion);
    expect(permissionError.code).toBe('invalid-value');
    expect(permissionError.path).toBe('permissions[0].version');

    // the envelope schema version
    const schemaVersion = review((raw) => {
      raw['schemaVersion'] = '2.0.0';
    });
    const schemaError = expectParseFail(schemaVersion);
    expect(schemaError.code).toBe('unknown-schema-version');
    expect(schemaError.path).toBe('schemaVersion');
  });

  it('rejects bindings that do not resolve against the action vocabulary', () => {
    // unknown command
    const unknown = review((raw) => {
      (raw['bindings'] as Record<string, unknown>[])[0]!['commandName'] = 'field.deleteEverything';
    });
    const unknownError = expectValidationFail(unknown);
    expect(unknownError.code).toBe('not-found');
    expect(unknownError.details[0]?.code).toBe('unknown-command');

    // class mismatch against the known descriptor
    const mismatch = review((raw) => {
      (raw['bindings'] as Record<string, unknown>[])[0]!['actionClass'] = 'approval-required';
    });
    const mismatchError = expectValidationFail(mismatch);
    expect(mismatchError.code).toBe('invariant-violation');
    expect(mismatchError.details[0]?.code).toBe('action-class-mismatch');

    // prohibited is unrepresentable even before validation
    const prohibited = review((raw) => {
      (raw['bindings'] as Record<string, unknown>[])[0]!['actionClass'] = 'prohibited';
    });
    const prohibitedError = expectParseFail(prohibited);
    expect(prohibitedError.code).toBe('invalid-value');
    expect(prohibitedError.path).toBe('bindings[0].actionClass');
  });

  it('rejects a binding whose required capability is never declared (A9: explicit)', () => {
    const result = review((raw) => {
      raw['permissions'] = (raw['permissions'] as Record<string, unknown>[]).filter(
        (permission) => permission['capability'] !== 'work.write',
      );
    });
    const error = expectValidationFail(result);
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('undeclared-required-capability');
    expect(error.details[0]?.message).toBe('work.write');
  });

  it('rejects UI actions referencing unbound commands', () => {
    const result = review((raw) => {
      const extensions = raw['uiExtensions'] as Record<string, unknown>[];
      const view = extensions[0]!['view'] as Record<string, unknown>;
      (view['elements'] as Record<string, unknown>[])[2]!['commandName'] = 'cost.commitBudgetRevision';
    });
    const error = expectValidationFail(result);
    expect(error.details[0]?.code).toBe('undeclared-binding-action');
  });

  it('rejects malformed event subscriptions (grammar) and code references (strict keys)', () => {
    const badEvent = review((raw) => {
      (raw['subscriptions'] as Record<string, unknown>[])[0]!['eventName'] = 'progressRecorded';
    });
    const eventError = expectParseFail(badEvent);
    expect(eventError.path).toBe('subscriptions[0].eventName');

    const codeRef = review((raw) => {
      (raw['uiExtensions'] as Record<string, unknown>[])[0]!['code'] = 'main.js';
    });
    expectParseFail(codeRef);
  });

  it('rejects self-dependencies and duplicate declarations', () => {
    const selfDependency = review((raw) => {
      (raw['dependencies'] as Record<string, unknown>[])[0]!['appId'] = 'field-progress-tracker';
    });
    const selfError = expectParseFail(selfDependency);
    expect(selfError.received).toContain('self-dependency');

    const duplicatePermission = review((raw) => {
      (raw['permissions'] as unknown[]).push({
        kind: 'app-permission',
        capability: 'work.write',
        scopeKind: 'project',
        version: 2,
      });
    });
    expectParseFail(duplicatePermission);

    const duplicateBinding = review((raw) => {
      (raw['bindings'] as unknown[]).push((raw['bindings'] as unknown[])[0]);
    });
    expectParseFail(duplicateBinding);
  });

  it('rejects non-object roots and missing required fields', () => {
    for (const root of [null, undefined, 42, 'manifest', [], true]) {
      const result = reviewAppManifest(root, sampleDeps());
      expectParseFail(result);
    }
    for (const field of [
      'kind',
      'schemaVersion',
      'appId',
      'manifestVersion',
      'title',
      'permissions',
      'bindings',
      'subscriptions',
      'uiExtensions',
      'dependencies',
    ]) {
      const result = review((raw) => {
        delete raw[field];
      });
      const error = expectParseFail(result);
      expect(error.code).toBe('missing-field');
    }
  });

  it('is deterministic: the same malformed input reviews identically twice', () => {
    const mutate: Mutation = (raw) => {
      (raw['permissions'] as Record<string, unknown>[])[0]!['capability'] = 'work.*';
    };
    expect(review(mutate)).toStrictEqual(review(mutate));
  });
});
