# @office/domain-contracts

The Office contracts and change domain module (OFF-012): the canonical,
**provider-independent** commercial spine of a construction project — the
project-scoped `Contract` aggregate (parties as typed links, canonical
minor-unit contract value, forward-only execution status, explicit one-way
archive) owning its immutable scope obligations; the `ChangeEvent` aggregate
binding change to scope, evidence, cost and schedule through **typed
cross-entity links** (ids and refs only — never copied data); the one-way
`ChangeOrder` lifecycle (submitted → approved/rejected → executed, executing
supersedes the originating change event's proposed state); and immutable claim
references pinning claims to evidence + executed change orders. Pure domain:
no SQL, no migrations, no wall clock, no randomness, no provider vocabulary —
provider import (construction-management platforms, estimating tools,
accounting systems) happens in adapter packages owned elsewhere, never here.

## Why this package exists

Freeze A1 makes the contract the commercial spine of the project graph: every
commercial fact — what was contracted, what changed, what the change cost,
and what evidence backs a claim — must be explicit, auditable, and immutable.
Contracted scope never edits itself: scope CHANGE flows exclusively through
change events and change orders, which is exactly why every change carries its
own audit trail. The contract root owns its scope decomposition (the
immutable `ScopeObligation` rows) as ONE consistency unit guarded by
optimistic concurrency, while change events, change orders and claim
references are their own aggregates (own id, version, concurrency token) so
they can be referenced individually by events, relationships (OFF-013) and
impact analysis (OFF-014).

## Public surface

`src/index.ts` is the package's whole public surface — consume the package
only through its root entry point, never through deeper paths.

| Area | Exports |
| --- | --- |
| State | `ContractState`, `ContractExecutionStatus`, `ContractLifecycleStatus`, the status vocabularies, `CONTRACT_KIND`, `CONTRACT_INVARIANTS`, `NewContract`, `ContractChanges`, `ScopeObligationState`, `SCOPE_OBLIGATION_KIND`, `NewScopeObligation`, `ChangeEventState`, `ChangeType`, `CHANGE_TYPES`, `ChangeEventStatus`, `CHANGE_EVENT_KIND`, `CHANGE_EVENT_INVARIANTS`, `NewChangeEvent`, `ChangeEventLinks`, `ChangeOrderState`, `ChangeOrderStatus`, `CHANGE_ORDER_STATUSES`, `CHANGE_ORDER_KIND`, `CHANGE_ORDER_INVARIANTS`, `NewChangeOrder`, `ClaimReferenceState`, `CLAIM_REFERENCE_KIND`, `CLAIM_REFERENCE_INVARIANTS`, `NewClaimReference`, and the pure transitions `create/update/archiveContractState`, `recordObligationState`, `createChangeEventState`, `linkChangeReferencesState`, `replaceChangeLinksState`, `removeChangeLinksState` (the always-failing link-immutability guards), `supersedeChangeEventState`, `create/approve/reject/executeChangeOrderState`, `createClaimReferenceState` |
| Value objects | `Money`, `MinorUnits`, `CurrencyCode`, `QuantityValue`, `PartyLink`, `PartyKind`, `EvidenceLink`, `CostImpactLink` (+ their grammar constants and the fail-closed `parse*`/is helpers) |
| Events | `EventSink` (the port), `InMemoryEventSink`, `RecordedEventAppend`, `createInMemoryEventSink`, `failingEventSink`, `eventSinkFailure`, the 11 event-name constants, `contractsEventEnvelope`, the ref builders (`contractRef`, `obligationRef`, `changeEventRef`, `changeOrderRef`, `claimReferenceRef`) and the payload types |
| Store | `ContractsStore`, `ContractsStoreTransaction`, `createInMemoryContractsStore`, `InMemoryContractsStore` |
| Commands | `ContractsCommands`, `createContractsCommands`, `ContractsCommandDeps`, `ContractsCommandAuthorization`, the 11 command-name constants, the payload types and their fail-closed parsers |
| Ledger sink | `createLedgerEventSink` (the thin OFF-005-backed EventSink adapter) |

Dependencies: exactly five workspace packages — `@office/contracts`,
`@office/domain-kernel`, `@office/authz`, `@office/events` (the ledger-backed
EventSink adapter only) and `@office/persistence` (the `SqlExecutor` type of
the mirrored EventSink port) — plus node builtins. No external dependencies;
no domain-to-domain imports (the EventSink port is shape-mirrored from the
identity modules, never imported from them).

## The contract aggregate

- **Project-scoped root** (the second authorization boundary, freeze A12):
  `{ kind: 'project', tenantId, projectId }` always, enforced by invariant.
- **Parties are typed links**: `owner` and `contractor` are `PartyLink`s
  (`{ entityKind: 'person' | 'company', entityId }`) — identity-domain
  entities referenced by canonical id, never copied (no names or emails enter
  this package).
- **Contract value is canonical money**: `Money` = integer **minor units**
  (cents) + an ISO-4217-style three-letter currency code. `@office/contracts`
  exposes no money type, so this package owns a local branded minor-unit type
  (documented here for a future contracts-package addition); minor units keep
  commercial arithmetic in exact integers — never floats.
- **Execution status is forward-only**: `draft` → `executed` → `closed`; a
  rewind is a typed `invariant-violation`.
- **Lifecycle is one-way**: `active` → `archived` — the explicit archive
  mirrors the identity modules' archive (timestamped, terminal, never a
  delete). An archived contract rejects updates, obligation recording,
  change-event raising, change-order submission and link appends.
- **Scope obligations are immutable rows of record** inside the root:
  create-only (code, description, canonical decimal-string `quantity`, unit),
  never updated, never deleted, version pinned to the initial version by
  invariant. Recording appends and bumps the ROOT's version exactly once (the
  commercial baseline is one consistency unit); duplicate codes are typed
  `invariant-violation`s.

## The change model (change event → change order)

A `ChangeEvent` is a proposed change to contracted scope — its OWN aggregate,
`'proposed'` until an executed change order supersedes it. A `ChangeOrder`
is the ordered/approved change lifecycle — its OWN aggregate with the
explicit, auditable, strictly one-way status machine:

```
submitted ──► approved ──► executed      (executing SUPERSEDES the originating
    │                                      change event's proposed state, in
    └──────► rejected                     the SAME unit of work)
```

- `'rejected'` and `'executed'` are terminal — every illegal transition is a
  typed `invariant-violation`, and the status/timestamp pairing invariants
  (`decidedAt`, `executedAt`) make an illegal jump structurally impossible.
- **Executing supersedes**: `executeChangeOrder` writes the executed order,
  supersedes the originating change event (status `'superseded'`,
  `supersededByChangeOrderId` pointing forward to the executing order), and
  appends the audit event inside ONE transaction — all three commit or none.
- **Rejected orders never mutate contracted scope**: there is no transition
  out of `'rejected'`, and the obligation rows are immutable anyway.
- A superseded change event can no longer originate a change order, and its
  link set is frozen (appends are typed-rejected).
- `changeValue` is signed minor-unit money (a decrease is negative) or null
  when the order carries no value impact.

## Claim references

A `ClaimReference` is an immutable pin binding one claim entity (a typed
`EntityKind` + `EntityId` link to an entity owned elsewhere — claims are not
modeled here) to ONE SPECIFIC document revision AND one **executed** change
order, inside the owning contract's scope. Create-only, never repointed; the
natural key (claim, change order, document, revision) rejects duplicates as a
typed conflict. Claim references bind only to executed orders — entitlement
evidence points at change that actually took effect.

## The typed-link discipline (the acceptance heart)

A change event binds to four link families — affected scope obligations,
entitlement evidence, cost impact, schedule impact — through TYPED
cross-entity links: canonical `EntityId`s and refs ONLY:

- `affectedObligationIds` — obligations of the owning contract (validated
  against THIS package's contract; unknown ids are typed rejections);
- `evidenceLinks` — `{ documentId, revisionId }` pairs, one SPECIFIC document
  revision each (documents domain never imported);
- `costImpactLinks` — `{ budgetId | null, costItemId | null }`, at least one
  non-null (cost domain never imported);
- `scheduleImpactActivityIds` — activity ids (schedule domain never imported).

**No referenced entity's data is ever duplicated** into this package's
aggregates or event payloads — no obligation descriptions, document titles or
hashes, cost amounts, or schedule dates: there is no field for them to appear
in, and the tests prove it by serializing the state. **Links are immutable
once recorded**: existing entries are never repointed, edited or removed; new
entries may only be APPENDED while the change event is still proposed, and
the always-failing guards `replaceChangeLinksState` /
`removeChangeLinksState` encode that absence as typed
`invariant-violation`s. Referential wiring against the documents, cost and
schedule packages is the app layer's job — the domain never imports them
(no domain-to-domain imports, ever).

## Commands, authorization, and concurrency

Every mutation runs the canonical path: parse the payload **fail-closed**
(strict keys; a malformed payload is a typed `invariant-violation` naming the
offending dotted path, never a silent default) → authorize through
`@office/authz`'s deny-by-default `authorize()` (structural A12 isolation
first, explicit deny, allow, default deny — a denied command never opens a
transaction; the capability is `contracts.write` over the contracts-domain
entity kinds) → load through the scope-guarded store → optimistic concurrency
(`expectedVersion`; stale → typed `concurrency-conflict`, commercial state is
never silently overwritten) → the invariant-checked pure transition → store
write + event append inside ONE `runInTransaction` (a failure anywhere rolls
everything back; `tx.rollback` carries the typed `DomainError` out).

**A12 isolation**: the store is scope-guarded — a foreign tenant's or foreign
project's contract, change event, change order or claim reference loads as a
typed `not-found` (invisible, no existence oracle), and a tenant-scoped
create must name its project while a project-scoped create initializes
exactly its own project (a payload naming another project is a typed
`unauthorized` second-boundary violation).

## Audit events + the EventSink port

Every mutation emits exactly one `DomainEventEnvelope` (freeze A3) through the
injected **EventSink port** — `appendEvents(executor, events)` inside the SAME
transaction as the store write, so a sink failure aborts the mutation (proven
by tests): event name, the aggregate's OWN project scope, actor,
`source: 'domain'`, the correlation id carried over from the command's causal
chain with the causation id = the command's idempotency key (the OFF-005
ledger convention), schema version, occurred-at (injected clock), and
before/after `EntityRef`s per transition kind. The vocabulary covers the
eleven transitions: contract created/updated/archived, obligation recorded,
change event raised/linked, change order submitted/approved/rejected/executed
(the executed payload records the supersession), claim referenced. Every
contracts event payload carries the owning `contractId` — the ledger
aggregate stream key (the contract root owns its whole commercial stream).

The port is minimal and shape-mirrored from the landed identity modules. This
package ships three implementations:

- `createInMemoryEventSink()` — records appends instead of writing (tests);
- `failingEventSink(reason)` — a typed always-failing sink (failure-path
  tests/limits);
- `createLedgerEventSink()` — the REAL thin adapter over `@office/events`:
  appends each event to the OFF-005 event ledger and enqueues its
  transactional-outbox record, per envelope, inside the caller's transaction.
  It derives each event's ledger aggregate stream from the payload's
  `contractId` and fails closed (typed `invariant-violation`) when handed an
  envelope that does not carry one.

## Determinism and ids

Handlers read no wall clock and no randomness: `now` and the canonical-id
opaque parts come from the injected suppliers (`ContractsCommandDeps`). Every
canonical id is composed through the contracts `formatEntityId` helper, so
every issued id parses with `parseEntityId` by construction — the same
supplier sequence yields the same ids, and replaying the identical command
sequence reconstructs the exact final state AND the exact event stream
(test-proven).

## Storage

This package is PURE DOMAIN: it ships NO migrations and NO SQL. The
`ContractsStore` port (with the in-memory implementation) is the transactional
seam a later wiring implements over PostgreSQL; the in-memory store's
transactions refuse SQL by design (wire the ledger sink to a real persistence
transaction). A production wiring composes: a SQL-backed `ContractsStore`,
the ledger event sink, the migrator, and the id/clock suppliers (wall clock +
crypto randomness there; fixed values in tests).

## Tests

The suite is deterministic and in-memory (no database, no `DATABASE_URL`):

```bash
pnpm test                                    # whole workspace, includes this package
pnpm vitest run packages/domain/contracts    # this package only
```

- `src/state.test.ts` — the contract lifecycle (forward-only execution
  status, one-way terminal archive), immutable obligation rows, the change
  event's typed link families (duplicate rejection, append-only, the
  always-failing replace/remove guards, one-way supersession with frozen
  links), the one-way change-order machine, the create-only claim reference
  invariants.
- `src/parse.test.ts` — the commercial value objects (money, quantities,
  party/evidence/cost links) and every command payload parser, fail-closed
  with strict keys and nested indexed error paths.
- `src/events.test.ts` — the envelope builder (scope/actor/source/causality
  propagation, before/after refs), the event vocabulary (all eleven names and
  their payloads), the sink port implementations.
- `src/commands.test.ts` — fail-closed parsing through the handlers, the
  command-name guard, deny-by-default authorization (capability required,
  explicit deny, undeclared capability; denied commands never open a
  transaction), create-scope rules, A12 cross-tenant AND cross-project typed
  not-found with nothing mutated, optimistic concurrency (contract and change
  event), the cross-entity link gate, the one-way lifecycles, claim
  references (executed-order requirement, duplicate natural key), the
  failing-sink abort.
- `src/integration.test.ts` — the full commercial lifecycle (one audit event
  per mutation with complete envelope assertions), THE link-no-copy
  acceptance (serialized states and event payloads contain ids/refs only),
  deterministic end-to-end replay (identical states AND identical event
  streams), deterministic ids, the scope-guarded read model.
- `src/ledger-sink.test.ts` — the ledger-backed EventSink adapter at the
  shape level against a fake executor (per-envelope ledger append + outbox
  enqueue in the caller's transaction; the fail-closed payload guard; typed
  outbox-failure mapping).
- `src/boundary.test.ts` — the package boundary self-gate: exactly the five
  allowed workspace dependencies, no domain-to-domain imports, no provider
  vocabulary, no migrations/SQL, source entry point only, deterministic
  sources.
