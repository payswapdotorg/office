// Office schedule domain — the thin ledger-backed EventSink adapter (OFF-010).
//
// Unlike the OFF-007 identity modules, @office/events IS in this item's
// dependency graph, so this package ships a REAL EventSink implementation
// next to the in-memory test sink: one that appends every audit event to the
// OFF-005 event ledger AND enqueues the transactional-outbox record, per
// envelope, inside the CALLER'S transaction (the executor handed to
// appendEvents — the same transaction the schedule store write runs in, so
// state + ledger + outbox commit atomically or not at all).
//
// This adapter is deliberately THIN: it owns no SQL of its own (the ledger
// and outbox modules compose their statements), no migrations, and no state.
// It derives each event's ledger aggregate stream from the schedule-domain
// payload convention (every schedule event payload carries the owning
// scheduleId — see events.ts) and fails closed with a typed
// invariant-violation when handed an envelope that does not.
//
// Wiring: use this sink with a SQL-backed ScheduleStore implementation whose
// transactions are real persistence transactions (SqlExecutors). The
// in-memory store's transactions refuse SQL by design — the aggregates,
// commands, and tests of this package stay pure domain.
import { isEntityId } from '@office/contracts';
import type { DomainEventEnvelope, EntityId } from '@office/contracts';
import { appendEvent, enqueueOutbox } from '@office/events';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { EventSink } from './events';
import { SCHEDULE_KIND } from './state';

/**
 * Derive the ledger aggregate stream of one schedule event: the schedule
 * root owning the mutation (every schedule event payload carries its
 * scheduleId — the package's own payload contract). Fail-closed: an
 * envelope whose payload does not carry a canonical schedule id is a wiring
 * error, rejected typed rather than silently mis-streamed.
 */
const aggregateOf = (
  envelope: DomainEventEnvelope,
): Result<EntityId, DomainError> => {
  const payload = envelope.payload as { readonly scheduleId?: unknown };
  const scheduleId = payload?.scheduleId;
  if (typeof scheduleId !== 'string' || !isEntityId(scheduleId)) {
    return fail(
      invariantViolation(
        {
          name: 'schedule-event-payload-carries-schedule-id',
          statement: `the payload of event '${envelope.eventName}' does not carry the owning scheduleId required to derive its ledger aggregate stream`,
        },
        { scope: envelope.scope, correlationId: envelope.causality.correlationId },
      ),
    );
  }
  return ok(scheduleId);
};

/**
 * Create the ledger-backed EventSink: appends each event to the OFF-005
 * event ledger and enqueues its outbox record, BOTH inside the caller's
 * transaction (the executor passed to appendEvents — the SAME transaction
 * the schedule state write belongs to). Any failure result rolls the whole
 * mutation back (handlers honor the port contract), so state, ledger and
 * outbox stay atomic.
 */
export function createLedgerEventSink(): EventSink {
  return {
    appendEvents: async (
      executor: SqlExecutor,
      events: readonly DomainEventEnvelope[],
    ): Promise<Result<true, DomainError>> => {
      for (const envelope of events) {
        const aggregate = aggregateOf(envelope);
        if (!aggregate.ok) return aggregate;
        const appended = await appendEvent(executor, {
          envelope,
          aggregate: { entityKind: SCHEDULE_KIND, entityId: aggregate.value },
        });
        if (!appended.ok) return appended;
        const enqueued = await enqueueOutbox(executor, appended.value);
        if (!enqueued.ok) {
          return fail(
            domainError(
              'invariant-violation',
              `event sink rejected the append: the outbox rejected ledger event ${appended.value.eventId}: ${enqueued.error.message}`,
              enqueued.error.details,
              {
                scope: enqueued.error.scope,
                correlationId: enqueued.error.correlationId,
              },
            ),
          );
        }
      }
      return ok(true);
    },
  };
}
