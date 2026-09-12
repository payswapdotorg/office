import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseApiError,
  parseCorrelationId,
  parseEntityId,
  parseEntityKind,
  parseIdempotencyKey,
  parseProjectId,
  parseScope,
  parseTenantId,
} from '@office/contracts';
import type { ParseResult, Scope } from '@office/contracts';
import {
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
} from './index';

// OFF-003 domain kernel — domain error model tests. Deterministic: fixed
// ids and fixed context.

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TENANT_B_OPAQUE = 'f9e8d7c6b5a493827160f5e4d3c2b1a0';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const PROJECT_B_OPAQUE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9';
const ENTITY_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const tenantA = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_A_OPAQUE })));
const tenantB = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_B_OPAQUE })));
const projectA = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_A_OPAQUE })));
const projectB = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_B_OPAQUE })));
const entityId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: ENTITY_OPAQUE })));
const entityKind = unwrap(parseEntityKind('task'));
const correlationId = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));
const idempotencyKey = unwrap(parseIdempotencyKey('idem-4f9d2c81a7e3'));
const scope: Scope = unwrap(
  parseScope({ kind: 'project', tenantId: tenantA, projectId: projectA }),
);

describe('domain error taxonomy', () => {
  it('lists the codes in taxonomy order', () => {
    expect(DOMAIN_ERROR_CODES).toStrictEqual([
      'invariant-violation',
      'concurrency-conflict',
      'not-found',
      'unauthorized',
      'forbidden',
      'idempotency-conflict',
    ]);
  });

  it('maps every code onto the contracts ApiError vocabulary', () => {
    expect(DOMAIN_ERROR_TO_API_ERROR_CODE).toStrictEqual({
      'invariant-violation': 'validation_failed',
      'concurrency-conflict': 'conflict',
      'not-found': 'not_found',
      unauthorized: 'unauthorized',
      forbidden: 'forbidden',
      'idempotency-conflict': 'conflict',
    });
  });

  it('builds invariant violations with the invariant name as detail code', () => {
    const error = invariantViolation(
      { name: 'done-count-within-item-count', statement: 'done count never exceeds item count' },
      { scope, correlationId },
    );
    expect(error.kind).toBe('domain-error');
    expect(error.code).toBe('invariant-violation');
    expect(error.message).toBe(
      "invariant 'done-count-within-item-count' violated: done count never exceeds item count",
    );
    expect(error.scope).toStrictEqual(scope);
    expect(error.correlationId).toBe(correlationId);
    expect(error.details).toStrictEqual([
      {
        code: 'done-count-within-item-count',
        message: 'done count never exceeds item count',
        path: null,
      },
    ]);
  });

  it('builds concurrency conflicts carrying expected and actual versions', () => {
    const error = concurrencyConflict(
      { entityKind, entityId, expectedVersion: 3, actualVersion: 5 },
      { scope, correlationId },
    );
    expect(error.code).toBe('concurrency-conflict');
    expect(error.message).toBe(
      `stale version for task ${entityId}: expected version 3, actual version 5`,
    );
    expect(error.details).toStrictEqual([
      {
        code: 'stale-aggregate-version',
        message: 'expected version 3, actual version 5',
        path: 'version',
      },
    ]);
  });

  it('builds not-found, tenant/project scope violations, and idempotency conflicts', () => {
    expect(entityNotFound({ entityKind, entityId }, { scope }).code).toBe('not-found');
    expect(entityNotFound({ entityKind, entityId }).message).toBe(`task ${entityId} not found`);
    const tenantViolation = tenantScopeViolation(
      { commandTenantId: tenantA, aggregateTenantId: tenantB },
      { scope },
    );
    expect(tenantViolation.code).toBe('unauthorized');
    expect(tenantViolation.details[0]?.code).toBe('tenant-scope-violation');
    const projectViolation = projectScopeViolation(
      { commandProjectId: projectA, aggregateProjectId: projectB },
      { scope },
    );
    expect(projectViolation.code).toBe('unauthorized');
    expect(projectViolation.details[0]?.code).toBe('project-scope-violation');
    const idempotency = idempotencyConflict({ idempotencyKey });
    expect(idempotency.code).toBe('idempotency-conflict');
    expect(idempotency.details[0]?.code).toBe('idempotency-key-reuse');
  });

  it('defaults scope and correlation id to null when no context is given', () => {
    const error = entityNotFound({ entityKind, entityId });
    expect(error.scope).toBeNull();
    expect(error.correlationId).toBeNull();
    expect(error.details).toHaveLength(1);
  });

  it('builds arbitrary typed errors via the generic constructor (loudly)', () => {
    const error = domainError(
      'forbidden',
      'actor lacks capability',
      [{ code: 'missing-capability', message: 'tasks.archiveTask', path: null }],
      { scope },
    );
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe('actor lacks capability');
    expect(() => domainError('nope' as never, 'x', [])).toThrow(TypeError);
    expect(() => domainError('forbidden', '', [])).toThrow(TypeError);
  });

  it('translates to ApiError envelopes that round-trip through contracts parsing', () => {
    const conflict = concurrencyConflict(
      { entityKind, entityId, expectedVersion: 1, actualVersion: 2 },
      { scope, correlationId },
    );
    const api = toApiError(conflict);
    expect(api.kind).toBe('error');
    expect(api.code).toBe('conflict');
    expect(api.retryable).toBe(true);
    expect(api.scope).toStrictEqual(scope);
    expect(api.correlationId).toBe(correlationId);
    expect(unwrap(parseApiError(JSON.parse(JSON.stringify(api)) as unknown))).toStrictEqual(api);

    const violation = invariantViolation({
      name: 'done-count-within-item-count',
      statement: 'done count never exceeds item count',
    });
    const violationApi = toApiError(violation);
    expect(violationApi.code).toBe('validation_failed');
    expect(violationApi.retryable).toBe(false);
    expect(violationApi.scope).toBeNull();
    expect(unwrap(parseApiError(JSON.parse(JSON.stringify(violationApi)) as unknown))).toStrictEqual(
      violationApi,
    );
  });
});
