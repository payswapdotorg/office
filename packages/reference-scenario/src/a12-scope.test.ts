// Office reference-scenario — the A12 scope self-gate (OFF-037).
//
// Freeze A12 (ONE project state, all clients share it): the scenario world's
// EVERY command surface resolves through ONE typed session record, and a
// foreign session's submission is a TYPED rejection — never data, never an
// existence oracle, never a throw, never a ledger effect. Both directions:
//
//   - a FOREIGN TENANT session (a different, well-formed tenant id) naming
//     the REAL project scope is typed-rejected before any command surface is
//     touched (the world's `submit` gates scope FIRST);
//   - a SAME-TENANT session on a FOREIGN project id is typed-rejected the
//     same way (the second boundary of the same gate);
//   - the world's read gate (`readGuard`) typed-rejects both foreign
//     directions while the seeded session reads;
//   - the SEEDED-SESSION CONTROL: the very same command payload, submitted by
//     the world's own session, EXECUTES — proving the gate (not the parser)
//     is what rejects the foreign submissions.
//
// Every rejection leaves ZERO ledger effects and ZERO command-journal
// entries: the A12 gate fires before composition, so a foreign session can
// never even mint an idempotency key into the world's dispatch log.
import { describe, expect, it } from 'vitest';
import { RECORD_COST_ITEM_COMMAND } from '@office/domain-cost';
import { parseProjectId, parseTenantId } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import type { ReferenceScenarioParts, ScenarioRun, ScenarioSession } from './index';
import { runReferenceScenario, sessionCoversScope } from './index';

const FIXED_NOW = '2026-10-06T09:00:00.000Z';

const parts = (): ReferenceScenarioParts => {
  let tick = 0;
  return {
    tenantId: 'office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    projectId: 'office-prj-v1-referenceworks01',
    actorId: 'office-ent-v1-scenarioactor0001',
    correlationId: 'ref-scenario-correlation-0001',
    adapterActorId: 'office-ent-v1-scenarioadapter1',
    now: () => FIXED_NOW as Timestamp,
    newOpaqueId: () => `ref${String((tick += 1)).padStart(13, '0')}`,
  };
};

/** A foreign tenant id (well-formed, never this world's tenant). */
const FOREIGN_TENANT_ID = 'office-tnt-v1-ffffffffffffffffffffffffffffffff';
/** A foreign project id (well-formed, never this world's project). */
const FOREIGN_PROJECT_ID = 'office-prj-v1-foreignworks9999';

// The foreign identities are parsed through the contracts package's own
// fail-closed helpers: a foreign session is WELL-FORMED (the gate rejects on
// scope, never on malformedness — the exact distinction A12 draws).
const foreignTenantId = (() => {
  const parsed = parseTenantId(FOREIGN_TENANT_ID);
  if (!parsed.ok) throw new TypeError(`a12 fixture error (tenant): ${parsed.error.code}`);
  return parsed.value;
})();
const foreignProjectId = (() => {
  const parsed = parseProjectId(FOREIGN_PROJECT_ID);
  if (!parsed.ok) throw new TypeError(`a12 fixture error (project): ${parsed.error.code}`);
  return parsed.value;
})();

// ONE shared run of THE chain — the A12 probes submit against its world.
const runPromise: Promise<ScenarioRun> = runReferenceScenario(parts());

/** The A12 probe payload: one of the chain's own commands over the world's budget. */
const probePayload = (run: ScenarioRun): Record<string, unknown> => ({
  budgetId: run.costImpact.budgetId,
  expectedVersion: run.world.stores.cost.budgets[0]?.version ?? 1,
  code: 'a12-scope-probe-01',
  description: 'An A12 scope probe submission',
  unit: 'm2',
  quantityMilli: 1000,
  unitRateMinor: 100,
});

describe('A12 — the scenario world resolves through ONE typed session scope', () => {
  it('typed-rejects a FOREIGN TENANT session naming the real project scope, with zero ledger effects', async () => {
    const run = await runPromise;
    const ledgerBefore = run.world.ledger.count;
    const journalBefore = run.world.commandJournal.length;

    // Direction 1: a different tenant's session, naming the REAL project id.
    // Well-formed in every field — the tenant id is the only difference.
    const foreignTenantSession: ScenarioSession = {
      ...run.world.session,
      scope: { ...run.world.scope, tenantId: foreignTenantId },
    };
    expect(sessionCoversScope(foreignTenantSession, run.world.scope)).toBe(false);

    const submission = await run.world.submit(foreignTenantSession, {
      commandName: RECORD_COST_ITEM_COMMAND,
      payload: probePayload(run),
      scope: run.world.scope,
      idempotencyKey: 'a12-probe-foreign-tenant-1',
    });
    expect(submission.ok).toBe(false);
    if (!submission.ok) {
      expect(submission.error.code).toBe('forbidden');
      expect(submission.error.details[0]?.code).toBe('session-scope-violation');
    }

    // ZERO effects: no ledger event, no journal entry (the gate fires before
    // composition, so the foreign key never even lands in the dispatch log).
    expect(run.world.ledger.count).toBe(ledgerBefore);
    expect(run.world.commandJournal.length).toBe(journalBefore);
  }, 60000);

  it('typed-rejects a SAME-TENANT session on a foreign project id, with zero ledger effects', async () => {
    const run = await runPromise;
    const ledgerBefore = run.world.ledger.count;
    const journalBefore = run.world.commandJournal.length;

    // Direction 2: this tenant's session, on a DIFFERENT project.
    const foreignProjectSession: ScenarioSession = {
      ...run.world.session,
      scope: { ...run.world.scope, projectId: foreignProjectId },
    };
    expect(sessionCoversScope(foreignProjectSession, run.world.scope)).toBe(false);

    const submission = await run.world.submit(foreignProjectSession, {
      commandName: RECORD_COST_ITEM_COMMAND,
      payload: probePayload(run),
      scope: run.world.scope,
      idempotencyKey: 'a12-probe-foreign-project-1',
    });
    expect(submission.ok).toBe(false);
    if (!submission.ok) {
      expect(submission.error.code).toBe('forbidden');
      expect(submission.error.details[0]?.code).toBe('session-scope-violation');
    }

    // ZERO effects again — same typed rejection, same invisible world.
    expect(run.world.ledger.count).toBe(ledgerBefore);
    expect(run.world.commandJournal.length).toBe(journalBefore);
  }, 60000);

  it('typed-rejects the world read guard for both foreign directions (the seeded session reads)', async () => {
    const run = await runPromise;

    const foreignTenantSession: ScenarioSession = {
      ...run.world.session,
      scope: { ...run.world.scope, tenantId: foreignTenantId },
    };
    const foreignProjectSession: ScenarioSession = {
      ...run.world.session,
      scope: { ...run.world.scope, projectId: foreignProjectId },
    };

    // A foreign session reads NOTHING of this world — the typed rejection.
    const tenantRead = run.world.readGuard(foreignTenantSession);
    expect(tenantRead.ok).toBe(false);
    if (!tenantRead.ok) {
      expect(tenantRead.error.code).toBe('forbidden');
      expect(tenantRead.error.details[0]?.code).toBe('session-scope-violation');
    }
    const projectRead = run.world.readGuard(foreignProjectSession);
    expect(projectRead.ok).toBe(false);
    if (!projectRead.ok) {
      expect(projectRead.error.code).toBe('forbidden');
    }

    // The seeded session reads (the control) — and the guards had no effects.
    const ownRead = run.world.readGuard(run.world.session);
    expect(ownRead.ok).toBe(true);
    expect(sessionCoversScope(run.world.session, run.world.scope)).toBe(true);
  }, 60000);

  it('the SEEDED-SESSION control executes the very same command the foreign sessions were rejected on', async () => {
    const run = await runPromise;
    const ledgerBefore = run.world.ledger.count;

    // The identical payload (same budget id, same code, same everything but
    // the idempotency key), submitted by the world's OWN session: it passes
    // the A12 gate, reaches the cost command surface, and EXECUTES — proving
    // the gate, not the parser, is what rejected the foreign submissions.
    const control = await run.world.submit(run.world.session, {
      commandName: RECORD_COST_ITEM_COMMAND,
      payload: probePayload(run),
      scope: run.world.scope,
      idempotencyKey: 'a12-probe-control-1',
    });
    expect(control.ok).toBe(true);

    // The control's effect landed exactly once: one new ledger event, one new
    // journal entry (executed) — the seeded session's submission is real.
    expect(run.world.ledger.count).toBe(ledgerBefore + 1);
    const journal = run.world.commandJournal;
    const entry = journal[journal.length - 1];
    expect(entry?.outcome).toBe('executed');
    expect(entry?.eventId).not.toBeNull();
    expect(entry?.commandName).toBe('cost.recordCostItem');
    // The recorded cost item carries the probe's code — the world answers the
    // seeded session with data, and the foreign sessions with the SAME typed
    // rejection (no existence oracle either way).
    const budget = run.world.stores.cost.budgets[0];
    expect(budget).toBeDefined();
    if (budget !== undefined) {
      expect(
        Object.values(budget.costItems).some((item) => item.code === 'a12-scope-probe-01'),
      ).toBe(true);
    }
  }, 60000);
});
