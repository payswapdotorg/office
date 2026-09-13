import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from '@office/contracts';
import {
  PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR,
  createInMemoryProcurementEventSink,
  emitProcurementRecommendationProposed,
  failingProcurementEventSink,
  procurementRecommendationProposedEnvelope,
} from './audit';
import type { ProcurementSinkExecutor } from './audit';
import { detectProcurementRecommendations } from './recommendation';
import { HISTORY_OUTCOMES, needScenarioOf, runGoldenProcurementScan } from './scenarios';
import { DETECTED_AT, tenantReader, testScanId, unwrap } from './test-support';

// OFF-034 audit — the A3 envelopes through the injected sink port: one typed
// intelligence.procurementProposed envelope per detected recommendation,
// caused by the recommendation's primary producing event, carrying the
// JSON-safe payload with the EXPOSED projected-impact composition and the
// SUGGESTION-ONLY next actions; the sink is the only write path (the
// caller's executor rides every append; failures propagate typed).

const run = runGoldenProcurementScan();

const executor: ProcurementSinkExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

describe('the typed envelope (A3 — caused by the primary producing event)', () => {
  it('builds one intelligence.procurementProposed envelope per recommendation', () => {
    for (const recommendation of run.recommendations) {
      const envelope = unwrap(procurementRecommendationProposedEnvelope(recommendation));
      expect(envelope.eventName).toBe('intelligence.procurementProposed');
      expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(envelope.source).toBe('system');
      expect(envelope.actor).toStrictEqual(recommendation.actor);
      expect(envelope.occurredAt).toBe(DETECTED_AT);
      expect(envelope.scope).toStrictEqual(recommendation.scope);
      // Causality: the procurement event is CAUSED BY the recommendation's
      // primary producing event; the correlation id carries over.
      expect(envelope.causality.causationId).toBe(recommendation.primarySource.eventId);
      expect(envelope.causality.correlationId).toBe(recommendation.primarySource.correlationId);
      // The entity ref points at the first referenced canonical record
      // (the budget of record — canonical kind order).
      expect(envelope.entityRefs.after).toStrictEqual(recommendation.referencedRecords[0]);
      expect(envelope.entityRefs.before).toBeNull();
    }
  });

  it('carries the EXPOSED projected-impact composition across the event boundary', () => {
    for (const recommendation of run.recommendations) {
      const envelope = unwrap(procurementRecommendationProposedEnvelope(recommendation));
      const payload = envelope.payload as Record<string, unknown>;
      const impact = payload['projectedImpact'] as Record<string, unknown>;
      expect(impact['projectedDeltaMinor']).toBe(
        recommendation.projectedImpact.projectedDeltaMinor,
      );
      expect(impact['components']).toStrictEqual(
        recommendation.projectedImpact.components.map((component) => ({
          role: component.role,
          amountMinor: component.amountMinor,
          citedFrom: component.citedFrom,
          assessmentId: component.assessmentId,
          alternativeId: component.alternativeId,
        })),
      );
      // The components' signed sum survives the boundary (hand-recomputable).
      const components = impact['components'] as readonly { amountMinor: number }[];
      expect(
        components.reduce((total, component) => total + component.amountMinor, 0),
      ).toBe(recommendation.projectedImpact.projectedDeltaMinor);
    }
  });

  it('carries SUGGESTION-ONLY next actions (command references, never executions)', () => {
    for (const recommendation of run.recommendations) {
      const envelope = unwrap(procurementRecommendationProposedEnvelope(recommendation));
      const payload = envelope.payload as Record<string, unknown>;
      const actions = payload['proposedNextActions'] as readonly Record<string, unknown>[];
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(typeof action['commandName']).toBe('string');
        const actionPayload = action['payload'] as Record<string, unknown>;
        expect(actionPayload).not.toHaveProperty('version');
        expect(actionPayload).not.toHaveProperty('actorId');
        expect(actionPayload).not.toHaveProperty('idempotencyKey');
      }
    }
  });

  it('is JSON-safe (the payload round-trips through JSON unchanged)', () => {
    for (const recommendation of run.recommendations) {
      const envelope = unwrap(procurementRecommendationProposedEnvelope(recommendation));
      expect(JSON.parse(JSON.stringify(envelope.payload))).toStrictEqual(envelope.payload);
      // Deterministic: the same recommendation re-builds the identical envelope.
      expect(unwrap(procurementRecommendationProposedEnvelope(recommendation))).toStrictEqual(
        envelope,
      );
    }
  });

  it('omits the benchmark fact when the scan carried no benchmark (the honest empty basis)', () => {
    // A benchmark-less timing-shift scan: the historical basis carries the
    // outcomes but NO benchmark calibration fact.
    const scenario = needScenarioOf({
      n: 49,
      costItemQuantityMilli: 12_000,
      costItemUnitRateMinor: 1_000_000,
      commitmentAmountMinor: 10_000_000,
      assessedDeltaMinor: 600_000,
      assessedDurationDelta: 12,
      quotes: [
        {
          alternativeId: 'quote-m1',
          vendorKey: 'vendor-55',
          incumbentVendor: true,
          quantityMilli: 12_000,
          unitRateMinor: 800_000,
          leadTimeDays: 45,
          outcomeIds: [],
        },
        {
          alternativeId: 'quote-m2',
          vendorKey: 'vendor-56',
          incumbentVendor: false,
          quantityMilli: 12_000,
          unitRateMinor: 850_000,
          leadTimeDays: 25,
          outcomeIds: ['outcome-0005', 'outcome-0006'],
        },
      ],
    });
    const detected = unwrap(
      detectProcurementRecommendations(
        {
          budgets: [scenario.budget],
          commitments: [scenario.commitment],
          alternatives: scenario.alternatives,
          assessments: [scenario.assessment],
          outcomes: HISTORY_OUTCOMES,
          benchmarks: [],
        },
        tenantReader(),
        { scanId: testScanId(49), detectedAt: DETECTED_AT },
      ),
    );
    expect(detected).toHaveLength(1);
    const envelope = unwrap(procurementRecommendationProposedEnvelope(detected[0]!));
    const payload = envelope.payload as Record<string, unknown>;
    const basis = payload['historicalBasis'] as Record<string, unknown>;
    expect(basis['outcomeIds']).toStrictEqual(['outcome-0005', 'outcome-0006']);
    expect(basis['benchmarkIds']).toStrictEqual([]);
  });

  it('documents the payload grammar (the consuming contract)', () => {
    expect(PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR).toContain('projectedImpact');
    expect(PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR).toContain('proposedNextActions');
    expect(PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR).toContain('evidenceSetRefs');
    expect(PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR).toContain('historicalBasis');
  });
});

describe('the injected sink port (the only write path)', () => {
  it('records one append per recommendation, each carrying the CALLER executor', async () => {
    const sink = createInMemoryProcurementEventSink();
    for (const recommendation of run.recommendations) {
      const emitted = await emitProcurementRecommendationProposed(sink, executor, recommendation);
      expect(emitted).toStrictEqual({ ok: true, value: true });
    }
    expect(sink.appends).toHaveLength(3);
    expect(sink.appends.map((append) => append.executor)).toStrictEqual([
      executor,
      executor,
      executor,
    ]);
    expect(sink.events.map((event) => event.eventName)).toStrictEqual([
      'intelligence.procurementProposed',
      'intelligence.procurementProposed',
      'intelligence.procurementProposed',
    ]);
  });

  it('is byte-identical across re-emissions (deterministic audit stream)', async () => {
    const first = createInMemoryProcurementEventSink();
    const second = createInMemoryProcurementEventSink();
    for (const recommendation of run.recommendations) {
      await emitProcurementRecommendationProposed(first, executor, recommendation);
      await emitProcurementRecommendationProposed(second, executor, recommendation);
    }
    expect(second.events).toStrictEqual(first.events);
  });

  it('propagates a failing sink as a typed failure (the transaction aborts)', async () => {
    const sink = failingProcurementEventSink('the ledger is closed');
    const emitted = await emitProcurementRecommendationProposed(
      sink,
      executor,
      run.recommendations[0]!,
    );
    expect(emitted.ok).toBe(false);
    if (!emitted.ok) {
      expect(emitted.error.code).toBe('invariant-violation');
      expect(emitted.error.details[0]?.code).toBe('procurement-sink-rejected');
      expect(String(emitted.error.message)).toContain('the ledger is closed');
    }
  });
});
