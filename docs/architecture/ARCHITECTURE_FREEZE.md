# Office Architecture Freeze

Status: FROZEN FOR IMPLEMENTATION
Version: 1.0
Scope: canonical architecture for the PaySwap Office construction operating system

## Mission

Office is an AI-native construction enterprise and project operating system. It unifies enterprise memory, project state, cost/schedule/work/contract relationships, evidence, workflows, agents, integrations, and extensible apps around a canonical construction graph.

Office must be useful whether the customer keeps Procore, Autodesk, Primavera, ERP, spreadsheets, email, and field tools, or gradually replaces parts of that stack. The platform therefore owns the canonical semantic model and workflow/execution layer while adapters translate external authorities into it.

## Frozen Architectural Decisions

### A1. Canonical domain model

The canonical state is a Construction Enterprise Graph containing tenant, organization, project, people, companies, contracts, scope, locations, models, documents, schedule, cost, procurement, work, quality, safety, communications, evidence, workflows, apps, and outcomes.

A project graph is a bounded projection of the enterprise graph. Project entities are never duplicated merely because a user interface or app needs a different view.

### A2. Transactional authority

PostgreSQL is the transactional source of truth for canonical Office state. JSON/document fields may be used for extension metadata and provider payloads, but core entities retain typed columns and relational integrity.

Object/file storage is separate from PostgreSQL. Search indexes, analytics stores, vector indexes, caches, and derived graphs are replaceable projections and never the canonical write authority.

### A3. Event history

Every consequential domain mutation emits an immutable domain event with tenant/project scope, actor, source, correlation ID, causation ID, schema version, occurred-at time, and before/after references where applicable.

At-least-once delivery is assumed. Consumers must be idempotent.

### A4. Evidence and provenance

Every consequential machine-generated claim, recommendation, or action proposal must carry evidence references, source identity, timestamps, confidence, policy context, and execution state. AI output without provenance is not considered project truth.

### A5. Specialist system coexistence

External systems are integrated through adapters. During migration they can remain system-of-record authorities for their specialty: e.g. scheduling, BIM/modeling, construction workflow, or accounting. Office maps them to canonical contracts and must never hard-code provider-specific semantics into core domain entities.

### A6. Multi-view project state

Web, mobile, field, desktop, BIM/CAD, spreadsheet, scheduling, reporting, and future platform clients are views/extensions over the same project graph. A wall-size change made in one authorized app must publish a domain event and produce derived updates visible in the other apps.

### A7. Marketplace

Third-party and first-party apps are extensions, not separate project silos. Apps declare capabilities, permissions, events, commands, UI surfaces, data dependencies, compatibility, versions, and lifecycle hooks. Installation creates a tenant-scoped app installation. Apps can be suspended or revoked without deleting canonical project state.

### A8. AI execution boundary

Agents never write arbitrary database state. They call typed domain commands and workflows through a policy-enforcing action gateway. Actions are classified as read, reversible write, approval-required write, or prohibited. High-impact financial, contractual, schedule-baseline, access, and destructive actions require explicit approval unless an organization policy grants automation.

### A9. Offline-first field edge

Field clients keep a bounded local event queue and relevant project cache. Offline operations are captured as commands/events with deterministic IDs and later synchronized. Conflict resolution is domain-specific and cannot silently last-write-wins for financial, contractual, or schedule-critical data.

### A10. Modular monolith first

Start as a modular monolith with strong domain boundaries and an internal event bus/outbox. Extract services only when independently scalable operational requirements are demonstrated. No microservice split is allowed merely for organizational aesthetics.

### A11. API-first extensibility

Every stable domain capability exposed to first-party UI must be exposed through typed application contracts that can later be consumed by desktop clients and marketplace apps. Internal module boundaries are treated as public contracts once referenced by an app or external adapter.

### A12. Tenant isolation

Every persisted entity and every read/write path is tenant-scoped. Project access is a second authorization boundary. Cross-tenant access is prohibited unless mediated by an explicit platform-level control plane capability.

## Core bounded contexts

1. Identity & Tenancy
2. Organization & People
3. Projects & Locations
4. Documents & Evidence
5. BIM/Model References
6. Work & Field Operations
7. Schedule & Program of Work
8. Cost, Budget & Commitments
9. Procurement & Vendors
10. Contracts & Change Events
11. Quality & Safety
12. Workflow & Approvals
13. Enterprise Memory & Benchmarking
14. Intelligence & Margin Analysis
15. Agent Runtime & Action Gateway
16. Integrations & Adapters
17. Marketplace & App Lifecycle
18. Notifications & Collaboration
19. Offline Sync & Client State
20. Audit & Compliance

## Dependency rule

Core domain modules may depend only inward on shared kernel contracts and directly declared domain interfaces. UI, AI, adapters, marketplace apps, analytics, and provider-specific code must depend on application/domain contracts, never on another provider-specific implementation.

## Canonical flows

### Cross-view mutation

1. Client invokes a typed command.
2. Authorization and policy checks run.
3. Domain service validates invariant.
4. Transaction persists state and an outbox event atomically.
5. Event consumers update projections/search/notifications/integration queues.
6. Other clients observe the canonical state through APIs/subscriptions/sync.

### External adapter ingestion

1. Adapter fetches provider data.
2. Provider payload is stored with provider identity and version.
3. Adapter maps it to canonical command(s)/events.
4. Reconciliation records source mapping and conflict status.
5. Canonical graph is updated transactionally.
6. Derived projections and subscribed apps react to canonical events.

### Agent action

1. Agent retrieves authorized evidence and context.
2. Agent proposes a typed command.
3. Action gateway checks permissions, policy, confidence/evidence requirements, and idempotency.
4. If approval is required, an approval task is created.
5. Approved command executes transactionally.
6. Event ledger records execution and causal links.

## Frozen anti-patterns

- No feature-specific duplicate Project models.
- No app-private copy of canonical schedule/cost/BIM truth.
- No AI direct SQL writes.
- No provider-specific IDs as canonical primary keys.
- No unversioned external synchronization.
- No destructive automatic conflict resolution for material commercial state.
- No platform-specific databases as alternative source of truth.
- No giant generic "AI service" that bypasses domain commands.
- No marketplace app that silently expands permissions at runtime.
- No microservice extraction without a documented operational reason.

## Implementation sequence constraint

Build stable contracts before high-volume feature surfaces. The first implementation wave creates the domain/application contracts, database conventions, event/outbox foundation, authorization primitives, integration SDK, and app SDK. Feature modules then build independently over those contracts.
