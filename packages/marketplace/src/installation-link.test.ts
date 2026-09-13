import { describe, expect, it } from 'vitest';
import { activateInstallation, revokeInstallation, uninstallInstallation } from '@office/app-runtime';
import {
  isInstallationLink,
  isInstallationLinkState,
  linkInstallation,
  moveInstallationLink,
  parseInstallationLink,
  parseInstallationLinkState,
  parseRuntimeLifecycleSnapshot,
  unlinkInstallation,
  UNLINKABLE_RUNTIME_STATES,
} from './installation-link';
import type { InstallationLink } from './installation-link';
import { installationLinkIdOf } from './identity';
import {
  adminActor,
  fixtureInstallation,
  INSTALLATION_A,
  operatorActor,
  T0,
  TENANT_A,
  unwrap,
  V1,
  V2,
} from './test-support';

// OFF-027 marketplace — installation metadata linkage: the derived link id
// keyed on (tenant, installation), the runtime lifecycle snapshot (TYPE-ONLY
// consumption of the app-runtime record), the moving pin (update/rollback),
// and the terminal idempotent severance (uninstall). The link is METADATA
// ONLY — nothing here constructs, dispatches, or executes the runtime.
describe('marketplace installation links (OFF-027)', () => {
  const installation = () => fixtureInstallation(INSTALLATION_A, TENANT_A, V1, T0);
  const linkId = installationLinkIdOf({
    tenantId: TENANT_A,
    installationId: INSTALLATION_A,
  });
  const releaseId = 'office-rel-v1-0123456789abcdef0123456789abcdef';
  const entitlementId = 'office-etl-v1-0123456789abcdef0123456789abcdef';

  const link = (): InstallationLink =>
    linkInstallation({
      installation: installation(),
      releaseId: releaseId as ReturnType<typeof linkInstallation>['releaseId'],
      releaseVersion: V1,
      entitlementId: entitlementId as ReturnType<typeof linkInstallation>['entitlementId'],
      linkedAt: T0,
      linkedBy: adminActor(),
    });

  it('composes a linked record with the derived id and the snapshotted runtime lifecycle', () => {
    const record = link();
    expect(record.kind).toBe('installation-link');
    expect(record.linkId).toBe(linkId);
    expect(record.installationId).toBe(INSTALLATION_A);
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.appId).toBe('progress-recorder');
    expect(record.currentVersion).toBe(V1);
    expect(record.runtimeLifecycle).toBe('installing');
    expect(record.state).toBe('linked');
    expect(record.linkedAt).toBe(T0);
    expect(record.linkedBy).toEqual(adminActor());
    expect(record.updatedAt).toBeNull();
    expect(record.updatedBy).toBeNull();
    expect(record.unlinkedAt).toBeNull();
    expect(record.unlinkedBy).toBeNull();
    // deterministic identity: the same logical key always derives the same link
    expect(link().linkId).toBe(link().linkId);
  });

  it('throws loudly on an invalid part (the trusted path validates itself)', () => {
    expect(() =>
      linkInstallation({
        installation: installation(),
        releaseId: releaseId as ReturnType<typeof linkInstallation>['releaseId'],
        releaseVersion: 'not-a-version' as unknown as ReturnType<typeof linkInstallation>['currentVersion'],
        entitlementId: entitlementId as ReturnType<typeof linkInstallation>['entitlementId'],
        linkedAt: T0,
        linkedBy: adminActor(),
      }),
    ).toThrow(TypeError);
  });

  it('parses a link record round-trip and rejects malformed ones', () => {
    const record = link();
    expect(unwrap(parseInstallationLink(record))).toStrictEqual(record);
    expect(isInstallationLink(record)).toBe(true);
    expect(parseInstallationLink({ ...record, extra: true }).ok).toBe(false);
    expect(parseInstallationLink({ ...record, state: 'severed' }).ok).toBe(false);
    expect(parseInstallationLink({ ...record, linkId: 'office-lnk-v1-nope' }).ok).toBe(false);
    expect(parseInstallationLink({ ...record, runtimeLifecycle: 'pending' }).ok).toBe(false);
    expect(parseInstallationLink({ ...record, tenantId: 'not-a-tenant' }).ok).toBe(false);
    expect(parseInstallationLink(null).ok).toBe(false);
    expect(parseInstallationLink('nope').ok).toBe(false);
  });

  it('rejects severed/linked provenance inconsistencies fail-closed', () => {
    const record = link();
    // a linked record carrying severance provenance
    expect(parseInstallationLink({ ...record, unlinkedAt: T0 }).ok).toBe(false);
    expect(parseInstallationLink({ ...record, unlinkedBy: operatorActor() }).ok).toBe(false);
    // a severed record without severance provenance
    const severed = unlinkInstallation(record, { at: T0, by: operatorActor() });
    expect(parseInstallationLink({ ...severed, unlinkedAt: null }).ok).toBe(false);
    expect(parseInstallationLink({ ...severed, unlinkedBy: null }).ok).toBe(false);
  });

  it('parses link states and runtime lifecycle snapshots fail-closed', () => {
    expect(unwrap(parseInstallationLinkState('linked'))).toBe('linked');
    expect(unwrap(parseInstallationLinkState('unlinked'))).toBe('unlinked');
    expect(isInstallationLinkState('linked')).toBe(true);
    expect(parseInstallationLinkState('pending').ok).toBe(false);
    expect(parseInstallationLinkState(null).ok).toBe(false);
    for (const state of ['installing', 'active', 'suspended', 'revoked', 'uninstalled'] as const) {
      expect(unwrap(parseRuntimeLifecycleSnapshot(state))).toBe(state);
    }
    expect(parseRuntimeLifecycleSnapshot('terminated').ok).toBe(false);
    expect(parseRuntimeLifecycleSnapshot(1).ok).toBe(false);
  });

  it('the unlinkable runtime states are exactly the terminal ones', () => {
    expect(UNLINKABLE_RUNTIME_STATES).toStrictEqual(['revoked', 'uninstalled']);
  });

  it('snapshots the runtime lifecycle from the app-runtime record (metadata only)', () => {
    const active = unwrap(activateInstallation(installation(), { at: T0 }))
      .installation;
    const revoked = unwrap(revokeInstallation(active, { at: T0, by: operatorActor() })).installation;
    const revokedLink = linkInstallation({
      installation: revoked,
      releaseId: releaseId as ReturnType<typeof linkInstallation>['releaseId'],
      releaseVersion: V1,
      entitlementId: entitlementId as ReturnType<typeof linkInstallation>['entitlementId'],
      linkedAt: T0,
      linkedBy: adminActor(),
    });
    expect(revokedLink.runtimeLifecycle).toBe('revoked');
    const uninstalled = unwrap(uninstallInstallation(active, { at: T0, by: operatorActor() })).installation;
    const uninstalledLink = linkInstallation({
      installation: uninstalled,
      releaseId: releaseId as ReturnType<typeof linkInstallation>['releaseId'],
      releaseVersion: V1,
      entitlementId: entitlementId as ReturnType<typeof linkInstallation>['entitlementId'],
      linkedAt: T0,
      linkedBy: adminActor(),
    });
    expect(uninstalledLink.runtimeLifecycle).toBe('uninstalled');
  });

  it('moves the pinned release (update/rollback) with fresh provenance, record intact', () => {
    const record = link();
    const moved = moveInstallationLink(record, {
      toReleaseId: 'office-rel-v1-0123456789abcdef0123456789abcdee' as ReturnType<
        typeof linkInstallation
      >['releaseId'],
      toVersion: V2,
      at: T0,
      by: operatorActor(),
    });
    expect(moved.currentVersion).toBe(V2);
    expect(moved.updatedAt).toBe(T0);
    expect(moved.updatedBy).toEqual(operatorActor());
    // the identity, provenance of the original link, and lifecycle are intact
    expect(moved.linkId).toBe(record.linkId);
    expect(moved.linkedAt).toBe(record.linkedAt);
    expect(moved.linkedBy).toEqual(record.linkedBy);
    expect(moved.state).toBe('linked');
    // the original record is untouched (pure transition)
    expect(record.currentVersion).toBe(V1);
    expect(record.updatedAt).toBeNull();
  });

  it('severs terminally and idempotently, preserving the original severance provenance', () => {
    const record = link();
    const severed = unlinkInstallation(record, { at: T0, by: operatorActor() });
    expect(severed.state).toBe('unlinked');
    expect(severed.unlinkedAt).toBe(T0);
    expect(severed.unlinkedBy).toEqual(operatorActor());
    // re-severance returns the identical record — no re-stamping
    expect(unlinkInstallation(severed, { at: T0, by: adminActor() })).toBe(severed);
    // a severed link can never move its pin again
    expect(() =>
      moveInstallationLink(severed, {
        toReleaseId: releaseId as ReturnType<typeof linkInstallation>['releaseId'],
        toVersion: V2,
        at: T0,
        by: operatorActor(),
      }),
    ).toThrow(TypeError);
  });
});
