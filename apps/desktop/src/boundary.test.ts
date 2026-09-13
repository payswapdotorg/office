import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-032 desktop client protocol/reference shell — package boundary
// self-gate (the structural half of the acceptance, mirroring the landed
// @office/web and @office/field shells' self-gates): @office/desktop-shell
// is STRUCTURALLY PLATFORM-FREE and DATABASE-FREE — it imports NO
// @office/persistence (not even TYPE-ONLY), no adapters*/app-runtime/
// marketplace/security/workflows/agents/intelligence package, no domain
// package outside organization/projects/schedule/cost, carries no SQL and no
// direct-database vocabulary, and constructs NO gateway (the A8 seam is
// TYPE-ONLY). It NEVER imports @office/web or @office/field (apps do not
// import apps — the landed shells are the structural templates, mirrored
// not imported). It is a pure typed view-model layer over THE SAME
// @office/sync + @office/client-sync client protocol the web and field
// shells consume: no DOM/browser API usage, no service workers, no network
// I/O, NO Electron/node runtime APIs (the typed reference host — the
// protocol proof, not a binary), no UI framework or ANY external dependency,
// no wall clock, no randomness in the client modules, generic fixture
// vocabulary only, NO platform-specific domain model (no local raw-string
// branded casts — every domain term arrives from the shared contracts/domain
// packages through their public surfaces), and a source entry point with no
// build output.
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

/** The CLIENT modules (the logic — not the test suites, not the harness). */
const clientModules = (): string[] =>
  listSrcFiles().filter((file) => !file.endsWith('.test.ts') && file !== 'test-support.ts');

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
// never match its own source (the vocabulary rule: generic fixture
// vocabulary only — no real vendor names, no provider vocabulary, no real OS
// vendor names beyond the generic 'desktop-host' vocabulary of the shell).
const vendorVocabulary = new RegExp(
  `\\b(${[
    'pro' + 'core',
    'auto' + 'desk',
    'prim' + 'avera',
    'e' + 'rp',
    'prov' + 'ider',
    'ven' + 'dor',
    'elec' + 'tron',
    'win' + 'dows',
    'mac' + 'os',
    'dar' + 'win',
    'lin' + 'ux',
  ].join('|')})\\b`,
  'i',
);

/** The workspace packages the desktop shell depends on (the declared boundary). */
const WORKSPACE_DEPENDENCIES = [
  '@office/actions',
  '@office/authz',
  '@office/client-sync',
  '@office/contracts',
  '@office/domain-cost',
  '@office/domain-kernel',
  '@office/domain-organization',
  '@office/domain-projects',
  '@office/domain-schedule',
  '@office/events',
  '@office/sync',
] as const;

/**
 * Packages the desktop shell must never import — value OR type (structurally
 * platform-free and database-free; apps never import apps; no domain
 * package outside organization/projects/schedule/cost).
 */
const FORBIDDEN_PACKAGES = [
  // Apps never import apps: the landed web and field shells are the
  // STRUCTURAL TEMPLATES.
  '@office/web',
  '@office/field',
  '@office/persistence',
  '@office/adapters-sdk',
  '@office/adapter-construction',
  '@office/adapter-model',
  '@office/adapter-schedule',
  '@office/adapter-finance',
  '@office/app-sdk',
  '@office/app-runtime',
  '@office/marketplace',
  '@office/security',
  '@office/workflows',
  '@office/agents',
  '@office/test-fixtures',
  '@office/intelligence-memory',
  '@office/intelligence-relationships',
  '@office/intelligence-margin',
  '@office/intelligence-exceptions',
  '@office/intelligence-revenue',
  '@office/intelligence-stack-analysis',
  // Domain packages other than organization/projects/schedule/cost.
  '@office/domain-contracts',
  '@office/domain-documents',
  '@office/domain-field',
] as const;

/** SQL / direct-database vocabulary (THE zero-database structural rule). */
const sqlVocabulary =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b|\bpg\b\.\bconnect\b/i;

/** DOM/browser/service-worker API usage vocabulary (a view-model layer, no rendering, no offline browser machinery). */
const domVocabulary =
  /\bgetElementById\b|\bquerySelector\b|\bcreateElement\b|\bcreateTextNode\b|\blocalStorage\b|\bsessionStorage\b|\bnavigator\s*\.\s*\w+\s*\(|\bwindow\s*\.\s*\w+|\bDOMParser\b|\bXMLHttpRequest\b|\brequestAnimationFrame\b|\bfetch\s*\(|\balert\s*\(|\bprompt\s*\(|\bserviceWorker\b|\bcaches\s*\./;

/** Electron/node-runtime API vocabulary (the typed reference host, not a binary). */
const runtimeVocabulary = /\brequire\s*\(|\bprocess\.env\b|\b__dirname\b|\b__filename\b|\bnative\s+module\b/;

/** Gateway construction vocabulary (A8: the desktop shell never constructs one). */
const gatewayVocabulary = /\bcreateActionGateway\b/;

/**
 * THE no-platform-specific-domain-model scan: no local raw-string branded
 * casts anywhere in the client modules — every branded domain vocabulary
 * term (command names, entity ids, project/tenant ids, event names,
 * operation kinds, idempotency/correlation keys, ledger event ids,
 * capabilities, conflict record ids, timestamps) arrives from the shared
 * contracts/domain/sync packages through their public fail-closed surfaces.
 */
const brandedCastVocabulary =
  /\bas\s+(?:CommandName|EntityId|ProjectId|TenantId|EventName|OperationKind|IdempotencyKey|CorrelationId|LedgerEventId|Capability|ConflictRecordId|Timestamp)\b/;

/**
 * Source files the import-boundary scans run over: every src file EXCEPT this
 * scanner itself — its own check code must NAME the very specifiers and
 * packages it scans for, so scanning it would self-match by construction.
 */
const scannedSrcFiles = (): string[] => listSrcFiles().filter((file) => file !== 'boundary.test.ts');

describe('desktop client protocol/reference shell package boundary (OFF-032)', () => {
  it('is @office/desktop-shell 0.1.0, private, ESM, side-effect free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/desktop-shell');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the eleven workspace dependencies and nothing external', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/actions': 'workspace:^',
      '@office/authz': 'workspace:^',
      '@office/client-sync': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-cost': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
      '@office/domain-organization': 'workspace:^',
      '@office/domain-projects': 'workspace:^',
      '@office/domain-schedule': 'workspace:^',
      '@office/events': 'workspace:^',
      '@office/sync': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the package, the eleven dependencies, and node builtins (tests may use vitest)', () => {
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

  it('imports NO @office/web and NO @office/field, and no persistence/adapter/runtime/marketplace/security/workflows/agents/intelligence/foreign-domain package — not even TYPE-ONLY', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (FORBIDDEN_PACKAGES.includes(specifier as (typeof FORBIDDEN_PACKAGES)[number])) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the CLIENT modules import nothing but relative paths and the eleven dependencies (no node builtins, no environment — the typed reference host)', () => {
    const violations: string[] = [];
    for (const file of clientModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('.') ||
          WORKSPACE_DEPENDENCIES.includes(specifier as (typeof WORKSPACE_DEPENDENCIES)[number]);
        if (!permitted) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('consumes @office/actions TYPE-ONLY (the A8 gateway seam — never a value import)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes(`from '@office/actions'`)) continue;
        const trimmed = line.trim();
        // `import type` keeps the gateway package OUT of the client's runtime
        // graph — a VALUE import would mean binding executable gateway
        // behavior; the desktop shell only composes proposals a bound
        // gateway accepts.
        if (!trimmed.startsWith('import type')) {
          violations.push(`${file}: value import of @office/actions`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('constructs no gateway (A8: the desktop shell never constructs, holds, or calls one)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (gatewayVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('carries no SQL or direct-database vocabulary in any module (zero direct database access)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (sqlVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('uses no DOM/browser/service-worker API anywhere (the offline ENGINE is @office/client-sync, composed in memory)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (domVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('carries no Electron/node-runtime API vocabulary anywhere (the typed reference host, not a binary)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (runtimeVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no provider/vendor/OS-vendor vocabulary in any source or test file', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (vendorVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('declares NO platform-specific domain model: no local raw-string branded casts in the client modules', () => {
    const violations: string[] = [];
    for (const file of clientModules()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (brandedCastVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the client modules contain no non-determinism primitives (injected clock/id suppliers only)', () => {
    const violations: string[] = [];
    const nondeterminism = new RegExp(
      `\\b(${['Date' + '.now', 'Math' + '.random', 'crypto' + '.randomUUID'].join('|')})\\b|\\bset(${'Time' + 'out'}|${'Inter' + 'val'})\\b`,
    );
    for (const file of listSrcFiles().filter((candidate) => !candidate.endsWith('.test.ts'))) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (nondeterminism.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the client modules construct no wall-clock Date at all (tests build fixed instants themselves)', () => {
    const violations: string[] = [];
    const wallClock = /\bnew\s+Date\b/;
    for (const file of listSrcFiles().filter((candidate) => !candidate.endsWith('.test.ts'))) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (wallClock.test(text)) {
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

  it('ships every required client module and re-exports none of the internals', () => {
    for (const module of [
      'session/session.ts',
      'session/world.ts',
      'session/stream.ts',
      'host-port/host-port.ts',
      'desktop/host.ts',
      'desktop/commands.ts',
      'desktop/workspace.ts',
      'desktop/sync.ts',
      'desktop/conflicts.ts',
      'index.ts',
      'test-support.ts',
    ]) {
      expect(existsSync(join(srcDir, module))).toBe(true);
    }
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes("from './test-support'")).toBe(false);
    // The client modules exist in the structure the brief prescribes.
    expect(clientModules().length).toBeGreaterThan(0);
  });
});
