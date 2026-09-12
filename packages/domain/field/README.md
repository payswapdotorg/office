# @office/domain-field

Work & field domain module for PaySwap Office (**OFF-009**) — the canonical
project-scoped **FieldEvent**, **DailyLog**, **Issue**, and **Inspection**
aggregates of the frozen enterprise graph (freeze A1/A12): field crews capture
what they observe on site (deliveries, pours, visits, …), keep append-only
daily logs, raise and walk issues to resolution, and schedule/conduct
inspections whose findings link issues. Every capture can happen **offline**:
each command carries a **client-generated idempotency key** and a
**client-observed timestamp**, and replays exactly-once after reconnection
through the domain-kernel `IdempotencyRegistry` (freeze A9/A8).

This package is **pure domain**: aggregates, commands, and ports only — no SQL,
no migrations, no repository layer (the persistence/app layers implement the
`FieldStore` port transactionally later). Runtime dependencies are exactly
`@office/contracts`, `@office/domain-kernel`, `@office/authz`,
`@office/persistence` (the `SqlExecutor` **type** of the `EventSink` port
only), and `@office/events` — which IS in this item's dependency graph,
imported only by the thin ledger-backed `EventSink` adapter (`ledger-sink.ts`)
that implements the port transactionally over the OFF-005 event ledger + outbox.
No other external dependencies, and no domain-to-domain imports: the identity
modules (OFF-007) are mirrored in *shape*, never imported — the `EventSink`
port is the seam any transactional implementation satisfies structurally.

`src/index.ts` is the whole public surface; import only from the package root
(`@office/domain-field`). Anything not re-exported there is package-internal
and may change without notice.

## The model in one paragraph

A `FieldEvent` (project-scoped, `open` → `resolved` one-way) records one
observation: category, summary, location, the **client-observed** `observedAt`
timestamp and `observedBy` party, an optional quantity `Measurement`, and
create-only `EvidenceReference` pins (entity + document + revision). A
`DailyLog` is keyed by `(project, day, party)` — one log per party per
canonical calendar day (`LogDay`, `YYYY-MM-DD`) — and holds **append-only
entries**; the day closes exactly once, and a correction is a NEW entry whose
`correctsEntryId` points at the entry it corrects — entries are never edited
or deleted. An `Issue` (`open` → `resolved` → `reopened`…) carries a severity,
an optional assignee, and **append-only comments** with the same
correction-as-new-comment rule; resolution requires an open issue, reopening
requires a resolved one. An `Inspection` (`scheduled` → `conducted` → a
terminal outcome) declares a checklist upfront, must be conducted with exactly
that checklist's results, and terminates in an outcome (`pass` / `pass-with-
findings` / `fail` / `inconclusive`) whose findings reference issues of the
same project scope. All four lifecycles are one-way, invariant-checked, and
optimistically concurrent (stale `expectedVersion` → typed
`concurrency-conflict`, state untouched).

## What is here

| Area | Exports |
| --- | --- |
| State | `FieldEventState` (+ `FIELD_EVENT_KIND`, `FIELD_EVENT_STATUSES`, `FIELD_EVENT_INVARIANTS`, `NewFieldEvent`, `EvidenceReference`, `Measurement`), `DailyLogState` (+ `DAILY_LOG_KIND`, `DAILY_LOG_STATUSES`, `DAILY_LOG_INVARIANTS`, `NewDailyLog`, `DailyLogEntry`, `DailyLogEntryInput`), `IssueState` (+ `ISSUE_KIND`, `ISSUE_STATUSES`, `ISSUE_SEVERITIES`, `ISSUE_INVARIANTS`, `NewIssue`, `IssueComment`), `InspectionState` (+ `INSPECTION_KIND`, `INSPECTION_STATUSES`, `INSPECTION_OUTCOMES`, `INSPECTION_INVARIANTS`, `NewInspection`, `ChecklistItem`, `InspectionResult`, `InspectionFinding`, `InspectionOutcome`), and the pure transitions `createFieldEventState`, `attachFieldEventEvidenceState`, `resolveFieldEventState`, `createDailyLogState`, `appendDailyLogEntryState`, `closeDailyLogDayState`, `createIssueState`, `assignIssueState`, `commentOnIssueState`, `resolveIssueState`, `reopenIssueState`, `createInspectionState`, `conductInspectionState`, `recordInspectionOutcomeState` |
| Scoping value | `LogDay` + `parseLogDay` / `isLogDay` / `LOG_DAY_GRAMMAR` (calendar-exact canonical day) |
| Store port | `FieldStore`, `createInMemoryFieldStore` (A12 visibility by construction: foreign tenant → typed not-found, no existence oracle; same tenant / wrong project → typed unauthorized) |
| Events | `EventSink`, `InMemoryEventSink`, `RecordedEventAppend`, `createInMemoryEventSink`, `failingEventSink`, `eventSinkFailure`, the thirteen `field.*` event-name constants + `FIELD_EVENT_NAMES`, `fieldEventEnvelope`, `createdRefs`, `updatedRefs`, `fieldEntityRef` (+ the payload types) |
| Ledger adapter | `createLedgerEventSink` (+ `LedgerEventSinkOptions`) — the transactional `appendEvent` + `enqueueOutbox` implementation of the port |
| Commands | `createFieldCommands` (+ `FieldCommands`, the four per-aggregate groups, `FieldCommandDeps`, `FieldCommandAuthorization`, `FieldCommandOutcome`), the thirteen command-name constants, and the fail-closed payload parsers (`parseCaptureFieldEventPayload`, `parseRaiseIssuePayload`, …) |
| Read model | `createProjectReadModel` (+ `ProjectReadModel`, `FieldEventSummary`, `OpenIssueRecord`, `InspectionOutcomeRecord`) |

## The mutation path (per command)

1. **Command-name guard + fail-closed payload parse** — a malformed payload is
   a typed `invariant-violation` (`invalid-command-payload`), never a silent
   default; unknown keys are rejected (strict shape).
2. **Project scope required** (freeze A12, second boundary): every field
   aggregate is project-bound, so a tenant-scoped command is a typed
   `unauthorized` `project-scope-required` — field-event capture requires
   project scope, not just tenant scope.
3. **Deny-by-default authorization** through `@office/authz`'s `authorize()`
   with the CALLER-supplied `{ policy, capabilities }`: structural scope
   isolation, then explicit deny, then allow, then default deny. A denied
   command never mutates anything at all — no store write, no event, and not
   even an idempotency-registry lookup.
4. **Idempotency** through the domain-kernel `IdempotencyRegistry`, keyed by
   `(scope, idempotency key)` — see the offline contract below.
5. **Scoped load + A12 backstop**: the store's scoped loads make a foreign
   tenant's aggregate a typed not-found (no existence oracle) and a
   same-tenant/wrong-project aggregate a typed `project-scope-violation`;
   `checkScopeCovers` re-checks coverage anyway (defense in depth).
6. **Optimistic concurrency**: `checkConcurrency` against the loaded
   aggregate's `concurrencyTokenOf` — a stale `expectedVersion` is a typed
   `concurrency-conflict` and the state is never silently overwritten.
7. **Invariant-checked pure transition** (append-only histories, one-way
   lifecycles).
8. **Sink append BEFORE store commit**: the audit event is appended through
   the injected `EventSink` on the injected `executor`, and only then is the
   store written — a failing sink aborts the whole mutation (state unchanged,
   nothing recorded, the key stays retryable).
9. **Typed outcome**: `{ replayed, state }` — replays carry the ORIGINAL
   outcome with `replayed: true`.

## The offline capture/replay contract (freeze A9/A8)

A disconnected crew forms commands with a **client-generated idempotency key**
(the `CommandEnvelope`'s `idempotencyKey`) and **client-observed timestamps**
(`observedAt` / `reportedAt` / `conductedAt` — payload *data* recorded on the
aggregate, never ordering authority). After reconnection the client retries
the same command; the registry guarantees:

- **Same `(scope, key)` + same command fingerprint** → the ORIGINAL outcome is
  returned with `replayed: true`: no second aggregate, no second audit event,
  no second canonical id consumed, no fresh clock read — even after the
  aggregate has since mutated further (the registry replays the recorded
  outcome; it never re-reads the store).
- **Same key + different payload** → typed `idempotency-conflict`
  (`idempotency-key-reuse`); no duplicate effects.
- **A failed execution is never recorded** (e.g. the event-sink outage above),
  so a transient failure stays retryable under the SAME key.
- **Keys are scoped**: the same key under another project is a different
  command.
- **Authorization precedes idempotency**: a retry arriving without the
  capability is denied (`forbidden`) and the registry is never consulted —
  a denial is never mistaken for a replay.
- Honest retry metadata (`issuedAt`) is not command identity: only
  `(scope, key, fingerprint)` is.

## Projection semantics (read model)

`createProjectReadModel()` is an in-memory projection **rebuilt from the
emitted event envelopes** — `apply()` folds one `DomainEventEnvelope` at a
time and answers the three per-project reads:

- `recentFieldEvents(projectId, limit)` — newest capture first, with live
  status (a later resolution flips the summary's status);
- `openIssues(projectId)` — the currently-open issues with assignee, in
  raise order;
- `inspectionOutcomes(projectId)` — the recorded terminal outcomes with their
  findings' issue ids, in schedule order.

The projection is **fail-closed**: a foreign event name, a tenant-scoped
envelope, or a resolution applied before its capture are typed
`invariant-violation`s (the ledger's dense per-aggregate order is the
ordering authority — never a client-observed timestamp). The test suite proves
the projection answers **identically** to the aggregate states in the store,
so the emitted event shapes are sufficient to derive the views.

## The EventSink port + the ledger adapter

`EventSink` (in `events.ts`) is the minimal port: `appendEvents(executor,
events)` on the caller's transaction handle. `createInMemoryEventSink()`
records appends (tests), `failingEventSink(reason)` proves atomicity, and
`createLedgerEventSink()` (in `ledger-sink.ts`) is the transactional
implementation over `@office/events`: for every envelope it calls `appendEvent`
(ledger row + dense per-aggregate sequence) and `enqueueOutbox` (dispatch row)
on the SAME caller-supplied `SqlExecutor` — the open transaction of the
surrounding mutation — so event, outbox entry, and state change commit
atomically or vanish together. The aggregate of each append is derived from
the envelope's `entityRefs.after`; a missing after-ref is a typed failure.
Every mutation emits exactly one envelope carrying the command's scope, actor,
`source: 'domain'`, propagated correlation/causation ids (causation = the
command's idempotency key), before/after `EntityRefs` (before `null` exactly
on creations), and the invariant-checked next state mirrored into the payload.

## Running the tests

The package is fully deterministic (injected `now` / `newOpaqueId` suppliers,
in-memory store/sink/registry, fixed literals) and runs as part of the
workspace vitest suite — no database, no network:

```sh
pnpm test                      # whole workspace (this package: 160 tests)
pnpm vitest run packages/domain/field   # just this package
pnpm lint && pnpm typecheck && pnpm test:architecture
```

Test files, one per concern: `state.test.ts` (pure transitions, invariants,
append-only histories), `parse.test.ts` (fail-closed payload parsing),
`events.test.ts` (audit envelopes + failing-sink atomicity),
`commands.test.ts` (authorization, A12 both boundaries both directions,
concurrency, lifecycles), `offline.test.ts` (THE exactly-once capture/replay
gate), `projection.test.ts` (read-model correctness),
`ledger-sink.test.ts` (ledger delegation shape, mocked ledger), and
`boundary.test.ts` (the package-boundary self-gate: dependencies, imports,
no provider vocabulary, no wall clock / randomness, pure domain).

## Downstream consumers

The app layer wires `createFieldCommands` with a transactional `FieldStore`,
the ledger-backed sink (or its own), a durable idempotency registry, and the
real clock/id suppliers; read paths subscribe to the ledger and fold into
`createProjectReadModel` (or a SQL projection of the same events). Later
Office modules consume this package only through its root entry point.
