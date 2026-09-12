// Office domain kernel — public surface (OFF-003).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-004 persistence, OFF-005 events, OFF-006 authz, OFF-007+ domains)
// consume the kernel only through this root entry point, never through
// deeper paths. Anything not re-exported here is package-internal and may
// change without notice.
//
// The package imports exactly one dependency — @office/contracts — and
// nothing else (dependency rule: domain modules depend only inward on
// shared kernel contracts). No persistence, no event ledger, no outbox:
// those are OFF-004/OFF-005.
//
// Surface summary:
// - result:        Result, ok, fail, mapOk, mapFailure
// - errors:        DomainError, DomainErrorCode, DOMAIN_ERROR_CODES,
//                  DOMAIN_ERROR_TO_API_ERROR_CODE, toApiError + one builder
//                  per taxonomy code
// - aggregate:     Aggregate, AggregateVersion, ConcurrencyToken (+parse/is
//                  helpers, INITIAL/MAX versions, nextAggregateVersion),
//                  concurrencyTokenOf, checkConcurrency, checkScopeCovers
// - invariants:    Invariant, defineInvariant, checkInvariants
// - idempotency:   CommandFingerprint, commandFingerprint,
//                  IdempotencyRegistry, IdempotencyLookup,
//                  createInMemoryIdempotencyRegistry, withIdempotency
// - command:       CommandExecutionContext, CommandHandler, CommandResult

// Total, typed result plumbing.
export { fail, mapFailure, mapOk, ok } from './result';
export type { Result } from './result';

// Domain error taxonomy (aligned with the contracts ApiError vocabulary).
export {
  DOMAIN_ERROR_CODES,
  DOMAIN_ERROR_TO_API_ERROR_CODE,
  concurrencyConflict,
  domainError,
  entityNotFound,
  idempotencyConflict,
  invariantViolation,
  projectScopeViolation,
  tenantScopeViolation,
  toApiError,
} from './errors';
export type {
  DomainError,
  DomainErrorContext,
  DomainErrorCode,
  DomainErrorDetail,
} from './errors';

// Aggregate identity & versioning with optimistic concurrency (A12 backstop).
export {
  INITIAL_AGGREGATE_VERSION,
  MAX_AGGREGATE_VERSION,
  checkConcurrency,
  checkScopeCovers,
  concurrencyTokenOf,
  isAggregateVersion,
  isConcurrencyToken,
  nextAggregateVersion,
  parseAggregateVersion,
  parseConcurrencyToken,
} from './aggregate';
export type {
  Aggregate,
  AggregateVersion,
  ConcurrencyToken,
} from './aggregate';

// Declarative invariant checking (result-style, never bare throws).
export { checkInvariants, defineInvariant } from './invariants';
export type { Invariant } from './invariants';

// Idempotency key-registry primitives (A8 / ADR-005).
export {
  commandFingerprint,
  createInMemoryIdempotencyRegistry,
  withIdempotency,
} from './idempotency';
export type {
  CommandFingerprint,
  IdempotencyLookup,
  IdempotencyRegistry,
  IdempotentExecution,
} from './idempotency';

// Transactional command interface (interface only — OFF-004/OFF-005 own the
// transaction, ledger, and outbox).
export type {
  CommandExecutionContext,
  CommandHandler,
  CommandResult,
} from './command';
