# @office/persistence

PostgreSQL persistence foundation for PaySwap Office (**OFF-004**) — the
transactional system of record layer every later module builds on: ordered
plain-SQL migrations with a transactional migrator, the `TransactionRunner`
transactional boundary, tenant/project scoped statement composition, and
typed reference repositories (tenants, projects) with optimistic concurrency.

Stack decision (lead-directed): **repository-equivalent SQL mapping** — the
`pg` (node-postgres) driver + hand-written SQL migrations + typed
repositories. No ORM, no schema engine, no query builder. Runtime
dependencies are exactly `@office/contracts`, `@office/domain-kernel`, and
`pg`; node builtins aside, nothing else is imported (verified by
`src/boundary.test.ts`).

`src/index.ts` is the whole public surface; import only from the package
root (`@office/persistence`). Anything not re-exported there is
package-internal and may change without notice.

## What is here

| Area | Exports |
| --- | --- |
| SQL surface | `SqlValue`, `SqlResult`, `SqlExecutor` (the typed driver seam — pool, session, or open transaction) |
| Failures | `PersistenceFailure` (+ `PersistenceFailureCode`) — typed operational faults; expected domain failures are `DomainError`s on the Result channel |
| Scoping | `scopedSql`, `ScopedSql`, `projectScopeMismatch`, `TENANT_SCOPE_COLUMN`, `PROJECT_SCOPE_COLUMN` |
| Pool | `PersistencePool`, `createPersistencePool`, `createTransactionRunner` |
| Transactions | `Transaction`, `TransactionRunner` |
| Migrations | `MigrationFile`, `AppliedMigration`, `MigrationRunResult`, `Migrator`, `createMigrator`, `readMigrationFiles`, `parseMigrationFileName`, `MIGRATION_FILE_PATTERN`, `DEFAULT_MIGRATIONS_DIR` |
| Repositories | `TenantsRepository` (`createTenantsRepository`, `TenantRecord`, `NewTenant`), `ProjectsRepository` (`createProjectsRepository`, `ProjectRecord`, `NewProject`, `ProjectChanges`) |
| Test harness | `startPersistenceTestHarness`, `PersistenceTestHarness`, `PersistenceTestHarnessOptions` |

## The construction guarantee (freeze A12)

Every repository statement is tenant-scoped **by construction**: a statement
can only be composed from a validated contracts `Scope` via `scopedSql`,
which binds the tenant id as the **first** parameter and emits the
`tenant_id = $1` predicate (plus `project_id = $2` under project scope).
There is no unscoped SQL path through the public API. Consequences proven
by the integration suite:

- a foreign-tenant row is simply **not visible** — reads and writes return
  a typed `not-found` `DomainError`, never cross-tenant data, with no
  existence oracle (foreign row and missing row are indistinguishable);
- the **project second boundary** is checked before any SQL runs: a
  project-scoped call addressing a different project is a typed
  `unauthorized` (`project-scope-violation`) failure;
- row **ownership comes from the scope**, never from caller input: the
  insert column list binds `tenant_id` from the executing scope;
- writes are guarded by **optimistic concurrency** (`WHERE … AND version =
  $expected`): a stale version is a typed `concurrency-conflict`, never a
  silent overwrite.

## TransactionRunner semantics

`runInTransaction(work)` is the one atomic seam (the one OFF-005 builds the
event-ledger + outbox on):

- `work` receives a `Transaction` — a `SqlExecutor` plus `tx.rollback(value)`;
  repositories run inside it unchanged (they accept any `SqlExecutor`).
- `work` resolves → **COMMIT**; the resolved value becomes the call's value.
- `work` throws → **ROLLBACK**; the original error is rethrown (never
  swallowed, never replaced). A failure inside the transaction leaves **no
  partial writes**.
- `tx.rollback(value)` → **ROLLBACK** with every write of the attempt
  discarded, and `value` becomes the call's value. This is how a handler
  returns a typed `DomainError` failure while guaranteeing the writes are
  gone: `return tx.rollback(fail(entityNotFound(…)))`.
- A `Result` failure value alone does **not** roll back — repositories
  return typed failures as values; the handler decides and rolls back
  explicitly (throw or `tx.rollback`).
- Isolation is READ COMMITTED; optimistic-concurrency `WHERE version = …`
  guards are exact under it. Transactions are **not nestable** — code that
  already holds a transaction passes its `tx` down as the `SqlExecutor`.

Typing note: when the *only* return of `work` is `tx.rollback(value)` the
callback infers as `never` — annotate the callback's return type
(`async (tx): Promise<Result<…, DomainError>> => …`) in that case; a
callback that also returns non-rollback values infers naturally.

Operational faults (driver errors, corrupt rows, broken migrations) are
loud, typed `PersistenceFailure` exceptions carrying the driver error as
`cause` — never raw driver errors, never swallowed, never Result values.

## Migrations

Migrations are plain `.sql` files under `migrations/`, named
`<NNNN>_<snake_name>.sql` (4-digit version, 1..9999), applied in ascending
version order. They are **immutable once applied and forward-only**: each
run verifies applied checksums (sha256 of the file text), rejects edits to
applied files, rejects pending files below the high-water mark, and rejects
unknown/non-matching files (fail closed — a typo'd migration is never
silently skipped). Each migration applies inside its own transaction that
also records the run in the `schema_migrations` ledger; a failed migration
rolls back completely and stops the run. The whole run is serialized
cluster-wide with a session advisory lock.

```ts
import { createMigrator, createPersistencePool } from '@office/persistence';

const pool = createPersistencePool({ connectionString });
const migrator = createMigrator(pool /*, { migrationsDir, now } */);
const { applied, verified } = await migrator.migrate(); // idempotent no-op when current
```

Run it against an **empty database** (the migrator bootstraps the ledger
table itself); never point it at a database with existing state. Schema
conventions: canonical id columns are TEXT primary keys; typed columns for
core fields; JSONB only for extension metadata; `version` BIGINT for
optimistic concurrency; `created_at`/`updated_at` TIMESTAMPTZ supplied by
the caller's injected clock.

## Test harness modes

`startPersistenceTestHarness()` (from the package root; test-only) yields a
pool bound to an **empty scratch database** and a `stop()` to call in
`afterAll`:

- **`DATABASE_URL` set to a PostgreSQL URL** (`postgres://` or
  `postgresql://`, CI mode): the harness uses THAT server but never the
  referenced database's contents — it connects to the server's maintenance
  database and drops/creates a uniquely named scratch database, so pointing
  it at a populated database can never destroy it. CI provides a
  `postgres:17` service with `DATABASE_URL` pointing at it. A well-formed
  PostgreSQL URL that cannot be reached fails loudly (no silent fallback).
- **`DATABASE_URL` unset, empty, or a non-PostgreSQL scheme** (local mode):
  the harness boots its own embedded-postgres 17.10 cluster rootlessly on a
  free port ≥ 5434, creates the scratch database on it, and tears the
  cluster down in `stop()`. `embedded-postgres` is a ROOT devDependency,
  imported dynamically so production imports never load it.

Either way the "migration from an empty database" acceptance is exercised
literally: the pool starts empty and the suite migrates it.

## Verification

- `pnpm lint` / `pnpm typecheck` — clean at the repository root.
- `pnpm test` — unit suites (`scope`, `migrator`, `boundary`) plus the
  integration acceptance suite (`integration.test.ts`): migrations from an
  empty database, transactional rollback (throw and `tx.rollback(value)`),
  tenant isolation, project second boundary, optimistic concurrency, typed
  columns + JSONB round trips, fail-closed row decoding, and scoped-by-
  construction statement recording.
