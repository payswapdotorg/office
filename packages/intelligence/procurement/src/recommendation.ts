// Office intelligence — THE deterministic recommendation pass (OFF-034).
//
// detectProcurementRecommendations() is THE procurement scan engine: the
// cost domain's typed read surface (the budget of record + the incumbent
// commitments — consumed through the domain's OWN derived reads only) + the
// quoted fulfillment alternatives (the fail-closed parsed input contract)
// + the margin engine's ImpactAssessment values (the projected economic
// impact basis — cited, never re-derived) + the memory engine's outcome
// records and benchmark facts (the historical basis) go in (with the
// caller's authorization and the injected scan identity/clock), the typed
// ProcurementRecommendation set comes out. Same inputs → the
// byte-identical recommendation set, every run (run-twice + shuffled-input
// determinism are the acceptance tests; A7 rebuildability discipline). No
// clock, no randomness, no environment, no AI — the comparison and the
// recommendation rules are pure typed computation.
//
// The scan order is part of the contract:
//   1. the CAPABILITY gate (deny-by-default: a request missing one of the
//      three area read capabilities never reads an input, never compares);
//   2. duplicate input identities are typed invariant violations (an input
//      set is a set);
//   3. STRUCTURAL scope coverage of every input (freeze A12): budgets,
//      commitments, alternatives, assessments, outcomes, and benchmarks
//      outside the caller's execution scope are typed-rejected BEFORE any
//      comparison — cross-tenant inputs never compute, and the rejection
//      never reveals the foreign scope;
//   4. the POLICY gate over every input's resource: records the caller's
//      policy denies are EXCLUDED (the set-query precedent — denied
//      records are never served, never errors);
//   5. structural wiring validation (fail-closed): an alternative naming
//      an unknown incumbent commitment, an unknown outcome reference, a
//      currency foreign to the addressed budget, or a duplicate incumbent
//      re-quote is a typed invariant violation — never a silently-dropped
//      quote;
//   6. only then: the per-need comparison (comparison.ts) + the three
//      recommendation rules (vendor switch, order splitting, timing
//      shift), each a pure function of ONE compared need, emitting at most
//      ONE recommendation per need in the kind precedence order with its
//      FULL evidence chain (A4) and its qualified EvidenceSet (the agents
//      discipline — an empty or out-of-scope set is a typed rejection,
//      never a silently-propagated recommendation).
//
// Recommendation ids are DERIVED from the injected scan identity
// (`<scanId>#<ordinal>` in the canonical emission order: need order, the
// recommendations themselves ordered by the kind precedence; comparisons
// carry the mirrored `<scanId>#c<ordinal>`) — deterministic without any id
// supplier beyond the scan token itself.
import type { Actor, EntityId, EntityRef, EventName, Scope, Timestamp } from '@office/contracts';
import { CHANGE_EVENT_RAISED_EVENT } from '@office/intelligence-margin';
import type { ImpactAssessment } from '@office/intelligence-margin';
import type { Benchmark, BenchmarkId, OutcomeRecord, Rational } from '@office/intelligence-memory';
import type { BudgetState, CommitmentState } from '@office/domain-cost';
import { budgetBasisOf } from '@office/domain-cost';
import type { EvidenceItem, EvidenceQuery, EvidenceSet } from '@office/agents';
import { checkScopeCoversResource, resourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import {
  BUDGET_KIND,
  CHANGE_EVENT_KIND,
  COMMITMENT_KIND,
  COST_ITEM_KIND,
  PROJECT_KIND,
  compareReferencedRecords,
  procurementRationalOf,
  rationalCompare,
} from './model';
import type {
  EconomicImpactComponent,
  ProducingLedgerEventId,
  ProcurementEconomicImpact,
  ProcurementEvidence,
  ProcurementHistoricalBasis,
  ProcurementRiskFactor,
} from './model';
import {
  PROCUREMENT_ENGINE,
  budgetOfRecordFor,
  buildVendorComparison,
  procurementCurrencyOf,
  procurementNeedsOf,
} from './comparison';
import type {
  ProcurementAlternative,
  ProcurementNeed,
  VendorComparison,
  VendorComparisonRow,
} from './comparison';
import { checkProcurementCapabilities, checkProcurementPolicy, checkProcurementScopeCovers } from './authorization';
import type { ProcurementAuthorization } from './authorization';
import type { ProcurementKind, ProcurementScanId, RecommendationId, VendorKey } from './vocabulary';

// ---------------------------------------------------------------------------
// The typed inputs of one procurement scan.
// ---------------------------------------------------------------------------

/** The typed inputs of one procurement detection scan (all authorization-filtered). */
export interface ProcurementScanInputs {
  /**
   * The cost domain's typed read surface — the budgets of record (the
   * basis-of-record cost items the needs' scope anchors and price-basis
   * risk factors derive from). Read-only states: the engine never mutates
   * them and never calls a domain transition.
   */
  readonly budgets: readonly BudgetState[];
  /** The incumbent commitments — the canonical obligations being compared. */
  readonly commitments: readonly CommitmentState[];
  /**
   * The quoted fulfillment alternatives (the comparison surface): each
   * vendor's typed quote for (part of) a need, including the incumbent
   * vendor's own current quote (the price and lead-time baseline).
   */
  readonly alternatives: readonly ProcurementAlternative[];
  /**
   * The margin engine's ImpactAssessment values — the projected economic
   * impact basis every recommendation cites (each assessment is itself an
   * authorization-filtered projection of one source change event; the
   * engine references its numbers, it never re-derives them).
   */
  readonly assessments: readonly ImpactAssessment[];
  /**
   * The memory engine's outcome records — the completed-project history
   * the vendor-performance ratings derive from (the historical basis).
   */
  readonly outcomes: readonly OutcomeRecord[];
  /** The memory engine's benchmark facts — the calibration + gating basis. */
  readonly benchmarks: readonly Benchmark[];
}

/** The injected deterministic parts of one scan (identity + clock). */
export interface ScanParts {
  /** The caller-supplied deterministic scan identity. */
  readonly scanId: ProcurementScanId;
  /** When the scan runs (injected clock). */
  readonly detectedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// The typed thresholds + gates of the recommendation rules (documentation
// constants — the tests pin them; nothing here is tunable at runtime
// because an unexplained knob would be a black box).
// ---------------------------------------------------------------------------

/**
 * The minimum saving share (over the incumbent path) a vendor switch must
 * reach to be worth a recommendation: 1/40 (2.5%) — below it the switch is
 * noise, not an optimization.
 */
export const SWITCH_MIN_SAVING_SHARE: Rational = { numerator: 1, denominator: 40 };

/**
 * The minimum lead-time gain (whole days over the incumbent vendor's own
 * re-quote) a timing shift must reach: 10 days — below it the delivery
 * dimension is not the driver of the recommendation.
 */
export const TIMING_MIN_LEAD_GAIN_DAYS = 10;

/**
 * The minimum assessed program-duration delta (whole days) a timing shift
 * responds to: 1 day — a need with no assessed schedule impact has no
 * timing angle.
 */
export const TIMING_MIN_ASSESSED_DELAY_DAYS = 1;

// ---------------------------------------------------------------------------
// Fail-closed scan rejections.
// ---------------------------------------------------------------------------

const scanContext = (authorization: ProcurementAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

const crossScopeInputRejection = (authorization: ProcurementAuthorization): DomainError =>
  domainError(
    'unauthorized',
    'procurement scan inputs carry records outside the caller\u2019s scope: cross-scope inputs are typed-rejected before any comparison (freeze A12)',
    [
      {
        code: 'procurement-input-scope',
        message: 'cross-scope scan inputs are typed-rejected (freeze A12)',
        path: null,
      },
    ],
    scanContext(authorization),
  );

const duplicateInputRejection = (
  family: string,
  id: string,
  authorization: ProcurementAuthorization,
): DomainError =>
  domainError(
    'invariant-violation',
    `the scan input set contains a duplicate ${family} ${id}: an input set is a set`,
    [{ code: 'duplicate-input', message: id, path: family }],
    scanContext(authorization),
  );

const wiringFailure = (
  code: string,
  message: string,
  authorization: ProcurementAuthorization,
): DomainError =>
  domainError(
    'invariant-violation',
    `the procurement scan inputs are structurally inconsistent: ${message}`,
    [{ code, message, path: 'alternatives' }],
    scanContext(authorization),
  );

// ---------------------------------------------------------------------------
// THE evidence-set qualification gate (the agents discipline — freeze A4).
// ---------------------------------------------------------------------------

/** The tool name the procurement detection cites as every item's retrieval provenance. */
export const PROCUREMENT_DETECTION_TOOL = 'procurement-recommendation-detection';

/** The typed rejection of an empty evidence set (mirrors the agents gate). */
const emptyEvidenceSetFailure = (context?: DomainErrorContext): DomainError =>
  domainError(
    'invariant-violation',
    'a consequential procurement recommendation requires a non-empty evidence set (freeze A4)',
    [
      {
        code: 'empty-evidence-set',
        message: 'the recommendation grounded on no evidence; unqualified recommendations are typed-rejected',
        path: 'evidenceSet',
      },
    ],
    context,
  );

/** The typed rejection of one out-of-scope or entity-less evidence item. */
const unqualifiedEvidenceItemFailure = (
  ref: string,
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'unauthorized',
    `evidence item '${ref}' is unqualified: ${reason} (freeze A12/A4)`,
    [
      {
        code: 'evidence-scope-violation',
        message: reason,
        path: 'evidenceSet',
      },
    ],
    context,
  );

/**
 * THE structural evidence gate (freeze A4, mirroring the agents runtime's
 * qualifyEvidenceSet discipline and the landed peers' gates): is this
 * EvidenceSet QUALIFIED to ground a consequential procurement
 * recommendation? A qualified set is non-empty AND entirely covered by the
 * scan's scope (structural A12: every item's scope passes the same
 * checkScopeCoversResource every module uses — cross-tenant/cross-project
 * or entity-less items are typed rejections, never silently-dropped or
 * silently-trusted evidence).
 */
export function qualifyProcurementEvidenceSet(
  set: EvidenceSet,
  scanScope: Scope,
  context?: DomainErrorContext,
): Result<true, DomainError> {
  if (set.items.length === 0) {
    return fail(emptyEvidenceSetFailure(context));
  }
  for (const item of set.items) {
    if (item.entity === null) {
      return fail(
        unqualifiedEvidenceItemFailure(
          item.ref,
          'the item carries no entity reference to scope-check',
          context,
        ),
      );
    }
    const covered = checkScopeCoversResource(
      scanScope,
      resourceScope({
        scope: item.scope,
        resourceKind: item.entity.entityKind,
        resourceId: item.entity.entityId,
        ownerId: null,
      }),
      context,
    );
    if (!covered.ok) {
      return fail(
        unqualifiedEvidenceItemFailure(
          item.ref,
          'the item is outside the scan\u2019s scope and cannot ground a consequential recommendation',
          context,
        ),
      );
    }
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// THE recommendation record.
// ---------------------------------------------------------------------------

/** The schema version of the ProcurementRecommendation model (bump on shape change). */
export const RECOMMENDATION_SCHEMA_VERSION = 1;

/**
 * The primary producing source of a recommendation (the A3 causation
 * anchor of the emitted procurement event): the
 * `contracts.changeEventRaised` event the producing assessment assessed —
 * the change that created the procurement need.
 */
export interface ProcurementPrimarySource {
  /** The ledger id of the primary producing event. */
  readonly eventId: ProducingLedgerEventId;
  /** The primary producing event's name ('contracts.changeEventRaised'). */
  readonly eventName: EventName;
  /** The primary producing event's occurred-at time. */
  readonly occurredAt: Timestamp;
  /** The correlation id of the primary source's causal chain (A3 carry-over). */
  readonly correlationId: string;
}

/** The detection provenance of one procurement recommendation (A4). */
export interface DetectionProvenance {
  /** The scan that produced this recommendation (the injected scan identity). */
  readonly scanId: ProcurementScanId;
  /** When the scan ran (injected clock — never wall time). */
  readonly detectedAt: Timestamp;
  /** The consumed inputs' shape (the admitted, policy-filtered set). */
  readonly consumed: {
    readonly budgetCount: number;
    readonly commitmentCount: number;
    readonly alternativeCount: number;
    readonly assessmentCount: number;
    readonly outcomeCount: number;
    readonly benchmarkCount: number;
  };
}

/** One selected fulfillment alternative of a recommendation (cited). */
export interface SelectedAlternative {
  /** The selected quote's identity. */
  readonly alternativeId: string;
  /** The selected vendor's generic key. */
  readonly vendorKey: VendorKey;
  /** The selected quote's normalized comparable amount (cited from the quote). */
  readonly normalizedAmountMinor: number;
}

/**
 * THE procurement recommendation: a detected optimization opportunity —
 * deterministic, versioned, evidence-chained. Every claim (kind, selected
 * alternatives, projected impact, historical basis, risk factors) carries
 * the source references that produced it; the detection provenance names
 * the scan and its injected timestamp. Recommendations are PROJECTIONS +
 * SUGGESTIONS (A2/A7): the same scan inputs always reproduce the identical
 * recommendation set, and the engine never commits a procurement decision
 * from one (see proposal.ts).
 */
export interface ProcurementRecommendation {
  /** The scan-derived identity (deterministic given the scan identity). */
  readonly recommendationId: RecommendationId;
  /** The model schema version of this recommendation. */
  readonly recommendationVersion: typeof RECOMMENDATION_SCHEMA_VERSION;
  /** The source identity of the detecting engine (A4). */
  readonly engine: typeof PROCUREMENT_ENGINE;
  /** When the recommendation was detected (injected clock — never wall time). */
  readonly detectedAt: Timestamp;
  /** The actor the scan ran for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the recommendation was detected under (the need's scope, A12). */
  readonly scope: Scope;
  /** The detected optimization's kind (closed vocabulary). */
  readonly kind: ProcurementKind;
  /** The deterministic human-readable summary of the optimization. */
  readonly title: string;
  /** The vendor comparison the recommendation was detected over (embedded). */
  readonly comparison: VendorComparison;
  /** The selected fulfillment alternatives (the recommended composition), canonical order. */
  readonly selectedAlternatives: readonly SelectedAlternative[];
  /** The referenced canonical cost-domain records, canonical order. */
  readonly referencedRecords: readonly EntityRef[];
  /** The projected economic impact (cited components + referenced assessments). */
  readonly projectedImpact: ProcurementEconomicImpact;
  /** The historical basis (referenced outcome + benchmark facts). */
  readonly historicalBasis: ProcurementHistoricalBasis;
  /** The recommendation-level typed risk factors (the selection's risks). */
  readonly riskFactors: readonly ProcurementRiskFactor[];
  /**
   * THE evidence chain acceptance: every source record/event/assessment/
   * outcome/benchmark reference behind any claim of this recommendation,
   * deduplicated and in canonical order — every reference resolves to a
   * producing source record (A4).
   */
  readonly evidence: readonly ProcurementEvidence[];
  /**
   * THE complete evidence set (the agents discipline): the qualified,
   * non-empty EvidenceSet the recommendation grounds its consequential
   * suggestion on — an empty or out-of-scope set is a typed rejection
   * (the qualification gate above).
   */
  readonly evidenceSet: EvidenceSet;
  /** The detection provenance (scan id, injected timestamp, consumed shape). */
  readonly provenance: DetectionProvenance;
  /** The primary producing event (the A3 causation anchor of the detection). */
  readonly primarySource: ProcurementPrimarySource;
}

// ---------------------------------------------------------------------------
// The evidence-set items (the agents-typed bundle every recommendation carries).
// ---------------------------------------------------------------------------

const assessmentItemOf = (
  assessment: ImpactAssessment,
  detectedAt: Timestamp,
): EvidenceItem => {
  const query: EvidenceQuery = {
    kind: 'margin-assessment',
    assessmentId: assessment.assessmentId,
  };
  return {
    kind: 'margin-assessment',
    ref: assessment.assessmentId,
    entity: {
      entityKind: CHANGE_EVENT_KIND,
      entityId: assessment.source.changeEventId,
    },
    scope: assessment.scope,
    confidence: assessment.confidence.level,
    retrieval: { tool: PROCUREMENT_DETECTION_TOOL, query, retrievedAt: detectedAt },
  };
};

const outcomeItemOf = (outcome: OutcomeRecord, detectedAt: Timestamp): EvidenceItem => {
  const query: EvidenceQuery = {
    kind: 'memory-outcomes',
    projectId: outcome.scope.kind === 'project' ? outcome.scope.projectId : null,
  };
  return {
    kind: 'memory-outcome',
    ref: outcome.outcomeId,
    entity: {
      entityKind: PROJECT_KIND,
      entityId: outcome.projectId,
    },
    scope: outcome.scope,
    confidence: 'high',
    retrieval: { tool: PROCUREMENT_DETECTION_TOOL, query, retrievedAt: detectedAt },
  };
};

/** Build the recommendation's complete EvidenceSet (assessment + outcomes, canonical order). */
const evidenceSetOf = (
  assessment: ImpactAssessment,
  outcomes: readonly OutcomeRecord[],
  detectedAt: Timestamp,
): EvidenceSet => {
  const ordered = [...outcomes].sort((left, right) =>
    left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0,
  );
  return {
    items: [
      assessmentItemOf(assessment, detectedAt),
      ...ordered.map((outcome) => outcomeItemOf(outcome, detectedAt)),
    ],
  };
};

// ---------------------------------------------------------------------------
// The projected economic impact — THE cited, exposed composition.
// ---------------------------------------------------------------------------

/**
 * Build the projected economic impact of one recommendation: the projected
 * committed-cost delta of adopting the selected fulfillment against the
 * incumbent path, composed of the CITED components — the incumbent
 * commitment's current amount (released, negative), the producing
 * assessment's own budget-revision delta (adjusted, negative), and each
 * selected alternative's normalized price (engaged, positive). The
 * composition is EXPOSED and hand-recomputable: the components' signed sum
 * IS the projected delta, and the assessment-cited component's amount is
 * the referenced assessment's OWN recorded value (referenced, never
 * re-derived).
 */
const economicImpactOf = (
  need: ProcurementNeed,
  selected: readonly SelectedAlternative[],
): ProcurementEconomicImpact => {
  const components: EconomicImpactComponent[] = [
    {
      role: 'incumbent-commitment-release',
      amountMinor: -need.incumbentAmountMinor,
      citedFrom: 'commitment-current-amount',
      assessmentId: null,
      alternativeId: null,
    },
    {
      role: 'assessed-delta-adjustment',
      amountMinor: -need.assessedDeltaMinor,
      citedFrom: 'assessment-cost-impact-budget-revision-delta',
      assessmentId: need.assessment.assessmentId,
      alternativeId: null,
    },
    ...selected.map((alternative) => ({
      role: 'alternative-engage' as const,
      amountMinor: alternative.normalizedAmountMinor,
      citedFrom: 'alternative-normalized-price' as const,
      assessmentId: null,
      alternativeId: alternative.alternativeId,
    })),
  ];
  const projectedDeltaMinor = components.reduce((sum, component) => sum + component.amountMinor, 0);
  return {
    projectedDeltaMinor,
    currency: need.currency,
    components,
    assessmentIds: [...need.assessmentIds],
  };
};

// ---------------------------------------------------------------------------
// THE three recommendation rules. Each rule is a pure function of ONE
// compared need (+ its vendor comparison) into at most one recommendation
// of its kind; the kind precedence is the vocabulary order (vendor switch
// → order splitting → timing shift), and at most ONE recommendation is
// emitted per need.
// ---------------------------------------------------------------------------

/** The benchmark's schedule-variance p90 calibration fact (first benchmark, canonical id order). */
const scheduleVarianceBenchmarkOf = (
  benchmarks: readonly Benchmark[],
): { readonly benchmarkId: BenchmarkId; readonly percentile90: Rational } | null => {
  const ordered = [...benchmarks].sort((left, right) =>
    left.benchmarkId < right.benchmarkId ? -1 : left.benchmarkId > right.benchmarkId ? 1 : 0,
  );
  for (const benchmark of ordered) {
    const metric = benchmark.metrics.find((candidate) => candidate.kind === 'schedule-variance-days');
    if (metric !== undefined) {
      return { benchmarkId: benchmark.benchmarkId, percentile90: metric.percentile90 };
    }
  }
  return null;
};

/** The unstamped parts of one detected recommendation (identity comes from the scan). */
interface RecommendationParts {
  readonly kind: ProcurementKind;
  readonly need: ProcurementNeed;
  readonly comparison: VendorComparison;
  readonly selected: readonly SelectedAlternative[];
  readonly title: string;
  readonly historicalBasis: ProcurementHistoricalBasis;
  readonly riskFactors: readonly ProcurementRiskFactor[];
}

interface RuleContext {
  readonly need: ProcurementNeed;
  readonly comparison: VendorComparison;
  readonly basisQuantityMilli: number;
  readonly benchmarks: readonly Benchmark[];
}

const selectedOf = (rows: readonly VendorComparisonRow[]): readonly SelectedAlternative[] =>
  [...rows]
    .sort((left, right) =>
      left.alternativeId < right.alternativeId ? -1 : left.alternativeId > right.alternativeId ? 1 : 0,
    )
    .map((row) => ({
      alternativeId: row.alternativeId,
      vendorKey: row.vendorKey,
      normalizedAmountMinor: row.price.normalizedAmountMinor,
    }));

const singleSourceRiskOf = (
  selected: readonly SelectedAlternative[],
  commitmentId: EntityId,
): ProcurementRiskFactor[] => {
  const vendors = new Set<string>(selected.map((alternative) => alternative.vendorKey));
  const single = selected[0];
  if (vendors.size === 1 && single !== undefined) {
    return [
      {
        kind: 'single-source-concentration',
        vendorKey: single.vendorKey,
        derivedFrom: [{ entityKind: COMMITMENT_KIND, entityId: commitmentId }],
      },
    ];
  }
  return [];
};

/** Rule 1 — vendor switch: a single cheaper quote covering the need's scope. */
const detectVendorSwitch = (context: RuleContext): RecommendationParts | null => {
  const { need, comparison } = context;
  if (need.incumbentPathAmountMinor <= 0) return null;
  const incumbentRequote = comparison.rows.find((row) => row.incumbentVendor);
  if (incumbentRequote === undefined) return null;
  const covering = comparison.rows.filter(
    (row) =>
      !row.incumbentVendor &&
      row.price.quotedQuantityMilli >= context.basisQuantityMilli &&
      row.price.currency === need.currency,
  );
  if (covering.length === 0) return null;
  const cheapest = [...covering].sort((left, right) => {
    if (left.price.normalizedAmountMinor !== right.price.normalizedAmountMinor) {
      return left.price.normalizedAmountMinor < right.price.normalizedAmountMinor ? -1 : 1;
    }
    return left.alternativeId < right.alternativeId ? -1 : left.alternativeId > right.alternativeId ? 1 : 0;
  })[0];
  if (cheapest === undefined) return null;
  // The switch must be PRICE-driven: the alternative undercuts the
  // incumbent vendor's own current quote.
  if (cheapest.price.normalizedAmountMinor >= incumbentRequote.price.normalizedAmountMinor) {
    return null;
  }
  const saving = need.incumbentPathAmountMinor - cheapest.price.normalizedAmountMinor;
  if (saving <= 0) return null;
  const share = procurementRationalOf(saving, need.incumbentPathAmountMinor);
  if (!share.ok) return null;
  if (rationalCompare(share.value, SWITCH_MIN_SAVING_SHARE) < 0) return null;

  const selected = selectedOf([cheapest]);
  return {
    kind: 'vendor-switch',
    need,
    comparison,
    selected,
    title: `Vendor switch: ${cheapest.vendorKey} quotes ${String(cheapest.price.normalizedAmountMinor)} minor units against the ${String(need.incumbentPathAmountMinor)} minor-unit incumbent path on commitment ${String(need.incumbentCommitmentId)}`,
    historicalBasis: {
      outcomeIds: cheapest.performance.outcomeIds,
      benchmarks: [],
    },
    riskFactors: singleSourceRiskOf(selected, need.incumbentCommitmentId),
  };
};

/** Rule 2 — order splitting: a multi-vendor composition covering the need's scope. */
const detectOrderSplitting = (context: RuleContext): RecommendationParts | null => {
  const { need, comparison } = context;
  if (need.incumbentPathAmountMinor <= 0) return null;
  const candidates = comparison.rows
    .filter(
      (row) =>
        !row.incumbentVendor &&
        row.price.currency === need.currency &&
        row.price.quotedQuantityMilli >= 1,
    )
    .sort((left, right) => {
      if (left.price.quotedUnitRateMinor !== right.price.quotedUnitRateMinor) {
        return left.price.quotedUnitRateMinor < right.price.quotedUnitRateMinor ? -1 : 1;
      }
      return left.alternativeId < right.alternativeId ? -1 : left.alternativeId > right.alternativeId ? 1 : 0;
    });
  // Cheapest-first coverage: accumulate quotes until the composition
  // covers the need's budget-basis scope quantity.
  const accumulated: VendorComparisonRow[] = [];
  let coveredQuantity = 0;
  for (const candidate of candidates) {
    if (coveredQuantity >= context.basisQuantityMilli) break;
    accumulated.push(candidate);
    coveredQuantity += candidate.price.quotedQuantityMilli;
  }
  if (accumulated.length < 2) return null;
  const vendors = new Set<string>(accumulated.map((row) => row.vendorKey));
  if (vendors.size < 2) return null;
  const combined = accumulated.reduce(
    (sum, row) => sum + row.price.normalizedAmountMinor,
    0,
  );
  if (combined >= need.incumbentPathAmountMinor) return null;

  const selected = selectedOf(accumulated);
  const outcomeIds = [
    ...new Set(accumulated.flatMap((row) => row.performance.outcomeIds)),
  ].sort();
  return {
    kind: 'order-splitting',
    need,
    comparison,
    selected,
    title: `Order splitting: ${String(accumulated.length)} alternatives of ${String(vendors.size)} vendors fulfill the scope of commitment ${String(need.incumbentCommitmentId)} for ${String(combined)} minor units against the ${String(need.incumbentPathAmountMinor)} minor-unit incumbent path`,
    historicalBasis: {
      outcomeIds,
      benchmarks: [],
    },
    riskFactors: singleSourceRiskOf(selected, need.incumbentCommitmentId),
  };
};

/** Rule 3 — timing shift: a faster quote whose early order beats the assessed delay. */
const detectTimingShift = (context: RuleContext): RecommendationParts | null => {
  const { need, comparison } = context;
  if (need.incumbentPathAmountMinor <= 0) return null;
  const incumbentRequote = comparison.rows.find((row) => row.incumbentVendor);
  if (incumbentRequote === undefined) return null;
  const assessedDelay = need.assessment.scheduleImpact.projectDurationDelta;
  if (assessedDelay < TIMING_MIN_ASSESSED_DELAY_DAYS) return null;
  const faster = comparison.rows
    .filter(
      (row) =>
        !row.incumbentVendor &&
        row.price.currency === need.currency &&
        row.price.quotedQuantityMilli >= context.basisQuantityMilli &&
        row.delivery.leadGainDays >= TIMING_MIN_LEAD_GAIN_DAYS,
    )
    .sort((left, right) => {
      if (left.delivery.leadGainDays !== right.delivery.leadGainDays) {
        return left.delivery.leadGainDays > right.delivery.leadGainDays ? -1 : 1;
      }
      if (left.price.normalizedAmountMinor !== right.price.normalizedAmountMinor) {
        return left.price.normalizedAmountMinor < right.price.normalizedAmountMinor ? -1 : 1;
      }
      return left.alternativeId < right.alternativeId ? -1 : left.alternativeId > right.alternativeId ? 1 : 0;
    })[0];
  if (faster === undefined) return null;
  // The timing shift must be DELIVERY-driven: the faster quote is NOT
  // price-cheaper than the incumbent vendor's own current quote.
  if (faster.price.normalizedAmountMinor < incumbentRequote.price.normalizedAmountMinor) {
    return null;
  }
  const netDelta = faster.price.normalizedAmountMinor - need.incumbentPathAmountMinor;
  if (netDelta >= 0) return null;

  const selected = selectedOf([faster]);
  // The benchmark calibration: an assessed impact beyond the benchmarked
  // p90 schedule-variance envelope cites the benchmark fact.
  const benchmark = scheduleVarianceBenchmarkOf(context.benchmarks);
  const assessedDelayRational = { numerator: assessedDelay, denominator: 1 } as Rational;
  const beyondBenchmark =
    benchmark !== null && rationalCompare(assessedDelayRational, benchmark.percentile90) > 0;
  return {
    kind: 'timing-shift',
    need,
    comparison,
    selected,
    title: `Timing shift: ${faster.vendorKey} delivers ${String(faster.delivery.leadTimeDays)} days against the incumbent re-quote\u2019s ${String(incumbentRequote.delivery.leadTimeDays)}, avoiding ${String(-netDelta)} minor units of the assessed impact on commitment ${String(need.incumbentCommitmentId)}`,
    historicalBasis: {
      outcomeIds: faster.performance.outcomeIds,
      benchmarks:
        benchmark !== null && beyondBenchmark
          ? [{ benchmarkId: benchmark.benchmarkId, metricKind: 'schedule-variance-days' }]
          : [],
    },
    riskFactors: singleSourceRiskOf(selected, need.incumbentCommitmentId),
  };
};

// ---------------------------------------------------------------------------
// THE scan engine.
// ---------------------------------------------------------------------------

/**
 * THE deterministic detection pass: compare the quoted fulfillment
 * alternatives of every admitted procurement need and detect the typed
 * recommendation set. Runs the fixed gate order (capability → duplicate →
 * A12 scope → policy → structural wiring → comparison + rules → the A4
 * evidence-set qualification), derives every identity from the injected
 * scan identity, and returns the recommendations in the canonical emission
 * order. Pure: the same inputs + authorization + scan identity ALWAYS
 * produce the byte-identical recommendation set.
 */
export function detectProcurementRecommendations(
  inputs: ProcurementScanInputs,
  authorization: ProcurementAuthorization,
  parts: ScanParts,
): Result<readonly ProcurementRecommendation[], DomainError> {
  // 1. Capability gate — before ANY input is read.
  const capabilities = checkProcurementCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  // 2. Duplicate input identities are a caller wiring error (a set is a set).
  const seenBudgetIds = new Set<string>();
  for (const budget of inputs.budgets) {
    if (seenBudgetIds.has(budget.entityId)) {
      return fail(duplicateInputRejection('budget', budget.entityId, authorization));
    }
    seenBudgetIds.add(budget.entityId);
  }
  const seenCommitmentIds = new Set<string>();
  for (const commitment of inputs.commitments) {
    if (seenCommitmentIds.has(commitment.entityId)) {
      return fail(duplicateInputRejection('commitment', commitment.entityId, authorization));
    }
    seenCommitmentIds.add(commitment.entityId);
  }
  const seenAlternativeIds = new Set<string>();
  for (const alternative of inputs.alternatives) {
    if (seenAlternativeIds.has(alternative.alternativeId)) {
      return fail(
        duplicateInputRejection('alternative', alternative.alternativeId, authorization),
      );
    }
    seenAlternativeIds.add(alternative.alternativeId);
  }
  const seenAssessmentIds = new Set<string>();
  for (const assessment of inputs.assessments) {
    if (seenAssessmentIds.has(assessment.assessmentId)) {
      return fail(
        duplicateInputRejection('assessment', assessment.assessmentId, authorization),
      );
    }
    seenAssessmentIds.add(assessment.assessmentId);
  }
  const seenOutcomeIds = new Set<string>();
  for (const outcome of inputs.outcomes) {
    if (seenOutcomeIds.has(outcome.outcomeId)) {
      return fail(duplicateInputRejection('outcome', outcome.outcomeId, authorization));
    }
    seenOutcomeIds.add(outcome.outcomeId);
  }
  const seenBenchmarkIds = new Set<string>();
  for (const benchmark of inputs.benchmarks) {
    if (seenBenchmarkIds.has(benchmark.benchmarkId)) {
      return fail(duplicateInputRejection('benchmark', benchmark.benchmarkId, authorization));
    }
    seenBenchmarkIds.add(benchmark.benchmarkId);
  }

  // 3. Structural scope coverage of every input (A12 — typed rejection,
  //    never an existence oracle: the rejection never names the foreign scope).
  for (const budget of inputs.budgets) {
    const covered = checkProcurementScopeCovers(authorization, {
      scope: budget.scope,
      entityKind: BUDGET_KIND,
      entityId: budget.entityId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const commitment of inputs.commitments) {
    const covered = checkProcurementScopeCovers(authorization, {
      scope: commitment.scope,
      entityKind: COMMITMENT_KIND,
      entityId: commitment.entityId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const alternative of inputs.alternatives) {
    const covered = checkProcurementScopeCovers(authorization, {
      scope: alternative.scope,
      entityKind: PROJECT_KIND,
      entityId: alternative.scope.kind === 'project' ? alternative.scope.projectId : null,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const assessment of inputs.assessments) {
    const covered = checkProcurementScopeCovers(authorization, {
      scope: assessment.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: assessment.source.changeEventId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const outcome of inputs.outcomes) {
    const covered = checkProcurementScopeCovers(authorization, {
      scope: outcome.scope,
      entityKind: PROJECT_KIND,
      entityId: outcome.projectId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const benchmark of inputs.benchmarks) {
    const covered = checkProcurementScopeCovers(authorization, {
      scope: benchmark.scope,
      entityKind: PROJECT_KIND,
      entityId: null,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }

  // 4. Policy exclusion: records the caller's policy denies are invisible
  //    to this scan (the set-query precedent — never errors, never served).
  const policyAdmits = (resource: {
    readonly scope: Scope;
    readonly entityKind: Parameters<typeof checkProcurementPolicy>[1]['entityKind'];
    readonly entityId: EntityId | null;
  }): boolean => checkProcurementPolicy(authorization, resource).ok;

  const admittedBudgets = inputs.budgets.filter((budget) =>
    policyAdmits({ scope: budget.scope, entityKind: BUDGET_KIND, entityId: budget.entityId }),
  );
  const admittedCommitments = inputs.commitments.filter((commitment) =>
    policyAdmits({
      scope: commitment.scope,
      entityKind: COMMITMENT_KIND,
      entityId: commitment.entityId,
    }),
  );
  const admittedAlternatives = inputs.alternatives.filter((alternative) =>
    policyAdmits({
      scope: alternative.scope,
      entityKind: PROJECT_KIND,
      entityId: alternative.scope.kind === 'project' ? alternative.scope.projectId : null,
    }),
  );
  const admittedAssessments = inputs.assessments.filter((assessment) =>
    policyAdmits({
      scope: assessment.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: assessment.source.changeEventId,
    }),
  );
  const admittedOutcomes = inputs.outcomes.filter((outcome) =>
    policyAdmits({ scope: outcome.scope, entityKind: PROJECT_KIND, entityId: outcome.projectId }),
  );
  const admittedBenchmarks = inputs.benchmarks.filter((benchmark) =>
    policyAdmits({ scope: benchmark.scope, entityKind: PROJECT_KIND, entityId: null }),
  );

  // 5. Structural wiring validation (fail-closed, never silent drops).
  const commitmentOf = new Map<EntityId, CommitmentState>(
    admittedCommitments.map((commitment) => [commitment.entityId, commitment] as const),
  );
  // The budget of record of every commitment: the budget whose basis of
  // record CONTAINS the commitment's current line cost items (the domain's
  // own wiring — several budgets of record may live in one project, so the
  // project alone does not identify the budget of record; canonical budget
  // order keeps the resolution input-order independent).
  const budgetOfCommitment = new Map<EntityId, BudgetState>();
  for (const commitment of admittedCommitments) {
    const budget = budgetOfRecordFor(admittedBudgets, commitment);
    if (budget !== undefined) {
      budgetOfCommitment.set(commitment.entityId, budget);
    }
  }
  for (const alternative of admittedAlternatives) {
    if (
      alternative.incumbentCommitmentId !== null &&
      !commitmentOf.has(alternative.incumbentCommitmentId)
    ) {
      return fail(
        wiringFailure(
          'unknown-incumbent-commitment',
          `alternative ${alternative.alternativeId} names incumbent commitment ${String(alternative.incumbentCommitmentId)} which is not part of the scan input set`,
          authorization,
        ),
      );
    }
    const addressedBudget =
      alternative.incumbentCommitmentId === null
        ? undefined
        : budgetOfCommitment.get(alternative.incumbentCommitmentId);
    if (
      addressedBudget !== undefined &&
      alternative.currency !== procurementCurrencyOf(addressedBudget.currency)
    ) {
      return fail(
        wiringFailure(
          'alternative-currency-mismatch',
          `alternative ${alternative.alternativeId} quotes ${alternative.currency} while its addressed budget is ${addressedBudget.currency} — the engine never invents FX (rank per currency or supply converted quotes)`,
          authorization,
        ),
      );
    }
    for (const outcomeId of alternative.outcomeIds) {
      if (!admittedOutcomes.some((outcome) => outcome.outcomeId === outcomeId)) {
        return fail(
          wiringFailure(
            'unknown-vendor-history-outcome',
            `alternative ${alternative.alternativeId} references outcome ${outcomeId} which is not part of the scan input set`,
            authorization,
          ),
        );
      }
    }
  }

  // 6. The needs: every admitted commitment that carries a producing
  //    assessment (canonical commitment order — input order never matters).
  const needs = procurementNeedsOf(admittedBudgets, admittedCommitments, admittedAssessments);
  const outcomesOf = new Map<string, OutcomeRecord>(
    admittedOutcomes.map((outcome) => [outcome.outcomeId, outcome] as const),
  );
  const alternativesOfNeed = new Map<EntityId, ProcurementAlternative[]>();
  for (const need of needs) {
    const list = admittedAlternatives
      .filter(
        (alternative) => alternative.incumbentCommitmentId === need.incumbentCommitmentId,
      )
      .sort((left, right) =>
        left.alternativeId < right.alternativeId
          ? -1
          : left.alternativeId > right.alternativeId
            ? 1
            : 0,
      );
    alternativesOfNeed.set(need.incumbentCommitmentId, list);
  }
  // Exactly one incumbent re-quote per compared need (the baseline).
  for (const need of needs) {
    const requotes = (alternativesOfNeed.get(need.incumbentCommitmentId) ?? []).filter(
      (alternative) => alternative.incumbentVendor,
    );
    if (requotes.length > 1) {
      return fail(
        wiringFailure(
          'duplicate-incumbent-quote',
          `the need of commitment ${String(need.incumbentCommitmentId)} carries ${String(requotes.length)} incumbent vendor re-quotes: exactly one baseline quote is required`,
          authorization,
        ),
      );
    }
  }

  // 7. THE comparison + recommendation rules — canonical need order, the
  //    kind precedence (vendor switch → order splitting → timing shift);
  //    the ordinal stamping is pure array order (deterministic,
  //    input-order independent because the iteration orders are canonical).
  const detected: RecommendationParts[] = [];
  for (const need of needs) {
    const commitment = commitmentOf.get(need.incumbentCommitmentId);
    const budget = budgetOfCommitment.get(need.incumbentCommitmentId);
    if (commitment === undefined || budget === undefined) continue;
    const basisItems = budgetBasisOf(budget);
    const basisItem = basisItems.find((item) => item.entityId === need.costItemId);
    if (basisItem === undefined) continue;
    const needAlternatives = alternativesOfNeed.get(need.incumbentCommitmentId) ?? [];
    if (needAlternatives.length === 0) continue;
    const comparisonId = `${parts.scanId}#c${String(detected.length + 1).padStart(4, '0')}` as VendorComparison['comparisonId'];
    const comparison = buildVendorComparison({
      need,
      budget,
      basisItem,
      commitment,
      alternatives: needAlternatives,
      outcomesOf,
      benchmarks: admittedBenchmarks,
      comparisonId,
      detectedAt: parts.detectedAt,
      actor: authorization.context.actor,
    });
    if (!comparison.ok) return comparison;
    const context: RuleContext = {
      need,
      comparison: comparison.value,
      basisQuantityMilli: basisItem.quantityMilli,
      benchmarks: admittedBenchmarks,
    };
    const rules: readonly ((ruleContext: RuleContext) => RecommendationParts | null)[] = [
      detectVendorSwitch,
      detectOrderSplitting,
      detectTimingShift,
    ];
    for (const rule of rules) {
      const result = rule(context);
      if (result !== null) {
        detected.push(result);
        break;
      }
    }
  }

  // 8. Stamp the deterministic identities, then qualify every
  //    recommendation's evidence set (the agents discipline — an empty or
  //    out-of-scope set is a typed rejection, never a silently-propagated
  //    recommendation).
  const consumed = {
    budgetCount: admittedBudgets.length,
    commitmentCount: admittedCommitments.length,
    alternativeCount: admittedAlternatives.length,
    assessmentCount: admittedAssessments.length,
    outcomeCount: admittedOutcomes.length,
    benchmarkCount: admittedBenchmarks.length,
  };
  const recommendations = detected.map((recommendationParts, index) => {
    const recommendationId = `${parts.scanId}#${String(index + 1).padStart(4, '0')}` as RecommendationId;
    const outcomes = recommendationParts.historicalBasis.outcomeIds.map((outcomeId) =>
      outcomesOf.get(outcomeId),
    );
    const historicalOutcomes = outcomes.filter(
      (outcome): outcome is OutcomeRecord => outcome !== undefined,
    );
    const referencedRecords = [
      { entityKind: COMMITMENT_KIND, entityId: recommendationParts.need.incumbentCommitmentId },
      { entityKind: BUDGET_KIND, entityId: recommendationParts.need.budgetId },
      { entityKind: COST_ITEM_KIND, entityId: recommendationParts.need.costItemId },
    ].sort(compareReferencedRecords);
    return {
      recommendationId,
      recommendationVersion: RECOMMENDATION_SCHEMA_VERSION,
      engine: PROCUREMENT_ENGINE,
      detectedAt: parts.detectedAt,
      actor: authorization.context.actor,
      scope: recommendationParts.comparison.scope,
      kind: recommendationParts.kind,
      title: recommendationParts.title,
      comparison: recommendationParts.comparison,
      selectedAlternatives: recommendationParts.selected,
      referencedRecords,
      projectedImpact: economicImpactOf(recommendationParts.need, recommendationParts.selected),
      historicalBasis: recommendationParts.historicalBasis,
      riskFactors: recommendationParts.riskFactors,
      evidence: recommendationParts.comparison.evidence,
      evidenceSet: evidenceSetOf(
        recommendationParts.need.assessment,
        historicalOutcomes,
        parts.detectedAt,
      ),
      provenance: {
        scanId: parts.scanId,
        detectedAt: parts.detectedAt,
        consumed,
      },
      primarySource: {
        eventId: recommendationParts.need.assessment.source.eventId,
        eventName: CHANGE_EVENT_RAISED_EVENT,
        occurredAt: recommendationParts.need.assessment.source.occurredAt,
        correlationId: recommendationParts.need.assessment.source.correlationId,
      },
    } satisfies ProcurementRecommendation;
  });
  for (const recommendation of recommendations) {
    const qualified = qualifyProcurementEvidenceSet(
      recommendation.evidenceSet,
      authorization.context.scope,
      scanContext(authorization),
    );
    if (!qualified.ok) return qualified;
  }
  return ok(recommendations);
}
