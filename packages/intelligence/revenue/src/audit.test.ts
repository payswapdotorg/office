import { describe, expect, it } from 'vitest';
import { RECOVERY_DETECTED_EVENT } from './vocabulary';
import { runGoldenRecoveryScan } from './scenarios';
import {
  RECOVERY_DETECTED_PAYLOAD_GRAMMAR,
  createInMemoryRecoveryEventSink,
  emitRecoveryCandidateDetected,
  failingRecoveryEventSink,
  recoveryCandidateDetectedEnvelope,
  recoverySinkFailure,
} from './audit';
import type { RecoverySinkExecutor } from './audit';
import { proposeNextActions } from './proposal';
import type { CandidateRecovery } from './candidates';
import { DETECTED_AT, USER_ACTOR, unwrap } from './test-support';

// OFF-033 audit — the recovery-candidate-detected event: the envelope shape
// (A3 causality, system source, the JSON-safe payload with the evidence ids
// + the proposed next actions), the injected EventSink port (appends inside
// the caller's transaction, typed failure propagation), and the fail-closed
// rejections.

const run = runGoldenRecoveryScan();
const executor: RecoverySinkExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

const candidateAt = (index: number): CandidateRecovery => {
  const candidate = run.candidates[index];
  if (candidate === undefined) throw new Error(`missing candidate ${index}`);
  return candidate;
};

describe('the recovery-candidate-detected envelope (A3/A4)', () => {
  it('emits the typed event name with the system source + the scan actor', () => {
    const envelope = unwrap(recoveryCandidateDetectedEnvelope(candidateAt(0)));
    expect(envelope.kind).toBe('event');
    expect(envelope.eventName).toBe(RECOVERY_DETECTED_EVENT);
    expect(envelope.source).toBe('system');
    expect(envelope.actor).toStrictEqual(USER_ACTOR);
    expect(envelope.occurredAt).toBe(DETECTED_AT);
    expect(envelope.schemaVersion).toBe('1.0.0');
  });

  it('causes the event by the primary producing event, carrying the source correlation id', () => {
    const envelope = unwrap(recoveryCandidateDetectedEnvelope(candidateAt(0)));
    expect(envelope.causality.causationId).toBe(candidateAt(0).primarySource.eventId);
    expect(envelope.causality.correlationId).toBe(candidateAt(0).primarySource.correlationId);
    expect(envelope.scope).toStrictEqual(candidateAt(0).scope);
  });

  it('points the entity refs at the first referenced canonical record', () => {
    const envelope = unwrap(recoveryCandidateDetectedEnvelope(candidateAt(0)));
    expect(envelope.entityRefs.after).toStrictEqual(candidateAt(0).referencedRecords[0]);
    expect(envelope.entityRefs.before).toBeNull();
  });

  it('carries the JSON-safe summary: severity, economic basis, evidence ids, evidence-set refs', () => {
    const candidate = candidateAt(1);
    const payload = unwrap(recoveryCandidateDetectedEnvelope(candidate)).payload as Record<
      string,
      unknown
    >;
    expect(payload['candidateId']).toBe(candidate.candidateId);
    expect(payload['candidateVersion']).toBe(candidate.candidateVersion);
    expect(payload['engine']).toBe(candidate.engine);
    expect(payload['scanId']).toBe(candidate.provenance.scanId);
    expect(payload['detectedAt']).toBe(DETECTED_AT);
    expect(payload['kind']).toBe(candidate.kind);
    expect(payload['title']).toBe(candidate.title);
    expect(payload['severity']).toStrictEqual({
      level: candidate.severity.level,
      reasons: [...candidate.severity.reasons],
    });
    expect(payload['economicBasis']).toStrictEqual({
      amountMinor: candidate.economicBasis.amountMinor,
      currency: candidate.economicBasis.currency,
      citedFrom: candidate.economicBasis.citedFrom,
      assessmentIds: [...candidate.economicBasis.assessmentIds],
    });
    expect(payload['evidenceAssessmentIds']).toStrictEqual(
      candidate.evidence
        .filter((evidence) => evidence.kind === 'assessment')
        .map((evidence) => (evidence.kind === 'assessment' ? evidence.assessmentId : null)),
    );
    expect(payload['evidenceOutcomeIds']).toStrictEqual(
      candidate.evidence
        .filter((evidence) => evidence.kind === 'outcome')
        .map((evidence) => (evidence.kind === 'outcome' ? evidence.outcomeId : null)),
    );
    expect(payload['evidenceBenchmarkIds']).toStrictEqual(
      candidate.evidence
        .filter((evidence) => evidence.kind === 'benchmark')
        .map((evidence) => (evidence.kind === 'benchmark' ? evidence.benchmarkId : null)),
    );
    expect(payload['evidenceSetRefs']).toStrictEqual(
      candidate.evidenceSet.items.map((item) => item.ref),
    );
  });

  it('carries the SUGGESTED next actions as data (command references, never executions)', () => {
    const candidate = candidateAt(0);
    const payload = unwrap(recoveryCandidateDetectedEnvelope(candidate)).payload as Record<
      string,
      unknown
    >;
    expect(payload['proposedNextActions']).toStrictEqual(
      proposeNextActions(candidate).map((action) => ({
        commandName: action.command.commandName,
        title: action.title,
        confidence: {
          level: action.confidence.level,
          reasons: [...action.confidence.reasons],
        },
        payload: action.command.payload,
      })),
    );
  });

  it('rejects a candidate that references no canonical record (fail-closed)', () => {
    const empty: CandidateRecovery = {
      ...candidateAt(0),
      referencedRecords: [],
    };
    const rejected = recoveryCandidateDetectedEnvelope(empty);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('recovery-event-valid');
    }
  });

  it('pins the payload grammar documentation constant', () => {
    expect(RECOVERY_DETECTED_PAYLOAD_GRAMMAR).toContain('recoveryCandidateDetected payload');
    expect(RECOVERY_DETECTED_PAYLOAD_GRAMMAR).toContain('proposedNextActions');
  });
});

describe('the injected EventSink port (appends inside the caller\'s transaction)', () => {
  it('records the append + hands over the caller\'s executor', async () => {
    const sink = createInMemoryRecoveryEventSink();
    const emitted = await emitRecoveryCandidateDetected(sink, executor, candidateAt(0));
    expect(emitted).toStrictEqual({ ok: true, value: true });
    expect(sink.appends).toHaveLength(1);
    const append = sink.appends[0];
    expect(append?.executor).toBe(executor);
    expect(append?.events).toHaveLength(1);
    expect(append?.events[0]?.eventName).toBe(RECOVERY_DETECTED_EVENT);
    expect(sink.events).toHaveLength(1);
  });

  it('emits one envelope per candidate across the golden set (in order)', async () => {
    const sink = createInMemoryRecoveryEventSink();
    for (const candidate of run.candidates) {
      expect((await emitRecoveryCandidateDetected(sink, executor, candidate)).ok).toBe(true);
    }
    expect(sink.events.map((event) => event.causality.causationId)).toStrictEqual(
      run.candidates.map((candidate) => candidate.primarySource.eventId),
    );
  });

  it('a failing sink propagates the typed failure (the caller\'s transaction aborts)', async () => {
    const sink = failingRecoveryEventSink('the ledger rejected the append');
    const rejected = await emitRecoveryCandidateDetected(sink, executor, candidateAt(0));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('recovery-sink-rejected');
      expect(String(rejected.error.message)).toContain('the ledger rejected the append');
    }
  });

  it('recoverySinkFailure builds the typed sink rejection', () => {
    const failure = recoverySinkFailure('reason-here');
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('recovery-sink-rejected');
    expect(failure.details[0]?.message).toBe('reason-here');
  });

  it('is deterministic: the same candidate emits the byte-identical envelope', () => {
    for (const candidate of run.candidates) {
      expect(unwrap(recoveryCandidateDetectedEnvelope(candidate))).toStrictEqual(
        unwrap(recoveryCandidateDetectedEnvelope(candidate)),
      );
    }
  });
});
