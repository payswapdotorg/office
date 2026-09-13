# @office/web

The PaySwap Office **web application shell** (OFF-030): the primary web
client's APPLICATION SHELL as a typed, deterministic **view-model layer** —
project workspace composition, typed command surfaces, the control-tower
surface, and evidence navigation over the event ledger, operated end-to-end
over a seeded project with **zero direct database access**.

Pure TypeScript: **no UI framework, no DOM, no rendering** — the host wires
rendering later. Every surface is a pure projection over the landed Office
packages' public surfaces (the in-memory reference engines as the seeded
world): same seeded world + same operations → byte-identical view models,
run-twice.

## Purpose

Freeze A11 (`docs/architecture/ARCHITECTURE_FREEZE.md`): the web client is a
VIEW of ONE project state — never a second source of truth. This package is
that view's typed shell:

- **Workspace composition** — `projectWorkspace(world, session)` composes THE
  project workspace view model: header (project + organization), schedule
  summary (activities, baselines, the CPM forecast via the schedule package's
  public forecast), field status (the ledger-folded field read model), cost
  position (budgeted/committed/invoiced/paid/remaining + over-committed cost
  items), commitments (contracts + change events), documents, and approvals
  (live workflow instances). Deterministic, fail-closed: a typed rejection
  fails the whole load (a partial workspace is never silently served).
- **Command surfaces** — `captureFieldObservation`, `submitWorkflowApproval`,
  `approveWorkflowApproval`, `advanceWorkflowInstance`, and `recordCostItem`
  are typed bindings over the session's online data plane
  (`@office/client-sync`): the deterministic operation id IS the command's
  idempotency key, authorization holds on every submission (grant →
  capability → deny-by-default policy, A12 re-checked), and every outcome is
  a typed, displayable `CommandOutcomeView` — rejections are view models
  (`RejectionView`), **never throws**. Unconfirmed retries replay the
  recorded outcome (no second effect).
- **Control-tower surface** — `controlTowerView(world, session, parts)` is
  the view over `@office/intelligence-exceptions`' portfolio exception set:
  ledger → commercial facts fold (`@office/intelligence-margin`) →
  relationship index (`@office/intelligence-relationships`) → one impact
  assessment per visible change event → `detectExceptions` → `rankExceptions`
  (the ranking seed scale re-seeded in the portfolio's own currency —
  fail-closed, never FX invention) → suggested next actions displayed as
  **SUGGESTIONS ONLY** (typed command references the shell never executes).
- **Evidence navigation** — `evidenceOverview`, `aggregateHistory`,
  `evidenceEventOf`, `causalityChainOf`, `correlationChainOf`, and
  `evidenceCommandOf` are the ledger-event walkers over `@office/events`'
  vocabulary; `openEvidenceNavigation` / `pushEvidencePage` /
  `backEvidencePage` / `evidencePageView` are the typed, deterministic
  page/back navigation state **without a router**. The A3 causality chain
  walks any event BACKWARDS to the ORIGINATING COMMAND (the world's command
  journal); every push resolves its address fail-closed first — an unknown,
  malformed, or out-of-scope address is a typed navigation rejection, never
  an existence oracle.
- **Shell session** — ONE typed session record (`createWebSession`: tenant,
  project, actor, deny-by-default policy, closed capability set) that every
  surface resolves through. Cross-tenant and cross-project loads, walks,
  navigation pushes, and command submissions are typed-rejected **both
  directions** (freeze A12); a foreign session's control tower is EMPTY
  (invisible rows are absent).

## The view-model architecture

```
                    ONE typed WebSession (tenant + project + actor + policy)
                                      │
   ┌──────────────────────────────────┼───────────────────────────────────────┐
   │                                  │                                       │
projectWorkspace                controlTowerView                    evidence walkers
(header / schedule /            (facts fold → index →                (ledger streams,
 field / cost /                 assessments → detect →               A3 causality +
 commitments /                   rank → SUGGESTIONS)                  correlation chains)
 documents / approvals)                │                                    │
   │                                  │                                    │
   └──────────── THE SEEDED WORLD (in-memory reference engines + the ─────────┘
                  append-only ledger slice + the live subscription broker)

   command bindings ──► WebDataPlane (@office/client-sync online path)
                          │  deterministic operation id = idempotency key
                          ▼
                the LANDED domain command services
        (authorization, invariants, optimistic concurrency, audit events)
                          │
                          ▼
                the appended ledger event fans out on the live stream
                → every client's views re-derive from the SAME events
```

The shell **never** writes canonical state directly (commands flow through
the landed packages' public command surfaces), **never** constructs an
action gateway (the A8 seam `WebActionGateway` / `WebCommandProposal` is
`@office/actions` **TYPE-ONLY** — the host binds the real gateway over the
same proposal shape), and holds **no** second-source-of-truth caches (every
view model is rebuilt from the public read surfaces on every load).

## THE end-to-end acceptance (the named gate)

`src/golden-scenario.test.ts` — a SEEDED project (deterministic seed through
the domain packages' own command surfaces: organization → project → schedule
(3 activities + the serial critical path + baseline) → contract → budget →
2 cost items → commitment → document + revision → change event → approval
workflow definition + live instance) is operated END-TO-END through the
shell, every step through public package surfaces, in memory:

1. the workspace **loads** (the full view model over the seeded world);
2. a field observation is **recorded** through the command surface and
   reflected (the live stream fans the event out; the workspace re-derives);
3. the workflow approval is **submitted** and reflected (the approvals
   section shows the submitted step);
4. the cost position **re-projects** (a new cost item moves
   budgeted/remaining in the workspace view);
5. the control tower's exception impact **updates** (the same scan identity
   over the re-projected ledger: the cost-overrun exception's economic
   impact grows 50 000 → 150 000 minor, the priority score's economic term
   re-ranks, and the recorded item's ledger event joins the evidence chain);
6. evidence navigation **walks the full causality chain** from the
   control-tower item's evidence back to the ORIGINATING COMMAND — the
   ledger event the `recordCostItem` binding appended, its A3 causation id
   (the online operation id), and the world's command journal entry.

…plus run-twice identity (a second, independently seeded shell operated
identically yields byte-identical view models), the unconfirmed-retry replay
(exactly one ledger event), and typed rejections surfaced as displayable
view models (stale expected version, malformed ids, unbound transitions —
nothing executed).

`src/a12-scope.test.ts` proves the A12 scope gate both directions (workspace
loads, evidence walkers + navigation, command submissions typed-rejected;
empty foreign control tower; no existence oracle), and
`src/boundary.test.ts` is the structural self-gate below.

## The zero-database discipline (structurally database-free)

`src/boundary.test.ts` (mirroring the landed packages' self-gates) proves
structurally that the shell:

- imports **NO** `@office/persistence` — not even TYPE-ONLY — and no
  adapters*/app-sdk/app-runtime/marketplace/security package;
- consumes `@office/actions` **TYPE-ONLY** (the A8 gateway seam) and
  constructs no gateway anywhere;
- carries no SQL / direct-database vocabulary and uses no DOM/browser API;
- declares exactly its eighteen workspace dependencies, nothing external;
- uses injected clock/id suppliers only (no wall clock, no randomness in the
  modules; tests build fixed instants themselves);
- uses generic fixture vocabulary only (no provider vocabulary, no real
  vendor names).

The seeded world's in-memory reference engines (the domain packages' own
stores and registries, driven through their public command surfaces) are the
sanctioned fixtures — the brief's "in-memory reference engines as the seeded
world".

## What OFF-031 / OFF-032 / OFF-037 consume

The public surface is **only** `src/index.ts` (never deeper paths):

| consumer | what they take |
| --- | --- |
| **OFF-031** (field client) | the session/command/evidence patterns: `createWebSession`, the typed `CommandOutcomeView` surface (`rejections` as view models), `openWebDataPlane` (the online submission twin of the offline queue), and the A12 scope discipline (`sessionCoversScope`) |
| **OFF-032** (desktop shell) | the same view-model layer wholesale: `projectWorkspace`, `controlTowerView`, the evidence walkers + typed navigation state (page/back without a router), and the `WebActionGateway` TYPE-ONLY seam a host binds a real gateway over |
| **OFF-037** (integration) | the seeded world harness (`seedOfficeWorld` / `SeededWorld`), the shell session + data plane composition, and the deterministic golden scenario as the reference end-to-end operation of a seeded project with zero direct database access |

## How tests run

The root vitest config already spans `apps/*/src/**/*.test.ts`, and the root
`tsc --noEmit` spans `apps/**/*.ts` — `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and `pnpm test:architecture` at the repo root gate this package
with no per-app runner:

| file | what it proves |
| --- | --- |
| `src/golden-scenario.test.ts` | THE named end-to-end acceptance (4 tests) |
| `src/a12-scope.test.ts` | the A12 scope gate, both directions (6 tests) |
| `src/boundary.test.ts` | the structural database-free/UI-free self-gate (13 tests) |

Do not add UI frameworks, provider SDKs, network I/O, DOM usage, or any
direct database access to this package.
