// Office security — THE revocation conformance check (OFF-036, A7/A9).
//
// Drives the REAL app runtime's lifecycle state machine through the full
// revocation discipline and records the typed evidence:
//   - SUSPENSION is the STOP sign: a suspended installation receives NO
//     commands and NO events — both dispatch paths typed-reject with
//     'installation-suspended' BEFORE the gateway (zero gateway calls,
//     zero handler effects), and every rejection is audited;
//   - RE-ACTIVATION restores both streams (canonical state was never
//     deleted — freeze A7): the command dispatches again and the event
//     delivers again;
//   - REVOCATION is one-way and terminal: a revoked installation receives
//     nothing on either path, and re-activation is typed-rejected
//     ('revocation-terminal');
//   - A9 GRANT REVOCATION stops the streams cleanly at the permission
//     layer: revoking the installation's live grant denies the command
//     dispatch with 'capability-revoked' (again BEFORE the gateway) and,
//     with the read grant revoked, the event delivery with
//     'capability-revoked' too.
import { parseCorrelationId } from '@office/contracts';
import type { EntityId, Scope } from '@office/contracts';
import type { ConformanceFailure } from './evidence';
import {
  conformanceFailure,
  conformanceResult,
  rejectionCodeOf,
} from './evidence';
import type { ConformanceCheckResult } from './evidence';
import type { ConformanceHarness } from './harness';
import {
  actorOf,
  appActorOf,
  commandEnvelopeOf,
  domainEventOf,
  expectOk,
} from './harness';

/** The lifecycle phases the revocation check observes. */
export type RevocationPhase =
  | 'suspended'
  | 'reactivated'
  | 'revoked'
  | 'terminal'
  | 'grant-revoked';

/** The surfaces the revocation check drives. */
export type RevocationSurface = 'command' | 'event' | 'lifecycle' | 'permission';

/** One recorded revocation observation with its outcome. */
export interface RevocationProbe {
  /** The probe's label (stable, deterministic). */
  readonly label: string;
  /** Which lifecycle phase the observation belongs to. */
  readonly phase: RevocationPhase;
  /** Which surface was driven. */
  readonly surface: RevocationSurface;
  /** The installation observed. */
  readonly installationId: EntityId;
  /** Was the operation typed-rejected? */
  readonly rejected: boolean;
  /** The typed rejection's detail code, or null. */
  readonly rejectionCode: string | null;
  /** Gateway calls attributable to this probe. */
  readonly gatewayCalls: number;
  /** Committed handler effects attributable to this probe. */
  readonly handlerInvocations: number;
  /** Event deliveries attributable to this probe. */
  readonly deliveries: number;
  /** Did the probe's decision leave its audit envelope? */
  readonly audited: boolean;
}

/** The revocation vocabulary the check expects. */
export const REVOCATION_CODES = [
  'installation-suspended',
  'installation-revoked',
  'revocation-terminal',
  'capability-revoked',
] as const;

/** The fixed operator that suspends/revoke. */
const operatorActor = () => actorOf('user');

/** The tenant scope of one installation (its own tenant — A12). */
const scopeOfInstallation = (harness: ConformanceHarness, installationId: EntityId): Scope => {
  const installation = harness.store.installations.find(installationId);
  if (installation === null) {
    throw new TypeError(`installation ${installationId} not found`);
  }
  return { kind: 'tenant', tenantId: installation.tenantId };
};

/** The next deterministic correlation id of a lifecycle chain. */
const nextCorrelationId = (harness: ConformanceHarness) =>
  expectOk(parseCorrelationId(harness.nextKey()));

/** Dispatch one app command and observe the outcome (counting the effects). */
const dispatchCommandProbe = async (
  harness: ConformanceHarness,
  label: string,
  phase: RevocationPhase,
  installationId: EntityId,
): Promise<RevocationProbe> => {
  const command = commandEnvelopeOf('field.recordProgress', {
    key: harness.nextKey(),
    scope: scopeOfInstallation(harness, installationId),
    actor: appActorOf(installationId),
  });
  const before = {
    gatewayCalls: harness.countedGateway.calls.count,
    handlerInvocations: harness.handlerInvocations.count,
    audit: harness.ledger.size(),
  };
  const decided = await harness.appRuntime.dispatchCommand({
    installationId,
    command,
    evidence: [{ slot: 'observation', ref: 'evidence://field/observation-4' }],
    confidence: 'high',
    subject: null,
    resourceScope: null,
  });
  return {
    label,
    phase,
    surface: 'command',
    installationId,
    rejected: !decided.ok,
    rejectionCode: rejectionCodeOf(decided),
    gatewayCalls: harness.countedGateway.calls.count - before.gatewayCalls,
    handlerInvocations: harness.handlerInvocations.count - before.handlerInvocations,
    deliveries: 0,
    audited: harness.ledger.size() > before.audit,
  };
};

/** Deliver one subscribed event and observe the outcome. */
const dispatchEventProbe = async (
  harness: ConformanceHarness,
  label: string,
  phase: RevocationPhase,
  installationId: EntityId,
): Promise<RevocationProbe> => {
  const event = domainEventOf('work.progressRecorded', {
    scope: scopeOfInstallation(harness, installationId),
    entityKind: 'field-report',
    causationId: harness.nextKey(),
  });
  const before = {
    gatewayCalls: harness.countedGateway.calls.count,
    audit: harness.ledger.size(),
  };
  const delivered = await harness.appRuntime.dispatchEvent({ installationId, event });
  return {
    label,
    phase,
    surface: 'event',
    installationId,
    rejected: !delivered.ok,
    rejectionCode: rejectionCodeOf(delivered),
    gatewayCalls: harness.countedGateway.calls.count - before.gatewayCalls,
    handlerInvocations: 0,
    deliveries: delivered.ok ? 1 : 0,
    audited: harness.ledger.size() > before.audit,
  };
};

/** Drive one lifecycle transition and observe the outcome. */
const lifecycleProbe = async (
  harness: ConformanceHarness,
  label: string,
  phase: RevocationPhase,
  operation: 'suspend' | 'activate' | 'revoke',
  installationId: EntityId,
): Promise<RevocationProbe> => {
  const before = { audit: harness.ledger.size() };
  const correlationId = nextCorrelationId(harness);
  const decided =
    operation === 'suspend'
      ? await harness.appRuntime.suspend({
          installationId,
          by: operatorActor(),
          correlationId,
        })
      : operation === 'activate'
        ? await harness.appRuntime.activate({
            installationId,
            correlationId,
          })
        : await harness.appRuntime.revoke({
            installationId,
            by: operatorActor(),
            correlationId,
          });
  return {
    label,
    phase,
    surface: 'lifecycle',
    installationId,
    rejected: !decided.ok,
    rejectionCode: rejectionCodeOf(decided),
    gatewayCalls: 0,
    handlerInvocations: 0,
    deliveries: 0,
    audited: harness.ledger.size() > before.audit,
  };
};

/** Revoke one live grant of the installation through the REAL runtime. */
const revokeGrantProbe = async (
  harness: ConformanceHarness,
  label: string,
  installationId: EntityId,
  capabilityName: string,
): Promise<RevocationProbe> => {
  const permissions = harness.store.permissions.ofInstallation(installationId);
  const target = permissions.find(
    (permission) => permission.spec.capability === capabilityName,
  );
  if (target === undefined) {
    throw new TypeError(`no ${capabilityName} grant found for installation ${installationId}`);
  }
  const decided = await harness.appRuntime.revokePermission({
    installationId,
    permissionId: target.permissionId,
    revokedBy: operatorActor(),
  });
  return {
    label,
    phase: 'grant-revoked',
    surface: 'permission',
    installationId,
    rejected: !decided.ok,
    rejectionCode: rejectionCodeOf(decided),
    gatewayCalls: 0,
    handlerInvocations: 0,
    deliveries: 0,
    audited: false,
  };
};

/**
 * Drive the full revocation discipline through the REAL app runtime:
 * suspend -> both streams stop; re-activate -> both streams restore;
 * revoke -> both streams stop forever (re-activation typed-rejected);
 * grant revocation -> both streams stop at the permission layer.
 */
export async function driveRevocationProbes(
  harness: ConformanceHarness,
): Promise<readonly RevocationProbe[]> {
  const probes: RevocationProbe[] = [];
  const installationId = harness.installations.a;
  const otherId = harness.installations.b;

  // --- suspension: the STOP sign ---
  probes.push(
    await lifecycleProbe(harness, 'suspend', 'suspended', 'suspend', installationId),
  );
  probes.push(
    await dispatchCommandProbe(harness, 'suspended-command', 'suspended', installationId),
  );
  probes.push(
    await dispatchEventProbe(harness, 'suspended-event', 'suspended', installationId),
  );

  // --- re-activation: the streams restore ---
  probes.push(
    await lifecycleProbe(harness, 'reactivate', 'reactivated', 'activate', installationId),
  );
  probes.push(
    await dispatchCommandProbe(harness, 'reactivated-command', 'reactivated', installationId),
  );
  probes.push(
    await dispatchEventProbe(harness, 'reactivated-event', 'reactivated', installationId),
  );

  // --- revocation: one-way, terminal ---
  probes.push(
    await lifecycleProbe(harness, 'revoke', 'revoked', 'revoke', installationId),
  );
  probes.push(
    await dispatchCommandProbe(harness, 'revoked-command', 'revoked', installationId),
  );
  probes.push(
    await dispatchEventProbe(harness, 'revoked-event', 'revoked', installationId),
  );
  probes.push(
    await lifecycleProbe(harness, 'activate-after-revoke', 'terminal', 'activate', installationId),
  );

  // --- A9 grant revocation (the second, still-active installation) ---
  probes.push(
    await revokeGrantProbe(harness, 'revoke-work-write-grant', otherId, 'work.write'),
  );
  probes.push(
    await dispatchCommandProbe(harness, 'grant-revoked-command', 'grant-revoked', otherId),
  );
  probes.push(
    await revokeGrantProbe(harness, 'revoke-work-read-grant', otherId, 'work.read'),
  );
  probes.push(
    await dispatchEventProbe(harness, 'grant-revoked-event', 'grant-revoked', otherId),
  );

  return probes;
}

/** The expected outcome of one probe, by phase + surface (pure). */
const expectationOf = (
  probe: RevocationProbe,
): { rejected: boolean; rejectionCode: string | null; effects: boolean } => {
  switch (probe.phase) {
    case 'suspended':
      // The lifecycle transition itself SUCCEEDS (and is audited); both
      // dispatch streams typed-reject with 'installation-suspended'.
      return probe.surface === 'lifecycle'
        ? { rejected: false, rejectionCode: null, effects: false }
        : { rejected: true, rejectionCode: 'installation-suspended', effects: false };
    case 'reactivated':
      // Re-activation succeeds; both streams restore (effects observed).
      return probe.surface === 'lifecycle'
        ? { rejected: false, rejectionCode: null, effects: false }
        : { rejected: false, rejectionCode: null, effects: true };
    case 'revoked':
      // The revocation transition itself SUCCEEDS (and is audited); both
      // dispatch streams typed-reject with 'installation-revoked'.
      return probe.surface === 'lifecycle'
        ? { rejected: false, rejectionCode: null, effects: false }
        : { rejected: true, rejectionCode: 'installation-revoked', effects: false };
    case 'terminal':
      // Re-activation after revocation is typed-rejected, one-way.
      return { rejected: true, rejectionCode: 'revocation-terminal', effects: false };
    case 'grant-revoked':
      // The A9 grant revocation succeeds; the streams stop at the permission layer.
      return probe.surface === 'permission'
        ? { rejected: false, rejectionCode: null, effects: false }
        : { rejected: true, rejectionCode: 'capability-revoked', effects: false };
  }
};

/**
 * Evaluate the revocation evidence (pure, deterministic): suspension stops
 * both streams pre-gateway and audited; re-activation restores them;
 * revocation stops them terminally (re-activation typed-rejected); revoked
 * grants stop the streams cleanly at the permission layer.
 */
export function evaluateRevocation(
  probes: readonly RevocationProbe[],
): ConformanceCheckResult {
  const failures: ConformanceFailure[] = [];
  for (const probe of probes) {
    const expectation = expectationOf(probe);
    if (probe.rejected !== expectation.rejected) {
      failures.push(
        conformanceFailure(
          probe.label,
          expectation.rejected ? 'revocation-not-enforced' : 'revocation-over-enforced',
          `expected rejected=${expectation.rejected} (${probe.phase}/${probe.surface}), observed rejected=${probe.rejected} (${probe.rejectionCode ?? 'no rejection'})`,
        ),
      );
    }
    if (
      expectation.rejectionCode !== null &&
      probe.rejectionCode !== expectation.rejectionCode
    ) {
      failures.push(
        conformanceFailure(
          probe.label,
          'wrong-rejection-code',
          `expected the revocation code '${expectation.rejectionCode}', observed '${probe.rejectionCode}'`,
        ),
      );
    }
    if (!expectation.effects) {
      if (probe.handlerInvocations !== 0 || probe.deliveries !== 0) {
        failures.push(
          conformanceFailure(
            probe.label,
            'side-effect-committed',
            `a stopped installation/stream must receive nothing — observed ${probe.handlerInvocations} handler invocation(s), ${probe.deliveries} delivery/deliveries`,
          ),
        );
      }
      if (probe.surface !== 'lifecycle' && probe.surface !== 'permission' && probe.gatewayCalls !== 0) {
        failures.push(
          conformanceFailure(
            probe.label,
            'gateway-reached',
            `${probe.gatewayCalls} gateway call(s) for a stopped stream (the rejection must happen before the gateway)`,
          ),
        );
      }
    } else if (probe.surface === 'command' && probe.handlerInvocations !== 1) {
      failures.push(
        conformanceFailure(
          probe.label,
          'stream-not-restored',
          `a re-activated installation must dispatch again — observed ${probe.handlerInvocations} handler invocation(s)`,
        ),
      );
    } else if (probe.surface === 'event' && probe.deliveries !== 1) {
      failures.push(
        conformanceFailure(
          probe.label,
          'stream-not-restored',
          `a re-activated installation must receive events again — observed ${probe.deliveries} delivery/deliveries`,
        ),
      );
    }
    if (probe.surface === 'command' || probe.surface === 'event') {
      if (!probe.audited) {
        failures.push(
          conformanceFailure(
            probe.label,
            'decision-not-audited',
            'the dispatch/delivery decision left no audit envelope (A3)',
          ),
        );
      }
    }
    if (probe.surface === 'lifecycle' && !probe.rejected && !probe.audited) {
      failures.push(
        conformanceFailure(
          probe.label,
          'decision-not-audited',
          'the lifecycle transition left no audit envelope (A3)',
        ),
      );
    }
  }
  return conformanceResult('revocation', probes.length, failures);
}
