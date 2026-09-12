import { describe, expect, it } from 'vitest';
import {
  formatProjectId,
  formatTenantId,
  isApiError,
  parseApiError,
  parseCorrelationId,
  parseProjectId,
  parseScope,
  parseTenantId,
} from './index';
import type { ApiError, ApiErrorCode, ParseResult } from './index';

// OFF-002 contracts — errors tests. Deterministic: fixed ids and codes.

const TENANT_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PROJECT_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const roundTrip = (value: unknown, parse: (raw: unknown) => ParseResult<unknown>): void => {
  const parsed = parse(JSON.parse(JSON.stringify(value)) as unknown);
  if (!parsed.ok) {
    throw new Error(`round-trip parse failed: ${JSON.stringify(parsed.error)}`);
  }
  expect(parsed.value).toStrictEqual(value);
};

const tenantId = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_OPAQUE })));
const projectId = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_OPAQUE })));
const scope = unwrap(parseScope({ kind: 'project', tenantId, projectId }));
const correlationId = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));

const fullError: ApiError = {
  kind: 'error',
  code: 'validation_failed',
  message: 'Command envelope rejected: payload failed domain validation.',
  retryable: false,
  scope,
  correlationId,
  details: [
    { code: 'missing_field', message: 'name is required', path: 'payload.name' },
    { code: 'invalid_value', message: 'code must be unique per tenant', path: 'payload.code' },
  ],
};

const minimalError: ApiError = {
  kind: 'error',
  code: 'bad_request',
  message: 'Request body is not a valid command envelope.',
  retryable: false,
  scope: null,
  correlationId: null,
  details: [],
};

describe('api error envelope', () => {
  it('round-trips a fully-scoped error through JSON', () => {
    roundTrip(fullError, parseApiError);
  });

  it('round-trips an unscoped error (null scope and correlation id)', () => {
    roundTrip(minimalError, parseApiError);
  });

  it('round-trips every documented error code', () => {
    const codes: ApiErrorCode[] = [
      'bad_request',
      'validation_failed',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'unsupported_schema_version',
      'rate_limited',
      'internal',
      'unavailable',
    ];
    for (const code of codes) {
      roundTrip({ ...minimalError, code }, parseApiError);
    }
  });

  it('type-guards api errors', () => {
    expect(isApiError(JSON.parse(JSON.stringify(fullError)) as unknown)).toBe(true);
    expect(isApiError({ kind: 'error' })).toBe(false);
    expect(isApiError('error')).toBe(false);
  });

  it('accepts null scope and correlationId but requires their presence', () => {
    const missingScope = JSON.parse(JSON.stringify(fullError)) as Record<string, unknown>;
    delete missingScope['scope'];
    const scopeResult = parseApiError(missingScope);
    expect(scopeResult.ok).toBe(false);
    if (!scopeResult.ok) {
      expect(scopeResult.error.code).toBe('missing-field');
      expect(scopeResult.error.path).toBe('scope');
    }
    const missingCorrelation = JSON.parse(JSON.stringify(fullError)) as Record<string, unknown>;
    delete missingCorrelation['correlationId'];
    const correlationResult = parseApiError(missingCorrelation);
    expect(correlationResult.ok).toBe(false);
    if (!correlationResult.ok) {
      expect(correlationResult.error.code).toBe('missing-field');
      expect(correlationResult.error.path).toBe('correlationId');
    }
  });

  it('rejects malformed errors field by field with typed paths', () => {
    const cases: Array<{
      name: string;
      mutate: (raw: Record<string, unknown>) => void;
      code: string;
      path: string;
    }> = [
      {
        name: 'missing code',
        mutate: (raw) => {
          delete raw['code'];
        },
        code: 'missing-field',
        path: 'code',
      },
      {
        name: 'unknown code',
        mutate: (raw) => {
          raw['code'] = 'teapot';
        },
        code: 'invalid-value',
        path: 'code',
      },
      {
        name: 'missing message',
        mutate: (raw) => {
          delete raw['message'];
        },
        code: 'missing-field',
        path: 'message',
      },
      {
        name: 'empty message',
        mutate: (raw) => {
          raw['message'] = '';
        },
        code: 'invalid-value',
        path: 'message',
      },
      {
        name: 'missing retryable',
        mutate: (raw) => {
          delete raw['retryable'];
        },
        code: 'missing-field',
        path: 'retryable',
      },
      {
        name: 'non-boolean retryable',
        mutate: (raw) => {
          raw['retryable'] = 'no';
        },
        code: 'invalid-type',
        path: 'retryable',
      },
      {
        name: 'missing details',
        mutate: (raw) => {
          delete raw['details'];
        },
        code: 'missing-field',
        path: 'details',
      },
      {
        name: 'non-array details',
        mutate: (raw) => {
          raw['details'] = {};
        },
        code: 'invalid-type',
        path: 'details',
      },
      {
        name: 'detail missing message',
        mutate: (raw) => {
          raw['details'] = [{ code: 'missing_field', path: null }];
        },
        code: 'missing-field',
        path: 'details[0].message',
      },
      {
        name: 'detail bad code',
        mutate: (raw) => {
          raw['details'] = [{ code: 'Bad Code', message: 'x', path: null }];
        },
        code: 'invalid-value',
        path: 'details[0].code',
      },
      {
        name: 'detail empty path',
        mutate: (raw) => {
          raw['details'] = [{ code: 'missing_field', message: 'x', path: '' }];
        },
        code: 'invalid-value',
        path: 'details[0].path',
      },
      {
        name: 'detail non-string path',
        mutate: (raw) => {
          raw['details'] = [{ code: 'missing_field', message: 'x', path: 42 }];
        },
        code: 'invalid-type',
        path: 'details[0].path',
      },
      {
        name: 'detail unknown field',
        mutate: (raw) => {
          raw['details'] = [{ code: 'missing_field', message: 'x', path: null, hint: 'y' }];
        },
        code: 'unknown-field',
        path: 'details[0].hint',
      },
      {
        name: 'unknown top-level field',
        mutate: (raw) => {
          raw['trace'] = 'external-123';
        },
        code: 'unknown-field',
        path: 'trace',
      },
      {
        name: 'wrong kind',
        mutate: (raw) => {
          raw['kind'] = 'api-error';
        },
        code: 'invalid-value',
        path: 'kind',
      },
      {
        name: 'invalid scope tenant id',
        mutate: (raw) => {
          const scopeValue = raw['scope'] as Record<string, unknown>;
          scopeValue['tenantId'] = '12345';
        },
        code: 'invalid-value',
        path: 'scope.tenantId',
      },
    ];
    for (const testCase of cases) {
      const raw = JSON.parse(JSON.stringify(fullError)) as Record<string, unknown>;
      testCase.mutate(raw);
      const result = parseApiError(raw);
      expect(result.ok, `case: ${testCase.name}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code, `case: ${testCase.name} (code)`).toBe(testCase.code);
        expect(result.error.path, `case: ${testCase.name} (path)`).toBe(testCase.path);
      }
    }
  });
});
