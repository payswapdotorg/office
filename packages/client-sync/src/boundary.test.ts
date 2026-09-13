import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-029 client-sync — package boundary self-gate. These checks mirror the
// work item's acceptance boundary: @office/client-sync declares exactly five
// runtime dependencies (@office/sync, @office/contracts, @office/domain-kernel,
// @office/authz, @office/events — the merged foundations it composes), imports
// nothing else outside the package outside of tests (node:crypto's sha256 is
// the package's ONLY node import — the digests), adds NO new external
// dependency of any kind, performs NO I/O of its own (no filesystem, no
// network, no process environment — the engine is the deterministic
// in-memory reference implementation; the app layer wires real transports and
// durable stores against the ports later), carries no provider vocabulary,
// and reads no clock and no randomness (the kernel's injected clock/id rule).
// Deterministic: filesystem reads only.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const listFiles = (dir: string, suffix: string): string[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .sort();

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

const WORKSPACE_DEPENDENCIES = [
  '@office/authz',
  '@office/contracts',
  '@office/domain-kernel',
  '@office/events',
  '@office/sync',
];

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source (the acceptance gate forbids those names anywhere in
// this package).
const providerVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp'].join('|')})\\b`,
  'i',
);

// I/O and nondeterminism vocabularies, likewise assembled from fragments so
// this file cannot match its own scans. Only non-test modules are scanned
// (the tests themselves legitimately touch the filesystem to read sources).
const ioVocabulary = [
  'node:' + 'fs',
  'node:' + 'http',
  'node:' + 'https',
  'node:' + 'net',
  'node:' + 'tls',
  'node:' + 'dns',
  'node:' + 'os',
  'node:' + 'path',
  'node:' + 'url',
  'node:' + 'child_' + 'process',
  'node:' + 'worker_' + 'threads',
  'fet' + 'ch(',
  'process' + '.env',
  'XMLHttp' + 'Request',
  'Web' + 'Socket',
];
const nondeterminismVocabulary = [
  'Date' + '.now',
  'Math' + '.random',
  'set' + 'Timeout',
  'set' + 'Interval',
  'process' + '.env',
];

describe('client-sync package boundary (OFF-029)', () => {
  it('is @office/client-sync 0.1.0, private, ESM', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/client-sync');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the allowed runtime dependencies: sync, contracts, domain-kernel, authz, events', () => {
    const pkg = readPackageJson();
    const dependencies = pkg['dependencies'] as Record<string, unknown>;
    expect(Object.keys(dependencies).sort()).toStrictEqual(
      [...WORKSPACE_DEPENDENCIES].sort(),
    );
    for (const name of WORKSPACE_DEPENDENCIES) {
      expect(dependencies[name], `${name} must be a workspace dependency`).toBe('workspace:^');
    }
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only allowed modules outside the package (node:crypto + the five foundations + test-only vitest/node stdlib)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('.') ||
          specifier === 'node:crypto' ||
          WORKSPACE_DEPENDENCIES.includes(specifier) ||
          (isTest && (specifier === 'vitest' || specifier.startsWith('node:')));
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports the domain/intelligence/adapters/workflows/actions layers (the engine composes the foundations only)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        if (
          specifier === '@office/domain' ||
          specifier.startsWith('@office/domain/') ||
          specifier === '@office/intelligence' ||
          specifier.startsWith('@office/intelligence/') ||
          specifier === '@office/adapters-sdk' ||
          specifier === '@office/workflows' ||
          specifier === '@office/actions' ||
          specifier === '@office/persistence' ||
          specifier === '@office/test-fixtures'
        ) {
          offenders.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('performs no I/O of its own (no filesystem, no network, no process environment in package code)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      if (file.endsWith('.test.ts')) continue;
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const token of ioVocabulary) {
        if (text.includes(token)) {
          offenders.push(`${file}: '${token}'`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('reads no clock and no randomness in package code (the injected clock/id rule)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      if (file.endsWith('.test.ts')) continue;
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const token of nondeterminismVocabulary) {
        if (text.includes(token)) {
          offenders.push(`${file}: '${token}'`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('contains no provider vocabulary in any source or test file', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      if (providerVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('ships a source entry point with no build output', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    const exports = pkg['exports'] as Record<string, unknown>;
    expect(exports['.']).toBe('./src/index.ts');
    expect(exports['./package.json']).toBe('./package.json');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
  });

  it('keeps the required protocol modules present (the symmetric package structure)', () => {
    for (const required of [
      'identity.ts',
      'parse.ts',
      'queue.ts',
      'tokens.ts',
      'conflict.ts',
      'replay.ts',
      'audit.ts',
      'engine.ts',
      'index.ts',
      'test-support.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });

  it('colocates the full test surface (the OFF-029 suites run under the root vitest glob)', () => {
    for (const required of [
      'identity.test.ts',
      'queue.test.ts',
      'tokens.test.ts',
      'replay.test.ts',
      'conflict.test.ts',
      'engine.test.ts',
      'audit.test.ts',
      'boundary.test.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });

  it('exposes the OFF-029 public surface from the package root (downstream consumes the root only)', () => {
    const text = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    for (const required of [
      'offlineOperationIdOf',
      'offlineCommandFingerprint',
      'createLocalQueue',
      'clientOperationOf',
      'parseQueueEntry',
      'assessTargetDivergence',
      'addressesTarget',
      'createInMemoryOperationJournal',
      'createInMemoryConflictLog',
      'autoResolveOpenConflict',
      'authorizeQueuedMutation',
      'drainLocalQueue',
      'TypedCommandPath',
      'createInMemorySyncEventSink',
      'SyncEventSink',
      'MUTATION_REPLAYED_EVENT',
      'CONFLICT_RESOLVED_EVENT',
      'createSyncEngine',
      'SyncEngineParts',
      'ReconnectReport',
      'ConflictResolutionCommand',
    ]) {
      expect(text.includes(required), `index.ts must export ${required}`).toBe(true);
    }
  });
});
