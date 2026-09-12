import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope } from '@office/contracts';
import type { CommandEnvelope, ParseResult } from '@office/contracts';
import {
  commandFingerprint,
  createInMemoryIdempotencyRegistry,
  withIdempotency,
} from './index';
import type { DomainError } from './index';

// OFF-003 domain kernel — idempotency primitive tests. Deterministic: fixed
// commands, fixed instants, in-memory registry only.

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TENANT_B_OPAQUE = 'f9e8d7c6b5a493827160f5e4d3c2b1a0';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const USER_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

interface CommandFixture {
  readonly commandName?: string;
  readonly tenantOpaque?: string;
  readonly projectId?: boolean;
  readonly actorId?: string;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly causationId?: string | null;
  readonly issuedAt?: string;
  readonly payload?: Record<string, unknown>;
}

/** Build a VALIDATED CommandEnvelope via the contracts boundary parser. */
const command = (fixture: CommandFixture = {}): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName: fixture.commandName ?? 'tasks.setCounts',
      scope:
        fixture.projectId === false
          ? {
              kind: 'tenant',
              tenantId: `office-tnt-v1-${fixture.tenantOpaque ?? TENANT_A_OPAQUE}`,
            }
          : {
              kind: 'project',
              tenantId: `office-tnt-v1-${fixture.tenantOpaque ?? TENANT_A_OPAQUE}`,
              projectId: `office-prj-v1-${PROJECT_A_OPAQUE}`,
            },
      actor: {
        kind: 'user',
        actorId: `office-ent-v1-${fixture.actorId ?? USER_OPAQUE}`,
      },
      idempotencyKey: fixture.idempotencyKey ?? 'idem-4f9d2c81a7e3',
      causality: {
        correlationId: fixture.correlationId ?? 'corr-0f1e2d3c4b5a',
        causationId: fixture.causationId === undefined ? null : fixture.causationId,
      },
      issuedAt: fixture.issuedAt ?? '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload: fixture.payload ?? { doneCount: 2, itemCount: 3 },
    }),
  );

describe('command fingerprint', () => {
  it('is deterministic for structurally equal commands regardless of key order', () => {
    const first = command();
    const second = command();
    expect(commandFingerprint(first)).toBe(commandFingerprint(second));
    expect(commandFingerprint(first)).toBe(commandFingerprint(first));
  });

  it('changes with command name, scope, actor, schema-relevant payload, and tenant', () => {
    const base = commandFingerprint(command());
    expect(commandFingerprint(command({ commandName: 'tasks.archiveTask' }))).not.toBe(base);
    expect(commandFingerprint(command({ tenantOpaque: TENANT_B_OPAQUE }))).not.toBe(base);
    expect(
      commandFingerprint(command({ payload: { doneCount: 3, itemCount: 3 } })),
    ).not.toBe(base);
    expect(
      commandFingerprint(command({ actorId: 'd4e5f60718293a4b5c6d7e8f9a1b2c3' })),
    ).not.toBe(base);
    expect(
      commandFingerprint(command({ projectId: false })),
    ).not.toBe(base);
  });

  it('ignores retry metadata: issuedAt, causality, and the idempotency key itself', () => {
    const base = commandFingerprint(command());
    expect(
      commandFingerprint(command({ issuedAt: '2027-01-01T00:00:00.000Z' })),
    ).toBe(base);
    expect(
      commandFingerprint(
        command({ correlationId: 'corr-ffffffffffff', causationId: 'evt-998877665544' }),
      ),
    ).toBe(base);
    expect(commandFingerprint(command({ idempotencyKey: 'idem-aaaaaaaaaaaa' }))).toBe(base);
  });

  it('serializes payloads canonically (sorted keys, array order preserved)', () => {
    const unordered = command({ payload: { itemCount: 3, doneCount: 2 } });
    const ordered = command({ payload: { doneCount: 2, itemCount: 3 } });
    expect(commandFingerprint(unordered)).toBe(commandFingerprint(ordered));
    const arraysDiffer = command({
      payload: { tags: ['a', 'b'], doneCount: 2, itemCount: 3 },
    });
    const arraysReordered = command({
      payload: { tags: ['b', 'a'], doneCount: 2, itemCount: 3 },
    });
    expect(commandFingerprint(arraysDiffer)).not.toBe(commandFingerprint(arraysReordered));
  });
});

describe('in-memory idempotency registry', () => {
  it('reports unregistered for a fresh (scope, key) pair', () => {
    const registry = createInMemoryIdempotencyRegistry();
    const cmd = command();
    const lookup = registry.lookup(cmd.scope, cmd.idempotencyKey, commandFingerprint(cmd));
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.value.status).toBe('unregistered');
  });

  it('replays the recorded outcome for the same key and fingerprint', () => {
    const registry = createInMemoryIdempotencyRegistry();
    const cmd = command();
    const fingerprint = commandFingerprint(cmd);
    expect(registry.record(cmd.scope, cmd.idempotencyKey, fingerprint, { version: 2 }).ok).toBe(
      true,
    );
    const replay = registry.lookup(cmd.scope, cmd.idempotencyKey, fingerprint);
    expect(replay.ok).toBe(true);
    if (replay.ok && replay.value.status === 'replay') {
      expect(replay.value.outcome).toStrictEqual({ version: 2 });
    } else {
      throw new Error('expected replay status');
    }
  });

  it('fails with a typed idempotency-conflict on a different command fingerprint', () => {
    const registry = createInMemoryIdempotencyRegistry();
    const original = command();
    const other = command({ payload: { doneCount: 3, itemCount: 3 } });
    expect(
      registry.record(original.scope, original.idempotencyKey, commandFingerprint(original), 1)
        .ok,
    ).toBe(true);
    const conflict = registry.lookup(
      original.scope,
      original.idempotencyKey,
      commandFingerprint(other),
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      const error: DomainError = conflict.error;
      expect(error.code).toBe('idempotency-conflict');
      expect(error.details[0]?.code).toBe('idempotency-key-reuse');
    }
    const recordConflict = registry.record(
      original.scope,
      original.idempotencyKey,
      commandFingerprint(other),
      2,
    );
    expect(recordConflict.ok).toBe(false);
    if (!recordConflict.ok) {
      expect(recordConflict.error.code).toBe('idempotency-conflict');
    }
  });

  it('never lets a conflicting record overwrite the original outcome', () => {
    const registry = createInMemoryIdempotencyRegistry();
    const original = command();
    const other = command({ commandName: 'tasks.archiveTask' });
    registry.record(original.scope, original.idempotencyKey, commandFingerprint(original), {
      version: 2,
    });
    expect(
      registry.record(original.scope, original.idempotencyKey, commandFingerprint(other), {
        version: 99,
      }).ok,
    ).toBe(false);
    const replay = registry.lookup(
      original.scope,
      original.idempotencyKey,
      commandFingerprint(original),
    );
    if (replay.ok && replay.value.status === 'replay') {
      expect(replay.value.outcome).toStrictEqual({ version: 2 });
    } else {
      throw new Error('expected the original outcome to be preserved');
    }
  });

  it('dedupes by (scope, idempotency key): the same key in another scope is fresh', () => {
    const registry = createInMemoryIdempotencyRegistry();
    const tenantCommand = command();
    const otherTenantCommand = command({ tenantOpaque: TENANT_B_OPAQUE });
    expect(
      registry.record(
        tenantCommand.scope,
        tenantCommand.idempotencyKey,
        commandFingerprint(tenantCommand),
        'tenant-a-outcome',
      ).ok,
    ).toBe(true);
    const otherScope = registry.lookup(
      otherTenantCommand.scope,
      otherTenantCommand.idempotencyKey,
      commandFingerprint(otherTenantCommand),
    );
    expect(otherScope.ok).toBe(true);
    if (otherScope.ok) expect(otherScope.value.status).toBe('unregistered');
  });

  it('keeps separate registry instances isolated', () => {
    const first = createInMemoryIdempotencyRegistry();
    const second = createInMemoryIdempotencyRegistry();
    const cmd = command();
    first.record(cmd.scope, cmd.idempotencyKey, commandFingerprint(cmd), 1);
    const lookup = second.lookup(cmd.scope, cmd.idempotencyKey, commandFingerprint(cmd));
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.value.status).toBe('unregistered');
  });
});

describe('withIdempotency composition', () => {
  it('executes once and replays the recorded outcome on retry (harmless)', async () => {
    const registry = createInMemoryIdempotencyRegistry();
    const cmd = command();
    let executions = 0;
    const execute = (): { readonly version: number } => {
      executions += 1;
      return { version: 2 };
    };
    const first = await withIdempotency(registry, cmd, () => ({
      ok: true as const,
      value: execute(),
    }));
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.replayed).toBe(false);
      expect(first.value.value).toStrictEqual({ version: 2 });
    }
    const retry = await withIdempotency(
      registry,
      command({ issuedAt: '2026-09-12T10:16:00.000Z' }),
      () => ({ ok: true as const, value: execute() }),
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.value.replayed).toBe(true);
      expect(retry.value.value).toStrictEqual({ version: 2 });
    }
    expect(executions).toBe(1);
  });

  it('fails with a typed idempotency-conflict when the same key carries a different command', async () => {
    const registry = createInMemoryIdempotencyRegistry();
    const cmd = command();
    let executions = 0;
    const execute = () => {
      executions += 1;
      return { ok: true as const, value: { version: 2 } };
    };
    await withIdempotency(registry, cmd, execute);
    const conflicting = await withIdempotency(
      registry,
      command({ payload: { doneCount: 3, itemCount: 3 } }),
      execute,
    );
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.code).toBe('idempotency-conflict');
      expect(conflicting.error.scope).toStrictEqual(cmd.scope);
      expect(conflicting.error.correlationId).toBe(cmd.causality.correlationId);
    }
    expect(executions).toBe(1);
  });

  it('does not record failures: the same key retries and can succeed', async () => {
    const registry = createInMemoryIdempotencyRegistry();
    const cmd = command();
    const domainError: DomainError = {
      kind: 'domain-error',
      code: 'concurrency-conflict',
      message: 'stale version',
      scope: cmd.scope,
      correlationId: cmd.causality.correlationId,
      details: [],
    };
    let failing = true;
    let executions = 0;
    const execute = () => {
      executions += 1;
      return failing
        ? { ok: false as const, error: domainError }
        : { ok: true as const, value: { version: 3 } };
    };
    const failed = await withIdempotency(registry, cmd, execute);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('concurrency-conflict');
    failing = false;
    const retried = await withIdempotency(registry, cmd, execute);
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.value.replayed).toBe(false);
      expect(retried.value.value).toStrictEqual({ version: 3 });
    }
    expect(executions).toBe(2);
  });

  it('supports async executors and awaits their results', async () => {
    const registry = createInMemoryIdempotencyRegistry();
    const cmd = command();
    const first = await withIdempotency(registry, cmd, async () => ({
      ok: true as const,
      value: 'committed',
    }));
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.value).toBe('committed');
    const replay = await withIdempotency(registry, cmd, async () => ({
      ok: true as const,
      value: 'committed-again',
    }));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.value).toBe('committed');
    }
  });
});
