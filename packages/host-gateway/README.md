# @office/host-gateway

Office production gateway composition (OFF-DEPLOY) — **THE server-side runtime
behind the browser host**: the typed topology's gateway component
(`packages/operations/src/topology/model.ts`) made runnable. One composition
owns every production concern the browser host cannot: the pg pool over the
CALLER-supplied connection string (the package never reads `DATABASE_URL`
itself — the host's route layer does), the forward-only migrator over the
ORDERED UNION of every landed migration directory, the REAL canonical
PostgreSQL path (tenants/organizations/projects through the landed domain
repositories + their own lifecycle command services, audit events appended to
the real event ledger + outbox inside the command's own transaction), the
@office/web session/view-model/command surface driven server-side over the
deterministic seeded reference world, and the REAL A8 action gateway with the
approval-gated workflow decision routed through the workflow-engine-backed
approval authority. It is the ONLY workspace package `apps/host` may import
besides `@office/web`: all SQL lives here, so the browser host stays
structurally database-free (the architecture gate enforces it for every
`apps/*`).

## Public surface (src/index.ts — the whole surface)

- `createHostRuntime(options) -> HostRuntime` — THE composition: pool,
  `migrate()` (the ordered union of all six landed migrations), `health()`
  (the typed readiness report: pool reachability + applied-migration state +
  the injected release identity), `openSession`, the seeded reference world +
  hosted session + online data plane, the canonical PG surface (repositories,
  lifecycle command services, `composeCommand`, `updateProject`), the read
  surfaces (`projectWorkspace` / `controlTowerView` / the evidence walkers,
  scope-checked, typed Results), the shell's typed command bindings driven
  server-side, the A8 approval-gated action surface, and `end()`.
- `composeCanonicalMigrations` + `LANDED_MIGRATION_DIRS` — the migration
  policy made runnable (unique + strictly ascending across the union, the
  files copied verbatim so the migrator's immutability guard sees the real
  history).
- The fail-closed request parsers (`parseUpdateProjectRequest`,
  `parseApprovalDecisionRequest`, `parseCaptureFieldObservationRequest`,
  `parseRecordCostItemRequest`, `parseSubmitWorkflowApprovalRequest`,
  `parseApproveWorkflowApprovalRequest`, `parseAdvanceWorkflowRequest`) —
  what the host's route layer parses untrusted JSON with (strict keys, typed
  `HostInputRejection` values, never a throw).
- `APPROVAL_DECISION_DESCRIPTOR` + the approval proposal/handler helpers —
  the registered approval-gated action (the shell's workflow approval
  decision, class approval-required).
- `createLedgerAuditSink` — the transactional ledger + outbox `EventSink` the
  canonical command path and the A8 audit trail append through.

The hosted identities (`HOST_TENANT_ID` / `HOST_PROJECT_ID` /
`HOST_ACTOR_ID` / `HOST_CORRELATION_ID`) are fixed deterministic literals;
`DEFAULT_RELEASE_ID` is the local-development release identity.

## Consumed packages (exactly nine, all `workspace:^`)

| package | role in the composition |
| --- | --- |
| `@office/persistence` | the pool + transaction runner + migrator + tenants repository |
| `@office/events` | the REAL event ledger + outbox (append/read/enqueue) + the events migrations |
| `@office/actions` | the REAL A8 action gateway + the workflow-engine-backed approval authority |
| `@office/web` | the session + seeded reference world + data plane + view models + command bindings |
| `@office/authz` | the policy/capability authorization inputs the command services take |
| `@office/contracts` | canonical envelopes, scopes, actors, and the fail-closed parse helpers |
| `@office/domain-kernel` | `Result`/`DomainError`, aggregate versioning, idempotency registry |
| `@office/domain-organization` | the organization PG repository + lifecycle command service + migrations |
| `@office/domain-projects` | the project PG repository + lifecycle command service + migrations |

No external dependencies, no deep workspace paths (`src/boundary.test.ts`
proves it by scanning the package), no other `@office` import of any kind.
All SQL flows the landed scoped surfaces (the repositories, the ledger +
outbox functions) — the gateway composes them; it never writes a SQL
statement of its own, so the A12 tenant-scope discipline of
`packages/persistence` / `packages/events` holds here too (the architecture
gate's persistence-facing scan covers this package by construction).

## Deterministic discipline

Every clock and canonical-id supplier is INJECTED (`options.now`,
`options.newOpaqueId`) — no wall clock, no randomness; the hosted seed
identities are fixed literals, so the same options compose the byte-identical
seeded reference world (the integration suite's run-twice proof). Typed
Results everywhere: expected domain failures are values; the landed
`PersistenceFailure` split is wrapped into typed operational-failure Results
at `migrate()` / `health()`; request-shaped inputs are parsed fail-closed
through the exported parsers or the landed contracts parsers — never
trusted, never a throw.

## The honest canonical-state boundary

PG is the canonical store for every landed PG surface (tenants,
organizations, projects + lifecycle, the event ledger, the outbox — six
migrations). The richer domain surfaces (cost/schedule/field/workflows) run
over the packages' public in-memory reference engines — the deterministic
semantic-reference projection of `seedOfficeWorld` — exactly the
reference-scenario discipline. No surface is duplicated across both. See
`docs/execution/DEPLOYMENT.md` for the deployment topology this composition
serves.

## Tests

| suite | proves |
| --- | --- |
| `src/integration.test.ts` | the ordered six-migration union from an empty database; health; the canonical PG path (REAL commands, REAL ledger, REAL outbox, optimistic concurrency); the evidence walkers; A12 both directions; run-twice determinism |
| `src/actions-gateway.test.ts` | the A8 approval-gated action end to end over the REAL ledger: route, complete, audit, evidence, replay, and the typed deny cases |
| `src/boundary.test.ts` | the nine-dependency boundary, forbidden imports, vocabulary + determinism scans, the source entry point |

Run them with the repo-root `pnpm test` (the workspace vitest glob covers
`packages/*/src/**/*.test.ts`); the two integration suites boot the landed
persistence test harness (`DATABASE_URL` unset → the embedded local cluster).
