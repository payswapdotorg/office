// Office domain kernel — result (OFF-003).
//
// The kernel's total, typed result type: every domain-level operation
// returns a Result instead of throwing. Throwing is reserved for loud
// TypeError programming errors on the trusted construction path (same
// convention as @office/contracts parse/format); every expected domain
// failure — invariant violation, stale version, unknown aggregate, scope
// violation, idempotency conflict — is a value a caller can branch on.
//
// Shape deliberately mirrors the contracts ParseResult (discriminated on
// `ok`): success carries `value`; failure carries a typed `error`. The
// kernel's error channel is the DomainError taxonomy (see errors.ts); the
// type parameter stays open so persistence/events (OFF-004/OFF-005) can
// reuse the same plumbing for their own typed failures.
import type { DomainError } from './errors';

/**
 * Total, typed result of a kernel/domain operation: success carries the
 * `value`; failure carries the typed `error`. Never a throw, never a silent
 * fallback.
 */
export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Build a successful Result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Build a failed Result with the typed error. */
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Map the success value, passing failures through unchanged. */
export const mapOk = <T, U, E>(
  result: Result<T, E>,
  project: (value: T) => U,
): Result<U, E> => (result.ok ? ok(project(result.value)) : result);

/** Map the failure error, passing successes through unchanged. */
export const mapFailure = <T, E, F>(
  result: Result<T, E>,
  project: (error: E) => F,
): Result<T, F> => (result.ok ? result : fail(project(result.error)));
