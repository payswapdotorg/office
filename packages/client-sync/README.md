# @office/client-sync

Offline sync engine for PaySwap Office (**OFF-029**) — the client-side
offline sync protocol on top of **@office/sync**'s realtime subscription
layer: disconnected mutations are captured into a bounded **LocalQueue**
with CLIENT-GENERATED **deterministic operation ids** (client id + local
sequence + command fingerprint) and client-observed timestamps, stamped with
**causal/version tokens** (the client's last-confirmed slice cursor), and on
reconnection replayed through the typed command path **exactly once** —
idempotent by operation id at two composing layers, resumable across
interrupted drains without duplicates or losses. Diverged captures surface as
**explicit conflict records**: **PROTECTED** state (material commercial
state — financial, contractual, schedule-critical) is parked with **no
auto-resolution path**; the only exit is the typed **explicit resolution
command**, whose reconciled mutation re-enters the queue discipline and
applies exactly once. **OPEN** state supersedes deterministically (the
committed server side stands, recorded and audited — never silent).

This package is the PROTOCOL plus the deterministic in-memory reference
engine — **no transport of any kind** (no websocket, no network I/O), no
filesystem, no SQL, no migrations, no clock reads, no randomness (every
instant is an injected `now`, every identity a deterministic derivation).
The server-side world (the broker, the project-slice source, the operation
registry, the applied-operation journal, the conflict log, the typed command
path, and the audit sink) is **injected** through ports; the app layer wires
real transports, durable queue stores, the ledger-backed slice source, and
the domain command paths against them later.

Runtime dependencies are exactly `@office/sync` (THE foundation: grants,
subscriptions, project slices, operation registry, conflict records, the
broker), `@office/contracts` (envelope/scope/identity contracts),
`@office/domain-kernel` (Result/DomainError, command fingerprints,
idempotency semantics), `@office/authz` (the deny-by-default authorization
the replay re-checks), and `@office/events` (the ledger event vocabulary) —
plus `node:crypto` for sha256 digests. Nothing else is imported (verified by
the package's boundary tests).

`src/index.ts` is the whole public surface; import only from the package root
(`@office/client-sync`). Anything not re-exported there is package-internal
and may change without notice.

## What is here

| Area | Exports |
| --- | --- |
| Identity | `LocalSequence` (+ `parse`/`is`, grammar, bounds), `OfflineOperationKey`, `offlineOperationIdOf` (THE deterministic offline id rule: client id + local sequence + command fingerprint), `OfflineCommandIdentity`, `offlineCommandFingerprint` |
| Queue | `ProtectionClass` (+ `parse`/`is`), `QueueEntryState`, `QueueEntry` (+ `parse`/`is` — the fail-closed boundary every untrusted entry passes), `clientOperationOf`, `OfflineMutation`, `LocalQueue`, `DEFAULT_QUEUE_CAPACITY`, `createLocalQueue` (THE bounded disconnected mutation queue) |
| Tokens | `CausalToken` (the client's last-seen slice position), `addressesTarget`, `DivergenceAssessment`, `assessTargetDivergence` (the server-side base-version-vs-actual check: clean-apply vs conflict) |
| Conflict | `AppliedOperation`, `OperationJournal`, `createInMemoryOperationJournal` (every applied operation linked to its ledger event — a divergence names its cause), `ConflictLog`, `createInMemoryConflictLog` (idempotent re-detection), `autoResolveOpenConflict` (OPEN-state supersession only — never protected), `ConflictResolutionCommand` (THE typed explicit resolution) |
| Replay | `CommandPathContext`, `CommandPathOutcome`, `TypedCommandPath` (the authorized, idempotent command boundary the queue drains through), `authorizeQueuedMutation`, `DrainEntryOutcome`, `DrainReport`, `DrainDeps`, `drainLocalQueue` (THE exactly-once queue drain) |
| Audit | the five sync audit event names (`sync.mutationReplayed`, `sync.mutationRejected`, `sync.conflictSurfaced`, `sync.conflictAutoResolved`, `sync.conflictResolved`), `SyncAuditSinkExecutor`, `SyncEventSink`, `InMemorySyncEventSink`, `createInMemorySyncEventSink`, `failingSyncEventSink`, `failAfterSyncEventSink`, and the envelope builders |
| Engine | `SyncEngine`, `SyncEngineParts`, `OfflineCapture`, `OnlineSubmission`, `OnlineSubmissionOutcome`, `ReconnectReport`, `ConflictResolutionReport`, `createSyncEngine` (the composed in-memory engine: one client's sync session) |

## The protocol in one pass

One `SyncEngine` instance is ONE CLIENT's sync session over one subscribed
project slice; the server-side world is injected (two engines sharing one
world is the two-client convergence scenario):

1. **Subscribe** — the online session start, via @office/sync's broker and
   the A9 grant chain. The initial catchup is consumed with the
   exactly-once cursor discipline; the engine's confirmed position becomes
   its causal-token basis.
2. **goOffline** — the disconnect. The engine stops consuming its stream;
   captures accumulate in the bounded `LocalQueue` (default capacity 1024;
   overflow is a typed `queue-full` rejection — freeze A9).
3. **captureOffline** — the disconnected mutation capture, typed-rejected
   while connected (the online path is `submitOnline`). Each capture gets a
   DENSE local sequence, a client-generated deterministic operation id (the
   same client + sequence + command always derives the same id — a queue
   rebuild never mints a second identity for one logical mutation), the
   local causal chain (each capture caused by the previous one), the
   client-observed timestamp (payload data, never an ordering authority),
   and the CAUSAL/VERSION TOKEN (the position the client had consumed when
   it composed the mutation). The A8 idempotency-key rule: the command
   envelope's key IS the entry's operation id.
4. **submitOnline** — the connected twin: the ONLINE deterministic operation
   id (subscription + the client's observed cursor + the operation kind), the
   same authorization chain, the same idempotency semantics — an unconfirmed
   retry gets the RECORDED outcome back, never a second effect.
5. **reconnect** — catchup (resubscribe from the client's LAST CONFIRMED
   cursor — no duplicates, no gaps) + replay (the queue drain) + conflict
   surfacing + consumption of the client's own replayed effects, delivered
   live by the broker.
6. **resolveConflict** — the ONLY exit from a protected conflict (below).

## The queue and the exactly-once replay

On reconnection the queue drains through the typed command path in
DETERMINISTIC order (local sequence ascending). Each mutation replays
EXACTLY ONCE — idempotency by operation id at two composing layers:

1. **the protocol layer** — @office/sync's `OperationRegistry`: the drain
   registers the entry's `ClientOperation` before presenting the command; a
   re-drain after a partial failure sees the typed duplicate and resumes
   without duplicates;
2. **the effect layer** — the command envelope's idempotency key IS the
   deterministic offline operation id, and the typed command path is
   idempotent by (scope, key): an interrupted drain that re-presents a
   command whose effect already happened gets the RECORDED outcome back
   (`replayed: true`) — the inner handler runs exactly once.

The per-entry discipline (fail-closed, typed at every step): **authorize**
(grant active — a grant revoked while the client was offline typed-denies its
replay; required write capability; the caller-supplied policy,
deny-by-default, BEFORE any effect) → **register** (protocol dedup) →
**resume bookkeeping** (an operation already applied AND journaled in an
earlier interrupted drain re-surfaces its audit + terminal mark, nothing
else; the true crash gap — registered, effect landed, never journaled —
falls THROUGH to the divergence check, so the protection gate is structural)
→ **divergence check** (tokens.ts: base version vs actual — every
not-yet-applied entry) → **clean-apply** (command path → journal → publish →
audit → mark) or **conflict path** (below). Server rejections surface as
typed per-entry outcomes (audited, the entry stays pending and retryable);
an audit-sink failure ABORTS the whole drain — a partially-audited replay
never silently passes — and the resume continues exactly-once.

## Causal/version tokens and the divergence check

A capture's causal token is the slice position the client had consumed when
it composed it. At replay, `assessTargetDivergence` compares the target's
BASE VERSION (slice events addressing it at positions ≤ the token) against
the ACTUAL VERSION (at the head), counting the client's OWN causal-chain
events (journal-recorded own operations plus events caused by this queue's
own commands — the A3 `causedByCommand` convention) as knowledge, never
divergence. Base === actual is CLEAN (apply); a foreign event past the token
is DIVERGED (the first such event is the divergence's cause).

## Conflicts: protected vs open (the named acceptance)

A diverged capture is surfaced as an explicit @office/sync `ConflictRecord`
(both sides, deterministic side order). Its domain-declared protection class
decides what may happen next:

- **PROTECTED** mutations are PARKED: the replay engine has NO path that
  applies them — structurally (the drain's diverged-protected branch never
  invokes the typed command path, on first presentation OR on any resume;
  the entry goes terminal `conflicted`, out of `pending`, so no drain can
  ever present it again). The ONLY way forward is the typed **explicit
  resolution command** (`ConflictResolutionCommand`: the conflict, the
  explicit strategy, the resolving actor, ≥ 1 ledger event proving the
  reconciliation — a resolution without an audit trail is typed-rejected —
  and the reconciled mutation). The reconciled mutation RE-ENTERS the queue
  discipline: captured like any offline mutation (fresh deterministic
  operation id, the CURRENT causal token) and replayed exactly once. An
  identical re-resolution is an idempotent no-op; a different one is a typed
  invariant-violation. The protocol NEVER auto-resolves a protected
  conflict — no destructive automatic resolution, no last-write-wins.
- **OPEN** mutations are superseded DETERMINISTICALLY: the committed
  server-side operation stands (the engine never reverts committed ledger
  state), the supersession is recorded as a RESOLVED conflict record (system
  actor, strategy naming the standing side, the diverging event as audit
  evidence), and the entry lands `superseded`. Explicit and audited — never
  silent.

## The audit discipline (freeze A3)

Every consequential queue-drain transition emits an immutable
`DomainEventEnvelope` through the **EventSink port**
(`appendEvents(executor, events)` inside the caller's transaction — a
failure result MUST abort the surrounding drain): a replayed mutation
(`sync.mutationReplayed`), a typed server rejection
(`sync.mutationRejected`), a surfaced protected conflict
(`sync.conflictSurfaced`, carrying base/actual versions and the diverging
event), an open-state supersession (`sync.conflictAutoResolved`), and an
explicit resolution (`sync.conflictResolved`). Audit events ADDRESS the
target entity without changing it (before === after).

## THE offline convergence contract

Two clients, one shared world: client A drops offline and queues a protected
mutation against the pre-B world while client B mutates the same target
online. A reconnects → catchup (B's missed window, exactly once) → replay
(the divergence surfaces; A's entry is parked, never auto-resolved) → A
resolves EXPLICITLY (the reconciled mutation re-enters the queue and applies
exactly once) → both clients' folded state, consumed from their OWN streams,
is IDENTICAL — and identical to the world's actual ledger state: no
duplicates, no losses, no divergence. This is the acceptance scenario of
`engine.test.ts` and the contract OFF-030/031/032 clients inherit.

## Verification

From the repository root:

- `pnpm lint` / `pnpm typecheck` — clean.
- `pnpm test` — the colocated suites: `identity` (THE deterministic offline
  id rule), `queue` (the bounded capture discipline, the terminal lifecycle,
  the fail-closed entry parse), `tokens` (the divergence check's pure rule),
  `replay` (N queued → reconnect → each applied exactly once, counting inner
  handler invocations; the interrupted drain and the crash gap resumed
  exactly-once; rejections surfaced and retryable; authorization holding on
  replay), `conflict` (THE protected-conflict rule: surfaced record, the
  structural no-auto-resolution proof, the resolution re-entering the queue,
  the idempotent re-resolution, the open-state supersession), `engine` (the
  typed session lifecycle, the online twin, THE two-client offline
  convergence), `audit` (the freeze-A3 envelopes through the EventSink port,
  the aborting sink), and `boundary` (the package boundary self-gate).
- `pnpm test:architecture` — the workspace convention gate.

## Downstream consumers

- **OFF-030 (web client)** and **OFF-031/032 (the other clients)** embed the
  `SyncEngine` per client session, capture mutations offline behind their
  UI, and surface `ConflictRecord`s (from `conflictsNotified` and the
  `DrainReport`) for EXPLICIT human resolution — composing
  `ConflictResolutionCommand`s with their own reconciled payloads.
- The app layer wires the durable `LocalQueue` store, the real transport
  behind @office/sync's broker ports, the ledger-backed
  `ProjectSliceSource`, the domain packages' command handlers behind
  `TypedCommandPath`, and the persistence-backed audit sink behind
  `SyncEventSink`.

All of them import only from the package root (`@office/client-sync`).
