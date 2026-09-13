import { describe, expect, it } from 'vitest';
import { parseEntityId, parseEntityKind } from '@office/contracts';
import type { AdapterCommandInput } from '@office/adapters-sdk';
import {
  coordinateOf,
  providerObjectId,
  providerObjectKind,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
} from '@office/adapters-sdk';
import { createInMemorySourceMappingStore } from '@office/adapters-sdk';
import {
  ACCOUNT_OBJECT_KIND,
  FINANCE_ADAPTER_KIND,
  FINANCE_SYSTEM_ID,
  INVOICE_OBJECT_KIND,
} from './vocabulary';
import {
  bindFinanceReference,
  createFinanceTranslator,
  parseAccountProviderData,
  parseCommitmentProviderData,
  parseCostCodeProviderData,
  parseInvoiceProviderData,
  parsePaymentProviderData,
  resolveFinanceReference,
} from './mappings';
import {
  BUDGET_REF_ID,
  COMMITMENT_REF_ID,
  COST_ITEM_REF_ID,
  INVOICE_REF_ID,
  NOW_1,
  NOW_2,
  PROJECT_ID,
  TENANT_A,
  TENANT_B,
  entity,
  unwrap,
  version,
} from './test-support';

// OFF-024 — the financial reference mapping and the object command
// translation: one provider observation (the AdapterCommandInput the SDK
// engines compose) becomes a typed canonical command proposal whose payload
// mirrors the LANDED cost-domain payload shapes (cost.createBudget/
// reviseBudget, cost.recordCostItem, cost.createCommitment/amendCommitment/
// closeCommitment, cost.recordInvoice, cost.referencePayment). Everything is
// fail-closed and deterministic: malformed provider data and unmapped
// transitions are typed failures, the A10 rule keeps office-issued ids in
// every identity field, and the same input always yields the identical
// proposal. Remapping a bound provider reference is the store's typed
// collision — an explicit conflict, never an overwrite.

const translator = createFinanceTranslator();

const input = (parts: {
  readonly objectType: string;
  readonly objectId: string;
  readonly version: string;
  readonly changeKind: AdapterCommandInput['changeKind'];
  readonly data: Record<string, unknown>;
  readonly canonical?: { readonly entityKind: string; readonly entityId: string } | null;
  readonly canonicalVersion?: number | null;
  readonly displayName?: string | null;
}): AdapterCommandInput => ({
  origin: 'sync',
  tenantId: TENANT_A,
  source: sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectType: providerObjectKind(parts.objectType),
    objectId: providerObjectId(parts.objectId),
    version: providerVersion(parts.version),
  }),
  canonical:
    parts.canonical === undefined || parts.canonical === null
      ? null
      : {
          entityKind: unwrap(parseEntityKind(parts.canonical.entityKind)),
          entityId: unwrap(parseEntityId(parts.canonical.entityId)),
        },
  canonicalVersion:
    parts.canonicalVersion === undefined || parts.canonicalVersion === null
      ? null
      : version(parts.canonicalVersion),
  changeKind: parts.changeKind,
  displayName: parts.displayName === undefined ? null : parts.displayName,
  // The test helper's loose record is the translator's untrusted input.
  data: parts.data as AdapterCommandInput['data'],
});

const ACCOUNT_DATA = {
  code: '5010',
  name: 'Earthworks costs',
  currency: 'EUR',
  projectRef: PROJECT_ID,
};

const COST_CODE_DATA = {
  code: '0310',
  description: 'Bulk excavation',
  unit: 'm3',
  budgetRef: BUDGET_REF_ID,
  quantityMilli: 1_500,
  unitRateMinor: 2_400,
};

const COMMITMENT_DATA = {
  number: 'PO-2026-014',
  commitmentKind: 'purchase-order',
  description: 'Phase one earthworks package',
  currency: 'EUR',
  budgetRef: BUDGET_REF_ID,
  lines: [
    { costItemRef: COST_ITEM_REF_ID, description: 'Bulk excavation', amountMinor: 3_600_000 },
  ],
};

const INVOICE_DATA = {
  number: 'INV-2026-0301',
  description: 'Earthworks invoice 1',
  currency: 'EUR',
  commitmentRef: COMMITMENT_REF_ID,
  issuedOn: NOW_1,
  dueOn: NOW_2,
  lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
};

const PAYMENT_DATA = {
  invoiceRef: INVOICE_REF_ID,
  reference: 'TRC-8841',
  amountMinor: 250_000,
  paidAt: NOW_2,
};

describe('finance command translation (OFF-024)', () => {
  it('proposes cost.createBudget for a created ERP account (the budget container)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: 'account',
        objectId: 'acc-1',
        version: 'v1',
        changeKind: 'created',
        data: ACCOUNT_DATA,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.createBudget');
    expect(proposal.value.payload).toStrictEqual({
      name: '5010 Earthworks costs',
      currency: 'EUR',
      projectId: PROJECT_ID,
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(
          sourceRef({
            adapterKind: FINANCE_ADAPTER_KIND,
            systemId: FINANCE_SYSTEM_ID,
            objectType: ACCOUNT_OBJECT_KIND,
            objectId: providerObjectId('acc-1'),
            version: providerVersion('v1'),
          }),
        ),
        providerData: ACCOUNT_DATA,
      },
    });
  });

  it('proposes cost.reviseBudget for a renamed ERP account (the mapped update path)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: 'account',
        objectId: 'acc-1',
        version: 'v2',
        changeKind: 'updated',
        data: { ...ACCOUNT_DATA, name: 'Earthworks costs (renamed)' },
        canonical: { entityKind: 'budget', entityId: entity(1) },
        canonicalVersion: 3,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.reviseBudget');
    expect(proposal.value.payload).toStrictEqual({
      budgetId: entity(1),
      expectedVersion: 3,
      label: 'ERP account 5010 revision v2: Earthworks costs (renamed)',
    });
  });

  it('proposes cost.recordCostItem for a created ERP cost code (the budget line)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: 'cost-code',
        objectId: 'cc-1',
        version: 'v1',
        changeKind: 'created',
        data: COST_CODE_DATA,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.recordCostItem');
    expect(proposal.value.payload).toStrictEqual({
      budgetId: BUDGET_REF_ID,
      expectedVersion: 1,
      code: '0310',
      description: 'Bulk excavation',
      unit: 'm3',
      quantityMilli: 1_500,
      unitRateMinor: 2_400,
    });
  });

  it('proposes cost.createCommitment for a created ERP commitment (lines included)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: 'commitment',
        objectId: 'po-1',
        version: 'v1',
        changeKind: 'created',
        data: COMMITMENT_DATA,
        displayName: 'PO-2026-014',
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.createCommitment');
    expect(proposal.value.payload).toStrictEqual({
      budgetId: BUDGET_REF_ID,
      number: 'PO-2026-014',
      commitmentKind: 'purchase-order',
      description: 'Phase one earthworks package',
      currency: 'EUR',
      lines: [
        { costItemId: COST_ITEM_REF_ID, description: 'Bulk excavation', amountMinor: 3_600_000 },
      ],
    });
  });

  it('proposes cost.amendCommitment for an appended commitment line (the latest only)', () => {
    const appended = [
      ...COMMITMENT_DATA.lines,
      { costItemRef: entity(21), description: 'Haulage', amountMinor: 480_000 },
    ];
    const proposal = translator.proposeCommand(
      input({
        objectType: 'commitment',
        objectId: 'po-1',
        version: 'v2',
        changeKind: 'updated',
        data: { ...COMMITMENT_DATA, lines: appended },
        canonical: { entityKind: 'commitment', entityId: entity(5) },
        canonicalVersion: 2,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.amendCommitment');
    expect(proposal.value.payload).toStrictEqual({
      commitmentId: entity(5),
      expectedVersion: 2,
      budgetId: BUDGET_REF_ID,
      reason: 'ERP commitment PO-2026-014 revision v2',
      lines: [{ costItemId: entity(21), description: 'Haulage', amountMinor: 480_000 }],
    });
  });

  it('proposes cost.closeCommitment for a voided ERP commitment (the reason cites the source)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: 'commitment',
        objectId: 'po-1',
        version: 'v3',
        changeKind: 'deleted',
        data: COMMITMENT_DATA,
        canonical: { entityKind: 'commitment', entityId: entity(5) },
        canonicalVersion: 2,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.closeCommitment');
    expect(proposal.value.payload).toStrictEqual({
      commitmentId: entity(5),
      expectedVersion: 2,
      reason: 'ERP commitment PO-2026-014 voided in the ERP at revision v3',
    });
  });

  it('proposes cost.recordInvoice for a created ERP invoice (the immutable commercial record)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: 'invoice',
        objectId: 'inv-1',
        version: 'v1',
        changeKind: 'created',
        data: INVOICE_DATA,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.recordInvoice');
    expect(proposal.value.payload).toMatchObject({
      commitmentId: COMMITMENT_REF_ID,
      number: 'INV-2026-0301',
      description: 'Earthworks invoice 1',
      currency: 'EUR',
      issuedOn: NOW_1,
      dueOn: NOW_2,
      lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
    });
    // The provenance-carrying extension metadata binds the proposal to the
    // exact source version (the idempotency trail).
    expect(
      (proposal.value.payload as { extensionMetadata?: { sourceKey?: string } }).extensionMetadata
        ?.sourceKey,
    ).toBe(
      sourceRefKeyOf(
        sourceRef({
          adapterKind: FINANCE_ADAPTER_KIND,
          systemId: FINANCE_SYSTEM_ID,
          objectType: INVOICE_OBJECT_KIND,
          objectId: providerObjectId('inv-1'),
          version: providerVersion('v1'),
        }),
      ),
    );
  });

  it('proposes cost.referencePayment for a created ERP payment (the append-only reference)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: 'payment',
        objectId: 'pay-1',
        version: 'v1',
        changeKind: 'created',
        data: PAYMENT_DATA,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('cost.referencePayment');
    expect(proposal.value.payload).toStrictEqual({
      invoiceId: INVOICE_REF_ID,
      expectedVersion: 1,
      reference: 'TRC-8841',
      amountMinor: 250_000,
      paidAt: NOW_2,
    });
  });

  // ---- the fail-closed transition discipline --------------------------------
  it('FAILS CLOSED on every unmapped provider transition (typed, no invented semantics)', () => {
    const canonical = { entityKind: 'invoice', entityId: entity(9) };
    const cases: readonly [string, AdapterCommandInput][] = [
      [
        'an account deletion (budgets keep their revision history)',
        input({
          objectType: 'account',
          objectId: 'acc-1',
          version: 'v3',
          changeKind: 'deleted',
          data: ACCOUNT_DATA,
          canonical: { entityKind: 'budget', entityId: entity(1) },
        }),
      ],
      [
        'a cost-code update (append-only budget lines with unique codes)',
        input({
          objectType: 'cost-code',
          objectId: 'cc-1',
          version: 'v2',
          changeKind: 'updated',
          data: COST_CODE_DATA,
          canonical: { entityKind: 'cost-item', entityId: entity(2) },
        }),
      ],
      [
        'a cost-code deletion',
        input({
          objectType: 'cost-code',
          objectId: 'cc-1',
          version: 'v3',
          changeKind: 'deleted',
          data: COST_CODE_DATA,
          canonical: { entityKind: 'cost-item', entityId: entity(2) },
        }),
      ],
      [
        'an invoice revision (canonical invoice amounts are immutable at record time)',
        input({
          objectType: 'invoice',
          objectId: 'inv-1',
          version: 'v2',
          changeKind: 'updated',
          data: INVOICE_DATA,
          canonical,
        }),
      ],
      [
        'an invoice deletion (an immutable commercial record)',
        input({
          objectType: 'invoice',
          objectId: 'inv-1',
          version: 'v3',
          changeKind: 'deleted',
          data: INVOICE_DATA,
          canonical,
        }),
      ],
      [
        'a payment update (payment references never change)',
        input({
          objectType: 'payment',
          objectId: 'pay-1',
          version: 'v2',
          changeKind: 'updated',
          data: PAYMENT_DATA,
          canonical: { entityKind: 'payment-reference', entityId: entity(11) },
        }),
      ],
      [
        'a payment deletion (payment references never retract)',
        input({
          objectType: 'payment',
          objectId: 'pay-1',
          version: 'v3',
          changeKind: 'deleted',
          data: PAYMENT_DATA,
          canonical: { entityKind: 'payment-reference', entityId: entity(11) },
        }),
      ],
    ];
    for (const [label, commandInput] of cases) {
      const rejected = translator.proposeCommand(commandInput);
      expect(rejected.ok, label).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.error.code, label).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code, label).toBe('provider-transition-unmapped');
    }
  });

  it('fails closed on an updated commitment with no lines (nothing to amend)', () => {
    const rejected = translator.proposeCommand(
      input({
        objectType: 'commitment',
        objectId: 'po-1',
        version: 'v2',
        changeKind: 'updated',
        data: { ...COMMITMENT_DATA, lines: [] },
        canonical: { entityKind: 'commitment', entityId: entity(5) },
      }),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.details[0]?.code).toBe('provider-update-without-lines');
  });

  it('requires a resolved canonical target for updates and deletions', () => {
    // An account update has a landed command (cost.reviseBudget) and a
    // commitment deletion has one (cost.closeCommitment): both MUST resolve
    // the mapped canonical target before any payload is composed — an
    // update/deletion without one is the typed canonical-target-required
    // failure (the engine always provides it through the mapping record).
    const update = translator.proposeCommand(
      input({
        objectType: 'account',
        objectId: 'acc-1',
        version: 'v2',
        changeKind: 'updated',
        data: ACCOUNT_DATA,
        canonical: null,
      }),
    );
    expect(update.ok, 'updated').toBe(false);
    if (update.ok) return;
    expect(update.error.details[0]?.code, 'updated').toBe('canonical-target-required');

    const deletion = translator.proposeCommand(
      input({
        objectType: 'commitment',
        objectId: 'po-1',
        version: 'v2',
        changeKind: 'deleted',
        data: COMMITMENT_DATA,
        canonical: null,
      }),
    );
    expect(deletion.ok, 'deleted').toBe(false);
    if (deletion.ok) return;
    expect(deletion.error.details[0]?.code, 'deleted').toBe('canonical-target-required');
  });

  it('fails closed on malformed provider data (typed, with field paths)', () => {
    const cases: readonly [string, AdapterCommandInput][] = [
      [
        'a non-object payload',
        input({ objectType: 'account', objectId: 'acc-1', version: 'v1', changeKind: 'created', data: {} as Record<string, unknown> }),
      ],
      [
        'a malformed currency',
        input({
          objectType: 'account',
          objectId: 'acc-1',
          version: 'v1',
          changeKind: 'created',
          data: { ...ACCOUNT_DATA, currency: 'eu' },
        }),
      ],
      [
        'an unknown key',
        input({
          objectType: 'invoice',
          objectId: 'inv-1',
          version: 'v1',
          changeKind: 'created',
          data: { ...INVOICE_DATA, memo: 'off-wire field' },
        }),
      ],
      [
        'a non-integer amount',
        input({
          objectType: 'invoice',
          objectId: 'inv-1',
          version: 'v1',
          changeKind: 'created',
          data: {
            ...INVOICE_DATA,
            lines: [{ description: 'Phase one earthworks', amountMinor: 2_500.5 }],
          },
        }),
      ],
      [
        'a provider id in an identity field (A10: provider ids are never canonical ids)',
        input({
          objectType: 'invoice',
          objectId: 'inv-1',
          version: 'v1',
          changeKind: 'created',
          data: { ...INVOICE_DATA, commitmentRef: 'inv-1' },
        }),
      ],
    ];
    for (const [label, commandInput] of cases) {
      const rejected = translator.proposeCommand(commandInput);
      expect(rejected.ok, label).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.error.code, label).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code, label).toMatch(/^provider-data-/);
    }
  });

  it('fails closed on undeclared object kinds', () => {
    const rejected = translator.proposeCommand(
      input({
        objectType: 'timesheet',
        objectId: 'ts-1',
        version: 'v1',
        changeKind: 'created',
        data: { any: 'payload' },
      }),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('invariant-violation');
    expect(rejected.error.details[0]?.code).toBe('object-kind-not-declared');
  });

  it('is deterministic: the same input yields the identical proposal', () => {
    const commandInput = input({
      objectType: 'invoice',
      objectId: 'inv-1',
      version: 'v1',
      changeKind: 'created',
      data: INVOICE_DATA,
    });
    expect(translator.proposeCommand(commandInput)).toStrictEqual(
      translator.proposeCommand(commandInput),
    );
  });

  it('parses each kind of provider data fail-closed (strict keys, typed results)', () => {
    expect(parseAccountProviderData(ACCOUNT_DATA).ok).toBe(true);
    expect(parseCostCodeProviderData(COST_CODE_DATA).ok).toBe(true);
    expect(parseCommitmentProviderData(COMMITMENT_DATA).ok).toBe(true);
    expect(parseInvoiceProviderData(INVOICE_DATA).ok).toBe(true);
    expect(parsePaymentProviderData(PAYMENT_DATA).ok).toBe(true);
    for (const parse of [
      parseAccountProviderData,
      parseCostCodeProviderData,
      parseCommitmentProviderData,
      parseInvoiceProviderData,
      parsePaymentProviderData,
    ]) {
      expect(parse(null).ok).toBe(false);
      expect(parse({ ...ACCOUNT_DATA, extra: 1 }).ok).toBe(false);
    }
  });
});

describe('financial reference mapping (OFF-024)', () => {
  const invoiceRef = sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectType: INVOICE_OBJECT_KIND,
    objectId: providerObjectId('inv-1'),
    version: providerVersion('v1'),
  });
  const canonical = {
    entityKind: unwrap(parseEntityKind('invoice')),
    entityId: entity(31),
  };

  it('resolves a bound reference deterministically and fails closed on unmapped ones', async () => {
    const store = createInMemorySourceMappingStore();
    const unmapped = await resolveFinanceReference({
      mappings: store,
      tenantId: TENANT_A,
      coordinate: coordinateOf(invoiceRef),
    });
    expect(unmapped.ok).toBe(false);
    if (unmapped.ok) return;
    expect(unmapped.error.code).toBe('not-found');
    expect(unmapped.error.details[0]?.code).toBe('finance-reference-unmapped');

    const bound = unwrap(
      await bindFinanceReference({
        mappings: store,
        tenantId: TENANT_A,
        coordinate: coordinateOf(invoiceRef),
        canonical,
        providerVersion: invoiceRef.version,
        canonicalVersion: version(1),
        actor: { kind: 'adapter', actorId: entity(41) },
        now: NOW_1,
      }),
    );
    expect(bound.canonical).toStrictEqual(canonical);

    const resolved = unwrap(
      await resolveFinanceReference({
        mappings: store,
        tenantId: TENANT_A,
        coordinate: coordinateOf(invoiceRef),
      }),
    );
    expect(resolved).toStrictEqual(canonical);
    // Re-binding the SAME pair is idempotent version bookkeeping (not a
    // conflict) — the mapping table resolves the same canonical id
    // deterministically.
    const rebound = unwrap(
      await bindFinanceReference({
        mappings: store,
        tenantId: TENANT_A,
        coordinate: coordinateOf(invoiceRef),
        canonical,
        providerVersion: providerVersion('v2'),
        canonicalVersion: version(2),
        actor: { kind: 'adapter', actorId: entity(41) },
        now: NOW_2,
      }),
    );
    expect(rebound.canonical).toStrictEqual(canonical);
    expect(rebound.providerVersion).toBe('v2');
  });

  it('typed-rejects a REMAP attempt (a bound coordinate re-pointed at another canonical id)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await bindFinanceReference({
        mappings: store,
        tenantId: TENANT_A,
        coordinate: coordinateOf(invoiceRef),
        canonical,
        providerVersion: invoiceRef.version,
        canonicalVersion: version(1),
        actor: { kind: 'adapter', actorId: entity(41) },
        now: NOW_1,
      }),
    );
    const remap = await bindFinanceReference({
      mappings: store,
      tenantId: TENANT_A,
      coordinate: coordinateOf(invoiceRef),
      canonical: {
        entityKind: unwrap(parseEntityKind('invoice')),
        entityId: entity(32),
      },
      providerVersion: invoiceRef.version,
      canonicalVersion: version(1),
      actor: { kind: 'adapter', actorId: entity(41) },
      now: NOW_2,
    });
    expect(remap.ok).toBe(false);
    if (remap.ok) return;
    expect(remap.error.code).toBe('invariant-violation');
    expect(remap.error.details[0]?.code).toBe('source-mapping-collision');
    // The original binding is intact — an explicit conflict, never an overwrite.
    const resolved = unwrap(
      await resolveFinanceReference({
        mappings: store,
        tenantId: TENANT_A,
        coordinate: coordinateOf(invoiceRef),
      }),
    );
    expect(resolved).toStrictEqual(canonical);
  });

  it('typed-rejects a second provider object claiming a bound canonical id (reverse bijection)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await bindFinanceReference({
        mappings: store,
        tenantId: TENANT_A,
        coordinate: coordinateOf(invoiceRef),
        canonical,
        providerVersion: invoiceRef.version,
        canonicalVersion: version(1),
        actor: { kind: 'adapter', actorId: entity(41) },
        now: NOW_1,
      }),
    );
    const twin = sourceRef({
      adapterKind: FINANCE_ADAPTER_KIND,
      systemId: FINANCE_SYSTEM_ID,
      objectType: INVOICE_OBJECT_KIND,
      objectId: providerObjectId('inv-2'),
      version: providerVersion('v1'),
    });
    const collision = await bindFinanceReference({
      mappings: store,
      tenantId: TENANT_A,
      coordinate: coordinateOf(twin),
      canonical,
      providerVersion: twin.version,
      canonicalVersion: version(1),
      actor: { kind: 'adapter', actorId: entity(41) },
      now: NOW_2,
    });
    expect(collision.ok).toBe(false);
    if (collision.ok) return;
    expect(collision.error.details[0]?.code).toBe('canonical-binding-collision');
  });

  it('scopes mappings by tenant (A12: a foreign tenant sees absence)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(
      await bindFinanceReference({
        mappings: store,
        tenantId: TENANT_A,
        coordinate: coordinateOf(invoiceRef),
        canonical,
        providerVersion: invoiceRef.version,
        canonicalVersion: version(1),
        actor: { kind: 'adapter', actorId: entity(41) },
        now: NOW_1,
      }),
    );
    const foreign = await resolveFinanceReference({
      mappings: store,
      tenantId: TENANT_B,
      coordinate: coordinateOf(invoiceRef),
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe('not-found');
    expect(foreign.error.details[0]?.code).toBe('finance-reference-unmapped');
  });
});
