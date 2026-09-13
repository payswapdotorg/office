import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseEntityRef,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { EntityRef, EventName, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  adapterCommandEnvelope,
  providerObjectId,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
} from '@office/adapters-sdk';
import type { AdapterCommandInput } from '@office/adapters-sdk';
import type { DomainEventEnvelope } from '@office/contracts';
import type { EntityNode, EventNameTally, Relationship } from '@office/intelligence-relationships';
import {
  ELEMENT_OBJECT_KIND,
  MODEL_ADAPTER_KIND,
  MODEL_SYSTEM_ID,
  ELEMENT_CHANGED_EVENT,
  ELEMENT_RETIRED_EVENT,
  MODEL_REGISTERED_EVENT,
  MODEL_VERSION_REGISTERED_EVENT,
  parseElementClassification,
  parseElementQuantity,
  parseModelDiscipline,
} from './vocabulary';
import type { ElementClassification } from './vocabulary';
import { LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF, TOWER_MODEL_ID, WALL_ELEMENT_ID } from './provider-fixture';
import { createModelTranslator, elementChangedEnvelope, elementRetiredEnvelope, modelEventEnvelope } from './change-mapping';
import type { ElementChangedPayload, ElementRetiredPayload } from './change-mapping';
import {
  edgesOfModelEvent,
  isModelEventId,
  modelEventIdOf,
  modelEventReferenceOf,
  notificationsOfModelEvent,
  parseModelEventId,
  projectModelRelationships,
} from './notification';
import type { ModelEventId, ModelRelationshipIndex } from './notification';

// OFF-022 adapter-model — THE affected-relationship notification flow: the
// deterministic relationship projection over canonical models-area events
// (typed against @office/intelligence-relationships' vocabulary — TYPES
// ONLY), the edge derivation grammar, and the notification records with
// full traceability to the source event id. Deterministic: fixed ids and
// instants, sha256 derivations only.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-10-06T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-10-07T12:30:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-10-08T08:15:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `mdl${String(n).padStart(13, '0')}` });
const version = (n: number) => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));
const classification = (code: string): ElementClassification =>
  unwrap(parseElementClassification(code));
const discipline = (code: string) => unwrap(parseModelDiscipline(code));
const quantityOf = (value: number, unit: string) =>
  unwrap(parseElementQuantity({ value, unit }));

const CONTEXT = adapterAuthorizationContext({
  actorId: entity(90),
  scope: { kind: 'tenant', tenantId: TENANT_A },
  capabilities: ['models.write'],
});

const WALL_ELEMENT_REF = ref('element', entity(4));
const MODEL_REF = ref('model', entity(1));
const MODEL_VERSION_REF = ref('model-version', entity(3));
const ACTIVITY_REF = ref('activity', entity(80));
const DOCUMENT_REF = ref('document', entity(81));

const wallSource = (objectVersion: string) =>
  sourceRef({
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectType: ELEMENT_OBJECT_KIND,
    objectId: providerObjectId(WALL_ELEMENT_ID),
    version: providerVersion(objectVersion),
  });

const wallCommand = (objectVersion: string) => {
  const input: AdapterCommandInput = {
    origin: 'sync',
    tenantId: TENANT_A,
    source: wallSource(objectVersion),
    canonical: WALL_ELEMENT_REF,
    canonicalVersion: version(1),
    changeKind: 'updated',
    displayName: 'Wall 103 — grid B/4',
    data: {
      modelId: TOWER_MODEL_ID,
      modelVersionId: 'mv-tower-a-2',
      classification: 'wall',
      quantity: { value: 42.5, unit: 'm2' },
      linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    },
  };
  const proposal = unwrap(createModelTranslator().proposeCommand(input));
  return adapterCommandEnvelope({
    proposal,
    context: CONTEXT,
    source: input.source,
    causationId: null,
    now: NOW_1,
  });
};

const wallChangedEnvelope = (
  occurredAt: Timestamp,
  objectVersion: string,
  affected: readonly EntityRef[],
  quantity: { readonly value: number; readonly unit: string } | null,
): DomainEventEnvelope<ElementChangedPayload> =>
  elementChangedEnvelope({
    command: wallCommand(objectVersion),
    occurredAt,
    element: WALL_ELEMENT_REF,
    modelVersion: MODEL_VERSION_REF,
    model: MODEL_REF,
    classification: classification('wall'),
    change: 'updated',
    displayName: 'Wall 103 — grid B/4',
    quantity: quantity === null ? null : quantityOf(quantity.value, quantity.unit),
    affectedEntityRefs: affected,
    rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    providerObjectId: WALL_ELEMENT_ID,
    providerVersion: objectVersion,
  });

const wallRetiredEnvelope = (
  occurredAt: Timestamp,
  objectVersion: string,
  affected: readonly EntityRef[],
): DomainEventEnvelope<ElementRetiredPayload> =>
  elementRetiredEnvelope({
    command: wallCommand(objectVersion),
    occurredAt,
    element: WALL_ELEMENT_REF,
    modelVersion: MODEL_VERSION_REF,
    model: MODEL_REF,
    classification: classification('wall'),
    displayName: 'Wall 103 — grid B/4',
    affectedEntityRefs: affected,
    rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    providerObjectId: WALL_ELEMENT_ID,
    providerVersion: objectVersion,
  });

const versionRegisteredEnvelope = (occurredAt: Timestamp): DomainEventEnvelope =>
  modelEventEnvelope({
    command: wallCommand('v1'),
    eventName: MODEL_VERSION_REGISTERED_EVENT,
    occurredAt,
    entityRefs: { before: null, after: MODEL_VERSION_REF },
    payload: {
      modelId: MODEL_REF.entityId,
      modelVersionId: MODEL_VERSION_REF.entityId,
      label: 'coordination-2026-10-05',
      provenance: {
        sourceKey: sourceRefKeyOf(wallSource('v1')),
        providerObjectId: 'mv-tower-a-2',
        providerVersion: 'v1',
      },
    },
  });

const nonModelsEnvelope = (base: DomainEventEnvelope): DomainEventEnvelope => ({
  ...base,
  eventName: 'projects.projectCreated' as EventName,
});

describe('the model event id (the source event id of every notification)', () => {
  it('derives office-mdev-v1 ids deterministically from the exact envelope', () => {
    const envelope = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' });
    const id = modelEventIdOf(envelope);
    expect(id).toMatch(/^office-mdev-v1-[0-9a-z]{32}$/);
    expect(modelEventIdOf(envelope)).toBe(id);
    expect(isModelEventId(id)).toBe(true);
    // A different envelope (different occurredAt) derives a different id.
    const other = modelEventIdOf(wallChangedEnvelope(NOW_3, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' }));
    expect(other).not.toBe(id);
    // The full payload participates: a changed quantity changes the id.
    const mutated = modelEventIdOf(
      wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 45.5, unit: 'm2' }),
    );
    expect(mutated).not.toBe(id);
  });

  it('parses model event ids fail-closed', () => {
    expect(parseModelEventId('office-mdev-v1-0123456789abcdef0123456789abcdef').ok).toBe(true);
    for (const bad of [
      'office-mnt-v1-0123456789abcdef0123456789abcdef',
      'office-mdev-v1-SHORT',
      'office-mdev-v1-UPPERCASE0123456789abcdef01234567',
      'office-mdev-v2-0123456789abcdef0123456789abcdef',
      '',
      null,
      7,
    ]) {
      expect(parseModelEventId(bad).ok, String(bad)).toBe(false);
      expect(isModelEventId(bad), String(bad)).toBe(false);
    }
  });

  it('composes the full traceability reference of an envelope', () => {
    const command = wallCommand('v2');
    const envelope = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' });
    const reference = modelEventReferenceOf(envelope);
    expect(reference).toStrictEqual({
      eventId: modelEventIdOf(envelope),
      eventName: ELEMENT_CHANGED_EVENT,
      occurredAt: NOW_2,
      correlationId: envelope.causality.correlationId,
      causationId: envelope.causality.causationId,
      actor: envelope.actor,
    });
    // The causation id is the executed command's idempotency key — the
    // SourceRef-derived sync key of the exact provider object version.
    expect(reference.causationId).toBe(command.idempotencyKey);
  });
});

describe('edgesOfModelEvent — the edge derivation grammar', () => {
  it('derives affects + derives-from edges for models.elementChanged', () => {
    const envelope = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' });
    const edges = unwrap(edgesOfModelEvent(envelope));
    expect(edges).toHaveLength(3);
    const reference = modelEventReferenceOf(envelope);
    expect(edges).toStrictEqual([
      {
        kind: 'derives-from',
        from: WALL_ELEMENT_REF,
        to: MODEL_VERSION_REF,
        scope: envelope.scope,
        sourceEvent: reference,
      },
      { kind: 'affects', from: WALL_ELEMENT_REF, to: ACTIVITY_REF, scope: envelope.scope, sourceEvent: reference },
      { kind: 'affects', from: WALL_ELEMENT_REF, to: DOCUMENT_REF, scope: envelope.scope, sourceEvent: reference },
    ]);
  });

  it('derives the same shape for models.elementRetired (retirement affects the links too)', () => {
    const envelope = wallRetiredEnvelope(NOW_3, 'v3', [ACTIVITY_REF]);
    const edges = unwrap(edgesOfModelEvent(envelope));
    expect(edges.map((edge) => [edge.kind, edge.to.entityKind])).toStrictEqual([
      ['derives-from', 'model-version'],
      ['affects', 'activity'],
    ]);
  });

  it('derives the version→model edge for models.modelVersionRegistered and none for pure lifecycle events', () => {
    const versionEvent = versionRegisteredEnvelope(NOW_1);
    expect(unwrap(edgesOfModelEvent(versionEvent))).toStrictEqual([
      {
        kind: 'derives-from',
        from: MODEL_VERSION_REF,
        to: MODEL_REF,
        scope: versionEvent.scope,
        sourceEvent: modelEventReferenceOf(versionEvent),
      },
    ]);

    const lifecycleEvent = modelEventEnvelope({
      command: wallCommand('v1'),
      eventName: MODEL_REGISTERED_EVENT,
      occurredAt: NOW_1,
      entityRefs: { before: null, after: MODEL_REF },
      payload: {
        modelId: MODEL_REF.entityId,
        name: 'Tower A — structural model',
        discipline: discipline('structure'),
        provenance: {
          sourceKey: sourceRefKeyOf(wallSource('v1')),
          providerObjectId: TOWER_MODEL_ID,
          providerVersion: 'v1',
        },
      },
    });
    expect(unwrap(edgesOfModelEvent(lifecycleEvent))).toStrictEqual([]);
  });

  it('fails closed on non-models events and malformed payloads', () => {
    const envelope = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF], { value: 42.5, unit: 'm2' });
    const foreign = nonModelsEnvelope(envelope);
    const foreignResult = edgesOfModelEvent(foreign);
    expect(foreignResult.ok).toBe(false);
    if (!foreignResult.ok) {
      expect(foreignResult.error.details[0]?.code).toBe('model-event-not-recognized');
    }

    const malformed: DomainEventEnvelope = {
      ...envelope,
      payload: { ...envelope.payload, displayName: '' },
    };
    const malformedResult = edgesOfModelEvent(malformed);
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) {
      expect(malformedResult.error.details[0]?.code).toBe('model-event-payload-invalid-value');
    }
  });
});

describe('projectModelRelationships — THE relationship projection', () => {
  it('folds the event stream deterministically (most recent assertion per edge)', () => {
    const first = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' });
    const second = wallChangedEnvelope(NOW_3, 'v3', [ACTIVITY_REF], { value: 44, unit: 'm2' });
    const index = unwrap(projectModelRelationships([versionRegisteredEnvelope(NOW_1), first, second]));

    // Edge identity is (kind, from, to): the activity edge carries the MOST
    // RECENT asserting event's reference, the document edge keeps its own.
    const relationships = index.relationships;
    expect(relationships.map((edge) => [edge.kind, edge.from.entityKind, edge.to.entityKind, edge.to.entityId])).toStrictEqual([
      ['affects', 'element', 'activity', entity(80)],
      ['affects', 'element', 'document', entity(81)],
      ['derives-from', 'element', 'model-version', entity(3)],
      ['derives-from', 'model-version', 'model', entity(1)],
    ]);
    const activityEdge = relationships.find(
      (edge) => edge.kind === 'affects' && edge.to.entityKind === 'activity',
    );
    expect(activityEdge?.sourceEvent.eventId).toBe(modelEventIdOf(second));
    expect(activityEdge?.sourceEvent.occurredAt).toBe(NOW_3);
    const documentEdge = relationships.find(
      (edge) => edge.kind === 'affects' && edge.to.entityKind === 'document',
    );
    expect(documentEdge?.sourceEvent.eventId).toBe(modelEventIdOf(first));
    expect(documentEdge?.sourceEvent.occurredAt).toBe(NOW_2);

    // Every tracked node is collected in canonical order.
    expect(index.entities.map((node) => [node.entity.entityKind, node.entity.entityId])).toStrictEqual([
      ['activity', entity(80)],
      ['document', entity(81)],
      ['element', entity(4)],
      ['model', entity(1)],
      ['model-version', entity(3)],
    ]);

    // The derivation metadata is the projection's own audit trail.
    expect(index.derivation).toStrictEqual({
      projectedEventCount: 3,
      entityCount: 5,
      relationshipCount: 4,
      recognizedEventNames: [
        { eventName: ELEMENT_CHANGED_EVENT, count: 2 },
        { eventName: 'models.modelVersionRegistered', count: 1 },
      ],
      skippedEventNames: [],
    });

    // Incident queries answer in canonical order.
    expect(index.relationshipsOf(WALL_ELEMENT_REF)).toHaveLength(3);
    expect(index.relationshipsOf(ACTIVITY_REF)).toHaveLength(1);
    expect(index.relationshipsOf(MODEL_REF)).toHaveLength(1);
  });

  it('skips non-models events deterministically and fails closed on malformed payloads', () => {
    const element = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF], { value: 42.5, unit: 'm2' });
    const index = unwrap(
      projectModelRelationships([nonModelsEnvelope(element), element, nonModelsEnvelope(element)]),
    );
    expect(index.derivation.recognizedEventNames).toStrictEqual([
      { eventName: ELEMENT_CHANGED_EVENT, count: 1 },
    ]);
    expect(index.derivation.skippedEventNames).toStrictEqual([
      { eventName: 'projects.projectCreated', count: 2 },
    ]);
    expect(index.derivation.projectedEventCount).toBe(3);

    const malformed: DomainEventEnvelope = {
      ...element,
      payload: { ...element.payload, quantity: { value: -1, unit: 'm2' } },
    };
    const result = projectModelRelationships([malformed]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('model-event-payload-invalid-value');
    }
  });

  it('derives edges structurally compatible with the canonical relationship vocabulary (types only)', () => {
    const index: ModelRelationshipIndex = unwrap(
      projectModelRelationships([
        versionRegisteredEnvelope(NOW_1),
        wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' }),
      ]),
    );
    const edge = index.relationships[0];
    if (edge === undefined) throw new Error('expected at least one edge');
    // The tracked edge IS the canonical Relationship shape (kind/from/to/scope).
    const canonical: Pick<Relationship, 'kind' | 'from' | 'to' | 'scope'> = edge;
    expect(canonical.kind).toBe(edge.kind);
    // The tracked nodes ARE the canonical EntityNode shape.
    const node: EntityNode = { entity: canonical.from, scope: canonical.scope };
    expect(node.entity).toStrictEqual(canonical.from);
    // The derivation metadata mirrors the canonical EventNameTally shape.
    const tally: EventNameTally = { eventName: canonical.kind as EventName, count: 1 };
    expect(tally.count).toBe(1);
    expect(index.derivation.recognizedEventNames.every((entry) => entry.count >= 1)).toBe(true);
  });
});

describe('notificationsOfModelEvent — THE affected-relationship notifications', () => {
  it('emits one notification per affected linked entity, referencing the source event id', () => {
    const envelope = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' });
    const notifications = unwrap(notificationsOfModelEvent(envelope));
    expect(notifications).toHaveLength(2);
    const reference = modelEventReferenceOf(envelope);
    expect(notifications).toStrictEqual([
      {
        kind: 'relationship-notification',
        notificationId: notifications[0]?.notificationId,
        tenantId: TENANT_A,
        subject: WALL_ELEMENT_REF,
        affected: ACTIVITY_REF,
        relationshipKind: 'affects',
        sourceEvent: reference,
      },
      {
        kind: 'relationship-notification',
        notificationId: notifications[1]?.notificationId,
        tenantId: TENANT_A,
        subject: WALL_ELEMENT_REF,
        affected: DOCUMENT_REF,
        relationshipKind: 'affects',
        sourceEvent: reference,
      },
    ]);
    // Full traceability: every record cites the SOURCE EVENT ID…
    for (const notification of notifications) {
      expect(notification.sourceEvent.eventId).toBe(modelEventIdOf(envelope));
      expect(notification.sourceEvent.eventName).toBe(ELEMENT_CHANGED_EVENT);
      expect(notification.tenantId).toBe(TENANT_A);
      expect(notification.notificationId).toMatch(/^office-mnt-v1-[0-9a-z]{32}$/);
    }
    // …with deterministic, DISTINCT notification ids per affected entity.
    expect(notifications[0]?.notificationId).not.toBe(notifications[1]?.notificationId);
  });

  it('derives notifications for the retirement event too (delete-of-version affects the links)', () => {
    const envelope = wallRetiredEnvelope(NOW_3, 'v3', [ACTIVITY_REF, DOCUMENT_REF]);
    const notifications = unwrap(notificationsOfModelEvent(envelope));
    expect(notifications.map((notification) => notification.affected.entityKind)).toStrictEqual([
      'activity',
      'document',
    ]);
    expect(notifications[0]?.sourceEvent.eventName).toBe(ELEMENT_RETIRED_EVENT);
    expect(notifications[0]?.sourceEvent.eventId).toBe(modelEventIdOf(envelope));
  });

  it('fails closed on non-element-mutation events and malformed payloads', () => {
    const element = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF], { value: 42.5, unit: 'm2' });
    const lifecycle = modelEventEnvelope({
      command: wallCommand('v1'),
      eventName: MODEL_REGISTERED_EVENT,
      occurredAt: NOW_1,
      entityRefs: { before: null, after: MODEL_REF },
      payload: {
        modelId: MODEL_REF.entityId,
        name: 'Tower A — structural model',
        discipline: discipline('structure'),
        provenance: {
          sourceKey: sourceRefKeyOf(wallSource('v1')),
          providerObjectId: TOWER_MODEL_ID,
          providerVersion: 'v1',
        },
      },
    });
    const lifecycleResult = notificationsOfModelEvent(lifecycle);
    expect(lifecycleResult.ok).toBe(false);
    if (!lifecycleResult.ok) {
      expect(lifecycleResult.error.details[0]?.code).toBe('model-event-not-element-mutation');
    }

    const foreignResult = notificationsOfModelEvent(nonModelsEnvelope(element));
    expect(foreignResult.ok).toBe(false);
    if (!foreignResult.ok) {
      expect(foreignResult.error.details[0]?.code).toBe('model-event-not-element-mutation');
    }

    const malformed: DomainEventEnvelope = {
      ...element,
      payload: { ...element.payload, affectedEntityRefs: [{ entityKind: 'activity' }] },
    };
    const malformedResult = notificationsOfModelEvent(malformed);
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) {
      expect(malformedResult.error.details[0]?.code).toBe('model-event-payload-missing-field');
    }
  });

  it('is deterministic: the same event derives the identical notifications', () => {
    const envelope = wallChangedEnvelope(NOW_2, 'v2', [ACTIVITY_REF, DOCUMENT_REF], { value: 42.5, unit: 'm2' });
    expect(unwrap(notificationsOfModelEvent(envelope))).toStrictEqual(
      unwrap(notificationsOfModelEvent(envelope)),
    );
    const id: ModelEventId = modelEventIdOf(envelope);
    expect(id).toBe(modelEventIdOf(envelope));
  });
});
