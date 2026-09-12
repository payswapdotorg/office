import { describe, expect, it } from 'vitest';
import { formatEntityId, parseEntityKind, parseTenantId, parseTimestamp } from '@office/contracts';
import type { TenantId, Timestamp } from '@office/contracts';
import { ok, parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { authorizationContext, definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import { runSync, SYNC_MAX_LIMIT } from './sync';
import type { RunSyncRequest, SyncEngineDeps, SyncOutcome } from './sync';
import { createInMemorySourceMappingStore } from './mapping';
import { createInMemorySyncCursorStore } from './cursor';
import { syncStream, syncCursor, syncCursorToken } from './cursor';
import type { SyncCursor } from './cursor';
import { createInMemoryConflictStore } from './conflict';
import { coordinateOf } from './source-ref';
import { providerObjectId, providerObjectKind, providerSystemId, providerVersion } from './identity';
import {
  FAKE_ADAPTER_KIND,
  FAKE_ARCHIVE_COMMAND,
  FAKE_CREATE_COMMAND,
  FAKE_OBJECT_KIND,
  FAKE_SYSTEM_ID,
  FAKE_UPDATE_COMMAND,
  createFakeProvider,
} from './fake-provider';
import type { FakeProvider } from './fake-provider';
import type { Adapter } from './adapter';

// OFF-020 adapters-sdk — the sync engine. runSync drives one page of one
// object-kind stream through the canonical intake path: authorize (adapter
// actor + declared capability, deny-by-default) → resume (cursor stream
// membership) → pull (fail-closed parse of adapter output, tenant/stream
// injection guards) → reconcile (mapping branches: create, replay no-op,
// provider-moved update/delete, canonical-ahead, BOTH-moved conflict) →
// checkpoint (monotonic cursor). Restarting from the persisted cursor
// re-processes nothing checkpointed; re-delivered items no-op through the
// SourceRef-derived idempotency keys. Deterministic: fixed clock/ids.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160504f3e2d1c0b'));

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `org${String(n).padStart(13, '0')}` });
const version = (n: number) => unwrap(parseAggregateVersion(n));
const ORGANIZATION = unwrap(parseEntityKind('organization'));

const CONTEXT = authorizationContext({
  actor: { kind: 'adapter', actorId: entity(90) },
  scope: { kind: 'tenant', tenantId: TENANT_A },
  capabilities: ['organization.write'],
});

const ALLOW_POLICY: Policy = definePolicy([
  { effect: 'allow', actorKinds: ['adapter'], capabilities: ['organization.write'] },
]);
const DENY_BY_DEFAULT: Policy = definePolicy([]);

const STREAM = syncStream({
  tenantId: TENANT_A,
  adapterKind: FAKE_ADAPTER_KIND,
  systemId: FAKE_SYSTEM_ID,
  objectKind: FAKE_OBJECT_KIND,
});

/** A canonical version lookup over an explicit, deterministic table. */
const versionLookup =
  (table: Map<string, AggregateVersion | null>) =>
  async (
    tenantId: TenantId,
    canonical: { readonly entityKind: string; readonly entityId: string },
  ): Promise<Result<AggregateVersion | null, DomainError>> => {
    if (tenantId !== TENANT_A) return ok(null);
    return ok(table.get(canonical.entityId) ?? null);
  };

/** Deterministic sync engine deps: fixed clock, sequential office-issued ids. */
const engineDeps = (parts?: {
  readonly at?: Timestamp;
  readonly versions?: Map<string, AggregateVersion | null>;
}): SyncEngineDeps => {
  let nextId = 1;
  const versions = parts?.versions ?? new Map<string, AggregateVersion | null>();
  return {
    mappings: createInMemorySourceMappingStore(),
    cursors: createInMemorySyncCursorStore(),
    conflicts: createInMemoryConflictStore(),
    canonicalVersionOf: versionLookup(versions),
    now: () => parts?.at ?? NOW_1,
    nextCanonicalId: () => entity(nextId++),
  };
};

const seededProvider = (objects: number): FakeProvider => {
  const provider = createFakeProvider();
  for (let index = 1; index <= objects; index += 1) {
    provider.putObject({ objectId: `c-${index}`, displayName: `Contact ${index}` });
  }
  return provider;
};

const run = (parts: {
  readonly provider: FakeProvider;
  readonly deps: SyncEngineDeps;
  readonly cursor?: SyncCursor | null;
  readonly limit?: number;
  readonly policy?: Policy;
  readonly objectKind?: ReturnType<typeof providerObjectKind>;
  readonly adapter?: Adapter;
  readonly systemId?: ReturnType<typeof providerSystemId>;
}): Promise<Result<SyncOutcome, DomainError>> => {
  const request: RunSyncRequest = {
    authorization: { context: CONTEXT, policy: parts.policy ?? ALLOW_POLICY },
    adapter: parts.adapter ?? parts.provider.adapter,
    translator: parts.provider.translator,
    systemId: parts.systemId ?? FAKE_SYSTEM_ID,
    objectKind: parts.objectKind ?? FAKE_OBJECT_KIND,
    cursor: parts.cursor === undefined ? null : parts.cursor,
    limit: parts.limit ?? 100,
  };
  return runSync(request, parts.deps);
};

describe('sync out: the first pull maps objects and checkpoints the stream', () => {
  it('maps every object, proposes create commands, and stamps office-issued ids', async () => {
    const provider = seededProvider(2);
    const deps = engineDeps();
    const outcome = unwrap(await run({ provider, deps }));
    expect(outcome.applications).toHaveLength(2);
    for (const [index, application] of outcome.applications.entries()) {
      expect(application.outcome).toBe('mapped-created');
      expect(application.command).not.toBeNull();
      if (application.command !== null) {
        expect(application.command.commandName).toBe(FAKE_CREATE_COMMAND);
        // Office-issued canonical ids, in deterministic sequence — never
        // the provider's object ids (A10).
        expect(application.mapping?.canonical.entityId).toBe(entity(index + 1));
        expect(application.mapping?.canonical.entityId).not.toBe(`c-${index + 1}`);
      }
      expect(application.mapping?.providerVersion).toBe('v1');
    }
    // A single page that exhausts the stream carries no continuation token.
    expect(outcome.cursor).toBeNull();
    expect(outcome.hasMore).toBe(false);
    expect(outcome.conflicts).toStrictEqual([]);
  });

  it('pages the stream and advances the persisted cursor per page', async () => {
    const provider = seededProvider(3);
    const deps = engineDeps({ at: NOW_1 });

    const page1 = unwrap(await run({ provider, deps, limit: 1 }));
    expect(page1.applications).toHaveLength(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).not.toBeNull();
    if (page1.cursor !== null) {
      expect(page1.cursor.token).toBe('1');
      expect(page1.cursor.checkpoint.itemsObserved).toBe(1);
      expect(page1.cursor.checkpoint.lastProviderVersion).toBe('v1');
      expect(page1.cursor.updatedAt).toBe(NOW_1);
      // The cursor is PERSISTED: a restart loads exactly this position.
      expect(await deps.cursors.load(STREAM)).toStrictEqual(page1.cursor);
    }

    // Restart from the persisted cursor: the provider resumes AFTER the
    // checkpoint — nothing already checkpointed is re-delivered.
    const persisted = await deps.cursors.load(STREAM);
    const page2 = unwrap(await run({ provider, deps, cursor: persisted, limit: 1 }));
    expect(page2.applications).toHaveLength(1);
    expect(page2.applications[0]?.snapshot.source.objectId).toBe('c-2');
    expect(page2.cursor?.token).toBe('2');
    if (page2.cursor !== null) {
      expect(await deps.cursors.load(STREAM)).toStrictEqual(page2.cursor);
    }

    const page3 = unwrap(
      await run({ provider, deps, cursor: await deps.cursors.load(STREAM), limit: 1 }),
    );
    expect(page3.applications).toHaveLength(1);
    expect(page3.applications[0]?.snapshot.source.objectId).toBe('c-3');
    // Stream exhausted: no continuation token, nothing more.
    expect(page3.cursor?.token).toBe('2'); // unchanged: the page saved nothing
    expect(page3.hasMore).toBe(false);
  });
});

describe('cursor replay-safety (restart and at-least-once re-delivery)', () => {
  it('re-processes nothing checkpointed when restarting from the persisted cursor', async () => {
    const provider = seededProvider(3);
    const deps = engineDeps();
    // Page through the whole stream with limit 1, always resuming from the
    // store's persisted position.
    const seen: string[] = [];
    let cursor: SyncCursor | null = null;
    for (let page = 0; page < 3; page += 1) {
      const outcome = unwrap(await run({ provider, deps, cursor, limit: 1 }));
      for (const application of outcome.applications) {
        seen.push(application.snapshot.source.objectId);
      }
      cursor = await deps.cursors.load(STREAM);
    }
    // Each object was delivered exactly once: positional replay safety.
    expect(seen).toStrictEqual(['c-1', 'c-2', 'c-3']);
    expect(await countMappings(deps)).toBe(3);
  });

  it('no-ops a re-delivered item through the idempotency layer (no duplicate mapping/command)', async () => {
    const provider = seededProvider(2);
    const versions = new Map<string, AggregateVersion | null>();
    const deps = engineDeps({ versions });
    // First pass: both objects mapped; the create commands executed
    // canonically (both aggregates now exist at version 1).
    unwrap(await run({ provider, deps }));
    versions.set(entity(1), version(1));
    versions.set(entity(2), version(1));

    // A full re-run from the very beginning (e.g. an operator reset the
    // cursor, or the provider re-delivered the page): same SourceRefs, same
    // versions, canonical quiet — every item is a typed replay no-op.
    const replay = unwrap(await run({ provider, deps, cursor: null }));
    expect(replay.applications.map((application) => application.outcome)).toStrictEqual([
      'replay-no-op',
      'replay-no-op',
    ]);
    for (const application of replay.applications) {
      expect(application.command).toBeNull();
    }
    expect(await countMappings(deps)).toBe(2);
    expect(replay.conflicts).toStrictEqual([]);

    // Restarting from the persisted cursor across a re-delivered page is the
    // same no-op: the token re-delivers c-2 only, at the same version.
    const cursor = syncCursor({
      stream: STREAM,
      token: syncCursorToken('1'),
      checkpoint: { itemsObserved: 1, lastProviderVersion: null },
      updatedAt: NOW_1,
    });
    const redelivered = unwrap(await run({ provider, deps, cursor, limit: 1 }));
    expect(redelivered.applications[0]?.snapshot.source.objectId).toBe('c-2');
    expect(redelivered.applications[0]?.outcome).toBe('replay-no-op');
    expect(redelivered.applications[0]?.command).toBeNull();
    expect(await countMappings(deps)).toBe(2);
  });
});

describe('stream membership and authorization guards run BEFORE the pull', () => {
  it('typed-rejects a cursor of a different tenant before touching the provider', async () => {
    const provider = seededProvider(1);
    let pulls = 0;
    const countingAdapter: Adapter = {
      ...provider.adapter,
      sync: async (request) => {
        pulls += 1;
        return provider.adapter.sync(request);
      },
    };
    const foreign = syncCursor({
      stream: syncStream({
        tenantId: TENANT_B,
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: FAKE_SYSTEM_ID,
        objectKind: FAKE_OBJECT_KIND,
      }),
      token: syncCursorToken('1'),
      checkpoint: { itemsObserved: 1, lastProviderVersion: null },
      updatedAt: NOW_1,
    });
    const result = await run({ provider, deps: engineDeps(), cursor: foreign, adapter: countingAdapter });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('tenant-scope-violation');
    }
    expect(pulls).toBe(0); // the rejection preceded the provider pull
  });

  it('typed-rejects a cursor of a different stream (adapter/system/object kind)', async () => {
    const provider = seededProvider(1);
    for (const stream of [
      syncStream({
        tenantId: TENANT_A,
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: FAKE_SYSTEM_ID,
        objectKind: providerObjectKind('task'),
      }),
      syncStream({
        tenantId: TENANT_A,
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: providerSystemId('fake-instance-02'),
        objectKind: FAKE_OBJECT_KIND,
      }),
    ]) {
      const foreign = syncCursor({
        stream,
        token: syncCursorToken('1'),
        checkpoint: { itemsObserved: 1, lastProviderVersion: null },
        updatedAt: NOW_1,
      });
      const result = await run({ provider, deps: engineDeps(), cursor: foreign });
      expect(result.ok, `stream: ${JSON.stringify(stream)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invariant-violation');
        expect(result.error.details[0]?.code).toBe('cursor-stream-mismatch');
      }
    }
  });

  it('typed-rejects an invalid page size and an undeclared object kind', async () => {
    const provider = seededProvider(1);
    for (const limit of [0, -1, 1.5, SYNC_MAX_LIMIT + 1]) {
      const result = await run({ provider, deps: engineDeps(), limit });
      expect(result.ok, `limit: ${String(limit)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invariant-violation');
        expect(result.error.details[0]?.code).toBe('sync-limit-invalid');
      }
    }
    const undeclared = await run({
      provider,
      deps: engineDeps(),
      objectKind: providerObjectKind('task'),
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.error.code).toBe('invariant-violation');
      expect(undeclared.error.details[0]?.code).toBe('object-kind-not-declared');
    }
    const wrongSystem = await run({
      provider,
      deps: engineDeps(),
      systemId: providerSystemId('fake-instance-02'),
    });
    expect(wrongSystem.ok).toBe(false); // the fake provider rejects foreign systems
    if (!wrongSystem.ok) {
      expect(wrongSystem.error.code).toBe('invariant-violation');
      expect(wrongSystem.error.details[0]?.code).toBe('provider-system-mismatch');
    }
  });

  it('authorizes deny-by-default and typed-rejects non-adapter actors', async () => {
    const provider = seededProvider(1);
    const denied = await run({ provider, deps: engineDeps(), policy: DENY_BY_DEFAULT });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('forbidden');
      expect(denied.error.details[0]?.code).toBe('no-allow-rule');
    }
    const userContext = authorizationContext({
      actor: { kind: 'user', actorId: entity(99) },
      scope: { kind: 'tenant', tenantId: TENANT_A },
      capabilities: ['organization.write'],
    });
    const wrongActor = await runSync(
      {
        authorization: { context: userContext, policy: ALLOW_POLICY },
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: FAKE_SYSTEM_ID,
        objectKind: FAKE_OBJECT_KIND,
        cursor: null,
        limit: 100,
      },
      engineDeps(),
    );
    expect(wrongActor.ok).toBe(false);
    if (!wrongActor.ok) {
      expect(wrongActor.error.code).toBe('forbidden');
      expect(wrongActor.error.details[0]?.code).toBe('adapter-actor-required');
    }
  });
});

describe('reconciliation branches', () => {
  it('applies provider updates when the canonical side is quiet', async () => {
    const provider = seededProvider(1);
    const versions = new Map<string, AggregateVersion | null>();
    const deps = engineDeps({ versions });
    unwrap(await run({ provider, deps }));
    versions.set(entity(1), version(1));
    provider.updateObject('c-1', { displayName: 'Contact 1 (renamed)' });

    const outcome = unwrap(await run({ provider, deps, cursor: null }));
    expect(outcome.applications[0]?.outcome).toBe('applied-update');
    expect(outcome.applications[0]?.command?.commandName).toBe(FAKE_UPDATE_COMMAND);
    expect(outcome.applications[0]?.mapping?.providerVersion).toBe('v2');
    expect(outcome.conflicts).toStrictEqual([]);
  });

  it('applies provider deletions as archive commands', async () => {
    const provider = seededProvider(1);
    const versions = new Map<string, AggregateVersion | null>();
    const deps = engineDeps({ versions });
    unwrap(await run({ provider, deps }));
    versions.set(entity(1), version(1));
    provider.deleteObject('c-1');

    const outcome = unwrap(await run({ provider, deps, cursor: null }));
    expect(outcome.applications[0]?.outcome).toBe('applied-deletion');
    expect(outcome.applications[0]?.command?.commandName).toBe(FAKE_ARCHIVE_COMMAND);
  });

  it('skips orphan deletions of never-mapped objects', async () => {
    const provider = seededProvider(1);
    const deps = engineDeps();
    provider.deleteObject('c-1');
    const outcome = unwrap(await run({ provider, deps }));
    expect(outcome.applications[0]?.outcome).toBe('orphan-deletion-skipped');
    expect(outcome.applications[0]?.mapping).toBeNull();
    expect(outcome.applications[0]?.command).toBeNull();
  });

  it('no-ops when only the canonical side moved (canonical owns the truth)', async () => {
    const provider = seededProvider(1);
    const versions = new Map<string, AggregateVersion | null>();
    const deps = engineDeps({ versions });
    unwrap(await run({ provider, deps }));
    // The canonical aggregate advanced independently (an office-side edit).
    versions.set(entity(1), version(4));
    const outcome = unwrap(await run({ provider, deps, cursor: null }));
    expect(outcome.applications[0]?.outcome).toBe('canonical-ahead');
    expect(outcome.applications[0]?.command).toBeNull();
    expect(outcome.applications[0]?.mapping?.canonicalVersion).toBe(4);
    expect(outcome.conflicts).toStrictEqual([]);
  });
});

describe('conflict detection (divergence → explicit record, both sides)', () => {
  it('detects a both-sides-moved divergence without proposing a command', async () => {
    const provider = seededProvider(1);
    const versions = new Map<string, AggregateVersion | null>();
    const deps = engineDeps({ versions });
    const first = unwrap(await run({ provider, deps }));
    const canonicalId = first.applications[0]?.mapping?.canonical.entityId;
    expect(canonicalId).toBe(entity(1));

    // BOTH sides advance independently since the last synchronized point.
    versions.set(entity(1), version(2)); // canonical aggregate moved (office-side edit)
    provider.updateObject('c-1', { displayName: 'Contact 1 (provider edit)' }); // provider moved

    const outcome = unwrap(await run({ provider, deps, cursor: null }));
    const application = outcome.applications[0];
    expect(application?.outcome).toBe('conflict-detected');
    expect(application?.command).toBeNull();

    // The explicit Conflict record carries BOTH sides…
    expect(outcome.conflicts).toHaveLength(1);
    const conflict = outcome.conflicts[0];
    expect(conflict).toBeDefined();
    if (conflict !== undefined) {
      expect(conflict.kind).toBe('source-conflict');
      expect(conflict.tenantId).toBe(TENANT_A);
      // …the provider side INCLUDING the observed provider version…
      expect(conflict.source.objectId).toBe('c-1');
      expect(conflict.source.version).toBe('v2');
      // …and the canonical side with its version at detection.
      expect(conflict.canonical.entityKind).toBe('organization');
      expect(conflict.canonical.entityId).toBe(entity(1));
      expect(conflict.canonicalVersion).toBe(2);
      // Detection state, no resolution — never auto-resolved.
      expect(conflict.state).toBe('detected');
      expect(conflict.resolution).toBeNull();
      expect(conflict.detectedBy).toStrictEqual({ kind: 'adapter', actorId: entity(90) });
      // Persisted in the tenant's conflict store, queryable by source.
      expect(await deps.conflicts.findById(TENANT_A, conflict.conflictId)).toStrictEqual(conflict);
      expect(
        await deps.conflicts.listBySource(TENANT_A, coordinateOf(conflict.source)),
      ).toHaveLength(1);
    }

    // The mapping bookkeeping did NOT advance past the divergence point.
    const stored = await deps.mappings.findByCoordinate(
      TENANT_A,
      coordinateOf({
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: FAKE_SYSTEM_ID,
        objectType: FAKE_OBJECT_KIND,
        objectId: providerObjectId('c-1'),
        version: providerVersion('v2'),
      }),
    );
    expect(stored?.providerVersion).toBe('v1');
    expect(stored?.canonicalVersion).toBe(1);
  });

  it('re-detecting the same divergence is idempotent (no duplicate record)', async () => {
    const provider = seededProvider(1);
    const versions = new Map<string, AggregateVersion | null>();
    const deps = engineDeps({ versions });
    unwrap(await run({ provider, deps }));
    versions.set(entity(1), version(2));
    provider.updateObject('c-1', { displayName: 'Contact 1 (provider edit)' });

    const first = unwrap(await run({ provider, deps, cursor: null }));
    const second = unwrap(await run({ provider, deps, cursor: null }));
    expect(first.conflicts).toHaveLength(1);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]).toStrictEqual(first.conflicts[0]);
    // Still exactly one conflict for the source — no duplicates.
    const listed = await deps.conflicts.listBySource(
      TENANT_A,
      coordinateOf({
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: FAKE_SYSTEM_ID,
        objectType: FAKE_OBJECT_KIND,
        objectId: providerObjectId('c-1'),
        version: providerVersion('v2'),
      }),
    );
    expect(listed).toHaveLength(1);
  });
});

describe('adapter output guards (untrusted implementors)', () => {
  it('typed-rejects a snapshot stamped for a foreign tenant', async () => {
    const provider = seededProvider(1);
    const injecting: Adapter = {
      ...provider.adapter,
      sync: async (request) => {
        const pulled = await provider.adapter.sync(request);
        if (!pulled.ok) return pulled;
        const snapshots = pulled.value.snapshots.map((snapshot) => ({
          ...snapshot,
          tenantId: TENANT_B,
        }));
        return ok({ ...pulled.value, snapshots });
      },
    };
    const result = await run({ provider, deps: engineDeps(), adapter: injecting });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('tenant-scope-violation');
    }
  });

  it('typed-rejects a snapshot of a different stream', async () => {
    const provider = seededProvider(1);
    const injecting: Adapter = {
      ...provider.adapter,
      sync: async (request) => {
        const pulled = await provider.adapter.sync(request);
        if (!pulled.ok) return pulled;
        const snapshots = pulled.value.snapshots.map((snapshot) => ({
          ...snapshot,
          source: { ...snapshot.source, objectType: providerObjectKind('task') },
        }));
        return ok({ ...pulled.value, snapshots });
      },
    };
    const result = await run({ provider, deps: engineDeps(), adapter: injecting });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('snapshot-stream-mismatch');
    }
  });

  it('typed-rejects an adapter page that fails the fail-closed result parse', async () => {
    const provider = seededProvider(1);
    const malformed: Adapter = {
      ...provider.adapter,
      sync: async () => ok({ kind: 'sync-result', snapshots: [null] } as never),
    };
    const result = await run({ provider, deps: engineDeps(), adapter: malformed });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code.startsWith('sync-result-')).toBe(true);
    }
  });
});

/** Count the tenant's mappings through the reverse index of the fixture. */
const countMappings = async (deps: SyncEngineDeps): Promise<number> => {
  let count = 0;
  for (let index = 1; index <= 9; index += 1) {
    const listed = await deps.mappings.listByCanonical(TENANT_A, {
      entityKind: ORGANIZATION,
      entityId: entity(index),
    });
    count += listed.length;
  }
  return count;
};
