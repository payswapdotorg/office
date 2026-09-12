// Office authz — resource scope & structural isolation (OFF-006).
//
// ResourceScope: WHAT is being accessed — the resource's owning tenant/
// project Scope (freeze A12), its canonical kind, and optional instance/
// owner identity. AuthorizationContext (context.ts) carries WHO is asking
// and under which Scope; policy.ts evaluates rules between the two.
//
// Structural isolation: checkScopeCoversResource proves the request scope
// covers the resource scope BEFORE any policy rule is consulted — a
// different tenant, or a different project within the same tenant, is a
// typed 'unauthorized' denial no policy can override. This mirrors (and
// layers on) the domain kernel's checkScopeCovers backstop: the kernel
// guards command execution over aggregates; authz guards every read/write
// path. Denials carry the REQUEST scope (never the foreign resource's).
import {
  isEntityId,
  isEntityKind,
  isScope,
  parseEntityId,
  parseEntityKind,
  parseFail,
  parseOk,
  parseScope,
} from '@office/contracts';
import type { EntityId, EntityKind, ParseResult, Scope } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';

/**
 * What is being accessed: the resource's owning tenant/project scope plus
 * its canonical identity. `resourceId`/`ownerId` are null exactly when the
 * access is not bound to a specific resource instance or owner.
 */
export interface ResourceScope {
  /** Owning tenant/project scope of the resource (freeze A12). */
  readonly scope: Scope;
  /** Canonical entity kind of the resource, e.g. 'project', 'document'. */
  readonly resourceKind: EntityKind;
  /** The specific resource instance, or null for kind-level access. */
  readonly resourceId: EntityId | null;
  /** The resource's owning actor (e.g. document author), or null. */
  readonly ownerId: EntityId | null;
}

/** Shape description used in parse failures. */
export const RESOURCE_SCOPE_GRAMMAR =
  'ResourceScope: { scope, resourceKind, resourceId: EntityId | null, ownerId: EntityId | null }';

const RESOURCE_SCOPE_KEYS = ['scope', 'resourceKind', 'resourceId', 'ownerId'] as const;

/** Parse an untrusted value as a ResourceScope (total, fail-closed, strict keys). */
export function parseResourceScope(raw: unknown): ParseResult<ResourceScope> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RESOURCE_SCOPE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RESOURCE_SCOPE_KEYS, '', RESOURCE_SCOPE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scope = requireFieldWith(raw, 'scope', '', parseScope);
  if (!scope.ok) return scope;
  const resourceKind = requireFieldWith(raw, 'resourceKind', '', parseEntityKind);
  if (!resourceKind.ok) return resourceKind;
  const resourceId = requireNullableFieldWith(raw, 'resourceId', '', parseEntityId);
  if (!resourceId.ok) return resourceId;
  const ownerId = requireNullableFieldWith(raw, 'ownerId', '', parseEntityId);
  if (!ownerId.ok) return ownerId;
  return parseOk(
    {
      scope: scope.value,
      resourceKind: resourceKind.value,
      resourceId: resourceId.value,
      ownerId: ownerId.value,
    } satisfies ResourceScope,
  );
}

/** Type guard for structurally valid ResourceScope values. */
export function isResourceScope(raw: unknown): raw is ResourceScope {
  return parseResourceScope(raw).ok;
}

const optionalEntityId = (
  value: EntityId | null | undefined,
  field: string,
): EntityId | null => {
  if (value === null || value === undefined) return null;
  if (!isEntityId(value)) {
    throw new TypeError(`invalid ${field}: ${String(value)}`);
  }
  return value;
};

/** Compose a ResourceScope from validated parts (trusted path; loud TypeError). */
export function resourceScope(parts: {
  readonly scope: Scope;
  readonly resourceKind: EntityKind;
  readonly resourceId?: EntityId | null;
  readonly ownerId?: EntityId | null;
}): ResourceScope {
  if (!isScope(parts.scope)) {
    throw new TypeError(`invalid resource scope: ${JSON.stringify(parts.scope)}`);
  }
  if (!isEntityKind(parts.resourceKind)) {
    throw new TypeError(`invalid resource kind: ${String(parts.resourceKind)}`);
  }
  return {
    scope: parts.scope,
    resourceKind: parts.resourceKind,
    resourceId: optionalEntityId(parts.resourceId, 'resourceId'),
    ownerId: optionalEntityId(parts.ownerId, 'ownerId'),
  };
}

/**
 * Denial-context resolution (package-internal): authorization denials carry
 * the REQUEST scope (never the foreign resource's) and the supplied
 * correlation id — the scope is never silently omitted when known (A12).
 */
export const resolveDenialContext = (
  supplied: DomainErrorContext | undefined,
  requestScope: Scope,
): DomainErrorContext => ({
  scope: supplied?.scope ?? requestScope,
  correlationId: supplied?.correlationId ?? null,
});

/**
 * Structural scope coverage (freeze A12): may a request executing under
 * `requestScope` access `resource`?
 *
 * - different tenant → typed unauthorized ('tenant-scope-violation');
 * - a project-scoped request on a project-scoped resource of the same tenant
 *   but a different project → typed unauthorized ('project-scope-violation');
 * - a project-scoped request MAY access a tenant-wide resource of the same
 *   tenant (referencing tenant-level entities from project scope is legal);
 * - a tenant-scoped request covers every resource of its tenant;
 * - otherwise covered.
 *
 * Denials carry the request scope, not the foreign resource's. authorize()
 * runs this check BEFORE any rule matching (see policy.ts), so no policy can
 * ever allow a cross-tenant or cross-project access.
 */
export function checkScopeCoversResource(
  requestScope: Scope,
  resource: ResourceScope,
  context?: DomainErrorContext,
): Result<true, DomainError> {
  const denialContext = resolveDenialContext(context, requestScope);
  if (requestScope.tenantId !== resource.scope.tenantId) {
    return fail(
      domainError(
        'unauthorized',
        `request tenant ${requestScope.tenantId} cannot access a resource owned by tenant ${resource.scope.tenantId}`,
        [
          {
            code: 'tenant-scope-violation',
            message: `request tenant ${requestScope.tenantId}, resource tenant ${resource.scope.tenantId}`,
            path: null,
          },
        ],
        denialContext,
      ),
    );
  }
  if (
    requestScope.kind === 'project' &&
    resource.scope.kind === 'project' &&
    requestScope.projectId !== resource.scope.projectId
  ) {
    return fail(
      domainError(
        'unauthorized',
        `request project ${requestScope.projectId} cannot access a resource bound to project ${resource.scope.projectId}`,
        [
          {
            code: 'project-scope-violation',
            message: `request project ${requestScope.projectId}, resource project ${resource.scope.projectId}`,
            path: null,
          },
        ],
        denialContext,
      ),
    );
  }
  return ok(true);
}
