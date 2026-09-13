import { describe, expect, it } from 'vitest';
import { runReferenceScenario, replayNotifications, causalWalk } from './index';

const FIXED_NOW = '2026-10-06T09:00:00.000Z';

const parts = (): Parameters<typeof runReferenceScenario>[0] => {
  let tick = 0;
  return {
    tenantId: 'office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    projectId: 'office-prj-v1-referenceworks01',
    actorId: 'office-ent-v1-scenarioactor0001',
    correlationId: 'ref-scenario-correlation-0001',
    adapterActorId: 'office-ent-v1-scenarioadapter1',
    now: () => FIXED_NOW as never,
    newOpaqueId: () => `ref${String((tick += 1)).padStart(13, '0')}`,
  };
};

describe('smoke', () => {
  it('runs the chain', async () => {
    const run = await runReferenceScenario(parts());
    expect(run.modelIngress.event.eventId).toBeTruthy();
    expect(run.costImpact.command.eventId).toBeTruthy();
    expect(run.scheduleIngress.command.eventId).toBeTruthy();
    expect(run.evidence.references).toHaveLength(5);
    expect(run.approval.decided.eventId).toBeTruthy();
    expect(run.execution.committedAfterMinor).toBeGreaterThan(0);
    expect(run.observers.procurement.recommendations.length).toBeGreaterThan(0);
    // The revenue observer correctly finds ZERO candidates on this world:
    // the executed change order CLAIMS the proposed change event, and the
    // landed detection rules (constructive change AND delay impact) both
    // require an UNCLAIMED proposed event — a fully-converted change has
    // nothing to recover. The observer's causal-ID agreement is asserted
    // through its input records + the procurement evidence chains.
    expect(run.observers.revenue.candidates.length).toBe(0);
    const replay = await replayNotifications(run);
    expect(replay.newCanonicalRecords).toBe(0);
    const walk = causalWalk(run);
    expect(walk.hops.length).toBeGreaterThan(5);
    console.log(JSON.stringify({
      ledgerCount: run.world.ledger.count,
      journal: run.world.commandJournal.map((entry) => `${entry.commandName}:${entry.outcome}`),
      procurement: run.observers.procurement.recommendations.map((r) => r.kind),
      revenue: run.observers.revenue.candidates.map((c) => c.kind),
      replayProposals: replay.proposals.map((p) => p.commandName),
    }, null, 2));
  }, 60000);
});
