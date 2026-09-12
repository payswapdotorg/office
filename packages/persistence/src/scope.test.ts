import { describe, expect, it } from 'vitest';
import { parseTenantId, parseProjectId, parseTimestamp } from '@office/contracts';
import type { Scope, TenantId, ProjectId, ParseResult } from '@office/contracts';
import { projectScopeMismatch, scopedSql } from './scope';

// OFF-004 scope helpers — the A12 construction guarantee in miniature: a
// statement can only be composed from a validated contracts Scope, the
// tenant predicate is bound first, and project scope adds the second
// boundary predicate. Pure composition tests; no database involved.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TENANT_B_OPAQUE = 'f9e8d7c6b5a493827160f5e4d3c2b1a0';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const PROJECT_B_OPAQUE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9';

const tenantAId = unwrap(parseTenantId(`office-tnt-v1-${TENANT_A_OPAQUE}`));
const tenantBId = unwrap(parseTenantId(`office-tnt-v1-${TENANT_B_OPAQUE}`));
const projectAId = unwrap(parseProjectId(`office-prj-v1-${PROJECT_A_OPAQUE}`));
const projectBId = unwrap(parseProjectId(`office-prj-v1-${PROJECT_B_OPAQUE}`));

const tenantAScope: Scope = { kind: 'tenant', tenantId: tenantAId };
const projectAScope: Scope = { kind: 'project', tenantId: tenantAId, projectId: projectAId };

describe('scopedSql (tenant/project scoped statement composition, A12)', () => {
  it('binds the tenant predicate first for tenant scope', () => {
    const statement = scopedSql(tenantAScope);
    expect(statement.scopePredicate).toBe('tenant_id = $1');
    expect(statement.values).toStrictEqual([tenantAId]);
  });

  it('binds tenant then project predicates for project scope', () => {
    const statement = scopedSql(projectAScope);
    expect(statement.scopePredicate).toBe('tenant_id = $1 AND project_id = $2');
    expect(statement.values).toStrictEqual([tenantAId, projectAId]);
  });

  it('binds further parameters after the scope values, in order', () => {
    const statement = scopedSql(projectAScope);
    const name = statement.bind('Tower Crane Erection');
    const version = statement.bind(3);
    const updated = statement.bind(unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')));
    expect([name, version, updated]).toStrictEqual(['$3', '$4', '$5']);
    expect(statement.values).toStrictEqual([tenantAId, projectAId, 'Tower Crane Erection', 3, '2026-09-12T10:15:31.000Z']);
  });

  it('keeps the scope identity on the statement', () => {
    expect(scopedSql(tenantAScope).scope).toStrictEqual(tenantAScope);
    expect(scopedSql(projectAScope).scope).toStrictEqual(projectAScope);
  });

  it('rejects an invalid scope loudly (never falls back to unscoped)', () => {
    const forged = { kind: 'tenant', tenantId: 'not-a-canonical-id' } as unknown as Scope;
    expect(() => scopedSql(forged)).toThrow(TypeError);
    const forgedProject = {
      kind: 'project',
      tenantId: tenantAId,
      projectId: 'office-tnt-v1-someothervalue99',
    } as unknown as Scope;
    expect(() => scopedSql(forgedProject)).toThrow(TypeError);
  });

  it('composes a full scoped statement deterministically', () => {
    const statement = scopedSql(tenantAScope);
    const idParam = statement.bind(projectBId);
    const sql = `SELECT * FROM projects WHERE ${statement.scopePredicate} AND project_id = ${idParam}`;
    expect(sql).toBe('SELECT * FROM projects WHERE tenant_id = $1 AND project_id = $2');
    expect(statement.values).toStrictEqual([tenantAId, projectBId]);
  });
});

describe('projectScopeMismatch (project second boundary, pre-SQL)', () => {
  it('returns null for tenant scope (any project of the tenant is addressable)', () => {
    expect(projectScopeMismatch(tenantAScope, projectBId)).toBeNull();
  });

  it('returns null when a project scope addresses its own project', () => {
    expect(projectScopeMismatch(projectAScope, projectAId)).toBeNull();
  });

  it('returns a typed unauthorized failure when a project scope addresses a different project', () => {
    const error = projectScopeMismatch(projectAScope, projectBId, { scope: projectAScope });
    expect(error).not.toBeNull();
    if (error === null) throw new Error('expected a scope violation');
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
    expect(error.message).toContain(String(projectAId));
    expect(error.message).toContain(String(projectBId));
    expect(error.scope).toStrictEqual(projectAScope);
  });

  it('never inspects the tenant of the addressed row — the SQL tenant predicate owns that boundary', () => {
    // A tenant-B project addressed from tenant A's project scope is still a
    // project-scope violation; the cross-tenant case is handled by the SQL
    // predicate and returns not-found, never data.
    const error = projectScopeMismatch(
      { kind: 'project', tenantId: tenantBId, projectId: projectBId },
      projectAId,
    );
    expect(error?.code).toBe('unauthorized');
  });
});

describe('scope types interop (contracts Scope is the repository scope)', () => {
  it('accepts both Scope variants built from branded ids', () => {
    const asScope = (tenantId: TenantId, projectId?: ProjectId): Scope =>
      projectId === undefined
        ? { kind: 'tenant', tenantId }
        : { kind: 'project', tenantId, projectId };
    expect(scopedSql(asScope(tenantBId)).values).toStrictEqual([tenantBId]);
    expect(scopedSql(asScope(tenantBId, projectBId)).values).toStrictEqual([tenantBId, projectBId]);
  });
});
