# PaySwap Office

AI-native Construction Enterprise & Project Operating System.

This repository is intentionally architecture-first. The canonical product is a construction operating system that sits above and across specialist construction systems, unifies the enterprise and project truth model, automates workflows, protects margin, learns from completed projects, and supports an extensible app marketplace plus future desktop/cross-platform views.

## Successor Tech Lead Entry Point

Start here, in order:

1. `docs/architecture/ARCHITECTURE_FREEZE.md`
2. `docs/architecture/ADR-001-canonical-construction-graph.md`
3. `docs/architecture/ADR-002-multi-view-project-model.md`
4. `docs/architecture/ADR-003-app-marketplace.md`
5. `docs/architecture/ADR-004-system-adapters.md`
6. `docs/architecture/ADR-005-agent-execution-safety.md`
7. `docs/execution/WORK_ITEMS.md`
8. `docs/execution/DEPENDENCY_GRAPH.md`
9. `docs/execution/TECH_LEAD_HANDOFF.md`
10. `docs/execution/DEFINITION_OF_DONE.md`

The repository is the source of truth for implementation. Do not rely on prior conversation context.

## Core Product Thesis

The product is not a Procore clone, BIM viewer, Primavera clone, or Excel clone. It is the **canonical construction project and enterprise operating layer** that lets those capabilities become different views and extensions of the same underlying project graph.

Examples:

- Change a wall size in a BIM/CAD app -> affected quantities update in the BOQ view -> cost impact is calculated -> affected schedule activities are identified.
- Update a program-of-work activity -> project forecast changes -> impacted procurement/work packages are surfaced.
- Capture a field event by voice/photo -> event enters the project graph -> relevant workflow, schedule, cost, quality, and contractual checks run.
- Install a marketplace scheduling app -> it uses canonical project/schedule contracts rather than creating a second disconnected project model.

## Non-negotiable Principles

- Postgres is the transactional system of record.
- The Construction Enterprise Graph and Project Graph are canonical domain models, not analytics-only overlays.
- Immutable domain events provide history and causal traceability.
- Every consequential AI claim must have evidence, provenance, confidence, and an explicit execution policy.
- Specialist systems are adapters/data authorities during transition; the platform must not hard-code dependence on Procore, Autodesk, Primavera, or any one provider.
- Apps are extensions/views over canonical project capabilities, not competing private databases.
- Marketplace apps must be permissioned, tenant-aware, versioned, installable, auditable, and revocable.
- Desktop/mobile/web are views into the same project state. No platform-specific source of truth.
- Offline field operation is a first-class capability.
- Work items must stay small enough for up to three workers to execute concurrently with explicit dependency contracts.

## Current State

This repository currently contains the architecture and execution artifacts needed to bootstrap implementation. Production code has not yet been scaffolded; the work graph is designed to create that code in safe, independently verifiable slices.
