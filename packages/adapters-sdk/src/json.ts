// Office adapters-sdk — provider payload JSON values (OFF-020).
//
// AdapterJsonValue is the JSON value model carried by provider snapshots
// (the extension bag) and webhook bodies: the shape provider payloads are
// normalized into before anything else in the SDK touches them. The model is
// deliberately JSON-exact — null/boolean/finite number/string/array/object
// with bounded depth and size — because these values land in JSONB columns
// (freeze A2) and must survive a serialization round trip without surprise.
//
// The extension bag is the ONE open-keyed surface in this package (it is the
// provider's own namespace, by design); everything else in the adapters SDK
// is strict-keyed. Parsing is total and fail-closed: undefined, functions,
// symbols, NaN/Infinity, oversized nesting, and non-plain objects are all
// typed rejections, never silent drops.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { describeValue, fieldPath, isPlainObject } from './parse';

/**
 * A JSON-plain object: `Object.prototype` (or null) prototype, not an array.
 * Class instances (Date, Map, Set, …) have their own prototypes and are NOT
 * JSON — the extension bag must reject them instead of silently coercing
 * them to their (often empty) enumerable own keys.
 */
const isJsonPlainObject = (raw: unknown): raw is Record<string, unknown> => {
  if (!isPlainObject(raw)) return false;
  const prototype = Object.getPrototypeOf(raw);
  return prototype === Object.prototype || prototype === null;
};

/** JSON primitive as carried in provider payloads. */
export type AdapterJsonPrimitive = null | boolean | number | string;

/** A JSON value: primitive, array of values, or object of values. */
export type AdapterJsonValue =
  | AdapterJsonPrimitive
  | readonly AdapterJsonValue[]
  | { readonly [key: string]: AdapterJsonValue };

/** A JSON object: the open-keyed extension bag shape (JSONB-shaped). */
export type AdapterJsonObject = { readonly [key: string]: AdapterJsonValue };

/** Maximum nesting depth of a provider payload value. */
export const ADAPTER_JSON_MAX_DEPTH = 32;

/** Maximum length of one string inside a provider payload. */
export const ADAPTER_JSON_MAX_STRING_LENGTH = 65_536;

/** Maximum keys per object inside a provider payload. */
export const ADAPTER_JSON_MAX_OBJECT_KEYS = 4_096;

/** Maximum items per array inside a provider payload. */
export const ADAPTER_JSON_MAX_ARRAY_ITEMS = 65_536;

/** Grammar description used in parse failures. */
export const ADAPTER_JSON_GRAMMAR = `a JSON value (null, boolean, finite number, string of <= ${ADAPTER_JSON_MAX_STRING_LENGTH} characters, array of <= ${ADAPTER_JSON_MAX_ARRAY_ITEMS} items, or object of <= ${ADAPTER_JSON_MAX_OBJECT_KEYS} keys; nesting depth <= ${ADAPTER_JSON_MAX_DEPTH})`;

const parseValue = (raw: unknown, path: string, depth: number): ParseResult<AdapterJsonValue> => {
  if (raw === null) return parseOk(null);
  switch (typeof raw) {
    case 'boolean':
      return parseOk(raw);
    case 'number':
      if (!Number.isFinite(raw)) {
        return parseFail('invalid-value', path, 'a finite JSON number', describeValue(raw));
      }
      return parseOk(raw);
    case 'string':
      if (raw.length > ADAPTER_JSON_MAX_STRING_LENGTH) {
        return parseFail(
          'invalid-value',
          path,
          `a string of <= ${ADAPTER_JSON_MAX_STRING_LENGTH} characters`,
          `string of length ${raw.length}`,
        );
      }
      return parseOk(raw);
    case 'object': {
      if (depth >= ADAPTER_JSON_MAX_DEPTH) {
        return parseFail(
          'invalid-value',
          path,
          `nesting depth <= ${ADAPTER_JSON_MAX_DEPTH}`,
          'value nested too deeply',
        );
      }
      if (Array.isArray(raw)) {
        if (raw.length > ADAPTER_JSON_MAX_ARRAY_ITEMS) {
          return parseFail(
            'invalid-value',
            path,
            `an array of <= ${ADAPTER_JSON_MAX_ARRAY_ITEMS} items`,
            `array of length ${raw.length}`,
          );
        }
        const items: AdapterJsonValue[] = [];
        for (const [index, item] of raw.entries()) {
          const parsed = parseValue(item, `${path}[${index}]`, depth + 1);
          if (!parsed.ok) return parsed;
          items.push(parsed.value);
        }
        return parseOk(items);
      }
      if (!isJsonPlainObject(raw)) {
        // A class instance, Date, Map, … is not JSON — rejected, not coerced.
        return parseFail('invalid-type', path, ADAPTER_JSON_GRAMMAR, describeValue(raw));
      }
      const keys = Object.keys(raw);
      if (keys.length > ADAPTER_JSON_MAX_OBJECT_KEYS) {
        return parseFail(
          'invalid-value',
          path,
          `an object of <= ${ADAPTER_JSON_MAX_OBJECT_KEYS} keys`,
          `object with ${keys.length} keys`,
        );
      }
      const record: Record<string, AdapterJsonValue> = {};
      for (const key of keys) {
        const nestedPath = path === '' ? key : fieldPath(path, key);
        const parsed = parseValue(raw[key], nestedPath, depth + 1);
        if (!parsed.ok) return parsed;
        record[key] = parsed.value;
      }
      return parseOk(record);
    }
    default:
      // undefined, function, symbol, bigint — not JSON.
      return parseFail('invalid-type', path, ADAPTER_JSON_GRAMMAR, describeValue(raw));
  }
};

/**
 * Parse an untrusted value as an AdapterJsonValue (total, fail-closed,
 * depth- and size-bounded). Paths are relative to the parsed root: nested
 * failures report 'data[2].name' style locations.
 */
export function parseAdapterJsonValue(raw: unknown, path = ''): ParseResult<AdapterJsonValue> {
  return parseValue(raw, path, 0);
}

/**
 * Parse an untrusted value as an AdapterJsonObject (total, fail-closed): a
 * plain JSON object, every value a bounded AdapterJsonValue. This is the
 * extension-bag / webhook-data parser.
 */
export function parseAdapterJsonObject(
  raw: unknown,
  field = '',
): ParseResult<AdapterJsonObject> {
  const parsed = parseAdapterJsonValue(raw, field);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return parseFail(
      'invalid-type',
      field,
      'a JSON object (the provider extension bag)',
      describeValue(raw),
    );
  }
  // Narrowed to the object member of the AdapterJsonValue union.
  return parseOk(value as AdapterJsonObject);
}

/** Type guard for structurally valid AdapterJsonValue values. */
export function isAdapterJsonValue(raw: unknown): raw is AdapterJsonValue {
  return parseAdapterJsonValue(raw).ok;
}

/** Type guard for structurally valid AdapterJsonObject values. */
export function isAdapterJsonObject(raw: unknown): raw is AdapterJsonObject {
  return parseAdapterJsonObject(raw).ok;
}
