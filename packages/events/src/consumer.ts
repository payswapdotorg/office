// Office events — idempotent consumer cursor (OFF-005, freeze A3).
//
// At-least-once delivery is a frozen assumption; consumers must be
// idempotent. consumeIdempotently() is the API that makes them so: it runs
// the consumer's projection writes AND the durable cursor advance inside
// ONE TransactionRunner transaction, keyed by (tenant, consumer name) and
// tracking the last consumed ledger sequence PER AGGREGATE — dense by the
// ledger's counter/append invariant, which is what the skip decision relies
// on:
//
//   * re-delivered event (sequence <= cursor)  → skipped, handler never runs
//     (duplicate delivery is harmless — no effect, no cursor change);
//   * next event (sequence == cursor + 1)      → handler runs, cursor and
//     handler writes commit atomically (or both vanish);
//   * gap (sequence > cursor + 1)              → typed invariant-violation
//     (a delivery-layer fault: silently skipping the missing events would
//     starve projections forever — fail closed instead);
//   * a consumer's FIRST delivery establishes its position at any sequence
//     (a cursor that does not exist yet is an unstarted consumer, not a gap).
//
// Race safety with NO advisory locks: the cursor row is claimed with
// INSERT ... ON CONFLICT DO NOTHING (a conflicting uncommitted insert makes
// the second transaction WAIT until the first resolves — commit → the
// second sees the advanced cursor and skips; rollback → the second claims),
// and the existing-row path serializes on SELECT ... FOR UPDATE. Concurrent
// duplicate delivery therefore processes exactly once, proven by test.
//
// The delivered event is position-verified against the ledger itself before
// anything runs (the outbox join already guarantees this on the dispatch
// path; direct-delivery consumers get the same fail-closed guarantee).
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { domainError, fail, invariantViolation, ok, tenantScopeViolation } from '@office/domain-kernel';
import type { SqlExecutor, Transaction, TransactionRunner } from '@office/persistence';
import type { LedgerEvent } from './ledger';
import type { ConsumerName, LedgerSequence } from './identity';
import { readConsumerName, readEntityRef, readLedgerSequence, readTimestamp, toDate } from './rows';

/**
 * The durable position of one consumer for one aggregate stream: the last
 * ledger sequence this consumer has processed (its handler's writes for
 * every event up to that position are committed).
 */
export interface ConsumerCursor {
  readonly consumerName: ConsumerName;
  readonly aggregate: EntityRef;
  readonly lastSequence: LedgerSequence;
  readonly updatedAt: Timestamp;
}

/**
 * Outcome of one idempotent consumption: the handler ran and its writes
 * committed with the cursor advance ('processed'), or the delivery was a
 * duplicate/stale event and nothing happened ('skipped-duplicate').
 */
export type ConsumptionOutcome<T> =
  | { readonly status: 'processed'; readonly effect: T }
  | { readonly status: 'skipped-duplicate'; readonly lastSequence: LedgerSequence };

/**
 * Input of consumeIdempotently. The handler receives the open transaction
 * and returns a typed Result: a failure rolls the whole consumption back
 * (handler writes AND cursor) and is returned to the caller — redelivery
 * reprocesses, at-least-once semantics preserved.
 */
export interface ConsumeIdempotentlyInput<T> {
  /** The tenant whose stream is being consumed (the cursor's tenant key). */
  readonly tenantId: TenantId;
  /** The consuming projection/worker's stable identity, e.g. 'projections.projects'. */
  readonly consumerName: ConsumerName;
  /** The delivered event to consume (position-verified against the ledger). */
  readonly event: LedgerEvent;
  /** The consumption instant (injected clock) recorded on cursor advancement. */
  readonly now: Timestamp;
  /** The consumer's transactional effect (projection writes inside `tx`). */
  readonly handle: (tx: Transaction) => Promise<Result<T, DomainError>>;
}

const CURSORS_TABLE = 'consumer_cursors';
const LEDGER_TABLE = 'event_ledger';

const tenantScope = (tenantId: TenantId) => ({ kind: 'tenant', tenantId }) as const;

/** Decode a cursor row (fail-closed). */
const mapCursorRow = (row: Record<string, unknown>): ConsumerCursor => ({
  consumerName: readConsumerName(row, CURSORS_TABLE),
  aggregate: readEntityRef(row, CURSORS_TABLE, 'aggregate_kind', 'aggregate_id'),
  lastSequence: readLedgerSequence(row, CURSORS_TABLE, 'last_sequence'),
  updatedAt: readTimestamp(row, CURSORS_TABLE, 'updated_at'),
});

/**
 * Consume one delivered event idempotently: duplicate delivery is a no-op;
 * the handler's writes and the cursor advance commit atomically or not at
 * all. See the module comment for the full classification (skip / process /
 * gap) and the race-safety scheme.
 */
export async function consumeIdempotently<T>(
  runner: TransactionRunner,
  input: ConsumeIdempotentlyInput<T>,
): Promise<Result<ConsumptionOutcome<T>, DomainError>> {
  const { tenantId, consumerName, event, now, handle } = input;
  const correlationId = event.envelope.causality.correlationId;
  const scope = tenantScope(tenantId);
  const context: DomainErrorContext = { scope, correlationId };

  // A12 backstop: the consumer's tenant must be the event's tenant — a
  // cross-tenant consumption attempt is a typed unauthorized failure before
  // any SQL runs.
  if (event.envelope.scope.tenantId !== tenantId) {
    return fail(
      tenantScopeViolation(
        {
          commandTenantId: tenantId,
          aggregateTenantId: event.envelope.scope.tenantId,
        },
        context,
      ),
    );
  }

  return runner.runInTransaction(async (tx) => {
    // Position-verify the delivered event against the ledger (fail closed:
    // the outbox join guarantees this on the dispatch path; a directly
    // delivered event gets the same guarantee).
    const ledger = await tx.query(
      `SELECT sequence FROM ${LEDGER_TABLE} WHERE tenant_id = $1 AND event_id = $2`,
      [tenantId, event.eventId],
    );
    const ledgerRow = ledger.rows[0];
    if (ledgerRow === undefined) {
      return tx.rollback(
        fail(
          domainError(
            'not-found',
            `ledger event ${event.eventId} not found: cannot consume an event outside the ledger`,
            [{ code: 'ledger-event-not-found', message: event.eventId, path: null }],
            context,
          ),
        ),
      );
    }
    const ledgerSequence = readLedgerSequence(ledgerRow, LEDGER_TABLE);
    if (ledgerSequence !== event.sequence) {
      return tx.rollback(
        fail(
          invariantViolation(
            {
              name: 'delivered-event-position',
              statement: `delivered event ${event.eventId} carries sequence ${event.sequence} but the ledger records ${ledgerSequence}`,
            },
            context,
          ),
        ),
      );
    }

    // Claim-or-serialize: a fresh cursor row is claimed at the delivered
    // position (an unstarted consumer establishes its position); an
    // existing row is locked FOR UPDATE until this transaction resolves.
    // Concurrent first delivery of the same event serializes on the
    // insert; concurrent advance of an existing cursor serializes on the
    // row lock.
    const claim = await tx.query(
      `INSERT INTO ${CURSORS_TABLE} (
         tenant_id, consumer_name, aggregate_kind, aggregate_id, last_sequence, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, consumer_name, aggregate_kind, aggregate_id)
       DO NOTHING
       RETURNING last_sequence`,
      [
        tenantId,
        consumerName,
        event.aggregate.entityKind,
        event.aggregate.entityId,
        event.sequence,
        toDate(now),
      ],
    );
    const claimed = claim.rows[0] !== undefined;

    if (!claimed) {
      const cursor = await tx.query(
        `SELECT last_sequence FROM ${CURSORS_TABLE}
         WHERE tenant_id = $1 AND consumer_name = $2 AND aggregate_kind = $3 AND aggregate_id = $4
         FOR UPDATE`,
        [tenantId, consumerName, event.aggregate.entityKind, event.aggregate.entityId],
      );
      const cursorRow = cursor.rows[0];
      if (cursorRow === undefined) {
        return tx.rollback(
          fail(
            invariantViolation(
              {
                name: 'consumer-cursor-row',
                statement: 'consumer cursor row vanished between claim and lock',
              },
              context,
            ),
          ),
        );
      }
      const lastSequence = readLedgerSequence(cursorRow, CURSORS_TABLE, 'last_sequence');
      if (event.sequence <= lastSequence) {
        // Duplicate (or stale) delivery: harmless — nothing runs, nothing
        // moves. Every write of this attempt is discarded.
        return tx.rollback(ok({ status: 'skipped-duplicate' as const, lastSequence }));
      }
      if (event.sequence > lastSequence + 1) {
        return tx.rollback(
          fail(
            invariantViolation(
              {
                name: 'consumer-ledger-gap',
                statement: `delivered sequence ${event.sequence} for aggregate ${event.aggregate.entityKind} ${event.aggregate.entityId} leaves a gap after cursor ${lastSequence}: events ${lastSequence + 1}..${event.sequence - 1} were never delivered`,
              },
              context,
            ),
          ),
        );
      }
    }

    // The handler's writes join THIS transaction: a failure discards them
    // together with the claim/advance (redelivery reprocesses).
    const handled = await handle(tx);
    if (!handled.ok) {
      return tx.rollback(fail(handled.error));
    }

    if (!claimed) {
      // Advance the locked cursor to the consumed position.
      await tx.query(
        `UPDATE ${CURSORS_TABLE}
         SET last_sequence = $5, updated_at = $6
         WHERE tenant_id = $1 AND consumer_name = $2 AND aggregate_kind = $3 AND aggregate_id = $4`,
        [
          tenantId,
          consumerName,
          event.aggregate.entityKind,
          event.aggregate.entityId,
          event.sequence,
          toDate(now),
        ],
      );
    }
    return ok({ status: 'processed' as const, effect: handled.value });
  });
}

/**
 * Read one consumer's cursor for one aggregate stream (null when the
 * consumer has not consumed anything yet). Tenant-keyed; operational
 * introspection and tests.
 */
export async function readConsumerCursor(
  db: SqlExecutor,
  tenantId: TenantId,
  consumerName: ConsumerName,
  aggregate: EntityRef,
): Promise<Result<ConsumerCursor | null, DomainError>> {
  const result = await db.query(
    `SELECT tenant_id, consumer_name, aggregate_kind, aggregate_id, last_sequence, updated_at
     FROM ${CURSORS_TABLE}
     WHERE tenant_id = $1 AND consumer_name = $2 AND aggregate_kind = $3 AND aggregate_id = $4`,
    [tenantId, consumerName, aggregate.entityKind, aggregate.entityId],
  );
  const row = result.rows[0];
  return ok(row === undefined ? null : mapCursorRow(row));
}
