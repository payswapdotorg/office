// Office security — deterministic alert evaluation over the audit stream (OFF-036).
//
// evaluateSensitiveActionAlerts() turns (rules, the recorded audit ledger, a
// query scope) into typed SensitiveActionAlert records: every rule whose
// matching predicate observes at least its threshold of audit events fires
// ONE alert carrying the FULL PROVENANCE (the ledger event ids and event
// names of every matching event, in ledger order). The evaluation is pure
// and deterministic — no clock, no randomness, no I/O — so the same rules
// over the same ledger state always produce byte-identical alerts (the
// run-twice proofs rely on it).
//
// A12: the evaluation reads the ledger through eventsInScope ONLY — an
// evaluation under tenant A's scope never sees tenant B's audit events, and
// a project-scoped evaluation sees its own project's events plus the
// tenant-wide audit events, never a foreign project's.
//
// Payloads are read fail-closed (total narrowing through
// observeAuditPayload): an event whose payload does not narrow to the
// audit-decision shape simply never matches — the evaluation stays total
// and deterministic over any contract-valid ledger.
import { createHash } from 'node:crypto';
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult, Scope, TenantId } from '@office/contracts';
import type { AuditLedgerEvent, InMemoryAuditLedger } from '../audit-ledger';
import type { ReviewProvenanceRef } from '../access-review/model';
import { observeAuditPayload } from '../access-review/derive';
import type { AuditDecisionObservation } from '../access-review/derive';
import type { AlertRuleKind, AlertSeverity, SensitiveActionAlertRule } from './rules';

// ----- the matching vocabulary ---------------------------------------------------------------

/** Every decision kind that counts as a typed denial (both dispatch surfaces). */
const DENIED_DECISIONS = ['denied', 'command-rejected', 'event-rejected'] as const;

/** The A12 denial codes (the tenant-isolation vocabulary, both surfaces). */
const CROSS_TENANT_CODES = [
  'tenant-scope-violation',
  'project-scope-violation',
  'cross-tenant-scope',
] as const;

/** The fail-closed classification denial codes. */
const PROHIBITED_CLASS_CODES = ['unknown-action', 'prohibited-action'] as const;

/** The revocation-family denial codes (A7/A9). */
const REVOCATION_ACTIVITY_CODES = [
  'installation-suspended',
  'installation-revoked',
  'revocation-terminal',
  'capability-revoked',
] as const;

/**
 * Does one audit-decision observation match one rule kind? (pure) — the
 * closed matching vocabulary every SensitiveActionAlertRule kind is defined
 * by (see rules.ts).
 */
export const alertRuleKindMatches = (
  kind: AlertRuleKind,
  observation: AuditDecisionObservation,
): boolean => {
  const denied =
    observation.decision !== null &&
    (DENIED_DECISIONS as readonly string[]).includes(observation.decision);
  const code = observation.denialCode;
  switch (kind) {
    case 'denied-action-cluster':
      return denied;
    case 'cross-tenant-denial':
      return denied && code !== null && (CROSS_TENANT_CODES as readonly string[]).includes(code);
    case 'prohibited-class-attempt':
      return (
        denied && code !== null && (PROHIBITED_CLASS_CODES as readonly string[]).includes(code)
      );
    case 'actor-kind-rejection':
      return denied && code === 'actor-kind-not-permitted';
    case 'revocation-activity':
      return (
        denied && code !== null && (REVOCATION_ACTIVITY_CODES as readonly string[]).includes(code)
      );
    case 'sensitive-execution':
      return observation.decision === 'executed' && observation.actionClass === 'approval-required';
  }
};

// ----- the alert identity derivation ---------------------------------------------------------

/** Grammar of a sensitive-action alert identity. */
export const ALERT_ID_GRAMMAR =
  'office-alt-v1-<opaque: 16..64 lowercase alphanumeric> (derived, deterministic)';

const ALERT_ID_PREFIX = 'office-alt-v1-';
const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;

/** Parse an untrusted value as a sensitive-action alert id (total, fail-closed). */
export function parseAlertId(raw: unknown): ParseResult<string> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(ALERT_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(raw.slice(ALERT_ID_PREFIX.length))
  ) {
    return parseFail('invalid-value', '', ALERT_ID_GRAMMAR, String(raw));
  }
  return parseOk(raw);
}

/** Type guard for valid sensitive-action alert ids. */
export const isAlertId = (raw: unknown): boolean => parseAlertId(raw).ok;

/**
 * Derive the deterministic alert identity of (rule, tenant, evidence): the
 * same rule over the same ledger state always maps to the same id (sha256
 * over the stable keys — the evidence event ids in ledger order).
 */
export function alertIdOf(parts: {
  readonly ruleId: string;
  readonly tenantId: TenantId;
  readonly eventIds: readonly string[];
}): string {
  const digest = createHash('sha256')
    .update(`${parts.ruleId}|${parts.tenantId}|${parts.eventIds.join(',')}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const candidate = `${ALERT_ID_PREFIX}${digest}`;
  const parsed = parseAlertId(candidate);
  if (!parsed.ok) {
    throw new TypeError(`derived alert id is invalid: ${parsed.error.code}`);
  }
  return parsed.value;
}

// ----- the alert record ----------------------------------------------------------------------

/** One typed sensitive-action alert, fired by one rule over the audit stream. */
export interface SensitiveActionAlert {
  /** The alert's deterministic derived identity. */
  readonly alertId: string;
  /** The rule that fired (its stable id). */
  readonly ruleId: string;
  /** The rule's matching kind. */
  readonly kind: AlertRuleKind;
  /** The rule's severity. */
  readonly severity: AlertSeverity;
  /** The tenant whose audit stream the alert fired in (A12). */
  readonly tenantId: TenantId;
  /** How many matching audit events were observed. */
  readonly observed: number;
  /** The full provenance: every matching ledger event, in ledger order. */
  readonly evidence: readonly ReviewProvenanceRef[];
}

// ----- the evaluation ------------------------------------------------------------------------

/** The inputs of one alert evaluation. */
export interface AlertEvaluationInput {
  /** The rules being evaluated (already-parsed typed records). */
  readonly rules: readonly SensitiveActionAlertRule[];
  /** The recorded audit trail the rules are evaluated over. */
  readonly ledger: InMemoryAuditLedger;
  /** The scope the evaluation runs under (A12: the visible audit stream). */
  readonly scope: Scope;
}

/** The typed result of one alert evaluation. */
export interface AlertEvaluationResult {
  /** The scope the evaluation ran under (A12). */
  readonly scope: Scope;
  /** Every fired alert, in rule order (deterministic). */
  readonly alerts: readonly SensitiveActionAlert[];
  /** How many audit events the evaluation scanned (the scope-visible stream). */
  readonly scannedEvents: number;
}

/** The provenance reference of one ledger event (pure). */
const provenanceOf = (event: AuditLedgerEvent): ReviewProvenanceRef => ({
  eventId: event.eventId,
  eventName: event.envelope.eventName,
});

/**
 * Evaluate the sensitive-action alert rules over the recorded audit stream
 * (pure, deterministic): every rule whose matching predicate observes at
 * least its threshold of scope-visible audit events fires one typed alert
 * with the full provenance. Two evaluations of the same rules over the same
 * ledger state produce byte-identical results (run-twice safe).
 */
export function evaluateSensitiveActionAlerts(
  input: AlertEvaluationInput,
): AlertEvaluationResult {
  const scoped = input.ledger.eventsInScope(input.scope);
  const tenantId = input.scope.tenantId;
  const alerts: SensitiveActionAlert[] = [];
  for (const rule of input.rules) {
    const matching = scoped.filter((event) =>
      alertRuleKindMatches(rule.kind, observeAuditPayload(event.envelope.payload)),
    );
    if (matching.length < rule.threshold) continue;
    const evidence = matching.map(provenanceOf);
    alerts.push({
      alertId: alertIdOf({
        ruleId: rule.ruleId,
        tenantId,
        eventIds: evidence.map((entry) => entry.eventId),
      }),
      ruleId: rule.ruleId,
      kind: rule.kind,
      severity: rule.severity,
      tenantId,
      observed: matching.length,
      evidence,
    });
  }
  return { scope: input.scope, alerts, scannedEvents: scoped.length };
}
