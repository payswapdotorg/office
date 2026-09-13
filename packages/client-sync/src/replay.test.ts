import { describe, expect, it } from 'vitest';
import type { SubscriptionId, SubscriptionGrantId } from '@office/sync';
import {
  MUTATION_REPLAYED_EVENT,
  createInMemorySyncEventSink,
  failAfterSyncEventSink,
} from './audit';
import { clientOperationOf, createLocalQueue } from './queue';
import type { LocalQueue, QueueEntry } from './queue';
import { drainLocalQueue } from './replay';
import type { DrainDeps } from './replay';
import {
  ACTOR_ADMIN,
  ACTOR_A,
  CLIENT_A,
  NOW_2,
  NOW_3,
  NOW_4,
  SCOPE_1,
  TARGET_NOTE,
  consumedIds,
  createSwitchableSink,
  createWorld,
  denyWritesPolicy,
  engineOver,
  issueWriterGrant,
  progressMutation,
  unwrap,
  withSession,
} from './test-support';
import type { SyncWorld } from './test-support';

// OFF-029 — the exactly-once replay protocol: on reconnection the bounded
// LocalQueue drains through the typed command path in deterministic
// local-sequence order and EVERY queued mutation applies EXACTLY ONCE —
// counting inner handler invocations (the test world's counting command path
// is the oracle), across first presentations AND interrupted-drain resumes
// (the at-least-once world: an audit-sink failure aborts the drain mid-way;
// the true crash gap leaves an operation registered with its effect landed
// but never journaled). Authorization (A12) holds on replay: a grant revoked
// while the client was offline, or a deny-writes policy, typed-denies the
// drain BEFORE any effect — and a typed server rejection surfaces per-entry,
// never lost, the entry staying pending and retryable.

/** The raw-drain session's fixed subscription id (any canonical id works). */
const RAW_SUBSCRIPTION_ID =
  'office-sub-v1-0123456789abcdef0123456789abcdef' as SubscriptionId;

/** Build the raw-drain session: a queue + the full DrainDeps over one world. */
const rawSession = (
  world: SyncWorld,
  serial = 91,
): { readonly queue: LocalQueue; readonly deps: DrainDeps; readonly grantId: SubscriptionGrantId } => {
  const grant = unwrap(issueWriterGrant(world.broker, CLIENT_A, ACTOR_A, serial));
  const queue = createLocalQueue({ clientId: CLIENT_A });
  const deps: DrainDeps = {
    clientId: CLIENT_A,
    subscriptionId: RAW_SUBSCRIPTION_ID,
    grantId: grant.grantId,
    scope: SCOPE_1,
    queue,
    registry: world.registry,
    slice: world.source,
    commandPath: world.commandPath,
    policy: world.policy,
    audit: { sink: world.sink, executor: world.executor },
    journal: world.journal,
    conflicts: world.conflicts,
    broker: world.broker,
  };
  return { queue, deps, grantId: grant.grantId };
};

/** The applied-state view of a queue entry (fail-loud lookup). */
const appliedStateOf = (queue: LocalQueue, entry: QueueEntry) => {
  const stored = queue.entryOf(entry.operationId);
  expect(stored).not.toBeNull();
  return stored?.state;
};

describe('the exactly-once replay (N queued mutations → reconnect → applied once each)', () => {
  it('applies every queued mutation exactly once, in deterministic local-sequence order', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    const first = unwrap(a.captureOffline(progressMutation({ percent: 40 })));
    const second = unwrap(a.captureOffline(progressMutation({ percent: 55 })));
    const third = unwrap(a.captureOffline(progressMutation({ percent: 70 })));

    const report = unwrap(await a.reconnect(NOW_3));

    // THE named acceptance: each of the N queued mutations applied EXACTLY
    // ONCE — the inner handler ran once per deterministic operation id and
    // nothing else ran at all.
    expect(world.commandPath.calls).toHaveLength(3);
    for (const entry of [first, second, third]) {
      expect(world.commandPath.callCount(entry.operationId), entry.operationId).toBe(1);
    }
    expect(report.drain.outcomes.map((outcome) => outcome.status)).toEqual([
      'applied',
      'applied',
      'applied',
    ]);
    expect(report.drain.outcomes.map((outcome) => outcome.localSequence)).toEqual([1, 2, 3]);
    expect(report.drain.remaining).toBe(0);
    expect(a.queue.pending).toHaveLength(0);
    for (const entry of [first, second, third]) {
      expect(appliedStateOf(a.queue, entry)).toMatchObject({ status: 'applied', replayed: false });
    }
    // Every applied operation is journaled exactly once (protocol + effect).
    expect(world.journal.size).toBe(3);
    // No duplicates, no losses: the client consumed exactly the world's events.
    expect(consumedIds(a.consumedEvents)).toEqual(
      world.source.events.map((event) => event.eventId),
    );
    expect(a.consumedEvents).toHaveLength(3);
    expect(a.consumedPosition).toBe(3);
  });

  it('drains a raw queue through the typed command path (A8: the envelope key IS the operation id)', async () => {
    const world = createWorld();
    const { queue, deps } = rawSession(world);
    const first = unwrap(
      queue.capture(withSession(progressMutation({ percent: 40 }), { subscriptionId: RAW_SUBSCRIPTION_ID })),
    );
    // A second capture against the SAME causal token, on an independent
    // target: consecutive offline captures never diverge each other.
    const second = unwrap(
      queue.capture(
        withSession(progressMutation({ percent: 55, target: TARGET_NOTE }), {
          subscriptionId: RAW_SUBSCRIPTION_ID,
        }),
      ),
    );
    expect(first.command.idempotencyKey).toBe(first.operationId);
    expect(second.command.idempotencyKey).toBe(second.operationId);

    const report = unwrap(await drainLocalQueue(deps, { now: NOW_3 }));

    expect(report.outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'applied']);
    expect(report.remaining).toBe(0);
    expect(world.commandPath.callCount(first.operationId)).toBe(1);
    expect(world.commandPath.callCount(second.operationId)).toBe(1);
    expect(report.appliedEvents.map((event) => event.eventId)).toEqual(
      world.source.events.map((event) => event.eventId),
    );
    expect(world.journal.size).toBe(2);
    expect(appliedStateOf(queue, first)).toMatchObject({ status: 'applied' });
    expect(appliedStateOf(queue, second)).toMatchObject({ status: 'applied' });
  });

  it('re-presents a rejected entry on a later drain (rejections surface, never silently retry, never lose)', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    const entry = unwrap(a.captureOffline(progressMutation({ percent: 40 })));

    // The server rejects the first presentation with a typed error.
    world.commandPath.rejectNext('the domain rejected the progress step');
    const rejected = unwrap(await a.reconnect(NOW_3));
    expect(rejected.drain.outcomes[0]?.status).toBe('rejected');
    expect(a.queue.pending).toHaveLength(1);
    expect(world.commandPath.callCount(entry.operationId)).toBe(0);

    // The entry stays pending and retryable: a later drain re-presents it —
    // through the SAME deterministic operation id (protocol dedup) — and it
    // applies exactly once overall.
    unwrap(a.goOffline());
    const retried = unwrap(await a.reconnect(NOW_4));
    expect(retried.drain.outcomes[0]?.status).toBe('applied');
    expect(world.commandPath.callCount(entry.operationId)).toBe(1);
    expect(world.commandPath.calls).toHaveLength(1);
    expect(a.queue.pending).toHaveLength(0);
    expect(world.source.events).toHaveLength(1);
  });
});

describe('interrupted drains (the at-least-once world, resumed exactly-once)', () => {
  it('an audit-sink failure mid-drain aborts typed; the resume completes without duplicates or losses', async () => {
    const base = createWorld();
    const sink = createSwitchableSink();
    const world: SyncWorld = { ...base, sink };
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    const first = unwrap(a.captureOffline(progressMutation({ percent: 40 })));
    const second = unwrap(a.captureOffline(progressMutation({ percent: 55 })));
    const third = unwrap(a.captureOffline(progressMutation({ percent: 70 })));

    // Interrupt the drain after two audited applies: the third entry's audit
    // append fails, so the whole drain aborts typed (a partially-audited
    // replay never silently passes) — after its effect already landed.
    sink.use(failAfterSyncEventSink(2, 'the audit transaction is down'));
    const interrupted = await a.reconnect(NOW_3);
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) {
      expect(interrupted.error.code).toBe('invariant-violation');
      expect(interrupted.error.message).toContain('sync audit event sink');
    }
    // Two entries completed; the third is still pending — its effect event
    // IS in the slice and the journal, only the audit + mark were lost.
    expect(appliedStateOf(a.queue, first)).toMatchObject({ status: 'applied' });
    expect(appliedStateOf(a.queue, second)).toMatchObject({ status: 'applied' });
    expect(a.queue.pending).toHaveLength(1);
    expect(world.commandPath.calls).toHaveLength(3);
    expect(world.source.events).toHaveLength(3);

    // The resume: drain again (reconnect after a clean goOffline, the audit
    // sink restored to a recording one). The third entry sees the protocol
    // duplicate + its journaled prior outcome, and finishes with audit +
    // terminal mark — the inner handler NEVER re-runs.
    sink.use(createInMemorySyncEventSink());
    unwrap(a.goOffline());
    const resumed = unwrap(await a.reconnect(NOW_4));
    expect(resumed.drain.outcomes).toHaveLength(1);
    expect(resumed.drain.outcomes[0]?.status).toBe('applied');
    expect(resumed.drain.outcomes[0]).toMatchObject({ replayed: true });
    expect(world.commandPath.callCount(third.operationId)).toBe(1);
    expect(a.queue.pending).toHaveLength(0);

    // EXACTLY ONCE overall: one inner-handler run per operation id.
    expect(world.commandPath.calls).toHaveLength(3);
    for (const entry of [first, second, third]) {
      expect(world.commandPath.callCount(entry.operationId), entry.operationId).toBe(1);
    }
    // No duplicate effects (the slice holds exactly three events) and no
    // losses: the client consumed every world event exactly once.
    expect(world.source.events).toHaveLength(3);
    expect(consumedIds(a.consumedEvents)).toEqual(
      world.source.events.map((event) => event.eventId),
    );
    // The audit discipline held across the interruption: exactly one
    // sync.mutationReplayed envelope per operation id, overall.
    const replayedAudits = sink.events.filter(
      (envelope) => envelope.eventName === MUTATION_REPLAYED_EVENT,
    );
    expect(replayedAudits.map((envelope) => envelope.payload).map((payload) => (payload as Record<string, unknown>)['operationId'])).toEqual(
      [first.operationId, second.operationId, third.operationId],
    );
  });

  it('the crash gap (registered + effect landed, never journaled) resumes through the idempotent command path', async () => {
    const world = createWorld();
    const { queue, deps } = rawSession(world);
    const entry = unwrap(
      queue.capture(withSession(progressMutation({ percent: 40 }), { subscriptionId: RAW_SUBSCRIPTION_ID })),
    );

    // The interrupted first presentation: the operation was REGISTERED and
    // its effect event landed in the slice (and was published), but the
    // journal write never happened — the entry's fate is undecided.
    unwrap(await world.registry.register(clientOperationOf(entry)));
    const executed = unwrap(
      await world.commandPath.execute(entry.command, { now: NOW_2, target: entry.target }),
    );
    unwrap(await world.broker.publish(executed.event));
    expect(world.commandPath.callCount(entry.operationId)).toBe(1);
    expect(world.journal.eventOf(entry.operationId)).toBeNull();

    const report = unwrap(await drainLocalQueue(deps, { now: NOW_3 }));

    // The resume fell THROUGH to the structural divergence check (no resume
    // path may bypass it), recognized its own effect event in the slice, and
    // the idempotent command path returned the RECORDED outcome — the inner
    // handler never re-ran, and exactly one effect event exists.
    expect(world.commandPath.callCount(entry.operationId)).toBe(1);
    expect(report.outcomes[0]?.status).toBe('applied');
    expect(report.outcomes[0]).toMatchObject({
      replayed: true,
      eventId: executed.event.eventId,
    });
    expect(appliedStateOf(queue, entry)).toEqual({
      status: 'applied',
      eventId: executed.event.eventId,
      replayed: true,
    });
    expect(world.journal.eventOf(entry.operationId)?.eventId).toBe(executed.event.eventId);
    expect(world.source.events).toHaveLength(1);
    expect(report.appliedEvents).toHaveLength(1);
  });
});

describe('authorization on replay (A12 holds offline)', () => {
  it('a grant revoked while the client was offline typed-denies the replay before any effect', async () => {
    const world = createWorld();
    const { engine: a, grant } = engineOver(world, {
      clientId: CLIENT_A,
      actor: ACTOR_A,
      serial: 1,
    });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    unwrap(a.captureOffline(progressMutation({ percent: 40 })));
    unwrap(world.broker.revoke(grant.grantId, { revokedBy: ACTOR_ADMIN, now: NOW_3 }));

    const replay = await a.reconnect(NOW_4);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe('forbidden');
      expect(replay.error.details[0]?.code).toBe('grant-revoked');
    }
    expect(world.commandPath.calls).toHaveLength(0);
    expect(a.queue.pending).toHaveLength(1);
  });

  it('a deny-writes policy typed-denies the queued mutation before any effect (the entry stays retryable)', async () => {
    const world = createWorld(denyWritesPolicy());
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());
    unwrap(a.captureOffline(progressMutation({ percent: 40 })));

    const replay = await a.reconnect(NOW_3);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe('forbidden');
    }
    expect(world.commandPath.calls).toHaveLength(0);
    expect(a.queue.pending).toHaveLength(1);
    expect(world.source.events).toHaveLength(0);
  });
});
