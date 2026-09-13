import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseEntityRef,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  applyWebhook,
  createFakeWebhookVerifier,
  createInMemoryConflictStore,
  createInMemorySourceMappingStore,
  createInMemorySyncCursorStore,
  providerObjectId,
  providerSystemId,
  runSync,
  sourceCoordinate,
  syncStream,
} from '@office/adapters-sdk';
import type { AdapterAuthorization, SyncEngineDeps } from '@office/adapters-sdk';
import {
  ELEMENT_OBJECT_KIND,
  MODEL_ADAPTER_KIND,
  MODEL_OBJECT_KIND,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_OBJECT_KIND,
} from './vocabulary';
import {
  COLUMN_ELEMENT_ID,
  LINKED_ACTIVITY_REF,
  LINKED_DOCUMENT_REF,
  TOWER_MODEL_ID,
  TOWER_MODEL_V2_ID,
  WALL_ELEMENT_ID,
  createSeededModelProvider,
} from './provider-fixture';
import type { SeededModelProvider } from './provider-fixture';
import { runModelSync } from './sync';

// OFF-022 adapter-model — the multi-stream sync driver over the SDK engine:
// model hierarchy stream order (parents map before children), replay-safe
// paging (positional cursors, idempotent re-runs), explicit conflicts on
// divergence, and webhook ingest per the SDK discipline. Deterministic:
// fixed clock, sequential office-issued ids, fixed fixture state.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-10-06T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-10-07T10:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-10-08T11:00:00.000Z'));
const NOW_4: Timestamp = unwrap(parseTimestamp('2026-10-09T12:00:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `mdl${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));

const AUTHORIZATION: AdapterAuthorization = {
  context: adapterAuthorizationContext({
    actorId: entity(90),
    scope: { kind: 'tenant', tenantId: TENANT_A },
    capabilities: ['models.write'],
  }),
  policy: { rules: [{ effect: 'allow', actorKinds: ['adapter'] }] },
};

/** Deterministic engine state: fixed clock, sequential office-issued ids. */
const engine = (now: () => Timestamp) => {
  let nextId = 1;
  const versions = new Map<string, AggregateVersion | null>();
  const deps: SyncEngineDeps = {
    mappings: createInMemorySourceMappingStore(),
    cursors: createInMemorySyncCursorStore(),
    conflicts: createInMemoryConflictStore(),
    canonicalVersionOf: async (tenantId, canonical) => {
      if (tenantId !== TENANT_A) return { ok: true as const, value: null };
      return { ok: true as const, value: versions.get(canonical.entityId) ?? null };
    },
    now,
    nextCanonicalId: () => entity(nextId++),
  };
  return { deps, versions };
};

/** The canonical element coordinate of the seeded wall element. */
const wallCoordinate = () =>
  sourceCoordinate({
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectType: ELEMENT_OBJECT_KIND,
    objectId: providerObjectId(WALL_ELEMENT_ID),
  });

const elementStream = () =>
  syncStream({
    tenantId: TENANT_A,
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectKind: ELEMENT_OBJECT_KIND,
  });

/** Establish the whole seeded world: sync every stream, execute the creates. */
const establishedWorld = async (now: () => Timestamp) => {
  const provider = createSeededModelProvider();
  const world = engine(now);
  const first = unwrap(
    await runModelSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: MODEL_SYSTEM_ID,
        limit: 10,
      },
      world.deps,
    ),
  );
  // The host executed every create command: all seven aggregates exist at v1.
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    world.versions.set(entity(n), version(1));
  }
  return { provider, ...world, first };
};

describe('runModelSync — the multi-stream hierarchy driver', () => {
  it('syncs the four streams in model hierarchy order, parents before children', async () => {
    const { deps, first } = await establishedWorld(() => NOW_1);
    expect(first.streams.map((stream) => stream.objectKind)).toStrictEqual([
      'model',
      'model-version',
      'element',
      'element-classification',
    ]);
    // Every application mapped a new object (nothing replayed on a fresh world).
    expect(first.streams.map((stream) => stream.applications.length)).toStrictEqual([1, 2, 2, 2]);
    for (const stream of first.streams) {
      for (const application of stream.applications) {
        expect(application.outcome).toBe('mapped-created');
        expect(application.command).not.toBeNull();
      }
    }
    // Commands were proposed in stream + provider order.
    expect(first.commands.map((command) => command.commandName)).toStrictEqual([
      'models.registerModel',
      'models.registerModelVersion',
      'models.registerModelVersion',
      'models.recordElementChange',
      'models.recordElementChange',
      'models.registerClassification',
      'models.registerClassification',
    ]);
    // A10/A11: provider ids are never primary keys — every mapping binds an
    // office-issued canonical id, issued in deterministic sequence.
    const wall = await deps.mappings.findByCoordinate(TENANT_A, await wallCoordinate());
    expect(wall?.canonical).toStrictEqual({ entityKind: 'element', entityId: entity(4) });
    expect(wall?.providerVersion).toBe('v1');
    const model = await deps.mappings.findByCoordinate(
      TENANT_A,
      sourceCoordinate({
        adapterKind: MODEL_ADAPTER_KIND,
        systemId: MODEL_SYSTEM_ID,
        objectType: MODEL_OBJECT_KIND,
        objectId: providerObjectId(TOWER_MODEL_ID),
      }),
    );
    expect(model?.canonical).toStrictEqual({ entityKind: 'model', entityId: entity(1) });
  });

  it('proposes the element change commands with full provider provenance', async () => {
    const { provider, first } = await establishedWorld(() => NOW_1);
    const wallCommand = first.commands.find(
      (command) =>
        command.commandName === 'models.recordElementChange' &&
        command.payload['elementId'] === entity(4),
    );
    expect(wallCommand).toBeDefined();
    expect(wallCommand?.payload).toMatchObject({
      elementId: entity(4),
      change: 'created',
      displayName: 'Wall 103 — grid B/4',
      classification: 'wall',
      quantity: { value: 42.5, unit: 'm2' },
      modelProviderId: TOWER_MODEL_ID,
      modelVersionProviderId: TOWER_MODEL_V2_ID,
      linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
      expectedVersion: 1,
    });
    // The command's idempotency key is the SourceRef-derived sync key: the
    // same provider object version never proposes twice.
    expect(wallCommand?.idempotencyKey).toMatch(/^office-sync-v1-[0-9a-z]{32,}$/);
    expect(provider.objects).toHaveLength(7);
  });

  it('propagates engine failures typed (a foreign provider system stops the run)', async () => {
    const provider = createSeededModelProvider();
    const { deps } = engine(() => NOW_1);
    const result = await runModelSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: providerSystemId('model-instance-99'),
        limit: 10,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('provider-system-mismatch');
    }
  });
});

describe('runModelSync — replay safety (A11: same SourceRef + version is a no-op)', () => {
  it('re-runs the whole sync without duplicate mappings or commands', async () => {
    const world = await establishedWorld(() => NOW_1);
    const second = unwrap(
      await runModelSync(
        {
          authorization: AUTHORIZATION,
          adapter: world.provider.adapter,
          translator: world.provider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 10,
        },
        world.deps,
      ),
    );
    // Everything already applied at the same provider versions: idempotent.
    for (const stream of second.streams) {
      for (const application of stream.applications) {
        expect(application.outcome).toBe('replay-no-op');
        expect(application.command).toBeNull();
      }
    }
    expect(second.commands).toStrictEqual([]);
    expect(second.conflicts).toStrictEqual([]);
    // Exactly one mapping per provider object — no duplicates anywhere.
    const wall = await world.deps.mappings.findByCoordinate(TENANT_A, await wallCoordinate());
    expect(wall?.canonical.entityId).toBe(entity(4));
    const bound = await world.deps.mappings.listByCanonical(TENANT_A, ref('element', entity(4)));
    expect(bound).toHaveLength(1);
  });

  it('applies a provider update on the next run and then replays it (applied-update → no-op)', async () => {
    const world = await establishedWorld(() => NOW_1);
    // The provider mutates the wall element (bumps to v2).
    world.provider.updateElement(WALL_ELEMENT_ID, {
      displayName: 'Wall 103 — grid B/5',
      data: {
        modelId: TOWER_MODEL_ID,
        modelVersionId: TOWER_MODEL_V2_ID,
        classification: 'wall',
        quantity: { value: 45.5, unit: 'm2' },
        linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
      },
    });
    const second = unwrap(
      await runModelSync(
        {
          authorization: AUTHORIZATION,
          adapter: world.provider.adapter,
          translator: world.provider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 10,
        },
        world.deps,
      ),
    );
    const wallApplication = second.streams
      .find((stream) => stream.objectKind === 'element')
      ?.applications.find((application) => application.snapshot.source.objectId === WALL_ELEMENT_ID);
    expect(wallApplication?.outcome).toBe('applied-update');
    expect(wallApplication?.command?.commandName).toBe('models.recordElementChange');
    expect(wallApplication?.command?.payload['change']).toBe('updated');
    expect(wallApplication?.command?.payload['quantity']).toStrictEqual({ value: 45.5, unit: 'm2' });
    // The canonical aggregate executed the update: the next run sees the
    // canonical side ahead of the mapping bookkeeping (provider quiet), and
    // the run AFTER that is the pure replay no-op.
    world.versions.set(entity(4), version(2));
    const third = unwrap(
      await runModelSync(
        {
          authorization: AUTHORIZATION,
          adapter: world.provider.adapter,
          translator: world.provider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 10,
        },
        world.deps,
      ),
    );
    const wallThird = third.streams
      .find((stream) => stream.objectKind === 'element')
      ?.applications.find((application) => application.snapshot.source.objectId === WALL_ELEMENT_ID);
    expect(wallThird?.outcome).toBe('canonical-ahead');
    expect(wallThird?.command).toBeNull();
    const fourth = unwrap(
      await runModelSync(
        {
          authorization: AUTHORIZATION,
          adapter: world.provider.adapter,
          translator: world.provider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 10,
        },
        world.deps,
      ),
    );
    for (const stream of fourth.streams) {
      for (const application of stream.applications) {
        expect(application.outcome).toBe('replay-no-op');
      }
    }
  });
});

describe('runModelSync — explicit conflicts (never last-write-wins)', () => {
  it('records a detected conflict with both sides when provider and office both moved', async () => {
    const world = await establishedWorld(() => NOW_1);
    // The provider mutates the wall element (v2)…
    world.provider.updateElement(WALL_ELEMENT_ID, {
      data: {
        modelId: TOWER_MODEL_ID,
        modelVersionId: TOWER_MODEL_V2_ID,
        classification: 'wall',
        quantity: { value: 46, unit: 'm2' },
        linkedRefs: [LINKED_ACTIVITY_REF],
      },
    });
    // …and an office-side edit lands in the same window (canonical at v2).
    world.versions.set(entity(4), version(2));
    const divergent = unwrap(
      await runModelSync(
        {
          authorization: AUTHORIZATION,
          adapter: world.provider.adapter,
          translator: world.provider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 10,
        },
        world.deps,
      ),
    );
    const wallApplication = divergent.streams
      .find((stream) => stream.objectKind === 'element')
      ?.applications.find((application) => application.snapshot.source.objectId === WALL_ELEMENT_ID);
    expect(wallApplication?.outcome).toBe('conflict-detected');
    expect(wallApplication?.command).toBeNull();
    expect(divergent.conflicts).toHaveLength(1);
    expect(divergent.conflicts[0]).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'model-cde',
        systemId: 'model-instance-01',
        objectType: 'element',
        objectId: WALL_ELEMENT_ID,
        version: 'v2',
      },
      canonical: { entityKind: 'element', entityId: entity(4) },
      canonicalVersion: 2,
      state: 'detected',
      resolution: null,
    });
    // Re-running the divergent sync re-detects the SAME conflict — an
    // idempotent append, no duplicate record, still no command.
    const reDetected = unwrap(
      await runModelSync(
        {
          authorization: AUTHORIZATION,
          adapter: world.provider.adapter,
          translator: world.provider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 10,
        },
        world.deps,
      ),
    );
    expect(reDetected.conflicts[0]).toStrictEqual(divergent.conflicts[0]);
    const recorded = await world.deps.conflicts.listBySource(
      TENANT_A,
      sourceCoordinate({
        adapterKind: MODEL_ADAPTER_KIND,
        systemId: MODEL_SYSTEM_ID,
        objectType: ELEMENT_OBJECT_KIND,
        objectId: providerObjectId(WALL_ELEMENT_ID),
      }),
    );
    expect(recorded).toHaveLength(1);
  });
});

describe('cursor restart safety (positional cursors, per-stream)', () => {
  it('resumes an interrupted element stream from the persisted cursor', async () => {
    const provider = createSeededModelProvider();
    const { deps, versions } = engine(() => NOW_1);
    const stream = await elementStream();
    // Page 1: the wall element maps.
    const pageOne = unwrap(
      await runSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: MODEL_SYSTEM_ID,
          objectKind: ELEMENT_OBJECT_KIND,
          cursor: null,
          limit: 1,
        },
        deps,
      ),
    );
    expect(pageOne.applications).toHaveLength(1);
    expect(pageOne.applications[0]?.snapshot.source.objectId).toBe(WALL_ELEMENT_ID);
    expect(pageOne.hasMore).toBe(true);
    const saved = await deps.cursors.load(stream);
    expect(saved?.token).toBe('1');

    // "Restart": a NEW engine call resumes from the persisted cursor.
    versions.set(entity(4), version(1));
    const pageTwo = unwrap(
      await runSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: MODEL_SYSTEM_ID,
          objectKind: ELEMENT_OBJECT_KIND,
          cursor: saved,
          limit: 1,
        },
        deps,
      ),
    );
    // Nothing checkpointed is re-delivered: only the column element applies.
    expect(pageTwo.applications).toHaveLength(1);
    expect(pageTwo.applications[0]?.snapshot.source.objectId).toBe(COLUMN_ELEMENT_ID);
    expect(pageTwo.hasMore).toBe(false);
  });

  it('rejects resuming one stream with another stream cursor (typed)', async () => {
    const provider = createSeededModelProvider();
    const { deps } = engine(() => NOW_1);
    // Establish a persisted cursor on the MODEL-VERSION stream (one of two
    // objects paged, so a continuation token survives)…
    unwrap(
      await runSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: MODEL_SYSTEM_ID,
          objectKind: MODEL_VERSION_OBJECT_KIND,
          cursor: null,
          limit: 1,
        },
        deps,
      ),
    );
    const versionStreamCursor = await deps.cursors.load(
      syncStream({
        tenantId: TENANT_A,
        adapterKind: MODEL_ADAPTER_KIND,
        systemId: MODEL_SYSTEM_ID,
        objectKind: MODEL_VERSION_OBJECT_KIND,
      }),
    );
    expect(versionStreamCursor).not.toBeNull();
    // …and try to resume the ELEMENT stream with it: typed rejection.
    const result = await runSync(
      {
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: MODEL_SYSTEM_ID,
        objectKind: ELEMENT_OBJECT_KIND,
        cursor: versionStreamCursor,
        limit: 10,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('cursor-stream-mismatch');
    }
  });

  it('pages every stream to exhaustion at limit 1 (7 applications, 7 commands)', async () => {
    const provider = createSeededModelProvider();
    const { deps } = engine(() => NOW_1);
    const outcome = unwrap(
      await runModelSync(
        {
          authorization: AUTHORIZATION,
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 1,
        },
        deps,
      ),
    );
    expect(outcome.streams.map((stream) => stream.applications.length)).toStrictEqual([1, 2, 2, 2]);
    expect(outcome.commands).toHaveLength(7);
    expect(outcome.streams.every((stream) => stream.hasMore === false)).toBe(true);
  });
});

describe('webhook ingest per the SDK discipline', () => {
  const world = async (): Promise<{
    readonly provider: SeededModelProvider;
    readonly deps: SyncEngineDeps;
    readonly versions: Map<string, AggregateVersion | null>;
  }> => {
    const established = await establishedWorld(() => NOW_1);
    return {
      provider: established.provider,
      deps: established.deps,
      versions: established.versions,
    };
  };

  it('applies an inbound element update webhook and replays it idempotently', async () => {
    const { provider, deps } = await world();
    // The provider pushes a column update (bumps to v2).
    provider.updateElement(COLUMN_ELEMENT_ID, {
      displayName: 'Column 21 — grid C/3',
      data: {
        modelId: TOWER_MODEL_ID,
        modelVersionId: TOWER_MODEL_V2_ID,
        classification: 'column',
        quantity: { value: 13.5, unit: 'm3' },
        linkedRefs: [LINKED_ACTIVITY_REF],
      },
    });
    const raw = provider.emitWebhook('updated', COLUMN_ELEMENT_ID);
    const applied = unwrap(
      await applyWebhook({
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        verifier: createFakeWebhookVerifier(),
        deps: {
          mappings: deps.mappings,
          canonicalVersionOf: deps.canonicalVersionOf,
          now: () => NOW_2,
          nextCanonicalId: () => entity(99),
        },
        raw,
      }),
    );
    expect(applied.outcome).toBe('source-updated');
    expect(applied.command?.commandName).toBe('models.recordElementChange');
    expect(applied.command?.payload).toMatchObject({
      elementId: entity(5),
      change: 'updated',
      classification: 'column',
      quantity: { value: 13.5, unit: 'm3' },
      linkedRefs: [LINKED_ACTIVITY_REF],
    });
    expect(applied.mapping?.canonical.entityId).toBe(entity(5));
    expect(applied.mapping?.providerVersion).toBe('v2');

    // The same raw event redelivered VERBATIM is a typed replay no-op.
    const replay = unwrap(
      await applyWebhook({
        authorization: AUTHORIZATION,
        adapter: provider.adapter,
        translator: provider.translator,
        verifier: createFakeWebhookVerifier(),
        deps: {
          mappings: deps.mappings,
          canonicalVersionOf: deps.canonicalVersionOf,
          now: () => NOW_3,
          nextCanonicalId: () => entity(99),
        },
        raw,
      }),
    );
    expect(replay.outcome).toBe('replay-no-op');
    expect(replay.command).toBeNull();
  });

  it('rejects a webhook with a bad signature (typed unauthorized)', async () => {
    const { provider, deps } = await world();
    const raw = provider.emitWebhook('updated', WALL_ELEMENT_ID);
    const result = await applyWebhook({
      authorization: AUTHORIZATION,
      adapter: provider.adapter,
      translator: provider.translator,
      verifier: createFakeWebhookVerifier(),
      deps: {
        mappings: deps.mappings,
        canonicalVersionOf: deps.canonicalVersionOf,
        now: () => NOW_4,
        nextCanonicalId: () => entity(99),
      },
      raw: { ...raw, headers: {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('webhook-signature-invalid');
    }
  });

  it('fails closed on an update for an unmapped source (run a targeted sync first)', async () => {
    const { provider, deps } = await world();
    const raw = provider.emitWebhook('updated', WALL_ELEMENT_ID);
    const result = await applyWebhook({
      authorization: AUTHORIZATION,
      adapter: provider.adapter,
      translator: provider.translator,
      verifier: createFakeWebhookVerifier(),
      deps: {
        mappings: createInMemorySourceMappingStore(),
        canonicalVersionOf: deps.canonicalVersionOf,
        now: () => NOW_4,
        nextCanonicalId: () => entity(99),
      },
      raw,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('source-mapping-not-found');
    }
  });
});

describe('determinism of the sync driver', () => {
  it('produces identical outcomes across two fully independent worlds', async () => {
    const run = async (): Promise<unknown> => {
      const world = await establishedWorld(() => NOW_1);
      world.provider.updateElement(WALL_ELEMENT_ID, {
        data: {
          modelId: TOWER_MODEL_ID,
          modelVersionId: TOWER_MODEL_V2_ID,
          classification: 'wall',
          quantity: { value: 45.5, unit: 'm2' },
          linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
        },
      });
      world.versions.set(entity(4), version(2));
      const divergent = unwrap(
        await runModelSync(
          {
            authorization: AUTHORIZATION,
            adapter: world.provider.adapter,
            translator: world.provider.translator,
            systemId: MODEL_SYSTEM_ID,
            limit: 10,
          },
          world.deps,
        ),
      );
      return JSON.stringify({
        streams: divergent.streams.map((stream) => ({
          objectKind: stream.objectKind,
          applications: stream.applications.map((application) => ({
            objectId: application.snapshot.source.objectId,
            outcome: application.outcome,
          })),
          conflicts: stream.conflicts,
        })),
        commands: divergent.commands.map((command) => ({
          commandName: command.commandName,
          idempotencyKey: command.idempotencyKey,
          payload: command.payload,
        })),
        conflicts: divergent.conflicts,
      });
    };
    expect(await run()).toStrictEqual(await run());
  });
});
