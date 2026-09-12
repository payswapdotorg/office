# @office/domain-kernel

Transaction-independent domain primitives for PaySwap Office (**OFF-003**) —
the kernel every later domain module (OFF-007+) builds on: aggregate
identity & versioning with optimistic concurrency, the `DomainError`
taxonomy, declarative invariant checking, idempotency key-registry
primitives, and the transactional `CommandHandler` interface.

The package depends on exactly one thing: **`@office/contracts`** (workspace
dependency). No persistence, no event ledger, no outbox, no I/O, no
wall-clock or randomness — those belong to OFF-004/OFF-005 and to the
runtime that injects suppliers. Verified by `src/boundary.test.ts`.

## What is here

| Area | Exports |
| --- | --- |
| Result | `Result<T, E>`, `ok`, `fail`, `mapOk`, `mapFailure` |
| Errors | `DomainError`, `DomainErrorCode`, `DOMAIN_ERROR_CODES`, `DOMAIN_ERROR_TO_API_ERROR_CODE`, one builder per code (`invariantViolation`, `concurrencyConflict`, `entityNotFound`, `tenantScopeViolation`, `projectScopeViolation`, `idempotencyConflict`, generic `domainError`), `toApiError` |
| Aggregate | `Aggregate`, `AggregateVersion` (+ `INITIAL_AGGREGATE_VERSION`, `MAX_AGGREGATE_VERSION`, parse/is/next), `ConcurrencyToken` (+ parse/is), `concurrencyTokenOf`, `checkConcurrency`, `checkScopeCovers` |
| Invariants | `Invariant<S>`, `defineInvariant`, `checkInvariants` |
| Idempotency | `CommandFingerprint`, `commandFingerprint`, `IdempotencyRegistry`, `IdempotencyLookup`, `createInMemoryIdempotencyRegistry`, `withIdempotency` |
| Command | `CommandExecutionContext`, `CommandHandler`, `CommandResult` |

`src/index.ts` is the whole public surface; import only from the package
root. `IdempotencyKey`, `CommandEnvelope`, `Scope`, `EntityRef` and friends
come from `@office/contracts` — the kernel re-exports nothing.

## The four kernel invariants

Deterministic tests in `src/kernel.test.ts` prove all four end-to-end with
a sample handler composed from kernel primitives:

1. **Tenant isolation (freeze A12)** — `checkScopeCovers(commandScope,
   aggregateScope)`: a command scoped to tenant A cannot act on an
   aggregate of tenant B → typed `unauthorized` failure with detail code
   `tenant-scope-violation` (cross-project within a tenant:
   `project-scope-violation`). A project-scoped command may still act on a
   tenant-wide aggregate of the same tenant (referencing tenant-level
   entities from project scope is legal).
2. **Optimistic concurrency** — `checkConcurrency(expected, actual)`: a
   stale `AggregateVersion` → typed `concurrency-conflict`; a matching
   version applies and the committed version is
   `nextAggregateVersion(actual)` (monotonic, starts at 1). Never a silent
   overwrite. Presenting a token for a different aggregate than the loaded
   one is a loud `TypeError` (programming error on the trusted path).
3. **Idempotency (freeze A8 / ADR-005)** — `withIdempotency(registry,
   command, execute)`: same (scope, key) + same command fingerprint → the
   recorded outcome is replayed (harmless, single execution); same key +
   different command → typed `idempotency-conflict`.
4. **Invariant enforcement** — `checkInvariants(nextState, invariants)`: a
   violated invariant → typed `invariant-violation` result whose detail
   code is the invariant's name. Handlers check the NEXT state and commit
   only on success, so the aggregate state is unchanged after a violation.

## Result style

Expected domain failures are values, never exceptions: every check returns
`Result<T, DomainError>` discriminated on `ok`. Throwing is reserved for
loud `TypeError`s on the trusted construction path (malformed declarations,
forged version values, non-JSON payloads in fingerprints) — same convention
as the contracts `parse`/`format` pair.

## DomainError taxonomy

| Code | Meaning | ApiError mapping | Retryable |
| --- | --- | --- | --- |
| `invariant-violation` | mutation would violate a domain invariant | `validation_failed` | no |
| `concurrency-conflict` | stale expected version | `conflict` | yes |
| `not-found` | addressed aggregate does not exist | `not_found` | no |
| `unauthorized` | scope does not cover the target (A12) | `unauthorized` | no |
| `forbidden` | actor lacks capability (refined by OFF-006) | `forbidden` | no |
| `idempotency-conflict` | idempotency key reused for a different command | `conflict` | no |

`toApiError(domainError)` is the single bridge to the contracts `ApiError`
envelope. Whether a transport surface hides cross-tenant existence behind
`not_found` is an OFF-006/API decision — the kernel reports what happened.

## Idempotency semantics

- **Dedupe key**: the pair `(scope, idempotency key)`.
- **Command fingerprint**: canonical JSON (object keys sorted recursively,
  arrays in order) of `{ commandName, schemaVersion, scope, actor, payload }`.
  Retry metadata — `issuedAt`, `causality`, and the idempotency key itself —
  is excluded, so an honest client retry fingerprints identically.
- **Execution policy** (`withIdempotency`): only successful outcomes are
  recorded. Failures are not recorded, so the same key can retry —
  transient failures (concurrency) stay retryable after a version refresh,
  and permanent failures deterministically fail again.
- **In-memory registry** (`createInMemoryIdempotencyRegistry`): for unit
  tests and deterministic suites. Persistence-backed dedupe with the same
  semantics is owned by OFF-004/OFF-005, which implement the
  `IdempotencyRegistry` interface transactionally.

## Command interface

`CommandHandler<P, Tx, T>` receives an **already-validated**
`CommandEnvelope` (boundary parsing happens upstream against
`@office/contracts`) plus a transaction-bound `CommandExecutionContext`:
an opaque `transaction` handle owned by OFF-004, and injected `now` /
`newEntityId` suppliers. The kernel itself never reads a wall clock or
generates randomness — same inputs, same outputs, always.

## Source package — no build step

Ships TypeScript source; the repository is typecheck-gated at the root
(`pnpm typecheck` spans `packages/**/*.ts`) and the root vitest config runs
the co-located tests (`pnpm test`). Consumers declare:

```json
{ "dependencies": { "@office/domain-kernel": "workspace:^" } }
```

## Explicitly out of scope

- Persistence, transactions, tenant-scoped queries — OFF-004.
- Event ledger, outbox, consumer dedupe — OFF-005.
- Authorization policy (roles/capabilities, unauthorized-vs-forbidden
  refinement) — OFF-006.
- Real domain aggregates and commands — OFF-007+.
- Provider-specific vocabulary of any kind — adapters (OFF-020+) only.
