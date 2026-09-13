import { describe, expect, it } from 'vitest';
import {
  isEventSubscription,
  isEventSubscriptionFilter,
  parseEventSubscription,
  parseEventSubscriptionFilter,
} from './subscriptions';
import { unwrap } from './test-support';

// OFF-025 — event subscriptions: canonical event names (grammar-validated)
// plus TYPED filters. No wildcard predicates; no absent filter (explicit
// 'all' declaration instead).

const VALID_SUBSCRIPTION = {
  kind: 'event-subscription',
  eventName: 'work.progressRecorded',
  filter: { kind: 'entity-kind', entityKind: 'field-report' },
} as const;

describe('subscription filters (EventSubscriptionFilter)', () => {
  it('parses the explicit all-filter and the entity-kind filter', () => {
    expect(unwrap(parseEventSubscriptionFilter({ kind: 'all' }))).toStrictEqual({ kind: 'all' });
    expect(
      unwrap(parseEventSubscriptionFilter({ kind: 'entity-kind', entityKind: 'field-report' })),
    ).toStrictEqual({ kind: 'entity-kind', entityKind: 'field-report' });
    expect(isEventSubscriptionFilter({ kind: 'all' })).toBe(true);
  });

  it('rejects malformed and wildcard-shaped filters fail-closed', () => {
    for (const bad of [
      null,
      'all',
      {},
      { kind: 'wildcard' },
      { kind: '*' },
      { kind: 'all', entityKind: 'field-report' },
      { kind: 'entity-kind' },
      { kind: 'entity-kind', entityKind: 'Field Report' },
      { kind: 'entity-kind', entityKind: '' },
      { kind: 'entity-kind', entityKind: 7 },
      { kind: 'entity-kind', entityKind: 'field-report', extra: 1 },
    ]) {
      expect(parseEventSubscriptionFilter(bad).ok, `filter ${JSON.stringify(bad)}`).toBe(false);
      expect(isEventSubscriptionFilter(bad)).toBe(false);
    }
  });
});

describe('event subscriptions (EventSubscription)', () => {
  it('parses a valid subscription unchanged (both filter kinds)', () => {
    expect(unwrap(parseEventSubscription(VALID_SUBSCRIPTION))).toStrictEqual(VALID_SUBSCRIPTION);
    expect(
      unwrap(
        parseEventSubscription({
          kind: 'event-subscription',
          eventName: 'cost.budgetRevisionCommitted',
          filter: { kind: 'all' },
        }),
      ),
    ).toStrictEqual({
      kind: 'event-subscription',
      eventName: 'cost.budgetRevisionCommitted',
      filter: { kind: 'all' },
    });
    expect(isEventSubscription(VALID_SUBSCRIPTION)).toBe(true);
  });

  it('rejects malformed event names against the canonical grammar', () => {
    for (const bad of [
      'progressRecorded', // no dot-separated segments
      'work', // single segment
      'Work.ProgressRecorded', // uppercase segment start
      'work.progressRecorded.extra.deep.too.far.segments', // 7 segments
      'work.progress recorded', // whitespace
      '',
      42,
      null,
    ]) {
      const result = parseEventSubscription({
        kind: 'event-subscription',
        eventName: bad,
        filter: { kind: 'all' },
      });
      expect(result.ok, `event name ${JSON.stringify(bad)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.path).toBe('eventName');
      }
    }
  });

  it('requires an explicit filter (never a silent default)', () => {
    const result = parseEventSubscription({
      kind: 'event-subscription',
      eventName: 'work.progressRecorded',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing-field');
      expect(result.error.path).toBe('filter');
    }
  });

  it('rejects malformed subscriptions fail-closed (kind, strict keys)', () => {
    for (const bad of [
      null,
      [],
      'subscription',
      { ...VALID_SUBSCRIPTION, kind: 'subscription' },
      { ...VALID_SUBSCRIPTION, filter: null },
      { ...VALID_SUBSCRIPTION, filter: '*' },
      { ...VALID_SUBSCRIPTION, extra: 'hook' },
    ]) {
      expect(parseEventSubscription(bad).ok, `subscription ${JSON.stringify(bad)}`).toBe(false);
      expect(isEventSubscription(bad)).toBe(false);
    }
  });
});
