// Office operations — the failure-mode catalog (OFF-038).
//
// THE typed catalog of the critical failure modes production readiness is
// judged on, following the OFF-036 alert-rule precedent: records are PURE
// DATA (no behavior, no clock, no I/O) — the deterministic detection lives
// in detect.ts. Every record carries BOTH halves the acceptance demands:
// the DETECTION rule (its stable id + the typed predicate kind evaluated
// over the observability inputs) and the documented OPERATOR ACTION (the
// runbook step text, mirrored in RUNBOOK.md) plus the ESCALATION policy.
//
// Fail-closed: an untrusted catalog record parses through a total validator
// (strict keys, closed kind/severity vocabularies, non-empty texts) — a
// malformed record can never enter the evaluator. The trusted builder
// (defineFailureMode) throws loud TypeErrors instead.
//
// A12: the catalog itself is the tenant-independent POLICY vocabulary (the
// same five failure modes govern every tenant); the per-tenant scope is
// carried by the detection surface — the TenantObservability input and the
// OperationalAlert records it emits are tenant-scoped, with typed
// cross-tenant rejections both directions (see detect.ts).
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';

// ----- the failure-mode vocabulary ----------------------------------------------------------

/**
 * Every critical failure mode in the catalog, in vocabulary order. Each kind
 * binds ONE typed detection predicate over the observability inputs (the
 * closed matching vocabulary evaluated in detect.ts):
 *   - 'database-unavailability'      — the canonical database is unreachable
 *                                       or connection faults cluster;
 *   - 'migration-failure-mid-batch'  — a migration run failed AFTER applying
 *                                       at least one migration in the same
 *                                       run (a partially-applied batch);
 *   - 'adapter-provider-outage'      — an adapter family's health surface
 *                                       reports degraded or unavailable
 *                                       (the degrade/recover dial);
 *   - 'ledger-append-failure'        — an append to the event ledger failed
 *                                       (the source of truth is at risk);
 *   - 'pool-exhaustion'              — the connection pool is at its maximum
 *                                       AND clients are waiting.
 */
export const FAILURE_MODE_KINDS = [
  'database-unavailability',
  'migration-failure-mid-batch',
  'adapter-provider-outage',
  'ledger-append-failure',
  'pool-exhaustion',
] as const;

/** One critical failure mode (the closed catalog vocabulary). */
export type FailureModeKind = (typeof FAILURE_MODE_KINDS)[number];

/** Grammar description used in parse failures. */
export const FAILURE_MODE_KIND_GRAMMAR =
  "'database-unavailability' | 'migration-failure-mid-batch' | 'adapter-provider-outage' | 'ledger-append-failure' | 'pool-exhaustion'";

/** Parse an untrusted value as a FailureModeKind (total, fail-closed). */
export function parseFailureModeKind(raw: unknown): ParseResult<FailureModeKind> {
  if (typeof raw !== 'string' || !(FAILURE_MODE_KINDS as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', FAILURE_MODE_KIND_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as FailureModeKind);
}

/** Type guard for valid FailureModeKind values. */
export const isFailureModeKind = (raw: unknown): raw is FailureModeKind =>
  parseFailureModeKind(raw).ok;

// ----- the severity vocabulary --------------------------------------------------------------

/** Every operational severity, in vocabulary order. */
export const OPERATIONAL_SEVERITIES = ['warning', 'critical'] as const;

/** One operational severity (how urgent the fired alert is). */
export type OperationalSeverity = (typeof OPERATIONAL_SEVERITIES)[number];

/** Grammar description used in parse failures. */
export const OPERATIONAL_SEVERITY_GRAMMAR = "'warning' | 'critical'";

/** Parse an untrusted value as an OperationalSeverity (total, fail-closed). */
export function parseOperationalSeverity(raw: unknown): ParseResult<OperationalSeverity> {
  if (typeof raw !== 'string' || !(OPERATIONAL_SEVERITIES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', OPERATIONAL_SEVERITY_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as OperationalSeverity);
}

/** Type guard for valid OperationalSeverity values. */
export const isOperationalSeverity = (raw: unknown): raw is OperationalSeverity =>
  parseOperationalSeverity(raw).ok;

// ----- the identity grammars ----------------------------------------------------------------

/** Grammar description used in parse failures. */
export const FAILURE_MODE_ID_GRAMMAR =
  'lowercase kebab-case failure mode id (3..64 chars), e.g. database-unavailability';

const FAILURE_MODE_ID_PATTERN = /^[a-z](?:[a-z0-9]-{0,1})*[a-z0-9]$/;

/** Parse an untrusted value as a failure mode id (total, fail-closed). */
export function parseFailureModeId(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string' || !FAILURE_MODE_ID_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', FAILURE_MODE_ID_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw);
}

/** Type guard for valid failure mode ids. */
export const isFailureModeId = (raw: unknown): boolean => parseFailureModeId(raw).ok;

// ----- the catalog record -------------------------------------------------------------------

/** One typed failure-mode record (pure data — see the module comment). */
export interface FailureModeRecord {
  /** The record's stable id (kebab-case — the vocabulary operators reference). */
  readonly failureModeId: string;
  /** The failure mode (binds the detection predicate kind in detect.ts). */
  readonly kind: FailureModeKind;
  /** The severity of an alert this mode fires. */
  readonly severity: OperationalSeverity;
  /** What the failure mode is (human-readable, deterministic). */
  readonly description: string;
  /** The detection rule's stable id (fires via the kind's typed predicate). */
  readonly detectionRuleId: string;
  /** The documented operator action (the runbook step text). */
  readonly operatorAction: string;
  /** The escalation policy when the operator action does not resolve it. */
  readonly escalation: string;
}

const FAILURE_MODE_KEYS = [
  'failureModeId',
  'kind',
  'severity',
  'description',
  'detectionRuleId',
  'operatorAction',
  'escalation',
] as const;

const FAILURE_MODE_GRAMMAR =
  'FailureModeRecord: { failureModeId: kebab id, kind: FailureModeKind, severity: OperationalSeverity, description: string, detectionRuleId: kebab id, operatorAction: string, escalation: string }';

/** Describe an untrusted value compactly for parse failures. */
function describeValue(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'array';
  if (typeof raw === 'object') return 'object';
  if (typeof raw === 'string') return `'${raw}'`;
  return String(raw);
}

/** Is the value a plain object (not null, not an array)? */
function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/** Read one required field through a total parser (strict, fail-closed). */
function requireFieldWith<T>(
  raw: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => ParseResult<T>,
): ParseResult<T> {
  const value = raw[key];
  if (value === undefined) {
    return parseFail('missing-field', key, 'present', 'undefined');
  }
  return parse(value);
}

/** Read one required non-empty string field (strict, fail-closed). */
function requireText(
  raw: Record<string, unknown>,
  key: string,
  bounds: { readonly min: number; readonly max: number },
): ParseResult<string> {
  const value = raw[key];
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length < bounds.min ||
    value.length > bounds.max
  ) {
    return parseFail(
      'invalid-value',
      key,
      `non-empty string (${bounds.min}..${bounds.max} chars)`,
      describeValue(value),
    );
  }
  return parseOk(value);
}

/** Fail closed on any key outside the strict key set (null when clean). */
function unknownKeyFailure(
  raw: Record<string, unknown>,
  keys: readonly string[],
): ParseResult<never> | null {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) {
      return parseFail('unknown-field', key, 'one of the documented keys', 'present');
    }
  }
  return null;
}

/** Trusted builder: construct one FailureModeRecord, throwing on bad parts. */
export function defineFailureMode(parts: Omit<FailureModeRecord, never>): FailureModeRecord {
  const parsed = parseFailureModeRecord(parts);
  if (!parsed.ok) {
    throw new TypeError(
      `invalid failure mode: ${parsed.error.code} at '${parsed.error.path}'`,
    );
  }
  return parsed.value;
}

/** Parse an untrusted value as a FailureModeRecord (total, fail-closed, strict keys). */
export function parseFailureModeRecord(raw: unknown): ParseResult<FailureModeRecord> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', FAILURE_MODE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, FAILURE_MODE_KEYS);
  if (unknownKey !== null) return unknownKey;
  const failureModeId = requireFieldWith(raw, 'failureModeId', parseFailureModeId);
  if (!failureModeId.ok) return failureModeId;
  const kind = requireFieldWith(raw, 'kind', parseFailureModeKind);
  if (!kind.ok) return kind;
  const severity = requireFieldWith(raw, 'severity', parseOperationalSeverity);
  if (!severity.ok) return severity;
  const description = requireText(raw, 'description', { min: 1, max: 500 });
  if (!description.ok) return description;
  const detectionRuleId = requireFieldWith(raw, 'detectionRuleId', parseFailureModeId);
  if (!detectionRuleId.ok) return detectionRuleId;
  const operatorAction = requireText(raw, 'operatorAction', { min: 1, max: 1000 });
  if (!operatorAction.ok) return operatorAction;
  const escalation = requireText(raw, 'escalation', { min: 1, max: 1000 });
  if (!escalation.ok) return escalation;
  return parseOk({
    failureModeId: failureModeId.value,
    kind: kind.value,
    severity: severity.value,
    description: description.value,
    detectionRuleId: detectionRuleId.value,
    operatorAction: operatorAction.value,
    escalation: escalation.value,
  } satisfies FailureModeRecord);
}

/** Type guard for structurally valid FailureModeRecord values. */
export function isFailureModeRecord(raw: unknown): raw is FailureModeRecord {
  return parseFailureModeRecord(raw).ok;
}

// ----- THE canonical catalog ----------------------------------------------------------------

/**
 * THE failure-mode catalog: one record per critical failure mode, each with
 * a tested detection rule (detect.ts evaluates the kind's typed predicate
 * over the observability inputs) and the documented operator action +
 * escalation mirrored in RUNBOOK.md. Pure data; generic vocabulary only.
 */
export const OFFICE_FAILURE_MODE_CATALOG: readonly FailureModeRecord[] = [
  defineFailureMode({
    failureModeId: 'database-unavailability',
    kind: 'database-unavailability',
    severity: 'critical',
    description:
      'The canonical database is unreachable (connection refused, timeout, or reset) or connection faults are clustering across statements',
    detectionRuleId: 'database-unreachable-or-connection-fault-cluster',
    operatorAction:
      'Check the database process and network path; confirm the gateway health endpoint reports the database reachable again before reopening client writes. Follow the RUNBOOK restore procedure only if the database cannot be recovered in place.',
    escalation:
      'If the database is not reachable again within the recovery window, page the on-call operator and run the restore drill procedure against the latest deterministic backup',
  }),
  defineFailureMode({
    failureModeId: 'migration-failure-mid-batch',
    kind: 'migration-failure-mid-batch',
    severity: 'critical',
    description:
      'A migration run failed after applying at least one migration in the same run: the batch is partially applied (each migration is its own transaction, so earlier migrations of the batch stay applied)',
    detectionRuleId: 'migration-run-failed-after-applying',
    operatorAction:
      'Read the failed migration error; fix the migration file or the environment cause; re-run the migrator — it resumes forward-only from the recorded high-water mark (never edit or reorder applied files). The database stays consistent: the failed migration rolled back completely.',
    escalation:
      'If the migrator cannot advance after the fix, stop all deployments, page the on-call operator, and treat the database as frozen until the batch completes',
  }),
  defineFailureMode({
    failureModeId: 'adapter-provider-outage',
    kind: 'adapter-provider-outage',
    severity: 'warning',
    description:
      'An adapter family reports a non-healthy provider connection through its health surface (degraded or unavailable — the degrade/recover dial operators watch)',
    detectionRuleId: 'adapter-health-not-healthy',
    operatorAction:
      'Confirm the provider system status, then drive the adapter recover transition once the provider is reachable again; degraded adapters keep serving one-way ingress, so no restore is needed. Do not restart the database for an adapter outage.',
    escalation:
      'If the adapter stays degraded or unavailable past the provider recovery window, escalate to the integration owner and consider pausing the affected sync schedules',
  }),
  defineFailureMode({
    failureModeId: 'ledger-append-failure',
    kind: 'ledger-append-failure',
    severity: 'critical',
    description:
      'An append to the append-only event ledger failed: the single source of truth stopped accepting events, and projections stall behind it',
    detectionRuleId: 'ledger-append-fault-observed',
    operatorAction:
      'Stop accepting new commands at the gateway (fail closed — never drop events silently), check the database health and disk capacity, then replay the failed append from the command envelope once the cause is resolved.',
    escalation:
      'If appends keep failing after the cause is addressed, page the on-call operator and verify ledger integrity against the deterministic backup before resuming writes',
  }),
  defineFailureMode({
    failureModeId: 'pool-exhaustion',
    kind: 'pool-exhaustion',
    severity: 'warning',
    description:
      'The connection pool is at its maximum size with clients waiting for connections: latency climbs toward statement timeouts',
    detectionRuleId: 'pool-at-max-with-waiters',
    operatorAction:
      'Identify long-running or leaked statements via the pool statistics, terminate the blocking statements (a transaction that cannot be salvaged is rolled back), and raise the pool maximum only after the leak is ruled out.',
    escalation:
      'If exhaustion recurs after the blocking statements are cleared, escalate to the platform owner with the pool statistics and the waiting counts',
  }),
] as const;
