// Office intelligence — golden control-tower scenarios (OFF-019, package-internal).
//
// Deterministic fixtures for THE named acceptance of the exception engine:
// the golden seeded portfolio (a SCHEDULE SLIP change with a downstream
// dependency chain, a COST OVERRUN change whose projected cost exceeds the
// contracted value, an ENTITLEMENT EXPOSURE change with undecided order
// value, and an EVIDENCE GAP change whose assessment carries low
// confidence) scanned together with a memory-benchmark calibration context
// derived from completed-project history. The same builders always
// reproduce the identical streams (fixed ids, fixed clock, fixed
// correlation/causation tokens), so the scan + ranking over them is
// byte-identical across runs and input orderings — the acceptance test.
//
// Every builder appends a ledger-shaped event stream to its own in-memory
// source (mirroring the landed margin engine's scenario idioms through the
// PUBLIC peer surfaces only: projectRelationships / traverseRelationships
// / projectCommercialFacts / calculateImpact / deriveOutcome /
// computeBenchmarks — no package-internal module is imported).
import { parseTimestamp } from '@office/contracts';
import type { EntityId, EntityRef, Scope, Timestamp } from '@office/contracts';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import {
  calculateImpact,
  projectCommercialFacts,
} from '@office/intelligence-margin';
import type { CommercialFacts, ImpactAssessment } from '@office/intelligence-margin';
import {
  computeBenchmarks,
  deriveOutcome,
  parseBenchmarkId,
  parseOutcomeId,
} from '@office/intelligence-memory';
import type { Benchmark, OutcomeRecord } from '@office/intelligence-memory';
import {
  BUDGET_KIND,
  COMMITMENT_KIND,
  CONTRACT_KIND,
  DOCUMENT_KIND,
  SCHEDULE_KIND,
  projectRelationships,
  traverseRelationships,
} from '@office/intelligence-relationships';
import type { TraversalSubgraph } from '@office/intelligence-relationships';
import {
  ASSESSED_AT,
  DETECTED_AT,
  T0,
  T1,
  T2,
  T3,
  T4,
  appendCommandEvent,
  newEventSource,
  projectOneReader,
  projectOneScope,
  projectTwoScope,
  testAssessmentId,
  testCommand,
  testCorrelationId,
  testId,
  testKey,
  testScanId,
  unwrap,
} from './test-support';
import { CHANGE_EVENT_KIND, DEFAULT_PRIORITY_WEIGHTS } from './model';
import type { Exception, RankedException } from './model';
import { detectExceptions } from './scan';
import { rankExceptions } from './rank';
import { exceptionAuthorizationOf } from './test-support';

// ----- shared deterministic ids -----------------------------------------------------

// Scenario A — the schedule slip (project 1).
export const SCHEDULE_CONTRACT = testId('con', 1);
export const SCHEDULE_ID = testId('sch', 1);
export const SLIP_ACTIVITY_1 = testId('act', 1);
export const SLIP_ACTIVITY_2 = testId('act', 2);
export const SLIP_ACTIVITY_3 = testId('act', 3);
export const SLIP_DEPENDENCY_1 = testId('dep', 1);
export const SLIP_DEPENDENCY_2 = testId('dep', 2);
export const SLIP_BASELINE = testId('bas', 1);
export const SLIP_PROGRESS = testId('prg', 1);
export const SCHEDULE_CHANGE_EVENT = testId('chg', 1);

// Scenario B — the cost overrun (project 1).
export const COST_CONTRACT = testId('con', 2);
export const COST_BUDGET = testId('bud', 2);
export const COST_ITEM_1 = testId('cst', 21);
export const COST_ITEM_2 = testId('cst', 22);
export const COST_COMMITMENT = testId('cmt', 2);
export const COST_BUDGET_REVISION = testId('brv', 2);
export const COST_CHANGE_EVENT = testId('chg', 2);

// Scenario C — the entitlement exposure (project 1).
export const ENTITLEMENT_CONTRACT = testId('con', 3);
export const ENTITLEMENT_CHANGE_EVENT = testId('chg', 3);
export const ENTITLEMENT_ORDER_1 = testId('ord', 31);
export const ENTITLEMENT_ORDER_2 = testId('ord', 32);
export const ENTITLEMENT_ORDER_3 = testId('ord', 33);
export const ENTITLEMENT_CLAIM = testId('clr', 31);
export const ENTITLEMENT_DOCUMENT = testId('doc', 31);
export const ENTITLEMENT_REVISION = testId('rev', 31);
export const ENTITLEMENT_FIELD_ISSUE = testId('iss', 31);

// Scenario D — the evidence gap (project 1).
export const GAP_CONTRACT = testId('con', 4);
export const GAP_CHANGE_EVENT = testId('chg', 4);

// The completed-project history (project 2, tenant A) the calibration
// benchmark is computed over: three finished projects with schedule
// variances 0, 1, and 1 days and full-margin contract positions.
export const HISTORY_SCHEDULE = testId('sch', 9);
export const HISTORY_ACTIVITY_1 = testId('act', 91);
export const HISTORY_ACTIVITY_2 = testId('act', 92);
export const HISTORY_ACTIVITY_3 = testId('act', 93);
export const HISTORY_DEPENDENCY_1 = testId('dep', 9);
export const HISTORY_DEPENDENCY_2 = testId('dep', 92);
export const HISTORY_BASELINE = testId('bas', 9);
export const HISTORY_CONTRACT = testId('con', 9);
export const HISTORY_CHANGE_EVENT = testId('chg', 9);

const HISTORY_SLIP_DAYS: readonly number[] = [0, 1, 1];

const commandOf = (key: number, commandName: string, scope: Scope) =>
  testCommand({
    commandName,
    scope,
    idempotencyKey: testKey(key),
    correlationId: testCorrelationId(key),
    issuedAt: T0,
  });

/** One scenario's built stream: its events + the change event it assesses. */
export interface ScenarioBuilt {
  /** The scenario's full ledger stream, in append order. */
  readonly events: readonly LedgerEvent[];
  /** The change event entity the scenario's assessment assesses. */
  readonly changeEventId: EntityId;
  /** The ledger id of the `contracts.changeEventRaised` event (the source). */
  readonly sourceEventId: LedgerEventId;
  /** The deterministic assessment identity of the scenario's assessment. */
  readonly assessmentId: ReturnType<typeof testAssessmentId>;
}

// ---------------------------------------------------------------------------
// Scenario A — the SCHEDULE SLIP stream (project 1): A1(5) -FS0-> A2(4)
// -FS2-> A3(3) with the baseline B1, the contract (20M), the change event
// (impacting A2 + A3), the post-change duration update of A2 (4 -> 7), and
// the post-change progress of A3 (50%, remaining 2) — the assessment
// forecasts a +2-day program slip with A3 gated behind the slipped A2.
// ---------------------------------------------------------------------------

export const buildScheduleSlipScenario = async (): Promise<ScenarioBuilt> => {
  const scope = projectOneScope();
  const source = newEventSource();
  const scheduleAggregate: EntityRef = { entityKind: SCHEDULE_KIND, entityId: SCHEDULE_ID };
  const contractAggregate: EntityRef = { entityKind: CONTRACT_KIND, entityId: SCHEDULE_CONTRACT };
  // The aggregate of `contracts.changeEventRaised` is the CHANGE EVENT (the
  // domain envelope's entityRefs.after is the change-event ref) — this is
  // what registers an isolated change event as a node in the relationship
  // index even when it carries no links at all.
  const changeEventAggregate: EntityRef = {
    entityKind: CHANGE_EVENT_KIND,
    entityId: SCHEDULE_CHANGE_EVENT,
  };

  await appendCommandEvent(source, {
    command: commandOf(1, 'schedule.createSchedule', scope),
    eventName: 'schedule.scheduleCreated',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: { scheduleId: SCHEDULE_ID, name: 'Tower fit-out', version: 1, createdAt: T0 },
  });
  await appendCommandEvent(source, {
    command: commandOf(2, 'schedule.addActivity', scope),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      activityId: SLIP_ACTIVITY_1,
      code: 'A1',
      name: 'Framing level 3',
      plannedDuration: 5,
      parentActivityId: null,
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(3, 'schedule.addActivity', scope),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      activityId: SLIP_ACTIVITY_2,
      code: 'A2',
      name: 'Wall closing',
      plannedDuration: 4,
      parentActivityId: null,
      version: 3,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(4, 'schedule.addActivity', scope),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      activityId: SLIP_ACTIVITY_3,
      code: 'A3',
      name: 'Ceiling closure',
      plannedDuration: 3,
      parentActivityId: null,
      version: 4,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(5, 'schedule.addDependency', scope),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      dependencyId: SLIP_DEPENDENCY_1,
      predecessorId: SLIP_ACTIVITY_1,
      successorId: SLIP_ACTIVITY_2,
      linkType: 'FS',
      lagDays: 0,
      version: 5,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(6, 'schedule.addDependency', scope),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      dependencyId: SLIP_DEPENDENCY_2,
      predecessorId: SLIP_ACTIVITY_2,
      successorId: SLIP_ACTIVITY_3,
      linkType: 'FS',
      lagDays: 2,
      version: 6,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(7, 'schedule.setBaseline', scope),
    eventName: 'schedule.baselineSet',
    scope,
    occurredAt: T1,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      baselineId: SLIP_BASELINE,
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
  await appendCommandEvent(source, {
    command: commandOf(8, 'contracts.createContract', scope),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T1,
    aggregate: contractAggregate,
    payload: {
      contractId: SCHEDULE_CONTRACT,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: 20000000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T1,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(9, 'contracts.raiseChangeEvent', scope),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T2,
    aggregate: changeEventAggregate,
    payload: {
      contractId: SCHEDULE_CONTRACT,
      changeEventId: SCHEDULE_CHANGE_EVENT,
      title: 'Wall closing sequence change',
      changeType: 'schedule',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [],
      costImpactLinks: [],
      scheduleImpactActivityIds: [SLIP_ACTIVITY_2, SLIP_ACTIVITY_3],
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(10, 'schedule.updateActivity', scope),
    eventName: 'schedule.activityUpdated',
    scope,
    occurredAt: T2,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      activityId: SLIP_ACTIVITY_2,
      code: 'A2',
      plannedDuration: 7,
      version: 8,
      updatedAt: T2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(11, 'schedule.recordProgress', scope),
    eventName: 'schedule.progressRecorded',
    scope,
    occurredAt: T2,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      progressUpdateId: SLIP_PROGRESS,
      activityId: SLIP_ACTIVITY_3,
      percentComplete: 50,
      remainingDuration: 2,
      actualStart: T2,
      actualFinish: null,
      version: 9,
    },
  });

  return {
    events: unwrap(await source.readEvents()),
    changeEventId: SCHEDULE_CHANGE_EVENT,
    sourceEventId: changeEventRaised.eventId,
    assessmentId: testAssessmentId(1),
  };
};

// ---------------------------------------------------------------------------
// Scenario B — the COST OVERRUN stream (project 1): contract CT2 (8M),
// budget B2 with cost item CI21 (5M), commitment CM2 (9M — above the
// contracted value already), the change event CE2 (impacting B2 + CI21),
// the post-change budget revision BR2, and the post-change item CI22
// (2M). The assessment projects 11M against 8M contracted — a 3M overrun
// (3/8 of contracted value, escalated critical by the margin-ratio
// benchmark calibration).
// ---------------------------------------------------------------------------

export const buildCostOverrunScenario = async (): Promise<ScenarioBuilt> => {
  const scope = projectOneScope();
  const source = newEventSource();
  const contractAggregate: EntityRef = { entityKind: CONTRACT_KIND, entityId: COST_CONTRACT };
  const budgetAggregate: EntityRef = { entityKind: BUDGET_KIND, entityId: COST_BUDGET };
  const commitmentAggregate: EntityRef = { entityKind: COMMITMENT_KIND, entityId: COST_COMMITMENT };
  const changeEventAggregate: EntityRef = {
    entityKind: CHANGE_EVENT_KIND,
    entityId: COST_CHANGE_EVENT,
  };

  await appendCommandEvent(source, {
    command: commandOf(1, 'contracts.createContract', scope),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T0,
    aggregate: contractAggregate,
    payload: {
      contractId: COST_CONTRACT,
      title: 'MEP works contract',
      version: 1,
      contractValue: { amount: 8000000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T0,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(2, 'cost.createBudget', scope),
    eventName: 'cost.budgetCreated',
    scope,
    occurredAt: T0,
    aggregate: budgetAggregate,
    payload: { budgetId: COST_BUDGET, name: 'MEP budget', currency: 'USD', version: 1, createdAt: T0 },
  });
  await appendCommandEvent(source, {
    command: commandOf(3, 'cost.recordCostItem', scope),
    eventName: 'cost.costItemRecorded',
    scope,
    occurredAt: T0,
    aggregate: budgetAggregate,
    payload: {
      budgetId: COST_BUDGET,
      costItemId: COST_ITEM_1,
      code: '23-00-00',
      description: 'HVAC rough-in',
      unit: 'lot',
      quantityMilli: 1000,
      unitRateMinor: 5000,
      amountMinor: 5000000,
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(4, 'cost.createCommitment', scope),
    eventName: 'cost.commitmentCreated',
    scope,
    occurredAt: T1,
    aggregate: commitmentAggregate,
    payload: {
      commitmentId: COST_COMMITMENT,
      budgetId: COST_BUDGET,
      number: 'SUB-201',
      commitmentKind: 'subcontract',
      description: 'HVAC subcontract',
      lineCount: 1,
      committedAmountMinor: 9000000,
      version: 1,
      createdAt: T1,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(5, 'contracts.raiseChangeEvent', scope),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T1,
    aggregate: changeEventAggregate,
    payload: {
      contractId: COST_CONTRACT,
      changeEventId: COST_CHANGE_EVENT,
      title: 'Duct routing amended',
      changeType: 'scope',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [],
      costImpactLinks: [{ budgetId: COST_BUDGET, costItemId: COST_ITEM_1 }],
      scheduleImpactActivityIds: [],
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(6, 'cost.reviseBudget', scope),
    eventName: 'cost.budgetRevised',
    scope,
    occurredAt: T2,
    aggregate: budgetAggregate,
    payload: {
      budgetId: COST_BUDGET,
      revisionId: COST_BUDGET_REVISION,
      sequence: 1,
      label: 'Re-baseline after duct routing change',
      supersedes: null,
      costItemCount: 1,
      version: 3,
      createdAt: T2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(7, 'cost.recordCostItem', scope),
    eventName: 'cost.costItemRecorded',
    scope,
    occurredAt: T2,
    aggregate: budgetAggregate,
    payload: {
      budgetId: COST_BUDGET,
      costItemId: COST_ITEM_2,
      code: '23-00-10',
      description: 'Additional duct routing',
      unit: 'lot',
      quantityMilli: 400,
      unitRateMinor: 5000,
      amountMinor: 2000000,
      version: 4,
    },
  });

  return {
    events: unwrap(await source.readEvents()),
    changeEventId: COST_CHANGE_EVENT,
    sourceEventId: changeEventRaised.eventId,
    assessmentId: testAssessmentId(2),
  };
};

// ---------------------------------------------------------------------------
// Scenario C — the ENTITLEMENT EXPOSURE stream (project 1): contract CT3
// (10M base; the folded contracted position is 14.5M after the approved
// order CO31), the change event CE3 (claim type, evidenced by D31/R31),
// three change orders (CO31 approved 4.5M, CO32 rejected 2M, CO33 still
// submitted 1M), and one claim reference against CO31. The assessment
// leaves 1M of submitted-but-undecided value exposed — 1M over the 14.5M
// contracted position (2/29, above the 1/20 moderate threshold).
// ---------------------------------------------------------------------------

export const buildEntitlementScenario = async (): Promise<ScenarioBuilt> => {
  const scope = projectOneScope();
  const source = newEventSource();
  const contractAggregate: EntityRef = { entityKind: CONTRACT_KIND, entityId: ENTITLEMENT_CONTRACT };
  const documentAggregate: EntityRef = { entityKind: DOCUMENT_KIND, entityId: ENTITLEMENT_DOCUMENT };
  const changeEventAggregate: EntityRef = {
    entityKind: CHANGE_EVENT_KIND,
    entityId: ENTITLEMENT_CHANGE_EVENT,
  };

  await appendCommandEvent(source, {
    command: commandOf(1, 'documents.registerDocument', scope),
    eventName: 'documents.documentRegistered',
    scope,
    occurredAt: T0,
    aggregate: documentAggregate,
    payload: {
      documentId: ENTITLEMENT_DOCUMENT,
      projectId: scope.kind === 'project' ? scope.projectId : null,
      title: 'Site condition photos',
      status: 'active',
      version: 1,
      createdAt: T0,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(2, 'documents.attachRevision', scope),
    eventName: 'documents.revisionAttached',
    scope,
    occurredAt: T0,
    aggregate: documentAggregate,
    payload: {
      documentId: ENTITLEMENT_DOCUMENT,
      revisionId: ENTITLEMENT_REVISION,
      contentHash: 'sha256-9a8b7c6d5e',
      storageKey: 'documents/site-conditions/r1',
      byteSize: 4096,
      supersedes: null,
      attachedAt: T0,
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(3, 'contracts.createContract', scope),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T0,
    aggregate: contractAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      title: 'Site works contract',
      version: 1,
      contractValue: { amount: 10000000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T0,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(4, 'contracts.raiseChangeEvent', scope),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T1,
    aggregate: changeEventAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      changeEventId: ENTITLEMENT_CHANGE_EVENT,
      title: 'Site condition disputed',
      changeType: 'claim',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [{ documentId: ENTITLEMENT_DOCUMENT, revisionId: ENTITLEMENT_REVISION }],
      costImpactLinks: [],
      scheduleImpactActivityIds: [],
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(5, 'contracts.submitChangeOrder', scope),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      changeOrderId: ENTITLEMENT_ORDER_1,
      changeEventId: ENTITLEMENT_CHANGE_EVENT,
      title: 'CO-31 approved works',
      changeValue: { amount: 4500000, currency: 'USD' },
      status: 'submitted',
      version: 3,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(6, 'contracts.approveChangeOrder', scope),
    eventName: 'contracts.changeOrderApproved',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      changeOrderId: ENTITLEMENT_ORDER_1,
      status: 'approved',
      decidedAt: T2,
      version: 4,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(7, 'contracts.submitChangeOrder', scope),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      changeOrderId: ENTITLEMENT_ORDER_2,
      changeEventId: ENTITLEMENT_CHANGE_EVENT,
      title: 'CO-32 rejected works',
      changeValue: { amount: 2000000, currency: 'USD' },
      status: 'submitted',
      version: 5,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(8, 'contracts.rejectChangeOrder', scope),
    eventName: 'contracts.changeOrderRejected',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      changeOrderId: ENTITLEMENT_ORDER_2,
      status: 'rejected',
      decidedAt: T2,
      version: 6,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(9, 'contracts.submitChangeOrder', scope),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T3,
    aggregate: contractAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      changeOrderId: ENTITLEMENT_ORDER_3,
      changeEventId: ENTITLEMENT_CHANGE_EVENT,
      title: 'CO-33 pending works',
      changeValue: { amount: 1000000, currency: 'USD' },
      status: 'submitted',
      version: 7,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(10, 'contracts.referenceClaim', scope),
    eventName: 'contracts.claimReferenced',
    scope,
    occurredAt: T4,
    aggregate: contractAggregate,
    payload: {
      contractId: ENTITLEMENT_CONTRACT,
      claimReferenceId: ENTITLEMENT_CLAIM,
      claimEntityKind: 'field-issue',
      claimEntityId: ENTITLEMENT_FIELD_ISSUE,
      changeOrderId: ENTITLEMENT_ORDER_1,
      documentId: ENTITLEMENT_DOCUMENT,
      revisionId: ENTITLEMENT_REVISION,
    },
  });

  return {
    events: unwrap(await source.readEvents()),
    changeEventId: ENTITLEMENT_CHANGE_EVENT,
    sourceEventId: changeEventRaised.eventId,
    assessmentId: testAssessmentId(3),
  };
};

// ---------------------------------------------------------------------------
// Scenario D — the EVIDENCE GAP stream (project 1): contract CT4 (12M) and
// an ISOLATED change event CE4 (no cost/schedule links, no orders, no
// evidence links) — the assessment's subgraph has zero edges, so its
// confidence is low ('isolated-change-event') and the scan raises the
// evidence-gap exception.
// ---------------------------------------------------------------------------

export const buildEvidenceGapScenario = async (): Promise<ScenarioBuilt> => {
  const scope = projectOneScope();
  const source = newEventSource();
  const contractAggregate: EntityRef = { entityKind: CONTRACT_KIND, entityId: GAP_CONTRACT };
  // THE isolated change event: its raised event's aggregate is the change
  // event itself (the domain envelope shape), so the node exists in the
  // relationship index even though the event carries zero links — the
  // traversal then returns the zero-edge subgraph that makes the margin
  // assessment's confidence low ('isolated-change-event').
  const changeEventAggregate: EntityRef = {
    entityKind: CHANGE_EVENT_KIND,
    entityId: GAP_CHANGE_EVENT,
  };

  await appendCommandEvent(source, {
    command: commandOf(1, 'contracts.createContract', scope),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T0,
    aggregate: contractAggregate,
    payload: {
      contractId: GAP_CONTRACT,
      title: 'Envelope works contract',
      version: 1,
      contractValue: { amount: 12000000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T0,
    },
  });
  const changeEventRaised = await appendCommandEvent(source, {
    command: commandOf(2, 'contracts.raiseChangeEvent', scope),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T1,
    aggregate: changeEventAggregate,
    payload: {
      contractId: GAP_CONTRACT,
      changeEventId: GAP_CHANGE_EVENT,
      title: 'Facade detail query',
      changeType: 'clarification',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [],
      costImpactLinks: [],
      scheduleImpactActivityIds: [],
      version: 2,
    },
  });

  return {
    events: unwrap(await source.readEvents()),
    changeEventId: GAP_CHANGE_EVENT,
    sourceEventId: changeEventRaised.eventId,
    assessmentId: testAssessmentId(4),
  };
};

// ---------------------------------------------------------------------------
// The completed-project HISTORY streams (project 2, tenant A): one builder
// parameterized by the slip days the finished project closed under. The
// three built histories (slips 0, 1, 1) produce the calibration benchmark
// (schedule-variance-days p90 = 1; margin-ratio min = 1/1).
// ---------------------------------------------------------------------------

const buildHistoryScenario = async (
  n: number,
  slipDays: number,
): Promise<ScenarioBuilt> => {
  const scope = projectTwoScope();
  const source = newEventSource();
  const scheduleAggregate: EntityRef = { entityKind: SCHEDULE_KIND, entityId: HISTORY_SCHEDULE };
  const contractAggregate: EntityRef = { entityKind: CONTRACT_KIND, entityId: HISTORY_CONTRACT };
  const changeEventAggregate: EntityRef = {
    entityKind: CHANGE_EVENT_KIND,
    entityId: HISTORY_CHANGE_EVENT,
  };

  await appendCommandEvent(source, {
    command: commandOf(1, 'schedule.createSchedule', scope),
    eventName: 'schedule.scheduleCreated',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: { scheduleId: HISTORY_SCHEDULE, name: 'History tower', version: 1, createdAt: T0 },
  });
  await appendCommandEvent(source, {
    command: commandOf(2, 'schedule.addActivity', scope),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: HISTORY_SCHEDULE,
      activityId: HISTORY_ACTIVITY_1,
      code: 'H1',
      name: 'History framing',
      plannedDuration: 5,
      parentActivityId: null,
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(3, 'schedule.addActivity', scope),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: HISTORY_SCHEDULE,
      activityId: HISTORY_ACTIVITY_2,
      code: 'H2',
      name: 'History closing',
      plannedDuration: 4,
      parentActivityId: null,
      version: 3,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(4, 'schedule.addActivity', scope),
    eventName: 'schedule.activityAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: HISTORY_SCHEDULE,
      activityId: HISTORY_ACTIVITY_3,
      code: 'H3',
      name: 'History ceiling',
      plannedDuration: 3,
      parentActivityId: null,
      version: 4,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(5, 'schedule.addDependency', scope),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: HISTORY_SCHEDULE,
      dependencyId: HISTORY_DEPENDENCY_1,
      predecessorId: HISTORY_ACTIVITY_1,
      successorId: HISTORY_ACTIVITY_2,
      linkType: 'FS',
      lagDays: 0,
      version: 5,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(6, 'schedule.addDependency', scope),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: HISTORY_SCHEDULE,
      dependencyId: HISTORY_DEPENDENCY_2,
      predecessorId: HISTORY_ACTIVITY_2,
      successorId: HISTORY_ACTIVITY_3,
      linkType: 'FS',
      lagDays: 2,
      version: 6,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(7, 'schedule.setBaseline', scope),
    eventName: 'schedule.baselineSet',
    scope,
    occurredAt: T1,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: HISTORY_SCHEDULE,
      baselineId: HISTORY_BASELINE,
      sequence: 1,
      label: 'History baseline',
      supersedes: null,
      activityCount: 3,
      dependencyCount: 2,
      milestoneCount: 0,
      version: 7,
      createdAt: T1,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(8, 'contracts.createContract', scope),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T1,
    aggregate: contractAggregate,
    payload: {
      contractId: HISTORY_CONTRACT,
      title: 'History works contract',
      version: 1,
      contractValue: { amount: 20000000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T1,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(9, 'contracts.raiseChangeEvent', scope),
    eventName: 'contracts.changeEventRaised',
    scope,
    occurredAt: T2,
    aggregate: changeEventAggregate,
    payload: {
      contractId: HISTORY_CONTRACT,
      changeEventId: HISTORY_CHANGE_EVENT,
      title: 'History closing change',
      changeType: 'schedule',
      status: 'proposed',
      affectedObligationIds: [],
      evidenceLinks: [],
      costImpactLinks: [],
      scheduleImpactActivityIds: [HISTORY_ACTIVITY_2, HISTORY_ACTIVITY_3],
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(10, 'schedule.updateActivity', scope),
    eventName: 'schedule.activityUpdated',
    scope,
    occurredAt: T2,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: HISTORY_SCHEDULE,
      activityId: HISTORY_ACTIVITY_2,
      code: 'H2',
      plannedDuration: 4 + slipDays,
      version: 8,
      updatedAt: T2,
    },
  });

  const events = unwrap(await source.readEvents());
  const found = events.find((event) => event.envelope.eventName === 'contracts.changeEventRaised');
  if (found === undefined) {
    throw new Error('history scenario stream is missing its changeEventRaised event');
  }
  return {
    events,
    changeEventId: HISTORY_CHANGE_EVENT,
    sourceEventId: found.eventId,
    assessmentId: testAssessmentId(1000 + n),
  };
};

// ---------------------------------------------------------------------------
// The assessment pipeline (the public peer surfaces only).
// ---------------------------------------------------------------------------

const reader = () => projectOneReader();
const historyReader = () => exceptionAuthorizationOf(projectTwoScope());

/** One scenario's computed pipeline: facts + subgraph + assessment. */
export interface ScenarioAssessment {
  readonly facts: CommercialFacts;
  readonly subgraph: TraversalSubgraph;
  readonly assessment: ImpactAssessment;
}

const assessScenario = async (
  built: ScenarioBuilt,
): Promise<ScenarioAssessment> => {
  const index = unwrap(projectRelationships(built.events));
  const subgraph = unwrap(
    traverseRelationships(
      index,
      {
        start: { entityKind: CHANGE_EVENT_KIND, entityId: built.changeEventId },
        maxDepth: 2,
      },
      { policy: reader().policy, context: reader().context },
    ),
  );
  const facts = unwrap(projectCommercialFacts(built.events));
  const assessment = unwrap(
    calculateImpact(
      { sourceEventId: built.sourceEventId },
      { facts, subgraph },
      reader(),
      { assessmentId: built.assessmentId, assessedAt: ASSESSED_AT },
    ),
  );
  return { facts, subgraph, assessment };
};

const assessHistory = async (built: ScenarioBuilt): Promise<ImpactAssessment> => {
  const index = unwrap(projectRelationships(built.events));
  const subgraph = unwrap(
    traverseRelationships(
      index,
      {
        start: {
          entityKind: CHANGE_EVENT_KIND,
          entityId: built.changeEventId,
        },
        maxDepth: 2,
      },
      { policy: historyReader().policy, context: historyReader().context },
    ),
  );
  const facts = unwrap(projectCommercialFacts(built.events));
  return unwrap(
    calculateImpact(
      { sourceEventId: built.sourceEventId },
      { facts, subgraph },
      historyReader(),
      { assessmentId: built.assessmentId, assessedAt: ASSESSED_AT },
    ),
  );
};

/** The recorded-at clock of the history outcomes (injected). */
export const RECORDED_AT: Timestamp = unwrap(
  parseTimestamp('2026-09-20T09:00:00.000Z'),
);

/** The computed-at clock of the calibration benchmark (injected). */
export const COMPUTED_AT: Timestamp = unwrap(
  parseTimestamp('2026-09-21T09:00:00.000Z'),
);

/**
 * Build THE calibration benchmark: derive the three completed-project
 * outcomes (schedule variances 0, 1, 1; full-margin positions) and compute
 * the tenant-A benchmark over them (schedule-variance-days p90 = 1/1,
 * margin-ratio min = 1/1).
 */
export const buildCalibrationBenchmark = async (): Promise<{
  readonly benchmark: Benchmark;
  readonly outcomes: readonly OutcomeRecord[];
}> => {
  const outcomes: OutcomeRecord[] = [];
  for (const [index, slipDays] of HISTORY_SLIP_DAYS.entries()) {
    const history = await buildHistoryScenario(index + 1, slipDays);
    const assessment = await assessHistory(history);
    const outcome = unwrap(
      deriveOutcome(
        {
          facts: unwrap(projectCommercialFacts(history.events)),
          assessments: [assessment],
        },
        {
          outcomeId: unwrap(parseOutcomeId(`outcome-${String(index + 1).padStart(4, '0')}`)),
          recordedAt: RECORDED_AT,
          actor: reader().context.actor,
          scope: projectTwoScope(),
        },
      ),
    );
    outcomes.push(outcome);
  }
  const benchmark = unwrap(
    computeBenchmarks(outcomes, {
      benchmarkId: unwrap(parseBenchmarkId('benchmark-0001')),
      computedAt: COMPUTED_AT,
      actor: reader().context.actor,
      scope: { kind: 'tenant', tenantId: reader().context.scope.tenantId },
    }),
  );
  return { benchmark, outcomes };
};

// ---------------------------------------------------------------------------
// THE golden portfolio scan (the named acceptance).
// ---------------------------------------------------------------------------

/** One full run of the golden control-tower pipeline. */
export interface PortfolioScanRun {
  /** The four live scenarios, in canonical assessment order. */
  readonly scenarios: readonly ScenarioBuilt[];
  /** The four live assessments (the scan's economic inputs). */
  readonly assessments: readonly ImpactAssessment[];
  /** The four traversal subgraphs (the scan's structural inputs). */
  readonly subgraphs: readonly TraversalSubgraph[];
  /** The calibration benchmark (the scan's memory-fact input). */
  readonly benchmark: Benchmark;
  /** The detected exception set (canonical emission order). */
  readonly exceptions: readonly Exception[];
  /** The ranked exception set (the stable priority order). */
  readonly ranked: readonly RankedException[];
}

/**
 * Run THE golden portfolio scan: build the four live scenarios + the
 * completed-project history, compute the assessments + calibration
 * benchmark through the public peer surfaces, detect the exception set,
 * and rank it with the default seeded weights. Fully deterministic — the
 * same run twice produces byte-identical results.
 */
export const runPortfolioScan = async (): Promise<PortfolioScanRun> => {
  const scenarios: readonly ScenarioBuilt[] = [
    await buildScheduleSlipScenario(),
    await buildCostOverrunScenario(),
    await buildEntitlementScenario(),
    await buildEvidenceGapScenario(),
  ];
  const assessed: ScenarioAssessment[] = [];
  for (const scenario of scenarios) {
    assessed.push(await assessScenario(scenario));
  }
  const assessments = assessed.map((run) => run.assessment);
  const subgraphs = assessed.map((run) => run.subgraph);
  const { benchmark } = await buildCalibrationBenchmark();

  const exceptions = unwrap(
    detectExceptions(
      { assessments, subgraphs, benchmarks: [benchmark] },
      projectOneReader(),
      { scanId: testScanId(1), detectedAt: DETECTED_AT },
    ),
  );
  const ranked = unwrap(rankExceptions(exceptions, DEFAULT_PRIORITY_WEIGHTS));
  return { scenarios, assessments, subgraphs, benchmark, exceptions, ranked };
};

// ---------------------------------------------------------------------------
// The golden ordering summary (entity ids, kinds, severities, amounts, and
// the exact-rational totals — never ledger event ids; the exact source ids
// are asserted separately against the scenarios' returned events).
// ---------------------------------------------------------------------------

/** The golden (comparable) summary of one ranked exception. */
export interface GoldenRankEntry {
  readonly rank: number;
  readonly kind: string;
  readonly severityLevel: string;
  readonly amountMinor: number | null;
  readonly total: readonly [number, number];
}

/**
 * THE golden priority ordering of the seeded portfolio (the named
 * acceptance): the cost overrun (critical, 3M at stake, 13/20) leads, the
 * entitlement exposure (moderate, 1M at stake, 3/10) follows, the
 * benchmark-calibrated schedule slip (moderate, no direct money, 1/4)
 * third, and the two minor moneyless exceptions tie at 1/8 with the kind
 * tie-breaker ordering the dependency risk before the evidence gap.
 */
export const GOLDEN_PRIORITY_ORDER: readonly GoldenRankEntry[] = [
  { rank: 1, kind: 'cost-overrun', severityLevel: 'critical', amountMinor: 3000000, total: [13, 20] },
  { rank: 2, kind: 'entitlement-exposure', severityLevel: 'moderate', amountMinor: 1000000, total: [3, 10] },
  { rank: 3, kind: 'schedule-slip', severityLevel: 'moderate', amountMinor: null, total: [1, 4] },
  { rank: 4, kind: 'dependency-risk', severityLevel: 'minor', amountMinor: null, total: [1, 8] },
  { rank: 5, kind: 'evidence-gap', severityLevel: 'minor', amountMinor: null, total: [1, 8] },
];

/** Normalize one ranked exception into its golden (comparable) summary. */
export const rankedShapeOf = (ranked: RankedException): GoldenRankEntry => ({
  rank: ranked.rank,
  kind: ranked.exception.kind,
  severityLevel: ranked.exception.severity.level,
  amountMinor: ranked.exception.economicImpact.amountMinor,
  total: [ranked.score.total.numerator, ranked.score.total.denominator],
});
