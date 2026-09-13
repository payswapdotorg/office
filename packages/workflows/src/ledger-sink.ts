// Office workflow engine — the ledger-backed EventSink adapter (OFF-016).
//
// A THIN transactional implementation of the EventSink port over the OFF-005
// event ledger and outbox: for every envelope it calls appendEvent (ledger
// row + dense per-aggregate sequence) and enqueueOutbox (dispatch row) on
// the SAME caller-supplied executor — the open transaction of the
// surrounding mutation — so the event, the outbox entry, and the state
// change commit atomically or vanish together (the canonical mutation flow
// of the frozen architecture). The aggregate of each append is derived from
// the envelope's entityRefs.after (this engine's events always carry the
// mutated aggregate as their after-reference; before is null exactly on
// creations, and before === after on the audit-only approval-denied event —
// the denial record addresses the unchanged aggregate).
//
// This adapter is the only place the package touches @office/events; the
// aggregates, commands, and their tests stay pure-domain and
// in-memory-testable.
import { isEntityRef } from '@office/contracts';
import type { DomainEventEnvelope, EntityRef, EventName } from '@office/contracts';
import { appendEvent, enqueueOutbox } from '@office/events';
import { invariantViolation } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { EventSink } from './events';

/** Options of {@link createLedgerEventSink}. */
export interface LedgerEventSinkOptions {
  /**
   * Enqueue an outbox row for every appended event (default true — the
   * canonical atomic pattern of appendEvent + enqueueOutbox in one
   * transaction). False appends to the ledger only (auditing sinks).
   */
  readonly enqueueOutbox?: boolean;
}

/** The typed failure for an envelope that does not address its aggregate. */
const withoutAfterReference = (eventName: EventName): DomainError =>
  invariantViolation(
    {
      name: 'ledger-sink-requires-after-ref',
      statement: `event '${eventName}' carries no entityRefs.after reference; the ledger-backed sink derives each append's aggregate from it (a workflow event must address its mutated aggregate)`,
    },
  );

/**
 * Create the ledger-backed EventSink: appendEvent + enqueueOutbox per
 * envelope, all inside the caller's open transaction (the executor handed to
 * appendEvents).
 */
export function createLedgerEventSink(options: LedgerEventSinkOptions = {}): EventSink {
  const shouldEnqueue = options.enqueueOutbox ?? true;
  return {
    appendEvents: async (
      executor: SqlExecutor,
      events: readonly DomainEventEnvelope[],
    ): Promise<Result<true, DomainError>> => {
      for (const envelope of events) {
        const aggregate: EntityRef | null = envelope.entityRefs.after;
        if (!isEntityRef(aggregate)) {
          return { ok: false, error: withoutAfterReference(envelope.eventName) };
        }
        const appended = await appendEvent(executor, { envelope, aggregate });
        if (!appended.ok) return appended;
        if (shouldEnqueue) {
          const enqueued = await enqueueOutbox(executor, appended.value);
          if (!enqueued.ok) return enqueued;
        }
      }
      return { ok: true, value: true };
    },
  };
}
