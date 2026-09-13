// Office intelligence — the rebuildable memory store projection (OFF-015).
//
// projectMemory() folds a ledger event stream — the recorded
// intelligence.outcomeRecorded / intelligence.benchmarkComputed /
// intelligence.lessonCaptured events — into the memory store: the served
// outcomes, lessons, and benchmark snapshots. It is the memory module's
// PROJECTION (freeze A2/A7): derived, rebuildable, replaceable — NEVER a
// second source of truth. THE discipline this module proves:
//
// - REBUILDABILITY: the store is a pure function of its input events —
//   folding the same stream twice yields the identical store, and folding
//   from scratch after the served content was tampered with yields the
//   pristine store again (tampering NEVER propagates into a rebuild; the
//   event stream is the only source).
// - PROJECTIONS NEVER BECOME CANONICAL TRUTH: every served record carries
//   its derivation provenance (engine, schema version, recorded-at, actor,
//   scope, and the full evidence spine), and the store itself exposes its
//   own derivation metadata (what was folded, what was skipped).
// - IMMUTABLE FACTS OF HISTORY: an outcome is recorded once per project
//   (a second outcome for the same project is a typed invariant
//   violation); idempotent at-least-once redelivery of the SAME event is
//   a deterministic no-op (freeze A3); a conflicting re-record with the
//   same id is a typed invariant violation.
// - NO DRIFTING BENCHMARKS: a recorded benchmark snapshot must equal the
//   PURE recomputation (computeBenchmarks) over exactly its named outcome
//   ids — a drifted snapshot is a typed invariant violation at fold time.
//
// Event-name recognition: exactly RECOGNIZED_MEMORY_EVENT_NAMES. Unknown
// event names (every domain event, every assessment event — those are the
// DERIVATION inputs, not store inputs) are SKIPPED deterministically and
// tallied — never a crash, never a silent data invention. A RECOGNIZED
// event name with a malformed payload fails closed instead.
import type { EntityId, EventName } from '@office/contracts';
import type { LedgerEvent } from '@office/events';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  BENCHMARK_COMPUTED_EVENT,
  LESSON_CAPTURED_EVENT,
  OUTCOME_RECORDED_EVENT,
  isRecognizedMemoryEventName,
} from './vocabulary';
import { computeBenchmarks } from './benchmark';
import { parseBenchmarkPayload, parseLessonPayload, parseOutcomePayload } from './memory-events';
import type { Benchmark, Lesson, OutcomeRecord } from './model';

// ---------------------------------------------------------------------------
// The store model.
// ---------------------------------------------------------------------------

/** One event-name tally of the store derivation metadata. */
export interface MemoryEventNameTally {
  readonly eventName: EventName;
  readonly count: number;
}

/** How the store was derived — the fold's own audit trail. */
export interface MemoryDerivation {
  /** Every event the fold consumed (recognized + skipped). */
  readonly projectedEventCount: number;
  /** How many outcome records the store serves. */
  readonly outcomeCount: number;
  /** How many lessons the store serves. */
  readonly lessonCount: number;
  /** How many benchmark snapshots the store serves. */
  readonly benchmarkCount: number;
  /** The recognized memory event names, tallied (canonical name order). */
  readonly recognizedEventNames: readonly MemoryEventNameTally[];
  /** The skipped event names, tallied (canonical name order). */
  readonly skippedEventNames: readonly MemoryEventNameTally[];
}

/**
 * THE memory store: the deterministic, rebuildable projection of the
 * recorded memory events. Collections are canonically sorted (outcomes by
 * outcome id, lessons by lesson id, benchmarks by benchmark id); the
 * lookup helpers are read-only. The store NEVER mutates after the fold.
 */
export interface MemoryStore {
  /** The fold's own audit trail (what was projected, what was skipped). */
  readonly derivation: MemoryDerivation;
  /** Every served outcome record, canonical outcome-id order. */
  readonly outcomes: readonly OutcomeRecord[];
  /** Every served lesson, canonical lesson-id order. */
  readonly lessons: readonly Lesson[];
  /** Every served benchmark snapshot, canonical benchmark-id order. */
  readonly benchmarks: readonly Benchmark[];
  /** The outcome record of one outcome id, or null. */
  outcomeOf(outcomeId: string): OutcomeRecord | null;
  /** The recorded outcome of one project, or null (one outcome per project). */
  outcomeOfProject(projectId: EntityId): OutcomeRecord | null;
  /** The lesson of one lesson id, or null. */
  lessonOf(lessonId: string): Lesson | null;
  /** The benchmark snapshot of one benchmark id, or null. */
  benchmarkOf(benchmarkId: string): Benchmark | null;
}

// ---------------------------------------------------------------------------
// The fold's fail-closed errors.
// ---------------------------------------------------------------------------

const storeViolation = (name: string, message: string): DomainError =>
  domainError(
    'invariant-violation',
    `the memory store cannot fold the stream: ${message}`,
    [{ code: name, message, path: null }],
  );

const outcomeAlreadyRecorded = (outcomeId: string): DomainError =>
  storeViolation(
    'outcome-already-recorded',
    `outcome ${outcomeId} is already recorded with different content (an outcome is a fact of history — re-recording is a typed violation)`,
  );

const projectOutcomeAlreadyRecorded = (projectId: string, outcomeId: string): DomainError =>
  storeViolation(
    'project-outcome-already-recorded',
    `project ${projectId} already carries its recorded outcome (a completed project records ONE outcome); the conflicting outcome id is ${outcomeId}`,
  );

const lessonAlreadyCaptured = (lessonId: string): DomainError =>
  storeViolation(
    'lesson-already-captured',
    `lesson ${lessonId} is already captured with different content (re-capture with new content is a typed violation)`,
  );

const benchmarkAlreadyRecorded = (benchmarkId: string): DomainError =>
  storeViolation(
    'benchmark-already-recorded',
    `benchmark ${benchmarkId} is already recorded with different content (a benchmark snapshot is immutable)`,
  );

const benchmarkOutcomeMissing = (benchmarkId: string, outcomeId: string): DomainError =>
  storeViolation(
    'benchmark-outcome-missing',
    `benchmark ${benchmarkId} names outcome ${outcomeId}, which the stream has not recorded (benchmarks fold after the outcomes they were computed over)`,
  );

const benchmarkDrifted = (benchmarkId: string): DomainError =>
  storeViolation(
    'benchmark-drifted',
    `benchmark ${benchmarkId} drifted from its outcome set: the recorded values do not equal the pure recomputation over exactly its named outcome ids`,
  );

// ---------------------------------------------------------------------------
// Canonical JSON (deterministic structural equality — sorted keys).
// ---------------------------------------------------------------------------

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const structurallyEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

// ---------------------------------------------------------------------------
// THE fold.
// ---------------------------------------------------------------------------

interface FoldState {
  readonly outcomes: Map<string, OutcomeRecord>;
  readonly outcomesByProject: Map<string, OutcomeRecord>;
  readonly lessons: Map<string, Lesson>;
  readonly benchmarks: Map<string, Benchmark>;
  readonly recognized: Map<string, number>;
  readonly skipped: Map<string, number>;
  projectedEventCount: number;
}

const talliesOf = (counts: Map<string, number>): readonly MemoryEventNameTally[] =>
  [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([eventName, count]) => ({ eventName: eventName as EventName, count }));

/**
 * Fold a ledger event stream into THE memory store — the deterministic,
 * rebuildable projection (freeze A2/A7). THE rebuild function: folding the
 * same events always yields the identical store, from scratch, with no
 * other input (tampered store content never survives a rebuild).
 */
export function projectMemory(
  events: readonly LedgerEvent[],
): Result<MemoryStore, DomainError> {
  const state: FoldState = {
    outcomes: new Map(),
    outcomesByProject: new Map(),
    lessons: new Map(),
    benchmarks: new Map(),
    recognized: new Map(),
    skipped: new Map(),
    projectedEventCount: 0,
  };

  for (const event of events) {
    state.projectedEventCount += 1;
    const name = event.envelope.eventName as string;
    if (!isRecognizedMemoryEventName(event.envelope.eventName)) {
      state.skipped.set(name, (state.skipped.get(name) ?? 0) + 1);
      continue;
    }
    state.recognized.set(name, (state.recognized.get(name) ?? 0) + 1);

    if (name === OUTCOME_RECORDED_EVENT) {
      const outcome = parseOutcomePayload(event.envelope.payload);
      if (!outcome.ok) return outcome;
      // An outcome is recorded under a PROJECT scope (the completed project
      // it records) — anything else fails closed at the fold boundary.
      if (outcome.value.scope.kind !== 'project') {
        return fail(
          storeViolation(
            'outcome-scope-project',
            `outcome ${outcome.value.outcomeId} is recorded under a non-project scope`,
          ),
        );
      }
      const existing = state.outcomes.get(outcome.value.outcomeId);
      if (existing !== undefined) {
        if (!structurallyEqual(existing, outcome.value)) {
          return fail(outcomeAlreadyRecorded(outcome.value.outcomeId));
        }
        continue; // idempotent at-least-once redelivery (freeze A3)
      }
      const projectOutcome = state.outcomesByProject.get(outcome.value.projectId);
      if (projectOutcome !== undefined) {
        return fail(projectOutcomeAlreadyRecorded(outcome.value.projectId, outcome.value.outcomeId));
      }
      state.outcomes.set(outcome.value.outcomeId, outcome.value);
      state.outcomesByProject.set(outcome.value.projectId, outcome.value);
      continue;
    }

    if (name === LESSON_CAPTURED_EVENT) {
      const lesson = parseLessonPayload(event.envelope.payload);
      if (!lesson.ok) return lesson;
      const existing = state.lessons.get(lesson.value.lessonId);
      if (existing !== undefined) {
        if (!structurallyEqual(existing, lesson.value)) {
          return fail(lessonAlreadyCaptured(lesson.value.lessonId));
        }
        continue; // idempotent at-least-once redelivery (freeze A3)
      }
      state.lessons.set(lesson.value.lessonId, lesson.value);
      continue;
    }

    if (name === BENCHMARK_COMPUTED_EVENT) {
      const benchmark = parseBenchmarkPayload(event.envelope.payload);
      if (!benchmark.ok) return benchmark;
      const existing = state.benchmarks.get(benchmark.value.benchmarkId);
      if (existing !== undefined) {
        if (!structurallyEqual(existing, benchmark.value)) {
          return fail(benchmarkAlreadyRecorded(benchmark.value.benchmarkId));
        }
        continue; // idempotent at-least-once redelivery (freeze A3)
      }
      // THE drift gate: the recorded snapshot must equal the pure
      // recomputation over exactly its named outcome ids (ledger order
      // records the outcomes before the benchmarks computed over them).
      const namedOutcomes: OutcomeRecord[] = [];
      for (const outcomeId of producingOutcomeIdsOf(benchmark.value)) {
        const named = state.outcomes.get(outcomeId);
        if (named === undefined) {
          return fail(benchmarkOutcomeMissing(benchmark.value.benchmarkId, outcomeId));
        }
        namedOutcomes.push(named);
      }
      if (namedOutcomes.length !== benchmark.value.outcomeCount) {
        return fail(
          benchmarkDrifted(benchmark.value.benchmarkId),
        );
      }
      const recomputed = computeBenchmarks(namedOutcomes, {
        benchmarkId: benchmark.value.benchmarkId,
        computedAt: benchmark.value.computedAt,
        actor: benchmark.value.actor,
        scope: benchmark.value.scope,
      });
      if (!recomputed.ok) return recomputed;
      if (!structurallyEqual(recomputed.value, benchmark.value)) {
        return fail(benchmarkDrifted(benchmark.value.benchmarkId));
      }
      state.benchmarks.set(benchmark.value.benchmarkId, benchmark.value);
      continue;
    }
  }

  const outcomes = [...state.outcomes.values()].sort((left, right) =>
    left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0,
  );
  const lessons = [...state.lessons.values()].sort((left, right) =>
    left.lessonId < right.lessonId ? -1 : left.lessonId > right.lessonId ? 1 : 0,
  );
  const benchmarks = [...state.benchmarks.values()].sort((left, right) =>
    left.benchmarkId < right.benchmarkId ? -1 : left.benchmarkId > right.benchmarkId ? 1 : 0,
  );

  return ok({
    derivation: {
      projectedEventCount: state.projectedEventCount,
      outcomeCount: outcomes.length,
      lessonCount: lessons.length,
      benchmarkCount: benchmarks.length,
      recognizedEventNames: talliesOf(state.recognized),
      skippedEventNames: talliesOf(state.skipped),
    },
    outcomes,
    lessons,
    benchmarks,
    outcomeOf: (outcomeId) => state.outcomes.get(outcomeId) ?? null,
    outcomeOfProject: (projectId) => state.outcomesByProject.get(projectId) ?? null,
    lessonOf: (lessonId) => state.lessons.get(lessonId) ?? null,
    benchmarkOf: (benchmarkId) => state.benchmarks.get(benchmarkId) ?? null,
  } satisfies MemoryStore);
}

/** The producing outcome ids of one benchmark (the union over its metrics). */
const producingOutcomeIdsOf = (benchmark: Benchmark): readonly string[] => {
  const ids = new Set<string>();
  for (const metric of benchmark.metrics) {
    for (const outcomeId of metric.outcomeIds) {
      ids.add(outcomeId);
    }
  }
  return [...ids].sort();
};
