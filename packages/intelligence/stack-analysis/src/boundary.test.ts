import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-035 package boundary self-gate — the "software-stack replacement
// analysis" acceptance: the engine is pure typed data + pure deterministic
// computation over the observed-system vocabulary (the adapters-sdk), the
// app-declaration vocabulary (the app-sdk), the installed-app records (the
// marketplace), and the observed-performance facts (the intelligence memory
// engine). This suite scans the package's own sources deterministically
// (filesystem reads only) and proves:
//   - every import is one of the SEVEN workspace dependencies, a node
//     builtin, a relative path, or (tests only) vitest — never an
//     AI/LLM/network SDK, never a forbidden domain/runtime/adapter
//     implementation package;
//   - the logic files contain no non-determinism primitives (no
//     Math.random, no Date.now, no wall-clock Date construction) and no
//     SQL/migration/repository vocabulary;
//   - no network client vocabulary and no AI provider/model/embedding
//     vocabulary anywhere in the package;
//   - no command construction and no execution surface exists (the engine
//     only SUGGESTS — structurally no uninstall/revoke/issue path);
//   - package.json declares ONLY the seven workspace dependencies and the
//     generic fixture vocabulary discipline holds.
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

/** The LOGIC files (the engine + pure functions — not the test suite). */
const logicFiles = (): string[] => listSrcFiles().filter((file) => !file.endsWith('.test.ts'));

/**
 * The ENGINE files (the public-surface modules): every logic file except
 * the two package-INTERNAL fixture modules — src/test-support.ts (typed
 * value factories) and src/scenarios.ts (the golden seeded portfolio,
 * built through the landed packages' OWN trusted builders and parsers,
 * exactly as a host would). The fixture modules are the sanctioned
 * host-side builders and are never re-exported.
 */
const engineFiles = (): string[] =>
  logicFiles().filter((file) => file !== 'test-support.ts' && file !== 'scenarios.ts');

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

/** The closed allow-list: the seven workspace deps + node builtins + relative. */
const WORKSPACE_DEPENDENCIES = [
  '@office/adapters-sdk',
  '@office/app-sdk',
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
  '@office/intelligence-memory',
  '@office/marketplace',
] as const;

const FORBIDDEN_PACKAGES = [
  // Domain packages (the dependency rule: the intelligence layer imports NO
  // domain package at all — not even the typed read surface; the observed
  // vocabulary comes from the SDKs and the record shapes from contracts).
  /^@office\/domain(?!-kernel)(\/|$)/,
  // Adapter IMPLEMENTATIONS (OFF LIMITS — the SDK's neutral vocabulary only).
  /^@office\/adapter-(?!sdk)/,
  // Runtime/sync/app surfaces the intelligence layer never imports.
  /^@office\/agents(\/|$)/,
  /^@office\/actions(\/|$)/,
  /^@office\/app-runtime(\/|$)/,
  /^@office\/persistence(\/|$)/,
  /^@office\/security(\/|$)/,
  /^@office\/workflows(\/|$)/,
  /^@office\/sync(\/|$)/,
  /^@office\/client-sync(\/|$)/,
  /^@office\/events(\/|$)/,
  /^@office\/test-fixtures(\/|$)/,
  // Intelligence siblings (the boundary is exactly the seven deps above).
  /^@office\/intelligence-(exceptions|margin|relationships|revenue)(\/|$)/,
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
const sqlVocabulary = new RegExp(
  `\\b(${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'migration', 'repo' + 'sitory', 'DATABASE_URL'].join('|')})\\b`,
);

describe('stack analysis package boundary — the suggestion-only engine (OFF-035)', () => {
  it('is @office/intelligence-stack-analysis 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/intelligence-stack-analysis');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares ONLY the seven workspace dependencies (no external deps of any kind)', () => {
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

  it('imports NO forbidden domain/adapter-implementation/runtime/sync/AI/network package anywhere', () => {
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

  it('the engine never imports the package-internal fixture modules (never re-exported)', () => {
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/from\s+['"]\.\/(test-support|scenarios)['"]/);
    const violations: string[] = [];
    for (const file of engineFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (/from\s+['"]\.\/(test-support|scenarios)['"]/.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no AI/embedding vocabulary in the engine (logic files)', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (aiVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no network client vocabulary in the engine (logic files)', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (networkVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no SQL/migration/repository vocabulary in the engine (logic files)', () => {
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (sqlVocabulary.test(text)) {
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

  it('carries no provider/vendor vocabulary anywhere in the package description or sources', () => {
    const pkg = readPackageJson();
    const description = String(pkg['description'] ?? '');
    const providerVocabulary = new RegExp(
      `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp', 'sage', 'view' + 'point'].join('|')})\\b`,
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

  it('the generic fixture vocabulary discipline (no real-world identities in the engine)', () => {
    // The engine's own sources carry only generic vocabulary: the closed
    // assessment/suggestion kinds, the emitted event name, and the engine
    // identity — plus the declared capability vocabulary of the platform.
    const text =
      stripComments(readFileSync(join(srcDir, 'vocabulary.ts'), 'utf8')) +
      stripComments(readFileSync(join(srcDir, 'model.ts'), 'utf8')) +
      stripComments(readFileSync(join(srcDir, 'replacement.ts'), 'utf8')) +
      stripComments(readFileSync(join(srcDir, 'coverage.ts'), 'utf8'));
    expect(text).toContain("'external-system'");
    expect(text).toContain("'installed-app'");
    expect(text).toContain("'consolidate'");
    expect(text).toContain("'extend-coverage'");
    expect(text).toContain("'maintain'");
    expect(text).toContain('intelligence-stack-analysis');
    expect(text).toContain('intelligence.replacementAssessed');
  });

  it('structurally constructs NO command and executes NOTHING (the suggestion-only proof)', () => {
    // The whole public surface is re-exports of the typed modules — no
    // service wiring, no client construction, no runtime side effects —
    // and the internal fixture modules are never re-exported.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    const exportLines = index
      .split('\n')
      .filter((line) => line.trim().startsWith('export'));
    expect(exportLines.length).toBeGreaterThanOrEqual(12);
    expect(index).not.toMatch(/\bnew\s+\w*Client\b/);
    expect(index).not.toMatch(/\bconnect\b/);
    expect(index).not.toMatch(/\bapiKey\b/i);

    // No command envelope is ever constructed (the only typed command
    // builder of the landed contracts package), and no dispatch/execute/
    // commit surface exists anywhere in the engine's logic — including the
    // fixture modules (they build typed fixture data, never commands).
    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (text.match(/\bparseCommandEnvelope\b/) !== null) violations.push(`${file}: parseCommandEnvelope`);
      if (text.match(/\bcommandOf\b/) !== null) violations.push(`${file}: commandOf`);
      if (text.match(/\bcreateCommand\b/) !== null) violations.push(`${file}: createCommand`);
      if (text.match(/\b(dispatch|execute|handleCommand)\w*\s*\(/) !== null) {
        violations.push(`${file}: execution surface`);
      }
      if (text.match(/\bnew\s+\w*(Gateway|Client)\b/) !== null) {
        violations.push(`${file}: gateway/client construction`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('THE suggestion-only discipline: no uninstall/revoke/issue/mutation export exists anywhere', () => {
    // The public surface exposes MEASUREMENT, QUERY, and SUGGESTION
    // vocabulary only: no function or constant can uninstall an app, revoke
    // an entitlement, issue a command, or mutate canonical state — adoption
    // of a suggestion is explicit downstream human/host action through the
    // landed marketplace lifecycle commands, never this engine.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    // The surface is named re-export blocks: collect every exported name.
    const exportNames = [
      ...index.matchAll(/export (?:type )?\{([\s\S]*?)\}\s+from/g),
    ].flatMap((match) =>
      (match[1] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => entry.replace(/\s+as\s+\w+$/, '')),
    );
    expect(exportNames.length).toBeGreaterThan(40);
    // NOTE: 'installationLinkResource' is the pure resource DESCRIPTOR of a
    // link (authorization addressing), not a mutation — the verb scan below
    // lists only true mutation/execution verbs.
    const mutationVerbs =
      /^(uninstall|revoke|grant|issue|dispatch|execute|mutate|append|delete|remove|sever|unlink|update)\w*/;
    const violations = exportNames.filter((name) => mutationVerbs.test(name));
    expect(violations, `mutation-shaped exports: ${violations.join(', ')}`).toStrictEqual([]);
    // Command names appear only as typed REFERENCE vocabulary (the observed
    // workflow surface), never as a construction.
    expect(index).not.toMatch(/commandOf|createCommand|parseCommandEnvelope/);
  });

  it('the audit module\'s only write path is the injected sink port (appendEvents)', () => {
    const audit = stripComments(readFileSync(join(srcDir, 'audit.ts'), 'utf8'));
    // Exactly ONE call site hands the built envelope to the injected sink
    // with the CALLER-supplied executor — never a direct write.
    expect(audit.match(/\.appendEvents\s*\(/g) ?? []).toHaveLength(1);
    expect(audit).toMatch(/sink\.appendEvents\(executor,\s*\[envelope\.value\]\)/);
    expect(audit.match(/\binsert\b|\bupsert\b|\bwriteRow\b/gi) ?? []).toHaveLength(0);
  });

  it('THE no-manual-score discipline holds at the package surface (scan inputs are records only)', () => {
    // The scan-input shape (coverage.ts) carries ONLY record lists — no
    // score, weight, threshold, rank, or potential field exists anywhere in
    // the input vocabulary (the fail-closed strict-keys validation makes a
    // fed manual score a typed rejection — see golden.test.ts).
    const coverage = stripComments(readFileSync(join(srcDir, 'coverage.ts'), 'utf8'));
    const scanInputsMatch = coverage.match(
      /export interface StackScanInputs \{([\s\S]*?)\n\}/,
    );
    expect(scanInputsMatch).not.toBeNull();
    const fields = [...(scanInputsMatch?.[1] ?? '').matchAll(/readonly (\w+):/g)].map(
      (field) => field[1] ?? '',
    );
    expect(fields).toStrictEqual([
      'systems',
      'releases',
      'entitlements',
      'links',
      'outcomes',
      'benchmarks',
    ]);
    const forbidden = /score|potential|weight|threshold|rank|manual/i;
    for (const field of fields) {
      expect(forbidden.test(field)).toBe(false);
    }
    // And the only score constructor is the DERIVED one (replacement.ts):
    // the score is a computed field of the assessment, never an input.
    const replacement = stripComments(readFileSync(join(srcDir, 'replacement.ts'), 'utf8'));
    expect(replacement).toMatch(/deriveReplacementScore\(/);
    expect(replacement).not.toMatch(/\b(?:manual|arbitrary)Score\b/i);
  });
});
