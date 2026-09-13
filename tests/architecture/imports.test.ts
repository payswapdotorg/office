import { describe, expect, it } from 'vitest';
import {
  checkForbiddenImports,
  discoverPackages,
  importSpecifiers,
  loadRepoTree,
  LAYERING_RULES,
  stripComments,
} from './rules';

// OFF-039 check 1 — forbidden imports: the GLOBAL cross-package
// import-boundary scan. Every packages/* and apps/* source file may import
// ONLY: relative paths, node: builtins, the package's OWN package.json
// dependencies, vitest (in *.test.ts files), and the enumerated sanctioned
// dynamic imports — and declared imports must still satisfy the frozen
// layering rules (one global rule table). Everything else fails closed with
// the offending file + import + violated rule.
describe('forbidden imports (OFF-039 architecture conformance)', () => {
  const files = loadRepoTree();

  it('derives every package boundary from its OWN package.json dependencies block', () => {
    const { packages, violations } = discoverPackages(files);
    expect(violations).toStrictEqual([]);
    // The landed workspace: 36 packages + 4 apps, every dependency a
    // workspace:^ link except the persistence driver (pg) — the floor
    // assertions keep a silently-empty scan from ever passing.
    expect(packages.length).toBeGreaterThanOrEqual(40);
    const names = packages.map((pkg) => pkg.name);
    for (const expected of [
      '@office/contracts',
      '@office/domain-kernel',
      '@office/authz',
      '@office/persistence',
      '@office/events',
      '@office/agents',
      '@office/actions',
      '@office/security',
      '@office/operations',
      '@office/domain-organization',
      '@office/intelligence-revenue',
      '@office/web',
      '@office/field-client',
      '@office/desktop-shell',
      '@office-sample/app',
    ]) {
      expect(names).toContain(expected);
    }
    const persistence = packages.find((pkg) => pkg.name === '@office/persistence');
    expect(persistence?.dependencies).toStrictEqual(['@office/contracts', '@office/domain-kernel', 'pg']);
    // The agent runtime's declared boundary: the type-only SqlExecutor port.
    const agents = packages.find((pkg) => pkg.name === '@office/agents');
    expect(agents?.dependencies).toContain('@office/persistence');
    // The web shell's declared boundary never contains persistence.
    const web = packages.find((pkg) => pkg.name === '@office/web');
    expect(web?.dependencies).not.toContain('@office/persistence');
  });

  it('scans the whole workspace source surface (the scan is never empty)', () => {
    const sourceFiles = files.filter(
      (file) =>
        file.path.endsWith('.ts') &&
        (file.path.startsWith('packages/') || file.path.startsWith('apps/')) &&
        file.path.includes('/src/'),
    );
    expect(sourceFiles.length).toBeGreaterThanOrEqual(600);
    // The import-clause pattern resolves real statements on a known surface:
    // the contracts package imports nothing but node builtins + itself.
    const contractsIndex = files.find((file) => file.path === 'packages/contracts/src/index.ts');
    expect(contractsIndex).toBeDefined();
    const specifiers = importSpecifiers(stripComments(contractsIndex?.text ?? ''));
    expect(specifiers.every((specifier) => specifier.startsWith('./'))).toBe(true);
  });

  it('carries the frozen layering rules as one named rule table', () => {
    expect(LAYERING_RULES.map((rule) => rule.rule)).toStrictEqual([
      'domain-never-imports-adapters',
      'clients-never-import-persistence',
      'adapters-never-import-adapters',
    ]);
    for (const rule of LAYERING_RULES) {
      expect(rule.description.length).toBeGreaterThan(0);
      expect(rule.forbids.length).toBeGreaterThan(0);
    }
  });

  it('passes on the entire current tree — zero violations, fail closed', () => {
    const violations = checkForbiddenImports(files);
    expect(violations).toStrictEqual([]);
  });
});
