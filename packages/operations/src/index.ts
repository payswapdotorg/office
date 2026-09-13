// Office operations — public surface (OFF-038).
//
// src/index.ts is the package's WHOLE public surface: OFF-039 (architecture
// conformance gate) and OFF-040 (successor handoff verification) consume
// the package only through this root entry point, never through deeper
// paths. Anything not re-exported here is package-internal and may change
// without notice.
//
// The package imports exactly eight workspace dependencies — the four
// adapter families (their landed kind/system vocabulary anchors the
// topology's adapter deployments), @office/contracts (ids, Scope, parse
// plumbing), @office/domain-kernel (Result/DomainError), @office/persistence
// (the migrator/pool/harness substrate the restore drill runs on), and
// @office/security (the alert/detection precedent vocabulary) — plus the
// node:crypto digest builtin for the deterministic checksums. No new
// external dependencies; pg flows through @office/persistence's harness
// only; no network I/O beyond the local embedded/scratch database.
//
// Surface summary:
// - topology:  DeploymentTopology (+ components/adapters/invariants/flows)
//              and OFFICE_DEPLOYMENT_TOPOLOGY — the typed deployment shape
//              the runbook and the failure catalog reason about
// - drill:     THE restore drill (runRestoreDrill + RestoreDrillReport +
//              the migrations-policy report leg) and its deterministic
//              parts (createDatabaseBackup, restoreDatabaseBackup,
//              compareBackups) — the runbook's restore procedure as code
// - failures:  the failure-mode catalog (OFFICE_FAILURE_MODE_CATALOG, the
//              typed records with detection + operator action + escalation,
//              fail-closed parsing) and the automated detection
//              (evaluateFailureDetection + failureModeMatches, the
//              tenant-scoped observability inputs, the typed alerts, the
//              A12 scope guards both directions)

// The typed deployment-topology artifact.
export {
  OFFICE_DEPLOYMENT_TOPOLOGY,
} from './topology/model';
export type {
  AdapterDeployment,
  DeploymentTopology,
  TopologyComponent,
  TopologyInvariant,
} from './topology/model';

// THE restore drill + its deterministic parts.
export {
  BACKUP_EXCLUDED_TABLES,
  createDatabaseBackup,
} from './drill/backup';
export type { BackupTableDump, DatabaseBackup } from './drill/backup';
export {
  compareBackups,
  compareDatabaseContents,
} from './drill/compare';
export type { DatabaseComparison, TableComparison } from './drill/compare';
export { restoreDatabaseBackup } from './drill/restore';
export type { RestoreDatabaseBackupParts, RestoreOutcome } from './drill/restore';
export {
  drillClock,
  runRestoreDrill,
  seedCanonicalRows,
} from './drill/run';
export type {
  MigrationsPolicyReport,
  RestoreDrillDeps,
  RestoreDrillReport,
  SeedStep,
  SeedSummary,
} from './drill/run';

// The failure-mode catalog.
export {
  FAILURE_MODE_KINDS,
  FAILURE_MODE_KIND_GRAMMAR,
  OFFICE_FAILURE_MODE_CATALOG,
  OPERATIONAL_SEVERITIES,
  OPERATIONAL_SEVERITY_GRAMMAR,
  defineFailureMode,
  isFailureModeId,
  isFailureModeKind,
  isFailureModeRecord,
  isOperationalSeverity,
  parseFailureModeId,
  parseFailureModeKind,
  parseFailureModeRecord,
} from './failures/model';
export type {
  FailureModeKind,
  FailureModeRecord,
  OperationalSeverity,
} from './failures/model';

// The automated detection over the observability inputs.
export {
  OPERATIONAL_ALERT_ID_GRAMMAR,
  evaluateFailureDetection,
  failureModeMatches,
  healthyTenantObservability,
  isOperationalAlertId,
  operationalAlertIdOf,
  operationalAlertsInScope,
  parseOperationalAlertId,
} from './failures/detect';
export type {
  AdapterHealthView,
  DatabaseObservation,
  FailureDetectionParts,
  FailureDetectionReport,
  LedgerObservation,
  MigrationRunObservation,
  OperationalAlert,
  PersistenceFaultSample,
  PoolObservation,
  TenantObservability,
} from './failures/detect';
