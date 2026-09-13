import { describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import type { Rational } from '@office/intelligence-memory';
import {
  DEFAULT_PRIORITY_WEIGHTS,
  EXCEPTIONS_ENGINE,
  EXCEPTION_SCHEMA_VERSION,
  PRIORITY_FORMULA,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  addRationals,
  canonicalExceptionEvidence,
  compareAffectedEntities,
  compareExceptionEvidence,
  compareExceptions,
  exceptionRationalOf,
  minRationals,
  multiplyRationals,
  rationalCompare,
  reduceExceptionRational,
  severityRankOf,
} from './model';
import type {
  Exception,
  ExceptionAssessmentSource,
  ExceptionBenchmarkSource,
  ExceptionEventSource,
} from './model';
import type { ExceptionId, ScanId, SeverityLevel } from './vocabulary';

// OFF-019 model — the exact-rational arithmetic the exposed score
// composition computes over, the evidence-chain canonical order, the
// exception comparator, and the seeded priority weights. Everything here is
// pure typed computation: no floats anywhere (rationalCompare cross-
// multiplies through BigInt, so 1/3 and 333333/1000000 compare EXACTLY).

const rational = (numerator: number, denominator: number): Rational => ({
  numerator,
  denominator,
});

describe('exact-rational arithmetic (OFF-019)', () => {
  it('adds with reduction to lowest terms', () => {
    expect(addRationals(rational(1, 2), rational(1, 4))).toStrictEqual(rational(3, 4));
    expect(addRationals(rational(1, 2), rational(1, 2))).toStrictEqual(rational(1, 1));
    expect(addRationals(RATIONAL_ZERO, rational(3, 9))).toStrictEqual(rational(1, 3));
    expect(addRationals(rational(1, 6), rational(1, 3))).toStrictEqual(rational(1, 2));
    // The default score composition: 1/2 + 3/20 = 13/20.
    expect(addRationals(rational(1, 2), rational(3, 20))).toStrictEqual(rational(13, 20));
  });

  it('multiplies with reduction to lowest terms', () => {
    expect(multiplyRationals(rational(1, 2), rational(1, 2))).toStrictEqual(rational(1, 4));
    expect(multiplyRationals(rational(2, 4), rational(1, 2))).toStrictEqual(rational(1, 4));
    expect(multiplyRationals(RATIONAL_ONE, rational(3, 10))).toStrictEqual(rational(3, 10));
    expect(multiplyRationals(RATIONAL_ZERO, rational(9, 7))).toStrictEqual(RATIONAL_ZERO);
    expect(multiplyRationals(rational(1, 2), rational(3, 10))).toStrictEqual(rational(3, 20));
  });

  it('compares exactly through BigInt cross-multiplication (no float traps)', () => {
    expect(rationalCompare(rational(1, 3), rational(1, 3))).toBe(0);
    expect(rationalCompare(rational(1, 3), rational(2, 3))).toBe(-1);
    expect(rationalCompare(rational(2, 3), rational(1, 3))).toBe(1);
    // 1/3 vs 333333/1000000: floats call these equal; the exact comparison
    // does not (1 * 1000000 > 333333 * 3).
    expect(rationalCompare(rational(1, 3), rational(333333, 1000000))).toBe(1);
    expect(rationalCompare(rational(1, 3), rational(333334, 1000000))).toBe(-1);
    // Unreduced forms compare by VALUE, not by representation.
    expect(rationalCompare(rational(1, 2), rational(2, 4))).toBe(0);
    expect(rationalCompare(rational(-3, 8), RATIONAL_ZERO)).toBe(-1);
  });

  it('takes the exact minimum', () => {
    expect(minRationals(rational(1, 4), RATIONAL_ONE)).toStrictEqual(rational(1, 4));
    expect(minRationals(RATIONAL_ONE, rational(1, 4))).toStrictEqual(rational(1, 4));
    expect(minRationals(RATIONAL_ONE, rational(2, 2))).toStrictEqual(RATIONAL_ONE);
  });

  it('reduces to lowest terms with the sign in the numerator', () => {
    expect(reduceExceptionRational(rational(2, 4))).toStrictEqual(rational(1, 2));
    expect(reduceExceptionRational(rational(-6, 8))).toStrictEqual(rational(-3, 4));
    expect(reduceExceptionRational(rational(0, 7))).toStrictEqual(RATIONAL_ZERO);
    expect(reduceExceptionRational(rational(13, 13))).toStrictEqual(RATIONAL_ONE);
  });

  it('builds rationals fail-closed on the domain bounds', () => {
    expect(exceptionRationalOf(3, 10)).toStrictEqual({
      ok: true,
      value: rational(3, 10),
    } as const);
    expect(exceptionRationalOf(-3, 8)).toStrictEqual({
      ok: true,
      value: rational(-3, 8),
    } as const);
    expect(exceptionRationalOf(6, 4)).toStrictEqual({
      ok: true,
      value: rational(3, 2),
    } as const);
    for (const [numerator, denominator] of [
      [1, 0],
      [1, -2],
      [0.5, 2],
      [1, 1.5],
      [9007199254740992, 1],
      [1, 9007199254740992],
    ] as const) {
      const built = exceptionRationalOf(numerator, denominator);
      expect(built.ok, `expected rejection: ${numerator}/${denominator}`).toBe(false);
      if (!built.ok) {
        expect(built.error.code).toBe('invalid-value');
        expect(built.error.expected).toContain('rational');
      }
    }
  });
});

describe('the evidence-chain canonical order (OFF-019)', () => {
  const assessment = (assessmentId: string): ExceptionAssessmentSource => ({
    kind: 'assessment',
    assessmentId: assessmentId as ExceptionAssessmentSource['assessmentId'],
    assessedAt: '2026-09-18T09:00:00.000Z' as ExceptionAssessmentSource['assessedAt'],
    sourceEventId: 'evt-000000000001' as ExceptionAssessmentSource['sourceEventId'],
    changeEventId: 'chg-000000000001' as ExceptionAssessmentSource['changeEventId'],
    contractId: 'con-000000000001' as ExceptionAssessmentSource['contractId'],
  });
  const benchmark = (benchmarkId: string): ExceptionBenchmarkSource => ({
    kind: 'benchmark',
    benchmarkId: benchmarkId as ExceptionBenchmarkSource['benchmarkId'],
    computedAt: '2026-09-21T09:00:00.000Z' as ExceptionBenchmarkSource['computedAt'],
    metricKind: 'schedule-variance-days' as ExceptionBenchmarkSource['metricKind'],
  });
  const event = (eventId: string): ExceptionEventSource => ({
    kind: 'event',
    eventId: eventId as ExceptionEventSource['eventId'],
    eventName: 'contracts.changeEventRaised' as ExceptionEventSource['eventName'],
    occurredAt: '2026-09-14T11:45:00.000Z' as ExceptionEventSource['occurredAt'],
  });

  it('orders assessments, then benchmarks, then events — by id within a kind', () => {
    const references = [event('e2'), benchmark('b1'), assessment('a2'), event('e1'), assessment('a1')];
    expect([...references].sort(compareExceptionEvidence)).toStrictEqual([
      assessment('a1'),
      assessment('a2'),
      benchmark('b1'),
      event('e1'),
      event('e2'),
    ]);
  });

  it('deduplicates by source id and returns the canonical order', () => {
    const references = [
      event('e1'),
      assessment('a1'),
      event('e1'),
      assessment('a1'),
      benchmark('b1'),
      assessment('a2'),
    ];
    expect(canonicalExceptionEvidence(references)).toStrictEqual([
      assessment('a1'),
      assessment('a2'),
      benchmark('b1'),
      event('e1'),
    ]);
  });
});

describe('the exception comparator (OFF-019)', () => {
  const exceptionOf = (kind: Exception['kind'], exceptionId: string): Exception =>
    ({
      exceptionId: exceptionId as ExceptionId,
      exceptionVersion: EXCEPTION_SCHEMA_VERSION,
      engine: EXCEPTIONS_ENGINE,
      detectedAt: '2026-09-19T09:00:00.000Z' as Exception['detectedAt'],
      actor: { kind: 'user', actorId: 'usr-000000000001' } as Exception['actor'],
      scope: { kind: 'tenant', tenantId: 'tnt-000000000001' } as Exception['scope'],
      kind,
      title: `title ${exceptionId}`,
      affected: [],
      severity: { level: 'minor' as SeverityLevel, reasons: [] },
      economicImpact: { amountMinor: null, currency: null, assessmentIds: [] },
      evidence: [],
      provenance: {
        scanId: 'scan-0001' as ScanId,
        detectedAt: '2026-09-19T09:00:00.000Z' as Exception['detectedAt'],
        consumed: { assessmentCount: 0, subgraphCount: 0, benchmarkCount: 0 },
        calibrationBenchmarkIds: [],
      },
      primarySource: {
        eventId: 'evt-000000000001' as Exception['primarySource']['eventId'],
        eventName: 'contracts.changeEventRaised' as Exception['primarySource']['eventName'],
        occurredAt: '2026-09-14T11:45:00.000Z' as Exception['primarySource']['occurredAt'],
        correlationId: 'corr-00000001',
      },
    }) as Exception;

  it('orders by kind first, then exception id (the emission order)', () => {
    const exceptions = [
      exceptionOf('evidence-gap', 'scan-0001#0005'),
      exceptionOf('schedule-slip', 'scan-0001#0001'),
      exceptionOf('cost-overrun', 'scan-0001#0002'),
      exceptionOf('dependency-risk', 'scan-0001#0004'),
      exceptionOf('entitlement-exposure', 'scan-0001#0003'),
    ];
    expect([...exceptions].sort(compareExceptions)).toStrictEqual([
      exceptionOf('schedule-slip', 'scan-0001#0001'),
      exceptionOf('cost-overrun', 'scan-0001#0002'),
      exceptionOf('entitlement-exposure', 'scan-0001#0003'),
      exceptionOf('dependency-risk', 'scan-0001#0004'),
      exceptionOf('evidence-gap', 'scan-0001#0005'),
    ]);
  });

  it('orders affected entities by kind, then id (the relationships idiom)', () => {
    const ref = (entityKind: string, entityId: string): EntityRef =>
      ({ entityKind, entityId }) as EntityRef;
    const refs = [ref('activity', 'a2'), ref('change-event', 'c1'), ref('activity', 'a1')];
    expect([...refs].sort(compareAffectedEntities)).toStrictEqual([
      ref('activity', 'a1'),
      ref('activity', 'a2'),
      ref('change-event', 'c1'),
    ]);
  });
});

describe('the seeded priority weights (OFF-019)', () => {
  it('exposes the formula, the schema version, and the engine identity', () => {
    expect(PRIORITY_FORMULA).toBe(
      'priority = severityWeight x severityRank(level) + economicWeight x min(1, economicImpact / economicScale)',
    );
    expect(EXCEPTION_SCHEMA_VERSION).toBe(1);
    expect(EXCEPTIONS_ENGINE).toBe('intelligence-exceptions');
  });

  it('ranks the typed severity scale as exact rationals', () => {
    expect(severityRankOf('minor')).toStrictEqual(rational(1, 4));
    expect(severityRankOf('moderate')).toStrictEqual(rational(1, 2));
    expect(severityRankOf('major')).toStrictEqual(rational(3, 4));
    expect(severityRankOf('critical')).toStrictEqual(RATIONAL_ONE);
  });

  it('defaults to the balanced seed: severity 1/2, economic 1/2, scale 10M USD', () => {
    expect(DEFAULT_PRIORITY_WEIGHTS.severityWeight).toStrictEqual(rational(1, 2));
    expect(DEFAULT_PRIORITY_WEIGHTS.economicWeight).toStrictEqual(rational(1, 2));
    expect(DEFAULT_PRIORITY_WEIGHTS.economicScale.amountMinor).toBe(10_000_000);
    expect(DEFAULT_PRIORITY_WEIGHTS.economicScale.currency).toBe('USD');
  });
});
