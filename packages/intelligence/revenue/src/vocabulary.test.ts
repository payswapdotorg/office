import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_ID_GRAMMAR,
  RECOVERY_KINDS,
  RECOVERY_KIND_GRAMMAR,
  RECOVERY_REQUIRED_CAPABILITIES,
  RECOVERY_REQUIRED_CAPABILITY_NAMES,
  RECOVERY_SCAN_ID_GRAMMAR,
  SEVERITY_LEVELS,
  SEVERITY_LEVEL_GRAMMAR,
  isCandidateId,
  isRecoveryKind,
  isRecoveryScanId,
  isSeverityLevel,
  parseCandidateId,
  parseRecoveryKind,
  parseRecoveryScanId,
  parseSeverityLevel,
} from './vocabulary';

// OFF-033 vocabulary — the closed recovery-kind vocabulary, the typed
// severity scale, and the candidate/scan identity grammars are fail-closed
// total parsers: every untrusted value is either canonical or a typed
// failure naming the expected grammar.

describe('the recovery kind vocabulary (OFF-033)', () => {
  it('pins the closed vocabulary in canonical order', () => {
    expect(RECOVERY_KINDS).toStrictEqual([
      'constructive-change',
      'entitlement-rebalance',
      'delay-impact',
    ]);
  });

  it('parses every canonical kind and rejects everything else', () => {
    for (const kind of RECOVERY_KINDS) {
      expect(parseRecoveryKind(kind)).toStrictEqual({ ok: true, value: kind });
      expect(isRecoveryKind(kind)).toBe(true);
    }
    for (const raw of ['cost-overrun', 'schedule-slip', '', 7, null, undefined, {}]) {
      const parsed = parseRecoveryKind(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('invalid-value');
        expect(parsed.error.expected).toBe(RECOVERY_KIND_GRAMMAR);
      }
      expect(isRecoveryKind(raw)).toBe(false);
    }
  });
});

describe('the typed severity scale (OFF-033)', () => {
  it('pins the four-level scale in ascending order', () => {
    expect(SEVERITY_LEVELS).toStrictEqual(['minor', 'moderate', 'major', 'critical']);
  });

  it('parses every level and rejects everything else', () => {
    for (const level of SEVERITY_LEVELS) {
      expect(parseSeverityLevel(level)).toStrictEqual({ ok: true, value: level });
      expect(isSeverityLevel(level)).toBe(true);
    }
    for (const raw of ['catastrophic', 'MAJOR', 1, null]) {
      const parsed = parseSeverityLevel(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('invalid-value');
        expect(parsed.error.expected).toBe(SEVERITY_LEVEL_GRAMMAR);
      }
      expect(isSeverityLevel(raw)).toBe(false);
    }
  });
});

describe('the candidate/scan identity grammars (OFF-033)', () => {
  it('accepts opaque printable-ASCII tokens of 8..128 characters', () => {
    expect(isCandidateId('scan-0001#0001')).toBe(true);
    expect(isCandidateId('12345678')).toBe(true);
    expect(isRecoveryScanId('scan-0001')).toBe(true);
    expect(parseRecoveryScanId('scan-0002')).toStrictEqual({ ok: true, value: 'scan-0002' });
  });

  it('rejects short, long, whitespace, and non-string values fail-closed', () => {
    for (const raw of ['short', 'has space', `x`.repeat(129), 42, null, undefined]) {
      const candidate = parseCandidateId(raw);
      expect(candidate.ok).toBe(false);
      if (!candidate.ok) {
        expect(candidate.error.code).toBe('invalid-value');
        expect(candidate.error.expected).toBe(CANDIDATE_ID_GRAMMAR);
      }
      const scan = parseRecoveryScanId(raw);
      expect(scan.ok).toBe(false);
      if (!scan.ok) {
        expect(scan.error.expected).toBe(RECOVERY_SCAN_ID_GRAMMAR);
      }
    }
  });
});

describe('the recovery capability gate constants (OFF-033)', () => {
  it('requires the three area read capabilities, canonical order', () => {
    expect(RECOVERY_REQUIRED_CAPABILITY_NAMES).toStrictEqual([
      'contracts.read',
      'cost.read',
      'schedule.read',
    ]);
    expect([...RECOVERY_REQUIRED_CAPABILITIES]).toStrictEqual(
      RECOVERY_REQUIRED_CAPABILITY_NAMES,
    );
  });
});
