// Office canonical contracts — scope (OFF-002).
//
// Tenant/project scope types (freeze A12): every command and event envelope
// is tenant-scoped; project scope applies where the operation is bound to a
// single project. Project access is the second authorization boundary. The
// scope carried here is the data contract; enforcement (deny-by-default,
// cross-tenant rejection) belongs to OFF-006.
import {
  describeValue,
  isPlainObject,
  parseFail,
  parseOk,
  requireFieldWith,
  unknownKeyFailure,
} from './parse';
import type { ParseResult } from './parse';
import { parseProjectId, parseTenantId } from './identity';
import type { ProjectId, TenantId } from './identity';

/** Tenant-wide scope: the operation is not bound to a single project. */
export interface TenantScope {
  readonly kind: 'tenant';
  readonly tenantId: TenantId;
}

/** Project scope: tenant-scoped and additionally bound to one project. */
export interface ProjectScope {
  readonly kind: 'project';
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

/** Tenant/project scope of an envelope, discriminated on `kind`. */
export type Scope = TenantScope | ProjectScope;

/** Shape description used in parse failures. */
export const SCOPE_GRAMMAR =
  "{ kind: 'tenant', tenantId } | { kind: 'project', tenantId, projectId }";

const TENANT_SCOPE_KEYS = ['kind', 'tenantId'] as const;
const PROJECT_SCOPE_KEYS = ['kind', 'tenantId', 'projectId'] as const;

/**
 * Parse an untrusted value as a Scope (total, fail-closed, strict keys).
 * Both variants require a valid canonical TenantId; the project variant
 * additionally requires a valid canonical ProjectId.
 */
export function parseScope(raw: unknown): ParseResult<Scope> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SCOPE_GRAMMAR, describeValue(raw));
  }
  const kind = raw['kind'];
  if (kind === undefined) {
    return parseFail('missing-field', 'kind', "'tenant' | 'project'", 'undefined');
  }
  if (kind === 'tenant') {
    const unknownKey = unknownKeyFailure(raw, TENANT_SCOPE_KEYS, '', SCOPE_GRAMMAR);
    if (unknownKey) return unknownKey;
    const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
    if (!tenantId.ok) return tenantId;
    return parseOk({ kind: 'tenant', tenantId: tenantId.value } satisfies TenantScope);
  }
  if (kind === 'project') {
    const unknownKey = unknownKeyFailure(raw, PROJECT_SCOPE_KEYS, '', SCOPE_GRAMMAR);
    if (unknownKey) return unknownKey;
    const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
    if (!tenantId.ok) return tenantId;
    const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
    if (!projectId.ok) return projectId;
    return parseOk(
      { kind: 'project', tenantId: tenantId.value, projectId: projectId.value } satisfies ProjectScope,
    );
  }
  return parseFail('invalid-value', 'kind', "'tenant' | 'project'", describeValue(kind));
}

/** Type guard for structurally valid Scope values. */
export function isScope(raw: unknown): raw is Scope {
  return parseScope(raw).ok;
}
