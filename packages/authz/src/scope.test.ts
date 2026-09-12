import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCorrelationId,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
} from '@office/contracts';
import type { EntityId, EntityKind, ParseResult, Scope } from '@office/contracts';
import type { DomainError, Result } from '@office/domain-kernel';
import { checkScopeCoversResource, isResourceScope, parseResourceScope, resourceScope } from './index';

// OFF-006 authz — resource scope and structural isolation tests.
// Deterministic: fixed ids and scopes.

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TENANT_B_OPAQUE = 'f9e8d7c6b5a493827160f5e4d3c2b1a0';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const PROJECT_B_OPAQUE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9';
const DOC_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';
const USER_OPAQUE = 'c3d4e5f60718293a4b5c6d7e8f9a1b2';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const failure = <T>(result: ParseResult<T>) => {
  if (result.ok) throw new Error('expected a parse failure');
  return result.error;
};

const denial = (result: Result<true, DomainError>): DomainError => {
  if (result.ok) throw new Error('expected a denial');
  return result.error;
};

const tenantA = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_A_OPAQUE })));
const tenantB = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_B_OPAQUE })));
const projectA = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_A_OPAQUE })));
const projectB = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_B_OPAQUE })));
const documentId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: DOC_OPAQUE })));
const userId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: USER_OPAQUE })));
const kindProject = unwrap(parseEntityKind('project'));
const kindDocument = unwrap(parseEntityKind('document'));

const tenantScopeA: Scope = { kind: 'tenant', tenantId: tenantA };
const tenantScopeB: Scope = { kind: 'tenant', tenantId: tenantB };
const projectScopeA1: Scope = { kind: 'project', tenantId: tenantA, projectId: projectA };
const projectScopeA2: Scope = { kind: 'project', tenantId: tenantA, projectId: projectB };

describe('ResourceScope parsing (fail-closed)', () => {
  it('parses a project-scoped resource with instance and owner ids', () => {
    const resource = unwrap(
      parseResourceScope({
        scope: { kind: 'project', tenantId: tenantA, projectId: projectA },
        resourceKind: 'document',
        resourceId: documentId,
        ownerId: userId,
      }),
    );
    expect(resource.scope).toStrictEqual(projectScopeA1);
    expect(resource.resourceKind).toBe(kindDocument);
    expect(resource.resourceId).toBe(documentId);
    expect(resource.ownerId).toBe(userId);
  });

  it('parses a tenant-scoped resource with null ids', () => {
    const resource = unwrap(
      parseResourceScope({
        scope: { kind: 'tenant', tenantId: tenantA },
        resourceKind: 'project',
        resourceId: null,
        ownerId: null,
      }),
    );
    expect(resource.scope).toStrictEqual(tenantScopeA);
    expect(resource.resourceKind).toBe(kindProject);
    expect(resource.resourceId).toBeNull();
    expect(resource.ownerId).toBeNull();
  });

  it('rejects non-object input', () => {
    for (const bad of [null, 42, 'resource', [], true]) {
      expect(parseResourceScope(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects unknown keys (strict shape)', () => {
    const error = failure(
      parseResourceScope({
        scope: tenantScopeA,
        resourceKind: 'project',
        resourceId: null,
        ownerId: null,
        tenant: tenantA,
      }),
    );
    expect(error.code).toBe('unknown-field');
    expect(error.path).toBe('tenant');
  });

  it('nests scope failures under the scope field', () => {
    const error = failure(
      parseResourceScope({
        scope: { kind: 'tenant', tenantId: 'not-a-tenant' },
        resourceKind: 'project',
        resourceId: null,
        ownerId: null,
      }),
    );
    expect(error.path).toBe('scope.tenantId');
  });

  it('rejects missing required fields', () => {
    const error = failure(
      parseResourceScope({ resourceKind: 'project', resourceId: null, ownerId: null }),
    );
    expect(error.code).toBe('missing-field');
    expect(error.path).toBe('scope');
  });

  it('rejects invalid resource kinds and non-null invalid ids', () => {
    const kind = failure(
      parseResourceScope({
        scope: tenantScopeA,
        resourceKind: 'Not-A-Kind',
        resourceId: null,
        ownerId: null,
      }),
    );
    expect(kind.path).toBe('resourceKind');
    const resourceId = failure(
      parseResourceScope({
        scope: tenantScopeA,
        resourceKind: 'project',
        resourceId: 'nope',
        ownerId: null,
      }),
    );
    expect(resourceId.path).toBe('resourceId');
    const ownerId = failure(
      parseResourceScope({
        scope: tenantScopeA,
        resourceKind: 'project',
        resourceId: null,
        ownerId: 7,
      }),
    );
    expect(ownerId.path).toBe('ownerId');
  });

  it('isResourceScope guards structurally valid resources', () => {
    expect(
      isResourceScope({ scope: tenantScopeA, resourceKind: 'project', resourceId: null, ownerId: null }),
    ).toBe(true);
    expect(isResourceScope({ scope: tenantScopeA, resourceKind: 'project' })).toBe(false);
    expect(isResourceScope(null)).toBe(false);
  });

  it('resourceScope() composes trusted values and validates loudly', () => {
    const resource = resourceScope({
      scope: projectScopeA1,
      resourceKind: kindDocument,
      resourceId: documentId,
    });
    expect(resource.scope).toStrictEqual(projectScopeA1);
    expect(resource.ownerId).toBeNull();
    expect(() =>
      resourceScope({ scope: projectScopeA1, resourceKind: 'Bad-Kind' as EntityKind }),
    ).toThrow(TypeError);
    expect(() =>
      resourceScope({ scope: { kind: 'tenant' } as unknown as Scope, resourceKind: kindProject }),
    ).toThrow(TypeError);
    expect(() =>
      resourceScope({
        scope: tenantScopeA,
        resourceKind: kindProject,
        resourceId: 'nope' as EntityId,
      }),
    ).toThrow(TypeError);
  });
});

describe('structural scope coverage (freeze A12)', () => {
  const projectResourceA1 = resourceScope({ scope: projectScopeA1, resourceKind: kindProject });
  const projectResourceA2 = resourceScope({ scope: projectScopeA2, resourceKind: kindProject });
  const tenantResourceA = resourceScope({ scope: tenantScopeA, resourceKind: kindProject });
  const tenantResourceB = resourceScope({ scope: tenantScopeB, resourceKind: kindProject });

  it('covers same-tenant, same-project resources', () => {
    expect(checkScopeCoversResource(projectScopeA1, projectResourceA1)).toStrictEqual({
      ok: true,
      value: true,
    });
  });

  it('covers tenant-wide resources from project scope (same tenant)', () => {
    expect(checkScopeCoversResource(projectScopeA1, tenantResourceA).ok).toBe(true);
  });

  it('covers project-scoped resources from tenant scope (same tenant)', () => {
    expect(checkScopeCoversResource(tenantScopeA, projectResourceA1).ok).toBe(true);
  });

  it('denies cross-tenant access with a typed tenant-scope-violation', () => {
    const error = denial(checkScopeCoversResource(tenantScopeA, tenantResourceB));
    expect(error.kind).toBe('domain-error');
    expect(error.code).toBe('unauthorized');
    expect(error.message).toBe(
      `request tenant ${tenantA} cannot access a resource owned by tenant ${tenantB}`,
    );
    expect(error.details).toStrictEqual([
      {
        code: 'tenant-scope-violation',
        message: `request tenant ${tenantA}, resource tenant ${tenantB}`,
        path: null,
      },
    ]);
  });

  it('denies cross-project access within a tenant with a typed project-scope-violation', () => {
    const error = denial(checkScopeCoversResource(projectScopeA1, projectResourceA2));
    expect(error.code).toBe('unauthorized');
    expect(error.message).toBe(
      `request project ${projectA} cannot access a resource bound to project ${projectB}`,
    );
    expect(error.details).toStrictEqual([
      {
        code: 'project-scope-violation',
        message: `request project ${projectA}, resource project ${projectB}`,
        path: null,
      },
    ]);
  });

  it('tenant mismatch dominates a project mismatch (tenant is checked first)', () => {
    const foreign = resourceScope({
      scope: { kind: 'project', tenantId: tenantB, projectId: projectB },
      resourceKind: kindProject,
    });
    const error = denial(checkScopeCoversResource(projectScopeA1, foreign));
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('denials carry the request scope, never the foreign resource scope', () => {
    const error = denial(checkScopeCoversResource(projectScopeA1, tenantResourceB));
    expect(error.scope).toStrictEqual(projectScopeA1);
  });

  it('attaches the supplied correlation id and defaults the scope to the request scope', () => {
    const correlationId = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));
    const error = denial(
      checkScopeCoversResource(tenantScopeA, tenantResourceB, { correlationId }),
    );
    expect(error.correlationId).toBe(correlationId);
    expect(error.scope).toStrictEqual(tenantScopeA);
  });
});
