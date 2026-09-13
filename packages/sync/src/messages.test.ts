import { describe, expect, it } from 'vitest';
import {
  parseConflictNotifiedMessage,
  parseEventDeliveredMessage,
  parseGrantRevokedMessage,
  parseProtocolErrorMessage,
  parseSliceCatchupMessage,
  parseSliceEntry,
  parseStreamMessage,
} from './messages';
import type {
  EventDeliveredMessage,
  GrantRevokedMessage,
  ProtocolErrorMessage,
  SliceCatchupMessage,
} from './messages';
import { createInMemorySliceSource, sliceCursor } from './slice';
import type { SlicePosition } from './slice';
import { clientOperation, operationDigestOf } from './operations';
import type { ClientOperation } from './operations';
import { detectConflict } from './conflict';
import { operationIdOf, subscriptionIdOf, subscriptionGrantIdOf } from './identity';
import { CURRENT_PROTOCOL_VERSION } from './version';
import {
  ACTOR_A,
  ACTOR_ADMIN,
  CLIENT_A,
  CLIENT_B,
  NOW_3,
  SCOPE_1,
  TENANT_A,
  entityIdOf,
  entityKindOf,
  eventEnvelope,
  operationKindOf,
  unwrap,
} from './test-support';

// OFF-028 — the five typed stream protocol messages. Every message is a
// plain JSON value with a strict fail-closed parse: unknown kinds, unknown
// fields, unknown protocol versions, cursor/position inconsistencies — all
// typed errors, never silent acceptance. Fixed everything; deterministic.

const PROGRESS = entityKindOf('progress-update');

const makeEvent = async () => {
  const source = createInMemorySliceSource();
  return unwrap(
    await source.append(
      eventEnvelope({
        eventName: 'schedule.progressRecorded',
        scope: SCOPE_1,
        actor: ACTOR_A,
        occurredAt: '2026-09-12T10:15:31.000Z',
        correlationId: 'corr-0f1e2d3c4b5a',
      }),
      { entityKind: PROGRESS, entityId: CLIENT_A },
    ),
  );
};

const subscriptionId = () =>
  subscriptionIdOf({ tenantId: TENANT_A, projectId: SCOPE_1.projectId, subscriberId: CLIENT_A, ordinal: 1 });

const position = (n: number): SlicePosition => n as SlicePosition;

const makeOperation = (subscriberOpaque: string, payload: Record<string, unknown>): ClientOperation => {
  const subscriberId = entityIdOf(subscriberOpaque);
  const sub = subscriptionIdOf({ tenantId: TENANT_A, projectId: SCOPE_1.projectId, subscriberId, ordinal: 1 });
  return clientOperation({
    operationId: operationIdOf({ subscriptionId: sub, position: 2, operationKind: 'record-progress' }),
    subscriptionId: sub,
    position: position(2),
    operationKind: operationKindOf('record-progress'),
    actor: { kind: 'user', actorId: subscriberId },
    scope: SCOPE_1,
    target: { entityKind: PROGRESS, entityId: CLIENT_A },
    payloadDigest: operationDigestOf(payload),
  });
};

const makeConflict = () =>
  unwrap(
    detectConflict({
      operations: [
        makeOperation('a1b2c3d4e5f60718293a4b5c6d7e8f9', { percent: 40 }),
        makeOperation('b2c3d4e5f60718293a4b5c6d7e8f9a1', { percent: 60 }),
      ],
      detectedAt: NOW_3,
      detectedBy: ACTOR_ADMIN,
    }),
  );

describe('event-delivered (the envelope + ledger sequence + position + cursor)', () => {
  it('round-trips a valid message', async () => {
    const event = await makeEvent();
    const message: EventDeliveredMessage = {
      kind: 'event-delivered',
      subscriptionId: subscriptionId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      event,
      position: position(1),
      cursor: sliceCursor({ subscriptionId: subscriptionId(), position: position(1) }),
    };
    expect(unwrap(parseEventDeliveredMessage(message))).toEqual(message);
    expect(unwrap(parseStreamMessage(message))).toEqual(message);
  });

  it('rejects cursor inconsistencies, unknown fields, and bad versions fail-closed', async () => {
    const event = await makeEvent();
    const base: EventDeliveredMessage = {
      kind: 'event-delivered',
      subscriptionId: subscriptionId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      event,
      position: position(1),
      cursor: sliceCursor({ subscriptionId: subscriptionId(), position: position(1) }),
    };
    const raw = base as unknown as Record<string, unknown>;
    const wrongPosition: Record<string, unknown> = {
      ...raw,
      cursor: { kind: 'slice-cursor', subscriptionId: subscriptionId(), position: 2 },
    };
    expect(parseEventDeliveredMessage(wrongPosition).ok).toBe(false);
    const foreignCursor: Record<string, unknown> = {
      ...raw,
      cursor: {
        kind: 'slice-cursor',
        subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: SCOPE_1.projectId, subscriberId: CLIENT_B, ordinal: 1 }),
        position: 1,
      },
    };
    expect(parseEventDeliveredMessage(foreignCursor).ok).toBe(false);
    expect(parseEventDeliveredMessage({ ...raw, extra: 1 }).ok).toBe(false);
    expect(parseEventDeliveredMessage({ ...raw, protocolVersion: '2.0.0' }).ok).toBe(false);
    expect(parseEventDeliveredMessage({ ...raw, position: 0 }).ok).toBe(false);
    expect(parseEventDeliveredMessage({ ...raw, event: { eventId: 'evt-1' } }).ok).toBe(false);
  });
});

describe('slice-catchup (the bulk resumption window from a cursor)', () => {
  it('round-trips a valid catchup and an empty one', async () => {
    const event = await makeEvent();
    const message: SliceCatchupMessage = {
      kind: 'slice-catchup',
      subscriptionId: subscriptionId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      entries: [
        { event, position: position(2) },
        { event, position: position(4) },
      ],
      cursor: sliceCursor({ subscriptionId: subscriptionId(), position: position(4) }),
    };
    expect(unwrap(parseSliceCatchupMessage(message))).toEqual(message);
    const empty: SliceCatchupMessage = {
      kind: 'slice-catchup',
      subscriptionId: subscriptionId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      entries: [],
      cursor: sliceCursor({ subscriptionId: subscriptionId(), position: position(0) }),
    };
    expect(unwrap(parseSliceCatchupMessage(empty))).toEqual(empty);
  });

  it('rejects descending positions, cursor/last-entry mismatch, and strict-key violations', async () => {
    const event = await makeEvent();
    const raw = {
      kind: 'slice-catchup',
      subscriptionId: subscriptionId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      entries: [
        { event, position: 2 },
        { event, position: 1 },
      ],
      cursor: { kind: 'slice-cursor', subscriptionId: subscriptionId(), position: 1 },
    };
    expect(parseSliceCatchupMessage(raw).ok).toBe(false);
    const cursorMismatch = {
      ...raw,
      entries: [{ event, position: 2 }],
      cursor: { kind: 'slice-cursor', subscriptionId: subscriptionId(), position: 5 },
    };
    expect(parseSliceCatchupMessage(cursorMismatch).ok).toBe(false);
    expect(parseSliceCatchupMessage({ ...raw, extra: true }).ok).toBe(false);
    expect(parseSliceCatchupMessage('catchup').ok).toBe(false);
  });

  it('parses slice entries fail-closed (positions are 1-based)', async () => {
    const event = await makeEvent();
    expect(unwrap(parseSliceEntry({ event, position: 3 }))).toEqual({ event, position: 3 });
    expect(parseSliceEntry({ event, position: 0 }).ok).toBe(false);
    expect(parseSliceEntry({ event }).ok).toBe(false);
    expect(parseSliceEntry({ event, position: 1, extra: 1 }).ok).toBe(false);
    expect(parseSliceEntry(null).ok).toBe(false);
  });
});

describe('grant-revoked (the clean stop)', () => {
  it('round-trips a valid message and rejects malformed ones', () => {
    const message: GrantRevokedMessage = {
      kind: 'grant-revoked',
      subscriptionId: subscriptionId(),
      grantId: subscriptionGrantIdOf({ tenantId: TENANT_A, subscriberId: CLIENT_A, serial: 1 }),
      revokedAt: NOW_3,
    };
    expect(unwrap(parseGrantRevokedMessage(message))).toEqual(message);
    expect(unwrap(parseStreamMessage(message))).toEqual(message);
    const raw = message as unknown as Record<string, unknown>;
    expect(parseGrantRevokedMessage({ ...raw, grantId: 'grant-1' }).ok).toBe(false);
    expect(parseGrantRevokedMessage({ ...raw, revokedAt: 'yesterday' }).ok).toBe(false);
    expect(parseGrantRevokedMessage({ ...raw, extra: 1 }).ok).toBe(false);
  });
});

describe('conflict-notified (the surfaced conflict record)', () => {
  it('round-trips a valid message and rejects malformed ones', () => {
    const message = {
      kind: 'conflict-notified',
      subscriptionId: subscriptionId(),
      conflict: makeConflict(),
    };
    expect(unwrap(parseConflictNotifiedMessage(message))).toEqual(message);
    expect(unwrap(parseStreamMessage(message))).toEqual(message);
    const raw = message as unknown as Record<string, unknown>;
    expect(parseConflictNotifiedMessage({ ...raw, conflict: { kind: 'sync-conflict' } }).ok).toBe(false);
    expect(parseConflictNotifiedMessage({ ...raw, extra: 1 }).ok).toBe(false);
  });
});

describe('protocol-error (typed, fail-closed, closed vocabulary)', () => {
  it('round-trips each closed code, with and without a subscription context', () => {
    for (const code of ['unknown-protocol-version', 'cursor-subscription-mismatch', 'slice-discontinuity'] as const) {
      const message: ProtocolErrorMessage = {
        kind: 'protocol-error',
        subscriptionId: subscriptionId(),
        code,
        message: `typed failure: ${code}`,
      };
      expect(unwrap(parseProtocolErrorMessage(message))).toEqual(message);
      const streamless: ProtocolErrorMessage = { ...message, subscriptionId: null };
      expect(unwrap(parseProtocolErrorMessage(streamless))).toEqual(streamless);
    }
  });

  it('rejects unknown codes and malformed messages fail-closed', () => {
    const raw = {
      kind: 'protocol-error',
      subscriptionId: subscriptionId(),
      code: 'something-broke',
      message: 'nope',
    };
    expect(parseProtocolErrorMessage(raw).ok).toBe(false);
    expect(parseProtocolErrorMessage({ ...raw, code: 'slice-discontinuity', message: '' }).ok).toBe(false);
    expect(parseProtocolErrorMessage({ ...raw, code: 'slice-discontinuity', message: 7 }).ok).toBe(false);
    expect(parseProtocolErrorMessage({ ...raw, code: 'slice-discontinuity', message: 'x'.repeat(513) }).ok).toBe(false);
    expect(parseProtocolErrorMessage({ ...raw, code: 'slice-discontinuity', extra: 1 }).ok).toBe(false);
  });
});

describe('parseStreamMessage dispatch (fail-closed on kind)', () => {
  it('rejects unknown kinds and non-object values', () => {
    expect(parseStreamMessage({ kind: 'mystery-message' }).ok).toBe(false);
    expect(parseStreamMessage({}).ok).toBe(false);
    expect(parseStreamMessage('message').ok).toBe(false);
    expect(parseStreamMessage(null).ok).toBe(false);
    expect(parseStreamMessage({ kind: 42 }).ok).toBe(false);
  });
});
