import { describe, expect, it } from 'vitest';
import { definePolicy } from '@office/authz';
import { APP_ONE_FIXTURES, GOLDEN_ASSESSED_AT, goldenStackInputs } from './scenarios';
import {
  STACK_REQUIRED_CAPABILITY_NAMES,
  parseAssessmentId,
} from './vocabulary';
import {
  TENANT_A,
  TENANT_B,
  fixtureEntitlement,
  fixtureLink,
  fixtureSystem,
  stackAuthorizationOf,
  tenantAScope,
  tenantBScope,
  testId,
  testScanId,
  unwrap,
} from './test-support';
import {
  checkStackCapabilities,
  checkStackPolicy,
  checkStackScopeCovers,
  installationLinkResource,
  observedSystemResource,
  queryReplacementAssessmentById,
  queryReplacementAssessments,
  stackAssessmentNotFound,
  stackInputScopeFailure,
} from './authorization';
import type { StackAuthorization } from './authorization';
import { assessStackReplacement } from './replacement';
import type { ReplacementAssessment } from './replacement';
import type { StackScanInputs } from './coverage';

// OFF-035 authorization — deny-by-default across the three layers (area read
// capabilities BEFORE anything is read; structural scope coverage, freeze
// A12, in BOTH directions; caller-supplied policy rules), the permissioned
// SET read (foreign assessments are invisible, never errors), and the
// permissioned SINGLE read (invisible == absent — no existence oracle).

const tenantA = (): StackAuthorization => stackAuthorizationOf(tenantAScope());
const tenantB = (): StackAuthorization => stackAuthorizationOf(tenantBScope());
const parts = () => ({ scanId: testScanId(1), now: GOLDEN_ASSESSED_AT });

const goldenSet = (): readonly ReplacementAssessment[] =>
  unwrap(assessStackReplacement(goldenStackInputs(), tenantA(), parts())).assessments;

/** A real tenant-B scan (tenant-B systems/links/entitlements, no memory). */
const tenantBSet = (): readonly ReplacementAssessment[] => {
  const appOne = APP_ONE_FIXTURES();
  const entitlement = fixtureEntitlement({
    tenantId: TENANT_B,
    appId: 'app-01',
    range: '^1.0.0',
    ordinal: 1,
  });
  const link = fixtureLink({
    tenantId: TENANT_B,
    installationId: testId('installation', 11),
    appId: 'app-01',
    releaseId: appOne.release.releaseId,
    currentVersion: '1.2.0',
    entitlementId: entitlement.entitlementId,
  });
  const system = fixtureSystem({
    tenantId: TENANT_B,
    adapterKind: 'system-b',
    systemId: 'instance-99',
    objectKinds: [
      { objectKind: 'document', canonicalKind: 'document', capability: 'documents.read' },
    ],
  });
  const inputs: StackScanInputs = {
    systems: [system],
    releases: [appOne.release],
    entitlements: [entitlement],
    links: [link],
    outcomes: [],
    benchmarks: [],
  };
  // A distinct scan identity so the tenant-B assessment ids never collide
  // with the golden tenant-A ones.
  return unwrap(
    assessStackReplacement(inputs, tenantB(), { scanId: testScanId(2), now: GOLDEN_ASSESSED_AT }),
  ).assessments;
};

/** Deny reads of one resource kind while allowing every other read. */
const denyKindAllowRestPolicy = (resourceKind: string) =>
  definePolicy([
    { effect: 'deny', resourceKinds: [resourceKind] },
    { effect: 'allow', actions: ['read'] },
  ]);

describe('the three authorization layers (deny-by-default)', () => {
  it('layer 1 — the capability gate requires exactly the four area read capabilities', () => {
    expect(STACK_REQUIRED_CAPABILITY_NAMES).toStrictEqual([
      'apps.read',
      'contracts.read',
      'cost.read',
      'schedule.read',
    ]);
    expect(checkStackCapabilities(tenantA())).toStrictEqual({ ok: true, value: true });
    for (const missing of ['apps.read', 'contracts.read', 'cost.read', 'schedule.read']) {
      const held = STACK_REQUIRED_CAPABILITY_NAMES.filter((name) => name !== missing);
      const result = checkStackCapabilities(stackAuthorizationOf(tenantAScope(), undefined, held));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('forbidden');
      expect(result.error.message).toContain(missing);
    }
  });

  it('layer 2 — structural scope coverage admits the caller\'s own records and rejects foreign ones', () => {
    const system = goldenStackInputs().systems[0];
    if (system === undefined) throw new Error('missing system fixture');
    const link = goldenStackInputs().links[0];
    if (link === undefined) throw new Error('missing link fixture');
    expect(checkStackScopeCovers(tenantA(), observedSystemResource(system))).toStrictEqual({
      ok: true,
      value: true,
    });
    expect(checkStackScopeCovers(tenantA(), installationLinkResource(link))).toStrictEqual({
      ok: true,
      value: true,
    });
    const foreign = fixtureSystem({
      tenantId: TENANT_B,
      adapterKind: 'system-b',
      systemId: 'instance-99',
      objectKinds: [
        { objectKind: 'document', canonicalKind: 'document', capability: 'documents.read' },
      ],
    });
    const rejected = checkStackScopeCovers(tenantA(), observedSystemResource(foreign));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.error.code).toBe('unauthorized');
    expect(rejected.error.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('layer 2 — the typed cross-scope input rejection names the path, never the foreign scope', () => {
    const failure = stackInputScopeFailure('links[3]');
    expect(failure.code).toBe('unauthorized');
    expect(failure.details[0]?.code).toBe('stack-input-scope');
    expect(failure.details[0]?.path).toBe('links[3]');
    expect(failure.message).toContain('links[3]');
    expect(failure.message).not.toContain(String(TENANT_B));
  });

  it('layer 3 — the policy gate: explicit deny wins, first allow grants, otherwise deny', () => {
    const link = goldenStackInputs().links[0];
    if (link === undefined) throw new Error('missing link fixture');
    const resource = installationLinkResource(link);
    expect(checkStackPolicy(tenantA(), resource)).toStrictEqual({ ok: true, value: true });
    const denied = checkStackPolicy(
      stackAuthorizationOf(tenantAScope(), denyKindAllowRestPolicy('app-installation')),
      resource,
    );
    expect(denied.ok).toBe(false);
    const emptyPolicy = stackAuthorizationOf(tenantAScope(), definePolicy([]));
    expect(checkStackPolicy(emptyPolicy, resource).ok).toBe(false);
  });
});

describe('queryReplacementAssessments (the permissioned set read)', () => {
  it('serves the caller\'s own assessments in canonical assessment-id order', () => {
    const served = unwrap(queryReplacementAssessments(goldenSet(), tenantA()));
    expect(served).toHaveLength(5);
    expect(served.map((assessment) => assessment.assessmentId)).toStrictEqual([
      'scan-0001#0001',
      'scan-0001#0002',
      'scan-0001#0003',
      'scan-0001#0004',
      'scan-0001#0005',
    ]);
    expect([...served].reverse().sort((l, r) => (l.assessmentId < r.assessmentId ? -1 : 1))).toStrictEqual(
      served,
    );
  });

  it('the served order is canonical regardless of the supplied array order', () => {
    const reversed = [...goldenSet()].reverse();
    const served = unwrap(queryReplacementAssessments(reversed, tenantA()));
    expect(served.map((a) => a.assessmentId)).toStrictEqual(
      goldenSet().map((a) => a.assessmentId),
    );
  });

  it('the kind tag filter restricts the served set (a pure data filter)', () => {
    const systems = unwrap(queryReplacementAssessments(goldenSet(), tenantA(), { kind: 'external-system' }));
    expect(systems).toHaveLength(3);
    for (const assessment of systems) {
      expect(assessment.kind).toBe('external-system');
    }
    const apps = unwrap(queryReplacementAssessments(goldenSet(), tenantA(), { kind: 'installed-app' }));
    expect(apps).toHaveLength(2);
    for (const assessment of apps) {
      expect(assessment.kind).toBe('installed-app');
    }
  });

  it('a tenant-B reader over the tenant-A set is served NOTHING (never an error)', () => {
    const served = queryReplacementAssessments(goldenSet(), tenantB());
    expect(served.ok).toBe(true);
    if (!served.ok) throw new Error('unreachable');
    expect(served.value).toStrictEqual([]);
  });

  it('a foreign assessment inside the set is INVISIBLE to the tenant-A reader', () => {
    const mixed = [...goldenSet(), ...tenantBSet()];
    expect(mixed.length).toBeGreaterThan(5);
    const served = unwrap(queryReplacementAssessments(mixed, tenantA()));
    expect(served).toHaveLength(5);
    for (const assessment of served) {
      expect(assessment.assessmentId).toMatch(/^scan-0001#/);
    }
    // And the tenant-B reader sees exactly its own two.
    const servedB = unwrap(queryReplacementAssessments(mixed, tenantB()));
    expect(servedB).toHaveLength(2);
  });

  it('policy-denied assessments are excluded from the served set (never errors)', () => {
    const deniedApps = stackAuthorizationOf(
      tenantAScope(),
      denyKindAllowRestPolicy('app-installation'),
    );
    const served = unwrap(queryReplacementAssessments(goldenSet(), deniedApps));
    expect(served).toHaveLength(3);
    for (const assessment of served) {
      expect(assessment.kind).toBe('external-system');
    }
  });

  it('the capability gate rejects the set read BEFORE any record is touched', () => {
    const noCapabilities = stackAuthorizationOf(tenantAScope(), undefined, []);
    // The set contains a foreign assessment; a denied reader must get the
    // FORBIDDEN denial (not a scope leak about the set's contents).
    const rejected = queryReplacementAssessments(
      [...goldenSet(), ...tenantBSet()],
      noCapabilities,
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.error.code).toBe('forbidden');
    expect(rejected.error.details[0]?.code).toBe('missing-stack-capability');
  });
});

describe('queryReplacementAssessmentById (the permissioned single read — no existence oracle)', () => {
  const assessmentAt = (ordinal: number): ReplacementAssessment => {
    const assessment = goldenSet()[ordinal - 1];
    if (assessment === undefined) throw new Error(`missing assessment ${ordinal}`);
    return assessment;
  };

  it('serves a visible assessment by its scan-derived id', () => {
    const served = unwrap(
      queryReplacementAssessmentById(goldenSet(), tenantA(), assessmentAt(1).assessmentId),
    );
    expect(served).toStrictEqual(assessmentAt(1));
  });

  it('a tenant-B reader gets the SAME typed not-found as for an absent id (direction 1)', () => {
    const foreign = queryReplacementAssessmentById(
      goldenSet(),
      tenantB(),
      assessmentAt(1).assessmentId,
    );
    const absent = queryReplacementAssessmentById(
      goldenSet(),
      tenantB(),
      unwrap(parseAssessmentId('scan-9999#9999')),
    );
    expect(foreign.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!foreign.ok && !absent.ok) {
      expect(foreign.error.code).toBe('not-found');
      expect(absent.error.code).toBe('not-found');
      expect(foreign.error.details[0]?.code).toBe('stack-assessment-not-found');
      // The denial shape + caller scope are identical: the only difference is
      // the echo of the caller's OWN requested id — never a foreign-scope or
      // existence oracle.
      expect(absent.error.scope).toStrictEqual(foreign.error.scope);
      expect(absent.error.details[0]?.code).toBe(foreign.error.details[0]?.code);
      expect(String(foreign.error.message)).not.toContain(String(tenantAScope().tenantId));
      expect(String(foreign.error.message)).not.toContain(String(TENANT_A));
    }
  });

  it('a tenant-A reader cannot fetch a foreign assessment by id (direction 2)', () => {
    const foreignSet = tenantBSet();
    const foreignAssessment = foreignSet[0];
    if (foreignAssessment === undefined) throw new Error('missing tenant-B assessment');
    const rejected = queryReplacementAssessmentById(
      [...goldenSet(), ...foreignSet],
      tenantA(),
      foreignAssessment.assessmentId,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('not-found');
      expect(rejected.error.details[0]?.code).toBe('stack-assessment-not-found');
    }
  });

  it('the capability gate rejects the single read BEFORE the lookup', () => {
    const missing = stackAuthorizationOf(tenantAScope(), undefined, ['apps.read', 'contracts.read']);
    const rejected = queryReplacementAssessmentById(
      goldenSet(),
      missing,
      assessmentAt(1).assessmentId,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
    }
  });

  it('stackAssessmentNotFound carries the requested id and the caller scope', () => {
    const error = stackAssessmentNotFound('scan-0001#0001', tenantA());
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.message).toBe('scan-0001#0001');
    expect(error.scope).toStrictEqual(tenantAScope());
  });
});
