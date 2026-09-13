import { describe, expect, it } from 'vitest';
import { providerSystemId } from '@office/adapters-sdk';
import {
  syncCursor,
  syncCursorToken,
  syncStream,
} from '@office/adapters-sdk';
import type { SyncCursor, SyncRequest } from '@office/adapters-sdk';
import {
  ACCOUNT_OBJECT_KIND,
  COST_CODE_OBJECT_KIND,
  FINANCE_ADAPTER_KIND,
  FINANCE_CAPABILITIES,
  FINANCE_OBJECT_KINDS,
  FINANCE_SYSTEM_ID,
  INVOICE_OBJECT_KIND,
} from './vocabulary';
import { createErpProviderStore } from './provider-fixture';
import { createFinanceAdapter } from './adapter';
import {
  BUDGET_REF_ID,
  COMMITMENT_REF_ID,
  NOW_1,
  NOW_2,
  PROJECT_ID,
  TENANT_A,
  unwrap,
} from './test-support';

// OFF-024 — the finance Adapter over the injected ERP provider store: the
// five declared object-kind surfaces (capabilities), the typed connection
// lifecycle (an unknown or disconnected connection is a typed not-found, the
// health surface observes the provider's degraded mode), and the sync
// surface's POSITIONAL replay safety — the continuation token is the position
// AFTER the last delivered item, so a cursor restart re-delivers nothing.

/** Three invoices against one commitment (a paged invoice stream). */
const invoiceStore = () => {
  const store = createErpProviderStore();
  for (const objectId of ['inv-1', 'inv-2', 'inv-3']) {
    store.putInvoice({
      objectId,
      number: `INV-2026-${objectId.toUpperCase()}`,
      description: `Earthworks invoice ${objectId}`,
      currency: 'EUR',
      commitmentRef: COMMITMENT_REF_ID,
      issuedOn: NOW_1,
      dueOn: NOW_2,
      lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
      updatedAt: NOW_1,
    });
  }
  return store;
};

const invoiceSyncRequest = (parts: {
  readonly cursor: SyncCursor | null;
  readonly limit: number;
  readonly systemId?: ReturnType<typeof providerSystemId>;
}): SyncRequest => ({
  kind: 'sync-request',
  tenantId: TENANT_A,
  systemId: parts.systemId ?? FINANCE_SYSTEM_ID,
  objectKind: INVOICE_OBJECT_KIND,
  cursor: parts.cursor,
  limit: parts.limit,
  now: NOW_1,
});

const invoiceCursor = (token: string): SyncCursor =>
  syncCursor({
    stream: syncStream({
      tenantId: TENANT_A,
      adapterKind: FINANCE_ADAPTER_KIND,
      systemId: FINANCE_SYSTEM_ID,
      objectKind: INVOICE_OBJECT_KIND,
    }),
    token: syncCursorToken(token),
    checkpoint: { itemsObserved: 0, lastProviderVersion: null },
    updatedAt: NOW_1,
  });

describe('finance adapter (OFF-024)', () => {
  it('declares the erp-finance family and the five object-kind surfaces', () => {
    const adapter = createFinanceAdapter({ store: createErpProviderStore() });
    expect(adapter.kind).toBe(FINANCE_ADAPTER_KIND);
    expect(adapter.capabilities).toStrictEqual(FINANCE_CAPABILITIES);
    expect(adapter.capabilities.objectKinds.map((entry) => entry.objectKind)).toStrictEqual(
      FINANCE_OBJECT_KINDS,
    );
    for (const entry of adapter.capabilities.objectKinds) {
      expect(entry.canonicalKind).toBeTypeOf('string');
      expect(entry.capability).toBe('cost.write');
    }
  });

  it('connects against the fixture system and typed-rejects foreign systems', async () => {
    const adapter = createFinanceAdapter({ store: createErpProviderStore() });
    const connection = unwrap(
      await adapter.connect({ kind: 'connect-request', systemId: FINANCE_SYSTEM_ID, now: NOW_1 }),
    );
    expect(connection).toStrictEqual({
      kind: 'adapter-connection',
      systemId: FINANCE_SYSTEM_ID,
      establishedAt: NOW_1,
    });

    const foreign = await adapter.connect({
      kind: 'connect-request',
      systemId: providerSystemId('erp-instance-99'),
      now: NOW_1,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe('invariant-violation');
    expect(foreign.error.details[0]?.code).toBe('provider-system-mismatch');

    const foreignSync = await adapter.sync(
      invoiceSyncRequest({ cursor: null, limit: 10, systemId: providerSystemId('erp-instance-99') }),
    );
    expect(foreignSync.ok).toBe(false);
    if (foreignSync.ok) return;
    expect(foreignSync.error.details[0]?.code).toBe('provider-system-mismatch');
  });

  it('health-checks a connection and observes the provider degrade/recover dial', async () => {
    const store = createErpProviderStore();
    const adapter = createFinanceAdapter({ store });
    const connection = unwrap(
      await adapter.connect({ kind: 'connect-request', systemId: FINANCE_SYSTEM_ID, now: NOW_1 }),
    );

    const healthy = unwrap(await adapter.healthCheck({ connection, now: NOW_1 }));
    expect(healthy).toStrictEqual({
      kind: 'adapter-health',
      status: 'healthy',
      checkedAt: NOW_1,
      detail: null,
    });

    store.degrade('ERP ledger reindex in progress');
    const degraded = unwrap(await adapter.healthCheck({ connection, now: NOW_2 }));
    expect(degraded.status).toBe('degraded');
    expect(degraded.detail).toBe('ERP ledger reindex in progress');

    store.recover();
    const recovered = unwrap(await adapter.healthCheck({ connection, now: NOW_2 }));
    expect(recovered.status).toBe('healthy');
  });

  it('typed-rejects unknown connections (and a disconnected one is never usable again)', async () => {
    const adapter = createFinanceAdapter({ store: createErpProviderStore() });
    const connection = unwrap(
      await adapter.connect({ kind: 'connect-request', systemId: FINANCE_SYSTEM_ID, now: NOW_1 }),
    );

    const stranger = {
      kind: 'adapter-connection',
      systemId: FINANCE_SYSTEM_ID,
      establishedAt: NOW_1,
    } as const;

    const unknown = await adapter.healthCheck({ connection: stranger, now: NOW_1 });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe('not-found');
    expect(unknown.error.details[0]?.code).toBe('adapter-connection-unknown');

    const disconnected = unwrap(await adapter.disconnect({ connection, now: NOW_2 }));
    expect(disconnected).toStrictEqual({
      kind: 'adapter-disconnected',
      disconnectedAt: NOW_2,
    });
    const gone = await adapter.healthCheck({ connection, now: NOW_2 });
    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.error.details[0]?.code).toBe('adapter-connection-unknown');
  });

  it('pages positionally: the token is the position AFTER the last delivered item', async () => {
    const adapter = createFinanceAdapter({ store: invoiceStore() });

    const page1 = unwrap(
      await adapter.sync(invoiceSyncRequest({ cursor: null, limit: 2 })),
    );
    expect(page1.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual([
      'inv-1',
      'inv-2',
    ]);
    expect(page1.nextCursorToken).toBe('2');
    expect(page1.checkpoint).toStrictEqual({
      itemsObserved: 2,
      lastProviderVersion: 'v1',
    });
    expect(page1.hasMore).toBe(true);

    const page2 = unwrap(
      await adapter.sync(invoiceSyncRequest({ cursor: invoiceCursor('2'), limit: 2 })),
    );
    expect(page2.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual(['inv-3']);
    expect(page2.nextCursorToken).toBeNull();
    expect(page2.hasMore).toBe(false);
  });

  it('re-delivers nothing before the checkpoint when restarting from a cursor', async () => {
    const adapter = createFinanceAdapter({ store: invoiceStore() });
    const resume = unwrap(
      await adapter.sync(invoiceSyncRequest({ cursor: invoiceCursor('2'), limit: 10 })),
    );
    // The checkpointed prefix (inv-1, inv-2) never comes back.
    expect(resume.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual(['inv-3']);
  });

  it('typed-rejects resumptions from invalid positions', async () => {
    const adapter = createFinanceAdapter({ store: invoiceStore() });
    const cases: readonly [string, string][] = [
      ['past the end of the stream', '4'],
      ['a non-numeric token', 'inv-1'],
    ];
    for (const [label, token] of cases) {
      const rejected = await adapter.sync(invoiceSyncRequest({ cursor: invoiceCursor(token), limit: 10 }));
      expect(rejected.ok, label).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.error.code, label).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code, label).toBe('provider-token-invalid');
    }
  });

  it('translates each provider object into its tenant-stamped neutral snapshot', async () => {
    const store = createErpProviderStore();
    store.putAccount({
      objectId: 'acc-1',
      code: '5010',
      name: 'Earthworks costs',
      currency: 'EUR',
      projectRef: PROJECT_ID,
      updatedAt: NOW_1,
    });
    store.putCostCode({
      objectId: 'cc-1',
      code: '0310',
      description: 'Bulk excavation',
      unit: 'm3',
      budgetRef: BUDGET_REF_ID,
      quantityMilli: 1_500,
      unitRateMinor: 2_400,
      updatedAt: NOW_1,
    });
    const adapter = createFinanceAdapter({ store });

    const accounts = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: FINANCE_SYSTEM_ID,
        objectKind: ACCOUNT_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_2,
      }),
    );
    const account = accounts.snapshots[0];
    expect(account?.tenantId).toBe(TENANT_A);
    expect(account?.source).toStrictEqual({
      adapterKind: 'erp-finance',
      systemId: 'erp-instance-01',
      objectType: 'account',
      objectId: 'acc-1',
      version: 'v1',
    });
    expect(account?.displayName).toBe('5010 Earthworks costs');
    expect(account?.objectStatus).toBe('active');
    expect(account?.providerUpdatedAt).toBe(NOW_1);
    expect(account?.observedAt).toBe(NOW_2);
    expect(account?.extension).toStrictEqual({
      code: '5010',
      name: 'Earthworks costs',
      currency: 'EUR',
      projectRef: PROJECT_ID,
    });

    const costCodes = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: FINANCE_SYSTEM_ID,
        objectKind: COST_CODE_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_2,
      }),
    );
    expect(costCodes.snapshots[0]?.extension).toStrictEqual({
      code: '0310',
      description: 'Bulk excavation',
      unit: 'm3',
      budgetRef: BUDGET_REF_ID,
      quantityMilli: 1_500,
      unitRateMinor: 2_400,
    });
  });

  it('delivers tombstones as explicit deleted snapshots at the bumped version', async () => {
    const store = createErpProviderStore();
    store.putAccount({
      objectId: 'acc-1',
      code: '5010',
      name: 'Earthworks costs',
      currency: 'EUR',
      projectRef: PROJECT_ID,
      updatedAt: NOW_1,
    });
    store.deleteAccount('acc-1', NOW_2);
    const adapter = createFinanceAdapter({ store });

    const page = unwrap(
      await adapter.sync(invoiceSyncRequest({ cursor: null, limit: 10 })),
    );
    expect(page.snapshots.map((snapshot) => snapshot.source.objectType)).toStrictEqual([]);
    const accounts = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: FINANCE_SYSTEM_ID,
        objectKind: ACCOUNT_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_2,
      }),
    );
    const tombstone = accounts.snapshots[0];
    expect(tombstone?.objectStatus).toBe('deleted');
    expect(tombstone?.source.version).toBe('v2');
    expect(tombstone?.providerUpdatedAt).toBe(NOW_2);
  });
});
