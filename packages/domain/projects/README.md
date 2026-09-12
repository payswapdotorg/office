# @office/domain-projects

Project domain module for PaySwap Office (**OFF-007**) — the canonical
tenant+project-scoped **Project aggregate** of the frozen enterprise graph
(freeze A1): THE second authorization boundary of the whole system (freeze
A12), with an explicit one-way lifecycle (`active` → `archived`), lifecycle
commands guarded by deny-by-default authorization, and an audit event for
every consequential mutation. The `projects` table itself is the OFF-004
foundation's (migration `0002`, immutable); this package owns its lifecycle
extension (migration `0101`, a pure additive `ALTER TABLE`).

Runtime dependencies are exactly `@office/contracts`,
`@office/domain-kernel`, `@office/authz`, and `@office/persistence` — no
external dependencies, and `@office/events` is deliberately NOT imported
(the `EventSink` port below is the seam the event ledger implements). This
is verified by `src/boundary.test.ts`, the package's boundary self-gate.

`src/index.ts` is the whole public surface; import only from the package
root (`@office/domain-projects`). Anything not re-exported there is
package-internal and may change without notice.

The package mirrors the structure of the sibling
`@office/domain-organization` module exactly (state / events / repository /
commands / migrations) — the two domain modules stay independent (no
domain-to-domain imports, dependency rule), so shared plumbing (parse
helpers, the EventSink port) is duplicated per package rather than
extracted.

## What is here

| Area | Exports |
| --- | --- |
| State | `ProjectState`, `ProjectStatus`, `PROJECT_STATUSES`, `PROJECT_KIND`, `PROJECT_INVARIANTS`, `NewProject`, `ProjectChanges`, `createProjectState`, `updateProjectState`, `archiveProjectState` |
| Repository | `ProjectsDomainRepository`, `createProjectsDomainRepository` |
| Events | `EventSink`, `InMemoryEventSink`, `RecordedEventAppend`, `createInMemoryEventSink`, `failingEventSink`, `eventSinkFailure`, `PROJECT_CREATED_EVENT`, `PROJECT_UPDATED_EVENT`, `PROJECT_ARCHIVED_EVENT`, `projectEventEnvelope`, `projectRef` (+ payload types) |
| Commands | `ProjectCommands`, `createProjectCommands`, `ProjectCommandDeps`, `ProjectCommandAuthorization`, `CREATE_PROJECT_COMMAND`, `UPDATE_PROJECT_COMMAND`, `ARCHIVE_PROJECT_COMMAND` (+ payload types and their fail-closed parsers) |
| Migrations | `PROJECT_MIGRATIONS_DIR` — `migrations/0101_projects_lifecycle.sql`, applied through `@office/persistence`'s migrator conventions |

## The mutation path (the cross-view flow, per command)

1. **Parse** the payload fail-closed (strict keys, branded `ProjectId`s
   with the `prj` kind code, typed versions) — a malformed payload is a
   typed `invariant-violation`, never a silent default.
2. **Authorize** with the caller-supplied `Policy` through `@office/authz`'s
   deny-by-default `authorize()` — structural A12 scope coverage first, then
   explicit deny, then allow, then default deny. A denied command never
   opens a transaction.
3. **Load** through the tenant/project-scoped repository — a foreign
   tenant's row is a typed `not-found` (no existence oracle), a
   project-scoped command addressing another project is a typed
   `unauthorized` (`project-scope-violation`), and the kernel's
   `checkScopeCovers` re-checks scope coverage as a backstop.
4. **Check optimistic concurrency** (`checkConcurrency`) — a stale version
   is a typed `concurrency-conflict`; state is never silently overwritten.
5. **Mutate** through the invariant-checked pure transition (updates and
   archives require `active`; archive is the explicit one-way lifecycle
   event).
6. **Write + append atomically**: the repository write AND the audit event
   append through the injected `EventSink` run inside ONE
   `runInTransaction` — a failure anywhere rolls everything back.

Determinism (kernel rule): handlers read no wall clock and no randomness —
`now` and the canonical-id opaque parts come from the injected suppliers
(`ProjectCommandDeps`), and the canonical id is composed through
`formatProjectId`, so every issued id parses with `parseProjectId` by
construction.

## The project scope (second boundary) specifics

- A project **owns its own project scope**:
  `{ kind: 'project', tenantId, projectId = entityId }` — enforced by a
  declarative invariant, so a project state can never claim a foreign
  scope. Every audit event carries this scope (freeze A3/A12).
- **Create**: a tenant-scoped command gets a fresh canonical `ProjectId`
  from the injected supplier; a project-scoped command initializes exactly
  the project its scope addresses (deterministic — no id issued). The
  repository's `projectScopeMismatch` guard enforces the project-scoped
  case at the storage boundary.
- **Update/archive**: the authorization resource is the addressed project
  bound to the COMMAND's tenant — a project-scoped command addressing a
  different project is denied by the structural check BEFORE any
  transaction opens, while a cross-tenant attempt passes authorization and
  vanishes at the tenant-scoped repository as a typed `not-found` (freeze
  A12 invisibility — no existence oracle). A tenant-scoped command covers
  every project of its tenant; a project-scoped command covers exactly its
  own.

## The EventSink port contract

```ts
interface EventSink {
  appendEvents(
    executor: SqlExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}
```

- `executor` is the **open transaction** of the surrounding mutation — a
  real implementation (the OFF-005 event ledger, wired by the runtime)
  writes its ledger rows with it, so event persistence is atomic with the
  state change that produced it.
- A failure result **must abort** the mutation: handlers roll the
  transaction back, so a partially-applied mutation can never commit.
- The port is **structural and minimal by design**: any object with this
  method satisfies it. It is mirrored byte-for-byte in shape by
  `@office/domain-organization`, and one implementation serves both.
- The package ships `createInMemoryEventSink()` (records appends for
  deterministic tests) and `failingEventSink(reason)` (typed failures for
  rollback tests and wiring guards).

Every lifecycle event is a `DomainEventEnvelope` built by
`projectEventEnvelope` (self-checked through the contracts parser): event
name, the aggregate's own project scope, actor and correlation/causation
propagated from the command envelope (the event's causation id is the
command's idempotency key — the OFF-005 ledger convention), `source:
'domain'`, `occurredAt` from the injected clock, and before/after
`EntityRef`s per transition kind.

## Storage & migrations

The `projects` table belongs to the OFF-004 foundation (migration `0002`,
immutable — tenant_id + project_id scope columns, typed core columns, JSONB
extension metadata, optimistic-concurrency version). This package owns
`migrations/0101_projects_lifecycle.sql` — a pure additive `ALTER TABLE`
adding the explicit lifecycle (`status` with the closed vocabulary
defaulting to `active` for pre-existing rows, `archived_at`, and a row-level
CHECK keeping the pair consistent): archive is an explicit recorded
transition, never a delete and never a silent flag.

The migration ships co-located with the package (the OFF-005-established
convention — the ledger's migrations travel under `packages/events/migrations`,
and the organization module's under
`packages/domain/organization/migrations`). A runtime composes the full
canonical chain by pointing `@office/persistence`'s migrator at a directory
containing the persistence migrations (`0001`, `0002`), the events
migrations (`0003`, `0004`), the organization migration (`0100`), and this
package's (`0101`) — ascending version order holds throughout (`0101+` is
this package's range).

Why co-located (documented deviation, accepted by the Tech Lead): the
frozen integration suites of `@office/persistence` and `@office/events`
assert the exact applied-version list of THEIR composed chains; adding new
files to their migration directories would break those suites, and editing
`0001`/`0002` or `packages/persistence/src` is forbidden by this item's
boundary. Co-location keeps every suite's chain exactly what it composes,
and `0002` stays byte-identical.

## Running the tests

From the repo root (the workspace globs cover `packages/domain/*`):

```bash
pnpm test              # all packages, including this one
pnpm vitest run packages/domain/projects   # just this package
```

Unit suites (`state`, `events`, `commands`, `boundary`) are pure and
deterministic (fixed ids, fixed injected clock, no I/O). The integration
suite runs on **real PostgreSQL** through `@office/persistence`'s harness:
set `DATABASE_URL` (postgres://) for CI mode, or let it boot an embedded
PostgreSQL locally — an empty scratch database, the composed migration
chain (0001, 0002, 0101) applied from zero, and every acceptance property
proven: lifecycle with authorization + audit events (both create paths),
typed denials (capability, explicit deny, cross-tenant invisibility,
second-boundary violation), optimistic concurrency, atomicity of write +
event append, deterministic canonical ids, and tenant/project isolation.
