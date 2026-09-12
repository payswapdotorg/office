import { describe, expect, it } from 'vitest';
import { isIdempotencyKey, isCorrelationId, parseIdempotencyKey } from '@office/contracts';
import {
  coordinateOf,
  isSourceCoordinate,
  isSourceRef,
  parseSourceCoordinate,
  parseSourceRef,
  sourceCoordinate,
  sourceCoordinateKeyOf,
  sourceCorrelationId,
  sourceRef,
  sourceRefKeyOf,
  syncIdempotencyKey,
} from './source-ref';
import {
  adapterKind,
  providerObjectKind,
  providerObjectId,
  providerSystemId,
  providerVersion,
} from './identity';

// OFF-020 adapters-sdk — the source identity reference and its deterministic
// derivations. SourceRef is a provider object's full identity (coordinate +
// provider version); the version-less SourceCoordinate is the stable identity
// the mapping record binds to a canonical office EntityId. The derived sync
// idempotency key (per provider object version — shared across the sync and
// webhook paths) and source correlation id (per provider object lifecycle)
// are sha256 digests over the canonical JSON serialization: deterministic and
// pure, so same inputs always derive the same ids.

const KIND = adapterKind('fake-crm');
const SYSTEM = providerSystemId('fake-instance-01');
const TYPE = providerObjectKind('contact');

const ref = (objectId: string, version: string) =>
  sourceRef({
    adapterKind: KIND,
    systemId: SYSTEM,
    objectType: TYPE,
    objectId: providerObjectId(objectId),
    version: providerVersion(version),
  });

const REF_C1_V1 = ref('c-1', 'v1');
const REF_C1_V2 = ref('c-1', 'v2');
const REF_C2_V1 = ref('c-2', 'v1');

describe('source coordinate / source ref parsing (fail-closed)', () => {
  it('parses a valid coordinate and ref with strict keys', () => {
    const coordinate = parseSourceCoordinate(coordinateOf(REF_C1_V1));
    expect(coordinate.ok).toBe(true);
    if (coordinate.ok) {
      expect(coordinate.value.adapterKind).toBe('fake-crm');
      expect(coordinate.value.systemId).toBe('fake-instance-01');
      expect(coordinate.value.objectType).toBe('contact');
      expect(coordinate.value.objectId).toBe('c-1');
    }
    const parsed = parseSourceRef(REF_C1_V1);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.version).toBe('v1');
    expect(isSourceCoordinate(coordinateOf(REF_C1_V1))).toBe(true);
    expect(isSourceRef(REF_C1_V1)).toBe(true);
  });

  it('rejects non-objects, unknown keys, missing fields, and bad parts', () => {
    for (const raw of [
      null,
      'ref',
      7,
      {},
      { ...REF_C1_V1, extra: 'field' },
      { adapterKind: KIND, systemId: SYSTEM, objectType: TYPE }, // objectId missing
      { ...REF_C1_V1, objectId: 'has space' },
      { ...REF_C1_V1, version: '' },
    ]) {
      expect(parseSourceRef(raw).ok, `raw: ${JSON.stringify(raw)}`).toBe(false);
      expect(isSourceRef(raw)).toBe(false);
    }
    // A full ref is not a coordinate: `version` is an unknown key there.
    expect(parseSourceCoordinate(REF_C1_V1).ok).toBe(false);
    expect(isSourceCoordinate(REF_C1_V2)).toBe(false);
  });

  it('strips the version when projecting a ref to its coordinate', () => {
    const coordinate = coordinateOf(REF_C1_V2);
    expect(coordinate).toStrictEqual({
      adapterKind: KIND,
      systemId: SYSTEM,
      objectType: TYPE,
      objectId: providerObjectId('c-1'),
    });
    // Same object at a different version projects to the SAME coordinate.
    expect(coordinateOf(REF_C1_V1)).toStrictEqual(coordinate);
    // A different object projects to a different coordinate.
    expect(coordinateOf(REF_C2_V1)).not.toStrictEqual(coordinate);
  });

  it('throws loudly on the trusted composition path', () => {
    expect(() =>
      sourceCoordinate({
        adapterKind: KIND,
        systemId: SYSTEM,
        objectType: TYPE,
        objectId: providerObjectId('c-1'),
      }),
    ).not.toThrow();
    expect(() =>
      sourceRef({
        adapterKind: KIND,
        systemId: SYSTEM,
        objectType: TYPE,
        objectId: providerObjectId(''),
        version: providerVersion('v1'),
      }),
    ).toThrow(TypeError);
  });
});

describe('canonical key serialization', () => {
  it('serializes keys as unambiguous JSON arrays in fixed part order', () => {
    expect(sourceCoordinateKeyOf(coordinateOf(REF_C1_V1))).toBe(
      '["fake-crm","fake-instance-01","contact","c-1"]',
    );
    expect(sourceRefKeyOf(REF_C1_V1)).toBe(
      '["fake-crm","fake-instance-01","contact","c-1","v1"]',
    );
  });

  it('never collides across differing parts (JSON escaping forbids injection)', () => {
    const embedded = sourceRef({
      adapterKind: KIND,
      systemId: SYSTEM,
      objectType: TYPE,
      objectId: providerObjectId('x","y'),
      version: providerVersion('v1'),
    });
    // A coordinate whose objectId embeds quote/comma material still occupies
    // exactly one array slot — no delimiter injection can forge a collision
    // (the key is exactly the JSON serialization of the five-part array).
    expect(sourceRefKeyOf(embedded)).toBe(
      JSON.stringify(['fake-crm', 'fake-instance-01', 'contact', 'x","y', 'v1']),
    );
    expect(sourceRefKeyOf(embedded)).not.toBe(sourceRefKeyOf(REF_C1_V1));
    expect(sourceRefKeyOf(REF_C1_V1)).not.toBe(sourceRefKeyOf(REF_C1_V2));
    expect(sourceCoordinateKeyOf(coordinateOf(REF_C1_V1))).not.toBe(
      sourceCoordinateKeyOf(coordinateOf(REF_C2_V1)),
    );
  });
});

describe('deterministic derivations (A9-friendly digests)', () => {
  it('derives the same sync idempotency key for the same ref, every time', () => {
    const first = syncIdempotencyKey(REF_C1_V1);
    const second = syncIdempotencyKey(REF_C1_V1);
    expect(first).toBe(second);
    // The key is a valid contracts idempotency key by construction.
    expect(isIdempotencyKey(first)).toBe(true);
    expect(parseIdempotencyKey(first).ok).toBe(true);
  });

  it('derives a DIFFERENT key per provider object version', () => {
    // One command per provider object version: a moved version is a new key…
    expect(syncIdempotencyKey(REF_C1_V1)).not.toBe(syncIdempotencyKey(REF_C1_V2));
    // …and a different object is a different key at the same version.
    expect(syncIdempotencyKey(REF_C1_V1)).not.toBe(syncIdempotencyKey(REF_C2_V1));
  });

  it('derives the same correlation id for one object across ALL versions', () => {
    const chain = sourceCorrelationId(coordinateOf(REF_C1_V1));
    expect(sourceCorrelationId(coordinateOf(REF_C1_V2))).toBe(chain);
    expect(isCorrelationId(chain)).toBe(true);
    // Another provider object is another causal chain.
    expect(sourceCorrelationId(coordinateOf(REF_C2_V1))).not.toBe(chain);
  });

  it('keeps the idempotency key and correlation id distinct derivations', () => {
    expect(syncIdempotencyKey(REF_C1_V1)).not.toBe(sourceCorrelationId(coordinateOf(REF_C1_V1)));
  });
});
