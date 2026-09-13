// Office operations — automated failure detection (OFF-038).
//
// THE pure evaluation function the acceptance demands: it takes the typed
// observability inputs (the adapter health views + the persistence failure
// observations + the pool statistics, all tenant-scoped) and emits one typed
// OperationalAlert per catalog record whose detection predicate fires.
// Deterministic: no clock, no randomness, no I/O — the same catalog over the
// same observability state always produces byte-identical alerts (the
// run-twice tests rely on it). Each rule fires on its fixture input and
// stays silent on the healthy input (the tested acceptance pair).
//
// A12 (both directions):
//   * evaluating tenant B's observability under tenant A's scope is a typed
//     `unauthorized` rejection (tenantScopeViolation), never a silent
//     cross-tenant read;
//   * reading the emitted alerts is scope-guarded too —
//     operationalAlertsInScope() only ever returns the alerts whose tenant
//     matches the reading scope (a project scope sees its own tenant's
//     tenant-wide alerts, mirroring the security precedent).
import { createHash } from 'node:crypto';
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult, Scope, TenantId } from '@office/contracts';
import { fail, ok, tenantScopeViolation } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { FailureModeKind, FailureModeRecord, OperationalSeverity } from './model';
import { OFFICE_FAILURE_MODE_CATALOG } from './model';

// ----- the observability inputs --------------------------------------------------------------

/** Health of one adapter family, as observed through its health surface. */
export interface AdapterHealthView {
  readonly kind: 'adapter-health-view';
  /** The adapter family (the landed adapter kind vocabulary). */
  readonly adapterKind: string;
  /** The provider system instance the family serves. */
  readonly systemId: string;
  /** The observed connection status (the degrade/recover dial). */
  readonly status: 'healthy' | 'degraded' | 'unavailable';
  /** Human-readable diagnostic, or null when fully healthy. */
  readonly detail: string | null;
}

/** One observed persistence fault (the typed fault-code family). */
export interface PersistenceFaultSample {
  readonly kind: 'persistence-fault-sample';
  /** Which operational surface faulted. */
  readonly surface: 'database' | 'migration' | 'ledger' | 'pool';
  /** The typed fault code (the PersistenceFailure code family). */
  readonly code: 'driver-error' | 'migration-validation' | 'migration-failed' | 'row-corruption';
  /** Human-readable fault message. */
  readonly message: string;
}

/** Database reachability + the recent connection-fault cluster. */
export interface DatabaseObservation {
  readonly kind: 'database-observation';
  /** Whether the last reachability probe succeeded. */
  readonly reachable: boolean;
  /** Connection-class driver faults observed in the window. */
  readonly connectionFaults: readonly PersistenceFaultSample[];
}

/** The last migration run's outcome (the forward-only batch ledger). */
export interface MigrationRunObservation {
  readonly kind: 'migration-run-observation';
  /** Migrations this run applied before finishing, or null when never run. */
  readonly appliedInRun: number | null;
  /** Whether the run failed (the failed migration rolled back completely). */
  readonly failed: boolean;
}

/** Event-ledger append health (the source of truth). */
export interface LedgerObservation {
  readonly kind: 'ledger-observation';
  /** Append faults observed in the window. */
  readonly appendFailures: readonly PersistenceFaultSample[];
}

/** Connection-pool statistics. */
export interface PoolObservation {
  readonly kind: 'pool-observation';
  /** Open connections right now. */
  readonly size: number;
  /** The pool's configured maximum. */
  readonly maxSize: number;
  /** Clients currently waiting for a connection. */
  readonly waiting: number;
}

/** THE tenant-scoped observability input (one tenant's operational view). */
export interface TenantObservability {
  readonly kind: 'tenant-observability';
  /** The tenant this view belongs to (A12 — evaluated only under its scope). */
  readonly tenantId: TenantId;
  readonly database: DatabaseObservation;
  readonly migrations: MigrationRunObservation;
  readonly adapters: readonly AdapterHealthView[];
  readonly ledger: LedgerObservation;
  readonly pool: PoolObservation;
}

/** The healthy observability baseline: no faults, everything healthy. */
export const healthyTenantObservability = (tenantId: TenantId): TenantObservability => ({
  kind: 'tenant-observability',
  tenantId,
  database: { kind: 'database-observation', reachable: true, connectionFaults: [] },
  migrations: { kind: 'migration-run-observation', appliedInRun: 5, failed: false },
  adapters: [],
  ledger: { kind: 'ledger-observation', appendFailures: [] },
  pool: { kind: 'pool-observation', size: 4, maxSize: 20, waiting: 0 },
});

// ----- the detection predicates (the closed matching vocabulary) ----------------------------

/**
 * Does the observability view match one failure mode? (pure) — the typed
 * detection rule of each catalog kind:
 *   - 'database-unavailability'     — unreachable, or >= 2 connection faults
 *                                     observed in the window (a cluster);
 *   - 'migration-failure-mid-batch' — the last run failed AFTER applying at
 *                                     least one migration in the same run;
 *   - 'adapter-provider-outage'     — any adapter health view is degraded or
 *                                     unavailable (the degrade/recover dial);
 *   - 'ledger-append-failure'       — at least one ledger append fault;
 *   - 'pool-exhaustion'             — the pool is at its maximum AND clients
 *                                     are waiting.
 */
export function failureModeMatches(
  kind: FailureModeKind,
  observability: TenantObservability,
): boolean {
  switch (kind) {
    case 'database-unavailability':
      return (
        !observability.database.reachable ||
        observability.database.connectionFaults.length >= 2
      );
    case 'migration-failure-mid-batch':
      return (
        observability.migrations.appliedInRun !== null &&
        observability.migrations.appliedInRun >= 1 &&
        observability.migrations.failed
      );
    case 'adapter-provider-outage':
      return observability.adapters.some((view) => view.status !== 'healthy');
    case 'ledger-append-failure':
      return observability.ledger.appendFailures.length >= 1;
    case 'pool-exhaustion':
      return (
        observability.pool.size >= observability.pool.maxSize &&
        observability.pool.waiting >= 1
      );
  }
}

/** Deterministic evidence lines for one fired failure mode (fixed order). */
const evidenceFor = (
  kind: FailureModeKind,
  observability: TenantObservability,
): readonly string[] => {
  switch (kind) {
    case 'database-unavailability':
      return [
        `database reachable: ${String(observability.database.reachable)}`,
        `connection faults observed: ${observability.database.connectionFaults.length}`,
      ];
    case 'migration-failure-mid-batch':
      return [
        `migrations applied in the failed run: ${observability.migrations.appliedInRun ?? 'never ran'}`,
        `run failed: ${String(observability.migrations.failed)}`,
      ];
    case 'adapter-provider-outage':
      return observability.adapters
        .filter((view) => view.status !== 'healthy')
        .map(
          (view) =>
            `adapter ${view.adapterKind} (${view.systemId}) reports ${view.status}` +
            `${view.detail === null ? '' : `: ${view.detail}`}`,
        );
    case 'ledger-append-failure':
      return observability.ledger.appendFailures.map(
        (fault) => `ledger append fault (${fault.code}): ${fault.message}`,
      );
    case 'pool-exhaustion':
      return [
        `pool size ${observability.pool.size} of maximum ${observability.pool.maxSize}`,
        `clients waiting: ${observability.pool.waiting}`,
      ];
  }
};

// ----- the alert identity --------------------------------------------------------------------

/** Grammar of an operational alert identity. */
export const OPERATIONAL_ALERT_ID_GRAMMAR =
  'office-opr-v1-<opaque: 16..64 lowercase alphanumeric> (derived, deterministic)';

const OPERATIONAL_ALERT_ID_PREFIX = 'office-opr-v1-';
const OPERATIONAL_ALERT_OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;

/** Parse an untrusted value as an operational alert id (total, fail-closed). */
export function parseOperationalAlertId(raw: unknown): ParseResult<string> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(OPERATIONAL_ALERT_ID_PREFIX) ||
    !OPERATIONAL_ALERT_OPAQUE_PATTERN.test(raw.slice(OPERATIONAL_ALERT_ID_PREFIX.length))
  ) {
    return parseFail('invalid-value', '', OPERATIONAL_ALERT_ID_GRAMMAR, String(raw));
  }
  return parseOk(raw);
}

/** Type guard for valid operational alert ids. */
export const isOperationalAlertId = (raw: unknown): boolean => parseOperationalAlertId(raw).ok;

/**
 * Derive the deterministic alert identity of (failure mode, tenant,
 * evidence): the same failure mode over the same observability state always
 * maps to the same id (sha256 over the stable keys).
 */
export function operationalAlertIdOf(parts: {
  readonly failureModeId: string;
  readonly tenantId: TenantId;
  readonly evidence: readonly string[];
}): string {
  const digest = createHash('sha256')
    .update(`${parts.failureModeId}|${parts.tenantId}|${parts.evidence.join(',')}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  const candidate = `${OPERATIONAL_ALERT_ID_PREFIX}${digest}`;
  const parsed = parseOperationalAlertId(candidate);
  if (!parsed.ok) {
    throw new TypeError(`derived operational alert id is invalid: ${parsed.error.code}`);
  }
  return parsed.value;
}

// ----- the alert record ----------------------------------------------------------------------

/** One typed operational alert, fired by one catalog record's detection rule. */
export interface OperationalAlert {
  readonly kind: 'operational-alert';
  /** The alert's deterministic derived identity. */
  readonly alertId: string;
  /** The catalog record that fired (its stable id). */
  readonly failureModeId: string;
  /** The failure mode that fired (the closed vocabulary). */
  readonly failureModeKind: FailureModeKind;
  /** The fired mode's severity. */
  readonly severity: OperationalSeverity;
  /** The tenant whose observability view the alert fired in (A12). */
  readonly tenantId: TenantId;
  /** Deterministic evidence lines (fixed order, human-readable). */
  readonly evidence: readonly string[];
  /** The documented operator action for this mode (the runbook step). */
  readonly operatorAction: string;
}

// ----- THE evaluation function ---------------------------------------------------------------

/** The typed detection-report outcome. */
export interface FailureDetectionReport {
  readonly kind: 'failure-detection-report';
  /** The tenant the evaluation ran under. */
  readonly tenantId: TenantId;
  /** Every alert that fired, in catalog order. */
  readonly alerts: readonly OperationalAlert[];
  /** True iff no failure mode fired (the healthy case). */
  readonly healthy: boolean;
}

/** The parts one detection evaluation needs. */
export interface FailureDetectionParts {
  /** The catalog to evaluate (default: the canonical OFFICE catalog). */
  readonly catalog?: readonly FailureModeRecord[];
  /** The scope the evaluation runs under (A12 — must match the view's tenant). */
  readonly scope: Scope;
  /** The tenant-scoped observability view to evaluate. */
  readonly observability: TenantObservability;
}

/**
 * THE automated detection: evaluate the catalog's detection rules over one
 * tenant-scoped observability view, under an explicit scope. Cross-tenant
 * evaluation is a typed `unauthorized` rejection (A12, both directions —
 * see operationalAlertsInScope for the read side). Pure and deterministic.
 */
export function evaluateFailureDetection(
  parts: FailureDetectionParts,
): Result<FailureDetectionReport, DomainError> {
  const catalog = parts.catalog ?? OFFICE_FAILURE_MODE_CATALOG;
  if (parts.scope.tenantId !== parts.observability.tenantId) {
    return fail(
      tenantScopeViolation(
        {
          commandTenantId: parts.scope.tenantId,
          aggregateTenantId: parts.observability.tenantId,
        },
        { scope: parts.scope },
      ),
    );
  }
  const alerts: OperationalAlert[] = [];
  for (const record of catalog) {
    if (!failureModeMatches(record.kind, parts.observability)) continue;
    const evidence = evidenceFor(record.kind, parts.observability);
    alerts.push({
      kind: 'operational-alert',
      alertId: operationalAlertIdOf({
        failureModeId: record.failureModeId,
        tenantId: parts.observability.tenantId,
        evidence,
      }),
      failureModeId: record.failureModeId,
      failureModeKind: record.kind,
      severity: record.severity,
      tenantId: parts.observability.tenantId,
      evidence,
      operatorAction: record.operatorAction,
    });
  }
  return ok({
    kind: 'failure-detection-report',
    tenantId: parts.observability.tenantId,
    alerts,
    healthy: alerts.length === 0,
  });
}

/**
 * The read side of the A12 guard: only the alerts whose tenant matches the
 * reading scope are ever returned (a project scope sees its own tenant's
 * tenant-wide alerts, mirroring the security alert precedent). Pure.
 */
export function operationalAlertsInScope(
  alerts: readonly OperationalAlert[],
  scope: Scope,
): readonly OperationalAlert[] {
  return alerts.filter((alert) => alert.tenantId === scope.tenantId);
}
