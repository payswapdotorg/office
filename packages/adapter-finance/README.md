# @office/adapter-finance

The ERP/finance adapter contract (OFF-024): the generic enterprise-resource-
planning / accounting Adapter over the `@office/adapters-sdk` contract —
**financial reference mapping** (provider account/cost-code/commitment/
invoice/payment ids → canonical `EntityId`s, provider ids never primary keys),
**typed reconciliation interfaces** (per-reference balance comparisons with
typed discrepancy kinds carrying both sides), and **THE source-version-mapped,
non-duplicating financial synchronization** (the same provider object version
never proposes a canonical command twice, whatever path it arrives through —
sync page, webhook redelivery, intra-page duplicate, or cursor restart — and
every duplicate attempt is counted and typed-deduplicated), with the **explicit
conflict discipline** for material commercial state: no auto-resolution, ever.

Generic vocabulary only (adapter kind `erp-finance`, fixture system
`erp-instance-01`, object kinds `account` / `cost-code` / `commitment` /
`invoice` / `payment`): every provider-specific shape lives INSIDE this
package; swapping in a concrete vendor integration means a sibling package
owning the real wire formats over the SAME SDK contract. Ports only — no I/O,
no SQL, no clock, no randomness. The package imports exactly three workspace
dependencies: `@office/adapters-sdk`, `@office/contracts`, and
`@office/domain-kernel` (the canonical cost domain is **not** imported —
reconciliation works on typed summaries + SourceRef mappings).

## Public surface

`src/index.ts` is the package's whole public surface; anything not re-exported
there is package-internal.

| area | exports |
| --- | --- |
| vocabulary | `FINANCE_ADAPTER_KIND`, `FINANCE_SYSTEM_ID`, the five object-kind constants, `FINANCE_OBJECT_KINDS`, `FINANCE_OBJECT_MAPPINGS`, `FINANCE_CAPABILITIES`, `FINANCE_CAPABILITY_NAMES`, `financeObjectMappingOf` |
| provider fixture | `createErpProviderStore` (+ the `Erp*Object` / `ErpProviderStore` types) |
| snapshot translation | `financeSnapshotOf`, `financeObjectViewOf` |
| reference mapping + translation | `resolveFinanceReference`, `bindFinanceReference`, `createFinanceTranslator`, the per-kind `parse*ProviderData` fail-closed parsers |
| adapter | `createFinanceAdapter` |
| sync (THE acceptance) | `runFinanceSync`, `createVersionMappedSyncAdapter`, `createInMemoryProviderVersionLedger`, `MAX_SYNC_PAGES_PER_STREAM`, the report/count/duplicate types |
| reconciliation | `reconcileFinanceBalances` (+ the fact/discrepancy/comparison/report types) |
| conflict discipline | `detectedAmountMismatchConflict`, `detectedConcurrentEditConflict`, `detectedReferenceRemapConflict`, `amountMismatchConflictsOf`, `createInMemoryFinancialConflictStore`, `resolveFinancialConflict`, the fail-closed parsers + guards |
| webhook ingest | `ingestErpWebhook`, `translateErpWebhookBody`, the signature/checksum conventions + verifiers, the header constants |

## The Adapter implementation

`createFinanceAdapter({ store })` builds the Adapter over one injected ERP
provider store (the deterministic fixture, or a real ERP client's read
surface): the five declared object-kind capabilities (validated through the
SDK's fail-closed parser so table and declaration can never drift), typed
lifecycle transitions (connect/healthCheck/disconnect — an unknown or
disconnected connection is a typed `not-found`, the health surface observes
the provider's degraded mode), and the positional replay-safe sync paging
(the continuation token is the position AFTER the last delivered item, so a
cursor restart re-delivers nothing before the checkpoint).

## The financial reference mappings (the A10 discipline)

The object mapping table is the package's heart — for each provider object
kind, the canonical entity kind it translates into, the authz capability the
sync authorizes through (`cost.write`), and the LANDED canonical command
names proposed per change kind:

| provider kind | canonical kind | created | updated | deleted |
| --- | --- | --- | --- | --- |
| account | budget | `cost.createBudget` | `cost.reviseBudget` | fail closed |
| cost-code | cost-item | `cost.recordCostItem` | fail closed | fail closed |
| commitment | commitment | `cost.createCommitment` | `cost.amendCommitment` | `cost.closeCommitment` |
| invoice | invoice | `cost.recordInvoice` | fail closed | fail closed |
| payment | payment-reference | `cost.referencePayment` | fail closed | fail closed |

The four families of fail-closed gaps are the documented discipline, not
missing work: canonical cost items are append-only budget lines with unique
codes, canonical invoice amounts are immutable at record time (revisions flow
through new invoices — the credit-note discipline), payment references are
append-only, and budgets keep their revision history. The adapter NEVER
invents canonical semantics — an unmapped provider transition is the typed
`provider-transition-unmapped` failure.

Identity references inside provider payloads (project, budget, cost item,
commitment, invoice) are the OFFICE-ISSUED ids the ERP learned when its
finance workspace was provisioned from office — parsed fail-closed as
canonical ids, never manufactured out of provider object ids. The canonical
aggregate id of the translated object itself always comes from the engine's
mapping record (office-issued through the injected supplier). A REMAPPING
attempt (a bound coordinate re-pointed at a different canonical id) is the
mapping store's typed collision — an explicit conflict, never an overwrite.

## THE non-duplication + version-mapping acceptance

`runFinanceSync` layers the SDK's `runSync` (authorization, capability
checks, fail-closed snapshot parsing, stream-consistency guards, mapping
bookkeeping, the conflict branches, cursor checkpoints) under one new seam the
financial acceptance requires: the **provider version ledger** — the
source-version mapping recording, per (tenant, provider coordinate, provider
version), whether a canonical command was proposed from that EXACT version
(carrying the command's idempotency key, which the SDK derives from the
SourceRef + version) and how many times that version was observed. The ledger
is written by BOTH intake paths (sync and webhook), so the two converge on
exactly one proposal per source version.

Replay safety is three-layered, by design:

1. **positional** — the adapter's continuation tokens resume after the
   checkpointed items: a cursor restart re-delivers nothing;
2. **version-mapped** — even when a version DOES come back (at-least-once
   redelivery, an older cursor, an intra-page duplicate), the ledger turns it
   into a counted typed no-op: no second proposal, ever;
3. **idempotent keys** — every proposal carries the SDK's SourceRef-derived
   idempotency key (shared with the webhook path), so the command layer
   converges even across engine boundaries.

The end-to-end proof lives in `src/finance-flow.test.ts`: the same invoice
version arrives through a first sync, a full re-sync, AND a duplicate webhook
delivery → exactly ONE canonical proposal exists across all paths (counted),
its ledger entry counting every observation; a version bump proposes exactly
one update, and its re-delivery through both paths deduplicates; the mapping
table resolves the same canonical ids across re-syncs; a cursor restart
re-processes nothing into commands; and the whole scenario is deterministic
(run-twice → identical reports, commands, conflicts, and reconciliations).

## Reconciliation + the explicit conflict discipline

`reconcileFinanceBalances` is the pure, deterministic comparison surface
between the provider's financial state and the canonical state: it joins two
TYPED summaries — the provider's per-reference balance facts (observed at a
source version) and the canonical per-reference balance facts (entity +
recorded amount + last-synchronized source) — on the source coordinate, and
projects per-reference balance comparisons plus the closed discrepancy
vocabulary, each record carrying BOTH sides (present or absent) and the
SourceRefs:

| discrepancy kind | meaning |
| --- | --- |
| `missing-canonical` | the provider reports a reference with no canonical record bound |
| `missing-provider` | a mapped canonical record the provider no longer reports |
| `amount-mismatch` | both sides present, the provider amount differs from the canonical recorded amount |
| `version-divergence` | equal amounts, the provider version moved past the synchronized version |

Financial state is MATERIAL commercial state: an amount mismatch (or a
concurrent edit, or a reference remap attempt) becomes an explicit
`FinancialConflict` record carrying BOTH sides — the full SourceRef including
the provider version plus the disputed amount, and the office entity, its
aggregate version, and its recorded amount. Conflict ids are derived
deterministically from both sides (amounts included): re-detection is
idempotent, a moved side is a NEW divergence pair. Detection NEVER resolves
anything (structurally: the only composition site of the `resolved` state is
`resolveFinancialConflict`); resolution is an EXPLICIT typed command requiring
a closed strategy plus the idempotency keys of the canonical commands that
performed the reconciliation — at least one, no duplicates. Resolving an
already-resolved conflict identically is an idempotent replay; resolving it
differently is a typed invariant-violation. There is no other resolution
path, and no last-write-wins anywhere.

## Sync + webhook semantics

`runFinanceSync` syncs every requested object-kind stream (default: the
finance family order — accounts → cost codes → commitments → invoices →
payments, so parent mappings exist before children reference them) paged to
exhaustion, resuming from each stream's persisted cursor, with a per-stream
page bound against stuck providers. The report carries per-stream outcomes,
the proposed commands, the conflicts, the counted duplicate observations, and
the summary counts (proposals, mapped-created, applied updates/deletions,
duplicates deduplicated, replay no-ops, canonical-ahead, conflicts, orphan
deletions skipped).

`ingestErpWebhook` is what comes BACK from the ERP: the provider pushes
events in its own wire format (`{ kind: 'erp-webhook-event', eventType:
'<object-kind>.<created|updated|deleted>', objectId, revisionTag, occurredAt,
payload }`), signed with the provider's signature header. The intake pipeline
is JSON-exactness → the provider signature over the WIRE body → fail-closed
translation into the SDK's provider-neutral body → THE source-version dedup
(a version the ledger already proposed from — sync path OR earlier webhook —
is a counted typed no-op, and the SDK engine never runs) → the divergence
pre-check (both sides moved → an explicit conflict record, no command) → the
SDK's `applyWebhook` intake → the ledger observation of the proposal
(cross-path closure).

## The provider fixture

`createErpProviderStore()` builds the deterministic in-memory ERP provider
(generic vocabulary only): chart-of-accounts/project cost accounts, job-
costing cost codes, commercial commitments (purchase orders and subcontracts)
with append-only lines, invoices with revision history, and payments —
per-object monotonic versions on every mutation (tombstones included), a
degrade/recover dial for the health surface, and webhook emission in the
provider's wire format with the deterministic signature convention. No clock,
no randomness: the same mutation sequence, same versions, same pushes.

## How tests run

The package's tests live beside the sources (`src/*.test.ts`) and run as part
of the workspace suite:

```
pnpm test                                     # all workspace tests (vitest run)
npx vitest run packages/adapter-finance      # just this package's suite
pnpm test:architecture                        # the workspace architecture gate
```

Coverage: `vocabulary.test.ts` (the closed vocabularies + the mapping table),
`mapping.test.ts` (every translator branch, strict payload parses, the A10
identity discipline, the reference mapping bind/resolve/remap-rejection),
`adapter.test.ts` (lifecycle + positional paging + token validation +
tombstones), `sync.test.ts` (THE non-duplication through the driver: same
version twice, version bumps, the mapping-table determinism, the cursor
restart, intra-page duplicates, divergence conflicts, page bounds),
`reconciliation.test.ts` (the pure projection: determinism, order
independence, every discrepancy kind with both sides, fail-closed inputs),
`conflict-discipline.test.ts` (THE explicit conflict discipline: both sides,
derived ids, idempotent appends, the structural no-auto-resolution proof, the
explicit resolution path), `webhook-ingest.test.ts` (the wire translation,
the signature/checksum conventions, THE duplicate-delivery no-op, the
divergence pre-check, the cross-path convergence), `finance-flow.test.ts`
(**THE named acceptance**, end to end + run-twice determinism), and
`boundary.test.ts` (the package boundary self-gate: exact three workspace
dependencies, forbidden imports, the vendor-vocabulary scan, pure ports,
determinism scans).

## What OFF-037 consumes

The integration fabric consumes this package through its root entry point:
`createFinanceAdapter` (+ the `ErpProviderStore` port to wire the real ERP
client's read surface into), `createFinanceTranslator`, `runFinanceSync`
(with the SDK's `SyncEngineDeps` — mappings/cursors/conflicts stores,
`canonicalVersionOf`, injected clock and office-issued id supplier — plus the
`ProviderVersionLedger` port the non-duplication acceptance requires), the
reference layer (`resolveFinanceReference` / `bindFinanceReference` over the
shared tenant-scoped mapping store), the reconciliation surface
(`reconcileFinanceBalances` over the typed summaries the runtime composes
from the canonical state it owns), the conflict discipline
(`amountMismatchConflictsOf` / `detected*Conflict` /
`resolveFinancialConflict` — the explicit typed records the runtime resolves
through canonical commands, never automatically), and the webhook intake
(`ingestErpWebhook` + the verifier ports the runtime wires to the real
provider's signature scheme). The deterministic fixture
(`createErpProviderStore`) is the harness for the fabric's own contract
tests.
