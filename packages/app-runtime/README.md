# @office/app-runtime

The Office **app runtime and sandbox boundary** (**OFF-026**): the engine that
instantiates a published marketplace app for one tenant and then mediates
EVERY command it dispatches and EVERY event it receives. An app is a
**manifest, never code** (freeze A7) — the runtime never executes anything on
an app's behalf; it resolves the app's declared bindings and subscriptions
through typed records and routes the app's commands through **THE action
gateway** (freeze A8 — the only mutation path in the system).

The runtime is the composition point of the app world's three disciplines:

- **A9 (permissions are explicit and revocable)** — every dispatched command
  re-checks the installation's *live* grants **before** the gateway is ever
  reached; grants are re-checked at event delivery. An app can never touch an
  undeclared capability, and revoking a grant denies immediately.
- **A12 (tenant isolation, both directions)** — the installation — not the
  app — is the tenant-scoped identity: every command's scope and every
  delivered event's scope must equal the installation's tenant. A
  tenant-A installation cannot dispatch into tenant B, and neither side of
  the boundary receives the other's events.
- **A8 (gateway-mediated mutations) + A11 (one canonical graph)** — the
  runtime holds no canonical project state and constructs no gateway of its
  own: commands travel to the injected `ActionGateway`, events become typed
  delivery records, and the runtime's own bookkeeping is installations,
  grants, and namespace entries only.

The package depends on exactly six workspace packages — `@office/app-sdk`
(the manifest/permission records and the validation ports), `@office/actions`
(THE gateway plus the proposal vocabulary), `@office/contracts` (envelopes,
`Actor`, parse plumbing), `@office/authz` (the closed capability vocabulary
and `Policy`), `@office/domain-kernel` (`Result`/`DomainError`), and the
**TYPE-ONLY** `SqlExecutor` surface of `@office/persistence` (the
`AppEventSink` port signature — no store, no repository, no SQL). No domain,
intelligence, sync, adapters, agents, or client-sync packages; no external
dependencies; no provider vocabulary; no arbitrary app code execution
anywhere.

## Public surface

Everything is exported from `src/index.ts` (the package's whole surface —
deeper paths are internal and may change without notice):

| Module | What it exports |
| --- | --- |
| `installation.ts` | **`AppInstallation`** (the tenant-scoped identity: installation id, tenant, pinned `appId`/`manifestVersion`, state, declared hooks, the transition instants/actors), `AppLifecycleState` + `APP_LIFECYCLE_STATES` (+parse/is, grammar), `installInstallation` (trusted builder), `activateInstallation` / `suspendInstallation` / `revokeInstallation` / `uninstallInstallation` (the typed state machine), `installationActor` (the `'app'` actor), `isInstallationDispatchable`, `LifecycleTransition` |
| `hooks.ts` | `LIFECYCLE_HOOKS`, `AppLifecycleHook` (the declared descriptor record: `on-install` / `on-activate` / `on-suspend` / `on-revoke`), `LifecycleHookInvocation` (the typed record the HOST executes), `appLifecycleHooks`, `lifecycleHookInvocationOf` (+parse/is, grammars) |
| `permissions.ts` | `grantManifestPermissions` (issue the manifest's grants), `installationGrantView` (ownership-validated live/revoked partition), **`checkInstallationCapabilities`** (THE A9 dispatch gate), `requiredCapabilityOfEvent` (the event-side read-capability derivation, fail-closed), `revokeInstallationPermission`, `upgradeInstallationPermission`, `parseInstallationPermission` |
| `namespace.ts` | `AppCommandNamespaceEntry`, `AppEventNamespaceEntry`, `AppCommandNamespaceId`, `AppEventNamespaceId` (+parse/is, grammars, `format` builders), `appCommandNamespaceIdOf` / `appEventNamespaceIdOf` (the deterministic sha256 derivations), `namespaceIdOf` |
| `dispatch.ts` | **`appCommandDispatch`** and **`appEventDispatch`** (THE two engines), `matchEventSubscription`, `AppDispatchDeps`, `AppCommandDispatchInput` / `AppCommandDispatchRecord` / `AppCommandOutcome`, `AppEventDeliveryRecord`, the closed `APP_COMMAND_REJECTION_REASONS` / `APP_EVENT_REJECTION_REASONS` vocabularies |
| `audit-events.ts` | the nine `APP_*_EVENT` name constants + `APP_RUNTIME_EVENT_NAMES`, `AppRuntimeDecision` / `APP_RUNTIME_DECISIONS`, `AppRuntimeAuditPayload`, `appRuntimeEventEnvelope`, `commandCausationIdOf`, **the `AppEventSink` port**, `createInMemoryAppEventSink`, `failingAppEventSink`, `appSinkFailure` |
| `registry.ts` | `AppInstallationStore`, `AppPermissionStore`, `AppNamespaceStore`, `createInMemoryAppRuntimeStore` (the deterministic in-memory reference) |
| `runtime.ts` | **`createAppRuntime`** — the composed engine over a store: `install`, `activate`, `suspend`, `revoke`, `uninstall`, `dispatchCommand`, `dispatchEvent`, `dispatchEventToSubscribers` (the fan-out), `revokePermission`, `upgradePermission` |

## The AppInstallation lifecycle

One installation instantiates ONE published manifest version of ONE app for
ONE tenant (freeze A7). The installation — not the app — is the actor
identity (`{ kind: 'app', actorId: installationId }`) every dispatched
command carries, and the tenant scope every command and event must stay
inside (A12):

```
installing ──activate──▶ active ──suspend──▶ suspended
       ▲                    │  ▲                │
       └──(new install)─────┘  └── reactivate ──┘
                            │
         revoke ────────────┼──────────▶ revoked     (TERMINAL, one-way)
         uninstall ─────────┴──────────▶ uninstalled (TERMINAL)
```

- **suspension is the STOP sign**: a suspended installation receives NO
  commands and NO events — both dispatch engines typed-reject with an
  auditable `installation-suspended` reason; **re-activation restores
  dispatch** (canonical state was never deleted, freeze A7);
- **revocation is one-way**: a revoked installation can never re-activate
  (re-install is a NEW installation); revoking twice is idempotent — the
  original revocation instant and actor are preserved;
- every transition is a typed `Result` over immutable snapshots, instants
  come from the injected clock, and every transition is audited.

## Permission enforcement (the A9 gate)

`grantManifestPermissions` issues one deterministic `Permission` per declared
spec at install time (ids derived through the SDK's `permissionIdOf`).
`checkInstallationCapabilities` is THE dispatch gate: every required
capability of the dispatched action must be covered by a **live grant that
belongs to THIS installation** — a foreign record (another tenant,
installation, or app) is a typed `permission-foreign` wiring defect, never a
usable grant. The gate returns the live grant capabilities which travel with
the proposal into the gateway (defense in depth — the host policy re-checks).
On the event side, `requiredCapabilityOfEvent` derives `<area>.read` from the
event name and validates it against the CLOSED authz vocabulary: events of
undeclared areas (e.g. the gateway's own `actions.*` audit trail) are never
delivered to an app.

## The app command/event namespace

Each installation registers its manifest's bindings and subscriptions under
namespace entries keyed by derived, deterministic identities
(`office-ncmd-v1-…` / `office-nsub-v1-…`, sha256 over
`installation|command` / `installation|event`): the same key always maps to
the same identity, two installations never collide, and registering the same
key twice is a typed `namespace-*-collision` — never a silent override of
one app binding by another. Entries are plain JSON records with strict
cross-field consistency (the binding's command name must equal the entry's).

## Lifecycle hooks (declared, never executed)

A hook is a DECLARED DESCRIPTOR RECORD — the same symbolic `AppHandler`
contract a command binding carries. The runtime emits typed
`LifecycleHookInvocation` records (which installation, which hook, which
symbolic handler id, when) on its audit trail; **the host** resolves the
symbolic id to its own installed handler code and invokes it. The runtime
itself executes no app code of any kind. Uninstall declares no hook — it is
removal, not app behavior.

## Gateway-mediated dispatch + the audit trail

`appCommandDispatch` runs six gates **before** `executeAction` is ever
reached: lifecycle (active only) → binding match → actor identity (the
installation's own `'app'` actor, never a spoofed one) → tenant scope (A12,
command AND resource scope) → classification against the injected
action-descriptor source → A9 live grants. The proposal then travels through
THE gateway with the installation's capabilities and the host's policy; the
gateway's decision (`executed` / `routed-to-approval` / `denied`) is recorded
verbatim in the `AppCommandDispatchRecord`. `appEventDispatch` applies the
same discipline (lifecycle, subscription match, tenant, typed filter,
re-checked grants) and produces the typed `AppEventDeliveryRecord` — delivery
is at-least-once, consumers must be idempotent (freeze A3).

Every decision emits an immutable `DomainEventEnvelope` through **the
`AppEventSink` port** (`appendEvents(executor, events)` with the caller's
open transaction executor, mirroring the landed packages' EventSink shape):
the five lifecycle transitions (carrying the hook invocations), every
dispatched command, every pre-gateway typed rejection **with its reason**
(the suspension rejection is auditable), every delivered event, and every
typed event rejection. A sink failure aborts the surrounding operation — no
audit, no record, no committed effect.

## Running the tests

The package has no build step (source package, same convention as the merged
packages) and no test scripts of its own — the root toolchain covers it:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:architecture
```

The suite (8 files, 133 tests) is deterministic throughout: injected
timestamps (no wall clock), fixed tenants/installations/actors, derived ids,
typed `Result`/`ParseResult` assertions, and a counting wrapper around the
REAL action gateway. The marquee suites are:

- `dispatch.test.ts` — **THE acceptance**: command dispatch with an
  undeclared capability typed-rejected BEFORE the gateway (zero gateway
  calls, zero handler invocations, rejection audited); cross-tenant dispatch
  typed-rejected in both directions; the systematic 15-cell
  lifecycle-state × grant-state matrix (exactly ONE cell — active + live
  grants — reaches the gateway); a suspended installation receiving nothing
  on both paths with the suspension rejection audited; re-activation
  restoring dispatch; one-way revocation;
- `runtime.test.ts` — the composed engine: the audited install flow, the
  install → active → suspended → revoked transitions with their hooks, the
  fan-out delivery, the all-or-nothing sink-failure abort, and the A11 proof
  (a successful dispatch mutates nothing in the runtime's own store);
- `boundary.test.ts` — the package's dependency/import/type-only self-gate
  (the structural half of the A8 proof; the behavioral half is the gateway
  invocation counting in the dispatch/runtime suites).
