// Office adapter-construction — package-internal parse plumbing (OFF-021).
//
// Total, fail-closed parse combinators for this package's own value types,
// built on the PUBLIC contracts parse plumbing (ParseResult, parseOk,
// parseFail — the same typed ContractParseError surface every Office boundary
// uses). The adapters-sdk deliberately does NOT re-export its internal parse
// module through its public surface, so this package repeats the small
// combinator set (mirroring the adapters-sdk's internal conventions exactly:
// 'missing-field'/'unknown-field' codes, field paths nested under the parent
// field name) plus the two combinators the provider-data shapes need beyond
// that set (bounded numbers, homogeneous arrays).
//
// Exported for the other modules of this package only; deliberately NOT
// re-exported by src/index.ts.
import { parseFail, parseOk } from '@office/contracts';
import type { ContractParseError, ParseResult } from '@office/contracts';

/** The failing variant of ParseResult (what fail-closed checks return). */
export interface ParseFailure {
  readonly ok: false;
  readonly error: ContractParseError;
}

/** A string value rule: length bounds, optional grammar pattern, description. */
export interface StringRule {
  readonly min: number;
  readonly max: number;
  readonly pattern?: RegExp;
  readonly description: string;
}

/** A bounded numeric value rule. */
export interface NumberRule {
  readonly min: number;
  readonly max: number;
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

/** Join a path prefix and a relative sub-path into one dotted path. */
export const joinPath = (prefix: string, sub: string): string =>
  sub === '' ? prefix : `${prefix}.${sub}`;

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
): ParseFailure | null => {
  const key = firstUnknownKey(raw, allowed);
  if (key === null) return null;
  return {
    ok: false,
    error: {
      code: 'unknown-field',
      path: fieldPath(path, key),
      expected: grammar,
      received: `unexpected key "${key}"`,
    },
  };
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
export const requireLiteral = <T extends string>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  allowed: readonly T[],
): ParseResult<T> => {
  const expected = allowed.map((value) => `'${value}'`).join(' | ');
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), expected, 'undefined');
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return parseFail('invalid-value', fieldPath(path, field), expected, describeValue(value));
  }
  return parseOk(value as T);
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

/** Parse an OPTIONAL field: absent → undefined; present → the sub-parser runs. */
export const optionalField = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | undefined> => {
  const value = raw[field];
  if (value === undefined) return parseOk(undefined);
  return nest(parseValue(value), path, field);
};

/** Check a number value against a NumberRule at `path` (finite, bounded). */
export const checkNumber = (value: unknown, rule: NumberRule, path: string): ParseResult<number> => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return parseFail('invalid-type', path, rule.description, describeValue(value));
  }
  if (value < rule.min || value > rule.max) {
    return parseFail('invalid-value', path, rule.description, `number ${String(value)}`);
  }
  return parseOk(value);
};

/** Require a bounded numeric field of an object (no coercion, no NaN/Inf). */
export const requireNumberField = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
  rule: NumberRule,
): ParseResult<number> => {
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), rule.description, 'undefined');
  }
  return checkNumber(value, rule, fieldPath(path, field));
};

/**
 * Require an array field whose elements are validated by `parseValue`, in
 * order, with error paths nested like '<field>[3]'. An empty array is valid
 * (emptiness semantics belong to the caller's shape rule).
 */
export const requireArrayField = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
  expected: string,
): ParseResult<readonly T[]> => {
  const value = raw[field];
  const arrayPath = fieldPath(path, field);
  if (value === undefined) {
    return parseFail('missing-field', arrayPath, expected, 'undefined');
  }
  if (!Array.isArray(value)) {
    return parseFail('invalid-type', arrayPath, expected, describeValue(value));
  }
  const values: T[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseValue(item);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        parsed.error.path === ''
          ? `${arrayPath}[${index}]`
          : `${arrayPath}[${index}].${parsed.error.path}`,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    values.push(parsed.value);
  }
  return parseOk(values);
};

/** Require a plain-object field (nested object shapes). */
export const requireRecordField = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
): ParseResult<Record<string, unknown>> => {
  const value = raw[field];
  const recordPath = fieldPath(path, field);
  if (value === undefined) {
    return parseFail('missing-field', recordPath, 'an object', 'undefined');
  }
  if (!isPlainObject(value)) {
    return parseFail('invalid-type', recordPath, 'an object', describeValue(value));
  }
  return parseOk(value);
};
