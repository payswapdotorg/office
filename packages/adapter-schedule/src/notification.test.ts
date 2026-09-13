import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseDomainEventEnvelope,
  parseEntityRef,
  parseEventName,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import {
  adapterAuthorizationContext,
  adapterCommandEnvelope,
  providerObjectId,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
  sourceCorrelationId,
  sourceCoordinate,
  syncIdempotencyKey,
} from '@office/adapters-sdk';
import type { AdapterJsonObject } from '@office/adapters-sdk';
import {
  ACTIVITY_OBJECT_KIND,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
  CREATE_SCHEDULE_COMMAND,
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  REMOVE_DEPENDENCY_COMMAND,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  parseScheduleDate,
} from './vocabulary';
import type { ScheduleDate } from './vocabulary';
import {
  TOWER_SCHEDULE_ID,
  FOUNDATIONS_ACTIVITY_ID,
  STRUCTURE_ACTIVITY_ID,
  ENVELOPE_ACTIVITY_ID,
  FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
  STRUCTURE_ENVELOPE_DEPENDENCY_ID,
  SEPTEMBER_BASELINE_ID,
} from './provider-fixture';
import {
  activityAddedEnvelope,
  activityUpdatedEnvelope,
  baselineSetEnvelope,
  dependencyAddedEnvelope,
  dependencyRemovedEnvelope,
  scheduleCreatedEnvelope,
} from './change-mapping';
import type { DomainEventEnvelope } from '@office/contracts';
import {
  edgesOfScheduleEvent,
  impactedEntitiesOfActivity,
  isScheduleEventId,
  notificationsOfScheduleEvent,
  parseScheduleEventId,
  projectScheduleRelationships,
  scheduleEventIdOf,
  scheduleEventReferenceOf,
} from './notification';
import type { RelationshipNotification, ScheduleRelationshipIndex } from './notification';

// OFF-023 adapter-schedule — THE downstream impact-notification flow: the
// deterministic source-event-id derivation, the relationship projection (the
// structural schedule network + THE impact edges derived at every activity
// update), the impacted-entity derivation, and the notification records —
// each referencing the source event id with full causality.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-11-10T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-11-12T10:30:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-11-13T11:45:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `sch${String(n).padStart(13, '0')}` });
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));
/** A fail-closed parsed ISO calendar date (the typed CPM date vocabulary). */
const date = (raw: string): ScheduleDate => unwrap(parseScheduleDate(raw));
/** The event at `index`, loudly (a missing fixture event is a test defect). */
const eventAt = (
  events: readonly DomainEventEnvelope[],
  index: number,
): DomainEventEnvelope => {
  const event = events[index];
  if (event === undefined) throw new Error(`expected the event at index ${index}`);
  return event;
};

const CONTEXT = adapterAuthorizationContext({
  actorId: entity(90),
  scope: { kind: 'tenant', tenantId: TENANT_A },
  capabilities: ['schedule.write'],
});

const SCHEDULE_REF = ref('schedule', entity(1));
const FOUNDATIONS_REF = ref('activity', entity(2));
const STRUCTURE_REF = ref('activity', entity(3));
const ENVELOPE_REF = ref('activity', entity(4));
const DEP_1_REF = ref('dependency', entity(5));
const DEP_2_REF = ref('dependency', entity(6));
const BASELINE_REF = ref('baseline', entity(7));

const sourceOf = (objectType: string, objectId: string, objectVersion: string) =>
  sourceRef({
    adapterKind: SCHEDULE_ADAPTER_KIND,
    systemId: SCHEDULE_SYSTEM_ID,
    objectType: objectType as never,
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

const commandOf = (
  commandName: typeof CREATE_SCHEDULE_COMMAND,
  objectType: string,
  objectId: string,
  objectVersion: string,
  payload: AdapterJsonObject,
) =>
  adapterCommandEnvelope({
    proposal: { commandName, payload },
    context: CONTEXT,
    source: sourceOf(objectType, objectId, objectVersion),
    causationId: null,
    now: NOW_1,
  });

/** THE canonical event stream of the seeded world, executed by the host. */
const structuralEvents = (): readonly DomainEventEnvelope[] => [
  scheduleCreatedEnvelope({
    command: commandOf(CREATE_SCHEDULE_COMMAND, 'project-schedule', TOWER_SCHEDULE_ID, 'v1', {
      name: 'Tower A — master schedule',
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('project-schedule', TOWER_SCHEDULE_ID, 'v1')) },
    }),
    occurredAt: NOW_1,
    schedule: SCHEDULE_REF,
    name: 'Tower A — master schedule',
    providerObjectId: TOWER_SCHEDULE_ID,
    providerVersion: 'v1',
  }),
  activityAddedEnvelope({
    command: commandOf(ADD_ACTIVITY_COMMAND, 'activity', FOUNDATIONS_ACTIVITY_ID, 'v1', {
      activityId: entity(2),
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity', FOUNDATIONS_ACTIVITY_ID, 'v1')) },
    }),
    occurredAt: NOW_1,
    activity: FOUNDATIONS_REF,
    schedule: SCHEDULE_REF,
    code: 'A4010',
    name: 'Foundations',
    plannedDuration: 20,
    parentActivity: null,
    plannedStart: date('2026-09-01'),
    plannedFinish: date('2026-09-18'),
    providerObjectId: FOUNDATIONS_ACTIVITY_ID,
    providerVersion: 'v1',
  }),
  activityAddedEnvelope({
    command: commandOf(ADD_ACTIVITY_COMMAND, 'activity', STRUCTURE_ACTIVITY_ID, 'v1', {
      activityId: entity(3),
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity', STRUCTURE_ACTIVITY_ID, 'v1')) },
    }),
    occurredAt: NOW_1,
    activity: STRUCTURE_REF,
    schedule: SCHEDULE_REF,
    code: 'A4020',
    name: 'Structure framing',
    plannedDuration: 35,
    parentActivity: FOUNDATIONS_REF,
    plannedStart: date('2026-09-21'),
    plannedFinish: date('2026-11-04'),
    providerObjectId: STRUCTURE_ACTIVITY_ID,
    providerVersion: 'v1',
  }),
  activityAddedEnvelope({
    command: commandOf(ADD_ACTIVITY_COMMAND, 'activity', ENVELOPE_ACTIVITY_ID, 'v1', {
      activityId: entity(4),
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity', ENVELOPE_ACTIVITY_ID, 'v1')) },
    }),
    occurredAt: NOW_1,
    activity: ENVELOPE_REF,
    schedule: SCHEDULE_REF,
    code: 'A4030',
    name: 'Envelope',
    plannedDuration: 25,
    parentActivity: STRUCTURE_REF,
    plannedStart: date('2026-11-09'),
    plannedFinish: date('2026-12-11'),
    providerObjectId: ENVELOPE_ACTIVITY_ID,
    providerVersion: 'v1',
  }),
  dependencyAddedEnvelope({
    command: commandOf(ADD_DEPENDENCY_COMMAND, 'activity-dependency', FOUNDATIONS_STRUCTURE_DEPENDENCY_ID, 'v1', {
      dependencyId: entity(5),
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity-dependency', FOUNDATIONS_STRUCTURE_DEPENDENCY_ID, 'v1')) },
    }),
    occurredAt: NOW_1,
    dependency: DEP_1_REF,
    schedule: SCHEDULE_REF,
    predecessor: FOUNDATIONS_REF,
    successor: STRUCTURE_REF,
    linkType: 'fs',
    lagDays: 0,
    version: 1,
    providerObjectId: FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
    providerVersion: 'v1',
  }),
  dependencyAddedEnvelope({
    command: commandOf(ADD_DEPENDENCY_COMMAND, 'activity-dependency', STRUCTURE_ENVELOPE_DEPENDENCY_ID, 'v1', {
      dependencyId: entity(6),
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity-dependency', STRUCTURE_ENVELOPE_DEPENDENCY_ID, 'v1')) },
    }),
    occurredAt: NOW_1,
    dependency: DEP_2_REF,
    schedule: SCHEDULE_REF,
    predecessor: STRUCTURE_REF,
    successor: ENVELOPE_REF,
    linkType: 'fs',
    lagDays: 3,
    version: 1,
    providerObjectId: STRUCTURE_ENVELOPE_DEPENDENCY_ID,
    providerVersion: 'v1',
  }),
  baselineSetEnvelope({
    command: commandOf(SET_BASELINE_COMMAND, 'baseline', SEPTEMBER_BASELINE_ID, 'v1', {
      baselineId: entity(7),
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('baseline', SEPTEMBER_BASELINE_ID, 'v1')) },
    }),
    occurredAt: NOW_1,
    baseline: BASELINE_REF,
    schedule: SCHEDULE_REF,
    label: 'baseline-2026-09-01',
    supersedes: null,
    providerObjectId: SEPTEMBER_BASELINE_ID,
    providerVersion: 'v1',
  }),
];

/** THE activity-update event of the canonical flow (the structure dates moved). */
const activityUpdated = (): DomainEventEnvelope =>
  activityUpdatedEnvelope({
    command: commandOf(UPDATE_ACTIVITY_COMMAND, 'activity', STRUCTURE_ACTIVITY_ID, 'v2', {
      activityId: entity(3),
      expectedVersion: 1,
      extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity', STRUCTURE_ACTIVITY_ID, 'v2')) },
    }),
    occurredAt: NOW_2,
    activity: STRUCTURE_REF,
    schedule: SCHEDULE_REF,
    code: 'A4020',
    name: 'Structure framing',
    plannedDuration: 38,
    plannedStart: date('2026-09-24'),
    plannedFinish: date('2026-11-09'),
    version: 2,
    providerObjectId: STRUCTURE_ACTIVITY_ID,
    providerVersion: 'v2',
  });

describe('the source event id derivation (deterministic, sha256 over the envelope)', () => {
  it('derives stable prefixed ids and rejects foreign shapes', () => {
    const event = activityUpdated();
    const eventId = scheduleEventIdOf(event);
    expect(eventId).toMatch(/^office-schev-v1-[0-9a-z]{32}$/u);
    expect(isScheduleEventId(eventId)).toBe(true);
    expect(unwrap(parseScheduleEventId(eventId))).toBe(eventId);
    expect(parseScheduleEventId('office-schev-v1-UPPER').ok).toBe(false);
    expect(parseScheduleEventId('office-mdev-v1-0123456789abcdef0123456789abcdef').ok).toBe(false);
    expect(parseScheduleEventId(null).ok).toBe(false);
  });

  it('distinguishes envelopes by every canonical field (payload included)', () => {
    const event = activityUpdated();
    expect(scheduleEventIdOf(event)).toBe(scheduleEventIdOf(activityUpdated()));
    const otherOccurrence = activityUpdatedEnvelope({
      command: commandOf(UPDATE_ACTIVITY_COMMAND, 'activity', STRUCTURE_ACTIVITY_ID, 'v2', {
        activityId: entity(3),
        expectedVersion: 1,
        extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity', STRUCTURE_ACTIVITY_ID, 'v2')) },
      }),
      occurredAt: NOW_3, // a different execution instant: a different event
      activity: STRUCTURE_REF,
      schedule: SCHEDULE_REF,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 38,
      plannedStart: date('2026-09-24'),
      plannedFinish: date('2026-11-09'),
      version: 2,
      providerObjectId: STRUCTURE_ACTIVITY_ID,
      providerVersion: 'v2',
    });
    expect(scheduleEventIdOf(otherOccurrence)).not.toBe(scheduleEventIdOf(event));
    // The reference carries the full causality of the source event.
    const reference = scheduleEventReferenceOf(event);
    expect(reference.eventId).toBe(scheduleEventIdOf(event));
    expect(reference.eventName).toBe('schedule.activityUpdated');
    expect(reference.occurredAt).toBe(NOW_2);
    expect(reference.correlationId).toBe(
      sourceCorrelationId(
        sourceCoordinate({
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: ACTIVITY_OBJECT_KIND,
          objectId: providerObjectId(STRUCTURE_ACTIVITY_ID),
        }),
      ),
    );
    expect(reference.causationId).toBe(
      syncIdempotencyKey(sourceOf('activity', STRUCTURE_ACTIVITY_ID, 'v2')),
    );
    expect(reference.actor).toStrictEqual(event.actor);
  });
});

describe('the relationship projection (structural network + THE impact edges)', () => {
  it('derives the structural edges of each event kind', () => {
    const events = structuralEvents();
    for (const event of events) {
      const edges = unwrap(edgesOfScheduleEvent(event));
      expect(Array.isArray(edges)).toBe(true);
    }
    // A top-level activity (no parent) asserts only its schedule edge; the
    // WBS child asserts BOTH its schedule edge and its parent-activity edge.
    const topLevel = unwrap(edgesOfScheduleEvent(eventAt(events, 1)));
    expect(topLevel.map((edge) => `${edge.kind}: ${edge.from.entityKind} → ${edge.to.entityKind}`)).toStrictEqual([
      'derives-from: activity → schedule',
    ]);
    const added = unwrap(edgesOfScheduleEvent(eventAt(events, 2)));
    expect(added.map((edge) => `${edge.kind}: ${edge.from.entityKind} → ${edge.to.entityKind}`)).toStrictEqual([
      'derives-from: activity → schedule',
      'derives-from: activity → activity',
    ]);
    const dependency = unwrap(edgesOfScheduleEvent(eventAt(events, 4)));
    expect(dependency.map((edge) => `${edge.kind}: ${edge.from.entityId.slice(-1)} → ${edge.to.entityId.slice(-1)}`)).toStrictEqual([
      'depends-on: 3 → 2', // structure (successor) depends-on foundations (predecessor)
    ]);
    const secondDependency = unwrap(edgesOfScheduleEvent(eventAt(events, 5)));
    expect(secondDependency.map((edge) => `${edge.kind}: ${edge.from.entityId.slice(-1)} → ${edge.to.entityId.slice(-1)}`)).toStrictEqual([
      'depends-on: 4 → 3', // envelope (successor) depends-on structure (predecessor)
    ]);
    const baseline = unwrap(edgesOfScheduleEvent(eventAt(events, 6)));
    expect(baseline.map((edge) => `${edge.kind}: ${edge.from.entityKind} → ${edge.to.entityKind}`)).toStrictEqual([
      'derives-from: baseline → schedule',
    ]);
    // The update event asserts no PERSISTENT edge (its impact edges are
    // derived by the fold with graph context).
    expect(unwrap(edgesOfScheduleEvent(activityUpdated()))).toStrictEqual([]);
  });

  it('folds the seeded world into the schedule network (deterministic order)', () => {
    const index = unwrap(projectScheduleRelationships(structuralEvents()));
    expect(
      index.relationships.map(
        (edge) =>
          `${edge.kind}: ${edge.from.entityKind}:${edge.from.entityId.slice(-1)} → ${edge.to.entityKind}:${edge.to.entityId.slice(-1)}`,
      ),
    ).toStrictEqual([
      'depends-on: activity:3 → activity:2', // structure depends-on foundations
      'depends-on: activity:4 → activity:3', // envelope depends-on structure
      'derives-from: activity:2 → schedule:1', // foundations: top-level (no parent)
      'derives-from: activity:3 → activity:2', // structure: WBS child of foundations
      'derives-from: activity:3 → schedule:1',
      'derives-from: activity:4 → activity:3', // envelope: WBS child of structure
      'derives-from: activity:4 → schedule:1',
      'derives-from: baseline:7 → schedule:1',
    ]);
    expect(index.entities.map((node) => node.entity.entityKind)).toStrictEqual([
      'activity',
      'activity',
      'activity',
      'baseline',
      'dependency',
      'dependency',
      'schedule',
    ]);
    expect(index.derivation.projectedEventCount).toBe(7);
    expect(index.derivation.relationshipCount).toBe(8);
    expect(index.derivation.recognizedEventNames).toStrictEqual([
      { eventName: 'schedule.activityAdded', count: 3 },
      { eventName: 'schedule.baselineSet', count: 1 },
      { eventName: 'schedule.dependencyAdded', count: 2 },
      { eventName: 'schedule.scheduleCreated', count: 1 },
    ]);
    expect(index.derivation.skippedEventNames).toStrictEqual([]);
    // Incidence: the structure activity is incident to five edges.
    expect(index.relationshipsOf(STRUCTURE_REF)).toHaveLength(5);
  });

  it('skips non-schedules events deterministically and fails closed on malformed payloads', () => {
    const foreign = {
      kind: 'event',
      eventName: unwrap(parseEventName('models.elementChanged')),
      scope: { kind: 'tenant', tenantId: TENANT_A },
      actor: { kind: 'adapter', actorId: entity(90) },
      source: 'domain',
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      schemaVersion: '1.0.0',
      occurredAt: NOW_1,
      entityRefs: { before: null, after: STRUCTURE_REF },
      payload: {},
    } as unknown as DomainEventEnvelope;
    expect(parseDomainEventEnvelope(foreign).ok).toBe(true);
    const index = unwrap(projectScheduleRelationships([foreign]));
    expect(index.relationships).toStrictEqual([]);
    expect(index.derivation.skippedEventNames).toStrictEqual([
      { eventName: 'models.elementChanged', count: 1 },
    ]);

    const malformed = { ...activityUpdated(), payload: { nope: true } } as DomainEventEnvelope;
    const result = projectScheduleRelationships([malformed]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-event-payload-unknown-field');
    }
  });

  it('retracts the depends-on edge on dependency removal', () => {
    const removal = dependencyRemovedEnvelope({
      command: commandOf(REMOVE_DEPENDENCY_COMMAND, 'activity-dependency', STRUCTURE_ENVELOPE_DEPENDENCY_ID, 'v2', {
        dependencyId: entity(6),
        expectedVersion: 1,
        extensionMetadata: { sourceKey: sourceRefKeyOf(sourceOf('activity-dependency', STRUCTURE_ENVELOPE_DEPENDENCY_ID, 'v2')) },
      }),
      occurredAt: NOW_3,
      dependency: DEP_2_REF,
      schedule: SCHEDULE_REF,
      predecessor: STRUCTURE_REF,
      successor: ENVELOPE_REF,
      linkType: 'fs',
      version: 1,
      providerObjectId: STRUCTURE_ENVELOPE_DEPENDENCY_ID,
      providerVersion: 'v2',
    });
    const before = unwrap(projectScheduleRelationships(structuralEvents()));
    const after = unwrap(projectScheduleRelationships([...structuralEvents(), removal]));
    expect(after.relationships).toHaveLength(before.relationships.length - 1);
    expect(
      after.relationships.some(
        (edge) => edge.kind === 'depends-on' && edge.from.entityId === entity(4),
      ),
    ).toBe(false);
  });
});

describe('THE impact derivation (impacted successors + the baseline)', () => {
  it('derives the impacted set from the projection network', () => {
    const index = unwrap(projectScheduleRelationships(structuralEvents()));
    const impacted = impactedEntitiesOfActivity(STRUCTURE_REF, SCHEDULE_REF, index);
    // The envelope activity depends-on the structure activity (the successor),
    // and the September baseline derives-from the schedule (the baseline).
    expect(impacted).toStrictEqual([ENVELOPE_REF, BASELINE_REF]);
    // Foundations has the structure activity as its impacted successor too
    // (structure depends-on foundations), and the baseline is still impacted.
    expect(impactedEntitiesOfActivity(FOUNDATIONS_REF, SCHEDULE_REF, index)).toStrictEqual([
      STRUCTURE_REF,
      BASELINE_REF,
    ]);
  });

  it('derives THE impact edges at the activity-update event in the fold', () => {
    const index = unwrap(
      projectScheduleRelationships([...structuralEvents(), activityUpdated()]),
    );
    const impactEdges = index.relationships
      .filter((edge) => edge.kind === 'affects')
      .map((edge) => `${edge.kind}: ${edge.from.entityKind}:${edge.from.entityId.slice(-1)} → ${edge.to.entityKind}:${edge.to.entityId.slice(-1)}`);
    expect(impactEdges).toStrictEqual([
      'affects: activity:3 → activity:4', // the impacted successor
      'affects: activity:3 → baseline:7', // the schedule's baseline
    ]);
    // Each impact edge's provenance is THE update event.
    const updateEvent = activityUpdated();
    for (const edge of index.relationships.filter((edge) => edge.kind === 'affects')) {
      expect(edge.sourceEvent.eventId).toBe(scheduleEventIdOf(updateEvent));
    }
    expect(index.derivation.recognizedEventNames).toContainEqual({
      eventName: 'schedule.activityUpdated',
      count: 1,
    });
  });
});

describe('THE impact notifications (each referencing the source event id)', () => {
  it('emits one notification per impacted entity with full traceability', () => {
    const index = unwrap(
      projectScheduleRelationships([...structuralEvents(), activityUpdated()]),
    );
    const event = activityUpdated();
    const notifications = unwrap(notificationsOfScheduleEvent(event, index));
    expect(notifications).toHaveLength(2);
    for (const notification of notifications) {
      expect(notification.kind).toBe('relationship-notification');
      expect(notification.tenantId).toBe(TENANT_A);
      expect(notification.subject).toStrictEqual(STRUCTURE_REF);
      expect(notification.relationshipKind).toBe('affects');
      // FULL TRACEABILITY: the source event id is the deterministic id of the
      // EXACT canonical event envelope the host emitted.
      expect(notification.sourceEvent.eventId).toBe(scheduleEventIdOf(event));
      expect(notification.sourceEvent.eventName).toBe('schedule.activityUpdated');
      expect(notification.sourceEvent.occurredAt).toBe(NOW_2);
      expect(notification.sourceEvent.causationId).toBe(
        syncIdempotencyKey(sourceOf('activity', STRUCTURE_ACTIVITY_ID, 'v2')),
      );
      expect(notification.sourceEvent.correlationId).toBe(
        sourceCorrelationId(
          sourceCoordinate({
            adapterKind: SCHEDULE_ADAPTER_KIND,
            systemId: SCHEDULE_SYSTEM_ID,
            objectType: ACTIVITY_OBJECT_KIND,
            objectId: providerObjectId(STRUCTURE_ACTIVITY_ID),
          }),
        ),
      );
      expect(notification.notificationId).toMatch(/^office-scnt-v1-[0-9a-z]{32}$/u);
    }
    expect(notifications.map((notification) => notification.impacted)).toStrictEqual([
      ENVELOPE_REF,
      BASELINE_REF,
    ]);
    expect(notifications[0]?.notificationId).not.toBe(notifications[1]?.notificationId);
  });

  it('fails closed on non-activity-change events (typed invariant)', () => {
    const index = unwrap(projectScheduleRelationships(structuralEvents()));
    const scheduleCreated = structuralEvents()[0];
    if (scheduleCreated === undefined) throw new Error('expected the schedule-created event');
    const result = notificationsOfScheduleEvent(scheduleCreated, index);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-event-not-activity-change');
    }
  });

  it('is fully deterministic: run-twice → identical projections AND notifications', () => {
    const run = (): {
      readonly relationships: unknown;
      readonly notifications: readonly RelationshipNotification[];
      readonly derivation: unknown;
    } => {
      const index: ScheduleRelationshipIndex = unwrap(
        projectScheduleRelationships([...structuralEvents(), activityUpdated()]),
      );
      return {
        relationships: index.relationships,
        notifications: unwrap(notificationsOfScheduleEvent(activityUpdated(), index)),
        derivation: index.derivation,
      };
    };
    expect(run()).toStrictEqual(run());
  });
});
