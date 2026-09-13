import { beforeAll, describe, expect, it } from 'vitest';
import type { CurrencyCode } from '@office/intelligence-margin';
import { unwrap } from './test-support';
import { runPortfolioScan } from './scenarios';
import type { PortfolioScanRun } from './scenarios';
import type { Rational } from '@office/intelligence-memory';
import {
  DEFAULT_PRIORITY_WEIGHTS,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  addRationals,
  minRationals,
  multiplyRationals,
  rationalCompare,
  reduceExceptionRational,
  severityRankOf,
} from './model';
import type { Exception, PriorityWeights } from './model';
import { compareRankedPriority, rankExceptions } from './rank';

// OFF-019 seeded prioritization — THE deterministic ranking function with
// its EXPOSED score composition (the named acceptance): every ranked
// exception carries both attributable components (severity weight x rank,
// economic weight x exposure) over EXACT RATIONALS, recomputable by hand
// from the model alone, and the ordering is a TOTAL ORDER — identical
// across runs and input permutations, with typed tie-breakers and
// fail-closed seed validation.

let run: PortfolioScanRun;

beforeAll(async () => {
  run = await runPortfolioScan();
});

const rational = (numerator: number, denominator: number): Rational => ({
  numerator,
  denominator,
});

const weightsOf = (parts: {
  severityWeight?: Rational;
  economicWeight?: Rational;
  amountMinor?: number;
}): PriorityWeights => ({
  severityWeight: parts.severityWeight ?? DEFAULT_PRIORITY_WEIGHTS.severityWeight,
  economicWeight: parts.economicWeight ?? DEFAULT_PRIORITY_WEIGHTS.economicWeight,
  economicScale: {
    amountMinor: parts.amountMinor ?? DEFAULT_PRIORITY_WEIGHTS.economicScale.amountMinor,
    currency: 'USD' as CurrencyCode,
  },
});

describe('the exposed priority-score composition (OFF-019 named acceptance)', () => {
  it('decomposes every golden score into severity + economic contributions', () => {
    for (const ranked of run.ranked) {
      const { exception, score } = ranked;
      const weights = DEFAULT_PRIORITY_WEIGHTS;

      // Severity component: weight x severityRank(level), attributable.
      expect(score.severity.weight).toStrictEqual(weights.severityWeight);
      expect(score.severity.level).toBe(exception.severity.level);
      expect(score.severity.rank).toStrictEqual(severityRankOf(exception.severity.level));
      expect(score.severity.contribution).toStrictEqual(
        multiplyRationals(weights.severityWeight, severityRankOf(exception.severity.level)),
      );

      // Economic component: weight x min(1, amount/scale), attributable to
      // the exception's producing assessment ids.
      const amount = exception.economicImpact.amountMinor;
      const expectedExposure: Rational =
        amount === null || amount <= 0
          ? RATIONAL_ZERO
          : minRationals(
              RATIONAL_ONE,
              reduceExceptionRational(
                rational(amount, weights.economicScale.amountMinor),
              ),
            );
      expect(score.economic.weight).toStrictEqual(weights.economicWeight);
      expect(score.economic.exposure).toStrictEqual(expectedExposure);
      expect(score.economic.contribution).toStrictEqual(
        multiplyRationals(weights.economicWeight, expectedExposure),
      );
      expect(score.economic.amountMinor).toBe(exception.economicImpact.amountMinor);
      expect(score.economic.currency).toBe(exception.economicImpact.currency);
      expect(score.economic.assessmentIds).toStrictEqual(
        exception.economicImpact.assessmentIds,
      );

      // Total: severityContribution + economicContribution (exact).
      expect(score.total).toStrictEqual(
        addRationals(score.severity.contribution, score.economic.contribution),
      );
    }
  });

  it('recomputes the golden scores by hand (no black boxes)', () => {
    const byKind = new Map(run.ranked.map((ranked) => [ranked.exception.kind, ranked]));
    // Cost overrun: critical (1/1) at 3M over the 10M scale.
    const overrun = byKind.get('cost-overrun');
    expect(overrun?.score.severity.contribution).toStrictEqual(rational(1, 2));
    expect(overrun?.score.economic.exposure).toStrictEqual(rational(3, 10));
    expect(overrun?.score.economic.contribution).toStrictEqual(rational(3, 20));
    expect(overrun?.score.total).toStrictEqual(rational(13, 20));
    // Entitlement exposure: moderate (1/2) at 1M over the 10M scale.
    const entitlement = byKind.get('entitlement-exposure');
    expect(entitlement?.score.severity.contribution).toStrictEqual(rational(1, 4));
    expect(entitlement?.score.economic.exposure).toStrictEqual(rational(1, 10));
    expect(entitlement?.score.economic.contribution).toStrictEqual(rational(1, 20));
    expect(entitlement?.score.total).toStrictEqual(rational(3, 10));
    // Schedule slip: moderate (1/2), no direct money — severity alone.
    const slip = byKind.get('schedule-slip');
    expect(slip?.score.severity.contribution).toStrictEqual(rational(1, 4));
    expect(slip?.score.economic.exposure).toStrictEqual(RATIONAL_ZERO);
    expect(slip?.score.total).toStrictEqual(rational(1, 4));
    // Dependency risk + evidence gap: minor (1/4), moneyless — 1/8 each.
    for (const kind of ['dependency-risk', 'evidence-gap'] as const) {
      const moneyless = byKind.get(kind);
      expect(moneyless?.score.severity.contribution).toStrictEqual(rational(1, 8));
      expect(moneyless?.score.economic.exposure).toStrictEqual(RATIONAL_ZERO);
      expect(moneyless?.score.economic.contribution).toStrictEqual(RATIONAL_ZERO);
      expect(moneyless?.score.total).toStrictEqual(rational(1, 8));
    }
  });

  it('recomputes the composition identically under custom seeds', () => {
    const weights = weightsOf({
      severityWeight: rational(3, 4),
      economicWeight: rational(1, 4),
      amountMinor: 1_000_000,
    });
    const ranked = unwrap(rankExceptions(run.exceptions, weights));
    for (const entry of ranked) {
      expect(entry.score.severity.weight).toStrictEqual(rational(3, 4));
      expect(entry.score.economic.weight).toStrictEqual(rational(1, 4));
      const amount = entry.exception.economicImpact.amountMinor;
      // The smaller scale saturates the 3M overrun at 1.
      if (amount !== null && amount >= 1_000_000) {
        expect(entry.score.economic.exposure).toStrictEqual(RATIONAL_ONE);
      }
      expect(entry.score.total).toStrictEqual(
        addRationals(entry.score.severity.contribution, entry.score.economic.contribution),
      );
    }
    // The saturated cost-overrun outranks everything at severity 3/4 + 1/4.
    expect(ranked[0]?.exception.kind).toBe('cost-overrun');
    expect(ranked[0]?.score.total).toStrictEqual(RATIONAL_ONE);
  });

  it('ranks on severity alone when the economic weight is zero', () => {
    const ranked = unwrap(
      rankExceptions(run.exceptions, weightsOf({ economicWeight: RATIONAL_ZERO })),
    );
    // Critical first, then moderates, then minors (kind tie-break within ties).
    expect(ranked.map((entry) => entry.exception.severity.level)).toStrictEqual([
      'critical',
      'moderate',
      'moderate',
      'minor',
      'minor',
    ]);
    for (const entry of ranked) {
      expect(entry.score.economic.contribution).toStrictEqual(RATIONAL_ZERO);
    }
  });
});

describe('the stable total order (OFF-019 determinism)', () => {
  it('is a strict total order over the golden set (pairwise + antisymmetric)', () => {
    const ranked = run.ranked;
    for (let left = 0; left < ranked.length; left += 1) {
      for (let right = 0; right < ranked.length; right += 1) {
        const forward = compareRankedPriority(ranked[left]!, ranked[right]!);
        const backward = compareRankedPriority(ranked[right]!, ranked[left]!);
        // (0 - 0 is +0: the diagonal compares equal without a -0 trap.)
        expect(forward).toBe(0 - backward);
        if (left < right) {
          expect(forward).toBeLessThan(0);
        } else if (left > right) {
          expect(forward).toBeGreaterThan(0);
        } else {
          expect(forward).toBe(0);
        }
      }
    }
  });

  it('breaks the 1/8 moneyless tie by kind (dependency-risk before evidence-gap)', () => {
    const [fourth, fifth] = [run.ranked[3], run.ranked[4]];
    expect(fourth?.exception.kind).toBe('dependency-risk');
    expect(fifth?.exception.kind).toBe('evidence-gap');
    expect(rationalCompare(fourth?.score.total ?? RATIONAL_ZERO, fifth?.score.total ?? RATIONAL_ZERO)).toBe(0);
    expect(compareRankedPriority(fourth!, fifth!)).toBeLessThan(0);
  });

  it('produces the identical ordering under every input permutation', () => {
    const canonical = run.ranked.map((entry) => entry.exception.exceptionId);
    const permutations: readonly (readonly Exception[])[] = [
      [...run.exceptions].reverse(),
      rotate(run.exceptions, 1),
      rotate(run.exceptions, 3),
      swap(rotate(run.exceptions, 2), 0, 4),
    ];
    for (const [index, permutation] of permutations.entries()) {
      const ranked = unwrap(rankExceptions(permutation));
      expect(
        ranked.map((entry) => entry.exception.exceptionId),
        `permutation ${index}`,
      ).toStrictEqual(canonical);
      expect(ranked.map((entry) => entry.rank)).toStrictEqual([1, 2, 3, 4, 5]);
    }
  });
});

describe('fail-closed ranking rejections (OFF-019)', () => {
  it('rejects invalid seeds (weights + scale) with typed invariant violations', () => {
    const invalid: readonly [PriorityWeights, string][] = [
      [weightsOf({ severityWeight: rational(1, 0) }), 'severity weight must be an exact rational'],
      [weightsOf({ economicWeight: rational(1, -2) }), 'economic weight must be an exact rational'],
      [weightsOf({ severityWeight: rational(-1, 4) }), 'severity weight must be >= 0'],
      [weightsOf({ economicWeight: rational(-1, 4) }), 'economic weight must be >= 0'],
      [
        weightsOf({ severityWeight: RATIONAL_ZERO, economicWeight: RATIONAL_ZERO }),
        'severityWeight + economicWeight must be > 0',
      ],
      [weightsOf({ amountMinor: 0 }), 'economic scale amount must be an integer > 0'],
      [weightsOf({ amountMinor: -10 }), 'economic scale amount must be an integer > 0'],
    ];
    for (const [weights, fragment] of invalid) {
      const result = rankExceptions(run.exceptions, weights);
      expect(result.ok, `expected rejection: ${fragment}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invariant-violation');
        expect(result.error.message).toContain(fragment);
        expect(result.error.details[0]?.code).toBe('priority-weights-valid');
      }
    }
  });

  it('rejects duplicate exception ids (an exception set is a set)', () => {
    const duplicate = [...run.exceptions, run.exceptions[0]!];
    const result = rankExceptions(duplicate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('duplicate-exception');
      expect(result.error.details[0]?.message).toBe(run.exceptions[0]?.exceptionId);
    }
  });

  it('rejects cross-currency sets typed (no FX invention)', () => {
    const foreign = run.exceptions.map((exception) =>
      exception.exceptionId === 'scan-0001#0002'
        ? {
            ...exception,
            economicImpact: {
              ...exception.economicImpact,
              currency: 'EUR' as CurrencyCode,
            },
          }
        : exception,
    );
    const result = rankExceptions(foreign);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('exception-currency-consistent');
      expect(result.error.message).toContain('EUR');
      expect(result.error.message).toContain('USD');
    }
  });
});

/** Rotate an array left by `by` (a fixed, deterministic permutation). */
const rotate = <T>(values: readonly T[], by: number): readonly T[] => {
  if (values.length === 0) return values;
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
};

/** Swap two positions of an array (a fixed, deterministic permutation). */
const swap = <T>(values: readonly T[], left: number, right: number): readonly T[] => {
  const copy = [...values];
  const a = copy[left];
  const b = copy[right];
  if (a !== undefined) copy[right] = a;
  if (b !== undefined) copy[left] = b;
  return copy;
};
