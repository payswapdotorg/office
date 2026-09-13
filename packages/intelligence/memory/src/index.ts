// Office intelligence — public surface (OFF-015).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-018 agent runtime, OFF-019 control tower, OFF-034/035 chips)
// consume the package only through its root entry point, never through
// deeper paths. Anything not re-exported here is package-internal and may
// change without notice.
//
// The package imports exactly six workspace dependencies — @office/contracts
// (envelope + entity/identity contracts + parse helpers),
// @office/domain-kernel (Result/DomainError), @office/authz (deny-by-default
// permissioned memory reads + structural scope isolation), @office/events
// (the ledger READ surface + LedgerEventId identity; this package never
// writes the ledger through it), @office/intelligence-margin (the
// ImpactAssessment values + the commercial facts fold that outcome
// derivation consumes), and @office/intelligence-relationships (the
// authorization-filtered traversal subgraphs the similarity feature vectors
// consume) — plus node builtins. No new external dependencies; NO
// AI/LLM/embedding/network dependency of ANY kind (similarity is
// deterministic typed computation over typed feature vectors).
//
// Surface summary:
// - vocabulary:  OUTCOME_RECORDED_EVENT, BENCHMARK_COMPUTED_EVENT,
//                LESSON_CAPTURED_EVENT, RECOGNIZED_MEMORY_EVENT_NAMES,
//                isRecognizedMemoryEventName, OUTCOME/BENCHMARK/LESSON_ID
//                grammars + parse/is helpers, MEMORY_REQUIRED_CAPABILITIES,
//                MEMORY_REQUIRED_CAPABILITY_NAMES
// - model:       Rational (+ RATIONAL_ZERO/ONE, RATIONAL_COMPONENT_MAX,
//                RATIONAL_GRAMMAR, rationalOf, reduceRational,
//                compareRationals, rationalsEqual, parseRational),
//                OutcomeRecord (+ every outcome sub-model), Benchmark (+
//                metric stats/positions), Lesson (+ tags/links/provenance),
//                ProjectFeatureVector + similarity query/candidate types,
//                OutcomeQuery/LessonQuery (+ parse helpers), evidence
//                comparators, schema versions, MEMORY_ENGINE, PROJECT_KIND
// - outcome:     deriveOutcome (THE deterministic outcome capture),
//                OutcomeInputs, OutcomeIdentity
// - benchmark:   computeBenchmarks (THE pure outcome-set function),
//                BenchmarkParts
// - lesson:      captureLesson (THE deterministic lesson capture),
//                LessonContent, LessonProvenanceInput, LessonIdentity,
//                lessonAppliesToArea
// - similarity:  projectFeatureVector, rankSimilarProjects,
//                DEFAULT_SIMILARITY_WEIGHTS, DEFAULT_SIMILARITY_LIMIT
// - store:       projectMemory (THE deterministic, rebuildable fold),
//                MemoryStore, MemoryDerivation, MemoryEventNameTally
// - authorization: MemoryAuthorization, checkMemoryCapabilities,
//                checkMemoryScopeCovers, checkMemoryPolicy, memoryResource,
//                memoryOutcomeNotFound, queryOutcomes, queryLessons
// - events:      outcomeRecordedEnvelope, benchmarkComputedEnvelope,
//                lessonCapturedEnvelope (+ emit conveniences), payload
//                builders/parsers, MemoryEventSink, MemorySinkExecutor,
//                InMemoryMemoryEventSink, createInMemoryMemoryEventSink,
//                memorySinkFailure, failingMemoryEventSink
//
// src/test-support.ts is a package-INTERNAL test module (deterministic
// envelope factories + the golden completed-project scenarios) — it is not
// part of the public surface.

// The memory vocabulary + the three record-identity grammars.
export {
  BENCHMARK_COMPUTED_EVENT,
  BENCHMARK_ID_GRAMMAR,
  LESSON_CAPTURED_EVENT,
  LESSON_ID_GRAMMAR,
  MEMORY_REQUIRED_CAPABILITIES,
  MEMORY_REQUIRED_CAPABILITY_NAMES,
  OUTCOME_ID_GRAMMAR,
  OUTCOME_RECORDED_EVENT,
  RECOGNIZED_MEMORY_EVENT_NAMES,
  isBenchmarkId,
  isLessonId,
  isOutcomeId,
  isRecognizedMemoryEventName,
  parseBenchmarkId,
  parseLessonId,
  parseOutcomeId,
} from './vocabulary';
export type { BenchmarkId, LessonId, OutcomeId } from './vocabulary';

// The typed memory model (rational arithmetic + the three record kinds).
export {
  BENCHMARK_METRIC_KINDS,
  BENCHMARK_METRIC_KIND_GRAMMAR,
  BENCHMARK_SCHEMA_VERSION,
  FEATURE_KINDS,
  FEATURE_KIND_GRAMMAR,
  LESSON_AREAS,
  LESSON_AREA_GRAMMAR,
  LESSON_QUERY_GRAMMAR,
  LESSON_SCHEMA_VERSION,
  LESSON_TAG_VALUE_GRAMMAR,
  MEMORY_ENGINE,
  OUTCOME_QUERY_GRAMMAR,
  OUTCOME_SCHEMA_VERSION,
  PROJECT_KIND,
  RATIONAL_COMPONENT_MAX,
  RATIONAL_GRAMMAR,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  SIMILARITY_QUERY_GRAMMAR,
  canonicalOutcomeEvidence,
  compareAssessmentSources,
  compareLessonLinks,
  compareLessonTags,
  compareOutcomeEvidence,
  compareRationals,
  isSimilarityQuery,
  parseBenchmarkMetricKind,
  parseFeatureKind,
  parseLessonArea,
  parseLessonQuery,
  parseLessonTag,
  parseOutcomeQuery,
  parseRational,
  parseSimilarityQuery,
  rationalOf,
  rationalsEqual,
  reduceRational,
} from './model';
export type {
  Benchmark,
  BenchmarkMetricKind,
  BenchmarkMetricStats,
  BenchmarkPosition,
  ChangePressureOutcome,
  ContractMarginPosition,
  EntitlementOrderOutcome,
  EntitlementOrderStatus,
  EntitlementOutcome,
  FeatureKind,
  FeatureValue,
  Lesson,
  LessonArea,
  LessonLink,
  LessonProvenance,
  LessonQuery,
  LessonTag,
  MarginOutcome,
  OutcomeAssessmentSource,
  OutcomeEventSource,
  OutcomeEvidence,
  OutcomeQuery,
  OutcomeRecord,
  ProjectFeatureVector,
  Rational,
  ScheduleOutcome,
  SimilarityCandidate,
  SimilarityComponent,
  SimilarityQuery,
  SimilarityWeight,
} from './model';

// THE deterministic outcome capture.
export { deriveOutcome } from './outcome';
export type { OutcomeIdentity, OutcomeInputs } from './outcome';

// THE pure benchmark computation.
export { computeBenchmarks } from './benchmark';
export type { BenchmarkParts } from './benchmark';

// THE deterministic lesson capture.
export { LESSON_STATEMENT_GRAMMAR, LESSON_TITLE_GRAMMAR, captureLesson, lessonAppliesToArea } from './lesson';
export type { LessonContent, LessonIdentity, LessonProvenanceInput } from './lesson';

// THE typed similarity contracts.
export {
  DEFAULT_SIMILARITY_LIMIT,
  DEFAULT_SIMILARITY_WEIGHTS,
  projectFeatureVector,
  rankSimilarProjects,
} from './similarity';

// THE deterministic, rebuildable memory store projection.
export { projectMemory } from './store';
export type { MemoryDerivation, MemoryEventNameTally, MemoryStore } from './store';

// Permissioned memory reads (authorization BEFORE queries).
export {
  checkMemoryCapabilities,
  checkMemoryPolicy,
  checkMemoryScopeCovers,
  memoryOutcomeNotFound,
  memoryResource,
  queryLessons,
  queryOutcomes,
} from './authorization';
export type { MemoryAuthorization } from './authorization';

// Memory events + the mirrored EventSink port.
export {
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
export type {
  InMemoryMemoryEventSink,
  MemoryCausality,
  MemoryEventSink,
  MemorySinkExecutor,
  RecordedMemoryAppend,
} from './memory-events';
