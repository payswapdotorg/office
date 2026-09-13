import { describe, expect, it } from 'vitest';
import { budgetBasisOf, committedAmountMinorOf } from '@office/domain-cost';
import {
  LEAD_TIME_DAYS_MAX,
  budgetOfRecordFor,
  buildVendorComparison,
  normalizedAmountMinorOf,
  parseProcurementAlternative,
  procurementNeedsOf,
  vendorPerformanceOf,
} from './comparison';
import type { ProcurementAlternative } from './comparison';
import { parseComparisonId } from './vocabulary';
import { HISTORY_BENCHMARK, HISTORY_OUTCOMES, needScenarioOf, switchScenario } from './scenarios';
import {
  DETECTED_AT,
  T2,
  projectOneScope,
  sourceRef,
  testAssessmentId,
  testLedgerEventId,
  unwrap,
  USER_ACTOR,
} from './test-support';

// OFF-034 comparison — THE vendor comparison contracts: the fail-closed
// quoted-alternative input grammar, the exact normalized amounts, the
// outcome-derived vendor-performance ratings, the budget-of-record
// resolution (the commitment's lines reference the budget's cost items —
// several budgets of record may live in one project), the need derivation
// over the cost domain's derived reads, and the four-dimension comparison
// builder.

/** The raw quote record shared by the parser probes (mutated per probe). */
const quoteRaw = (): Record<string, unknown> => ({
  alternativeId: 'quote-t01',
  vendorKey: 'vendor-41',
  scope: projectOneScope(),
  incumbentCommitmentId: null,
  incumbentVendor: false,
  quotedQuantityMilli: 1_000,
  quotedUnitRateMinor: 100_000,
  currency: 'USD',
  leadTimeDays: 10,
  outcomeIds: [],
});

/** Parse a valid quoted alternative (the honest input path). */
const quoteOf = (overrides: Record<string, unknown>): ProcurementAlternative =>
  unwrap(parseProcurementAlternative({ ...quoteRaw(), ...overrides }));

const outcomesOf = new Map(HISTORY_OUTCOMES.map((outcome) => [outcome.outcomeId, outcome] as const));

describe('parseProcurementAlternative (the fail-closed input contract)', () => {
  it('parses a well-formed quote through the honest input path', () => {
    const parsed = quoteOf({});
    expect(parsed.alternativeId).toBe('quote-t01');
    expect(parsed.vendorKey).toBe('vendor-41');
    expect(parsed.incumbentCommitmentId).toBeNull();
    expect(parsed.incumbentVendor).toBe(false);
    expect(parsed.quotedQuantityMilli).toBe(1_000);
    expect(parsed.quotedUnitRateMinor).toBe(100_000);
    expect(parsed.currency).toBe('USD');
    expect(parsed.leadTimeDays).toBe(10);
    expect(parsed.outcomeIds).toStrictEqual([]);
  });

  it('rejects non-objects, unknown fields, and malformed identities', () => {
    expect(parseProcurementAlternative('quote').ok).toBe(false);
    expect(parseProcurementAlternative(null).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), extra: 'field' }).ok).toBe(false);
    // The alternative id grammar: 8..128 printable ASCII, no whitespace.
    expect(parseProcurementAlternative({ ...quoteRaw(), alternativeId: 'short' }).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), alternativeId: 'has space' }).ok).toBe(false);
    // The generic vendor key grammar: 'vendor-' + 2..8 digits, never a name.
    expect(parseProcurementAlternative({ ...quoteRaw(), vendorKey: 'vendor' }).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), vendorKey: 'acme-supply' }).ok).toBe(false);
    expect(
      parseProcurementAlternative({ ...quoteRaw(), vendorKey: 'vendor-000000001' }).ok,
    ).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), vendorKey: 'vendor-01' }).ok).toBe(true);
  });

  it('rejects malformed price/delivery/history terms (fail-closed bounds)', () => {
    expect(parseProcurementAlternative({ ...quoteRaw(), quotedQuantityMilli: 0 }).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), quotedQuantityMilli: 1.5 }).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), quotedUnitRateMinor: -1 }).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), currency: 'DOLLAR' }).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), leadTimeDays: 0 }).ok).toBe(false);
    expect(
      parseProcurementAlternative({ ...quoteRaw(), leadTimeDays: LEAD_TIME_DAYS_MAX + 1 }).ok,
    ).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), outcomeIds: 'outcome-0001' }).ok).toBe(false);
    expect(parseProcurementAlternative({ ...quoteRaw(), outcomeIds: ['bad id'] }).ok).toBe(false);
  });

  it('rejects inexact extensions (money is never rounded)', () => {
    // 1 milli x 1 minor/unit does not divide evenly by 1000.
    const inexact = parseProcurementAlternative({
      ...quoteRaw(),
      quotedQuantityMilli: 1,
      quotedUnitRateMinor: 1,
    });
    expect(inexact.ok).toBe(false);
    if (!inexact.ok) {
      expect(inexact.error.code).toBe('invalid-value');
    }
    // The same rate at a whole-unit quantity is exact.
    expect(
      parseProcurementAlternative({
        ...quoteRaw(),
        quotedQuantityMilli: 1_000,
        quotedUnitRateMinor: 1,
      }).ok,
    ).toBe(true);
  });

  it('normalizedAmountMinorOf is the exact extension quantityMilli x unitRateMinor / 1000', () => {
    expect(
      normalizedAmountMinorOf({ quotedQuantityMilli: 10_000, quotedUnitRateMinor: 780_000 }),
    ).toBe(7_800_000);
    expect(
      normalizedAmountMinorOf({ quotedQuantityMilli: 5_000, quotedUnitRateMinor: 700_000 }),
    ).toBe(3_500_000);
    expect(normalizedAmountMinorOf({ quotedQuantityMilli: 1_000, quotedUnitRateMinor: 0 })).toBe(0);
  });
});

describe('vendorPerformanceOf (the outcome-derived rating — never a manual score)', () => {
  it('is unrated without referenced outcomes (with its typed reason)', () => {
    const rating = vendorPerformanceOf(quoteOf({}), outcomesOf);
    expect(rating.level).toBe('unrated');
    expect(rating.reasons).toStrictEqual(['no-referenced-outcomes']);
    expect(rating.outcomeIds).toStrictEqual([]);
    expect(rating.onTimeCount).toBe(0);
    expect(rating.totalCount).toBe(0);
    expect(rating.onTimeShare).toBeNull();
  });

  it('derives strong at the 2/3 on-time share and acceptable at 1/2', () => {
    // Outcomes 1..3: variances -2, -1, +3 -> 2/3 on time (strong).
    const strong = vendorPerformanceOf(
      quoteOf({ outcomeIds: ['outcome-0001', 'outcome-0002', 'outcome-0003'] }),
      outcomesOf,
    );
    expect(strong.level).toBe('strong');
    expect(strong.reasons).toStrictEqual(['on-time-share-strong']);
    expect(strong.onTimeCount).toBe(2);
    expect(strong.totalCount).toBe(3);
    expect(strong.onTimeShare).toStrictEqual({ numerator: 2, denominator: 3 });
    // Outcomes 5..6: variances +1, -4 -> 1/2 on time (acceptable).
    const acceptable = vendorPerformanceOf(
      quoteOf({ outcomeIds: ['outcome-0005', 'outcome-0006'] }),
      outcomesOf,
    );
    expect(acceptable.level).toBe('acceptable');
    expect(acceptable.onTimeShare).toStrictEqual({ numerator: 1, denominator: 2 });
    // Variance exactly 0 is on time (variance <= 0).
    const onTimeZero = vendorPerformanceOf(
      quoteOf({ outcomeIds: ['outcome-0001', 'outcome-0002'] }),
      outcomesOf,
    );
    expect(onTimeZero.onTimeCount).toBe(2);
    expect(onTimeZero.onTimeShare).toStrictEqual({ numerator: 1, denominator: 1 });
  });

  it('derives underperforming below the 1/3 on-time share', () => {
    // Outcome 3 (+3 days) is the only reference: 0/1 on time.
    const underperforming = vendorPerformanceOf(
      quoteOf({ outcomeIds: ['outcome-0003'] }),
      outcomesOf,
    );
    expect(underperforming.level).toBe('underperforming');
    expect(underperforming.reasons).toStrictEqual(['on-time-share-underperforming']);
    expect(underperforming.onTimeShare).toStrictEqual({ numerator: 0, denominator: 1 });
  });

  it('ignores referenced-but-absent outcome ids (the outcome map is the truth)', () => {
    const rating = vendorPerformanceOf(quoteOf({ outcomeIds: ['outcome-9999'] }), outcomesOf);
    expect(rating.level).toBe('unrated');
    expect(rating.outcomeIds).toStrictEqual([]);
  });

  it('cites its outcome ids in canonical order regardless of input order', () => {
    const rating = vendorPerformanceOf(
      quoteOf({ outcomeIds: ['outcome-0003', 'outcome-0001', 'outcome-0002'] }),
      outcomesOf,
    );
    expect(rating.outcomeIds).toStrictEqual(['outcome-0001', 'outcome-0002', 'outcome-0003']);
  });
});

describe('budgetOfRecordFor (the commitment lines reference the budget of record)', () => {
  const scenario = switchScenario();

  /** A second same-project scenario (the multi-budget-per-project probe). */
  const otherScenario = (): ReturnType<typeof needScenarioOf> =>
    needScenarioOf({
      n: 41,
      costItemQuantityMilli: 2_000,
      costItemUnitRateMinor: 1_000_000,
      commitmentAmountMinor: 2_000_000,
      assessedDeltaMinor: 100_000,
      assessedDurationDelta: 0,
      quotes: [
        {
          alternativeId: 'quote-d1',
          vendorKey: 'vendor-41',
          incumbentVendor: true,
          quantityMilli: 2_000,
          unitRateMinor: 1_050_000,
          leadTimeDays: 30,
          outcomeIds: [],
        },
      ],
    });

  it('resolves the budget whose basis contains the commitment line cost items', () => {
    const budget = budgetOfRecordFor([scenario.budget], scenario.commitment);
    expect(budget?.entityId).toBe(scenario.budget.entityId);
  });

  it('resolves the RIGHT budget when several budgets share one project (input-order independent)', () => {
    // The golden portfolio puts three budgets in project 1: the resolution
    // must be by cost-item containment, never by the first same-project hit.
    const other = otherScenario();
    const orderings = [
      [other.budget, scenario.budget],
      [scenario.budget, other.budget],
    ];
    for (const ordering of orderings) {
      expect(budgetOfRecordFor(ordering, scenario.commitment)?.entityId).toBe(
        scenario.budget.entityId,
      );
      expect(budgetOfRecordFor(ordering, other.commitment)?.entityId).toBe(other.budget.entityId);
    }
  });

  it('returns undefined when no budget contains the commitment line items', () => {
    expect(budgetOfRecordFor([], scenario.commitment)).toBeUndefined();
    const unrelated = otherScenario();
    expect(budgetOfRecordFor([unrelated.budget], scenario.commitment)).toBeUndefined();
  });
});

describe('procurementNeedsOf (the need derivation — the incumbent position)', () => {
  const scenario = switchScenario();
  const needOf = () =>
    procurementNeedsOf([scenario.budget], [scenario.commitment], [scenario.assessment])[0]!;

  it('derives the need with its cited incumbent path', () => {
    const needs = procurementNeedsOf([scenario.budget], [scenario.commitment], [scenario.assessment]);
    expect(needs).toHaveLength(1);
    const need = needOf();
    expect(need.incumbentCommitmentId).toBe(scenario.commitment.entityId);
    expect(need.budgetId).toBe(scenario.budget.entityId);
    expect(need.costItemId).toBe(scenario.assessment.costImpact.itemDeltas[0]?.costItemId);
    expect(need.incumbentAmountMinor).toBe(committedAmountMinorOf(scenario.commitment));
    expect(need.assessedDeltaMinor).toBe(scenario.assessment.costImpact.budgetRevisionDeltaMinor);
    expect(need.incumbentPathAmountMinor).toBe(
      committedAmountMinorOf(scenario.commitment) +
        scenario.assessment.costImpact.budgetRevisionDeltaMinor,
    );
    expect(need.currency).toBe('USD');
    expect(need.assessmentIds).toStrictEqual([scenario.assessment.assessmentId]);
    expect(need.assessment.assessmentId).toBe(scenario.assessment.assessmentId);
  });

  it('skips commitments without a producing assessment (no basis, no need)', () => {
    const needs = procurementNeedsOf([scenario.budget], [scenario.commitment], []);
    expect(needs).toStrictEqual([]);
  });

  it('the LATEST producing assessment wins (the newest projection of the same need)', () => {
    const newer = {
      ...scenario.assessment,
      assessmentId: testAssessmentId(9041),
      costImpact: {
        ...scenario.assessment.costImpact,
        budgetRevisionDeltaMinor: 123_000,
        evidence: [sourceRef(testLedgerEventId(1341), 'cost.costItemRecorded', T2)],
      },
    };
    const needs = procurementNeedsOf(
      [scenario.budget],
      [scenario.commitment],
      [newer, scenario.assessment],
    );
    expect(needs).toHaveLength(1);
    const need = needs[0];
    if (need === undefined) throw new Error('missing need');
    expect(need.assessment.assessmentId).toBe(newer.assessmentId);
    expect(need.assessedDeltaMinor).toBe(123_000);
    expect(need.incumbentPathAmountMinor).toBe(8_123_000);
  });
});

describe('buildVendorComparison (THE four-dimension comparison record)', () => {
  const scenario = switchScenario();
  const basisItem = (): ReturnType<typeof budgetBasisOf>[number] => budgetBasisOf(scenario.budget)[0]!;
  const comparisonParts = (
    alternatives: readonly ProcurementAlternative[],
    benchmarks: readonly (typeof HISTORY_BENCHMARK)[] = [HISTORY_BENCHMARK],
  ) => ({
    need: procurementNeedsOf([scenario.budget], [scenario.commitment], [scenario.assessment])[0]!,
    budget: scenario.budget,
    basisItem: basisItem(),
    commitment: scenario.commitment,
    alternatives,
    outcomesOf,
    benchmarks,
    comparisonId: unwrap(parseComparisonId('scan-0001#c0041')),
    detectedAt: DETECTED_AT,
    actor: USER_ACTOR,
  });

  it('builds one row per quoted alternative in canonical id order with all four dimensions', () => {
    const comparison = unwrap(buildVendorComparison(comparisonParts([...scenario.alternatives].reverse())));
    expect(comparison.rows.map((row) => row.alternativeId)).toStrictEqual(['quote-a1', 'quote-a2']);
    for (const row of comparison.rows) {
      // Price: the exact extension.
      expect(row.price.normalizedAmountMinor).toBe(
        normalizedAmountMinorOf({
          quotedQuantityMilli: row.price.quotedQuantityMilli,
          quotedUnitRateMinor: row.price.quotedUnitRateMinor,
        }),
      );
      // Delivery: every row measures against the incumbent re-quote.
      expect(row.delivery.incumbentLeadTimeDays).toBe(30);
      expect(row.delivery.leadGainDays).toBe(30 - row.delivery.leadTimeDays);
      // Risk factors are vendor-scoped.
      for (const factor of row.riskFactors) {
        expect(factor.vendorKey).toBe(row.vendorKey);
      }
    }
    // The challenger carries its history; the unrated incumbent row carries
    // the no-history risk factor.
    const challenger = comparison.rows.find((row) => !row.incumbentVendor);
    expect(challenger?.performance.level).toBe('strong');
    expect(challenger?.performance.outcomeIds).toStrictEqual([
      'outcome-0001',
      'outcome-0002',
      'outcome-0003',
    ]);
    const incumbentRow = comparison.rows.find((row) => row.incumbentVendor);
    expect(incumbentRow?.performance.level).toBe('unrated');
    expect(incumbentRow?.riskFactors.map((factor) => factor.kind)).toStrictEqual([
      'no-vendor-history',
    ]);
    // The historical basis is the union of the rows' referenced outcomes +
    // the schedule-variance benchmark fact.
    expect(comparison.historicalBasis.outcomeIds).toStrictEqual([
      'outcome-0001',
      'outcome-0002',
      'outcome-0003',
    ]);
    expect(comparison.historicalBasis.benchmarks).toStrictEqual([
      { benchmarkId: HISTORY_BENCHMARK.benchmarkId, metricKind: 'schedule-variance-days' },
    ]);
    expect(comparison.assessmentIds).toStrictEqual([scenario.assessment.assessmentId]);
    expect(comparison.engine).toBe('intelligence-procurement');
    expect(comparison.actor).toStrictEqual(USER_ACTOR);
    expect(comparison.scope).toStrictEqual(scenario.commitment.scope);
    expect(comparison.comparisonVersion).toBe(1);
  });

  it('carries the price-above-budget-basis risk factor when a quote exceeds the basis', () => {
    const above = quoteOf({
      alternativeId: 'quote-t02',
      incumbentCommitmentId: scenario.commitment.entityId,
      quotedQuantityMilli: 10_000,
      quotedUnitRateMinor: 1_100_000,
    });
    const comparison = unwrap(
      buildVendorComparison(comparisonParts([...scenario.alternatives, above], [])),
    );
    const row = comparison.rows.find((candidate) => candidate.alternativeId === 'quote-t02');
    expect(row?.riskFactors.map((factor) => factor.kind)).toContain('price-above-budget-basis');
    // Without benchmarks the historical basis carries no benchmark fact.
    expect(comparison.historicalBasis.benchmarks).toStrictEqual([]);
  });

  it('typed-rejects a need without the incumbent vendor re-quote (the baseline)', () => {
    const onlyChallenger = scenario.alternatives.filter(
      (alternative) => !alternative.incumbentVendor,
    );
    const rejected = buildVendorComparison(comparisonParts(onlyChallenger));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('incumbent-quote-required');
    }
  });

  it('is deterministic: the same parts build the byte-identical comparison', () => {
    const parts = comparisonParts(scenario.alternatives);
    expect(buildVendorComparison({ ...parts })).toStrictEqual(buildVendorComparison({ ...parts }));
  });
});
