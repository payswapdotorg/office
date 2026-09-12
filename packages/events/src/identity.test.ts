import { describe, expect, it } from 'vitest';
import {
  parseCausationId,
  parseCorrelationId,
  parseEntityId,
  parseEntityKind,
  parseTenantId,
} from '@office/contracts';
import type { EntityRef, IdParts, ParseResult, TenantId } from '@office/contracts';
import {
  CONSUMER_NAME_GRAMMAR,
  LEDGER_EVENT_ID_GRAMMAR,
  causationIdOf,
  formatLedgerEventId,
  isConsumerName,
  isLedgerEventId,
  isLedgerSequence,
  ledgerEventIdOf,
  parseConsumerName,
  parseLedgerEventId,
  parseLedgerSequence,
} from './identity';
import type { LedgerKey, LedgerSequence } from './identity';

// OFF-005 identity contract — deterministic unit tests (no database): the
// ledger event id grammar + deterministic derivation, the causation
// re-branding bridge, ledger sequence bounds, and consumer name grammar.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const OTHER_TENANT: TenantId = unwrap(
  parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160f5e4d3c2b1a0'),
);
const AGGREGATE: EntityRef = {
  entityKind: unwrap(parseEntityKind('schedule-activity')),
  entityId: unwrap(parseEntityId('office-ent-v1-0123456789abcdef0123456789abcdef')),
};
const OTHER_AGGREGATE: EntityRef = {
  entityKind: AGGREGATE.entityKind,
  entityId: unwrap(parseEntityId('office-ent-v1-ffffffffffffffffffffffffffffffff')),
};

const sequence = (value: number): LedgerSequence => unwrap(parseLedgerSequence(value));

const keyOf = (over: Partial<LedgerKey>): LedgerKey => ({
  tenantId: TENANT,
  aggregate: AGGREGATE,
  sequence: sequence(1),
  ...over,
});

describe('parseLedgerEventId', () => {
  it('accepts the derived ledger event id shape', () => {
    const id = ledgerEventIdOf(keyOf({}));
    expect(id).toMatch(/^office-evt-v1-[0-9a-f]{32}$/);
    expect(unwrap(parseLedgerEventId(id))).toBe(id);
    expect(isLedgerEventId(id)).toBe(true);
  });

  it('rejects malformed ids fail-closed', () => {
    for (const raw of [
      null,
      undefined,
      42,
      '',
      'office-evt-v1-',
      'office-evt-v2-0123456789abcdef0123456789abcdef',
      'office-ent-v1-0123456789abcdef0123456789abcdef',
      'office-evt-v1-0123456789ABCDEF0123456789ABCDEF',
      'office-evt-v1-short',
      `office-evt-v1-${'a'.repeat(65)}`,
    ]) {
      const result = parseLedgerEventId(raw);
      expect(result.ok, `expected failure for ${String(raw)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.expected).toBe(LEDGER_EVENT_ID_GRAMMAR);
      }
      expect(isLedgerEventId(raw)).toBe(false);
    }
  });
});

describe('formatLedgerEventId', () => {
  it('composes valid parts and rejects invalid ones loudly', () => {
    expect(formatLedgerEventId({ version: 'v1', opaque: 'a'.repeat(16) })).toBe(
      `office-evt-v1-${'a'.repeat(16)}`,
    );
    expect(() =>
      formatLedgerEventId({ version: 'v2', opaque: 'a'.repeat(16) } as unknown as IdParts),
    ).toThrow(TypeError);
    expect(() => formatLedgerEventId({ version: 'v1', opaque: 'short' })).toThrow(TypeError);
    expect(() => formatLedgerEventId({ version: 'v1', opaque: 'UPPERCASE123456' })).toThrow(
      TypeError,
    );
  });
});

describe('ledgerEventIdOf (deterministic derivation)', () => {
  it('is pure: the same ledger key always derives the same id', () => {
    const key = keyOf({ sequence: sequence(7) });
    expect(ledgerEventIdOf(key)).toBe(ledgerEventIdOf(key));
  });

  it('derives distinct ids for distinct keys', () => {
    const ids = new Set(
      [1, 2, 3].map((value) => ledgerEventIdOf(keyOf({ sequence: sequence(value) }))),
    );
    expect(ids.size).toBe(3);
    expect(ledgerEventIdOf(keyOf({ tenantId: OTHER_TENANT }))).not.toBe(ledgerEventIdOf(keyOf({})));
    expect(ledgerEventIdOf(keyOf({ aggregate: OTHER_AGGREGATE }))).not.toBe(
      ledgerEventIdOf(keyOf({})),
    );
  });

  it('produces ids that are valid CausationIds (the causation bridge)', () => {
    const id = ledgerEventIdOf(keyOf({}));
    expect(parseCausationId(id).ok).toBe(true);
    expect(unwrap(parseCorrelationId(id))).toBe(id);
  });
});

describe('causationIdOf', () => {
  it('re-brands valid tokens (ledger ids, idempotency keys) as CausationIds', () => {
    const id = ledgerEventIdOf(keyOf({}));
    const causation = causationIdOf(id);
    expect(parseCausationId(causation).ok).toBe(true);
    expect(causation).toBe(id);
    expect(causationIdOf('idem-key-00000001')).toBe('idem-key-00000001');
  });

  it('throws a loud TypeError for invalid tokens', () => {
    for (const raw of ['', 'short', 'has whitespace in it', 'ümlaut-token-üüüü']) {
      expect(() => causationIdOf(raw), `expected throw for ${JSON.stringify(raw)}`).toThrow(
        TypeError,
      );
    }
  });
});

describe('parseLedgerSequence', () => {
  it('accepts safe positive integers and rejects everything else', () => {
    expect(unwrap(parseLedgerSequence(1))).toBe(1);
    expect(unwrap(parseLedgerSequence(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    for (const raw of [
      null,
      undefined,
      '1',
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(parseLedgerSequence(raw).ok, `expected failure for ${String(raw)}`).toBe(false);
      expect(isLedgerSequence(raw)).toBe(false);
    }
  });
});

describe('parseConsumerName', () => {
  it('accepts 1..6 lowercase dotted segments', () => {
    for (const raw of ['audit', 'projections.projects', 'intelligence.margin.impact']) {
      expect(unwrap(parseConsumerName(raw))).toBe(raw);
      expect(isConsumerName(raw)).toBe(true);
    }
  });

  it('rejects malformed names fail-closed', () => {
    for (const raw of [
      null,
      42,
      '',
      'Audit',
      '1audit',
      '.audit',
      'audit.',
      'projections..projects',
      `a.${'b'.repeat(40)}`,
    ]) {
      const result = parseConsumerName(raw);
      expect(result.ok, `expected failure for ${String(raw)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.expected).toBe(CONSUMER_NAME_GRAMMAR);
      }
      expect(isConsumerName(raw)).toBe(false);
    }
  });
});
