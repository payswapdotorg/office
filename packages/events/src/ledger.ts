// Office events — the append-only event ledger (OFF-005, freeze A3).
//
// appendEvent() records one immutable DomainEventEnvelope row inside a
// CALLER-SUPPLIED transaction (SqlExecutor — never its own transaction):
// a command handler's state writes and its ledger append commit atomically
// together, per the frozen cross-view mutation flow ("transaction persists
// state and an outbox event atomically").
//
// Sequence assignment is ledger-side and race-safe: a per-(tenant,
// aggregate) counter row (event_sequences) is upserted with
// INSERT ... ON CONFLICT DO UPDATE, which takes an exclusive row lock held
// until the transaction resolves — concurrent appends for the same aggregate
// serialize on it, so sequences are strictly monotonic AND dense (the
// counter and the ledger row commit or vanish together). The UNIQUE
// (tenant_id, aggregate_kind, aggregate_id, sequence) constraint is the
// database-level net that makes duplicate sequences impossible regardless of
// the write path; a violation surfaces as a typed invariant-violation.
//
// Event ids are deterministic (identity.ts): derived from the ledger key, so
// replay reproduces them exactly — and they double as valid CausationIds for
// downstream events (causedByEvent below).
//
// Immutability: this module contains no UPDATE or DELETE against
// event_ledger, and migration 0003 installs a trigger rejecting any such
// statement from anywhere — the ledger is append-only, ever.
import { isDomainEventEnvelope, isEntityRef } from '@office/contracts';
import type {
  Causality,
  CommandEnvelope,
  DomainEventEnvelope,
  EntityRef,
  Scope,
} from '@office/contracts';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { scopedSql } from '@office/persistence';
import type { SqlExecutor } from '@office/persistence';
import { causationIdOf, ledgerEventIdOf } from './identity';
import type { LedgerEventId, LedgerSequence } from './identity';
import {
  asJsonbValue,
  driverErrorInfo,
  readEntityRef,
  readEnvelope,
  readLedgerEventId,
  readLedgerSequence,
  toDate,
} from './rows';

/**
 * A ledger row decoded into canonical types: the ledger-assigned identity
 * and position plus the full validated envelope, exactly as appended.
 */
export interface LedgerEvent {
  /** Deterministic ledger-assigned id (also usable as a CausationId). */
  readonly eventId: LedgerEventId;
  /** Dense per-(tenant, aggregate) position; strictly monotonic. */
  readonly sequence: LedgerSequence;
  /** The aggregate this event belongs to (kind + canonical id). */
  readonly aggregate: EntityRef;
  /** The immutable envelope as appended (scope, actor, causality, payload, ...). */
  readonly envelope: DomainEventEnvelope;
}

/** Input of an append: the validated envelope plus the aggregate it belongs to. */
export interface AppendEventInput {
  readonly envelope: DomainEventEnvelope;
  /**
   * The aggregate the event records a mutation of — the key sequence numbers
   * are assigned per (tenant, aggregate). Events not bound to a single
   * entity (both entity refs null) still belong to an aggregate stream, so
   * the aggregate is explicit rather than derived.
   */
  readonly aggregate: EntityRef;
}

const LEDGER_COLUMNS =
  'tenant_id, event_id, aggregate_kind, aggregate_id, sequence, event_name, project_id, actor, source, correlation_id, causation_id, schema_version, occurred_at, entity_refs, payload';

const LEDGER_TABLE = 'event_ledger';
const SEQUENCES_TABLE = 'event_sequences';

/** Decode a ledger row (fail-closed). */
const mapLedgerRow = (row: Record<string, unknown>): LedgerEvent => ({
  eventId: readLedgerEventId(row, LEDGER_TABLE),
  sequence: readLedgerSequence(row, LEDGER_TABLE),
  aggregate: readEntityRef(row, LEDGER_TABLE, 'aggregate_kind', 'aggregate_id'),
  envelope: readEnvelope(row, LEDGER_TABLE),
});

const contextOf = (envelope: DomainEventEnvelope): DomainErrorContext => ({
  scope: envelope.scope,
  correlationId: envelope.causality.correlationId,
});

/**
 * Append one immutable event to the ledger inside the caller's transaction.
 *
 * The envelope is revalidated fail-closed at the ledger boundary (the ledger
 * is the system of record for history — garbage never gets stored); the
 * scope columns of the row come from the validated envelope's scope, never
 * from caller-supplied column values. Sequence assignment and the insert run
 * in the SAME transaction, so a rollback anywhere discards both — sequences
 * stay dense.
 */
export async function appendEvent(
  db: SqlExecutor,
  input: AppendEventInput,
): Promise<Result<LedgerEvent, DomainError>> {
  const { envelope, aggregate } = input;
  if (!isDomainEventEnvelope(envelope)) {
    return fail(
      invariantViolation(
        {
          name: 'event-envelope-valid',
          statement: 'appendEvent requires a structurally valid DomainEventEnvelope',
        },
      ),
    );
  }
  if (!isEntityRef(aggregate)) {
    return fail(
      invariantViolation(
        {
          name: 'aggregate-ref-valid',
          statement: 'appendEvent requires a structurally valid aggregate EntityRef',
        },
        contextOf(envelope),
      ),
    );
  }

  // Race-safe sequence assignment: the upsert's exclusive row lock per
  // (tenant, aggregate) serializes concurrent appends until commit.
  let sequence: LedgerSequence;
  try {
    const counter = await db.query(
      `INSERT INTO ${SEQUENCES_TABLE} (tenant_id, aggregate_kind, aggregate_id, last_sequence)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, aggregate_kind, aggregate_id)
       DO UPDATE SET last_sequence = ${SEQUENCES_TABLE}.last_sequence + 1
       RETURNING last_sequence`,
      [envelope.scope.tenantId, aggregate.entityKind, aggregate.entityId],
    );
    const row = counter.rows[0];
    if (row === undefined) {
      return fail(
        invariantViolation(
          {
            name: 'sequence-assigned',
            statement: 'event sequence counter upsert returned no row',
          },
          contextOf(envelope),
        ),
      );
    }
    sequence = readLedgerSequence(row, SEQUENCES_TABLE, 'last_sequence');
  } catch (error) {
    return fail(sequenceFailure(error, envelope, aggregate));
  }

  const eventId = ledgerEventIdOf({
    tenantId: envelope.scope.tenantId,
    aggregate,
    sequence,
  });

  try {
    const result = await db.query(
      `INSERT INTO ${LEDGER_TABLE} (
         tenant_id, event_id, aggregate_kind, aggregate_id, sequence, event_name,
         project_id, actor, source, correlation_id, causation_id, schema_version,
         occurred_at, entity_refs, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${LEDGER_COLUMNS}`,
      [
        envelope.scope.tenantId,
        eventId,
        aggregate.entityKind,
        aggregate.entityId,
        sequence,
        envelope.eventName,
        envelope.scope.kind === 'project' ? envelope.scope.projectId : null,
        asJsonbValue(envelope.actor),
        envelope.source,
        envelope.causality.correlationId,
        envelope.causality.causationId,
        envelope.schemaVersion,
        toDate(envelope.occurredAt),
        asJsonbValue(envelope.entityRefs),
        asJsonbValue(envelope.payload),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return fail(
        invariantViolation(
          {
            name: 'ledger-insert-row',
            statement: 'event ledger insert returned no row',
          },
          contextOf(envelope),
        ),
      );
    }
    return ok(mapLedgerRow(row));
  } catch (error) {
    return fail(insertFailure(error, envelope, aggregate, sequence));
  }
}

/** Map counter-upsert driver errors onto typed domain failures. */
const sequenceFailure = (
  error: unknown,
  envelope: DomainEventEnvelope,
  aggregate: EntityRef,
): DomainError => {
  const { code, constraint } = driverErrorInfo(error);
  if (code === '23505' && constraint === 'event_sequences_pkey') {
    return domainError(
      'invariant-violation',
      'event sequence counter insert raced despite the per-aggregate row lock',
      [{ code: 'sequence-counter-race', message: aggregate.entityId, path: 'aggregate' }],
      contextOf(envelope),
    );
  }
  throw error;
};

/** Map ledger-insert driver errors onto typed domain failures. */
const insertFailure = (
  error: unknown,
  envelope: DomainEventEnvelope,
  aggregate: EntityRef,
  sequence: LedgerSequence,
): DomainError => {
  const { code, constraint } = driverErrorInfo(error);
  if (code === '23505' && constraint === 'event_ledger_pkey') {
    return domainError(
      'invariant-violation',
      `event id already exists in the ledger: ${ledgerEventIdOf({
        tenantId: envelope.scope.tenantId,
        aggregate,
        sequence,
      })}`,
      [{ code: 'event-id-already-exists', message: aggregate.entityId, path: 'eventId' }],
      contextOf(envelope),
    );
  }
  if (code === '23505' && constraint === 'event_ledger_aggregate_sequence_key') {
    return domainError(
      'invariant-violation',
      `sequence ${sequence} already recorded for aggregate ${aggregate.entityKind} ${aggregate.entityId}`,
      [{ code: 'aggregate-sequence-conflict', message: String(sequence), path: 'sequence' }],
      contextOf(envelope),
    );
  }
  throw error;
};

/** Select one ledger row by id within a scope (null when not visible). */
const selectLedgerRow = async (
  db: SqlExecutor,
  scope: Scope,
  eventId: LedgerEventId,
): Promise<Record<string, unknown> | null> => {
  const statement = scopedSql(scope);
  const idParam = statement.bind(eventId);
  const result = await db.query(
    `SELECT ${LEDGER_COLUMNS} FROM ${LEDGER_TABLE}
     WHERE ${statement.scopePredicate} AND event_id = ${idParam}`,
    statement.values,
  );
  const row = result.rows[0];
  return row === undefined ? null : row;
};

/**
 * Load one ledger event by id within the scope. A foreign-tenant or
 * out-of-project-scope event is a typed not-found — the row is simply not
 * visible, with no existence oracle (same semantics as the persistence
 * repositories).
 */
export async function readEventById(
  db: SqlExecutor,
  scope: Scope,
  eventId: LedgerEventId,
): Promise<Result<LedgerEvent, DomainError>> {
  const row = await selectLedgerRow(db, scope, eventId);
  if (row === null) {
    return fail(
      domainError(
        'not-found',
        `ledger event ${eventId} not found`,
        [{ code: 'ledger-event-not-found', message: eventId, path: null }],
        { scope },
      ),
    );
  }
  return ok(mapLedgerRow(row));
}

/**
 * Read the aggregate's whole event stream in ledger order (sequence
 * ascending) within the scope — the replay source for projections and
 * aggregate rehydration. Deterministic by construction: sequences are dense
 * per aggregate and ordering never depends on wall-clock or read timing.
 */
export async function readAggregateEvents(
  db: SqlExecutor,
  scope: Scope,
  aggregate: EntityRef,
): Promise<Result<readonly LedgerEvent[], DomainError>> {
  const statement = scopedSql(scope);
  const kindParam = statement.bind(aggregate.entityKind);
  const idParam = statement.bind(aggregate.entityId);
  const result = await db.query(
    `SELECT ${LEDGER_COLUMNS} FROM ${LEDGER_TABLE}
     WHERE ${statement.scopePredicate} AND aggregate_kind = ${kindParam} AND aggregate_id = ${idParam}
     ORDER BY sequence ASC`,
    statement.values,
  );
  return ok(result.rows.map(mapLedgerRow));
}

/**
 * Causality for an event caused by a COMMAND: the command's correlation id
 * is carried forward unchanged, and the causation id points at the causing
 * message — the command's idempotency key (contracts causality convention,
 * freeze A3). Trusted path: the command envelope is already validated and
 * the idempotency key grammar is exactly the causation id grammar.
 */
export const causedByCommand = (command: CommandEnvelope): Causality => ({
  correlationId: command.causality.correlationId,
  causationId: causationIdOf(command.idempotencyKey),
});

/**
 * Causality for an event caused by a PRIOR EVENT (a reaction, projection,
 * or workflow consequence): the correlation id of the causal chain is
 * carried forward unchanged, and the causation id points at the prior
 * event's ledger id. Trusted path: the ledger event was decoded fail-closed.
 */
export const causedByEvent = (event: LedgerEvent): Causality => ({
  correlationId: event.envelope.causality.correlationId,
  causationId: causationIdOf(event.eventId),
});
