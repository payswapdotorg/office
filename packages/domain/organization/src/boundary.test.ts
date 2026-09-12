import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-007 organization domain — package boundary self-gate. These checks
// mirror the work item's acceptance boundary: @office/domain-organization
// declares exactly four runtime dependencies (@office/contracts,
// @office/domain-kernel, @office/authz, @office/persistence — the declared
// dependency graph of OFF-007), imports nothing else outside the package
// outside of tests, NEVER imports @office/events (out of this item's
// dependency graph — the EventSink port is the seam the ledger implements),
// carries no provider vocabulary, and ships its forward-only migration
// co-located with the package (version 0100+, applied through
// @office/persistence's migrator conventions). Deterministic: filesystem
// reads only.
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

// The forbidden events package name is assembled from fragments so this
// scan can never match its own source (same trick as the provider
// vocabulary below).
const eventsPackage = ['@office', '/events'].join('');

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source (the acceptance gate forbids those names anywhere in
// this package).
const providerVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp'].join('|')})\\b`,
  'i',
);

describe('organization domain package boundary (OFF-007)', () => {
  it('is @office/domain-organization 0.1.0, private, ESM', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/domain-organization');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed workspace dependencies: contracts, domain-kernel, authz, persistence', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/authz': 'workspace:^',
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
          specifier === '@office/persistence' ||
          (isTest && specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports @office/events (out of the OFF-007 dependency graph; the EventSink port is the seam)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (importSpecifiers(text).includes(eventsPackage)) {
        offenders.push(file);
      }
      if (text.includes(`'${eventsPackage}`)) {
        offenders.push(`${file} (string literal reference)`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('ships its co-located migration numbered 0100 onward (forward-only, persistence migrator conventions)', () => {
    expect(existsSync(migrationsDir)).toBe(true);
    const files = listFiles(migrationsDir, '.sql');
    expect(files.length).toBeGreaterThanOrEqual(1);
    const versions = files.map((fileName) => Number(fileName.slice(0, 4)));
    for (const fileName of files) {
      expect(fileName).toMatch(/^\d{4}_[a-z][a-z0-9_]*\.sql$/);
    }
    for (const version of versions) {
      expect(version).toBeGreaterThanOrEqual(100);
    }
    expect(versions).toStrictEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
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
    for (const required of ['state.ts', 'events.ts', 'repository.ts', 'commands.ts', 'migrations.ts']) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
