// Office intelligence — the deterministic seeded prioritization (OFF-019).
//
// rankExceptions() is THE ranking function of the control tower (the named
// acceptance): the same exception set → the IDENTICAL ordering, every run,
// under every input permutation. The priority score composes severity
// weight + economic weight over EXACT RATIONALS with the composition
// EXPOSED on every ranked exception (no black boxes):
//
//   priority = severityWeight x severityRank(level)
//            + economicWeight x min(1, economicImpact / economicScale)
//
// severityRank is the typed four-level scale as an exact rational
// (minor 1/4, moderate 1/2, major 3/4, critical 1/1); the economic exposure
// is the exception's money at stake over the caller-supplied SEED scale
// (the reference amount of the portfolio being ranked — the "seeded" of the
// seeded prioritization), bounded at 1. Kinds that carry no money (a
// dependency risk or an evidence gap has no amount) contribute an economic
// exposure of exactly 0 — they rank on severity alone, never on invented
// numbers.
//
// The ordering is a TOTAL ORDER with typed tie-breakers, so it is stable by
// construction: total score desc, then severity level desc, then economic
// amount desc (null amounts last), then kind asc, then the first affected
// entity ref asc, then exception id asc (the terminal tie-breaker — ids are
// unique, so the comparator is total and the sort can never depend on the
// input permutation).
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { Rational } from '@office/intelligence-memory';
import {
  DEFAULT_PRIORITY_WEIGHTS,
  PRIORITY_FORMULA,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  addRationals,
  minRationals,
  multiplyRationals,
  rationalCompare,
  reduceExceptionRational,
  severityRankOf,
} from './model';
import type {
  EconomicScoreComponent,
  Exception,
  PriorityScore,
  PriorityWeights,
  RankedException,
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

const duplicateExceptionFailure = (exceptionId: string): DomainError =>
  domainError(
    'invariant-violation',
    `the ranking input set contains a duplicate exception ${exceptionId}: an exception set is a set`,
    [{ code: 'duplicate-exception', message: exceptionId, path: 'exceptions' }],
  );

const currencyFailure = (exceptionId: string, currency: string, scale: string): DomainError =>
  domainError(
    'invariant-violation',
    `exception ${exceptionId} carries economic impact in ${currency} while the ranking seed scale is ${scale}: cross-currency prioritization is typed-rejected (no FX invention)`,
    [
      {
        code: 'exception-currency-consistent',
        message: `rank per currency, or supply converted assessments (${currency} vs ${scale})`,
        path: 'economicImpact.currency',
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

const exposureOf = (exception: Exception, scaleAmountMinor: number): Rational => {
  const amount = exception.economicImpact.amountMinor;
  if (amount === null || amount <= 0) return RATIONAL_ZERO;
  return minRationals(
    RATIONAL_ONE,
    reduceExceptionRational({ numerator: amount, denominator: scaleAmountMinor }),
  );
};

const scoreOf = (exception: Exception, weights: PriorityWeights): PriorityScore => {
  const severityRank = severityRankOf(exception.severity.level);
  const severityComponent: SeverityScoreComponent = {
    weight: weights.severityWeight,
    level: exception.severity.level,
    rank: severityRank,
    contribution: multiplyRationals(weights.severityWeight, severityRank),
  };
  const exposure = exposureOf(exception, weights.economicScale.amountMinor);
  const economicComponent: EconomicScoreComponent = {
    weight: weights.economicWeight,
    exposure,
    contribution: multiplyRationals(weights.economicWeight, exposure),
    amountMinor: exception.economicImpact.amountMinor,
    currency: exception.economicImpact.currency,
    assessmentIds: [...exception.economicImpact.assessmentIds],
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

const firstAffectedOrder = (left: Exception, right: Exception): number => {
  const leftFirst = left.affected[0];
  const rightFirst = right.affected[0];
  if (leftFirst === undefined && rightFirst === undefined) return 0;
  if (leftFirst === undefined) return 1;
  if (rightFirst === undefined) return -1;
  if (leftFirst.entityKind !== rightFirst.entityKind) {
    return leftFirst.entityKind < rightFirst.entityKind ? -1 : 1;
  }
  if (leftFirst.entityId !== rightFirst.entityId) {
    return leftFirst.entityId < rightFirst.entityId ? -1 : 1;
  }
  return 0;
};

/**
 * THE comparator of the stable priority order (a TOTAL order):
 * total score desc → severity level desc → economic amount desc (null
 * last) → kind asc → first affected entity asc → exception id asc.
 */
export const compareRankedPriority = (
  left: { readonly exception: Exception; readonly score: PriorityScore },
  right: { readonly exception: Exception; readonly score: PriorityScore },
): number => {
  const total = rationalCompare(right.score.total, left.score.total);
  if (total !== 0) return total;
  const severity =
    severityLevelOrder(right.exception.severity.level) -
    severityLevelOrder(left.exception.severity.level);
  if (severity !== 0) return severity;
  const amount = amountOrder(
    left.exception.economicImpact.amountMinor,
    right.exception.economicImpact.amountMinor,
  );
  if (amount !== 0) return amount;
  if (left.exception.kind !== right.exception.kind) {
    return left.exception.kind < right.exception.kind ? -1 : 1;
  }
  const affected = firstAffectedOrder(left.exception, right.exception);
  if (affected !== 0) return affected;
  if (left.exception.exceptionId !== right.exception.exceptionId) {
    return left.exception.exceptionId < right.exception.exceptionId ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// THE ranking function.
// ---------------------------------------------------------------------------

/**
 * THE deterministic seeded prioritization: rank the exception set into the
 * STABLE priority order (same set → identical ordering, every run, under
 * every input permutation) with the EXPOSED score composition carried on
 * every ranked exception. The seed is the typed weights table
 * (severityWeight, economicWeight, economicScale — all exact rationals /
 * integer minor units; defaults provided). Cross-currency sets are
 * typed-rejected (no FX invention); duplicate exception ids are
 * typed-rejected (an exception set is a set).
 */
export function rankExceptions(
  exceptions: readonly Exception[],
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): Result<readonly RankedException[], DomainError> {
  // 1. The seed must be valid (fail-closed, never a silent default).
  const validWeights = validateWeights(weights);
  if (!validWeights.ok) return validWeights;

  // 2. An exception set is a set (duplicate ids are a caller wiring error).
  const seen = new Set<string>();
  for (const exception of exceptions) {
    if (seen.has(exception.exceptionId)) {
      return fail(duplicateExceptionFailure(exception.exceptionId));
    }
    seen.add(exception.exceptionId);
  }

  // 3. Currency consistency: every money-carrying exception must share the
  //    seed scale's currency (cross-currency prioritization would need FX
  //    rates — an external dependency this engine never invents).
  for (const exception of exceptions) {
    const currency = exception.economicImpact.currency;
    if (currency !== null && currency !== weights.economicScale.currency) {
      return fail(
        currencyFailure(
          exception.exceptionId,
          currency,
          weights.economicScale.currency,
        ),
      );
    }
  }

  // 4. Score + order (the comparator is total, so the sort is stable by
  //    construction and input-permutation independent).
  const scored = exceptions.map((exception) => ({
    exception,
    score: scoreOf(exception, weights),
  }));
  const ordered = [...scored].sort(compareRankedPriority);
  const ranked: RankedException[] = ordered.map((entry, index) => ({
    rank: index + 1,
    exception: entry.exception,
    score: entry.score,
  }));
  return ok(ranked);
}
