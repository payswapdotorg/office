// Office intelligence — the proposed next actions + the policy-gated
// commitment (OFF-034). SUGGESTIONS ONLY.
//
// proposeNextActions() maps each recommendation kind deterministically
// into typed command references over the OFF-017 gateway's own command
// vocabulary (the cost domain's typed command names — the engine invents
// no command names). commitProcurementDecision() is the ONLY
// commitment-shaped surface, and it is structurally a proposal producer:
// WITHOUT an explicit ProcurementPolicyDecision the commitment is a typed
// rejection (freeze A8: contractual actions are approval-required); WITH
// one it still only PROPOSES — the exit is a typed ProposedNextAction
// record carrying the authorizing decision (A4: who decided, when, and
// why) so the gateway and the audit trail can verify the approval chain.
//
// This package has NO execution path: no command envelope is ever
// constructed, no dispatch/execute/commit surface exists anywhere, and the
// audit module's only write path is the injected sink port (the
// structural no-auto-commit proof in the test suite proves it by scanning
// and counting).
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { EntityId } from '@office/contracts';
import {
  AMEND_COMMITMENT_COMMAND,
  CREATE_COMMITMENT_COMMAND,
} from './model';
import type {
  ProcurementEvidence,
  ProcurementPolicyDecision,
  ProposedConfidence,
  ProposedConfidenceLevel,
  ProposedConfidenceReason,
  ProposedNextAction,
} from './model';
import type { ProcurementRecommendation } from './recommendation';

// ---------------------------------------------------------------------------
// The deterministic confidence (A4 — derivable from the recommendation's
// own evidence chain, never a guess).
// ---------------------------------------------------------------------------

const confidenceReasonsOf = (
  recommendation: ProcurementRecommendation,
): readonly ProposedConfidenceReason[] => {
  const reasons: ProposedConfidenceReason[] = ['single-assessment-basis'];
  if (recommendation.historicalBasis.outcomeIds.length > 0) {
    reasons.push('historical-basis-outcomes');
  }
  if (recommendation.historicalBasis.benchmarks.length > 0) {
    reasons.push('benchmark-calibrated');
  } else {
    reasons.push('no-benchmark-context');
  }
  const selectedIds = new Set<string>(
    recommendation.selectedAlternatives.map((alternative) => alternative.alternativeId),
  );
  const priceAboveBasis = recommendation.comparison.rows.some(
    (row) =>
      selectedIds.has(row.alternativeId) &&
      row.riskFactors.some((factor) => factor.kind === 'price-above-budget-basis'),
  );
  if (priceAboveBasis) reasons.push('price-above-budget-basis');
  return [...new Set<ProposedConfidenceReason>(reasons)].sort();
};

const confidenceOf = (
  level: ProposedConfidenceLevel,
  reasons: readonly ProposedConfidenceReason[],
): ProposedConfidence => ({ level, reasons: [...reasons] });

const levelOf = (reasons: readonly ProposedConfidenceReason[]): ProposedConfidenceLevel => {
  if (reasons.includes('human-decision-required')) return 'low';
  if (reasons.includes('benchmark-calibrated') && reasons.includes('historical-basis-outcomes')) {
    return 'high';
  }
  return 'medium';
};

// ---------------------------------------------------------------------------
// The justifying evidence (a subset of the recommendation's own chain).
// ---------------------------------------------------------------------------

const assessmentEvidenceOf = (
  recommendation: ProcurementRecommendation,
): readonly ProcurementEvidence[] =>
  recommendation.evidence.filter((evidence) => evidence.kind === 'assessment');

const costEvidenceOf = (
  recommendation: ProcurementRecommendation,
): readonly ProcurementEvidence[] =>
  recommendation.evidence.filter(
    (evidence) => evidence.kind === 'record' || evidence.kind === 'event',
  );

// ---------------------------------------------------------------------------
// The per-kind suggestion mappings (pure, total over the kind vocabulary).
// ---------------------------------------------------------------------------

const incumbentCommitmentIdOf = (
  recommendation: ProcurementRecommendation,
): EntityId => recommendation.comparison.need.incumbentCommitmentId;

const budgetIdOf = (recommendation: ProcurementRecommendation): EntityId =>
  recommendation.comparison.need.budgetId;

/** Vendor switch: re-baseline the incumbent, then place the switched commitment. */
const vendorSwitchActions = (
  recommendation: ProcurementRecommendation,
): readonly ProposedNextAction[] => {
  const reasons = confidenceReasonsOf(recommendation);
  const evidence = assessmentEvidenceOf(recommendation);
  const costEvidence = costEvidenceOf(recommendation);
  return [
    {
      command: {
        commandName: AMEND_COMMITMENT_COMMAND,
        payload: { commitmentId: incumbentCommitmentIdOf(recommendation) },
      },
      scope: recommendation.scope,
      title: 'Re-baseline the incumbent commitment to the switched fulfillment',
      rationale: `The vendor switch projects ${String(recommendation.projectedImpact.projectedDeltaMinor)} minor units against the incumbent path; re-baselining the incumbent commitment prepares the canonical position for the switch.`,
      confidence: confidenceOf(levelOf(reasons), reasons),
      evidence: costEvidence,
      policyDecision: null,
    },
    {
      command: {
        commandName: CREATE_COMMITMENT_COMMAND,
        payload: { budgetId: budgetIdOf(recommendation) },
      },
      scope: recommendation.scope,
      title: 'Place the commitment with the switched vendor',
      rationale: `The comparison quotes ${String(recommendation.selectedAlternatives.length)} selected alternative(s) covering the need's scope; placing the commitment executes the switch the recommendation projects.`,
      confidence: confidenceOf(levelOf(reasons), reasons),
      evidence,
      policyDecision: null,
    },
  ];
};

/** Order splitting: re-baseline the incumbent, then place the split part commitment. */
const orderSplittingActions = (
  recommendation: ProcurementRecommendation,
): readonly ProposedNextAction[] => {
  const reasons = confidenceReasonsOf(recommendation);
  const evidence = assessmentEvidenceOf(recommendation);
  const costEvidence = costEvidenceOf(recommendation);
  return [
    {
      command: {
        commandName: AMEND_COMMITMENT_COMMAND,
        payload: { commitmentId: incumbentCommitmentIdOf(recommendation) },
      },
      scope: recommendation.scope,
      title: 'Re-baseline the incumbent commitment to the retained split share',
      rationale: `The split retains part of the need's scope on the incumbent; re-baselining the incumbent commitment to the retained share prepares the canonical position for the split.`,
      confidence: confidenceOf(levelOf(reasons), reasons),
      evidence: costEvidence,
      policyDecision: null,
    },
    {
      command: {
        commandName: CREATE_COMMITMENT_COMMAND,
        payload: { budgetId: budgetIdOf(recommendation) },
      },
      scope: recommendation.scope,
      title: 'Place the split part commitment with the second vendor',
      rationale: `The split composition covers the need's scope across ${String(recommendation.selectedAlternatives.length)} alternatives, reducing the single-source concentration risk; placing the second commitment executes the split the recommendation projects.`,
      confidence: confidenceOf(levelOf(reasons), reasons),
      evidence,
      policyDecision: null,
    },
  ];
};

/** Timing shift: place the early order, then release the incumbent's late path. */
const timingShiftActions = (
  recommendation: ProcurementRecommendation,
): readonly ProposedNextAction[] => {
  const reasons: ProposedConfidenceReason[] = [
    ...confidenceReasonsOf(recommendation),
    'human-decision-required',
  ];
  reasons.sort();
  const evidence = assessmentEvidenceOf(recommendation);
  const costEvidence = costEvidenceOf(recommendation);
  return [
    {
      command: {
        commandName: CREATE_COMMITMENT_COMMAND,
        payload: { budgetId: budgetIdOf(recommendation) },
      },
      scope: recommendation.scope,
      title: 'Place the early order with the faster vendor',
      rationale: `The timing shift pays a price premium for a material lead-time gain, avoiding ${String(-recommendation.projectedImpact.projectedDeltaMinor)} minor units of the assessed impact; placing the early order is a human-approved spending decision.`,
      confidence: confidenceOf(levelOf(reasons), reasons),
      evidence,
      policyDecision: null,
    },
    {
      command: {
        commandName: AMEND_COMMITMENT_COMMAND,
        payload: { commitmentId: incumbentCommitmentIdOf(recommendation) },
      },
      scope: recommendation.scope,
      title: 'Re-baseline the incumbent commitment off the late path',
      rationale: `The incumbent vendor's own re-quote carries the late lead time the assessed impact rides; re-baselining the incumbent commitment releases the late path once the early order lands.`,
      confidence: confidenceOf(levelOf(reasons), reasons),
      evidence: costEvidence,
      policyDecision: null,
    },
  ];
};

// ---------------------------------------------------------------------------
// THE proposal mapping (pure, total over the kind vocabulary).
// ---------------------------------------------------------------------------

/**
 * THE proposed next actions of one procurement recommendation: the
 * deterministic per-kind mapping into typed command references the OFF-017
 * action gateway resolves, each carrying the evidence justifying the
 * proposal and a deterministic A4 confidence. SUGGESTIONS ONLY — this
 * function has no execution path and the package has no execution surface
 * at all.
 */
export function proposeNextActions(
  recommendation: ProcurementRecommendation,
): readonly ProposedNextAction[] {
  switch (recommendation.kind) {
    case 'vendor-switch':
      return vendorSwitchActions(recommendation);
    case 'order-splitting':
      return orderSplittingActions(recommendation);
    case 'timing-shift':
      return timingShiftActions(recommendation);
  }
}

// ---------------------------------------------------------------------------
// THE policy-gated commitment (the named acceptance — suggestion only).
// ---------------------------------------------------------------------------

const commitmentRequiresPolicyFailure = (recommendationId: string): DomainError =>
  domainError(
    'forbidden',
    `committing the procurement decision of recommendation ${recommendationId} requires an explicit policy decision (freeze A8): the engine only PROPOSES — supply the authorizing decision to obtain the commitment proposal`,
    [
      {
        code: 'commitment-requires-policy-decision',
        message:
          'commitment without an explicit policy decision is a typed rejection; the exit is a ProposedNextAction record',
        path: 'policyDecision',
      },
    ],
  );

/**
 * THE policy-gated commitment of one procurement recommendation: PROPOSE
 * the commitment as a typed ProposedNextAction (the ONLY exit — the engine
 * never commits a procurement decision, issues a command, or mutates
 * canonical state). Without an explicit policy decision the commitment is
 * a typed rejection (freeze A8: contractual actions are approval-required
 * unless an organization policy grants automation); with one, the proposal
 * carries the authorizing decision (A4: who decided, when, and why) so the
 * gateway and the audit trail can verify the approval chain. The proposed
 * command is the commitment vehicle (cost.createCommitment) with ONLY
 * deterministic reference fields — aggregate versions, actors, idempotency
 * keys, and approvals are supplied by the PROPOSING caller at proposal
 * time.
 */
export function commitProcurementDecision(
  recommendation: ProcurementRecommendation,
  decision: ProcurementPolicyDecision | null,
): Result<ProposedNextAction, DomainError> {
  if (decision === null) {
    return fail(commitmentRequiresPolicyFailure(recommendation.recommendationId));
  }
  const commitmentReasons: ProposedConfidenceReason[] = [
    ...confidenceReasonsOf(recommendation),
    'human-decision-required',
  ];
  commitmentReasons.sort();
  return ok({
    command: {
      commandName: CREATE_COMMITMENT_COMMAND,
      payload: { budgetId: budgetIdOf(recommendation) },
    },
    scope: recommendation.scope,
    title: `Commit the procurement decision of the ${recommendation.kind} recommendation`,
    rationale: `An explicit policy decision (${decision.decision}) by an actor of kind '${decision.decidedBy.kind}' authorizes committing this procurement recommendation; the engine only PROPOSES the commitment — the gateway classifies, authorizes, and routes it.`,
    confidence: confidenceOf('high', commitmentReasons),
    evidence: assessmentEvidenceOf(recommendation),
    policyDecision: decision,
  });
}
