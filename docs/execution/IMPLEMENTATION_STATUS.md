# Office Implementation Status

Status: production implementation STARTED — 14/40 items done (OFF-001..OFF-013 + OFF-020). Next wave READY: OFF-014 (margin engine) + OFF-016 (workflow engine) + OFF-028 (realtime subscription) — dispatched in parallel (highest downstream fan-in); provider adapters OFF-021/022/023 queued behind them.

## Completed work items

### OFF-020 Adapter SDK — DONE (2026-09-12)

- Merge: PR #23 squash-merged as `afb4d86` on `main`.
- Worker: local subagent (attempt 1 wrote all source; attempt 2 wrote all 13 test files + README and died at the gates phase; the Tech Lead finished: fixed 13 branded-literal test defects, ran the gates, committed, pushed).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1331/1331** (245 new in @office/adapters-sdk across 13 suites); architecture 5/5.
- Acceptance gates proven: fake-provider ROUND-TRIP (sync out with snapshots + cursor advance; webhook in with normalized envelope + SourceRef resolution; conflict detection explicit with both sides; replay idempotent no-op) WITHOUT importing any core provider code; deterministic mapping (same provider object → same canonical id; second object → existing canonical id = explicit conflict, never silent overwrite); cursor replay-safety (restart re-processes nothing checkpointed; foreign stream/tenant cursor typed-rejected); NO destructive auto-resolution (conflicts land in detected state; resolution is an explicit command with audit refs); A12 isolation on mapping records.
- Produced `@office/adapters-sdk`: the provider-neutral Adapter contract, SourceRef identity mapping (A10: provider ids never primary keys), SyncCursor, Conflict, ProviderSnapshot, webhook normalization (signature verifier port), the fake-provider fixture. For OFF-021/022/023/024 consumption.
- Review gates: ownership exact (packages/adapters-sdk/** + lockfile); ports only — NO I/O anywhere; no provider vocabulary (generic fake-crm/fake-pm kinds); no domain-package imports; secrets scan clean.

### OFF-013 Cross-domain relationship engine — DONE (2026-09-12)

- Merge: PR #22 squash-merged as `c990300` on `main`.
- Worker: local subagent (2 attempts; attempt 2 wrote the 31-test acceptance suite + README, fixed 6 inherited defects, wired root test discovery with the additive OFF-007-pattern widening for packages/intelligence/* — required for workspace linking).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1230/1230** (31 new in @office/intelligence-relationships); architecture 5/5.
- Acceptance gates proven: deterministic traversal for the key construction causal chains (golden fixtures: schedule dependency chain; change event evidencedBy revision + impacting cost/schedule; field-issue → change order → activity covered transitively with a documented envelope-gap note — no data invented); projection determinism + A7 rebuildability (same stream twice → identical index; rebuilt from scratch → identical index); authorization AT TRAVERSAL TIME (A12 both directions, no existence oracle, no leakage through the graph); per-edge provenance (producing event id) + causal-chain reconstruction through command causation; unknown event names skipped deterministically.
- Produced `@office/intelligence-relationships`: the affects/dependsOn/evidencedBy/impacts/derivesFrom index, TraversalQuery, causal-chain queries. For OFF-014/015/016/018/019 consumption.
- Review gates: ownership exact (packages/intelligence/relationships/** + lockfile + the two documented additive root-config widenings); consumes event SHAPES via @office/events/@office/contracts only — no domain-package imports; no provider vocabulary; secrets scan clean.

### OFF-012 Contracts/change model — DONE (2026-09-12)

- Merge: PR #21 squash-merged as `5970e9f` on `main` (supersedes #20, auto-closed by a premature head-branch deletion during the parallel-lockfile-conflict recovery — the branch was rebased onto post-OFF-011 main, lockfile regenerated, gates re-run green locally at 7009b43).
- Worker: local subagent (2 attempts; attempt 2 audited the inherited ~9.1K-line tree, fixed 4 inherited test defects + one 6-line source defect (parse.ts bracket-path convention `field[2]`), wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1074/1074** (113 new in @office/domain-contracts across 7 suites); architecture 5/5.
- Acceptance gates proven: change events link to scope/evidence/cost/schedule via TYPED EntityId/EntityRef links only — no copied entity data, no domain-to-domain imports; links immutable once recorded; change-order lifecycle submitted → approved/rejected → executed explicit/auditable/one-way (executing supersedes the originating change event's proposed state; rejected never mutate scope); contract lifecycle with one-way archive + deny-by-default authorization + A12 both directions; deterministic full-stream replay (identical states AND event streams); optimistic concurrency typed conflicts.
- Produced `@office/domain-contracts`: contract/scope-obligation/change-event/change-order/claim-reference model; the typed-link discipline for OFF-013/OFF-014 consumption.
- Review gates: ownership exact; no domain-to-domain imports; no provider vocabulary; secrets scan clean.

### OFF-011 Cost/budget/commitment model — DONE (2026-09-12)

- Merge: PR #19 squash-merged as `e8723de` on `main`.
- Worker: local subagent (2 attempts; attempt 2 fixed 6 inherited defect clusters incl. a semantic ledger-sink owning-root resolution bug (commitment events now stream under the commitment aggregate), wrote the 125-test acceptance suite + README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1086/1086** (125 new in @office/domain-cost across 7 suites); architecture 5/5.
- Acceptance gates proven: budget revisions immutable (prior revision byte-identical after supersession; balances computed from the current revision); atomic balance updates (optimistic concurrency typed conflicts, zero partial state on failing-sink abort); immutable commercial event history (full-stream replay → identical states AND event streams); A12 both directions; deny-by-default incl. the stronger projects.write revision gate; committed-vs-budget and invoiced-vs-committed balances as deterministic pure functions (computed, never stored-and-drifted).
- Produced `@office/domain-cost`: budget/cost-item/commitment/invoice/payment-reference model with cost-impact interfaces for OFF-014.
- Review gates: ownership exact; no domain-to-domain imports; no provider vocabulary; secrets scan clean.

### OFF-009 Work/field model — DONE (2026-09-12)

- Merge: PR #18 squash-merged as `744e88e` on `main`.
- Worker: local subagent (3 attempts; attempt 3 rebased the inherited ~10K-line uncommitted tree onto the merged 008/010 main, fixed 15 typecheck + 2 lint defects in inherited tests, wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **961/961** (160 new in @office/domain-field across 8 suites); architecture 5/5.
- Acceptance gates proven: offline-style capture with client-supplied idempotency key + client-observed timestamp (same-key replay = exactly-once, no duplicate aggregate/event; different payload same key = typed idempotency-conflict); deny-by-default authorization incl. cross-tenant/cross-project (A12); failing-sink atomicity; in-memory projection rebuilt from events answering per-project reads (projection≡aggregate-state equivalence).
- Produced `@office/domain-field`: field events, daily logs, issues, inspections; the offline-capture/replay contract; the read-model projection; EventSink port + ledger-backed adapter (@office/events appendEvent+enqueueOutbox, same transaction).
- Review gates: ownership exact (packages/domain/field/** + lockfile additive importer); @office/persistence imported for the port's SqlExecutor type only (same pattern as 007/008); no domain-to-domain imports; no provider vocabulary; secrets scan clean.

### OFF-010 Schedule/program-of-work model — DONE (2026-09-12)

- Merge: PR #17 squash-merged as `c6e77c5` on `main`.
- Worker: local subagent (2 attempts; attempt 2 audited the inherited ~4.7K-line source, fixed one latent parser defect test-first — absent-vs-explicit-null change fields no longer clear pinned dates/parent — and wrote the full 149-test acceptance suite).
- Acceptance evidence (station-verified fresh checkout): install 0; lint 0; typecheck 0; `pnpm test` **696/696** (149 new in @office/domain-schedule); architecture 5/5.
- Acceptance gates proven: dependency validation (cycle/self/missing/duplicate typed rejections); baseline protection (always-forbidden mutation guards, snapshots bit-identical under progress/edits, DISTINCT stronger baseline capability for re-baseline); progress updates as events; deterministic CPM forecast (run-twice + shuffled-inputs determinism; FS/SS/FF/SF + lag semantics); deterministic end-to-end replay → identical states AND event streams.
- Produced `@office/domain-schedule`: the canonical provider-independent schedule contract (activities, dependencies, milestones, baselines, progress, forecast + variance); EventSink port + ledger-backed adapter.
- Review gates: ownership exact; no domain-to-domain imports; NO provider vocabulary (fragment-assembled p6/ms-project asserted absent by the boundary test); secrets scan clean.

### OFF-008 Documents and evidence model — DONE (2026-09-12)

- Merge: PR #16 squash-merged as `2fc035e` on `main`.
- Worker: local subagent (2 attempts; attempt 2 finished the inherited ~5.6K-line tree: fixed 2 lint + 21 typecheck defects + 6 buggy tests, added the two missing acceptance proofs, wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **652/652** (105 new in @office/domain-documents); architecture 5/5.
- Acceptance gates proven: revision supersession chain (R1→R2→R3 explicit chain, full history readable, R1 byte-identical after supersession); revisions immutable (re-attach same revision id with different content → typed conflict + rollback); evidence references immutable + auditable (pin entity+document+revision; creation emits envelope with scope/actor/causation); ObjectStorage port content-addressed with in-memory implementation (A6: no provider adapter).
- Produced `@office/domain-documents`: document/revision/evidence aggregates; ObjectStorage port; EventSink port mirroring OFF-007's shape exactly. For OFF-012/013/016 consumption.
- Review gates: ownership exact (packages/domain/documents/** + lockfile new importer, workspace links only); @office/persistence for the port's SqlExecutor type only; no domain-to-domain imports; no @office/events import (port mirroring suffices at this layer); no provider vocabulary; secrets scan clean.

### OFF-007 Enterprise/project identity model — DONE (2026-09-12)

- Merge: PR #15 squash-merged as `cbc0346` on `main`.
- Worker: local subagent (2 attempts: attempt 1 completed the organization package, attempt 2 audited + fixed inherited defects and built the projects package). The chat.z.ai replay channel was down (backend outage: http-500 on chat GETs, capacity wall on creates) — the Tech Lead switched the item to a local worker rather than lose deadline time, and retired the replay session cleanly.
- Acceptance evidence (station-verified at a fresh checkout of off-007 @ 9e24d1c): pnpm install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **547/547** (141 new: 68 organization + 73 projects, incl. **48 real-PostgreSQL integration tests** on the embedded harness); architecture 5/5.
- CI evidence: both check-runs `success` on `9e24d1c` (push + pull_request).
- Acceptance gates proven: create/update/archive lifecycle WITH authorization (granted-with-capability vs typed denial regression tests incl. cross-tenant A12; denied commands never open a transaction); audit events through the EventSink port with scope/actor/source 'domain'/correlation+causation from the command envelope/before-after EntityRefs; deterministic canonical IDs (injected supplier sequence → same ids; parse via contracts); optimistic concurrency (stale version → typed conflict, state unchanged); repository integration tests prove tenant scope isolation for the new tables (no existence oracle).
- Produced `@office/domain-organization` + `@office/domain-projects` (packages/domain/*): the canonical enterprise/project identity aggregates, the established domain-package pattern (state/parse/events/commands/index + repositories), the minimal EventSink port (`appendEvents(executor, events): Promise<Result<true, DomainError>>` + in-memory/failing sinks) that OFF-005's ledger implements at app wiring time, migrations 0100_organizations.sql + 0101_projects_lifecycle.sql (pure additive ALTER on 0002's projects table; co-located under packages/domain/*/migrations per the OFF-005 convention).
- Review gates: ownership exact (packages/domain/** + lockfile + the two PRE-APPROVED additive root-config widenings: pnpm-workspace.yaml `packages/domain/*` glob + vitest include glob); no packages/events imports (dependency graph respected — 007 depends on 004+006 only); no new external dependencies; no provider vocabulary; secrets scan clean; frozen docs untouched; 0001/0002 + packages/persistence/src untouched.

### OFF-005 Event ledger and transactional outbox — DONE (2026-09-12)

- Merge: PR #14 squash-merged as `7a45cf7` on `main`.
- Acceptance evidence: lint 0; typecheck 0; `pnpm test` **406/406** (66 new in @office/events incl. **45 integration tests on real PostgreSQL**); architecture 5/5; clean tree (packages/events/** + lockfile only).
- CI evidence: both check-runs `success` on `9f16483` (push + pull_request, same four gates with postgres service).
- Acceptance gates proven: mutation + event + outbox commit atomically (a failure after the state write discards ALL three — no partial anything); duplicate delivery harmless (consumer-cursor no-op replay); deterministic dense strictly-monotonic per-aggregate sequences (race-safe under concurrent appends); causation/correlation propagation (command → event → chained events, chain roots null); outbox dispatch exactly-once-per-row under duplicate processing; ledger immutability enforced AT THE DATABASE LEVEL (UPDATE/DELETE rejected); tenant isolation with no existence oracle (A12).
- Produced `@office/events`: appendEvent (caller-supplied transaction — never opens its own), enqueueOutbox (same-transaction), consumeIdempotently (durable cursor), readEventById/readAggregateEvents/causedByCommand/causedByEvent, outbox fetch/mark/failure-retry lifecycle, migrations co-located at packages/events/migrations/ (0003 event ledger, 0004 outbox + cursors) composed via EVENTS_MIGRATIONS_DIR + the persistence migrator. For OFF-007+/OFF-013/OFF-016 consumption.
- Review gates: ownership exact (packages/events/** + pnpm-lock.yaml); no new external dependencies (3 workspace deps only: contracts/domain-kernel/persistence); no provider vocabulary; secrets scan clean. Worker session `off-005` (chat.z.ai agents tab, GLM-5.3/Full-Stack); verified independently by the Tech Lead at a fresh checkout.

### OFF-004 Database foundation — DONE (2026-09-12)

- Merge: PR #13 squash-merged as `b99baad` on `main`.
- Acceptance evidence: lint 0; typecheck 0; `pnpm test` **340/340** (69 in @office/persistence incl. **39 integration tests on real PostgreSQL 17.10**); architecture 5/5; clean tree.
- CI evidence: runs `34689969917` (push) + `34690069250` (pull_request) both `success` on `177d806`, with the postgres:17 service container + DATABASE_URL.
- Acceptance gates proven: migration from empty database (transactional, ordered, recorded); tenant scope isolation by construction (scopedSql binds tenant_id; project second boundary; cross-tenant rows unreachable — typed not-found/unauthorized); transactional rollback leaves no partial writes (cooperative tx.rollback(value) for typed DomainError failures).
- Produced `@office/persistence`: TransactionRunner/Transaction (the atomic mutation+outbox seam for OFF-005), SqlExecutor repository seam, scopedSql, migrator + forward-only SQL migrations (0001 tenants, 0002 projects), Tenants/Projects repositories with optimistic-concurrency WHERE-version guards, fail-closed row decoding, PersistenceFailure-only driver errors. Harness: embedded-postgres (local) / DATABASE_URL (CI) with scratch-DB isolation.
- Review gates: ownership exact (packages/persistence/** + lockfile + named root-file additions only: package.json devDeps + onlyBuiltDependencies, pnpm-workspace.yaml allowBuilds, ci.yml postgres service); no Prisma/ORM (boundary test asserts); no provider vocabulary; secrets scan clean.

### OFF-006 Authorization and policy kernel — DONE (2026-09-12)

- Merge: PR #12 squash-merged as `ad8aafc` on `main`.
- Acceptance evidence: lint 0; typecheck 0; `pnpm test` **271/271** (105 new in @office/authz); architecture 5/5; clean tree (16 package files + lockfile; ZERO new external deps).
- CI evidence: runs `34688707330` (push) + `34688888218` (pull_request) both `success` on `fe59625`.
- Acceptance gate proven: denied cross-tenant AND cross-project reads and writes under regression tests — **structural A12 isolation runs BEFORE any rule matching, so no policy can ever allow them**; deny-by-default (no-allow-rule), explicit-deny wins; denials carry the request scope only.
- Produced `@office/authz`: AuthorizationContext (uniform user/agent/app/adapter/system), ResourceScope, closed Capability vocabulary (fail-closed parsing), role→capability primitives, declarative Policy + pure authorize() evaluator with audit ruleIndex. Designed for OFF-017/OFF-026 consumption.

### OFF-003 Domain kernel and invariants — DONE (2026-09-12)

- Merge: PR #11 squash-merged as `4e9913c` on `main`.
- Acceptance evidence: clean `pnpm install` (incl. fresh-clone frozen-lockfile check); lint 0; typecheck 0; `pnpm test` **166/166** (75 new in domain-kernel); architecture 5/5; clean tree (19 package files + lockfile).
- CI evidence: runs `34686984934` (push) + `34687263462` (pull_request) both `success` on `9140d6a`.
- All four kernel invariants proven end-to-end: tenant isolation (A12 backstop), optimistic concurrency (typed conflict, never silent overwrite), idempotency (fingerprint registry, harmless replay vs typed conflict), invariant enforcement (state unchanged on violation).
- Produced `@office/domain-kernel`: AggregateVersion, ConcurrencyToken/checkConcurrency, Aggregate/checkScopeCovers, DomainError taxonomy + toApiError bridge, Invariant/checkInvariants, CommandFingerprint/IdempotencyRegistry/withIdempotency, CommandHandler with injected clock/id suppliers. Imports ONLY @office/contracts (boundary self-gate).

### OFF-002 Canonical contract package — DONE (2026-09-12)

- Merge: PR #10 squash-merged as `f7831b2` on `main`.
- Acceptance evidence: clean `pnpm install`; `pnpm lint` 0; `pnpm typecheck` 0; `pnpm test` **91/91** across 14 files; `pnpm test:architecture` 5/5; clean tree (26 package files + lockfile only).
- CI evidence: runs `34685707874` (push) + `34685807444` (pull_request) both `success` on `1938cfd`.
- Produced surface: `@office/contracts` — branded opaque IDs (EntityId/TenantId/ProjectId), Scope (A12), Actor, CommandEnvelope with mandatory idempotency key, DomainEventEnvelope per A3 (causality, before/after refs), Page, ApiError, fail-closed SchemaVersion. Boundary self-gate proves zero dependencies, no imports outside the package, no provider vocabulary.
- Review gates: ownership exact; frozen docs untouched; secrets scan clean. Worker session `off-002` (chat.z.ai agents tab); verified independently by the Tech Lead.

### OFF-001 Repository/toolchain bootstrap — DONE (2026-09-12)

- Merge: PR #9 squash-merged as `65a79e2` on `main`.
- Acceptance evidence: clean `pnpm install`; `pnpm lint` exit 0; `pnpm typecheck` exit 0; `pnpm test` 7/7 passed; `pnpm test:architecture` 5/5 passed; working tree clean (exactly the 19 declared files).
- CI evidence: GitHub Actions runs `34682400695` (push) and `34683445975` (pull_request) both completed `success` on `535f1cf` (Node 22 + pnpm 12.4.1, frozen lockfile, same four gates).
- Review gates: frozen `docs/` untouched; no runtime/provider dependencies (toolchain only); no secrets in tracked files; `apps/web` placeholder enforced by `tests/architecture/workspace.test.ts`.
- Worker session `off-001c` (chat.z.ai agents tab, GLM-5.3/Full-Stack); verification reproduced independently by the Tech Lead per the `AGENTS.md` evidence rule.

## Current ready queue

- `OFF-007` Enterprise/project identity model (`packages/domain/organization`, `packages/domain/projects`; depends OFF-004 ✅ + OFF-006 ✅) — in flight through the replay worker channel.
- NEXT WAVE (unblocked the moment OFF-007 merges; worker cap 3): `OFF-008` Documents/evidence model, `OFF-009` Work/field model, `OFF-010` Schedule/program-of-work model (all depend OFF-004 ✅ + OFF-005 ✅ + OFF-006 ✅ + OFF-007).

## After OFF-005 + OFF-007

- The Phase 2 domain wave opens: OFF-008/OFF-009/OFF-010/OFF-011/OFF-012 all depend on OFF-004+OFF-005+OFF-006+OFF-007 — dispatch up to three disjoint domain workers from that set (e.g. OFF-008 + OFF-009 + OFF-010) once both land. The dependency graph remains authoritative for readiness.

## Phase tracker issues

- Phase 0–1: #1
- Phase 2: #2
- Phase 3: #3
- Phase 4: #4
- Phase 5: #5
- Phase 6: #6
- Phase 7: #7
- Phase 8: #8

## State meanings

`READY` = all declared prerequisites merged and verified.
`IN_PROGRESS` = assigned to a worker.
`BLOCKED` = prerequisite/contract problem; no implementation guessing.
`DONE` = acceptance checks + architecture conformance + review passed.

## Authority

`docs/architecture/*` freezes architecture.
`docs/execution/WORK_ITEMS.md` defines atomic scope.
`docs/execution/DEPENDENCY_GRAPH.md` defines readiness.
`docs/execution/DEFINITION_OF_DONE.md` defines completion.
`docs/execution/TECH_LEAD_HANDOFF.md` defines orchestration.
