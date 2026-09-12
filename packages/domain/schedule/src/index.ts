// Office schedule domain — public surface (OFF-010).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-011 cost, OFF-013 relationships, OFF-014 margin/impact, OFF-016
// workflows, OFF-020+/OFF-023 schedule adapters) consume the package only
// through its root entry point, never through deeper paths. Anything not
// re-exported here is package-internal and may change without notice.
//
// The package imports exactly five workspace dependencies — @office/contracts
// (envelopes + canonical ids), @office/domain-kernel (Result/DomainError,
// aggregate versioning + concurrency, invariants), @office/authz (the
// deny-by-default authorize() evaluator), @office/events (the thin
// ledger-backed EventSink adapter only — the aggregates, commands and tests
// never touch it), and @office/persistence (the SqlExecutor type of the
// mirrored EventSink port) — plus node builtins. No external dependencies;
// no domain-to-domain imports (the EventSink port is shape-mirrored from the
// identity modules, never imported from them); no provider vocabulary — the
// schedule contract is Office-canonical and provider-independent (freeze
// A5/A6; provider import happens in adapter packages owned elsewhere).
//
// Surface summary:
// - state:       ScheduleState, ActivityState, DependencyState,
//                MilestoneState, BaselineState, BaselineSnapshot,
//                ProgressUpdateState, DependencyLinkType,
//                DEPENDENCY_LINK_TYPES, SCHEDULE/ACTIVITY/DEPENDENCY/
//                MILESTONE/BASELINE/PROGRESS_UPDATE_KIND,
//                SCHEDULE_INVARIANTS, NewSchedule, NewActivity,
//                ActivityChanges, NewDependency, NewMilestone, NewBaseline,
//                NewProgressUpdate, createScheduleState, addActivityState,
//                updateActivityState, addDependencyState,
//                removeDependencyState, addMilestoneState, setBaselineState,
//                recordProgressState, updateBaselineState (always forbidden),
//                removeBaselineState (always forbidden), latestProgressFor,
//                latestProgressByActivity
// - events:      EventSink, InMemoryEventSink, RecordedEventAppend,
//                createInMemoryEventSink, failingEventSink, eventSinkFailure,
//                the 8 event-name constants, scheduleEventEnvelope, the ref
//                builders (+ payload types, ScheduleEventPayloads)
// - store:       ScheduleStore, ScheduleStoreTransaction,
//                createInMemoryScheduleStore, InMemoryScheduleStore
// - forecast:    ForecastNetworkInput (+ activity/dependency/progress/
//                milestone input types), ScheduleForecast, ForecastActivity,
//                ForecastMilestone, forecastSchedule, forecastOfSchedule,
//                forecastOfBaseline
// - variance:    ScheduleVariance, ActivityVariance, scheduleVariance
// - commands:    ScheduleCommands, createScheduleCommands,
//                ScheduleCommandDeps, ScheduleCommandAuthorization, the 8
//                command-name constants (+ payload types and their
//                fail-closed parsers)
// - ledger-sink: createLedgerEventSink (the thin OFF-005-backed EventSink)

// Aggregate state, invariants, and pure network transitions (incl. the
// dependency-graph validation gate and the baseline protection guards).
export {
  ACTIVITY_KIND,
  BASELINE_KIND,
  DEPENDENCY_KIND,
  DEPENDENCY_LINK_TYPES,
  MILESTONE_KIND,
  PROGRESS_UPDATE_KIND,
  SCHEDULE_INVARIANTS,
  SCHEDULE_KIND,
  addActivityState,
  addDependencyState,
  addMilestoneState,
  createScheduleState,
  latestProgressByActivity,
  latestProgressFor,
  recordProgressState,
  removeBaselineState,
  removeDependencyState,
  setBaselineState,
  updateActivityState,
  updateBaselineState,
} from './state';
export type {
  ActivityChanges,
  ActivityState,
  BaselineSnapshot,
  BaselineState,
  DependencyLinkType,
  DependencyState,
  MilestoneState,
  NewActivity,
  NewBaseline,
  NewDependency,
  NewMilestone,
  NewProgressUpdate,
  NewSchedule,
  ProgressUpdateState,
  ScheduleState,
} from './state';

// Audit events + THE EventSink port (minimal; mirrored from the identity
// modules; the OFF-005 ledger implements it directly or via ledger-sink.ts).
export {
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_UPDATED_EVENT,
  BASELINE_SET_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  MILESTONE_ADDED_EVENT,
  PROGRESS_RECORDED_EVENT,
  SCHEDULE_CREATED_EVENT,
  activityRef,
  baselineRef,
  createInMemoryEventSink,
  dependencyRef,
  eventSinkFailure,
  failingEventSink,
  milestoneRef,
  progressUpdateRef,
  scheduleEventEnvelope,
  scheduleRef,
} from './events';
export type {
  ActivityAddedPayload,
  ActivityUpdatedPayload,
  BaselineSetPayload,
  DependencyAddedPayload,
  DependencyRemovedPayload,
  EventSink,
  InMemoryEventSink,
  MilestoneAddedPayload,
  ProgressRecordedPayload,
  RecordedEventAppend,
  ScheduleCreatedPayload,
  ScheduleEventPayloads,
  ScheduleEventPayload,
} from './events';

// The pure-domain transactional store port + the in-memory implementation.
export { createInMemoryScheduleStore } from './store';
export type {
  InMemoryScheduleStore,
  ScheduleStore,
  ScheduleStoreTransaction,
} from './store';

// The deterministic CPM forecast (pure function; derived reads only).
export { forecastOfBaseline, forecastOfSchedule, forecastSchedule } from './forecast';
export type {
  ForecastActivity,
  ForecastActivityInput,
  ForecastDependencyInput,
  ForecastMilestone,
  ForecastMilestoneInput,
  ForecastNetworkInput,
  ForecastProgressInput,
  ScheduleForecast,
} from './forecast';

// The deterministic current-vs-baseline variance (pure derived read).
export { scheduleVariance } from './variance';
export type { ActivityVariance, ScheduleVariance } from './variance';

// Mutation command handlers (parse → authorize → load scoped → concurrency →
// pure transition → store write + event append inside ONE transaction).
export {
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  ADD_MILESTONE_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  RECORD_PROGRESS_COMMAND,
  REMOVE_DEPENDENCY_COMMAND,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  createScheduleCommands,
  parseAddActivityPayload,
  parseAddDependencyPayload,
  parseAddMilestonePayload,
  parseCreateSchedulePayload,
  parseRecordProgressPayload,
  parseRemoveDependencyPayload,
  parseSetBaselinePayload,
  parseUpdateActivityPayload,
} from './commands';
export type {
  AddActivityPayload,
  AddDependencyPayload,
  AddMilestonePayload,
  CreateSchedulePayload,
  RecordProgressPayload,
  RemoveDependencyPayload,
  ScheduleCommandAuthorization,
  ScheduleCommandDeps,
  ScheduleCommands,
  SetBaselinePayload,
  UpdateActivityPayload,
} from './commands';

// The thin ledger-backed EventSink adapter (appendEvent + enqueueOutbox per
// envelope, inside the caller's transaction).
export { createLedgerEventSink } from './ledger-sink';
