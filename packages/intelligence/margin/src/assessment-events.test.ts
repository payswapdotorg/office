import { describe, expect, it } from 'vitest';
import { isDomainEventEnvelope } from '@office/contracts';
import { CURRENT_SCHEMA_VERSION } from '@office/contracts';
import { buildCostScenario } from './scenarios';
import { assessStream } from './scenarios';
import { CHANGE_EVENT_ID } from './scenarios';
import {
  createInMemoryAssessmentEventSink,
  emitMarginAssessment,
  failingAssessmentEventSink,
  marginAssessmentEnvelope,
} from './assessment-events';
import { MARGIN_ASSESSED_EVENT } from './vocabulary';
import { newEventSource, projectOneScope, unwrap, USER_ACTOR } from './test-support';
import type { ImpactAssessment } from './model';
import type { AssessmentSinkExecutor } from './assessment-events';

// OFF-014 assessment events — every assessment emits exactly ONE
// DomainEventEnvelope through the AssessmentEventSink port (the mirrored
// landed EventSink shape: appendEvents(executor, events) inside the
// caller's transaction, a failure aborting the surrounding write). The
// envelope carries the A3/A4 spine: caused by the source change event
// (causation id = its ledger id, correlation carried over), produced by the
// requesting actor under the 'system' source, and the full JSON-safe
// assessment summary whose every number keeps its source event ids.

const costAssessment = async (): Promise<{
  readonly assessment: ImpactAssessment;
  readonly events: Awaited<ReturnType<typeof buildCostScenario>>;
}> => {
  const source = newEventSource();
  const events = await buildCostScenario(source);
  const run = await assessStream(unwrap(await source.readEvents()), {
    changeEventId: CHANGE_EVENT_ID,
    sourceEventId: events.changeEventRaised.eventId,
  });
  return { assessment: run.assessment, events };
};

/** The no-op executor a test hands the sink (the caller's transaction). */
const testExecutor: AssessmentSinkExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

describe('the marginAssessed envelope (OFF-014)', () => {
  it('builds one canonical intelligence.marginAssessed envelope per assessment', async () => {
    const { assessment, events } = await costAssessment();
    const envelope = marginAssessmentEnvelope(assessment);

    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('envelope build failed');
    const value = envelope.value;

    // It IS a canonical domain event envelope — downstream consumers
    // (OFF-015 memory, OFF-018 recommendations) consume it like any other.
    expect(isDomainEventEnvelope(value)).toBe(true);
    expect(value.kind).toBe('event');
    expect(value.eventName).toBe(MARGIN_ASSESSED_EVENT);
    expect(value.eventName).toBe('intelligence.marginAssessed');
    expect(value.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(value.source).toBe('system');
    expect(value.actor).toStrictEqual(USER_ACTOR);
    expect(value.scope).toStrictEqual(projectOneScope());
    expect(value.occurredAt).toBe(assessment.assessedAt);

    // Causality (A3): the assessment is CAUSED BY the source change event —
    // its ledger id is the causation id; the change's correlation rides on.
    expect(value.causality.causationId).toBe(events.changeEventRaised.eventId);
    expect(value.causality.correlationId).toBe(
      events.changeEventRaised.envelope.causality.correlationId,
    );

    // The entity refs point at the assessed change event (before null,
    // after the change event — a read-side assessment creates nothing).
    expect(value.entityRefs.before).toBeNull();
    expect(value.entityRefs.after).toStrictEqual({
      entityKind: 'change-event',
      entityId: CHANGE_EVENT_ID,
    });

    // The payload is the JSON-safe assessment summary with the traceability
    // spine intact: identity, source event id, per-number source event ids,
    // and the complete evidence event id set.
    const payload = value.payload as Record<string, unknown>;
    expect(payload['assessmentId']).toBe(assessment.assessmentId);
    expect(payload['assessmentVersion']).toBe(assessment.assessmentVersion);
    expect(payload['engine']).toBe(assessment.engine);
    expect(payload['sourceEventId']).toBe(events.changeEventRaised.eventId);
    expect(payload['changeEventId']).toBe(CHANGE_EVENT_ID);
    expect(payload['evidenceEventIds']).toStrictEqual(
      assessment.evidence.map((reference) => reference.eventId),
    );
    const costImpact = payload['costImpact'] as Record<string, unknown>;
    const itemDeltas = costImpact['itemDeltas'] as readonly Record<string, unknown>[];
    expect(itemDeltas[0]?.['sourceEventId']).toBe(events.costItem2Recorded.eventId);
    const margin = payload['margin'] as Record<string, unknown>;
    expect(margin['marginMinor']).toBe(assessment.marginPosition.marginMinor);
    const layerEvidence = margin['layerEvidenceEventIds'] as Record<string, unknown>;
    expect(layerEvidence['committedCost']).toStrictEqual(
      assessment.marginPosition.committedCost.evidence.map((reference) => reference.eventId),
    );
    const entitlement = payload['entitlement'] as Record<string, unknown>;
    expect(entitlement['status']).toBe(assessment.entitlementImpact.status);
    const policyContext = payload['policyContext'] as Record<string, unknown>;
    expect(policyContext['decision']).toBe('allow');
  });
});

describe('the AssessmentEventSink port (OFF-014)', () => {
  it('emits one assessment as one append inside the caller\u2019s transaction', async () => {
    const { assessment } = await costAssessment();
    const sink = createInMemoryAssessmentEventSink();

    const result = await emitMarginAssessment(sink, testExecutor, assessment);

    expect(result.ok).toBe(true);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.executor).toBe(testExecutor);
    expect(sink.appends[0]?.events).toHaveLength(1);
    expect(sink.events).toHaveLength(1);
    const envelope = sink.events[0];
    expect(envelope?.eventName).toBe(MARGIN_ASSESSED_EVENT);
    expect(envelope?.causality.causationId).toBe(assessment.source.eventId);
    expect(envelope?.occurredAt).toBe(assessment.assessedAt);
  });

  it('emitting the same assessment twice appends two envelopes (audit trail, no dedup loss)', async () => {
    const { assessment } = await costAssessment();
    const sink = createInMemoryAssessmentEventSink();
    unwrap(await emitMarginAssessment(sink, testExecutor, assessment));
    unwrap(await emitMarginAssessment(sink, testExecutor, assessment));
    expect(sink.appends).toHaveLength(2);
    expect(sink.events).toHaveLength(2);
    // Both envelopes are byte-identical — assessments are deterministic.
    expect(JSON.stringify(sink.events[1])).toBe(JSON.stringify(sink.events[0]));
  });

  it('a sink failure propagates typed so the caller\u2019s transaction aborts', async () => {
    const { assessment } = await costAssessment();
    const sink = failingAssessmentEventSink('ledger write rejected in test');

    const result = await emitMarginAssessment(sink, testExecutor, assessment);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('assessment-sink-rejected');
      expect(result.error.message).toContain('ledger write rejected in test');
    }
  });
});
