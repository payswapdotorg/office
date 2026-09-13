# RUNBOOK — @office/operations incident procedures (OFF-038)

Package-internal operator documentation. The frozen root `docs/` tree is
never touched; this file is the incident runbook the failure-mode catalog's
`operatorAction` texts reference. Companion reading: `README.md` (the
migrations policy, the drill, the topology, the catalog table).

## On any alert

1. Read the alert's `evidence` lines first — they name the surface and the
   observed values (which adapter, how many faults, what the pool reported).
2. Follow the failure mode's row in the catalog table (`README.md`) or the
   per-mode procedure below.
3. Record the incident with the alert id (`office-opr-v1-…`, derived
   deterministically from mode + tenant + evidence) in the operations log.

## Per-failure-mode operator actions

### `database-unavailability` (critical)

Detection: the database reachability probe failed, or ≥ 2 connection-class
driver faults clustered in the window.

1. Check the database process and the network path (the fault evidence
   carries the driver messages).
2. Do **not** restart the gateway — it is fail-closed by design; it will
   recover when the database does.
3. Confirm the database reachable again, then confirm the gateway health
   reports it before reopening client writes.
4. Only if the database cannot be recovered in place: run THE restore
   procedure below.

Escalation: not reachable again within the recovery window → page the
on-call operator and run the restore procedure against the latest
deterministic backup.

### `migration-failure-mid-batch` (critical)

Detection: the last migration run failed after applying at least one
migration in the same run (the batch is partially applied; each migration
is its own transaction, so the failed one rolled back completely).

1. Read the failed migration's error message.
2. Fix the cause (the migration file or the environment); **never** edit or
   reorder an already-applied file — the migrator verifies checksums and
   fails closed on edits.
3. Re-run the migrator: it resumes forward-only from the recorded
   high-water mark.
4. The database stays consistent throughout — the failed migration's
   transaction rolled back entirely.

Escalation: the migrator cannot advance after the fix → stop all
deployments, page the on-call operator, treat the database as frozen until
the batch completes.

### `adapter-provider-outage` (warning)

Detection: an adapter family's health surface reports `degraded` or
`unavailable` (the degrade/recover dial).

1. Confirm the provider system's status.
2. Once the provider is reachable, drive the adapter's **recover**
   transition.
3. Degraded adapters keep serving one-way ingress — no restore, no database
   action. Never restart the database for an adapter outage.
4. If syncs paused, resume them; cursors replay from the persisted
   positions.

Escalation: still degraded/unavailable past the provider recovery window →
escalate to the integration owner; consider pausing the affected sync
schedules.

### `ledger-append-failure` (critical)

Detection: at least one append to the event ledger faulted.

1. **Stop accepting new commands at the gateway** — fail closed; never drop
   events silently.
2. Check database health and disk capacity (append faults are usually
   downstream of those).
3. Resolve the cause, then replay the failed append from its command
   envelope — the ledger is append-only, so replay is always safe.

Escalation: appends keep failing after the cause is addressed → page the
on-call operator and verify ledger integrity against the deterministic
backup before resuming writes.

### `pool-exhaustion` (warning)

Detection: the connection pool is at its configured maximum AND clients are
waiting.

1. Identify long-running or leaked statements via the pool statistics.
2. Terminate the blocking statements (a transaction that cannot be salvaged
   is rolled back — no partial writes).
3. Raise the pool maximum **only after** a leak is ruled out.

Escalation: exhaustion recurs after the blocking statements are cleared →
escalate to the platform owner with the pool statistics and waiting counts.

## THE restore procedure (the drill's steps as the operator runbook)

The restore drill (`runRestoreDrill`, `src/drill/restore-drill.test.ts`) is
this procedure executed and verified automatically. Executed by hand:

1. **MIGRATE a fresh empty database** from the immutable migration files —
   the schema always comes from the migrator, never from the backup (the
   migrations policy: forward-only, ordered, append-new-never-edit).
2. **Execute the backup script** — the deterministic SQL dump
   (`createDatabaseBackup` output: one `BEGIN ... COMMIT` transaction of
   ordered INSERTs, referenced tables before dependents) — into the fresh
   target. `schema_migrations` is rebuilt by the migrator, not the script.
3. **VERIFY**: re-dump the restored database through the same backup
   function and compare (`compareBackups`): same table set, same rows, same
   ordered content — the checksums must match. Compare twice; both passes
   must be identical.
4. **CUTOVER** only after verification passes; the old database is dropped
   only when the restore is verified (the drill's destroy step models the
   cutover ordering: destroy AFTER the backup exists, restore + verify into
   the fresh target).

Backups are taken with `createDatabaseBackup` over the live pool; their
checksum is the content identity operators compare against.

## Escalation policy (summary)

- **critical** alerts (`database-unavailability`,
  `migration-failure-mid-batch`, `ledger-append-failure`): act immediately
  per the procedures above; page the on-call operator if the first operator
  action does not resolve the condition within the mode's recovery window.
- **warning** alerts (`adapter-provider-outage`, `pool-exhaustion`): act
  within the working window; escalate to the owning role (integration owner
  / platform owner) if the condition persists or recurs.
- Any incident that reaches the restore procedure is reported to the
  Tech Lead with the drill's typed report (backup checksum, comparison
  passes, migration legs) attached as evidence.
