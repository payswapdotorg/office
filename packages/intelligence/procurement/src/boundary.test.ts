import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-034 package boundary self-gate — THE "suggestion-only procurement
// optimization engine" acceptance: the engine is pure typed data + pure
// deterministic computation over the cost domain's typed READ surface and
// the intelligence peers' outputs. This suite scans the package's own
// sources deterministically (filesystem reads only) and proves:
//   - every import is one of the SEVEN workspace dependencies, a node
//     builtin, a relative path, or (tests only) vitest — never an
//     AI/LLM/network SDK, never a forbidden domain/runtime package;
//   - the domain surface is @office/domain-cost ONLY (the typed read
//     surface — derived reads + limits, never a command, transition,
//     store, or sink) — no other domain package (contracts/schedule/field/
//     organization/projects/documents), no sync/client-sync/adapters/
//     app-sdk/app-runtime/marketplace/security/persistence/actions/events;
//   - @office/agents is consumed TYPE-ONLY (the EvidenceSet discipline);
//   - the logic files contain no non-determinism primitives (no
//     Math.random, no Date.now, no wall-clock Date construction) and no
//     SQL/migration/repository vocabulary;
//   - no network client vocabulary and no AI provider/model/embedding
//     vocabulary anywhere in the package;
//   - no command construction and no execution surface exists (the engine
//     only PROPOSES — structurally no auto-commitment path), and the ONLY
//     commitment-shaped export is the policy-gated one whose exit is a
//     ProposedNextAction record;
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
 * value factories) and src/scenarios.ts (the golden seeded fixtures, which
 * build canonical cost-domain records through the domain package's OWN
 * pure state constructors, exactly as a host would). The import
 * disciplines below apply to the engine; the fixture modules are the
 * sanctioned host-side builders and are never re-exported.
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

/** The names a file exports (declarations + re-export brace lists). */
const exportedNames = (text: string): string[] => {
  const names: string[] = [];
  const declarations = /\bexport\s+(?:async\s+)?(?:const|function|class|let)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declarations)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  const braceLists = /\bexport\s*\{([^}]*)\}/g;
  for (const match of text.matchAll(braceLists)) {
    const clause = match[1] ?? '';
    for (const entry of clause.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      // `local as exported` — the exported face is what the surface shows.
      const exported = trimmed.includes(' as ')
        ? (trimmed.split(' as ').at(-1) ?? '').trim()
        : trimmed;
      if (exported.length > 0) names.push(exported);
    }
  }
  return names;
};

// The closed allow-list: the seven workspace deps + node builtins + relative.
const WORKSPACE_DEPENDENCIES = [
  '@office/domain-cost',
  '@office/intelligence-margin',
  '@office/intelligence-memory',
  '@office/agents',
  '@office/contracts',
  '@office/domain-kernel',
  '@office/authz',
] as const;

const FORBIDDEN_PACKAGES = [
  // Domain packages OTHER than domain/cost + the kernel (the dependency
  // rule: the procurement engine reads the canonical commitment/invoice
  // model only — domain/contracts is a revenue-peer surface, not ours).
  /^@office\/domain(?!-cost|-kernel)(\/|$)/,
  // Runtime/sync/app surfaces the intelligence layer never imports.
  /^@office\/adapters(-sdk)?(\/|$)/,
  /^@office\/workflows(\/|$)/,
  /^@office\/sync(\/|$)/,
  /^@office\/client-sync(\/|$)/,
  /^@office\/actions(\/|$)/,
  /^@office\/persistence(\/|$)/,
  /^@office\/app-sdk(\/|$)/,
  /^@office\/app-runtime(\/|$)/,
  /^@office\/marketplace(\/|$)/,
  /^@office\/security(\/|$)/,
  /^@office\/events(\/|$)/,
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
const sqlVocabulary = new RegExp(
  `\\b(${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'migration', 'repo' + 'sitory', 'DATABASE_URL'].join('|')})\\b`,
);

// Mutation-shaped export verbs: an export whose name STARTS with a mutation
// verb would be a write-shaped surface. The single sanctioned exception is
// the policy-gated commitment (proven below to exit a suggestion record).
const MUTATION_VERB_PATTERN = /^(uninstall|revoke|grant|issue|commit|mutate|append|delete|remove)([A-Z_]\w*)?$/;

describe('procurement package boundary — the suggestion-only engine (OFF-034)', () => {
  it('is @office/intelligence-procurement 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/intelligence-procurement');
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

  it('imports NO forbidden domain/runtime/sync/AI/network package anywhere', () => {
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

  it('consumes @office/agents TYPE-ONLY (the EvidenceSet discipline, never its runtime)', () => {
    const violations: string[] = [];
    for (const file of engineFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const match of text.matchAll(
        /import\s+([^;]+?)\s*from\s+['"]@office\/agents['"]/g,
      )) {
        const clause = match[1] ?? '';
        if (!clause.trim().startsWith('type ')) {
          violations.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('consumes @office/domain-cost through its READ surface only (no command, transition, store, or sink)', () => {
    // The engine's cost-domain imports are derived reads + typed limits +
    // read states ONLY: never a *_COMMAND name, never a state transition
    // (create/record/amend/close/revise/reference*State), never a store or
    // sink constructor. The package-internal fixture module scenarios.ts
    // builds canonical cost records through the domain's OWN pure state
    // constructors — exactly as a host would — and is covered separately.
    const violations: string[] = [];
    for (const file of engineFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const match of text.matchAll(
        /import\s+([^;]+?)\s*from\s+['"]@office\/domain-cost['"]/g,
      )) {
        const clause = (match[1] ?? '').trim();
        if (clause.startsWith('type ')) continue;
        const symbols = clause.replace(/^type\s+/, '').replace(/[{}]/g, '').split(',');
        for (const symbol of symbols) {
          const name = symbol.trim().split(/\s+as\s+/)[0]?.trim() ?? '';
          if (name.length === 0) continue;
          if (/COMMAND/.test(name)) {
            violations.push(`${file}: ${name} (command name)`);
          }
          if (/^(create|record|amend|close|revise|reference|apply)[A-Z]/.test(name)) {
            violations.push(`${file}: ${name} (transition)`);
          }
          if (/(Store|Sink|Commands)$/.test(name)) {
            violations.push(`${file}: ${name} (runtime surface)`);
          }
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the engine never imports the package-internal fixture modules', () => {
    const violations: string[] = [];
    for (const file of engineFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (specifier === './test-support' || specifier === './scenarios') {
          violations.push(`${file}: '${specifier}'`);
        }
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
    // recommendation kinds, the vendor-performance levels, the engine
    // identity, and the detection tool. Vendors are 'vendor-01'-style keys,
    // never real-world identities.
    const text =
      stripComments(readFileSync(join(srcDir, 'vocabulary.ts'), 'utf8')) +
      stripComments(readFileSync(join(srcDir, 'model.ts'), 'utf8')) +
      stripComments(readFileSync(join(srcDir, 'comparison.ts'), 'utf8')) +
      stripComments(readFileSync(join(srcDir, 'recommendation.ts'), 'utf8'));
    expect(text).toContain("'vendor-switch'");
    expect(text).toContain("'order-splitting'");
    expect(text).toContain("'timing-shift'");
    expect(text).toContain('intelligence-procurement');
    expect(text).toContain('procurement-recommendation-detection');
    // The closed vendor-performance levels the ratings derive into.
    expect(text).toContain("'unrated'");
    expect(text).toContain("'underperforming'");
    expect(text).toContain("'acceptable'");
    expect(text).toContain("'strong'");
  });

  it('structurally constructs NO command and executes NOTHING (the no-auto-commitment proof)', () => {
    // The whole public surface is re-exports of the typed modules — no
    // service wiring, no client construction, no runtime side effects —
    // and the internal fixture modules are never re-exported.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    const exportLines = index
      .split('\n')
      .filter((line) => line.trim().startsWith('export'));
    expect(exportLines.length).toBeGreaterThanOrEqual(12);
    expect(index).not.toMatch(/from\s+['"]\.\/(test-support|scenarios)['"]/);
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

  it('exposes NO mutation-shaped export — the single commitment-shaped export exits a SUGGESTION record', () => {
    // The only commitment-shaped surface is the policy-gated
    // commitProcurementDecision — mirrored on the revenue sibling's
    // assertRecoveryClaim: WITHOUT an explicit policy decision it is a
    // typed rejection, and WITH one the exit is STILL a ProposedNextAction
    // record (a suggestion, never a command or state mutation). Every
    // other mutation verb is absent from the whole public surface.
    const proposal = stripComments(readFileSync(join(srcDir, 'proposal.ts'), 'utf8'));
    expect(proposal).toMatch(
      /export function commitProcurementDecision\(\s*recommendation:\s*ProcurementRecommendation,\s*decision:\s*ProcurementPolicyDecision \| null,\s*\):\s*Result<ProposedNextAction,\s*DomainError>/,
    );

    const violations: string[] = [];
    for (const file of logicFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const name of exportedNames(text)) {
        if (!MUTATION_VERB_PATTERN.test(name)) continue;
        if (name === 'commitProcurementDecision') continue;
        violations.push(`${file}: ${name}`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the audit module\'s only write path is the injected sink port (appendEvents)', () => {
    const audit = stripComments(readFileSync(join(srcDir, 'audit.ts'), 'utf8'));
    // Exactly ONE call site hands the built envelope to the injected sink
    // with the CALLER-supplied executor — never a direct write.
    expect(audit.match(/\.appendEvents\s*\(/g) ?? []).toHaveLength(1);
    expect(audit).toMatch(/sink\.appendEvents\(executor,\s*\[envelope\.value\]\)/);
    expect(audit.match(/\binsert\b|\bupsert\b|\bwriteRow\b/gi) ?? []).toHaveLength(0);
  });
});
