// Office intelligence — package-internal test support (OFF-034).
//
// NOT part of the public surface: deterministic factories for the typed
// values the golden procurement scenarios need — the fixed clock/tenant/
// project/actor identities, the deterministic ledger event ids the margin
// assessment fixtures cite, the memory outcome/benchmark identities, the
// procurement scan identity, and the procurement authorizations. Fixed
// clock, fixed ids, fixed correlation/causation tokens: no Date.now, no
// Math.random, no environment. The single branded-value cast (the ledger
// event ids the assessment fixtures cite) is the trusted fixture path:
// every emitted envelope re-validates those ids through @office/contracts'
// canonical parsers, so a malformed fixture can never silently pass.
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseEventName,
  parseTimestamp,
} from '@office/contracts';
import type { Actor, EntityId, EventName, Scope, Timestamp } from '@office/contracts';
import { authorizationContext, definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import type { ImpactAssessment, SourceEventReference } from '@office/intelligence-margin';
import { parseAssessmentId } from '@office/intelligence-margin';
import type { AssessmentId } from '@office/intelligence-margin';
import { parseBenchmarkId, parseOutcomeId } from '@office/intelligence-memory';
import type { BenchmarkId, OutcomeId } from '@office/intelligence-memory';
import { parseProcurementScanId } from './vocabulary';
import type { ProcurementScanId } from './vocabulary';
import type { ProcurementAuthorization } from './authorization';

/** Unwrap a typed Result (failures are test bugs — loud, never silent). */
export const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

/** The fixed test clock (deterministic — replayed streams replay exactly). */
export const T0: Timestamp = unwrap(parseTimestamp('2026-09-12T08:00:00.000Z'));
export const T1: Timestamp = unwrap(parseTimestamp('2026-09-13T09:30:00.000Z'));
export const T2: Timestamp = unwrap(parseTimestamp('2026-09-14T11:45:00.000Z'));
export const T3: Timestamp = unwrap(parseTimestamp('2026-09-15T14:15:00.000Z'));
export const T4: Timestamp = unwrap(parseTimestamp('2026-09-16T16:45:00.000Z'));
export const T5: Timestamp = unwrap(parseTimestamp('2026-09-17T10:00:00.000Z'));

/** The fixed assessment clock (the injected `assessedAt` of every golden). */
export const ASSESSED_AT: Timestamp = unwrap(parseTimestamp('2026-09-18T09:00:00.000Z'));

/** The fixed detection clock (the injected `detectedAt` of every golden scan). */
export const DETECTED_AT: Timestamp = unwrap(parseTimestamp('2026-09-19T09:00:00.000Z'));

/** The fixed record/compute clocks of the history fixtures (injected). */
export const RECORDED_AT: Timestamp = unwrap(parseTimestamp('2026-09-20T09:00:00.000Z'));
export const COMPUTED_AT: Timestamp = unwrap(parseTimestamp('2026-09-21T09:00:00.000Z'));

/** Two tenants (A12 isolation tests run in BOTH directions). */
export const TENANT_A = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
export const TENANT_B = formatTenantId({
  version: 'v1',
  opaque: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
});

/** Two projects of tenant A (the live portfolio + the completed history). */
export const PROJECT_1 = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
export const PROJECT_2 = formatProjectId({
  version: 'v1',
  opaque: 'a9f8e7d6c5b4a39281706f5e4d3c2b10',
});

/** The fixed acting user (a canonical actor, not a provider identity). */
export const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
export const USER_ACTOR: Actor = { kind: 'user', actorId: ACTOR_ID };

export const projectOneScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_1,
});

export const projectTwoScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_2,
});

export const tenantAScope = (): Scope => ({
  kind: 'tenant',
  tenantId: TENANT_A,
});

export const tenantBScope = (): Scope => ({
  kind: 'tenant',
  tenantId: TENANT_B,
});

/** Deterministic entity ids: <prefix><n> padded to the 16-char opaque minimum. */
export const testId = (prefix: string, n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

/** Deterministic correlation ids (one per causal chain). */
export const testCorrelationId = (n: number): string => `corr-${String(n).padStart(8, '0')}`;

/**
 * Deterministic ledger event ids (the producing events the assessment
 * fixtures cite) — the events package's canonical grammar
 * `office-evt-v1-<opaque>`, cast through the assessment source's own
 * branded type (the trusted fixture path; every emitted envelope
 * re-validates the id through the contracts parser).
 */
export const testLedgerEventId = (
  n: number,
): ImpactAssessment['source']['eventId'] =>
  `office-evt-v1-${String(n).padStart(16, '0')}` as ImpactAssessment['source']['eventId'];

/** Deterministic ledger event source refs (the producing events fixtures cite). */
export const sourceRef = (
  eventId: ImpactAssessment['source']['eventId'],
  eventName: string,
  occurredAt: Timestamp,
): SourceEventReference => ({
  eventId,
  eventName: unwrap(parseEventName(eventName)) as EventName,
  occurredAt,
});

/** Deterministic assessment identities (the injected tokens of the goldens). */
export const testAssessmentId = (n: number): AssessmentId =>
  unwrap(parseAssessmentId(`assessment-${String(n).padStart(4, '0')}`));

/** Deterministic outcome identities (the history fixture tokens). */
export const testOutcomeId = (n: number): OutcomeId =>
  unwrap(parseOutcomeId(`outcome-${String(n).padStart(4, '0')}`));

/** Deterministic benchmark identities (the history fixture tokens). */
export const testBenchmarkId = (n: number): BenchmarkId =>
  unwrap(parseBenchmarkId(`benchmark-${String(n).padStart(4, '0')}`));

/** Deterministic scan identities (the injected tokens of the golden scans). */
export const testScanId = (n: number): ProcurementScanId =>
  unwrap(parseProcurementScanId(`scan-${String(n).padStart(4, '0')}`));

// ---------------------------------------------------------------------------
// Procurement-authorization factories (deterministic, deny-by-default probes).
// ---------------------------------------------------------------------------

/** Every area read capability a procurement scan/read requires. */
export const ALL_PROCUREMENT_CAPABILITIES: readonly string[] = [
  'organization.read',
  'projects.read',
  'documents.read',
  'work.read',
  'schedule.read',
  'cost.read',
  'contracts.read',
];

/** The allow-all-reads policy: every read within the caller's covered scope. */
export const ALLOW_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'allow', actions: ['read'] },
]);

/** The explicit-deny-every-read policy (explicit deny wins over any allow). */
export const DENY_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'deny', actions: ['read'] },
]);

/** The empty policy — no rules at all (deny-by-default, 'no-allow-rule'). */
export const EMPTY_POLICY: Policy = definePolicy([]);

/**
 * A procurement authorization for the fixed test user: the given scope, the
 * given capabilities (default: every area read), and the given policy
 * (default: allow-all-reads). Capability/policy combos are the A12 and
 * capability-missing probes of the procurement tests.
 */
export const procurementAuthorizationOf = (
  scope: Scope,
  parts: {
    readonly capabilities?: readonly string[];
    readonly policy?: Policy;
  } = {},
): ProcurementAuthorization => ({
  policy: parts.policy ?? ALLOW_ALL_READS_POLICY,
  context: authorizationContext({
    actor: USER_ACTOR,
    scope,
    capabilities: parts.capabilities ?? ALL_PROCUREMENT_CAPABILITIES,
  }),
});

/**
 * The tenant-A reader the golden scan runs under (the procurement lead
 * reviewing the tenant's sourcing portfolio: covers the live project-1
 * needs AND the project-2 completed history).
 */
export const tenantReader = (): ProcurementAuthorization =>
  procurementAuthorizationOf(tenantAScope());

/** The project-one reader (the A12 project-boundary probes). */
export const projectOneReader = (): ProcurementAuthorization =>
  procurementAuthorizationOf(projectOneScope());

/** The tenant-B reader (the A12 cross-tenant probes, both directions). */
export const tenantBReader = (): ProcurementAuthorization =>
  procurementAuthorizationOf(tenantBScope());
