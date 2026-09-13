// Office security — sensitive-action alert rules (OFF-036).
//
// The typed rule descriptors the alert evaluator consumes: one rule binds an
// alert rule id (stable, kebab-case — the vocabulary operators reference) to
// a MATCHING KIND over the recorded audit stream, a severity, and a
// threshold (how many matching audit events must be observed before the
// alert fires — a cluster of denials, a single cross-tenant attempt). Rules
// are PURE DATA: they carry no behavior, no clock, no I/O; the deterministic
// evaluation lives in evaluate.ts.
//
// Fail-closed: every field of an untrusted rule record parses through a
// total validator (strict keys, closed kind/severity vocabularies, threshold
// >= 1) — an alert rule can never enter the evaluator malformed. The trusted
// builder (defineAlertRule) throws loud TypeErrors instead.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  unknownKeyFailure,
} from '../parse';

// ----- the severity vocabulary -------------------------------------------------------------

/** Every alert severity, in vocabulary order. */
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;

/** One alert severity (how urgent the fired alert is). */
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Grammar description used in parse failures. */
export const ALERT_SEVERITY_GRAMMAR = "'info' | 'warning' | 'critical'";

/** Parse an untrusted value as an AlertSeverity (total, fail-closed). */
export function parseAlertSeverity(raw: unknown): ParseResult<AlertSeverity> {
  if (typeof raw !== 'string' || !(ALERT_SEVERITIES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', ALERT_SEVERITY_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as AlertSeverity);
}

/** Type guard for valid AlertSeverity values. */
export const isAlertSeverity = (raw: unknown): raw is AlertSeverity =>
  parseAlertSeverity(raw).ok;

// ----- the rule-kind vocabulary ------------------------------------------------------------

/**
 * Every sensitive-action alert rule kind, in vocabulary order. Each kind is a
 * pure matching predicate over one recorded audit event (see evaluate.ts):
 *   - 'denied-action-cluster'   — any typed denial (gateway or app runtime);
 *   - 'cross-tenant-denial'     — a denial of the A12 vocabulary (a
 *                                 cross-tenant or cross-project attempt);
 *   - 'prohibited-class-attempt'— a fail-closed classification rejection
 *                                 (unknown command / prohibited class);
 *   - 'actor-kind-rejection'    — the descriptor actor-kind gate fired;
 *   - 'revocation-activity'     — a revocation-family rejection (suspension,
 *                                 revocation, revoked grant);
 *   - 'sensitive-execution'     — an approval-class action that EXECUTED
 *                                 (a consequential mutation gated by an
 *                                 approval that completed).
 */
export const ALERT_RULE_KINDS = [
  'denied-action-cluster',
  'cross-tenant-denial',
  'prohibited-class-attempt',
  'actor-kind-rejection',
  'revocation-activity',
  'sensitive-execution',
] as const;

/** One sensitive-action alert rule kind (the closed matching vocabulary). */
export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number];

/** Grammar description used in parse failures. */
export const ALERT_RULE_KIND_GRAMMAR =
  "'denied-action-cluster' | 'cross-tenant-denial' | 'prohibited-class-attempt' | 'actor-kind-rejection' | 'revocation-activity' | 'sensitive-execution'";

/** Parse an untrusted value as an AlertRuleKind (total, fail-closed). */
export function parseAlertRuleKind(raw: unknown): ParseResult<AlertRuleKind> {
  if (typeof raw !== 'string' || !(ALERT_RULE_KINDS as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', ALERT_RULE_KIND_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as AlertRuleKind);
}

/** Type guard for valid AlertRuleKind values. */
export const isAlertRuleKind = (raw: unknown): raw is AlertRuleKind =>
  parseAlertRuleKind(raw).ok;

// ----- the rule identity grammar -----------------------------------------------------------

/** Grammar description used in parse failures. */
export const ALERT_RULE_ID_GRAMMAR =
  'lowercase kebab-case alert rule id (3..64 chars), e.g. cross-tenant-denials-critical';

const ALERT_RULE_ID_PATTERN = /^[a-z](?:[a-z0-9]-{0,1})*[a-z0-9]$/;

/** Parse an untrusted value as an alert rule id (total, fail-closed). */
export function parseAlertRuleId(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string' || !ALERT_RULE_ID_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', ALERT_RULE_ID_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw);
}

/** Type guard for valid alert rule ids. */
export const isAlertRuleId = (raw: unknown): boolean => parseAlertRuleId(raw).ok;

// ----- the rule record ---------------------------------------------------------------------

/** One typed sensitive-action alert rule (pure data — see the module comment). */
export interface SensitiveActionAlertRule {
  /** The rule's stable id (kebab-case — the vocabulary operators reference). */
  readonly ruleId: string;
  /** What the rule matches over the recorded audit stream. */
  readonly kind: AlertRuleKind;
  /** The severity of an alert this rule fires. */
  readonly severity: AlertSeverity;
  /** How many matching audit events must be observed before the alert fires. */
  readonly threshold: number;
  /** What the rule watches for (human-readable, deterministic). */
  readonly description: string;
}

const ALERT_RULE_KEYS = ['ruleId', 'kind', 'severity', 'threshold', 'description'] as const;

const ALERT_RULE_GRAMMAR =
  "SensitiveActionAlertRule: { ruleId: kebab id, kind: AlertRuleKind, severity: AlertSeverity, threshold: integer >= 1, description: string }";

/** Parse a threshold (integer >= 1, fail-closed). */
const parseThreshold = (raw: unknown): ParseResult<number> => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return parseFail('invalid-value', '', 'integer threshold >= 1', describeValue(raw));
  }
  return parseOk(raw);
};

/** Parse a description (non-empty string, fail-closed). */
const parseDescription = (raw: unknown): ParseResult<string> => {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 500) {
    return parseFail(
      'invalid-value',
      '',
      'non-empty description string (1..500 chars)',
      describeValue(raw),
    );
  }
  return parseOk(raw);
};

/** Parse an untrusted value as a SensitiveActionAlertRule (total, fail-closed, strict keys). */
export function parseSensitiveActionAlertRule(
  raw: unknown,
): ParseResult<SensitiveActionAlertRule> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ALERT_RULE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ALERT_RULE_KEYS, '', ALERT_RULE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const ruleId = requireFieldWith(raw, 'ruleId', '', parseAlertRuleId);
  if (!ruleId.ok) return ruleId;
  const kind = requireFieldWith(raw, 'kind', '', parseAlertRuleKind);
  if (!kind.ok) return kind;
  const severity = requireFieldWith(raw, 'severity', '', parseAlertSeverity);
  if (!severity.ok) return severity;
  const threshold = requireFieldWith(raw, 'threshold', '', parseThreshold);
  if (!threshold.ok) return threshold;
  const description = requireFieldWith(raw, 'description', '', parseDescription);
  if (!description.ok) return description;
  return parseOk(
    {
      ruleId: ruleId.value,
      kind: kind.value,
      severity: severity.value,
      threshold: threshold.value,
      description: description.value,
    } satisfies SensitiveActionAlertRule,
  );
}

/** Type guard for structurally valid SensitiveActionAlertRule values. */
export const isSensitiveActionAlertRule = (raw: unknown): raw is SensitiveActionAlertRule =>
  parseSensitiveActionAlertRule(raw).ok;

/**
 * Compose a validated SensitiveActionAlertRule (trusted path): validates the
 * input with the same fail-closed checks and throws a loud TypeError instead
 * of returning the failure.
 */
export function defineAlertRule(raw: unknown): SensitiveActionAlertRule {
  const result = parseSensitiveActionAlertRule(raw);
  if (!result.ok) {
    throw new TypeError(
      `invalid alert rule: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}

// ----- the canonical rule set ---------------------------------------------------------------

/**
 * The canonical sensitive-action alert rule set (pure data): every matching
 * kind of the vocabulary, one rule each, with the platform's default
 * severities and thresholds. Operators derive their own sets through
 * parseSensitiveActionAlertRule/defineAlertRule — this is the deterministic
 * reference the tests (and OFF-038's release gate) evaluate with.
 */
export const DEFAULT_SENSITIVE_ACTION_ALERT_RULES: readonly SensitiveActionAlertRule[] = [
  defineAlertRule({
    ruleId: 'cross-tenant-denials-critical',
    kind: 'cross-tenant-denial',
    severity: 'critical',
    threshold: 1,
    description: 'A cross-tenant or cross-project attempt was typed-rejected (A12).',
  }),
  defineAlertRule({
    ruleId: 'prohibited-class-attempts-critical',
    kind: 'prohibited-class-attempt',
    severity: 'critical',
    threshold: 1,
    description: 'An unknown or prohibited action was attempted (fail-closed classification).',
  }),
  defineAlertRule({
    ruleId: 'actor-kind-rejections-warning',
    kind: 'actor-kind-rejection',
    severity: 'warning',
    threshold: 1,
    description: 'An actor kind the action does not accept tried to execute it.',
  }),
  defineAlertRule({
    ruleId: 'revocation-activity-info',
    kind: 'revocation-activity',
    severity: 'info',
    threshold: 1,
    description: 'A suspended/revoked installation or revoked grant was probed (A7/A9).',
  }),
  defineAlertRule({
    ruleId: 'denied-action-cluster-warning',
    kind: 'denied-action-cluster',
    severity: 'warning',
    threshold: 3,
    description: 'A cluster of three or more typed denials was observed.',
  }),
  defineAlertRule({
    ruleId: 'sensitive-executions-info',
    kind: 'sensitive-execution',
    severity: 'info',
    threshold: 1,
    description: 'An approval-class consequential action executed (a completed approval).',
  }),
];
