import { beforeAll, describe, expect, it } from 'vitest';
import { EXCEPTION_DETECTED_EVENT } from './vocabulary';
import { unwrap } from './test-support';
import {
  createInMemoryExceptionEventSink,
  emitExceptionDetected,
  exceptionDetectedEnvelope,
  exceptionSinkFailure,
  failingExceptionEventSink,
} from './exception-events';
import type { ExceptionSinkExecutor } from './exception-events';
import { runPortfolioScan } from './scenarios';
import type { PortfolioScanRun } from './scenarios';
import type { Exception } from './model';
import { suggestNextActions } from './next-actions';

// OFF-019 exception events — every detected exception emits exactly ONE
// DomainEventEnvelope through the ExceptionEventSink port (the peers'
// EventSink shape: appendEvents(executor, events) inside the caller's
// transaction). The envelope is built through the canonical contracts
// parser, caused by the exception's primary producing event (A3), and
// carries the JSON-safe control-tower summary — evidence ids + suggested
// next actions included. Sink failures are typed and propagate.

let run: PortfolioScanRun;

beforeAll(async () => {
  run = await runPortfolioScan();
});

/** A no-op executor stand-in (the sink records it; nothing is queried). */
const executorOf = (): ExceptionSinkExecutor => ({
  query: async () => ({ rows: [], rowCount: 0 }),
});

describe('the exceptionDetected envelope (OFF-019)', () => {
  it('builds one canonical envelope per exception', () => {
    for (const exception of run.exceptions) {
      const envelope = exceptionDetectedEnvelope(exception);
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) continue;
      const value = envelope.value;
      expect(value.eventName).toBe(EXCEPTION_DETECTED_EVENT);
      expect(value.eventName).toBe('intelligence.exceptionDetected');
      // The machine-generated intelligence event is sourced 'system'.
      expect(value.source).toBe('system');
      expect(value.actor).toStrictEqual(exception.actor);
      expect(value.scope).toStrictEqual(exception.scope);
      expect(value.occurredAt).toBe(exception.detectedAt);
      // A3 causality: caused by the primary producing event, correlation carried over.
      expect(value.causality.causationId).toBe(exception.primarySource.eventId);
      expect(value.causality.correlationId).toBe(exception.primarySource.correlationId);
      // The entity ref points at the exception's first affected entity.
      expect(value.entityRefs).toStrictEqual({
        before: null,
        after: exception.affected[0],
      });
    }
  });

  it('carries the JSON-safe control-tower summary with every evidence id', () => {
    for (const exception of run.exceptions) {
      const envelope = exceptionDetectedEnvelope(exception);
      if (!envelope.ok) throw new Error('unexpected envelope failure');
      const payload = envelope.value.payload as Record<string, unknown>;
      expect(payload['exceptionId']).toBe(exception.exceptionId);
      expect(payload['exceptionVersion']).toBe(exception.exceptionVersion);
      expect(payload['engine']).toBe(exception.engine);
      expect(payload['scanId']).toBe(exception.provenance.scanId);
      expect(payload['detectedAt']).toBe(exception.detectedAt);
      expect(payload['kind']).toBe(exception.kind);
      expect(payload['title']).toBe(exception.title);
      expect(payload['severity']).toStrictEqual({
        level: exception.severity.level,
        reasons: [...exception.severity.reasons],
      });
      expect(payload['economicImpact']).toStrictEqual({
        amountMinor: exception.economicImpact.amountMinor,
        currency: exception.economicImpact.currency,
        assessmentIds: [...exception.economicImpact.assessmentIds],
      });
      expect(payload['affected']).toStrictEqual(
        exception.affected.map((ref) => ({
          entityKind: ref.entityKind,
          entityId: ref.entityId,
        })),
      );
      // The A4 evidence chain survives the event boundary, split by kind.
      expect(payload['evidenceEventIds']).toStrictEqual(
        exception.evidence
          .filter((evidence) => evidence.kind === 'event')
          .map((evidence) => (evidence.kind === 'event' ? evidence.eventId : null)),
      );
      expect(payload['evidenceAssessmentIds']).toStrictEqual(
        exception.evidence
          .filter((evidence) => evidence.kind === 'assessment')
          .map((evidence) => (evidence.kind === 'assessment' ? evidence.assessmentId : null)),
      );
      expect(payload['evidenceBenchmarkIds']).toStrictEqual(
        exception.evidence
          .filter((evidence) => evidence.kind === 'benchmark')
          .map((evidence) => (evidence.kind === 'benchmark' ? evidence.benchmarkId : null)),
      );
      // The payload is JSON-safe end to end.
      expect(JSON.parse(JSON.stringify(payload))).toStrictEqual(payload);
    }
  });

  it('carries the suggested next actions as data (suggestions only)', () => {
    for (const exception of run.exceptions) {
      const envelope = exceptionDetectedEnvelope(exception);
      if (!envelope.ok) throw new Error('unexpected envelope failure');
      const payload = envelope.value.payload as Record<string, unknown>;
      expect(payload['nextActions']).toStrictEqual(
        suggestNextActions(exception).map((action) => ({
          commandName: action.command.commandName,
          title: action.title,
          confidence: {
            level: action.confidence.level,
            reasons: [...action.confidence.reasons],
          },
          payload: action.command.payload,
        })),
      );
    }
  });

  it('is deterministic: the same exception yields the identical envelope', () => {
    for (const exception of run.exceptions) {
      const first = exceptionDetectedEnvelope(exception);
      const second = exceptionDetectedEnvelope(exception);
      expect(first).toStrictEqual(second);
    }
  });

  it('fails typed when the exception carries no affected entity ref', () => {
    const empty: Exception = { ...run.exceptions[0]!, affected: [] };
    const result = exceptionDetectedEnvelope(empty);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('exception-event-valid');
      expect(result.error.message).toContain('at least one affected entity ref');
    }
  });
});

describe('the ExceptionEventSink port (OFF-019)', () => {
  it('the in-memory sink records the append (executor + events, in order)', async () => {
    const sink = createInMemoryExceptionEventSink();
    const executor = executorOf();
    const exception = run.exceptions[0]!;
    const envelope = unwrap(exceptionDetectedEnvelope(exception));
    const emitted = await emitExceptionDetected(sink, executor, exception);
    expect(emitted).toStrictEqual({ ok: true, value: true });
    expect(sink.appends).toStrictEqual([{ executor, events: [envelope] }]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.eventName).toBe(EXCEPTION_DETECTED_EVENT);
  });

  it('every emitted exception appends exactly one envelope, in emission order', async () => {
    const sink = createInMemoryExceptionEventSink();
    const executor = executorOf();
    for (const exception of run.exceptions) {
      const emitted = await emitExceptionDetected(sink, executor, exception);
      expect(emitted.ok).toBe(true);
    }
    expect(sink.appends).toHaveLength(run.exceptions.length);
    expect(sink.events.map((event) => eventNameOfPayload(event.payload))).toStrictEqual(
      run.exceptions.map((exception) => exception.kind),
    );
  });

  it('a failing sink propagates the typed failure (the transaction aborts)', async () => {
    const sink = failingExceptionEventSink('the ledger is unavailable');
    const emitted = await emitExceptionDetected(sink, executorOf(), run.exceptions[0]!);
    expect(emitted.ok).toBe(false);
    if (!emitted.ok) {
      expect(emitted.error.code).toBe('invariant-violation');
      expect(emitted.error.details[0]?.code).toBe('exception-sink-rejected');
      expect(emitted.error.message).toContain('the ledger is unavailable');
    }
  });

  it('the typed sink failure constructor carries the reason', () => {
    const error = exceptionSinkFailure('append rejected');
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('exception-sink-rejected');
    expect(error.details[0]?.message).toBe('append rejected');
  });
});

/** Read one emitted payload's exception kind (the summary's `kind` field). */
const eventNameOfPayload = (payload: unknown): string => {
  const record = payload as Record<string, unknown>;
  return String(record['kind']);
};
