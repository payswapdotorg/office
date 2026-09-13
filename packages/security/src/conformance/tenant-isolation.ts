// Office security — THE tenant-isolation conformance check (OFF-036, A12).
//
// Drives the REAL gateway + REAL app runtime through cross-tenant attempts
// — both directions (tenant A -> tenant B and tenant B -> tenant A) on all
// three surfaces, plus a cross-PROJECT attempt through the gateway (the
// project is the second authorization boundary) — and records the typed
// evidence: the observed rejection, the side effects attributable to the
// attempt (gateway calls, handler invocations, event deliveries), and where
// the attempt's audit envelopes landed (the REQUESTING tenant's trail —
// never the foreign tenant's).
//
// The pure evaluator turns the evidence into the typed check result:
//   - every cross-scope attempt is typed-rejected with the A12 vocabulary
//     ('tenant-scope-violation' / 'project-scope-violation' through the
//     gateway's authorize(), 'cross-tenant-scope' through the app runtime's
//     pre-gateway gates) — even under an ALLOW-ALL policy, because the
//     structural scope check runs before any rule is consulted;
//   - ZERO committed effects (no handler invocations, no deliveries) and,
//     on the app surfaces, ZERO gateway calls (the rejection happens BEFORE
//     the gateway is ever reached);
//   - the rejection IS audited, in the requesting tenant's trail (A3);
//   - NOTHING leaks into the foreign tenant's trail.
import { actionProposal } from '@office/actions';
import type { Scope, TenantId } from '@office/contracts';
import type { ConformanceFailure } from './evidence';
import {
  conformanceFailure,
  conformanceResult,
  rejectionCodeOf,
} from './evidence';
import type { ConformanceCheckResult } from './evidence';
import type { ConformanceHarness } from './harness';
import {
  allowAllPolicy,
  appActorOf,
  commandEnvelopeOf,
  domainEventOf,
  projectOneScope,
  tenantAScope,
  tenantBScope,
} from './harness';

/** The isolation directions the check probes. */
export type IsolationDirection = 'a-to-b' | 'b-to-a' | 'cross-project';

/** The surfaces the check drives cross-tenant attempts through. */
export type IsolationSurface = 'gateway-command' | 'app-command' | 'app-event';

/** One recorded cross-tenant attempt with its observed outcome. */
export interface TenantIsolationProbe {
  /** The probe's label (stable, deterministic). */
  readonly label: string;
  /** Which boundary direction was attempted. */
  readonly direction: IsolationDirection;
  /** Which surface the attempt went through. */
  readonly surface: IsolationSurface;
  /** The tenant the attempt executed under (whose trail the audit lands in). */
  readonly requestingTenantId: TenantId;
  /** The foreign tenant whose scope was addressed. */
  readonly foreignTenantId: TenantId | null;
  /** Was the attempt typed-rejected? */
  readonly rejected: boolean;
  /** The typed rejection's detail code, or null. */
  readonly rejectionCode: string | null;
  /** Gateway calls attributable to this attempt. */
  readonly gatewayCalls: number;
  /** Committed handler effects attributable to this attempt. */
  readonly handlerInvocations: number;
  /** Event deliveries attributable to this attempt. */
  readonly deliveries: number;
  /** Audit envelopes the attempt produced in the REQUESTING tenant's trail. */
  readonly auditInRequestingTenant: number;
  /** Audit envelopes the attempt produced in the FOREIGN tenant's trail (must be 0). */
  readonly auditInForeignTenant: number;
}

/** The A12 rejection vocabulary (both surfaces' cross-scope denial codes). */
export const TENANT_ISOLATION_CODES = [
  'tenant-scope-violation',
  'project-scope-violation',
  'cross-tenant-scope',
] as const;

/** The rejection code a probe's surface + direction must observe. */
const expectedCodeOf = (probe: {
  readonly surface: IsolationSurface;
  readonly direction: IsolationDirection;
}): string => {
  if (probe.surface === 'gateway-command') {
    return probe.direction === 'cross-project' ? 'project-scope-violation' : 'tenant-scope-violation';
  }
  return 'cross-tenant-scope';
};

/** The counter/ledger snapshot taken before one attempt. */
interface ProbeBaseline {
  readonly gatewayCalls: number;
  readonly handlerInvocations: number;
  readonly auditRequesting: number;
  readonly auditForeign: number;
}

const baselineOf = (harness: ConformanceHarness, probe: TenantIsolationProbe): ProbeBaseline => ({
  gatewayCalls: harness.countedGateway.calls.count,
  handlerInvocations: harness.handlerInvocations.count,
  auditRequesting: harness.ledger.eventsOfTenant(probe.requestingTenantId).length,
  auditForeign:
    probe.foreignTenantId === null ? 0 : harness.ledger.eventsOfTenant(probe.foreignTenantId).length,
});

/** Assemble the probe from the post-attempt counters (pure). */
const probeOf = (
  harness: ConformanceHarness,
  probe: TenantIsolationProbe,
  baseline: ProbeBaseline,
  observed: { readonly rejected: boolean; readonly rejectionCode: string | null; readonly delivered: boolean },
): TenantIsolationProbe => ({
  ...probe,
  rejected: observed.rejected,
  rejectionCode: observed.rejectionCode,
  gatewayCalls: harness.countedGateway.calls.count - baseline.gatewayCalls,
  handlerInvocations: harness.handlerInvocations.count - baseline.handlerInvocations,
  deliveries: observed.delivered ? 1 : 0,
  auditInRequestingTenant:
    harness.ledger.eventsOfTenant(probe.requestingTenantId).length - baseline.auditRequesting,
  auditInForeignTenant:
    probe.foreignTenantId === null
      ? 0
      : harness.ledger.eventsOfTenant(probe.foreignTenantId).length - baseline.auditForeign,
});

/** One gateway-level cross-scope attempt (the authorize() structural gate). */
const gatewayProbe = async (
  harness: ConformanceHarness,
  label: string,
  direction: IsolationDirection,
): Promise<TenantIsolationProbe> => {
  const commandScope = direction === 'b-to-a' ? tenantBScope() : projectOneScope();
  const resourceScope: Scope =
    direction === 'a-to-b'
      ? tenantBScope()
      : direction === 'b-to-a'
        ? tenantAScope()
        : { kind: 'project', tenantId: commandScope.tenantId, projectId: harness.projects.two };
  const draft: TenantIsolationProbe = {
    label,
    direction,
    surface: 'gateway-command',
    requestingTenantId: commandScope.tenantId,
    foreignTenantId: direction === 'cross-project' ? null : resourceScope.tenantId,
    rejected: false,
    rejectionCode: null,
    gatewayCalls: 0,
    handlerInvocations: 0,
    deliveries: 0,
    auditInRequestingTenant: 0,
    auditInForeignTenant: 0,
  };
  const baseline = baselineOf(harness, draft);
  const key = harness.nextKey();
  const command = commandEnvelopeOf('cost.listCostItems', {
    key,
    scope: commandScope,
  });
  const proposal = actionProposal({
    command,
    subject: null,
    evidence: [],
    confidence: 'certain',
    resourceScope,
    approval: null,
  });
  const decided = await harness.gateway.executeAction(proposal, {
    // ALLOW-ALL on purpose: no policy rule can allow a cross-scope access —
    // the structural A12 check runs before any rule is consulted.
    policy: allowAllPolicy,
    capabilities: ['cost.read'],
  });
  return probeOf(harness, draft, baseline, {
    rejected: !decided.ok,
    rejectionCode: rejectionCodeOf(decided),
    delivered: false,
  });
};

/** One app-runtime command attempt (the pre-gateway tenant gate). */
const appCommandProbe = async (
  harness: ConformanceHarness,
  label: string,
  direction: IsolationDirection,
): Promise<TenantIsolationProbe> => {
  const installationId = direction === 'b-to-a' ? harness.installations.b : harness.installations.a;
  const installation = harness.store.installations.find(installationId);
  if (installation === null) throw new TypeError(`installation ${installationId} not found`);
  const commandScope = direction === 'b-to-a' ? tenantAScope() : tenantBScope();
  const draft: TenantIsolationProbe = {
    label,
    direction,
    surface: 'app-command',
    requestingTenantId: installation.tenantId,
    foreignTenantId: commandScope.tenantId,
    rejected: false,
    rejectionCode: null,
    gatewayCalls: 0,
    handlerInvocations: 0,
    deliveries: 0,
    auditInRequestingTenant: 0,
    auditInForeignTenant: 0,
  };
  const baseline = baselineOf(harness, draft);
  const command = commandEnvelopeOf('field.recordProgress', {
    key: harness.nextKey(),
    scope: commandScope,
    actor: appActorOf(installationId),
  });
  const decided = await harness.appRuntime.dispatchCommand({
    installationId,
    command,
    evidence: [{ slot: 'observation', ref: 'evidence://field/observation-1' }],
    confidence: 'high',
    subject: null,
    resourceScope: null,
  });
  return probeOf(harness, draft, baseline, {
    rejected: !decided.ok,
    rejectionCode: rejectionCodeOf(decided),
    delivered: false,
  });
};

/** One app-runtime event-delivery attempt (the tenant gate on the event side). */
const appEventProbe = async (
  harness: ConformanceHarness,
  label: string,
  direction: IsolationDirection,
): Promise<TenantIsolationProbe> => {
  const installationId = direction === 'b-to-a' ? harness.installations.b : harness.installations.a;
  const installation = harness.store.installations.find(installationId);
  if (installation === null) throw new TypeError(`installation ${installationId} not found`);
  const eventScope = direction === 'b-to-a' ? tenantAScope() : tenantBScope();
  const draft: TenantIsolationProbe = {
    label,
    direction,
    surface: 'app-event',
    requestingTenantId: installation.tenantId,
    foreignTenantId: eventScope.tenantId,
    rejected: false,
    rejectionCode: null,
    gatewayCalls: 0,
    handlerInvocations: 0,
    deliveries: 0,
    auditInRequestingTenant: 0,
    auditInForeignTenant: 0,
  };
  const baseline = baselineOf(harness, draft);
  const event = domainEventOf('work.progressRecorded', {
    scope: eventScope,
    entityKind: 'field-report',
    causationId: harness.nextKey(),
  });
  const delivered = await harness.appRuntime.dispatchEvent({ installationId, event });
  return probeOf(harness, draft, baseline, {
    rejected: !delivered.ok,
    rejectionCode: rejectionCodeOf(delivered),
    delivered: delivered.ok,
  });
};

/**
 * Drive the tenant-isolation probes through the REAL gateway + REAL app
 * runtime: both tenant directions on all three surfaces, plus the
 * cross-project direction through the gateway.
 */
export async function driveTenantIsolationProbes(
  harness: ConformanceHarness,
): Promise<readonly TenantIsolationProbe[]> {
  return [
    await gatewayProbe(harness, 'gateway-a-to-b', 'a-to-b'),
    await gatewayProbe(harness, 'gateway-b-to-a', 'b-to-a'),
    await gatewayProbe(harness, 'gateway-cross-project', 'cross-project'),
    await appCommandProbe(harness, 'app-command-a-to-b', 'a-to-b'),
    await appCommandProbe(harness, 'app-command-b-to-a', 'b-to-a'),
    await appEventProbe(harness, 'app-event-a-to-b', 'a-to-b'),
    await appEventProbe(harness, 'app-event-b-to-a', 'b-to-a'),
  ];
}

/**
 * Evaluate the tenant-isolation evidence (pure, deterministic): every
 * cross-scope attempt typed-rejected with the A12 vocabulary, zero
 * committed effects, pre-gateway rejections on the app surfaces, the
 * rejection audited in the REQUESTING tenant's trail, and nothing in the
 * foreign tenant's.
 */
export function evaluateTenantIsolation(
  probes: readonly TenantIsolationProbe[],
): ConformanceCheckResult {
  const failures: ConformanceFailure[] = [];
  for (const probe of probes) {
    const expectedCode = expectedCodeOf(probe);
    if (!probe.rejected) {
      failures.push(
        conformanceFailure(
          probe.label,
          'cross-scope-attempt-accepted',
          `a ${probe.direction} attempt through ${probe.surface} was not rejected (A12 violated)`,
        ),
      );
      continue;
    }
    if (probe.rejectionCode !== expectedCode) {
      failures.push(
        conformanceFailure(
          probe.label,
          'wrong-rejection-code',
          `expected the A12 code '${expectedCode}', observed '${probe.rejectionCode}'`,
        ),
      );
    }
    if (probe.handlerInvocations !== 0) {
      failures.push(
        conformanceFailure(
          probe.label,
          'side-effect-committed',
          `${probe.handlerInvocations} handler invocation(s) committed for a cross-scope attempt`,
        ),
      );
    }
    if (probe.deliveries !== 0) {
      failures.push(
        conformanceFailure(
          probe.label,
          'side-effect-committed',
          `${probe.deliveries} event delivery/deliveries committed for a cross-scope attempt`,
        ),
      );
    }
    if (probe.surface !== 'gateway-command' && probe.gatewayCalls !== 0) {
      failures.push(
        conformanceFailure(
          probe.label,
          'gateway-reached',
          `${probe.gatewayCalls} gateway call(s) for a pre-gateway rejection (the attempt must die at the runtime's tenant gate)`,
        ),
      );
    }
    if (probe.surface === 'gateway-command' && probe.gatewayCalls !== 1) {
      failures.push(
        conformanceFailure(
          probe.label,
          'gateway-not-consulted',
          `a gateway-surface attempt must produce exactly one gateway decision, observed ${probe.gatewayCalls}`,
        ),
      );
    }
    if (probe.auditInRequestingTenant < 1) {
      failures.push(
        conformanceFailure(
          probe.label,
          'rejection-not-audited',
          "the typed rejection produced no audit envelope in the requesting tenant's trail (A3)",
        ),
      );
    }
    if (probe.auditInForeignTenant !== 0) {
      failures.push(
        conformanceFailure(
          probe.label,
          'audit-leaked-to-foreign-tenant',
          `${probe.auditInForeignTenant} audit envelope(s) landed in the foreign tenant's trail`,
        ),
      );
    }
  }
  return conformanceResult('tenant-isolation', probes.length, failures);
}
