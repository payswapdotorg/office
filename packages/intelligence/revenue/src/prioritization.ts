// Office intelligence — the deterministic seeded prioritization (OFF-033).
//
// rankRecoveryCandidates() is THE ranking function of the revenue recovery
// engine (the named acceptance): the same candidate set → the IDENTICAL
// ordering, every run, under every input permutation. The priority score
// composes severity weight + economic weight over EXACT RATIONALS with the
// composition EXPOSED on every ranked candidate (no black boxes):
//
//   priority = severityWeight x severityRank(level)
//            + economicWeight x min(1, recoveryValue / economicScale)
//
// severityRank is the typed four-level scale as an exact rational
// (minor 1/4, moderate 1/2, major 3/4, critical 1/1); the economic
// exposure is the candidate's money at stake over the caller-supplied SEED
// scale (the reference amount of the portfolio being ranked — the "seeded"
// of the seeded prioritization), bounded at 1. Kinds that carry no money
// (a delay-impact candidate has no cited amount) contribute an economic
// exposure of exactly 0 — they rank on severity alone, never on invented
// numbers.
//
// The ordering is a TOTAL ORDER with typed tie-breakers, so it is stable by
// construction: total score desc, then severity level desc, then economic
// amount desc (null amounts last), then kind asc, then the first
// referenced record asc, then candidate id asc (the terminal tie-breaker —
// ids are unique, so the comparator is total and the sort can never depend
// on the input permutation).
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { Rational } from '@office/intelligence-memory';
import type { EntityRef } from '@office/contracts';
import type { CandidateRecovery, RankedCandidate } from './candidates';
import {
  DEFAULT_PRIORITY_WEIGHTS,
  PRIORITY_FORMULA,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  addRationals,
  minRationals,
  multiplyRationals,
  rationalCompare,
  reduceRecoveryRational,
  severityRankOf,
} from './model';
import type {
  EconomicScoreComponent,
  PriorityScore,
  PriorityWeights,
  SeverityScoreComponent,
} from './model';
import type { SeverityLevel } from './vocabulary';

// ---------------------------------------------------------------------------
// Fail-closed ranking rejections.
// ---------------------------------------------------------------------------

const weightsFailure = (statement: string): DomainError =>
  domainError('invariant-violation', statement, [
    { code: 'priority-weights-valid', message: PRIORITY_FORMULA, path: null },
  ]);

const duplicateCandidateFailure = (candidateId: string): DomainError =>
  domainError(
    'invariant-violation',
    `the ranking input set contains a duplicate recovery candidate ${candidateId}: a candidate set is a set`,
    [{ code: 'duplicate-candidate', message: candidateId, path: 'candidates' }],
  );

const currencyFailure = (candidateId: string, currency: string, scale: string): DomainError =>
  domainError(
    'invariant-violation',
    `recovery candidate ${candidateId} carries its economic basis in ${currency} while the ranking seed scale is ${scale}: cross-currency prioritization is typed-rejected (no FX invention)`,
    [
      {
        code: 'candidate-currency-consistent',
        message: `rank per currency, or supply converted assessments (${currency} vs ${scale})`,
        path: 'economicBasis.currency',
      },
    ],
  );

// ---------------------------------------------------------------------------
// The weights validation (fail-closed — the seed must be explainable).
// ---------------------------------------------------------------------------

const validateWeights = (weights: PriorityWeights): Result<true, DomainError> => {
  const { severityWeight, economicWeight, economicScale } = weights;
  if (
    !Number.isInteger(severityWeight.numerator) ||
    !Number.isInteger(severityWeight.denominator) ||
    severityWeight.denominator <= 0
  ) {
    return fail(weightsFailure('the severity weight must be an exact rational'));
  }
  if (
    !Number.isInteger(economicWeight.numerator) ||
    !Number.isInteger(economicWeight.denominator) ||
    economicWeight.denominator <= 0
  ) {
    return fail(weightsFailure('the economic weight must be an exact rational'));
  }
  if (rationalCompare(severityWeight, RATIONAL_ZERO) < 0) {
    return fail(weightsFailure('the severity weight must be >= 0'));
  }
  if (rationalCompare(economicWeight, RATIONAL_ZERO) < 0) {
    return fail(weightsFailure('the economic weight must be >= 0'));
  }
  if (
    rationalCompare(addRationals(severityWeight, economicWeight), RATIONAL_ZERO) <= 0
  ) {
    return fail(weightsFailure('severityWeight + economicWeight must be > 0'));
  }
  if (
    !Number.isInteger(economicScale.amountMinor) ||
    economicScale.amountMinor <= 0
  ) {
    return fail(weightsFailure('the economic scale amount must be an integer > 0'));
  }
  return ok(true);
};

// ---------------------------------------------------------------------------
// The exposed score computation (pure, exact-rational).
// ---------------------------------------------------------------------------

const exposureOf = (candidate: CandidateRecovery, scaleAmountMinor: number): Rational => {
  const amount = candidate.economicBasis.amountMinor;
  if (amount === null || amount <= 0) return RATIONAL_ZERO;
  return minRationals(
    RATIONAL_ONE,
    reduceRecoveryRational({ numerator: amount, denominator: scaleAmountMinor }),
  );
};

const scoreOf = (candidate: CandidateRecovery, weights: PriorityWeights): PriorityScore => {
  const severityRank = severityRankOf(candidate.severity.level);
  const severityComponent: SeverityScoreComponent = {
    weight: weights.severityWeight,
    level: candidate.severity.level,
    rank: severityRank,
    contribution: multiplyRationals(weights.severityWeight, severityRank),
  };
  const exposure = exposureOf(candidate, weights.economicScale.amountMinor);
  const economicComponent: EconomicScoreComponent = {
    weight: weights.economicWeight,
    exposure,
    contribution: multiplyRationals(weights.economicWeight, exposure),
    amountMinor: candidate.economicBasis.amountMinor,
    currency: candidate.economicBasis.currency,
    citedFrom: candidate.economicBasis.citedFrom,
    assessmentIds: [...candidate.economicBasis.assessmentIds],
  };
  return {
    total: addRationals(severityComponent.contribution, economicComponent.contribution),
    severity: severityComponent,
    economic: economicComponent,
  };
};

// ---------------------------------------------------------------------------
// The total order (typed tie-breakers — stable by construction).
// ---------------------------------------------------------------------------

const severityLevelOrder = (level: SeverityLevel): number => {
  switch (level) {
    case 'minor':
      return 0;
    case 'moderate':
      return 1;
    case 'major':
      return 2;
    case 'critical':
      return 3;
  }
};

const amountOrder = (left: number | null, right: number | null): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1; // null amounts rank after money at stake
  if (right === null) return -1;
  if (left !== right) return left > right ? -1 : 1;
  return 0;
};

const firstReferencedOrder = (left: EntityRef | undefined, right: EntityRef | undefined): number => {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (left.entityKind !== right.entityKind) {
    return left.entityKind < right.entityKind ? -1 : 1;
  }
  if (left.entityId !== right.entityId) {
    return left.entityId < right.entityId ? -1 : 1;
  }
  return 0;
};

/**
 * THE comparator of the stable priority order (a TOTAL order):
 * total score desc → severity level desc → economic amount desc (null
 * last) → kind asc → first referenced record asc → candidate id asc.
 */
export const compareRankedPriority = (
  left: { readonly candidate: CandidateRecovery; readonly score: PriorityScore },
  right: { readonly candidate: CandidateRecovery; readonly score: PriorityScore },
): number => {
  const total = rationalCompare(right.score.total, left.score.total);
  if (total !== 0) return total;
  const severity =
    severityLevelOrder(right.candidate.severity.level) -
    severityLevelOrder(left.candidate.severity.level);
  if (severity !== 0) return severity;
  const amount = amountOrder(
    left.candidate.economicBasis.amountMinor,
    right.candidate.economicBasis.amountMinor,
  );
  if (amount !== 0) return amount;
  if (left.candidate.kind !== right.candidate.kind) {
    return left.candidate.kind < right.candidate.kind ? -1 : 1;
  }
  const referenced = firstReferencedOrder(
    left.candidate.referencedRecords[0],
    right.candidate.referencedRecords[0],
  );
  if (referenced !== 0) return referenced;
  if (left.candidate.candidateId !== right.candidate.candidateId) {
    return left.candidate.candidateId < right.candidate.candidateId ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// THE ranking function.
// ---------------------------------------------------------------------------

/**
 * THE deterministic seeded prioritization: rank the recovery candidate set
 * into the STABLE priority order (same set → identical ordering, every
 * run, under every input permutation) with the EXPOSED score composition
 * carried on every ranked candidate. The seed is the typed weights table
 * (severityWeight, economicWeight, economicScale — all exact rationals /
 * integer minor units; defaults provided). Cross-currency sets are
 * typed-rejected (no FX invention); duplicate candidate ids are
 * typed-rejected (a candidate set is a set).
 */
export function rankRecoveryCandidates(
  candidates: readonly CandidateRecovery[],
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): Result<readonly RankedCandidate[], DomainError> {
  // 1. The seed must be valid (fail-closed, never a silent default).
  const validWeights = validateWeights(weights);
  if (!validWeights.ok) return validWeights;

  // 2. A candidate set is a set (duplicate ids are a caller wiring error).
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.candidateId)) {
      return fail(duplicateCandidateFailure(candidate.candidateId));
    }
    seen.add(candidate.candidateId);
  }

  // 3. Currency consistency: every money-carrying candidate must share the
  //    seed scale's currency (cross-currency prioritization would need FX
  //    rates — an external dependency this engine never invents).
  for (const candidate of candidates) {
    const currency = candidate.economicBasis.currency;
    if (currency !== null && currency !== weights.economicScale.currency) {
      return fail(
        currencyFailure(
          candidate.candidateId,
          currency,
          weights.economicScale.currency,
        ),
      );
    }
  }

  // 4. Score + order (the comparator is total, so the sort is stable by
  //    construction and input-permutation independent).
  const scored = candidates.map((candidate) => ({
    candidate,
    score: scoreOf(candidate, weights),
  }));
  const ordered = [...scored].sort(compareRankedPriority);
  const ranked: RankedCandidate[] = ordered.map((entry, index) => ({
    rank: index + 1,
    candidate: entry.candidate,
    score: entry.score,
  }));
  return ok(ranked);
}
