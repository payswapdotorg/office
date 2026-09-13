import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@office/contracts';
import {
  adapterKind,
  coordinateOf,
  providerObjectKind,
  providerObjectId,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
  syncIdempotencyKey,
  webhookDeduplicationKey,
} from '@office/adapters-sdk';
import type {
  AdapterJsonValue,
  RawWebhook,
  WebhookSignatureVerifier,
} from '@office/adapters-sdk';
import { CONSTRUCTION_ADAPTER_KIND, CONSTRUCTION_SYSTEM_ID, DOCUMENT_OBJECT_KIND } from './vocabulary';
import { createConstructionProviderStore } from './provider-fixture';
import { createConstructionAdapter } from './adapter';
import { createConstructionTranslator } from './mapping';
import { runConstructionSync } from './sync';
import {
  CDE_TRANSLATION_CHECKSUM_HEADER,
  CDE_WEBHOOK_SIGNATURE_HEADER,
  cdeTranslationChecksum,
  cdeWebhookSignature,
  createCdeTranslationVerifier,
  createCdeWebhookVerifier,
  ingestCdeWebhook,
  translateCdeWebhookBody,
} from './webhook-ingest';
import {
  NOW_1,
  NOW_2,
  PROJECT_ID,
  TENANT_A,
  constructionAuthorization,
  engine,
  entity,
  unwrap,
  version,
} from './test-support';

// OFF-021 — the CDE webhook ingest: what comes BACK from the construction
// provider. The CDE pushes events in its own wire format (strict keys,
// '<object-kind>.<created|updated|deleted>' event types, declared object
// kinds only), signed with the provider's signature header; ingestCdeWebhook
// layers the SDK's intake engine with an explicit divergence pre-check
// (both sides moved → a Conflict record with both sides, NEVER a silent
// last-write-wins). Everything is fail-closed and deterministic: the same
// push derives the same dedup key and the same SourceRef-derived command
// idempotency key the sync path derives for the same provider object
// version (cross-path convergence).

const sourceOf = (objectType: string, objectId: string, objectVersion: string) =>
  sourceRef({
    adapterKind: CONSTRUCTION_ADAPTER_KIND,
    systemId: CONSTRUCTION_SYSTEM_ID,
    objectType: providerObjectKind(objectType),
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

const wire = (parts: {
  readonly eventType: string;
  readonly objectId?: string;
  readonly revisionTag?: string;
  readonly occurredAt?: Timestamp | null;
  readonly payload?: Record<string, unknown>;
}): Record<string, unknown> => ({
  kind: 'cde-webhook-event',
  eventType: parts.eventType,
  objectId: parts.objectId ?? 'doc-9',
  revisionTag: parts.revisionTag ?? 'v1',
  occurredAt: parts.occurredAt === undefined ? NOW_2 : parts.occurredAt,
  payload: parts.payload ?? { any: 'payload' },
});

/** One document in the provider store, ready to be pushed. */
const putDocument = (
  store: ReturnType<typeof createConstructionProviderStore>,
  objectId: string,
  updatedAt: Timestamp,
): void => {
  store.putDocument({
    objectId,
    title: 'Structural drawing package',
    projectId: PROJECT_ID,
    discipline: 'structural',
    revision: { revisionId: 'rev-1', contentBase64: 'UEsDBBQABgAGAAA=' },
    updatedAt,
  });
};

/** Deterministic ingest world: fixture store + engine state + adapter wiring. */
const webhookWorld = (now: Timestamp) => {
  const store = createConstructionProviderStore();
  const { deps, versions } = engine({ now });
  const adapter = createConstructionAdapter({ store });
  const translator = createConstructionTranslator();
  const authorization = constructionAuthorization();
  const ingest = (raw: RawWebhook, verifier: WebhookSignatureVerifier = createCdeWebhookVerifier()) =>
    ingestCdeWebhook({ authorization, adapter, translator, verifier, deps, raw });
  return { store, deps, versions, adapter, translator, authorization, ingest };
};

describe('CDE webhook ingest (OFF-021)', () => {
  // ---- the wire → ProviderWebhookBody translation (fail-closed) ------------
  it('translates each declared object kind and event kind of the wire vocabulary', () => {
    for (const objectType of ['document', 'rfi', 'change-event', 'observation']) {
      for (const eventKind of ['created', 'updated', 'deleted']) {
        const translated = translateCdeWebhookBody(wire({ eventType: `${objectType}.${eventKind}` }));
        expect(translated.ok, `${objectType}.${eventKind}`).toBe(true);
        if (!translated.ok) continue;
        expect(translated.value.eventKind).toBe(eventKind);
        expect(translated.value.objectType).toBe(objectType);
      }
    }
  });

  it('translates one wire body into the exact provider-neutral body (including a null instant)', () => {
    const translated = translateCdeWebhookBody(
      wire({
        eventType: 'document.updated',
        objectId: 'doc-9',
        revisionTag: 'v4',
        occurredAt: NOW_2,
        payload: { some: 'data' },
      }),
    );
    expect(translated.ok).toBe(true);
    if (!translated.ok) return;
    expect(translated.value).toStrictEqual({
      kind: 'provider-webhook-body',
      eventKind: 'updated',
      objectType: 'document',
      objectId: 'doc-9',
      version: 'v4',
      occurredAt: NOW_2,
      data: { some: 'data' },
    });
    const noInstant = translateCdeWebhookBody(wire({ eventType: 'rfi.created', occurredAt: null }));
    expect(noInstant.ok).toBe(true);
    if (!noInstant.ok) return;
    expect(noInstant.value.occurredAt).toBeNull();
  });

  it('fails closed on malformed wire bodies (typed, with field paths)', () => {
    const base = wire({ eventType: 'document.created' });
    const cases: readonly [string, Record<string, unknown>, string | null][] = [
      ['an array body', ['nope'] as unknown as Record<string, unknown>, null],
      ['an unknown top-level key', { ...base, trace: 'x' }, 'trace'],
      ['a wrong kind literal', { ...base, kind: 'cde-other-event' }, 'kind'],
      ['an undeclared object kind', { ...base, eventType: 'inspection.created' }, 'eventType'],
      ['an unknown event kind', { ...base, eventType: 'document.patched' }, 'eventType'],
      ['a malformed eventType', { ...base, eventType: 'documentcreated' }, 'eventType'],
      ['a missing objectId', { ...base, objectId: undefined }, 'objectId'],
      ['a missing revisionTag', { ...base, revisionTag: undefined }, 'revisionTag'],
      ['a malformed occurredAt', { ...base, occurredAt: 'yesterday' }, 'occurredAt'],
      ['a non-object payload', { ...base, payload: 'not-an-object' }, 'payload'],
    ];
    for (const [label, body, path] of cases) {
      const translated = translateCdeWebhookBody(body);
      expect(translated.ok, label).toBe(false);
      if (translated.ok) continue;
      expect(translated.error.code, label).toBe('invariant-violation');
      expect(translated.error.details[0]?.code, label).toMatch(/^cde-webhook-/);
      if (path !== null) {
        expect(translated.error.details[0]?.path, label).toBe(path);
      }
    }
  });

  // ---- the deterministic signature/checksum conventions ---------------------
  it('derives deterministic wire signatures and translation checksums', () => {
    const body = wire({ eventType: 'document.created' });
    expect(cdeWebhookSignature(body)).toBe(cdeWebhookSignature(body));
    expect(cdeWebhookSignature(body)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(cdeWebhookSignature(wire({ eventType: 'document.updated' }))).not.toBe(
      cdeWebhookSignature(body),
    );
    expect(cdeTranslationChecksum(body)).toBe(cdeTranslationChecksum(body));
    expect(cdeTranslationChecksum(body)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('verifies provider signatures over the wire body (fail-closed on tampering)', () => {
    const verifier = createCdeWebhookVerifier();
    const body = wire({ eventType: 'document.created' });
    const input = {
      adapterKind: CONSTRUCTION_ADAPTER_KIND,
      systemId: CONSTRUCTION_SYSTEM_ID,
      headers: { [CDE_WEBHOOK_SIGNATURE_HEADER]: cdeWebhookSignature(body) },
      body: body as unknown as AdapterJsonValue,
    };
    expect(verifier.verify(input).ok).toBe(true);

    const tampered = verifier.verify({
      ...input,
      headers: { [CDE_WEBHOOK_SIGNATURE_HEADER]: `sha256=${'0'.repeat(64)}` },
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok) return;
    expect(tampered.error.code).toBe('unauthorized');
    expect(tampered.error.details[0]?.code).toBe('webhook-signature-invalid');

    const missing = verifier.verify({ ...input, headers: {} });
    expect(missing.ok).toBe(false);
  });

  it('binds the SDK intake to exactly the translated body (integrity verifier)', () => {
    const verifier = createCdeTranslationVerifier();
    const body = unwrap(translateCdeWebhookBody(wire({ eventType: 'rfi.created' })));
    const accepted = verifier.verify({
      adapterKind: CONSTRUCTION_ADAPTER_KIND,
      systemId: CONSTRUCTION_SYSTEM_ID,
      headers: { [CDE_TRANSLATION_CHECKSUM_HEADER]: cdeTranslationChecksum(body) },
      body: body as unknown as AdapterJsonValue,
    });
    expect(accepted.ok).toBe(true);

    const altered = verifier.verify({
      adapterKind: CONSTRUCTION_ADAPTER_KIND,
      systemId: CONSTRUCTION_SYSTEM_ID,
      headers: { [CDE_TRANSLATION_CHECKSUM_HEADER]: cdeTranslationChecksum(body) },
      body: { ...body, objectId: 'rfi-99' } as unknown as AdapterJsonValue,
    });
    expect(altered.ok).toBe(false);
    if (altered.ok) return;
    expect(altered.error.details[0]?.code).toBe('translation-integrity-invalid');
  });

  // ---- the end-to-end intake ------------------------------------------------
  it('applies a created push: mapping recorded + the typed create proposal', async () => {
    const world = webhookWorld(NOW_2);
    putDocument(world.store, 'doc-9', NOW_1);
    const outcome = unwrap(await world.ingest(world.store.emitWebhook('created', 'doc-9')));

    expect(outcome.kind).toBe('cde-webhook-outcome');
    expect(outcome.outcome).toBe('source-created');
    expect(outcome.command?.commandName).toBe('documents.registerDocument');
    expect(outcome.command?.payload).toStrictEqual({
      projectId: PROJECT_ID,
      title: 'Structural drawing package',
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(sourceOf('document', 'doc-9', 'v1')),
        providerData: {
          title: 'Structural drawing package',
          projectId: PROJECT_ID,
          discipline: 'structural',
          revision: { revisionId: 'rev-1', contentBase64: 'UEsDBBQABgAGAAA=' },
        },
      },
    });
    // The command key is the SourceRef-derived key (shared with the sync
    // path — one command per provider object version).
    expect(outcome.command?.idempotencyKey).toBe(syncIdempotencyKey(sourceOf('document', 'doc-9', 'v1')));
    // The envelope carries the deterministic replay deduplication key.
    expect(outcome.envelope?.deduplicationKey).toBe(
      webhookDeduplicationKey({
        adapterKind: CONSTRUCTION_ADAPTER_KIND,
        systemId: CONSTRUCTION_SYSTEM_ID,
        eventKind: 'created',
        objectType: DOCUMENT_OBJECT_KIND,
        objectId: providerObjectId('doc-9'),
        version: providerVersion('v1'),
        occurredAt: NOW_1,
      }),
    );
    expect(outcome.mapping).toMatchObject({
      canonical: { entityKind: 'document', entityId: entity(1) },
      providerVersion: 'v1',
    });
    expect(outcome.conflict).toBeNull();
  });

  it('replays a redelivered push verbatim (idempotent no-op)', async () => {
    const world = webhookWorld(NOW_2);
    putDocument(world.store, 'doc-9', NOW_1);
    const raw = world.store.emitWebhook('created', 'doc-9');
    const first = unwrap(await world.ingest(raw));
    expect(first.outcome).toBe('source-created');

    // The exact same push (same body, same signature, same version)
    // redelivered: no duplicate mapping, no duplicate command.
    const second = unwrap(await world.ingest(raw));
    expect(second.outcome).toBe('replay-no-op');
    expect(second.command).toBeNull();
    expect(second.mapping).toStrictEqual(first.mapping);
  });

  it('typed-rejects an updated push with no established mapping', async () => {
    const world = webhookWorld(NOW_2);
    putDocument(world.store, 'doc-9', NOW_1);
    const missing = await world.ingest(world.store.emitWebhook('updated', 'doc-9'));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('not-found');
    expect(missing.error.details[0]?.code).toBe('source-mapping-not-found');
  });

  it('applies an updated push for a mapped source (update proposal + advanced mapping)', async () => {
    const world = webhookWorld(NOW_2);
    putDocument(world.store, 'doc-9', NOW_1);
    unwrap(await world.ingest(world.store.emitWebhook('created', 'doc-9')));
    // The create command executed canonically (the aggregate is at v1).
    world.versions.set(entity(1), version(1));
    world.store.updateDocument('doc-9', {
      revision: { revisionId: 'rev-2', contentBase64: 'TUVQIHJldjI=' },
      updatedAt: NOW_2,
    });

    const updated = unwrap(await world.ingest(world.store.emitWebhook('updated', 'doc-9')));
    expect(updated.outcome).toBe('source-updated');
    expect(updated.command?.commandName).toBe('documents.attachRevision');
    expect(updated.command?.payload).toMatchObject({
      documentId: entity(1),
      expectedVersion: 1,
      contentBase64: 'TUVQIHJldjI=',
    });
    expect(updated.command?.idempotencyKey).toBe(syncIdempotencyKey(sourceOf('document', 'doc-9', 'v2')));
    expect(updated.mapping?.providerVersion).toBe('v2');
  });

  it('applies a deleted push for a mapped source and no-ops an unknown one', async () => {
    const world = webhookWorld(NOW_2);
    putDocument(world.store, 'doc-9', NOW_1);
    unwrap(await world.ingest(world.store.emitWebhook('created', 'doc-9')));
    world.store.deleteDocument('doc-9', NOW_2);

    const deleted = unwrap(await world.ingest(world.store.emitWebhook('deleted', 'doc-9')));
    expect(deleted.outcome).toBe('source-deleted');
    expect(deleted.command?.commandName).toBe('documents.archiveDocument');
    expect(deleted.command?.payload).toStrictEqual({
      projectId: PROJECT_ID,
      documentId: entity(1),
      expectedVersion: 1,
    });

    putDocument(world.store, 'doc-10', NOW_2);
    const unknown = unwrap(await world.ingest(world.store.emitWebhook('deleted', 'doc-10')));
    expect(unknown.outcome).toBe('deletion-no-op');
    expect(unknown.command).toBeNull();
    expect(unknown.mapping).toBeNull();
  });

  it('typed-rejects pushes routed to another adapter family', async () => {
    const world = webhookWorld(NOW_2);
    const mismatched = await world.ingest({
      kind: 'raw-webhook',
      adapterKind: adapterKind('fake-crm'),
      systemId: CONSTRUCTION_SYSTEM_ID,
      headers: {},
      body: {},
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.error.code).toBe('invariant-violation');
    expect(mismatched.error.details[0]?.code).toBe('adapter-kind-mismatch');
  });

  it('typed-rejects a tampered push at the authenticity boundary', async () => {
    const world = webhookWorld(NOW_2);
    putDocument(world.store, 'doc-9', NOW_1);
    const raw = world.store.emitWebhook('created', 'doc-9');
    // The body is mutated after the provider signed it (same header).
    const tampered: RawWebhook = {
      ...raw,
      body: { ...(raw.body as Record<string, unknown>), objectId: 'doc-8' },
    };
    const rejected = await world.ingest(tampered);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('unauthorized');
    expect(rejected.error.details[0]?.code).toBe('webhook-signature-invalid');
  });

  it('detects divergence as an explicit conflict (both sides, no command, no advancement)', async () => {
    const world = webhookWorld(NOW_2);
    putDocument(world.store, 'doc-9', NOW_1);
    unwrap(await world.ingest(world.store.emitWebhook('created', 'doc-9')));
    // An office-side edit lands on the same aggregate (canonical at v2)…
    world.versions.set(entity(1), version(2));
    // …and the provider pushes an update in the same window.
    world.store.updateDocument('doc-9', {
      revision: { revisionId: 'rev-2', contentBase64: 'TUVQIHJldjI=' },
      updatedAt: NOW_2,
    });

    const divergent = unwrap(await world.ingest(world.store.emitWebhook('updated', 'doc-9')));
    expect(divergent.outcome).toBe('conflict-detected');
    expect(divergent.command).toBeNull();
    expect(divergent.envelope).toBeNull();
    expect(divergent.mapping?.providerVersion).toBe('v1');
    expect(divergent.conflict).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'construction-cde',
        systemId: 'cde-instance-01',
        objectType: 'document',
        objectId: 'doc-9',
        version: 'v2',
      },
      canonical: { entityKind: 'document', entityId: entity(1) },
      canonicalVersion: 2,
      state: 'detected',
      resolution: null,
    });
    const recorded = divergent.conflict;
    expect(recorded).not.toBeNull();
    if (recorded === null) return;
    expect(
      await world.deps.conflicts.listBySource(TENANT_A, coordinateOf(sourceOf('document', 'doc-9', 'v1'))),
    ).toStrictEqual([recorded]);
  });

  it('converges across paths: one command idempotency key per provider object version', async () => {
    const world = webhookWorld(NOW_1);
    putDocument(world.store, 'doc-7', NOW_1);

    // 1. The sync path creates the source (its command keyed by the v1
    //    SourceRef — the SAME key the webhook path would derive).
    const report = unwrap(
      await runConstructionSync(
        {
          authorization: world.authorization,
          adapter: world.adapter,
          translator: world.translator,
          systemId: CONSTRUCTION_SYSTEM_ID,
          objectKinds: [DOCUMENT_OBJECT_KIND],
          limit: 10,
        },
        world.deps,
      ),
    );
    const synced = report.streams[0]?.commands[0] ?? null;
    expect(synced?.commandName).toBe('documents.registerDocument');
    expect(synced?.idempotencyKey).toBe(syncIdempotencyKey(sourceOf('document', 'doc-7', 'v1')));
    // 2. The create command executed canonically.
    world.versions.set(entity(1), version(1));

    // 3. An updated push at v2 proposes the update command, keyed by the
    //    v2 SourceRef — a different key for a different version.
    world.store.updateDocument('doc-7', {
      revision: { revisionId: 'rev-2', contentBase64: 'TUVQIHJldjI=' },
      updatedAt: NOW_2,
    });
    const pushed = unwrap(await world.ingest(world.store.emitWebhook('updated', 'doc-7')));
    expect(pushed.command?.commandName).toBe('documents.attachRevision');
    expect(pushed.command?.idempotencyKey).toBe(syncIdempotencyKey(sourceOf('document', 'doc-7', 'v2')));
    expect(pushed.command?.idempotencyKey).not.toBe(synced?.idempotencyKey);

    // 4. A later full re-scan of the same version proposes NOTHING — the
    //    webhook already advanced the mapping bookkeeping, so the sync
    //    replays idempotently (no third command, ever).
    const rescan = unwrap(
      await runConstructionSync(
        {
          authorization: world.authorization,
          adapter: world.adapter,
          translator: world.translator,
          systemId: CONSTRUCTION_SYSTEM_ID,
          objectKinds: [DOCUMENT_OBJECT_KIND],
          limit: 10,
        },
        world.deps,
      ),
    );
    expect(rescan.streams[0]?.commands).toStrictEqual([]);
    expect(
      rescan.streams[0]?.applications.every((application) => application.outcome === 'replay-no-op'),
    ).toBe(true);
  });
});
