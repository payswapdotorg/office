import { describe, expect, it } from 'vitest';
import {
  APP_ONE_FIXTURES,
  APP_TWO_FIXTURES,
  SYSTEM_A,
  goldenStackInputs,
} from './scenarios';
import { TENANT_A, TENANT_B, fixtureEntitlement, fixtureLink, fixtureManifest, fixtureRelease, releaseFixtureId, testId, unwrap } from './test-support';
import { compareObservedSystems, measureStackCoverage, validateStackScanInputs } from './coverage';
import type {
  MeasuredPortfolio,
  ObservedExternalSystem,
  StackScanInputs,
} from './coverage';

// OFF-035 coverage — the fail-closed scan-input validation (strict keys,
// re-parse through the owning packages' own parsers, duplicate identities,
// cross-reference resolution) and THE deterministic workflow coverage
// measurement (typed + evidenced records; canonical orders; the provider
// lists are SETS). Every probe is deterministic: fixed fixtures, no clock,
// no randomness.

const inputsOf = (): StackScanInputs => goldenStackInputs();

describe('the fail-closed scan-input validation', () => {
  it('accepts the golden inputs and returns every list in canonical order', () => {
    const validated = unwrap(validateStackScanInputs(inputsOf()));
    expect(validated.systems.map((s) => `${s.adapterKind}|${s.systemId}`)).toStrictEqual([
      'system-a|instance-01',
      'system-b|instance-02',
      'system-c|instance-03',
    ]);
    expect(validated.systems).toStrictEqual([...validated.systems].sort(compareObservedSystems));
    expect(validated.links.map((l) => l.linkId)).toStrictEqual([...validated.links]
      .map((l) => l.linkId)
      .sort());
    expect(validated.outcomes.map((o) => o.outcomeId)).toStrictEqual(['outcome-0001', 'outcome-0002']);
    expect(validated.benchmarks.map((b) => b.benchmarkId)).toStrictEqual(['benchmark-0001']);
  });

  it('the input arrays\' order never matters (shuffled lists validate identically)', () => {
    const inputs = inputsOf();
    const shuffled: StackScanInputs = {
      systems: [...inputs.systems].reverse(),
      releases: [...inputs.releases].reverse(),
      entitlements: [...inputs.entitlements].reverse(),
      links: [...inputs.links].reverse(),
      outcomes: [...inputs.outcomes].reverse(),
      benchmarks: [...inputs.benchmarks].reverse(),
    };
    expect(JSON.stringify(unwrap(validateStackScanInputs(shuffled)))).toBe(
      JSON.stringify(unwrap(validateStackScanInputs(inputs))),
    );
  });

  it('an unknown field on the wrapper is a typed rejection (records only)', () => {
    const poisoned = { ...inputsOf(), frobnicate: true } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invariant-violation');
    expect(result.error.message).toContain("unknown field(s) 'frobnicate'");
  });

  it('a non-array input list is a typed rejection naming the path', () => {
    const poisoned = { ...inputsOf(), systems: 'nope' } as unknown as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain("expected 'systems' to be an array");
    expect(result.error.details[0]?.path).toBe('systems');
  });

  it('an observed system with the wrong kind literal is a typed rejection', () => {
    const wrongKind = { ...SYSTEM_A(), kind: 'external-system' } as unknown as ObservedExternalSystem;
    const poisoned = { ...inputsOf(), systems: [wrongKind] } as unknown as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain("expected kind 'observed-external-system'");
    expect(result.error.message).toContain('systems[0]');
  });

  it('an observed system with an invalid tenant id is a typed rejection', () => {
    const wrong = { ...SYSTEM_A(), tenantId: 'junk' } as unknown as ObservedExternalSystem;
    const poisoned = { ...inputsOf(), systems: [wrong] } as unknown as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain("expected a tenant id at 'systems[0]'");
    expect(result.error.details[0]?.path).toBe('systems[0].tenantId');
  });

  it('an observed system with an invalid adapter kind is a typed rejection', () => {
    const wrong = { ...SYSTEM_A(), adapterKind: 42 } as unknown as ObservedExternalSystem;
    const poisoned = { ...inputsOf(), systems: [wrong] } as unknown as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain("expected an adapter kind at 'systems[0]'");
    expect(result.error.details[0]?.path).toBe('systems[0].adapterKind');
  });

  it('an observed system with an invalid system id is a typed rejection', () => {
    const wrong = { ...SYSTEM_A(), systemId: '' } as unknown as ObservedExternalSystem;
    const poisoned = { ...inputsOf(), systems: [wrong] } as unknown as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain("expected a provider system id at 'systems[0]'");
    expect(result.error.details[0]?.path).toBe('systems[0].systemId');
  });

  it('declared capabilities are re-parsed through the adapters-sdk grammar (unknown field)', () => {
    const system = SYSTEM_A();
    const poisonedCapabilities = { ...system.capabilities, score: 1 } as never;
    const wrong = { ...system, capabilities: poisonedCapabilities } as unknown as ObservedExternalSystem;
    const poisoned = { ...inputsOf(), systems: [wrong] } as unknown as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('adapters-sdk grammar');
    expect(result.error.details[0]?.path).toBe('systems[0].capabilities');
  });

  it('an adapter that syncs nothing fails the adapters-sdk grammar (>= 1 object kind)', () => {
    const system = SYSTEM_A();
    const poisonedCapabilities = { objectKinds: [] } as never;
    const wrong = { ...system, capabilities: poisonedCapabilities } as unknown as ObservedExternalSystem;
    const poisoned = { ...inputsOf(), systems: [wrong] } as unknown as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('adapters-sdk grammar');
  });

  it('a duplicate observed system is a typed invariant violation', () => {
    const inputs = inputsOf();
    const poisoned = { ...inputs, systems: [SYSTEM_A(), SYSTEM_A()] } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details[0]?.code).toBe('stack-input-duplicate');
    expect(result.error.message).toContain('duplicate observed external system');
  });

  it('a duplicate installation link is a typed invariant violation', () => {
    const inputs = inputsOf();
    const poisoned = { ...inputs, links: [inputs.links[0], inputs.links[0]] } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details[0]?.code).toBe('stack-input-duplicate');
    expect(result.error.message).toContain('duplicate installation link');
  });

  it('a link whose release is not supplied is a typed rejection (never a silent skip)', () => {
    const inputs = inputsOf();
    const appTwo = APP_TWO_FIXTURES();
    const poisoned = { ...inputs, releases: [appTwo.release] } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('which is not supplied');
    expect(result.error.details[0]?.path).toBe('links[0].releaseId');
  });

  it('a link pinning a release that describes a different version is a typed rejection', () => {
    const appOne = APP_ONE_FIXTURES();
    const misPinned = fixtureLink({
      tenantId: TENANT_A,
      installationId: testId('installation', 1),
      appId: 'app-01',
      releaseId: appOne.release.releaseId,
      currentVersion: '9.9.9',
      entitlementId: appOne.entitlement.entitlementId,
    });
    const poisoned = {
      ...inputsOf(),
      links: [misPinned],
    } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain("pins release");
    expect(result.error.message).toContain("'9.9.9'");
  });

  it('a link whose entitlement is not supplied is a typed rejection', () => {
    const appOne = APP_ONE_FIXTURES();
    const poisoned = {
      ...inputsOf(),
      entitlements: [APP_TWO_FIXTURES().entitlement],
      links: [appOne.link],
    } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('which is not supplied');
    expect(result.error.details[0]?.path).toBe('links[0].entitlementId');
  });

  it('a link referencing an entitlement of a different tenant is a typed rejection', () => {
    const appOne = APP_ONE_FIXTURES();
    // The same entitlement record, re-scoped to tenant B (the id stays the
    // tenant-A derived one, so the cross-reference RESOLVES and only the
    // tenant mismatch fires).
    const foreignEntitlement = { ...appOne.entitlement, tenantId: TENANT_B } as never;
    const poisoned = {
      ...inputsOf(),
      entitlements: [foreignEntitlement, APP_TWO_FIXTURES().entitlement],
    } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('different tenant/app');
  });

  it('marketplace records are re-parsed through their own grammar (unknown field)', () => {
    const inputs = inputsOf();
    const poisonedRelease = { ...inputs.releases[0], score: 1 } as never;
    const poisoned = { ...inputs, releases: [poisonedRelease] } as StackScanInputs;
    const result = validateStackScanInputs(poisoned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('releases[0]');
    expect(result.error.message).toContain('marketplace release grammar');
  });
});

describe('the deterministic workflow coverage measurement', () => {
  const goldenPortfolio = (): MeasuredPortfolio => {
    const appOne = APP_ONE_FIXTURES();
    const appTwo = APP_TWO_FIXTURES();
    return {
      systems: [SYSTEM_A(), ...goldenStackInputs().systems.slice(1)],
      apps: [
        { link: appOne.link, release: appOne.release, entitlement: appOne.entitlement, manifest: appOne.manifest },
        { link: appTwo.link, release: appTwo.release, entitlement: appTwo.entitlement, manifest: appTwo.manifest },
      ],
    };
  };

  it('measures one typed coverage record per external system and per installed app', () => {
    const measured = measureStackCoverage(goldenPortfolio());
    expect(measured.systems).toHaveLength(3);
    expect(measured.apps).toHaveLength(2);
    expect(measured.systems.map((s) => s.kind)).toStrictEqual([
      'external-system-coverage',
      'external-system-coverage',
      'external-system-coverage',
    ]);
    expect(measured.apps.map((a) => a.kind)).toStrictEqual([
      'installed-app-coverage',
      'installed-app-coverage',
    ]);
    // Canonical orders: systems by (adapter kind, system id); apps by
    // (app id, link id) — the portfolio arrays' order never matters.
    expect(measured.systems.map((s) => s.adapterKind)).toStrictEqual([
      'system-a',
      'system-b',
      'system-c',
    ]);
    expect(measured.apps.map((a) => a.appId)).toStrictEqual(['app-01', 'app-02']);
  });

  it('the measured portfolio arrays\' order never matters (identical measurement)', () => {
    const portfolio = goldenPortfolio();
    const shuffled: MeasuredPortfolio = {
      systems: [...portfolio.systems].reverse(),
      apps: [...portfolio.apps].reverse(),
    };
    expect(JSON.stringify(measureStackCoverage(shuffled))).toBe(
      JSON.stringify(measureStackCoverage(portfolio)),
    );
  });

  it('an empty portfolio measures nothing', () => {
    expect(measureStackCoverage({ systems: [], apps: [] })).toStrictEqual({
      systems: [],
      apps: [],
    });
  });

  it('one capability evidenced by several object kinds is ONE surface entry, ONE provider reference', () => {
    // The system declares two object kinds ('contact' and 'company') that
    // both translate to organization.read: the capability is evidenced by
    // BOTH object kinds, and the system PROVIDES it exactly once.
    const multiKindSystem = goldenStackInputs().systems[0];
    if (multiKindSystem === undefined) throw new Error('missing system fixture');
    const system = {
      ...multiKindSystem,
      capabilities: {
        objectKinds: [
          { objectKind: 'contact', canonicalKind: 'organization', capability: 'organization.read' },
          { objectKind: 'company', canonicalKind: 'organization', capability: 'organization.read' },
          { objectKind: 'person', canonicalKind: 'organization', capability: 'people.read' },
        ],
      },
    } as unknown as ObservedExternalSystem;
    const appOne = APP_ONE_FIXTURES();
    const measured = measureStackCoverage({
      systems: [system],
      apps: [
        { link: appOne.link, release: appOne.release, entitlement: appOne.entitlement, manifest: appOne.manifest },
      ],
    });
    const systemCoverage = measured.systems[0];
    expect(systemCoverage?.surface).toHaveLength(2);
    const organization = systemCoverage?.surface.find(
      (entry) => entry.capability === 'organization.read',
    );
    expect(organization?.objectKinds).toStrictEqual(['company', 'contact']);
    // Every covered capability references the app installation exactly once.
    for (const entry of systemCoverage?.covered ?? []) {
      expect(entry.providedBy.map((p) => p.linkId)).toStrictEqual([appOne.link.linkId]);
    }
    // The app direction: the overlapping capability references the system
    // exactly ONCE (the provider lists are sets).
    const appCoverage = measured.apps[0];
    const overlapping = appCoverage?.overlapping.find(
      (entry) => entry.capability === 'organization.read',
    );
    expect(overlapping?.providedBy).toHaveLength(1);
    expect(overlapping?.providedBy[0]?.adapterKind).toBe('system-a');
  });

  it('one capability declared by several permission specs is ONE surface entry (both specs evidence it)', () => {
    // app-03 declares organization.read at BOTH scope kinds (allowed: the
    // manifest uniqueness rule is per (capability, scope kind)) — the
    // capability is ONE surface entry evidenced by BOTH specs, and the app
    // PROVIDES it exactly once.
    const manifest = fixtureManifest({
      appId: 'app-03',
      manifestVersion: '1.0.0',
      title: 'Scoped Reader',
      permissions: [
        { capability: 'organization.read', scopeKind: 'tenant' },
        { capability: 'organization.read', scopeKind: 'project' },
      ],
      commands: [],
      events: [],
    });
    const release = fixtureRelease(manifest);
    const entitlement = fixtureEntitlement({
      tenantId: TENANT_A,
      appId: 'app-03',
      range: '^1.0.0',
      ordinal: 1,
    });
    const link = fixtureLink({
      tenantId: TENANT_A,
      installationId: testId('installation', 3),
      appId: 'app-03',
      releaseId: releaseFixtureId('app-03', '1.0.0'),
      currentVersion: '1.0.0',
      entitlementId: entitlement.entitlementId,
    });
    const system = goldenStackInputs().systems[0];
    if (system === undefined) throw new Error('missing system fixture');
    const measured = measureStackCoverage({
      systems: [system],
      apps: [{ link, release, entitlement, manifest }],
    });
    const appCoverage = measured.apps[0];
    expect(appCoverage?.surface).toHaveLength(1);
    expect(appCoverage?.surface[0]?.capability).toBe('organization.read');
    expect(appCoverage?.surface[0]?.specs).toHaveLength(2);
    expect(appCoverage?.surface[0]?.specs.map((spec) => spec.scopeKind).sort()).toStrictEqual([
      'project',
      'tenant',
    ]);
    // The system direction: the covered capability references the app ONCE.
    const systemCoverage = measured.systems[0];
    for (const entry of systemCoverage?.covered ?? []) {
      expect(entry.providedBy).toHaveLength(1);
      expect(entry.providedBy[0]?.appId).toBe('app-03');
    }
  });

  it('the command and subscription surfaces are deduplicated and canonically sorted', () => {
    const appTwo = APP_TWO_FIXTURES();
    const measured = measureStackCoverage({
      systems: [],
      apps: [
        { link: appTwo.link, release: appTwo.release, entitlement: appTwo.entitlement, manifest: appTwo.manifest },
      ],
    });
    expect(measured.apps[0]?.commandSurface).toStrictEqual([
      'contracts.listChangeEvents',
      'cost.listCostItems',
    ]);
    expect(measured.apps[0]?.subscriptionSurface).toStrictEqual(['cost.costItemRecorded']);
  });

  it('a system no installed app declares yields typed, evidenced gaps only', () => {
    const systemB = goldenStackInputs().systems[1];
    if (systemB === undefined) throw new Error('missing system fixture');
    const appOne = APP_ONE_FIXTURES();
    const measured = measureStackCoverage({
      systems: [systemB],
      apps: [
        { link: appOne.link, release: appOne.release, entitlement: appOne.entitlement, manifest: appOne.manifest },
      ],
    });
    const coverage = measured.systems[0];
    expect(coverage?.covered).toStrictEqual([]);
    expect(coverage?.gaps.map((gap) => gap.capability)).toStrictEqual([
      'documents.read',
      'models.read',
    ]);
    expect(coverage?.gaps[0]?.neededBy).toStrictEqual(['document']);
    expect(coverage?.surfaceCount).toBe(2);
    expect(coverage?.coveredCount).toBe(0);
    expect(coverage?.gapCount).toBe(2);
  });

  it('an app whose declared surface no external system provides is entirely unique', () => {
    const appTwo = APP_TWO_FIXTURES();
    const systemB = goldenStackInputs().systems[1];
    if (systemB === undefined) throw new Error('missing system fixture');
    const measured = measureStackCoverage({
      systems: [systemB],
      apps: [
        { link: appTwo.link, release: appTwo.release, entitlement: appTwo.entitlement, manifest: appTwo.manifest },
      ],
    });
    const coverage = measured.apps[0];
    expect(coverage?.overlapping).toStrictEqual([]);
    // Canonical capability order = the authz vocabulary's declaration order
    // (work.read before cost.read before contracts.read).
    expect(coverage?.unique.map((entry) => entry.capability)).toStrictEqual([
      'work.read',
      'cost.read',
      'contracts.read',
    ]);
    expect(coverage?.uniqueCount).toBe(3);
    expect(coverage?.overlappingCount).toBe(0);
  });
});
