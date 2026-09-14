// Office host gateway — public surface (OFF-DEPLOY).
//
// src/index.ts is the package's WHOLE public surface: apps/host (and any
// future server host) consume the package only through this root entry
// point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package is THE gateway component of the typed deployment topology
// (packages/operations/src/topology/model.ts) made runnable: the pg pool,
// the forward-only migrator over the ordered union of every landed
// migration directory, the canonical PG path (tenants/organizations/projects
// repositories + their lifecycle command services + the real event ledger +
// outbox), the @office/web session/view-model/command surface driven
// server-side over the deterministic seeded reference world, and the REAL A8
// action gateway with the approval-gated workflow decision. It is the ONLY
// workspace package apps/host may import besides @office/web (all SQL lives
// here; the browser host stays structurally database-free).
//
// Composed ONLY through the workspace packages' public root entry points
// (verified by the package's boundary self-gate suite). Deterministic
// compositions: every
// clock and canonical-id supplier is injected; the hosted seed identities
// are fixed literals. Typed Results everywhere; request-shaped inputs are
// parsed fail-closed through this surface's exported parsers or through the
// landed contracts parsers — never trusted, never a throw.
//
// Surface summary:
// - runtime:     createHostRuntime (+ HostRuntime, HostRuntimeOptions,
//                HealthReport, HostOperationalFailure) — THE composition;
//                the hosted identities + default release id constants
// - migrations:  composeCanonicalMigrations (+ ComposedMigrationChain,
//                ComposedChainFailure, LANDED_MIGRATION_DIRS) — the ordered
//                union of every landed migration directory, materialized
//                for @office/persistence's migrator
// - inputs:      the fail-closed request parsers + their typed shapes
//                (HostInputRejection, UpdateProjectRequest,
//                ApprovalDecisionRequest) — what the host's route layer
//                parses untrusted JSON with
// - approvals:   APPROVAL_DECISION_DESCRIPTOR — the registered
//                approval-gated action (the shell's workflow approval
//                decision) — plus its helpers for advanced callers
// - ledger sink: createLedgerAuditSink (+ LedgerAuditSink) — the
//                transactional ledger + outbox EventSink the canonical
//                command path and the A8 audit trail append through

// THE composition + its typed shapes.
export { createHostRuntime } from './runtime';
export type {
  ApprovalActionSurface,
  CanonicalCommandParts,
  CanonicalPgSurface,
  HealthReport,
  HostOperationalFailure,
  HostRuntime,
  HostRuntimeOptions,
} from './runtime';
export {
  DEFAULT_RELEASE_ID,
  HOST_ACTOR_ID,
  HOST_CORRELATION_ID,
  HOST_PROJECT_ID,
  HOST_TENANT_ID,
} from './runtime';

// The composed canonical migration chain.
export { composeCanonicalMigrations } from './migrations';
export type {
  ComposedChainFailure,
  ComposedMigrationChain,
} from './migrations';
export { LANDED_MIGRATION_DIRS } from './migrations';

// The fail-closed request parsers (the host's route layer boundary).
export {
  parseAdvanceWorkflowRequest,
  parseApprovalDecisionRequest,
  parseApprovalReferenceInput,
  parseApproveWorkflowApprovalRequest,
  parseCaptureFieldObservationRequest,
  parseRecordCostItemRequest,
  parseSubmitWorkflowApprovalRequest,
  parseUpdateProjectRequest,
} from './inputs';
export type {
  ApprovalDecisionRequest,
  HostInputRejection,
  UpdateProjectRequest,
} from './inputs';

// The A8 approval-gated action (registered descriptor + proposal helpers).
export {
  APPROVAL_DECISION_DESCRIPTOR,
  composeApprovalDecisionProposal,
  createApprovalDecisionHandler,
  driveRoutedApprovalToApproved,
  resolveApprovalActionKey,
} from './approvals';
export type {
  ApprovalHandlerParts,
  ApprovalProposalParts,
  RoutedApprovalParts,
} from './approvals';

// The transactional ledger + outbox audit sink.
export { createLedgerAuditSink } from './ledger-sink';
export type { LedgerAuditSink } from './ledger-sink';
