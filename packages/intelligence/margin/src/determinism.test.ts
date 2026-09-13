import { describe, expect, it } from 'vitest';
import { projectRelationships, traverseRelationships } from '@office/intelligence-relationships';
import type { LedgerEvent } from '@office/events';
import {
  CHANGE_EVENT_ID,
  assessmentShapeOf,
  buildCostScenario,
  buildMarginScenario,
  buildScheduleScenario,
  testAssessmentId,
} from './scenarios';
import { calculateImpact } from './calculation';
import { projectCommercialFacts } from './facts';
import { CHANGE_EVENT_KIND } from './model';
import { ASSESSED_AT, newEventSource, projectOneReader, unwrap } from './test-support';
import { ASSESSMENT_SCHEMA_VERSION, ASSESSMENT_ENGINE } from './model';

// OFF-014 determinism — THE named acceptance: calculateImpact run twice on
// identical inputs produces IDENTICAL assessments (byte-identical JSON),
// and shuffled input ordering produces identical assessments too — the
// subgraph's edge/node arrays handed over in reverse order, and the ledger
// stream rebuilt with the same events appended in a different (valid)
// global order that preserves each aggregate's chain and the change-event
// boundary. No clock, no randomness, no environment: the injected
// assessment identity and clock are the only identity inputs.

/** Build the calculation inputs of the margin scenario stream. */
const marginInputs = async () => {
  const source = newEventSource();
  await buildMarginScenario(source);
  const stream = unwrap(await source.readEvents());
  const index = unwrap(projectRelationships(stream));
  const reader = projectOneReader();
  const subgraph = unwrap(
    traverseRelationships(
      index,
      { start: { entityKind: CHANGE_EVENT_KIND, entityId: CHANGE_EVENT_ID }, maxDepth: 2 },
      { policy: reader.policy, context: reader.context },
    ),
  );
  const facts = unwrap(projectCommercialFacts(stream));
  return { stream, subgraph, facts };
};

const assess = (inputs: Awaited<ReturnType<typeof marginInputs>>) =>
  calculateImpact(
    { sourceEventId: changeEventIdOf(inputs.stream) },
    { facts: inputs.facts, subgraph: inputs.subgraph },
    projectOneReader(),
    { assessmentId: testAssessmentId(1), assessedAt: ASSESSED_AT },
  );

const changeEventIdOf = (stream: readonly LedgerEvent[]): LedgerEvent['eventId'] => {
  const changeEvent = stream.find(
    (event) => event.envelope.eventName === 'contracts.changeEventRaised',
  );
  if (changeEvent === undefined) throw new Error('stream has no change event');
  return changeEvent.eventId;
};

const comparableOf = (assessment: unknown): string => JSON.stringify(assessment);

describe('calculateImpact determinism (OFF-014)', () => {
  it('run twice on identical inputs produces identical assessments', async () => {
    const inputs = await marginInputs();

    const first = assess(inputs);
    const second = assess(inputs);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toStrictEqual(first.value);
      expect(comparableOf(second.value)).toBe(comparableOf(first.value));
      // The injected identity parts are echoed exactly — nothing else in
      // the assessment carries run identity.
      expect(first.value.assessmentId).toBe(testAssessmentId(1));
      expect(first.value.assessedAt).toBe(ASSESSED_AT);
      expect(first.value.engine).toBe(ASSESSMENT_ENGINE);
      expect(first.value.assessmentVersion).toBe(ASSESSMENT_SCHEMA_VERSION);
    }
  });

  it('shuffled subgraph edge/node ordering produces the identical assessment', async () => {
    const source = newEventSource();
    await buildCostScenario(source);
    const stream = unwrap(await source.readEvents());
    const index = unwrap(projectRelationships(stream));
    const reader = projectOneReader();
    const subgraph = unwrap(
      traverseRelationships(
        index,
        { start: { entityKind: CHANGE_EVENT_KIND, entityId: CHANGE_EVENT_ID }, maxDepth: 2 },
        { policy: reader.policy, context: reader.context },
      ),
    );
    const facts = unwrap(projectCommercialFacts(stream));

    // The caller hands the SAME subgraph over with its edge and node arrays
    // reversed (any internal ordering is the caller's business): the
    // calculation must not depend on it.
    const reversed = {
      ...subgraph,
      edges: [...subgraph.edges].reverse(),
      nodes: [...subgraph.nodes].reverse(),
    };
    expect(reversed.edges[0]).not.toBe(subgraph.edges[0]);

    const sourceEventId = changeEventIdOf(stream);
    const baseline = calculateImpact(
      { sourceEventId },
      { facts, subgraph },
      projectOneReader(),
      { assessmentId: testAssessmentId(1), assessedAt: ASSESSED_AT },
    );
    const shuffled = calculateImpact(
      { sourceEventId },
      { facts, subgraph: reversed },
      projectOneReader(),
      { assessmentId: testAssessmentId(1), assessedAt: ASSESSED_AT },
    );

    expect(baseline.ok).toBe(true);
    expect(shuffled.ok).toBe(true);
    if (baseline.ok && shuffled.ok) {
      expect(assessmentShapeOf(shuffled.value)).toStrictEqual(assessmentShapeOf(baseline.value));
      expect(comparableOf(shuffled.value)).toBe(comparableOf(baseline.value));
    }
  });

  it('shuffled ledger stream ordering (chain-preserving) produces the identical assessment', async () => {
    // Stream A: the margin scenario in its canonical append order.
    const sourceA = newEventSource();
    await buildMarginScenario(sourceA);
    const streamA = unwrap(await sourceA.readEvents());

    // Stream B: the SAME envelopes, appended in a different global order
    // that preserves every aggregate's own event chain (contract, budget,
    // commitment CM1) and the pre/post-change boundary around the change
    // event — a valid alternative arrival order of the same history.
    // Canonical positions: 0 contract, 1 budget, 2 item1, 3 cm1-created,
    // 4 cm1-amended, 5 cm2-created, 6 CHANGE EVENT, 7 revision, 8 item2,
    // 9 order-submitted, 10 order-approved, 11 invoice.
    const shuffle = [5, 1, 3, 2, 0, 4, 6, 11, 7, 9, 8, 10];
    const sourceB = newEventSource();
    for (const position of shuffle) {
      unwrap(await sourceB.append(streamA[position]!.envelope, streamA[position]!.aggregate));
    }
    const streamB = unwrap(await sourceB.readEvents());
    expect(streamB).toHaveLength(streamA.length);

    const runOf = async (stream: readonly LedgerEvent[]) => {
      const index = unwrap(projectRelationships(stream));
      const reader = projectOneReader();
      const subgraph = unwrap(
        traverseRelationships(
          index,
          { start: { entityKind: CHANGE_EVENT_KIND, entityId: CHANGE_EVENT_ID }, maxDepth: 2 },
          { policy: reader.policy, context: reader.context },
        ),
      );
      const facts = unwrap(projectCommercialFacts(stream));
      return unwrap(
        calculateImpact(
          { sourceEventId: changeEventIdOf(stream) },
          { facts, subgraph },
          projectOneReader(),
          { assessmentId: testAssessmentId(1), assessedAt: ASSESSED_AT },
        ),
      );
    };

    const assessmentA = await runOf(streamA);
    const assessmentB = await runOf(streamB);

    // Identical assessments — including every source event id (the ledger
    // ids are content-derived, so the same history carries the same ids
    // whatever valid order it arrives in).
    expect(comparableOf(assessmentB)).toBe(comparableOf(assessmentA));
    expect(assessmentB.evidence).toStrictEqual(assessmentA.evidence);
    expect(assessmentB.consumed.projectedEventCount).toBe(assessmentA.consumed.projectedEventCount);
  });

  it('the commercial facts fold is deterministic and rebuildable', async () => {
    const source = newEventSource();
    await buildScheduleScenario(source);
    const stream = unwrap(await source.readEvents());

    const first = unwrap(projectCommercialFacts(stream));
    const second = unwrap(projectCommercialFacts(stream));
    // Rebuilt from the same stream: identical facts (data parts; the lookup
    // helpers are functions and asserted behaviorally below).
    const dataOf = (facts: typeof first) => ({
      derivation: facts.derivation,
      contracts: facts.contracts,
      changeEvents: facts.changeEvents,
      changeOrders: facts.changeOrders,
      claimReferences: facts.claimReferences,
      budgets: facts.budgets,
      costItems: facts.costItems,
      budgetRevisions: facts.budgetRevisions,
      commitments: facts.commitments,
      activities: facts.activities,
      dependencies: facts.dependencies,
      baselines: facts.baselines,
    });
    expect(dataOf(second)).toStrictEqual(dataOf(first));
    expect(comparableOf(dataOf(second))).toBe(comparableOf(dataOf(first)));
    // The lookup helpers agree across rebuilds.
    expect(second.changeEventByLedgerId(changeEventIdOf(stream))).toStrictEqual(
      first.changeEventByLedgerId(changeEventIdOf(stream)),
    );
    expect(second.activities).toStrictEqual(first.activities);

    // A FRESH source with the same append sequence rebuilds the same facts
    // (A7: derived, rebuildable, never a second source of truth).
    const fresh = newEventSource();
    await buildScheduleScenario(fresh);
    const rebuilt = unwrap(projectCommercialFacts(unwrap(await fresh.readEvents())));
    expect(dataOf(rebuilt)).toStrictEqual(dataOf(first));
  });
});
