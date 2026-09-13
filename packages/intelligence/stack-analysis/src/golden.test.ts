import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rationalOf } from '@office/intelligence-memory';
import type { Rational } from '@office/intelligence-memory';
import {
  APP_ONE_FIXTURES,
  APP_TWO_FIXTURES,
  GOLDEN_ASSESSED_AT,
  SYSTEM_A,
  SYSTEM_B,
  SYSTEM_C,
  goldenStackInputs,
} from './scenarios';
import {
  ASSESSED_AT,
  DENY_ALL_READS_POLICY,
  TENANT_A,
  TENANT_B,
  stackAuthorizationOf,
  tenantAScope,
  testScanId,
  unwrap,
} from './test-support';
import { assessStackReplacement, compareAssessments } from './replacement';
import type { ReplacementAssessment, StackAnalysisResult } from './replacement';
import { REPLACEMENT_FORMULA } from './model';
import { parseAssessmentId, parseStackScanId } from './vocabulary';
import type { StackScanInputs } from './coverage';

// OFF-035 THE named acceptance — the golden seeded software portfolio:
// the over-covered external system (an installed app strictly over-covers
// it), the gap system (no coverage), and the partial-coverage candidate,
// producing typed ReplacementAssessment records whose scores are COMPUTED
// from the observed coverage composition (recomputed BY HAND below from
// the referenced records), with the structural no-manual-score proof (no
// score input exists anywhere in the package's surface).
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const authorization = () => stackAuthorizationOf(tenantAScope());
const parts = () => ({ scanId: testScanId(1), now: GOLDEN_ASSESSED_AT });

const scan = (): StackAnalysisResult =>
  unwrap(assessStackReplacement(goldenStackInputs(), authorization(), parts()));

const assessmentsOf = (): readonly ReplacementAssessment[] => scan().assessments;

/** Loud fixture accessor (noUncheckedIndexedAccess-safe; failures are test bugs). */
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) {
    throw new Error(`missing golden fixture: ${what}`);
  }
  return value;
};

const systemAssessmentOf = (adapterKind: string): ReplacementAssessment => {
  const assessment = assessmentsOf().find(
    (candidate) =>
      candidate.coverage.kind === 'external-system-coverage' &&
      candidate.coverage.adapterKind === adapterKind,
  );
  if (assessment === undefined) {
    throw new Error(`no golden system assessment for '${adapterKind}'`);
  }
  return assessment;
};

const appAssessmentOf = (appId: string): ReplacementAssessment => {
  const assessment = assessmentsOf().find(
    (candidate) =>
      candidate.coverage.kind === 'installed-app-coverage' && candidate.coverage.appId === appId,
  );
  if (assessment === undefined) {
    throw new Error(`no golden app assessment for '${appId}'`);
  }
  return assessment;
};

describe('OFF-035 golden portfolio — the derived replacement scores', () => {
  it('produces exactly five assessments in the canonical emission order with scan-derived ids', () => {
    const analysis = scan();
    expect(analysis.assessments).toHaveLength(5);
    expect(analysis.assessments.map((assessment) => assessment.assessmentId)).toStrictEqual([
      'scan-0001#0001',
      'scan-0001#0002',
      'scan-0001#0003',
      'scan-0001#0004',
      'scan-0001#0005',
    ]);
    expect(analysis.scanId).toBe('scan-0001');
    expect(analysis.analysisVersion).toBe(1);
    expect(analysis.engine).toBe('intelligence-stack-analysis');
    expect(analysis.assessedAt).toBe(GOLDEN_ASSESSED_AT);
    // The emission order equals the canonical comparator order (systems,
    // then apps — the closed assessment-kind vocabulary's order).
    const shuffled = [...analysis.assessments].reverse();
    expect([...shuffled].sort(compareAssessments)).toStrictEqual(analysis.assessments);
  });

  it('the over-covered external system: score 3/3 (the installed app strictly over-covers it)', () => {
    const assessment = systemAssessmentOf('system-a');
    expect(assessment.kind).toBe('external-system');
    const coverage = assessment.coverage;
    expect(coverage.kind).toBe('external-system-coverage');
    if (coverage.kind !== 'external-system-coverage') throw new Error('unreachable');
    expect(coverage.surface.map((entry) => entry.capability)).toStrictEqual([
      'organization.read',
      'people.read',
      'projects.read',
    ]);
    expect(coverage.covered.map((entry) => entry.capability)).toStrictEqual([
      'organization.read',
      'people.read',
      'projects.read',
    ]);
    expect(coverage.gaps).toStrictEqual([]);
    expect(coverage.surfaceCount).toBe(3);
    expect(coverage.coveredCount).toBe(3);
    expect(coverage.gapCount).toBe(0);
    // The evidence: every covered capability is provided by app-01's installation.
    for (const entry of coverage.covered) {
      expect(entry.providedBy.map((provider) => provider.appId)).toStrictEqual(['app-01']);
    }
    expect(assessment.score.coveredCount).toBe(3);
    expect(assessment.score.surfaceCount).toBe(3);
    expect(assessment.score.value).toEqual(unwrap(rationalOf(1, 1)));
    expect(assessment.suggestion.kind).toBe('consolidate');
    expect(assessment.suggestion.reasons).toContain('coverage-complete');
    // The over-coverage: app-01's declared surface strictly CONTAINS the system's.
    const appOne = appAssessmentOf('app-01').coverage;
    expect(appOne.kind).toBe('installed-app-coverage');
    if (appOne.kind !== 'installed-app-coverage') throw new Error('unreachable');
    for (const capability of coverage.surface.map((entry) => entry.capability)) {
      expect(appOne.surface.map((entry) => entry.capability)).toContain(capability);
    }
    expect(appOne.surface).toHaveLength(4);
  });

  it('the gap system: score 0/2 with the typed, evidenced coverage gaps', () => {
    const assessment = systemAssessmentOf('system-b');
    const coverage = assessment.coverage;
    expect(coverage.kind).toBe('external-system-coverage');
    if (coverage.kind !== 'external-system-coverage') throw new Error('unreachable');
    expect(coverage.covered).toStrictEqual([]);
    expect(coverage.gaps.map((gap) => gap.capability)).toStrictEqual([
      'documents.read',
      'models.read',
    ]);
    // Every gap is evidenced by the object kinds that need it.
    expect(coverage.gaps[0]?.neededBy).toStrictEqual(['document']);
    expect(coverage.gaps[1]?.neededBy).toStrictEqual(['model']);
    expect(coverage.surfaceCount).toBe(2);
    expect(coverage.coveredCount).toBe(0);
    expect(assessment.score.value).toEqual(unwrap(rationalOf(0, 1)));
    expect(assessment.suggestion.kind).toBe('maintain');
    expect(assessment.suggestion.reasons).toContain('coverage-none');
  });

  it('the partial-coverage candidate: score 2/4 with the typed gaps cost.write/contracts.write', () => {
    const assessment = systemAssessmentOf('system-c');
    const coverage = assessment.coverage;
    expect(coverage.kind).toBe('external-system-coverage');
    if (coverage.kind !== 'external-system-coverage') throw new Error('unreachable');
    expect(coverage.covered.map((entry) => entry.capability)).toStrictEqual([
      'cost.read',
      'contracts.read',
    ]);
    expect(coverage.gaps.map((gap) => gap.capability)).toStrictEqual([
      'cost.write',
      'contracts.write',
    ]);
    for (const entry of coverage.covered) {
      expect(entry.providedBy.map((provider) => provider.appId)).toStrictEqual(['app-02']);
    }
    expect(assessment.score.value).toEqual(unwrap(rationalOf(1, 2)));
    expect(assessment.suggestion.kind).toBe('extend-coverage');
    expect(assessment.suggestion.reasons).toContain('coverage-partial');
    expect(assessment.suggestion.reasons).toContain('gap-capabilities:2');
  });

  it('the installed-app direction: app-01 scores 3/4, app-02 scores 2/3 (overlap fractions)', () => {
    const appOne = appAssessmentOf('app-01');
    expect(appOne.kind).toBe('installed-app');
    const oneCoverage = appOne.coverage;
    expect(oneCoverage.kind).toBe('installed-app-coverage');
    if (oneCoverage.kind !== 'installed-app-coverage') throw new Error('unreachable');
    expect(oneCoverage.surface.map((entry) => entry.capability)).toStrictEqual([
      'organization.read',
      'people.read',
      'projects.read',
      'work.read',
    ]);
    expect(oneCoverage.overlapping.map((entry) => entry.capability)).toStrictEqual([
      'organization.read',
      'people.read',
      'projects.read',
    ]);
    for (const entry of oneCoverage.overlapping) {
      expect(entry.providedBy.map((provider) => provider.adapterKind)).toStrictEqual(['system-a']);
    }
    expect(oneCoverage.unique.map((entry) => entry.capability)).toStrictEqual(['work.read']);
    expect(oneCoverage.commandSurface).toStrictEqual(['organization.listOrganizations']);
    expect(oneCoverage.subscriptionSurface).toStrictEqual(['organization.organizationCreated']);
    expect(appOne.score.value).toEqual(unwrap(rationalOf(3, 4)));
    expect(appOne.suggestion.kind).toBe('extend-coverage');

    const appTwo = appAssessmentOf('app-02');
    const twoCoverage = appTwo.coverage;
    expect(twoCoverage.kind).toBe('installed-app-coverage');
    if (twoCoverage.kind !== 'installed-app-coverage') throw new Error('unreachable');
    expect(twoCoverage.overlapping.map((entry) => entry.capability)).toStrictEqual([
      'cost.read',
      'contracts.read',
    ]);
    expect(twoCoverage.unique.map((entry) => entry.capability)).toStrictEqual(['work.read']);
    expect(twoCoverage.commandSurface).toStrictEqual([
      'contracts.listChangeEvents',
      'cost.listCostItems',
    ]);
    expect(twoCoverage.subscriptionSurface).toStrictEqual(['cost.costItemRecorded']);
    expect(appTwo.score.value).toEqual(unwrap(rationalOf(2, 3)));
    expect(appTwo.suggestion.kind).toBe('extend-coverage');
  });

  it('THE acceptance — every score recomputed BY HAND from the referenced records matches', () => {
    const inputs = goldenStackInputs();
    // The measured installed apps (the linked + active-entitlement portfolio).
    const measuredApps = inputs.links.map((link) =>
      must(
        inputs.releases.find((entry) => entry.releaseId === link.releaseId),
        `release of link '${link.linkId}'`,
      ),
    );
    expect(measuredApps).toHaveLength(2);
    // The app-side capability universe: the union of the measured manifests'
    // declared permissions (the observed workflow/capability surface).
    const appCapabilityUniverse = new Set<string>();
    for (const release of measuredApps) {
      for (const spec of release.manifest.permissions) {
        appCapabilityUniverse.add(spec.capability);
      }
    }
    // The system-side capability universe: the union of the observed systems'
    // declared object-kind capabilities.
    const systemCapabilityUniverse = new Set<string>();
    for (const system of inputs.systems) {
      for (const objectCapability of system.capabilities.objectKinds) {
        systemCapabilityUniverse.add(objectCapability.capability);
      }
    }

    for (const assessment of scan().assessments) {
      // The referenced records of THIS assessment's subject.
      if (assessment.coverage.kind === 'external-system-coverage') {
        const subjectCoverage = assessment.coverage;
        const { adapterKind, systemId } = subjectCoverage;
        const subject = must(
          inputs.systems.find(
            (entry) => entry.adapterKind === adapterKind && entry.systemId === systemId,
          ),
          `observed system '${adapterKind}/${systemId}'`,
        );
        // BY HAND: surface = the observed object-kind capabilities; covered =
        // those the installed apps declare; score = covered/surface.
        const surface = new Set<string>(
          subject.capabilities.objectKinds.map((entry) => entry.capability),
        );
        const covered = [...surface].filter((capability) => appCapabilityUniverse.has(capability));
        expect(assessment.score.surfaceCount).toBe(surface.size);
        expect(assessment.score.coveredCount).toBe(covered.length);
        expect(assessment.score.value).toEqual(
          unwrap(rationalOf(covered.length, surface.size)) as Rational,
        );
        // SET equality (the engine's canonical capability order is the authz
        // declaration order — the BY-HAND recompute checks the SET, not the
        // engine's ordering choice).
        expect([...assessment.coverage.surface.map((entry) => entry.capability)].sort())
          .toStrictEqual([...surface].sort());
        expect([...assessment.coverage.covered.map((entry) => entry.capability)].sort())
          .toStrictEqual([...covered].sort());
      } else {
        const subjectCoverage = assessment.coverage;
        const subject = must(
          inputs.releases.find(
            (entry) => entry.releaseId === subjectCoverage.releaseId,
          ),
          `release '${subjectCoverage.releaseId}'`,
        );
        // BY HAND: surface = the pinned manifest's declared permissions; the
        // overlap = those the external systems also provide; score = the ratio.
        const surface = new Set<string>(
          subject.manifest.permissions.map((spec) => spec.capability),
        );
        const overlapped = [...surface].filter((capability) =>
          systemCapabilityUniverse.has(capability),
        );
        expect(assessment.score.surfaceCount).toBe(surface.size);
        expect(assessment.score.coveredCount).toBe(overlapped.length);
        expect(assessment.score.value).toEqual(
          unwrap(rationalOf(overlapped.length, surface.size)) as Rational,
        );
        // SET equality (the engine's canonical capability order is the authz
        // declaration order — the BY-HAND recompute checks the SET, not the
        // engine's ordering choice).
        expect([...assessment.coverage.surface.map((entry) => entry.capability)].sort())
          .toStrictEqual([...surface].sort());
        expect([...assessment.coverage.overlapping.map((entry) => entry.capability)].sort())
          .toStrictEqual([...overlapped].sort());
      }
      // The composition is exposed: the formula constant + both counts.
      expect(assessment.score.formula).toBe(REPLACEMENT_FORMULA);
      // The counts agree with the assessment's OWN coverage lists.
      if (assessment.coverage.kind === 'external-system-coverage') {
        expect(assessment.score.coveredCount).toBe(assessment.coverage.covered.length);
        expect(assessment.score.surfaceCount).toBe(assessment.coverage.surface.length);
      } else {
        expect(assessment.score.coveredCount).toBe(assessment.coverage.overlapping.length);
        expect(assessment.score.surfaceCount).toBe(assessment.coverage.surface.length);
      }
    }
  });

  it('every evidence reference resolves to a golden input record (A4, end to end)', () => {
    const inputs = goldenStackInputs();
    const systemKeys = new Set(
      inputs.systems.map((system) => `${system.adapterKind}|${system.systemId}`),
    );
    const linkIds = new Set(inputs.links.map((link) => link.linkId));
    const releaseIds = new Set(inputs.releases.map((release) => release.releaseId));
    const entitlementIds = new Set(
      inputs.entitlements.map((entitlement) => entitlement.entitlementId),
    );
    const outcomeIds = new Set(inputs.outcomes.map((outcome) => outcome.outcomeId));
    const benchmarkIds = new Set(inputs.benchmarks.map((benchmark) => benchmark.benchmarkId));
    for (const assessment of scan().assessments) {
      expect(assessment.evidence.length).toBeGreaterThan(0);
      for (const evidence of assessment.evidence) {
        switch (evidence.evidenceKind) {
          case 'system':
            expect(systemKeys.has(`${evidence.adapterKind}|${evidence.systemId}`)).toBe(true);
            break;
          case 'installation-link':
            expect(linkIds.has(evidence.linkId)).toBe(true);
            break;
          case 'release':
            expect(releaseIds.has(evidence.releaseId)).toBe(true);
            break;
          case 'entitlement':
            expect(entitlementIds.has(evidence.entitlementId)).toBe(true);
            break;
          case 'outcome':
            expect(outcomeIds.has(evidence.outcomeId)).toBe(true);
            break;
          case 'benchmark':
            expect(benchmarkIds.has(evidence.benchmarkId)).toBe(true);
            break;
        }
      }
    }
  });

  it('the observed-performance basis is the referenced outcome/benchmark ids (carried evidence)', () => {
    for (const assessment of scan().assessments) {
      expect(assessment.performanceBasis).not.toBeNull();
      expect(assessment.performanceBasis?.outcomeIds).toStrictEqual([
        'outcome-0001',
        'outcome-0002',
      ]);
      expect(assessment.performanceBasis?.benchmarkIds).toStrictEqual(['benchmark-0001']);
    }
  });

  it('the consumed tallies record the whole scan shape (no silent skips)', () => {
    const analysis = scan();
    expect(analysis.consumed).toStrictEqual({
      systemCount: 3,
      releaseCount: 2,
      entitlementCount: 2,
      linkCount: 2,
      measuredAppCount: 2,
      skippedUnlinkedLinkCount: 0,
      skippedRevokedEntitlementLinkCount: 0,
      policySkippedSystemCount: 0,
      policySkippedLinkCount: 0,
      outcomeCount: 2,
      benchmarkCount: 1,
      assessmentCount: 5,
    });
    for (const assessment of analysis.assessments) {
      expect(assessment.provenance.scanId).toBe('scan-0001');
      expect(assessment.provenance.consumed).toStrictEqual(analysis.consumed);
    }
  });

  it('run-twice byte-identical, and shuffled inputs produce the identical analysis', () => {
    const first = scan();
    const second = scan();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const inputs = goldenStackInputs();
    const systemAt = (index: number) => must(inputs.systems[index], `systems[${index}]`);
    const linkAt = (index: number) => must(inputs.links[index], `links[${index}]`);
    const outcomeAt = (index: number) => must(inputs.outcomes[index], `outcomes[${index}]`);
    const permutations: readonly StackScanInputs[] = [
      {
        systems: [...inputs.systems].reverse(),
        releases: [...inputs.releases].reverse(),
        entitlements: [...inputs.entitlements].reverse(),
        links: [...inputs.links].reverse(),
        outcomes: [...inputs.outcomes].reverse(),
        benchmarks: [...inputs.benchmarks].reverse(),
      },
      {
        systems: [systemAt(2), systemAt(0), systemAt(1)],
        releases: inputs.releases,
        entitlements: inputs.entitlements,
        links: [linkAt(1), linkAt(0)],
        outcomes: [outcomeAt(1), outcomeAt(0)],
        benchmarks: inputs.benchmarks,
      },
      {
        systems: [systemAt(1), systemAt(2), systemAt(0)],
        releases: inputs.releases,
        entitlements: inputs.entitlements,
        links: inputs.links,
        outcomes: inputs.outcomes,
        benchmarks: inputs.benchmarks,
      },
    ];
    for (const [index, permutation] of permutations.entries()) {
      const shuffled = unwrap(
        assessStackReplacement(permutation, authorization(), parts()),
      );
      expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
      expect(shuffled.assessments.map((a) => a.assessmentId)).toStrictEqual(
        first.assessments.map((a) => a.assessmentId),
      );
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it('suggestion-only: every assessment exits as typed data (no command, no executable surface)', () => {
    for (const assessment of scan().assessments) {
      const suggestion = assessment.suggestion;
      expect(['consolidate', 'extend-coverage', 'maintain']).toContain(suggestion.kind);
      expect(typeof suggestion.rationale).toBe('string');
      expect(suggestion.reasons.length).toBeGreaterThan(0);
      // No command references and no executable vocabulary anywhere in the
      // suggestion — the only exit is a typed data record.
      const serialized = JSON.stringify(suggestion);
      expect(serialized).not.toContain('commandName');
      expect(serialized).not.toContain('command');
      expect(serialized).not.toContain('payload');
    }
  });
});

// ---------------------------------------------------------------------------
// THE structural no-manual-score proof: no score input exists anywhere in
// the package's surface — the scan inputs carry records only, every score
// is a computed field, and a manual score fed anywhere into the fail-closed
// input validation is a typed unknown-field rejection.
// ---------------------------------------------------------------------------

describe('OFF-035 THE structural no-manual-score proof', () => {
  it('a manual score fed into the scan-input WRAPPER is a typed unknown-field rejection', () => {
    const poisoned = {
      ...goldenStackInputs(),
      replacementScore: 0.9,
    } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('invariant-violation');
    expect(result.error.message).toContain("unknown field(s) 'replacementScore'");
    expect(result.error.message).toContain('no score, weight, or manual input of any kind');
  });

  it('a manual score fed into an OBSERVED SYSTEM record is a typed unknown-field rejection', () => {
    const systemA = SYSTEM_A();
    const poisoned = {
      ...goldenStackInputs(),
      systems: [{ ...systemA, manualScore: 1 }, SYSTEM_B(), SYSTEM_C()],
    } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain("unknown field(s) 'manualScore'");
    expect(result.error.message).toContain('systems[0]');
  });

  it('a manual score fed into a memory record is a typed unknown-field rejection', () => {
    const inputs = goldenStackInputs();
    const outcome = must(inputs.outcomes[0], 'outcomes[0]');
    const poisonedOutcome = { ...outcome, score: 5 } as never;
    const poisoned = {
      ...inputs,
      outcomes: [poisonedOutcome, inputs.outcomes[1]],
    } as StackScanInputs;
    const outcomeResult = assessStackReplacement(poisoned, authorization(), parts());
    expect(outcomeResult.ok).toBe(false);
    if (outcomeResult.ok) throw new Error('unreachable');
    expect(outcomeResult.error.message).toContain("unknown field(s) 'score'");

    const benchmark = must(inputs.benchmarks[0], 'benchmarks[0]');
    const poisonedBenchmark = { ...benchmark, score: 5 } as never;
    const poisonedTwo = {
      ...inputs,
      benchmarks: [poisonedBenchmark],
    } as StackScanInputs;
    const benchmarkResult = assessStackReplacement(poisonedTwo, authorization(), parts());
    expect(benchmarkResult.ok).toBe(false);
    if (benchmarkResult.ok) throw new Error('unreachable');
    expect(benchmarkResult.error.message).toContain("unknown field(s) 'score'");
  });

  it('a manual score fed into a marketplace record is rejected by its own strict parser', () => {
    const inputs = goldenStackInputs();
    const link = must(inputs.links[0], 'links[0]');
    const poisonedLink = { ...link, score: 1 } as never;
    const poisoned = {
      ...inputs,
      links: [poisonedLink, inputs.links[1]],
    } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('links[0]');
    expect(result.error.message).toContain('marketplace installation-link grammar');
  });

  it('a manual score fed into adapter capabilities is rejected by the adapters-sdk grammar', () => {
    const systemA = SYSTEM_A();
    const poisonedCapabilities = {
      ...systemA.capabilities,
      score: 1,
    } as never;
    const poisoned = {
      ...goldenStackInputs(),
      systems: [{ ...systemA, capabilities: poisonedCapabilities }, SYSTEM_B(), SYSTEM_C()],
    } as StackScanInputs;
    const result = assessStackReplacement(poisoned, authorization(), parts());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('adapters-sdk grammar');
  });

  it('no scan-input interface carries any score-shaped field (source scan)', () => {
    const stripComments = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const coverageSource = stripComments(readFileSync(join(srcDir, 'coverage.ts'), 'utf8'));
    const replacementSource = stripComments(readFileSync(join(srcDir, 'replacement.ts'), 'utf8'));

    const interfaceFieldsOf = (source: string, interfaceName: string): string[] => {
      const pattern = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`);
      const match = source.match(pattern);
      expect(match, `interface ${interfaceName} must be declared`).not.toBeNull();
      const body = match?.[1] ?? '';
      return [...body.matchAll(/readonly (\w+):/g)].map((field) => field[1] ?? '');
    };

    const forbidden = /score|potential|weight|threshold|rank|manual/i;
    for (const [source, name] of [
      [coverageSource, 'StackScanInputs'],
      [coverageSource, 'ObservedExternalSystem'],
      [replacementSource, 'StackScanParts'],
    ] as const) {
      const fields = interfaceFieldsOf(source, name);
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(
          forbidden.test(field),
          `the ${name} input interface must not carry a score-shaped field '${field}'`,
        ).toBe(false);
      }
    }
  });

  it('the score-derivation module contains no numeric tuning literals (only 0 and 1)', () => {
    const stripComments = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
    const text = stripComments(readFileSync(join(srcDir, 'replacement.ts'), 'utf8'));
    const literals = [...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((match) => match[0] ?? '');
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(['0', '1']).toContain(literal);
    }
  });

  it('the identity grammars parse the golden scan/assessment tokens (fail-closed)', () => {
    expect(unwrap(parseStackScanId('scan-0001'))).toBe('scan-0001');
    expect(unwrap(parseAssessmentId('scan-0001#0001'))).toBe('scan-0001#0001');
    expect(parseAssessmentId('short').ok).toBe(false);
    expect(parseStackScanId('').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant fixtures sanity (the golden portfolio itself is tenant A;
// the tenant-B direction is exercised in authorization.test.ts).
// ---------------------------------------------------------------------------

describe('OFF-035 golden fixture sanity', () => {
  it('the golden fixtures are tenant-A records with tenant-B catalog releases', () => {
    const inputs = goldenStackInputs();
    for (const system of inputs.systems) {
      expect(system.tenantId).toBe(TENANT_A);
    }
    for (const link of inputs.links) {
      expect(link.tenantId).toBe(TENANT_A);
    }
    // The releases are catalog records published by the tenant-B publisher —
    // resolved through the tenant-A links (the documented catalog semantics).
    for (const release of inputs.releases) {
      expect(release.tenantId).toBe(TENANT_B);
    }
    const appOne = APP_ONE_FIXTURES();
    const appTwo = APP_TWO_FIXTURES();
    expect(appOne.entitlement.state).toBe('active');
    expect(appTwo.entitlement.state).toBe('active');
    expect(appOne.link.state).toBe('linked');
    expect(appTwo.link.state).toBe('linked');
  });

  it('a denied policy measures nothing (the policy gate excludes every subject)', () => {
    const denied = stackAuthorizationOf(tenantAScope(), DENY_ALL_READS_POLICY);
    const analysis = unwrap(assessStackReplacement(goldenStackInputs(), denied, parts()));
    expect(analysis.assessments).toStrictEqual([]);
    expect(analysis.consumed.policySkippedSystemCount).toBe(3);
    expect(analysis.consumed.policySkippedLinkCount).toBe(2);
    expect(analysis.consumed.measuredAppCount).toBe(0);
    expect(analysis.assessedAt).toBe(ASSESSED_AT);
  });
});
