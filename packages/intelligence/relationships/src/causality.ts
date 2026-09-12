// Office intelligence — causal-chain queries (OFF-013).
//
// For one entity (or one explicit relationship), reconstruct the chain of
// commands and events that produced its current relationships, walking
// BACKWARD from each edge's provenance event through the ledger's causality
// convention (freeze A3): an event's causation id is either the COMMAND's
// idempotency key (causedByCommand — the chain root) or the ledger id of a
// PRIOR EVENT (causedByEvent — keep walking). Every returned step is
// authorization-filtered (checkEventReadable): an unreadable or absent
// causing event terminates the chain without leaking its existence — the
// chain contains exactly what the caller may see, ordered root-first, with
// the edge's producing event last.
//
// Deterministic: chains are emitted in canonical relationship order, steps
// in strict causation order, and a visited-set guards causal cycles.
import { entityNotFound, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { CausationId, EntityRef } from '@office/contracts';
import { isLedgerEventId } from '@office/events';
import type { LedgerEvent } from '@office/events';
import type {
  CausalChainStep,
  EntityCausalChains,
  Relationship,
  RelationshipCausalChain,
  RelationshipIndex,
} from './model';
import { checkEventReadable, checkNodeReadable } from './authorization';
import type { TraversalAuthorization } from './authorization';
import type { RelationshipEventSource } from './source';

const eventStepOf = (event: LedgerEvent): CausalChainStep => ({
  kind: 'event',
  eventId: event.eventId,
  eventName: event.envelope.eventName,
  aggregate: event.aggregate,
  sequence: event.sequence,
  actor: event.envelope.actor,
  occurredAt: event.envelope.occurredAt,
  correlationId: event.envelope.causality.correlationId,
  causationId: event.envelope.causality.causationId,
});

/**
 * Reconstruct the causal chain of ONE relationship: the command(s)/event(s)
 * that produced it, root first, producing event last. The relationship
 * itself must be visible to the caller (its producing event passes
 * checkEventReadable); steps backward from an unreadable or absent cause
 * stop there — no existence oracle.
 */
export async function causalChainOfRelationship(
  relationship: Relationship,
  source: RelationshipEventSource,
  authorization: TraversalAuthorization,
): Promise<Result<RelationshipCausalChain, DomainError>> {
  // The producing event must itself be readable for the chain to exist.
  const producing = await source.readEventById(relationship.provenance.eventId);
  if (!producing.ok) return producing;
  if (!checkEventReadable(authorization, producing.value).ok) {
    return fail(
      entityNotFound(
        {
          entityKind: relationship.provenance.aggregate.entityKind,
          entityId: relationship.provenance.aggregate.entityId,
        },
        { scope: authorization.context.scope },
      ),
    );
  }

  const steps: CausalChainStep[] = [];
  const seen = new Set<string>();
  let cursor: LedgerEvent | null = producing.value;
  while (cursor !== null) {
    steps.unshift(eventStepOf(cursor));
    seen.add(cursor.eventId);
    const cause: CausationId | null = cursor.envelope.causality.causationId;
    if (cause === null) {
      cursor = null;
      break;
    }
    if (!isLedgerEventId(cause)) {
      // Not ledger-event-shaped: the causation token is a COMMAND's
      // idempotency key — the chain root.
      steps.unshift({
        kind: 'command',
        idempotencyKey: cause,
        correlationId: cursor.envelope.causality.correlationId,
      });
      cursor = null;
      break;
    }
    const prior = await source.readEventById(cause);
    if (!prior.ok) {
      // A ledger-event-shaped causation id that the source cannot produce:
      // the causing event is absent from the projected stream — the chain
      // ends at this event without claiming a command caused it.
      cursor = null;
      break;
    }
    if (seen.has(prior.value.eventId)) {
      // A causal cycle (the prior event is already on the chain): stop —
      // deterministic termination, no invention.
      cursor = null;
      break;
    }
    if (!checkEventReadable(authorization, prior.value).ok) {
      // The causing event exists but is invisible to this caller: the
      // chain ends at the earliest VISIBLE link (no existence oracle).
      cursor = null;
      break;
    }
    cursor = prior.value;
  }

  return ok({ relationship, steps });
}

/**
 * Reconstruct the causal chains behind one entity's CURRENT relationships:
 * one chain per incident relationship that is visible to the caller (its
 * producing event passes checkEventReadable), in canonical relationship
 * order. Cross-scope relationships are absent — the entity itself must be
 * readable (same start-node discipline as traversal: scope-uncovered is a
 * typed not-found, capability/policy denials are the typed error).
 */
export async function causalChainsOf(
  index: RelationshipIndex,
  source: RelationshipEventSource,
  entity: EntityRef,
  authorization: TraversalAuthorization,
): Promise<Result<EntityCausalChains, DomainError>> {
  const startNode = index.entityNodeOf(entity);
  if (startNode === null) {
    return fail(
      entityNotFound(
        { entityKind: entity.entityKind, entityId: entity.entityId },
        { scope: authorization.context.scope },
      ),
    );
  }
  const startCheck = checkNodeReadable(authorization, startNode);
  if (!startCheck.ok) {
    if (startCheck.error.code === 'unauthorized') {
      return fail(
        entityNotFound(
          { entityKind: entity.entityKind, entityId: entity.entityId },
          { scope: authorization.context.scope },
        ),
      );
    }
    return fail(startCheck.error);
  }

  const chains: RelationshipCausalChain[] = [];
  for (const relationship of index.relationshipsOf(entity)) {
    // The relationship's producing event decides visibility: its aggregate
    // must be readable under the event's own scope (the edge carries both).
    const eventNode = {
      entity: relationship.provenance.aggregate,
      scope: relationship.scope,
    };
    if (!checkNodeReadable(authorization, eventNode).ok) continue;
    const chain = await causalChainOfRelationship(relationship, source, authorization);
    if (chain.ok) chains.push(chain.value);
  }

  return ok({ entity, chains } satisfies EntityCausalChains);
}
