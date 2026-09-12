// Office events — the transactional outbox (OFF-005, freeze A3/A10).
//
// enqueueOutbox() appends the outbox row for an already-appended ledger
// event INSIDE THE SAME caller-supplied transaction as the state writes and
// the ledger append: the canonical mutation flow is
//
//     runInTransaction(tx => { state writes; appendEvent(tx, ...); enqueueOutbox(tx, event); })
//
// so the event is dispatched if and only if the state change committed — no
// partial anything (proven by the integration suite: a failure after the
// state write rolls back state + event + outbox row together).
//
// The outbox row references the ledger event (FK): an enqueue of an event
// that was never appended is a typed invariant-violation, which is exactly
// what forces the append-then-enqueue order inside one transaction.
//
// Dispatch is at-least-once (freeze A3): fetchPendingOutbox may hand the
// same row to more than one worker; markDispatched is the idempotent
// exactly-once-per-row transition (a duplicate call is a no-op that leaves
// dispatched_at untouched), and consumers deduplicate effects through the
// consumer cursor (consumer.ts).
import type { Scope, Timestamp } from '@office/contracts';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { scopedSql } from '@office/persistence';
import type { SqlExecutor } from '@office/persistence';
import type { LedgerEvent } from './ledger';
import type { LedgerEventId } from './identity';
import {
  driverErrorInfo,
  readEntityRef,
  readEnvelope,
  readLedgerEventId,
  readLedgerSequence,
  readNonNegativeInt,
  readNullableTimestamp,
  readOutboxState,
  readScope,
  readTimestamp,
  toDate,
} from './rows';

/** Lifecycle state of an outbox row: pending dispatch, or dispatched. */
export type OutboxState = 'pending' | 'dispatched';

/** A decoded outbox row: dispatch bookkeeping for exactly one ledger event. */
export interface OutboxRecord {
  /** Insertion-ordered identity (dispatch drains in this order). */
  readonly outboxId: number;
  /** The ledger event this row dispatches (FK: exactly one row per event). */
  readonly eventId: LedgerEventId;
  /** The scope columns of the outbox row (from the event's envelope scope). */
  readonly scope: Scope;
  readonly state: OutboxState;
  /** Failed dispatch attempts recorded so far (never incremented once dispatched). */
  readonly attempts: number;
  /** Earliest next dispatch attempt (next-attempt-at; retry backoff policy is the caller's). */
  readonly availableAt: Timestamp;
  readonly createdAt: Timestamp;
  readonly dispatchedAt: Timestamp | null;
}

/** A pending outbox row joined with its full ledger event — the dispatch unit. */
export interface OutboxEntry {
  readonly record: OutboxRecord;
  readonly event: LedgerEvent;
}

/** Options for enqueueOutbox. */
export interface EnqueueOutboxOptions {
  /**
   * Earliest dispatch attempt (next-attempt-at). Defaults to the event's
   * occurred-at — deterministic, no wall clock. Delayed publication sets an
   * explicit later instant.
   */
  readonly availableAt?: Timestamp;
}

/** Options for fetchPendingOutbox. */
export interface FetchPendingOutboxOptions {
  /** The dispatcher's 'now' (injected clock — never read inside the package). */
  readonly now: Timestamp;
  /** Maximum number of due rows to fetch (>= 1). */
  readonly limit: number;
}

/** Options for markDispatched. */
export interface MarkDispatchedOptions {
  /** The dispatch instant (injected clock) recorded as dispatched_at exactly once. */
  readonly now: Timestamp;
}

/** Options for recordDispatchFailure. */
export interface RecordDispatchFailureOptions {
  /** When the next attempt becomes due (caller's retry/backoff policy). */
  readonly nextAttemptAt: Timestamp;
}

const OUTBOX_TABLE = 'event_outbox';
const LEDGER_TABLE = 'event_ledger';

const OUTBOX_COLUMNS =
  'outbox_id, tenant_id, project_id, event_id, state, attempts, available_at, created_at, dispatched_at';

/** Decode an outbox row (fail-closed). */
const mapOutboxRow = (row: Record<string, unknown>): OutboxRecord => ({
  outboxId: readNonNegativeInt(row, OUTBOX_TABLE, 'outbox_id'),
  eventId: readLedgerEventId(row, OUTBOX_TABLE),
  scope: readScope(row, OUTBOX_TABLE),
  state: readOutboxState(row, OUTBOX_TABLE),
  attempts: readNonNegativeInt(row, OUTBOX_TABLE, 'attempts'),
  availableAt: readTimestamp(row, OUTBOX_TABLE, 'available_at'),
  createdAt: readTimestamp(row, OUTBOX_TABLE, 'created_at'),
  dispatchedAt: readNullableTimestamp(row, OUTBOX_TABLE, 'dispatched_at'),
});

/**
 * Enqueue the outbox row for an appended ledger event, inside the SAME
 * transaction as the append (and the state writes). The row's scope columns
 * and created_at come from the event's envelope; state starts 'pending'
 * with zero attempts. Enqueueing the same event twice is a typed
 * invariant-violation (one outbox row per event, by the unique key).
 */
export async function enqueueOutbox(
  db: SqlExecutor,
  event: LedgerEvent,
  options: EnqueueOutboxOptions = {},
): Promise<Result<OutboxRecord, DomainError>> {
  const availableAt = options.availableAt ?? event.envelope.occurredAt;
  const scope = event.envelope.scope;
  try {
    const result = await db.query(
      `INSERT INTO ${OUTBOX_TABLE} (
         tenant_id, project_id, event_id, state, attempts, available_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${OUTBOX_COLUMNS}`,
      [
        scope.tenantId,
        scope.kind === 'project' ? scope.projectId : null,
        event.eventId,
        'pending',
        0,
        toDate(availableAt),
        toDate(event.envelope.occurredAt),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return fail(
        invariantViolation(
          {
            name: 'outbox-insert-row',
            statement: 'outbox insert returned no row',
          },
          { scope, correlationId: event.envelope.causality.correlationId },
        ),
      );
    }
    return ok(mapOutboxRow(row));
  } catch (error) {
    const { code, constraint } = driverErrorInfo(error);
    if (code === '23505' && constraint === 'event_outbox_event_id_key') {
      return fail(
        domainError(
          'invariant-violation',
          `outbox entry already exists for event ${event.eventId}`,
          [{ code: 'outbox-entry-already-exists', message: event.eventId, path: 'eventId' }],
          { scope, correlationId: event.envelope.causality.correlationId },
        ),
      );
    }
    if (code === '23503' && constraint === 'event_outbox_event_id_fkey') {
      return fail(
        domainError(
          'invariant-violation',
          `outbox enqueue requires the event to be appended first (same transaction): ${event.eventId}`,
          [
            {
              code: 'outbox-event-not-in-ledger',
              message: event.eventId,
              path: 'eventId',
            },
          ],
          { scope, correlationId: event.envelope.causality.correlationId },
        ),
      );
    }
    throw error;
  }
}

/**
 * Fetch due pending outbox entries (state 'pending', available_at <= now)
 * within the scope, drained in insertion order — which per aggregate equals
 * ledger sequence order, because same-aggregate appends serialize on the
 * sequence counter row lock until commit. At-least-once: concurrent
 * dispatchers may see the same row; markDispatched + the consumer cursor
 * make duplicates harmless. The joined ledger event is decoded fail-closed.
 */
export async function fetchPendingOutbox(
  db: SqlExecutor,
  scope: Scope,
  options: FetchPendingOutboxOptions,
): Promise<Result<readonly OutboxEntry[], DomainError>> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    return fail(
      invariantViolation(
        {
          name: 'outbox-fetch-limit',
          statement: 'fetchPendingOutbox requires an integer limit >= 1',
        },
        { scope },
      ),
    );
  }
  // scopedSql binds the scope values first ($1 tenant, $2 project when
  // project-scoped); the predicate below mirrors its numbering, qualified to
  // the outbox side of the join (o.tenant_id = e.tenant_id by the join).
  const statement = scopedSql(scope);
  const nowParam = statement.bind(toDate(options.now));
  const limitParam = statement.bind(options.limit);
  const outboxScopePredicate =
    scope.kind === 'project'
      ? 'o.tenant_id = $1 AND o.project_id = $2'
      : 'o.tenant_id = $1';
  const result = await db.query(
    `SELECT
       o.outbox_id      AS outbox_id,
       o.tenant_id      AS outbox_tenant_id,
       o.project_id     AS outbox_project_id,
       o.event_id       AS outbox_event_id,
       o.state          AS outbox_state,
       o.attempts       AS outbox_attempts,
       o.available_at   AS outbox_available_at,
       o.created_at     AS outbox_created_at,
       o.dispatched_at  AS outbox_dispatched_at,
       e.tenant_id      AS event_tenant_id,
       e.event_id       AS event_event_id,
       e.aggregate_kind AS event_aggregate_kind,
       e.aggregate_id   AS event_aggregate_id,
       e.sequence       AS event_sequence,
       e.event_name     AS event_event_name,
       e.project_id     AS event_project_id,
       e.actor          AS event_actor,
       e.source         AS event_source,
       e.correlation_id AS event_correlation_id,
       e.causation_id   AS event_causation_id,
       e.schema_version AS event_schema_version,
       e.occurred_at    AS event_occurred_at,
       e.entity_refs    AS event_entity_refs,
       e.payload        AS event_payload
     FROM ${OUTBOX_TABLE} o
     JOIN ${LEDGER_TABLE} e
       ON e.tenant_id = o.tenant_id AND e.event_id = o.event_id
     WHERE ${outboxScopePredicate}
       AND o.state = 'pending'
       AND o.available_at <= ${nowParam}
     ORDER BY o.outbox_id ASC
     LIMIT ${limitParam}`,
    statement.values,
  );
  return ok(result.rows.map(mapOutboxEntryRow));
}

/** Decode one joined outbox+ledger row into an OutboxEntry (fail-closed). */
const mapOutboxEntryRow = (row: Record<string, unknown>): OutboxEntry => {
  const outboxRow: Record<string, unknown> = {
    outbox_id: row['outbox_id'],
    tenant_id: row['outbox_tenant_id'],
    project_id: row['outbox_project_id'],
    event_id: row['outbox_event_id'],
    state: row['outbox_state'],
    attempts: row['outbox_attempts'],
    available_at: row['outbox_available_at'],
    created_at: row['outbox_created_at'],
    dispatched_at: row['outbox_dispatched_at'],
  };
  const ledgerRow: Record<string, unknown> = {
    tenant_id: row['event_tenant_id'],
    event_id: row['event_event_id'],
    aggregate_kind: row['event_aggregate_kind'],
    aggregate_id: row['event_aggregate_id'],
    sequence: row['event_sequence'],
    event_name: row['event_event_name'],
    project_id: row['event_project_id'],
    actor: row['event_actor'],
    source: row['event_source'],
    correlation_id: row['event_correlation_id'],
    causation_id: row['event_causation_id'],
    schema_version: row['event_schema_version'],
    occurred_at: row['event_occurred_at'],
    entity_refs: row['event_entity_refs'],
    payload: row['event_payload'],
  };
  return {
    record: mapOutboxRow(outboxRow),
    event: {
      eventId: readLedgerEventId(ledgerRow, LEDGER_TABLE),
      sequence: readLedgerSequence(ledgerRow, LEDGER_TABLE),
      aggregate: readEntityRef(ledgerRow, LEDGER_TABLE, 'aggregate_kind', 'aggregate_id'),
      envelope: readEnvelope(ledgerRow, LEDGER_TABLE),
    },
  };
};

/** Select one outbox row by id within a scope (null when not visible). */
const selectOutboxRow = async (
  db: SqlExecutor,
  scope: Scope,
  outboxId: number,
): Promise<OutboxRecord | null> => {
  const statement = scopedSql(scope);
  const idParam = statement.bind(outboxId);
  const result = await db.query(
    `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX_TABLE}
     WHERE ${statement.scopePredicate} AND outbox_id = ${idParam}`,
    statement.values,
  );
  const row = result.rows[0];
  return row === undefined ? null : mapOutboxRow(row);
};

/**
 * Mark an outbox row dispatched — exactly-once-per-row under duplicate
 * processing: the transition runs only from the 'pending' state, so a
 * duplicate call is a no-op that returns the already-dispatched record with
 * dispatched_at untouched. A missing (or scope-invisible) row is a typed
 * not-found.
 */
export async function markDispatched(
  db: SqlExecutor,
  scope: Scope,
  outboxId: number,
  options: MarkDispatchedOptions,
): Promise<Result<OutboxRecord, DomainError>> {
  const statement = scopedSql(scope);
  const nowParam = statement.bind(toDate(options.now));
  const idParam = statement.bind(outboxId);
  const result = await db.query(
    `UPDATE ${OUTBOX_TABLE}
     SET state = 'dispatched', dispatched_at = ${nowParam}
     WHERE ${statement.scopePredicate} AND outbox_id = ${idParam} AND state = 'pending'
     RETURNING ${OUTBOX_COLUMNS}`,
    statement.values,
  );
  const row = result.rows[0];
  if (row !== undefined) {
    return ok(mapOutboxRow(row));
  }
  // Zero affected rows: missing/invisible row, or already dispatched — the
  // scoped re-read classifies exactly.
  const current = await selectOutboxRow(db, scope, outboxId);
  if (current === null) {
    return fail(outboxNotFound(outboxId, scope));
  }
  if (current.state === 'dispatched') {
    return ok(current);
  }
  return fail(
    invariantViolation(
      {
        name: 'outbox-dispatch-transition',
        statement: `outbox row ${outboxId} could not transition from state '${current.state}'`,
      },
      { scope },
    ),
  );
};

/**
 * Record a failed dispatch attempt on a pending row: attempts increments,
 * available_at moves to the caller's next-attempt-at (their backoff policy),
 * state stays 'pending'. Recording a failure for an already-dispatched row
 * is a no-op returning the record unchanged (a duplicate dispatcher lost
 * the race — the row IS dispatched); a missing row is a typed not-found.
 */
export async function recordDispatchFailure(
  db: SqlExecutor,
  scope: Scope,
  outboxId: number,
  options: RecordDispatchFailureOptions,
): Promise<Result<OutboxRecord, DomainError>> {
  const statement = scopedSql(scope);
  const nextParam = statement.bind(toDate(options.nextAttemptAt));
  const idParam = statement.bind(outboxId);
  const result = await db.query(
    `UPDATE ${OUTBOX_TABLE}
     SET attempts = attempts + 1, available_at = ${nextParam}
     WHERE ${statement.scopePredicate} AND outbox_id = ${idParam} AND state = 'pending'
     RETURNING ${OUTBOX_COLUMNS}`,
    statement.values,
  );
  const row = result.rows[0];
  if (row !== undefined) {
    return ok(mapOutboxRow(row));
  }
  const current = await selectOutboxRow(db, scope, outboxId);
  if (current === null) {
    return fail(outboxNotFound(outboxId, scope));
  }
  if (current.state === 'dispatched') {
    return ok(current);
  }
  return fail(
    invariantViolation(
      {
        name: 'outbox-failure-transition',
        statement: `outbox row ${outboxId} could not record a failure from state '${current.state}'`,
      },
      { scope },
    ),
  );
};

const outboxNotFound = (outboxId: number, scope: Scope): DomainError =>
  domainError(
    'not-found',
    `outbox entry ${outboxId} not found`,
    [{ code: 'outbox-entry-not-found', message: String(outboxId), path: null }],
    { scope },
  );
