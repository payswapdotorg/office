// OFF-036 security — the deterministic conformance harness acceptance.
//
// The harness is the wiring every conformance check drives: the REAL action
// gateway (@office/actions createActionGateway over the canonical
// descriptors, counting handlers, the in-memory approval authority and
// idempotency registry) wrapped in a COUNTING gateway, and the REAL app
// runtime (@office/app-runtime createAppRuntime) over the in-memory store
// pre-populated through the package's exported fail-closed parses. This
// suite proves the wiring (the surfaces under test are the real packages'
// own composed engines), the fixture discipline (two ACTIVE installations,
// one per tenant, with live A9 grants and a registered namespace), the
// injected clock/id suppliers (deterministic ticks, sequential keys), and
// THE determinism: two harnesses built the same way drive byte-identical
// flows (identical ledger rows, counters, and audit envelopes).
import { describe, expect, it } from 'vitest';
import { driveTenantIsolationProbes } from './tenant-isolation';
import { makeConformanceHarness } from './harness';
import { CANONICAL_DESCRIPTORS } from './harness';

describe('the deterministic conformance harness (OFF-036)', () => {
  it('wires the REAL gateway over the canonical descriptor vocabulary', () => {
    const harness = makeConformanceHarness();
    expect(CANONICAL_DESCRIPTORS.map((descriptor) => descriptor.commandName)).toStrictEqual([
      'cost.listCostItems',
      'field.recordProgress',
      'documents.submitDailyLog',
      'cost.commitBudgetRevision',
      'cost.purgeCostLedger',
    ]);
    // The counting gateway delegates to the real one: an executed read
    // through the harness gateway invokes the counting handler exactly once.
    expect(harness.handlerInvocations.count).toBe(0);
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.ledger.size()).toBe(0);
  });

  it('pre-populates two ACTIVE installations — one per tenant — with live grants and a namespace', () => {
    const harness = makeConformanceHarness();
    const installations = harness.store.installations.installations();
    expect(installations.map((installation) => installation.installationId)).toStrictEqual([
      harness.installations.a,
      harness.installations.b,
    ]);
    expect(new Set(installations.map((installation) => installation.tenantId)).size).toBe(2);
    expect(installations.every((installation) => installation.state === 'active')).toBe(true);
    for (const installationId of [harness.installations.a, harness.installations.b]) {
      const capabilities = harness.store
        .permissions.ofInstallation(installationId)
        .map((permission) => permission.spec.capability);
      expect([...capabilities].sort()).toStrictEqual(['work.read', 'work.write']);
      expect(harness.store.namespace.commandsOf(installationId).length).toBe(1);
      expect(harness.store.namespace.eventsOf(installationId).length).toBe(1);
    }
  });

  it('ticks the injected clock deterministically and mints sequential idempotency keys', () => {
    const harness = makeConformanceHarness();
    const first = harness.now();
    const second = harness.now();
    expect(first < second).toBe(true);
    // setClock jumps deterministically (the same offset maps to the same
    // tick — no wall clock anywhere).
    harness.setClock(700);
    const jumped = harness.now();
    expect(jumped > second).toBe(true);
    expect(harness.nextKey()).toBe('sec-00001');
    expect(harness.nextKey()).toBe('sec-00002');
  });

  it('THE determinism: two harnesses built the same way drive byte-identical flows', async () => {
    const left = makeConformanceHarness();
    const right = makeConformanceHarness();
    const leftProbes = await driveTenantIsolationProbes(left);
    const rightProbes = await driveTenantIsolationProbes(right);
    // Identical probes (typed evidence records), identical counters...
    expect(leftProbes).toStrictEqual(rightProbes);
    expect(left.countedGateway.calls.count).toBe(right.countedGateway.calls.count);
    expect(left.handlerInvocations.count).toBe(right.handlerInvocations.count);
    // ...and byte-identical audit ledger rows (derived ids, dense
    // sequences, envelopes, aggregate refs).
    expect(left.ledger.events()).toStrictEqual(right.ledger.events());
    expect(left.ledger.events().map((event) => event.eventId)).toStrictEqual(
      right.ledger.events().map((event) => event.eventId),
    );
    // The raw sinks agree with the combined ledger projection.
    expect(left.gatewaySink.events.length + left.appSink.events.length).toBe(left.ledger.size());
    expect(right.gatewaySink.events.length + right.appSink.events.length).toBe(
      right.ledger.size(),
    );
  });

  it('honors a custom scenario name (the report carries it)', () => {
    const harness = makeConformanceHarness({ name: 'office-release-gate-golden' });
    expect(harness.name).toBe('office-release-gate-golden');
    expect(makeConformanceHarness().name).toBe('office-security-conformance');
  });
});
