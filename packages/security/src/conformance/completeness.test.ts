// OFF-036 security — THE audit-completeness conformance acceptance (A3).
//
// THE completeness counting, driven through the REAL gateway + REAL app
// runtime: a golden set of consequential mutations (executed reads and
// writes, an approval routing, a typed denial, a duplicate replay, an app
// command dispatch — which audits BOTH the runtime's dispatch decision and
// the gateway's execution decision — an audited pre-gateway rejection, an
// event delivery, an agent run, and a sync conflict) is accounted for, and
// the (tenant, causation, event name) multiset the mutations EXPECT must
// equal the multiset the audit ledger HOLDS: no missing envelope (an
// unaudited consequential mutation), no unclaimed envelope (an audit event
// with no accounted mutation). The evaluator's detection power is proven
// against forged evidence in both directions.
import { parseCausationId } from '@office/contracts';
import type { CausationId } from '@office/contracts';
import { describe, expect, it } from 'vitest';
import { makeConformanceHarness } from './harness';
import {
  auditLedgerSnapshot,
  driveConsequentialMutations,
  evaluateAuditCompleteness,
} from './completeness';
import type { AuditCompletenessEvidence } from './completeness';

/** Fixture helper: a branded CausationId from a known-good literal. */
const causationIdOf = (raw: string): CausationId => {
  const parsed = parseCausationId(raw);
  if (!parsed.ok) throw new TypeError(`fixture causation id: ${raw}`);
  return parsed.value;
};


describe('THE audit-completeness conformance check (OFF-036, A3)', () => {
  it('drives the golden consequential-mutation set and the completeness counting passes', async () => {
    const harness = makeConformanceHarness();
    const mutations = await driveConsequentialMutations(harness);
    const evidence: AuditCompletenessEvidence = {
      mutations,
      ledger: auditLedgerSnapshot(harness),
    };
    const result = evaluateAuditCompleteness(evidence);
    expect(result.check).toBe('audit-completeness');
    expect(result.probes).toBe(10);
    expect(result.passed).toBe(true);
    expect(result.failures).toStrictEqual([]);
    // The counting is exhaustive: every ledger row belongs to an accounted
    // mutation, and every accounted envelope is held.
    expect(harness.ledger.size()).toBe(
      mutations.reduce((sum, mutation) => sum + mutation.expectedAuditEvents.length, 0),
    );
  });

  it('every mutation kind of the platform is accounted for (gateway, app runtime, agents, sync)', async () => {
    const harness = makeConformanceHarness();
    const mutations = await driveConsequentialMutations(harness);
    const kinds = new Set(mutations.map((mutation) => mutation.kind));
    expect([...kinds].sort()).toStrictEqual(
      ['agent-run', 'app-command-dispatch', 'app-event-delivery', 'gateway-decision', 'sync-conflict'].sort(),
    );
  });

  it('every consequential decision leaves its audit envelope under its own causation', async () => {
    const harness = makeConformanceHarness();
    const mutations = await driveConsequentialMutations(harness);
    const byMutation = mutations.map((mutation) => ({
      label: mutation.label,
      held: mutation.expectedAuditEvents.every((eventName) =>
        harness.ledger
          .byCausation((mutation.causationId ?? causationIdOf('completeness-fallback')) as never)
          .some((event) => event.envelope.eventName === eventName),
      ),
    }));
    expect(byMutation.every((entry) => entry.held)).toBe(true);
    // Spot checks: the gateway decisions, the dual-enveloped app dispatch,
    // the duplicate observation, and the grammar-only agent/sync records.
    const executed = mutations.find((mutation) => mutation.label === 'read-execution');
    expect(executed?.expectedAuditEvents).toStrictEqual(['actions.actionExecuted']);
    const dispatch = mutations.find((mutation) => mutation.label === 'app-command-dispatch');
    expect(dispatch?.expectedAuditEvents).toStrictEqual([
      'apps.appCommandDispatched',
      'actions.actionExecuted',
    ]);
    const replay = mutations.find((mutation) => mutation.label === 'duplicate-replay');
    expect(replay?.expectedAuditEvents).toStrictEqual(['actions.actionDuplicateObserved']);
    const agentRun = mutations.find((mutation) => mutation.label === 'agent-run-completed');
    expect(agentRun?.expectedAuditEvents).toStrictEqual(['agents.agentRunCompleted']);
    const conflict = mutations.find((mutation) => mutation.label === 'sync-conflict-surfaced');
    expect(conflict?.expectedAuditEvents).toStrictEqual(['sync.conflictSurfaced']);
  });

  it('detection power: a MISSING audit envelope is typed-reported (an unaudited mutation)', async () => {
    const harness = makeConformanceHarness();
    const mutations = await driveConsequentialMutations(harness);
    const ledger = auditLedgerSnapshot(harness);
    // Drop one row from the observed ledger: the mutation that expected it
    // is now unaudited.
    const dropped = ledger.slice(0, -1);
    const result = evaluateAuditCompleteness({ mutations, ledger: dropped });
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('audit-envelope-missing');
  });

  it('detection power: an UNCLAIMED audit envelope is typed-reported', async () => {
    const harness = makeConformanceHarness();
    const mutations = await driveConsequentialMutations(harness);
    const ledger = auditLedgerSnapshot(harness);
    // One accounting record withdrawn: its envelope is now unclaimed.
    const result = evaluateAuditCompleteness({ mutations: mutations.slice(0, -1), ledger });
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('unclaimed-audit-envelope');
  });

  it('detection power: duplicated audit envelopes beyond the accounted multiplicity are typed-reported', async () => {
    const harness = makeConformanceHarness();
    const mutations = await driveConsequentialMutations(harness);
    const ledger = [...auditLedgerSnapshot(harness)];
    const duplicated = [...ledger, (ledger[0] ?? ({ eventName: '', tenantId: '', causationId: null } as unknown as (typeof ledger)[number]))];
    const result = evaluateAuditCompleteness({ mutations, ledger: duplicated });
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain('unclaimed-audit-envelope');
  });
});
