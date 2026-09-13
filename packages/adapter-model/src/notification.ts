// Office adapter-model — THE affected-relationship notification flow (OFF-022).
//
// The flow this package exists to demonstrate:
//
//   provider element mutation
//     → canonical command proposal (change-mapping.ts)
//     → (executed by the host) canonical `models.elementChanged` /
//       `models.elementRetired` DomainEventEnvelope
//     → THE relationship projection below derives the expected edges
//       ((element) affects (each linked activity/document),
//       (element) derives-from (its model version),
//       (model version) derives-from (its model))
//     → the notification records below — one per affected linked entity —
//       each referencing the SOURCE EVENT ID (full traceability: the event
//       id, the event's causation id — the executed command's idempotency
//       key, which is the SourceRef-derived sync key of the exact provider
//       object version — and the correlation id of the provider object's
//       whole lifecycle chain).
//
// The edge vocabulary is THE canonical relationship vocabulary of
// @office/intelligence-relationships (OFF-013), consumed AS TYPES ONLY (the
// frozen OFF-022 boundary: no logic imports): ModelRelationshipEdge extends
// the canonical Relationship shape (kind/from/to/scope), the tracked nodes
// ARE the canonical EntityNode shape, and the derivation metadata mirrors
// the canonical EventNameTally shape. The ledger-branded provenance of the
// full Relationship type is intentionally replaced by this package's own
// ModelEventReference — the OFF-005 ledger assigns ledger event ids at
// append time, which this package cannot reach (and must not: adapters
// never touch the ledger); the adapter-side reference derived here is the
// deterministic digest of the exact envelope, plus its full causality.
//
// Deterministic by construction: a pure fold over the event stream in given
// order, edge identity (kind, from, to), the most recent asserting event's
// reference per edge, canonical orderings everywhere, and sha256-derived
// ids over canonical serializations. No clock, no randomness, no I/O.
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
  ELEMENT_CHANGED_EVENT,
  ELEMENT_RETIRED_EVENT,
  ELEMENT_CANONICAL_KIND,
  MODEL_CANONICAL_KIND,
  MODEL_VERSION_CANONICAL_KIND,
  MODEL_VERSION_REGISTERED_EVENT,
} from './vocabulary';
import {
  parseElementChangedPayload,
  parseElementRetiredPayload,
  parseModelEventPayload,
} from './change-mapping';
import type {
  ElementChangedPayload,
  ElementRetiredPayload,
  ModelVersionRegisteredPayload,
} from './change-mapping';
import { compareEntityRef } from './references';

// ---------------------------------------------------------------------------
// The adapter-side canonical event reference (the source event id).
// ---------------------------------------------------------------------------

declare const modelEventIdBrand: unique symbol;

/**
 * The deterministic id of one canonical models-area event: a sha256 digest
 * over the canonical serialization of the envelope (fixed field order, the
 * payload serialized as constructed). The OFF-005 ledger assigns its own
 * ledger event ids at append time — this package never touches the ledger;
 * the ModelEventId is the adapter-side stable reference the notification
 * records cite for full traceability (same derivation discipline as the
 * SDK's sync idempotency keys).
 */
export type ModelEventId = string & {
  readonly [modelEventIdBrand]: 'ModelEventId';
};

/** Grammar description used in parse failures. */
export const MODEL_EVENT_ID_GRAMMAR =
  'office-mdev-v1-<opaque: 16..64 lowercase alphanumeric> (deterministic sha256 derivation over the canonical event envelope serialization)';

const MODEL_EVENT_ID_PREFIX = 'office-mdev-v1-';
const DERIVED_OPAQUE_LENGTH = 32;
const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;

/** Parse an untrusted value as a ModelEventId (total, fail-closed). */
export function parseModelEventId(raw: unknown): Result<ModelEventId, DomainError> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(MODEL_EVENT_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(raw.slice(MODEL_EVENT_ID_PREFIX.length))
  ) {
    return fail(
      domainError(
        'invariant-violation',
        `not a valid model event id: ${String(raw)}`,
        [
          {
            code: 'model-event-id-invalid',
            message: String(raw),
            path: null,
          },
        ],
      ),
    );
  }
  return ok(raw as ModelEventId);
}

/** Type guard for structurally valid ModelEventId values. */
export function isModelEventId(raw: unknown): raw is ModelEventId {
  return parseModelEventId(raw).ok;
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
 * Derive the ModelEventId of one canonical models-area event envelope
 * (deterministic, pure): `office-mdev-v1-<sha256 prefix>` over the envelope's
 * canonical serialization — event name, scope, actor, source, causal chain,
 * schema version, occurred-at, before/after entity refs, and the payload as
 * constructed (the trusted envelope builders emit fixed key order).
 */
export function modelEventIdOf(envelope: DomainEventEnvelope): ModelEventId {
  const material = JSON.stringify([
    'office-model-event-reference',
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
  const candidate = `${MODEL_EVENT_ID_PREFIX}${digest.slice(0, DERIVED_OPAQUE_LENGTH)}`;
  const parsed = parseModelEventId(candidate);
  if (!parsed.ok) {
    // Pure derivation over validated inputs — a violation is a module defect.
    throw new TypeError(`derived model event id is not valid: ${candidate}`);
  }
  return parsed.value;
}

/** The full traceability reference to the source event of a notification. */
export interface ModelEventReference {
  /** The deterministic id of the exact canonical event envelope. */
  readonly eventId: ModelEventId;
  /** The event's name (e.g. 'models.elementChanged'). */
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

/** Compose the ModelEventReference of one envelope (deterministic, pure). */
export function modelEventReferenceOf(envelope: DomainEventEnvelope): ModelEventReference {
  return {
    eventId: modelEventIdOf(envelope),
    eventName: envelope.eventName,
    occurredAt: envelope.occurredAt,
    correlationId: envelope.causality.correlationId,
    causationId: envelope.causality.causationId,
    actor: envelope.actor,
  };
}

// ---------------------------------------------------------------------------
// The model relationship projection (the edge derivation).
// ---------------------------------------------------------------------------

/**
 * One typed directed edge between canonical entities — structurally THE
 * canonical Relationship shape (kind/from/to/scope from
 * @office/intelligence-relationships, consumed as types only), with the
 * ledger-branded provenance replaced by this package's own source-event
 * reference (the adapter side of the provenance seam).
 */
export interface ModelRelationshipEdge extends Pick<Relationship, 'kind' | 'from' | 'to' | 'scope'> {
  /** The derivation provenance: the event that asserted this edge. */
  readonly sourceEvent: ModelEventReference;
}

/**
 * How the model relationship projection was derived — its own audit trail
 * (mirroring the canonical DerivationMetadata shape as far as the
 * types-only boundary allows).
 */
export interface ModelDerivationMetadata {
  /** Total events the projection consumed. */
  readonly projectedEventCount: number;
  /** How many distinct entities the index tracks. */
  readonly entityCount: number;
  /** How many relationship edges the index carries. */
  readonly relationshipCount: number;
  /** Recognized models-area event names with their counts (canonical order). */
  readonly recognizedEventNames: readonly EventNameTally[];
  /** Non-models event names skipped deterministically, with counts (canonical order). */
  readonly skippedEventNames: readonly EventNameTally[];
}

/** The model relationship index — a derived, rebuildable projection. */
export interface ModelRelationshipIndex {
  /** Every relationship edge, in canonical order. */
  readonly relationships: readonly ModelRelationshipEdge[];
  /** Every tracked entity node, in canonical order. */
  readonly entities: readonly EntityNode[];
  /** The projection's derivation metadata. */
  readonly derivation: ModelDerivationMetadata;
  /** All relationships incident to one entity (both directions), in canonical order. */
  relationshipsOf(entity: EntityRef): readonly ModelRelationshipEdge[];
}

/** Canonical relationship order: kind, from, to, producing event id. */
export function compareModelRelationshipEdge(
  left: ModelRelationshipEdge,
  right: ModelRelationshipEdge,
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
export function compareModelEntityNode(left: EntityNode, right: EntityNode): number {
  return compareEntityRef(left.entity, right.entity);
}

const edgeKeyOf = (edge: ModelRelationshipEdge): string =>
  JSON.stringify([edge.kind, edge.from.entityKind, edge.from.entityId, edge.to.entityKind, edge.to.entityId]);

const nodeKeyOf = (entity: EntityRef): string => JSON.stringify([entity.entityKind, entity.entityId]);

/** Compose one asserted edge (local helper). */
const edgeOf = (
  kind: RelationshipKind,
  from: EntityRef,
  to: EntityRef,
  scope: DomainEventEnvelope['scope'],
  sourceEvent: ModelEventReference,
): ModelRelationshipEdge => ({ kind, from, to, scope, sourceEvent });

/**
 * Derive the relationship edges ONE canonical models-area event asserts
 * (deterministic, pure — the derivation grammar of the projection):
 *
 *   `models.modelVersionRegistered`
 *     → (model version) derives-from (model);
 *   `models.elementChanged` / `models.elementRetired`
 *     → (element) derives-from (its model version) AND
 *       (element) affects (each linked activity/document) — the affected
 *       entities of the mutation, THE notification edges;
 *   every other models-area event asserts no cross-entity edge.
 */
export function edgesOfModelEvent(
  event: DomainEventEnvelope,
): Result<readonly ModelRelationshipEdge[], DomainError> {
  const payload = parseModelEventPayload(event.eventName, event.payload);
  if (payload === null) {
    return fail(notAModelEventError(event));
  }
  if (!payload.ok) {
    return fail(payloadError(event, payload.error));
  }
  const reference = modelEventReferenceOf(event);
  const edges: ModelRelationshipEdge[] = [];
  if (event.eventName === MODEL_VERSION_REGISTERED_EVENT) {
    const versionPayload = payload.value as ModelVersionRegisteredPayload;
    edges.push(
      edgeOf(
        'derives-from',
        { entityKind: MODEL_VERSION_CANONICAL_KIND, entityId: versionPayload.modelVersionId },
        { entityKind: MODEL_CANONICAL_KIND, entityId: versionPayload.modelId },
        event.scope,
        reference,
      ),
    );
  }
  if (event.eventName === ELEMENT_CHANGED_EVENT || event.eventName === ELEMENT_RETIRED_EVENT) {
    const elementPayload = payload.value as ElementChangedPayload | ElementRetiredPayload;
    const element = { entityKind: ELEMENT_CANONICAL_KIND, entityId: elementPayload.elementId };
    edges.push(
      edgeOf(
        'derives-from',
        element,
        { entityKind: MODEL_VERSION_CANONICAL_KIND, entityId: elementPayload.modelVersionId },
        event.scope,
        reference,
      ),
    );
    for (const affected of elementPayload.affectedEntityRefs) {
      edges.push(edgeOf('affects', element, affected, event.scope, reference));
    }
  }
  return ok(edges);
}

/**
 * THE relationship projection: fold a canonical event stream into the model
 * relationship index. Deterministic by construction: events are consumed in
 * the given order, edge identity is (kind, from, to), the fold keeps the
 * MOST RECENT asserting event's reference per edge, and every output
 * collection is canonically sorted. Unknown (non-models) event names are
 * skipped deterministically and tallied — never a crash, never a silent
 * invention; a RECOGNIZED models-area event name with a malformed payload
 * is a typed invariant-violation instead (the ledger's payloads were
// validated at append time — corruption fails closed rather than guessing).
 */
export function projectModelRelationships(
  events: readonly DomainEventEnvelope[],
): Result<ModelRelationshipIndex, DomainError> {
  const edges = new Map<string, ModelRelationshipEdge>();
  const nodes = new Map<string, EntityNode>();
  const recognized = new Map<string, number>();
  const skipped = new Map<string, number>();

  for (const event of events) {
    const payload = parseModelEventPayload(event.eventName, event.payload);
    if (payload === null) {
      tally(skipped, event.eventName);
      continue;
    }
    if (!payload.ok) {
      return fail(payloadError(event, payload.error));
    }
    tally(recognized, event.eventName);

    // The event's own aggregate joins the tracked nodes (lifecycle events
    // with no cross-entity links contribute their node only).
    const aggregate = event.entityRefs.after ?? event.entityRefs.before;
    if (aggregate !== null) {
      nodes.set(nodeKeyOf(aggregate), { entity: aggregate, scope: event.scope });
    }

    const derived = edgesOfModelEvent(event);
    if (!derived.ok) return derived;
    for (const edge of derived.value) {
      edges.set(edgeKeyOf(edge), edge);
      nodes.set(nodeKeyOf(edge.from), { entity: edge.from, scope: edge.scope });
      nodes.set(nodeKeyOf(edge.to), { entity: edge.to, scope: edge.scope });
    }
  }

  const relationships = [...edges.values()].sort(compareModelRelationshipEdge);
  const entities = [...nodes.values()].sort(compareModelEntityNode);
  return ok({
    relationships,
    entities,
    derivation: {
      projectedEventCount: events.length,
      entityCount: entities.length,
      relationshipCount: relationships.length,
      recognizedEventNames: talliesOf(recognized),
      skippedEventNames: talliesOf(skipped),
    },
    relationshipsOf(entity: EntityRef): readonly ModelRelationshipEdge[] {
      return relationships.filter(
        (edge) =>
          compareEntityRef(edge.from, entity) === 0 || compareEntityRef(edge.to, entity) === 0,
      );
    },
  } satisfies ModelRelationshipIndex);
}

const tally = (map: Map<string, number>, eventName: EventName): void => {
  map.set(eventName, (map.get(eventName) ?? 0) + 1);
};

const talliesOf = (map: Map<string, number>): readonly EventNameTally[] =>
  [...map.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([eventName, count]) => ({ eventName: eventName as EventName, count }));

const notAModelEventError = (event: DomainEventEnvelope): DomainError =>
  domainError(
    'invariant-violation',
    `event '${event.eventName}' is not a models-area event — the model relationship projection only consumes the models-area vocabulary`,
    [
      {
        code: 'model-event-not-recognized',
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
    `recognized models-area event '${event.eventName}' carries a malformed payload: ${failure.code} at '${failure.path === '' ? '<root>' : failure.path}'`,
    [
      {
        code: `model-event-payload-${failure.code}`,
        message: failure.received,
        path: failure.path === '' ? null : failure.path,
      },
    ],
    { scope: event.scope },
  );

// ---------------------------------------------------------------------------
// THE affected-relationship notifications.
// ---------------------------------------------------------------------------

declare const modelNotificationIdBrand: unique symbol;

/** The deterministic id of one affected-relationship notification record. */
export type ModelNotificationId = string & {
  readonly [modelNotificationIdBrand]: 'ModelNotificationId';
};

/** Grammar description used in parse failures. */
export const MODEL_NOTIFICATION_ID_GRAMMAR =
  'office-mnt-v1-<opaque: 16..64 lowercase alphanumeric> (deterministic sha256 derivation over the source event id, the subject, the affected entity, and the relationship kind)';

const MODEL_NOTIFICATION_ID_PREFIX = 'office-mnt-v1-';

/**
 * One affected-relationship notification: the record asserting that a model
 * element mutation AFFECTS one linked entity (an activity, a document —
 * whatever the element's provider link refs resolved to canonically), with
 * the FULL traceability to the source canonical event.
 */
export interface RelationshipNotification {
  readonly kind: 'relationship-notification';
  /** The deterministic notification id (derived, never random). */
  readonly notificationId: ModelNotificationId;
  /** The tenant whose canonical flow produced the notification (A12). */
  readonly tenantId: TenantId;
  /** The mutated model element (the notification's subject). */
  readonly subject: EntityRef;
  /** The affected linked entity (the notification's object). */
  readonly affected: EntityRef;
  /** The relationship kind asserted between subject and affected ('affects'). */
  readonly relationshipKind: RelationshipKind;
  /** The full traceability reference to the source canonical event. */
  readonly sourceEvent: ModelEventReference;
}

/** Compose the deterministic notification id (local, pure). */
const notificationIdOf = (
  sourceEventId: ModelEventId,
  subject: EntityRef,
  affected: EntityRef,
  relationshipKind: RelationshipKind,
): ModelNotificationId => {
  const material = JSON.stringify([
    'office-model-relationship-notification',
    sourceEventId,
    subject.entityKind,
    subject.entityId,
    affected.entityKind,
    affected.entityId,
    relationshipKind,
  ]);
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  const candidate = `${MODEL_NOTIFICATION_ID_PREFIX}${digest.slice(0, DERIVED_OPAQUE_LENGTH)}`;
  if (
    typeof candidate !== 'string' ||
    !candidate.startsWith(MODEL_NOTIFICATION_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(candidate.slice(MODEL_NOTIFICATION_ID_PREFIX.length))
  ) {
    // Pure derivation over validated inputs — a violation is a module defect.
    throw new TypeError(`derived model notification id is not valid: ${candidate}`);
  }
  return candidate as ModelNotificationId;
};

/**
 * Derive THE affected-relationship notifications of one canonical
 * element-mutation event (`models.elementChanged` or `models.elementRetired`):
 * one notification per affected linked entity — (element) affects (entity) —
 * each referencing the source event id, its causation id (the executed
 * command's SourceRef-derived idempotency key), and its correlation id (the
 * provider object's lifecycle chain): full traceability from the
 * notification back to the exact provider object version that caused it.
 *
 * Fail-closed: any other event (a non-element-mutation models-area event, a
 * non-models event, or a malformed payload) is a typed invariant-violation.
 * Deterministic: notifications are emitted in the event payload's canonical
 * affected-entity order.
 */
export function notificationsOfModelEvent(
  event: DomainEventEnvelope,
): Result<readonly RelationshipNotification[], DomainError> {
  if (event.eventName !== ELEMENT_CHANGED_EVENT && event.eventName !== ELEMENT_RETIRED_EVENT) {
    return fail(
      domainError(
        'invariant-violation',
        `event '${event.eventName}' is not an element-mutation event — the affected-relationship notification flow consumes models.elementChanged and models.elementRetired events only`,
        [
          {
            code: 'model-event-not-element-mutation',
            message: event.eventName,
            path: 'eventName',
          },
        ],
        { scope: event.scope },
      ),
    );
  }
  const payload =
    event.eventName === ELEMENT_CHANGED_EVENT
      ? parseElementChangedPayload(event.payload)
      : parseElementRetiredPayload(event.payload);
  if (!payload.ok) {
    return fail(payloadError(event, payload.error));
  }
  const element = { entityKind: ELEMENT_CANONICAL_KIND, entityId: payload.value.elementId };
  const reference = modelEventReferenceOf(event);
  const tenantId = event.scope.tenantId;
  return ok(
    payload.value.affectedEntityRefs.map(
      (affected) =>
        ({
          kind: 'relationship-notification',
          notificationId: notificationIdOf(reference.eventId, element, affected, 'affects'),
          tenantId,
          subject: element,
          affected,
          relationshipKind: 'affects',
          sourceEvent: reference,
        }) satisfies RelationshipNotification,
    ),
  );
}
