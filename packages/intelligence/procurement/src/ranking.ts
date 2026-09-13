// Office intelligence — THE deterministic seeded ranking (OFF-034).
//
// rankProcurementRecommendations() composes the preference score over
// EXACT RATIONALS with the composition EXPOSED on every ranked
// recommendation (the named acceptance — recomputable by hand from the
// model alone, no black boxes):
//
//   preference = economicWeight x min(1, |projectedDelta| / economicScale)
//              + deliveryWeight x min(1, leadGainDays / deliveryScaleDays)
//
// Both components ride CITED numbers: the projected delta is the
// recommendation's own projected economic impact (whose components cite
// the incumbent commitment amount, the producing assessment's own
// budget-revision delta, and each selected alternative's normalized
// price), and the lead-time gain is the delivery comparison's own
// incumbent-baseline difference. The ordering is a TOTAL ORDER, so it is
// stable by construction: the same set yields the identical order under
// every run and every input permutation.
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { EntityRef } from '@office/contracts';
import type { Rational } from '@office/intelligence-memory';
import {
  DEFAULT_PREFERENCE_WEIGHTS,
  PREFERENCE_FORMULA,
  addRationals,
  minRationals,
  multiplyRationals,
  rationalCompare,
  reduceProcurementRational,
  RATIONAL_ONE,
  RATIONAL_ZERO,
} from './model';
import type {
  DeliveryScoreComponent,
  EconomicScoreComponent,
  PreferenceScore,
  PreferenceWeights,
} from './model';
import { PROCUREMENT_KINDS } from './vocabulary';
import type { ProcurementKind } from './vocabulary';
import type { ProcurementRecommendation } from './recommendation';

// ---------------------------------------------------------------------------
// Fail-closed seed + set rejections.
// ---------------------------------------------------------------------------

const invalidWeightsFailure = (reason: string): DomainError =>
  domainError(
    'invariant-violation',
    `the preference weights seed is invalid: ${reason}`,
    [{ code: 'preference-weights-invalid', message: PREFERENCE_FORMULA, path: null }],
  );

const duplicateRecommendationFailure = (recommendationId: string): DomainError =>
  domainError(
    'invariant-violation',
    `the recommendation set contains a duplicate recommendation ${recommendationId}: a recommendation set is a set`,
    [{ code: 'duplicate-recommendation', message: recommendationId, path: null }],
  );

const currencyFailure = (
  recommendationId: string,
  actual: string,
  expected: string,
): DomainError =>
  domainError(
    'invariant-violation',
    `recommendation ${recommendationId} projects ${actual} while the seed economic scale is ${expected}: cross-currency prioritization would need FX rates — an external dependency this engine never invents (rank per currency or supply converted assessments)`,
    [
      {
        code: 'recommendation-currency-consistent',
        message: `${actual} != ${expected}`,
        path: 'economicScale.currency',
      },
    ],
  );

const validateWeights = (weights: PreferenceWeights): Result<true, DomainError> => {
  if (
    weights.economicWeight.denominator <= 0 ||
    weights.deliveryWeight.denominator <= 0 ||
    weights.economicWeight.numerator < 0 ||
    weights.deliveryWeight.numerator < 0
  ) {
    return fail(
      invalidWeightsFailure('both weights must be non-negative exact rationals'),
    );
  }
  if (
    rationalCompare(weights.economicWeight, RATIONAL_ZERO) === 0 &&
    rationalCompare(weights.deliveryWeight, RATIONAL_ZERO) === 0
  ) {
    return fail(invalidWeightsFailure('the weights must not both be zero'));
  }
  if (!Number.isInteger(weights.economicScale.amountMinor) || weights.economicScale.amountMinor <= 0) {
    return fail(invalidWeightsFailure('the economic scale must be a positive integer minor amount'));
  }
  if (!Number.isInteger(weights.deliveryScale.days) || weights.deliveryScale.days <= 0) {
    return fail(invalidWeightsFailure('the delivery scale must be a positive whole-day count'));
  }
  return ok(true);
};

// ---------------------------------------------------------------------------
// The exposure of one ranked component (exact rationals, exposed).
// ---------------------------------------------------------------------------

/** The lead-time gain of one recommendation (the delivery exposure's input). */
export const leadGainDaysOf = (recommendation: ProcurementRecommendation): number => {
  const incumbentLead = recommendation.comparison.rows.find((row) => row.incumbentVendor)
    ?.delivery.leadTimeDays;
  if (incumbentLead === undefined) return 0;
  const selectedIds = new Set<string>(
    recommendation.selectedAlternatives.map((alternative) => alternative.alternativeId),
  );
  const selectedLeads = recommendation.comparison.rows
    .filter((row) => selectedIds.has(row.alternativeId))
    .map((row) => row.delivery.leadTimeDays);
  if (selectedLeads.length === 0) return 0;
  return incumbentLead - Math.max(...selectedLeads);
};

const exposureOf = (amountMinor: number, scale: number): Rational => {
  // A NEGATIVE projected delta (a saving — the normal procurement case) is
  // exposure too: the magnitude is what the scale measures, so only an
  // exactly-zero amount has zero exposure.
  if (amountMinor === 0) return RATIONAL_ZERO;
  return minRationals(
    reduceProcurementRational({ numerator: Math.abs(amountMinor), denominator: scale }),
    RATIONAL_ONE,
  );
};

// ---------------------------------------------------------------------------
// The score composition (pure, exposed).
// ---------------------------------------------------------------------------

const scoreOf = (
  recommendation: ProcurementRecommendation,
  weights: PreferenceWeights,
): PreferenceScore => {
  const economicExposure = exposureOf(
    recommendation.projectedImpact.projectedDeltaMinor,
    weights.economicScale.amountMinor,
  );
  const economicComponent: EconomicScoreComponent = {
    weight: weights.economicWeight,
    exposure: economicExposure,
    contribution: multiplyRationals(weights.economicWeight, economicExposure),
    projectedDeltaMinor: recommendation.projectedImpact.projectedDeltaMinor,
    currency: recommendation.projectedImpact.currency,
    assessmentIds: [...recommendation.projectedImpact.assessmentIds],
  };
  const leadGainDays = leadGainDaysOf(recommendation);
  const deliveryExposure =
    leadGainDays <= 0
      ? RATIONAL_ZERO
      : minRationals(
          reduceProcurementRational({
            numerator: leadGainDays,
            denominator: weights.deliveryScale.days,
          }),
          RATIONAL_ONE,
        );
  const deliveryComponent: DeliveryScoreComponent = {
    weight: weights.deliveryWeight,
    exposure: deliveryExposure,
    contribution: multiplyRationals(weights.deliveryWeight, deliveryExposure),
    leadGainDays,
  };
  return {
    total: addRationals(economicComponent.contribution, deliveryComponent.contribution),
    economic: economicComponent,
    delivery: deliveryComponent,
  };
};

// ---------------------------------------------------------------------------
// The total order (typed tie-breakers — stable by construction).
// ---------------------------------------------------------------------------

const kindOrder = (kind: ProcurementKind): number => {
  const index = (PROCUREMENT_KINDS as readonly string[]).indexOf(kind);
  return index < 0 ? PROCUREMENT_KINDS.length : index;
};

const amountOrder = (left: number, right: number): number => {
  if (left !== right) return Math.abs(left) > Math.abs(right) ? -1 : 1;
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
 * THE comparator of the stable preference order (a TOTAL order):
 * total score desc → |projected delta| desc → lead-time gain desc →
 * kind asc → first referenced record asc → recommendation id asc.
 */
export const compareRankedPreference = (
  left: { readonly recommendation: ProcurementRecommendation; readonly score: PreferenceScore },
  right: { readonly recommendation: ProcurementRecommendation; readonly score: PreferenceScore },
): number => {
  const total = rationalCompare(right.score.total, left.score.total);
  if (total !== 0) return total;
  const amount = amountOrder(
    left.recommendation.projectedImpact.projectedDeltaMinor,
    right.recommendation.projectedImpact.projectedDeltaMinor,
  );
  if (amount !== 0) return amount;
  const leadGain = leadGainDaysOf(right.recommendation) - leadGainDaysOf(left.recommendation);
  if (leadGain !== 0) return leadGain;
  if (left.recommendation.kind !== right.recommendation.kind) {
    return kindOrder(left.recommendation.kind) - kindOrder(right.recommendation.kind);
  }
  const referenced = firstReferencedOrder(
    left.recommendation.referencedRecords[0],
    right.recommendation.referencedRecords[0],
  );
  if (referenced !== 0) return referenced;
  if (left.recommendation.recommendationId !== right.recommendation.recommendationId) {
    return left.recommendation.recommendationId < right.recommendation.recommendationId ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// The ranking function.
// ---------------------------------------------------------------------------

/** One procurement recommendation ranked by the seeded prioritization (the total order). */
export interface RankedRecommendation {
  /** The 1-based position in the stable preference order (identical across runs). */
  readonly rank: number;
  /** The ranked recommendation. */
  readonly recommendation: ProcurementRecommendation;
  /** The exposed preference score (recomputable from the model alone). */
  readonly score: PreferenceScore;
}

/**
 * THE deterministic seeded prioritization: rank the recommendation set
 * into the STABLE preference order (same set → identical ordering, every
 * run, under every input permutation) with the EXPOSED score composition
 * carried on every ranked recommendation. The seed is the typed weights
 * table (economicWeight, deliveryWeight, economicScale, deliveryScale —
 * all exact rationals / integer units; defaults provided). Cross-currency
 * sets are typed-rejected (no FX invention); duplicate recommendation ids
 * are typed-rejected (a recommendation set is a set).
 */
export function rankProcurementRecommendations(
  recommendations: readonly ProcurementRecommendation[],
  weights: PreferenceWeights = DEFAULT_PREFERENCE_WEIGHTS,
): Result<readonly RankedRecommendation[], DomainError> {
  // 1. The seed must be valid (fail-closed, never a silent default).
  const validWeights = validateWeights(weights);
  if (!validWeights.ok) return validWeights;

  // 2. A recommendation set is a set (duplicate ids are a caller wiring error).
  const seen = new Set<string>();
  for (const recommendation of recommendations) {
    if (seen.has(recommendation.recommendationId)) {
      return fail(duplicateRecommendationFailure(recommendation.recommendationId));
    }
    seen.add(recommendation.recommendationId);
  }

  // 3. Currency consistency: every projection must share the seed scale's
  //    currency (cross-currency prioritization would need FX rates — an
  //    external dependency this engine never invents).
  for (const recommendation of recommendations) {
    if (recommendation.projectedImpact.currency !== weights.economicScale.currency) {
      return fail(
        currencyFailure(
          recommendation.recommendationId,
          recommendation.projectedImpact.currency,
          weights.economicScale.currency,
        ),
      );
    }
  }

  // 4. Score + order (the comparator is total, so the sort is stable by
  //    construction and input-permutation independent).
  const scored = recommendations.map((recommendation) => ({
    recommendation,
    score: scoreOf(recommendation, weights),
  }));
  const ordered = [...scored].sort(compareRankedPreference);
  const ranked: RankedRecommendation[] = ordered.map((entry, index) => ({
    rank: index + 1,
    recommendation: entry.recommendation,
    score: entry.score,
  }));
  return ok(ranked);
}
