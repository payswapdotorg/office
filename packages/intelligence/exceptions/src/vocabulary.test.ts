import { describe, expect, it } from 'vitest';
import type { ParseResult } from '@office/contracts';
import {
  EXCEPTION_DETECTED_EVENT,
  EXCEPTION_ID_GRAMMAR,
  EXCEPTION_KINDS,
  EXCEPTION_KIND_GRAMMAR,
  EXCEPTION_REQUIRED_CAPABILITIES,
  EXCEPTION_REQUIRED_CAPABILITY_NAMES,
  SCAN_ID_GRAMMAR,
  SEVERITY_LEVELS,
  SEVERITY_LEVEL_GRAMMAR,
  isExceptionId,
  isExceptionKind,
  isScanId,
  isSeverityLevel,
  parseExceptionId,
  parseExceptionKind,
  parseScanId,
  parseSeverityLevel,
} from './vocabulary';

// OFF-019 vocabulary — the closed detection vocabulary, the typed severity
// scale, the exception-detected event name, and the scan/exception identity
// grammar. Every parser is total + fail-closed: an untrusted value either
// parses into the closed vocabulary or fails with a typed parse error
// carrying the grammar (never a coercion, never a guess).

const failuresOf = <T>(result: ParseResult<T>): string[] => {
  if (result.ok) return [];
  return [
    result.error.code,
    result.error.expected,
    String(result.error.received),
  ];
};

describe('the closed exception kind vocabulary (OFF-019)', () => {
  it('declares exactly the five actionable kinds, in canonical order', () => {
    expect(EXCEPTION_KINDS).toStrictEqual([
      'schedule-slip',
      'cost-overrun',
      'entitlement-exposure',
      'dependency-risk',
      'evidence-gap',
    ]);
  });

  it('parses every declared kind; rejects everything else fail-closed', () => {
    for (const kind of EXCEPTION_KINDS) {
      const parsed = parseExceptionKind(kind);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(kind);
      expect(isExceptionKind(kind)).toBe(true);
    }
    for (const raw of [
      'nonsense',
      'Schedule-Slip',
      'schedule_slip',
      '',
      'schedule-slip ',
      42,
      null,
      undefined,
      true,
      { kind: 'schedule-slip' },
      ['schedule-slip'],
    ]) {
      const parsed = parseExceptionKind(raw);
      expect(parsed.ok, `expected rejection: ${JSON.stringify(raw)}`).toBe(false);
      if (!parsed.ok) {
        // The typed failure names the grammar and the received token shape.
        expect(failuresOf(parsed)).toContain(EXCEPTION_KIND_GRAMMAR);
        expect(parsed.error.code).toBe('invalid-value');
      }
      expect(isExceptionKind(raw)).toBe(false);
    }
  });
});

describe('the typed severity scale (OFF-019)', () => {
  it('declares the four levels in canonical ascending order', () => {
    expect(SEVERITY_LEVELS).toStrictEqual(['minor', 'moderate', 'major', 'critical']);
  });

  it('parses every declared level; rejects everything else fail-closed', () => {
    for (const level of SEVERITY_LEVELS) {
      const parsed = parseSeverityLevel(level);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(level);
      expect(isSeverityLevel(level)).toBe(true);
    }
    for (const raw of ['catastrophic', 'MINOR', 'minor\n', 0, null, {}, ['major']]) {
      const parsed = parseSeverityLevel(raw);
      expect(parsed.ok, `expected rejection: ${JSON.stringify(raw)}`).toBe(false);
      if (!parsed.ok) {
        expect(failuresOf(parsed)).toContain(SEVERITY_LEVEL_GRAMMAR);
        expect(parsed.error.code).toBe('invalid-value');
      }
      expect(isSeverityLevel(raw)).toBe(false);
    }
  });
});

describe('the exception-detected event name (OFF-019)', () => {
  it('is the intelligence package family\'s exception event name', () => {
    expect(EXCEPTION_DETECTED_EVENT).toBe('intelligence.exceptionDetected');
  });
});

describe('the scan/exception identity grammar (OFF-019)', () => {
  it('accepts opaque printable-ASCII tokens of 8..128 characters', () => {
    for (const raw of ['scan-0001', 'exception#0042', 'x'.repeat(8), 'x'.repeat(128)]) {
      const scanId = parseScanId(raw);
      const exceptionId = parseExceptionId(raw);
      expect(scanId.ok, `scan id rejected: ${JSON.stringify(raw)}`).toBe(true);
      expect(exceptionId.ok, `exception id rejected: ${JSON.stringify(raw)}`).toBe(true);
      if (scanId.ok) expect(scanId.value).toBe(raw);
      if (exceptionId.ok) expect(exceptionId.value).toBe(raw);
      expect(isScanId(raw)).toBe(true);
      expect(isExceptionId(raw)).toBe(true);
    }
  });

  it('rejects short, long, whitespace, and non-string tokens fail-closed', () => {
    for (const raw of [
      'short',
      'x'.repeat(7),
      'x'.repeat(129),
      'scan 0001',
      'scan\t0001',
      'scan\n0001',
      ' scan-0001',
      'scan-0001 ',
      '',
      42,
      null,
      undefined,
    ]) {
      const scanId = parseScanId(raw);
      const exceptionId = parseExceptionId(raw);
      expect(scanId.ok, `scan id accepted: ${JSON.stringify(raw)}`).toBe(false);
      expect(exceptionId.ok, `exception id accepted: ${JSON.stringify(raw)}`).toBe(false);
      if (!scanId.ok) expect(failuresOf(scanId)).toContain(SCAN_ID_GRAMMAR);
      if (!exceptionId.ok) expect(failuresOf(exceptionId)).toContain(EXCEPTION_ID_GRAMMAR);
      expect(isScanId(raw)).toBe(false);
      expect(isExceptionId(raw)).toBe(false);
    }
  });
});

describe('the exception scan/read capabilities (OFF-019)', () => {
  it('requires the three area read capabilities, in canonical order', () => {
    expect(EXCEPTION_REQUIRED_CAPABILITY_NAMES).toStrictEqual([
      'contracts.read',
      'cost.read',
      'schedule.read',
    ]);
    expect(EXCEPTION_REQUIRED_CAPABILITIES).toHaveLength(3);
    for (const required of EXCEPTION_REQUIRED_CAPABILITIES) {
      expect(typeof required).toBe('string');
      expect(EXCEPTION_REQUIRED_CAPABILITY_NAMES).toContain(required);
    }
  });
});
