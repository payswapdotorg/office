// OFF-036 security — the sensitive-action alert rule vocabulary suite.
//
// The typed rule descriptors the alert evaluation consumes are PURE DATA
// with a closed vocabulary: severities, matching kinds, the kebab-case rule
// identity grammar, and the threshold (integer >= 1). Parsing is total and
// fail-closed (strict keys — unknown fields are errors); the trusted
// builder throws loud TypeErrors; and the canonical default rule set
// covers every matching kind of the vocabulary with distinct rule ids.
import { describe, expect, it } from 'vitest';
import {
  ALERT_RULE_KINDS,
  ALERT_SEVERITIES,
  DEFAULT_SENSITIVE_ACTION_ALERT_RULES,
  defineAlertRule,
  isAlertRuleId,
  isAlertRuleKind,
  isAlertSeverity,
  isSensitiveActionAlertRule,
  parseAlertRuleId,
  parseAlertRuleKind,
  parseAlertSeverity,
  parseSensitiveActionAlertRule,
  expectFail,
  expectOk,
} from '../index';

describe('the alert rule vocabulary (OFF-036)', () => {
  it('declares the severities and matching kinds in vocabulary order', () => {
    expect([...ALERT_SEVERITIES]).toStrictEqual(['info', 'warning', 'critical']);
    expect([...ALERT_RULE_KINDS]).toStrictEqual([
      'denied-action-cluster',
      'cross-tenant-denial',
      'prohibited-class-attempt',
      'actor-kind-rejection',
      'revocation-activity',
      'sensitive-execution',
    ]);
  });

  it('parses severities and kinds total + fail-closed', () => {
    for (const severity of ALERT_SEVERITIES) {
      expect(expectOk(parseAlertSeverity(severity))).toBe(severity);
      expect(isAlertSeverity(severity)).toBe(true);
    }
    for (const kind of ALERT_RULE_KINDS) {
      expect(expectOk(parseAlertRuleKind(kind))).toBe(kind);
      expect(isAlertRuleKind(kind)).toBe(true);
    }
    expect(expectFail(parseAlertSeverity('loud')).code).toBe('invalid-value');
    expect(expectFail(parseAlertSeverity(1)).code).toBe('invalid-value');
    expect(expectFail(parseAlertRuleKind('happy-path')).code).toBe('invalid-value');
    expect(expectFail(parseAlertRuleKind(null)).code).toBe('invalid-value');
  });

  it('accepts only the kebab-case rule id grammar (fail-closed)', () => {
    expect(expectOk(parseAlertRuleId('cross-tenant-denials-critical'))).toBe(
      'cross-tenant-denials-critical',
    );
    expect(isAlertRuleId('a')).toBe(false);
    expect(isAlertRuleId('Has-Upper')).toBe(false);
    expect(isAlertRuleId('spaces in id')).toBe(false);
    expect(isAlertRuleId('trailing-')).toBe(false);
    expect(isAlertRuleId(42)).toBe(false);
    expect(expectFail(parseAlertRuleId('snake_case_rule')).code).toBe('invalid-value');
  });

  it('parses a full rule record (strict keys) and rejects malformed ones', () => {
    const rule = {
      ruleId: 'denied-action-cluster-warning',
      kind: 'denied-action-cluster',
      severity: 'warning',
      threshold: 3,
      description: 'A cluster of three or more typed denials was observed.',
    } as const;
    const parsed = expectOk(parseSensitiveActionAlertRule(rule));
    expect(parsed).toStrictEqual(rule);
    expect(isSensitiveActionAlertRule(rule)).toBe(true);

    // Unknown field (strict keys).
    expect(expectFail(parseSensitiveActionAlertRule({ ...rule, extra: 1 })).code).toBe(
      'unknown-field',
    );
    // Missing field.
    expect(expectFail(parseSensitiveActionAlertRule({ ...rule, threshold: undefined })).code).toBe(
      'missing-field',
    );
    // Bad kind / severity / threshold / description / ruleId.
    expect(
      expectFail(parseSensitiveActionAlertRule({ ...rule, kind: 'nope' })).code,
    ).toBe('invalid-value');
    expect(
      expectFail(parseSensitiveActionAlertRule({ ...rule, severity: 'loud' })).code,
    ).toBe('invalid-value');
    expect(expectFail(parseSensitiveActionAlertRule({ ...rule, threshold: 0 })).code).toBe(
      'invalid-value',
    );
    expect(expectFail(parseSensitiveActionAlertRule({ ...rule, threshold: 1.5 })).code).toBe(
      'invalid-value',
    );
    expect(expectFail(parseSensitiveActionAlertRule({ ...rule, description: '' })).code).toBe(
      'invalid-value',
    );
    expect(expectFail(parseSensitiveActionAlertRule({ ...rule, ruleId: 'X' })).code).toBe(
      'invalid-value',
    );
    expect(expectFail(parseSensitiveActionAlertRule('nope')).code).toBe('invalid-type');
    expect(expectFail(parseSensitiveActionAlertRule(null)).code).toBe('invalid-type');
  });

  it('defineAlertRule is the trusted path (loud TypeError, never a silent failure)', () => {
    expect(defineAlertRule({
      ruleId: 'custom-rule',
      kind: 'sensitive-execution',
      severity: 'info',
      threshold: 1,
      description: 'A custom sensitive-action rule.',
    })).toStrictEqual({
      ruleId: 'custom-rule',
      kind: 'sensitive-execution',
      severity: 'info',
      threshold: 1,
      description: 'A custom sensitive-action rule.',
    });
    expect(() => defineAlertRule({ ruleId: 'bad', kind: 'nope', severity: 'info', threshold: 1, description: 'x' })).toThrow(TypeError);
  });

  it('ships a canonical default rule set covering every matching kind (pure data)', () => {
    expect(DEFAULT_SENSITIVE_ACTION_ALERT_RULES.length).toBe(ALERT_RULE_KINDS.length);
    const kinds = DEFAULT_SENSITIVE_ACTION_ALERT_RULES.map((rule) => rule.kind);
    expect([...new Set(kinds)].sort()).toStrictEqual([...ALERT_RULE_KINDS].sort());
    const ids = DEFAULT_SENSITIVE_ACTION_ALERT_RULES.map((rule) => rule.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_SENSITIVE_ACTION_ALERT_RULES.every((rule) => rule.threshold >= 1)).toBe(true);
    // The platform's A12 watch fires at threshold 1, critical.
    const crossTenant = DEFAULT_SENSITIVE_ACTION_ALERT_RULES.find(
      (rule) => rule.kind === 'cross-tenant-denial',
    );
    expect(crossTenant?.severity).toBe('critical');
    expect(crossTenant?.threshold).toBe(1);
  });
});
