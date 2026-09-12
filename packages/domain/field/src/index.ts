// Office field domain — public surface (OFF-009).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-010+ domains, OFF-013 relationships, OFF-016 workflows, the app
// layer) consume the package only through its root entry point, never
// through deeper paths. Anything not re-exported here is package-internal
// and may change without notice.
//
// The package imports exactly five workspace dependencies — @office/contracts
// (envelopes + canonical ids), @office/domain-kernel (Result/DomainError,
// aggregate versioning + concurrency, invariants, the IdempotencyRegistry),
// @office/authz (the deny-by-default authorize() evaluator),
// @office/persistence (the SqlExecutor type of the EventSink port), and
// @office/events (the ledger-backed EventSink adapter only) — plus node
// builtins in tests. No external dependencies; the identity domain packages
// (@office/domain-organization, @office/domain-projects) are deliberately
// NOT imported (no domain-to-domain imports, dependency rule — the EventSink
// port is mirrored in shape, which any transactional implementation
// satisfies structurally).
//
// Surface summary:
// - state:       FieldEventState (+ statuses, invariants, transitions,
//                EvidenceReference, Measurement), DailyLogState (+ entry
//                types, statuses, invariants, transitions), IssueState (+
//                comment types, severities, statuses, invariants,
//                transitions), InspectionState (+ checklist/result/finding
//                types, statuses, outcomes, invariants, transitions), the
//                four KIND constants
// - store:       FieldStore, createInMemoryFieldStore (the pure-domain
//                aggregate keeper with A12 visibility semantics)
// - events:      EventSink, InMemoryEventSink, RecordedEventAppend,
//                createInMemoryEventSink, failingEventSink, eventSinkFailure,
//                the thirteen FIELD_*_EVENT name constants, FIELD_EVENT_NAMES,
//                fieldEventEnvelope, createdRefs, updatedRefs, fieldEntityRef
//                (+ payload types)
// - ledger-sink: createLedgerEventSink (+ options) — the transactional
//                appendEvent + enqueueOutbox implementation of the port
// - commands:    FieldCommands (+ the four per-aggregate groups),
//                createFieldCommands, FieldCommandDeps,
//                FieldCommandAuthorization, FieldCommandOutcome, the
//                thirteen *_COMMAND name constants (+ payload types and
//                their fail-closed parsers)
// - projection:  ProjectReadModel, createProjectReadModel,
//                FieldEventSummary, OpenIssueRecord, InspectionOutcomeRecord

// Aggregate states, invariants, and pure lifecycle transitions.
export {
  DAILY_LOG_INVARIANTS,
  DAILY_LOG_KIND,
  DAILY_LOG_STATUSES,
  FIELD_EVENT_INVARIANTS,
  FIELD_EVENT_KIND,
  FIELD_EVENT_STATUSES,
  INSPECTION_INVARIANTS,
  INSPECTION_KIND,
  INSPECTION_OUTCOMES,
  INSPECTION_STATUSES,
  ISSUE_INVARIANTS,
  ISSUE_KIND,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  appendDailyLogEntryState,
  assignIssueState,
  attachFieldEventEvidenceState,
  closeDailyLogDayState,
  commentOnIssueState,
  conductInspectionState,
  createDailyLogState,
  createFieldEventState,
  createInspectionState,
  createIssueState,
  recordInspectionOutcomeState,
  reopenIssueState,
  resolveFieldEventState,
  resolveIssueState,
} from './state';
export type {
  ChecklistItem,
  DailyLogEntry,
  DailyLogEntryInput,
  DailyLogState,
  DailyLogStatus,
  EvidenceReference,
  FieldEventState,
  FieldEventStatus,
  InspectionFinding,
  InspectionOutcome,
  InspectionResult,
  InspectionState,
  InspectionStatus,
  IssueComment,
  IssueSeverity,
  IssueState,
  IssueStatus,
  Measurement,
  NewDailyLog,
  NewFieldEvent,
  NewInspection,
  NewIssue,
} from './state';

// The pure-domain aggregate keeper (A12 visibility by construction).
export { createInMemoryFieldStore } from './store';
export type { FieldStore } from './store';

// Audit events + THE EventSink port (minimal; the ledger-backed adapter
// below implements it transactionally over @office/events).
export {
  DAILY_LOG_DAY_CLOSED_EVENT,
  DAILY_LOG_ENTRY_APPENDED_EVENT,
  FIELD_EVENT_CAPTURED_EVENT,
  FIELD_EVENT_EVIDENCE_ATTACHED_EVENT,
  FIELD_EVENT_NAMES,
  FIELD_EVENT_RESOLVED_EVENT,
  INSPECTION_CONDUCTED_EVENT,
  INSPECTION_OUTCOMED_EVENT,
  INSPECTION_SCHEDULED_EVENT,
  ISSUE_ASSIGNED_EVENT,
  ISSUE_COMMENTED_EVENT,
  ISSUE_RAISED_EVENT,
  ISSUE_REOPENED_EVENT,
  ISSUE_RESOLVED_EVENT,
  createdRefs,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  fieldEntityRef,
  fieldEventEnvelope,
  updatedRefs,
} from './events';
export type {
  DailyLogDayClosedPayload,
  DailyLogEntryAppendedPayload,
  EventSink,
  FieldAuditPayload,
  FieldEventCapturedPayload,
  FieldEventEvidenceAttachedPayload,
  FieldEventResolvedPayload,
  InMemoryEventSink,
  InspectionConductedPayload,
  InspectionOutcomedPayload,
  InspectionScheduledPayload,
  IssueAssignedPayload,
  IssueCommentedPayload,
  IssueRaisedPayload,
  IssueReopenedPayload,
  IssueResolvedPayload,
  RecordedEventAppend,
} from './events';

// The transactional ledger-backed EventSink adapter.
export { createLedgerEventSink } from './ledger-sink';
export type { LedgerEventSinkOptions } from './ledger-sink';

// Command handlers (parse → project-scope → authorize → idempotency → load
// → concurrency → invariant-checked transition → sink append + store commit).
export {
  APPEND_DAILY_LOG_ENTRY_COMMAND,
  ASSIGN_ISSUE_COMMAND,
  CAPTURE_FIELD_EVENT_COMMAND,
  CLOSE_DAILY_LOG_DAY_COMMAND,
  COMMENT_ON_ISSUE_COMMAND,
  CONDUCT_INSPECTION_COMMAND,
  RAISE_ISSUE_COMMAND,
  RECORD_INSPECTION_OUTCOME_COMMAND,
  REOPEN_ISSUE_COMMAND,
  RESOLVE_FIELD_EVENT_COMMAND,
  RESOLVE_ISSUE_COMMAND,
  SCHEDULE_INSPECTION_COMMAND,
  createFieldCommands,
  parseAppendDailyLogEntryPayload,
  parseAssignIssuePayload,
  parseCaptureFieldEventPayload,
  parseChecklistItem,
  parseCloseDailyLogDayPayload,
  parseCommentOnIssuePayload,
  parseConductInspectionPayload,
  parseDailyLogEntryPayload,
  parseEvidenceReference,
  parseInspectionFinding,
  parseInspectionResult,
  parseMeasurement,
  parseRaiseIssuePayload,
  parseRecordInspectionOutcomePayload,
  parseReopenIssuePayload,
  parseResolveFieldEventPayload,
  parseResolveIssuePayload,
  parseScheduleInspectionPayload,
} from './commands';
export type {
  AppendDailyLogEntryPayload,
  AssignIssuePayload,
  AttachFieldEventEvidencePayload,
  CaptureFieldEventPayload,
  CloseDailyLogDayPayload,
  CommentOnIssuePayload,
  ConductInspectionPayload,
  DailyLogCommands,
  DailyLogEntryPayload,
  FieldCommandAuthorization,
  FieldCommandDeps,
  FieldCommandOutcome,
  FieldCommands,
  FieldEventCommands,
  InspectionCommands,
  RaiseIssuePayload,
  RecordInspectionOutcomePayload,
  ReopenIssuePayload,
  ResolveFieldEventPayload,
  ResolveIssuePayload,
  ScheduleInspectionPayload,
} from './commands';

// The project read model (in-memory projection rebuilt from emitted events).
export { createProjectReadModel } from './projection';
export type {
  FieldEventSummary,
  InspectionOutcomeRecord,
  OpenIssueRecord,
  ProjectReadModel,
} from './projection';

// LogDay (daily-log scoping value) + its fail-closed parser/is-guard.
export { isLogDay, parseLogDay, LOG_DAY_GRAMMAR } from './parse';
export type { LogDay } from './parse';
