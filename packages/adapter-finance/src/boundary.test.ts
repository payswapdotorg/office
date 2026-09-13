import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-024 adapter-finance — package boundary self-gate. These checks mirror
// the work item's acceptance boundary: @office/adapter-finance declares
// exactly THREE workspace dependencies (@office/adapters-sdk — THE Adapter
// contract, engines, and ports it implements; @office/contracts; and
// @office/domain-kernel — Result/DomainError), imports nothing else outside
// the package outside of tests (node builtins allowed — the crypto digest
// only in sources), never imports a core domain/sync/actions/workflows/
// agents or app-runtime/client-sdk/persistence/authz/events package (the
// canonical cost domain is NOT imported — reconciliation works on TYPED
// summaries + SourceRef mappings), carries NO real vendor vocabulary in code
// (the GENERIC 'erp-finance' family descriptor is the sanctioned vocabulary;
// identifiers and string values stay generic), and performs NO I/O of its
// own (ports only: no fs, no net, no process spawning, no database env, no
// SQL, no migrations — and no wall clock or randomness anywhere: injected
// clock/id suppliers only). Deterministic: filesystem reads only.

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

// This package's own canonical name and the three allowed dependencies,
// assembled from fragments so the string-literal scans cannot match the
// test's own source.
const ownPackageName = ['@office', '/adapter-finance'].join('');
const allowedPackages = [
  ['@office', '/adapters-sdk'].join(''),
  ['@office', '/contracts'].join(''),
  ['@office', '/domain-ke', 'rnel'].join(''),
] as const;
// Every OTHER @office/domain-* package is a merged domain package — this
// adapter must never import one (domains own the canonical semantics;
// adapters translate, they do not own — freeze A6).
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
  ['@office', '/intelligence'].join(''),
  ['@office', '/security'].join(''),
] as const;
// The environment variable name persistence wiring would need, assembled so
// the pure-ports scan cannot match the test's own source.
const databaseUrlLiteral = ['DATABASE', '_URL'].join('');

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source. Comments may describe the ERP/finance adapter family
// generically (the work item's own descriptor — 'erp-finance' IS the
// sanctioned generic kind); IDENTIFIERS and STRING VALUES stay generic — a
// REAL vendor name in actual code is the violation. The generic 'erp'
// word itself is deliberately NOT banned: it is this family's sanctioned
// generic vocabulary ('erp-finance', 'erp-instance-01').
const providerVocabulary = new RegExp(
  `\\b(${[
    's' + 'ap',
    'or' + 'acle',
    'net' + 'suite',
    'quick' + 'books',
    'xe' + 'ro',
    'dyn' + 'amics',
    'sa' + 'ge',
    'work' + 'day',
    'in' + 'for',
  ].join('|')})\\b`,
  'i',
);

// Node builtins the package's own SOURCE may touch: the crypto digest only
// (pure sha256 derivations — the webhook signature/checksum and conflict-id
// conventions). Tests may additionally use the fs/path/url builtins this
// boundary scan itself needs.
const SOURCE_NODE_MODULES = new Set(['node:crypto']);
const TEST_NODE_MODULES = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url']);

// The I/O-free determinism scan. Sources: no wall clock, no randomness, no
// Date construction at all. Tests: no wall clock and no randomness either
// (fixtures must be fixed constants).
const wallClockPattern = /(?:Date\s*\.\s*now|Math\s*\.\s*random)/;
const dateConstructionPattern = /new\s+Date\s*\(/;

describe('adapter-finance package boundary (OFF-024)', () => {
  it('carries the canonical adapter-finance package identity (0.1.0, private, ESM)', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe(ownPackageName);
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed workspace dependencies: adapters-sdk, contracts, domain-kernel', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/adapters-sdk': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only allowed modules outside the package (node builtins + the three office packages)', () => {
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

  it('never imports a domain package, a runtime package, an apps/* module, authz/events, or intelligence', () => {
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
        // Any other @office/* workspace package beyond the three declared
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

  it('contains no real vendor vocabulary in any source or test file CODE (comments excluded)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      // Comments may carry the work item's generic ERP/finance descriptor;
      // identifiers and string values must stay generic — a real ERP/finance
      // vendor name in code is the violation.
      const code = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (providerVocabulary.test(code)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('keeps the generic ERP/finance vocabulary discipline (the sanctioned generic identity)', () => {
    // The adapter family kind, provider system, object kinds, and canonical
    // kinds are the generic vocabulary the acceptance demands.
    const vocabulary = readFileSync(join(srcDir, 'vocabulary.ts'), 'utf8');
    expect(vocabulary).toContain("'erp-finance'");
    expect(vocabulary).toContain("'erp-instance-01'");
    expect(vocabulary).toContain("'account'");
    expect(vocabulary).toContain("'cost-code'");
    expect(vocabulary).toContain("'commitment'");
    expect(vocabulary).toContain("'invoice'");
    expect(vocabulary).toContain("'payment'");
    // The canonical kinds are the landed cost domain's own vocabulary.
    expect(vocabulary).toContain("'budget'");
    expect(vocabulary).toContain("'cost-item'");
    expect(vocabulary).toContain("'payment-reference'");
    // The fixture store's object kinds are the generic provider family.
    const fixture = readFileSync(join(srcDir, 'provider-fixture.ts'), 'utf8');
    expect(fixture).toContain("objectType: 'account'");
    expect(fixture).toContain("objectType: 'cost-code'");
    expect(fixture).toContain("objectType: 'commitment'");
    expect(fixture).toContain("objectType: 'invoice'");
    expect(fixture).toContain("objectType: 'payment'");
    // The office-issued identity grammar the fixture references carry (A10:
    // office-issued ids only — provider ids never reach canonical fields).
    const support = readFileSync(join(srcDir, 'test-support.ts'), 'utf8');
    expect(support).toContain("'prj0000000000001'");
    expect(support).toContain("'bud0000000000001'");
    expect(support).toContain("'cst0000000000001'");
    expect(support).toContain("'cmt0000000000001'");
    expect(support).toContain("'inv0000000000001'");
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
    // The package-internal parse plumbing and the deterministic test support
    // are deliberately NOT re-exported.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes("from './parse'")).toBe(false);
    expect(index.includes("from './test-support'")).toBe(false);
  });

  it('keeps the required adapter modules present', () => {
    for (const required of [
      'vocabulary.ts',
      'parse.ts',
      'snapshot-translation.ts',
      'mappings.ts',
      'adapter.ts',
      'provider-fixture.ts',
      'sync.ts',
      'reconciliation.ts',
      'conflict-discipline.ts',
      'webhook-ingest.ts',
      'index.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
