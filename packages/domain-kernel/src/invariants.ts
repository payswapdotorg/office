// Office domain kernel — invariant helpers (OFF-003).
//
// Declarative invariant checking, result-style: invariants are data (a named
// statement plus a pure predicate), and checking them returns a typed
// invariant-violation DomainError — never a bare throw. The canonical
// command flow (freeze "cross-view mutation"): authorization, then
// invariant validation, then the transactional persist. A handler computes
// the NEXT state, checks its invariants, and commits only on success — so a
// violated invariant leaves the aggregate state unchanged by construction.
//
// Checks stop at the first violated invariant, in declaration order, which
// makes failures deterministic. Predicates must be pure and deterministic:
// no clock, no randomness, no I/O (kernel rule).
import { fail, ok } from './result';
import type { Result } from './result';
import { invariantViolation } from './errors';
import type { DomainError, DomainErrorContext } from './errors';

/**
 * A named domain invariant over a state shape: `holds` must be a pure,
 * deterministic predicate. Declared once, checked everywhere the state is
 * about to be committed.
 */
export interface Invariant<S> {
  /** Stable machine-readable invariant name (lowercase kebab-case). */
  readonly name: string;
  /** Human-readable statement of what must always hold. */
  readonly statement: string;
  /** Pure predicate over the state; deterministic, no I/O. */
  readonly holds: (state: S) => boolean;
}

const INVARIANT_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/**
 * Declare an invariant (trusted path). Throws TypeError for an invalid name
 * or empty statement — loud, never silent.
 */
export function defineInvariant<S>(
  name: string,
  statement: string,
  holds: (state: S) => boolean,
): Invariant<S> {
  if (typeof name !== 'string' || !INVARIANT_NAME_PATTERN.test(name)) {
    throw new TypeError(`invalid invariant name: ${String(name)}`);
  }
  if (typeof statement !== 'string' || statement.length === 0) {
    throw new TypeError(`invariant '${name}' requires a non-empty statement`);
  }
  if (typeof holds !== 'function') {
    throw new TypeError(`invariant '${name}' requires a predicate function`);
  }
  return { name, statement, holds };
}

/**
 * Check a (typically next) state against invariants, in declaration order.
 * All hold → ok(state). The first violation → a typed invariant-violation
 * DomainError whose detail code is the invariant's name — the caller must
 * not commit the state, leaving the aggregate unchanged.
 */
export function checkInvariants<S>(
  state: S,
  invariants: readonly Invariant<S>[],
  context?: DomainErrorContext,
): Result<S, DomainError> {
  for (const invariant of invariants) {
    if (!invariant.holds(state)) {
      return fail(
        invariantViolation(
          { name: invariant.name, statement: invariant.statement },
          context,
        ),
      );
    }
  }
  return ok(state);
}
