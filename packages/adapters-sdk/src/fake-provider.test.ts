import { describe, expect, it } from 'vitest';
import { formatEntityId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { TenantId, Timestamp } from '@office/contracts';
import { ok, parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import { authorizationContext, definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import { applyWebhook } from './webhook';
import { runSync } from './sync';
import type { SyncEngineDeps, SyncOutcome } from './sync';
import { createInMemorySourceMappingStore } from './mapping';
import { createInMemorySyncCursorStore } from './cursor';
import { syncStream } from './cursor';
import type { SyncCursor } from './cursor';
import { createInMemoryConflictStore, resolveConflict } from './conflict';
import { coordinateOf } from './source-ref';
import { providerObjectId, providerVersion } from './identity';
import {
  FAKE_ADAPTER_KIND,
  FAKE_ARCHIVE_COMMAND,
  FAKE_CREATE_COMMAND,
  FAKE_OBJECT_KIND,
  FAKE_SYSTEM_ID,
  FAKE_UPDATE_COMMAND,
  createFakeProvider,
  createFakeWebhookVerifier,
  fakeAuditEventRef,
} from './fake-provider';

// OFF-020 adapters-sdk — THE named acceptance: the fake provider's objects
// round-trip through the Adapter contract end to end, WITHOUT importing any
// core provider code (only the merged office packages):
//
//   1. SYNC OUT      — snapshots + cursor advance, mappings recorded against
//                      office-issued canonical ids;
//   2. WEBHOOK IN    — a normalized envelope with SourceRef resolution back
//                      to the SAME canonical id the sync established;
//   3. CONFLICT      — divergence (both sides moved) lands as an explicit
//                      Conflict record carrying both sides, in the detected
//                      state, with no command and no auto-resolution;
//   4. REPLAY        — the same SourceRef + version is an idempotent no-op:
//                      no duplicate mapping, no duplicate command, and
//                      conflict re-detection appends nothing.
//
// The whole scenario is then run a SECOND time with fresh stores and the same
// injected clock/id suppliers: identical inputs MUST produce identical
// mappings, cursors, conflicts, and commands (determinism gate).

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));
const NOW_4: Timestamp = unwrap(parseTimestamp('2026-09-15T09:00:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `org${String(n).padStart(13, '0')}` });
const version = (n: number) => unwrap(parseAggregateVersion(n));

const CONTEXT = authorizationContext({
  actor: { kind: 'adapter', actorId: entity(90) },
  scope: { kind: 'tenant', tenantId: TENANT_A },
  capabilities: ['organization.write'],
});
const POLICY: Policy = definePolicy([
  { effect: 'allow', actorKinds: ['adapter'], capabilities: ['organization.write'] },
]);

const STREAM = syncStream({
  tenantId: TENANT_A,
  adapterKind: FAKE_ADAPTER_KIND,
  systemId: FAKE_SYSTEM_ID,
  objectKind: FAKE_OBJECT_KIND,
});

/** Deterministic engine state: fixed clock, sequential ids, version table. */
const engine = () => {
  let nextId = 1;
  const versions = new Map<string, AggregateVersion | null>();
  const deps: SyncEngineDeps = {
    mappings: createInMemorySourceMappingStore(),
    cursors: createInMemorySyncCursorStore(),
    conflicts: createInMemoryConflictStore(),
    canonicalVersionOf: async (tenantId, canonical) => {
      if (tenantId !== TENANT_A) return ok(null);
      return ok(versions.get(canonical.entityId) ?? null);
    },
    now: () => NOW_1,
    nextCanonicalId: () => entity(nextId++),
  };
  return { deps, versions };
};

/**
 * The full round-trip scenario, as a pure function of injected state. Every
 * step is driven through the PUBLIC engine surfaces (runSync / applyWebhook /
 * resolveConflict) against the fake provider — no direct store surgery
 * except the canonical version table, which stands in for the runtime's
 * command execution (the graph the adapters never touch).
 */
const scenario = async (): Promise<{
  readonly syncRuns: readonly SyncOutcome[];
  readonly webhookOutcomes: readonly {
    readonly outcome: string;
    readonly commandName: string | null;
    readonly mappedCanonical: string | null;
    readonly providerVersion: string | null;
  }[];
  readonly replayWebhookOutcome: string;
  readonly replaySyncOutcomes: readonly string[];
  readonly mappings: readonly unknown[];
  readonly cursor: unknown;
  readonly conflicts: readonly unknown[];
  readonly resolvedConflict: unknown;
  readonly commandCount: number;
}> => {
  const provider = createFakeProvider();
  provider.putObject({ objectId: 'c-1', displayName: 'Site logistics contact' });
  provider.putObject({ objectId: 'c-2', displayName: 'Field supervision contact' });
  const { deps, versions } = engine();
  const commands: string[] = [];

  const noteCommand = (name: string | null): void => {
    if (name !== null) commands.push(name);
  };

  // ---- 1. SYNC OUT: page the stream one object at a time -----------------
  const syncRuns: SyncOutcome[] = [];
  let cursor: SyncCursor | null = null;
  for (let page = 0; page < 2; page += 1) {
    const run = unwrap(
      await runSync(
        {
          authorization: { context: CONTEXT, policy: POLICY },
          adapter: provider.adapter,
          translator: provider.translator,
          systemId: FAKE_SYSTEM_ID,
          objectKind: FAKE_OBJECT_KIND,
          cursor,
          limit: 1,
        },
        deps,
      ),
    );
    for (const application of run.applications) {
      noteCommand(application.command?.commandName ?? null);
    }
    syncRuns.push(run);
    cursor = await deps.cursors.load(STREAM);
  }

  // The create commands executed canonically: both aggregates exist at v1.
  versions.set(entity(1), version(1));
  versions.set(entity(2), version(1));

  // ---- 2. WEBHOOK IN: an inbound update for the mapped source ------------
  provider.updateObject('c-1', { displayName: 'Site logistics contact (updated)' });
  // The raw webhook is captured ONCE at this provider state: the replay in
  // step 4 redelivers THIS exact event (same body, same signature).
  const rawWebhook = provider.emitWebhook('updated', 'c-1');
  const webhook = unwrap(
    await applyWebhook({
      authorization: { context: CONTEXT, policy: POLICY },
      adapter: provider.adapter,
      translator: provider.translator,
      verifier: createFakeWebhookVerifier(),
      deps: {
        mappings: deps.mappings,
        canonicalVersionOf: deps.canonicalVersionOf,
        now: () => NOW_2,
        nextCanonicalId: () => entity(99),
      },
      raw: rawWebhook,
    }),
  );
  noteCommand(webhook.command?.commandName ?? null);
  // The webhook's update command executed canonically: aggregate 1 at v2.
  versions.set(entity(1), version(2));

  // ---- 3. CONFLICT: both sides move independently -------------------------
  provider.updateObject('c-1', { displayName: 'Site logistics contact (provider edit)' });
  versions.set(entity(1), version(3)); // an office-side edit lands in the same window
  const conflictRun = unwrap(
    await runSync(
      {
        authorization: { context: CONTEXT, policy: POLICY },
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: FAKE_SYSTEM_ID,
        objectKind: FAKE_OBJECT_KIND,
        cursor: null,
        limit: 100,
      },
      deps,
    ),
  );
  for (const application of conflictRun.applications) {
    noteCommand(application.command?.commandName ?? null);
  }
  syncRuns.push(conflictRun);

  // ---- 4. REPLAY: same SourceRef + version everywhere ---------------------
  // 4a. The webhook that already applied is redelivered VERBATIM (the same
  //     raw event object — same body, same signature, same version).
  const replayWebhook = unwrap(
    await applyWebhook({
      authorization: { context: CONTEXT, policy: POLICY },
      adapter: provider.adapter,
      translator: provider.translator,
      verifier: createFakeWebhookVerifier(),
      deps: {
        mappings: deps.mappings,
        canonicalVersionOf: deps.canonicalVersionOf,
        now: () => NOW_3,
        nextCanonicalId: () => entity(99),
      },
      raw: rawWebhook,
    }),
  );
  noteCommand(replayWebhook.command?.commandName ?? null);
  // 4b. A full re-run of the sync from the very beginning: c-2 replays
  //     verbatim (v1, canonical quiet), c-1 re-detects the SAME divergence.
  const replaySync = unwrap(
    await runSync(
      {
        authorization: { context: CONTEXT, policy: POLICY },
        adapter: provider.adapter,
        translator: provider.translator,
        systemId: FAKE_SYSTEM_ID,
        objectKind: FAKE_OBJECT_KIND,
        cursor: null,
        limit: 100,
      },
      deps,
    ),
  );
  for (const application of replaySync.applications) {
    noteCommand(application.command?.commandName ?? null);
  }
  syncRuns.push(replaySync);

  // ---- 5. EXPLICIT RESOLUTION (after the fact, with audit refs) ----------
  const detected = conflictRun.conflicts[0];
  const resolved =
    detected !== undefined
      ? unwrap(
          await resolveConflict({
            store: deps.conflicts,
            conflict: detected,
            strategy: 'merge',
            resolvedBy: { kind: 'user', actorId: entity(91) },
            auditEventRefs: [fakeAuditEventRef('office-evt-v1-0123456789abcdef0123456789abcdef')],
            now: NOW_4,
          }),
        )
      : null;

  // ---- the deterministic world-state snapshot -----------------------------
  const mappingOf = (objectId: string) =>
    deps.mappings.findByCoordinate(
      TENANT_A,
      coordinateOf({
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: FAKE_SYSTEM_ID,
        objectType: FAKE_OBJECT_KIND,
        objectId: providerObjectId(objectId),
        version: providerVersion('v1'),
      }),
    );
  const coordinateOfC1 = coordinateOf({
    adapterKind: FAKE_ADAPTER_KIND,
    systemId: FAKE_SYSTEM_ID,
    objectType: FAKE_OBJECT_KIND,
    objectId: providerObjectId('c-1'),
    version: providerVersion('v1'),
  });
  return {
    syncRuns,
    webhookOutcomes: [
      {
        outcome: webhook.outcome,
        commandName: webhook.command?.commandName ?? null,
        mappedCanonical: webhook.mapping?.canonical.entityId ?? null,
        providerVersion: webhook.mapping?.providerVersion ?? null,
      },
    ],
    replayWebhookOutcome: replayWebhook.outcome,
    replaySyncOutcomes: replaySync.applications.map((application) => application.outcome),
    mappings: [await mappingOf('c-1'), await mappingOf('c-2')],
    cursor: await deps.cursors.load(STREAM),
    conflicts: await deps.conflicts.listBySource(TENANT_A, coordinateOfC1),
    resolvedConflict: resolved,
    commandCount: commands.length,
  };
};

describe('fake-provider round-trip (THE OFF-020 acceptance)', () => {
  it('syncs out, webhooks in, detects conflicts, and replays idempotently', async () => {
    const world = await scenario();

    // ---- 1. SYNC OUT ------------------------------------------------------
    // Page 1 mapped c-1 and advanced + persisted the cursor; page 2 mapped
    // c-2 resuming from that cursor (nothing checkpointed re-delivered).
    expect(world.syncRuns[0]?.applications).toHaveLength(1);
    expect(world.syncRuns[0]?.applications[0]?.outcome).toBe('mapped-created');
    expect(world.syncRuns[0]?.applications[0]?.snapshot.source.objectId).toBe('c-1');
    expect(world.syncRuns[0]?.cursor?.token).toBe('1');
    expect(world.syncRuns[0]?.hasMore).toBe(true);

    expect(world.syncRuns[1]?.applications).toHaveLength(1);
    expect(world.syncRuns[1]?.applications[0]?.snapshot.source.objectId).toBe('c-2');
    // The second page exhausted the stream: the provider returns no
    // continuation token, so the run's effective cursor stays at the
    // persisted position (token '1') and hasMore is false.
    expect(world.syncRuns[1]?.cursor?.token).toBe('1');
    expect(world.syncRuns[1]?.hasMore).toBe(false);

    // Both mappings bind office-issued canonical ids (A10: provider ids are
    // never primary keys) in deterministic sequence.
    expect(world.mappings[0]).toMatchObject({
      canonical: { entityKind: 'organization', entityId: entity(1) },
      providerVersion: 'v2',
    });
    expect(world.mappings[1]).toMatchObject({
      canonical: { entityKind: 'organization', entityId: entity(2) },
      providerVersion: 'v1',
    });

    // ---- 2. WEBHOOK IN ----------------------------------------------------
    // The normalized envelope resolved the SourceRef back to the canonical id
    // the sync established, and the engine proposed the update command.
    expect(world.webhookOutcomes[0]).toStrictEqual({
      outcome: 'source-updated',
      commandName: FAKE_UPDATE_COMMAND,
      mappedCanonical: entity(1),
      providerVersion: 'v2',
    });

    // ---- 3. CONFLICT DETECTION -------------------------------------------
    // Both sides moved since the last synchronized point: an explicit record
    // with both sides, in the detected state — and NO command proposed.
    expect(world.syncRuns[2]?.conflicts).toHaveLength(1);
    const conflict = world.syncRuns[2]?.conflicts[0];
    expect(conflict).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'fake-crm',
        systemId: 'fake-instance-01',
        objectType: 'contact',
        objectId: 'c-1',
        version: 'v3',
      },
      canonical: { entityKind: 'organization', entityId: entity(1) },
      canonicalVersion: 3,
      state: 'detected',
      resolution: null,
    });
    expect(world.syncRuns[2]?.applications[0]?.outcome).toBe('conflict-detected');
    expect(world.syncRuns[2]?.applications[0]?.command).toBeNull();

    // ---- 4. REPLAY --------------------------------------------------------
    // The redelivered webhook (same SourceRef + version) is a typed no-op…
    expect(world.replayWebhookOutcome).toBe('replay-no-op');
    // …and the re-run sync replays c-2 verbatim while re-detecting the SAME
    // divergence for c-1 (idempotent append, no duplicate record).
    expect(world.replaySyncOutcomes).toStrictEqual(['conflict-detected', 'replay-no-op']);
    expect(world.conflicts).toHaveLength(1);
    expect(world.syncRuns[3]?.conflicts[0]).toStrictEqual(conflict);

    // Exactly one mapping per provider object — no duplicates anywhere.
    expect(world.mappings).toHaveLength(2);
    // Commands proposed across the WHOLE round-trip: two creates (sync pages)
    // + one update (webhook) — the conflict and every replay proposed none.
    expect(world.commandCount).toBe(3);

    // ---- 5. EXPLICIT RESOLUTION ------------------------------------------
    // Resolution is an explicit command citing audit event refs; the record
    // flips to resolved with both sides preserved.
    expect(world.resolvedConflict).toMatchObject({
      state: 'resolved',
      resolution: {
        strategy: 'merge',
        auditEventRefs: ['office-evt-v1-0123456789abcdef0123456789abcdef'],
      },
      canonical: { entityId: entity(1) },
    });
  });

  it('derives the deterministic create/delete command vocabulary', () => {
    // The fake fixture proposes the landed canonical organization commands —
    // generic provider vocabulary only, no real provider names.
    expect(FAKE_CREATE_COMMAND).toBe('organization.createOrganization');
    expect(FAKE_UPDATE_COMMAND).toBe('organization.updateOrganization');
    expect(FAKE_ARCHIVE_COMMAND).toBe('organization.archiveOrganization');
    expect(FAKE_ADAPTER_KIND).toBe('fake-crm');
    expect(FAKE_SYSTEM_ID).toBe('fake-instance-01');
    expect(FAKE_OBJECT_KIND).toBe('contact');
  });

  it('is fully deterministic: same inputs → same mappings/cursors/conflicts/commands', async () => {
    const first = await scenario();
    const second = await scenario();
    // Every observable of the round-trip — sync outcomes, webhook outcomes,
    // replays, mappings, the persisted cursor, conflicts, the resolved
    // record, and the proposed command count — is identical across runs.
    expect(second.syncRuns).toStrictEqual(first.syncRuns);
    expect(second.webhookOutcomes).toStrictEqual(first.webhookOutcomes);
    expect(second.replayWebhookOutcome).toBe(first.replayWebhookOutcome);
    expect(second.replaySyncOutcomes).toStrictEqual(first.replaySyncOutcomes);
    expect(second.mappings).toStrictEqual(first.mappings);
    expect(second.cursor).toStrictEqual(first.cursor);
    expect(second.conflicts).toStrictEqual(first.conflicts);
    expect(second.resolvedConflict).toStrictEqual(first.resolvedConflict);
    expect(second.commandCount).toBe(first.commandCount);
  });
});
