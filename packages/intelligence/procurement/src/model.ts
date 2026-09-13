// Office intelligence — the procurement recommendation model (OFF-034).
//
// The shared typed model of the procurement optimization engine: the local
// exact-Rational arithmetic (every preference score is an integer-numerator/
// positive-integer-denominator pair — never a float), the A4 evidence chain
// (the discriminated source references that PRODUCED a recommendation's
// claims), the typed price/delivery/vendor-performance/risk comparison parts,
// the projected economic impact (composed of typed components each CITED
// from a referenced commitment amount, a referenced assessment value, or a
// referenced alternative quote — exposed and hand-recomputable), the
// historical basis (referenced outcome + benchmark facts), the exposed
// preference-score composition (the named acceptance: recomputable by hand
// from the model alone), and the ProposedNextAction contract (SUGGESTIONS
// ONLY — the engine has no execution path at all).
//
// The model contains no clock, no randomness, no environment, and no
// entity data beyond ids/refs and the derived numbers: every constructor
// in this package is a PURE function of its typed inputs, so the same
// inputs always produce the byte-identical recommendation set (A7
// rebuildability discipline).
//
// The agents EvidenceSet TYPE discipline (OFF-018) is imported TYPE-ONLY
// from @office/agents: a recommendation carries a complete, qualified
// evidence set (see recommendation.ts's qualifyProcurementEvidenceSet
// gate) — the runtime boundary stays within the engine's own pure
// computation.
import { parseCommandName, parseEntityKind, parseFail, parseOk } from '@office/contracts';
import type {
  Actor,
  CommandName,
  EntityId,
  EntityKind,
  EntityRef,
  EventName,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import type { EvidenceSet } from '@office/agents';
import type { AssessmentId, CurrencyCode, ImpactAssessment } from '@office/intelligence-margin';
import type {
  BenchmarkId,
  BenchmarkMetricKind,
  OutcomeId,
  Rational,
} from '@office/intelligence-memory';
import type { VendorKey } from './vocabulary';
import type { VendorPerformanceLevel } from './vocabulary';

// ---------------------------------------------------------------------------
// Local exact-rational arithmetic (memory's Rational shape, local
// operations — mirroring the landed intelligence peers' discipline).
// ---------------------------------------------------------------------------

/** Add two exact rationals (result reduced to lowest terms). */
export const addRationals = (left: Rational, right: Rational): Rational =>
  reduceProcurementRational({
    numerator:
      left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });

/** Multiply two exact rationals (result reduced to lowest terms). */
export const multiplyRationals = (left: Rational, right: Rational): Rational =>
  reduceProcurementRational({
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  });

/** The smaller of two exact rationals. */
export const minRationals = (left: Rational, right: Rational): Rational =>
  rationalCompare(left, right) <= 0 ? left : right;

/** Compare two exact rationals exactly (BigInt cross-multiplication). */
export const rationalCompare = (left: Rational, right: Rational): number => {
  const l = BigInt(left.numerator) * BigInt(right.denominator);
  const r = BigInt(right.numerator) * BigInt(left.denominator);
  if (l < r) return -1;
  if (l > r) return 1;
  return 0;
};

const gcd = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0 ? 1 : a;
};

/** Reduce one rational to lowest terms (sign in the numerator). */
export const reduceProcurementRational = (value: Rational): Rational => {
  const g = gcd(value.numerator, value.denominator);
  return { numerator: value.numerator / g, denominator: value.denominator / g };
};

/** The zero rational (0/1). */
export const RATIONAL_ZERO: Rational = { numerator: 0, denominator: 1 };
/** The one rational (1/1). */
export const RATIONAL_ONE: Rational = { numerator: 1, denominator: 1 };

/** Build one exact rational (fail-closed on the domain bounds). */
export const procurementRationalOf = (
  numerator: number,
  denominator: number,
): ParseResult<Rational> => {
  const bound = 9007199254740991; // 2^53 - 1
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    Math.abs(numerator) > bound ||
    Math.abs(denominator) > bound ||
    denominator <= 0
  ) {
    return parseFail(
      'invalid-value',
      '',
      `rational: integer numerator and integer denominator 1..${bound}`,
      `rational(${String(numerator)}, ${String(denominator)})`,
    );
  }
  return parseOk(reduceProcurementRational({ numerator, denominator }));
};

// ---------------------------------------------------------------------------
// THE evidence chain — the A4 provenance spine of every procurement
// recommendation. Every claim (kind, price, delivery, performance, risk,
// projected impact, historical basis) cites the canonical cost-domain
// records, the producing ledger events, the margin assessments, and the
// memory outcomes/benchmarks that produced it (discriminated source refs,
// mirroring the landed intelligence peers' evidence discipline — every
// reference resolves to a producing source record).
// ---------------------------------------------------------------------------

/** The ledger event id shape of the producing events (margin's source refs). */
export type ProducingLedgerEventId = ImpactAssessment['source']['eventId'];

/** Reference to one canonical cost-domain record that produced a claim. */
export interface ProcurementRecordSource {
  readonly kind: 'record';
  /** The canonical entity ref of the referenced record. */
  readonly ref: EntityRef;
  /** Which cost-domain aggregate the referenced record is. */
  readonly recordKind: 'budget' | 'cost-item' | 'commitment';
  /** The record's aggregate version at detection time (read surface). */
  readonly version: number;
  /** When the referenced record was created (its own clock, cited). */
  readonly createdAt: Timestamp;
}

/** Reference to the recorded ledger event that produced one claim. */
export interface ProcurementEventSource {
  readonly kind: 'event';
  /** The ledger id of the producing event. */
  readonly eventId: ProducingLedgerEventId;
  /** The producing event's name, e.g. 'contracts.changeEventRaised'. */
  readonly eventName: EventName;
  /** The producing event's occurred-at time. */
  readonly occurredAt: Timestamp;
}

/** Reference to the margin assessment that produced one claim. */
export interface ProcurementAssessmentSource {
  readonly kind: 'assessment';
  /** The assessment's caller-supplied identity. */
  readonly assessmentId: AssessmentId;
  /** When the assessment was produced (injected clock). */
  readonly assessedAt: Timestamp;
  /** Ledger id of the assessed `contracts.changeEventRaised` event. */
  readonly sourceEventId: ProducingLedgerEventId;
  /** The assessed change event entity. */
  readonly changeEventId: EntityId;
  /** The owning contract of the assessed change event. */
  readonly contractId: EntityId;
}

/** Reference to the memory outcome record behind one historical claim. */
export interface ProcurementOutcomeSource {
  readonly kind: 'outcome';
  /** The outcome's caller-supplied identity. */
  readonly outcomeId: OutcomeId;
  /** When the outcome was recorded (injected clock). */
  readonly recordedAt: Timestamp;
  /** The completed project the outcome records. */
  readonly projectId: EntityId;
}

/** Reference to the memory benchmark that calibrated one claim. */
export interface ProcurementBenchmarkSource {
  readonly kind: 'benchmark';
  /** The benchmark's caller-supplied identity. */
  readonly benchmarkId: BenchmarkId;
  /** When the benchmark was computed (injected clock). */
  readonly computedAt: Timestamp;
  /** The metric the calibration compared against. */
  readonly metricKind: BenchmarkMetricKind;
}

/** One provenance reference of a procurement recommendation. */
export type ProcurementEvidence =
  | ProcurementRecordSource
  | ProcurementEventSource
  | ProcurementAssessmentSource
  | ProcurementOutcomeSource
  | ProcurementBenchmarkSource;

/**
 * Canonical evidence order: assessments, then benchmarks, then outcomes,
 * then cost-domain records, then events (by identity within a kind).
 */
export const compareProcurementEvidence = (
  left: ProcurementEvidence,
  right: ProcurementEvidence,
): number => {
  const kindOrder = (evidence: ProcurementEvidence): number => {
    switch (evidence.kind) {
      case 'assessment':
        return 0;
      case 'benchmark':
        return 1;
      case 'outcome':
        return 2;
      case 'record':
        return 3;
      case 'event':
        return 4;
    }
  };
  if (kindOrder(left) !== kindOrder(right)) {
    return kindOrder(left) < kindOrder(right) ? -1 : 1;
  }
  const idOf = (evidence: ProcurementEvidence): string => {
    switch (evidence.kind) {
      case 'assessment':
        return evidence.assessmentId;
      case 'benchmark':
        return evidence.benchmarkId;
      case 'outcome':
        return evidence.outcomeId;
      case 'record':
        return `${evidence.ref.entityKind}:${evidence.ref.entityId}`;
      case 'event':
        return evidence.eventId;
    }
  };
  const leftId = idOf(left);
  const rightId = idOf(right);
  if (leftId !== rightId) {
    return leftId < rightId ? -1 : 1;
  }
  return 0;
};

/** Deduplicate and canonically order procurement evidence references. */
export const canonicalProcurementEvidence = (
  references: readonly ProcurementEvidence[],
): readonly ProcurementEvidence[] => {
  const idOf = (evidence: ProcurementEvidence): string => {
    switch (evidence.kind) {
      case 'assessment':
        return `assessment:${evidence.assessmentId}`;
      case 'benchmark':
        return `benchmark:${evidence.benchmarkId}`;
      case 'outcome':
        return `outcome:${evidence.outcomeId}`;
      case 'record':
        return `record:${evidence.ref.entityKind}:${evidence.ref.entityId}`;
      case 'event':
        return `event:${evidence.eventId}`;
    }
  };
  const byId = new Map<string, ProcurementEvidence>();
  for (const reference of references) {
    if (!byId.has(idOf(reference))) {
      byId.set(idOf(reference), reference);
    }
  }
  return [...byId.values()].sort(compareProcurementEvidence);
};

/** The agents-typed evidence set every recommendation carries (TYPE-ONLY import). */
export type ProcurementEvidenceSet = EvidenceSet;

// ---------------------------------------------------------------------------
// The comparison claim parts — price, delivery, vendor performance, and
// risk, each typed and evidence-chained (never a float, never a manual
// score: every number derives from referenced records).
// ---------------------------------------------------------------------------

/**
 * The price comparison of one quoted alternative: the normalized comparable
 * amount — the EXACT extension of the quoted quantity (integer milli-units)
 * and quoted unit rate (integer minor units per whole unit), the cost
 * domain's own exactness discipline (an extension that does not divide
 * evenly is a typed invariant violation — money is never rounded).
 */
export interface PriceComparison {
  /** The quoted quantity (integer milli-units). */
  readonly quotedQuantityMilli: number;
  /** The quoted unit rate (integer minor units per whole unit). */
  readonly quotedUnitRateMinor: number;
  /** The normalized comparable amount: quantityMilli x unitRateMinor / 1000 (exact). */
  readonly normalizedAmountMinor: number;
  /** The single currency of the quote (every quote of a scan shares it). */
  readonly currency: CurrencyCode;
}

/**
 * The delivery comparison of one quoted alternative: the lead-time
 * comparison against the incumbent vendor's own re-quote (the only honest
 * lead-time baseline — the incumbent commitment itself carries no lead time;
 * the re-quote is a referenced input record).
 */
export interface DeliveryComparison {
  /** The quoted lead time (whole days). */
  readonly leadTimeDays: number;
  /** The incumbent vendor's own quoted lead time (the baseline). */
  readonly incumbentLeadTimeDays: number;
  /** The lead-time gain: incumbent lead time − quoted lead time (may be negative). */
  readonly leadGainDays: number;
}

/**
 * Why the vendor performance level is what it is (stable machine-readable
 * codes — every rating derives from referenced outcome records only).
 */
export type VendorPerformanceReason =
  | 'on-time-share-strong'
  | 'on-time-share-acceptable'
  | 'on-time-share-underperforming'
  | 'no-referenced-outcomes';

/**
 * The vendor-performance rating of one quoted alternative — the historical
 * outcome-derived rating: the on-time share of the vendor's referenced
 * completed-project outcomes (schedule variance <= 0 days), with the exact
 * composition exposed (which outcomes, how many on time, the exact share).
 * 'unrated' when the alternative references no outcome history (a typed
 * absence, never an invented rating).
 */
export interface VendorPerformanceRating {
  /** The typed performance level (the four-level scale). */
  readonly level: VendorPerformanceLevel;
  /** The deterministic rules that produced this level, canonical order. */
  readonly reasons: readonly VendorPerformanceReason[];
  /** The referenced outcome records behind the rating, canonical order. */
  readonly outcomeIds: readonly OutcomeId[];
  /** How many of the referenced outcomes finished on time (variance <= 0). */
  readonly onTimeCount: number;
  /** How many outcome records the rating derived from. */
  readonly totalCount: number;
  /** The exact on-time share (onTimeCount / totalCount; null when unrated). */
  readonly onTimeShare: Rational | null;
}

/**
 * One typed risk factor of a comparison row or a recommendation selection —
 * a derived, evidence-chained condition (never a manual score): each factor
 * carries its deterministic reason and the records it was derived from.
 */
export type ProcurementRiskFactorKind =
  | 'single-source-concentration'
  | 'price-above-budget-basis'
  | 'underperforming-vendor-history'
  | 'no-vendor-history';

/** One typed risk factor (the kind + the deterministic derivation basis). */
export interface ProcurementRiskFactor {
  /** The closed risk-factor vocabulary this factor belongs to. */
  readonly kind: ProcurementRiskFactorKind;
  /** The referenced vendor the factor is about. */
  readonly vendorKey: VendorKey;
  /** The canonical entity refs of the records the factor was derived from. */
  readonly derivedFrom: readonly EntityRef[];
}

// ---------------------------------------------------------------------------
// The projected economic impact — THE named acceptance: referenced
// assessments + an exposed, hand-recomputable composition. Every component
// CITES its producing source through the typed citation vocabulary (a
// referenced commitment's current amount, a referenced assessment's own
// budget-revision delta, or a referenced alternative's normalized price);
// the components' signed sum IS the projected delta — recomputable by hand
// from the model alone (no black boxes, no re-derived numbers).
// ---------------------------------------------------------------------------

/**
 * Where one economic-impact component's amount was CITED from — a typed
 * discriminator proving the number is a reference to an already-recorded
 * value, never a re-derived one.
 */
export type EconomicCitation =
  | 'commitment-current-amount'
  | 'assessment-cost-impact-budget-revision-delta'
  | 'alternative-normalized-price';

/** The role one economic-impact component plays in the projection. */
export type EconomicComponentRole =
  | 'incumbent-commitment-release'
  | 'assessed-delta-adjustment'
  | 'alternative-engage';

/** One exposed component of a projected economic impact (cited + signed). */
export interface EconomicImpactComponent {
  /** The role this component plays in the projection. */
  readonly role: EconomicComponentRole;
  /**
   * The component's signed contribution to the projected delta (integer
   * minor units): the incumbent release and the assessed-delta adjustment
   * enter negative (the incumbent path is avoided), each engaged
   * alternative enters positive.
   */
  readonly amountMinor: number;
  /** The typed citation the amount was referenced through. */
  readonly citedFrom: EconomicCitation;
  /** The cited producing assessment (the assessed-delta component), or null. */
  readonly assessmentId: AssessmentId | null;
  /** The cited alternative (the alternative-price component), or null. */
  readonly alternativeId: string | null;
}

/**
 * The projected economic impact of one procurement recommendation: the
 * projected committed-cost delta of adopting the recommended fulfillment
 * against the incumbent path, composed of typed CITED components (the
 * incumbent commitment's current amount released, the producing
 * assessment's own budget-revision delta adjusted, and each selected
 * alternative's normalized price engaged) — the composition is EXPOSED and
 * hand-recomputable: sum(components) === projectedDeltaMinor, and every
 * assessment-cited component's amount equals the referenced assessment's
 * own recorded value (referenced, never re-derived).
 */
export interface ProcurementEconomicImpact {
  /** The projected delta (signed integer minor units; negative = projected saving). */
  readonly projectedDeltaMinor: number;
  /** The single currency of the projection (the budget's own currency). */
  readonly currency: CurrencyCode;
  /** The exposed composition (signed, cited, canonical order). */
  readonly components: readonly EconomicImpactComponent[];
  /** THE referenced assessments whose values the projection is built on. */
  readonly assessmentIds: readonly AssessmentId[];
}

/** One benchmark fact the historical basis cites. */
export interface HistoricalBenchmarkFact {
  /** The cited benchmark's caller-supplied identity. */
  readonly benchmarkId: BenchmarkId;
  /** The cited metric. */
  readonly metricKind: BenchmarkMetricKind;
}

/**
 * The historical basis of one procurement recommendation: the referenced
 * memory outcome records + benchmark facts the recommendation's
 * vendor-performance ratings and timing calibration are grounded in
 * (completed-project history — referenced facts, never re-derived
 * statistics).
 */
export interface ProcurementHistoricalBasis {
  /** The referenced outcome records, canonical order. */
  readonly outcomeIds: readonly OutcomeId[];
  /** The cited benchmark facts, canonical order. */
  readonly benchmarks: readonly HistoricalBenchmarkFact[];
}

// ---------------------------------------------------------------------------
// Seeded ranking — the EXPOSED preference-score composition (THE named
// acceptance). The preference score of a procurement recommendation is the
// exact-rational composition
//
//   preference = economicWeight x min(1, |projectedDelta| / economicScale)
//              + deliveryWeight x min(1, leadGainDays / deliveryScaleDays)
//
// with every attributable component carried on the ranked recommendation:
// the weights, the economic exposure, the delivery exposure, and both
// contributions — recomputable by hand from the model alone (no black
// boxes).
// ---------------------------------------------------------------------------

/** The exposed formula of the preference score (documentation constant). */
export const PREFERENCE_FORMULA =
  'preference = economicWeight x min(1, |projectedDelta| / economicScale) + deliveryWeight x min(1, leadGainDays / deliveryScaleDays)';

/** The reference money the economic exposure is measured against (the seed). */
export interface EconomicScale {
  /** The scale amount (integer minor units, > 0). */
  readonly amountMinor: number;
  /** The single currency of the scale (every ranked delta must match). */
  readonly currency: CurrencyCode;
}

/** The reference lead-time gain the delivery exposure is measured against (the seed). */
export interface DeliveryScale {
  /** The scale in whole days (> 0). */
  readonly days: number;
}

/** The seeded weights of the ranking function (exact rationals, exposed). */
export interface PreferenceWeights {
  /** The weight of the economic component (>= 0). */
  readonly economicWeight: Rational;
  /** The weight of the delivery component (>= 0). */
  readonly deliveryWeight: Rational;
  /** The economic scale the exposure is measured against (the seed). */
  readonly economicScale: EconomicScale;
  /** The delivery scale the lead-time exposure is measured against (the seed). */
  readonly deliveryScale: DeliveryScale;
}

/** Grammar description used in parse failures. */
export const PREFERENCE_WEIGHTS_GRAMMAR =
  'PreferenceWeights: { economicWeight: Rational >= 0, deliveryWeight: Rational >= 0, economicWeight + deliveryWeight > 0, economicScale: { amountMinor: integer > 0, currency: CurrencyCode }, deliveryScale: { days: integer > 0 } }';

/** The default seeded weights: economic 1/2, delivery 1/2, scale 10M minor / 30 days. */
export const DEFAULT_PREFERENCE_WEIGHTS: PreferenceWeights = {
  economicWeight: { numerator: 1, denominator: 2 },
  deliveryWeight: { numerator: 1, denominator: 2 },
  economicScale: { amountMinor: 10_000_000, currency: 'USD' as CurrencyCode },
  deliveryScale: { days: 30 },
};

/** The economic component of one preference score (attributable, exposed). */
export interface EconomicScoreComponent {
  /** The weight this component carries (the seed). */
  readonly weight: Rational;
  /** The exposure: min(1, |projectedDelta| / economicScale) (exact rational). */
  readonly exposure: Rational;
  /** The component's contribution: weight x exposure (exact rational). */
  readonly contribution: Rational;
  /** The projected delta the exposure measured (signed, cited composition). */
  readonly projectedDeltaMinor: number;
  /** The currency of the measured delta. */
  readonly currency: CurrencyCode;
  /** THE referenced assessments of the measured impact (canonical order). */
  readonly assessmentIds: readonly AssessmentId[];
}

/** The delivery component of one preference score (attributable, exposed). */
export interface DeliveryScoreComponent {
  /** The weight this component carries (the seed). */
  readonly weight: Rational;
  /** The exposure: min(1, leadGainDays / deliveryScaleDays) (exact rational). */
  readonly exposure: Rational;
  /** The component's contribution: weight x exposure (exact rational). */
  readonly contribution: Rational;
  /** The lead-time gain the exposure measured (cited from the comparison rows). */
  readonly leadGainDays: number;
}

/** The exposed preference score of one ranked recommendation (A4 + the acceptance). */
export interface PreferenceScore {
  /** The total score: economicContribution + deliveryContribution (exact). */
  readonly total: Rational;
  /** The economic component (attributable: weight, exposure, contribution). */
  readonly economic: EconomicScoreComponent;
  /** The delivery component (attributable: weight, exposure, contribution). */
  readonly delivery: DeliveryScoreComponent;
}

// ---------------------------------------------------------------------------
// The ProposedNextAction contract — SUGGESTIONS ONLY. Every proposed action
// is a typed command reference resolvable through the OFF-017 action
// gateway (the gateway's own CommandName vocabulary + a JSON-safe payload
// of the deterministic reference fields; aggregate-versioned fields,
// actors, idempotency keys, and approvals are supplied by the PROPOSING
// caller at proposal time). The procurement engine NEVER places a
// commitment, NEVER issues a command, and NEVER mutates canonical state —
// the only exit of the commitment surface is a typed ProposedNextAction
// record (see proposal.ts).
// ---------------------------------------------------------------------------

/** The typed confidence level of a proposed next action (A4). */
export type ProposedConfidenceLevel = 'low' | 'medium' | 'high';

/** Why the confidence level is what it is (stable machine-readable codes). */
export type ProposedConfidenceReason =
  | 'single-assessment-basis'
  | 'historical-basis-outcomes'
  | 'benchmark-calibrated'
  | 'no-benchmark-context'
  | 'price-above-budget-basis'
  | 'human-decision-required';

/** The deterministic confidence of one proposed action (A4). */
export interface ProposedConfidence {
  readonly level: ProposedConfidenceLevel;
  readonly reasons: readonly ProposedConfidenceReason[];
}

/** The typed command reference of one proposed action (gateway-resolvable). */
export interface ActionCommandReference {
  /** The command name — one of the OFF-017 gateway's typed command names. */
  readonly commandName: CommandName;
  /**
   * The JSON-safe payload of deterministic reference fields (entity ids the
   * command targets). Aggregate-versioned fields are caller-supplied at
   * proposal time — the procurement engine never resolves live versions.
   */
  readonly payload: Record<string, unknown>;
}

/**
 * An explicit policy decision authorizing the COMMITMENT of a procurement
 * decision (freeze A8: contractual actions are approval-required unless an
 * organization policy grants automation). The engine records the decision
 * on the commitment PROPOSAL it produces — it never executes the decision.
 */
export interface ProcurementPolicyDecision {
  /** The closed decision vocabulary: this decision allows a procurement commitment. */
  readonly decision: 'commit-procurement-decision';
  /** Who made the decision (A4 source identity). */
  readonly decidedBy: Actor;
  /** When the decision was made (injected clock — never wall time). */
  readonly decidedAt: Timestamp;
  /** The recorded rationale of the decision. */
  readonly rationale: string;
}

/** One PROPOSED next action for a procurement recommendation (never executed here). */
export interface ProposedNextAction {
  /** The suggested command (typed reference, gateway-resolvable). */
  readonly command: ActionCommandReference;
  /** The scope the suggested command would run under. */
  readonly scope: Scope;
  /** Human-readable title of the proposed action. */
  readonly title: string;
  /** Why this action is proposed for this recommendation (deterministic text). */
  readonly rationale: string;
  /** The deterministic confidence of the proposal (A4). */
  readonly confidence: ProposedConfidence;
  /** The evidence justifying the proposal (subset of the recommendation's chain). */
  readonly evidence: readonly ProcurementEvidence[];
  /**
   * The explicit policy decision behind a COMMITMENT proposal (null for
   * plain suggestions — commitment proposals carry their authorizing
   * decision, A4/A8).
   */
  readonly policyDecision: ProcurementPolicyDecision | null;
}

// ---------------------------------------------------------------------------
// The proposed command names — the landed cost domain's typed command
// vocabulary (the registry the OFF-017 gateway resolves proposals against).
// The literals mirror packages/domain/cost/src/commands.ts exactly; the
// engine invents no command names and CONSTRUCTS no commands (the boundary
// self-gate proves it).
// ---------------------------------------------------------------------------

const commandNameLiteral = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid command name literal: ${name}`);
  }
  return parsed.value;
};

/** Proposed for every procurement recommendation: place the commitment with the selected vendor(s). */
export const CREATE_COMMITMENT_COMMAND: CommandName = commandNameLiteral('cost.createCommitment');
/** Proposed when the incumbent position must be re-baselined (switch/split/timing release). */
export const AMEND_COMMITMENT_COMMAND: CommandName = commandNameLiteral('cost.amendCommitment');
/** Proposed when the incumbent position is fully replaced (a terminal release). */
export const CLOSE_COMMITMENT_COMMAND: CommandName = commandNameLiteral('cost.closeCommitment');

// ---------------------------------------------------------------------------
// Entity kind constants the referenced-record refs reference (the local
// vocabulary mirror of the cost domain's declared kinds — the same idiom
// every landed intelligence package uses).
// ---------------------------------------------------------------------------

const kindLiteral = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind literal: ${literal}`);
  }
  return parsed.value;
};

export const BUDGET_KIND: EntityKind = kindLiteral('budget');
export const COST_ITEM_KIND: EntityKind = kindLiteral('cost-item');
export const COMMITMENT_KIND: EntityKind = kindLiteral('commitment');
export const PROJECT_KIND: EntityKind = kindLiteral('project');
export const CHANGE_EVENT_KIND: EntityKind = kindLiteral('change-event');

/** Canonical referenced-record order (kind, then id). */
export const compareReferencedRecords = (
  left: EntityRef,
  right: EntityRef,
): number => {
  if (left.entityKind !== right.entityKind) {
    return left.entityKind < right.entityKind ? -1 : 1;
  }
  if (left.entityId !== right.entityId) {
    return left.entityId < right.entityId ? -1 : 1;
  }
  return 0;
};
