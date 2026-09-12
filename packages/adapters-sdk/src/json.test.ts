import { describe, expect, it } from 'vitest';
import {
  ADAPTER_JSON_MAX_ARRAY_ITEMS,
  ADAPTER_JSON_MAX_DEPTH,
  ADAPTER_JSON_MAX_OBJECT_KEYS,
  ADAPTER_JSON_MAX_STRING_LENGTH,
  isAdapterJsonObject,
  isAdapterJsonValue,
  parseAdapterJsonObject,
  parseAdapterJsonValue,
} from './json';

// OFF-020 adapters-sdk — the provider payload JSON value model. The extension
// bag must be JSON-exact (JSONB-shaped, freeze A2): parsing is total and
// fail-closed — undefined, functions, symbols, bigints, non-finite numbers,
// non-plain objects (Date/Map/class instances), oversized strings/arrays/
// keys, and too-deep nesting are all typed rejections, never silent drops or
// coercions. Deterministic: pure functions over literal inputs.

const unwrapError = (result: ReturnType<typeof parseAdapterJsonValue>): {
  readonly code: string;
  readonly path: string;
} => {
  if (result.ok) throw new Error('expected a parse failure');
  return { code: result.error.code, path: result.error.path };
};

describe('adapter JSON value parsing (fail-closed)', () => {
  it('accepts every JSON-exact primitive, array, and object shape', () => {
    const value = {
      nothing: null,
      yes: true,
      no: false,
      count: 3,
      ratio: 0.5,
      name: 'Site logistics contact',
      tags: ['a', 'b', []],
      nested: { deeper: { deepest: null } },
      empty: {},
      emptyList: [],
    };
    const parsed = parseAdapterJsonValue(value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(value);
    expect(isAdapterJsonValue(value)).toBe(true);
  });

  it('rejects every non-JSON value with a typed failure', () => {
    for (const raw of [
      undefined,
      () => {},
      Symbol('sigil'),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date('2026-09-12T10:15:31.000Z'),
      new Map([['a', 1]]),
      new Set([1]),
      new (class Widget {
        public readonly field = 1;
      })(),
    ]) {
      const result = parseAdapterJsonValue(raw);
      expect(result.ok, `raw: ${String(raw)}`).toBe(false);
      if (!result.ok) {
        expect(['invalid-type', 'invalid-value']).toContain(result.error.code);
      }
      expect(isAdapterJsonValue(raw)).toBe(false);
    }
  });

  it('rejects oversized strings, arrays, and objects at the documented bounds', () => {
    const longString = 'a'.repeat(ADAPTER_JSON_MAX_STRING_LENGTH + 1);
    const bigArray = new Array(ADAPTER_JSON_MAX_ARRAY_ITEMS + 1).fill(0);
    const manyKeys: Record<string, number> = {};
    for (let index = 0; index <= ADAPTER_JSON_MAX_OBJECT_KEYS; index += 1) {
      manyKeys[`k${index}`] = index;
    }
    for (const raw of [longString, bigArray, manyKeys]) {
      const result = parseAdapterJsonValue(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-value');
    }
    // At the bounds themselves everything still parses.
    expect(parseAdapterJsonValue('a'.repeat(ADAPTER_JSON_MAX_STRING_LENGTH)).ok).toBe(true);
    expect(
      parseAdapterJsonValue(new Array(ADAPTER_JSON_MAX_ARRAY_ITEMS).fill(0)).ok,
    ).toBe(true);
  });

  it('enforces the nesting depth bound and reports nested paths', () => {
    const nest = (depth: number): unknown => {
      let value: unknown = {};
      for (let level = 0; level < depth; level += 1) value = { a: value };
      return value;
    };
    // A chain of 31 wrappers is a 32-level object tree — the maximum.
    expect(parseAdapterJsonValue(nest(ADAPTER_JSON_MAX_DEPTH - 1)).ok).toBe(true);
    // One more wrapper exceeds the depth bound.
    const tooDeep = parseAdapterJsonValue(nest(ADAPTER_JSON_MAX_DEPTH));
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) expect(tooDeep.error.code).toBe('invalid-value');

    // Nested failures report dotted/array paths relative to the parsed root.
    const badNested = parseAdapterJsonValue({ items: [{ name: 10n }] });
    expect(badNested.ok).toBe(false);
    if (!badNested.ok) {
      expect(badNested.error.path).toBe('items[0].name');
      expect(badNested.error.code).toBe('invalid-type');
    }
  });

  it('is a total function: every rejection carries the typed error contract', () => {
    const failure = unwrapError(parseAdapterJsonValue(undefined));
    expect(failure.code).toBe('invalid-type');
    const missing = parseAdapterJsonValue({ a: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('invalid-type');
      expect(missing.error.path).toBe('a');
    }
  });
});

describe('adapter JSON object parsing (the extension-bag shape)', () => {
  it('accepts a plain JSON object and round-trips it exactly', () => {
    const bag = { source: 'provider-field', nested: { list: [1, 'two', null] } };
    const parsed = parseAdapterJsonObject(bag);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(bag);
    expect(isAdapterJsonObject(bag)).toBe(true);
  });

  it('rejects everything that is not a JSON object (null, arrays, primitives)', () => {
    for (const raw of [null, [], 0, 'bag', true, undefined]) {
      const result = parseAdapterJsonObject(raw);
      expect(result.ok, `raw: ${String(raw)}`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-type');
      expect(isAdapterJsonObject(raw)).toBe(false);
    }
  });

  it('rejects objects whose values are not bounded JSON values', () => {
    const result = parseAdapterJsonObject({ when: new Date(0) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-type');
      expect(result.error.path).toBe('when');
    }
  });
});
