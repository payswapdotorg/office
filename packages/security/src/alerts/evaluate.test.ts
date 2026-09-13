// OFF-036 security — THE sensitive-action alert evaluation acceptance.
//
// evaluateSensitiveActionAlerts() over a ledger populated by the REAL
// gateway + REAL app runtime (the deterministic harness): the A12 watch
// fires with FULL PROVENANCE (ledger event ids, in ledger order), the
// threshold gates clusters (three denials fire the cluster rule, two do
// not), every matching kind of the vocabulary fires on its own evidence,
// the derived alert identities parse under the canonical grammar, the
// evaluation is scope-filtered (A12: tenant B's evaluation never sees
// tenant A's audit events), and it is deterministic run-twice.
import { describe, expect, it } from 'vitest';
import {
  ALERT_ID_GRAMMAR,
  DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
  TENANT_A,
  TENANT_B,
  appActorOf,
  APP_ID_A,
  createInMemoryAuditLedger,
  defineAlertRule,
  domainEventOf,
  driveTenantIsolationProbes,
  evaluateSensitiveActionAlerts,
  expectOk,
  isAlertId,
  makeConformanceHarness,
  parseAlertId,
  tenantAScope,
  tenantBScope,
} from '../index';
import { alertIdOf, alertRuleKindMatches } from '../index';
import type { AuditDecisionObservation } from '../index';

/** One observation fixture (the fail-closed narrowing input). */
const observation = (parts: Partial<AuditDecisionObservation>): AuditDecisionObservation => ({
  decision: 'denied',
  denialCode: 'tenant-scope-violation',
  requiredCapabilities: [],
  actionClass: null,
  ...parts,
});

describe('the alert matching vocabulary (OFF-036)', () => {
  it('matches every kind by its closed predicate (pure)', () => {
    expect(alertRuleKindMatches('denied-action-cluster', observation({}))).toBe(true);
    expect(alertRuleKindMatches('denied-action-cluster', observation({ decision: 'executed' }))).toBe(false);
    expect(
      alertRuleKindMatches('denied-action-cluster', observation({ decision: 'command-rejected' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('denied-action-cluster', observation({ decision: 'event-rejected' })),
    ).toBe(true);
    expect(alertRuleKindMatches('denied-action-cluster', observation({ decision: null }))).toBe(false);

    expect(alertRuleKindMatches('cross-tenant-denial', observation({}))).toBe(true);
    expect(
      alertRuleKindMatches('cross-tenant-denial', observation({ denialCode: 'cross-tenant-scope' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('cross-tenant-denial', observation({ denialCode: 'project-scope-violation' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('cross-tenant-denial', observation({ denialCode: 'no-allow-rule' })),
    ).toBe(false);

    expect(
      alertRuleKindMatches('prohibited-class-attempt', observation({ denialCode: 'unknown-action' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('prohibited-class-attempt', observation({ denialCode: 'prohibited-action' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('prohibited-class-attempt', observation({ denialCode: 'explicit-deny' })),
    ).toBe(false);

    expect(
      alertRuleKindMatches('actor-kind-rejection', observation({ denialCode: 'actor-kind-not-permitted' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('actor-kind-rejection', observation({ denialCode: 'no-allow-rule' })),
    ).toBe(false);

    expect(
      alertRuleKindMatches('revocation-activity', observation({ denialCode: 'installation-suspended' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('revocation-activity', observation({ denialCode: 'capability-revoked' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('revocation-activity', observation({ denialCode: 'no-allow-rule' })),
    ).toBe(false);

    expect(
      alertRuleKindMatches('sensitive-execution', observation({ decision: 'executed', actionClass: 'approval-required' })),
    ).toBe(true);
    expect(
      alertRuleKindMatches('sensitive-execution', observation({ decision: 'executed', actionClass: 'reversible' })),
    ).toBe(false);
    expect(
      alertRuleKindMatches('sensitive-execution', observation({ decision: 'denied', actionClass: 'approval-required' })),
    ).toBe(false);
  });

  it('derives alert identities deterministically (same inputs, same id)', () => {
    const first = alertIdOf({
      ruleId: 'cross-tenant-denials-critical',
      tenantId: TENANT_A,
      eventIds: ['office-evt-v1-0123456789abcdef0123456789abcdef'],
    });
    const second = alertIdOf({
      ruleId: 'cross-tenant-denials-critical',
      tenantId: TENANT_A,
      eventIds: ['office-evt-v1-0123456789abcdef0123456789abcdef'],
    });
    expect(first).toBe(second);
    expect(isAlertId(first)).toBe(true);
    expect(expectOk(parseAlertId(first))).toBe(first);
    // Distinct evidence (or tenant, or rule) derives a distinct id.
    expect(
      alertIdOf({
        ruleId: 'cross-tenant-denials-critical',
        tenantId: TENANT_A,
        eventIds: ['office-evt-v1-fedcba9876543210fedcba9876543210'],
      }),
    ).not.toBe(first);
    expect(
      alertIdOf({
        ruleId: 'cross-tenant-denials-critical',
        tenantId: TENANT_B,
        eventIds: ['office-evt-v1-0123456789abcdef0123456789abcdef'],
      }),
    ).not.toBe(first);
    // The grammar description is exported for parse failures.
    expect(ALERT_ID_GRAMMAR).toContain('office-alt-v1-');
    expect(isAlertId('office-alt-v1-SHORT')).toBe(false);
    expect(isAlertId('office-rev-v1-0123456789abcdef0123456789abcdef')).toBe(false);
  });
});

describe('THE alert evaluation over the audit stream (OFF-036)', () => {
  it('fires the A12 watch over the REAL driven ledger with full provenance', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    const result = evaluateSensitiveActionAlerts({
      rules: DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
      ledger: harness.ledger,
      scope: tenantAScope(),
    });
    expect(result.scannedEvents).toBe(4);
    const ruleIds = result.alerts.map((alert) => alert.ruleId);
    expect(ruleIds).toStrictEqual(['cross-tenant-denials-critical', 'denied-action-cluster-warning']);
    const crossTenant = result.alerts.find(
      (alert) => alert.ruleId === 'cross-tenant-denials-critical',
    );
    expect(crossTenant?.kind).toBe('cross-tenant-denial');
    expect(crossTenant?.severity).toBe('critical');
    expect(crossTenant?.tenantId).toBe(TENANT_A);
    expect(crossTenant?.observed).toBe(4);
    // FULL PROVENANCE: every matching ledger event, in ledger order.
    expect(crossTenant?.evidence.length).toBe(4);
    for (const entry of crossTenant?.evidence ?? []) {
      expect(entry.eventId).toMatch(/^office-evt-v1-[0-9a-f]{32}$/);
      expect(entry.eventName).toMatch(/^(actions|apps)\./);
    }
    expect(isAlertId(crossTenant?.alertId ?? '')).toBe(true);
  });

  it('thresholds gate clusters: two denials do not fire the three-denial cluster rule', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    // Re-append only the first two tenant-A rejections into a fresh ledger
    // (the same evidence, one row short of the cluster threshold).
    const twoLedger = createInMemoryAuditLedger();
    for (const event of harness.ledger.eventsOfTenant(TENANT_A).slice(0, 2)) {
      expectOk(twoLedger.append(event.envelope));
    }
    const twoOnly = evaluateSensitiveActionAlerts({
      rules: DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
      ledger: twoLedger,
      scope: tenantAScope(),
    });
    expect(twoOnly.scannedEvents).toBe(2);
    expect(twoOnly.alerts.map((alert) => alert.ruleId)).toStrictEqual([
      'cross-tenant-denials-critical',
    ]);
  });

  it('every matching kind fires on its own evidence (a grammar-only sensitive execution)', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    // An approval-class action that EXECUTED (a completed approval) — the
    // sensitive-execution watch — recorded through the envelope grammar.
    expectOk(
      harness.ledger.append(
        domainEventOf('actions.actionExecuted', {
          scope: tenantAScope(),
          actor: appActorOf(APP_ID_A),
          payload: { decision: 'executed', actionClass: 'approval-required' },
        }),
      ),
    );
    const result = evaluateSensitiveActionAlerts({
      rules: DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
      ledger: harness.ledger,
      scope: tenantAScope(),
    });
    expect(result.alerts.map((alert) => alert.ruleId)).toStrictEqual([
      'cross-tenant-denials-critical',
      'denied-action-cluster-warning',
      'sensitive-executions-info',
    ]);
    const sensitive = result.alerts.find((alert) => alert.ruleId === 'sensitive-executions-info');
    expect(sensitive?.observed).toBe(1);
    expect(sensitive?.evidence[0]?.eventName).toBe('actions.actionExecuted');
  });

  it('fires custom rules (operators derive their own sets through the same surface)', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    const result = evaluateSensitiveActionAlerts({
      rules: [
        defineAlertRule({
          ruleId: 'tenant-a-rejections',
          kind: 'denied-action-cluster',
          severity: 'critical',
          threshold: 1,
          description: 'Any typed denial fires immediately.',
        }),
      ],
      ledger: harness.ledger,
      scope: tenantAScope(),
    });
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]?.ruleId).toBe('tenant-a-rejections');
    expect(result.alerts[0]?.observed).toBe(4);
  });

  it('is scope-filtered (A12): tenant B never sees tenant A audit events', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    const tenantB = evaluateSensitiveActionAlerts({
      rules: DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
      ledger: harness.ledger,
      scope: tenantBScope(),
    });
    const tenantA = evaluateSensitiveActionAlerts({
      rules: DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
      ledger: harness.ledger,
      scope: tenantAScope(),
    });
    expect(tenantB.scannedEvents).toBe(3);
    expect(tenantA.scannedEvents).toBe(4);
    expect(tenantB.alerts.every((alert) => alert.tenantId === TENANT_B)).toBe(true);
    expect(tenantA.alerts.every((alert) => alert.tenantId === TENANT_A)).toBe(true);
    // The two evaluations' provenance is disjoint (A12 in both directions).
    const evidenceA = new Set(
      tenantA.alerts.flatMap((alert) => alert.evidence.map((entry) => entry.eventId)),
    );
    const evidenceB = new Set(
      tenantB.alerts.flatMap((alert) => alert.evidence.map((entry) => entry.eventId)),
    );
    expect([...evidenceB].every((eventId) => !evidenceA.has(eventId))).toBe(true);
  });

  it('is deterministic run-twice: the same rules over the same ledger state deep-equal', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    const input = {
      rules: DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
      ledger: harness.ledger,
      scope: tenantAScope(),
    } as const;
    const first = evaluateSensitiveActionAlerts(input);
    const second = evaluateSensitiveActionAlerts(input);
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('fires nothing over an empty trail (no evidence, no alerts)', () => {
    const harness = makeConformanceHarness();
    const result = evaluateSensitiveActionAlerts({
      rules: DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
      ledger: harness.ledger,
      scope: tenantAScope(),
    });
    expect(result.scannedEvents).toBe(0);
    expect(result.alerts).toStrictEqual([]);
  });
});
