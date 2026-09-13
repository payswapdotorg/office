# Successor handoff verification — the successor's map (OFF-040)

This directory is the machine-verified successor independence test of
`docs/execution/TECH_LEAD_HANDOFF.md`: a typed suite that proves, from
repository artifacts ALONE (zero conversation context), that the dependency
graph is verified, the ready queue is computable, ownership is unambiguous,
the setup instructions are reproducible, and every independence-test question
is answered by an existing artifact anchor.

- `artifacts.ts` — the fail-closed parsers, the ready-state algorithm, the
  completion replay, and the six verification-family checkers (pure functions
  over artifact text plus an injected filesystem oracle).
- `handoff.test.ts` — the real-artifact verifications (one describe per family).
- `mutation.test.ts` — the mutation probes: synthetic violating worlds fed
  through the same checkers, proving every rule fails closed naming the
  violation (a rule that cannot be shown to fail is not a gate).

## How this suite re-verifies the handoff

`pnpm test` sweeps this directory through the root vitest include glob
`tests/**/*.test.ts`; the focused run is `pnpm exec vitest run tests/handoff`.
The suite is deterministic (no clock, no randomness, sorted walks) and
fail-closed: a missing artifact, section, or unparseable line is a FAILURE
naming the file and the expectation — never a skip. The six families:

1. **The verified dependency graph** — WORK_ITEMS.md `Depends on` fields and
   DEPENDENCY_GRAPH.md's DAG summary encode the same acyclic 40-item graph
   (every summary edge is a declared dependency, same direction).
2. **The computable ready queue** — the algorithm below applied to the DONE set
   parsed from IMPLEMENTATION_STATUS.md; the recorded tracker must agree with
   the computed queue, and the queue is EMPTY exactly when the backlog is
   complete.
3. **The completion replay** — reverse document order of the completion
   entries is the completion order; every item was READY when it completed
   (zero dependency-order violations), the execution never stalled, and the
   ready frontier offered at least three simultaneous choices.
4. **Unambiguous ownership** — one Owner boundary per item, all boundaries
   distinct, every primary footprint claimed exactly once, every workspace
   manifest owned.
5. **Reproducible setup instructions** — the bootstrap below and the toolchain
   pins are wired identically across this map, package.json, and
   .github/workflows/ci.yml.
6. **The independence-test answers** — every question in the handoff
   document's "Successor independence test" list has an existing,
   non-vacuous artifact anchor (the map below), and the successor-facing
   status sections carry the terminal truth.

## The ready queue and how to compute it

The algorithm is the one `docs/execution/WORK_ITEMS.md` defines in its
"Ready-state algorithm" section (the authority; DEPENDENCY_GRAPH.md's summary
is a stage-level compression that must never contradict it):

> A work item is READY iff every item named in its `Depends on` field is DONE
> and its declared outputs are present and verified. There are no implicit
> readiness lanes and no unnamed governance tasks.

To compute it from artifacts alone:

1. Parse every `### OFF-XXX` block in `docs/execution/WORK_ITEMS.md` and read
   its exact `Depends on:` field (the edge authority).
2. Parse every `### OFF-XXX <title> — DONE (date)` heading in
   `docs/execution/IMPLEMENTATION_STATUS.md` (entries are newest-first) —
   that heading set is the DONE set.
3. An item is READY iff it is not DONE and every item named in its
   `Depends on:` field is in the DONE set (and its declared outputs are
   present — see the produced paths in the ownership table below).

One worked command (this suite recomputing the queue over the real artifacts):

```console
$ pnpm exec vitest run tests/handoff
```

The terminal state is asserted by family 2: all 40 items DONE ⇒ the ready
queue is EMPTY and the backlog is complete.

## Where the completion evidence lives

`docs/execution/IMPLEMENTATION_STATUS.md` — its "Completed work items"
section lists one entry per DONE item, newest-first, each carrying a
`- Merge:` line with the merge evidence (the PR number or commit sha of the
squash-merge onto `main`). Reverse document order of those entries is the
completion order the replay family re-verifies; the merge evidence is
corroborating proof the entry landed in git. Completion itself is defined by
`docs/execution/DEFINITION_OF_DONE.md` — never by code presence or a worker
report alone.

## The ownership table

One row per frozen work item: the owner boundary quoted verbatim from
WORK_ITEMS.md, and the primary footprint(s) its completion entry's Produced
line declares. The single shared-infrastructure exception:
`packages/test-fixtures` is owned by no single item — it is the shared test
fixture package created inside landed items' harness work and consumed across
boundaries; every other workspace manifest is claimed by exactly one item.

| Item | Owner boundary (verbatim) | Primary footprint |
| --- | --- | --- |
| OFF-001 | repository/tooling | `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `.github/workflows/ci.yml` |
| OFF-002 | `packages/contracts` | `packages/contracts` |
| OFF-003 | `packages/domain-kernel` | `packages/domain-kernel` |
| OFF-004 | `packages/persistence` | `packages/persistence` |
| OFF-005 | `packages/events` | `packages/events` |
| OFF-006 | `packages/authz` | `packages/authz` |
| OFF-007 | organization, person, company, project, location | `packages/domain/organization`, `packages/domain/projects` |
| OFF-008 | documents, revisions, evidence references | `packages/domain/documents` |
| OFF-009 | daily logs, field observations, issues, inspections | `packages/domain/field` |
| OFF-010 | schedule, activity, dependency, milestone, baseline | `packages/domain/schedule` |
| OFF-011 | budget, cost item, commitment, invoice, payment reference | `packages/domain/cost` |
| OFF-012 | contract, scope obligation, change event, change order, claim reference | `packages/domain/contracts` |
| OFF-013 | graph relationship/read projection | `packages/intelligence/relationships` |
| OFF-014 | commercial impact analysis | `packages/intelligence/margin` |
| OFF-015 | historical project learning | `packages/intelligence/memory` |
| OFF-016 | workflow state machine | `packages/workflows` |
| OFF-017 | typed command execution gateway | `packages/actions` |
| OFF-018 | agent orchestration | `packages/agents` |
| OFF-019 | portfolio exception detection | `packages/intelligence/exceptions` |
| OFF-020 | provider-neutral integrations | `packages/adapters-sdk` |
| OFF-021 | construction/CDE adapter example | `packages/adapter-construction` |
| OFF-022 | BIM/model adapter contract | `packages/adapter-model` |
| OFF-023 | schedule adapter | `packages/adapter-schedule` |
| OFF-024 | accounting adapter | `packages/adapter-finance` |
| OFF-025 | `packages/app-sdk` | `packages/app-sdk`, `apps/sample-app` |
| OFF-026 | app execution isolation | `packages/app-runtime` |
| OFF-027 | marketplace | `packages/marketplace` |
| OFF-028 | client synchronization API | `packages/sync` |
| OFF-029 | client sync engine | `packages/client-sync` |
| OFF-030 | primary web client | `apps/web` |
| OFF-031 | field experience | `apps/field` |
| OFF-032 | future platform adapter | `apps/desktop` |
| OFF-033 | contractual revenue recovery | `packages/intelligence/revenue` |
| OFF-034 | vendor/procurement intelligence | `packages/intelligence/procurement` |
| OFF-035 | customer software portfolio analytics | `packages/intelligence/stack-analysis` |
| OFF-036 | cross-cutting controls | `packages/security` |
| OFF-037 | integration acceptance | `packages/reference-scenario` |
| OFF-038 | operations/reliability | `packages/operations` |
| OFF-039 | architecture governance | `tests/architecture` |
| OFF-040 | tech-lead bootstrap | `tests/handoff` |

## Reproducible setup (the bootstrap)

A fresh engineer brings the repository up from a clean checkout with exactly
these commands — the same four gates CI runs as required steps:

```console
$ git clone <this repository>
$ pnpm install
$ pnpm lint
$ pnpm typecheck
$ pnpm test
$ pnpm test:architecture
```

Toolchain pins: pnpm 12.4.1 (the `packageManager` field in package.json, also
read by CI's pnpm/action-setup step) and Node.js 22 (the `engines.node`
floor; CI sets up `node-version: 22`). CI installs with
`pnpm install --frozen-lockfile`, so the committed `pnpm-lock.yaml` is the
reproducible dependency truth — this suite adds no dependencies. The vitest
include globs cover `tests/**`, `packages/*`, the nested domain and
intelligence families, and `apps/*`, so new tests are never silently unrun;
the architecture conformance gate (OFF-039) runs as its own required,
never-continue-on-error CI step.

## The independence-test answers

Where the repository answers each question of the handoff document's
"Successor independence test" list (family 6 verifies each anchor exists and
carries the answering vocabulary):

| Question | Where the repository answers it |
--- | ---
| the product mission | `README.md` (Core Product Thesis) + `docs/architecture/ARCHITECTURE_FREEZE.md` (Mission) + `docs/execution/TECH_LEAD_HANDOFF.md` (Mission) — the mission vocabulary is machine-verified |
| canonical truth and bounded contexts | `docs/architecture/ARCHITECTURE_FREEZE.md` (Core bounded contexts, A2. Transactional authority) + `docs/architecture/ADR-001-canonical-construction-graph.md` (Decision) |
| coexistence strategy for specialist systems | `docs/architecture/ARCHITECTURE_FREEZE.md` (A5. Specialist system coexistence) + `docs/architecture/ADR-004-system-adapters.md` (Decision) |
| marketplace model | `docs/architecture/ADR-003-app-marketplace.md` (Decision) + `docs/architecture/ARCHITECTURE_FREEZE.md` (A7. Marketplace) |
| same-project/many-view contract | `docs/architecture/ADR-002-multi-view-project-model.md` (Decision) + `docs/architecture/ARCHITECTURE_FREEZE.md` (A6. Multi-view project state) |
| AI execution boundary | `docs/architecture/ADR-005-agent-execution-safety.md` (Decision) + `docs/architecture/ARCHITECTURE_FREEZE.md` (A8. AI execution boundary) |
| offline conflict policy | `docs/architecture/ARCHITECTURE_FREEZE.md` (A9. Offline-first field edge) + `docs/execution/TECH_LEAD_HANDOFF.md` (Non-negotiable architecture, item 9) — no silent last-write-wins |
| current READY queue | `docs/execution/IMPLEMENTATION_STATUS.md` (Current ready queue) + `docs/execution/WORK_ITEMS.md` (Ready-state algorithm) + `docs/execution/DEPENDENCY_GRAPH.md` (Readiness) — recomputed by this suite's ready-queue family |
| worker ownership rules | `docs/execution/WORK_ITEMS.md` (Worker operating rule, Work item format) + `AGENTS.md` (Worker protocol) + `docs/execution/TECH_LEAD_HANDOFF.md` (Worker dispatch contract) — one item = one owner-boundary = one branch/PR |
| completion evidence | `docs/execution/IMPLEMENTATION_STATUS.md` (Completed work items: every entry carries a Merge: PR number or commit sha) + `docs/execution/DEFINITION_OF_DONE.md` — the merge-evidence discipline |
| how to propose an architecture change | `docs/execution/TECH_LEAD_HANDOFF.md` (Architecture-change protocol) + `AGENTS.md` (Hard constraints) — an accepted ADR revision, never an inline feature edit |

## Extending the backlog (the frozen universe)

The suite's `EXPECTED_ITEM_IDS` is the terminal 40-item universe
(OFF-001 … OFF-040). Extension is additive governance, never history edits:
new work is proposed as NEW work items with their own ID, Owner boundary,
Depends on, Produces, and Acceptance — recorded in the execution docs and
executed under `AGENTS.md`, `docs/execution/DEFINITION_OF_DONE.md`, and the
OFF-039 conformance gate. Editing a landed item's history, boundary, or
completion evidence to manufacture readiness is exactly what this suite
exists to catch.
