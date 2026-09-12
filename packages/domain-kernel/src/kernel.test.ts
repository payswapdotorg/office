import { describe, expect, it } from 'vitest';
import {
  parseCommandEnvelope,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  CommandEnvelope,
  EntityId,
  EntityKind,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import {
  checkConcurrency,
  checkInvariants,
  checkScopeCovers,
  commandFingerprint,
  concurrencyTokenOf,
  createInMemoryIdempotencyRegistry,
  defineInvariant,
  entityNotFound,
  fail,
  nextAggregateVersion,
  ok,
  withIdempotency,
} from './index';
import type {
  Aggregate,
  AggregateVersion,
  CommandExecutionContext,
  CommandHandler,
  ConcurrencyToken,
  DomainError,
  IdempotencyRegistry,
  IdempotentExecution,
  Invariant,
  Result,
} from './index';

// OFF-003 domain kernel — the four kernel invariants, PROVEN end-to-end by
// a deterministic sample handler over an in-memory aggregate store:
//
//   1. tenant isolation: a command scoped to tenant A cannot act on the
//      aggregate state of tenant B → typed unauthorized/tenant-scope failure;
//   2. optimistic concurrency: a stale AggregateVersion → typed
//      concurrency-conflict; the correct version applies and increments;
//   3. idempotency: same key + same command replays the recorded outcome
//      harmlessly; same key + different command → idempotency-conflict;
//   4. invariant enforcement: a violated invariant → typed
//      invariant-violation result AND the aggregate state is unchanged.
//
// The fixture mirrors the canonical cross-view mutation flow (freeze):
// idempotency lookup → scope check → concurrency check → invariant check on
// the NEXT state → commit. It uses only kernel primitives plus an injected
// fixed clock — no wall clock, no randomness, no I/O.
//
// 'task' here is a TEST aggregate only: real aggregates arrive with
// OFF-007+.

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TENANT_B_OPAQUE = 'f9e8d7c6b5a493827160f5e4d3c2b1a0';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const PROJECT_B_OPAQUE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9';
const USER_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';
const TASK_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';
const CORRELATION_ID = 'corr-0f1e2d3c4b5a';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const fixedNow: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const tenantAId = unwrap(parseTenantId(`office-tnt-v1-${TENANT_A_OPAQUE}`));
const tenantBId = unwrap(parseTenantId(`office-tnt-v1-${TENANT_B_OPAQUE}`));
const projectAId = unwrap(parseProjectId(`office-prj-v1-${PROJECT_A_OPAQUE}`));
const projectBId = unwrap(parseProjectId(`office-prj-v1-${PROJECT_B_OPAQUE}`));
const taskId = unwrap(parseEntityId(`office-ent-v1-${TASK_OPAQUE}`));
const taskBId = unwrap(parseEntityId(`office-ent-v1-${PROJECT_B_OPAQUE}`));
const taskKind: EntityKind = unwrap(parseEntityKind('task'));

const projectAScope: Scope = { kind: 'project', tenantId: tenantAId, projectId: projectAId };
const projectBScope: Scope = { kind: 'project', tenantId: tenantBId, projectId: projectBId };

/** Sample aggregate (test fixture): a checklist task with counts. */
interface TaskAggregate extends Aggregate {
  readonly title: string;
  readonly doneCount: number;
  readonly itemCount: number;
}

const TASK_INVARIANTS: readonly Invariant<TaskAggregate>[] = [
  defineInvariant(
    'task-title-non-empty',
    'a task title is never empty',
    (task) => task.title.trim().length > 0,
  ),
  defineInvariant(
    'task-done-count-within-item-count',
    'done count never exceeds item count',
    (task) => task.doneCount <= task.itemCount,
  ),
];

/** Domain-validated payload of the sample command (trusted by the handler). */
interface SetCountsPayload {
  readonly entityId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly doneCount: number;
  readonly itemCount: number;
}

interface SetCountsOutcome {
  readonly entityId: EntityId;
  readonly version: AggregateVersion;
}

interface TaskFixture {
  readonly store: Map<string, TaskAggregate>;
  readonly registry: IdempotencyRegistry;
  readonly handler: CommandHandler<SetCountsPayload, null, IdempotentExecution<SetCountsOutcome>>;
  readonly executions: { count: number };
  readonly seedTask: (task: TaskAggregate) => void;
}

const context: CommandExecutionContext<null> = {
  transaction: null,
  now: () => fixedNow,
  newEntityId: () => taskId,
};

/** Compose the sample handler from kernel primitives only. */
const createTaskFixture = (): TaskFixture => {
  const store = new Map<string, TaskAggregate>();
  const registry = createInMemoryIdempotencyRegistry();
  const executions = { count: 0 };

  const handler: CommandHandler<
    SetCountsPayload,
    null,
    IdempotentExecution<SetCountsOutcome>
  > = async (command) => {
    const payload = command.payload;
    const errorContext = {
      scope: command.scope,
      correlationId: command.causality.correlationId,
    };

    return withIdempotency(registry, command, async (): Promise<
      Result<SetCountsOutcome, DomainError>
    > => {
      executions.count += 1;

      const task = store.get(payload.entityId);
      if (task === undefined) {
        return fail(
          entityNotFound({ entityKind: taskKind, entityId: payload.entityId }, errorContext),
        );
      }

      // 1. tenant/project isolation (A12 backstop).
      const scopeCheck = checkScopeCovers(command.scope, task.scope, errorContext);
      if (!scopeCheck.ok) return scopeCheck;

      // 2. optimistic concurrency (never silent overwrite).
      const expectedToken: ConcurrencyToken = {
        kind: 'concurrency-token',
        entityKind: taskKind,
        entityId: payload.entityId,
        version: payload.expectedVersion,
      };
      const concurrencyCheck = checkConcurrency(
        expectedToken,
        concurrencyTokenOf(task),
        errorContext,
      );
      if (!concurrencyCheck.ok) return concurrencyCheck;

      // 3. invariants on the NEXT state — commit only when they hold.
      const nextTask: TaskAggregate = {
        ...task,
        doneCount: payload.doneCount,
        itemCount: payload.itemCount,
        version: nextAggregateVersion(task.version),
      };
      const invariantCheck = checkInvariants(nextTask, TASK_INVARIANTS, errorContext);
      if (!invariantCheck.ok) return invariantCheck;

      // 4. commit.
      store.set(payload.entityId, nextTask);
      return ok({ entityId: payload.entityId, version: nextTask.version });
    });
  };

  return {
    store,
    registry,
    handler,
    executions,
    seedTask: (task) => {
      store.set(task.entityId, task);
    },
  };
};

interface CommandFixture {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly idempotencyKey?: string;
  readonly issuedAt?: string;
  readonly payload?: {
    readonly entityId?: string;
    readonly expectedVersion?: number;
    readonly doneCount?: number;
    readonly itemCount?: number;
  };
}

/** Build a validated command envelope (fixture validates the payload). */
const setCountsCommand = (fixture: CommandFixture = {}): CommandEnvelope<SetCountsPayload> => {
  const payload = {
    entityId: taskId,
    expectedVersion: 1,
    doneCount: 2,
    itemCount: 3,
    ...fixture.payload,
  };
  const parsed = unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName: 'tasks.setCounts',
      scope: {
        kind: 'project',
        tenantId: fixture.tenantId ?? tenantAId,
        projectId: fixture.projectId ?? projectAId,
      },
      actor: { kind: 'user', actorId: `office-ent-v1-${USER_OPAQUE}` },
      idempotencyKey: fixture.idempotencyKey ?? 'idem-4f9d2c81a7e3',
      causality: { correlationId: CORRELATION_ID, causationId: null },
      issuedAt: fixture.issuedAt ?? '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );
  return { ...parsed, payload: payload as SetCountsPayload };
};

const seedTaskIn = (fixture: TaskFixture, scope: Scope): TaskAggregate => {
  const task: TaskAggregate = {
    entityKind: taskKind,
    entityId: taskId,
    scope,
    version: 1 as AggregateVersion,
    title: 'Pour slab',
    doneCount: 0,
    itemCount: 3,
  };
  fixture.seedTask(task);
  return task;
};

const seeded = (fixture: TaskFixture): TaskAggregate => {
  const task = fixture.store.get(taskId);
  if (task === undefined) throw new Error('task not seeded');
  return task;
};

const expectFailure = async (
  fixture: TaskFixture,
  command: CommandEnvelope<SetCountsPayload>,
): Promise<DomainError> => {
  const result = await fixture.handler(command, context);
  expect(result.ok).toBe(false);
  if (!result.ok) return result.error;
  throw new Error('expected a typed failure');
};

describe('kernel invariant 1 — tenant isolation (freeze A12)', () => {
  it('rejects a tenant A command acting on a tenant B aggregate with a typed unauthorized failure', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectBScope);
    const error = await expectFailure(fixture, setCountsCommand());
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
    expect(error.scope).toStrictEqual(projectAScope);
    expect(error.correlationId).toBe(CORRELATION_ID);
  });

  it('leaves the tenant B aggregate state unchanged', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectBScope);
    await expectFailure(fixture, setCountsCommand());
    expect(seeded(fixture)).toStrictEqual({
      entityKind: 'task',
      entityId: taskId,
      scope: projectBScope,
      version: 1,
      title: 'Pour slab',
      doneCount: 0,
      itemCount: 3,
    });
  });

  it('allows the same mutation from the owning tenant', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    const result = await fixture.handler(setCountsCommand(), context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value.version).toBe(2);
    expect(seeded(fixture).doneCount).toBe(2);
  });
});

describe('kernel invariant 2 — optimistic concurrency', () => {
  it('rejects a stale expected version with a typed concurrency-conflict', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    // First mutation moves the aggregate to version 2.
    const first = await fixture.handler(setCountsCommand(), context);
    expect(first.ok).toBe(true);
    // Stale retry presenting version 1 against actual version 2.
    const stale = await expectFailure(
      fixture,
      setCountsCommand({
        idempotencyKey: 'idem-stale-retry-0001',
        payload: { expectedVersion: 1 },
      }),
    );
    expect(stale.code).toBe('concurrency-conflict');
    expect(stale.message).toContain('expected version 1');
    expect(stale.message).toContain('actual version 2');
    expect(stale.details[0]?.code).toBe('stale-aggregate-version');
  });

  it('never silently overwrites: state stays at the current version after a conflict', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    await fixture.handler(setCountsCommand(), context);
    await expectFailure(
      fixture,
      setCountsCommand({
        idempotencyKey: 'idem-stale-retry-0001',
        payload: { expectedVersion: 1 },
      }),
    );
    expect(seeded(fixture).version).toBe(2);
    expect(seeded(fixture).doneCount).toBe(2);
  });

  it('applies the mutation and increments the version when the expected version is correct', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    const result = await fixture.handler(
      setCountsCommand({ payload: { expectedVersion: 1, doneCount: 1 } }),
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value.version).toBe(2);
    expect(seeded(fixture)).toStrictEqual({
      entityKind: 'task',
      entityId: taskId,
      scope: projectAScope,
      version: 2,
      title: 'Pour slab',
      doneCount: 1,
      itemCount: 3,
    });
    // A second correct mutation (expected version now 2) increments again.
    const second = await fixture.handler(
      setCountsCommand({
        idempotencyKey: 'idem-second-command-2',
        payload: { expectedVersion: 2, doneCount: 3 },
      }),
      context,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.value.version).toBe(3);
    expect(seeded(fixture).version).toBe(3);
  });
});

describe('kernel invariant 3 — idempotency (freeze A8 / ADR-005)', () => {
  it('replays the recorded outcome harmlessly: same key + same command executes once', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    const first = await fixture.handler(setCountsCommand(), context);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.replayed).toBe(false);
      expect(first.value.value).toStrictEqual({ entityId: taskId, version: 2 });
    }
    // Honest client retry: fresh issuedAt, same logical command and key.
    const retry = await fixture.handler(
      setCountsCommand({ issuedAt: '2026-09-12T10:16:00.000Z' }),
      context,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.replayed).toBe(true);
      expect(retry.value.value).toStrictEqual({ entityId: taskId, version: 2 });
    }
    expect(fixture.executions.count).toBe(1);
    expect(seeded(fixture).version).toBe(2);
  });

  it('rejects the same key carrying a different command with a typed idempotency-conflict', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    await fixture.handler(setCountsCommand(), context);
    const conflicting = await expectFailure(
      fixture,
      setCountsCommand({ payload: { doneCount: 3 } }),
    );
    expect(conflicting.code).toBe('idempotency-conflict');
    expect(conflicting.details[0]?.code).toBe('idempotency-key-reuse');
    expect(conflicting.scope).toStrictEqual(projectAScope);
    expect(fixture.executions.count).toBe(1);
    expect(seeded(fixture).doneCount).toBe(2);
  });

  it('keeps dedupe scoped: the same key under another scope is a different command', async () => {
    const fixture = createTaskFixture();
    const taskB: TaskAggregate = {
      entityKind: taskKind,
      entityId: taskBId,
      scope: projectBScope,
      version: 1 as AggregateVersion,
      title: 'Tenant B task',
      doneCount: 0,
      itemCount: 5,
    };
    fixture.seedTask(taskB);
    seedTaskIn(fixture, projectAScope);
    // Tenant A command consumes the key first.
    await fixture.handler(setCountsCommand(), context);
    // The same key under tenant B is a fresh registration, not a conflict.
    const foreign = await fixture.handler(
      setCountsCommand({
        tenantId: tenantBId,
        projectId: projectBId,
        payload: { entityId: taskBId, doneCount: 1, itemCount: 5 },
      }),
      context,
    );
    expect(foreign.ok).toBe(true);
    if (foreign.ok) expect(foreign.value.replayed).toBe(false);
    expect(fixture.executions.count).toBe(2);
  });
});

describe('kernel invariant 4 — invariant enforcement', () => {
  it('returns a typed invariant-violation when the next state would violate an invariant', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    const error = await expectFailure(
      fixture,
      setCountsCommand({ payload: { doneCount: 5, itemCount: 3 } }),
    );
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('task-done-count-within-item-count');
    expect(error.message).toBe(
      "invariant 'task-done-count-within-item-count' violated: done count never exceeds item count",
    );
  });

  it('leaves the aggregate state unchanged after a violated invariant', async () => {
    const fixture = createTaskFixture();
    const seed = seedTaskIn(fixture, projectAScope);
    await expectFailure(fixture, setCountsCommand({ payload: { doneCount: 5, itemCount: 3 } }));
    expect(seeded(fixture)).toStrictEqual(seed);
    expect(seeded(fixture).version).toBe(1);
    expect(seeded(fixture).doneCount).toBe(0);
    expect(seeded(fixture).itemCount).toBe(3);
  });

  it('accepts the boundary case where done equals item count', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    const result = await fixture.handler(
      setCountsCommand({ payload: { doneCount: 3, itemCount: 3 } }),
      context,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value.version).toBe(2);
    expect(seeded(fixture).doneCount).toBe(3);
  });
});

describe('kernel composition details', () => {
  it('reports unknown aggregates with a typed not-found failure', async () => {
    const fixture = createTaskFixture();
    const error = await expectFailure(fixture, setCountsCommand());
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('entity-not-found');
  });

  it('is deterministic: an identical fixture run twice produces identical outcomes', async () => {
    const run = async (): Promise<{ outcomes: unknown; task: TaskAggregate }> => {
      const fixture = createTaskFixture();
      seedTaskIn(fixture, projectAScope);
      const first = await fixture.handler(setCountsCommand(), context);
      const retry = await fixture.handler(setCountsCommand(), context);
      return { outcomes: [first, retry], task: seeded(fixture) };
    };
    expect(await run()).toStrictEqual(await run());
  });

  it('registers the executed command under (scope, key, fingerprint) for replay', async () => {
    const fixture = createTaskFixture();
    seedTaskIn(fixture, projectAScope);
    const command = setCountsCommand();
    await fixture.handler(command, context);
    const lookup = fixture.registry.lookup(
      command.scope,
      command.idempotencyKey,
      commandFingerprint(command),
    );
    expect(lookup.ok).toBe(true);
    if (lookup.ok && lookup.value.status === 'replay') {
      expect(lookup.value.outcome).toStrictEqual({ entityId: taskId, version: 2 });
    } else {
      throw new Error('expected the executed command to be registered for replay');
    }
  });
});
