# @office/domain-organization

Organization domain module for PaySwap Office (**OFF-007**) — the canonical
tenant-scoped **Organization aggregate** of the frozen enterprise graph
(freeze A1): a named enterprise unit (a construction company, a business
unit, a client organization) with an explicit one-way lifecycle
(`active` → `archived`), lifecycle commands guarded by deny-by-default
authorization, and an audit event for every consequential mutation.

Runtime dependencies are exactly `@office/contracts`,
`@office/domain-kernel`, `@office/authz`, and `@office/persistence` — no
external dependencies, and `@office/events` is deliberately NOT imported
(the `EventSink` port below is the seam the event ledger implements). This
is verified by `src/boundary.test.ts`, the package's boundary self-gate.

`src/index.ts` is the whole public surface; import only from the package
root (`@office/domain-organization`). Anything not re-exported there is
package-internal and may change without notice.

## What is here

| Area | Exports |
| --- | --- |
| State | `OrganizationState`, `OrganizationStatus`, `ORGANIZATION_STATUSES`, `ORGANIZATION_KIND`, `ORGANIZATION_INVARIANTS`, `NewOrganization`, `OrganizationChanges`, `createOrganizationState`, `updateOrganizationState`, `archiveOrganizationState` |
| Repository | `OrganizationsRepository`, `createOrganizationsRepository` |
| Events | `EventSink`, `InMemoryEventSink`, `RecordedEventAppend`, `createInMemoryEventSink`, `failingEventSink`, `eventSinkFailure`, `ORGANIZATION_CREATED_EVENT`, `ORGANIZATION_UPDATED_EVENT`, `ORGANIZATION_ARCHIVED_EVENT`, `organizationEventEnvelope`, `organizationRef` (+ payload types) |
| Commands | `OrganizationCommands`, `createOrganizationCommands`, `OrganizationCommandDeps`, `OrganizationCommandAuthorization`, `CREATE_ORGANIZATION_COMMAND`, `UPDATE_ORGANIZATION_COMMAND`, `ARCHIVE_ORGANIZATION_COMMAND` (+ payload types and their fail-closed parsers) |
| Migrations | `ORGANIZATION_MIGRATIONS_DIR` — `migrations/0100_organizations.sql`, applied through `@office/persistence`'s migrator conventions |

## The mutation path (the cross-view flow, per command)

1. **Parse** the payload fail-closed (strict keys, branded ids, typed
   versions) — a malformed payload is a typed `invariant-violation`, never
   a silent default.
2. **Authorize** with the caller-supplied `Policy` through `@office/authz`'s
   deny-by-default `authorize()` — structural A12 scope coverage first, then
   explicit deny, then allow, then default deny. A denied command never
   opens a transaction.
3. **Load** through the tenant-scoped repository — a foreign tenant's row
   is a typed `not-found` (no existence oracle), and the kernel's
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
(`OrganizationCommandDeps`), and the canonical id is composed through
`formatEntityId`, so every issued id parses with `parseEntityId` by
construction.

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
  `@office/domain-projects`, and one implementation serves both.
- The package ships `createInMemoryEventSink()` (records appends for
  deterministic tests) and `failingEventSink(reason)` (typed failures for
  rollback tests and wiring guards).

Every lifecycle event is a `DomainEventEnvelope` built by
`organizationEventEnvelope` (self-checked through the contracts parser):
event name, the aggregate's tenant scope, actor and correlation/causation
propagated from the command envelope (the event's causation id is the
command's idempotency key — the OFF-005 ledger convention), `source:
'domain'`, `occurredAt` from the injected clock, and before/after
`EntityRef`s per transition kind.

## Storage & migrations

The `organizations` table is owned by this package and ships co-located at
`migrations/0100_organizations.sql` — the OFF-005-established convention
(the ledger's migrations travel under `packages/events/migrations`). The
persistence foundation owns `0001`/`0002` (immutable) and the event ledger
owns `0003`/`0004`; a runtime composes the full canonical chain by pointing
`@office/persistence`'s migrator at a directory containing all of them —
ascending version order holds throughout (`0100+` is this package's range).
Conventions: canonical id is the `TEXT PRIMARY KEY`; `tenant_id` is the
first scope column with the tenant FK `ON DELETE CASCADE` (freeze A12);
typed columns everywhere, JSONB only for extension metadata (freeze A2);
optimistic-concurrency `version` from 1; timestamps supplied by the
injected clock; the lifecycle is an explicit status + `archived_at` pair
kept consistent by a row-level CHECK — archive is never a delete.

Why co-located (documented deviation, accepted by the Tech Lead): the
frozen integration suites of `@office/persistence` and `@office/events`
assert the exact applied-version list of THEIR composed chains; adding new
files to their migration directories would break those suites, and editing
them is outside this item's ownership. Co-location keeps every suite's
chain exactly what it composes.

## Running the tests

From the repo root (the workspace globs cover `packages/domain/*`):

```bash
pnpm test              # all packages, including this one
pnpm vitest run packages/domain/organization   # just this package
```

Unit suites (`state`, `events`, `commands`, `boundary`) are pure and
deterministic (fixed ids, fixed injected clock, no I/O). The integration
suite runs on **real PostgreSQL** through `@office/persistence`'s harness:
set `DATABASE_URL` (postgres://) for CI mode, or let it boot an embedded
PostgreSQL locally — an empty scratch database, the composed migration
chain applied from zero, and every acceptance property proven: lifecycle
with authorization + audit events, typed denials (capability, explicit
deny, cross-tenant invisibility), optimistic concurrency, atomicity of
write + event append, deterministic canonical ids, and tenant isolation.
