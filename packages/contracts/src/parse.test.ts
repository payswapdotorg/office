import { describe, expect, it } from 'vitest';
import { parseFail, parseOk } from './index';

// OFF-002 contracts — parse plumbing tests. Deterministic: no clock, no
// network, no randomness.

describe('parse plumbing (ParseResult)', () => {
  it('builds success results', () => {
    expect(parseOk(42)).toStrictEqual({ ok: true, value: 42 });
    expect(parseOk('value')).toStrictEqual({ ok: true, value: 'value' });
    expect(parseOk(null)).toStrictEqual({ ok: true, value: null });
  });

  it('infers literal types via const type parameters', () => {
    const result = parseOk('1.0.0');
    if (!result.ok) {
      throw new Error('unexpected failure');
    }
    const literal: '1.0.0' = result.value;
    expect(literal).toBe('1.0.0');
  });

  it('builds typed failure results', () => {
    const result = parseFail(
      'unknown-schema-version',
      'schemaVersion',
      'one of: 1.0.0',
      'string "9.9.9"',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toStrictEqual({
        code: 'unknown-schema-version',
        path: 'schemaVersion',
        expected: 'one of: 1.0.0',
        received: 'string "9.9.9"',
      });
    }
  });
});
