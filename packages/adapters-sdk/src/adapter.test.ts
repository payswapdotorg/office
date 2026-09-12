import { describe, expect, it } from 'vitest';
import { formatEntityId, parseEntityKind, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, EntityKind, TenantId, Timestamp } from '@office/contracts';
import { authorizationContext, capability } from '@office/authz';
import {
  adapterAuthorizationContext,
  isAdapterCapabilities,
  isAdapterConnection,
  isAdapterHealth,
  isAdapterObjectCapability,
  isSyncResult,
  parseAdapterCapabilities,
  parseAdapterConnection,
  parseAdapterHealth,
  parseAdapterObjectCapability,
  parseSyncResult,
  requireAdapterActor,
} from './adapter';
import type { AdapterObjectCapability, SyncResult } from './adapter';
import {
  adapterKind,
  providerObjectId,
  providerObjectKind,
  providerSystemId,
  providerVersion,
} from './identity';
import { providerSnapshot } from './snapshot';
import { sourceRef } from './source-ref';
import { syncCursorToken } from './cursor';

// OFF-020 adapters-sdk — the provider-neutral Adapter contract surface:
// capability declarations (which object kinds an adapter syncs, and the
// canonical kind + capability each maps to), the connection lifecycle values,
// the sync page result shape (the engine's fail-closed boundary check on
// adapter output), and the adapter actor authorization guards. Deterministic:
// fixed ids/instants, pure functions.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `adp${String(n).padStart(13, '0')}` });

const KIND = adapterKind('fake-crm');
const SYSTEM = providerSystemId('fake-instance-01');

/** Fixture helper: a branded EntityKind from a known-good literal. */
const entityKindOf = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity kind: ${raw}`);
  return parsed.value;
};
const CONTACTS = providerObjectKind('contact');
const TASKS = providerObjectKind('task');

const capabilityEntry = (objectKind: typeof CONTACTS): AdapterObjectCapability => ({
  objectKind,
  canonicalKind: entityKindOf('organization'),
  capability: capability('organization.write'),
});

describe('adapter capability declarations', () => {
  it('parses a declared object-kind surface with strict keys', () => {
    const entry = capabilityEntry(CONTACTS);
    const parsed = parseAdapterObjectCapability(entry);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(entry);
    expect(isAdapterObjectCapability(entry)).toBe(true);
  });

  it('rejects malformed declarations fail-closed', () => {
    for (const raw of [
      null,
      'contact',
      { ...capabilityEntry(CONTACTS), unknown: 1 },
      { ...capabilityEntry(CONTACTS), objectKind: 'Contact' },
      { ...capabilityEntry(CONTACTS), canonicalKind: 'Organization' },
      { ...capabilityEntry(CONTACTS), capability: 'organization.audit' },
      { objectKind: CONTACTS, canonicalKind: 'organization' },
    ]) {
      expect(parseAdapterObjectCapability(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isAdapterObjectCapability(raw)).toBe(false);
    }
  });

  it('parses a capabilities set with unique object kinds and >= 1 entry', () => {
    const caps = { objectKinds: [capabilityEntry(CONTACTS), capabilityEntry(TASKS)] };
    const parsed = parseAdapterCapabilities(caps);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.objectKinds).toHaveLength(2);
    expect(isAdapterCapabilities(caps)).toBe(true);

    // An adapter that syncs nothing is not an adapter.
    expect(parseAdapterCapabilities({ objectKinds: [] }).ok).toBe(false);
    // One capability per provider object kind — duplicates are rejected.
    expect(
      parseAdapterCapabilities({
        objectKinds: [capabilityEntry(CONTACTS), capabilityEntry(CONTACTS)],
      }).ok,
    ).toBe(false);
    for (const raw of [null, {}, { objectKinds: 'contact' }, { objectKinds: [null] }]) {
      expect(parseAdapterCapabilities(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isAdapterCapabilities(raw)).toBe(false);
    }
  });
});

describe('adapter connection lifecycle values', () => {
  it('parses a connection with strict keys', () => {
    const connection = { kind: 'adapter-connection', systemId: SYSTEM, establishedAt: NOW };
    const parsed = parseAdapterConnection(connection);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(connection);
    expect(isAdapterConnection(connection)).toBe(true);
    for (const raw of [
      null,
      { ...connection, kind: 'socket' },
      { ...connection, unknown: 1 },
      { ...connection, systemId: 'has space' },
      { ...connection, establishedAt: 'now' },
    ]) {
      expect(parseAdapterConnection(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isAdapterConnection(raw)).toBe(false);
    }
  });

  it('parses health with the closed status vocabulary and nullable detail', () => {
    const healthy = { kind: 'adapter-health', status: 'healthy', checkedAt: NOW, detail: null };
    const parsed = parseAdapterHealth(healthy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(healthy);
    expect(isAdapterHealth(healthy)).toBe(true);
    const degraded = { ...healthy, status: 'degraded', detail: 'quota nearly exhausted' };
    expect(parseAdapterHealth(degraded).ok).toBe(true);
    for (const raw of [
      null,
      { ...healthy, status: 'sick' },
      { ...healthy, detail: 7 },
      { ...healthy, detail: 'x'.repeat(513) },
      { ...healthy, unknown: 1 },
    ]) {
      expect(parseAdapterHealth(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isAdapterHealth(raw)).toBe(false);
    }
  });
});

describe('sync page results (the engine boundary check on adapter output)', () => {
  const snapshot = providerSnapshot({
    tenantId: TENANT_A,
    source: sourceRef({
      adapterKind: KIND,
      systemId: SYSTEM,
      objectType: CONTACTS,
      objectId: providerObjectId('c-1'),
      version: providerVersion('v1'),
    }),
    displayName: 'Site logistics contact',
    objectStatus: 'active',
    providerUpdatedAt: NOW,
    observedAt: NOW,
    extension: {},
  });

  const page: SyncResult = {
    kind: 'sync-result',
    snapshots: [snapshot],
    nextCursorToken: syncCursorToken('1'),
    checkpoint: { itemsObserved: 1, lastProviderVersion: providerVersion('v1') },
    hasMore: true,
  };

  it('parses a valid page with strict keys and round-trips it', () => {
    const parsed = parseSyncResult(page);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(page);
    expect(isSyncResult(page)).toBe(true);
    // An exhausted page carries a null token.
    const exhausted: SyncResult = { ...page, snapshots: [], nextCursorToken: null, hasMore: false };
    expect(parseSyncResult(exhausted).ok).toBe(true);
  });

  it('rejects malformed pages fail-closed', () => {
    for (const raw of [
      null,
      'page',
      { ...page, kind: 'other-result' },
      { ...page, unknown: 1 },
      { ...page, hasMore: 'yes' },
      { ...page, nextCursorToken: 'has space' },
      { ...page, checkpoint: { itemsObserved: -1, lastProviderVersion: null } },
      { ...page, snapshots: [null] },
      { ...page, snapshots: [{ ...snapshot, objectStatus: 'archived' }] },
    ]) {
      const parsed = parseSyncResult(raw);
      expect(parsed.ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      if (!parsed.ok) {
        expect(['invalid-type', 'invalid-value', 'unknown-field', 'missing-field']).toContain(
          parsed.error.code,
        );
      }
      expect(isSyncResult(raw)).toBe(false);
    }
  });
});

describe('the adapter actor authorization guards', () => {
  const scope = { kind: 'tenant', tenantId: TENANT_A } as const;

  it('accepts the adapter actor kind only', () => {
    const adapterContext = authorizationContext({
      actor: { kind: 'adapter', actorId: entity(1) },
      scope,
      capabilities: ['organization.write'],
    });
    expect(requireAdapterActor(adapterContext).ok).toBe(true);
    for (const actor of [
      { kind: 'user', actorId: entity(2) },
      { kind: 'agent', actorId: entity(3) },
      { kind: 'app', actorId: entity(4) },
      { kind: 'system' },
    ] as readonly Actor[]) {
      const context = authorizationContext({
        actor,
        scope,
        capabilities: ['organization.write'],
      });
      const guard = requireAdapterActor(context);
      expect(guard.ok, `actor: ${JSON.stringify(actor)}`).toBe(false);
      if (!guard.ok) {
        expect(guard.error.code).toBe('forbidden');
        expect(guard.error.details[0]?.code).toBe('adapter-actor-required');
      }
    }
  });

  it('composes the adapter service context on the trusted path', () => {
    const context = adapterAuthorizationContext({
      actorId: entity(1),
      scope,
      capabilities: ['organization.write', 'people.read'],
    });
    expect(context.actor).toStrictEqual({ kind: 'adapter', actorId: entity(1) });
    expect(context.scope).toStrictEqual(scope);
    expect(context.capabilities).toHaveLength(2);
    // An undeclared capability fails loudly at composition, never silently.
    expect(() =>
      adapterAuthorizationContext({
        actorId: entity(1),
        scope,
        capabilities: ['organization.audit'],
      }),
    ).toThrow(TypeError);
  });
});
