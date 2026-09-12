# ADR-002: Same Project, Many Views

Status: Accepted / Frozen

## Decision

All clients and apps are projections/views over the same canonical project state. Office will support web first and reserve stable client contracts for future desktop, mobile, field, BIM/CAD, spreadsheet, scheduling, and specialist applications.

The project identity is a stable opaque Office project ID. Client-specific IDs live in adapter mappings. Every write enters the canonical command/event path regardless of client.

## Required behavior

A single mutation can propagate across views. Example:

1. BIM/CAD app changes wall thickness.
2. The model adapter submits a typed model-element mutation.
3. Canonical event `model.element.changed` is emitted.
4. Quantity service recalculates affected quantity facts.
5. BOQ projection updates.
6. Cost engine recomputes estimate/forecast impact.
7. Schedule impact service identifies affected activities and dependencies.
8. User-facing apps receive typed change notifications.

A scheduling app changing an activity must similarly affect program-of-work views, progress projections, resource dependencies, and risk analysis where relevant.

## Client contract layers

- Identity/session contract
- Project read model contract
- Command contract
- Event subscription contract
- File/model reference contract
- Offline sync contract
- Capability discovery contract
- App extension contract

All are versioned. Backward compatibility is required for supported app/client versions.

## Desktop readiness

Desktop apps must be able to use the same APIs/events as web clients. Desktop-specific functionality such as local file watching, native dialogs, GPU-intensive model rendering, and OS filesystem access belongs in a platform shell, not in the domain model.

The domain SDK must remain platform-neutral TypeScript where practical. A later native/Rust/.NET/other adapter is permitted behind the same protocol contracts.

## Offline readiness

A future field client may cache a project slice and enqueue commands. Every offline command has a deterministic client operation ID, expected version or causal token, and replay policy. Financial, contractual, access, and schedule-baseline conflicts are surfaced for review rather than silently overwritten.

## Consequences

The system is harder to build initially, but feature investments compound across clients. Adding a new app becomes an exercise in binding to contracts rather than building another database-backed product.
