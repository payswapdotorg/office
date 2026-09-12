// Office schedule domain — package-internal parse helpers (OFF-010).
//
// Fail-closed payload parsing for the domain's command payloads, mirroring
// the conventions of the sibling identity modules (total parsers returning
// ParseResult, strict keys, dotted error paths, short received-value
// descriptions). NOT exported from the package root: only the command
// modules of this package use these helpers; payload shapes are the
// package's own contract surface and are re-exported as typed values.
//
// Schedule-specific additions over the organization helpers: bounded
// INTEGER rules (durations, lags, percent complete — calendar-free working
// units, freeze A6/provider independence), the closed dependency link-type
// vocabulary (FS/SS/FF/SF), and a pure chronological timestamp comparison
// (planned/actual date sanity) — no host Date parsing, fully deterministic.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult, Timestamp } from '@office/contracts';

/** Narrow unknown to a plain JSON object (not null, not an array). */
export const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Short, safe description of an unknown value for error messages. */
export const describeValue = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  switch (typeof raw) {
    case 'string':
      return `string ${JSON.stringify(raw.length > 32 ? `${raw.slice(0, 32)}…` : raw)}`;
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

/** A string value rule: length bounds, optional grammar pattern, description. */
export interface StringRule {
  readonly min: number;
  readonly max: number;
  readonly pattern?: RegExp;
  readonly description: string;
}

/** An integer value rule: inclusive bounds and description. */
export interface IntegerRule {
  readonly min: number;
  readonly max: number;
  readonly description: string;
}

const describeStringRule = (rule: StringRule): string =>
  `${rule.description} (${rule.min}..${rule.max} characters)`;

const describeIntegerRule = (rule: IntegerRule): string =>
  `${rule.description} (integer ${rule.min}..${rule.max})`;

/** Path of `field` inside the value at `path` ('' = the root). */
export const fieldPath = (path: string, field: string): string =>
  path === '' ? field : `${path}.${field}`;

/** Join a path prefix and a relative sub-path into one dotted path. */
export const joinPath = (prefix: string, sub: string): string =>
  sub === '' ? prefix : `${prefix}.${sub}`;

/**
 * Repath a nested parse result: sub-parsers report paths relative to their
 * own root; composition prefixes the parent field name.
 */
export const nest = <T>(
  result: ParseResult<T>,
  path: string,
  field: string,
): ParseResult<T> => {
  if (result.ok) return result;
  return parseFail(
    result.error.code,
    joinPath(fieldPath(path, field), result.error.path),
    result.error.expected,
    result.error.received,
  );
};

/** First key of `raw` outside `allowed`, or null when the keys match exactly. */
export const firstUnknownKey = (
  raw: Record<string, unknown>,
  allowed: readonly string[],
): string | null => {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
};

/**
 * Fail-closed unknown-key check. Payload shapes are strict: a field the shape
 * does not know is an error, never silently dropped.
 */
export const unknownKeyFailure = (
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  grammar: string,
): ParseResult<never> | null => {
  const key = firstUnknownKey(raw, allowed);
  if (key === null) return null;
  return parseFail(
    'unknown-field',
    fieldPath(path, key),
    grammar,
    `unexpected key "${key}"`,
  );
};

/** Check a string value against a StringRule at `path`. */
const checkString = (
  value: unknown,
  rule: StringRule,
  path: string,
): ParseResult<string> => {
  const expected = describeStringRule(rule);
  if (typeof value !== 'string') {
    return parseFail('invalid-type', path, expected, describeValue(value));
  }
  if (value.length < rule.min || value.length > rule.max) {
    return parseFail('invalid-value', path, expected, `string of length ${value.length}`);
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    return parseFail('invalid-value', path, expected, describeValue(value));
  }
  return parseOk(value);
};

/** Parse a standalone string value against a StringRule. */
export const parseStringLike = (raw: unknown, rule: StringRule): ParseResult<string> =>
  checkString(raw, rule, '');

/** Check an integer value against an IntegerRule at `path`. */
const checkInteger = (
  value: unknown,
  rule: IntegerRule,
  path: string,
): ParseResult<number> => {
  const expected = describeIntegerRule(rule);
  if (typeof value !== 'number') {
    return parseFail('invalid-type', path, expected, describeValue(value));
  }
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
    return parseFail('invalid-value', path, expected, describeValue(value));
  }
  return parseOk(value);
};

/** Parse a standalone integer value against an IntegerRule. */
export const parseIntegerLike = (raw: unknown, rule: IntegerRule): ParseResult<number> =>
  checkInteger(raw, rule, '');

/** Require a string field of an object; fails closed on missing/type/grammar. */
export const requireString = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
  rule: StringRule,
): ParseResult<string> => {
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), describeStringRule(rule), 'undefined');
  }
  return checkString(value, rule, fieldPath(path, field));
};

/** Require an integer field of an object; fails closed on missing/type/range. */
export const requireInteger = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
  rule: IntegerRule,
): ParseResult<number> => {
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), describeIntegerRule(rule), 'undefined');
  }
  return checkInteger(value, rule, fieldPath(path, field));
};

/**
 * Require a field by delegating to its sub-parser. An absent field fails with
 * 'missing-field'; a present field is validated with error paths nested under
 * the field name.
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

/**
 * Parse an optional field: absent yields `undefined`; present delegates to the
 * sub-parser (fail-closed — an explicit null is NOT absent).
 */
export const optionalFieldWith = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | undefined> => {
  const value = raw[field];
  if (value === undefined) return parseOk(undefined);
  return nest(parseValue(value), path, field);
};

/**
 * Parse an optional-or-nullable field: absent or null yields null; any other
 * value delegates to the sub-parser. Used for optional planned/actual dates
 * and optional parent/bound activity references.
 */
export const optionalNullableFieldWith = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | null> => {
  const value = raw[field];
  if (value === undefined || value === null) return parseOk(null);
  return nest(parseValue(value), path, field);
};

/**
 * Parse a standalone JSON object value (extension metadata, freeze A2): must
 * be a plain JSON object — never null, never an array, never a scalar.
 */
export const parseJsonObject = (
  raw: unknown,
): ParseResult<Readonly<Record<string, unknown>>> =>
  isPlainObject(raw)
    ? parseOk(raw)
    : parseFail('invalid-type', '', 'a JSON object (extension metadata)', describeValue(raw));

/**
 * Parse one literal of the closed dependency link-type vocabulary
 * (FS = finish-to-start, SS = start-to-start, FF = finish-to-finish,
 * SF = start-to-finish). Total, fail-closed: any other value — including
 * lowercase or spelled-out variants — is rejected, so an undeclared link
 * semantics can never enter the model.
 */
export const parseDependencyLinkType = (raw: unknown): ParseResult<'FS' | 'SS' | 'FF' | 'SF'> => {
  const grammar = "dependency link type: one of 'FS', 'SS', 'FF', 'SF'";
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', grammar, describeValue(raw));
  }
  switch (raw) {
    case 'FS':
    case 'SS':
    case 'FF':
    case 'SF':
      return parseOk(raw);
    default:
      return parseFail('invalid-value', '', grammar, describeValue(raw));
  }
};

/**
 * Pure chronological comparison of two canonical Timestamps (RFC 3339 UTC
 * strings): returns a negative number when `a` is strictly earlier than `b`,
 * zero when they denote the same instant, positive when `a` is later.
 * Deterministic numeric component comparison — never host Date parsing, and
 * correct across differing fractional-digit widths (a naive lexicographic
 * string compare is NOT: '…00Z' sorts after '…00.5Z').
 */
export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  // Fixed-width prefix: YYYY-MM-DDTHH:mm:ss (canonical grammar guarantees it).
  const dateOf = (value: string): number[] => [
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)),
    Number(value.slice(8, 10)),
    Number(value.slice(11, 13)),
    Number(value.slice(14, 16)),
    Number(value.slice(17, 19)),
  ];
  const left = dateOf(a);
  const right = dateOf(b);
  for (const [index, part] of left.entries()) {
    const other = right[index] ?? 0;
    if (part !== other) return part - other;
  }
  // Same whole seconds: compare the fractional digits numerically (absent
  // fraction = .0 exactly).
  const fractionOf = (value: string): number => {
    const match = /^.{19}\.(\d{1,9})Z$/.exec(value);
    return match === null ? 0 : Number(`0.${match[1] ?? '0'}`);
  };
  return fractionOf(a) - fractionOf(b);
}
