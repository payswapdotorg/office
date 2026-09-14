# Architecture conformance suite (OFF-039)

THE frozen-architecture conformance gate of the PaySwap Office workspace: five
fail-closed static scans that hold the landed code to the rules the
architecture freeze names, run as a required CI gate on every push and pull
request.

- **Rule source:** `docs/architecture/ARCHITECTURE_FREEZE.md` (frozen — never
  edited here) and the landed packages' own declared boundaries.
- **Acceptance origin:** `docs/execution/WORK_ITEMS.md` OFF-039 — *"Produces:
  automated checks for forbidden imports, provider leakage, direct agent DB
  access, unscoped queries, and app permission drift. Acceptance: conformance
  suite passes on main and is a required CI gate."*
- **Predecessor:** `workspace.test.ts` (OFF-001) — the deliberately trivial
  placeholder gate whose header deferred the deep gates to this item. Its five
  landed assertions keep running unchanged alongside the conformance checks.

## How the suite runs

```
pnpm test:architecture      # vitest run tests/architecture (repo root)
```

The same command runs in CI as the distinctly named, required step
**"Architecture conformance gate (OFF-039)"** in
`.github/workflows/ci.yml` — never `continue-on-error`, never conditional, on
every push and pull request. Branch-protection status-check wiring is the
Tech Lead's post-merge follow-up (repo settings, not repo files).

| file | role |
| --- | --- |
| `rules.ts` | THE shared rule table + scan helpers + the five pure checkers |
| `imports.test.ts` | check 1 over the real tree |
| `provider-leakage.test.ts` | check 2 over the real tree |
| `agent-db-access.test.ts` | check 3 over the real tree |
| `scoped-queries.test.ts` | check 4 over the real tree |
| `app-permissions.test.ts` | check 5 over the real tree |
| `conformance.test.ts` | the mutation probes (every rule proven to fail) |
| `workspace.test.ts` | the OFF-001 placeholder gate (landed acceptance) |

## The five rules

### 1. Forbidden imports — the global cross-package import-boundary scan

**Freeze citation:** the freeze's dependency discipline (adapters map INTO
canonical contracts, never the reverse — A5; clients are views, not databases
— A6/A12) plus the landed structural convention that every package's
boundary is its OWN `package.json` dependencies block.

**Static encoding:** every `.ts` file under `packages/*/src/` and
`apps/*/src/` may import ONLY:

1. relative imports (`./`, `../`),
2. `node:` builtins,
3. the owning package's OWN declared dependencies (from its
   `package.json` `dependencies` block — derived, never hand-maintained here),
4. `vitest` — in `*.test.ts` files only,
5. the enumerated sanctioned dynamic imports (below).

Declared is not enough: the import must also satisfy **`LAYERING_RULES`** —
the one frozen layering table applied globally:

| rule | forbids |
| --- | --- |
| `domain-never-imports-adapters` | `packages/domain/*` importing `@office/adapters-sdk` / `@office/adapter-*` |
| `clients-never-import-persistence` | `apps/*` importing `@office/persistence` (not even type-only) |
| `adapters-never-import-adapters` | `@office/adapter-*` importing another `@office/adapter-*` |

**Sanctioned exceptions (enumerated):** the root-devDependency harness seam —
`embedded-postgres` may be dynamically imported by
`packages/persistence/src/testing.ts` ONLY (a root devDependency, loaded
dynamically so production imports never pull it in).

**How a violation renders:** `rule: 'undeclared-workspace-dependency' |
'external-import' | 'test-runner-import-outside-test' |
'orphan-source-file' | 'package-manifest-unreadable' | <layering rule>`,
with the offending file and the offending import specifier in the detail —
e.g. `'@office/persistence' is declared but layering forbids it — …`.

### 2. Provider leakage — the repo-wide real-vendor-name vocabulary scan

**Freeze citation:** A5 — *"must never hard-code provider-specific semantics
into core domain entities"*; the repo-wide vocabulary rule: generic
vocabulary only, no real vendor/cloud names in code.

**Static encoding:** one forbidden-vocabulary list lives in `rules.ts`
(`FORBIDDEN_PROVIDER_NAMES`, fragment-assembled so this suite's own source
never carries a literal name) and is scanned word-boundary,
case-insensitively, comment-stripped, over every `.ts` file under
`packages/`, `apps/`, and `tests/`.

**Sanctioned exceptions (enumerated, path-exact):**

- `tests/architecture/**` — this suite (the scan inputs + probes themselves);
- `packages/intelligence/{procurement,revenue,stack-analysis}/src/boundary.test.ts`
  — the landed per-package boundary scanners whose scan inputs carry the
  literal names;
- `packages/adapter-{construction,finance,model,schedule}/src/{vocabulary,provider-fixture}.ts`
  — the adapter families' fixture-vocabulary homes.

Deliberately NOT forbidden repo-wide (they are the landed generic SDK/domain
vocabulary; they stay banned only inside the packages whose own boundary
tests carry them): `provider`, `vendor`, `erp`, `oracle` (the
existence-oracle security term).

**How a violation renders:** `rule: 'provider-name-leakage'` with the file
and the leaked name(s) in the detail.

### 3. Direct agent DB access — the agents/intelligence family ban

**Freeze citation:** A8 — *"Agents never write arbitrary database state.
They call typed domain commands and workflows through a policy-enforcing
action gateway"*; frozen anti-pattern — *"No AI direct SQL writes."*

**Static encoding:** over every file of `packages/agents/src/` and every
`packages/intelligence/*/src/` (glob-discovered, so future intelligence
packages are covered automatically):

- no VALUE import of `@office/persistence` (an `import { … } from` clause
  that does not start with `type`);
- no import of `@office/persistence` at all OUTSIDE `packages/agents` (the
  intelligence families mirror the port locally);
- no `pg` / `node:pg` driver import in any form;
- no SQL surface in any non-test module: SQL statement vocabulary
  (`INSERT INTO`, `DELETE FROM`, `UPDATE … SET`, `CREATE TABLE`,
  `SELECT … FROM`), any `.query(` call site, or `new Pool/Client`
  construction.

**Sanctioned exception (one seam):** the TYPE-ONLY `SqlExecutor` port
signature import in `packages/agents` — an inert type reference to the port
the runtime receives through the action gateway; it links no runtime code.

**How a violation renders:** `rule: 'agent-persistence-value-import' |
'agent-persistence-import' | 'agent-sql-driver-import' |
'agent-sql-surface'` with the offending file in every case.

### 4. Unscoped queries — the static form of the A12 tenant-scoping discipline

**Freeze citation:** A12 — *"Every persisted entity and every read/write
path is tenant-scoped. … Cross-tenant access is prohibited unless mediated
by an explicit platform-level control plane capability."*

**Static encoding:** over every package declaring `@office/persistence` in
its dependencies (derived from the manifests) plus `packages/persistence`
itself — every non-test `src/` module's EXPORTED query surface must flow
tenant scope:

- every method of every exported `*Repository` interface declares a
  tenant-scoping parameter — `scope: Scope` / `tenantId: TenantId` directly,
  or a typed input whose interface carries one of those / the validated A3
  `DomainEventEnvelope` (the carrier analysis is recursive through the
  interface map and cycle-safe; an input whose interface carries no scope
  field is an unscoped entry point, not a pass);
- every exported function declaration whose body executes `.query(` does the
  same (the events discipline: scope directly, or through the validated
  envelope the row's scope columns come from).

**Sanctioned exceptions (enumerated — the platform control plane A12 names):**

- `packages/persistence/src/migrator.ts` — DDL + `schema_migrations`
  bookkeeping, advisory-locked, no tenant data;
- `packages/persistence/src/testing.ts` — the integration-test harness that
  creates/drops the isolated scratch database;
- `packages/operations/src/drill/backup.ts`, `packages/operations/src/drill/restore.ts`
  — the whole-database operator restore drill (OFF-038).

**How a violation renders:** `rule: 'unscoped-repository-method' |
'unscoped-query-export'` with the file and the full offending signature in
the detail.

### 5. App permission drift — client baselines vs the closed capability registry

**Freeze citation:** A7 — *"Apps declare capabilities, permissions…"*; frozen
anti-pattern — *"No marketplace app that silently expands permissions at
runtime"*; A8's capability classification. The canonical registry is
`packages/authz/src/capability.ts` (`DECLARED_CAPABILITY_NAMES`, OFF-006) —
the same registry the OFF-036 access-review surface audits declared
baselines against.

**Static encoding:** for each of the three permission-declaring clients
(`apps/web`, `apps/field`, `apps/desktop`):

- every `capability('…')` literal and every name inside a
  `capabilities: [...]` policy array across the client's source must be a
  member of the registry — **no undeclared permission**;
- the registry itself declares BOTH halves of every area (`<area>.read` and
  `<area>.write`) — **no missing one**;
- the client's session module (`apps/<client>/src/session/session.ts`)
  exposes exactly one `SESSION_*_CAPABILITIES` const and one `definePolicy`
  call, and the two capability sets are EXACTLY equal — the baseline the
  OFF-036 surface audits cannot drift between what the client grants and
  what it allows.

**Sanctioned exceptions:** none. A missing registry, a missing client source
tree, a missing session module, or an unparseable baseline is itself a
failure — this rule fails closed on its own inputs.

**How a violation renders:** `rule: 'undeclared-client-permission' |
'registry-area-half-missing' | 'permission-baseline-drift' |
'capability-registry-missing' | 'capability-registry-unparseable' |
'client-source-missing' | 'client-session-missing' |
'session-baseline-unparseable'`, naming both sides (the registry file and/or
the offending client file) in every case.

## The .tsx coverage (OFF-DEPLOY)

The gate scans `.ts` AND `.tsx` source files — the browser host
(`apps/host`) ships JSX modules, and a JSX module can smuggle a forbidden
import or leak a vendor name exactly as reliably as a TypeScript module:

- `loadRepoTree()` collects `.tsx` files like `.ts` files (one shared pass);
- **Check 1 (forbidden imports)** scans `.tsx` modules with the same
  allowed-forms and layering rules — a `.tsx` importing `@office/persistence`
  fails `clients-never-import-persistence` exactly as a `.ts` would;
- **Check 2 (provider leakage)** scans `.tsx` content with the same
  vocabulary and comment-stripping discipline.
- Checks 3/4/5 (agent DB access, scoped queries, app permissions) keep their
  `.ts`-only filters **by design**: their domains — the agent/intelligence
  families, the persistence-facing packages, the three permission-declaring
  clients — carry no `.tsx`, and the browser host owns no capability surface
  of its own (it drives the composed session through the gateway). Each
  filter carries the note inline.
- The root `tsconfig.json` includes `apps/**/*.tsx` with `jsx: react-jsx` +
  the DOM libs (an additive widening — every pre-existing include and strict
  flag untouched; `.tsx` exists only inside `apps/host`).
- The mutation probes cover the extension explicitly: a browser-host-shaped
  healthy `.tsx` tree passes clean; a `.tsx` importing persistence, an
  undeclared import inside a `.tsx`, and a leaked provider name in JSX all
  fail closed naming the `.tsx` file.

## Mutation probes — a rule that cannot be shown to fail is not a gate

`conformance.test.ts` feeds SYNTHETIC in-memory `RepoFile[]` fixture maps
(never a real repo file) through the same pure checkers:

- **MUTATION probes** — a fixture carrying exactly one violation shape fails
  closed naming the violated rule AND the offending synthetic file;
- **HEALTHY-CONTROL probes** — a clean fixture map yields zero violations
  (a scanner that cannot pass a healthy tree is vacuous);
- **FAIL-CLOSED probes** — a missing or unreadable DECLARED file (a package
  manifest, the capability registry, a client session) is a FAILURE, never a
  skip.

The five real-tree test files add floor assertions (the scan is never
empty: ≥40 discovered manifests, ≥600 scanned source files, ≥100
agents/intelligence files, ≥13 persistence-facing packages, ≥26 registry
names) so a silently-empty scan can never pass.

## Determinism discipline

- ONE shared pass: `loadRepoTree()` walks `packages/`, `apps/`, and `tests/`
  exactly once (memoized — every check shares the same reads), sorted by
  path at every level and overall, skipping only `node_modules`/`dist`/
  `build`/`coverage` and never following symlinks.
- No clock, no randomness, no filesystem-ordering assumptions, no network
  I/O, no LLM/AI calls — the suite is pure static file analysis on node
  builtins + the root devDependency vitest (zero new dependencies).
- Fast by construction: one pass over the tree, shared file reads; the whole
  suite runs in seconds.

## Fail-closed discipline

Everything is a failure, never a skip: an unreadable directory or file
THROWS inside `loadRepoTree()`; an unparsable or nameless package manifest
is a `package-manifest-unreadable` violation; a missing registry/session
file is its own violation class. No check is advisory; nothing is warn-only.

## Extending the suite

- **A new rule** goes into `rules.ts` as a pure checker over
  `readonly RepoFile[]`, gets a real-tree test file, a mutation probe, and a
  section here (with the freeze citation).
- **A new sanctioned exception** is a reviewed, enumerated addition to the
  relevant exception list above, with the justification written here — never
  a silent widening, never a blanket pass.
- **A new intelligence package** (`packages/intelligence/<name>/`) is covered
  automatically by the glob-derived family scans; a new client app is NOT
  (the three permission-declaring clients are a reviewed list).
