# Office Successor Tech Lead Handoff

## Mission

Take this repository as the sole authoritative implementation context and lead delivery of the frozen Office architecture. Dispatch no more than three workers concurrently. Keep implementation aligned to the frozen ADRs and dependency graph.

## First-day procedure

1. Read `README.md` and every document under `docs/architecture/`.
2. Read `docs/execution/WORK_ITEMS.md`, `DEPENDENCY_GRAPH.md`, and `DEFINITION_OF_DONE.md`.
3. Inspect the actual repository tree and CI state; never infer implementation from these docs alone.
4. Confirm the current work-item status against git history and closed/open issues.
5. Select at most three ready work items from the graph.
6. Before dispatching, write each worker a narrow brief containing the work-item ID, exact acceptance criteria, allowed directories, dependencies, and forbidden changes.
7. Review each worker's diff against the frozen architecture before merging.
8. Update work-item status in the issue and execution artifacts only after tests and conformance checks pass.

## Worker dispatch template

```text
Work item: OFF-XXX
Goal: <one sentence copied from WORK_ITEMS.md>
Read first:
- <frozen ADRs>
- <dependency outputs>
Allowed ownership:
- <exact directories/files>
Consumes:
- <exact interfaces>
Produces:
- <exact interfaces/files>
Acceptance:
- <deterministic tests>
Forbidden:
- provider-specific concepts in core
- direct DB writes from agents/apps
- unrelated refactors
- changing frozen ADRs
Stop and report if:
- contract is insufficient
- dependency is missing
- another ownership boundary must be changed
```

## Architecture-change protocol

The worker must stop if the implementation appears to require changing a frozen decision. The Tech Lead writes a proposed ADR revision describing context, alternatives, decision, consequences, migration, and affected work items. No implementation continues against a changed contract until the revision is explicitly accepted and committed.

## Review protocol

Every merged item is checked for:

- tenant/project authorization
- canonical source-of-truth compliance
- event/outbox behavior where mutations occur
- idempotency
- provider leakage
- app permission isolation
- agent action gateway compliance
- deterministic tests for new invariants
- migration safety
- no hidden coupling to unapproved work items

## Branch/commit discipline

Preferred implementation workflow is one branch/PR per work item. Commits stay focused. Do not squash unrelated work items together merely to reduce PR count.

## Readiness signals

A work item is `READY` only when every dependency is merged and its declared interfaces exist. It is `IN_PROGRESS` only when a worker is actively implementing it. It is `BLOCKED` when a dependency or architectural question is unresolved. It is `DONE` only when its acceptance gate and required review pass.

## Completion rule

A feature is not considered implemented because code exists. It is complete only when the Definition of Done passes and the work item's contract is consumed without architecture drift.

## Successor independence test

A fresh Tech Lead with no conversation context must be able to answer from this repo alone:

- What is the mission?
- What is canonical truth?
- What are the bounded contexts?
- Which systems are adapters?
- How do apps extend the platform?
- How does a desktop client share the same project?
- What may agents do?
- Which three items are ready next?
- What constitutes completion?

If any answer requires hidden conversation history, the handoff is incomplete and the Tech Lead must repair the repository artifacts before feature work proceeds.
