# @office/operations

Office production readiness and operational runbook (**OFF-038**) — the
operability package: **THE deterministic restore drill** over the persistence
integration harness (the work item's named acceptance), the migrations-policy
verification, the typed deployment-topology artifact, and the failure-mode
catalog with tested automated detection rules and documented operator
actions. `src/index.ts` is the whole public surface; import only from the
package root (`@office/operations`). The operator-facing procedure docs live
inside this package: this README (the policy) and `RUNBOOK.md` (the incident
runbook) — the frozen root `docs/` tree is never touched.

## What is here

| Area | Exports |
| --- | --- |
| Topology | `OFFICE_DEPLOYMENT_TOPOLOGY`, `DeploymentTopology`, `TopologyComponent`, `AdapterDeployment`, `TopologyInvariant` |
| Drill | `runRestoreDrill`, `RestoreDrillReport`, `MigrationsPolicyReport`, `seedCanonicalRows`, `drillClock`, `RestoreDrillDeps`, `SeedStep`, `SeedSummary` |
| Backup | `createDatabaseBackup`, `DatabaseBackup`, `BackupTableDump`, `BACKUP_EXCLUDED_TABLES` |
| Restore | `restoreDatabaseBackup`, `RestoreOutcome`, `RestoreDatabaseBackupParts` |
| Comparison | `compareBackups`, `compareDatabaseContents`, `DatabaseComparison`, `TableComparison` |
| Catalog | `OFFICE_FAILURE_MODE_CATALOG`, `FailureModeRecord`, `FailureModeKind`, `OperationalSeverity`, `defineFailureMode`, `parseFailureModeRecord` (+ kind/severity/id parses and guards) |
| Detection | `evaluateFailureDetection`, `failureModeMatches`, `TenantObservability` (+ the observation surfaces), `OperationalAlert`, `operationalAlertIdOf`, `operationalAlertsInScope`, `healthyTenantObservability` |

Dependencies are exactly the eight landed workspace packages the brief names
(the four adapter families, `@office/contracts`, `@office/domain-kernel`,
`@office/persistence`, `@office/security`); `pg` and `embedded-postgres`
flow through `@office/persistence`'s harness and are never direct
dependencies here. No network I/O beyond the local embedded/scratch
database; no cloud, vendor, or provider names anywhere (verified by
`src/boundary.test.ts`).

## The migrations policy

Schema changes land exclusively through `@office/persistence`'s migrator,
under three rules the drill verifies on a real database:

1. **Forward-only** — migrations apply in ascending version order and are
   never rolled back; a pending file below the recorded high-water mark is
   rejected.
2. **Ordered** — `<NNNN>_<snake_name>.sql` files under `migrations/`, applied
   in ascending version order, each inside its own transaction that also
   records the run in the `schema_migrations` ledger.
3. **Append-new-never-edit** — every run verifies the sha256 checksum of
   every applied file; editing an applied file (or naming a file that does
   not match the grammar) fails closed.

The drill proves the policy end-to-end: from an empty scratch database every
file applies **in order**; an immediate re-run applies **nothing** and
verifies every checksum (the no-op proof); the restore target reapplies the
same immutable files from empty. `schema_migrations` is deliberately excluded
from the backup payload — the ledger is derived state the migrator rebuilds
deterministically, which is why the restored ledger matches by construction.

## THE restore drill (the named acceptance)

`runRestoreDrill()` composes one deterministic run over the persistence
integration harness (embedded local mode when `DATABASE_URL` is unset; the
CI service database otherwise):

```
(1) MIGRATE  the empty source scratch: every file applies, in order;
             migrate() again — a no-op that verifies every checksum
(2) SEED     canonical-shaped rows through the LANDED repositories
             (two tenants, three projects, one rename, one
             optimistic-concurrency update — non-trivial restored content)
(3) BACKUP   the deterministic SQL dump (backup.ts)
(4) DESTROY  the source scratch database (harness stop(): pool ends,
             database drops — the data is gone)
(5) RESTORE  into a FRESH scratch: migrate from empty (the schema
             authority) + execute the backup script in one transaction
(6) COMPARE  twice, on independent re-dumps of the restored side: same
             table set, same rows, same ordered content — byte-identical
             scripts, identical checksums
```

The backup is a hand-rolled deterministic dump (pg_dump is not available as
a library): the table set from `information_schema.tables`, columns in
ordinal order, rows read `ORDER BY` the primary key, every row rendered as
one INSERT with inlined literals — one `BEGIN ... COMMIT` script whose sha256
checksum is the content identity. The dump order is restore-safe: a
deterministic topological order over the foreign-key graph (referenced
tables before dependents) — the drill itself caught the alphabetical order
violating `projects_tenant_id_fkey` on replay. No clocks, no randomness, no
environment reads: the same content always produces the byte-identical
script, so the comparison is a typed structural walk over two dumps.
`src/drill/restore-drill.test.ts` runs the drill **twice** and asserts the
two typed reports are byte-identical — the "deterministically repeatable"
acceptance, literally.

## The deployment topology

`OFFICE_DEPLOYMENT_TOPOLOGY` is pure typed data (no infrastructure code):
ONE canonical database (migrations + append-only event ledger + tenant-scoped
projections), one gateway (the single fail-closed API boundary), the ordered
event transport, the three clients (web/desktop/field), the canonical
projections, and the four adapter families anchored to the landed
`*_ADAPTER_KIND` / `*_SYSTEM_ID` vocabulary with their `adapter-health-check`
surfaces. Six typed invariants state the operating contract: single-database,
ledger-is-truth, tenant-isolation, forward-only-schema, gateway-only-ingress,
and restorable-by-drill.

## The failure-mode catalog + automated detection

`OFFICE_FAILURE_MODE_CATALOG` enumerates the critical failure modes as pure
typed records (the OFF-036 alert-rule precedent); `evaluateFailureDetection`
is the pure evaluation function that turns one tenant-scoped observability
view into typed `OperationalAlert`s. Each rule fires on its fixture input and
stays silent on the healthy input (`src/failures/detect.test.ts`).

| Failure mode | Severity | Detection rule (typed predicate) | Operator action (short) |
| --- | --- | --- | --- |
| `database-unavailability` | critical | unreachable, or ≥ 2 connection faults in the window | recover the database; runbook restore only if unrecoverable |
| `migration-failure-mid-batch` | critical | last run failed after applying ≥ 1 migration | fix the cause, re-run the migrator (resumes forward-only) |
| `adapter-provider-outage` | warning | any adapter health view not `healthy` (degrade/recover dial) | confirm the provider, drive recover; no database action |
| `ledger-append-failure` | critical | ≥ 1 ledger append fault | stop new commands (fail closed), fix, replay the append |
| `pool-exhaustion` | warning | pool at maximum AND clients waiting | clear blocking statements; raise the maximum only after ruling out leaks |

A12 both directions: evaluating tenant B's observability under tenant A's
scope is a typed `unauthorized` rejection, and `operationalAlertsInScope`
never returns a foreign tenant's alerts to a reading scope. The catalog
itself is the tenant-independent policy vocabulary; alerts and evaluations
carry the tenant scope.

## What OFF-039/OFF-040 consume

- **OFF-039 (architecture conformance gate)**: the topology's typed
  invariants (single-database, gateway-only-ingress, tenant-isolation,
  forward-only-schema) as the policy statements its automated checks enforce,
  and this package's `boundary.test.ts` as the per-package deps/import
  discipline precedent.
- **OFF-040 (successor handoff verification)**: `RUNBOOK.md`'s restore
  procedure (the drill's steps as the operator runbook) and the reproducible
  verification entry point — `pnpm test` runs the drill itself.

## Verification

- `pnpm lint` / `pnpm typecheck` — clean at the repository root.
- `pnpm test` — the suite: THE restore drill (+ the migrations-policy
  verification over its report), the catalog/detection fixtures
  (fires/silent/determinism/A12), the topology invariants, the pure
  comparison cases, and the package boundary gate. The drill boots the
  embedded cluster (local mode); everything else is pure and fast.
