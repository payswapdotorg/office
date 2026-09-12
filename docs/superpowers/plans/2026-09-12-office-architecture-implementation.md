# Office Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the frozen Office construction enterprise/project operating system as a modular monolith with a canonical project graph, event ledger, cross-system adapters, marketplace apps, evidence-grounded agents, and future-proof web/field/desktop clients.

**Architecture:** PostgreSQL-backed canonical domain/application modules share typed contracts and an immutable transactional outbox. Procore/Autodesk/Primavera/ERP and future desktop/marketplace applications integrate through provider-neutral adapters and the App SDK; clients are views over the same project state.

**Tech Stack:** TypeScript, Next.js web application, PostgreSQL, Prisma or repository-equivalent SQL mapping selected during OFF-004 without violating relational ownership, object storage for files, typed event contracts, automated tests, CI architecture gates.

**Spec:** `docs/architecture/ARCHITECTURE_FREEZE.md`

## Global Constraints

- PostgreSQL is the transactional source of truth.
- Enterprise/project graphs are canonical domain models.
- Immutable domain events and transactional outbox are required for consequential mutations.
- Agents never write arbitrary database state.
- Provider-specific SDKs live only inside adapters.
- Apps are extensions/views and cannot create duplicate canonical project universes.
- Web/mobile/desktop/field clients share canonical project state.
- Offline conflicts affecting financial, contractual, access, or schedule-baseline state are never silently overwritten.
- Tenant isolation is mandatory on every persisted/read/write path.
- No microservice extraction without a demonstrated operational reason.

---

## File/ownership structure to establish

```text
apps/
  web/
packages/
  contracts/
  domain-kernel/
  persistence/
  events/
  authz/
  domain/
    organization/
    projects/
    documents/
    field/
    schedule/
    cost/
    contracts/
  workflows/
  actions/
  agents/
  intelligence/
  adapters-sdk/
  adapters-procore/
  adapters-autodesk/
  adapters-primavera/
  adapters-erp/
  app-sdk/
  app-runtime/
  marketplace/
  sync/
  client-sdk/
  test-fixtures/
docs/
```

Workers must keep source ownership within the relevant package and test directory. Shared contract edits require the contract work item owner or Tech Lead approval.

### Task 1: OFF-001 Repository/toolchain bootstrap

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `vitest.config.ts`
- Create: `eslint.config.*`
- Create: `.github/workflows/ci.yml`
- Create: `apps/web/package.json`
- Create: `apps/web/README.md`
- Create: `packages/test-fixtures/README.md`

**Interfaces:** Produces workspace scripts `lint`, `typecheck`, `test`, and `test:architecture` plus package boundary conventions.

- [ ] Write fixture tests proving package scripts run.
- [ ] Run clean install and all four commands.
- [ ] Add CI job that runs the same commands.
- [ ] Commit only bootstrap files.

### Task 2: OFF-002 Canonical contract package

**Files:**
- Create: `packages/contracts/src/identity.ts`
- Create: `packages/contracts/src/commands.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/version.ts`
- Test: `packages/contracts/src/*.test.ts`

**Interfaces:** `EntityId`, `TenantId`, `ProjectId`, `CommandEnvelope`, `DomainEventEnvelope`, `Causality`, `Page`, `ApiError`.

- [ ] Write serialization tests for every envelope.
- [ ] Verify unknown schema versions fail closed.
- [ ] Export only provider-neutral types.

### Task 3: OFF-003 Domain kernel

**Files:** `packages/domain-kernel/src/aggregate.ts`, `invariants.ts`, `idempotency.ts`, `result.ts`, tests.

**Interfaces:** `AggregateVersion`, `ConcurrencyToken`, `DomainError`, `CommandHandler`, `IdempotencyKey`.

- [ ] Add deterministic concurrency/idempotency tests.
- [ ] Implement transaction-independent domain primitives.
- [ ] Verify package imports only `@office/contracts`.

### Task 4: OFF-004 Persistence

**Files:** `packages/persistence/prisma/schema.prisma`, migrations, repositories, tests.

**Interfaces:** `TransactionRunner`, repository interfaces, tenant/project scoped query helpers.

- [ ] Create tenant/project metadata tables.
- [ ] Prove rollback and isolation with integration tests.
- [ ] Commit migration and repository tests together.

### Task 5: OFF-005 Events/outbox

**Files:** `packages/events/src/ledger.ts`, `outbox.ts`, `consumer.ts`, tests.

**Interfaces:** `appendEvent()`, `enqueueOutbox()`, `consumeIdempotently()`.

- [ ] Write atomic state+outbox integration test.
- [ ] Add duplicate event delivery regression.
- [ ] Add causation/correlation propagation tests.

### Task 6: OFF-006 Authorization

**Files:** `packages/authz/src/policy.ts`, `scope.ts`, tests.

**Interfaces:** `AuthorizationContext`, `authorize()`, `Capability`, `ResourceScope`.

- [ ] Write deny-by-default and cross-tenant tests.
- [ ] Ensure app/agent callers can carry scoped authorization context.

### Task 7: OFF-007 project identity

**Files:** `packages/domain/projects/*`, `packages/domain/organization/*`, tests.

**Interfaces:** project/organization commands and events.

- [ ] Implement lifecycle tests.
- [ ] Emit canonical events through OFF-005.

### Task 8: OFF-008 documents/evidence

**Files:** `packages/domain/documents/*`, object-storage port, tests.

**Interfaces:** document/revision/evidence commands and read contracts.

- [ ] Test revision supersession.
- [ ] Test immutable evidence references.

### Task 9: OFF-009 field/work

**Files:** `packages/domain/field/*`, tests.

**Interfaces:** field event, daily log, issue, inspection contracts.

- [ ] Test idempotent field capture.
- [ ] Test authorization and project scope.

### Task 10: OFF-010 schedule

**Files:** `packages/domain/schedule/*`, tests.

**Interfaces:** activity/dependency/baseline/progress commands and reads.

- [ ] Test invalid dependency graphs.
- [ ] Test protected baseline mutations.
- [ ] Test forecast updates.

### Task 11: OFF-011 cost

**Files:** `packages/domain/cost/*`, tests.

**Interfaces:** budget/commitment/cost/invoice reference contracts.

- [ ] Test atomic commercial mutations.
- [ ] Test immutable commercial history.

### Task 12: OFF-012 contracts/change

**Files:** `packages/domain/contracts/*`, tests.

**Interfaces:** scope obligation/change event/change order/claim evidence contracts.

- [ ] Test evidence and scope relationships without duplicate canonical entities.

### Task 13: OFF-013 relationship engine

**Files:** `packages/intelligence/relationships/*`, tests.

**Interfaces:** `Relationship`, `TraversalQuery`, causal-chain query methods.

- [ ] Build deterministic traversal fixtures.
- [ ] Prove authorization filters at traversal time.

### Task 14: OFF-014 margin engine

**Files:** `packages/intelligence/margin/*`, tests.

**Interfaces:** `ImpactAssessment`, `calculateImpact()`.

- [ ] Add golden construction scenarios for schedule/cost/entitlement impact.
- [ ] Require source event IDs in every assessment.

### Task 15: OFF-015 enterprise memory

**Files:** `packages/intelligence/memory/*`, tests.

**Interfaces:** `OutcomeRecord`, `Benchmark`, `Lesson`, similarity query.

- [ ] Store deterministic outcome facts.
- [ ] Test that projections do not become canonical truth.

### Task 16: OFF-016 workflow

**Files:** `packages/workflows/*`, tests.

**Interfaces:** workflow definition/state/task/approval contracts.

- [ ] Test deterministic transition table.
- [ ] Test retries and escalation.

### Task 17: OFF-017 action gateway

**Files:** `packages/actions/*`, tests.

**Interfaces:** `ActionDescriptor`, `executeAction()`, approval requirement classification.

- [ ] Prove agents/apps cannot bypass authorization.
- [ ] Prove idempotent duplicate command behavior.

### Task 18: OFF-018 agents

**Files:** `packages/agents/*`, tests.

**Interfaces:** `AgentRun`, `EvidenceSet`, `Tool`, `ProposedAction`.

- [ ] Build a deterministic mock model/tool harness.
- [ ] Require evidence for consequential recommendations.
- [ ] Prove no direct persistence imports.

### Task 19: OFF-019 control tower

**Files:** `packages/intelligence/exceptions/*`, tests.

**Interfaces:** `Exception`, severity, impact, next-action contract.

- [ ] Build deterministic seeded prioritization.

### Task 20: OFF-020 adapter SDK

**Files:** `packages/adapters-sdk/*`, tests.

**Interfaces:** `Adapter`, `SourceRef`, `SyncCursor`, `Conflict`, `ProviderSnapshot`.

- [ ] Build fake provider fixture.
- [ ] Test ingest/update/replay.

### Task 21: OFF-021/022/023/024 provider adapters

**Files:** one package per provider family under `packages/adapters-*`.

- [ ] Implement only declared adapter contracts.
- [ ] Keep all provider-specific types inside adapter package.
- [ ] Run adapter contract suite against fixtures.

### Task 22: OFF-025 app SDK

**Files:** `packages/app-sdk/*`, manifest schema, tests.

**Interfaces:** `AppManifest`, `Capability`, `Permission`, `CommandBinding`, `EventSubscription`, `UiExtension`.

- [ ] Test malformed manifests.
- [ ] Test permission/dependency declaration validation.
- [ ] Compile a minimal sample app against SDK only.

### Task 23: OFF-026 app runtime

**Files:** `packages/app-runtime/*`, tests.

**Interfaces:** tenant-scoped app identity, capability gateway, lifecycle hooks.

- [ ] Test tenant isolation and revocation.

### Task 24: OFF-027 marketplace

**Files:** `packages/marketplace/*`, tests.

**Interfaces:** publisher, release, installation, entitlement, update, rollback, uninstall.

- [ ] Test lifecycle and permission delta review.

### Task 25: OFF-028/029 sync

**Files:** `packages/sync/*`, `packages/client-sdk/*`, tests.

**Interfaces:** subscriptions, project slices, deterministic operation IDs, conflict records.

- [ ] Test two-client convergence.
- [ ] Test protected conflict handling.

### Task 26: OFF-030/031 web and field clients

**Files:** `apps/web/*`, field workspace modules, tests.

- [ ] Implement project workspace and control tower from canonical APIs.
- [ ] Implement offline field capture and synchronization.

### Task 27: OFF-032 desktop protocol/reference shell

**Files:** reference shell package/app and protocol tests.

- [ ] Consume the same client contracts as web.
- [ ] Prove no platform-specific domain model exists.

### Task 28: OFF-033/034 revenue recovery + procurement optimization

**Files:** `packages/intelligence/revenue/*`, `packages/intelligence/procurement/*`, tests.

- [ ] Add evidence-backed opportunity fixtures.
- [ ] Include historical basis and economic impact in recommendations.

### Task 29: OFF-035 replacement analysis

**Files:** `packages/intelligence/stack-analysis/*`, tests.

- [ ] Derive system coverage from observed workflows/capabilities.
- [ ] Never hard-code arbitrary replacement percentages.

### Task 30: OFF-036/037/038/039/040 release gates

**Files:** conformance tests, E2E fixtures, runbooks, architecture checks.

- [ ] Run tenant/security/audit tests.
- [ ] Run model-change -> BOQ -> schedule -> change-event scenario.
- [ ] Run restore drill.
- [ ] Run forbidden-import/provider-leakage/direct-agent-write checks.
- [ ] Verify a fresh Tech Lead can select three ready tasks using repo artifacts alone.

---

## Execution policy

The Tech Lead should keep the active set to at most three items and prefer one item from each independent bounded context. Do not start an item early merely because its code can be stubbed; readiness means its predecessor contract is complete and tested.
