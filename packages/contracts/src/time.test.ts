import { describe, expect, it } from 'vitest';
import { formatTimestamp, isTimestamp, parseTimestamp } from './index';
import type { ParseResult } from './index';

// OFF-002 contracts — time tests. Deterministic: fixed instants, no clock.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

describe('timestamps (time)', () => {
  it('round-trips a canonical millisecond instant', () => {
    const value = '2026-09-12T10:15:30.000Z';
    expect(unwrap(parseTimestamp(value))).toBe(value);
  });

  it('accepts 1..9 fractional digits and returns strings verbatim', () => {
    expect(unwrap(parseTimestamp('2026-09-12T10:15:30Z'))).toBe('2026-09-12T10:15:30Z');
    expect(unwrap(parseTimestamp('2026-09-12T10:15:30.5Z'))).toBe('2026-09-12T10:15:30.5Z');
    expect(unwrap(parseTimestamp('2026-09-12T10:15:30.123456789Z'))).toBe(
      '2026-09-12T10:15:30.123456789Z',
    );
  });

  it('accepts real leap days and rejects non-leap ones', () => {
    expect(isTimestamp('2024-02-29T00:00:00Z')).toBe(true);
    expect(isTimestamp('2000-02-29T00:00:00Z')).toBe(true); // divisible by 400: leap
    expect(isTimestamp('1900-02-29T00:00:00Z')).toBe(false); // divisible by 100 only
    expect(isTimestamp('2026-02-29T00:00:00Z')).toBe(false);
  });

  it('rejects calendar-invalid and non-UTC instants', () => {
    const invalid = [
      '2026-13-01T00:00:00Z',
      '2026-00-01T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-09-31T00:00:00Z',
      '2026-09-12T24:00:00Z',
      '2026-09-12T10:60:00Z',
      '2026-09-12T10:15:60Z',
      '2026-09-12 10:15:30Z',
      '2026-09-12T10:15:30+00:00',
      '2026-09-12T10:15:30',
      '2026-09-12',
      '0000-01-01T00:00:00Z',
      '2026-09-12T10:15:30.Z',
      42,
      null,
    ];
    for (const candidate of invalid) {
      expect(parseTimestamp(candidate).ok, `candidate: ${String(candidate)}`).toBe(false);
    }
  });

  it('type-guards timestamp values', () => {
    expect(isTimestamp('2026-09-12T10:15:30.000Z')).toBe(true);
    expect(isTimestamp('yesterday')).toBe(false);
    expect(isTimestamp(12345)).toBe(false);
  });

  it('formats Dates into canonical UTC millisecond instants', () => {
    expect(formatTimestamp(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(formatTimestamp(new Date('2026-09-12T10:15:30.123Z'))).toBe(
      '2026-09-12T10:15:30.123Z',
    );
  });

  it('format throws for invalid dates (loud, never silent)', () => {
    expect(() => formatTimestamp(new Date(Number.NaN))).toThrow(TypeError);
  });
});
