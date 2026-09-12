// Office canonical contracts — parse plumbing (OFF-002).
//
// Every contract parse function is total: it returns a ParseResult, never
// throws, and never silently accepts an invalid or unknown shape. The typed
// ContractParseError is the fail-closed error surface required by the OFF-002
// acceptance gate ("unknown/unsupported schema versions fail closed").
//
// Parse paths are relative to the value being parsed: '' is the root, nested
// parsers report their own relative paths, and composition (nest/require*)
// prefixes them — e.g. an invalid tenant id inside an event scope reports
// 'scope.tenantId'.
//
// The public surface of this module (ParseResult, ContractParseError,
// parseOk, parseFail) is re-exported by src/index.ts. The helpers below the
// internal marker are exported for the other modules of this package only.
// This module imports nothing: the contracts package is the innermost
// shared kernel of the workspace.

/** Machine-readable reason why a contract parse failed. */
export type ContractParseErrorCode =
  /** The value is not the JSON kind the field requires. */
  | 'invalid-type'
  /** The value has the right kind but violates the field's grammar or range. */
  | 'invalid-value'
  /** A required field is absent. */
  | 'missing-field'
  /** A field unknown to the strict contract shape is present. */
  | 'unknown-field'
  /** A schema version is well-formed but not in KNOWN_SCHEMA_VERSIONS. */
  | 'unknown-schema-version'
  /** A canonical ID is well-formed but its ID format version is not known. */
  | 'unknown-id-version';

/** Typed, machine-readable description of a contract parse failure. */
export interface ContractParseError {
  readonly code: ContractParseErrorCode;
  /** Dotted path to the offending part, relative to the parsed root ('' = the root itself). */
  readonly path: string;
  /** Human-readable description of the accepted shape. */
  readonly expected: string;
  /** Short description of the value that was actually received. */
  readonly received: string;
}

/**
 * Result of a total contract parse: success carries the validated value;
 * failure carries a typed ContractParseError. Never a throw, never a silent
 * default.
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractParseError };

/** Build a successful ParseResult. */
export const parseOk = <const T>(value: T): ParseResult<T> => ({
  ok: true,
  value,
});

/** Build a failed ParseResult with a typed ContractParseError. */
export const parseFail = (
  code: ContractParseErrorCode,
  path: string,
  expected: string,
  received: string,
): ParseResult<never> => ({
  ok: false,
  error: { code, path, expected, received },
});

// ---------------------------------------------------------------------------
// Package-internal helpers. Exported for the other modules of this package
// only; deliberately NOT re-exported by src/index.ts.
// ---------------------------------------------------------------------------

/** A string value rule: length bounds, optional grammar pattern, description. */
export interface StringRule {
  readonly min: number;
  readonly max: number;
  readonly pattern?: RegExp;
  readonly description: string;
}

const describeRule = (rule: StringRule): string =>
  `${rule.description} (${rule.min}..${rule.max} characters)`;

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

/**
 * Fail-closed unknown-key check. Contract shapes are strict: a field the
 * shape does not know is an error, never silently dropped.
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
