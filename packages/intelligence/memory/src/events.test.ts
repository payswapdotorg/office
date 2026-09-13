import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_COMPUTED_EVENT,
  LESSON_CAPTURED_EVENT,
  OUTCOME_RECORDED_EVENT,
} from './vocabulary';
import {
  benchmarkComputedEnvelope,
  benchmarkPayload,
  createInMemoryMemoryEventSink,
  emitBenchmarkComputed,
  emitLessonCaptured,
  emitOutcomeRecorded,
  failingMemoryEventSink,
  lessonCapturedEnvelope,
  lessonPayload,
  memorySinkFailure,
  outcomePayload,
  outcomeRecordedEnvelope,
  parseBenchmarkPayload,
  parseLessonPayload,
  parseOutcomePayload,
} from './memory-events';
import type { MemorySinkExecutor } from './memory-events';
import { computeBenchmarks } from './benchmark';
import { captureLesson } from './lesson';
import {
  GOLDEN_PROJECT_ONE,
  GOLDEN_PROJECT_THREE,
  GOLDEN_PROJECT_TWO,
  T5,
  USER_ACTOR,
  captureLessonOk,
  outcomeOfRun,
  runCompletedProject,
  testBenchmarkId,
  testId,
  testLessonId,
  tenantAWideScope,
  projectOneScope,
  unwrap,
} from './test-support';
import type { OutcomeRecord } from './model';

// OFF-015 memory events — every recorded outcome, computed benchmark
// snapshot, and captured lesson emits exactly ONE DomainEventEnvelope
// through the MemoryEventSink port (mirroring the landed EventSink shape:
// appendEvents(executor, events) inside the CALLER's transaction). The
// envelope carries A3 causality (the outcome event is CAUSED BY the
// terminal assessed change event, correlation carried over) and A4
// provenance, and the payload round-trips through the fail-closed parsers
// back into the EXACT typed records (the fold's rebuild path).

const goldenOutcomes = async (): Promise<readonly OutcomeRecord[]> =>
  Promise.all(
    [GOLDEN_PROJECT_ONE, GOLDEN_PROJECT_TWO, GOLDEN_PROJECT_THREE].map((spec) =>
      runCompletedProject(spec).then(outcomeOfRun),
    ),
  );

const goldenLesson = () =>
  captureLessonOk(
    {
      title: 'Close the wall sequence before fit-out starts',
      statement:
        'Project one recorded a +3 day schedule variance because the wall-closing sequence overlapped the fit-out package.',
      applicability: [
        { area: 'schedule', value: 'wall-closing-sequence' },
        { area: 'cost', value: 'fit-out-package' },
      ],
      links: [
        {
          entity: { entityKind: 'contract' as never, entityId: testId('con', 1) },
          documentId: testId('doc', 1),
          revisionId: testId('rev', 1),
          sourceEventId: null,
        },
      ],
      provenance: { origin: 'human', author: USER_ACTOR, derivedFromOutcomeIds: [] },
    },
    {
      lessonId: testLessonId(1),
      capturedAt: T5,
      actor: USER_ACTOR,
      scope: projectOneScope(),
    },
  );

/** A no-op executor standing in for the caller's open transaction. */
const executor: MemorySinkExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

describe('the outcomeRecorded envelope (OFF-015, A3/A4)', () => {
  it('carries the event name, scope, actor, source, entity ref, and payload', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const envelope = unwrap(outcomeRecordedEnvelope(outcome));

    expect(envelope.eventName).toBe(OUTCOME_RECORDED_EVENT);
    expect(envelope.scope).toStrictEqual(outcome.scope);
    expect(envelope.actor).toStrictEqual(outcome.actor);
    expect(envelope.source).toBe('system'); // machine-derived by the intelligence engine
    expect(envelope.occurredAt).toBe(outcome.recordedAt);
    expect(envelope.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: 'project', entityId: outcome.projectId },
    });
    expect(envelope.payload).toStrictEqual(outcomePayload(outcome));
  });

  it('is CAUSED BY the terminal assessed change event (A3 causality)', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const envelope = unwrap(outcomeRecordedEnvelope(outcome));

    // The terminal assessment (latest assessedAt) anchors causality: its
    // correlation id carries over, its source change event is the cause.
    const terminal = outcome.evidence
      .filter((entry) => entry.kind === 'assessment')
      .sort((left, right) =>
        left.assessedAt === right.assessedAt
          ? left.assessmentId < right.assessmentId
            ? -1
            : 1
          : left.assessedAt < right.assessedAt
            ? -1
            : 1,
      )
      .at(-1);
    if (terminal === undefined || terminal.kind !== 'assessment') {
      throw new Error('no terminal assessment');
    }
    expect(envelope.causality.correlationId).toBe(terminal.correlationId);
    expect(envelope.causality.causationId).toBe(terminal.sourceEventId);
  });
});

describe('the benchmarkComputed + lessonCaptured envelopes (OFF-015)', () => {
  it('the benchmark envelope carries the caller-supplied causality + payload', async () => {
    const outcomes = await goldenOutcomes();
    const benchmark = unwrap(
      computeBenchmarks(outcomes, {
        benchmarkId: testBenchmarkId(1),
        computedAt: T5,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      }),
    );
    const causality = { correlationId: 'corr-00000077', causationId: null };
    const envelope = unwrap(benchmarkComputedEnvelope(benchmark, causality));

    expect(envelope.eventName).toBe(BENCHMARK_COMPUTED_EVENT);
    expect(envelope.scope).toStrictEqual(benchmark.scope);
    expect(envelope.actor).toStrictEqual(benchmark.actor);
    expect(envelope.source).toBe('system');
    expect(envelope.occurredAt).toBe(benchmark.computedAt);
    expect(envelope.entityRefs).toStrictEqual({ before: null, after: null });
    expect(envelope.causality.correlationId).toBe('corr-00000077');
    expect(envelope.causality.causationId).toBeNull();
    expect(envelope.payload).toStrictEqual(benchmarkPayload(benchmark));
  });

  it('the lesson envelope carries its first typed link as the entity ref', () => {
    const lesson = goldenLesson();
    const causality = { correlationId: 'corr-00000078', causationId: null };
    const envelope = unwrap(lessonCapturedEnvelope(lesson, causality));

    expect(envelope.eventName).toBe(LESSON_CAPTURED_EVENT);
    expect(envelope.scope).toStrictEqual(lesson.scope);
    expect(envelope.actor).toStrictEqual(lesson.actor);
    expect(envelope.source).toBe('system');
    expect(envelope.occurredAt).toBe(lesson.capturedAt);
    expect(envelope.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: 'contract', entityId: testId('con', 1) },
    });
    expect(envelope.causality.correlationId).toBe('corr-00000078');
    expect(envelope.causality.causationId).toBeNull();
    expect(envelope.payload).toStrictEqual(lessonPayload(lesson));
  });

  it('a lesson without links anchors the envelope at its scope project', () => {
    const lesson = unwrap(
      captureLesson(
        {
          title: 'Linkless lesson',
          statement: 'A lesson with no typed links still emits its envelope.',
          applicability: [{ area: 'general', value: 'portfolio' }],
          links: [],
          provenance: { origin: 'human', author: USER_ACTOR, derivedFromOutcomeIds: [] },
        },
        {
          lessonId: testLessonId(2),
          capturedAt: T5,
          actor: USER_ACTOR,
          scope: projectOneScope(),
        },
      ),
    );
    const envelope = unwrap(
      lessonCapturedEnvelope(lesson, { correlationId: 'corr-00000079', causationId: null }),
    );

    expect(envelope.entityRefs).toStrictEqual({ before: null, after: null });
  });
});

describe('memory events flow through the MemoryEventSink port (OFF-015)', () => {
  it('the in-memory sink records every append (executor + events, in order)', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const outcomes = await goldenOutcomes();
    const benchmark = unwrap(
      computeBenchmarks(outcomes, {
        benchmarkId: testBenchmarkId(1),
        computedAt: T5,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      }),
    );
    const lesson = goldenLesson();
    const sink = createInMemoryMemoryEventSink();

    const first = unwrap(await emitOutcomeRecorded(sink, executor, outcome));
    const second = unwrap(
      await emitBenchmarkComputed(sink, executor, benchmark, {
        correlationId: 'corr-00000077',
        causationId: null,
      }),
    );
    const third = unwrap(
      await emitLessonCaptured(sink, executor, lesson, {
        correlationId: 'corr-00000078',
        causationId: null,
      }),
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(third).toBe(true);
    expect(sink.appends).toHaveLength(3);
    expect(sink.appends[0]?.executor).toBe(executor);
    expect(sink.events.map((event) => event.eventName)).toStrictEqual([
      OUTCOME_RECORDED_EVENT,
      BENCHMARK_COMPUTED_EVENT,
      LESSON_CAPTURED_EVENT,
    ]);
  });

  it('a failing sink propagates its typed failure (the caller aborts)', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const sink = failingMemoryEventSink('the ledger is read-only in this test');

    const result = await emitOutcomeRecorded(sink, executor, outcome);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('memory-sink-rejected');
      expect(result.error.details[0]?.message).toBe(
        'the ledger is read-only in this test',
      );
    }
    // The typed sink failure helper names the reason.
    expect(memorySinkFailure('reason').details[0]?.code).toBe('memory-sink-rejected');
  });
});

describe('payload round-trips through the fail-closed parsers (OFF-015)', () => {
  it('outcomePayload → parseOutcomePayload reconstructs the EXACT typed record', async () => {
    for (const spec of [GOLDEN_PROJECT_ONE, GOLDEN_PROJECT_TWO, GOLDEN_PROJECT_THREE]) {
      const outcome = outcomeOfRun(await runCompletedProject(spec));
      const parsed = unwrap(parseOutcomePayload(outcomePayload(outcome)));
      expect(parsed).toStrictEqual(outcome);
    }
  });

  it('benchmarkPayload → parseBenchmarkPayload reconstructs the EXACT snapshot', async () => {
    const outcomes = await goldenOutcomes();
    const benchmark = unwrap(
      computeBenchmarks(outcomes, {
        benchmarkId: testBenchmarkId(1),
        computedAt: T5,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      }),
    );
    const parsed = unwrap(parseBenchmarkPayload(benchmarkPayload(benchmark)));
    expect(parsed).toStrictEqual(benchmark);
  });

  it('lessonPayload → parseLessonPayload reconstructs the EXACT lesson', () => {
    const lesson = goldenLesson();
    const parsed = unwrap(parseLessonPayload(lessonPayload(lesson)));
    expect(parsed).toStrictEqual(lesson);
  });

  it('the envelope payload is JSON-safe (the wire format survives stringify)', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const envelope = unwrap(outcomeRecordedEnvelope(outcome));

    const throughWire = JSON.parse(JSON.stringify(envelope.payload)) as unknown;
    expect(unwrap(parseOutcomePayload(throughWire))).toStrictEqual(outcome);
  });
});

describe('fail-closed payload parsing (OFF-015)', () => {
  it('rejects malformed outcome payloads with typed field paths', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const payload = outcomePayload(outcome);

    // Strict keys: one extra field at the root (the strict-keys failure
    // names the offending block's path).
    const extraField = { ...payload, extra: true };
    const extra = parseOutcomePayload(extraField);
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.error.details[0]?.code).toBe('memory-payload-valid');
      expect(extra.error.details[0]?.path).toBe('outcome');
    }

    // A nested lie: the schedule variance contradicts nothing structural,
    // but the wrong TYPE fails closed.
    const badVariance = {
      ...payload,
      schedule: { ...(payload['schedule'] as object), varianceDays: 'three' },
    };
    const variance = parseOutcomePayload(badVariance);
    expect(variance.ok).toBe(false);
    if (!variance.ok) {
      expect(variance.error.details[0]?.path).toBe('outcome.schedule.varianceDays');
    }

    // Non-object payloads never parse.
    for (const raw of [null, 'outcome', 42, []]) {
      expect(parseOutcomePayload(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('rejects malformed benchmark payloads (wrong engine, bad metric kind)', async () => {
    const outcomes = await goldenOutcomes();
    const benchmark = unwrap(
      computeBenchmarks(outcomes, {
        benchmarkId: testBenchmarkId(1),
        computedAt: T5,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      }),
    );
    const payload = benchmarkPayload(benchmark);

    const wrongEngine = { ...payload, engine: 'some-other-engine' };
    const engine = parseBenchmarkPayload(wrongEngine);
    expect(engine.ok).toBe(false);
    if (!engine.ok) {
      expect(engine.error.details[0]?.path).toBe('benchmark.engine');
    }

    const badMetric = {
      ...payload,
      metrics: [{ ...(payload['metrics'] as unknown[])[0] as object, kind: 'not-a-metric' }],
    };
    const metric = parseBenchmarkPayload(badMetric);
    expect(metric.ok).toBe(false);
    if (!metric.ok) {
      expect(metric.error.details[0]?.code).toBe('memory-payload-valid');
    }
  });

  it('rejects malformed lesson payloads (unpaired evidence, bad area, bad origin)', () => {
    const lesson = goldenLesson();
    const payload = lessonPayload(lesson);

    // A revision without its document: evidence links pair.
    const unpaired = {
      ...payload,
      links: [
        {
          ...((payload['links'] as unknown[])[0] as object),
          documentId: null,
          revisionId: testId('rev', 9),
        },
      ],
    };
    const paired = parseLessonPayload(unpaired);
    expect(paired.ok).toBe(false);

    const badArea = {
      ...payload,
      applicability: [{ area: 'procurement', value: 'nope' }],
    };
    const area = parseLessonPayload(badArea);
    expect(area.ok).toBe(false);
    if (!area.ok) {
      expect(area.error.details[0]?.code).toBe('memory-payload-valid');
    }

    const badOrigin = {
      ...payload,
      provenance: { ...((payload['provenance'] as object)), origin: 'machine-dreamt' },
    };
    const origin = parseLessonPayload(badOrigin);
    expect(origin.ok).toBe(false);
    if (!origin.ok) {
      expect(origin.error.details[0]?.path).toBe('lesson.provenance.origin');
    }
  });

  it('a tampered outcome payload that still parses is NOT the outcome (payload ≠ truth)', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const payload = outcomePayload(outcome);
    // The margin number is edited in the payload — it still parses (it is
    // structurally valid), but it is a DIFFERENT record than the derived
    // outcome: only the fold's drift/idempotency gates decide whether it
    // ever enters a store (see store.test.ts).
    const tampered = unwrap(
      parseOutcomePayload({
        ...payload,
        margin: { ...(payload['margin'] as object), marginMinor: 999 },
      }),
    );
    expect(tampered.margin.marginMinor).toBe(999);
    expect(tampered.margin.marginMinor).not.toBe(outcome.margin.marginMinor);
    expect(tampered.outcomeId).toBe(outcome.outcomeId);
    expect(tampered.outcomeVersion).toBe(1);
  });
});
