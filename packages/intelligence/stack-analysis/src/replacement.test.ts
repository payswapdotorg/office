import { describe, expect, it } from 'vitest';
import { definePolicy } from '@office/authz';
import { revokeEntitlement, unlinkInstallation } from '@office/marketplace';
import {
  APP_ONE_FIXTURES,
  APP_TWO_FIXTURES,
  GOLDEN_ASSESSED_AT,
  SYSTEM_A,
  goldenStackInputs,
} from './scenarios';
import {
  DENY_ALL_READS_POLICY,
  TENANT_A,
  TENANT_B,
  T1,
  USER_ACTOR,
  fixtureEntitlement,
  fixtureLink,
  fixtureManifest,
  fixtureRelease,
  releaseFixtureId,
  stackAuthorizationOf,
  tenantAScope,
  tenantBScope,
  testId,
  testScanId,
  unwrap,
} from './test-support';
import { assessStackReplacement, compareAssessments } from './replacement';
import type { StackAnalysisResult } from './replacement';
import {
  ASSESSMENT_ID_SEPARATOR,
  ASSESSMENT_KINDS,
  ASSESSMENT_ORDINAL_WIDTH,
  STACK_ASSESSED_EVENT,
  SUGGESTION_KINDS,
  isAssessmentKind,
  isSuggestionKind,
  parseAssessmentKind,
  parseStackScanId,
  parseSuggestionKind,
} from './vocabulary';
import type { StackScanInputs } from './coverage';

// OFF-035 replacement — the deterministic scan's behavior: the gate ORDER
// (capability gate BEFORE any input is read), the A12 structural scope
// coverage in BOTH directions, the measured-portfolio rule (severed links
// and revoked-entitlement links are skipped AND tallied — never silent),
// the policy gate (denied subjects are invisible, tallied), the derived
// suggestion postures (including the undefined empty-surface ratio), the
// scan-derived identity discipline, and the closed vocabulary grammars.

const authorization = () => stackAuthorizationOf(tenantAScope());
const parts = () => ({ scanId: testScanId(1), now: GOLDEN_ASSESSED_AT });

/** Deny reads of one resource kind while allowing every other read. */
const denyKindAllowRestPolicy = (resourceKind: string) =>
  definePolicy([
    { effect: 'deny', resourceKinds: [resourceKind] },
    { effect: 'allow', actions: ['read'] },
  ]);

const scan = (inputs: StackScanInputs = goldenStackInputs()): StackAnalysisResult =>
  unwrap(assessStackReplacement(inputs, authorization(), parts()));

const systemAssessmentOf = (analysis: StackAnalysisResult, adapterKind: string) => {
  const assessment = analysis.assessments.find(
    (candidate) =>
      candidate.coverage.kind === 'external-system-coverage' &&
      candidate.coverage.adapterKind === adapterKind,
  );
  if (assessment === undefined) throw new Error(`no assessment for '${adapterKind}'`);
  return assessment;
};

const appAssessmentOf = (analysis: StackAnalysisResult, appId: string) => {
  const assessment = analysis.assessments.find(
    (candidate) =>
      candidate.coverage.kind === 'installed-app-coverage' && candidate.coverage.appId === appId,
  );
  if (assessment === undefined) throw new Error(`no assessment for '${appId}'`);
  return assessment;
};

describe('the scan gate ORDER (authorization before any input is read)', () => {
  it('the capability gate fires BEFORE the poisoned inputs are read', () => {
    const poisoned = { ...goldenStackInputs(), replacementScore: 0.9 } as StackScanInputs;
    const noCapabilities = stackAuthorizationOf(tenantAScope(), undefined, []);
    const result = assessStackReplacement(poisoned, noCapabilities, parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The forbidden capability denial — NOT the input validation failure:
    // the gate proves no input byte was read.
    expect(result.error.code).toBe('forbidden');
    expect(result.error.details[0]?.code).toBe('missing-stack-capability');
  });

  it('the denial names exactly the missing capabilities', () => {
    const partial = stackAuthorizationOf(tenantAScope(), undefined, ['apps.read']);
    const result = assessStackReplacement(goldenStackInputs(), partial, parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('contracts.read');
    expect(result.error.message).toContain('cost.read');
    expect(result.error.message).toContain('schedule.read');
    expect(result.error.message).not.toContain('missing apps.read');
  });
});

describe('A12 — cross-tenant scan inputs are typed-rejected in BOTH directions', () => {
  it('a tenant-A caller over a tenant-B observed system: unauthorized, path named, scope never revealed', () => {
    const foreignSystem = SYSTEM_A();
    const poisoned = {
      ...goldenStackInputs(),
      systems: [{ ...foreignSystem, tenantId: TENANT_B }, ...goldenStackInputs().systems.slice(1)],
    } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unauthorized');
    expect(result.error.details[0]?.code).toBe('stack-input-scope');
    expect(result.error.details[0]?.path).toBe('systems[0]');
    expect(result.error.message).not.toContain(String(TENANT_B));
  });

  it('a tenant-A caller over a tenant-B installation link: unauthorized at links[i]', () => {
    const appOne = APP_ONE_FIXTURES();
    const foreignEntitlement = fixtureEntitlement({
      tenantId: TENANT_B,
      appId: 'app-01',
      range: '^1.0.0',
      ordinal: 1,
    });
    const foreignLink = fixtureLink({
      tenantId: TENANT_B,
      installationId: testId('installation', 9),
      appId: 'app-01',
      releaseId: appOne.release.releaseId,
      currentVersion: '1.2.0',
      entitlementId: foreignEntitlement.entitlementId,
    });
    const poisoned = {
      ...goldenStackInputs(),
      links: [foreignLink, APP_TWO_FIXTURES().link],
      entitlements: [foreignEntitlement, APP_TWO_FIXTURES().entitlement],
    } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details[0]?.code).toBe('stack-input-scope');
    // The canonically sorted link list places the foreign link last.
    expect(result.error.details[0]?.path).toBe('links[1]');
  });

  it('a tenant-A caller over a tenant-B entitlement: unauthorized at entitlements[i]', () => {
    // An ORPHAN entitlement of tenant B (referenced by no link): it passes
    // the cross-reference validation (nothing references it) and is then
    // scope-rejected — EVERY input record is gated, referenced or not.
    const foreignEntitlement = fixtureEntitlement({
      tenantId: TENANT_B,
      appId: 'app-01',
      range: '^1.0.0',
      ordinal: 9,
    });
    const poisoned = {
      ...goldenStackInputs(),
      entitlements: [...goldenStackInputs().entitlements, foreignEntitlement],
    } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details[0]?.code).toBe('stack-input-scope');
    expect(String(result.error.details[0]?.path)).toMatch(/^entitlements\[\d+\]$/);
  });

  it('a tenant-A caller over a tenant-B outcome record: unauthorized at outcomes[i]', () => {
    const outcome = goldenStackInputs().outcomes[0];
    if (outcome === undefined) throw new Error('missing outcome fixture');
    const foreign = {
      ...outcome,
      scope: { kind: 'project' as const, tenantId: TENANT_B, projectId: outcome.projectId },
    } as never;
    const poisoned = { ...goldenStackInputs(), outcomes: [foreign] } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details[0]?.code).toBe('stack-input-scope');
    expect(result.error.details[0]?.path).toBe('outcomes[0]');
  });

  it('a tenant-A caller over a tenant-B benchmark: unauthorized at benchmarks[i]', () => {
    const benchmark = goldenStackInputs().benchmarks[0];
    if (benchmark === undefined) throw new Error('missing benchmark fixture');
    const foreign = { ...benchmark, scope: { kind: 'tenant' as const, tenantId: TENANT_B } } as never;
    const poisoned = { ...goldenStackInputs(), benchmarks: [foreign] } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details[0]?.code).toBe('stack-input-scope');
    expect(result.error.details[0]?.path).toBe('benchmarks[0]');
  });

  it('the other direction: a tenant-B caller over tenant-A records is equally rejected', () => {
    const tenantB = stackAuthorizationOf(tenantBScope());
    const result = assessStackReplacement(goldenStackInputs(), tenantB, parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('unauthorized');
    expect(result.error.details[0]?.code).toBe('stack-input-scope');
    expect(result.error.details[0]?.path).toBe('systems[0]');
  });
});

describe('the measured-portfolio rule (skips are tallied, never silent)', () => {
  it('a severed (unlinked) installation link is skipped and tallied', () => {
    const appOne = APP_ONE_FIXTURES();
    const severed = unlinkInstallation(appOne.link, { at: T1, by: USER_ACTOR });
    expect(severed.state).toBe('unlinked');
    const inputs = {
      ...goldenStackInputs(),
      links: [severed, APP_TWO_FIXTURES().link],
    } as StackScanInputs;
    const analysis = scan(inputs);
    expect(analysis.consumed.linkCount).toBe(2);
    expect(analysis.consumed.measuredAppCount).toBe(1);
    expect(analysis.consumed.skippedUnlinkedLinkCount).toBe(1);
    expect(analysis.consumed.skippedRevokedEntitlementLinkCount).toBe(0);
    expect(analysis.assessments).toHaveLength(4); // 3 systems + app-02 only.
    // With app-01 gone, system-a has NO coverage at all (all typed gaps,
    // score 0/3).
    const systemA = systemAssessmentOf(analysis, 'system-a');
    expect(systemA.coverage.kind === 'external-system-coverage' && systemA.coverage.gapCount).toBe(3);
    expect(systemA.suggestion.kind).toBe('maintain');
  });

  it('a revoked entitlement skips its link (the app is not measured)', () => {
    const appTwo = APP_TWO_FIXTURES();
    const revoked = revokeEntitlement(appTwo.entitlement, { at: T1, by: USER_ACTOR });
    expect(revoked.state).toBe('revoked');
    const inputs = {
      ...goldenStackInputs(),
      entitlements: [APP_ONE_FIXTURES().entitlement, revoked],
    } as StackScanInputs;
    const analysis = scan(inputs);
    expect(analysis.consumed.measuredAppCount).toBe(1);
    expect(analysis.consumed.skippedRevokedEntitlementLinkCount).toBe(1);
    expect(analysis.consumed.skippedUnlinkedLinkCount).toBe(0);
    expect(analysis.assessments).toHaveLength(4); // 3 systems + app-01 only.
    // With app-02 gone, system-c keeps only its typed gaps (0/4 covered).
    const systemC = systemAssessmentOf(analysis, 'system-c');
    expect(systemC.coverage.kind === 'external-system-coverage' && systemC.coverage.coveredCount).toBe(0);
  });

  it('severed AND revoked together leave the system portfolio unmeasured', () => {
    const appOne = APP_ONE_FIXTURES();
    const appTwo = APP_TWO_FIXTURES();
    const inputs = {
      ...goldenStackInputs(),
      links: [unlinkInstallation(appOne.link, { at: T1, by: USER_ACTOR }), appTwo.link],
      entitlements: [appOne.entitlement, revokeEntitlement(appTwo.entitlement, { at: T1, by: USER_ACTOR })],
    } as StackScanInputs;
    const analysis = scan(inputs);
    expect(analysis.consumed.measuredAppCount).toBe(0);
    expect(analysis.consumed.skippedUnlinkedLinkCount).toBe(1);
    expect(analysis.consumed.skippedRevokedEntitlementLinkCount).toBe(1);
    expect(analysis.assessments).toHaveLength(3); // the systems only.
    for (const assessment of analysis.assessments) {
      expect(assessment.coverage.kind === 'external-system-coverage' && assessment.coverage.coveredCount).toBe(0);
    }
  });
});

describe('the policy gate (denied subjects are invisible, tallied, never errors)', () => {
  it('denying the external-system resource kind excludes every system, apps stay measured', () => {
    const deniedSystems = stackAuthorizationOf(
      tenantAScope(),
      denyKindAllowRestPolicy('external-system'),
    );
    const result = assessStackReplacement(goldenStackInputs(), deniedSystems, parts());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.assessments).toHaveLength(2); // the two apps only.
    expect(result.value.consumed.policySkippedSystemCount).toBe(3);
    expect(result.value.consumed.policySkippedLinkCount).toBe(0);
    expect(result.value.consumed.measuredAppCount).toBe(2);
    expect(scan().consumed.policySkippedSystemCount).toBe(0);
  });

  it('denying the app-installation resource kind excludes every app, systems stay measured', () => {
    const deniedApps = stackAuthorizationOf(
      tenantAScope(),
      denyKindAllowRestPolicy('app-installation'),
    );
    const result = assessStackReplacement(goldenStackInputs(), deniedApps, parts());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.assessments).toHaveLength(3); // the systems only.
    expect(result.value.consumed.policySkippedLinkCount).toBe(2);
    expect(result.value.consumed.policySkippedSystemCount).toBe(0);
    expect(result.value.consumed.measuredAppCount).toBe(0);
    // No app is measured, so every system capability is a typed gap.
    for (const assessment of result.value.assessments) {
      expect(assessment.suggestion.kind).toBe('maintain');
    }
  });

  it('an empty policy denies everything by default (measures nothing, never errors)', () => {
    const emptyPolicy = stackAuthorizationOf(tenantAScope(), DENY_ALL_READS_POLICY);
    const result = assessStackReplacement(goldenStackInputs(), emptyPolicy, parts());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.assessments).toStrictEqual([]);
    expect(result.value.consumed.policySkippedSystemCount).toBe(3);
    expect(result.value.consumed.policySkippedLinkCount).toBe(2);
  });
});

describe('the derived suggestion postures (data only, derived from the composition)', () => {
  it('a declared-capability-less app has an UNDEFINED ratio (null value) and a maintain posture', () => {
    const manifest = fixtureManifest({
      appId: 'app-04',
      manifestVersion: '1.0.0',
      title: 'Empty Surface',
      permissions: [],
      commands: [],
      events: [],
    });
    const release = fixtureRelease(manifest);
    const entitlement = fixtureEntitlement({
      tenantId: TENANT_A,
      appId: 'app-04',
      range: '^1.0.0',
      ordinal: 1,
    });
    const link = fixtureLink({
      tenantId: TENANT_A,
      installationId: testId('installation', 4),
      appId: 'app-04',
      releaseId: releaseFixtureId('app-04', '1.0.0'),
      currentVersion: '1.0.0',
      entitlementId: entitlement.entitlementId,
    });
    const inputs = {
      ...goldenStackInputs(),
      releases: [...goldenStackInputs().releases, release],
      entitlements: [...goldenStackInputs().entitlements, entitlement],
      links: [...goldenStackInputs().links, link],
    } as StackScanInputs;
    const analysis = scan(inputs);
    const appFour = appAssessmentOf(analysis, 'app-04');
    expect(appFour.score.value).toBeNull();
    expect(appFour.score.coveredCount).toBe(0);
    expect(appFour.score.surfaceCount).toBe(0);
    expect(appFour.suggestion.kind).toBe('maintain');
    expect(appFour.suggestion.reasons).toContain('no-declared-capability-surface');
    // The other assessments are unchanged (the golden five + app-04 = six).
    expect(analysis.assessments).toHaveLength(6);
  });

  it('the golden postures are pinned (consolidate / extend-coverage / maintain)', () => {
    const analysis = scan();
    expect(systemAssessmentOf(analysis, 'system-a').suggestion.kind).toBe('consolidate');
    expect(systemAssessmentOf(analysis, 'system-b').suggestion.kind).toBe('maintain');
    expect(systemAssessmentOf(analysis, 'system-c').suggestion.kind).toBe('extend-coverage');
    expect(appAssessmentOf(analysis, 'app-01').suggestion.kind).toBe('extend-coverage');
    expect(appAssessmentOf(analysis, 'app-02').suggestion.kind).toBe('extend-coverage');
  });

  it('the deterministic titles carry the counted composition', () => {
    const analysis = scan();
    expect(systemAssessmentOf(analysis, 'system-a').title).toBe(
      "External system 'system-a/instance-01': 3/3 observed capabilities covered by installed apps",
    );
    expect(appAssessmentOf(analysis, 'app-01').title).toBe(
      "Installed app 'app-01' 1.2.0: 3/4 declared capabilities provided by external systems",
    );
  });
});

describe('the scan-derived identity discipline', () => {
  it('assessment ids are <scanId>#<ordinal> with the pinned separator and width', () => {
    const analysis = scan();
    expect(analysis.assessments[0]?.assessmentId).toBe(
      `scan-0001${ASSESSMENT_ID_SEPARATOR}${String(1).padStart(ASSESSMENT_ORDINAL_WIDTH, '0')}`,
    );
    expect(analysis.assessments).toHaveLength(5);
    expect(analysis.assessments[4]?.assessmentId).toBe('scan-0001#0005');
  });

  it('a different scan identity produces disjoint assessment ids', () => {
    const other = unwrap(
      assessStackReplacement(goldenStackInputs(), authorization(), {
        scanId: testScanId(2),
        now: GOLDEN_ASSESSED_AT,
      }),
    );
    expect(other.assessments[0]?.assessmentId).toBe('scan-0002#0001');
    const goldenIds = new Set(scan().assessments.map((a) => a.assessmentId));
    for (const assessment of other.assessments) {
      expect(goldenIds.has(assessment.assessmentId)).toBe(false);
    }
  });

  it('a scan id that leaves no room for the ordinal suffix is a typed rejection', () => {
    const longScanId = unwrap(parseStackScanId('s'.repeat(125)));
    const result = assessStackReplacement(goldenStackInputs(), authorization(), {
      scanId: longScanId,
      now: GOLDEN_ASSESSED_AT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.details[0]?.code).toBe('stack-assessment-id-unreachable');
    expect(result.error.message).toContain('leaves no room for the ordinal suffix');
  });

  it('the emission order is the canonical comparator order', () => {
    const analysis = scan();
    expect([...analysis.assessments].reverse().sort(compareAssessments)).toStrictEqual(
      analysis.assessments,
    );
  });
});

describe('the observed-performance basis + the evidence chain', () => {
  it('no memory records supplied: the performance basis is null and carries no memory evidence', () => {
    const inputs = goldenStackInputs();
    const bare = {
      systems: inputs.systems,
      releases: inputs.releases,
      entitlements: inputs.entitlements,
      links: inputs.links,
      outcomes: [],
      benchmarks: [],
    } as StackScanInputs;
    const analysis = scan(bare);
    for (const assessment of analysis.assessments) {
      expect(assessment.performanceBasis).toBeNull();
      const memoryEvidence = assessment.evidence.filter(
        (evidence) => evidence.evidenceKind === 'outcome' || evidence.evidenceKind === 'benchmark',
      );
      expect(memoryEvidence).toStrictEqual([]);
    }
  });

  it('the system assessment\'s evidence chain is canonical: subject, providers, memory basis', () => {
    const analysis = scan();
    const systemA = systemAssessmentOf(analysis, 'system-a');
    const kinds = systemA.evidence.map((evidence) => evidence.evidenceKind);
    expect(kinds).toStrictEqual([
      'system',
      'installation-link',
      'release',
      'entitlement',
      'outcome',
      'outcome',
      'benchmark',
    ]);
    expect(systemA.evidence[0]).toStrictEqual({
      evidenceKind: 'system',
      kind: 'external-system-ref',
      adapterKind: 'system-a',
      systemId: 'instance-01',
    });
    expect(systemA.performanceBasis).toStrictEqual({
      outcomeIds: ['outcome-0001', 'outcome-0002'],
      benchmarkIds: ['benchmark-0001'],
    });
  });

  it('the app assessment\'s evidence chain is canonical (subject linkage, providing systems, memory basis)', () => {
    const analysis = scan();
    const appOne = appAssessmentOf(analysis, 'app-01');
    // The three overlapping capabilities are all provided by the SAME
    // system — the canonical evidence chain DEDUPLICATES it to one ref.
    const kinds = appOne.evidence.map((evidence) => evidence.evidenceKind);
    expect(kinds).toStrictEqual([
      'system',
      'installation-link',
      'release',
      'entitlement',
      'outcome',
      'outcome',
      'benchmark',
    ]);
    expect(appOne.evidence[0]).toStrictEqual({
      evidenceKind: 'system',
      kind: 'external-system-ref',
      adapterKind: 'system-a',
      systemId: 'instance-01',
    });
  });
});

describe('the closed vocabulary grammars (fail-closed)', () => {
  it('the assessment kinds parse and reject fail-closed', () => {
    expect(ASSESSMENT_KINDS).toStrictEqual(['external-system', 'installed-app']);
    expect(unwrap(parseAssessmentKind('installed-app'))).toBe('installed-app');
    expect(parseAssessmentKind('bogus').ok).toBe(false);
    expect(parseAssessmentKind(42).ok).toBe(false);
    expect(isAssessmentKind('external-system')).toBe(true);
    expect(isAssessmentKind(null)).toBe(false);
  });

  it('the suggestion kinds parse and reject fail-closed', () => {
    expect(SUGGESTION_KINDS).toStrictEqual(['consolidate', 'extend-coverage', 'maintain']);
    expect(unwrap(parseSuggestionKind('maintain'))).toBe('maintain');
    expect(parseSuggestionKind('uninstall').ok).toBe(false);
    expect(isSuggestionKind('consolidate')).toBe(true);
    expect(isSuggestionKind('delete')).toBe(false);
  });

  it('the emitted event name follows the intelligence family grammar', () => {
    expect(STACK_ASSESSED_EVENT).toBe('intelligence.replacementAssessed');
  });
});
