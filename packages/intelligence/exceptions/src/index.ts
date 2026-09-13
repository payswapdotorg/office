// Office intelligence — public surface (OFF-019).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-030 views, OFF-033 agent runtime, OFF-035 chips) consume the
// package only through its root entry point, never through deeper paths.
// Anything not re-exported here is package-internal and may change without
// notice.
//
// The package imports exactly seven workspace dependencies — @office/contracts
// (envelope + entity/identity/command contracts + parse helpers),
// @office/domain-kernel (Result/DomainError), @office/authz (deny-by-default
// exception access + structural scope isolation), @office/events
// (LedgerEventId identity; this package never writes the ledger through
// it), @office/intelligence-relationships (the authorization-filtered
// traversal subgraphs the dependency-risk rule computes over),
// @office/intelligence-margin (the ImpactAssessment values — the economic
// numbers every rule computes over), and @office/intelligence-memory (the
// benchmark facts that calibrate severity + the exact-rational shape) —
// plus node builtins. No new external dependencies; NO AI/LLM/network
// dependency of ANY kind (detection + ranking are deterministic typed
// computation over the evidence).
//
// Surface summary:
// - vocabulary:  EXCEPTION_DETECTED_EVENT, EXCEPTION_KINDS,
//                EXCEPTION_KIND_GRAMMAR, parse/isExceptionKind,
//                SEVERITY_LEVELS, SEVERITY_LEVEL_GRAMMAR,
//                parse/isSeverityLevel, EXCEPTION_ID_GRAMMAR,
//                SCAN_ID_GRAMMAR, parse/isExceptionId, parse/isScanId,
//                EXCEPTION_REQUIRED_CAPABILITIES,
//                EXCEPTION_REQUIRED_CAPABILITY_NAMES
// - model:       Exception, ExceptionKind, ExceptionId, ScanId,
//                SeverityLevel, ExceptionSeverity (+Reason),
//                EconomicImpact, EconomicScale, DetectionProvenance,
//                ExceptionPrimarySource, ExceptionEvidence (+Event/
//                Assessment/BenchmarkSource), compareExceptionEvidence,
//                canonicalExceptionEvidence, EXCEPTION_SCHEMA_VERSION,
//                EXCEPTIONS_ENGINE, compareExceptions, Rational arithmetic
//                (add/multiply/min/compare/reduce + exceptionRationalOf +
//                RATIONAL_ZERO/ONE), PriorityWeights (+ DEFAULT_,
//                PRIORITY_WEIGHTS_GRAMMAR), PRIORITY_FORMULA, severityRankOf,
//                PriorityScore (+Severity/EconomicScoreComponent),
//                RankedException, NextAction (+Confidence/Reasons,
//                ActionCommandReference), the eight suggested command
//                constants, the entity-kind constants, compareAffectedEntities
// - scan:        detectExceptions (THE deterministic detection pass),
//                ExceptionScanInputs, ScanParts, the typed threshold tables
//                (SCHEDULE_SLIP_THRESHOLDS_DAYS, ECONOMIC_SHARE_THRESHOLDS,
//                DEPENDENCY_THRESHOLDS_COUNT, SCHEDULE_SLIP_MIN_DAYS)
// - rank:        rankExceptions (THE deterministic seeded prioritization),
//                compareRankedPriority
// - next-actions: suggestNextActions (SUGGESTIONS ONLY — no execution path)
// - authorization: ExceptionAuthorization, checkExceptionCapabilities,
//                checkExceptionScopeCovers, checkExceptionPolicy,
//                exceptionResource, exceptionNotFound, queryExceptions,
//                queryExceptionById, ExceptionQuery
// - events:      exceptionDetectedEnvelope, emitExceptionDetected,
//                EXCEPTION_DETECTED_PAYLOAD_GRAMMAR, ExceptionEventSink,
//                ExceptionSinkExecutor, InMemoryExceptionEventSink,
//                createInMemoryExceptionEventSink, RecordedExceptionAppend,
//                exceptionSinkFailure, failingExceptionEventSink
//
// src/test-support.ts and src/scenarios.ts are package-INTERNAL test
// modules (deterministic envelope factories + the golden seeded control-
// tower scenarios) — they are not part of the public surface.

// The exception vocabulary + the scan/exception identity grammars.
export {
  EXCEPTION_DETECTED_EVENT,
  EXCEPTION_ID_GRAMMAR,
  EXCEPTION_KINDS,
  EXCEPTION_KIND_GRAMMAR,
  EXCEPTION_REQUIRED_CAPABILITIES,
  EXCEPTION_REQUIRED_CAPABILITY_NAMES,
  SCAN_ID_GRAMMAR,
  SEVERITY_LEVELS,
  SEVERITY_LEVEL_GRAMMAR,
  isExceptionId,
  isExceptionKind,
  isScanId,
  isSeverityLevel,
  parseExceptionId,
  parseExceptionKind,
  parseScanId,
  parseSeverityLevel,
} from './vocabulary';
export type { ExceptionId, ExceptionKind, ScanId, SeverityLevel } from './vocabulary';

// The exception model + the exposed priority-score composition.
export {
  ACTIVITY_KIND,
  APPROVE_CHANGE_ORDER_COMMAND,
  BUDGET_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CONTRACT_KIND,
  DEFAULT_PRIORITY_WEIGHTS,
  DEPENDENCY_KIND,
  EXCEPTIONS_ENGINE,
  EXCEPTION_SCHEMA_VERSION,
  LINK_CHANGE_REFERENCES_COMMAND,
  PRIORITY_FORMULA,
  PRIORITY_WEIGHTS_GRAMMAR,
  PROJECT_KIND,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  RECORD_PROGRESS_COMMAND,
  REJECT_CHANGE_ORDER_COMMAND,
  REVISE_BUDGET_COMMAND,
  SET_BASELINE_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  addRationals,
  canonicalExceptionEvidence,
  compareAffectedEntities,
  compareExceptionEvidence,
  compareExceptions,
  exceptionRationalOf,
  minRationals,
  multiplyRationals,
  rationalCompare,
  reduceExceptionRational,
  severityRankOf,
} from './model';
export type {
  ActionCommandReference,
  DetectionProvenance,
  EconomicImpact,
  EconomicScale,
  EconomicScoreComponent,
  Exception,
  ExceptionAssessmentSource,
  ExceptionBenchmarkSource,
  ExceptionEvidence,
  ExceptionEventSource,
  ExceptionPrimarySource,
  ExceptionSeverity,
  ExceptionSeverityReason,
  NextAction,
  NextActionConfidence,
  NextActionConfidenceLevel,
  NextActionConfidenceReason,
  PriorityScore,
  PriorityWeights,
  RankedException,
  SeverityScoreComponent,
} from './model';

// THE deterministic detection pass + the typed threshold tables.
export {
  DEPENDENCY_THRESHOLDS_COUNT,
  ECONOMIC_SHARE_THRESHOLDS,
  SCHEDULE_SLIP_MIN_DAYS,
  SCHEDULE_SLIP_THRESHOLDS_DAYS,
  detectExceptions,
} from './scan';
export type { ExceptionScanInputs, ScanParts } from './scan';

// THE deterministic seeded prioritization.
export { compareRankedPriority, rankExceptions } from './rank';

// The suggested next actions (SUGGESTIONS ONLY).
export { suggestNextActions } from './next-actions';

// Permissioned exception reads (authorization BEFORE scans/queries).
export {
  checkExceptionCapabilities,
  checkExceptionPolicy,
  checkExceptionScopeCovers,
  exceptionNotFound,
  exceptionResource,
  queryExceptionById,
  queryExceptions,
} from './authorization';
export type { ExceptionAuthorization, ExceptionQuery } from './authorization';

// Exception events + the mirrored EventSink port.
export {
  EXCEPTION_DETECTED_PAYLOAD_GRAMMAR,
  createInMemoryExceptionEventSink,
  emitExceptionDetected,
  exceptionDetectedEnvelope,
  exceptionSinkFailure,
  failingExceptionEventSink,
} from './exception-events';
export type {
  ExceptionEventSink,
  ExceptionSinkExecutor,
  InMemoryExceptionEventSink,
  RecordedExceptionAppend,
} from './exception-events';
