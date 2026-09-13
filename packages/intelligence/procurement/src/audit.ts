// Office intelligence — procurement audit events + the sink port (OFF-034).
//
// Every detected procurement recommendation emits exactly ONE
// DomainEventEnvelope through the ProcurementEventSink port, mirroring the
// landed intelligence peers' EventSink shape byte-for-byte in structure
// (appendEvents(executor, events) inside the CALLER's transaction — see
// the margin engine's assessment-events, the memory engine's
// memory-events, and the revenue engine's audit): the downstream consumers
// OFF-037 (the end-to-end construction reference scenario) and OFF-040
// (analytics) consume procurement-recommendation events like any other
// domain event.
//
// One documented local structural type (the dependency rule forbids
// importing the owning package):
// - ProcurementSinkExecutor mirrors @office/persistence's SqlExecutor
//   surface (the `query` method) — a real implementation receives the
//   caller's open transaction executor exactly like the domain sinks do.
// - The envelope is built through @office/contracts' canonical parser, so
//   an emitted procurement event can never be invalid.
//
// Causality (A3): the procurement event is CAUSED BY the recommendation's
// primary producing event — its causation id is that event's ledger id,
// and the correlation id of the source's causal chain is carried over. The
// envelope's source is 'system' (the recommendation is machine-generated
// by the intelligence engine — never 'domain', never an adapter), the
// actor is the scan's requesting actor, and the entity refs point at the
// recommendation's first referenced canonical record. The payload carries
// the JSON-safe recommendation summary INCLUDING the projected economic
// impact's exposed composition and the proposed next actions' command
// references (suggestions only — the event carries data, never an
// execution).
import { CURRENT_SCHEMA_VERSION, parseDomainEventEnvelope } from '@office/contracts';
import type { DomainEventEnvelope, EntityRef } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { PROCUREMENT_RECOMMENDATION_PROPOSED_EVENT } from './vocabulary';
import type { ProcurementRecommendation } from './recommendation';
import { proposeNextActions } from './proposal';

// ---------------------------------------------------------------------------
// The sink executor port (local structural mirror of SqlExecutor).
// ---------------------------------------------------------------------------

/**
 * The executor surface a procurement sink needs (a local structural mirror
 * of @office/persistence's SqlExecutor — that package is not importable
 * from the intelligence layer; the shape is the port, mirroring the landed
 * intelligence peers' EventSink convention exactly).
 */
export interface ProcurementSinkExecutor {
  readonly query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

// ---------------------------------------------------------------------------
// The EventSink port (mirrors the landed intelligence peers' shape).
// ---------------------------------------------------------------------------

/**
 * THE procurement event sink port: append procurement events inside the
 * caller's transaction (the executor it hands over). A failure result MUST
 * abort the surrounding write, exactly like the domain packages' EventSink.
 */
export interface ProcurementEventSink {
  /**
   * Append `events` inside the transaction of `executor`. A failure result
   * MUST abort the surrounding mutation, so a partially-applied write can
   * never commit.
   */
  appendEvents(
    executor: ProcurementSinkExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedProcurementAppend {
  readonly executor: ProcurementSinkExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory procurement event sink: records appends instead of writing (tests). */
export interface InMemoryProcurementEventSink extends ProcurementEventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedProcurementAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory procurement event sink for deterministic tests. */
export function createInMemoryProcurementEventSink(): InMemoryProcurementEventSink {
  const appends: RecordedProcurementAppend[] = [];
  return {
    appends,
    get events(): readonly DomainEventEnvelope[] {
      return appends.flatMap((append) => append.events);
    },
    appendEvents: async (executor, events) => {
      appends.push({ executor, events: [...events] });
      return ok(true);
    },
  };
}

/** Build a typed sink failure (for tests and wiring guards). */
export const procurementSinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `procurement event sink rejected the append: ${reason}`,
    [{ code: 'procurement-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingProcurementEventSink = (reason: string): ProcurementEventSink => ({
  appendEvents: async () => fail(procurementSinkFailure(reason)),
});

// ---------------------------------------------------------------------------
// The procurement event envelope.
// ---------------------------------------------------------------------------

/** Grammar description of the procurement-recommendation-proposed event payload. */
export const PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR =
  'procurementRecommendationProposed payload: { recommendationId, recommendationVersion, engine, scanId, detectedAt, kind, title, selectedAlternatives, referencedRecords, projectedImpact (with its exposed component composition), historicalBasis, riskFactors, evidenceRecordRefs, evidenceEventIds, evidenceAssessmentIds, evidenceOutcomeIds, evidenceBenchmarkIds, evidenceSetRefs, proposedNextActions } (JSON-safe summary of the ProcurementRecommendation + its proposed next actions)';

/** Build a typed failure for an unbuildable procurement event. */
const procurementEventFailure = (reason: string): DomainError =>
  domainError(
    'invariant-violation',
    `the procurement recommendation cannot be emitted as an event: ${reason}`,
    [{ code: 'procurement-event-valid', message: reason, path: null }],
  );

/**
 * Build the audit event of ONE detected procurement recommendation: an
 * `intelligence.procurementProposed` DomainEventEnvelope
 * whose causation id is the recommendation's primary producing event's
 * ledger id (the detection is downstream of the change that created the
 * need), whose correlation id is carried over from the source's causal
 * chain, whose actor is the scan's requesting actor, and whose payload is
 * the JSON-safe recommendation summary downstream consumers (OFF-037/040)
 * read — including the projected economic impact's EXPOSED component
 * composition (every cited number survives the event boundary), the
 * proposed next actions (SUGGESTIONS ONLY), the evidence chain ids (A4
 * traceability survives the event boundary), and the complete evidence-set
 * reference tokens (the agents discipline).
 */
export function procurementRecommendationProposedEnvelope(
  recommendation: ProcurementRecommendation,
): Result<DomainEventEnvelope, DomainError> {
  const firstReferenced = recommendation.referencedRecords[0];
  if (firstReferenced === undefined) {
    return fail(
      procurementEventFailure(
        'a procurement recommendation must reference at least one canonical record',
      ),
    );
  }
  const entityRef: EntityRef = {
    entityKind: firstReferenced.entityKind,
    entityId: firstReferenced.entityId,
  };
  const envelope = parseDomainEventEnvelope({
    kind: 'event',
    eventName: PROCUREMENT_RECOMMENDATION_PROPOSED_EVENT,
    scope: recommendation.scope,
    actor: recommendation.actor,
    source: 'system',
    causality: {
      correlationId: recommendation.primarySource.correlationId,
      causationId: recommendation.primarySource.eventId,
    },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: recommendation.detectedAt,
    entityRefs: { before: null, after: entityRef },
    payload: {
      recommendationId: recommendation.recommendationId,
      recommendationVersion: recommendation.recommendationVersion,
      engine: recommendation.engine,
      scanId: recommendation.provenance.scanId,
      detectedAt: recommendation.detectedAt,
      kind: recommendation.kind,
      title: recommendation.title,
      selectedAlternatives: recommendation.selectedAlternatives.map((alternative) => ({
        alternativeId: alternative.alternativeId,
        vendorKey: alternative.vendorKey,
        normalizedAmountMinor: alternative.normalizedAmountMinor,
      })),
      referencedRecords: recommendation.referencedRecords.map((ref) => ({
        entityKind: ref.entityKind,
        entityId: ref.entityId,
      })),
      projectedImpact: {
        projectedDeltaMinor: recommendation.projectedImpact.projectedDeltaMinor,
        currency: recommendation.projectedImpact.currency,
        components: recommendation.projectedImpact.components.map((component) => ({
          role: component.role,
          amountMinor: component.amountMinor,
          citedFrom: component.citedFrom,
          assessmentId: component.assessmentId,
          alternativeId: component.alternativeId,
        })),
        assessmentIds: [...recommendation.projectedImpact.assessmentIds],
      },
      historicalBasis: {
        outcomeIds: [...recommendation.historicalBasis.outcomeIds],
        benchmarkIds: recommendation.historicalBasis.benchmarks.map((fact) => fact.benchmarkId),
      },
      riskFactors: recommendation.riskFactors.map((factor) => ({
        kind: factor.kind,
        vendorKey: factor.vendorKey,
      })),
      evidenceRecordRefs: recommendation.evidence
        .filter((evidence) => evidence.kind === 'record')
        .map((evidence) => (evidence.kind === 'record' ? evidence.ref.entityId : null)),
      evidenceEventIds: recommendation.evidence
        .filter((evidence) => evidence.kind === 'event')
        .map((evidence) => (evidence.kind === 'event' ? evidence.eventId : null)),
      evidenceAssessmentIds: recommendation.evidence
        .filter((evidence) => evidence.kind === 'assessment')
        .map((evidence) => (evidence.kind === 'assessment' ? evidence.assessmentId : null)),
      evidenceOutcomeIds: recommendation.evidence
        .filter((evidence) => evidence.kind === 'outcome')
        .map((evidence) => (evidence.kind === 'outcome' ? evidence.outcomeId : null)),
      evidenceBenchmarkIds: recommendation.evidence
        .filter((evidence) => evidence.kind === 'benchmark')
        .map((evidence) => (evidence.kind === 'benchmark' ? evidence.benchmarkId : null)),
      evidenceSetRefs: recommendation.evidenceSet.items.map((item) => item.ref),
      proposedNextActions: proposeNextActions(recommendation).map((action) => ({
        commandName: action.command.commandName,
        title: action.title,
        confidence: {
          level: action.confidence.level,
          reasons: [...action.confidence.reasons],
        },
        payload: action.command.payload,
      })),
    },
  });
  if (!envelope.ok) {
    return fail(
      procurementEventFailure(
        `the procurementRecommendationProposed envelope failed its own contract: ${JSON.stringify(envelope.error)}`,
      ),
    );
  }
  return ok(envelope.value);
}

/**
 * Emit ONE detected procurement recommendation through a
 * ProcurementEventSink — the convenience the runtime wires: build the
 * envelope and hand it to the sink with the caller's executor. The sink's
 * failure propagates (typed) so the caller's transaction aborts.
 */
export async function emitProcurementRecommendationProposed(
  sink: ProcurementEventSink,
  executor: ProcurementSinkExecutor,
  recommendation: ProcurementRecommendation,
): Promise<Result<true, DomainError>> {
  const envelope = procurementRecommendationProposedEnvelope(recommendation);
  if (!envelope.ok) return envelope;
  return sink.appendEvents(executor, [envelope.value]);
}
