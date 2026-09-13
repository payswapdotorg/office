import { describe, expect, it } from 'vitest';
import { parseRecommendationId } from './vocabulary';
import { runGoldenProcurementScan } from './scenarios';
import {
  checkProcurementCapabilities,
  checkProcurementPolicy,
  checkProcurementScopeCovers,
  procurementRecommendationNotFound,
  procurementResource,
  queryProcurementRecommendationById,
  queryProcurementRecommendations,
} from './authorization';
import {
  ALL_PROCUREMENT_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  EMPTY_POLICY,
  procurementAuthorizationOf,
  projectOneScope,
  tenantAScope,
  tenantBScope,
  testId,
  unwrap,
} from './test-support';
import { COMMITMENT_KIND, PROJECT_KIND } from './model';
import type { ProcurementRecommendation } from './recommendation';

// OFF-034 authorization — the permissioned procurement reads: the capability
// gate BEFORE any record is served, structural scope coverage (A12 both
// directions — a foreign recommendation is INVISIBLE, with a not-found
// identical in shape to an absent one), and the policy gate
// (deny-by-default exclusion, never an error).

const run = runGoldenProcurementScan();

describe('the three authorization layers (deny-by-default)', () => {
  it('the capability gate passes a fully-capable context and names the missing ones', () => {
    expect(checkProcurementCapabilities(procurementAuthorizationOf(tenantAScope()))).toStrictEqual({
      ok: true,
      value: true,
    });
    const missing = procurementAuthorizationOf(tenantAScope(), {
      capabilities: ALL_PROCUREMENT_CAPABILITIES.filter(
        (capability) => capability !== 'cost.read',
      ),
    });
    const rejected = checkProcurementCapabilities(missing);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('missing-procurement-capability');
      expect(String(rejected.error.message)).toContain('cost.read');
    }
  });

  it('structural scope coverage accepts in-scope resources and rejects foreign ones', () => {
    const reader = procurementAuthorizationOf(tenantAScope());
    expect(
      checkProcurementScopeCovers(reader, {
        scope: projectOneScope(),
        entityKind: COMMITMENT_KIND,
        entityId: testId('com', 11),
      }),
    ).toStrictEqual({ ok: true, value: true });
    const foreign = checkProcurementScopeCovers(reader, {
      scope: tenantBScope(),
      entityKind: COMMITMENT_KIND,
      entityId: testId('com', 99),
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('unauthorized');
    }
  });

  it('the policy gate: explicit deny wins, empty policy denies by default, allow serves', () => {
    const parts = {
      scope: projectOneScope(),
      entityKind: COMMITMENT_KIND,
      entityId: testId('com', 11),
    };
    expect(checkProcurementPolicy(procurementAuthorizationOf(tenantAScope()), parts).ok).toBe(true);
    expect(
      checkProcurementPolicy(
        procurementAuthorizationOf(tenantAScope(), { policy: DENY_ALL_READS_POLICY }),
        parts,
      ).ok,
    ).toBe(false);
    expect(
      checkProcurementPolicy(
        procurementAuthorizationOf(tenantAScope(), { policy: EMPTY_POLICY }),
        parts,
      ).ok,
    ).toBe(false);
  });

  it('procurementResource derives the resource scope of an entity', () => {
    const resource = procurementResource({
      scope: projectOneScope(),
      entityKind: PROJECT_KIND,
      entityId: null,
    });
    expect(resource).toBeDefined();
  });
});

describe('queryProcurementRecommendations (the permissioned set read — A12 both directions)', () => {
  it('serves the tenant-A recommendation set in canonical id order regardless of supplied order', () => {
    const served = unwrap(
      queryProcurementRecommendations(
        [...run.recommendations].reverse(),
        procurementAuthorizationOf(tenantAScope()),
      ),
    );
    expect(served.map((recommendation) => recommendation.recommendationId)).toStrictEqual([
      'scan-0001#0001',
      'scan-0001#0002',
      'scan-0001#0003',
    ]);
  });

  it('serves NOTHING to a tenant-B reader (direction 1 — invisible, never an error)', () => {
    const served = unwrap(
      queryProcurementRecommendations(
        run.recommendations,
        procurementAuthorizationOf(tenantBScope()),
      ),
    );
    expect(served).toStrictEqual([]);
  });

  it('a project-one reader sees the whole golden set (scope narrowing admits own records)', () => {
    const served = unwrap(
      queryProcurementRecommendations(
        run.recommendations,
        procurementAuthorizationOf(projectOneScope()),
      ),
    );
    expect(served).toStrictEqual(run.recommendations);
  });

  it('a foreign recommendation in the set is invisible to a tenant-A reader (direction 2)', () => {
    const foreign: ProcurementRecommendation = {
      ...run.recommendations[0]!,
      recommendationId: unwrap(parseRecommendationId('scan-9998#0009')),
      scope: tenantBScope(),
    };
    const served = unwrap(
      queryProcurementRecommendations(
        [...run.recommendations, foreign],
        procurementAuthorizationOf(tenantAScope()),
      ),
    );
    expect(served).toStrictEqual(run.recommendations);
  });

  it('the kind filter restricts the served set (a pure tag filter)', () => {
    const served = unwrap(
      queryProcurementRecommendations(run.recommendations, procurementAuthorizationOf(tenantAScope()), {
        kind: 'timing-shift',
      }),
    );
    expect(served.map((recommendation) => recommendation.kind)).toStrictEqual(['timing-shift']);
  });

  it('the capability gate rejects BEFORE any record is served', () => {
    const missing = procurementAuthorizationOf(tenantAScope(), {
      capabilities: ['contracts.read'],
    });
    const rejected = queryProcurementRecommendations(run.recommendations, missing);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('missing-procurement-capability');
    }
  });

  it('policy-denied recommendations are excluded from the served set (never errors)', () => {
    const denied = unwrap(
      queryProcurementRecommendations(
        run.recommendations,
        procurementAuthorizationOf(tenantAScope(), { policy: DENY_ALL_READS_POLICY }),
      ),
    );
    expect(denied).toStrictEqual([]);
  });
});

describe('queryProcurementRecommendationById (the permissioned single read — no existence oracle)', () => {
  const recommendationAt = (index: number): ProcurementRecommendation => {
    const recommendation = run.recommendations[index];
    if (recommendation === undefined) throw new Error(`missing recommendation ${index}`);
    return recommendation;
  };

  it('serves a visible recommendation by its derived id', () => {
    const served = unwrap(
      queryProcurementRecommendationById(
        run.recommendations,
        procurementAuthorizationOf(tenantAScope()),
        recommendationAt(0).recommendationId,
      ),
    );
    expect(served).toStrictEqual(recommendationAt(0));
  });

  it('a tenant-B reader gets the SAME typed not-found as for an absent id (direction 1)', () => {
    const foreign = queryProcurementRecommendationById(
      run.recommendations,
      procurementAuthorizationOf(tenantBScope()),
      recommendationAt(0).recommendationId,
    );
    const absent = queryProcurementRecommendationById(
      run.recommendations,
      procurementAuthorizationOf(tenantBScope()),
      unwrap(parseRecommendationId('scan-9999#9999')),
    );
    expect(foreign.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!foreign.ok && !absent.ok) {
      expect(foreign.error.code).toBe('not-found');
      expect(absent.error.code).toBe('not-found');
      expect(foreign.error.details[0]?.code).toBe('procurement-recommendation-not-found');
      // The denial shape + caller scope are identical: the only difference
      // is the echo of the caller's OWN requested id — never a foreign-scope
      // or existence oracle.
      expect(absent.error.scope).toStrictEqual(foreign.error.scope);
      expect(absent.error.details[0]?.code).toBe(foreign.error.details[0]?.code);
      expect(String(foreign.error.message)).not.toContain(String(tenantAScope().tenantId));
    }
  });

  it('a tenant-A reader cannot fetch a foreign recommendation by id (direction 2)', () => {
    const foreign: ProcurementRecommendation = {
      ...recommendationAt(0),
      recommendationId: unwrap(parseRecommendationId('scan-9998#0009')),
      scope: tenantBScope(),
    };
    const rejected = queryProcurementRecommendationById(
      [...run.recommendations, foreign],
      procurementAuthorizationOf(tenantAScope()),
      foreign.recommendationId,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('not-found');
    }
  });

  it('the capability gate rejects the single read BEFORE the lookup', () => {
    const missing = procurementAuthorizationOf(tenantAScope(), {
      capabilities: ALL_PROCUREMENT_CAPABILITIES.filter(
        (capability) => capability !== 'contracts.read',
      ),
    });
    const rejected = queryProcurementRecommendationById(
      run.recommendations,
      missing,
      recommendationAt(0).recommendationId,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
    }
  });

  it('procurementRecommendationNotFound carries the id and the caller scope', () => {
    const error = procurementRecommendationNotFound(
      'scan-0001#0001',
      procurementAuthorizationOf(tenantAScope()),
    );
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.message).toBe('scan-0001#0001');
    expect(error.scope).toStrictEqual(tenantAScope());
  });
});
