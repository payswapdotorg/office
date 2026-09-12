import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, enqueueOutbox } from '@office/events';
import type { AppendEventInput, LedgerEvent, OutboxRecord } from '@office/events';
import { parseCommandEnvelope, parseEntityId, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, DomainEventEnvelope, ParseResult, Timestamp } from '@office/contracts';
import { createLedgerEventSink } from './ledger-sink';
import { FIELD_EVENT_CAPTURED_EVENT, fieldEventEnvelope } from './events';
import { FIELD_EVENT_KIND } from './state';
import type { SqlExecutor } from '@office/persistence';

// OFF-009 field domain — the ledger-backed EventSink adapter, unit-level: the
// @office/events ledger functions are MOCKED (no real PostgreSQL), and the
// tests prove the delegation SHAPE: every envelope is appended through
// appendEvent and outboxed through enqueueOutbox on the SAME caller-supplied
// executor (the open transaction of the surrounding mutation), in order, with
// the aggregate derived from the envelope's entityRefs.after — and any ledger
// failure propagates so the handler aborts the whole mutation.

vi.mock('@office/events', () => ({
  appendEvent: vi.fn(),
  enqueueOutbox: vi.fn(),
}));

const mockedAppendEvent = vi.mocked(appendEvent);
const mockedEnqueueOutbox = vi.mocked(enqueueOutbox);

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_1 = unwrap(parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
const USER = 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1';
const FIELD_EVENT_ENTITY_ID = unwrap(parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'));

const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const EXECUTOR_A: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };
const EXECUTOR_B: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };

const command: CommandEnvelope = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'field.captureFieldEvent',
    scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 },
    actor: { kind: 'user', actorId: USER },
    idempotencyKey: 'idem-ledger-sink-1',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: {},
  }),
);

const captureEnvelope = (suffix: string): DomainEventEnvelope =>
  fieldEventEnvelope({
    command,
    eventName: FIELD_EVENT_CAPTURED_EVENT,
    scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 },
    occurredAt: NOW,
    entityRefs: {
      before: null,
      after: { entityKind: FIELD_EVENT_KIND, entityId: FIELD_EVENT_ENTITY_ID },
    },
    payload: {
      fieldEventId: FIELD_EVENT_ENTITY_ID,
      category: 'delivery-arrival',
      summary: `Concrete pour started at level 3 ${suffix}`,
      detail: null,
      location: 'Level 3, north face',
      observedAt: NOW,
      observedBy: FIELD_EVENT_ENTITY_ID,
      quantity: null,
      evidence: [],
      status: 'open',
      version: 1,
      createdAt: NOW,
    },
  });

/** The LedgerEvent the mocked appendEvent resolves with. */
const ledgerEventOf = (input: AppendEventInput): LedgerEvent => ({
  eventId: 'office-evt-v1-0123456789abcdef' as LedgerEvent['eventId'],
  sequence: 1 as LedgerEvent['sequence'],
  aggregate: input.aggregate,
  envelope: input.envelope,
});

/** The OutboxRecord the mocked enqueueOutbox resolves with. */
const outboxRecordOf = (event: LedgerEvent): OutboxRecord => ({
  outboxId: 1,
  eventId: event.eventId,
  scope: event.envelope.scope,
  state: 'pending',
  attempts: 0,
  availableAt: event.envelope.occurredAt,
  createdAt: event.envelope.occurredAt,
  dispatchedAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createLedgerEventSink (ledger-backed adapter, mocked ledger)', () => {
  it('delegates each envelope to appendEvent + enqueueOutbox on the SAME executor', async () => {
    mockedAppendEvent.mockImplementation(async (db, input) => {
      expect(db).toBe(EXECUTOR_A);
      return { ok: true, value: ledgerEventOf(input) };
    });
    mockedEnqueueOutbox.mockImplementation(async (db, event) => {
      expect(db).toBe(EXECUTOR_A);
      return { ok: true, value: outboxRecordOf(event) };
    });

    const sink = createLedgerEventSink();
    const event = captureEnvelope('one');
    const result = await sink.appendEvents(EXECUTOR_A, [event]);

    expect(result.ok).toBe(true);
    expect(mockedAppendEvent).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueOutbox).toHaveBeenCalledTimes(1);

    const appendCall = mockedAppendEvent.mock.calls[0];
    expect(appendCall?.[0]).toBe(EXECUTOR_A);
    expect(appendCall?.[1]?.envelope).toBe(event);
    // The aggregate is derived from the envelope's entityRefs.after.
    expect(appendCall?.[1]?.aggregate).toStrictEqual(event.entityRefs.after);

    const outboxCall = mockedEnqueueOutbox.mock.calls[0];
    // appendEvent and enqueueOutbox receive the SAME executor — the caller's
    // ONE open transaction (the canonical atomic pattern).
    expect(outboxCall?.[0]).toBe(appendCall?.[0]);
    // The outboxed event is exactly what appendEvent returned.
    expect(outboxCall?.[1]?.eventId).toBe(ledgerEventOf({
      envelope: event,
      aggregate: event.entityRefs.after as AppendEventInput['aggregate'],
    }).eventId);
    expect(outboxCall?.[1]?.envelope).toBe(event);
  });

  it('appends and enqueues every envelope of a multi-event batch, in order', async () => {
    const appended: AppendEventInput[] = [];
    mockedAppendEvent.mockImplementation(async (db, input) => {
      expect(db).toBe(EXECUTOR_B);
      appended.push(input);
      return { ok: true, value: ledgerEventOf(input) };
    });
    const enqueued: LedgerEvent[] = [];
    mockedEnqueueOutbox.mockImplementation(async (db, event) => {
      expect(db).toBe(EXECUTOR_B);
      enqueued.push(event);
      return { ok: true, value: outboxRecordOf(event) };
    });

    const sink = createLedgerEventSink();
    const events = [captureEnvelope('one'), captureEnvelope('two')];
    const result = await sink.appendEvents(EXECUTOR_B, events);

    expect(result.ok).toBe(true);
    expect(mockedAppendEvent).toHaveBeenCalledTimes(2);
    expect(mockedEnqueueOutbox).toHaveBeenCalledTimes(2);
    expect(appended.map((input) => input.envelope)).toStrictEqual(events);
    // append[0] happens before enqueue[0], which happens before append[1]
    // (the per-envelope append-then-enqueue order inside one transaction).
    expect(mockedAppendEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mockedEnqueueOutbox.mock.invocationCallOrder[0] as number,
    );
    expect(mockedEnqueueOutbox.mock.invocationCallOrder[0]).toBeLessThan(
      mockedAppendEvent.mock.invocationCallOrder[1] as number,
    );
    expect(enqueued.map((event) => event.envelope)).toStrictEqual(events);
  });

  it('propagates an appendEvent failure and never enqueues', async () => {
    mockedAppendEvent.mockResolvedValue({
      ok: false,
      error: {
        kind: 'domain-error',
        code: 'invariant-violation',
        message: 'ledger rejected the append',
        scope: null,
        correlationId: null,
        details: [],
      },
    });

    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(EXECUTOR_A, [captureEnvelope('one')]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invariant-violation');
    expect(mockedEnqueueOutbox).not.toHaveBeenCalled();
  });

  it('propagates an enqueueOutbox failure', async () => {
    mockedAppendEvent.mockImplementation(async (db, input) => {
      expect(db).toBe(EXECUTOR_A);
      return { ok: true, value: ledgerEventOf(input) };
    });
    mockedEnqueueOutbox.mockResolvedValue({
      ok: false,
      error: {
        kind: 'domain-error',
        code: 'invariant-violation',
        message: 'outbox rejected the row',
        scope: null,
        correlationId: null,
        details: [],
      },
    });

    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(EXECUTOR_A, [captureEnvelope('one')]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invariant-violation');
    expect(mockedAppendEvent).toHaveBeenCalledTimes(1);
  });

  it('skips the outbox when enqueueOutbox is disabled (audit-only sink)', async () => {
    mockedAppendEvent.mockImplementation(async (db, input) => {
      expect(db).toBe(EXECUTOR_A);
      return { ok: true, value: ledgerEventOf(input) };
    });

    const sink = createLedgerEventSink({ enqueueOutbox: false });
    const result = await sink.appendEvents(EXECUTOR_A, [captureEnvelope('one')]);

    expect(result.ok).toBe(true);
    expect(mockedAppendEvent).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueOutbox).not.toHaveBeenCalled();
  });

  it('rejects an envelope without an entityRefs.after reference (typed violation)', async () => {
    const sink = createLedgerEventSink();
    const rootless = fieldEventEnvelope({
      command,
      eventName: FIELD_EVENT_CAPTURED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 },
      occurredAt: NOW,
      entityRefs: { before: null, after: null },
      payload: {
        fieldEventId: FIELD_EVENT_ENTITY_ID,
        category: 'delivery-arrival',
        summary: 'Concrete pour started at level 3',
        detail: null,
        location: 'Level 3, north face',
        observedAt: NOW,
        observedBy: FIELD_EVENT_ENTITY_ID,
        quantity: null,
        evidence: [],
        status: 'open',
        version: 1,
        createdAt: NOW,
      },
    });

    const result = await sink.appendEvents(EXECUTOR_A, [rootless]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('ledger-sink-requires-after-ref');
    }
    expect(mockedAppendEvent).not.toHaveBeenCalled();
    expect(mockedEnqueueOutbox).not.toHaveBeenCalled();
  });
});
