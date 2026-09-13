import { beforeAll, describe, expect, it } from 'vitest';
import type { DomainError, Result } from '@office/domain-kernel';
import { runRestoreDrill } from '../index';
import type { RestoreDrillReport } from '../index';

// OFF-038 — THE restore drill: the work item's named acceptance, run over
// the real persistence integration harness (local embedded mode here:
// DATABASE_URL unset; CI mode picks the service database up automatically).
//
// ONE drill composition per beforeAll leg — migrate (from empty, then the
// no-op re-run) -> seed canonical rows through the landed repositories ->
// deterministic backup -> DESTROY the source scratch database -> restore
// into a fresh scratch -> compare TWICE on independent re-dumps. The drill
// then runs a SECOND time in the same file: both runs use the same fixed
// clock and the same fixed seed, so the repeatable-determinism acceptance
// is proven literally — the two typed reports are byte-identical.
//
// The migrations-policy verification (forward-only, ordered, append-new-
// never-edit) is asserted over the report's policy leg: every file applies
// from empty in order, the immediate re-run applies nothing and verifies
// every checksum, and the restore target reapplies the same files.
//
// Everything is deterministic: fixed clock, fixed seed, no environment
// reads beyond the harness's mode selection.

let firstRun: RestoreDrillReport;
let secondRun: RestoreDrillReport;

const expectOk = (result: Result<RestoreDrillReport, DomainError>): RestoreDrillReport => {
  if (result.ok) return result.value;
  throw new Error(`the restore drill failed: ${JSON.stringify(result.error)}`);
};

beforeAll(async () => {
  firstRun = expectOk(await runRestoreDrill());
  secondRun = expectOk(await runRestoreDrill());
}, 480_000);

describe('THE restore drill (OFF-038 named acceptance)', () => {
  it('passes: backup -> destroy -> restore -> identical content', () => {
    expect(firstRun.identical).toBe(true);
    expect(firstRun.comparisons[0]?.identical).toBe(true);
    expect(firstRun.comparisons[1]?.identical).toBe(true);
  });

  it('proves content identity twice on independent re-dumps of the restored side', () => {
    const [firstComparison, secondComparison] = firstRun.comparisons;
    if (firstComparison === undefined || secondComparison === undefined) {
      throw new Error('the drill report must carry exactly two comparison passes');
    }
    expect(firstComparison.differences).toEqual([]);
    expect(secondComparison.differences).toEqual([]);
    expect(firstComparison.missingTables).toEqual([]);
    expect(secondComparison.missingTables).toEqual([]);
    expect(firstComparison.extraTables).toEqual([]);
    expect(secondComparison.extraTables).toEqual([]);
    // Both passes compare the ORIGINAL backup's checksum against their own
    // independent re-dump: the restored content is byte-identical to the
    // pre-destroy content, twice.
    expect(firstComparison.sourceChecksum).toBe(firstRun.backup.checksum);
    expect(firstComparison.targetChecksum).toBe(firstRun.backup.checksum);
    expect(secondComparison.sourceChecksum).toBe(firstRun.backup.checksum);
    expect(secondComparison.targetChecksum).toBe(firstRun.backup.checksum);
    expect(JSON.stringify(firstComparison)).toBe(JSON.stringify(secondComparison));
  });

  it('carries the seeded canonical rows in the backup (and never the derived ledger)', () => {
    expect(firstRun.seed).toEqual({ tenants: 2, projects: 3, updates: 2 });
    expect(firstRun.backup.tables).toContain('public.tenants');
    expect(firstRun.backup.tables).toContain('public.projects');
    expect(firstRun.backup.tables).not.toContain('public.schema_migrations');
    // 2 tenants + 3 projects, one rename and one update in place (never
    // extra rows) — the updates are proven by the version columns below.
    expect(firstRun.backup.statementCount).toBe(5);
    expect(firstRun.restore.statementsExecuted).toBe(firstRun.backup.statementCount);
    expect(firstRun.destroy.dropped).toBe(true);
  });

  it('keeps every per-table verdict identical with non-trivial row counts', () => {
    for (const verdict of firstRun.comparisons[0]?.tables ?? []) {
      expect(verdict.identical, `table ${verdict.table}`).toBe(true);
      expect(verdict.sourceRows).toBe(verdict.targetRows);
      expect(verdict.sourceRows).toBeGreaterThan(0);
    }
    const rowsByName = new Map(
      (firstRun.comparisons[0]?.tables ?? []).map((verdict) => [verdict.table, verdict.sourceRows]),
    );
    expect(rowsByName.get('public.tenants')).toBe(2);
    expect(rowsByName.get('public.projects')).toBe(3);
  });
});

describe('the migrations-policy verification (forward-only, ordered)', () => {
  it('applies every migration file from the empty source, in order', () => {
    expect(firstRun.migrationsPolicy.filesInOrder).toEqual([
      '0001_tenants.sql',
      '0002_projects.sql',
    ]);
    expect(firstRun.migrationsPolicy.sourceAppliedFromEmpty).toEqual(
      firstRun.migrationsPolicy.filesInOrder,
    );
  });

  it('re-running the migrator is a no-op that verifies every applied checksum', () => {
    expect(firstRun.migrationsPolicy.sourceReRunApplied).toEqual([]);
    expect(firstRun.migrationsPolicy.sourceReRunVerified).toEqual(
      firstRun.migrationsPolicy.filesInOrder,
    );
  });

  it('restores the target schema from empty through the same immutable files', () => {
    expect(firstRun.migrationsPolicy.targetAppliedFromEmpty).toEqual(
      firstRun.migrationsPolicy.filesInOrder,
    );
  });
});

describe('the drill is deterministic and repeatable', () => {
  it('two independent drill runs produce byte-identical typed reports', () => {
    expect(JSON.stringify(secondRun)).toBe(JSON.stringify(firstRun));
  });

  it('derives a stable backup checksum from content alone', () => {
    expect(secondRun.backup.checksum).toBe(firstRun.backup.checksum);
    expect(firstRun.backup.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
