// Office intelligence — the memory model (OFF-015).
//
// The typed data model of the enterprise memory module: the exact-rational
// arithmetic every benchmark statistic and similarity score is expressed in
// (integer numerator / positive integer denominator — no floats anywhere,
// so every derived number is exactly attributable and replay-stable), the
// OUTCOME RECORD (a completed project's recorded outcome — deterministic
// facts derived from recorded events + assessments, each carrying SOURCE
// EVENT/ASSESSMENT refs, A4 provenance), the BENCHMARK (deterministic facts
// computed from an outcome set — every value carries the outcome ids that
// produced it), the LESSON (a reusable, human-authored-or-derived record
// with typed links, applicability tags, and provenance), and the project
// SIMILARITY contracts (typed feature vectors + exposed score composition).
//
// The model contains no clock, no randomness, no environment, and no entity
// data beyond ids/refs and the derived numbers: every constructor in this
// package is a PURE function of its typed inputs (the recorded facts + the
// margin engine's ImpactAssessment values + the injected identity/clock),
// so the same inputs always produce the byte-identical record.
import { isEntityId, parseEntityKind, parseFail, parseOk } from '@office/contracts';
import type {
  Actor,
  EntityId,
  EntityKind,
  EntityRef,
  EventName,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import type { LedgerEventId } from '@office/events';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { AssessmentId, CurrencyCode } from '@office/intelligence-margin';
import type { BenchmarkId, LessonId, OutcomeId } from './vocabulary';

// ---------------------------------------------------------------------------
// Exact rational arithmetic — the deterministic number discipline of every
// benchmark statistic and similarity score (no floats, no rounding).
// ---------------------------------------------------------------------------

/**
 * An exact rational number: integer numerator over POSITIVE integer
 * denominator. The denominator is always > 0 (never 0, never negative);
 * the sign lives in the numerator. Both components are bounded integers.
 */
export interface Rational {
  readonly numerator: number;
  readonly denominator: number;
}

/** The grammar of a serialized rational (the payload representation). */
export const RATIONAL_GRAMMAR =
  'rational: { numerator: safe integer, denominator: safe integer > 0 } (exact, reduced to lowest terms)';

/** The component bound of the Rational domain (every safe integer). */
export const RATIONAL_COMPONENT_MAX = 9007199254740991; // 2^53 - 1

/** The zero rational (0/1). */
export const RATIONAL_ZERO: Rational = { numerator: 0, denominator: 1 };

/** The one rational (1/1). */
export const RATIONAL_ONE: Rational = { numerator: 1, denominator: 1 };

const SAFE_ABS = RATIONAL_COMPONENT_MAX;

const isSafeComponent = (raw: unknown): raw is number =>
  typeof raw === 'number' && Number.isInteger(raw) && Math.abs(raw) <= SAFE_ABS;

/** Fail-closed constructor of one rational (validated, reduced). */
export function rationalOf(
  numerator: number,
  denominator: number,
): Result<Rational, DomainError> {
  if (!isSafeComponent(numerator) || !isSafeComponent(denominator) || denominator <= 0) {
    return fail(
      domainError(
        'invariant-violation',
        `rational(${numerator}, ${denominator}) is outside the exact-rational domain`,
        [
          {
            code: 'rational-domain',
            message: `numerator must be an integer |n| <= ${SAFE_ABS}, denominator an integer 1..${SAFE_ABS}`,
            path: null,
          },
        ],
      ),
    );
  }
  return ok(reduceRational({ numerator, denominator }));
}

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
export const reduceRational = (value: Rational): Rational => {
  const g = gcd(value.numerator, value.denominator);
  return { numerator: value.numerator / g, denominator: value.denominator / g };
};

/**
 * Compare two rationals exactly (BigInt cross-multiplication): -1 when
 * left < right, 0 when equal, 1 when left > right. Deterministic and
 * exact for every Rational in the domain — no float anywhere.
 */
export const compareRationals = (left: Rational, right: Rational): number => {
  const l = BigInt(left.numerator) * BigInt(right.denominator);
  const r = BigInt(right.numerator) * BigInt(left.denominator);
  if (l < r) return -1;
  if (l > r) return 1;
  return 0;
};

/** Structural equality of two rationals (exact). */
export const rationalsEqual = (left: Rational, right: Rational): boolean =>
  compareRationals(left, right) === 0;

/** Parse an untrusted value as a serialized rational (total, fail-closed). */
export function parseRational(raw: unknown): ParseResult<Rational> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFail('invalid-type', '', RATIONAL_GRAMMAR, describeValue(raw));
  }
  const record = raw as Record<string, unknown>;
  const knownKeys = new Set<string>(['numerator', 'denominator']);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      return parseFail('unknown-field', key, RATIONAL_GRAMMAR, 'present');
    }
  }
  const numerator = record['numerator'];
  if (!isSafeComponent(numerator)) {
    return parseFail(
      'invalid-value',
      'numerator',
      `an integer |n| <= ${SAFE_ABS}`,
      describeValue(numerator),
    );
  }
  const denominator = record['denominator'];
  if (!isSafeComponent(denominator) || denominator <= 0) {
    return parseFail(
      'invalid-value',
      'denominator',
      `an integer 1..${SAFE_ABS}`,
      describeValue(denominator),
    );
  }
  return parseOk(reduceRational({ numerator, denominator }));
}

// ---------------------------------------------------------------------------
// The source references of an outcome — the A4 provenance spine. Every
// number of an OutcomeRecord cites the ledger events and the margin
// assessments that produced it.
// ---------------------------------------------------------------------------

/**
 * Reference to the margin assessment that produced one derived number: the
 * assessment's identity, its assessed-at time, and the ledger event of the
 * change event it assessed (the assessment's own causation anchor).
 */
export interface OutcomeAssessmentSource {
  readonly kind: 'assessment';
  /** The assessment's caller-supplied identity. */
  readonly assessmentId: AssessmentId;
  /** When the assessment was produced (injected clock). */
  readonly assessedAt: Timestamp;
  /** Ledger id of the assessed `contracts.changeEventRaised` event. */
  readonly sourceEventId: LedgerEventId;
  /** The correlation id of the assessment's causal chain. */
  readonly correlationId: string;
  /** The assessed change event entity. */
  readonly changeEventId: EntityId;
  /** The owning contract of the assessed change event. */
  readonly contractId: EntityId;
}

/** Reference to the recorded ledger event that produced one derived number. */
export interface OutcomeEventSource {
  readonly kind: 'event';
  /** The ledger id of the producing event. */
  readonly eventId: LedgerEventId;
  /** The producing event's name, e.g. 'contracts.changeEventRaised'. */
  readonly eventName: EventName;
  /** The producing event's occurred-at time. */
  readonly occurredAt: Timestamp;
}

/** One provenance reference of an outcome: a recorded event OR an assessment. */
export type OutcomeEvidence = OutcomeEventSource | OutcomeAssessmentSource;

/** Canonical evidence order: assessments first (by assessment id), then events (by event id). */
export const compareOutcomeEvidence = (
  left: OutcomeEvidence,
  right: OutcomeEvidence,
): number => {
  const kindOrder = (evidence: OutcomeEvidence): number =>
    evidence.kind === 'assessment' ? 0 : 1;
  if (kindOrder(left) !== kindOrder(right)) {
    return kindOrder(left) < kindOrder(right) ? -1 : 1;
  }
  const leftId = left.kind === 'assessment' ? left.assessmentId : left.eventId;
  const rightId = right.kind === 'assessment' ? right.assessmentId : right.eventId;
  if (leftId !== rightId) {
    return leftId < rightId ? -1 : 1;
  }
  return 0;
};

/** Deduplicate and canonically order outcome evidence references. */
export const canonicalOutcomeEvidence = (
  references: readonly OutcomeEvidence[],
): readonly OutcomeEvidence[] => {
  const byId = new Map<string, OutcomeEvidence>();
  for (const reference of references) {
    const id = reference.kind === 'assessment' ? reference.assessmentId : reference.eventId;
    if (!byId.has(id)) {
      byId.set(id, reference);
    }
  }
  return [...byId.values()].sort(compareOutcomeEvidence);
};

/** Canonical order of assessment sources (assessed-at, then assessment id). */
export const compareAssessmentSources = (
  left: OutcomeAssessmentSource,
  right: OutcomeAssessmentSource,
): number => {
  if (left.assessedAt !== right.assessedAt) {
    return left.assessedAt < right.assessedAt ? -1 : 1;
  }
  if (left.assessmentId !== right.assessmentId) {
    return left.assessmentId < right.assessmentId ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// THE OUTCOME RECORD — a completed project's recorded outcome.
// ---------------------------------------------------------------------------

/** The schema version of the OutcomeRecord model (bump on shape change). */
export const OUTCOME_SCHEMA_VERSION = 1;

/** The source identity of the memory engine (A4 'source identity'). */
export const MEMORY_ENGINE = 'intelligence-memory';

/** The schedule outcome: baseline vs final forecast (calendar-free day counts). */
export interface ScheduleOutcome {
  /** The project duration before the first assessed change (the basis). */
  readonly baselineDurationDays: number;
  /** The project duration after the last assessed change (the final position). */
  readonly finalDurationDays: number;
  /** Schedule variance: final − baseline (positive = late). */
  readonly varianceDays: number;
  /** The boundary assessments that produced the two durations. */
  readonly sources: readonly OutcomeAssessmentSource[];
}

/** One contract's final margin position (from its latest assessment). */
export interface ContractMarginPosition {
  /** The contract the position belongs to. */
  readonly contractId: EntityId;
  /** The latest assessment that produced this position. */
  readonly assessmentId: AssessmentId;
  /** The position's currency (single currency per outcome). */
  readonly currency: CurrencyCode;
  /** Contracted value: contract value + approved/executed order values. */
  readonly contractedValueMinor: number;
  /** Committed cost of the impacted budgets. */
  readonly committedCostMinor: number;
  /** Projected cost of the impacted budgets. */
  readonly projectedCostMinor: number;
  /** Margin over projected cost: contracted − projected. */
  readonly marginMinor: number;
  /** Margin ratio: margin / contracted (exact rational; null when contracted value is 0 — undefined ratio). */
  readonly marginRatio: Rational | null;
}

/** The aggregated cost margin outcome of the completed project. */
export interface MarginOutcome {
  /** The single currency of every money layer. */
  readonly currency: CurrencyCode;
  /** The original contracted value at creation (the recorded contracts). */
  readonly originalContractedValueMinor: number;
  /** The final contracted value (incl. approved/executed change orders). */
  readonly contractedValueMinor: number;
  /** The final committed cost across the impacted budgets. */
  readonly committedCostMinor: number;
  /** The final projected cost across the impacted budgets. */
  readonly projectedCostMinor: number;
  /** The final margin: contracted − projected. */
  readonly marginMinor: number;
  /** The project margin ratio: margin / contracted (exact rational; null when contracted value is 0). */
  readonly marginRatio: Rational | null;
  /** Each contract's final position, in canonical contract order. */
  readonly perContract: readonly ContractMarginPosition[];
  /** The latest-per-contract assessments that produced the position. */
  readonly sources: readonly OutcomeAssessmentSource[];
  /** The `contracts.contractCreated` events of the recorded contracts. */
  readonly eventSources: readonly OutcomeEventSource[];
}

/** The final recorded status of one change order at outcome time. */
export type EntitlementOrderStatus =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'executed';

/** One change order's recorded outcome. */
export interface EntitlementOrderOutcome {
  readonly changeOrderId: EntityId;
  /** The order's submitted value (null when the order carried none). */
  readonly valueMinor: number | null;
  /** The order's final recorded status (latest decision wins). */
  readonly status: EntitlementOrderStatus;
  /** The `contracts.changeOrderSubmitted` event that produced the value. */
  readonly submissionEventId: LedgerEventId;
  /** The decision event (approved/rejected/executed), or null while pending. */
  readonly decisionEventId: LedgerEventId | null;
}

/** The aggregate entitlement outcome of the completed project. */
export interface EntitlementOutcome {
  /** Count of orders whose final status is 'approved'. */
  readonly approvedCount: number;
  /** Count of orders whose final status is 'executed'. */
  readonly executedCount: number;
  /** Count of orders whose final status is 'rejected'. */
  readonly rejectedCount: number;
  /** Count of orders still 'submitted' (undecided) at outcome time. */
  readonly pendingCount: number;
  /** Total value of approved orders (integer minor units). */
  readonly approvedValueMinor: number;
  /** Total value of rejected orders (integer minor units). */
  readonly rejectedValueMinor: number;
  /** Total value of undecided orders (integer minor units). */
  readonly pendingValueMinor: number;
  /**
   * The approval rate: (approved + executed) / total orders — the exact
   * rational; defined as 1/1 when the project recorded no change orders
   * (nothing was left undecided).
   */
  readonly approvalRate: Rational;
  /** Every order's final position, in canonical change-order order. */
  readonly orders: readonly EntitlementOrderOutcome[];
  /** The submission + decision events behind every order position. */
  readonly eventSources: readonly OutcomeEventSource[];
}

/** The change pressure of the completed project (counts from the recorded events). */
export interface ChangePressureOutcome {
  /** Count of raised change events (the folded commercial facts). */
  readonly changeEventCount: number;
  /** Count of submitted change orders. */
  readonly changeOrderCount: number;
  /** Count of recorded contracts. */
  readonly contractCount: number;
  /** The `contracts.changeEventRaised` events behind the count. */
  readonly eventSources: readonly OutcomeEventSource[];
}

/**
 * THE OUTCOME RECORD: a completed project's recorded outcome — deterministic
 * facts derived from recorded events + assessments. Tenant/project scoped,
 * immutable once recorded (an outcome is a fact of history — the store
 * rejects a second outcome for the same project), and every number carries
 * its SOURCE EVENT/ASSESSMENT references (A4 provenance): memory is a
 * PROJECTION, never canonical truth (A2/A7).
 */
export interface OutcomeRecord {
  /** The caller-supplied outcome identity (deterministic token). */
  readonly outcomeId: OutcomeId;
  /** The model schema version of this outcome record. */
  readonly outcomeVersion: typeof OUTCOME_SCHEMA_VERSION;
  /** The source identity of the deriving engine (A4). */
  readonly engine: typeof MEMORY_ENGINE;
  /** When the outcome was recorded (injected clock — never wall time). */
  readonly recordedAt: Timestamp;
  /** The actor the outcome was recorded for (A4 source identity). */
  readonly actor: Actor;
  /** The project scope the outcome was recorded under. */
  readonly scope: Scope;
  /** The completed project the outcome records. */
  readonly projectId: EntityId;
  /** The schedule outcome. */
  readonly schedule: ScheduleOutcome;
  /** The cost margin outcome. */
  readonly margin: MarginOutcome;
  /** The entitlement outcome. */
  readonly entitlement: EntitlementOutcome;
  /** The change pressure outcome. */
  readonly changePressure: ChangePressureOutcome;
  /** The consumed inputs' shape (facts + assessments). */
  readonly consumed: {
    readonly projectedEventCount: number;
    readonly assessmentCount: number;
  };
  /**
   * THE provenance acceptance: every source event and assessment reference
   * behind any number of this outcome, deduplicated and canonically ordered.
   */
  readonly evidence: readonly OutcomeEvidence[];
}

// ---------------------------------------------------------------------------
// THE BENCHMARK — deterministic facts computed from an outcome set.
// ---------------------------------------------------------------------------

/** The schema version of the Benchmark model (bump on shape change). */
export const BENCHMARK_SCHEMA_VERSION = 1;

/** The metric kinds a benchmark aggregates, in canonical order. */
export const BENCHMARK_METRIC_KINDS = [
  'schedule-variance-days',
  'margin-ratio',
  'entitlement-approval-rate',
  'change-event-count',
] as const;

/** One benchmark metric kind (a typed, named feature of an outcome). */
export type BenchmarkMetricKind = (typeof BENCHMARK_METRIC_KINDS)[number];

/** Grammar description used in parse failures. */
export const BENCHMARK_METRIC_KIND_GRAMMAR =
  "benchmark metric kind: one of 'schedule-variance-days', 'margin-ratio', 'entitlement-approval-rate', 'change-event-count'";

/** Parse an untrusted value as a benchmark metric kind (total, fail-closed). */
export function parseBenchmarkMetricKind(
  raw: unknown,
): ParseResult<BenchmarkMetricKind> {
  if (
    typeof raw === 'string' &&
    (BENCHMARK_METRIC_KINDS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as BenchmarkMetricKind);
  }
  return parseFail(
    'invalid-value',
    '',
    BENCHMARK_METRIC_KIND_GRAMMAR,
    describeValue(raw),
  );
}

/** The aggregate statistics of one metric over its producing outcomes. */
export interface BenchmarkMetricStats {
  /** The metric this aggregate describes. */
  readonly kind: BenchmarkMetricKind;
  /**
   * THE producing outcome ids: every outcome whose value entered this
   * aggregate, in canonical order (the named acceptance — a benchmark
   * value carries the outcome ids that produced it).
   */
  readonly outcomeIds: readonly OutcomeId[];
  /** The minimum observed value (exact rational). */
  readonly min: Rational;
  /** The maximum observed value (exact rational). */
  readonly max: Rational;
  /** The arithmetic mean (exact rational: sum / count). */
  readonly mean: Rational;
  /** The median (odd count: the middle value; even: the exact mean of the middle two). */
  readonly median: Rational;
  /** The 90th percentile (nearest-rank: the ceil(0.9 × count)-th smallest value). */
  readonly percentile90: Rational;
}

/** The percentile position of one outcome's value within one metric's set. */
export interface BenchmarkPosition {
  /** The metric the position is measured in. */
  readonly metricKind: BenchmarkMetricKind;
  /** The positioned outcome. */
  readonly outcomeId: OutcomeId;
  /**
   * The percentile rank: (strictly-below + ties / 2) / count — the exact
   * fraction of the metric's outcomes at or below this outcome's value.
   */
  readonly position: Rational;
}

/**
 * THE BENCHMARK: deterministic facts computed from an outcome set — a PURE
 * function of the queried outcomes (the same outcome set ALWAYS produces
 * the identical benchmark: run-twice determinism), every value carrying
 * the outcome ids that produced it. A recorded benchmark snapshot is an
 * immutable fact; the pure recomputation over its named outcome set must
 * equal it exactly (drift is structurally rejected by the store fold).
 */
export interface Benchmark {
  /** The caller-supplied benchmark identity (deterministic token). */
  readonly benchmarkId: BenchmarkId;
  /** The model schema version of this benchmark. */
  readonly benchmarkVersion: typeof BENCHMARK_SCHEMA_VERSION;
  /** The source identity of the computing engine (A4). */
  readonly engine: typeof MEMORY_ENGINE;
  /** When the benchmark was computed (injected clock — never wall time). */
  readonly computedAt: Timestamp;
  /** The actor the benchmark was computed for (A4 source identity). */
  readonly actor: Actor;
  /** The tenant scope the benchmark spans (A12: one tenant, never mixed). */
  readonly scope: Scope;
  /** The number of outcomes the benchmark was computed over. */
  readonly outcomeCount: number;
  /** Per-metric aggregate statistics, in canonical metric order. */
  readonly metrics: readonly BenchmarkMetricStats[];
  /** Per-metric percentile positions, in canonical (metric, outcome) order. */
  readonly positions: readonly BenchmarkPosition[];
}

// ---------------------------------------------------------------------------
// THE LESSON — a reusable, human-authored-or-derived record.
// ---------------------------------------------------------------------------

/** The schema version of the Lesson model (bump on shape change). */
export const LESSON_SCHEMA_VERSION = 1;

/** The applicability areas of a lesson, in canonical order. */
export const LESSON_AREAS = [
  'schedule',
  'cost',
  'contracts',
  'entitlement',
  'field',
  'general',
] as const;

/** One applicability area of a lesson (the closed tag vocabulary). */
export type LessonArea = (typeof LESSON_AREAS)[number];

/** Grammar description used in parse failures. */
export const LESSON_AREA_GRAMMAR =
  "lesson area: one of 'schedule', 'cost', 'contracts', 'entitlement', 'field', 'general'";

/** Parse an untrusted value as a lesson area (total, fail-closed). */
export function parseLessonArea(raw: unknown): ParseResult<LessonArea> {
  if (typeof raw === 'string' && (LESSON_AREAS as readonly string[]).includes(raw)) {
    return parseOk(raw as LessonArea);
  }
  return parseFail('invalid-value', '', LESSON_AREA_GRAMMAR, describeValue(raw));
}

/** The grammar of one applicability tag value. */
export const LESSON_TAG_VALUE_GRAMMAR =
  'non-empty printable-ASCII string of 1..64 characters (no control characters)';

const LESSON_TAG_VALUE_PATTERN = /^[\x21-\x7e]{1,64}$/;

/** One applicability tag: a typed area plus a free (bounded) value. */
export interface LessonTag {
  /** The area the tag applies to (closed vocabulary). */
  readonly area: LessonArea;
  /** The tag's value, e.g. 'wall-closing-sequence' (bounded string). */
  readonly value: string;
}

/** Parse one applicability tag (total, fail-closed, strict keys). */
export function parseLessonTag(raw: unknown): ParseResult<LessonTag> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFail(
      'invalid-type',
      '',
      'LessonTag: { area: LessonArea, value: 1..64 printable-ASCII chars }',
      describeValue(raw),
    );
  }
  const record = raw as Record<string, unknown>;
  const knownKeys = new Set<string>(['area', 'value']);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      return parseFail('unknown-field', key, 'LessonTag: { area, value }', 'present');
    }
  }
  const area = parseLessonArea(record['area']);
  if (!area.ok) {
    return parseFail(area.error.code, 'area', area.error.expected, area.error.received);
  }
  const value = record['value'];
  if (typeof value !== 'string' || !LESSON_TAG_VALUE_PATTERN.test(value)) {
    return parseFail(
      'invalid-value',
      'value',
      LESSON_TAG_VALUE_GRAMMAR,
      describeValue(value),
    );
  }
  return parseOk({ area: area.value, value } satisfies LessonTag);
}

/** Canonical lesson-tag order: area, then value. */
export const compareLessonTags = (left: LessonTag, right: LessonTag): number => {
  if (left.area !== right.area) {
    return left.area < right.area ? -1 : 1;
  }
  if (left.value !== right.value) {
    return left.value < right.value ? -1 : 1;
  }
  return 0;
};

/**
 * One typed link of a lesson: the entity the lesson is about, optionally
 * anchored to a document revision (the evidence) and/or the ledger event
 * that motivated the link.
 */
export interface LessonLink {
  /** The linked entity (typed ref). */
  readonly entity: EntityRef;
  /** The linked document (null when the link carries no document evidence). */
  readonly documentId: EntityId | null;
  /** The linked document revision (null when no document is linked). */
  readonly revisionId: EntityId | null;
  /** The motivating ledger event (null when the link cites no event). */
  readonly sourceEventId: LedgerEventId | null;
}

/** Canonical order of typed lesson links (entity kind, then entity id). */
export const compareLessonLinks = (left: LessonLink, right: LessonLink): number => {
  if (left.entity.entityKind !== right.entity.entityKind) {
    return left.entity.entityKind < right.entity.entityKind ? -1 : 1;
  }
  if (left.entity.entityId !== right.entity.entityId) {
    return left.entity.entityId < right.entity.entityId ? -1 : 1;
  }
  return 0;
};

/** How the lesson came to be (who/what derived it, and from which outcomes). */
export interface LessonProvenance {
  /** 'human' (authored by a person) or 'derived' (machine-derived from outcomes). */
  readonly origin: 'human' | 'derived';
  /** The author/deriving actor (A4 source identity). */
  readonly author: Actor;
  /**
   * The outcomes a derived lesson was derived from (empty for human
   * lessons; required non-empty for derived lessons).
   */
  readonly derivedFromOutcomeIds: readonly OutcomeId[];
  /** The deriving engine of machine-derived lessons (A4). */
  readonly engine: typeof MEMORY_ENGINE;
}

/**
 * THE LESSON: a reusable, human-authored-or-derived lesson record with
 * typed links, applicability tags, and provenance. Lessons are DATA — the
 * store serves them; they NEVER change behavior silently (no consumer of
 * this package may branch on lesson content without explicit code).
 */
export interface Lesson {
  /** The caller-supplied lesson identity (deterministic token). */
  readonly lessonId: LessonId;
  /** The model schema version of this lesson. */
  readonly lessonVersion: typeof LESSON_SCHEMA_VERSION;
  /** The source identity of the capturing engine (A4). */
  readonly engine: typeof MEMORY_ENGINE;
  /** When the lesson was captured (injected clock — never wall time). */
  readonly capturedAt: Timestamp;
  /** The actor the lesson was captured by/for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the lesson was captured under. */
  readonly scope: Scope;
  /** The lesson's title (1..200 printable characters). */
  readonly title: string;
  /** The lesson's statement (1..2000 printable characters). */
  readonly statement: string;
  /** The applicability tags, canonical (area, value) order. */
  readonly applicability: readonly LessonTag[];
  /** The typed links, canonical (entity kind, id) order. */
  readonly links: readonly LessonLink[];
  /** The provenance (who/what derived it and from which outcomes). */
  readonly provenance: LessonProvenance;
}

// ---------------------------------------------------------------------------
// Project similarity — typed feature vectors + exposed score composition.
// ---------------------------------------------------------------------------

/** The typed feature kinds of the similarity contract, in canonical order. */
export const FEATURE_KINDS = [
  'schedule-variance',
  'margin-ratio',
  'approval-rate',
  'change-activity',
  'contracted-scale',
  'relationship-density',
] as const;

/** One typed feature kind of the similarity contract. */
export type FeatureKind = (typeof FEATURE_KINDS)[number];

/** Grammar description used in parse failures. */
export const FEATURE_KIND_GRAMMAR =
  "feature kind: one of 'schedule-variance', 'margin-ratio', 'approval-rate', 'change-activity', 'contracted-scale', 'relationship-density'";

/** Parse an untrusted value as a feature kind (total, fail-closed). */
export function parseFeatureKind(raw: unknown): ParseResult<FeatureKind> {
  if (typeof raw === 'string' && (FEATURE_KINDS as readonly string[]).includes(raw)) {
    return parseOk(raw as FeatureKind);
  }
  return parseFail('invalid-value', '', FEATURE_KIND_GRAMMAR, describeValue(raw));
}

/** One typed feature of one project: a named exact-rational value. */
export interface FeatureValue {
  /** The feature's kind (the typed name). */
  readonly kind: FeatureKind;
  /** The feature's exact value. */
  readonly value: Rational;
}

/**
 * One project's typed feature vector, derived deterministically from its
 * recorded outcome (plus, optionally, its authorization-filtered
 * relationship subgraph — the similarity input the relationship engine
 * provides). NO embeddings, NO opaque models: every value is attributable.
 */
export interface ProjectFeatureVector {
  /** The project the vector describes. */
  readonly projectId: EntityId;
  /** The outcome the vector was derived from. */
  readonly outcomeId: OutcomeId;
  /** The features, canonical kind order. */
  readonly features: readonly FeatureValue[];
}

/** One feature weight of a similarity query (1..100). */
export interface SimilarityWeight {
  readonly kind: FeatureKind;
  readonly weight: number;
}

/** Grammar description of the similarity query. */
export const SIMILARITY_QUERY_GRAMMAR =
  "SimilarityQuery: { weights?: array of { kind: FeatureKind, weight: 1..100 } (at most one per kind), limit?: 1..100 }";

/** The typed similarity query: feature weights + result limit. */
export interface SimilarityQuery {
  /**
   * The per-feature weights (default: every feature kind weight 1). At
   * most one weight per kind; positive integers 1..100.
   */
  readonly weights?: readonly SimilarityWeight[];
  /** How many ranked candidates to return (default 10; 1..100). */
  readonly limit?: number;
}

/** Parse an untrusted value as a SimilarityQuery (total, fail-closed, strict keys). */
export function parseSimilarityQuery(raw: unknown): ParseResult<SimilarityQuery> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFail('invalid-type', '', SIMILARITY_QUERY_GRAMMAR, describeValue(raw));
  }
  const record = raw as Record<string, unknown>;
  const knownKeys = new Set<string>(['weights', 'limit']);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      return parseFail('unknown-field', key, SIMILARITY_QUERY_GRAMMAR, 'present');
    }
  }
  let weights: readonly SimilarityWeight[] | undefined;
  if (record['weights'] !== undefined) {
    if (!Array.isArray(record['weights'])) {
      return parseFail(
        'invalid-type',
        'weights',
        'an array of { kind, weight }',
        describeValue(record['weights']),
      );
    }
    const parsed: SimilarityWeight[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of (record['weights'] as unknown[]).entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return parseFail(
          'invalid-type',
          `weights[${index}]`,
          '{ kind: FeatureKind, weight: 1..100 }',
          describeValue(entry),
        );
      }
      const weightRecord = entry as Record<string, unknown>;
      const weightKeys = new Set<string>(['kind', 'weight']);
      for (const key of Object.keys(weightRecord)) {
        if (!weightKeys.has(key)) {
          return parseFail(
            'unknown-field',
            `weights[${index}].${key}`,
            '{ kind, weight }',
            'present',
          );
        }
      }
      const kind = parseFeatureKind(weightRecord['kind']);
      if (!kind.ok) {
        return parseFail(
          kind.error.code,
          `weights[${index}].kind`,
          kind.error.expected,
          kind.error.received,
        );
      }
      const weight = weightRecord['weight'];
      if (
        typeof weight !== 'number' ||
        !Number.isInteger(weight) ||
        weight < 1 ||
        weight > 100
      ) {
        return parseFail(
          'invalid-value',
          `weights[${index}].weight`,
          'an integer 1..100',
          describeValue(weight),
        );
      }
      if (seen.has(kind.value)) {
        return parseFail(
          'invalid-value',
          `weights[${index}].kind`,
          'at most one weight per feature kind (no duplicates)',
          `duplicate kind '${kind.value}'`,
        );
      }
      seen.add(kind.value);
      parsed.push({ kind: kind.value, weight });
    }
    weights = parsed;
  }
  let limit: number | undefined;
  if (record['limit'] !== undefined) {
    const rawLimit = record['limit'];
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 100
    ) {
      return parseFail(
        'invalid-value',
        'limit',
        'an integer 1..100',
        describeValue(rawLimit),
      );
    }
    limit = rawLimit;
  }
  const query: SimilarityQuery =
    weights === undefined && limit === undefined
      ? {}
      : {
          ...(weights === undefined ? {} : { weights }),
          ...(limit === undefined ? {} : { limit }),
        };
  return parseOk(query);
}

/** Type guard for structurally valid SimilarityQuery values. */
export function isSimilarityQuery(raw: unknown): raw is SimilarityQuery {
  return parseSimilarityQuery(raw).ok;
}

/** One attributable component of a similarity score (the EXPOSED composition). */
export interface SimilarityComponent {
  /** The typed feature this component scores. */
  readonly featureKind: FeatureKind;
  /** The subject's exact feature value. */
  readonly left: Rational;
  /** The candidate's exact feature value. */
  readonly right: Rational;
  /** The weight this component carried (from the query). */
  readonly weight: number;
  /** The per-feature similarity in [0,1]: max / (max + |left − right|), exact. */
  readonly similarity: Rational;
}

/** One ranked similar-project candidate with its EXPOSED score composition. */
export interface SimilarityCandidate {
  /** The candidate project. */
  readonly projectId: EntityId;
  /** The candidate's recorded outcome. */
  readonly outcomeId: OutcomeId;
  /** The rank (1-based, deterministic: score desc, then project id asc). */
  readonly rank: number;
  /** The total score: Σ(weight × similarity) / Σweight over SHARED features, exact. */
  readonly score: Rational;
  /** Every shared-feature component, canonical kind order — the composition. */
  readonly components: readonly SimilarityComponent[];
  /**
   * Features present on only one side (attributed skips — never silently
   * dropped): each entry names the kind and the side that lacked it.
   */
  readonly missingKinds: readonly {
    readonly kind: FeatureKind;
    readonly side: 'left' | 'right';
  }[];
}

// ---------------------------------------------------------------------------
// The memory read queries.
// ---------------------------------------------------------------------------

/** Grammar description of the outcome query. */
export const OUTCOME_QUERY_GRAMMAR =
  'OutcomeQuery: { projectId?: EntityId } — the outcome of one project, or every outcome inside the caller\u2019s covered scope when omitted';

/** The typed outcome query: one project's outcome, or the covered set. */
export interface OutcomeQuery {
  /** The project whose outcome is queried (default: the whole covered scope). */
  readonly projectId?: EntityId;
}

/** Parse an untrusted value as an OutcomeQuery (total, fail-closed, strict keys). */
export function parseOutcomeQuery(raw: unknown): ParseResult<OutcomeQuery> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFail('invalid-type', '', OUTCOME_QUERY_GRAMMAR, describeValue(raw));
  }
  const record = raw as Record<string, unknown>;
  const knownKeys = new Set<string>(['projectId']);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      return parseFail('unknown-field', key, OUTCOME_QUERY_GRAMMAR, 'present');
    }
  }
  if (record['projectId'] === undefined) {
    return parseOk({});
  }
  const projectId = record['projectId'];
  if (!isEntityId(projectId)) {
    return parseFail(
      'invalid-value',
      'projectId',
      'a canonical EntityId',
      describeValue(projectId),
    );
  }
  return parseOk({ projectId } satisfies OutcomeQuery);
}

/** Grammar description of the lesson query. */
export const LESSON_QUERY_GRAMMAR =
  'LessonQuery: { areas?: LessonArea[] (no duplicates) } — every lesson inside the caller\u2019s covered scope, optionally filtered by applicability area';

/** The typed lesson query. */
export interface LessonQuery {
  /** Filter to lessons carrying at least one tag of these areas. */
  readonly areas?: readonly LessonArea[];
}

/** Parse an untrusted value as a LessonQuery (total, fail-closed, strict keys). */
export function parseLessonQuery(raw: unknown): ParseResult<LessonQuery> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFail('invalid-type', '', LESSON_QUERY_GRAMMAR, describeValue(raw));
  }
  const record = raw as Record<string, unknown>;
  const knownKeys = new Set<string>(['areas']);
  for (const key of Object.keys(record)) {
    if (!knownKeys.has(key)) {
      return parseFail('unknown-field', key, LESSON_QUERY_GRAMMAR, 'present');
    }
  }
  if (record['areas'] === undefined) {
    return parseOk({});
  }
  if (!Array.isArray(record['areas'])) {
    return parseFail(
      'invalid-type',
      'areas',
      'an array of lesson areas',
      describeValue(record['areas']),
    );
  }
  const areas: LessonArea[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (record['areas'] as unknown[]).entries()) {
    const area = parseLessonArea(entry);
    if (!area.ok) {
      return parseFail(
        area.error.code,
        `areas[${index}]`,
        area.error.expected,
        area.error.received,
      );
    }
    if (seen.has(area.value)) {
      return parseFail(
        'invalid-value',
        `areas[${index}]`,
        'no duplicate areas',
        `duplicate area '${area.value}'`,
      );
    }
    seen.add(area.value);
    areas.push(area.value);
  }
  return parseOk({ areas } satisfies LessonQuery);
}

// ---------------------------------------------------------------------------
// Entity kind constants the memory vocabulary references (the kinds of the
// entities the outcome/lesson links point at — mirroring the landed
// packages' declared kinds exactly, the same local-vocabulary idiom the
// relationship and margin engines use).
// ---------------------------------------------------------------------------

const kindLiteral = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind literal: ${literal}`);
  }
  return parsed.value;
};

/** The completed-project kind of an outcome record. */
export const PROJECT_KIND: EntityKind = kindLiteral('project');

// ---------------------------------------------------------------------------
// Shared internal helpers.
// ---------------------------------------------------------------------------

function describeValue(raw: unknown): string {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return `${typeof raw} ${String(raw)}`;
  }
  return typeof raw;
}
