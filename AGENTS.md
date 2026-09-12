# Office Agent Operating Contract

This file is mandatory context for any AI agent working in this repository.

## Mission

Implement the Office construction enterprise/project operating system described by the frozen architecture under `docs/architecture/` and execution artifacts under `docs/execution/`.

## Mandatory reading order

1. `README.md`
2. `AGENTS.md`
3. `docs/architecture/ARCHITECTURE_FREEZE.md`
4. all ADRs under `docs/architecture/`
5. `docs/execution/WORK_ITEMS.md`
6. `docs/execution/DEPENDENCY_GRAPH.md`
7. `docs/execution/TECH_LEAD_HANDOFF.md`
8. `docs/execution/DEFINITION_OF_DONE.md`
9. the active work item's exact acceptance contract

## Hard constraints

- Never invent a competing architecture because an implementation feels easier.
- Never introduce a second project/schedule/BOQ/cost/model source of truth.
- Never import a provider SDK into canonical domain packages.
- Never let an AI agent or marketplace app perform direct database writes.
- Never bypass tenant/project authorization.
- Never silently resolve material synchronization conflicts with last-write-wins.
- Never change a frozen ADR inside a feature PR.
- Never expand a work item across another worker's ownership boundary without Tech Lead approval.

## Worker protocol

Each worker must:

1. identify its work-item ID;
2. read all direct prerequisites;
3. inspect actual code before changing it;
4. write failing/deterministic tests first for behavior changes;
5. implement the smallest conforming change;
6. run the work item's acceptance checks;
7. report files changed, tests run, and any contract ambiguity;
8. stop rather than invent a solution when a frozen boundary is insufficient.

## Tech Lead protocol

At most 3 workers may be active concurrently. The dependency graph is authoritative for readiness. Merge order follows dependencies. The Tech Lead is responsible for detecting architecture drift and for initiating an ADR revision when a frozen decision genuinely must change.

## Evidence rule

Do not claim an implementation is complete from code presence, compile success, or a worker report alone. Verify the behavior and architecture conformance directly.
