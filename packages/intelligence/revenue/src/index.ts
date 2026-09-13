// Office intelligence — public surface (OFF-033).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-037 end-to-end integration, OFF-040 analytics) consume the package
// only through its root entry point, never through deeper paths. Anything
// not re-exported here is package-internal and may change without notice.
//
// The package imports exactly seven workspace dependencies — @office/contracts
// (envelope + entity/identity/command contracts + parse helpers),
// @office/domain-kernel (Result/DomainError), @office/authz (deny-by-default
// recovery access + structural scope isolation), @office/domain-contracts
// (the canonical contracts/change model — the typed READ surface the
// detection consumes; type-only, never mutated), @office/agents (the
// EvidenceSet TYPE discipline — type-only), @office/intelligence-margin
// (the ImpactAssessment values — the economic basis, referenced never
// re-derived), and @office/intelligence-memory (the outcome records +
// benchmark facts — the historical basis, and the exact-Rational shape) —
// plus node builtins. No new external dependencies; NO AI/LLM/network
// dependency of ANY kind (detection + ranking are deterministic typed
// computation over the evidence).
//
// Surface summary:
// - vocabulary:  RECOVERY_DETECTED_EVENT, RECOVERY_KINDS,
//                RECOVERY_KIND_GRAMMAR, parse/isRecoveryKind,
//                SEVERITY_LEVELS, SEVERITY_LEVEL_GRAMMAR,
//                parse/isSeverityLevel, CANDIDATE_ID_GRAMMAR,
//                RECOVERY_SCAN_ID_GRAMMAR, parse/isCandidateId,
//                parse/isRecoveryScanId, RECOVERY_REQUIRED_CAPABILITIES,
//                RECOVERY_REQUIRED_CAPABILITY_NAMES
// - model:       RecoveryEvidence (+Record/Event/Assessment/Outcome/
//                BenchmarkSource), compareRecoveryEvidence,
//                canonicalRecoveryEvidence, ProducingLedgerEventId,
//                CandidateEvidenceSet, RecoverySeverity (+Reason),
//                RecoveryEconomicBasis (+Citation), RecoveryHistoricalBasis
//                (+HistoricalBenchmarkFact), Rational arithmetic
//                (add/multiply/min/compare/reduce + recoveryRationalOf +
//                RATIONAL_ZERO/ONE), PriorityWeights (+ DEFAULT_,
//                PRIORITY_WEIGHTS_GRAMMAR), PRIORITY_FORMULA, severityRankOf,
//                PriorityScore (+Severity/EconomicScoreComponent),
//                ProposedNextAction (+Confidence/Reasons,
//                ActionCommandReference, RecoveryPolicyDecision), the three
//                suggested command constants, the entity-kind constants,
//                compareReferencedRecords
// - candidates:  CandidateRecovery, RankedCandidate, DetectionProvenance,
//                RecoveryPrimarySource, CANDIDATE_SCHEMA_VERSION,
//                RECOVERY_ENGINE, compareCandidates
// - detection:   detectRecoveryCandidates (THE deterministic detection
//                pass), RecoveryScanInputs, ScanParts, the typed threshold
//                tables + gates (CONSTRUCTIVE/ENTITLEMENT_SHARE_THRESHOLDS,
//                DELAY_IMPACT_THRESHOLDS_DAYS, DELAY_IMPACT_MIN_DAYS,
//                REBALANCE_MIN_APPROVAL_RATE,
//                REBALANCE_DIVERGENCE_APPROVAL_RATE),
//                qualifyRecoveryEvidenceSet (THE A4 gate),
//                RECOVERY_DETECTION_TOOL
// - prioritization: rankRecoveryCandidates (THE deterministic seeded
//                prioritization), compareRankedPriority
// - proposal:    proposeNextActions (SUGGESTIONS ONLY — no execution
//                path), assertRecoveryClaim (THE policy-gated assertion:
//                a typed rejection without an explicit policy decision,
//                a ProposedNextAction record with one)
// - authorization: RecoveryAuthorization, checkRecoveryCapabilities,
//                checkRecoveryScopeCovers, checkRecoveryPolicy,
//                recoveryResource, recoveryCandidateNotFound,
//                queryRecoveryCandidates, queryRecoveryCandidateById,
//                RecoveryQuery
// - audit:       recoveryCandidateDetectedEnvelope, emitRecoveryCandidateDetected,
//                RECOVERY_DETECTED_PAYLOAD_GRAMMAR, RecoveryEventSink,
//                RecoverySinkExecutor, InMemoryRecoveryEventSink,
//                createInMemoryRecoveryEventSink, RecordedRecoveryAppend,
//                recoverySinkFailure, failingRecoveryEventSink
//
// src/test-support.ts and src/scenarios.ts are package-INTERNAL test
// modules (deterministic fixture factories + the golden seeded recovery
// scenarios) — they are not part of the public surface.

// The recovery vocabulary + the scan/candidate identity grammars.
export {
  CANDIDATE_ID_GRAMMAR,
  RECOVERY_DETECTED_EVENT,
  RECOVERY_KINDS,
  RECOVERY_KIND_GRAMMAR,
  RECOVERY_REQUIRED_CAPABILITIES,
  RECOVERY_REQUIRED_CAPABILITY_NAMES,
  RECOVERY_SCAN_ID_GRAMMAR,
  SEVERITY_LEVELS,
  SEVERITY_LEVEL_GRAMMAR,
  isCandidateId,
  isRecoveryKind,
  isRecoveryScanId,
  isSeverityLevel,
  parseCandidateId,
  parseRecoveryKind,
  parseRecoveryScanId,
  parseSeverityLevel,
} from './vocabulary';
export type { CandidateId, RecoveryKind, RecoveryScanId, SeverityLevel } from './vocabulary';

// The shared recovery model + the exposed priority-score composition.
export {
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CLAIM_REFERENCE_KIND,
  CONTRACT_KIND,
  DEFAULT_PRIORITY_WEIGHTS,
  LINK_CHANGE_REFERENCES_COMMAND,
  PRIORITY_FORMULA,
  PRIORITY_WEIGHTS_GRAMMAR,
  PROJECT_KIND,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  REFERENCE_CLAIM_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  addRationals,
  canonicalRecoveryEvidence,
  compareReferencedRecords,
  compareRecoveryEvidence,
  minRationals,
  multiplyRationals,
  rationalCompare,
  recoveryRationalOf,
  reduceRecoveryRational,
  severityRankOf,
} from './model';
export type {
  ActionCommandReference,
  CandidateEvidenceSet,
  EconomicScale,
  EconomicScoreComponent,
  HistoricalBenchmarkFact,
  PriorityScore,
  PriorityWeights,
  ProducingLedgerEventId,
  ProposedConfidence,
  ProposedConfidenceLevel,
  ProposedConfidenceReason,
  ProposedNextAction,
  RecoveryAssessmentSource,
  RecoveryBenchmarkSource,
  RecoveryEconomicBasis,
  RecoveryEconomicCitation,
  RecoveryEvidence,
  RecoveryEventSource,
  RecoveryHistoricalBasis,
  RecoveryOutcomeSource,
  RecoveryPolicyDecision,
  RecoveryRecordSource,
  RecoverySeverity,
  RecoverySeverityReason,
  SeverityScoreComponent,
} from './model';

// THE recovery candidate record.
export {
  CANDIDATE_SCHEMA_VERSION,
  RECOVERY_ENGINE,
  compareCandidates,
} from './candidates';
export type {
  CandidateRecovery,
  DetectionProvenance,
  RankedCandidate,
  RecoveryPrimarySource,
} from './candidates';

// THE deterministic detection pass + the typed threshold tables + the
// evidence-set qualification gate.
export {
  CONSTRUCTIVE_SHARE_THRESHOLDS,
  DELAY_IMPACT_MIN_DAYS,
  DELAY_IMPACT_THRESHOLDS_DAYS,
  ENTITLEMENT_SHARE_THRESHOLDS,
  REBALANCE_DIVERGENCE_APPROVAL_RATE,
  REBALANCE_MIN_APPROVAL_RATE,
  RECOVERY_DETECTION_TOOL,
  detectRecoveryCandidates,
  qualifyRecoveryEvidenceSet,
} from './detection';
export type { RecoveryScanInputs, ScanParts } from './detection';

// THE deterministic seeded prioritization.
export { compareRankedPriority, rankRecoveryCandidates } from './prioritization';

// The proposed next actions (SUGGESTIONS ONLY) + the policy-gated assertion.
export { assertRecoveryClaim, proposeNextActions } from './proposal';

// Permissioned recovery reads (authorization BEFORE scans/queries).
export {
  checkRecoveryCapabilities,
  checkRecoveryPolicy,
  checkRecoveryScopeCovers,
  queryRecoveryCandidateById,
  queryRecoveryCandidates,
  recoveryCandidateNotFound,
  recoveryResource,
} from './authorization';
export type { RecoveryAuthorization, RecoveryQuery } from './authorization';

// Recovery audit events + the mirrored EventSink port.
export {
  RECOVERY_DETECTED_PAYLOAD_GRAMMAR,
  createInMemoryRecoveryEventSink,
  emitRecoveryCandidateDetected,
  failingRecoveryEventSink,
  recoveryCandidateDetectedEnvelope,
  recoverySinkFailure,
} from './audit';
export type {
  InMemoryRecoveryEventSink,
  RecordedRecoveryAppend,
  RecoveryEventSink,
  RecoverySinkExecutor,
} from './audit';
