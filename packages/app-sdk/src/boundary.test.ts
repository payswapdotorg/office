import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-025 app-sdk — package boundary self-gate. These checks mirror the
// work item's acceptance boundary: @office/app-sdk depends ONLY on the
// four declared workspace packages (@office/actions TYPE-ONLY — an
// importing app's runtime graph stays contracts/authz/domain-kernel),
// never imports domain/intelligence/sync/adapters/agents/client-sync
// packages, carries no provider vocabulary, no wall clock, no randomness,
// and ships a source entry point with no build output. Deterministic:
// filesystem reads only.
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

/** The workspace packages this SDK depends on. */
const RUNTIME_DEPENDENCIES = [
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
] as const;

/** The TYPE-ONLY dependency (the frozen-A8 action class vocabulary). */
const TYPE_ONLY_DEPENDENCY = '@office/actions';

/** Packages an app graph must never contain (the dependency rule). */
const FORBIDDEN_PACKAGES = [
  '@office/adapters-sdk',
  '@office/client-sync',
  '@office/sync',
  'packages/domain/',
  'packages/intelligence/',
] as const;

/**
 * Source files the import-boundary scans run over: every src file EXCEPT this
 * scanner itself — its own check code must NAME the very specifiers and
 * packages it scans for, so scanning it would self-match by construction.
 */
const scannedSrcFiles = (): string[] =>
  listSrcFiles().filter((file) => file !== 'boundary.test.ts');

describe('app-sdk package boundary (OFF-025)', () => {
  it('is @office/app-sdk 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/app-sdk');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the four workspace dependencies and nothing external', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/actions': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the package, the four dependencies, and node builtins', () => {
    const violations: string[] = [];
    const allowed = [...RUNTIME_DEPENDENCIES, TYPE_ONLY_DEPENDENCY];
    for (const file of scannedSrcFiles()) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          allowed.includes(specifier) ||
          (isTest && specifier === 'vitest');
        if (!permitted) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('consumes @office/actions TYPE-ONLY (an importing app pulls no actions runtime)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      if (file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(srcDir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes(`from '${TYPE_ONLY_DEPENDENCY}'`)) continue;
        const trimmed = line.trim();
        // Both `import type` and the type-only re-export (`export type`) keep
        // @office/actions out of the runtime graph; a VALUE import does not.
        if (!trimmed.startsWith('import type') && !trimmed.startsWith('export type')) {
          violations.push(`${file}: value import of ${TYPE_ONLY_DEPENDENCY}`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports domain/intelligence/sync/adapters packages (value or type)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      for (const forbidden of FORBIDDEN_PACKAGES) {
        if (text.includes(forbidden)) {
          violations.push(`${file}: '${forbidden}'`);
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

  it('uses no wall clock and no randomness anywhere in src (determinism)', () => {
    const violations: string[] = [];
    const nondeterminism = /\bDate\.now\b|\bMath\.random\b|\bnew Date\b|\bcrypto\.randomUUID\b/;
    for (const file of listSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (nondeterminism.test(text)) {
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
});
