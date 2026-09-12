// Office persistence — public surface (OFF-004).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-005 events/outbox, OFF-007+ domain repositories) consume the package
// only through its root entry point, never through deeper paths. Anything
// not re-exported here is package-internal and may change without notice.
//
// Stack decision (lead-directed): repository-equivalent SQL mapping —
// `pg` (node-postgres) + hand-written ordered SQL migrations + a small
// migrator + typed repositories. No ORM, no engines, no query builders.
//
// Surface summary:
// - sql:          SqlValue, SqlResult, SqlExecutor (the typed driver surface)
// - failure:      PersistenceFailure (+ PersistenceFailureCode) — typed
//                 operational faults; expected domain failures are
//                 DomainErrors on the Result channel, never thrown
// - scope:        scopedSql (tenant/project scoped statement binder, the A12
//                 construction guarantee), projectScopeMismatch,
//                 TENANT_SCOPE_COLUMN, PROJECT_SCOPE_COLUMN
// - pool:         PersistencePool, createPersistencePool,
//                 createTransactionRunner
// - transaction:  Transaction, TransactionRunner — THE transactional seam
//                 (automatic rollback on throw; tx.rollback(value) for typed
//                 failures with discarded writes)
// - migrator:     MigrationFile, AppliedMigration, MigrationRunResult,
//                 Migrator, createMigrator, readMigrationFiles,
//                 parseMigrationFileName, MIGRATION_FILE_PATTERN,
//                 DEFAULT_MIGRATIONS_DIR
// - tenants:      TenantRecord, NewTenant, TenantsRepository,
//                 createTenantsRepository (reference tenant metadata repo)
// - projects:     ProjectRecord, NewProject, ProjectChanges,
//                 ProjectsRepository, createProjectsRepository (reference
//                 scoped repository: tenant isolation by construction, project
//                 second boundary, optimistic concurrency)
// - testing:      startPersistenceTestHarness (DATABASE_URL CI mode /
//                 embedded-postgres local mode, empty scratch database)

// Typed SQL surface over node-postgres.
export type { SqlExecutor, SqlResult, SqlValue } from './sql';

// Typed operational faults (expected domain failures are Result values).
export { PersistenceFailure } from './failure';
export type { PersistenceFailureCode } from './failure';

// Tenant/project scoped statement composition (freeze A12).
export { PROJECT_SCOPE_COLUMN, TENANT_SCOPE_COLUMN, projectScopeMismatch, scopedSql } from './scope';
export type { ScopedSql } from './scope';

// Pooled surface + transaction boundary.
export { createPersistencePool, createTransactionRunner } from './pool';
export type { PersistencePool, PersistencePoolOptions } from './pool';
export type { Transaction, TransactionRunner } from './transaction';

// Ordered plain-SQL migrations + migrator.
export {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATION_FILE_PATTERN,
  createMigrator,
  parseMigrationFileName,
  readMigrationFiles,
} from './migrator';
export type {
  AppliedMigration,
  MigrationFile,
  MigrationRunResult,
  Migrator,
  MigratorOptions,
} from './migrator';

// Reference repositories (schema conventions + scope isolation).
export { createProjectsRepository } from './projects';
export type {
  NewProject,
  ProjectChanges,
  ProjectRecord,
  ProjectsRepository,
} from './projects';
export { createTenantsRepository } from './tenants';
export type { NewTenant, TenantRecord, TenantsRepository } from './tenants';

// Integration-test harness (test-only; boots/uses real PostgreSQL).
export { startPersistenceTestHarness } from './testing';
export type {
  PersistenceTestHarness,
  PersistenceTestHarnessOptions,
} from './testing';
