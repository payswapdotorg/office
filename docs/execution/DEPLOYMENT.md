# DEPLOYMENT — the production topology + operations record (OFF-DEPLOY)

The Tech Lead's deployment topology decision for issue #55 (OFF-DEPLOY:
Tech Lead production deployment orchestration), recorded BEFORE the
deployment files change. This document is the operational companion of the
typed topology artifact (`packages/operations/src/topology/model.ts`, the
OFF-038 record) and the incident runbook
(`packages/operations/RUNBOOK.md`): the artifact states the canonical shape,
this record states how that shape is hosted, what is REAL today, and how it
is operated. Hosting facts (vendor names) live HERE and in configuration
files only — the packages stay vendor-neutral (the architecture gate's
vocabulary rule).

## Topology

The typed topology's components, made runnable (generic vocabulary):

| component (typed topology role) | deployment realization |
| --- | --- |
| browser client (`client`) | `apps/host` — a Next.js 15 App Router application, the browser-facing host. It renders `@office/web`'s view models and dispatches its typed commands; it is structurally database-free (no `@office/persistence` import anywhere — enforced by the architecture gate for all `apps/*`). |
| gateway (`gateway`) | `packages/host-gateway` — the server composition package, deployed as Vercel serverless functions behind the host's own API routes (`/api/*`). It owns the pg pool, the migrator, the canonical PG path, the `@office/web` session/view-model/command surface driven server-side, and the A8 action gateway. It is the ONLY workspace package `apps/host` imports besides `@office/web`. |
| canonical store (`database`) | one managed PostgreSQL database (Neon-class; Vercel Postgres once the connection lands): the tenants, organizations, and projects tables, the append-only event ledger, the transactional outbox, and the consumer cursors — exactly the landed PG surfaces and their six migrations. |
| event transport (`event-transport`) | the outbox discipline, operated as the ordered delivery contract between the ledger and its consumers. The first deployment polls on demand; a push-based transport is a documented extension point (below). |
| canonical projections (`projection`) | the tenant/project-scoped tables derived from the ledger (always rebuildable — never the source of truth). |
| the three landed clients (`client`) | the web shell (`@office/web`) is served THROUGH `apps/host` (its view models are the host's rendering contract); the field and desktop shells are landed client packages whose own hosting is future work under the same governance. |
| the four adapter families (`adapter`) | NOT DEPLOYED. The construction/finance/model/schedule adapter families ship as fixture rigs (their health/degrade surfaces and object mappings are landed and tested); connecting real provider tenants is future work under the same governance. Ingested provider data enters only through them, never directly. |

Data flow is the typed artifact's: every client command enters through the
gateway as a fail-closed, session-scoped command envelope; the gateway is
the only surface that touches the canonical store; every read crosses the
tenant scope there (freeze A12 end to end).

## Hosting facts

- **Platform:** Vercel, project Git-connected to this repository, monorepo
  root `apps/host` (the app directory). Deploy flow: pull request → preview
  deployment → promote to production. Rollback is instant to the previous
  deployment (below).
- **Recorded hosting facts (Stage 4, at promote time):** project `office`
  (id `prj_hnyfiZljrASpOmH95twpQQaB5K8x`, personal team, Git-connected to
  `payswapdotorg/office`, production branch `main`, framework preset
  nextjs, root directory `apps/host`, region `iad1`); production alias
  `office-teal-zeta.vercel.app`; bootstrap production deployment
  `dpl_7mPoWXtUvpBwEfJ8p9e1PeYvNquo` (READY, commit `83f4011`, promoted
  2026-09-14) — the audited tip of PR #56 plus the build-wiring and
  build-output commits. The bootstrap deployed the code BEFORE the
  database credentials landed: the host served the honest degradation
  (`/api/health` 503 unreachable, the seeded reference world rendering,
  typed rejections live) exactly as the boot rehearsal predicted; the
  production declaration (Stage 7) follows the database-backed smoke, not
  the bootstrap alone. `NODE_VERSION` is pinned as a project environment
  variable (`22`) for the `engines: node >=22` contract.
- **Recorded hosting facts (Stage 7, at the production declaration):** the
  production database is REAL — Neon, project `office-production` (id
  `square-paper-16539172`, organization `org-shy-shadow-21570034`, region
  `aws-us-east-2` co-located with the `iad1` functions, PostgreSQL 17). The
  application connects through the **pooled endpoint** (PgBouncer, port
  6543 — the serverless-compatible shape; the gateway's parameterized
  queries are transaction-scoped unnamed statements, pooler-compatible —
  the gateway runtime uses no session-scoped advisory locks), while the
  migration/bootstrap operator run uses the **direct endpoint** (port 5432
  — the migrator's advisory-locked dedicated sessions require it). Compute
  autoscales 0.25–2 CU and suspends after idle (the free plan's behavior:
  the first request after an idle suspend pays the compute cold start —
  visible as a slow first `/api/health`, never a wrong answer). The
  database was bootstrapped by the validated operator procedure before the
  database-backed deployment landed: the ordered migration union applied
  6/6 (`tenants` … `projects_lifecycle`), the canonical seed chain inserted
  the hosted tenant → `Hosted Operator Organization` → `Hosted Campus
  Works` through the REAL command paths, and the ledger + outbox rows were
  verified in-database. The first database-backed production deployment is
  `dpl_CEZA2TFDs11Wd1ghLe6hResgohYf` (READY, commit `e380b01`, promoted
  2026-09-14, `DATABASE_URL` present at runtime): `/api/health` answers
  200 `reachable` + 6 applied + `projects_lifecycle` + the release
  identity, and the hosted smoke acceptance chain passed 23/23 against the
  live production URL (readiness + release identity; every read surface
  200; the malformed-envelope typed 400; the field-capture canonical
  command executed end to end; the A8 approval-gated action
  submit → propose → complete with `workflows.approvalApproved` landing in
  the transactional ledger — the production ledger verified to hold the
  bootstrap and smoke events). A client-bundle scan (the served page +
  every JS chunk) found zero secret material (no connection strings, no
  credentials, no key material).
- **Production URL / project id / deployment ids:** the records above;
  the promoted chain so far — `dpl_7mPoWXtUvpBwEfJ8p9e1PeYvNquo`
  (commit `83f4011`, the pre-database bootstrap) → `dpl_Greqbz4Tyc3mgPz6agBQ2xFK4mF1`
  (commit `e380b01`, the Git-connected auto-deploy, still pre-database) →
  `dpl_CEZA2TFDs11Wd1ghLe6hResgohYf` (commit `e380b01`, the first
  database-backed production deployment — **current**; the rollback target
  is `dpl_Greqbz4Tyc3mgPz6agBQ2xFK4mF1`, READY). Later deployments append
  their ids here as they are promoted.
- **Environment classes** (all managed as Vercel environment variables,
  preview and production scoped):
  1. *public vars* — none required today (the host renders server-side; no
     client-side configuration is exposed).
  2. *server-only secrets* — none today; the A8 action gateway's approval
     routing is engine-internal.
  3. *adapter credentials* — none today (no adapter family is deployed).
  4. *database credentials* — `DATABASE_URL`, server-only, pointing at the
     managed PostgreSQL database (realized as an **encrypted** Vercel
     environment variable, production + preview scoped — never a plain/
     public variable, never in any browser module). It is read by the
     host's route layer (never inside `@office/host-gateway`, never in
     any browser module).
  5. *release identifiers* — `VERCEL_DEPLOYMENT_ID` (falling back to
     `RELEASE_ID`, then `local-dev`) surfaces in `/api/health` as the
     release identity.

## The canonical-state boundary (honest scope)

What is REAL PostgreSQL today, versus the deterministic reference projection:

- **REAL PG (the canonical store):** tenants, organizations, projects
  (including their lifecycle), the append-only event ledger, the
  transactional outbox, and the consumer cursors — the landed PG
  repositories and their six migrations `0001_tenants`,
  `0002_projects`, `0003_event_ledger`, `0004_outbox`,
  `0100_organizations`, `0101_projects_lifecycle`. The gateway composes the
  landed domain repositories and command services over the pool; the
  canonical org/project lifecycle commands write through them (typed
  Results, optimistic concurrency, audit events appended to the ledger +
  outbox inside the same transaction).
- **The reference-engine projection (the semantic reference):** the richer
  domain surfaces — schedule, field, cost, contracts, documents, workflows,
  and the intelligence folds — are composed through the packages' public
  in-memory engines (`@office/web`'s seeded world: the deterministic
  reference-scenario discipline). The hosted composition seeds that world
  with injected clock/id suppliers, so the browser host's workspace,
  control-tower, and evidence views are the reference projection of the
  seeded reference world — the semantic reference the issue's "deployment
  tests validate its hosted composition" names.
- **Plainly stated:** PG is the canonical store for every landed PG surface;
  the reference engines are the deterministic semantic-reference projection;
  no surface is duplicated across both. PG backing for the remaining domain
  surfaces is a documented extension point (below), to be landed surface by
  surface under the same governance — never as a silent swap.

## Migration policy

The landed forward-only migrator (`@office/persistence`) is the only schema
authority: `packages/host-gateway` composes the ORDERED UNION of every
landed migration directory — the persistence foundation, the events ledger
+ outbox, and the organization + projects domain migrations — and applies
them in strict version order (1, 2, 3, 4, 100, 101). Never edit an applied
file (the migrator refuses edited history by checksum); never add a
migration below the applied high-water mark; the run is serialized
cluster-wide by the migrator's advisory lock (two booting instances queue
instead of racing). See `packages/operations/RUNBOOK.md` ("Per-failure-mode
operator actions: `migration-failure-mid-batch`") for the operator
procedure on a partially applied batch.

## Hosted composition operations (the validated operator procedures)

The Stage-6 rehearsal over the embedded cluster validated the exact
production procedures (each re-validated against a fresh boot):

1. **Database bootstrap (migrate + canonical seed):** an operator script
   composes the HostRuntime with `DATABASE_URL` and runs `migrate()`
   (the ordered union applies 1–4 + 100 + 101; re-runs verify only), then
   seeds the canonical chain through the REAL command paths —
   `tenants.insert` → `organization.createOrganization` →
   `projects.createProject` under the hosted identities — then reads
   `health()` (reachable + 6 applied + `projects_lifecycle`). The
   procedure is idempotent: re-runs answer typed already-exists /
   recorded-outcome rejections and the health report stays green.
2. **Hosted smoke (the acceptance chain):** `/api/health` 200 reachable
   with the release identity; every read surface 200 (`/`,
   `/control-tower`, `/evidence`, `/api/workspace`, `/api/ledger`); a
   malformed command envelope answers the typed 400; the field-capture
   command executes end to end (`field.fieldEventCaptured` with its
   operation + event ids); the A8 approval-gated action runs
   submit → propose → complete (the live approval must be SUBMITTED
   before the decision — the workflow status guard; the complete returns
   `workflows.approvalApproved` with the ledger audit).
3. **The web session's operation slots (a request-scoped-transport
   consequence, recorded honestly):** the online sync engine derives each
   command's operation id from (subscription, observed cursor position,
   operation kind); in this first deployment the transport is
   request-scoped, so reads do not advance the session's cursor basis and
   each command KIND has effectively one static slot per booted instance.
   Behaviors an operator will see (all typed, none a throw): an identical
   retry replays the recorded outcome; a DISTINCT payload on a slot that
   already executed answers `idempotency-conflict`; a domain-REJECTED
   submission still records its slot with its payload digest, so a
   corrected retry answers `idempotency-conflict` on that instance (fresh
   instances — the normal serverless recycle — offer fresh slots). The
   push-based realtime transport extension point (below) is the designed
   home of the advancing-cursor discipline.

## Rollback

1. **Application:** Vercel instant rollback to the previous deployment (the
   host + gateway functions return to the prior release; the release
   identity in `/api/health` reflects it). Two operator surfaces, the exact
   procedure machine-verified against the live project: the dashboard's
   *Instant Rollback* (Deployments → the target deployment → the rollback
   action), or the alias-assignment API
   (`POST /v2/deployments/{deploymentId}/aliases` with the production alias
   `office-teal-zeta.vercel.app` — verified as a no-op re-assignment against
   the current deployment, HTTP 200). Today's rollback target:
   `dpl_Greqbz4Tyc3mgPz6agBQ2xFK4mF1` (READY). Environment variables are
   runtime-injected project state: an application rollback returns the
   prior CODE, not the prior environment — a rolled-back deployment still
   sees the current `DATABASE_URL` (honest: the host answers with its own
   code's behavior over the live canonical state).
2. **Database:** the restore procedure of `packages/operations/RUNBOOK.md`
   ("THE restore procedure") — the drill's steps as the operator runbook:
   the latest deterministic backup, re-migrated forward-only from the
   recorded high-water mark, verified by content comparison.
3. **The high-water-mark rule:** rollback NEVER rolls back the schema. An
   application rollback lands on a database whose schema is at or above the
   application's expectations (forward-only migrations + additive columns
   make older code safe on newer schema); a schema regression would violate
   the migration policy, not undo it.

## Extension points (future work items under the same governance)

- **Object storage** for document revisions and model artifacts (the
  documents domain's storage port is injectable; the seeded world uses an
  in-memory implementation).
- **Push-based realtime transport** (the A9 sync contracts are
  transport-agnostic; the first deployment's transport is request-scoped).
- **PG backing for the remaining domain surfaces** (schedule, field, cost,
  contracts, documents, workflows), landed surface by surface with the same
  repository + ledger + outbox discipline as organizations and projects.

## Observability

- **`/api/health`** (THE readiness endpoint): pool reachability, migration
  state (applied count + latest applied name), and the release identity —
  200 healthy, 503 when the database is unreachable.
- **Vercel build/deployment event logs** are readable through the
  deployments API (`/v1/deployments/{id}/events`) — verified against the
  live deployment (the full build log: region, route table, build
  durations, the stderr channel). Request-level runtime logs are the
  dashboard's Logs surface (the runtime-logs API requires the log-drain
  integration — recorded honestly: not configured today).
- **The landed failure-mode catalog** (`@office/operations`) remains the ops
  reference: the detection rules and documented operator actions
  (`database-unavailability`, `migration-failure-mid-batch`, adapter
  degradation, pool exhaustion) apply to this topology unchanged.
