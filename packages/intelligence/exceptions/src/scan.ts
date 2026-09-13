// Office intelligence — the deterministic detection pass (OFF-019).
//
// detectExceptions() is THE scan engine: the margin engine's
// ImpactAssessment values + the relationship engine's authorization-filtered
// traversal subgraphs + the memory engine's benchmark facts go in (with the
// caller's authorization and the injected scan identity/clock), the
// portfolio exception set comes out. Same inputs → the byte-identical
// exception set, every run (run-twice + shuffled-inputs determinism are the
// acceptance tests; A7 rebuildability discipline). No clock, no randomness,
// no environment, no AI — the detection rules are pure typed computation.
//
// The scan order is part of the contract:
//   1. the CAPABILITY gate (deny-by-default: a request missing one of the
//      three area read capabilities never reads an input, never detects);
//   2. STRUCTURAL scope coverage of every input (freeze A12): assessments,
//      subgraph nodes, and benchmarks outside the caller's execution scope
//      are typed-rejected BEFORE any detection — cross-tenant inputs never
//      compute, and the rejection never reveals the foreign scope;
//   3. the POLICY gate over every input's resource: assessments and
//      benchmarks the caller's policy denies are EXCLUDED (the set-query
//      precedent — denied records are never served, never errors);
//   4. only then: the five detection rules (schedule slip, cost overrun,
//      entitlement exposure, dependency risk, evidence gap), every
//      exception carrying its full evidence chain (A4).
//
// Exception ids are DERIVED from the injected scan identity (scanId#ordinal
// in the canonical emission order: kind order, then assessment order) —
// deterministic without any id supplier beyond the scan token itself.
import type { EntityId, EntityRef, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { ImpactAssessment } from '@office/intelligence-margin';
import { CHANGE_EVENT_RAISED_EVENT } from '@office/intelligence-margin';
import type { AssessmentId, CurrencyCode } from '@office/intelligence-margin';
import type { Benchmark, BenchmarkId, BenchmarkMetricKind, Rational } from '@office/intelligence-memory';
import type { TraversalSubgraph } from '@office/intelligence-relationships';
import type { ExceptionId, ExceptionKind, ScanId, SeverityLevel } from './vocabulary';
import {
  ACTIVITY_KIND,
  BUDGET_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CONTRACT_KIND,
  EXCEPTIONS_ENGINE,
  EXCEPTION_SCHEMA_VERSION,
  PROJECT_KIND,
  canonicalExceptionEvidence,
  rationalCompare,
  reduceExceptionRational,
} from './model';
import type {
  DetectionProvenance,
  EconomicImpact,
  Exception,
  ExceptionAssessmentSource,
  ExceptionBenchmarkSource,
  ExceptionEvidence,
  ExceptionEventSource,
  ExceptionPrimarySource,
  ExceptionSeverity,
  ExceptionSeverityReason,
} from './model';
import {
  checkExceptionCapabilities,
  checkExceptionPolicy,
  checkExceptionScopeCovers,
} from './authorization';
import type { ExceptionAuthorization } from './authorization';

// ---------------------------------------------------------------------------
// The typed inputs of one detection scan.
// ---------------------------------------------------------------------------

/** The typed inputs of one detection scan (all authorization-filtered). */
export interface ExceptionScanInputs {
  /**
   * The margin engine's ImpactAssessment values — the economic numbers the
   * rules compute over (each assessment is itself an authorization-filtered
   * projection of one source change event).
   */
  readonly assessments: readonly ImpactAssessment[];
  /**
   * The relationship engine's authorization-filtered traversal subgraphs —
   * the affected-entity structure the dependency-risk rule computes over.
   * A subgraph is consumed by the assessment of its start change event.
   */
  readonly subgraphs: readonly TraversalSubgraph[];
  /**
   * The memory engine's benchmark facts — the severity-calibration context
   * (a value beyond the benchmarked envelope escalates the severity one
   * level, with the benchmark id cited in the evidence chain).
   */
  readonly benchmarks: readonly Benchmark[];
}

/** The injected identity/clock of one detection scan (never wall time). */
export interface ScanParts {
  /** The caller-supplied deterministic scan identity. */
  readonly scanId: ScanId;
  /** When the scan runs (injected clock). */
  readonly detectedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// The typed severity thresholds of the detection rules (documentation
// constants — the tests pin them; nothing here is tunable at runtime
// because an unexplained knob would be a black box).
// ---------------------------------------------------------------------------

/** Schedule-slip severity thresholds (slip days; minor below the lowest). */
export const SCHEDULE_SLIP_THRESHOLDS_DAYS: readonly {
  readonly minDays: number;
  readonly level: SeverityLevel;
}[] = [
  { minDays: 20, level: 'critical' },
  { minDays: 10, level: 'major' },
  { minDays: 4, level: 'moderate' },
];

/** Cost-overrun / entitlement severity thresholds (share of contracted value). */
export const ECONOMIC_SHARE_THRESHOLDS: readonly {
  readonly minShare: Rational;
  readonly level: SeverityLevel;
}[] = [
  { minShare: { numerator: 1, denominator: 2 }, level: 'critical' },
  { minShare: { numerator: 1, denominator: 5 }, level: 'major' },
  { minShare: { numerator: 1, denominator: 20 }, level: 'moderate' },
];

/** Dependency-risk severity thresholds (downstream activity count). */
export const DEPENDENCY_THRESHOLDS_COUNT: readonly {
  readonly minDownstream: number;
  readonly level: SeverityLevel;
}[] = [
  { minDownstream: 8, level: 'critical' },
  { minDownstream: 4, level: 'major' },
  { minDownstream: 2, level: 'moderate' },
];

/** The minimum positive slip that raises a schedule-slip exception (days). */
export const SCHEDULE_SLIP_MIN_DAYS = 1;

// ---------------------------------------------------------------------------
// Severity helpers (pure, exact-rational).
// ---------------------------------------------------------------------------

const severityByDays = (days: number): SeverityLevel => {
  for (const threshold of SCHEDULE_SLIP_THRESHOLDS_DAYS) {
    if (days >= threshold.minDays) return threshold.level;
  }
  return 'minor';
};

const severityByShare = (share: Rational): SeverityLevel => {
  for (const threshold of ECONOMIC_SHARE_THRESHOLDS) {
    if (rationalCompare(share, threshold.minShare) >= 0) return threshold.level;
  }
  return 'minor';
};

const severityByCount = (count: number): SeverityLevel => {
  for (const threshold of DEPENDENCY_THRESHOLDS_COUNT) {
    if (count >= threshold.minDownstream) return threshold.level;
  }
  return 'minor';
};

const LEVEL_ORDER: readonly SeverityLevel[] = ['minor', 'moderate', 'major', 'critical'];

/** Escalate one severity level (bounded at critical — calibration only raises). */
const escalate = (level: SeverityLevel): SeverityLevel => {
  const index = LEVEL_ORDER.indexOf(level);
  const next = LEVEL_ORDER[Math.min(index + 1, LEVEL_ORDER.length - 1)];
  return next ?? 'critical';
};

// ---------------------------------------------------------------------------
// Fail-closed scan rejections.
// ---------------------------------------------------------------------------

const scanContext = (authorization: ExceptionAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

const crossScopeInputRejection = (authorization: ExceptionAuthorization): DomainError =>
  domainError(
    'unauthorized',
    'exception scan inputs carry records outside the caller\u2019s scope: cross-scope inputs are typed-rejected before any detection (freeze A12)',
    [
      {
        code: 'exception-input-scope',
        message: 'cross-scope scan inputs are typed-rejected (freeze A12)',
        path: null,
      },
    ],
    scanContext(authorization),
  );

const duplicateAssessmentRejection = (
  assessmentId: string,
  authorization: ExceptionAuthorization,
): DomainError =>
  domainError(
    'invariant-violation',
    `the scan input set contains a duplicate assessment ${assessmentId}: an assessment set is a set`,
    [{ code: 'duplicate-assessment', message: assessmentId, path: 'assessments' }],
    scanContext(authorization),
  );

// ---------------------------------------------------------------------------
// Source-reference helpers (the evidence chain constructors).
// ---------------------------------------------------------------------------

const assessmentSourceOf = (assessment: ImpactAssessment): ExceptionAssessmentSource => ({
  kind: 'assessment',
  assessmentId: assessment.assessmentId,
  assessedAt: assessment.assessedAt,
  sourceEventId: assessment.source.eventId,
  changeEventId: assessment.source.changeEventId,
  contractId: assessment.source.contractId,
});

const changeEventRefOf = (assessment: ImpactAssessment): EntityRef => ({
  entityKind: CHANGE_EVENT_KIND,
  entityId: assessment.source.changeEventId,
});

const contractRefOf = (assessment: ImpactAssessment): EntityRef => ({
  entityKind: CONTRACT_KIND,
  entityId: assessment.source.contractId,
});

// The assessment's subject is always a `contracts.changeEventRaised` event
// (the margin engine's assessment query grammar) — the canonical name of
// the primary producing event.
const changeEventSourceOf = (assessment: ImpactAssessment): ExceptionEventSource => ({
  kind: 'event',
  eventId: assessment.source.eventId,
  eventName: CHANGE_EVENT_RAISED_EVENT,
  occurredAt: assessment.source.occurredAt,
});

const primarySourceOf = (assessment: ImpactAssessment): ExceptionPrimarySource => ({
  eventId: assessment.source.eventId,
  eventName: CHANGE_EVENT_RAISED_EVENT,
  occurredAt: assessment.source.occurredAt,
  correlationId: assessment.source.correlationId,
});

const benchmarkSourceOf = (
  benchmark: Benchmark,
  metricKind: BenchmarkMetricKind,
): ExceptionBenchmarkSource => ({
  kind: 'benchmark',
  benchmarkId: benchmark.benchmarkId,
  computedAt: benchmark.computedAt,
  metricKind,
});

/** The benchmark metric lookup: first benchmark (canonical id order) carrying the metric. */
const benchmarkMetricOf = (
  benchmarks: readonly Benchmark[],
  metricKind: BenchmarkMetricKind,
): { readonly benchmark: Benchmark; readonly metric: Benchmark['metrics'][number] } | null => {
  const ordered = [...benchmarks].sort((left, right) =>
    left.benchmarkId < right.benchmarkId ? -1 : left.benchmarkId > right.benchmarkId ? 1 : 0,
  );
  for (const benchmark of ordered) {
    const metric = benchmark.metrics.find((candidate) => candidate.kind === metricKind);
    if (metric !== undefined) return { benchmark, metric };
  }
  return null;
};

const severityOf = (
  level: SeverityLevel,
  reasons: readonly ExceptionSeverityReason[],
): ExceptionSeverity => ({
  level,
  reasons: [...new Set<ExceptionSeverityReason>(reasons)].sort(),
});

const economicOf = (
  amountMinor: number | null,
  currency: CurrencyCode | null,
  assessmentIds: readonly AssessmentId[],
): EconomicImpact => ({
  amountMinor,
  currency,
  assessmentIds: [...assessmentIds],
});

const compareRefs = (left: EntityRef, right: EntityRef): number => {
  if (left.entityKind !== right.entityKind) {
    return left.entityKind < right.entityKind ? -1 : 1;
  }
  if (left.entityId !== right.entityId) {
    return left.entityId < right.entityId ? -1 : 1;
  }
  return 0;
};

/** Deduplicate + canonically order the affected-entity refs (a ref set). */
const canonicalAffectedEntities = (
  refs: readonly EntityRef[],
): readonly EntityRef[] => {
  const byKey = new Map<string, EntityRef>();
  for (const ref of refs) {
    const key = `${ref.entityKind}|${ref.entityId}`;
    if (!byKey.has(key)) {
      byKey.set(key, ref);
    }
  }
  return [...byKey.values()].sort(compareRefs);
};

// ---------------------------------------------------------------------------
// THE five detection rules. Each rule is a pure function of ONE admitted
// assessment (+ its matched subgraph + the calibration benchmarks) into at
// most one exception PARTS value of its kind, with the complete evidence
// chain; the scan engine then stamps the deterministic identity.
// ---------------------------------------------------------------------------

/** The unstamped parts of one detected exception (identity comes from the scan). */
interface ExceptionParts {
  readonly kind: ExceptionKind;
  readonly assessment: ImpactAssessment;
  readonly title: string;
  readonly affected: readonly EntityRef[];
  readonly severity: ExceptionSeverity;
  readonly economicImpact: EconomicImpact;
  readonly evidence: readonly ExceptionEvidence[];
  readonly calibrationBenchmarkIds: readonly BenchmarkId[];
}

interface RuleContext {
  readonly subgraphOf: ReadonlyMap<EntityId, TraversalSubgraph>;
  readonly benchmarks: readonly Benchmark[];
  readonly consumed: {
    readonly assessmentCount: number;
    readonly subgraphCount: number;
    readonly benchmarkCount: number;
  };
}

/** Rule 1 — schedule slip: the change event's forecast consequence moved the program. */
const detectScheduleSlip = (
  context: RuleContext,
  assessment: ImpactAssessment,
): ExceptionParts | null => {
  const slipDays = assessment.scheduleImpact.projectDurationDelta;
  if (slipDays < SCHEDULE_SLIP_MIN_DAYS) return null;

  const reasons: ExceptionSeverityReason[] = ['schedule-slip-days'];
  let level = severityByDays(slipDays);
  const calibration: BenchmarkId[] = [];
  const evidence: ExceptionEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
  ];

  // Benchmark calibration: a slip beyond the benchmarked p90 schedule
  // variance escalates one level (the benchmark id is cited in the chain).
  const calibrationMetric = benchmarkMetricOf(context.benchmarks, 'schedule-variance-days');
  if (calibrationMetric !== null) {
    const slip = reduceExceptionRational({ numerator: slipDays, denominator: 1 });
    if (rationalCompare(slip, calibrationMetric.metric.percentile90) > 0) {
      level = escalate(level);
      reasons.push('benchmark-beyond-percentile90');
      calibration.push(calibrationMetric.benchmark.benchmarkId);
      evidence.push(benchmarkSourceOf(calibrationMetric.benchmark, 'schedule-variance-days'));
    }
  }

  const affected: EntityRef[] = [
    changeEventRefOf(assessment),
    ...assessment.scheduleImpact.activityDeltas.map((delta) => ({
      entityKind: ACTIVITY_KIND,
      entityId: delta.activityId,
    })),
  ];
  for (const driver of assessment.scheduleImpact.drivers) {
    evidence.push({
      kind: 'event',
      eventId: driver.eventId,
      eventName: driver.eventName,
      occurredAt: driver.occurredAt,
    });
  }

  return {
    kind: 'schedule-slip',
    assessment,
    title: `Schedule slip of ${slipDays} day${slipDays === 1 ? '' : 's'} on change event ${assessment.source.changeEventId}`,
    affected,
    severity: severityOf(level, reasons),
    economicImpact: economicOf(null, null, [assessment.assessmentId]),
    evidence,
    calibrationBenchmarkIds: calibration,
  };
};

/** Rule 2 — cost overrun: the projected or committed cost exceeds the contracted value. */
const detectCostOverrun = (
  context: RuleContext,
  assessment: ImpactAssessment,
): ExceptionParts | null => {
  const contracted = assessment.marginPosition.contractedValue.amountMinor;
  const projected = assessment.marginPosition.projectedCost.amountMinor;
  const committed = assessment.marginPosition.committedCost.amountMinor;
  const overrun = Math.max(projected, committed) - contracted;
  if (overrun <= 0) return null;

  const reasons: ExceptionSeverityReason[] = ['cost-overrun-share'];
  let level: SeverityLevel;
  if (contracted <= 0) {
    // No contracted value to measure against: committed cost with zero
    // contracted value is full exposure (deterministic fallback).
    level = 'critical';
  } else {
    const share = reduceExceptionRational({
      numerator: overrun,
      denominator: contracted,
    });
    level = severityByShare(share);
  }

  const calibration: BenchmarkId[] = [];
  const evidence: ExceptionEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
  ];

  // Benchmark calibration: a margin ratio below the benchmarked minimum
  // (worse than every benchmarked completed project) escalates one level.
  if (contracted > 0) {
    const marginRatio = reduceExceptionRational({
      numerator: assessment.marginPosition.marginMinor,
      denominator: contracted,
    });
    const calibrationMetric = benchmarkMetricOf(context.benchmarks, 'margin-ratio');
    if (
      calibrationMetric !== null &&
      rationalCompare(marginRatio, calibrationMetric.metric.min) < 0
    ) {
      level = escalate(level);
      reasons.push('benchmark-below-minimum');
      calibration.push(calibrationMetric.benchmark.benchmarkId);
      evidence.push(benchmarkSourceOf(calibrationMetric.benchmark, 'margin-ratio'));
    }
  }

  const affected: EntityRef[] = [
    changeEventRefOf(assessment),
    contractRefOf(assessment),
    ...assessment.costImpact.revisionAnchors.map((anchor) => ({
      entityKind: BUDGET_KIND,
      entityId: anchor.budgetId,
    })),
  ];
  for (const layer of [
    assessment.marginPosition.contractedValue,
    assessment.marginPosition.committedCost,
    assessment.marginPosition.projectedCost,
  ]) {
    for (const reference of layer.evidence) {
      evidence.push({
        kind: 'event',
        eventId: reference.eventId,
        eventName: reference.eventName,
        occurredAt: reference.occurredAt,
      });
    }
  }

  return {
    kind: 'cost-overrun',
    assessment,
    title: `Cost overrun of ${overrun} minor units on contract ${assessment.source.contractId}`,
    affected,
    severity: severityOf(level, reasons),
    economicImpact: economicOf(overrun, assessment.marginPosition.currency, [
      assessment.assessmentId,
    ]),
    evidence,
    calibrationBenchmarkIds: calibration,
  };
};

/** Rule 3 — entitlement exposure: submitted-but-undecided change order value. */
const detectEntitlementExposure = (
  _context: RuleContext,
  assessment: ImpactAssessment,
): ExceptionParts | null => {
  const pending = assessment.entitlementImpact.pendingValueMinor;
  if (pending <= 0) return null;

  const pendingOrders = assessment.entitlementImpact.orders.filter(
    (order) => order.status === 'submitted',
  );
  const contracted = assessment.marginPosition.contractedValue.amountMinor;
  let level: SeverityLevel;
  if (contracted <= 0) {
    level = 'critical';
  } else {
    const share = reduceExceptionRational({ numerator: pending, denominator: contracted });
    level = severityByShare(share);
  }

  const evidence: ExceptionEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
  ];
  for (const order of pendingOrders) {
    evidence.push({
      kind: 'event',
      eventId: order.submissionSource.eventId,
      eventName: order.submissionSource.eventName,
      occurredAt: order.submissionSource.occurredAt,
    });
    if (order.decisionSource !== null) {
      evidence.push({
        kind: 'event',
        eventId: order.decisionSource.eventId,
        eventName: order.decisionSource.eventName,
        occurredAt: order.decisionSource.occurredAt,
      });
    }
  }

  return {
    kind: 'entitlement-exposure',
    assessment,
    title: `Entitlement exposure of ${pending} minor units across ${pendingOrders.length} undecided change order${pendingOrders.length === 1 ? '' : 's'}`,
    affected: [
      changeEventRefOf(assessment),
      contractRefOf(assessment),
      ...pendingOrders.map((order) => ({
        entityKind: CHANGE_ORDER_KIND,
        entityId: order.changeOrderId,
      })),
    ],
    severity: severityOf(level, ['entitlement-pending-share']),
    economicImpact: economicOf(pending, assessment.marginPosition.currency, [
      assessment.assessmentId,
    ]),
    evidence,
    calibrationBenchmarkIds: [],
  };
};

/** Rule 4 — dependency risk: a slipped activity that downstream work depends on. */
const detectDependencyRisk = (
  context: RuleContext,
  assessment: ImpactAssessment,
): ExceptionParts | null => {
  const subgraph = context.subgraphOf.get(assessment.source.changeEventId);
  if (subgraph === undefined) return null;

  const slippedActivities = assessment.scheduleImpact.activityDeltas.filter(
    (delta) => delta.earlyFinishDelta > 0 || delta.earlyStartDelta > 0,
  );
  if (slippedActivities.length === 0) return null;

  // 'depends-on' edges point successor -> predecessor: a slipped activity
  // that other activities depend on gates downstream work.
  const downstreamOf = new Map<EntityId, EntityId[]>();
  let downstreamCount = 0;
  const edgeEvidence: ExceptionEvidence[] = [];
  for (const edge of subgraph.edges) {
    if (edge.kind !== 'depends-on') continue;
    const gates = slippedActivities.some((delta) => delta.activityId === edge.to.entityId);
    if (!gates) continue;
    const list = downstreamOf.get(edge.to.entityId) ?? [];
    if (!list.includes(edge.from.entityId)) {
      list.push(edge.from.entityId);
      downstreamOf.set(edge.to.entityId, list);
      downstreamCount += 1;
    }
    edgeEvidence.push({
      kind: 'event',
      eventId: edge.provenance.eventId,
      eventName: edge.provenance.eventName,
      occurredAt: null,
    });
  }
  if (downstreamCount === 0) return null;

  const evidence: ExceptionEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
    ...edgeEvidence,
  ];
  for (const delta of slippedActivities) {
    for (const driver of delta.drivers) {
      evidence.push({
        kind: 'event',
        eventId: driver.eventId,
        eventName: driver.eventName,
        occurredAt: driver.occurredAt,
      });
    }
  }

  const affected: EntityRef[] = [
    changeEventRefOf(assessment),
    ...slippedActivities.map((delta) => ({
      entityKind: ACTIVITY_KIND,
      entityId: delta.activityId,
    })),
    ...[...downstreamOf.values()].flat().map((activityId) => ({
      entityKind: ACTIVITY_KIND,
      entityId: activityId,
    })),
  ];

  return {
    kind: 'dependency-risk',
    assessment,
    title: `Dependency risk: ${downstreamCount} downstream activit${downstreamCount === 1 ? 'y' : 'ies'} gated by slipped activities of change event ${assessment.source.changeEventId}`,
    affected,
    severity: severityOf(severityByCount(downstreamCount), ['dependency-downstream-count']),
    economicImpact: economicOf(null, null, [assessment.assessmentId]),
    evidence,
    calibrationBenchmarkIds: [],
  };
};

/** Rule 5 — evidence gap: the producing assessment itself carries low confidence. */
const detectEvidenceGap = (
  _context: RuleContext,
  assessment: ImpactAssessment,
): ExceptionParts | null => {
  if (assessment.confidence.level !== 'low') return null;
  const reasonCount = assessment.confidence.reasons.length;
  const level: SeverityLevel = reasonCount >= 2 ? 'moderate' : 'minor';

  const evidence: ExceptionEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
    ...assessment.evidence.map((reference) => ({
      kind: 'event' as const,
      eventId: reference.eventId,
      eventName: reference.eventName,
      occurredAt: reference.occurredAt,
    })),
  ];

  return {
    kind: 'evidence-gap',
    assessment,
    title: `Evidence gap: the impact assessment of change event ${assessment.source.changeEventId} carries low confidence (${reasonCount} reason${reasonCount === 1 ? '' : 's'})`,
    affected: [changeEventRefOf(assessment), contractRefOf(assessment)],
    severity: severityOf(level, ['evidence-confidence-reasons']),
    economicImpact: economicOf(null, null, [assessment.assessmentId]),
    evidence,
    calibrationBenchmarkIds: [],
  };
};

// ---------------------------------------------------------------------------
// THE scan engine.
// ---------------------------------------------------------------------------

const stampException = (
  parts: ExceptionParts,
  parts2: ScanParts,
  ordinal: number,
  consumed: RuleContext['consumed'],
): Exception => {
  const exceptionId = `${parts2.scanId}#${String(ordinal).padStart(4, '0')}` as ExceptionId;
  const provenance: DetectionProvenance = {
    scanId: parts2.scanId,
    detectedAt: parts2.detectedAt,
    consumed: { ...consumed },
    calibrationBenchmarkIds: [...new Set<BenchmarkId>(parts.calibrationBenchmarkIds)].sort(),
  };
  return {
    exceptionId,
    exceptionVersion: EXCEPTION_SCHEMA_VERSION,
    engine: EXCEPTIONS_ENGINE,
    detectedAt: parts2.detectedAt,
    actor: parts.assessment.actor,
    scope: parts.assessment.scope,
    kind: parts.kind,
    title: parts.title,
    affected: canonicalAffectedEntities(parts.affected),
    severity: parts.severity,
    economicImpact: parts.economicImpact,
    evidence: canonicalExceptionEvidence(parts.evidence),
    provenance,
    primarySource: primarySourceOf(parts.assessment),
  };
};

/**
 * THE deterministic detection pass over (assessments + subgraphs +
 * benchmarks): the portfolio exception set. Authorization runs BEFORE any
 * input is read (capability gate first, A12 scope coverage second, policy
 * exclusion third); the detection rules then compute every exception with
 * its full evidence chain. Same inputs + same authorization + same scan
 * identity → the byte-identical exception set (A7).
 */
export function detectExceptions(
  inputs: ExceptionScanInputs,
  authorization: ExceptionAuthorization,
  parts: ScanParts,
): Result<readonly Exception[], DomainError> {
  // 1. Capability gate — before ANY input is read.
  const capabilities = checkExceptionCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  // 2. Duplicate assessment ids are a caller wiring error (an input set is a set).
  const seenAssessmentIds = new Set<string>();
  for (const assessment of inputs.assessments) {
    if (seenAssessmentIds.has(assessment.assessmentId)) {
      return fail(duplicateAssessmentRejection(assessment.assessmentId, authorization));
    }
    seenAssessmentIds.add(assessment.assessmentId);
  }

  // 3. Structural scope coverage of every input (A12 — typed rejection,
  //    never an existence oracle: the rejection never names the foreign scope).
  for (const assessment of inputs.assessments) {
    const covered = checkExceptionScopeCovers(authorization, {
      scope: assessment.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: assessment.source.changeEventId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const subgraph of inputs.subgraphs) {
    for (const node of subgraph.nodes) {
      const covered = checkExceptionScopeCovers(authorization, {
        scope: node.scope,
        entityKind: node.entity.entityKind,
        entityId: node.entity.entityId,
      });
      if (!covered.ok) return fail(crossScopeInputRejection(authorization));
    }
  }
  for (const benchmark of inputs.benchmarks) {
    const covered = checkExceptionScopeCovers(authorization, {
      scope: benchmark.scope,
      entityKind: PROJECT_KIND,
      entityId: null,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }

  // 4. Policy exclusion: denied assessments/benchmarks are invisible to this
  //    scan (the set-query precedent — never errors, never served).
  const admittedAssessments = inputs.assessments.filter((assessment) =>
    checkExceptionPolicy(authorization, {
      scope: assessment.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: assessment.source.changeEventId,
    }).ok,
  );
  const admittedBenchmarks = inputs.benchmarks.filter((benchmark) =>
    checkExceptionPolicy(authorization, {
      scope: benchmark.scope,
      entityKind: PROJECT_KIND,
      entityId: null,
    }).ok,
  );

  // 5. Match each subgraph to the assessment of its start change event
  //    (first matching start wins — the caller passes one traversal per
  //    assessed change event; only admitted assessments consume theirs).
  const subgraphOf = new Map<EntityId, TraversalSubgraph>();
  for (const subgraph of inputs.subgraphs) {
    const start = subgraph.query.start;
    if (start.entityKind !== 'change-event') continue;
    if (subgraphOf.has(start.entityId)) continue;
    subgraphOf.set(start.entityId, subgraph);
  }
  const consumedChangeEventIds = new Set<EntityId>(
    admittedAssessments.map((assessment) => assessment.source.changeEventId),
  );
  const consumedSubgraphCount = [...subgraphOf.keys()].filter((changeEventId) =>
    consumedChangeEventIds.has(changeEventId),
  ).length;

  // 6. THE detection rules — canonical assessment order, kind order; the
  //    ordinal stamping is pure array order (deterministic, input-order
  //    independent because the iteration orders are canonical).
  const orderedAssessments = [...admittedAssessments].sort((left, right) =>
    left.assessmentId < right.assessmentId
      ? -1
      : left.assessmentId > right.assessmentId
        ? 1
        : 0,
  );
  const context: RuleContext = {
    subgraphOf,
    benchmarks: admittedBenchmarks,
    consumed: {
      assessmentCount: admittedAssessments.length,
      subgraphCount: consumedSubgraphCount,
      benchmarkCount: admittedBenchmarks.length,
    },
  };

  const rules: readonly ((
    context: RuleContext,
    assessment: ImpactAssessment,
  ) => ExceptionParts | null)[] = [
    detectScheduleSlip,
    detectCostOverrun,
    detectEntitlementExposure,
    detectDependencyRisk,
    detectEvidenceGap,
  ];
  const detected: ExceptionParts[] = [];
  for (const rule of rules) {
    for (const assessment of orderedAssessments) {
      const result = rule(context, assessment);
      if (result !== null) detected.push(result);
    }
  }

  const stamped = detected.map((exceptionParts, index) =>
    stampException(exceptionParts, parts, index + 1, context.consumed),
  );
  return ok(stamped);
}
