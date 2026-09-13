import { describe, expect, it } from 'vitest';
import { parseLedgerEventId } from '@office/events';
import {
  canonicalEvidence,
  compareSourceEventReferences,
  isImpactQuery,
  parseCurrencyCode,
  parseImpactQuery,
} from './model';
import type { SourceEventReference } from './model';
import { isAssessmentId, parseAssessmentId } from './vocabulary';

// OFF-014 model surface — total, fail-closed parsers (strict keys, branded
// grammars) and the canonical evidence ordering that makes every
// assessment's traceability spine deterministic.

const EVENT_ID_A = parseLedgerEventId('office-evt-v1-aaaaaaaaaaaaaaaa0000000000000000');
const EVENT_ID_B = parseLedgerEventId('office-evt-v1-bbbbbbbbbbbbbbbb0000000000000000');
const EVENT_ID_C = parseLedgerEventId('office-evt-v1-cccccccccccccccc0000000000000000');
if (!EVENT_ID_A.ok || !EVENT_ID_B.ok || !EVENT_ID_C.ok) {
  throw new Error('test fixture ledger event ids failed to parse');
}

const reference = (
  eventId: SourceEventReference['eventId'],
  eventName: string,
): SourceEventReference => ({
  eventId,
  eventName: eventName as SourceEventReference['eventName'],
  occurredAt: '2026-09-12T08:00:00.000Z' as SourceEventReference['occurredAt'],
});

describe('parseImpactQuery (OFF-014)', () => {
  it('parses a canonical query and round-trips it', () => {
    const sourceEventId = EVENT_ID_A.value;
    const result = parseImpactQuery({ sourceEventId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual({ sourceEventId });
      expect(isImpactQuery({ sourceEventId })).toBe(true);
    }
  });

  it('rejects unknown fields (strict keys)', () => {
    const result = parseImpactQuery({
      sourceEventId: EVENT_ID_A.value,
      extra: 'no',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-field');
      expect(result.error.path).toBe('extra');
    }
    expect(isImpactQuery({ sourceEventId: EVENT_ID_A.value, extra: 'no' })).toBe(false);
  });

  it('rejects a missing or invalid source event id (fail-closed)', () => {
    for (const raw of [{}, { sourceEventId: 'not-an-event-id' }, null, 42, []]) {
      const result = parseImpactQuery(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code.length).toBeGreaterThan(0);
      }
      expect(isImpactQuery(raw)).toBe(false);
    }
  });
});

describe('parseAssessmentId (OFF-014)', () => {
  it('accepts printable-ASCII tokens of 8..128 characters', () => {
    for (const raw of ['assessment-0001', 'a'.repeat(8), 'x'.repeat(128), 'tok.en-123_ABC']) {
      const result = parseAssessmentId(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(raw);
      expect(isAssessmentId(raw)).toBe(true);
    }
  });

  it('rejects short, whitespace, and non-string values (fail-closed)', () => {
    for (const raw of ['short', 'a'.repeat(7), 'x'.repeat(129), 'has space', '', null, 7]) {
      expect(parseAssessmentId(raw).ok).toBe(false);
      expect(isAssessmentId(raw)).toBe(false);
    }
  });
});

describe('parseCurrencyCode (OFF-014)', () => {
  it('accepts uppercase 3-letter ISO-4217-style codes', () => {
    for (const raw of ['USD', 'EUR', 'GBP', 'JPY']) {
      const result = parseCurrencyCode(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(raw);
    }
  });

  it('rejects lowercase, wrong-length, and non-string values (fail-closed)', () => {
    for (const raw of ['usd', 'US', 'USDD', 'US!', '', null, 3]) {
      const result = parseCurrencyCode(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid-value');
      }
    }
  });
});

describe('canonical evidence ordering (OFF-014)', () => {
  it('deduplicates by event id and orders by (eventName, eventId)', () => {
    const duplicated = reference(EVENT_ID_B.value, 'cost.costItemRecorded');
    const input = [
      reference(EVENT_ID_C.value, 'cost.budgetRevised'),
      duplicated,
      reference(EVENT_ID_A.value, 'contracts.changeOrderApproved'),
      duplicated,
    ];

    const canonical = canonicalEvidence(input);

    // One reference per EVENT (deduplicated by ledger event id), ordered by
    // event name first ('contracts.…' before 'cost.…'), then by event id.
    expect(canonical).toStrictEqual([
      reference(EVENT_ID_A.value, 'contracts.changeOrderApproved'),
      reference(EVENT_ID_C.value, 'cost.budgetRevised'),
      reference(EVENT_ID_B.value, 'cost.costItemRecorded'),
    ]);
    expect(canonical).toHaveLength(3);
  });

  it('compares by event name first, then event id', () => {
    const alpha = reference(EVENT_ID_C.value, 'a.event');
    const beta = reference(EVENT_ID_A.value, 'b.event');
    const beta2 = reference(EVENT_ID_B.value, 'b.event');
    expect(compareSourceEventReferences(alpha, beta)).toBeLessThan(0);
    expect(compareSourceEventReferences(beta, alpha)).toBeGreaterThan(0);
    expect(compareSourceEventReferences(beta, beta2)).toBeLessThan(0);
    expect(compareSourceEventReferences(beta, beta)).toBe(0);
  });

  it('keeps an empty evidence set empty (an assessment with no numbers)', () => {
    expect(canonicalEvidence([])).toStrictEqual([]);
  });
});
