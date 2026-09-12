// Office project domain — public surface (OFF-007).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-008+ domains, workflows, the action gateway, apps) consume the
// package only through its root entry point, never through deeper paths.
// Anything not re-exported here is package-internal and may change without
// notice.
//
// The package imports exactly four workspace dependencies — @office/contracts
// (envelopes + canonical ids), @office/domain-kernel (Result/DomainError,
// aggregate versioning + concurrency, invariants), @office/authz (the
// deny-by-default authorize() evaluator), and @office/persistence
// (SqlExecutor/TransactionRunner, projectScopeMismatch, migrator
// conventions) — plus node builtins. No external dependencies; @office/events
// is deliberately NOT imported (the EventSink port below is the seam the
// event ledger implements later).
//
// Surface summary:
// - state:       ProjectState, ProjectStatus, PROJECT_STATUSES,
//                PROJECT_KIND, PROJECT_INVARIANTS, NewProject,
//                ProjectChanges, createProjectState, updateProjectState,
//                archiveProjectState
// - repository:  ProjectsDomainRepository, createProjectsDomainRepository
// - events:      EventSink, InMemoryEventSink, RecordedEventAppend,
//                createInMemoryEventSink, failingEventSink,
//                eventSinkFailure, PROJECT_CREATED_EVENT,
//                PROJECT_UPDATED_EVENT, PROJECT_ARCHIVED_EVENT,
//                projectEventEnvelope, projectRef (+ payload types)
// - commands:    ProjectCommands, createProjectCommands,
//                ProjectCommandDeps, ProjectCommandAuthorization,
//                CREATE/UPDATE/ARCHIVE_PROJECT_COMMAND (+ payload types
//                and their fail-closed parsers)
// - migrations:  PROJECT_MIGRATIONS_DIR (0101_projects_lifecycle.sql — apply
//                with @office/persistence's migrator conventions)

// Aggregate state, invariants, and pure lifecycle transitions.
export {
  PROJECT_INVARIANTS,
  PROJECT_KIND,
  PROJECT_STATUSES,
  archiveProjectState,
  createProjectState,
  updateProjectState,
} from './state';
export type {
  ProjectChanges,
  ProjectState,
  ProjectStatus,
} from './state';

// The tenant/project-scoped projects domain repository (A12 by construction).
export { createProjectsDomainRepository } from './repository';
export type { NewProject, ProjectsDomainRepository } from './repository';

// Audit events + THE EventSink port (minimal; OFF-005's ledger implements it).
export {
  PROJECT_ARCHIVED_EVENT,
  PROJECT_CREATED_EVENT,
  PROJECT_UPDATED_EVENT,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  projectEventEnvelope,
  projectRef,
} from './events';
export type {
  EventSink,
  InMemoryEventSink,
  ProjectArchivedPayload,
  ProjectCreatedPayload,
  ProjectUpdatedPayload,
  RecordedEventAppend,
} from './events';

// Lifecycle command handlers (authorize → load → concurrency → mutate →
// repository write + event append inside ONE transaction).
export {
  ARCHIVE_PROJECT_COMMAND,
  CREATE_PROJECT_COMMAND,
  UPDATE_PROJECT_COMMAND,
  createProjectCommands,
  parseArchiveProjectPayload,
  parseCreateProjectPayload,
  parseUpdateProjectPayload,
} from './commands';
export type {
  ArchiveProjectPayload,
  CreateProjectPayload,
  ProjectCommandAuthorization,
  ProjectCommandDeps,
  ProjectCommands,
  UpdateProjectPayload,
} from './commands';

// The package's migrations directory (apply via @office/persistence's migrator).
export { PROJECT_MIGRATIONS_DIR } from './migrations';
