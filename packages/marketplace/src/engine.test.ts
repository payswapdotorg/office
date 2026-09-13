import { describe, expect, it } from 'vitest';
import { activateInstallation, revokeInstallation } from '@office/app-runtime';
import { versionRange } from '@office/app-sdk';
import type { VersionRange } from '@office/app-sdk';
import type { DomainError } from '@office/domain-kernel';
import type { Result } from '@office/domain-kernel';
import { createInMemoryMarketplaceAuditSink, failingMarketplaceAuditSink } from './audit';
import type { MarketplaceAuditSink } from './audit';
import { createMarketplace } from './engine';
import type { Marketplace } from './engine';
import { parsePermissionConfirmation } from './update';
import {
  adminActor,
  createCanonicalWorld,
  countingCanonicalStatePort,
  fixtureInstallation,
  INSTALLATION_A,
  INSTALLATION_B,
  INSTALLATION_C,
  knownFixtureActions,
  makeClock,
  operatorActor,
  PUBLISHER_NAME,
  rawManifestPatch,
  rawManifestV1,
  rawManifestV2,
  T0,
  TENANT_A,
  TENANT_B,
  unwrap,
  V1,
  V2,
} from './test-support';
import { PROGRESS_APP_ID } from './test-support';

// OFF-027 marketplace — THE composed engine's typed rejection matrix: the A12
// cross-tenant discipline (typed-rejected in BOTH directions over every
// tenant-scoped operation and query), the revocation gates (a revoked
// publisher cannot publish; a revoked entitlement cannot install or update),
// the update discipline (strictly-newer staged moves; duplicate staging), the
// release immutability, and the append-then-commit audit discipline (a failing
// audit sink aborts with NO committed state).
describe('the marketplace engine (OFF-027)', () => {
  const fresh = (sink: MarketplaceAuditSink = createInMemoryMarketplaceAuditSink()): Marketplace =>
    createMarketplace({
      actions: knownFixtureActions(),
      audit: sink,
      canonicalState: countingCanonicalStatePort(createCanonicalWorld().port()).port,
      now: makeClock().now,
    });

  /** The failure detail code of a typed rejection (loud on success). */
  const failCode = (result: Result<unknown, DomainError>): string => {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]).toBeDefined();
      return result.error.details[0]?.code ?? 'none';
    }
    return 'none';
  };

  /** Seed tenant A: publisher + v1/v2/patch releases + entitlement + link at v1. */
  const seeded = (): {
    readonly engine: Marketplace;
    readonly sink: ReturnType<typeof createInMemoryMarketplaceAuditSink>;
    readonly ids: {
      readonly publisherId: string;
      readonly releaseV1: string;
      readonly releaseV2: string;
      readonly releasePatch: string;
      readonly entitlementId: string;
      readonly linkId: string;
    };
  } => {
    const sink = createInMemoryMarketplaceAuditSink();
    const engine = fresh(sink);
    const publisher = unwrap(
      engine.registerPublisher({
        tenantId: TENANT_A,
        displayName: PUBLISHER_NAME,
        apps: [PROGRESS_APP_ID],
        by: adminActor(),
      }),
    );
    const releaseV1 = unwrap(
      engine.publishRelease({ tenant: TENANT_A, publisherId: publisher.publisherId, rawManifest: rawManifestV1, by: adminActor() }),
    );
    const releaseV2 = unwrap(
      engine.publishRelease({ tenant: TENANT_A, publisherId: publisher.publisherId, rawManifest: rawManifestV2, by: adminActor() }),
    );
    const releasePatch = unwrap(
      engine.publishRelease({ tenant: TENANT_A, publisherId: publisher.publisherId, rawManifest: rawManifestPatch, by: adminActor() }),
    );
    const entitlement = unwrap(
      engine.grantEntitlement({
        tenant: TENANT_A,
        appId: PROGRESS_APP_ID,
        versionRange: versionRange('^1.4.0'),
        by: adminActor(),
      }),
    );
    const link = unwrap(
      engine.linkInstallation({
        tenant: TENANT_A,
        installation: fixtureInstallation(INSTALLATION_A, TENANT_A, V1, T0),
        releaseId: releaseV1.releaseId,
        entitlementId: entitlement.entitlementId,
        by: adminActor(),
      }),
    );
    return {
      engine,
      sink,
      ids: {
        publisherId: publisher.publisherId,
        releaseV1: releaseV1.releaseId,
        releaseV2: releaseV2.releaseId,
        releasePatch: releasePatch.releaseId,
        entitlementId: entitlement.entitlementId,
        linkId: link.linkId,
      },
    };
  };

  // ----- A12: cross-tenant typed rejections, BOTH directions -------------------------------

  it('A12: tenant-scoped queries are typed-rejected cross-tenant (both directions)', () => {
    const { engine, ids } = seeded();
    // a tenant-B-owned record for the reverse direction
    const publisherB = unwrap(
      engine.registerPublisher({
        tenantId: TENANT_B,
        displayName: PUBLISHER_NAME,
        apps: [PROGRESS_APP_ID],
        by: adminActor(),
      }),
    );

    // A's records queried by B → unauthorized / cross-tenant-scope
    for (const probe of [
      () => engine.publisher(TENANT_B, ids.publisherId as never),
      () => engine.entitlement(TENANT_B, ids.entitlementId as never),
      () => engine.installationLink(TENANT_B, ids.linkId as never),
      () => engine.entitledCatalog(TENANT_B, TENANT_A),
      () => engine.publishersOf(TENANT_B, TENANT_A),
      () => engine.entitlementsOf(TENANT_B, TENANT_A),
      () => engine.installationLinksOf(TENANT_B, TENANT_A),
    ]) {
      const rejected = probe();
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('unauthorized');
        expect(rejected.error.details[0]?.code).toBe('cross-tenant-scope');
      }
    }

    // B's records queried by A → the same typed rejection (both directions)
    const reverse = engine.publisher(TENANT_A, publisherB.publisherId);
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) {
      expect(reverse.error.code).toBe('unauthorized');
      expect(reverse.error.details[0]?.code).toBe('cross-tenant-scope');
    }
    // same-tenant queries succeed
    expect(engine.publisher(TENANT_A, ids.publisherId as never).ok).toBe(true);
    expect(engine.publisher(TENANT_B, publisherB.publisherId).ok).toBe(true);
  });

  it('A12: tenant-scoped mutations are typed-rejected cross-tenant (both directions)', () => {
    const { engine, ids } = seeded();
    const publisherB = unwrap(
      engine.registerPublisher({
        tenantId: TENANT_B,
        displayName: PUBLISHER_NAME,
        apps: [PROGRESS_APP_ID],
        by: adminActor(),
      }),
    );
    const installationB = fixtureInstallation(INSTALLATION_B, TENANT_B, V1, T0);

    // B acting on A's records
    expect(failCode(engine.revokePublisher({ tenant: TENANT_B, publisherId: ids.publisherId as never, by: operatorActor() }))).toBe('cross-tenant-scope');
    expect(
      failCode(
        engine.publishRelease({ tenant: TENANT_B, publisherId: ids.publisherId as never, rawManifest: rawManifestPatch, by: adminActor() }),
      ),
    ).toBe('cross-tenant-scope');
    expect(
      failCode(
        engine.linkInstallation({
          tenant: TENANT_B,
          installation: installationB,
          releaseId: ids.releaseV1 as never,
          entitlementId: ids.entitlementId as never,
          by: adminActor(),
        }),
      ),
    ).toBe('cross-tenant-scope');
    expect(failCode(engine.stageUpdate({ tenant: TENANT_B, linkId: ids.linkId as never, toReleaseId: ids.releaseV2 as never, by: operatorActor() }))).toBe('cross-tenant-scope');
    expect(failCode(engine.recordUninstall({ tenant: TENANT_B, linkId: ids.linkId as never, by: operatorActor() }))).toBe('cross-tenant-scope');
    // A acting on B's records
    expect(failCode(engine.revokePublisher({ tenant: TENANT_A, publisherId: publisherB.publisherId, by: operatorActor() }))).toBe('cross-tenant-scope');
  });

  // ----- the revocation gates ----------------------------------------------------------------

  it('a revoked publisher cannot publish (typed-rejected, no release, no audit record)', () => {
    const { engine, sink, ids } = seeded();
    const ledgerBefore = sink.records().length;
    unwrap(engine.revokePublisher({ tenant: TENANT_A, publisherId: ids.publisherId as never, by: adminActor() }));
    const rejected = engine.publishRelease({
      tenant: TENANT_A,
      publisherId: ids.publisherId as never,
      rawManifest: { ...rawManifestV1, manifestVersion: '2.0.0' },
      by: adminActor(),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('publisher-revoked');
    }
    // no new release, no audit record for the rejected publish
    expect(unwrap(engine.catalogEntry(PROGRESS_APP_ID)).versions).toStrictEqual(['1.4.0', '1.4.1', '1.5.0']);
    expect(sink.records().length).toBe(ledgerBefore + 1); // the revocation itself, nothing else
  });

  it('a revoked entitlement cannot install (typed-rejected, no link, no audit record)', () => {
    const { engine, sink, ids } = seeded();
    unwrap(engine.revokeEntitlement({ tenant: TENANT_A, entitlementId: ids.entitlementId as never, by: adminActor() }));
    const ledgerBefore = sink.records().length;
    const rejected = engine.linkInstallation({
      tenant: TENANT_A,
      installation: fixtureInstallation(INSTALLATION_B, TENANT_A, V1, T0),
      releaseId: ids.releaseV1 as never,
      entitlementId: ids.entitlementId as never,
      by: adminActor(),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('entitlement-revoked');
    }
    expect(unwrap(engine.installationLinksOf(TENANT_A, TENANT_A))).toHaveLength(1);
    expect(sink.records().length).toBe(ledgerBefore);
  });

  it('a revoked entitlement cannot update (staging typed-rejected)', () => {
    const { engine, ids } = seeded();
    unwrap(engine.revokeEntitlement({ tenant: TENANT_A, entitlementId: ids.entitlementId as never, by: adminActor() }));
    const rejected = engine.stageUpdate({
      tenant: TENANT_A,
      linkId: ids.linkId as never,
      toReleaseId: ids.releaseV2 as never,
      by: operatorActor(),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('entitlement-revoked');
    }
  });

  // ----- the update discipline -----------------------------------------------------------------

  it('an unchanged-capability update proceeds WITHOUT confirmation', () => {
    const { engine, ids } = seeded();
    const staged = unwrap(
      engine.stageUpdate({ tenant: TENANT_A, linkId: ids.linkId as never, toReleaseId: ids.releasePatch as never, by: operatorActor() }),
    );
    expect(staged.permissionDelta.added).toStrictEqual([]);
    const applied = unwrap(
      engine.applyUpdate({ tenant: TENANT_A, updateId: staged.updateId, by: operatorActor() }),
    );
    expect(applied.update.state).toBe('applied');
    expect(applied.link.currentVersion).toBe('1.4.1');
  });

  it('an added-capability update is typed-rejected without full fresh confirmation', () => {
    const { engine, ids } = seeded();
    const staged = unwrap(
      engine.stageUpdate({ tenant: TENANT_A, linkId: ids.linkId as never, toReleaseId: ids.releaseV2 as never, by: operatorActor() }),
    );
    // no confirmations at all
    expect(failCode(engine.applyUpdate({ tenant: TENANT_A, updateId: staged.updateId, by: operatorActor() }))).toBe('confirmation-required');
    // a confirmation for a capability NOT being added
    expect(
      failCode(
        engine.applyUpdate({
          tenant: TENANT_A,
          updateId: staged.updateId,
          confirmations: [
            unwrap(parsePermissionConfirmation({ kind: 'update-confirmation', capability: 'work.read', scopeKind: 'project' })),
          ],
          by: operatorActor(),
        }),
      ),
    ).toBe('unexpected-confirmation');
    // a duplicate confirmation
    expect(
      failCode(
        engine.applyUpdate({
          tenant: TENANT_A,
          updateId: staged.updateId,
          confirmations: [
            unwrap(parsePermissionConfirmation({ kind: 'update-confirmation', capability: 'cost.read', scopeKind: 'tenant' })),
            unwrap(parsePermissionConfirmation({ kind: 'update-confirmation', capability: 'cost.read', scopeKind: 'tenant' })),
          ],
          by: operatorActor(),
        }),
      ),
    ).toBe('duplicate-confirmation');
    // the exact confirmation applies
    const applied = unwrap(
      engine.applyUpdate({
        tenant: TENANT_A,
        updateId: staged.updateId,
        confirmations: [
          unwrap(parsePermissionConfirmation({ kind: 'update-confirmation', capability: 'cost.read', scopeKind: 'tenant' })),
        ],
        by: operatorActor(),
      }),
    );
    expect(applied.update.state).toBe('applied');
    expect(applied.link.currentVersion).toBe(V2);
  });

  it('an update target must be strictly newer; one staged move per (link, from, to)', () => {
    const { engine, ids } = seeded();
    // the link pins v1.4.0 — staging back to v1.4.0 itself is not a move
    expect(
      failCode(engine.stageUpdate({ tenant: TENANT_A, linkId: ids.linkId as never, toReleaseId: ids.releaseV1 as never, by: operatorActor() })),
    ).toBe('update-target-not-newer');
    // the same staged move twice is a typed duplicate
    unwrap(engine.stageUpdate({ tenant: TENANT_A, linkId: ids.linkId as never, toReleaseId: ids.releaseV2 as never, by: operatorActor() }));
    expect(
      failCode(engine.stageUpdate({ tenant: TENANT_A, linkId: ids.linkId as never, toReleaseId: ids.releaseV2 as never, by: operatorActor() })),
    ).toBe('update-already-staged');
  });

  it('rollback of a staged (never applied) update and uninstall of a severed link are typed-rejected', () => {
    const { engine, ids } = seeded();
    const staged = unwrap(
      engine.stageUpdate({ tenant: TENANT_A, linkId: ids.linkId as never, toReleaseId: ids.releaseV2 as never, by: operatorActor() }),
    );
    expect(failCode(engine.rollbackUpdate({ tenant: TENANT_A, updateId: staged.updateId, by: operatorActor() }))).toBe('update-not-applied');
    unwrap(engine.recordUninstall({ tenant: TENANT_A, linkId: ids.linkId as never, by: operatorActor() }));
    expect(
      failCode(engine.stageUpdate({ tenant: TENANT_A, linkId: ids.linkId as never, toReleaseId: ids.releasePatch as never, by: operatorActor() })),
    ).toBe('installation-link-severed');
  });

  // ----- releases and intake -------------------------------------------------------------------

  it('releases are immutable once published (re-publishing is a typed duplicate)', () => {
    const { engine, sink, ids } = seeded();
    const ledgerBefore = sink.records().length;
    const rejected = engine.publishRelease({
      tenant: TENANT_A,
      publisherId: ids.publisherId as never,
      rawManifest: rawManifestV1,
      by: adminActor(),
    });
    expect(failCode(rejected)).toBe('release-already-published');
    expect(sink.records().length).toBe(ledgerBefore);
    expect(unwrap(engine.catalogEntry(PROGRESS_APP_ID)).versions).toStrictEqual(['1.4.0', '1.4.1', '1.5.0']);
  });

  it('a publisher may only publish its declared app set (typed-rejected otherwise)', () => {
    const { engine, ids } = seeded();
    const foreignApp = { ...rawManifestV1, appId: 'timesheet-logger' };
    const rejected = engine.publishRelease({
      tenant: TENANT_A,
      publisherId: ids.publisherId as never,
      rawManifest: foreignApp,
      by: adminActor(),
    });
    expect(failCode(rejected)).toBe('publisher-app-not-declared');
    expect(engine.catalogEntry(foreignApp.appId as never).ok).toBe(false);
  });

  it('an invalid manifest is typed-rejected through the SDK review (no release, no audit)', () => {
    const engine = fresh();
    const publisher = unwrap(
      engine.registerPublisher({
        tenantId: TENANT_A,
        displayName: PUBLISHER_NAME,
        apps: [PROGRESS_APP_ID],
        by: adminActor(),
      }),
    );
    const rejected = engine.publishRelease({
      tenant: TENANT_A,
      publisherId: publisher.publisherId,
      rawManifest: { ...rawManifestV1, bindings: [{ ...rawManifestV1.bindings[0], commandName: 'nope.nope' }] },
      by: adminActor(),
    });
    expect(rejected.ok).toBe(false);
    expect(engine.catalog()).toHaveLength(0);
  });

  // ----- entitlements ----------------------------------------------------------------------------

  it('duplicate active entitlements are rejected; re-grant after revocation derives a fresh id', () => {
    const { engine, ids } = seeded();
    const range: VersionRange = versionRange('^1.4.0');
    expect(
      failCode(engine.grantEntitlement({ tenant: TENANT_A, appId: PROGRESS_APP_ID, versionRange: range, by: adminActor() })),
    ).toBe('entitlement-already-granted');
    unwrap(engine.revokeEntitlement({ tenant: TENANT_A, entitlementId: ids.entitlementId as never, by: adminActor() }));
    const regranted = unwrap(
      engine.grantEntitlement({ tenant: TENANT_A, appId: PROGRESS_APP_ID, versionRange: range, by: adminActor() }),
    );
    expect(regranted.entitlementId).not.toBe(ids.entitlementId);
    expect(regranted.state).toBe('active');
  });

  it('an entitlement range that does not cover the release is typed-rejected at install', () => {
    const engine = fresh();
    const publisher = unwrap(
      engine.registerPublisher({ tenantId: TENANT_A, displayName: PUBLISHER_NAME, apps: [PROGRESS_APP_ID], by: adminActor() }),
    );
    const releaseV1 = unwrap(
      engine.publishRelease({ tenant: TENANT_A, publisherId: publisher.publisherId, rawManifest: rawManifestV1, by: adminActor() }),
    );
    const releaseV2 = unwrap(
      engine.publishRelease({ tenant: TENANT_A, publisherId: publisher.publisherId, rawManifest: rawManifestV2, by: adminActor() }),
    );
    const exact = unwrap(
      engine.grantEntitlement({ tenant: TENANT_A, appId: PROGRESS_APP_ID, versionRange: versionRange('1.4.0'), by: adminActor() }),
    );
    expect(
      failCode(
        engine.linkInstallation({
          tenant: TENANT_A,
          installation: fixtureInstallation(INSTALLATION_A, TENANT_A, V2, T0),
          releaseId: releaseV2.releaseId,
          entitlementId: exact.entitlementId,
          by: adminActor(),
        }),
      ),
    ).toBe('entitlement-range-unsatisfied');
    // the covered version links fine
    expect(
      engine.linkInstallation({
        tenant: TENANT_A,
        installation: fixtureInstallation(INSTALLATION_B, TENANT_A, V1, T0),
        releaseId: releaseV1.releaseId,
        entitlementId: exact.entitlementId,
        by: adminActor(),
      }).ok,
    ).toBe(true);
  });

  // ----- installation intake gates -----------------------------------------------------------------

  it('installation/release mismatches, double links, and terminal installations are typed-rejected', () => {
    const { engine, ids } = seeded();
    // wrong pinned version
    expect(
      failCode(
        engine.linkInstallation({
          tenant: TENANT_A,
          installation: fixtureInstallation(INSTALLATION_B, TENANT_A, V2, T0),
          releaseId: ids.releaseV1 as never,
          entitlementId: ids.entitlementId as never,
          by: adminActor(),
        }),
      ),
    ).toBe('installation-version-mismatch');
    // already linked
    expect(
      failCode(
        engine.linkInstallation({
          tenant: TENANT_A,
          installation: fixtureInstallation(INSTALLATION_A, TENANT_A, V1, T0),
          releaseId: ids.releaseV1 as never,
          entitlementId: ids.entitlementId as never,
          by: adminActor(),
        }),
      ),
    ).toBe('installation-already-linked');
    // terminal runtime state (the host revoked the installation)
    const revokedInstallation = unwrap(
      revokeInstallation(
        unwrap(activateInstallation(fixtureInstallation(INSTALLATION_C, TENANT_A, V1, T0), { at: T0 })).installation,
        { at: T0, by: operatorActor() },
      ),
    ).installation;
    expect(
      failCode(
        engine.linkInstallation({
          tenant: TENANT_A,
          installation: revokedInstallation,
          releaseId: ids.releaseV1 as never,
          entitlementId: ids.entitlementId as never,
          by: adminActor(),
        }),
      ),
    ).toBe('installation-terminal');
  });

  // ----- not-found + the audit discipline -----------------------------------------------------------

  it('unknown subjects are typed not-found failures', () => {
    const engine = fresh();
    expect(failCode(engine.revokePublisher({ tenant: TENANT_A, publisherId: 'office-pub-v1-0123456789abcdef0123456789abcdef' as never, by: adminActor() }))).toBe('unknown-publisher');
    expect(failCode(engine.stageUpdate({ tenant: TENANT_A, linkId: 'office-lnk-v1-0123456789abcdef0123456789abcdef' as never, toReleaseId: 'office-rel-v1-0123456789abcdef0123456789abcdef' as never, by: operatorActor() }))).toBe('unknown-installation-link');
    expect(failCode(engine.catalogEntry(PROGRESS_APP_ID))).toBe('unknown-catalog-entry');
  });

  it('a failing audit append aborts the operation with NO committed state (append-then-commit)', () => {
    const engine = fresh(failingMarketplaceAuditSink());
    const rejected = engine.registerPublisher({
      tenantId: TENANT_A,
      displayName: PUBLISHER_NAME,
      apps: [PROGRESS_APP_ID],
      by: adminActor(),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.details[0]?.code).toBe('audit-sink-failure');
    }
    // nothing committed — the store never saw the publisher
    expect(unwrap(engine.publishersOf(TENANT_A, TENANT_A))).toStrictEqual([]);
    // and the entitlement path aborts the same way
    expect(
      engine.grantEntitlement({ tenant: TENANT_A, appId: PROGRESS_APP_ID, versionRange: versionRange('^1.4.0'), by: adminActor() }).ok,
    ).toBe(false);
    expect(unwrap(engine.entitlementsOf(TENANT_A, TENANT_A))).toStrictEqual([]);
  });

  // ----- the catalog projections --------------------------------------------------------------------

  it('the global catalog projections are tenant-free deterministic metadata', () => {
    const { engine } = seeded();
    const snapshot = engine.catalog();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.appId).toBe('progress-recorder');
    expect(snapshot[0]?.versions).toStrictEqual(['1.4.0', '1.4.1', '1.5.0']);
    expect(engine.catalog()).toStrictEqual(snapshot);
    const source = engine.catalogSource();
    expect(typeof source.versions).toBe('function');
    // the entitled catalog is the tenant-scoped projection (A12-gated)
    const entitled = unwrap(engine.entitledCatalog(TENANT_A, TENANT_A));
    expect(entitled).toHaveLength(1);
    expect(entitled[0]?.entitlements).toHaveLength(1);
    expect(entitled[0]?.latestVersion).toBe('1.5.0');
  });
});
