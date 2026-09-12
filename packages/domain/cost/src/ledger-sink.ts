// Office cost domain — the thin ledger-backed EventSink adapter (OFF-011).
//
// Unlike the OFF-007 identity modules, @office/events IS in this item's
// dependency graph, so this package ships a REAL EventSink implementation
// next to the in-memory test sink: one that appends every audit event to the
// OFF-005 event ledger AND enqueues the transactional-outbox record, per
// envelope, inside the CALLER'S transaction (the executor handed to
// appendEvents — the same transaction the cost store write runs in, so
// state + ledger + outbox commit atomically or not at all).
//
// This adapter is deliberately THIN: it owns no SQL of its own (the ledger
// and outbox modules compose their statements), no migrations, and no state.
// It derives each event's ledger aggregate stream from the cost-domain
// payload convention (budget events carry the owning budgetId, commitment
// events the commitmentId, invoice events the invoiceId — see events.ts) and
// fails closed with a typed invariant-violation when handed an envelope that
// does not.
//
// Wiring: use this sink with a SQL-backed CostStore implementation whose
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
import { BUDGET_KIND, COMMITMENT_KIND, INVOICE_KIND } from './state';

/**
 * Derive the ledger aggregate stream of one cost event: the aggregate ROOT
 * owning the mutation. Every cost event payload carries exactly one owning
 * root id — budget events the budgetId, commitment events the commitmentId,
 * invoice events the invoiceId (the package's own payload convention). Some
 * payloads ADDITIONALLY reference a sibling root (a commitment-created event
 * names the budget it was created against; an invoice event names the
 * commitment it is billed against), so the resolution order is owning-root
 * first: invoiceId, then commitmentId, then budgetId — never the other way
 * around, or commitment/invoice events would mis-stream under their
 * referenced sibling. Fail-closed: an envelope whose payload carries no
 * recognizable owning root id is a wiring error, rejected typed rather than
 * silently mis-streamed.
 */
const aggregateOf = (
  envelope: DomainEventEnvelope,
): Result<{ readonly entityKind: typeof BUDGET_KIND | typeof COMMITMENT_KIND | typeof INVOICE_KIND; readonly entityId: EntityId }, DomainError> => {
  const payload = envelope.payload as {
    readonly budgetId?: unknown;
    readonly commitmentId?: unknown;
    readonly invoiceId?: unknown;
  };
  const invoiceId = payload?.invoiceId;
  if (typeof invoiceId === 'string' && isEntityId(invoiceId)) {
    return ok({ entityKind: INVOICE_KIND, entityId: invoiceId });
  }
  const commitmentId = payload?.commitmentId;
  if (typeof commitmentId === 'string' && isEntityId(commitmentId)) {
    return ok({ entityKind: COMMITMENT_KIND, entityId: commitmentId });
  }
  const budgetId = payload?.budgetId;
  if (typeof budgetId === 'string' && isEntityId(budgetId)) {
    return ok({ entityKind: BUDGET_KIND, entityId: budgetId });
  }
  return fail(
    invariantViolation(
      {
        name: 'cost-event-payload-carries-owning-root-id',
        statement: `the payload of event '${envelope.eventName}' carries neither a budgetId, a commitmentId, nor an invoiceId — the owning aggregate root cannot be derived for its ledger stream`,
      },
      { scope: envelope.scope, correlationId: envelope.causality.correlationId },
    ),
  );
};

/**
 * Create the ledger-backed EventSink: appends each event to the OFF-005
 * event ledger and enqueues its outbox record, BOTH inside the caller's
 * transaction (the executor passed to appendEvents — the SAME transaction
 * the cost state write belongs to). Any failure result rolls the whole
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
          aggregate: { entityKind: aggregate.value.entityKind, entityId: aggregate.value.entityId },
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
