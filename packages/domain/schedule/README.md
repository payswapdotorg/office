# @office/domain-schedule

The Office schedule and program-of-work domain module (OFF-010): the canonical,
**provider-independent** model of a construction project's program of work —
activities, typed dependencies, milestones, immutable baselines, an
append-only progress log, a deterministic critical-path forecast, and
current-vs-baseline variance. Pure domain: no SQL, no wall clock, no
randomness, no provider vocabulary — provider import (scheduling tools,
planning software) happens in adapter packages owned elsewhere, never here.

## Why this package exists

Freeze A1/A6 give every project ONE program of work: a single project-scoped
`Schedule` aggregate root owning the WHOLE activity network. Dependency-graph
validation (cycles, self-links, missing references, duplicates) and the CPM
forecast are whole-network questions; the root is the boundary that keeps
them transactional and pure. Activities, dependencies, milestones, baselines
and progress updates are entity models INSIDE the root (each with its own
canonical `EntityId` + `EntityKind`), so events, relationships (OFF-013) and
impact analysis (OFF-014) can reference them individually.

## Public surface

`src/index.ts` is the package's whole public surface — consume the package
only through its root entry point, never through deeper paths.

| Area | Exports |
| --- | --- |
| State | `ScheduleState`, `ActivityState`, `DependencyState`, `MilestoneState`, `BaselineState`, `BaselineSnapshot`, `ProgressUpdateState`, `DependencyLinkType`, `DEPENDENCY_LINK_TYPES`, the entity-kind constants, `SCHEDULE_INVARIANTS`, `NewSchedule`, `NewActivity`, `ActivityChanges`, `NewDependency`, `NewMilestone`, `NewBaseline`, `NewProgressUpdate`, and the pure transitions `createScheduleState`, `addActivityState`, `updateActivityState`, `addDependencyState`, `removeDependencyState`, `addMilestoneState`, `setBaselineState`, `recordProgressState`, `updateBaselineState`, `removeBaselineState` (the last two are the always-failing baseline-protection guards), plus the derived reads `latestProgressFor`, `latestProgressByActivity` |
| Events | `EventSink` (the port), `InMemoryEventSink`, `RecordedEventAppend`, `createInMemoryEventSink`, `failingEventSink`, `eventSinkFailure`, the 8 event-name constants, `scheduleEventEnvelope`, the ref builders (`scheduleRef`, `activityRef`, `dependencyRef`, `milestoneRef`, `baselineRef`, `progressUpdateRef`) and the payload types |
| Store | `ScheduleStore`, `ScheduleStoreTransaction`, `createInMemoryScheduleStore`, `InMemoryScheduleStore` |
| Forecast | `forecastSchedule` (the pure CPM function), `forecastOfSchedule`, `forecastOfBaseline`, `ForecastNetworkInput` (+ activity/dependency/progress/milestone inputs), `ScheduleForecast`, `ForecastActivity`, `ForecastMilestone` |
| Variance | `scheduleVariance`, `ScheduleVariance`, `ActivityVariance` |
| Commands | `ScheduleCommands`, `createScheduleCommands`, `ScheduleCommandDeps`, `ScheduleCommandAuthorization`, the 8 command-name constants, the payload types and their fail-closed parsers |
| Ledger sink | `createLedgerEventSink` (the thin OFF-005-backed EventSink adapter) |

Dependencies: exactly five workspace packages — `@office/contracts`,
`@office/domain-kernel`, `@office/authz`, `@office/events` (the ledger-backed
EventSink adapter only) and `@office/persistence` (the `SqlExecutor` type of
the mirrored EventSink port) — plus node builtins. No external dependencies;
no domain-to-domain imports (the EventSink port is shape-mirrored from the
identity modules, never imported from them).

## The canonical schedule contract

- **Activities** carry a unique code, display name, a calendar-free integer
  `plannedDuration` (working units — days at this layer), optional pinned
  `plannedStart`/`plannedFinish` instants of the current plan, and an optional
  `parentActivityId` (a WBS-ish forest within the project). Durations are
  deliberately calendar-free: working-time mapping, holidays and calendars are
  out of scope at this layer.
- **Dependencies** are typed links over the closed vocabulary `FS`, `SS`,
  `FF`, `SF` with a signed integer `lagDays`. The model is a directed graph;
  see "Dependency semantics" below.
- **Milestones** are zero-duration markers bound to an activity (or
  project-level). Achievement is ALWAYS a derived read over the progress log —
  never stored as truth.
- **Baselines** are immutable snapshots of the whole network, chained backward
  through `supersedes` like document revisions; the root carries
  `currentBaselineId`. Re-baselining appends a new snapshot and never touches
  the old one.
- **Progress updates** are an append-only log; an activity's CURRENT progress
  is the LATEST entry (derived read). Entries are never edited or deleted.

## Dependency semantics

The dependency-graph validation gate (acceptance): adding a link rejects, as a
typed `invariant-violation` BEFORE any state lands —

- a **missing** predecessor or successor reference,
- a **self-dependency** (an activity cannot depend on itself),
- a **duplicate** link (same pair + link type), and
- any link that would **close a cycle** — a cycle is a deadlock; no valid
  program of work can schedule it (Kahn's algorithm over the directed
  predecessor→successor graph, regardless of link type).

Removing a dependency is the ONLY removal in the model (plan logic may be
re-modeled); activities, milestones, progress history and baselines are
append-only. The network stays consistent: the invariant set re-validates
reference integrity, acyclicity of the current network AND every baseline
snapshot on every transition.

## Baseline semantics (protected baselines)

A baseline, once set, can never be edited or deleted — there is no mutating
transition, and the two explicit guards `updateBaselineState` /
`removeBaselineState` encode that absence as always-failing typed `forbidden`
results. Change flows through activity updates, progress updates and
re-baselines only; snapshots are isolated deep copies, so every landed
baseline stays bit-identical forever. The forecast and variance are
DETERMINISTIC recomputations against the snapshot (freeze A3: projections are
derived, never stored as truth).

## Progress + forecast semantics

The forecast (`forecastSchedule`) is a PURE deterministic function of
(activities, dependencies, progress):

- **Remaining-work model**: an activity's forecast duration is its LATEST
  recorded remaining duration (full planned duration while unstarted, zero
  when complete).
- **CPM pass**: the classic forward/backward pass over calendar-free integer
  working units — early/late start/finish day offsets relative to the forecast
  origin (day 0), total float, criticality (`totalFloat <= 0`), the critical
  path (deterministic tie-breaks), and milestone forecast days (a bound
  milestone forecasts its activity's early finish; a project-level milestone
  the project finish).
- **Link semantics** as start bounds on the successor: `FS: ES(s) >= EF(p) +
  lag`, `SS: ES(s) >= ES(p) + lag`, `FF: ES(s) >= EF(p) + lag - d(s)`,
  `SF: ES(s) >= ES(p) + lag - d(s)`.
- **Determinism** (acceptance): the same network + progress yields identical
  early/late dates, floats, critical path and milestone days on every run,
  independent of input array ordering — max/min reductions, canonical
  orderings, deterministic tie-breaks, no clock, no randomness, no stored
  projections. `forecastOfSchedule` recomputes from the current network +
  latest progress; `forecastOfBaseline` recomputes the frozen plan
  progress-free; `scheduleVariance` derives the current-vs-baseline deltas from
  both.

## Commands, authorization, and concurrency

Every mutation runs the canonical path: parse the payload **fail-closed**
(strict keys; malformed input is a typed `invariant-violation`, never a silent
default) → authorize through `@office/authz`'s deny-by-default `authorize()`
(structural A12 isolation first, explicit deny, allow, default deny — a denied
command never opens a transaction) → load through the scope-guarded store →
optimistic concurrency (`expectedVersion`; stale → typed
`concurrency-conflict`, the network is never silently overwritten) → the
invariant-checked pure transition → store write + event append inside ONE
transaction (a failure anywhere rolls everything back).

**Baseline authorization** (acceptance): setting a baseline passes a SECOND,
distinct, stronger gate — the project-area write capability (`projects.write`)
in addition to the schedule-area write capability (`schedule.write`): an actor
holding only the schedule capability can record progress but is denied
baselining with a typed `forbidden`.

**A12 isolation**: the store is scope-guarded — a foreign tenant's or foreign
project's schedule loads as a typed `not-found` (invisible, no existence
oracle), and a tenant-scoped create must name its project while a
project-scoped create initializes exactly its own project (a payload naming
another project is a typed `unauthorized` second-boundary violation).

## Audit events + the EventSink port

Every mutation emits exactly one `DomainEventEnvelope` (freeze A3) through the
injected **EventSink port** — `appendEvents(executor, events)` inside the SAME
transaction as the store write, so a sink failure aborts the mutation (proven
by tests): event name, the aggregate's OWN project scope, actor, `source:
'domain'`, the correlation id carried over from the command's causal chain
with the causation id = the command's idempotency key (the OFF-005 ledger
convention), schema version, occurred-at (injected clock), and before/after
`EntityRef`s per transition kind. Every schedule event payload carries the
owning `scheduleId` — the ledger aggregate stream key.

The port is minimal and shape-mirrored from the landed identity modules. This
package ships three implementations:

- `createInMemoryEventSink()` — records appends instead of writing (tests);
- `failingEventSink(reason)` — a typed always-failing sink (failure-path
  tests/limits);
- `createLedgerEventSink()` — the REAL thin adapter over `@office/events`:
  appends each event to the OFF-005 event ledger and enqueues its
  transactional-outbox record, per envelope, inside the caller's transaction.
  It derives each event's ledger aggregate stream from the payload's
  `scheduleId` and fails closed (typed `invariant-violation`) when handed an
  envelope that does not carry one.

## Storage

This package is PURE DOMAIN: it ships NO migrations and NO SQL. The
`ScheduleStore` port (with the in-memory implementation) is the transactional
seam a later wiring implements over PostgreSQL; the in-memory store's
transactions refuse SQL by design (wire the ledger sink to a real persistence
transaction). A production wiring composes: a SQL-backed `ScheduleStore`, the
ledger event sink, the migrator, and the id/clock suppliers (wall clock +
crypto randomness there; fixed values in tests).

## Tests

The suite is deterministic and in-memory (no database, no `DATABASE_URL`):

```bash
pnpm test                                  # whole workspace, includes this package
pnpm vitest run packages/domain/schedule   # this package only
```

- `src/state.test.ts` — the dependency-graph gate (cycles, self-links,
  missing/duplicate references, removal + re-modeling), baseline protection
  (immutability guards; progress never mutates a baseline), the append-only
  progress log and its consistency rules, milestone and WBS validation,
  derived progress reads.
- `src/forecast.test.ts` — the deterministic CPM pass (multi-activity chain
  with a known critical path, parallel branches, lags, SS/FF/SF semantics),
  the remaining-work progress model, determinism (run-twice + shuffled
  inputs), milestone forecasts, fail-closed input validation.
- `src/variance.test.ts` — current-vs-baseline deltas, out-of-baseline
  activities, pre-baseline nulls, determinism.
- `src/events.test.ts` — the envelope builder (scope/actor/source/causality
  propagation, before/after refs), the event vocabulary, the sink port.
- `src/commands.test.ts` — fail-closed payload parsing for all eight
  commands, the command-name guard, authorization (default deny, explicit
  deny, undeclared capability; the DISTINCT stronger baseline capability),
  create-scope rules (one program of work per project), A12 cross-tenant and
  cross-project typed not-found, optimistic concurrency.
- `src/integration.test.ts` — the full in-memory lifecycle (one audit event
  per mutation with complete envelope assertions), baseline immutability +
  re-baseline chain, the failing-sink abort (state + ledger atomicity), cycle
  rejection through the command path, forecast recomputation after each
  progress event, and deterministic end-to-end replay of the identical
  command sequence.
- `src/ledger-sink.test.ts` — the ledger-backed EventSink adapter at the
  shape level against a fake executor (per-envelope sequence upsert + ledger
  insert + outbox insert in the caller's transaction; the fail-closed
  payload guard; typed outbox-failure mapping).
- `src/boundary.test.ts` — the package boundary self-gate: exactly the five
  allowed workspace dependencies, no domain-to-domain imports, no provider
  vocabulary, no migrations/SQL, source entry point only.
