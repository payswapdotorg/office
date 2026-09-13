import { describe, expect, it } from 'vitest';
import { ok } from '@office/domain-kernel';
import { providerVersion, syncCursorToken } from '@office/adapters-sdk';
import type { Adapter, SyncResult } from '@office/adapters-sdk';
import {
  CHANGE_EVENT_OBJECT_KIND,
  CONSTRUCTION_SYSTEM_ID,
  DOCUMENT_OBJECT_KIND,
  OBSERVATION_OBJECT_KIND,
} from './vocabulary';
import { createConstructionProviderStore } from './provider-fixture';
import { createConstructionAdapter } from './adapter';
import { createConstructionTranslator } from './mapping';
import { runConstructionSync } from './sync';
import {
  CONTRACT_ID,
  NOW_1,
  PROJECT_ID,
  constructionAuthorization,
  engine,
  entity,
  unwrap,
  version,
} from './test-support';

// OFF-021 — the multi-stream construction sync orchestrator: every declared
// object-kind stream (or the caller's subset) paged to exhaustion through
// the SDK engine, resuming each stream from its persisted cursor. Same
// provider data + same cursors → same applications, mappings, conflicts,
// and proposed commands (determinism); a failed stream aborts the whole
// call with the typed failure (the runtime wraps calls in its own
// retry/transaction policy).

/** One object of each declared kind. */
const seededStore = () => {
  const store = createConstructionProviderStore();
  store.putDocument({
    objectId: 'doc-1',
    title: 'Structural drawing package',
    projectId: PROJECT_ID,
    discipline: 'structural',
    revision: { revisionId: 'rev-1', contentBase64: 'UEsDBBQABgAGAAA=' },
    updatedAt: NOW_1,
  });
  store.putRfi({
    objectId: 'rfi-1',
    title: 'Cladding penetration detail',
    question: 'Which detail governs the roof penetration at grid C4?',
    category: 'design-coordination',
    severity: 'high',
    projectId: PROJECT_ID,
    raisedBy: entity(301),
    raisedAt: NOW_1,
    updatedAt: NOW_1,
  });
  store.putChangeEvent({
    objectId: 'ce-1',
    title: 'Additional facade cleaning scope',
    changeType: 'addition',
    contractRef: CONTRACT_ID,
    costImpacts: [{ budgetId: null, costItemId: entity(302) }],
    updatedAt: NOW_1,
  });
  store.putObservation({
    objectId: 'obs-1',
    category: 'quality',
    summary: 'Missing vapor barrier at north wall',
    location: 'Level 3, grid B2',
    observedAt: NOW_1,
    observedBy: entity(303),
    updatedAt: NOW_1,
  });
  return store;
};

describe('construction multi-stream sync (OFF-021)', () => {
  it('syncs every declared stream to exhaustion, in declaration order', async () => {
    const store = seededStore();
    const { deps } = engine({ now: NOW_1 });
    const report = unwrap(
      await runConstructionSync(
        {
          authorization: constructionAuthorization(),
          adapter: createConstructionAdapter({ store }),
          translator: createConstructionTranslator(),
          systemId: CONSTRUCTION_SYSTEM_ID,
          limit: 2,
        },
        deps,
      ),
    );

    expect(report.kind).toBe('construction-sync-report');
    expect(report.streams.map((stream) => stream.objectKind)).toStrictEqual([
      'document',
      'rfi',
      'change-event',
      'observation',
    ]);
    for (const stream of report.streams) {
      expect(stream.kind).toBe('construction-stream-report');
      expect(stream.applications.map((application) => application.outcome)).toStrictEqual([
        'mapped-created',
      ]);
      // One-object streams exhaust inside a single page: no continuation
      // token, so no cursor is ever persisted for them.
      expect(stream.runs).toHaveLength(1);
      expect(stream.cursor).toBeNull();
    }
    expect(report.streams.map((stream) => stream.commands.map((c) => c.commandName))).toStrictEqual([
      ['documents.registerDocument'],
      ['field.raiseIssue'],
      ['contracts.raiseChangeEvent'],
      ['field.captureFieldEvent'],
    ]);
  });

  it('syncs a caller-selected subset of streams', async () => {
    const store = seededStore();
    const { deps } = engine({ now: NOW_1 });
    const report = unwrap(
      await runConstructionSync(
        {
          authorization: constructionAuthorization(),
          adapter: createConstructionAdapter({ store }),
          translator: createConstructionTranslator(),
          systemId: CONSTRUCTION_SYSTEM_ID,
          objectKinds: [OBSERVATION_OBJECT_KIND],
          limit: 2,
        },
        deps,
      ),
    );
    expect(report.streams).toHaveLength(1);
    expect(report.streams[0]?.objectKind).toBe('observation');
    expect(report.streams[0]?.commands[0]?.commandName).toBe('field.captureFieldEvent');
  });

  it('resumes from the persisted cursor: an incremental catch-up observes the appended objects', async () => {
    const store = createConstructionProviderStore();
    for (const objectId of ['doc-1', 'doc-2', 'doc-3']) {
      store.putDocument({
        objectId,
        title: `Document ${objectId}`,
        projectId: PROJECT_ID,
        discipline: 'structural',
        revision: { revisionId: `rev-${objectId}`, contentBase64: 'UEsDBBQABgAGAAA=' },
        updatedAt: NOW_1,
      });
    }
    const { deps, versions } = engine({ now: NOW_1 });
    const request = {
      authorization: constructionAuthorization(),
      adapter: createConstructionAdapter({ store }),
      translator: createConstructionTranslator(),
      systemId: CONSTRUCTION_SYSTEM_ID,
      objectKinds: [DOCUMENT_OBJECT_KIND],
    };
    const limit = 2;

    const initial = unwrap(await runConstructionSync({ ...request, limit }, deps));
    expect(initial.streams[0]?.applications).toHaveLength(3);
    expect(initial.streams[0]?.cursor?.token).toBe('2');
    // The create commands executed canonically.
    for (let n = 1; n <= 3; n += 1) {
      versions.set(entity(n), version(1));
    }

    // The provider appends one more document; the catch-up resumes from the
    // persisted cursor — the un-checkpointed tail (doc-3) is re-delivered
    // and idempotently no-ops, the appended object is created.
    store.putDocument({
      objectId: 'doc-4',
      title: 'Storm drainage layout',
      projectId: PROJECT_ID,
      discipline: 'civil',
      revision: { revisionId: 'rev-doc-4', contentBase64: 'QWRkZW5kdW0gZHJhaW5hZ2U=' },
      updatedAt: NOW_1,
    });
    const catchUp = unwrap(await runConstructionSync({ ...request, limit }, deps));
    expect(catchUp.streams[0]?.applications.map((application) => application.outcome)).toStrictEqual(
      ['replay-no-op', 'mapped-created'],
    );
    expect(catchUp.streams[0]?.commands.map((command) => command.commandName)).toStrictEqual([
      'documents.registerDocument',
    ]);
  });

  it('cursor restart re-processes nothing: an immediate re-run proposes zero commands', async () => {
    const store = seededStore();
    const { deps, versions } = engine({ now: NOW_1 });
    const request = {
      authorization: constructionAuthorization(),
      adapter: createConstructionAdapter({ store }),
      translator: createConstructionTranslator(),
      systemId: CONSTRUCTION_SYSTEM_ID,
    };
    const initial = unwrap(await runConstructionSync({ ...request, limit: 2 }, deps));
    const commandCount = initial.streams.reduce(
      (count, stream) => count + stream.commands.length,
      0,
    );
    expect(commandCount).toBe(4);
    for (let n = 1; n <= 4; n += 1) {
      versions.set(entity(n), version(1));
    }

    // A restart from the persisted cursors (the runtime's crash-recovery
    // point): nothing already processed comes back as a command — only
    // idempotent no-ops.
    const restart = unwrap(await runConstructionSync({ ...request, limit: 2 }, deps));
    expect(
      restart.streams.every((stream) =>
        stream.applications.every((application) => application.outcome === 'replay-no-op'),
      ),
    ).toBe(true);
    expect(
      restart.streams.reduce((count, stream) => count + stream.commands.length, 0),
    ).toBe(0);
  });

  it('fails closed on a provider that never exhausts (the per-stream page bound)', async () => {
    const store = seededStore();
    const base = createConstructionAdapter({ store });
    // A hostile Adapter implementation: every page reports more items (the
    // SDK treats adapter output as untrusted; this orchestrator additionally
    // bounds the loop). Deterministic — position only ever increments.
    let position = 0;
    const stuck: Adapter = {
      kind: base.kind,
      capabilities: base.capabilities,
      connect: (request) => base.connect(request),
      healthCheck: (request) => base.healthCheck(request),
      disconnect: (request) => base.disconnect(request),
      async sync() {
        position += 1;
        return ok({
          kind: 'sync-result',
          snapshots: [],
          nextCursorToken: syncCursorToken(String(position)),
          checkpoint: { itemsObserved: position, lastProviderVersion: providerVersion('v1') },
          hasMore: true,
        } satisfies SyncResult);
      },
    };
    const { deps } = engine({ now: NOW_1 });
    const exhausted = await runConstructionSync(
      {
        authorization: constructionAuthorization(),
        adapter: stuck,
        translator: createConstructionTranslator(),
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKinds: [DOCUMENT_OBJECT_KIND],
        limit: 2,
      },
      deps,
    );
    expect(exhausted.ok).toBe(false);
    if (exhausted.ok) return;
    expect(exhausted.error.code).toBe('invariant-violation');
    expect(exhausted.error.details[0]?.code).toBe('sync-page-limit');
  });

  it("propagates the SDK engine's typed limit validation", async () => {
    const store = seededStore();
    const { deps } = engine({ now: NOW_1 });
    const invalid = await runConstructionSync(
      {
        authorization: constructionAuthorization(),
        adapter: createConstructionAdapter({ store }),
        translator: createConstructionTranslator(),
        systemId: CONSTRUCTION_SYSTEM_ID,
        objectKinds: [DOCUMENT_OBJECT_KIND],
        limit: 0,
      },
      deps,
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.details[0]?.code).toBe('sync-limit-invalid');
  });

  it("propagates the translator's fail-closed rejection of a withdrawn change event", async () => {
    const store = createConstructionProviderStore();
    store.putChangeEvent({
      objectId: 'ce-1',
      title: 'Additional facade cleaning scope',
      changeType: 'addition',
      contractRef: CONTRACT_ID,
      costImpacts: [{ budgetId: null, costItemId: entity(401) }],
      updatedAt: NOW_1,
    });
    const { deps, versions } = engine({ now: NOW_1 });
    const request = {
      authorization: constructionAuthorization(),
      adapter: createConstructionAdapter({ store }),
      translator: createConstructionTranslator(),
      systemId: CONSTRUCTION_SYSTEM_ID,
      objectKinds: [CHANGE_EVENT_OBJECT_KIND],
    };
    const created = unwrap(await runConstructionSync({ ...request, limit: 10 }, deps));
    expect(created.streams[0]?.commands[0]?.commandName).toBe('contracts.raiseChangeEvent');
    versions.set(entity(1), version(1));

    // The provider withdraws the change event. The canonical contracts
    // domain models change events as append-only — no landed command
    // withdraws one — so the translator fails closed and the typed failure
    // aborts the stream (never an improvised semantic).
    store.deleteChangeEvent('ce-1', NOW_1);
    const withdrawn = await runConstructionSync({ ...request, limit: 10 }, deps);
    expect(withdrawn.ok).toBe(false);
    if (withdrawn.ok) return;
    expect(withdrawn.error.code).toBe('invariant-violation');
    expect(withdrawn.error.details[0]?.code).toBe('provider-transition-unmapped');
  });
});
