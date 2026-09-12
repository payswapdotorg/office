import { describe, expect, it } from 'vitest';
import { parseTenantId, parseTimestamp } from '@office/contracts';
import type { TenantId, Timestamp } from '@office/contracts';
import {
  isProviderSnapshot,
  parseProviderSnapshot,
  providerSnapshot,
} from './snapshot';
import { adapterKind, providerObjectKind, providerObjectId, providerSystemId, providerVersion } from './identity';
import { sourceRef } from './source-ref';

// OFF-020 adapters-sdk — the provider-neutral object snapshot. An adapter
// produces one snapshot per provider object version: provenance (the SourceRef
// and the observedAt instant from the INJECTED clock — never a wall clock),
// typed core fields every provider object has (display name, lifecycle status
// with an explicit 'deleted' tombstone, provider-side last-modified), and the
// open-keyed extension bag (JSONB-shaped). Parsing is total and fail-closed.
// Deterministic: fixed tenant/instants.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const PROVIDER_AT: Timestamp = unwrap(parseTimestamp('2026-09-11T08:00:00.000Z'));

const SOURCE = sourceRef({
  adapterKind: adapterKind('fake-crm'),
  systemId: providerSystemId('fake-instance-01'),
  objectType: providerObjectKind('contact'),
  objectId: providerObjectId('c-1'),
  version: providerVersion('v2'),
});

const BASE_PARTS = {
  tenantId: TENANT_A,
  source: SOURCE,
  displayName: 'Site logistics contact',
  objectStatus: 'active',
  providerUpdatedAt: PROVIDER_AT,
  observedAt: NOW,
  extension: { email: 'ops@example.test', tags: ['primary'] },
} as const;

type SnapshotParts = Parameters<typeof providerSnapshot>[0];

/** Compose a snapshot, allowing (deliberately invalid) overrides for the
 * trusted-path TypeError assertions — the builder must reject loudly. */
const snapshot = (overrides?: Record<string, unknown>): ReturnType<typeof providerSnapshot> =>
  providerSnapshot({
    ...(BASE_PARTS as unknown as SnapshotParts),
    ...overrides,
  } as unknown as SnapshotParts);

describe('provider snapshot composition and parsing', () => {
  it('builds a snapshot with full provenance and round-trips strict parsing', () => {
    const value = snapshot();
    expect(value.kind).toBe('provider-snapshot');
    expect(value.tenantId).toBe(TENANT_A);
    expect(value.source).toStrictEqual(SOURCE);
    expect(value.displayName).toBe('Site logistics contact');
    expect(value.objectStatus).toBe('active');
    expect(value.providerUpdatedAt).toBe(PROVIDER_AT);
    expect(value.observedAt).toBe(NOW);
    expect(value.extension).toStrictEqual({ email: 'ops@example.test', tags: ['primary'] });

    const parsed = parseProviderSnapshot(value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(value);
    expect(isProviderSnapshot(value)).toBe(true);
  });

  it('accepts the tombstone status and null core fields', () => {
    const tombstone = snapshot({
      displayName: null,
      objectStatus: 'deleted',
      providerUpdatedAt: null,
    });
    expect(tombstone.objectStatus).toBe('deleted');
    expect(parseProviderSnapshot(tombstone).ok).toBe(true);
    // An empty display name is a name, not an absence.
    expect(parseProviderSnapshot(snapshot({ displayName: '' })).ok).toBe(true);
  });

  it('rejects malformed snapshots fail-closed (strict keys, closed vocabularies)', () => {
    for (const raw of [
      null,
      'snapshot',
      { ...snapshot(), kind: 'other-snapshot' },
      { ...snapshot(), unknown: 'field' },
      { ...snapshot(), objectStatus: 'archived' },
      { ...snapshot(), objectStatus: 'Active' },
      { ...snapshot(), displayName: 42 },
      { ...snapshot(), displayName: 'x'.repeat(513) },
      { ...snapshot(), observedAt: 'now' },
      { ...snapshot(), providerUpdatedAt: 'now' },
      { ...snapshot(), tenantId: 'tenant-a' },
      { ...snapshot(), source: { ...SOURCE, version: null } },
      // The extension bag must be a JSON object, not an array or primitive.
      { ...snapshot(), extension: ['not', 'an', 'object'] },
      { ...snapshot(), extension: null },
      { ...snapshot(), extension: { when: new Date(0) } },
    ]) {
      const parsed = parseProviderSnapshot(raw);
      expect(parsed.ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      if (!parsed.ok) {
        expect(['invalid-type', 'invalid-value', 'unknown-field', 'missing-field']).toContain(
          parsed.error.code,
        );
      }
      expect(isProviderSnapshot(raw)).toBe(false);
    }
  });

  it('throws loudly on the trusted composition path', () => {
    expect(() => snapshot()).not.toThrow();
    expect(() => snapshot({ objectStatus: 'vanished' })).toThrow(TypeError);
    expect(() => snapshot({ extension: 'nope' })).toThrow(TypeError);
  });
});
