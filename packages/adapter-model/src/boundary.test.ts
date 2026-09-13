import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-022 adapter-model — package boundary self-gate. These checks mirror
// the work item's acceptance boundary: @office/adapter-model declares
// exactly four workspace dependencies (@office/adapters-sdk,
// @office/intelligence-relationships — CONSUMED AS TYPES ONLY,
// @office/contracts, @office/domain-kernel), imports nothing else outside
// the package outside of tests (node builtins allowed — crypto digests only
// in sources), never imports a core domain/sync/actions/workflows/agents or
// app-runtime/client-sdk package, carries NO provider vocabulary in code
// (comments may describe the Autodesk-CLASS family generically; identifiers
// and string values stay generic — 'model-cde' over 'model-instance-01'),
// and performs NO I/O of its own (ports only: no fs, no net, no process
// spawning, no database env, no SQL, no migrations — and no wall clock or
// randomness anywhere: injected clock/id suppliers only).
// Deterministic: filesystem reads only.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;

const listFiles = (dir: string, suffix: string): string[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .sort();

/** Strip line and block comments so only real import/export syntax is scanned. */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

interface ImportStatement {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

const importStatements = (text: string): ImportStatement[] => {
  const statements: ImportStatement[] = [];
  // Only import/export statement clauses: a bare `from '...'` can also occur
  // inside string literals (error messages), which are not imports. The
  // clause must belong to a statement that begins with the import/export
  // keyword and terminates with `;`.
  const pattern = /\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]\s*;/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    const statement = match[0];
    if (specifier === undefined) continue;
    statements.push({
      specifier,
      typeOnly: /\bimport\s+type\b|\bexport\s+type\b/.test(statement),
    });
  }
  return statements;
};

// This package's own canonical name and the four allowed dependencies,
// assembled from fragments so the string-literal scans cannot match the
// test's own source.
const ownPackageName = ['@office', '/adapter-model'].join('');
const allowedPackages = [
  ['@office', '/adapters-sdk'].join(''),
  ['@office', '/contracts'].join(''),
  ['@office', '/domain-ke', 'rnel'].join(''),
  ['@office', '/intelligence-relatio', 'nships'].join(''),
] as const;
// The intelligence package is consumed AS TYPES ONLY: no logic import may
// reference it (the frozen OFF-022 boundary).
const typesOnlyPackage = allowedPackages[3];
// Every OTHER @office/domain-* package is a merged domain package — this
// adapter must never import one (domains own the canonical semantics;
// adapters translate, they do not own).
const domainPackagePrefix = ['@office', '/domain-'].join('');
const kernelPackage = allowedPackages[2];
// Core runtime packages this adapter must stay decoupled from (the SDK is
// THE only adapter-contract seam; the runtime consumes adapters, never the
// reverse), assembled from fragments so the scan cannot match its own source.
const forbiddenPackages = [
  ['@office', '/sync'].join(''),
  ['@office', '/actions'].join(''),
  ['@office', '/workflows'].join(''),
  ['@office', '/agents'].join(''),
  ['@office', '/app-sdk'].join(''),
  ['@office', '/app-runtime'].join(''),
  ['@office', '/client-sync'].join(''),
  ['@office', '/client-sdk'].join(''),
  ['@office', '/persistence'].join(''),
  ['@office', '/test-fixtures'].join(''),
  ['@office', '/authz'].join(''),
  ['@office', '/events'].join(''),
] as const;
// The environment variable name persistence wiring would need, assembled so
// the pure-ports scan cannot match the test's own source.
const databaseUrlLiteral = ['DATABASE', '_URL'].join('');

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source. Comments may describe the Autodesk-CLASS adapter
// family (the work item's own descriptor); IDENTIFIERS and STRING VALUES
// stay generic — a provider name in actual code is the violation.
const providerVocabulary = new RegExp(
  `\\b(${['auto' + 'desk', 'pro' + 'core', 'prim' + 'avera', 'e' + 'rp', 'ms' + '-project', 'p' + '6'].join('|')})\\b`,
  'i',
);

// Node builtins the package's own SOURCE may touch: crypto digests only
// (pure sha256 derivations). Tests may additionally use the fs/path/url
// builtins this boundary scan itself needs.
const SOURCE_NODE_MODULES = new Set(['node:crypto']);
const TEST_NODE_MODULES = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url']);

// The I/O-free determinism scan. Sources: no wall clock, no randomness, no
// Date construction at all. Tests: no wall clock and no randomness either
// (fixtures must be fixed constants).
const wallClockPattern = /(?:Date\s*\.\s*now|Math\s*\.\s*random)/;
const dateConstructionPattern = /new\s+Date\s*\(/;

describe('adapter-model package boundary (OFF-022)', () => {
  it('carries the canonical adapter-model package identity (0.1.0, private, ESM)', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe(ownPackageName);
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed workspace dependencies: adapters-sdk, intelligence-relationships, contracts, domain-kernel', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/adapters-sdk': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/intelligence-relationships': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only allowed modules outside the package (node builtins + the four office packages)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const statement of importStatements(text)) {
        const allowed =
          statement.specifier.startsWith('.') ||
          (statement.specifier.startsWith('node:')
            ? isTest
              ? TEST_NODE_MODULES.has(statement.specifier)
              : SOURCE_NODE_MODULES.has(statement.specifier)
            : false) ||
          (allowedPackages as readonly string[]).includes(statement.specifier) ||
          (isTest && statement.specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${statement.specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports a domain package, a runtime package, an apps/* module, or authz/events', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const statement of importStatements(text)) {
        if (
          statement.specifier.startsWith(domainPackagePrefix) &&
          statement.specifier !== kernelPackage
        ) {
          offenders.push(`${file}: '${statement.specifier}'`);
        }
        if ((forbiddenPackages as readonly string[]).includes(statement.specifier)) {
          offenders.push(`${file}: '${statement.specifier}'`);
        }
        if (statement.specifier.startsWith('apps/') || statement.specifier.includes('/apps/')) {
          offenders.push(`${file}: '${statement.specifier}'`);
        }
        // Any other @office/* workspace package beyond the four declared
        // dependencies is a boundary violation.
        if (
          statement.specifier.startsWith('@office/') &&
          !(allowedPackages as readonly string[]).includes(statement.specifier)
        ) {
          offenders.push(`${file}: '${statement.specifier}'`);
        }
      }
      if (text.includes(`'${domainPackagePrefix}`) && !text.includes(`'${kernelPackage}`)) {
        offenders.push(`${file} (string literal reference)`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('consumes @office/intelligence-relationships AS TYPES ONLY (no logic imports)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      if (file.endsWith('.test.ts')) continue;
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const statement of importStatements(text)) {
        if (statement.specifier === typesOnlyPackage && !statement.typeOnly) {
          offenders.push(`${file}: value import of '${typesOnlyPackage}'`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('is PURE PORTS: no persistence, no SQL, no database wiring, no migrations', () => {
    expect(existsSync(join(packageRoot, 'migrations'))).toBe(false);
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      expect(text.includes(databaseUrlLiteral), file).toBe(false);
      expect(/SELECT\s|INSERT\s|UPDATE\s+\w+\s+SET|CREATE\s+TABLE/i.test(text), file).toBe(false);
    }
    for (const file of listFiles(packageRoot, '.sql')) {
      throw new Error(`unexpected SQL file in a pure-ports package: ${file}`);
    }
  });

  it('contains no provider vocabulary in any source or test file CODE (comments excluded)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      // Comments may carry the work item's own 'Autodesk-class' descriptor;
      // identifiers and string values must stay generic.
      const code = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (providerVocabulary.test(code)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('keeps the generic model vocabulary discipline (no vendor identity in values)', () => {
    // The adapter family kind, provider system, object kinds, and canonical
    // kinds are the generic vocabulary the acceptance demands.
    const vocabulary = readFileSync(join(srcDir, 'vocabulary.ts'), 'utf8');
    expect(vocabulary).toContain("'model-cde'");
    expect(vocabulary).toContain("'model-instance-01'");
    expect(vocabulary).toContain("'model'");
    expect(vocabulary).toContain("'model-version'");
    expect(vocabulary).toContain("'element'");
    expect(vocabulary).toContain("'element-classification'");
    // The fixture's cross-system link refs use generic families too.
    const fixture = readFileSync(join(srcDir, 'provider-fixture.ts'), 'utf8');
    expect(fixture).toContain("'schedule-planning'");
    expect(fixture).toContain("'construction-cde'");
  });

  it('is deterministic everywhere: no wall clock, no randomness (sources: no Date at all)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (wallClockPattern.test(text)) {
        violations.push(`${file} (wall clock or randomness)`);
      }
      if (!isTest && dateConstructionPattern.test(text)) {
        violations.push(`${file} (Date construction in source)`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('ships a source entry point with no build output, no test-only surface leak, and a README', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
    expect(existsSync(join(packageRoot, 'README.md'))).toBe(true);
    // The package-internal parse plumbing is deliberately NOT re-exported.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes("from './parse'")).toBe(false);
  });

  it('keeps the required adapter modules present', () => {
    for (const required of [
      'vocabulary.ts',
      'parse.ts',
      'references.ts',
      'change-mapping.ts',
      'notification.ts',
      'adapter.ts',
      'provider-fixture.ts',
      'sync.ts',
      'index.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
