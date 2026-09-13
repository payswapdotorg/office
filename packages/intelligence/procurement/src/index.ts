// Office intelligence — public surface (OFF-034).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-037 end-to-end integration, OFF-040 analytics) consume the package
// only through its root entry point, never through deeper paths. Anything
// not re-exported here is package-internal and may change without notice.
//
// The package imports exactly seven workspace dependencies — @office/contracts
// (envelope + entity/identity/command contracts + parse helpers),
// @office/domain-kernel (Result/DomainError), @office/authz (deny-by-default
// procurement access + structural scope isolation), @office/domain-cost
// (the canonical commitment/invoice model — the typed READ surface the
// comparison consumes, through the domain's derived reads only: never its
// transitions, commands, or sinks), @office/agents (the EvidenceSet TYPE
// discipline — type-only), @office/intelligence-margin (the
// ImpactAssessment values — the projected economic impact basis,
// referenced never re-derived), and @office/intelligence-memory (the
// outcome records + benchmark facts — the historical basis, and the
// exact-Rational shape) — plus node builtins. No new external
// dependencies; NO AI/LLM/network dependency of ANY kind (comparison +
// ranking are deterministic typed computation over the evidence).
//
// Surface summary:
// - vocabulary:  PROCUREMENT_RECOMMENDATION_PROPOSED_EVENT,
//                PROCUREMENT_KINDS, PROCUREMENT_KIND_GRAMMAR,
//                parse/isProcurementKind, VENDOR_PERFORMANCE_LEVELS,
//                VENDOR_PERFORMANCE_GRAMMAR, parse/isVendorPerformanceLevel,
//                VENDOR_KEY_GRAMMAR, parse/isVendorKey,
//                PROCUREMENT_SCAN_ID_GRAMMAR, parse/isProcurementScanId,
//                ALTERNATIVE_ID_GRAMMAR, parse/isAlternativeId,
//                RECOMMENDATION_ID_GRAMMAR, parse/isRecommendationId,
//                COMPARISON_ID_GRAMMAR, parse/isComparisonId,
//                parseAlternativeOutcomeIds,
//                PROCUREMENT_REQUIRED_CAPABILITIES,
//                PROCUREMENT_REQUIRED_CAPABILITY_NAMES
// - model:       ProcurementEvidence (+Record/Event/Assessment/Outcome/
//                BenchmarkSource), compareProcurementEvidence,
//                canonicalProcurementEvidence, ProducingLedgerEventId,
//                ProcurementEvidenceSet, PriceComparison,
//                DeliveryComparison, VendorPerformanceRating (+Reason),
//                ProcurementRiskFactor (+Kind), ProcurementEconomicImpact
//                (+Component +Citation +Role), ProcurementHistoricalBasis
//                (+HistoricalBenchmarkFact), Rational arithmetic
//                (add/multiply/min/compare/reduce +
//                procurementRationalOf + RATIONAL_ZERO/ONE),
//                PreferenceWeights (+ DEFAULT_PREFERENCE_WEIGHTS,
//                PREFERENCE_WEIGHTS_GRAMMAR), PREFERENCE_FORMULA,
//                PreferenceScore (+Economic/DeliveryScoreComponent),
//                EconomicScale, DeliveryScale, ProposedNextAction
//                (+Confidence/Reasons, ActionCommandReference,
//                ProcurementPolicyDecision), the three suggested command
//                constants, the entity-kind constants,
//                compareReferencedRecords
// - comparison:  ProcurementAlternative (+ the fail-closed
//                parseProcurementAlternative), normalizedAmountMinorOf,
//                LEAD_TIME_DAYS_MAX, PERFORMANCE_STRONG_SHARE,
//                PERFORMANCE_ACCEPTABLE_SHARE, vendorPerformanceOf,
//                ProcurementNeed, procurementNeedsOf, VendorComparison
//                (+Row +RowRisk), COMPARISON_SCHEMA_VERSION,
//                PROCUREMENT_ENGINE, buildVendorComparison
// - recommendation: ProcurementRecommendation, SelectedAlternative,
//                RankedRecommendation is ranking's — DetectionProvenance,
//                ProcurementPrimarySource, RECOMMENDATION_SCHEMA_VERSION,
//                detectProcurementRecommendations (THE deterministic
//                detection pass), ProcurementScanInputs, ScanParts, the
//                typed threshold tables (SWITCH_MIN_SAVING_SHARE,
//                TIMING_MIN_LEAD_GAIN_DAYS,
//                TIMING_MIN_ASSESSED_DELAY_DAYS),
//                qualifyProcurementEvidenceSet (THE A4 gate),
//                PROCUREMENT_DETECTION_TOOL
// - ranking:     rankProcurementRecommendations (THE deterministic seeded
//                prioritization), compareRankedPreference, leadGainDaysOf
// - proposal:    proposeNextActions (SUGGESTIONS ONLY — no execution
//                path), commitProcurementDecision (THE policy-gated
//                commitment: a typed rejection without an explicit policy
//                decision, a ProposedNextAction record with one)
// - authorization: ProcurementAuthorization, checkProcurementCapabilities,
//                checkProcurementScopeCovers, checkProcurementPolicy,
//                procurementResource, procurementRecommendationNotFound,
//                queryProcurementRecommendations,
//                queryProcurementRecommendationById, ProcurementQuery
// - audit:       procurementRecommendationProposedEnvelope,
//                emitProcurementRecommendationProposed,
//                PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR,
//                ProcurementEventSink, ProcurementSinkExecutor,
//                InMemoryProcurementEventSink,
//                createInMemoryProcurementEventSink,
//                RecordedProcurementAppend, procurementSinkFailure,
//                failingProcurementEventSink
//
// src/test-support.ts and src/scenarios.ts are package-INTERNAL test
// modules (deterministic fixture factories + the golden seeded
// procurement scenarios) — they are not part of the public surface.

// The procurement vocabulary + the scan/recommendation/comparison identity grammars.
export {
  ALTERNATIVE_ID_GRAMMAR,
  COMPARISON_ID_GRAMMAR,
  PROCUREMENT_KINDS,
  PROCUREMENT_KIND_GRAMMAR,
  PROCUREMENT_RECOMMENDATION_PROPOSED_EVENT,
  PROCUREMENT_REQUIRED_CAPABILITIES,
  PROCUREMENT_REQUIRED_CAPABILITY_NAMES,
  PROCUREMENT_SCAN_ID_GRAMMAR,
  RECOMMENDATION_ID_GRAMMAR,
  VENDOR_KEY_GRAMMAR,
  VENDOR_PERFORMANCE_GRAMMAR,
  VENDOR_PERFORMANCE_LEVELS,
  isAlternativeId,
  isComparisonId,
  isProcurementKind,
  isProcurementScanId,
  isRecommendationId,
  isVendorKey,
  isVendorPerformanceLevel,
  parseAlternativeId,
  parseAlternativeOutcomeIds,
  parseComparisonId,
  parseProcurementKind,
  parseProcurementScanId,
  parseRecommendationId,
  parseVendorKey,
  parseVendorPerformanceLevel,
} from './vocabulary';
export type {
  AlternativeId,
  ComparisonId,
  ProcurementKind,
  ProcurementScanId,
  RecommendationId,
  VendorKey,
  VendorPerformanceLevel,
} from './vocabulary';

// The shared procurement model + the exposed preference-score composition.
export {
  AMEND_COMMITMENT_COMMAND,
  BUDGET_KIND,
  CLOSE_COMMITMENT_COMMAND,
  COMMITMENT_KIND,
  COST_ITEM_KIND,
  CREATE_COMMITMENT_COMMAND,
  DEFAULT_PREFERENCE_WEIGHTS,
  PREFERENCE_FORMULA,
  PREFERENCE_WEIGHTS_GRAMMAR,
  PROJECT_KIND,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  addRationals,
  canonicalProcurementEvidence,
  compareProcurementEvidence,
  compareReferencedRecords,
  minRationals,
  multiplyRationals,
  procurementRationalOf,
  rationalCompare,
  reduceProcurementRational,
} from './model';
export type {
  ActionCommandReference,
  DeliveryComparison,
  DeliveryScale,
  DeliveryScoreComponent,
  EconomicCitation,
  EconomicComponentRole,
  EconomicImpactComponent,
  EconomicScale,
  EconomicScoreComponent,
  HistoricalBenchmarkFact,
  PreferenceScore,
  PreferenceWeights,
  PriceComparison,
  ProcurementAssessmentSource,
  ProcurementBenchmarkSource,
  ProcurementEconomicImpact,
  ProcurementEvidence,
  ProcurementEvidenceSet,
  ProcurementEventSource,
  ProcurementHistoricalBasis,
  ProcurementOutcomeSource,
  ProcurementPolicyDecision,
  ProcurementRecordSource,
  ProcurementRiskFactor,
  ProcurementRiskFactorKind,
  ProducingLedgerEventId,
  ProposedConfidence,
  ProposedConfidenceLevel,
  ProposedConfidenceReason,
  ProposedNextAction,
  VendorPerformanceRating,
  VendorPerformanceReason,
} from './model';

// THE vendor comparison contracts.
export {
  COMPARISON_SCHEMA_VERSION,
  LEAD_TIME_DAYS_MAX,
  PERFORMANCE_ACCEPTABLE_SHARE,
  PERFORMANCE_STRONG_SHARE,
  PROCUREMENT_ENGINE,
  buildVendorComparison,
  normalizedAmountMinorOf,
  parseProcurementAlternative,
  procurementNeedsOf,
  vendorPerformanceOf,
} from './comparison';
export type {
  ProcurementAlternative,
  ProcurementNeed,
  ProcurementRowRisk,
  VendorComparison,
  VendorComparisonRow,
} from './comparison';

// THE recommendation record + the deterministic detection pass.
export {
  PROCUREMENT_DETECTION_TOOL,
  RECOMMENDATION_SCHEMA_VERSION,
  SWITCH_MIN_SAVING_SHARE,
  TIMING_MIN_ASSESSED_DELAY_DAYS,
  TIMING_MIN_LEAD_GAIN_DAYS,
  detectProcurementRecommendations,
  qualifyProcurementEvidenceSet,
} from './recommendation';
export type {
  DetectionProvenance,
  ProcurementPrimarySource,
  ProcurementRecommendation,
  ProcurementScanInputs,
  ScanParts,
  SelectedAlternative,
} from './recommendation';

// THE deterministic seeded prioritization.
export { compareRankedPreference, leadGainDaysOf, rankProcurementRecommendations } from './ranking';
export type { RankedRecommendation } from './ranking';

// The proposed next actions (SUGGESTIONS ONLY) + the policy-gated commitment.
export { commitProcurementDecision, proposeNextActions } from './proposal';

// Permissioned procurement reads (authorization BEFORE scans/queries).
export {
  checkProcurementCapabilities,
  checkProcurementPolicy,
  checkProcurementScopeCovers,
  procurementRecommendationNotFound,
  procurementResource,
  queryProcurementRecommendationById,
  queryProcurementRecommendations,
} from './authorization';
export type { ProcurementAuthorization, ProcurementQuery } from './authorization';

// Procurement audit events + the mirrored EventSink port.
export {
  PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR,
  createInMemoryProcurementEventSink,
  emitProcurementRecommendationProposed,
  failingProcurementEventSink,
  procurementRecommendationProposedEnvelope,
  procurementSinkFailure,
} from './audit';
export type {
  InMemoryProcurementEventSink,
  ProcurementEventSink,
  ProcurementSinkExecutor,
  RecordedProcurementAppend,
} from './audit';
