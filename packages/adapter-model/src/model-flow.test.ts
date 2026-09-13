import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEntityRef,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  createInMemoryConflictStore,
  createInMemorySourceMappingStore,
  createInMemorySyncCursorStore,
  providerObjectId,
  providerVersion,
  recordSourceMapping,
  sourceCoordinate,
  sourceCorrelationId,
  sourceRef,
  sourceRefKeyOf,
  syncIdempotencyKey,
} from '@office/adapters-sdk';
import type { AdapterAuthorization, SyncEngineDeps } from '@office/adapters-sdk';
import {
  ELEMENT_CHANGED_EVENT,
  ELEMENT_OBJECT_KIND,
  MODEL_ADAPTER_KIND,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_OBJECT_KIND,
  MODEL_VERSION_REGISTERED_EVENT,
  parseElementClassification,
  parseElementQuantity,
} from './vocabulary';
import {
  LINKED_ACTIVITY_REF,
  LINKED_DOCUMENT_REF,
  TOWER_MODEL_ID,
  TOWER_MODEL_V2_ID,
  WALL_ELEMENT_ID,
  createSeededModelProvider,
} from './provider-fixture';
import { elementChangedEnvelope, modelEventEnvelope } from './change-mapping';
import type { ElementChangedPayload } from './change-mapping';
import type { CommandEnvelope } from '@office/contracts';
import type { DomainEventEnvelope } from '@office/contracts';
import {
  modelEventIdOf,
  notificationsOfModelEvent,
  projectModelRelationships,
} from './notification';
import type { ModelRelationshipIndex, RelationshipNotification } from './notification';
import { resolveElementParentChain, resolveProviderLinks } from './references';
import { runModelSync } from './sync';

// OFF-022 adapter-model — THE named acceptance, end to end:
//
//   provider element mutation (the fixture's wall element, updated)
//     → ProviderSnapshot (the SDK's normalized observation, via runModelSync)
//     → canonical command proposal (models.recordElementChange)
//     → (THIS TEST executes it as the host would: resolving the element's
//        canonical identity, its model/version parent chain, and its linked
//        activity/document through the shared mapping store)
//     → the canonical `models.elementChanged` DomainEventEnvelope
//     → THE relationship projection (projectModelRelationships, typed against
//        the @office/intelligence-relationships vocabulary) derives the
//        expected edges — (element) affects (activity), (element) affects
//        (document), (element) derives-from (model version),
//        (model version) derives-from (model)
//     → the notification records (notificationsOfModelEvent) — one per
//        affected linked entity — each referencing the SOURCE EVENT ID with
//        the full causal chain back to the exact provider object version.
//
// The whole scenario is a pure function of injected state (fixed clock,
// sequential office-issued ids), and runs a SECOND time with fresh stores to
// prove run-twice determinism: identical proposals AND notifications.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-10-06T09:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-10-07T10:05:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `mdl${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));
const classification = () => unwrap(parseElementClassification('wall'));
const quantityOf = (value: number, unit: string) =>
  unwrap(parseElementQuantity({ value, unit }));

const AUTHORIZATION: AdapterAuthorization = {
  context: adapterAuthorizationContext({
    actorId: entity(90),
    scope: { kind: 'tenant', tenantId: TENANT_A },
    capabilities: ['models.write'],
  }),
  policy: { rules: [{ effect: 'allow', actorKinds: ['adapter'] }] },
};

const wallCoordinate = () =>
  sourceCoordinate({
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectType: ELEMENT_OBJECT_KIND,
    objectId: providerObjectId(WALL_ELEMENT_ID),
  });

const wallSourceRef = (providerObjectVersion: string) =>
  sourceRef({
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectType: ELEMENT_OBJECT_KIND,
    objectId: providerObjectId(WALL_ELEMENT_ID),
    version: providerVersion(providerObjectVersion),
  });

/** THE end-to-end scenario, as a pure function of injected state. */
const scenario = async (): Promise<{
  readonly firstSyncOutcomes: readonly { objectId: string; outcome: string }[];
  readonly updateSyncOutcomes: readonly { objectId: string; outcome: string }[];
  readonly proposedCommand: CommandEnvelope<unknown>;
  readonly canonicalEvent: DomainEventEnvelope<ElementChangedPayload>;
  readonly eventId: string;
  readonly projection: ModelRelationshipIndex;
  readonly notifications: readonly RelationshipNotification[];
}> => {
  const provider = createSeededModelProvider();

  // Deterministic engine state: fixed clock per phase, sequential ids.
  let nextId = 1;
  const canonicalVersions = new Map<string, AggregateVersion | null>();
  const deps: SyncEngineDeps = {
    mappings: createInMemorySourceMappingStore(),
    cursors: createInMemorySyncCursorStore(),
    conflicts: createInMemoryConflictStore(),
    canonicalVersionOf: async (tenantId, canonical) => {
      if (tenantId !== TENANT_A) return { ok: true as const, value: null };
      return { ok: true as const, value: canonicalVersions.get(canonical.entityId) ?? null };
    },
    now: () => NOW_1,
    nextCanonicalId: () => entity(nextId++),
  };

  // The linked entities (the wall's activity and document) were synced by
  // THEIR adapters into the SAME shared, tenant-scoped mapping store — the
  // office-side identities the element's provider link refs resolve to.
  const linked = [
    [LINKED_ACTIVITY_REF, ref('activity', entity(80))],
    [LINKED_DOCUMENT_REF, ref('document', entity(81))],
  ] as const;
  for (const [link, canonical] of linked) {
    unwrap(
      await recordSourceMapping({
        store: deps.mappings,
        tenantId: TENANT_A,
        coordinate: sourceCoordinate({
          adapterKind: link.adapterKind,
          systemId: link.systemId,
          objectType: link.objectType,
          objectId: providerObjectId(link.objectId),
        }),
        canonical,
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: AUTHORIZATION.context.actor,
        now: NOW_1,
      }),
    );
  }

  // ---- 1. THE INITIAL SYNC: the whole model hierarchy, parents first -----
  const first = unwrap(
    await runModelSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: MODEL_SYSTEM_ID,
        limit: 10,
      },
      deps,
    ),
  );
  const firstSyncOutcomes = first.streams.flatMap((stream) =>
    stream.applications.map((application) => ({
      objectId: application.snapshot.source.objectId,
      outcome: application.outcome,
    })),
  );

  // ---- 2. THE HOST EXECUTES the create proposals: the canonical models-area
  // aggregates now exist (the test stands in for the Action Gateway —
  // adapters never write canonical state).
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    canonicalVersions.set(entity(n), version(1));
  }

  // ---- 3. THE PROVIDER ELEMENT MUTATION: the wall element is updated -----
  provider.updateElement(WALL_ELEMENT_ID, {
    displayName: 'Wall 103 — grid B/5',
    data: {
      modelId: TOWER_MODEL_ID,
      modelVersionId: TOWER_MODEL_V2_ID,
      classification: 'wall',
      quantity: { value: 45.5, unit: 'm2' },
      linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    },
  });

  // ---- 4. THE NEXT SYNC OBSERVES IT: snapshot → command proposal ---------
  const second = unwrap(
    await runModelSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: MODEL_SYSTEM_ID,
        limit: 10,
      },
      deps,
    ),
  );
  const updateSyncOutcomes = second.streams.flatMap((stream) =>
    stream.applications.map((application) => ({
      objectId: application.snapshot.source.objectId,
      outcome: application.outcome,
    })),
  );
  // Exactly ONE command was proposed: the wall element's update.
  expect(second.commands).toHaveLength(1);
  const proposedCommand = second.commands[0];
  if (proposedCommand === undefined) throw new Error('expected the element update command');

  // ---- 5. THE HOST EXECUTES THE PROPOSAL as a canonical event ------------
  // (the test resolves everything the runtime would resolve: the element's
  // canonical identity, its model/version parent chain, and its linked
  // entities — ALL through the shared tenant-scoped mapping store.)
  const elementMapping = await deps.mappings.findByCoordinate(TENANT_A, wallCoordinate());
  if (elementMapping === null) throw new Error('expected the wall element mapping');
  const parents = unwrap(
    await resolveElementParentChain(deps.mappings, TENANT_A, {
      element: wallCoordinate(),
      modelVersionProviderObjectId: TOWER_MODEL_V2_ID,
      modelProviderObjectId: TOWER_MODEL_ID,
    }),
  );
  const affectedEntityRefs = unwrap(
    await resolveProviderLinks(deps.mappings, TENANT_A, [
      LINKED_ACTIVITY_REF,
      LINKED_DOCUMENT_REF,
    ]),
  );
  const canonicalEvent = elementChangedEnvelope({
    command: proposedCommand,
    occurredAt: NOW_3,
    element: elementMapping.canonical,
    modelVersion: parents.modelVersion,
    model: parents.model,
    classification: classification(),
    change: 'updated',
    displayName: 'Wall 103 — grid B/5',
    quantity: quantityOf(45.5, 'm2'),
    affectedEntityRefs,
    rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    providerObjectId: WALL_ELEMENT_ID,
    providerVersion: 'v2',
  });

  // The host also executed the v2 model-version registration from the first
  // sync (its canonical event joins the projection's input stream).
  const versionCommand = first.commands.find(
    (command) =>
      command.commandName === 'models.registerModelVersion' &&
      command.payload['modelVersionId'] === entity(3),
  );
  if (versionCommand === undefined) {
    throw new Error('expected the v2 model-version registration command');
  }
  const versionRegistered = modelEventEnvelope({
    command: versionCommand,
    eventName: MODEL_VERSION_REGISTERED_EVENT,
    occurredAt: NOW_3,
    entityRefs: { before: null, after: parents.modelVersion },
    payload: {
      modelId: parents.model.entityId,
      modelVersionId: parents.modelVersion.entityId,
      label: 'coordination-2026-10-05',
      provenance: {
        sourceKey: sourceRefKeyOf(
          sourceRef({
            adapterKind: MODEL_ADAPTER_KIND,
            systemId: MODEL_SYSTEM_ID,
            objectType: MODEL_VERSION_OBJECT_KIND,
            objectId: providerObjectId(TOWER_MODEL_V2_ID),
            version: providerVersion('v1'),
          }),
        ),
        providerObjectId: TOWER_MODEL_V2_ID,
        providerVersion: 'v1',
      },
    },
  });

  // ---- 6. THE RELATIONSHIP PROJECTION derives the expected edges ----------
  const projection = unwrap(projectModelRelationships([versionRegistered, canonicalEvent]));

  // ---- 7. THE AFFECTED-RELATIONSHIP NOTIFICATIONS ------------------------
  const notifications = unwrap(notificationsOfModelEvent(canonicalEvent));

  return {
    firstSyncOutcomes,
    updateSyncOutcomes,
    proposedCommand,
    canonicalEvent,
    eventId: modelEventIdOf(canonicalEvent),
    projection,
    notifications,
  };
};

describe('THE OFF-022 acceptance: element mutation → canonical event → affected-relationship notification', () => {
  it('runs the canonical flow end to end with full traceability', async () => {
    const world = await scenario();

    // ---- 1./4. the sync surface ------------------------------------------
    // The initial sync mapped the whole seeded world in hierarchy order.
    expect(world.firstSyncOutcomes).toStrictEqual([
      { objectId: 'm-tower-a', outcome: 'mapped-created' },
      { objectId: 'mv-tower-a-1', outcome: 'mapped-created' },
      { objectId: 'mv-tower-a-2', outcome: 'mapped-created' },
      { objectId: 'el-wall-103', outcome: 'mapped-created' },
      { objectId: 'el-column-21', outcome: 'mapped-created' },
      { objectId: 'cls-wall', outcome: 'mapped-created' },
      { objectId: 'cls-column', outcome: 'mapped-created' },
    ]);
    // The update sync proposed exactly the wall element's change; everything
    // else replayed as the idempotent no-op.
    expect(world.updateSyncOutcomes).toStrictEqual([
      { objectId: 'm-tower-a', outcome: 'replay-no-op' },
      { objectId: 'mv-tower-a-1', outcome: 'replay-no-op' },
      { objectId: 'mv-tower-a-2', outcome: 'replay-no-op' },
      { objectId: 'el-wall-103', outcome: 'applied-update' },
      { objectId: 'el-column-21', outcome: 'replay-no-op' },
      { objectId: 'cls-wall', outcome: 'replay-no-op' },
      { objectId: 'cls-column', outcome: 'replay-no-op' },
    ]);

    // ---- 4. the command proposal -----------------------------------------
    expect(world.proposedCommand.commandName).toBe('models.recordElementChange');
    expect(world.proposedCommand.payload).toMatchObject({
      elementId: entity(4),
      change: 'updated',
      displayName: 'Wall 103 — grid B/5',
      classification: 'wall',
      quantity: { value: 45.5, unit: 'm2' },
      modelProviderId: TOWER_MODEL_ID,
      modelVersionProviderId: TOWER_MODEL_V2_ID,
      linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
      expectedVersion: 1,
    });
    // A10: the element's canonical id is office-issued, never the provider's.
    expect((world.proposedCommand.payload as Record<string, unknown>)['elementId']).not.toContain(
      WALL_ELEMENT_ID,
    );

    // ---- 5. the canonical event ------------------------------------------
    expect(world.canonicalEvent.eventName).toBe(ELEMENT_CHANGED_EVENT);
    expect(world.canonicalEvent.eventName).toBe('models.elementChanged');
    // The event round-trips the contracts parser by construction.
    expect(parseDomainEventEnvelope(world.canonicalEvent).ok).toBe(true);
    // FULL TRACEABILITY — the causal chain of the event ties it to the exact
    // provider object version: the event's causation id IS the executed
    // command's idempotency key, which is the SourceRef-derived sync key of
    // the wall element at provider version v2.
    expect(world.canonicalEvent.causality.causationId).toBe(world.proposedCommand.idempotencyKey);
    expect(world.canonicalEvent.causality.causationId).toBe(syncIdempotencyKey(wallSourceRef('v2')));
    expect(world.canonicalEvent.causality.correlationId).toBe(sourceCorrelationId(wallCoordinate()));
    expect(world.canonicalEvent.payload.provenance).toStrictEqual({
      sourceKey: sourceRefKeyOf(wallSourceRef('v2')),
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v2',
      rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    });
    expect(world.canonicalEvent.payload.affectedEntityRefs).toStrictEqual([
      ref('activity', entity(80)),
      ref('document', entity(81)),
    ]);

    // ---- 6. THE relationship projection derives the expected edges --------
    expect(
      world.projection.relationships.map(
        (edge) => `${edge.kind}: ${edge.from.entityKind}:${edge.from.entityId.slice(-2)} → ${edge.to.entityKind}:${edge.to.entityId.slice(-2)}`,
      ),
    ).toStrictEqual([
      'affects: element:04 → activity:80',
      'affects: element:04 → document:81',
      'derives-from: element:04 → model-version:03',
      'derives-from: model-version:03 → model:01',
    ]);
    expect(world.projection.entities.map((node) => node.entity.entityKind)).toStrictEqual([
      'activity',
      'document',
      'element',
      'model',
      'model-version',
    ]);
    // The mutation's subject is incident to three edges: the two affected
    // links and its own derivation from the model version.
    expect(world.projection.relationshipsOf(ref('element', entity(4)))).toHaveLength(3);
    expect(world.projection.relationshipsOf(ref('model', entity(1)))).toHaveLength(1);

    // ---- 7. THE notification records reference the SOURCE EVENT ID -------
    expect(world.notifications).toHaveLength(2);
    for (const notification of world.notifications) {
      expect(notification.kind).toBe('relationship-notification');
      expect(notification.tenantId).toBe(TENANT_A);
      expect(notification.subject).toStrictEqual(ref('element', entity(4)));
      expect(notification.relationshipKind).toBe('affects');
      // FULL TRACEABILITY: the source event id is the deterministic id of the
      // EXACT canonical event envelope the host emitted.
      expect(notification.sourceEvent.eventId).toBe(world.eventId);
      expect(notification.sourceEvent.eventId).toBe(modelEventIdOf(world.canonicalEvent));
      expect(notification.sourceEvent.eventName).toBe('models.elementChanged');
      expect(notification.sourceEvent.occurredAt).toBe(NOW_3);
      // …and the causation id is the executed command's idempotency key —
      // traceable back to the exact provider object version that caused it.
      expect(notification.sourceEvent.causationId).toBe(world.proposedCommand.idempotencyKey);
      expect(notification.sourceEvent.causationId).toBe(syncIdempotencyKey(wallSourceRef('v2')));
      expect(notification.sourceEvent.correlationId).toBe(sourceCorrelationId(wallCoordinate()));
      expect(notification.sourceEvent.actor).toStrictEqual(world.canonicalEvent.actor);
      expect(notification.notificationId).toMatch(/^office-mnt-v1-[0-9a-z]{32}$/);
    }
    expect(world.notifications.map((notification) => notification.affected)).toStrictEqual([
      ref('activity', entity(80)),
      ref('document', entity(81)),
    ]);
    expect(world.notifications[0]?.notificationId).not.toBe(world.notifications[1]?.notificationId);
    // The event id format is the deterministic derivation's.
    expect(world.eventId).toMatch(/^office-mdev-v1-[0-9a-z]{32}$/);
    expect(unwrap(parseCausationId(world.proposedCommand.idempotencyKey))).toBe(
      world.proposedCommand.idempotencyKey,
    );
  });

  it('is fully deterministic: run-twice → identical proposals AND notifications', async () => {
    const first = await scenario();
    const second = await scenario();
    // The sync surface: identical applications across both runs.
    expect(second.firstSyncOutcomes).toStrictEqual(first.firstSyncOutcomes);
    expect(second.updateSyncOutcomes).toStrictEqual(first.updateSyncOutcomes);
    // The proposal: the identical command (name, idempotency key, payload).
    expect(second.proposedCommand).toStrictEqual(first.proposedCommand);
    // The canonical event: the identical envelope → the identical event id.
    expect(second.canonicalEvent).toStrictEqual(first.canonicalEvent);
    expect(second.eventId).toBe(first.eventId);
    // The projection: the identical edges (and their provenance references).
    expect(second.projection.relationships).toStrictEqual(first.projection.relationships);
    expect(second.projection.entities).toStrictEqual(first.projection.entities);
    expect(second.projection.derivation).toStrictEqual(first.projection.derivation);
    // THE notifications: the identical records, source event ids included.
    expect(second.notifications).toStrictEqual(first.notifications);
  });
});
