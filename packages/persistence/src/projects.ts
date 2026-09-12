// Office persistence — project metadata repository (OFF-004).
//
// THE reference repository of the persistence foundation, over the
// `projects` table. Scope isolation is structural (freeze A12):
//
//   * every method takes a validated contracts `Scope` as its scope of
//     execution — there is no unscoped entry point;
//   * every statement is composed through `scopedSql(scope)`, which binds
//     `tenant_id` (and `project_id` under project scope) into the WHERE
//     clause, so tenant A can never read or write tenant B's rows: a foreign
//     row is simply not there (typed not-found), never leaked;
//   * the project second boundary is checked before SQL: a project-scoped
//     call addressing a different project is a typed unauthorized failure;
//   * writes are guarded by optimistic concurrency (`WHERE ... AND
//     version = $expected`), so a stale version is a typed
//     concurrency-conflict and never a silent overwrite.
import type { ProjectId, Scope, TenantId, Timestamp } from '@office/contracts';
import {
  INITIAL_AGGREGATE_VERSION,
  concurrencyConflict,
  domainError,
  entityNotFound,
  fail,
  ok,
} from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { driverErrorInfo } from './failure';
import {
  readAggregateVersion,
  readJsonObject,
  readProjectId,
  readTenantId,
  readText,
  readTimestamp,
  toDate,
  entityKindOf,
} from './rows';
import { projectScopeMismatch, scopedSql } from './scope';
import type { SqlExecutor } from './sql';

/** A project metadata row, decoded into canonical types. */
export interface ProjectRecord {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly version: AggregateVersion;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** Extension metadata (A2: JSONB reserved for extension metadata only). */
  readonly extensionMetadata: Readonly<Record<string, unknown>>;
}

/** Input of a project insert; the canonical id is issued upstream (injected). */
export interface NewProject {
  readonly projectId: ProjectId;
  readonly name: string;
  /** Optional extension metadata (defaults to the empty object). */
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
  readonly now: Timestamp;
}

/** Field changes for an update; at least one field must be present. */
export interface ProjectChanges {
  readonly name?: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

/**
 * Project metadata repository: every read and write executes under an
 * explicit tenant (or tenant+project) scope, by construction.
 */
export interface ProjectsRepository {
  /**
   * Insert a project owned by the scope's tenant. The tenant ownership of
   * the row comes from the scope itself, never from a caller-supplied
   * column. Unknown tenant → typed not-found; duplicate canonical id →
   * typed invariant-violation.
   */
  insert(
    db: SqlExecutor,
    scope: Scope,
    input: NewProject,
  ): Promise<Result<ProjectRecord, DomainError>>;
  /**
   * Load the addressed project within the scope. Cross-tenant → typed
   * not-found (the row is not visible); project scope addressing another
   * project → typed unauthorized.
   */
  findById(
    db: SqlExecutor,
    scope: Scope,
    projectId: ProjectId,
  ): Promise<Result<ProjectRecord, DomainError>>;
  /**
   * List the projects visible to the scope: every project of the scope's
   * tenant under tenant scope; exactly the scoped project under project
   * scope (the second boundary applied at row level).
   */
  list(db: SqlExecutor, scope: Scope): Promise<Result<readonly ProjectRecord[], DomainError>>;
  /**
   * Update the addressed project with optimistic concurrency: a stale
   * expected version is a typed concurrency-conflict; a missing row is a
   * typed not-found. `changes` must carry at least one field (loud
   * TypeError otherwise — trusted-path programming error).
   */
  update(
    db: SqlExecutor,
    scope: Scope,
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
    changes: ProjectChanges,
    now: Timestamp,
  ): Promise<Result<ProjectRecord, DomainError>>;
}

const PROJECT_COLUMNS =
  'tenant_id, project_id, name, version, created_at, updated_at, extension_metadata';
const PROJECT_KIND = entityKindOf('project');

const mapProjectRow = (row: Record<string, unknown>): ProjectRecord => ({
  tenantId: readTenantId(row, 'projects'),
  projectId: readProjectId(row, 'projects'),
  name: readText(row, 'projects', 'name'),
  version: readAggregateVersion(row, 'projects'),
  createdAt: readTimestamp(row, 'projects', 'created_at'),
  updatedAt: readTimestamp(row, 'projects', 'updated_at'),
  extensionMetadata: readJsonObject(row, 'projects', 'extension_metadata'),
});

/** Require at least one change field (trusted-path check). */
const requireChanges = (changes: ProjectChanges): void => {
  if (changes.name === undefined && changes.extensionMetadata === undefined) {
    throw new TypeError('project update requires at least one change field');
  }
};

/** Create the project metadata repository. */
export const createProjectsRepository = (): ProjectsRepository => {
  const selectProject = async (
    db: SqlExecutor,
    scope: Scope,
    projectId: ProjectId,
  ): Promise<ProjectRecord | null> => {
    const statement = scopedSql(scope);
    const idParam = statement.bind(projectId);
    const result = await db.query(
      `SELECT ${PROJECT_COLUMNS} FROM projects
       WHERE ${statement.scopePredicate} AND project_id = ${idParam}`,
      statement.values,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapProjectRow(row);
  };

  return {
    insert: async (db, scope, input) => {
      const scopeError = projectScopeMismatch(scope, input.projectId, { scope });
      if (scopeError !== null) return fail(scopeError);
      try {
        // tenant_id is bound from the SCOPE, never from the input — the row
        // is owned by the executing tenant by construction.
        const result = await db.query(
          `INSERT INTO projects (tenant_id, project_id, name, version, created_at, updated_at, extension_metadata)
           VALUES ($1, $2, $3, $4, $5, $5, $6)
           RETURNING ${PROJECT_COLUMNS}`,
          [
            scope.tenantId,
            input.projectId,
            input.name,
            INITIAL_AGGREGATE_VERSION,
            toDate(input.now),
            input.extensionMetadata ?? {},
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          return fail(
            domainError(
              'invariant-violation',
              `project insert returned no row for ${input.projectId}`,
              [{ code: 'project-insert-no-row', message: input.projectId, path: null }],
            ),
          );
        }
        return ok(mapProjectRow(row));
      } catch (error) {
        const { code, constraint } = driverErrorInfo(error);
        if (code === '23505' && constraint === 'projects_pkey') {
          return fail(
            domainError(
              'invariant-violation',
              `canonical project id already exists: ${input.projectId}`,
              [{ code: 'project-id-already-exists', message: input.projectId, path: 'projectId' }],
            ),
          );
        }
        if (code === '23503' && constraint === 'projects_tenant_id_fkey') {
          return fail(
            domainError(
              'not-found',
              `tenant ${scope.tenantId} not found: cannot create project ${input.projectId}`,
              [{ code: 'tenant-not-found', message: scope.tenantId, path: 'tenantId' }],
              { scope },
            ),
          );
        }
        throw error;
      }
    },

    findById: async (db, scope, projectId) => {
      const scopeError = projectScopeMismatch(scope, projectId, { scope });
      if (scopeError !== null) return fail(scopeError);
      const project = await selectProject(db, scope, projectId);
      if (project === null) {
        return fail(
          entityNotFound({ entityKind: PROJECT_KIND, entityId: projectId }, { scope }),
        );
      }
      return ok(project);
    },

    list: async (db, scope) => {
      const statement = scopedSql(scope);
      const result = await db.query(
        `SELECT ${PROJECT_COLUMNS} FROM projects
         WHERE ${statement.scopePredicate}
         ORDER BY created_at DESC, project_id ASC`,
        statement.values,
      );
      return ok(result.rows.map(mapProjectRow));
    },

    update: async (db, scope, projectId, expectedVersion, changes, now) => {
      requireChanges(changes);
      const scopeError = projectScopeMismatch(scope, projectId, { scope });
      if (scopeError !== null) return fail(scopeError);

      const statement = scopedSql(scope);
      const idParam = statement.bind(projectId);
      const versionParam = statement.bind(expectedVersion);
      const nowParam = statement.bind(toDate(now));
      const assignments: string[] = [];
      if (changes.name !== undefined) {
        assignments.push(`name = ${statement.bind(changes.name)}`);
      }
      if (changes.extensionMetadata !== undefined) {
        assignments.push(`extension_metadata = ${statement.bind(changes.extensionMetadata)}`);
      }
      const result = await db.query(
        `UPDATE projects
         SET ${assignments.join(', ')}, version = version + 1, updated_at = ${nowParam}
         WHERE ${statement.scopePredicate} AND project_id = ${idParam} AND version = ${versionParam}
         RETURNING ${PROJECT_COLUMNS}`,
        statement.values,
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return ok(mapProjectRow(row));
      }
      // Zero affected rows: absent (or foreign-tenant) row vs. stale version —
      // the scoped re-read classifies exactly.
      const current = await selectProject(db, scope, projectId);
      if (current === null) {
        return fail(
          entityNotFound({ entityKind: PROJECT_KIND, entityId: projectId }, { scope }),
        );
      }
      return fail(
        concurrencyConflict(
          {
            entityKind: PROJECT_KIND,
            entityId: projectId,
            expectedVersion,
            actualVersion: current.version,
          },
          { scope },
        ),
      );
    },
  };
};
