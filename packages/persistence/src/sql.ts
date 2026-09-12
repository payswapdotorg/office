// Office persistence — typed SQL surface over node-postgres (OFF-004).
//
// The thinnest possible typed wrapper around `pg`: one parameter-value union,
// one result shape, one executor interface. This module is deliberately NOT a
// query builder (lead-directed stack decision: hand-written SQL only) — it
// only standardizes how statements travel to PostgreSQL and what comes back,
// so every later Office module (OFF-005 events/outbox first) programs against
// these types instead of leaking `pg` driver types through the stack.
import type { QueryResult } from 'pg';

/**
 * A single bound SQL parameter value. PostgreSQL receives exactly these
 * shapes; anything else is a programming error and fails loudly in the driver.
 * Plain JSON objects are included for JSONB columns (node-postgres serializes
 * them with JSON.stringify) — extension metadata only, per freeze A2.
 */
export type SqlValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | Readonly<Record<string, unknown>>
  | readonly SqlValue[];

/** The result of one executed statement: decoded rows plus the affected count. */
export interface SqlResult {
  /** Rows decoded by node-postgres, keyed by (lowercased) column name. */
  readonly rows: readonly Record<string, unknown>[];
  /** Number of rows the statement affected (0 when none / not applicable). */
  readonly rowCount: number;
}

/**
 * Anything that can execute one SQL statement with bound parameters: the
 * pooled {@link PersistencePool}, a dedicated session, or an open
 * {@link Transaction}. Repositories accept this interface so the SAME code
 * path runs standalone and inside a transaction.
 */
export interface SqlExecutor {
  readonly query: (text: string, values?: readonly SqlValue[]) => Promise<SqlResult>;
}

/**
 * Adapt a node-postgres `QueryResult` into the persistence `SqlResult`
 * (internal helper — never exported beyond the package's pg adapters).
 *
 * A text-only (simple-protocol) query whose string carries MULTIPLE
 * statements — a migration file is exactly that — resolves to an ARRAY of
 * results in node-postgres, one per statement. The aggregate view: all rows
 * of all statements, in order, and the summed affected-row count.
 */
export const toSqlResult = (
  result:
    | QueryResult<Record<string, unknown>>
    | readonly QueryResult<Record<string, unknown>>[],
): SqlResult => {
  if ('rows' in result) {
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }
  return {
    rows: result.flatMap((part) => part.rows),
    rowCount: result.reduce((total, part) => total + (part.rowCount ?? 0), 0),
  };
};
