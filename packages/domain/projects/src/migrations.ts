// Office project domain — migrations location (OFF-007).
//
// The project package's forward-only migration (0101_projects_lifecycle.sql)
// ships WITH the package so the lifecycle travels with the code that owns it
// — the same co-location convention OFF-005 established for the event ledger
// (0003/0004 under packages/events/migrations) and OFF-007's organization
// module follows (0100 under packages/domain/organization/migrations). The
// `projects` TABLE itself belongs to the OFF-004 foundation (migration 0002,
// immutable): 0101 is a pure additive ALTER that gives it the explicit
// active->archived lifecycle without touching 0002. The applying machinery is
// @office/persistence's migrator (same conventions: <NNNN>_<snake_name>.sql,
// transactional, checksum-guarded, forward-only); a runtime composes the full
// canonical chain by pointing the migrator at a directory containing the
// persistence migrations (0001, 0002), the events migrations (0003, 0004),
// the organization migration (0100), and this package's (0101) — ascending
// version order holds throughout.
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
 * The project package's own migrations directory
 * (packages/domain/projects/migrations) — version 0101 onward only.
 */
export const PROJECT_MIGRATIONS_DIR: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
