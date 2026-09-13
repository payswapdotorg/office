// OFF-026 app-runtime — per-installation A9 permission enforcement suite.
//
// The grant bookkeeping: manifest-declared specs become deterministic
// Permission records; the A9 dispatch gate (checkInstallationCapabilities)
// typed-rejects missing, revoked, and FOREIGN grants; the event-side
// capability derivation fails closed outside the closed vocabulary; the
// revoke/upgrade wrappers carry the ownership discipline.
import { describe, expect, it } from 'vitest';
import { parseCapability } from '@office/authz';
import { grantPermission, revokePermission } from '@office/app-sdk';
import type { AppId, Permission } from '@office/app-sdk';
import {
  checkInstallationCapabilities,
  grantManifestPermissions,
  installationGrantView,
  requiredCapabilityOfEvent,
  revokeInstallationPermission,
  upgradeInstallationPermission,
} from './permissions';
import {
  TENANT_A,
  TENANT_B,
  INSTALLATION,
  INSTALLATION_B,
  SAMPLE_MANIFEST,
  T0,
  activeInstallationOf,
  adminActor,
  expectFail,
  expectOk,
  operatorActor,
  samplePermissionsFor,
  unwrap,
} from './test-support';
import { parseEventName } from '@office/contracts';

describe('grantManifestPermissions', () => {
  it('issues exactly one deterministic Permission per declared spec', () => {
    const installation = activeInstallationOf();
    const grants = grantManifestPermissions(installation, SAMPLE_MANIFEST, {
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    expect(grants).toHaveLength(2);
    expect(grants.map((grant) => grant.spec.capability)).toStrictEqual(['work.read', 'work.write']);
    for (const grant of grants) {
      expect(grant.tenantId).toBe(TENANT_A);
      expect(grant.installationId).toBe(INSTALLATION);
      expect(grant.appId).toBe(SAMPLE_MANIFEST.appId);
      expect(grant.state).toBe('granted');
      expect(grant.version).toBe(1);
      expect(grant.grantedBy).toStrictEqual(adminActor());
    }
    // Deterministic identity: the same key maps to the same permission id.
    const again = grantManifestPermissions(installation, SAMPLE_MANIFEST, {
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    expect(again.map((grant) => grant.permissionId)).toStrictEqual(
      grants.map((grant) => grant.permissionId),
    );
  });

  it('throws a loud TypeError when the manifest belongs to another app', () => {
    const installation = activeInstallationOf();
    expect(() =>
      grantManifestPermissions(
        installation,
        { ...SAMPLE_MANIFEST, appId: 'other-application' as AppId },
        { grantedAt: T0, grantedBy: adminActor() },
      ),
    ).toThrow(TypeError);
  });
});

describe('installationGrantView (ownership discipline)', () => {
  it('partitions the installation\u2019s grants into live and revoked', () => {
    const installation = activeInstallationOf();
    const grants = samplePermissionsFor(installation);
    const revoked = expectOk(
      revokePermission(grants[1] as Permission, { revokedBy: operatorActor(), now: T0 }),
    );
    const view = expectOk(installationGrantView(installation, [grants[0] as Permission, revoked]));
    expect(view.live.map((grant) => grant.spec.capability)).toStrictEqual(['work.read']);
    expect(view.revoked.map((grant) => grant.spec.capability)).toStrictEqual(['work.write']);
  });

  it('typed-rejects a FOREIGN permission record (another installation/tenant/app)', () => {
    const installation = activeInstallationOf();
    const foreignInstallation = { ...installation, installationId: INSTALLATION_B };
    const foreign = samplePermissionsFor(foreignInstallation);
    const rejected = expectFail(
      installationGrantView(installation, [foreign[0] as Permission]),
    );
    expect(rejected.code).toBe('invariant-violation');
    expect(rejected.details[0]?.code).toBe('permission-foreign');

    const foreignTenant = { ...installation, tenantId: TENANT_B };
    const byTenant = samplePermissionsFor(foreignTenant);
    expect(
      expectFail(installationGrantView(installation, [byTenant[0] as Permission])).details[0]?.code,
    ).toBe('permission-foreign');

    // A grant of ANOTHER app for the same installation/tenant: composed
    // directly through the SDK grant builder (grantManifestPermissions
    // would refuse the app mismatch — its TypeError is a different fixture).
    const foreignAppGrant = grantPermission({
      tenantId: TENANT_A,
      installationId: INSTALLATION,
      appId: 'another-application' as AppId,
      spec: (samplePermissionsFor(installation)[0] as Permission).spec,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    expect(
      expectFail(installationGrantView(installation, [foreignAppGrant])).details[0]?.code,
    ).toBe('permission-foreign');
  });
});

describe('checkInstallationCapabilities (THE A9 dispatch gate)', () => {
  it('returns the live grant capabilities when every requirement is covered', () => {
    const installation = activeInstallationOf();
    const grants = samplePermissionsFor(installation);
    const capabilities = expectOk(
      checkInstallationCapabilities(installation, grants, [unwrap(parseCapability('work.write'))]),
    );
    expect([...capabilities]).toStrictEqual(['work.read', 'work.write']);
  });

  it('typed-rejects a never-granted capability (forbidden, before the gateway)', () => {
    const installation = activeInstallationOf();
    const grants = samplePermissionsFor(installation);
    const failure = expectFail(
      checkInstallationCapabilities(installation, grants, [unwrap(parseCapability('cost.write'))]),
    );
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('capability-not-granted');
  });

  it('typed-rejects a REVOKED capability with the revocation detail', () => {
    const installation = activeInstallationOf();
    const grants = samplePermissionsFor(installation);
    const revoked = expectOk(
      revokePermission(grants[1] as Permission, { revokedBy: operatorActor(), now: T0 }),
    );
    const failure = expectFail(
      checkInstallationCapabilities(installation, [grants[0] as Permission, revoked], [
        unwrap(parseCapability('work.write')),
      ]),
    );
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('capability-revoked');
  });

  it('typed-rejects when NO grants exist at all (deny-by-default)', () => {
    const installation = activeInstallationOf();
    const failure = expectFail(
      checkInstallationCapabilities(installation, [], [unwrap(parseCapability('work.read'))]),
    );
    expect(failure.details[0]?.code).toBe('capability-not-granted');
  });

  it('typed-rejects foreign grants even when the capability would match', () => {
    const installation = activeInstallationOf();
    const foreign = samplePermissionsFor({ ...installation, installationId: INSTALLATION_B });
    const failure = expectFail(
      checkInstallationCapabilities(installation, [foreign[1] as Permission], [
        unwrap(parseCapability('work.write')),
      ]),
    );
    expect(failure.details[0]?.code).toBe('permission-foreign');
  });
});

describe('requiredCapabilityOfEvent (the event-side derivation)', () => {
  it("derives the event area's read capability", () => {
    expect(expectOk(requiredCapabilityOfEvent(unwrap(parseEventName('work.progressRecorded'))))).toBe('work.read');
    expect(expectOk(requiredCapabilityOfEvent(unwrap(parseEventName('cost.costItemRecorded'))))).toBe('cost.read');
    expect(
      expectOk(requiredCapabilityOfEvent(unwrap(parseEventName('contracts.changeEventRaised')))),
    ).toBe('contracts.read');
  });

  it('fails closed for areas outside the capability vocabulary (platform-internal)', () => {
    for (const name of ['actions.actionExecuted', 'nope.somethingHappened']) {
      const failure = expectFail(requiredCapabilityOfEvent(unwrap(parseEventName(name))));
      expect(failure.code, name).toBe('forbidden');
      expect(failure.details[0]?.code, name).toBe('event-area-capability-unknown');
    }
  });

  it("derives the marketplace area's read capability for the runtime's own audit events", () => {
    expect(
      expectOk(requiredCapabilityOfEvent(unwrap(parseEventName('apps.appInstalled')))),
    ).toBe('apps.read');
  });
});

describe('the revoke/upgrade wrappers (ownership discipline)', () => {
  it('revokes an OWN permission and is idempotent', () => {
    const installation = activeInstallationOf();
    const grants = samplePermissionsFor(installation);
    const revoked = expectOk(
      revokeInstallationPermission(installation, grants[0] as Permission, {
        revokedBy: operatorActor(),
        now: T0,
      }),
    );
    expect(revoked.state).toBe('revoked');
    const again = expectOk(
      revokeInstallationPermission(installation, revoked, { revokedBy: adminActor(), now: T0 }),
    );
    expect(again).toStrictEqual(revoked);
  });

  it('typed-rejects revoking a FOREIGN permission through this installation', () => {
    const installation = activeInstallationOf();
    const foreign = samplePermissionsFor({ ...installation, installationId: INSTALLATION_B });
    const failure = expectFail(
      revokeInstallationPermission(installation, foreign[0] as Permission, {
        revokedBy: operatorActor(),
        now: T0,
      }),
    );
    expect(failure.details[0]?.code).toBe('permission-foreign');
  });

  it('upgrades an OWN permission to an explicitly re-declared spec (versioned)', () => {
    const installation = activeInstallationOf();
    const grants = samplePermissionsFor(installation);
    const upgraded = expectOk(
      upgradeInstallationPermission(installation, grants[0] as Permission, {
        spec: { ...((grants[0] as Permission).spec), version: 2 as never },
        now: T0,
      }),
    );
    expect(upgraded.state).toBe('versioned');
    expect(upgraded.version).toBe(2);
  });

  it('typed-rejects upgrading a FOREIGN permission', () => {
    const installation = activeInstallationOf();
    const foreign = samplePermissionsFor({ ...installation, installationId: INSTALLATION_B });
    const failure = expectFail(
      upgradeInstallationPermission(installation, foreign[0] as Permission, {
        spec: { ...(foreign[0] as Permission).spec, version: 2 as never },
        now: T0,
      }),
    );
    expect(failure.details[0]?.code).toBe('permission-foreign');
  });
});

describe('a grant for another installation never satisfies this installation', () => {
  it('the borrowed-grant matrix over tenant/installation/app mismatches', () => {
    const installation = activeInstallationOf();
    const required = [unwrap(parseCapability('work.write'))];
    const borrowed = grantPermission({
      tenantId: TENANT_B,
      installationId: INSTALLATION_B,
      appId: SAMPLE_MANIFEST.appId,
      spec: (samplePermissionsFor(installation)[1] as Permission).spec,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    const failure = expectFail(checkInstallationCapabilities(installation, [borrowed], required));
    expect(failure.details[0]?.code).toBe('permission-foreign');
  });
});
