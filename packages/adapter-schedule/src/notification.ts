// Office adapter-schedule — THE downstream impact-notification flow (OFF-023).
//
// The flow this package exists to demonstrate:
//
//   provider activity update (dates/duration changed)
//     → canonical command proposal (change-mapping.ts)
//     → (executed by the host) canonical `schedule.activityUpdated`
//       DomainEventEnvelope
//     → THE relationship projection below derives the expected affected
//       edges — the structural schedule network ((activity) derives-from
//       (its schedule), (activity) derives-from (its parent activity),
//       (successor activity) depends-on (predecessor activity),
//       (baseline) derives-from (its schedule)) and, at every
//       activity-update event, the IMPACT edges:
//       (updated activity) affects (each impacted successor activity) and
//       (updated activity) affects (the schedule's baseline)
//     → the notification records below — one per impacted entity — each
//       referencing the SOURCE EVENT ID (full traceability: the event id,
//       the event's causation id — the executed command's idempotency key,
//       which is the SourceRef-derived sync key of the exact provider object
//       version — and the correlation id of the provider object's whole
//       lifecycle chain).
//
// The edge vocabulary is THE canonical relationship vocabulary of
// @office/intelligence-relationships (OFF-013), consumed AS TYPES ONLY (the
// frozen OFF-023 boundary: no logic imports): ScheduleRelationshipEdge
// extends the canonical Relationship shape (kind/from/to/scope), the tracked
// nodes ARE the canonical EntityNode shape, and the derivation metadata
// mirrors the canonical EventNameTally shape. The ledger-branded provenance
// of the full Relationship type is intentionally replaced by this package's
// own ScheduleEventReference — the OFF-005 ledger assigns ledger event ids
// at append time, which this package cannot reach (and must not: adapters
// never touch the ledger); the adapter-side reference derived here is the
// deterministic digest of the exact envelope, plus its full causality.
//
// Deterministic by construction: a pure fold over the event stream in given
// order, edge identity (kind, from, to), the most recent asserting event's
// reference per edge, canonical orderings everywhere, and sha256-derived ids
// over canonical serializations. No clock, no randomness, no I/O.
import { createHash } from 'node:crypto';
import type { Actor, CausationId, CorrelationId, DomainEventEnvelope, EntityRef, EventName, TenantId, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type {
  EntityNode,
  EventNameTally,
  Relationship,
  RelationshipKind,
} from '@office/intelligence-relationships';
import {
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_CANONICAL_KIND,
  ACTIVITY_UPDATED_EVENT,
  BASELINE_CANONICAL_KIND,
  BASELINE_SET_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  SCHEDULE_CANONICAL_KIND,
} from './vocabulary';
import {
  parseActivityUpdatedPayload,
  parseScheduleEventPayload,
} from './change-mapping';
import type {
  ActivityAddedPayload,
  ActivityUpdatedPayload,
  BaselineSetPayload,
  DependencyAddedPayload,
  DependencyRemovedPayload,
} from './change-mapping';
import { compareEntityRef } from './references';

// ---------------------------------------------------------------------------
// The adapter-side canonical event reference (the source event id).
// ---------------------------------------------------------------------------

declare const scheduleEventIdBrand: unique symbol;

/**
 * The deterministic id of one canonical schedules-area event: a sha256
 * digest over the canonical serialization of the envelope (fixed field
 * order, the payload serialized as constructed). The OFF-005 ledger assigns
 * its own ledger event ids at append time — this package never touches the
 * ledger; the ScheduleEventId is the adapter-side stable reference the
 * notification records cite for full traceability (same derivation
 * discipline as the SDK's sync idempotency keys).
 */
export type ScheduleEventId = string & {
  readonly [scheduleEventIdBrand]: 'ScheduleEventId';
};

/** Grammar description used in parse failures. */
export const SCHEDULE_EVENT_ID_GRAMMAR =
  'office-schev-v1-<opaque: 16..64 lowercase alphanumeric> (deterministic sha256 derivation over the canonical event envelope serialization)';

const SCHEDULE_EVENT_ID_PREFIX = 'office-schev-v1-';
const DERIVED_OPAQUE_LENGTH = 32;
const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;

/** Parse an untrusted value as a ScheduleEventId (total, fail-closed). */
export function parseScheduleEventId(raw: unknown): Result<ScheduleEventId, DomainError> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(SCHEDULE_EVENT_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(raw.slice(SCHEDULE_EVENT_ID_PREFIX.length))
  ) {
    return fail(
      domainError(
        'invariant-violation',
        `not a valid schedule event id: ${String(raw)}`,
        [
          {
            code: 'schedule-event-id-invalid',
            message: String(raw),
            path: null,
          },
        ],
      ),
    );
  }
  return ok(raw as ScheduleEventId);
}

/** Type guard for structurally valid ScheduleEventId values. */
export function isScheduleEventId(raw: unknown): raw is ScheduleEventId {
  return parseScheduleEventId(raw).ok;
}

/** The scope serialization used by the digest material (canonical, local). */
const scopeMaterial = (scope: DomainEventEnvelope['scope']): string =>
  scope.kind === 'project'
    ? JSON.stringify(['project', scope.tenantId, scope.projectId])
    : JSON.stringify(['tenant', scope.tenantId]);

/** The actor serialization used by the digest material (canonical, local). */
const actorMaterial = (actor: Actor): string =>
  actor.kind === 'system' ? JSON.stringify(['system']) : JSON.stringify([actor.kind, actor.actorId]);

/** The entity-ref serialization used by the digest material (canonical, local). */
const refMaterial = (ref: EntityRef | null): string =>
  ref === null ? JSON.stringify(null) : JSON.stringify([ref.entityKind, ref.entityId]);

/**
 * Derive the ScheduleEventId of one canonical schedules-area event envelope
 * (deterministic, pure): `office-schev-v1-<sha256 prefix>` over the
 * envelope's canonical serialization — event name, scope, actor, source,
 * causal chain, schema version, occurred-at, before/after entity refs, and
 * the payload as constructed (the trusted envelope builders emit fixed key
 * order).
 */
export function scheduleEventIdOf(envelope: DomainEventEnvelope): ScheduleEventId {
  const material = JSON.stringify([
    'office-schedule-event-reference',
    envelope.eventName,
    scopeMaterial(envelope.scope),
    actorMaterial(envelope.actor),
    envelope.source,
    envelope.causality.correlationId,
    envelope.causality.causationId,
    envelope.schemaVersion,
    envelope.occurredAt,
    refMaterial(envelope.entityRefs.before),
    refMaterial(envelope.entityRefs.after),
    JSON.stringify(envelope.payload),
  ]);
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  const candidate = `${SCHEDULE_EVENT_ID_PREFIX}${digest.slice(0, DERIVED_OPAQUE_LENGTH)}`;
  const parsed = parseScheduleEventId(candidate);
  if (!parsed.ok) {
    // Pure derivation over validated inputs — a violation is a module defect.
    throw new TypeError(`derived schedule event id is not valid: ${candidate}`);
  }
  return parsed.value;
}

/** The full traceability reference to the source event of a notification. */
export interface ScheduleEventReference {
  /** The deterministic id of the exact canonical event envelope. */
  readonly eventId: ScheduleEventId;
  /** The event's name (e.g. 'schedule.activityUpdated'). */
  readonly eventName: EventName;
  /** When the event occurred (the host execution's injected clock). */
  readonly occurredAt: Timestamp;
  /**
   * The event's causal chain: the correlation id ties the provider object's
   * whole lifecycle together; the causation id is the executed command's
   * idempotency key — for adapter-proposed commands the SourceRef-derived
   * sync key of the exact provider object version.
   */
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
  /** The actor that executed the command (the adapter actor). */
  readonly actor: Actor;
}

/** Compose the ScheduleEventReference of one envelope (deterministic, pure). */
export function scheduleEventReferenceOf(envelope: DomainEventEnvelope): ScheduleEventReference {
  return {
    eventId: scheduleEventIdOf(envelope),
    eventName: envelope.eventName,
    occurredAt: envelope.occurredAt,
    correlationId: envelope.causality.correlationId,
    causationId: envelope.causality.causationId,
    actor: envelope.actor,
  };
}

// ---------------------------------------------------------------------------
// The schedule relationship projection (the edge derivation).
// ---------------------------------------------------------------------------

/**
 * One typed directed edge between canonical entities — structurally THE
 * canonical Relationship shape (kind/from/to/scope from
 * @office/intelligence-relationships, consumed as types only), with the
 * ledger-branded provenance replaced by this package's own source-event
 * reference (the adapter side of the provenance seam).
 */
export interface ScheduleRelationshipEdge extends Pick<Relationship, 'kind' | 'from' | 'to' | 'scope'> {
  /** The derivation provenance: the event that asserted this edge. */
  readonly sourceEvent: ScheduleEventReference;
}

/**
 * How the schedule relationship projection was derived — its own audit trail
 * (mirroring the canonical DerivationMetadata shape as far as the
 * types-only boundary allows).
 */
export interface ScheduleDerivationMetadata {
  /** Total events the projection consumed. */
  readonly projectedEventCount: number;
  /** How many distinct entities the index tracks. */
  readonly entityCount: number;
  /** How many relationship edges the index carries. */
  readonly relationshipCount: number;
  /** Recognized schedules-area event names with their counts (canonical order). */
  readonly recognizedEventNames: readonly EventNameTally[];
  /** Non-schedules event names skipped deterministically, with counts (canonical order). */
  readonly skippedEventNames: readonly EventNameTally[];
}

/** The schedule relationship index — a derived, rebuildable projection. */
export interface ScheduleRelationshipIndex {
  /** Every relationship edge, in canonical order. */
  readonly relationships: readonly ScheduleRelationshipEdge[];
  /** Every tracked entity node, in canonical order. */
  readonly entities: readonly EntityNode[];
  /** The projection's derivation metadata. */
  readonly derivation: ScheduleDerivationMetadata;
  /** All relationships incident to one entity (both directions), in canonical order. */
  relationshipsOf(entity: EntityRef): readonly ScheduleRelationshipEdge[];
}

/** Canonical relationship order: kind, from, to, producing event id. */
export function compareScheduleRelationshipEdge(
  left: ScheduleRelationshipEdge,
  right: ScheduleRelationshipEdge,
): number {
  if (left.kind !== right.kind) {
    return left.kind < right.kind ? -1 : 1;
  }
  const from = compareEntityRef(left.from, right.from);
  if (from !== 0) return from;
  const to = compareEntityRef(left.to, right.to);
  if (to !== 0) return to;
  if (left.sourceEvent.eventId !== right.sourceEvent.eventId) {
    return left.sourceEvent.eventId < right.sourceEvent.eventId ? -1 : 1;
  }
  return 0;
}

/** Canonical entity-node order: entity kind, then id. */
export function compareScheduleEntityNode(left: EntityNode, right: EntityNode): number {
  return compareEntityRef(left.entity, right.entity);
}

const edgeKeyOf = (edge: ScheduleRelationshipEdge): string =>
  JSON.stringify([edge.kind, edge.from.entityKind, edge.from.entityId, edge.to.entityKind, edge.to.entityId]);

const nodeKeyOf = (entity: EntityRef): string => JSON.stringify([entity.entityKind, entity.entityId]);

/** Compose one asserted edge (local helper). */
const edgeOf = (
  kind: RelationshipKind,
  from: EntityRef,
  to: EntityRef,
  scope: DomainEventEnvelope['scope'],
  sourceEvent: ScheduleEventReference,
): ScheduleRelationshipEdge => ({ kind, from, to, scope, sourceEvent });

/** The mutable fold state (local). */
interface FoldState {
  readonly edges: Map<string, ScheduleRelationshipEdge>;
  readonly nodes: Map<string, EntityNode>;
  readonly recognized: Map<string, number>;
  readonly skipped: Map<string, number>;
}

/**
 * Derive the STRUCTURAL relationship edges ONE canonical schedules-area
 * event asserts (deterministic, pure — the derivation grammar of the
 * projection's persistent network):
 *
 *   `schedule.activityAdded`
 *     → (activity) derives-from (its schedule) AND, when it has one,
 *       (activity) derives-from (its parent activity);
 *   `schedule.dependencyAdded`
 *     → (successor activity) depends-on (predecessor activity);
 *   `schedule.baselineSet`
 *     → (baseline) derives-from (its schedule);
 *   `schedule.dependencyRemoved` asserts no edge (the fold removes the
 *     asserted depends-on edge instead);
 *   `schedule.activityUpdated` / `schedule.scheduleCreated` assert no
 *     PERSISTENT edge — the activity-update event's IMPACT edges are derived
 *     by the fold with graph context (see projectScheduleRelationships).
 */
export function edgesOfScheduleEvent(
  event: DomainEventEnvelope,
): Result<readonly ScheduleRelationshipEdge[], DomainError> {
  const payload = parseScheduleEventPayload(event.eventName, event.payload);
  if (payload === null) {
    return fail(notAScheduleEventError(event));
  }
  if (!payload.ok) {
    return fail(payloadError(event, payload.error));
  }
  const reference = scheduleEventReferenceOf(event);
  const edges: ScheduleRelationshipEdge[] = [];
  if (event.eventName === ACTIVITY_ADDED_EVENT) {
    const added = payload.value as ActivityAddedPayload;
    const activity = { entityKind: ACTIVITY_CANONICAL_KIND, entityId: added.activityId };
    const schedule = { entityKind: SCHEDULE_CANONICAL_KIND, entityId: added.scheduleId };
    edges.push(edgeOf('derives-from', activity, schedule, event.scope, reference));
    if (added.parentActivityId !== null) {
      edges.push(
        edgeOf(
          'derives-from',
          activity,
          { entityKind: ACTIVITY_CANONICAL_KIND, entityId: added.parentActivityId },
          event.scope,
          reference,
        ),
      );
    }
  }
  if (event.eventName === DEPENDENCY_ADDED_EVENT) {
    const dependency = payload.value as DependencyAddedPayload;
    edges.push(
      edgeOf(
        'depends-on',
        { entityKind: ACTIVITY_CANONICAL_KIND, entityId: dependency.successorId },
        { entityKind: ACTIVITY_CANONICAL_KIND, entityId: dependency.predecessorId },
        event.scope,
        reference,
      ),
    );
  }
  if (event.eventName === BASELINE_SET_EVENT) {
    const baseline = payload.value as BaselineSetPayload;
    edges.push(
      edgeOf(
        'derives-from',
        { entityKind: BASELINE_CANONICAL_KIND, entityId: baseline.baselineId },
        { entityKind: SCHEDULE_CANONICAL_KIND, entityId: baseline.scheduleId },
        event.scope,
        reference,
      ),
    );
  }
  return ok(edges);
}

/**
 * THE impact derivation: the entities one updated activity affects — every
 * IMPACTED SUCCESSOR activity (each activity that depends-on the updated
 * activity) plus THE SCHEDULE'S BASELINE (each baseline registered over the
 * updated activity's schedule), in canonical entity order. This single pure
 * derivation is used by BOTH the relationship fold (which records the
 * impact edges at the update event) and the notification flow (which emits
 * one notification per impacted entity) — the expected affected edges are
 * derived exactly once, from the same projection state.
 */
export function impactedEntitiesOfActivity(
  activity: EntityRef,
  schedule: EntityRef,
  index: Pick<ScheduleRelationshipIndex, 'relationships'>,
): readonly EntityRef[] {
  const impacted: EntityRef[] = [];
  for (const edge of index.relationships) {
    // (successor) depends-on (updated activity) — the successor is impacted.
    if (edge.kind === 'depends-on' && compareEntityRef(edge.to, activity) === 0) {
      impacted.push(edge.from);
    }
    // (baseline) derives-from (the updated activity's schedule) — the
    // baseline's planned dates are impacted by the activity change.
    if (
      edge.kind === 'derives-from' &&
      edge.from.entityKind === BASELINE_CANONICAL_KIND &&
      compareEntityRef(edge.to, schedule) === 0
    ) {
      impacted.push(edge.from);
    }
  }
  impacted.sort(compareEntityRef);
  return impacted;
}

/**
 * THE relationship projection: fold a canonical event stream into the
 * schedule relationship index. Deterministic by construction: events are
 * consumed in the given order, edge identity is (kind, from, to), the fold
 * keeps the MOST RECENT asserting event's reference per edge, and every
 * output collection is canonically sorted. Unknown (non-schedules) event
 * names are skipped deterministically and tallied — never a crash, never a
 * silent invention; a RECOGNIZED schedules-area event name with a malformed
 * payload is a typed invariant-violation instead (the ledger's payloads
 * were validated at append time — corruption fails closed rather than
 * guessing).
 *
 * At every `schedule.activityUpdated` event the fold ALSO derives the
 * impact edges — (updated activity) affects (each impacted successor) and
 * (updated activity) affects (the schedule's baseline) — from the network
 * the PRIOR events established: THE expected affected edges of the
 * downstream impact-notification flow.
 */
export function projectScheduleRelationships(
  events: readonly DomainEventEnvelope[],
): Result<ScheduleRelationshipIndex, DomainError> {
  const state: FoldState = {
    edges: new Map<string, ScheduleRelationshipEdge>(),
    nodes: new Map<string, EntityNode>(),
    recognized: new Map<string, number>(),
    skipped: new Map<string, number>(),
  };

  for (const event of events) {
    const payload = parseScheduleEventPayload(event.eventName, event.payload);
    if (payload === null) {
      tally(state.skipped, event.eventName);
      continue;
    }
    if (!payload.ok) {
      return fail(payloadError(event, payload.error));
    }
    tally(state.recognized, event.eventName);

    // The event's own aggregate joins the tracked nodes (lifecycle events
    // with no cross-entity links contribute their node only).
    const aggregate = event.entityRefs.after ?? event.entityRefs.before;
    if (aggregate !== null) {
      state.nodes.set(nodeKeyOf(aggregate), { entity: aggregate, scope: event.scope });
    }

    // Dependency removal: the asserted depends-on edge is retracted.
    if (event.eventName === DEPENDENCY_REMOVED_EVENT) {
      const removed = payload.value as DependencyRemovedPayload;
      state.edges.delete(
        JSON.stringify([
          'depends-on',
          ACTIVITY_CANONICAL_KIND,
          removed.successorId,
          ACTIVITY_CANONICAL_KIND,
          removed.predecessorId,
        ]),
      );
    }

    const derived = edgesOfScheduleEvent(event);
    if (!derived.ok) return derived;
    for (const edge of derived.value) {
      state.edges.set(edgeKeyOf(edge), edge);
      state.nodes.set(nodeKeyOf(edge.from), { entity: edge.from, scope: edge.scope });
      state.nodes.set(nodeKeyOf(edge.to), { entity: edge.to, scope: edge.scope });
    }

    // THE activity-update impact derivation: (updated activity) affects each
    // impacted successor activity and the schedule's baseline.
    if (event.eventName === ACTIVITY_UPDATED_EVENT) {
      const updated = payload.value as ActivityUpdatedPayload;
      const activity = { entityKind: ACTIVITY_CANONICAL_KIND, entityId: updated.activityId };
      const schedule = { entityKind: SCHEDULE_CANONICAL_KIND, entityId: updated.scheduleId };
      const reference = scheduleEventReferenceOf(event);
      const impacted = impactedEntitiesOfActivity(
        activity,
        schedule,
        { relationships: [...state.edges.values()] },
      );
      for (const affected of impacted) {
        const impactEdge = edgeOf('affects', activity, affected, event.scope, reference);
        state.edges.set(edgeKeyOf(impactEdge), impactEdge);
        state.nodes.set(nodeKeyOf(impactEdge.from), { entity: impactEdge.from, scope: impactEdge.scope });
        state.nodes.set(nodeKeyOf(impactEdge.to), { entity: impactEdge.to, scope: impactEdge.scope });
      }
    }
  }

  const relationships = [...state.edges.values()].sort(compareScheduleRelationshipEdge);
  const entities = [...state.nodes.values()].sort(compareScheduleEntityNode);
  return ok({
    relationships,
    entities,
    derivation: {
      projectedEventCount: events.length,
      entityCount: entities.length,
      relationshipCount: relationships.length,
      recognizedEventNames: talliesOf(state.recognized),
      skippedEventNames: talliesOf(state.skipped),
    },
    relationshipsOf(entity: EntityRef): readonly ScheduleRelationshipEdge[] {
      return relationships.filter(
        (edge) =>
          compareEntityRef(edge.from, entity) === 0 || compareEntityRef(edge.to, entity) === 0,
      );
    },
  } satisfies ScheduleRelationshipIndex);
}

const tally = (map: Map<string, number>, eventName: EventName): void => {
  map.set(eventName, (map.get(eventName) ?? 0) + 1);
};

const talliesOf = (map: Map<string, number>): readonly EventNameTally[] =>
  [...map.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([eventName, count]) => ({ eventName: eventName as EventName, count }));

const notAScheduleEventError = (event: DomainEventEnvelope): DomainError =>
  domainError(
    'invariant-violation',
    `event '${event.eventName}' is not a schedules-area event — the schedule relationship projection only consumes the schedules-area vocabulary`,
    [
      {
        code: 'schedule-event-not-recognized',
        message: event.eventName,
        path: 'eventName',
      },
    ],
    { scope: event.scope },
  );

const payloadError = (
  event: DomainEventEnvelope,
  failure: { readonly code: string; readonly path: string; readonly expected: string; readonly received: string },
): DomainError =>
  domainError(
    'invariant-violation',
    `recognized schedules-area event '${event.eventName}' carries a malformed payload: ${failure.code} at '${failure.path === '' ? '<root>' : failure.path}'`,
    [
      {
        code: `schedule-event-payload-${failure.code}`,
        message: failure.received,
        path: failure.path === '' ? null : failure.path,
      },
    ],
    { scope: event.scope },
  );

// ---------------------------------------------------------------------------
// THE downstream impact notifications.
// ---------------------------------------------------------------------------

declare const scheduleNotificationIdBrand: unique symbol;

/** The deterministic id of one impact-notification record. */
export type ScheduleNotificationId = string & {
  readonly [scheduleNotificationIdBrand]: 'ScheduleNotificationId';
};

/** Grammar description used in parse failures. */
export const SCHEDULE_NOTIFICATION_ID_GRAMMAR =
  'office-scnt-v1-<opaque: 16..64 lowercase alphanumeric> (deterministic sha256 derivation over the source event id, the subject, the impacted entity, and the relationship kind)';

const SCHEDULE_NOTIFICATION_ID_PREFIX = 'office-scnt-v1-';

/**
 * One downstream impact notification: the record asserting that a canonical
 * activity change AFFECTS one entity of the schedule network (an impacted
 * successor activity, or the schedule's baseline — everything the
 * relationship projection derives as affected by the change), with the FULL
 * traceability to the source canonical event.
 */
export interface RelationshipNotification {
  readonly kind: 'relationship-notification';
  /** The deterministic notification id (derived, never random). */
  readonly notificationId: ScheduleNotificationId;
  /** The tenant whose canonical flow produced the notification (A12). */
  readonly tenantId: TenantId;
  /** The changed schedule activity (the notification's subject). */
  readonly subject: EntityRef;
  /** The impacted entity (the notification's object). */
  readonly impacted: EntityRef;
  /** The relationship kind asserted between subject and impacted ('affects'). */
  readonly relationshipKind: RelationshipKind;
  /** The full traceability reference to the source canonical event. */
  readonly sourceEvent: ScheduleEventReference;
}

/** Compose the deterministic notification id (local, pure). */
const notificationIdOf = (
  sourceEventId: ScheduleEventId,
  subject: EntityRef,
  impacted: EntityRef,
  relationshipKind: RelationshipKind,
): ScheduleNotificationId => {
  const material = JSON.stringify([
    'office-schedule-impact-notification',
    sourceEventId,
    subject.entityKind,
    subject.entityId,
    impacted.entityKind,
    impacted.entityId,
    relationshipKind,
  ]);
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  const candidate = `${SCHEDULE_NOTIFICATION_ID_PREFIX}${digest.slice(0, DERIVED_OPAQUE_LENGTH)}`;
  if (
    typeof candidate !== 'string' ||
    !candidate.startsWith(SCHEDULE_NOTIFICATION_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(candidate.slice(SCHEDULE_NOTIFICATION_ID_PREFIX.length))
  ) {
    // Pure derivation over validated inputs — a violation is a module defect.
    throw new TypeError(`derived schedule notification id is not valid: ${candidate}`);
  }
  return candidate as ScheduleNotificationId;
};

/**
 * Derive THE downstream impact notifications of one canonical
 * activity-change event (`schedule.activityUpdated`): one notification per
 * impacted entity — (activity) affects (entity) — where the impacted set is
 * THE relationship projection's derivation: every successor activity that
 * depends-on the changed activity, plus the schedule's baseline. Each
 * notification references the source event id, its causation id (the
 * executed command's SourceRef-derived idempotency key), and its
 * correlation id (the provider object's lifecycle chain): full
 * traceability from the notification back to the exact provider object
 * version that caused it.
 *
 * Fail-closed: any other event (a non-activity-change schedules-area event,
 * a non-schedules event, or a malformed payload) is a typed
 * invariant-violation. Deterministic: notifications are emitted in the
 * impacted set's canonical entity order.
 */
export function notificationsOfScheduleEvent(
  event: DomainEventEnvelope,
  index: Pick<ScheduleRelationshipIndex, 'relationships'>,
): Result<readonly RelationshipNotification[], DomainError> {
  if (event.eventName !== ACTIVITY_UPDATED_EVENT) {
    return fail(
      domainError(
        'invariant-violation',
        `event '${event.eventName}' is not an activity-change event — the downstream impact-notification flow consumes schedule.activityUpdated events only`,
        [
          {
            code: 'schedule-event-not-activity-change',
            message: event.eventName,
            path: 'eventName',
          },
        ],
        { scope: event.scope },
      ),
    );
  }
  const payload = parseActivityUpdatedPayload(event.payload);
  if (!payload.ok) {
    return fail(payloadError(event, payload.error));
  }
  const activity = { entityKind: ACTIVITY_CANONICAL_KIND, entityId: payload.value.activityId };
  const schedule = { entityKind: SCHEDULE_CANONICAL_KIND, entityId: payload.value.scheduleId };
  const reference = scheduleEventReferenceOf(event);
  const tenantId = event.scope.tenantId;
  const impacted = impactedEntitiesOfActivity(activity, schedule, index);
  return ok(
    impacted.map(
      (entity) =>
        ({
          kind: 'relationship-notification',
          notificationId: notificationIdOf(reference.eventId, activity, entity, 'affects'),
          tenantId,
          subject: activity,
          impacted: entity,
          relationshipKind: 'affects',
          sourceEvent: reference,
        }) satisfies RelationshipNotification,
    ),
  );
}
