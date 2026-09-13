// Office adapter-model — the deterministic model provider fixture (OFF-022).
//
// A complete, deterministic, in-memory provider of the model object family,
// in strictly GENERIC vocabulary ('model-cde' over 'model-instance-01'):
// no real vendor names anywhere and no vendor SDK — the provider-specific
// shapes live INSIDE this package (that IS the acceptance discipline being
// demonstrated). The fixture proves the adapter contract end to end:
//
//   - a MODEL with TWO immutable VERSIONS (registering v2 never rewrites
//     v1 — the document-revision discipline);
//   - ELEMENTS with typed classifications, quantities, and provider-side
//     link refs to a linked ACTIVITY and DOCUMENT in other provider systems
//     (resolved through the shared source-mapping store);
//   - classification registry entries (element-classification objects);
//   - mutation streams: element updates bump the provider version
//     deterministically, element deletions are TOMBSTONES (the
//     delete-of-version discipline — history is never destructively
//     removed);
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
  adapterKind,
  fakeWebhookSignature,
  providerObjectKind,
  providerSystemId,
} from '@office/adapters-sdk';
import type { AdapterCommandTranslator, AdapterJsonObject, RawWebhook } from '@office/adapters-sdk';
import { createModelAdapter } from './adapter';
import type { ModelProviderObject, ModelProviderStore } from './adapter';
import { createModelTranslator } from './change-mapping';
import {
  ELEMENT_CLASSIFICATION_OBJECT_KIND,
  ELEMENT_OBJECT_KIND,
  MODEL_ADAPTER_KIND,
  MODEL_OBJECT_KIND,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_OBJECT_KIND,
} from './vocabulary';
import type { ProviderLinkRef } from './vocabulary';

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

/** The seeded fixture model's provider object id. */
export const TOWER_MODEL_ID = 'm-tower-a';
/** The seeded fixture model's first version (the baseline). */
export const TOWER_MODEL_V1_ID = 'mv-tower-a-1';
/** The seeded fixture model's second version (the coordination update). */
export const TOWER_MODEL_V2_ID = 'mv-tower-a-2';
/** The seeded fixture wall element's provider object id. */
export const WALL_ELEMENT_ID = 'el-wall-103';
/** The seeded fixture column element's provider object id. */
export const COLUMN_ELEMENT_ID = 'el-column-21';
/** The seeded wall classification registry entry's provider object id. */
export const WALL_CLASSIFICATION_ID = 'cls-wall';
/** The seeded column classification registry entry's provider object id. */
export const COLUMN_CLASSIFICATION_ID = 'cls-column';

/**
 * The seeded wall element's linked ACTIVITY — a provider link ref into the
 * schedule-side adapter family (generic vocabulary; resolved canonically
 * through the shared source-mapping store at host execution time).
 */
export const LINKED_ACTIVITY_REF: ProviderLinkRef = {
  kind: 'provider-link-ref',
  adapterKind: adapterKind('schedule-planning'),
  systemId: providerSystemId('schedule-instance-01'),
  objectType: providerObjectKind('activity'),
  objectId: 'act-401',
};

/**
 * The seeded wall element's linked DOCUMENT — a provider link ref into the
 * construction-CDE adapter family (generic vocabulary; same resolution
 * discipline).
 */
export const LINKED_DOCUMENT_REF: ProviderLinkRef = {
  kind: 'provider-link-ref',
  adapterKind: adapterKind('construction-cde'),
  systemId: providerSystemId('cde-instance-01'),
  objectType: providerObjectKind('document'),
  objectId: 'doc-9',
};

/** Fixed provider-side timestamps of the seeded fixture (deterministic). */
export const TOWER_MODEL_UPDATED_AT: Timestamp = fixedTimestamp('2026-09-01T08:00:00.000Z');
export const TOWER_MODEL_V1_UPDATED_AT: Timestamp = fixedTimestamp('2026-09-01T08:30:00.000Z');
export const TOWER_MODEL_V2_UPDATED_AT: Timestamp = fixedTimestamp('2026-10-05T09:15:00.000Z');
export const CLASSIFICATION_UPDATED_AT: Timestamp = fixedTimestamp('2026-09-01T07:00:00.000Z');
export const ELEMENTS_UPDATED_AT: Timestamp = fixedTimestamp('2026-10-05T11:45:00.000Z');

// ---------------------------------------------------------------------------
// The in-memory provider store.
// ---------------------------------------------------------------------------

/** Create the deterministic in-memory model provider store. */
export function createModelProviderStore(): ModelProviderStore {
  const objects: ModelProviderObject[] = [];
  const versions = new Map<string, number>();

  const nextVersion = (objectId: string): string => {
    const next = (versions.get(objectId) ?? 0) + 1;
    versions.set(objectId, next);
    return `v${next}`;
  };

  const findObject = (objectId: string): ModelProviderObject => {
    const found = objects.find((entry) => entry.objectId === objectId);
    if (found === undefined) {
      throw new TypeError(`the model provider has no object '${objectId}'`);
    }
    return found;
  };

  return {
    get objects(): readonly ModelProviderObject[] {
      return [...objects];
    },
    putObject(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`the model provider already has object '${input.objectId}'`);
      }
      const object: ModelProviderObject = {
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
      const updated: ModelProviderObject = {
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
      const deleted: ModelProviderObject = {
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
// THE seeded model provider fixture.
// ---------------------------------------------------------------------------

/** The wired fixture: adapter + translator + the seeded provider store. */
export interface SeededModelProvider {
  /** The Adapter-contract implementation (hand this to the sync engine). */
  readonly adapter: ReturnType<typeof createModelAdapter>;
  /** The command-translator implementation (hand this to the engines). */
  readonly translator: AdapterCommandTranslator;
  /** The seeded provider store (the mutation surface below drives it). */
  readonly store: ModelProviderStore;
  /** The provider's objects, in insertion order (tombstones included). */
  readonly objects: readonly ModelProviderObject[];
  /** Register a NEW immutable model version (never rewrites an existing one). */
  registerModelVersion(input: {
    readonly objectId: string;
    readonly displayName: string;
    readonly data: AdapterJsonObject;
    readonly updatedAt?: Timestamp | null;
  }): ModelProviderObject;
  /** Mutate one ELEMENT; bumps its version deterministically. */
  updateElement(
    objectId: string,
    patch: {
      readonly displayName?: string;
      readonly data?: AdapterJsonObject;
    },
  ): ModelProviderObject;
  /** Retire one ELEMENT (the delete-of-version tombstone; history persists). */
  retireElement(objectId: string): ModelProviderObject;
  /** Emit the raw webhook for one object's current state (signed, generic). */
  emitWebhook(eventKind: 'created' | 'updated' | 'deleted', objectId: string): RawWebhook;
}

/**
 * Create THE deterministic seeded model provider: one model with two
 * immutable versions, two element-classification registry entries, and two
 * elements with typed classifications, quantities, and provider-side link
 * refs (the wall links to one activity AND one document; the column links
 * to the activity only). Fully deterministic — the same fixture state on
 * every call, no clock or randomness inside.
 */
export function createSeededModelProvider(): SeededModelProvider {
  const store = createModelProviderStore();

  // The model container.
  store.putObject({
    objectId: TOWER_MODEL_ID,
    objectType: MODEL_OBJECT_KIND,
    displayName: 'Tower A — structural model',
    data: { discipline: 'structure' },
    updatedAt: TOWER_MODEL_UPDATED_AT,
  });
  // The model's TWO immutable versions (v2 never rewrites v1).
  store.putObject({
    objectId: TOWER_MODEL_V1_ID,
    objectType: MODEL_VERSION_OBJECT_KIND,
    displayName: 'Tower A v1 — baseline',
    data: { modelId: TOWER_MODEL_ID, label: 'baseline-2026-09-01' },
    updatedAt: TOWER_MODEL_V1_UPDATED_AT,
  });
  store.putObject({
    objectId: TOWER_MODEL_V2_ID,
    objectType: MODEL_VERSION_OBJECT_KIND,
    displayName: 'Tower A v2 — coordination update',
    data: { modelId: TOWER_MODEL_ID, label: 'coordination-2026-10-05' },
    updatedAt: TOWER_MODEL_V2_UPDATED_AT,
  });
  // The classification registry entries.
  store.putObject({
    objectId: WALL_CLASSIFICATION_ID,
    objectType: ELEMENT_CLASSIFICATION_OBJECT_KIND,
    displayName: 'Wall classification',
    data: { code: 'wall', description: 'Vertical planar building element' },
    updatedAt: CLASSIFICATION_UPDATED_AT,
  });
  store.putObject({
    objectId: COLUMN_CLASSIFICATION_ID,
    objectType: ELEMENT_CLASSIFICATION_OBJECT_KIND,
    displayName: 'Column classification',
    data: { code: 'column', description: 'Vertical load-bearing member' },
    updatedAt: CLASSIFICATION_UPDATED_AT,
  });
  // The elements (both at the coordination-update version v2).
  store.putObject({
    objectId: WALL_ELEMENT_ID,
    objectType: ELEMENT_OBJECT_KIND,
    displayName: 'Wall 103 — grid B/4',
    data: {
      modelId: TOWER_MODEL_ID,
      modelVersionId: TOWER_MODEL_V2_ID,
      classification: 'wall',
      quantity: { value: 42.5, unit: 'm2' },
      linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    },
    updatedAt: ELEMENTS_UPDATED_AT,
  });
  store.putObject({
    objectId: COLUMN_ELEMENT_ID,
    objectType: ELEMENT_OBJECT_KIND,
    displayName: 'Column 21 — grid C/2',
    data: {
      modelId: TOWER_MODEL_ID,
      modelVersionId: TOWER_MODEL_V2_ID,
      classification: 'column',
      quantity: { value: 12, unit: 'm3' },
      linkedRefs: [LINKED_ACTIVITY_REF],
    },
    updatedAt: ELEMENTS_UPDATED_AT,
  });

  const requireElement = (objectId: string): ModelProviderObject => {
    const found = unwrap(
      store.objects.find((entry) => entry.objectId === objectId),
      `the model provider has no object '${objectId}'`,
    );
    if (found.objectType !== ELEMENT_OBJECT_KIND) {
      throw new TypeError(
        `provider object '${objectId}' is a ${found.objectType}, not an element — the element mutation surface is elements only`,
      );
    }
    return found;
  };

  return {
    adapter: createModelAdapter({ store }),
    translator: createModelTranslator(),
    store,
    get objects(): readonly ModelProviderObject[] {
      return store.objects;
    },
    registerModelVersion(input) {
      return store.putObject({
        objectId: input.objectId,
        objectType: MODEL_VERSION_OBJECT_KIND,
        displayName: input.displayName,
        data: input.data,
        updatedAt: input.updatedAt ?? null,
      });
    },
    updateElement(objectId, patch) {
      requireElement(objectId);
      return store.updateObject(objectId, patch);
    },
    retireElement(objectId) {
      requireElement(objectId);
      return store.deleteObject(objectId);
    },
    emitWebhook(eventKind, objectId) {
      const object = unwrap(
        store.objects.find((entry) => entry.objectId === objectId),
        `the model provider has no object '${objectId}'`,
      );
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
        adapterKind: MODEL_ADAPTER_KIND,
        systemId: MODEL_SYSTEM_ID,
        headers: { [FAKE_WEBHOOK_SIGNATURE_HEADER]: fakeWebhookSignature(body) },
        body,
      };
    },
  };
}
