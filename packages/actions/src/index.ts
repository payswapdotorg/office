// Office action gateway — public surface (OFF-017).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-018 agent runtime, OFF-025 app SDK surface, OFF-026 app runtime,
// OFF-030 web API, OFF-031 desktop, OFF-033/034 sync/field, OFF-036 release
// gate) consume the package only through this root entry point, never through
// deeper paths. Anything not re-exported here is package-internal and may
// change without notice.
//
// The package imports exactly five workspace dependencies — @office/contracts
// (envelopes + canonical ids), @office/domain-kernel (Result/DomainError,
// the CommandHandler/CommandExecutionContext contract, the
// IdempotencyRegistry + command fingerprint), @office/authz (the
// deny-by-default authorize() evaluator + the capability vocabulary),
// @office/persistence (the SqlExecutor type of the EventSink port), and
// @office/workflows (the approval engine the approval-required class routes
// into, through the adapter in workflow-approval.ts). No external
// dependencies; NO domain packages are imported (the gateway is generic over
// typed commands — domain handlers are INJECTED; dependency rule).
//
// Surface summary:
// - classification: the four-class vocabulary (ACTION_CLASSES), ActionClass,
//                   parse/isActionClass, classifyAction (fail-closed:
//                   unknown → prohibited by default), authorizationActionOf
// - descriptor:     ActionDescriptor (+ ActionClass types), the structural
//                   class rules, parse/isActionDescriptor,
//                   defineActionDescriptor (trusted path)
// - evidence:       EvidenceRequirement, EvidenceReference (+ parsers/lists),
//                   ConfidenceLevel (+ CONFIDENCE_LEVELS, ranks, comparisons)
// - approval:       ApprovalRouting (+ parser), ApprovalReference (+ parser),
//                   ApprovalStatus/ApprovalRecord/ApprovalRoutingRequest,
//                   THE ApprovalAuthority port, approvalRoutingKeyOf,
//                   createInMemoryApprovalAuthority (deterministic stub),
//                   the typed routing-mismatch/already-decided failures
// - registry:       ActionRegistry, createInMemoryActionRegistry
// - proposal:       ActionProposal (+ parser/type guard, actionProposal
//                   trusted builder), ActionAuthorization
// - audit events:   the four ACTION_*_EVENT name constants,
//                   ACTION_EVENT_NAMES, ActionDecision/ACTION_DECISIONS,
//                   ActionAuditPayload, actionEventEnvelope,
//                   auditPayloadBaseOf/withApprovalOnPayload, EventSink (the
//                   port), InMemoryEventSink/createInMemoryEventSink,
//                   failingEventSink, eventSinkFailure
// - handlers:       ActionCommandHandler, ActionHandlers,
//                   createInMemoryActionHandlers
// - gateway:        executeAction (via createActionGateway),
//                   ActionGateway/ActionGatewayDeps, ActionResult,
//                   RecordedActionOutcome
// - workflow seam:  createWorkflowApprovalAuthority (+ deps) — the
//                   @office/workflows-backed ApprovalAuthority adapter

// The four-class action vocabulary + fail-closed classification.
export { classifyAction, authorizationActionOf } from './classification';
export type { ActionClassification } from './classification';
export {
  ACTION_CLASSES,
  isActionClass,
  parseActionClass,
} from './descriptor';
export type { ActionClass } from './descriptor';

// The ActionDescriptor model (typed, fail-closed, structural class rules).
export {
  defineActionDescriptor,
  isActionDescriptor,
  parseActionDescriptor,
} from './descriptor';
export type { ActionDescriptor } from './descriptor';

// The A4 evidence + confidence vocabulary.
export {
  CONFIDENCE_LEVELS,
  confidenceLevel,
  confidenceRank,
  evidenceSlotsOf,
  isConfidenceLevel,
  meetsConfidence,
  parseConfidenceLevel,
  parseEvidenceReference,
  parseEvidenceReferences,
  parseEvidenceRequirement,
  parseEvidenceRequirements,
} from './evidence';
export type {
  ConfidenceLevel,
  EvidenceReference,
  EvidenceRequirement,
} from './evidence';

// The approval routing contract + THE approval authority port.
export {
  APPROVAL_STATUSES,
  approvalAlreadyDecided,
  approvalRoutingKeyOf,
  approvalRoutingMismatch,
  createInMemoryApprovalAuthority,
  parseApprovalReference,
  parseApprovalRouting,
} from './approval';
export type {
  ApprovalAuthority,
  ApprovalRecord,
  ApprovalReference,
  ApprovalRouting,
  ApprovalRoutingRequest,
  ApprovalStatus,
  InMemoryApprovalAuthority,
} from './approval';

// The registry of known actions.
export { createInMemoryActionRegistry } from './registry';
export type { ActionRegistry } from './registry';

// The action proposal + the caller-supplied authorization inputs.
export {
  actionProposal,
  isActionProposal,
  parseActionProposal,
} from './proposal';
export type { ActionAuthorization, ActionProposal } from './proposal';

// The gateway's own audit events + THE EventSink port.
export {
  ACTION_DECISIONS,
  ACTION_DENIED_EVENT,
  ACTION_DUPLICATE_OBSERVED_EVENT,
  ACTION_EVENT_NAMES,
  ACTION_EXECUTED_EVENT,
  ACTION_ROUTED_TO_APPROVAL_EVENT,
  actionEventEnvelope,
  auditPayloadBaseOf,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  withApprovalOnPayload,
} from './audit-events';
export type {
  ActionAuditPayload,
  ActionDecision,
  EventSink,
  InMemoryEventSink,
  RecordedEventAppend,
} from './audit-events';

// The injected typed command handler port.
export { createInMemoryActionHandlers } from './handlers';
export type { ActionCommandHandler, ActionHandlers } from './handlers';

// THE gateway: executeAction is the only path to canonical mutation.
export { createActionGateway } from './gateway';
export type {
  ActionGateway,
  ActionGatewayDeps,
  ActionResult,
  RecordedActionOutcome,
} from './gateway';

// The @office/workflows-backed approval authority adapter.
export { createWorkflowApprovalAuthority } from './workflow-approval';
export type { WorkflowApprovalAuthorityDeps } from './workflow-approval';
