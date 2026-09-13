# @office/marketplace

The Office marketplace catalog and lifecycle engine (OFF-027): tenant-scoped
publisher registration and revocation, immutable app releases pinned to
validated `AppManifest`s, the queryable catalog, explicit revocable tenant
entitlements, installation metadata linkage onto app-runtime
`AppInstallation` identities, staged updates with the A9 permission-delta
review (added capabilities require fresh grant confirmation), rollback,
uninstall severance — and the typed audit ledger every lifecycle transition
lands in, with the canonical project state provably untouched (A11).

The marketplace is **metadata, never project truth** (freeze A11): it never
mutates canonical project state, never issues canonical events, never
constructs or invokes the action gateway or the app runtime (A7/A8), and
never executes app code — app manifests are DATA. Every tenant-scoped
operation and query carries the acting tenant and is typed-rejected
cross-tenant in both directions (A12). The vocabulary is deliberately
generic (`publisher-01`-style fixtures; no vendor/provider names).

## Boundary

Depends on exactly five workspace packages and nothing external:

| dependency | consumed as | what it provides here |
| --- | --- | --- |
| `@office/app-sdk` | value | `AppManifest` validation (`reviewAppManifest`/`validateAppManifest` against an injected `ActionDescriptorSource`), permission specs, version ranges, `AppCatalogSource`, semver ordering |
| `@office/app-runtime` | TYPE-ONLY (logic) | the `AppInstallation`/`AppLifecycleState` record surface the marketplace LINKS to — the marketplace never constructs or executes the runtime |
| `@office/contracts` | value | ids, actor, timestamps, the fail-closed parse plumbing |
| `@office/domain-kernel` | value | `Result`/`DomainError` |
| `@office/authz` | value | the closed capability vocabulary the fresh-grant confirmations validate against |

The boundary is self-gated in `src/boundary.test.ts` (mirroring
app-runtime's self-gate): exact dependency set, import scan, type-only
app-runtime consumption in the logic, no domain/intelligence/sync/adapters/
agents/client-sync/events/workflows/persistence/actions imports, no SQL or
store vocabulary, no gateway/runtime construction, no provider/vendor
vocabulary, no wall clock, no randomness. The one sanctioned host-side value
consumer of app-runtime is `src/test-support.ts`, which builds fixture
installation records through the runtime's own trusted builders (the host
side of the linkage — the marketplace's logic only ever sees the typed
records).

## Public surface

Everything is exported through `src/index.ts` (the whole public surface;
deeper paths are package-internal):

| module | exports |
| --- | --- |
| `identity` | `PublisherId`/`ReleaseId`/`EntitlementId`/`InstallationLinkId`/`UpdateId`/`AuditRecordId` (+ parse/is/format, grammars) and the deterministic derivations `publisherIdOf`/`releaseIdOf`/`entitlementIdOf`/`installationLinkIdOf`/`updateIdOf`/`auditRecordIdOf` |
| `audit` | `MarketplaceTransition` (+ `MARKETPLACE_TRANSITIONS`), `MarketplaceAuditDetail`, `MarketplaceAuditRecord`, `marketplaceAuditRecord`, `auditRecordToJson`, `EMPTY_AUDIT_DETAIL`, the `MarketplaceAuditSink` port, `createInMemoryMarketplaceAuditSink`, `failingMarketplaceAuditSink`, `auditSinkFailure` |
| `canonical-state` | `CanonicalStateSnapshot`, `CanonicalStatePort` (the A11 probe) |
| `publisher` | `Publisher`, `PublisherState` (+parse/is, grammars), `registerPublisher`, `revokePublisher`, `isPublisherActive`, `mayPublishApp` |
| `release` | `AppRelease` (+parse/is, grammar), `publishReleaseRecord` |
| `catalog` | `CatalogEntry`, `EntitledCatalogEntry`, `catalogSnapshotOf`, `catalogEntryOf`, `catalogSourceOf`, `entitledCatalogOf`, `coveringEntitlements` |
| `entitlement` | `Entitlement`, `EntitlementState` (+parse/is, grammars), `grantEntitlement`, `revokeEntitlement`, `entitlesRelease`, `versionRangeKey` |
| `installation-link` | `InstallationLink`, `InstallationLinkState`, `UNLINKABLE_RUNTIME_STATES` (+parse/is, grammars), `linkInstallation`, `moveInstallationLink`, `unlinkInstallation`, `parseRuntimeLifecycleSnapshot` |
| `update` | `PermissionDelta`, `permissionDeltaOf`, `addsCapability`, `PermissionConfirmation` (+parse/is), `confirmationsCover`, `InstallationUpdate`, `UpdateState` (+parse/is, grammars), `stageInstallationUpdate`, `applyStagedUpdate`, `rollBackAppliedUpdate`, `permissionSummary`, `confirmationSummary` |
| `store` | the five record-store ports + `InMemoryMarketplaceStore`, `createInMemoryMarketplaceStore` |
| `engine` | `Marketplace`, `MarketplaceDeps`, `AppliedUpdate`, `createMarketplace` (THE composed engine) |

## The lifecycle and audit discipline

`createMarketplace(deps)` wires the record modules over an injected store
(defaults to the deterministic in-memory reference), an injected
`ActionDescriptorSource`, THE injected audit sink, an injected clock, and
the canonical-state observation port. Every mutating operation runs its
typed gates, **appends the audit record BEFORE any state commits** (a
failing append aborts the operation with no committed effect), and only then
commits.

```
registerPublisher ──► publishRelease ──► grantEntitlement ──► linkInstallation
      │                    │                    │                   │
      │ (revocation        │ (immutable         │ (revocation       │ stageUpdate
      │  stops new         │  once published)   │  stops installs)  │  (permission delta)
      │  releases)         │                    │                   ▼
      │                    │                    │            applyUpdate ──► rollbackUpdate
      │                    │                    │            (fresh grant      (explicit typed
      │                    │                    │             confirmations     command; releases
      │                    │                    │             for ADDED specs)   never mutate)
      ▼                    ▼                    ▼                   ▼
 publisher-revoked    release-published   entitlement-revoked   recordUninstall
                                                                (severs the linkage)
```

Every transition — `publisher-registered`, `publisher-revoked`,
`release-published`, `entitlement-granted`, `entitlement-revoked`,
`installation-linked`, `update-staged`, `update-applied`,
`update-rolled-back`, `installation-unlinked` — lands in the audit ledger as
a typed `MarketplaceAuditRecord` with the full provenance (WHO: the acting
actor; WHAT: the transition + the closed JSON-safe detail; WHEN: an instant
from the injected clock) and a deterministic derived record id, so re-running
the same scenario reproduces a byte-identical ledger.

**THE acceptance** (`src/lifecycle.test.ts`): the golden scenario drives
publish → entitle → install-link → update (permission delta requiring
review) → rollback → uninstall → publisher revoke through the composed
engine; every transition lands in the audit ledger with typed provenance;
the canonical-state fingerprint is compared before and after **every**
marketplace operation and never moves (a control test mutates the canonical
world directly and proves the comparison is meaningful); and two independent
engines driven through the same sequence produce byte-identical audit
ledgers.

The A9 update discipline (`src/update.ts` + engine gates): the delta is
keyed on `(capability, scopeKind)` — same key in both manifests is unchanged
(a declaration-version bump does not add capability), keys only in the target
are ADDED, keys only in the current release are REMOVED. Added-capability
updates are staged records, never silent swaps, and apply only with exactly
one fresh grant confirmation per ADDED spec (`confirmation-required`,
`unexpected-confirmation`, `duplicate-confirmation` are the typed
rejections); unchanged-capability updates apply without confirmation.
Rollback is an explicit typed command moving the link's pin back to the
from-release — the release records themselves are immutable.

## What OFF-035/OFF-038 consume

- **OFF-035 (system-coverage analysis)**: the full public surface above —
  the marketplace's own record vocabulary (publishers, releases,
  entitlements, links, updates, audit records) and the `Marketplace` engine
  surface (lifecycle operations + the deterministic projections) are the
  catalog/lifecycle quarter of the coverage model.
- **OFF-038 (release gates)**: the `MarketplaceDeps` port shape (audit sink,
  canonical-state port, injected clock, action-descriptor source), the
  `MarketplaceAuditSink` port and `MarketplaceAuditRecord` contract (every
  lifecycle transition is auditable with typed provenance), the A11
  zero-canonical-mutation discipline, and the boundary self-gate as the
  pattern for per-package release gates.

## Running the tests

From the repository root (`pnpm test` runs every package; the marketplace
suite is deterministic — injected clock/id suppliers, fixed fixture epoch,
no network, no I/O beyond filesystem reads in the boundary self-gate):

| file | covers |
| --- | --- |
| `src/identity.test.ts` | the branded id vocabulary + the deterministic derivations (22 tests) |
| `src/publisher.test.ts` | publisher registration/revocation, the declared app set (8 tests) |
| `src/release.test.ts` | releases pin validated manifests; immutability (6 tests) |
| `src/catalog.test.ts` | the catalog/entitled projections, the `AppCatalogSource` port (7 tests) |
| `src/entitlement.test.ts` | entitlement grant/revoke, range coverage (11 tests) |
| `src/installation-link.test.ts` | linkage composition, the moving pin, terminal severance (9 tests) |
| `src/update.test.ts` | the permission delta, the fresh-grant confirmations, the staged/applied/rolled-back lifecycle (15 tests) |
| `src/engine.test.ts` | the composed engine: A12 both directions, revocation gates, update discipline, append-then-commit (18 tests) |
| `src/lifecycle.test.ts` | THE golden scenario + the A11 zero-mutation proof + run-twice determinism (5 tests) |
| `src/boundary.test.ts` | the package boundary self-gate (13 tests) |
