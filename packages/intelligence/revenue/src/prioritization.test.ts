import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from '@office/intelligence-margin';
import { parseCurrencyCode } from '@office/intelligence-margin';
import { runGoldenRecoveryScan } from './scenarios';
import { compareRankedPriority, rankRecoveryCandidates } from './prioritization';
import { parseCandidateId } from './vocabulary';
import {
  DEFAULT_PRIORITY_WEIGHTS,
  PRIORITY_FORMULA,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  addRationals,
  multiplyRationals,
  severityRankOf,
} from './model';
import type { PriorityWeights } from './model';
import type { CandidateRecovery } from './candidates';
import { unwrap } from './test-support';

// OFF-033 prioritization — THE deterministic seeded ranking: the EXPOSED
// exact-rational score composition (recomputable by hand from the model
// alone), the total order with typed tie-breakers, stability across runs
// AND shuffled input orderings, and the fail-closed rejections.

describe('the default seed + the exposed formula (documentation constants)', () => {
  it('pins the default weights and the formula statement', () => {
    expect(DEFAULT_PRIORITY_WEIGHTS).toStrictEqual({
      severityWeight: { numerator: 1, denominator: 2 },
      economicWeight: { numerator: 1, denominator: 2 },
      economicScale: { amountMinor: 10_000_000, currency: 'USD' },
    });
    expect(PRIORITY_FORMULA).toBe(
      'priority = severityWeight x severityRank(level) + economicWeight x min(1, recoveryValue / economicScale)',
    );
    expect(severityRankOf('minor')).toStrictEqual({ numerator: 1, denominator: 4 });
    expect(severityRankOf('critical')).toStrictEqual(RATIONAL_ONE);
  });
});

describe('THE exposed score composition (recomputable by hand)', () => {
  const run = runGoldenRecoveryScan();
  const ranked = run.ranked;

  it('composes the golden delay-impact score: severity only, no invented money', () => {
    // critical severity, no money at stake: 1/2 x 1 + 1/2 x 0 = 1/2.
    const delay = ranked.find((entry) => entry.candidate.kind === 'delay-impact');
    expect(delay).toBeDefined();
    if (delay === undefined) return;
    expect(delay.score.severity).toStrictEqual({
      weight: { numerator: 1, denominator: 2 },
      level: 'critical',
      rank: RATIONAL_ONE,
      contribution: { numerator: 1, denominator: 2 },
    });
    expect(delay.score.economic).toStrictEqual({
      weight: { numerator: 1, denominator: 2 },
      exposure: RATIONAL_ZERO,
      contribution: RATIONAL_ZERO,
      amountMinor: null,
      currency: null,
      citedFrom: 'none',
      assessmentIds: [delay.candidate.economicBasis.assessmentIds[0]],
    });
    expect(delay.score.total).toStrictEqual({ numerator: 1, denominator: 2 });
  });

  it('composes the golden entitlement-rebalance score: 1/2 x 3/4 + 1/2 x 1/4 = 1/2', () => {
    const rebalance = ranked.find((entry) => entry.candidate.kind === 'entitlement-rebalance');
    expect(rebalance).toBeDefined();
    if (rebalance === undefined) return;
    expect(rebalance.score.severity.contribution).toStrictEqual({ numerator: 3, denominator: 8 });
    expect(rebalance.score.economic.exposure).toStrictEqual({ numerator: 1, denominator: 4 });
    expect(rebalance.score.economic.contribution).toStrictEqual({ numerator: 1, denominator: 8 });
    expect(rebalance.score.total).toStrictEqual({ numerator: 1, denominator: 2 });
  });

  it('composes the golden constructive-change score: 1/2 x 1/2 + 1/2 x 3/40 = 23/80', () => {
    const constructive = ranked.find((entry) => entry.candidate.kind === 'constructive-change');
    expect(constructive).toBeDefined();
    if (constructive === undefined) return;
    expect(constructive.score.severity.contribution).toStrictEqual({ numerator: 1, denominator: 4 });
    expect(constructive.score.economic.exposure).toStrictEqual({ numerator: 3, denominator: 40 });
    expect(constructive.score.economic.contribution).toStrictEqual({ numerator: 3, denominator: 80 });
    expect(constructive.score.total).toStrictEqual({ numerator: 23, denominator: 80 });
    // THE formula, recomputed by hand from the components:
    expect(constructive.score.total).toStrictEqual(
      addRationals(
        multiplyRationals(
          constructive.score.severity.weight,
          severityRankOf(constructive.score.severity.level),
        ),
        multiplyRationals(constructive.score.economic.weight, constructive.score.economic.exposure),
      ),
    );
  });

  it('ties break by severity level desc before kind (the golden 1/2-vs-1/2 tie)', () => {
    // delay-impact (critical) and entitlement-rebalance (major) both total
    // exactly 1/2: the delay candidate ranks first on the severity tie-break.
    expect(ranked.map((entry) => entry.candidate.kind)).toStrictEqual([
      'delay-impact',
      'entitlement-rebalance',
      'constructive-change',
    ]);
    expect(ranked.map((entry) => entry.rank)).toStrictEqual([1, 2, 3]);
    const delay = ranked[0];
    const rebalance = ranked[1];
    expect(delay && rebalance).toBeDefined();
    if (delay === undefined || rebalance === undefined) return;
    expect(compareRankedPriority(delay, rebalance)).toBeLessThan(0);
    expect(compareRankedPriority(rebalance, delay)).toBeGreaterThan(0);
  });

  it('recomputes every golden score from the model alone (no black boxes)', () => {
    for (const entry of ranked) {
      const expected = addRationals(
        multiplyRationals(entry.score.severity.weight, entry.score.severity.rank),
        multiplyRationals(entry.score.economic.weight, entry.score.economic.exposure),
      );
      expect(entry.score.total).toStrictEqual(expected);
      // The economic component cites the producing assessment ids.
      expect(entry.score.economic.assessmentIds).toStrictEqual(
        entry.candidate.economicBasis.assessmentIds,
      );
    }
  });
});

describe('stability across runs AND shuffled input orderings', () => {
  it('is identical across independent runs and candidate-set shuffles', () => {
    const first = runGoldenRecoveryScan().ranked;
    const second = runGoldenRecoveryScan().ranked;
    expect(second).toStrictEqual(first);
    const candidates = first.map((entry) => entry.candidate);
    const shuffled = unwrap(rankRecoveryCandidates([...candidates].reverse()));
    expect(shuffled).toStrictEqual(first);
    const rotated = unwrap(rankRecoveryCandidates([candidates[2]!, candidates[0]!, candidates[1]!]));
    expect(rotated).toStrictEqual(first);
  });

  it('re-ranking the ranked set reproduces the identical order + scores', () => {
    const run = runGoldenRecoveryScan();
    const reRanked = unwrap(rankRecoveryCandidates(run.ranked.map((entry) => entry.candidate)));
    expect(reRanked).toStrictEqual(run.ranked);
  });

  it('is stable under a different valid seed (the weights are attributable)', () => {
    const run = runGoldenRecoveryScan();
    const severityHeavy: PriorityWeights = {
      severityWeight: { numerator: 1, denominator: 1 },
      economicWeight: { numerator: 0, denominator: 1 },
      economicScale: DEFAULT_PRIORITY_WEIGHTS.economicScale,
    };
    const reRanked = unwrap(
      rankRecoveryCandidates(run.candidates, severityHeavy),
    );
    // Pure severity ranking: critical (delay) > major (rebalance) > moderate
    // (constructive) — same golden order, severity-only scores.
    expect(reRanked.map((entry) => entry.candidate.kind)).toStrictEqual([
      'delay-impact',
      'entitlement-rebalance',
      'constructive-change',
    ]);
    for (const entry of reRanked) {
      expect(entry.score.severity.weight).toStrictEqual(RATIONAL_ONE);
      expect(entry.score.economic.contribution).toStrictEqual(RATIONAL_ZERO);
      expect(entry.score.total).toStrictEqual(entry.score.severity.contribution);
    }
  });
});

describe('the fail-closed ranking rejections', () => {
  const run = runGoldenRecoveryScan();

  it('rejects a negative weight', () => {
    const rejected = rankRecoveryCandidates(run.candidates, {
      severityWeight: { numerator: -1, denominator: 2 },
      economicWeight: { numerator: 1, denominator: 2 },
      economicScale: DEFAULT_PRIORITY_WEIGHTS.economicScale,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('priority-weights-valid');
    }
  });

  it('rejects weights summing to zero', () => {
    const rejected = rankRecoveryCandidates(run.candidates, {
      severityWeight: RATIONAL_ZERO,
      economicWeight: RATIONAL_ZERO,
      economicScale: DEFAULT_PRIORITY_WEIGHTS.economicScale,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(String(rejected.error.message)).toContain('severityWeight + economicWeight');
    }
  });

  it('rejects a non-positive economic scale', () => {
    const rejected = rankRecoveryCandidates(run.candidates, {
      severityWeight: { numerator: 1, denominator: 2 },
      economicWeight: { numerator: 1, denominator: 2 },
      economicScale: { amountMinor: 0, currency: DEFAULT_PRIORITY_WEIGHTS.economicScale.currency },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(String(rejected.error.message)).toContain('economic scale');
    }
  });

  it('rejects duplicate candidate ids (a candidate set is a set)', () => {
    const rejected = rankRecoveryCandidates([run.candidates[0]!, run.candidates[0]!]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.details[0]?.code).toBe('duplicate-candidate');
      expect(String(rejected.error.details[0]?.message)).toBe(run.candidates[0]?.candidateId);
    }
  });

  it('rejects a cross-currency candidate set (no FX invention)', () => {
    const eur = unwrap(parseCurrencyCode('EUR')) as CurrencyCode;
    const foreignCurrency: CandidateRecovery = {
      ...run.candidates[0]!,
      candidateId: unwrap(parseCandidateId('scan-9999#0001')),
      economicBasis: { ...run.candidates[0]!.economicBasis, currency: eur },
    };
    const rejected = rankRecoveryCandidates([...run.candidates, foreignCurrency]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.details[0]?.code).toBe('candidate-currency-consistent');
      expect(String(rejected.error.message)).toContain('EUR');
    }
  });

  it('ranks an empty set to an empty ranking', () => {
    expect(unwrap(rankRecoveryCandidates([]))).toStrictEqual([]);
  });
});
