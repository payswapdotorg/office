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
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
  PROJECT_SCHEDULE_OBJECT_KIND,
  SCHEDULE_SYSTEM_ID,
} from './vocabulary';
import {
  ENVELOPE_ACTIVITY_ID,
  FOUNDATIONS_ACTIVITY_ID,
  SEPTEMBER_BASELINE_ID,
  STRUCTURE_ACTIVITY_ID,
  TOWER_SCHEDULE_ID,
  createScheduleProviderStore,
  createSeededScheduleProvider,
} from './provider-fixture';
import { createScheduleAdapter } from './adapter';

// OFF-023 adapter-schedule — the Adapter implementation over the injected
// provider port: typed lifecycle values (no sockets), per-stream positional
// paging with restart-safe cursors, and fail-closed request validation.
// Deterministic: the seeded fixture state is fixed, timestamps injected.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-11-10T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-11-10T09:05:00.000Z'));

describe('the schedule adapter lifecycle (typed values, no sockets)', () => {
  const provider = createSeededScheduleProvider();

  it('connects to the serving provider system and stamps the injected clock', async () => {
    const connection = unwrap(
      await provider.adapter.connect({
        kind: 'connect-request',
        systemId: SCHEDULE_SYSTEM_ID,
        now: NOW_1,
      }),
    );
    expect(connection).toStrictEqual({
      kind: 'adapter-connection',
      systemId: SCHEDULE_SYSTEM_ID,
      establishedAt: NOW_1,
    });
  });

  it('rejects a connection to a different provider system (typed)', async () => {
    const result = await provider.adapter.connect({
      kind: 'connect-request',
      systemId: providerSystemId('schedule-instance-99'),
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
        systemId: SCHEDULE_SYSTEM_ID,
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

describe('the schedule adapter sync surface (positional paging)', () => {
  it('declares the four schedule object-kind surfaces of the family', () => {
    const provider = createSeededScheduleProvider();
    expect(provider.adapter.kind).toBe('schedule-pm');
    expect(
      provider.adapter.capabilities.objectKinds.map((entry) => entry.objectKind),
    ).toStrictEqual([
      'project-schedule',
      'activity',
      'activity-dependency',
      'baseline',
    ]);
    for (const entry of provider.adapter.capabilities.objectKinds) {
      expect(entry.capability).toBe('schedule.write');
    }
  });

  it('pages one object-kind stream in provider order with continuation tokens', async () => {
    const provider = createSeededScheduleProvider();
    const page = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: ACTIVITY_OBJECT_KIND,
        cursor: null,
        limit: 1,
        now: NOW_1,
      }),
    );
    expect(page.snapshots).toHaveLength(1);
    expect(page.snapshots[0]?.source.objectId).toBe(FOUNDATIONS_ACTIVITY_ID);
    expect(page.snapshots[0]?.source.objectType).toBe('activity');
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
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: ACTIVITY_OBJECT_KIND,
        cursor: syncCursor({
          stream: syncStream({
            tenantId: TENANT_A,
            adapterKind: provider.adapter.kind,
            systemId: SCHEDULE_SYSTEM_ID,
            objectKind: ACTIVITY_OBJECT_KIND,
          }),
          token: syncCursorToken('1'),
          checkpoint: { itemsObserved: 1, lastProviderVersion: providerVersion('v1') },
          updatedAt: NOW_1,
        }),
        limit: 1,
        now: NOW_2,
      }),
    );
    expect(second.snapshots[0]?.source.objectId).toBe(STRUCTURE_ACTIVITY_ID);
    expect(second.nextCursorToken).toBe('2');
    expect(second.hasMore).toBe(true);
    expect(second.checkpoint).toStrictEqual({ itemsObserved: 2, lastProviderVersion: 'v1' });
  });

  it('stamps tenant and the injected clock on every snapshot (observedAt)', async () => {
    const provider = createSeededScheduleProvider();
    const page = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: PROJECT_SCHEDULE_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(page.snapshots).toHaveLength(1);
    expect(page.snapshots[0]?.source.objectId).toBe(TOWER_SCHEDULE_ID);
    expect(page.snapshots[0]?.observedAt).toBe(NOW_1);
    expect(page.snapshots[0]?.displayName).toBe('Tower A — master schedule');
    expect(page.snapshots[0]?.extension).toStrictEqual({ name: 'Tower A — master schedule' });
    expect(page.hasMore).toBe(false);
  });

  it('serves each family stream separately (dependencies and baselines in insertion order)', async () => {
    const provider = createSeededScheduleProvider();
    const dependencies = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: ACTIVITY_DEPENDENCY_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(dependencies.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual([
      'dep-401-402',
      'dep-402-403',
    ]);
    expect(dependencies.snapshots[1]?.extension).toStrictEqual({
      scheduleId: TOWER_SCHEDULE_ID,
      predecessorId: STRUCTURE_ACTIVITY_ID,
      successorId: ENVELOPE_ACTIVITY_ID,
      linkType: 'fs',
      lagDays: 3,
    });
    const baselines = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: BASELINE_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(baselines.snapshots.map((snapshot) => snapshot.source.objectId)).toStrictEqual([
      SEPTEMBER_BASELINE_ID,
    ]);
  });

  it('serves tombstones in stream order (deletions never remove history)', async () => {
    const provider = createSeededScheduleProvider();
    // A provider activity deletion is a tombstone: the schedules-area history
    // is append-only, so the tombstone observation is what the engine sees.
    provider.store.deleteObject(ENVELOPE_ACTIVITY_ID);
    const page = unwrap(
      await provider.adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: SCHEDULE_SYSTEM_ID,
        objectKind: ACTIVITY_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(
      page.snapshots.map((snapshot) => [snapshot.source.objectId, snapshot.objectStatus]),
    ).toStrictEqual([
      [FOUNDATIONS_ACTIVITY_ID, 'active'],
      [STRUCTURE_ACTIVITY_ID, 'active'],
      [ENVELOPE_ACTIVITY_ID, 'deleted'],
    ]);
    // The tombstoned activity's provider version bumped deterministically.
    expect(page.snapshots[2]?.source.version).toBe('v2');
  });

  it('rejects sync against a foreign provider system (typed)', async () => {
    const provider = createSeededScheduleProvider();
    const result = await provider.adapter.sync({
      kind: 'sync-request',
      tenantId: TENANT_A,
      systemId: providerSystemId('schedule-instance-99'),
      objectKind: ACTIVITY_OBJECT_KIND,
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
    const provider = createSeededScheduleProvider();
    const cursorStore = createInMemorySyncCursorStore();
    const stream = syncStream({
      tenantId: TENANT_A,
      adapterKind: provider.adapter.kind,
      systemId: SCHEDULE_SYSTEM_ID,
      objectKind: ACTIVITY_OBJECT_KIND,
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
      systemId: SCHEDULE_SYSTEM_ID,
      objectKind: ACTIVITY_OBJECT_KIND,
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
      systemId: SCHEDULE_SYSTEM_ID,
      objectKind: ACTIVITY_OBJECT_KIND,
      cursor: beyond,
      limit: 10,
      now: NOW_1,
    });
    expect(beyondResult.ok).toBe(false);
    // The cursor store itself stays untouched by the rejected request.
    expect(await cursorStore.load(stream)).toBeNull();
  });

  it('serves other provider systems of the same family when configured', async () => {
    const store = createScheduleProviderStore();
    store.putObject({
      objectId: TOWER_SCHEDULE_ID,
      objectType: PROJECT_SCHEDULE_OBJECT_KIND,
      displayName: 'Tower A — master schedule',
      data: { name: 'Tower A — master schedule' },
      updatedAt: null,
    });
    const adapter = createScheduleAdapter({
      store,
      systemId: providerSystemId('schedule-instance-02'),
    });
    const page = unwrap(
      await adapter.sync({
        kind: 'sync-request',
        tenantId: TENANT_A,
        systemId: providerSystemId('schedule-instance-02'),
        objectKind: PROJECT_SCHEDULE_OBJECT_KIND,
        cursor: null,
        limit: 10,
        now: NOW_1,
      }),
    );
    expect(page.snapshots[0]?.source.systemId).toBe('schedule-instance-02');
  });
});
