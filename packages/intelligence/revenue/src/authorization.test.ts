import { describe, expect, it } from 'vitest';
import { parseCandidateId } from './vocabulary';
import { runGoldenRecoveryScan } from './scenarios';
import {
  checkRecoveryCapabilities,
  checkRecoveryPolicy,
  checkRecoveryScopeCovers,
  queryRecoveryCandidateById,
  queryRecoveryCandidates,
  recoveryCandidateNotFound,
  recoveryResource,
} from './authorization';
import {
  ALL_RECOVERY_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  EMPTY_POLICY,
  projectOneScope,
  recoveryAuthorizationOf,
  tenantAScope,
  tenantBScope,
  testId,
  unwrap,
} from './test-support';
import { CHANGE_EVENT_KIND, PROJECT_KIND } from './model';
import type { CandidateRecovery } from './candidates';

// OFF-033 authorization — the permissioned recovery reads: the capability
// gate BEFORE any record is served, structural scope coverage (A12 both
// directions — a foreign candidate is INVISIBLE, with a not-found identical
// to an absent one), and the policy gate (deny-by-default exclusion).

const run = runGoldenRecoveryScan();

describe('the three authorization layers (deny-by-default)', () => {
  it('the capability gate passes a fully-capable context and names the missing ones', () => {
    expect(checkRecoveryCapabilities(recoveryAuthorizationOf(tenantAScope()))).toStrictEqual({
      ok: true,
      value: true,
    });
    const missing = recoveryAuthorizationOf(tenantAScope(), {
      capabilities: ALL_RECOVERY_CAPABILITIES.filter(
        (capability) => capability !== 'schedule.read',
      ),
    });
    const rejected = checkRecoveryCapabilities(missing);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(String(rejected.error.message)).toContain('schedule.read');
    }
  });

  it('structural scope coverage accepts in-scope resources and rejects foreign ones', () => {
    const reader = recoveryAuthorizationOf(tenantAScope());
    expect(
      checkRecoveryScopeCovers(reader, {
        scope: projectOneScope(),
        entityKind: CHANGE_EVENT_KIND,
        entityId: testId('chg', 1),
      }),
    ).toStrictEqual({ ok: true, value: true });
    const foreign = checkRecoveryScopeCovers(reader, {
      scope: { kind: 'tenant', tenantId: tenantBScope().tenantId },
      entityKind: CHANGE_EVENT_KIND,
      entityId: testId('chg', 99),
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('unauthorized');
    }
  });

  it('the policy gate: explicit deny wins, empty policy denies by default, allow serves', () => {
    const parts = {
      scope: projectOneScope(),
      entityKind: CHANGE_EVENT_KIND,
      entityId: testId('chg', 1),
    };
    expect(checkRecoveryPolicy(recoveryAuthorizationOf(tenantAScope()), parts).ok).toBe(true);
    expect(
      checkRecoveryPolicy(
        recoveryAuthorizationOf(tenantAScope(), { policy: DENY_ALL_READS_POLICY }),
        parts,
      ).ok,
    ).toBe(false);
    expect(
      checkRecoveryPolicy(recoveryAuthorizationOf(tenantAScope(), { policy: EMPTY_POLICY }), parts)
        .ok,
    ).toBe(false);
  });

  it('recoveryResource derives the resource scope of an entity', () => {
    const resource = recoveryResource({
      scope: projectOneScope(),
      entityKind: PROJECT_KIND,
      entityId: null,
    });
    expect(resource).toBeDefined();
  });
});

describe('queryRecoveryCandidates (the permissioned set read — A12 both directions)', () => {
  it('serves the tenant-A candidate set to a tenant-A reader', () => {
    const served = unwrap(queryRecoveryCandidates(run.candidates, recoveryAuthorizationOf(tenantAScope())));
    expect(served.map((candidate) => candidate.kind)).toStrictEqual([
      'constructive-change',
      'entitlement-rebalance',
      'delay-impact',
    ]);
  });

  it('serves NOTHING to a tenant-B reader (direction 1 — invisible, never an error)', () => {
    const served = unwrap(queryRecoveryCandidates(run.candidates, recoveryAuthorizationOf(tenantBScope())));
    expect(served).toStrictEqual([]);
  });

  it('a project-one reader sees only project-one candidates (scope narrowing)', () => {
    const served = unwrap(
      queryRecoveryCandidates(run.candidates, recoveryAuthorizationOf(projectOneScope())),
    );
    // Every golden candidate lives in project 1 — all three are served.
    expect(served).toStrictEqual(run.candidates);
  });

  it('a foreign candidate in the set is invisible to a tenant-A reader (direction 2)', () => {
    const foreign: CandidateRecovery = {
      ...run.candidates[0]!,
      candidateId: unwrap(parseCandidateId('scan-9998#0009')),
      scope: tenantBScope(),
    };
    const served = unwrap(
      queryRecoveryCandidates([...run.candidates, foreign], recoveryAuthorizationOf(tenantAScope())),
    );
    expect(served).toStrictEqual(run.candidates);
  });

  it('the kind filter restricts the served set (a pure tag filter)', () => {
    const served = unwrap(
      queryRecoveryCandidates(run.candidates, recoveryAuthorizationOf(tenantAScope()), {
        kind: 'delay-impact',
      }),
    );
    expect(served.map((candidate) => candidate.kind)).toStrictEqual(['delay-impact']);
  });

  it('the capability gate rejects BEFORE any record is served', () => {
    const missing = recoveryAuthorizationOf(tenantAScope(), {
      capabilities: ['contracts.read'],
    });
    const rejected = queryRecoveryCandidates(run.candidates, missing);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('missing-recovery-capability');
    }
  });

  it('policy-denied candidates are excluded from the served set (never errors)', () => {
    const denied = unwrap(
      queryRecoveryCandidates(
        run.candidates,
        recoveryAuthorizationOf(tenantAScope(), { policy: DENY_ALL_READS_POLICY }),
      ),
    );
    expect(denied).toStrictEqual([]);
  });
});

describe('queryRecoveryCandidateById (the permissioned single read — no existence oracle)', () => {
  const candidateAt = (index: number): CandidateRecovery => {
    const candidate = run.candidates[index];
    if (candidate === undefined) throw new Error(`missing candidate ${index}`);
    return candidate;
  };

  it('serves a visible candidate by its derived id', () => {
    const served = unwrap(
      queryRecoveryCandidateById(run.candidates, recoveryAuthorizationOf(tenantAScope()), candidateAt(0).candidateId),
    );
    expect(served).toStrictEqual(candidateAt(0));
  });

  it('a tenant-B reader gets the SAME typed not-found as for an absent id (direction 1)', () => {
    const foreign = queryRecoveryCandidateById(
      run.candidates,
      recoveryAuthorizationOf(tenantBScope()),
      candidateAt(0).candidateId,
    );
    const absent = queryRecoveryCandidateById(
      run.candidates,
      recoveryAuthorizationOf(tenantBScope()),
      unwrap(parseCandidateId('scan-9999#9999')),
    );
    expect(foreign.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!foreign.ok && !absent.ok) {
      expect(foreign.error.code).toBe('not-found');
      expect(absent.error.code).toBe('not-found');
      expect(foreign.error.details[0]?.code).toBe('recovery-candidate-not-found');
      // The denial shape + caller scope are identical: the only difference
      // is the echo of the caller's OWN requested id — never a foreign-scope
      // or existence oracle.
      expect(absent.error.scope).toStrictEqual(foreign.error.scope);
      expect(absent.error.details[0]?.code).toBe(foreign.error.details[0]?.code);
      expect(String(foreign.error.message)).not.toContain(String(tenantAScope().tenantId));
    }
  });

  it('a tenant-A reader cannot fetch a foreign candidate by id (direction 2)', () => {
    const foreign: CandidateRecovery = {
      ...candidateAt(0),
      candidateId: unwrap(parseCandidateId('scan-9998#0009')),
      scope: tenantBScope(),
    };
    const rejected = queryRecoveryCandidateById(
      [...run.candidates, foreign],
      recoveryAuthorizationOf(tenantAScope()),
      foreign.candidateId,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('not-found');
    }
  });

  it('the capability gate rejects the single read BEFORE the lookup', () => {
    const missing = recoveryAuthorizationOf(tenantAScope(), {
      capabilities: ALL_RECOVERY_CAPABILITIES.filter((capability) => capability !== 'cost.read'),
    });
    const rejected = queryRecoveryCandidateById(run.candidates, missing, candidateAt(0).candidateId);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
    }
  });

  it('recoveryCandidateNotFound carries the candidate id and the caller scope', () => {
    const error = recoveryCandidateNotFound('scan-0001#0001', recoveryAuthorizationOf(tenantAScope()));
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.message).toBe('scan-0001#0001');
  });
});
