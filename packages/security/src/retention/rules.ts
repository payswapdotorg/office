// Office security — retention policy rules (OFF-036).
//
// The typed retention policy contracts: one rule binds an EVENT CLASS (the
// first dot-separated segment of a canonical event name — 'cost',
// 'documents', the platform audit areas 'actions'/'apps'/'agents'/'sync') to
// a RETENTION CLASS (how long events of that class are retained before they
// become eligible for expiry). Rules are PURE DATA: they carry no clock, no
// I/O, and — decisively — NO deletion. The pure retain/expire projection
// lives in evaluate.ts; actual deletion belongs to the runtime that owns the
// store, never to this package (the audit ledger is immutable — freeze A3).
//
// THE IMMUTABLE-AUDIT-TRAIL INVARIANT, enforced fail-closed at the rule-set
// boundary: a valid rule set must cover EVERY platform audit event class
// (actions/apps/agents/sync) and map each one to 'permanent' — the audit
// trail never expires and is never deleted. A rule set that maps an audit
// class to a finite retention class, or omits an audit class entirely, is a
// typed rejection, never a silent retention gap.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { AUDIT_EVENT_CLASSES } from '../audit-ledger';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  unknownKeyFailure,
} from '../parse';

// ----- the retention-class vocabulary --------------------------------------------------------

/**
 * Every retention class, in vocabulary order:
 *   - 'permanent'      — never expires (the audit trail, freeze A3);
 *   - 'regulatory-7y'  — retained 2557 days (7 years incl. leap days);
 *   - 'operational-90d'— retained 90 days.
 */
export const RETENTION_CLASSES = ['permanent', 'regulatory-7y', 'operational-90d'] as const;

/** One retention class (how long events of a class are retained). */
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Grammar description used in parse failures. */
export const RETENTION_CLASS_GRAMMAR = "'permanent' | 'regulatory-7y' | 'operational-90d'";

/** Parse an untrusted value as a RetentionClass (total, fail-closed). */
export function parseRetentionClass(raw: unknown): ParseResult<RetentionClass> {
  if (typeof raw !== 'string' || !(RETENTION_CLASSES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', RETENTION_CLASS_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as RetentionClass);
}

/** Type guard for valid RetentionClass values. */
export const isRetentionClass = (raw: unknown): raw is RetentionClass =>
  parseRetentionClass(raw).ok;

/**
 * The retention duration of each class in days ('permanent' carries null —
 * no expiry is ever computed). Pure data; the projection in evaluate.ts
 * consumes it.
 */
export const RETENTION_CLASS_DAYS: Readonly<Record<RetentionClass, number | null>> = {
  permanent: null,
  'regulatory-7y': 2557,
  'operational-90d': 90,
};

// ----- the event-class grammar ---------------------------------------------------------------

/** Grammar description used in parse failures. */
export const EVENT_CLASS_GRAMMAR =
  "lowercase-initial event-name area (the first dot-separated segment of a canonical event name), e.g. 'cost'";

const EVENT_CLASS_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}$/;

/** Parse an untrusted value as an event class (total, fail-closed). */
export function parseEventClass(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string' || !EVENT_CLASS_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', EVENT_CLASS_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw);
}

/** Type guard for valid event classes. */
export const isEventClass = (raw: unknown): raw is string => parseEventClass(raw).ok;

// ----- the rule record ----------------------------------------------------------------------

/** One typed retention rule: an event class's retention class (pure data). */
export interface RetentionRule {
  /** The event class the rule governs (the event-name area). */
  readonly eventClass: string;
  /** How long events of the class are retained. */
  readonly retentionClass: RetentionClass;
}

const RETENTION_RULE_KEYS = ['eventClass', 'retentionClass'] as const;

const RETENTION_RULE_GRAMMAR =
  "RetentionRule: { eventClass: event-name area, retentionClass: RetentionClass }";

/** Parse an untrusted value as a RetentionRule (total, fail-closed, strict keys). */
export function parseRetentionRule(raw: unknown): ParseResult<RetentionRule> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RETENTION_RULE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RETENTION_RULE_KEYS, '', RETENTION_RULE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const eventClass = requireFieldWith(raw, 'eventClass', '', parseEventClass);
  if (!eventClass.ok) return eventClass;
  const retentionClass = requireFieldWith(raw, 'retentionClass', '', parseRetentionClass);
  if (!retentionClass.ok) return retentionClass;
  return parseOk(
    {
      eventClass: eventClass.value,
      retentionClass: retentionClass.value,
    } satisfies RetentionRule,
  );
}

/** Type guard for structurally valid RetentionRule values. */
export const isRetentionRule = (raw: unknown): raw is RetentionRule =>
  parseRetentionRule(raw).ok;

// ----- the rule set (the immutable-audit-trail invariant) ------------------------------------

/** One validated retention rule set: pure data satisfying every invariant. */
export interface RetentionRuleSet {
  /** The rules, in declaration order. */
  readonly rules: readonly RetentionRule[];
}

const RETENTION_RULE_SET_GRAMMAR =
  'RetentionRuleSet: { rules: RetentionRule[] } — no duplicate event classes; every audit event class (actions/apps/agents/sync) covered and mapped to permanent';

const auditClassFailure = (message: string): ParseResult<never> =>
  parseFail('invalid-value', 'rules', 'the immutable-audit-trail retention invariant', message);

/**
 * Parse an untrusted value as a RetentionRuleSet (total, fail-closed, strict
 * keys): every rule parses, no event class is mapped twice, and — THE
 * immutable-audit-trail invariant — every platform audit event class is
 * covered and mapped to 'permanent' (the audit trail never expires).
 */
export function parseRetentionRuleSet(raw: unknown): ParseResult<RetentionRuleSet> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RETENTION_RULE_SET_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['rules'], '', RETENTION_RULE_SET_GRAMMAR);
  if (unknownKey) return unknownKey;
  const rulesRaw = raw['rules'];
  if (rulesRaw === undefined) {
    return parseFail('missing-field', 'rules', 'array of RetentionRule', 'undefined');
  }
  if (!Array.isArray(rulesRaw)) {
    return parseFail('invalid-type', 'rules', 'array of RetentionRule', describeValue(rulesRaw));
  }
  const rules: RetentionRule[] = [];
  const byClass = new Map<string, RetentionClass>();
  for (const [index, ruleRaw] of rulesRaw.entries()) {
    const rule = parseRetentionRule(ruleRaw);
    if (!rule.ok) {
      return parseFail(
        rule.error.code,
        `rules[${index}]${rule.error.path === '' ? '' : `.${rule.error.path}`}`,
        rule.error.expected,
        rule.error.received,
      );
    }
    if (byClass.has(rule.value.eventClass)) {
      return parseFail(
        'invalid-value',
        `rules[${index}].eventClass`,
        'each event class mapped exactly once',
        `duplicate event class '${rule.value.eventClass}'`,
      );
    }
    byClass.set(rule.value.eventClass, rule.value.retentionClass);
    rules.push(rule.value);
  }
  // THE immutable-audit-trail invariant: every audit class covered, permanent.
  for (const auditClass of AUDIT_EVENT_CLASSES) {
    const mapped = byClass.get(auditClass);
    if (mapped === undefined) {
      return auditClassFailure(
        `audit event class '${auditClass}' has no retention rule — the audit trail is immutable and every audit class must be covered`,
      );
    }
    if (mapped !== 'permanent') {
      return auditClassFailure(
        `audit event class '${auditClass}' is mapped to '${mapped}' — the audit trail is immutable and never expires (freeze A3)`,
      );
    }
  }
  return parseOk({ rules } satisfies RetentionRuleSet);
}

/** Type guard for structurally valid RetentionRuleSet values. */
export const isRetentionRuleSet = (raw: unknown): raw is RetentionRuleSet =>
  parseRetentionRuleSet(raw).ok;

/**
 * Compose a validated RetentionRuleSet (trusted path): validates the input
 * with the same fail-closed checks (including the immutable-audit-trail
 * invariant) and throws a loud TypeError instead of returning the failure.
 */
export function defineRetentionRuleSet(rules: readonly unknown[]): RetentionRuleSet {
  const result = parseRetentionRuleSet({ rules });
  if (!result.ok) {
    throw new TypeError(
      `invalid retention rule set: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}

// ----- the canonical rule set ----------------------------------------------------------------

/**
 * The canonical retention rule set (pure data): the four platform audit
 * classes are PERMANENT (the immutable audit trail — freeze A3), the
 * financial/contractual/evidence domain areas carry the 7-year regulatory
 * retention, and the operational areas carry the 90-day operational
 * retention. The pure retain/expire projection (evaluate.ts) consumes this;
 * NOTHING here (or there) deletes anything.
 */
export const DEFAULT_RETENTION_RULES: RetentionRuleSet = defineRetentionRuleSet([
  // The platform audit trail — immutable, permanent (freeze A3).
  { eventClass: 'actions', retentionClass: 'permanent' },
  { eventClass: 'apps', retentionClass: 'permanent' },
  { eventClass: 'agents', retentionClass: 'permanent' },
  { eventClass: 'sync', retentionClass: 'permanent' },
  // Financial, contractual, and evidence records — the regulatory horizon.
  { eventClass: 'cost', retentionClass: 'regulatory-7y' },
  { eventClass: 'procurement', retentionClass: 'regulatory-7y' },
  { eventClass: 'contracts', retentionClass: 'regulatory-7y' },
  { eventClass: 'documents', retentionClass: 'regulatory-7y' },
  // Operational records — the operational horizon.
  { eventClass: 'organization', retentionClass: 'operational-90d' },
  { eventClass: 'people', retentionClass: 'operational-90d' },
  { eventClass: 'projects', retentionClass: 'operational-90d' },
  { eventClass: 'models', retentionClass: 'operational-90d' },
  { eventClass: 'work', retentionClass: 'operational-90d' },
  { eventClass: 'schedule', retentionClass: 'operational-90d' },
  { eventClass: 'quality', retentionClass: 'operational-90d' },
  { eventClass: 'workflows', retentionClass: 'operational-90d' },
]);
