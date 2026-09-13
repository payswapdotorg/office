import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-027 marketplace — package boundary self-gate (the structural half of
// the acceptance, mirroring app-runtime's self-gate): @office/marketplace
// depends ONLY on the five declared workspace packages
// (@office/app-runtime TYPE-ONLY in the LOGIC — the installation-record
// surface the marketplace LINKS to; the test harnesses value-import the
// runtime's own trusted record builders to construct the HOST-side fixtures,
// exactly like every landed package's test-support wires real dependencies),
// never imports domain/intelligence/sync/adapters/agents/client-sync/events/
// workflows/persistence/actions/client-sdk packages, constructs NO gateway
// and NO app runtime (A7/A8 — the marketplace never executes app code), never
// touches a store (A11 — the marketplace owns metadata, never project truth),
// carries no SQL, no provider/vendor vocabulary, no wall clock, no
// randomness, and ships a source entry point with no build output.
// Deterministic: filesystem reads only.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;

const listSrcFiles = (): string[] =>
  readdirSync(srcDir)
    .filter((file) => file.endsWith('.ts'))
    .sort();

/** The LOGIC files (the engine + its record modules — not the test suites). */
const logicFiles = (): string[] => listSrcFiles().filter((file) => !file.endsWith('.test.ts'));

/**
 * The MARKETPLACE modules (test-support is the deterministic harness fixture
 * — it builds the HOST-side app-runtime installation records through the
 * runtime's own trusted builders, the same way every landed package's
 * test-support wires the real dependency its logic only consumes as data).
 */
const marketplaceModules = (): string[] =>
  logicFiles().filter((file) => file !== 'test-support.ts');

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

// Provider/vendor vocabulary is assembled from fragments so this scan can
// never match its own source (the vocabulary rule: generic marketplace
// vocabulary only — no real vendor names, no provider vocabulary).
const vendorVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp', 'prov' + 'ider', 'ven' + 'dor'].join('|')})\\b`,
  'i',
);

/** The workspace packages the marketplace depends on. */
const WORKSPACE_DEPENDENCIES = [
  '@office/app-runtime',
  '@office/app-sdk',
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
] as const;

/** Packages the marketplace must never import (value or type). */
const FORBIDDEN_PACKAGES = [
  'packages/domain/',
  'packages/intelligence/',
  'packages/adapters/',
  'packages/apps/',
  'packages/client-sync/',
  '@office/adapters-sdk',
  '@office/agents',
  '@office/client-sdk',
  '@office/client-sync',
  '@office/events',
  '@office/persistence',
  '@office/sync',
  '@office/workflows',
  '@office/actions',
] as const;

/** Direct-store vocabulary (THE no-store structural rule, A11). */
const storeVocabulary =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b/i;

/** Gateway/runtime construction vocabulary (A7/A8: never constructed here). */
const constructionVocabulary = /\bcreate(?:ActionGateway|AppRuntime|InMemoryActionHandlers|InMemoryIdempotencyRegistry)\b/;

/** The app-runtime value imports the LOGIC must never make (TYPE-ONLY). */
const TYPE_ONLY_DEPENDENCY = '@office/app-runtime';

/**
 * Source files the import-boundary scans run over: every src file EXCEPT this
 * scanner itself — its own check code must NAME the very specifiers and
 * packages it scans for, so scanning it would self-match by construction.
 */
const scannedSrcFiles = (): string[] => listSrcFiles().filter((file) => file !== 'boundary.test.ts');

describe('marketplace package boundary (OFF-027)', () => {
  it('is @office/marketplace 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/marketplace');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the five workspace dependencies and nothing external', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/app-runtime': 'workspace:^',
      '@office/app-sdk': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the package, the five dependencies, and node builtins', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          WORKSPACE_DEPENDENCIES.includes(specifier as (typeof WORKSPACE_DEPENDENCIES)[number]) ||
          (isTest && specifier === 'vitest');
        if (!permitted) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the ENGINE/record modules consume @office/app-runtime TYPE-ONLY (installation records are data)', () => {
    const violations: string[] = [];
    for (const file of marketplaceModules()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes(`from '${TYPE_ONLY_DEPENDENCY}'`)) continue;
        const trimmed = line.trim();
        // `import type` keeps the runtime OUT of the marketplace's runtime
        // graph — a VALUE import would mean constructing/executing runtime
        // behavior; the engine only ever sees typed installation records.
        if (!trimmed.startsWith('import type')) {
          violations.push(`${file}: value import of ${TYPE_ONLY_DEPENDENCY}`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('app-runtime value imports appear ONLY in the harness (test-support + test files)', () => {
    const hostSide: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (line.includes(`from '${TYPE_ONLY_DEPENDENCY}'`) && !line.trim().startsWith('import type')) {
          hostSide.push(file);
          break;
        }
      }
    }
    // test-support.ts (the harness fixture) is the ONE sanctioned host-side
    // value consumer: it builds fixture installation records through the
    // runtime's own trusted builders, never executing anything.
    expect(hostSide.every((file) => file.endsWith('.test.ts') || file === 'test-support.ts')).toBe(true);
  });

  it('never imports domain/intelligence/sync/adapters/agents/client-sync/events/workflows/persistence/actions/apps', () => {
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

  it('contains no provider/vendor vocabulary in any source or test file', () => {
    const violations: string[] = [];
    // boundary.test.ts is excluded from THIS scan only because the scanner
    // must NAME the banned words it scans for (its own title/regex would
    // self-match by construction); every other file is scanned in full.
    for (const file of listSrcFiles().filter((candidate) => candidate !== 'boundary.test.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (vendorVocabulary.test(text)) {
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

  it('the MARKETPLACE modules construct no wall-clock Date at all (injected clock only)', () => {
    const violations: string[] = [];
    const wallClock = /\bnew\s+Date\b/;
    for (const file of marketplaceModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (wallClock.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the MARKETPLACE modules never construct the gateway or the app runtime (A7/A8)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      if (constructionVocabulary.test(text)) {
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

  it('ships a source entry point, a README, and no build output', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'README.md'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
  });

  it('ships every required lifecycle module and re-exports none of the internals', () => {
    for (const module of [
      'audit.ts',
      'canonical-state.ts',
      'catalog.ts',
      'engine.ts',
      'entitlement.ts',
      'identity.ts',
      'installation-link.ts',
      'publisher.ts',
      'release.ts',
      'store.ts',
      'update.ts',
    ]) {
      expect(existsSync(join(srcDir, module))).toBe(true);
    }
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes("from './parse'")).toBe(false);
    expect(index.includes("from './test-support'")).toBe(false);
    expect(index.includes("from './failure'")).toBe(false);
  });
});
