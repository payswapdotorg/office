import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import {
  providerSystemId,
  providerVersion,
  syncCursor,
  syncCursorToken,
  syncStream,
} from '@office/adapters-sdk';
import type { Adapter, SyncResult } from '@office/adapters-sdk';
import {
  CONSTRUCTION_ADAPTER_KIND,
  CONSTRUCTION_CAPABILITIES,
  CONSTRUCTION_OBJECT_MAPPINGS,
  CONSTRUCTION_SYSTEM_ID,
  DOCUMENT_OBJECT_KIND,
  RFI_OBJECT_KIND,
} from './vocabulary';
import { createConstructionProviderStore } from './provider-fixture';
import { createConstructionAdapter } from './adapter';
import { NOW_1, NOW_2, PROJECT_ID, TENANT_A, USER_ID, unwrap } from './test-support';

// OFF-021 — the Adapter implementation over the SDK contract: the declared
// capabilities, the typed lifecycle transitions (connections are VALUES
// tracked by reference — an unknown or disconnected connection is a typed
// not-found, and a disconnected connection is never usable again), the
// degrade/recover health surface the fixture dials, and the positional,
// replay-safe sync paging (the continuation token is the position AFTER the
// last delivered item, so a restart from a checkpointed cursor re-delivers
// nothing before the checkpoint).

const PROV_T1: Timestamp = unwrap(parseTimestamp('2026-09-10T08:00:00.000Z'));

const FOREIGN_SYSTEM = providerSystemId('cde-instance-02');

const DOC_STREAM = syncStream({
  tenantId: TENANT_A,
  adapterKind: CONSTRUCTION_ADAPTER_KIND,
  systemId: CONSTRUCTION_SYSTEM_ID,
  objectKind: DOCUMENT_OBJECT_KIND,
});

const cursorAt = (token: string, itemsObserved: number) =>
  syncCursor({
    stream: DOC_STREAM,
    token: syncCursorToken(token),
    checkpoint: { itemsObserved, lastProviderVersion: providerVersion('v1') },
    updatedAt: NOW_2,
  });

/** Three documents, in insertion order. */
const seededStore = () => {
  const store = createConstructionProviderStore();
  for (const [objectId, title, discipline] of [
    ['doc-1', 'Structural drawing package', 'structural'],
    ['doc-2', 'Facade cleaning plan', 'architectural'],
    ['doc-3', 'MEP coordination set', 'mechanical'],
  ] as const) {
    store.putDocument({
      objectId,
      title,
      projectId: PROJECT_ID,
      discipline,
      revision: { revisionId: `rev-${objectId}`, contentBase64: 'UEsDBBQABgAGAAA=' },
      updatedAt: PROV_T1,
    });
  }
  return store;
};

const connectRequest = (now: Timestamp) => ({
  kind: 'connect-request' as const,
  systemId: CONSTRUCTION_SYSTEM_ID,
  now,
});

describe('construction adapter (OFF-021)', () => {
  it('declares the construction-cde family and the four object-kind surfaces', () => {
    const adapter: Adapter = createConstructionAdapter({ store: createConstructionProviderStore() });
    expect(adapter.kind).toBe('construction-cde');
    expect(adapter.capabilities).toStrictEqual(CONSTRUCTION_CAPABILITIES);
    expect(adapter.capabilities.objectKinds).toStrictEqual(
      CONSTRUCTION_OBJECT_MAPPINGS.map((mapping) => ({
        objectKind: mapping.objectKind,
        canonicalKind: mapping.canonicalKind,
        capability: mapping.capability,
      })),
    );
  });

  // ---- the typed lifecycle ---------------------------------------------------
  it('connects against the fixture system and typed-rejects foreign systems', async () => {
    const store = seededStore();
    const adapter = createConstructionAdapter({ store });

    const connected = await adapter.connect(connectRequest(NOW_1));
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value).toStrictEqual({
      kind: 'adapter-connection',
      systemId: CONSTRUCTION_SYSTEM_ID,
      establishedAt: NOW_1,
    });

    const foreign = await adapter.connect({
      kind: 'connect-request',
      systemId: FOREIGN_SYSTEM,
      now: NOW_1,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe('invariant-violation');
    expect(foreign.error.details[0]?.code).toBe('provider-system-mismatch');
  });

  it('health-checks a connection and observes the provider degrade/recover dial', async () => {
    const store = seededStore();
    const adapter = createConstructionAdapter({ store });
    const connected = unwrap(await adapter.connect(connectRequest(NOW_1)));
    const connection = connected;

    const healthy = unwrap(
      await adapter.healthCheck({ connection, now: NOW_2 }),
    );
    expect(healthy).toStrictEqual({
      kind: 'adapter-health',
      status: 'healthy',
      checkedAt: NOW_2,
      detail: null,
    });

    store.degrade('the CDE batch API is rate-limited');
    const degraded = unwrap(await adapter.healthCheck({ connection, now: NOW_2 }));
    expect(degraded.status).toBe('degraded');
    expect(degraded.detail).toBe('the CDE batch API is rate-limited');

    store.recover();
    const recovered = unwrap(await adapter.healthCheck({ connection, now: NOW_2 }));
    expect(recovered.status).toBe('healthy');
    expect(recovered.detail).toBeNull();
  });

  it('typed-rejects unknown connections (and a disconnected one is never usable again)', async () => {
    const store = seededStore();
    const adapter = createConstructionAdapter({ store });
    // A structurally valid connection this adapter never established
    // (tracked by reference identity — a value, never a socket).
    const stranger = {
      kind: 'adapter-connection',
      systemId: CONSTRUCTION_SYSTEM_ID,
      establishedAt: NOW_1,
    } as const;

    const strangerHealth = await adapter.healthCheck({ connection: stranger, now: NOW_2 });
    expect(strangerHealth.ok).toBe(false);
    if (strangerHealth.ok) return;
    expect(strangerHealth.error.code).toBe('not-found');
    expect(strangerHealth.error.details[0]?.code).toBe('adapter-connection-unknown');

    const strangerDisconnect = await adapter.disconnect({ connection: stranger, now: NOW_2 });
    expect(strangerDisconnect.ok).toBe(false);

    const connection = unwrap(await adapter.connect(connectRequest(NOW_1)));
    const disconnected = unwrap(await adapter.disconnect({ connection, now: NOW_2 }));
    expect(disconnected).toStrictEqual({
      kind: 'adapter-disconnected',
      disconnectedAt: NOW_2,
    });
    // The disconnected connection is dead for health checks…
    const deadHealth = await adapter.healthCheck({ connection, now: NOW_2 });
    expect(deadHealth.ok).toBe(false);
    if (deadHealth.ok) return;
    expect(deadHealth.error.details[0]?.code).toBe('adapter-connection-unknown');
    // …and for a second disconnect.
    const deadDisconnect = await adapter.disconnect({ connection, now: NOW_2 });
    expect(deadDisconnect.ok).toBe(false);
    // A fresh connect establishes a NEW, usable connection.
    const reconnected = unwrap(await adapter.connect(connectRequest(NOW_2)));
    expect(reconnected.establishedAt).toBe(NOW_2);
    const usable = unwrap(await adapter.healthCheck({ connection: reconnected, now: NOW_2 }));
    expect(usable.status).toBe('healthy');
  });

  // ---- the sync surface (positional, replay-safe paging) --------------------
  it('pages positionally: the token is the position AFTER the last delivered item', async () => {
    const store = seededStore();
    const adapter = createConstructionAdapter({ store });

    const page1 = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKind: DOCUMENT_OBJECT_KIND,
        cursor: null,
        limit: 2,
        now: NOW_1,
      }),
    ) satisfies SyncResult;
    expect(page1.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual([
      'doc-1',
      'doc-2',
    ]);
    expect(page1.nextCursorToken).toBe('2');
    expect(page1.hasMore).toBe(true);
    expect(page1.checkpoint).toStrictEqual({
      itemsObserved: 2,
      lastProviderVersion: 'v1',
    });

    const page2 = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKind: DOCUMENT_OBJECT_KIND,
        cursor: cursorAt('2', 2),
        limit: 2,
        now: NOW_2,
      }),
    );
    expect(page2.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual(['doc-3']);
    expect(page2.nextCursorToken).toBeNull();
    expect(page2.hasMore).toBe(false);
    expect(page2.checkpoint).toStrictEqual({
      itemsObserved: 3,
      lastProviderVersion: 'v1',
    });
  });

  it('re-delivers nothing before the checkpoint when restarting from a cursor', async () => {
    const store = seededStore();
    const adapter = createConstructionAdapter({ store });

    // A crash after the first page: restarting from the checkpointed cursor
    // (token '1' — the position after doc-1) re-delivers ONLY the tail.
    const restart = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKind: DOCUMENT_OBJECT_KIND,
        cursor: cursorAt('1', 1),
        limit: 2,
        now: NOW_2,
      }),
    );
    expect(restart.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual([
      'doc-2',
      'doc-3',
    ]);
  });

  it('typed-rejects resumptions from invalid positions', async () => {
    const store = seededStore();
    const adapter = createConstructionAdapter({ store });
    for (const token of ['999', 'abc', '-1']) {
      const resumed = await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKind: DOCUMENT_OBJECT_KIND,
        cursor: cursorAt(token, 999),
        limit: 2,
        now: NOW_1,
      });
      expect(resumed.ok, `token '${token}'`).toBe(false);
      if (resumed.ok) continue;
      expect(resumed.error.code, `token '${token}'`).toBe('invariant-violation');
      expect(resumed.error.details[0]?.code, `token '${token}'`).toBe('provider-token-invalid');
    }
  });

  it('typed-rejects syncs against a foreign provider system', async () => {
    const store = seededStore();
    const adapter = createConstructionAdapter({ store });
    const foreign = await adapter.sync({
      kind: 'sync-request',
      tenantId: TENANT_A,
      systemId: FOREIGN_SYSTEM,
      objectKind: DOCUMENT_OBJECT_KIND,
      cursor: null,
      limit: 2,
      now: NOW_1,
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.details[0]?.code).toBe('provider-system-mismatch');
  });

  it('translates each provider object into its tenant-stamped neutral snapshot', async () => {
    const store = createConstructionProviderStore();
    store.putDocument({
      objectId: 'doc-1',
      title: 'Structural drawing package',
      projectId: PROJECT_ID,
      discipline: 'structural',
      revision: { revisionId: 'rev-1', contentBase64: 'UEsDBBQABgAGAAA=' },
      updatedAt: PROV_T1,
    });
    store.putRfi({
      objectId: 'rfi-1',
      title: 'Cladding penetration detail',
      question: 'Which detail governs the roof penetration at grid C4?',
      category: 'design-coordination',
      severity: 'high',
      projectId: PROJECT_ID,
      raisedBy: USER_ID,
      raisedAt: PROV_T1,
      updatedAt: PROV_T1,
    });
    const adapter = createConstructionAdapter({ store });

    const documents = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKind: DOCUMENT_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_2,
      }),
    );
    const documentSnapshot = documents.snapshots[0];
    expect(documentSnapshot).toMatchObject({
      kind: 'provider-snapshot',
      tenantId: TENANT_A,
      displayName: 'Structural drawing package',
      objectStatus: 'active',
      providerUpdatedAt: PROV_T1,
      observedAt: NOW_2,
      source: {
        adapterKind: 'construction-cde',
        systemId: 'cde-instance-01',
        objectType: 'document',
        objectId: 'doc-1',
        version: 'v1',
      },
      extension: {
        title: 'Structural drawing package',
        projectId: PROJECT_ID,
        discipline: 'structural',
        revision: { revisionId: 'rev-1', contentBase64: 'UEsDBBQABgAGAAA=' },
      },
    });

    const rfis = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKind: RFI_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_2,
      }),
    );
    expect(rfis.snapshots[0]).toMatchObject({
      displayName: 'Cladding penetration detail',
      objectStatus: 'active',
      observedAt: NOW_2,
      source: { objectType: 'rfi', objectId: 'rfi-1', version: 'v1' },
      extension: {
        title: 'Cladding penetration detail',
        category: 'design-coordination',
        severity: 'high',
      },
    });
  });

  it('delivers tombstones as explicit deleted snapshots at the bumped version', async () => {
    const store = seededStore();
    store.deleteDocument('doc-2', PROV_T1);
    const adapter = createConstructionAdapter({ store });
    const page = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKind: DOCUMENT_OBJECT_KIND,
        cursor: cursorAt('1', 1),
        limit: 10,
        now: NOW_2,
      }),
    );
    expect(page.snapshots).toHaveLength(2);
    expect(page.snapshots[0]).toMatchObject({
      objectStatus: 'deleted',
      providerUpdatedAt: PROV_T1,
      source: { objectId: 'doc-2', version: 'v2' },
    });
    expect(page.snapshots[1]).toMatchObject({
      objectStatus: 'active',
      source: { objectId: 'doc-3', version: 'v1' },
    });
  });
});
