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
- **Production URL / project id / deployment ids:** recorded at promote time
  by the Tech Lead (Stage 4/5 of the issue; this record deliberately does
  not invent them).
- **Environment classes** (all managed as Vercel environment variables,
  preview and production scoped):
  1. *public vars* — none required today (the host renders server-side; no
     client-side configuration is exposed).
  2. *server-only secrets* — none today; the A8 action gateway's approval
     routing is engine-internal.
  3. *adapter credentials* — none today (no adapter family is deployed).
  4. *database credentials* — `DATABASE_URL`, server-only, pointing at the
     managed PostgreSQL database. It is read by the host's route layer
     (never inside `@office/host-gateway`, never in any browser module).
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

## Rollback

1. **Application:** Vercel instant rollback to the previous deployment (the
   host + gateway functions return to the prior release; the release
   identity in `/api/health` reflects it).
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
- **Vercel runtime logs** for request-level diagnostics.
- **The landed failure-mode catalog** (`@office/operations`) remains the ops
  reference: the detection rules and documented operator actions
  (`database-unavailability`, `migration-failure-mid-batch`, adapter
  degradation, pool exhaustion) apply to this topology unchanged.
