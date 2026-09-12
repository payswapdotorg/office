# ADR-001: Canonical Construction Enterprise + Project Graph

Status: Accepted / Frozen

## Context

Construction firms use many specialized systems. The product must preserve one coherent project across design, BIM, quantities, BOQ, schedule, procurement, field work, cost, contracts, quality, safety, and closeout. A screen-oriented architecture would duplicate entities and make cross-app synchronization fragile.

## Decision

Use a canonical Construction Enterprise Graph backed by PostgreSQL relationships plus immutable domain events. A Project Graph is a bounded project-scoped view over the enterprise graph.

Core nodes include:

- Tenant, Organization, Person, Company, Team, Role
- Project, Location, Phase, Work Package
- Contract, Commitment, Budget, Cost Item, Invoice, Payment
- Model, Model Element, Drawing, Document, Revision, Evidence
- Schedule, Activity, Milestone, Dependency, Baseline
- Quantity, BOQ Line, Resource, Procurement Package, Vendor
- RFI, Submittal, Issue, Inspection, Safety Event, Daily Log
- Change Event, Change Order, Claim, Approval
- Workflow, Task, Notification
- Agent Run, Recommendation, Action, Approval Request
- App, App Installation, Capability, Permission, Subscription/Entitlement

Relationships are first-class where they carry business meaning: affects, derives-from, depends-on, located-at, evidenced-by, supersedes, committed-to, impacts, generated-by, approved-by, performed-by, and reconciled-with.

## Consequences

Positive:

- A mutation in one app can drive derived updates everywhere.
- Firm memory can learn from completed projects.
- Margin and risk can be modeled as causal relationships rather than dashboards.
- Marketplace apps share canonical state instead of becoming isolated SaaS islands.

Costs:

- Domain modeling must be disciplined.
- Referential and authorization complexity are higher than CRUD screens.
- External data reconciliation becomes an explicit product concern.

## Invariants

1. Provider IDs are references, never canonical primary keys.
2. A domain concept has one canonical owner module.
3. Derived projections may be rebuilt from canonical state/events.
4. Every cross-domain relationship has an explicit contract and authorization rule.
5. No app may introduce a competing canonical representation of an existing core entity.
