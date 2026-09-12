import { describe, expect, it } from 'vitest';
import { isLedgerEventId } from '@office/events';
import { causalChainOfRelationship, causalChainsOf } from './causality';
import { projectRelationships } from './projection';
import { createInMemoryEventSource } from './source';
import {
  ACTIVITY_2,
  ACTIVITY_3,
  CHANGE_EVENT_EVIDENCE_CAUSAL_CHAIN_GOLDEN,
  DOCUMENT_ID,
  REVISION_2,
  activityRef,
  buildChangeEventChainStream,
  buildScheduleDependencyChainStream,
  changeEventRef,
  revisionRef,
} from './fixtures';
import {
  PROJECT_1,
  TENANT_B,
  projectScopeOf,
  tenantScopeOf,
  testCorrelationId,
  testKey,
  traversalAuthorizationOf,
  unwrap,
} from './test-support';

// OFF-013 causal-chain queries — provenance and causation reconstruction:
// every relationship edge carries its producing event's ledger id, and the
// causal-chain queries walk BACKWARD from an edge through the ledger's
// causality convention (an event's causation id is the causing COMMAND's
// idempotency key at chain roots, or the ledger id of a PRIOR EVENT) — the
// golden change-event chain reconstructs command -> revision supersession ->
// change event. Every step is authorization-filtered: an invisible causing
// event terminates the chain without leaking its existence.

const reader = traversalAuthorizationOf(projectScopeOf(PROJECT_1));

describe('causal-chain queries (OFF-013)', () => {
  it('reconstructs the golden causal chain of the change-event evidence relationship', async () => {
    const source = createInMemoryEventSource();
    const { revisionSuperseded, changeEventRaised } = await buildChangeEventChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const evidencedBy = index
      .relationshipsOf(changeEventRef())
      .find((edge) => edge.kind === 'evidenced-by' && edge.to.entityId === REVISION_2);
    expect(evidencedBy).toBeDefined();
    if (evidencedBy === undefined) return;

    const chain = await causalChainOfRelationship(evidencedBy, source, reader);
    expect(chain.ok).toBe(true);
    if (chain.ok) {
      expect(chain.value.relationship).toStrictEqual(evidencedBy);
      // Golden: command root -> revision supersession -> change event raised
      // (the change event was raised AS A REACTION to the supersession).
      expect(
        chain.value.steps.map((step) =>
          step.kind === 'command'
            ? { kind: step.kind, idempotencyKey: step.idempotencyKey }
            : { kind: step.kind, eventName: step.eventName },
        ),
      ).toStrictEqual(CHANGE_EVENT_EVIDENCE_CAUSAL_CHAIN_GOLDEN);

      const [root, superseded, raised] = chain.value.steps;
      expect(root?.kind).toBe('command');
      if (root?.kind === 'command') {
        expect(root.idempotencyKey).toBe(testKey(3));
        expect(root.correlationId).toBe(testCorrelationId(3));
      }
      expect(superseded?.kind).toBe('event');
      if (superseded?.kind === 'event') {
        expect(superseded.eventId).toBe(revisionSuperseded.eventId);
        expect(superseded.eventName).toBe('documents.revisionSuperseded');
        expect(superseded.causationId).toBe(testKey(3));
      }
      expect(raised?.kind).toBe('event');
      if (raised?.kind === 'event') {
        // The producing event ends the chain, caused by the prior event's
        // ledger id, on the SAME correlation chain.
        expect(raised.eventId).toBe(changeEventRaised.eventId);
        expect(raised.eventName).toBe('contracts.changeEventRaised');
        expect(raised.causationId).toBe(revisionSuperseded.eventId);
        expect(raised.correlationId).toBe(testCorrelationId(3));
      }
    }
  });

  it('reconstructs a command-rooted chain for a command-caused relationship', async () => {
    const source = createInMemoryEventSource();
    const { dependencyA3OnA2 } = await buildScheduleDependencyChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const dependsOn = index.relationships.find(
      (edge) => edge.from.entityId === ACTIVITY_3 && edge.to.entityId === ACTIVITY_2,
    );
    expect(dependsOn).toBeDefined();
    if (dependsOn === undefined) return;

    const chain = await causalChainOfRelationship(dependsOn, source, reader);
    expect(chain.ok).toBe(true);
    if (chain.ok) {
      expect(chain.value.steps).toHaveLength(2);
      const [root, produced] = chain.value.steps;
      expect(root?.kind).toBe('command');
      if (root?.kind === 'command') expect(root.idempotencyKey).toBe(testKey(6));
      expect(produced?.kind).toBe('event');
      if (produced?.kind === 'event') {
        expect(produced.eventId).toBe(dependencyA3OnA2.eventId);
        expect(produced.eventName).toBe('schedule.dependencyAdded');
        expect(produced.causationId).toBe(testKey(6));
      }
    }
  });

  it('reconstructs one chain per visible incident relationship, each ending at its producing event', async () => {
    const source = createInMemoryEventSource();
    await buildChangeEventChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const chains = await causalChainsOf(index, source, changeEventRef(), reader);
    expect(chains.ok).toBe(true);
    if (chains.ok) {
      expect(chains.value.entity).toStrictEqual(changeEventRef());
      expect(chains.value.chains.map((chain) => chain.relationship.kind)).toStrictEqual([
        'affects',
        'derives-from',
        'evidenced-by',
        'impacts',
        'impacts',
        'impacts',
        'impacts',
      ]);
      for (const chain of chains.value.chains) {
        // Root-first ordering: every chain in these streams roots at a command.
        expect(chain.steps[0]?.kind).toBe('command');
        // The producing event ends the chain — the edge's provenance is the
        // last link, carrying the same ledger event id.
        const last = chain.steps[chain.steps.length - 1];
        expect(last?.kind).toBe('event');
        if (last?.kind === 'event') {
          expect(last.eventId).toBe(chain.relationship.provenance.eventId);
        }
      }
    }
  });

  it('carries the producing event id on every relationship edge', async () => {
    const source = createInMemoryEventSource();
    await buildChangeEventChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    expect(index.relationships).toHaveLength(13);
    for (const edge of index.relationships) {
      expect(isLedgerEventId(edge.provenance.eventId)).toBe(true);
      const producing = unwrap(await source.readEventById(edge.provenance.eventId));
      expect(producing.envelope.eventName).toBe(edge.provenance.eventName);
      expect(producing.aggregate).toStrictEqual(edge.provenance.aggregate);
      expect(producing.sequence).toBe(edge.provenance.sequence);
      expect(producing.envelope.causality.correlationId).toBe(edge.provenance.correlationId);
      expect(producing.envelope.causality.causationId).toBe(edge.provenance.causationId);
      expect(producing.envelope.occurredAt).toBe(edge.provenance.occurredAt);
    }
  });

  it('terminates reaction chains at the earliest visible link (no existence oracle)', async () => {
    const source = createInMemoryEventSource();
    await buildChangeEventChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    // A contracts-only reader: every incident relationship of the change
    // event was produced by a CONTRACT-aggregate event, so all chains stay
    // visible — but the reaction-caused ones cannot walk back past the
    // invisible document event, and never leak that it exists.
    const contractsOnlyReader = traversalAuthorizationOf(projectScopeOf(PROJECT_1), {
      capabilities: ['contracts.read'],
    });
    const chains = await causalChainsOf(index, source, changeEventRef(), contractsOnlyReader);
    expect(chains.ok).toBe(true);
    if (chains.ok) {
      expect(chains.value.chains).toHaveLength(7);
      for (const chain of chains.value.chains) {
        if (chain.relationship.provenance.eventName === 'contracts.changeOrderSubmitted') {
          // Command-caused: full chain (command root + producing event).
          expect(chain.steps).toHaveLength(2);
          expect(chain.steps[0]?.kind).toBe('command');
        } else {
          // Reaction-caused (contracts.changeEventRaised): the chain ends at
          // the earliest VISIBLE link — the document supersession event and
          // its command are absent, without leaking their existence.
          expect(chain.steps).toHaveLength(1);
          const only = chain.steps[0];
          expect(only?.kind).toBe('event');
          if (only?.kind === 'event') {
            expect(only.eventName).toBe('contracts.changeEventRaised');
            expect(only.causationId).not.toBeNull();
          }
        }
      }
    }

    // The same reader asking for the chain behind a DOCUMENT-aggregate
    // relationship gets a typed not-found: the producing event is invisible.
    const revisionEdge = index
      .relationshipsOf(revisionRef(REVISION_2))
      .find((edge) => edge.kind === 'derives-from' && edge.to.entityId === DOCUMENT_ID);
    expect(revisionEdge).toBeDefined();
    if (revisionEdge !== undefined) {
      const chain = await causalChainOfRelationship(revisionEdge, source, contractsOnlyReader);
      expect(chain.ok).toBe(false);
      if (!chain.ok) {
        expect(chain.error.code).toBe('not-found');
        expect(chain.error.details[0]?.code).toBe('entity-not-found');
      }
    }
  });

  it('answers a typed not-found for a cross-scope entity (A12)', async () => {
    const source = createInMemoryEventSource();
    await buildChangeEventChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const tenantBReader = traversalAuthorizationOf(tenantScopeOf(TENANT_B));
    const result = await causalChainsOf(index, source, activityRef(ACTIVITY_3), tenantBReader);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('entity-not-found');
    }
  });
});
