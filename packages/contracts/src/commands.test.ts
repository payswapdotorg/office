import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  isCommandEnvelope,
  isCommandName,
  isIdempotencyKey,
  parseCausationId,
  parseCommandEnvelope,
  parseCommandName,
  parseCorrelationId,
  parseEntityId,
  parseIdempotencyKey,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from './index';
import type { CommandEnvelope, ParseResult } from './index';

// OFF-002 contracts — commands tests. Deterministic: fixed ids and instants.

const TENANT_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PROJECT_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const USER_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const roundTrip = (value: unknown, parse: (raw: unknown) => ParseResult<unknown>): void => {
  const parsed = parse(JSON.parse(JSON.stringify(value)) as unknown);
  if (!parsed.ok) {
    throw new Error(`round-trip parse failed: ${JSON.stringify(parsed.error)}`);
  }
  expect(parsed.value).toStrictEqual(value);
};

const tenantId = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_OPAQUE })));
const projectId = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_OPAQUE })));
const userId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: USER_OPAQUE })));
const correlationId = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));
const issuedAt = unwrap(parseTimestamp('2026-09-12T10:15:30.000Z'));
const idempotencyKey = unwrap(parseIdempotencyKey('idem-4f9d2c81a7e3'));
const causationId = unwrap(parseCausationId('evt-998877665544'));

const command: CommandEnvelope<{ name: string }> = {
  kind: 'command',
  commandName: unwrap(parseCommandName('projects.createProject')),
  scope: { kind: 'project', tenantId, projectId },
  actor: { kind: 'user', actorId: userId },
  idempotencyKey,
  causality: { correlationId, causationId: null },
  issuedAt,
  schemaVersion: '1.0.0',
  payload: { name: 'Riverside Tower' },
};

describe('command envelope (freeze A8 / ADR-005)', () => {
  it('round-trips a user command through JSON', () => {
    roundTrip(command, parseCommandEnvelope);
  });

  it('round-trips system-actor and caused commands', () => {
    const systemCommand: CommandEnvelope<{ tenant: string }> = {
      ...command,
      commandName: unwrap(parseCommandName('tenants.provisionTenant')),
      scope: { kind: 'tenant', tenantId },
      actor: { kind: 'system' },
      payload: { tenant: 'riverhead-construction' },
    };
    roundTrip(systemCommand, parseCommandEnvelope);
    const causedCommand: CommandEnvelope<Record<string, never>> = {
      ...command,
      commandName: unwrap(parseCommandName('projects.approveProject')),
      causality: { correlationId, causationId },
      payload: {},
    };
    roundTrip(causedCommand, parseCommandEnvelope);
  });

  it('type-guards command envelopes, names, and idempotency keys', () => {
    expect(isCommandEnvelope(JSON.parse(JSON.stringify(command)) as unknown)).toBe(true);
    expect(isCommandEnvelope({ kind: 'command' })).toBe(false);
    expect(isCommandName('projects.createProject')).toBe(true);
    expect(isCommandName('CreateProject')).toBe(false);
    expect(isIdempotencyKey('idem-4f9d2c81a7e3')).toBe(true);
    expect(isIdempotencyKey('')).toBe(false);
    expect(isIdempotencyKey('has space')).toBe(false);
  });

  it('parses idempotency keys standalone', () => {
    expect(unwrap(parseIdempotencyKey('idem-4f9d2c81a7e3'))).toBe('idem-4f9d2c81a7e3');
    expect(parseIdempotencyKey(42).ok).toBe(false);
  });

  it('REQUIRES the idempotency key (A8/ADR-005): missing or malformed keys fail closed', () => {
    const missing = JSON.parse(JSON.stringify(command)) as Record<string, unknown>;
    delete missing['idempotencyKey'];
    const missingResult = parseCommandEnvelope(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(missingResult.error.code).toBe('missing-field');
      expect(missingResult.error.path).toBe('idempotencyKey');
    }
    const malformed = ['short', '', 'has space', 'x'.repeat(129), 42, null, ['key']];
    for (const badKey of malformed) {
      const raw = JSON.parse(JSON.stringify(command)) as Record<string, unknown>;
      raw['idempotencyKey'] = badKey;
      expect(parseCommandEnvelope(raw).ok, `key: ${String(badKey)}`).toBe(false);
    }
  });

  it('fails closed on unknown schema versions', () => {
    const raw = JSON.parse(JSON.stringify(command)) as Record<string, unknown>;
    raw['schemaVersion'] = '2.0.0';
    const result = parseCommandEnvelope(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-schema-version');
      expect(result.error.path).toBe('schemaVersion');
    }
  });

  it('rejects malformed envelopes field by field with typed paths', () => {
    const cases: Array<{
      name: string;
      mutate: (raw: Record<string, unknown>) => void;
      code: string;
      path: string;
    }> = [
      {
        name: 'missing commandName',
        mutate: (raw) => {
          delete raw['commandName'];
        },
        code: 'missing-field',
        path: 'commandName',
      },
      {
        name: 'invalid commandName',
        mutate: (raw) => {
          raw['commandName'] = 'CreateProject';
        },
        code: 'invalid-value',
        path: 'commandName',
      },
      {
        name: 'missing scope',
        mutate: (raw) => {
          delete raw['scope'];
        },
        code: 'missing-field',
        path: 'scope',
      },
      {
        name: 'missing projectId on project scope',
        mutate: (raw) => {
          const scope = raw['scope'] as Record<string, unknown>;
          delete scope['projectId'];
        },
        code: 'missing-field',
        path: 'scope.projectId',
      },
      {
        name: 'missing actor',
        mutate: (raw) => {
          delete raw['actor'];
        },
        code: 'missing-field',
        path: 'actor',
      },
      {
        name: 'missing causality',
        mutate: (raw) => {
          delete raw['causality'];
        },
        code: 'missing-field',
        path: 'causality',
      },
      {
        name: 'missing issuedAt',
        mutate: (raw) => {
          delete raw['issuedAt'];
        },
        code: 'missing-field',
        path: 'issuedAt',
      },
      {
        name: 'invalid issuedAt',
        mutate: (raw) => {
          raw['issuedAt'] = '2026-09-12';
        },
        code: 'invalid-value',
        path: 'issuedAt',
      },
      {
        name: 'missing payload',
        mutate: (raw) => {
          delete raw['payload'];
        },
        code: 'missing-field',
        path: 'payload',
      },
      {
        name: 'null payload',
        mutate: (raw) => {
          raw['payload'] = null;
        },
        code: 'invalid-type',
        path: 'payload',
      },
      {
        name: 'unknown envelope field',
        mutate: (raw) => {
          raw['priority'] = 'high';
        },
        code: 'unknown-field',
        path: 'priority',
      },
      {
        name: 'wrong kind',
        mutate: (raw) => {
          raw['kind'] = 'command2';
        },
        code: 'invalid-value',
        path: 'kind',
      },
    ];
    for (const testCase of cases) {
      const raw = JSON.parse(JSON.stringify(command)) as Record<string, unknown>;
      testCase.mutate(raw);
      const result = parseCommandEnvelope(raw);
      expect(result.ok, `case: ${testCase.name}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code, `case: ${testCase.name} (code)`).toBe(testCase.code);
        expect(result.error.path, `case: ${testCase.name} (path)`).toBe(testCase.path);
      }
    }
  });
});
