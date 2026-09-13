// Office security — the access-review model (OFF-036).
//
// A typed review record for one subject (an actor — user, agent, adapter,
// system — or an app installation) under one scope: the capabilities the
// reviewer audits (the DECLARED baseline, e.g. the A9 permission
// declaration or the role capability set), the typed findings derived from
// the recorded audit trail, the review decision, and the full provenance
// (the ledger event ids the findings derive from — the A7 discipline:
// reviews are DERIVED state, recomputed deterministically from events).
//
// The finding vocabulary is closed and typed; the decision rule is
// deterministic (see derive.ts): escalate-class findings -> 'escalated';
// every declared capability unused (or no audit evidence at all) ->
// 'revoked'; otherwise 'approved'.
import { createHash } from 'node:crypto';
import { parseFail, parseOk } from '@office/contracts';
import type { Actor, EntityId, ParseResult, Scope, TenantId } from '@office/contracts';

/** Every access-review finding kind, in vocabulary order. */
export const ACCESS_REVIEW_FINDING_KINDS = [
  'capability-in-use',
  'capability-unused',
  'denied-actions-observed',
  'cross-tenant-denials-observed',
  'capability-revocation-observed',
  'no-audit-evidence',
] as const;

/** One typed access-review finding kind (the closed vocabulary). */
export type AccessReviewFindingKind = (typeof ACCESS_REVIEW_FINDING_KINDS)[number];

/** Grammar description used in parse failures. */
export const ACCESS_REVIEW_FINDING_GRAMMAR =
  "'capability-in-use' | 'capability-unused' | 'denied-actions-observed' | 'cross-tenant-denials-observed' | 'capability-revocation-observed' | 'no-audit-evidence'";

/** Every access-review decision, in vocabulary order. */
export const ACCESS_REVIEW_DECISIONS = ['approved', 'revoked', 'escalated'] as const;

/** One typed access-review decision (the closed vocabulary). */
export type AccessReviewDecision = (typeof ACCESS_REVIEW_DECISIONS)[number];

/** Grammar description used in parse failures. */
export const ACCESS_REVIEW_DECISION_GRAMMAR = "'approved' | 'revoked' | 'escalated'";

/** Parse an untrusted value as an AccessReviewFindingKind (fail-closed). */
export function parseAccessReviewFindingKind(
  raw: unknown,
): ParseResult<AccessReviewFindingKind> {
  if (
    typeof raw !== 'string' ||
    !(ACCESS_REVIEW_FINDING_KINDS as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', ACCESS_REVIEW_FINDING_GRAMMAR, String(raw));
  }
  return parseOk(raw as AccessReviewFindingKind);
}

/** Parse an untrusted value as an AccessReviewDecision (fail-closed). */
export function parseAccessReviewDecision(
  raw: unknown,
): ParseResult<AccessReviewDecision> {
  if (
    typeof raw !== 'string' ||
    !(ACCESS_REVIEW_DECISIONS as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', ACCESS_REVIEW_DECISION_GRAMMAR, String(raw));
  }
  return parseOk(raw as AccessReviewDecision);
}

/** The subject of one access review: an actor, or an app installation. */
export type ReviewSubject =
  | { readonly kind: 'actor-subject'; readonly actor: Actor }
  | {
      readonly kind: 'installation-subject';
      readonly installationId: EntityId;
      readonly appId: string;
      readonly tenantId: TenantId;
    };

/** One provenance reference: the ledger event a finding derives from. */
export interface ReviewProvenanceRef {
  /** The ledger-assigned event id (deterministic). */
  readonly eventId: string;
  /** The audit event's name. */
  readonly eventName: string;
}

/** One typed finding of an access review, with its provenance. */
export interface AccessReviewFinding {
  /** The finding kind (the closed vocabulary). */
  readonly kind: AccessReviewFindingKind;
  /** The capability the finding is about, or null for subject-level ones. */
  readonly capability: string | null;
  /** The ledger events the finding derives from (in ledger order). */
  readonly evidence: readonly ReviewProvenanceRef[];
}

/** One typed access review over the recorded audit trail (derived, A7). */
export interface AccessReview {
  /** The review's deterministic derived identity. */
  readonly reviewId: string;
  /** The subject under review. */
  readonly subject: ReviewSubject;
  /** The scope the review ran under (A12). */
  readonly scope: Scope;
  /** The DECLARED capability baseline the reviewer audited against. */
  readonly declaredCapabilities: readonly string[];
  /** The capabilities the audit trail PROVES the subject held (by execution). */
  readonly provenCapabilities: readonly string[];
  /** The typed findings, in derivation order. */
  readonly findings: readonly AccessReviewFinding[];
  /** The deterministic review decision. */
  readonly decision: AccessReviewDecision;
}

// ----- the review identity derivation ---------------------------------------------------------

/** Grammar of an access-review identity. */
export const ACCESS_REVIEW_ID_GRAMMAR =
  'office-rev-v1-<opaque: 16..64 lowercase alphanumeric> (derived, deterministic)';

const REVIEW_ID_PREFIX = 'office-rev-v1-';
const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;

/** Parse an untrusted value as an access-review id (total, fail-closed). */
export function parseAccessReviewId(raw: unknown): ParseResult<string> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(REVIEW_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(raw.slice(REVIEW_ID_PREFIX.length))
  ) {
    return parseFail('invalid-value', '', ACCESS_REVIEW_ID_GRAMMAR, String(raw));
  }
  return parseOk(raw);
}

/** Type guard for valid access-review ids. */
export const isAccessReviewId = (raw: unknown): boolean => parseAccessReviewId(raw).ok;

/** The stable subject key of a review subject (pure). */
export const subjectKeyOf = (subject: ReviewSubject): string =>
  subject.kind === 'actor-subject'
    ? `actor|${subject.actor.kind}|${subject.actor.kind === 'system' ? '' : subject.actor.actorId}`
    : `installation|${subject.installationId}|${subject.appId}|${subject.tenantId}`;

/** The stable scope key of a review scope (pure). */
export const scopeKeyOf = (scope: Scope): string =>
  scope.kind === 'project'
    ? `scope|${scope.tenantId}|${scope.projectId}`
    : `scope|${scope.tenantId}`;

/**
 * Derive the deterministic access-review identity of (subject, scope,
 * declared capabilities): the same review inputs always map to the same id
 * (sha256 over the stable keys; declared capabilities are sorted first).
 */
export function accessReviewIdOf(parts: {
  readonly subject: ReviewSubject;
  readonly scope: Scope;
  readonly declaredCapabilities: readonly string[];
}): string {
  const declared = [...parts.declaredCapabilities].sort().join(',');
  const digest = createHash('sha256')
    .update(`${subjectKeyOf(parts.subject)}|${scopeKeyOf(parts.scope)}|${declared}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const candidate = `${REVIEW_ID_PREFIX}${digest}`;
  const parsed = parseAccessReviewId(candidate);
  if (!parsed.ok) {
    throw new TypeError(`derived access review id is invalid: ${parsed.error.code}`);
  }
  return parsed.value;
}
