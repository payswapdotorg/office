// OFF-017 acceptance — the injected typed command handler port: resolution
// by command name, fail-closed construction, and the invocation contract the
// gateway relies on (already-validated envelope + transaction-bound context).
import { describe, expect, it } from 'vitest';
import { parseCommandName, parseEntityId, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope } from '@office/contracts';
import { ok } from '@office/domain-kernel';
import { FAKE_EXECUTOR, envelope, unwrap } from './test-support';
import { createInMemoryActionHandlers } from './handlers';
import type { ActionCommandHandler } from './handlers';

const counting: ActionCommandHandler = async (command: CommandEnvelope) =>
  ok({ seen: command.commandName as string });

describe('createInMemoryActionHandlers', () => {
  it('resolves a registered handler by command name', () => {
    const handlers = createInMemoryActionHandlers({
      'cost.listCostItems': counting,
    });
    expect(handlers.resolve(unwrap(parseCommandName('cost.listCostItems')))).toBe(counting);
  });

  it('resolves unknown command names to null (a typed wiring failure upstream)', () => {
    const handlers = createInMemoryActionHandlers({
      'cost.listCostItems': counting,
    });
    expect(handlers.resolve(unwrap(parseCommandName('cost.teleportLedger')))).toBeNull();
  });

  it('throws a loud TypeError on a malformed command-name key', () => {
    expect(() => createInMemoryActionHandlers({ 'Not A Name': counting })).toThrow(TypeError);
  });

  it('throws a loud TypeError on a non-function handler', () => {
    expect(() =>
      createInMemoryActionHandlers({ 'cost.listCostItems': 42 as unknown as ActionCommandHandler }),
    ).toThrow(TypeError);
  });

  it('handlers receive the already-validated envelope and the transaction-bound context', async () => {
    const seen: CommandEnvelope[] = [];
    const handlers = createInMemoryActionHandlers({
      'cost.listCostItems': async (command, context) => {
        seen.push(command);
        expect(context.transaction).toBe(FAKE_EXECUTOR);
        expect(typeof context.now()).toBe('string');
        expect(String(context.newEntityId())).toMatch(/^office-ent-v1-/);
        return ok(true);
      },
    });
    const command = envelope({ filter: 'all' }, unwrap(parseCommandName('cost.listCostItems')), {
      key: 'handler-key-0001',
    });
    const result = await handlers.resolve(command.commandName)?.(command, {
      transaction: FAKE_EXECUTOR,
      now: () => unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
      newEntityId: () => unwrap(parseEntityId('office-ent-v1-0000000000000001')),
    });
    expect(result?.ok).toBe(true);
    expect(seen).toEqual([command]);
  });
});
