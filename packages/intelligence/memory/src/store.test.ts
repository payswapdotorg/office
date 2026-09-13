import { describe, expect, it } from 'vitest';
import { parseCorrelationId } from '@office/contracts';
import type { CorrelationId } from '@office/contracts';
import type { LedgerEvent } from '@office/events';
import { computeBenchmarks } from './benchmark';
import { deriveOutcome } from './outcome';
import { captureLesson } from './lesson';
import { projectMemory } from './store';
import type { MemoryStore } from './store';
import { LESSON_CAPTURED_EVENT, OUTCOME_RECORDED_EVENT } from './vocabulary';
import type { OutcomeId } from './vocabulary';
import { lessonPayload } from './memory-events';
import {
  benchmarkAppendOf,
  causalityOf,
  lessonAppendOf,
  memoryLedgerOf,
  outcomeAppendOf,
  captureLessonOk,
  testEventEnvelope,
  testId,
  testLessonId,
  testOutcomeId,
  testBenchmarkId,
  T4,
  T5,
  USER_ACTOR,
  unwrap,
  GOLDEN_PROJECT_ONE,
  GOLDEN_PROJECT_THREE,
  GOLDEN_PROJECT_TWO,
  outcomeOfRun,
  runCompletedProject,
  projectOneScope,
  tenantAWideScope,
} from './test-support';
import type { MemoryAppend } from './test-support';
import type { Benchmark, Lesson, OutcomeRecord } from './model';

/** A canonical correlation id token (the envelope's trusted path needs one). */
const correlation = (token: string): CorrelationId => unwrap(parseCorrelationId(token));

// OFF-015 memory store — THE rebuildable-projection discipline (freeze
// A2/A7): the whole memory store is a pure fold of its recorded memory
// events. Folding the same stream twice yields the identical store; folding
// from scratch after the served content was TAMPERED with yields the
// pristine store again — tampering never propagates into a rebuild, because
// the event stream is the only source. Immutable facts of history (one
// outcome per project, idempotent redelivery, conflicting re-record
// typed-rejected) and the no-drift benchmark gate (a recorded snapshot must
// equal the pure recomputation over exactly its named outcome ids) fold
// fail-closed.

const goldenOutcomes = async (): Promise<readonly OutcomeRecord[]> =>
  Promise.all(
    [GOLDEN_PROJECT_ONE, GOLDEN_PROJECT_TWO, GOLDEN_PROJECT_THREE].map((spec) =>
      runCompletedProject(spec).then(outcomeOfRun),
    ),
  );

const goldenLesson = (): Lesson =>
  captureLessonOk(
    {
      title: 'Close the wall sequence before fit-out starts',
      statement:
        'Project one recorded a +3 day schedule variance because the wall-closing sequence overlapped the fit-out package; sequencing the close-out first avoids the variance.',
      applicability: [
        { area: 'schedule', value: 'wall-closing-sequence' },
        { area: 'cost', value: 'fit-out-package' },
      ],
      links: [
        {
          entity: { entityKind: 'contract' as never, entityId: testId('con', 1) },
          documentId: null,
          revisionId: null,
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

/** The full golden memory stream: 3 outcomes + 1 benchmark + 1 lesson. */
const goldenMemoryEvents = async (): Promise<readonly LedgerEvent[]> => {
  const outcomes = await goldenOutcomes();
  const outcomeAppends = outcomes.map(outcomeAppendOf);
  const outcomeOnlyEvents = await memoryLedgerOf(outcomeAppends);
  const anchor = causalityOf(outcomeOnlyEvents[outcomeOnlyEvents.length - 1] as never);
  const benchmark = unwrap(
    computeBenchmarks(outcomes, {
      benchmarkId: testBenchmarkId(1),
      computedAt: T5,
      actor: USER_ACTOR,
      scope: tenantAWideScope(),
    }),
  );
  const lesson = goldenLesson();
  const appends: readonly MemoryAppend[] = [
    ...outcomeAppends,
    benchmarkAppendOf(benchmark, anchor),
    lessonAppendOf(lesson, { correlationId: 'corr-00000099', causationId: null }),
  ];
  return memoryLedgerOf(appends);
};

describe('the memory store fold (OFF-015, A2/A7)', () => {
  it('serves the folded outcomes, benchmark, and lesson with lookups + tallies', async () => {
    const events = await goldenMemoryEvents();
    const store = unwrap(projectMemory(events));

    expect(store.outcomes).toHaveLength(3);
    expect(store.benchmarks).toHaveLength(1);
    expect(store.lessons).toHaveLength(1);
    expect(store.outcomeOf(testOutcomeId(1))?.projectId).toBe(
      store.outcomeOfProject(store.outcomes[0]?.projectId as never)?.projectId,
    );
    expect(store.lessonOf(testLessonId(1))?.title).toBe(
      'Close the wall sequence before fit-out starts',
    );
    expect(store.benchmarkOf(testBenchmarkId(1))?.outcomeCount).toBe(3);
    // Canonical collection order: outcomes by outcome id.
    expect(store.outcomes.map((outcome) => outcome.outcomeId)).toStrictEqual([
      testOutcomeId(1),
      testOutcomeId(2),
      testOutcomeId(3),
    ]);
    // The derivation audit trail.
    expect(store.derivation.outcomeCount).toBe(3);
    expect(store.derivation.benchmarkCount).toBe(1);
    expect(store.derivation.lessonCount).toBe(1);
    expect(store.derivation.projectedEventCount).toBe(5);
    expect(store.derivation.recognizedEventNames).toStrictEqual([
      { eventName: 'intelligence.benchmarkComputed', count: 1 },
      { eventName: 'intelligence.lessonCaptured', count: 1 },
      { eventName: 'intelligence.outcomeRecorded', count: 3 },
    ]);
    expect(store.derivation.skippedEventNames).toStrictEqual([]);
  });

  it('skips unknown event names deterministically and tallies them (never a crash)', async () => {
    const outcomes = await goldenOutcomes();
    const outcomeAppends = outcomes.map(outcomeAppendOf);
    // A domain event and a margin assessment event ride the same stream:
    // they are DERIVATION inputs, not store inputs — skipped + tallied.
    const noise: readonly MemoryAppend[] = [
      {
        envelope: testEventEnvelope({
          eventName: 'contracts.contractCreated',
          scope: projectOneScope(),
          causality: { correlationId: correlation('corr-00000001'), causationId: null },
          occurredAt: T4,
          aggregate: { entityKind: 'contract' as never, entityId: testId('con', 1) },
          payload: { contractId: testId('con', 1) },
        }),
        aggregate: { entityKind: 'contract' as never, entityId: testId('con', 1) },
      },
      {
        envelope: testEventEnvelope({
          eventName: 'intelligence.marginAssessed',
          scope: projectOneScope(),
          causality: { correlationId: correlation('corr-00000002'), causationId: null },
          occurredAt: T4,
          aggregate: { entityKind: 'contract' as never, entityId: testId('con', 1) },
          payload: { assessmentId: 'assessment-0001' },
        }),
        aggregate: { entityKind: 'contract' as never, entityId: testId('con', 1) },
      },
    ];
    const events = await memoryLedgerOf([...outcomeAppends, ...noise]);
    const store = unwrap(projectMemory(events));

    expect(store.outcomes).toHaveLength(3); // nothing invented from the noise
    expect(store.derivation.projectedEventCount).toBe(5); // 3 recognized + 2 skipped
    expect(store.derivation.skippedEventNames).toStrictEqual([
      { eventName: 'contracts.contractCreated', count: 1 },
      { eventName: 'intelligence.marginAssessed', count: 1 },
    ]);
  });
});

describe('THE rebuild discipline: projections never become canonical truth (OFF-015, A2/A7)', () => {
  it('folding the same event stream twice yields the identical store', async () => {
    const events = await goldenMemoryEvents();
    const first = unwrap(projectMemory(events));
    const second = unwrap(projectMemory(events));

    expect(JSON.stringify(second.outcomes)).toBe(JSON.stringify(first.outcomes));
    expect(JSON.stringify(second.benchmarks)).toBe(JSON.stringify(first.benchmarks));
    expect(JSON.stringify(second.lessons)).toBe(JSON.stringify(first.lessons));
    expect(JSON.stringify(second.derivation)).toBe(JSON.stringify(first.derivation));
  });

  it('tampering with the served memory NEVER propagates into a rebuild', async () => {
    const events = await goldenMemoryEvents();
    const pristine = unwrap(projectMemory(events));
    const pristineJson = JSON.stringify(pristine.outcomes);
    const pristineBenchmarkJson = JSON.stringify(pristine.benchmarks);
    const originalMargin = pristine.outcomeOf(testOutcomeId(1))?.margin.marginMinor;

    // Tamper with the served projection content: the outcome's margin and
    // the benchmark's producing ids (memory content is typed readonly, so
    // the tamper goes through the same hostile cast any DB row edit would).
    const tamperedOutcome = pristine.outcomeOf(testOutcomeId(1)) as unknown as {
      margin: { marginMinor: number; marginRatio: { numerator: number } };
    };
    tamperedOutcome.margin.marginMinor = 999999;
    tamperedOutcome.margin.marginRatio.numerator = 999999;
    const tamperedBenchmark = pristine.benchmarkOf(testBenchmarkId(1)) as unknown as {
      metrics: { outcomeIds: string[] }[];
    };
    const metricZero = tamperedBenchmark.metrics[0];
    if (metricZero === undefined) throw new Error('metric missing');
    metricZero.outcomeIds = ['outcome-999999'];

    // The tamper LANDED in the served store (the projection was edited)...
    expect(pristine.outcomeOf(testOutcomeId(1))?.margin.marginMinor).toBe(999999);
    expect(metricZero.outcomeIds).toStrictEqual(['outcome-999999']);

    // ...but the rebuild — a fold of the SAME events, from scratch —
    // discards it entirely: the event stream is the only source.
    const rebuilt = unwrap(projectMemory(events));
    expect(JSON.stringify(rebuilt.outcomes)).toBe(pristineJson);
    expect(JSON.stringify(rebuilt.benchmarks)).toBe(pristineBenchmarkJson);
    expect(rebuilt.outcomeOf(testOutcomeId(1))?.margin.marginMinor).toBe(originalMargin);
    expect(rebuilt.benchmarkOf(testBenchmarkId(1))?.metrics[0]?.outcomeIds).toStrictEqual([
      testOutcomeId(1),
      testOutcomeId(2),
      testOutcomeId(3),
    ]);
    // And a rebuild of the REBUILT stream is still identical (no drift loop).
    expect(JSON.stringify(unwrap(projectMemory(events)).outcomes)).toBe(pristineJson);
  });

  it('the store exposes its own derivation provenance (never canonical truth)', async () => {
    const events = await goldenMemoryEvents();
    const store = unwrap(projectMemory(events));

    // Every served record carries derivation provenance: the engine, the
    // schema version, the recorded-at clock, the actor, the scope — plus
    // (outcomes) the full evidence spine.
    for (const outcome of store.outcomes) {
      expect(outcome.engine).toBe('intelligence-memory');
      expect(outcome.outcomeVersion).toBe(1);
      expect(outcome.evidence.length).toBeGreaterThan(0);
    }
    for (const benchmark of store.benchmarks) {
      expect(benchmark.engine).toBe('intelligence-memory');
      expect(benchmark.outcomeCount).toBeGreaterThan(0);
    }
    for (const lesson of store.lessons) {
      expect(lesson.engine).toBe('intelligence-memory');
      expect(lesson.provenance.engine).toBe('intelligence-memory');
    }
  });
});

describe('outcome immutability — a fact of history (OFF-015)', () => {
  it('typed-rejects a SECOND outcome for the same project', async () => {
    const run = await runCompletedProject(GOLDEN_PROJECT_ONE);
    const first = outcomeOfRun(run);
    const second = unwrap(
      // Same project, different outcome id: history records ONE outcome.
      deriveOutcome(
        { facts: run.facts, assessments: run.assessments },
        {
          outcomeId: testOutcomeId(99),
          recordedAt: T5,
          actor: USER_ACTOR,
          scope: run.spec.scope,
        },
      ),
    );
    const events = await memoryLedgerOf([
      outcomeAppendOf(first),
      outcomeAppendOf(second),
    ]);

    const result = projectMemory(events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('project-outcome-already-recorded');
    }
  });

  it('typed-rejects a conflicting re-record under the same outcome id', async () => {
    const run = await runCompletedProject(GOLDEN_PROJECT_ONE);
    const first = outcomeOfRun(run);
    const conflicting = unwrap(
      deriveOutcome(
        { facts: run.facts, assessments: run.assessments },
        {
          outcomeId: testOutcomeId(1),
          recordedAt: T4, // different recorded-at → different content
          actor: USER_ACTOR,
          scope: run.spec.scope,
        },
      ),
    );
    const events = await memoryLedgerOf([
      outcomeAppendOf(first),
      outcomeAppendOf(conflicting),
    ]);

    const result = projectMemory(events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('outcome-already-recorded');
    }
  });

  it('treats at-least-once redelivery of the SAME outcome event as a no-op', async () => {
    const outcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_ONE));
    const append = outcomeAppendOf(outcome);
    // The ledger records the envelope twice (two distinct ledger events).
    const events = await memoryLedgerOf([append, append]);
    const store = unwrap(projectMemory(events));

    expect(store.outcomes).toHaveLength(1);
    expect(store.derivation.recognizedEventNames).toStrictEqual([
      { eventName: 'intelligence.outcomeRecorded', count: 2 },
    ]);
    expect(store.derivation.outcomeCount).toBe(1);
  });

  it('treats redelivered lesson and benchmark events as no-ops too', async () => {
    const outcomes = await goldenOutcomes();
    const outcomeAppends = outcomes.map(outcomeAppendOf);
    const outcomeOnlyEvents = await memoryLedgerOf(outcomeAppends);
    const anchor = causalityOf(outcomeOnlyEvents[outcomeOnlyEvents.length - 1] as never);
    const benchmark = unwrap(
      computeBenchmarks(outcomes, {
        benchmarkId: testBenchmarkId(1),
        computedAt: T5,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      }),
    );
    const lesson = goldenLesson();
    const benchmarkAppend = benchmarkAppendOf(benchmark, anchor);
    const lessonAppend = lessonAppendOf(lesson, {
      correlationId: 'corr-00000099',
      causationId: null,
    });
    const events = await memoryLedgerOf([
      ...outcomeAppends,
      benchmarkAppend,
      benchmarkAppend, // redelivered
      lessonAppend,
      lessonAppend, // redelivered
    ]);
    const store = unwrap(projectMemory(events));

    expect(store.benchmarks).toHaveLength(1);
    expect(store.lessons).toHaveLength(1);
    expect(store.derivation.recognizedEventNames).toStrictEqual([
      { eventName: 'intelligence.benchmarkComputed', count: 2 },
      { eventName: 'intelligence.lessonCaptured', count: 2 },
      { eventName: 'intelligence.outcomeRecorded', count: 3 },
    ]);
  });
});

describe('the no-drift benchmark gate (OFF-015)', () => {
  const driftedStream = async (mutate: (benchmark: Benchmark) => Benchmark) => {
    const outcomes = await goldenOutcomes();
    const outcomeAppends = outcomes.map(outcomeAppendOf);
    const outcomeOnlyEvents = await memoryLedgerOf(outcomeAppends);
    const anchor = causalityOf(outcomeOnlyEvents[outcomeOnlyEvents.length - 1] as never);
    const benchmark = mutate(
      unwrap(
        computeBenchmarks(outcomes, {
          benchmarkId: testBenchmarkId(1),
          computedAt: T5,
          actor: USER_ACTOR,
          scope: tenantAWideScope(),
        }),
      ),
    );
    const events = await memoryLedgerOf([
      ...outcomeAppends,
      benchmarkAppendOf(benchmark, anchor),
    ]);
    return projectMemory(events);
  };

  it('typed-rejects a benchmark whose values drifted from its outcome set', async () => {
    // The stored min schedule variance is edited to a lie: the pure
    // recomputation over the SAME outcome ids disagrees → typed rejection.
    const result = await driftedStream((benchmark) => ({
      ...benchmark,
      metrics: benchmark.metrics.map((metric) =>
        metric.kind === 'schedule-variance-days'
          ? { ...metric, min: { numerator: 999, denominator: 1 } }
          : metric,
      ),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('benchmark-drifted');
    }
  });

  it('typed-rejects a benchmark naming an outcome the stream never recorded', async () => {
    const result = await driftedStream((benchmark) => ({
      ...benchmark,
      metrics: benchmark.metrics.map((metric) => ({
        ...metric,
        outcomeIds: [
          ...metric.outcomeIds.slice(0, 2),
          'outcome-999999' as OutcomeId,
        ],
      })),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('benchmark-outcome-missing');
    }
  });

  it('accepts the pure recomputation itself (the honest snapshot folds)', async () => {
    const result = await driftedStream((benchmark) => benchmark);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.benchmarks).toHaveLength(1);
    }
  });
});

describe('lesson immutability + fold fail-closed parsing (OFF-015)', () => {
  it('typed-rejects a conflicting lesson re-capture under the same id', async () => {
    const lesson = goldenLesson();
    const conflicting = unwrap(
      captureLesson(
        {
          title: 'A different title entirely',
          statement: lesson.statement,
          applicability: lesson.applicability,
          links: lesson.links,
          provenance: { origin: 'human', author: USER_ACTOR, derivedFromOutcomeIds: [] },
        },
        {
          lessonId: testLessonId(1),
          capturedAt: T5,
          actor: USER_ACTOR,
          scope: projectOneScope(),
        },
      ),
    );
    const events = await memoryLedgerOf([
      lessonAppendOf(lesson, { correlationId: 'corr-00000098', causationId: null }),
      lessonAppendOf(conflicting, { correlationId: 'corr-00000097', causationId: null }),
    ]);

    const result = projectMemory(events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('lesson-already-captured');
    }
  });

  it('fails closed on a recognized event name with a malformed payload', async () => {
    const garbage: MemoryAppend = {
      envelope: testEventEnvelope({
        eventName: OUTCOME_RECORDED_EVENT,
        scope: projectOneScope(),
        causality: { correlationId: correlation('corr-00000096'), causationId: null },
        occurredAt: T4,
        aggregate: { entityKind: 'project' as never, entityId: testId('prj', 1) },
        payload: { garbage: true },
      }),
      aggregate: { entityKind: 'project' as never, entityId: testId('prj', 1) },
    };
    const events = await memoryLedgerOf([garbage]);

    const result = projectMemory(events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('memory-payload-valid');
    }
  });

  it('fails closed on a recognized lesson event with a strict-keys violation', async () => {
    const lesson = goldenLesson();
    const badLesson: MemoryAppend = {
      envelope: testEventEnvelope({
        eventName: LESSON_CAPTURED_EVENT,
        scope: projectOneScope(),
        causality: { correlationId: correlation('corr-00000095'), causationId: null },
        occurredAt: T4,
        aggregate: { entityKind: 'project' as never, entityId: testId('prj', 1) },
        // The canonical lesson payload + one extra field: strict keys fail.
        payload: { ...lessonPayload(lesson), extra: true },
      }),
      aggregate: { entityKind: 'project' as never, entityId: testId('prj', 1) },
    };
    const events = await memoryLedgerOf([badLesson]);

    const result = projectMemory(events);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('memory-payload-valid');
    }
  });

  it('an empty stream folds into the empty store (a projection of nothing)', () => {
    const store = unwrap(projectMemory([]));
    expect(store.outcomes).toStrictEqual([]);
    expect(store.lessons).toStrictEqual([]);
    expect(store.benchmarks).toStrictEqual([]);
    expect(store.derivation.projectedEventCount).toBe(0);
    expect(store.outcomeOf('outcome-000001')).toBeNull();
    expect(store.lessonOf('lesson-000001')).toBeNull();
    expect(store.benchmarkOf('benchmark-000001')).toBeNull();
    expect(store.outcomeOfProject(testId('prj', 1) as never)).toBeNull();
  });
});

describe('store read surface typing (OFF-015)', () => {
  it('the fold output is read-only data + lookup helpers (never a writer)', async () => {
    const events = await goldenMemoryEvents();
    const store: MemoryStore = unwrap(projectMemory(events));

    expect(typeof store.outcomeOf).toBe('function');
    expect(typeof store.outcomeOfProject).toBe('function');
    expect(typeof store.lessonOf).toBe('function');
    expect(typeof store.benchmarkOf).toBe('function');
    expect(Object.keys(store).sort()).toStrictEqual([
      'benchmarkOf',
      'benchmarks',
      'derivation',
      'lessonOf',
      'lessons',
      'outcomeOf',
      'outcomeOfProject',
      'outcomes',
    ]);
  });
});
