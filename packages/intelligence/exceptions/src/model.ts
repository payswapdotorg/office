// Office intelligence — the exception and control-tower model (OFF-019).
//
// An Exception is ONE deterministic, versioned machine-generated claim that
// an actionable portfolio condition exists: the detected kind (schedule
// slip, cost overrun, entitlement exposure, dependency risk, evidence gap),
// the affected entities (typed refs), the typed severity (deterministically
// computed from the scan rules' typed thresholds and calibrated by the
// memory engine's benchmark facts), the economic impact (referencing the
// producing ImpactAssessment ids), the EVIDENCE CHAIN (every claim resolves
// to its producing source event/assessment/benchmark ids — freeze A4), and
// the detection provenance (which scan produced it, at which injected
// timestamp).
//
// The priority score composition is EXPOSED (the named acceptance): the
// ranking function composes severity weight + economic weight into the
// score over EXACT RATIONALS with every attributable component carried on
// the ranked exception — no black boxes, no floats, recomputable by hand.
//
// The model contains no clock, no randomness, no environment, and no entity
// data beyond ids/refs and the derived numbers: every constructor in this
// package is a PURE function of its typed inputs, so the same inputs always
// produce the byte-identical exception set (A7 rebuildability discipline).
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
import type { LedgerEventId } from '@office/events';
import type { AssessmentId, CurrencyCode } from '@office/intelligence-margin';
import type {
  BenchmarkId,
  BenchmarkMetricKind,
  Rational,
} from '@office/intelligence-memory';
import {
  compareEntityRef,
} from '@office/intelligence-relationships';
import { EXCEPTION_KINDS } from './vocabulary';
import type { ExceptionId, ExceptionKind, ScanId, SeverityLevel } from './vocabulary';

// ---------------------------------------------------------------------------
// Local exact-rational arithmetic (memory's Rational, local operations).
// ---------------------------------------------------------------------------

/** Add two exact rationals (result reduced to lowest terms). */
export const addRationals = (left: Rational, right: Rational): Rational =>
  reduceExceptionRational({
    numerator:
      left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });

/** Multiply two exact rationals (result reduced to lowest terms). */
export const multiplyRationals = (left: Rational, right: Rational): Rational =>
  reduceExceptionRational({
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
export const reduceExceptionRational = (value: Rational): Rational => {
  const g = gcd(value.numerator, value.denominator);
  return { numerator: value.numerator / g, denominator: value.denominator / g };
};

/** The zero rational (0/1). */
export const RATIONAL_ZERO: Rational = { numerator: 0, denominator: 1 };
/** The one rational (1/1). */
export const RATIONAL_ONE: Rational = { numerator: 1, denominator: 1 };

/** Build one exact rational (fail-closed on the domain bounds). */
export const exceptionRationalOf = (
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
  return parseOk(reduceExceptionRational({ numerator, denominator }));
};

// ---------------------------------------------------------------------------
// The evidence chain — the A4 provenance spine of every exception claim.
// Every number and every severity assertion of an exception cites the
// recorded ledger events, the margin assessments, and the memory benchmarks
// that produced it (discriminated source refs, mirroring the memory
// engine's OutcomeEvidence discipline).
// ---------------------------------------------------------------------------

/** Reference to the recorded ledger event that produced one claim. */
export interface ExceptionEventSource {
  readonly kind: 'event';
  /** The ledger id of the producing event. */
  readonly eventId: LedgerEventId;
  /** The producing event's name, e.g. 'contracts.changeEventRaised'. */
  readonly eventName: EventName;
  /**
   * The producing event's occurred-at time, or null when the reference was
   * derived from a relationship edge's provenance (which carries the event
   * id + name; the ledger id still resolves the time).
   */
  readonly occurredAt: Timestamp | null;
}

/** Reference to the margin assessment that produced one claim. */
export interface ExceptionAssessmentSource {
  readonly kind: 'assessment';
  /** The assessment's caller-supplied identity. */
  readonly assessmentId: AssessmentId;
  /** When the assessment was produced (injected clock). */
  readonly assessedAt: Timestamp;
  /** Ledger id of the assessed `contracts.changeEventRaised` event. */
  readonly sourceEventId: LedgerEventId;
  /** The assessed change event entity. */
  readonly changeEventId: EntityId;
  /** The owning contract of the assessed change event. */
  readonly contractId: EntityId;
}

/** Reference to the memory benchmark that calibrated one claim. */
export interface ExceptionBenchmarkSource {
  readonly kind: 'benchmark';
  /** The benchmark's caller-supplied identity. */
  readonly benchmarkId: BenchmarkId;
  /** When the benchmark was computed (injected clock). */
  readonly computedAt: Timestamp;
  /** The metric the calibration compared against. */
  readonly metricKind: BenchmarkMetricKind;
}

/** One provenance reference of an exception: an event, an assessment, or a benchmark. */
export type ExceptionEvidence =
  | ExceptionEventSource
  | ExceptionAssessmentSource
  | ExceptionBenchmarkSource;

/** Canonical evidence order: assessments, then benchmarks, then events (by id). */
export const compareExceptionEvidence = (
  left: ExceptionEvidence,
  right: ExceptionEvidence,
): number => {
  const kindOrder = (evidence: ExceptionEvidence): number =>
    evidence.kind === 'assessment' ? 0 : evidence.kind === 'benchmark' ? 1 : 2;
  if (kindOrder(left) !== kindOrder(right)) {
    return kindOrder(left) < kindOrder(right) ? -1 : 1;
  }
  const leftId =
    left.kind === 'assessment'
      ? left.assessmentId
      : left.kind === 'benchmark'
        ? left.benchmarkId
        : left.eventId;
  const rightId =
    right.kind === 'assessment'
      ? right.assessmentId
      : right.kind === 'benchmark'
        ? right.benchmarkId
        : right.eventId;
  if (leftId !== rightId) {
    return leftId < rightId ? -1 : 1;
  }
  return 0;
};

/** Deduplicate and canonically order exception evidence references. */
export const canonicalExceptionEvidence = (
  references: readonly ExceptionEvidence[],
): readonly ExceptionEvidence[] => {
  const idOf = (evidence: ExceptionEvidence): string =>
    evidence.kind === 'assessment'
      ? evidence.assessmentId
      : evidence.kind === 'benchmark'
        ? evidence.benchmarkId
        : evidence.eventId;
  const byId = new Map<string, ExceptionEvidence>();
  for (const reference of references) {
    if (!byId.has(idOf(reference))) {
      byId.set(idOf(reference), reference);
    }
  }
  return [...byId.values()].sort(compareExceptionEvidence);
};

// ---------------------------------------------------------------------------
// Severity + economic impact — the typed, evidence-chained claim parts.
// ---------------------------------------------------------------------------

/**
 * Why the severity level is what it is (stable machine-readable codes, one
 * per deterministic rule that fired — threshold rules + benchmark
 * calibration rules).
 */
export type ExceptionSeverityReason =
  | 'schedule-slip-days'
  | 'cost-overrun-share'
  | 'entitlement-pending-share'
  | 'dependency-downstream-count'
  | 'evidence-confidence-reasons'
  | 'benchmark-beyond-percentile90'
  | 'benchmark-below-minimum';

/** The typed severity of one exception (deterministically computed). */
export interface ExceptionSeverity {
  /** The severity level of the typed four-level scale. */
  readonly level: SeverityLevel;
  /** The deterministic rules that produced this level, canonical order. */
  readonly reasons: readonly ExceptionSeverityReason[];
}

/**
 * The economic impact of one exception: the money at stake (integer minor
 * units of the single currency) plus THE PRODUCING ASSESSMENT IDS (the
 * named acceptance: economic impact references the producing
 * ImpactAssessment ids). Kinds without a money angle carry null amounts
 * with their producing assessment ids still referenced.
 */
export interface EconomicImpact {
  /** The money at stake (integer minor units), or null when the kind has none. */
  readonly amountMinor: number | null;
  /** The single currency of the amount (null iff amountMinor is null). */
  readonly currency: CurrencyCode | null;
  /** Every margin assessment that produced this impact, canonical order. */
  readonly assessmentIds: readonly AssessmentId[];
}

// ---------------------------------------------------------------------------
// Detection provenance — which scan produced the exception, at which
// injected timestamp, over which consumed inputs.
// ---------------------------------------------------------------------------

/** The causation anchor of an exception: its primary producing event. */
export interface ExceptionPrimarySource {
  /** The ledger id of the primary producing event. */
  readonly eventId: LedgerEventId;
  /** The primary producing event's name. */
  readonly eventName: EventName;
  /** The primary producing event's occurred-at time. */
  readonly occurredAt: Timestamp;
  /** The correlation id of the primary source's causal chain (A3 carry-over). */
  readonly correlationId: string;
}

/** The detection provenance of one exception (A4). */
export interface DetectionProvenance {
  /** The scan that produced this exception (the injected scan identity). */
  readonly scanId: ScanId;
  /** When the scan ran (injected clock — never wall time). */
  readonly detectedAt: Timestamp;
  /** The consumed inputs' shape (assessments + subgraphs + benchmarks). */
  readonly consumed: {
    readonly assessmentCount: number;
    readonly subgraphCount: number;
    readonly benchmarkCount: number;
  };
  /** The memory benchmarks the severity calibration used, canonical order. */
  readonly calibrationBenchmarkIds: readonly BenchmarkId[];
}

// ---------------------------------------------------------------------------
// THE EXCEPTION MODEL.
// ---------------------------------------------------------------------------

/** The schema version of the Exception model (bump on shape change). */
export const EXCEPTION_SCHEMA_VERSION = 1;

/** The source identity of the exception engine (A4 'source identity'). */
export const EXCEPTIONS_ENGINE = 'intelligence-exceptions';

/**
 * THE exception: a detected portfolio condition — deterministic, versioned,
 * evidence-chained. Every claim (kind, severity, economic impact, affected
 * entities) carries the source event/assessment/benchmark references that
 * produced it; the detection provenance names the scan and its injected
 * timestamp. Exceptions are PROJECTIONS of the peers' outputs (A2/A7): the
 * same scan inputs always reproduce the identical exception set.
 */
export interface Exception {
  /** The scan-derived identity (deterministic given the scan identity). */
  readonly exceptionId: ExceptionId;
  /** The model schema version of this exception. */
  readonly exceptionVersion: typeof EXCEPTION_SCHEMA_VERSION;
  /** The source identity of the detecting engine (A4). */
  readonly engine: typeof EXCEPTIONS_ENGINE;
  /** When the exception was detected (injected clock — never wall time). */
  readonly detectedAt: Timestamp;
  /** The actor the scan ran for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the exception was detected under (A12). */
  readonly scope: Scope;
  /** The detected condition's kind (closed vocabulary). */
  readonly kind: ExceptionKind;
  /** The deterministic human-readable summary of the condition. */
  readonly title: string;
  /** The affected entities (typed refs, canonical order). */
  readonly affected: readonly EntityRef[];
  /** The typed severity (deterministically computed, benchmark-calibrated). */
  readonly severity: ExceptionSeverity;
  /** The economic impact (money at stake + producing assessment ids). */
  readonly economicImpact: EconomicImpact;
  /**
   * THE evidence chain acceptance: every source event/assessment/benchmark
   * reference behind any claim of this exception, deduplicated and in
   * canonical order.
   */
  readonly evidence: readonly ExceptionEvidence[];
  /** The detection provenance (scan id, injected timestamp, consumed shape). */
  readonly provenance: DetectionProvenance;
  /** The primary producing event (the A3 causation anchor of the detection). */
  readonly primarySource: ExceptionPrimarySource;
}

/** The canonical position of one exception kind (the vocabulary order). */
const exceptionKindOrder = (kind: ExceptionKind): number => {
  const index = (EXCEPTION_KINDS as readonly string[]).indexOf(kind);
  return index < 0 ? EXCEPTION_KINDS.length : index;
};

/**
 * Canonical exception order: kind (the closed vocabulary's canonical
 * order — the detection rules' emission order), then exception id.
 */
export const compareExceptions = (left: Exception, right: Exception): number => {
  if (left.kind !== right.kind) {
    return exceptionKindOrder(left.kind) - exceptionKindOrder(right.kind);
  }
  if (left.exceptionId !== right.exceptionId) {
    return left.exceptionId < right.exceptionId ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// Seeded prioritization — the EXPOSED score composition (THE named
// acceptance). The priority score of an exception is the exact-rational
// composition
//
//   priority = severityWeight x severityRank(level)
//            + economicWeight x min(1, economicImpact / economicScale)
//
// with every attributable component carried on the ranked exception: the
// weights, the severity rank, the economic exposure, and both contributions
// — recomputable by hand from the model alone (no black boxes).
// ---------------------------------------------------------------------------

/** The exposed formula of the priority score (documentation constant). */
export const PRIORITY_FORMULA =
  'priority = severityWeight x severityRank(level) + economicWeight x min(1, economicImpact / economicScale)';

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
  /** THE producing assessment ids of the ranked amount (canonical order). */
  readonly assessmentIds: readonly AssessmentId[];
}

/** The exposed priority score of one ranked exception (A4 + the acceptance). */
export interface PriorityScore {
  /** The total score: severityContribution + economicContribution (exact). */
  readonly total: Rational;
  /** The severity component (attributable: weight, level, rank, contribution). */
  readonly severity: SeverityScoreComponent;
  /** The economic component (attributable: weight, exposure, contribution). */
  readonly economic: EconomicScoreComponent;
}

/** One exception ranked by the seeded prioritization (the total order). */
export interface RankedException {
  /** The 1-based position in the stable priority order (identical across runs). */
  readonly rank: number;
  /** The ranked exception. */
  readonly exception: Exception;
  /** The exposed priority score (recomputable from the model alone). */
  readonly score: PriorityScore;
}

// ---------------------------------------------------------------------------
// The NextAction contract — SUGGESTIONS ONLY. Every suggested action is a
// typed command reference resolvable through the OFF-017 action gateway
// (the gateway's own CommandName vocabulary + a JSON-safe payload of the
// deterministic reference fields; aggregate-versioned fields, actors,
// idempotency keys, and approvals are supplied by the proposing caller at
// proposal time). The control tower NEVER executes anything — the engine
// has no execution path at all (the boundary test proves it).
// ---------------------------------------------------------------------------

/** The typed confidence level of a suggested next action (A4). */
export type NextActionConfidenceLevel = 'low' | 'medium' | 'high';

/** Why the confidence level is what it is (stable machine-readable codes). */
export type NextActionConfidenceReason =
  | 'single-assessment-basis'
  | 'multi-assessment-basis'
  | 'assessment-confidence-high'
  | 'assessment-confidence-degraded'
  | 'benchmark-calibrated'
  | 'no-benchmark-context'
  | 'human-decision-required';

/** The deterministic confidence of one suggested action (A4). */
export interface NextActionConfidence {
  readonly level: NextActionConfidenceLevel;
  readonly reasons: readonly NextActionConfidenceReason[];
}

/** The typed command reference of one suggested action (gateway-resolvable). */
export interface ActionCommandReference {
  /** The command name — one of the OFF-017 gateway's typed command names. */
  readonly commandName: CommandName;
  /**
   * The JSON-safe payload of deterministic reference fields (entity ids the
   * command targets). Aggregate-versioned fields are caller-supplied at
   * proposal time — the control tower never resolves live versions.
   */
  readonly payload: Record<string, unknown>;
}

/** One SUGGESTED next action for an exception (never executed here). */
export interface NextAction {
  /** The suggested command (typed reference, gateway-resolvable). */
  readonly command: ActionCommandReference;
  /** The scope the suggested command would run under. */
  readonly scope: Scope;
  /** Human-readable title of the suggested action. */
  readonly title: string;
  /** Why this action is suggested for this exception (deterministic text). */
  readonly rationale: string;
  /** The deterministic confidence of the suggestion (A4). */
  readonly confidence: NextActionConfidence;
  /** The evidence justifying the suggestion (subset of the exception's chain). */
  readonly evidence: readonly ExceptionEvidence[];
}

// ---------------------------------------------------------------------------
// The suggested command names — the landed domain packages' typed command
// vocabulary (the registry the OFF-017 gateway resolves proposals against).
// The literals mirror packages/domain/*/src/commands.ts exactly; the engine
// invents no command names.
// ---------------------------------------------------------------------------

const commandNameLiteral = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid command name literal: ${name}`);
  }
  return parsed.value;
};

/** Suggested for schedule slips: record actual progress to re-forecast. */
export const RECORD_PROGRESS_COMMAND: CommandName = commandNameLiteral('schedule.recordProgress');
/** Suggested for schedule slips: re-baseline the program after re-forecast. */
export const SET_BASELINE_COMMAND: CommandName = commandNameLiteral('schedule.setBaseline');
/** Suggested for cost overruns: commit a budget revision covering the overrun. */
export const REVISE_BUDGET_COMMAND: CommandName = commandNameLiteral('cost.reviseBudget');
/** Suggested for cost overruns: pursue entitlement for the overrun delta. */
export const SUBMIT_CHANGE_ORDER_COMMAND: CommandName = commandNameLiteral('contracts.submitChangeOrder');
/** Suggested for entitlement exposure: approve a pending change order. */
export const APPROVE_CHANGE_ORDER_COMMAND: CommandName = commandNameLiteral('contracts.approveChangeOrder');
/** Suggested for entitlement exposure: reject a pending change order. */
export const REJECT_CHANGE_ORDER_COMMAND: CommandName = commandNameLiteral('contracts.rejectChangeOrder');
/** Suggested for dependency risk: resequence the impacted activity. */
export const UPDATE_ACTIVITY_COMMAND: CommandName = commandNameLiteral('schedule.updateActivity');
/** Suggested for evidence gaps: link the missing document evidence. */
export const LINK_CHANGE_REFERENCES_COMMAND: CommandName = commandNameLiteral('contracts.linkChangeReferences');

// ---------------------------------------------------------------------------
// Entity kind constants the affected-entity refs reference (imported from
// the relationship engine's canonical local vocabulary — the intelligence
// family's shared kind mirror).
// ---------------------------------------------------------------------------

const kindLiteral = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind literal: ${literal}`);
  }
  return parsed.value;
};

export const CONTRACT_KIND: EntityKind = kindLiteral('contract');
export const BUDGET_KIND: EntityKind = kindLiteral('budget');
export const ACTIVITY_KIND: EntityKind = kindLiteral('activity');
export const DEPENDENCY_KIND: EntityKind = kindLiteral('dependency');
export const CHANGE_EVENT_KIND: EntityKind = kindLiteral('change-event');
export const CHANGE_ORDER_KIND: EntityKind = kindLiteral('change-order');
export const PROJECT_KIND: EntityKind = kindLiteral('project');

/** Canonical affected-entity order (kind, then id — the relationships idiom). */
export const compareAffectedEntities = compareEntityRef;
