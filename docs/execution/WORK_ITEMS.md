# Office Work Items

Status: FROZEN EXECUTION BACKLOG

## Worker operating rule

At most 3 implementation workers may be active concurrently. The Tech Lead selects only work items whose declared dependencies are merged and whose predecessor acceptance gates have passed.

A worker must not modify files owned by another active worker except through the declared contract path. A work item is atomic: exactly one immutable ID, one ownership boundary, one acceptance gate, and one implementation branch/PR.

## Work item format

- ID is immutable.
- One primary ownership boundary per item.
- Every item has an independently testable acceptance gate.
- Dependencies are contract dependencies, not convenience dependencies.
- A worker may consume only artifacts named in `Produces` of completed prerequisites.
- A work item must not be combined with another work-item ID in one branch/PR.

## Phase 0 — Governance and bootstrap

### OFF-001 Repository/toolchain bootstrap
Owner boundary: repository/tooling
Depends on: none
Produces: package workspace, TypeScript base config, lint/test scripts, CI skeleton, directory conventions, environment contract.
Acceptance: clean install; typecheck/lint/test commands execute; CI validates a trivial fixture.

### OFF-002 Canonical contract package
Owner boundary: `packages/contracts`
Depends on: OFF-001
Produces: versioned IDs, tenant/project scope types, command envelope, event envelope, pagination, error envelope, versioning rules.
Acceptance: contract package builds with no app/domain imports; serialization tests pass.

### OFF-003 Domain kernel and invariants
Owner boundary: `packages/domain-kernel`
Depends on: OFF-002
Produces: aggregate identity, domain error model, invariant helpers, idempotency primitives, transactional command interface.
Acceptance: deterministic unit tests for tenant isolation, optimistic concurrency, idempotency and invariant failures.

## Phase 1 — Persistence and event foundation

### OFF-004 Database foundation
Owner boundary: `packages/persistence`
Depends on: OFF-002, OFF-003
Produces: PostgreSQL schema conventions, migrations, tenant/project scoping, repositories, transaction boundary.
Acceptance: migration from empty database; repository tests prove scope isolation and transactional rollback.

### OFF-005 Event ledger and transactional outbox
Owner boundary: `packages/events`
Depends on: OFF-003, OFF-004
Produces: append-only event ledger, outbox, idempotent consumer cursor, causation/correlation fields.
Acceptance: mutation + event commit atomically; duplicate delivery is harmless; event ordering is deterministic within aggregate.

### OFF-006 Authorization and policy kernel
Owner boundary: `packages/authz`
Depends on: OFF-002, OFF-003
Produces: tenant/project/resource policy evaluator, role/capability primitives, service-to-service authorization context.
Acceptance: denied cross-tenant/project reads and writes are covered by regression tests.

## Phase 2 — Canonical project model

### OFF-007 Enterprise/project identity model
Owner boundary: organization, person, company, project, location
Depends on: OFF-004, OFF-006
Produces: canonical enterprise/project aggregates and commands.
Acceptance: create/update/archive lifecycle with authorization, audit events, deterministic IDs.

### OFF-008 Documents and evidence model
Owner boundary: documents, revisions, evidence references
Depends on: OFF-004, OFF-005, OFF-006, OFF-007
Produces: document/revision/evidence aggregates and object-storage abstraction.
Acceptance: revision/supersedes chain; evidence references are immutable and auditable.

### OFF-009 Work/field model
Owner boundary: daily logs, field observations, issues, inspections
Depends on: OFF-004, OFF-005, OFF-006, OFF-007
Produces: field event commands/events and project read model.
Acceptance: field event can be created offline-style with an idempotency key and later replayed.

### OFF-010 Schedule/program-of-work model
Owner boundary: schedule, activity, dependency, milestone, baseline
Depends on: OFF-004, OFF-005, OFF-006, OFF-007
Produces: canonical schedule contract independent of Primavera/provider semantics.
Acceptance: dependency validation, baseline protection, progress update events and forecast calculation tests.

### OFF-011 Cost/budget/commitment model
Owner boundary: budget, cost item, commitment, invoice, payment reference
Depends on: OFF-004, OFF-005, OFF-006, OFF-007
Produces: canonical commercial model and cost-impact interfaces.
Acceptance: tenant/project isolation, atomic balance updates, immutable commercial event history.

### OFF-012 Contracts/change model
Owner boundary: contract, scope obligation, change event, change order, claim reference
Depends on: OFF-004, OFF-005, OFF-006, OFF-007
Produces: contract/change command contracts and entitlement evidence links.
Acceptance: change event can be linked to scope/evidence/cost/schedule without copying those entities.

## Phase 3 — Cross-domain intelligence substrate

### OFF-013 Cross-domain relationship engine
Owner boundary: graph relationship/read projection
Depends on: OFF-005, OFF-008, OFF-009, OFF-010, OFF-011, OFF-012
Produces: canonical relationship index for affects/depends-on/evidenced-by/impacts/derives-from.
Acceptance: deterministic traversal tests for key construction causal chains.

### OFF-014 Margin and impact engine
Owner boundary: commercial impact analysis
Depends on: OFF-010, OFF-011, OFF-012, OFF-013
Produces: cost/schedule/entitlement/margin impact calculations with evidence references.
Acceptance: golden scenarios prove impact calculations and traceability to source events.

### OFF-015 Enterprise memory and benchmarking
Owner boundary: historical project learning
Depends on: OFF-007, OFF-010, OFF-011, OFF-013, OFF-014
Produces: reusable lessons, benchmark records, project similarity contracts, outcome capture.
Acceptance: completed project outcomes can be queried and used to produce deterministic benchmark facts; no opaque AI dependency in core storage.

## Phase 4 — Workflow and action execution

### OFF-016 Workflow/approval engine
Owner boundary: workflow state machine
Depends on: OFF-005, OFF-006, OFF-013
Produces: generic workflow definitions, tasks, approvals, escalation, retries.
Acceptance: deterministic state transitions; approval-required actions cannot bypass policy.

### OFF-017 Action gateway
Owner boundary: typed command execution gateway
Depends on: OFF-003, OFF-005, OFF-006, OFF-016
Produces: read/reversible/approval-required/prohibited action classification; idempotent execution.
Acceptance: direct unauthorized writes fail; duplicate action keys do not duplicate effects.

### OFF-018 Agent runtime
Owner boundary: agent orchestration
Depends on: OFF-013, OFF-014, OFF-015, OFF-016, OFF-017
Produces: evidence-grounded agent runs, tool registry, proposed commands, approval handoff, execution records.
Acceptance: an agent cannot mutate state except through OFF-017; every consequential recommendation carries evidence.

### OFF-019 Exception/control-tower engine
Owner boundary: portfolio exception detection
Depends on: OFF-013, OFF-014, OFF-015, OFF-016
Produces: actionable exceptions, severity, economic impact, suggested next actions.
Acceptance: seeded scenarios produce stable priority ordering and evidence chains.

## Phase 5 — Interoperability and app ecosystem

### OFF-020 Adapter SDK
Owner boundary: provider-neutral integrations
Depends on: OFF-002, OFF-005, OFF-006, OFF-007, OFF-010, OFF-011
Produces: adapter interfaces, source identity mapping, sync cursor, conflict record, webhook normalization.
Acceptance: a fake provider can round-trip objects through the adapter contract without importing core provider code.

### OFF-021 Procore-class construction adapter
Owner boundary: construction/CDE adapter example
Depends on: OFF-020, OFF-008, OFF-009, OFF-012
Produces: reference adapter implementing document/RFI/change/event mappings with no provider types in core.
Acceptance: contract-test fixture proves ingest, update, source mapping and replay behavior.

### OFF-022 Autodesk/Model adapter contract
Owner boundary: BIM/model adapter contract
Depends on: OFF-020, OFF-008, OFF-013
Produces: model/document/element reference contract and change event mapping.
Acceptance: fixture demonstrates model element mutation -> canonical event -> affected relationship notification.

### OFF-023 Primavera/schedule adapter contract
Owner boundary: schedule adapter
Depends on: OFF-020, OFF-010, OFF-013
Produces: schedule/activity/baseline mapping and conflict rules.
Acceptance: fixture demonstrates provider activity update -> canonical schedule event -> downstream impact notification.

### OFF-024 ERP/finance adapter contract
Owner boundary: accounting adapter
Depends on: OFF-020, OFF-011, OFF-014
Produces: financial reference mapping and reconciliation interfaces.
Acceptance: fixture proves source version mapping and non-duplicating financial synchronization.

### OFF-025 App SDK and manifest
Owner boundary: `packages/app-sdk`
Depends on: OFF-002, OFF-005, OFF-006, OFF-016, OFF-017, OFF-020
Produces: app manifest schema, capabilities, permissions, event subscriptions, command bindings, extension UI contract.
Acceptance: invalid permissions/dependencies are rejected; sample app can compile against SDK without core imports.

### OFF-026 App runtime/sandbox boundary
Owner boundary: app execution isolation
Depends on: OFF-006, OFF-017, OFF-025
Produces: tenant-scoped app identity, permission checks, app namespace, lifecycle hooks, suspend/revoke behavior.
Acceptance: app cannot access undeclared capability or another tenant; suspended app receives no commands/events.

### OFF-027 Marketplace catalog/lifecycle
Owner boundary: marketplace
Depends on: OFF-025, OFF-026
Produces: catalog, publisher, app release, installation, entitlement, update, rollback, uninstall metadata.
Acceptance: install/update/rollback/revoke are auditable and preserve canonical project state.

## Phase 6 — Cross-platform readiness

### OFF-028 Realtime subscription protocol
Owner boundary: client synchronization API
Depends on: OFF-005, OFF-006, OFF-013
Produces: versioned event/query subscription contract and project slice streams.
Acceptance: two clients observe the same mutation without divergent state.

### OFF-029 Offline sync protocol
Owner boundary: client sync engine
Depends on: OFF-002, OFF-005, OFF-006, OFF-028
Produces: deterministic operation IDs, local queue protocol, causal/version tokens, conflict records.
Acceptance: offline mutations replay once; protected conflicts require resolution.

### OFF-030 Web application shell
Owner boundary: primary web client
Depends on: OFF-007, OFF-008, OFF-009, OFF-010, OFF-011, OFF-012, OFF-016, OFF-018, OFF-019, OFF-028
Produces: project workspace, command surfaces, control tower, evidence navigation.
Acceptance: a seeded project can be operated end-to-end without direct database access.

### OFF-031 Field/offline web client
Owner boundary: field experience
Depends on: OFF-009, OFF-016, OFF-028, OFF-029
Produces: offline-capable field capture and sync UI.
Acceptance: capture on disconnected network, reconnect, synchronize, and show conflict state.

### OFF-032 Desktop client protocol/reference shell
Owner boundary: future platform adapter
Depends on: OFF-002, OFF-028, OFF-029, OFF-025
Produces: platform shell contract and reference desktop host that consumes the same project protocol.
Acceptance: desktop reference app reads/writes same seeded project using no platform-specific domain model.

## Phase 7 — Economic and enterprise hardening

### OFF-033 Revenue recovery engine
Owner boundary: contractual revenue recovery
Depends on: OFF-012, OFF-014, OFF-018, OFF-019
Produces: evidence-backed candidate change/claim detection.
Acceptance: golden cases identify candidate recoveries with complete evidence chain and no automatic contractual assertion without policy.

### OFF-034 Procurement optimization engine
Owner boundary: vendor/procurement intelligence
Depends on: OFF-011, OFF-014, OFF-015, OFF-018
Produces: price, delivery, vendor-performance and risk comparison contracts.
Acceptance: recommendation includes historical basis and projected economic impact.

### OFF-035 Software-stack replacement analysis
Owner boundary: customer software portfolio analytics
Depends on: OFF-020, OFF-025, OFF-027, OFF-015
Produces: workflow coverage and replacement-potential measurements by external system/app.
Acceptance: replacement score is derived from observed workflows/capabilities, not arbitrary manual scores.

### OFF-036 Security/audit hardening
Owner boundary: cross-cutting controls
Depends on: OFF-004, OFF-005, OFF-006, OFF-017, OFF-026, OFF-029
Produces: audit trails, security tests, access reviews, sensitive-action alerts, retention rules.
Acceptance: security test suite proves tenant isolation, authorization boundaries, audit completeness and revocation.

### OFF-037 End-to-end construction reference scenario
Owner boundary: integration acceptance
Depends on: OFF-021, OFF-022, OFF-023, OFF-024, OFF-030, OFF-033, OFF-034
Produces: deterministic reference scenario from model change -> quantity/cost -> schedule impact -> change evidence -> approval -> execution.
Acceptance: all linked projections agree on causal IDs and no duplicate canonical records appear.

## Phase 8 — Release readiness

### OFF-038 Production readiness and operational runbook
Owner boundary: operations/reliability
Depends on: OFF-036, OFF-037
Produces: deployment topology, migrations policy, backup/restore test, observability, incident/runbook docs.
Acceptance: restore drill passes; critical failure modes have documented operator action and automated detection.

### OFF-039 Architecture conformance gate
Owner boundary: architecture governance
Depends on: OFF-038 and all predecessor contracts
Produces: automated checks for forbidden imports, provider leakage, direct agent DB access, unscoped queries, and app permission drift.
Acceptance: conformance suite passes on main and is a required CI gate.

### OFF-040 Successor handoff verification
Owner boundary: tech-lead bootstrap
Depends on: OFF-039
Produces: verified dependency graph, ready queue, no ambiguous ownership, and reproducible setup instructions.
Acceptance: a fresh engineer can choose three ready work items from repo artifacts without conversation context.

## Ready-state algorithm

A work item is READY iff every item named in its `Depends on` field is DONE and its declared outputs are present and verified. There are no implicit readiness lanes and no unnamed governance tasks.

At repository bootstrap, only `OFF-001` is READY. After `OFF-001`, only `OFF-002` is READY. After `OFF-003`, `OFF-004` and `OFF-006` can become READY concurrently. The dependency graph remains authoritative at every later stage.

## Stop-the-line rules

A worker must stop and report to the Tech Lead if:

1. a required contract differs from the frozen ADRs;
2. another worker's ownership boundary must be crossed;
3. a provider-specific concept needs to enter the canonical model;
4. a new canonical source of truth is being introduced;
5. an AI action would bypass the Action Gateway;
6. a work item grows beyond its stated acceptance boundary.
