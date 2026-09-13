// Office workflow engine — package-internal parse helpers (OFF-016).
//
// Fail-closed payload parsing for the domain's command payloads and workflow
// model inputs, mirroring the conventions of @office/contracts' internal parse
// plumbing and the landed domain packages (total parsers returning
// ParseResult, strict keys, dotted error paths, short received-value
// descriptions). NOT exported from the package root: only the modules of this
// package use these helpers; payload shapes are the package's own contract
// surface and are re-exported as typed values.
//
// The workflow model needs (over the sibling helper set): closed
// literal-vocabulary parsing, bounded positive-integer parsing (SLA minutes,
// retry attempts, backoff parameters), and non-empty string-array parsing
// (assignment actor kinds / roles).
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';

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

const describeRule = (rule: StringRule): string =>
  `${rule.description} (${rule.min}..${rule.max} characters)`;

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
  const expected = describeRule(rule);
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

/** Require a string field of an object; fails closed on missing/type/grammar. */
export const requireString = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
  rule: StringRule,
): ParseResult<string> => {
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), describeRule(rule), 'undefined');
  }
  return checkString(value, rule, fieldPath(path, field));
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
 * value delegates to the sub-parser.
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
 * Require a field whose sub-parser takes the FIELD NAME and reports paths
 * that already include it (the list parsers below report 'tasks',
 * 'tasks[1]', ...): the missing-field probe mirrors requireFieldWith, but a
 * present value is NOT re-nested — the sub-parser's dotted paths are already
 * absolute, so composition must not prefix the field twice.
 */
export const requireSelfPathedField = <T>(
  raw: Record<string, unknown>,
  field: string,
  parseValue: (value: unknown, field: string) => ParseResult<T>,
): ParseResult<T> => {
  const value = raw[field];
  if (value === undefined) {
    const probe = parseValue(value, field);
    const expected = probe.ok ? 'a required field' : probe.error.expected;
    return parseFail('missing-field', field, expected, 'undefined');
  }
  return parseValue(value, field);
};

/**
 * Parse an optional field whose sub-parser takes the FIELD NAME and reports
 * paths that already include it (optional lists): absent yields `undefined`;
 * a present value is validated by the sub-parser without re-nesting.
 */
export const optionalSelfPathedField = <T>(
  raw: Record<string, unknown>,
  field: string,
  parseValue: (value: unknown, field: string) => ParseResult<T>,
): ParseResult<T | undefined> => {
  const value = raw[field];
  if (value === undefined) return parseOk(undefined);
  return parseValue(value, field);
};

/**
 * Parse a closed literal vocabulary (statuses, conditions, state kinds):
 * fail-closed against the exact allowed literals.
 */
export const parseLiteralOf = <T extends string>(
  vocabulary: readonly T[],
  description: string,
) => {
  return (raw: unknown): ParseResult<T> => {
    const expected = `one of: ${vocabulary.join(' | ')} (${description})`;
    if (typeof raw !== 'string') {
      return parseFail('invalid-type', '', expected, describeValue(raw));
    }
    if (!(vocabulary as readonly string[]).includes(raw)) {
      return parseFail('invalid-value', '', expected, describeValue(raw));
    }
    return parseOk(raw as T);
  };
};

/**
 * Parse a bounded positive integer (SLA minutes, retry attempts, backoff
 * seconds, definition versions): a JSON number, integral, within [min, max].
 */
export const parseBoundedInteger = (
  raw: unknown,
  min: number,
  max: number,
  description: string,
): ParseResult<number> => {
  const expected = `integer in ${min}..${max} (${description})`;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return parseFail('invalid-type', '', expected, describeValue(raw));
  }
  if (raw < min || raw > max) {
    return parseFail('invalid-value', '', expected, describeValue(raw));
  }
  return parseOk(raw);
};

/**
 * Parse an array of values through a sub-parser (fail-closed): a real array,
 * every element parsed; element failures report paths like '<field>[2]'.
 */
export const parseValueArrayWith = <T>(
  raw: unknown,
  field: string,
  parseValue: (value: unknown) => ParseResult<T>,
  elementDescription: string,
): ParseResult<readonly T[]> => {
  if (!Array.isArray(raw)) {
    return parseFail(
      'invalid-type',
      field,
      `array of ${elementDescription}`,
      describeValue(raw),
    );
  }
  const values: T[] = [];
  for (const [index, element] of raw.entries()) {
    const result = parseValue(element);
    if (!result.ok) {
      // Element paths follow the contracts convention: '<field>[2]' with no
      // separator dot between the field and the bracket (e.g. 'tasks[2]').
      return parseFail(
        result.error.code,
        `${field}[${index}]${result.error.path === '' ? '' : `.${result.error.path}`}`,
        result.error.expected,
        result.error.received,
      );
    }
    values.push(result.value);
  }
  return parseOk(values);
};
