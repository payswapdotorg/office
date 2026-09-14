import { describe, expect, it } from 'vitest';
import type { RepoFile, Violation } from './rules';
import {
  CAPABILITY_REGISTRY_FILE,
  checkAgentDbAccess,
  checkAppPermissions,
  checkForbiddenImports,
  checkProviderLeakage,
  checkScopedQueries,
  loadRepoTree,
} from './rules';

// OFF-039 mutation probes — the proof that the five conformance rules
// actually FAIL on violations: a rule that cannot be shown to fail is not a
// gate. Every probe feeds a SYNTHETIC in-memory `RepoFile[]` fixture map
// (never a real repo file) through the pure checkers of rules.ts:
//
//   - MUTATION probes: a fixture carrying exactly one violation shape must
//     fail closed naming the violated rule and the offending file;
//   - HEALTHY-CONTROL probes: a clean fixture map yields zero violations (a
//     scanner that cannot pass a healthy tree is vacuous);
//   - FAIL-CLOSED probes: a missing or unreadable DECLARED file (a package
//     manifest, the capability registry, a client session) is a FAILURE,
//     never a skip.
//
// The synthetic fixture names (Synth*) deliberately never alias a landed
// surface, and the fixture paths stay under packages/ and apps/ so the
// path-derived rules apply exactly as they do over the real tree. The
// provider-name fixtures follow the fragment discipline: the real names are
// assembled at runtime, never literal in this suite's own source.

const file = (path: string, text: string): RepoFile => ({ path, text });

const manifest = (dir: string, name: string, dependencies: readonly string[] = []): RepoFile =>
  file(
    `${dir}/package.json`,
    JSON.stringify({
      name,
      ...(dependencies.length > 0
        ? {
            dependencies: Object.fromEntries(
              dependencies.map((dependency) => [dependency, 'workspace:^']),
            ),
          }
        : {}),
    }),
  );

const violationsOf = (
  violations: readonly Violation[],
  rule: string,
): readonly Violation[] => violations.filter((violation) => violation.rule === rule);

// ---------------------------------------------------------------------------
// Check 1 — forbidden imports.
// ---------------------------------------------------------------------------

describe('mutation probes — check 1: forbidden imports', () => {
  const healthyTree: readonly RepoFile[] = [
    manifest('packages/synth', '@office/synth', ['@office/contracts', '@office/domain-kernel']),
    file(
      'packages/synth/src/index.ts',
      [
        "import { join } from 'node:path';",
        "import type { SynthThing } from './thing';",
        "import { parseScope } from '@office/contracts';",
        "import { EntityId } from '@office/domain-kernel';",
        'export const value: number = 1;',
        'export const pathOf = (id: EntityId): string => join(id, String(value));',
        'export type { SynthThing };',
      ].join('\n'),
    ),
    file('packages/synth/src/thing.ts', 'export interface SynthThing { readonly id: string; }\n'),
    file(
      'packages/synth/src/index.test.ts',
      [
        "import { describe, expect, it } from 'vitest';",
        "import { value } from './index';",
        "describe('synth', () => { it('is deterministic', () => { expect(value).toBe(1); }); });",
      ].join('\n'),
    ),
    // The sanctioned dynamic-import seam: the root-devDependency harness of
    // packages/persistence, imported dynamically so production never loads it.
    manifest('packages/persistence', '@office/persistence', [
      '@office/contracts',
      '@office/domain-kernel',
      'pg',
    ]),
    file(
      'packages/persistence/src/testing.ts',
      [
        'export const startHarness = async (): Promise<void> => {',
        "  const mod = await import('embedded-postgres');",
        '  await mod.default.initialise();',
        '};',
      ].join('\n'),
    ),
  ];

  it('HEALTHY CONTROL: a clean synthetic package tree yields zero violations', () => {
    expect(checkForbiddenImports(healthyTree)).toStrictEqual([]);
  });

  it('MUTATION: an undeclared workspace import fails closed naming file + import', () => {
    const violations = checkForbiddenImports([
      manifest('packages/synth', '@office/synth', ['@office/contracts']),
      file(
        'packages/synth/src/index.ts',
        [
          "import { parseScope } from '@office/contracts';",
          "import { helper } from '@office/other';",
          'export const value = helper(parseScope);',
        ].join('\n'),
      ),
    ]);
    const undeclared = violationsOf(violations, 'undeclared-workspace-dependency');
    expect(undeclared.length).toBe(1);
    expect(undeclared[0]?.file).toBe('packages/synth/src/index.ts');
    expect(undeclared[0]?.detail).toContain("'@office/other'");
  });

  it('MUTATION: an undeclared external import fails closed naming file + import', () => {
    const violations = checkForbiddenImports([
      manifest('packages/synth', '@office/synth'),
      file('packages/synth/src/index.ts', "import pad from 'left-pad';\nexport const padded = pad;\n"),
    ]);
    const external = violationsOf(violations, 'external-import');
    expect(external.length).toBe(1);
    expect(external[0]?.file).toBe('packages/synth/src/index.ts');
    expect(external[0]?.detail).toContain("'left-pad'");
  });

  it('MUTATION: a domain package importing an adapter fails closed even though declared', () => {
    const violations = checkForbiddenImports([
      manifest('packages/domain/synth', '@office/domain-synth', ['@office/adapter-finance']),
      file(
        'packages/domain/synth/src/index.ts',
        "import { financePort } from '@office/adapter-finance';\nexport const port = financePort;\n",
      ),
    ]);
    const layering = violationsOf(violations, 'domain-never-imports-adapters');
    expect(layering.length).toBe(1);
    expect(layering[0]?.file).toBe('packages/domain/synth/src/index.ts');
    expect(layering[0]?.detail).toContain("'@office/adapter-finance'");
    expect(layering[0]?.detail).toContain('layering forbids');
  });

  it('MUTATION: a client importing persistence fails closed even though declared', () => {
    const violations = checkForbiddenImports([
      manifest('apps/synthapp', '@office/synthapp', ['@office/contracts', '@office/persistence']),
      file(
        'apps/synthapp/src/index.ts',
        "import { Pool } from '@office/persistence';\nexport const pool = Pool;\n",
      ),
    ]);
    const layering = violationsOf(violations, 'clients-never-import-persistence');
    expect(layering.length).toBe(1);
    expect(layering[0]?.file).toBe('apps/synthapp/src/index.ts');
  });

  it('MUTATION: an adapter importing another adapter fails closed', () => {
    const violations = checkForbiddenImports([
      manifest('packages/adapter-synth', '@office/adapter-synth', ['@office/adapter-finance']),
      file(
        'packages/adapter-synth/src/index.ts',
        "import { financeThing } from '@office/adapter-finance';\nexport const thing = financeThing;\n",
      ),
    ]);
    const layering = violationsOf(violations, 'adapters-never-import-adapters');
    expect(layering.length).toBe(1);
    expect(layering[0]?.file).toBe('packages/adapter-synth/src/index.ts');
  });

  it('MUTATION: the test-runner import outside a *.test.ts file fails closed', () => {
    const violations = checkForbiddenImports([
      manifest('packages/synth', '@office/synth'),
      file('packages/synth/src/index.ts', "import { it } from 'vitest';\nexport const runner = it;\n"),
    ]);
    const testRunner = violationsOf(violations, 'test-runner-import-outside-test');
    expect(testRunner.length).toBe(1);
    expect(testRunner[0]?.file).toBe('packages/synth/src/index.ts');
  });

  it('MUTATION: a source file with no owning package manifest fails closed (orphan)', () => {
    const violations = checkForbiddenImports([
      file('packages/orphan/src/index.ts', "import { join } from 'node:path';\nexport const joined = join;\n"),
    ]);
    const orphan = violationsOf(violations, 'orphan-source-file');
    expect(orphan.length).toBe(1);
    expect(orphan[0]?.file).toBe('packages/orphan/src/index.ts');
  });

  it('FAIL-CLOSED: an unparsable package manifest is a failure, never a skip', () => {
    const violations = checkForbiddenImports([
      file('packages/broken/package.json', '{ not json'),
      file('packages/broken/src/index.ts', 'export const value = 1;\n'),
    ]);
    const unreadable = violationsOf(violations, 'package-manifest-unreadable');
    expect(unreadable.length).toBe(1);
    expect(unreadable[0]?.file).toBe('packages/broken/package.json');
  });

  it('FAIL-CLOSED: a manifest without a string name is a failure, never a skip', () => {
    const violations = checkForbiddenImports([
      file('packages/nameless/package.json', '{"version": "0.1.0"}'),
      file('packages/nameless/src/index.ts', 'export const value = 1;\n'),
    ]);
    const unreadable = violationsOf(violations, 'package-manifest-unreadable');
    expect(unreadable.length).toBe(1);
    expect(unreadable[0]?.file).toBe('packages/nameless/package.json');
  });

  // OFF-DEPLOY: the .tsx extension probes — the browser host's JSX modules
  // are gated exactly like TypeScript modules (check 1 scans .ts AND .tsx).
  it('HEALTHY CONTROL: a browser-host-shaped .tsx tree yields zero violations', () => {
    expect(
      checkForbiddenImports([
        manifest('apps/synthhost', '@office/synthhost', [
          'next',
          'react',
          'react-dom',
          '@office/web',
          '@office/host-gateway',
        ]),
        file(
          'apps/synthhost/src/app/page.tsx',
          [
            "import type { ProjectWorkspaceView } from '@office/web';",
            "import { getHostRuntime } from '@office/host-gateway';",
            'export default async function Page() {',
            '  const value: ProjectWorkspaceView | null = null;',
            '  return <main>{JSON.stringify(value)}</main>;',
            '}',
          ].join('\n'),
        ),
      ]),
    ).toStrictEqual([]);
  });

  it('MUTATION: a .tsx module importing persistence fails closed (JSX is not an exemption)', () => {
    const violations = checkForbiddenImports([
      manifest('apps/synthhost', '@office/synthhost', ['react', '@office/persistence']),
      file(
        'apps/synthhost/src/app/page.tsx',
        "import { Pool } from '@office/persistence';\nexport default function Page() { return <div>{String(Pool)}</div>; }\n",
      ),
    ]);
    const layering = violationsOf(violations, 'clients-never-import-persistence');
    expect(layering.length).toBe(1);
    expect(layering[0]?.file).toBe('apps/synthhost/src/app/page.tsx');
  });

  it('MUTATION: an undeclared import inside a .tsx module fails closed naming file + import', () => {
    const violations = checkForbiddenImports([
      manifest('apps/synthhost', '@office/synthhost', ['react']),
      file(
        'apps/synthhost/src/components/thing.tsx',
        "import { helper } from '@office/other';\nexport const Thing = () => <div>{String(helper)}</div>;\n",
      ),
    ]);
    const undeclared = violationsOf(violations, 'undeclared-workspace-dependency');
    expect(undeclared.length).toBe(1);
    expect(undeclared[0]?.file).toBe('apps/synthhost/src/components/thing.tsx');
    expect(undeclared[0]?.detail).toContain("'@office/other'");
  });
});

// ---------------------------------------------------------------------------
// Check 2 — provider leakage.
// ---------------------------------------------------------------------------

describe('mutation probes — check 2: provider leakage', () => {
  // The fragment discipline: assembled at runtime, never literal in source.
  const leakedName = 'pro' + 'core';

  it('HEALTHY CONTROL: generic vocabulary (and an empty map) yields zero violations', () => {
    expect(checkProviderLeakage([])).toStrictEqual([]);
    expect(
      checkProviderLeakage([
        file(
          'packages/synth/src/index.ts',
          'export const kind = "provider";\nexport const role = "vendor";\nexport const category = "erp-finance";\nexport const term = "existence oracle";\n',
        ),
      ]),
    ).toStrictEqual([]);
  });

  it('MUTATION: a real provider name in a source file fails closed naming file + name', () => {
    const violations = checkProviderLeakage([
      file('packages/synth/src/index.ts', `export const adapterLabel = '${leakedName} sync';\n`),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0]?.rule).toBe('provider-name-leakage');
    expect(violations[0]?.file).toBe('packages/synth/src/index.ts');
    expect(violations[0]?.detail).toContain(leakedName);
  });

  it('MUTATION: a name inside a comment is NOT a violation (comments are stripped first)', () => {
    expect(
      checkProviderLeakage([
        file(
          'packages/synth/src/index.ts',
          `// the ${leakedName} integration is deliberately unnamed\nexport const value = 1;\n`,
        ),
      ]),
    ).toStrictEqual([]);
  });

  it('MUTATION: the sanctioned exception paths are enumerated, not a blanket pass', () => {
    const content = `export const scanInput = '${leakedName}';\n`;
    // The adapter fixture-vocabulary home and the intelligence scanner carry
    // the literal names as their own scan inputs — sanctioned by enumeration.
    expect(
      checkProviderLeakage([file('packages/adapter-construction/src/vocabulary.ts', content)]),
    ).toStrictEqual([]);
    expect(
      checkProviderLeakage([
        file('packages/intelligence/procurement/src/boundary.test.ts', content),
      ]),
    ).toStrictEqual([]);
    // The SAME content anywhere else fails closed: the exception is a path
    // list, never a content-based or blanket exemption.
    const violations = checkProviderLeakage([file('packages/synth/src/vocabulary.ts', content)]);
    expect(violations.length).toBe(1);
    expect(violations[0]?.rule).toBe('provider-name-leakage');
    expect(violations[0]?.file).toBe('packages/synth/src/vocabulary.ts');
  });

  // OFF-DEPLOY: the .tsx extension probe — JSX modules leak vendor names
  // exactly as reliably as TypeScript modules (check 2 scans .ts AND .tsx).
  it('MUTATION: a real provider name inside a .tsx module fails closed naming file + name', () => {
    const violations = checkProviderLeakage([
      file(
        'apps/synthhost/src/components/sync-status.tsx',
        `export const SyncLabel = () => <span>${leakedName} sync</span>;\n`,
      ),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0]?.rule).toBe('provider-name-leakage');
    expect(violations[0]?.file).toBe('apps/synthhost/src/components/sync-status.tsx');
    expect(violations[0]?.detail).toContain(leakedName);
  });

  it('HEALTHY CONTROL: generic vocabulary inside a .tsx module is clean', () => {
    expect(
      checkProviderLeakage([
        file(
          'apps/synthhost/src/components/status.tsx',
          'export const Status = () => <span role="status">provider: connected</span>;\n',
        ),
      ]),
    ).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Check 3 — direct agent DB access.
// ---------------------------------------------------------------------------

describe('mutation probes — check 3: direct agent DB access', () => {
  it('HEALTHY CONTROL: the type-only port seam, test fixtures, and non-family SQL are clean', () => {
    expect(
      checkAgentDbAccess([
        // The one sanctioned inert seam: a TYPE-ONLY port signature.
        file(
          'packages/agents/src/run.ts',
          "import type { SqlExecutor } from '@office/persistence';\nexport interface SynthAgentPort { readonly executor: SqlExecutor; }\n",
        ),
        // Test fixtures may exercise SQL vocabulary freely.
        file(
          'packages/agents/src/run.test.ts',
          "import { describe, expect, it } from 'vitest';\ndescribe('run', () => { it('fixture', () => { expect('INSERT INTO t VALUES (1)').toBeTruthy(); }); });\n",
        ),
        // SQL outside the agents/intelligence families is not this rule's concern.
        file('packages/persistence/src/rows.ts', "export const stmt = 'INSERT INTO tenants (id) VALUES (1)';\n"),
      ]),
    ).toStrictEqual([]);
  });

  it('MUTATION: a VALUE import of @office/persistence in the agents package fails closed', () => {
    const violations = checkAgentDbAccess([
      file(
        'packages/agents/src/direct.ts',
        "import { SqlExecutor } from '@office/persistence';\nexport const executor = SqlExecutor;\n",
      ),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0]?.rule).toBe('agent-persistence-value-import');
    expect(violations[0]?.file).toBe('packages/agents/src/direct.ts');
    expect(violations[0]?.detail).toContain('type-only');
  });

  it('MUTATION: any @office/persistence import outside packages/agents fails closed (even type-only)', () => {
    const violations = checkAgentDbAccess([
      file(
        'packages/intelligence/synth/src/port.ts',
        "import type { SqlExecutor } from '@office/persistence';\nexport type Port = SqlExecutor;\n",
      ),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0]?.rule).toBe('agent-persistence-import');
    expect(violations[0]?.file).toBe('packages/intelligence/synth/src/port.ts');
  });

  it('MUTATION: a SQL driver import anywhere in the family fails closed', () => {
    const violations = checkAgentDbAccess([
      file('packages/agents/src/driver.ts', "import { Pool } from 'pg';\nexport const pool = Pool;\n"),
      file(
        'packages/intelligence/synth/src/driver.ts',
        "import { Client } from 'node:pg';\nexport const client = Client;\n",
      ),
    ]);
    const driver = violationsOf(violations, 'agent-sql-driver-import');
    expect(driver.length).toBe(2);
    expect(driver.map((violation) => violation.file).sort()).toStrictEqual([
      'packages/agents/src/driver.ts',
      'packages/intelligence/synth/src/driver.ts',
    ]);
  });

  it('MUTATION: SQL statement vocabulary in a non-test family module fails closed', () => {
    const violations = checkAgentDbAccess([
      file(
        'packages/agents/src/store.ts',
        "export const insertStmt = 'INSERT INTO tenants (id) VALUES (1)';\n",
      ),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0]?.rule).toBe('agent-sql-surface');
    expect(violations[0]?.file).toBe('packages/agents/src/store.ts');
  });

  it('MUTATION: a .query( call site in a non-test family module fails closed', () => {
    const violations = checkAgentDbAccess([
      file(
        'packages/intelligence/synth/src/ledger.ts',
        "export const read = async (executor: { query(sql: string): Promise<void> }): Promise<void> => executor.query('SELECT 1');\n",
      ),
    ]);
    expect(violations.length).toBe(1);
    expect(violations[0]?.rule).toBe('agent-sql-surface');
    expect(violations[0]?.file).toBe('packages/intelligence/synth/src/ledger.ts');
    expect(violations[0]?.detail).toContain('.query(');
  });
});

// ---------------------------------------------------------------------------
// Check 4 — unscoped queries.
// ---------------------------------------------------------------------------

describe('mutation probes — check 4: unscoped queries', () => {
  const facingManifest = manifest('packages/synth-events', '@office/synth-events', [
    '@office/persistence',
  ]);
  const executorParam = 'executor: { query(sql: string): Promise<void> }';

  it('HEALTHY CONTROL: scoped repository + carrier input + scoped query export yield zero', () => {
    expect(
      checkScopedQueries([
        facingManifest,
        file(
          'packages/synth-events/src/things.ts',
          [
            'export interface SynthThingInput {',
            '  readonly envelope: DomainEventEnvelope;',
            '  readonly id: string;',
            '}',
            'export interface SynthThingsRepository {',
            '  load(scope: Scope, id: string): Promise<string | undefined>;',
            '  save(input: SynthThingInput): Promise<void>;',
            '}',
          ].join('\n'),
        ),
        file(
          'packages/synth-events/src/loader.ts',
          [
            'export async function loadScopedRow(scope: Scope, ' +
              executorParam +
              '): Promise<void> {',
            "  await executor.query('SELECT 1');",
            '}',
          ].join('\n'),
        ),
      ]),
    ).toStrictEqual([]);
  });

  it('MUTATION: an unscoped repository method fails closed naming interface + method', () => {
    const violations = checkScopedQueries([
      facingManifest,
      file(
        'packages/synth-events/src/things.ts',
        [
          'export interface SynthThingsRepository {',
            '  load(id: string): Promise<string | undefined>;',
            '  save(scope: Scope, id: string): Promise<void>;',
          '}',
        ].join('\n'),
      ),
    ]);
    const unscoped = violationsOf(violations, 'unscoped-repository-method');
    expect(unscoped.length).toBe(1);
    expect(unscoped[0]?.file).toBe('packages/synth-events/src/things.ts');
    expect(unscoped[0]?.detail).toContain('SynthThingsRepository.load');
    expect(unscoped[0]?.detail).toContain('A12');
  });

  it('MUTATION: an input interface WITHOUT a scope carrier does not pass as scoped', () => {
    // The carrier analysis is recursive and earned: an input whose interface
    // carries no scope field is an unscoped entry point, not a pass.
    const violations = checkScopedQueries([
      facingManifest,
      file(
        'packages/synth-events/src/things.ts',
        [
          'export interface SynthPlainInput {',
            '  readonly id: string;',
          '}',
          'export interface SynthThingsRepository {',
            '  load(input: SynthPlainInput): Promise<string | undefined>;',
          '}',
        ].join('\n'),
      ),
    ]);
    const unscoped = violationsOf(violations, 'unscoped-repository-method');
    expect(unscoped.length).toBe(1);
    expect(unscoped[0]?.file).toBe('packages/synth-events/src/things.ts');
    expect(unscoped[0]?.detail).toContain('SynthThingsRepository.load');
  });

  it('MUTATION: an exported query function without a scope parameter fails closed', () => {
    const violations = checkScopedQueries([
      facingManifest,
      file(
        'packages/synth-events/src/loader.ts',
        [
          `export function loadEverything(${executorParam}): Promise<void> {`,
          "  return executor.query('SELECT 1');",
          '}',
        ].join('\n'),
      ),
    ]);
    const unscoped = violationsOf(violations, 'unscoped-query-export');
    expect(unscoped.length).toBe(1);
    expect(unscoped[0]?.file).toBe('packages/synth-events/src/loader.ts');
    expect(unscoped[0]?.detail).toContain('loadEverything');
    expect(unscoped[0]?.detail).toContain('A12');
  });

  it('MUTATION: the control-plane exception list is real and narrow (same content, two paths)', () => {
    const content = [
      `export async function runMigrations(${executorParam}): Promise<void> {`,
      "  await executor.query('CREATE TABLE synth (id text)');",
      '}',
    ].join('\n');
    // The enumerated platform control-plane file is sanctioned...
    expect(
      checkScopedQueries([file('packages/persistence/src/migrator.ts', content)]),
    ).toStrictEqual([]);
    // ...and the SAME content in a tenant-data-facing package fails closed.
    const violations = checkScopedQueries([
      facingManifest,
      file('packages/synth-events/src/migrator.ts', content),
    ]);
    const unscoped = violationsOf(violations, 'unscoped-query-export');
    expect(unscoped.length).toBe(1);
    expect(unscoped[0]?.file).toBe('packages/synth-events/src/migrator.ts');
  });

  it('BOUNDARY: *.test.ts files are out of scope for the exported-surface rule', () => {
    expect(
      checkScopedQueries([
        facingManifest,
        file(
          'packages/synth-events/src/loader.test.ts',
          `export const probe = (${executorParam}): Promise<void> => executor.query('SELECT 1');\n`,
        ),
      ]),
    ).toStrictEqual([]);
  });

  it('FAIL-CLOSED: an unparsable manifest of a persistence-declaring package fails closed', () => {
    const violations = checkScopedQueries([
      file('packages/synth-events/package.json', '{ not json'),
      file('packages/synth-events/src/index.ts', 'export const value = 1;\n'),
    ]);
    const unreadable = violationsOf(violations, 'package-manifest-unreadable');
    expect(unreadable.length).toBe(1);
    expect(unreadable[0]?.file).toBe('packages/synth-events/package.json');
  });
});

// ---------------------------------------------------------------------------
// Check 5 — app permission drift.
// ---------------------------------------------------------------------------

describe('mutation probes — check 5: app permission drift', () => {
  const registryNames = ['projects.read', 'projects.write', 'work.read', 'work.write'];

  const registryWith = (names: readonly string[]): RepoFile =>
    file(
      CAPABILITY_REGISTRY_FILE,
      `const DECLARED_CAPABILITY_NAMES = [\n${names.map((name) => `  '${name}',`).join('\n')}\n] as const;\n`,
    );

  const sessionOf = (
    client: string,
    declared: readonly string[],
    allowed: readonly string[],
  ): RepoFile =>
    file(
      `apps/${client}/src/session/session.ts`,
      [
        "import { capability, definePolicy } from '@office/authz';",
        "import type { Capability } from '@office/authz';",
        `export const SESSION_${client.toUpperCase()}_CAPABILITIES: readonly Capability[] = [`,
        ...declared.map((name) => `  capability('${name}'),`),
        '];',
        `definePolicy([{ capabilities: [${allowed.map((name) => `'${name}'`).join(', ')}] }]);`,
      ].join('\n'),
    );

  const healthyTree = (): readonly RepoFile[] => [
    registryWith(registryNames),
    sessionOf('web', registryNames, registryNames),
    sessionOf('field', registryNames, registryNames),
    sessionOf('desktop', registryNames, registryNames),
  ];

  it('HEALTHY CONTROL: the registry plus three matching session baselines yield zero', () => {
    expect(checkAppPermissions(healthyTree())).toStrictEqual([]);
  });

  it('MUTATION: a client capability literal outside the registry fails closed', () => {
    const violations = checkAppPermissions([
      ...healthyTree(),
      file(
        'apps/web/src/commands.ts',
        "import { capability } from '@office/authz';\nexport const purge = capability('projects.purge');\n",
      ),
    ]);
    const undeclared = violationsOf(violations, 'undeclared-client-permission');
    expect(undeclared.length).toBe(1);
    expect(undeclared[0]?.file).toBe('apps/web/src/commands.ts');
    expect(undeclared[0]?.detail).toContain("'projects.purge'");
  });

  it('MUTATION: a policy capability array outside the registry fails closed', () => {
    const violations = checkAppPermissions([
      ...healthyTree(),
      file('apps/field/src/policy.ts', "export const policy = { capabilities: ['projects.purge'] };\n"),
    ]);
    const undeclared = violationsOf(violations, 'undeclared-client-permission');
    expect(undeclared.length).toBe(1);
    expect(undeclared[0]?.file).toBe('apps/field/src/policy.ts');
    expect(undeclared[0]?.detail).toContain("'projects.purge'");
  });

  it('MUTATION: an area missing one half in the registry itself fails closed', () => {
    const violations = checkAppPermissions([
      registryWith(['projects.read', 'work.read', 'work.write']),
      sessionOf('web', ['projects.read', 'work.read', 'work.write'], ['projects.read', 'work.read', 'work.write']),
      sessionOf('field', ['work.read', 'work.write'], ['work.read', 'work.write']),
      sessionOf('desktop', ['work.read', 'work.write'], ['work.read', 'work.write']),
    ]);
    const missing = violationsOf(violations, 'registry-area-half-missing');
    expect(missing.length).toBe(1);
    expect(missing[0]?.file).toBe(CAPABILITY_REGISTRY_FILE);
    expect(missing[0]?.detail).toContain("'projects'");
    expect(missing[0]?.detail).toContain("'write'");
  });

  it('MUTATION: session/policy baseline drift fails closed naming both sides', () => {
    const violations = checkAppPermissions([
      registryWith(registryNames),
      // web grants projects.read but its policy allows work.read too.
      sessionOf('web', ['projects.read'], ['projects.read', 'work.read']),
      sessionOf('field', registryNames, registryNames),
      sessionOf('desktop', registryNames, registryNames),
    ]);
    const drift = violationsOf(violations, 'permission-baseline-drift');
    expect(drift.length).toBe(1);
    expect(drift[0]?.file).toBe('apps/web/src/session/session.ts');
    expect(drift[0]?.detail).toContain('work.read');
    expect(drift[0]?.detail).toContain('allowed by the policy but not granted');
  });

  it('MUTATION: a session without a statically analyzable baseline fails closed', () => {
    const violations = checkAppPermissions([
      registryWith(registryNames),
      file('apps/web/src/session/session.ts', "export const capabilities: readonly string[] = ['projects.read'];\n"),
      sessionOf('field', registryNames, registryNames),
      sessionOf('desktop', registryNames, registryNames),
    ]);
    const unparseable = violationsOf(violations, 'session-baseline-unparseable');
    expect(unparseable.length).toBe(1);
    expect(unparseable[0]?.file).toBe('apps/web/src/session/session.ts');
  });

  it('FAIL-CLOSED: a missing capability registry is a failure, never a skip', () => {
    const violations = checkAppPermissions([
      sessionOf('web', registryNames, registryNames),
      sessionOf('field', registryNames, registryNames),
      sessionOf('desktop', registryNames, registryNames),
    ]);
    const missing = violationsOf(violations, 'capability-registry-missing');
    expect(missing.length).toBe(1);
    expect(missing[0]?.file).toBe(CAPABILITY_REGISTRY_FILE);
  });

  it('FAIL-CLOSED: an unparseable capability registry is a failure, never a skip', () => {
    const violations = checkAppPermissions([
      file(CAPABILITY_REGISTRY_FILE, 'export const capabilities: readonly string[] = [];\n'),
      sessionOf('web', registryNames, registryNames),
      sessionOf('field', registryNames, registryNames),
      sessionOf('desktop', registryNames, registryNames),
    ]);
    const unparseable = violationsOf(violations, 'capability-registry-unparseable');
    expect(unparseable.length).toBe(1);
    expect(unparseable[0]?.file).toBe(CAPABILITY_REGISTRY_FILE);
  });

  it('FAIL-CLOSED: a client with no source tree is a failure, never a skip', () => {
    const violations = checkAppPermissions([
      registryWith(registryNames),
      sessionOf('field', registryNames, registryNames),
      sessionOf('desktop', registryNames, registryNames),
    ]);
    const missing = violationsOf(violations, 'client-source-missing');
    expect(missing.length).toBe(1);
    expect(missing[0]?.file).toBe('apps/web/src');
  });

  it('FAIL-CLOSED: a client without its session module is a failure, never a skip', () => {
    const violations = checkAppPermissions([
      registryWith(registryNames),
      file('apps/web/src/shell.ts', 'export const shell = "view";\n'),
      sessionOf('field', registryNames, registryNames),
      sessionOf('desktop', registryNames, registryNames),
    ]);
    const missing = violationsOf(violations, 'client-session-missing');
    expect(missing.length).toBe(1);
    expect(missing[0]?.file).toBe('apps/web/src/session/session.ts');
  });
});

// ---------------------------------------------------------------------------
// The shared tree pass — determinism of the loader every check consumes.
// ---------------------------------------------------------------------------

describe('the shared tree pass (determinism)', () => {
  it('loads the real tree as ONE memoized, sorted, duplicate-free pass', () => {
    const first = loadRepoTree();
    expect(loadRepoTree()).toBe(first); // memoized: every check shares one pass
    const paths = first.map((repoFile) => repoFile.path);
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toStrictEqual(sorted); // no filesystem-ordering assumptions
    expect(new Set(paths).size).toBe(paths.length); // no duplicate reads
    expect(paths).toContain('packages/contracts/src/index.ts');
    expect(paths).toContain('apps/web/src/session/session.ts');
  });
});
