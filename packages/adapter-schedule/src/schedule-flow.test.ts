import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEntityRef,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  CommandEnvelope,
  DomainEventEnvelope,
  EntityRef,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  createInMemoryConflictStore,
  createInMemorySourceMappingStore,
  createInMemorySyncCursorStore,
  providerObjectId,
  providerVersion,
  sourceCoordinate,
  sourceCorrelationId,
  sourceRef,
  sourceRefKeyOf,
  syncIdempotencyKey,
} from '@office/adapters-sdk';
import type { AdapterAuthorization, AdapterJsonObject, SyncEngineDeps } from '@office/adapters-sdk';
import { ACTIVITY_OBJECT_KIND, SCHEDULE_ADAPTER_KIND, SCHEDULE_SYSTEM_ID, parseScheduleDate } from './vocabulary';
import type { ScheduleDate } from './vocabulary';
import {
  ENVELOPE_ACTIVITY_ID,
  FOUNDATIONS_ACTIVITY_ID,
  FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
  SEPTEMBER_BASELINE_ID,
  STRUCTURE_ACTIVITY_ID,
  STRUCTURE_ENVELOPE_DEPENDENCY_ID,
  TOWER_SCHEDULE_ID,
  createSeededScheduleProvider,
} from './provider-fixture';
import type { SeededScheduleProvider } from './provider-fixture';
import {
  activityAddedEnvelope,
  activityUpdatedEnvelope,
  baselineSetEnvelope,
  dependencyAddedEnvelope,
  parseActivityDependencyProviderData,
  parseActivityProviderData,
  parseBaselineProviderData,
  parseProjectScheduleProviderData,
  scheduleCreatedEnvelope,
} from './change-mapping';
import type { ActivityUpdatedPayload } from './change-mapping';
import {
  notificationsOfScheduleEvent,
  projectScheduleRelationships,
  scheduleEventIdOf,
} from './notification';
import type { RelationshipNotification, ScheduleRelationshipIndex } from './notification';
import { resolveDependencyEndpoints, resolveOwningSchedule, resolveScheduleObject } from './references';
import { runScheduleSync } from './sync';

// OFF-023 adapter-schedule — THE named acceptance, end to end:
//
//   provider activity update (the fixture's structure framing, dates moved)
//     → ProviderSnapshot (the SDK's normalized observation, via runScheduleSync)
//     → canonical command proposal (schedule.updateActivity)
//     → (THIS TEST executes it as the host would: resolving the activity's
//        canonical identity and its owning schedule through the shared
//        tenant-scoped mapping store)
//     → the canonical `schedule.activityUpdated` DomainEventEnvelope
//     → THE relationship projection (projectScheduleRelationships, typed
//        against the @office/intelligence-relationships vocabulary) derives
//        the expected affected edges — (activity) affects (each impacted
//        successor activity) and (activity) affects (the schedule's baseline)
//     → the notification records (notificationsOfScheduleEvent) — one per
//        impacted entity — each referencing the SOURCE EVENT ID with the
//        full causal chain back to the exact provider object version.
//
// The whole scenario is a pure function of injected state (fixed clock,
// sequential office-issued ids), and runs a SECOND time with fresh stores to
// prove run-twice determinism: identical proposals AND notifications.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-11-10T09:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-11-13T11:45:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `sch${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));
/** A fail-closed parsed ISO calendar date (the typed CPM date vocabulary). */
const date = (raw: string): ScheduleDate => unwrap(parseScheduleDate(raw));

const AUTHORIZATION: AdapterAuthorization = {
  context: adapterAuthorizationContext({
    actorId: entity(90),
    scope: { kind: 'tenant', tenantId: TENANT_A },
    capabilities: ['schedule.write'],
  }),
  policy: { rules: [{ effect: 'allow', actorKinds: ['adapter'] }] },
};

const coordinate = (objectType: string, objectId: string) =>
  sourceCoordinate({
    adapterKind: SCHEDULE_ADAPTER_KIND,
    systemId: SCHEDULE_SYSTEM_ID,
    objectType: objectType as never,
    objectId: providerObjectId(objectId),
  });

const structureSourceRef = (providerObjectVersion: string) =>
  sourceRef({
    adapterKind: SCHEDULE_ADAPTER_KIND,
    systemId: SCHEDULE_SYSTEM_ID,
    objectType: ACTIVITY_OBJECT_KIND,
    objectId: providerObjectId(STRUCTURE_ACTIVITY_ID),
    version: providerVersion(providerObjectVersion),
  });

/** The seeded fixture's provider payload for one object (fail-closed parsed). */
const dataOf = (provider: SeededScheduleProvider, objectId: string): AdapterJsonObject => {
  const object = provider.objects.find((entry) => entry.objectId === objectId);
  if (object === undefined) throw new Error(`expected provider object '${objectId}'`);
  return object.data;
};

/** THE end-to-end scenario, as a pure function of injected state. */
const scenario = async (): Promise<{
  readonly firstSyncOutcomes: readonly { objectId: string; outcome: string }[];
  readonly updateSyncOutcomes: readonly { objectId: string; outcome: string }[];
  readonly proposedCommand: CommandEnvelope<unknown>;
  readonly canonicalEvent: DomainEventEnvelope<ActivityUpdatedPayload>;
  readonly eventId: string;
  readonly projection: ScheduleRelationshipIndex;
  readonly notifications: readonly RelationshipNotification[];
}> => {
  const provider = createSeededScheduleProvider();

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
  const run = () =>
    runScheduleSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: SCHEDULE_SYSTEM_ID,
        limit: 10,
        divergenceView: provider.divergenceView,
      },
      deps,
    );

  // The seeded world's provider payloads (captured at v1, before the mutation).
  const scheduleData = unwrap(
    parseProjectScheduleProviderData(dataOf(provider, TOWER_SCHEDULE_ID)),
  );
  const foundationsData = unwrap(
    parseActivityProviderData(dataOf(provider, FOUNDATIONS_ACTIVITY_ID)),
  );
  const structureData = unwrap(
    parseActivityProviderData(dataOf(provider, STRUCTURE_ACTIVITY_ID)),
  );
  const envelopeData = unwrap(
    parseActivityProviderData(dataOf(provider, ENVELOPE_ACTIVITY_ID)),
  );
  const depOneData = unwrap(
    parseActivityDependencyProviderData(dataOf(provider, FOUNDATIONS_STRUCTURE_DEPENDENCY_ID)),
  );
  const depTwoData = unwrap(
    parseActivityDependencyProviderData(dataOf(provider, STRUCTURE_ENVELOPE_DEPENDENCY_ID)),
  );
  const baselineData = unwrap(
    parseBaselineProviderData(dataOf(provider, SEPTEMBER_BASELINE_ID)),
  );

  // ---- 1. THE INITIAL SYNC: the whole schedule hierarchy, parents first ---
  const first = unwrap(await run());
  const firstSyncOutcomes = first.streams.flatMap((stream) =>
    stream.applications.map((application) => ({
      objectId: application.snapshot.source.objectId,
      outcome: application.outcome,
    })),
  );

  // ---- 2. THE HOST EXECUTES the create proposals: the canonical schedules-
  // area aggregates now exist (the test stands in for the Action Gateway —
  // adapters never write canonical state).
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    canonicalVersions.set(entity(n), version(1));
  }

  // The canonical identities the host resolved through the SHARED, tenant-
  // scoped mapping store (A10: office-issued ids, never provider ids).
  const scheduleRef = await resolveScheduleObject(
    deps.mappings,
    TENANT_A,
    coordinate('project-schedule', TOWER_SCHEDULE_ID),
  );
  if (scheduleRef === null) throw new Error('expected the schedule mapping');
  const foundationsRef = await resolveScheduleObject(
    deps.mappings,
    TENANT_A,
    coordinate('activity', FOUNDATIONS_ACTIVITY_ID),
  );
  if (foundationsRef === null) throw new Error('expected the foundations mapping');
  const structureRef = await resolveScheduleObject(
    deps.mappings,
    TENANT_A,
    coordinate('activity', STRUCTURE_ACTIVITY_ID),
  );
  if (structureRef === null) throw new Error('expected the structure mapping');
  const envelopeRef = await resolveScheduleObject(
    deps.mappings,
    TENANT_A,
    coordinate('activity', ENVELOPE_ACTIVITY_ID),
  );
  if (envelopeRef === null) throw new Error('expected the envelope mapping');
  const depOneRef = await resolveScheduleObject(
    deps.mappings,
    TENANT_A,
    coordinate('activity-dependency', FOUNDATIONS_STRUCTURE_DEPENDENCY_ID),
  );
  if (depOneRef === null) throw new Error('expected the first dependency mapping');
  const depTwoRef = await resolveScheduleObject(
    deps.mappings,
    TENANT_A,
    coordinate('activity-dependency', STRUCTURE_ENVELOPE_DEPENDENCY_ID),
  );
  if (depTwoRef === null) throw new Error('expected the second dependency mapping');
  const baselineRef = await resolveScheduleObject(
    deps.mappings,
    TENANT_A,
    coordinate('baseline', SEPTEMBER_BASELINE_ID),
  );
  if (baselineRef === null) throw new Error('expected the baseline mapping');

  // The dependency endpoints, resolved as the host would (both sides).
  const depOneEndpoints = unwrap(
    await resolveDependencyEndpoints(deps.mappings, TENANT_A, {
      dependency: coordinate('activity-dependency', FOUNDATIONS_STRUCTURE_DEPENDENCY_ID),
      predecessorProviderObjectId: FOUNDATIONS_ACTIVITY_ID,
      successorProviderObjectId: STRUCTURE_ACTIVITY_ID,
    }),
  );
  const depTwoEndpoints = unwrap(
    await resolveDependencyEndpoints(deps.mappings, TENANT_A, {
      dependency: coordinate('activity-dependency', STRUCTURE_ENVELOPE_DEPENDENCY_ID),
      predecessorProviderObjectId: STRUCTURE_ACTIVITY_ID,
      successorProviderObjectId: ENVELOPE_ACTIVITY_ID,
    }),
  );

  // The first sync's proposed commands, matched to their provider objects.
  const commandOf = (commandName: string, payloadKey: string, payloadValue: string) => {
    const found = first.commands.find(
      (command) =>
        command.commandName === commandName &&
        (command.payload as Record<string, unknown>)[payloadKey] === payloadValue,
    );
    if (found === undefined) {
      throw new Error(`expected the ${commandName} command for ${payloadValue}`);
    }
    return found;
  };
  // The first sync's proposed commands, matched to their provider objects
  // (the createSchedule payload carries no canonical id of its own — it is
  // the project-schedule stream's single command).
  const scheduleCommand = first.commands.find(
    (command) => command.commandName === 'schedule.createSchedule',
  );
  if (scheduleCommand === undefined) {
    throw new Error('expected the schedule.createSchedule command');
  }
  const structureCommand = commandOf('schedule.addActivity', 'activityId', entity(3));

  // ---- 3. THE HOST EMITS the first sync's canonical events (the projection's
  // structural input stream — every envelope built from a REAL proposed
  // command, with identities resolved through the mapping store).
  const structuralEvents: readonly DomainEventEnvelope[] = [
    scheduleCreatedEnvelope({
      command: scheduleCommand,
      occurredAt: NOW_1,
      schedule: scheduleRef,
      name: scheduleData.name,
      providerObjectId: TOWER_SCHEDULE_ID,
      providerVersion: 'v1',
    }),
    activityAddedEnvelope({
      command: commandOf('schedule.addActivity', 'activityId', entity(2)),
      occurredAt: NOW_1,
      activity: foundationsRef,
      schedule: scheduleRef,
      code: foundationsData.code,
      name: foundationsData.name,
      plannedDuration: foundationsData.plannedDuration,
      parentActivity: null,
      plannedStart: foundationsData.plannedStart,
      plannedFinish: foundationsData.plannedFinish,
      providerObjectId: FOUNDATIONS_ACTIVITY_ID,
      providerVersion: 'v1',
    }),
    activityAddedEnvelope({
      command: structureCommand,
      occurredAt: NOW_1,
      activity: structureRef,
      schedule: scheduleRef,
      code: structureData.code,
      name: structureData.name,
      plannedDuration: structureData.plannedDuration,
      parentActivity: foundationsRef,
      plannedStart: structureData.plannedStart,
      plannedFinish: structureData.plannedFinish,
      providerObjectId: STRUCTURE_ACTIVITY_ID,
      providerVersion: 'v1',
    }),
    activityAddedEnvelope({
      command: commandOf('schedule.addActivity', 'activityId', entity(4)),
      occurredAt: NOW_1,
      activity: envelopeRef,
      schedule: scheduleRef,
      code: envelopeData.code,
      name: envelopeData.name,
      plannedDuration: envelopeData.plannedDuration,
      parentActivity: structureRef,
      plannedStart: envelopeData.plannedStart,
      plannedFinish: envelopeData.plannedFinish,
      providerObjectId: ENVELOPE_ACTIVITY_ID,
      providerVersion: 'v1',
    }),
    dependencyAddedEnvelope({
      command: commandOf('schedule.addDependency', 'dependencyId', entity(5)),
      occurredAt: NOW_1,
      dependency: depOneRef,
      schedule: scheduleRef,
      predecessor: depOneEndpoints.predecessor,
      successor: depOneEndpoints.successor,
      linkType: depOneData.linkType,
      lagDays: depOneData.lagDays,
      version: 1,
      providerObjectId: FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
      providerVersion: 'v1',
    }),
    dependencyAddedEnvelope({
      command: commandOf('schedule.addDependency', 'dependencyId', entity(6)),
      occurredAt: NOW_1,
      dependency: depTwoRef,
      schedule: scheduleRef,
      predecessor: depTwoEndpoints.predecessor,
      successor: depTwoEndpoints.successor,
      linkType: depTwoData.linkType,
      lagDays: depTwoData.lagDays,
      version: 1,
      providerObjectId: STRUCTURE_ENVELOPE_DEPENDENCY_ID,
      providerVersion: 'v1',
    }),
    baselineSetEnvelope({
      command: commandOf('schedule.setBaseline', 'baselineId', entity(7)),
      occurredAt: NOW_1,
      baseline: baselineRef,
      schedule: scheduleRef,
      label: baselineData.label,
      supersedes: null,
      providerObjectId: SEPTEMBER_BASELINE_ID,
      providerVersion: 'v1',
    }),
  ];

  // ---- 4. THE PROVIDER ACTIVITY MUTATION: the structure framing dates move
  provider.updateActivity(STRUCTURE_ACTIVITY_ID, {
    displayName: 'Structure framing',
    data: {
      scheduleId: TOWER_SCHEDULE_ID,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 38,
      parentActivityId: FOUNDATIONS_ACTIVITY_ID,
      plannedStart: '2026-09-24',
      plannedFinish: '2026-11-09',
    },
  });

  // ---- 5. THE NEXT SYNC OBSERVES IT: snapshot → command proposal ---------
  const second = unwrap(await run());
  const updateSyncOutcomes = second.streams.flatMap((stream) =>
    stream.applications.map((application) => ({
      objectId: application.snapshot.source.objectId,
      outcome: application.outcome,
    })),
  );
  // Exactly ONE command was proposed: the structure activity's date change.
  expect(second.commands).toHaveLength(1);
  const proposedCommand = second.commands[0];
  if (proposedCommand === undefined) throw new Error('expected the activity update command');
  expect(second.conflicts).toStrictEqual([]);

  // ---- 6. THE HOST EXECUTES THE PROPOSAL as the canonical event -----------
  // (the test resolves everything the runtime would resolve: the activity's
  // canonical identity and its owning schedule — through the shared
  // tenant-scoped mapping store.)
  const owningSchedule = unwrap(
    await resolveOwningSchedule(deps.mappings, TENANT_A, {
      referencing: coordinate('activity', STRUCTURE_ACTIVITY_ID),
      scheduleProviderObjectId: TOWER_SCHEDULE_ID,
    }),
  );
  const canonicalEvent = activityUpdatedEnvelope({
    command: proposedCommand,
    occurredAt: NOW_3,
    activity: structureRef,
    schedule: owningSchedule,
    code: 'A4020',
    name: 'Structure framing',
    plannedDuration: 38,
    plannedStart: date('2026-09-24'),
    plannedFinish: date('2026-11-09'),
    version: 2,
    providerObjectId: STRUCTURE_ACTIVITY_ID,
    providerVersion: 'v2',
  });

  // ---- 7. THE RELATIONSHIP PROJECTION derives the expected affected edges -
  const projection = unwrap(
    projectScheduleRelationships([...structuralEvents, canonicalEvent]),
  );

  // ---- 8. THE DOWNSTREAM IMPACT NOTIFICATIONS ------------------------------
  const notifications = unwrap(notificationsOfScheduleEvent(canonicalEvent, projection));

  return {
    firstSyncOutcomes,
    updateSyncOutcomes,
    proposedCommand,
    canonicalEvent,
    eventId: scheduleEventIdOf(canonicalEvent),
    projection,
    notifications,
  };
};

describe('THE OFF-023 acceptance: provider activity update → canonical schedule event → downstream impact notification', () => {
  it('runs the canonical flow end to end with full traceability', async () => {
    const world = await scenario();

    // ---- 1./5. the sync surface ------------------------------------------
    // The initial sync mapped the whole seeded world in hierarchy order.
    expect(world.firstSyncOutcomes).toStrictEqual([
      { objectId: TOWER_SCHEDULE_ID, outcome: 'mapped-created' },
      { objectId: FOUNDATIONS_ACTIVITY_ID, outcome: 'mapped-created' },
      { objectId: STRUCTURE_ACTIVITY_ID, outcome: 'mapped-created' },
      { objectId: ENVELOPE_ACTIVITY_ID, outcome: 'mapped-created' },
      { objectId: FOUNDATIONS_STRUCTURE_DEPENDENCY_ID, outcome: 'mapped-created' },
      { objectId: STRUCTURE_ENVELOPE_DEPENDENCY_ID, outcome: 'mapped-created' },
      { objectId: SEPTEMBER_BASELINE_ID, outcome: 'mapped-created' },
    ]);
    // The update sync proposed exactly the structure activity's date change;
    // everything else replayed as the idempotent no-op.
    expect(world.updateSyncOutcomes).toStrictEqual([
      { objectId: TOWER_SCHEDULE_ID, outcome: 'replay-no-op' },
      { objectId: FOUNDATIONS_ACTIVITY_ID, outcome: 'replay-no-op' },
      { objectId: STRUCTURE_ACTIVITY_ID, outcome: 'applied-update' },
      { objectId: ENVELOPE_ACTIVITY_ID, outcome: 'replay-no-op' },
      { objectId: FOUNDATIONS_STRUCTURE_DEPENDENCY_ID, outcome: 'replay-no-op' },
      { objectId: STRUCTURE_ENVELOPE_DEPENDENCY_ID, outcome: 'replay-no-op' },
      { objectId: SEPTEMBER_BASELINE_ID, outcome: 'replay-no-op' },
    ]);

    // ---- 5. the command proposal -----------------------------------------
    expect(world.proposedCommand.commandName).toBe('schedule.updateActivity');
    expect(world.proposedCommand.payload).toMatchObject({
      activityId: entity(3),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 38,
      plannedStart: '2026-09-24',
      plannedFinish: '2026-11-09',
      expectedVersion: 1,
    });
    // A10: the activity's canonical id is office-issued, never the provider's.
    expect((world.proposedCommand.payload as Record<string, unknown>)['activityId']).not.toContain(
      STRUCTURE_ACTIVITY_ID,
    );

    // ---- 6. the canonical event ------------------------------------------
    expect(world.canonicalEvent.eventName).toBe('schedule.activityUpdated');
    // The event round-trips the contracts parser by construction.
    expect(parseDomainEventEnvelope(world.canonicalEvent).ok).toBe(true);
    expect(world.canonicalEvent.entityRefs).toStrictEqual({
      before: ref('activity', entity(3)),
      after: ref('activity', entity(3)),
    });
    // FULL TRACEABILITY — the causal chain of the event ties it to the exact
    // provider object version: the event's causation id IS the executed
    // command's idempotency key, which is the SourceRef-derived sync key of
    // the structure activity at provider version v2.
    expect(world.canonicalEvent.causality.causationId).toBe(world.proposedCommand.idempotencyKey);
    expect(world.canonicalEvent.causality.causationId).toBe(
      syncIdempotencyKey(structureSourceRef('v2')),
    );
    expect(world.canonicalEvent.causality.correlationId).toBe(
      sourceCorrelationId(coordinate('activity', STRUCTURE_ACTIVITY_ID)),
    );
    expect(world.canonicalEvent.payload.provenance).toStrictEqual({
      sourceKey: sourceRefKeyOf(structureSourceRef('v2')),
      providerObjectId: STRUCTURE_ACTIVITY_ID,
      providerVersion: 'v2',
    });

    // ---- 7. THE relationship projection derives the expected edges --------
    // The structural network, plus THE impact edges derived at the update
    // event: (structure) affects (its impacted successor activity) and
    // (structure) affects (the schedule's baseline).
    expect(
      world.projection.relationships.map(
        (edge) =>
          `${edge.kind}: ${edge.from.entityKind}:${edge.from.entityId.slice(-1)} → ${edge.to.entityKind}:${edge.to.entityId.slice(-1)}`,
      ),
    ).toStrictEqual([
      'affects: activity:3 → activity:4', // the impacted successor activity
      'affects: activity:3 → baseline:7', // the schedule's baseline
      'depends-on: activity:3 → activity:2',
      'depends-on: activity:4 → activity:3',
      'derives-from: activity:2 → schedule:1',
      'derives-from: activity:3 → activity:2',
      'derives-from: activity:3 → schedule:1',
      'derives-from: activity:4 → activity:3',
      'derives-from: activity:4 → schedule:1',
      'derives-from: baseline:7 → schedule:1',
    ]);
    // The changed activity is incident to seven edges: the two impact edges,
    // its two derivation edges, the two depends-on edges it anchors, and the
    // envelope activity's WBS derivation from it.
    expect(world.projection.relationshipsOf(ref('activity', entity(3)))).toHaveLength(7);

    // ---- 8. THE notification records reference the SOURCE EVENT ID -------
    expect(world.notifications).toHaveLength(2);
    for (const notification of world.notifications) {
      expect(notification.kind).toBe('relationship-notification');
      expect(notification.tenantId).toBe(TENANT_A);
      expect(notification.subject).toStrictEqual(ref('activity', entity(3)));
      expect(notification.relationshipKind).toBe('affects');
      // FULL TRACEABILITY: the source event id is the deterministic id of the
      // EXACT canonical event envelope the host emitted.
      expect(notification.sourceEvent.eventId).toBe(world.eventId);
      expect(notification.sourceEvent.eventId).toBe(scheduleEventIdOf(world.canonicalEvent));
      expect(notification.sourceEvent.eventName).toBe('schedule.activityUpdated');
      expect(notification.sourceEvent.occurredAt).toBe(NOW_3);
      // …and the causation id is the executed command's idempotency key —
      // traceable back to the exact provider object version that caused it.
      expect(notification.sourceEvent.causationId).toBe(world.proposedCommand.idempotencyKey);
      expect(notification.sourceEvent.causationId).toBe(syncIdempotencyKey(structureSourceRef('v2')));
      expect(notification.sourceEvent.correlationId).toBe(
        sourceCorrelationId(coordinate('activity', STRUCTURE_ACTIVITY_ID)),
      );
      expect(notification.sourceEvent.actor).toStrictEqual(world.canonicalEvent.actor);
      expect(notification.notificationId).toMatch(/^office-scnt-v1-[0-9a-z]{32}$/u);
    }
    // One notification per impacted entity: the successor activity and the
    // baseline, in canonical entity order.
    expect(world.notifications.map((notification) => notification.impacted)).toStrictEqual([
      ref('activity', entity(4)),
      ref('baseline', entity(7)),
    ]);
    expect(world.notifications[0]?.notificationId).not.toBe(world.notifications[1]?.notificationId);
    // The event id format is the deterministic derivation's.
    expect(world.eventId).toMatch(/^office-schev-v1-[0-9a-z]{32}$/u);
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
