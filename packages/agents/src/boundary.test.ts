import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-018 package boundary self-gate — THE "an agent cannot mutate state
// except through OFF-017" structural half of the acceptance: the runtime
// package is pure typed data + pure orchestration behind injected ports. This
// suite scans the package's own sources deterministically (filesystem reads
// only) and proves:
//   - every import is one of the EIGHT declared workspace dependencies, a
//     node builtin, or relative — never an AI/LLM/embedding/network SDK;
//   - @office/persistence is imported TYPE-ONLY (the SqlExecutor port
//     signature) — no store, repository, or SQL anywhere;
//   - NO domain/adapters/workflows/sync/client-sync/events package is
//     imported (workflows come through the gateway's routing only);
//   - the runtime never CONSTRUCTS a gateway or a command handler — the
//     mutation surface is injected (the behavioral half of the proof, the
//     handler-invocation counting, lives in run.test.ts);
//   - the logic files contain no non-determinism primitives (no
//     Math.random/Date.now/wall clock) and no network/AI/provider vocabulary;
//   - package.json declares ONLY workspace dependencies.
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
const runtimeModules = logicFiles().filter((file) => file !== 'test-support.ts');

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
  // Bare dynamic imports too (import('...')).
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(dynamic)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

/** The closed allow-list: the eight declared workspace deps + node + relative. */
const WORKSPACE_DEPENDENCIES = [
  '@office/actions',
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
  '@office/intelligence-margin',
  '@office/intelligence-memory',
  '@office/intelligence-relationships',
  '@office/persistence',
] as const;

const FORBIDDEN_PACKAGES = [
  // The dependency rule: agents consume actions + the intelligence peers +
  // contracts/kernel/authz + the persistence TYPE only. Workflows arrive
  // through the gateway's approval routing — never by import.
  /^@office\/domain(?!-kernel)(\/|$)/,
  /^@office\/adapters(-sdk)?(\/|$)/,
  /^@office\/workflows(\/|$)/,
  /^@office\/sync(\/|$)/,
  /^@office\/client-sync(\/|$)/,
  /^@office\/events(\/|$)/,
  /^@office\/test-fixtures(\/|$)/,
  /^@office\/intelligence(?!-)(\/|$)/,
  /^apps\//,
  // AI/LLM/embedding SDKs of any kind (assembled from fragments so this
  // scan can never match its own source).
  /^(open|)ai/,
  /^anthropic/,
  /^langchain/,
  /^llamaindex/,
  /^@google\/generativeai/,
  /^cohere/,
  /^huggingface/,
  /^transformers/,
  /^sagemaker/,
  /^bedrock/,
  /^replicate/,
  /^ollama/,
  // Network clients of any kind.
  /^axios$/,
  /^node-fetch$/,
  /^undici$/,
  /^got$/,
  /^needle$/,
  /^superagent$/,
  /^puppeteer$/,
  /^playwright/,
  /^ws$/,
];

// AI + network vocabulary, assembled from fragments so this file can never
// match its own scan patterns.
const aiVocabulary = new RegExp(
  `\\b(${['embed' + 'ding', 'llm', 'gpt', 'open' + 'ai', 'anth' + 'ropic', 'lan' + 'gchain', 'cha' + 'tbot', 'neural', 'infer' + 'ence-engine'].join('|')})\\b`,
  'i',
);
const networkVocabulary = new RegExp(
  `\\b(${['fe' + 'tch', 'axi' + 'os', 'HttpClient', 'http' + '.request', 'net' + '.connect', 'WebSocket', 'XMLHttpRequest', 'und' + 'ici'].join('|')})\\b`,
);
const nondeterminismVocabulary = new RegExp(
  `\\b(${['Date' + '.now', 'Math' + '.random', 'crypto' + '.randomUUID'].join('|')})\\b|\\bset(Timeout|Interval)\\b`,
);
// The runtime modules additionally admit no wall-clock Date construction at
// all (the harness fixture may build fixed-epoch instants; the runtime may not).
const wallClockVocabulary = /\bnew\s+Date\b/;
// Direct-store vocabulary (THE no-direct-mutation structural rule): SQL
// statements and store/pool construction.
const storeVocabulary = /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b/i;
const gatewayConstruction = /\bcreate(?:ActionGateway|InMemoryActionHandlers|InMemoryIdempotencyRegistry)\b/;

describe('agents package boundary — gateway-mediated mutations only (OFF-018)', () => {
  it('is @office/agents 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/agents');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares ONLY the eight workspace dependencies (no external deps of any kind)', () => {
    const pkg = readPackageJson();
    const dependencies = pkg['dependencies'] as Record<string, string> | undefined;
    expect(dependencies).toBeDefined();
    expect(Object.keys(dependencies ?? {}).sort()).toStrictEqual(
      [...WORKSPACE_DEPENDENCIES].sort(),
    );
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      expect(range, `${name} must be a workspace dependency`).toBe('workspace:^');
    }
    // No other dependency blocks at all.
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the allow-list (workspace deps + node builtins + relative)', () => {
    const violations: string[] = [];
    for (const file of listSrcFiles()) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          (isTest && specifier === 'vitest') ||
          (WORKSPACE_DEPENDENCIES as readonly string[]).includes(specifier);
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('imports NO domain/adapters/workflows/sync/events/AI/network package anywhere', () => {
    const violations: string[] = [];
    for (const file of listSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        for (const forbidden of FORBIDDEN_PACKAGES) {
          if (forbidden.test(specifier)) {
            violations.push(`${file}: '${specifier}'`);
          }
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('imports @office/persistence TYPE-ONLY (the SqlExecutor port signature — no store)', () => {
    const violations: string[] = [];
    for (const file of listSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      const pattern = /import\s+([^;]*?)\s+from\s+['"]@office\/persistence['"]/g;
      for (const match of text.matchAll(pattern)) {
        const clause = (match[1] ?? '').trim();
        if (!clause.startsWith('type')) {
          violations.push(`${file}: value import '${clause}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never constructs a gateway, handler, or idempotency registry outside the test harness', () => {
    // THE structural half of "an agent cannot mutate state except through
    // OFF-017": the runtime modules receive the gateway INJECTED — the only
    // construction site is the deterministic test harness (test-support.ts).
    const violations: string[] = [];
    for (const file of runtimeModules) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (gatewayConstruction.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no direct-store path in the runtime modules (no SQL, no store construction)', () => {
    const violations: string[] = [];
    for (const file of runtimeModules) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (storeVocabulary.test(text) || text.includes('.query(')) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no AI/embedding vocabulary in the logic files', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (aiVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no network client vocabulary in the logic files', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (networkVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the LOGIC files contain no non-determinism primitives (no clock, no randomness)', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (nondeterminismVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the RUNTIME modules construct no wall-clock Date at all (injected clock only)', () => {
    const violations: string[] = [];
    for (const file of runtimeModules) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (wallClockVocabulary.test(text)) {
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

  it('carries no provider vocabulary anywhere in the package description or sources', () => {
    const pkg = readPackageJson();
    const description = String(pkg['description'] ?? '');
    const providerVocabulary = new RegExp(
      `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp'].join('|')})\\b`,
      'i',
    );
    expect(providerVocabulary.test(description)).toBe(false);

    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      if (providerVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('colocates the full module + test surface (the OFF-018 suites run under the root vitest glob)', () => {
    for (const required of [
      'model.ts',
      'parse.ts',
      'vocabulary.ts',
      'evidence.ts',
      'tools.ts',
      'proposals.ts',
      'run.ts',
      'execution-records.ts',
      'test-support.ts',
      'index.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
    for (const suite of [
      'model.test.ts',
      'parse.test.ts',
      'evidence.test.ts',
      'tools.test.ts',
      'run.test.ts',
      'execution-records.test.ts',
      'boundary.test.ts',
    ]) {
      expect(existsSync(join(srcDir, suite)), suite).toBe(true);
    }
  });

  it('the public surface exposes typed contracts + pure functions only (no service surface)', () => {
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    // The whole public surface is re-exports of the typed modules — no
    // service wiring, no client construction, no runtime side effects.
    const exportLines = index
      .split('\n')
      .filter((line) => line.trim().startsWith('export'));
    expect(exportLines.length).toBeGreaterThanOrEqual(14);
    expect(index).not.toMatch(/\bnew\s+\w*Client\b/);
    expect(index).not.toMatch(/\bconnect\b/);
    expect(index).not.toMatch(/\bapiKey\b/i);
    expect(index).not.toMatch(/\btoken\b/i);
  });
});
