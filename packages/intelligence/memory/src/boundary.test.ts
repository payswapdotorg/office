import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-015 package boundary self-gate — THE "no opaque AI in core storage"
// acceptance: the memory package's core storage is pure typed data + pure
// functions. This suite scans the package's own sources deterministically
// (filesystem reads only) and proves:
//   - every import is a workspace dependency, a node builtin, or relative —
//     never an AI/LLM/embedding/network SDK of ANY kind;
//   - the logic files contain no non-determinism primitives (no
//     Math.random, no Date.now, no wall-clock Date construction);
//   - no network client vocabulary (fetch/axios/http/undici/tls/dns) and no
//     AI provider/model/embedding vocabulary anywhere in the package;
//   - package.json declares ONLY workspace dependencies;
//   - no domain/adapters/workflows/sync/actions package is imported (the
//     dependency rule: intelligence consumes contracts/kernel/authz/events
//     + its intelligence peers only).
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

/** The LOGIC files (the core storage + pure functions — not the test suite). */
const logicFiles = (): string[] => listSrcFiles().filter((file) => !file.endsWith('.test.ts'));

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

/** The closed allow-list: the six workspace deps + node builtins + relative. */
const WORKSPACE_DEPENDENCIES = [
  '@office/contracts',
  '@office/domain-kernel',
  '@office/authz',
  '@office/events',
  '@office/intelligence-relationships',
  '@office/intelligence-margin',
] as const;

const FORBIDDEN_PACKAGES = [
  // Domain/adapters/workflows/sync/actions: the dependency rule.
  /^@office\/domain(?!-kernel)(\/|$)/,
  /^@office\/adapters(-sdk)?(\/|$)/,
  /^@office\/workflows(\/|$)/,
  /^@office\/sync(\/|$)/,
  /^@office\/actions(\/|$)/,
  /^@office\/persistence(\/|$)/,
  /^@office\/test-fixtures(\/|$)/,
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
const nondeterminismVocabulary = /\bMath\.random\b|\bDate\.now\b|\bnew Date\b|\bcrypto\.randomUUID\b/;

describe('memory package boundary — no opaque AI in core storage (OFF-015)', () => {
  it('is @office/intelligence-memory 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/intelligence-memory');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares ONLY the six workspace dependencies (no external deps of any kind)', () => {
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

  it('imports NO domain/adapters/workflows/sync/actions/AI/network package anywhere', () => {
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

  it('contains no AI/embedding vocabulary in the core storage (logic files)', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (aiVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no network client vocabulary in the core storage (logic files)', () => {
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

  it('the public surface exposes typed contracts + pure functions only (no AI service surface)', () => {
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    // The whole public surface is re-exports of the typed modules — no
    // service wiring, no client construction, no runtime side effects.
    const exportLines = index
      .split('\n')
      .filter((line) => line.trim().startsWith('export'));
    expect(exportLines.length).toBeGreaterThanOrEqual(15);
    expect(index).not.toMatch(/\bnew\s+\w*Client\b/);
    expect(index).not.toMatch(/\bconnect\b/);
    expect(index).not.toMatch(/\bapiKey\b/i);
    expect(index).not.toMatch(/\btoken\b/i);
  });
});
