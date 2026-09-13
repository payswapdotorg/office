// Office app-runtime — package-internal parse plumbing (OFF-026).
//
// Total, fail-closed parse combinators for the app-runtime package's own
// value types, built on the PUBLIC contracts parse plumbing (ParseResult,
// parseOk, parseFail — the same typed ContractParseError surface every
// Office boundary uses). Mirrors the internal helper layers of the
// contracts, authz, actions, and app-sdk packages: those helpers are
// deliberately package-internal THERE, so this module repeats the small
// combinator set for the app runtime.
//
// Exported for the other modules of this package only; deliberately NOT
// re-exported by src/index.ts.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';

/** A string value rule: length bounds, optional grammar pattern, description. */
export interface StringRule {
  readonly min: number;
  readonly max: number;
  readonly pattern?: RegExp;
  readonly description: string;
}

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

/**
 * Join a path prefix and a relative sub-path into one dotted path.
 * Array-index sub-paths ('[0]', '[0].capability') attach WITHOUT a dot so a
 * nested element failure reads `hooks[0].hook`, never `hooks.[0].hook`.
 */
export const joinPath = (prefix: string, sub: string): string => {
  if (sub === '') return prefix;
  if (sub.startsWith('[')) return `${prefix}${sub}`;
  return `${prefix}.${sub}`;
};

/** Path of `field` inside the value at `parentPath` ('' = root). */
export const fieldPath = (parentPath: string, field: string): string =>
  parentPath === '' ? field : `${parentPath}.${field}`;

/**
 * Repath a nested parse result: sub-parsers report paths relative to their
 * own root; composition prefixes the parent field name.
 */
export const nest = <T>(
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
export const firstUnknownKey = (
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

/** Describe a string rule the way parse failures quote it. */
const describeRule = (rule: StringRule): string =>
  `${rule.description} (${rule.min}..${rule.max} characters)`;

/** Check a string value against a StringRule at `path`. */
export const checkString = (
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

/** Parse a standalone (top-level) string value against a StringRule. */
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

/** Parse a nullable OPTIONAL field: absent or null → null; else the sub-parser. */
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
 * Parse an array field whose elements are validated by `parseValue`, in
 * order. Element failures report paths like '<field>[3]' plus the element's
 * OWN internal path when it has one ('<field>[3].hook'). Duplicates are NOT
 * rejected here (value identity cannot see structural duplicates) — set-like
 * semantics are the caller's rule, keyed by its own logical key.
 */
export const parseArrayWith = <T>(
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
      const elementPath =
        parsed.error.path === ''
          ? `${field}[${index}]`
          : `${field}[${index}].${parsed.error.path}`;
      return parseFail(
        parsed.error.code,
        elementPath,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    values.push(parsed.value);
  }
  return parseOk(values);
};
