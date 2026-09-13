// Office intelligence — golden construction scenarios (OFF-014, package-internal).
//
// Deterministic fixtures for the four NAMED golden scenarios of the margin
// engine's acceptance: COST impact (a change order's cost-item links →
// budget revision delta → margin), SCHEDULE impact (a change event's
// activity links → dependency network → forecast day deltas via the
// recorded schedule state), ENTITLEMENT impact (change orders
// approved/rejected → claim reference position), and MARGIN aggregation
// (contracted − committed − projected with evidence refs at each layer).
//
// Each builder appends a ledger-shaped event stream to an in-memory source
// (commands with fixed idempotency keys, fixed clock, fixed ids) and
// returns the named ledger events the goldens assert traceability against
// (ledger event ids are deterministic — the same append sequence always
// reproduces identical ids). The `parts` options of each builder produce
// the MUTATED/REMOVED source-event variants the traceability tests use:
// mutating or removing a source event must change the assessment.
//
// Golden shapes are static data (entity ids, amounts, deltas, statuses —
// never ledger event ids); the exact source event ids are asserted
// separately against the returned events, which is the real traceability
// proof (the named acceptance: every assessment carries the exact source
// event ids that produced every impact number).
import type { EntityId, EntityRef } from '@office/contracts';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import {
  projectRelationships,
  traverseRelationships,
} from '@office/intelligence-relationships';
import type { TraversalSubgraph } from '@office/intelligence-relationships';
import { calculateImpact } from './calculation';
import { projectCommercialFacts } from './facts';
import type { CommercialFacts } from './facts';
import { parseAssessmentId } from './vocabulary';
import type { AssessmentId } from './vocabulary';
import type { ImpactAssessment } from './model';
import { CHANGE_EVENT_KIND } from './model';
import {
  ASSESSED_AT,
  T0,
  T1,
  T2,
  T3,
  T4,
  appendCommandEvent,
  newEventSource,
  projectOneReader,
  projectOneScope,
  testCommand,
  testCorrelationId,
  testId,
  testKey,
  unwrap,
} from './test-support';
import type { InMemoryEventSource } from '@office/intelligence-relationships';

// ----- shared deterministic ids -----------------------------------------------------

export const CONTRACT_ID = testId('con', 1);
export const BUDGET_ID = testId('bud', 1);
export const COST_ITEM_1 = testId('cst', 1);
export const COST_ITEM_2 = testId('cst', 2);
export const COMMITMENT_1 = testId('cmt', 1);
export const COMMITMENT_2 = testId('cmt', 2);
export const AMENDMENT_1 = testId('amd', 1);
export const BUDGET_REVISION_1 = testId('brv', 1);
export const CHANGE_EVENT_ID = testId('chg', 1);
export const CHANGE_ORDER_1 = testId('ord', 1);
export const CHANGE_ORDER_2 = testId('ord', 2);
export const CHANGE_ORDER_3 = testId('ord', 3);
export const CLAIM_REFERENCE_1 = testId('clr', 1);
export const FIELD_ISSUE_ID = testId('iss', 1);
export const DOCUMENT_ID = testId('doc', 1);
export const DOCUMENT_REVISION_1 = testId('rev', 1);
export const SCHEDULE_ID = testId('sch', 1);
export const ACTIVITY_1 = testId('act', 1);
export const ACTIVITY_2 = testId('act', 2);
export const ACTIVITY_3 = testId('act', 3);
export const DEPENDENCY_1 = testId('dep', 1);
export const DEPENDENCY_2 = testId('dep', 2);
export const BASELINE_1 = testId('bas', 1);
export const PROGRESS_1 = testId('prg', 1);
export const INVOICE_1 = testId('inv', 1);

const contractAggregate: EntityRef = { entityKind: 'contract' as EntityRef['entityKind'], entityId: CONTRACT_ID };
const budgetAggregate: EntityRef = { entityKind: 'budget' as EntityRef['entityKind'], entityId: BUDGET_ID };
const commitmentOneAggregate: EntityRef = { entityKind: 'commitment' as EntityRef['entityKind'], entityId: COMMITMENT_1 };
const commitmentTwoAggregate: EntityRef = { entityKind: 'commitment' as EntityRef['entityKind'], entityId: COMMITMENT_2 };
const scheduleAggregate: EntityRef = { entityKind: 'schedule' as EntityRef['entityKind'], entityId: SCHEDULE_ID };

const commandOf = (key: number, commandName: string) =>
  testCommand({
    commandName,
    scope: projectOneScope(),
    idempotencyKey: testKey(key),
    correlationId: testCorrelationId(key),
    issuedAt: T0,
  });

/** Deterministic assessment identities (the injected tokens of the goldens). */
export const testAssessmentId = (n: number): AssessmentId =>
  unwrap(parseAssessmentId(`assessment-${String(n).padStart(4, '0')}`));

// ---------------------------------------------------------------------------
// The golden comparable shape of an assessment (entity ids, amounts,
// deltas, statuses — never ledger event ids; the exact source event ids
// are asserted separately against the scenario's returned events).
// ---------------------------------------------------------------------------

/** The golden (comparable) shape of one assessment. */
export interface GoldenAssessment {
  readonly costImpact: {
    readonly budgetRevisionDeltaMinor: number;
    readonly itemDeltas: readonly {
      readonly budgetId: EntityId;
      readonly costItemId: EntityId;
      readonly amountMinor: number;
    }[];
    readonly revisionAnchors: readonly {
      readonly budgetId: EntityId;
      readonly revisionId: EntityId;
    }[];
  };
  readonly scheduleImpact: {
    readonly activityDeltas: readonly {
      readonly activityId: EntityId;
      readonly code: string;
      readonly earlyStartDelta: number;
      readonly earlyFinishDelta: number;
    }[];
    readonly projectDurationDelta: number;
    readonly preProjectDuration: number;
    readonly currentProjectDuration: number;
    readonly basisAnchorEventNames: readonly string[];
  };
  readonly entitlementImpact: {
    readonly status: string;
    readonly approvedValueMinor: number;
    readonly rejectedValueMinor: number;
    readonly pendingValueMinor: number;
    readonly orders: readonly {
      readonly changeOrderId: EntityId;
      readonly valueMinor: number | null;
      readonly status: string;
      readonly claims: readonly {
        readonly claimReferenceId: EntityId;
        readonly claimEntityKind: string;
        readonly claimEntityId: EntityId;
      }[];
    }[];
  };
  readonly marginPosition: {
    readonly currency: string;
    readonly contractedValueMinor: number;
    readonly committedCostMinor: number;
    readonly budgetedCostMinor: number;
    readonly projectedCostMinor: number;
    readonly marginMinor: number;
    readonly marginOverCommittedMinor: number;
  };
  readonly confidence: {
    readonly level: string;
    readonly reasons: readonly string[];
  };
  readonly consumed: {
    readonly projectedEventCount: number;
    readonly subgraphNodeCount: number;
    readonly subgraphEdgeCount: number;
  };
  /** The producing event NAMES of the full evidence set (canonical order). */
  readonly evidenceEventNames: readonly string[];
}

/** Normalize an assessment into its golden (comparable) shape. */
export const assessmentShapeOf = (assessment: ImpactAssessment): GoldenAssessment => ({
  costImpact: {
    budgetRevisionDeltaMinor: assessment.costImpact.budgetRevisionDeltaMinor,
    itemDeltas: assessment.costImpact.itemDeltas.map((delta) => ({
      budgetId: delta.budgetId,
      costItemId: delta.costItemId,
      amountMinor: delta.amountMinor,
    })),
    revisionAnchors: assessment.costImpact.revisionAnchors.map((anchor) => ({
      budgetId: anchor.budgetId,
      revisionId: anchor.revisionId,
    })),
  },
  scheduleImpact: {
    activityDeltas: assessment.scheduleImpact.activityDeltas.map((delta) => ({
      activityId: delta.activityId,
      code: delta.code,
      earlyStartDelta: delta.earlyStartDelta,
      earlyFinishDelta: delta.earlyFinishDelta,
    })),
    projectDurationDelta: assessment.scheduleImpact.projectDurationDelta,
    preProjectDuration: assessment.scheduleImpact.preProjectDuration,
    currentProjectDuration: assessment.scheduleImpact.currentProjectDuration,
    basisAnchorEventNames: assessment.scheduleImpact.basisAnchors.map(
      (anchor) => anchor.eventName as string,
    ),
  },
  entitlementImpact: {
    status: assessment.entitlementImpact.status as string,
    approvedValueMinor: assessment.entitlementImpact.approvedValueMinor,
    rejectedValueMinor: assessment.entitlementImpact.rejectedValueMinor,
    pendingValueMinor: assessment.entitlementImpact.pendingValueMinor,
    orders: assessment.entitlementImpact.orders.map((order) => ({
      changeOrderId: order.changeOrderId,
      valueMinor: order.valueMinor,
      status: order.status as string,
      claims: order.claims.map((claim) => ({
        claimReferenceId: claim.claimReferenceId,
        claimEntityKind: claim.claimEntityKind as string,
        claimEntityId: claim.claimEntityId,
      })),
    })),
  },
  marginPosition: {
    currency: assessment.marginPosition.currency,
    contractedValueMinor: assessment.marginPosition.contractedValue.amountMinor,
    committedCostMinor: assessment.marginPosition.committedCost.amountMinor,
    budgetedCostMinor: assessment.marginPosition.budgetedCost.amountMinor,
    projectedCostMinor: assessment.marginPosition.projectedCost.amountMinor,
    marginMinor: assessment.marginPosition.marginMinor,
    marginOverCommittedMinor: assessment.marginPosition.marginOverCommittedMinor,
  },
  confidence: {
    level: assessment.confidence.level as string,
    reasons: [...assessment.confidence.reasons] as readonly string[],
  },
  consumed: { ...assessment.consumed },
  evidenceEventNames: assessment.evidence.map((reference) => reference.eventName as string),
});

// ---------------------------------------------------------------------------
// The assessment runner (the full deterministic pipeline of a scenario).
// ---------------------------------------------------------------------------

/** One scenario's computed pipeline: facts + subgraph + assessment. */
export interface ScenarioRun {
  readonly facts: CommercialFacts;
  readonly subgraph: TraversalSubgraph;
  readonly assessment: ImpactAssessment;
}

/**
 * Run the full pipeline over one built stream: project the relationships,
 * traverse the authorization-filtered subgraph around the change event,
 * fold the commercial facts, and calculate the impact — deterministically
 * (the fixed assessment identity + clock of the goldens).
 */
export const assessStream = async (
  events: readonly LedgerEvent[],
  parts: {
    readonly changeEventId: EntityId;
    readonly sourceEventId: LedgerEventId;
  },
): Promise<ScenarioRun> => {
  const index = unwrap(projectRelationships(events));
  const subgraph = unwrap(
    traverseRelationships(
      index,
      {
        start: { entityKind: CHANGE_EVENT_KIND, entityId: parts.changeEventId },
        maxDepth: 2,
      },
      // The traversal authorization is the relationships engine's own; the
      // golden scenarios reuse the assessment reader's context/policy shape
      // (the same allow-all-reads project-one reader).
      {
        policy: projectOneReader().policy,
        context: projectOneReader().context,
      },
    ),
  );
  const facts = unwrap(projectCommercialFacts(events));
  const assessment = unwrap(
    calculateImpact(
      { sourceEventId: parts.sourceEventId },
      { facts, subgraph },
      projectOneReader(),
      { assessmentId: testAssessmentId(1), assessedAt: ASSESSED_AT },
    ),
  );
  return { facts, subgraph, assessment };
};

/** Build a fresh source and run one scenario builder against it. */
export const runScenario = async (
  build: (source: InMemoryEventSource) => Promise<unknown>,
  parts: {
    readonly changeEventId: EntityId;
    readonly sourceEventId: LedgerEventId;
  },
): Promise<ScenarioRun> => {
  const source = newEventSource();
  await build(source);
  return assessStream(unwrap(await source.readEvents()), parts);
};

// ---------------------------------------------------------------------------
// Scenario 1 — COST impact: a change order's cost-item links → budget
// revision delta → margin. Variants: drop the approval; mutate the
// post-change item amount.
// ---------------------------------------------------------------------------

/** The events of the cost scenario (null when a variant dropped one). */
export interface CostScenarioEvents {
  readonly contractCreated: LedgerEvent;
  readonly budgetCreated: LedgerEvent;
  readonly costItem1Recorded: LedgerEvent;
  readonly commitmentCreated: LedgerEvent;
  readonly changeEventRaised: LedgerEvent;
  readonly budgetRevised: LedgerEvent;
  readonly costItem2Recorded: LedgerEvent;
  readonly changeOrderSubmitted: LedgerEvent;
  readonly changeOrderApproved: LedgerEvent | null;
}

/** The golden cost-impact assessment shape (full acceptance detail). */
export const COST_SCENARIO_GOLDEN: GoldenAssessment = {
  costImpact: {
    budgetRevisionDeltaMinor: 1500000,
    itemDeltas: [{ budgetId: BUDGET_ID, costItemId: COST_ITEM_2, amountMinor: 1500000 }],
    revisionAnchors: [{ budgetId: BUDGET_ID, revisionId: BUDGET_REVISION_1 }],
  },
  scheduleImpact: {
    activityDeltas: [],
    projectDurationDelta: 0,
    preProjectDuration: 0,
    currentProjectDuration: 0,
    basisAnchorEventNames: [],
  },
  entitlementImpact: {
    status: 'entitled',
    approvedValueMinor: 4500000,
    rejectedValueMinor: 0,
    pendingValueMinor: 0,
    orders: [{ changeOrderId: CHANGE_ORDER_1, valueMinor: 4500000, status: 'approved', claims: [] }],
  },
  marginPosition: {
    currency: 'USD',
    contractedValueMinor: 17000000,
    committedCostMinor: 8000000,
    budgetedCostMinor: 10200000,
    projectedCostMinor: 9500000,
    marginMinor: 7500000,
    marginOverCommittedMinor: 9000000,
  },
  confidence: { level: 'high', reasons: ['complete-inputs'] },
  consumed: { projectedEventCount: 9, subgraphNodeCount: 7, subgraphEdgeCount: 7 },
  evidenceEventNames: [
    'contracts.changeEventRaised',
    'contracts.changeOrderApproved',
    'contracts.changeOrderSubmitted',
    'contracts.contractCreated',
    'cost.budgetRevised',
    'cost.commitmentCreated',
    'cost.costItemRecorded',
    'cost.costItemRecorded',
  ],
};

/**
 * Append the cost-impact stream: contract CT (value 12,500,000 minor),
 * budget B with cost item CI1 (10,200,000), commitment CM1 (8,000,000),
 * the change event CE (impacting B + CI1), the post-change budget
 * revision BR1, the post-change item CI2 (1,500,000 — the budget revision
 * delta), and the change order CO1 (4,500,000) submitted then approved.
 */
export const buildCostScenario = async (
  source: InMemoryEventSource,
  parts: {
    readonly approval?: boolean;
    readonly secondItemAmountMinor?: number;
  } = {},
): Promise<CostScenarioEvents> => {
  const scope = projectOneScope();
  const contractCreated = await appendCommandEvent(source, {
    command: commandOf(1, 'contracts.createContract'),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T0,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: 12500000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T0,
    },
  });
  const budgetCreated = await appendCommandEvent(source, {
    command: commandOf(2, 'cost.createBudget'),
    eventName: 'cost.budgetCreated',
    scope,
    occurredAt: T0,
    aggregate: budgetAggregate,
    payload: { budgetId: BUDGET_ID, name: 'Fit-out budget', currency: 'USD', version: 1, createdAt: T0 },
  });
  const costItem1Recorded = await appendCommandEvent(source, {
    command: commandOf(3, 'cost.recordCostItem'),
    eventName: 'cost.costItemRecorded',
    scope,
    occurredAt: T0,
    aggregate: budgetAggregate,
    payload: {
      budgetId: BUDGET_ID,
      costItemId: COST_ITEM_1,
      code: '02-41-00',
      description: 'Metal stud framing',
      unit: 'm2',
      quantityMilli: 1200,
      unitRateMinor: 8500,
      amountMinor: 10200000,
      version: 2,
    },
  });
  const commitmentCreated = await appendCommandEvent(source, {
    command: commandOf(4, 'cost.createCommitment'),
    eventName: 'cost.commitmentCreated',
    scope,
    occurredAt: T1,
    aggregate: commitmentOneAggregate,
    payload: {
      commitmentId: COMMITMENT_1,
      budgetId: BUDGET_ID,
      number: 'SUB-101',
      commitmentKind: 'subcontract',
      description: 'Framing subcontract',
      lineCount: 1,
      committedAmountMinor: 8000000,
      version: 1,
      createdAt: T1,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(5, 'contracts.raiseChangeEvent'),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T1,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeEventId: CHANGE_EVENT_ID,
      title: 'Wall closing amended',
      changeType: 'scope',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [],
      costImpactLinks: [{ budgetId: BUDGET_ID, costItemId: COST_ITEM_1 }],
      scheduleImpactActivityIds: [],
      version: 2,
    },
  });
  const budgetRevised = await appendCommandEvent(source, {
    command: commandOf(6, 'cost.reviseBudget'),
    eventName: 'cost.budgetRevised',
    scope,
    occurredAt: T2,
    aggregate: budgetAggregate,
    payload: {
      budgetId: BUDGET_ID,
      revisionId: BUDGET_REVISION_1,
      sequence: 1,
      label: 'Re-baseline after wall closing change',
      supersedes: null,
      costItemCount: 1,
      version: 3,
      createdAt: T2,
    },
  });
  const costItem2Recorded = await appendCommandEvent(source, {
    command: commandOf(7, 'cost.recordCostItem'),
    eventName: 'cost.costItemRecorded',
    scope,
    occurredAt: T2,
    aggregate: budgetAggregate,
    payload: {
      budgetId: BUDGET_ID,
      costItemId: COST_ITEM_2,
      code: '02-41-10',
      description: 'Additional stud framing',
      unit: 'm2',
      quantityMilli: 200,
      unitRateMinor: 7500,
      amountMinor: parts.secondItemAmountMinor ?? 1500000,
      version: 4,
    },
  });
  const changeOrderSubmitted = await appendCommandEvent(source, {
    command: commandOf(8, 'contracts.submitChangeOrder'),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T3,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_1,
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO-01 wall closing amendment',
      changeValue: { amount: 4500000, currency: 'USD' },
      status: 'submitted',
      version: 3,
    },
  });
  let changeOrderApproved: LedgerEvent | null = null;
  if (parts.approval !== false) {
    changeOrderApproved = await appendCommandEvent(source, {
      command: commandOf(9, 'contracts.approveChangeOrder'),
      eventName: 'contracts.changeOrderApproved',
      scope,
      occurredAt: T3,
      aggregate: contractAggregate,
      payload: {
        contractId: CONTRACT_ID,
        changeOrderId: CHANGE_ORDER_1,
        status: 'approved',
        decidedAt: T3,
        version: 4,
      },
    });
  }
  return {
    contractCreated,
    budgetCreated,
    costItem1Recorded,
    commitmentCreated,
    changeEventRaised,
    budgetRevised,
    costItem2Recorded,
    changeOrderSubmitted,
    changeOrderApproved,
  };
};

// ---------------------------------------------------------------------------
// Scenario 2 — SCHEDULE impact: a change event's activity links → the
// dependency network → forecast day deltas via the recorded schedule
// state. Variants: drop the duration update; drop the progress record.
// ---------------------------------------------------------------------------

/** The events of the schedule scenario (null when a variant dropped one). */
export interface ScheduleScenarioEvents {
  readonly scheduleCreated: LedgerEvent;
  readonly activity1Added: LedgerEvent;
  readonly activity2Added: LedgerEvent;
  readonly activity3Added: LedgerEvent;
  readonly dependency1Added: LedgerEvent;
  readonly dependency2Added: LedgerEvent;
  readonly baselineSet: LedgerEvent;
  readonly contractCreated: LedgerEvent;
  readonly changeEventRaised: LedgerEvent;
  readonly activity2Updated: LedgerEvent | null;
  readonly activity3Progress: LedgerEvent | null;
}

/**
 * The golden schedule-impact assessment shape: A1(5)→A2(4)→A3(3) with FS
 * lag 0/2 projects to duration 14 pre-change; the post-change update
 * (A2 duration 4→7) and progress (A3 remaining 2) project to 16 — the
 * change's forecast consequence is +2 project days, +3 early-finish on
 * A2, +2 early-finish/+3 early-start on A3.
 */
export const SCHEDULE_SCENARIO_GOLDEN: GoldenAssessment = {
  costImpact: {
    budgetRevisionDeltaMinor: 0,
    itemDeltas: [],
    revisionAnchors: [],
  },
  scheduleImpact: {
    activityDeltas: [
      { activityId: ACTIVITY_2, code: 'A2', earlyStartDelta: 0, earlyFinishDelta: 3 },
      { activityId: ACTIVITY_3, code: 'A3', earlyStartDelta: 3, earlyFinishDelta: 2 },
    ],
    projectDurationDelta: 2,
    preProjectDuration: 14,
    currentProjectDuration: 16,
    basisAnchorEventNames: ['schedule.baselineSet'],
  },
  entitlementImpact: {
    status: 'none',
    approvedValueMinor: 0,
    rejectedValueMinor: 0,
    pendingValueMinor: 0,
    orders: [],
  },
  marginPosition: {
    currency: 'USD',
    contractedValueMinor: 20000000,
    committedCostMinor: 0,
    budgetedCostMinor: 0,
    projectedCostMinor: 0,
    marginMinor: 20000000,
    marginOverCommittedMinor: 20000000,
  },
  confidence: { level: 'high', reasons: ['complete-inputs'] },
  consumed: { projectedEventCount: 11, subgraphNodeCount: 5, subgraphEdgeCount: 5 },
  evidenceEventNames: [
    'contracts.changeEventRaised',
    'contracts.contractCreated',
    'schedule.activityUpdated',
    'schedule.baselineSet',
    'schedule.progressRecorded',
  ],
};

/**
 * Append the schedule-impact stream: schedule S with activities A1(5),
 * A2(4), A3(3), dependencies A1→A2 (FS, 0) and A2→A3 (FS, 2), the
 * baseline B1, the owning contract, the change event CE (impacting
 * A2 + A3), the post-change duration update of A2 (4→7), and the
 * post-change progress of A3 (50%, remaining 2).
 */
export const buildScheduleScenario = async (
  source: InMemoryEventSource,
  parts: {
    readonly durationUpdate?: boolean;
    readonly progress?: boolean;
  } = {},
): Promise<ScheduleScenarioEvents> => {
  const scope = projectOneScope();
  const scheduleCreated = await appendCommandEvent(source, {
    command: commandOf(1, 'schedule.createSchedule'),
    eventName: 'schedule.scheduleCreated',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: { scheduleId: SCHEDULE_ID, name: 'Tower fit-out', version: 1, createdAt: T0 },
  });
  const activity1Added = await appendCommandEvent(source, {
    command: commandOf(2, 'schedule.addActivity'),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      activityId: ACTIVITY_1,
      code: 'A1',
      name: 'Framing level 3',
      plannedDuration: 5,
      parentActivityId: null,
      version: 2,
    },
  });
  const activity2Added = await appendCommandEvent(source, {
    command: commandOf(3, 'schedule.addActivity'),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      activityId: ACTIVITY_2,
      code: 'A2',
      name: 'Wall closing',
      plannedDuration: 4,
      parentActivityId: null,
      version: 3,
    },
  });
  const activity3Added = await appendCommandEvent(source, {
    command: commandOf(4, 'schedule.addActivity'),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      activityId: ACTIVITY_3,
      code: 'A3',
      name: 'Ceiling closure',
      plannedDuration: 3,
      parentActivityId: null,
      version: 4,
    },
  });
  const dependency1Added = await appendCommandEvent(source, {
    command: commandOf(5, 'schedule.addDependency'),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      dependencyId: DEPENDENCY_1,
      predecessorId: ACTIVITY_1,
      successorId: ACTIVITY_2,
      linkType: 'FS',
      lagDays: 0,
      version: 5,
    },
  });
  const dependency2Added = await appendCommandEvent(source, {
    command: commandOf(6, 'schedule.addDependency'),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      dependencyId: DEPENDENCY_2,
      predecessorId: ACTIVITY_2,
      successorId: ACTIVITY_3,
      linkType: 'FS',
      lagDays: 2,
      version: 6,
    },
  });
  const baselineSet = await appendCommandEvent(source, {
    command: commandOf(7, 'schedule.setBaseline'),
    eventName: 'schedule.baselineSet',
    scope,
    occurredAt: T1,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      baselineId: BASELINE_1,
      sequence: 1,
      label: 'Baseline B1',
      supersedes: null,
      activityCount: 3,
      dependencyCount: 2,
      milestoneCount: 0,
      version: 7,
      createdAt: T1,
    },
  });
  const contractCreated = await appendCommandEvent(source, {
    command: commandOf(8, 'contracts.createContract'),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T1,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: 20000000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T1,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(9, 'contracts.raiseChangeEvent'),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeEventId: CHANGE_EVENT_ID,
      title: 'Wall closing sequence change',
      changeType: 'schedule',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [],
      costImpactLinks: [],
      scheduleImpactActivityIds: [ACTIVITY_2, ACTIVITY_3],
      version: 2,
    },
  });
  let activity2Updated: LedgerEvent | null = null;
  if (parts.durationUpdate !== false) {
    activity2Updated = await appendCommandEvent(source, {
      command: commandOf(10, 'schedule.updateActivity'),
      eventName: 'schedule.activityUpdated',
      scope,
      occurredAt: T2,
      aggregate: scheduleAggregate,
      payload: {
        scheduleId: SCHEDULE_ID,
        activityId: ACTIVITY_2,
        code: 'A2',
        plannedDuration: 7,
        version: 8,
        updatedAt: T2,
      },
    });
  }
  let activity3Progress: LedgerEvent | null = null;
  if (parts.progress !== false) {
    activity3Progress = await appendCommandEvent(source, {
      command: commandOf(11, 'schedule.recordProgress'),
      eventName: 'schedule.progressRecorded',
      scope,
      occurredAt: T2,
      aggregate: scheduleAggregate,
      payload: {
        scheduleId: SCHEDULE_ID,
        progressUpdateId: PROGRESS_1,
        activityId: ACTIVITY_3,
        percentComplete: 50,
        remainingDuration: 2,
        actualStart: T2,
        actualFinish: null,
        version: 9,
      },
    });
  }
  return {
    scheduleCreated,
    activity1Added,
    activity2Added,
    activity3Added,
    dependency1Added,
    dependency2Added,
    baselineSet,
    contractCreated,
    changeEventRaised,
    activity2Updated,
    activity3Progress,
  };
};

// ---------------------------------------------------------------------------
// Scenario 3 — ENTITLEMENT impact: change orders approved/rejected → the
// claim reference position.
// ---------------------------------------------------------------------------

/** The events of the entitlement scenario. */
export interface EntitlementScenarioEvents {
  readonly documentRegistered: LedgerEvent;
  readonly revisionAttached: LedgerEvent;
  readonly contractCreated: LedgerEvent;
  readonly changeEventRaised: LedgerEvent;
  readonly order1Submitted: LedgerEvent;
  readonly order1Approved: LedgerEvent;
  readonly order2Submitted: LedgerEvent;
  readonly order2Rejected: LedgerEvent;
  readonly order3Submitted: LedgerEvent;
  readonly claimReferenced: LedgerEvent;
}

/** The golden entitlement-impact assessment shape. */
export const ENTITLEMENT_SCENARIO_GOLDEN: GoldenAssessment = {
  costImpact: {
    budgetRevisionDeltaMinor: 0,
    itemDeltas: [],
    revisionAnchors: [],
  },
  scheduleImpact: {
    activityDeltas: [],
    projectDurationDelta: 0,
    preProjectDuration: 0,
    currentProjectDuration: 0,
    basisAnchorEventNames: [],
  },
  entitlementImpact: {
    status: 'entitled-with-exposure',
    approvedValueMinor: 4500000,
    rejectedValueMinor: 2000000,
    pendingValueMinor: 1000000,
    orders: [
      {
        changeOrderId: CHANGE_ORDER_1,
        valueMinor: 4500000,
        status: 'approved',
        claims: [
          { claimReferenceId: CLAIM_REFERENCE_1, claimEntityKind: 'field-issue', claimEntityId: FIELD_ISSUE_ID },
        ],
      },
      { changeOrderId: CHANGE_ORDER_2, valueMinor: 2000000, status: 'rejected', claims: [] },
      { changeOrderId: CHANGE_ORDER_3, valueMinor: 1000000, status: 'submitted', claims: [] },
    ],
  },
  marginPosition: {
    currency: 'USD',
    contractedValueMinor: 17000000,
    committedCostMinor: 0,
    budgetedCostMinor: 0,
    projectedCostMinor: 1000000,
    marginMinor: 16000000,
    marginOverCommittedMinor: 17000000,
  },
  confidence: { level: 'medium', reasons: ['undecided-change-order'] },
  consumed: { projectedEventCount: 10, subgraphNodeCount: 7, subgraphEdgeCount: 7 },
  evidenceEventNames: [
    'contracts.changeEventRaised',
    'contracts.changeOrderApproved',
    'contracts.changeOrderRejected',
    'contracts.changeOrderSubmitted',
    'contracts.changeOrderSubmitted',
    'contracts.changeOrderSubmitted',
    'contracts.claimReferenced',
    'contracts.contractCreated',
  ],
};

/**
 * Append the entitlement-impact stream: an evidence document D with
 * revision R (both SKIPPED by the commercial fold — documents events carry
 * no commercial fact), the contract CT, the change event CE, three change
 * orders (CO1 approved, CO2 rejected, CO3 still submitted), and one claim
 * reference (a field issue claimed against CO1, evidenced by D/R).
 */
export const buildEntitlementScenario = async (
  source: InMemoryEventSource,
): Promise<EntitlementScenarioEvents> => {
  const scope = projectOneScope();
  const documentAggregate: EntityRef = { entityKind: 'document' as EntityRef['entityKind'], entityId: DOCUMENT_ID };
  const documentRegistered = await appendCommandEvent(source, {
    command: commandOf(1, 'documents.registerDocument'),
    eventName: 'documents.documentRegistered',
    scope,
    occurredAt: T0,
    aggregate: documentAggregate,
    payload: {
      documentId: DOCUMENT_ID,
      projectId: scope.kind === 'project' ? scope.projectId : null,
      title: 'Wall closing photos',
      status: 'active',
      version: 1,
      createdAt: T0,
    },
  });
  const revisionAttached = await appendCommandEvent(source, {
    command: commandOf(2, 'documents.attachRevision'),
    eventName: 'documents.revisionAttached',
    scope,
    occurredAt: T0,
    aggregate: documentAggregate,
    payload: {
      documentId: DOCUMENT_ID,
      revisionId: DOCUMENT_REVISION_1,
      contentHash: 'sha256-1a2b3c4d5e',
      storageKey: 'documents/wall-closing/r1',
      byteSize: 4096,
      supersedes: null,
      attachedAt: T0,
      version: 2,
    },
  });
  const contractCreated = await appendCommandEvent(source, {
    command: commandOf(3, 'contracts.createContract'),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T0,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: 12500000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T0,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(4, 'contracts.raiseChangeEvent'),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T1,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeEventId: CHANGE_EVENT_ID,
      title: 'Site condition disputed',
      changeType: 'claim',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: DOCUMENT_REVISION_1 }],
      costImpactLinks: [],
      scheduleImpactActivityIds: [],
      version: 2,
    },
  });
  const order1Submitted = await appendCommandEvent(source, {
    command: commandOf(5, 'contracts.submitChangeOrder'),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_1,
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO-01 approved works',
      changeValue: { amount: 4500000, currency: 'USD' },
      status: 'submitted',
      version: 3,
    },
  });
  const order1Approved = await appendCommandEvent(source, {
    command: commandOf(6, 'contracts.approveChangeOrder'),
    eventName: 'contracts.changeOrderApproved',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_1,
      status: 'approved',
      decidedAt: T2,
      version: 4,
    },
  });
  const order2Submitted = await appendCommandEvent(source, {
    command: commandOf(7, 'contracts.submitChangeOrder'),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_2,
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO-02 rejected works',
      changeValue: { amount: 2000000, currency: 'USD' },
      status: 'submitted',
      version: 5,
    },
  });
  const order2Rejected = await appendCommandEvent(source, {
    command: commandOf(8, 'contracts.rejectChangeOrder'),
    eventName: 'contracts.changeOrderRejected',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_2,
      status: 'rejected',
      decidedAt: T2,
      version: 6,
    },
  });
  const order3Submitted = await appendCommandEvent(source, {
    command: commandOf(9, 'contracts.submitChangeOrder'),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T3,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_3,
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO-03 pending works',
      changeValue: { amount: 1000000, currency: 'USD' },
      status: 'submitted',
      version: 7,
    },
  });
  const claimReferenced = await appendCommandEvent(source, {
    command: commandOf(10, 'contracts.referenceClaim'),
    eventName: 'contracts.claimReferenced',
    scope,
    occurredAt: T4,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      claimReferenceId: CLAIM_REFERENCE_1,
      claimEntityKind: 'field-issue',
      claimEntityId: FIELD_ISSUE_ID,
      changeOrderId: CHANGE_ORDER_1,
      documentId: DOCUMENT_ID,
      revisionId: DOCUMENT_REVISION_1,
    },
  });
  return {
    documentRegistered,
    revisionAttached,
    contractCreated,
    changeEventRaised,
    order1Submitted,
    order1Approved,
    order2Submitted,
    order2Rejected,
    order3Submitted,
    claimReferenced,
  };
};

// ---------------------------------------------------------------------------
// Scenario 4 — MARGIN aggregation: contracted − committed − projected with
// evidence refs at each layer (two commitments + an amendment, a budget
// revision, a post-change item, an approved order, and an invoice the fold
// deterministically skips). Variants: drop the commitment amendment.
// ---------------------------------------------------------------------------

/** The events of the margin scenario (null when a variant dropped one). */
export interface MarginScenarioEvents {
  readonly contractCreated: LedgerEvent;
  readonly budgetCreated: LedgerEvent;
  readonly costItem1Recorded: LedgerEvent;
  readonly commitment1Created: LedgerEvent;
  readonly commitment1Amended: LedgerEvent | null;
  readonly commitment2Created: LedgerEvent;
  readonly changeEventRaised: LedgerEvent;
  readonly budgetRevised: LedgerEvent;
  readonly costItem2Recorded: LedgerEvent;
  readonly changeOrderSubmitted: LedgerEvent;
  readonly changeOrderApproved: LedgerEvent;
  readonly invoiceRecorded: LedgerEvent;
}

/** The golden margin-aggregation assessment shape. */
export const MARGIN_SCENARIO_GOLDEN: GoldenAssessment = {
  costImpact: {
    budgetRevisionDeltaMinor: 1500000,
    itemDeltas: [{ budgetId: BUDGET_ID, costItemId: COST_ITEM_2, amountMinor: 1500000 }],
    revisionAnchors: [{ budgetId: BUDGET_ID, revisionId: BUDGET_REVISION_1 }],
  },
  scheduleImpact: {
    activityDeltas: [],
    projectDurationDelta: 0,
    preProjectDuration: 0,
    currentProjectDuration: 0,
    basisAnchorEventNames: [],
  },
  entitlementImpact: {
    status: 'entitled',
    approvedValueMinor: 4500000,
    rejectedValueMinor: 0,
    pendingValueMinor: 0,
    orders: [{ changeOrderId: CHANGE_ORDER_1, valueMinor: 4500000, status: 'approved', claims: [] }],
  },
  marginPosition: {
    currency: 'USD',
    contractedValueMinor: 17000000,
    committedCostMinor: 8000000,
    budgetedCostMinor: 10200000,
    projectedCostMinor: 9500000,
    marginMinor: 7500000,
    marginOverCommittedMinor: 9000000,
  },
  confidence: { level: 'high', reasons: ['complete-inputs'] },
  consumed: { projectedEventCount: 12, subgraphNodeCount: 8, subgraphEdgeCount: 7 },
  evidenceEventNames: [
    'contracts.changeEventRaised',
    'contracts.changeOrderApproved',
    'contracts.changeOrderSubmitted',
    'contracts.contractCreated',
    'cost.budgetRevised',
    'cost.commitmentAmended',
    'cost.commitmentCreated',
    'cost.costItemRecorded',
    'cost.costItemRecorded',
  ],
};

/**
 * Append the margin-aggregation stream: contract CT (12,500,000), budget B
 * with CI1 (10,200,000), commitments CM1 (6,000,000 → amended 7,500,000)
 * and CM2 (500,000), the change event CE (impacting B), the post-change
 * revision BR1 + item CI2 (1,500,000), the approved order CO1 (4,500,000),
 * and one invoice against CM1 (3,000,000 — recognized by NO fold rule and
 * skipped deterministically).
 */
export const buildMarginScenario = async (
  source: InMemoryEventSource,
  parts: {
    readonly amendment?: boolean;
  } = {},
): Promise<MarginScenarioEvents> => {
  const scope = projectOneScope();
  const contractCreated = await appendCommandEvent(source, {
    command: commandOf(1, 'contracts.createContract'),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T0,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: 12500000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T0,
    },
  });
  const budgetCreated = await appendCommandEvent(source, {
    command: commandOf(2, 'cost.createBudget'),
    eventName: 'cost.budgetCreated',
    scope,
    occurredAt: T0,
    aggregate: budgetAggregate,
    payload: { budgetId: BUDGET_ID, name: 'Fit-out budget', currency: 'USD', version: 1, createdAt: T0 },
  });
  const costItem1Recorded = await appendCommandEvent(source, {
    command: commandOf(3, 'cost.recordCostItem'),
    eventName: 'cost.costItemRecorded',
    scope,
    occurredAt: T0,
    aggregate: budgetAggregate,
    payload: {
      budgetId: BUDGET_ID,
      costItemId: COST_ITEM_1,
      code: '02-41-00',
      description: 'Metal stud framing',
      unit: 'm2',
      quantityMilli: 1200,
      unitRateMinor: 8500,
      amountMinor: 10200000,
      version: 2,
    },
  });
  const commitment1Created = await appendCommandEvent(source, {
    command: commandOf(4, 'cost.createCommitment'),
    eventName: 'cost.commitmentCreated',
    scope,
    occurredAt: T1,
    aggregate: commitmentOneAggregate,
    payload: {
      commitmentId: COMMITMENT_1,
      budgetId: BUDGET_ID,
      number: 'SUB-101',
      commitmentKind: 'subcontract',
      description: 'Framing subcontract',
      lineCount: 1,
      committedAmountMinor: 6000000,
      version: 1,
      createdAt: T1,
    },
  });
  let commitment1Amended: LedgerEvent | null = null;
  if (parts.amendment !== false) {
    commitment1Amended = await appendCommandEvent(source, {
      command: commandOf(5, 'cost.amendCommitment'),
      eventName: 'cost.commitmentAmended',
      scope,
      occurredAt: T1,
      aggregate: commitmentOneAggregate,
      payload: {
        commitmentId: COMMITMENT_1,
        amendmentId: AMENDMENT_1,
        sequence: 1,
        reason: 'scope addition priced',
        lineCount: 1,
        committedAmountMinor: 7500000,
        version: 2,
        amendedAt: T1,
      },
    });
  }
  const commitment2Created = await appendCommandEvent(source, {
    command: commandOf(6, 'cost.createCommitment'),
    eventName: 'cost.commitmentCreated',
    scope,
    occurredAt: T1,
    aggregate: commitmentTwoAggregate,
    payload: {
      commitmentId: COMMITMENT_2,
      budgetId: BUDGET_ID,
      number: 'PO-201',
      commitmentKind: 'purchase-order',
      description: 'Framing materials',
      lineCount: 1,
      committedAmountMinor: 500000,
      version: 1,
      createdAt: T1,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(7, 'contracts.raiseChangeEvent'),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeEventId: CHANGE_EVENT_ID,
      title: 'Wall closing amended',
      changeType: 'scope',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [],
      costImpactLinks: [{ budgetId: BUDGET_ID, costItemId: null }],
      scheduleImpactActivityIds: [],
      version: 2,
    },
  });
  const budgetRevised = await appendCommandEvent(source, {
    command: commandOf(8, 'cost.reviseBudget'),
    eventName: 'cost.budgetRevised',
    scope,
    occurredAt: T3,
    aggregate: budgetAggregate,
    payload: {
      budgetId: BUDGET_ID,
      revisionId: BUDGET_REVISION_1,
      sequence: 1,
      label: 'Re-baseline after wall closing change',
      supersedes: null,
      costItemCount: 1,
      version: 3,
      createdAt: T3,
    },
  });
  const costItem2Recorded = await appendCommandEvent(source, {
    command: commandOf(9, 'cost.recordCostItem'),
    eventName: 'cost.costItemRecorded',
    scope,
    occurredAt: T3,
    aggregate: budgetAggregate,
    payload: {
      budgetId: BUDGET_ID,
      costItemId: COST_ITEM_2,
      code: '02-41-10',
      description: 'Additional stud framing',
      unit: 'm2',
      quantityMilli: 200,
      unitRateMinor: 7500,
      amountMinor: 1500000,
      version: 4,
    },
  });
  const changeOrderSubmitted = await appendCommandEvent(source, {
    command: commandOf(10, 'contracts.submitChangeOrder'),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T4,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_1,
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO-01 wall closing amendment',
      changeValue: { amount: 4500000, currency: 'USD' },
      status: 'submitted',
      version: 3,
    },
  });
  const changeOrderApproved = await appendCommandEvent(source, {
    command: commandOf(11, 'contracts.approveChangeOrder'),
    eventName: 'contracts.changeOrderApproved',
    scope,
    occurredAt: T4,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_1,
      status: 'approved',
      decidedAt: T4,
      version: 4,
    },
  });
  const invoiceRecorded = await appendCommandEvent(source, {
    command: commandOf(12, 'cost.recordInvoice'),
    eventName: 'cost.invoiceRecorded',
    scope,
    occurredAt: T4,
    aggregate: commitmentOneAggregate,
    payload: {
      invoiceId: INVOICE_1,
      commitmentId: COMMITMENT_1,
      number: 'INV-3001',
      lineCount: 1,
      invoicedAmountMinor: 3000000,
      version: 3,
      createdAt: T4,
    },
  });
  return {
    contractCreated,
    budgetCreated,
    costItem1Recorded,
    commitment1Created,
    commitment1Amended,
    commitment2Created,
    changeEventRaised,
    budgetRevised,
    costItem2Recorded,
    changeOrderSubmitted,
    changeOrderApproved,
    invoiceRecorded,
  };
};
