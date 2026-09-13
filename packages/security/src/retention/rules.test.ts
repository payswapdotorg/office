// OFF-036 security — the retention rule contract suite.
//
// The typed retention policy contracts are PURE DATA with fail-closed
// parsing: the retention-class vocabulary (with its day durations), the
// event-class grammar (the first dot-separated segment of a canonical event
// name), strict-keyed rule records, and THE immutable-audit-trail invariant
// enforced at the rule-set boundary — every platform audit event class
// (actions/apps/agents/sync) must be covered AND mapped to 'permanent' (the
// audit trail never expires, freeze A3). A rule set that maps an audit class
// to a finite class, omits one, or maps a class twice is a typed rejection.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_EVENT_CLASSES,
  DEFAULT_RETENTION_RULES,
  EVENT_CLASS_GRAMMAR,
  RETENTION_CLASSES,
  RETENTION_CLASS_DAYS,
  defineRetentionRuleSet,
  isEventClass,
  isRetentionClass,
  isRetentionRule,
  isRetentionRuleSet,
  parseEventClass,
  parseRetentionClass,
  parseRetentionRule,
  parseRetentionRuleSet,
  expectFail,
  expectOk,
} from '../index';

describe('the retention-class vocabulary (OFF-036)', () => {
  it('declares the classes in vocabulary order with their day durations', () => {
    expect([...RETENTION_CLASSES]).toStrictEqual(['permanent', 'regulatory-7y', 'operational-90d']);
    expect(RETENTION_CLASS_DAYS['permanent']).toBeNull();
    expect(RETENTION_CLASS_DAYS['regulatory-7y']).toBe(2557);
    expect(RETENTION_CLASS_DAYS['operational-90d']).toBe(90);
  });

  it('parses retention classes total + fail-closed', () => {
    for (const retentionClass of RETENTION_CLASSES) {
      expect(expectOk(parseRetentionClass(retentionClass))).toBe(retentionClass);
      expect(isRetentionClass(retentionClass)).toBe(true);
    }
    expect(expectFail(parseRetentionClass('forever')).code).toBe('invalid-value');
    expect(expectFail(parseRetentionClass(null)).code).toBe('invalid-value');
  });

  it('parses event classes total + fail-closed (the event-name area grammar)', () => {
    expect(expectOk(parseEventClass('cost'))).toBe('cost');
    expect(expectOk(parseEventClass('documents'))).toBe('documents');
    expect(isEventClass('actions')).toBe(true);
    expect(isEventClass('Cost')).toBe(false);
    expect(isEventClass('9cost')).toBe(false);
    expect(isEventClass('')).toBe(false);
    expect(isEventClass('cost-item')).toBe(false);
    expect(isEventClass(42)).toBe(false);
    expect(EVENT_CLASS_GRAMMAR).toContain('first dot-separated segment');
  });
});

describe('the retention rule records (OFF-036)', () => {
  it('parses a rule (strict keys) and rejects malformed ones', () => {
    const rule = { eventClass: 'cost', retentionClass: 'regulatory-7y' } as const;
    expect(expectOk(parseRetentionRule(rule))).toStrictEqual(rule);
    expect(isRetentionRule(rule)).toBe(true);
    expect(expectFail(parseRetentionRule({ ...rule, extra: 1 })).code).toBe('unknown-field');
    expect(expectFail(parseRetentionRule({ eventClass: 'cost' })).code).toBe('missing-field');
    expect(expectFail(parseRetentionRule({ ...rule, retentionClass: 'forever' })).code).toBe(
      'invalid-value',
    );
    expect(expectFail(parseRetentionRule({ ...rule, eventClass: 'Cost' })).code).toBe(
      'invalid-value',
    );
    expect(expectFail(parseRetentionRule('nope')).code).toBe('invalid-type');
  });

  it('THE immutable-audit-trail invariant: audit classes must be covered and permanent', () => {
    // A minimal VALID set: all four audit classes, permanent.
    const valid = {
      rules: AUDIT_EVENT_CLASSES.map((eventClass) => ({
        eventClass,
        retentionClass: 'permanent',
      })),
    };
    expect(isRetentionRuleSet(valid)).toBe(true);
    expect(expectOk(parseRetentionRuleSet(valid)).rules.length).toBe(4);

    // An audit class mapped to a FINITE class is a typed rejection.
    const finite = expectFail(
      parseRetentionRuleSet({
        rules: [
          ...AUDIT_EVENT_CLASSES.slice(1).map((eventClass) => ({
            eventClass,
            retentionClass: 'permanent',
          })),
          { eventClass: AUDIT_EVENT_CLASSES[0], retentionClass: 'regulatory-7y' },
        ],
      }),
    );
    expect(finite.code).toBe('invalid-value');
    expect(finite.expected).toContain('immutable-audit-trail');

    // A MISSING audit class is a typed rejection.
    const missing = expectFail(
      parseRetentionRuleSet({
        rules: AUDIT_EVENT_CLASSES.slice(1).map((eventClass) => ({
          eventClass,
          retentionClass: 'permanent',
        })),
      }),
    );
    expect(missing.code).toBe('invalid-value');
    expect(missing.received).toContain(AUDIT_EVENT_CLASSES[0] ?? '');

    // A duplicate event class is a typed rejection.
    const duplicate = expectFail(
      parseRetentionRuleSet({
        rules: [
          ...AUDIT_EVENT_CLASSES.map((eventClass) => ({
            eventClass,
            retentionClass: 'permanent',
          })),
          { eventClass: 'actions', retentionClass: 'permanent' },
        ],
      }),
    );
    expect(duplicate.code).toBe('invalid-value');
    expect(duplicate.path).toBe('rules[4].eventClass');

    // Non-audit classes may map to finite retention.
    expect(
      expectOk(
        parseRetentionRuleSet({
          rules: [
            ...AUDIT_EVENT_CLASSES.map((eventClass) => ({
              eventClass,
              retentionClass: 'permanent',
            })),
            { eventClass: 'cost', retentionClass: 'operational-90d' },
          ],
        }),
      ).rules.length,
    ).toBe(5);
  });

  it('defineRetentionRuleSet is the trusted path (loud TypeError)', () => {
    // The immutable-audit-trail invariant: every audit class must be covered.
    const completeSet = [
      { eventClass: 'actions', retentionClass: 'permanent' },
      { eventClass: 'apps', retentionClass: 'permanent' },
      { eventClass: 'agents', retentionClass: 'permanent' },
      { eventClass: 'sync', retentionClass: 'permanent' },
    ];
    expect(defineRetentionRuleSet(completeSet)).toStrictEqual({ rules: completeSet });
    expect(() => defineRetentionRuleSet([{ eventClass: 'apps', retentionClass: 'operational-90d' }])).toThrow(
      TypeError,
    );
  });

  it('ships a canonical default rule set satisfying every invariant (pure data)', () => {
    expect(isRetentionRuleSet(DEFAULT_RETENTION_RULES)).toBe(true);
    const byClass = new Map(
      DEFAULT_RETENTION_RULES.rules.map((rule) => [rule.eventClass, rule.retentionClass]),
    );
    for (const auditClass of AUDIT_EVENT_CLASSES) {
      expect(byClass.get(auditClass)).toBe('permanent');
    }
    // The canonical horizon mix: financial/contractual/evidence areas carry
    // the regulatory class, operational areas the operational class.
    expect(byClass.get('cost')).toBe('regulatory-7y');
    expect(byClass.get('contracts')).toBe('regulatory-7y');
    expect(byClass.get('documents')).toBe('regulatory-7y');
    expect(byClass.get('procurement')).toBe('regulatory-7y');
    expect(byClass.get('work')).toBe('operational-90d');
    expect(byClass.get('projects')).toBe('operational-90d');
  });
});
