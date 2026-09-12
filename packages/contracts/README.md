# @office/contracts

Canonical, provider-neutral typed contracts for PaySwap Office (**OFF-002**).

`@office/contracts` is the innermost shared kernel of the Office workspace:
every later module — domain kernel, persistence, events, authz, domain
packages, adapter SDK, app SDK, clients — depends on these types, and this
package itself depends on **nothing** (zero runtime dependencies, no imports
outside the package; verified by `src/boundary.test.ts`).

## What is here

| Area | Exports |
| --- | --- |
| Identity | `EntityId`, `TenantId`, `ProjectId`, `EntityKind`, `IdParts`, `IdVersion`, `KNOWN_ID_VERSIONS` (+ parse/format/is per type) |
| Scope | `Scope` = `TenantScope` \| `ProjectScope` (freeze A12) |
| Actor | `Actor` = `IdentifiedActor` (user/agent/app/adapter) \| `SystemActor` |
| Time | `Timestamp` (canonical UTC RFC 3339) |
| Versioning | `SchemaVersion`, `SemverString`, `KNOWN_SCHEMA_VERSIONS`, `CURRENT_SCHEMA_VERSION` |
| Commands | `CommandEnvelope`, `CommandName`, `IdempotencyKey` (freeze A8 / ADR-005) |
| Events | `DomainEventEnvelope`, `EventName`, `EventSource`, `Causality`, `CorrelationId`, `CausationId`, `EntityRef`, `EntityRefs` (freeze A3) |
| Pagination | `Page<T>`, `PageCursor` |
| Errors | `ApiError`, `ApiErrorCode`, `ApiErrorDetail` |
| Parsing | `ParseResult`, `ContractParseError`, `ContractParseErrorCode`, `parseOk`, `parseFail` |

Freeze references: A3 (event envelope fields), A8 (idempotency), A11 (typed
application contracts), A12 (tenant/project scope), the dependency rule
(contracts are the innermost shared kernel), and the anti-pattern "no
provider-specific IDs as canonical primary keys".

## Source package — no build step

This package ships TypeScript source and is never compiled: the repository
is **typecheck-gated** (`pnpm typecheck` at the root spans
`packages/**/*.ts` under the strict `tsconfig.base.json` settings) and the
root vitest configuration runs the co-located tests (`pnpm test`).
`main`, `types`, and `exports` therefore point directly at `src/index.ts`.
Workspace consumers declare:

```json
{ "dependencies": { "@office/contracts": "workspace:*" } }
```

and import only from the package root — deep imports into
`@office/contracts/src/*` are not part of the public surface. `src/index.ts`
is the whole public surface; extending it requires the contracts owner or
Tech Lead approval.

## Canonical IDs

Grammar: `office-<kind>-<idVersion>-<opaque>`

- `kind` code: `ent` (generic entity), `tnt` (tenant), `prj` (project).
- `idVersion`: currently `v1`; unknown versions fail closed with code
  `unknown-id-version`.
- `opaque`: 16..64 lowercase alphanumeric characters.

Rules:

- Canonical IDs are **Office-issued only**. Provider-shaped strings (numeric
  provider keys, dashed UUIDs, provider handles) never parse as canonical
  IDs — the `office-` prefix and strict grammar guarantee it.
- Type model (A1): `EntityId` is the supertype; `TenantId`/`ProjectId` are
  branded subtypes with their own kind codes, assignable to `EntityId` but
  not to each other. An entity reference can therefore carry a project id
  without a second, duplicate identifier.
- `parse` is the total, fail-closed boundary for untrusted values;
  `format` composes validated parts on the trusted construction path and
  throws `TypeError` on invalid parts (loud, never silent); `is` is a
  boolean type guard.
- Deterministic ID generation is owned by later work items (OFF-003,
  OFF-007).

## Envelopes

`CommandEnvelope` (freeze A8/A11, ADR-005):

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `'command'` | discriminator |
| `commandName` | `CommandName` | 2..6 dot-separated lowercase-leading segments |
| `scope` | `Scope` | tenant-scoped always; project where applicable (A12) |
| `actor` | `Actor` | user / agent / app / adapter / system |
| `idempotencyKey` | `IdempotencyKey` | **required** — replays must not duplicate effects |
| `causality` | `Causality` | correlation id + causation id (null for roots) |
| `issuedAt` | `Timestamp` | UTC RFC 3339 |
| `schemaVersion` | `SchemaVersion` | must be a known version |
| `payload` | `P` | JSON object; semantics validated by the owning domain |

`DomainEventEnvelope` (freeze A3): `kind: 'event'`, `eventName`, `scope`,
`actor`, `source` (`'domain' | 'adapter' | 'system'`), `causality`,
`schemaVersion`, `occurredAt`, `entityRefs` (`{ before, after }`, null where
not applicable), `payload`.

`ApiError`: `kind: 'error'`, `code` (stable machine-readable union),
`message`, `retryable`, `scope` (null when the failing request could not
establish one), `correlationId` (null when unavailable), `details[]`
(`{ code, message, path }`). Parse failures with code
`unknown-schema-version` map naturally to ApiErrorCode
`unsupported_schema_version`.

`Page<T>`: `kind: 'page'`, `items`, `nextCursor` (null = final page).
Pages carry no scope of their own: tenant/project scoping is enforced by the
scoped query path that produced them (A12, OFF-004).

Causality convention: `correlationId` ties one causal chain together;
`causationId` references the causing message — a command's idempotency key
or a prior event's ledger id — and is null for chain roots. Precise ledger
semantics are owned by OFF-005.

## Versioning rules (fail closed)

- A schema version parses only when it is a well-formed semver string
  **and** listed in `KNOWN_SCHEMA_VERSIONS`. Unknown versions produce a
  typed `unknown-schema-version` error — never silent acceptance.
- Envelope shapes are **strict**: unknown fields fail closed with
  `unknown-field` instead of being silently dropped. New fields require a
  new known version, which is a deliberate, owned contract change.
- `CURRENT_SCHEMA_VERSION` is the version new envelopes should be written
  with.

## Determinism

Contracts expose no clock, randomness, or network access. All functions are
deterministic and pure; tests use fixed instants and fixed opaque parts.

## Explicitly out of scope

- Domain logic and business invariants — OFF-003 domain kernel.
- Persistence, tenant-scoped queries — OFF-004.
- Event ledger, outbox, dedup/idempotency enforcement — OFF-005.
- Authorization enforcement — OFF-006.
- Provider-specific types and vocabulary — OFF-020+ adapters only.
