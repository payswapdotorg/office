import { describe, expect, it } from 'vitest';
import { parseTenantId, parseTimestamp } from '@office/contracts';
import type { TenantId, Timestamp } from '@office/contracts';
import {
  createInMemorySyncCursorStore,
  providerSystemId,
  providerVersion,
  syncCursor,
  syncCursorToken,
  syncStream,
} from '@office/adapters-sdk';
import {
  ELEMENT_OBJECT_KIND,
  MODEL_OBJECT_KIND,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_OBJECT_KIND,
} from './vocabulary';
import {
  COLUMN_ELEMENT_ID,
  TOWER_MODEL_ID,
  TOWER_MODEL_V2_ID,
  WALL_ELEMENT_ID,
  createModelProviderStore,
  createSeededModelProvider,
} from './provider-fixture';
import { createModelAdapter } from './adapter';

// OFF-022 adapter-model — the Adapter implementation over the injected
// provider port: typed lifecycle values (no sockets), per-stream positional
// paging with restart-safe cursors, and fail-closed request validation.
// Deterministic: the seeded fixture state is fixed, timestamps injected.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-10-06T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-10-06T09:05:00.000Z'));

describe('the model adapter lifecycle (typed values, no sockets)', () => {
  const provider = createSeededModelProvider();

  it('connects to the serving provider system and stamps the injected clock', async () => {
    const connection = unwrap(
      await provider.adapter.connect({ kind: 'connect-request', systemId: MODEL_SYSTEM_ID, now: NOW_1 }),
    );
    expect(connection).toStrictEqual({
      kind: 'adapter-connection',
      systemId: MODEL_SYSTEM_ID,
      establishedAt: NOW_1,
    });
  });

  it('rejects a connection to a different provider system (typed)', async () => {
    const result = await provider.adapter.connect({
      kind: 'connect-request',
      systemId: providerSystemId('model-instance-99'),
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('provider-system-mismatch');
    }
  });

  it('reports health and disconnects deterministically', async () => {
    const connection = unwrap(
      await provider.adapter.connect({
        kind: 'connect-request',
        systemId: MODEL_SYSTEM_ID,
        now: NOW_1,
      }),
    );
    const health = unwrap(await provider.adapter.healthCheck({ connection, now: NOW_1 }));
    expect(health).toStrictEqual({
      kind: 'adapter-health',
      status: 'healthy',
      checkedAt: NOW_1,
      detail: null,
    });
    const disconnected = unwrap(await provider.adapter.disconnect({ connection, now: NOW_2 }));
    expect(disconnected).toStrictEqual({
      kind: 'adapter-disconnected',
      disconnectedAt: NOW_2,
    });
  });
});

describe('the model adapter sync surface (positional paging)', () => {
  it('declares the four model object-kind surfaces of the family', () => {
    const provider = createSeededModelProvider();
    expect(provider.adapter.kind).toBe('model-cde');
    expect(provider.adapter.capabilities.objectKinds.map((entry) => entry.objectKind)).toStrictEqual([
      'model',
      'model-version',
      'element',
      'element-classification',
    ]);
  });

  it('pages one object-kind stream in provider order with continuation tokens', async () => {
    const provider = createSeededModelProvider();
    const page = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: MODEL_SYSTEM_ID,
        objectKind: ELEMENT_OBJECT_KIND,
        cursor: null,
        limit: 1,
        now: NOW_1,
      }),
    );
    expect(page.snapshots).toHaveLength(1);
    expect(page.snapshots[0]?.source.objectId).toBe(WALL_ELEMENT_ID);
    expect(page.snapshots[0]?.source.objectType).toBe('element');
    expect(page.snapshots[0]?.source.version).toBe('v1');
    expect(page.snapshots[0]?.tenantId).toBe(TENANT_A);
    expect(page.snapshots[0]?.objectStatus).toBe('active');
    expect(page.nextCursorToken).toBe('1');
    expect(page.hasMore).toBe(true);
    expect(page.checkpoint).toStrictEqual({ itemsObserved: 1, lastProviderVersion: 'v1' });

    const second = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: MODEL_SYSTEM_ID,
        objectKind: ELEMENT_OBJECT_KIND,
        cursor: syncCursor({
          stream: syncStream({
            tenantId: TENANT_A,
            adapterKind: provider.adapter.kind,
            systemId: MODEL_SYSTEM_ID,
            objectKind: ELEMENT_OBJECT_KIND,
          }),
          token: syncCursorToken('1'),
          checkpoint: { itemsObserved: 1, lastProviderVersion: providerVersion('v1') },
          updatedAt: NOW_1,
        }),
        limit: 1,
        now: NOW_2,
      }),
    );
    expect(second.snapshots[0]?.source.objectId).toBe(COLUMN_ELEMENT_ID);
    expect(second.nextCursorToken).toBeNull();
    expect(second.hasMore).toBe(false);
    expect(second.checkpoint).toStrictEqual({ itemsObserved: 2, lastProviderVersion: 'v1' });
  });

  it('stamps tenant and the injected clock on every snapshot (observedAt)', async () => {
    const provider = createSeededModelProvider();
    const page = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: MODEL_SYSTEM_ID,
        objectKind: MODEL_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(page.snapshots).toHaveLength(1);
    expect(page.snapshots[0]?.source.objectId).toBe(TOWER_MODEL_ID);
    expect(page.snapshots[0]?.observedAt).toBe(NOW_1);
    expect(page.snapshots[0]?.displayName).toBe('Tower A — structural model');
    expect(page.snapshots[0]?.extension).toStrictEqual({ discipline: 'structure' });
    expect(page.hasMore).toBe(false);
  });

  it('serves tombstones in stream order (deletions never remove history)', async () => {
    const provider = createSeededModelProvider();
    provider.retireElement(COLUMN_ELEMENT_ID);
    const page = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: MODEL_SYSTEM_ID,
        objectKind: ELEMENT_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(page.snapshots.map((snapshot) => [snapshot.source.objectId, snapshot.objectStatus])).toStrictEqual([
      [WALL_ELEMENT_ID, 'active'],
      [COLUMN_ELEMENT_ID, 'deleted'],
    ]);
    // The retired element's provider version bumped deterministically.
    expect(page.snapshots[1]?.source.version).toBe('v2');
  });

  it('rejects sync against a foreign provider system (typed)', async () => {
    const provider = createSeededModelProvider();
    const result = await provider.adapter.sync({
      kind: 'sync-request',
      tenantId: TENANT_A,
      systemId: providerSystemId('model-instance-99'),
      objectKind: ELEMENT_OBJECT_KIND,
      cursor: null,
      limit: 10,
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('provider-system-mismatch');
    }
  });

  it('rejects resume tokens it cannot serve (typed, never a guess)', async () => {
    const provider = createSeededModelProvider();
    const cursorStore = createInMemorySyncCursorStore();
    const stream = syncStream({
      tenantId: TENANT_A,
      adapterKind: provider.adapter.kind,
      systemId: MODEL_SYSTEM_ID,
      objectKind: ELEMENT_OBJECT_KIND,
    });
    const bogus = syncCursor({
      stream,
      token: syncCursorToken('not-a-position'),
      checkpoint: { itemsObserved: 0, lastProviderVersion: null },
      updatedAt: NOW_1,
    });
    const result = await provider.adapter.sync({
      kind: 'sync-request',
      tenantId: TENANT_A,
      systemId: MODEL_SYSTEM_ID,
      objectKind: ELEMENT_OBJECT_KIND,
      cursor: bogus,
      limit: 10,
      now: NOW_1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('provider-token-invalid');
    }
    // A token past the end of the stream is equally unresumable.
    const beyond = syncCursor({
      stream,
      token: syncCursorToken('99'),
      checkpoint: { itemsObserved: 0, lastProviderVersion: null },
      updatedAt: NOW_1,
    });
    const beyondResult = await provider.adapter.sync({
      kind: 'sync-request',
      tenantId: TENANT_A,
      systemId: MODEL_SYSTEM_ID,
      objectKind: ELEMENT_OBJECT_KIND,
      cursor: beyond,
      limit: 10,
      now: NOW_1,
    });
    expect(beyondResult.ok).toBe(false);
    // The cursor store itself stays untouched by the rejected request.
    expect(await cursorStore.load(stream)).toBeNull();
  });

  it('serves other provider systems of the same family when configured', async () => {
    const store = createModelProviderStore();
    store.putObject({
      objectId: TOWER_MODEL_ID,
      objectType: MODEL_OBJECT_KIND,
      displayName: 'Tower A — structural model',
      data: { discipline: 'structure' },
      updatedAt: null,
    });
    const adapter = createModelAdapter({ store, systemId: providerSystemId('model-instance-02') });
    const page = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: providerSystemId('model-instance-02'),
        objectKind: MODEL_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(page.snapshots[0]?.source.systemId).toBe('model-instance-02');
  });

  it('exposes the model-version stream in registration order (v1 before v2)', async () => {
    const provider = createSeededModelProvider();
    const page = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: MODEL_SYSTEM_ID,
        objectKind: MODEL_VERSION_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(page.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual([
      'mv-tower-a-1',
      TOWER_MODEL_V2_ID,
    ]);
  });
});
