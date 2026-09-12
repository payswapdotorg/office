import { describe, expect, it } from 'vitest';
import {
  formatProjectId,
  formatTenantId,
  isScope,
  parseProjectId,
  parseScope,
  parseTenantId,
} from './index';
import type { ParseResult, Scope } from './index';

// OFF-002 contracts — scope tests. Deterministic: fixed ids, no clock.

const TENANT_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PROJECT_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const roundTrip = (value: unknown, parse: (raw: unknown) => ParseResult<unknown>): void => {
  const parsed = parse(JSON.parse(JSON.stringify(value)) as unknown);
  if (!parsed.ok) {
    throw new Error(`round-trip parse failed: ${JSON.stringify(parsed.error)}`);
  }
  expect(parsed.value).toStrictEqual(value);
};

const tenantId = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_OPAQUE })));
const projectId = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_OPAQUE })));

const tenantScope: Scope = { kind: 'tenant', tenantId };
const projectScope: Scope = { kind: 'project', tenantId, projectId };

describe('scope (freeze A12)', () => {
  it('round-trips tenant scope through JSON', () => {
    roundTrip(tenantScope, parseScope);
  });

  it('round-trips project scope through JSON', () => {
    roundTrip(projectScope, parseScope);
  });

  it('parses both variants and narrows the union', () => {
    const tenant = unwrap(parseScope({ kind: 'tenant', tenantId }));
    expect(tenant.kind).toBe('tenant');
    if (tenant.kind === 'tenant') {
      expect(tenant.tenantId).toBe(tenantId);
    } else {
      throw new Error('expected tenant scope');
    }
    const project = unwrap(parseScope({ kind: 'project', tenantId, projectId }));
    expect(project.kind).toBe('project');
    if (project.kind === 'project') {
      expect(project.projectId).toBe(projectId);
    } else {
      throw new Error('expected project scope');
    }
  });

  it('type-guards scope values', () => {
    expect(isScope(tenantScope)).toBe(true);
    expect(isScope(projectScope)).toBe(true);
    expect(isScope(42)).toBe(false);
    expect(isScope({ kind: 'tenant' })).toBe(false);
  });

  it('rejects malformed shapes', () => {
    const malformed = [42, null, [], 'tenant', {}, { kind: 'tenant' }];
    for (const candidate of malformed) {
      expect(parseScope(candidate).ok, `candidate: ${JSON.stringify(candidate)}`).toBe(false);
    }
  });

  it('rejects unknown scope kinds at the kind field', () => {
    const result = parseScope({ kind: 'organization', tenantId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('kind');
    }
  });

  it('rejects unknown fields (strict shapes)', () => {
    const result = parseScope({ kind: 'tenant', tenantId, projectId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-field');
      expect(result.error.path).toBe('projectId');
    }
  });

  it('rejects invalid tenant ids with nested paths', () => {
    const result = parseScope({ kind: 'project', tenantId: '12345', projectId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('tenantId');
    }
  });

  it('requires projectId on project scope', () => {
    const result = parseScope({ kind: 'project', tenantId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing-field');
      expect(result.error.path).toBe('projectId');
    }
  });
});
