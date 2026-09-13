// Office intelligence — public surface (OFF-035).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-038 release gates, OFF-040 analytics) consume the package only
// through its root entry point, never through deeper paths. Anything not
// re-exported here is package-internal and may change without notice.
//
// The package imports exactly seven workspace dependencies —
// @office/adapters-sdk (the provider-neutral observed-system vocabulary:
// the AdapterCapabilities typed read surface, re-parsed fail-closed — the
// engine never imports an adapter implementation), @office/app-sdk (the
// AppManifest/PermissionSpec vocabulary: the declared app surfaces),
// @office/marketplace (the AppRelease/Entitlement/InstallationLink records:
// what is installed per tenant, re-parsed fail-closed),
// @office/intelligence-memory (the OutcomeRecord/Benchmark facts — the
// observed-performance basis, referenced ids only — plus the exact-Rational
// shape every derived score is), @office/contracts (envelope + entity/
// identity contracts + parse helpers), @office/domain-kernel
// (Result/DomainError), and @office/authz (deny-by-default authorization +
// the closed capability vocabulary and its canonical order) — plus node
// builtins. No new external dependencies; NO AI/LLM/network dependency of
// ANY kind (coverage measurement and score derivation are deterministic
// typed computation over the referenced records).
//
// Surface summary:
// - vocabulary:  STACK_ASSESSED_EVENT, ASSESSMENT_KINDS,
//                ASSESSMENT_KIND_GRAMMAR, parse/isAssessmentKind,
//                SUGGESTION_KINDS, SUGGESTION_KIND_GRAMMAR,
//                parse/isSuggestionKind, ASSESSMENT_ID_GRAMMAR,
//                STACK_SCAN_ID_GRAMMAR, parse/isAssessmentId,
//                parse/isStackScanId, ASSESSMENT_ID_SEPARATOR,
//                ASSESSMENT_ORDINAL_WIDTH, EXTERNAL_SYSTEM_KIND,
//                APP_INSTALLATION_KIND, APP_ENTITLEMENT_KIND,
//                BENCHMARK_KIND, PROJECT_KIND,
//                STACK_REQUIRED_CAPABILITIES,
//                STACK_REQUIRED_CAPABILITY_NAMES
// - model:       StackEvidence (+ExternalSystemRef/AppInstallationRef),
//                compare/canonicalStackEvidence, compareExternalSystemRefs,
//                compareAppInstallationRefs, compareCapabilities,
//                PerformanceBasis, REPLACEMENT_FORMULA, SCORE_SCHEMA_VERSION,
//                ReplacementScore (the exposed composition),
//                SUGGESTION_SCHEMA_VERSION, ReplacementSuggestion,
//                STACK_ENGINE, assessmentKindOrder, suggestionKindOrder,
//                PinnedAppVersion, RATIONAL_ONE/RATIONAL_ZERO/
//                compareRationals (the memory engine's canonical re-exports)
// - coverage:    ObservedExternalSystem, StackScanInputs,
//                validateStackScanInputs (the fail-closed gate — strict
//                keys, re-parse, duplicates, cross-references),
//                ValidatedStackInputs, MeasuredInstallation,
//                MeasuredPortfolio, measureStackCoverage (THE deterministic
//                workflow coverage measurement), MeasuredStackCoverage,
//                ExternalSystemCoverage, InstalledAppCoverage,
//                SystemCapabilitySurface, CoveredSystemCapability,
//                SystemCapabilityGap, AppCapabilitySurface,
//                OverlappedAppCapability, compareObservedSystems
// - replacement: ReplacementAssessment, StackAnalysisResult,
//                assessStackReplacement (THE deterministic scan), StackScanParts,
//                StackConsumedCounts, AssessmentProvenance, SubjectCoverage,
//                ASSESSMENT_SCHEMA_VERSION, ANALYSIS_SCHEMA_VERSION,
//                compareAssessments, isExternalSystemAssessment,
//                isInstalledAppAssessment
// - authorization: StackAuthorization, checkStackCapabilities,
//                checkStackScopeCovers, checkStackPolicy, stackResource,
//                observedSystemResource, installationLinkResource,
//                stackInputScopeFailure, stackAssessmentNotFound,
//                queryReplacementAssessments, queryReplacementAssessmentById,
//                StackQuery
// - audit:       replacementAssessedEnvelope, emitReplacementAssessed,
//                STACK_ASSESSED_PAYLOAD_GRAMMAR, StackCausality,
//                StackEventSink, StackSinkExecutor,
//                InMemoryStackEventSink, createInMemoryStackEventSink,
//                RecordedStackAppend, stackSinkFailure,
//                failingStackEventSink
//
// src/test-support.ts and src/scenarios.ts are package-INTERNAL test
// modules (deterministic fixture factories + the golden seeded portfolio)
// — they are not part of the public surface.

// The stack analysis vocabulary + the scan/assessment identity grammars.
export {
  APP_ENTITLEMENT_KIND,
  APP_INSTALLATION_KIND,
  ASSESSMENT_ID_GRAMMAR,
  ASSESSMENT_ID_SEPARATOR,
  ASSESSMENT_KIND_GRAMMAR,
  ASSESSMENT_KINDS,
  ASSESSMENT_ORDINAL_WIDTH,
  BENCHMARK_KIND,
  EXTERNAL_SYSTEM_KIND,
  PROJECT_KIND,
  STACK_ASSESSED_EVENT,
  STACK_REQUIRED_CAPABILITIES,
  STACK_REQUIRED_CAPABILITY_NAMES,
  STACK_SCAN_ID_GRAMMAR,
  SUGGESTION_KIND_GRAMMAR,
  SUGGESTION_KINDS,
  isAssessmentId,
  isAssessmentKind,
  isStackScanId,
  isSuggestionKind,
  parseAssessmentId,
  parseAssessmentKind,
  parseStackScanId,
  parseSuggestionKind,
} from './vocabulary';
export type { AssessmentId, AssessmentKind, StackScanId, SuggestionKind } from './vocabulary';

// The shared model + THE exposed replacement-score composition.
export {
  RATIONAL_ONE,
  RATIONAL_ZERO,
  REPLACEMENT_FORMULA,
  SCORE_SCHEMA_VERSION,
  STACK_ENGINE,
  SUGGESTION_SCHEMA_VERSION,
  assessmentKindOrder,
  canonicalStackEvidence,
  compareAppInstallationRefs,
  compareCapabilities,
  compareExternalSystemRefs,
  compareRationals,
  compareStackEvidence,
  suggestionKindOrder,
} from './model';
export type {
  AppInstallationRef,
  ExternalSystemRef,
  PerformanceBasis,
  PinnedAppVersion,
  ReplacementScore,
  ReplacementSuggestion,
  StackEvidence,
} from './model';

// The scan-input model + THE deterministic coverage measurement.
export {
  compareObservedSystems,
  measureStackCoverage,
  validateStackScanInputs,
} from './coverage';
export type {
  AppCapabilitySurface,
  CoveredSystemCapability,
  ExternalSystemCoverage,
  InstalledAppCoverage,
  MeasuredInstallation,
  MeasuredPortfolio,
  MeasuredStackCoverage,
  ObservedExternalSystem,
  OverlappedAppCapability,
  StackScanInputs,
  SystemCapabilityGap,
  SystemCapabilitySurface,
  ValidatedStackInputs,
} from './coverage';

// THE replacement assessment record + THE deterministic scan.
export {
  ANALYSIS_SCHEMA_VERSION,
  ASSESSMENT_SCHEMA_VERSION,
  assessStackReplacement,
  compareAssessments,
  isExternalSystemAssessment,
  isInstalledAppAssessment,
} from './replacement';
export type {
  AssessmentProvenance,
  ReplacementAssessment,
  StackAnalysisResult,
  StackConsumedCounts,
  StackScanParts,
  SubjectCoverage,
} from './replacement';

// Permissioned stack reads (authorization BEFORE scans/queries).
export {
  checkStackCapabilities,
  checkStackPolicy,
  checkStackScopeCovers,
  installationLinkResource,
  observedSystemResource,
  queryReplacementAssessmentById,
  queryReplacementAssessments,
  stackAssessmentNotFound,
  stackInputScopeFailure,
  stackResource,
} from './authorization';
export type { StackAuthorization, StackQuery } from './authorization';

// Stack analysis audit events + the mirrored EventSink port.
export {
  STACK_ASSESSED_PAYLOAD_GRAMMAR,
  createInMemoryStackEventSink,
  emitReplacementAssessed,
  failingStackEventSink,
  replacementAssessedEnvelope,
  stackSinkFailure,
} from './audit';
export type {
  InMemoryStackEventSink,
  RecordedStackAppend,
  StackCausality,
  StackEventSink,
  StackSinkExecutor,
} from './audit';
