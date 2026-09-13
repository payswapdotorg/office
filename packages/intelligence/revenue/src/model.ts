// Office intelligence — the recovery candidate model (OFF-033).
//
// The shared typed model of the revenue recovery engine: the local
// exact-Rational arithmetic (every priority score is an integer-numerator/
// positive-integer-denominator pair — never a float), the A4 evidence
// chain (the discriminated source references that PRODUCED a candidate's
// claims), the typed severity/economic/historical claim parts, the exposed
// priority-score composition (the named acceptance: recomputable by hand
// from the model alone), and the ProposedNextAction contract (SUGGESTIONS
// ONLY — the engine has no execution path at all).
//
// The model contains no clock, no randomness, no environment, and no
// entity data beyond ids/refs and the derived numbers: every constructor
// in this package is a PURE function of its typed inputs, so the same
// inputs always produce the byte-identical candidate set (A7
// rebuildability discipline).
//
// The agents EvidenceSet TYPE discipline (OFF-018) is imported TYPE-ONLY
// from @office/agents: a candidate carries a complete, qualified evidence
// set (see detection.ts's qualifyRecoveryEvidenceSet gate) — the runtime
// boundary stays within the engine's own pure computation.
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
import type { SeverityLevel } from './vocabulary';

// ---------------------------------------------------------------------------
// Local exact-rational arithmetic (memory's Rational shape, local
// operations — mirroring the exception engine's discipline exactly).
// ---------------------------------------------------------------------------

/** Add two exact rationals (result reduced to lowest terms). */
export const addRationals = (left: Rational, right: Rational): Rational =>
  reduceRecoveryRational({
    numerator:
      left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });

/** Multiply two exact rationals (result reduced to lowest terms). */
export const multiplyRationals = (left: Rational, right: Rational): Rational =>
  reduceRecoveryRational({
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
export const reduceRecoveryRational = (value: Rational): Rational => {
  const g = gcd(value.numerator, value.denominator);
  return { numerator: value.numerator / g, denominator: value.denominator / g };
};

/** The zero rational (0/1). */
export const RATIONAL_ZERO: Rational = { numerator: 0, denominator: 1 };
/** The one rational (1/1). */
export const RATIONAL_ONE: Rational = { numerator: 1, denominator: 1 };

/** Build one exact rational (fail-closed on the domain bounds). */
export const recoveryRationalOf = (
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
  return parseOk(reduceRecoveryRational({ numerator, denominator }));
};

// ---------------------------------------------------------------------------
// THE evidence chain — the A4 provenance spine of every recovery candidate.
// Every claim (kind, severity, economic basis, historical basis) cites the
// canonical contracts-domain records, the producing ledger events, the
// margin assessments, and the memory outcomes/benchmarks that produced it
// (discriminated source refs, mirroring the exception engine's evidence
// discipline — every reference resolves to a producing source record).
// ---------------------------------------------------------------------------

/** The ledger event id shape of the producing events (margin's source refs). */
export type ProducingLedgerEventId = ImpactAssessment['source']['eventId'];

/** Reference to one canonical contracts-domain record that produced a claim. */
export interface RecoveryRecordSource {
  readonly kind: 'record';
  /** The canonical entity ref of the referenced record. */
  readonly ref: EntityRef;
  /** Which contracts-domain aggregate the referenced record is. */
  readonly recordKind: 'contract' | 'change-event' | 'change-order' | 'claim-reference';
  /** The record's aggregate version at detection time (read surface). */
  readonly version: number;
  /** When the referenced record was created (its own clock, cited). */
  readonly createdAt: Timestamp;
}

/** Reference to the recorded ledger event that produced one claim. */
export interface RecoveryEventSource {
  readonly kind: 'event';
  /** The ledger id of the producing event. */
  readonly eventId: ProducingLedgerEventId;
  /** The producing event's name, e.g. 'contracts.changeEventRaised'. */
  readonly eventName: EventName;
  /** The producing event's occurred-at time. */
  readonly occurredAt: Timestamp;
}

/** Reference to the margin assessment that produced one claim. */
export interface RecoveryAssessmentSource {
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
export interface RecoveryOutcomeSource {
  readonly kind: 'outcome';
  /** The outcome's caller-supplied identity. */
  readonly outcomeId: OutcomeId;
  /** When the outcome was recorded (injected clock). */
  readonly recordedAt: Timestamp;
  /** The completed project the outcome records. */
  readonly projectId: EntityId;
}

/** Reference to the memory benchmark that calibrated one claim. */
export interface RecoveryBenchmarkSource {
  readonly kind: 'benchmark';
  /** The benchmark's caller-supplied identity. */
  readonly benchmarkId: BenchmarkId;
  /** When the benchmark was computed (injected clock). */
  readonly computedAt: Timestamp;
  /** The metric the calibration compared against. */
  readonly metricKind: BenchmarkMetricKind;
}

/** One provenance reference of a recovery candidate. */
export type RecoveryEvidence =
  | RecoveryRecordSource
  | RecoveryEventSource
  | RecoveryAssessmentSource
  | RecoveryOutcomeSource
  | RecoveryBenchmarkSource;

/**
 * Canonical evidence order: assessments, then benchmarks, then outcomes,
 * then contracts-domain records, then events (by identity within a kind).
 */
export const compareRecoveryEvidence = (
  left: RecoveryEvidence,
  right: RecoveryEvidence,
): number => {
  const kindOrder = (evidence: RecoveryEvidence): number => {
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
  const idOf = (evidence: RecoveryEvidence): string => {
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

/** Deduplicate and canonically order recovery evidence references. */
export const canonicalRecoveryEvidence = (
  references: readonly RecoveryEvidence[],
): readonly RecoveryEvidence[] => {
  const idOf = (evidence: RecoveryEvidence): string => {
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
  const byId = new Map<string, RecoveryEvidence>();
  for (const reference of references) {
    if (!byId.has(idOf(reference))) {
      byId.set(idOf(reference), reference);
    }
  }
  return [...byId.values()].sort(compareRecoveryEvidence);
};

/** The agents-typed evidence set every candidate carries (TYPE-ONLY import). */
export type CandidateEvidenceSet = EvidenceSet;

// ---------------------------------------------------------------------------
// Severity + the economic/historical claim parts — typed, evidence-chained.
// ---------------------------------------------------------------------------

/**
 * Why the severity level is what it is (stable machine-readable codes, one
 * per deterministic rule that fired — threshold rules + benchmark
 * calibration rules).
 */
export type RecoverySeverityReason =
  | 'constructive-cost-share'
  | 'entitlement-rejected-share'
  | 'delay-impact-days'
  | 'benchmark-beyond-percentile90'
  | 'benchmark-approval-rate-divergence';

/** The typed severity of one recovery candidate (deterministically computed). */
export interface RecoverySeverity {
  /** The severity level of the typed four-level scale. */
  readonly level: SeverityLevel;
  /** The deterministic rules that produced this level, canonical order. */
  readonly reasons: readonly RecoverySeverityReason[];
}

/**
 * Where the money at stake of a candidate was CITED from — a typed
 * discriminator proving the number is a reference to an already-recorded
 * value, never a re-derived one.
 */
export type RecoveryEconomicCitation =
  | 'assessment-cost-impact-budget-revision-delta'
  | 'change-order-submitted-value'
  | 'none';

/**
 * The economic impact basis of one recovery candidate: the money at stake
 * (an integer minor-unit amount CITED from the producing assessment's own
 * numbers or from the canonical change-order record — never re-derived)
 * plus THE PRODUCING ASSESSMENT IDS (the economic basis is referenced, not
 * recomputed). Kinds without a money angle carry a null amount with their
 * producing assessment ids still referenced.
 */
export interface RecoveryEconomicBasis {
  /** The money at stake (integer minor units), or null when the kind has none. */
  readonly amountMinor: number | null;
  /** The single currency of the amount (null iff amountMinor is null). */
  readonly currency: CurrencyCode | null;
  /** The typed citation the amount was referenced through. */
  readonly citedFrom: RecoveryEconomicCitation;
  /** Every margin assessment that produced this basis, canonical order. */
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
 * The historical basis of one recovery candidate: the referenced memory
 * outcome records + benchmark facts the candidate's recovery expectation
 * is grounded in (completed-project history — referenced facts, never
 * re-derived statistics).
 */
export interface RecoveryHistoricalBasis {
  /** The referenced outcome records, canonical order. */
  readonly outcomeIds: readonly OutcomeId[];
  /** The cited benchmark facts, canonical order. */
  readonly benchmarks: readonly HistoricalBenchmarkFact[];
}

// ---------------------------------------------------------------------------
// Seeded prioritization — the EXPOSED score composition (THE named
// acceptance). The priority score of a recovery candidate is the
// exact-rational composition
//
//   priority = severityWeight x severityRank(level)
//            + economicWeight x min(1, recoveryValue / economicScale)
//
// with every attributable component carried on the ranked candidate: the
// weights, the severity rank, the economic exposure, and both contributions
// — recomputable by hand from the model alone (no black boxes).
// ---------------------------------------------------------------------------

/** The exposed formula of the priority score (documentation constant). */
export const PRIORITY_FORMULA =
  'priority = severityWeight x severityRank(level) + economicWeight x min(1, recoveryValue / economicScale)';

/** The exact-rational rank of one severity level (minor 1/4 .. critical 1/1). */
export const severityRankOf = (level: SeverityLevel): Rational => {
  switch (level) {
    case 'minor':
      return { numerator: 1, denominator: 4 };
    case 'moderate':
      return { numerator: 1, denominator: 2 };
    case 'major':
      return { numerator: 3, denominator: 4 };
    case 'critical':
      return { numerator: 1, denominator: 1 };
  }
};

/** The reference money the economic exposure is measured against (the seed). */
export interface EconomicScale {
  /** The scale amount (integer minor units, > 0). */
  readonly amountMinor: number;
  /** The single currency of the scale (every ranked amount must match). */
  readonly currency: CurrencyCode;
}

/** The seeded weights of the ranking function (exact rationals, exposed). */
export interface PriorityWeights {
  /** The weight of the severity component (>= 0). */
  readonly severityWeight: Rational;
  /** The weight of the economic component (>= 0). */
  readonly economicWeight: Rational;
  /** The economic scale the exposure is measured against (the seed). */
  readonly economicScale: EconomicScale;
}

/** Grammar description used in parse failures. */
export const PRIORITY_WEIGHTS_GRAMMAR =
  'PriorityWeights: { severityWeight: Rational >= 0, economicWeight: Rational >= 0, severityWeight + economicWeight > 0, economicScale: { amountMinor: integer > 0, currency: CurrencyCode } }';

/** The default seeded weights: severity 1/2, economic 1/2, scale 10M minor. */
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  severityWeight: { numerator: 1, denominator: 2 },
  economicWeight: { numerator: 1, denominator: 2 },
  economicScale: { amountMinor: 10_000_000, currency: 'USD' as CurrencyCode },
};

/** The severity component of one priority score (attributable, exposed). */
export interface SeverityScoreComponent {
  /** The weight this component carries (the seed). */
  readonly weight: Rational;
  /** The severity level that was ranked. */
  readonly level: SeverityLevel;
  /** The exact-rational rank of the level (minor 1/4 .. critical 1/1). */
  readonly rank: Rational;
  /** The component's contribution: weight x rank (exact rational). */
  readonly contribution: Rational;
}

/** The economic component of one priority score (attributable, exposed). */
export interface EconomicScoreComponent {
  /** The weight this component carries (the seed). */
  readonly weight: Rational;
  /** The exposure: min(1, amount / economicScale) (exact rational; 0 when the kind carries no money). */
  readonly exposure: Rational;
  /** The component's contribution: weight x exposure (exact rational). */
  readonly contribution: Rational;
  /** The money at stake (null when the kind carries none). */
  readonly amountMinor: number | null;
  /** The currency of the amount (null when the kind carries none). */
  readonly currency: CurrencyCode | null;
  /** The typed citation the ranked amount was referenced through. */
  readonly citedFrom: RecoveryEconomicCitation;
  /** THE producing assessment ids of the ranked basis (canonical order). */
  readonly assessmentIds: readonly AssessmentId[];
}

/** The exposed priority score of one ranked candidate (A4 + the acceptance). */
export interface PriorityScore {
  /** The total score: severityContribution + economicContribution (exact). */
  readonly total: Rational;
  /** The severity component (attributable: weight, level, rank, contribution). */
  readonly severity: SeverityScoreComponent;
  /** The economic component (attributable: weight, exposure, contribution). */
  readonly economic: EconomicScoreComponent;
}

// ---------------------------------------------------------------------------
// The ProposedNextAction contract — SUGGESTIONS ONLY. Every proposed
// action is a typed command reference resolvable through the OFF-017
// action gateway (the gateway's own CommandName vocabulary + a JSON-safe
// payload of the deterministic reference fields; aggregate-versioned
// fields, actors, idempotency keys, and approvals are supplied by the
// PROPOSING caller at proposal time). The recovery engine NEVER asserts a
// contractual claim, NEVER issues a command, and NEVER mutates canonical
// state — the only exit of the assertion surface is a typed
// ProposedNextAction record (see proposal.ts).
// ---------------------------------------------------------------------------

/** The typed confidence level of a proposed next action (A4). */
export type ProposedConfidenceLevel = 'low' | 'medium' | 'high';

/** Why the confidence level is what it is (stable machine-readable codes). */
export type ProposedConfidenceReason =
  | 'single-assessment-basis'
  | 'historical-basis-outcomes'
  | 'benchmark-calibrated'
  | 'no-benchmark-context'
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
   * proposal time — the recovery engine never resolves live versions.
   */
  readonly payload: Record<string, unknown>;
}

/**
 * An explicit policy decision authorizing the ASSERTION of a recovery
 * claim (freeze A8: contractual actions are approval-required unless an
 * organization policy grants automation). The engine records the decision
 * on the assertion PROPOSAL it produces — it never executes the decision.
 */
export interface RecoveryPolicyDecision {
  /** The closed decision vocabulary: this decision allows a claim assertion. */
  readonly decision: 'assert-recovery-claim';
  /** Who made the decision (A4 source identity). */
  readonly decidedBy: Actor;
  /** When the decision was made (injected clock — never wall time). */
  readonly decidedAt: Timestamp;
  /** The recorded rationale of the decision. */
  readonly rationale: string;
}

/** One PROPOSED next action for a recovery candidate (never executed here). */
export interface ProposedNextAction {
  /** The suggested command (typed reference, gateway-resolvable). */
  readonly command: ActionCommandReference;
  /** The scope the suggested command would run under. */
  readonly scope: Scope;
  /** Human-readable title of the proposed action. */
  readonly title: string;
  /** Why this action is proposed for this candidate (deterministic text). */
  readonly rationale: string;
  /** The deterministic confidence of the proposal (A4). */
  readonly confidence: ProposedConfidence;
  /** The evidence justifying the proposal (subset of the candidate's chain). */
  readonly evidence: readonly RecoveryEvidence[];
  /**
   * The explicit policy decision behind an ASSERTION proposal (null for
   * plain suggestions — assertion proposals carry their authorizing
   * decision, A4/A8).
   */
  readonly policyDecision: RecoveryPolicyDecision | null;
}

// ---------------------------------------------------------------------------
// The proposed command names — the landed domain packages' typed command
// vocabulary (the registry the OFF-017 gateway resolves proposals against).
// The literals mirror packages/domain/contracts/src/commands.ts exactly; the
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

/** Proposed for recovery candidates: submit the change order that claims the recovery. */
export const SUBMIT_CHANGE_ORDER_COMMAND: CommandName = commandNameLiteral('contracts.submitChangeOrder');
/** Proposed for evidence completion: attach the producing evidence to the change event. */
export const LINK_CHANGE_REFERENCES_COMMAND: CommandName = commandNameLiteral('contracts.linkChangeReferences');
/** Proposed after execution: pin the claim reference to the executed order + evidence. */
export const REFERENCE_CLAIM_COMMAND: CommandName = commandNameLiteral('contracts.referenceClaim');

// ---------------------------------------------------------------------------
// Entity kind constants the referenced-record refs reference (the local
// vocabulary mirror of the contracts domain's declared kinds — the same
// idiom every landed intelligence package uses).
// ---------------------------------------------------------------------------

const kindLiteral = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind literal: ${literal}`);
  }
  return parsed.value;
};

export const CONTRACT_KIND: EntityKind = kindLiteral('contract');
export const CHANGE_EVENT_KIND: EntityKind = kindLiteral('change-event');
export const CHANGE_ORDER_KIND: EntityKind = kindLiteral('change-order');
export const CLAIM_REFERENCE_KIND: EntityKind = kindLiteral('claim-reference');
export const PROJECT_KIND: EntityKind = kindLiteral('project');

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
