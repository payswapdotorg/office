// Office persistence — the transactional boundary (OFF-004).
//
// TransactionRunner is THE seam the rest of Office uses for atomic mutation:
// a command handler's state writes and (from OFF-005 on) its event-ledger and
// outbox appends all execute inside ONE runInTransaction call, so they commit
// or vanish together. Semantics, relied on by OFF-005:
//
//   * `work` receives a Transaction — a SqlExecutor plus `rollback(value)`.
//   * `work` resolves        → COMMIT, and its value becomes the call's value.
//   * `work` throws          → ROLLBACK and the original error is rethrown
//                              (never swallowed, never replaced).
//   * `tx.rollback(value)`   → ROLLBACK, and `value` becomes the call's value.
//                              This is how a handler returns a typed
//                              DomainError failure while guaranteeing that
//                              every write of the attempt is discarded: e.g.
//                              `return tx.rollback(fail(entityNotFound(...)))`.
//
// Isolation: default READ COMMITTED. Optimistic concurrency is enforced by
// the repositories' `WHERE ... AND version = $expected` guards, which are
// exact under READ COMMITTED and keep lock contention minimal.
//
// Transactions are NOT nestable: each call acquires its own connection. Code
// that already holds a transaction passes its `tx` down as the SqlExecutor
// for every repository call instead.
import type { PoolClient } from 'pg';
import { driverFailure } from './failure';
import { toSqlResult } from './sql';
import type { SqlExecutor, SqlResult, SqlValue } from './sql';

/**
 * An open PostgreSQL transaction. A SqlExecutor (so repositories run inside
 * it unchanged) plus the cooperative {@link Transaction.rollback} escape.
 */
export interface Transaction extends SqlExecutor {
  /**
   * Roll the transaction back (discarding every write of the attempt) and
   * make `value` the result of the surrounding `runInTransaction` call.
   * Never returns; throws an internal control signal caught by the runner.
   */
  readonly rollback: <T>(value: T) => never;
}

/**
 * The transactional boundary of the persistence foundation (freeze A2:
 * PostgreSQL is the transactional system of record; canonical flows persist
 * state and outbox events atomically inside this seam).
 */
export interface TransactionRunner {
  runInTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** Internal control signal: rollback requested with a value to return. */
class RollbackSignal {
  readonly kind = 'rollback-signal' as const;
  constructor(readonly value: unknown) {}
}

/** Adapt a dedicated pg client into the package's SqlExecutor (internal). */
export const sessionExecutor = (client: PoolClient, operation = 'session.query'): SqlExecutor => ({
  query: async (text: string, values?: readonly SqlValue[]): Promise<SqlResult> => {
    try {
      // No values (or none bound) keeps pg on the simple query protocol,
      // which is what allows multi-statement migration files to run as one
      // unit of work.
      const result =
        values === undefined || values.length === 0
          ? await client.query<Record<string, unknown>>(text)
          : await client.query<Record<string, unknown>>(text, [...values]);
      return toSqlResult(result);
    } catch (cause) {
      throw driverFailure(operation, cause);
    }
  },
});

/** Build the Transaction handle over an already-connected client. */
const transactionOver = (client: PoolClient): Transaction => {
  const executor = sessionExecutor(client, 'transaction.query');
  return {
    query: executor.query,
    rollback: <T>(value: T): never => {
      throw new RollbackSignal(value);
    },
  };
};

/**
 * Run `work` as one transaction on a dedicated client that the caller
 * acquires/releases (used by the pool adapter; exported for symmetry with
 * the package's internals only through the pool surface).
 */
export const runInTransactionOnClient = async <T>(
  client: PoolClient,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  try {
    await client.query('BEGIN');
  } catch (cause) {
    throw driverFailure('BEGIN', cause);
  }
  let value: T;
  try {
    value = await work(transactionOver(client));
  } catch (error) {
    if (error instanceof RollbackSignal) {
      // Cooperative rollback: discard the writes, return the caller's value.
      try {
        await client.query('ROLLBACK');
      } catch (cause) {
        throw driverFailure('ROLLBACK', cause);
      }
      return error.value as T;
    }
    // Unexpected failure: best-effort rollback, then rethrow the ORIGINAL
    // error — the runner never masks what actually went wrong.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection already unusable; releasing the client ends the
      // transaction server-side.
    }
    throw error;
  }
  try {
    await client.query('COMMIT');
  } catch (cause) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A failed COMMIT already ended the transaction server-side.
    }
    throw driverFailure('COMMIT', cause);
  }
  return value;
};
