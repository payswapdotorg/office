import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  parseCommandEnvelope,
  parseDomainEventEnvelope,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  DomainEventEnvelope,
  EntityRef,
  ParseResult,
  ProjectId,
  Scope,
  TenantId,
} from '@office/contracts';
import { entityNotFound, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  createMigrator,
  createProjectsRepository,
  createTenantsRepository,
  readMigrationFiles,
  startPersistenceTestHarness,
} from '@office/persistence';
import type { MigrationFile, PersistencePool, PersistenceTestHarness } from '@office/persistence';
import {
  EVENTS_MIGRATIONS_DIR,
  appendEvent,
  causedByCommand,
  causedByEvent,
  consumeIdempotently,
  enqueueOutbox,
  fetchPendingOutbox,
  ledgerEventIdOf,
  markDispatched,
  parseConsumerName,
  parseLedgerEventId,
  parseLedgerSequence,
  readAggregateEvents,
  readConsumerCursor,
  readEventById,
  recordDispatchFailure,
} from './index';
import type { LedgerEvent, LedgerSequence, OutboxEntry } from './index';

// OFF-005 integration acceptance — one real PostgreSQL for the whole file
// (DATABASE_URL set → that server, CI mode; unset → embedded PostgreSQL 17,
// local mode; the persistence harness owns both). The pool binds to an EMPTY
// scratch database; the suite migrates the full canonical chain —
// persistence's 0001/0002 plus this package's 0003/0004, composed into one
// directory — from empty, in one migrator run.
//
// Everything is deterministic: fixed canonical ids, fixed injected
// timestamps, fixed names; no wall clock, no randomness.
//
// Acceptance suites, in order:
//   1. migrations — the events schema from an empty database (column shapes,
//      forward-only chain, idempotent re-run);
//   2. ledger append/read — deterministic ids, dense strictly monotonic
//      sequences, envelope round-trip, concurrency race-safety, rollback
//      density, tenant isolation;
//   3. ledger immutability — the append-only trigger rejects UPDATE/DELETE;
//   4. atomic mutation + event + outbox (THE acceptance) — commit together
//      or vanish together, including the failure-after-state-write case;
//   5. causation/correlation propagation through command → event → event
//      chains;
//   6. outbox dispatch lifecycle — due/limit/scope filters, exactly-once
//      dispatch marking, failure/retry bookkeeping;
//   7. idempotent consumer cursor — duplicate delivery is a no-op, gaps fail
//      closed, handler+cursor atomicity, concurrent duplicate races;
//   8. fail-closed row decoding (corrupt rows throw typed PersistenceFailure);
//   9. replay determinism — the same command sequence on a fresh scratch
//      database reproduces the identical ledger.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const expectOk = <T>(result: Result<T, DomainError>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

const expectFailure = <T>(result: Result<T, DomainError>): DomainError => {
  if (result.ok) throw new Error('expected a typed failure');
  return result.error;
};

// ----- fixed test data --------------------------------------------------------

const NOW_1 = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2 = unwrap(parseTimestamp('2026-09-12T11:30:00.000Z'));
const NOW_3 = unwrap(parseTimestamp('2026-09-12T12:45:10.000Z'));
const NOW_4 = unwrap(parseTimestamp('2026-09-12T14:00:00.000Z'));
const NOW_5 = unwrap(parseTimestamp('2026-09-12T15:20:00.000Z'));
const NOW_6 = unwrap(parseTimestamp('2026-09-12T16:40:00.000Z'));

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-aaaaaaaa11111111bbbbbbbb22222222'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-cccccccc33333333dddddddd44444444'));
const TENANT_REPLAY: TenantId = unwrap(
  parseTenantId('office-tnt-v1-eeeeeeee55555555ffffffff66666666'),
);

const USER_ACTOR_ID = unwrap(parseEntityId('office-ent-v1-10101010101010101010101010101010'));
const AGG_ACTIVITY: EntityRef = {
  entityKind: unwrap(parseEntityKind('schedule-activity')),
  entityId: unwrap(parseEntityId('office-ent-v1-20202020202020202020202020202020')),
};
const AGG_ISSUE: EntityRef = {
  entityKind: unwrap(parseEntityKind('field-issue')),
  entityId: unwrap(parseEntityId('office-ent-v1-30303030303030303030303030303030')),
};
const AGG_BUDGET: EntityRef = {
  entityKind: unwrap(parseEntityKind('cost-budget')),
  entityId: unwrap(parseEntityId('office-ent-v1-40404040404040404040404040404040')),
};
const AGG_REPLAY: EntityRef = {
  entityKind: unwrap(parseEntityKind('schedule-activity')),
  entityId: unwrap(parseEntityId('office-ent-v1-50505050505050505050505050505050')),
};
const AGG_CONCURRENT: EntityRef = {
  entityKind: unwrap(parseEntityKind('schedule-activity')),
  entityId: unwrap(parseEntityId('office-ent-v1-60606060606060606060606060606060')),
};

const PROJECT_ATOMIC: ProjectId = unwrap(
  parseProjectId('office-prj-v1-70707070707070707070707070707070'),
);
const PROJECT_ATOMIC_ROLLBACK: ProjectId = unwrap(
  parseProjectId('office-prj-v1-71717171717171717171717171717171'),
);
const PROJECT_ATOMIC_VALUE: ProjectId = unwrap(
  parseProjectId('office-prj-v1-72727272727272727272727272727272'),
);
const PROJECT_SCOPED: ProjectId = unwrap(
  parseProjectId('office-prj-v1-73737373737373737373737373737373'),
);
const PROJECT_C1: ProjectId = unwrap(
  parseProjectId('office-prj-v1-81818181818181818181818181818181'),
);
const PROJECT_C2: ProjectId = unwrap(
  parseProjectId('office-prj-v1-82828282828282828282828282828282'),
);
const PROJECT_FAIL: ProjectId = unwrap(
  parseProjectId('office-prj-v1-84848484848484848484848484848484'),
);
const PROJECT_CONCURRENT: ProjectId = unwrap(
  parseProjectId('office-prj-v1-85858585858585858585858585858585'),
);

const CORR_A = 'corr-aaaaaaaa11111111';
const CORR_CHAIN = 'corr-bbbbbbbb22222222';
const CORR_B = 'corr-dddddddd44444444';
const IDEM_CHAIN = 'idem-cccccccc33333333';

const seq = (value: number): LedgerSequence => unwrap(parseLedgerSequence(value));

const CONSUMER_PROJECTIONS = unwrap(parseConsumerName('projections.activities'));
const CONSUMER_AUDIT = unwrap(parseConsumerName('audit'));
const CONSUMER_LATE = unwrap(parseConsumerName('audit.late'));

const scopeTenantA: Scope = { kind: 'tenant', tenantId: TENANT_A };
const scopeTenantB: Scope = { kind: 'tenant', tenantId: TENANT_B };
const scopeTenantReplay: Scope = { kind: 'tenant', tenantId: TENANT_REPLAY };
const scopeProjectScoped: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_SCOPED };

/** Build a validated event envelope from parts (fail-closed through the parser). */
const envelope = (
  over: {
    eventName?: string;
    scope?: Scope;
    causality?: { correlationId: string; causationId: string | null };
    occurredAt?: DomainEventEnvelope['occurredAt'];
    entityRefs?: { before: EntityRef | null; after: EntityRef | null };
    payload?: Record<string, unknown>;
  },
): DomainEventEnvelope =>
  unwrap(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName: 'schedule.activityCompleted',
      scope: scopeTenantA,
      actor: { kind: 'user', actorId: USER_ACTOR_ID },
      source: 'domain',
      causality: { correlationId: CORR_A, causationId: null },
      schemaVersion: CURRENT_SCHEMA_VERSION,
      occurredAt: NOW_1,
      entityRefs: { before: null, after: AGG_ACTIVITY },
      payload: { activityName: 'Pour foundations', quantity: 42.5 },
      ...over,
    }),
  );

/** Append one event inside its own transaction; returns the LedgerEvent. */
const append = async (
  pool: PersistencePool,
  input: { envelope: DomainEventEnvelope; aggregate: EntityRef },
): Promise<LedgerEvent> =>
  expectOk(await pool.runInTransaction(async (tx) => appendEvent(tx, { ...input })));

// ----- harness boot + combined migration + shared seed ------------------------

let harness: PersistenceTestHarness;
let pool: PersistencePool;
let migrationRun: { applied: readonly MigrationFile[]; verified: readonly MigrationFile[] };

const fixtureDirs: string[] = [];

/** Compose the full canonical migration chain (persistence + events) into one temp dir. */
const combinedMigrationsDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'office-events-migrations-'));
  const files = [
    ...(await readMigrationFiles(harness.migrationsDir)),
    ...(await readMigrationFiles(EVENTS_MIGRATIONS_DIR)),
  ];
  for (const file of files) {
    await writeFile(join(dir, file.fileName), file.text, 'utf8');
  }
  fixtureDirs.push(dir);
  return dir;
};

beforeAll(async () => {
  harness = await startPersistenceTestHarness();
  pool = harness.pool;

  // Migration gate: the scratch database is EMPTY here; the composed chain
  // applies 0001, 0002 (persistence) + 0003, 0004 (events) in one run.
  const migrationsDir = await combinedMigrationsDir();
  migrationRun = await createMigrator(pool, { migrationsDir, now: () => NOW_1 }).migrate();

  // Shared fixture tenant rows (the atomicity suite mutates projects).
  const tenants = createTenantsRepository();
  expectOk(await tenants.insert(pool, { tenantId: TENANT_A, displayName: 'Tenant A', now: NOW_1 }));
  expectOk(await tenants.insert(pool, { tenantId: TENANT_B, displayName: 'Tenant B', now: NOW_1 }));
}, 180_000);

afterAll(async () => {
  await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await harness.stop();
}, 120_000);

// ----- 1. migrations -----------------------------------------------------------

describe('migrations — events schema from an empty database (acceptance)', () => {
  it('applies the full canonical chain in version order', () => {
    expect(migrationRun.applied.map((file) => file.version)).toStrictEqual([1, 2, 3, 4]);
    expect(migrationRun.applied.map((file) => file.name)).toStrictEqual([
      'tenants',
      'projects',
      'event_ledger',
      'outbox',
    ]);
    expect(migrationRun.verified).toStrictEqual([]);
  });

  it('re-running the composed chain is a verified no-op (idempotent, forward-only)', async () => {
    const dir = await combinedMigrationsDir();
    const rerun = await createMigrator(pool, { migrationsDir: dir, now: () => NOW_1 }).migrate();
    expect(rerun.applied).toStrictEqual([]);
    expect(rerun.verified.map((file) => file.version)).toStrictEqual([1, 2, 3, 4]);
  });

  it('creates event_ledger with the frozen column shapes (A2/A3/A12)', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'event_ledger'
       ORDER BY ordinal_position`,
    );
    expect(
      result.rows.map((row) => [row['column_name'], row['data_type'], row['is_nullable']]),
    ).toStrictEqual([
      ['tenant_id', 'text', 'NO'],
      ['event_id', 'text', 'NO'],
      ['aggregate_kind', 'text', 'NO'],
      ['aggregate_id', 'text', 'NO'],
      ['sequence', 'bigint', 'NO'],
      ['event_name', 'text', 'NO'],
      ['project_id', 'text', 'YES'],
      ['actor', 'jsonb', 'NO'],
      ['source', 'text', 'NO'],
      ['correlation_id', 'text', 'NO'],
      ['causation_id', 'text', 'YES'],
      ['schema_version', 'text', 'NO'],
      ['occurred_at', 'timestamp with time zone', 'NO'],
      ['entity_refs', 'jsonb', 'NO'],
      ['payload', 'jsonb', 'NO'],
    ]);
  });

  it('creates event_outbox and consumer_cursors with the frozen column shapes', async () => {
    const outbox = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'event_outbox'
       ORDER BY ordinal_position`,
    );
    expect(
      outbox.rows.map((row) => [row['column_name'], row['data_type'], row['is_nullable']]),
    ).toStrictEqual([
      ['outbox_id', 'bigint', 'NO'],
      ['tenant_id', 'text', 'NO'],
      ['project_id', 'text', 'YES'],
      ['event_id', 'text', 'NO'],
      ['state', 'text', 'NO'],
      ['attempts', 'bigint', 'NO'],
      ['available_at', 'timestamp with time zone', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['dispatched_at', 'timestamp with time zone', 'YES'],
    ]);
    const cursors = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'consumer_cursors'
       ORDER BY ordinal_position`,
    );
    expect(
      cursors.rows.map((row) => [row['column_name'], row['data_type'], row['is_nullable']]),
    ).toStrictEqual([
      ['tenant_id', 'text', 'NO'],
      ['consumer_name', 'text', 'NO'],
      ['aggregate_kind', 'text', 'NO'],
      ['aggregate_id', 'text', 'NO'],
      ['last_sequence', 'bigint', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
  });
});

// ----- 2. ledger append + read -------------------------------------------------

describe('ledger — append, sequence assignment, reads (acceptance)', () => {
  // Fixed envelopes for the AGG_ACTIVITY stream (also consumed by suites 5–7).
  const firstEnvelope = envelope({
    occurredAt: NOW_1,
    payload: { activityName: 'Pour foundations', quantity: 42.5 },
  });
  const secondEnvelope = envelope({ occurredAt: NOW_3, payload: { activityName: 'Cure slab', quantity: 1 } });
  const thirdEnvelope = envelope({ occurredAt: NOW_2, payload: { activityName: 'Strip forms', quantity: 3 } });
  let firstEvent: LedgerEvent;

  it('assigns sequence 1 and a deterministic id to the first event of an aggregate', async () => {
    firstEvent = await append(pool, { envelope: firstEnvelope, aggregate: AGG_ACTIVITY });
    expect(firstEvent.sequence).toBe(1);
    expect(firstEvent.aggregate).toStrictEqual(AGG_ACTIVITY);
    expect(unwrap(parseLedgerEventId(firstEvent.eventId))).toBe(firstEvent.eventId);
    expect(firstEvent.eventId).toBe(
      ledgerEventIdOf({ tenantId: TENANT_A, aggregate: AGG_ACTIVITY, sequence: seq(1) }),
    );
  });

  it('round-trips the whole envelope fail-closed (read-back equality)', async () => {
    const read = expectOk(await readEventById(pool, scopeTenantA, firstEvent.eventId));
    expect(read.eventId).toBe(firstEvent.eventId);
    expect(read.sequence).toBe(1);
    expect(read.aggregate).toStrictEqual(AGG_ACTIVITY);
    expect(read.envelope).toStrictEqual(firstEnvelope);
  });

  it('assigns dense strictly monotonic sequences per (tenant, aggregate)', async () => {
    const second = await append(pool, { envelope: secondEnvelope, aggregate: AGG_ACTIVITY });
    const third = await append(pool, { envelope: thirdEnvelope, aggregate: AGG_ACTIVITY });
    expect(second.sequence).toBe(2);
    expect(third.sequence).toBe(3);

    // Ordering follows append (sequence) order, NOT occurredAt order: the
    // third event occurred BEFORE the second, but sequences stay monotonic
    // and the stream reads back in ledger order.
    expect(third.envelope.occurredAt < second.envelope.occurredAt).toBe(true);
    const stream = expectOk(await readAggregateEvents(pool, scopeTenantA, AGG_ACTIVITY));
    expect(stream.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);
    expect(stream.map((event) => event.envelope.payload)).toStrictEqual([
      firstEnvelope.payload,
      secondEnvelope.payload,
      thirdEnvelope.payload,
    ]);
  });

  it('independent aggregates each start at sequence 1', async () => {
    const issueEvent = await append(pool, {
      envelope: envelope({
        eventName: 'field.observationRecorded',
        entityRefs: { before: null, after: AGG_ISSUE },
        payload: { note: 'Crack observed in east wall' },
      }),
      aggregate: AGG_ISSUE,
    });
    expect(issueEvent.sequence).toBe(1);
    const issueStream = expectOk(await readAggregateEvents(pool, scopeTenantA, AGG_ISSUE));
    expect(issueStream.map((event) => event.sequence)).toStrictEqual([1]);
  });

  it('is race-safe: concurrent appends for the same aggregate commit both, sequences dense', async () => {
    const results = await Promise.all(
      [1, 2].map((n) =>
        pool.runInTransaction(async (tx) =>
          appendEvent(tx, {
            envelope: envelope({
              occurredAt: NOW_4,
              payload: { activityName: `Concurrent ${n}`, quantity: n },
            }),
            aggregate: AGG_CONCURRENT,
          }),
        ),
      ),
    );
    const sequences = results.map((result) => expectOk(result).sequence).sort((a, b) => a - b);
    expect(sequences).toStrictEqual([1, 2]);
    const ids = new Set(results.map((result) => expectOk(result).eventId));
    expect(ids.size).toBe(2);
    const stream = expectOk(await readAggregateEvents(pool, scopeTenantA, AGG_CONCURRENT));
    expect(stream.map((event) => event.sequence)).toStrictEqual([1, 2]);
  });

  it('a rolled-back append frees its sequence (counter and row vanish together)', async () => {
    const first = await append(pool, {
      envelope: envelope({ occurredAt: NOW_4, payload: { activityName: 'Budget baseline', quantity: 0 } }),
      aggregate: AGG_BUDGET,
    });
    expect(first.sequence).toBe(1);
    await expect(
      pool.runInTransaction(async (tx) => {
        await appendEvent(tx, {
          envelope: envelope({
            eventName: 'cost.budgetLineUpdated',
            entityRefs: { before: null, after: AGG_BUDGET },
            payload: { line: 'Concrete', amount: 1000 },
          }),
          aggregate: AGG_BUDGET,
        });
        throw new Error('boom: simulated append failure');
      }),
    ).rejects.toThrow('boom: simulated append failure');
    // Sequence 2 was assigned inside the rolled-back transaction and is free
    // again: the next append takes it, and the stream stays dense.
    const next = await append(pool, {
      envelope: envelope({
        eventName: 'cost.budgetLineUpdated',
        entityRefs: { before: null, after: AGG_BUDGET },
        payload: { line: 'Steel', amount: 2000 },
      }),
      aggregate: AGG_BUDGET,
    });
    expect(next.sequence).toBe(2);
    const stream = expectOk(await readAggregateEvents(pool, scopeTenantA, AGG_BUDGET));
    expect(stream.map((event) => event.sequence)).toStrictEqual([1, 2]);
  });

  it('re-validates the envelope fail-closed at the ledger boundary', async () => {
    const invalid = {
      ...envelope({}),
      eventName: 'not-a-valid-event-name',
    } as unknown as DomainEventEnvelope;
    const failure = expectFailure(
      await appendEvent(pool, { envelope: invalid, aggregate: AGG_ACTIVITY }),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('event-envelope-valid');
  });

  it('tenant isolation: tenant B cannot read tenant A events (no existence oracle)', async () => {
    const foreign = expectFailure(await readEventById(pool, scopeTenantB, firstEvent.eventId));
    expect(foreign.code).toBe('not-found');
    expect(foreign.details[0]?.code).toBe('ledger-event-not-found');
    const missing = expectFailure(
      await readEventById(
        pool,
        scopeTenantA,
        ledgerEventIdOf({ tenantId: TENANT_A, aggregate: AGG_ACTIVITY, sequence: seq(9999) }),
      ),
    );
    expect(missing.code).toBe('not-found');
    expect(missing.details[0]?.code).toBe(foreign.details[0]?.code);
    const emptyStream = expectOk(await readAggregateEvents(pool, scopeTenantB, AGG_ACTIVITY));
    expect(emptyStream).toStrictEqual([]);
  });
});

// ----- 3. ledger immutability ---------------------------------------------------

describe('ledger immutability — append-only, ever (acceptance)', () => {
  it('rejects UPDATE on ledger rows at the database level', async () => {
    await expect(
      pool.query('UPDATE event_ledger SET event_name = $1 WHERE tenant_id = $2', [
        'tampered.eventName',
        TENANT_A,
      ]),
    ).rejects.toThrow(/append-only and immutable/);
  });

  it('rejects DELETE on ledger rows at the database level', async () => {
    await expect(
      pool.query('DELETE FROM event_ledger WHERE tenant_id = $1', [TENANT_A]),
    ).rejects.toThrow(/append-only and immutable/);
  });
});

// ----- 4. atomic mutation + event + outbox --------------------------------------

describe('atomic state + event + outbox commit (THE acceptance)', () => {
  const projects = createProjectsRepository();
  const projectAggregate = (projectId: ProjectId): EntityRef => ({
    entityKind: unwrap(parseEntityKind('project')),
    entityId: projectId,
  });
  const projectCreatedEvent = (projectId: ProjectId): DomainEventEnvelope =>
    envelope({
      eventName: 'projects.projectCreated',
      entityRefs: { before: null, after: projectAggregate(projectId) },
      payload: { projectId },
    });

  it('commits the mutation, the ledger event, and the outbox row together', async () => {
    const committed = await pool.runInTransaction(async (tx) => {
      const project = expectOk(
        await projects.insert(tx, scopeTenantA, {
          projectId: PROJECT_ATOMIC,
          name: 'Riverside Hospital',
          now: NOW_1,
        }),
      );
      const event = expectOk(
        await appendEvent(tx, {
          envelope: projectCreatedEvent(PROJECT_ATOMIC),
          aggregate: projectAggregate(PROJECT_ATOMIC),
        }),
      );
      const outbox = expectOk(await enqueueOutbox(tx, event));
      return { project, event, outbox };
    });

    expect(committed.project.version).toBe(1);
    expect(committed.event.sequence).toBe(1);
    expect(committed.outbox.state).toBe('pending');
    expect(committed.outbox.attempts).toBe(0);
    expect(committed.outbox.availableAt).toBe(NOW_1);

    // All three committed: the project row, the ledger row, the outbox row.
    const project = expectOk(await projects.findById(pool, scopeTenantA, PROJECT_ATOMIC));
    expect(project.name).toBe('Riverside Hospital');
    const event = expectOk(await readEventById(pool, scopeTenantA, committed.event.eventId));
    expect(event.envelope.payload).toStrictEqual({ projectId: PROJECT_ATOMIC });
    const pending = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_2, limit: 10 }));
    expect(pending.map((entry) => entry.record.eventId)).toContain(committed.event.eventId);
  });

  it('a failure after the state write discards state, event, AND outbox — no partial anything', async () => {
    const aggregate = projectAggregate(PROJECT_ATOMIC_ROLLBACK);
    await expect(
      pool.runInTransaction(async (tx) => {
        expectOk(
          await projects.insert(tx, scopeTenantA, {
            projectId: PROJECT_ATOMIC_ROLLBACK,
            name: 'Never Committed',
            now: NOW_1,
          }),
        );
        const event = expectOk(
          await appendEvent(tx, {
            envelope: projectCreatedEvent(PROJECT_ATOMIC_ROLLBACK),
            aggregate,
          }),
        );
        expectOk(await enqueueOutbox(tx, event));
        // The failure happens AFTER every write of the attempt.
        throw new Error('boom: simulated handler failure after state write');
      }),
    ).rejects.toThrow('boom: simulated handler failure after state write');

    // NO partial anything: the state write is gone...
    const missing = await projects.findById(pool, scopeTenantA, PROJECT_ATOMIC_ROLLBACK);
    expect(expectFailure(missing).code).toBe('not-found');
    // ...the event is gone...
    const gone = expectFailure(
      await readEventById(
        pool,
        scopeTenantA,
        ledgerEventIdOf({ tenantId: TENANT_A, aggregate, sequence: seq(1) }),
      ),
    );
    expect(gone.code).toBe('not-found');
    // ...and the outbox row is gone.
    const pending = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_2, limit: 50 }));
    const leaked = pending.filter((entry) => entry.event.aggregate.entityId === aggregate.entityId);
    expect(leaked).toStrictEqual([]);
  });

  it('tx.rollback(value) discards everything and returns the typed failure', async () => {
    const aggregate = projectAggregate(PROJECT_ATOMIC_VALUE);
    const outcome = await pool.runInTransaction(
      async (tx): Promise<Result<never, DomainError>> => {
        expectOk(
          await projects.insert(tx, scopeTenantA, {
            projectId: PROJECT_ATOMIC_VALUE,
            name: 'Rolled Back With Value',
            now: NOW_1,
          }),
        );
        const event = expectOk(
          await appendEvent(tx, {
            envelope: projectCreatedEvent(PROJECT_ATOMIC_VALUE),
            aggregate,
          }),
        );
        expectOk(await enqueueOutbox(tx, event));
        return tx.rollback(fail(entityNotFound(aggregate)));
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('not-found');
    }
    const missing = await projects.findById(pool, scopeTenantA, PROJECT_ATOMIC_VALUE);
    expect(expectFailure(missing).code).toBe('not-found');
  });

  it('enqueueOutbox requires the append first (same transaction), fail-closed', async () => {
    const fabricated: LedgerEvent = {
      eventId: ledgerEventIdOf({ tenantId: TENANT_A, aggregate: AGG_ISSUE, sequence: seq(42) }),
      sequence: seq(42),
      aggregate: AGG_ISSUE,
      envelope: envelope({}),
    };
    const failure = expectFailure(await enqueueOutbox(pool, fabricated));
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('outbox-event-not-in-ledger');
  });

  it('a committed outbox row cannot be enqueued again (one row per event)', async () => {
    const event = await append(pool, {
      envelope: envelope({
        eventName: 'cost.budgetLineUpdated',
        entityRefs: { before: null, after: AGG_BUDGET },
        payload: { line: 'Enqueue-once', amount: 5 },
      }),
      aggregate: AGG_BUDGET,
    });
    expectOk(await pool.runInTransaction(async (tx) => enqueueOutbox(tx, event)));
    const duplicate = await pool.runInTransaction(async (tx) => enqueueOutbox(tx, event));
    const failure = expectFailure(duplicate);
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('outbox-entry-already-exists');
    const pending = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_6, limit: 50 }));
    expect(pending.filter((entry) => entry.record.eventId === event.eventId).length).toBe(1);
  });
});

// ----- 5. causation / correlation propagation ------------------------------------

describe('causation/correlation propagation (acceptance)', () => {
  it('carries the command correlation forward and points causation at the command key', async () => {
    const command = unwrap(
      parseCommandEnvelope({
        kind: 'command',
        commandName: 'schedule.completeActivity',
        scope: scopeTenantA,
        actor: { kind: 'user', actorId: USER_ACTOR_ID },
        idempotencyKey: IDEM_CHAIN,
        causality: { correlationId: CORR_CHAIN, causationId: null },
        issuedAt: NOW_2,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        payload: { activityId: AGG_ACTIVITY.entityId },
      }),
    );
    const causality = causedByCommand(command);
    expect(causality).toStrictEqual({ correlationId: CORR_CHAIN, causationId: IDEM_CHAIN });

    const event = await append(pool, {
      envelope: envelope({ causality, occurredAt: NOW_2, payload: { step: 'command-caused' } }),
      aggregate: AGG_ACTIVITY,
    });
    const read = expectOk(await readEventById(pool, scopeTenantA, event.eventId));
    expect(read.envelope.causality).toStrictEqual({
      correlationId: CORR_CHAIN,
      causationId: IDEM_CHAIN,
    });
  });

  it('chains events: correlation constant, causation points at the prior event id', async () => {
    const first = await append(pool, {
      envelope: envelope({
        causality: { correlationId: CORR_CHAIN, causationId: IDEM_CHAIN },
        occurredAt: NOW_3,
        payload: { step: 1 },
      }),
      aggregate: AGG_ACTIVITY,
    });
    const second = await append(pool, {
      envelope: envelope({
        causality: causedByEvent(first),
        occurredAt: NOW_4,
        payload: { step: 2 },
      }),
      aggregate: AGG_ACTIVITY,
    });
    const third = await append(pool, {
      envelope: envelope({
        causality: causedByEvent(second),
        occurredAt: NOW_5,
        payload: { step: 3 },
      }),
      aggregate: AGG_ACTIVITY,
    });

    const [r1, r2, r3] = [
      expectOk(await readEventById(pool, scopeTenantA, first.eventId)),
      expectOk(await readEventById(pool, scopeTenantA, second.eventId)),
      expectOk(await readEventById(pool, scopeTenantA, third.eventId)),
    ];
    // The correlation id rides the whole chain unchanged...
    expect(r1.envelope.causality.correlationId).toBe(CORR_CHAIN);
    expect(r2.envelope.causality.correlationId).toBe(CORR_CHAIN);
    expect(r3.envelope.causality.correlationId).toBe(CORR_CHAIN);
    // ...and each causation id points at the message that caused it.
    expect(r1.envelope.causality.causationId).toBe(IDEM_CHAIN);
    expect(r2.envelope.causality.causationId).toBe(r1.eventId);
    expect(r3.envelope.causality.causationId).toBe(r2.eventId);
  });

  it('stores chain roots with causationId null and reads them back as null', async () => {
    const root = await append(pool, {
      envelope: envelope({
        causality: { correlationId: CORR_B, causationId: null },
        payload: { step: 'root' },
      }),
      aggregate: AGG_ISSUE,
    });
    const read = expectOk(await readEventById(pool, scopeTenantA, root.eventId));
    expect(read.envelope.causality).toStrictEqual({ correlationId: CORR_B, causationId: null });
  });

  it('project-scoped events store the project column and read back under project scope', async () => {
    const event = await append(pool, {
      envelope: envelope({
        scope: scopeProjectScoped,
        eventName: 'field.observationRecorded',
        entityRefs: { before: null, after: AGG_ISSUE },
        payload: { note: 'Scoped observation' },
      }),
      aggregate: AGG_ISSUE,
    });
    expect(event.envelope.scope).toStrictEqual(scopeProjectScoped);
    const read = expectOk(await readEventById(pool, scopeProjectScoped, event.eventId));
    expect(read.envelope.scope).toStrictEqual(scopeProjectScoped);
    // Tenant scope sees it too (the project boundary is a subset)...
    const tenantRead = expectOk(await readEventById(pool, scopeTenantA, event.eventId));
    expect(tenantRead.eventId).toBe(event.eventId);
    // ...but a DIFFERENT project scope does not (typed not-found).
    const otherProject: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ATOMIC };
    const foreign = expectFailure(await readEventById(pool, otherProject, event.eventId));
    expect(foreign.code).toBe('not-found');
  });
});

// ----- 6. outbox dispatch lifecycle ----------------------------------------------

describe('outbox dispatch lifecycle (acceptance)', () => {
  const immediateEvents: LedgerEvent[] = [];
  let scopedEvent: LedgerEvent;
  let futureEvent: LedgerEvent;
  let tenantBEvent: LedgerEvent;

  beforeAll(async () => {
    // Three tenant-scoped events for tenant A (available immediately).
    for (const n of [1, 2, 3]) {
      const event = await append(pool, {
        envelope: envelope({ occurredAt: NOW_2, payload: { dispatch: n } }),
        aggregate: AGG_ACTIVITY,
      });
      expectOk(await pool.runInTransaction(async (tx) => enqueueOutbox(tx, event)));
      immediateEvents.push(event);
    }
    // One project-scoped event (available immediately).
    scopedEvent = await append(pool, {
      envelope: envelope({
        scope: scopeProjectScoped,
        eventName: 'field.observationRecorded',
        entityRefs: { before: null, after: AGG_ISSUE },
        payload: { dispatch: 'scoped' },
      }),
      aggregate: AGG_ISSUE,
    });
    expectOk(await pool.runInTransaction(async (tx) => enqueueOutbox(tx, scopedEvent)));
    // One future-dated event (available only from NOW_6).
    futureEvent = await append(pool, {
      envelope: envelope({ occurredAt: NOW_2, payload: { dispatch: 'future' } }),
      aggregate: AGG_ACTIVITY,
    });
    expectOk(
      await pool.runInTransaction(async (tx) =>
        enqueueOutbox(tx, futureEvent, { availableAt: NOW_6 }),
      ),
    );
    // One event for tenant B (isolation probe).
    tenantBEvent = await append(pool, {
      envelope: envelope({
        scope: scopeTenantB,
        causality: { correlationId: CORR_B, causationId: null },
        payload: { dispatch: 'tenant-b' },
      }),
      aggregate: AGG_ISSUE,
    });
    expectOk(await pool.runInTransaction(async (tx) => enqueueOutbox(tx, tenantBEvent)));
  }, 60_000);

  it('fetches due pending entries in insertion order with the joined events', async () => {
    const pending = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_3, limit: 50 }));
    const ids = pending.map((entry) => entry.record.eventId);
    // The three immediate events + the project-scoped one are due; the
    // future-dated one is not; tenant B's is invisible.
    for (const event of [...immediateEvents, scopedEvent]) {
      expect(ids).toContain(event.eventId);
    }
    expect(ids).not.toContain(futureEvent.eventId);
    expect(ids).not.toContain(tenantBEvent.eventId);
    // Insertion order: outbox_id ascending.
    const order = pending.map((entry) => entry.record.outboxId);
    expect(order).toStrictEqual([...order].sort((a, b) => a - b));
    // The joined event is the full fail-closed decoded ledger event.
    const entry: OutboxEntry | undefined = pending.find(
      (candidate) => candidate.record.eventId === (immediateEvents[0] as LedgerEvent).eventId,
    );
    expect(entry).toBeDefined();
    expect(entry?.event.aggregate).toStrictEqual(AGG_ACTIVITY);
    expect(entry?.event.envelope.payload).toStrictEqual({ dispatch: 1 });
    expect(entry?.record.state).toBe('pending');
    expect(entry?.record.attempts).toBe(0);
  });

  it('respects the fetch limit', async () => {
    const limited = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_3, limit: 2 }));
    expect(limited.length).toBe(2);
    const all = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_3, limit: 50 }));
    expect(limited.map((entry) => entry.record.outboxId)).toStrictEqual(
      all.slice(0, 2).map((entry) => entry.record.outboxId),
    );
  });

  it('scopes by project: a project-scoped fetch sees exactly its own rows', async () => {
    const pending = expectOk(
      await fetchPendingOutbox(pool, scopeProjectScoped, { now: NOW_3, limit: 50 }),
    );
    expect(pending.map((entry) => entry.record.eventId)).toStrictEqual([scopedEvent.eventId]);
  });

  it('isolates tenants: tenant B sees only its own rows', async () => {
    const pending = expectOk(await fetchPendingOutbox(pool, scopeTenantB, { now: NOW_3, limit: 50 }));
    expect(pending.map((entry) => entry.record.eventId)).toStrictEqual([tenantBEvent.eventId]);
  });

  it('marks rows dispatched exactly-once-per-row under duplicate processing', async () => {
    const all = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_3, limit: 50 }));
    const target = all[0] as OutboxEntry;
    const first = expectOk(
      await markDispatched(pool, scopeTenantA, target.record.outboxId, { now: NOW_3 }),
    );
    expect(first.state).toBe('dispatched');
    expect(first.dispatchedAt).toBe(NOW_3);
    // Duplicate processing (another worker, a later clock): no-op — the
    // dispatch instant is NOT rewritten.
    const duplicate = expectOk(
      await markDispatched(pool, scopeTenantA, target.record.outboxId, { now: NOW_4 }),
    );
    expect(duplicate.state).toBe('dispatched');
    expect(duplicate.dispatchedAt).toBe(NOW_3);
    // The row is no longer fetchable as pending.
    const pending = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_4, limit: 50 }));
    expect(pending.map((entry) => entry.record.eventId)).not.toContain(target.record.eventId);
  });

  it('marks a missing outbox row as a typed not-found', async () => {
    const failure = expectFailure(await markDispatched(pool, scopeTenantA, 999999, { now: NOW_3 }));
    expect(failure.code).toBe('not-found');
    expect(failure.details[0]?.code).toBe('outbox-entry-not-found');
  });

  it('records dispatch failures with retry bookkeeping, then dispatches', async () => {
    const all = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_3, limit: 50 }));
    const target = all[0] as OutboxEntry;
    // The first attempt failed: retry becomes due at NOW_5.
    const failed = expectOk(
      await recordDispatchFailure(pool, scopeTenantA, target.record.outboxId, {
        nextAttemptAt: NOW_5,
      }),
    );
    expect(failed.state).toBe('pending');
    expect(failed.attempts).toBe(1);
    expect(failed.availableAt).toBe(NOW_5);
    // Not due before NOW_5...
    const before = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_4, limit: 50 }));
    expect(before.map((entry) => entry.record.eventId)).not.toContain(target.record.eventId);
    // ...due from NOW_5 on, with the failure count visible...
    const after = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_5, limit: 50 }));
    const retried = after.find((entry) => entry.record.eventId === target.record.eventId);
    expect(retried?.record.attempts).toBe(1);
    // ...and dispatchable for good.
    const dispatched = expectOk(
      await markDispatched(pool, scopeTenantA, target.record.outboxId, { now: NOW_5 }),
    );
    expect(dispatched.state).toBe('dispatched');
    expect(dispatched.attempts).toBe(1);
    // A late failure report for the dispatched row is a harmless no-op.
    const late = expectOk(
      await recordDispatchFailure(pool, scopeTenantA, target.record.outboxId, {
        nextAttemptAt: NOW_6,
      }),
    );
    expect(late.state).toBe('dispatched');
    expect(late.attempts).toBe(1);
    expect(late.availableAt).toBe(NOW_5);
  });

  it('respects the future-dated availability window', async () => {
    const atNow5 = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_5, limit: 50 }));
    expect(atNow5.map((entry) => entry.record.eventId)).not.toContain(futureEvent.eventId);
    const atNow6 = expectOk(await fetchPendingOutbox(pool, scopeTenantA, { now: NOW_6, limit: 50 }));
    expect(atNow6.map((entry) => entry.record.eventId)).toContain(futureEvent.eventId);
  });
});

// ----- 7. idempotent consumer cursor ---------------------------------------------

describe('idempotent consumer cursor (acceptance)', () => {
  const projects = createProjectsRepository();
  let stream: readonly LedgerEvent[] = [];
  let handlerRuns = 0;

  beforeAll(async () => {
    // The AGG_ACTIVITY stream grew through suites 2, 5, and 6; the cursor
    // semantics are exercised on the full stream from sequence 1.
    stream = expectOk(await readAggregateEvents(pool, scopeTenantA, AGG_ACTIVITY));
    expect(stream.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('processes the first delivery: handler runs, cursor advances atomically', async () => {
    const first = stream[0] as LedgerEvent;
    const outcome = await consumeIdempotently(pool, {
      tenantId: TENANT_A,
      consumerName: CONSUMER_PROJECTIONS,
      event: first,
      now: NOW_3,
      handle: async (tx) => {
        handlerRuns += 1;
        expectOk(
          await projects.insert(tx, scopeTenantA, {
            projectId: PROJECT_C1,
            name: 'Activity Projection',
            now: NOW_3,
          }),
        );
        return ok(1);
      },
    });
    const result = expectOk(outcome);
    if (result.status !== 'processed') {
      throw new Error(`expected processed, got ${JSON.stringify(result)}`);
    }
    expect(result.effect).toBe(1);
    expect(handlerRuns).toBe(1);
    const cursor = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_PROJECTIONS, AGG_ACTIVITY),
    );
    expect(cursor?.lastSequence).toBe(first.sequence);
    expect(cursor?.updatedAt).toBe(NOW_3);
    // The handler's projection write committed WITH the cursor.
    expect(expectOk(await projects.findById(pool, scopeTenantA, PROJECT_C1)).name).toBe(
      'Activity Projection',
    );
  });

  it('re-consuming the same event is a no-op (same cursor position, same event id)', async () => {
    const first = stream[0] as LedgerEvent;
    const outcome = await consumeIdempotently(pool, {
      tenantId: TENANT_A,
      consumerName: CONSUMER_PROJECTIONS,
      event: first,
      now: NOW_4,
      handle: async () => {
        handlerRuns += 1;
        return ok(-1);
      },
    });
    const result = expectOk(outcome);
    if (result.status !== 'skipped-duplicate') {
      throw new Error(`expected skipped-duplicate, got ${JSON.stringify(result)}`);
    }
    expect(result.lastSequence).toBe(first.sequence);
    // The handler did NOT run and the cursor did not move.
    expect(handlerRuns).toBe(1);
    const cursor = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_PROJECTIONS, AGG_ACTIVITY),
    );
    expect(cursor?.lastSequence).toBe(first.sequence);
    expect(cursor?.updatedAt).toBe(NOW_3);
  });

  it('fails closed on a delivery gap instead of silently skipping events', async () => {
    const third = stream[2] as LedgerEvent;
    const outcome = await consumeIdempotently(pool, {
      tenantId: TENANT_A,
      consumerName: CONSUMER_PROJECTIONS,
      event: third,
      now: NOW_4,
      handle: async () => ok(-1),
    });
    const failure = expectFailure(outcome);
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('consumer-ledger-gap');
    const cursor = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_PROJECTIONS, AGG_ACTIVITY),
    );
    expect(cursor?.lastSequence).toBe(1);
  });

  it('recovers in order: the skipped event processes, then the gapped one', async () => {
    const second = stream[1] as LedgerEvent;
    const third = stream[2] as LedgerEvent;
    const secondOutcome = expectOk(
      await consumeIdempotently(pool, {
        tenantId: TENANT_A,
        consumerName: CONSUMER_PROJECTIONS,
        event: second,
        now: NOW_4,
        handle: async (tx) => {
          expectOk(
            await projects.insert(tx, scopeTenantA, {
              projectId: PROJECT_C2,
              name: 'Activity Projection 2',
              now: NOW_4,
            }),
          );
          return ok(2);
        },
      }),
    );
    expect(secondOutcome.status).toBe('processed');
    const thirdOutcome = expectOk(
      await consumeIdempotently(pool, {
        tenantId: TENANT_A,
        consumerName: CONSUMER_PROJECTIONS,
        event: third,
        now: NOW_4,
        handle: async () => ok(3),
      }),
    );
    expect(thirdOutcome.status).toBe('processed');
    const cursor = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_PROJECTIONS, AGG_ACTIVITY),
    );
    expect(cursor?.lastSequence).toBe(3);
  });

  it('skips stale deliveries (an older event than the cursor)', async () => {
    const second = stream[1] as LedgerEvent;
    const runsBefore = handlerRuns;
    const outcome = expectOk(
      await consumeIdempotently(pool, {
        tenantId: TENANT_A,
        consumerName: CONSUMER_PROJECTIONS,
        event: second,
        now: NOW_5,
        handle: async () => {
          handlerRuns += 1;
          return ok(-1);
        },
      }),
    );
    expect(outcome.status).toBe('skipped-duplicate');
    // The handler did NOT run for the stale delivery.
    expect(handlerRuns).toBe(runsBefore);
  });

  it('a handler failure rolls the projection write AND the cursor advance back', async () => {
    const event = stream[3] as LedgerEvent;
    const before = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_PROJECTIONS, AGG_ACTIVITY),
    );
    const outcome = await consumeIdempotently(pool, {
      tenantId: TENANT_A,
      consumerName: CONSUMER_PROJECTIONS,
      event,
      now: NOW_5,
      handle: async (tx) => {
        expectOk(
          await projects.insert(tx, scopeTenantA, {
            projectId: PROJECT_FAIL,
            name: 'Never Committed Projection',
            now: NOW_5,
          }),
        );
        return fail(
          invariantViolation({ name: 'projection', statement: 'simulated consumer failure' }),
        );
      },
    });
    const failure = expectFailure(outcome);
    expect(failure.code).toBe('invariant-violation');
    // The handler's write is gone...
    const missing = await projects.findById(pool, scopeTenantA, PROJECT_FAIL);
    expect(expectFailure(missing).code).toBe('not-found');
    // ...and the cursor did not advance.
    const after = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_PROJECTIONS, AGG_ACTIVITY),
    );
    expect(after?.lastSequence).toBe(before?.lastSequence);
    // Redelivery with a succeeding handler processes exactly once.
    const redelivered = expectOk(
      await consumeIdempotently(pool, {
        tenantId: TENANT_A,
        consumerName: CONSUMER_PROJECTIONS,
        event,
        now: NOW_5,
        handle: async () => ok(4),
      }),
    );
    expect(redelivered.status).toBe('processed');
  });

  it('keeps consumers independent: another consumer processes the same events', async () => {
    const first = stream[0] as LedgerEvent;
    const outcome = expectOk(
      await consumeIdempotently(pool, {
        tenantId: TENANT_A,
        consumerName: CONSUMER_AUDIT,
        event: first,
        now: NOW_5,
        handle: async () => ok('audit-1'),
      }),
    );
    expect(outcome.status).toBe('processed');
    const auditCursor = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_AUDIT, AGG_ACTIVITY),
    );
    expect(auditCursor?.lastSequence).toBe(first.sequence);
  });

  it('accepts a late-start consumer whose first delivery establishes its position', async () => {
    const second = stream[1] as LedgerEvent;
    const outcome = expectOk(
      await consumeIdempotently(pool, {
        tenantId: TENANT_A,
        consumerName: CONSUMER_LATE,
        event: second,
        now: NOW_5,
        handle: async () => ok('late-2'),
      }),
    );
    expect(outcome.status).toBe('processed');
    const cursor = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_LATE, AGG_ACTIVITY),
    );
    expect(cursor?.lastSequence).toBe(second.sequence);
  });

  it('rejects cross-tenant consumption before any SQL runs (A12)', async () => {
    const first = stream[0] as LedgerEvent;
    const failure = expectFailure(
      await consumeIdempotently(pool, {
        tenantId: TENANT_B,
        consumerName: CONSUMER_PROJECTIONS,
        event: first,
        now: NOW_5,
        handle: async () => ok(-1),
      }),
    );
    expect(failure.code).toBe('unauthorized');
    expect(failure.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('rejects consumption of an event that is not in the ledger (fail closed)', async () => {
    const fabricated: LedgerEvent = {
      eventId: ledgerEventIdOf({ tenantId: TENANT_A, aggregate: AGG_ISSUE, sequence: seq(777) }),
      sequence: seq(777),
      aggregate: AGG_ISSUE,
      envelope: envelope({}),
    };
    const failure = expectFailure(
      await consumeIdempotently(pool, {
        tenantId: TENANT_A,
        consumerName: CONSUMER_AUDIT,
        event: fabricated,
        now: NOW_5,
        handle: async () => ok(-1),
      }),
    );
    expect(failure.code).toBe('not-found');
    expect(failure.details[0]?.code).toBe('ledger-event-not-found');
  });

  it('processes exactly once under CONCURRENT duplicate delivery', async () => {
    const event = await append(pool, {
      envelope: envelope({
        eventName: 'cost.budgetLineUpdated',
        entityRefs: { before: null, after: AGG_BUDGET },
        payload: { line: 'Concurrent consumption', amount: 7 },
      }),
      aggregate: AGG_BUDGET,
    });
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        consumeIdempotently(pool, {
          tenantId: TENANT_A,
          consumerName: CONSUMER_PROJECTIONS,
          event,
          now: NOW_5,
          handle: async (tx) => {
            expectOk(
              await projects.insert(tx, scopeTenantA, {
                projectId: PROJECT_CONCURRENT,
                name: 'Concurrent Projection',
                now: NOW_5,
              }),
            );
            return ok('concurrent');
          },
        }),
      ),
    );
    const statuses = outcomes.map((outcome) => expectOk(outcome).status).sort();
    expect(statuses).toStrictEqual(['processed', 'skipped-duplicate']);
    // The handler's write happened exactly once.
    const written = expectOk(await projects.findById(pool, scopeTenantA, PROJECT_CONCURRENT));
    expect(written.version).toBe(1);
    const cursor = expectOk(
      await readConsumerCursor(pool, TENANT_A, CONSUMER_PROJECTIONS, AGG_BUDGET),
    );
    expect(cursor?.lastSequence).toBe(event.sequence);
  });
});

// ----- 8. fail-closed row decoding ----------------------------------------------

describe('fail-closed row decoding (row corruption)', () => {
  it('throws a typed row-corruption failure for a tampered ledger row', async () => {
    const eventId = ledgerEventIdOf({ tenantId: TENANT_A, aggregate: AGG_ISSUE, sequence: seq(888) });
    await pool.query(
      `INSERT INTO event_ledger (
         tenant_id, event_id, aggregate_kind, aggregate_id, sequence, event_name,
         project_id, actor, source, correlation_id, causation_id, schema_version,
         occurred_at, entity_refs, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, NULL, $10, $11, $12, $13)`,
      [
        TENANT_A,
        eventId,
        AGG_ISSUE.entityKind,
        AGG_ISSUE.entityId,
        888,
        'field.observationRecorded',
        { kind: 'system' },
        'domain',
        'bad', // passes the DB CHECK (non-empty), fails the contracts parser (min 8 chars)
        CURRENT_SCHEMA_VERSION,
        new Date(NOW_1),
        { before: null, after: null },
        { note: 'corrupt' },
      ],
    );
    await expect(readEventById(pool, scopeTenantA, eventId)).rejects.toMatchObject({
      code: 'row-corruption',
    });
    await expect(readAggregateEvents(pool, scopeTenantA, AGG_ISSUE)).rejects.toMatchObject({
      code: 'row-corruption',
    });
  });

  it('throws a typed row-corruption failure for a tampered outbox row', async () => {
    const event = await append(pool, {
      envelope: envelope({ payload: { corruption: 'probe' } }),
      aggregate: AGG_ACTIVITY,
    });
    await pool.query(
      `INSERT INTO event_outbox (tenant_id, project_id, event_id, state, attempts, available_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        TENANT_A,
        'not-a-canonical-project-id', // corrupted project scope column
        event.eventId,
        'pending',
        0,
        new Date(NOW_1),
        new Date(NOW_1),
      ],
    );
    await expect(
      fetchPendingOutbox(pool, scopeTenantA, { now: NOW_2, limit: 50 }),
    ).rejects.toMatchObject({ code: 'row-corruption' });
  });
});

// ----- 9. replay determinism ------------------------------------------------------

describe('replay determinism — same commands, fresh database, identical ledger (acceptance)', () => {
  const replayEnvelopes: readonly DomainEventEnvelope[] = [
    envelope({
      scope: scopeTenantReplay,
      causality: { correlationId: CORR_B, causationId: null },
      occurredAt: NOW_1,
      entityRefs: { before: null, after: AGG_REPLAY },
      payload: { step: 1 },
    }),
    envelope({
      scope: scopeTenantReplay,
      causality: { correlationId: CORR_B, causationId: 'idem-9999999988888888' },
      occurredAt: NOW_2,
      entityRefs: { before: null, after: AGG_REPLAY },
      payload: { step: 2 },
    }),
    envelope({
      scope: scopeTenantReplay,
      causality: { correlationId: CORR_B, causationId: 'idem-9999999977777777' },
      occurredAt: NOW_3,
      entityRefs: { before: null, after: AGG_REPLAY },
      payload: { step: 3 },
    }),
  ];

  const runReplay = async (target: PersistencePool): Promise<readonly LedgerEvent[]> => {
    const events: LedgerEvent[] = [];
    for (const env of replayEnvelopes) {
      events.push(
        expectOk(
          await target.runInTransaction(async (tx) =>
            appendEvent(tx, { envelope: env, aggregate: AGG_REPLAY }),
          ),
        ),
      );
    }
    return events;
  };

  it('reproduces the identical ledger on a fresh scratch database', async () => {
    // First run: the primary scratch database of this suite.
    const first = await runReplay(pool);
    const firstStream = expectOk(await readAggregateEvents(pool, scopeTenantReplay, AGG_REPLAY));

    // Second run: a FRESH scratch database on the same server/cluster,
    // migrated with the same composed chain.
    const secondHarness = await startPersistenceTestHarness();
    try {
      const dir = await combinedMigrationsDir();
      await createMigrator(secondHarness.pool, { migrationsDir: dir, now: () => NOW_1 }).migrate();
      const second = await runReplay(secondHarness.pool);
      const secondStream = expectOk(
        await readAggregateEvents(secondHarness.pool, scopeTenantReplay, AGG_REPLAY),
      );

      // Event ids, sequences, and full envelopes reproduce exactly.
      expect(second.map((event) => event.eventId)).toStrictEqual(
        first.map((event) => event.eventId),
      );
      expect(second.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);
      expect(firstStream.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);
      expect(secondStream).toStrictEqual(firstStream);
    } finally {
      await secondHarness.stop();
    }
  }, 180_000);
});
