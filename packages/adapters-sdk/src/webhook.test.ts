import { describe, expect, it } from 'vitest';
import { formatEntityId, parseEntityKind, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityKind, TenantId, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { authorizationContext, definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  applyWebhook,
  isWebhookDeduplicationKey,
  isProviderWebhookBody,
  normalizeWebhook,
  parseWebhookDeduplicationKey,
  webhookDeduplicationKey,
} from './webhook';
import type {
  NormalizedWebhook,
  RawWebhook,
  WebhookEngineDeps,
  WebhookSignatureVerifier,
} from './webhook';
import { adapterKind, providerObjectId, providerVersion } from './identity';
import { coordinateOf, sourceRef, syncIdempotencyKey } from './source-ref';
import { createInMemorySourceMappingStore } from './mapping';
import {
  FAKE_ADAPTER_KIND,
  FAKE_ARCHIVE_COMMAND,
  FAKE_CREATE_COMMAND,
  FAKE_OBJECT_KIND,
  FAKE_SYSTEM_ID,
  FAKE_UPDATE_COMMAND,
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  createFakeProvider,
  createFakeWebhookVerifier,
  fakeWebhookSignature,
} from './fake-provider';
import type { FakeProvider } from './fake-provider';

// OFF-020 adapters-sdk — webhook normalization + the intake engine. An
// inbound provider push is verified by the INJECTED signature verifier port
// (tested with the fake), parsed fail-closed, normalized into ONE typed
// envelope (SourceRef, event kind, payload, deterministic replay dedup key,
// receivedAt from the injected clock), and applied end to end: the engine
// resolves/records the source mapping and proposes the canonical command —
// adapters never write the graph. Deterministic: fixed tenants/instants/ids,
// in-memory stores, the fake provider fixture.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160504f3e2d1c0b'));

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `org${String(n).padStart(13, '0')}` });

const SCOPE_A = { kind: 'tenant', tenantId: TENANT_A } as const;

const ALLOW_POLICY: Policy = definePolicy([
  { effect: 'allow', actorKinds: ['adapter'], capabilities: ['organization.write'] },
]);
const DENY_BY_DEFAULT: Policy = definePolicy([]);

/** A canonical version lookup over an explicit, deterministic table. */
const versionLookup =
  (table: Map<string, AggregateVersion | null>) =>
  async (
    tenantId: TenantId,
    canonical: { readonly entityKind: string; readonly entityId: string },
  ): Promise<Result<AggregateVersion | null, DomainError>> => {
    // Tenant-scoped by construction: foreign tenants see absence, never
    // another tenant's versions (A12 — no existence oracle).
    if (tenantId !== TENANT_A) return ok(null);
    return ok(table.get(canonical.entityId) ?? null);
  };

/** Deterministic engine deps: fixed clock, sequential office-issued ids. */
const engineDeps = (parts?: {
  readonly at?: Timestamp;
  readonly versions?: Map<string, AggregateVersion | null>;
  readonly idPrefix?: number;
}): WebhookEngineDeps => {
  const now = parts?.at ?? NOW_1;
  let nextId = parts?.idPrefix ?? 1;
  const versions = parts?.versions ?? new Map<string, AggregateVersion | null>();
  return {
    mappings: createInMemorySourceMappingStore(),
    canonicalVersionOf: versionLookup(versions),
    now: () => now,
    nextCanonicalId: () => entity(nextId++),
  };
};

const seededProvider = (): FakeProvider => {
  const provider = createFakeProvider();
  provider.putObject({ objectId: 'c-1', displayName: 'Site logistics contact' });
  return provider;
};

const applyWith = (parts: {
  readonly provider?: FakeProvider;
  readonly raw: RawWebhook;
  readonly deps?: WebhookEngineDeps;
  readonly policy?: Policy;
  readonly tenantId?: TenantId;
  readonly verifier?: WebhookSignatureVerifier;
}) => {
  const provider = parts.provider ?? seededProvider();
  const tenantId = parts.tenantId ?? TENANT_A;
  const context = authorizationContext({
    actor: { kind: 'adapter', actorId: entity(90) },
    scope: { kind: 'tenant', tenantId },
    capabilities: ['organization.write'],
  });
  return applyWebhook({
    authorization: { context, policy: parts.policy ?? ALLOW_POLICY },
    adapter: provider.adapter,
    translator: provider.translator,
    verifier: parts.verifier ?? createFakeWebhookVerifier(),
    deps: parts.deps ?? engineDeps(),
    raw: parts.raw,
  });
};

/** Fixture helper: a branded EntityKind from a known-good literal. */
const entityKindOf = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity kind: ${raw}`);
  return parsed.value;
};

describe('webhook dedup keys and body parsing', () => {
  it('derives the same dedup key for the same provider event identity', () => {
    const base = {
      adapterKind: FAKE_ADAPTER_KIND,
      systemId: FAKE_SYSTEM_ID,
      eventKind: 'updated' as const,
      objectType: FAKE_OBJECT_KIND,
      objectId: providerObjectId('c-1'),
      version: providerVersion('v2'),
      occurredAt: NOW_1,
    };
    const key = webhookDeduplicationKey(base);
    expect(webhookDeduplicationKey({ ...base })).toBe(key);
    expect(isWebhookDeduplicationKey(key)).toBe(true);
    expect(parseWebhookDeduplicationKey(key).ok).toBe(true);
    // A moved version or a different event kind is a different event.
    expect(webhookDeduplicationKey({ ...base, version: providerVersion('v3') })).not.toBe(key);
    expect(webhookDeduplicationKey({ ...base, eventKind: 'created' })).not.toBe(key);
    expect(webhookDeduplicationKey({ ...base, objectId: providerObjectId('c-2') })).not.toBe(key);
    for (const raw of [
      '',
      'office-whk-v1-',
      'office-whk-v1-short',
      'office-whk-v1-ABCDEF0123456789ABCDEF0123456789',
      'office-cfl-v1-abcdef0123456789abcdef0123456789',
      7,
      null,
    ]) {
      expect(parseWebhookDeduplicationKey(raw).ok, `raw: ${String(raw)}`).toBe(false);
      expect(isWebhookDeduplicationKey(raw)).toBe(false);
    }
  });

  it('parses provider webhook bodies fail-closed (strict keys, closed vocabulary)', () => {
    const body = {
      kind: 'provider-webhook-body',
      eventKind: 'updated',
      objectType: 'contact',
      objectId: 'c-1',
      version: 'v2',
      occurredAt: NOW_1,
      data: { email: 'ops@example.test' },
    };
    expect(isProviderWebhookBody(body)).toBe(true);
    for (const raw of [
      null,
      { ...body, kind: 'webhook' },
      { ...body, eventKind: 'upserted' },
      { ...body, objectType: 'Contact' },
      { ...body, objectId: 'has space' },
      { ...body, version: '' },
      { ...body, occurredAt: 'now' },
      { ...body, data: [] },
      { ...body, unknown: 1 },
      { kind: 'provider-webhook-body', eventKind: 'updated' },
    ]) {
      expect(isProviderWebhookBody(raw), `raw: ${JSON.stringify(raw)}`).toBe(false);
    }
  });
});

describe('webhook normalization (verify → parse → envelope)', () => {
  it('normalizes a signed webhook into the typed envelope', () => {
    const provider = seededProvider();
    const raw = provider.emitWebhook('created', 'c-1');
    const normalized = normalizeWebhook({
      raw,
      tenantId: TENANT_A,
      verifier: createFakeWebhookVerifier(),
      now: NOW_1,
    });
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      const envelope: NormalizedWebhook = normalized.value;
      expect(envelope.kind).toBe('normalized-webhook');
      expect(envelope.tenantId).toBe(TENANT_A);
      expect(envelope.source).toStrictEqual(
        sourceRef({
          adapterKind: FAKE_ADAPTER_KIND,
          systemId: FAKE_SYSTEM_ID,
          objectType: FAKE_OBJECT_KIND,
          objectId: providerObjectId('c-1'),
          version: providerVersion('v1'),
        }),
      );
      expect(envelope.eventKind).toBe('created');
      expect(envelope.occurredAt).toBeNull();
      expect(envelope.data).toStrictEqual({});
      expect(envelope.receivedAt).toBe(NOW_1);
      expect(isWebhookDeduplicationKey(envelope.deduplicationKey)).toBe(true);
    }
  });

  it('typed-rejects a webhook whose signature the verifier port denies', () => {
    const provider = seededProvider();
    const raw = provider.emitWebhook('created', 'c-1');
    const tampered: RawWebhook = {
      ...raw,
      headers: { [FAKE_WEBHOOK_SIGNATURE_HEADER]: 'sha256=deadbeef' },
    };
    const normalized = normalizeWebhook({
      raw: tampered,
      tenantId: TENANT_A,
      verifier: createFakeWebhookVerifier(),
      now: NOW_1,
    });
    expect(normalized.ok).toBe(false);
    if (!normalized.ok) {
      expect(normalized.error.code).toBe('unauthorized');
      expect(normalized.error.details[0]?.code).toBe('webhook-signature-invalid');
    }
  });

  it('typed-rejects malformed bodies fail-closed (never a silent drop)', () => {
    const provider = seededProvider();
    const signed = (body: unknown): RawWebhook => ({
      kind: 'raw-webhook',
      adapterKind: FAKE_ADAPTER_KIND,
      systemId: FAKE_SYSTEM_ID,
      headers: { [FAKE_WEBHOOK_SIGNATURE_HEADER]: fakeWebhookSignature(body as never) },
      body,
    });
    // Non-JSON bodies fail the FIRST gate (the JSON value parser), so no
    // signature can carry them through.
    for (const body of [undefined, () => {}, new Date(0)]) {
      const normalized = normalizeWebhook({
        raw: { ...signed(null), body },
        tenantId: TENANT_A,
        verifier: createFakeWebhookVerifier(),
        now: NOW_1,
      });
      expect(normalized.ok, `body: ${String(body)}`).toBe(false);
      if (!normalized.ok) {
        expect(normalized.error.code).toBe('invariant-violation');
        expect(normalized.error.details[0]?.code.startsWith('webhook-body-')).toBe(true);
      }
    }
    // JSON-exact but structurally wrong bodies pass verification and fail
    // the strict ProviderWebhookBody parse instead.
    for (const body of [
      'not-an-object',
      { kind: 'provider-webhook-body' },
      { kind: 'provider-webhook-body', eventKind: 'exploded' },
      { ...(provider.emitWebhook('created', 'c-1').body as Record<string, unknown>), extra: 'field' },
    ]) {
      const normalized = normalizeWebhook({
        raw: signed(body),
        tenantId: TENANT_A,
        verifier: createFakeWebhookVerifier(),
        now: NOW_1,
      });
      expect(normalized.ok, `body: ${String(body)}`).toBe(false);
      if (!normalized.ok) {
        expect(normalized.error.code).toBe('invariant-violation');
        expect(normalized.error.details[0]?.code.startsWith('webhook-body-')).toBe(true);
      }
    }
  });

  it('runs the injected verifier BEFORE the strict body shape parse', () => {
    // A JSON-exact but structurally invalid body with an INVALID signature is
    // an unauthorized signature failure — verification gates the shape parse,
    // so an unsigned body can never probe the parser shape.
    const normalized = normalizeWebhook({
      raw: {
        kind: 'raw-webhook',
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: FAKE_SYSTEM_ID,
        headers: {},
        body: { kind: 'provider-webhook-body' },
      },
      tenantId: TENANT_A,
      verifier: createFakeWebhookVerifier(),
      now: NOW_1,
    });
    expect(normalized.ok).toBe(false);
    if (!normalized.ok) expect(normalized.error.code).toBe('unauthorized');
  });
});

describe('the webhook intake engine (applyWebhook)', () => {
  it('creates a mapping and proposes the create command for a new source', async () => {
    const provider = seededProvider();
    const deps = engineDeps({ at: NOW_1 });
    const outcome = unwrap(
      await applyWith({ provider, raw: provider.emitWebhook('created', 'c-1'), deps }),
    );
    expect(outcome.outcome).toBe('source-created');
    expect(outcome.mapping).not.toBeNull();
    if (outcome.mapping !== null) {
      // The canonical id is office-issued by the injected supplier — the
      // provider id never reaches the canonical side (A10).
      expect(outcome.mapping.canonical.entityId).toBe(entity(1));
      expect(outcome.mapping.canonical.entityId).not.toBe('c-1');
      expect(outcome.mapping.providerVersion).toBe('v1');
      expect(outcome.mapping.canonicalVersion).toBe(INITIAL_AGGREGATE_VERSION);
    }
    expect(outcome.command).not.toBeNull();
    if (outcome.command !== null) {
      expect(outcome.command.commandName).toBe(FAKE_CREATE_COMMAND);
      expect(outcome.command.idempotencyKey).toBe(syncIdempotencyKey(outcome.envelope.source));
      expect(outcome.command.causality.causationId).toBe(outcome.envelope.deduplicationKey);
      expect(outcome.command.issuedAt).toBe(NOW_1);
    }
    // The mapping is persisted and resolvable through the coordinate.
    const stored = await deps.mappings.findByCoordinate(
      TENANT_A,
      coordinateOf(outcome.envelope.source),
    );
    expect(stored?.canonical.entityId).toBe(entity(1));
  });

  it('replays the same event as an idempotent no-op (no duplicate anything)', async () => {
    const provider = seededProvider();
    const deps = engineDeps({ at: NOW_1 });
    const raw = provider.emitWebhook('created', 'c-1');
    const first = unwrap(await applyWith({ provider, raw, deps }));
    expect(first.outcome).toBe('source-created');

    // Full redelivery of the SAME provider event: same version, same body.
    const replay = unwrap(await applyWith({ provider, raw, deps }));
    expect(replay.outcome).toBe('replay-no-op');
    expect(replay.command).toBeNull();
    expect(replay.mapping).not.toBeNull();
    expect(replay.mapping).toStrictEqual(first.mapping);
    // Still exactly one mapping — nothing duplicated.
    expect(
      await deps.mappings.listByCanonical(TENANT_A, {
        entityKind: entityKindOf('organization'),
        entityId: entity(1),
      }),
    ).toHaveLength(1);
  });

  it('proposes the update command and advances bookkeeping on a new version', async () => {
    const provider = seededProvider();
    const versions = new Map<string, AggregateVersion | null>();
    const deps = engineDeps({ at: NOW_1, versions });
    unwrap(await applyWith({ provider, raw: provider.emitWebhook('created', 'c-1'), deps }));

    // The create command executed canonically: the aggregate exists at v1.
    versions.set(entity(1), INITIAL_AGGREGATE_VERSION);
    provider.updateObject('c-1', { displayName: 'Site logistics contact (updated)' });

    const updated = unwrap(
      await applyWith({ provider, raw: provider.emitWebhook('updated', 'c-1'), deps }),
    );
    expect(updated.outcome).toBe('source-updated');
    expect(updated.mapping?.providerVersion).toBe('v2');
    expect(updated.mapping?.canonical.entityId).toBe(entity(1));
    expect(updated.command).not.toBeNull();
    if (updated.command !== null) {
      expect(updated.command.commandName).toBe(FAKE_UPDATE_COMMAND);
      // A different provider version derives a different command key.
      expect(updated.command.idempotencyKey).toBe(
        syncIdempotencyKey(updated.envelope.source),
      );
      expect(updated.command.idempotencyKey).not.toBe(
        syncIdempotencyKey({ ...updated.envelope.source, version: providerVersion('v1') }),
      );
    }
  });

  it('typed-rejects an update for an unknown source (fail closed)', async () => {
    const provider = seededProvider();
    provider.putObject({ objectId: 'c-9', displayName: 'Unknown elsewhere' });
    const result = await applyWith({
      provider,
      raw: provider.emitWebhook('updated', 'c-9'),
      deps: engineDeps(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('source-mapping-not-found');
    }
  });

  it('proposes the archive command for a deletion of a mapped source', async () => {
    const provider = seededProvider();
    const deps = engineDeps({ at: NOW_1 });
    unwrap(await applyWith({ provider, raw: provider.emitWebhook('created', 'c-1'), deps }));
    provider.deleteObject('c-1');
    const deleted = unwrap(
      await applyWith({ provider, raw: provider.emitWebhook('deleted', 'c-1'), deps }),
    );
    expect(deleted.outcome).toBe('source-deleted');
    expect(deleted.command).not.toBeNull();
    if (deleted.command !== null) {
      expect(deleted.command.commandName).toBe(FAKE_ARCHIVE_COMMAND);
    }
  });

  it('no-ops a deletion of an unmapped source', async () => {
    const provider = seededProvider();
    provider.putObject({ objectId: 'c-9', displayName: 'Ghost' });
    provider.deleteObject('c-9');
    const outcome = unwrap(
      await applyWith({
        provider,
        raw: provider.emitWebhook('deleted', 'c-9'),
        deps: engineDeps(),
      }),
    );
    expect(outcome.outcome).toBe('deletion-no-op');
    expect(outcome.mapping).toBeNull();
    expect(outcome.command).toBeNull();
  });

  it('typed-rejects a webhook routed to a different adapter kind', async () => {
    const provider = seededProvider();
    const raw = provider.emitWebhook('created', 'c-1');
    const result = await applyWith({
      provider,
      raw: { ...raw, adapterKind: adapterKind('fake-pm') },
      deps: engineDeps(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('adapter-kind-mismatch');
    }
  });

  it('typed-rejects an object kind the adapter does not declare', async () => {
    const provider = seededProvider();
    const body = {
      kind: 'provider-webhook-body',
      eventKind: 'created',
      objectType: 'task',
      objectId: 't-1',
      version: 'v1',
      occurredAt: null,
      data: {},
    };
    const result = await applyWith({
      provider,
      raw: {
        kind: 'raw-webhook',
        adapterKind: FAKE_ADAPTER_KIND,
        systemId: FAKE_SYSTEM_ID,
        headers: { [FAKE_WEBHOOK_SIGNATURE_HEADER]: fakeWebhookSignature(body as never) },
        body,
      },
      deps: engineDeps(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('object-kind-not-declared');
    }
  });

  it('authorizes the run deny-by-default before anything moves', async () => {
    const provider = seededProvider();
    const result = await applyWith({
      provider,
      raw: provider.emitWebhook('created', 'c-1'),
      deps: engineDeps(),
      policy: DENY_BY_DEFAULT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
    // Nothing was recorded — the denial preceded every effect.
    const deps = engineDeps();
    expect(
      await deps.mappings.findByCoordinate(
        TENANT_A,
        coordinateOf(
          sourceRef({
            adapterKind: FAKE_ADAPTER_KIND,
            systemId: FAKE_SYSTEM_ID,
            objectType: FAKE_OBJECT_KIND,
            objectId: providerObjectId('c-1'),
            version: providerVersion('v1'),
          }),
        ),
      ),
    ).toBeNull();
  });

  it('typed-rejects a non-adapter actor before anything moves', async () => {
    const provider = seededProvider();
    const raw = provider.emitWebhook('created', 'c-1');
    const result = await applyWebhook({
      authorization: {
        context: authorizationContext({
          actor: { kind: 'user', actorId: entity(99) },
          scope: SCOPE_A,
          capabilities: ['organization.write'],
        }),
        policy: ALLOW_POLICY,
      },
      adapter: provider.adapter,
      translator: provider.translator,
      verifier: createFakeWebhookVerifier(),
      deps: engineDeps(),
      raw,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('adapter-actor-required');
    }
  });

  it('sees no mapping under a foreign tenant (A12 — absence, no oracle)', async () => {
    const provider = seededProvider();
    const deps = engineDeps({ at: NOW_1 });
    // Tenant A maps the source…
    unwrap(await applyWith({ provider, raw: provider.emitWebhook('created', 'c-1'), deps }));
    // …tenant B receives the same event for the same provider object: the
    // mapping is invisible, so an 'updated' is a typed not-found exactly as
    // for a never-mapped source.
    const result = await applyWith({
      provider,
      raw: provider.emitWebhook('updated', 'c-1'),
      deps,
      tenantId: TENANT_B,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('source-mapping-not-found');
    }
  });
});
