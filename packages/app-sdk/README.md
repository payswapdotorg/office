# @office/app-sdk

The Office marketplace **App SDK** (**OFF-025**): the typed contract a
marketplace app ships and the fail-closed validation the platform runs on it.
An app is a **manifest, never code** (freeze A7): it declares its identity,
its permissions (A9: explicit, versioned, revocable), the typed commands it
offers to serve, the canonical events it reacts to, the UI surfaces the host
renders on its behalf, and the *contract* versions of other apps it depends
on. The app runtime (**OFF-026**) instantiates manifests tenant-scoped and the
marketplace (**OFF-027**) catalogs them; this SDK owns the vocabulary both
sides speak.

The SDK depends on exactly four workspace packages — `@office/contracts`
(ids, envelopes, the envelope schema version, the canonical parse plumbing),
`@office/authz` (the closed capability vocabulary), `@office/domain-kernel`
(`Result`/`DomainError`), and the **TYPE-ONLY** surface of `@office/actions`
(the frozen-A8 action-class vocabulary; the real action registry satisfies
the validation port structurally). No domain, intelligence, sync, adapters,
agents, or client-sync packages anywhere in an importing app's graph —
[`apps/sample-app`](../../apps/sample-app) is the standing proof. No external
dependencies of any kind.

## Public surface

Everything is exported from `src/index.ts` (the package's whole surface —
deeper paths are internal and may change without notice):

| Module | What it exports |
| --- | --- |
| `identity.ts` | `AppId`, `AppVersion`, `ViewId`, `AppHandlerId`, `PermissionId`, `PermissionVersion`, `VersionRange` (+ total fail-closed `parse`/`is` guards, trusted builders, grammars), `permissionIdOf` (the deterministic sha256 derivation), `compareAppVersions`, `satisfiesVersion` |
| `permissions.ts` | `PermissionSpec` (the A9 declaration), `Permission` (the A9 runtime record), `PermissionState`, `grantPermission`, `upgradePermission`, `revokePermission`, `isPermissionActive` (+parse/is, grammars) |
| `bindings.ts` | `AppHandler`, `CommandBinding`, `BINDABLE_ACTION_CLASSES` (+parse/is, grammars) |
| `subscriptions.ts` | `EventSubscription`, `EventSubscriptionFilter` (+parse/is, grammars) |
| `ui-extensions.ts` | `EXTENSION_POINTS`, `ExtensionPointId`, `ViewElement`, `ViewDescriptor`, `UiExtension`, `VIEW_MAX_ELEMENTS` (+parse/is, grammars) |
| `manifest.ts` | `AppDependency`, **`AppManifest`**, `appManifest` (the trusted builder), `parseAppManifest`, `isAppManifest` (+grammars) |
| `validation.ts` | `KnownAction`, `ActionDescriptorSource`, `AppCatalogSource`, `AppValidationDeps`, `actionDescriptorSource`, `validateAppManifest`, `reviewAppManifest`, `ManifestReview` |
| `registry.ts` | `AppRegistry`, `createInMemoryAppRegistry` (the deterministic in-memory reference; satisfies `AppCatalogSource`) |
| re-exports | the closed authz capability vocabulary (`CAPABILITIES`, `capability`, `parseCapability`, `Capability`) so an app imports only this package + `@office/contracts`; the `ActionClass` vocabulary (TYPE-ONLY) |

## The AppManifest contract

`AppManifest` is the versioned, tenant-independent **template** an app
publisher ships. It is versioned **twice**: the envelope schema version
(`@office/contracts`, fail-closed against the known schema versions) and the
app's own semantic `manifestVersion` (`MAJOR.MINOR.PATCH`). Strict keys
everywhere — an unknown field is a typed `unknown-field` rejection, never a
silently ignored one:

```ts
const manifest = appManifest({
  appId: appId('field-progress-tracker'),
  manifestVersion: appVersion('1.4.0'),
  title: 'Field Progress Tracker',
  description: 'Records daily field progress against the plan.',
  permissions: [/* PermissionSpec… */],
  bindings: [/* CommandBinding… */],
  subscriptions: [/* EventSubscription… */],
  uiExtensions: [/* UiExtension… */],
  dependencies: [/* AppDependency… */],
});
```

`appManifest` is the **trusted builder** (loud `TypeError` on invalid parts);
`parseAppManifest` is the **untrusted boundary** (total, typed
`ContractParseError`s). A parsed manifest re-parses unchanged — the parse is
idempotent (a dependency's version range normalizes from its string form
`'^2.1.0'` to the typed `{ kind: 'caret', version: '2.1.0' }`, and both forms
parse). Manifest-level uniqueness is enforced at parse: one permission per
(capability, scope kind), one binding per command name, one subscription per
event name, one view per view id, one dependency per app id, and never a
dependency on the manifest's own app.

`AppDependency` declares a dependency on **another app's published contract
versions** (its manifest surface), never its implementation: an exact pin
`'2.1.0'` or a caret range `'^2.1.0'` (semver caret semantics via
`satisfiesVersion`). The manifest carries no tenant, no code, no credentials,
and no secrets — installation (OFF-026/OFF-027) instantiates it scoped.

## Permissions (the A9 lifecycle)

Two records, deliberately distinct:

- **`PermissionSpec`** — the *declaration* inside a manifest: exactly one
  capability (validated against the **closed** `@office/authz` vocabulary —
  `'*'`, `'work.*'`, `'*.read'`, and unknown areas can never parse), one
  explicit scope kind (`'tenant' | 'project'`, never `'*'`), and a
  declaration version. Bumping the version is a manifest-level permission
  change the marketplace reviews as a delta — an app can never silently
  expand a permission at runtime.
- **`Permission`** — the *runtime record* the app runtime and marketplace own
  instances of: who holds what (tenant, tenant-scoped installation, app), the
  granted spec, and the lifecycle position. The id is **derived
  deterministically** from the permission key (`permissionIdOf`), so
  re-granting the same capability at the same scope kind to the same
  installation resolves to the *same* identity.

The lifecycle semantics this SDK pins (and the transitions implement):

```
granted ──upgrade──▶ versioned ──revoke──▶ revoked (terminal)
```

- `grantPermission` composes the issued record: state `'granted'`, lifecycle
  version 1, no revocation fields.
- `upgradePermission` is an **explicit spec upgrade**: the lifecycle version
  bumps and the state becomes `'versioned'` — holders pinned to the previous
  lifecycle version are stale until the marketplace re-grants. Upgrading a
  revoked permission, re-upgrading to the *same* spec, or changing the
  capability/scope kind in place (a new permission, not an upgrade) are typed
  invariant violations.
- `revokePermission` is **terminal and idempotent**: the record stops
  conferring the capability; revoking an already-revoked permission returns
  it unchanged (the original revocation instant and actor are preserved).
  `isPermissionActive` is the gate the runtime re-checks before any gateway
  call — a revoked permission denies, it never partially executes.

## Command bindings

A `CommandBinding` is how an app offers to serve a typed domain command: the
canonical `commandName` (grammar-validated at parse, resolved against the
real OFF-017 `ActionDescriptor`s at validation), the app's **handler
contract**, and the required action class. The handler contract is a stable
**symbolic** `AppHandlerId` plus human-readable metadata — the app runtime
resolves the id to installed handler code at execution time, behind the
action gateway; a manifest never carries executable code, file paths, or
network references (freeze A8).

Only the three executable action classes are bindable
(`BINDABLE_ACTION_CLASSES` = `read` | `reversible` | `approval-required`);
`'prohibited'` is rejected **at parse time** — prohibited commands are never
executed for anyone, apps doubly so.

## Event subscriptions

An `EventSubscription` is the canonical event name (grammar-validated against
the `@office/contracts` event-name grammar) plus a **typed filter**: every
occurrence (`{ kind: 'all' }`, declared — never silently defaulted) or the
occurrences whose entity reference carries one declared entity kind
(`{ kind: 'entity-kind', entityKind }`). Filters are typed values — no
arbitrary predicates, no wildcard expressions. Delivery is
installation-scoped and at-least-once; consumers must be idempotent.

## The extension UI contract

An app **never ships executable core code**. Instead the manifest declares
`UiExtension`s: a typed extension-point id from the **closed**
`EXTENSION_POINTS` vocabulary (`project.overview.panel`,
`project.cost.panel`, `project.schedule.panel`, `project.quality.panel`,
`project.documents.panel`, `app.settings.section`) plus a typed
`ViewDescriptor` the host renders — 1..50 typed elements (`heading`, `text`,
`metric`, `action`). The `action` element references a command the manifest
binds (validation cross-checks it); an undeclared reference is
typed-rejected. No code references, file paths, URLs, or scripts are
representable anywhere in the descriptor: the host owns every pixel and every
execution; the app owns only the declaration. Unknown extension points are
typed-rejected at parse — hosts and apps negotiate new surfaces through
manifest schema versions, never through unknown ids.

## Validation semantics

Two total, fail-closed steps, both pure and deterministic (no throws, no
clock, no randomness — instants and ids are injected/derived):

1. **`parseAppManifest`** — the structural parse: strict keys, typed fields,
   closed vocabularies (capabilities, scope kinds, extension points, action
   classes, grammars), and the manifest-level uniqueness rules.
2. **`validateAppManifest`** — the cross-reference validation against
   INJECTED ports: every binding resolves against the action vocabulary
   (unknown commands are `not-found` — the gateway classifies unknown
   commands as prohibited by default — and the declared class must *match*
   the descriptor's), every capability a bound action *requires* must be
   *declared* (A9 explicitness — `forbidden` otherwise), every UI action
   references a declared binding, and every app dependency resolves against
   the app catalog (unknown app, or a range no published contract version
   satisfies — `not-found`).

`reviewAppManifest(raw, deps)` is the single entry point that runs both —
the intake the marketplace (OFF-027) and the app runtime (OFF-026) call.
Success returns the manifest **unchanged** — validation never repairs. The
`ActionDescriptorSource`/`AppCatalogSource` ports are structural:
`@office/actions`' real registry plugs in via `actionDescriptorSource` (the
validation tests run against real `ActionDescriptor`s), and
`createInMemoryAppRegistry` is the in-memory catalog reference for tests.

## The sample app

[`apps/sample-app`](../../apps/sample-app) (`@office-sample/app`) is the
reference marketplace app and the standing proof of the SDK's acceptance
boundary: a minimal manifest (two explicit permissions, one reversible
command binding with a symbolic handler, one event subscription with a typed
filter) that type-checks against **only** `@office/app-sdk` +
`@office/contracts`. Its boundary test additionally proves the import graph
contains no other `@office/*` package anywhere in its source.

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

The suite (11 files, 105 tests) is deterministic throughout: injected
timestamps (no wall clock), fixed tenants/installations/actors, derived ids,
typed `Result`/`ParseResult` assertions. The marquee suites are
`malformed.test.ts` — **the malformed-manifest acceptance matrix**: bad
capability, wildcard permission, unknown extension point, undeclared
dependency, bad version, and more, every case typed-rejected through
`reviewAppManifest` with the exact typed error path asserted — and
`boundary.test.ts`, the package's dependency/import/type-only self-gate
(provider-vocabulary ban, no wall clock, no randomness, no build output).
