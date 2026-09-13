import { describe, expect, it } from 'vitest';
import { versionRange } from '@office/app-sdk';
import type { DomainError } from '@office/domain-kernel';
import type { Result } from '@office/domain-kernel';
import { createInMemoryMarketplaceAuditSink } from './audit';
import type { MarketplaceAuditRecord } from './audit';
import { createMarketplace } from './engine';
import type { Marketplace } from './engine';
import { installationLinkIdOf, publisherIdOf, releaseIdOf, updateIdOf } from './identity';
import { parsePermissionConfirmation } from './update';
import {
  adminActor,
  countingCanonicalStatePort,
  createCanonicalWorld,
  fixtureInstallation,
  INSTALLATION_A,
  knownFixtureActions,
  makeClock,
  operatorActor,
  PUBLISHER_NAME,
  rawManifestV1,
  rawManifestV2,
  T0,
  TENANT_A,
  unwrap,
  V1,
  V2,
} from './test-support';
import { PROGRESS_APP_ID } from './test-support';

// OFF-027 marketplace — THE named acceptance: the golden lifecycle scenario
// (publish → entitle → install-link → update with a permission delta that
// requires fresh confirmation → rollback → uninstall → publisher revoke)
// driven through THE composed engine with EVERY transition landing in the
// typed audit ledger (who/what/when through the injected clock; deterministic
// derived ids), and the canonical-state port fingerprint compared BEFORE and
// AFTER every single marketplace operation — zero canonical mutations, ever
// (freeze A11: the marketplace owns metadata, never project truth).
describe('THE marketplace lifecycle golden scenario (OFF-027)', () => {
  /** Drive the whole golden scenario once; assert canonical preservation per step. */
  const driveGoldenScenario = (): {
    readonly engine: Marketplace;
    readonly ledger: readonly MarketplaceAuditRecord[];
    readonly portCalls: number;
    readonly ids: {
      readonly publisherId: string;
      readonly releaseV1: string;
      readonly releaseV2: string;
      readonly entitlementId: string;
      readonly linkId: string;
      readonly updateId: string;
    };
    readonly rejectedApply: Result<unknown, DomainError>;
  } => {
    const world = createCanonicalWorld();
    const counting = countingCanonicalStatePort(world.port());
    const sink = createInMemoryMarketplaceAuditSink();
    const engine = createMarketplace({
      actions: knownFixtureActions(),
      audit: sink,
      canonicalState: counting.port,
      now: makeClock().now,
    });

    // The A11 probe: every marketplace operation runs between two canonical
    // snapshots, and the snapshots must be byte-identical — a marketplace
    // operation can never mutate canonical project state.
    let steps = 0;
    const step = <T>(run: () => Result<T, DomainError>): Result<T, DomainError> => {
      const before = world.snapshot();
      const result = run();
      const after = world.snapshot();
      expect(after).toStrictEqual(before);
      steps += 1;
      return result;
    };

    // 1. publisher registration
    const publisher = unwrap(
      step(() =>
        engine.registerPublisher({
          tenantId: TENANT_A,
          displayName: PUBLISHER_NAME,
          apps: [PROGRESS_APP_ID],
          by: adminActor(),
        }),
      ),
    );

    // 2./3. the two app releases (v1.4.0 and the permission-delta v1.5.0)
    const releaseV1 = unwrap(
      step(() =>
        engine.publishRelease({
          tenant: TENANT_A,
          publisherId: publisher.publisherId,
          rawManifest: rawManifestV1,
          by: adminActor(),
        }),
      ),
    );
    const releaseV2 = unwrap(
      step(() =>
        engine.publishRelease({
          tenant: TENANT_A,
          publisherId: publisher.publisherId,
          rawManifest: rawManifestV2,
          by: adminActor(),
        }),
      ),
    );

    // 4. the tenant entitlement over the whole ^1.4.0 line
    const entitlement = unwrap(
      step(() =>
        engine.grantEntitlement({
          tenant: TENANT_A,
          appId: PROGRESS_APP_ID,
          versionRange: versionRange('^1.4.0'),
          by: adminActor(),
        }),
      ),
    );

    // 5. the installation metadata linkage (the host installed v1.4.0)
    const link = unwrap(
      step(() =>
        engine.linkInstallation({
          tenant: TENANT_A,
          installation: fixtureInstallation(INSTALLATION_A, TENANT_A, V1, T0),
          releaseId: releaseV1.releaseId,
          entitlementId: entitlement.entitlementId,
          by: adminActor(),
        }),
      ),
    );

    // 6. the update is STAGED, never a silent swap — the delta adds cost.read@tenant
    const update = unwrap(
      step(() =>
        engine.stageUpdate({
          tenant: TENANT_A,
          linkId: link.linkId,
          toReleaseId: releaseV2.releaseId,
          by: operatorActor(),
        }),
      ),
    );
    expect(update.permissionDelta.added.map((spec) => `${spec.capability}@${spec.scopeKind}`)).toStrictEqual([
      'cost.read@tenant',
    ]);

    // 7. the added-capability update WITHOUT confirmation is typed-rejected
    const rejectedApply = step(() => engine.applyUpdate({ tenant: TENANT_A, updateId: update.updateId, by: operatorActor() }));
    expect(rejectedApply.ok).toBe(false);
    // the staged record is untouched and the pin has not moved
    expect(unwrap(engine.update(TENANT_A, update.updateId)).state).toBe('staged');
    expect(unwrap(engine.installationLink(TENANT_A, link.linkId)).currentVersion).toBe(V1);
    // and the rejection landed in NO audit record
    const ledgerBeforeApply = sink.records().length;

    // 8. the confirmed apply moves the pin to v1.5.0
    const applied = unwrap(
      step(() =>
        engine.applyUpdate({
          tenant: TENANT_A,
          updateId: update.updateId,
          confirmations: [
            unwrap(
              parsePermissionConfirmation({
                kind: 'update-confirmation',
                capability: 'cost.read',
                scopeKind: 'tenant',
              }),
            ),
          ],
          by: operatorActor(),
        }),
      ),
    );
    expect(sink.records().length).toBe(ledgerBeforeApply + 1);
    expect(applied.link.currentVersion).toBe(V2);
    expect(applied.update.state).toBe('applied');

    // 9. the explicit typed rollback moves the pin back; releases immutable
    const rolledBack = unwrap(
      step(() =>
        engine.rollbackUpdate({
          tenant: TENANT_A,
          updateId: update.updateId,
          by: operatorActor(),
        }),
      ),
    );
    expect(rolledBack.link.currentVersion).toBe(V1);
    expect(rolledBack.update.state).toBe('rolled-back');
    expect(rolledBack.update.toReleaseId).toBe(releaseV2.releaseId);
    expect(rolledBack.update.fromReleaseId).toBe(releaseV1.releaseId);

    // 10. the uninstall severs the entitlement→installation linkage
    const severed = unwrap(
      step(() =>
        engine.recordUninstall({
          tenant: TENANT_A,
          linkId: link.linkId,
          by: operatorActor(),
        }),
      ),
    );
    expect(severed.state).toBe('unlinked');

    // 11. the publisher revocation closes the scenario
    const revokedPublisher = unwrap(
      step(() =>
        engine.revokePublisher({
          tenant: TENANT_A,
          publisherId: publisher.publisherId,
          by: adminActor(),
        }),
      ),
    );
    expect(revokedPublisher.state).toBe('revoked');

    // the catalog still carries both immutable releases
    expect(unwrap(engine.catalogEntry(PROGRESS_APP_ID)).versions).toStrictEqual([V1, V2]);

    expect(steps).toBe(11);
    return {
      engine,
      ledger: sink.records(),
      portCalls: counting.calls(),
      ids: {
        publisherId: publisher.publisherId,
        releaseV1: releaseV1.releaseId,
        releaseV2: releaseV2.releaseId,
        entitlementId: entitlement.entitlementId,
        linkId: link.linkId,
        updateId: update.updateId,
      },
      rejectedApply,
    };
  };

  it('every transition lands in the typed audit ledger with deterministic provenance', () => {
    const run = driveGoldenScenario();
    const { ledger, ids } = run;

    // THE transition sequence, in append order
    expect(ledger.map((record) => record.transition)).toStrictEqual([
      'publisher-registered',
      'release-published',
      'release-published',
      'entitlement-granted',
      'installation-linked',
      'update-staged',
      'update-applied',
      'update-rolled-back',
      'installation-unlinked',
      'publisher-revoked',
    ]);
    // exactly one record per actual transition — the rejected apply never landed
    expect(ledger).toHaveLength(10);

    // WHO/WHAT: every record is tenant-scoped, carries the acting actor and
    // the deterministic derived subject id
    expect(ledger.every((record) => record.tenantId === TENANT_A)).toBe(true);
    expect(ledger.map((record) => record.subject)).toStrictEqual([
      ids.publisherId,
      ids.releaseV1,
      ids.releaseV2,
      ids.entitlementId,
      ids.linkId,
      ids.updateId,
      ids.updateId,
      ids.updateId,
      ids.linkId,
      ids.publisherId,
    ]);
    expect(ledger.map((record) => record.by)).toStrictEqual([
      adminActor(),
      adminActor(),
      adminActor(),
      adminActor(),
      adminActor(),
      operatorActor(),
      operatorActor(),
      operatorActor(),
      operatorActor(),
      adminActor(),
    ]);
    // WHAT: every app-scoped transition carries the fixture app id (the
    // publisher records carry only the publisher id)
    expect(
      ledger
        .filter((record) => !record.transition.startsWith('publisher-'))
        .every((record) => record.detail.appId === 'progress-recorder'),
    ).toBe(true);
    expect(ledger[0]?.detail.publisherId).toBe(ids.publisherId);

    // WHEN: every audited instant comes from the injected clock — strictly
    // ascending (each transition consumes its own tick), never the epoch
    const instants = ledger.map((record) => record.at);
    expect(new Set(instants).size).toBe(10);
    for (let index = 1; index < instants.length; index += 1) {
      expect(instants[index]! > instants[index - 1]!).toBe(true);
    }
    expect(instants[0]).not.toBe(T0);

    // the permission-delta review is visible in the staged/applied details
    const staged = ledger.find((record) => record.transition === 'update-staged');
    expect(staged?.detail.addedCapabilities).toStrictEqual(['cost.read@tenant']);
    const applied = ledger.find((record) => record.transition === 'update-applied');
    expect(applied?.detail.addedCapabilities).toStrictEqual(['cost.read@tenant']);
    expect(applied?.detail.confirmations).toStrictEqual(['cost.read@tenant']);
    const rolledBack = ledger.find((record) => record.transition === 'update-rolled-back');
    expect(rolledBack?.detail.fromVersion).toBe(V1);
    expect(rolledBack?.detail.toVersion).toBe(V2);
    const unlinked = ledger.find((record) => record.transition === 'installation-unlinked');
    expect(unlinked?.detail.installationId).toBe(INSTALLATION_A);
    expect(unlinked?.detail.entitlementId).toBe(ids.entitlementId);
  });

  it('the record identities are the deterministic derivations (no clock, no randomness)', () => {
    const { ids } = driveGoldenScenario();
    expect(ids.publisherId).toBe(
      publisherIdOf({ tenantId: TENANT_A, displayName: PUBLISHER_NAME, apps: ['progress-recorder'] }),
    );
    expect(ids.releaseV1).toBe(releaseIdOf({ appId: 'progress-recorder', manifestVersion: V1 }));
    expect(ids.releaseV2).toBe(releaseIdOf({ appId: 'progress-recorder', manifestVersion: V2 }));
    expect(ids.linkId).toBe(
      installationLinkIdOf({ tenantId: TENANT_A, installationId: INSTALLATION_A }),
    );
    expect(ids.updateId).toBe(
      updateIdOf({ linkId: ids.linkId, fromReleaseId: ids.releaseV1, toReleaseId: ids.releaseV2 }),
    );
    expect(ids.entitlementId.startsWith('office-etl-v1-')).toBe(true);
  });

  it('ZERO canonical mutations attributable to any marketplace operation (A11)', () => {
    const run = driveGoldenScenario();
    // the fingerprint comparison ran before/after EVERY one of the 11 steps
    // inside the scenario — and the engine never even READ the canonical port
    expect(run.portCalls).toBe(0);
  });

  it('the comparison is meaningful: a direct canonical mutation moves the fingerprint (control)', () => {
    const world = createCanonicalWorld();
    const before = world.snapshot();
    world.mutate('the control path — never the marketplace');
    const after = world.snapshot();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.mutationCount).toBe(1);
  });

  it('run-twice determinism: two independent engines produce byte-identical audit ledgers', () => {
    const first = driveGoldenScenario();
    const second = driveGoldenScenario();
    expect(second.ledger).toStrictEqual(first.ledger);
    expect(second.ids).toStrictEqual(first.ids);
    // the JSON-safe projection is identical too (ledger serialization)
    expect(second.ledger.map((record) => JSON.stringify(record))).toStrictEqual(
      first.ledger.map((record) => JSON.stringify(record)),
    );
  });
});
