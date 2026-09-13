// Office field/offline web client — the reconnect + synchronize surface (OFF-031).
//
// THE synchronization surface: the reconnect flow drives @office/client-sync's
// engine.reconnect — catchup (resume from the client's LAST CONFIRMED cursor,
// exactly once, no duplicates, no gaps) + the queue's EXACTLY-ONCE drain
// (authorize → register → divergence check → clean-apply or the explicit
// conflict path — conflict surfacing included) + the consumption of the
// client's own replayed effects. The engine's ReconnectReport becomes the
// displayable SYNC REPORT VIEW (applied/rejected/conflicted/superseded
// counts, per-entry outcomes, the catchup window, the remaining pending
// count) and the client's cursor/token state is displayable at every step
// (the consumed position IS the causal-token basis of the next capture).
//
// This module is a pure projection over the engine's typed reports: no I/O,
// no clock reads (the `now` of the reconnect is injected), no state of its
// own — every field comes from the engine's own deterministic records.
// Typed Results throughout: a session-state violation (synchronizing a
// connected session, say) is a typed rejection view, never a throw.
import type { DomainError, Result } from '@office/domain-kernel';
import { domainError } from '@office/domain-kernel';
import type { Timestamp } from '@office/contracts';
import type { LedgerEvent } from '@office/events';
import type { ReconnectReport } from '@office/client-sync';
import type { DrainEntryOutcome } from '@office/client-sync';
import type { FieldDataPlane } from '../session/stream';
import type { FieldSession } from '../session/session';
import { sessionCoversScope } from '../session/session';

/** The displayable view of one consumed ledger event (the stream's shape). */
export interface ConsumedEventView {
  readonly eventId: string;
  readonly eventName: string;
}

/** The displayable view of one cleanly applied queue entry. */
export interface AppliedEntryView {
  readonly operationId: string;
  readonly localSequence: number;
  readonly eventId: string;
  readonly eventName: string;
  /** True when the outcome was replayed (idempotent), not first-applied. */
  readonly replayed: boolean;
}

/** The displayable view of one typed server rejection (surfaced, retryable). */
export interface RejectedEntryView {
  readonly operationId: string;
  readonly localSequence: number;
  readonly code: string;
  readonly message: string;
}

/** The displayable view of one surfaced (parked) protected conflict. */
export interface ConflictedEntryView {
  readonly operationId: string;
  readonly localSequence: number;
  readonly conflictId: string;
  readonly protection: 'protected';
}

/** The displayable view of one deterministic open-state supersession. */
export interface SupersededEntryView {
  readonly operationId: string;
  readonly localSequence: number;
  readonly conflictId: string;
}

/** THE sync report view (the engine's reconnect report, displayable). */
export interface SyncReportView {
  readonly kind: 'sync-report-view';
  /** The missed window consumed by the reconnect catchup (exactly once). */
  readonly catchup: readonly ConsumedEventView[];
  readonly catchupCount: number;
  /** The entries the drain applied cleanly (in drain order). */
  readonly applied: readonly AppliedEntryView[];
  /** The entries the server typed-rejected (surfaced, never lost, retryable). */
  readonly rejected: readonly RejectedEntryView[];
  /** The protected divergences surfaced as explicit conflicts (parked). */
  readonly conflicted: readonly ConflictedEntryView[];
  /** The open divergences deterministically superseded (committed side stands). */
  readonly superseded: readonly SupersededEntryView[];
  /** The per-outcome counts (the report's summary row). */
  readonly counts: {
    readonly catchup: number;
    readonly applied: number;
    readonly rejected: number;
    readonly conflicted: number;
    readonly superseded: number;
  };
  /** The entries still pending after the synchronize (rejections stay retryable). */
  readonly remainingPending: number;
  /** The client's own replayed effects consumed live after the drain. */
  readonly replayedOwnEffects: readonly ConsumedEventView[];
  /** The cursor/token state AFTER the synchronize (the next capture's basis). */
  readonly consumedPosition: number;
}

/**
 * The typed rejection of a synchronize attempt (displayable): A12 (the
 * session does not cover the world the plane is wired over) or the engine's
 * own typed session-state/protocol failures, carried verbatim.
 */
export type SynchronizeRejection =
  | { readonly code: 'session-scope-uncovered'; readonly received: string }
  | { readonly code: 'sync-rejected'; readonly message: string };

/** Project one ledger event into its displayable view (pure). */
const consumedEventViewOf = (event: LedgerEvent): ConsumedEventView => ({
  eventId: event.eventId,
  eventName: event.envelope.eventName,
});

/**
 * Project the drain's per-entry outcomes into the report's per-outcome view
 * lists (pure). Each applied entry's event name is resolved through the
 * session's OWN consumed stream (the engine folds its replayed effects
 * before the report returns, so every applied effect the client keeps is
 * in the lookup — the applied view never invents a name).
 */
const outcomeViewsOf = (
  outcomes: readonly DrainEntryOutcome[],
  eventNameById: ReadonlyMap<string, string>,
) => {
  const applied: AppliedEntryView[] = [];
  const rejected: RejectedEntryView[] = [];
  const conflicted: ConflictedEntryView[] = [];
  const superseded: SupersededEntryView[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'applied') {
      applied.push({
        operationId: outcome.operationId,
        localSequence: outcome.localSequence,
        eventId: outcome.eventId,
        eventName: eventNameById.get(outcome.eventId) ?? '',
        replayed: outcome.replayed,
      });
    } else if (outcome.status === 'rejected') {
      rejected.push({
        operationId: outcome.operationId,
        localSequence: outcome.localSequence,
        code: outcome.error.code,
        message: outcome.error.message,
      });
    } else if (outcome.status === 'conflicted') {
      conflicted.push({
        operationId: outcome.operationId,
        localSequence: outcome.localSequence,
        conflictId: outcome.conflictId,
        protection: 'protected',
      });
    } else {
      superseded.push({
        operationId: outcome.operationId,
        localSequence: outcome.localSequence,
        conflictId: outcome.conflictId,
      });
    }
  }
  return { applied, rejected, conflicted, superseded };
};

/**
 * Project the engine's reconnect report into THE displayable sync report
 * view (pure): the catchup window, every per-entry outcome (applied /
 * rejected / conflicted / superseded with their counts), the remaining
 * pending count, the client's own replayed effects, and the post-sync
 * cursor/token state. `consumed` is the session's own consumed stream after
 * the reconnect (the applied effects' event-name lookup) and
 * `consumedPosition` its final cursor.
 */
export const syncReportViewOf = (
  report: ReconnectReport,
  consumed: readonly LedgerEvent[],
  consumedPosition: number,
): SyncReportView => {
  const eventNameById = new Map<string, string>(
    consumed.map((event) => [event.eventId, event.envelope.eventName]),
  );
  const { applied, rejected, conflicted, superseded } = outcomeViewsOf(
    report.drain.outcomes,
    eventNameById,
  );
  return {
    kind: 'sync-report-view',
    catchup: report.catchup.map(consumedEventViewOf),
    catchupCount: report.catchup.length,
    applied,
    rejected,
    conflicted,
    superseded,
    counts: {
      catchup: report.catchup.length,
      applied: applied.length,
      rejected: rejected.length,
      conflicted: conflicted.length,
      superseded: superseded.length,
    },
    remainingPending: report.drain.remaining,
    replayedOwnEffects: report.replayed.map(consumedEventViewOf),
    consumedPosition,
  };
};

/**
 * THE synchronize: drive the reconnect flow (catchup + the exactly-once
 * queue drain + conflict surfacing) and return the displayable sync report
 * view. The engine's typed failures surface as typed rejection views (a
 * synchronize of a session that is still connected, for example) — never a
 * throw. A12: a session that does not cover the world the plane is wired
 * over is a typed unauthorized rejection before any effect.
 */
export async function synchronize(
  plane: FieldDataPlane,
  session: FieldSession,
  now: Timestamp,
): Promise<Result<SyncReportView, SynchronizeRejection>> {
  if (!sessionCoversScope(session, plane.worldScope)) {
    return {
      ok: false,
      error: {
        code: 'session-scope-uncovered',
        received: `tenant ${session.tenantId} project ${session.projectId}`,
      },
    };
  }
  const reconnected = await plane.reconnect(now);
  if (!reconnected.ok) {
    return {
      ok: false,
      error: { code: 'sync-rejected', message: reconnected.error.message },
    };
  }
  return {
    ok: true,
    value: syncReportViewOf(
      reconnected.value,
      plane.engine.consumedEvents,
      plane.engine.consumedPosition,
    ),
  };
}

/** The session's sync status view (the cursor/token state, displayable). */
export interface SyncStatusView {
  readonly kind: 'sync-status-view';
  /** Is the session currently connected (between goOffline and reconnect)? */
  readonly connected: boolean;
  /** The client's LAST CONFIRMED slice position — the causal-token basis. */
  readonly consumedPosition: number;
  /** The number of events the session has consumed (its own view's length). */
  readonly consumedEventCount: number;
  /** The bounded offline queue's entry count (all states). */
  readonly queueSize: number;
  /** The entries still pending replay (the queue is empty at zero). */
  readonly pendingCount: number;
  /** The queue's bounded capacity (freeze A9). */
  readonly capacity: number;
  /** The conflict records delivered to this session's stream, in order. */
  readonly conflictsNotifiedCount: number;
}

/**
 * Project the session's sync status (the cursor/token state displayable at
 * every step): the connection state, the last confirmed position (THE
 * causal token every capture is composed against), the queue's pending/
 * entry counts, and the notified conflict count. A12: a session that does
 * not cover the world the plane is wired over is a typed unauthorized
 * rejection.
 */
export function syncStatusView(
  plane: FieldDataPlane,
  session: FieldSession,
): Result<SyncStatusView, DomainError> {
  if (!sessionCoversScope(session, plane.worldScope)) {
    return {
      ok: false,
      error: domainError(
        'unauthorized',
        `the session's scope does not cover this world's project state (session project ${session.projectId})`,
        [
          {
            code: 'session-scope-uncovered',
            message: `tenant ${session.tenantId} project ${session.projectId}`,
            path: null,
          },
        ],
        { scope: session.scope, correlationId: null },
      ),
    };
  }
  const engine = plane.engine;
  return {
    ok: true,
    value: {
      kind: 'sync-status-view',
      connected: engine.connected,
      consumedPosition: engine.consumedPosition,
      consumedEventCount: engine.consumedEvents.length,
      queueSize: engine.queue.size,
      pendingCount: engine.queue.pending.length,
      capacity: engine.queue.capacity,
      conflictsNotifiedCount: engine.conflictsNotified.length,
    },
  };
}

/**
 * Disconnect the session (the engine's goOffline): the session stops
 * consuming its stream and captures accumulate in the bounded LocalQueue.
 * Typed Results — a disconnect of a session that is not connected is a
 * typed rejection view, never a throw.
 */
export function disconnect(
  plane: FieldDataPlane,
  session: FieldSession,
): Result<true, SynchronizeRejection> {
  if (!sessionCoversScope(session, plane.worldScope)) {
    return {
      ok: false,
      error: {
        code: 'session-scope-uncovered',
        received: `tenant ${session.tenantId} project ${session.projectId}`,
      },
    };
  }
  const offline = plane.engine.goOffline();
  if (!offline.ok) {
    return { ok: false, error: { code: 'sync-rejected', message: offline.error.message } };
  }
  return { ok: true, value: true };
}
