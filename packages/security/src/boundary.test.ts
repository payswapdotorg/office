import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-036 security — package boundary self-gate (the structural half of the
// acceptance). These checks mirror the work item's boundary: @office/security
// depends ONLY on the six declared workspace packages (@office/authz,
// @office/actions, @office/app-runtime, @office/events, @office/contracts,
// @office/domain-kernel), never imports domain/intelligence/sync/adapters/
// agents/client-sync/app-sdk/app-runtime-forbidden paths, carries no SQL or
// direct-store vocabulary, no provider vocabulary, no network I/O, no wall
// clock or randomness in the LOGIC modules (the harness is the deterministic
// fixture module — fixed epoch, injected clock, exactly like every landed
// package's test-support), and ships a source entry point with no build
// output. The BEHAVIORAL half of the proof (the conformance checks driving
// the REAL gateway + REAL app runtime) lives in the conformance suites.
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

const listNested = (dir: string): string[] =>
  readdirSync(join(srcDir, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();

const allSrcFiles = (): string[] => [
  ...listSrcFiles(),
  ...listNested('conformance'),
  ...listNested('access-review'),
  ...listNested('alerts'),
  ...listNested('retention'),
];

/** The LOGIC files (the model + evaluators — not the test suites). */
const logicFiles = (): string[] => allSrcFiles().filter((file) => !file.endsWith('.test.ts'));

/**
 * The RUNTIME modules — every logic file EXCEPT the deterministic conformance
 * harness (the fixture module that wires the REAL gateway + REAL app runtime
 * for the suites, exactly like every landed package's test-support: fixed
 * epoch, injected clock, sequential id suppliers).
 */
const runtimeModules = (): string[] =>
  logicFiles().filter((file) => file !== 'conformance/harness.ts');

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

/** The workspace packages this package depends on (the whole dependency set). */
const DECLARED_DEPENDENCIES = [
  '@office/actions',
  '@office/app-runtime',
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
  '@office/events',
] as const;

/** Packages this package must never import (value or type) — path forms for
 *  the domain/intelligence trees so '@office/domain-kernel' never self-matches. */
const FORBIDDEN_PACKAGES = [
  'packages/domain/',
  'packages/intelligence/',
  '@office/adapters-sdk',
  '@office/adapter-model',
  '@office/adapter-construction',
  '@office/agents',
  '@office/client-sync',
  '@office/sync',
  '@office/workflows',
  '@office/app-sdk',
] as const;

/** Direct-store vocabulary (THE no-direct-mutation structural rule, A11). */
const storeVocabulary =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b/i;

/** Network I/O vocabulary (no sockets, no fetch, no HTTP anywhere). */
const networkVocabulary = /\b(?:fetch\s*\(|\bhttp?s?:\/\/|new\s+(?:Server|Socket)|net\.connect|tls\.connect)/i;

/** Ledger mutation vocabulary (the audit trail is immutable — append + read only). */
const ledgerMutationVocabulary = /\b(?:ledger\.(?:remove|delete|update|truncate|clear|pop|shift|drop))\b/i;

/**
 * Source files the import-boundary scans run over: every src file EXCEPT this
 * scanner itself — its own check code must NAME the very specifiers and
 * packages it scans for, so scanning it would self-match by construction.
 */
const scannedSrcFiles = (): string[] =>
  allSrcFiles().filter((file) => file !== 'boundary.test.ts');

describe('security package boundary (OFF-036)', () => {
  it('is @office/security 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/security');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the six workspace dependencies and nothing external', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/actions': 'workspace:^',
      '@office/app-runtime': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/events': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the package, the six dependencies, node builtins, and vitest (tests)', () => {
    const violations: string[] = [];
    const allowed = [...DECLARED_DEPENDENCIES];
    for (const file of scannedSrcFiles()) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          (allowed as readonly string[]).includes(specifier) ||
          (isTest && specifier === 'vitest');
        if (!permitted) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports domain/intelligence/sync/adapters/agents/client-sync/app-sdk/workflows', () => {
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
    for (const file of allSrcFiles()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      if (providerVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the LOGIC files contain no non-determinism primitives (no wall clock, no randomness)', () => {
    const violations: string[] = [];
    const nondeterminism = new RegExp(
      `\\b(${['Date' + '.now', 'Math' + '.random', 'crypto' + '.randomUUID'].join('|')})\\b|\\bset(${'Time' + 'out'}|${'Inter' + 'val'})\\b`,
    );
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (nondeterminism.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the RUNTIME modules construct no wall-clock Date at all (pure modules; the harness owns the fixed epoch)', () => {
    const violations: string[] = [];
    const wallClock = /\bnew\s+Date\b/;
    for (const file of runtimeModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (wallClock.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the LOGIC files carry no SQL or direct-store vocabulary (A11: no forks, no repositories)', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (storeVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('carries no network I/O vocabulary anywhere', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (networkVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never mutates the audit ledger through a deletion surface (immutability, freeze A3)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (ledgerMutationVocabulary.test(text)) {
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
