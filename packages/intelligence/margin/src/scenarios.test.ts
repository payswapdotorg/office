import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '@office/events';
import {
  CHANGE_EVENT_ID,
  COST_ITEM_2,
  COST_SCENARIO_GOLDEN,
  DOCUMENT_ID,
  DOCUMENT_REVISION_1,
  ENTITLEMENT_SCENARIO_GOLDEN,
  MARGIN_SCENARIO_GOLDEN,
  SCHEDULE_SCENARIO_GOLDEN,
  assessmentShapeOf,
  assessStream,
  buildCostScenario,
  buildEntitlementScenario,
  buildMarginScenario,
  buildScheduleScenario,
  testAssessmentId,
} from './scenarios';
import type { GoldenAssessment } from './scenarios';
import {
  ALL_ASSESSMENT_CAPABILITIES,
  ASSESSED_AT,
  newEventSource,
  projectOneReader,
  projectOneScope,
  unwrap,
  USER_ACTOR,
} from './test-support';
import { ASSESSMENT_REQUIRED_CAPABILITY_NAMES } from './vocabulary';
import {
  ASSESSMENT_ENGINE,
  ASSESSMENT_SCHEMA_VERSION,
  CHANGE_EVENT_KIND,
} from './model';
import type { ImpactAssessment, SourceEventReference } from './model';

// OFF-014 golden construction scenarios — THE named acceptance: each of the
// four goldens (cost, schedule, entitlement, margin) proves its impact
// numbers AND carries the exact SOURCE EVENT IDS that produced every number
// (asserted against the scenario's returned ledger events), and mutating or
// removing a source event changes the assessment — traceability is real,
// not decorative. A4 provenance (source identity, injected timestamps,
// confidence, policy context) rides on every golden too.

const eventIdsOf = (references: readonly SourceEventReference[]): readonly string[] =>
  references.map((reference) => reference.eventId);

const idSetOf = (references: readonly SourceEventReference[]): ReadonlySet<string> =>
  new Set(eventIdsOf(references));

/** The canonical evidence order is (eventName, eventId) — assert it holds. */
const expectCanonicallyOrdered = (assessment: ImpactAssessment): void => {
  const names = assessment.evidence.map((reference) => reference.eventName as string);
  expect([...names]).toStrictEqual([...names].sort());
  for (const reference of assessment.evidence) {
    expect(reference.eventName.length).toBeGreaterThan(0);
  }
};

/** Assert the A4 provenance block of one assessment (shared by all goldens). */
const expectA4Provenance = (assessment: ImpactAssessment): void => {
  // Source identity: the engine, the schema version, the injected identity.
  expect(assessment.engine).toBe(ASSESSMENT_ENGINE);
  expect(assessment.assessmentVersion).toBe(ASSESSMENT_SCHEMA_VERSION);
  expect(assessment.assessmentId).toBe(testAssessmentId(1));
  // Injected clock — never wall time; the requesting actor; the scope.
  expect(assessment.assessedAt).toBe(ASSESSED_AT);
  expect(assessment.actor).toStrictEqual(USER_ACTOR);
  expect(assessment.scope).toStrictEqual(projectOneScope());
  // Policy context (A4): capabilities held, capabilities required, the
  // caller's policy digest, and the allow decision that admitted it.
  expect(assessment.policyContext.capabilities).toStrictEqual(
    [...ALL_ASSESSMENT_CAPABILITIES].sort(),
  );
  expect(assessment.policyContext.requiredCapabilities).toStrictEqual(
    ASSESSMENT_REQUIRED_CAPABILITY_NAMES,
  );
  expect(assessment.policyContext.policyRuleCount).toBe(1);
  expect(assessment.policyContext.decision).toBe('allow');
  // The query the assessment answers round-trips.
  expect(assessment.query.sourceEventId).toBe(assessment.source.eventId);
};

/** Build one scenario stream and assess its change event. */
const runScenarioWith = async (
  build: (source: ReturnType<typeof newEventSource>) => Promise<{
    readonly changeEventRaised: LedgerEvent;
  }>,
): Promise<{ readonly assessment: ImpactAssessment; readonly stream: readonly LedgerEvent[] }> => {
  const source = newEventSource();
  const events = await build(source);
  const stream = unwrap(await source.readEvents());
  const run = await assessStream(stream, {
    changeEventId: CHANGE_EVENT_ID,
    sourceEventId: events.changeEventRaised.eventId,
  });
  return { assessment: run.assessment, stream };
};

/** Re-assess a scenario stream with one event REMOVED (never happened). */
const assessWithout = async (
  stream: readonly LedgerEvent[],
  removed: LedgerEvent,
): Promise<ImpactAssessment> => {
  const filtered = stream.filter((event) => event.eventId !== removed.eventId);
  expect(filtered.length).toBe(stream.length - 1);
  const changeEvent = stream.find(
    (event) => event.envelope.eventName === 'contracts.changeEventRaised',
  );
  if (changeEvent === undefined) throw new Error('scenario stream has no change event');
  const run = await assessStream(filtered, {
    changeEventId: CHANGE_EVENT_ID,
    sourceEventId: changeEvent.eventId,
  });
  return run.assessment;
};

describe('golden cost scenario (OFF-014)', () => {
  it('assesses the golden cost impact with exact source event ids', async () => {
    const source = newEventSource();
    const events = await buildCostScenario(source);
    const { changeOrderApproved } = events;
    if (changeOrderApproved === null) throw new Error('cost scenario approval missing');
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const { assessment } = run;

    // THE golden shape: every impact number, exactly as specified.
    expect(assessmentShapeOf(assessment)).toStrictEqual(COST_SCENARIO_GOLDEN);
    expectCanonicallyOrdered(assessment);
    expectA4Provenance(assessment);
    expect(assessment.confidence).toStrictEqual({ level: 'high', reasons: ['complete-inputs'] });

    // The source summary is the assessed change event itself (A4 source
    // identity): its ledger id, entity, contract, and scope.
    expect(assessment.source.eventId).toBe(events.changeEventRaised.eventId);
    expect(assessment.source.changeEventId).toBe(CHANGE_EVENT_ID);
    expect(assessment.source.occurredAt).toBe(events.changeEventRaised.envelope.occurredAt);
    expect(assessment.source.scope).toStrictEqual(projectOneScope());

    // Every cost number carries its producing event id, exactly:
    // the budget revision delta is the post-change cost item CI2…
    expect(assessment.costImpact.budgetRevisionDeltaMinor).toBe(1500000);
    expect(assessment.costImpact.itemDeltas).toHaveLength(1);
    expect(assessment.costImpact.itemDeltas[0]?.costItemId).toBe(COST_ITEM_2);
    expect(assessment.costImpact.itemDeltas[0]?.source.eventId).toBe(events.costItem2Recorded.eventId);
    expect(assessment.costImpact.itemDeltas[0]?.source.eventName).toBe('cost.costItemRecorded');
    // …anchored by the post-change budget revision BR1…
    expect(assessment.costImpact.revisionAnchors).toHaveLength(1);
    expect(assessment.costImpact.revisionAnchors[0]?.source.eventId).toBe(events.budgetRevised.eventId);
    // …the entitlement is CO1's submission + approval…
    const order = assessment.entitlementImpact.orders[0];
    expect(order?.submissionSource.eventId).toBe(events.changeOrderSubmitted.eventId);
    expect(order?.decisionSource?.eventId).toBe(changeOrderApproved.eventId);
    // …and every margin layer's evidence is its exact producing event set.
    expect(idSetOf(assessment.marginPosition.contractedValue.evidence)).toStrictEqual(
      new Set([
        events.contractCreated.eventId,
        events.changeOrderSubmitted.eventId,
        changeOrderApproved.eventId,
      ]),
    );
    expect(idSetOf(assessment.marginPosition.committedCost.evidence)).toStrictEqual(
      new Set([events.commitmentCreated.eventId]),
    );
    expect(idSetOf(assessment.marginPosition.budgetedCost.evidence)).toStrictEqual(
      new Set([events.costItem1Recorded.eventId, events.budgetRevised.eventId]),
    );
    expect(idSetOf(assessment.marginPosition.projectedCost.evidence)).toStrictEqual(
      new Set([
        events.commitmentCreated.eventId,
        events.costItem2Recorded.eventId,
        events.budgetRevised.eventId,
      ]),
    );

    // The assessment's complete evidence set is exactly the producing
    // events of every number — the traceability spine (A4). The budget's
    // CREATION feeds no number (the layers use items, revisions, and
    // commitments), so it is correctly absent.
    expect(idSetOf(assessment.evidence)).toStrictEqual(
      new Set([
        events.contractCreated.eventId,
        events.costItem1Recorded.eventId,
        events.commitmentCreated.eventId,
        events.changeEventRaised.eventId,
        events.budgetRevised.eventId,
        events.costItem2Recorded.eventId,
        events.changeOrderSubmitted.eventId,
        changeOrderApproved.eventId,
      ]),
    );
    expect(assessment.evidence).toHaveLength(8);
  });

  it('mutating the post-change cost item amount changes the assessment', async () => {
    const source = newEventSource();
    const events = await buildCostScenario(source, { secondItemAmountMinor: 1600000 });
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const shape = assessmentShapeOf(run.assessment);

    // The mutated source event still produces the same evidence id, but
    // every number it feeds moved (traceability survives mutation).
    expect(shape.costImpact.budgetRevisionDeltaMinor).toBe(1600000);
    expect(shape.costImpact.itemDeltas[0]?.amountMinor).toBe(1600000);
    expect(run.assessment.costImpact.itemDeltas[0]?.source.eventId).toBe(
      events.costItem2Recorded.eventId,
    );
    expect(shape.marginPosition.projectedCostMinor).toBe(9600000);
    expect(shape.marginPosition.marginMinor).toBe(7400000);
    expect(shape).not.toStrictEqual(COST_SCENARIO_GOLDEN);
  });

  it('removing the post-change cost item event changes the assessment and its evidence', async () => {
    const { stream } = await runScenarioWith((source) => buildCostScenario(source));
    const costItem2 = stream.find(
      (event) => event.envelope.eventName === 'cost.costItemRecorded' &&
        (event.envelope.payload as Record<string, unknown>)['costItemId'] !== undefined &&
        (event.envelope.payload as Record<string, unknown>)['amountMinor'] === 1500000,
    );
    if (costItem2 === undefined) throw new Error('cost item 2 event not found');

    const without = await assessWithout(stream, costItem2);
    const shape = assessmentShapeOf(without);

    // Removing the source event removed its number AND its evidence id —
    // the assessment no longer references the event that never happened.
    expect(shape.costImpact.budgetRevisionDeltaMinor).toBe(0);
    expect(shape.costImpact.itemDeltas).toStrictEqual([]);
    expect(shape.costImpact.revisionAnchors).toHaveLength(1);
    expect(shape.marginPosition.projectedCostMinor).toBe(8000000);
    expect(shape.marginPosition.marginMinor).toBe(9000000);
    expect(idSetOf(without.evidence).has(costItem2.eventId)).toBe(false);
    expect(shape).not.toStrictEqual(COST_SCENARIO_GOLDEN);
  });

  it('dropping the approval leaves the order pending and changes the margin', async () => {
    const source = newEventSource();
    const events = await buildCostScenario(source, { approval: false });
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const shape = assessmentShapeOf(run.assessment);

    // No approval event → no decision source, no entitlement, pending value
    // in the projected cost, and the confidence drops to medium.
    expect(events.changeOrderApproved).toBeNull();
    expect(run.assessment.entitlementImpact.orders[0]?.decisionSource).toBeNull();
    expect(shape.entitlementImpact.status).toBe('pending');
    expect(shape.entitlementImpact.approvedValueMinor).toBe(0);
    expect(shape.entitlementImpact.pendingValueMinor).toBe(4500000);
    expect(shape.marginPosition.contractedValueMinor).toBe(12500000);
    expect(shape.marginPosition.projectedCostMinor).toBe(14000000);
    expect(shape.marginPosition.marginMinor).toBe(-1500000);
    expect(shape.confidence).toStrictEqual({ level: 'medium', reasons: ['undecided-change-order'] });
    expect(shape).not.toStrictEqual(COST_SCENARIO_GOLDEN);
  });
});

describe('golden schedule scenario (OFF-014)', () => {
  it('assesses the golden forecast deltas with exact source event ids', async () => {
    const source = newEventSource();
    const events = await buildScheduleScenario(source);
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const { assessment } = run;

    expect(assessmentShapeOf(assessment)).toStrictEqual(SCHEDULE_SCENARIO_GOLDEN);
    expectCanonicallyOrdered(assessment);
    expectA4Provenance(assessment);
    expect(assessment.source.eventId).toBe(events.changeEventRaised.eventId);

    // Every schedule delta carries the exact post-change assertions that
    // moved the network: A2's duration update, A3's progress record, and
    // the baseline that anchors the forecast basis.
    expect(assessment.scheduleImpact.activityDeltas).toHaveLength(2);
    const a2 = assessment.scheduleImpact.activityDeltas[0];
    const a3 = assessment.scheduleImpact.activityDeltas[1];
    expect(a2?.drivers.map((driver) => driver.eventId)).toStrictEqual([events.activity2Updated?.eventId]);
    expect(a2?.drivers[0]?.eventName).toBe('schedule.activityUpdated');
    expect(a3?.drivers.map((driver) => driver.eventId)).toStrictEqual([events.activity3Progress?.eventId]);
    expect(a3?.drivers[0]?.eventName).toBe('schedule.progressRecorded');
    expect(assessment.scheduleImpact.basisAnchors.map((anchor) => anchor.eventId)).toStrictEqual([
      events.baselineSet.eventId,
    ]);
    expect(assessment.scheduleImpact.basisAnchors[0]?.eventName).toBe('schedule.baselineSet');

    // The complete evidence set: the change, the contract it amends, the
    // duration update, the progress record, and the baseline.
    expect(idSetOf(assessment.evidence)).toStrictEqual(
      new Set([
        events.contractCreated.eventId,
        events.changeEventRaised.eventId,
        events.activity2Updated?.eventId,
        events.activity3Progress?.eventId,
        events.baselineSet.eventId,
      ]),
    );
    expect(assessment.evidence).toHaveLength(5);
  });

  it('dropping the duration update changes the forecast and the confidence', async () => {
    const source = newEventSource();
    const events = await buildScheduleScenario(source, { durationUpdate: false });
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const shape = assessmentShapeOf(run.assessment);

    expect(events.activity2Updated).toBeNull();
    // Without A2's 4→7 update the project shrinks a day (A3's remaining
    // work governs) and A2 moves nothing — its drivers are empty.
    expect(shape.scheduleImpact.projectDurationDelta).toBe(-1);
    expect(shape.scheduleImpact.currentProjectDuration).toBe(13);
    expect(shape.scheduleImpact.activityDeltas[0]?.earlyFinishDelta).toBe(0);
    expect(shape.scheduleImpact.activityDeltas[1]?.earlyFinishDelta).toBe(-1);
    expect(run.assessment.scheduleImpact.activityDeltas[0]?.drivers).toStrictEqual([]);
    expect(shape.confidence).toStrictEqual({ level: 'medium', reasons: ['unchanged-impacted-activity'] });
    expect(shape).not.toStrictEqual(SCHEDULE_SCENARIO_GOLDEN);
  });

  it('dropping the progress record changes the forecast and the confidence', async () => {
    const source = newEventSource();
    const events = await buildScheduleScenario(source, { progress: false });
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const shape = assessmentShapeOf(run.assessment);

    expect(events.activity3Progress).toBeNull();
    // Without A3's progress the full post-change chain runs to 17 days.
    expect(shape.scheduleImpact.projectDurationDelta).toBe(3);
    expect(shape.scheduleImpact.currentProjectDuration).toBe(17);
    expect(shape.scheduleImpact.activityDeltas[1]?.earlyFinishDelta).toBe(3);
    expect(run.assessment.scheduleImpact.activityDeltas[1]?.drivers).toStrictEqual([]);
    expect(shape.confidence).toStrictEqual({ level: 'medium', reasons: ['unchanged-impacted-activity'] });
    expect(shape).not.toStrictEqual(SCHEDULE_SCENARIO_GOLDEN);
  });

  it('removing the duration update event changes the assessment and its evidence', async () => {
    const { stream } = await runScenarioWith((source) =>
      buildScheduleScenario(source),
    );
    const update = stream.find(
      (event) => event.envelope.eventName === 'schedule.activityUpdated',
    );
    if (update === undefined) throw new Error('activity update event not found');

    const without = await assessWithout(stream, update);
    const shape = assessmentShapeOf(without);

    expect(shape.scheduleImpact.projectDurationDelta).toBe(-1);
    expect(shape).not.toStrictEqual(SCHEDULE_SCENARIO_GOLDEN);
    // The removed event's id vanished from the evidence set and from A2's
    // drivers — traceability tracks removal exactly.
    expect(idSetOf(without.evidence).has(update.eventId)).toBe(false);
    expect(without.scheduleImpact.activityDeltas[0]?.drivers).toStrictEqual([]);
    expect(idSetOf(without.scheduleImpact.evidence).has(update.eventId)).toBe(false);
  });
});

describe('golden entitlement scenario (OFF-014)', () => {
  it('assesses the golden entitlement position with exact source event ids', async () => {
    const source = newEventSource();
    const events = await buildEntitlementScenario(source);
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const { assessment } = run;

    expect(assessmentShapeOf(assessment)).toStrictEqual(ENTITLEMENT_SCENARIO_GOLDEN);
    expectCanonicallyOrdered(assessment);
    expectA4Provenance(assessment);
    expect(assessment.source.eventId).toBe(events.changeEventRaised.eventId);
    // The change event's evidence links survive into the source summary
    // (the document revision the claim references are evidenced by).
    expect(assessment.source.evidenceLinks).toStrictEqual([
      { documentId: DOCUMENT_ID, revisionId: DOCUMENT_REVISION_1 },
    ]);

    // Every order's position carries its submission + decision event ids,
    // and the claim references carry their producing event ids.
    const [order1, order2, order3] = assessment.entitlementImpact.orders;
    expect(order1?.submissionSource.eventId).toBe(events.order1Submitted.eventId);
    expect(order1?.decisionSource?.eventId).toBe(events.order1Approved.eventId);
    expect(order1?.claims).toHaveLength(1);
    expect(order1?.claims[0]?.source.eventId).toBe(events.claimReferenced.eventId);
    expect(order1?.claims[0]?.claimEntityKind).toBe('field-issue');
    expect(order2?.submissionSource.eventId).toBe(events.order2Submitted.eventId);
    expect(order2?.decisionSource?.eventId).toBe(events.order2Rejected.eventId);
    expect(order3?.submissionSource.eventId).toBe(events.order3Submitted.eventId);
    expect(order3?.decisionSource).toBeNull();

    // Complete evidence set: the change, the contract, every submission,
    // both decisions, and the claim reference.
    expect(idSetOf(assessment.evidence)).toStrictEqual(
      new Set([
        events.contractCreated.eventId,
        events.changeEventRaised.eventId,
        events.order1Submitted.eventId,
        events.order1Approved.eventId,
        events.order2Submitted.eventId,
        events.order2Rejected.eventId,
        events.order3Submitted.eventId,
        events.claimReferenced.eventId,
      ]),
    );
    expect(assessment.evidence).toHaveLength(8);
    // Skipped documents events contributed no commercial fact — the fold's
    // skip tally proves no data was invented.
    expect(run.facts.derivation.skippedEventNames).toStrictEqual([
      { eventName: 'documents.documentRegistered', count: 1 },
      { eventName: 'documents.revisionAttached', count: 1 },
    ]);
  });

  it('removing the rejection changes the entitlement position and its evidence', async () => {
    const { stream } = await runScenarioWith((source) =>
      buildEntitlementScenario(source),
    );
    const rejection = stream.find(
      (event) => event.envelope.eventName === 'contracts.changeOrderRejected',
    );
    if (rejection === undefined) throw new Error('rejection event not found');

    const without = await assessWithout(stream, rejection);
    const shape = assessmentShapeOf(without);

    // CO2 never decided: its value moves from rejected to pending, the
    // projected cost grows, and the rejection's evidence id vanishes.
    expect(shape.entitlementImpact.rejectedValueMinor).toBe(0);
    expect(shape.entitlementImpact.pendingValueMinor).toBe(3000000);
    expect(shape.entitlementImpact.orders[1]?.status).toBe('submitted');
    expect(shape.marginPosition.projectedCostMinor).toBe(3000000);
    expect(shape.marginPosition.marginMinor).toBe(14000000);
    expect(idSetOf(without.evidence).has(rejection.eventId)).toBe(false);
    expect(without.entitlementImpact.orders[1]?.decisionSource).toBeNull();
    expect(shape).not.toStrictEqual(ENTITLEMENT_SCENARIO_GOLDEN);
  });
});

describe('golden margin scenario (OFF-014)', () => {
  it('assesses the golden margin aggregation with evidence at every layer', async () => {
    const source = newEventSource();
    const events = await buildMarginScenario(source);
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const { assessment } = run;

    expect(assessmentShapeOf(assessment)).toStrictEqual(MARGIN_SCENARIO_GOLDEN);
    expectCanonicallyOrdered(assessment);
    expectA4Provenance(assessment);
    expect(assessment.source.eventId).toBe(events.changeEventRaised.eventId);

    // Margin aggregation with evidence refs at each layer: contracted
    // (contract + approved order), committed (latest commitment
    // assertions — the amendment superseded CM1's creation), budgeted (the
    // revision basis), projected (committed + post-change item + nothing
    // pending).
    expect(idSetOf(assessment.marginPosition.contractedValue.evidence)).toStrictEqual(
      new Set([
        events.contractCreated.eventId,
        events.changeOrderSubmitted.eventId,
        events.changeOrderApproved.eventId,
      ]),
    );
    expect(idSetOf(assessment.marginPosition.committedCost.evidence)).toStrictEqual(
      new Set([events.commitment1Amended?.eventId, events.commitment2Created.eventId]),
    );
    expect(idSetOf(assessment.marginPosition.budgetedCost.evidence)).toStrictEqual(
      new Set([events.costItem1Recorded.eventId, events.budgetRevised.eventId]),
    );
    expect(idSetOf(assessment.marginPosition.projectedCost.evidence)).toStrictEqual(
      new Set([
        events.commitment1Amended?.eventId,
        events.commitment2Created.eventId,
        events.costItem2Recorded.eventId,
        events.budgetRevised.eventId,
      ]),
    );

    // The invoice event was skipped by the fold — it is in NO layer's
    // evidence (committed cost is the latest commitment assertions — the
    // amendment superseded CM1's creation — never invoices).
    expect(idSetOf(assessment.evidence).has(events.invoiceRecorded.eventId)).toBe(false);
    expect(idSetOf(assessment.evidence)).toStrictEqual(
      new Set([
        events.contractCreated.eventId,
        events.costItem1Recorded.eventId,
        events.commitment1Amended?.eventId,
        events.commitment2Created.eventId,
        events.changeEventRaised.eventId,
        events.budgetRevised.eventId,
        events.costItem2Recorded.eventId,
        events.changeOrderSubmitted.eventId,
        events.changeOrderApproved.eventId,
      ]),
    );
    expect(assessment.evidence).toHaveLength(9);
  });

  it('dropping the commitment amendment changes the committed layer and its evidence', async () => {
    const source = newEventSource();
    const events = await buildMarginScenario(source, { amendment: false });
    const run = await assessStream(unwrap(await source.readEvents()), {
      changeEventId: CHANGE_EVENT_ID,
      sourceEventId: events.changeEventRaised.eventId,
    });
    const shape = assessmentShapeOf(run.assessment);

    // No amendment → CM1 stays at its created amount: the committed layer
    // (and the margin) move, and the layer's evidence references CM1's
    // CREATION event instead of the amendment.
    expect(events.commitment1Amended).toBeNull();
    expect(shape.marginPosition.committedCostMinor).toBe(6500000);
    expect(shape.marginPosition.projectedCostMinor).toBe(8000000);
    expect(shape.marginPosition.marginMinor).toBe(9000000);
    expect(shape.marginPosition.marginOverCommittedMinor).toBe(10500000);
    expect(idSetOf(run.assessment.marginPosition.committedCost.evidence)).toStrictEqual(
      new Set([events.commitment1Created.eventId, events.commitment2Created.eventId]),
    );
    expect(shape).not.toStrictEqual(MARGIN_SCENARIO_GOLDEN);
  });

  it('removing the amendment event changes the assessment and its evidence', async () => {
    const { stream } = await runScenarioWith((source) => buildMarginScenario(source));
    const amendment = stream.find(
      (event) => event.envelope.eventName === 'cost.commitmentAmended',
    );
    if (amendment === undefined) throw new Error('amendment event not found');

    const without = await assessWithout(stream, amendment);
    const shape = assessmentShapeOf(without);

    expect(shape.marginPosition.committedCostMinor).toBe(6500000);
    expect(shape.marginPosition.marginMinor).toBe(9000000);
    expect(idSetOf(without.evidence).has(amendment.eventId)).toBe(false);
    expect(idSetOf(without.marginPosition.committedCost.evidence).has(amendment.eventId)).toBe(false);
    expect(shape).not.toStrictEqual(MARGIN_SCENARIO_GOLDEN);
  });
});

// The four goldens are DISTINCT scenarios (different numbers everywhere) —
// a cheap guard that the fixtures themselves stay meaningful.
describe('golden scenarios are distinct', () => {
  const goldens: readonly [string, GoldenAssessment][] = [
    ['cost', COST_SCENARIO_GOLDEN],
    ['schedule', SCHEDULE_SCENARIO_GOLDEN],
    ['entitlement', ENTITLEMENT_SCENARIO_GOLDEN],
    ['margin', MARGIN_SCENARIO_GOLDEN],
  ];
  for (const [name, golden] of goldens) {
    it(`the ${name} golden is a distinct assessment`, () => {
      for (const [otherName, other] of goldens) {
        if (otherName === name) continue;
        expect(golden).not.toStrictEqual(other);
      }
    });
  }
  it('keeps the change event kind constant the assessment vocabulary uses', () => {
    expect(CHANGE_EVENT_KIND).toBe('change-event');
    expect(projectOneReader().context.capabilities.length).toBeGreaterThan(0);
  });
});
