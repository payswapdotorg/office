import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  isCausality,
  isDomainEventEnvelope,
  isEventName,
  parseCausality,
  parseCausationId,
  parseCorrelationId,
  parseDomainEventEnvelope,
  parseEntityId,
  parseEntityKind,
  parseEntityRef,
  parseEntityRefs,
  parseEventName,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from './index';
import type { DomainEventEnvelope, EntityRef, ParseResult } from './index';

// OFF-002 contracts — events tests. Deterministic: fixed ids and instants.

const TENANT_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PROJECT_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const PROJECT_REF_OPAQUE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9';
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
const projectEntityId = formatProjectId({ version: 'v1', opaque: PROJECT_REF_OPAQUE });
const userId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: USER_OPAQUE })));
const correlationId = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));
const causationId = unwrap(parseCausationId('idem-4f9d2c81a7e3'));
const occurredAt = unwrap(parseTimestamp('2026-09-12T10:15:30.000Z'));
const projectKind = unwrap(parseEntityKind('project'));
const documentKind = unwrap(parseEntityKind('document'));

const createdEvent: DomainEventEnvelope<{ name: string }> = {
  kind: 'event',
  eventName: unwrap(parseEventName('projects.projectCreated')),
  scope: { kind: 'project', tenantId, projectId },
  actor: { kind: 'user', actorId: userId },
  source: 'domain',
  causality: { correlationId, causationId: null },
  schemaVersion: '1.0.0',
  occurredAt,
  entityRefs: {
    before: null,
    after: { entityKind: projectKind, entityId: projectEntityId },
  },
  payload: { name: 'Riverside Tower' },
};

describe('domain event envelope (freeze A3)', () => {
  it('round-trips a creation event through JSON', () => {
    roundTrip(createdEvent, parseDomainEventEnvelope);
  });

  it('round-trips update (before/after) and archive (after = null) variants', () => {
    const entityRef: EntityRef = { entityKind: projectKind, entityId: projectEntityId };
    const renamed: DomainEventEnvelope<{ name: string }> = {
      ...createdEvent,
      eventName: unwrap(parseEventName('projects.projectRenamed')),
      causality: { correlationId, causationId },
      entityRefs: { before: entityRef, after: entityRef },
      payload: { name: 'Riverside Tower Phase 2' },
    };
    roundTrip(renamed, parseDomainEventEnvelope);
    const archived: DomainEventEnvelope<Record<string, never>> = {
      ...createdEvent,
      eventName: unwrap(parseEventName('projects.projectArchived')),
      entityRefs: { before: entityRef, after: null },
      payload: {},
    };
    roundTrip(archived, parseDomainEventEnvelope);
  });

  it('round-trips adapter-sourced and system-actor events', () => {
    const imported: DomainEventEnvelope<{ batch: string }> = {
      ...createdEvent,
      eventName: unwrap(parseEventName('documents.documentImported')),
      actor: { kind: 'adapter', actorId: formatEntityId({ version: 'v1', opaque: USER_OPAQUE }) },
      source: 'adapter',
      entityRefs: {
        before: null,
        after: {
          entityKind: documentKind,
          entityId: formatEntityId({ version: 'v1', opaque: PROJECT_REF_OPAQUE }),
        },
      },
      payload: { batch: 'nightly-sync-2026-09-12' },
    };
    roundTrip(imported, parseDomainEventEnvelope);
    const purged: DomainEventEnvelope<Record<string, never>> = {
      ...createdEvent,
      eventName: unwrap(parseEventName('retention.candidatesPurged')),
      scope: { kind: 'tenant', tenantId },
      actor: { kind: 'system' },
      source: 'system',
      entityRefs: { before: null, after: null },
      payload: {},
    };
    roundTrip(purged, parseDomainEventEnvelope);
  });

  it('type-guards event envelopes', () => {
    expect(isDomainEventEnvelope(JSON.parse(JSON.stringify(createdEvent)) as unknown)).toBe(true);
    expect(isDomainEventEnvelope({ kind: 'event' })).toBe(false);
    expect(isDomainEventEnvelope(42)).toBe(false);
  });

  it('fails closed on unknown schema versions', () => {
    const raw = JSON.parse(JSON.stringify(createdEvent)) as Record<string, unknown>;
    raw['schemaVersion'] = '9.9.9';
    const result = parseDomainEventEnvelope(raw);
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
        name: 'missing eventName',
        mutate: (raw) => {
          delete raw['eventName'];
        },
        code: 'missing-field',
        path: 'eventName',
      },
      {
        name: 'invalid eventName',
        mutate: (raw) => {
          raw['eventName'] = 'Projects.Created';
        },
        code: 'invalid-value',
        path: 'eventName',
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
        name: 'invalid tenant id in scope',
        mutate: (raw) => {
          const scope = raw['scope'] as Record<string, unknown>;
          scope['tenantId'] = '12345';
        },
        code: 'invalid-value',
        path: 'scope.tenantId',
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
        name: 'unknown source',
        mutate: (raw) => {
          raw['source'] = 'cloud';
        },
        code: 'invalid-value',
        path: 'source',
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
        name: 'missing causationId',
        mutate: (raw) => {
          const causality = raw['causality'] as Record<string, unknown>;
          delete causality['causationId'];
        },
        code: 'missing-field',
        path: 'causality.causationId',
      },
      {
        name: 'missing occurredAt',
        mutate: (raw) => {
          delete raw['occurredAt'];
        },
        code: 'missing-field',
        path: 'occurredAt',
      },
      {
        name: 'space instead of T in occurredAt',
        mutate: (raw) => {
          raw['occurredAt'] = '2026-09-12 10:15:30Z';
        },
        code: 'invalid-value',
        path: 'occurredAt',
      },
      {
        name: 'missing entityRefs',
        mutate: (raw) => {
          delete raw['entityRefs'];
        },
        code: 'missing-field',
        path: 'entityRefs',
      },
      {
        name: 'malformed entityRefs.before',
        mutate: (raw) => {
          raw['entityRefs'] = { before: 'x' };
        },
        code: 'invalid-type',
        path: 'entityRefs.before',
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
        name: 'array payload',
        mutate: (raw) => {
          raw['payload'] = ['nope'];
        },
        code: 'invalid-type',
        path: 'payload',
      },
      {
        name: 'unknown envelope field',
        mutate: (raw) => {
          raw['eventId'] = 'external-123';
        },
        code: 'unknown-field',
        path: 'eventId',
      },
      {
        name: 'wrong kind',
        mutate: (raw) => {
          raw['kind'] = 'event2';
        },
        code: 'invalid-value',
        path: 'kind',
      },
    ];
    for (const testCase of cases) {
      const raw = JSON.parse(JSON.stringify(createdEvent)) as Record<string, unknown>;
      testCase.mutate(raw);
      const result = parseDomainEventEnvelope(raw);
      expect(result.ok, `case: ${testCase.name}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code, `case: ${testCase.name} (code)`).toBe(testCase.code);
        expect(result.error.path, `case: ${testCase.name} (path)`).toBe(testCase.path);
      }
    }
  });
});

describe('causality', () => {
  it('round-trips root and caused causality', () => {
    roundTrip({ correlationId, causationId: null }, parseCausality);
    roundTrip({ correlationId, causationId }, parseCausality);
  });

  it('type-guards causality values', () => {
    expect(isCausality({ correlationId, causationId: null })).toBe(true);
    expect(isCausality({ correlationId })).toBe(false);
    expect(isCausality(42)).toBe(false);
  });

  it('rejects malformed correlation ids with nested paths', () => {
    const result = parseCausality({ correlationId: 'short', causationId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe('correlationId');
    }
  });
});

describe('event names and entity references', () => {
  it('parses canonical event names', () => {
    expect(unwrap(parseEventName('projects.projectCreated'))).toBe('projects.projectCreated');
    expect(unwrap(parseEventName('cost.budgetLineItem.updated'))).toBe(
      'cost.budgetLineItem.updated',
    );
    expect(unwrap(parseEventName('a.b'))).toBe('a.b');
    expect(isEventName('Projects.Created')).toBe(false);
    expect(isEventName('created')).toBe(false);
    expect(isEventName('projects..created')).toBe(false);
    expect(isEventName(42)).toBe(false);
  });

  it('round-trips entity references', () => {
    roundTrip({ entityKind: 'project', entityId: projectEntityId }, parseEntityRef);
    roundTrip(
      { before: null, after: { entityKind: 'project', entityId: projectEntityId } },
      parseEntityRefs,
    );
    roundTrip(
      { before: { entityKind: 'project', entityId: projectEntityId }, after: null },
      parseEntityRefs,
    );
  });
});
