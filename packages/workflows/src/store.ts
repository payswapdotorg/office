// Office workflow engine — the in-memory aggregate store (OFF-016).
//
// This package is PURE DOMAIN (no SQL, no migrations, no repository layer):
// WorkflowStore is the aggregate-keeper PORT the command handlers mutate
// through — the in-memory implementation below is the deterministic
// reference (tests, pure in-memory composition), and a persistence-backed
// implementation can satisfy the same port later without touching the
// aggregate or command layers.
//
// Scope isolation (freeze A12), mirroring the reference repositories of
// @office/persistence and the landed domain packages exactly:
//   * every find* takes a validated contracts Scope — there is no unscoped
//     entry point;
//   * a foreign tenant's aggregate is INVISIBLE: typed not-found, no
//     existence oracle (the failure names the sought id, never confirming
//     or denying a foreign tenant's row);
//   * the project second boundary: a project-scoped lookup may only see its
//     own project's aggregates — anything else is a typed unauthorized
//     project-scope-violation (same tenant, wrong project);
//   * a tenant-scoped lookup sees every aggregate of its tenant;
//   * saves are keyed by canonical id and keep first-insertion order (the
//     deterministic iteration the acceptance suites rely on).
import { domainError, entityNotFound, fail, ok, projectScopeViolation } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { EntityId, EntityKind, ProjectId, Scope } from '@office/contracts';
import type { WorkflowDefinitionState, WorkflowInstanceState } from './state';
import { WORKFLOW_DEFINITION_KIND, WORKFLOW_INSTANCE_KIND } from './state';

/**
 * The aggregate-keeper port of the workflow engine. Save semantics: a save of
 * a state whose canonical id is absent inserts it; a save of a present id
 * replaces it (the optimistic-concurrency guard lives in the command
 * handlers, which only ever save invariant-checked NEXT states).
 */
export interface WorkflowStore {
  /** Load a workflow definition by id within the scope (A12 visibility rules). */
  findDefinition(
    scope: Scope,
    definitionId: EntityId,
    context?: DomainErrorContext,
  ): Result<WorkflowDefinitionState, DomainError>;
  /** Every definition of one key within the scope, in version order (A12). */
  findDefinitionsByKey(
    scope: Scope,
    key: string,
    context?: DomainErrorContext,
  ): Result<readonly WorkflowDefinitionState[], DomainError>;
  /** Insert or replace a workflow definition state. */
  saveDefinition(state: WorkflowDefinitionState): void;

  /** Load a workflow instance by id within the scope (A12 visibility rules). */
  findInstance(
    scope: Scope,
    instanceId: EntityId,
    context?: DomainErrorContext,
  ): Result<WorkflowInstanceState, DomainError>;
  /** Insert or replace a workflow instance state. */
  saveInstance(state: WorkflowInstanceState): void;

  /** Every definition, in first-insertion order (tests, version computation). */
  definitions(): readonly WorkflowDefinitionState[];
  /** Every instance, in first-insertion order (tests). */
  instances(): readonly WorkflowInstanceState[];
}

/** The typed second-boundary denial of a project-scoped lookup (A12). */
const projectScopeDenial = (
  lookupScope: Scope & { readonly kind: 'project' },
  aggregateProjectId: ProjectId,
  context?: DomainErrorContext,
): DomainError =>
  projectScopeViolation(
    { commandProjectId: lookupScope.projectId, aggregateProjectId },
    {
      scope: context?.scope ?? lookupScope,
      correlationId: context?.correlationId ?? null,
    },
  );

/** Denial context resolution for the not-found path (A12: the request scope, never the foreign one). */
const notFoundContext = (scope: Scope, context?: DomainErrorContext): DomainErrorContext => ({
  scope: context?.scope ?? scope,
  correlationId: context?.correlationId ?? null,
});

/** The fail-closed failure of a definitions-by-key lookup with an invalid key. */
const invalidDefinitionKey = (key: string, context: DomainErrorContext): DomainError =>
  domainError(
    'invariant-violation',
    `workflow definition key '${key}' is not a valid kebab-case key`,
    [{ code: 'invalid-definition-key', message: `key '${key}'`, path: 'key' }],
    context,
  );

const DEFINITION_KEY_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/**
 * Create the deterministic in-memory WorkflowStore (the reference
 * implementation of the port).
 */
export function createInMemoryWorkflowStore(): WorkflowStore {
  const definitionsById = new Map<EntityId, WorkflowDefinitionState>();
  const instancesById = new Map<EntityId, WorkflowInstanceState>();

  /**
   * One scoped by-id load, applying the A12 visibility rules: absent or
   * foreign-tenant → typed not-found (invisibility, no existence oracle);
   * same tenant, wrong project under a project-scoped lookup → typed
   * unauthorized project-scope-violation.
   */
  const loadScoped = <S extends { readonly entityId: EntityId; readonly scope: Scope }>(
    byId: Map<EntityId, S>,
    entityKind: EntityKind,
    scope: Scope,
    entityId: EntityId,
    context?: DomainErrorContext,
  ): Result<S, DomainError> => {
    const found = byId.get(entityId);
    if (found === undefined || found.scope.tenantId !== scope.tenantId) {
      return fail(entityNotFound({ entityKind, entityId }, notFoundContext(scope, context)));
    }
    if (
      scope.kind === 'project' &&
      found.scope.kind === 'project' &&
      scope.projectId !== found.scope.projectId
    ) {
      return fail(projectScopeDenial(scope, found.scope.projectId, context));
    }
    return ok(found);
  };

  return {
    findDefinition: (scope, definitionId, context) =>
      loadScoped(definitionsById, WORKFLOW_DEFINITION_KIND, scope, definitionId, context),

    findDefinitionsByKey: (scope, key, context) => {
      if (!DEFINITION_KEY_PATTERN.test(key)) {
        return fail(invalidDefinitionKey(key, context ?? { scope }));
      }
      const matching = [...definitionsById.values()].filter(
        (definition) =>
          definition.key === key &&
          definition.scope.tenantId === scope.tenantId &&
          (scope.kind !== 'project' ||
            definition.scope.kind !== 'project' ||
            definition.scope.projectId === scope.projectId),
      );
      matching.sort((a, b) => a.definitionVersion - b.definitionVersion);
      return ok(matching);
    },
    saveDefinition: (state) => {
      definitionsById.set(state.entityId, state);
    },

    findInstance: (scope, instanceId, context) =>
      loadScoped(instancesById, WORKFLOW_INSTANCE_KIND, scope, instanceId, context),
    saveInstance: (state) => {
      instancesById.set(state.entityId, state);
    },

    definitions: () => [...definitionsById.values()],
    instances: () => [...instancesById.values()],
  };
}
