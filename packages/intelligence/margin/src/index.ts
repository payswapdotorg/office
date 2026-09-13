// Office intelligence — public surface (OFF-014).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-015 enterprise memory, OFF-018 recommendations, OFF-019 agents,
// OFF-033/034 chips) consume the package only through its root entry
// point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package imports exactly five workspace dependencies — @office/contracts
// (envelope + entity/identity contracts + parse helpers),
// @office/domain-kernel (Result/DomainError), @office/authz (deny-by-default
// assessment access + structural scope isolation),
// @office/events (the ledger READ surface + deterministic ledger event id
// derivation; this package never writes the ledger through it), and
// @office/intelligence-relationships (the ONE intelligence peer — the
// authorization-filtered traversal subgraphs the calculations consume) —
// plus node builtins. No new external dependencies. The domain packages
// (organization/projects/documents/field/schedule/cost/contracts) are
// NEVER imported: their event SHAPES are consumed through typed facts
// folded from the @office/contracts envelope payloads (the margin engine
// is an intelligence projection, not a domain peer — the dependency rule).
//
// Surface summary:
// - vocabulary:  RECOGNIZED_COMMERCIAL_EVENT_NAMES,
//                isRecognizedCommercialEventName, CHANGE_EVENT_RAISED_EVENT,
//                MARGIN_ASSESSED_EVENT, ASSESSMENT_ID_GRAMMAR,
//                parse/isAssessmentId, ASSESSMENT_REQUIRED_CAPABILITIES,
//                ASSESSMENT_REQUIRED_CAPABILITY_NAMES (+ the entity-kind
//                constants the impact links reference)
// - model:       ImpactAssessment, ImpactQuery (+ parse/is, IMPACT_QUERY_GRAMMAR),
//                ImpactInputs, SourceEventReference, ChangeEventSource,
//                CostImpact, CostItemDelta, ScheduleImpact,
//                ActivityForecastDelta, EntitlementPosition,
//                ChangeOrderEntitlement, MarginPosition, MarginLayer,
//                AssessmentConfidence (+Level/Reason), AssessmentPolicyContext,
//                ASSESSMENT_SCHEMA_VERSION, ASSESSMENT_ENGINE,
//                CurrencyCode (+parse), compareSourceEventReferences,
//                canonicalEvidence
// - facts:       CommercialFacts + every fact type (ContractFact,
//                ChangeEventFact, ChangeOrderFact, ClaimReferenceFact,
//                BudgetFact, CostItemFact, BudgetRevisionFact,
//                CommitmentFact, ActivityFact, DurationAssertion,
//                ProgressFact, DependencyFact, BaselineFact, FactSource,
//                CommercialDerivation, CommercialEventNameTally),
//                projectCommercialFacts (the deterministic, rebuildable fold)
// - calculation: calculateImpact (THE pure, deterministic function),
//                AssessmentParts
// - authorization: AssessmentAuthorization, checkAssessmentCapabilities,
//                checkAssessmentScopeCovers, checkAssessmentPolicy,
//                assessmentResource, crossScopeInputRejection,
//                sourceEventNotFound
// - events:      marginAssessmentEnvelope, emitMarginAssessment,
//                MARGIN_ASSESSED_PAYLOAD_GRAMMAR, AssessmentEventSink,
//                AssessmentSinkExecutor, InMemoryAssessmentEventSink,
//                createInMemoryAssessmentEventSink, RecordedAssessmentAppend,
//                assessmentSinkFailure, failingAssessmentEventSink
//
// src/test-support.ts and src/scenarios.ts are package-INTERNAL test
// modules (deterministic envelope factories and golden scenario
// fixtures) — they are not part of the public surface.

// The commercial vocabulary + the assessment identity grammar.
export {
  ASSESSMENT_ID_GRAMMAR,
  ASSESSMENT_REQUIRED_CAPABILITIES,
  ASSESSMENT_REQUIRED_CAPABILITY_NAMES,
  CHANGE_EVENT_RAISED_EVENT,
  MARGIN_ASSESSED_EVENT,
  RECOGNIZED_COMMERCIAL_EVENT_NAMES,
  isAssessmentId,
  isRecognizedCommercialEventName,
  parseAssessmentId,
} from './vocabulary';
export type { AssessmentId } from './vocabulary';

// The assessment model + the entity-kind constants of the impact links.
export {
  ACTIVITY_KIND,
  ASSESSMENT_ENGINE,
  ASSESSMENT_SCHEMA_VERSION,
  BASELINE_KIND,
  BUDGET_KIND,
  BUDGET_REVISION_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CLAIM_REFERENCE_KIND,
  COMMITMENT_KIND,
  CONTRACT_KIND,
  COST_ITEM_KIND,
  CURRENCY_CODE_GRAMMAR,
  DEPENDENCY_KIND,
  IMPACT_QUERY_GRAMMAR,
  canonicalEvidence,
  compareSourceEventReferences,
  isImpactQuery,
  parseCurrencyCode,
  parseImpactQuery,
} from './model';
export type {
  ActivityForecastDelta,
  AssessmentConfidence,
  AssessmentConfidenceLevel,
  AssessmentConfidenceReason,
  AssessmentPolicyContext,
  ChangeEventSource,
  ChangeOrderEntitlement,
  CostImpact,
  CostItemDelta,
  CurrencyCode,
  EntitlementPosition,
  ImpactAssessment,
  ImpactInputs,
  ImpactQuery,
  MarginLayer,
  MarginPosition,
  ScheduleImpact,
  SourceEventReference,
} from './model';

// The deterministic, rebuildable commercial facts fold (freeze A2/A7).
export { projectCommercialFacts } from './facts';
export type {
  ActivityFact,
  BaselineFact,
  BudgetFact,
  BudgetRevisionFact,
  ChangeEventFact,
  ChangeOrderFact,
  ClaimReferenceFact,
  CommercialDerivation,
  CommercialEventNameTally,
  CommercialFacts,
  CommitmentFact,
  CostItemFact,
  DependencyFact,
  DurationAssertion,
  FactSource,
  ProgressFact,
} from './facts';

// THE pure, deterministic impact calculation.
export { calculateImpact } from './calculation';
export type { AssessmentParts } from './calculation';

// Assessment authorization (deny-by-default, before calculation).
export {
  assessmentResource,
  checkAssessmentCapabilities,
  checkAssessmentPolicy,
  checkAssessmentScopeCovers,
  crossScopeInputRejection,
  sourceEventNotFound,
} from './authorization';
export type { AssessmentAuthorization } from './authorization';

// Assessment events + the mirrored EventSink port.
export {
  MARGIN_ASSESSED_PAYLOAD_GRAMMAR,
  assessmentSinkFailure,
  createInMemoryAssessmentEventSink,
  emitMarginAssessment,
  failingAssessmentEventSink,
  marginAssessmentEnvelope,
} from './assessment-events';
export type {
  AssessmentEventSink,
  AssessmentSinkExecutor,
  InMemoryAssessmentEventSink,
  RecordedAssessmentAppend,
} from './assessment-events';
