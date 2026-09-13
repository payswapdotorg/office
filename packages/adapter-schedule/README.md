# @office/adapter-schedule

The Office Primavera-class schedule adapter contract (**OFF-023**): the
schedule adapter over `@office/adapters-sdk` — project-schedule/activity/
activity-dependency/baseline reference mappings (provider ids are never
primary keys; baselines are immutable records), activity change-event mapping
into canonical schedules-area command proposals and event envelopes with
typed CPM data (durations, FS/SS/FF/SF dependencies + lag), **the downstream
impact-notification flow** (provider activity update → canonical schedule
event → impacted successor activities + the baseline notified with full
source-event traceability), **the typed schedule conflict rules** (concurrent
activity-date changes, dependency-cycle introductions, re-baselining attempts
against protected baselines — explicit Conflict records with both sides, never
auto-resolved), and replay-safe multi-stream sync.

An adapter is a **translator, never an owner** (freeze A5): it proposes typed
canonical commands the host executes; it never writes canonical state (freeze
A8/A11). All provider-specific shapes live **inside this package** — the
vocabulary is strictly generic (`schedule-pm` over `schedule-instance-01`; the
schedule object family is `project-schedule` / `activity` /
`activity-dependency` / `baseline`), and no vendor SDK is imported. Ports
only: no I/O, no SQL, no clock, no randomness (injected clock/id suppliers
everywhere).

The package consumes exactly four workspace dependencies —
`@office/adapters-sdk` (THE contract), `@office/contracts`,
`@office/domain-kernel`, and `@office/intelligence-relationships` (**consumed
as types only**: the notification flow is *typed against* the canonical
relationship vocabulary; no logic of the relationship engine is ever
imported). The boundary is self-gated by `src/boundary.test.ts`.

## Public surface

Everything is exported from `src/index.ts` (the package's whole surface —
deeper paths are internal and may change without notice):

| Module | What it exports |
| --- | --- |
| `vocabulary.ts` | The schedule adapter family identity (`schedule-pm` / `schedule-instance-01`), the four schedule object kinds + their canonical kinds + the capability block (`schedule.write`), the schedules-area command/event names, and the closed sub-vocabularies (the CPM link types FS/SS/FF/SF, lag/duration bounds, ISO calendar dates, provider id rules) — every one fail-closed parsed |
| `references.ts` | **The schedule reference contracts** — `recordScheduleObjectMapping` (kind + hierarchy discipline), `assertScheduleObjectMapping`, `resolveScheduleObject`, `resolveOwningSchedule`, `resolveDependencyEndpoints`, `scheduleProviderCoordinateOf`, `compareEntityRef` |
| `change-mapping.ts` | `createScheduleTranslator` (provider mutations → canonical command proposals), the schedules-area event payload contracts + parses, `scheduleEventEnvelope` / `scheduleCreatedEnvelope` / `activityAddedEnvelope` / `activityUpdatedEnvelope` / `dependencyAddedEnvelope` / `dependencyRemovedEnvelope` / `baselineSetEnvelope` (the host-side execution seam) |
| `notification.ts` | **THE downstream impact-notification flow** — `ScheduleEventId` / `scheduleEventIdOf` (the source event id), `edgesOfScheduleEvent`, `projectScheduleRelationships` (the deterministic relationship projection), `impactedEntitiesOfActivity`, `notificationsOfScheduleEvent` (the notification records) |
| `conflict-rules.ts` | **THE typed conflict rules** — `classifyScheduleConflict`, `detectDependencyCycle` (pure DFS over provider edges), `detectScheduleDivergences` (the pre-flight pass composing explicit Conflict records with both sides) |
| `adapter.ts` | `createScheduleAdapter` — the `Adapter` implementation over the injected `ScheduleProviderStore` port |
| `provider-fixture.ts` | `createScheduleProviderStore` + `createSeededScheduleProvider` — the deterministic in-memory schedule provider (a project schedule with three activities, two FS dependencies with typed lag, one protected baseline, mutation streams incl. the divergence scenarios, signed webhook emission) |
| `sync.ts` | `runScheduleSync` — the multi-stream sync driver in schedule hierarchy order, over the SDK's `runSync` engine, with the pre-flight conflict-rule pass and quarantine |
| `parse.ts` | Package-internal fail-closed parse combinators (deliberately NOT re-exported) |

## The Adapter implementation

`createScheduleAdapter({ store })` implements the SDK's `Adapter` contract
over an injected `ScheduleProviderStore` port (the provider-data seam — in
production the runtime wires the real provider client's data into it; in
tests the deterministic fixture does):

- **Capabilities** — the four declared object-kind surfaces
  (`project-schedule` → `schedule`, `activity` → `activity`,
  `activity-dependency` → `dependency`, `baseline` → `baseline`), each
  authorized through the declared `schedule.write` capability at sync time
  (deny-by-default via the SDK engine's authz check).
- **Lifecycle** — `connect` / `healthCheck` / `disconnect`, typed `Result`s
  over value types; a request for a different provider system is a typed
  rejection, never a guess.
- **Sync surface** — one page of one object-kind stream per call:
  tenant-stamped `ProviderSnapshot`s (fail-closed re-parsed by the engine)
  plus the positional continuation token/checkpoint. A resume token the
  provider cannot serve is a typed `provider-token-invalid` rejection.

## Schedule/activity/baseline reference mappings (the A10 discipline)

`references.ts` layers the SCHEDULE discipline on the SDK's tenant-scoped
`SourceMappingStore`:

- **Kind discipline** — a mapping for a schedule object-family coordinate must
  bind the canonical kind declared for that object kind (`activity` →
  `activity`, `activity-dependency` → `dependency`, `baseline` → `baseline`,
  `project-schedule` → `schedule`); anything else is a typed
  `schedule-mapping-kind-mismatch`, never silently used.
- **Hierarchy discipline** — an `activity` or `baseline` mapping requires its
  owning `project-schedule` mapping, and an `activity-dependency` mapping
  requires BOTH its predecessor AND successor `activity` mappings (same
  tenant, adapter family, provider system): links and baselines can never
  dangle above an unmapped schedule network — typed
  `schedule-parent-unmapped` (naming the missing parent's role and id), never
  an invented parent. `resolveOwningSchedule` / `resolveDependencyEndpoints`
  are the read side.
- **Remapping discipline** — re-pointing a coordinate at a different
  canonical id, or a second provider object claiming a bound canonical id, is
  the SDK store's typed collision (`source-mapping-collision` /
  `canonical-binding-collision`) — explicit conflicts, never overwrites, no
  last-write-wins anywhere.
- **Baseline immutability** — every newly observed provider baseline object
  (including a re-baseline superseding a prior one) registers a NEW canonical
  baseline record; a registered baseline is never mutated (see the conflict
  rules below for the in-place attempt).

Canonical ids are ALWAYS office-issued by the caller's injected supplier
(`SyncEngineDeps.nextCanonicalId`) — a provider object id never reaches a
canonical id field.

## Change-event mapping (mutation → proposal → canonical event)

`createScheduleTranslator()` is the `AdapterCommandTranslator`: pure,
deterministic, fail-closed over the provider payload before any proposal is
composed:

| Provider mutation | Proposed canonical command |
| --- | --- |
| project-schedule created | `schedule.createSchedule` |
| project-schedule updated / deleted in place | typed `schedule-update-unsupported` rejection — the frozen schedules-area vocabulary defines no schedule-update or schedule-deletion command (append-only history); an in-place provider schedule mutation is a divergence the runtime reconciles explicitly |
| activity created | `schedule.addActivity` (typed CPM data: code, duration, WBS parent, planned dates) |
| activity updated | `schedule.updateActivity` (**THE flow's proposal**: dates/duration/identity + `expectedVersion`) |
| activity deleted | typed `schedule-activity-deletion-unsupported` rejection — the schedules-area history is append-only |
| activity-dependency created / deleted | `schedule.addDependency` (link type + lag) / `schedule.removeDependency` — links are added and removed, never mutated in place (an in-place update is a typed `schedule-dependency-immutable` rejection) |
| baseline created | `schedule.setBaseline` — a re-baseline done properly is a NEW provider object (supersedes) registering a NEW canonical record |
| baseline updated / deleted in place | typed `schedule-baseline-immutable` rejection — baselines are immutable records; the in-place change of a mapped (protected) baseline is the re-baselining conflict the divergence detection records |

The host executes proposals (adapters never write the graph) and emits the
canonical events through the trusted builders — `scheduleCreatedEnvelope` /
`activityAddedEnvelope` / `activityUpdatedEnvelope` /
`dependencyAddedEnvelope` / `dependencyRemovedEnvelope` / `baselineSetEnvelope`
(via the generic `scheduleEventEnvelope`) — which self-check through the
strict payload parsers AND the contracts envelope parser: an emitted event can
never be invalid. The event's causation id IS the executed command's
idempotency key — the SourceRef-derived sync key of the exact provider object
version — so every canonical event is traceable to the exact provider
observation that caused it.

## THE typed conflict rules (the named focus)

Schedule conflicts are MATERIAL: the provider's schedule state and the
canonical schedules-area state can diverge in ways that must never be
silently reconciled (no last-write-wins, no destructive auto-resolution).
`conflict-rules.ts` is the adapter's divergence detection; every rule
composes an explicit `Conflict` record carrying BOTH sides (the provider
SourceRef INCLUDING its version, and the canonical EntityRef + its aggregate
version at detection) and NOTHING else — detection never resolves; resolution
is an explicit command (`resolveConflict` with ledger-evidence refs), which
the runtime issues after reconciling:

1. **Concurrent activity-date changes** — the provider changed an activity's
   dates while the canonical aggregate moved independently. Detected by the
   SDK's sync engine itself (both sides moved since the last synchronized
   point); `classifyScheduleConflict` types the engine's record as
   `concurrent-activity-change`.
2. **Dependency-cycle introductions** — a NEW provider dependency link whose
   edge would close a cycle in the schedule network (`detectDependencyCycle`:
   pure deterministic DFS over the provider's own edges). The introducing
   link is QUARANTINED from the sync stream (no mapping is created or
   advanced, no command is ever proposed — the canonical network stays
   acyclic) and the divergence is recorded as a typed
   `dependency-cycle-introduction` Conflict against the OWNING SCHEDULE
   aggregate.
3. **Baseline re-baselining attempts against protected baselines** — a
   provider baseline object changed IN PLACE where the mapped baseline record
   is immutable. The attempt is quarantined from the baseline stream (the
   immutable record is never mutated — its mapping keeps the last quiet
   provider version) and recorded as a typed `baseline-rebaselining` Conflict;
   a re-baseline done properly (a NEW provider baseline object superseding
   the old one) flows through as a NEW canonical baseline record.

`runScheduleSync` runs the pre-flight detection after the project-schedule
stream (whose mapping the detection records against), quarantines the
divergent objects from the dependency and baseline streams of that run, and
classifies EVERY conflict the run produced — the engine's both-sides-moved
divergences and the quarantined ones — with its typed rule kind in
`ScheduleSyncOutcome.conflictRules`, so the runtime sees WHICH named rule
fired for every record. Re-detection is idempotent (conflict ids derive from
both sides — the same divergence appended again is a no-op).

## THE notification flow (the OFF-023 acceptance)

```
provider activity update (the fixture's structure framing, dates moved)
  → ProviderSnapshot (runScheduleSync, schedule hierarchy stream order)
  → canonical command proposal (schedule.updateActivity)
  → (host executes it) canonical schedule.activityUpdated DomainEventEnvelope
  → projectScheduleRelationships derives the expected edges:
        the structural network: (activity) derives-from (its schedule),
        (activity) derives-from (its WBS parent activity),
        (successor activity) depends-on (predecessor activity),
        (baseline) derives-from (its schedule)
        + at every activity update, THE impact edges:
        (updated activity) affects (each impacted successor activity)
        (updated activity) affects (the schedule's baseline)
  → notificationsOfScheduleEvent emits one record per impacted entity,
    each referencing the SOURCE EVENT ID (scheduleEventIdOf) with the full
    causal chain: the event id, the event's causation id (= the executed
    command's SourceRef-derived idempotency key), and the correlation id of
    the provider object's whole lifecycle chain.
```

`ScheduleRelationshipEdge` is structurally the canonical `Relationship` shape
of `@office/intelligence-relationships` (`kind`/`from`/`to`/`scope` —
consumed as types only); the tracked nodes ARE the canonical `EntityNode`
shape; the derivation metadata mirrors `EventNameTally`. The OFF-005 ledger
assigns ledger event ids at append time — this package never touches the
ledger; the `ScheduleEventId` (`office-schev-v1-<sha256>`) is the
adapter-side stable reference the notification records cite. The projection
is a deterministic, rebuildable fold: events are consumed in given order,
edge identity is `(kind, from, to)`, the fold keeps the most recent asserting
event's reference per edge, non-schedules event names are skipped and
tallied, and a recognized name with a malformed payload fails closed as a
typed `invariant-violation`.

The end-to-end fixture lives in `src/schedule-flow.test.ts`; run-twice
determinism (identical proposals AND notifications) is asserted there too.

## Sync + cursor semantics

`runScheduleSync` is a thin orchestration over the SDK's `runSync` engine: it
drives every declared object-kind stream **in schedule hierarchy order**
(project schedule, then activities, then the dependency links between them,
then the baselines) so parent mappings exist before children reference them.
Per stream it pages until exhaustion (bounded by
`MAX_SYNC_PAGES_PER_STREAM`, a typed failure past it — never an unbounded
loop), with:

- **positional cursors** — the provider pages slice by stream position; the
  engine persists the continuation token per stream (`SyncCursorStore`), and
  a restart resumes from the persisted cursor with nothing checkpointed
  re-delivered; a cursor from another stream is a typed
  `cursor-stream-mismatch` rejection;
- **replay safety** — the command idempotency key is the SourceRef-derived
  sync key, so the same provider object version never proposes twice: a
  re-delivered page is `replay-no-op` (no duplicate mapping, no duplicate
  command);
- **re-sync determinism** — same provider data, same stores, same injected
  clock/id suppliers → the same mappings (the same office-issued canonical
  ids), cursors, conflicts, and command proposals;
- **explicit conflicts** — when provider and canonical sides both moved since
  the last synchronized point, the run records a detected `Conflict` with
  both sides (state `detected`, resolution only ever explicit) and proposes
  NO command; re-detection is an idempotent append; the pre-flight
  quarantine (above) keeps cycle-introducing links and in-place re-baselining
  attempts out of the stream entirely;
- **webhook ingest** — the fixture emits signed raw webhooks (`emitWebhook`);
  the SDK's `applyWebhook` normalizes (verify → parse → dedup key), resolves
  the mapping, and proposes the update command; a redelivered webhook is
  `replay-no-op`, a bad signature a typed `unauthorized`, an update for an
  unmapped source a typed `not-found`.

## The provider fixture

`createSeededScheduleProvider()` builds the fully deterministic in-memory
provider (generic vocabulary only): one project schedule (`sch-tower-a` —
"Tower A — master schedule"), three activities with typed CPM data (the WBS
chain `act-401` Foundations → `act-402` Structure framing → `act-403`
Envelope: codes, planned durations, planned start/finish dates, WBS parents),
two FS dependency links (`dep-401-402` with zero lag, `dep-402-403` with
typed 3-day lag), and one PROTECTED baseline over the whole network
(`bl-2026-09`, immutable). Mutations bump per-object provider versions
deterministically (`updateActivity` — THE flow's trigger), dependency
INTRODUCTIONS append new link objects (`introduceDependency` — the
cycle-introduction divergence: `dep-403-401` closes the network cycle),
baseline REGISTRATION appends new immutable baseline objects
(`registerBaseline` — a re-baseline done properly), and the IN-PLACE
re-baselining attempt mutates the protected baseline object
(`attemptRebaseline` — the named divergence the conflict rules quarantine).
No clock, no randomness: the same fixture state on every call.

## How tests run

The package's tests live beside the sources (`src/*.test.ts`) and run as part
of the workspace suite:

```
pnpm test                                     # all workspace tests (vitest run)
npx vitest run packages/adapter-schedule      # just this package's suite
pnpm test:architecture                        # the workspace architecture gate
```

Coverage: `vocabulary.test.ts` (closed vocabularies, fail-closed parses),
`references.test.ts` (A10/A11 mapping discipline: kind/hierarchy/remapping,
tenant scoping), `change-mapping.test.ts` (every translator branch + strict
payload parses + the trusted envelope builders), `notification.test.ts` (the
projection fold, the edge grammar, THE impact derivation, the notification
records), `conflict-rules.test.ts` (the pure cycle detection, the typed
classification, the pre-flight divergence pass), `adapter.test.ts` (lifecycle
+ positional paging + token validation), `sync.test.ts` (multi-stream
hierarchy order, replay idempotence, cursor restart, THE three conflict rules
through the driver — engine-detected AND quarantined — webhook ingest,
determinism + same-canonical-ids re-sync), `schedule-flow.test.ts` (**THE
named acceptance**, end to end + run-twice determinism), and
`boundary.test.ts` (the package boundary self-gate: imports, types-only
consumption, generic vocabulary discipline, pure ports, determinism scans).

## What OFF-037 consumes

The integration fabric consumes this package through its root entry point:
`createScheduleAdapter` (+ the `ScheduleProviderStore` port to wire the real
provider client's data into), `createScheduleTranslator`, `runScheduleSync`
(with the SDK's `SyncEngineDeps` — mappings/cursors/conflicts stores,
`canonicalVersionOf`, injected clock and office-issued id supplier — plus the
`ScheduleDivergenceView` port the pre-flight conflict rules run over), the
reference layer (`recordScheduleObjectMapping` / `resolveScheduleObject` /
`resolveOwningSchedule` / `resolveDependencyEndpoints` /
`scheduleProviderCoordinateOf` over the shared tenant-scoped mapping store),
the conflict-rules layer (`detectScheduleDivergences` /
`classifyScheduleConflict` — the typed conflict records the runtime resolves
explicitly), the envelope builders (`scheduleEventEnvelope` and the concrete
schedules-area builders — the host-side execution seam that emits the
canonical schedules-area events), and the notification flow
(`projectScheduleRelationships` + `notificationsOfScheduleEvent` +
`scheduleEventIdOf` — feeding the relationship engine's vocabulary with full
source-event traceability). The deterministic fixture
(`createSeededScheduleProvider`) is the harness for the fabric's own contract
tests.
