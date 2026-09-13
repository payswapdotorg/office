import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-026 app-runtime — package boundary self-gate (the A8/A11 structural
// half of the acceptance). These checks mirror the work item's boundary:
// @office/app-runtime depends ONLY on the six declared workspace packages
// (@office/persistence TYPE-ONLY — the SqlExecutor surface of the AppEventSink
// port), never imports domain/intelligence/sync/adapters/agents/client-sync/
// events/workflows packages, constructs NO gateway and NO command handler
// (the mutation surface is injected — the behavioral half of the proof, the
// gateway/handler invocation counting, lives in dispatch.test.ts and
// runtime.test.ts), carries no SQL/direct-store vocabulary, no provider
// vocabulary, no wall clock, no randomness, and ships a source entry point
// with no build output. Deterministic: filesystem reads only.
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

/** The LOGIC files (the runtime + its ports — not the test suites). */
const logicFiles = (): string[] => listSrcFiles().filter((file) => !file.endsWith('.test.ts'));

/**
 * The RUNTIME modules (test-support is the deterministic harness fixture —
 * it wires the REAL gateway the tests observe, exactly like every landed
 * package's test-support does).
 */
const runtimeModules = (): string[] => logicFiles().filter((file) => file !== 'test-support.ts');

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

/** The workspace packages this runtime depends on at RUNTIME. */
const RUNTIME_DEPENDENCIES = [
  '@office/actions',
  '@office/app-sdk',
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
] as const;

/** The TYPE-ONLY dependency (the SqlExecutor surface of the AppEventSink port). */
const TYPE_ONLY_DEPENDENCY = '@office/persistence';

/** Packages this runtime must never import (value or type) — path forms for
 *  the domain/intelligence trees so '@office/domain-kernel' never self-matches. */
const FORBIDDEN_PACKAGES = [
  'packages/domain/',
  'packages/intelligence/',
  '@office/adapters-sdk',
  '@office/agents',
  '@office/client-sync',
  '@office/events',
  '@office/sync',
  '@office/workflows',
] as const;

/** Direct-store vocabulary (THE no-direct-mutation structural rule, A11). */
const storeVocabulary =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b/i;

/** Gateway construction vocabulary (the mutation surface must be injected, A8). */
const gatewayConstruction =
  /\bcreate(?:ActionGateway|InMemoryActionHandlers|InMemoryIdempotencyRegistry)\b/;

/**
 * Source files the import-boundary scans run over: every src file EXCEPT this
 * scanner itself — its own check code must NAME the very specifiers and
 * packages it scans for, so scanning it would self-match by construction.
 */
const scannedSrcFiles = (): string[] => listSrcFiles().filter((file) => file !== 'boundary.test.ts');

describe('app-runtime package boundary (OFF-026)', () => {
  it('is @office/app-runtime 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/app-runtime');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the six workspace dependencies and nothing external', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/actions': 'workspace:^',
      '@office/app-sdk': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/persistence': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the package, the six dependencies, and node builtins', () => {
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

  it('consumes @office/persistence TYPE-ONLY (the SqlExecutor port signature)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      if (file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(srcDir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes(`from '${TYPE_ONLY_DEPENDENCY}'`)) continue;
        const trimmed = line.trim();
        // `import type` keeps @office/persistence out of the runtime graph;
        // a VALUE import would pull stores/pools/SQL into the app runtime.
        if (!trimmed.startsWith('import type')) {
          violations.push(`${file}: value import of ${TYPE_ONLY_DEPENDENCY}`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports domain/intelligence/sync/adapters/agents/client-sync/events/workflows', () => {
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

  it('the LOGIC files contain no non-determinism primitives (no clock, no randomness)', () => {
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

  it('the RUNTIME modules construct no wall-clock Date at all (injected clock only)', () => {
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

  it('the RUNTIME modules never construct the gateway or its handlers (A8: injected)', () => {
    const violations: string[] = [];
    for (const file of runtimeModules()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      if (gatewayConstruction.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the LOGIC files carry no SQL or direct-store vocabulary (A11: no forks)', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (storeVocabulary.test(text)) {
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
