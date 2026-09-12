import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, CommandName, ParseResult, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import { createInMemoryIdempotencyRegistry } from '@office/domain-kernel';
import type { IdempotencyRegistry } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import {
  ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
  CAPTURE_FIELD_EVENT_COMMAND,
  RAISE_ISSUE_COMMAND,
  RESOLVE_FIELD_EVENT_COMMAND,
  createFieldCommands,
} from './commands';
import type { FieldCommandAuthorization, FieldCommands, FieldCommandDeps } from './commands';
import { createInMemoryEventSink, failingEventSink } from './events';
import type { EventSink, InMemoryEventSink } from './events';
import { createInMemoryFieldStore } from './store';
import type { IssueState } from './state';

// OFF-009 field domain — THE offline-style capture gate (freeze A9/A8): a
// field crew captures observations while disconnected, each command stamped
// with a CLIENT-generated idempotency key and a CLIENT-observed timestamp;
// after reconnection the same commands replay. Exactly-once semantics through
// the domain-kernel IdempotencyRegistry:
//
//   * same (scope, key) + same command fingerprint → the ORIGINAL outcome is
//     returned with replayed: true — no second aggregate, no second event,
//     no second canonical id, no fresh server clock read;
//   * same key + different payload → typed idempotency-conflict;
//   * a FAILED execution is never recorded, so a transient failure (e.g. an
//     event-sink outage) stays retryable with the SAME key;
//   * the registry is keyed by (scope, key): another scope's capture under
//     the same key is a different command.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const expectOk = async <T>(
  promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> => {
  const result = await promise;
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_1 = unwrap(parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
const PROJECT_2 = unwrap(parseProjectId('office-prj-v1-2b3c4d5e6f708192a3b4c5d6e7f8a9b'));

const USER = 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1';
const PARTY = 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2';

// The client clock runs BEHIND the server clock: the offline crew observed
// this at 09:00 while disconnected; the server first sees the command later.
const CLIENT_OBSERVED_AT = '2026-09-12T09:00:00.000Z';
const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);
const unwrapTimestamp = (offsetSeconds: number): Timestamp =>
  unwrap(parseTimestamp(new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString()));
const SERVER_FIRST_NOW: Timestamp = unwrapTimestamp(0);
const SERVER_SECOND_NOW: Timestamp = unwrapTimestamp(3600);

const FAKE_EXECUTOR: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };

const grant: FieldCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['work.write'], actions: ['write'] }]),
  capabilities: ['work.write'],
};

const envelope = (
  payload: unknown,
  commandName: CommandName,
  options: {
    scope?: Scope;
    key?: string;
    issuedAt?: string;
  } = {},
): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: options.scope ?? { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 },
      actor: { kind: 'user', actorId: USER },
      idempotencyKey: options.key ?? 'idem-should-not-happen',
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: options.issuedAt ?? '2026-09-12T09:00:01.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

const capturePayload = () => ({
  category: 'delivery-arrival',
  summary: 'Concrete pour started at level 3',
  location: 'Level 3, north face',
  observedAt: CLIENT_OBSERVED_AT,
  observedBy: PARTY,
});

const raisePayload = () => ({
  title: 'Cracked formwork on column C-12',
  category: 'structural-defect',
  severity: 'high',
  reportedAt: CLIENT_OBSERVED_AT,
  reportedBy: PARTY,
});

interface Harness {
  readonly commands: FieldCommands;
  readonly store: ReturnType<typeof createInMemoryFieldStore>;
  readonly sink: InMemoryEventSink;
  readonly registryStats: { lookups: number; records: number };
  readonly ids: { issued: number };
  readonly clock: { read: () => Timestamp };
}

/**
 * The deterministic offline harness: a store/sink/registry triple shared by
 * one or more command services (the sink is swappable — the "reconnection"
 * scenario), a two-value injected clock (server time at capture, later at
 * replay), and counting suppliers proving replay consumes nothing.
 */
const makeHarness = (): Harness & { commandsWith: (sink: EventSink) => FieldCommands } => {
  const store = createInMemoryFieldStore();
  const inner = createInMemoryIdempotencyRegistry();
  const registryStats = { lookups: 0, records: 0 };
  const idempotencyRegistry: IdempotencyRegistry = {
    lookup: (scope, key, fingerprint, context) => {
      registryStats.lookups += 1;
      return inner.lookup(scope, key, fingerprint, context);
    },
    record: (scope, key, fingerprint, outcome, context) => {
      registryStats.records += 1;
      return inner.record(scope, key, fingerprint, outcome, context);
    },
  };
  const ids = { issued: 0 };
  let tick = 0;
  const now = (): Timestamp => unwrapTimestamp(tick++ * 3600);
  const depsBase = {
    store,
    idempotencyRegistry,
    now,
    newOpaqueId: () => {
      ids.issued += 1;
      return String(ids.issued).padStart(16, '0');
    },
    executor: FAKE_EXECUTOR,
  };
  const sink = createInMemoryEventSink();
  const commandsWith = (eventSink: EventSink): FieldCommands =>
    createFieldCommands({ ...depsBase, eventSink } satisfies FieldCommandDeps);
  return {
    commands: commandsWith(sink),
    commandsWith,
    store,
    sink,
    registryStats,
    ids,
    clock: { read: now },
  };
};

// ----- THE gate: capture once, replay exactly once -------------------------------

describe('offline-style capture and replay (exactly-once)', () => {
  it('replaying the same capture command after reconnection duplicates nothing', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-capture-1';

    // Disconnected capture (the command was formed while offline: client key,
    // client-observed timestamp, client-issued timestamp).
    const first = await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
        grant,
      ),
    );
    expect(first.replayed).toBe(false);
    expect(first.state.version).toBe(1);
    expect(first.state.observedAt).toBe(unwrap(parseTimestamp(CLIENT_OBSERVED_AT)));
    expect(first.state.createdAt).toBe(SERVER_FIRST_NOW);
    const capturedId = first.state.entityId;

    expect(harness.store.fieldEvents()).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.ids.issued).toBe(1);

    // Reconnection: the client retries the SAME command (same key, same
    // payload, fresh issuedAt — honest retry metadata is not command
    // identity). The registry replays the recorded outcome.
    const replay = await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, {
          key,
          issuedAt: '2026-09-12T18:40:05.000Z',
        }),
        grant,
      ),
    );
    expect(replay.replayed).toBe(true);
    // The ORIGINAL outcome is returned — the first server timestamp, not the
    // later clock the second execution would have read.
    expect(replay.state).toStrictEqual(first.state);
    expect(replay.state.createdAt).toBe(SERVER_FIRST_NOW);
    expect(replay.state.entityId).toBe(capturedId);

    // Exactly-once effects: no duplicate aggregate, no duplicate event, no
    // second canonical id consumed, no second registry recording.
    expect(harness.store.fieldEvents()).toHaveLength(1);
    expect(harness.store.fieldEvents()[0]?.entityId).toBe(capturedId);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.ids.issued).toBe(1);
    expect(harness.registryStats.lookups).toBe(2);
    expect(harness.registryStats.records).toBe(1);
  });

  it('a different payload under the same key is a typed idempotency-conflict', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-capture-2';
    await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
        grant,
      ),
    );

    const conflicting = await harness.commands.fieldEvents.captureFieldEvent(
      envelope(
        { ...capturePayload(), summary: 'Concrete pour started at level 4' },
        CAPTURE_FIELD_EVENT_COMMAND,
        { key },
      ),
      grant,
    );
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.code).toBe('idempotency-conflict');
      expect(conflicting.error.details[0]?.code).toBe('idempotency-key-reuse');
    }
    // No duplicate effects from the conflicting attempt.
    expect(harness.store.fieldEvents()).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(1);
  });

  it('raiseIssue replays exactly-once as well (the second offline capture)', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-issue-1';
    const first = await expectOk(
      harness.commands.issues.raiseIssue(envelope(raisePayload(), RAISE_ISSUE_COMMAND, { key }), grant),
    );
    expect(first.replayed).toBe(false);
    const issueId = first.state.entityId;

    const replay = await expectOk(
      harness.commands.issues.raiseIssue(envelope(raisePayload(), RAISE_ISSUE_COMMAND, { key }), grant),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.state.entityId).toBe(issueId);
    expect(replay.state.createdAt).toBe(SERVER_FIRST_NOW);

    expect(harness.store.issues()).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.ids.issued).toBe(1);

    const conflicting = await harness.commands.issues.raiseIssue(
      envelope({ ...raisePayload(), severity: 'critical' }, RAISE_ISSUE_COMMAND, { key }),
      grant,
    );
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.error.code).toBe('idempotency-conflict');
    expect(harness.store.issues()).toHaveLength(1);
  });

  it('replays a MUTATION command exactly-once (resolve) and conflicts on a changed note', async () => {
    const harness = makeHarness();
    const captured = (await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key: 'idem-offline-capture-3' }),
        grant,
      ),
    )).state;

    const key = 'idem-offline-resolve-1';
    const first = await expectOk(
      harness.commands.fieldEvents.resolveFieldEvent(
        envelope(
          { fieldEventId: captured.entityId, expectedVersion: 1, resolutionNote: 'accepted' },
          RESOLVE_FIELD_EVENT_COMMAND,
          { key },
        ),
        grant,
      ),
    );
    expect(first.replayed).toBe(false);
    expect(first.state.version).toBe(2);
    expect(first.state.status).toBe('resolved');

    const replay = await expectOk(
      harness.commands.fieldEvents.resolveFieldEvent(
        envelope(
          { fieldEventId: captured.entityId, expectedVersion: 1, resolutionNote: 'accepted' },
          RESOLVE_FIELD_EVENT_COMMAND,
          { key },
        ),
        grant,
      ),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.state).toStrictEqual(first.state);

    // Exactly one resolved event was ever emitted.
    expect(harness.sink.events.filter((event) => event.eventName === 'field.fieldEventResolved')).toHaveLength(1);
    expect(harness.store.fieldEvents()[0]?.version).toBe(2);

    const conflicting = await harness.commands.fieldEvents.resolveFieldEvent(
      envelope(
        { fieldEventId: captured.entityId, expectedVersion: 1, resolutionNote: 'changed my mind' },
        RESOLVE_FIELD_EVENT_COMMAND,
        { key },
      ),
      grant,
    );
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.error.code).toBe('idempotency-conflict');
  });

  it('replays the ORIGINAL captured outcome even after the aggregate mutated further', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-capture-4';
    const first = await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
        grant,
      ),
    );

    // The aggregate moved on (evidence attached → version 2).
    await expectOk(
      harness.commands.fieldEvents.attachFieldEventEvidence(
        envelope(
          {
            fieldEventId: first.state.entityId,
            expectedVersion: 1,
            evidence: [{ entityKind: 'document', entityId: PARTY, revisionId: USER }],
          },
          ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
        ),
        grant,
      ),
    );
    expect(harness.store.fieldEvents()[0]?.version).toBe(2);

    // The replay of the ORIGINAL capture still returns the recorded v1
    // outcome — the registry replays history, it never re-reads the store.
    const replay = await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
        grant,
      ),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.state.version).toBe(1);
    expect(replay.state.evidence).toHaveLength(0);
    // ...while the store still holds the mutated aggregate.
    expect(harness.store.fieldEvents()[0]?.version).toBe(2);
  });

  it('a failed execution is never recorded: the same key retries after recovery', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-capture-5';

    // The event sink is down (e.g. the ledger write failed): the mutation
    // aborts — no state, no event, no idempotency recording.
    const failing = harness.commandsWith(failingEventSink('ledger unavailable'));
    const failed = await failing.fieldEvents.captureFieldEvent(
      envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
      grant,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invariant-violation');
      expect(failed.error.details[0]?.code).toBe('event-sink-rejected');
    }
    expect(harness.store.fieldEvents()).toHaveLength(0);
    expect(harness.registryStats.records).toBe(0);

    // Recovery: the client retries the SAME command with the SAME key —
    // the transient failure stayed retryable, so it now executes (with the
    // NEXT server clock tick; the failed attempt consumed nothing but time).
    const recovered = await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
        grant,
      ),
    );
    expect(recovered.replayed).toBe(false);
    expect(recovered.state.createdAt).toBe(SERVER_SECOND_NOW);
    expect(harness.store.fieldEvents()).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.registryStats.records).toBe(1);
  });

  it('keys are scoped: the same key under another project is a different command', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-capture-6';
    const first = await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
        grant,
      ),
    );
    expect(first.replayed).toBe(false);

    const otherScope = await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, {
          key,
          scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_2 },
        }),
        grant,
      ),
    );
    expect(otherScope.replayed).toBe(false);
    expect(otherScope.state.entityId).not.toBe(first.state.entityId);
    expect(harness.store.fieldEvents()).toHaveLength(2);
    expect(harness.sink.events).toHaveLength(2);
    expect(harness.registryStats.records).toBe(2);
  });

  it('the replayed outcome is the exact recorded state object (original outcome identity)', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-issue-2';
    const first = await expectOk(
      harness.commands.issues.raiseIssue(envelope(raisePayload(), RAISE_ISSUE_COMMAND, { key }), grant),
    );
    const replay = await expectOk(
      harness.commands.issues.raiseIssue(envelope(raisePayload(), RAISE_ISSUE_COMMAND, { key }), grant),
    );
    expect(replay.state).toBe(first.state as IssueState);
  });

  it('a denied replay still denies (authorization precedes idempotency)', async () => {
    const harness = makeHarness();
    const key = 'idem-offline-capture-7';
    await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
        grant,
      ),
    );

    // The retry arrives WITHOUT the capability this time: deny-by-default
    // authorization runs BEFORE the registry — the denial is not a replay.
    const denied = await harness.commands.fieldEvents.captureFieldEvent(
      envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { key }),
      {
        policy: definePolicy([{ effect: 'allow', capabilities: ['work.write'], actions: ['write'] }]),
        capabilities: [],
      },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('forbidden');
      expect(denied.error.details[0]?.code).toBe('no-allow-rule');
    }
    // The registry was never consulted for the denied retry.
    expect(harness.registryStats.lookups).toBe(1);
  });
});
