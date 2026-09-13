import { describe, expect, it } from 'vitest';
import { checkAgentDbAccess, importClausesFor, loadRepoTree, stripComments } from './rules';

// OFF-039 check 3 — direct agent DB access: the agents/intelligence families
// NEVER touch the database directly (freeze A8 — "Agents never write
// arbitrary database state"; the frozen anti-pattern "No AI direct SQL
// writes"). No VALUE import of @office/persistence (the type-only
// SqlExecutor port signature in packages/agents is the sanctioned inert
// seam), no persistence import at all outside packages/agents (the
// intelligence families mirror the port locally), no pg driver import, and
// no SQL surface in any non-test module.
describe('direct agent DB access (OFF-039 architecture conformance)', () => {
  const files = loadRepoTree();

  it('scans the whole agents/intelligence family (glob-discovered, never empty)', () => {
    const family = files.filter(
      (file) =>
        file.path.endsWith('.ts') &&
        (file.path.startsWith('packages/agents/src/') ||
          (file.path.startsWith('packages/intelligence/') && file.path.includes('/src/'))),
    );
    expect(family.length).toBeGreaterThanOrEqual(100);
    const familyDirs = new Set(
      family.map((file) => file.path.split('/').slice(0, 3).join('/')),
    );
    expect(familyDirs.has('packages/agents/src')).toBe(true);
    for (const expected of [
      'packages/intelligence/exceptions',
      'packages/intelligence/margin',
      'packages/intelligence/memory',
      'packages/intelligence/procurement',
      'packages/intelligence/revenue',
      'packages/intelligence/stack-analysis',
      'packages/intelligence/relationships',
    ]) {
      expect(familyDirs.has(expected)).toBe(true);
    }
  });

  it('documents the one sanctioned inert seam: the agents TYPE-ONLY SqlExecutor port', () => {
    // The landed agents package imports @office/persistence type-only (the
    // EventSink port signature) — the clause discipline this check enforces.
    const seam = files.find((file) => file.path === 'packages/agents/src/run.ts');
    expect(seam).toBeDefined();
    const clauses = importClausesFor(stripComments(seam?.text ?? ''), '@office/persistence');
    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) {
      expect(clause.startsWith('type')).toBe(true);
    }
    // The intelligence families import nothing from persistence at all.
    const intelligenceImports = files
      .filter(
        (file) =>
          file.path.startsWith('packages/intelligence/') && file.path.includes('/src/'),
      )
      .flatMap((file) => importClausesFor(stripComments(file.text), '@office/persistence'));
    expect(intelligenceImports).toStrictEqual([]);
  });

  it('passes on the entire current family — zero violations, fail closed', () => {
    const violations = checkAgentDbAccess(files);
    expect(violations).toStrictEqual([]);
  });
});
