// Office intelligence — the memory module's vocabulary (OFF-015).
//
// The typed vocabulary of the enterprise memory module: the memory event
// names emitted through the MemoryEventSink port (outcome recorded /
// benchmark computed / lesson captured — the derived stream downstream
// consumers OFF-018/019/034/035 treat like any other domain event), the
// caller-supplied identity grammars of the three record kinds, and the area
// read capabilities a memory read must hold.
//
// The event names declare their owning area ('intelligence') exactly like
// the margin engine's 'intelligence.marginAssessed' (bounded context 14
// surface; enterprise memory & benchmarking is bounded context 13, carried
// by the same intelligence package family). The literals mirror the landed
// convention: '<area>.<camelCaseFact>'.
import { parseEventName, parseFail, parseOk } from '@office/contracts';
import type { EventName, ParseResult } from '@office/contracts';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';

const eventNameLiteral = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid event name literal: ${name}`);
  }
  return parsed.value;
};

// ---------------------------------------------------------------------------
// The emitted memory events (A3/A4): every recorded outcome, computed
// benchmark snapshot, and captured lesson emits exactly one
// DomainEventEnvelope through the MemoryEventSink port, so memory behaves
// like any other derived stream. The store projection folds exactly these
// three names back into the rebuildable memory store (A7).
// ---------------------------------------------------------------------------

/** Event name of the outcome-recorded memory event. */
export const OUTCOME_RECORDED_EVENT: EventName = eventNameLiteral(
  'intelligence.outcomeRecorded',
);

/** Event name of the benchmark-computed memory event. */
export const BENCHMARK_COMPUTED_EVENT: EventName = eventNameLiteral(
  'intelligence.benchmarkComputed',
);

/** Event name of the lesson-captured memory event. */
export const LESSON_CAPTURED_EVENT: EventName = eventNameLiteral(
  'intelligence.lessonCaptured',
);

/** Every ledger event name the memory store projection recognizes. */
export const RECOGNIZED_MEMORY_EVENT_NAMES: readonly EventName[] = [
  OUTCOME_RECORDED_EVENT,
  BENCHMARK_COMPUTED_EVENT,
  LESSON_CAPTURED_EVENT,
];

const recognizedEventNameSet = new Set<string>(RECOGNIZED_MEMORY_EVENT_NAMES);

/** Is this event name one the memory store projection recognizes (vs. skips)? */
export function isRecognizedMemoryEventName(name: EventName): boolean {
  return recognizedEventNameSet.has(name);
}

// ---------------------------------------------------------------------------
// The caller-supplied identity grammars of the three record kinds. All
// three are opaque printable-ASCII tokens (8..128 chars, no whitespace) —
// the same grammar family as the margin engine's AssessmentId: the runtime
// injects deterministic ids (never this package — no clock, no randomness).
// ---------------------------------------------------------------------------

/** Grammar description used in parse failures. */
export const OUTCOME_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

/** Grammar description used in parse failures. */
export const BENCHMARK_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

/** Grammar description used in parse failures. */
export const LESSON_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

const describeToken = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  return typeof raw;
};

const TOKEN_PATTERN = /^[\x21-\x7e]{8,128}$/;

declare const outcomeIdBrand: unique symbol;

/** Caller-supplied identity of one recorded outcome (deterministic token). */
export type OutcomeId = string & {
  readonly [outcomeIdBrand]: 'OutcomeId';
};

/** Parse an untrusted value as an OutcomeId (total, fail-closed). */
export function parseOutcomeId(raw: unknown): ParseResult<OutcomeId> {
  if (typeof raw !== 'string' || !TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', OUTCOME_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as OutcomeId);
}

/** Type guard for canonical OutcomeId values. */
export function isOutcomeId(raw: unknown): raw is OutcomeId {
  return parseOutcomeId(raw).ok;
}

declare const benchmarkIdBrand: unique symbol;

/** Caller-supplied identity of one computed benchmark (deterministic token). */
export type BenchmarkId = string & {
  readonly [benchmarkIdBrand]: 'BenchmarkId';
};

/** Parse an untrusted value as a BenchmarkId (total, fail-closed). */
export function parseBenchmarkId(raw: unknown): ParseResult<BenchmarkId> {
  if (typeof raw !== 'string' || !TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', BENCHMARK_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as BenchmarkId);
}

/** Type guard for canonical BenchmarkId values. */
export function isBenchmarkId(raw: unknown): raw is BenchmarkId {
  return parseBenchmarkId(raw).ok;
}

declare const lessonIdBrand: unique symbol;

/** Caller-supplied identity of one captured lesson (deterministic token). */
export type LessonId = string & {
  readonly [lessonIdBrand]: 'LessonId';
};

/** Parse an untrusted value as a LessonId (total, fail-closed). */
export function parseLessonId(raw: unknown): ParseResult<LessonId> {
  if (typeof raw !== 'string' || !TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', LESSON_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as LessonId);
}

/** Type guard for canonical LessonId values. */
export function isLessonId(raw: unknown): raw is LessonId {
  return parseLessonId(raw).ok;
}

// ---------------------------------------------------------------------------
// Memory read capabilities. A memory outcome/benchmark spans the same three
// bounded contexts the margin assessments it derives from span (the
// contract/commercial position, the cost position, the schedule position),
// so a permissioned memory read requires all three area read capabilities
// BEFORE any record is queried — a request that cannot read one of the
// three areas never sees a single outcome fact. The closed capability
// vocabulary lives in @office/authz (areas only, no intelligence area is
// declared); memory reuses exactly the three commercial area reads the
// assessments carried.
// ---------------------------------------------------------------------------

/** The area read capabilities every memory read must hold. */
export const MEMORY_REQUIRED_CAPABILITIES: readonly Capability[] = [
  capability('contracts.read'),
  capability('cost.read'),
  capability('schedule.read'),
];

/** The area read capability names, in canonical order (error messages). */
export const MEMORY_REQUIRED_CAPABILITY_NAMES: readonly string[] = [
  'contracts.read',
  'cost.read',
  'schedule.read',
];
