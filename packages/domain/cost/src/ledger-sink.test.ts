import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseDomainEventEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, DomainEventEnvelope, ParseResult, Timestamp } from '@office/contracts';
import type { SqlExecutor, SqlResult, SqlValue } from '@office/persistence';
import {
  BUDGET_CREATED_EVENT,
  COMMITMENT_CREATED_EVENT,
  INVOICE_RECORDED_EVENT,
  PAYMENT_REFERENCED_EVENT,
  costEventEnvelope,
} from './events';
import {
  BUDGET_KIND,
  COMMITMENT_KIND,
  COST_ITEM_KIND,
  INVOICE_KIND,
  PAYMENT_REFERENCE_KIND,
} from './state';
import { createLedgerEventSink } from './ledger-sink';

// OFF-011 cost domain — the thin ledger-backed EventSink adapter,
// shape-level tested against a fake SqlExecutor: no real database required.
// The fake echoes the adapter's own bound values back as decoded rows, so
// the assertions prove the WRITE SHAPE the adapter produces through the
// OFF-005 ledger + outbox functions (per-envelope: sequence upsert, ledger
// insert, outbox insert — all inside the CALLER'S transaction), the
// owning-root stream derivation (commitment events stream under the
// commitment even though their payload also names the budget; invoice
// events under the invoice even though their payload also names the
// commitment), the fail-closed payload guard, and the typed failure mapping.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const BUDGET_ID = formatEntityId({
  version: 'v1',
  opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2',
});
const COMMITMENT_ID = formatEntityId({
  version: 'v1',
  opaque: 'd4e5f60718293a4b5c6d7e8f9a1b2c3',
});
const INVOICE_ID = formatEntityId({
  version: 'v1',
  opaque: 'e5f60718293a4b5c6d7e8f9a1b2c3d4',
});
const COST_ITEM_ID = formatEntityId({
  version: 'v1',
  opaque: 'f60718293a4b5c6d7e8f9a1b2c3d4e5',
});
const PAYMENT_ID = formatEntityId({
  version: 'v1',
  opaque: '0718293a4b5c6d7e8f9a1b2c3d4e5f6',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const PAID_AT: Timestamp = unwrap(parseTimestamp('2026-09-11T09:00:00.000Z'));

const SCOPE = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID } as const;

const command: CommandEnvelope<unknown> = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'cost.createCommitment',
    scope: { kind: 'tenant', tenantId: TENANT_A },
    actor: { kind: 'user', actorId: ACTOR_ID },
    idempotencyKey: 'idem-4f9d2c81a7e3',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: {},
  }),
);

const budgetCreatedEnvelope = (): DomainEventEnvelope =>
  costEventEnvelope({
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

const commitmentCreatedEnvelope = (): DomainEventEnvelope =>
  costEventEnvelope({
    command,
    eventName: COMMITMENT_CREATED_EVENT,
    scope: SCOPE,
    occurredAt: NOW,
    entityRefs: { before: null, after: { entityKind: COMMITMENT_KIND, entityId: COMMITMENT_ID } },
    payload: {
      // The commitment payload names BOTH its owning root (commitmentId) and
      // the budget it was created against (budgetId).
      commitmentId: COMMITMENT_ID,
      budgetId: BUDGET_ID,
      number: 'PO-0001',
      commitmentKind: 'purchase-order',
      description: 'Foundations package',
      lineCount: 1,
      committedAmountMinor: 100000,
      version: 1,
      createdAt: NOW,
    },
  });

const invoiceRecordedEnvelope = (): DomainEventEnvelope =>
  costEventEnvelope({
    command,
    eventName: INVOICE_RECORDED_EVENT,
    scope: SCOPE,
    occurredAt: NOW,
    entityRefs: { before: null, after: { entityKind: INVOICE_KIND, entityId: INVOICE_ID } },
    payload: {
      // The invoice payload names BOTH its owning root (invoiceId) and the
      // commitment it is billed against (commitmentId).
      invoiceId: INVOICE_ID,
      commitmentId: COMMITMENT_ID,
      number: 'INV-0001',
      lineCount: 1,
      invoicedAmountMinor: 100000,
      version: 1,
      createdAt: NOW,
    },
  });

const paymentReferencedEnvelope = (): DomainEventEnvelope =>
  costEventEnvelope({
    command,
    eventName: PAYMENT_REFERENCED_EVENT,
    scope: SCOPE,
    occurredAt: NOW,
    entityRefs: {
      before: null,
      after: { entityKind: PAYMENT_REFERENCE_KIND, entityId: PAYMENT_ID },
    },
    payload: {
      invoiceId: INVOICE_ID,
      commitmentId: COMMITMENT_ID,
      paymentReferenceId: PAYMENT_ID,
      reference: 'CHK-1001',
      amountMinor: 60000,
      paidAt: PAID_AT,
      version: 2,
      recordedAt: NOW,
    },
  });

/**
 * A shape-level fake executor: it records every statement + bound values and
 * answers each of the three statements the ledger append path issues by
 * echoing the adapter's OWN bound values back as a decodable row. Asserting
 * on `statements`/`values` proves the exact write shape; no database exists.
 */
interface FakeExecutor extends SqlExecutor {
  readonly statements: readonly string[];
  readonly values: readonly SqlValue[][];
}

const fakeExecutor = (failOutboxWith?: Error): FakeExecutor => {
  const statements: string[] = [];
  const values: SqlValue[][] = [];
  // Per-(tenant, aggregate) sequence counters, mirroring the real ledger's
  // event_sequences rows: each aggregate stream numbers its OWN events
  // densely from 1.
  const sequences = new Map<string, number>();
  const executor: FakeExecutor = {
    statements,
    values,
    query: async (text: string, binds?: readonly SqlValue[]): Promise<SqlResult> => {
      statements.push(text);
      values.push([...(binds ?? [])]);
      if (text.includes('event_sequences')) {
        const [tenantId, aggregateKind, aggregateId] = [...(binds ?? [])];
        const key = `${String(tenantId)}|${String(aggregateKind)}|${String(aggregateId)}`;
        const next = (sequences.get(key) ?? 0) + 1;
        sequences.set(key, next);
        return { rows: [{ last_sequence: next }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO event_ledger')) {
        const v = [...(binds ?? [])];
        // The ledger insert binds: tenant, event_id, agg_kind, agg_id,
        // sequence, event_name, project_id, actor, source, correlation_id,
        // causation_id, schema_version, occurred_at, entity_refs, payload.
        // Echo them back as the RETURNING row (a decodable ledger row).
        return {
          rows: [
            {
              tenant_id: v[0],
              event_id: v[1],
              aggregate_kind: v[2],
              aggregate_id: v[3],
              sequence: v[4],
              event_name: v[5],
              project_id: v[6],
              actor: v[7],
              source: v[8],
              correlation_id: v[9],
              causation_id: v[10],
              schema_version: v[11],
              occurred_at: v[12],
              entity_refs: v[13],
              payload: v[14],
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('event_outbox')) {
        if (failOutboxWith !== undefined) throw failOutboxWith;
        const v = [...(binds ?? [])];
        return {
          rows: [
            {
              outbox_id: 1,
              tenant_id: v[0],
              project_id: v[1],
              event_id: v[2],
              state: v[3],
              attempts: v[4],
              available_at: v[5],
              created_at: v[6],
              dispatched_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected statement reached the executor: ${text}`);
    },
  };
  return executor;
};

describe('createLedgerEventSink (shape-level, fake executor)', () => {
  it('appends one budget event through the ledger and outbox inside the caller transaction', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, [budgetCreatedEnvelope()]);
    expect(result.ok).toBe(true);

    // Exactly three statements, in the canonical append order: the per-
    // aggregate sequence upsert, the ledger insert, the outbox insert.
    expect(executor.statements).toHaveLength(3);
    expect(executor.statements[0]).toContain('event_sequences');
    expect(executor.statements[1]).toContain('INSERT INTO event_ledger');
    expect(executor.statements[2]).toContain('event_outbox');

    // The ledger insert is scoped to the BUDGET aggregate stream derived
    // from the event payload's owning budgetId (binds $1..$6).
    const ledgerBinds = executor.values[1] ?? [];
    expect(ledgerBinds[0]).toBe(TENANT_A);
    expect(ledgerBinds[2]).toBe('budget');
    expect(ledgerBinds[3]).toBe(BUDGET_ID);
    expect(ledgerBinds[5]).toBe('cost.budgetCreated');
    expect(ledgerBinds[6]).toBe(PROJECT_ID);
    expect(ledgerBinds[8]).toBe('domain');

    // The outbox insert carries the appended ledger event id, pending state,
    // zero attempts (binds $1..$5).
    const outboxBinds = executor.values[2] ?? [];
    expect(outboxBinds[0]).toBe(TENANT_A);
    expect(outboxBinds[1]).toBe(PROJECT_ID);
    expect(outboxBinds[3]).toBe('pending');
    expect(outboxBinds[4]).toBe(0);
  });

  it('streams a commitment event under the COMMITMENT root (its budgetId is only a reference)', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, [commitmentCreatedEnvelope()]);
    expect(result.ok).toBe(true);
    const ledgerBinds = executor.values[1] ?? [];
    expect(ledgerBinds[2]).toBe('commitment');
    expect(ledgerBinds[3]).toBe(COMMITMENT_ID);
    expect(ledgerBinds[5]).toBe('cost.commitmentCreated');
  });

  it('streams invoice and payment events under the INVOICE root (the commitmentId is only a reference)', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, [
      invoiceRecordedEnvelope(),
      paymentReferencedEnvelope(),
    ]);
    expect(result.ok).toBe(true);
    const invoiceLedgerBinds = executor.values[1] ?? [];
    expect(invoiceLedgerBinds[2]).toBe('invoice');
    expect(invoiceLedgerBinds[3]).toBe(INVOICE_ID);
    expect(invoiceLedgerBinds[5]).toBe('cost.invoiceRecorded');
    const paymentLedgerBinds = executor.values[4] ?? [];
    expect(paymentLedgerBinds[2]).toBe('invoice');
    expect(paymentLedgerBinds[3]).toBe(INVOICE_ID);
    expect(paymentLedgerBinds[5]).toBe('cost.paymentReferenced');
  });

  it('appends each event of a batch with dense per-aggregate sequences', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, [
      budgetCreatedEnvelope(),
      commitmentCreatedEnvelope(),
    ]);
    expect(result.ok).toBe(true);
    // Two events => six statements (sequence, ledger, outbox) x 2.
    expect(executor.statements).toHaveLength(6);
    expect(executor.statements[3]).toContain('event_sequences');
    expect(executor.statements[4]).toContain('INSERT INTO event_ledger');
    // The second event's own aggregate stream gets ITS next dense sequence.
    const secondLedgerBinds = executor.values[4] ?? [];
    expect(secondLedgerBinds[2]).toBe('commitment');
    expect(secondLedgerBinds[4]).toBe(1);
  });

  it('an empty batch is a no-op that touches no SQL', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, []);
    expect(result.ok).toBe(true);
    expect(executor.statements).toHaveLength(0);
  });

  it('fails closed when an envelope payload carries no owning root id', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const bare = unwrap(
      parseDomainEventEnvelope({
        kind: 'event',
        eventName: 'cost.costItemRecorded',
        scope: SCOPE,
        actor: { kind: 'user', actorId: ACTOR_ID },
        source: 'domain',
        causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: 'idem-4f9d2c81a7e3' },
        schemaVersion: '1.0.0',
        occurredAt: NOW,
        entityRefs: {
          before: null,
          after: { entityKind: COST_ITEM_KIND, entityId: COST_ITEM_ID },
        },
        payload: { note: 'no owning root id' },
      }),
    );
    const result = await sink.appendEvents(executor, [bare]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('cost-event-payload-carries-owning-root-id');
    }
    // Nothing was written: the guard fires before any SQL runs.
    expect(executor.statements).toHaveLength(0);
  });

  it('maps an outbox rejection onto a typed invariant-violation (the mutation aborts)', async () => {
    const duplicate = Object.assign(
      new Error('duplicate key value violates unique constraint'),
      { code: '23505', constraint: 'event_outbox_event_id_key' },
    );
    const executor = fakeExecutor(duplicate);
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, [budgetCreatedEnvelope()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('outbox-entry-already-exists');
      expect(result.error.message).toContain('event sink rejected the append');
    }
    // The ledger insert DID run; the outbox insert failed — the caller's
    // transaction must roll the ledger row back (the port contract).
    expect(executor.statements).toHaveLength(3);
  });
});
