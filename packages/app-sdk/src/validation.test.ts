import { describe, expect, it } from 'vitest';
import {
  actionDescriptorSource,
  reviewAppManifest,
  validateAppManifest,
} from './validation';
import type { AppValidationDeps } from './validation';
import {
  createInMemoryActionRegistry,
  defineActionDescriptor,
} from '@office/actions';
import type { ActionRegistry } from '@office/actions';
import {
  SAMPLE_MANIFEST_RAW,
  fakeCatalog,
  sampleDeps,
  expectValidationFail,
  expectOk,
  unwrap,
} from './test-support';
import { parseAppManifest } from './manifest';

// OFF-025 — cross-reference validation against the REAL OFF-017 action
// vocabulary: the fixtures below are REAL ActionDescriptors (built through
// @office/actions' own trusted builder and in-memory registry — the same
// registry shape the gateway consults), proving the SDK's structural port
// accepts the real thing and that bindings validate against real
// descriptors. Dependency validation runs against the fake catalog and the
// in-memory app registry (registry.test.ts).

/** The REAL reversible descriptor behind the sample binding (work.write). */
const RECORD_PROGRESS = defineActionDescriptor({
  commandName: 'field.recordProgress',
  title: 'Record field progress',
  description: 'Record a field progress observation (reversible class).',
  actionClass: 'reversible',
  actorKinds: ['user', 'agent', 'app', 'adapter', 'system'],
  requiredCapabilities: ['work.write'],
  policyRef: 'policy/field-progress@2',
  evidenceRequirements: [
    { slot: 'observation', description: 'The field observation backing the progress record.' },
  ],
  requiredConfidence: 'medium',
  resourceKind: 'field-report',
  compensatingCommand: 'field.correctProgress',
  approval: null,
});

/** The REAL read descriptor for the class-mismatch fixtures (cost.read). */
const LIST_COST_ITEMS = defineActionDescriptor({
  commandName: 'cost.listCostItems',
  title: 'List cost items',
  description: 'Query the cost items of a project (read class).',
  actionClass: 'read',
  actorKinds: ['user', 'agent', 'app', 'adapter', 'system'],
  requiredCapabilities: ['cost.read'],
  policyRef: 'policy/cost-queries@1',
  evidenceRequirements: [],
  requiredConfidence: 'low',
  resourceKind: 'cost-item',
  compensatingCommand: null,
  approval: null,
});

const realRegistry: ActionRegistry = createInMemoryActionRegistry([
  RECORD_PROGRESS,
  LIST_COST_ITEMS,
]);

const realDeps = (): AppValidationDeps => ({
  actions: actionDescriptorSource(realRegistry),
  apps: fakeCatalog({ 'cost-insights': ['2.1.0', '2.3.1', '3.0.0'] }),
});

// Deterministic deep clone of fixture data (mutable records for mutation).
const clone = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const validManifest = () => unwrap(parseAppManifest(SAMPLE_MANIFEST_RAW));

describe('validation against REAL ActionDescriptors', () => {
  it('accepts the sample manifest with the real registry', () => {
    const result = validateAppManifest(validManifest(), realDeps());
    expect(expectOk(result)).toStrictEqual(validManifest());
  });

  it('reviews the raw sample manifest end to end through the real registry', () => {
    const review = reviewAppManifest(SAMPLE_MANIFEST_RAW, realDeps());
    expect(expectOk(review)).toStrictEqual(validManifest());
  });

  it('rejects a binding to an unknown command (prohibited by default at the gateway)', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW) as Record<string, unknown>;
    const bindings = raw['bindings'] as Record<string, unknown>[];
    bindings[0] = {
      ...bindings[0],
      commandName: 'field.deleteEverything',
      handler: { kind: 'app-handler', handlerId: 'delete-handler', title: 'Delete' },
    };
    const review = reviewAppManifest(raw, realDeps());
    const error = expectValidationFail(review);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('unknown-command');
    expect(error.details[0]?.path).toBe('bindings[0].commandName');
  });

  it('rejects an action-class mismatch against the real descriptor', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW) as Record<string, unknown>;
    const bindings = raw['bindings'] as Record<string, unknown>[];
    // cost.listCostItems is a READ action in the real registry; declare it reversible
    bindings[0] = {
      kind: 'command-binding',
      commandName: 'cost.listCostItems',
      handler: { kind: 'app-handler', handlerId: 'list-handler', title: 'List cost items' },
      actionClass: 'reversible',
    };
    (raw['permissions'] as unknown[]).push({
      kind: 'app-permission',
      capability: 'cost.read',
      scopeKind: 'project',
      version: 1,
    });
    const review = reviewAppManifest(raw, realDeps());
    const error = expectValidationFail(review);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('action-class-mismatch');
    expect(error.details[0]?.path).toBe('bindings[0].actionClass');
  });

  it('rejects a binding whose required capability the manifest never declares (A9: explicit)', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW) as Record<string, unknown>;
    // keep the work.write binding, drop the work.write permission declaration
    raw['permissions'] = (raw['permissions'] as Record<string, unknown>[]).filter(
      (permission) => permission['capability'] !== 'work.write',
    );
    const review = reviewAppManifest(raw, realDeps());
    const error = expectValidationFail(review);
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('undeclared-required-capability');
    expect(error.details[0]?.message).toBe('work.write');
    expect(error.details[0]?.path).toBe('bindings[0].commandName');
  });
});

describe('UI action cross-references', () => {
  it('rejects an action element referencing an unbound command', () => {
    const raw = clone(SAMPLE_MANIFEST_RAW) as Record<string, unknown>;
    const extensions = raw['uiExtensions'] as Record<string, unknown>[];
    const view = extensions[0]!['view'] as Record<string, unknown>;
    const elements = view['elements'] as Record<string, unknown>[];
    elements[2] = { kind: 'action', label: 'Commit budget revision', commandName: 'cost.commitBudgetRevision' };
    const review = reviewAppManifest(raw, realDeps());
    const error = expectValidationFail(review);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('undeclared-binding-action');
    expect(error.details[0]?.path).toBe('uiExtensions[0].view.elements[2].commandName');
  });
});

describe('dependency validation', () => {
  it('rejects a dependency on an app unknown to the catalog', () => {
    // The action source still knows the sample binding (the manifest itself
    // is well-formed) — ONLY the catalog is empty, so the dependency failure
    // is what surfaces, not a binding failure.
    const deps: AppValidationDeps = {
      actions: sampleDeps().actions,
      apps: fakeCatalog({}),
    };
    const review = reviewAppManifest(SAMPLE_MANIFEST_RAW, deps);
    const error = expectValidationFail(review);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('unknown-dependency-app');
    expect(error.details[0]?.message).toBe('cost-insights');
    expect(error.details[0]?.path).toBe('dependencies[0].appId');
  });

  it('rejects a dependency range satisfied by no published version', () => {
    const deps: AppValidationDeps = {
      actions: sampleDeps().actions,
      apps: fakeCatalog({ 'cost-insights': ['3.0.0'] }),
    };
    const review = reviewAppManifest(SAMPLE_MANIFEST_RAW, deps);
    const error = expectValidationFail(review);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('dependency-version-unsatisfied');
    expect(error.details[0]?.path).toBe('dependencies[0].versionRange');
  });

  it('accepts the dependency when a published version satisfies the range', () => {
    const deps: AppValidationDeps = {
      actions: sampleDeps().actions,
      apps: fakeCatalog({ 'cost-insights': ['1.9.0', '2.3.1'] }),
    };
    expect(expectOk(reviewAppManifest(SAMPLE_MANIFEST_RAW, deps))).toStrictEqual(validManifest());
  });
});

describe('determinism (pure validation)', () => {
  it('produces identical results on repeated runs (success and failure)', () => {
    const first = validateAppManifest(validManifest(), realDeps());
    const second = validateAppManifest(validManifest(), realDeps());
    expect(first).toStrictEqual(second);

    const raw = clone(SAMPLE_MANIFEST_RAW) as Record<string, unknown>;
    const bindings = raw['bindings'] as Record<string, unknown>[];
    bindings[0] = { ...bindings[0], commandName: 'field.deleteEverything' };
    const failureA = reviewAppManifest(raw, realDeps());
    const failureB = reviewAppManifest(raw, realDeps());
    expect(failureA).toStrictEqual(failureB);
  });

  it('never mutates the manifest it validates', () => {
    const snapshot = clone(SAMPLE_MANIFEST_RAW);
    validateAppManifest(validManifest(), realDeps());
    expect(SAMPLE_MANIFEST_RAW).toStrictEqual(snapshot);
  });
});
