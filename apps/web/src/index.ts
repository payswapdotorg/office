// Office web application shell — public surface (OFF-030).
//
// src/index.ts is the package's WHOLE public surface: the host application
// (and the OFF-031 field client / OFF-032 desktop shell / OFF-037
// integration consumers) import the shell ONLY through this entry point,
// never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The shell is the primary web client's APPLICATION SHELL as a typed,
// deterministic VIEW-MODEL layer over the landed Office packages: pure
// TypeScript view models + command dispatch + navigation state. NO UI
// framework, NO DOM, NO rendering (the host wires that later), NO network
// I/O, and structurally ZERO direct database access (no @office/persistence
// import anywhere, no SQL, no repositories — proven by the boundary
// self-gate). The A8 gateway is consumed TYPE-ONLY; the shell never
// constructs one.
//
// Surface summary:
// - session:   WebSession, createWebSession (typed rejections), the
//              session context/scope helpers, the deterministic SEEDED
//              WORLD (the in-memory reference engines of the landed domain
//              packages wired through their own public command surfaces),
//              and the online session data plane over @office/client-sync
// - workspace: THE project workspace view model (header, schedule summary,
//              field status, cost position, commitments, documents,
//              approvals) — one deterministic projection per load
// - commands:  the typed command bindings of the seeded project's real
//              command paths (typed Results; rejections are displayable
//              view models, never throws) + the TYPE-ONLY A8 gateway seam
// - control
//   tower:     the portfolio exception-set view (prioritized,
//              evidence-chained, suggested next actions as SUGGESTIONS only)
// - evidence:  the ledger-event walkers + typed navigation state (push/back
//              without a router): aggregate streams, the event-name
//              vocabulary overview, and the A3 causality/correlation chains
//              from any view model back to the originating command
export {
  SESSION_OPERATOR_CAPABILITIES,
  createWebSession,
  entityRefOf,
  sessionActorIdOf,
  sessionContextOf,
  sessionCoversScope,
  sessionOperatorPolicy,
} from './session/session';
export type {
  Result,
  WebSession,
  WebSessionInput,
  WebSessionRejection,
} from './session/session';
export {
  seedOfficeWorld,
} from './session/world';
export type {
  CommandJournalEntry,
  SeedIdentities,
  SeededWorld,
  SeededWorldParts,
  WorldEventRecorder,
} from './session/world';
export { openWebDataPlane } from './session/stream';
export type {
  WebCommandRequest,
  WebCommandRequestRejection,
  WebDataPlane,
} from './session/stream';
export { projectWorkspace } from './workspace/workspace';
export type {
  ApprovalStepView,
  ApprovalsView,
  CommitmentsView,
  CostPositionView,
  DocumentsView,
  FieldStatusView,
  ProjectHeaderView,
  ProjectWorkspaceView,
  ScheduleSummaryView,
} from './workspace/workspace';
export {
  approveWorkflowApproval,
  advanceWorkflowInstance,
  captureFieldObservation,
  commandProposalOf,
  recordCostItem,
  rejectionViewOf,
  submitWorkflowApproval,
  CAPTURE_FIELD_EVENT_COMMAND,
  RECORD_COST_ITEM_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
  APPROVE_APPROVAL_COMMAND,
  EXECUTE_TRANSITION_COMMAND,
} from './commands/commands';
export type {
  AdvanceWorkflowInput,
  ApproveWorkflowApprovalInput,
  CaptureFieldObservationInput,
  CommandOutcomeView,
  CommandReceiptView,
  RecordCostItemInput,
  RejectionDetailView,
  RejectionView,
  SubmitWorkflowApprovalInput,
  WebActionGateway,
  WebCommandProposal,
} from './commands/commands';
export { controlTowerView } from './control-tower/control-tower';
export type {
  ControlTowerScanParts,
  ControlTowerView,
  ExceptionEvidenceView,
  ExceptionItemView,
  SuggestedActionView,
} from './control-tower/control-tower';
export {
  aggregateHistory,
  backEvidencePage,
  causalityChainOf,
  correlationChainOf,
  currentEvidencePage,
  evidenceCommandOf,
  evidenceEventOf,
  evidenceOverview,
  evidencePageView,
  openEvidenceNavigation,
  pushEvidencePage,
} from './evidence/evidence';
export type {
  AggregateHistoryView,
  CausalityChainView,
  CorrelationChainView,
  EvidenceCommandView,
  EvidenceEventView,
  EvidenceNavigation,
  EvidenceNavigationRejection,
  EvidenceOverviewView,
  EvidencePage,
  EvidencePageView,
} from './evidence/evidence';
