import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OFF-001 architecture gate: asserts the workspace conventions the toolchain
// bootstrap installs. Deliberately trivial and deterministic — deeper
// architecture gates (import boundaries, provider leakage) arrive with the
// release-gate work items (OFF-036+).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;

describe('workspace conventions (OFF-001)', () => {
  it('establishes the apps/ and packages/ workspace directories', () => {
    expect(existsSync(join(repoRoot, 'apps'))).toBe(true);
    expect(existsSync(join(repoRoot, 'packages'))).toBe(true);
  });

  it('pins pnpm as the workspace package manager', () => {
    const pkg = readJson('package.json');
    expect(pkg['packageManager']).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('maps apps/* and packages/* as the workspace globs', () => {
    const workspaceYaml = readFileSync(
      join(repoRoot, 'pnpm-workspace.yaml'),
      'utf8',
    );
    expect(workspaceYaml).toContain('apps/*');
    expect(workspaceYaml).toContain('packages/*');
  });

  it('defines the four root quality scripts', () => {
    const pkg = readJson('package.json');
    const scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>;
    for (const name of ['lint', 'typecheck', 'test', 'test:architecture']) {
      expect(typeof scripts[name], `root script "${name}"`).toBe('string');
    }
  });

  it('keeps apps/web a placeholder until OFF-030', () => {
    expect(existsSync(join(repoRoot, 'apps', 'web', 'package.json'))).toBe(
      true,
    );
    expect(existsSync(join(repoRoot, 'apps', 'web', 'README.md'))).toBe(true);
    expect(existsSync(join(repoRoot, 'apps', 'web', 'src'))).toBe(false);
  });
});
