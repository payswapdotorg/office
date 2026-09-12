import { describe, expect, it } from 'vitest';
import type { ParseResult } from '@office/contracts';
import {
  CAPABILITIES,
  ROLE_DEFINITIONS,
  capabilityAction,
  defineRole,
  expandRoles,
  isRole,
  parseCapability,
  parseRole,
  roleCapabilities,
} from './index';
import type { Role } from './index';

// OFF-006 authz — role/capability primitive tests. Deterministic: fixed
// values, no I/O.

const ROLE_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const failure = <T>(result: ParseResult<T>) => {
  if (result.ok) throw new Error('expected a parse failure');
  return result.error;
};

describe('role vocabulary (OFF-006)', () => {
  it('declares the canonical roles with grammar-valid, unique names', () => {
    expect(ROLE_DEFINITIONS.length).toBeGreaterThanOrEqual(6);
    const names = new Set<string>();
    for (const definition of ROLE_DEFINITIONS) {
      expect(ROLE_NAME_PATTERN.test(definition.role), definition.role).toBe(true);
      expect(names.has(definition.role), definition.role).toBe(false);
      names.add(definition.role);
    }
  });

  it('every role grants only declared, duplicate-free capabilities', () => {
    const declared = new Set<string>(CAPABILITIES);
    for (const definition of ROLE_DEFINITIONS) {
      const seen = new Set<string>();
      for (const name of definition.capabilities) {
        expect(declared.has(name), `${definition.role}: ${name}`).toBe(true);
        expect(seen.has(name), `${definition.role}: duplicate ${name}`).toBe(false);
        seen.add(name);
      }
    }
  });

  it('parses declared roles and rejects undeclared or malformed ones (fail-closed)', () => {
    for (const definition of ROLE_DEFINITIONS) {
      expect(parseRole(definition.role).ok, definition.role).toBe(true);
    }
    const undeclared = failure(parseRole('superadmin'));
    expect(undeclared.code).toBe('invalid-value');
    expect(undeclared.received).toContain('superadmin');
    const malformed = failure(parseRole('Tenant_Admin'));
    expect(malformed.code).toBe('invalid-value');
    const nonString = failure(parseRole(42));
    expect(nonString.code).toBe('invalid-type');
    expect(failure(parseRole('')).code).toBe('invalid-value');
  });

  it('isRole guards declared roles only', () => {
    expect(isRole('viewer')).toBe(true);
    expect(isRole('superadmin')).toBe(false);
    expect(isRole(null)).toBe(false);
  });

  it('expands a role to exactly its declared capability set', () => {
    const granted = new Set<string>(roleCapabilities(unwrap(parseRole('viewer'))));
    expect(granted.size).toBeGreaterThan(0);
    expect(granted.has('projects.read')).toBe(true);
    expect(granted.has('projects.write')).toBe(false);
  });

  it('role→capability expansion distinguishes read-only from read/write roles', () => {
    const viewer = new Set<string>(roleCapabilities(unwrap(parseRole('viewer'))));
    const manager = new Set<string>(roleCapabilities(unwrap(parseRole('project-manager'))));
    expect(viewer.has('projects.read')).toBe(true);
    expect(viewer.has('projects.write')).toBe(false);
    expect(manager.has('projects.read')).toBe(true);
    expect(manager.has('projects.write')).toBe(true);
    expect(manager.has('organization.write')).toBe(false);
  });

  it('tenant-admin expands to the full declared vocabulary', () => {
    expect(roleCapabilities(unwrap(parseRole('tenant-admin')))).toStrictEqual(CAPABILITIES);
  });

  it('viewer expands to exactly the read half of the vocabulary', () => {
    const reads = CAPABILITIES.filter((value) => capabilityAction(value) === 'read');
    expect(roleCapabilities(unwrap(parseRole('viewer')))).toStrictEqual(reads);
  });

  it('expandRoles unions overlapping roles deterministically in vocabulary order', () => {
    const viewer = unwrap(parseRole('viewer'));
    const fieldEngineer = unwrap(parseRole('field-engineer'));
    const expanded = expandRoles([fieldEngineer, viewer]);
    expect(expanded).toStrictEqual(expandRoles([viewer, fieldEngineer]));
    const set = new Set<string>(expanded);
    expect(set.has('work.write')).toBe(true);
    expect(set.has('models.read')).toBe(true);
    expect(set.has('cost.write')).toBe(false);
    expect(expanded).toStrictEqual(CAPABILITIES.filter((value) => set.has(value)));
  });

  it('expandRoles of an empty role set is empty', () => {
    expect(expandRoles([])).toStrictEqual([]);
  });

  it('expandRoles collapses duplicate grants across roles', () => {
    const admin = unwrap(parseRole('tenant-admin'));
    const viewer = unwrap(parseRole('viewer'));
    expect(expandRoles([admin, viewer])).toStrictEqual(CAPABILITIES);
    expect(expandRoles([viewer, viewer])).toStrictEqual(
      roleCapabilities(unwrap(parseRole('viewer'))),
    );
  });

  it('defineRole validates loudly on the trusted path', () => {
    const definition = defineRole({ role: 'auditor', capabilities: ['projects.read', 'documents.read'] });
    expect(definition.role).toBe('auditor');
    expect(definition.capabilities).toStrictEqual([
      unwrap(parseCapability('projects.read')),
      unwrap(parseCapability('documents.read')),
    ]);
    expect(() => defineRole({ role: 'Bad Role', capabilities: ['projects.read'] })).toThrow(
      TypeError,
    );
    expect(() => defineRole({ role: 'ghost', capabilities: ['projects.admin'] })).toThrow(
      TypeError,
    );
    expect(() =>
      defineRole({ role: 'ghost', capabilities: ['projects.read', 'projects.read'] }),
    ).toThrow(TypeError);
  });

  it('roleCapabilities throws loudly on an undeclared role', () => {
    expect(() => roleCapabilities('ghost' as Role)).toThrow(TypeError);
  });
});
