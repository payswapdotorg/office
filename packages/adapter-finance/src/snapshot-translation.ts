// Office adapter-finance — the snapshot translation seam (OFF-024).
//
// The provider object → ProviderSnapshot translation: every ERP object the
// fixture store holds is observed as ONE provider-neutral ProviderSnapshot
// (the SDK's observation contract — the only shape the SDK engines accept),
// carrying the object's identity at its current version (the SourceRef), the
// typed core fields every provider object has, and the per-kind provider
// data view in the open-keyed extension bag.
//
// The per-kind data views are DELIBERATELY provider-native field names (this
// is the one place provider-specific structure exists by design — freeze A6):
// the extension bag is what the snapshot stream AND the webhook payload
// carry, and the fail-closed per-kind parsers (mappings.ts) are its only
// consumer. Because both intake paths carry the SAME data for the SAME
// provider object version, they converge on one command per provider object
// version (the SDK's SourceRef-derived idempotency keys).
//
// Identity references inside the views (project, budget, cost item,
// commitment, invoice) are the OFFICE-ISSUED ids the ERP learned when the
// finance workspace was provisioned from office — the adapter never
// manufactures a canonical id out of a provider object id (freeze
// anti-pattern A10: provider ids are never primary keys).
import type { TenantId, Timestamp } from '@office/contracts';
import {
  providerObjectId,
  providerObjectKind,
  providerSnapshot,
  providerVersion,
  sourceRef,
} from '@office/adapters-sdk';
import type { AdapterJsonObject, ProviderSnapshot, ProviderSystemId } from '@office/adapters-sdk';
import { FINANCE_ADAPTER_KIND, FINANCE_SYSTEM_ID } from './vocabulary';
import type { ErpProviderObject } from './provider-fixture';

/**
 * The neutral view of one provider object: its display name and its payload
 * data (the extension bag / webhook payload). Deterministic, pure — derived
 * only from the object's own fields, never from a clock or a counter.
 */
export interface FinanceObjectView {
  readonly displayName: string;
  readonly data: AdapterJsonObject;
}

/**
 * Derive the neutral (display name, payload data) view of one provider
 * object. Throws a loud TypeError on an object kind the mapping table does
 * not declare (the fixture store only holds declared kinds — the trusted
 * path).
 */
export function financeObjectViewOf(object: ErpProviderObject): FinanceObjectView {
  // Captured before the switch narrows the discriminant (the default branch
  // reports it; by then the type is `never`).
  const objectType: string = object.objectType;
  switch (object.objectType) {
    case 'account':
      return {
        displayName: `${object.code} ${object.name}`,
        data: {
          code: object.code,
          name: object.name,
          currency: object.currency,
          projectRef: object.projectRef,
        },
      };
    case 'cost-code':
      return {
        displayName: object.code,
        data: {
          code: object.code,
          description: object.description,
          unit: object.unit,
          budgetRef: object.budgetRef,
          quantityMilli: object.quantityMilli,
          unitRateMinor: object.unitRateMinor,
        },
      };
    case 'commitment':
      return {
        displayName: object.number,
        data: {
          number: object.number,
          commitmentKind: object.commitmentKind,
          description: object.description,
          currency: object.currency,
          budgetRef: object.budgetRef,
          lines: object.lines.map((line) => ({
            costItemRef: line.costItemRef,
            description: line.description,
            amountMinor: line.amountMinor,
          })),
        },
      };
    case 'invoice':
      return {
        displayName: object.number,
        data: {
          number: object.number,
          description: object.description,
          currency: object.currency,
          commitmentRef: object.commitmentRef,
          issuedOn: object.issuedOn,
          dueOn: object.dueOn,
          lines: object.lines.map((line) => ({
            description: line.description,
            amountMinor: line.amountMinor,
          })),
        },
      };
    case 'payment':
      return {
        displayName: object.reference,
        data: {
          invoiceRef: object.invoiceRef,
          reference: object.reference,
          amountMinor: object.amountMinor,
          paidAt: object.paidAt,
        },
      };
    default:
      throw new TypeError(
        `finance adapter does not translate object kind '${objectType}'`,
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
export function financeSnapshotOf(parts: {
  readonly object: ErpProviderObject;
  readonly tenantId: TenantId;
  readonly now: Timestamp;
  /** The provider system being synced (defaults to the reference fixture's). */
  readonly systemId?: ProviderSystemId;
}): ProviderSnapshot {
  const view = financeObjectViewOf(parts.object);
  return providerSnapshot({
    tenantId: parts.tenantId,
    source: sourceRef({
      adapterKind: FINANCE_ADAPTER_KIND,
      systemId: parts.systemId ?? FINANCE_SYSTEM_ID,
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
