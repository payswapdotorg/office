// Office intelligence — the deterministic relationship projection (OFF-013).
//
// projectRelationships() folds a ledger event stream (the landed domain
// packages' events, read through the RelationshipEventSource port) into the
// relationship index. DETERMINISTIC BY CONSTRUCTION: events are consumed in
// ledger order, edge identity is (kind, from, to), the fold keeps the most
// recent asserting event's provenance per edge and honors explicit removals
// (schedule.dependencyRemoved), and every output collection is canonically
// sorted — no clock, no randomness, no environment. The same stream always
// projects to a byte-identical index; rebuilding from scratch is the same
// function (freeze A2/A7: derived, rebuildable, replaceable — never a
// second source of truth).
//
// Event-name recognition: exactly the landed vocabularies
// (vocabulary.ts RECOGNIZED_EVENT_NAMES). Unknown event names are SKIPPED
// deterministically — fail-open for future packages, tallied in the
// derivation metadata, never a crash and never a silent data invention.
// A RECOGNIZED event name with a malformed payload is a typed
// invariant-violation instead: the ledger's payloads were domain-validated
// at append time, so a malformed payload means corruption, and the
// projection fails closed rather than guessing.
//
// Derivation rules (ids and refs ONLY — the engine never copies entity
// data; every edge carries its producing event id as provenance):
// - documents.revisionAttached / revisionSuperseded:
//     (revision) derives-from (document) [and (prior revision)].
// - documents.evidenceReferenced:
//     (evidenced entity) evidenced-by (document revision).
// - field.fieldEventCaptured / fieldEventEvidenceAttached:
//     (field event) evidenced-by (each evidence link entity, as given).
// - schedule.activityAdded: parentActivityId -> (activity) derives-from
//     (parent activity).
// - schedule.dependencyAdded / dependencyRemoved:
//     (successor activity) depends-on (predecessor activity) [added /
//     removed].
// - schedule.milestoneAdded: boundActivityId -> (milestone) depends-on
//     (bound activity).
// - schedule.baselineSet: (baseline) derives-from (schedule) [and the
//     superseded baseline].
// - schedule.progressRecorded: (progress update) affects (activity).
// - cost.costItemRecorded: (cost item) derives-from (budget).
// - cost.budgetRevised: (budget revision) derives-from (budget) [and the
//     superseded revision].
// - cost.commitmentCreated: (commitment) affects (budget).
// - cost.commitmentAmended: (commitment amendment) derives-from
//     (commitment).
// - cost.invoiceRecorded: (invoice) affects (commitment).
// - cost.paymentReferenced: (payment reference) affects (invoice) and
//     affects (commitment).
// - contracts.changeEventRaised / changeEventLinked:
//     (change event) affects (obligations), evidenced-by (document
//     revisions), impacts (budgets, cost items, activities).
// - contracts.changeOrderSubmitted: (change order) derives-from (change
//     event).
// - contracts.claimReferenced: (claim entity) evidenced-by (document
//     revision) and derives-from (change order).
//
// KNOWN ENVELOPE GAP (reported with this branch): no landed field-package
// event carries activity references, so the acceptance example "a field
// issue affecting an activity" has no envelope source — the engine derives
// it from no data rather than inventing it (see README).
import { isEntityId, isEntityKind } from '@office/contracts';
import type {
  DomainEventEnvelope,
  EntityId,
  EntityKind,
  EntityRef,
  EventName,
  Scope,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import type {
  EntityNode,
  EventNameTally,
  Relationship,
  RelationshipIndex,
  RelationshipProvenance,
} from './model';
import { compareEntityNode, compareRelationship } from './model';
import {
  ACTIVITY_KIND,
  BASELINE_KIND,
  BUDGET_KIND,
  BUDGET_REVISION_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  COMMITMENT_AMENDMENT_KIND,
  COMMITMENT_KIND,
  COST_ITEM_KIND,
  DOCUMENT_KIND,
  FIELD_EVENT_KIND,
  INVOICE_KIND,
  MILESTONE_KIND,
  PAYMENT_REFERENCE_KIND,
  PROGRESS_UPDATE_KIND,
  REVISION_KIND,
  SCHEDULE_KIND,
  SCOPE_OBLIGATION_KIND,
  isRecognizedEventName,
} from './vocabulary';
import type { RelationshipKind } from './vocabulary';

// ---------------------------------------------------------------------------
// Fail-closed payload field readers (typed errors carry the event name and
// field path; payloads arrive as `unknown` exactly like the ledger rows).
// ---------------------------------------------------------------------------

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const payloadFailure = (
  envelope: DomainEventEnvelope,
  field: string,
  expected: string,
  received: unknown,
): DomainError =>
  domainError(
    'invariant-violation',
    `relationship projection cannot consume the payload of '${envelope.eventName}': field '${field}' is not ${expected}`,
    [
      {
        code: 'relationship-payload-valid',
        message: `expected ${expected} at '${field}', received ${JSON.stringify(received)}`,
        path: `${envelope.eventName}.${field}`,
      },
    ],
    { scope: envelope.scope, correlationId: envelope.causality.correlationId },
  );

const entityIdField = (
  envelope: DomainEventEnvelope,
  payload: Record<string, unknown>,
  field: string,
): Result<EntityId, DomainError> => {
  const raw = payload[field];
  if (!isEntityId(raw)) {
    return fail(payloadFailure(envelope, field, 'a canonical EntityId', raw));
  }
  return ok(raw);
};

const nullableEntityIdField = (
  envelope: DomainEventEnvelope,
  payload: Record<string, unknown>,
  field: string,
): Result<EntityId | null, DomainError> => {
  const raw = payload[field];
  if (raw === null) return ok(null);
  if (!isEntityId(raw)) {
    return fail(payloadFailure(envelope, field, 'a canonical EntityId or null', raw));
  }
  return ok(raw);
};

const entityIdArrayField = (
  envelope: DomainEventEnvelope,
  payload: Record<string, unknown>,
  field: string,
): Result<readonly EntityId[], DomainError> => {
  const raw = payload[field];
  if (!Array.isArray(raw)) {
    return fail(payloadFailure(envelope, field, 'an array of canonical EntityId values', raw));
  }
  const ids: EntityId[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isEntityId(entry)) {
      return fail(payloadFailure(envelope, `${field}[${index}]`, 'a canonical EntityId', entry));
    }
    ids.push(entry);
  }
  return ok(ids);
};

/** One evidence link of a contracts change-event payload (ids only). */
interface EvidenceLink {
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
}

/** One cost impact link of a contracts change-event payload (ids only). */
interface CostImpactLink {
  readonly budgetId: EntityId | null;
  readonly costItemId: EntityId | null;
}

const evidenceLinksField = (
  envelope: DomainEventEnvelope,
  payload: Record<string, unknown>,
  field: string,
): Result<readonly EvidenceLink[], DomainError> => {
  const raw = payload[field];
  if (!Array.isArray(raw)) {
    return fail(payloadFailure(envelope, field, 'an array of evidence links', raw));
  }
  const links: EvidenceLink[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(payloadFailure(envelope, `${field}[${index}]`, 'an evidence link object', entry));
    }
    const documentId = entityIdField(envelope, entry, 'documentId');
    if (!documentId.ok) return documentId;
    const revisionId = entityIdField(envelope, entry, 'revisionId');
    if (!revisionId.ok) return revisionId;
    links.push({ documentId: documentId.value, revisionId: revisionId.value });
  }
  return ok(links);
};

const costImpactLinksField = (
  envelope: DomainEventEnvelope,
  payload: Record<string, unknown>,
  field: string,
): Result<readonly CostImpactLink[], DomainError> => {
  const raw = payload[field];
  if (!Array.isArray(raw)) {
    return fail(payloadFailure(envelope, field, 'an array of cost impact links', raw));
  }
  const links: CostImpactLink[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(payloadFailure(envelope, `${field}[${index}]`, 'a cost impact link object', entry));
    }
    const budgetId = nullableEntityIdField(envelope, entry, 'budgetId');
    if (!budgetId.ok) return budgetId;
    const costItemId = nullableEntityIdField(envelope, entry, 'costItemId');
    if (!costItemId.ok) return costItemId;
    links.push({ budgetId: budgetId.value, costItemId: costItemId.value });
  }
  return ok(links);
};

/** One evidence reference of a field-domain payload (entity + pinned revision). */
interface FieldEvidenceReference {
  readonly entityKind: EntityKind;
  readonly entityId: EntityId;
  readonly revisionId: EntityId;
}

const fieldEvidenceReferencesField = (
  envelope: DomainEventEnvelope,
  payload: Record<string, unknown>,
  field: string,
): Result<readonly FieldEvidenceReference[], DomainError> => {
  const raw = payload[field];
  if (!Array.isArray(raw)) {
    return fail(payloadFailure(envelope, field, 'an array of evidence references', raw));
  }
  const references: FieldEvidenceReference[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(payloadFailure(envelope, `${field}[${index}]`, 'an evidence reference object', entry));
    }
    const entityKind = entry['entityKind'];
    if (!isEntityKind(entityKind)) {
      return fail(payloadFailure(envelope, `${field}[${index}].entityKind`, 'a canonical EntityKind', entityKind));
    }
    const entityId = entityIdField(envelope, entry, 'entityId');
    if (!entityId.ok) return entityId;
    const revisionId = entityIdField(envelope, entry, 'revisionId');
    if (!revisionId.ok) return revisionId;
    references.push({ entityKind, entityId: entityId.value, revisionId: revisionId.value });
  }
  return ok(references);
};

const entityKindField = (
  envelope: DomainEventEnvelope,
  payload: Record<string, unknown>,
  field: string,
): Result<EntityKind, DomainError> => {
  const raw = payload[field];
  if (!isEntityKind(raw)) {
    return fail(payloadFailure(envelope, field, 'a canonical EntityKind', raw));
  }
  return ok(raw);
};

// ---------------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------------

const entityKey = (entity: EntityRef): string => `${entity.entityKind}|${entity.entityId}`;

const edgeKey = (kind: RelationshipKind, from: EntityRef, to: EntityRef): string =>
  `${kind}\u0000${entityKey(from)}\u0000${entityKey(to)}`;

interface FoldState {
  readonly edges: Map<string, Relationship>;
  readonly nodes: Map<string, EntityNode>;
  readonly recognized: Map<string, number>;
  readonly skipped: Map<string, number>;
  projectedEventCount: number;
}

const touchNode = (state: FoldState, entity: EntityRef, scope: Scope): void => {
  state.nodes.set(entityKey(entity), { entity, scope });
};

const provenanceOf = (event: LedgerEvent): RelationshipProvenance => ({
  eventId: event.eventId,
  eventName: event.envelope.eventName,
  aggregate: event.aggregate,
  sequence: event.sequence,
  correlationId: event.envelope.causality.correlationId,
  causationId: event.envelope.causality.causationId,
  occurredAt: event.envelope.occurredAt,
  actor: event.envelope.actor,
});

const assertEdge = (
  state: FoldState,
  event: LedgerEvent,
  kind: RelationshipKind,
  from: EntityRef,
  to: EntityRef,
): void => {
  state.edges.set(edgeKey(kind, from, to), {
    kind,
    from,
    to,
    scope: event.envelope.scope,
    provenance: provenanceOf(event),
  });
  touchNode(state, from, event.envelope.scope);
  touchNode(state, to, event.envelope.scope);
};

const ref = (entityKind: EntityKind, entityId: EntityId): EntityRef => ({
  entityKind,
  entityId,
});

/**
 * Apply ONE recognized event to the fold. Returns a typed failure when a
 * consumed payload field is malformed (fail-closed); unknown event names
 * are tallied as skipped by the caller.
 */
const applyEvent = (state: FoldState, event: LedgerEvent): Result<true, DomainError> => {
  const envelope = event.envelope;
  const payload = envelope.payload;
  const name = envelope.eventName as string;
  const asRecord = isRecord(payload) ? payload : {};
  const scope = envelope.scope;

  // The aggregate of every recognized event is a tracked entity node.
  touchNode(state, event.aggregate, scope);

  switch (name) {
    case 'documents.revisionAttached': {
      const documentId = entityIdField(envelope, asRecord, 'documentId');
      if (!documentId.ok) return documentId;
      const revisionId = entityIdField(envelope, asRecord, 'revisionId');
      if (!revisionId.ok) return revisionId;
      assertEdge(state, event, 'derives-from', ref(REVISION_KIND, revisionId.value), ref(DOCUMENT_KIND, documentId.value));
      return ok(true);
    }
    case 'documents.revisionSuperseded': {
      const documentId = entityIdField(envelope, asRecord, 'documentId');
      if (!documentId.ok) return documentId;
      const revisionId = entityIdField(envelope, asRecord, 'revisionId');
      if (!revisionId.ok) return revisionId;
      const supersedes = entityIdField(envelope, asRecord, 'supersedes');
      if (!supersedes.ok) return supersedes;
      assertEdge(state, event, 'derives-from', ref(REVISION_KIND, revisionId.value), ref(DOCUMENT_KIND, documentId.value));
      assertEdge(state, event, 'derives-from', ref(REVISION_KIND, revisionId.value), ref(REVISION_KIND, supersedes.value));
      return ok(true);
    }
    case 'documents.evidenceReferenced': {
      const revisionId = entityIdField(envelope, asRecord, 'revisionId');
      if (!revisionId.ok) return revisionId;
      const documentId = entityIdField(envelope, asRecord, 'documentId');
      if (!documentId.ok) return documentId;
      const evidencedEntityKind = entityKindField(envelope, asRecord, 'evidencedEntityKind');
      if (!evidencedEntityKind.ok) return evidencedEntityKind;
      const evidencedEntityId = entityIdField(envelope, asRecord, 'evidencedEntityId');
      if (!evidencedEntityId.ok) return evidencedEntityId;
      assertEdge(
        state,
        event,
        'evidenced-by',
        ref(evidencedEntityKind.value, evidencedEntityId.value),
        ref(REVISION_KIND, revisionId.value),
      );
      touchNode(state, ref(DOCUMENT_KIND, documentId.value), scope);
      return ok(true);
    }
    case 'field.fieldEventCaptured':
    case 'field.fieldEventEvidenceAttached': {
      const fieldEventId = entityIdField(envelope, asRecord, 'fieldEventId');
      if (!fieldEventId.ok) return fieldEventId;
      const field = name === 'field.fieldEventCaptured' ? 'evidence' : 'attached';
      const evidence = fieldEvidenceReferencesField(envelope, asRecord, field);
      if (!evidence.ok) return evidence;
      for (const link of evidence.value) {
        assertEdge(
          state,
          event,
          'evidenced-by',
          ref(FIELD_EVENT_KIND, fieldEventId.value),
          ref(link.entityKind, link.entityId),
        );
      }
      return ok(true);
    }
    case 'schedule.activityAdded': {
      const activityId = entityIdField(envelope, asRecord, 'activityId');
      if (!activityId.ok) return activityId;
      const parentActivityId = nullableEntityIdField(envelope, asRecord, 'parentActivityId');
      if (!parentActivityId.ok) return parentActivityId;
      if (parentActivityId.value !== null) {
        assertEdge(
          state,
          event,
          'derives-from',
          ref(ACTIVITY_KIND, activityId.value),
          ref(ACTIVITY_KIND, parentActivityId.value),
        );
      }
      return ok(true);
    }
    case 'schedule.dependencyAdded': {
      const predecessorId = entityIdField(envelope, asRecord, 'predecessorId');
      if (!predecessorId.ok) return predecessorId;
      const successorId = entityIdField(envelope, asRecord, 'successorId');
      if (!successorId.ok) return successorId;
      assertEdge(
        state,
        event,
        'depends-on',
        ref(ACTIVITY_KIND, successorId.value),
        ref(ACTIVITY_KIND, predecessorId.value),
      );
      return ok(true);
    }
    case 'schedule.dependencyRemoved': {
      const predecessorId = entityIdField(envelope, asRecord, 'predecessorId');
      if (!predecessorId.ok) return predecessorId;
      const successorId = entityIdField(envelope, asRecord, 'successorId');
      if (!successorId.ok) return successorId;
      state.edges.delete(
        edgeKey('depends-on', ref(ACTIVITY_KIND, successorId.value), ref(ACTIVITY_KIND, predecessorId.value)),
      );
      return ok(true);
    }
    case 'schedule.milestoneAdded': {
      const milestoneId = entityIdField(envelope, asRecord, 'milestoneId');
      if (!milestoneId.ok) return milestoneId;
      const boundActivityId = nullableEntityIdField(envelope, asRecord, 'boundActivityId');
      if (!boundActivityId.ok) return boundActivityId;
      if (boundActivityId.value !== null) {
        assertEdge(
          state,
          event,
          'depends-on',
          ref(MILESTONE_KIND, milestoneId.value),
          ref(ACTIVITY_KIND, boundActivityId.value),
        );
      }
      return ok(true);
    }
    case 'schedule.baselineSet': {
      const scheduleId = entityIdField(envelope, asRecord, 'scheduleId');
      if (!scheduleId.ok) return scheduleId;
      const baselineId = entityIdField(envelope, asRecord, 'baselineId');
      if (!baselineId.ok) return baselineId;
      const supersedes = nullableEntityIdField(envelope, asRecord, 'supersedes');
      if (!supersedes.ok) return supersedes;
      assertEdge(state, event, 'derives-from', ref(BASELINE_KIND, baselineId.value), ref(SCHEDULE_KIND, scheduleId.value));
      if (supersedes.value !== null) {
        assertEdge(
          state,
          event,
          'derives-from',
          ref(BASELINE_KIND, baselineId.value),
          ref(BASELINE_KIND, supersedes.value),
        );
      }
      return ok(true);
    }
    case 'schedule.progressRecorded': {
      const progressUpdateId = entityIdField(envelope, asRecord, 'progressUpdateId');
      if (!progressUpdateId.ok) return progressUpdateId;
      const activityId = entityIdField(envelope, asRecord, 'activityId');
      if (!activityId.ok) return activityId;
      assertEdge(
        state,
        event,
        'affects',
        ref(PROGRESS_UPDATE_KIND, progressUpdateId.value),
        ref(ACTIVITY_KIND, activityId.value),
      );
      return ok(true);
    }
    case 'cost.costItemRecorded': {
      const budgetId = entityIdField(envelope, asRecord, 'budgetId');
      if (!budgetId.ok) return budgetId;
      const costItemId = entityIdField(envelope, asRecord, 'costItemId');
      if (!costItemId.ok) return costItemId;
      assertEdge(state, event, 'derives-from', ref(COST_ITEM_KIND, costItemId.value), ref(BUDGET_KIND, budgetId.value));
      return ok(true);
    }
    case 'cost.budgetRevised': {
      const budgetId = entityIdField(envelope, asRecord, 'budgetId');
      if (!budgetId.ok) return budgetId;
      const revisionId = entityIdField(envelope, asRecord, 'revisionId');
      if (!revisionId.ok) return revisionId;
      const supersedes = nullableEntityIdField(envelope, asRecord, 'supersedes');
      if (!supersedes.ok) return supersedes;
      assertEdge(
        state,
        event,
        'derives-from',
        ref(BUDGET_REVISION_KIND, revisionId.value),
        ref(BUDGET_KIND, budgetId.value),
      );
      if (supersedes.value !== null) {
        assertEdge(
          state,
          event,
          'derives-from',
          ref(BUDGET_REVISION_KIND, revisionId.value),
          ref(BUDGET_REVISION_KIND, supersedes.value),
        );
      }
      return ok(true);
    }
    case 'cost.commitmentCreated': {
      const commitmentId = entityIdField(envelope, asRecord, 'commitmentId');
      if (!commitmentId.ok) return commitmentId;
      const budgetId = entityIdField(envelope, asRecord, 'budgetId');
      if (!budgetId.ok) return budgetId;
      assertEdge(state, event, 'affects', ref(COMMITMENT_KIND, commitmentId.value), ref(BUDGET_KIND, budgetId.value));
      return ok(true);
    }
    case 'cost.commitmentAmended': {
      const commitmentId = entityIdField(envelope, asRecord, 'commitmentId');
      if (!commitmentId.ok) return commitmentId;
      const amendmentId = entityIdField(envelope, asRecord, 'amendmentId');
      if (!amendmentId.ok) return amendmentId;
      assertEdge(
        state,
        event,
        'derives-from',
        ref(COMMITMENT_AMENDMENT_KIND, amendmentId.value),
        ref(COMMITMENT_KIND, commitmentId.value),
      );
      return ok(true);
    }
    case 'cost.invoiceRecorded': {
      const invoiceId = entityIdField(envelope, asRecord, 'invoiceId');
      if (!invoiceId.ok) return invoiceId;
      const commitmentId = entityIdField(envelope, asRecord, 'commitmentId');
      if (!commitmentId.ok) return commitmentId;
      assertEdge(state, event, 'affects', ref(INVOICE_KIND, invoiceId.value), ref(COMMITMENT_KIND, commitmentId.value));
      return ok(true);
    }
    case 'cost.paymentReferenced': {
      const invoiceId = entityIdField(envelope, asRecord, 'invoiceId');
      if (!invoiceId.ok) return invoiceId;
      const commitmentId = entityIdField(envelope, asRecord, 'commitmentId');
      if (!commitmentId.ok) return commitmentId;
      const paymentReferenceId = entityIdField(envelope, asRecord, 'paymentReferenceId');
      if (!paymentReferenceId.ok) return paymentReferenceId;
      assertEdge(
        state,
        event,
        'affects',
        ref(PAYMENT_REFERENCE_KIND, paymentReferenceId.value),
        ref(INVOICE_KIND, invoiceId.value),
      );
      assertEdge(
        state,
        event,
        'affects',
        ref(PAYMENT_REFERENCE_KIND, paymentReferenceId.value),
        ref(COMMITMENT_KIND, commitmentId.value),
      );
      return ok(true);
    }
    case 'contracts.changeEventRaised':
    case 'contracts.changeEventLinked': {
      const changeEventId = entityIdField(envelope, asRecord, 'changeEventId');
      if (!changeEventId.ok) return changeEventId;
      const raised = name === 'contracts.changeEventRaised';
      const obligations = entityIdArrayField(
        envelope,
        asRecord,
        raised ? 'affectedObligationIds' : 'addedObligationIds',
      );
      if (!obligations.ok) return obligations;
      const evidence = evidenceLinksField(
        envelope,
        asRecord,
        raised ? 'evidenceLinks' : 'addedEvidenceLinks',
      );
      if (!evidence.ok) return evidence;
      const costImpacts = costImpactLinksField(
        envelope,
        asRecord,
        raised ? 'costImpactLinks' : 'addedCostImpactLinks',
      );
      if (!costImpacts.ok) return costImpacts;
      const activities = entityIdArrayField(
        envelope,
        asRecord,
        raised ? 'scheduleImpactActivityIds' : 'addedActivityIds',
      );
      if (!activities.ok) return activities;
      const changeEvent = ref(CHANGE_EVENT_KIND, changeEventId.value);
      for (const obligationId of obligations.value) {
        assertEdge(state, event, 'affects', changeEvent, ref(SCOPE_OBLIGATION_KIND, obligationId));
      }
      for (const link of evidence.value) {
        assertEdge(state, event, 'evidenced-by', changeEvent, ref(REVISION_KIND, link.revisionId));
        touchNode(state, ref(DOCUMENT_KIND, link.documentId), scope);
      }
      for (const link of costImpacts.value) {
        if (link.budgetId !== null) {
          assertEdge(state, event, 'impacts', changeEvent, ref(BUDGET_KIND, link.budgetId));
        }
        if (link.costItemId !== null) {
          assertEdge(state, event, 'impacts', changeEvent, ref(COST_ITEM_KIND, link.costItemId));
        }
      }
      for (const activityId of activities.value) {
        assertEdge(state, event, 'impacts', changeEvent, ref(ACTIVITY_KIND, activityId));
      }
      return ok(true);
    }
    case 'contracts.changeOrderSubmitted': {
      const changeOrderId = entityIdField(envelope, asRecord, 'changeOrderId');
      if (!changeOrderId.ok) return changeOrderId;
      const changeEventId = entityIdField(envelope, asRecord, 'changeEventId');
      if (!changeEventId.ok) return changeEventId;
      assertEdge(
        state,
        event,
        'derives-from',
        ref(CHANGE_ORDER_KIND, changeOrderId.value),
        ref(CHANGE_EVENT_KIND, changeEventId.value),
      );
      return ok(true);
    }
    case 'contracts.claimReferenced': {
      const claimEntityKind = entityKindField(envelope, asRecord, 'claimEntityKind');
      if (!claimEntityKind.ok) return claimEntityKind;
      const claimEntityId = entityIdField(envelope, asRecord, 'claimEntityId');
      if (!claimEntityId.ok) return claimEntityId;
      const changeOrderId = entityIdField(envelope, asRecord, 'changeOrderId');
      if (!changeOrderId.ok) return changeOrderId;
      const documentId = entityIdField(envelope, asRecord, 'documentId');
      if (!documentId.ok) return documentId;
      const revisionId = entityIdField(envelope, asRecord, 'revisionId');
      if (!revisionId.ok) return revisionId;
      const claim = ref(claimEntityKind.value, claimEntityId.value);
      assertEdge(state, event, 'evidenced-by', claim, ref(REVISION_KIND, revisionId.value));
      assertEdge(state, event, 'derives-from', claim, ref(CHANGE_ORDER_KIND, changeOrderId.value));
      touchNode(state, ref(DOCUMENT_KIND, documentId.value), scope);
      return ok(true);
    }
    default:
      // Recognized lifecycle/audit events with no cross-entity links in
      // their payloads: the aggregate node above is the whole effect.
      return ok(true);
  }
};

const talliesOf = (counts: Map<string, number>): readonly EventNameTally[] =>
  [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([eventName, count]) => ({ eventName: eventName as EventName, count }));

/**
 * Project a ledger event stream into the relationship index — THE
 * deterministic, rebuildable projection (A7). Consuming the same stream
 * twice yields identical indexes; rebuilding from scratch is this same
 * function. Fails closed (typed invariant-violation) on a recognized event
 * name with a malformed payload; skips unknown event names deterministically.
 */
export function projectRelationships(
  events: readonly LedgerEvent[],
): Result<RelationshipIndex, DomainError> {
  const state: FoldState = {
    edges: new Map(),
    nodes: new Map(),
    recognized: new Map(),
    skipped: new Map(),
    projectedEventCount: 0,
  };

  for (const event of events) {
    state.projectedEventCount += 1;
    const name = event.envelope.eventName as string;
    if (!isRecognizedEventName(event.envelope.eventName)) {
      state.skipped.set(name, (state.skipped.get(name) ?? 0) + 1);
      continue;
    }
    state.recognized.set(name, (state.recognized.get(name) ?? 0) + 1);
    const applied = applyEvent(state, event);
    if (!applied.ok) return applied;
  }

  const relationships = [...state.edges.values()].sort(compareRelationship);
  const entities = [...state.nodes.values()].sort(compareEntityNode);

  const adjacency = new Map<string, Relationship[]>();
  for (const relationship of relationships) {
    for (const endpoint of [relationship.from, relationship.to]) {
      const key = entityKey(endpoint);
      const list = adjacency.get(key);
      if (list === undefined) {
        adjacency.set(key, [relationship]);
      } else {
        list.push(relationship);
      }
    }
  }

  const index: RelationshipIndex = {
    relationships,
    entities,
    derivation: {
      projectedEventCount: state.projectedEventCount,
      entityCount: entities.length,
      relationshipCount: relationships.length,
      recognizedEventNames: talliesOf(state.recognized),
      skippedEventNames: talliesOf(state.skipped),
    },
    relationshipsOf: (entity: EntityRef) => adjacency.get(entityKey(entity)) ?? [],
    entityNodeOf: (entity: EntityRef) => state.nodes.get(entityKey(entity)) ?? null,
  };
  return ok(index);
}
