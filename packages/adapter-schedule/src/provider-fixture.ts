// Office adapter-schedule — the deterministic schedule provider fixture (OFF-023).
//
// A complete, deterministic, in-memory provider of the schedule object
// family, in strictly GENERIC vocabulary ('schedule-pm' over
// 'schedule-instance-01'): no real vendor names anywhere and no vendor SDK —
// the provider-specific shapes live INSIDE this package (that IS the
// acceptance discipline being demonstrated). The fixture proves the adapter
// contract end to end:
//
//   - a PROJECT SCHEDULE (the CPM container);
//   - three ACTIVITIES with typed CPM data (codes, planned durations,
//     planned start/finish dates, WBS parents);
//   - two ACTIVITY DEPENDENCIES (FS links with typed lag);
//   - one PROTECTED BASELINE over the whole network (immutable records);
//   - mutation streams: activity date updates bump the provider version
//     deterministically (THE flow), dependency INTRODUCTIONS append new
//     link objects (the cycle-introduction divergence), baseline
//     REGISTRATION appends new baseline objects (a re-baseline done
//     properly — a new record, never a mutation), and the IN-PLACE
//     re-baselining attempt mutates the protected baseline object (the
//     named divergence the conflict rules quarantine);
//   - sync pages slice positionally after the cursor token (positional
//     replay safety) and webhooks are emitted with the SDK's deterministic
//     fake-signature convention (verified by the SDK's fake verifier port).
//
// No clock, no randomness: versions are per-object counters, timestamps are
// fixed constants, and the same operations always produce the same state.
import { parseTimestamp } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import {
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  fakeWebhookSignature,
  providerObjectKind,
} from '@office/adapters-sdk';
import type { AdapterCommandTranslator, AdapterJsonObject, RawWebhook } from '@office/adapters-sdk';
import { createScheduleAdapter } from './adapter';
import type { ScheduleProviderObject, ScheduleProviderStore } from './adapter';
import { createScheduleTranslator, parseActivityDependencyProviderData, parseBaselineProviderData } from './change-mapping';
import type { ScheduleLinkType } from './vocabulary';
import {
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
  PROJECT_SCHEDULE_OBJECT_KIND,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
} from './vocabulary';
import type { ScheduleDivergenceView } from './conflict-rules';

const unwrap = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) {
    throw new TypeError(message);
  }
  return value;
};

const fixedTimestamp = (raw: string): Timestamp => {
  const parsed = parseTimestamp(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid fixed fixture timestamp: ${raw}`);
  }
  return parsed.value;
};

// ---------------------------------------------------------------------------
// The fixture's provider identities (generic vocabulary).
// ---------------------------------------------------------------------------

/** The seeded fixture project schedule's provider object id. */
export const TOWER_SCHEDULE_ID = 'sch-tower-a';
/** The seeded fixture's foundations activity (the network's first activity). */
export const FOUNDATIONS_ACTIVITY_ID = 'act-401';
/** The seeded fixture's structure-framing activity (THE flow's changed activity). */
export const STRUCTURE_ACTIVITY_ID = 'act-402';
/** The seeded fixture's envelope activity (the flow's impacted successor). */
export const ENVELOPE_ACTIVITY_ID = 'act-403';
/** The seeded foundations → structure dependency link. */
export const FOUNDATIONS_STRUCTURE_DEPENDENCY_ID = 'dep-401-402';
/** The seeded structure → envelope dependency link (with typed lag). */
export const STRUCTURE_ENVELOPE_DEPENDENCY_ID = 'dep-402-403';
/** The seeded protected baseline over the whole network. */
export const SEPTEMBER_BASELINE_ID = 'bl-2026-09';

/** Fixed provider-side timestamps of the seeded fixture (deterministic). */
export const TOWER_SCHEDULE_UPDATED_AT: Timestamp = fixedTimestamp('2026-08-30T08:00:00.000Z');
export const ACTIVITIES_UPDATED_AT: Timestamp = fixedTimestamp('2026-09-01T08:00:00.000Z');
export const DEPENDENCIES_UPDATED_AT: Timestamp = fixedTimestamp('2026-09-01T09:00:00.000Z');
export const BASELINE_UPDATED_AT: Timestamp = fixedTimestamp('2026-09-02T10:00:00.000Z');

// ---------------------------------------------------------------------------
// The in-memory provider store.
// ---------------------------------------------------------------------------

/** Create the deterministic in-memory schedule provider store. */
export function createScheduleProviderStore(): ScheduleProviderStore {
  const objects: ScheduleProviderObject[] = [];
  const versions = new Map<string, number>();

  const nextVersion = (objectId: string): string => {
    const next = (versions.get(objectId) ?? 0) + 1;
    versions.set(objectId, next);
    return `v${next}`;
  };

  const findObject = (objectId: string): ScheduleProviderObject => {
    const found = objects.find((entry) => entry.objectId === objectId);
    if (found === undefined) {
      throw new TypeError(`the schedule provider has no object '${objectId}'`);
    }
    return found;
  };

  return {
    get objects(): readonly ScheduleProviderObject[] {
      return [...objects];
    },
    putObject(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`the schedule provider already has object '${input.objectId}'`);
      }
      const object: ScheduleProviderObject = {
        objectId: input.objectId,
        objectType: input.objectType,
        version: nextVersion(input.objectId),
        displayName: input.displayName,
        status: 'active',
        data: input.data ?? {},
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    updateObject(objectId, patch) {
      const current = findObject(objectId);
      const updated: ScheduleProviderObject = {
        ...current,
        displayName: patch.displayName ?? current.displayName,
        data: patch.data ?? current.data,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      objects[objects.indexOf(current)] = updated;
      return updated;
    },
    deleteObject(objectId, updatedAt) {
      const current = findObject(objectId);
      const deleted: ScheduleProviderObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      objects[objects.indexOf(current)] = deleted;
      return deleted;
    },
  };
}

// ---------------------------------------------------------------------------
// THE seeded schedule provider fixture.
// ---------------------------------------------------------------------------

/** The wired fixture: adapter + translator + the seeded provider store. */
export interface SeededScheduleProvider {
  /** The Adapter-contract implementation (hand this to the sync engine). */
  readonly adapter: ReturnType<typeof createScheduleAdapter>;
  /** The command-translator implementation (hand this to the engines). */
  readonly translator: AdapterCommandTranslator;
  /** The seeded provider store (the mutation surface below drives it). */
  readonly store: ScheduleProviderStore;
  /** The provider's objects, in insertion order (tombstones included). */
  readonly objects: readonly ScheduleProviderObject[];
  /**
   * The divergence view over the provider's own state (dependencies +
   * baselines with their versions and protection flags) — the injected port
   * the conflict rules' pre-flight detection runs over.
   */
  readonly divergenceView: ScheduleDivergenceView;
  /** Mutate one ACTIVITY (dates/duration/identity); bumps its version deterministically. */
  updateActivity(
    objectId: string,
    patch: {
      readonly displayName?: string;
      readonly data?: AdapterJsonObject;
    },
  ): ScheduleProviderObject;
  /**
   * Introduce a NEW dependency link (appends a new provider object — the
   * introduction surface of the cycle-introduction divergence).
   */
  introduceDependency(input: {
    readonly objectId: string;
    readonly predecessorId: string;
    readonly successorId: string;
    readonly linkType: ScheduleLinkType;
    readonly lagDays: number;
  }): ScheduleProviderObject;
  /**
   * Register a NEW baseline object (a re-baseline done properly: a new
   * record superseding a prior one, never a mutation of it).
   */
  registerBaseline(input: {
    readonly objectId: string;
    readonly label: string;
    readonly supersedes: string | null;
    readonly protected?: boolean;
  }): ScheduleProviderObject;
  /**
   * Attempt an IN-PLACE re-baseline of an existing baseline object (the
   * named divergence: a re-baselining attempt against a protected baseline).
   */
  attemptRebaseline(objectId: string, patch: { readonly label: string }): ScheduleProviderObject;
  /** Emit the raw webhook for one object's current state (signed, generic). */
  emitWebhook(eventKind: 'created' | 'updated' | 'deleted', objectId: string): RawWebhook;
}

/**
 * Create THE deterministic seeded schedule provider: one project schedule
 * with three activities (a WBS chain: foundations → structure framing →
 * envelope), two FS dependency links (the second with typed lag), and one
 * protected baseline over the whole network. Fully deterministic — the same
 * fixture state on every call, no clock or randomness inside.
 */
export function createSeededScheduleProvider(): SeededScheduleProvider {
  const store = createScheduleProviderStore();

  // The project schedule container.
  store.putObject({
    objectId: TOWER_SCHEDULE_ID,
    objectType: PROJECT_SCHEDULE_OBJECT_KIND,
    displayName: 'Tower A — master schedule',
    data: { name: 'Tower A — master schedule' },
    updatedAt: TOWER_SCHEDULE_UPDATED_AT,
  });
  // The activities (a WBS chain with typed CPM data).
  store.putObject({
    objectId: FOUNDATIONS_ACTIVITY_ID,
    objectType: ACTIVITY_OBJECT_KIND,
    displayName: 'Foundations',
    data: {
      scheduleId: TOWER_SCHEDULE_ID,
      code: 'A4010',
      name: 'Foundations',
      plannedDuration: 20,
      parentActivityId: null,
      plannedStart: '2026-09-01',
      plannedFinish: '2026-09-18',
    },
    updatedAt: ACTIVITIES_UPDATED_AT,
  });
  store.putObject({
    objectId: STRUCTURE_ACTIVITY_ID,
    objectType: ACTIVITY_OBJECT_KIND,
    displayName: 'Structure framing',
    data: {
      scheduleId: TOWER_SCHEDULE_ID,
      code: 'A4020',
      name: 'Structure framing',
      plannedDuration: 35,
      parentActivityId: FOUNDATIONS_ACTIVITY_ID,
      plannedStart: '2026-09-21',
      plannedFinish: '2026-11-04',
    },
    updatedAt: ACTIVITIES_UPDATED_AT,
  });
  store.putObject({
    objectId: ENVELOPE_ACTIVITY_ID,
    objectType: ACTIVITY_OBJECT_KIND,
    displayName: 'Envelope',
    data: {
      scheduleId: TOWER_SCHEDULE_ID,
      code: 'A4030',
      name: 'Envelope',
      plannedDuration: 25,
      parentActivityId: STRUCTURE_ACTIVITY_ID,
      plannedStart: '2026-11-09',
      plannedFinish: '2026-12-11',
    },
    updatedAt: ACTIVITIES_UPDATED_AT,
  });
  // The dependency links (FS + typed lag).
  store.putObject({
    objectId: FOUNDATIONS_STRUCTURE_DEPENDENCY_ID,
    objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
    displayName: 'Foundations → structure framing',
    data: {
      scheduleId: TOWER_SCHEDULE_ID,
      predecessorId: FOUNDATIONS_ACTIVITY_ID,
      successorId: STRUCTURE_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 0,
    },
    updatedAt: DEPENDENCIES_UPDATED_AT,
  });
  store.putObject({
    objectId: STRUCTURE_ENVELOPE_DEPENDENCY_ID,
    objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
    displayName: 'Structure framing → envelope',
    data: {
      scheduleId: TOWER_SCHEDULE_ID,
      predecessorId: STRUCTURE_ACTIVITY_ID,
      successorId: ENVELOPE_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 3,
    },
    updatedAt: DEPENDENCIES_UPDATED_AT,
  });
  // The protected baseline over the whole network (immutable record).
  store.putObject({
    objectId: SEPTEMBER_BASELINE_ID,
    objectType: BASELINE_OBJECT_KIND,
    displayName: 'September baseline',
    data: {
      scheduleId: TOWER_SCHEDULE_ID,
      label: 'baseline-2026-09-01',
      supersedes: null,
      protected: true,
    },
    updatedAt: BASELINE_UPDATED_AT,
  });

  const requireObject = (objectId: string): ScheduleProviderObject =>
    unwrap(
      store.objects.find((entry) => entry.objectId === objectId),
      `the schedule provider has no object '${objectId}'`,
    );

  const requireObjectOfType = (
    objectId: string,
    objectType: ReturnType<typeof providerObjectKind>,
    surface: string,
  ): ScheduleProviderObject => {
    const found = requireObject(objectId);
    if (found.objectType !== objectType) {
      throw new TypeError(
        `provider object '${objectId}' is a ${found.objectType}, not an ${objectType} — the ${surface} surface is ${objectType} objects only`,
      );
    }
    return found;
  };

  return {
    adapter: createScheduleAdapter({ store }),
    translator: createScheduleTranslator(),
    store,
    get objects(): readonly ScheduleProviderObject[] {
      return store.objects;
    },
    get divergenceView(): ScheduleDivergenceView {
      // The trusted fixture path: the view is derived fail-closed from the
      // provider's own objects — a malformed provider payload is a loud
      // fixture defect, never silent data.
      const dependencies = store.objects
        .filter((entry) => entry.objectType === ACTIVITY_DEPENDENCY_OBJECT_KIND)
        .map((entry) => {
          const parsed = parseActivityDependencyProviderData(entry.data);
          if (!parsed.ok) {
            throw new TypeError(
              `fixture dependency object '${entry.objectId}' carries a malformed payload: ${parsed.error.code} at '${parsed.error.path}'`,
            );
          }
          return {
            objectId: entry.objectId,
            version: entry.version,
            scheduleId: parsed.value.scheduleId,
            predecessorId: parsed.value.predecessorId,
            successorId: parsed.value.successorId,
          };
        });
      const baselines = store.objects
        .filter((entry) => entry.objectType === BASELINE_OBJECT_KIND)
        .map((entry) => {
          const parsed = parseBaselineProviderData(entry.data);
          if (!parsed.ok) {
            throw new TypeError(
              `fixture baseline object '${entry.objectId}' carries a malformed payload: ${parsed.error.code} at '${parsed.error.path}'`,
            );
          }
          return {
            objectId: entry.objectId,
            version: entry.version,
            scheduleId: parsed.value.scheduleId,
            protected: parsed.value.protected,
          };
        });
      return { dependencies, baselines };
    },
    updateActivity(objectId, patch) {
      requireObjectOfType(objectId, ACTIVITY_OBJECT_KIND, 'activity mutation');
      return store.updateObject(objectId, patch);
    },
    introduceDependency(input) {
      return store.putObject({
        objectId: input.objectId,
        objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
        displayName: `Dependency ${input.predecessorId} → ${input.successorId}`,
        data: {
          scheduleId: TOWER_SCHEDULE_ID,
          predecessorId: input.predecessorId,
          successorId: input.successorId,
          linkType: input.linkType,
          lagDays: input.lagDays,
        },
        updatedAt: DEPENDENCIES_UPDATED_AT,
      });
    },
    registerBaseline(input) {
      return store.putObject({
        objectId: input.objectId,
        objectType: BASELINE_OBJECT_KIND,
        displayName: input.label,
        data: {
          scheduleId: TOWER_SCHEDULE_ID,
          label: input.label,
          supersedes: input.supersedes,
          protected: input.protected ?? false,
        },
        updatedAt: BASELINE_UPDATED_AT,
      });
    },
    attemptRebaseline(objectId, patch) {
      const current = requireObjectOfType(objectId, BASELINE_OBJECT_KIND, 're-baselining attempt');
      return store.updateObject(objectId, {
        displayName: patch.label,
        data: { ...current.data, label: patch.label },
      });
    },
    emitWebhook(eventKind, objectId) {
      const object = requireObject(objectId);
      const body = {
        kind: 'provider-webhook-body',
        eventKind,
        objectType: object.objectType,
        objectId: object.objectId,
        version: object.version,
        occurredAt: object.updatedAt,
        data: object.data,
      };
      return {
        kind: 'raw-webhook',
        adapterKind: SCHEDULE_ADAPTER_KIND,
        systemId: SCHEDULE_SYSTEM_ID,
        headers: { [FAKE_WEBHOOK_SIGNATURE_HEADER]: fakeWebhookSignature(body) },
        body,
      };
    },
  };
}
