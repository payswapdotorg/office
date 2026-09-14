// Office host gateway — the composed canonical migration chain (OFF-DEPLOY).
//
// The deployment's migration policy made runnable: the ORDERED UNION of every
// landed migration directory — the persistence foundation
// (DEFAULT_MIGRATIONS_DIR: 0001_tenants, 0002_projects), the events package
// (EVENTS_MIGRATIONS_DIR: 0003_event_ledger, 0004_outbox), and the
// organization + project domain modules (ORGANIZATION_MIGRATIONS_DIR: 0100,
// PROJECT_MIGRATIONS_DIR: 0101). The landed migrator binds ONE directory, so
// the union is materialized as real files in one composed directory (exactly
// the composition the landed integration suites use) and handed to
// createMigrator; versions are verified unique + strictly ascending across
// the union before anything runs (fail-closed, forward-only, never edit an
// applied file — see docs/execution/DEPLOYMENT.md, "Migration policy").
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MIGRATIONS_DIR,
  readMigrationFiles,
} from '@office/persistence';
import type { MigrationFile } from '@office/persistence';
import { EVENTS_MIGRATIONS_DIR } from '@office/events';
import { ORGANIZATION_MIGRATIONS_DIR } from '@office/domain-organization';
import { PROJECT_MIGRATIONS_DIR } from '@office/domain-projects';

/** Every landed migration directory, in canonical (version-range) order. */
export const LANDED_MIGRATION_DIRS: readonly string[] = [
  DEFAULT_MIGRATIONS_DIR,
  EVENTS_MIGRATIONS_DIR,
  ORGANIZATION_MIGRATIONS_DIR,
  PROJECT_MIGRATIONS_DIR,
];

/** Why the composed chain could not be materialized (typed, never thrown). */
export type ComposedChainFailure =
  | { readonly code: 'duplicate-migration-version'; readonly version: number; readonly files: readonly string[] }
  | { readonly code: 'migration-read-failed'; readonly detail: string };

/** The materialized composed chain: its directory + the ordered files. */
export interface ComposedMigrationChain {
  /** The directory holding the union (created by this composition). */
  readonly dir: string;
  /** Every file of the union, in strict ascending version order. */
  readonly files: readonly MigrationFile[];
  /** Remove the composed directory (best-effort, always safe to call). */
  readonly cleanup: () => Promise<void>;
}

/**
 * Compose THE canonical migration chain: read every landed migration
 * directory, merge by version, verify the union is unique and strictly
 * ascending (a duplicate or regressing version is a typed failure, never a
 * silently reordered run), and materialize the files under a fresh temporary
 * directory (or under `root` when the caller pins one). The files are copied
 * verbatim — checksums, names, and texts stay byte-identical to the landed
 * sources, so the migrator's immutability guard sees the real history.
 */
export const composeCanonicalMigrations = async (
  root?: string,
): Promise<
  { readonly ok: true; readonly value: ComposedMigrationChain } | { readonly ok: false; readonly error: ComposedChainFailure }
> => {
  const files: MigrationFile[] = [];
  try {
    for (const dir of LANDED_MIGRATION_DIRS) {
      files.push(...(await readMigrationFiles(dir)));
    }
  } catch (cause) {
    return {
      ok: false,
      error: { code: 'migration-read-failed', detail: String(cause) },
    };
  }
  files.sort((left, right) => left.version - right.version);
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous === undefined || current === undefined) continue;
    if (current.version === previous.version) {
      return {
        ok: false,
        error: {
          code: 'duplicate-migration-version',
          version: current.version,
          files: [previous.fileName, current.fileName],
        },
      };
    }
  }
  let dir: string;
  try {
    dir = await mkdtemp(join(root ?? tmpdir(), 'office-host-migrations-'));
  } catch (cause) {
    return {
      ok: false,
      error: { code: 'migration-read-failed', detail: String(cause) },
    };
  }
  try {
    for (const file of files) {
      await writeFile(join(dir, file.fileName), file.text, 'utf8');
    }
  } catch (cause) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      error: { code: 'migration-read-failed', detail: String(cause) },
    };
  }
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { ok: true, value: { dir, files: [...files], cleanup } };
};
