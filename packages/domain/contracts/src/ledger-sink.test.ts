import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseDomainEventEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type { DomainEventEnvelope, ParseResult, Timestamp } from '@office/contracts';
import type { SqlExecutor, SqlResult, SqlValue } from '@office/persistence';
import { CHANGE_EVENT_RAISED_EVENT } from './events';
import { CHANGE_EVENT_KIND, CONTRACT_KIND } from './state';
import { contractsEventEnvelope } from './events';
import { createLedgerEventSink } from './ledger-sink';

// OFF-012 contracts/change domain — the thin ledger-backed EventSink adapter,
// shape-level tested against a fake SqlExecutor: no real database required.
// The fake echoes the adapter's own bound values back as decoded rows, so
// the assertions prove the WRITE SHAPE the adapter produces through the
// OFF-005 ledger + outbox functions (per-envelope: sequence upsert, ledger
// insert, outbox insert — all inside the CALLER'S transaction), plus the
// fail-closed payload guard and the typed failure mapping.

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
const CONTRACT_ID = formatEntityId({
  version: 'v1',
  opaque: 'aa1b2c3d4e5f60718293a4b5c6d7e8f0',
});
const CHANGE_EVENT_ID = formatEntityId({
  version: 'v1',
  opaque: 'cc3d4e5f60718293a4b5c6d7e8f0a1b2',
});
const OBLIGATION_ID = formatEntityId({
  version: 'v1',
  opaque: 'bb2c3d4e5f60718293a4b5c6d7e8f0a1',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const SCOPE = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID } as const;

const command = unwrap(
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

const changeEventRaisedEnvelope = (): DomainEventEnvelope =>
  contractsEventEnvelope({
    command,
    eventName: CHANGE_EVENT_RAISED_EVENT,
    scope: SCOPE,
    occurredAt: NOW,
    entityRefs: {
      before: null,
      after: { entityKind: CHANGE_EVENT_KIND, entityId: CHANGE_EVENT_ID },
    },
    payload: {
      contractId: CONTRACT_ID,
      changeEventId: CHANGE_EVENT_ID,
      title: 'North platform additional excavation',
      changeType: 'modification',
      status: 'proposed',
      affectedObligationIds: [OBLIGATION_ID],
      evidenceLinks: [],
      costImpactLinks: [],
      scheduleImpactActivityIds: [],
      version: 1,
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
  let sequence = 0;
  const executor: FakeExecutor = {
    statements,
    values,
    query: async (text: string, binds?: readonly SqlValue[]): Promise<SqlResult> => {
      statements.push(text);
      values.push([...(binds ?? [])]);
      if (text.includes('event_sequences')) {
        sequence += 1;
        return { rows: [{ last_sequence: sequence }], rowCount: 1 };
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
  it('appends one event through the ledger and outbox inside the caller transaction', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, [changeEventRaisedEnvelope()]);
    expect(result.ok).toBe(true);

    // Exactly three statements, in the canonical append order: the per-
    // aggregate sequence upsert, the ledger insert, the outbox insert.
    expect(executor.statements).toHaveLength(3);
    expect(executor.statements[0]).toContain('event_sequences');
    expect(executor.statements[1]).toContain('INSERT INTO event_ledger');
    expect(executor.statements[2]).toContain('event_outbox');

    // The ledger insert is scoped to the CONTRACT aggregate stream derived
    // from the event payload's owning contractId (binds $1..$4).
    const ledgerBinds = executor.values[1] ?? [];
    expect(ledgerBinds[0]).toBe(TENANT_A);
    expect(ledgerBinds[2]).toBe(String(CONTRACT_KIND));
    expect(ledgerBinds[3]).toBe(CONTRACT_ID);
    expect(ledgerBinds[5]).toBe('contracts.changeEventRaised');
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

  it('appends each event of a batch with dense per-aggregate sequences', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, [
      changeEventRaisedEnvelope(),
      changeEventRaisedEnvelope(),
    ]);
    expect(result.ok).toBe(true);
    // Two events => six statements (sequence, ledger, outbox) x 2.
    expect(executor.statements).toHaveLength(6);
    expect(executor.statements[3]).toContain('event_sequences');
    expect(executor.statements[4]).toContain('INSERT INTO event_ledger');
    // The second ledger insert binds the NEXT dense sequence number.
    const secondLedgerBinds = executor.values[4] ?? [];
    expect(secondLedgerBinds[4]).toBe(2);
  });

  it('an empty batch is a no-op that touches no SQL', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const result = await sink.appendEvents(executor, []);
    expect(result.ok).toBe(true);
    expect(executor.statements).toHaveLength(0);
  });

  it('fails closed when an envelope payload does not carry the owning contractId', async () => {
    const executor = fakeExecutor();
    const sink = createLedgerEventSink();
    const bare = unwrap(
      parseDomainEventEnvelope({
        kind: 'event',
        eventName: 'contracts.changeEventRaised',
        scope: SCOPE,
        actor: { kind: 'user', actorId: ACTOR_ID },
        source: 'domain',
        causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: 'idem-4f9d2c81a7e3' },
        schemaVersion: '1.0.0',
        occurredAt: NOW,
        entityRefs: {
          before: null,
          after: { entityKind: CHANGE_EVENT_KIND, entityId: CHANGE_EVENT_ID },
        },
        payload: { note: 'no owning contract id' },
      }),
    );
    const result = await sink.appendEvents(executor, [bare]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('contracts-event-payload-carries-contract-id');
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
    const result = await sink.appendEvents(executor, [changeEventRaisedEnvelope()]);
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
