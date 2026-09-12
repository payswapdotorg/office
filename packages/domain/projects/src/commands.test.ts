import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope, parseTenantId, parseTimestamp } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Transaction, TransactionRunner } from '@office/persistence';
import {
  ARCHIVE_PROJECT_COMMAND,
  CREATE_PROJECT_COMMAND,
  UPDATE_PROJECT_COMMAND,
  createProjectCommands,
  parseArchiveProjectPayload,
  parseCreateProjectPayload,
  parseUpdateProjectPayload,
} from './commands';
import type { ProjectCommandDeps } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';

// OFF-007 project domain — command payload parsing (fail-closed) and the
// command-name guard + authorize-before-transaction behavior. Pure unit
// tests: a fake transaction runner proves denied commands never open a
// transaction; the repository is never reached.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const PROJECT_ID = 'office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9' as const;

const envelope = (payload: unknown, commandName = CREATE_PROJECT_COMMAND) =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: { kind: 'tenant', tenantId: TENANT_A },
      actor: { kind: 'user', actorId: 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1' },
      idempotencyKey: 'idem-4f9d2c81a7e3',
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

// ----- payload parsing ---------------------------------------------------------

describe('createProject payload parsing (fail-closed)', () => {
  it('parses a minimal valid payload', () => {
    const result = parseCreateProjectPayload({ name: 'Riverside Tower' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual({ name: 'Riverside Tower' });
  });

  it('parses extension metadata when present', () => {
    const result = parseCreateProjectPayload({
      name: 'Riverside Tower',
      extensionMetadata: { code: 'RT-01' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extensionMetadata).toStrictEqual({ code: 'RT-01' });
    }
  });

  it('rejects a missing name', () => {
    const result = parseCreateProjectPayload({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });

  it('rejects an empty name', () => {
    const result = parseCreateProjectPayload({ name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects non-object extension metadata', () => {
    const result = parseCreateProjectPayload({ name: 'Riverside Tower', extensionMetadata: 'RT-01' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseCreateProjectPayload({ name: 'Riverside Tower', code: 'RT-01' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('updateProject payload parsing (fail-closed)', () => {
  it('parses a valid payload', () => {
    const result = parseUpdateProjectPayload({
      projectId: PROJECT_ID,
      expectedVersion: 2,
      name: 'Riverside Tower II',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projectId).toBe(PROJECT_ID);
      expect(result.value.expectedVersion).toBe(2);
      expect(result.value.changes).toStrictEqual({ name: 'Riverside Tower II' });
    }
  });

  it('rejects a payload without any change field', () => {
    const result = parseUpdateProjectPayload({
      projectId: PROJECT_ID,
      expectedVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a generic entity id (a project id must use the prj kind code)', () => {
    const result = parseUpdateProjectPayload({
      projectId: 'office-ent-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
      expectedVersion: 2,
      name: 'Riverside Tower II',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a malformed canonical project id', () => {
    const result = parseUpdateProjectPayload({
      projectId: 'not-a-canonical-id',
      expectedVersion: 2,
      name: 'Riverside Tower II',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a non-positive expected version', () => {
    const result = parseUpdateProjectPayload({
      projectId: PROJECT_ID,
      expectedVersion: 0,
      name: 'Riverside Tower II',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseUpdateProjectPayload({
      projectId: PROJECT_ID,
      expectedVersion: 2,
      name: 'Riverside Tower II',
      status: 'archived',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('archiveProject payload parsing (fail-closed)', () => {
  it('parses a valid payload', () => {
    const result = parseArchiveProjectPayload({
      projectId: PROJECT_ID,
      expectedVersion: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.expectedVersion).toBe(3);
  });

  it('rejects a missing expected version', () => {
    const result = parseArchiveProjectPayload({ projectId: PROJECT_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

// ----- command-name guard + authorize-before-transaction -----------------------

const fakeTx = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Transaction;

const makeDeps = (
  sink: InMemoryEventSink = createInMemoryEventSink(),
): ProjectCommandDeps & { runnerCalls: { count: number } } => {
  const runnerCalls = { count: 0 };
  const runner: TransactionRunner = {
    runInTransaction: async (work) => {
      runnerCalls.count += 1;
      return work(fakeTx);
    },
  };
  return {
    repository: {
      insert: async () => {
        throw new Error('repository must not be reached in these tests');
      },
      findById: async () => {
        throw new Error('repository must not be reached in these tests');
      },
      list: async () => {
        throw new Error('repository must not be reached in these tests');
      },
      update: async () => {
        throw new Error('repository must not be reached in these tests');
      },
      archive: async () => {
        throw new Error('repository must not be reached in these tests');
      },
    },
    eventSink: sink,
    transactionRunner: runner,
    now: () => NOW,
    newOpaqueId: () => 'c3d4e5f60718293a4b5c6d7e8f9a1b2',
    runnerCalls,
  };
};

describe('command-name guard (trusted path, loud)', () => {
  it('rejects an envelope of another command kind with a TypeError', async () => {
    const deps = makeDeps();
    const commands = createProjectCommands(deps);
    const wrongEnvelope = envelope({ projectId: PROJECT_ID, expectedVersion: 1 }, UPDATE_PROJECT_COMMAND);
    await expect(
      commands.createProject(wrongEnvelope, { policy: definePolicy([]), capabilities: ['projects.write'] }),
    ).rejects.toThrow(TypeError);
    expect(deps.runnerCalls.count).toBe(0);
  });
});

describe('authorization runs before any transaction is opened', () => {
  it('denies without the required capability (default deny) and never opens a transaction', async () => {
    const deps = makeDeps();
    const commands = createProjectCommands(deps);
    const result = await commands.createProject(envelope({ name: 'Riverside Tower' }), {
      policy: definePolicy([]),
      capabilities: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
      expect(result.error.scope).toStrictEqual({ kind: 'tenant', tenantId: TENANT_A });
    }
    expect(deps.runnerCalls.count).toBe(0);
  });

  it('denies through an explicit deny rule even with the capability granted', async () => {
    const deps = makeDeps();
    const commands = createProjectCommands(deps);
    const result = await commands.createProject(envelope({ name: 'Riverside Tower' }), {
      policy: definePolicy([
        { effect: 'deny', capabilities: ['projects.write'], actions: ['write'] },
        { effect: 'allow', capabilities: ['projects.write'], actions: ['write'] },
      ]),
      capabilities: ['projects.write'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
    expect(deps.runnerCalls.count).toBe(0);
  });

  it('rejects an undeclared capability name loudly (trusted path)', async () => {
    const deps = makeDeps();
    const commands = createProjectCommands(deps);
    await expect(
      commands.createProject(envelope({ name: 'Riverside Tower' }), {
        policy: definePolicy([]),
        capabilities: ['projects.administer'],
      }),
    ).rejects.toThrow(TypeError);
    expect(deps.runnerCalls.count).toBe(0);
  });
});

describe('command name constants', () => {
  it('declares the three lifecycle command names', () => {
    expect(CREATE_PROJECT_COMMAND).toBe('projects.createProject');
    expect(UPDATE_PROJECT_COMMAND).toBe('projects.updateProject');
    expect(ARCHIVE_PROJECT_COMMAND).toBe('projects.archiveProject');
  });
});
