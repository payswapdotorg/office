// Office intelligence — the deterministic detection pass (OFF-033).
//
// detectRecoveryCandidates() is THE recovery scan engine: the contracts
// domain model's typed read surface (contract/change-event/change-order/
// claim-reference states) + the margin engine's ImpactAssessment values
// (the economic basis) + the memory engine's outcome records and benchmark
// facts (the historical basis) go in (with the caller's authorization and
// the injected scan identity/clock), the candidate recovery set comes out.
// Same inputs → the byte-identical candidate set, every run (run-twice +
// shuffled-inputs determinism are the acceptance tests; A7 rebuildability
// discipline). No clock, no randomness, no environment, no AI — the
// detection rules are pure typed computation.
//
// The scan order is part of the contract:
//   1. the CAPABILITY gate (deny-by-default: a request missing one of the
//      three area read capabilities never reads an input, never detects);
//   2. STRUCTURAL scope coverage of every input (freeze A12): contracts
//      records, assessments, outcomes, and benchmarks outside the caller's
//      execution scope are typed-rejected BEFORE any detection —
//      cross-tenant inputs never compute, and the rejection never reveals
//      the foreign scope;
//   3. the POLICY gate over every input's resource: records the caller's
//      policy denies are EXCLUDED (the set-query precedent — denied
//      records are never served, never errors);
//   4. only then: the three detection rules (constructive change,
//      entitlement rebalance, delay impact), each a pure function of one
//      admitted assessment (+ its canonical change event/order records +
//      the historical basis), emitting at most one candidate per (rule,
//      assessment) with its FULL evidence chain (A4) and its qualified
//      EvidenceSet (the agents discipline — an empty or out-of-scope set
//      is a typed rejection, never a silently-propagated candidate).
//
// Candidate ids are DERIVED from the injected scan identity
// (<scanId>#<ordinal> in the canonical emission order: kind order, then
// canonical assessment order) — deterministic without any id supplier
// beyond the scan token itself.
import type { EntityId, EntityRef, Scope, Timestamp } from '@office/contracts';
import { CHANGE_EVENT_RAISED_EVENT, parseCurrencyCode } from '@office/intelligence-margin';
import type { CurrencyCode, ImpactAssessment } from '@office/intelligence-margin';
import type { Benchmark, BenchmarkId, OutcomeRecord, Rational } from '@office/intelligence-memory';
import type {
  ChangeEventState,
  ChangeOrderState,
  ClaimReferenceState,
  ContractState,
} from '@office/domain-contracts';
import type { EvidenceItem, EvidenceQuery, EvidenceSet } from '@office/agents';
import { checkScopeCoversResource, resourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import {
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CLAIM_REFERENCE_KIND,
  CONTRACT_KIND,
  PROJECT_KIND,
  canonicalRecoveryEvidence,
  compareReferencedRecords,
  rationalCompare,
  reduceRecoveryRational,
} from './model';
import type {
  RecoveryAssessmentSource,
  RecoveryBenchmarkSource,
  RecoveryEconomicBasis,
  RecoveryEvidence,
  RecoveryEventSource,
  RecoveryHistoricalBasis,
  RecoveryOutcomeSource,
  RecoveryRecordSource,
  RecoverySeverity,
  RecoverySeverityReason,
} from './model';
import { CANDIDATE_SCHEMA_VERSION, RECOVERY_ENGINE } from './candidates';
import type { CandidateRecovery, DetectionProvenance } from './candidates';
import type { RecoveryKind, RecoveryScanId, SeverityLevel } from './vocabulary';
import {
  checkRecoveryCapabilities,
  checkRecoveryPolicy,
  checkRecoveryScopeCovers,
} from './authorization';
import type { RecoveryAuthorization } from './authorization';

// ---------------------------------------------------------------------------
// The typed inputs of one detection scan.
// ---------------------------------------------------------------------------

/** The typed inputs of one recovery detection scan (all authorization-filtered). */
export interface RecoveryScanInputs {
  /**
   * The contracts domain model's typed read surface — the canonical
   * contract aggregates (the commercial baseline the candidates measure
   * against). Read-only states: the engine never mutates them.
   */
  readonly contracts: readonly ContractState[];
  /**
   * The canonical change-event records — the proposed changes the rules
   * detect over (status, typed links, owning contract).
   */
  readonly changeEvents: readonly ChangeEventState[];
  /**
   * The canonical change-order records — the ordered/approved change
   * lifecycle (the claim conversion state of each change event).
   */
  readonly changeOrders: readonly ChangeOrderState[];
  /**
   * The canonical claim-reference records — the immutable pins of already
   * asserted claims (the idempotence guard: a pinned position is not a
   * candidate).
   */
  readonly claimReferences: readonly ClaimReferenceState[];
  /**
   * The margin engine's ImpactAssessment values — the economic basis every
   * rule cites (each assessment is itself an authorization-filtered
   * projection of one source change event; the engine references its
   * numbers, it never re-derives them).
   */
  readonly assessments: readonly ImpactAssessment[];
  /**
   * The memory engine's outcome records — the completed-project history
   * the recovery expectation is grounded in (the historical basis).
   */
  readonly outcomes: readonly OutcomeRecord[];
  /**
   * The memory engine's benchmark facts — the calibration + gating context
   * (the approval climate, the benchmarked schedule-variance envelope).
   */
  readonly benchmarks: readonly Benchmark[];
}

/** The injected identity/clock of one detection scan (never wall time). */
export interface ScanParts {
  /** The caller-supplied deterministic scan identity. */
  readonly scanId: RecoveryScanId;
  /** When the scan runs (injected clock). */
  readonly detectedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// The typed thresholds + gates of the detection rules (documentation
// constants — the tests pin them; nothing here is tunable at runtime
// because an unexplained knob would be a black box).
// ---------------------------------------------------------------------------

/** Constructive-change severity thresholds (share of the contracted value). */
export const CONSTRUCTIVE_SHARE_THRESHOLDS: readonly {
  readonly minShare: Rational;
  readonly level: SeverityLevel;
}[] = [
  { minShare: { numerator: 1, denominator: 2 }, level: 'critical' },
  { minShare: { numerator: 1, denominator: 5 }, level: 'major' },
  { minShare: { numerator: 1, denominator: 20 }, level: 'moderate' },
];

/** Entitlement-rebalance severity thresholds (share of the contracted value). */
export const ENTITLEMENT_SHARE_THRESHOLDS: readonly {
  readonly minShare: Rational;
  readonly level: SeverityLevel;
}[] = [
  { minShare: { numerator: 1, denominator: 2 }, level: 'critical' },
  { minShare: { numerator: 1, denominator: 5 }, level: 'major' },
  { minShare: { numerator: 1, denominator: 20 }, level: 'moderate' },
];

/** Delay-impact severity thresholds (program slip days; minor below the lowest). */
export const DELAY_IMPACT_THRESHOLDS_DAYS: readonly {
  readonly minDays: number;
  readonly level: SeverityLevel;
}[] = [
  { minDays: 20, level: 'critical' },
  { minDays: 10, level: 'major' },
  { minDays: 4, level: 'moderate' },
];

/** The minimum positive program slip that raises a delay-impact candidate (days). */
export const DELAY_IMPACT_MIN_DAYS = 1;

/**
 * The benchmarked approval rate below which NO rebalance candidate fires
 * (a rejection consistent with the historical climate is not a candidate).
 */
export const REBALANCE_MIN_APPROVAL_RATE: Rational = { numerator: 1, denominator: 2 };

/**
 * The benchmarked approval rate at or above which a rejection diverges
 * from the historical climate enough to escalate one severity level.
 */
export const REBALANCE_DIVERGENCE_APPROVAL_RATE: Rational = { numerator: 9, denominator: 10 };

// ---------------------------------------------------------------------------
// Severity helpers (pure, exact-rational).
// ---------------------------------------------------------------------------

const severityByShare = (
  share: Rational,
  thresholds: readonly { readonly minShare: Rational; readonly level: SeverityLevel }[],
): SeverityLevel => {
  for (const threshold of thresholds) {
    if (rationalCompare(share, threshold.minShare) >= 0) return threshold.level;
  }
  return 'minor';
};

const severityByDays = (days: number): SeverityLevel => {
  for (const threshold of DELAY_IMPACT_THRESHOLDS_DAYS) {
    if (days >= threshold.minDays) return threshold.level;
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

const scanContext = (authorization: RecoveryAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

const crossScopeInputRejection = (authorization: RecoveryAuthorization): DomainError =>
  domainError(
    'unauthorized',
    'recovery scan inputs carry records outside the caller\u2019s scope: cross-scope inputs are typed-rejected before any detection (freeze A12)',
    [
      {
        code: 'recovery-input-scope',
        message: 'cross-scope scan inputs are typed-rejected (freeze A12)',
        path: null,
      },
    ],
    scanContext(authorization),
  );

const duplicateInputRejection = (
  family: string,
  id: string,
  authorization: RecoveryAuthorization,
): DomainError =>
  domainError(
    'invariant-violation',
    `the scan input set contains a duplicate ${family} ${id}: an input set is a set`,
    [{ code: 'duplicate-input', message: id, path: family }],
    scanContext(authorization),
  );

// ---------------------------------------------------------------------------
// THE evidence-set qualification gate (the agents discipline — freeze A4).
// ---------------------------------------------------------------------------

/** The tool name the recovery detection cites as every item's retrieval provenance. */
export const RECOVERY_DETECTION_TOOL = 'recovery-candidate-detection';

/** The typed rejection of an empty evidence set (mirrors the agents gate). */
const emptyEvidenceSetFailure = (context?: DomainErrorContext): DomainError =>
  domainError(
    'invariant-violation',
    'a consequential recovery candidate requires a non-empty evidence set (freeze A4)',
    [
      {
        code: 'empty-evidence-set',
        message: 'the candidate grounded on no evidence; unqualified candidates are typed-rejected',
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
 * qualifyEvidenceSet discipline): is this EvidenceSet QUALIFIED to ground a
 * consequential recovery candidate? A qualified set is non-empty AND
 * entirely covered by the scan's scope (structural A12: every item's scope
 * passes the same checkScopeCoversResource every module uses —
 * cross-tenant/cross-project or entity-less items are typed rejections,
 * never silently-dropped or silently-trusted evidence).
 */
export function qualifyRecoveryEvidenceSet(
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
          'the item is outside the scan\u2019s scope and cannot ground a consequential candidate',
          context,
        ),
      );
    }
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// Source-reference helpers (the evidence chain constructors).
// ---------------------------------------------------------------------------

const assessmentSourceOf = (assessment: ImpactAssessment): RecoveryAssessmentSource => ({
  kind: 'assessment',
  assessmentId: assessment.assessmentId,
  assessedAt: assessment.assessedAt,
  sourceEventId: assessment.source.eventId,
  changeEventId: assessment.source.changeEventId,
  contractId: assessment.source.contractId,
});

const changeEventSourceOf = (assessment: ImpactAssessment): RecoveryEventSource => ({
  kind: 'event',
  eventId: assessment.source.eventId,
  eventName: CHANGE_EVENT_RAISED_EVENT,
  occurredAt: assessment.source.occurredAt,
});

const recordSourceOf = (
  recordKind: 'contract' | 'change-event' | 'change-order' | 'claim-reference',
  ref: EntityRef,
  version: number,
  createdAt: Timestamp,
): RecoveryRecordSource => ({
  kind: 'record',
  ref,
  recordKind,
  version,
  createdAt,
});

const eventSourceOf = (reference: {
  readonly eventId: ImpactAssessment['source']['eventId'];
  readonly eventName: ImpactAssessment['evidence'][number]['eventName'];
  readonly occurredAt: Timestamp;
}): RecoveryEventSource => ({
  kind: 'event',
  eventId: reference.eventId,
  eventName: reference.eventName,
  occurredAt: reference.occurredAt,
});

const outcomeSourceOf = (outcome: OutcomeRecord): RecoveryOutcomeSource => ({
  kind: 'outcome',
  outcomeId: outcome.outcomeId,
  recordedAt: outcome.recordedAt,
  projectId: outcome.projectId,
});

const benchmarkSourceOf = (
  benchmark: Benchmark,
  metricKind: Benchmark['metrics'][number]['kind'],
): RecoveryBenchmarkSource => ({
  kind: 'benchmark',
  benchmarkId: benchmark.benchmarkId,
  computedAt: benchmark.computedAt,
  metricKind,
});

/** The benchmark metric lookup: first benchmark (canonical id order) carrying the metric. */
const benchmarkMetricOf = (
  benchmarks: readonly Benchmark[],
  metricKind: Benchmark['metrics'][number]['kind'],
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
  reasons: readonly RecoverySeverityReason[],
): RecoverySeverity => ({
  level,
  reasons: [...new Set<RecoverySeverityReason>(reasons)].sort(),
});

// ---------------------------------------------------------------------------
// The evidence-set items (the agents-typed bundle every candidate carries).
// ---------------------------------------------------------------------------

/** The assessment's own confidence level, carried into the evidence item. */
const itemConfidenceOf = (
  level: ImpactAssessment['confidence']['level'],
): EvidenceItem['confidence'] => level;

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
    confidence: itemConfidenceOf(assessment.confidence.level),
    retrieval: { tool: RECOVERY_DETECTION_TOOL, query, retrievedAt: detectedAt },
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
    retrieval: { tool: RECOVERY_DETECTION_TOOL, query, retrievedAt: detectedAt },
  };
};

/** Build the candidate's complete EvidenceSet (assessment + outcomes, canonical order). */
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
// THE three detection rules. Each rule is a pure function of ONE admitted
// assessment (+ its canonical change event/order records + the historical
// basis) into at most one candidate PARTS value of its kind, with the
// complete evidence chain; the scan engine then stamps the deterministic
// identity.
// ---------------------------------------------------------------------------

/** The unstamped parts of one detected candidate (identity comes from the scan). */
interface CandidateParts {
  readonly kind: RecoveryKind;
  readonly assessment: ImpactAssessment;
  readonly changeEvent: ChangeEventState;
  readonly title: string;
  readonly referencedRecords: readonly EntityRef[];
  readonly severity: RecoverySeverity;
  readonly economicBasis: RecoveryEconomicBasis;
  readonly historicalBasis: RecoveryHistoricalBasis;
  readonly evidence: readonly RecoveryEvidence[];
  readonly evidenceSet: EvidenceSet;
}

interface RuleContext {
  readonly changeEventOf: ReadonlyMap<EntityId, ChangeEventState>;
  readonly contractOf: ReadonlyMap<EntityId, ContractState>;
  readonly ordersOf: ReadonlyMap<EntityId, readonly ChangeOrderState[]>;
  /** The change-order ids already pinned by claim references (idempotence). */
  readonly claimedChangeOrderIds: ReadonlySet<EntityId>;
  readonly outcomes: readonly OutcomeRecord[];
  readonly benchmarks: readonly Benchmark[];
  readonly detectedAt: Timestamp;
  readonly consumed: {
    readonly contractCount: number;
    readonly changeEventCount: number;
    readonly changeOrderCount: number;
    readonly claimReferenceCount: number;
    readonly assessmentCount: number;
    readonly outcomeCount: number;
    readonly benchmarkCount: number;
  };
}

/** Has a claim reference already pinned any order originating from this change event? */
const assertionAlreadyPinned = (
  context: RuleContext,
  changeEventId: EntityId,
): boolean => {
  const orders = context.ordersOf.get(changeEventId) ?? [];
  return orders.some((order) => context.claimedChangeOrderIds.has(order.entityId));
};

/** Rule 1 — constructive change: performed work with NO change order claiming it. */
const detectConstructiveChange = (
  context: RuleContext,
  assessment: ImpactAssessment,
): CandidateParts | null => {
  const changeEvent = context.changeEventOf.get(assessment.source.changeEventId);
  if (changeEvent === undefined) return null;
  if (changeEvent.status !== 'proposed') return null;
  const orders = context.ordersOf.get(changeEvent.entityId) ?? [];
  if (orders.length > 0) return null;
  if (assertionAlreadyPinned(context, changeEvent.entityId)) return null;

  const performedMinor = assessment.costImpact.budgetRevisionDeltaMinor;
  if (performedMinor <= 0) return null;

  const contracted = assessment.marginPosition.contractedValue.amountMinor;
  const level: SeverityLevel =
    contracted <= 0
      ? 'critical'
      : severityByShare(
          reduceRecoveryRational({ numerator: performedMinor, denominator: contracted }),
          CONSTRUCTIVE_SHARE_THRESHOLDS,
        );

  const evidence: RecoveryEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
    recordSourceOf('change-event', { entityKind: CHANGE_EVENT_KIND, entityId: changeEvent.entityId }, changeEvent.version, changeEvent.createdAt),
  ];
  const referencedRecords: EntityRef[] = [
    { entityKind: CHANGE_EVENT_KIND, entityId: changeEvent.entityId },
    { entityKind: CONTRACT_KIND, entityId: changeEvent.contractId },
  ];
  const contract = context.contractOf.get(changeEvent.contractId);
  if (contract !== undefined) {
    evidence.push(
      recordSourceOf('contract', { entityKind: CONTRACT_KIND, entityId: contract.entityId }, contract.version, contract.createdAt),
    );
  }
  for (const reference of assessment.costImpact.evidence) {
    evidence.push(eventSourceOf(reference));
  }

  // Historical basis: the completed projects that recovered entitlement
  // value through change orders (the recovery precedent), in canonical
  // outcome-id order — the input array order must never matter (the
  // shuffled-input acceptance).
  const recoveredOutcomes = context.outcomes
    .filter((outcome) => outcome.entitlement.approvedValueMinor > 0)
    .sort((left, right) =>
      left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0,
    );
  for (const outcome of recoveredOutcomes) {
    evidence.push(outcomeSourceOf(outcome));
  }

  return {
    kind: 'constructive-change',
    assessment,
    changeEvent,
    title: `Constructive change indicator: ${performedMinor} minor units of work recorded on change event ${changeEvent.entityId} with no change order`,
    referencedRecords,
    severity: severityOf(level, ['constructive-cost-share']),
    economicBasis: {
      amountMinor: performedMinor,
      currency: assessment.marginPosition.currency,
      citedFrom: 'assessment-cost-impact-budget-revision-delta',
      assessmentIds: [assessment.assessmentId],
    },
    historicalBasis: {
      outcomeIds: recoveredOutcomes.map((outcome) => outcome.outcomeId),
      benchmarks: [],
    },
    evidence,
    evidenceSet: evidenceSetOf(assessment, recoveredOutcomes, context.detectedAt),
  };
};

/** Rule 2 — entitlement rebalance: a rejected documented claim diverging from history. */
const detectEntitlementRebalance = (
  context: RuleContext,
  assessment: ImpactAssessment,
): CandidateParts | null => {
  const changeEvent = context.changeEventOf.get(assessment.source.changeEventId);
  if (changeEvent === undefined) return null;
  if (changeEvent.evidenceLinks.length === 0) return null;
  if (assertionAlreadyPinned(context, changeEvent.entityId)) return null;

  const rejectedWithValue = (context.ordersOf.get(changeEvent.entityId) ?? [])
    .filter(
      (order) =>
        order.status === 'rejected' &&
        order.changeValue !== null &&
        order.changeValue.amount > 0,
    )
    .sort((left, right) =>
      left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
    );
  const order = rejectedWithValue[0];
  if (order === undefined) return null;

  // The historical gate: only a rejection that diverges from the benchmarked
  // approval climate is a candidate (fail-closed without the benchmark fact).
  const approvalMetric = benchmarkMetricOf(context.benchmarks, 'entitlement-approval-rate');
  if (approvalMetric === null) return null;
  if (rationalCompare(approvalMetric.metric.mean, REBALANCE_MIN_APPROVAL_RATE) < 0) return null;

  const rejectedMinor = order.changeValue?.amount ?? 0;
  // The cited currency is validated through the economic basis's own
  // grammar (the domain record's currency is already canonical — a value
  // that cannot parse is a malformed citation that grounds no candidate).
  const citedCurrencyRaw = order.changeValue?.currency;
  const citedCurrency =
    citedCurrencyRaw === undefined ? null : parseCurrencyCode(citedCurrencyRaw);
  if (citedCurrency !== null && !citedCurrency.ok) return null;
  const currency: CurrencyCode =
    citedCurrency === null ? assessment.marginPosition.currency : citedCurrency.value;
  const contracted = assessment.marginPosition.contractedValue.amountMinor;
  let level: SeverityLevel;
  if (contracted <= 0) {
    level = 'critical';
  } else {
    level = severityByShare(
      reduceRecoveryRational({ numerator: rejectedMinor, denominator: contracted }),
      ENTITLEMENT_SHARE_THRESHOLDS,
    );
  }
  const reasons: RecoverySeverityReason[] = ['entitlement-rejected-share'];
  if (
    rationalCompare(approvalMetric.metric.mean, REBALANCE_DIVERGENCE_APPROVAL_RATE) >= 0
  ) {
    level = escalate(level);
    reasons.push('benchmark-approval-rate-divergence');
  }

  const evidence: RecoveryEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
    recordSourceOf('change-event', { entityKind: CHANGE_EVENT_KIND, entityId: changeEvent.entityId }, changeEvent.version, changeEvent.createdAt),
    recordSourceOf('change-order', { entityKind: CHANGE_ORDER_KIND, entityId: order.entityId }, order.version, order.createdAt),
  ];
  const referencedRecords: EntityRef[] = [
    { entityKind: CHANGE_EVENT_KIND, entityId: changeEvent.entityId },
    { entityKind: CONTRACT_KIND, entityId: changeEvent.contractId },
    { entityKind: CHANGE_ORDER_KIND, entityId: order.entityId },
  ];
  const contract = context.contractOf.get(changeEvent.contractId);
  if (contract !== undefined) {
    evidence.push(
      recordSourceOf('contract', { entityKind: CONTRACT_KIND, entityId: contract.entityId }, contract.version, contract.createdAt),
    );
  }
  // The submission + decision events behind the rejected position (cited
  // from the assessment's own entitlement evidence, never re-derived).
  const entitlementOrder = assessment.entitlementImpact.orders.find(
    (candidate) => candidate.changeOrderId === order.entityId,
  );
  if (entitlementOrder !== undefined) {
    evidence.push(eventSourceOf(entitlementOrder.submissionSource));
    if (entitlementOrder.decisionSource !== null) {
      evidence.push(eventSourceOf(entitlementOrder.decisionSource));
    }
  }

  // Historical basis: the benchmarked approval climate + its producing outcomes.
  const outcomeOf = new Map<string, OutcomeRecord>(
    context.outcomes.map((outcome) => [outcome.outcomeId as string, outcome]),
  );
  const producingOutcomes = approvalMetric.metric.outcomeIds
    .map((outcomeId) => outcomeOf.get(outcomeId))
    .filter((outcome): outcome is OutcomeRecord => outcome !== undefined);
  evidence.push(benchmarkSourceOf(approvalMetric.benchmark, 'entitlement-approval-rate'));
  for (const outcome of producingOutcomes) {
    evidence.push(outcomeSourceOf(outcome));
  }

  return {
    kind: 'entitlement-rebalance',
    assessment,
    changeEvent,
    title: `Entitlement rebalance candidate: rejected change order ${order.entityId} of ${rejectedMinor} minor units with documented evidence`,
    referencedRecords,
    severity: severityOf(level, reasons),
    economicBasis: {
      amountMinor: rejectedMinor,
      currency,
      citedFrom: 'change-order-submitted-value',
      assessmentIds: [assessment.assessmentId],
    },
    historicalBasis: {
      outcomeIds: producingOutcomes.map((outcome) => outcome.outcomeId),
      benchmarks: [
        { benchmarkId: approvalMetric.benchmark.benchmarkId, metricKind: 'entitlement-approval-rate' },
      ],
    },
    evidence,
    evidenceSet: evidenceSetOf(assessment, producingOutcomes, context.detectedAt),
  };
};

/** Rule 3 — delay impact: an unconverted program delay with no claiming order. */
const detectDelayImpact = (
  context: RuleContext,
  assessment: ImpactAssessment,
): CandidateParts | null => {
  const changeEvent = context.changeEventOf.get(assessment.source.changeEventId);
  if (changeEvent === undefined) return null;
  if (changeEvent.status !== 'proposed') return null;
  const orders = context.ordersOf.get(changeEvent.entityId) ?? [];
  if (orders.length > 0) return null;
  if (assertionAlreadyPinned(context, changeEvent.entityId)) return null;

  const slipDays = assessment.scheduleImpact.projectDurationDelta;
  if (slipDays < DELAY_IMPACT_MIN_DAYS) return null;

  const reasons: RecoverySeverityReason[] = ['delay-impact-days'];
  let level = severityByDays(slipDays);
  const citedBenchmarks: {
    readonly benchmarkId: BenchmarkId;
    readonly metricKind: 'schedule-variance-days';
  }[] = [];
  const producingOutcomes: OutcomeRecord[] = [];
  const evidence: RecoveryEvidence[] = [
    assessmentSourceOf(assessment),
    changeEventSourceOf(assessment),
    recordSourceOf('change-event', { entityKind: CHANGE_EVENT_KIND, entityId: changeEvent.entityId }, changeEvent.version, changeEvent.createdAt),
  ];
  const referencedRecords: EntityRef[] = [
    { entityKind: CHANGE_EVENT_KIND, entityId: changeEvent.entityId },
    { entityKind: CONTRACT_KIND, entityId: changeEvent.contractId },
  ];
  const contract = context.contractOf.get(changeEvent.contractId);
  if (contract !== undefined) {
    evidence.push(
      recordSourceOf('contract', { entityKind: CONTRACT_KIND, entityId: contract.entityId }, contract.version, contract.createdAt),
    );
  }
  for (const driver of assessment.scheduleImpact.drivers) {
    evidence.push(eventSourceOf(driver));
  }

  // Historical basis: the benchmarked schedule-variance envelope + its
  // producing outcomes (a slip beyond the benchmarked p90 escalates one
  // severity level, with the benchmark cited in the chain).
  const varianceMetric = benchmarkMetricOf(context.benchmarks, 'schedule-variance-days');
  if (varianceMetric !== null) {
    const slip = reduceRecoveryRational({ numerator: slipDays, denominator: 1 });
    if (rationalCompare(slip, varianceMetric.metric.percentile90) > 0) {
      level = escalate(level);
      reasons.push('benchmark-beyond-percentile90');
    }
    citedBenchmarks.push({
      benchmarkId: varianceMetric.benchmark.benchmarkId,
      metricKind: 'schedule-variance-days',
    });
    evidence.push(benchmarkSourceOf(varianceMetric.benchmark, 'schedule-variance-days'));
    const outcomeOf = new Map<string, OutcomeRecord>(
      context.outcomes.map((outcome) => [outcome.outcomeId as string, outcome]),
    );
    for (const outcomeId of varianceMetric.metric.outcomeIds) {
      const outcome = outcomeOf.get(outcomeId);
      if (outcome !== undefined) {
        evidence.push(outcomeSourceOf(outcome));
        producingOutcomes.push(outcome);
      }
    }
  }

  return {
    kind: 'delay-impact',
    assessment,
    changeEvent,
    title: `Delay impact candidate: ${slipDays}-day program delay on change event ${changeEvent.entityId} with no change order`,
    referencedRecords,
    severity: severityOf(level, reasons),
    economicBasis: {
      amountMinor: null,
      currency: null,
      citedFrom: 'none',
      assessmentIds: [assessment.assessmentId],
    },
    historicalBasis: {
      outcomeIds: producingOutcomes.map((outcome) => outcome.outcomeId),
      benchmarks: citedBenchmarks,
    },
    evidence,
    evidenceSet: evidenceSetOf(assessment, producingOutcomes, context.detectedAt),
  };
};

// ---------------------------------------------------------------------------
// THE scan engine.
// ---------------------------------------------------------------------------

const stampCandidate = (
  parts: CandidateParts,
  scanParts: ScanParts,
  ordinal: number,
  consumed: RuleContext['consumed'],
  actor: CandidateRecovery['actor'],
): CandidateRecovery => {
  const candidateId = `${scanParts.scanId}#${String(ordinal).padStart(4, '0')}` as CandidateRecovery['candidateId'];
  const provenance: DetectionProvenance = {
    scanId: scanParts.scanId,
    detectedAt: scanParts.detectedAt,
    consumed: { ...consumed },
  };
  return {
    candidateId,
    candidateVersion: CANDIDATE_SCHEMA_VERSION,
    engine: RECOVERY_ENGINE,
    detectedAt: scanParts.detectedAt,
    actor,
    scope: parts.changeEvent.scope,
    kind: parts.kind,
    title: parts.title,
    referencedRecords: [...parts.referencedRecords]
      .filter(
        (ref, index, all) =>
          all.findIndex(
            (other) => other.entityKind === ref.entityKind && other.entityId === ref.entityId,
          ) === index,
      )
      .sort(compareReferencedRecords),
    severity: parts.severity,
    economicBasis: parts.economicBasis,
    historicalBasis: parts.historicalBasis,
    evidence: canonicalRecoveryEvidence(parts.evidence),
    evidenceSet: parts.evidenceSet,
    provenance,
    primarySource: {
      eventId: parts.assessment.source.eventId,
      eventName: CHANGE_EVENT_RAISED_EVENT,
      occurredAt: parts.assessment.source.occurredAt,
      correlationId: parts.assessment.source.correlationId,
    },
  };
};

/**
 * THE deterministic detection pass over (the contracts model + assessments
 * + outcomes + benchmarks): the candidate recovery set. Authorization runs
 * BEFORE any input is read (capability gate first, A12 scope coverage
 * second, policy exclusion third); the detection rules then compute every
 * candidate with its full evidence chain and its qualified EvidenceSet.
 * Same inputs + same authorization + same scan identity → the
 * byte-identical candidate set (A7).
 */
export function detectRecoveryCandidates(
  inputs: RecoveryScanInputs,
  authorization: RecoveryAuthorization,
  parts: ScanParts,
): Result<readonly CandidateRecovery[], DomainError> {
  // 1. Capability gate — before ANY input is read.
  const capabilities = checkRecoveryCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  // 2. Duplicate input identities are a caller wiring error (a set is a set).
  const seenAssessmentIds = new Set<string>();
  for (const assessment of inputs.assessments) {
    if (seenAssessmentIds.has(assessment.assessmentId)) {
      return fail(
        duplicateInputRejection('assessment', assessment.assessmentId, authorization),
      );
    }
    seenAssessmentIds.add(assessment.assessmentId);
  }
  const seenChangeEventIds = new Set<string>();
  for (const changeEvent of inputs.changeEvents) {
    if (seenChangeEventIds.has(changeEvent.entityId)) {
      return fail(duplicateInputRejection('change event', changeEvent.entityId, authorization));
    }
    seenChangeEventIds.add(changeEvent.entityId);
  }
  const seenChangeOrderIds = new Set<string>();
  for (const order of inputs.changeOrders) {
    if (seenChangeOrderIds.has(order.entityId)) {
      return fail(duplicateInputRejection('change order', order.entityId, authorization));
    }
    seenChangeOrderIds.add(order.entityId);
  }
  const seenContractIds = new Set<string>();
  for (const contract of inputs.contracts) {
    if (seenContractIds.has(contract.entityId)) {
      return fail(duplicateInputRejection('contract', contract.entityId, authorization));
    }
    seenContractIds.add(contract.entityId);
  }

  // 3. Structural scope coverage of every input (A12 — typed rejection,
  //    never an existence oracle: the rejection never names the foreign scope).
  for (const contract of inputs.contracts) {
    const covered = checkRecoveryScopeCovers(authorization, {
      scope: contract.scope,
      entityKind: CONTRACT_KIND,
      entityId: contract.entityId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const changeEvent of inputs.changeEvents) {
    const covered = checkRecoveryScopeCovers(authorization, {
      scope: changeEvent.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: changeEvent.entityId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const order of inputs.changeOrders) {
    const covered = checkRecoveryScopeCovers(authorization, {
      scope: order.scope,
      entityKind: CHANGE_ORDER_KIND,
      entityId: order.entityId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const claimReference of inputs.claimReferences) {
    const covered = checkRecoveryScopeCovers(authorization, {
      scope: claimReference.scope,
      entityKind: CLAIM_REFERENCE_KIND,
      entityId: claimReference.entityId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const assessment of inputs.assessments) {
    const covered = checkRecoveryScopeCovers(authorization, {
      scope: assessment.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: assessment.source.changeEventId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const outcome of inputs.outcomes) {
    const covered = checkRecoveryScopeCovers(authorization, {
      scope: outcome.scope,
      entityKind: PROJECT_KIND,
      entityId: outcome.projectId,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }
  for (const benchmark of inputs.benchmarks) {
    const covered = checkRecoveryScopeCovers(authorization, {
      scope: benchmark.scope,
      entityKind: PROJECT_KIND,
      entityId: null,
    });
    if (!covered.ok) return fail(crossScopeInputRejection(authorization));
  }

  // 4. Policy exclusion: records the caller's policy denies are invisible
  //    to this scan (the set-query precedent — never errors, never served).
  const policyAdmits = (parts: {
    readonly scope: Scope;
    readonly entityKind: Parameters<typeof checkRecoveryPolicy>[1]['entityKind'];
    readonly entityId: EntityId | null;
  }): boolean => checkRecoveryPolicy(authorization, parts).ok;

  const admittedContracts = inputs.contracts.filter((contract) =>
    policyAdmits({ scope: contract.scope, entityKind: CONTRACT_KIND, entityId: contract.entityId }),
  );
  const admittedChangeEvents = inputs.changeEvents.filter((changeEvent) =>
    policyAdmits({
      scope: changeEvent.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: changeEvent.entityId,
    }),
  );
  const admittedChangeOrders = inputs.changeOrders.filter((order) =>
    policyAdmits({ scope: order.scope, entityKind: CHANGE_ORDER_KIND, entityId: order.entityId }),
  );
  const admittedClaimReferences = inputs.claimReferences.filter((claimReference) =>
    policyAdmits({
      scope: claimReference.scope,
      entityKind: CLAIM_REFERENCE_KIND,
      entityId: claimReference.entityId,
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

  // 5. The rule context: canonical lookups over the admitted records.
  const changeEventOf = new Map<EntityId, ChangeEventState>(
    admittedChangeEvents.map((changeEvent) => [changeEvent.entityId, changeEvent] as const),
  );
  const contractOf = new Map<EntityId, ContractState>(
    admittedContracts.map((contract) => [contract.entityId, contract] as const),
  );
  const ordersOf = new Map<EntityId, ChangeOrderState[]>();
  for (const order of admittedChangeOrders) {
    const list = ordersOf.get(order.changeEventId) ?? [];
    list.push(order);
    ordersOf.set(order.changeEventId, list);
  }
  for (const [key, list] of ordersOf) {
    ordersOf.set(
      key,
      [...list].sort((left, right) =>
        left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
      ),
    );
  }
  const claimedChangeOrderIds = new Set<EntityId>(
    admittedClaimReferences.map((claimReference) => claimReference.changeOrderId),
  );
  const context: RuleContext = {
    changeEventOf,
    contractOf,
    ordersOf,
    claimedChangeOrderIds,
    outcomes: admittedOutcomes,
    benchmarks: admittedBenchmarks,
    detectedAt: parts.detectedAt,
    consumed: {
      contractCount: admittedContracts.length,
      changeEventCount: admittedChangeEvents.length,
      changeOrderCount: admittedChangeOrders.length,
      claimReferenceCount: admittedClaimReferences.length,
      assessmentCount: admittedAssessments.length,
      outcomeCount: admittedOutcomes.length,
      benchmarkCount: admittedBenchmarks.length,
    },
  };

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
  const rules: readonly ((
    context: RuleContext,
    assessment: ImpactAssessment,
  ) => CandidateParts | null)[] = [
    detectConstructiveChange,
    detectEntitlementRebalance,
    detectDelayImpact,
  ];
  const detected: CandidateParts[] = [];
  for (const rule of rules) {
    for (const assessment of orderedAssessments) {
      const result = rule(context, assessment);
      if (result !== null) detected.push(result);
    }
  }

  // 7. Stamp the deterministic identities, then qualify every candidate's
  //    evidence set (the agents discipline — an empty or out-of-scope set
  //    is a typed rejection, never a silently-propagated candidate).
  const candidates = detected.map((candidateParts, index) =>
    stampCandidate(
      candidateParts,
      parts,
      index + 1,
      context.consumed,
      authorization.context.actor,
    ),
  );
  for (const candidate of candidates) {
    const qualified = qualifyRecoveryEvidenceSet(
      candidate.evidenceSet,
      authorization.context.scope,
      scanContext(authorization),
    );
    if (!qualified.ok) return qualified;
  }
  return ok(candidates);
}
