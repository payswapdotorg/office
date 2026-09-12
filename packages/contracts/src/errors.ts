// Office canonical contracts — errors (OFF-002).
//
// ApiError: the machine-readable error envelope returned by Office API
// surfaces (DoD: "Error semantics are explicit and machine-readable").
//
// Scope and correlation id are null exactly when the failing request could
// not establish them (for example, malformed input rejected before a scope
// or correlation id could be read); they are never silently omitted when
// known (freeze A12 — every read/write path is tenant-scoped).
//
// Mapping guidance: envelope parse failures (ContractParseError, code
// 'unknown-schema-version') map to ApiErrorCode 'unsupported_schema_version'
// or 'validation_failed'; authorization outcomes map to 'unauthorized' /
// 'forbidden' (enforced by OFF-006, not here).
import {
  describeValue,
  isPlainObject,
  joinPath,
  parseFail,
  parseOk,
  requireLiteral,
  requireNullableFieldWith,
  requireString,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import type { ParseResult } from './parse';
import { parseScope } from './scope';
import type { Scope } from './scope';
import { parseCorrelationId } from './events';
import type { CorrelationId } from './events';

/** Stable, machine-readable API error codes. */
export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unsupported_schema_version'
  | 'rate_limited'
  | 'internal'
  | 'unavailable';

const API_ERROR_CODES: readonly ApiErrorCode[] = [
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

/** One structured, machine-readable error detail. */
export interface ApiErrorDetail {
  /** Stable machine-readable detail code, e.g. 'missing_field'. */
  readonly code: string;
  /** Human-readable explanation safe to display. */
  readonly message: string;
  /** Dotted path to the offending part, or null when not applicable. */
  readonly path: string | null;
}

/** Machine-readable error envelope returned by Office API surfaces. */
export interface ApiError {
  readonly kind: 'error';
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Tenant/project scope of the failing request, or null when unavailable. */
  readonly scope: Scope | null;
  /** Correlation id of the failing request, or null when unavailable. */
  readonly correlationId: CorrelationId | null;
  readonly details: readonly ApiErrorDetail[];
}

/** Shape description used in parse failures. */
export const API_ERROR_GRAMMAR =
  'ApiError: { kind, code, message, retryable, scope, correlationId, details }';

/** Shape description used in parse failures. */
export const API_ERROR_DETAIL_GRAMMAR = '{ code, message, path: string | null }';

const API_ERROR_KEYS = [
  'kind',
  'code',
  'message',
  'retryable',
  'scope',
  'correlationId',
  'details',
] as const;

const API_ERROR_DETAIL_KEYS = ['code', 'message', 'path'] as const;

const MESSAGE_RULE: StringRule = {
  min: 1,
  max: 512,
  description: 'human-readable message',
};

const DETAIL_CODE_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z0-9][a-z0-9_.-]{0,63}$/,
  description: 'lowercase machine-readable detail code',
};

const DETAIL_MESSAGE_RULE: StringRule = {
  min: 1,
  max: 512,
  description: 'human-readable detail message',
};

const DETAIL_PATH_RULE: StringRule = {
  min: 1,
  max: 256,
  pattern: /^[\x21-\x7e]{1,256}$/,
  description: 'dotted path (printable, no whitespace) or null',
};

/** Parse an untrusted value as an ApiErrorDetail (total, fail-closed, strict keys). */
function parseApiErrorDetail(raw: unknown): ParseResult<ApiErrorDetail> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', API_ERROR_DETAIL_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, API_ERROR_DETAIL_KEYS, '', API_ERROR_DETAIL_GRAMMAR);
  if (unknownKey) return unknownKey;
  const code = requireString(raw, 'code', '', DETAIL_CODE_RULE);
  if (!code.ok) return code;
  const message = requireString(raw, 'message', '', DETAIL_MESSAGE_RULE);
  if (!message.ok) return message;
  const pathValue = raw['path'];
  if (pathValue === undefined) {
    return parseFail('missing-field', 'path', 'dotted path or null', 'undefined');
  }
  if (pathValue === null) {
    return parseOk({ code: code.value, message: message.value, path: null } satisfies ApiErrorDetail);
  }
  const path = requireString(raw, 'path', '', DETAIL_PATH_RULE);
  if (!path.ok) return path;
  return parseOk({ code: code.value, message: message.value, path: path.value } satisfies ApiErrorDetail);
}

/**
 * Parse an untrusted value as an ApiError (total, fail-closed, strict keys).
 * `scope` and `correlationId` may be null (unestablished context); every
 * other field is required and validated.
 */
export function parseApiError(raw: unknown): ParseResult<ApiError> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', API_ERROR_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, API_ERROR_KEYS, '', API_ERROR_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['error']);
  if (!kind.ok) return kind;
  const code = requireLiteral(raw, 'code', '', API_ERROR_CODES);
  if (!code.ok) return code;
  const message = requireString(raw, 'message', '', MESSAGE_RULE);
  if (!message.ok) return message;
  const retryable = raw['retryable'];
  if (retryable === undefined) {
    return parseFail('missing-field', 'retryable', 'boolean', 'undefined');
  }
  if (typeof retryable !== 'boolean') {
    return parseFail('invalid-type', 'retryable', 'boolean', describeValue(retryable));
  }
  const scope = requireNullableFieldWith(raw, 'scope', '', parseScope);
  if (!scope.ok) return scope;
  const correlationId = requireNullableFieldWith(raw, 'correlationId', '', parseCorrelationId);
  if (!correlationId.ok) return correlationId;
  const detailsRaw = raw['details'];
  if (detailsRaw === undefined) {
    return parseFail('missing-field', 'details', 'array of ApiErrorDetail', 'undefined');
  }
  if (!Array.isArray(detailsRaw)) {
    return parseFail('invalid-type', 'details', 'array of ApiErrorDetail', describeValue(detailsRaw));
  }
  const details: ApiErrorDetail[] = [];
  for (const [index, item] of detailsRaw.entries()) {
    const detail = parseApiErrorDetail(item);
    if (!detail.ok) {
      return parseFail(
        detail.error.code,
        joinPath(`details[${index}]`, detail.error.path),
        detail.error.expected,
        detail.error.received,
      );
    }
    details.push(detail.value);
  }
  return parseOk(
    {
      kind: 'error',
      code: code.value as ApiErrorCode,
      message: message.value,
      retryable,
      scope: scope.value,
      correlationId: correlationId.value,
      details,
    } satisfies ApiError,
  );
}

/** Type guard for structurally valid ApiError values. */
export function isApiError(raw: unknown): raw is ApiError {
  return parseApiError(raw).ok;
}
