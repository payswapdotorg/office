import { describe, expect, it } from 'vitest';
import { parseTenantId, parseTimestamp } from '@office/contracts';
import type { TenantId, Timestamp } from '@office/contracts';
import {
  checkCursorStream,
  createInMemorySyncCursorStore,
  isSyncCheckpoint,
  isSyncCursor,
  isSyncCursorToken,
  isSyncStream,
  nextCursor,
  parseSyncCheckpoint,
  parseSyncCursor,
  parseSyncCursorToken,
  parseSyncStream,
  syncCursor,
  syncCursorToken,
  syncStream,
  syncStreamKeyOf,
} from './cursor';
import { adapterKind, providerObjectKind, providerSystemId, providerVersion } from './identity';

// OFF-020 adapters-sdk — resumable, replay-safe sync cursors. Replay safety
// is two-layered: POSITIONAL (a restart hands the provider the opaque token,
// so nothing checkpointed is re-delivered) and IDEMPOTENT (the command keys
// derive from SourceRef + version, so even re-delivered items no-op). A
// cursor presented to the WRONG stream — different tenant (A12) or different
// adapter/system/object-kind — is typed-rejected before any sync runs, and a
// cursor never rewinds silently. Deterministic: fixed tenants/instants.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160504f3e2d1c0b'));

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));

const KIND = adapterKind('fake-crm');
const SYSTEM = providerSystemId('fake-instance-01');
const CONTACTS = providerObjectKind('contact');
const TASKS = providerObjectKind('task');

const stream = (parts?: {
  readonly tenantId?: TenantId;
  readonly adapterKind?: typeof KIND;
  readonly systemId?: typeof SYSTEM;
  readonly objectKind?: typeof CONTACTS;
}) =>
  syncStream({
    tenantId: parts?.tenantId ?? TENANT_A,
    adapterKind: parts?.adapterKind ?? KIND,
    systemId: parts?.systemId ?? SYSTEM,
    objectKind: parts?.objectKind ?? CONTACTS,
  });

const STREAM = stream();
const checkpoint = (itemsObserved: number, lastProviderVersion: string | null) => ({
  itemsObserved,
  lastProviderVersion:
    lastProviderVersion === null ? null : providerVersion(lastProviderVersion),
});

const cursor = (parts?: {
  readonly stream?: ReturnType<typeof stream>;
  readonly token?: string;
  readonly itemsObserved?: number;
  readonly updatedAt?: Timestamp;
}) =>
  syncCursor({
    stream: parts?.stream ?? STREAM,
    token: syncCursorToken(parts?.token ?? '3'),
    checkpoint: checkpoint(parts?.itemsObserved ?? 3, 'v3'),
    updatedAt: parts?.updatedAt ?? NOW_1,
  });

describe('sync stream / checkpoint / cursor parsing (fail-closed)', () => {
  it('parses valid shapes with strict keys and round-trips them', () => {
    const parsedStream = parseSyncStream(STREAM);
    expect(parsedStream.ok).toBe(true);
    if (parsedStream.ok) expect(parsedStream.value).toStrictEqual(STREAM);
    expect(isSyncStream(STREAM)).toBe(true);

    const cp = checkpoint(3, 'v3');
    const parsedCp = parseSyncCheckpoint(cp);
    expect(parsedCp.ok).toBe(true);
    if (parsedCp.ok) expect(parsedCp.value).toStrictEqual(cp);
    expect(isSyncCheckpoint(cp)).toBe(true);
    expect(isSyncCheckpoint(checkpoint(0, null))).toBe(true);

    const c = cursor();
    const parsedCursor = parseSyncCursor(c);
    expect(parsedCursor.ok).toBe(true);
    if (parsedCursor.ok) expect(parsedCursor.value).toStrictEqual(c);
    expect(isSyncCursor(c)).toBe(true);

    const token = parseSyncCursorToken('opaque-token-01');
    expect(token.ok).toBe(true);
    expect(isSyncCursorToken('opaque-token-01')).toBe(true);
  });

  it('rejects malformed streams, checkpoints, cursors, and tokens', () => {
    for (const raw of [
      null,
      'stream',
      { ...STREAM, objectKind: 'Task' },
      { ...STREAM, extra: 1 },
      { tenantId: TENANT_A, adapterKind: KIND, systemId: SYSTEM },
    ]) {
      expect(parseSyncStream(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isSyncStream(raw)).toBe(false);
    }
    for (const raw of [
      null,
      { itemsObserved: -1, lastProviderVersion: null },
      { itemsObserved: 1.5, lastProviderVersion: null },
      { itemsObserved: 3 },
      { itemsObserved: 3, lastProviderVersion: 'v 3' },
      { itemsObserved: 3, lastProviderVersion: 'v3', extra: null },
    ]) {
      expect(parseSyncCheckpoint(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isSyncCheckpoint(raw)).toBe(false);
    }
    for (const raw of [
      null,
      { ...cursor(), kind: 'other-cursor' },
      { ...cursor(), unknown: 'field' },
      { ...cursor(), token: 'has space' },
      { ...cursor(), updatedAt: 'yesterday' },
    ]) {
      expect(parseSyncCursor(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isSyncCursor(raw)).toBe(false);
    }
    for (const raw of ['', 'has space', 3, null, 'x'.repeat(1025)]) {
      expect(parseSyncCursorToken(raw).ok, `raw: ${String(raw)}`).toBe(false);
      expect(isSyncCursorToken(raw)).toBe(false);
    }
  });

  it('serializes the stream key canonically and deterministically', () => {
    expect(syncStreamKeyOf(STREAM)).toBe(
      `["${TENANT_A}","fake-crm","fake-instance-01","contact"]`,
    );
    expect(syncStreamKeyOf(stream())).toBe(syncStreamKeyOf(STREAM));
    expect(syncStreamKeyOf(stream({ tenantId: TENANT_B }))).not.toBe(syncStreamKeyOf(STREAM));
    expect(syncStreamKeyOf(stream({ objectKind: TASKS }))).not.toBe(syncStreamKeyOf(STREAM));
  });
});

describe('stream membership (a cursor never resumes a foreign stream)', () => {
  it('accepts a cursor of exactly the same stream', () => {
    const membership = checkCursorStream(cursor(), STREAM);
    expect(membership.ok).toBe(true);
  });

  it('typed-rejects a cursor of a different TENANT as unauthorized (A12)', () => {
    const membership = checkCursorStream(cursor({ stream: stream({ tenantId: TENANT_B }) }), STREAM);
    expect(membership.ok).toBe(false);
    if (!membership.ok) {
      expect(membership.error.code).toBe('unauthorized');
      expect(membership.error.details[0]?.code).toBe('tenant-scope-violation');
    }
  });

  it('typed-rejects a cursor of a different adapter/system/object-kind', () => {
    for (const foreign of [
      stream({ adapterKind: adapterKind('fake-pm') }),
      stream({ systemId: providerSystemId('fake-instance-02') }),
      stream({ objectKind: TASKS }),
    ]) {
      const membership = checkCursorStream(cursor({ stream: foreign }), STREAM);
      expect(membership.ok, `foreign: ${syncStreamKeyOf(foreign)}`).toBe(false);
      if (!membership.ok) {
        expect(membership.error.code).toBe('invariant-violation');
        expect(membership.error.details[0]?.code).toBe('cursor-stream-mismatch');
      }
    }
  });
});

describe('cursor advancement (nextCursor)', () => {
  it('advances deterministically from a fresh start and from a prior cursor', () => {
    const fresh = nextCursor({
      stream: STREAM,
      previous: null,
      token: syncCursorToken('2'),
      checkpoint: checkpoint(2, 'v2'),
      now: NOW_1,
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.value.token).toBe('2');
      expect(fresh.value.checkpoint.itemsObserved).toBe(2);
      expect(fresh.value.updatedAt).toBe(NOW_1);
    }

    const advanced = nextCursor({
      stream: STREAM,
      previous: unwrap(fresh),
      token: syncCursorToken('5'),
      checkpoint: checkpoint(5, 'v5'),
      now: NOW_2,
    });
    expect(advanced.ok).toBe(true);
    if (advanced.ok) {
      expect(advanced.value.token).toBe('5');
      expect(advanced.value.checkpoint.itemsObserved).toBe(5);
      expect(advanced.value.updatedAt).toBe(NOW_2);
    }
  });

  it('typed-rejects checkpoint regression — a cursor never rewinds silently', () => {
    const regression = nextCursor({
      stream: STREAM,
      previous: cursor({ itemsObserved: 5 }),
      token: syncCursorToken('2'),
      checkpoint: checkpoint(2, 'v2'),
      now: NOW_2,
    });
    expect(regression.ok).toBe(false);
    if (!regression.ok) {
      expect(regression.error.code).toBe('invariant-violation');
      expect(regression.error.details[0]?.code).toBe('cursor-checkpoint-regression');
    }
    // An equal-or-larger checkpoint is accepted (idempotent re-observation).
    const same = nextCursor({
      stream: STREAM,
      previous: cursor({ itemsObserved: 5 }),
      token: syncCursorToken('5'),
      checkpoint: checkpoint(5, 'v5'),
      now: NOW_3,
    });
    expect(same.ok).toBe(true);
  });

  it('typed-rejects a previous cursor from a different stream before advancing', () => {
    const foreign = nextCursor({
      stream: STREAM,
      previous: cursor({ stream: stream({ objectKind: TASKS }) }),
      token: syncCursorToken('5'),
      checkpoint: checkpoint(5, 'v5'),
      now: NOW_2,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('invariant-violation');
    const crossTenant = nextCursor({
      stream: STREAM,
      previous: cursor({ stream: stream({ tenantId: TENANT_B }) }),
      token: syncCursorToken('5'),
      checkpoint: checkpoint(5, 'v5'),
      now: NOW_2,
    });
    expect(crossTenant.ok).toBe(false);
    if (!crossTenant.ok) expect(crossTenant.error.code).toBe('unauthorized');
  });
});

describe('the in-memory cursor store (the persisted-position fixture)', () => {
  it('loads null for a stream that never synced', async () => {
    const store = createInMemorySyncCursorStore();
    expect(await store.load(STREAM)).toBeNull();
  });

  it('saves and reloads the stream cursor exactly (restart resumes here)', async () => {
    const store = createInMemorySyncCursorStore();
    const saved = unwrap(
      await store.save(
        syncCursor({
          stream: STREAM,
          token: syncCursorToken('7'),
          checkpoint: checkpoint(7, 'v7'),
          updatedAt: NOW_1,
        }),
      ),
    );
    expect(await store.load(STREAM)).toStrictEqual(saved);
    // Another stream (or tenant) sees nothing — no existence oracle.
    expect(await store.load(stream({ objectKind: TASKS }))).toBeNull();
    expect(await store.load(stream({ tenantId: TENANT_B }))).toBeNull();
  });

  it('refuses to rewind the persisted position', async () => {
    const store = createInMemorySyncCursorStore();
    unwrap(
      await store.save(
        syncCursor({
          stream: STREAM,
          token: syncCursorToken('7'),
          checkpoint: checkpoint(7, 'v7'),
          updatedAt: NOW_1,
        }),
      ),
    );
    const rewind = await store.save(
      syncCursor({
        stream: STREAM,
        token: syncCursorToken('2'),
        checkpoint: checkpoint(2, 'v2'),
        updatedAt: NOW_2,
      }),
    );
    expect(rewind.ok).toBe(false);
    if (!rewind.ok) {
      expect(rewind.error.code).toBe('invariant-violation');
      expect(rewind.error.details[0]?.code).toBe('cursor-checkpoint-regression');
    }
    // The persisted cursor still points at 7.
    expect((await store.load(STREAM))?.checkpoint.itemsObserved).toBe(7);
  });
});
