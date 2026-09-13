// Office security — access-review derivation over the audit trail (OFF-036).
//
// reviewSubjectAccess() derives one typed AccessReview for a subject under
// a scope from the RECORDED audit trail (the A7 discipline: reviews are
// derived state — deterministically recomputed from events, never stored
// authoritatively here). The derivation:
//
//   1. A12 GATE FIRST: an installation subject of another tenant than the
//      query scope is a typed 'unauthorized' rejection ('tenant-scope-
//      violation') BEFORE the ledger is ever read — cross-tenant review
//      queries never see the foreign trail;
//   2. the subject's attributable events in scope are collected (the
//      envelope's actor identifies the subject — an installation reviews
//      under its own 'app' actor);
//   3. capabilities proven HELD are the required capabilities of the
//      subject's EXECUTED gateway decisions (the gateway only executes an
//      action when the actor holds every required capability — execution is
//      the proof);
//   4. findings: declared capabilities unused, denials observed, cross-
//      tenant denials observed, post-revocation dispatch attempts
//      ('capability-revoked'), or no audit evidence at all;
//   5. the decision: any escalate-class finding -> 'escalated'; every
//      declared capability unused (or no evidence) -> 'revoked'; else
//      'approved'.
//
// Payloads are read fail-closed (total narrowing): an event whose payload
// does not narrow to the audit-decision shape is not counted — the
// derivation stays total and deterministic over any contract-valid ledger.
import { isScope } from '@office/contracts';
import type { Scope } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { AuditLedgerEvent, InMemoryAuditLedger } from '../audit-ledger';
import { auditEventClassOf } from '../audit-ledger';
import { accessReviewIdOf } from './model';
import type {
  AccessReview,
  AccessReviewDecision,
  AccessReviewFinding,
  ReviewProvenanceRef,
  ReviewSubject,
} from './model';

/** The cross-tenant denial vocabulary the review counts (A12). */
export const CROSS_TENANT_DENIAL_CODES = [
  'tenant-scope-violation',
  'cross-tenant-scope',
] as const;

/** The decision kinds that escalate a review (deterministic rule). */
export const ESCALATING_FINDING_KINDS = [
  'denied-actions-observed',
  'cross-tenant-denials-observed',
  'capability-revocation-observed',
] as const;

/** The fail-closed plain-object narrowing (payloads are `unknown`). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The narrowed audit-decision observation of one audit event's payload. */
export interface AuditDecisionObservation {
  /** The payload's decision field ('executed', 'denied', ...), or null. */
  readonly decision: string | null;
  /** The payload's denial code (actions: denialCode; apps: reason), or null. */
  readonly denialCode: string | null;
  /** The payload's required capabilities (actions), or empty. */
  readonly requiredCapabilities: readonly string[];
  /** The payload's action class ('approval-required', ...; actions), or null. */
  readonly actionClass: string | null;
}

/** Narrow one audit payload to the audit-decision observation (fail-closed). */
export const observeAuditPayload = (payload: unknown): AuditDecisionObservation => {
  if (!isPlainObject(payload)) {
    return { decision: null, denialCode: null, requiredCapabilities: [], actionClass: null };
  }
  const decision = typeof payload['decision'] === 'string' ? payload['decision'] : null;
  const denial =
    typeof payload['denialCode'] === 'string'
      ? payload['denialCode']
      : typeof payload['reason'] === 'string'
        ? payload['reason']
        : null;
  const rawCapabilities = payload['requiredCapabilities'];
  const requiredCapabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const actionClass = typeof payload['actionClass'] === 'string' ? payload['actionClass'] : null;
  return { decision, denialCode: denial, requiredCapabilities, actionClass };
};

/** Does one ledger event's actor identify the review subject? (pure) */
const attributableTo = (event: AuditLedgerEvent, subject: ReviewSubject): boolean => {
  const actor = event.envelope.actor;
  if (subject.kind === 'actor-subject') {
    if (actor.kind === 'system') return subject.actor.kind === 'system';
    if (subject.actor.kind === 'system') return false;
    return actor.kind === subject.actor.kind && actor.actorId === subject.actor.actorId;
  }
  return actor.kind === 'app' && actor.actorId === subject.installationId;
};

/** The provenance reference of one ledger event (pure). */
const provenanceOf = (event: AuditLedgerEvent): ReviewProvenanceRef => ({
  eventId: event.eventId,
  eventName: event.envelope.eventName,
});

/** The inputs of one access review. */
export interface AccessReviewInput {
  /** The subject under review (an actor, or an app installation). */
  readonly subject: ReviewSubject;
  /** The scope the review runs under (A12: the visible audit trail). */
  readonly scope: Scope;
  /** The DECLARED capability baseline being audited (e.g. the A9 grants). */
  readonly declaredCapabilities: readonly string[];
  /** The recorded audit trail the review derives from. */
  readonly ledger: InMemoryAuditLedger;
}

/**
 * Derive one typed access review from the recorded audit trail
 * (deterministic, pure over the ledger's current state — the A7
 * discipline). Cross-tenant review queries (an installation subject of
 * another tenant than the query scope) are typed-rejected BEFORE the
 * ledger is ever read.
 */
export function reviewSubjectAccess(
  input: AccessReviewInput,
): Result<AccessReview, DomainError> {
  // 1. Fail-closed scope validation.
  if (!isScope(input.scope)) {
    return fail(
      domainError(
        'invariant-violation',
        'the access review requires a structurally valid query scope',
        [{ code: 'invalid-review-scope', message: 'scope failed its contract', path: 'scope' }],
      ),
    );
  }

  // 2. THE A12 GATE — before any ledger access: an installation subject of
  //    another tenant than the query scope is a typed unauthorized denial.
  if (
    input.subject.kind === 'installation-subject' &&
    input.subject.tenantId !== input.scope.tenantId
  ) {
    return fail(
      domainError(
        'unauthorized',
        `review scope tenant ${input.scope.tenantId} cannot review installation ${input.subject.installationId} of tenant ${input.subject.tenantId} (A12)`,
        [
          {
            code: 'tenant-scope-violation',
            message: `review tenant ${input.scope.tenantId}, subject tenant ${input.subject.tenantId}`,
            path: 'subject.tenantId',
          },
        ],
        { scope: input.scope, correlationId: null },
      ),
    );
  }

  // 3. The subject's attributable events, in ledger order (scope-visible).
  const attributable = input.ledger
    .eventsInScope(input.scope)
    .filter((event) => attributableTo(event, input.subject));

  // 4. Capabilities PROVEN held: the required capabilities of executed
  //    gateway decisions (only 'actions.*' events carry them).
  const provenCapabilities = new Set<string>();
  const capabilityEvidence = new Map<string, ReviewProvenanceRef[]>();
  const deniedEvidence: ReviewProvenanceRef[] = [];
  const crossTenantEvidence: ReviewProvenanceRef[] = [];
  const revocationEvidence: ReviewProvenanceRef[] = [];
  for (const event of attributable) {
    const observation = observeAuditPayload(event.envelope.payload);
    if (observation.decision === null) continue;
    if (auditEventClassOf(event.envelope.eventName) === 'actions' && observation.decision === 'executed') {
      for (const capability of observation.requiredCapabilities) {
        provenCapabilities.add(capability);
        const prior = capabilityEvidence.get(capability);
        capabilityEvidence.set(capability, [...(prior ?? []), provenanceOf(event)]);
      }
    }
    const denied =
      observation.decision === 'denied' || observation.decision === 'command-rejected';
    if (denied) {
      deniedEvidence.push(provenanceOf(event));
      if (
        observation.denialCode !== null &&
        (CROSS_TENANT_DENIAL_CODES as readonly string[]).includes(observation.denialCode)
      ) {
        crossTenantEvidence.push(provenanceOf(event));
      }
      if (observation.denialCode === 'capability-revoked') {
        revocationEvidence.push(provenanceOf(event));
      }
    }
  }

  // 5. The typed findings, in derivation order.
  const findings: AccessReviewFinding[] = [];
  const declared = [...new Set(input.declaredCapabilities)];
  // With no attributable audit evidence at all, per-capability findings are
  // meaningless — the sole finding is 'no-audit-evidence' (a subject WITH an
  // evidence trail can show a capability as unused; one without cannot).
  const hasAttributableEvidence = attributable.length > 0;
  for (const capability of declared) {
    if (!hasAttributableEvidence) break;
    findings.push(
      provenCapabilities.has(capability)
        ? {
            kind: 'capability-in-use',
            capability,
            evidence: capabilityEvidence.get(capability) ?? [],
          }
        : { kind: 'capability-unused', capability, evidence: [] },
    );
  }
  if (deniedEvidence.length > 0) {
    findings.push({
      kind: 'denied-actions-observed',
      capability: null,
      evidence: deniedEvidence,
    });
  }
  if (crossTenantEvidence.length > 0) {
    findings.push({
      kind: 'cross-tenant-denials-observed',
      capability: null,
      evidence: crossTenantEvidence,
    });
  }
  if (revocationEvidence.length > 0) {
    findings.push({
      kind: 'capability-revocation-observed',
      capability: null,
      evidence: revocationEvidence,
    });
  }
  if (attributable.length === 0) {
    findings.push({ kind: 'no-audit-evidence', capability: null, evidence: [] });
  }

  // 6. The deterministic decision.
  const escalated = findings.some((finding) =>
    (ESCALATING_FINDING_KINDS as readonly string[]).includes(finding.kind),
  );
  const everyDeclaredUnused =
    declared.length > 0 &&
    declared.every((capability) => !provenCapabilities.has(capability));
  const decision: AccessReviewDecision = escalated
    ? 'escalated'
    : everyDeclaredUnused || attributable.length === 0
      ? 'revoked'
      : 'approved';

  return ok({
    reviewId: accessReviewIdOf({
      subject: input.subject,
      scope: input.scope,
      declaredCapabilities: declared,
    }),
    subject: input.subject,
    scope: input.scope,
    declaredCapabilities: declared,
    provenCapabilities: [...provenCapabilities],
    findings,
    decision,
  } satisfies AccessReview);
}
