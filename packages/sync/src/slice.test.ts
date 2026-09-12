import { describe, expect, it } from 'vitest';
import {
  MAX_SLICE_READ_LIMIT,
  buildProjectSlice,
  checkCursorSubscription,
  checkSliceContinuity,
  createInMemorySliceSource,
  eventInSliceScope,
  headPositionOf,
  isLedgerEvent,
  isProjectScope,
  isSliceCursor,
  isSlicePosition,
  orderSliceEntries,
  parseLedgerEvent,
  parseProjectScope,
  parseSliceCursor,
  parseSlicePosition,
  sliceCursor,
  sliceEntriesAfter,
} from './slice';
import type { LedgerEvent } from '@office/events';
import type { SlicePosition } from './slice';
import { CURRENT_PROTOCOL_VERSION } from './version';
import {
  ACTOR_A,
  CLIENT_A,
  SCOPE_1,
  SCOPE_2,
  SCOPE_TENANT_B,
  TENANT_A,
  entityIdOf,
  entityKindOf,
  eventEnvelope,
  unwrap,
} from './test-support';
import { subscriptionIdOf } from './identity';

// OFF-028 — project slices: the per-project ordered event stream, its
// DETERMINISTIC total order ((occurredAt, eventId) with dense 1-based
// positions), the subscription-scoped resume cursor, and the ledger READ
// port + its deterministic in-memory implementation (ledger-shaped identity
// semantics: dense per-aggregate sequences, sha256-derived event ids).

const PROGRESS = entityKindOf('progress-update');

/** Trusted test cast: a fixed slice position (constants are hand-verified). */
const slicePositionOf = (n: number): SlicePosition => n as SlicePosition;

const appendProgress = async (
  source: ReturnType<typeof createInMemorySliceSource>,
  parts: {
    readonly occurredAt: string;
    readonly opaque: string;
    readonly scope?: typeof SCOPE_1;
    readonly kind?: ReturnType<typeof entityKindOf>;
  },
) => {
  const aggregate = { entityKind: parts.kind ?? PROGRESS, entityId: entityIdOf(parts.opaque) };
  return unwrap(
    await source.append(
      eventEnvelope({
        eventName: 'schedule.progressRecorded',
        scope: parts.scope ?? SCOPE_1,
        actor: ACTOR_A,
        occurredAt: parts.occurredAt,
        correlationId: 'corr-0f1e2d3c4b5a',
      }),
      aggregate,
    ),
  );
};

describe('slice positions & cursors (fail-closed)', () => {
  it('parses positions >= 0 and rejects everything else', () => {
    expect(unwrap(parseSlicePosition(0))).toBe(0);
    expect(unwrap(parseSlicePosition(1))).toBe(1);
    expect(isSlicePosition(42)).toBe(true);
    for (const bad of [-1, 1.5, '3', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseSlicePosition(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('composes and parses cursors; membership is typed-checked', () => {
    const subscriptionId = subscriptionIdOf({
      tenantId: TENANT_A,
      projectId: SCOPE_1.projectId,
      subscriberId: CLIENT_A,
      ordinal: 1,
    });
    const cursor = sliceCursor({ subscriptionId, position: slicePositionOf(7) });
    expect(unwrap(parseSliceCursor(cursor))).toEqual(cursor);
    expect(isSliceCursor(cursor)).toBe(true);
    expect(unwrap(checkCursorSubscription(cursor, subscriptionId))).toBe(true);
    const other = subscriptionIdOf({
      tenantId: TENANT_A,
      projectId: SCOPE_1.projectId,
      subscriberId: CLIENT_A,
      ordinal: 2,
    });
    const failed = checkCursorSubscription(cursor, other);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invariant-violation');
      expect(failed.error.details[0]?.code).toBe('cursor-subscription-mismatch');
    }
    expect(parseSliceCursor({ kind: 'slice-cursor', subscriptionId, position: -1 }).ok).toBe(false);
    expect(parseSliceCursor({ kind: 'slice-cursor', subscriptionId, position: 1, extra: true }).ok).toBe(false);
  });

  it('parses project scopes and rejects tenant scopes (a slice is project-scoped)', () => {
    expect(unwrap(parseProjectScope(SCOPE_1))).toEqual(SCOPE_1);
    expect(isProjectScope(SCOPE_1)).toBe(true);
    expect(parseProjectScope({ kind: 'tenant', tenantId: TENANT_A }).ok).toBe(false);
    expect(parseProjectScope({ kind: 'project', tenantId: TENANT_A, projectId: 'prj-1' }).ok).toBe(false);
  });
});

describe('deterministic slice ordering (the protocol backbone)', () => {
  it('orders by occurredAt ascending with the eventId tiebreak, dense 1-based positions', async () => {
    const source = createInMemorySliceSource();
    const early = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    const late = await appendProgress(source, { occurredAt: '2026-09-12T10:16:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1' });
    const tieA = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2' });
    const tieB = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'd4e5f60718293a4b5c6d7e8f9a1b2c3' });
    const events = [late, tieB, early, tieA];
    const ordered = orderSliceEntries(events);
    // occurredAt is the primary key: the three same-instant events come first
    // (ordered by their eventId tiebreak), then the later event — regardless
    // of where the later event's id would sort among them.
    const byEventId = (left: LedgerEvent, right: LedgerEvent) =>
      left.eventId === right.eventId ? 0 : left.eventId < right.eventId ? -1 : 1;
    expect(ordered.map((entry) => entry.event.eventId)).toEqual([
      ...[early, tieA, tieB].sort(byEventId).map((event) => event.eventId),
      late.eventId,
    ]);
    expect(ordered.map((entry) => entry.position)).toEqual([1, 2, 3, 4]);
  });

  it('produces the identical slice regardless of input order (run-twice identity)', async () => {
    const source = createInMemorySliceSource();
    const events: LedgerEvent[] = [
      await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' }),
      await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1' }),
      await appendProgress(source, { occurredAt: '2026-09-13T08:00:00.000Z', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2' }),
    ];
    const first = orderSliceEntries([...events].reverse());
    const second = orderSliceEntries([...events]);
    const third = orderSliceEntries([events[1]!, events[2]!, events[0]!]);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('builds the project slice with scope filtering and dense positions', async () => {
    const source = createInMemorySliceSource();
    const inSlice = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    const otherProject = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1', scope: SCOPE_2 });
    const otherTenant = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2', scope: SCOPE_TENANT_B });
    const slice = buildProjectSlice(SCOPE_1, CURRENT_PROTOCOL_VERSION, source.events);
    expect(slice.protocolVersion).toBe(CURRENT_PROTOCOL_VERSION);
    expect(slice.entries.map((entry) => entry.event.eventId)).toEqual([inSlice.eventId]);
    expect(slice.entries[0]?.position).toBe(1);
    // A12: foreign-scope events are invisible, never an error.
    expect(eventInSliceScope(otherProject, SCOPE_1)).toBe(false);
    expect(eventInSliceScope(otherTenant, SCOPE_1)).toBe(false);
    expect(eventInSliceScope(inSlice, SCOPE_1)).toBe(true);
  });

  it('exposes the resume window and head position', async () => {
    const source = createInMemorySliceSource();
    await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    await appendProgress(source, { occurredAt: '2026-09-12T10:16:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1' });
    await appendProgress(source, { occurredAt: '2026-09-12T10:17:31.000Z', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2' });
    const slice = buildProjectSlice(SCOPE_1, CURRENT_PROTOCOL_VERSION, source.events);
    expect(headPositionOf(slice)).toBe(3);
    expect(sliceEntriesAfter(slice, slicePositionOf(0)).map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(sliceEntriesAfter(slice, slicePositionOf(1)).map((entry) => entry.position)).toEqual([2, 3]);
    expect(sliceEntriesAfter(slice, slicePositionOf(3))).toEqual([]);
    const empty = buildProjectSlice(SCOPE_2, CURRENT_PROTOCOL_VERSION, source.events);
    expect(headPositionOf(empty)).toBe(0);
  });

  it('verifies continuity fail-closed (a gap is a typed invariant-violation)', async () => {
    const source = createInMemorySliceSource();
    const event = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    const contiguous = [
      { event, position: slicePositionOf(4) },
      { event, position: slicePositionOf(5) },
    ];
    expect(unwrap(checkSliceContinuity(contiguous, slicePositionOf(3)))).toBe(true);
    const gapped = [
      { event, position: slicePositionOf(4) },
      { event, position: slicePositionOf(6) },
    ];
    const failed = checkSliceContinuity(gapped, slicePositionOf(3));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invariant-violation');
      expect(failed.error.details[0]?.code).toBe('slice-continuity');
    }
  });
});

describe('ledger event parse boundary (fail-closed)', () => {
  it('round-trips an in-memory-source event', async () => {
    const source = createInMemorySliceSource();
    const event = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    expect(unwrap(parseLedgerEvent(event))).toEqual(event);
    expect(isLedgerEvent(event)).toBe(true);
  });

  it('rejects malformed ledger events fail-closed', async () => {
    const source = createInMemorySliceSource();
    const event = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    const raw = event as unknown as Record<string, unknown>;
    expect(parseLedgerEvent({ ...raw, eventId: 'evt-1' }).ok).toBe(false);
    expect(parseLedgerEvent({ ...raw, sequence: 0 }).ok).toBe(false);
    expect(parseLedgerEvent({ ...raw, extra: 1 }).ok).toBe(false);
    expect(parseLedgerEvent({ ...raw, envelope: { kind: 'event' } }).ok).toBe(false);
    expect(parseLedgerEvent('event').ok).toBe(false);
    expect(parseLedgerEvent(null).ok).toBe(false);
  });
});

describe('the in-memory slice source (ledger-shaped, deterministic)', () => {
  it('assigns dense per-aggregate sequences and sha-derived deterministic ids', async () => {
    const run = async () => {
      const source = createInMemorySliceSource();
      const first = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
      const second = await appendProgress(source, { occurredAt: '2026-09-12T10:16:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
      const otherAggregate = await appendProgress(source, { occurredAt: '2026-09-12T10:17:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1' });
      return { ids: [first.eventId, second.eventId, otherAggregate.eventId], sequences: [first.sequence, second.sequence, otherAggregate.sequence] };
    };
    const firstRun = await run();
    const secondRun = await run();
    expect(firstRun).toEqual(secondRun); // run-twice identity (A9 replayability)
    expect(firstRun.sequences).toEqual([1, 2, 1]); // dense PER aggregate
    expect(firstRun.ids[0]).not.toBe(firstRun.ids[1]);
    expect(firstRun.ids[0]).not.toBe(firstRun.ids[2]);
  });

  it('reads resumable windows: contiguous positions, limit-bounded, after-exclusive', async () => {
    const source = createInMemorySliceSource();
    for (const opaque of ['a1b2c3d4e5f60718293a4b5c6d7e8f9', 'b2c3d4e5f60718293a4b5c6d7e8f9a1', 'c3d4e5f60718293a4b5c6d7e8f9a1b2']) {
      await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque });
    }
    const fromStart = unwrap(await source.readSlice({ scope: SCOPE_1, after: slicePositionOf(0), limit: 2 }));
    expect(fromStart.map((entry) => entry.position)).toEqual([1, 2]);
    const resumed = unwrap(await source.readSlice({ scope: SCOPE_1, after: slicePositionOf(2), limit: MAX_SLICE_READ_LIMIT }));
    expect(resumed.map((entry) => entry.position)).toEqual([3]);
    expect(unwrap(checkSliceContinuity(resumed, slicePositionOf(2)))).toBe(true);
    // A12: another project's slice is simply empty here.
    const foreign = unwrap(await source.readSlice({ scope: SCOPE_2, after: slicePositionOf(0), limit: 10 }));
    expect(foreign).toEqual([]);
  });

  it('rejects invalid read limits fail-closed', async () => {
    const source = createInMemorySliceSource();
    for (const limit of [0, -1, 1.5, MAX_SLICE_READ_LIMIT + 1]) {
      const failed = await source.readSlice({ scope: SCOPE_1, after: slicePositionOf(0), limit });
      expect(failed.ok, String(limit)).toBe(false);
      if (!failed.ok) {
        expect(failed.error.code).toBe('invariant-violation');
        expect(failed.error.details[0]?.code).toBe('slice-read-limit');
      }
    }
  });

  it('rejects structurally invalid appends fail-closed (the ledger is never garbled)', async () => {
    const source = createInMemorySliceSource();
    const badEnvelope = { kind: 'event' } as never;
    const first = await source.append(badEnvelope, { entityKind: PROGRESS, entityId: CLIENT_A });
    expect(first.ok).toBe(false);
    const second = await source.append(
      eventEnvelope({
        eventName: 'schedule.progressRecorded',
        scope: SCOPE_1,
        actor: ACTOR_A,
        occurredAt: '2026-09-12T10:15:31.000Z',
        correlationId: 'corr-0f1e2d3c4b5a',
      }),
      { entityKind: PROGRESS, entityId: 'ent-1' } as never,
    );
    expect(second.ok).toBe(false);
    expect(source.events).toEqual([]);
  });
});
