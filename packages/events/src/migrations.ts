// Office events — migrations location (OFF-005).
//
// The package's two forward-only migrations (0003_event_ledger.sql,
// 0004_outbox.sql) ship with the package so the ledger/outbox schema travels
// with the code that owns it. The applying machinery is @office/persistence's
// migrator (same conventions: <NNNN>_<snake_name>.sql, transactional,
// checksum-guarded); a runtime composes the full canonical chain by pointing
// the migrator at a directory containing the persistence migrations plus
// these (the integration suite does exactly that, and documents the
// composition order).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The events package's own migrations directory (packages/events/migrations). */
export const EVENTS_MIGRATIONS_DIR: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
