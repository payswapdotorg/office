// Office persistence — typed infrastructure failure (OFF-004).
//
// The domain-kernel convention splits failures in two: EXPECTED domain
// failures are values on the Result channel (typed DomainErrors — not-found,
// unauthorized, concurrency-conflict, ...), while UNEXPECTED faults are loud
// exceptions. Persistence follows the same split: every repository method
// returns Result<T, DomainError> for outcomes a caller can branch on, and
// throws this typed PersistenceFailure for operational faults the caller
// cannot resolve by branching — driver/connection errors, corrupt rows,
// broken migration files. Raw driver errors are never surfaced as Result
// values and never swallowed: they always ride inside a PersistenceFailure
// (as `cause`) so transport boundaries can translate them precisely.
import type { SqlResult } from './sql';

/** Machine-readable persistence fault codes. */
export type PersistenceFailureCode =
  /** The PostgreSQL driver raised an unexpected error (connection, syntax, ...). */
  | 'driver-error'
  /** A migration file violated the naming/ordering contract before any SQL ran. */
  | 'migration-validation'
  /** A migration's SQL failed; its transaction was rolled back. */
  | 'migration-failed'
  /** A persisted row did not match the expected schema/shape. */
  | 'row-corruption';

/**
 * Typed operational fault thrown by persistence internals. Expected domain
 * outcomes are never thrown — they are DomainErrors on the Result channel.
 */
export class PersistenceFailure extends Error {
  readonly kind = 'persistence-failure' as const;
  readonly code: PersistenceFailureCode;

  constructor(code: PersistenceFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PersistenceFailure';
    this.code = code;
  }
}

/** Fail with a driver error, preserving the driver's own error as `cause`. */
export const driverFailure = (operation: string, cause: unknown): PersistenceFailure =>
  new PersistenceFailure(
    'driver-error',
    `PostgreSQL operation failed (${operation}): ${describeCause(cause)}`,
    { cause },
  );

/** Fail with a corrupt-row error, including the offending row. */
export const rowCorruption = (table: string, field: string, row: SqlResult['rows'][number]): PersistenceFailure =>
  new PersistenceFailure(
    'row-corruption',
    `corrupt row in table '${table}': field '${field}' has unexpected value ${safeJson(row[field])}`,
    { cause: row },
  );

/**
 * Inspect a thrown error for a node-postgres error code/constraint pair.
 * Unwraps a PersistenceFailure's `cause` first, so repositories can map known
 * constraint violations regardless of which layer wrapped the driver error.
 */
export const driverErrorInfo = (
  error: unknown,
): { readonly code?: unknown; readonly constraint?: unknown } => {
  const cause =
    error instanceof PersistenceFailure ? error.cause : error;
  if (typeof cause === 'object' && cause !== null) {
    const candidate = cause as { code?: unknown; constraint?: unknown };
    return { code: candidate.code, constraint: candidate.constraint };
  }
  return {};
};

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return code === undefined ? cause.message : `${cause.message} (code ${String(code)})`;
  }
  return String(cause);
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
};
