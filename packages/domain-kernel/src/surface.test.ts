import { describe, expect, it } from 'vitest';
import * as kernel from './index';

// OFF-003 domain kernel — public surface tests. The runtime (value) surface
// is pinned exactly; type-only exports are exercised by the typed imports
// used across this suite and enforced by `pnpm typecheck`.

const EXPECTED_VALUE_EXPORTS = [
  // result
  'ok',
  'fail',
  'mapOk',
  'mapFailure',
  // errors
  'DOMAIN_ERROR_CODES',
  'DOMAIN_ERROR_TO_API_ERROR_CODE',
  'domainError',
  'invariantViolation',
  'concurrencyConflict',
  'entityNotFound',
  'tenantScopeViolation',
  'projectScopeViolation',
  'idempotencyConflict',
  'toApiError',
  // aggregate identity & versioning
  'INITIAL_AGGREGATE_VERSION',
  'MAX_AGGREGATE_VERSION',
  'parseAggregateVersion',
  'isAggregateVersion',
  'nextAggregateVersion',
  'parseConcurrencyToken',
  'isConcurrencyToken',
  'concurrencyTokenOf',
  'checkConcurrency',
  'checkScopeCovers',
  // invariants
  'defineInvariant',
  'checkInvariants',
  // idempotency
  'commandFingerprint',
  'createInMemoryIdempotencyRegistry',
  'withIdempotency',
];

describe('public surface (index)', () => {
  it('exports exactly the documented value surface', () => {
    expect(Object.keys(kernel).sort()).toEqual([...EXPECTED_VALUE_EXPORTS].sort());
  });

  it('pins the versioning constants', () => {
    expect(kernel.INITIAL_AGGREGATE_VERSION).toBe(1);
    expect(kernel.MAX_AGGREGATE_VERSION).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('pins the domain error taxonomy and ApiError mapping', () => {
    expect(kernel.DOMAIN_ERROR_CODES).toStrictEqual([
      'invariant-violation',
      'concurrency-conflict',
      'not-found',
      'unauthorized',
      'forbidden',
      'idempotency-conflict',
    ]);
    expect(kernel.DOMAIN_ERROR_TO_API_ERROR_CODE['concurrency-conflict']).toBe('conflict');
    expect(kernel.DOMAIN_ERROR_TO_API_ERROR_CODE['invariant-violation']).toBe(
      'validation_failed',
    );
  });
});
