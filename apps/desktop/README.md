# @office/desktop-shell

The PaySwap Office **desktop client protocol/reference shell** (OFF-032): the
**platform shell HOST-PORT CONTRACT** (the typed surface every desktop
platform host must provide the shell) plus the **REFERENCE DESKTOP HOST**
that implements it in memory — a typed, deterministic desktop client that
consumes **THE SAME sync/client-sync client protocol as the web and field
shells**: read the workspace over the subscribed slice → write through the
typed command path → **go offline (capture) → reconnect → synchronize
(exactly-once drain) → show conflict state → resolve explicitly** — plus the
**cross-client convergence proof** (a web-style client and the desktop host
over ONE shared server world converge on the identical reconciled state),
all through public package surfaces, in memory, with **zero direct database
access** and **no platform-specific domain model**.

Pure TypeScript: **no UI framework, no DOM, no Electron/node runtime APIs**
— this is the typed reference host, the PROTOCOL PROOF, not a binary; a real
desktop platform host implements the same typed port shape over its real
transport, durable queue, and conflict store, and the shell's view models
and command surfaces are unchanged.

## Purpose

Freeze A12 (ONE project state, all clients share it — the desktop is a
CLIENT of the same protocol), A11 (a VIEW, never a second source of truth),
A8/A9 (the typed command path + the subscription/slice/offline-engine
protocol), and the offline-conflict freeze decision
(`docs/architecture/ARCHITECTURE_FREEZE.md`): material synchronization
conflicts are resolved by **EXPLICIT resolution, never silent
last-write-wins**. This package is that discipline's typed desktop client:

- **THE platform shell host-port contract** — `DESKTOP_HOST_PORT_CONTRACT`
  (the JSON-safe descriptor of the three named ports: **identity** — how the
  host resolves the desktop session; **data** — how the host provides the
  subscribed project slice + the offline engine + the read projections;
  **commands** — how the host executes the typed command surface) and
  `validateDesktopHostPort`, the FAIL-CLOSED structural validator (strict
  keys, every declared member present and callable, no unknown sections) —
  a malformed host port is a typed rejection naming the offending path,
  never a silent partial host.
- **THE reference desktop host** — `createReferenceDesktopHost(world)` wires
  every declared port member over the SEEDED DESKTOP WORLD through the
  shell's own session/data-plane/command modules, which compose **THE SAME**
  `@office/sync` + `@office/client-sync` contracts the web and field shells
  consume (the A9 grant + subscription, the bounded LocalQueue, the
  exactly-once reconnect drain, the conflict records, the typed explicit
  resolution). Deterministic: injected clock/id suppliers only; every `now`
  is caller-supplied.
- **Desktop session plane** — ONE typed desktop-session record
  (`createDesktopSession`: tenant, project, acting desktop user,
  deny-by-default policy, closed capability set) that every surface resolves
  through (freeze A12). `seedDesktopWorld` composes the deterministic SEEDED
  DESKTOP WORLD — the landed organization/projects/schedule/cost domain
  packages' reference engines wired through their own public command
  surfaces, plus the SHARED server-side sync parts (the ledger-shaped slice
  source, the subscription broker, the operation registry, the
  applied-operation journal, the conflict log, the sync audit sink).
  `openDesktopDataPlane` wires ONE client's data plane over those shared
  parts. Two planes over ONE world is the desktop-host/web-style-twin
  convergence composition.
- **Typed command surface** — `submitCostItem` / `captureCostItem`
  (`cost.recordCostItem`, protection **protected**), `submitProgress`
  (`schedule.recordProgress`, protection **open**), `captureActivityUpdate`
  (`schedule.updateActivity`, protection **open**), `captureCommitmentAmend`
  (`cost.amendCommitment`, protection **protected** — commitments are
  material commercial state), and `submitCommitmentClose`
  (`cost.closeCommitment`, the web-style twin's divergence mutation): typed
  bindings over the session's data plane — canonical ids parsed fail-closed,
  the mutation submitted through the ONLINE typed path or captured into
  `@office/client-sync`'s bounded LocalQueue with a client-generated
  deterministic operation id (the A8 idempotency key) and the
  domain-declared protection class, and every outcome a typed displayable
  view (`SubmissionOutcomeView` / `CaptureOutcomeView`) — rejections are view
  models (`RejectionView`), **never throws**. `offlineQueueView` projects
  the queue's displayable state.
- **Workspace view model** — `desktopWorkspaceView` composes the project
  workspace over the session's SUBSCRIBED SLICE: the header (project +
  owning organization), the schedule summary with the deterministic CPM
  forecast, THE cost-position read model (`cost.costPosition`, verbatim), the
  session's own consumed-stream section, and the pending capture count —
  A11: a projection of ONE project state, never a copy.
- **Reconnect + synchronize surface** — `synchronize` drives the engine's
  reconnect (catchup from the client's LAST CONFIRMED cursor, exactly once,
  no duplicates, no gaps + the queue's EXACTLY-ONCE drain + the client's own
  replayed effects) into the displayable `SyncReportView`;
  `syncStatusView` shows the cursor/token state at every step; `disconnect`
  is the connection lifecycle (the desktop goes offline too).
- **Conflict state surface (THE acceptance core)** — `conflictStateView`
  projects every surfaced conflict as a displayable `ConflictView` carrying
  BOTH SIDES + PROVENANCE + the domain-declared protection class + the
  deterministic `ConflictDisposition`: a **PROTECTED** conflict shows the
  no-auto-resolution state whose ONLY exit is `resolveProtectedConflict` —
  the TYPED EXPLICIT RESOLUTION COMMAND surfaced as a USER ACTION (strategy
  + audit evidence + the RECONCILED SUCCESSOR COMMITMENT re-entering the
  queue discipline); an **OPEN** conflict shows the deterministic
  supersession outcome (the committed server side stands, recorded +
  audited, never silent).

## The desktop architecture

```
                ONE typed DesktopSession (tenant + project + actor + policy)
                                  │
        ┌─────────────────────────┼───────────────────────────────────┐
        │                         │                                   │
   THE HOST-PORT CONTRACT   workspace view model            sync + conflict surfaces
   (identity · data ·       (header · schedule · CPM        (disconnect → reconnect →
    commands — validate      forecast · cost position ·      exactly-once drain · both
    fail-closed; the          the session's own slice)        sides + disposition +
    reference host =                                  the explicit resolution)
    the in-memory proof)                                  │
        │                         │                         │
        └──── DesktopDataPlane (@office/client-sync SyncEngine) ────┘
                        │  bounded LocalQueue · causal/version tokens
                        │  deterministic operation id = idempotency key
                        ▼
           THE SEEDED DESKTOP WORLD's shared server-side parts
  (slice source · subscription broker · operation registry · journal ·
   conflict log · sync audit sink) + the LANDED domain command services
       (authorization, invariants, optimistic concurrency, audit events)
                        │
                        ▼
        the appended ledger event fans out on the live stream
        → the desktop host AND the web-style twin re-derive from
          the SAME events (A12: all clients share ONE project state)
```

The shell **never** writes canonical state directly (mutations flow through
the landed packages' public command surfaces — the offline queue replays
through the SAME typed command path as the online twin), **never**
constructs an action gateway (the A8 seam `DesktopActionGateway` /
`DesktopCommandProposal` is `@office/actions` **TYPE-ONLY** — the host binds
the real gateway over the same proposal shape later), and holds **no**
second-source-of-truth caches (the engine's consumed-events view is the
client's own cursor discipline; every view model re-derives from public
surfaces on every load).

## THE end-to-end acceptance (the named gate)

`src/golden-scenario.test.ts` — a SEEDED project (deterministic seed through
the domain packages' own command surfaces: organization → project → a
three-activity serial programme with a baseline → a budget with two cost
items → ONE committed purchase order) is operated by TWO clients (the
reference desktop host + a web-style twin) through public package surfaces,
in memory:

1. the CONNECTED SEED: the reference host validates against the host-port
   contract; both clients subscribe; the workspace view model loads over
   the subscribed slice (the 12 project-scope seed events);
2. THE DESKTOP HOST WRITES ONLINE: a progress record through the typed
   command path — the canonical world's command journal reflects it under
   its operation id;
3. DISCONNECT: the desktop host drops offline;
4. the WEB-STYLE TWIN mutates the SAME targets ONLINE (the divergence
   window): progress on the same activity + the purchase order CLOSED;
5. CAPTURE: the desktop host captures three mutations OFFLINE — an activity
   update (OPEN), the staged purchase-order amendment on the contested
   commitment (PROTECTED), a new budget cost item (PROTECTED, uncontested) —
   queued, counted, displayable;
6. RECONNECT + SYNCHRONIZE: the exactly-once drain SUPERSEDES the open
   activity update deterministically (committed side stands, recorded +
   audited), PARKS the protected amendment as an explicit conflict (never
   applied — no auto-resolution), and APPLIES the cost item cleanly through
   the typed command path (the world reflects it under its operation id);
7. the CONFLICT STATE: both conflicts are displayable view models carrying
   both sides + provenance; the protected conflict shows the
   no-auto-resolution state and the ONLY exit; the open conflict shows the
   deterministic supersession outcome (the twin's progress event as audit
   evidence);
8. THE EXPLICIT RESOLUTION: the desktop user resolves the protected conflict
   (merge strategy, the diverging close event as audit evidence, the staged
   amended scope re-entering as a SUCCESSOR purchase order against the same
   budget) — the reconciled mutation re-enters the queue discipline and
   applies EXACTLY ONCE;
9. THE QUEUE IS EMPTY and the workspace reflects the RECONCILED commercial
   position (both commitments committed, the budget at its new version), and
   BOTH CLIENTS CONVERGE on the world's actual project-slice stream —
   THE CROSS-CLIENT CONVERGENCE PROOF (A12: a web-style client and the
   desktop host over ONE shared server world share the identical reconciled
   state).

…plus run-twice identity (a second, independently seeded world + sessions +
planes, operated identically, yields byte-identical view models), typed
rejections surfaced as displayable view models (capture while connected,
submission while disconnected, unknown conflict, malformed ids, a stale
expected version that stays retryable — nothing lost), the sync audit trail
(freeze A3: the five consequential sync transitions audited through the
shared sink), and the host-port contract's own fail-closed validation probes
plus a full client loop driven through the PORT itself (open plane → submit
online → disconnect → capture offline → synchronize → read every view back).

`src/a12-scope.test.ts` proves the A12 scope gate both directions (offline
captures, online submissions, the workspace read, and the
queue/status/conflict/synchronize surfaces typed-rejected for a foreign
tenant's or a foreign project's session, with zero effects; both directions
receive the IDENTICAL rejection — no existence oracle), and
`src/boundary.test.ts` is the structural self-gate below.

## The zero-database, zero-platform discipline (structurally free of both)

`src/boundary.test.ts` (mirroring the landed `@office/web` and
`@office/field` shells' self-gates) proves structurally that the desktop
shell:

- imports **NO** `@office/persistence` — not even TYPE-ONLY — and no
  adapters*/app-runtime/marketplace/security/workflows/agents/intelligence
  package and no domain package outside organization/projects/schedule/cost;
- imports **NO** `@office/web` and **NO** `@office/field` (apps never import
  apps — the landed shells are the structural templates, mirrored not
  imported);
- consumes `@office/actions` **TYPE-ONLY** (the A8 gateway seam) and
  constructs no gateway anywhere;
- carries no SQL / direct-database vocabulary, no DOM/browser/service-worker
  API, and **no Electron/node-runtime API vocabulary** (the typed reference
  host, not a binary); the CLIENT modules import nothing but relative paths
  and the eleven workspace dependencies — not even node builtins;
- declares **NO platform-specific domain model**: no local raw-string branded
  casts anywhere in the client modules — every domain term (command names,
  entity kinds and ids, operation kinds, event names) arrives from the
  shared contracts/domain/sync packages through their public fail-closed
  surfaces;
- declares exactly its eleven workspace dependencies, nothing external, no
  UI framework;
- uses injected clock/id suppliers only (no wall clock, no randomness in
  the modules; tests build fixed instants themselves);
- uses generic fixture vocabulary only (no provider vocabulary, no real
  vendor names, no real OS vendor names beyond the generic 'desktop-host'
  vocabulary).

The seeded world's in-memory reference engines (the domain packages' own
stores and registries driven through their public command surfaces, plus the
app-internal in-memory twins of the landed identity-repository ports) are
the sanctioned fixtures — the brief's "in-memory deterministic proof". The
structurally-required transaction/executor handles of the landed ports are
satisfied by pure in-memory no-op twins; the persistence package is never
imported, not even TYPE-ONLY.

## What OFF-037 + the platform teams consume

The public surface is **only** `src/index.ts` (never deeper paths):

| consumer | what they take |
| --- | --- |
| **OFF-037** (integration) | the two-client seeded-world harness (`seedDesktopWorld` / `desktopHarnessOf` in `test-support`), the deterministic golden scenario as the reference desktop operation (read → write → offline → reconnect → synchronize exactly once → resolve explicitly → converge), and the host-port contract descriptor when wiring the integrated host |
| **successor platform teams** (the real desktop host) | `DESKTOP_HOST_PORT_CONTRACT` + `validateDesktopHostPort` (the typed contract every platform host must satisfy) and the reference host's view models + command surfaces — implement the same port shape over the real transport, durable queue, and conflict store; the shell is unchanged |

## How tests run

The root vitest config already spans `apps/*/src/**/*.test.ts`, and the root
`tsc --noEmit` spans `apps/**/*.ts` — `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and `pnpm test:architecture` at the repo root gate this package
with no per-app runner:

| file | what it proves |
| --- | --- |
| `src/golden-scenario.test.ts` | THE named end-to-end acceptance incl. the cross-client convergence proof, run-twice identity, the retryable stale-version rejection, and the host-port contract's fail-closed validation + port-driven loop (5 tests) |
| `src/a12-scope.test.ts` | the A12 scope gate, both directions, no existence oracle (5 tests) |
| `src/boundary.test.ts` | the structural database-free/platform-free/gateway-free/no-local-domain-model self-gate (16 tests) |

Do not add UI frameworks, Electron or node runtime APIs, provider SDKs,
network I/O, DOM usage, any direct database access, or any
platform-specific domain model to this package.
