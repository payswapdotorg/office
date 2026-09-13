// Office reference-scenario — THE golden chain suite (OFF-037).
//
// THE deterministic end-to-end construction reference scenario, asserted step
// by step, plus the TWO named acceptance invariants of the work item:
//
//   INVARIANT #1 — every linked projection agrees on the causal IDs. The
//   causality chain is walked END TO END (event -> command -> aggregate ->
//   projection -> evidence) through `causalWalk`, and every hop's causal ids
//   (its ledger event id, its causation id, the ids its projection cites)
//   resolve into the SAME chain: the model mutation event, the cost command,
//   the schedule update, the approval pair, the execution — one spine, cited
//   identically by the cost position, the schedule impact, the change
//   evidence packet, the approval record, and the two intelligence observers.
//
//   INVARIANT #2 — no duplicate canonical records appear, INCLUDING under
//   replay. Proven three ways: (a) canonical counting — every canonical
//   aggregate appears exactly once (one budget, one commitment with its
//   append-only amendment line-set chain, one invoice, one schedule, distinct
//   cost-item/schedule-element ids) and the ledger carries each event id
//   exactly once with dense per-aggregate sequences; (b) REPLAY — re-delivering
//   the SAME adapter notifications produces ZERO new canonical records and
//   leaves the ledger + command journal lengths unchanged; (c) RUN-TWICE — two
//   runs over fresh equal parts produce byte-identical ledgers and journals.
//
// The suite also proves the displayable-rejection discipline: a stale-version
// submission through the world's own typed path returns {ok:false} with the
// DomainError code, is recorded in the command journal as a rejected entry,
// and has ZERO ledger effects — the chain surfaces typed Results, never a raw
// throw, never a silent overwrite.
//
// The revenue observer's ZERO candidates is the DOCUMENTED landed semantics:
// the executed change order CLAIMS the proposed change event, and both
// constructive-change and delay-impact rules require an UNCLAIMED event — a
// fully-converted change has nothing to recover (see smoke.test.ts).
import { describe, expect, it } from 'vitest';
import { RECORD_COST_ITEM_COMMAND } from '@office/domain-cost';
import type { Timestamp } from '@office/contracts';
import type { ReferenceScenarioParts, ScenarioRun } from './index';
import { causalWalk, replayNotifications, runReferenceScenario } from './index';

const FIXED_NOW = '2026-10-06T09:00:00.000Z';

/** Fresh, EQUAL deterministic parts — every run of the same parts is the same run. */
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

// ONE shared execution of THE chain: every read-only assertion below awaits
// the same run (the scenario is deterministic, so sharing is the proof setup
// for run-twice byte-equality as well). The one MUTATING test (the
// displayable rejection) is declared LAST and snapshots its own before-state.
const runPromise: Promise<ScenarioRun> = runReferenceScenario(parts());

/** The typed DomainError-shaped rejection of a Result (assert helper). */
const rejectionOf = (result: { ok: boolean }): { code: string; details: readonly { code: string }[] } => {
  expect(result.ok).toBe(false);
  const error = (result as { error?: { code?: unknown; details?: unknown } }).error;
  expect(error).toBeDefined();
  expect(typeof error?.code).toBe('string');
  return error as { code: string; details: readonly { code: string }[] };
};

describe('golden — THE end-to-end construction reference scenario (OFF-037)', () => {
  it('runs the chain deterministically end to end — every step lands its record', async () => {
    const run = await runPromise;

    // The seeded world: one tenant, one organization, one project — the scope
    // every chain command is submitted under.
    expect(run.world.identities.organizationId).toMatch(/^office-ent-v1-/);
    expect(run.world.identities.projectId).toBe(run.parts.projectId);
    expect(run.world.scope.projectId).toBe(run.parts.projectId);
    expect(run.world.scope.tenantId).toBe(run.parts.tenantId);

    // 0a. THE FINANCE INGRESS: the commercial baseline landed canonically.
    expect(run.financeIngress.commands.length).toBeGreaterThan(0);
    for (const command of run.financeIngress.commands) {
      expect(command.eventId).toBeTruthy();
      expect(command.commandName).toMatch(/^(cost|schedule)\./);
    }
    // 0b. THE SCHEDULE INGRESS (first pass): the whole network.
    expect(run.scheduleBaseline.commands.length).toBeGreaterThan(0);
    for (const command of run.scheduleBaseline.commands) {
      expect(command.eventId).toBeTruthy();
      expect(command.commandName).toMatch(/^schedule\./);
    }
    expect(run.scheduleBaseline.schedule.entityId).toBeTruthy();
    expect(Object.keys(run.scheduleBaseline.schedule.activities).length).toBeGreaterThan(0);
    // 0c. THE CONSTRUCTION INGRESS: the change-event/document mappings.
    expect(run.constructionIngress.changeEvent.entityId).toMatch(/^office-ent-v1-/);
    expect(run.constructionIngress.document.entityId).toMatch(/^office-ent-v1-/);

    // 1. THE MODEL INGRESS: the wall-element mutation -> the canonical event.
    expect(run.modelIngress.proposal.commandName).toBe('models.recordElementChange');
    expect(run.modelIngress.mutation.quantityAfter).toBeGreaterThan(
      run.modelIngress.mutation.quantityBefore,
    );
    expect(run.modelIngress.mutation.unit).toBeTruthy();
    expect(run.modelIngress.event.eventId).toBeTruthy();
    expect(run.modelIngress.event.envelope.eventName).toBeTruthy();
    expect(run.modelIngress.element.entityId).toMatch(/^office-ent-v1-/);
    expect(run.modelIngress.model.entityId).toMatch(/^office-ent-v1-/);
    expect(run.modelIngress.modelVersion.entityId).toMatch(/^office-ent-v1-/);
    expect(run.modelIngress.affectedEntityRefs.length).toBeGreaterThan(0);

    // 2. THE COST IMPACT: the quantity change through domain-cost's typed path.
    expect(run.costImpact.command.commandName).toBe('cost.recordCostItem');
    expect(run.costImpact.command.eventId).toBeTruthy();
    expect(run.costImpact.quantityMilliDelta).toBe(
      Math.round((run.modelIngress.mutation.quantityAfter - run.modelIngress.mutation.quantityBefore) * 1000),
    );
    expect(run.costImpact.amountMinorDelta).toBeGreaterThan(0);
    // The recorded cost item IS the budget's working-set entry — the linked
    // projection of the cost impact step.
    const budget = run.world.stores.cost.budgets[0];
    expect(budget).toBeDefined();
    if (budget === undefined) return;
    expect(run.costImpact.budgetId).toBe(budget.entityId);
    const changeItem = Object.values(budget.costItems).find(
      (item) => item.entityId === run.costImpact.costItemId,
    );
    expect(changeItem).toBeDefined();
    if (changeItem !== undefined) {
      expect(changeItem.quantityMilli).toBe(run.costImpact.quantityMilliDelta);
      expect(changeItem.amountMinor).toBe(run.costImpact.amountMinorDelta);
      // The exact integer extension of the change (no floats anywhere).
      expect(changeItem.amountMinor * 1000).toBe(
        changeItem.quantityMilli * changeItem.unitRateMinor,
      );
    }

    // 3. THE SCHEDULE INGRESS: the activity update through domain-schedule.
    expect(run.scheduleIngress.command.commandName).toBe('schedule.updateActivity');
    expect(run.scheduleIngress.command.eventId).toBeTruthy();
    expect(run.scheduleIngress.durationAfter).toBeGreaterThan(
      run.scheduleIngress.durationBefore,
    );
    const schedule = run.world.stores.schedule.schedules[0];
    expect(schedule).toBeDefined();
    if (schedule !== undefined) {
      expect(run.scheduleIngress.scheduleId).toBe(schedule.entityId);
      const activity = schedule.activities[run.scheduleIngress.activityId];
      expect(activity).toBeDefined();
      if (activity !== undefined) {
        expect(activity.plannedDuration).toBe(run.scheduleIngress.durationAfter);
        expect(activity.code).toBe(run.scheduleIngress.activityCode);
      }
    }

    // 4. THE CHANGE EVIDENCE: the agents EvidenceSet packet (5 references).
    expect(run.evidence.references).toHaveLength(5);
    expect(run.evidence.packet.items).toHaveLength(5);
    expect(run.evidence.qualified).toBe(true);

    // 5. THE APPROVAL: routed and decided through the workflows machine.
    expect(run.approval.approvalKey).toBe('quantity-change-approval');
    expect(run.approval.submitted.eventId).toBeTruthy();
    expect(run.approval.decided.eventId).toBeTruthy();
    expect(run.approval.decided.commandName).toBe('workflows.approveApproval');
    expect(run.approval.subject.entityId).toBe(run.constructionIngress.changeEvent.entityId);
    expect(run.approval.definitionId).toMatch(/^office-ent-v1-/);
    expect(run.approval.instanceId).toMatch(/^office-ent-v1-/);

    // 6. THE EXECUTION: the approved change applied canonically.
    expect(run.execution.command.commandName).toBe('cost.amendCommitment');
    expect(run.execution.command.eventId).toBeTruthy();
    expect(run.execution.committedAfterMinor).toBeGreaterThan(run.execution.committedBeforeMinor);
    const commitment = run.world.stores.cost.commitments[0];
    expect(commitment).toBeDefined();
    if (commitment !== undefined) {
      expect(run.execution.commitmentId).toBe(commitment.entityId);
      // The amendment line set is a FULL snapshot of the commitment's lines:
      // the executed change order's value is the TIP line set's total minus
      // the CREATION line set's total — exactly the recorded cost impact.
      const lineSetTotal = (lineSet: { lines: readonly { amountMinor: number }[] }): number =>
        lineSet.lines.reduce((sum, line) => sum + line.amountMinor, 0);
      const creation = commitment.lineSets[0];
      const tip = commitment.lineSets[commitment.lineSets.length - 1];
      expect(creation).toBeDefined();
      expect(tip).toBeDefined();
      if (creation !== undefined && tip !== undefined) {
        expect(lineSetTotal(tip) - lineSetTotal(creation)).toBe(run.costImpact.amountMinorDelta);
      }
    }

    // 7. THE OBSERVERS: the two detection surfaces over the executed world.
    expect(run.observers.procurement.recommendations.length).toBeGreaterThan(0);
    for (const recommendation of run.observers.procurement.recommendations) {
      expect(recommendation.recommendationId).toBeTruthy();
      expect(recommendation.kind).toBeTruthy();
    }
    // The revenue observer correctly finds ZERO candidates on this world (the
    // documented landed semantics — the executed change order claims the
    // change event; both recovery rules require an UNCLAIMED event).
    expect(run.observers.revenue.candidates).toStrictEqual([]);
    expect(run.observers.revenue.inputChangeEventId).toBe(
      run.constructionIngress.changeEvent.entityId,
    );

    // The world's ledger + journal both landed (every command, every event).
    expect(run.world.ledger.count).toBeGreaterThan(0);
    expect(run.world.ledger.events.length).toBe(run.world.ledger.count);
    expect(run.world.commandJournal.length).toBeGreaterThan(0);
  }, 60000);

  it('INVARIANT #1 — every linked projection agrees on the causal IDs (the walk, end to end)', async () => {
    const run = await runPromise;
    const walk = causalWalk(run);

    // THE walk covers the whole chain, in order.
    expect(walk.hops.map((hop) => hop.step)).toStrictEqual([
      'model-ingress',
      'cost-impact',
      'schedule-ingress',
      'change-evidence',
      'approval-submitted',
      'approval-decided',
      'execution',
      'observers',
    ]);

    // The chain's own id spaces: every ledger event id, every journal command id.
    const eventIds = new Set<string>(run.world.ledger.events.map((event) => event.eventId));
    const commandIds = new Set<string>(run.world.commandJournal.map((entry) => entry.idempotencyKey));
    // ...plus the originating model proposal (executed through the adapter
    // ledger-append seam, so it never passes through the world's journal).
    commandIds.add(run.modelIngress.proposal.idempotencyKey);

    // (a) Every hop's CAUSAL links resolve into the chain's event ids: the
    // hop's own ledger event id AND the causation id it carries. There is no
    // causal link that dangles outside the chain.
    for (const hop of walk.hops) {
      if (hop.eventId !== null) {
        expect(eventIds.has(hop.eventId), `hop ${hop.step} event id`).toBe(true);
        expect(run.world.ledger.eventOf(hop.eventId), `hop ${hop.step} event resolves`).not.toBeNull();
      }
      if (hop.causationId !== null) {
        expect(eventIds.has(hop.causationId), `hop ${hop.step} causation id`).toBe(true);
      }
      expect(commandIds.has(hop.commandId), `hop ${hop.step} command id`).toBe(true);
    }

    // (b) ONE correlation id carries every command of the chain: the walk's
    // correlation is the scenario's own correlation, every hop downstream of
    // the model origin carries it, and every executed command record does too.
    expect(walk.correlationId).toBe(run.parts.correlationId);
    for (const hop of walk.hops.slice(1)) {
      expect(hop.correlationId, `hop ${hop.step} correlation`).toBe(walk.correlationId);
    }
    for (const record of [
      run.costImpact.command,
      run.scheduleIngress.command,
      run.approval.submitted,
      run.approval.decided,
      run.execution.command,
    ]) {
      expect(record.correlationId).toBe(run.parts.correlationId);
    }

    // (c) THE originating causal chain: the walk's origin is the model
    // adapter's own proposal + the models.elementChanged ledger event.
    expect(walk.originatingCommandId).toBe(run.modelIngress.proposal.idempotencyKey);
    expect(walk.originatingEventId).toBe(run.modelIngress.event.eventId);
    expect(eventIds.has(walk.originatingEventId)).toBe(true);

    // (d) THE causal spine — each downstream step's causation id names the
    // EXACT upstream event the chain's own steps recorded:
    //   model event -> cost command, schedule command, approval submission
    //   approval submission -> approval decision
    //   approval decision -> execution
    expect(run.costImpact.command.causationId).toBe(run.modelIngress.event.eventId);
    expect(run.scheduleIngress.command.causationId).toBe(run.modelIngress.event.eventId);
    expect(run.approval.submitted.causationId).toBe(run.modelIngress.event.eventId);
    expect(run.approval.decided.causationId).toBe(run.approval.submitted.eventId);
    expect(run.execution.command.causationId).toBe(run.approval.decided.eventId);

    // (e) Every id ANY hop's projection cites resolves into the chain's id
    // universe (the ledger's event ids + the world's canonical aggregate ids
    // + the observers' own derived ids) — no projection cites a stranger.
    const entityIds = new Set<string>();
    entityIds.add(run.world.identities.organizationId);
    entityIds.add(run.world.identities.projectId);
    for (const budgetRow of run.world.stores.cost.budgets) {
      entityIds.add(budgetRow.entityId);
      for (const itemId of Object.keys(budgetRow.costItems)) entityIds.add(itemId);
      for (const revisionId of Object.keys(budgetRow.revisions)) entityIds.add(revisionId);
    }
    for (const commitmentRow of run.world.stores.cost.commitments) {
      entityIds.add(commitmentRow.entityId);
      for (const lineSet of commitmentRow.lineSets) entityIds.add(lineSet.entityId);
    }
    for (const invoice of run.world.stores.cost.invoices) entityIds.add(invoice.entityId);
    for (const scheduleRow of run.world.stores.schedule.schedules) {
      entityIds.add(scheduleRow.entityId);
      for (const id of Object.keys(scheduleRow.activities)) entityIds.add(id);
      for (const id of Object.keys(scheduleRow.dependencies)) entityIds.add(id);
      for (const id of Object.keys(scheduleRow.baselines ?? {})) entityIds.add(id);
      for (const id of Object.keys(scheduleRow.milestones ?? {})) entityIds.add(id);
    }
    entityIds.add(run.approval.definitionId);
    entityIds.add(run.approval.instanceId);
    entityIds.add(run.constructionIngress.changeEvent.entityId);
    entityIds.add(run.constructionIngress.document.entityId);
    entityIds.add(run.modelIngress.element.entityId);
    entityIds.add(run.modelIngress.model.entityId);
    entityIds.add(run.modelIngress.modelVersion.entityId);
    for (const ref of run.modelIngress.affectedEntityRefs) entityIds.add(ref.entityId);
    const universe = new Set<string>([
      ...eventIds,
      ...commandIds,
      ...entityIds,
      ...run.observers.procurement.recommendations.map((r) => r.recommendationId),
    ]);
    for (const hop of walk.hops) {
      for (const id of hop.citedIds) {
        expect(universe.has(id), `hop ${hop.step} cites ${id}`).toBe(true);
      }
    }

    // (f) The observers hop cites the SAME four chain events every linked
    // projection agrees on: the model event, the cost event, the schedule
    // event, the execution event — plus the world's own cost aggregates.
    const observersHop = walk.hops.find((hop) => hop.step === 'observers');
    expect(observersHop).toBeDefined();
    if (observersHop !== undefined) {
      expect(observersHop.citedIds).toContain(run.modelIngress.event.eventId);
      expect(observersHop.citedIds).toContain(run.costImpact.command.eventId);
      expect(observersHop.citedIds).toContain(run.scheduleIngress.command.eventId);
      expect(observersHop.citedIds).toContain(run.execution.command.eventId);
      for (const budgetId of run.observers.procurement.inputBudgetIds) {
        expect(observersHop.citedIds).toContain(budgetId);
      }
      for (const commitmentId of run.observers.procurement.inputCommitmentIds) {
        expect(observersHop.citedIds).toContain(commitmentId);
      }
    }
    // The observer inputs ARE the world's records (not copies of them).
    for (const budgetId of run.observers.procurement.inputBudgetIds) {
      expect(run.world.stores.cost.budgets.some((row) => row.entityId === budgetId)).toBe(true);
    }
    for (const commitmentId of run.observers.procurement.inputCommitmentIds) {
      expect(run.world.stores.cost.commitments.some((row) => row.entityId === commitmentId)).toBe(true);
    }
  }, 60000);

  it('INVARIANT #1 (continued) — the evidence packet, the approval record, and the observers cite the SAME events', async () => {
    const run = await runPromise;
    const eventIds = new Set<string>(run.world.ledger.events.map((event) => event.eventId));

    // THE evidence packet's five references resolve to the chain's own
    // records: the three ledger events of the mutation/impact steps, plus the
    // construction ingress's change event and document entities.
    expect(run.evidence.references).toStrictEqual([
      run.modelIngress.event.eventId,
      run.costImpact.command.eventId,
      run.scheduleIngress.command.eventId,
      `change-event:${run.constructionIngress.changeEvent.entityId}`,
      `document:${run.constructionIngress.document.entityId}`,
    ]);
    // The packet's cited event ids resolve INTO the ledger (same events).
    expect(run.evidence.citedEventIds).toStrictEqual([
      run.modelIngress.event.eventId,
      run.costImpact.command.eventId,
      run.scheduleIngress.command.eventId,
    ]);
    for (const eventId of run.evidence.citedEventIds) {
      expect(eventIds.has(eventId), `evidence cites ${eventId}`).toBe(true);
      expect(run.world.ledger.eventOf(eventId)).not.toBeNull();
    }
    // The packet's cited entities are the world's own aggregates.
    expect(run.evidence.citedEntityIds).toStrictEqual([
      run.modelIngress.element.entityId,
      run.costImpact.budgetId,
      run.scheduleIngress.activityId,
    ]);

    // THE approval record cites the packet: the approval decision's note
    // embeds every evidence reference, verbatim and in order.
    expect(run.approval.note).toBe(`change-evidence:${run.evidence.references.join(',')}`);

    // THE procurement recommendations' evidence cites the world's records:
    // every cost-domain record reference resolves into the world's cost store,
    // every event reference resolves into the ledger, and the recommendation
    // set carries the agents-typed complete evidence set.
    const costRecordIds = new Set<string>();
    for (const budgetRow of run.world.stores.cost.budgets) {
      costRecordIds.add(budgetRow.entityId);
      for (const itemId of Object.keys(budgetRow.costItems)) costRecordIds.add(itemId);
    }
    for (const commitmentRow of run.world.stores.cost.commitments) {
      costRecordIds.add(commitmentRow.entityId);
    }
    for (const recommendation of run.observers.procurement.recommendations) {
      for (const record of recommendation.referencedRecords) {
        expect(costRecordIds.has(record.entityId), `recommendation record ${record.entityId}`).toBe(true);
      }
      const citedEventIds: string[] = [];
      for (const item of recommendation.evidence) {
        if (item.kind === 'record') {
          expect(costRecordIds.has(item.ref.entityId), `evidence record ${item.ref.entityId}`).toBe(true);
        } else if (item.kind === 'event') {
          expect(eventIds.has(item.eventId), `evidence event ${item.eventId}`).toBe(true);
          citedEventIds.push(item.eventId);
        } else if (item.kind === 'assessment') {
          // The assessment source anchors on the chain's own events/entities.
          expect(eventIds.has(item.sourceEventId)).toBe(true);
          expect(item.changeEventId).toBe(run.constructionIngress.changeEvent.entityId);
        }
      }
      // The SAME originating causal events the whole chain agrees on: the
      // model mutation event and the cost impact event are cited evidence.
      expect(citedEventIds).toContain(run.modelIngress.event.eventId);
      expect(citedEventIds).toContain(run.costImpact.command.eventId);
      // The primary producing event of every recommendation IS the chain's
      // originating event, carrying the chain's correlation id (A3/A4).
      expect(recommendation.primarySource.eventId).toBe(run.modelIngress.event.eventId);
      expect(recommendation.primarySource.correlationId).toBe(run.parts.correlationId);
      // The agents discipline: a complete, non-empty evidence set.
      expect(recommendation.evidenceSet.items.length).toBeGreaterThan(0);
      expect(recommendation.evidence.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('INVARIANT #2 — no duplicate canonical records (canonical aggregate counting)', async () => {
    const run = await runPromise;

    // Every canonical aggregate appears EXACTLY once.
    expect(run.world.stores.cost.budgets).toHaveLength(1);
    expect(run.world.stores.cost.commitments).toHaveLength(1);
    expect(run.world.stores.cost.invoices).toHaveLength(1);
    expect(run.world.stores.schedule.schedules).toHaveLength(1);

    // The commitment's append-only amendment line-set chain: creation + the
    // ONE executed amendment, dense sequences, distinct line-set ids.
    const commitment = run.world.stores.cost.commitments[0];
    expect(commitment).toBeDefined();
    if (commitment !== undefined) {
      expect(commitment.lineSets.map((lineSet) => lineSet.sequence)).toStrictEqual([1, 2]);
      const lineSetIds = commitment.lineSets.map((lineSet) => lineSet.entityId);
      expect(new Set(lineSetIds).size).toBe(lineSetIds.length);
      // The amendment's line set cites the change cost item (the typed link).
      const tip = commitment.lineSets[commitment.lineSets.length - 1];
      expect(tip).toBeDefined();
      if (tip !== undefined) {
        expect(tip.lines.some((line) => line.costItemId === run.costImpact.costItemId)).toBe(true);
      }
    }

    // Distinct cost item ids across the budget's working set and revisions.
    const costItemIds: string[] = [];
    for (const budgetRow of run.world.stores.cost.budgets) {
      costItemIds.push(...Object.keys(budgetRow.costItems));
      for (const revision of Object.values(budgetRow.revisions)) {
        costItemIds.push(...revision.costItems.map((item) => item.entityId));
      }
    }
    expect(new Set(costItemIds).size).toBe(costItemIds.length);
    expect(costItemIds.length).toBeGreaterThan(0);

    // Distinct schedule-element ids (activities, dependencies, baselines).
    const schedule = run.world.stores.schedule.schedules[0];
    expect(schedule).toBeDefined();
    if (schedule !== undefined) {
      const elementIds = [
        ...Object.keys(schedule.activities),
        ...Object.keys(schedule.dependencies),
        ...Object.keys(schedule.baselines ?? {}),
        ...Object.keys(schedule.milestones ?? {}),
      ];
      expect(new Set(elementIds).size).toBe(elementIds.length);
      expect(elementIds.length).toBeGreaterThan(0);
    }

    // THE ledger carries each event exactly once: a Set of the event ids has
    // the full length (no id ever repeats).
    const ledgerEventIds = run.world.ledger.events.map((event) => event.eventId);
    expect(new Set(ledgerEventIds).size).toBe(ledgerEventIds.length);
    expect(ledgerEventIds.length).toBe(run.world.ledger.count);

    // Per-aggregate ledger sequences are dense and strictly monotonic: no
    // aggregate's stream ever repeats a position (the ledger identity basis).
    const sequencesByAggregate = new Map<string, number[]>();
    for (const event of run.world.ledger.events) {
      const key = `${event.aggregate.entityKind}|${event.aggregate.entityId}`;
      const prior = sequencesByAggregate.get(key) ?? [];
      sequencesByAggregate.set(key, [...prior, event.sequence]);
    }
    for (const [key, sequences] of sequencesByAggregate) {
      expect(sequences, `aggregate ${key} dense sequence`).toStrictEqual(
        sequences.map((_, index) => index + 1),
      );
    }

    // The command journal carries each idempotency key exactly once, and every
    // executed entry's event id resolves into the ledger exactly once.
    const journalKeys = run.world.commandJournal.map((entry) => entry.idempotencyKey);
    expect(new Set(journalKeys).size).toBe(journalKeys.length);
    for (const entry of run.world.commandJournal) {
      if (entry.eventId === null) continue;
      expect(run.world.ledger.eventOf(entry.eventId), `journal event ${entry.eventId}`).not.toBeNull();
    }
    // Every journal entry is either executed-with-event or rejected-with-code
    // — the displayable outcome discipline.
    for (const entry of run.world.commandJournal) {
      if (entry.outcome === 'executed') {
        expect(entry.eventId).not.toBeNull();
        expect(entry.rejectionCode).toBeNull();
      } else {
        expect(entry.outcome).toBe('rejected');
        expect(entry.eventId).toBeNull();
        expect(entry.rejectionCode).toBeTruthy();
      }
    }
  }, 60000);

  it('INVARIANT #2 — replaying the SAME adapter notifications produces ZERO new canonical records', async () => {
    const run = await runPromise;
    const replay = await replayNotifications(run);

    // The replay really re-delivered the notifications (proposals were
    // observed) — and yet ZERO new canonical records landed.
    expect(replay.proposals.length).toBeGreaterThan(0);
    expect(replay.newCanonicalRecords).toBe(0);
    expect(replay.ledgerCountAfter).toBe(replay.ledgerCountBefore);
    expect(replay.journalCountAfter).toBe(replay.journalCountBefore);
    expect(replay.ledgerCountBefore).toBe(run.world.ledger.count);

    // Replaying AGAIN is still zero (repeated re-delivery stays idempotent).
    const replayTwo = await replayNotifications(run);
    expect(replayTwo.newCanonicalRecords).toBe(0);
    expect(replayTwo.ledgerCountAfter).toBe(replay.ledgerCountBefore);
    expect(replayTwo.journalCountAfter).toBe(replay.journalCountBefore);

    // And the ledger's no-duplicate discipline STILL holds after replay: each
    // event id exactly once, per-aggregate sequences still dense.
    const ledgerEventIds = run.world.ledger.events.map((event) => event.eventId);
    expect(new Set(ledgerEventIds).size).toBe(ledgerEventIds.length);
    expect(run.world.ledger.count).toBe(replay.ledgerCountBefore);
  }, 60000);

  it('INVARIANT #2 — run-twice over fresh equal parts is byte-identical', async () => {
    const first = await runReferenceScenario(parts());
    const second = await runReferenceScenario(parts());

    // The two runs' ledgers are byte-identical (the full event envelopes).
    const envelopesOf = (scenario: ScenarioRun): string =>
      JSON.stringify(scenario.world.ledger.events.map((event) => event.envelope));
    expect(envelopesOf(second)).toBe(envelopesOf(first));
    // ...and their event identities match one-for-one, in append order.
    expect(second.world.ledger.events.map((event) => event.eventId)).toStrictEqual(
      first.world.ledger.events.map((event) => event.eventId),
    );
    // The command journals are identical too (same commands, same outcomes).
    expect(JSON.stringify(second.world.commandJournal)).toBe(
      JSON.stringify(first.world.commandJournal),
    );

    // And BOTH equal the shared run of the suite — three executions of the
    // same parts, one byte-identical world + ledger.
    const shared = await runPromise;
    expect(envelopesOf(second)).toBe(envelopesOf(shared));
    expect(JSON.stringify(second.world.commandJournal)).toBe(
      JSON.stringify(shared.world.commandJournal),
    );
    // The canonical aggregate counts agree across the runs.
    expect(second.world.stores.cost.budgets.length).toBe(first.world.stores.cost.budgets.length);
    expect(second.world.stores.cost.commitments.length).toBe(first.world.stores.cost.commitments.length);
    expect(second.world.stores.schedule.schedules.length).toBe(first.world.stores.schedule.schedules.length);
    expect(second.world.ledger.count).toBe(first.world.ledger.count);
  }, 60000);

  it('surfaces typed, displayable rejections (stale versions never silently overwrite)', async () => {
    const run = await runPromise;
    const ledgerBefore = run.world.ledger.count;
    const journalBefore = run.world.commandJournal.length;
    const budget = run.world.stores.cost.budgets[0];
    expect(budget).toBeDefined();
    if (budget === undefined) return;

    // A WRONG expectedVersion submission through the world's own typed path:
    // {ok:false} with the DomainError code — never a throw, never an overwrite.
    const stale = await run.world.submit(run.world.session, {
      commandName: RECORD_COST_ITEM_COMMAND,
      payload: {
        budgetId: run.costImpact.budgetId,
        expectedVersion: budget.version + 1000,
        code: 'golden-stale-probe-01',
        description: 'A stale-version probe that must never land',
        unit: 'm2',
        quantityMilli: 1000,
        unitRateMinor: 100,
      },
      scope: run.world.scope,
      idempotencyKey: 'golden-stale-probe-1',
    });
    const rejection = rejectionOf(stale);
    expect(rejection.code).toBe('concurrency-conflict');
    expect(rejection.details[0]?.code).toBe('stale-aggregate-version');

    // ZERO ledger effects: the stale submission appended nothing.
    expect(run.world.ledger.count).toBe(ledgerBefore);

    // The rejection is DISPLAYABLE: the command journal records it as a
    // rejected entry carrying the typed rejection code and NO event id.
    const journalAfter = run.world.commandJournal;
    expect(journalAfter.length).toBe(journalBefore + 1);
    const entry = journalAfter[journalAfter.length - 1];
    expect(entry).toBeDefined();
    if (entry !== undefined) {
      expect(entry.outcome).toBe('rejected');
      expect(entry.rejectionCode).toBe('concurrency-conflict');
      expect(entry.eventId).toBeNull();
      expect(entry.commandName).toBe('cost.recordCostItem');
    }
    // The budget's state is untouched (the recorded state stands).
    const budgetAfter = run.world.stores.cost.budgets[0];
    expect(budgetAfter?.version).toBe(budget.version);
    expect(Object.keys(budgetAfter?.costItems ?? {})).toStrictEqual(
      Object.keys(budget.costItems),
    );
  }, 60000);
});
