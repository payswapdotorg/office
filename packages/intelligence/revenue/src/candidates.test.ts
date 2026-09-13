import { describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import { parseAssessmentId } from '@office/intelligence-margin';
import { compareCandidates } from './candidates';
import type { CandidateRecovery } from './candidates';
import {
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CONTRACT_KIND,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  addRationals,
  canonicalRecoveryEvidence,
  compareRecoveryEvidence,
  compareReferencedRecords,
  minRationals,
  multiplyRationals,
  rationalCompare,
  recoveryRationalOf,
  reduceRecoveryRational,
  severityRankOf,
} from './model';
import type { RecoveryAssessmentSource, RecoveryEvidence } from './model';
import { DETECTED_AT, testId, testLedgerEventId, unwrap } from './test-support';
import { runGoldenRecoveryScan } from './scenarios';

// OFF-033 model — the local exact-rational arithmetic, the canonical
// evidence order, the referenced-record order, and the candidate
// comparator are pure deterministic contracts (fail-closed where they
// parse).

describe('the local exact-rational arithmetic (OFF-033)', () => {
  it('adds, multiplies, and reduces to lowest terms', () => {
    expect(addRationals({ numerator: 1, denominator: 2 }, { numerator: 1, denominator: 4 })).toStrictEqual(
      { numerator: 3, denominator: 4 },
    );
    expect(multiplyRationals({ numerator: 3, denominator: 4 }, { numerator: 1, denominator: 2 })).toStrictEqual(
      { numerator: 3, denominator: 8 },
    );
    expect(reduceRecoveryRational({ numerator: 6, denominator: 8 })).toStrictEqual({
      numerator: 3,
      denominator: 4,
    });
  });

  it('compares exactly and bounds at min', () => {
    expect(rationalCompare({ numerator: 1, denominator: 3 }, { numerator: 1, denominator: 2 })).toBe(-1);
    expect(rationalCompare({ numerator: 2, denominator: 4 }, { numerator: 1, denominator: 2 })).toBe(0);
    expect(rationalCompare({ numerator: 3, denominator: 4 }, { numerator: 1, denominator: 2 })).toBe(1);
    expect(minRationals(RATIONAL_ZERO, RATIONAL_ONE)).toStrictEqual(RATIONAL_ZERO);
  });

  it('builds rationals fail-closed (integers, positive denominator, 2^53-1 bound)', () => {
    expect(unwrap(recoveryRationalOf(3, 8))).toStrictEqual({ numerator: 3, denominator: 8 });
    expect(unwrap(recoveryRationalOf(-6, 8))).toStrictEqual({ numerator: -3, denominator: 4 });
    for (const parts of [
      [0.5, 2],
      [1, 0],
      [1, -2],
      [Number.MAX_SAFE_INTEGER + 1, 1],
    ] as const) {
      expect(recoveryRationalOf(parts[0], parts[1]).ok).toBe(false);
    }
  });

  it('ranks the typed severity scale as exact rationals', () => {
    expect(severityRankOf('minor')).toStrictEqual({ numerator: 1, denominator: 4 });
    expect(severityRankOf('moderate')).toStrictEqual({ numerator: 1, denominator: 2 });
    expect(severityRankOf('major')).toStrictEqual({ numerator: 3, denominator: 4 });
    expect(severityRankOf('critical')).toStrictEqual({ numerator: 1, denominator: 1 });
  });
});

describe('the canonical evidence order (OFF-033)', () => {
  const changeEventId = testId('chg', 1);
  const contractId = testId('con', 1);
  const assessmentEvidence: RecoveryAssessmentSource = {
    kind: 'assessment',
    assessmentId: unwrap(parseAssessmentId('assessment-0001')),
    assessedAt: DETECTED_AT,
    sourceEventId: testLedgerEventId(101),
    changeEventId,
    contractId,
  };
  const recordEvidence: RecoveryEvidence = {
    kind: 'record',
    ref: { entityKind: CHANGE_EVENT_KIND, entityId: changeEventId },
    recordKind: 'change-event',
    version: 1,
    createdAt: DETECTED_AT,
  };
  const orderRecordEvidence: RecoveryEvidence = {
    kind: 'record',
    ref: { entityKind: CHANGE_ORDER_KIND, entityId: testId('ord', 21) },
    recordKind: 'change-order',
    version: 2,
    createdAt: DETECTED_AT,
  };
  const contractRecordEvidence: RecoveryEvidence = {
    kind: 'record',
    ref: { entityKind: CONTRACT_KIND, entityId: contractId },
    recordKind: 'contract',
    version: 1,
    createdAt: DETECTED_AT,
  };

  it('orders the kind classes (assessment, benchmark, outcome, record, event) then identity', () => {
    const ordered = [
      recordEvidence,
      assessmentEvidence,
      contractRecordEvidence,
      orderRecordEvidence,
    ].sort(compareRecoveryEvidence);
    expect(ordered[0]).toStrictEqual(assessmentEvidence);
    expect(ordered.slice(1).map((evidence) => evidence.kind)).toStrictEqual([
      'record',
      'record',
      'record',
    ]);
    // Records order by (entityKind, entityId): change-event < change-order < contract.
    expect(
      [contractRecordEvidence, orderRecordEvidence, recordEvidence]
        .sort(compareRecoveryEvidence)
        .map((evidence) => (evidence.kind === 'record' ? evidence.recordKind : evidence.kind)),
    ).toStrictEqual(['change-event', 'change-order', 'contract']);
  });

  it('deduplicates references by their typed identity and orders canonically', () => {
    const canonical = canonicalRecoveryEvidence([
      recordEvidence,
      recordEvidence,
      contractRecordEvidence,
      assessmentEvidence,
    ]);
    expect(canonical).toStrictEqual([assessmentEvidence, recordEvidence, contractRecordEvidence]);
  });
});

describe('the referenced-record + candidate comparators (OFF-033)', () => {
  it('orders referenced records by (entityKind, entityId)', () => {
    const refs: readonly EntityRef[] = [
      { entityKind: CONTRACT_KIND, entityId: testId('con', 1) },
      { entityKind: CHANGE_EVENT_KIND, entityId: testId('chg', 1) },
    ];
    const ordered = [...refs].sort(compareReferencedRecords);
    expect(ordered.map((ref) => ref.entityKind)).toStrictEqual(['change-event', 'contract']);
    expect(compareReferencedRecords(refs[0] as EntityRef, refs[0] as EntityRef)).toBe(0);
  });

  it('orders candidates by the kind vocabulary order then candidate id (golden set)', () => {
    const run = runGoldenRecoveryScan();
    const candidateAt = (index: number): CandidateRecovery => {
      const candidate = run.candidates[index];
      if (candidate === undefined) {
        throw new Error(`golden scan must expose candidate ${index}`);
      }
      return candidate;
    };
    const constructive = candidateAt(0);
    const rebalance = candidateAt(1);
    const delay = candidateAt(2);
    // Vocabulary order: constructive-change < entitlement-rebalance < delay-impact.
    // The comparator is a sort comparator (sign-based, mirroring the
    // exceptions engine's compareExceptions): the sign carries the order.
    expect(Math.sign(compareCandidates(constructive, rebalance))).toBe(-1);
    expect(Math.sign(compareCandidates(rebalance, delay))).toBe(-1);
    expect(Math.sign(compareCandidates(delay, constructive))).toBe(1);
    expect(compareCandidates(constructive, constructive)).toBe(0);
    // The identity tie-breaker: same kind, ordered by candidate id.
    expect(constructive.candidateId < rebalance.candidateId).toBe(true);
  });
});
