# @office/adapter-construction

The Office reference construction/CDE provider adapter (**OFF-021**): a
complete Adapter implementation over the `@office/adapters-sdk` contract —
the "Procore-class" work item realized as a strictly **generic
construction common-data-environment (CDE)** adapter. No real vendor name,
wire format, or credential appears anywhere inside the package (`boundary.test.ts`
enforces the ban); swapping this adapter for a concrete vendor integration
means a sibling package owning the real names and signatures over the SAME
SDK contract.

The adapter is a **translator, never an owner** (freeze A5): it declares the
object kinds it can sync, pulls provider-neutral `ProviderSnapshot`s, and
proposes typed canonical commands that the Action Gateway / application
layer executes — adapters **never** write the graph (freeze A8/A11).
Provider ids are **never** primary keys (freeze anti-pattern A10): the
binding between a provider object and its office-issued canonical id is a
first-class, queryable, tenant-scoped `SourceMapping` (A12) recorded by the
SDK engines. Everything is pure ports — no I/O, no SQL, no clock, no
randomness; the clock, the canonical id supplier, the stores, and the
signature verifiers are all injected.

## The Adapter implementation

`src/adapter.ts` — `createConstructionAdapter({ store })` implements the SDK's
`Adapter` contract over one injected construction provider store (the
fixture below, or a real CDE client's read surface):

- **Capabilities** — the four declared object-kind surfaces, validated
  through the SDK's own fail-closed `parseAdapterCapabilities` so the mapping
  table and the declaration can never drift apart.
- **Lifecycle** — `connect` / `healthCheck` / `disconnect` as typed state
  transitions over connection VALUES (tracked by reference identity, never
  sockets): an unknown connection is a typed not-found, a disconnected
  connection is never usable again, and the health surface observes the
  provider's degraded mode (the fixture's degrade/recover dial).
- **Sync surface** — `sync(SyncRequest)` returns one page of one object-kind
  stream: tenant-stamped snapshots plus the continuation token/checkpoint.
  Positional replay safety: the token is the position AFTER the last
  delivered item.

`src/sync.ts` — `runConstructionSync` orchestrates every declared stream (or
the caller's subset) through the SDK's `runSync` engine to exhaustion,
resuming each stream from its persisted cursor: one call performs a complete
initial ingest OR an incremental catch-up. A stream that keeps reporting
more items is bounded (`sync-page-limit`); any typed engine failure (an
invalid limit, a fail-closed translation) aborts the whole call.

## Object mappings

`src/vocabulary.ts` owns THE object mapping table — the heart of the A6/A11
discipline. Every command name below is a LANDED canonical command (the
literals are validated through the contracts parsers at module load):

| Provider object kind | Canonical kind | Capability | created | updated | deleted |
| --- | --- | --- | --- | --- | --- |
| `document` | `document` | `documents.write` | `documents.registerDocument` | `documents.attachRevision` | `documents.archiveDocument` |
| `rfi` | `field-issue` | `work.write` | `field.raiseIssue` | `field.commentOnIssue` | `field.resolveIssue` |
| `change-event` | `change-event` | `contracts.write` | `contracts.raiseChangeEvent` | `contracts.linkChangeReferences` | **fails closed** |
| `observation` | `field-event` | `work.write` | `field.captureFieldEvent` | `field.attachFieldEventEvidence` | `field.resolveFieldEvent` |

The single documented gap: the canonical contracts domain models change
events as **append-only** — no landed command withdraws one — so a withdrawn
provider change event maps to NOTHING and the translator (`src/mapping.ts`)
fails closed (`provider-transition-unmapped`) instead of improvising a
semantic that does not exist. Documented translation decisions the adapter
owns: a document update attaches the provider's current revision content; an
RFI update comments with the provider's current question; a change-event
update links the append-only impact references added since the last
synchronized version (the latest cost impact / schedule activity); an
observation update attaches the latest append-only evidence reference.
Identity references inside payloads (project, contract, users, evidence
document/revision ids) are the office-issued ids the provider learned when
its workspace was provisioned from office — parsed fail-closed as canonical
ids, never manufactured from provider ids.

Every payload is parsed **fail-closed per object kind first** (`parse.ts` +
the four `parse*ProviderData` parsers): strict keys, bounded strings, typed
enums, canonical id grammars — a malformed payload is a typed translation
failure with a field path, never a partially-filled command.

## Source identity

Provider objects are identified by their `SourceRef` — adapter kind
`construction-cde`, provider system `cde-instance-01` (the reference
fixture), object type, object id, and the provider's monotonic version
(`v1`, `v2`, …). The version-less projection (the `SourceCoordinate`) is
what a `SourceMapping` binds to an office-issued canonical `EntityRef`.
The mapping store enforces the bijection invariants (a coordinate re-pointed
at a different canonical id, or a second provider object claiming a bound
canonical id, is a typed collision — never an overwrite), and every
operation is tenant-scoped (A12): a foreign tenant's mapping is
indistinguishable from absence.

`src/snapshot-translation.ts` is the neutral seam: one provider object at
one version becomes a tenant-stamped `ProviderSnapshot` — provenance
(SourceRef), the display name, the lifecycle status with the explicit
`deleted` tombstone state, the provider's own last-modified instant, the
observation instant from the injected clock, and the open-keyed extension
bag carrying the per-kind provider payload data. The SAME data view feeds
the sync path (the snapshot's `extension`) and the webhook path (the
translated body's `data`), so both intake paths converge on one command per
provider object version.

## Sync & cursor semantics

`runConstructionSync` drives each stream page-by-page through the SDK
engine, which reconciles every snapshot: no mapping + active → issue a
canonical id (injected supplier) and propose the create; mapping + provider
moved + canonical quiet → propose the update/delete and advance the
bookkeeping; both sides moved → an explicit Conflict (below); same
SourceRef + version → idempotent replay no-op. The stream's cursor is
persisted through the engine (monotonic — it never rewinds).

Replay safety is two-layered:

1. **Positional** — the adapter's continuation token is the position after
   the last delivered item, so restarting from a checkpointed cursor
   re-delivers nothing already checkpointed; the un-checkpointed tail of an
   interrupted run is re-delivered at-least-once.
2. **Idempotent** — anything that does come back no-ops through the
   SourceRef-derived command idempotency keys (one command per provider
   object version, shared with the webhook path).

Single-object streams exhaust inside one page, so no cursor is persisted
for them — a later call re-scans the whole stream, which is how provider
mutations on those streams are observed positionally (mutations on
already-consumed positions arrive through the webhook path or the runtime's
full re-scan).

## Webhook ingest

`src/webhook-ingest.ts` owns what comes BACK from the CDE: the provider
pushes events in its own wire format — `{ kind: 'cde-webhook-event',
eventType: '<object-kind>.<created|updated|deleted>', objectId,
revisionTag, occurredAt, payload }` — signed with the `x-cde-signature`
header. `ingestCdeWebhook` layers the SDK's `applyWebhook` intake engine:

1. **JSON-exactness** of the wire body;
2. the **provider signature** over the wire body (authenticity established
   at the provider boundary, before any translation — the injected
   `WebhookSignatureVerifier` port; `createCdeWebhookVerifier` is the
   deterministic test double);
3. **fail-closed translation** into the SDK's `ProviderWebhookBody` (strict
   keys, eventType grammar, declared object kinds only);
4. a **divergence pre-check**: if the source is mapped, the push carries a
   NEW provider version, AND the canonical aggregate moved independently —
   an explicit `Conflict` record with BOTH sides is appended and NO command
   is proposed (never a silent last-write-wins; the SDK's webhook engine has
   no conflict store, so this package composes one over `detectedConflict`
   + the injected `ConflictStore`);
5. the **SDK intake engine** over the translated body, with a
   translation-integrity checksum header (`x-cde-translation`) binding the
   body the SDK normalizes to exactly the value this translation produced.

The runtime replaces both deterministic sha256 conventions with its real
crypto policy at the port. Redelivered pushes derive the same dedup key and
replay as no-ops; `updated` pushes with no established mapping are typed
not-found (run a targeted sync first).

## The provider fixture

`src/provider-fixture.ts` — `createConstructionProviderStore()` is a
complete, deterministic, in-memory construction CDE at reference-fixture
scale: controlled documents with revision history, RFIs, change events with
append-only cost/schedule impact links, and field observations with
append-only evidence references. Objects version monotonically per id,
deletions are tombstones (never removals), every mutation is pure data
(caller-supplied instants), and `emitWebhook(eventKind, objectId)` produces
the signed raw push in the CDE wire format. All provider-specific shape
knowledge lives in the fixture, `snapshot-translation.ts`, and `mapping.ts`
— nothing provider-shaped ever leaves the package.

## Running the tests

No build step (source package, same convention as the merged packages) and
no test scripts of its own — the root vitest glob
(`packages/*/src/**/*.test.ts`) discovers the seven suites:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:architecture
```

The suite (7 files, 76 tests) mirrors the SDK idioms: deterministic
everywhere (injected clocks stepped per phase, sequential office-issued id
suppliers, fixed tenants/instants), typed `Result` assertions, fail-closed
parse matrices. The marquee suites:

- **`contract.test.ts` — THE named acceptance**: the construction fixture
  round-trips through the adapter contract end to end — initial ingest
  (objects → snapshots → mappings + command proposals), update (new
  provider version → update proposal + cursor advance, appended objects
  picked up incrementally), source mapping (re-sync resolves the SAME
  canonical ids deterministically; cross-tenant lookups typed-rejected),
  replay (same SourceRef+version → idempotent no-op; cursor restart →
  nothing re-processed; tombstone → archive proposal), divergence (both
  sides moved → explicit Conflict records with both sides, re-detection
  idempotent) — then the whole scenario re-runs with fresh stores and the
  same injected clock/id suppliers to prove identical proposals.
- **`boundary.test.ts` — THE no-provider-types-in-core acceptance**: the
  package imports ONLY `@office/adapters-sdk`, `@office/contracts`, and
  `@office/domain-kernel` (never a domain/intelligence/sync/actions/
  workflows/agents/app package, never `apps/*`), carries no provider
  vocabulary, performs no I/O, is deterministic everywhere — and a runtime
  proof that the canonical graph is touched ONLY through typed command
  proposals: a full ingest leaves the canonical-state stand-in untouched
  while every artifact that would move it is a typed `CommandEnvelope` over
  the landed command vocabulary with SourceRef-derived idempotency keys.
- `adapter.test.ts`, `sync.test.ts`, `webhook-ingest.test.ts`, and the
  inherited `mapping.test.ts` / `vocabulary.test.ts` cover the lifecycle
  transitions, positional paging and restarts, the multi-stream orchestrator
  (including the page bound and fail-closed propagation), the CDE wire
  translation matrix, signature/tamper rejection, the webhook intake
  branches (including divergence conflicts and cross-path idempotency-key
  convergence), and the object mapping table.

## What OFF-037 consumes

**OFF-037** (the end-to-end construction reference scenario — the
integration-acceptance item that wires model change → quantity/cost →
schedule impact → change evidence → approval → execution) consumes this
package through its public surface only (`src/index.ts`): the vocabulary and
mapping table (to know which canonical kinds/commands a construction source
proposes), `createConstructionAdapter` + `runConstructionSync` for the
ingest legs, `ingestCdeWebhook` (with the injected signature verifier and
conflict store) for the push legs, and the deterministic provider fixture
to script the construction side of the scenario. OFF-037 executes the
proposed `CommandEnvelope`s through the Action Gateway — which is also what
advances the canonical aggregate versions the engines observe — and
resolves any recorded conflicts explicitly (`resolveConflict` with ledger
audit refs), never automatically. The adapter runtime (the SQL
implementations of the mapping/cursor/conflict stores, the webhook dedup
registry, the real signature verifiers, and the cron/worker wiring) belongs
to the runtime layer, not this package.
