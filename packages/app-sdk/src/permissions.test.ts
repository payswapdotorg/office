import { describe, expect, it } from 'vitest';
import { parseAppId, permissionIdOf } from './identity';
import {
  grantPermission,
  isPermission,
  isPermissionActive,
  isPermissionScopeKind,
  isPermissionSpec,
  parsePermission,
  parsePermissionScopeKind,
  parsePermissionSpec,
  revokePermission,
  upgradePermission,
} from './permissions';
import type { Permission, PermissionScopeKind, PermissionSpec, PermissionState } from './permissions';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';
import type { Result } from '@office/domain-kernel';
import type { DomainError } from '@office/domain-kernel';
import {
  INSTALLATION,
  INSTALLATION_B,
  SAMPLE_APP_ID,
  TENANT_A,
  TENANT_B,
  T0,
  T1,
  T2,
  adminActor,
  expectFail,
  expectOk,
  operatorActor,
  unwrap,
} from './test-support';

// OFF-025 — the A9 permission discipline: explicit (closed capability
// vocabulary, explicit scope kinds, no wildcards), versioned (declaration
// version + lifecycle version), revocable (terminal, idempotent). The
// lifecycle mirrors the landed sync subscription grants: granted →
// versioned → revoked, typed Results all the way.

const workWriteSpec = (version: number): PermissionSpec =>
  unwrap(
    parsePermissionSpec({
      kind: 'app-permission',
      capability: 'work.write',
      scopeKind: 'project',
      version,
    }),
  );

const grantedPermission = (): Permission =>
  grantPermission({
    tenantId: TENANT_A,
    installationId: INSTALLATION,
    appId: parseAppIdForTest(),
    spec: workWriteSpec(1),
    grantedAt: T0,
    grantedBy: adminActor(),
  });

const parseAppIdForTest = () => unwrap(parseAppId(SAMPLE_APP_ID));

describe('permission declarations (PermissionSpec)', () => {
  it('parses an explicit declaration and rejects malformed shapes fail-closed', () => {
    const spec = unwrap(
      parsePermissionSpec({
        kind: 'app-permission',
        capability: 'work.read',
        scopeKind: 'tenant',
        version: 3,
      }),
    );
    expect(spec).toStrictEqual({
      kind: 'app-permission',
      capability: 'work.read',
      scopeKind: 'tenant',
      version: 3,
    });
    expect(isPermissionSpec({ ...spec })).toBe(true);
    expect(isPermissionSpec({ ...spec, extra: 1 })).toBe(false); // strict keys
    expect(parsePermissionSpec(null).ok).toBe(false);
    expect(parsePermissionSpec([]).ok).toBe(false);
    expect(parsePermissionSpec({ ...spec, kind: 'permission' }).ok).toBe(false);
    expect(parsePermissionSpec({ ...spec, capability: undefined }).ok).toBe(false);
    expect(parsePermissionSpec({ ...spec, scopeKind: undefined }).ok).toBe(false);
    expect(parsePermissionSpec({ ...spec, version: undefined }).ok).toBe(false);
  });

  it('rejects capabilities outside the closed authz vocabulary (THE named matrix case)', () => {
    for (const bad of [
      'projects.*', // wildcard capability
      '*', // full wildcard
      'work.*', // area wildcard
      'notAnArea.read', // undeclared area
      'telepathy.read', // undeclared area (well-formed shape)
      'work.readx', // malformed suffix
      'WORK.READ', // case
      '', // empty
      42, // wrong type
      null,
    ]) {
      const result = parsePermissionSpec({
        kind: 'app-permission',
        capability: bad,
        scopeKind: 'project',
        version: 1,
      });
      expect(result.ok, `capability ${JSON.stringify(bad)}`).toBe(false);
      if (!result.ok) {
        expect(['invalid-type', 'invalid-value']).toContain(result.error.code);
        expect(result.error.path).toBe('capability');
      }
    }
  });

  it('rejects wildcard and unknown scope kinds (explicit scope only)', () => {
    for (const bad of ['*', 'any', 'both', 'tenant-wide', '', 5, null]) {
      const result = parsePermissionScopeKind(bad);
      expect(result.ok, `scope kind ${JSON.stringify(bad)}`).toBe(false);
      expect(isPermissionScopeKind(bad)).toBe(false);
    }
    expect(unwrap(parsePermissionScopeKind('tenant'))).toBe('tenant');
    expect(unwrap(parsePermissionScopeKind('project'))).toBe('project');
    expect(
      parsePermissionSpec({
        kind: 'app-permission',
        capability: 'work.read',
        scopeKind: '*',
        version: 1,
      }).ok,
    ).toBe(false);
  });

  it('rejects non-positive declaration versions', () => {
    for (const bad of [0, -1, 1.5, '1', null]) {
      expect(
        parsePermissionSpec({
          kind: 'app-permission',
          capability: 'work.read',
          scopeKind: 'tenant',
          version: bad,
        }).ok,
        `version ${JSON.stringify(bad)}`,
      ).toBe(false);
    }
  });

  it('types the declaration closed at the type level', () => {
    const spec: PermissionSpec = workWriteSpec(1);
    const granted: Capability = spec.capability;
    const scope: PermissionScopeKind = spec.scopeKind;
    // @ts-expect-error — the scope kind is explicit: 'tenant' | 'project', never a wildcard
    const _wildcard: PermissionScopeKind = '*';
    void granted;
    void scope;
    void _wildcard;
  });
});

describe('runtime permission records (the A9 lifecycle)', () => {
  it('grants with state granted, lifecycle version 1, and the derived permission id', () => {
    const permission = grantedPermission();
    expect(permission.state).toBe('granted');
    expect(permission.version).toBe(1);
    expect(permission.revokedAt).toBeNull();
    expect(permission.revokedBy).toBeNull();
    expect(permission.permissionId).toBe(
      permissionIdOf({
        tenantId: TENANT_A,
        installationId: INSTALLATION,
        capability: 'work.write',
        scopeKind: 'project',
      }),
    );
    expect(isPermission(permission)).toBe(true);
    expect(isPermissionActive(permission)).toBe(true);
  });

  it('round-trips through the fail-closed parse', () => {
    const permission = grantedPermission();
    expect(unwrap(parsePermission(permission))).toStrictEqual(permission);
    expect(unwrap(parsePermission(JSON.parse(JSON.stringify(permission))))).toStrictEqual(permission);
  });

  it('rejects lifecycle-inconsistent records fail-closed', () => {
    const permission = grantedPermission();
    expect(parsePermission({ ...permission, state: 'expired' }).ok).toBe(false);
    expect(parsePermission({ ...permission, state: undefined }).ok).toBe(false);
    // a live permission carrying revocation fields
    expect(parsePermission({ ...permission, revokedAt: T1, revokedBy: adminActor() }).ok).toBe(false);
    // a revoked permission missing its revocation fields
    const revoked = expectOk(revokePermission(permission, { revokedBy: adminActor(), now: T1 }));
    expect(parsePermission({ ...revoked, revokedAt: null }).ok).toBe(false);
    expect(parsePermission({ ...revoked, revokedBy: null }).ok).toBe(false);
    // granted must mean lifecycle version 1
    expect(parsePermission({ ...permission, version: 2 }).ok).toBe(false);
    // versioned must mean at least one explicit upgrade
    expect(parsePermission({ ...revoked, state: 'versioned', version: 1 }).ok).toBe(false);
    // strict keys and foreign kinds
    expect(parsePermission({ ...permission, extra: true }).ok).toBe(false);
    expect(parsePermission({ ...permission, kind: 'permission' }).ok).toBe(false);
    // a foreign tenant id is not a valid tenant id at all
    expect(parsePermission({ ...permission, tenantId: 'tenant-a' }).ok).toBe(false);
  });

  it('upgrades the spec explicitly: version bumps, state becomes versioned', () => {
    const permission = grantedPermission();
    const upgraded = expectOk(upgradePermission(permission, { spec: workWriteSpec(2), now: T1 }));
    expect(upgraded.state).toBe('versioned');
    expect(upgraded.version).toBe(2);
    expect(upgraded.spec.version).toBe(2);
    expect(upgraded.grantedAt).toBe(T0);
    expect(isPermissionActive(upgraded)).toBe(true);
    // the original record is untouched (immutable transitions)
    expect(permission.state).toBe('granted');
    expect(permission.version).toBe(1);
  });

  it('rejects no-op and widening upgrades typed-cleanly', () => {
    const permission = grantedPermission();
    const upgraded = expectOk(upgradePermission(permission, { spec: workWriteSpec(2), now: T1 }));
    // same spec again
    const sameSpec = expectFail(upgradePermission(upgraded, { spec: workWriteSpec(2), now: T2 }));
    expect(sameSpec.code).toBe('invariant-violation');
    expect(sameSpec.details[0]?.code).toBe('permission-spec-unchanged');
    // capability change = a NEW permission, never an in-place widening
    const widened = expectFail(
      upgradePermission(permission, {
        spec: unwrap(
          parsePermissionSpec({
            kind: 'app-permission',
            capability: 'work.read',
            scopeKind: 'project',
            version: 2,
          }),
        ),
        now: T1,
      }),
    );
    expect(widened.code).toBe('invariant-violation');
    expect(widened.details[0]?.code).toBe('permission-widening-forbidden');
    // scope-kind change likewise
    const rescoped = expectFail(
      upgradePermission(permission, { spec: unwrap(
        parsePermissionSpec({
          kind: 'app-permission',
          capability: 'work.write',
          scopeKind: 'tenant',
          version: 2,
        }),
      ), now: T1 }),
    );
    expect(rescoped.details[0]?.code).toBe('permission-widening-forbidden');
  });

  it('revokes terminally and idempotently, preserving the first revocation', () => {
    const permission = grantedPermission();
    const revoked = expectOk(revokePermission(permission, { revokedBy: operatorActor(), now: T1 }));
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokedAt).toBe(T1);
    expect(revoked.revokedBy).toStrictEqual(operatorActor());
    expect(isPermissionActive(revoked)).toBe(false);
    // idempotent: revoking again returns the same record
    const again = expectOk(revokePermission(revoked, { revokedBy: adminActor(), now: T2 }));
    expect(again).toStrictEqual(revoked);
    // a revoked permission cannot be upgraded (terminal)
    const failed = expectFail(upgradePermission(revoked, { spec: workWriteSpec(3), now: T2 }));
    expect(failed.code).toBe('invariant-violation');
    expect(failed.details[0]?.code).toBe('permission-revoked');
  });

  it('keys permissions per installation and tenant (A7/A12 isolation at the type level)', () => {
    const otherInstallation = grantPermission({
      tenantId: TENANT_A,
      installationId: INSTALLATION_B,
      appId: parseAppIdForTest(),
      spec: workWriteSpec(1),
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    const otherTenant = grantPermission({
      tenantId: TENANT_B,
      installationId: INSTALLATION,
      appId: parseAppIdForTest(),
      spec: workWriteSpec(1),
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    const permission = grantedPermission();
    expect(otherInstallation.permissionId).not.toBe(permission.permissionId);
    expect(otherTenant.permissionId).not.toBe(permission.permissionId);
  });

  it('types the lifecycle as the closed granted → versioned → revoked union', () => {
    // The lifecycle contract, pinned at the type level (compile-time).
    const lifecycle = ['granted', 'versioned', 'revoked'] as const satisfies readonly PermissionState[];
    expect(lifecycle).toStrictEqual(['granted', 'versioned', 'revoked']);
    // @ts-expect-error — PermissionState is the closed three-state lifecycle union
    const _expired: PermissionState = 'expired';
    void _expired;
    // The transitions are typed Results, never throws:
    const upgraded: Result<Permission, DomainError> = upgradePermission(grantedPermission(), {
      spec: workWriteSpec(2),
      now: T1,
    });
    const revoked: Result<Permission, DomainError> = revokePermission(grantedPermission(), {
      revokedBy: adminActor(),
      now: T1,
    });
    expect(upgraded.ok).toBe(true);
    expect(revoked.ok).toBe(true);
  });

  it('documents the capability vocabulary source (authz re-export proof)', () => {
    expect(capability('work.write')).toBe('work.write');
    expect(() => capability('work.*')).toThrow(TypeError);
  });
});
