import { describe, expect, it } from 'vitest';
import { formatEntityId, parseCommandEnvelope, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, EntityId, ParseResult, Timestamp } from '@office/contracts';
import type { CommandExecutionContext, CommandHandler, CommandResult } from './index';
import { ok } from './index';

// OFF-003 domain kernel — transactional command interface tests. The
// interface is exercised through a deterministic in-memory handler: the
// transaction handle is a plain object, the clock and id suppliers are
// fixed values (no wall clock, no randomness anywhere).

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const USER_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';
const NEW_ENTITY_OPAQUE = 'c3d4e5f60718293a4b5c6d7e8f9a1b2';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

interface Tx {
  readonly id: string;
}

const command: CommandEnvelope<{ note: string }> = {
  ...unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName: 'tasks.appendNote',
      scope: {
        kind: 'project',
        tenantId: `office-tnt-v1-${TENANT_A_OPAQUE}`,
        projectId: `office-prj-v1-${PROJECT_A_OPAQUE}`,
      },
      actor: { kind: 'user', actorId: `office-ent-v1-${USER_OPAQUE}` },
      idempotencyKey: 'idem-4f9d2c81a7e3',
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload: { note: 'rebar delivered' },
    }),
  ),
  payload: { note: 'rebar delivered' },
};

describe('command execution context (injected suppliers)', () => {
  it('carries an opaque transaction handle plus injected clock and id suppliers', async () => {
    const fixedNow = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
    const fixedId = formatEntityId({ version: 'v1', opaque: NEW_ENTITY_OPAQUE });
    let clockCalls = 0;
    let idCalls = 0;
    const context: CommandExecutionContext<Tx> = {
      transaction: { id: 'tx-001' },
      now: () => {
        clockCalls += 1;
        return fixedNow;
      },
      newEntityId: () => {
        idCalls += 1;
        return fixedId;
      },
    };

    const handler: CommandHandler<
      { note: string },
      Tx,
      { at: Timestamp; newId: EntityId; note: string }
    > = async (envelope, ctx) =>
      ok({ at: ctx.now(), newId: ctx.newEntityId(), note: envelope.payload.note });

    const result: CommandResult<{ at: Timestamp; newId: EntityId; note: string }> =
      await handler(command, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.at).toBe('2026-09-12T10:15:31.000Z');
      expect(result.value.newId).toBe(fixedId);
      expect(result.value.note).toBe('rebar delivered');
    }
    expect(clockCalls).toBe(1);
    expect(idCalls).toBe(1);
    // The transaction handle is opaque to the kernel: passed through intact.
    expect(context.transaction).toStrictEqual({ id: 'tx-001' });
  });

  it('defaults the transaction handle type parameter to unknown', () => {
    const context: CommandExecutionContext = {
      transaction: null,
      now: () => unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
      newEntityId: () => formatEntityId({ version: 'v1', opaque: NEW_ENTITY_OPAQUE }),
    };
    expect(context.transaction).toBeNull();
    expect(context.now()).toBe('2026-09-12T10:15:31.000Z');
  });
});
