import { describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import {
  BUDGET_ID,
  CHANGE_EVENT_ID,
  COMMITMENT_1,
  buildCostScenario,
  buildEntitlementScenario,
  buildMarginScenario,
  buildScheduleScenario,
} from './scenarios';
import { projectCommercialFacts } from './facts';
import {
  T0,
  appendCommandEvent,
  newEventSource,
  projectOneScope,
  testCommand,
  testCorrelationId,
  testId,
  testKey,
  unwrap,
} from './test-support';

// OFF-014 commercial facts fold — the margin engine's projection (A2/A7):
// deterministic, rebuildable, fail-closed. The fold consumes ledger order;
// per-entity latest-assertion-wins is deterministic; unknown event names
// are skipped and tallied (never a crash, never invented data); a
// RECOGNIZED name with a malformed payload fails closed; and the
// before-submission ordering invariants of the recorded streams fail
// closed as typed invariant violations.

const contractAggregate = (contractId: EntityRef['entityId']): EntityRef => ({
  entityKind: 'contract' as EntityRef['entityKind'],
  entityId: contractId,
});
const budgetAggregate: EntityRef = {
  entityKind: 'budget' as EntityRef['entityKind'],
  entityId: BUDGET_ID,
};
const CONTRACT_ID = testId('con', 1);
const COMMITMENT_AGGREGATE: EntityRef = {
  entityKind: 'commitment' as EntityRef['entityKind'],
  entityId: COMMITMENT_1,
};

const commandOf = (key: number, commandName: string) =>
  testCommand({
    commandName,
    scope: projectOneScope(),
    idempotencyKey: testKey(key),
    correlationId: testCorrelationId(key),
    issuedAt: T0,
  });

describe('commercial facts fold (OFF-014)', () => {
  it('latest commitment assertion wins deterministically with its producing event', async () => {
    const source = newEventSource();
    const events = await buildMarginScenario(source);
    const facts = unwrap(projectCommercialFacts(unwrap(await source.readEvents())));

    // CM1 was created at 6,000,000 then amended to 7,500,000: the CURRENT
    // committed amount is the amendment's, and the fact's source is the
    // amendment event — not the creation.
    expect(facts.commitments).toHaveLength(2);
    const cm1 = facts.commitments.find((fact) => fact.commitmentId === COMMITMENT_1);
    expect(cm1?.committedAmountMinor).toBe(7500000);
    expect(cm1?.source.eventId).toBe(events.commitment1Amended?.eventId);
    expect(cm1?.source.eventName).toBe('cost.commitmentAmended');
    expect(facts.commitmentsOf(BUDGET_ID)).toHaveLength(2);
  });

  it('keeps ordered duration histories and latest progress per activity', async () => {
    const source = newEventSource();
    await buildScheduleScenario(source);
    const facts = unwrap(projectCommercialFacts(unwrap(await source.readEvents())));

    expect(facts.activities).toHaveLength(3);
    const a2 = facts.activities.find((fact) => fact.code === 'A2');
    // A2 was added at duration 4 then updated to 7: the history preserves
    // ledger order and the latest progress of A3 is its 50% record.
    expect(a2?.durationAssertions.map((assertion) => assertion.plannedDuration)).toStrictEqual([4, 7]);
    expect(a2?.durationAssertions[0]?.source.eventName).toBe('schedule.activityAdded');
    expect(a2?.durationAssertions[1]?.source.eventName).toBe('schedule.activityUpdated');
    const a3 = facts.activities.find((fact) => fact.code === 'A3');
    expect(a3?.latestProgress?.percentComplete).toBe(50);
    expect(a3?.latestProgress?.remainingDuration).toBe(2);
    expect(facts.derivation.activityCount).toBe(3);
    expect(facts.derivation.dependencyCount).toBe(2);
    expect(facts.derivation.baselineCount).toBe(1);
  });

  it('skips unknown event names deterministically without inventing data', async () => {
    const source = newEventSource();
    await buildMarginScenario(source);
    const facts = unwrap(projectCommercialFacts(unwrap(await source.readEvents())));

    // The invoice event (recognized by NO fold rule) contributed only its
    // skip tally — no invoice entity appears anywhere in the facts.
    expect(facts.derivation.projectedEventCount).toBe(12);
    expect(facts.derivation.skippedEventNames).toStrictEqual([
      { eventName: 'cost.invoiceRecorded', count: 1 },
    ]);
    expect(JSON.stringify(facts)).not.toContain('invoiceRecorded\u0000');
    expect(facts.commitments).toHaveLength(2);
    expect(facts.costItems).toHaveLength(2);
  });

  it('skips documents events the commercial fold does not consume', async () => {
    const source = newEventSource();
    await buildEntitlementScenario(source);
    const stream = unwrap(await source.readEvents());
    const changeEventRaised = stream.find(
      (event) => event.envelope.eventName === 'contracts.changeEventRaised',
    );
    if (changeEventRaised === undefined) throw new Error('entitlement stream has no change event');
    const facts = unwrap(projectCommercialFacts(stream));

    expect(facts.derivation.skippedEventNames).toStrictEqual([
      { eventName: 'documents.documentRegistered', count: 1 },
      { eventName: 'documents.revisionAttached', count: 1 },
    ]);
    // The evidence link still rides on the change event fact itself.
    const changeEvent = facts.changeEventByLedgerId(changeEventRaised.eventId);
    expect(changeEvent?.changeEventId).toBe(CHANGE_EVENT_ID);
    expect(changeEvent?.evidenceLinks).toHaveLength(1);
  });

  it('fails closed on a recognized event name with a malformed payload', async () => {
    const source = newEventSource();
    await appendCommandEvent(source, {
      command: commandOf(1, 'cost.recordCostItem'),
      eventName: 'cost.costItemRecorded',
      scope: projectOneScope(),
      occurredAt: T0,
      aggregate: budgetAggregate,
      payload: {
        budgetId: BUDGET_ID,
        costItemId: testId('cst', 1),
        amountMinor: 'lots of money', // malformed: not an integer
      },
    });

    const result = projectCommercialFacts(unwrap(await source.readEvents()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('commercial-payload-valid');
      expect(result.error.details[0]?.path).toBe('cost.costItemRecorded.amountMinor');
    }
  });

  it('fails closed when a decision arrives before its change order submission', async () => {
    const source = newEventSource();
    await appendCommandEvent(source, {
      command: commandOf(1, 'contracts.approveChangeOrder'),
      eventName: 'contracts.changeOrderApproved',
      scope: projectOneScope(),
      occurredAt: T0,
      aggregate: contractAggregate(CONTRACT_ID),
      payload: {
        contractId: CONTRACT_ID,
        changeOrderId: testId('ord', 1),
        status: 'approved',
        decidedAt: T0,
        version: 1,
      },
    });

    const result = projectCommercialFacts(unwrap(await source.readEvents()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('change-order-submitted-before-decision');
    }
  });

  it('fails closed when a contract is created twice', async () => {
    const source = newEventSource();
    const payload = {
      contractId: CONTRACT_ID,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: 1000000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T0,
    };
    await appendCommandEvent(source, {
      command: commandOf(1, 'contracts.createContract'),
      eventName: 'contracts.contractCreated',
      scope: projectOneScope(),
      occurredAt: T0,
      aggregate: contractAggregate(CONTRACT_ID),
      payload,
    });
    await appendCommandEvent(source, {
      command: commandOf(2, 'contracts.createContract'),
      eventName: 'contracts.contractCreated',
      scope: projectOneScope(),
      occurredAt: T0,
      aggregate: contractAggregate(CONTRACT_ID),
      payload,
    });

    const result = projectCommercialFacts(unwrap(await source.readEvents()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('contract-created-once');
    }
  });

  it('fails closed when a commitment amendment arrives before its creation', async () => {
    const source = newEventSource();
    await appendCommandEvent(source, {
      command: commandOf(1, 'cost.amendCommitment'),
      eventName: 'cost.commitmentAmended',
      scope: projectOneScope(),
      occurredAt: T0,
      aggregate: COMMITMENT_AGGREGATE,
      payload: {
        commitmentId: COMMITMENT_1,
        amendmentId: testId('amd', 1),
        sequence: 1,
        reason: 'orphaned amendment',
        lineCount: 1,
        committedAmountMinor: 1000,
        version: 2,
        amendedAt: T0,
      },
    });

    const result = projectCommercialFacts(unwrap(await source.readEvents()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('commitment-created-before-amendment');
    }
  });

  it('derives the fold audit trail (counts + recognized tallies)', async () => {
    const source = newEventSource();
    await buildCostScenario(source);
    const facts = unwrap(projectCommercialFacts(unwrap(await source.readEvents())));

    expect(facts.derivation.projectedEventCount).toBe(9);
    expect(facts.derivation.contractCount).toBe(1);
    expect(facts.derivation.changeEventCount).toBe(1);
    expect(facts.derivation.changeOrderCount).toBe(1);
    expect(facts.derivation.budgetCount).toBe(1);
    expect(facts.derivation.costItemCount).toBe(2);
    expect(facts.derivation.budgetRevisionCount).toBe(1);
    expect(facts.derivation.commitmentCount).toBe(1);
    expect(facts.derivation.skippedEventNames).toStrictEqual([]);
    expect(facts.derivation.recognizedEventNames).toHaveLength(8);
  });
});
