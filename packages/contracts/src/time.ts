// Office canonical contracts — time (OFF-002).
//
// Timestamp: the canonical UTC instant string used by envelope fields
// (command issuedAt, event occurredAt). Grammar: RFC 3339 / ISO 8601 with
// the 'Z' designator only — 'YYYY-MM-DDTHH:mm:ss[.f…f]Z' with 1..9
// fractional digits accepted on parse; formatTimestamp always emits
// millisecond precision.
//
// Contracts expose no clock access: every function here is deterministic
// and tests use fixed instants. Validation is calendar-exact (month/day
// ranges, leap years) and does not depend on host Date parsing quirks.
import { describeValue, parseFail, parseOk } from './parse';
import type { ParseResult } from './parse';

declare const timestampBrand: unique symbol;

/** Canonical UTC RFC 3339 instant string (branded). */
export type Timestamp = string & { readonly [timestampBrand]: 'Timestamp' };

/** Shape description used in parse failures. */
export const TIMESTAMP_GRAMMAR =
  'YYYY-MM-DDTHH:mm:ss[.fff]Z — UTC RFC 3339 instant, 1..9 fractional digits';

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
};

/**
 * Parse an untrusted value as a Timestamp (total, fail-closed). Accepts
 * 1..9 fractional digits and requires the UTC 'Z' designator; the string is
 * returned verbatim (never rewritten) so serialization round-trips exactly.
 */
export function parseTimestamp(raw: unknown): ParseResult<Timestamp> {
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', TIMESTAMP_GRAMMAR, describeValue(raw));
  }
  const match = TIMESTAMP_PATTERN.exec(raw);
  if (match === null) {
    return parseFail('invalid-value', '', TIMESTAMP_GRAMMAR, describeValue(raw));
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const calendarValid =
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59;
  if (!calendarValid) {
    return parseFail('invalid-value', '', 'a valid UTC calendar instant', describeValue(raw));
  }
  return parseOk(raw as Timestamp);
}

/** Type guard for structurally valid Timestamp values. */
export function isTimestamp(raw: unknown): raw is Timestamp {
  return parseTimestamp(raw).ok;
}

/**
 * Format a Date into the canonical Timestamp form (UTC, millisecond
 * precision). Throws TypeError for an invalid Date and RangeError for dates
 * outside the representable ISO range — format is the trusted path.
 */
export function formatTimestamp(date: Date): Timestamp {
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError('formatTimestamp requires a valid Date');
  }
  return date.toISOString() as Timestamp;
}
