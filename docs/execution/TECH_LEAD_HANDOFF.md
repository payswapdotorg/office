# Office Successor Tech Lead Handoff

Status: BACKLOG COMPLETE — all 40 work items DONE and verified (40/40); the ready queue is EMPTY; the machine-verified successor independence test lives at tests/handoff.

## Mission

Take this repository as the sole authoritative implementation context and lead delivery of the frozen Office construction enterprise/project operating system. The product is an AI-native construction operating layer built around one canonical enterprise/project graph, immutable evidence-bearing events, governed workflows/actions, provider-neutral adapters, an app marketplace, and same-project/many-view clients.

## Important reality check

The frozen 40-item backlog is complete: all 40 work items are DONE with station-verified acceptance evidence. The completion evidence lives in `docs/execution/IMPLEMENTATION_STATUS.md` — every recorded entry carries its merge PRs (the PR number and commit sha of the squash-merge onto `main`) — and every item satisfied `docs/execution/DEFINITION_OF_DONE.md` before merge. The station-verified gates (`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:architecture` — including the required OFF-039 conformance gate) exit 0 on `main`, and CI runs the same gates as required steps on every push and pull request. Do not describe features as implemented until the corresponding work item acceptance evidence exists in git and CI.

## Non-negotiable architecture

1. PostgreSQL owns canonical Office state.
2. Enterprise Graph and Project Graph are canonical domain models.
3. Domain mutations use immutable events and transactional outbox semantics.
4. AI recommendations/actions require evidence, provenance, policy and typed commands.
5. Agents and marketplace apps never perform arbitrary SQL writes.
6. Procore/Autodesk/Primavera/ERP are adapters and external authorities during coexistence; provider semantics never leak into canonical domain contracts.
7. Apps are extensions/views of the same project, not parallel project universes.
8. Web, field, desktop, BIM/CAD, spreadsheet and scheduling clients are views over the same project state.
9. Offline conflicts involving financial, contractual, access or schedule-baseline state are surfaced for resolution.
10. The first architecture is a modular monolith; service extraction needs an operational justification.

## Mandatory reading order

1. `README.md`
2. `AGENTS.md`
3. `docs/architecture/ARCHITECTURE_FREEZE.md`
4. every ADR under `docs/architecture/`
5. `docs/execution/WORK_ITEMS.md`
6. `docs/execution/DEPENDENCY_GRAPH.md`
7. `docs/execution/DEFINITION_OF_DONE.md`
8. the active work item's prerequisites and acceptance contract
9. actual source tree, git history, CI state, and tests

## First takeover procedure

1. Inspect the repository tree before making any implementation assumptions.
2. Confirm the current commit and branch state.
3. Confirm that no undocumented production code exists.
4. Check open/closed phase issues and reconcile them with git state.
5. Treat `WORK_ITEMS.md` as the atomic backlog and `DEPENDENCY_GRAPH.md` as readiness authority.
6. Calculate READY items from the dependency fields; do not use prose-created lanes.
7. At initial bootstrap, dispatch only `OFF-001`.
8. After `OFF-001`, dispatch `OFF-002`; after `OFF-003`, `OFF-004` and `OFF-006` can run in parallel.
9. Keep at most 3 implementation workers active.
10. Give each worker one OFF ID, one branch/PR, exact allowed ownership paths, direct prerequisite outputs, acceptance tests, and forbidden changes.
11. Review the actual diff and acceptance evidence before merge.
12. Update status only after verification passes.

## Worker dispatch contract

```text
Work item: OFF-XXX
Goal: <exact work-item goal>
Read first:
- frozen architecture
- direct prerequisite outputs
- active work-item acceptance
Allowed ownership:
- exact bounded-context/package paths
Consumes:
- exact predecessor interfaces
Produces:
- exact interfaces/files
Required tests:
- deterministic tests named by the work item
Forbidden:
- provider leakage into core
- direct AI/app SQL writes
- unscoped queries
- second canonical source of truth
- unrelated refactors
- changes to frozen ADRs
Stop and report when:
- a frozen contract is insufficient
- another ownership boundary must change
- the item needs to expand
```

## Three-worker scheduling rule

The maximum concurrency is three. This is a cap, not a target. Never create artificial work merely to fill three slots.

Prefer independent ownership boundaries. Example high-value parallelization after prerequisites are complete:

- `OFF-004` + `OFF-006`
- `OFF-008` + `OFF-009` + `OFF-010`
- `OFF-021` + `OFF-022` + `OFF-023`

Do not combine multiple OFF IDs into one worker assignment.

## Architecture-change protocol

If implementation appears to require changing a frozen decision:

1. Stop the affected worker.
2. Record the concrete mismatch and affected work items.
3. Draft an ADR revision containing context, alternatives, decision, consequences, migration and work-item impact.
4. Do not implement against the revised design until the ADR revision is explicitly accepted and committed.

## Mandatory review gates

Every merged work item must be checked for:

- tenant/project authorization;
- canonical source-of-truth compliance;
- event/outbox correctness for canonical mutations;
- idempotency/replay behavior;
- provider leakage;
- app permission isolation where applicable;
- Action Gateway enforcement for agent/app writes;
- deterministic tests for new invariants;
- migration safety;
- hidden coupling to unfinished work;
- no unexplained direct database access from UI, adapters, apps or agents.

## Definition of done

`docs/execution/DEFINITION_OF_DONE.md` is mandatory. Code presence, compilation, screenshots, or worker claims are not completion evidence by themselves.

## Git discipline

- One work item = one implementation branch/PR.
- Keep commits focused and reviewable.
- Never merge out of dependency order merely because a PR is ready.
- Avoid force-pushing shared worker branches.
- Do not rewrite frozen architecture in feature commits.

## Current authoritative status

- Backlog: COMPLETE — `OFF-001` through `OFF-040`, 40/40 DONE and verified; `docs/execution/IMPLEMENTATION_STATUS.md` is the completion authority and records the merge evidence per entry.
- Ready queue: the ready queue is EMPTY — computable from `docs/execution/DEPENDENCY_GRAPH.md` plus the exact dependency fields in `docs/execution/WORK_ITEMS.md`, and recomputed (with the completion replay) by the machine-verified handoff suite at `tests/handoff`.
- Architecture: frozen under `docs/architecture/`; conformance is enforced by the required OFF-039 CI gate.
- Extension entry point: propose NEW work items under the same governance — `AGENTS.md`, `docs/execution/DEFINITION_OF_DONE.md`, and the conformance gate — never by editing the frozen history of landed items.
- Phase trackers: GitHub issues #1 through #8.
- Dependency authority: `docs/execution/DEPENDENCY_GRAPH.md`.
- Completion authority: `docs/execution/DEFINITION_OF_DONE.md`.

## Successor independence test

A fresh Tech Lead with no conversation context must be able to determine from this repository alone:

- the product mission;
- canonical truth and bounded contexts;
- coexistence strategy for specialist systems;
- marketplace model;
- same-project/many-view contract;
- AI execution boundary;
- offline conflict policy;
- current READY queue;
- worker ownership rules;
- completion evidence;
- how to propose an architecture change.

If any answer requires hidden conversation context, repair the repository artifacts before feature implementation continues.
