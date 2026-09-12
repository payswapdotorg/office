// Office intelligence — the relationship event source (OFF-013).
//
// The projection reads the ledger's READ surface through this PORT — the
// engine never writes the ledger (packages/events owns appends; freeze A3:
// consumers project, they do not mutate history). The runtime wires the
// real ledger behind this port later (readAggregateEvents/readEventById of
// @office/events against a SqlExecutor in the caller's scope); this package
// ships the deterministic IN-MEMORY source for tests, which mirrors the
// ledger's read shape exactly: per-(tenant, aggregate) dense sequences and
// deterministic ledger event ids derived the same way appendEvent derives
// them (ledgerEventIdOf), so the same append sequence reproduces identical
// ids and identical read results — the replayability proofs of A7/A9.
import { isDomainEventEnvelope, isEntityRef } from '@office/contracts';
import type { DomainEventEnvelope, EntityRef } from '@office/contracts';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { ledgerEventIdOf } from '@office/events';
import type { LedgerEvent, LedgerEventId, LedgerSequence } from '@office/events';

/**
 * The ledger READ surface the relationship engine needs: the full event
 * stream(s) being projected, in ledger order, plus one-event-by-id lookup
 * (the backward walk of causal-chain queries). Implementations are
 * scope-responsible exactly like the real ledger reads: an event outside
 * the reading scope is simply not present.
 */
export interface RelationshipEventSource {
  /** Every ledger event visible to this source, in ledger order. */
  readEvents(): Promise<Result<readonly LedgerEvent[], DomainError>>;
  /** One ledger event by id (typed not-found when absent from the source). */
  readEventById(eventId: LedgerEventId): Promise<Result<LedgerEvent, DomainError>>;
}

/**
 * The deterministic in-memory event source for tests: append events in
 * ledger order and read them back with the SAME identity semantics as the
 * OFF-005 ledger (dense per-(tenant, aggregate) sequences; deterministic
 * ledger event ids derived from the ledger key). No clock, no randomness —
 * the same append sequence always produces the identical event list.
 */
export interface InMemoryEventSource extends RelationshipEventSource {
  /**
   * Append one envelope to the source's ledger-shaped stream. Mirrors
   * appendEvent's boundary checks (fail-closed envelope + aggregate
   * validation) but writes only memory — the real ledger is never touched.
   */
  append(
    envelope: DomainEventEnvelope,
    aggregate: EntityRef,
  ): Promise<Result<LedgerEvent, DomainError>>;
  /** Every appended event, in append order. */
  readonly events: readonly LedgerEvent[];
}

/** Create an empty in-memory event source (deterministic, pure memory). */
export function createInMemoryEventSource(): InMemoryEventSource {
  const events: LedgerEvent[] = [];
  const byId = new Map<string, LedgerEvent>();
  const counters = new Map<string, number>();

  const sequenceKey = (envelope: DomainEventEnvelope, aggregate: EntityRef): string =>
    `${envelope.scope.tenantId}|${aggregate.entityKind}|${aggregate.entityId}`;

  return {
    get events(): readonly LedgerEvent[] {
      return [...events];
    },
    append: async (envelope, aggregate) => {
      if (!isDomainEventEnvelope(envelope)) {
        return fail(
          invariantViolation(
            {
              name: 'event-envelope-valid',
              statement: 'append requires a structurally valid DomainEventEnvelope',
            },
          ),
        );
      }
      if (!isEntityRef(aggregate)) {
        return fail(
          invariantViolation(
            {
              name: 'aggregate-ref-valid',
              statement: 'append requires a structurally valid aggregate EntityRef',
            },
          ),
        );
      }
      const key = sequenceKey(envelope, aggregate);
      const sequence = (counters.get(key) ?? 0) + 1;
      counters.set(key, sequence);
      const event: LedgerEvent = {
        eventId: ledgerEventIdOf({
          tenantId: envelope.scope.tenantId,
          aggregate,
          sequence: sequence as LedgerSequence,
        }),
        sequence: sequence as LedgerSequence,
        aggregate,
        envelope,
      };
      events.push(event);
      byId.set(event.eventId, event);
      return ok(event);
    },
    readEvents: async () => ok([...events]),
    readEventById: async (eventId) => {
      const found = byId.get(eventId);
      if (found === undefined) {
        return fail(
          domainError(
            'not-found',
            `ledger event ${eventId} not found`,
            [{ code: 'ledger-event-not-found', message: eventId, path: null }],
            {},
          ),
        );
      }
      return ok(found);
    },
  };
}
