// Office desktop client protocol/reference shell — public surface (OFF-032).
//
// src/index.ts is the package's WHOLE public surface: the host application
// (and the OFF-037 integration + successor platform teams) import the desktop
// shell ONLY through this entry point, never through deeper paths. Anything
// not re-exported here is package-internal and may change without notice.
//
// The desktop shell is the platform shell CONTRACT + the REFERENCE DESKTOP
// HOST as a typed, deterministic VIEW-MODEL layer over THE SAME
// @office/sync + @office/client-sync client protocol the web and field shells
// consume: the host-port contract (what ANY platform host must provide the
// shell), the reference host's in-memory implementation over the seeded
// world, the session's subscribed project slice, the typed command path
// (online submissions + offline captures through the domain packages' own
// command surfaces), and the offline engine's reconnect/synchronize/conflict
// surfaces. NO UI framework, NO DOM, NO Electron/node runtime APIs (this is
// the typed reference host — the protocol proof, not a binary; the real
// platform host wires later), NO network I/O, and structurally ZERO direct
// database access (no @office/persistence import anywhere, no SQL — proven by
// the boundary self-gate). The landed @office/web and @office/field shells
// are the STRUCTURAL TEMPLATES — mirrored, never imported (apps do not import
// apps). The A8 gateway is consumed TYPE-ONLY; the shell never constructs
// one. NO platform-specific domain model: every domain term arrives from the
// shared contracts/domain packages through their fail-closed parsers.
//
// Surface summary:
// - session:   DesktopSession, createDesktopSession (typed rejections), the
//              session context/scope helpers, the deterministic SEEDED
//              DESKTOP WORLD (the in-memory reference engines of the landed
//              organization/projects/schedule/cost domain packages wired
//              through their own public command surfaces + the SHARED
//              server-side sync parts), and the session data plane over
//              @office/client-sync's SyncEngine
// - host-port: THE platform shell host-port contract — the typed descriptor
//              (the three named ports: identity, data, commands) + the
//              fail-closed candidate validator, and THE REFERENCE DESKTOP
//              HOST (createReferenceDesktopHost) implementing it in memory
//              over the same client protocol as web and field
// - commands:  the typed ONLINE + OFFLINE bindings of the schedule/cost
//              domains' real command paths (protection-class-declared; typed
//              Results; rejections are displayable view models, never
//              throws) and the displayable offline QUEUE state
// - workspace: the project workspace view model (header, schedule summary
//              with the deterministic CPM forecast, THE cost-position read
//              model, the session's own subscribed-slice section)
// - sync:      THE synchronize surface (the reconnect flow driving the
//              engine's exactly-once drain) with the displayable sync report
//              view and the connection lifecycle (disconnect)
// - conflicts: THE conflict state surface (every surfaced conflict as a
//              displayable view model: BOTH SIDES + provenance + the
//              domain-declared protection class + the deterministic
//              disposition) and THE typed explicit resolution command as a
//              USER ACTION — the ONLY exit from a protected conflict
export {
  SESSION_DESKTOP_CAPABILITIES,
  createDesktopSession,
  desktopSessionPolicy,
  entityRefOf,
  sessionActorIdOf,
  sessionContextOf,
  sessionCoversScope,
} from './session/session';
export type {
  DesktopSession,
  DesktopSessionInput,
  DesktopSessionRejection,
  Result,
} from './session/session';
export { seedDesktopWorld } from './session/world';
export type {
  CommandJournalEntry,
  DesktopSeedIdentities,
  SeededDesktopWorld,
  SeededDesktopWorldParts,
  WorldEventRecorder,
  WorldSyncParts,
} from './session/world';
export { openDesktopDataPlane, DESKTOP_SESSION_CORRELATION } from './session/stream';
export type {
  DesktopDataPlane,
  DesktopMutationRequest,
  DesktopMutationRequestRejection,
} from './session/stream';
export { DESKTOP_HOST_PORT_CONTRACT, validateDesktopHostPort } from './host-port/host-port';
export type {
  DesktopHostCommandPort,
  DesktopHostDataPlanePort,
  DesktopHostIdentityPort,
  DesktopHostPort,
  DesktopHostPortMember,
  DesktopHostPortRejection,
  DesktopHostPortSection,
  DesktopPlaneWiring,
} from './host-port/host-port';
export { createReferenceDesktopHost } from './desktop/host';
export {
  captureActivityUpdate,
  captureCommitmentAmend,
  captureCostItem,
  captureDesktopMutation,
  offlineQueueView,
  queueEntryViewOf,
  rejectionViewOf,
  submitCommitmentClose,
  submitCostItem,
  submitDesktopMutation,
  submitProgress,
} from './desktop/commands';
export type {
  AmendCommitmentInput,
  CaptureOutcomeView,
  CloseCommitmentInput,
  CommandReceiptView,
  CommitmentLineInput,
  DesktopActionGateway,
  DesktopCommandProposal,
  OfflineQueueView,
  QueueEntryView,
  RecordCostItemInput,
  RecordProgressInput,
  RejectionDetailView,
  RejectionView,
  SubmissionOutcomeView,
  UpdateActivityInput,
} from './desktop/commands';
export { desktopWorkspaceView } from './desktop/workspace';
export type {
  ConsumedEventView,
  CostPositionView,
  DesktopWorkspaceView,
  ProjectHeaderView,
  ScheduleSummaryView,
  SubscribedSliceView,
} from './desktop/workspace';
export { disconnect, syncReportViewOf, syncStatusView, synchronize } from './desktop/sync';
export type {
  AppliedEntryView,
  ConflictedEntryView,
  RejectedEntryView,
  SupersededEntryView,
  SyncReportView,
  SyncStatusView,
  SynchronizeRejection,
} from './desktop/sync';
export { conflictStateView, resolveProtectedConflict } from './desktop/conflicts';
export type {
  ConflictDisposition,
  ConflictProvenanceView,
  ConflictSideView,
  ConflictStateView,
  ConflictView,
  ResolutionOutcomeView,
  ResolveConflictInput,
} from './desktop/conflicts';
