// Office operations — THE deterministic SQL backup (OFF-038).
//
// The restore drill's backup step: a hand-rolled deterministic SQL dump over
// a live scratch database. pg_dump is not available as a library, so the
// dump is composed from the catalog itself:
//
//   * the table set comes from information_schema.tables (BASE TABLE rows
//     outside the system schemas), ordered by (schema, table) — the table
//     enumeration is total and deterministic;
//   * the DUMP ORDER is restore-safe: tables are emitted in a deterministic
//     topological order over the foreign-key graph (a referenced table is
//     always dumped before its dependents, alphabetical tie-break), so the
//     script's INSERTs never violate a foreign key on replay — the drill
//     caught the alphabetical order doing exactly that;
//   * each table's columns come from information_schema.columns in
//     ordinal_position order, and its primary key from the constraint
//     catalog — rows are read with ORDER BY over the primary key columns
//     when a key exists, else over every column in ordinal order, so the
//     row order is deterministic by construction;
//   * every row renders as one INSERT statement with inlined literals
//     (NULL / TRUE / FALSE / numeric / quoted string / ISO-8601 timestamp /
//     JSON text for jsonb) — no parameter placeholders, because the script
//     is a restorable artifact, not a query;
//   * `schema_migrations` is EXCLUDED on purpose: the migration ledger is
//     derived state, rebuilt deterministically by the migrator itself from
//     the immutable migration files (the migrations policy); the backup
//     carries business data, the migrator carries schema + ledger;
//   * the script is a single BEGIN ... COMMIT transaction with the INSERTs
//     in table order, and its sha256 checksum is part of the typed record.
//
// Determinism: no clocks, no randomness, no environment reads — the same
// database content always produces the byte-identical script. That property
// IS the drill's comparison basis (compare.ts).
import { createHash } from 'node:crypto';
import { PersistenceFailure } from '@office/persistence';
import type { SqlExecutor, SqlResult } from '@office/persistence';

/** The tables whose contents are derived state, not backup payload. */
export const BACKUP_EXCLUDED_TABLES: readonly string[] = ['schema_migrations'];

/** Schemas that belong to the database system, never to the application. */
const SYSTEM_SCHEMAS: readonly string[] = ['information_schema', 'pg_catalog', 'pg_toast'];

/** One table's deterministic data dump. */
export interface BackupTableDump {
  /** Schema the table lives in (e.g. `public`). */
  readonly schema: string;
  /** Table name (e.g. `tenants`). */
  readonly table: string;
  /** Column names in ordinal order — the INSERT column order. */
  readonly columns: readonly string[];
  /** Primary-key column names in key order (empty when the table has none). */
  readonly primaryKey: readonly string[];
  /** Row count read from the table. */
  readonly rowCount: number;
  /** One INSERT statement per row, in the deterministic read order. */
  readonly insertStatements: readonly string[];
}

/** THE deterministic SQL backup of a whole scratch database. */
export interface DatabaseBackup {
  readonly kind: 'database-backup';
  /** Tables dumped, in the restore-safe (dependency-first) order. */
  readonly tables: readonly BackupTableDump[];
  /** Total INSERT statements in the script. */
  readonly statementCount: number;
  /** The restorable script: BEGIN; INSERTs; COMMIT; */
  readonly script: string;
  /** sha256 hex digest of the script — the content identity. */
  readonly checksum: string;
}

/** Quote one identifier (catalog-sourced, but quoted closed anyway). */
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Render one SQL string literal (standard-conforming doubles). */
const quoteString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Render one row value as an inlined SQL literal. */
const sqlLiteralOf = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'string') {
    // BIGINT arrives as a decimal string from the driver; an unquoted
    // decimal literal round-trips exactly through both BIGINT and TEXT
    // columns (an unknown-typed literal casts to the column's type).
    return /^(0|[1-9][0-9]*)$/.test(value) ? value : quoteString(value);
  }
  if (value instanceof Date) return quoteString(value.toISOString());
  if (typeof value === 'object') return quoteString(JSON.stringify(value));
  throw new TypeError(`backup cannot render value as a SQL literal: ${String(value)}`);
};

/** One catalog table row (validated on read — corrupt catalog rows fail loud). */
interface CatalogTable {
  readonly schema: string;
  readonly table: string;
}

const qualifiedNameOf = (entry: CatalogTable): string => `${entry.schema}.${entry.table}`;

/** One foreign-key dependency edge (referenced table -> dependent table). */
interface ForeignKeyEdge {
  /** The table whose rows reference the other (must be dumped AFTER it). */
  readonly dependent: string;
  /** The table being referenced (dumped BEFORE the dependent). */
  readonly referenced: string;
}

/** Read one text field off a catalog row, failing closed on corruption. */
const requireCatalogText = (row: Record<string, unknown>, field: string): string => {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistenceFailure(
      'row-corruption',
      `information_schema row field '${field}' is not non-empty text`,
      { cause: row },
    );
  }
  return value;
};

const readCatalogTables = async (db: SqlExecutor): Promise<readonly CatalogTable[]> => {
  const result: SqlResult = await db.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN (${SYSTEM_SCHEMAS.map(quoteString).join(', ')})
      ORDER BY table_schema ASC, table_name ASC`,
  );
  return result.rows.map((row) => ({
    schema: requireCatalogText(row, 'table_schema'),
    table: requireCatalogText(row, 'table_name'),
  }));
};

/** Read the foreign-key edges (deduped), validated fail-closed. */
const readForeignKeyEdges = async (db: SqlExecutor): Promise<readonly ForeignKeyEdge[]> => {
  const result: SqlResult = await db.query(
    `SELECT kcu.table_schema AS dependent_schema, kcu.table_name AS dependent_table,
            ccu.table_schema AS referenced_schema, ccu.table_name AS referenced_table
       FROM information_schema.referential_constraints rc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema = rc.constraint_schema
        AND kcu.constraint_name = rc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_schema = rc.unique_constraint_schema
        AND ccu.constraint_name = rc.unique_constraint_name
      WHERE rc.constraint_schema NOT IN (${SYSTEM_SCHEMAS.map(quoteString).join(', ')})`,
  );
  const edges = new Map<string, ForeignKeyEdge>();
  for (const row of result.rows) {
    const edge: ForeignKeyEdge = {
      dependent: `${requireCatalogText(row, 'dependent_schema')}.${requireCatalogText(row, 'dependent_table')}`,
      referenced: `${requireCatalogText(row, 'referenced_schema')}.${requireCatalogText(row, 'referenced_table')}`,
    };
    edges.set(`${edge.dependent}->${edge.referenced}`, edge);
  }
  return [...edges.values()];
};

/**
 * The restore-safe dump order: a deterministic topological sort over the
 * foreign-key graph — every referenced table is emitted before its
 * dependents (edges to tables outside the dump, and self-references, never
 * delay a table), with the alphabetically-first ready table as the
 * tie-break. A foreign-key CYCLE is broken deterministically by taking the
 * alphabetically-first remaining table (the canonical schema is acyclic).
 */
const orderTablesForRestore = (
  tables: readonly CatalogTable[],
  edges: readonly ForeignKeyEdge[],
): readonly CatalogTable[] => {
  const dumped = new Set(tables.map(qualifiedNameOf));
  const pending = [...tables];
  const placed = new Set<string>();
  const ordered: CatalogTable[] = [];
  while (pending.length > 0) {
    const readyIndex = pending.findIndex((candidate) => {
      const name = qualifiedNameOf(candidate);
      return edges.every(
        (edge) =>
          edge.dependent !== name ||
          edge.referenced === name ||
          !dumped.has(edge.referenced) ||
          placed.has(edge.referenced),
      );
    });
    const index = readyIndex === -1 ? 0 : readyIndex;
    const [next] = pending.splice(index, 1);
    if (next === undefined) break;
    placed.add(qualifiedNameOf(next));
    ordered.push(next);
  }
  return ordered;
};

const readColumns = async (
  db: SqlExecutor,
  schema: string,
  table: string,
): Promise<readonly string[]> => {
  const result = await db.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position ASC`,
    [schema, table],
  );
  return result.rows.map((row) => String(row['column_name']));
};

const readPrimaryKey = async (
  db: SqlExecutor,
  schema: string,
  table: string,
): Promise<readonly string[]> => {
  const result = await db.query(
    `SELECT kcu.column_name AS column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
        AND kcu.table_name = tc.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = $1 AND tc.table_name = $2
      ORDER BY kcu.ordinal_position ASC`,
    [schema, table],
  );
  return result.rows.map((row) => String(row['column_name']));
};

const renderInsert = (
  qualified: string,
  columns: readonly string[],
  row: Record<string, unknown>,
): string => {
  const columnList = columns.map(quoteIdentifier).join(', ');
  const literals = columns.map((column) => sqlLiteralOf(row[column])).join(', ');
  return `INSERT INTO ${qualified} (${columnList}) VALUES (${literals});`;
};

/**
 * THE backup step: dump a whole database as one deterministic SQL script.
 * Throws PersistenceFailure on driver faults (the operational convention);
 * returns the typed backup record on success.
 */
export async function createDatabaseBackup(db: SqlExecutor): Promise<DatabaseBackup> {
  const tables: BackupTableDump[] = [];
  const catalogTables = orderTablesForRestore(
    await readCatalogTables(db),
    await readForeignKeyEdges(db),
  );
  for (const catalogTable of catalogTables) {
    const schema = catalogTable.schema;
    const table = catalogTable.table;
    if (BACKUP_EXCLUDED_TABLES.includes(table)) continue;
    const columns = await readColumns(db, schema, table);
    if (columns.length === 0) {
      throw new TypeError(`table ${schema}.${table} has no columns in the catalog`);
    }
    const primaryKey = await readPrimaryKey(db, schema, table);
    const orderColumns = primaryKey.length > 0 ? primaryKey : columns;
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const columnList = columns.map(quoteIdentifier).join(', ');
    const orderList = orderColumns.map(quoteIdentifier).join(', ');
    const rows = await db.query(
      `SELECT ${columnList} FROM ${qualified} ORDER BY ${orderList} ASC`,
    );
    const insertStatements = rows.rows.map((row) =>
      renderInsert(qualified, columns, row as Record<string, unknown>),
    );
    tables.push({ schema, table, columns, primaryKey, rowCount: rows.rows.length, insertStatements });
  }

  const statementCount = tables.reduce((sum, entry) => sum + entry.insertStatements.length, 0);
  const script = ['BEGIN;', ...tables.flatMap((entry) => [...entry.insertStatements]), 'COMMIT;']
    .map((line) => `${line}\n`)
    .join('');
  const checksum = createHash('sha256').update(script, 'utf8').digest('hex');
  return {
    kind: 'database-backup',
    tables,
    statementCount,
    script,
    checksum,
  };
}
