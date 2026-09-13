// OFF-036 security — THE revocation conformance acceptance (A7/A9).
//
// The full revocation discipline, driven through the REAL app runtime's
// lifecycle state machine: SUSPENSION is the STOP sign (a suspended
// installation receives no commands and no events — both dispatch paths
// typed-reject with 'installation-suspended' BEFORE the gateway, zero
// gateway calls, zero handler effects, every rejection audited);
// RE-ACTIVATION restores both streams; REVOCATION is one-way and terminal
// (nothing received on either path, re-activation typed-rejected with
// 'revocation-terminal'); and A9 GRANT REVOCATION stops the streams cleanly
// at the permission layer ('capability-revoked'). Every lifecycle
// transition is audited. The evaluator's detection power is proven against
// forged evidence.
import { parseEntityId } from '@office/contracts';
import type { EntityId } from '@office/contracts';
import { describe, expect, it } from 'vitest';
import { makeConformanceHarness } from './harness';
import { driveRevocationProbes, evaluateRevocation } from './revocation';
import type { RevocationProbe } from './revocation';

/** Fixture helper: a branded EntityId from a known-good literal. */
const entityIdOf = (raw: string): EntityId => {
  const parsed = parseEntityId(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity id: ${raw}`);
  return parsed.value;
};


/** A probe-shaped record with a passing observation (forgery base). */
const forgedProbe = (parts: Partial<RevocationProbe>): RevocationProbe => ({
  label: 'forged-suspended-command',
  phase: 'suspended',
  surface: 'command',
  installationId: entityIdOf('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'),
  rejected: true,
  rejectionCode: 'installation-suspended',
  gatewayCalls: 0,
  handlerInvocations: 0,
  deliveries: 0,
  audited: true,
  ...parts,
});

describe('THE revocation conformance check (OFF-036, A7/A9)', () => {
  it('drives the full revocation discipline through the REAL app runtime and passes', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveRevocationProbes(harness);
    const result = evaluateRevocation(probes);
    expect(result.check).toBe('revocation');
    expect(result.probes).toBe(14);
    expect(result.passed).toBe(true);
    expect(result.failures).toStrictEqual([]);
  });

  it('a suspended installation receives NOTHING: both streams typed-reject pre-gateway, audited', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveRevocationProbes(harness);
    const command = probes.find((probe) => probe.label === 'suspended-command');
    expect(command?.rejected).toBe(true);
    expect(command?.rejectionCode).toBe('installation-suspended');
    expect(command?.gatewayCalls).toBe(0);
    expect(command?.handlerInvocations).toBe(0);
    expect(command?.audited).toBe(true);
    const event = probes.find((probe) => probe.label === 'suspended-event');
    expect(event?.rejected).toBe(true);
    expect(event?.rejectionCode).toBe('installation-suspended');
    expect(event?.gatewayCalls).toBe(0);
    expect(event?.deliveries).toBe(0);
    expect(event?.audited).toBe(true);
    // The suspension transition itself succeeded (and was audited).
    const suspend = probes.find((probe) => probe.label === 'suspend');
    expect(suspend?.rejected).toBe(false);
    expect(suspend?.audited).toBe(true);
  });

  it('re-activation restores both streams (canonical state was never deleted)', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveRevocationProbes(harness);
    const command = probes.find((probe) => probe.label === 'reactivated-command');
    expect(command?.rejected).toBe(false);
    expect(command?.handlerInvocations).toBe(1);
    const event = probes.find((probe) => probe.label === 'reactivated-event');
    expect(event?.rejected).toBe(false);
    expect(event?.deliveries).toBe(1);
  });

  it('revocation is one-way and terminal: nothing is received and re-activation is typed-rejected', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveRevocationProbes(harness);
    const command = probes.find((probe) => probe.label === 'revoked-command');
    expect(command?.rejected).toBe(true);
    expect(command?.rejectionCode).toBe('installation-revoked');
    expect(command?.handlerInvocations).toBe(0);
    expect(command?.gatewayCalls).toBe(0);
    const event = probes.find((probe) => probe.label === 'revoked-event');
    expect(event?.rejected).toBe(true);
    expect(event?.rejectionCode).toBe('installation-revoked');
    expect(event?.deliveries).toBe(0);
    const terminal = probes.find((probe) => probe.label === 'activate-after-revoke');
    expect(terminal?.rejected).toBe(true);
    expect(terminal?.rejectionCode).toBe('revocation-terminal');
    // The revocation transition itself succeeded (and was audited).
    const revoke = probes.find((probe) => probe.label === 'revoke');
    expect(revoke?.rejected).toBe(false);
    expect(revoke?.audited).toBe(true);
  });

  it('a revoked A9 grant stops the streams at the permission layer (the still-active installation)', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveRevocationProbes(harness);
    const writeRevoke = probes.find((probe) => probe.label === 'revoke-work-write-grant');
    expect(writeRevoke?.rejected).toBe(false);
    const command = probes.find((probe) => probe.label === 'grant-revoked-command');
    expect(command?.rejected).toBe(true);
    expect(command?.rejectionCode).toBe('capability-revoked');
    expect(command?.gatewayCalls).toBe(0);
    expect(command?.handlerInvocations).toBe(0);
    const readRevoke = probes.find((probe) => probe.label === 'revoke-work-read-grant');
    expect(readRevoke?.rejected).toBe(false);
    const event = probes.find((probe) => probe.label === 'grant-revoked-event');
    expect(event?.rejected).toBe(true);
    expect(event?.rejectionCode).toBe('capability-revoked');
    expect(event?.deliveries).toBe(0);
  });

  it('detection power: forged revocation evidence is typed-reported', () => {
    const notEnforced = evaluateRevocation([
      forgedProbe({ rejected: false, rejectionCode: null, handlerInvocations: 1 }),
    ]);
    expect(notEnforced.passed).toBe(false);
    expect(notEnforced.failures.map((failure) => failure.code)).toContain('revocation-not-enforced');
    expect(notEnforced.failures.map((failure) => failure.code)).toContain('side-effect-committed');

    const wrongCode = evaluateRevocation([
      forgedProbe({ rejectionCode: 'installation-revoked' }),
    ]);
    expect(wrongCode.failures.map((failure) => failure.code)).toContain('wrong-rejection-code');

    const gatewayReached = evaluateRevocation([forgedProbe({ gatewayCalls: 1 })]);
    expect(gatewayReached.failures.map((failure) => failure.code)).toContain('gateway-reached');

    const unaudited = evaluateRevocation([forgedProbe({ audited: false })]);
    expect(unaudited.failures.map((failure) => failure.code)).toContain('decision-not-audited');

    const notRestored = evaluateRevocation([
      forgedProbe({ phase: 'reactivated', rejected: false, rejectionCode: null, handlerInvocations: 0 }),
    ]);
    expect(notRestored.failures.map((failure) => failure.code)).toContain('stream-not-restored');
  });
});
