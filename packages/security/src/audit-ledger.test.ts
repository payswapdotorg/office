// OFF-036 security — the in-memory audit ledger acceptance suite.
//
// The ledger is THE read model every conformance check, access review,
// alert evaluation, and retention projection derives from. This suite proves
// its own contracts: fail-closed appending (contract-invalid envelopes and
// non-audit event names are typed-rejected, never stored), deterministic
// derived identities (two ledgers fed the same sequence hold byte-identical
// rows), the A12 scope-filtered read views (a tenant query never sees a
// foreign tenant's events; a project query sees its own project's events
// plus tenant-wide audit events, never a foreign project's), causation
// lookups, and the defensive-copy discipline of every read view.
import { parseCausationId } from '@office/contracts';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_CLASSES,
  auditEventClassOf,
  createInMemoryAuditLedger,
  domainEventOf,
  driveTenantIsolationProbes,
  expectFail,
  expectOk,
  makeConformanceHarness,
  TENANT_A,
  TENANT_B,
  PROJECT_2,
  projectOneScope,
  tenantAScope,
  tenantBScope,
} from './index';

describe('audit event classes (OFF-036)', () => {
  it('declares the four platform audit-trail areas in vocabulary order', () => {
    expect([...AUDIT_EVENT_CLASSES]).toStrictEqual(['actions', 'apps', 'agents', 'sync']);
  });

  it('classifies canonical event names by their first segment (fail-closed)', () => {
    expect(auditEventClassOf('actions.actionExecuted')).toBe('actions');
    expect(auditEventClassOf('apps.appCommandDispatched')).toBe('apps');
    expect(auditEventClassOf('agents.agentRunCompleted')).toBe('agents');
    expect(auditEventClassOf('sync.conflictSurfaced')).toBe('sync');
    expect(auditEventClassOf('projects.projectCreated')).toBeNull();
    expect(auditEventClassOf('cost.costItemRecorded')).toBeNull();
  });
});

describe('the in-memory audit ledger (OFF-036)', () => {
  it('typed-rejects a contract-invalid envelope and stores nothing (fail-closed)', () => {
    const ledger = createInMemoryAuditLedger();
    const broken = {
      ...domainEventOf('actions.actionExecuted'),
      eventName: 'not a valid event name at all',
    } as unknown as ReturnType<typeof domainEventOf>;
    const appended = ledger.append(broken);
    const error = expectFail(appended);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('audit-envelope-invalid');
    expect(ledger.size()).toBe(0);
    expect(ledger.events()).toStrictEqual([]);
  });

  it('typed-rejects a non-audit event name — the security ledger records audit trails only', () => {
    const ledger = createInMemoryAuditLedger();
    const domainEvent = domainEventOf('projects.projectCreated', { entityKind: 'project' });
    const error = expectFail(ledger.append(domainEvent));
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('audit-event-class-unknown');
    expect(ledger.size()).toBe(0);
  });

  it('appends validated audit envelopes with dense sequences and deterministic ids', () => {
    const ledger = createInMemoryAuditLedger();
    const first = expectOk(ledger.append(domainEventOf('actions.actionExecuted')));
    const second = expectOk(ledger.append(domainEventOf('actions.actionDenied')));
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.eventId).not.toBe(second.eventId);
    expect(ledger.size()).toBe(2);
    expect(ledger.events().map((event) => event.envelope.eventName)).toStrictEqual([
      'actions.actionExecuted',
      'actions.actionDenied',
    ]);
  });

  it('reproduces byte-identical rows for the same append sequence (determinism)', () => {
    const build = () => {
      const ledger = createInMemoryAuditLedger();
      expectOk(ledger.append(domainEventOf('actions.actionExecuted')));
      expectOk(ledger.append(domainEventOf('apps.appCommandDispatched')));
      expectOk(ledger.append(domainEventOf('agents.agentRunCompleted', { entityKind: 'agent-run' })));
      expectOk(ledger.append(domainEventOf('sync.conflictSurfaced', { entityKind: 'conflict-record' })));
      return ledger;
    };
    const left = build();
    const right = build();
    expect(left.events()).toStrictEqual(right.events());
    expect(left.events().map((event) => event.eventId)).toStrictEqual(
      right.events().map((event) => event.eventId),
    );
  });

  it('scopes every read view by tenant (A12: a tenant never sees a foreign trail)', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveTenantIsolationProbes(harness);
    // Rejections land in the REQUESTING tenant's trail only (the driver
    // proves the direction); the read views must agree.
    const tenantAEvents = harness.ledger.eventsOfTenant(TENANT_A);
    const tenantBEvents = harness.ledger.eventsOfTenant(TENANT_B);
    expect(tenantAEvents.length).toBeGreaterThan(0);
    expect(tenantBEvents.length).toBeGreaterThan(0);
    for (const event of tenantAEvents) {
      expect(event.envelope.scope.tenantId).toBe(TENANT_A);
    }
    for (const event of tenantBEvents) {
      expect(event.envelope.scope.tenantId).toBe(TENANT_B);
    }
    expect(harness.ledger.eventsInScope(tenantAScope())).toStrictEqual(tenantAEvents);
    expect(harness.ledger.eventsInScope(tenantBScope())).toStrictEqual(tenantBEvents);
    // The probes themselves observed exactly this split.
    const aToB = probes.filter((probe) => probe.requestingTenantId === TENANT_A);
    const bToA = probes.filter((probe) => probe.requestingTenantId === TENANT_B);
    expect(aToB.every((probe) => probe.auditInForeignTenant === 0)).toBe(true);
    expect(bToA.every((probe) => probe.auditInForeignTenant === 0)).toBe(true);
  });

  it('a project-scoped query sees its own project events plus tenant-wide audit events, never a foreign project (A12)', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    // Every recorded event of tenant A so far is tenant-wide (the rejections
    // are audited under the requesting installation/gateway tenant scope) —
    // project-scoped queries see tenant-wide audit events too (A12 coverage
    // semantics).
    const tenantA = harness.ledger.eventsOfTenant(TENANT_A);
    expect(tenantA.length).toBeGreaterThan(0);
    expect(harness.ledger.eventsInScope(projectOneScope()).length).toBe(tenantA.length);

    // A project-scoped event of the SAME tenant is visible from its own
    // project's query and invisible from a foreign project's query.
    const scoped = domainEventOf('actions.actionExecuted', { scope: projectOneScope() });
    expectOk(harness.ledger.append(scoped));
    const ownProject = harness.ledger.eventsInScope(projectOneScope());
    expect(ownProject.some((event) => event.envelope.eventName === scoped.eventName)).toBe(true);
    const foreignProject = harness.ledger.eventsInScope({
      kind: 'project',
      tenantId: TENANT_A,
      projectId: PROJECT_2,
    });
    expect(foreignProject.some((event) => event.envelope.eventName === scoped.eventName)).toBe(
      false,
    );
    expect(foreignProject.every((event) => event.envelope.scope.tenantId === TENANT_A)).toBe(true);

    // A tenant-B query (tenant or project scope) never sees ANY tenant-A event.
    expect(
      harness.ledger.eventsInScope(tenantBScope()).every(
        (event) => event.envelope.scope.tenantId === TENANT_B,
      ),
    ).toBe(true);
    expect(
      harness.ledger
        .eventsInScope({ kind: 'project', tenantId: TENANT_B, projectId: PROJECT_2 })
        .every((event) => event.envelope.scope.tenantId === TENANT_B),
    ).toBe(true);
  });

  it('answers causation lookups and returns defensive copies only', () => {
    const ledger = createInMemoryAuditLedger();
    const caused = domainEventOf('apps.appCommandRejected', { causationId: 'sec-00042' });
    expectOk(ledger.append(caused));
    expectOk(ledger.append(domainEventOf('actions.actionDenied')));
    const byCausation = ledger.byCausation(expectOk(parseCausationId('sec-00042')));
    expect(byCausation.length).toBe(1);
    expect(byCausation[0]?.envelope.eventName).toBe('apps.appCommandRejected');

    // Every read view is a defensive copy: distinct array identity, equal
    // content, and mutating the copy never touches the ledger.
    const events = ledger.events();
    expect(events).not.toBe(ledger.events());
    expect(events).toStrictEqual(ledger.events());
    const copy = ledger.eventsInScope(tenantAScope());
    (copy as unknown as { length: number }).length = 0;
    expect(ledger.eventsInScope(tenantAScope()).length).toBe(2);
    expect(ledger.size()).toBe(2);
  });
});

describe('tenant isolation probes feed the ledger (driver sanity)', () => {
  it('records both directions on all three surfaces (A12, both directions)', async () => {
    const harness = makeConformanceHarness();
    const probes = await driveTenantIsolationProbes(harness);
    const labels = probes.map((probe) => probe.label);
    expect(labels).toStrictEqual([
      'gateway-a-to-b',
      'gateway-b-to-a',
      'gateway-cross-project',
      'app-command-a-to-b',
      'app-command-b-to-a',
      'app-event-a-to-b',
      'app-event-b-to-a',
    ]);
    const directions = new Set(probes.map((probe) => probe.direction));
    expect([...directions].sort()).toStrictEqual(['a-to-b', 'b-to-a', 'cross-project']);
    expect(probes.every((probe) => probe.rejected)).toBe(true);
  });
});
