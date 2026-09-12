# @office/adapters-sdk

The Office provider-neutral integration SDK (**OFF-020**): the contract every
provider adapter (**OFF-021+**) implements, plus the deterministic engines that
drive provider observations into canonical office state — without the SDK ever
owning canonical semantics, performing I/O, or speaking any real provider's
name.

An adapter is a **translator, never an owner** (freeze A5): it declares what
object kinds it can sync, pulls provider-neutral snapshots, and proposes typed
canonical commands that the Action Gateway / application layer executes
(adapters **never** write the graph — freeze A8/A11). Provider ids are
**never** primary keys (freeze anti-pattern, A10): the binding between a
provider object and its office-issued canonical id is a first-class,
queryable, tenant-scoped record (A12).

## Public surface

Everything is exported from `src/index.ts` (the package's whole surface —
deeper paths are internal and may change without notice):

| Module | What it exports |
| --- | --- |
| `json.ts` | `AdapterJsonValue` / `AdapterJsonObject` (+bounds) — the JSON-exact extension-bag model |
| `identity.ts` | `AdapterKind`, `ProviderSystemId`, `ProviderObjectKind`, `ProviderObjectId`, `ProviderVersion` (+ total fail-closed `parse`, `is` guards, trusted builders) |
| `source-ref.ts` | `SourceCoordinate`, `SourceRef` (+parse/is/builders), `sourceRefKeyOf` / `sourceCoordinateKeyOf`, `syncIdempotencyKey`, `sourceCorrelationId` |
| `mapping.ts` | `SourceMapping`, the `SourceMappingStore` port, `createInMemorySourceMappingStore`, `recordSourceMapping`, `assertMappingTenant` |
| `cursor.ts` | `SyncStream`, `SyncCheckpoint`, `SyncCursor`, `SyncCursorToken` (+parse/is/builders), `syncStreamKeyOf`, `checkCursorStream`, `nextCursor`, the `SyncCursorStore` port + in-memory fixture |
| `conflict.ts` | `Conflict`, `ConflictId`, `ConflictResolution` (strategy vocabulary), `conflictIdOf`, `detectedConflict`, `resolveConflict`, the `ConflictStore` port + in-memory fixture |
| `snapshot.ts` | `ProviderSnapshot`, `ProviderObjectStatus` (+parse/is/builder) |
| `adapter.ts` | **the `Adapter` contract** — `AdapterCapabilities`, lifecycle values (`AdapterConnection`, `AdapterHealth`, `AdapterDisconnected`), `SyncRequest`/`SyncResult` (+parse), `requireAdapterActor`, `adapterAuthorizationContext` |
| `webhook.ts` | `RawWebhook`, `ProviderWebhookBody`, `NormalizedWebhook`, the `WebhookSignatureVerifier` port, `webhookDeduplicationKey`, `normalizeWebhook`, `applyWebhook` (intake engine) |
| `commands.ts` | `AdapterCommandInput`/`Proposal`, the `AdapterCommandTranslator` port, `adapterCommandEnvelope`, `causationIdOfWebhook`, `requireCanonicalTarget`, `checkCommandEnvelopeRoundTrip` |
| `sync.ts` | `runSync` (the sync engine), `SyncEngineDeps`, `SyncOutcome`, `SyncApplication` |
| `fake-provider.ts` | The deterministic fake-provider fixture + fake webhook verifier |

## The Adapter contract

`Adapter` is what OFF-021+ packages implement:

- **Capabilities** — the declared object-kind surfaces: for each provider
  object kind, the canonical entity kind it maps into and the capability the
  sync authorizes through (`@office/authz` deny-by-default). Unique object
  kinds, at least one.
- **Lifecycle** — `connect` / `healthCheck` / `disconnect`, all typed
  `Result`s over value types (no sockets in the SDK; real adapters do I/O
  against these contracts, credentials never appear in any SDK type).
- **Sync surface** — `sync(SyncRequest)` pulls one page of one object-kind
  stream: tenant-stamped snapshots plus the continuation token/checkpoint.

The engines treat adapter output as **untrusted**: `runSync` re-parses every
page fail-closed and typed-rejects cross-tenant or cross-stream snapshot
injections before anything is applied.

## SourceRef & identity mapping (the A10 discipline)

A `SourceRef` is a provider object's full identity — adapter kind, provider
system, provider object type, provider object id, provider version/etag
(version is REQUIRED; an adapter whose provider has none derives one
deterministically from payload content). The version-less projection is the
`SourceCoordinate` — the stable identity a `SourceMapping` binds to an
office-issued canonical `EntityRef`.

Mapping semantics (enforced, never silently repaired):

- **Tenant-scoped both directions (A12)** — every store operation is keyed by
  tenant first; a foreign tenant's mapping is indistinguishable from absence
  (no existence oracle). `assertMappingTenant` typed-rejects presented
  foreign-tenant records.
- **Deterministic** — the same provider object re-synced resolves to the
  SAME canonical id; re-saves advance version bookkeeping only.
- **Bijective within (tenant, adapter, system, object type)** — re-pointing a
  coordinate at a different canonical id, or a second provider object
  claiming an already-bound canonical id, is a typed collision (`source-mapping-collision`
  / `canonical-binding-collision`), never an overwrite.
- **Version bookkeeping** — `providerVersion` / `canonicalVersion` record the
  pair the conflict detector compares to detect divergence on both sides.

Deterministic derivations (sha256 over canonical JSON serializations):
`syncIdempotencyKey(ref)` is the command idempotency key for any canonical
command proposed from that exact provider object version — shared across the
sync and webhook paths, so at-least-once redelivery can never double-apply;
`sourceCorrelationId(coordinate)` ties one provider object's whole lifecycle
into a single causal chain.

## Cursors & conflicts

**`SyncCursor`** is the resumable state of one stream — the (tenant, adapter,
system, object kind) tuple — carrying the provider's opaque continuation
token plus checkpoint metadata. Replay safety is two-layered:

1. **Positional** — restarting hands the provider the token, so nothing
   checkpointed is re-delivered;
2. **Idempotent** — anything that does come back no-ops through the
   SourceRef-derived command keys.

A cursor presented to the wrong stream is typed-rejected before any pull:
foreign tenant → `unauthorized` (A12); foreign adapter/system/object-kind →
`invariant-violation`. Checkpoints are monotonic — a cursor never rewinds
silently (`nextCursor`, the store, and the engine all enforce it).

**`Conflict`** is the explicit, auditable record created when the provider's
state and the canonical state diverge in incompatible ways (both sides moved
since the last synchronized point). It carries BOTH sides — the provider
`SourceRef` (version included) and the canonical `EntityRef` + aggregate
version at detection — and lands in the `detected` state. There is **no
destructive automatic resolution** (frozen anti-pattern for material
commercial state): resolution is an explicit command (`resolveConflict`)
that must cite at least one ledger event (`@office/events`) proving the
reconciliation; resolving twice identically is an idempotent replay, resolving
differently is a typed violation. Conflict ids derive deterministically from
both sides, so re-detection appends nothing new.

## Webhook normalization

Inbound provider pushes are verified, parsed, and normalized into one typed
envelope — `NormalizedWebhook` = (SourceRef, event kind, payload, receivedAt
from the injected clock, deterministic replay deduplication key). The
signature check is an injected **port** (`WebhookSignatureVerifier`): the
runtime injects the real verifier; the fake fixture injects the deterministic
test verifier. Order: JSON-exactness first, then signature verification, then
the strict `ProviderWebhookBody` shape parse — all fail-closed typed errors.

`applyWebhook` then resolves/records the mapping and asks the adapter's
`AdapterCommandTranslator` to propose the canonical command — the returned
`CommandEnvelope` goes to the Action Gateway; the webhook path derives the
command's causation id from the envelope's dedup key, so webhook and sync
converge on one command per provider object version.

## The fake-provider fixture

`createFakeProvider()` is a complete, deterministic, in-memory provider
implementing the Adapter contract and the translator port with strictly
generic vocabulary — adapter kind `fake-crm`, system `fake-instance-01`,
object kind `contact`, mapping into the landed canonical `organization`
commands (`organization.createOrganization` / `updateOrganization` /
`archiveOrganization`). Objects version monotonically (`v1`, `v2`, …),
deletions are tombstones, sync pages slice positionally after the cursor
token, and `emitWebhook` produces signed raw webhooks the matching
`createFakeWebhookVerifier()` accepts. No real provider names anywhere — the
OFF-021+ adapter packages own those.

## Running the tests

The package has no build step (source package, same convention as the merged
packages) and no test scripts of its own — the root vitest glob
(`packages/*/src/**/*.test.ts`) discovers it:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:architecture
```

The suite (13 files, 132 tests) mirrors the schedule-domain idioms:
deterministic everywhere (injected clocks, sequential office-issued id
suppliers, fixed tenants/instants), typed `Result` assertions, and a
boundary self-scan (`boundary.test.ts`) proving the dependency/import rules,
the provider-vocabulary ban, and the no-I/O rule. The marquee test is
`fake-provider.test.ts`: the fake provider's objects round-trip through the
adapter contract — sync out (snapshots + cursor advance), webhook in
(normalized envelope + SourceRef resolution), conflict detection (explicit
record with both sides), replay (idempotent no-op, no duplicate
mapping/command) — then the entire scenario is re-run with fresh stores and
identical injected inputs to prove byte-identical outcomes.

## What OFF-021+ implement

- **Provider adapter packages** (real names, real wire formats, real
  signature schemes): implement `Adapter` + `AdapterCommandTranslator`,
  declare their object-kind surfaces, and translate their provider's payloads
  into `ProviderSnapshot`s and `ProviderWebhookBody`s. The SDK and its
  engines, ports, and stores stay provider-neutral.
- **The adapter runtime** (apps/* layer): SQL implementations of the three
  store ports (mappings, cursors, conflicts — keyed by tenant, A12), the
  webhook dedup registry keyed by the deterministic dedup keys, the real
  `WebhookSignatureVerifier`s, the cron/worker wiring around `runSync`, and
  the execution of proposed `CommandEnvelope`s through the Action Gateway
  (which is also what advances the canonical versions the engines observe).
- **Outbound push** (later items): the canonical-ahead reconciliation branch
  deliberately proposes no command — pushing canonical state back out to a
  quiet provider belongs to the outbound sync work, not this SDK.
