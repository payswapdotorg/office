// Office host gateway — the ledger-backed audit EventSink (OFF-DEPLOY).
//
// THE transactional implementation of the EventSink port over the REAL
// OFF-005 event ledger + outbox: for every audit envelope it calls
// appendEvent (ledger row + dense per-aggregate sequence) and enqueueOutbox
// (dispatch row) inside ONE transaction over the gateway's pool, so each
// audit append commits atomically or vanishes entirely. This mirrors the
// landed ledger-sink adapters of the domain packages byte-for-byte in
// semantics (the domain-organization/domain-projects ports are structurally
// identical); the host gateway composes it directly over @office/events'
// public appendEvent/enqueueOutbox so the canonical PG command path and the
// A8 action gateway's audit trail land in the SAME ledger as every other
// canonical event.
import { appendEvent, enqueueOutbox } from '@office/events';
import { invariantViolation } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { DomainEventEnvelope, EntityRef, EventName } from '@office/contracts';
import type { PersistencePool } from '@office/persistence';

/** The shared EventSink port shape every landed domain mirrors (minimal). */
export interface LedgerAuditSink {
  appendEvents(
    executor: unknown,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** The typed failure for an envelope that does not address its aggregate. */
const withoutAfterReference = (eventName: EventName): DomainError =>
  invariantViolation(
    {
      name: 'ledger-sink-requires-after-ref',
      statement: `audit event '${eventName}' carries no entityRefs.after reference; the ledger-backed sink derives each append's aggregate from it`,
    },
  );

/**
 * Create the ledger-backed audit sink over the runtime's pool. Each envelope
 * is appended + enqueued in one transaction (the canonical atomic pattern);
 * the executor handle the caller hands to appendEvents is accepted opaquely —
 * the sink runs over the pool it was composed with, which IS the executor the
 * gateway hands it, so the composition stays single-sourced.
 */
export const createLedgerAuditSink = (pool: PersistencePool): LedgerAuditSink => ({
  appendEvents: async (_executor, events) => {
    for (const envelope of events) {
      const aggregate: EntityRef | null = envelope.entityRefs.after;
      if (aggregate === null) {
        return { ok: false, error: withoutAfterReference(envelope.eventName) };
      }
      // ONE transaction per envelope: the ledger row (with its dense
      // sequence) and the outbox row commit together or vanish together —
      // the canonical atomic mutation pattern of the frozen architecture.
      const appended = await pool.runInTransaction(async (tx) => {
        const event = await appendEvent(tx, { envelope, aggregate });
        if (!event.ok) return event;
        return enqueueOutbox(tx, event.value);
      });
      if (!appended.ok) return appended;
    }
    return { ok: true, value: true };
  },
});
