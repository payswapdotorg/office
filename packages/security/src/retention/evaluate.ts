// Office security — the pure retention projection (OFF-036).
//
// evaluateRetention() projects a retention rule set over a stream of
// contract-valid event envelopes at a supplied instant ('now' — injected,
// never a wall clock) and returns, for every event, its PURE RETENTION
// DECISION: which retention class governs it, when (if ever) it expires, and
// whether it is retained or expired AT that instant. NOTHING IS DELETED —
// the projection is pure data over immutable inputs; actual deletion belongs
// to the runtime that owns the store, never to this package (the audit
// ledger is immutable — freeze A3, and the rule-set invariant already pins
// every audit class to 'permanent').
//
// Fail-closed: an event whose class has no rule in the set is a typed
// 'retention-class-unmapped' rejection — a retention policy gap is never a
// silent decision. Expiry instants are computed with EXACT integer calendar
// arithmetic (no Date object anywhere): the canonical timestamp grammar is
// parsed into (civil date, time-of-day) parts, whole days are added through
// the standard civil-date algorithms, and the result is re-validated through
// the contracts timestamp parser.
import { parseTimestamp } from '@office/contracts';
import type { DomainEventEnvelope, ParseResult, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { RETENTION_CLASS_DAYS } from './rules';
import type { RetentionClass, RetentionRuleSet } from './rules';

// ----- exact calendar arithmetic (pure, no Date) ---------------------------------------------

/** The parsed civil parts of one canonical timestamp. */
interface InstantParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const TIMESTAMP_PARTS_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Parse a contract-valid canonical timestamp into its civil parts (trusted
 * path — the value already satisfied the contracts grammar; a mismatch here
 * is a loud programming error, never a silent coercion).
 */
const instantPartsOf = (timestamp: Timestamp): InstantParts => {
  const match = TIMESTAMP_PARTS_PATTERN.exec(timestamp);
  if (match === null) {
    throw new TypeError(`timestamp does not match the canonical grammar: ${timestamp}`);
  }
  const fraction = match[7] ?? '0';
  const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3));
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    millisecond,
  };
};

/** Days since 1970-01-01 of a civil date (the standard proleptic algorithm). */
const daysFromCivil = (year: number, month: number, day: number): number => {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
};

/** The civil date of a days-since-epoch count (the inverse algorithm). */
const civilFromDays = (days: number): { readonly year: number; readonly month: number; readonly day: number } => {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPointer = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPointer + 2) / 5) + 1;
  const month = monthPointer + (monthPointer < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
};

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * Add whole days to a contract-valid canonical timestamp (pure, exact,
 * millisecond-precision output — the canonical formatTimestamp precision).
 * Fail-closed: an expiry beyond the representable timestamp range is a typed
 * parse failure, never a wrapped-around instant.
 */
export function addDaysToTimestamp(timestamp: Timestamp, days: number): ParseResult<Timestamp> {
  const parts = instantPartsOf(timestamp);
  const shifted = civilFromDays(daysFromCivil(parts.year, parts.month, parts.day) + days);
  const candidate = `${pad(shifted.year, 4)}-${pad(shifted.month, 2)}-${pad(shifted.day, 2)}T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(parts.millisecond, 3)}Z`;
  return parseTimestamp(candidate);
}

/** Is `left` at or before `right`? (pure, exact — civil parts compared lexicographically are chronologically ordered) */
const atOrBefore = (left: Timestamp, right: Timestamp): boolean => {
  const a = instantPartsOf(left);
  const b = instantPartsOf(right);
  const keys = [a.year, a.month, a.day, a.hour, a.minute, a.second, a.millisecond];
  const other = [b.year, b.month, b.day, b.hour, b.minute, b.second, b.millisecond];
  for (const [index, value] of keys.entries()) {
    const rhs = other[index] ?? 0;
    if (value !== rhs) return value < rhs;
  }
  return true;
};

// ----- the retention decision ----------------------------------------------------------------

/** The pure retention decision of one event under one rule set at one instant. */
export interface RetentionDecision {
  /** The event's canonical name. */
  readonly eventName: string;
  /** The event's class (its event-name area). */
  readonly eventClass: string;
  /** The event's occurred-at instant. */
  readonly occurredAt: Timestamp;
  /** The retention class governing the event's class. */
  readonly retentionClass: RetentionClass;
  /** When the event expires, or null when it is retained permanently. */
  readonly expiresAt: Timestamp | null;
  /** The decision at the evaluated instant: 'retain' or 'expire'. */
  readonly action: 'retain' | 'expire';
}

/** Deterministic totals over one projection's decisions. */
export interface RetentionSummary {
  /** How many events were projected. */
  readonly total: number;
  /** How many are retained. */
  readonly retain: number;
  /** How many are expired at the evaluated instant. */
  readonly expire: number;
  /** How many are permanent (no expiry ever). */
  readonly permanent: number;
}

/** Summarize one projection's decisions (pure, deterministic). */
export const retentionSummary = (
  decisions: readonly RetentionDecision[],
): RetentionSummary => ({
  total: decisions.length,
  retain: decisions.filter((decision) => decision.action === 'retain').length,
  expire: decisions.filter((decision) => decision.action === 'expire').length,
  permanent: decisions.filter((decision) => decision.retentionClass === 'permanent').length,
});

// ----- the projection -------------------------------------------------------------------------

/** The event class of a canonical event name (its first dot-separated segment). */
const eventClassOf = (eventName: string): string => (eventName as string).split('.')[0] ?? '';

/**
 * Project the retention rule set over a stream of contract-valid event
 * envelopes at `now` (pure, deterministic, NO deletion — see the module
 * comment): every event's class must be covered by the rule set (a gap is a
 * typed fail-closed rejection), the expiry instant of a finite retention
 * class is occurredAt + the class's whole-day duration, and the decision is
 * 'expire' exactly when a computed expiry is at or before `now`.
 */
export function evaluateRetention(
  ruleSet: RetentionRuleSet,
  events: readonly DomainEventEnvelope[],
  now: Timestamp,
): Result<readonly RetentionDecision[], DomainError> {
  const byClass = new Map<string, RetentionClass>(
    ruleSet.rules.map((rule) => [rule.eventClass, rule.retentionClass] as const),
  );
  const decisions: RetentionDecision[] = [];
  for (const event of events) {
    const eventClass = eventClassOf(event.eventName);
    const retentionClass = byClass.get(eventClass);
    if (retentionClass === undefined) {
      return fail(
        domainError(
          'invariant-violation',
          `event '${event.eventName}' belongs to class '${eventClass}', which the retention rule set does not cover — a retention policy gap is a typed failure, never a silent decision`,
          [{ code: 'retention-class-unmapped', message: eventClass, path: 'rules' }],
        ),
      );
    }
    const days = RETENTION_CLASS_DAYS[retentionClass];
    let expiresAt: Timestamp | null = null;
    if (days !== null) {
      const computed = addDaysToTimestamp(event.occurredAt, days);
      if (!computed.ok) {
        return fail(
          domainError(
            'invariant-violation',
            `the retention expiry of event '${event.eventName}' is not a representable canonical timestamp (class '${retentionClass}', ${days} days after ${event.occurredAt})`,
            [
              {
                code: 'retention-expiry-unrepresentable',
                message: `${retentionClass}+${days}d`,
                path: 'occurredAt',
              },
            ],
          ),
        );
      }
      expiresAt = computed.value;
    }
    decisions.push({
      eventName: event.eventName,
      eventClass,
      occurredAt: event.occurredAt,
      retentionClass,
      expiresAt,
      action: expiresAt !== null && atOrBefore(expiresAt, now) ? 'expire' : 'retain',
    });
  }
  return ok(decisions);
}
