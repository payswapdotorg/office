# @office/domain-documents

Documents & evidence domain module for PaySwap Office (**OFF-008**) — the
canonical project-scoped **Document aggregate** of the frozen enterprise graph
(freeze A1/A12) with **immutable, create-only revisions** chained by explicit
supersession, **immutable evidence references** that pin (entity, document,
revision), and a **provider-neutral, content-addressed object-storage port**.
Every consequential mutation is guarded by deny-by-default authorization,
optimistic concurrency, and an audit event.

This package is **pure domain**: aggregates, commands, and ports only — no SQL,
no migrations, no repository layer (the persistence/app layers implement the
`DocumentsStore` and `ObjectStorage` ports transactionally later). Runtime
dependencies are exactly `@office/contracts`, `@office/domain-kernel`,
`@office/authz`, and `@office/persistence` (the `SqlExecutor` **type** of the
`EventSink` port only) — no external dependencies, and `@office/events` is
deliberately NOT imported (the `EventSink` port below is the seam the event
ledger implements). No domain-to-domain imports: the identity modules
(OFF-007) are mirrored in *shape*, never imported.

`src/index.ts` is the whole public surface; import only from the package root
(`@office/domain-documents`). Anything not re-exported there is
package-internal and may change without notice.

## The model in one paragraph

A `Document` (project-scoped, `active` → `archived` one-way lifecycle) owns a
chain of `DocumentRevision` rows. Revisions are **rows of record**: created
once, never updated, never deleted — a successor revision carries a *forward*
`supersedes` link naming the revision it replaces, so superseding R1 with R2
appends R2 and moves the document's head pointer while R1's row (content
hash, storage key, bytes) stays byte-identical forever; the full history is
readable oldest-first. An `EvidenceReference` pins one entity (a task, an
issue, a change order, …) to **one specific revision** — never "the document"
— and is create-only: the natural key (entity, document, revision) makes a
re-pin a typed conflict, and no API repoints or edits a committed reference.
Revision content travels in commands as canonical base64; the handler decodes
it, hashes it with the **injected** hash supplier, and addresses the blob by
`doc/<tenant>/<project>/<hash>` — same content under the same scope always
addresses the same blob (dedupe), different content under the same key is a
typed integrity violation, never an overwrite.

## What is here

| Area | Exports |
| --- | --- |
| State | `DocumentState`, `DocumentStatus`, `DOCUMENT_STATUSES`, `DOCUMENT_KIND`, `DOCUMENT_INVARIANTS`, `NewDocument`, `DocumentRevisionState`, `REVISION_KIND`, `REVISION_INVARIANTS`, `NewDocumentRevision`, `EvidenceReferenceState`, `EVIDENCE_REFERENCE_KIND`, `EVIDENCE_REFERENCE_INVARIANTS`, `NewEvidenceReference`, `createDocumentState`, `archiveDocumentState`, `attachRevisionState`, `supersedeRevisionState`, `createDocumentRevisionState`, `createEvidenceReferenceState` |
| Storage port | `ObjectStorage`, `InMemoryObjectStorage`, `InMemoryStoredObject`, `createInMemoryObjectStorage`, `failingObjectStorage`, `RevisionHash`, `StorageKey`, `StorageKeyParts`, `REVISION_HASH_GRAMMAR`, `STORAGE_KEY_GRAMMAR`, `parseRevisionHash`, `isRevisionHash`, `parseStorageKey`, `isStorageKey`, `formatStorageKey`, `storageKeyParts`, `CONTENT_BASE64_RULE`/`GRAMMAR`, `decodeBase64`, `contentAddressMismatch`, `objectNotFound` |
| Events | `EventSink`, `InMemoryEventSink`, `RecordedEventAppend`, `createInMemoryEventSink`, `failingEventSink`, `eventSinkFailure`, `DOCUMENT_REGISTERED_EVENT`, `DOCUMENT_ARCHIVED_EVENT`, `REVISION_ATTACHED_EVENT`, `REVISION_SUPERSEDED_EVENT`, `EVIDENCE_REFERENCED_EVENT`, `documentsEventEnvelope`, `entityRefOf` (+ payload types) |
| Store port | `DocumentsStore`, `DocumentsUnitOfWork`, `InMemoryDocumentsStore`, `InMemoryStoreCounters`, `createInMemoryDocumentsStore` |
| Commands | `DocumentsCommands`, `createDocumentsCommands`, `DocumentsCommandDeps`, `DocumentsCommandAuthorization`, `RevisionMutationResult`, `REGISTER_DOCUMENT_COMMAND`, `ARCHIVE_DOCUMENT_COMMAND`, `ATTACH_REVISION_COMMAND`, `SUPERSEDE_REVISION_COMMAND`, `REFERENCE_EVIDENCE_COMMAND` (+ payload types and their fail-closed parsers) |

## The mutation path (per command)

1. **Parse** the payload fail-closed (strict keys, branded ids, typed
   versions, canonical base64) — a malformed payload is a typed
   `invariant-violation`, never a silent default.
2. **Authorize** with the caller-supplied `Policy` through `@office/authz`'s
   deny-by-default `authorize()`. The resource is addressed within the
   COMMAND's tenant and the payload's project: a project-scoped command
   addressing another project is denied structurally before any unit opens,
   and a cross-tenant attempt passes authorization only to vanish as a typed
   `not-found` inside the store (freeze A12 invisibility — no existence
   oracle). A denied command never opens a unit of work.
3. **Deduplicate** through the kernel's `withIdempotency` over the injected
   `IdempotencyRegistry`: replaying the same command with the same
   idempotency key is a no-op replay of the recorded outcome; the same key on
   a different command is a typed idempotency-conflict.
4. **Load** inside ONE store unit of work through scope-guarded reads (a
   foreign tenant's/project's row is a typed `not-found`), verify the claimed
   project, re-check scope coverage (kernel A12 backstop), and check
   optimistic concurrency — a stale `expectedVersion` is a typed
   `concurrency-conflict`; state is never silently overwritten.
5. **Mutate** through the invariant-checked pure transitions: revisions are
   created ONLY (attach the root, or append a successor that explicitly
   supersedes the current head); evidence references are created ONLY.
6. **Blob + writes + event atomically**: the content-addressed blob is put
   through the `ObjectStorage` port, the document/revision/evidence rows are
   staged, and the audit event is appended through the injected `EventSink`
   — all inside the SAME unit; a failure anywhere rolls every staged mutation
   back. An orphaned blob after a late failure is accepted by design:
   content-addressed keys are idempotent to re-put and reference no aggregate
   until the revision row commits.

Determinism (kernel rule): handlers read no wall clock and no randomness —
`now`, the canonical-id opaque parts, and the content hash come from the
injected suppliers (`DocumentsCommandDeps`), and canonical ids are composed
through `formatEntityId`, so every issued id parses with `parseEntityId` by
construction.

## The ObjectStorage port contract

```ts
interface ObjectStorage {
  put(key: StorageKey, content: Uint8Array): Promise<Result<true, DomainError>>;
  get(key: StorageKey): Promise<Result<Uint8Array, DomainError>>;
  check(key: StorageKey): Promise<Result<boolean, DomainError>>;
}
```

- **Provider-neutral by freeze A5/A6**: no provider vocabulary, no provider
  semantics — real object-storage adapters are owned by the app/adapter
  layers and implement this port; this package ships only the deterministic
  in-memory fake (`createInMemoryObjectStorage`) and the typed
  `failingObjectStorage` for failure paths.
- **Content addressing makes the contract sharp**: a key addresses exactly
  one byte sequence. `put` is idempotent for identical content (dedupe by
  key is allowed) and returns a typed `invariant-violation`
  (`content-address-mismatch`) for different content under the same key —
  never an overwrite. `get` returns the bytes or a typed `not-found`;
  `check` reports existence without reading.
- A `StorageKey` is exactly `doc/<canonical tenant id>/<canonical project
  id>/<content hash>` (parseable and composable through `parseStorageKey` /
  `formatStorageKey`); a `RevisionHash` is a lowercase hex digest produced by
  the **injected** hash supplier — no hashing algorithm is baked into the
  domain.

## The EventSink port contract

```ts
interface EventSink {
  appendEvents(
    executor: SqlExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}
```

- Mirrored **byte-for-byte in shape** from the identity domain packages of
  OFF-007 (`@office/domain-organization`, `@office/domain-projects`), so any
  transactional implementation satisfies all of them structurally — the port
  is the seam, the two domain packages stay independent (no domain-to-domain
  imports).
- `executor` is the **open unit of work** of the surrounding mutation — a
  real implementation (the OFF-005 event ledger, wired by the runtime)
  writes its ledger rows with it, so event persistence is atomic with the
  state change that produced it.
- A failure result **must abort** the mutation: handlers roll the unit back,
  so a partially-applied mutation can never commit.
- The package ships `createInMemoryEventSink()` (records appends for
  deterministic tests) and `failingEventSink(reason)` (typed failures for
  rollback tests and wiring guards).

Every documents event is a `DomainEventEnvelope` built by
`documentsEventEnvelope` (self-checked through the contracts parser): event
name, the owning document's **project** scope, actor and
correlation/causation propagated from the command envelope (the event's
causation id is the command's idempotency key — the OFF-005 ledger
convention), `source: 'domain'`, `occurredAt` from the injected clock, and
before/after `EntityRef`s per transition kind (creation events: before
`null`; supersession: before = superseded, after = successor; lifecycle:
before = after = the aggregate).

## Immutability, and how it is enforced

- **Revisions**: there is no mutating API at all — `DocumentRevisionState`
  is a readonly record whose `version` is pinned to the initial aggregate
  version by the `revision-version-is-create-only-initial` invariant; the
  store exposes `insertRevision` only (a duplicate canonical id is a typed
  `revision-id-already-exists` conflict). Re-attaching an existing revision
  id with different content therefore fails typed at two independent layers
  (duplicate row id; content-address mismatch in the storage port).
- **Evidence references**: same structure — `insertEvidenceReference` only,
  with the natural-key guard `evidence-reference-already-exists` making a
  re-pin of the same (entity, document, revision) triple a typed conflict.
  A different entity may pin the same revision, and the same entity may pin
  a different revision; a committed pin can never be repointed or edited.
- **No deletes anywhere**: the only lifecycle transition is the explicit,
  auditable, one-way `active` → `archived` archive of the document
  aggregate; the revision rows and evidence pins survive it untouched
  (evidence is history, freeze A4).

## Running the tests

From the repo root (the workspace globs cover `packages/domain/*`):

```bash
pnpm test                                # all packages, including this one
pnpm vitest run packages/domain/documents   # just this package
```

All suites (`state`, `storage`, `events`, `store`, `commands`) are pure unit
tests: deterministic injected suppliers (fixed clock, fixed id/hash
sequences), in-memory ports, no I/O, no database, no environment variables.
They prove the acceptance properties end-to-end: the R1→R2→R3 supersession
chain with full-history reads and R1 byte-identical after supersession;
revision and evidence immutability as typed conflicts; deny-by-default
authorization including cross-tenant invisibility and cross-project denial;
optimistic concurrency with unchanged state; idempotent replay; audit events
with correct scope/actor/causation; and write + event-append atomicity
(rollback on sink or storage failure).

## Downstream consumers

- **OFF-012 (contracts & change orders)**: pins change-order entities to
  specific document revisions through `referenceEvidence` (the
  `EvidenceReferenceState` natural key is the audit trail of what a change
  order pointed at, forever).
- **OFF-013 (relationships)**: consumes `DocumentState` / revision ids as
  entity endpoints of the enterprise graph, and the project scope of every
  row for A12-guarded traversal.
- **OFF-016 (workflows)**: attaches workflow artifacts as immutable
  revisions (`attachRevision` / `supersedeRevision`) and reads full histories
  through `revisionChainOf` — approvals never mutate history, they append.
- Later adapters (OFF-021/022) implement the `ObjectStorage` port against
  real object storage and the `DocumentsStore` / `EventSink` ports
  transactionally against PostgreSQL + the OFF-005 ledger; the runtime wires
  the wall clock, crypto hashing, and id randomness through
  `DocumentsCommandDeps`.
