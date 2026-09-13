import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@office/contracts';
import {
  adapterKind,
  coordinateOf,
  providerObjectId,
  providerObjectKind,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
  syncIdempotencyKey,
  webhookDeduplicationKey,
} from '@office/adapters-sdk';
import type { AdapterJsonValue, RawWebhook, WebhookSignatureVerifier } from '@office/adapters-sdk';
import { FINANCE_ADAPTER_KIND, FINANCE_SYSTEM_ID, INVOICE_OBJECT_KIND } from './vocabulary';
import { createErpProviderStore } from './provider-fixture';
import { createFinanceAdapter } from './adapter';
import { createFinanceTranslator } from './mappings';
import { runFinanceSync } from './sync';
import {
  ERP_TRANSLATION_CHECKSUM_HEADER,
  ERP_WEBHOOK_SIGNATURE_HEADER,
  createErpTranslationVerifier,
  createErpWebhookVerifier,
  erpTranslationChecksum,
  erpWebhookSignature,
  ingestErpWebhook,
  translateErpWebhookBody,
} from './webhook-ingest';
import {
  BUDGET_REF_ID,
  COMMITMENT_REF_ID,
  COST_ITEM_REF_ID,
  NOW_1,
  NOW_2,
  PROJECT_ID,
  TENANT_A,
  entity,
  engine,
  financeAuthorization,
  unwrap,
  version,
} from './test-support';

// OFF-024 — the ERP webhook ingest: what comes BACK from the ERP. The
// provider pushes events in its own wire format (strict keys,
// '<object-kind>.<created|updated|deleted>' event types, declared object
// kinds only), signed with the provider's signature header; ingestErpWebhook
// layers the SDK's intake engine with THE source-version dedup (a version the
// ledger already proposed from — sync path OR earlier webhook — is a counted
// typed no-op: duplicate webhook deliveries never propose twice) and an
// explicit divergence pre-check (both sides moved → a Conflict record with
// both sides, NEVER a silent last-write-wins). Everything is fail-closed and
// deterministic: the same push derives the same dedup key and the same
// SourceRef-derived command idempotency key the sync path derives for the
// same provider object version (cross-path convergence).

const sourceOf = (objectType: string, objectId: string, objectVersion: string) =>
  sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
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
  kind: 'erp-webhook-event',
  eventType: parts.eventType,
  objectId: parts.objectId ?? 'inv-9',
  revisionTag: parts.revisionTag ?? 'v1',
  occurredAt: parts.occurredAt === undefined ? NOW_2 : parts.occurredAt,
  payload: parts.payload ?? { any: 'payload' },
});

/** One invoice in the provider store, ready to be pushed. */
const putInvoice = (
  store: ReturnType<typeof createErpProviderStore>,
  objectId: string,
  updatedAt: Timestamp,
): void => {
  store.putInvoice({
    objectId,
    number: `INV-2026-${objectId.toUpperCase()}`,
    description: 'Earthworks invoice',
    currency: 'EUR',
    commitmentRef: COMMITMENT_REF_ID,
    issuedOn: NOW_1,
    dueOn: NOW_2,
    lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
    updatedAt,
  });
};

/** Deterministic ingest world: fixture store + engine state + adapter wiring. */
const webhookWorld = (now: Timestamp) => {
  const store = createErpProviderStore();
  const world = engine({ now });
  const adapter = createFinanceAdapter({ store });
  const translator = createFinanceTranslator();
  const authorization = financeAuthorization();
  const ingest = (raw: RawWebhook, verifier: WebhookSignatureVerifier = createErpWebhookVerifier()) =>
    ingestErpWebhook({ authorization, adapter, translator, verifier, deps: world.deps, raw });
  return { store, ...world, adapter, translator, authorization, ingest };
};

describe('ERP webhook ingest (OFF-024)', () => {
  // ---- the wire → ProviderWebhookBody translation (fail-closed) ------------
  it('translates each declared object kind and event kind of the wire vocabulary', () => {
    for (const objectType of ['account', 'cost-code', 'commitment', 'invoice', 'payment']) {
      for (const eventKind of ['created', 'updated', 'deleted']) {
        const translated = translateErpWebhookBody(wire({ eventType: `${objectType}.${eventKind}` }));
        expect(translated.ok, `${objectType}.${eventKind}`).toBe(true);
        if (!translated.ok) continue;
        expect(translated.value.eventKind).toBe(eventKind);
        expect(translated.value.objectType).toBe(objectType);
      }
    }
  });

  it('translates one wire body into the exact provider-neutral body (including a null instant)', () => {
    const translated = translateErpWebhookBody(
      wire({
        eventType: 'invoice.updated',
        objectId: 'inv-9',
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
      objectType: 'invoice',
      objectId: 'inv-9',
      version: 'v4',
      occurredAt: NOW_2,
      data: { some: 'data' },
    });
    const noInstant = translateErpWebhookBody(wire({ eventType: 'account.created', occurredAt: null }));
    expect(noInstant.ok).toBe(true);
    if (!noInstant.ok) return;
    expect(noInstant.value.occurredAt).toBeNull();
  });

  it('fails closed on malformed wire bodies (typed, with field paths)', () => {
    const base = wire({ eventType: 'invoice.created' });
    const cases: readonly [string, Record<string, unknown>, string | null][] = [
      ['an array body', ['nope'] as unknown as Record<string, unknown>, null],
      ['an unknown top-level key', { ...base, trace: 'x' }, 'trace'],
      ['a wrong kind literal', { ...base, kind: 'erp-other-event' }, 'kind'],
      ['an undeclared object kind', { ...base, eventType: 'timesheet.created' }, 'eventType'],
      ['an unknown event kind', { ...base, eventType: 'invoice.patched' }, 'eventType'],
      ['a malformed eventType', { ...base, eventType: 'invoicecreated' }, 'eventType'],
      ['a missing objectId', { ...base, objectId: undefined }, 'objectId'],
      ['a missing revisionTag', { ...base, revisionTag: undefined }, 'revisionTag'],
      ['a malformed occurredAt', { ...base, occurredAt: 'yesterday' }, 'occurredAt'],
      ['a non-object payload', { ...base, payload: 'not-an-object' }, 'payload'],
    ];
    for (const [label, body, path] of cases) {
      const translated = translateErpWebhookBody(body);
      expect(translated.ok, label).toBe(false);
      if (translated.ok) continue;
      expect(translated.error.code, label).toBe('invariant-violation');
      expect(translated.error.details[0]?.code, label).toMatch(/^erp-webhook-/);
      if (path !== null) {
        expect(translated.error.details[0]?.path, label).toBe(path);
      }
    }
  });

  // ---- the deterministic signature/checksum conventions ---------------------
  it('derives deterministic wire signatures and translation checksums', () => {
    const body = wire({ eventType: 'invoice.created' });
    expect(erpWebhookSignature(body)).toBe(erpWebhookSignature(body));
    expect(erpWebhookSignature(body)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(erpWebhookSignature(wire({ eventType: 'invoice.updated' }))).not.toBe(
      erpWebhookSignature(body),
    );
    expect(erpTranslationChecksum(body)).toBe(erpTranslationChecksum(body));
    expect(erpTranslationChecksum(body)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('verifies provider signatures over the wire body (fail-closed on tampering)', () => {
    const verifier = createErpWebhookVerifier();
    const body = wire({ eventType: 'invoice.created' });
    const input = {
      adapterKind: FINANCE_ADAPTER_KIND,
      systemId: FINANCE_SYSTEM_ID,
      headers: { [ERP_WEBHOOK_SIGNATURE_HEADER]: erpWebhookSignature(body) },
      body: body as unknown as AdapterJsonValue,
    };
    expect(verifier.verify(input).ok).toBe(true);

    const tampered = verifier.verify({
      ...input,
      headers: { [ERP_WEBHOOK_SIGNATURE_HEADER]: `sha256=${'0'.repeat(64)}` },
    });
    expect(tampered.ok).toBe(false);
    if (tampered.ok) return;
    expect(tampered.error.code).toBe('unauthorized');
    expect(tampered.error.details[0]?.code).toBe('webhook-signature-invalid');

    const missing = verifier.verify({ ...input, headers: {} });
    expect(missing.ok).toBe(false);
  });

  it('binds the SDK intake to exactly the translated body (integrity verifier)', () => {
    const verifier = createErpTranslationVerifier();
    const body = unwrap(translateErpWebhookBody(wire({ eventType: 'account.created' })));
    const accepted = verifier.verify({
      adapterKind: FINANCE_ADAPTER_KIND,
      systemId: FINANCE_SYSTEM_ID,
      headers: { [ERP_TRANSLATION_CHECKSUM_HEADER]: erpTranslationChecksum(body) },
      body: body as unknown as AdapterJsonValue,
    });
    expect(accepted.ok).toBe(true);

    const altered = verifier.verify({
      adapterKind: FINANCE_ADAPTER_KIND,
      systemId: FINANCE_SYSTEM_ID,
      headers: { [ERP_TRANSLATION_CHECKSUM_HEADER]: erpTranslationChecksum(body) },
      body: { ...body, objectId: 'acc-99' } as unknown as AdapterJsonValue,
    });
    expect(altered.ok).toBe(false);
    if (altered.ok) return;
    expect(altered.error.details[0]?.code).toBe('translation-integrity-invalid');
  });

  // ---- the end-to-end intake + THE duplicate-delivery discipline ------------
  it('applies a created push: mapping recorded + the typed create proposal', async () => {
    const world = webhookWorld(NOW_2);
    putInvoice(world.store, 'inv-9', NOW_1);
    const outcome = unwrap(await world.ingest(world.store.emitWebhook('created', 'inv-9')));

    expect(outcome.kind).toBe('erp-webhook-outcome');
    expect(outcome.outcome).toBe('source-created');
    expect(outcome.command?.commandName).toBe('cost.recordInvoice');
    expect(outcome.command?.payload).toStrictEqual({
      commitmentId: COMMITMENT_REF_ID,
      number: 'INV-2026-INV-9',
      description: 'Earthworks invoice',
      currency: 'EUR',
      issuedOn: NOW_1,
      dueOn: NOW_2,
      lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(sourceOf('invoice', 'inv-9', 'v1')),
        providerData: {
          number: 'INV-2026-INV-9',
          description: 'Earthworks invoice',
          currency: 'EUR',
          commitmentRef: COMMITMENT_REF_ID,
          issuedOn: NOW_1,
          dueOn: NOW_2,
          lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
        },
      },
    });
    // The command key is the SourceRef-derived key (shared with the sync
    // path — one command per provider object version).
    expect(outcome.command?.idempotencyKey).toBe(
      syncIdempotencyKey(sourceOf('invoice', 'inv-9', 'v1')),
    );
    // The envelope carries the deterministic replay deduplication key.
    expect(outcome.envelope?.deduplicationKey).toBe(
      webhookDeduplicationKey({
        adapterKind: FINANCE_ADAPTER_KIND,
        systemId: FINANCE_SYSTEM_ID,
        eventKind: 'created',
        objectType: INVOICE_OBJECT_KIND,
        objectId: providerObjectId('inv-9'),
        version: providerVersion('v1'),
        occurredAt: NOW_1,
      }),
    );
    expect(outcome.mapping).toMatchObject({
      canonical: { entityKind: 'invoice', entityId: entity(1) },
      providerVersion: 'v1',
    });
    expect(outcome.conflict).toBeNull();
    expect(outcome.duplicateEntry).toBeNull();
  });

  it('THE duplicate webhook delivery is a counted typed no-op (never a second proposal)', async () => {
    const world = webhookWorld(NOW_2);
    putInvoice(world.store, 'inv-9', NOW_1);
    const raw = world.store.emitWebhook('created', 'inv-9');
    const first = unwrap(await world.ingest(raw));
    expect(first.outcome).toBe('source-created');
    expect(first.command).not.toBeNull();
    const proposalKey = first.command?.idempotencyKey;

    // The exact same push (same body, same signature, same version)
    // redelivered AT LEAST ONCE: no second proposal, ever — the ledger turns
    // it into a counted typed no-op.
    const second = unwrap(await world.ingest(raw));
    expect(second.outcome).toBe('duplicate-version-deduplicated');
    expect(second.command).toBeNull();
    expect(second.envelope).toBeNull();
    expect(second.conflict).toBeNull();
    expect(second.duplicateEntry?.kind).toBe('version-ledger-entry');
    expect(second.duplicateEntry?.observationCount).toBe(2);
    expect(second.duplicateEntry?.proposalKey).toBe(proposalKey);

    // And AGAIN: every duplicate attempt is counted.
    const third = unwrap(await world.ingest(raw));
    expect(third.outcome).toBe('duplicate-version-deduplicated');
    expect(third.command).toBeNull();
    expect(third.duplicateEntry?.observationCount).toBe(3);

    // Exactly ONE canonical proposal exists across all three deliveries.
    const entries = await world.ledger.listByCoordinate(
      TENANT_A,
      coordinateOf(sourceOf('invoice', 'inv-9', 'v1')),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.observationCount).toBe(3);
    expect(entries[0]?.proposalKey).toBe(proposalKey);
  });

  it('typed-rejects an updated push with no established mapping', async () => {
    const world = webhookWorld(NOW_2);
    putInvoice(world.store, 'inv-9', NOW_1);
    const missing = await world.ingest(world.store.emitWebhook('updated', 'inv-9'));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('not-found');
    expect(missing.error.details[0]?.code).toBe('source-mapping-not-found');
  });

  it('applies an updated push for a mapped account, then deduplicates its redelivery', async () => {
    const world = webhookWorld(NOW_2);
    world.store.putAccount({
      objectId: 'acc-9',
      code: '5010',
      name: 'Earthworks costs',
      currency: 'EUR',
      projectRef: PROJECT_ID,
      updatedAt: NOW_1,
    });
    unwrap(await world.ingest(world.store.emitWebhook('created', 'acc-9')));
    // The create command executed canonically (the aggregate is at v1).
    world.versions.set(entity(1), version(1));
    world.store.renameAccount('acc-9', { name: 'Earthworks costs (renamed)', updatedAt: NOW_2 });

    const updated = unwrap(await world.ingest(world.store.emitWebhook('updated', 'acc-9')));
    expect(updated.outcome).toBe('source-updated');
    expect(updated.command?.commandName).toBe('cost.reviseBudget');
    expect(updated.command?.payload).toMatchObject({
      budgetId: entity(1),
      expectedVersion: 1,
    });
    expect(updated.command?.idempotencyKey).toBe(
      syncIdempotencyKey(sourceOf('account', 'acc-9', 'v2')),
    );
    expect(updated.mapping?.providerVersion).toBe('v2');

    // The same updated push redelivered: a counted typed no-op.
    const redelivered = unwrap(await world.ingest(world.store.emitWebhook('updated', 'acc-9')));
    expect(redelivered.outcome).toBe('duplicate-version-deduplicated');
    expect(redelivered.command).toBeNull();
    expect(redelivered.duplicateEntry?.observationCount).toBe(2);
  });

  it('applies a deleted push for a mapped commitment and no-ops an unknown one', async () => {
    const world = webhookWorld(NOW_2);
    world.store.putCommitment({
      objectId: 'po-9',
      number: 'PO-2026-014',
      commitmentKind: 'purchase-order',
      description: 'Phase one earthworks package',
      currency: 'EUR',
      budgetRef: BUDGET_REF_ID,
      lines: [
        { costItemRef: COST_ITEM_REF_ID, description: 'Bulk excavation', amountMinor: 3_600_000 },
      ],
      updatedAt: NOW_1,
    });
    unwrap(await world.ingest(world.store.emitWebhook('created', 'po-9')));
    world.versions.set(entity(1), version(1));
    world.store.voidCommitment('po-9', NOW_2);

    const deleted = unwrap(await world.ingest(world.store.emitWebhook('deleted', 'po-9')));
    expect(deleted.outcome).toBe('source-deleted');
    expect(deleted.command?.commandName).toBe('cost.closeCommitment');
    expect(deleted.command?.payload).toStrictEqual({
      commitmentId: entity(1),
      expectedVersion: 1,
      reason: 'ERP commitment PO-2026-014 voided in the ERP at revision v2',
    });

    world.store.putPayment({
      objectId: 'pay-9',
      invoiceRef: entity(51),
      reference: 'TRC-8841',
      amountMinor: 250_000,
      paidAt: NOW_2,
      updatedAt: NOW_2,
    });
    const unknown = unwrap(await world.ingest(world.store.emitWebhook('deleted', 'pay-9')));
    expect(unknown.outcome).toBe('deletion-no-op');
    expect(unknown.command).toBeNull();
    expect(unknown.mapping).toBeNull();
  });

  it('FAILS CLOSED on an invoice deletion push (no landed canonical command deletes an invoice)', async () => {
    const world = webhookWorld(NOW_2);
    putInvoice(world.store, 'inv-9', NOW_1);
    unwrap(await world.ingest(world.store.emitWebhook('created', 'inv-9')));
    world.versions.set(entity(1), version(1));
    world.store.deleteInvoice('inv-9', NOW_2);

    const rejected = await world.ingest(world.store.emitWebhook('deleted', 'inv-9'));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('invariant-violation');
    expect(rejected.error.details[0]?.code).toBe('provider-transition-unmapped');
  });

  it('typed-rejects pushes routed to another adapter family', async () => {
    const world = webhookWorld(NOW_2);
    const mismatched = await world.ingest({
      kind: 'raw-webhook',
      adapterKind: adapterKind('fake-crm'),
      systemId: FINANCE_SYSTEM_ID,
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
    putInvoice(world.store, 'inv-9', NOW_1);
    const raw = world.store.emitWebhook('created', 'inv-9');
    // The body is mutated after the provider signed it (same header).
    const tampered: RawWebhook = {
      ...raw,
      body: { ...(raw.body as Record<string, unknown>), objectId: 'inv-8' },
    };
    const rejected = await world.ingest(tampered);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('unauthorized');
    expect(rejected.error.details[0]?.code).toBe('webhook-signature-invalid');
  });

  it('detects divergence as an explicit conflict (both sides, no command, no advancement)', async () => {
    const world = webhookWorld(NOW_2);
    putInvoice(world.store, 'inv-9', NOW_1);
    unwrap(await world.ingest(world.store.emitWebhook('created', 'inv-9')));
    // An office-side edit lands on the same aggregate (canonical at v2)…
    world.versions.set(entity(1), version(2));
    // …and the ERP pushes a revision in the same window.
    world.store.reviseInvoice('inv-9', {
      lines: [{ description: 'Phase one earthworks (revised)', amountMinor: 312_500 }],
      updatedAt: NOW_2,
    });

    const divergent = unwrap(await world.ingest(world.store.emitWebhook('updated', 'inv-9')));
    expect(divergent.outcome).toBe('conflict-detected');
    expect(divergent.command).toBeNull();
    expect(divergent.envelope).toBeNull();
    expect(divergent.mapping?.providerVersion).toBe('v1');
    expect(divergent.conflict).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'erp-finance',
        systemId: 'erp-instance-01',
        objectType: 'invoice',
        objectId: 'inv-9',
        version: 'v2',
      },
      canonical: { entityKind: 'invoice', entityId: entity(1) },
      canonicalVersion: 2,
      state: 'detected',
      resolution: null,
    });
    const recorded = divergent.conflict;
    expect(recorded).not.toBeNull();
    if (recorded === null) return;
    expect(
      await world.deps.conflicts.listBySource(
        TENANT_A,
        coordinateOf(sourceOf('invoice', 'inv-9', 'v1')),
      ),
    ).toStrictEqual([recorded]);
  });

  // ---- THE cross-path convergence (sync ↔ webhook) --------------------------
  it('converges: after the SYNC path proposed a version, its webhook delivery is a counted typed no-op', async () => {
    const world = webhookWorld(NOW_1);
    putInvoice(world.store, 'inv-7', NOW_1);

    // 1. The sync path creates the source (its command keyed by the v1
    //    SourceRef — the SAME key the webhook path would derive).
    const report = unwrap(
      await runFinanceSync(
        {
          authorization: world.authorization,
          adapter: world.adapter,
          translator: world.translator,
          systemId: FINANCE_SYSTEM_ID,
          objectKinds: [INVOICE_OBJECT_KIND],
          limit: 10,
        },
        world.deps,
      ),
    );
    expect(report.commands).toHaveLength(1);
    const syncedKey = report.commands[0]?.idempotencyKey;
    world.versions.set(entity(1), version(1));

    // 2. The SAME provider object version pushed through the webhook path:
    //    the ledger already carries the proposal → counted typed no-op, no
    //    second command, ever.
    const pushed = unwrap(await world.ingest(world.store.emitWebhook('created', 'inv-7')));
    expect(pushed.outcome).toBe('duplicate-version-deduplicated');
    expect(pushed.command).toBeNull();
    expect(pushed.duplicateEntry?.proposalKey).toBe(syncedKey);
  });

  it('converges: after the WEBHOOK path proposed a version, the sync re-scan deduplicates it (counted)', async () => {
    const world = webhookWorld(NOW_1);
    putInvoice(world.store, 'inv-8', NOW_1);

    // 1. The webhook path creates the source first.
    const pushed = unwrap(await world.ingest(world.store.emitWebhook('created', 'inv-8')));
    expect(pushed.outcome).toBe('source-created');
    const pushedKey = pushed.command?.idempotencyKey;
    world.versions.set(entity(1), version(1));

    // 2. A later full sync re-scan of the same version: the version-mapped
    //    adapter filters it (the ledger carries the webhook's proposal) —
    //    counted, typed-deduplicated, zero new commands.
    const rescan = unwrap(
      await runFinanceSync(
        {
          authorization: world.authorization,
          adapter: world.adapter,
          translator: world.translator,
          systemId: FINANCE_SYSTEM_ID,
          objectKinds: [INVOICE_OBJECT_KIND],
          limit: 10,
        },
        world.deps,
      ),
    );
    expect(rescan.counts.proposals).toBe(0);
    expect(rescan.counts.duplicateDeduplicated).toBe(1);
    expect(rescan.commands).toStrictEqual([]);
    expect(rescan.duplicates[0]?.reason).toBe('ledger');
    // The mapping table holds the webhook's canonical id — not a second one.
    const entries = await world.ledger.listByCoordinate(
      TENANT_A,
      coordinateOf(sourceOf('invoice', 'inv-8', 'v1')),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.proposalKey).toBe(pushedKey);
  });

  it('is deterministic: the same push derives the same dedup and command keys (run twice)', async () => {
    const worldA = webhookWorld(NOW_2);
    const worldB = webhookWorld(NOW_2);
    putInvoice(worldA.store, 'inv-9', NOW_1);
    putInvoice(worldB.store, 'inv-9', NOW_1);
    const raw = worldA.store.emitWebhook('created', 'inv-9');

    const first = unwrap(await worldA.ingest(raw));
    const second = unwrap(await worldB.ingest(raw));
    expect(first.outcome).toBe(second.outcome);
    expect(first.command?.idempotencyKey).toBe(second.command?.idempotencyKey);
    expect(first.envelope?.deduplicationKey).toBe(second.envelope?.deduplicationKey);
    expect(first.command?.payload).toStrictEqual(second.command?.payload);
  });
});
