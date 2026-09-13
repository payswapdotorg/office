import { describe, expect, it } from 'vitest';
import { checkScopedQueries, discoverPackages, loadRepoTree } from './rules';

// OFF-039 check 4 — unscoped queries: the static form of freeze A12 on the
// persistence-facing data surfaces. Every package declaring @office/persistence
// (plus packages/persistence itself) must flow tenant scope through its
// EXPORTED query surface: every *Repository interface method and every
// exported function that executes .query( declares a tenant-scoping
// parameter — `scope: Scope` / `tenantId: TenantId` directly, or a typed
// input carrying the scope (or the validated A3 envelope the row's scope
// columns come from). There is no unscoped entry point. The platform
// control-plane files (migrations, test harness, restore drill) are the
// enumerated sanctioned exceptions.
describe('unscoped queries (OFF-039 architecture conformance)', () => {
  const files = loadRepoTree();

  it('derives the persistence-facing package set from the declared dependencies', () => {
    const { packages } = discoverPackages(files);
    const facing = packages.filter((pkg) => pkg.dependencies.includes('@office/persistence'));
    // The floor keeps a silently-empty derivation from ever passing; the
    // landed set spans the database surface, the domain repositories, the
    // event ledger/outbox, and the operations drill.
    expect(facing.length).toBeGreaterThanOrEqual(13);
    for (const expected of [
      'packages/events',
      'packages/domain/organization',
      'packages/domain/projects',
      'packages/operations',
      'packages/workflows',
      'packages/actions',
      'packages/agents',
      'packages/app-runtime',
    ]) {
      expect(facing.map((pkg) => pkg.dir)).toContain(expected);
    }
  });

  it('recognizes both landed scope-carrier forms on the real surfaces', () => {
    // The reference repository discipline: every method takes scope.
    const projects = files.find((file) => file.path === 'packages/persistence/src/projects.ts');
    expect(projects).toBeDefined();
    expect(projects?.text).toContain('insert(');
    expect(projects?.text).toMatch(/scope: Scope/);
    // The tenant-root discipline: the addressed tenant id is the scope.
    const tenants = files.find((file) => file.path === 'packages/persistence/src/tenants.ts');
    expect(tenants?.text).toMatch(/tenantId: TenantId/);
    // The events discipline: scope directly, or through the validated
    // envelope ("the scope columns of the row come from the validated
    // envelope's scope").
    const ledger = files.find((file) => file.path === 'packages/events/src/ledger.ts');
    expect(ledger?.text).toMatch(/scope: Scope/);
    expect(ledger?.text).toContain('envelope: DomainEventEnvelope');
  });

  it('enumerates the platform control-plane exceptions exactly', () => {
    // The exceptions are a closed, reviewed list — adding one is a README
    // rule change with the control-plane justification, never silent.
    const exceptions = [
      'packages/persistence/src/migrator.ts',
      'packages/persistence/src/testing.ts',
      'packages/operations/src/drill/backup.ts',
      'packages/operations/src/drill/restore.ts',
    ];
    for (const exception of exceptions) {
      expect(files.some((file) => file.path === exception)).toBe(true);
    }
  });

  it('passes on the entire current tree — zero unscoped exports, fail closed', () => {
    const violations = checkScopedQueries(files);
    expect(violations).toStrictEqual([]);
  });
});
