import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-003 domain kernel — package boundary self-gate. These checks mirror
// the work item's acceptance boundary: @office/domain-kernel depends ONLY
// on @office/contracts (dependency rule: domain modules depend only inward
// on the shared kernel contracts), imports nothing else outside the
// package, and carries no provider vocabulary. Deterministic: filesystem
// reads only.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const listSrcFiles = (): string[] =>
  readdirSync(srcDir)
    .filter((file) => file.endsWith('.ts'))
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

describe('domain-kernel package boundary (OFF-003)', () => {
  it('is @office/domain-kernel 0.1.0, private, ESM', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/domain-kernel');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly one runtime dependency: @office/contracts (workspace)', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/contracts': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only @office/contracts outside the package (plus test-only vitest/node builtins)', () => {
    const violations: string[] = [];
    for (const file of listSrcFiles()) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('.') ||
          specifier === '@office/contracts' ||
          (isTest && (specifier === 'vitest' || specifier.startsWith('node:')));
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no provider vocabulary in any source or test file', () => {
    const violations: string[] = [];
    for (const file of listSrcFiles()) {
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

  it('keeps the required kernel modules present', () => {
    for (const required of ['aggregate.ts', 'invariants.ts', 'idempotency.ts', 'result.ts']) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });
});
