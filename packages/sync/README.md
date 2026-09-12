# @office/sync

Realtime subscription protocol for PaySwap Office (**OFF-028**) — the
client synchronization API's protocol layer: versioned, typed subscription
contracts over **project-slice** event streams (freeze A12: all clients share
ONE project state), backed by explicit, versioned, revocable **A9 subscription
grants** that are re-checked at every stream read, with **exactly-once cursor
resume**, **deterministic client operation ids**, and **explicit conflict
records** that are never auto-resolved.

This package is the PROTOCOL plus a deterministic in-memory reference broker —
**no transport of any kind** (no websocket, no socket.io, no network I/O), no
SQL, no migrations, no writes to the event ledger. The app layer wires a real
transport against the typed stream messages and the ledger-backed slice source
later; `createSubscriptionBroker` is the in-memory test implementation of the
stream semantics.

Runtime dependencies are exactly `@office/contracts` (envelope/scope/identity
contracts), `@office/domain-kernel` (Result/DomainError),
`@office/authz` (deny-by-default authorization for the A9 grants), and
`@office/events` (the ledger read vocabulary: `LedgerEvent`, ledger event
ids/sequences) — plus `node:crypto` for sha256 digests. Nothing else is
imported (verified by the package's tests).

`src/index.ts` is the whole public surface; import only from the package root
(`@office/sync`). Anything not re-exported there is package-internal and may
change without notice.

## What is here

| Area | Exports |
| --- | --- |
| Identity | `SubscriptionId`, `SubscriptionGrantId`, `OperationId`, `ConflictRecordId` (+ `parse`/`is`/`format` helpers, grammars) and the deterministic derivations `subscriptionIdOf`, `subscriptionGrantIdOf`, `operationIdOf`, `conflictRecordIdOf` |
| Versioning | `ProtocolVersion`, `KNOWN_PROTOCOL_VERSIONS`, `CURRENT_PROTOCOL_VERSION` (`'1.0.0'`), `parseProtocolVersion` / `isProtocolVersion` — fail-closed ("no unversioned external synchronization") |
| Grant | `SubscriptionGrant`, `GrantState`, `GrantVersion`, `grantSubscription`, `upgradeGrantProtocol`, `revokeGrant`, `isGrantActive` — the A9 permission backing a subscription |
| Subscription | `Subscription`, `SubscriptionFilter`, `eventMatchesFilter`, `filterSliceEntries` — the versioned join contract |
| Slice | `SlicePosition`, `SliceCursor`, `SliceEntry`, `ProjectSlice`, `ProjectSliceSource` (the ledger read port), `orderSliceEntries` (the deterministic ordering rule), `buildProjectSlice`, `sliceEntriesAfter`, `headPositionOf`, `checkSliceContinuity`, `parseLedgerEvent`, `createInMemorySliceSource` |
| Messages | the five typed stream messages — `EventDeliveredMessage`, `SliceCatchupMessage`, `GrantRevokedMessage`, `ConflictNotifiedMessage`, `ProtocolErrorMessage` (+ `StreamMessage`, `parseStreamMessage`, per-kind parses) |
| Operations | `ClientOperation`, `OperationKind`, `OperationDigest`, `operationDigestOf`, `OperationRegistry`, `createInMemoryOperationRegistry` — deterministic ids + typed deduplication |
| Conflict | `ConflictRecord`, `ConflictResolution`, `detectConflict`, `resolveConflict` — explicit, auditable, never auto-resolved |
| Broker | `createSubscriptionBroker`, `SubscriptionBroker`, `LiveSubscription`, `SUBSCRIPTION_READ_CAPABILITY` — the in-memory reference implementation |

## The protocol in one pass

A client joins one project slice's stream and converges on the shared state:

1. **Grant** — an administrator issues a `SubscriptionGrant` (A9: explicit,
   versioned, revocable). The grant — not the subscription — is the
   permission: it carries the full `AuthorizationContext` (actor, execution
   scope, capabilities), the pinned protocol version, and its lifecycle
   position `granted → versioned → revoked` (revocation is terminal and
   idempotent).
2. **Subscribe** — the client submits a `Subscription`: the pinned protocol
   version, the typed filter (tenant+project scope plus optional
   entity-kind/event-name filters), the resume cursor (or null to start from
   the beginning), and the grant pin (`grantId` + `grantVersion` the
   subscription was composed against — a stale pin is typed-rejected after a
   grant upgrade; the client recomposes).
3. **Catchup** — the broker reads the slice window strictly after the cursor
   and delivers one `slice-catchup` message (entries in deterministic slice
   order, cursor after the last entry).
4. **Live** — each appended ledger event is fanned out as an
   `event-delivered` message: the event, its intrinsic slice position, and the
   advanced cursor.
5. **Stop** — revoking the grant stops every live stream it backs with the
   typed `grant-revoked` message: whole messages only, never a partial or
   corrupt event mid-delivery. New subscribes against a revoked grant are
   typed-denied.

## Project slices and the deterministic order

A `ProjectSlice` is one project's ordered event stream: every project-scope
ledger event of that project, in ONE deterministic total order with dense
1-based positions — `(occurredAt ASC, eventId ASC)`. The eventId tiebreak
(sha256-derived by the ledger) makes the order total even when distinct
aggregates' events share an instant: the same set of ledger events ALWAYS
yields the same slice, regardless of append timing, read timing, or input
order (proven run-twice by test). Positions are the cursor basis; filtered-out
events leave position gaps BY DESIGN (the cursor tracks delivered positions,
and a resume re-reads and re-filters the in-between window deterministically).

`ProjectSliceSource` is the ledger READ port the protocol projects from (this
package never writes history — consumers project, they do not mutate). The
runtime wires the real ledger behind this port; `createInMemorySliceSource`
ships the deterministic in-memory source for tests, mirroring the OFF-005
ledger's identity semantics exactly (dense per-(tenant, aggregate) sequences,
`ledgerEventIdOf`-derived event ids), so the same append sequence reproduces
identical reads.

## Exactly-once resume semantics

Delivery per subscription is exactly-once **relative to the presented
cursor**:

- `resubscribe(subscriptionId, cursor)` delivers the window strictly AFTER
  `cursor.position` — nothing the cursor already confirmed is re-delivered,
  and the window is verified contiguous fail-closed (`checkSliceContinuity`:
  a gap is a typed `invariant-violation`, never a silently starved client).
- A client presenting its latest cursor after a reconnect gets an empty
  incremental catchup — no duplicates.
- A client presenting a stale cursor (at-least-once replay) gets exactly the
  missing contiguous window: positions `cursor+1 .. head`, no gaps.
- A cursor of another subscription never resumes this one (typed
  `cursor-subscription-mismatch`); a cursor beyond the slice head is typed
  `cursor-beyond-head` — fabricated progress is never accepted.

Client operations carry **deterministic ids** (freeze A9): the idempotency key
is sha256 over (subscription, observed cursor position, operation kind) —
`operationIdOf` — and the payload travels as its canonical digest
(`operationDigestOf`, canonical JSON with recursively sorted keys). Same id +
same digest = a typed `duplicate` no-op in the `OperationRegistry`; same id +
different digest = typed `idempotency-conflict`. A retry after a reconnect is
a duplicate, never a second effect.

## Conflict records (explicit, never auto-resolved)

When two clients' concurrent operations on the same target produce
incompatible states — same target entity, same project scope, same observed
slice position, different payload digests — `detectConflict` records the
divergence EXPLICITLY: a `ConflictRecord` carrying BOTH complete operations,
in deterministic operation-id order (so the conflict id, derived from both
sides in that order, is stable across re-detection). The record lands in
`'detected'` and stays there — **no destructive automatic resolution, no
last-write-wins, anywhere in this package**. Resolution is an explicit
`resolveConflict` command citing at least one ledger event as audit evidence
(closed strategy vocabulary: merge / first-operation-wins /
second-operation-wins, sides in the record's canonical order); re-resolving
identically is an idempotent no-op, re-resolving differently is a typed
`invariant-violation`.

## The broker's authorization order (deny-by-default)

Every stream start (subscribe and resubscribe) runs, in order, BEFORE any
slice read or event delivery (proven by test with a read-counting source):

1. grant lookup (typed `not-found`);
2. grant state — a revoked grant typed-denies new subscribes and resumes;
3. structural scope coverage (A12) — cross-tenant and cross-project
   subscriptions are typed `unauthorized` in both directions, with no
   existence oracle;
4. the `projects.read` capability (`SUBSCRIPTION_READ_CAPABILITY`);
5. the caller-supplied policy through `authorize()` (explicit deny wins,
   first allow grants, default deny);
6. the grant-version and protocol-version pins (stale pins typed-rejected).

At every subsequent stream read (`publish`), the grant is RE-CHECKED: a
revoked grant stops its live streams typed-cleanly with `grant-revoked` and
nothing else. Fan-out iterates subscriptions in insertion order; every
delivered position, cursor, and message derives from the slice's
deterministic order — the same published stream and the same subscriptions
always produce identical delivered sequences (run-twice proven by test). No
clock, no randomness: timestamps arrive as injected parameters.

## Reported gap: the ledger read surface

`ProjectSliceSource.readSlice` needs a paginated, scope-checked project read
ordered by `(occurred_at ASC, event_id ASC)` over `event_ledger`. The
**current** `@office/events` public read surface offers only `readEventById`
and `readAggregateEvents` (per-aggregate); there is no project-scoped ordered
stream read yet. This does NOT block OFF-028 — the port isolates it, and the
in-memory source mirrors the ledger's identity semantics — but the runtime
wiring (OFF-029+) must add that read (or a maintained project-position
projection) to the events ledger read surface, behind this port, with the
same scope-responsible semantics (foreign-tenant rows simply not present).

## Verification

From the repository root:

- `pnpm lint` / `pnpm typecheck` — clean.
- `pnpm test` — the colocated suites: `identity`, `version`, `grant`,
  `subscription`, `slice`, `messages`, `operations`, `conflict`
  (unit/parse/determinism), and `broker` — the acceptance surface: the golden
  convergence test (two clients, one mutation, one live + one late-joining via
  catchup, identical state folded from their own streams after independent
  catchup + resubscribe), exactly-once cursor resume (latest and stale
  cursors, no duplicates, no gaps, foreign/beyond-head rejections), A9
  revocation (clean typed stops, denied re-subscribes, no partial events),
  A12 isolation (both directions, authorization before any slice read),
  conflict fan-out over the two-client concurrent-op scenario, the run-twice
  delivered-sequence identity, and the grant/protocol version pins.
- `pnpm test:architecture` — the workspace convention gate.

## Downstream consumers

- **OFF-029 (sync engine)** wires the durable operation registry and the
  ledger-backed `ProjectSliceSource` behind these ports, and drives the
  broker semantics against real transports.
- **OFF-030/031/032 (web and other clients)** consume the typed stream
  messages (`parseStreamMessage` at their boundary), resume from
  `SliceCursor`s, compose `ClientOperation`s with deterministic ids, and
  surface `ConflictRecord`s for explicit resolution.

All of them import only from the package root (`@office/sync`).
