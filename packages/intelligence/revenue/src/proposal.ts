// Office intelligence — the proposed next actions (OFF-033).
//
// proposeNextActions() is the ProposedNextAction contract: the
// deterministic per-kind mapping of one detected recovery candidate into
// PROPOSED typed command references — commands the OFF-017 action gateway
// resolves (the gateway's own CommandName vocabulary + a JSON-safe payload
// of the deterministic reference fields) plus the evidence justifying the
// proposal and a deterministic A4 confidence.
//
// SUGGESTIONS ONLY: this module has NO execution path — it builds typed
// data and returns it. The revenue recovery engine never asserts a
// contractual claim, never issues a command, and never mutates canonical
// state (freeze A8: an agent/app proposes the typed command through the
// policy-enforcing gateway; the gateway classifies, authorizes, and routes
// it). Aggregate-versioned payload fields, actors, idempotency keys, and
// approvals are supplied by the PROPOSING caller at proposal time — the
// proposals carry only what is deterministically derivable from the
// candidate.
//
// THE policy-gated assertion (the named acceptance): assertRecoveryClaim()
// is the ONLY assertion-shaped surface of the engine, and it is
// structurally a proposal producer — assertion WITHOUT an explicit policy
// decision is a typed rejection (freeze A8: contractual actions are
// approval-required), and WITH one it still only PROPOSES: the exit is a
// typed ProposedNextAction record carrying the authorizing decision (A4),
// never an executed assertion.
import type { EntityId, EntityRef } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { CandidateRecovery } from './candidates';
import {
  LINK_CHANGE_REFERENCES_COMMAND,
  REFERENCE_CLAIM_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
} from './model';
import type {
  ProposedConfidence,
  ProposedConfidenceReason,
  ProposedNextAction,
  RecoveryEvidence,
  RecoveryPolicyDecision,
} from './model';

// ---------------------------------------------------------------------------
// Confidence composition (deterministic, A4 — every reason is derivable
// from the candidate's own evidence chain and historical basis).
// ---------------------------------------------------------------------------

const confidenceOf = (
  level: ProposedConfidence['level'],
  reasons: readonly ProposedConfidenceReason[],
): ProposedConfidence => ({
  level,
  reasons: [...new Set<ProposedConfidenceReason>(reasons)].sort(),
});

const confidenceReasonsOf = (candidate: CandidateRecovery): readonly ProposedConfidenceReason[] => [
  'single-assessment-basis',
  ...(candidate.historicalBasis.outcomeIds.length > 0 ? ['historical-basis-outcomes'] as const : []),
  candidate.historicalBasis.benchmarks.length > 0 ? 'benchmark-calibrated' : 'no-benchmark-context',
];

const assessmentEvidenceOf = (candidate: CandidateRecovery): readonly RecoveryEvidence[] =>
  candidate.evidence.filter((evidence) => evidence.kind === 'assessment');

const eventEvidenceOf = (candidate: CandidateRecovery): readonly RecoveryEvidence[] =>
  candidate.evidence.filter((evidence) => evidence.kind === 'event');

const recordEvidenceOf = (candidate: CandidateRecovery): readonly RecoveryEvidence[] =>
  candidate.evidence.filter((evidence) => evidence.kind === 'record');

const outcomeEvidenceOf = (candidate: CandidateRecovery): readonly RecoveryEvidence[] =>
  candidate.evidence.filter((evidence) => evidence.kind === 'outcome');

const justifyingEvidenceOf = (candidate: CandidateRecovery): readonly RecoveryEvidence[] => [
  ...assessmentEvidenceOf(candidate),
  ...recordEvidenceOf(candidate),
  ...eventEvidenceOf(candidate),
  ...outcomeEvidenceOf(candidate),
];

const changeEventIdOf = (candidate: CandidateRecovery): EntityId | null => {
  const ref = candidate.referencedRecords.find(
    (candidate2: EntityRef) => candidate2.entityKind === 'change-event',
  );
  return ref === undefined ? null : ref.entityId;
};

const changeOrderIdOf = (candidate: CandidateRecovery): EntityId | null => {
  const ref = candidate.referencedRecords.find(
    (candidate2: EntityRef) => candidate2.entityKind === 'change-order',
  );
  return ref === undefined ? null : ref.entityId;
};

// ---------------------------------------------------------------------------
// The per-kind proposal builders (pure functions of the candidate).
// ---------------------------------------------------------------------------

const constructiveChangeActions = (candidate: CandidateRecovery): readonly ProposedNextAction[] => {
  const changeEventId = changeEventIdOf(candidate);
  const evidence = justifyingEvidenceOf(candidate);
  const confidenceReasons = confidenceReasonsOf(candidate);
  const actions: ProposedNextAction[] = [];

  // 1. Submit the change order that converts the performed work into a
  //    claimable entitlement position — the recovery vehicle. Submitting a
  //    contractual change order is a commercial action the deciding human
  //    owns; the engine only proposes it.
  actions.push({
    command: {
      commandName: SUBMIT_CHANGE_ORDER_COMMAND,
      payload: changeEventId === null ? {} : { changeEventId },
    },
    scope: candidate.scope,
    title: 'Submit the change order claiming the performed work',
    rationale: `The impact assessment of change event ${String(changeEventId)} records ${String(candidate.economicBasis.amountMinor)} minor units of work performed with no change order; submitting the order converts the constructive change into a claimable entitlement position.`,
    confidence: confidenceOf('medium', confidenceReasons),
    evidence,
    policyDecision: null,
  });

  // 2. Attach the producing cost evidence to the change event before
  //    submission — the entitlement evidence completion.
  actions.push({
    command: {
      commandName: LINK_CHANGE_REFERENCES_COMMAND,
      payload: changeEventId === null ? {} : { changeEventId },
    },
    scope: candidate.scope,
    title: 'Link the producing cost evidence to the change event',
    rationale:
      'The constructive-change indicator cites recorded cost items and budget revisions; linking them as change references completes the entitlement evidence before the order is submitted.',
    confidence: confidenceOf('high', confidenceReasons),
    evidence,
    policyDecision: null,
  });
  return actions;
};

const entitlementRebalanceActions = (candidate: CandidateRecovery): readonly ProposedNextAction[] => {
  const changeEventId = changeEventIdOf(candidate);
  const changeOrderId = changeOrderIdOf(candidate);
  const evidence = justifyingEvidenceOf(candidate);
  const confidenceReasons: readonly ProposedConfidenceReason[] = [
    ...confidenceReasonsOf(candidate),
    'human-decision-required',
  ];

  // 1. Re-submit the rejected position as a new change order — the
  //    commercial judgment (whether to re-open a rejected claim) belongs to
  //    the deciding human, so the proposal carries low confidence.
  return [
    {
      command: {
        commandName: SUBMIT_CHANGE_ORDER_COMMAND,
        payload: changeEventId === null ? {} : { changeEventId },
      },
      scope: candidate.scope,
      title: 'Re-submit the rejected position as a new change order',
      rationale: `Rejected change order ${String(changeOrderId)} carried ${String(candidate.economicBasis.amountMinor)} minor units with documented evidence while the benchmarked approval climate of the comparable history is favorable; re-submitting the documented position as a new order is the rebalance path.`,
      confidence: confidenceOf('low', confidenceReasons),
      evidence,
      policyDecision: null,
    },
    {
      command: {
        commandName: REFERENCE_CLAIM_COMMAND,
        payload:
          changeEventId === null
            ? {}
            : changeOrderId === null
              ? { changeEventId }
              : { changeEventId, supersedingChangeOrderId: changeOrderId },
      },
      scope: candidate.scope,
      title: 'Pin the claim reference once a re-submitted order executes',
      rationale:
        'Pinning a claim reference binds the claim to one specific executed change order and document revision (the entitlement evidence); the engine proposes it as the follow-up once the re-submitted order is approved and executed.',
      confidence: confidenceOf('low', confidenceReasons),
      evidence,
      policyDecision: null,
    },
  ];
};

const delayImpactActions = (candidate: CandidateRecovery): readonly ProposedNextAction[] => {
  const changeEventId = changeEventIdOf(candidate);
  const evidence = justifyingEvidenceOf(candidate);
  const confidenceReasons = confidenceReasonsOf(candidate);
  const actions: ProposedNextAction[] = [];

  // 1. Submit the change order claiming the delay impact — the recovery
  //    vehicle for the unconverted program delay.
  actions.push({
    command: {
      commandName: SUBMIT_CHANGE_ORDER_COMMAND,
      payload: changeEventId === null ? {} : { changeEventId },
    },
    scope: candidate.scope,
    title: 'Submit the change order claiming the delay impact',
    rationale: `The impact assessment of change event ${String(changeEventId)} forecasts a program delay with no change order converting it; submitting the order asserts the delay-impact entitlement position.`,
    confidence: confidenceOf('medium', confidenceReasons),
    evidence,
    policyDecision: null,
  });

  // 2. Attach the schedule evidence to the change event before submission.
  actions.push({
    command: {
      commandName: LINK_CHANGE_REFERENCES_COMMAND,
      payload: changeEventId === null ? {} : { changeEventId },
    },
    scope: candidate.scope,
    title: 'Link the schedule impact evidence to the change event',
    rationale:
      'The delay-impact candidate cites the post-change schedule assertions that moved the program; linking them as change references completes the delay-claim evidence before the order is submitted.',
    confidence: confidenceOf('high', confidenceReasons),
    evidence,
    policyDecision: null,
  });
  return actions;
};

// ---------------------------------------------------------------------------
// THE proposal mapping (pure, total over the kind vocabulary).
// ---------------------------------------------------------------------------

/**
 * THE proposed next actions of one recovery candidate: the deterministic
 * per-kind mapping into typed command references the OFF-017 action
 * gateway resolves, each carrying the evidence justifying the proposal and
 * a deterministic A4 confidence. SUGGESTIONS ONLY — this function has no
 * execution path and the package has no execution surface at all.
 */
export function proposeNextActions(candidate: CandidateRecovery): readonly ProposedNextAction[] {
  switch (candidate.kind) {
    case 'constructive-change':
      return constructiveChangeActions(candidate);
    case 'entitlement-rebalance':
      return entitlementRebalanceActions(candidate);
    case 'delay-impact':
      return delayImpactActions(candidate);
  }
}

// ---------------------------------------------------------------------------
// THE policy-gated assertion (the named acceptance — suggestion only).
// ---------------------------------------------------------------------------

const assertionRequiresPolicyFailure = (candidateId: string): DomainError =>
  domainError(
    'forbidden',
    `asserting the contractual claim of recovery candidate ${candidateId} requires an explicit policy decision (freeze A8): the engine only PROPOSES — supply the authorizing decision to obtain the assertion proposal`,
    [
      {
        code: 'assertion-requires-policy-decision',
        message:
          'assertion without an explicit policy decision is a typed rejection; the exit is a ProposedNextAction record',
        path: 'policyDecision',
      },
    ],
  );

/**
 * THE policy-gated assertion of one recovery candidate: PROPOSE the claim
 * assertion as a typed ProposedNextAction (the ONLY exit — the engine never
 * asserts, issues a command, or mutates canonical state). Without an
 * explicit policy decision the assertion is a typed rejection (freeze A8:
 * contractual actions are approval-required unless an organization policy
 * grants automation); with one, the proposal carries the authorizing
 * decision (A4: who decided, when, and why) so the gateway and the audit
 * trail can verify the approval chain. The proposed command is the
 * contractual assertion vehicle (contracts.submitChangeOrder) with ONLY
 * deterministic reference fields — aggregate versions, actors, idempotency
 * keys, and approvals are supplied by the PROPOSING caller at proposal
 * time.
 */
export function assertRecoveryClaim(
  candidate: CandidateRecovery,
  decision: RecoveryPolicyDecision | null,
): Result<ProposedNextAction, DomainError> {
  if (decision === null) {
    return fail(assertionRequiresPolicyFailure(candidate.candidateId));
  }
  const changeEventId = changeEventIdOf(candidate);
  return ok({
    command: {
      commandName: SUBMIT_CHANGE_ORDER_COMMAND,
      payload: changeEventId === null ? {} : { changeEventId },
    },
    scope: candidate.scope,
    title: `Assert the contractual claim of the ${candidate.kind} candidate`,
    rationale: `An explicit policy decision (${decision.decision}) by an actor of kind '${decision.decidedBy.kind}' authorizes asserting this recovery candidate; the engine only PROPOSES the assertion — the gateway classifies, authorizes, and routes it.`,
    confidence: confidenceOf('high', [
      ...confidenceReasonsOf(candidate),
      'human-decision-required',
    ]),
    evidence: justifyingEvidenceOf(candidate),
    policyDecision: decision,
  });
}
