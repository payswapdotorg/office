// Office security — THE authorization-boundary conformance check (OFF-036).
//
// Drives the REAL gateway through the deny-by-default matrix across EVERY
// actor kind of the contracts vocabulary ('user' | 'agent' | 'app' |
// 'adapter' | 'system'): no actor kind bypasses authorization — the very
// same @office/authz authorize() evaluator runs for all of them, and the
// descriptor's own actor-kind gate rejects undeclared kinds for any policy.
//
// The matrix probes:
//   - DENY-BY-DEFAULT: an EMPTY policy (no allow rule at all) denies every
//     actor kind ('no-allow-rule') — with full capabilities held;
//   - EXPLICIT DENY: a deny-write policy denies write-class actions for
//     every actor kind ('explicit-deny') while READ still executes (the
//     action split — deny rules are action-scoped);
//   - CAPABILITY GATE: a missing required capability denies BEFORE the
//     policy ('missing-required-capability'), full policy or not;
//   - ACTOR-KIND GATE: an action declared for human actors only
//     ('documents.submitDailyLog') rejects every non-human actor kind —
//     including 'system' — with an allow-all policy and full capabilities
//     ('actor-kind-not-permitted'): THE no-bypass proof;
//   - FAIL-CLOSED CLASSIFICATION: an unknown command is prohibited by
//     default ('unknown-action'); a prohibited-class action never executes
//     ('prohibited-action') — for any actor, under any policy.
// Every denial must carry its audit envelope (A3) and zero handler effects.
import type { ActorKind } from '@office/contracts';
import { actionProposal } from '@office/actions';
import type { ConformanceFailure } from './evidence';
import {
  conformanceFailure,
  conformanceResult,
  observedDecisionOf,
  rejectionCodeOf,
} from './evidence';
import type { ConformanceCheckResult } from './evidence';
import type { ConformanceHarness } from './harness';
import {
  ADAPTER,
  AGENT,
  APP_ID_A,
  USER,
  actorOf,
  allowAllPolicy,
  commandEnvelopeOf,
  denyWritePolicy,
  emptyPolicy,
  subjectRef,
} from './harness';

/** The policy fixtures the matrix drives (their fail-closed semantics). */
export type BoundaryPolicyKind = 'empty' | 'allow-all' | 'explicit-deny-write';

/** The capability fixtures the matrix drives. */
export type BoundaryCapabilityKind = 'full' | 'missing-required';

/** The expected normalized outcome of one probe. */
export type BoundaryExpectation = 'denied' | 'executed' | 'routed';

/** One recorded authorization-boundary probe with its observed outcome. */
export interface AuthorizationBoundaryProbe {
  /** The probe's label (stable, deterministic). */
  readonly label: string;
  /** The actor kind the probe dispatched under. */
  readonly actorKind: ActorKind;
  /** The command the probe proposed. */
  readonly commandName: string;
  /** The policy fixture the probe used. */
  readonly policy: BoundaryPolicyKind;
  /** The capability fixture the probe used. */
  readonly capabilities: BoundaryCapabilityKind;
  /** The outcome the boundary must produce. */
  readonly expected: BoundaryExpectation;
  /** The rejection code the boundary must produce (denied probes only). */
  readonly expectedRejectionCode: string | null;
  /** The observed normalized outcome. */
  readonly observed: 'executed' | 'routed' | 'denied' | 'other';
  /** The observed rejection's detail code, or null. */
  readonly rejectionCode: string | null;
  /** Handler invocations attributable to this probe. */
  readonly handlerInvocations: number;
  /** Did the probe's decision leave its audit envelope (gateway sink)? */
  readonly audited: boolean;
}

/** The authorization-boundary denial vocabulary the check expects. */
export const AUTHORIZATION_BOUNDARY_CODES = [
  'no-allow-rule',
  'explicit-deny',
  'missing-required-capability',
  'actor-kind-not-permitted',
  'unknown-action',
  'prohibited-action',
] as const;

const ACTOR_KINDS: readonly ActorKind[] = ['user', 'agent', 'app', 'adapter', 'system'];

/** The authorization fixture of one policy/capability combination. */
const authorizationOf = (
  policy: BoundaryPolicyKind,
  capabilities: BoundaryCapabilityKind,
) => ({
  policy:
    policy === 'empty' ? emptyPolicy : policy === 'allow-all' ? allowAllPolicy : denyWritePolicy,
  capabilities: capabilities === 'full' ? fullCapabilitiesOf() : [],
});

const fullCapabilitiesOf = (): readonly string[] => [
  'cost.read',
  'cost.write',
  'work.read',
  'work.write',
  'documents.write',
];

/** The actor id fixture of one kind (the system actor carries none). */
const actorIdOf = (kind: ActorKind) => {
  if (kind === 'user') return USER;
  if (kind === 'agent') return AGENT;
  if (kind === 'app') return APP_ID_A;
  if (kind === 'adapter') return ADAPTER;
  return null;
};

/** Drive ONE probe through the REAL gateway and record the evidence. */
const probe = async (
  harness: ConformanceHarness,
  parts: {
    readonly label: string;
    readonly actorKind: ActorKind;
    readonly commandName: string;
    readonly policy: BoundaryPolicyKind;
    readonly capabilities: BoundaryCapabilityKind;
    readonly expected: BoundaryExpectation;
    readonly expectedRejectionCode: string | null;
    readonly evidence?: readonly { readonly slot: string; readonly ref: string }[];
    readonly confidence?: string;
    readonly subject?: boolean;
  },
): Promise<AuthorizationBoundaryProbe> => {
  const actorId = actorIdOf(parts.actorKind);
  const command = commandEnvelopeOf(parts.commandName, {
    key: harness.nextKey(),
    actor: actorId === null ? actorOf('system') : actorOf(parts.actorKind, actorId),
  });
  const proposal = actionProposal({
    command,
    subject: parts.subject === true ? subjectRef() : null,
    evidence: parts.evidence ?? [],
    confidence: parts.confidence ?? 'certain',
    resourceScope: null,
    approval: null,
  });
  const authorization = authorizationOf(parts.policy, parts.capabilities);
  const handlerBefore = harness.handlerInvocations.count;
  const sinkBefore = harness.gatewaySink.events.length;
  const decided = await harness.gateway.executeAction(proposal, authorization);
  const audited = harness.gatewaySink.events.length > sinkBefore;
  return {
    label: parts.label,
    actorKind: parts.actorKind,
    commandName: parts.commandName,
    policy: parts.policy,
    capabilities: parts.capabilities,
    expected: parts.expected,
    expectedRejectionCode: parts.expectedRejectionCode,
    observed: observedDecisionOf(decided),
    rejectionCode: rejectionCodeOf(decided),
    handlerInvocations: harness.handlerInvocations.count - handlerBefore,
    audited,
  };
};

/**
 * Drive the deny-by-default matrix across every actor kind through the REAL
 * gateway: empty-policy denials, explicit-deny writes (reads still execute),
 * missing-capability denials, the actor-kind gate (no kind bypasses — system
 * included), fail-closed classification (unknown command), and the
 * prohibited class (never executed for anyone).
 */
export async function driveAuthorizationBoundaryProbes(
  harness: ConformanceHarness,
): Promise<readonly AuthorizationBoundaryProbe[]> {
  const probes: AuthorizationBoundaryProbe[] = [];

  // 1. DENY-BY-DEFAULT — an empty policy denies EVERY actor kind (read class,
  //    full capabilities held): no actor kind bypasses the evaluator.
  for (const kind of ACTOR_KINDS) {
    probes.push(
      await probe(harness, {
        label: `empty-policy-${kind}`,
        actorKind: kind,
        commandName: 'cost.listCostItems',
        policy: 'empty',
        capabilities: 'full',
        expected: 'denied',
        expectedRejectionCode: 'no-allow-rule',
      }),
    );
  }

  // 2. EXPLICIT DENY — deny-write denies the write class for every actor
  //    kind; the read class still executes (deny rules are action-scoped).
  for (const kind of ACTOR_KINDS) {
    probes.push(
      await probe(harness, {
        label: `deny-write-${kind}`,
        actorKind: kind,
        commandName: 'field.recordProgress',
        policy: 'explicit-deny-write',
        capabilities: 'full',
        expected: 'denied',
        expectedRejectionCode: 'explicit-deny',
        evidence: [{ slot: 'observation', ref: 'evidence://field/observation-1' }],
        confidence: 'high',
      }),
    );
  }
  probes.push(
    await probe(harness, {
      label: 'deny-write-read-still-executes',
      actorKind: 'user',
      commandName: 'cost.listCostItems',
      policy: 'explicit-deny-write',
      capabilities: 'full',
      expected: 'executed',
      expectedRejectionCode: null,
    }),
  );

  // 3. CAPABILITY GATE — a missing required capability denies BEFORE the
  //    policy, for every actor kind, even under allow-all.
  for (const kind of ACTOR_KINDS) {
    probes.push(
      await probe(harness, {
        label: `missing-capability-${kind}`,
        actorKind: kind,
        commandName: 'cost.listCostItems',
        policy: 'allow-all',
        capabilities: 'missing-required',
        expected: 'denied',
        expectedRejectionCode: 'missing-required-capability',
      }),
    );
  }

  // 4. ACTOR-KIND GATE — an action declared for human actors only rejects
  //    every non-human kind ('agent' | 'app' | 'adapter' | 'system') under
  //    an ALLOW-ALL policy with full capabilities: THE no-bypass proof.
  for (const kind of ACTOR_KINDS) {
    const human = kind === 'user';
    probes.push(
      await probe(harness, {
        label: `actor-kind-gate-${kind}`,
        actorKind: kind,
        commandName: 'documents.submitDailyLog',
        policy: 'allow-all',
        capabilities: 'full',
        expected: human ? 'executed' : 'denied',
        expectedRejectionCode: human ? null : 'actor-kind-not-permitted',
        confidence: 'high',
      }),
    );
  }

  // 5. APPROVAL-ROUTING — the approval-required class routes (never
  //    executes directly), for a human and a non-human actor alike.
  for (const kind of ['user', 'agent'] as const) {
    probes.push(
      await probe(harness, {
        label: `approval-routing-${kind}`,
        actorKind: kind,
        commandName: 'cost.commitBudgetRevision',
        policy: 'allow-all',
        capabilities: 'full',
        expected: 'routed',
        expectedRejectionCode: null,
        evidence: [
          { slot: 'justification', ref: 'evidence://revision/justification-1' },
          { slot: 'margin-assessment', ref: 'evidence://revision/margin-1' },
        ],
        confidence: 'certain',
        subject: true,
      }),
    );
  }

  // 6. FAIL-CLOSED CLASSIFICATION — an unknown command is prohibited by
  //    default; a prohibited-class action never executes. For humans and
  //    the system actor alike, under allow-all with full capabilities.
  for (const kind of ['user', 'system'] as const) {
    probes.push(
      await probe(harness, {
        label: `unknown-command-${kind}`,
        actorKind: kind,
        commandName: 'cost.definitelyNotARegisteredAction',
        policy: 'allow-all',
        capabilities: 'full',
        expected: 'denied',
        expectedRejectionCode: 'unknown-action',
      }),
    );
    probes.push(
      await probe(harness, {
        label: `prohibited-class-${kind}`,
        actorKind: kind,
        commandName: 'cost.purgeCostLedger',
        policy: 'allow-all',
        capabilities: 'full',
        expected: 'denied',
        expectedRejectionCode: 'prohibited-action',
      }),
    );
  }

  return probes;
}

/**
 * Evaluate the authorization-boundary evidence (pure, deterministic):
 * every probe observes exactly its expected outcome with the expected typed
 * denial code; denials commit ZERO handler effects and leave their audit
 * envelope; executions/routings happen only where expected.
 */
export function evaluateAuthorizationBoundaries(
  probes: readonly AuthorizationBoundaryProbe[],
): ConformanceCheckResult {
  const failures: ConformanceFailure[] = [];
  for (const p of probes) {
    if (p.observed !== p.expected) {
      failures.push(
        conformanceFailure(
          p.label,
          'boundary-outcome-mismatch',
          `expected '${p.expected}', observed '${p.observed}' for actor kind '${p.actorKind}' on '${p.commandName}' (${p.policy} policy, ${p.capabilities} capabilities)`,
        ),
      );
    }
    if (p.expected === 'denied') {
      if (p.expectedRejectionCode !== null && p.rejectionCode !== p.expectedRejectionCode) {
        failures.push(
          conformanceFailure(
            p.label,
            'wrong-rejection-code',
            `expected the denial code '${p.expectedRejectionCode}', observed '${p.rejectionCode}'`,
          ),
        );
      }
      if (p.handlerInvocations !== 0) {
        failures.push(
          conformanceFailure(
            p.label,
            'side-effect-committed',
            `${p.handlerInvocations} handler invocation(s) committed for a denied action`,
          ),
        );
      }
      if (!p.audited) {
        failures.push(
          conformanceFailure(
            p.label,
            'denial-not-audited',
            'the denial left no audit envelope on the gateway trail (A3)',
          ),
        );
      }
    }
    if (p.expected !== 'denied' && p.handlerInvocations !== (p.expected === 'executed' ? 1 : 0)) {
      failures.push(
        conformanceFailure(
          p.label,
          'side-effect-mismatch',
          `expected ${p.expected === 'executed' ? 1 : 0} handler invocation(s), observed ${p.handlerInvocations}`,
        ),
      );
    }
  }
  return conformanceResult('authorization-boundaries', probes.length, failures);
}
