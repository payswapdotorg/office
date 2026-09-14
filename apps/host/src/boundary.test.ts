import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-DEPLOY apps/host — the package boundary self-gate (mirroring the web
// shell's OFF-030 self-gate, EXTENDED over .tsx: the browser host's JSX
// modules are gated like every other source). apps/host is STRUCTURALLY
// DATABASE-FREE: it imports NO @office/persistence (not even TYPE-ONLY), no
// 'pg', and carries no SQL or direct-database vocabulary — all database
// access lives in @office/host-gateway. Its WORKSPACE imports are EXACTLY
// the two the deployment topology prescribes: @office/web (view-model types)
// and @office/host-gateway (the server composition). Client components
// ('use client' as their first statement) import @office/web TYPE-ONLY —
// type-only imports are erased at compile time, and @office/web pulls
// node:crypto, so it must never enter the client bundle — and they never
// import @office/host-gateway at all.
//
// Unlike the web shell (a pure view-model layer: no DOM, no fetch), this
// package IS the browser host: DOM APIs and fetch in client components are
// its sanctioned job, so apps/web's DOM/fetch scan is intentionally NOT
// mirrored here — everything else is, including the determinism discipline
// (injected clock/id suppliers only: no wall clock, no randomness in the
// host modules) and the vendor-vocabulary rule (generic vocabulary only).
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;

/** Every .ts AND .tsx file under src (recursively), as src-relative paths, sorted. */
const listSrcFiles = (dir: string = srcDir): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSrcFiles(path));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(relative(srcDir, path));
    }
  }
  return files.sort();
};

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
// never match its own source (the vocabulary rule: generic vocabulary only —
// no real vendor names, no provider vocabulary in package logic).
const vendorVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp', 'prov' + 'ider', 'ven' + 'dor'].join('|')})\\b`,
  'i',
);

/** The ONLY workspace packages the browser host may import. */
const WORKSPACE_IMPORTS = ['@office/web', '@office/host-gateway'] as const;

/** The non-workspace host stack (the app's own declared dependencies). */
const EXTERNAL_IMPORTS = ['next', 'next/server', 'next/link', 'react', 'react-dom'] as const;

/** Packages the browser host must never import — value OR type (structurally database-/runtime-free). */
const FORBIDDEN_PACKAGES = [
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
  '@office/test-fixtures',
] as const;

/** SQL / direct-database vocabulary (THE zero-database structural rule). */
const sqlVocabulary =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b|\bpg\b\.\bconnect\b/i;

/**
 * Source files the import-boundary scans run over: every src file EXCEPT
 * this scanner itself — its own check code must NAME the very specifiers and
 * packages it scans for, so scanning it would self-match by construction.
 */
const scannedSrcFiles = (): string[] => listSrcFiles().filter((file) => file !== 'boundary.test.ts');

/** The client-component files ('use client' as their first statement). */
const clientComponentFiles = (): string[] =>
  scannedSrcFiles().filter((file) =>
    /^\s*(['"])use client\1/.test(stripComments(readFileSync(join(srcDir, file), 'utf8'))),
  );

describe('browser host package boundary (OFF-DEPLOY)', () => {
  it('is @office/host, private, ESM', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/host');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the pinned host stack, the two workspace links, and the three @types devDependencies — no other workspace dep', () => {
    const pkg = readPackageJson();
    const dependencies = pkg['dependencies'] as Record<string, string>;
    expect(Object.keys(dependencies).sort()).toStrictEqual([
      '@office/host-gateway',
      '@office/web',
      'next',
      'react',
      'react-dom',
    ]);
    // next pinned EXACT to the newest stable 15.x (no range).
    expect(dependencies['next']).toMatch(/^15\.\d+\.\d+$/);
    expect(dependencies['react']).toMatch(/^19\./);
    expect(dependencies['react-dom']).toMatch(/^19\./);
    expect(dependencies['@office/web']).toBe('workspace:^');
    expect(dependencies['@office/host-gateway']).toBe('workspace:^');
    const devDependencies = pkg['devDependencies'] as Record<string, string>;
    expect(Object.keys(devDependencies).sort()).toStrictEqual([
      '@types/node',
      '@types/react',
      '@types/react-dom',
    ]);
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports NOTHING outside the package, the two workspace packages, the host stack, node builtins, and vitest (in tests)', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          WORKSPACE_IMPORTS.includes(specifier as (typeof WORKSPACE_IMPORTS)[number]) ||
          EXTERNAL_IMPORTS.includes(specifier as (typeof EXTERNAL_IMPORTS)[number]) ||
          (isTest && specifier === 'vitest');
        if (!permitted) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('imports NO @office/persistence and no adapter/app-sdk/app-runtime/marketplace/security package — not even TYPE-ONLY', () => {
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

  it('imports no pg and carries no SQL or direct-database vocabulary in any module', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (specifier === 'pg') violations.push(`${file}: 'pg'`);
      }
      if (sqlVocabulary.test(text)) violations.push(`${file}: SQL vocabulary`);
    }
    expect(violations).toStrictEqual([]);
  });

  it('client components (use client) import @office/web TYPE-ONLY and never import @office/host-gateway', () => {
    const violations: string[] = [];
    const clients = clientComponentFiles();
    // The two interactive surfaces of the deployment topology exist.
    expect(clients.length).toBeGreaterThanOrEqual(2);
    for (const file of clients) {
      const raw = readFileSync(join(srcDir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.includes(`from '@office/web'`)) continue;
        const trimmed = line.trim();
        // `import type` keeps @office/web OUT of the client bundle at
        // compile time — a VALUE import would drag node:crypto into the
        // browser; the gateway (pg) must never reach the client at all.
        if (!trimmed.startsWith('import type')) {
          violations.push(`${file}: value import of @office/web`);
        }
      }
      for (const specifier of importSpecifiers(stripComments(raw))) {
        if (specifier === '@office/host-gateway') {
          violations.push(`${file}: @office/host-gateway import in a client component`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('contains no provider/vendor vocabulary in any source or test file', () => {
    const violations: string[] = [];
    for (const file of scannedSrcFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (vendorVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('the host modules contain no wall-clock or randomness primitives (injected clock/id suppliers only)', () => {
    const violations: string[] = [];
    const nondeterminism = new RegExp(
      `\\b(${['Date' + '.now', 'Math' + '.random', 'crypto' + '.randomUUID'].join('|')})\\b`,
    );
    for (const file of listSrcFiles().filter((candidate) => !candidate.endsWith('.test.ts'))) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (nondeterminism.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('ships the App Router structure the deployment topology prescribes (no build output)', () => {
    for (const module of [
      'app/layout.tsx',
      'app/page.tsx',
      'app/control-tower/page.tsx',
      'app/evidence/page.tsx',
      'app/api/health/route.ts',
      'app/api/workspace/route.ts',
      'app/api/commands/route.ts',
      'app/api/actions/route.ts',
      'app/api/ledger/route.ts',
      'components/command-outcome.tsx',
      'components/field-capture-form.tsx',
      'components/approval-flow.tsx',
      'server/runtime.ts',
      'server/http.ts',
    ]) {
      expect(existsSync(join(srcDir, module))).toBe(true);
    }
    expect(existsSync(join(packageRoot, 'next.config.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(packageRoot, '.next'))).toBe(false);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
  });
});
