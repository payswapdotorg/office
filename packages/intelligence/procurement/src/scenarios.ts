// Office intelligence — golden procurement scenarios (OFF-034, package-internal).
//
// Deterministic fixtures for THE named acceptance of the procurement
// optimization engine: the golden seeded sourcing portfolio — a VENDOR
// SWITCH (one challenger quote undercuts the incumbent vendor's own current
// re-quote by a material share of the incumbent path), an ORDER SPLITTING
// (a two-vendor composition covers the need's scope for less than the
// incumbent path), and a LEAD-TIME-DRIVEN TIMING SHIFT (a faster quote pays
// a price premium over the incumbent re-quote yet undercuts the incumbent
// path while avoiding an assessed delay beyond the benchmarked schedule
// variance envelope) — scanned together with the completed-project history
// (six outcome records + the tenant benchmark computed over them). The same
// builders always reproduce the identical inputs (fixed ids, fixed clock,
// fixed correlation/causation tokens), so the scan + ranking over them is
// byte-identical across runs and input orderings — the acceptance test.
//
// The cost-domain records (budgets, basis cost items, incumbent
// commitments) are built through the cost domain's OWN pure transitions
// (createBudgetState / recordCostItemState / createCommitmentState — the
// canonical model, never hand-rolled state shapes). The quoted fulfillment
// alternatives are built through the engine's OWN fail-closed parser
// (parseProcurementAlternative — the honest input path, exactly as a host
// would supply them). The margin assessments and memory outcome/benchmark
// records are the engine's INPUTS (produced upstream by the intelligence
// peers); they are supplied here as typed fixture values with fully
// consistent internal evidence references, exactly as the peers would
// record them.
import type { EntityId } from '@office/contracts';
import type { CurrencyCode, ImpactAssessment } from '@office/intelligence-margin';
import {
  ASSESSMENT_ENGINE,
  ASSESSMENT_REQUIRED_CAPABILITY_NAMES,
  ASSESSMENT_SCHEMA_VERSION,
  parseCurrencyCode as parseMarginCurrencyCode,
} from '@office/intelligence-margin';
import {
  BENCHMARK_SCHEMA_VERSION,
  MEMORY_ENGINE,
  OUTCOME_SCHEMA_VERSION,
} from '@office/intelligence-memory';
import type { Benchmark, OutcomeRecord } from '@office/intelligence-memory';
import {
  createBudgetState,
  createCommitmentState,
  parseCurrencyCode as parseCostCurrencyCode,
  recordCostItemState,
} from '@office/domain-cost';
import type { BudgetState, CommitmentState } from '@office/domain-cost';
import {
  ACTOR_ID,
  ASSESSED_AT,
  COMPUTED_AT,
  DETECTED_AT,
  PROJECT_2,
  RECORDED_AT,
  T0,
  T1,
  T2,
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
import { parseProcurementAlternative } from './comparison';
import type { ProcurementAlternative } from './comparison';
import { detectProcurementRecommendations } from './recommendation';
import type { ProcurementRecommendation } from './recommendation';
import { rankProcurementRecommendations } from './ranking';
import type { RankedRecommendation } from './ranking';

// ----- shared deterministic ids ----------------------------------------------------

// Scenario 1 — the vendor switch (project 1, need family 11).
export const SWITCH_BUDGET = testId('bud', 11);
export const SWITCH_COST_ITEM = testId('cst', 11);
export const SWITCH_COMMITMENT = testId('com', 11);
export const SWITCH_CHANGE_EVENT = testId('chg', 11);
export const SWITCH_RAISED_EVENT = testLedgerEventId(1101);
export const SWITCH_CONTRACT_EVENT = testLedgerEventId(1201);
export const SWITCH_COST_ITEM_EVENT = testLedgerEventId(1301);

// Scenario 2 — the order splitting (project 1, need family 21).
export const SPLIT_BUDGET = testId('bud', 21);
export const SPLIT_COST_ITEM = testId('cst', 21);
export const SPLIT_COMMITMENT = testId('com', 21);
export const SPLIT_CHANGE_EVENT = testId('chg', 21);
export const SPLIT_RAISED_EVENT = testLedgerEventId(1102);
export const SPLIT_CONTRACT_EVENT = testLedgerEventId(1202);
export const SPLIT_COST_ITEM_EVENT = testLedgerEventId(1302);

// Scenario 3 — the lead-time-driven timing shift (project 1, need family 31).
export const TIMING_BUDGET = testId('bud', 31);
export const TIMING_COST_ITEM = testId('cst', 31);
export const TIMING_COMMITMENT = testId('com', 31);
export const TIMING_CHANGE_EVENT = testId('chg', 31);
export const TIMING_ACTIVITY = testId('act', 31);
export const TIMING_RAISED_EVENT = testLedgerEventId(1103);
export const TIMING_CONTRACT_EVENT = testLedgerEventId(1203);
export const TIMING_COST_ITEM_EVENT = testLedgerEventId(1303);
export const TIMING_ACTIVITY_EVENT = testLedgerEventId(1403);

/** The single currency of every golden fixture (the shared typed grammar). */
const USD_COST = unwrap(parseCostCurrencyCode('USD'));
const USD_MARGIN: CurrencyCode = unwrap(parseMarginCurrencyCode('USD'));

// The vendor outcome histories: six completed-project outcome records of
// tenant A's project-2 history with schedule variances −2, −1, +3, −5, +1,
// −4 days (on time when variance <= 0):
//   vendor-02 (the switch challenger)  → outcomes 1..3  → 2/3 on time (strong)
//   vendor-04 (the split first share)  → outcome 4      → 1/1   on time (strong)
//   vendor-05 (the split second share) → no history     (unrated)
//   vendor-07 (the timing challenger)  → outcomes 5..6  → 1/2   on time (acceptable)
const HISTORY_VARIANCE_DAYS: readonly number[] = [-2, -1, 3, -5, 1, -4];

// ---------------------------------------------------------------------------
// The cost-domain records (the domain package's OWN pure transitions).
// ---------------------------------------------------------------------------

/** Build one project budget of the golden portfolio (project 1). */
const budgetOf = (n: number, name: string): BudgetState =>
  unwrap(
    createBudgetState(
      { budgetId: testId('bud', n), name, currency: USD_COST, now: T0 },
      projectOneScope(),
    ),
  );

/** Record the need's basis cost item into the budget's working set. */
const withBasisItem = (
  budget: BudgetState,
  n: number,
  quantityMilli: number,
  unitRateMinor: number,
): BudgetState =>
  unwrap(
    recordCostItemState(budget, {
      costItemId: testId('cst', n),
      code: `CI-${String(n).padStart(4, '0')}`,
      description: 'The procurement need of the golden sourcing scenario',
      unit: 'lot',
      quantityMilli,
      unitRateMinor,
      now: T1,
    }),
  );

/** Build one incumbent commitment of the golden portfolio (project 1). */
const commitmentOf = (n: number, costItemId: EntityId, amountMinor: number): CommitmentState =>
  unwrap(
    createCommitmentState(
      {
        commitmentId: testId('com', n),
        number: `PO-${String(n).padStart(4, '0')}`,
        commitmentKind: 'purchase-order',
        description: 'The incumbent commitment of the golden sourcing scenario',
        currency: USD_COST,
        lines: [
          {
            lineId: testId('lin', n),
            costItemId,
            description: 'The incumbent fulfillment line',
            amountMinor,
          },
        ],
        now: T2,
        createdBy: ACTOR_ID,
      },
      projectOneScope(),
    ),
  );

// ---------------------------------------------------------------------------
// The margin assessment fixtures (the projected economic impact basis —
// typed input values, exactly as the margin engine would record them).
// ---------------------------------------------------------------------------

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

/** One quoted fulfillment alternative of a need scenario (the honest parse path). */
export interface NeedQuote {
  readonly alternativeId: string;
  readonly vendorKey: string;
  readonly incumbentVendor: boolean;
  readonly quantityMilli: number;
  readonly unitRateMinor: number;
  readonly leadTimeDays: number;
  readonly outcomeIds: readonly string[];
}

/** The parameterized parts of one procurement need scenario. */
export interface NeedScenarioParts {
  /** The id family (11/21/31 for the goldens; 41+ for test variants). */
  readonly n: number;
  readonly costItemQuantityMilli: number;
  readonly costItemUnitRateMinor: number;
  readonly commitmentAmountMinor: number;
  readonly assessedDeltaMinor: number;
  readonly assessedDurationDelta: number;
  readonly quotes: readonly NeedQuote[];
}

/** One procurement need scenario: the canonical records + the producing assessment + the quotes. */
export interface NeedScenario {
  readonly budget: BudgetState;
  readonly commitment: CommitmentState;
  readonly assessment: ImpactAssessment;
  readonly alternatives: readonly ProcurementAlternative[];
}

/**
 * Build one procurement need scenario: the budget of record with its basis
 * cost item (the cost domain's own pure transitions), the incumbent
 * commitment, the producing assessment (the projected economic impact
 * basis: the assessed budget-revision delta + the assessed program-duration
 * delta), and the quoted fulfillment alternatives — each parsed through the
 * engine's own fail-closed input parser.
 */
export const needScenarioOf = (parts: NeedScenarioParts): NeedScenario => {
  const budget = withBasisItem(
    budgetOf(parts.n, `Golden sourcing budget ${String(parts.n)}`),
    parts.n,
    parts.costItemQuantityMilli,
    parts.costItemUnitRateMinor,
  );
  const basisItem = budget.costItems[String(testId('cst', parts.n))] as
    | { readonly entityId: EntityId }
    | undefined;
  const costItemId = basisItem?.entityId ?? testId('cst', parts.n);
  const commitment = commitmentOf(parts.n, costItemId, parts.commitmentAmountMinor);

  const raisedEvent = testLedgerEventId(1100 + parts.n);
  const contractEvent = testLedgerEventId(1200 + parts.n);
  const costItemEvent = testLedgerEventId(1300 + parts.n);
  const activityEvent = testLedgerEventId(1400 + parts.n);
  const scheduleImpact: ImpactAssessment['scheduleImpact'] =
    parts.assessedDurationDelta === 0
      ? emptyScheduleImpact()
      : {
          activityDeltas: [
            {
              activityId: testId('act', parts.n),
              code: `A-${String(parts.n).padStart(3, '0')}`,
              earlyStartDelta: parts.assessedDurationDelta,
              earlyFinishDelta: parts.assessedDurationDelta,
              drivers: [sourceRef(activityEvent, 'schedule.activityUpdated', T2)],
            },
          ],
          projectDurationDelta: parts.assessedDurationDelta,
          preProjectDuration: 180,
          currentProjectDuration: 180 + parts.assessedDurationDelta,
          drivers: [sourceRef(activityEvent, 'schedule.activityUpdated', T2)],
          basisAnchors: [],
          evidence: [sourceRef(activityEvent, 'schedule.activityUpdated', T2)],
        };

  const assessment: ImpactAssessment = {
    assessmentId: testAssessmentId(parts.n),
    assessmentVersion: ASSESSMENT_SCHEMA_VERSION,
    engine: ASSESSMENT_ENGINE,
    assessedAt: ASSESSED_AT,
    actor: USER_ACTOR,
    scope: projectOneScope(),
    query: { sourceEventId: raisedEvent },
    source: {
      eventId: raisedEvent,
      changeEventId: testId('chg', parts.n),
      contractId: testId('con', parts.n),
      title: `Golden sourcing change ${String(parts.n)}`,
      changeType: 'modification',
      evidenceLinks: [],
      scope: projectOneScope(),
      actor: USER_ACTOR,
      occurredAt: T1,
      correlationId: testCorrelationId(parts.n),
    },
    consumed: {
      projectedEventCount: parts.assessedDurationDelta === 0 ? 3 : 4,
      subgraphNodeCount: 3,
      subgraphEdgeCount: 2,
    },
    costImpact: {
      budgetRevisionDeltaMinor: parts.assessedDeltaMinor,
      itemDeltas:
        parts.assessedDeltaMinor === 0
          ? []
          : [
              {
                budgetId: testId('bud', parts.n),
                costItemId,
                amountMinor: parts.assessedDeltaMinor,
                source: sourceRef(costItemEvent, 'cost.costItemRecorded', T2),
              },
            ],
      revisionAnchors: [],
      evidence:
        parts.assessedDeltaMinor === 0
          ? []
          : [sourceRef(costItemEvent, 'cost.costItemRecorded', T2)],
    },
    scheduleImpact,
    entitlementImpact: emptyEntitlementImpact(),
    marginPosition: {
      contractedValue: {
        amountMinor: 9_000_000,
        evidence: [sourceRef(contractEvent, 'contracts.contractCreated', T0)],
      },
      committedCost: {
        amountMinor: parts.commitmentAmountMinor,
        evidence: [sourceRef(contractEvent, 'contracts.contractCreated', T0)],
      },
      budgetedCost: {
        amountMinor: (parts.costItemQuantityMilli * parts.costItemUnitRateMinor) / 1000,
        evidence: [sourceRef(costItemEvent, 'cost.costItemRecorded', T1)],
      },
      projectedCost: {
        amountMinor: parts.commitmentAmountMinor + parts.assessedDeltaMinor,
        evidence:
          parts.assessedDeltaMinor === 0
            ? [sourceRef(contractEvent, 'contracts.contractCreated', T0)]
            : [
                sourceRef(contractEvent, 'contracts.contractCreated', T0),
                sourceRef(costItemEvent, 'cost.costItemRecorded', T2),
              ],
      },
      marginMinor: 9_000_000 - parts.commitmentAmountMinor - parts.assessedDeltaMinor,
      marginOverCommittedMinor: 9_000_000 - parts.commitmentAmountMinor,
      currency: USD_MARGIN,
    },
    confidence: { level: 'high', reasons: ['complete-inputs'] },
    policyContext: {
      capabilities: [...ASSESSMENT_REQUIRED_CAPABILITY_NAMES],
      requiredCapabilities: [...ASSESSMENT_REQUIRED_CAPABILITY_NAMES],
      policyRuleCount: 1,
      decision: 'allow',
    },
    evidence: [
      sourceRef(contractEvent, 'contracts.contractCreated', T0),
      ...(parts.assessedDeltaMinor === 0
        ? []
        : [sourceRef(costItemEvent, 'cost.costItemRecorded', T2)]),
      ...(parts.assessedDurationDelta === 0
        ? []
        : [sourceRef(activityEvent, 'schedule.activityUpdated', T2)]),
    ],
  };

  const alternatives = parts.quotes.map((quote) =>
    unwrap(
      parseProcurementAlternative({
        alternativeId: quote.alternativeId,
        vendorKey: quote.vendorKey,
        scope: projectOneScope(),
        incumbentCommitmentId: testId('com', parts.n),
        incumbentVendor: quote.incumbentVendor,
        quotedQuantityMilli: quote.quantityMilli,
        quotedUnitRateMinor: quote.unitRateMinor,
        currency: 'USD',
        leadTimeDays: quote.leadTimeDays,
        outcomeIds: [...quote.outcomeIds],
      }),
    ),
  );

  return { budget, commitment, assessment, alternatives };
};

/** Scenario 1 — the vendor switch: vendor-02 undercuts the incumbent re-quote by 700,000 of an 8,500,000 incumbent path. */
export const switchScenario = (): NeedScenario =>
  needScenarioOf({
    n: 11,
    costItemQuantityMilli: 10_000,
    costItemUnitRateMinor: 1_000_000,
    commitmentAmountMinor: 8_000_000,
    assessedDeltaMinor: 500_000,
    assessedDurationDelta: 0,
    quotes: [
      {
        alternativeId: 'quote-a1',
        vendorKey: 'vendor-01',
        incumbentVendor: true,
        quantityMilli: 10_000,
        unitRateMinor: 850_000,
        leadTimeDays: 30,
        outcomeIds: [],
      },
      {
        alternativeId: 'quote-a2',
        vendorKey: 'vendor-02',
        incumbentVendor: false,
        quantityMilli: 10_000,
        unitRateMinor: 780_000,
        leadTimeDays: 28,
        outcomeIds: ['outcome-0001', 'outcome-0002', 'outcome-0003'],
      },
    ],
  });

/** Scenario 2 — the order splitting: two vendors cover the scope for 7,100,000 against a 7,400,000 incumbent path. */
export const splitScenario = (): NeedScenario =>
  needScenarioOf({
    n: 21,
    costItemQuantityMilli: 8_000,
    costItemUnitRateMinor: 1_000_000,
    commitmentAmountMinor: 7_000_000,
    assessedDeltaMinor: 400_000,
    assessedDurationDelta: 0,
    quotes: [
      {
        alternativeId: 'quote-b1',
        vendorKey: 'vendor-03',
        incumbentVendor: true,
        quantityMilli: 8_000,
        unitRateMinor: 925_000,
        leadTimeDays: 40,
        outcomeIds: [],
      },
      {
        alternativeId: 'quote-b2',
        vendorKey: 'vendor-04',
        incumbentVendor: false,
        quantityMilli: 5_000,
        unitRateMinor: 700_000,
        leadTimeDays: 35,
        outcomeIds: ['outcome-0004'],
      },
      {
        alternativeId: 'quote-b3',
        vendorKey: 'vendor-05',
        incumbentVendor: false,
        quantityMilli: 5_000,
        unitRateMinor: 720_000,
        leadTimeDays: 33,
        outcomeIds: [],
      },
    ],
  });

/** Scenario 3 — the timing shift: vendor-07 is 20 days faster, pays a premium over the re-quote, still undercuts the 10,600,000 incumbent path. */
export const timingScenario = (): NeedScenario =>
  needScenarioOf({
    n: 31,
    costItemQuantityMilli: 12_000,
    costItemUnitRateMinor: 1_000_000,
    commitmentAmountMinor: 10_000_000,
    assessedDeltaMinor: 600_000,
    assessedDurationDelta: 12,
    quotes: [
      {
        alternativeId: 'quote-c1',
        vendorKey: 'vendor-06',
        incumbentVendor: true,
        quantityMilli: 12_000,
        unitRateMinor: 800_000,
        leadTimeDays: 45,
        outcomeIds: [],
      },
      {
        alternativeId: 'quote-c2',
        vendorKey: 'vendor-07',
        incumbentVendor: false,
        quantityMilli: 12_000,
        unitRateMinor: 850_000,
        leadTimeDays: 25,
        outcomeIds: ['outcome-0005', 'outcome-0006'],
      },
    ],
  });

// ---------------------------------------------------------------------------
// The completed-project history fixtures (project 2 — the historical basis).
// ---------------------------------------------------------------------------

/** Build one completed-project outcome record of the vendor history (typed fixture). */
const historyOutcomeOf = (n: number): OutcomeRecord => {
  const varianceDays = HISTORY_VARIANCE_DAYS[n - 1] ?? 0;
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
          sourceEventId: testLedgerEventId(9100 + n),
          correlationId: testCorrelationId(9100 + n),
          changeEventId: testId('chg', 900 + n),
          contractId: testId('con', 900 + n),
        },
      ],
    },
    margin: {
      currency: USD_MARGIN,
      originalContractedValueMinor: 10_000_000,
      contractedValueMinor: 10_300_000,
      committedCostMinor: 9_000_000,
      projectedCostMinor: 9_000_000,
      marginMinor: 1_300_000,
      marginRatio: { numerator: 1_300_000, denominator: 10_300_000 },
      perContract: [
        {
          contractId: testId('con', 900 + n),
          assessmentId: testAssessmentId(9000 + n),
          currency: USD_MARGIN,
          contractedValueMinor: 10_300_000,
          committedCostMinor: 9_000_000,
          projectedCostMinor: 9_000_000,
          marginMinor: 1_300_000,
          marginRatio: { numerator: 1_300_000, denominator: 10_300_000 },
        },
      ],
      sources: [
        {
          kind: 'assessment',
          assessmentId: testAssessmentId(9000 + n),
          assessedAt: ASSESSED_AT,
          sourceEventId: testLedgerEventId(9100 + n),
          correlationId: testCorrelationId(9100 + n),
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
      approvedCount: 3,
      executedCount: 0,
      rejectedCount: 1,
      pendingCount: 0,
      approvedValueMinor: 300_000,
      rejectedValueMinor: 100_000,
      pendingValueMinor: 0,
      approvalRate: { numerator: 3, denominator: 4 },
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
      changeOrderCount: 4,
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

/** The six completed-project outcome records (the vendors' historical basis inputs). */
export const HISTORY_OUTCOMES: readonly OutcomeRecord[] = [
  historyOutcomeOf(1),
  historyOutcomeOf(2),
  historyOutcomeOf(3),
  historyOutcomeOf(4),
  historyOutcomeOf(5),
  historyOutcomeOf(6),
];

/**
 * THE tenant-A history benchmark: schedule variances −5, −4, −2, −1, +1, +3
 * days (p90 = 3, mean −4/3) — the calibration fact the timing rule cites
 * when an assessed delay rises beyond the benchmarked envelope.
 */
export const HISTORY_BENCHMARK: Benchmark = {
  benchmarkId: testBenchmarkId(1),
  benchmarkVersion: BENCHMARK_SCHEMA_VERSION,
  engine: MEMORY_ENGINE,
  computedAt: COMPUTED_AT,
  actor: USER_ACTOR,
  scope: tenantAScope(),
  outcomeCount: 6,
  metrics: [
    {
      kind: 'schedule-variance-days',
      outcomeIds: [
        testOutcomeId(1),
        testOutcomeId(2),
        testOutcomeId(3),
        testOutcomeId(4),
        testOutcomeId(5),
        testOutcomeId(6),
      ],
      min: { numerator: -5, denominator: 1 },
      max: { numerator: 3, denominator: 1 },
      mean: { numerator: -4, denominator: 3 },
      median: { numerator: -3, denominator: 2 },
      percentile90: { numerator: 3, denominator: 1 },
    },
  ],
  positions: [
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(4), position: { numerator: 1, denominator: 6 } },
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(6), position: { numerator: 1, denominator: 3 } },
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(1), position: { numerator: 1, denominator: 2 } },
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(2), position: { numerator: 2, denominator: 3 } },
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(5), position: { numerator: 5, denominator: 6 } },
    { metricKind: 'schedule-variance-days', outcomeId: testOutcomeId(3), position: { numerator: 1, denominator: 1 } },
  ],
};

// ---------------------------------------------------------------------------
// THE golden sourcing portfolio scan (the named acceptance).
// ---------------------------------------------------------------------------

/** One full run of the golden procurement pipeline. */
export interface GoldenProcurementRun {
  /** The golden cost-domain records (the comparison's canonical inputs). */
  readonly budgets: readonly BudgetState[];
  readonly commitments: readonly CommitmentState[];
  /** The golden quoted fulfillment alternatives (the comparison surface). */
  readonly alternatives: readonly ProcurementAlternative[];
  /** The golden assessments (the projected economic impact basis inputs). */
  readonly assessments: readonly ImpactAssessment[];
  /** The completed-project history (the historical basis inputs). */
  readonly outcomes: readonly OutcomeRecord[];
  readonly benchmark: Benchmark;
  /** The detected recommendation set (canonical emission order). */
  readonly recommendations: readonly ProcurementRecommendation[];
  /** The ranked recommendation set (the stable preference order). */
  readonly ranked: readonly RankedRecommendation[];
}

/**
 * The golden inputs as one scan-input record (the permutation probes
 * reshuffle these arrays — determinism must not care).
 */
export const goldenInputsOf = (run: GoldenProcurementRun): {
  readonly budgets: readonly BudgetState[];
  readonly commitments: readonly CommitmentState[];
  readonly alternatives: readonly ProcurementAlternative[];
  readonly assessments: readonly ImpactAssessment[];
  readonly outcomes: readonly OutcomeRecord[];
  readonly benchmarks: readonly Benchmark[];
} => ({
  budgets: run.budgets,
  commitments: run.commitments,
  alternatives: run.alternatives,
  assessments: run.assessments,
  outcomes: run.outcomes,
  benchmarks: [run.benchmark],
});

/**
 * Run THE golden procurement scan: build the three live sourcing scenarios
 * (the vendor switch, the order splitting, the lead-time-driven timing
 * shift) + the completed-project history, detect the recommendation set,
 * and rank it with the default seeded weights. Fully deterministic — the
 * same run twice produces byte-identical results.
 */
export const runGoldenProcurementScan = (): GoldenProcurementRun => {
  const scenarios = [switchScenario(), splitScenario(), timingScenario()];
  const budgets: readonly BudgetState[] = scenarios.map((scenario) => scenario.budget);
  const commitments: readonly CommitmentState[] = scenarios.map(
    (scenario) => scenario.commitment,
  );
  const alternatives: readonly ProcurementAlternative[] = scenarios.flatMap(
    (scenario) => scenario.alternatives,
  );
  const assessments: readonly ImpactAssessment[] = scenarios.map(
    (scenario) => scenario.assessment,
  );
  const outcomes = HISTORY_OUTCOMES;
  const benchmark = HISTORY_BENCHMARK;

  const recommendations = unwrap(
    detectProcurementRecommendations(
      {
        budgets,
        commitments,
        alternatives,
        assessments,
        outcomes,
        benchmarks: [benchmark],
      },
      tenantReader(),
      { scanId: testScanId(1), detectedAt: DETECTED_AT },
    ),
  );
  const ranked = unwrap(rankProcurementRecommendations(recommendations));
  return {
    budgets,
    commitments,
    alternatives,
    assessments,
    outcomes,
    benchmark,
    recommendations,
    ranked,
  };
};

/** THE pinned stable preference order of the golden scan (kind sequence). */
export const GOLDEN_PREFERENCE_ORDER: readonly string[] = [
  'timing-shift',
  'order-splitting',
  'vendor-switch',
];

/** The stable ranked shape of one golden recommendation (order assertions). */
export const rankedShapeOf = (ranked: RankedRecommendation): {
  readonly rank: number;
  readonly kind: string;
  readonly recommendationId: string;
  readonly total: { readonly numerator: number; readonly denominator: number };
} => ({
  rank: ranked.rank,
  kind: ranked.recommendation.kind,
  recommendationId: ranked.recommendation.recommendationId,
  total: ranked.score.total,
});
