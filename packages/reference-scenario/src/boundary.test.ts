import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-037 reference-scenario — package boundary self-gate (the structural
// half of the acceptance, mirroring apps/field's self-gate and the landed
// intelligence siblings' conventions): @office/reference-scenario is THE
// deterministic integration-acceptance composition over the LANDED packages —
// it imports EXACTLY the sixteen workspace dependencies it declares (the four
// adapters, the four seeded domain command packages, the workflow surface,
// the agents EvidenceSet discipline, the events ledger identity, the contracts
// and kernel and authz primitives, and the two intelligence detection
// surfaces) and NOTHING else: no @office/persistence (not even TYPE-ONLY —
// the scenario is in-memory deterministic), no sync/client-sync/app-runtime/
// marketplace/security/app-sdk/adapters-sdk/test-fixtures, no app imports of
// any kind (apps never import apps and packages NEVER import apps — the
// optional @office/web shell import was dropped in favor of the domain read
// surfaces + the ledger, per the brief's documented drop), no deeper package
// paths ('@office/x/src/...'), no external dependency of any kind, no SQL or
// direct-database vocabulary, no network vocabulary, no AI/LLM vocabulary, no
// wall clock or randomness in the logic modules (injected clock/id suppliers
// only), no action-gateway construction, no provider names beyond the generic
// fixture vocabulary, and a source entry point with no build output.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;

/** Every .ts file under src (recursively), as src-relative paths, sorted. */
const listSrcFiles = (dir: string = srcDir): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSrcFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(relative(srcDir, path));
    }
  }
  return files.sort();
};

/** The LOGIC modules — the composition + the entry point (not the suites). */
const logicModules = (): string[] => listSrcFiles().filter((file) => !file.endsWith('.test.ts'));

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

/**
 * Files the FORBIDDEN-package scan runs over: every src file EXCEPT this
 * scanner itself — its own check code must NAME the very packages it scans
 * for, so scanning it would self-match by construction. (The vocabulary
 * scans below run over the LOGIC modules only.)
 */
const scannedSrcFiles = (): string[] => listSrcFiles().filter((file) => file !== 'boundary.test.ts');

/** The sixteen workspace packages the reference scenario declares + imports. */
const WORKSPACE_DEPENDENCIES = [
  '@office/adapter-construction',
  '@office/adapter-finance',
  '@office/adapter-model',
  '@office/adapter-schedule',
  '@office/agents',
  '@office/authz',
  '@office/contracts',
  '@office/domain-cost',
  '@office/domain-kernel',
  '@office/domain-organization',
  '@office/domain-projects',
  '@office/domain-schedule',
  '@office/events',
  '@office/intelligence-procurement',
  '@office/intelligence-revenue',
  '@office/workflows',
] as const;

/** Packages the reference scenario must never import — value OR type. */
const FORBIDDEN_PACKAGES = [
  // Structurally database-free (the in-memory deterministic world).
  '@office/persistence',
  // Not part of the scenario's composition (the brief's exclusion list).
  '@office/sync',
  '@office/client-sync',
  '@office/app-runtime',
  '@office/marketplace',
  '@office/security',
  '@office/app-sdk',
  '@office/adapters-sdk',
  '@office/test-fixtures',
  // Packages NEVER import apps (the sanctioned optional @office/web import
  // was dropped: projections read through the domain surfaces + the ledger).
  '@office/web',
  '@office/desktop-shell',
  '@office/field-client',
] as const;

/** Real provider/vendor names (generic fixture vocabulary only — assembled from fragments). */
const vendorVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp'].join('|')})\\b`,
  'i',
);

/** SQL / direct-database vocabulary (THE zero-database structural rule). */
const sqlVocabulary =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b|\bpg\b\.\bconnect\b/i;

/** Network vocabulary (no network I/O of any kind — deterministic in-memory). */
const networkVocabulary =
  /\bfetch\s*\(|\baxios\b|\bnode:(?:http|https|net|dgram)\b|\bhttps?\.(?:request|get)\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bwebsocket\b|\bnode-fetch\b/i;

/** AI/LLM vocabulary (no AI/LLM calls of any kind — typed computation only). */
const aiVocabulary = /\b(?:llm|gpt|openai|anthropic|claude|gemini|copilot|chatbot)\b/i;

/** Non-determinism primitives (injected clock/id suppliers only). */
const nondeterminismVocabulary = /\bDate\.now\b|\bMath\.random\b|\bcrypto\.randomUUID\b|\bnew\s+Date\b|\bset(?:Timeout|Interval)\b/;

/** Action-gateway construction vocabulary (the A8 seam is never constructed here). */
const gatewayVocabulary = /\bcreateActionGateway\b/;

describe('reference-scenario package boundary (OFF-037)', () => {
  it('is @office/reference-scenario 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/reference-scenario');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the SIXTEEN workspace dependencies and nothing external', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/adapter-construction': 'workspace:^',
      '@office/adapter-finance': 'workspace:^',
      '@office/adapter-model': 'workspace:^',
      '@office/adapter-schedule': 'workspace:^',
      '@office/agents': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-cost': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/domain-organization': 'workspace:^',
      '@office/domain-projects': 'workspace:^',
      '@office/domain-schedule': 'workspace:^',
      '@office/events': 'workspace:^',
      '@office/intelligence-procurement': 'workspace:^',
      '@office/intelligence-revenue': 'workspace:^',
      '@office/workflows': 'workspace:^',
    });
    expect(Object.keys(pkg['dependencies'] as Record<string, unknown>)).toHaveLength(16);
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the package, the sixteen dependencies, and node builtins', () => {
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          WORKSPACE_DEPENDENCIES.includes(specifier as (typeof WORKSPACE_DEPENDENCIES)[number]);
        if (!permitted) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('imports NO forbidden package and no deeper package path — not even TYPE-ONLY', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (FORBIDDEN_PACKAGES.includes(specifier as (typeof FORBIDDEN_PACKAGES)[number])) {
          violations.push(`${file}: '${specifier}'`);
          continue;
        }
        // Any other @office scope, any deeper '@office/x/src/...' path, or the
        // sample scope is outside the declared boundary (the import scan above
        // proves it for the logic modules; this scan covers the suites too).
        if (
          (specifier.startsWith('@office/') &&
            !WORKSPACE_DEPENDENCIES.includes(specifier as (typeof WORKSPACE_DEPENDENCIES)[number])) ||
          specifier.startsWith('@office-sample/')
        ) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('carries no SQL or direct-database vocabulary in any logic module (zero direct database access)', () => {
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (sqlVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('uses no network vocabulary anywhere in the logic modules (no network I/O of any kind)', () => {
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (networkVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no AI/LLM vocabulary anywhere in the logic modules (typed computation only)', () => {
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (aiVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no provider/vendor vocabulary beyond the generic fixtures in any source file', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (vendorVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the logic modules contain no non-determinism primitives (injected clock/id suppliers only)', () => {
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (nondeterminismVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('constructs no action gateway (the scenario composes typed commands; it never binds a gateway)', () => {
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (gatewayVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('ships a source entry point, a README, and no build output', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    const exports = pkg['exports'] as Record<string, unknown> | undefined;
    expect(exports?.['.']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'README.md'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
  });

  it('ships the scenario composition + the three suites and re-exports none of the test internals', () => {
    for (const module of [
      'scenario/world.ts',
      'scenario/adapters.ts',
      'scenario/chain.ts',
      'index.ts',
      'smoke.test.ts',
      'golden.test.ts',
      'a12-scope.test.ts',
    ]) {
      expect(existsSync(join(srcDir, module)), module).toBe(true);
    }
    // The public surface NEVER re-exports test support or the suites.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes('test-support')).toBe(false);
    expect(index.includes('.test')).toBe(false);
    expect(index.includes("from './smoke")).toBe(false);
    expect(index.includes("from './golden")).toBe(false);
    expect(index.includes("from './a12-scope")).toBe(false);
    // The logic modules exist in the structure the brief prescribes.
    expect(logicModules().length).toBe(4);
  });
});
