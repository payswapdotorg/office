import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-009 field domain — package boundary self-gate. These checks mirror the
// work item's acceptance boundary (and the sibling identity modules'
// self-gates): @office/domain-field declares exactly five workspace
// dependencies (@office/contracts, @office/domain-kernel, @office/authz,
// @office/persistence — the EventSink port's SqlExecutor type — and
// @office/events, which IS in this item's dependency graph for the
// ledger-backed sink adapter), imports nothing else outside the package
// outside of tests, NEVER imports another domain package (no
// domain-to-domain imports — the EventSink port is mirrored in shape, which
// any transactional implementation satisfies structurally), stays PURE DOMAIN
// (no SQL, no migrations, no repository layer), carries no provider
// vocabulary, and reads no wall clock and no randomness in its sources
// (injected suppliers only). Deterministic: filesystem reads only.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');
const migrationsDir = join(packageRoot, 'migrations');

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

// Sibling domain package names are assembled from fragments so this scan can
// never match its own source (same trick as the provider vocabulary below).
const otherDomainPackages = [
  ['@office/domain', '-organization'].join(''),
  ['@office/domain', '-projects'].join(''),
];

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source (the acceptance gate forbids those names anywhere in
// this package).
const providerVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp'].join('|')})\\b`,
  'i',
);

const ALLOWED_SPECIFIERS = new Set([
  '@office/contracts',
  '@office/domain-kernel',
  '@office/authz',
  '@office/persistence',
  '@office/events',
]);

describe('field domain package boundary (OFF-009)', () => {
  it('is @office/domain-field 0.1.0, private, ESM', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/domain-field');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed workspace dependencies: contracts, domain-kernel, authz, persistence, events', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/persistence': 'workspace:^',
      '@office/events': 'workspace:^',
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
          ALLOWED_SPECIFIERS.has(specifier) ||
          (isTest && specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports another domain package (no domain-to-domain imports; the EventSink port is the seam)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (specifier.startsWith('@office/domain-') && !ALLOWED_SPECIFIERS.has(specifier)) {
          offenders.push(`${file}: '${specifier}'`);
        }
      }
      for (const forbidden of otherDomainPackages) {
        if (text.includes(`'${forbidden}`) || text.includes(`"${forbidden}`)) {
          offenders.push(`${file} (string literal reference to ${forbidden})`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('is pure domain: no migrations, no SQL driver imports, no build output', () => {
    expect(existsSync(migrationsDir)).toBe(false);
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);

    // The driver references are assembled from fragments so this scan can
    // never match its own source.
    const pgImport = ['from ', '\'pg\''].join('');
    const embeddedPostgres = ['embedded', '-postgres'].join('');
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      expect(text.includes(pgImport), file).toBe(false);
      expect(text.includes(embeddedPostgres), file).toBe(false);
      expect(/\bINSERT INTO\b|\bSELECT \* FROM\b|\bCREATE TABLE\b/.test(text), file).toBe(false);
    }
  });

  it('reads no wall clock and no randomness in its domain sources (injected suppliers only)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      if (file.endsWith('.test.ts')) continue;
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (text.includes('Date.now(') || text.includes('Date.UTC(')) offenders.push(`${file}: wall clock`);
      if (text.includes('Math.random(')) offenders.push(`${file}: randomness`);
      if (text.includes('crypto.')) offenders.push(`${file}: crypto`);
    }
    expect(offenders).toStrictEqual([]);
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

  it('keeps the required domain modules present', () => {
    for (const required of [
      'state.ts',
      'parse.ts',
      'events.ts',
      'store.ts',
      'commands.ts',
      'projection.ts',
      'ledger-sink.ts',
      'index.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
