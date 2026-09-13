# @office/field-client

The PaySwap Office **field/offline web client** (OFF-031): the
offline-capable field experience as a typed, deterministic **view-model
layer** over `@office/client-sync`'s offline engine — **capture on a
disconnected network → reconnect → synchronize (exactly-once drain) → show
conflict state**, all through public package surfaces, in memory, with
**zero direct database access**.

Pure TypeScript: **no UI framework, no DOM, no rendering, no service
workers** — the offline ENGINE is `@office/client-sync` (SyncEngine,
LocalQueue, drain, conflict records, resolution commands); this app
composes it, deterministically, in memory. The host (and the OFF-032
desktop shell) wires rendering and the real transport later.

## Purpose

Freeze A11 + the offline-conflict freeze decision
(`docs/architecture/ARCHITECTURE_FREEZE.md`): the field client is a VIEW of
ONE project state — never a second source of truth — and material
synchronization conflicts are resolved by **EXPLICIT resolution, never
silent last-write-wins**. This package is that discipline's typed client:

- **Field session plane** — ONE typed field-session record
  (`createFieldSession`: tenant, project, field actor, deny-by-default
  policy, closed capability set) that every surface resolves through
  (freeze A12). `seedFieldWorld` composes the deterministic SEEDED FIELD
  WORLD — the landed organization/projects/field domain packages' reference
  engines wired through their own public command surfaces, plus the SHARED
  server-side sync parts (`@office/sync` + `@office/client-sync`: the
  ledger-shaped slice source, the subscription broker, the operation
  registry, the applied-operation journal, the conflict log, the sync audit
  sink). `openFieldDataPlane` wires ONE client's offline data plane over
  those shared parts: the A9 grant + subscription, the SyncEngine, and the
  typed command path (the world's own generic dispatch). Two planes over
  ONE world is the field-client/office-twin convergence composition.
- **Offline capture surfaces** — `captureFieldObservation`
  (`field.captureFieldEvent`, protection **open**),
  `captureEvidenceAttachment` (`field.attachFieldEventEvidence`,
  protection **protected** — evidence links feed contractual change claims),
  and `captureIssueResolution` (`field.resolveIssue`, protection **open**)
  are typed bindings over the session's data plane: canonical ids are
  parsed fail-closed, the mutation lands in `@office/client-sync`'s bounded
  LocalQueue with a client-generated deterministic operation id (the A8
  idempotency key) and the domain-declared protection class, and every
  outcome is a typed, displayable `CaptureOutcomeView` — rejections are view
  models (`RejectionView`), **never throws**. `offlineQueueView` projects
  the queue's displayable state (pending count, entries, protection
  classes); `submitEvidenceAttachment` / `submitIssueResolution` are the
  connected twins (the office-side session's mutations).
- **Reconnect + synchronize surface** — `synchronize` drives the engine's
  reconnect: catchup from the client's LAST CONFIRMED cursor (exactly once,
  no duplicates, no gaps) + the queue's EXACTLY-ONCE drain (authorize →
  register → divergence check → clean-apply or the explicit conflict path)
  + the consumption of the client's own replayed effects. The report
  becomes the displayable `SyncReportView` (applied/rejected/conflicted/
  superseded counts, the catchup window, remaining pending, the
  post-synchronize cursor); `syncStatusView` shows the cursor/token state
  at every step; `disconnect` is the connection lifecycle.
- **Conflict state surface (THE acceptance core)** — `conflictStateView`
  projects every surfaced conflict as a displayable `ConflictView` carrying
  BOTH SIDES (operation ids, actors, causal positions, payload digests, the
  contested target) + PROVENANCE (where, when, by whom detected) + the
  domain-declared protection class + the deterministic `ConflictDisposition`:
  a **PROTECTED** conflict shows the no-auto-resolution state whose ONLY
  exit is `resolveProtectedConflict` — the TYPED EXPLICIT RESOLUTION
  COMMAND surfaced as a USER ACTION (strategy + audit evidence + the
  RECONCILED evidence attachment at the field event's CURRENT version);
  an **OPEN** conflict shows the deterministic supersession outcome (the
  committed server side stands, recorded + audited, never silent).
- **Field board read surface** — `fieldBoardView` folds the session's OWN
  consumed event stream through the field domain's public read model
  (`createProjectReadModel`): the project header + recent observations +
  open issues — exactly what the session has consumed, so after a
  reconnect + synchronize it reflects the reconciled state (A11/A12).
  `fieldEventView` reads one contested observation's reconciled state
  through the field store's A12-scoped load.

## The offline architecture

```
                ONE typed FieldSession (tenant + project + actor + policy)
                                  │
      ┌───────────────────────────┼─────────────────────────────────────┐
      │                           │                                     │
  capture bindings          sync surface                        conflict surface
  (open / protected /     (disconnect → reconnect →           (both sides + provenance
   open protection)        exactly-once drain)                 + disposition + resolution)
      │                           │                                     │
      └──────────── FieldDataPlane (@office/client-sync SyncEngine) ─────┘
                        │  bounded LocalQueue · causal/version tokens
                        │  deterministic operation id = idempotency key
                        ▼
              THE SEEDED FIELD WORLD's shared server-side parts
   (slice source · subscription broker · operation registry · journal ·
    conflict log · sync audit sink) + the LANDED domain command services
        (authorization, invariants, optimistic concurrency, audit events)
                        │
                        ▼
        the appended ledger event fans out on the live stream
        → every client's views re-derive from the SAME events
```

The client **never** writes canonical state directly (mutations flow
through the landed packages' public command surfaces — the offline queue
replays through the SAME typed command path as the online twin), **never**
constructs an action gateway (the A8 seam `FieldActionGateway` /
`FieldCaptureProposal` is `@office/actions` **TYPE-ONLY** — the host binds
the real gateway over the same proposal shape), and holds **no**
second-source-of-truth caches (the engine's consumed-events view is the
client's own cursor discipline; every view model re-derives from public
surfaces on every load).

## THE end-to-end acceptance (the named gate)

`src/golden-scenario.test.ts` — a SEEDED field world (deterministic seed
through the domain packages' own command surfaces: organization → project →
ONE open field observation (the contested target) → one open issue) is
operated by TWO clients (the field session + the office-side twin) through
public package surfaces, in memory:

1. the CONNECTED SEED: both clients subscribe; the field board loads from
   the session's own consumed stream;
2. DISCONNECT: the field session drops offline;
3. the office twin mutates the SAME targets ONLINE (the divergence window);
4. CAPTURE: the field session captures three mutations OFFLINE — a new
   observation (open), an evidence link on the contested field event
   (PROTECTED), an issue resolution (open) — queued, counted, displayable;
5. RECONNECT + SYNCHRONIZE: the exactly-once drain applies the observation
   cleanly (the server world reflects it through the typed command path),
   PARKS the protected evidence capture as an explicit conflict (never
   applied — no auto-resolution), and SUPERSEDES the open issue resolution
   deterministically (committed side stands, recorded + audited);
6. the CONFLICT STATE: both conflicts are displayable view models carrying
   both sides + provenance; the protected conflict shows the
   no-auto-resolution state and the ONLY exit; the open conflict shows the
   deterministic supersession outcome;
7. THE EXPLICIT RESOLUTION: the field user resolves the protected conflict
   (merge strategy, the diverging event as audit evidence, the reconciled
   evidence attachment at the field event's CURRENT version) — the
   reconciled mutation re-enters the queue discipline and applies EXACTLY
   ONCE;
8. THE QUEUE IS EMPTY and the views reflect the RECONCILED state: the field
   event carries BOTH sides' evidence, the board re-derives from the
   session's own consumed stream, and both clients converge on the same
   project-slice events.

…plus run-twice identity (a second, independently seeded world + sessions +
planes, operated identically, yields byte-identical view models), typed
rejections surfaced as displayable view models (capture while connected,
submission while disconnected, unknown conflict, malformed ids, stale
reconciled version — retryable, nothing lost), and the sync audit trail
(freeze A3: the five consequential sync transitions audited through the
shared sink).

`src/a12-scope.test.ts` proves the A12 scope gate both directions (offline
captures, online submissions, read views, queue/status/conflict/synchronize
surfaces typed-rejected for a foreign tenant's or a foreign project's
session, with zero effects; no existence oracle), and
`src/boundary.test.ts` is the structural self-gate below.

## The zero-database discipline (structurally database-free)

`src/boundary.test.ts` (mirroring the landed `@office/web` shell's
self-gate) proves structurally that the field client:

- imports **NO** `@office/persistence` — not even TYPE-ONLY — and no
  adapters*/app-sdk/app-runtime/marketplace/security package;
- imports **NO** `@office/web` (apps never import apps — the landed shell
  is the structural template, mirrored not imported);
- consumes `@office/actions` **TYPE-ONLY** (the A8 gateway seam) and
  constructs no gateway anywhere;
- carries no SQL / direct-database vocabulary and uses no DOM/browser/
  service-worker API (the offline engine is `@office/client-sync`,
  composed in memory);
- declares exactly its ten workspace dependencies, nothing external;
- uses injected clock/id suppliers only (no wall clock, no randomness in
  the modules; tests build fixed instants themselves);
- uses generic fixture vocabulary only (no provider vocabulary, no real
  vendor names).

The seeded world's in-memory reference engines (the domain packages' own
stores and registries driven through their public command surfaces, plus
the app-internal in-memory twins of the landed identity-repository ports)
are the sanctioned fixtures — the brief's "in-memory reference world,
injected — no transport". The structurally-required transaction/executor
handles of the landed ports are satisfied by pure in-memory no-op twins;
the persistence package is never imported, not even TYPE-ONLY.

## What OFF-032 / OFF-037 consume

The public surface is **only** `src/index.ts` (never deeper paths):

| consumer | what they take |
| --- | --- |
| **OFF-032** (desktop shell) | the offline field experience wholesale: the field session + data-plane composition (`createFieldSession`, `openFieldDataPlane`), the capture/queue view models, the sync report + status views, and the conflict-state view models with the explicit resolution action as the only exit |
| **OFF-037** (integration) | the two-client seeded-world harness (`seedFieldWorld` / `fieldHarnessOf` in `test-support`) and the deterministic golden scenario as the reference offline operation — capture disconnected, reconnect, synchronize exactly once, resolve the protected conflict explicitly — with zero direct database access |

## How tests run

The root vitest config already spans `apps/*/src/**/*.test.ts`, and the root
`tsc --noEmit` spans `apps/**/*.ts` — `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and `pnpm test:architecture` at the repo root gate this package
with no per-app runner:

| file | what it proves |
| --- | --- |
| `src/golden-scenario.test.ts` | THE named end-to-end acceptance (4 tests) |
| `src/a12-scope.test.ts` | the A12 scope gate, both directions (6 tests) |
| `src/boundary.test.ts` | the structural database-free/UI-free/gateway-free self-gate (13 tests) |

Do not add UI frameworks, service workers, provider SDKs, network I/O, DOM
usage, or any direct database access to this package.
