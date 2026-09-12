// Office organization domain — migrations location (OFF-007).
//
// The organization package's forward-only migration (0100_organizations.sql)
// ships WITH the package so the table travels with the code that owns it —
// the same co-location convention OFF-005 established for the event ledger
// (0003/0004 under packages/events/migrations). The applying machinery is
// @office/persistence's migrator (same conventions: <NNNN>_<snake_name>.sql,
// transactional, checksum-guarded, forward-only); a runtime composes the full
// canonical chain by pointing the migrator at a directory containing the
// persistence migrations (0001, 0002), the events migrations (0003, 0004),
// and this package's (0100) — ascending version order holds throughout.
//
// Why co-located (and not added to packages/persistence/migrations): the
// frozen integration suites of @office/persistence and @office/events assert
// the exact applied-version list of THEIR composed chains; dropping new files
// into the persistence migrations directory would change those suites'
// migration sets and break them, while modifying them is outside this work
// item's ownership. Co-location keeps every suite's chain exactly what it
// composes. Documented deviation — see the package README.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The organization package's own migrations directory
 * (packages/domain/organization/migrations) — version 0100 onward only.
 */
export const ORGANIZATION_MIGRATIONS_DIR: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
