// OFF-036 security — the access-review model acceptance suite.
//
// The typed vocabulary the derived reviews are built from: the closed
// finding-kind and decision vocabularies (fail-closed parsing, unknown
// values typed-rejected), the derived access-review identity grammar (same
// review inputs always map to the same id — the A7 discipline's identity
// half), and the stable subject/scope keys the derivation orders by.
import { describe, expect, it } from 'vitest';
import {
  ACCESS_REVIEW_DECISIONS,
  ACCESS_REVIEW_FINDING_KINDS,
  accessReviewIdOf,
  isAccessReviewId,
  parseAccessReviewDecision,
  parseAccessReviewFindingKind,
  parseAccessReviewId,
  scopeKeyOf,
  subjectKeyOf,
  AGENT,
  TENANT_A,
  TENANT_B,
  PROJECT_1,
  actorOf,
  appActorOf,
  APP_ID_A,
  projectOneScope,
  tenantAScope,
  expectFail,
  expectOk,
} from '../index';

describe('the access-review vocabularies (OFF-036)', () => {
  it('declares the closed finding-kind vocabulary in order', () => {
    expect([...ACCESS_REVIEW_FINDING_KINDS]).toStrictEqual([
      'capability-in-use',
      'capability-unused',
      'denied-actions-observed',
      'cross-tenant-denials-observed',
      'capability-revocation-observed',
      'no-audit-evidence',
    ]);
  });

  it('declares the closed decision vocabulary in order', () => {
    expect([...ACCESS_REVIEW_DECISIONS]).toStrictEqual(['approved', 'revoked', 'escalated']);
  });

  it('parses every finding kind and decision (total, fail-closed)', () => {
    for (const kind of ACCESS_REVIEW_FINDING_KINDS) {
      expect(expectOk(parseAccessReviewFindingKind(kind))).toBe(kind);
    }
    for (const decision of ACCESS_REVIEW_DECISIONS) {
      expect(expectOk(parseAccessReviewDecision(decision))).toBe(decision);
    }
    const badKind = expectFail(parseAccessReviewFindingKind('capability-exploded'));
    expect(badKind.code).toBe('invalid-value');
    expect(expectFail(parseAccessReviewFindingKind(42)).code).toBe('invalid-value');
    expect(expectFail(parseAccessReviewDecision('maybe')).code).toBe('invalid-value');
    expect(expectFail(parseAccessReviewDecision(null)).code).toBe('invalid-value');
  });
});

describe('the derived access-review identity (OFF-036, A7)', () => {
  it('accepts only the canonical id grammar (fail-closed)', () => {
    expect(expectOk(parseAccessReviewId('office-rev-v1-0123456789abcdef0123456789abcdef'))).toBe(
      'office-rev-v1-0123456789abcdef0123456789abcdef',
    );
    expect(isAccessReviewId('office-rev-v1-0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isAccessReviewId('office-rev-v1-SHORT')).toBe(false);
    expect(isAccessReviewId('office-alt-v1-0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isAccessReviewId('nope')).toBe(false);
    expect(isAccessReviewId(1234)).toBe(false);
    expect(expectFail(parseAccessReviewId('office-rev-v1-UPPERCASE0123456789abcdef')).code).toBe(
      'invalid-value',
    );
  });

  it('derives the SAME id for the SAME review inputs (deterministic)', () => {
    const subject = {
      kind: 'installation-subject',
      installationId: APP_ID_A,
      appId: 'field-progress-tracker',
      tenantId: TENANT_A,
    } as const;
    const first = accessReviewIdOf({
      subject,
      scope: tenantAScope(),
      declaredCapabilities: ['work.read', 'work.write'],
    });
    const second = accessReviewIdOf({
      subject,
      scope: tenantAScope(),
      declaredCapabilities: ['work.read', 'work.write'],
    });
    expect(first).toBe(second);
    expect(isAccessReviewId(first)).toBe(true);
  });

  it('derives DISTINCT ids for distinct subjects, scopes, or declared baselines', () => {
    const subject = {
      kind: 'installation-subject',
      installationId: APP_ID_A,
      appId: 'field-progress-tracker',
      tenantId: TENANT_A,
    } as const;
    const base = accessReviewIdOf({
      subject,
      scope: tenantAScope(),
      declaredCapabilities: ['work.read', 'work.write'],
    });
    // A different declared baseline (order-insensitive — the derivation
    // sorts) maps to a different id; the same set in another order does not.
    expect(
      accessReviewIdOf({
        subject,
        scope: tenantAScope(),
        declaredCapabilities: ['work.write', 'work.read'],
      }),
    ).toBe(base);
    expect(
      accessReviewIdOf({ subject, scope: tenantAScope(), declaredCapabilities: ['work.read'] }),
    ).not.toBe(base);
    expect(
      accessReviewIdOf({
        subject,
        scope: projectOneScope(),
        declaredCapabilities: ['work.read', 'work.write'],
      }),
    ).not.toBe(base);
    expect(
      accessReviewIdOf({
        subject: { kind: 'actor-subject', actor: actorOf('agent', AGENT) },
        scope: tenantAScope(),
        declaredCapabilities: ['work.read', 'work.write'],
      }),
    ).not.toBe(base);
  });

  it('builds stable subject and scope keys (pure)', () => {
    expect(
      subjectKeyOf({ kind: 'actor-subject', actor: actorOf('agent', AGENT) }),
    ).toBe(`actor|agent|${AGENT}`);
    expect(subjectKeyOf({ kind: 'actor-subject', actor: actorOf('system') })).toBe('actor|system|');
    expect(
      subjectKeyOf({
        kind: 'installation-subject',
        installationId: APP_ID_A,
        appId: 'field-progress-tracker',
        tenantId: TENANT_A,
      }),
    ).toBe(`installation|${APP_ID_A}|field-progress-tracker|${TENANT_A}`);
    expect(scopeKeyOf(tenantAScope())).toBe(`scope|${TENANT_A}`);
    expect(scopeKeyOf(projectOneScope())).toBe(`scope|${TENANT_A}|${PROJECT_1}`);
    expect(scopeKeyOf(tenantAScope())).not.toBe(scopeKeyOf({ kind: 'tenant', tenantId: TENANT_B }));
    expect(appActorOf(APP_ID_A).kind).toBe('app');
  });
});
