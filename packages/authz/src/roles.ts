// Office authz — role/capability primitives (OFF-006).
//
// Roles are declared, named bundles of capabilities: the assignment
// vocabulary human users receive. Service principals (apps, agents,
// adapters) authorize with directly granted capabilities instead of roles —
// apps declare manifest capabilities (A7), agent runs carry granted sets
// (A8) — so roles are a user-assignment convenience, never a second
// enforcement path. All actors meet in the same evaluator (policy.ts).
//
// Fail-closed: parseRole rejects any string outside ROLE_DEFINITIONS, and
// the definitions themselves are validated at module load — a role naming an
// undeclared (or duplicate) capability breaks the import loudly, never
// silently. expandRoles unions grants deterministically in vocabulary order.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { CAPABILITIES, capabilityAction, parseCapability } from './capability';
import type { Capability } from './capability';
import { describeValue } from './parse';

declare const roleBrand: unique symbol;

/** A declared role name, e.g. 'project-manager' (branded canonical value). */
export type Role = string & { readonly [roleBrand]: 'Role' };

/** One declared role: the role name and the capability set it grants. */
export interface RoleDefinition {
  readonly role: Role;
  readonly capabilities: readonly Capability[];
}

/** Grammar description used in parse failures. */
export const ROLE_GRAMMAR =
  'declared role name — lowercase kebab-case (1..64 chars), one of ROLE_DEFINITIONS, e.g. "tenant-admin"';

const ROLE_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

const DECLARED_EXPECTED = 'one of the declared roles (ROLE_DEFINITIONS)';

/**
 * Compose a RoleDefinition from validated parts (trusted path). The role name
 * must match the grammar; every capability must be declared and unique — a
 * loud TypeError otherwise, never a silently dropped grant.
 */
export function defineRole(parts: {
  readonly role: string;
  readonly capabilities: readonly string[];
}): RoleDefinition {
  if (typeof parts.role !== 'string' || !ROLE_NAME_PATTERN.test(parts.role)) {
    throw new TypeError(`invalid role name: ${String(parts.role)}`);
  }
  const capabilities: Capability[] = [];
  for (const name of parts.capabilities) {
    const parsed = parseCapability(name);
    if (!parsed.ok) {
      throw new TypeError(
        `role '${parts.role}' declares an unknown capability: ${String(name)}`,
      );
    }
    if (capabilities.includes(parsed.value)) {
      throw new TypeError(
        `role '${parts.role}' declares duplicate capability: ${String(name)}`,
      );
    }
    capabilities.push(parsed.value);
  }
  return { role: parts.role as Role, capabilities };
}

const DECLARED_ROLES: readonly RoleDefinition[] = [
  // Tenant-wide administrator: the full declared vocabulary.
  defineRole({ role: 'tenant-admin', capabilities: CAPABILITIES }),
  // Day-to-day project delivery: everything within a project's domain
  // surfaces; no tenant-level organization/people/app administration.
  defineRole({
    role: 'project-manager',
    capabilities: [
      'organization.read',
      'people.read',
      'apps.read',
      'projects.read',
      'projects.write',
      'documents.read',
      'documents.write',
      'models.read',
      'models.write',
      'work.read',
      'work.write',
      'schedule.read',
      'schedule.write',
      'cost.read',
      'cost.write',
      'procurement.read',
      'procurement.write',
      'contracts.read',
      'contracts.write',
      'quality.read',
      'quality.write',
      'workflows.read',
      'workflows.write',
    ],
  }),
  // Commercial control: cost/procurement authority with read visibility of
  // the delivery context.
  defineRole({
    role: 'cost-manager',
    capabilities: [
      'projects.read',
      'documents.read',
      'models.read',
      'work.read',
      'schedule.read',
      'people.read',
      'cost.read',
      'cost.write',
      'procurement.read',
      'procurement.write',
      'contracts.read',
    ],
  }),
  // Planning: schedule authority with read visibility of delivery context.
  defineRole({
    role: 'scheduler',
    capabilities: [
      'projects.read',
      'documents.read',
      'models.read',
      'work.read',
      'cost.read',
      'people.read',
      'schedule.read',
      'schedule.write',
    ],
  }),
  // Field capture: daily logs, observations, documents, quality.
  defineRole({
    role: 'field-engineer',
    capabilities: [
      'projects.read',
      'models.read',
      'schedule.read',
      'documents.read',
      'documents.write',
      'work.read',
      'work.write',
      'quality.read',
      'quality.write',
    ],
  }),
  // Read-only across the declared vocabulary.
  defineRole({
    role: 'viewer',
    capabilities: CAPABILITIES.filter((value) => capabilityAction(value) === 'read'),
  }),
];

/** The declared role vocabulary with each role's capability grants. */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = DECLARED_ROLES;

/** Parse an untrusted value as a Role (total, fail-closed; closed vocabulary). */
export function parseRole(raw: unknown): ParseResult<Role> {
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', ROLE_GRAMMAR, describeValue(raw));
  }
  if (!ROLE_NAME_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', ROLE_GRAMMAR, describeValue(raw));
  }
  if (!ROLE_DEFINITIONS.some((definition) => definition.role === raw)) {
    return parseFail('invalid-value', '', DECLARED_EXPECTED, `undeclared role '${raw}'`);
  }
  return parseOk(raw as Role);
}

/** Type guard for declared Role values. */
export function isRole(raw: unknown): raw is Role {
  return parseRole(raw).ok;
}

/** The capability set a declared role grants (trusted path; loud TypeError). */
export function roleCapabilities(role: Role): readonly Capability[] {
  const definition = ROLE_DEFINITIONS.find((candidate) => candidate.role === role);
  if (definition === undefined) {
    throw new TypeError(`unknown role: ${String(role)}`);
  }
  return definition.capabilities;
}

/**
 * Expand roles into the union of their capability grants, ordered by the
 * canonical capability vocabulary order. Deterministic; duplicate grants
 * from overlapping roles collapse.
 */
export function expandRoles(roles: readonly Role[]): readonly Capability[] {
  const granted = new Set<Capability>();
  for (const role of roles) {
    for (const value of roleCapabilities(role)) {
      granted.add(value);
    }
  }
  return CAPABILITIES.filter((value) => granted.has(value));
}
