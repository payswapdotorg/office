// Office operations — THE restore step (OFF-038).
//
// The restore drill's restore leg: rebuild a FRESH empty scratch database
// from a {@link DatabaseBackup}. The procedure mirrors the runbook exactly:
//
//   1. the schema comes from the MIGRATOR, never from the dump — the
//      migrations policy (forward-only, ordered, append-never-edit) is the
//      single schema authority, so the restore target is migrated from
//      empty through the same immutable files the source was;
//   2. the data comes from the backup script — one transaction
//      (BEGIN ... COMMIT) of deterministic INSERTs, executed as a single
//      multi-statement query;
//   3. the migration ledger (`schema_migrations`) is deliberately NOT in
//      the backup: the migrator rebuilds it, which is why the restored
//      database's ledger matches the source's by construction.
//
// The step is idempotent in the runbook sense: it is only ever pointed at
// a FRESH empty database (the drill boots one; the runbook recreates one).
import type { MigrationFile, PersistencePool } from '@office/persistence';
import { createMigrator } from '@office/persistence';
import type { Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { DatabaseBackup } from './backup';

/** The typed outcome of one restore. */
export interface RestoreOutcome {
  readonly kind: 'restore-outcome';
  /** Migration files the target applied from empty (the schema rebuild). */
  readonly migrationsApplied: readonly MigrationFile[];
  /** INSERT statements executed from the backup script. */
  readonly statementsExecuted: number;
}

/** The parts one restore needs (all injectable for the drill's composition). */
export interface RestoreDatabaseBackupParts {
  /** Pool bound to the FRESH empty target database. */
  readonly pool: PersistencePool;
  /** Migrations directory (the harness hands the package's own). */
  readonly migrationsDir: string;
  /** The backup to restore. */
  readonly backup: DatabaseBackup;
  /** Injected clock for the rebuilt ledger's applied_at stamps. */
  readonly now: () => Timestamp;
}

/**
 * THE restore step: migrate the fresh target from empty, then execute the
 * backup's data script inside its own transaction. Driver faults stay loud
 * (PersistenceFailure, the operational convention); logical preconditions
 * fail closed on the Result channel.
 */
export async function restoreDatabaseBackup(
  parts: RestoreDatabaseBackupParts,
): Promise<Result<RestoreOutcome, DomainError>> {
  if (parts.backup.statementCount !== parts.backup.tables.reduce(
    (sum, entry) => sum + entry.insertStatements.length,
    0,
  )) {
    return fail(
      domainError('invariant-violation', 'backup statement count disagrees with its tables', [
        { code: 'backup-corrupt', message: parts.backup.checksum, path: null },
      ]),
    );
  }
  const migrator = createMigrator(parts.pool, {
    migrationsDir: parts.migrationsDir,
    now: parts.now,
  });
  const migrationRun = await migrator.migrate();
  await parts.pool.query(parts.backup.script);
  return ok({
    kind: 'restore-outcome',
    migrationsApplied: migrationRun.applied,
    statementsExecuted: parts.backup.statementCount,
  });
}
