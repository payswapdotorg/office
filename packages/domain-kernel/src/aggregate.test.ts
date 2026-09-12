import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
} from '@office/contracts';
import type { ParseResult, ProjectId, TenantId } from '@office/contracts';
import {
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
} from './index';
import type { Aggregate, AggregateVersion, ConcurrencyToken } from './index';

// OFF-003 domain kernel — aggregate identity & versioning tests.
// Deterministic: fixed ids, no clock, no randomness.

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TENANT_B_OPAQUE = 'f9e8d7c6b5a493827160f5e4d3c2b1a0';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const PROJECT_B_OPAQUE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TASK_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';
const OTHER_OPAQUE = 'c3d4e5f60718293a4b5c6d7e8f9a1b2';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const tenantA: TenantId = unwrap(
  parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_A_OPAQUE })),
);
const tenantB: TenantId = unwrap(
  parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_B_OPAQUE })),
);
const projectA: ProjectId = unwrap(
  parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_A_OPAQUE })),
);
const projectB: ProjectId = unwrap(
  parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_B_OPAQUE })),
);
const taskKind = unwrap(parseEntityKind('task'));
const taskId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: TASK_OPAQUE })));
const otherId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: OTHER_OPAQUE })));

const tenantAScope = { kind: 'tenant', tenantId: tenantA } as const;
const tenantBScope = { kind: 'tenant', tenantId: tenantB } as const;

describe('aggregate version', () => {
  it('starts at 1 and is monotonic under nextAggregateVersion', () => {
    expect(INITIAL_AGGREGATE_VERSION).toBe(1);
    expect(nextAggregateVersion(INITIAL_AGGREGATE_VERSION)).toBe(2);
    expect(nextAggregateVersion(2 as AggregateVersion)).toBe(3);
  });

  it('parses valid versions and fails closed on invalid ones', () => {
    expect(unwrap(parseAggregateVersion(1))).toBe(1);
    expect(unwrap(parseAggregateVersion(42))).toBe(42);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = parseAggregateVersion(bad);
      expect(result.ok, `version: ${String(bad)}`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-value');
    }
    for (const wrongType of ['1', null, true, undefined]) {
      const result = parseAggregateVersion(wrongType);
      expect(result.ok, `version: ${String(wrongType)}`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-type');
    }
    expect(isAggregateVersion(1)).toBe(true);
    expect(isAggregateVersion(0)).toBe(false);
    expect(isAggregateVersion('1')).toBe(false);
  });

  it('rejects versions beyond the safe integer ceiling loudly', () => {
    const tooBig = Number.MAX_SAFE_INTEGER + 1;
    expect(parseAggregateVersion(tooBig).ok).toBe(false);
    expect(() => nextAggregateVersion(MAX_AGGREGATE_VERSION)).toThrow(TypeError);
    expect(() => nextAggregateVersion(0 as AggregateVersion)).toThrow(TypeError);
  });

  it('round-trips the ceiling itself as a valid version', () => {
    expect(unwrap(parseAggregateVersion(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe('concurrency token', () => {
  it('parses and type-guards tokens with strict keys (fail closed)', () => {
    const token: ConcurrencyToken = {
      kind: 'concurrency-token',
      entityKind: taskKind,
      entityId: taskId,
      version: 7 as AggregateVersion,
    };
    const roundTripped = unwrap(
      parseConcurrencyToken(JSON.parse(JSON.stringify(token)) as unknown),
    );
    expect(roundTripped).toStrictEqual(token);
    expect(isConcurrencyToken(token)).toBe(true);

    const badCases: Array<[string, unknown, string, string]> = [
      ['unknown field', { ...token, extra: 1 }, 'unknown-field', 'extra'],
      [
        'missing version',
        { kind: 'concurrency-token', entityKind: taskKind, entityId: taskId },
        'missing-field',
        'version',
      ],
      ['wrong kind', { ...token, kind: 'token' }, 'invalid-value', 'kind'],
      ['zero version', { ...token, version: 0 }, 'invalid-value', 'version'],
      ['bad entity id', { ...token, entityId: 'not-an-id' }, 'invalid-value', 'entityId'],
    ];
    for (const [name, raw, code, path] of badCases) {
      const result = parseConcurrencyToken(raw);
      expect(result.ok, `case: ${name}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code, `case: ${name} (code)`).toBe(code);
        expect(result.error.path, `case: ${name} (path)`).toBe(path);
      }
    }
    expect(isConcurrencyToken({ kind: 'concurrency-token' })).toBe(false);
    expect(parseConcurrencyToken('token').ok).toBe(false);
  });

  it('derives the token of an aggregate (and rejects invalid versions loudly)', () => {
    const aggregate: Aggregate = {
      entityKind: taskKind,
      entityId: taskId,
      scope: tenantAScope,
      version: 3 as AggregateVersion,
    };
    expect(concurrencyTokenOf(aggregate)).toStrictEqual({
      kind: 'concurrency-token',
      entityKind: taskKind,
      entityId: taskId,
      version: 3,
    });
    expect(() => concurrencyTokenOf({ ...aggregate, version: 0 as AggregateVersion })).toThrow(TypeError);
  });
});

describe('optimistic concurrency check', () => {
  const token = (version: number, entityId = taskId): ConcurrencyToken => ({
    kind: 'concurrency-token',
    entityKind: taskKind,
    entityId,
    version: version as AggregateVersion,
  });

  it('accepts a matching expected version', () => {
    const result = checkConcurrency(token(4), token(4));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it('rejects a stale version with a typed concurrency-conflict', () => {
    const result = checkConcurrency(token(3), token(5));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('concurrency-conflict');
      expect(result.error.message).toContain('expected version 3');
      expect(result.error.message).toContain('actual version 5');
      expect(result.error.details[0]?.code).toBe('stale-aggregate-version');
    }
  });

  it('rejects future versions as conflicts too (never silent overwrite)', () => {
    const result = checkConcurrency(token(9), token(5));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('concurrency-conflict');
  });

  it('treats a token addressing a different aggregate as a loud programming error', () => {
    expect(() => checkConcurrency(token(4, otherId), token(4))).toThrow(TypeError);
  });
});

describe('scope coverage check (freeze A12)', () => {
  it('covers same-tenant and same-project scopes', () => {
    const projectAScope = {
      kind: 'project',
      tenantId: tenantA,
      projectId: projectA,
    } as const;
    expect(checkScopeCovers(tenantAScope, tenantAScope).ok).toBe(true);
    expect(checkScopeCovers(projectAScope, projectAScope).ok).toBe(true);
    expect(checkScopeCovers(projectAScope, tenantAScope).ok).toBe(true);
  });

  it('rejects cross-tenant access with a typed tenant-scope violation', () => {
    const result = checkScopeCovers(tenantAScope, tenantBScope);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('tenant-scope-violation');
    }
  });

  it('rejects cross-project access with a typed project-scope violation', () => {
    const result = checkScopeCovers(
      { kind: 'project', tenantId: tenantA, projectId: projectA },
      { kind: 'project', tenantId: tenantA, projectId: projectB },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-violation');
    }
  });

  it('lets a project-scoped command cover a tenant-wide aggregate of the same tenant', () => {
    const result = checkScopeCovers(
      { kind: 'project', tenantId: tenantA, projectId: projectA },
      tenantAScope,
    );
    expect(result.ok).toBe(true);
  });

  it('never lets a tenant-scoped command cross into another tenant', () => {
    const result = checkScopeCovers(
      { kind: 'tenant', tenantId: tenantB },
      { kind: 'project', tenantId: tenantA, projectId: projectA },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unauthorized');
  });
});
