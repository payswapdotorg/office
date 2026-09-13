// Office intelligence — golden recovery scenarios (OFF-033, package-internal).
//
// Deterministic fixtures for THE named acceptance of the revenue recovery
// engine: the golden seeded portfolio — a CONSTRUCTIVE CHANGE (work
// performed and recorded against a change event with NO change order
// claiming it), an ENTITLEMENT REBALANCE (a rejected documented change
// order in a historically approving climate), and a DELAY IMPACT (an
// unconverted program delay beyond the benchmarked schedule-variance
// envelope) — scanned together with the completed-project history (three
// outcome records + the tenant benchmark computed over them). The same
// builders always reproduce the identical inputs (fixed ids, fixed clock,
// fixed correlation/causation tokens), so the scan + ranking over them is
// byte-identical across runs and input orderings — the acceptance test.
//
// The contracts-domain records are built through the domain package's OWN
// pure transitions (createContractState / createChangeEventState /
// createChangeOrderState / rejectChangeOrderState — the canonical model,
// never hand-rolled state shapes). The margin assessments and memory
// outcome/benchmark records are the engine's INPUTS (produced upstream by
// the intelligence peers); they are supplied here as typed fixture values
// with fully consistent internal evidence references, exactly as the peers
// would record them.
import type { EntityId, Timestamp } from '@office/contracts';
import type { CurrencyCode, ImpactAssessment } from '@office/intelligence-margin';
import {
  ASSESSMENT_ENGINE,
  ASSESSMENT_REQUIRED_CAPABILITY_NAMES,
  ASSESSMENT_SCHEMA_VERSION,
  parseCurrencyCode,
} from '@office/intelligence-margin';
import {
  BENCHMARK_SCHEMA_VERSION,
  MEMORY_ENGINE,
  OUTCOME_SCHEMA_VERSION,
} from '@office/intelligence-memory';
import type { Benchmark, OutcomeRecord } from '@office/intelligence-memory';
import {
  createChangeEventState,
  createChangeOrderState,
  createContractState,
  parseMoney,
  parsePartyLink,
  rejectChangeOrderState,
} from '@office/domain-contracts';
import type {
  ChangeEventState,
  ChangeOrderState,
  ContractState,
} from '@office/domain-contracts';
import {
  ASSESSED_AT,
  COMPUTED_AT,
  DETECTED_AT,
  RECORDED_AT,
  T0,
  T1,
  T2,
  T3,
  PROJECT_2,
  sourceRef,
  tenantReader,
  testAssessmentId,
  testBenchmarkId,
  testCorrelationId,
  testId,
  testLedgerEventId,
  testOutcomeId,
  testScanId,
  unwrap,
  USER_ACTOR,
  projectOneScope,
  projectTwoScope,
  tenantAScope,
} from './test-support';
import { detectRecoveryCandidates } from './detection';
import { rankRecoveryCandidates } from './prioritization';
import type { CandidateRecovery, RankedCandidate } from './candidates';

// ----- shared deterministic ids -----------------------------------------------------

// Scenario 1 — the constructive change (project 1).
export const CONSTRUCTIVE_CONTRACT = testId('con', 1);
export const CONSTRUCTIVE_BUDGET = testId('bud', 1);
export const CONSTRUCTIVE_COST_ITEM = testId('cst', 1);
export const CONSTRUCTIVE_BUDGET_REVISION = testId('brv', 1);
export const CONSTRUCTIVE_DOCUMENT = testId('doc', 1);
export const CONSTRUCTIVE_REVISION = testId('rev', 1);
export const CONSTRUCTIVE_CHANGE_EVENT = testId('chg', 1);
export const CONSTRUCTIVE_RAISED_EVENT = testLedgerEventId(101);
export const CONSTRUCTIVE_COST_ITEM_EVENT = testLedgerEventId(102);
export const CONSTRUCTIVE_BUDGET_REVISED_EVENT = testLedgerEventId(103);
export const CONSTRUCTIVE_CONTRACT_EVENT = testLedgerEventId(104);

// Scenario 2 — the entitlement rebalance (project 1).
export const REBALANCE_CONTRACT = testId('con', 2);
export const REBALANCE_BUDGET = testId('bud', 2);
export const REBALANCE_DOCUMENT = testId('doc', 2);
export const REBALANCE_REVISION = testId('rev', 2);
export const REBALANCE_CHANGE_EVENT = testId('chg', 2);
export const REJECTED_ORDER = testId('ord', 21);
export const REBALANCE_CONTRACT_EVENT = testLedgerEventId(201);
export const REBALANCE_RAISED_EVENT = testLedgerEventId(202);
export const REJECTED_SUBMISSION_EVENT = testLedgerEventId(203);
export const REJECTED_DECISION_EVENT = testLedgerEventId(204);

// Scenario 3 — the delay impact (project 1).
export const DELAY_CONTRACT = testId('con', 3);
export const DELAY_DOCUMENT = testId('doc', 3);
export const DELAY_REVISION = testId('rev', 3);
export const DELAY_CHANGE_EVENT = testId('chg', 3);
export const DELAY_ACTIVITY_1 = testId('act', 31);
export const DELAY_ACTIVITY_2 = testId('act', 32);
export const DELAY_CONTRACT_EVENT = testLedgerEventId(301);
export const DELAY_RAISED_EVENT = testLedgerEventId(302);
export const DELAY_ACTIVITY_UPDATED_EVENT = testLedgerEventId(303);
export const DELAY_PROGRESS_EVENT = testLedgerEventId(304);

// The completed-project history (project 2, tenant A): three finished
// projects with schedule variances 4, 6, 9 days and entitlement approval
// rates 3/4, 4/5, 9/10 (approved value recovered through change orders).
const HISTORY_VARIANCE_DAYS: readonly number[] = [4, 6, 9];
const HISTORY_APPROVAL_RATES: readonly { readonly numerator: number; readonly denominator: number }[] = [
  { numerator: 3, denominator: 4 },
  { numerator: 4, denominator: 5 },
  { numerator: 9, denominator: 10 },
];
const HISTORY_APPROVED_VALUE_MINOR: readonly number[] = [300_000, 1_200_000, 2_000_000];

const moneyOf = (amountMinor: number) => unwrap(parseMoney({ amount: amountMinor, currency: 'USD' }));

/** The single currency of every golden fixture (margin's own typed grammar). */
const USD: CurrencyCode = unwrap(parseCurrencyCode('USD'));

const personOf = (n: number) =>
  unwrap(parsePartyLink({ entityKind: 'person', entityId: testId('per', n) }));
const companyOf = (n: number) =>
  unwrap(parsePartyLink({ entityKind: 'company', entityId: testId('com', n) }));

// ---------------------------------------------------------------------------
// The contracts-domain records (the domain package's OWN pure transitions).
// ---------------------------------------------------------------------------

/** Build one executed contract of the golden portfolio (project 1). */
const contractOf = (n: number, title: string, valueMinor: number): ContractState =>
  unwrap(
    createContractState(
      {
        contractId: testId('con', n),
        title,
        owner: personOf(n),
        contractor: companyOf(n),
        contractValue: moneyOf(valueMinor),
        executionStatus: 'executed',
        now: T0,
      },
      projectOneScope(),
    ),
  );

/** Build one proposed change event of the golden portfolio (project 1). */
const changeEventOf = (
  n: number,
  title: string,
  links: {
    readonly evidenceLinks?: readonly { readonly documentId: EntityId; readonly revisionId: EntityId }[];
    readonly costImpactLinks?: readonly { readonly budgetId: EntityId; readonly costItemId: EntityId | null }[];
    readonly scheduleImpactActivityIds?: readonly EntityId[];
  },
): ChangeEventState =>
  unwrap(
    createChangeEventState(
      {
        changeEventId: testId('chg', n),
        title,
        changeType: 'modification',
        links,
        now: T1,
      },
      projectOneScope(),
      testId('con', n),
    ),
  );

// ---------------------------------------------------------------------------
// The margin assessment fixtures (the economic basis — typed input values).
// ---------------------------------------------------------------------------

/** The shared defaults of the golden assessment fixtures. */
const assessmentFixture = (parts: {
  readonly n: number;
  readonly contractId: EntityId;
  readonly changeEventId: EntityId;
  readonly changeEventTitle: string;
  readonly evidenceLinks: readonly { readonly documentId: EntityId; readonly revisionId: EntityId }[];
  readonly raisedEvent: { readonly id: ReturnType<typeof testLedgerEventId>; readonly at: Timestamp };
  readonly contractEvent: { readonly id: ReturnType<typeof testLedgerEventId> };
  readonly costImpact: ImpactAssessment['costImpact'];
  readonly scheduleImpact: ImpactAssessment['scheduleImpact'];
  readonly entitlementImpact: ImpactAssessment['entitlementImpact'];
  readonly marginPosition: ImpactAssessment['marginPosition'];
  readonly extraEvidence: readonly ImpactAssessment['evidence'][number][];
}): ImpactAssessment => ({
  assessmentId: testAssessmentId(parts.n),
  assessmentVersion: ASSESSMENT_SCHEMA_VERSION,
  engine: ASSESSMENT_ENGINE,
  assessedAt: ASSESSED_AT,
  actor: USER_ACTOR,
  scope: projectOneScope(),
  query: { sourceEventId: parts.raisedEvent.id },
  source: {
    eventId: parts.raisedEvent.id,
    changeEventId: parts.changeEventId,
    contractId: parts.contractId,
    title: parts.changeEventTitle,
    changeType: 'modification',
    evidenceLinks: parts.evidenceLinks,
    scope: projectOneScope(),
    actor: USER_ACTOR,
    occurredAt: parts.raisedEvent.at,
    correlationId: testCorrelationId(parts.n),
  },
  consumed: {
    projectedEventCount: 4,
    subgraphNodeCount: 4,
    subgraphEdgeCount: 3,
  },
  costImpact: parts.costImpact,
  scheduleImpact: parts.scheduleImpact,
  entitlementImpact: parts.entitlementImpact,
  marginPosition: parts.marginPosition,
  confidence: { level: 'high', reasons: ['complete-inputs'] },
  policyContext: {
    capabilities: [...ASSESSMENT_REQUIRED_CAPABILITY_NAMES],
    requiredCapabilities: [...ASSESSMENT_REQUIRED_CAPABILITY_NAMES],
    policyRuleCount: 1,
    decision: 'allow',
  },
  evidence: [sourceRef(parts.contractEvent.id, 'contracts.contractCreated', T0), ...parts.extraEvidence],
});

const emptyCostImpact = (): ImpactAssessment['costImpact'] => ({
  budgetRevisionDeltaMinor: 0,
  itemDeltas: [],
  revisionAnchors: [],
  evidence: [],
});

const emptyScheduleImpact = (): ImpactAssessment['scheduleImpact'] => ({
  activityDeltas: [],
  projectDurationDelta: 0,
  preProjectDuration: 0,
  currentProjectDuration: 0,
  drivers: [],
  basisAnchors: [],
  evidence: [],
});

const emptyEntitlementImpact = (): ImpactAssessment['entitlementImpact'] => ({
  status: 'none',
  orders: [],
  approvedValueMinor: 0,
  rejectedValueMinor: 0,
  pendingValueMinor: 0,
  evidence: [],
});

/** Scenario 1's assessment: 750,000 minor units of work recorded, no schedule impact. */
export const CONSTRUCTIVE_ASSESSMENT: ImpactAssessment = assessmentFixture({
  n: 1,
  contractId: CONSTRUCTIVE_CONTRACT,
  changeEventId: CONSTRUCTIVE_CHANGE_EVENT,
  changeEventTitle: 'Unforeseen groundwater dewatering',
  evidenceLinks: [
    { documentId: CONSTRUCTIVE_DOCUMENT, revisionId: CONSTRUCTIVE_REVISION },
  ],
  raisedEvent: { id: CONSTRUCTIVE_RAISED_EVENT, at: T1 },
  contractEvent: { id: CONSTRUCTIVE_CONTRACT_EVENT },
  costImpact: {
    budgetRevisionDeltaMinor: 750_000,
    itemDeltas: [
      {
        budgetId: CONSTRUCTIVE_BUDGET,
        costItemId: CONSTRUCTIVE_COST_ITEM,
        amountMinor: 750_000,
        source: sourceRef(CONSTRUCTIVE_COST_ITEM_EVENT, 'cost.costItemRecorded', T2),
      },
    ],
    revisionAnchors: [
      {
        budgetId: CONSTRUCTIVE_BUDGET,
        revisionId: CONSTRUCTIVE_BUDGET_REVISION,
        source: sourceRef(CONSTRUCTIVE_BUDGET_REVISED_EVENT, 'cost.budgetRevised', T2),
      },
    ],
    evidence: [
      sourceRef(CONSTRUCTIVE_COST_ITEM_EVENT, 'cost.costItemRecorded', T2),
      sourceRef(CONSTRUCTIVE_BUDGET_REVISED_EVENT, 'cost.budgetRevised', T2),
    ],
  },
  scheduleImpact: emptyScheduleImpact(),
  entitlementImpact: emptyEntitlementImpact(),
  marginPosition: {
    contractedValue: {
      amountMinor: 8_000_000,
      evidence: [sourceRef(CONSTRUCTIVE_CONTRACT_EVENT, 'contracts.contractCreated', T0)],
    },
    committedCost: {
      amountMinor: 750_000,
      evidence: [sourceRef(CONSTRUCTIVE_COST_ITEM_EVENT, 'cost.costItemRecorded', T2)],
    },
    budgetedCost: { amountMinor: 0, evidence: [] },
    projectedCost: {
      amountMinor: 750_000,
      evidence: [
        sourceRef(CONSTRUCTIVE_COST_ITEM_EVENT, 'cost.costItemRecorded', T2),
        sourceRef(CONSTRUCTIVE_BUDGET_REVISED_EVENT, 'cost.budgetRevised', T2),
      ],
    },
    marginMinor: 7_250_000,
    marginOverCommittedMinor: 7_250_000,
    currency: USD,
  },
  extraEvidence: [
    sourceRef(CONSTRUCTIVE_COST_ITEM_EVENT, 'cost.costItemRecorded', T2),
    sourceRef(CONSTRUCTIVE_BUDGET_REVISED_EVENT, 'cost.budgetRevised', T2),
  ],
});

/** Scenario 2's assessment: the rejected order's entitlement position. */
export const REBALANCE_ASSESSMENT: ImpactAssessment = assessmentFixture({
  n: 2,
  contractId: REBALANCE_CONTRACT,
  changeEventId: REBALANCE_CHANGE_EVENT,
  changeEventTitle: 'Temporary crane exclusion rework',
  evidenceLinks: [
    { documentId: REBALANCE_DOCUMENT, revisionId: REBALANCE_REVISION },
  ],
  raisedEvent: { id: REBALANCE_RAISED_EVENT, at: T1 },
  contractEvent: { id: REBALANCE_CONTRACT_EVENT },
  costImpact: emptyCostImpact(),
  scheduleImpact: emptyScheduleImpact(),
  entitlementImpact: {
    status: 'rejected',
    orders: [
      {
        changeOrderId: REJECTED_ORDER,
        valueMinor: 2_500_000,
        currency: USD,
        status: 'rejected',
        submissionSource: sourceRef(REJECTED_SUBMISSION_EVENT, 'contracts.changeOrderSubmitted', T2),
        decisionSource: sourceRef(REJECTED_DECISION_EVENT, 'contracts.changeOrderRejected', T3),
        claims: [],
      },
    ],
    approvedValueMinor: 0,
    rejectedValueMinor: 2_500_000,
    pendingValueMinor: 0,
    evidence: [
      sourceRef(REJECTED_SUBMISSION_EVENT, 'contracts.changeOrderSubmitted', T2),
      sourceRef(REJECTED_DECISION_EVENT, 'contracts.changeOrderRejected', T3),
    ],
  },
  marginPosition: {
    contractedValue: {
      amountMinor: 12_500_000,
      evidence: [sourceRef(REBALANCE_CONTRACT_EVENT, 'contracts.contractCreated', T0)],
    },
    committedCost: { amountMinor: 0, evidence: [] },
    budgetedCost: { amountMinor: 0, evidence: [] },
    projectedCost: { amountMinor: 0, evidence: [] },
    marginMinor: 12_500_000,
    marginOverCommittedMinor: 12_500_000,
    currency: USD,
  },
  extraEvidence: [
    sourceRef(REJECTED_SUBMISSION_EVENT, 'contracts.changeOrderSubmitted', T2),
    sourceRef(REJECTED_DECISION_EVENT, 'contracts.changeOrderRejected', T3),
  ],
});

/** Scenario 3's assessment: a 12-day program delay, no cost response yet. */
export const DELAY_ASSESSMENT: ImpactAssessment = assessmentFixture({
  n: 3,
  contractId: DELAY_CONTRACT,
  changeEventId: DELAY_CHANGE_EVENT,
  changeEventTitle: 'Utility relocation delay',
  evidenceLinks: [
    { documentId: DELAY_DOCUMENT, revisionId: DELAY_REVISION },
  ],
  raisedEvent: { id: DELAY_RAISED_EVENT, at: T1 },
  contractEvent: { id: DELAY_CONTRACT_EVENT },
  costImpact: emptyCostImpact(),
  scheduleImpact: {
    activityDeltas: [
      {
        activityId: DELAY_ACTIVITY_1,
        code: 'A-031',
        earlyStartDelta: 4,
        earlyFinishDelta: 12,
        drivers: [sourceRef(DELAY_ACTIVITY_UPDATED_EVENT, 'schedule.activityUpdated', T2)],
      },
      {
        activityId: DELAY_ACTIVITY_2,
        code: 'A-032',
        earlyStartDelta: 12,
        earlyFinishDelta: 12,
        drivers: [sourceRef(DELAY_PROGRESS_EVENT, 'schedule.progressRecorded', T2)],
      },
    ],
    projectDurationDelta: 12,
    preProjectDuration: 180,
    currentProjectDuration: 192,
    drivers: [
      sourceRef(DELAY_ACTIVITY_UPDATED_EVENT, 'schedule.activityUpdated', T2),
      sourceRef(DELAY_PROGRESS_EVENT, 'schedule.progressRecorded', T2),
    ],
    basisAnchors: [],
    evidence: [
      sourceRef(DELAY_ACTIVITY_UPDATED_EVENT, 'schedule.activityUpdated', T2),
      sourceRef(DELAY_PROGRESS_EVENT, 'schedule.progressRecorded', T2),
    ],
  },
  entitlementImpact: emptyEntitlementImpact(),
  marginPosition: {
    contractedValue: {
      amountMinor: 15_000_000,
      evidence: [sourceRef(DELAY_CONTRACT_EVENT, 'contracts.contractCreated', T0)],
    },
    committedCost: { amountMinor: 0, evidence: [] },
    budgetedCost: { amountMinor: 0, evidence: [] },
    projectedCost: { amountMinor: 0, evidence: [] },
    marginMinor: 15_000_000,
    marginOverCommittedMinor: 15_000_000,
    currency: USD,
  },
  extraEvidence: [
    sourceRef(DELAY_ACTIVITY_UPDATED_EVENT, 'schedule.activityUpdated', T2),
    sourceRef(DELAY_PROGRESS_EVENT, 'schedule.progressRecorded', T2),
  ],
});

// ---------------------------------------------------------------------------
// The completed-project history fixtures (project 2 — the historical basis).
// ---------------------------------------------------------------------------

/** Build one completed-project outcome record of the history (typed fixture). */
const historyOutcomeOf = (n: number): OutcomeRecord => {
  const varianceDays = HISTORY_VARIANCE_DAYS[n - 1] ?? 0;
  const approvalRate = HISTORY_APPROVAL_RATES[n - 1] ?? { numerator: 1, denominator: 1 };
  const approvedValue = HISTORY_APPROVED_VALUE_MINOR[n - 1] ?? 0;
  const approvedCount = approvalRate.numerator;
  const rejectedCount = approvalRate.denominator - approvalRate.numerator;
  return {
    outcomeId: testOutcomeId(n),
    outcomeVersion: OUTCOME_SCHEMA_VERSION,
    engine: MEMORY_ENGINE,
    recordedAt: RECORDED_AT,
    actor: USER_ACTOR,
    scope: projectTwoScope(),
    projectId: PROJECT_2,
    schedule: {
      baselineDurationDays: 120,
      finalDurationDays: 120 + varianceDays,
      varianceDays,
      sources: [
        {
          kind: 'assessment',
          assessmentId: testAssessmentId(9000 + n),
          assessedAt: ASSESSED_AT,
          sourceEventId: testLedgerEventId(9000 + n),
          correlationId: testCorrelationId(9000 + n),
          changeEventId: testId('chg', 900 + n),
          contractId: testId('con', 900 + n),
        },
      ],
    },
    margin: {
      currency: USD,
      originalContractedValueMinor: 10_000_000,
      contractedValueMinor: 10_000_000 + approvedValue,
      committedCostMinor: 9_000_000,
      projectedCostMinor: 9_000_000,
      marginMinor: 1_000_000 + approvedValue,
      marginRatio: { numerator: 1_000_000 + approvedValue, denominator: 10_000_000 + approvedValue },
      perContract: [
        {
          contractId: testId('con', 900 + n),
          assessmentId: testAssessmentId(9000 + n),
          currency: USD,
          contractedValueMinor: 10_000_000 + approvedValue,
          committedCostMinor: 9_000_000,
          projectedCostMinor: 9_000_000,
          marginMinor: 1_000_000 + approvedValue,
          marginRatio: {
            numerator: 1_000_000 + approvedValue,
            denominator: 10_000_000 + approvedValue,
          },
        },
      ],
      sources: [
        {
          kind: 'assessment',
          assessmentId: testAssessmentId(9000 + n),
          assessedAt: ASSESSED_AT,
          sourceEventId: testLedgerEventId(9000 + n),
          correlationId: testCorrelationId(9000 + n),
          changeEventId: testId('chg', 900 + n),
          contractId: testId('con', 900 + n),
        },
      ],
      eventSources: [
        {
          kind: 'event',
          eventId: testLedgerEventId(9500 + n),
          eventName: sourceRef(testLedgerEventId(9500 + n), 'contracts.contractCreated', T0).eventName,
          occurredAt: T0,
        },
      ],
    },
    entitlement: {
      approvedCount,
      executedCount: 0,
      rejectedCount,
      pendingCount: 0,
      approvedValueMinor: approvedValue,
      rejectedValueMinor: 100_000 * rejectedCount,
      pendingValueMinor: 0,
      approvalRate,
      orders: [],
      eventSources: [
        {
          kind: 'event',
          eventId: testLedgerEventId(9600 + n),
          eventName: sourceRef(testLedgerEventId(9600 + n), 'contracts.changeOrderSubmitted', T2).eventName,
          occurredAt: T2,
        },
      ],
    },
    changePressure: {
      changeEventCount: 4,
      changeOrderCount: approvalRate.denominator,
      contractCount: 1,
      eventSources: [
        {
          kind: 'event',
          eventId: testLedgerEventId(9700 + n),
          eventName: sourceRef(testLedgerEventId(9700 + n), 'contracts.changeEventRaised', T1).eventName,
          occurredAt: T1,
        },
      ],
    },
    consumed: { projectedEventCount: 8, assessmentCount: 1 },
    evidence: [
      {
        kind: 'event',
        eventId: testLedgerEventId(9500 + n),
        eventName: sourceRef(testLedgerEventId(9500 + n), 'contracts.contractCreated', T0).eventName,
        occurredAt: T0,
      },
      {
        kind: 'event',
        eventId: testLedgerEventId(9700 + n),
        eventName: sourceRef(testLedgerEventId(9700 + n), 'contracts.changeEventRaised', T1).eventName,
        occurredAt: T1,
      },
    ],
  };
};

/** The three completed-project outcome records (the historical basis inputs). */
export const HISTORY_OUTCOMES: readonly OutcomeRecord[] = [
  historyOutcomeOf(1),
  historyOutcomeOf(2),
  historyOutcomeOf(3),
];

/**
 * THE tenant-A history benchmark: schedule variances 4, 6, 9 days
 * (p90 = 9) and entitlement approval rates 3/4, 4/5, 9/10 (mean 49/60) —
 * the calibration + gating facts the golden scan consumes.
 */
export const HISTORY_BENCHMARK: Benchmark = {
  benchmarkId: testBenchmarkId(1),
  benchmarkVersion: BENCHMARK_SCHEMA_VERSION,
  engine: MEMORY_ENGINE,
  computedAt: COMPUTED_AT,
  actor: USER_ACTOR,
  scope: tenantAScope(),
  outcomeCount: 3,
  metrics: [
    {
      kind: 'schedule-variance-days',
      outcomeIds: [testOutcomeId(1), testOutcomeId(2), testOutcomeId(3)],
      min: { numerator: 4, denominator: 1 },
      max: { numerator: 9, denominator: 1 },
      mean: { numerator: 19, denominator: 3 },
      median: { numerator: 6, denominator: 1 },
      percentile90: { numerator: 9, denominator: 1 },
    },
    {
      kind: 'entitlement-approval-rate',
      outcomeIds: [testOutcomeId(1), testOutcomeId(2), testOutcomeId(3)],
      min: { numerator: 3, denominator: 4 },
      max: { numerator: 9, denominator: 10 },
      mean: { numerator: 49, denominator: 60 },
      median: { numerator: 4, denominator: 5 },
      percentile90: { numerator: 9, denominator: 10 },
    },
  ],
  positions: [
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(1), position: { numerator: 1, denominator: 6 } },
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(2), position: { numerator: 1, denominator: 2 } },
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(3), position: { numerator: 5, denominator: 6 } },
    { metricKind: 'entitlement-approval-rate', outcomeId: testOutcomeId(1), position: { numerator: 1, denominator: 6 } },
    { metricKind: 'entitlement-approval-rate', outcomeId: testOutcomeId(2), position: { numerator: 1, denominator: 2 } },
    { metricKind: 'entitlement-approval-rate', outcomeId: testOutcomeId(3), position: { numerator: 5, denominator: 6 } },
  ],
};

// ---------------------------------------------------------------------------
// THE golden portfolio scan (the named acceptance).
// ---------------------------------------------------------------------------

/** One full run of the golden recovery pipeline. */
export interface GoldenRecoveryRun {
  /** The golden contracts-domain records (the detection's canonical inputs). */
  readonly contracts: readonly ContractState[];
  readonly changeEvents: readonly ChangeEventState[];
  readonly changeOrders: readonly ChangeOrderState[];
  /** The golden assessments (the economic-basis inputs). */
  readonly assessments: readonly ImpactAssessment[];
  /** The completed-project history (the historical-basis inputs). */
  readonly outcomes: readonly OutcomeRecord[];
  readonly benchmark: Benchmark;
  /** The detected candidate set (canonical emission order). */
  readonly candidates: readonly CandidateRecovery[];
  /** The ranked candidate set (the stable priority order). */
  readonly ranked: readonly RankedCandidate[];
}

/**
 * The golden inputs as one scan-input record (the permutation probes
 * reshuffle these arrays — determinism must not care).
 */
export const goldenInputsOf = (run: GoldenRecoveryRun): {
  readonly contracts: readonly ContractState[];
  readonly changeEvents: readonly ChangeEventState[];
  readonly changeOrders: readonly ChangeOrderState[];
  readonly claimReferences: readonly [];
  readonly assessments: readonly ImpactAssessment[];
  readonly outcomes: readonly OutcomeRecord[];
  readonly benchmarks: readonly Benchmark[];
} => ({
  contracts: run.contracts,
  changeEvents: run.changeEvents,
  changeOrders: run.changeOrders,
  claimReferences: [],
  assessments: run.assessments,
  outcomes: run.outcomes,
  benchmarks: [run.benchmark],
});

/**
 * Run THE golden recovery scan: build the three live scenarios + the
 * completed-project history, detect the candidate set, and rank it with
 * the default seeded weights. Fully deterministic — the same run twice
 * produces byte-identical results.
 */
export const runGoldenRecoveryScan = (): GoldenRecoveryRun => {
  const contracts: readonly ContractState[] = [
    contractOf(1, 'Site enabling package', 8_000_000),
    contractOf(2, 'Structural steel erection', 12_500_000),
    contractOf(3, 'Utility corridor relocation', 15_000_000),
  ];
  const changeEvents: readonly ChangeEventState[] = [
    changeEventOf(1, 'Unforeseen groundwater dewatering', {
      evidenceLinks: [
        { documentId: CONSTRUCTIVE_DOCUMENT, revisionId: CONSTRUCTIVE_REVISION },
      ],
      costImpactLinks: [
        { budgetId: CONSTRUCTIVE_BUDGET, costItemId: CONSTRUCTIVE_COST_ITEM },
      ],
    }),
    changeEventOf(2, 'Temporary crane exclusion rework', {
      evidenceLinks: [
        { documentId: REBALANCE_DOCUMENT, revisionId: REBALANCE_REVISION },
      ],
      costImpactLinks: [{ budgetId: REBALANCE_BUDGET, costItemId: null }],
    }),
    changeEventOf(3, 'Utility relocation delay', {
      evidenceLinks: [{ documentId: DELAY_DOCUMENT, revisionId: DELAY_REVISION }],
      scheduleImpactActivityIds: [DELAY_ACTIVITY_1, DELAY_ACTIVITY_2],
    }),
  ];
  const submittedOrder = unwrap(
    createChangeOrderState(
      {
        changeOrderId: REJECTED_ORDER,
        title: 'Crane exclusion rework order',
        changeValue: moneyOf(2_500_000),
        now: T2,
      },
      projectOneScope(),
      REBALANCE_CONTRACT,
      REBALANCE_CHANGE_EVENT,
    ),
  );
  const changeOrders: readonly ChangeOrderState[] = [
    unwrap(rejectChangeOrderState(submittedOrder, 'Position covered by the base contract', T3)),
  ];
  const assessments: readonly ImpactAssessment[] = [
    CONSTRUCTIVE_ASSESSMENT,
    REBALANCE_ASSESSMENT,
    DELAY_ASSESSMENT,
  ];
  const outcomes = HISTORY_OUTCOMES;
  const benchmark = HISTORY_BENCHMARK;

  const candidates = unwrap(
    detectRecoveryCandidates(
      { contracts, changeEvents, changeOrders, claimReferences: [], assessments, outcomes, benchmarks: [benchmark] },
      tenantReader(),
      { scanId: testScanId(1), detectedAt: DETECTED_AT },
    ),
  );
  const ranked = unwrap(rankRecoveryCandidates(candidates));
  return { contracts, changeEvents, changeOrders, assessments, outcomes, benchmark, candidates, ranked };
};

/** THE pinned stable priority order of the golden scan (kind sequence). */
export const GOLDEN_PRIORITY_ORDER: readonly string[] = [
  'delay-impact',
  'entitlement-rebalance',
  'constructive-change',
];

/** The stable ranked shape of one golden candidate (order assertions). */
export const rankedShapeOf = (ranked: RankedCandidate): {
  readonly rank: number;
  readonly kind: string;
  readonly candidateId: string;
  readonly total: { readonly numerator: number; readonly denominator: number };
} => ({
  rank: ranked.rank,
  kind: ranked.candidate.kind,
  candidateId: ranked.candidate.candidateId,
  total: ranked.score.total,
});
