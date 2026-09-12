import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-011 cost domain — package boundary self-gate. These checks mirror
// the work item's acceptance boundary: @office/domain-cost declares
// exactly five workspace dependencies (@office/contracts, @office/domain-kernel,
// @office/authz, @office/events — IN this item's dependency graph for the
// thin ledger-backed EventSink adapter — and @office/persistence for the
// SqlExecutor type of the mirrored EventSink port), imports nothing else
// outside the package outside of tests, NEVER imports another domain package
// (no domain-to-domain imports), carries no provider vocabulary, and ships
// NO persistence of its own (pure domain: no migrations, no SQL — the
// in-memory store is the transactional seam tests use). Deterministic:
// filesystem reads only.
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
  // inside string literals (error messages such as "transition from
  // 'active'"), which are not imports. The clause must belong to a statement
  // that begins with the import/export keyword and terminates with `;`.
  const pattern = /\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]\s*;/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

// Forbidden package-name prefixes are assembled from fragments so this scan
// can never match its own source (same trick as the provider vocabulary
// below). No domain-to-domain imports: the cost package consumes shared
// kernel contracts only, never a sibling domain package (and never itself by
// package name — the surface is src/index.ts).
const domainPackagePrefix = ['@office', '/domain-'].join('');
// The shared kernel is NOT a domain package (different workspace directory:
// packages/domain-kernel); assembled from fragments like the prefix above.
const kernelPackage = ['@office', '/domain-ke', 'rnel'].join('');
// This package's own canonical name, assembled so the string-literal scan
// cannot match the test's own source.
const ownPackageName = ['@office', '/domain-cost'].join('');
// The environment variable name persistence wiring would need, assembled so
// the pure-domain scan cannot match the test's own source.
const databaseUrlLiteral = ['DATABASE', '_URL'].join('');

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source (the acceptance gate forbids those names anywhere in
// this package — the commercial contract is Office-canonical; provider
// import happens in adapter packages owned elsewhere).
const providerVocabulary = new RegExp(
  `\\b(${[
    'pro' + 'core',
    'auto' + 'desk',
    'prim' + 'avera',
    'e' + 'rp',
    'ms' + '-project',
    'p' + '6',
    'quick' + 'books',
    'xa' + 'p',
  ].join('|')})\\b`,
  'i',
);

describe('cost domain package boundary (OFF-011)', () => {
  it('carries the canonical cost package identity (0.1.0, private, ESM)', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe(ownPackageName);
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed workspace dependencies: contracts, domain-kernel, authz, events, persistence', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/events': 'workspace:^',
      '@office/persistence': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only allowed modules outside the package (node stdlib + test-only vitest)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier === '@office/contracts' ||
          specifier === '@office/domain-kernel' ||
          specifier === '@office/authz' ||
          specifier === '@office/events' ||
          specifier === '@office/persistence' ||
          (isTest && specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports another domain package (no domain-to-domain imports)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (specifier.startsWith(domainPackagePrefix) && specifier !== kernelPackage) {
          offenders.push(`${file}: '${specifier}'`);
        }
      }
      if (text.includes(`'${domainPackagePrefix}`) && !text.includes(`'${kernelPackage}`)) {
        offenders.push(`${file} (string literal reference)`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('is PURE DOMAIN: no migrations, no SQL files, no database wiring', () => {
    expect(existsSync(join(packageRoot, 'migrations'))).toBe(false);
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      expect(text.includes(databaseUrlLiteral), file).toBe(false);
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

  it('ships a source entry point with no build output', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
  });

  it('keeps the required domain modules present', () => {
    for (const required of [
      'state.ts',
      'parse.ts',
      'events.ts',
      'store.ts',
      'balances.ts',
      'commands.ts',
      'ledger-sink.ts',
      'index.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
