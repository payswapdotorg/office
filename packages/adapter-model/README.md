# @office/adapter-model

The Office BIM/model adapter contract (**OFF-022**): the Autodesk-class model
adapter over `@office/adapters-sdk` — model/model-version/element/
element-classification reference mappings (provider ids are never primary
keys), element change-event mapping into canonical models-area command
proposals and event envelopes, **the affected-relationship notification
flow** (model element mutation → canonical event → affected
activity/document notifications), and replay-safe multi-stream sync.

An adapter is a **translator, never an owner** (freeze A5): it proposes typed
canonical commands the host executes; it never writes canonical state (freeze
A8/A11). All provider-specific shapes live **inside this package** — the
vocabulary is strictly generic (`model-cde` over `model-instance-01`; the
model object family is `model` / `model-version` / `element` /
`element-classification`), and no vendor SDK is imported. Ports only: no I/O,
no SQL, no clock, no randomness (injected clock/id suppliers everywhere).

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
| `vocabulary.ts` | The model adapter family identity (`model-cde` / `model-instance-01`), the four model object kinds + their canonical kinds + the capability block (`models.write`), the models-area command/event names, and the closed sub-vocabularies (element classifications, quantity units, disciplines, change kinds, provider link refs) — every one fail-closed parsed |
| `references.ts` | **The model reference contracts** — `recordModelObjectMapping` (kind + hierarchy discipline), `assertModelObjectMapping`, `resolveModelObject`, `resolveElementParentChain`, `modelProviderCoordinateOf`, `resolveProviderLink(s)`, `compareEntityRef` |
| `change-mapping.ts` | `createModelTranslator` (provider mutations → canonical command proposals), the models-area event payload contracts + parses, `modelEventEnvelope` / `elementChangedEnvelope` / `elementRetiredEnvelope` (the host-side execution seam) |
| `notification.ts` | **THE affected-relationship notification flow** — `ModelEventId` / `modelEventIdOf` (the source event id), `edgesOfModelEvent`, `projectModelRelationships` (the deterministic relationship projection), `notificationsOfModelEvent` (the notification records) |
| `adapter.ts` | `createModelAdapter` — the `Adapter` implementation over the injected `ModelProviderStore` port |
| `provider-fixture.ts` | `createModelProviderStore` + `createSeededModelProvider` — the deterministic in-memory model provider (a model with two immutable versions, classified elements with linked activity/document refs, mutation streams, signed webhook emission) |
| `sync.ts` | `runModelSync` — the multi-stream sync driver in model hierarchy order, over the SDK's `runSync` engine |
| `parse.ts` | Package-internal fail-closed parse combinators (deliberately NOT re-exported) |

## The Adapter implementation

`createModelAdapter({ store })` implements the SDK's `Adapter` contract over
an injected `ModelProviderStore` port (the provider-data seam — in production
the runtime wires the real provider client's data into it; in tests the
deterministic fixture does):

- **Capabilities** — the four declared object-kind surfaces
  (`model` → `model`, `model-version` → `model-version`, `element` →
  `element`, `element-classification` → `element-classification`), each
  authorized through the declared `models.write` capability at sync time
  (deny-by-default via the SDK engine's authz check).
- **Lifecycle** — `connect` / `healthCheck` / `disconnect`, typed `Result`s
  over value types; a request for a different provider system is a typed
  rejection, never a guess.
- **Sync surface** — one page of one object-kind stream per call:
  tenant-stamped `ProviderSnapshot`s (fail-closed re-parsed by the engine)
  plus the positional continuation token/checkpoint. A resume token the
  provider cannot serve is a typed `provider-token-invalid` rejection.

## Model/version/element reference mappings (the A10 discipline)

`references.ts` layers the MODEL discipline on the SDK's tenant-scoped
`SourceMappingStore`:

- **Kind discipline** — a mapping for a model object-family coordinate must
  bind the canonical kind declared for that object kind; anything else is a
  typed `model-mapping-kind-mismatch`, never silently used.
- **Hierarchy discipline** — a `model-version` mapping requires its parent
  `model` mapping, an `element` mapping requires its owning `model-version`
  mapping (same tenant, adapter family, provider system): elements can never
  dangle above an unmapped version — typed `model-parent-unmapped`, never an
  invented parent. `resolveElementParentChain` is the read side.
- **Remapping discipline** — re-pointing a coordinate at a different
  canonical id, or a second provider object claiming a bound canonical id, is
  the SDK store's typed collision (`source-mapping-collision` /
  `canonical-binding-collision`) — explicit conflicts, never overwrites, no
  last-write-wins anywhere.
- **Link resolution** — provider-side link refs (an element's linked activity
  in the schedule-side family, its evidencing document in the CDE-side
  family) resolve through the SAME shared mapping store the other adapters'
  syncs populate; resolution is all-or-nothing (`resolveProviderLinks` fails
  closed naming the first unresolved link), and output is canonically
  ordered.

Canonical ids are ALWAYS office-issued by the caller's injected supplier
(`SyncEngineDeps.nextCanonicalId`) — a provider object id never reaches a
canonical id field.

## Change-event mapping (mutation → proposal → canonical event)

`createModelTranslator()` is the `AdapterCommandTranslator`: pure,
deterministic, fail-closed over the provider payload before any proposal is
composed:

| Provider mutation | Proposed canonical command |
| --- | --- |
| model created / updated | `models.registerModel` / `models.updateModel` |
| model-version created | `models.registerModelVersion` (immutable: an in-place provider update is a typed `model-version-immutable` rejection — a changed version is a NEW provider object) |
| classification created / updated | `models.registerClassification` / `models.updateClassification` |
| element created / updated | `models.recordElementChange` (typed classification, quantity, linked refs, full provenance in `extensionMetadata`) |
| element deleted | `models.retireElement` — the **delete-of-version retirement**: the element is retired from the version going forward and its history is never destructively deleted |
| model / model-version / classification deleted | typed `model-history-immutable` rejection — the canonical models-area history is append-only; container deletions are a divergence the runtime reconciles explicitly |

The host executes proposals (adapters never write the graph) and emits the
canonical events through the trusted builders — `elementChangedEnvelope` /
`elementRetiredEnvelope` / `modelEventEnvelope` — which self-check through the
strict payload parsers AND the contracts envelope parser: an emitted event can
never be invalid. The event's causation id IS the executed command's
idempotency key — the SourceRef-derived sync key of the exact provider object
version — so every canonical event is traceable to the exact provider
observation that caused it.

## THE notification flow (the OFF-022 acceptance)

```
provider element mutation (the fixture's wall element, updated)
  → ProviderSnapshot (runModelSync, model hierarchy stream order)
  → canonical command proposal (models.recordElementChange)
  → (host executes it) canonical models.elementChanged DomainEventEnvelope
  → projectModelRelationships derives the expected edges:
        (element) affects (each linked activity/document)
        (element) derives-from (its model version)
        (model version) derives-from (its model)
  → notificationsOfModelEvent emits one record per affected linked entity,
    each referencing the SOURCE EVENT ID (modelEventIdOf) with the full causal
    chain: the event id, the event's causation id (= the executed command's
    SourceRef-derived idempotency key), and the correlation id of the
    provider object's whole lifecycle chain.
```

`ModelRelationshipEdge` is structurally the canonical `Relationship` shape of
`@office/intelligence-relationships` (`kind`/`from`/`to`/`scope` — consumed
as types only); the tracked nodes ARE the canonical `EntityNode` shape; the
derivation metadata mirrors `EventNameTally`. The OFF-005 ledger assigns
ledger event ids at append time — this package never touches the ledger; the
`ModelEventId` (`office-mdev-v1-<sha256>`) is the adapter-side stable
reference the notification records cite. The projection is a deterministic,
rebuildable fold: events are consumed in given order, edge identity is
`(kind, from, to)`, the fold keeps the most recent asserting event's
reference per edge, non-models event names are skipped and tallied, and a
recognized name with a malformed payload fails closed as a typed
`invariant-violation`.

The end-to-end fixture lives in `src/model-flow.test.ts`; run-twice
determinism (identical proposals AND notifications) is asserted there too.

## Sync + cursor semantics

`runModelSync` is a thin orchestration over the SDK's `runSync` engine: it
drives every declared object-kind stream **in model hierarchy order**
(models, then model versions, then elements, then classification entries) so
parent mappings exist before children reference them. Per stream it pages
until exhaustion (bounded by `MAX_SYNC_PAGES_PER_STREAM`, a typed failure
past it — never an unbounded loop), with:

- **positional cursors** — the provider pages slice by stream position; the
  engine persists the continuation token per stream
  (`SyncCursorStore`), and a restart resumes from the persisted cursor with
  nothing checkpointed re-delivered; a cursor from another stream is a typed
  `cursor-stream-mismatch` rejection;
- **replay safety** — the command idempotency key is the SourceRef-derived
  sync key, so the same provider object version never proposes twice: a
  re-delivered page is `replay-no-op` (no duplicate mapping, no duplicate
  command);
- **explicit conflicts** — when provider and canonical sides both moved since
  the last synchronized point, the run records a detected `Conflict` with
  both sides (state `detected`, resolution only ever explicit) and proposes
  NO command; re-detection is an idempotent append;
- **webhook ingest** — the fixture emits signed raw webhooks
  (`emitWebhook`); the SDK's `applyWebhook` normalizes (verify → parse →
  dedup key), resolves the mapping, and proposes the update command; a
  redelivered webhook is `replay-no-op`, a bad signature a typed
  `unauthorized`.

## The provider fixture

`createSeededModelProvider()` builds the fully deterministic in-memory
provider (generic vocabulary only): one model (`m-tower-a`) with **two
immutable versions** (`mv-tower-a-1` baseline, `mv-tower-a-2` coordination
update — registering v2 never rewrites v1), two classification registry
entries (`cls-wall`, `cls-column`), and two elements at v2 — the wall
(`el-wall-103`, classification `wall`, quantity 42.5 m2, linked to one
activity AND one document) and the column (`el-column-21`, classification
`column`, quantity 12 m3, linked to the activity only). Mutations bump
per-object provider versions deterministically (`updateElement`), deletions
are tombstones (`retireElement` — history persists), and
`registerModelVersion` appends a new immutable version. No clock, no
randomness: the same fixture state on every call.

## How tests run

The package's tests live beside the sources (`src/*.test.ts`) and run as part
of the workspace suite:

```
pnpm test                                  # all workspace tests (vitest run)
npx vitest run packages/adapter-model      # just this package's suite
pnpm test:architecture                     # the workspace architecture gate
```

Coverage: `vocabulary.test.ts` (closed vocabularies, fail-closed parses),
`references.test.ts` (A10/A11 mapping discipline: kind/hierarchy/remapping,
tenant scoping, link resolution), `change-mapping.test.ts` (every translator
branch + strict payload parses + the trusted envelope builders),
`notification.test.ts` (the projection fold, the edge grammar, the
notification records, types-only vocabulary compatibility),
`adapter.test.ts` (lifecycle + positional paging + token validation),
`sync.test.ts` (multi-stream hierarchy order, replay idempotence, conflicts,
cursor restart, webhook ingest, determinism), `model-flow.test.ts` (**THE
named acceptance**, end to end + run-twice determinism), and
`boundary.test.ts` (the package boundary self-gate: imports, types-only
consumption, generic vocabulary discipline, pure ports, determinism scans).

## What OFF-037 consumes

The integration fabric consumes this package through its root entry point:
`createModelAdapter` (+ the `ModelProviderStore` port to wire the real
provider client's data into), `createModelTranslator`, `runModelSync` (with
the SDK's `SyncEngineDeps` — mappings/cursors/conflicts stores,
`canonicalVersionOf`, injected clock and office-issued id supplier), the
reference layer (`recordModelObjectMapping` / `resolveModelObject` /
`resolveElementParentChain` / `resolveProviderLinks` over the shared
tenant-scoped mapping store), the envelope builders (`elementChangedEnvelope`
/ `elementRetiredEnvelope` / `modelEventEnvelope` — the host-side execution
seam that emits the canonical models-area events), and the notification flow
(`projectModelRelationships` + `notificationsOfModelEvent` + `modelEventIdOf`
— feeding the relationship engine's vocabulary with full source-event
traceability). The deterministic fixture (`createSeededModelProvider`) is the
harness for the fabric's own contract tests.
