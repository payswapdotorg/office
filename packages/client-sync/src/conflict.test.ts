import { describe, expect, it } from 'vitest';
import type { ConflictRecord } from '@office/sync';
import { CONFLICT_AUTO_RESOLVED_EVENT, CONFLICT_RESOLVED_EVENT } from './audit';
import type { OnlineSubmission, OnlineSubmissionOutcome, SyncEngine } from './engine';
import type { QueueEntry } from './queue';
import {
  ACTOR_A,
  ACTOR_ADMIN,
  ACTOR_B,
  CLIENT_A,
  CLIENT_B,
  NOW_2,
  NOW_3,
  NOW_4,
  SCOPE_1,
  TARGET_PROGRESS,
  createWorld,
  engineOver,
  foldState,
  progressMutation,
  unwrap,
} from './test-support';
import type { SyncWorld } from './test-support';

// OFF-029 — the protected-conflict rule (THE named acceptance): a captured
// mutation whose base has diverged on PROTECTED state is surfaced as an
// explicit @office/sync ConflictRecord (both sides, deterministic side
// order) and PARKED — the replay engine has NO path that applies it
// (structurally: the entry goes terminal 'conflicted', so no drain — first
// presentation, resume, or reconnect — can ever present it to the command
// path again). The ONLY way forward is the typed EXPLICIT resolution
// command, whose reconciled mutation re-enters the queue discipline and
// applies exactly once. OPEN-state divergences supersede deterministically:
// the committed server side stands, recorded and audited — never silent.

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

interface DivergedScenario {
  readonly world: SyncWorld;
  readonly a: SyncEngine;
  readonly b: SyncEngine;
  readonly queued: QueueEntry;
  readonly online: OnlineSubmissionOutcome;
  readonly conflict: ConflictRecord;
}

/**
 * Run the divergence scenario up to the surfaced conflict: A goes offline and
 * captures `protection`-class state against the pre-B world; B mutates the
 * SAME target online; A reconnects (catchup + drain + conflict surfacing).
 */
const diverge = async (protection: 'protected' | 'open'): Promise<DivergedScenario> => {
  const world = createWorld();
  const { engine: a } = engineOver(world, { clientId: CLIENT_A, actor: ACTOR_A, serial: 1 });
  const { engine: b } = engineOver(world, { clientId: CLIENT_B, actor: ACTOR_B, serial: 2 });
  unwrap(await a.subscribe());
  unwrap(await b.subscribe());
  unwrap(a.goOffline());
  const queued = unwrap(a.captureOffline(progressMutation({ percent: 40, protection })));
  const online = unwrap(
    await b.submitOnline(
      onlineMutation({ actor: ACTOR_B, percent: 65, correlationId: 'corr-b1b2b3b4b5b6' }),
      NOW_2,
    ),
  );
  unwrap(b.consumeLive());
  const report = unwrap(await a.reconnect(NOW_3));
  const outcome = report.drain.outcomes[0]!;
  expect(outcome.status).toBe(protection === 'protected' ? 'conflicted' : 'superseded');
  const conflictId: ConflictRecord['conflictId'] =
    outcome.status === 'conflicted' || outcome.status === 'superseded'
      ? outcome.conflictId
      : ('impossible' as ConflictRecord['conflictId']);
  const conflict = world.conflicts.conflictOf(conflictId);
  expect(conflict).not.toBeNull();
  // B folds the conflict notification too (its stream is live).
  unwrap(b.consumeLive());
  return { world, a, b, queued, online, conflict: conflict as ConflictRecord };
};

describe('protected divergence (THE named acceptance)', () => {
  it('surfaces an explicit ConflictRecord (both sides, deterministic order) and parks the entry', async () => {
    const { world, a, b, queued, online, conflict } = await diverge('protected');

    // THE explicit record: both sides, deterministic side order (operation
    // id ascending), detected — NOT resolved.
    expect(conflict.state).toBe('detected');
    expect(conflict.resolution).toBeNull();
    expect(conflict.target).toEqual(TARGET_PROGRESS);
    expect(conflict.tenantId).toBe(SCOPE_1.tenantId);
    expect(conflict.projectId).toBe(SCOPE_1.projectId);
    expect(new Set([conflict.first.operationId, conflict.second.operationId])).toEqual(
      new Set([queued.operationId, online.operation.operationId]),
    );
    expect(conflict.first.operationId < conflict.second.operationId).toBe(true);

    // The queue entry is parked TERMINALLY: 'conflicted', out of pending.
    expect(a.queue.entryOf(queued.operationId)?.state).toEqual({
      status: 'conflicted',
      conflictId: conflict.conflictId,
    });
    expect(a.queue.pending).toHaveLength(0);

    // NO auto-resolution: nothing was applied for the queued mutation — no
    // command execution, no journal record, no effect event.
    expect(world.commandPath.callCount(queued.operationId)).toBe(0);
    expect(world.journal.eventOf(queued.operationId)).toBeNull();
    expect(world.source.events.map((event) => event.eventId)).toEqual([online.event.eventId]);

    // The conflict was surfaced to the offline client's own stream (and to
    // the other live client of the same slice).
    expect(a.conflictsNotified.map((record) => record.conflictId)).toEqual([
      conflict.conflictId,
    ]);
    expect(b.conflictsNotified.map((record) => record.conflictId)).toEqual([
      conflict.conflictId,
    ]);

    // A consumed B's mutation in the reconnect catchup — exactly once.
    expect(a.consumedEvents.map((event) => event.eventId)).toEqual([online.event.eventId]);
  });

  it('has NO auto-resolution path: no later drain can ever present the parked entry again', async () => {
    const { world, a, queued } = await diverge('protected');

    // STRUCTURAL: the parked entry is terminal 'conflicted' — pending is
    // empty, so the drain loop (which iterates pending only) can never
    // re-present it. Prove it: reconnect AGAIN and drain — nothing happens.
    unwrap(a.goOffline());
    const again = unwrap(await a.reconnect(NOW_4));
    expect(again.drain.outcomes).toEqual([]);
    expect(again.drain.remaining).toBe(0);
    expect(again.drain.conflictsSurfaced).toEqual([]);

    // Still nothing applied for the parked mutation, after every drain.
    expect(world.commandPath.callCount(queued.operationId)).toBe(0);
    expect(world.source.events).toHaveLength(1);
    expect(a.queue.entryOf(queued.operationId)?.state.status).toBe('conflicted');
  });

  it('the explicit resolution command re-enters the queue and applies exactly once', async () => {
    const { world, a, queued, online, conflict } = await diverge('protected');
    const resolution = unwrap(
      await a.resolveConflict(
        {
          conflictId: conflict.conflictId,
          strategy: 'second-operation-wins',
          resolvedBy: ACTOR_ADMIN,
          auditEventRefs: [online.event.eventId],
          mutation: progressMutation({ percent: 80, note: 'reconciled after review' }),
        },
        NOW_4,
      ),
    );

    // The reconciled mutation RE-ENTERED the queue discipline: a fresh
    // deterministic operation id (not the parked one) and the CURRENT causal
    // token — then applied EXACTLY ONCE through the typed command path.
    expect(resolution.entry).not.toBeNull();
    expect(resolution.entry?.operationId).not.toBe(queued.operationId);
    expect(resolution.entry?.basePosition).toBe(1);
    expect(resolution.outcome?.status).toBe('applied');
    expect(world.commandPath.callCount(resolution.entry?.operationId as string)).toBe(1);
    expect(world.commandPath.calls).toHaveLength(2);

    // The record is resolved: explicit strategy, resolving actor, evidence.
    const stored = world.conflicts.conflictOf(conflict.conflictId);
    expect(stored?.state).toBe('resolved');
    expect(stored?.resolution?.strategy).toBe('second-operation-wins');
    expect(stored?.resolution?.resolvedBy).toEqual(ACTOR_ADMIN);
    expect(stored?.resolution?.auditEventRefs).toEqual([online.event.eventId]);

    // The reconciled effect landed AFTER the standing server side; the
    // offline client's own view converged onto the reconciled state.
    const appliedEventId =
      resolution.outcome?.status === 'applied' ? resolution.outcome.eventId : 'impossible';
    expect(world.source.events.map((event) => event.eventId)).toEqual([
      online.event.eventId,
      appliedEventId,
    ]);
    expect(foldState(a.consumedEvents)).toEqual({
      [STATE_KEY]: { percent: 80, note: 'reconciled after review' },
    });
    // The explicit resolution is audited (freeze A3).
    expect(
      world.sink.events.some((envelope) => envelope.eventName === CONFLICT_RESOLVED_EVENT),
    ).toBe(true);
  });

  it('an identical re-resolution is the idempotent no-op: nothing re-enters, nothing applies twice', async () => {
    const { world, a, online, conflict } = await diverge('protected');
    const command = {
      conflictId: conflict.conflictId,
      strategy: 'merge' as const,
      resolvedBy: ACTOR_ADMIN,
      auditEventRefs: [online.event.eventId],
      mutation: progressMutation({ percent: 80 }),
    };
    const first = unwrap(await a.resolveConflict(command, NOW_4));
    expect(first.entry).not.toBeNull();
    expect(world.commandPath.calls).toHaveLength(2);

    // The IDENTICAL resolution again (same strategy, actor, evidence, and
    // resolved-at instant): the stored record comes back, NOTHING re-enters
    // the queue, and nothing applies a second time.
    const again = unwrap(await a.resolveConflict(command, NOW_4));
    expect(again.entry).toBeNull();
    expect(again.outcome).toBeNull();
    expect(again.conflict.state).toBe('resolved');
    expect(world.commandPath.calls).toHaveLength(2);
    expect(world.source.events).toHaveLength(2);

    // A DIFFERENT resolution is a typed invariant-violation.
    const conflicting = await a.resolveConflict(
      { ...command, strategy: 'first-operation-wins' as const },
      NOW_4,
    );
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.details[0]?.code).toBe('conflict-already-resolved');
    }
  });
});

describe('open-state divergence (deterministic supersession, never silent)', () => {
  it('the committed server side stands; the supersession is recorded as a resolved conflict and audited', async () => {
    const { world, a, b, queued, online, conflict } = await diverge('open');

    // The entry landed 'superseded' and the conflict record carries the
    // deterministic supersession (system actor, strategy naming the standing
    // side in the record's canonical order, the diverging event as evidence).
    expect(a.queue.entryOf(queued.operationId)?.state).toMatchObject({
      status: 'superseded',
      conflictId: conflict.conflictId,
    });
    expect(conflict.state).toBe('resolved');
    expect(conflict.resolution?.resolvedBy).toEqual({ kind: 'system' });
    expect(['first-operation-wins', 'second-operation-wins']).toContain(
      conflict.resolution?.strategy,
    );

    // The COMMITTED server side stands: no effect for the superseded
    // mutation, no revert of B's mutation — the engine never reverts
    // committed ledger state.
    expect(world.commandPath.callCount(queued.operationId)).toBe(0);
    expect(world.source.events.map((event) => event.eventId)).toEqual([online.event.eventId]);

    // The supersession is never silent: the audit trail records it.
    expect(
      world.sink.events.some((envelope) => envelope.eventName === CONFLICT_AUTO_RESOLVED_EVENT),
    ).toBe(true);

    // Both clients' views hold the standing server state.
    expect(foldState(a.consumedEvents)).toEqual({ [STATE_KEY]: { percent: 65 } });
    expect(foldState(b.consumedEvents)).toEqual({ [STATE_KEY]: { percent: 65 } });
  });
});
