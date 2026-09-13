// Office adapter-finance — the deterministic ERP/finance provider fixture
// (OFF-024).
//
// A complete in-memory, DETERMINISTIC enterprise-resource-planning provider
// at reference-fixture scale: chart-of-accounts/project cost accounts, job
// costing cost codes, commercial commitments (purchase orders and
// subcontracts), invoices with revision history, and payments against those
// invoices. The adapter (adapter.ts) is driven entirely by this injected
// provider DATA — the package performs no network I/O of any kind; swapping
// the fixture for a real ERP client means implementing the same store reads
// behind the adapter, not changing the translation seams.
//
// Determinism rules (mirroring the adapters-sdk fake-provider fixture and
// the landed reference adapters):
//   - objects live in insertion order; versions bump monotonically per
//     object ('v1', 'v2', …) on EVERY mutation, tombstones included — the
//     version is the ERP's revision tag and the source-version mapping's
//     identity;
//   - every mutation is pure data (no clock, no randomness) — instants are
//     caller-supplied values;
//   - webhook pushes carry the provider's WIRE format body plus a
//     deterministic signature header the matching injected verifier checks
//     (webhook-ingest.ts owns that convention).
//
// The store's object shapes are PROVIDER-native (this is the one place
// provider-specific structure exists by design — freeze A6): plain string
// ids, the provider's own field names. Identity references that must be
// canonical office ids (project, budget, cost item, commitment, invoice) are
// carried as the office-issued id strings the ERP learned when the finance
// workspace was provisioned from office — the adapter never manufactures
// canonical ids out of provider ids (freeze anti-pattern A10: provider ids
// are never primary keys; mappings.ts parses these references fail-closed).
import type { Timestamp } from '@office/contracts';
import type { AdapterJsonObject, RawWebhook } from '@office/adapters-sdk';
import { FINANCE_ADAPTER_KIND, FINANCE_SYSTEM_ID } from './vocabulary';
import { financeObjectViewOf } from './snapshot-translation';
import {
  ERP_WEBHOOK_SIGNATURE_HEADER,
  erpWebhookSignature,
} from './webhook-ingest';

/** One chart-of-accounts / project cost account in the ERP. */
export interface ErpAccountObject {
  readonly objectType: 'account';
  readonly objectId: string;
  readonly version: string;
  /** The account's chart code, e.g. '5010'. */
  readonly code: string;
  readonly name: string;
  /** The account's currency (3 uppercase letters). */
  readonly currency: string;
  /** Office-issued project id (learned at workspace provisioning). */
  readonly projectRef: string;
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** One job-costing cost code in the ERP (a budget line template). */
export interface ErpCostCodeObject {
  readonly objectType: 'cost-code';
  readonly objectId: string;
  readonly version: string;
  readonly code: string;
  readonly description: string;
  readonly unit: string;
  /** Office-issued budget id the cost code belongs to (provisioned identity). */
  readonly budgetRef: string;
  /** Standard quantity in integer milli-units (quantity × 1000). */
  readonly quantityMilli: number;
  /** Unit rate in integer minor units per whole unit. */
  readonly unitRateMinor: number;
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** One commitment line (an office-issued cost-item link + an amount). */
export interface ErpCommitmentLine {
  /** Office-issued cost-item id (provisioned identity). */
  readonly costItemRef: string;
  readonly description: string;
  readonly amountMinor: number;
}

/** One commercial commitment (a purchase order or a subcontract) in the ERP. */
export interface ErpCommitmentObject {
  readonly objectType: 'commitment';
  readonly objectId: string;
  readonly version: string;
  /** The commercial document number, e.g. 'PO-2026-014'. */
  readonly number: string;
  readonly commitmentKind: 'purchase-order' | 'subcontract';
  readonly description: string;
  readonly currency: string;
  /** Office-issued budget id the commitment draws against (provisioned identity). */
  readonly budgetRef: string;
  /** Append-only commitment lines. */
  readonly lines: readonly ErpCommitmentLine[];
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** One invoice line (a description + an amount in minor units). */
export interface ErpInvoiceLine {
  readonly description: string;
  readonly amountMinor: number;
}

/** One invoice received against a commitment in the ERP. */
export interface ErpInvoiceObject {
  readonly objectType: 'invoice';
  readonly objectId: string;
  readonly version: string;
  /** The invoice number, e.g. 'INV-2026-0301'. */
  readonly number: string;
  readonly description: string;
  readonly currency: string;
  /** Office-issued commitment id the invoice is billed against (provisioned identity). */
  readonly commitmentRef: string;
  readonly issuedOn: Timestamp | null;
  readonly dueOn: Timestamp | null;
  /** The invoice lines (the disputed amount is their sum). */
  readonly lines: readonly ErpInvoiceLine[];
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** One payment made against an invoice in the ERP. */
export interface ErpPaymentObject {
  readonly objectType: 'payment';
  readonly objectId: string;
  readonly version: string;
  /** Office-issued invoice id the payment applies to (provisioned identity). */
  readonly invoiceRef: string;
  /** The external payment reference (a trace or check number). */
  readonly reference: string;
  readonly amountMinor: number;
  readonly paidAt: Timestamp;
  readonly status: 'active' | 'deleted';
  readonly updatedAt: Timestamp | null;
}

/** Any object the ERP store holds. */
export type ErpProviderObject =
  | ErpAccountObject
  | ErpCostCodeObject
  | ErpCommitmentObject
  | ErpInvoiceObject
  | ErpPaymentObject;

/** Which provider event kinds the ERP pushes (the webhook wire vocabulary). */
export type ErpEventKind = 'created' | 'updated' | 'deleted';

/**
 * The deterministic in-memory ERP provider store. All mutations throw loud
 * TypeErrors on unknown/duplicate ids (the trusted fixture path); every
 * version bump is pure bookkeeping — same mutation sequence, same versions.
 */
export interface ErpProviderStore {
  /** Every held object, in insertion order (tombstones included). */
  readonly objects: readonly ErpProviderObject[];
  /** The object with one id, or null when absent (tombstones included). */
  find(objectId: string): ErpProviderObject | null;

  putAccount(input: {
    readonly objectId: string;
    readonly code: string;
    readonly name: string;
    readonly currency: string;
    readonly projectRef: string;
    readonly updatedAt?: Timestamp | null;
  }): ErpAccountObject;
  renameAccount(
    objectId: string,
    patch: {
      readonly name?: string;
      readonly currency?: string;
      readonly updatedAt?: Timestamp | null;
    },
  ): ErpAccountObject;
  deleteAccount(objectId: string, updatedAt?: Timestamp | null): ErpAccountObject;

  putCostCode(input: {
    readonly objectId: string;
    readonly code: string;
    readonly description: string;
    readonly unit: string;
    readonly budgetRef: string;
    readonly quantityMilli: number;
    readonly unitRateMinor: number;
    readonly updatedAt?: Timestamp | null;
  }): ErpCostCodeObject;
  updateCostCode(
    objectId: string,
    patch: {
      readonly description?: string;
      readonly unitRateMinor?: number;
      readonly updatedAt?: Timestamp | null;
    },
  ): ErpCostCodeObject;
  deleteCostCode(objectId: string, updatedAt?: Timestamp | null): ErpCostCodeObject;

  putCommitment(input: {
    readonly objectId: string;
    readonly number: string;
    readonly commitmentKind: 'purchase-order' | 'subcontract';
    readonly description: string;
    readonly currency: string;
    readonly budgetRef: string;
    readonly lines?: readonly ErpCommitmentLine[];
    readonly updatedAt?: Timestamp | null;
  }): ErpCommitmentObject;
  updateCommitment(
    objectId: string,
    patch: {
      readonly description?: string;
      /** Appended to the append-only line list. */
      readonly appendLines?: readonly ErpCommitmentLine[];
      readonly updatedAt?: Timestamp | null;
    },
  ): ErpCommitmentObject;
  /** Void a commitment (a tombstone version — the commercial void). */
  voidCommitment(objectId: string, updatedAt?: Timestamp | null): ErpCommitmentObject;

  putInvoice(input: {
    readonly objectId: string;
    readonly number: string;
    readonly description: string;
    readonly currency: string;
    readonly commitmentRef: string;
    readonly issuedOn?: Timestamp | null;
    readonly dueOn?: Timestamp | null;
    readonly lines: readonly ErpInvoiceLine[];
    readonly updatedAt?: Timestamp | null;
  }): ErpInvoiceObject;
  /**
   * Revise an invoice's header/lines — the ERP-side revision that bumps the
   * version. (The canonical side has NO landed update command for invoices:
   * the translator fails closed on this transition — the documented gap.)
   */
  reviseInvoice(
    objectId: string,
    patch: {
      readonly description?: string;
      readonly dueOn?: Timestamp | null;
      /** Replaces the line list. */
      readonly lines?: readonly ErpInvoiceLine[];
      readonly updatedAt?: Timestamp | null;
    },
  ): ErpInvoiceObject;
  deleteInvoice(objectId: string, updatedAt?: Timestamp | null): ErpInvoiceObject;

  putPayment(input: {
    readonly objectId: string;
    readonly invoiceRef: string;
    readonly reference: string;
    readonly amountMinor: number;
    readonly paidAt: Timestamp;
    readonly updatedAt?: Timestamp | null;
  }): ErpPaymentObject;

  /** Mark the provider degraded (the healthCheck surface observes it). */
  degrade(detail: string): void;
  /** Clear the degraded mark. */
  recover(): void;
  /** The degraded diagnostic, or null when the provider is healthy. */
  degradedDetail(): string | null;

  /**
   * Emit the raw webhook push for one object's current state, in the ERP's
   * WIRE format, signed with the deterministic signature convention the
   * injected verifier checks (webhook-ingest.ts).
   */
  emitWebhook(eventKind: ErpEventKind, objectId: string): RawWebhook;
}

/** Create the deterministic in-memory ERP provider store. */
export function createErpProviderStore(): ErpProviderStore {
  const objects: ErpProviderObject[] = [];
  const versions = new Map<string, number>();
  let degradedDetail: string | null = null;

  const nextVersion = (objectId: string): string => {
    const next = (versions.get(objectId) ?? 0) + 1;
    versions.set(objectId, next);
    return `v${next}`;
  };

  const findObject = (objectId: string): ErpProviderObject => {
    const found = objects.find((entry) => entry.objectId === objectId);
    if (found === undefined) {
      throw new TypeError(`ERP provider has no object '${objectId}'`);
    }
    return found;
  };

  const replace = (
    current: ErpProviderObject,
    updated: ErpProviderObject,
  ): void => {
    objects[objects.indexOf(current)] = updated;
  };

  return {
    get objects() {
      return [...objects];
    },
    find(objectId) {
      return objects.find((entry) => entry.objectId === objectId) ?? null;
    },

    putAccount(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`ERP provider already has object '${input.objectId}'`);
      }
      const object: ErpAccountObject = {
        objectType: 'account',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        code: input.code,
        name: input.name,
        currency: input.currency,
        projectRef: input.projectRef,
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    renameAccount(objectId, patch) {
      const current = findObject(objectId) as ErpAccountObject;
      const updated: ErpAccountObject = {
        ...current,
        name: patch.name ?? current.name,
        currency: patch.currency ?? current.currency,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    deleteAccount(objectId, updatedAt) {
      const current = findObject(objectId) as ErpAccountObject;
      const deleted: ErpAccountObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    putCostCode(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`ERP provider already has object '${input.objectId}'`);
      }
      const object: ErpCostCodeObject = {
        objectType: 'cost-code',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        code: input.code,
        description: input.description,
        unit: input.unit,
        budgetRef: input.budgetRef,
        quantityMilli: input.quantityMilli,
        unitRateMinor: input.unitRateMinor,
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    updateCostCode(objectId, patch) {
      const current = findObject(objectId) as ErpCostCodeObject;
      const updated: ErpCostCodeObject = {
        ...current,
        description: patch.description ?? current.description,
        unitRateMinor: patch.unitRateMinor ?? current.unitRateMinor,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    deleteCostCode(objectId, updatedAt) {
      const current = findObject(objectId) as ErpCostCodeObject;
      const deleted: ErpCostCodeObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    putCommitment(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`ERP provider already has object '${input.objectId}'`);
      }
      const object: ErpCommitmentObject = {
        objectType: 'commitment',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        number: input.number,
        commitmentKind: input.commitmentKind,
        description: input.description,
        currency: input.currency,
        budgetRef: input.budgetRef,
        lines: input.lines ?? [],
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    updateCommitment(objectId, patch) {
      const current = findObject(objectId) as ErpCommitmentObject;
      const updated: ErpCommitmentObject = {
        ...current,
        description: patch.description ?? current.description,
        lines: [...current.lines, ...(patch.appendLines ?? [])],
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    voidCommitment(objectId, updatedAt) {
      const current = findObject(objectId) as ErpCommitmentObject;
      const deleted: ErpCommitmentObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    putInvoice(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`ERP provider already has object '${input.objectId}'`);
      }
      const object: ErpInvoiceObject = {
        objectType: 'invoice',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        number: input.number,
        description: input.description,
        currency: input.currency,
        commitmentRef: input.commitmentRef,
        issuedOn: input.issuedOn ?? null,
        dueOn: input.dueOn ?? null,
        lines: input.lines,
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
    },
    reviseInvoice(objectId, patch) {
      const current = findObject(objectId) as ErpInvoiceObject;
      const updated: ErpInvoiceObject = {
        ...current,
        description: patch.description ?? current.description,
        dueOn: patch.dueOn !== undefined ? patch.dueOn : current.dueOn,
        lines: patch.lines ?? current.lines,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, updated);
      return updated;
    },
    deleteInvoice(objectId, updatedAt) {
      const current = findObject(objectId) as ErpInvoiceObject;
      const deleted: ErpInvoiceObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      replace(current, deleted);
      return deleted;
    },

    putPayment(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`ERP provider already has object '${input.objectId}'`);
      }
      const object: ErpPaymentObject = {
        objectType: 'payment',
        objectId: input.objectId,
        version: nextVersion(input.objectId),
        invoiceRef: input.invoiceRef,
        reference: input.reference,
        amountMinor: input.amountMinor,
        paidAt: input.paidAt,
        status: 'active',
        updatedAt: input.updatedAt ?? null,
      };
      objects.push(object);
      return object;
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
      const view = financeObjectViewOf(object);
      const body: AdapterJsonObject = {
        kind: 'erp-webhook-event',
        eventType: `${object.objectType}.${eventKind}`,
        objectId: object.objectId,
        revisionTag: object.version,
        occurredAt: object.updatedAt,
        payload: view.data,
      };
      return {
        kind: 'raw-webhook',
        adapterKind: FINANCE_ADAPTER_KIND,
        systemId: FINANCE_SYSTEM_ID,
        headers: { [ERP_WEBHOOK_SIGNATURE_HEADER]: erpWebhookSignature(body) },
        body,
      };
    },
  };
}
