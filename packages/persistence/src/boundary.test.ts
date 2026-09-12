import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-004 persistence — package boundary self-gate. These checks mirror the
// work item's acceptance boundary: @office/persistence declares exactly three
// runtime dependencies (@office/contracts, @office/domain-kernel, pg — the
// lead-directed repository-equivalent SQL mapping), imports nothing else
// outside the package outside of tests, keeps embedded-postgres OUT of the
// static import graph (it is a ROOT devDependency loaded dynamically by the
// test harness only), carries no provider vocabulary, and ships ordered
// plain-SQL migrations. Deterministic: filesystem reads only.
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
  const pattern = /\bfrom\s+['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source (the acceptance gate forbids those names anywhere in
// this package).
const providerVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp'].join('|')})\\b`,
  'i',
);

describe('persistence package boundary (OFF-004)', () => {
  it('is @office/persistence 0.1.0, private, ESM', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/persistence');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed runtime dependencies: contracts, domain-kernel, pg', () => {
    const pkg = readPackageJson();
    const dependencies = pkg['dependencies'] as Record<string, unknown>;
    expect(Object.keys(dependencies).sort()).toStrictEqual([
      '@office/contracts',
      '@office/domain-kernel',
      'pg',
    ]);
    expect(dependencies['@office/contracts']).toBe('workspace:^');
    expect(dependencies['@office/domain-kernel']).toBe('workspace:^');
    expect(String(dependencies['pg'])).toMatch(/^\^?\d+\.\d+\.\d+$/);
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only allowed modules outside the package (node stdlib + test-only vitest)', () => {
    // Node builtin modules (`node:*`) are runtime stdlib, not dependencies —
    // the migrator (fs/path/crypto) and test harness (net/fs) use them. The
    // dependency boundary itself is asserted separately against package.json.
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
          specifier === 'pg' ||
          (isTest && specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never statically imports embedded-postgres (root devDependency, dynamic test-harness load only)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (importSpecifiers(text).includes('embedded-postgres')) {
        offenders.push(`${file} (static import)`);
      }
      const dynamicImport = /import\s*\(\s*['"]embedded-postgres['"]\s*\)/;
      if (dynamicImport.test(text) && file !== 'testing.ts') {
        offenders.push(`${file} (dynamic import outside the test harness)`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('ships ordered plain-SQL migrations (no ORM schema, no engines)', () => {
    expect(existsSync(migrationsDir)).toBe(true);
    const files = listFiles(migrationsDir, '.sql');
    expect(files.length).toBeGreaterThanOrEqual(2);
    const versions = files.map((fileName) => Number(fileName.slice(0, 4)));
    for (const fileName of files) {
      expect(fileName).toMatch(/^\d{4}_[a-z][a-z0-9_]*\.sql$/);
    }
    expect(versions).toStrictEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(existsSync(join(packageRoot, 'prisma'))).toBe(false);
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

  it('keeps the required foundation modules present', () => {
    for (const required of [
      'sql.ts',
      'failure.ts',
      'scope.ts',
      'pool.ts',
      'transaction.ts',
      'migrator.ts',
      'tenants.ts',
      'projects.ts',
      'testing.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
