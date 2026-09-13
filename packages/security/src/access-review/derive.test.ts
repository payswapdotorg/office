// OFF-036 security — THE access-review derivation acceptance (A7 + A12).
//
// reviewSubjectAccess() derives one typed AccessReview for a subject under
// a scope from the RECORDED audit trail — deterministically recomputed from
// events, never stored authoritatively here (freeze A7). This suite drives
// a REAL harness (the REAL gateway + REAL app runtime) to populate the
// ledger, then proves:
//   - the A12 GATE FIRST: a cross-tenant review query (an installation
//     subject of another tenant than the query scope) is a typed
//     'unauthorized'/'tenant-scope-violation' rejection BEFORE the ledger is
//     ever read; a structurally invalid scope is typed-rejected too;
//   - capabilities PROVEN held are the required capabilities of the
//     subject's EXECUTED gateway decisions (execution is the proof);
//   - the typed findings derive with full provenance (ledger event ids) and
//     the decision rule is deterministic (escalate-class findings win;
//     every declared capability unused — or no evidence at all — revokes;
//     otherwise approve);
//   - the derivation is pure over the ledger's current state (run-twice
//     deep-equal; a re-derivation over an unchanged ledger is identical).
import { describe, expect, it } from 'vitest';
import { actionProposal } from '@office/actions';
import {
  AGENT,
  APP_ID_A,
  SAMPLE_APP,
  TENANT_A,
  TENANT_B,
  actorOf,
  allowAllPolicy,
  appActorOf,
  commandEnvelopeOf,
  domainEventOf,
  driveTenantIsolationProbes,
  expectFail,
  expectOk,
  makeConformanceHarness,
  tenantAScope,
  tenantBScope,
} from '../index';
import { reviewSubjectAccess, observeAuditPayload } from '../index';

/** The tenant-A installation review subject fixture. */
const installationSubject = () =>
  ({
    kind: 'installation-subject',
    installationId: APP_ID_A,
    appId: SAMPLE_APP,
    tenantId: TENANT_A,
  }) as const;

describe('THE access-review derivation (OFF-036, A7/A12)', () => {
  it('derives a typed review from the recorded audit trail with full provenance', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    const review = expectOk(
      reviewSubjectAccess({
        subject: installationSubject(),
        scope: tenantAScope(),
        declaredCapabilities: ['work.read', 'work.write'],
        ledger: harness.ledger,
      }),
    );
    // The subject's own rejections are attributable to its 'app' actor;
    // every finding carries its ledger-event provenance.
    expect(review.subject).toStrictEqual(installationSubject());
    expect(review.scope).toStrictEqual(tenantAScope());
    expect(review.declaredCapabilities).toStrictEqual(['work.read', 'work.write']);
    const kinds = review.findings.map((finding) => finding.kind);
    expect(kinds).toContain('capability-unused');
    expect(kinds).toContain('denied-actions-observed');
    expect(kinds).toContain('cross-tenant-denials-observed');
    expect(review.decision).toBe('escalated');
    for (const finding of review.findings) {
      if (finding.kind === 'capability-unused') {
        expect(finding.evidence).toStrictEqual([]);
      } else {
        expect(finding.evidence.length).toBeGreaterThan(0);
        for (const entry of finding.evidence) {
          expect(entry.eventId).toMatch(/^office-evt-v1-[0-9a-f]{32}$/);
          expect(entry.eventName).toMatch(/^(actions|apps)\./);
        }
      }
    }
  });

  it('A12 GATE FIRST: a cross-tenant review query is typed-rejected before the ledger is read', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    // Tenant B's scope reviewing tenant A's installation: typed unauthorized.
    const error = expectFail(
      reviewSubjectAccess({
        subject: installationSubject(),
        scope: tenantBScope(),
        declaredCapabilities: ['work.read'],
        ledger: harness.ledger,
      }),
    );
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
    // And the mirrored direction: tenant A's scope reviewing tenant B's
    // installation subject.
    const mirrored = expectFail(
      reviewSubjectAccess({
        subject: {
          kind: 'installation-subject',
          installationId: harness.installations.b,
          appId: SAMPLE_APP,
          tenantId: TENANT_B,
        },
        scope: tenantAScope(),
        declaredCapabilities: ['work.read'],
        ledger: harness.ledger,
      }),
    );
    expect(mirrored.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('typed-rejects a structurally invalid query scope (fail-closed)', () => {
    const harness = makeConformanceHarness();
    const error = expectFail(
      reviewSubjectAccess({
        subject: installationSubject(),
        scope: { kind: 'galaxy' } as unknown as Parameters<typeof reviewSubjectAccess>[0]['scope'],
        declaredCapabilities: [],
        ledger: harness.ledger,
      }),
    );
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('invalid-review-scope');
  });

  it('proves capabilities HELD from EXECUTED gateway decisions (execution is the proof)', async () => {
    const harness = makeConformanceHarness();
    // One executed gateway decision under the user actor holding cost.read.
    const command = commandEnvelopeOf('cost.listCostItems', { key: harness.nextKey() });
    await harness.gateway.executeAction(
      actionProposal({
        command,
        subject: null,
        evidence: [],
        confidence: 'certain',
        resourceScope: null,
        approval: null,
      }),
      { policy: allowAllPolicy, capabilities: ['cost.read'] },
    );
    const review = expectOk(
      reviewSubjectAccess({
        subject: { kind: 'actor-subject', actor: actorOf('user') },
        scope: tenantAScope(),
        declaredCapabilities: ['cost.read', 'cost.write'],
        ledger: harness.ledger,
      }),
    );
    expect(review.provenCapabilities).toStrictEqual(['cost.read']);
    const inUse = review.findings.find((finding) => finding.kind === 'capability-in-use');
    expect(inUse?.capability).toBe('cost.read');
    expect(inUse?.evidence.length).toBe(1);
    expect(inUse?.evidence[0]?.eventName).toBe('actions.actionExecuted');
    const unused = review.findings.find((finding) => finding.kind === 'capability-unused');
    expect(unused?.capability).toBe('cost.write');
    // cost.read is in use, so the decision is not 'revoked'; no denials yet.
    expect(review.decision).toBe('approved');
  });

  it('revokes when every declared capability is unused (or there is no audit evidence at all)', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    // (a) A subject with NO audit evidence at all: the sole finding is
    //     'no-audit-evidence' and the decision is 'revoked'.
    const clean = expectOk(
      reviewSubjectAccess({
        subject: { kind: 'actor-subject', actor: actorOf('agent', AGENT) },
        scope: tenantAScope(),
        declaredCapabilities: ['work.read'],
        ledger: harness.ledger,
      }),
    );
    expect(clean.findings.map((finding) => finding.kind)).toStrictEqual(['no-audit-evidence']);
    expect(clean.decision).toBe('revoked');
    // (b) A subject with attributable evidence but NO executed decision and
    //     NO denial: every declared capability is unused — 'revoked'.
    const quiet = makeConformanceHarness();
    expectOk(
      quiet.ledger.append(
        domainEventOf('apps.appCommandDispatched', {
          scope: tenantAScope(),
          actor: appActorOf(APP_ID_A),
          payload: { decision: 'command-dispatched' },
        }),
      ),
    );
    const allUnused = expectOk(
      reviewSubjectAccess({
        subject: installationSubject(),
        scope: tenantAScope(),
        declaredCapabilities: ['work.read', 'work.write'],
        ledger: quiet.ledger,
      }),
    );
    expect(allUnused.findings.map((finding) => finding.kind)).toStrictEqual([
      'capability-unused',
      'capability-unused',
    ]);
    expect(allUnused.decision).toBe('revoked');
  });

  it('counts capability revocations observed as an escalate-class finding', async () => {
    const harness = makeConformanceHarness();
    // A grammar-only audit envelope of the revocation vocabulary.
    expectOk(
      harness.ledger.append(
        domainEventOf('apps.appCommandRejected', {
          scope: tenantAScope(),
          actor: appActorOf(APP_ID_A),
          payload: { decision: 'command-rejected', reason: 'capability-revoked' },
        }),
      ),
    );
    const review = expectOk(
      reviewSubjectAccess({
        subject: installationSubject(),
        scope: tenantAScope(),
        declaredCapabilities: [],
        ledger: harness.ledger,
      }),
    );
    expect(review.findings.map((finding) => finding.kind)).toContain(
      'capability-revocation-observed',
    );
    expect(review.decision).toBe('escalated');
  });

  it('is deterministic: deriving twice over the same ledger state produces deep-equal reviews', async () => {
    const harness = makeConformanceHarness();
    await driveTenantIsolationProbes(harness);
    const input = {
      subject: installationSubject(),
      scope: tenantAScope(),
      declaredCapabilities: ['work.read', 'work.write'],
      ledger: harness.ledger,
    } as const;
    const first = expectOk(reviewSubjectAccess(input));
    const second = expectOk(reviewSubjectAccess(input));
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('narrows audit payloads fail-closed (the observation vocabulary)', () => {
    expect(observeAuditPayload(null)).toStrictEqual({
      decision: null,
      denialCode: null,
      requiredCapabilities: [],
      actionClass: null,
    });
    expect(observeAuditPayload('nope')).toStrictEqual({
      decision: null,
      denialCode: null,
      requiredCapabilities: [],
      actionClass: null,
    });
    expect(observeAuditPayload({ decision: 'executed' })).toStrictEqual({
      decision: 'executed',
      denialCode: null,
      requiredCapabilities: [],
      actionClass: null,
    });
    expect(
      observeAuditPayload({ decision: 'denied', denialCode: 'no-allow-rule' }),
    ).toStrictEqual({
      decision: 'denied',
      denialCode: 'no-allow-rule',
      requiredCapabilities: [],
      actionClass: null,
    });
    expect(observeAuditPayload({ decision: 'command-rejected', reason: 'capability-revoked' })).toMatchObject(
      { denialCode: 'capability-revoked' },
    );
    expect(
      observeAuditPayload({
        decision: 'executed',
        requiredCapabilities: ['cost.read', 7, null],
        actionClass: 'approval-required',
      }),
    ).toMatchObject({ requiredCapabilities: ['cost.read'], actionClass: 'approval-required' });
  });
});
