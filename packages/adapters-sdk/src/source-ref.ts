// Office adapters-sdk — the source identity reference (OFF-020).
//
// SourceRef is a provider object's full identity: the adapter kind that
// translates it, the provider system it lives in, the provider's object type
// and object id, and the provider's version/etag of that object. The
// version-less projection is the SourceCoordinate — the STABLE identity a
// mapping record binds to a canonical office EntityId (mapping.ts).
//
// Deterministic derivations (A9-friendly, mirroring the events package's
// ledger id derivation): the canonical JSON serialization of a ref/coordinate
// is unambiguous (JSON string escaping — no delimiter injection), and the
// sync idempotency key and source correlation id are sha256 digests over it:
//   - syncIdempotencyKey(ref) — the command idempotency key for ANY canonical
//     command proposed from that exact provider object version, whether it
//     arrived through a sync page or a webhook. The same SourceRef always
//     derives the same key, so at-least-once redelivery can never
//     double-apply (replay safety), and the sync and webhook paths converge
//     on one command per provider object version.
//   - sourceCorrelationId(coordinate) — the correlation id tying together the
//     whole causal chain of one provider object's canonical commands.
import { createHash } from 'node:crypto';
import {
  parseCorrelationId,
  parseFail,
  parseIdempotencyKey,
  parseOk,
} from '@office/contracts';
import type {
  CorrelationId,
  IdempotencyKey,
  ParseResult,
} from '@office/contracts';
import {
  isPlainObject,
  requireFieldWith,
  unknownKeyFailure,
  describeValue,
} from './parse';
import {
  parseAdapterKind,
  parseProviderObjectKind,
  parseProviderObjectId,
  parseProviderSystemId,
  parseProviderVersion,
} from './identity';
import type {
  AdapterKind,
  ProviderObjectKind,
  ProviderObjectId,
  ProviderSystemId,
  ProviderVersion,
} from './identity';

/**
 * The stable identity of one provider object: adapter kind, provider system,
 * provider object type, provider object id — everything except the version,
 * which changes as the provider mutates the object.
 */
export interface SourceCoordinate {
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly objectType: ProviderObjectKind;
  readonly objectId: ProviderObjectId;
}

/**
 * A provider object's identity at one provider version: the SourceCoordinate
 * plus the provider version/etag observed for it.
 */
export interface SourceRef extends SourceCoordinate {
  readonly version: ProviderVersion;
}

/** Shape description used in parse failures. */
export const SOURCE_COORDINATE_GRAMMAR =
  'SourceCoordinate: { adapterKind, systemId, objectType, objectId }';

/** Shape description used in parse failures. */
export const SOURCE_REF_GRAMMAR =
  'SourceRef: { adapterKind, systemId, objectType, objectId, version }';

const COORDINATE_KEYS = ['adapterKind', 'systemId', 'objectType', 'objectId'] as const;
const SOURCE_REF_KEYS = [...COORDINATE_KEYS, 'version'] as const;

/** Parse an untrusted value as a SourceCoordinate (total, fail-closed, strict keys). */
export function parseSourceCoordinate(raw: unknown): ParseResult<SourceCoordinate> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SOURCE_COORDINATE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, COORDINATE_KEYS, '', SOURCE_COORDINATE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const adapterKind = requireFieldWith(raw, 'adapterKind', '', parseAdapterKind);
  if (!adapterKind.ok) return adapterKind;
  const systemId = requireFieldWith(raw, 'systemId', '', parseProviderSystemId);
  if (!systemId.ok) return systemId;
  const objectType = requireFieldWith(raw, 'objectType', '', parseProviderObjectKind);
  if (!objectType.ok) return objectType;
  const objectId = requireFieldWith(raw, 'objectId', '', parseProviderObjectId);
  if (!objectId.ok) return objectId;
  return parseOk(
    {
      adapterKind: adapterKind.value,
      systemId: systemId.value,
      objectType: objectType.value,
      objectId: objectId.value,
    } satisfies SourceCoordinate,
  );
}

/** Type guard for structurally valid SourceCoordinate values. */
export function isSourceCoordinate(raw: unknown): raw is SourceCoordinate {
  return parseSourceCoordinate(raw).ok;
}

/** Parse an untrusted value as a SourceRef (total, fail-closed, strict keys). */
export function parseSourceRef(raw: unknown): ParseResult<SourceRef> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SOURCE_REF_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SOURCE_REF_KEYS, '', SOURCE_REF_GRAMMAR);
  if (unknownKey) return unknownKey;
  // Delegate the coordinate parse to a NARROWED projection of the four
  // coordinate fields: the ref-level unknown-key check already ran, and the
  // coordinate parser would otherwise reject the ref's own `version` key as
  // unknown (field paths stay root-relative either way).
  const coordinate = parseSourceCoordinate({
    adapterKind: raw['adapterKind'],
    systemId: raw['systemId'],
    objectType: raw['objectType'],
    objectId: raw['objectId'],
  });
  if (!coordinate.ok) return coordinate;
  const version = requireFieldWith(raw, 'version', '', parseProviderVersion);
  if (!version.ok) return version;
  return parseOk({ ...coordinate.value, version: version.value } satisfies SourceRef);
}

/** Type guard for structurally valid SourceRef values. */
export function isSourceRef(raw: unknown): raw is SourceRef {
  return parseSourceRef(raw).ok;
}

/** Compose a SourceCoordinate from validated parts (trusted path; loud TypeError). */
export function sourceCoordinate(parts: {
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly objectType: ProviderObjectKind;
  readonly objectId: ProviderObjectId;
}): SourceCoordinate {
  const parsed = parseSourceCoordinate(parts);
  if (!parsed.ok) {
    throw new TypeError(`invalid source coordinate: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Compose a SourceRef from validated parts (trusted path; loud TypeError). */
export function sourceRef(parts: {
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly objectType: ProviderObjectKind;
  readonly objectId: ProviderObjectId;
  readonly version: ProviderVersion;
}): SourceRef {
  const parsed = parseSourceRef(parts);
  if (!parsed.ok) {
    throw new TypeError(`invalid source ref: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** The version-less coordinate of a source ref (the stable mapping identity). */
export function coordinateOf(ref: SourceRef): SourceCoordinate {
  return sourceCoordinate({
    adapterKind: ref.adapterKind,
    systemId: ref.systemId,
    objectType: ref.objectType,
    objectId: ref.objectId,
  });
}

/**
 * Canonical, unambiguous serialization of a coordinate: a JSON array of the
 * four identity parts in fixed order (JSON string escaping makes delimiter
 * injection impossible). This is the key every store and derivation below
 * digests — never a hand-rolled join.
 */
export function sourceCoordinateKeyOf(coordinate: SourceCoordinate): string {
  return JSON.stringify([
    coordinate.adapterKind,
    coordinate.systemId,
    coordinate.objectType,
    coordinate.objectId,
  ]);
}

/** Canonical, unambiguous serialization of a source ref (coordinate + version). */
export function sourceRefKeyOf(ref: SourceRef): string {
  return JSON.stringify([
    ref.adapterKind,
    ref.systemId,
    ref.objectType,
    ref.objectId,
    ref.version,
  ]);
}

/** Length of the derived opaque part (sha256 hex, truncated — events precedent). */
const DERIVED_OPAQUE_LENGTH = 32;

const digestOf = (material: string): string =>
  createHash('sha256').update(material, 'utf8').digest('hex').slice(0, DERIVED_OPAQUE_LENGTH);

/**
 * Derive the command idempotency key of one provider object version
 * (deterministic, pure): `office-sync-v1-<sha256 prefix>` over the canonical
 * ref serialization. Any canonical command proposed from this exact SourceRef
 * — sync page or webhook — carries this key, so replays and cross-path
 * duplicates collide at the command layer instead of double-applying.
 */
export function syncIdempotencyKey(ref: SourceRef): IdempotencyKey {
  const candidate = `office-sync-v1-${digestOf(`office-adapter-sync-idempotency|${sourceRefKeyOf(ref)}`)}`;
  const parsed = parseIdempotencyKey(candidate);
  if (!parsed.ok) {
    // Pure derivation over validated inputs — a violation is a module defect.
    throw new TypeError(`derived idempotency key is not valid: ${candidate}`);
  }
  return parsed.value;
}

/**
 * Derive the correlation id of one provider object's causal chain
 * (deterministic, pure): `office-src-v1-<sha256 prefix>` over the coordinate.
 * Every canonical command proposed for this provider object — across all
 * versions and both intake paths — shares this correlation id.
 */
export function sourceCorrelationId(coordinate: SourceCoordinate): CorrelationId {
  const candidate = `office-src-v1-${digestOf(`office-adapter-source-correlation|${sourceCoordinateKeyOf(coordinate)}`)}`;
  const parsed = parseCorrelationId(candidate);
  if (!parsed.ok) {
    throw new TypeError(`derived correlation id is not valid: ${candidate}`);
  }
  return parsed.value;
}
