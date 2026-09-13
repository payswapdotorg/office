// Office sync — package-internal parse plumbing (OFF-028).
//
// Total, fail-closed parse combinators for the sync package's own value
// types (protocol versions, grants, subscriptions, slice cursors, stream
// messages, operations, conflict records), built on the PUBLIC contracts
// parse plumbing (ParseResult, parseOk, parseFail — the same typed
// ContractParseError surface every Office boundary uses). Mirrors the
// internal helper layers of the contracts, authz, and adapters-sdk
// packages: those helpers are deliberately package-internal there, so this
// module repeats the small combinator set for sync.
//
// Exported for the other modules of this package only; deliberately NOT
// re-exported by src/index.ts.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';

/** Narrow unknown to a plain JSON object (not null, not an array). */
export const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const preview = (value: string): string =>
  value.length > 32 ? `${value.slice(0, 32)}…` : value;

/** Short, safe description of an unknown value for error messages. */
export const describeValue = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  switch (typeof raw) {
    case 'string':
      return `string ${JSON.stringify(preview(raw))}`;
    case 'number':
      return `number ${String(raw)}`;
    case 'boolean':
      return `boolean ${String(raw)}`;
    case 'object':
      return Array.isArray(raw) ? `array (length ${raw.length})` : 'object';
    default:
      return typeof raw;
  }
};

/** Join a path prefix and a relative sub-path into one dotted path. */
export const joinPath = (prefix: string, sub: string): string =>
  sub === '' ? prefix : `${prefix}.${sub}`;

/** Path of `field` inside the value at `parentPath` ('' = root). */
const fieldPath = (parentPath: string, field: string): string =>
  parentPath === '' ? field : `${parentPath}.${field}`;

/**
 * Repath a nested parse result: sub-parsers report paths relative to their
 * own root; composition prefixes the parent field name.
 */
const nest = <T>(
  result: ParseResult<T>,
  parentPath: string,
  field: string,
): ParseResult<T> => {
  if (result.ok) return result;
  return parseFail(
    result.error.code,
    joinPath(fieldPath(parentPath, field), result.error.path),
    result.error.expected,
    result.error.received,
  );
};

/** First key of `raw` outside `allowed`, or null when the keys match exactly. */
const firstUnknownKey = (
  raw: Record<string, unknown>,
  allowed: readonly string[],
): string | null => {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
};

/** Fail-closed unknown-key check (strict shapes: unknown fields are errors). */
export const unknownKeyFailure = (
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  grammar: string,
): ParseResult<never> | null => {
  const key = firstUnknownKey(raw, allowed);
  if (key === null) return null;
  return parseFail('unknown-field', fieldPath(path, key), grammar, `unexpected key "${key}"`);
};

/** Require a literal-valued field (discriminator or closed enum). */
export const requireLiteral = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
  allowed: readonly string[],
): ParseResult<string> => {
  const expected = allowed.map((value) => `'${value}'`).join(' | ');
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), expected, 'undefined');
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return parseFail('invalid-value', fieldPath(path, field), expected, describeValue(value));
  }
  return parseOk(value);
};

/**
 * Require a field by delegating to its sub-parser. An absent field fails with
 * 'missing-field' (reusing the sub-parser's own expected description); a
 * present field is validated with error paths nested under the field name.
 */
export const requireFieldWith = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T> => {
  const value = raw[field];
  if (value === undefined) {
    const probe = parseValue(value);
    const expected = probe.ok ? 'a required field' : probe.error.expected;
    return parseFail('missing-field', fieldPath(path, field), expected, 'undefined');
  }
  return nest(parseValue(value), path, field);
};

/** Require a nullable field: null is accepted; otherwise the sub-parser runs. */
export const requireNullableFieldWith = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | null> => {
  const value = raw[field];
  if (value === null) return parseOk(null);
  if (value === undefined) {
    const probe = parseValue(value);
    const expected = probe.ok ? 'a required field' : probe.error.expected;
    return parseFail('missing-field', fieldPath(path, field), expected, 'undefined');
  }
  return nest(parseValue(value), path, field);
};

/**
 * Parse an OPTIONAL field: absent → undefined; present → the sub-parser runs
 * (with the field name available for path reporting).
 */
export const optionalField = <T>(
  raw: Record<string, unknown>,
  field: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | undefined> => {
  const value = raw[field];
  if (value === undefined) return parseOk(undefined);
  return parseValue(value);
};

/**
 * Parse an array field whose elements are validated by `parseValue`, in
 * order, with duplicates rejected (set-like semantics). Element failures
 * report paths like '<field>[3]'.
 */
export const parseValueArray = <T>(
  raw: unknown,
  field: string,
  parseValue: (value: unknown) => ParseResult<T>,
  expected: string,
): ParseResult<readonly T[]> => {
  if (raw === undefined) {
    return parseFail('missing-field', field, expected, 'undefined');
  }
  if (!Array.isArray(raw)) {
    return parseFail('invalid-type', field, expected, describeValue(raw));
  }
  const values: T[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = parseValue(item);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        `${field}[${index}]`,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    if (values.includes(parsed.value)) {
      return parseFail(
        'invalid-value',
        `${field}[${index}]`,
        expected,
        `duplicate value '${String(parsed.value)}'`,
      );
    }
    values.push(parsed.value);
  }
  return parseOk(values);
};

/**
 * Parse an array field of literal strings drawn from a closed enum, with
 * duplicates rejected. Element failures report paths like '<field>[1]'.
 */
export const parseLiteralArray = (
  raw: unknown,
  field: string,
  allowed: readonly string[],
  expected: string,
): ParseResult<readonly string[]> =>
  parseValueArray(
    raw,
    field,
    (value) => {
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return parseFail('invalid-value', '', expected, describeValue(value));
      }
      return parseOk(value);
    },
    expected,
  );

/**
 * Parse a constrained string field (a branded token grammar): length bounds
 * plus an anchored pattern, with the field name available for paths.
 */
export const parseToken = (
  raw: unknown,
  field: string,
  pattern: RegExp,
  expected: string,
): ParseResult<string> => {
  if (typeof raw !== 'string' || !pattern.test(raw)) {
    return parseFail('invalid-value', field, expected, describeValue(raw));
  }
  return parseOk(raw);
};
