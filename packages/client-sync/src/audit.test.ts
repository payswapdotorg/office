import { describe, expect, it } from 'vitest';
import { parseDomainEventEnvelope } from '@office/contracts';
import type { DomainEventEnvelope } from '@office/contracts';
import type { ConflictRecordId } from '@office/sync';
import {
  CONFLICT_AUTO_RESOLVED_EVENT,
  CONFLICT_RESOLVED_EVENT,
  CONFLICT_SURFACED_EVENT,
  MUTATION_REJECTED_EVENT,
  MUTATION_REPLAYED_EVENT,
  createInMemorySyncEventSink,
  failAfterSyncEventSink,
} from './audit';
import type { OnlineSubmission } from './engine';
import {
  ACTOR_ADMIN,
  ACTOR_A,
  ACTOR_B,
  CLIENT_A,
  CLIENT_B,
  NOW_2,
  NOW_3,
  NOW_4,
  SCOPE_1,
  TARGET_PROGRESS,
  createSwitchableSink,
  createWorld,
  engineOver,
  progressMutation,
  unwrap,
} from './test-support';
import type { SyncWorld } from './test-support';

// OFF-029 — the audit discipline (freeze A3): every consequential
// queue-drain transition emits an immutable DomainEventEnvelope through the
// EventSink port — appendEvents(executor, events) inside the CALLER'S
// transaction — with the audit-only entity convention (the event ADDRESSES
// the target without changing it: before === after), canonical causality,
// and payloads carrying the operation/conflict identities. A sink failure
// ABORTS the whole drain typed (a partially-audited replay never silently
// passes); the resume completes the entry's audit exactly once overall.

/** The online-submission twin of the progress-mutation fixture. */
const onlineMutation = (parts: Parameters<typeof progressMutation>[0] = {}): OnlineSubmission => {
  const capture = progressMutation(parts);
  return {
    commandName: capture.commandName,
    scope: capture.scope,
    actor: capture.actor,
    correlationId: capture.correlationId,
    payload: capture.payload,
    target: capture.target,
    operationKind: capture.operationKind,
    requiredCapability: capture.requiredCapability,
  };
};

/** Every recorded envelope of one event name, in emission order. */
const eventsOf = (world: SyncWorld, name: string): DomainEventEnvelope[] =>
  world.sink.events.filter((envelope) => envelope.eventName === name);

/** The recorded envelope payload as a plain record. */
const payloadOf = (envelope: DomainEventEnvelope): Record<string, unknown> =>
  envelope.payload as Record<string, unknown>;

describe('the audit discipline (freeze A3: every drain transition is audited)', () => {
  it('a clean queue drain emits one sync.mutationReplayed envelope per applied mutation, through the EventSink port', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    const entry = unwrap(a.captureOffline(progressMutation({ percent: 40 })));
    unwrap(await a.reconnect(NOW_3));

    const replayed = eventsOf(world, MUTATION_REPLAYED_EVENT);
    expect(replayed).toHaveLength(1);
    const envelope = replayed[0]!;
    // The envelope is a structurally valid DomainEventEnvelope (the
    // canonical fail-closed parser accepts it — it can never be invalid).
    expect(parseDomainEventEnvelope(envelope).ok).toBe(true);
    // Audit-only: the event ADDRESSES the target without changing it.
    expect(envelope.entityRefs.before).toEqual(TARGET_PROGRESS);
    expect(envelope.entityRefs.after).toEqual(TARGET_PROGRESS);
    // Caused by the applied effect event; scope, actor, and the injected
    // instant carried verbatim.
    const appliedEventId = world.source.events[0]?.eventId;
    expect(envelope.causality.causationId).toBe(appliedEventId);
    expect(envelope.causality.correlationId).toBe(entry.command.causality.correlationId);
    expect(envelope.scope).toEqual(SCOPE_1);
    expect(envelope.actor).toEqual(ACTOR_A);
    expect(envelope.occurredAt).toBe(NOW_3);
    // The payload carries the replay identity verbatim.
    const payload = payloadOf(envelope);
    expect(payload['operationId']).toBe(entry.operationId);
    expect(payload['localSequence']).toBe(1);
    expect(payload['eventId']).toBe(appliedEventId);
    expect(payload['protection']).toBe('protected');
    expect(payload['replayed']).toBe(false);
    // THE port shape: appendEvents(executor, events) — the caller's
    // transaction executor travels with every append.
    expect(world.sink.appends).toHaveLength(1);
    expect(world.sink.appends[0]?.executor).toBe(world.executor);
    expect(world.sink.appends[0]?.events).toHaveLength(1);
  });

  it('a typed server rejection is audited as sync.mutationRejected (surfaced, never lost)', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    const entry = unwrap(a.captureOffline(progressMutation({ percent: 40 })));
    world.commandPath.rejectNext('the domain rejected the progress step');

    const report = unwrap(await a.reconnect(NOW_3));

    expect(report.drain.outcomes[0]?.status).toBe('rejected');
    const rejected = eventsOf(world, MUTATION_REJECTED_EVENT);
    expect(rejected).toHaveLength(1);
    const payload = payloadOf(rejected[0]!);
    // Caused by the rejected command itself (its idempotency key — the A3
    // command-caused convention), rejection surfaced verbatim.
    expect(rejected[0]!.causality.causationId).toBe(entry.operationId);
    expect(payload['operationId']).toBe(entry.operationId);
    expect(payload['localSequence']).toBe(1);
    expect(payload['protection']).toBe('protected');
    expect(payload['rejectionCode']).toBe('invariant-violation');
    expect(payload['rejectionMessage']).toBe('the domain rejected the progress step');
    // The rejected entry stays pending (retryable) — nothing was applied.
    expect(a.queue.pending).toHaveLength(1);
    expect(eventsOf(world, MUTATION_REPLAYED_EVENT)).toHaveLength(0);
  });

  it('a protected divergence is audited as sync.conflictSurfaced with both versions and the diverging event', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    const { engine: b } = engineOver(world, { clientId: CLIENT_B, actor: ACTOR_B, serial: 2 });
    unwrap(await a.subscribe());
    unwrap(await b.subscribe());
    unwrap(a.goOffline());
    const entry = unwrap(a.captureOffline(progressMutation({ percent: 40 })));
    const online = unwrap(
      await b.submitOnline(
        onlineMutation({ actor: ACTOR_B, percent: 65, correlationId: 'corr-b1b2b3b4b5b6' }),
        NOW_2,
      ),
    );
    unwrap(b.consumeLive());

    const report = unwrap(await a.reconnect(NOW_3));

    const surfaced = eventsOf(world, CONFLICT_SURFACED_EVENT);
    expect(surfaced).toHaveLength(1);
    const envelope = surfaced[0]!;
    const payload = payloadOf(envelope);
    const conflictId: ConflictRecordId =
      report.drain.outcomes[0]?.status === 'conflicted'
        ? report.drain.outcomes[0].conflictId
        : ('impossible' as ConflictRecordId);
    // Caused by the diverging event; the system actor surfaced it.
    expect(envelope.causality.causationId).toBe(online.event.eventId);
    expect(envelope.actor).toEqual({ kind: 'system' });
    expect(envelope.entityRefs.before).toEqual(TARGET_PROGRESS);
    expect(envelope.entityRefs.after).toEqual(TARGET_PROGRESS);
    // The payload carries the full divergence evidence.
    expect(payload['operationId']).toBe(entry.operationId);
    expect(payload['localSequence']).toBe(1);
    expect(payload['conflictId']).toBe(conflictId);
    expect(payload['protection']).toBe('protected');
    expect(payload['basePosition']).toBe(0);
    expect(payload['baseVersion']).toBe(0);
    expect(payload['actualVersion']).toBe(1);
    expect(payload['divergingEventId']).toBe(online.event.eventId);
  });

  it('an open-state supersession is audited as sync.conflictAutoResolved (never silent)', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    const { engine: b } = engineOver(world, { clientId: CLIENT_B, actor: ACTOR_B, serial: 2 });
    unwrap(await a.subscribe());
    unwrap(await b.subscribe());
    unwrap(a.goOffline());
    const entry = unwrap(a.captureOffline(progressMutation({ percent: 40, protection: 'open' })));
    const online = unwrap(
      await b.submitOnline(
        onlineMutation({ actor: ACTOR_B, percent: 65, correlationId: 'corr-b1b2b3b4b5b6' }),
        NOW_2,
      ),
    );
    unwrap(b.consumeLive());

    const report = unwrap(await a.reconnect(NOW_3));

    expect(report.drain.outcomes[0]?.status).toBe('superseded');
    const autoResolved = eventsOf(world, CONFLICT_AUTO_RESOLVED_EVENT);
    expect(autoResolved).toHaveLength(1);
    const payload = payloadOf(autoResolved[0]!);
    // The committed server side is named; the superseded offline operation too.
    expect(payload['supersededOperationId']).toBe(entry.operationId);
    expect(payload['committedOperationId']).toBe(online.operation.operationId);
    expect(['first-operation-wins', 'second-operation-wins']).toContain(payload['strategy']);
    expect(payload['divergingEventId']).toBe(online.event.eventId);
    expect(autoResolved[0]!.causality.causationId).toBe(online.event.eventId);
    // The system actor performed the deterministic supersession.
    expect(autoResolved[0]!.actor).toEqual({ kind: 'system' });
  });

  it('an explicit conflict resolution is audited as sync.conflictResolved, caused by the re-entered operation', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    const { engine: b } = engineOver(world, { clientId: CLIENT_B, actor: ACTOR_B, serial: 2 });
    unwrap(await a.subscribe());
    unwrap(await b.subscribe());
    unwrap(a.goOffline());
    unwrap(a.captureOffline(progressMutation({ percent: 40 })));
    const online = unwrap(
      await b.submitOnline(
        onlineMutation({ actor: ACTOR_B, percent: 65, correlationId: 'corr-b1b2b3b4b5b6' }),
        NOW_2,
      ),
    );
    unwrap(b.consumeLive());
    const report = unwrap(await a.reconnect(NOW_3));
    const conflictId: ConflictRecordId =
      report.drain.outcomes[0]?.status === 'conflicted'
        ? report.drain.outcomes[0].conflictId
        : ('impossible' as ConflictRecordId);

    const resolution = unwrap(
      await a.resolveConflict(
        {
          conflictId,
          strategy: 'merge',
          resolvedBy: ACTOR_ADMIN,
          auditEventRefs: [online.event.eventId],
          mutation: progressMutation({ percent: 80 }),
        },
        NOW_4,
      ),
    );

    const resolved = eventsOf(world, CONFLICT_RESOLVED_EVENT);
    expect(resolved).toHaveLength(1);
    const envelope = resolved[0]!;
    const payload = payloadOf(envelope);
    // Caused by the resolution command itself (the operation id under which
    // the reconciled mutation re-entered the queue); the resolving actor
    // signed it; the cited evidence travels in the payload.
    expect(payload['conflictId']).toBe(conflictId);
    expect(payload['strategy']).toBe('merge');
    expect(payload['resolutionOperationId']).toBe(resolution.entry?.operationId);
    expect(payload['auditEventRefs']).toEqual([online.event.eventId]);
    expect(envelope.causality.causationId).toBe(resolution.entry?.operationId);
    expect(envelope.actor).toEqual(ACTOR_ADMIN);
    // And the re-entered mutation's own replay audit followed it.
    const replayed = eventsOf(world, MUTATION_REPLAYED_EVENT);
    expect(replayed).toHaveLength(1);
    expect(payloadOf(replayed[0]!)['operationId']).toBe(resolution.entry?.operationId);
  });

  it('a sink failure aborts the whole drain typed; the resume audits the entry exactly once overall', async () => {
    const base = createWorld();
    const sink = createSwitchableSink();
    const world: SyncWorld = { ...base, sink };
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    const entry = unwrap(a.captureOffline(progressMutation({ percent: 40 })));

    // The sink fails the entry's audit append: the drain aborts typed — a
    // partially-audited replay never silently passes.
    sink.use(failAfterSyncEventSink(0, 'the audit transaction is down'));
    const interrupted = await a.reconnect(NOW_3);
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) {
      expect(interrupted.error.code).toBe('invariant-violation');
      expect(interrupted.error.message).toContain('sync audit event sink');
    }
    expect(sink.events).toHaveLength(0);
    expect(a.queue.pending).toHaveLength(1);

    // The resume (sink restored): the entry completes — audit + terminal
    // mark — with the inner handler having run EXACTLY ONCE overall.
    sink.use(createInMemorySyncEventSink());
    unwrap(a.goOffline());
    const resumed = unwrap(await a.reconnect(NOW_4));
    expect(resumed.drain.outcomes[0]?.status).toBe('applied');
    expect(resumed.drain.outcomes[0]).toMatchObject({ replayed: true });
    expect(world.commandPath.callCount(entry.operationId)).toBe(1);
    const replayed = sink.events.filter(
      (envelope) => envelope.eventName === MUTATION_REPLAYED_EVENT,
    );
    expect(replayed).toHaveLength(1);
    expect(payloadOf(replayed[0]!)['operationId']).toBe(entry.operationId);
    expect(payloadOf(replayed[0]!)['replayed']).toBe(true);
  });
});
