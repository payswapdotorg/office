import { describe, expect, it } from 'vitest';
import { parseCurrencyCode as parseMarginCurrencyCode } from '@office/intelligence-margin';
import type { CurrencyCode } from '@office/intelligence-margin';
import {
  DEFAULT_PREFERENCE_WEIGHTS,
  PREFERENCE_FORMULA,
  RATIONAL_ONE,
  RATIONAL_ZERO,
} from './model';
import type { PreferenceWeights } from './model';
import { compareRankedPreference, leadGainDaysOf, rankProcurementRecommendations } from './ranking';
import { runGoldenProcurementScan } from './scenarios';
import { unwrap } from './test-support';
import type { RecommendationId } from './vocabulary';

// OFF-034 ranking — THE deterministic seeded prioritization: the fail-closed
// seed validation, the set rejections (duplicates, cross-currency), the
// EXPOSED exact-rational score composition over CITED numbers (a negative
// projected delta — a saving — is economic exposure too, and every exposure
// is capped at 1), and the TOTAL order that makes the ranking stable across
// runs and shuffles.

const run = runGoldenProcurementScan();

/** The typed currency of every seed probe (the shared typed grammar). */
const USD = unwrap(parseMarginCurrencyCode('USD'));

const weightsOf = (overrides: Partial<PreferenceWeights>): PreferenceWeights => ({
  ...DEFAULT_PREFERENCE_WEIGHTS,
  ...overrides,
});

describe('the fail-closed seed validation (never a silent default)', () => {
  it('rejects non-positive denominators and negative numerators', () => {
    const invalidSeeds: readonly [string, PreferenceWeights][] = [
      ['zero economic denominator', weightsOf({ economicWeight: { numerator: 1, denominator: 0 } })],
      ['zero delivery denominator', weightsOf({ deliveryWeight: { numerator: 1, denominator: 0 } })],
      ['negative economic numerator', weightsOf({ economicWeight: { numerator: -1, denominator: 2 } })],
      ['negative delivery numerator', weightsOf({ deliveryWeight: { numerator: -1, denominator: 2 } })],
    ];
    for (const [label, weights] of invalidSeeds) {
      const rejected = rankProcurementRecommendations(run.recommendations, weights);
      expect(rejected.ok, label).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('invariant-violation');
        expect(rejected.error.details[0]?.code).toBe('preference-weights-invalid');
      }
    }
  });

  it('rejects an all-zero weight seed and non-positive scales', () => {
    const invalidSeeds: readonly [string, PreferenceWeights][] = [
      [
        'both weights zero',
        weightsOf({
          economicWeight: RATIONAL_ZERO,
          deliveryWeight: RATIONAL_ZERO,
        }),
      ],
      ['zero economic scale', weightsOf({ economicScale: { amountMinor: 0, currency: USD } })],
      ['fractional economic scale', weightsOf({ economicScale: { amountMinor: 0.5, currency: USD } })],
      ['zero delivery scale', weightsOf({ deliveryScale: { days: 0 } })],
    ];
    for (const [label, weights] of invalidSeeds) {
      const rejected = rankProcurementRecommendations(run.recommendations, weights);
      expect(rejected.ok, label).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('invariant-violation');
      }
    }
  });

  it('exposes the formula and the default seed as documentation constants', () => {
    expect(PREFERENCE_FORMULA).toBe(
      'preference = economicWeight x min(1, |projectedDelta| / economicScale) + deliveryWeight x min(1, leadGainDays / deliveryScaleDays)',
    );
    expect(DEFAULT_PREFERENCE_WEIGHTS.economicWeight).toStrictEqual({ numerator: 1, denominator: 2 });
    expect(DEFAULT_PREFERENCE_WEIGHTS.deliveryWeight).toStrictEqual({ numerator: 1, denominator: 2 });
    expect(DEFAULT_PREFERENCE_WEIGHTS.economicScale).toStrictEqual({
      amountMinor: 10_000_000,
      currency: 'USD',
    });
    expect(DEFAULT_PREFERENCE_WEIGHTS.deliveryScale).toStrictEqual({ days: 30 });
  });
});

describe('the set rejections (a recommendation set is a set; one currency at a time)', () => {
  it('rejects duplicate recommendation ids', () => {
    const rejected = rankProcurementRecommendations([
      ...run.recommendations,
      run.recommendations[0]!,
    ]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('duplicate-recommendation');
      expect(rejected.error.details[0]?.message).toBe(run.recommendations[0]!.recommendationId);
    }
  });

  it('rejects cross-currency sets (the engine never invents FX)', () => {
    const euroProjection = {
      ...run.recommendations[0]!.projectedImpact,
      currency: 'EUR' as CurrencyCode,
    };
    const euroRecommendation = {
      ...run.recommendations[0]!,
      recommendationId: 'scan-0001#0007' as RecommendationId,
      projectedImpact: euroProjection,
    };
    const rejected = rankProcurementRecommendations([
      ...run.recommendations,
      euroRecommendation,
    ]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('recommendation-currency-consistent');
    }
  });
});

describe('the exposed score composition (exact rationals over CITED numbers)', () => {
  it('leadGainDaysOf measures the selected composition against the incumbent re-quote', () => {
    expect(run.ranked.map((ranked) => leadGainDaysOf(ranked.recommendation))).toStrictEqual([
      20, 5, 2,
    ]);
  });

  it('a NEGATIVE projected delta is economic exposure (a saving is exposure)', () => {
    // The golden vendor switch projects -700,000 of a 10,000,000 scale:
    // its economic exposure is the magnitude 7/100 — never zero.
    const switchRanked = run.ranked.find(
      (ranked) => ranked.recommendation.kind === 'vendor-switch',
    );
    expect(switchRanked?.score.economic.exposure).toStrictEqual({ numerator: 7, denominator: 100 });
    expect(switchRanked?.score.economic.projectedDeltaMinor).toBe(-700_000);
    expect(switchRanked?.score.economic.contribution).toStrictEqual({
      numerator: 7,
      denominator: 200,
    });
  });

  it('caps every exposure at 1 (the min(1, ...) of the formula)', () => {
    // A tighter seed: the scale equals the timing shift's |delta| (400,000)
    // and its delivery scale equals its lead gain (20 days) — both exposures
    // hit exactly 1, and the switch's 700,000 delta is CAPPED at 1.
    const tightSeed = weightsOf({
      economicScale: { amountMinor: 400_000, currency: USD },
      deliveryScale: { days: 20 },
    });
    const ranked = unwrap(rankProcurementRecommendations(run.recommendations, tightSeed));
    const timing = ranked.find((ranked) => ranked.recommendation.kind === 'timing-shift');
    expect(timing?.score.economic.exposure).toStrictEqual(RATIONAL_ONE);
    expect(timing?.score.delivery.exposure).toStrictEqual(RATIONAL_ONE);
    expect(timing?.score.total).toStrictEqual(RATIONAL_ONE);
    const switchRanked = ranked.find((ranked) => ranked.recommendation.kind === 'vendor-switch');
    // |−700,000| / 400,000 = 7/4 → capped at 1/1.
    expect(switchRanked?.score.economic.exposure).toStrictEqual(RATIONAL_ONE);
    // The order under the tighter seed: timing (1) > switch (11/20) > split (1/2).
    expect(ranked.map((ranked) => ranked.recommendation.kind)).toStrictEqual([
      'timing-shift',
      'vendor-switch',
      'order-splitting',
    ]);
  });

  it('composes the total as the exact sum of the two contributions', () => {
    for (const ranked of run.ranked) {
      const economic = ranked.score.economic.contribution;
      const delivery = ranked.score.delivery.contribution;
      const expected =
        (economic.numerator * delivery.denominator + delivery.numerator * economic.denominator) /
        (economic.denominator * delivery.denominator);
      expect(
        ranked.score.total.numerator / ranked.score.total.denominator,
      ).toBeCloseTo(expected, 12);
      // Every contribution is its weight x exposure (exact).
      expect(
        ranked.score.economic.contribution.numerator /
          ranked.score.economic.contribution.denominator,
      ).toBeCloseTo(
        (ranked.score.economic.weight.numerator / ranked.score.economic.weight.denominator) *
          (ranked.score.economic.exposure.numerator / ranked.score.economic.exposure.denominator),
        12,
      );
    }
  });
});

describe('THE stable total order (identical across runs and shuffles)', () => {
  it('ranks the golden set 1..n in the pinned preference order', () => {
    expect(run.ranked.map((ranked) => ranked.rank)).toStrictEqual([1, 2, 3]);
    expect(run.ranked.map((ranked) => ranked.recommendation.kind)).toStrictEqual([
      'timing-shift',
      'order-splitting',
      'vendor-switch',
    ]);
  });

  it('is stable under reversed and rotated input orderings', () => {
    const reversed = unwrap(
      rankProcurementRecommendations([...run.recommendations].reverse()),
    );
    expect(reversed).toStrictEqual(run.ranked);
    const rotated = unwrap(
      rankProcurementRecommendations([
        run.recommendations[1]!,
        run.recommendations[2]!,
        run.recommendations[0]!,
      ]),
    );
    expect(rotated).toStrictEqual(run.ranked);
  });

  it('breaks full ties by recommendation id (the last total-order step)', () => {
    const clone = {
      ...run.recommendations[0]!,
      recommendationId: 'scan-0001#0009' as RecommendationId,
    };
    const ranked = unwrap(rankProcurementRecommendations([clone, run.recommendations[0]!]));
    expect(ranked.map((ranked) => ranked.recommendation.recommendationId)).toStrictEqual([
      'scan-0001#0001',
      'scan-0001#0009',
    ]);
    expect(ranked.map((ranked) => ranked.rank)).toStrictEqual([1, 2]);
  });

  it('compareRankedPreference is antisymmetric over the golden set (a total order)', () => {
    for (const left of run.ranked) {
      for (const right of run.ranked) {
        const forward = compareRankedPreference(left, right);
        const backward = compareRankedPreference(right, left);
        // Antisymmetry: the two directions always sum to exactly zero
        // (integer comparators — no -0/+0 traps).
        expect(forward + backward).toBe(0);
        expect(Math.sign(forward)).toBe(Math.sign(left.rank - right.rank));
      }
    }
  });
});
