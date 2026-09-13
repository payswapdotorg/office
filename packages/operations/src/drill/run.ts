// Office operations — THE restore drill composition (OFF-038).
//
// The named acceptance of the work item, as one deterministic run:
//
//   1. MIGRATE   the source harness's EMPTY scratch database (the harness
//                hands an empty database by contract) — every migration
//                applies, in order; then migrate() runs AGAIN and must be
//                a no-op (the forward-only migrations policy, verified);
//   2. SEED      canonical-shaped rows (two tenants, three projects, one
//                rename, one optimistic-concurrency update) through the
//                LANDED persistence repositories — the typed project path,
//                chosen over hand-written SQL because it exercises exactly
//                the surfaces production writes through (scope isolation,
//                optimistic concurrency, typed timestamps);
//   3. BACKUP    the deterministic SQL dump (backup.ts);
//   4. DESTROY   the source scratch database: the harness's stop() ends
//                its pool and DROPS the database — the data is gone;
//   5. RESTORE   into the FRESH target scratch database: migrate from
//                empty (schema authority) + execute the backup script
//                (restore.ts);
//   6. COMPARE   the restored database is dumped through the SAME backup
//                function and compared against the pre-destroy backup —
//                the comparison runs TWICE on independent re-dumps, and
//                both comparison records must be identical (determinism).
//
// The target harness boots BEFORE the destroy so the drill performs exactly
// one embedded-cluster lifecycle per run in local mode (the harness
// refcounts the process-local cluster). Harness boots are injectable for
// tests and alternative substrates; the clock is injected everywhere.
import { parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { ParseResult, ProjectId, Scope, TenantId, Timestamp } from '@office/contracts';
import { ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  createMigrator,
  createProjectsRepository,
  createTenantsRepository,
  readMigrationFiles,
  startPersistenceTestHarness,
} from '@office/persistence';
import type { PersistenceTestHarness, SqlExecutor } from '@office/persistence';
import { createDatabaseBackup } from './backup';
import type { DatabaseBackup } from './backup';
import { compareBackups } from './compare';
import type { DatabaseComparison } from './compare';
import { restoreDatabaseBackup } from './restore';

/** Loud trusted-path unwrap: drill fixtures are literals, so a parse
 *  failure is a programming error, never a runtime branch. */
const expectOk = <T>(result: ParseResult<T>, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`invalid drill fixture ${what}: ${result.error.expected}`);
};

/** The canonical seed's fixed identities (the reference scenario's
 *  identity conventions: office-tnt-v1-<opaque> / office-prj-v1-<opaque>). */
const DRILL_TENANT_A: TenantId = expectOk(
  parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
  'tenant A id',
);
const DRILL_TENANT_B: TenantId = expectOk(
  parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160f5e4d3c2b1a0'),
  'tenant B id',
);
const DRILL_PROJECT_A1: ProjectId = expectOk(
  parseProjectId('office-prj-v1-4f9d2c81a7e34b5d90c1f2e3a4b5c6d7'),
  'project A1 id',
);
const DRILL_PROJECT_A2: ProjectId = expectOk(
  parseProjectId('office-prj-v1-a1b2c3d4e5f60718293a4b5c6d7e8f9'),
  'project A2 id',
);
const DRILL_PROJECT_B1: ProjectId = expectOk(
  parseProjectId('office-prj-v1-9990abcdef1234567890abcdef123456'),
  'project B1 id',
);

const DRILL_NOW_1: Timestamp = expectOk(
  parseTimestamp('2025-01-06T08:00:00.000Z'),
  'clock instant 1',
);
const DRILL_NOW_2: Timestamp = expectOk(
  parseTimestamp('2025-01-06T09:30:00.000Z'),
  'clock instant 2',
);
const DRILL_NOW_3: Timestamp = expectOk(
  parseTimestamp('2025-01-06T11:15:00.000Z'),
  'clock instant 3',
);

/** The drill's fixed clock (deterministic by construction). */
export const drillClock = (): Timestamp => DRILL_NOW_1;

/** What one seed step wrote. */
export interface SeedSummary {
  readonly tenants: number;
  readonly projects: number;
  readonly updates: number;
}

/**
 * One seed step: writes canonical-shaped rows into a migrated database.
 * Implemented through the landed repositories (the typed path production
 * writes through); returns the typed summary for the drill report.
 */
export type SeedStep = (db: SqlExecutor) => Promise<Result<SeedSummary, DomainError>>;

/** THE canonical seed: two tenants, three projects, one rename, one update. */
export const seedCanonicalRows: SeedStep = async (db) => {
  const tenants = createTenantsRepository();
  const projects = createProjectsRepository();
  const scopeTenantA: Scope = { kind: 'tenant', tenantId: DRILL_TENANT_A };
  const scopeTenantB: Scope = { kind: 'tenant', tenantId: DRILL_TENANT_B };

  const insertedTenantA = await tenants.insert(db, {
    tenantId: DRILL_TENANT_A,
    displayName: 'Drill Tenant A',
    now: DRILL_NOW_1,
  });
  if (!insertedTenantA.ok) return insertedTenantA;
  const insertedTenantB = await tenants.insert(db, {
    tenantId: DRILL_TENANT_B,
    displayName: 'Drill Tenant B',
    now: DRILL_NOW_1,
  });
  if (!insertedTenantB.ok) return insertedTenantB;

  const insertedA1 = await projects.insert(db, scopeTenantA, {
    projectId: DRILL_PROJECT_A1,
    name: 'Drill Project A1',
    now: DRILL_NOW_1,
  });
  if (!insertedA1.ok) return insertedA1;
  const insertedA2 = await projects.insert(db, scopeTenantA, {
    projectId: DRILL_PROJECT_A2,
    name: 'Drill Project A2',
    extensionMetadata: { phase: 'execution', region: 'north' },
    now: DRILL_NOW_2,
  });
  if (!insertedA2.ok) return insertedA2;
  const insertedB1 = await projects.insert(db, scopeTenantB, {
    projectId: DRILL_PROJECT_B1,
    name: 'Drill Project B1',
    now: DRILL_NOW_2,
  });
  if (!insertedB1.ok) return insertedB1;

  // One tenant rename and one optimistic-concurrency project update: the
  // restored content then carries non-trivial rows (version > 1, moved
  // updated_at, jsonb metadata) — a restore that silently lost UPDATEs
  // would fail the comparison.
  const renamed = await tenants.rename(
    db,
    DRILL_TENANT_A,
    insertedTenantA.value.version,
    'Drill Tenant A (renamed)',
    DRILL_NOW_3,
  );
  if (!renamed.ok) return renamed;
  const updated = await projects.update(
    db,
    scopeTenantA,
    DRILL_PROJECT_A1,
    insertedA1.value.version,
    { extensionMetadata: { phase: 'closeout', region: 'north', gate: 2 } },
    DRILL_NOW_3,
  );
  if (!updated.ok) return updated;

  return ok({ tenants: 2, projects: 3, updates: 2 });
};

/** Injectables for the drill (defaults boot the persistence harness). */
export interface RestoreDrillDeps {
  /** Boot the SOURCE scratch database (default: the persistence harness). */
  readonly bootSource?: () => Promise<PersistenceTestHarness>;
  /** Boot the TARGET scratch database (default: the persistence harness). */
  readonly bootTarget?: () => Promise<PersistenceTestHarness>;
  /** The seed step (default: the canonical rows through the repositories). */
  readonly seed?: SeedStep;
  /** Injected clock (default: the drill's fixed instant). */
  readonly now?: () => Timestamp;
}

/** The migrations-policy leg of the drill report. */
export interface MigrationsPolicyReport {
  /** Every migration file on disk, in application order. */
  readonly filesInOrder: readonly string[];
  /** What the SOURCE applied from empty (expected: every file, in order). */
  readonly sourceAppliedFromEmpty: readonly string[];
  /** What the SOURCE's re-run applied (expected: none — the no-op proof). */
  readonly sourceReRunApplied: readonly string[];
  /** What the SOURCE's re-run verified by checksum (expected: every file). */
  readonly sourceReRunVerified: readonly string[];
  /** What the TARGET applied from empty during the restore. */
  readonly targetAppliedFromEmpty: readonly string[];
}

/** THE typed restore-drill report. */
export interface RestoreDrillReport {
  readonly kind: 'restore-drill-report';
  readonly migrationsPolicy: MigrationsPolicyReport;
  readonly seed: SeedSummary;
  readonly backup: {
    readonly tables: readonly string[];
    readonly statementCount: number;
    readonly checksum: string;
  };
  readonly destroy: { readonly dropped: boolean };
  readonly restore: { readonly statementsExecuted: number };
  /** Two independent comparison passes (the determinism proof). */
  readonly comparisons: readonly [DatabaseComparison, DatabaseComparison];
  /** True iff both comparison passes found the content identical. */
  readonly identical: boolean;
}

/**
 * THE restore drill: harness up -> migrate (from empty, then the no-op
 * re-run) -> seed -> backup -> destroy -> restore into a fresh scratch ->
 * compare twice. One embedded-cluster lifecycle per run in local mode; the
 * drill stops every harness it booted. Deterministic: fixed clock, fixed
 * seed, no environment reads.
 */
export async function runRestoreDrill(
  deps: RestoreDrillDeps = {},
): Promise<Result<RestoreDrillReport, DomainError>> {
  const bootSource = deps.bootSource ?? startPersistenceTestHarness;
  const bootTarget = deps.bootTarget ?? startPersistenceTestHarness;
  const seed = deps.seed ?? seedCanonicalRows;
  const now = deps.now ?? drillClock;

  const source = await bootSource();
  let target: PersistenceTestHarness | undefined;
  let sourceDestroyed = false;
  try {
    // (1) MIGRATE from empty + the forward-only no-op proof.
    const files = await readMigrationFiles(source.migrationsDir);
    const sourceMigrator = createMigrator(source.pool, {
      migrationsDir: source.migrationsDir,
      now,
    });
    const firstRun = await sourceMigrator.migrate();
    const reRun = await sourceMigrator.migrate();

    // (2) SEED canonical rows through the landed repositories.
    const seedResult = await seed(source.pool);
    if (!seedResult.ok) return seedResult;

    // (3) BACKUP: the deterministic dump of the live source database.
    const backup: DatabaseBackup = await createDatabaseBackup(source.pool);

    // (4)+(5) boot the FRESH target first (one cluster lifecycle), then
    // DESTROY the source (stop() ends its pool and drops the database),
    // then RESTORE the backup into the fresh target.
    target = await bootTarget();
    await source.stop();
    sourceDestroyed = true;
    const restoreResult = await restoreDatabaseBackup({
      pool: target.pool,
      migrationsDir: target.migrationsDir,
      backup,
      now,
    });
    if (!restoreResult.ok) return restoreResult;

    // (6) COMPARE — twice, on independent re-dumps of the restored side.
    const firstComparison = compareBackups(backup, await createDatabaseBackup(target.pool));
    const secondComparison = compareBackups(backup, await createDatabaseBackup(target.pool));

    return ok({
      kind: 'restore-drill-report',
      migrationsPolicy: {
        filesInOrder: files.map((file) => file.fileName),
        sourceAppliedFromEmpty: firstRun.applied.map((file) => file.fileName),
        sourceReRunApplied: reRun.applied.map((file) => file.fileName),
        sourceReRunVerified: reRun.verified.map((file) => file.fileName),
        targetAppliedFromEmpty: restoreResult.value.migrationsApplied.map(
          (file) => file.fileName,
        ),
      },
      seed: seedResult.value,
      backup: {
        tables: backup.tables.map((entry) => `${entry.schema}.${entry.table}`),
        statementCount: backup.statementCount,
        checksum: backup.checksum,
      },
      destroy: { dropped: true },
      restore: { statementsExecuted: restoreResult.value.statementsExecuted },
      comparisons: [firstComparison, secondComparison],
      identical:
        firstComparison.identical &&
        secondComparison.identical &&
        JSON.stringify(firstComparison) === JSON.stringify(secondComparison),
    });
  } finally {
    // Tear down target-first (its scratch drop needs the cluster alive),
    // then the source unless the destroy step already consumed it.
    if (target !== undefined) {
      await target.stop().catch(() => undefined);
    }
    if (!sourceDestroyed) {
      await source.stop().catch(() => undefined);
    }
  }
}
