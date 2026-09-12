import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseEntityKind,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, Scope, Timestamp } from '@office/contracts';
import type { SqlExecutor } from '@office/persistence';
import {
  CHANGE_EVENT_KIND,
  CHANGE_EVENT_LINKED_EVENT,
  CHANGE_EVENT_RAISED_EVENT,
  CHANGE_ORDER_APPROVED_EVENT,
  CHANGE_ORDER_EXECUTED_EVENT,
  CHANGE_ORDER_REJECTED_EVENT,
  CHANGE_ORDER_SUBMITTED_EVENT,
  CLAIM_REFERENCE_KIND,
  CLAIM_REFERENCED_EVENT,
  CONTRACT_ARCHIVED_EVENT,
  CONTRACT_CREATED_EVENT,
  CONTRACT_KIND,
  CONTRACT_UPDATED_EVENT,
  OBLIGATION_RECORDED_EVENT,
  SCOPE_OBLIGATION_KIND,
  approveChangeOrderState,
  archiveContractState,
  changeEventRef,
  changeOrderRef,
  claimReferenceRef,
  contractRef,
  contractsEventEnvelope,
  createChangeEventState,
  createChangeOrderState,
  createClaimReferenceState,
  createContractState,
  eventSinkFailure,
  executeChangeOrderState,
  failingEventSink,
  obligationRef,
  recordObligationState,
  supersedeChangeEventState,
  updateContractState,
} from './index';
import { createInMemoryEventSink } from './index';
import type { EventSink } from './index';
import type {
  ChangeEventState,
  ChangeOrderState,
  ClaimReferenceState,
  ContractState,
  ScopeObligationState,
} from './index';
import { rejectChangeOrderState } from './index';
import { parseMoney, parseQuantityValue } from './parse';

const money = (amount: number, currency: string) =>
  unwrap(parseMoney({ amount, currency }));

// OFF-012 contracts/change domain — audit events + the EventSink port. Unit
// tests: the event vocabulary parses, the envelope builder propagates
// actor/scope/source/causality from the command envelope and carries
// before/after entity refs per the transition kind, and the in-memory sink
// records appends for deterministic assertions. No I/O, fixed everything.

const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const id = (prefix: string, n: number) =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

const CONTRACT_ID = id('con', 1);
const OBLIGATION_ID = id('obl', 1);
const CHANGE_EVENT_ID = id('chg', 1);
const CHANGE_ORDER_ID = id('ord', 1);
const CLAIM_REFERENCE_ID = id('clr', 1);
const PERSON_ID = id('per', 1);
const COMPANY_ID = id('cmp', 1);
const DOCUMENT_ID = id('doc', 1);
const REVISION_ID = id('rev', 1);
const CLAIM_ID = id('clm', 1);

const SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };

const command: CommandEnvelope<unknown> = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'contracts.raiseChangeEvent',
    scope: { kind: 'tenant', tenantId: TENANT_A },
    actor: { kind: 'user', actorId: ACTOR_ID },
    idempotencyKey: 'idem-4f9d2c81a7e3',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: {},
  }),
);

const contract = (): ContractState =>
  unwrap(
    createContractState(
      {
        contractId: CONTRACT_ID,
        title: 'Riverside design-build contract',
        owner: { entityKind: 'person', entityId: PERSON_ID },
        contractor: { entityKind: 'company', entityId: COMPANY_ID },
        contractValue: money(12_500_000, 'USD'),
        now: NOW,
      },
      SCOPE,
    ),
  );

const obligationOf = (state: ContractState): ScopeObligationState => {
  const recorded = unwrap(
    recordObligationState(state, {
      obligationId: OBLIGATION_ID,
      code: 'EARTHWORKS',
      description: 'Excavation and grading of the north platform',
      quantity: unwrap(parseQuantityValue('1250.5')),
      unit: 'm3',
      now: NOW,
    }),
  );
  const obligation = recorded.obligations[OBLIGATION_ID];
  if (obligation === undefined) throw new Error('obligation missing');
  return obligation;
};

const changeEvent = (): ChangeEventState =>
  unwrap(
    createChangeEventState(
      {
        changeEventId: CHANGE_EVENT_ID,
        title: 'North platform additional excavation',
        changeType: 'modification',
        links: {
          affectedObligationIds: [OBLIGATION_ID],
          evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
          costImpactLinks: [{ budgetId: null, costItemId: id('cst', 1) }],
          scheduleImpactActivityIds: [id('act', 1)],
        },
        now: NOW,
      },
      SCOPE,
      CONTRACT_ID,
    ),
  );

const changeOrder = (): ChangeOrderState =>
  unwrap(
    createChangeOrderState(
      {
        changeOrderId: CHANGE_ORDER_ID,
        title: 'CO 01 — north platform additional excavation',
        changeValue: money(250_000, 'USD'),
        now: NOW,
      },
      SCOPE,
      CONTRACT_ID,
      CHANGE_EVENT_ID,
    ),
  );

const CLAIM_KIND = unwrap(parseEntityKind('claim'));

const claimReference = (): ClaimReferenceState =>
  unwrap(
    createClaimReferenceState(
      {
        claimReferenceId: CLAIM_REFERENCE_ID,
        claimEntityKind: CLAIM_KIND,
        claimEntityId: CLAIM_ID,
        changeOrderId: CHANGE_ORDER_ID,
        documentId: DOCUMENT_ID,
        revisionId: REVISION_ID,
        now: NOW,
      },
      SCOPE,
      CONTRACT_ID,
    ),
  );

describe('the contracts-domain event vocabulary', () => {
  it('defines the eleven lifecycle event names under the contracts area', () => {
    for (const name of [
      CONTRACT_CREATED_EVENT,
      CONTRACT_UPDATED_EVENT,
      CONTRACT_ARCHIVED_EVENT,
      OBLIGATION_RECORDED_EVENT,
      CHANGE_EVENT_RAISED_EVENT,
      CHANGE_EVENT_LINKED_EVENT,
      CHANGE_ORDER_SUBMITTED_EVENT,
      CHANGE_ORDER_APPROVED_EVENT,
      CHANGE_ORDER_REJECTED_EVENT,
      CHANGE_ORDER_EXECUTED_EVENT,
      CLAIM_REFERENCED_EVENT,
    ]) {
      expect(name.startsWith('contracts.')).toBe(true);
    }
  });
});

describe('contractsEventEnvelope (A3 propagation)', () => {
  it('carries scope, actor, source domain, causality from the command, schema version, occurredAt, and before/after refs', () => {
    const created = contract();
    const envelope = contractsEventEnvelope({
      command,
      eventName: CONTRACT_CREATED_EVENT,
      scope: created.scope,
      occurredAt: NOW,
      entityRefs: { before: null, after: contractRef(created) },
      payload: {
        contractId: created.entityId,
        title: created.title,
        version: created.version,
        contractValue: created.contractValue,
        executionStatus: created.executionStatus,
        createdAt: created.createdAt,
      },
    });
    expect(envelope.eventName).toBe('contracts.contractCreated');
    expect(envelope.scope).toStrictEqual(created.scope);
    expect(envelope.actor).toStrictEqual(command.actor);
    expect(envelope.source).toBe('domain');
    // The causation id of the event IS the command's idempotency key.
    expect(envelope.causality.correlationId).toBe(command.causality.correlationId);
    expect(envelope.causality.causationId).toBe(command.idempotencyKey);
    expect(envelope.occurredAt).toBe(NOW);
    expect(envelope.entityRefs.before).toBeNull();
    expect(envelope.entityRefs.after).toStrictEqual({
      entityKind: CONTRACT_KIND,
      entityId: CONTRACT_ID,
    });
    // Every envelope self-checks through the contracts parser (the builder
    // throws otherwise), so the payload is a plain JSON object here.
    expect(envelope.payload).toStrictEqual({
      contractId: CONTRACT_ID,
      title: 'Riverside design-build contract',
      version: 1,
      contractValue: { amount: 12_500_000, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: NOW,
    });
  });

  it('update/archived envelopes carry before AND after refs of the same entity', () => {
    const base = contract();
    const updated = unwrap(updateContractState(base, { title: 'Amended' }, NOW));
    const updatedEnvelope = contractsEventEnvelope({
      command,
      eventName: CONTRACT_UPDATED_EVENT,
      scope: updated.scope,
      occurredAt: NOW,
      entityRefs: {
        before: contractRef(base),
        after: contractRef(updated),
      },
      payload: {
        contractId: updated.entityId,
        title: updated.title,
        executionStatus: updated.executionStatus,
        version: updated.version,
        updatedAt: updated.updatedAt,
      },
    });
    expect(updatedEnvelope.entityRefs.before?.entityId).toBe(CONTRACT_ID);
    expect(updatedEnvelope.entityRefs.after?.entityId).toBe(CONTRACT_ID);

    const archived = unwrap(archiveContractState(updated, NOW));
    const archivedEnvelope = contractsEventEnvelope({
      command,
      eventName: CONTRACT_ARCHIVED_EVENT,
      scope: archived.scope,
      occurredAt: NOW,
      entityRefs: { before: contractRef(updated), after: contractRef(archived) },
      payload: {
        contractId: archived.entityId,
        lifecycleStatus: archived.lifecycleStatus,
        archivedAt: archived.archivedAt ?? NOW,
        version: archived.version,
        updatedAt: archived.updatedAt,
      },
    });
    expect(archivedEnvelope.payload).toMatchObject({ lifecycleStatus: 'archived' });
  });

  it('the obligation-recorded envelope carries the recorded row ref and quantity/unit payload', () => {
    const obligation = obligationOf(contract());
    const envelope = contractsEventEnvelope({
      command,
      eventName: OBLIGATION_RECORDED_EVENT,
      scope: obligation.scope,
      occurredAt: NOW,
      entityRefs: { before: null, after: obligationRef(obligation) },
      payload: {
        contractId: CONTRACT_ID,
        obligationId: obligation.entityId,
        code: obligation.code,
        quantity: obligation.quantity,
        unit: obligation.unit,
        version: 2,
      },
    });
    expect(envelope.entityRefs.after).toStrictEqual({
      entityKind: SCOPE_OBLIGATION_KIND,
      entityId: OBLIGATION_ID,
    });
    expect(envelope.payload).toMatchObject({ code: 'EARTHWORKS', quantity: '1250.5', unit: 'm3' });
  });

  it('the change-event-raised envelope carries the full typed link set (ids/refs only)', () => {
    const raised = changeEvent();
    const envelope = contractsEventEnvelope({
      command,
      eventName: CHANGE_EVENT_RAISED_EVENT,
      scope: raised.scope,
      occurredAt: NOW,
      entityRefs: { before: null, after: changeEventRef(raised) },
      payload: {
        contractId: raised.contractId,
        changeEventId: raised.entityId,
        title: raised.title,
        changeType: raised.changeType,
        status: raised.status,
        affectedObligationIds: raised.affectedObligationIds,
        evidenceLinks: raised.evidenceLinks,
        costImpactLinks: raised.costImpactLinks,
        scheduleImpactActivityIds: raised.scheduleImpactActivityIds,
        version: raised.version,
      },
    });
    expect(envelope.entityRefs.after).toStrictEqual({
      entityKind: CHANGE_EVENT_KIND,
      entityId: CHANGE_EVENT_ID,
    });
    const payload = envelope.payload as {
      affectedObligationIds: readonly string[];
      evidenceLinks: readonly { documentId: string; revisionId: string }[];
    };
    expect(payload.affectedObligationIds).toStrictEqual([OBLIGATION_ID]);
    expect(payload.evidenceLinks).toStrictEqual([
      { documentId: DOCUMENT_ID, revisionId: REVISION_ID },
    ]);
  });

  it('the change-order lifecycle envelopes carry before/after refs and status payloads', () => {
    const order = changeOrder();
    const approved = unwrap(approveChangeOrderState(order, 'verified', NOW));
    const approvedEnvelope = contractsEventEnvelope({
      command,
      eventName: CHANGE_ORDER_APPROVED_EVENT,
      scope: approved.scope,
      occurredAt: NOW,
      entityRefs: { before: changeOrderRef(order), after: changeOrderRef(approved) },
      payload: {
        contractId: approved.contractId,
        changeOrderId: approved.entityId,
        status: approved.status,
        decidedAt: approved.decidedAt ?? NOW,
        version: approved.version,
      },
    });
    expect(approvedEnvelope.payload).toMatchObject({ status: 'approved' });

    const rejected = unwrap(rejectChangeOrderState(order, 'priced above entitlement', NOW));
    const rejectedEnvelope = contractsEventEnvelope({
      command,
      eventName: CHANGE_ORDER_REJECTED_EVENT,
      scope: rejected.scope,
      occurredAt: NOW,
      entityRefs: { before: changeOrderRef(order), after: changeOrderRef(rejected) },
      payload: {
        contractId: rejected.contractId,
        changeOrderId: rejected.entityId,
        status: rejected.status,
        decidedAt: rejected.decidedAt ?? NOW,
        version: rejected.version,
      },
    });
    expect(rejectedEnvelope.payload).toMatchObject({ status: 'rejected' });
  });

  it('the executed envelope records the supersession of the originating change event', () => {
    const order = changeOrder();
    const approved = unwrap(approveChangeOrderState(order, null, NOW));
    const executed = unwrap(executeChangeOrderState(approved, NOW));
    const event = changeEvent();
    const superseded = unwrap(supersedeChangeEventState(event, executed.entityId, NOW));
    const envelope = contractsEventEnvelope({
      command,
      eventName: CHANGE_ORDER_EXECUTED_EVENT,
      scope: executed.scope,
      occurredAt: NOW,
      entityRefs: { before: changeOrderRef(approved), after: changeOrderRef(executed) },
      payload: {
        contractId: executed.contractId,
        changeOrderId: executed.entityId,
        changeEventId: superseded.entityId,
        status: executed.status,
        changeEventStatus: superseded.status,
        changeEventVersion: superseded.version,
        executedAt: executed.executedAt ?? NOW,
        version: executed.version,
      },
    });
    expect(envelope.payload).toMatchObject({
      status: 'executed',
      changeEventStatus: 'superseded',
      changeEventId: CHANGE_EVENT_ID,
    });
  });

  it('the claim-referenced envelope carries the claim link and its evidence pins', () => {
    const reference = claimReference();
    const envelope = contractsEventEnvelope({
      command,
      eventName: CLAIM_REFERENCED_EVENT,
      scope: reference.scope,
      occurredAt: NOW,
      entityRefs: { before: null, after: claimReferenceRef(reference) },
      payload: {
        contractId: reference.contractId,
        claimReferenceId: reference.entityId,
        claimEntityKind: reference.claimEntityKind,
        claimEntityId: reference.claimEntityId,
        changeOrderId: reference.changeOrderId,
        documentId: reference.documentId,
        revisionId: reference.revisionId,
      },
    });
    expect(envelope.entityRefs.after).toStrictEqual({
      entityKind: CLAIM_REFERENCE_KIND,
      entityId: CLAIM_REFERENCE_ID,
    });
    expect(envelope.payload).toMatchObject({ claimEntityId: CLAIM_ID });
  });
});

describe('the EventSink port implementations', () => {
  it('the in-memory sink records appends (executor + events) in order', async () => {
    const sink = createInMemoryEventSink();
    const executor = fakeExecutor();
    const raised = changeEvent();
    const envelope = contractsEventEnvelope({
      command,
      eventName: CHANGE_EVENT_RAISED_EVENT,
      scope: raised.scope,
      occurredAt: NOW,
      entityRefs: { before: null, after: changeEventRef(raised) },
      payload: {
        contractId: raised.contractId,
        changeEventId: raised.entityId,
        title: raised.title,
        changeType: raised.changeType,
        status: raised.status,
        affectedObligationIds: raised.affectedObligationIds,
        evidenceLinks: raised.evidenceLinks,
        costImpactLinks: raised.costImpactLinks,
        scheduleImpactActivityIds: raised.scheduleImpactActivityIds,
        version: raised.version,
      },
    });
    const first = await sink.appendEvents(executor, [envelope]);
    expect(first.ok).toBe(true);
    const second = await sink.appendEvents(executor, [envelope]);
    expect(second.ok).toBe(true);
    expect(sink.appends).toHaveLength(2);
    expect(sink.appends[0]?.executor).toBe(executor);
    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]?.eventName).toBe('contracts.changeEventRaised');
  });

  it('the failing sink returns the typed sink failure (the mutation aborts)', async () => {
    const sink: EventSink = failingEventSink('the ledger rejected the append');
    const result = await sink.appendEvents(fakeExecutor(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.message).toContain('event sink rejected the append');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    const failure = eventSinkFailure('reason');
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.message).toBe('reason');
  });
});

/** Minimal SqlExecutor fake: the in-memory sink only records the reference. */
const fakeExecutor = (): SqlExecutor => ({
  query: async () => {
    throw new TypeError('no SQL in the events unit tests');
  },
});
