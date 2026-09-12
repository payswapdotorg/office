import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope, parseTenantId, parseTimestamp } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Transaction, TransactionRunner } from '@office/persistence';
import {
  ARCHIVE_ORGANIZATION_COMMAND,
  CREATE_ORGANIZATION_COMMAND,
  UPDATE_ORGANIZATION_COMMAND,
  createOrganizationCommands,
  parseArchiveOrganizationPayload,
  parseCreateOrganizationPayload,
  parseUpdateOrganizationPayload,
} from './commands';
import type { OrganizationCommandDeps } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';

// OFF-007 organization domain — command payload parsing (fail-closed) and
// the command-name guard + authorize-before-transaction behavior. Pure unit
// tests: a fake transaction runner proves denied commands never open a
// transaction; the repository is never reached.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const ORGANIZATION_ID = 'office-ent-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9' as const;

const envelope = (payload: unknown, commandName = CREATE_ORGANIZATION_COMMAND) =>
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

describe('createOrganization payload parsing (fail-closed)', () => {
  it('parses a minimal valid payload', () => {
    const result = parseCreateOrganizationPayload({ name: 'BuildCo' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toStrictEqual({ name: 'BuildCo' });
  });

  it('parses extension metadata when present', () => {
    const result = parseCreateOrganizationPayload({
      name: 'BuildCo',
      extensionMetadata: { tier: 'enterprise' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extensionMetadata).toStrictEqual({ tier: 'enterprise' });
    }
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseCreateOrganizationPayload({ name: 'BuildCo', parentId: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects a missing name', () => {
    const result = parseCreateOrganizationPayload({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });

  it('rejects an empty name', () => {
    const result = parseCreateOrganizationPayload({ name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects non-object extension metadata', () => {
    const result = parseCreateOrganizationPayload({ name: 'BuildCo', extensionMetadata: [1] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });

  it('rejects a non-object payload root', () => {
    const result = parseCreateOrganizationPayload('BuildCo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });
});

describe('updateOrganization payload parsing (fail-closed)', () => {
  it('parses name and extension metadata changes', () => {
    const result = parseUpdateOrganizationPayload({
      organizationId: ORGANIZATION_ID,
      expectedVersion: 2,
      name: 'BuildCo Group',
      extensionMetadata: { tier: 'enterprise' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.organizationId).toBe(ORGANIZATION_ID);
      expect(result.value.expectedVersion).toBe(2);
      expect(result.value.changes.name).toBe('BuildCo Group');
    }
  });

  it('rejects a payload with no change field', () => {
    const result = parseUpdateOrganizationPayload({
      organizationId: ORGANIZATION_ID,
      expectedVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a malformed canonical organization id', () => {
    const result = parseUpdateOrganizationPayload({
      organizationId: 'not-a-canonical-id',
      expectedVersion: 2,
      name: 'BuildCo Group',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects a non-positive expected version', () => {
    const result = parseUpdateOrganizationPayload({
      organizationId: ORGANIZATION_ID,
      expectedVersion: 0,
      name: 'BuildCo Group',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseUpdateOrganizationPayload({
      organizationId: ORGANIZATION_ID,
      expectedVersion: 2,
      name: 'BuildCo Group',
      status: 'archived',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('archiveOrganization payload parsing (fail-closed)', () => {
  it('parses a valid payload', () => {
    const result = parseArchiveOrganizationPayload({
      organizationId: ORGANIZATION_ID,
      expectedVersion: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.expectedVersion).toBe(3);
  });

  it('rejects a missing expected version', () => {
    const result = parseArchiveOrganizationPayload({ organizationId: ORGANIZATION_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

// ----- command-name guard + authorize-before-transaction -----------------------

const fakeTx = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Transaction;

const makeDeps = (
  sink: InMemoryEventSink = createInMemoryEventSink(),
): OrganizationCommandDeps & { runnerCalls: { count: number } } => {
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
    const commands = createOrganizationCommands(deps);
    const wrongEnvelope = envelope({ organizationId: ORGANIZATION_ID, expectedVersion: 1 }, UPDATE_ORGANIZATION_COMMAND);
    await expect(
      commands.createOrganization(wrongEnvelope, { policy: definePolicy([]), capabilities: ['organization.write'] }),
    ).rejects.toThrow(TypeError);
    expect(deps.runnerCalls.count).toBe(0);
  });
});

describe('authorization runs before any transaction is opened', () => {
  it('denies without the required capability (default deny) and never opens a transaction', async () => {
    const deps = makeDeps();
    const commands = createOrganizationCommands(deps);
    const result = await commands.createOrganization(envelope({ name: 'BuildCo' }), {
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
    const commands = createOrganizationCommands(deps);
    const result = await commands.createOrganization(envelope({ name: 'BuildCo' }), {
      policy: definePolicy([
        { effect: 'deny', capabilities: ['organization.write'], actions: ['write'] },
        { effect: 'allow', capabilities: ['organization.write'], actions: ['write'] },
      ]),
      capabilities: ['organization.write'],
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
    const commands = createOrganizationCommands(deps);
    await expect(
      commands.createOrganization(envelope({ name: 'BuildCo' }), {
        policy: definePolicy([]),
        capabilities: ['organization.administer'],
      }),
    ).rejects.toThrow(TypeError);
    expect(deps.runnerCalls.count).toBe(0);
  });
});

describe('command name constants', () => {
  it('declares the three lifecycle command names', () => {
    expect(CREATE_ORGANIZATION_COMMAND).toBe('organization.createOrganization');
    expect(UPDATE_ORGANIZATION_COMMAND).toBe('organization.updateOrganization');
    expect(ARCHIVE_ORGANIZATION_COMMAND).toBe('organization.archiveOrganization');
  });
});
