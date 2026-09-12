// Office organization domain — public surface (OFF-007).
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
// (SqlExecutor/TransactionRunner, migrator conventions) — plus node builtins.
// No external dependencies; @office/events is deliberately NOT imported (the
// EventSink port below is the seam the event ledger implements later).
//
// Surface summary:
// - state:       OrganizationState, OrganizationStatus,
//                ORGANIZATION_STATUSES, ORGANIZATION_KIND,
//                ORGANIZATION_INVARIANTS, NewOrganization,
//                OrganizationChanges, createOrganizationState,
//                updateOrganizationState, archiveOrganizationState
// - repository:  OrganizationsRepository, createOrganizationsRepository
// - events:      EventSink, InMemoryEventSink, RecordedEventAppend,
//                createInMemoryEventSink, failingEventSink,
//                eventSinkFailure, ORGANIZATION_CREATED_EVENT,
//                ORGANIZATION_UPDATED_EVENT, ORGANIZATION_ARCHIVED_EVENT,
//                organizationEventEnvelope, organizationRef (+ payload types)
// - commands:    OrganizationCommands, createOrganizationCommands,
//                OrganizationCommandDeps, OrganizationCommandAuthorization,
//                CREATE/UPDATE/ARCHIVE_ORGANIZATION_COMMAND (+ payload types
//                and their fail-closed parsers)
// - migrations:  ORGANIZATION_MIGRATIONS_DIR (0100_organizations.sql — apply
//                with @office/persistence's migrator conventions)

// Aggregate state, invariants, and pure lifecycle transitions.
export {
  ORGANIZATION_INVARIANTS,
  ORGANIZATION_KIND,
  ORGANIZATION_STATUSES,
  archiveOrganizationState,
  createOrganizationState,
  updateOrganizationState,
} from './state';
export type {
  OrganizationChanges,
  OrganizationState,
  OrganizationStatus,
} from './state';

// The tenant-scoped organizations repository (A12 by construction).
export { createOrganizationsRepository } from './repository';
export type { NewOrganization, OrganizationsRepository } from './repository';

// Audit events + THE EventSink port (minimal; OFF-005's ledger implements it).
export {
  ORGANIZATION_ARCHIVED_EVENT,
  ORGANIZATION_CREATED_EVENT,
  ORGANIZATION_UPDATED_EVENT,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  organizationEventEnvelope,
  organizationRef,
} from './events';
export type {
  EventSink,
  InMemoryEventSink,
  OrganizationArchivedPayload,
  OrganizationCreatedPayload,
  OrganizationUpdatedPayload,
  RecordedEventAppend,
} from './events';

// Lifecycle command handlers (authorize → load → concurrency → mutate →
// repository write + event append inside ONE transaction).
export {
  ARCHIVE_ORGANIZATION_COMMAND,
  CREATE_ORGANIZATION_COMMAND,
  UPDATE_ORGANIZATION_COMMAND,
  createOrganizationCommands,
  parseArchiveOrganizationPayload,
  parseCreateOrganizationPayload,
  parseUpdateOrganizationPayload,
} from './commands';
export type {
  ArchiveOrganizationPayload,
  CreateOrganizationPayload,
  OrganizationCommandAuthorization,
  OrganizationCommandDeps,
  OrganizationCommands,
  UpdateOrganizationPayload,
} from './commands';

// The package's migrations directory (apply via @office/persistence's migrator).
export { ORGANIZATION_MIGRATIONS_DIR } from './migrations';
