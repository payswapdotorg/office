// Office persistence — tenant/project scoped query helpers (OFF-004, A12).
//
// THE construction guarantee of this package: a repository statement can only
// be composed by starting from a validated contracts Scope, and the helper
// below then (a) binds the tenant id as the FIRST parameter of every
// statement and (b) hands back a WHERE predicate that filters on the
// `tenant_id` column — plus the `project_id` column whenever the scope is
// project-scoped. An unscoped statement cannot be built through this API, so
// every SQL text a repository emits carries its scope by construction.
//
// This is a parameter binder, not a query builder (lead-directed stack
// decision): the SQL itself stays hand-written and fully visible in the
// repository modules.
import { isScope } from '@office/contracts';
import type { ProjectId, Scope, TenantId } from '@office/contracts';
import { projectScopeViolation } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext } from '@office/domain-kernel';
import type { SqlValue } from './sql';

/** Scope column every tenant-owned table must carry as its first scope column. */
export const TENANT_SCOPE_COLUMN = 'tenant_id';
/** Scope column of project-bound tables/entities (A12 second boundary). */
export const PROJECT_SCOPE_COLUMN = 'project_id';

/**
 * A statement composer bound to one validated tenant/project scope. The
 * tenant predicate is bound before any other parameter; every further value
 * is bound through {@link ScopedSql.bind} so placeholder numbering always
 * matches the bound values exactly.
 */
export interface ScopedSql {
  /** The validated scope this statement is executing under. */
  readonly scope: Scope;
  /**
   * WHERE fragment scoping the statement: `tenant_id = $1` for tenant scope,
   * `tenant_id = $1 AND project_id = $2` for project scope.
   */
  readonly scopePredicate: string;
  /** Bind the next statement parameter and return its `$n` placeholder. */
  readonly bind: (value: SqlValue) => string;
  /** All bound values, in `$n` order (scope values first). */
  readonly values: readonly SqlValue[];
}

/**
 * Open a scoped statement for `scope`. Trusted path: `scope` must already be
 * a structurally valid contracts Scope — anything else is a loud TypeError,
 * never a silent fallback to an unscoped statement.
 */
export function scopedSql(scope: Scope): ScopedSql {
  if (!isScope(scope)) {
    throw new TypeError(`scopedSql requires a valid contracts Scope: ${JSON.stringify(scope)}`);
  }
  const values: SqlValue[] = [scope.tenantId];
  let scopePredicate = `${TENANT_SCOPE_COLUMN} = $1`;
  if (scope.kind === 'project') {
    values.push(scope.projectId);
    scopePredicate += ` AND ${PROJECT_SCOPE_COLUMN} = $2`;
  }
  return {
    scope,
    scopePredicate,
    bind: (value: SqlValue): string => {
      values.push(value);
      return `$${values.length}`;
    },
    get values(): readonly SqlValue[] {
      return values;
    },
  };
}

/**
 * Pre-SQL check of the project second boundary (A12): when a command's scope
 * is project-scoped, it may only address that same project. Returns the typed
 * `unauthorized` DomainError on a mismatch, or null when the scope may
 * proceed (tenant scope addresses any project of its tenant; project scope
 * addresses exactly its own project). The tenant boundary is always enforced
 * in the SQL itself via {@link scopedSql}.
 */
export function projectScopeMismatch(
  scope: Scope,
  projectId: ProjectId,
  context?: DomainErrorContext,
): DomainError | null {
  if (scope.kind !== 'project') return null;
  if (scope.projectId === projectId) return null;
  return projectScopeViolation(
    { commandProjectId: scope.projectId, aggregateProjectId: projectId },
    context,
  );
}

/** Narrow a contracts Scope to its tenant id (every scope carries one, A12). */
export const tenantIdOf = (scope: Scope): TenantId => scope.tenantId;
