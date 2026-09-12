// Office persistence — pooled connection surface (OFF-004).
//
// createPersistencePool wraps a node-postgres Pool behind the package's own
// typed surface: plain queries, dedicated sessions (one client held for a
// sequence of statements — used by the migrator's advisory-locked run), the
// transactional boundary, and shutdown. Everything downstream (repositories,
// OFF-005 events/outbox) programs against SqlExecutor / TransactionRunner and
// never touches `pg` types directly.
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { driverFailure } from './failure';
import { toSqlResult } from './sql';
import type { SqlExecutor, SqlResult, SqlValue } from './sql';
import { runInTransactionOnClient, sessionExecutor } from './transaction';
import type { Transaction, TransactionRunner } from './transaction';

/** Options for creating the pooled persistence surface. */
export interface PersistencePoolOptions {
  /** PostgreSQL connection string, e.g. `postgres://user:pass@host:port/db`. */
  readonly connectionString: string;
  /** Maximum pooled connections (node-postgres default when omitted). */
  readonly max?: number;
}

/**
 * The pooled PostgreSQL surface of the persistence foundation: statement
 * execution, dedicated sessions, the transaction boundary, and shutdown.
 */
export interface PersistencePool extends SqlExecutor {
  /**
   * Execute one atomic unit of work (see transaction.ts for the exact
   * rollback semantics — this is the seam OFF-005 builds on).
   */
  readonly runInTransaction: TransactionRunner['runInTransaction'];
  /**
   * Run `work` on ONE dedicated pooled client (same session for every
   * statement). Required for session-scoped state such as advisory locks;
   * transactions are the ordinary way to get atomicity.
   */
  readonly withSession: <T>(work: (session: SqlExecutor) => Promise<T>) => Promise<T>;
  /** Close the pool; in-flight queries are awaited, then connections close. */
  readonly end: () => Promise<void>;
}

/** Create the pooled persistence surface for a connection string. */
export function createPersistencePool(options: PersistencePoolOptions): PersistencePool {
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.max === undefined ? {} : { max: options.max }),
  });

  const pooledQuery = async (
    text: string,
    values?: readonly SqlValue[],
  ): Promise<SqlResult> => {
    try {
      const result =
        values === undefined || values.length === 0
          ? await pool.query<Record<string, unknown>>(text)
          : await pool.query<Record<string, unknown>>(text, [...values]);
      return toSqlResult(result);
    } catch (cause) {
      throw driverFailure('pool.query', cause);
    }
  };

  const acquireClient = async (operation: string): Promise<PoolClient> => {
    try {
      return await pool.connect();
    } catch (cause) {
      throw driverFailure(operation, cause);
    }
  };

  return {
    query: pooledQuery,
    runInTransaction: async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
      const client = await acquireClient('connect (transaction)');
      try {
        return await runInTransactionOnClient(client, work);
      } finally {
        client.release();
      }
    },
    withSession: async <T>(work: (session: SqlExecutor) => Promise<T>): Promise<T> => {
      const client = await acquireClient('connect (session)');
      try {
        return await work(sessionExecutor(client));
      } finally {
        client.release();
      }
    },
    end: async (): Promise<void> => {
      try {
        await pool.end();
      } catch (cause) {
        throw driverFailure('pool.end', cause);
      }
    },
  };
}

/**
 * Bind a {@link TransactionRunner} to a pool — the narrow seam object to
 * hand to code that should be able to run transactions (and nothing else).
 */
export const createTransactionRunner = (pool: PersistencePool): TransactionRunner => ({
  runInTransaction: (work) => pool.runInTransaction(work),
});
