import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-020 adapters-sdk — package boundary self-gate. These checks mirror the
// work item's acceptance boundary: @office/adapters-sdk declares exactly four
// workspace dependencies (@office/contracts, @office/domain-kernel,
// @office/authz, @office/events), imports nothing else outside the package
// outside of tests (node builtins allowed — crypto digests only in sources),
// NEVER imports a domain package (the merged domain packages own the
// canonical semantics; adapters translate, they do not own), imports nothing
// under apps/*, carries NO provider vocabulary (the fake fixture uses generic
// names — 'fake-crm' over 'contact' objects; the OFF-021+ adapter packages
// own real names), and performs NO I/O of its own (ports only: no fs, no
// net, no process spawning, no database env, no SQL, no migrations — and no
// wall clock or randomness anywhere: injected clock/id suppliers only).
// Deterministic: filesystem reads only.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const listFiles = (dir: string, suffix: string): string[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .sort();

/** Strip line and block comments so only real import/export syntax is scanned. */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const importSpecifiers = (text: string): string[] => {
  const specifiers: string[] = [];
  // Only import/export statement clauses: a bare `from '...'` can also occur
  // inside string literals (error messages), which are not imports. The
  // clause must belong to a statement that begins with the import/export
  // keyword and terminates with `;`.
  const pattern = /\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]\s*;/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

// This package's own canonical name, assembled so the string-literal scans
// cannot match the test's own source.
const ownPackageName = ['@office', '/adapters-sdk'].join('');
// The shared kernel is a workspace dependency of this package (it lives in
// packages/domain-kernel, NOT under packages/domain/); assembled from
// fragments like the prefix below so the scan cannot match its own source.
const kernelPackage = ['@office', '/domain-ke', 'rnel'].join('');
// Every OTHER @office/domain-* package is a merged domain package — the
// adapters SDK must never import one (no domain-to-adapter coupling: the SDK
// is the translation seam, domains own the canonical semantics).
const domainPackagePrefix = ['@office', '/domain-'].join('');
// The environment variable name persistence wiring would need, assembled so
// the pure-ports scan cannot match the test's own source.
const databaseUrlLiteral = ['DATABASE', '_URL'].join('');

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source (the acceptance gate forbids those names anywhere in
// this package — the fake fixture uses generic vocabulary; the OFF-021+
// adapter packages own the real names).
const providerVocabulary = new RegExp(
  `\\b(${[
    'pro' + 'core',
    'auto' + 'desk',
    'prim' + 'avera',
    'e' + 'rp',
    'ms' + '-project',
    'p' + '6',
  ].join('|')})\\b`,
  'i',
);

// Node builtins the SDK's own source may touch: crypto digests only (pure
// sha256 derivations). Tests may additionally use the fs/path/url builtins
// this boundary scan itself needs.
const SOURCE_NODE_MODULES = new Set(['node:crypto']);
const TEST_NODE_MODULES = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url']);

// The I/O-free determinism scan. Sources: no wall clock, no randomness, no
// Date construction at all. Tests: no wall clock and no randomness either
// (fixtures must be fixed constants) — but `new Date(<fixed instant>)` is an
// acceptable TEST CONSTANT (it feeds the fail-closed parse checks).
const wallClockPattern = /(?:Date\s*\.\s*now|Math\s*\.\s*random)/;
const dateConstructionPattern = /new\s+Date\s*\(/;

describe('adapters-sdk package boundary (OFF-020)', () => {
  it('carries the canonical adapters-sdk package identity (0.1.0, private, ESM)', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe(ownPackageName);
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed workspace dependencies: contracts, domain-kernel, authz, events', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/events': 'workspace:^',
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
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('.') ||
          (specifier.startsWith('node:')
            ? isTest
              ? TEST_NODE_MODULES.has(specifier)
              : SOURCE_NODE_MODULES.has(specifier)
            : false) ||
          specifier === '@office/contracts' ||
          specifier === '@office/domain-kernel' ||
          specifier === '@office/authz' ||
          specifier === '@office/events' ||
          (isTest && specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports a domain package, an apps/* module, or another workspace package', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (specifier.startsWith(domainPackagePrefix) && specifier !== kernelPackage) {
          offenders.push(`${file}: '${specifier}'`);
        }
        if (specifier.startsWith('apps/') || specifier.includes('/apps/')) {
          offenders.push(`${file}: '${specifier}'`);
        }
        // Any other @office/* workspace package beyond the four declared
        // dependencies is a boundary violation (e.g. persistence,
        // test-fixtures).
        if (
          specifier.startsWith('@office/') &&
          specifier !== '@office/contracts' &&
          specifier !== '@office/domain-kernel' &&
          specifier !== '@office/authz' &&
          specifier !== '@office/events'
        ) {
          offenders.push(`${file}: '${specifier}'`);
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

  it('contains no provider vocabulary in any source or test file', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      if (providerVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
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

  it('ships a source entry point with no build output and no test-only surface leak', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
    // The package-internal parse plumbing is deliberately NOT re-exported.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes("from './parse'")).toBe(false);
  });

  it('keeps the required SDK modules present', () => {
    for (const required of [
      'json.ts',
      'identity.ts',
      'source-ref.ts',
      'mapping.ts',
      'cursor.ts',
      'conflict.ts',
      'snapshot.ts',
      'adapter.ts',
      'webhook.ts',
      'commands.ts',
      'sync.ts',
      'fake-provider.ts',
      'index.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
