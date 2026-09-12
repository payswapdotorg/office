import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, EventName, Timestamp } from '@office/contracts';
import type { SqlExecutor } from '@office/persistence';
import {
  BUDGET_CREATED_EVENT,
  BUDGET_REVISED_EVENT,
  COMMITMENT_AMENDED_EVENT,
  COMMITMENT_CLOSED_EVENT,
  COMMITMENT_CREATED_EVENT,
  COST_ITEM_RECORDED_EVENT,
  INVOICE_RECORDED_EVENT,
  PAYMENT_REFERENCED_EVENT,
  budgetRef,
  commitmentRef,
  costEventEnvelope,
  costItemRef,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  invoiceRef,
  paymentReferenceRef,
} from './events';
import type { EventSink } from './events';
import { BUDGET_KIND, COST_ITEM_KIND, INVOICE_KIND, PAYMENT_REFERENCE_KIND, parseCurrencyCode } from './state';
import {
  createBudgetState,
  createCommitmentState,
  createInvoiceState,
  recordCostItemState,
  referencePaymentState,
} from './state';
import type { BudgetState, InvoiceState } from './state';

// OFF-011 cost domain — audit events + the EventSink port. Unit tests: the
// commercial event vocabulary parses, the envelope builder propagates actor/
// scope/source/causality from the command envelope and carries before/after
// entity refs, and the in-memory sink records appends for deterministic
// assertions. No I/O, fixed everything.

const unwrap = <T, E>(
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

const BUDGET_ID = id('bud', 1);
const COST_ITEM_ID = id('cit', 1);
const INVOICE_ID = id('inv', 1);
const PAYMENT_ID = id('pay', 1);
const USD = unwrap(parseCurrencyCode('USD'));

const SCOPE = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID } as const;

const command: CommandEnvelope<unknown> = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'cost.recordCostItem',
    scope: { kind: 'tenant', tenantId: TENANT_A },
    actor: { kind: 'user', actorId: ACTOR_ID },
    idempotencyKey: 'idem-4f9d2c81a7e3',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: {},
  }),
);

describe('cost event vocabulary', () => {
  it('declares the eight commercial audit event names', () => {
    expect(BUDGET_CREATED_EVENT).toBe('cost.budgetCreated');
    expect(COST_ITEM_RECORDED_EVENT).toBe('cost.costItemRecorded');
    expect(BUDGET_REVISED_EVENT).toBe('cost.budgetRevised');
    expect(COMMITMENT_CREATED_EVENT).toBe('cost.commitmentCreated');
    expect(COMMITMENT_AMENDED_EVENT).toBe('cost.commitmentAmended');
    expect(COMMITMENT_CLOSED_EVENT).toBe('cost.commitmentClosed');
    expect(INVOICE_RECORDED_EVENT).toBe('cost.invoiceRecorded');
    expect(PAYMENT_REFERENCED_EVENT).toBe('cost.paymentReferenced');
  });
});

describe('cost event envelope construction (A3)', () => {
  it('propagates actor, causality and the aggregate scope from the command', () => {
    const event = costEventEnvelope({
      command,
      eventName: COST_ITEM_RECORDED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: {
        before: null,
        after: { entityKind: COST_ITEM_KIND, entityId: COST_ITEM_ID },
      },
      payload: {
        budgetId: BUDGET_ID,
        costItemId: COST_ITEM_ID,
        code: 'CONC',
        description: 'Concrete works',
        unit: 'lot',
        quantityMilli: 1000,
        unitRateMinor: 250000,
        amountMinor: 250000,
        version: 2,
      },
    });
    expect(event.kind).toBe('event');
    expect(event.eventName).toBe('cost.costItemRecorded');
    // The audit event carries the aggregate's OWN project scope.
    expect(event.scope).toStrictEqual(SCOPE);
    expect(event.actor).toStrictEqual({ kind: 'user', actorId: ACTOR_ID });
    expect(event.source).toBe('domain');
    // The correlation id carries over from the command's causal chain; the
    // causation id of the event is the COMMAND's idempotency key (the
    // ledger convention).
    expect(event.causality).toStrictEqual({
      correlationId: 'corr-0f1e2d3c4b5a',
      causationId: 'idem-4f9d2c81a7e3',
    });
    expect(event.schemaVersion).toBe('1.0.0');
    expect(event.occurredAt).toBe(NOW);
    expect(event.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: COST_ITEM_KIND, entityId: COST_ITEM_ID },
    });
    expect(event.payload).toStrictEqual({
      budgetId: BUDGET_ID,
      costItemId: COST_ITEM_ID,
      code: 'CONC',
      description: 'Concrete works',
      unit: 'lot',
      quantityMilli: 1000,
      unitRateMinor: 250000,
      amountMinor: 250000,
      version: 2,
    });
  });

  it('carries before/after entity refs for close-kind events', () => {
    const ref = budgetRef(
      unwrap(
        createBudgetState(
          { budgetId: BUDGET_ID, name: 'Riverside budget', currency: USD, now: NOW },
          SCOPE,
        ),
      ),
    );
    const event = costEventEnvelope({
      command,
      eventName: BUDGET_REVISED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: { before: ref, after: ref },
      payload: {
        budgetId: BUDGET_ID,
        revisionId: id('brv', 1),
        sequence: 1,
        label: 'Revision 1',
        supersedes: null,
        costItemCount: 1,
        version: 2,
        createdAt: NOW,
      },
    });
    expect(event.entityRefs).toStrictEqual({ before: ref, after: ref });
  });

  it('fails loudly on an invalid event-name literal (trusted path)', () => {
    expect(() =>
      costEventEnvelope({
        command,
        // A hand-broken name cannot pass the contracts parser — the builder
        // self-checks every envelope it emits.
        eventName: 'not.a-valid event name' as unknown as EventName,
        scope: SCOPE,
        occurredAt: NOW,
        entityRefs: { before: null, after: { entityKind: BUDGET_KIND, entityId: BUDGET_ID } },
        payload: {
          budgetId: BUDGET_ID,
          name: 'Riverside budget',
          currency: 'USD',
          version: 1,
          createdAt: NOW,
        },
      }),
    ).toThrow(TypeError);
  });
});

const failMissing = (): never => {
  throw new Error('entity missing');
};

describe('entity ref builders', () => {
  it('builds canonical refs for the commercial entity models', () => {
    const budget: BudgetState = unwrap(
      createBudgetState(
        { budgetId: BUDGET_ID, name: 'Riverside budget', currency: USD, now: NOW },
        SCOPE,
      ),
    );
    const withItem = unwrap(
      recordCostItemState(budget, {
        costItemId: COST_ITEM_ID,
        code: 'CONC',
        description: 'Concrete works',
        unit: 'lot',
        quantityMilli: 1000,
        unitRateMinor: 250000,
        now: NOW,
      }),
    );
    expect(budgetRef(budget)).toStrictEqual({
      entityKind: BUDGET_KIND,
      entityId: BUDGET_ID,
    });
    expect(costItemRef(withItem.costItems[COST_ITEM_ID] ?? failMissing())).toStrictEqual({
      entityKind: COST_ITEM_KIND,
      entityId: COST_ITEM_ID,
    });

    const commitment = unwrap(
      createCommitmentState(
        {
          commitmentId: id('cmt', 1),
          number: 'PO-0001',
          commitmentKind: 'purchase-order',
          description: 'Foundations package',
          currency: USD,
          lines: [
            {
              lineId: id('cml', 1),
              costItemId: COST_ITEM_ID,
              description: 'Concrete',
              amountMinor: 1000,
            },
          ],
          now: NOW,
          createdBy: null,
        },
        SCOPE,
      ),
    );
    expect(commitmentRef(commitment)).toStrictEqual({
      entityKind: 'commitment',
      entityId: id('cmt', 1),
    });

    const invoice: InvoiceState = unwrap(
      createInvoiceState(
        {
          invoiceId: INVOICE_ID,
          commitmentId: id('cmt', 1),
          number: 'INV-0001',
          description: 'Billing',
          currency: USD,
          lines: [{ lineId: id('inl', 1), description: 'Line', amountMinor: 1000 }],
          issuedOn: null,
          dueOn: null,
          now: NOW,
        },
        SCOPE,
      ),
    );
    expect(invoiceRef(invoice)).toStrictEqual({
      entityKind: INVOICE_KIND,
      entityId: INVOICE_ID,
    });
    const withPayment = unwrap(
      referencePaymentState(invoice, {
        paymentReferenceId: PAYMENT_ID,
        reference: 'CHK-1001',
        amountMinor: 1000,
        paidAt: NOW,
        now: NOW,
      }),
    );
    expect(paymentReferenceRef(withPayment.paymentReferences[0] ?? failMissing())).toStrictEqual({
      entityKind: PAYMENT_REFERENCE_KIND,
      entityId: PAYMENT_ID,
    });
  });
});

describe('the EventSink port (in-memory + failing sinks)', () => {
  it('the in-memory sink records appends in order and flattens its events', async () => {
    const sink = createInMemoryEventSink();
    const executor = fakeExecutor();
    const first = costEventEnvelope({
      command,
      eventName: BUDGET_CREATED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: { before: null, after: { entityKind: BUDGET_KIND, entityId: BUDGET_ID } },
      payload: {
        budgetId: BUDGET_ID,
        name: 'Riverside budget',
        currency: 'USD',
        version: 1,
        createdAt: NOW,
      },
    });
    const second = costEventEnvelope({
      command,
      eventName: COST_ITEM_RECORDED_EVENT,
      scope: SCOPE,
      occurredAt: NOW,
      entityRefs: { before: null, after: { entityKind: COST_ITEM_KIND, entityId: COST_ITEM_ID } },
      payload: {
        budgetId: BUDGET_ID,
        costItemId: COST_ITEM_ID,
        code: 'CONC',
        description: 'Concrete works',
        unit: 'lot',
        quantityMilli: 1000,
        unitRateMinor: 250000,
        amountMinor: 250000,
        version: 2,
      },
    });

    const firstAppend = await sink.appendEvents(executor, [first]);
    expect(firstAppend).toStrictEqual({ ok: true, value: true });
    const secondAppend = await sink.appendEvents(executor, [second]);
    expect(secondAppend).toStrictEqual({ ok: true, value: true });

    expect(sink.appends).toHaveLength(2);
    expect(sink.appends[0]?.executor).toBe(executor);
    expect(sink.events).toStrictEqual([first, second]);
    expect(sink.events.map((event) => event.eventName)).toStrictEqual([
      'cost.budgetCreated',
      'cost.costItemRecorded',
    ]);
  });

  it('the failing sink returns the typed event-sink failure', async () => {
    const sink: EventSink = failingEventSink('ledger unavailable');
    const result = await sink.appendEvents(fakeExecutor(), []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
      expect(result.error.message).toContain('ledger unavailable');
    }
    // The failure builder is the same typed shape (tests + wiring guards).
    expect(eventSinkFailure('x').code).toBe('invariant-violation');
  });
});

/** The in-memory sink never executes SQL; a stand-in executor suffices. */
const fakeExecutor = (): SqlExecutor => ({
  query: async () => {
    throw new TypeError('the in-memory sink must not execute SQL');
  },
});
