// Office intelligence — golden traversal fixtures (OFF-013, package-internal).
//
// Deterministic construction-causal-chain fixtures: each builder appends a
// ledger-shaped event stream to an in-memory source (commands with fixed
// idempotency keys, one reaction event chained through causedByEvent), and
// each GOLDEN shape is the exact authorization-visible subgraph (or causal
// chain) the engine must return for it. The named acceptance chains:
//
//  1. The schedule dependency chain (activity A3 depends-on A2 depends-on A1).
//  2. The change-event chain: a change event evidenced-by a document
//     revision and impacting cost (budget, cost item) + schedule
//     (activities), with a change order derived from it and a claim
//     referenced against the order — plus the full causal chain from the
//     evidenced-by relationship back through command causation.
//  3. The field evidence chain: a captured field event evidenced-by its
//     linked document (the derivable field-domain coverage; see README for
//     the reported envelope gap behind "a field issue affecting an
//     activity" — no landed field event carries activity references, and
//     this engine invents no data).
import type { EntityId, EntityRef, ProjectId, Scope } from '@office/contracts';
import type { LedgerEvent } from '@office/events';
import type { TraversalSubgraph } from './model';
import type { RelationshipKind } from './vocabulary';
import type { InMemoryEventSource } from './source';
import {
  ACTIVITY_KIND,
  BUDGET_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CONTRACT_KIND,
  COST_ITEM_KIND,
  DOCUMENT_KIND,
  FIELD_EVENT_KIND,
  FIELD_ISSUE_KIND,
  REVISION_KIND,
  SCHEDULE_KIND,
} from './vocabulary';
import {
  appendCommandEvent,
  appendReactionEvent,
  projectScopeOf,
  PROJECT_1,
  T0,
  T1,
  T2,
  T3,
  testCommand,
  testCorrelationId,
  testId,
  testKey,
} from './test-support';

// ----- shared deterministic ids ------------------------------------------------------

export const SCHEDULE_ID = testId('sch', 1);
export const ACTIVITY_1 = testId('act', 1);
export const ACTIVITY_2 = testId('act', 2);
export const ACTIVITY_3 = testId('act', 3);
export const DEPENDENCY_1 = testId('dep', 1);
export const DEPENDENCY_2 = testId('dep', 2);
export const DOCUMENT_ID = testId('doc', 1);
export const REVISION_1 = testId('rev', 1);
export const REVISION_2 = testId('rev', 2);
export const BUDGET_ID = testId('bud', 1);
export const COST_ITEM_ID = testId('cst', 1);
export const CONTRACT_ID = testId('con', 1);
export const OBLIGATION_ID = testId('obl', 1);
export const CHANGE_EVENT_ID = testId('chg', 1);
export const CHANGE_ORDER_ID = testId('ord', 1);
export const CLAIM_REFERENCE_ID = testId('clr', 1);
export const CLAIM_ENTITY_ID = testId('iss', 1);
export const FIELD_EVENT_ID = testId('fld', 1);

const activity = (id: EntityId): EntityRef => ({ entityKind: ACTIVITY_KIND, entityId: id });

const commandOf = (key: number, commandName: string, scope: Scope): ReturnType<typeof testCommand> =>
  testCommand({
    commandName,
    scope,
    idempotencyKey: testKey(key),
    correlationId: testCorrelationId(key),
    issuedAt: T0,
  });

const projectOne: ProjectId = PROJECT_1;

// ----- golden subgraph shapes -------------------------------------------------------

/** The authorization-independent shape a golden subgraph asserts. */
export interface GoldenNode {
  readonly entityKind: string;
  readonly entityId: EntityId;
  readonly depth: number;
}

/** One golden edge: identity + the producing event's name. */
export interface GoldenEdge {
  readonly kind: RelationshipKind;
  readonly fromKind: string;
  readonly fromId: EntityId;
  readonly toKind: string;
  readonly toId: EntityId;
  readonly provenanceEventName: string;
}

/** A golden subgraph: exact node set (with depths) + exact edge set. */
export interface GoldenSubgraph {
  readonly nodes: readonly GoldenNode[];
  readonly edges: readonly GoldenEdge[];
}

/** Normalize a traversal subgraph into its golden (comparable) shape. */
export const subgraphShapeOf = (subgraph: TraversalSubgraph): GoldenSubgraph => ({
  nodes: subgraph.nodes.map((node) => ({
    entityKind: node.entity.entityKind,
    entityId: node.entity.entityId,
    depth: node.depth,
  })),
  edges: subgraph.edges.map((edge) => ({
    kind: edge.kind,
    fromKind: edge.from.entityKind,
    fromId: edge.from.entityId,
    toKind: edge.to.entityKind,
    toId: edge.to.entityId,
    provenanceEventName: edge.provenance.eventName,
  })),
});

// ----- fixture 1: the schedule dependency chain -------------------------------------

/** The golden traversal from ACTIVITY_3 along depends-on edges (depth 2). */
export const SCHEDULE_DEPENDENCY_CHAIN_GOLDEN: GoldenSubgraph = {
  nodes: [
    { entityKind: 'activity', entityId: ACTIVITY_3, depth: 0 },
    { entityKind: 'activity', entityId: ACTIVITY_2, depth: 1 },
    { entityKind: 'activity', entityId: ACTIVITY_1, depth: 2 },
  ],
  // Edges in the model's canonical relationship order (kind, from, to) —
  // the same order every index/traversal output collection carries.
  edges: [
    {
      kind: 'depends-on',
      fromKind: 'activity',
      fromId: ACTIVITY_2,
      toKind: 'activity',
      toId: ACTIVITY_1,
      provenanceEventName: 'schedule.dependencyAdded',
    },
    {
      kind: 'depends-on',
      fromKind: 'activity',
      fromId: ACTIVITY_3,
      toKind: 'activity',
      toId: ACTIVITY_2,
      provenanceEventName: 'schedule.dependencyAdded',
    },
  ],
};

/** The events returned for causal-chain assertions (in append order). */
export interface ScheduleChainEvents {
  readonly dependencyA2OnA1: LedgerEvent;
  readonly dependencyA3OnA2: LedgerEvent;
}

/**
 * Append the schedule dependency-chain stream: schedule S, activities A1..A3,
 * and dependencies (A2 depends-on A1) + (A3 depends-on A2).
 */
export const buildScheduleDependencyChainStream = async (
  source: InMemoryEventSource,
): Promise<ScheduleChainEvents> => {
  const scope = projectScopeOf(projectOne);
  const scheduleAggregate: EntityRef = { entityKind: SCHEDULE_KIND, entityId: SCHEDULE_ID };
  await appendCommandEvent(source, {
    command: commandOf(1, 'schedule.createSchedule', scope),
    eventName: 'schedule.scheduleCreated',
    scope,
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: { scheduleId: SCHEDULE_ID, name: 'Tower fit-out', version: 1, createdAt: T0 },
  });
  for (const [index, activityId] of [ACTIVITY_1, ACTIVITY_2, ACTIVITY_3].entries()) {
    await appendCommandEvent(source, {
      command: commandOf(2 + index, 'schedule.addActivity', scope),
      eventName: 'schedule.activityAdded',
      scope,
      occurredAt: T0,
      aggregate: scheduleAggregate,
      payload: {
        scheduleId: SCHEDULE_ID,
        activityId,
        code: `A${index + 1}`,
        name: `Activity ${index + 1}`,
        plannedDuration: 5,
        parentActivityId: null,
        version: 2 + index,
      },
    });
  }
  const dependencyA2OnA1 = await appendCommandEvent(source, {
    command: commandOf(5, 'schedule.addDependency', scope),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T1,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      dependencyId: DEPENDENCY_1,
      predecessorId: ACTIVITY_1,
      successorId: ACTIVITY_2,
      linkType: 'finish-to-start',
      lagDays: 0,
      version: 5,
    },
  });
  const dependencyA3OnA2 = await appendCommandEvent(source, {
    command: commandOf(6, 'schedule.addDependency', scope),
    eventName: 'schedule.dependencyAdded',
    scope,
    occurredAt: T1,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: SCHEDULE_ID,
      dependencyId: DEPENDENCY_2,
      predecessorId: ACTIVITY_2,
      successorId: ACTIVITY_3,
      linkType: 'finish-to-start',
      lagDays: 2,
      version: 6,
    },
  });
  return { dependencyA2OnA1, dependencyA3OnA2 };
};

// ----- fixture 2: the change-event causal chain --------------------------------------

/** The golden traversal from the change event (all kinds, depth 2, both directions). */
export const CHANGE_EVENT_CHAIN_GOLDEN: GoldenSubgraph = {
  nodes: [
    { entityKind: 'change-event', entityId: CHANGE_EVENT_ID, depth: 0 },
    { entityKind: 'activity', entityId: ACTIVITY_2, depth: 1 },
    { entityKind: 'activity', entityId: ACTIVITY_3, depth: 1 },
    { entityKind: 'budget', entityId: BUDGET_ID, depth: 1 },
    { entityKind: 'change-order', entityId: CHANGE_ORDER_ID, depth: 1 },
    { entityKind: 'cost-item', entityId: COST_ITEM_ID, depth: 1 },
    { entityKind: 'revision', entityId: REVISION_2, depth: 1 },
    { entityKind: 'scope-obligation', entityId: OBLIGATION_ID, depth: 1 },
    { entityKind: 'document', entityId: DOCUMENT_ID, depth: 2 },
    { entityKind: 'field-issue', entityId: CLAIM_ENTITY_ID, depth: 2 },
    { entityKind: 'revision', entityId: REVISION_1, depth: 2 },
  ],
  edges: [
    {
      kind: 'affects',
      fromKind: 'change-event',
      fromId: CHANGE_EVENT_ID,
      toKind: 'scope-obligation',
      toId: OBLIGATION_ID,
      provenanceEventName: 'contracts.changeEventRaised',
    },
    {
      kind: 'derives-from',
      fromKind: 'change-order',
      fromId: CHANGE_ORDER_ID,
      toKind: 'change-event',
      toId: CHANGE_EVENT_ID,
      provenanceEventName: 'contracts.changeOrderSubmitted',
    },
    {
      kind: 'derives-from',
      fromKind: 'cost-item',
      fromId: COST_ITEM_ID,
      toKind: 'budget',
      toId: BUDGET_ID,
      provenanceEventName: 'cost.costItemRecorded',
    },
    {
      kind: 'derives-from',
      fromKind: 'field-issue',
      fromId: CLAIM_ENTITY_ID,
      toKind: 'change-order',
      toId: CHANGE_ORDER_ID,
      provenanceEventName: 'contracts.claimReferenced',
    },
    {
      kind: 'derives-from',
      fromKind: 'revision',
      fromId: REVISION_2,
      toKind: 'document',
      toId: DOCUMENT_ID,
      provenanceEventName: 'documents.revisionSuperseded',
    },
    {
      kind: 'derives-from',
      fromKind: 'revision',
      fromId: REVISION_2,
      toKind: 'revision',
      toId: REVISION_1,
      provenanceEventName: 'documents.revisionSuperseded',
    },
    {
      kind: 'evidenced-by',
      fromKind: 'change-event',
      fromId: CHANGE_EVENT_ID,
      toKind: 'revision',
      toId: REVISION_2,
      provenanceEventName: 'contracts.changeEventRaised',
    },
    {
      kind: 'evidenced-by',
      fromKind: 'field-issue',
      fromId: CLAIM_ENTITY_ID,
      toKind: 'revision',
      toId: REVISION_2,
      provenanceEventName: 'contracts.claimReferenced',
    },
    {
      kind: 'impacts',
      fromKind: 'change-event',
      fromId: CHANGE_EVENT_ID,
      toKind: 'activity',
      toId: ACTIVITY_2,
      provenanceEventName: 'contracts.changeEventRaised',
    },
    {
      kind: 'impacts',
      fromKind: 'change-event',
      fromId: CHANGE_EVENT_ID,
      toKind: 'activity',
      toId: ACTIVITY_3,
      provenanceEventName: 'contracts.changeEventRaised',
    },
    {
      kind: 'impacts',
      fromKind: 'change-event',
      fromId: CHANGE_EVENT_ID,
      toKind: 'budget',
      toId: BUDGET_ID,
      provenanceEventName: 'contracts.changeEventRaised',
    },
    {
      kind: 'impacts',
      fromKind: 'change-event',
      fromId: CHANGE_EVENT_ID,
      toKind: 'cost-item',
      toId: COST_ITEM_ID,
      provenanceEventName: 'contracts.changeEventRaised',
    },
  ],
};

/** The golden causal chain of the evidenced-by edge: command -> superseded event -> change event. */
export const CHANGE_EVENT_EVIDENCE_CAUSAL_CHAIN_GOLDEN = [
  { kind: 'command', idempotencyKey: testKey(3) },
  { kind: 'event', eventName: 'documents.revisionSuperseded' },
  { kind: 'event', eventName: 'contracts.changeEventRaised' },
] as const;

/** The events returned for causal-chain assertions (in append order). */
export interface ChangeEventChainEvents {
  readonly revisionSuperseded: LedgerEvent;
  readonly changeEventRaised: LedgerEvent;
  readonly changeOrderSubmitted: LedgerEvent;
}

/**
 * Append the change-event causal-chain stream: document D with revisions
 * R1 -> R2, schedule S2 with activities A2/A3, budget B with cost item CI,
 * contract CT with obligation O, the change event CE (evidenced-by R2,
 * impacting B/CI/A2/A3, affecting O) raised AS A REACTION to the revision
 * supersession (causedByEvent), the change order CO derived from CE, and a
 * field-issue claim referenced against CO with evidence R2.
 */
export const buildChangeEventChainStream = async (
  source: InMemoryEventSource,
): Promise<ChangeEventChainEvents> => {
  const scope = projectScopeOf(projectOne);
  const documentAggregate: EntityRef = { entityKind: DOCUMENT_KIND, entityId: DOCUMENT_ID };
  const budgetAggregate: EntityRef = { entityKind: BUDGET_KIND, entityId: BUDGET_ID };
  const contractAggregate: EntityRef = { entityKind: CONTRACT_KIND, entityId: CONTRACT_ID };
  const scheduleAggregate: EntityRef = { entityKind: SCHEDULE_KIND, entityId: testId('sch', 2) };

  await appendCommandEvent(source, {
    command: commandOf(1, 'documents.registerDocument', scope),
    eventName: 'documents.documentRegistered',
    scope,
    occurredAt: T0,
    aggregate: documentAggregate,
    payload: {
      documentId: DOCUMENT_ID,
      projectId: projectOne,
      title: 'Wall closing drawing',
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
      documentId: DOCUMENT_ID,
      revisionId: REVISION_1,
      contentHash: 'sha256-4d1e0b7b2c',
      storageKey: 'documents/wall-closing/r1',
      byteSize: 2048,
      supersedes: null,
      attachedAt: T0,
      version: 2,
    },
  });
  const revisionSuperseded = await appendCommandEvent(source, {
    command: commandOf(3, 'documents.supersedeRevision', scope),
    eventName: 'documents.revisionSuperseded',
    scope,
    occurredAt: T1,
    aggregate: documentAggregate,
    payload: {
      documentId: DOCUMENT_ID,
      revisionId: REVISION_2,
      contentHash: 'sha256-9f8e7d6c5b',
      storageKey: 'documents/wall-closing/r2',
      byteSize: 2560,
      supersedes: REVISION_1,
      supersededAt: T1,
      version: 3,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(4, 'schedule.createSchedule', scope),
    eventName: 'schedule.scheduleCreated',
    scope,
    occurredAt: T1,
    aggregate: scheduleAggregate,
    payload: { scheduleId: testId('sch', 2), name: 'Tower fit-out', version: 1, createdAt: T1 },
  });
  for (const [index, activityId] of [ACTIVITY_2, ACTIVITY_3].entries()) {
    await appendCommandEvent(source, {
      command: commandOf(5 + index, 'schedule.addActivity', scope),
      eventName: 'schedule.activityAdded',
      scope,
      occurredAt: T1,
      aggregate: scheduleAggregate,
      payload: {
        scheduleId: testId('sch', 2),
        activityId,
        code: `A${index + 2}`,
        name: `Activity ${index + 2}`,
        plannedDuration: 4,
        parentActivityId: null,
        version: 2 + index,
      },
    });
  }
  await appendCommandEvent(source, {
    command: commandOf(7, 'cost.createBudget', scope),
    eventName: 'cost.budgetCreated',
    scope,
    occurredAt: T1,
    aggregate: budgetAggregate,
    payload: { budgetId: BUDGET_ID, name: 'Fit-out budget', currency: 'USD', version: 1, createdAt: T1 },
  });
  await appendCommandEvent(source, {
    command: commandOf(8, 'cost.recordCostItem', scope),
    eventName: 'cost.costItemRecorded',
    scope,
    occurredAt: T1,
    aggregate: budgetAggregate,
    payload: {
      budgetId: BUDGET_ID,
      costItemId: COST_ITEM_ID,
      code: '02-41-00',
      description: 'Metal stud framing',
      unit: 'm2',
      quantityMilli: 1200,
      unitRateMinor: 8500,
      amountMinor: 10200000,
      version: 2,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(9, 'contracts.createContract', scope),
    eventName: 'contracts.contractCreated',
    scope,
    occurredAt: T1,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: 1250000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T1,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(10, 'contracts.recordObligation', scope),
    eventName: 'contracts.obligationRecorded',
    scope,
    occurredAt: T2,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      obligationId: OBLIGATION_ID,
      code: '02-41-00',
      quantity: '1200',
      unit: 'm2',
      version: 2,
    },
  });
  const changeEventRaised = await appendReactionEvent(source, {
    causedBy: revisionSuperseded,
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
      affectedObligationIds: [OBLIGATION_ID],
      evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_2 }],
      costImpactLinks: [{ budgetId: BUDGET_ID, costItemId: COST_ITEM_ID }],
      scheduleImpactActivityIds: [ACTIVITY_2, ACTIVITY_3],
      version: 3,
    },
  });
  const changeOrderSubmitted = await appendCommandEvent(source, {
    command: commandOf(11, 'contracts.submitChangeOrder', scope),
    eventName: 'contracts.changeOrderSubmitted',
    scope,
    occurredAt: T3,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      changeOrderId: CHANGE_ORDER_ID,
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO-01 wall closing amendment',
      changeValue: { amount: 45000, currency: 'USD' },
      status: 'submitted',
      version: 4,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(12, 'contracts.referenceClaim', scope),
    eventName: 'contracts.claimReferenced',
    scope,
    occurredAt: T3,
    aggregate: contractAggregate,
    payload: {
      contractId: CONTRACT_ID,
      claimReferenceId: CLAIM_REFERENCE_ID,
      claimEntityKind: FIELD_ISSUE_KIND,
      claimEntityId: CLAIM_ENTITY_ID,
      changeOrderId: CHANGE_ORDER_ID,
      documentId: DOCUMENT_ID,
      revisionId: REVISION_2,
    },
  });
  return { revisionSuperseded, changeEventRaised, changeOrderSubmitted };
};

// ----- fixture 3: the field evidence chain -------------------------------------------

/** The golden traversal from the captured field event along evidenced-by edges. */
export const FIELD_EVIDENCE_CHAIN_GOLDEN: GoldenSubgraph = {
  nodes: [
    { entityKind: 'field-event', entityId: FIELD_EVENT_ID, depth: 0 },
    { entityKind: 'document', entityId: DOCUMENT_ID, depth: 1 },
  ],
  edges: [
    {
      kind: 'evidenced-by',
      fromKind: 'field-event',
      fromId: FIELD_EVENT_ID,
      toKind: 'document',
      toId: DOCUMENT_ID,
      provenanceEventName: 'field.fieldEventCaptured',
    },
  ],
};

/**
 * Append the field evidence-chain stream: a captured field event whose
 * evidence references the document D (pinned to revision R1).
 */
export const buildFieldEvidenceChainStream = async (
  source: InMemoryEventSource,
): Promise<void> => {
  const scope = projectScopeOf(projectOne);
  const fieldEventAggregate: EntityRef = { entityKind: FIELD_EVENT_KIND, entityId: FIELD_EVENT_ID };
  await appendCommandEvent(source, {
    command: commandOf(1, 'field.captureFieldEvent', scope),
    eventName: 'field.fieldEventCaptured',
    scope,
    occurredAt: T2,
    aggregate: fieldEventAggregate,
    payload: {
      fieldEventId: FIELD_EVENT_ID,
      category: 'observation',
      summary: 'Stud framing observed out of alignment',
      detail: 'Grid C-4 alignment deviation',
      location: 'Level 3 / Grid C-4',
      observedAt: T1,
      observedBy: testId('per', 1),
      quantity: null,
      evidence: [{ entityKind: DOCUMENT_KIND, entityId: DOCUMENT_ID, revisionId: REVISION_1 }],
      status: 'open',
      version: 1,
      createdAt: T2,
    },
  });
  // The evidence document itself: presence + revision chain.
  const documentAggregate: EntityRef = { entityKind: DOCUMENT_KIND, entityId: DOCUMENT_ID };
  await appendCommandEvent(source, {
    command: commandOf(2, 'documents.registerDocument', scope),
    eventName: 'documents.documentRegistered',
    scope,
    occurredAt: T0,
    aggregate: documentAggregate,
    payload: {
      documentId: DOCUMENT_ID,
      projectId: projectOne,
      title: 'Site observation photos',
      status: 'active',
      version: 1,
      createdAt: T0,
    },
  });
  await appendCommandEvent(source, {
    command: commandOf(3, 'documents.attachRevision', scope),
    eventName: 'documents.revisionAttached',
    scope,
    occurredAt: T0,
    aggregate: documentAggregate,
    payload: {
      documentId: DOCUMENT_ID,
      revisionId: REVISION_1,
      contentHash: 'sha256-1a2b3c4d5e',
      storageKey: 'documents/site-photos/r1',
      byteSize: 4096,
      supersedes: null,
      attachedAt: T0,
      version: 2,
    },
  });
};

/** Convenience entity refs used across the golden tests. */
export const activityRef = (id: EntityId): EntityRef => activity(id);
export const changeEventRef = (): EntityRef => ({
  entityKind: CHANGE_EVENT_KIND,
  entityId: CHANGE_EVENT_ID,
});
export const revisionRef = (id: EntityId): EntityRef => ({
  entityKind: REVISION_KIND,
  entityId: id,
});
export const budgetRef = (): EntityRef => ({ entityKind: BUDGET_KIND, entityId: BUDGET_ID });
export const fieldEventRef = (): EntityRef => ({
  entityKind: FIELD_EVENT_KIND,
  entityId: FIELD_EVENT_ID,
});
export const claimEntityRef = (): EntityRef => ({
  entityKind: FIELD_ISSUE_KIND,
  entityId: CLAIM_ENTITY_ID,
});
export const changeOrderRef = (): EntityRef => ({
  entityKind: CHANGE_ORDER_KIND,
  entityId: CHANGE_ORDER_ID,
});
export const costItemRef = (): EntityRef => ({ entityKind: COST_ITEM_KIND, entityId: COST_ITEM_ID });
