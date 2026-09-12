import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-005 events — package boundary self-gate. These checks mirror the work
// item's acceptance boundary: @office/events declares exactly three runtime
// dependencies (@office/contracts, @office/domain-kernel, @office/persistence
// — the merged foundations it builds on), imports nothing else outside the
// package outside of tests (node stdlib is runtime, not a dependency), adds
// NO new external dependency of any kind (pg stays a persistence-internal
// concern — this package never imports it), carries no provider vocabulary,
// and ships its two forward-only migrations (0003_event_ledger.sql,
// 0004_outbox.sql) under the persistence migrator's naming contract. The
// ledger's append-only rule is additionally source-scanned: no non-test
// module may contain an UPDATE or DELETE statement against event_ledger
// (migration 0003 enforces the same rule at the database level).
// Deterministic: filesystem reads only.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');
const migrationsDir = join(packageRoot, 'migrations');

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

// Provider vocabulary is assembled from fragments so this scan can never
// match its own source (the acceptance gate forbids those names anywhere in
// this package).
const providerVocabulary = new RegExp(
  `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'e' + 'rp'].join('|')})\\b`,
  'i',
);

// Ledger mutation statements, likewise assembled from fragments so this
// file cannot match its own scan. Only non-test modules are scanned.
const ledgerMutation = new RegExp(
  `\\b(?:${'UP' + 'DATE'}\\s+event_ledger|${'DE' + 'LETE'}\\s+from\\s+event_ledger|${'TR' + 'UNCATE'}\\s+event_ledger)\\b`,
  'i',
);

describe('events package boundary (OFF-005)', () => {
  it('is @office/events 0.1.0, private, ESM', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/events');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
  });

  it('declares exactly the allowed runtime dependencies: contracts, domain-kernel, persistence', () => {
    const pkg = readPackageJson();
    const dependencies = pkg['dependencies'] as Record<string, unknown>;
    expect(Object.keys(dependencies).sort()).toStrictEqual([
      '@office/contracts',
      '@office/domain-kernel',
      '@office/persistence',
    ]);
    expect(dependencies['@office/contracts']).toBe('workspace:^');
    expect(dependencies['@office/domain-kernel']).toBe('workspace:^');
    expect(dependencies['@office/persistence']).toBe('workspace:^');
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only allowed modules outside the package (node stdlib + test-only vitest)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const isTest = file.endsWith('.test.ts');
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier === '@office/contracts' ||
          specifier === '@office/domain-kernel' ||
          specifier === '@office/persistence' ||
          (isTest && specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports pg (driver types stay a persistence-internal concern)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (importSpecifiers(text).includes('pg')) {
        offenders.push(file);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('ships exactly the two forward-only migrations under the migrator naming contract', () => {
    expect(existsSync(migrationsDir)).toBe(true);
    expect(listFiles(migrationsDir, '.sql')).toStrictEqual([
      '0003_event_ledger.sql',
      '0004_outbox.sql',
    ]);
    for (const fileName of listFiles(migrationsDir, '.sql')) {
      expect(fileName).toMatch(/^\d{4}_[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.sql$/);
    }
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

  it('never mutates or truncates ledger rows in package code (append-only source rule)', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      if (file.endsWith('.test.ts')) continue;
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (ledgerMutation.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('ships a source entry point with no build output', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
  });

  it('keeps the required foundation modules present', () => {
    for (const required of [
      'identity.ts',
      'migrations.ts',
      'rows.ts',
      'ledger.ts',
      'outbox.ts',
      'consumer.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });

  it('exposes the OFF-005 produce surface from the package root', () => {
    const text = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    for (const required of [
      'appendEvent',
      'enqueueOutbox',
      'consumeIdempotently',
      'causedByCommand',
      'causedByEvent',
      'EVENTS_MIGRATIONS_DIR',
    ]) {
      expect(text.includes(required), `index.ts must export ${required}`).toBe(true);
    }
  });
});
