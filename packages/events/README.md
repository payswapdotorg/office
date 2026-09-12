# @office/events

Event ledger and transactional outbox for PaySwap Office (**OFF-005**) — the
event foundation every later domain module builds on: an append-only event
ledger with ledger-assigned per-aggregate sequences and deterministic event
ids, a transactional outbox enqueued in the same transaction as state writes,
and an idempotent consumer cursor — with causation/correlation propagation
throughout (freeze A3, A10, A12).

Runtime dependencies are exactly `@office/contracts`, `@office/domain-kernel`,
and `@office/persistence` (the merged foundations); node builtins aside,
nothing else is imported, and `pg` stays a persistence-internal concern —
this package programs against `SqlExecutor` / `TransactionRunner` only
(verified by `src/boundary.test.ts`).

`src/index.ts` is the whole public surface; import only from the package root
(`@office/events`). Anything not re-exported there is package-internal and
may change without notice.

## What is here

| Area | Exports |
| --- | --- |
| Identity | `LedgerEventId`, `LedgerSequence`, `ConsumerName` (+ `parse`/`is`/`format` helpers and grammars), `ledgerEventIdOf` (deterministic id derivation), `causationIdOf` (token → `CausationId` bridge) |
| Migrations | `EVENTS_MIGRATIONS_DIR` — the package's `0003_event_ledger.sql` + `0004_outbox.sql`, applied with @office/persistence's migrator conventions |
| Ledger | `appendEvent`, `readEventById`, `readAggregateEvents`, `LedgerEvent`, `AppendEventInput`, `causedByCommand`, `causedByEvent` |
| Outbox | `enqueueOutbox`, `fetchPendingOutbox`, `markDispatched`, `recordDispatchFailure`, `OutboxRecord`, `OutboxEntry`, `OutboxState` (+ options types) |
| Consumer | `consumeIdempotently`, `readConsumerCursor`, `ConsumeIdempotentlyInput`, `ConsumptionOutcome`, `ConsumerCursor` |

## The atomic mutation pattern (the whole point)

A command handler's state writes, its ledger append, and its outbox enqueue
all execute inside ONE `runInTransaction` call — they commit together or
vanish together (the frozen cross-view mutation flow, proven by test):

```ts
import { appendEvent, causedByCommand, enqueueOutbox } from '@office/events';

const outcome = await pool.runInTransaction(
  async (tx): Promise<Result<ProjectRecord, DomainError>> => {
    const project = await projects.insert(tx, scope, { projectId, name, now });
    if (!project.ok) return tx.rollback(fail(project.error));

    const event = await appendEvent(tx, {
      envelope: {
        kind: 'event',
        eventName: 'projects.projectCreated' as EventName,
        scope,                                   // the command's scope
        actor: command.actor,
        source: 'domain',
        causality: causedByCommand(command),     // correlation carried, causation = command key
        schemaVersion: CURRENT_SCHEMA_VERSION,
        occurredAt: now,
        entityRefs: { before: null, after: { entityKind: 'project', entityId: project.value.projectId } },
        payload: { projectId: project.value.projectId },
      },
      aggregate: { entityKind: 'project', entityId: project.value.projectId },
    });
    if (!event.ok) return tx.rollback(fail(event.error));

    const outbox = await enqueueOutbox(tx, event.value);
    if (!outbox.ok) return tx.rollback(fail(outbox.error));

    return project;                              // COMMIT: state + event + outbox
  },
);
```

`appendEvent` and `enqueueOutbox` take the `SqlExecutor` (the open
transaction) as their first argument and NEVER open their own transactions —
passing the pool instead of a transaction is a caller error that loses
atomicity. The outbox row carries a foreign key to the ledger event, so the
enqueue must run in the same transaction as (or after) the append — this is
what makes the append-then-enqueue order structural rather than conventional.

## Ledger semantics

- **Append-only and immutable, ever.** No code path updates or deletes ledger
  rows, and migration `0003` installs a trigger that rejects any `UPDATE` /
  `DELETE` on `event_ledger` at the database level — the guarantee survives
  even hand-written SQL.
- **Sequences are ledger-assigned, dense, and strictly monotonic per
  (tenant, aggregate).** Assignment happens inside the appending transaction
  via an `event_sequences` counter upsert whose exclusive row lock serializes
  concurrent appends for the same aggregate until commit; the counter row and
  the ledger row commit or vanish together (a rolled-back append frees its
  sequence). The `UNIQUE (tenant_id, aggregate_kind, aggregate_id, sequence)`
  constraint is the database-level net that makes duplicate sequences
  impossible regardless of the write path.
- **Event ids are deterministic** (`office-evt-v1-<sha256-prefix>`): derived
  from the ledger key (tenant, aggregate, sequence), so replaying the same
  command sequence against a fresh database reproduces identical ids — proven
  by the replay acceptance test. A ledger event id is always a valid
  `CausationId`, which is what lets downstream events point at the event that
  caused them (`causedByEvent`).
- **Scope by construction (A12).** The row's `tenant_id` / `project_id`
  columns come from the validated envelope's scope, never from caller input;
  every read (`readEventById`, `readAggregateEvents`) is composed through the
  persistence package's `scopedSql`, so a foreign-tenant event is a typed
  `not-found` with no existence oracle.
- **Fail-closed everything.** The envelope is revalidated through
  `parseDomainEventEnvelope` at the append boundary (the ledger is the system
  of record for history — garbage never gets stored), and every row decodes
  back through the contracts parsers (`row-corruption` `PersistenceFailure`
  on any drift). The ledger deliberately carries NO tenant foreign key:
  immutable history outlives entity lifecycle (a cascade would violate
  append-only immutability; RESTRICT would block tenant archival); the tenant
  boundary is enforced by scoped statements instead.
- **Multi-aggregate appends within one transaction** should order aggregates
  deterministically (kind, then id) to avoid theoretical counter-row deadlock
  between transactions appending to the same two aggregates in opposite
  orders.

## Outbox semantics (at-least-once dispatch)

- `enqueueOutbox(db, event)` inserts the pending row (`state='pending'`,
  `attempts=0`, `available_at` = event occurred-at, or an explicit later
  instant) with `created_at` from the envelope — no wall clock anywhere.
- `fetchPendingOutbox(db, scope, { now, limit })` returns due pending entries
  (joined with their full fail-closed-decoded ledger events) in insertion
  order — which per aggregate equals ledger sequence order, because
  same-aggregate appends serialize on the counter row lock until commit.
- `markDispatched` is **exactly-once-per-row** under duplicate processing:
  the transition runs only from `'pending'`, so a duplicate call is a no-op
  returning the already-dispatched record with `dispatched_at` untouched.
- `recordDispatchFailure` increments `attempts`, moves `available_at` to the
  caller's next-attempt-at (their backoff policy — the package never reads a
  clock), and stays pending; a late report for an already-dispatched row is a
  harmless no-op.

## Consumer cursor semantics (duplicate delivery is harmless)

Delivery is at-least-once (A3); `consumeIdempotently` makes consumers
idempotent. It runs the consumer's handler AND the durable cursor advance in
ONE `runInTransaction` call, keyed by (tenant, consumer name) with the last
consumed ledger sequence tracked PER AGGREGATE:

- re-delivered event (`sequence <= cursor`) → `'skipped-duplicate'`, handler
  never runs, nothing moves;
- next event (`sequence == cursor + 1`) → handler runs; handler writes +
  cursor advance commit atomically (a handler failure rolls both back —
  redelivery reprocesses);
- gap (`sequence > cursor + 1`) → typed `invariant-violation`
  (`consumer-ledger-gap`): a delivery-layer fault that fails closed rather
  than silently starving projections;
- a consumer's FIRST delivery establishes its position at any sequence (an
  absent cursor is an unstarted consumer, not a gap).

Race safety uses no advisory locks: the cursor row is claimed with
`INSERT ... ON CONFLICT DO NOTHING` (a conflicting uncommitted insert makes a
concurrent transaction WAIT until the first resolves — commit → it sees the
advanced cursor and skips; rollback → it claims), and the existing-row path
serializes on `SELECT ... FOR UPDATE`. Concurrent duplicate delivery processes
exactly once — proven by test, including the projection write happening
exactly once. The delivered event is also position-verified against the
ledger before anything runs, and cross-tenant consumption is a typed
`unauthorized` before any SQL executes.

## Causality propagation

- `causedByCommand(command)` → `{ correlationId: command.causality.correlationId, causationId: command.idempotencyKey }`
  — the command's correlation id rides forward, the causation id points at
  the causing message (the command's idempotency key).
- `causedByEvent(event)` → `{ correlationId: <carried forward>, causationId: event.eventId }`
  — a reaction event points its causation id at the prior event's ledger id.
- Chain roots carry `causationId: null`, stored and read back as null.

## Migrations

The package ships two forward-only migrations — `0003_event_ledger.sql`
(`event_sequences` + `event_ledger` + the append-only trigger) and
`0004_outbox.sql` (`event_outbox` + `consumer_cursors`) — under
`packages/events/migrations/`, named and ordered per the persistence
migrator's conventions (`<NNNN>_<snake_name>.sql`, transactional,
checksum-guarded, forward-only). They are hosted inside this package (the
OFF-005 ownership boundary) rather than `packages/persistence/migrations/`;
compose the full canonical chain by pointing the migrator at a directory
containing the persistence migrations plus these — exactly what the
integration suite does:

```ts
import { createMigrator, readMigrationFiles } from '@office/persistence';
import { EVENTS_MIGRATIONS_DIR } from '@office/events';

// one migrator run over the composed chain: 0001, 0002, 0003, 0004
const dir = await composeIntoTempDir([
  persistenceMigrationsDir,
  EVENTS_MIGRATIONS_DIR,
]);
await createMigrator(pool, { migrationsDir: dir }).migrate();
```

The files are drop-in movable into a single canonical migrations directory
verbatim (same numbering, same conventions) if the Tech Lead consolidates
them there.

## Verification

- `pnpm lint` / `pnpm typecheck` — clean at the repository root.
- `pnpm test` — `identity` (deterministic unit), `boundary` (package
  self-gate: dependencies, imports, provider vocabulary, append-only source
  rule, migration naming), and `integration` (the acceptance suite against
  real PostgreSQL in both harness modes — embedded local / `DATABASE_URL`
  CI): atomic state+event+outbox commit and rollback, duplicate-delivery
  harmlessness (sequential and concurrent), dense monotonic per-aggregate
  ordering with replay determinism on a fresh database, causation/correlation
  chains, outbox dispatch exactly-once semantics, cursor gap fail-closure,
  tenant isolation, and fail-closed row decoding.
