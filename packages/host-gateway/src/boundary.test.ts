import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-DEPLOY host-gateway — package boundary self-gate (mirroring the landed
// reference-scenario self-gate and the architecture gate's conventions):
// @office/host-gateway is THE production gateway composition behind the
// browser host — it imports EXACTLY the nine workspace dependencies it
// declares (the persistence foundation, the event ledger + outbox, the REAL
// A8 action gateway, the web shell's session/world/plane/view models, the
// authorization inputs, the canonical contracts, the kernel, and the two
// canonical-PG domain modules) and NOTHING else: no other @office scope and
// no deeper package path ('@office/x/src/...', not even type-only), no
// external dependency of any kind, no construction/ERP vendor vocabulary
// (hosting names live in DEPLOYMENT.md + app config only), no AI/LLM
// vocabulary, no network I/O of its own (the host's routes own HTTP), no raw
// SQL of its own — every SQL execution flows the LANDED scoped surfaces (the
// repositories, the ledger + outbox functions), so the A12 tenant-scope
// discipline the architecture gate's persistence-facing scan asserts over
// this package (it declares @office/persistence) holds by construction —
// and no wall clock or randomness in the logic modules (injected clock/id
// suppliers only, per the deterministic-composition rule).
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
 * scans below run over the LOGIC modules only, except the vendor scan, which
 * follows the landed convention of covering every scanned file.)
 */
const scannedSrcFiles = (): string[] => listSrcFiles().filter((file) => file !== 'boundary.test.ts');

/** The nine workspace packages the gateway composition declares + imports. */
const WORKSPACE_DEPENDENCIES = [
  '@office/actions',
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
  '@office/domain-organization',
  '@office/domain-projects',
  '@office/events',
  '@office/persistence',
  '@office/web',
] as const;

/**
 * Workspace packages the gateway must never import — the composition's
 * documented exclusions. The generic scan below catches every OTHER
 * @office scope too (and any deeper path), so this list names the families
 * nearest the temptation: the adapter fixtures, the clients, the SDKs, the
 * reference scenario, and the operations tooling.
 */
const FORBIDDEN_PACKAGES = [
  '@office/adapter-construction',
  '@office/adapter-finance',
  '@office/adapter-model',
  '@office/adapter-schedule',
  '@office/adapters-sdk',
  '@office/app-runtime',
  '@office/app-sdk',
  '@office/client-sync',
  '@office/desktop-shell',
  '@office/field-client',
  '@office/marketplace',
  '@office/operations',
  '@office/reference-scenario',
  '@office/security',
  '@office/sync',
  '@office/test-fixtures',
] as const;

/** Real construction/ERP provider names (the architecture gate's list, assembled from fragments). */
const vendorVocabulary = new RegExp(
  `\\b(${[
    'pro' + 'core',
    'auto' + 'desk',
    'prim' + 'avera',
    'ms' + '-project',
    'p' + '6',
    'sa' + 'ge',
    'view' + 'point',
    's' + 'ap',
    'net' + 'suite',
    'quick' + 'books',
    'xe' + 'ro',
    'dyn' + 'amics',
    'work' + 'day',
    'in' + 'for',
  ].join('|')})\\b`,
  'i',
);

/**
 * Raw SQL / direct-driver vocabulary: the gateway ROUTES SQL through the
 * landed scoped surfaces — it never writes a statement of its own, never
 * constructs a Pool/Client, and never calls .query( directly (the
 * persistence-facing form of the architecture gate's A12 scan anticipates
 * exactly this discipline).
 */
const rawSqlVocabulary =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b/i;

/** Network vocabulary (no network I/O of its own — the host's routes own HTTP). */
const networkVocabulary =
  /\bfetch\s*\(|\baxios\b|\bnode:(?:http|https|net|dgram)\b|\bhttps?\.(?:request|get)\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bwebsocket\b|\bnode-fetch\b/i;

/** AI/LLM vocabulary (no AI/LLM calls of any kind — typed computation only). */
const aiVocabulary = /\b(?:llm|gpt|openai|anthropic|claude|gemini|copilot|chatbot)\b/i;

/** Non-determinism primitives (injected clock/id suppliers only). */
const nondeterminismVocabulary = /\bDate\.now\b|\bMath\.random\b|\bcrypto\.randomUUID\b|\bnew\s+Date\b|\bset(?:Timeout|Interval)\b/;

describe('host-gateway package boundary (OFF-DEPLOY)', () => {
  it('is @office/host-gateway 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/host-gateway');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the NINE workspace dependencies and nothing external', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/actions': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/domain-organization': 'workspace:^',
      '@office/domain-projects': 'workspace:^',
      '@office/events': 'workspace:^',
      '@office/persistence': 'workspace:^',
      '@office/web': 'workspace:^',
    });
    expect(Object.keys(pkg['dependencies'] as Record<string, unknown>)).toHaveLength(9);
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the package, the nine dependencies, and node builtins', () => {
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

  it('routes NO raw SQL of its own — every SQL execution flows the landed scoped surfaces', () => {
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (rawSqlVocabulary.test(text) || text.includes('.query(')) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('declares no repository interface and no .query(-executing export of its own (the A12 anticipation)', () => {
    // The architecture gate's persistence-facing scan (check 4) covers this
    // package (it declares @office/persistence): every exported *Repository
    // interface method and every exported .query(-executing function must
    // flow tenant scope. The gateway defines NONE of either — it composes the
    // landed scoped repositories and the landed ledger/outbox functions — so
    // the static discipline holds with nothing to exempt.
    const violations: string[] = [];
    for (const file of logicModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (/export\s+interface\s+\w*Repository\s*\{/.test(text)) {
        violations.push(`${file}: repository interface`);
      }
      const exported = /export\s+(?:async\s+)?function\s+(\w+)/g;
      for (const match of text.matchAll(exported)) {
        const name = match[1];
        if (name === undefined) continue;
        const open = text.indexOf('{', match.index ?? 0);
        if (open < 0) continue;
        let depth = 0;
        let close = -1;
        for (let i = open; i < text.length; i += 1) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              close = i;
              break;
            }
          }
        }
        if (close < 0) continue;
        if (text.slice(open, close).includes('.query(')) {
          violations.push(`${file}: ${name} executes .query(`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('uses no network vocabulary anywhere in the logic modules (the host routes own HTTP)', () => {
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

  it('contains no provider/vendor vocabulary beyond the generic composition in any source file', () => {
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

  it('ships the composition modules + the suites and re-exports none of the test internals', () => {
    for (const module of [
      'index.ts',
      'runtime.ts',
      'approvals.ts',
      'inputs.ts',
      'ledger-sink.ts',
      'migrations.ts',
      'integration.test.ts',
      'actions-gateway.test.ts',
      'boundary.test.ts',
    ]) {
      expect(existsSync(join(srcDir, module)), module).toBe(true);
    }
    // The public surface NEVER re-exports test internals or the suites.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes('.test')).toBe(false);
    expect(index.includes('test-support')).toBe(false);
    // The logic modules exist in the structure the brief prescribes.
    expect(logicModules().length).toBe(6);
  });
});
