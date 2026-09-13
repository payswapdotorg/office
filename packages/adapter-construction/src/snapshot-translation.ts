// Office adapter-construction — provider object → ProviderSnapshot (OFF-021).
//
// The SNAPSHOT TRANSLATION seam: one construction provider object at one
// provider version becomes a provider-neutral ProviderSnapshot — provenance
// (the SourceRef with adapter kind, provider system, object type/id and the
// provider's version), the typed core fields every provider object has (the
// display name, the lifecycle status with the explicit 'deleted' tombstone
// state, the provider's own last-modified instant, the observation instant
// from the injected clock), and the open-keyed extension bag carrying the
// provider's own payload data.
//
// The per-kind payload data (the extension bag) is THE shared provider-data
// vocabulary of this package: the sync path carries it inside the snapshot's
// `extension`, the webhook path carries it inside the translated
// ProviderWebhookBody's `data`, and the command translator (mapping.ts)
// parses it fail-closed per object kind. Because both intake paths carry the
// SAME data for the SAME provider object version, they converge on one
// command per provider object version (the SDK's SourceRef-derived
// idempotency keys).
//
// All provider-specific shape knowledge lives in THIS module and its sibling
// mapping.ts — nothing provider-shaped ever leaves the package (freeze A6:
// adapters never own canonical semantics; the snapshot is the neutral seam).
import type { TenantId, Timestamp } from '@office/contracts';
import { providerObjectId, providerObjectKind, providerSnapshot, providerVersion, sourceRef } from '@office/adapters-sdk';
import type { AdapterJsonObject, ProviderSnapshot, ProviderSystemId } from '@office/adapters-sdk';
import { CONSTRUCTION_ADAPTER_KIND, CONSTRUCTION_SYSTEM_ID } from './vocabulary';
import type { ConstructionProviderObject } from './provider-fixture';

/**
 * The neutral view of one provider object: its display name and its payload
 * data (the extension bag / webhook payload). Deterministic, pure — derived
 * only from the object's own fields, never from a clock or a counter.
 */
export interface ConstructionObjectView {
  readonly displayName: string;
  readonly data: AdapterJsonObject;
}

/**
 * Derive the neutral (display name, payload data) view of one provider
 * object. Throws a loud TypeError on an object kind the mapping table does
 * not declare (the fixture store only holds declared kinds — the trusted
 * path).
 */
export function constructionObjectViewOf(
  object: ConstructionProviderObject,
): ConstructionObjectView {
  // Captured before the switch narrows the discriminant (the default branch
  // reports it; by then the type is `never`).
  const objectType: string = object.objectType;
  switch (object.objectType) {
    case 'document':
      return {
        displayName: object.title,
        data: {
          title: object.title,
          projectId: object.projectId,
          discipline: object.discipline,
          revision: {
            revisionId: object.revision.revisionId,
            contentBase64: object.revision.contentBase64,
          },
        },
      };
    case 'rfi':
      return {
        displayName: object.title,
        data: {
          title: object.title,
          projectId: object.projectId,
          question: object.question,
          category: object.category,
          severity: object.severity,
          raisedBy: object.raisedBy,
          raisedAt: object.raisedAt,
        },
      };
    case 'change-event':
      return {
        displayName: object.title,
        data: {
          title: object.title,
          contractRef: object.contractRef,
          changeType: object.changeType,
          costImpacts: object.costImpacts.map((impact) => ({
            budgetId: impact.budgetId,
            costItemId: impact.costItemId,
          })),
          scheduleImpactActivityIds: [...object.scheduleImpactActivityIds],
        },
      };
    case 'observation':
      return {
        displayName: object.summary,
        data: {
          summary: object.summary,
          category: object.category,
          ...(object.detail !== undefined ? { detail: object.detail } : {}),
          location: object.location,
          observedAt: object.observedAt,
          observedBy: object.observedBy,
          ...(object.quantity !== undefined
            ? { quantity: { value: object.quantity.value, unit: object.quantity.unit } }
            : {}),
          ...(object.evidence !== undefined
            ? {
                evidence: object.evidence.map((ref) => ({
                  documentId: ref.documentId,
                  revisionId: ref.revisionId,
                })),
              }
            : {}),
        },
      };
    default:
      throw new TypeError(
        `construction adapter does not translate object kind '${objectType}'`,
      );
  }
}

/**
 * Translate one provider object into its tenant-stamped, provider-neutral
 * snapshot: the SourceRef carries the full provider identity at the object's
 * current version, observedAt comes from the injected clock (never a wall
 * clock read), and the extension bag carries the per-kind provider payload
 * data.
 */
export function constructionSnapshotOf(parts: {
  readonly object: ConstructionProviderObject;
  readonly tenantId: TenantId;
  readonly now: Timestamp;
  /** The provider system being synced (defaults to the reference fixture's). */
  readonly systemId?: ProviderSystemId;
}): ProviderSnapshot {
  const view = constructionObjectViewOf(parts.object);
  return providerSnapshot({
    tenantId: parts.tenantId,
    source: sourceRef({
      adapterKind: CONSTRUCTION_ADAPTER_KIND,
      systemId: parts.systemId ?? CONSTRUCTION_SYSTEM_ID,
      // The literal discriminant is re-branded through the SDK's trusted
      // builder (loud TypeError on an undeclared kind — the fixture path).
      objectType: providerObjectKind(parts.object.objectType),
      objectId: providerObjectId(parts.object.objectId),
      version: providerVersion(parts.object.version),
    }),
    displayName: view.displayName,
    objectStatus: parts.object.status,
    providerUpdatedAt: parts.object.updatedAt,
    observedAt: parts.now,
    extension: view.data,
  });
}
