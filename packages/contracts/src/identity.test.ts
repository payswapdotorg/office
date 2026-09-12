import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  isEntityId,
  isEntityKind,
  isProjectId,
  isTenantId,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
} from './index';
import type { EntityId, ParseResult, TenantId } from './index';

// OFF-002 contracts — identity tests. Deterministic: fixed opaque parts, no
// generation, no clock.

const OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const OPAQUE_ALT = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const entityId = `office-ent-v1-${OPAQUE}`;
const tenantIdString = `office-tnt-v1-${OPAQUE_ALT}`;
const projectIdString = `office-prj-v1-${OPAQUE}`;
const tenantId: TenantId = unwrap(parseTenantId(tenantIdString));

describe('canonical ids (identity)', () => {
  it('formats v1 ids with kind codes for every id type', () => {
    expect(formatEntityId({ version: 'v1', opaque: OPAQUE })).toBe(entityId);
    expect(formatTenantId({ version: 'v1', opaque: OPAQUE_ALT })).toBe(tenantIdString);
    expect(formatProjectId({ version: 'v1', opaque: OPAQUE })).toBe(projectIdString);
  });

  it('round-trips every id type through parse', () => {
    expect(unwrap(parseEntityId(entityId))).toBe(entityId);
    expect(unwrap(parseTenantId(tenantIdString))).toBe(tenantIdString);
    expect(unwrap(parseProjectId(projectIdString))).toBe(projectIdString);
  });

  it('serializes ids as plain strings (brands are compile-time only)', () => {
    expect(JSON.parse(JSON.stringify(entityId))).toBe(entityId);
    expect(JSON.parse(JSON.stringify(tenantId))).toBe(tenantIdString);
  });

  it('accepts tenant and project kind codes as EntityIds (A1 graph entities)', () => {
    expect(unwrap(parseEntityId(tenantIdString))).toBe(tenantIdString);
    expect(unwrap(parseEntityId(projectIdString))).toBe(projectIdString);
  });

  it('type-guards valid and invalid values', () => {
    expect(isEntityId(entityId)).toBe(true);
    expect(isEntityId(tenantIdString)).toBe(true);
    expect(isTenantId(tenantIdString)).toBe(true);
    expect(isProjectId(projectIdString)).toBe(true);
    expect(isEntityId('12345')).toBe(false);
    expect(isTenantId(entityId)).toBe(false);
    expect(isProjectId(tenantIdString)).toBe(false);
    expect(isTenantId(42)).toBe(false);
    expect(isProjectId(null)).toBe(false);
  });

  it('rejects provider-shaped strings as canonical ids', () => {
    const providerShaped = [
      '12345',
      'PRJ-001',
      '550e8400-e29b-41d4-a716-446655440000',
      'ext-98765',
      'vendor:project:42',
      '',
      'office',
      'office-ent-abc',
      'office-ent-v1',
    ];
    for (const candidate of providerShaped) {
      expect(parseEntityId(candidate).ok, `candidate: ${candidate}`).toBe(false);
      expect(parseTenantId(candidate).ok, `candidate: ${candidate}`).toBe(false);
      expect(parseProjectId(candidate).ok, `candidate: ${candidate}`).toBe(false);
    }
  });

  it('rejects malformed opaque parts', () => {
    const badOpaques = [
      'UPPERCASE1234567',
      'short',
      'spaces inside123',
      'a'.repeat(65),
      'pdashes-inside-99',
    ];
    for (const opaque of badOpaques) {
      expect(parseEntityId(`office-ent-v1-${opaque}`).ok, `opaque: ${opaque}`).toBe(false);
    }
  });

  it('fails closed on unknown id versions with typed errors', () => {
    const result = parseEntityId(`office-ent-v2-${OPAQUE}`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-id-version');
      expect(result.error.path).toBe('');
      expect(result.error.received).toBe('string "v2"');
    }
  });

  it('rejects cross-kind id strings for the subtypes', () => {
    expect(parseTenantId(entityId).ok).toBe(false);
    expect(parseTenantId(projectIdString).ok).toBe(false);
    expect(parseProjectId(entityId).ok).toBe(false);
    expect(parseProjectId(tenantIdString).ok).toBe(false);
  });

  it('rejects non-strings with typed errors', () => {
    const result = parseEntityId(42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-type');
      expect(result.error.received).toBe('number 42');
    }
  });

  it('format throws TypeError on invalid parts (trusted path is loud, not silent)', () => {
    expect(() => formatEntityId({ version: 'v1', opaque: 'short' })).toThrow(TypeError);
    expect(() => formatEntityId({ version: 'v1', opaque: 'UPPERCASE1234567' })).toThrow(TypeError);
    expect(() => formatTenantId({ version: 'v1', opaque: `dash-inside-${OPAQUE}` })).toThrow(
      TypeError,
    );
  });

  it('brands ids nominally at compile time', () => {
    const asEntity: EntityId = tenantId; // TenantId is a subtype of EntityId (A1)
    expect(asEntity).toBe(tenantIdString);

    // The assignment above is compile-time only: the runtime string is
    // unchanged and still validates as a tenant id.
    // @ts-expect-error an EntityId is branded and never assignable to TenantId
    const asTenant: TenantId = asEntity;
    expect(isTenantId(asTenant)).toBe(true);

    // @ts-expect-error a plain string is not assignable to a branded id
    const fromPlain: EntityId = entityId;
    expect(fromPlain).toBe(entityId);
  });

  it('parses and guards entity kinds', () => {
    expect(unwrap(parseEntityKind('project'))).toBe('project');
    expect(unwrap(parseEntityKind('change-order'))).toBe('change-order');
    expect(isEntityKind('document')).toBe(true);
    const badKinds = [
      'Project',
      'vendor:project',
      '-leading',
      'trailing-',
      'double--dash',
      '',
      'a'.repeat(65),
      42,
      null,
    ];
    for (const kind of badKinds) {
      expect(parseEntityKind(kind).ok, `kind: ${String(kind)}`).toBe(false);
    }
  });
});
