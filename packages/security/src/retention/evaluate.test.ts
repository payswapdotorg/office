// OFF-036 security — THE pure retention projection acceptance.
//
// evaluateRetention() projects a rule set over a stream of contract-valid
// event envelopes at a supplied instant: every event's class must be
// covered (a gap is a typed fail-closed rejection), the platform audit
// classes are PERMANENT (never expire — the immutable-audit-trail
// invariant), finite classes expire at occurredAt + the class's whole-day
// duration, and the decision is 'expire' exactly when a computed expiry is
// at or before the evaluated instant. NOTHING IS DELETED — the projection
// is pure data (the ledger's size is proven unchanged), the arithmetic is
// exact integer calendar math (leap years included), and it is
// deterministic run-twice.
import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import {
  DEFAULT_RETENTION_RULES,
  addDaysToTimestamp,
  domainEventOf,
  driveTenantIsolationProbes,
  evaluateRetention,
  expectFail,
  expectOk,
  makeConformanceHarness,
  retentionSummary,
} from '../index';

const at = (iso: string): Timestamp => expectOk(parseTimestamp(iso));

const DOMAIN_EVENTS = [
  domainEventOf('cost.costItemRecorded', { occurredAt: at('2026-01-15T08:00:00.000Z'), entityKind: 'cost-item' }),
  domainEventOf('contracts.changeEventCommitted', { occurredAt: at('2026-01-15T08:00:00.000Z'), entityKind: 'change-event' }),
  domainEventOf('work.progressRecorded', { occurredAt: at('2026-01-15T08:00:00.000Z'), entityKind: 'field-report' }),
  domainEventOf('projects.projectCreated', { occurredAt: at('2026-01-15T08:00:00.000Z'), entityKind: 'project' }),
] as const;

describe('the exact calendar arithmetic (OFF-036, pure)', () => {
  it('adds whole days exactly — ordinary years, leap years, month/year rollovers', () => {
    expect(expectOk(addDaysToTimestamp(at('2026-01-15T08:00:00.000Z'), 90))).toBe(
      '2026-04-15T08:00:00.000Z',
    );
    expect(expectOk(addDaysToTimestamp(at('2026-01-15T08:00:00.000Z'), 2557))).toBe(
      '2033-01-15T08:00:00.000Z',
    );
    // A leap February: 2028-02-29 + 365 days lands on 2029-02-28.
    expect(expectOk(addDaysToTimestamp(at('2028-02-29T12:30:45.250Z'), 365))).toBe(
      '2029-02-28T12:30:45.250Z',
    );
    // Year rollover and the non-leap 2100 (divisible by 100, not 400).
    expect(expectOk(addDaysToTimestamp(at('2026-12-31T23:59:59.999Z'), 1))).toBe(
      '2027-01-01T23:59:59.999Z',
    );
    expect(expectOk(addDaysToTimestamp(at('2100-02-28T00:00:00.000Z'), 1))).toBe(
      '2100-03-01T00:00:00.000Z',
    );
    // Adding zero days is the identity.
    expect(expectOk(addDaysToTimestamp(at('2026-01-15T08:00:00.000Z'), 0))).toBe(
      '2026-01-15T08:00:00.000Z',
    );
    // The time of day is preserved verbatim.
    expect(expectOk(addDaysToTimestamp(at('2026-06-01T13:14:15.678Z'), 30))).toBe(
      '2026-07-01T13:14:15.678Z',
    );
  });

  it('fails closed on an unrepresentable expiry (beyond the canonical timestamp range)', () => {
    const error = expectFail(addDaysToTimestamp(at('9999-12-31T00:00:00.000Z'), 365));
    expect(error.code).toBe('invalid-value');
    expect(error.path).toBe('');
  });
});

describe('THE pure retention projection (OFF-036)', () => {
  it('retains the platform audit trail permanently — the immutable-audit-trail invariant', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    // The REAL driven ledger: every recorded audit event is permanent.
    const ledgerSize = harness.ledger.size();
    const decisions = expectOk(
      evaluateRetention(
        DEFAULT_RETENTION_RULES,
        harness.ledger.events().map((event) => event.envelope),
        at('2150-01-01T00:00:00.000Z'),
      ),
    );
    expect(decisions.length).toBe(ledgerSize);
    expect(decisions.every((decision) => decision.retentionClass === 'permanent')).toBe(true);
    expect(decisions.every((decision) => decision.expiresAt === null)).toBe(true);
    expect(decisions.every((decision) => decision.action === 'retain')).toBe(true);
    // The projection deleted NOTHING (the ledger is immutable).
    expect(harness.ledger.size()).toBe(ledgerSize);
  });

  it('computes finite expiries from occurredAt + the class duration and flips at the instant', () => {
    const early = expectOk(evaluateRetention(DEFAULT_RETENTION_RULES, DOMAIN_EVENTS, at('2026-02-01T00:00:00.000Z')));
    expect(early.every((decision) => decision.action === 'retain')).toBe(true);
    expect(retentionSummary(early)).toStrictEqual({ total: 4, retain: 4, expire: 0, permanent: 0 });

    // 90 days after occurrence: the operational class expires at the
    // instant, the regulatory class is retained.
    const boundary = expectOk(
      evaluateRetention(DEFAULT_RETENTION_RULES, DOMAIN_EVENTS, at('2026-04-15T08:00:00.000Z')),
    );
    expect(boundary.map((decision) => [decision.eventClass, decision.action])).toStrictEqual([
      ['cost', 'retain'],
      ['contracts', 'retain'],
      ['work', 'expire'],
      ['projects', 'expire'],
    ]);
    expect(retentionSummary(boundary)).toStrictEqual({ total: 4, retain: 2, expire: 2, permanent: 0 });

    // One tick before the boundary the operational events are still retained.
    const beforeBoundary = expectOk(
      evaluateRetention(DEFAULT_RETENTION_RULES, DOMAIN_EVENTS, at('2026-04-15T07:59:59.999Z')),
    );
    expect(beforeBoundary.every((decision) => decision.action === 'retain')).toBe(true);

    // 2557 days after occurrence: the regulatory class expires too.
    const regulatory = expectOk(
      evaluateRetention(DEFAULT_RETENTION_RULES, DOMAIN_EVENTS, at('2033-01-15T08:00:00.000Z')),
    );
    expect(regulatory.every((decision) => decision.action === 'expire')).toBe(true);
    // The expiry instants themselves are the class durations after occurredAt.
    expect(regulatory[0]?.expiresAt).toBe('2033-01-15T08:00:00.000Z');
    expect(regulatory[2]?.expiresAt).toBe('2026-04-15T08:00:00.000Z');
  });

  it('typed-rejects an event class the rule set does not cover (fail-closed)', () => {
    const unmapped = domainEventOf('unknownarea.thingHappened', {
      occurredAt: at('2026-01-15T08:00:00.000Z'),
      entityKind: 'thing',
    });
    const error = expectFail(evaluateRetention(DEFAULT_RETENTION_RULES, [unmapped], at('2026-02-01T00:00:00.000Z')));
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('retention-class-unmapped');
    expect(error.details[0]?.message).toBe('unknownarea');
  });

  it('projects a mixed stream (audit trail + domain events) with the right per-class decisions', () => {
    const mixed = [
      domainEventOf('actions.actionExecuted', { occurredAt: at('2026-01-15T08:00:00.000Z') }),
      ...DOMAIN_EVENTS,
    ] as const;
    const decisions = expectOk(
      evaluateRetention(DEFAULT_RETENTION_RULES, mixed, at('2027-01-01T00:00:00.000Z')),
    );
    expect(decisions.map((decision) => [decision.eventName, decision.retentionClass, decision.action])).toStrictEqual([
      ['actions.actionExecuted', 'permanent', 'retain'],
      ['cost.costItemRecorded', 'regulatory-7y', 'retain'],
      ['contracts.changeEventCommitted', 'regulatory-7y', 'retain'],
      ['work.progressRecorded', 'operational-90d', 'expire'],
      ['projects.projectCreated', 'operational-90d', 'expire'],
    ]);
    expect(retentionSummary(decisions)).toStrictEqual({ total: 5, retain: 3, expire: 2, permanent: 1 });
  });

  it('is deterministic run-twice and deletes nothing (pure data over immutable inputs)', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    const events = harness.ledger.events().map((event) => event.envelope);
    const now = at('2033-06-01T00:00:00.000Z');
    const first = expectOk(evaluateRetention(DEFAULT_RETENTION_RULES, events, now));
    const second = expectOk(evaluateRetention(DEFAULT_RETENTION_RULES, events, now));
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(harness.ledger.size()).toBe(events.length);
  });
});
