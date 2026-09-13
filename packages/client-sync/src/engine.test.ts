import { describe, expect, it } from 'vitest';
import type { ConflictRecordId } from '@office/sync';
import type { OnlineSubmission } from './engine';
import {
  ACTOR_A,
  ACTOR_B,
  CLIENT_A,
  CLIENT_B,
  NOW_2,
  NOW_3,
  NOW_4,
  SCOPE_2,
  SCOPE_TENANT_B,
  TARGET_PROGRESS,
  consumedIds,
  createWorld,
  engineOver,
  foldState,
  progressMutation,
  unwrap,
} from './test-support';

// OFF-029 — the composed SyncEngine. THE acceptance scenario is the
// two-client offline convergence: client A drops offline and queues a
// mutation against the pre-B world while client B mutates the shared target
// online; A reconnects (catchup + replay + conflict surfacing), resolves the
// surfaced protected conflict EXPLICITLY, and both clients converge to the
// IDENTICAL state folded from their own consumed streams. Around it: the
// typed session lifecycle (state machine + the A12 session scope gate) and
// the connected twin (submitOnline — the online deterministic operation id
// and its exactly-once retry semantics).

/** The state-fold key of the contested target. */
const STATE_KEY = `${TARGET_PROGRESS.entityKind}:${TARGET_PROGRESS.entityId}`;

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

describe('the session lifecycle (typed at every step)', () => {
  it('typed-rejects every out-of-lifecycle call', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });

    // Before the session starts: everything fails typed.
    expect(a.goOffline().ok).toBe(false);
    expect(a.captureOffline(progressMutation({ percent: 40 })).ok).toBe(false);
    expect((await a.submitOnline(onlineMutation({ percent: 40 }), NOW_2)).ok).toBe(false);
    expect((await a.reconnect(NOW_2)).ok).toBe(false);
    expect(a.consumeLive().ok).toBe(false);

    unwrap(await a.subscribe());
    // While connected: offline captures and reconnects are typed-rejected.
    expect(a.captureOffline(progressMutation({ percent: 40 })).ok).toBe(false);
    expect((await a.reconnect(NOW_2)).ok).toBe(false);
    // A started session never starts twice (the broker owns resubscription).
    expect((await a.subscribe()).ok).toBe(false);

    // While disconnected: online submissions and resolutions are typed-rejected.
    unwrap(a.goOffline());
    expect((await a.submitOnline(onlineMutation({ percent: 40 }), NOW_2)).ok).toBe(false);
    expect(
      (
        await a.resolveConflict(
          {
            conflictId: 'office-scf-v1-0123456789abcdef0123456789abcdef' as ConflictRecordId,
            strategy: 'merge',
            resolvedBy: ACTOR_A,
            auditEventRefs: [],
            mutation: progressMutation({ percent: 40 }),
          },
          NOW_2,
        )
      ).ok,
    ).toBe(false);
    expect(a.consumeLive().ok).toBe(false);
    // The wired session contract is exposed verbatim.
    expect(a.clientId).toBe(CLIENT_A);
    expect(a.subscription.subscriptionId).toContain('office-sub-v1-');
  });

  it('the A12 session scope gate: captures outside the session scope are typed-rejected', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());
    unwrap(a.goOffline());

    for (const scope of [SCOPE_2, SCOPE_TENANT_B]) {
      const capture = a.captureOffline(progressMutation({ scope, percent: 40 }));
      expect(capture.ok, `${scope.tenantId}/${scope.projectId}`).toBe(false);
      if (!capture.ok) {
        expect(capture.error.code).toBe('unauthorized');
        expect(capture.error.details[0]?.code).toBe('mutation-scope-outside-session');
      }
    }
    expect(a.queue.size).toBe(0);
  });
});

describe('online submissions (the connected twin)', () => {
  it('applies once; an unconfirmed retry replays the recorded outcome (the online deterministic id)', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    unwrap(await a.subscribe());

    const first = unwrap(await a.submitOnline(onlineMutation({ percent: 40 }), NOW_2));
    expect(first.replayed).toBe(false);
    expect(world.commandPath.callCount(first.operation.operationId)).toBe(1);

    // The retry composes the SAME online deterministic operation id
    // (subscription + the client's observed cursor + the operation kind) and
    // gets the RECORDED outcome back — the inner handler never re-runs.
    const retry = unwrap(await a.submitOnline(onlineMutation({ percent: 40 }), NOW_3));
    expect(retry.replayed).toBe(true);
    expect(retry.operation.operationId).toBe(first.operation.operationId);
    expect(retry.event.eventId).toBe(first.event.eventId);
    expect(world.commandPath.calls).toHaveLength(1);

    // The engine folds its own effect exactly once (the causal-token basis
    // advanced), so a genuinely different mutation composes a FRESH id.
    unwrap(a.consumeLive());
    const second = unwrap(await a.submitOnline(onlineMutation({ percent: 55 }), NOW_4));
    expect(second.operation.operationId).not.toBe(first.operation.operationId);
    expect(second.replayed).toBe(false);
    expect(world.commandPath.calls).toHaveLength(2);
    expect(consumedIds(a.consumedEvents)).toEqual([first.event.eventId]);
  });
});

describe('THE two-client offline convergence', () => {
  it('A offline-queues while B mutates online; catchup + replay + explicit resolution converge both clients', async () => {
    const world = createWorld();
    const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
    const { engine: b } = engineOver(world, { clientId: CLIENT_B, actor: ACTOR_B, serial: 2 });
    unwrap(await a.subscribe());
    unwrap(await b.subscribe());

    // A's connection drops. B mutates the shared target ONLINE — the client
    // A has not seen (its causal token still cites the pre-B world).
    unwrap(a.goOffline());
    const online = unwrap(
      await b.submitOnline(
        onlineMutation({ actor: ACTOR_B, percent: 65, correlationId: 'corr-b1b2b3b4b5b6' }),
        NOW_2,
      ),
    );
    unwrap(b.consumeLive());

    // A captures its own protected mutation OFFLINE (base = the pre-B world).
    const queued = unwrap(a.captureOffline(progressMutation({ percent: 40 })));

    // Reconnect: catchup (B's missed window) + replay (the divergence
    // surfaces a protected conflict — parked, never auto-resolved) + the
    // conflict notification on A's own stream.
    const report = unwrap(await a.reconnect(NOW_3));
    expect(report.catchup.map((event) => event.eventId)).toEqual([online.event.eventId]);
    expect(report.drain.outcomes[0]?.status).toBe('conflicted');
    expect(world.commandPath.callCount(queued.operationId)).toBe(0);
    const conflictId: ConflictRecordId =
      report.drain.outcomes[0]?.status === 'conflicted'
        ? report.drain.outcomes[0].conflictId
        : ('impossible' as ConflictRecordId);
    expect(a.conflictsNotified.map((record) => record.conflictId)).toEqual([conflictId]);

    // The ONLY exit: the explicit resolution. A reconciles (a merged 80%)
    // citing B's ledger event as audit evidence; the reconciled mutation
    // re-enters the queue discipline and applies exactly once.
    const resolution = unwrap(
      await a.resolveConflict(
        {
          conflictId,
          strategy: 'merge',
          resolvedBy: ACTOR_A,
          auditEventRefs: [online.event.eventId],
          mutation: progressMutation({ percent: 80, correlationId: 'corr-9f8e7d6c5b4a' }),
        },
        NOW_4,
      ),
    );
    expect(resolution.outcome?.status).toBe('applied');
    expect(world.commandPath.callCount(resolution.entry?.operationId as string)).toBe(1);
    expect(world.commandPath.calls).toHaveLength(2);

    // B consumes A's reconciled effect live (and saw the conflict surface).
    unwrap(b.consumeLive());
    expect(b.conflictsNotified.map((record) => record.conflictId)).toEqual([conflictId]);

    // CONVERGENCE: both clients' folded entity state is IDENTICAL — and
    // identical to the world's actual ledger state.
    const aState = foldState(a.consumedEvents);
    const bState = foldState(b.consumedEvents);
    expect(bState).toEqual(aState);
    expect(aState).toEqual(foldState(world.source.events));
    expect(aState).toEqual({ [STATE_KEY]: { percent: 80 } });

    // No duplicates, no losses: each client consumed exactly the world's
    // events, once each, in the same causal order.
    expect(consumedIds(b.consumedEvents)).toEqual(consumedIds(a.consumedEvents));
    expect(new Set(consumedIds(a.consumedEvents))).toEqual(
      new Set(world.source.events.map((event) => event.eventId)),
    );
    expect(a.consumedEvents).toHaveLength(2);
    expect(b.consumedEvents).toHaveLength(2);
    expect(a.consumedPosition).toBe(2);
    expect(b.consumedPosition).toBe(2);

    // The journal names every applied operation (B's online + A's reconciled).
    expect(world.journal.size).toBe(2);
    expect(world.journal.eventOf(queued.operationId)).toBeNull();
  });
});
