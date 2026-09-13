import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_EXCEPTION_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  EMPTY_POLICY,
  exceptionAuthorizationOf,
  projectOneReader,
  projectOneScope,
  tenantBScope,
} from './test-support';
import { runPortfolioScan } from './scenarios';
import type { PortfolioScanRun } from './scenarios';
import type { Exception } from './model';
import {
  exceptionNotFound,
  queryExceptionById,
  queryExceptions,
} from './authorization';
import type { ExceptionAuthorization } from './authorization';
import type { ExceptionId } from './vocabulary';

// OFF-019 exception authorization — freeze A12, enforced BEFORE any
// exception is scanned or served, deny-by-default across three layers:
//   1. the capability gate (contracts.read AND cost.read AND schedule.read)
//      fires before the record set is touched — the poisoned-set probe
//      proves the gate runs first (any record access throws);
//   2. structural scope coverage: a foreign-tenant exception is INVISIBLE —
//      querying it is a typed not-found IDENTICAL to an absent one (no
//      existence oracle), in BOTH directions;
//   3. the policy gate: explicit deny wins, no allow rule denies.

let run: PortfolioScanRun;

beforeAll(async () => {
  run = await runPortfolioScan();
});

/** A tenant-B copy of one golden exception (same identity, foreign scope). */
const tenantBException = (): Exception => ({
  ...run.exceptions[0]!,
  scope: tenantBScope(),
});

const exceptionIdOf = (exception: Exception): ExceptionId => exception.exceptionId;

/** A record set whose every access throws (the poisoned-set probe). */
const poisonedExceptions = (): readonly Exception[] =>
  new Proxy([] as unknown as Exception[], {
    get(): never {
      throw new Error('poisoned record access — the gate must fire first');
    },
  });

describe('the capability gate runs BEFORE any exception is served (OFF-019)', () => {
  for (const missing of ['contracts.read', 'cost.read', 'schedule.read'] as const) {
    it(`denies the set query missing ${missing} without touching a record`, () => {
      const reader = exceptionAuthorizationOf(projectOneScope(), {
        capabilities: ALL_EXCEPTION_CAPABILITIES.filter(
          (capability) => capability !== missing,
        ),
      });
      const result = queryExceptions(poisonedExceptions(), reader, {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details[0]?.code).toBe('missing-exception-capability');
        expect(result.error.details[0]?.message).toContain(missing);
        expect(result.error.scope).toStrictEqual(projectOneScope());
      }
    });

    it(`denies the single-exception query missing ${missing} without touching a record`, () => {
      const reader = exceptionAuthorizationOf(projectOneScope(), {
        capabilities: ALL_EXCEPTION_CAPABILITIES.filter(
          (capability) => capability !== missing,
        ),
      });
      const result = queryExceptionById(poisonedExceptions(), reader, 'scan-0001#0001' as ExceptionId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details[0]?.code).toBe('missing-exception-capability');
      }
    });
  }
});

describe('cross-tenant exception access is typed-rejected both directions (A12)', () => {
  it('serves the visible exception by identity', () => {
    const reader = projectOneReader();
    const result = queryExceptionById(run.exceptions, reader, exceptionIdOf(run.exceptions[0]!));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual(run.exceptions[0]);
    }
  });

  it('a tenant-A reader querying a tenant-B exception is not-found, identical to absent', () => {
    const reader = projectOneReader();
    const foreign = tenantBException();
    const viaForeign = queryExceptionById([foreign], reader, exceptionIdOf(foreign));
    const viaAbsent = queryExceptionById([], reader, exceptionIdOf(foreign));
    expect(viaForeign.ok).toBe(false);
    expect(viaAbsent.ok).toBe(false);
    // IDENTICAL typed rejections — the surface is never an existence oracle.
    expect(viaForeign).toStrictEqual(viaAbsent);
    if (!viaForeign.ok) {
      expect(viaForeign.error.code).toBe('not-found');
      expect(viaForeign.error.details[0]?.code).toBe('exception-not-found');
      expect(viaForeign.error.details[0]?.message).toBe(exceptionIdOf(foreign));
      // The denial context carries the REQUEST scope, never the foreign one.
      expect(viaForeign.error.scope).toStrictEqual(projectOneScope());
    }
  });

  it('a tenant-B reader querying a tenant-A exception is not-found, identical to absent', () => {
    const reader = exceptionAuthorizationOf(tenantBScope());
    const domestic = run.exceptions[0]!;
    const viaForeign = queryExceptionById(run.exceptions, reader, exceptionIdOf(domestic));
    const viaAbsent = queryExceptionById([], reader, exceptionIdOf(domestic));
    expect(viaForeign.ok).toBe(false);
    expect(viaAbsent.ok).toBe(false);
    expect(viaForeign).toStrictEqual(viaAbsent);
    if (!viaForeign.ok) {
      expect(viaForeign.error.code).toBe('not-found');
      expect(viaForeign.error.scope).toStrictEqual(tenantBScope());
    }
  });

  it('the set query serves only scope-covered exceptions (foreign ones invisible)', () => {
    const reader = projectOneReader();
    const mixed: readonly Exception[] = [
      tenantBException(),
      ...run.exceptions.map((exception) => ({ ...exception, scope: tenantBScope() })),
      ...run.exceptions,
    ];
    const result = queryExceptions(mixed, reader, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Every foreign exception is invisible; no error, no leak.
      expect(result.value).toStrictEqual(
        [...run.exceptions].sort((left, right) =>
          left.exceptionId < right.exceptionId ? -1 : left.exceptionId > right.exceptionId ? 1 : 0,
        ),
      );
    }
  });

  it('the tenant-B set query sees none of the tenant-A exceptions', () => {
    const reader = exceptionAuthorizationOf(tenantBScope());
    const result = queryExceptions(run.exceptions, reader, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual([]);
    }
  });
});

describe('the policy gate (deny-by-default) governs served exceptions (OFF-019)', () => {
  it('explicit deny excludes every exception from the set query', () => {
    const reader = exceptionAuthorizationOf(projectOneScope(), {
      policy: DENY_ALL_READS_POLICY,
    });
    const result = queryExceptions(run.exceptions, reader, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual([]);
    }
  });

  it('explicit deny turns the by-identity query into the typed not-found', () => {
    const reader = exceptionAuthorizationOf(projectOneScope(), {
      policy: DENY_ALL_READS_POLICY,
    });
    const result = queryExceptionById(run.exceptions, reader, exceptionIdOf(run.exceptions[0]!));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('exception-not-found');
    }
  });

  it('no allow rule denies by default (the empty policy)', () => {
    const reader = exceptionAuthorizationOf(projectOneScope(), { policy: EMPTY_POLICY });
    const result = queryExceptions(run.exceptions, reader, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual([]);
    }
  });
});

describe('the set query shape (OFF-019)', () => {
  it('serves every visible exception in canonical exception-id order', () => {
    const reader = projectOneReader();
    const result = queryExceptions([...run.exceptions].reverse(), reader, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((exception) => exception.exceptionId)).toStrictEqual([
        'scan-0001#0001',
        'scan-0001#0002',
        'scan-0001#0003',
        'scan-0001#0004',
        'scan-0001#0005',
      ]);
    }
  });

  it('filters by the pure kind tag', () => {
    const reader = projectOneReader();
    const result = queryExceptions(run.exceptions, reader, { kind: 'cost-overrun' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual([run.exceptions[1]]);
    }
  });

  it('an empty kind filter result is empty, never an error', () => {
    const reader = projectOneReader();
    const result = queryExceptions(run.exceptions, reader, { kind: 'dependency-risk' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((exception) => exception.kind)).toStrictEqual([
        'dependency-risk',
      ]);
    }
  });
});

describe('the typed not-found constructor (OFF-019)', () => {
  it('names the exception id and carries the request scope', () => {
    const reader: ExceptionAuthorization = projectOneReader();
    const error = exceptionNotFound('scan-0001#0099', reader);
    expect(error.code).toBe('not-found');
    expect(error.message).toBe('no exception scan-0001#0099 is visible to this request');
    expect(error.details[0]?.code).toBe('exception-not-found');
    expect(error.details[0]?.message).toBe('scan-0001#0099');
    expect(error.scope).toStrictEqual(projectOneScope());
  });
});
