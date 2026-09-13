import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  formatEntityId,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEntityRef,
  parseEventName,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  adapterCommandEnvelope,
  providerObjectId,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
} from '@office/adapters-sdk';
import type { AdapterCommandInput, AdapterJsonObject } from '@office/adapters-sdk';
import {
  ACTIVITY_OBJECT_KIND,
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
  PROJECT_SCHEDULE_OBJECT_KIND,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
  CREATE_SCHEDULE_COMMAND,
  ADD_ACTIVITY_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  REMOVE_DEPENDENCY_COMMAND,
  SET_BASELINE_COMMAND,
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_UPDATED_EVENT,
  BASELINE_SET_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  SCHEDULE_CREATED_EVENT,
  parseScheduleDate,
} from './vocabulary';
import type { ScheduleDate } from './vocabulary';
import {
  TOWER_SCHEDULE_ID,
  FOUNDATIONS_ACTIVITY_ID,
  STRUCTURE_ACTIVITY_ID,
  ENVELOPE_ACTIVITY_ID,
  FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
  SEPTEMBER_BASELINE_ID,
} from './provider-fixture';
import {
  activityAddedEnvelope,
  activityUpdatedEnvelope,
  baselineSetEnvelope,
  createScheduleTranslator,
  dependencyAddedEnvelope,
  dependencyRemovedEnvelope,
  parseActivityAddedPayload,
  parseActivityDependencyProviderData,
  parseActivityProviderData,
  parseActivityUpdatedPayload,
  parseBaselineProviderData,
  parseBaselineSetPayload,
  parseDependencyAddedPayload,
  parseDependencyRemovedPayload,
  parseProjectScheduleProviderData,
  parseScheduleCreatedPayload,
  parseScheduleEventPayload,
  scheduleCreatedEnvelope,
  scheduleEventEnvelope,
} from './change-mapping';

// OFF-023 adapter-schedule — the change-event mapping: the command translator
// (provider schedule mutations → canonical schedules-area command proposals,
// with the immutable-baseline and append-only-history disciplines), the
// strict fail-closed payload parses, and the trusted envelope builders (the
// host-side execution seam). Deterministic: fixed ids and instants only.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-11-10T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-11-12T10:30:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `sch${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));
/** A fail-closed parsed ISO calendar date (the typed CPM date vocabulary). */
const date = (raw: string): ScheduleDate => unwrap(parseScheduleDate(raw));

const CONTEXT = adapterAuthorizationContext({
  actorId: entity(90),
  scope: { kind: 'tenant', tenantId: TENANT_A },
  capabilities: ['schedule.write'],
});

const SCHEDULE_REF = ref('schedule', entity(1));
const STRUCTURE_REF = ref('activity', entity(3));
const ENVELOPE_REF = ref('activity', entity(4));
const DEPENDENCY_REF = ref('dependency', entity(5));
const BASELINE_REF = ref('baseline', entity(7));

const STRUCTURE_DATA = {
  scheduleId: TOWER_SCHEDULE_ID,
  code: 'A4020',
  name: 'Structure framing',
  plannedDuration: 35,
  parentActivityId: FOUNDATIONS_ACTIVITY_ID,
  plannedStart: '2026-09-21',
  plannedFinish: '2026-11-04',
};

const DEPENDENCY_DATA = {
  scheduleId: TOWER_SCHEDULE_ID,
  predecessorId: STRUCTURE_ACTIVITY_ID,
  successorId: ENVELOPE_ACTIVITY_ID,
  linkType: 'fs',
  lagDays: 3,
};

const BASELINE_DATA = {
  scheduleId: TOWER_SCHEDULE_ID,
  label: 'baseline-2026-09-01',
  supersedes: null,
  protected: true,
};

const structureSource = (objectVersion: string) =>
  sourceRef({
    adapterKind: SCHEDULE_ADAPTER_KIND,
    systemId: SCHEDULE_SYSTEM_ID,
    objectType: ACTIVITY_OBJECT_KIND,
    objectId: providerObjectId(STRUCTURE_ACTIVITY_ID),
    version: providerVersion(objectVersion),
  });

const input = (over: Partial<AdapterCommandInput>): AdapterCommandInput => ({
  origin: 'sync',
  tenantId: TENANT_A,
  source: structureSource('v2'),
  canonical: STRUCTURE_REF,
  canonicalVersion: version(1),
  changeKind: 'updated',
  displayName: 'Structure framing',
  data: STRUCTURE_DATA,
  ...over,
});

/** Compose the executed command envelope of one proposal (the host stand-in). */
const commandOf = (proposal: { commandName: typeof UPDATE_ACTIVITY_COMMAND; payload: AdapterJsonObject }) =>
  adapterCommandEnvelope({
    proposal,
    context: CONTEXT,
    source: structureSource('v2'),
    causationId: null,
    now: NOW_1,
  });

describe('createScheduleTranslator — the proposal matrix', () => {
  const translator = createScheduleTranslator();

  it('proposes schedule.createSchedule for a new project schedule', () => {
    const proposal = unwrap(
      translator.proposeCommand(
        input({
          source: sourceRef({
            adapterKind: SCHEDULE_ADAPTER_KIND,
            systemId: SCHEDULE_SYSTEM_ID,
            objectType: PROJECT_SCHEDULE_OBJECT_KIND,
            objectId: providerObjectId(TOWER_SCHEDULE_ID),
            version: providerVersion('v1'),
          }),
          canonical: SCHEDULE_REF,
          changeKind: 'created',
          displayName: 'Tower A — master schedule',
          data: { name: 'Tower A — master schedule' },
        }),
      ),
    );
    expect(proposal.commandName).toBe(CREATE_SCHEDULE_COMMAND);
    expect(proposal.commandName).toBe('schedule.createSchedule');
    expect(proposal.payload).toStrictEqual({
      name: 'Tower A — master schedule',
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(
          sourceRef({
            adapterKind: SCHEDULE_ADAPTER_KIND,
            systemId: SCHEDULE_SYSTEM_ID,
            objectType: PROJECT_SCHEDULE_OBJECT_KIND,
            objectId: providerObjectId(TOWER_SCHEDULE_ID),
            version: providerVersion('v1'),
          }),
        ),
        providerData: { name: 'Tower A — master schedule' },
      },
    });
  });

  it('rejects an in-place provider schedule mutation (no canonical command exists)', () => {
    for (const changeKind of ['updated', 'deleted'] as const) {
      const result = translator.proposeCommand(
        input({
          source: sourceRef({
            adapterKind: SCHEDULE_ADAPTER_KIND,
            systemId: SCHEDULE_SYSTEM_ID,
            objectType: PROJECT_SCHEDULE_OBJECT_KIND,
            objectId: providerObjectId(TOWER_SCHEDULE_ID),
            version: providerVersion('v2'),
          }),
          canonical: SCHEDULE_REF,
          changeKind,
          data: { name: 'Tower A — renamed' },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.details[0]?.code).toBe('schedule-update-unsupported');
      }
    }
  });

  it('proposes schedule.addActivity for a new activity with full typed CPM data', () => {
    const proposal = unwrap(
      translator.proposeCommand(input({ changeKind: 'created', canonicalVersion: null })),
    );
    expect(proposal.commandName).toBe(ADD_ACTIVITY_COMMAND);
    expect(proposal.payload).toMatchObject({
      activityId: entity(3),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 35,
      parentActivityProviderId: FOUNDATIONS_ACTIVITY_ID,
      plannedStart: '2026-09-21',
      plannedFinish: '2026-11-04',
    });
    // A10: the canonical id is office-issued, never the provider's.
    expect((proposal.payload as Record<string, unknown>)['activityId']).not.toContain(
      STRUCTURE_ACTIVITY_ID,
    );
  });

  it('proposes schedule.updateActivity for an activity update (THE flow’s proposal)', () => {
    const proposal = unwrap(translator.proposeCommand(input({})));
    expect(proposal.commandName).toBe(UPDATE_ACTIVITY_COMMAND);
    expect(proposal.commandName).toBe('schedule.updateActivity');
    expect(proposal.payload).toMatchObject({
      activityId: entity(3),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      code: 'A4020',
      plannedDuration: 35,
      plannedStart: '2026-09-21',
      plannedFinish: '2026-11-04',
      expectedVersion: 1,
    });
  });

  it('rejects a provider activity deletion (the schedules-area history is append-only)', () => {
    const result = translator.proposeCommand(input({ changeKind: 'deleted' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-activity-deletion-unsupported');
      expect(result.error.message).toContain('append-only');
    }
  });

  it('proposes schedule.addDependency / schedule.removeDependency for link changes', () => {
    const dependencyInput = (changeKind: 'created' | 'deleted') =>
      input({
        source: sourceRef({
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
          objectId: providerObjectId(FOUNDATIONS_STRUCTURE_DEPENDENCY_ID),
          version: providerVersion('v1'),
        }),
        canonical: DEPENDENCY_REF,
        changeKind,
        displayName: 'Foundations → structure framing',
        data: DEPENDENCY_DATA,
      });
    const added = unwrap(translator.proposeCommand(dependencyInput('created')));
    expect(added.commandName).toBe(ADD_DEPENDENCY_COMMAND);
    expect(added.payload).toMatchObject({
      dependencyId: entity(5),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      predecessorProviderId: STRUCTURE_ACTIVITY_ID,
      successorProviderId: ENVELOPE_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 3,
    });
    const removed = unwrap(translator.proposeCommand(dependencyInput('deleted')));
    expect(removed.commandName).toBe(REMOVE_DEPENDENCY_COMMAND);
    expect(removed.payload).toMatchObject({
      dependencyId: entity(5),
      linkType: 'fs',
      expectedVersion: 1,
    });
  });

  it('rejects an in-place dependency mutation (links are added and removed, never mutated)', () => {
    const result = translator.proposeCommand(
      input({
        source: sourceRef({
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
          objectId: providerObjectId(FOUNDATIONS_STRUCTURE_DEPENDENCY_ID),
          version: providerVersion('v2'),
        }),
        changeKind: 'updated',
        data: DEPENDENCY_DATA,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('schedule-dependency-immutable');
    }
  });

  it('proposes schedule.setBaseline for a NEW baseline (a re-baseline is a new record)', () => {
    const proposal = unwrap(
      translator.proposeCommand(
        input({
          source: sourceRef({
            adapterKind: SCHEDULE_ADAPTER_KIND,
            systemId: SCHEDULE_SYSTEM_ID,
            objectType: BASELINE_OBJECT_KIND,
            objectId: providerObjectId('bl-2026-10'),
            version: providerVersion('v1'),
          }),
          canonical: BASELINE_REF,
          changeKind: 'created',
          displayName: 'October baseline',
          data: { ...BASELINE_DATA, label: 'baseline-2026-10-01', supersedes: SEPTEMBER_BASELINE_ID },
        }),
      ),
    );
    expect(proposal.commandName).toBe(SET_BASELINE_COMMAND);
    expect(proposal.payload).toMatchObject({
      baselineId: entity(7),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      label: 'baseline-2026-10-01',
      supersedesProviderId: SEPTEMBER_BASELINE_ID,
    });
  });

  it('rejects an in-place baseline mutation and deletion (immutable records) — the re-baselining divergence', () => {
    for (const changeKind of ['updated', 'deleted'] as const) {
      const result = translator.proposeCommand(
        input({
          source: sourceRef({
            adapterKind: SCHEDULE_ADAPTER_KIND,
            systemId: SCHEDULE_SYSTEM_ID,
            objectType: BASELINE_OBJECT_KIND,
            objectId: providerObjectId(SEPTEMBER_BASELINE_ID),
            version: providerVersion('v2'),
          }),
          changeKind,
          displayName: 'September baseline',
          data: { ...BASELINE_DATA, label: 'baseline-2026-09-01-revised' },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.details[0]?.code).toBe('schedule-baseline-immutable');
        // The protected-baseline rule is named in the rejection.
        expect(result.error.message).toContain('PROTECTED');
        expect(result.error.message).toContain('never a mutation');
      }
    }
  });

  it('rejects foreign object kinds and malformed provider payloads (fail-closed)', () => {
    const foreign = translator.proposeCommand(
      input({
        source: sourceRef({
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: 'model' as never,
          objectId: providerObjectId('m-1'),
          version: providerVersion('v1'),
        }),
      }),
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.details[0]?.code).toBe('schedule-object-kind-unknown');
    }

    const malformed = translator.proposeCommand(
      input({ data: { ...STRUCTURE_DATA, plannedDuration: 0 } }),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.details[0]?.code).toBe('provider-data-invalid-value');
    }

    const missingField = translator.proposeCommand(
      input({ data: { code: 'A4020' } as unknown as Record<string, never> }),
    );
    expect(missingField.ok).toBe(false);
    if (!missingField.ok) {
      expect(missingField.error.details[0]?.code).toBe('provider-data-missing-field');
    }
  });

  it('requires a resolved canonical target for non-create observations', () => {
    const result = translator.proposeCommand(
      input({ canonical: null, canonicalVersion: null }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('canonical-target-required');
    }
  });
});

describe('the provider payload parses (open extension bag, strict named fields)', () => {
  it('parses each family’s named fields fail-closed', () => {
    expect(parseProjectScheduleProviderData({ name: 'Tower A — master schedule' }).ok).toBe(true);
    expect(parseProjectScheduleProviderData({}).ok).toBe(false);
    expect(parseActivityProviderData(STRUCTURE_DATA).ok).toBe(true);
    expect(parseActivityProviderData({ ...STRUCTURE_DATA, plannedFinish: '2026-02-30' }).ok).toBe(false);
    expect(parseActivityProviderData({ ...STRUCTURE_DATA, plannedDuration: 9999 }).ok).toBe(false);
    expect(parseActivityProviderData({ ...STRUCTURE_DATA, plannedDuration: 1.5 }).ok).toBe(false);
    expect(parseActivityProviderData({ ...STRUCTURE_DATA, parentActivityId: 42 }).ok).toBe(false);
    expect(parseActivityDependencyProviderData(DEPENDENCY_DATA).ok).toBe(true);
    expect(parseActivityDependencyProviderData({ ...DEPENDENCY_DATA, linkType: 'xf' }).ok).toBe(false);
    expect(parseActivityDependencyProviderData({ ...DEPENDENCY_DATA, lagDays: -1 }).ok).toBe(false);
    expect(parseBaselineProviderData(BASELINE_DATA).ok).toBe(true);
    expect(parseBaselineProviderData({ ...BASELINE_DATA, protected: 'yes' }).ok).toBe(false);
    expect(parseBaselineProviderData({ ...BASELINE_DATA, supersedes: 'has space' }).ok).toBe(false);
  });
});

describe('the trusted event-envelope builders (the host-side execution seam)', () => {
  const structureCommand = commandOf({
    commandName: UPDATE_ACTIVITY_COMMAND,
    payload: {
      activityId: entity(3),
      scheduleProviderId: TOWER_SCHEDULE_ID,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 38,
      plannedStart: '2026-09-24',
      plannedFinish: '2026-11-09',
      expectedVersion: 1,
      extensionMetadata: { sourceKey: sourceRefKeyOf(structureSource('v2')) },
    },
  });

  it('composes THE schedule.activityUpdated envelope with full provenance + causality', () => {
    const event = activityUpdatedEnvelope({
      command: structureCommand,
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
    expect(event.eventName).toBe(ACTIVITY_UPDATED_EVENT);
    expect(event.eventName).toBe('schedule.activityUpdated');
    // The event round-trips the contracts parser by construction.
    expect(parseDomainEventEnvelope(event).ok).toBe(true);
    expect(event.source).toBe('domain');
    expect(event.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(event.entityRefs).toStrictEqual({ before: STRUCTURE_REF, after: STRUCTURE_REF });
    // FULL TRACEABILITY: the causation id is the executed command's
    // idempotency key (the SourceRef-derived sync key of the exact provider
    // object version).
    expect(event.causality.causationId).toBe(structureCommand.idempotencyKey);
    expect(unwrap(parseCausationId(event.causality.causationId))).toBe(
      structureCommand.idempotencyKey,
    );
    expect(event.payload).toStrictEqual({
      scheduleId: entity(1),
      activityId: entity(3),
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 38,
      plannedStart: '2026-09-24',
      plannedFinish: '2026-11-09',
      version: 2,
      provenance: {
        sourceKey: sourceRefKeyOf(structureSource('v2')),
        providerObjectId: STRUCTURE_ACTIVITY_ID,
        providerVersion: 'v2',
      },
    });
    // The strict payload parse accepts the composed payload.
    expect(parseActivityUpdatedPayload(event.payload).ok).toBe(true);
  });

  it('composes the lifecycle envelopes (schedule, activity, dependency, baseline)', () => {
    const created = scheduleCreatedEnvelope({
      command: structureCommand,
      occurredAt: NOW_1,
      schedule: SCHEDULE_REF,
      name: 'Tower A — master schedule',
      providerObjectId: TOWER_SCHEDULE_ID,
      providerVersion: 'v1',
    });
    expect(created.eventName).toBe(SCHEDULE_CREATED_EVENT);
    expect(parseScheduleCreatedPayload(created.payload).ok).toBe(true);
    expect(created.entityRefs).toStrictEqual({ before: null, after: SCHEDULE_REF });

    const added = activityAddedEnvelope({
      command: structureCommand,
      occurredAt: NOW_1,
      activity: STRUCTURE_REF,
      schedule: SCHEDULE_REF,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 35,
      parentActivity: ref('activity', entity(2)),
      plannedStart: date('2026-09-21'),
      plannedFinish: date('2026-11-04'),
      providerObjectId: STRUCTURE_ACTIVITY_ID,
      providerVersion: 'v1',
    });
    expect(added.eventName).toBe(ACTIVITY_ADDED_EVENT);
    expect(parseActivityAddedPayload(added.payload).ok).toBe(true);
    expect(added.payload.parentActivityId).toBe(entity(2));

    const dependencyAdded = dependencyAddedEnvelope({
      command: structureCommand,
      occurredAt: NOW_1,
      dependency: DEPENDENCY_REF,
      schedule: SCHEDULE_REF,
      predecessor: STRUCTURE_REF,
      successor: ENVELOPE_REF,
      linkType: 'fs',
      lagDays: 3,
      version: 1,
      providerObjectId: FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
      providerVersion: 'v1',
    });
    expect(dependencyAdded.eventName).toBe(DEPENDENCY_ADDED_EVENT);
    expect(parseDependencyAddedPayload(dependencyAdded.payload).ok).toBe(true);
    expect(dependencyAdded.payload).toMatchObject({
      predecessorId: entity(3),
      successorId: entity(4),
      linkType: 'fs',
      lagDays: 3,
    });

    const dependencyRemoved = dependencyRemovedEnvelope({
      command: structureCommand,
      occurredAt: NOW_2,
      dependency: DEPENDENCY_REF,
      schedule: SCHEDULE_REF,
      predecessor: STRUCTURE_REF,
      successor: ENVELOPE_REF,
      linkType: 'fs',
      version: 1,
      providerObjectId: FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
      providerVersion: 'v2',
    });
    expect(dependencyRemoved.eventName).toBe(DEPENDENCY_REMOVED_EVENT);
    expect(parseDependencyRemovedPayload(dependencyRemoved.payload).ok).toBe(true);
    expect(dependencyRemoved.entityRefs).toStrictEqual({ before: DEPENDENCY_REF, after: null });

    const baselineSet = baselineSetEnvelope({
      command: structureCommand,
      occurredAt: NOW_1,
      baseline: BASELINE_REF,
      schedule: SCHEDULE_REF,
      label: 'baseline-2026-09-01',
      supersedes: null,
      providerObjectId: SEPTEMBER_BASELINE_ID,
      providerVersion: 'v1',
    });
    expect(baselineSet.eventName).toBe(BASELINE_SET_EVENT);
    expect(parseBaselineSetPayload(baselineSet.payload).ok).toBe(true);
  });

  it('loudly rejects invalid envelope parts (trusted-path self-checks)', () => {
    expect(() =>
      scheduleEventEnvelope({
        command: structureCommand,
        eventName: unwrap(parseEventName('models.elementChanged')),
        occurredAt: NOW_1,
        entityRefs: { before: null, after: STRUCTURE_REF },
        payload: {
          scheduleId: entity(1),
          name: 'Tower A — master schedule',
          provenance: {
            sourceKey: sourceRefKeyOf(structureSource('v2')),
            providerObjectId: TOWER_SCHEDULE_ID,
            providerVersion: 'v1',
          },
        } as never,
      }),
    ).toThrow(/not a schedules-area event name/u);
    expect(() =>
      scheduleEventEnvelope({
        command: structureCommand,
        eventName: SCHEDULE_CREATED_EVENT,
        occurredAt: NOW_1,
        entityRefs: { before: null, after: SCHEDULE_REF },
        payload: {
          scheduleId: entity(1),
          // name missing: the strict payload parse fails loudly.
          provenance: {
            sourceKey: sourceRefKeyOf(structureSource('v2')),
            providerObjectId: TOWER_SCHEDULE_ID,
            providerVersion: 'v1',
          },
        } as never,
      }),
    ).toThrow(/invalid schedule\.scheduleCreated payload/u);
  });

  it('dispatches the payload parse by event name (null for non-schedules names)', () => {
    expect(parseScheduleEventPayload(SCHEDULE_CREATED_EVENT, { name: 'x' })).not.toBeNull();
    expect(
      parseScheduleEventPayload(unwrap(parseEventName('models.elementChanged')), {}),
    ).toBeNull();
  });

  it('is deterministic: identical parts compose identical envelopes', () => {
    const parts = {
      command: structureCommand,
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
    } as const;
    expect(activityUpdatedEnvelope(parts)).toStrictEqual(activityUpdatedEnvelope(parts));
  });
});
