// OFF-036 security — THE authorization-boundary conformance acceptance.
//
// The deny-by-default matrix across EVERY actor kind of the contracts
// vocabulary ('user' | 'agent' | 'app' | 'adapter' | 'system'), driven
// through the REAL action gateway: an EMPTY policy (no allow rule at all)
// denies every actor kind even with full capabilities; an explicit deny
// wins over a trailing allow while action-scoped reads still execute; a
// missing required capability denies BEFORE the policy; the descriptor's
// own actor-kind gate rejects undeclared kinds under an allow-all policy
// with full capabilities — THE no-bypass proof (the system actor included);
// and classification is fail-closed (unknown commands prohibited by
// default, prohibited classes never executed). Every denial carries its
// audit envelope and commits zero handler effects; the evaluator's
// detection power is proven against forged evidence.
import { describe, expect, it } from 'vitest';
import { makeConformanceHarness } from './harness';
import {
  driveAuthorizationBoundaryProbes,
  evaluateAuthorizationBoundaries,
} from './authorization';
import type { AuthorizationBoundaryProbe } from './authorization';

const ACTOR_KINDS = ['user', 'agent', 'app', 'adapter', 'system'] as const;

/** A probe-shaped record with a passing observation (forgery base). */
const forgedProbe = (parts: Partial<AuthorizationBoundaryProbe>): AuthorizationBoundaryProbe => ({
  label: 'forged-empty-policy-user',
  actorKind: 'user',
  commandName: 'cost.listCostItems',
  policy: 'empty',
  capabilities: 'full',
  expected: 'denied',
  expectedRejectionCode: 'no-allow-rule',
  observed: 'denied',
  rejectionCode: 'no-allow-rule',
  handlerInvocations: 0,
  audited: true,
  ...parts,
});

describe('THE authorization-boundary conformance check (OFF-036)', () => {
  it('drives the deny-by-default matrix across every actor kind through the REAL gateway and passes', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveAuthorizationBoundaryProbes(harness);
    const result = evaluateAuthorizationBoundaries(probes);
    expect(result.check).toBe('authorization-boundaries');
    expect(result.probes).toBe(27);
    expect(result.passed).toBe(true);
    expect(result.failures).toStrictEqual([]);
    // Every actor kind of the contracts vocabulary is covered.
    const observedKinds = new Set(probes.map((probe) => probe.actorKind));
    expect([...observedKinds].sort()).toStrictEqual([...ACTOR_KINDS].sort());
  });

  it('an EMPTY policy denies EVERY actor kind — full capabilities held (deny-by-default)', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveAuthorizationBoundaryProbes(harness);
    for (const kind of ACTOR_KINDS) {
      const probe = probes.find((candidate) => candidate.label === `empty-policy-${kind}`);
      expect(probe, `empty-policy-${kind}`).toBeDefined();
      expect(probe?.observed).toBe('denied');
      expect(probe?.rejectionCode).toBe('no-allow-rule');
      expect(probe?.handlerInvocations).toBe(0);
      expect(probe?.audited).toBe(true);
    }
  });

  it('an EXPLICIT deny wins for every actor kind while the action-scoped read still executes', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveAuthorizationBoundaryProbes(harness);
    for (const kind of ACTOR_KINDS) {
      const probe = probes.find((candidate) => candidate.label === `deny-write-${kind}`);
      expect(probe, `deny-write-${kind}`).toBeDefined();
      expect(probe?.observed).toBe('denied');
      expect(probe?.rejectionCode).toBe('explicit-deny');
      expect(probe?.handlerInvocations).toBe(0);
    }
    const read = probes.find((candidate) => candidate.label === 'deny-write-read-still-executes');
    expect(read?.observed).toBe('executed');
    expect(read?.handlerInvocations).toBe(1);
  });

  it('a missing required capability denies BEFORE the policy for every actor kind (allow-all held)', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveAuthorizationBoundaryProbes(harness);
    for (const kind of ACTOR_KINDS) {
      const probe = probes.find((candidate) => candidate.label === `missing-capability-${kind}`);
      expect(probe, `missing-capability-${kind}`).toBeDefined();
      expect(probe?.observed).toBe('denied');
      expect(probe?.rejectionCode).toBe('missing-required-capability');
    }
  });

  it('THE no-bypass proof: the actor-kind gate rejects every non-human kind under allow-all + full capabilities', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveAuthorizationBoundaryProbes(harness);
    for (const kind of ACTOR_KINDS) {
      const probe = probes.find((candidate) => candidate.label === `actor-kind-gate-${kind}`);
      expect(probe, `actor-kind-gate-${kind}`).toBeDefined();
      if (kind === 'user') {
        expect(probe?.observed).toBe('executed');
        expect(probe?.handlerInvocations).toBe(1);
      } else {
        // 'agent' | 'app' | 'adapter' | 'system' — no actor kind bypasses.
        expect(probe?.observed).toBe('denied');
        expect(probe?.rejectionCode).toBe('actor-kind-not-permitted');
        expect(probe?.handlerInvocations).toBe(0);
      }
    }
  });

  it('classification is fail-closed: unknown commands prohibited, prohibited classes never execute', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveAuthorizationBoundaryProbes(harness);
    for (const kind of ['user', 'system'] as const) {
      const unknown = probes.find((candidate) => candidate.label === `unknown-command-${kind}`);
      expect(unknown?.observed).toBe('denied');
      expect(unknown?.rejectionCode).toBe('unknown-action');
      const prohibited = probes.find((candidate) => candidate.label === `prohibited-class-${kind}`);
      expect(prohibited?.observed).toBe('denied');
      expect(prohibited?.rejectionCode).toBe('prohibited-action');
      expect(prohibited?.handlerInvocations).toBe(0);
    }
  });

  it('approval-required actions route into the approval engine (humans and non-humans alike)', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveAuthorizationBoundaryProbes(harness);
    for (const kind of ['user', 'agent'] as const) {
      const probe = probes.find((candidate) => candidate.label === `approval-routing-${kind}`);
      expect(probe, `approval-routing-${kind}`).toBeDefined();
      expect(probe?.observed).toBe('routed');
      expect(probe?.handlerInvocations).toBe(0);
      expect(probe?.audited).toBe(true);
    }
  });

  it('detection power: forged evidence is typed-reported (outcome, code, effects, audit)', () => {
    const mismatch = evaluateAuthorizationBoundaries([
      forgedProbe({ observed: 'executed' }),
    ]);
    expect(mismatch.passed).toBe(false);
    expect(mismatch.failures.map((failure) => failure.code)).toContain('boundary-outcome-mismatch');

    const wrongCode = evaluateAuthorizationBoundaries([
      forgedProbe({ rejectionCode: 'explicit-deny' }),
    ]);
    expect(wrongCode.failures.map((failure) => failure.code)).toContain('wrong-rejection-code');

    const sideEffect = evaluateAuthorizationBoundaries([
      forgedProbe({ handlerInvocations: 1 }),
    ]);
    expect(sideEffect.failures.map((failure) => failure.code)).toContain('side-effect-committed');

    const unaudited = evaluateAuthorizationBoundaries([forgedProbe({ audited: false })]);
    expect(unaudited.failures.map((failure) => failure.code)).toContain('denial-not-audited');

    const executedShortfall = evaluateAuthorizationBoundaries([
      forgedProbe({
        expected: 'executed',
        expectedRejectionCode: null,
        observed: 'executed',
        rejectionCode: null,
        handlerInvocations: 0,
      }),
    ]);
    expect(executedShortfall.failures.map((failure) => failure.code)).toContain('side-effect-mismatch');
  });
});
