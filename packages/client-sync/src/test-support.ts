// Office client-sync — package-internal test support (OFF-029).
//
// NOT part of the public surface: deterministic factories for the fixed
// tenants, projects, clients, actors, instants, envelopes, policies,
// authorization contexts, the counting typed command path, and the shared
// two-client world the offline sync engine's test suites need. Everything is
// a fixed constant — no Date.now, no Math.random, no environment — so every
// suite (and the interrupted-drain resumes) replays byte-identically.
//
// The counting command path is THE exactly-once oracle: it records every
// INNER HANDLER invocation by idempotency key, is idempotent by
// (scope, idempotency key) exactly like the landed domain command paths, and
// appends its effect to the in-memory slice source with the A3
// causedByCommand convention (the effect event's causation id IS the
// command's idempotency key) — the convention the replay's own-event
// recognition depends on.
import {
  CURRENT_SCHEMA_VERSION,
  formatEntityId,
  formatProjectId,
  formatTenantId,
  formatTimestamp,
  parseCommandName,
  parseCorrelationId,
  parseDomainEventEnvelope,
  parseEntityKind,
  parseEventName,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  CommandName,
  CorrelationId,
  DomainEventEnvelope,
  EntityId,
  EntityKind,
  EntityRef,
  EventName,
  ProjectId,
  ProjectScope,
  Scope,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { authorizationContext, capability, definePolicy } from '@office/authz';
import type { AuthorizationContext, Policy } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { Result } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import {
  CURRENT_PROTOCOL_VERSION,
  createInMemoryOperationRegistry,
  createInMemorySliceSource,
  createSubscriptionBroker,
  subscription,
  subscriptionFilter,
  subscriptionIdOf,
} from '@office/sync';
import type {
  InMemorySliceSource,
  OperationRegistry,
  Subscription,
  SubscriptionBroker,
  SubscriptionGrant,
  SubscriptionGrantId,
} from '@office/sync';
import { createInMemoryConflictLog, createInMemoryOperationJournal } from './conflict';
import type { ConflictLog, OperationJournal } from './conflict';
import { createInMemorySyncEventSink } from './audit';
import type {
  InMemorySyncEventSink,
  RecordedSyncAppend,
  SyncAuditSinkExecutor,
  SyncEventSink,
} from './audit';
import { createSyncEngine } from './engine';
import type { OfflineCapture, SyncEngine } from './engine';
import type { ProtectionClass } from './queue';
import type { TypedCommandPath } from './replay';

/** Unwrap a typed Result (failures are test bugs — loud, never silent). */
export const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

// ---- Fixed canonical identities (deterministic, opaque 32-hex parts). ----

export const TENANT_A: TenantId = formatTenantId({
  version: 'v1',
  opaque: '0b1c2d3e4f5061728394a5b6c7d8e9f0',
});
export const TENANT_B: TenantId = formatTenantId({
  version: 'v1',
  opaque: 'e0d9c8b7a6948536252411ffeeddccbb',
});

export const PROJECT_1: ProjectId = formatProjectId({
  version: 'v1',
  opaque: '11223344556677889900aabbccddeeff',
});
export const PROJECT_2: ProjectId = formatProjectId({
  version: 'v1',
  opaque: '998877665544332211ffeeddccbbaa00',
});

export const CLIENT_A: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'aa11bb22cc33dd44ee55ff6677889900',
});
export const CLIENT_B: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'bb22cc33dd44ee55ff6677889900aa11',
});
export const ADMIN: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'cc33dd44ee55ff6677889900aa11bb22',
});

export const ACTOR_A: Actor = { kind: 'user', actorId: CLIENT_A };
export const ACTOR_B: Actor = { kind: 'user', actorId: CLIENT_B };
export const ACTOR_ADMIN: Actor = { kind: 'user', actorId: ADMIN };
export const ACTOR_SYSTEM: Actor = { kind: 'system' };

// ---- Fixed instants (the injected clock of every suite). ----

export const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-15T08:00:00.000Z'));
export const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-15T08:30:00.000Z'));
export const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-15T09:00:00.000Z'));
export const NOW_4: Timestamp = unwrap(parseTimestamp('2026-09-15T09:30:00.000Z'));
export const NOW_5: Timestamp = unwrap(parseTimestamp('2026-09-15T10:00:00.000Z'));
export const NOW_6: Timestamp = unwrap(parseTimestamp('2026-09-15T10:30:00.000Z'));
export const NOW_7: Timestamp = unwrap(parseTimestamp('2026-09-15T11:00:00.000Z'));
export const NOW_8: Timestamp = unwrap(parseTimestamp('2026-09-15T11:30:00.000Z'));

// ---- Fixed scopes. ----

export const SCOPE_1: ProjectScope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 };
export const SCOPE_2: ProjectScope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_2 };
export const SCOPE_TENANT_B: ProjectScope = {
  kind: 'project',
  tenantId: TENANT_B,
  projectId: PROJECT_1,
};
export const TENANT_A_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_A };

// ---- Deterministic kind/id/name factories (fail-closed self-checked). ----

/** A fixed canonical EntityKind (trusted path: the constant must parse). */
export const entityKindOf = (kind: string): EntityKind => unwrap(parseEntityKind(kind));

/** A fixed canonical EventName (trusted path: the constant must parse). */
export const eventNameOf = (name: string): EventName => unwrap(parseEventName(name));

/** A fixed canonical CommandName (trusted path: the constant must parse). */
export const commandNameOf = (name: string): CommandName => unwrap(parseCommandName(name));

/** A fixed canonical CorrelationId (trusted path: the constant must parse). */
export const correlationIdOf = (token: string): CorrelationId =>
  unwrap(parseCorrelationId(token));

/** A fixed canonical EntityId (32-hex trusted-path constant). */
export const entityIdOf = (opaque: string): EntityId => formatEntityId({ version: 'v1', opaque });

/** Trusted test cast: a hand-verified slice position constant. */
export const slicePositionOf = (n: number): import('@office/sync').SlicePosition =>
  n as import('@office/sync').SlicePosition;

/** Trusted test cast: a hand-verified grant lifecycle version constant. */
export const grantVersionOf = (n: number): Subscription['grantVersion'] =>
  n as Subscription['grantVersion'];

/** Trusted test cast: a hand-verified kebab-case operation kind constant. */
export const operationKindOf = (kind: string): import('@office/sync').OperationKind =>
  kind as import('@office/sync').OperationKind;

// ---- Fixed targets and the progress-mutation fixture. ----

/** The progress-update entity kind of the test world's mutations. */
export const PROGRESS_KIND: EntityKind = entityKindOf('progress-update');
/** The contested target of the test world's mutations. */
export const TARGET_PROGRESS: EntityRef = {
  entityKind: PROGRESS_KIND,
  entityId: entityIdOf('d1d2d3d4d5d6d7e8f9a0b1c2d3e4f5a6'),
};
/** A second, independent target (no cross-target interference). */
export const TARGET_NOTE: EntityRef = {
  entityKind: entityKindOf('progress-note'),
  entityId: entityIdOf('e2d3d4d5d6d7e8f9a0b1c2d3e4f5a6d1'),
};

/** The write capability every progress mutation of the test world requires. */
export const WORK_WRITE = capability('work.write');

/** One progress-record mutation of the test world (offline capture shape). */
export const progressMutation = (parts: {
  readonly percent?: number;
  readonly protection?: ProtectionClass;
  readonly target?: EntityRef;
  readonly scope?: ProjectScope;
  readonly actor?: Actor;
  readonly commandName?: CommandName;
  readonly correlationId?: string;
  readonly note?: string;
} = {}): OfflineCapture => ({
  commandName: parts.commandName ?? commandNameOf('work.recordProgress'),
  scope: parts.scope ?? SCOPE_1,
  actor: parts.actor ?? ACTOR_A,
  correlationId: correlationIdOf(parts.correlationId ?? 'corr-1a2b3c4d5e6f'),
  issuedAt: NOW_2,
  payload: parts.note === undefined
    ? { percent: parts.percent ?? 40 }
    : { percent: parts.percent ?? 40, note: parts.note },
  target: parts.target ?? TARGET_PROGRESS,
  operationKind: operationKindOf('record-progress'),
  protection: parts.protection ?? 'protected',
  requiredCapability: WORK_WRITE,
});

/**
 * Complete an offline capture with its session basis (the subscription it
 * syncs under and the causal token it was composed against) — the parts the
 * engine adds for engine clients and raw-drain tests add themselves.
 */
export const withSession = (
  mutation: OfflineCapture,
  session: {
    readonly subscriptionId: import('@office/sync').SubscriptionId;
    readonly basePosition?: number;
  },
): import('./queue').OfflineMutation => ({
  ...mutation,
  subscriptionId: session.subscriptionId,
  basePosition: (session.basePosition ?? 0) as import('@office/sync').SlicePosition,
});

// ---- Fixed policies (the caller-supplied deny-by-default evaluators). ----

/** A policy that allows every read and write (the permissive baseline). */
export const allowReadWritePolicy = (): Policy =>
  definePolicy([{ effect: 'allow', actions: ['read', 'write'] }]);

/** A policy that allows reads but denies writes by default (A12 on replay). */
export const denyWritesPolicy = (): Policy =>
  definePolicy([{ effect: 'allow', actions: ['read'] }]);

/** A policy with no rules at all (deny-by-default: nothing is allowed). */
export const emptyPolicy = (): Policy => definePolicy([]);

// ---- Fixed authorization contexts (WHO may subscribe and write). ----

/** A context holding the slice read + work write capabilities. */
export const writerContext = (actor: Actor, scope: Scope): AuthorizationContext =>
  authorizationContext({ actor, scope, capabilities: ['projects.read', 'work.write'] });

// ---- The deterministic effect-event envelope of the test world. ----

/**
 * Build one domain event envelope (fail-closed self-checked through
 * parseDomainEventEnvelope, exactly like the landed domain packages emit).
 */
export const eventEnvelope = (parts: {
  readonly eventName: string;
  readonly scope: Scope;
  readonly actor: Actor;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly entityRef?: EntityRef | null;
}): DomainEventEnvelope<Record<string, unknown>> =>
  unwrap(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName: unwrap(parseEventName(parts.eventName)),
      scope: parts.scope,
      actor: parts.actor,
      source: 'domain',
      causality: {
        correlationId: parts.correlationId,
        causationId: parts.causationId ?? null,
      },
      schemaVersion: CURRENT_SCHEMA_VERSION,
      occurredAt: parts.occurredAt,
      entityRefs: { before: parts.entityRef ?? null, after: parts.entityRef ?? null },
      payload: parts.payload ?? {},
    }),
  ) as DomainEventEnvelope<Record<string, unknown>>;

// ---- THE counting typed command path (the exactly-once oracle). ----

/** The counting typed command path: the drain's port + the test oracle. */
export interface CountingCommandPath extends TypedCommandPath {
  /** Every inner-handler invocation, in order (the idempotency key). */
  readonly calls: readonly string[];
  /** How many times the inner handler ran for one idempotency key. */
  readonly callCount: (key: string) => number;
  /** Fail the NEXT first-presentation execution with a typed rejection. */
  rejectNext(reason: string): void;
}

/**
 * The deterministic in-memory typed command path: idempotent by
 * (scope, idempotency key) — a re-presented command returns the RECORDED
 * outcome with replayed: true and never re-runs the handler — and every
 * applied command appends its effect to the slice source with the A3
 * causedByCommand convention (causation id = the command's idempotency key).
 *
 * Each INNER-HANDLER execution is one command transaction, and its effect
 * event carries its OWN monotonic instant — the injected `now` advanced by
 * the execution ordinal (a fixed offset, never a clock read) — exactly like
 * the real domain command paths stamp one transaction instant per command.
 * This keeps the ledger's canonical (occurredAt, eventId) order APPEND-STABLE
 * across a multi-entry drain, so slice positions never shift under delivered
 * streams (the exactly-once cursor discipline's basis).
 */
export const createCountingCommandPath = (
  source: InMemorySliceSource,
): CountingCommandPath => {
  const recorded = new Map<string, LedgerEvent>();
  const calls: string[] = [];
  let rejection: string | null = null;
  let executions = 0;
  return {
    get calls(): readonly string[] {
      return [...calls];
    },
    callCount: (key) => calls.filter((candidate) => candidate === key).length,
    rejectNext: (reason) => {
      rejection = reason;
    },
    execute: async (command, context) => {
      const key = command.idempotencyKey as string;
      const prior = recorded.get(key);
      if (prior !== undefined) {
        // The idempotency replay: the recorded outcome comes back; the inner
        // handler does NOT run again (the effect layer of exactly-once).
        return ok({ event: prior, replayed: true });
      }
      if (rejection !== null) {
        const reason = rejection;
        rejection = null;
        return fail(
          domainError('invariant-violation', reason, [
            { code: 'command-rejected', message: reason, path: null },
          ]),
        );
      }
      calls.push(key);
      const occurredAt =
        executions === 0
          ? context.now
          : formatTimestamp(
              new Date(new Date(context.now).getTime() + executions * 1000),
            );
      executions += 1;
      const event = unwrap(
        await source.append(
          eventEnvelope({
            eventName: command.commandName,
            scope: command.scope,
            actor: command.actor,
            occurredAt,
            correlationId: command.causality.correlationId,
            causationId: key,
            payload: command.payload as Record<string, unknown>,
            entityRef: context.target,
          }),
          context.target,
        ),
      );
      recorded.set(key, event);
      return ok({ event, replayed: false });
    },
  };
};

// ---- The shared two-client world + engine scaffolding. ----

/** The no-op transaction executor of the in-memory audit sink (tests). */
export const stubExecutor = (): SyncAuditSinkExecutor => ({
  query: async () => ({ rows: [], rowCount: 0 }),
});

/** A switchable in-memory audit sink (records every SUCCESSFUL append). */
export interface SwitchableSyncEventSink extends InMemorySyncEventSink {
  /** Delegate subsequent appends to `sink` (successful appends stay recorded). */
  use(sink: SyncEventSink): void;
}

/**
 * The deterministic switchable audit sink: an in-memory sink that delegates
 * every append to its CURRENT inner sink while recording every SUCCESSFUL
 * append itself. Swap the inner sink mid-scenario (e.g. to
 * `failAfterSyncEventSink`) to interrupt a drain at a deterministic point,
 * then back to a recording sink to resume it — the overall audit trail of
 * the whole scenario stays observable through `events`.
 */
export const createSwitchableSink = (): SwitchableSyncEventSink => {
  const appends: RecordedSyncAppend[] = [];
  let inner: SyncEventSink = createInMemorySyncEventSink();
  return {
    use: (sink) => {
      inner = sink;
    },
    get appends(): readonly RecordedSyncAppend[] {
      return [...appends];
    },
    get events(): readonly DomainEventEnvelope[] {
      return appends.flatMap((append) => append.events);
    },
    appendEvents: async (executor, events) => {
      const result = await inner.appendEvents(executor, events);
      if (result.ok) {
        appends.push({ executor, events: [...events] });
      }
      return result;
    },
  };
};

/** One shared server-side world: two engines over one world = two clients. */
export interface SyncWorld {
  readonly source: InMemorySliceSource;
  readonly broker: SubscriptionBroker;
  readonly registry: OperationRegistry;
  readonly journal: OperationJournal;
  readonly conflicts: ConflictLog;
  readonly commandPath: CountingCommandPath;
  readonly sink: InMemorySyncEventSink;
  readonly executor: SyncAuditSinkExecutor;
  readonly policy: Policy;
}

/** Create a fresh deterministic shared world (all ports in-memory). */
export const createWorld = (policy: Policy = allowReadWritePolicy()): SyncWorld => {
  const source = createInMemorySliceSource();
  const broker = createSubscriptionBroker({ policy, source });
  const registry = createInMemoryOperationRegistry();
  const journal = createInMemoryOperationJournal();
  const conflicts = createInMemoryConflictLog();
  const commandPath = createCountingCommandPath(source);
  const sink = createInMemorySyncEventSink();
  return {
    source,
    broker,
    registry,
    journal,
    conflicts,
    commandPath,
    sink,
    executor: stubExecutor(),
    policy,
  };
};

/** Issue the standard writer grant of `subscriber` under the tenant scope. */
export const issueWriterGrant = (
  broker: SubscriptionBroker,
  subscriberId: EntityId,
  actor: Actor,
  serial: number,
): Result<SubscriptionGrant, import('@office/domain-kernel').DomainError> =>
  broker.issueGrant({
    subscriberId,
    context: writerContext(actor, TENANT_A_SCOPE),
    grantedBy: ACTOR_ADMIN,
    now: NOW_1,
    serial,
  });

/** Compose the standard full-slice session subscription of `subscriber`. */
export const sessionSubscription = (
  subscriberId: EntityId,
  grantId: SubscriptionGrantId,
  ordinal = 1,
): Subscription =>
  subscription({
    subscriptionId: subscriptionIdOf({
      tenantId: TENANT_A,
      projectId: PROJECT_1,
      subscriberId,
      ordinal,
    }),
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    filter: subscriptionFilter({ scope: SCOPE_1 }),
    grantId,
    grantVersion: grantVersionOf(1),
  });

/** One engine (one client's session) over the shared world. */
export const engineOver = (
  world: SyncWorld,
  parts: {
    readonly clientId: EntityId;
    readonly actor: Actor;
    readonly serial: number;
    readonly ordinal?: number;
  },
): { readonly engine: SyncEngine; readonly grant: SubscriptionGrant } => {
  const grant = unwrap(issueWriterGrant(world.broker, parts.clientId, parts.actor, parts.serial));
  const engine = createSyncEngine({
    broker: world.broker,
    slice: world.source,
    registry: world.registry,
    commandPath: world.commandPath,
    journal: world.journal,
    conflicts: world.conflicts,
    policy: world.policy,
    audit: { sink: world.sink, executor: world.executor },
    clientId: parts.clientId,
    subscription: sessionSubscription(parts.clientId, grant.grantId, parts.ordinal ?? 1),
    grantId: grant.grantId,
    scope: SCOPE_1,
  });
  return { engine, grant };
};

// ---- Convergence helpers (the client-side state fold). ----

/** The event ids of a consumed stream, in consumption order. */
export const consumedIds = (events: readonly LedgerEvent[]): readonly string[] =>
  events.map((event) => event.eventId);

/**
 * Fold consumed events into the client's entity-state projection: the last
 * consumed payload per addressed entity (the two-client convergence oracle —
 * both clients' folds must be deep-equal).
 */
export const foldState = (
  events: readonly LedgerEvent[],
): Record<string, Record<string, unknown>> => {
  const state: Record<string, Record<string, unknown>> = {};
  for (const event of events) {
    state[`${event.aggregate.entityKind}:${event.aggregate.entityId}`] = {
      ...(event.envelope.payload as Record<string, unknown>),
    };
  }
  return state;
};
