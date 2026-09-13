// Office security — public surface (OFF-036).
//
// src/index.ts is the package's WHOLE public surface: the release gate
// (OFF-038) and every later Office module consume the package only through
// this root entry point, never through deeper paths. Anything not
// re-exported here is package-internal (the parse plumbing in parse.ts, the
// fixture builders the test suites compose with locally) and may change
// without notice.
//
// The package imports exactly six workspace dependencies — @office/authz
// (the deny-by-default evaluator + Policy under test), @office/actions (THE
// action gateway + its audit events, driven with in-memory handlers),
// @office/app-runtime (the AppInstallation lifecycle + dispatch engines,
// driven in-memory through the exported fail-closed parses), @office/events
// (the ledger identity vocabulary — the deterministic ledger event id
// derivation), @office/contracts (envelopes, Actor, Scope, parse plumbing),
// and @office/domain-kernel (Result/DomainError). No external dependencies;
// no network I/O; no provider vocabulary; no SQL; agents'/sync execution
// records are consumed through the @office/contracts envelope grammar ONLY.
//
// Surface summary:
// - audit ledger:   the AUDIT_EVENT_CLASSES vocabulary, auditEventClassOf,
//                   AuditLedgerEvent, InMemoryAuditLedger,
//                   createInMemoryAuditLedger (the deterministic append-only
//                   read model every security model derives from)
// - conformance:    THE four checks — driveTenantIsolationProbes +
//                   evaluateTenantIsolation (A12), driveAuthorization-
//                   BoundaryProbes + evaluateAuthorizationBoundaries
//                   (deny-by-default across every actor kind),
//                   driveConsequentialMutations + auditLedgerSnapshot +
//                   evaluateAuditCompleteness (every consequential mutation
//                   leaves its audit envelope), driveRevocationProbes +
//                   evaluateRevocation (suspended/revoked installations
//                   receive nothing) — plus the evidence vocabulary, the
//                   deterministic conformance harness (the REAL gateway +
//                   REAL app runtime wired in memory), and runSecurity-
//                   Conformance (the composed SecurityAuditReport)
// - access review:  the typed review model (findings, decisions, provenance,
//                   the derived review identity) + reviewSubjectAccess (the
//                   deterministic A7 derivation from the recorded audit
//                   trail, cross-tenant review queries typed-rejected)
// - alerts:         the sensitive-action alert rule vocabulary (typed rule
//                   descriptors, the canonical rule set) +
//                   evaluateSensitiveActionAlerts (deterministic evaluation
//                   over the audit stream with full provenance)
// - retention:      the retention rule contracts (event class -> retention
//                   class, the immutable-audit-trail invariant, the
//                   canonical rule set) + evaluateRetention (the PURE
//                   retain/expire projection — no deletion, ever)

// The append-only in-memory audit ledger (the security read model).
export {
  AUDIT_EVENT_CLASSES,
  AUDIT_EVENT_CLASS_GRAMMAR,
  auditEventClassOf,
  createInMemoryAuditLedger,
} from './audit-ledger';
export type { AuditEventClass, AuditLedgerEvent, InMemoryAuditLedger } from './audit-ledger';

// The conformance evidence vocabulary.
export {
  CONFORMANCE_CHECK_IDS,
  CONFORMANCE_CHECK_ID_GRAMMAR,
  conformanceFailure,
  conformanceResult,
  observedDecisionOf,
  rejectionCodeOf,
} from './conformance/evidence';
export type {
  ConformanceCheckId,
  ConformanceCheckResult,
  ConformanceFailure,
  ObservedDecision,
} from './conformance/evidence';

// THE deterministic conformance harness (REAL gateway + REAL app runtime).
export {
  CANONICAL_DESCRIPTORS,
  COMMIT_BUDGET_REVISION,
  COMMIT_BUDGET_REVISION_COMMAND,
  CORRELATION_ID,
  FULL_CAPABILITIES,
  LIST_COST_ITEMS,
  LIST_COST_ITEMS_COMMAND,
  PURGE_COST_LEDGER,
  PURGE_COST_LEDGER_COMMAND,
  RECORD_PROGRESS,
  RECORD_PROGRESS_COMMAND,
  SAMPLE_APP,
  SAMPLE_APP_VERSION,
  SUBMIT_DAILY_LOG,
  SUBMIT_DAILY_LOG_COMMAND,
  TENANT_A,
  TENANT_B,
  PROJECT_1,
  PROJECT_2,
  USER,
  MANAGER,
  AGENT,
  APP_ID_A,
  APP_ID_B,
  ADAPTER,
  SUBJECT,
  T0,
  actorOf,
  allowAllPolicy,
  appActorOf,
  causationIdOf,
  commandEnvelopeOf,
  denyWritePolicy,
  domainEventOf,
  emptyPolicy,
  emptyPolicyGrant,
  expectFail,
  expectOk,
  fullGrant,
  makeConformanceHarness,
  missingCostWriteGrant,
  noCapabilitiesGrant,
  projectOneScope,
  projectTwoScope,
  PROGRESS_RECORDED_EVENT,
  subjectRef,
  tenantAScope,
  tenantBScope,
} from './conformance/harness';
export type {
  AnyResult,
  ConformanceHarness,
  CountingGateway,
} from './conformance/harness';

// THE tenant-isolation check (A12, both directions, all surfaces).
export {
  TENANT_ISOLATION_CODES,
  driveTenantIsolationProbes,
  evaluateTenantIsolation,
} from './conformance/tenant-isolation';
export type {
  IsolationDirection,
  IsolationSurface,
  TenantIsolationProbe,
} from './conformance/tenant-isolation';

// THE authorization-boundary check (deny-by-default, no actor-kind bypass).
export {
  AUTHORIZATION_BOUNDARY_CODES,
  driveAuthorizationBoundaryProbes,
  evaluateAuthorizationBoundaries,
} from './conformance/authorization';
export type {
  AuthorizationBoundaryProbe,
  BoundaryCapabilityKind,
  BoundaryExpectation,
  BoundaryPolicyKind,
} from './conformance/authorization';

// THE audit-completeness check (completeness counting over the audit ledger).
export {
  auditLedgerSnapshot,
  driveConsequentialMutations,
  evaluateAuditCompleteness,
} from './conformance/completeness';
export type {
  AuditCompletenessEvidence,
  AuditLedgerSnapshotEntry,
  ConsequentialMutationKind,
  ConsequentialMutationRecord,
} from './conformance/completeness';

// THE revocation check (suspension, terminal revocation, revoked grants).
export { REVOCATION_CODES, driveRevocationProbes, evaluateRevocation } from './conformance/revocation';
export type { RevocationPhase, RevocationProbe, RevocationSurface } from './conformance/revocation';

// The composed report (THE release-gate entry point).
export { runSecurityConformance } from './conformance/report';
export type { SecurityAuditReport } from './conformance/report';

// The access-review model.
export {
  ACCESS_REVIEW_DECISIONS,
  ACCESS_REVIEW_DECISION_GRAMMAR,
  ACCESS_REVIEW_FINDING_KINDS,
  ACCESS_REVIEW_FINDING_GRAMMAR,
  ACCESS_REVIEW_ID_GRAMMAR,
  accessReviewIdOf,
  isAccessReviewId,
  parseAccessReviewDecision,
  parseAccessReviewFindingKind,
  parseAccessReviewId,
  scopeKeyOf,
  subjectKeyOf,
} from './access-review/model';
export type {
  AccessReview,
  AccessReviewDecision,
  AccessReviewFinding,
  AccessReviewFindingKind,
  ReviewProvenanceRef,
  ReviewSubject,
} from './access-review/model';

// The deterministic access-review derivation over the audit trail.
export {
  CROSS_TENANT_DENIAL_CODES,
  ESCALATING_FINDING_KINDS,
  observeAuditPayload,
  reviewSubjectAccess,
} from './access-review/derive';
export type {
  AccessReviewInput,
  AuditDecisionObservation,
} from './access-review/derive';

// The sensitive-action alert rules + their deterministic evaluation.
export {
  ALERT_RULE_ID_GRAMMAR,
  ALERT_RULE_KINDS,
  ALERT_RULE_KIND_GRAMMAR,
  ALERT_SEVERITIES,
  ALERT_SEVERITY_GRAMMAR,
  DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
  defineAlertRule,
  isAlertRuleId,
  isAlertRuleKind,
  isAlertSeverity,
  isSensitiveActionAlertRule,
  parseAlertRuleId,
  parseAlertRuleKind,
  parseAlertSeverity,
  parseSensitiveActionAlertRule,
} from './alerts/rules';
export type { AlertRuleKind, AlertSeverity, SensitiveActionAlertRule } from './alerts/rules';
export {
  ALERT_ID_GRAMMAR,
  alertIdOf,
  alertRuleKindMatches,
  evaluateSensitiveActionAlerts,
  isAlertId,
  parseAlertId,
} from './alerts/evaluate';
export type {
  AlertEvaluationInput,
  AlertEvaluationResult,
  SensitiveActionAlert,
} from './alerts/evaluate';

// The retention rule contracts + the pure retain/expire projection.
export {
  DEFAULT_RETENTION_RULES,
  EVENT_CLASS_GRAMMAR,
  RETENTION_CLASSES,
  RETENTION_CLASS_DAYS,
  RETENTION_CLASS_GRAMMAR,
  defineRetentionRuleSet,
  isEventClass,
  isRetentionClass,
  isRetentionRule,
  isRetentionRuleSet,
  parseEventClass,
  parseRetentionClass,
  parseRetentionRule,
  parseRetentionRuleSet,
} from './retention/rules';
export type { RetentionClass, RetentionRule, RetentionRuleSet } from './retention/rules';
export {
  addDaysToTimestamp,
  evaluateRetention,
  retentionSummary,
} from './retention/evaluate';
export type { RetentionDecision, RetentionSummary } from './retention/evaluate';
