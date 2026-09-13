// Office field/offline web client — public surface (OFF-031).
//
// src/index.ts is the package's WHOLE public surface: the host application
// (and the OFF-032 desktop shell / OFF-037 integration consumers) import the
// field client ONLY through this entry point, never through deeper paths.
// Anything not re-exported here is package-internal and may change without
// notice.
//
// The field client is the offline-capable field experience as a typed,
// deterministic VIEW-MODEL layer over @office/client-sync's engine: pure
// TypeScript view models + the injected in-memory engine. NO UI framework,
// NO DOM, NO rendering, NO service workers (the offline ENGINE is
// @office/client-sync — this app composes it, deterministically, in
// memory), NO network I/O, and structurally ZERO direct database access (no
// @office/persistence import anywhere, no SQL, no repositories — proven by
// the boundary self-gate). The landed @office/web shell is the STRUCTURAL
// TEMPLATE — mirrored, never imported (apps do not import apps). The A8
// gateway is consumed TYPE-ONLY; the field client never constructs one.
//
// Surface summary:
// - session:   FieldSession, createFieldSession (typed rejections), the
//              session context/scope helpers, the deterministic SEEDED
//              FIELD WORLD (the in-memory reference engines of the landed
//              organization/projects/field domain packages wired through
//              their own public command surfaces + the SHARED server-side
//              sync parts), and the offline session data plane over
//              @office/client-sync's SyncEngine
// - capture:   the typed OFFLINE capture bindings of the field domain's
//              real command paths (protection-class-declared; typed Results;
//              rejections are displayable view models, never throws), the
//              online twin bindings, the displayable offline QUEUE state
//              (pending count, entries, protection classes), the field
//              board view (the session's own consumed-stream fold through
//              the field domain's public read model), and the single
//              field-event view (the reconciled state) + the TYPE-ONLY A8
//              gateway seam
// - sync:      THE synchronize surface (the reconnect flow driving the
//              engine's exactly-once drain) with the displayable sync
//              report view (applied/rejected/conflicted/superseded counts,
//              the catchup window, the cursor/token state) and the
//              connection lifecycle (disconnect)
// - conflicts: THE conflict state surface: every surfaced conflict as a
//              displayable view model (BOTH SIDES + provenance + the
//              domain-declared protection class + the deterministic
//              disposition), and THE typed explicit resolution command as a
//              USER ACTION — the ONLY exit from a protected conflict (the
//              reconciled mutation re-enters the queue discipline and
//              replays exactly once)
export {
  SESSION_FIELD_CAPABILITIES,
  createFieldSession,
  entityRefOf,
  sessionActorIdOf,
  sessionContextOf,
  sessionCoversScope,
  fieldSessionPolicy,
} from './session/session';
export type {
  FieldSession,
  FieldSessionInput,
  FieldSessionRejection,
  Result,
} from './session/session';
export { seedFieldWorld, ATTACH_FIELD_EVENT_EVIDENCE_COMMAND } from './session/world';
export type {
  CommandJournalEntry,
  FieldSeedIdentities,
  SeededFieldWorld,
  SeededFieldWorldParts,
  WorldEventRecorder,
  WorldSyncParts,
} from './session/world';
export { openFieldDataPlane, FIELD_SESSION_CORRELATION } from './session/stream';
export type {
  FieldDataPlane,
  FieldMutationRequest,
  FieldMutationRequestRejection,
} from './session/stream';
export {
  captureEvidenceAttachment,
  captureFieldObservation,
  captureIssueResolution,
  offlineQueueView,
  queueEntryViewOf,
  rejectionViewOf,
  submitEvidenceAttachment,
  submitIssueResolution,
} from './capture/capture';
export type {
  CaptureEvidenceAttachmentInput,
  CaptureFieldObservationInput,
  CaptureIssueResolutionInput,
  CaptureOutcomeView,
  CaptureReceiptView,
  FieldActionGateway,
  FieldCaptureProposal,
  OfflineQueueView,
  QueueEntryView,
  RejectionDetailView,
  RejectionView,
  SubmissionOutcomeView,
} from './capture/capture';
export { fieldBoardView, fieldEventView } from './capture/board';
export type { FieldBoardView, FieldEventView } from './capture/board';
export { disconnect, syncStatusView, syncReportViewOf, synchronize } from './sync-surface/sync';
export type {
  AppliedEntryView,
  ConflictedEntryView,
  ConsumedEventView,
  RejectedEntryView,
  SupersededEntryView,
  SyncReportView,
  SyncStatusView,
  SynchronizeRejection,
} from './sync-surface/sync';
export { conflictStateView, resolveProtectedConflict } from './conflicts/conflicts';
export type {
  ConflictDisposition,
  ConflictProvenanceView,
  ConflictSideView,
  ConflictStateView,
  ConflictView,
  ResolutionOutcomeView,
  ResolveConflictInput,
} from './conflicts/conflicts';
