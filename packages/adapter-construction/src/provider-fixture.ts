// Office adapter-construction — the deterministic construction/CDE provider
// fixture (OFF-021).
//
// A complete in-memory, DETERMINISTIC construction common-data-environment
// provider at reference-fixture scale: controlled documents with revision
// history, requests for information (RFIs), proposed change events, and
// field observations. The adapter (adapter.ts) is driven entirely by this
// injected provider DATA — the package performs no network I/O of any kind;
// swapping the fixture for a real CDE client means implementing the same
// store reads behind the adapter, not changing the translation seams.
//
// Determinism rules (mirroring the adapters-sdk fake-provider fixture):
//   - objects live in insertion order; versions bump monotonically per
//     object ('v1', 'v2', …); deletions are tombstones, never removals;
//   - every mutation is pure data (no clock, no randomness) — instants are
//     caller-supplied values;
//   - webhook pushes carry the provider's WIRE format body plus a
//     deterministic signature header the matching injected verifier checks
//     (webhook-ingest.ts owns that convention).
//
// The store's object shapes are PROVIDER-native (this is the one place
// provider-specific structure exists by design — freeze A6): plain string
// ids, the provider's own field names. Identity references that must be
// canonical office ids (project, contract, user, evidence) are carried as
// the office-issued id strings the provider learned when the CDE workspace
// was provisioned from office — the adapter never manufactures canonical
// ids out of provider ids (freeze anti-pattern A10: provider ids are never
// primary keys; mapping.ts parses these references fail-closed).
import type { Timestamp } from '@office/contracts';
import type { AdapterJsonObject, RawWebhook } from '@office/adapters-sdk';
import { CONSTRUCTION_ADAPTER_KIND, CONSTRUCTION_SYSTEM_ID } from './vocabulary';
import { constructionObjectViewOf } from './snapshot-translation';
import { CDE_WEBHOOK_SIGNATURE_HEADER, cdeWebhookSignature } from './webhook-ingest';

/** The provider's current revision of one controlled document. */
export interface ConstructionDocumentRevision {
  readonly revisionId: string;
  readonly contentBase64: string;
}

/** One controlled document in the CDE (tombstone on deletion, never removed). */
export interface ConstructionDocumentObject {
  readonly objectType: 'document';
  readonly objectId: string;
  readonly version: string;
  readonly title: string;
  /** Office-issued project id (learned at workspace provisioning). */
  readonly projectId: string;
  readonly discipline: string;
  readonly revision: ConstructionDocumentRevision;
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** One request for information in the CDE. */
export interface ConstructionRfiObject {
  readonly objectType: 'rfi';
  readonly objectId: string;
  readonly version: string;
  readonly title: string;
  readonly question: string;
  readonly category: string;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly projectId: string;
  /** Office-issued user id of the raising party (provisioned identity). */
  readonly raisedBy: string;
  readonly raisedAt: Timestamp;
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** One cost impact reference a change event carries (append-only list). */
export interface ConstructionCostImpact {
  readonly budgetId: string | null;
  readonly costItemId: string | null;
}

/** One proposed change event in the CDE. */
export interface ConstructionChangeEventObject {
  readonly objectType: 'change-event';
  readonly objectId: string;
  readonly version: string;
  readonly title: string;
  readonly changeType: 'addition' | 'modification' | 'deletion';
  /** Office-issued contract id the change event is raised against. */
  readonly contractRef: string;
  /** Append-only cost impact references (office-issued ids). */
  readonly costImpacts: readonly ConstructionCostImpact[];
  /** Append-only schedule impact activity ids (office-issued). */
  readonly scheduleImpactActivityIds: readonly string[];
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** One evidence reference an observation carries (append-only list). */
export interface ConstructionEvidenceReference {
  readonly documentId: string;
  readonly revisionId: string;
}

/** One field observation in the CDE (daily-report style capture). */
export interface ConstructionObservationObject {
  readonly objectType: 'observation';
  readonly objectId: string;
  readonly version: string;
  readonly category: string;
  readonly summary: string;
  readonly detail?: string;
  readonly location: string;
  readonly observedAt: Timestamp;
  /** Office-issued user id of the observer (provisioned identity). */
  readonly observedBy: string;
  readonly quantity?: { readonly value: number; readonly unit: string };
  /** Append-only evidence references (office-issued document/revision ids). */
  readonly evidence?: readonly ConstructionEvidenceReference[];
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** Any object the CDE store holds. */
export type ConstructionProviderObject =
  | ConstructionDocumentObject
  | ConstructionRfiObject
  | ConstructionChangeEventObject
  | ConstructionObservationObject;

/** Which provider event kinds the CDE pushes (the webhook wire vocabulary). */
export type CdeEventKind = 'created' | 'updated' | 'deleted';

/**
 * The deterministic in-memory construction provider store. All mutations
 * throw loud TypeErrors on unknown/duplicate ids (the trusted fixture path);
 * every version bump is pure bookkeeping — same mutation sequence, same
 * versions.
 */
export interface ConstructionProviderStore {
  /** Every held object, in insertion order (tombstones included). */
  readonly objects: readonly ConstructionProviderObject[];
  /** The object with one id, or null when absent (tombstones included). */
  find(objectId: string): ConstructionProviderObject | null;

  putDocument(input: {
    readonly objectId: string;
    readonly title: string;
    readonly projectId: string;
    readonly discipline: string;
    readonly revision: ConstructionDocumentRevision;
    readonly updatedAt?: Timestamp | null;
  }): ConstructionDocumentObject;
  updateDocument(
    objectId: string,
    patch: {
      readonly title?: string;
      readonly discipline?: string;
      readonly revision?: ConstructionDocumentRevision;
      readonly updatedAt?: Timestamp | null;
    },
  ): ConstructionDocumentObject;
  deleteDocument(objectId: string, updatedAt?: Timestamp | null): ConstructionDocumentObject;

  putRfi(input: {
    readonly objectId: string;
    readonly title: string;
    readonly question: string;
    readonly category: string;
    readonly severity: 'low' | 'medium' | 'high' | 'critical';
    readonly projectId: string;
    readonly raisedBy: string;
    readonly raisedAt: Timestamp;
    readonly updatedAt?: Timestamp | null;
  }): ConstructionRfiObject;
  updateRfi(
    objectId: string,
    patch: {
      readonly title?: string;
      readonly question?: string;
      readonly severity?: 'low' | 'medium' | 'high' | 'critical';
      readonly updatedAt?: Timestamp | null;
    },
  ): ConstructionRfiObject;
  deleteRfi(objectId: string, updatedAt?: Timestamp | null): ConstructionRfiObject;

  putChangeEvent(input: {
    readonly objectId: string;
    readonly title: string;
    readonly changeType: 'addition' | 'modification' | 'deletion';
    readonly contractRef: string;
    readonly costImpacts?: readonly ConstructionCostImpact[];
    readonly scheduleImpactActivityIds?: readonly string[];
    readonly updatedAt?: Timestamp | null;
  }): ConstructionChangeEventObject;
  updateChangeEvent(
    objectId: string,
    patch: {
      readonly title?: string;
      /** Appended to the append-only cost impact list. */
      readonly appendCostImpacts?: readonly ConstructionCostImpact[];
      /** Appended to the append-only schedule impact list. */
      readonly appendScheduleImpactActivityIds?: readonly string[];
      readonly updatedAt?: Timestamp | null;
    },
  ): ConstructionChangeEventObject;
  deleteChangeEvent(objectId: string, updatedAt?: Timestamp | null): ConstructionChangeEventObject;

  putObservation(input: {
    readonly objectId: string;
    readonly category: string;
    readonly summary: string;
    readonly detail?: string;
    readonly location: string;
    readonly observedAt: Timestamp;
    readonly observedBy: string;
    readonly quantity?: { readonly value: number; readonly unit: string };
    readonly evidence?: readonly ConstructionEvidenceReference[];
    readonly updatedAt?: Timestamp | null;
  }): ConstructionObservationObject;
  updateObservation(
    objectId: string,
    patch: {
      readonly summary?: string;
      readonly detail?: string;
      /** Appended to the append-only evidence list. */
      readonly appendEvidence?: readonly ConstructionEvidenceReference[];
      readonly updatedAt?: Timestamp | null;
    },
  ): ConstructionObservationObject;
  deleteObservation(objectId: string, updatedAt?: Timestamp | null): ConstructionObservationObject;

  /** Mark the provider degraded (the healthCheck surface observes it). */
  degrade(detail: string): void;
  /** Clear the degraded mark. */
  recover(): void;
  /** The degraded diagnostic, or null when the provider is healthy. */
  degradedDetail(): string | null;

  /**
   * Emit the raw webhook push for one object's current state, in the CDE's
   * WIRE format, signed with the deterministic signature convention the
   * injected verifier checks (webhook-ingest.ts).
   */
  emitWebhook(eventKind: CdeEventKind, objectId: string): RawWebhook;
}

/** Create the deterministic in-memory construction provider store. */
export function createConstructionProviderStore(): ConstructionProviderStore {
  const objects: ConstructionProviderObject[] = [];
  const versions = new Map<string, number>();
  let degradedDetail: string | null = null;

  const nextVersion = (objectId: string): string => {
    const next = (versions.get(objectId) ?? 0) + 1;
    versions.set(objectId, next);
    return `v${next}`;
  };

  const findObject = (objectId: string): ConstructionProviderObject => {
    const found = objects.find((entry) => entry.objectId === objectId);
    if (found === undefined) {
      throw new TypeError(`construction provider has no object '${objectId}'`);
    }
    return found;
  };

  const replace = (current: ConstructionProviderObject, updated: ConstructionProviderObject): void => {
    objects[objects.indexOf(current)] = updated;
  };

  return {
    get objects() {
      return [...objects];
    },
    find(objectId) {
      return objects.find((entry) => entry.objectId === objectId) ?? null;
    },

    putDocument(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`construction provider already has object '${input.objectId}'`);
      }
      const object: ConstructionDocumentObject = {
        objectType: 'document',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        title: input.title,
        projectId: input.projectId,
        discipline: input.discipline,
        revision: input.revision,
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    updateDocument(objectId, patch) {
      const current = findObject(objectId) as ConstructionDocumentObject;
      const updated: ConstructionDocumentObject = {
        ...current,
        title: patch.title ?? current.title,
        discipline: patch.discipline ?? current.discipline,
        revision: patch.revision ?? current.revision,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    deleteDocument(objectId, updatedAt) {
      const current = findObject(objectId) as ConstructionDocumentObject;
      const deleted: ConstructionDocumentObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    putRfi(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`construction provider already has object '${input.objectId}'`);
      }
      const object: ConstructionRfiObject = {
        objectType: 'rfi',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        title: input.title,
        question: input.question,
        category: input.category,
        severity: input.severity,
        projectId: input.projectId,
        raisedBy: input.raisedBy,
        raisedAt: input.raisedAt,
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    updateRfi(objectId, patch) {
      const current = findObject(objectId) as ConstructionRfiObject;
      const updated: ConstructionRfiObject = {
        ...current,
        title: patch.title ?? current.title,
        question: patch.question ?? current.question,
        severity: patch.severity ?? current.severity,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    deleteRfi(objectId, updatedAt) {
      const current = findObject(objectId) as ConstructionRfiObject;
      const deleted: ConstructionRfiObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    putChangeEvent(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`construction provider already has object '${input.objectId}'`);
      }
      const object: ConstructionChangeEventObject = {
        objectType: 'change-event',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        title: input.title,
        changeType: input.changeType,
        contractRef: input.contractRef,
        costImpacts: input.costImpacts ?? [],
        scheduleImpactActivityIds: input.scheduleImpactActivityIds ?? [],
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    updateChangeEvent(objectId, patch) {
      const current = findObject(objectId) as ConstructionChangeEventObject;
      const updated: ConstructionChangeEventObject = {
        ...current,
        title: patch.title ?? current.title,
        costImpacts: [
          ...current.costImpacts,
          ...(patch.appendCostImpacts ?? []),
        ],
        scheduleImpactActivityIds: [
          ...current.scheduleImpactActivityIds,
          ...(patch.appendScheduleImpactActivityIds ?? []),
        ],
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    deleteChangeEvent(objectId, updatedAt) {
      const current = findObject(objectId) as ConstructionChangeEventObject;
      const deleted: ConstructionChangeEventObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    putObservation(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`construction provider already has object '${input.objectId}'`);
      }
      const object: ConstructionObservationObject = {
        objectType: 'observation',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        category: input.category,
        summary: input.summary,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        location: input.location,
        observedAt: input.observedAt,
        observedBy: input.observedBy,
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    updateObservation(objectId, patch) {
      const current = findObject(objectId) as ConstructionObservationObject;
      const updated: ConstructionObservationObject = {
        ...current,
        summary: patch.summary ?? current.summary,
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        evidence:
          patch.appendEvidence !== undefined || current.evidence !== undefined
            ? [...(current.evidence ?? []), ...(patch.appendEvidence ?? [])]
            : undefined,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    deleteObservation(objectId, updatedAt) {
      const current = findObject(objectId) as ConstructionObservationObject;
      const deleted: ConstructionObservationObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    degrade(detail) {
      degradedDetail = detail;
    },
    recover() {
      degradedDetail = null;
    },
    degradedDetail() {
      return degradedDetail;
    },

    emitWebhook(eventKind, objectId) {
      const object = findObject(objectId);
      const view = constructionObjectViewOf(object);
      const body: AdapterJsonObject = {
        kind: 'cde-webhook-event',
        eventType: `${object.objectType}.${eventKind}`,
        objectId: object.objectId,
        revisionTag: object.version,
        occurredAt: object.updatedAt,
        payload: view.data,
      };
      return {
        kind: 'raw-webhook',
        adapterKind: CONSTRUCTION_ADAPTER_KIND,
        systemId: CONSTRUCTION_SYSTEM_ID,
        headers: { [CDE_WEBHOOK_SIGNATURE_HEADER]: cdeWebhookSignature(body) },
        body,
      };
    },
  };
}
