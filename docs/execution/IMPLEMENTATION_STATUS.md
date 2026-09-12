# Office Implementation Status

Status: production implementation STARTED — Phase 0 COMPLETE (5/40 items done); Phase 1 in progress (OFF-005 + OFF-007 dispatched).

## Completed work items

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

- `OFF-005` Event ledger and transactional outbox (`packages/events`; depends OFF-003 ✅ + OFF-004 ✅) and `OFF-007` Enterprise/project identity model (`packages/domain/organization`, `packages/domain/projects`; depends OFF-004 ✅ + OFF-006 ✅) — both READY and dispatched in parallel through the replay worker channel. Worker cap 3 respected.

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
