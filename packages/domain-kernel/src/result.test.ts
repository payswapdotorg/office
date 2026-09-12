import { describe, expect, it } from 'vitest';
import { fail, mapFailure, mapOk, ok } from './index';
import type { DomainError, Result } from './index';

// OFF-003 domain kernel — result tests. Deterministic: fixed values only.

const error: DomainError = {
  kind: 'domain-error',
  code: 'not-found',
  message: 'task not found',
  scope: null,
  correlationId: null,
  details: [],
};

describe('result plumbing', () => {
  it('discriminates successes and failures on `ok`', () => {
    const success: Result<number, DomainError> = ok(42);
    const failure: Result<number, DomainError> = fail(error);
    expect(success.ok).toBe(true);
    if (success.ok) expect(success.value).toBe(42);
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.error).toBe(error);
  });

  it('narrows through plain branching (no unwrap helper needed)', () => {
    const results: Result<string, DomainError>[] = [ok('applied'), fail(error)];
    const rendered = results.map((result) =>
      result.ok ? `ok:${result.value}` : `fail:${result.error.code}`,
    );
    expect(rendered).toStrictEqual(['ok:applied', 'fail:not-found']);
  });

  it('maps success values and passes failures through', () => {
    expect(mapOk(ok(2), (n) => n * 10)).toStrictEqual({ ok: true, value: 20 });
    expect(mapOk(fail(error), (n: number) => n * 10)).toStrictEqual({
      ok: false,
      error,
    });
  });

  it('maps failure errors and passes successes through', () => {
    expect(mapFailure(ok(2), (e: DomainError) => e.code)).toStrictEqual({
      ok: true,
      value: 2,
    });
    expect(mapFailure(fail(error), (e) => e.code)).toStrictEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('defaults the error channel to DomainError', () => {
    const result: Result<number> = ok(1);
    expect(result.ok).toBe(true);
  });
});
