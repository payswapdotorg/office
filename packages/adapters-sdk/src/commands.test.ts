import { describe, expect, it } from 'vitest';
import { formatEntityId, parseCommandName, parseEntityKind, parseTenantId, parseTimestamp } from '@office/contracts';
import { CURRENT_SCHEMA_VERSION, parseCommandEnvelope } from '@office/contracts';
import type { CommandName, EntityKind, EntityRef, TenantId, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION } from '@office/domain-kernel';
import { authorizationContext } from '@office/authz';
import {
  adapterCommandEnvelope,
  causationIdOfWebhook,
  checkCommandEnvelopeRoundTrip,
  requireCanonicalTarget,
} from './commands';
import type { AdapterCommandInput, AdapterCommandProposal } from './commands';
import {
  adapterKind,
  providerObjectId,
  providerObjectKind,
  providerSystemId,
  providerVersion,
} from './identity';
import { coordinateOf, sourceCorrelationId, sourceRef, syncIdempotencyKey } from './source-ref';
import { webhookDeduplicationKey } from './webhook';

// OFF-020 adapters-sdk — the canonical command translation seam. Adapters
// never write the graph: they propose typed commands, and the SDK composes
// the CommandEnvelope deterministically — the idempotency key derived from
// the SourceRef (ONE command per provider object version, shared across the
// sync and webhook intake paths), the correlation id tying the provider
// object's whole lifecycle into one causal chain, issuedAt from the injected
// clock, and the current schema version. Every composed envelope must
// round-trip the contracts parser. Deterministic: fixed ids/instants.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `org${String(n).padStart(13, '0')}` });

const SOURCE_V1 = sourceRef({
  adapterKind: adapterKind('fake-crm'),
  systemId: providerSystemId('fake-instance-01'),
  objectType: providerObjectKind('contact'),
  objectId: providerObjectId('c-1'),
  version: providerVersion('v1'),
});
const SOURCE_V2 = { ...SOURCE_V1, version: providerVersion('v2') };

const CONTEXT = authorizationContext({
  actor: { kind: 'adapter', actorId: entity(90) },
  scope: { kind: 'tenant', tenantId: TENANT_A },
  capabilities: ['organization.write'],
});

/** Fixture helper: a branded CommandName from a known-good literal. */
const commandNameOf = (raw: string): CommandName => {
  const parsed = parseCommandName(raw);
  if (!parsed.ok) throw new TypeError(`fixture command name: ${raw}`);
  return parsed.value;
};

/** Fixture helper: a branded EntityKind from a known-good literal. */
const entityKindOf = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity kind: ${raw}`);
  return parsed.value;
};

const PROPOSAL: AdapterCommandProposal = {
  commandName: commandNameOf('organization.createOrganization'),
  payload: { name: 'Site logistics contact' },
};

describe('adapter command envelope composition (deterministic)', () => {
  it('derives the idempotency key from the SourceRef — same ref, same key', () => {
    const command = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V1,
      causationId: null,
      now: NOW,
    });
    expect(command.kind).toBe('command');
    expect(command.commandName).toBe('organization.createOrganization');
    expect(command.idempotencyKey).toBe(syncIdempotencyKey(SOURCE_V1));
    // A different provider object version derives a different key.
    const moved = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V2,
      causationId: null,
      now: NOW,
    });
    expect(moved.idempotencyKey).toBe(syncIdempotencyKey(SOURCE_V2));
    expect(moved.idempotencyKey).not.toBe(command.idempotencyKey);
  });

  it('converges the sync and webhook paths on ONE command per provider version', () => {
    // The sync path composes with causationId null (a snapshot is a chain
    // root); the webhook path composes with the webhook dedup key as its
    // causation id. For the SAME SourceRef both paths derive the IDENTICAL
    // idempotency key and correlation id — a redelivered webhook or the same
    // version arriving later through a sync page collide at the command
    // layer instead of double-applying.
    const dedup = webhookDeduplicationKey({
      adapterKind: SOURCE_V1.adapterKind,
      systemId: SOURCE_V1.systemId,
      eventKind: 'updated',
      objectType: SOURCE_V1.objectType,
      objectId: SOURCE_V1.objectId,
      version: SOURCE_V1.version,
      occurredAt: null,
    });
    const fromSync = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V1,
      causationId: null,
      now: NOW,
    });
    const fromWebhook = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V1,
      causationId: causationIdOfWebhook(dedup),
      now: NOW_2,
    });
    expect(fromWebhook.idempotencyKey).toBe(fromSync.idempotencyKey);
    expect(fromWebhook.causality.correlationId).toBe(fromSync.causality.correlationId);
    expect(fromWebhook.causality.causationId).toBe(dedup);
    expect(fromSync.causality.causationId).toBeNull();
    // Only the issuance instant differs — injected clocks, not wall clocks.
    expect(fromWebhook.issuedAt).toBe(NOW_2);
    expect(fromSync.issuedAt).toBe(NOW);
  });

  it('ties the whole provider object lifecycle into one correlation chain', () => {
    const first = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V1,
      causationId: null,
      now: NOW,
    });
    const later = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V2,
      causationId: null,
      now: NOW_2,
    });
    const chain = sourceCorrelationId(coordinateOf(SOURCE_V1));
    expect(first.causality.correlationId).toBe(chain);
    expect(later.causality.correlationId).toBe(chain);
  });

  it('carries the context scope/actor, injected clock, and current schema version', () => {
    const command = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V1,
      causationId: null,
      now: NOW,
    });
    expect(command.scope).toStrictEqual(CONTEXT.scope);
    expect(command.actor).toStrictEqual(CONTEXT.actor);
    expect(command.issuedAt).toBe(NOW);
    expect(command.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(command.payload).toStrictEqual(PROPOSAL.payload);
  });

  it('round-trips the contracts parser and proves it typed', () => {
    const command = adapterCommandEnvelope({
      proposal: PROPOSAL,
      context: CONTEXT,
      source: SOURCE_V1,
      causationId: null,
      now: NOW,
    });
    expect(parseCommandEnvelope(command).ok).toBe(true);
    const roundTrip = checkCommandEnvelopeRoundTrip(command, TENANT_A);
    expect(roundTrip.ok).toBe(true);
  });

  it('throws loudly on an invalid proposal instead of coercing it', () => {
    expect(() =>
      adapterCommandEnvelope({
        // Intentionally invalid command name (missing namespace) — the
        // runtime parse must reject it; the cast is only to satisfy the
        // trusted-path input type in the test.
        proposal: { commandName: 'CreateOrganization' as CommandName, payload: {} },
        context: CONTEXT,
        source: SOURCE_V1,
        causationId: null,
        now: NOW,
      }),
    ).toThrow(TypeError);
    expect(() =>
      adapterCommandEnvelope({
        proposal: {
          commandName: PROPOSAL.commandName,
          // Intentionally invalid payload (null) — the runtime parse must
          // reject it; the cast is only to satisfy the input type.
          payload: null as unknown as AdapterCommandProposal['payload'],
        },
        context: CONTEXT,
        source: SOURCE_V1,
        causationId: null,
        now: NOW,
      }),
    ).toThrow(TypeError);
  });
});

describe('causationIdOfWebhook (the webhook dedup token as a causation id)', () => {
  it('re-brands a valid webhook dedup key', () => {
    const dedup = webhookDeduplicationKey({
      adapterKind: SOURCE_V1.adapterKind,
      systemId: SOURCE_V1.systemId,
      eventKind: 'created',
      objectType: SOURCE_V1.objectType,
      objectId: SOURCE_V1.objectId,
      version: SOURCE_V1.version,
      occurredAt: null,
    });
    expect(causationIdOfWebhook(dedup)).toBe(dedup);
  });

  it('throws loudly on a token that is not a causation id', () => {
    expect(() => causationIdOfWebhook('short')).toThrow(TypeError);
    expect(() => causationIdOfWebhook('office whk v1 with spaces')).toThrow(TypeError);
  });
});

describe('requireCanonicalTarget (the translator guard)', () => {
  const input = (canonical: AdapterCommandInput['canonical']): AdapterCommandInput => ({
    origin: 'sync',
    tenantId: TENANT_A,
    source: SOURCE_V1,
    canonical,
    canonicalVersion: canonical === null ? null : INITIAL_AGGREGATE_VERSION,
    changeKind: 'updated',
    displayName: 'Site logistics contact',
    data: {},
  });

  it('returns the resolved canonical target', () => {
    const target: EntityRef = { entityKind: entityKindOf('organization'), entityId: entity(1) };
    const guard = requireCanonicalTarget(input(target));
    expect(guard.ok).toBe(true);
    if (guard.ok) expect(guard.value).toStrictEqual(target);
  });

  it('typed-rejects a translation without a resolved canonical target', () => {
    const guard = requireCanonicalTarget(input(null));
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.error.code).toBe('invariant-violation');
      expect(guard.error.details[0]?.code).toBe('canonical-target-required');
    }
  });
});
