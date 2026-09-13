// OFF-036 security — THE tenant-isolation conformance acceptance (A12).
//
// The named acceptance of the work item, proven against the REAL action
// gateway and the REAL app runtime (the deterministic harness wires both
// in memory): cross-tenant attempts in BOTH directions on all three
// surfaces (gateway command, app command, app event) plus the cross-project
// boundary are typed-rejected with the A12 vocabulary — even under an
// ALLOW-ALL policy, because the structural scope check runs before any rule
// is consulted — commit ZERO side effects (no handler invocations, no
// deliveries, and no gateway call at all on the app surfaces), are audited
// in the REQUESTING tenant's trail, and leak NOTHING into the foreign
// tenant's. The pure evaluator's detection power is proven too: forged
// evidence (an accepted attempt, a committed effect, a foreign-trail leak, a
// missing audit envelope) is typed-reported as a conformance failure.
import { parseTenantId } from '@office/contracts';
import type { TenantId } from '@office/contracts';
import { describe, expect, it } from 'vitest';
import { makeConformanceHarness } from './harness';
import { driveTenantIsolationProbes, evaluateTenantIsolation } from './tenant-isolation';
import type { TenantIsolationProbe } from './tenant-isolation';
import { TENANT_ISOLATION_CODES } from './tenant-isolation';

/** Fixture helper: a branded TenantId from a known-good literal. */
const tenantIdOf = (raw: string): TenantId => {
  const parsed = parseTenantId(raw);
  if (!parsed.ok) throw new TypeError(`fixture tenant id: ${raw}`);
  return parsed.value;
};


/** A probe-shaped record with every observation defaulted (forgery base). */
const forgedProbe = (parts: Partial<TenantIsolationProbe>): TenantIsolationProbe => ({
  label: 'forged-gateway-a-to-b',
  direction: 'a-to-b',
  surface: 'gateway-command',
  requestingTenantId: tenantIdOf('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
  foreignTenantId: tenantIdOf('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'),
  rejected: true,
  rejectionCode: 'tenant-scope-violation',
  gatewayCalls: 1,
  handlerInvocations: 0,
  deliveries: 0,
  auditInRequestingTenant: 1,
  auditInForeignTenant: 0,
  ...parts,
});

describe('THE tenant-isolation conformance check (OFF-036, A12)', () => {
  it('drives cross-tenant attempts through the REAL gateway + REAL app runtime and passes', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveTenantIsolationProbes(harness);
    const result = evaluateTenantIsolation(probes);
    expect(result.check).toBe('tenant-isolation');
    expect(result.probes).toBe(7);
    expect(result.passed).toBe(true);
    expect(result.failures).toStrictEqual([]);
  });

  it('every cross-scope attempt is typed-rejected with the A12 vocabulary, both directions', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveTenantIsolationProbes(harness);
    expect(probes.every((probe) => probe.rejected)).toBe(true);
    expect(probes.every((probe) => probe.rejectionCode !== null)).toBe(true);
    for (const probe of probes) {
      expect(TENANT_ISOLATION_CODES).toContain(probe.rejectionCode);
    }
    // The gateway surface speaks the structural-scope vocabulary; the app
    // surfaces speak the pre-gateway tenant-gate vocabulary.
    expect(probes.filter((probe) => probe.surface === 'gateway-command').map((probe) => probe.rejectionCode)).toStrictEqual([
      'tenant-scope-violation',
      'tenant-scope-violation',
      'project-scope-violation',
    ]);
    expect(
      probes
        .filter((probe) => probe.surface !== 'gateway-command')
        .every((probe) => probe.rejectionCode === 'cross-tenant-scope'),
    ).toBe(true);
  });

  it('commits ZERO side effects: no handler invocations, no deliveries, pre-gateway app rejections', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveTenantIsolationProbes(harness);
    expect(probes.every((probe) => probe.handlerInvocations === 0)).toBe(true);
    expect(probes.every((probe) => probe.deliveries === 0)).toBe(true);
    // Gateway-surface attempts reach the gateway exactly once (the decision
    // IS the gateway's); app-surface attempts die at the runtime's tenant
    // gate BEFORE the gateway is ever reached.
    for (const probe of probes) {
      if (probe.surface === 'gateway-command') {
        expect(probe.gatewayCalls).toBe(1);
      } else {
        expect(probe.gatewayCalls).toBe(0);
      }
    }
    expect(harness.handlerInvocations.count).toBe(0);
    expect(harness.countedGateway.calls.count).toBe(3);
  });

  it('audits every rejection in the REQUESTING tenant trail and leaks nothing to the foreign tenant', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveTenantIsolationProbes(harness);
    expect(probes.every((probe) => probe.auditInRequestingTenant >= 1)).toBe(true);
    expect(probes.every((probe) => probe.auditInForeignTenant === 0)).toBe(true);
  });

  it('detection power: an ACCEPTED cross-tenant attempt is typed-reported (A12 violated)', () => {
    const result = evaluateTenantIsolation([
      forgedProbe({ rejected: false, rejectionCode: null }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('cross-scope-attempt-accepted');
  });

  it('detection power: a committed side effect is typed-reported', () => {
    const handler = evaluateTenantIsolation([forgedProbe({ handlerInvocations: 2 })]);
    expect(handler.failures.map((failure) => failure.code)).toContain('side-effect-committed');
    const delivery = evaluateTenantIsolation([
      forgedProbe({ surface: 'app-event', gatewayCalls: 0, deliveries: 1, rejectionCode: 'cross-tenant-scope' }),
    ]);
    expect(delivery.failures.map((failure) => failure.code)).toContain('side-effect-committed');
  });

  it('detection power: a foreign-trail audit leak is typed-reported', () => {
    const result = evaluateTenantIsolation([forgedProbe({ auditInForeignTenant: 1 })]);
    expect(result.failures.map((failure) => failure.code)).toContain('audit-leaked-to-foreign-tenant');
  });

  it('detection power: an unaudited rejection and a gateway reached pre-gate are typed-reported', () => {
    const unaudited = evaluateTenantIsolation([forgedProbe({ auditInRequestingTenant: 0 })]);
    expect(unaudited.failures.map((failure) => failure.code)).toContain('rejection-not-audited');
    const reached = evaluateTenantIsolation([
      forgedProbe({ surface: 'app-command', gatewayCalls: 1, rejectionCode: 'cross-tenant-scope' }),
    ]);
    expect(reached.failures.map((failure) => failure.code)).toContain('gateway-reached');
  });

  it('detection power: a wrong rejection code is typed-reported', () => {
    const result = evaluateTenantIsolation([forgedProbe({ rejectionCode: 'no-allow-rule' })]);
    expect(result.failures.map((failure) => failure.code)).toContain('wrong-rejection-code');
  });
});
