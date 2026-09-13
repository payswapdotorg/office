// Office adapter-finance — the ERP/finance vocabulary (OFF-024).
//
// THE finance adapter's identity surface, in strictly GENERIC vocabulary
// (freeze A6 + the plan's provider-vocabulary rule): the adapter family is
// 'erp-finance' (an enterprise-resource-planning / accounting family), the
// fixture system is 'erp-instance-01', and the provider object kinds are the
// generic financial object family — account, cost-code, commitment, invoice,
// payment. No real vendor name appears anywhere in this package (the
// boundary test enforces the ban); swapping this adapter for a concrete
// vendor integration means a sibling package owning the real wire formats
// and names, over the SAME @office/adapters-sdk contract.
//
// The OBJECT MAPPING TABLE is this package's heart (the A6/A11 discipline):
// for each provider object kind, the canonical entity kind it translates
// into, the authz capability the sync authorizes through (deny-by-default,
// declared vocabulary), and the LANDED canonical command names proposed for
// created/updated/deleted observations. The adapter NEVER invents canonical
// semantics: every command name below exists in the merged cost domain, and
// the provider transitions with no landed canonical command — a cost-code
// mutation (canonical cost items are append-only budget lines with unique
// codes), an invoice revision (canonical invoice amounts are immutable at
// record time; revisions flow through new invoices, the credit-note
// discipline), an invoice/payment deletion (commercial records and payment
// references are append-only), and an account deletion (budgets keep their
// revision history) — map to NOTHING and fail closed in the translator
// rather than improvising a semantic that does not exist.
//
// Construction of typed literals goes through the landed total parsers on the
// trusted path (parseEntityKind/parseCommandName throw loud TypeErrors on
// invalid literals — the fake-provider idiom), and the capabilities
// declaration is validated through the SDK's own fail-closed parser so the
// table and the AdapterCapabilities value can never drift apart.
import { parseCommandName, parseEntityKind } from '@office/contracts';
import type { CommandName, EntityKind } from '@office/contracts';
import {
  adapterKind,
  parseAdapterCapabilities,
  parseAdapterObjectCapability,
  providerObjectKind,
  providerSystemId,
} from '@office/adapters-sdk';
import type {
  AdapterCapabilities,
  AdapterKind,
  AdapterObjectCapability,
  ProviderObjectKind,
  ProviderSystemId,
} from '@office/adapters-sdk';

// The authz Capability type, reached through the SDK's re-exported contract
// surface (AdapterObjectCapability['capability']) — this package imports
// exactly @office/adapters-sdk, @office/contracts, and @office/domain-kernel,
// never @office/authz directly (the boundary test enforces it).
type Capability = AdapterObjectCapability['capability'];

/** The ERP/finance adapter family kind (generic vocabulary, no vendor). */
export const FINANCE_ADAPTER_KIND: AdapterKind = adapterKind('erp-finance');

/** The provider system the reference fixture syncs against. */
export const FINANCE_SYSTEM_ID: ProviderSystemId = providerSystemId('erp-instance-01');

/** Provider object kind: a chart-of-accounts / project cost account. */
export const ACCOUNT_OBJECT_KIND: ProviderObjectKind = providerObjectKind('account');
/** Provider object kind: a job-costing cost code (a budget line template). */
export const COST_CODE_OBJECT_KIND: ProviderObjectKind = providerObjectKind('cost-code');
/** Provider object kind: a commercial commitment (purchase order / subcontract). */
export const COMMITMENT_OBJECT_KIND: ProviderObjectKind = providerObjectKind('commitment');
/** Provider object kind: an invoice received against a commitment. */
export const INVOICE_OBJECT_KIND: ProviderObjectKind = providerObjectKind('invoice');
/** Provider object kind: a payment made against an invoice. */
export const PAYMENT_OBJECT_KIND: ProviderObjectKind = providerObjectKind('payment');

/**
 * All object kinds the finance adapter declares, in THE finance sync order:
 * reference entities before the commercial entities that reference them
 * (accounts → cost codes → commitments → invoices → payments), so parent
 * mappings are established before children propose commands against them.
 */
export const FINANCE_OBJECT_KINDS: readonly ProviderObjectKind[] = [
  ACCOUNT_OBJECT_KIND,
  COST_CODE_OBJECT_KIND,
  COMMITMENT_OBJECT_KIND,
  INVOICE_OBJECT_KIND,
  PAYMENT_OBJECT_KIND,
];

const trustedEntityKind = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical kind literal: ${raw}`);
  }
  return parsed.value;
};

const trustedCommandName = (raw: string): CommandName => {
  const parsed = parseCommandName(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical command name literal: ${raw}`);
  }
  return parsed.value;
};

/** Canonical kind of an ERP account (landed cost domain: the Budget aggregate). */
export const ACCOUNT_CANONICAL_KIND: EntityKind = trustedEntityKind('budget');
/** Canonical kind of an ERP cost code (landed cost domain: the cost-item line). */
export const COST_CODE_CANONICAL_KIND: EntityKind = trustedEntityKind('cost-item');
/** Canonical kind of an ERP commitment (landed cost domain: the Commitment aggregate). */
export const COMMITMENT_CANONICAL_KIND: EntityKind = trustedEntityKind('commitment');
/** Canonical kind of an ERP invoice (landed cost domain: the Invoice aggregate). */
export const INVOICE_CANONICAL_KIND: EntityKind = trustedEntityKind('invoice');
/** Canonical kind of an ERP payment (landed cost domain: the payment reference). */
export const PAYMENT_CANONICAL_KIND: EntityKind = trustedEntityKind('payment-reference');

// ---- the landed canonical command vocabulary this adapter proposes --------
// cost domain: cost.createBudget / reviseBudget (the budget aggregate + its
// append-only revision snapshots)
export const ACCOUNT_CREATE_COMMAND: CommandName = trustedCommandName('cost.createBudget');
export const ACCOUNT_UPDATE_COMMAND: CommandName = trustedCommandName('cost.reviseBudget');
// cost domain: cost.recordCostItem (an append-only budget line with a unique code)
export const COST_CODE_CREATE_COMMAND: CommandName = trustedCommandName('cost.recordCostItem');
// cost domain: cost.createCommitment / amendCommitment / closeCommitment
export const COMMITMENT_CREATE_COMMAND: CommandName = trustedCommandName('cost.createCommitment');
export const COMMITMENT_UPDATE_COMMAND: CommandName = trustedCommandName('cost.amendCommitment');
export const COMMITMENT_DELETE_COMMAND: CommandName = trustedCommandName('cost.closeCommitment');
// cost domain: cost.recordInvoice (the immutable commercial record)
export const INVOICE_CREATE_COMMAND: CommandName = trustedCommandName('cost.recordInvoice');
// cost domain: cost.referencePayment (an append-only payment reference against an invoice)
export const PAYMENT_CREATE_COMMAND: CommandName = trustedCommandName('cost.referencePayment');

/**
 * One declared object-kind surface: the provider object kind, the canonical
 * entity kind it maps into, the capability the sync authorizes through, and
 * the landed canonical commands proposed for each change kind. `updateCommand`
 * / `deleteCommand` are null when NO landed canonical command expresses the
 * provider's transition — the translator then fails closed (never invents
 * semantics).
 */
export interface FinanceObjectMapping {
  readonly objectKind: ProviderObjectKind;
  readonly canonicalKind: EntityKind;
  readonly capability: Capability;
  readonly createCommand: CommandName;
  readonly updateCommand: CommandName | null;
  readonly deleteCommand: CommandName | null;
}

/**
 * THE object mapping table (A6: external systems are adapters; A11: they sync
 * INTO the canonical graph — everything below maps to LANDED canonical
 * commands of the merged cost domain). The four documented null mappings are
 * the fail-closed gaps: canonical cost items are append-only lines with
 * unique codes, canonical invoice amounts are immutable at record time, and
 * payment references never change or retract — the adapter refuses to invent
 * update/delete semantics the canonical vocabulary does not carry. Capability
 * literals are validated through the SDK's fail-closed parser (which enforces
 * the authz declared vocabulary), so an undeclared capability is a loud
 * module defect, never a silent drift.
 */
const RAW_FINANCE_OBJECT_MAPPINGS = [
  {
    objectKind: ACCOUNT_OBJECT_KIND,
    canonicalKind: ACCOUNT_CANONICAL_KIND,
    capability: 'cost.write',
    createCommand: ACCOUNT_CREATE_COMMAND,
    updateCommand: ACCOUNT_UPDATE_COMMAND,
    deleteCommand: null, // no landed canonical command retires a budget (its revision history stays)
  },
  {
    objectKind: COST_CODE_OBJECT_KIND,
    canonicalKind: COST_CODE_CANONICAL_KIND,
    capability: 'cost.write',
    createCommand: COST_CODE_CREATE_COMMAND,
    updateCommand: null, // canonical cost items are append-only lines with unique codes — no update command
    deleteCommand: null, // and no landed command removes one
  },
  {
    objectKind: COMMITMENT_OBJECT_KIND,
    canonicalKind: COMMITMENT_CANONICAL_KIND,
    capability: 'cost.write',
    createCommand: COMMITMENT_CREATE_COMMAND,
    updateCommand: COMMITMENT_UPDATE_COMMAND,
    deleteCommand: COMMITMENT_DELETE_COMMAND,
  },
  {
    objectKind: INVOICE_OBJECT_KIND,
    canonicalKind: INVOICE_CANONICAL_KIND,
    capability: 'cost.write',
    createCommand: INVOICE_CREATE_COMMAND,
    updateCommand: null, // canonical invoice amounts are immutable at record time (credit-note discipline)
    deleteCommand: null, // an invoice is an immutable commercial record — never deleted canonically
  },
  {
    objectKind: PAYMENT_OBJECT_KIND,
    canonicalKind: PAYMENT_CANONICAL_KIND,
    capability: 'cost.write',
    createCommand: PAYMENT_CREATE_COMMAND,
    updateCommand: null, // payment references are append-only and never change
    deleteCommand: null, // and never retract
  },
] as const;

export const FINANCE_OBJECT_MAPPINGS: readonly FinanceObjectMapping[] =
  RAW_FINANCE_OBJECT_MAPPINGS.map((raw) => {
    const parsed = parseAdapterObjectCapability({
      objectKind: raw.objectKind,
      canonicalKind: raw.canonicalKind,
      capability: raw.capability,
    });
    if (!parsed.ok) {
      throw new TypeError(
        `invalid finance object mapping for '${raw.objectKind}': ${JSON.stringify(parsed.error)}`,
      );
    }
    return {
      objectKind: parsed.value.objectKind,
      canonicalKind: parsed.value.canonicalKind,
      capability: parsed.value.capability,
      createCommand: raw.createCommand,
      updateCommand: raw.updateCommand,
      deleteCommand: raw.deleteCommand,
    } satisfies FinanceObjectMapping;
  });

/**
 * The AdapterCapabilities value the adapter declares — composed FROM the
 * mapping table and validated through the SDK's own fail-closed parser (the
 * parser re-validates object-kind grammar, canonical-kind grammar, and the
 * authz declared-capability vocabulary), so the table and the declared
 * capabilities can never drift apart. A violation is a module defect (loud
 * TypeError on the trusted path).
 */
export const FINANCE_CAPABILITIES: AdapterCapabilities = (() => {
  const parsed = parseAdapterCapabilities({
    objectKinds: FINANCE_OBJECT_MAPPINGS.map((mapping) => ({
      objectKind: mapping.objectKind,
      canonicalKind: mapping.canonicalKind,
      capability: mapping.capability,
    })),
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid finance capabilities: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
})();

/** The capability names the adapter actor must hold (policy/test wiring). */
export const FINANCE_CAPABILITY_NAMES: readonly Capability[] =
  FINANCE_OBJECT_MAPPINGS.map((mapping) => mapping.capability);

/**
 * The declared mapping of one provider object kind, or null when the adapter
 * does not declare that kind (fail closed — an undeclared kind is never
 * silently translated).
 */
export function financeObjectMappingOf(
  objectKind: ProviderObjectKind,
): FinanceObjectMapping | null {
  return FINANCE_OBJECT_MAPPINGS.find((mapping) => mapping.objectKind === objectKind) ?? null;
}
