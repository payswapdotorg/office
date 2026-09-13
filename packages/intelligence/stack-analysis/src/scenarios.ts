// Office intelligence — package-internal golden scenarios (OFF-035).
//
// THE golden seeded software portfolio of tenant A (generic fixture
// vocabulary only — no real vendor names, no provider vocabulary):
//
//   SYSTEM A ('system-a' / 'instance-01')  — the OVER-COVERED external
//     system: its whole observed capability surface (organization.read,
//     people.read, projects.read) is covered by installed app-01, which
//     declares one capability MORE (work.read) — the installed app strictly
//     over-covers the system (replacement score 3/3 = 1).
//   SYSTEM B ('system-b' / 'instance-02')  — the GAP system: its observed
//     surface (documents.read, models.read) is covered by NO installed app
//     (replacement score 0/2 = 0 — the typed coverage gap).
//   SYSTEM C ('system-c' / 'instance-03')  — the PARTIAL-COVERAGE
//     candidate: its observed surface (cost.read, cost.write,
//     contracts.read, contracts.write) is half covered by installed app-02
//     (replacement score 2/4 = 1/2 — the typed gaps: cost.write,
//     contracts.write).
//   APP-01 ('app-01' v1.2.0) — declares organization.read, people.read,
//     projects.read, work.read; overlaps system-a on three of four
//     (3/4), one unique capability (work.read).
//   APP-02 ('app-02' v2.0.0) — declares cost.read, contracts.read,
//     work.read; overlaps system-c on two of three (2/3), one unique
//     capability (work.read).
//
// The two app releases are published by a TENANT-B publisher (catalog
// records are publisher-tenant-scoped by design — the tenant-A portfolio
// resolves them through its own links), and the observed-performance basis
// is the tenant-A history: two completed-project outcome records plus one
// benchmark over them.
import type { StackScanInputs } from './coverage';
import {
  ASSESSED_AT,
  TENANT_A,
  PROJECT_1,
  PROJECT_2,
  fixtureBenchmark,
  fixtureEntitlement,
  fixtureLink,
  fixtureManifest,
  fixtureOutcomeRecord,
  fixtureRelease,
  fixtureSystem,
  releaseFixtureId,
  testBenchmarkId,
  testId,
  testOutcomeId,
} from './test-support';

/** The golden over-covered external system (its whole surface covered by app-01). */
export const SYSTEM_A = () =>
  fixtureSystem({
    tenantId: TENANT_A,
    adapterKind: 'system-a',
    systemId: 'instance-01',
    objectKinds: [
      { objectKind: 'contact', canonicalKind: 'organization', capability: 'organization.read' },
      { objectKind: 'person', canonicalKind: 'organization', capability: 'people.read' },
      { objectKind: 'project', canonicalKind: 'project', capability: 'projects.read' },
    ],
  });

/** The golden gap external system (no installed app covers any of its surface). */
export const SYSTEM_B = () =>
  fixtureSystem({
    tenantId: TENANT_A,
    adapterKind: 'system-b',
    systemId: 'instance-02',
    objectKinds: [
      { objectKind: 'document', canonicalKind: 'document', capability: 'documents.read' },
      { objectKind: 'model', canonicalKind: 'model', capability: 'models.read' },
    ],
  });

/** The golden partial-coverage external system (half its surface covered by app-02). */
export const SYSTEM_C = () =>
  fixtureSystem({
    tenantId: TENANT_A,
    adapterKind: 'system-c',
    systemId: 'instance-03',
    objectKinds: [
      { objectKind: 'cost-item', canonicalKind: 'cost-item', capability: 'cost.read' },
      { objectKind: 'budget', canonicalKind: 'budget', capability: 'cost.write' },
      { objectKind: 'contract', canonicalKind: 'contract', capability: 'contracts.read' },
      { objectKind: 'change-event', canonicalKind: 'change-event', capability: 'contracts.write' },
    ],
  });

/** The golden over-covering installed app (its surface strictly contains system-a's). */
export const APP_ONE_MANIFEST = () =>
  fixtureManifest({
    appId: 'app-01',
    manifestVersion: '1.2.0',
    title: 'Portfolio Organiser',
    permissions: [
      { capability: 'organization.read', scopeKind: 'tenant' },
      { capability: 'people.read', scopeKind: 'tenant' },
      { capability: 'projects.read', scopeKind: 'tenant' },
      { capability: 'work.read', scopeKind: 'tenant' },
    ],
    commands: ['organization.listOrganizations'],
    events: ['organization.organizationCreated'],
  });

/** The golden partial installed app (covers half of system-c's surface). */
export const APP_TWO_MANIFEST = () =>
  fixtureManifest({
    appId: 'app-02',
    manifestVersion: '2.0.0',
    title: 'Commercial Reader',
    permissions: [
      { capability: 'cost.read', scopeKind: 'project' },
      { capability: 'contracts.read', scopeKind: 'project' },
      { capability: 'work.read', scopeKind: 'project' },
    ],
    commands: ['cost.listCostItems', 'contracts.listChangeEvents'],
    events: ['cost.costItemRecorded'],
  });

/** The golden tenant-A app fixtures (release + entitlement + link, per app). */
export const APP_ONE_FIXTURES = () => {
  const manifest = APP_ONE_MANIFEST();
  const release = fixtureRelease(manifest);
  const entitlement = fixtureEntitlement({
    tenantId: TENANT_A,
    appId: 'app-01',
    range: '^1.0.0',
    ordinal: 1,
  });
  const link = fixtureLink({
    tenantId: TENANT_A,
    installationId: testId('installation', 1),
    appId: 'app-01',
    releaseId: releaseFixtureId('app-01', '1.2.0'),
    currentVersion: '1.2.0',
    entitlementId: entitlement.entitlementId,
  });
  return { manifest, release, entitlement, link };
};

export const APP_TWO_FIXTURES = () => {
  const manifest = APP_TWO_MANIFEST();
  const release = fixtureRelease(manifest);
  const entitlement = fixtureEntitlement({
    tenantId: TENANT_A,
    appId: 'app-02',
    range: '^2.0.0',
    ordinal: 1,
  });
  const link = fixtureLink({
    tenantId: TENANT_A,
    installationId: testId('installation', 2),
    appId: 'app-02',
    releaseId: releaseFixtureId('app-02', '2.0.0'),
    currentVersion: '2.0.0',
    entitlementId: entitlement.entitlementId,
  });
  return { manifest, release, entitlement, link };
};

/** The golden observed-performance basis (two outcomes + one benchmark). */
export const GOLDEN_PERFORMANCE_BASIS = () => {
  const outcomeOne = fixtureOutcomeRecord({
    outcomeId: testOutcomeId(1),
    projectId: PROJECT_1,
    varianceDays: 6,
    changeEventCount: 9,
  });
  const outcomeTwo = fixtureOutcomeRecord({
    outcomeId: testOutcomeId(2),
    projectId: PROJECT_2,
    varianceDays: 0,
    changeEventCount: 7,
  });
  const benchmark = fixtureBenchmark({
    benchmarkId: testBenchmarkId(1),
    outcomeIds: [testOutcomeId(1), testOutcomeId(2)],
  });
  return { outcomes: [outcomeOne, outcomeTwo], benchmark };
};

/**
 * THE golden scan inputs: the three external systems, the two installed
 * apps (releases + entitlements + links), and the observed-performance
 * basis — the seeded portfolio the golden acceptance scans.
 */
export const goldenStackInputs = (): StackScanInputs => {
  const appOne = APP_ONE_FIXTURES();
  const appTwo = APP_TWO_FIXTURES();
  const performance = GOLDEN_PERFORMANCE_BASIS();
  return {
    systems: [SYSTEM_A(), SYSTEM_B(), SYSTEM_C()],
    releases: [appOne.release, appTwo.release],
    entitlements: [appOne.entitlement, appTwo.entitlement],
    links: [appOne.link, appTwo.link],
    outcomes: performance.outcomes,
    benchmarks: [performance.benchmark],
  };
};

/** The golden scan clock (the injected assessedAt of the golden scan). */
export const GOLDEN_ASSESSED_AT = ASSESSED_AT;
