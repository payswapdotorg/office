import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-038 operations — package boundary self-gate (the landed convention):
// @office/operations declares exactly the eight workspace dependencies the
// brief's Consumes list names (pg and embedded-postgres flow through
// @office/persistence's harness — never a direct dependency here), imports
// nothing else outside the package outside of tests, carries no provider
// vocabulary, and re-exports no test internals from its public surface.
// Deterministic: filesystem reads only.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

/** Every file under src/ with the given suffix, in sorted order. */
const listFiles = (suffix: string): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) files.push(full);
    }
  };
  walk(srcDir);
  return files;
};

/** Strip comments so only real import/export syntax is scanned. */
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
  '@office/adapter-construction',
  '@office/adapter-finance',
  '@office/adapter-model',
  '@office/adapter-schedule',
  '@office/contracts',
  '@office/domain-kernel',
  '@office/persistence',
  '@office/security',
] as const;

const sourceFiles = listFiles('.ts').filter((file) => !file.endsWith('.test.ts'));

describe('operations package boundary (OFF-038)', () => {
  it('is @office/operations 0.1.0, private, ESM, side-effect-free', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe('@office/operations');
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the eight workspace dependencies (never pg directly)', () => {
    const pkg = readPackageJson();
    const dependencies = pkg['dependencies'] as Record<string, string>;
    expect(Object.keys(dependencies).sort()).toEqual([...WORKSPACE_DEPENDENCIES].sort());
    for (const specifier of Object.values(dependencies)) {
      expect(specifier).toBe('workspace:^');
    }
    expect(Object.keys(pkg['devDependencies'] ?? {})).toEqual([]);
  });

  it('imports only the declared workspace packages, node builtins, and relatives', () => {
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('node:') ||
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          (WORKSPACE_DEPENDENCIES as readonly string[]).includes(specifier);
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('never re-exports test internals from the public surface', () => {
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes('.test.')).toBe(false);
    for (const file of listFiles('.test.ts')) {
      const basename = file.split('/').pop() ?? '';
      expect(index.includes(basename)).toBe(false);
    }
  });

  it('carries no vendor, cloud, or provider vocabulary in any source file', () => {
    // Assembled from fragments so this scan can never match its own source.
    const forbidden = new RegExp(
      `\\b(${['pro' + 'core', 'auto' + 'desk', 'prim' + 'avera', 'a' + 'ws', 'az' + 'ure', 'gc' + 'p', 'mic' + 'rosoft', 'goo' + 'gle', 's' + '3'].join('|')})\\b`,
      'i',
    );
    for (const file of listFiles('.ts')) {
      expect(forbidden.test(readFileSync(file, 'utf8')), `${file} carries provider vocabulary`).toBe(
        false,
      );
    }
  });

  it('ships the package README and the package-internal RUNBOOK (never root docs/)', () => {
    expect(existsSync(join(packageRoot, 'README.md'))).toBe(true);
    expect(existsSync(join(packageRoot, 'RUNBOOK.md'))).toBe(true);
  });
});
