// Office adapters-sdk — the provider-neutral object snapshot (OFF-020).
//
// ProviderSnapshot is the normalized record an adapter produces from one
// provider object at one provider version: provenance (the SourceRef and the
// observedAt instant from the injected clock — never a wall clock read inside
// the adapter), typed core fields every provider object has (display name,
// lifecycle status with an explicit 'deleted' tombstone state, provider-side
// last-modified instant), and the open-keyed extension bag carrying the
// provider's own payload data (JSONB-shaped, JSON-exact — see json.ts).
//
// Snapshots are tenant-stamped by the sync flow that requested them (the
// engine validates the stamp and typed-rejects a cross-tenant injection),
// because the snapshot is the office-side record of an observation — the
// provider itself has no notion of office tenants.
import {
  parseFail,
  parseOk,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { ParseResult, TenantId, Timestamp } from '@office/contracts';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  requireString,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import { parseAdapterJsonObject } from './json';
import type { AdapterJsonObject } from './json';
import { parseSourceRef } from './source-ref';
import type { SourceRef } from './source-ref';

/** Lifecycle status of a provider object as observed ('deleted' = tombstone). */
export type ProviderObjectStatus = 'active' | 'deleted';

/** Shape description used in parse failures. */
export const PROVIDER_SNAPSHOT_GRAMMAR =
  "ProviderSnapshot: { kind: 'provider-snapshot', tenantId, source, displayName: string | null, objectStatus: 'active' | 'deleted', providerUpdatedAt: Timestamp | null, observedAt, extension: JSON object }";

const PROVIDER_SNAPSHOT_KEYS = [
  'kind',
  'tenantId',
  'source',
  'displayName',
  'objectStatus',
  'providerUpdatedAt',
  'observedAt',
  'extension',
] as const;

const DISPLAY_NAME_RULE: StringRule = {
  min: 0,
  max: 512,
  description: 'provider object display name (may be empty; null when the provider has none)',
};

/** The normalized, provider-neutral observation of one provider object version. */
export interface ProviderSnapshot {
  readonly kind: 'provider-snapshot';
  /** The tenant whose sync observed this snapshot (stamped by the sync flow). */
  readonly tenantId: TenantId;
  /** Provenance: the provider object's full identity at this version. */
  readonly source: SourceRef;
  /** Typed core field: the object's display name, or null when it has none. */
  readonly displayName: string | null;
  /** Typed core field: lifecycle status — 'deleted' is the tombstone state. */
  readonly objectStatus: ProviderObjectStatus;
  /** The provider's own last-modified instant for this version, or null. */
  readonly providerUpdatedAt: Timestamp | null;
  /** Provenance: when office observed this version (injected clock). */
  readonly observedAt: Timestamp;
  /** The provider's own payload data (open-keyed extension bag, JSONB-shaped). */
  readonly extension: AdapterJsonObject;
}

/** Parse an untrusted value as a ProviderSnapshot (total, fail-closed, strict keys). */
export function parseProviderSnapshot(raw: unknown): ParseResult<ProviderSnapshot> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PROVIDER_SNAPSHOT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PROVIDER_SNAPSHOT_KEYS, '', PROVIDER_SNAPSHOT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['provider-snapshot']);
  if (!kind.ok) return kind;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const source = requireFieldWith(raw, 'source', '', parseSourceRef);
  if (!source.ok) return source;
  const displayName = requireNullableString(raw);
  if (!displayName.ok) return displayName;
  const objectStatus = requireLiteral(raw, 'objectStatus', '', ['active', 'deleted']);
  if (!objectStatus.ok) return objectStatus;
  const providerUpdatedAt = requireNullableFieldWith(
    raw,
    'providerUpdatedAt',
    '',
    parseTimestamp,
  );
  if (!providerUpdatedAt.ok) return providerUpdatedAt;
  const observedAt = requireFieldWith(raw, 'observedAt', '', parseTimestamp);
  if (!observedAt.ok) return observedAt;
  const extension = requireFieldWith(raw, 'extension', '', parseAdapterJsonObject);
  if (!extension.ok) return extension;
  return parseOk(
    {
      kind: 'provider-snapshot',
      tenantId: tenantId.value,
      source: source.value,
      displayName: displayName.value,
      objectStatus: objectStatus.value as ProviderObjectStatus,
      providerUpdatedAt: providerUpdatedAt.value,
      observedAt: observedAt.value,
      extension: extension.value,
    } satisfies ProviderSnapshot,
  );
}

/** Type guard for structurally valid ProviderSnapshot values. */
export function isProviderSnapshot(raw: unknown): raw is ProviderSnapshot {
  return parseProviderSnapshot(raw).ok;
}

/** Compose a ProviderSnapshot from validated parts (trusted path; loud TypeError). */
export function providerSnapshot(parts: {
  readonly tenantId: TenantId;
  readonly source: SourceRef;
  readonly displayName: string | null;
  readonly objectStatus: ProviderObjectStatus;
  readonly providerUpdatedAt: Timestamp | null;
  readonly observedAt: Timestamp;
  readonly extension: AdapterJsonObject;
}): ProviderSnapshot {
  const parsed = parseProviderSnapshot({ ...parts, kind: 'provider-snapshot' });
  if (!parsed.ok) {
    throw new TypeError(`invalid provider snapshot: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Display names may be absent (null) but never non-string or oversized. */
const requireNullableString = (
  raw: Record<string, unknown>,
): ParseResult<string | null> => {
  const value = raw['displayName'];
  if (value === null) return parseOk(null);
  const result = requireString(raw, 'displayName', '', DISPLAY_NAME_RULE);
  if (!result.ok) return result;
  return parseOk(result.value);
};
