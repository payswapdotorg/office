// Office persistence — ordered plain-SQL migrations + migrator (OFF-004).
//
// Migration system contract (forward-only, immutable once applied):
//   * migrations live as plain `.sql` files named `<NNNN>_<snake_name>.sql`
//     (4-digit zero-padded version, 1..9999) under a migrations directory;
//   * files apply in ascending version order, each inside its OWN transaction
//     that also records the run in the `schema_migrations` ledger table — a
//     failed migration rolls back completely and the run stops;
//   * already-applied migrations are verified by sha256 checksum: editing an
//     applied file is a hard error, and a pending file whose version is below
//     the high-water mark violates forward-only ordering;
//   * the whole run is serialized cluster-wide with a session advisory lock,
//     so concurrent migrators (two app instances booting at once) queue
//     instead of racing;
//   * the migrator runs from an EMPTY database (it bootstraps the ledger
//     table itself) — never point it at a database with existing state.
//
// The applied_at timestamps come from an injected clock when determinism
// matters (tests); the default reads the wall clock, which is fine for
// operational metadata.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTimestamp } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import { PersistenceFailure } from './failure';
import type { PersistencePool } from './pool';
import { readAggregateVersion, readText, readTimestamp } from './rows';
import type { SqlExecutor } from './sql';

/** Filename grammar of a migration: `<NNNN>_<snake_name>.sql`. */
export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.sql$/;

/** The package's own migrations directory (packages/persistence/migrations). */
export const DEFAULT_MIGRATIONS_DIR: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * Session advisory-lock key serializing migrators cluster-wide. The bytes
 * spell 'OFFICE' — an arbitrary but stable and documented constant.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 0x4f4646494345;

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    BIGINT PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL
)`;

/** One migration file, decoded and checksummed. */
export interface MigrationFile {
  /** Version from the filename prefix (1..9999). */
  readonly version: number;
  /** Snake-case name from the filename stem. */
  readonly name: string;
  /** Full filename, e.g. `0002_projects.sql`. */
  readonly fileName: string;
  /** The SQL text, verbatim. */
  readonly text: string;
  /** sha256 hex digest of the SQL text (immutability guard). */
  readonly checksum: string;
}

/** One recorded application of a migration. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Timestamp;
}

/** Outcome of one `migrate()` run. */
export interface MigrationRunResult {
  /** Migration files applied by THIS run, in application order. */
  readonly applied: readonly MigrationFile[];
  /** Already-applied files whose checksums were verified by this run. */
  readonly verified: readonly MigrationFile[];
}

/** Options for creating a migrator. */
export interface MigratorOptions {
  /** Migrations directory (default: the package's own `migrations/`). */
  readonly migrationsDir?: string;
  /** Injected clock for `applied_at` (tests inject a fixed instant). */
  readonly now?: () => Timestamp;
}

/** The migrator: applies pending migrations, records and verifies history. */
export interface Migrator {
  /** Apply every pending migration; safe to re-run (idempotent no-op). */
  migrate(): Promise<MigrationRunResult>;
  /** The applied-migrations ledger, ascending by version. */
  appliedMigrations(): Promise<readonly AppliedMigration[]>;
}

/**
 * Parse a migration filename (trusted path: violations throw a typed
 * PersistenceFailure('migration-validation') instead of being skipped —
 * a typo'd migration file must never be silently ignored).
 */
export function parseMigrationFileName(fileName: string): { version: number; name: string } {
  const match = MIGRATION_FILE_PATTERN.exec(fileName);
  if (match === null) {
    throw new PersistenceFailure(
      'migration-validation',
      `migration file '${fileName}' does not match <NNNN>_<snake_name>.sql`,
    );
  }
  const version = Number(match[1]);
  const name = match[2] ?? '';
  if (!Number.isInteger(version) || version < 1 || version > 9999 || name.length === 0) {
    throw new PersistenceFailure(
      'migration-validation',
      `migration file '${fileName}' has an invalid version or name`,
    );
  }
  return { version, name };
}

const checksumOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Read and validate every migration file in `dir`: names must match the
 * grammar, versions must be unique and strictly ascending, files must be
 * readable. Returned in application order.
 */
export async function readMigrationFiles(dir: string): Promise<readonly MigrationFile[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    throw new PersistenceFailure('migration-validation', `cannot read migrations directory: ${dir}`, {
      cause,
    });
  }
  const files: MigrationFile[] = [];
  for (const fileName of entries.filter((entry) => !entry.startsWith('.')).sort()) {
    const { version, name } = parseMigrationFileName(fileName);
    let text: string;
    try {
      text = await readFile(join(dir, fileName), 'utf8');
    } catch (cause) {
      throw new PersistenceFailure('migration-validation', `cannot read migration file: ${fileName}`, {
        cause,
      });
    }
    files.push({ version, name, fileName, text, checksum: checksumOf(text) });
  }
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous === undefined || current === undefined) continue;
    if (current.version <= previous.version) {
      throw new PersistenceFailure(
        'migration-validation',
        `migration versions must be unique and strictly ascending: ${current.fileName} conflicts with ${previous.fileName}`,
      );
    }
  }
  return files;
}

/** Decode one schema_migrations ledger row (fail-closed). */
const mapAppliedRow = (row: Record<string, unknown>): AppliedMigration => ({
  version: readAggregateVersion(row, 'schema_migrations', 'version'),
  name: readText(row, 'schema_migrations', 'name'),
  checksum: readText(row, 'schema_migrations', 'checksum'),
  appliedAt: readTimestamp(row, 'schema_migrations', 'applied_at'),
});

const readApplied = async (session: SqlExecutor): Promise<readonly AppliedMigration[]> => {
  const result = await session.query(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
  );
  return result.rows.map(mapAppliedRow);
};

/** Extract the node-postgres error code/constraint pair from any thrown error. */
const describeThrown = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

/** Create a migrator bound to a pool. */
export function createMigrator(pool: PersistencePool, options: MigratorOptions = {}): Migrator {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const clock = options.now ?? ((): Timestamp => formatTimestamp(new Date()));

  const migrate = async (): Promise<MigrationRunResult> => {
    const files = await readMigrationFiles(migrationsDir);
    return pool.withSession(async (session) => {
      // Serialize migrators cluster-wide; the lock is session-bound, so the
      // dedicated session guarantees lock + ledger + DDL on one connection.
      await session.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      try {
        await session.query(SCHEMA_MIGRATIONS_DDL);
        const applied = await readApplied(session);

        // Immutability + forward-only verification against the files on disk.
        const filesByVersion = new Map(files.map((file) => [file.version, file]));
        const appliedByVersion = new Map(applied.map((entry) => [entry.version, entry]));
        for (const entry of applied) {
          const file = filesByVersion.get(entry.version);
          if (file === undefined) {
            throw new PersistenceFailure(
              'migration-validation',
              `applied migration ${entry.version} (${entry.name}) has no file in ${migrationsDir} — migrations are immutable once applied`,
            );
          }
          if (file.checksum !== entry.checksum) {
            throw new PersistenceFailure(
              'migration-validation',
              `migration ${file.fileName} was modified after being applied (checksum mismatch) — migrations are immutable once applied`,
            );
          }
        }
        const highWaterMark = applied.length === 0 ? 0 : applied[applied.length - 1]?.version ?? 0;
        const pending = files.filter((file) => !appliedByVersion.has(file.version));
        for (const file of pending) {
          if (file.version <= highWaterMark) {
            throw new PersistenceFailure(
              'migration-validation',
              `migration ${file.fileName} is below the applied high-water mark (${highWaterMark}) — migrations are forward-only`,
            );
          }
        }
        const verified = files.filter((file) => appliedByVersion.has(file.version));

        // Apply each pending migration inside its own transaction, recording
        // the run in the same transaction: a failure rolls the migration back
        // completely and stops the run.
        const appliedNow: MigrationFile[] = [];
        for (const file of pending) {
          await session.query('BEGIN');
          try {
            await session.query(file.text);
            await session.query(
              'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
              [file.version, file.name, file.checksum, clock()],
            );
            await session.query('COMMIT');
            appliedNow.push(file);
          } catch (error) {
            let rollbackError: unknown;
            try {
              await session.query('ROLLBACK');
            } catch (secondary) {
              rollbackError = secondary;
            }
            throw new PersistenceFailure(
              'migration-failed',
              `migration ${file.fileName} failed and was rolled back: ${describeThrown(error)}`,
              rollbackError === undefined ? { cause: error } : { cause: [error, rollbackError] },
            );
          }
        }
        return { applied: appliedNow, verified };
      } finally {
        // Best-effort unlock; releasing the session client ends the lock
        // server-side even when this throws.
        await session.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(
          () => undefined,
        );
      }
    });
  };

  const appliedMigrations = async (): Promise<readonly AppliedMigration[]> =>
    pool.withSession(async (session) => {
      await session.query(SCHEMA_MIGRATIONS_DDL);
      return readApplied(session);
    });

  return { migrate, appliedMigrations };
}
