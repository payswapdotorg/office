// Office intelligence — the suggested next actions (OFF-019).
//
// suggestNextActions() is the NextAction contract: the deterministic
// per-kind mapping of one detected exception into SUGGESTED typed command
// references — commands the OFF-017 action gateway resolves (the gateway's
// own CommandName vocabulary + a JSON-safe payload of the deterministic
// reference fields) plus the evidence justifying the suggestion and a
// deterministic A4 confidence.
//
// SUGGESTIONS ONLY: this module has NO execution path — it builds typed
// data and returns it. The control tower never executes anything (freeze
// A8: an agent/app proposes the typed command through the policy-enforcing
// gateway; the gateway classifies, authorizes, and routes it). Aggregate-
// versioned payload fields, actors, idempotency keys, and approvals are
// supplied by the PROPOSING caller at proposal time — the suggestions
// carry only what is deterministically derivable from the exception.
import type { EntityId, EntityRef } from '@office/contracts';
import {
  APPROVE_CHANGE_ORDER_COMMAND,
  LINK_CHANGE_REFERENCES_COMMAND,
  RECORD_PROGRESS_COMMAND,
  REJECT_CHANGE_ORDER_COMMAND,
  REVISE_BUDGET_COMMAND,
  SET_BASELINE_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
} from './model';
import type {
  Exception,
  ExceptionEvidence,
  NextAction,
  NextActionConfidence,
  NextActionConfidenceReason,
} from './model';

// ---------------------------------------------------------------------------
// Confidence composition (deterministic, A4 — every reason is derivable
// from the exception's own evidence chain).
// ---------------------------------------------------------------------------

const confidenceOf = (
  level: NextActionConfidence['level'],
  reasons: readonly NextActionConfidenceReason[],
): NextActionConfidence => ({
  level,
  reasons: [...new Set<NextActionConfidenceReason>(reasons)].sort(),
});

const assessmentEvidenceOf = (exception: Exception): ExceptionEvidence[] =>
  exception.evidence.filter((evidence) => evidence.kind === 'assessment');

const eventEvidenceOf = (exception: Exception): ExceptionEvidence[] =>
  exception.evidence.filter((evidence) => evidence.kind === 'event');

const activityIdsOf = (exception: Exception): readonly EntityId[] =>
  exception.affected
    .filter((ref: EntityRef) => ref.entityKind === 'activity')
    .map((ref) => ref.entityId);

const changeOrderIdsOf = (exception: Exception): readonly EntityId[] =>
  exception.affected
    .filter((ref) => ref.entityKind === 'change-order')
    .map((ref) => ref.entityId);

const changeEventIdOf = (exception: Exception): EntityId | null => {
  const ref = exception.affected.find((candidate) => candidate.entityKind === 'change-event');
  return ref === undefined ? null : ref.entityId;
};

// ---------------------------------------------------------------------------
// The per-kind suggestion builders (pure functions of the exception).
// ---------------------------------------------------------------------------

const scheduleSlipActions = (exception: Exception): readonly NextAction[] => {
  const activityIds = activityIdsOf(exception);
  const evidence = [...assessmentEvidenceOf(exception), ...eventEvidenceOf(exception)];
  const confidenceReasons: NextActionConfidenceReason[] = [
    'single-assessment-basis',
    exception.provenance.calibrationBenchmarkIds.length > 0
      ? 'benchmark-calibrated'
      : 'no-benchmark-context',
  ];
  const actions: NextAction[] = [];

  // 1. Record actual progress on the slipped activities — the honest
  //    re-forecast input (a read-side write, gateway-classified reversible).
  if (activityIds.length > 0) {
    actions.push({
      command: {
        commandName: RECORD_PROGRESS_COMMAND,
        payload: {
          activityIds: [...activityIds],
        },
      },
      scope: exception.scope,
      title: 'Record actual progress on the slipped activities',
      rationale: `The impact assessment of change event ${String(changeEventIdOf(exception))} forecasts a ${exception.severity.level}-severity program slip; recording actual remaining durations re-anchors the forecast before any rebaseline decision.`,
      confidence: confidenceOf('medium', confidenceReasons),
      evidence,
    });
  }

  // 2. Re-baseline the program once actuals are recorded — a schedule
  //    baseline change is an approval-required action under freeze A8, so
  //    the suggestion explicitly defers the decision to the approver.
  actions.push({
    command: {
      commandName: SET_BASELINE_COMMAND,
      payload: {},
    },
    scope: exception.scope,
    title: 'Re-baseline the program after the re-forecast',
    rationale:
      'Setting a new schedule baseline is a consequential schedule-baseline action (freeze A8): it requires explicit approval, so the control tower only surfaces it as the follow-up once actual progress has re-anchored the forecast.',
    confidence: confidenceOf('low', [...confidenceReasons, 'human-decision-required']),
    evidence,
  });
  return actions;
};

const costOverrunActions = (exception: Exception): readonly NextAction[] => {
  const evidence = [...assessmentEvidenceOf(exception), ...eventEvidenceOf(exception)];
  const confidenceReasons: NextActionConfidenceReason[] = [
    'single-assessment-basis',
    exception.provenance.calibrationBenchmarkIds.length > 0
      ? 'benchmark-calibrated'
      : 'no-benchmark-context',
  ];
  const changeEventId = changeEventIdOf(exception);
  return [
    {
      command: {
        commandName: REVISE_BUDGET_COMMAND,
        payload: {},
      },
      scope: exception.scope,
      title: 'Commit a budget revision covering the overrun',
      rationale: `The margin assessment projects an overrun of ${String(exception.economicImpact.amountMinor)} minor units ${String(exception.economicImpact.currency)}; a budget revision makes the exposure explicit in the basis of record instead of leaving it in the projection only.`,
      confidence: confidenceOf('medium', confidenceReasons),
      evidence,
    },
    {
      command: {
        commandName: SUBMIT_CHANGE_ORDER_COMMAND,
        payload: changeEventId === null ? {} : { changeEventId },
      },
      scope: exception.scope,
      title: 'Pursue entitlement for the overrun delta',
      rationale: `The overrun is measured against contracted value ${String(exception.economicImpact.currency)}; a change order against the originating change event converts the uncovered delta into a claimable entitlement position.`,
      confidence: confidenceOf('medium', confidenceReasons),
      evidence,
    },
  ];
};

const entitlementExposureActions = (exception: Exception): readonly NextAction[] => {
  const pendingOrderIds = changeOrderIdsOf(exception);
  const evidence = [...assessmentEvidenceOf(exception), ...eventEvidenceOf(exception)];
  const confidenceReasons: readonly NextActionConfidenceReason[] = [
    'single-assessment-basis',
    'human-decision-required',
  ];
  // The decision itself is a commercial judgment the control tower never
  // makes: it surfaces BOTH decision commands (approve / reject) with the
  // pending order ids — the deciding human picks one through the gateway.
  return [
    {
      command: {
        commandName: APPROVE_CHANGE_ORDER_COMMAND,
        payload: { changeOrderIds: [...pendingOrderIds] },
      },
      scope: exception.scope,
      title: 'Approve the pending change orders',
      rationale: `Undecided change order value of ${String(exception.economicImpact.amountMinor)} minor units ${String(exception.economicImpact.currency)} is exposed; approving the meritorious orders converts the pending exposure into contracted value.`,
      confidence: confidenceOf('low', confidenceReasons),
      evidence,
    },
    {
      command: {
        commandName: REJECT_CHANGE_ORDER_COMMAND,
        payload: { changeOrderIds: [...pendingOrderIds] },
      },
      scope: exception.scope,
      title: 'Reject the pending change orders',
      rationale: `Undecided change order value of ${String(exception.economicImpact.amountMinor)} minor units ${String(exception.economicImpact.currency)} is exposed; rejecting the unmeritorious orders clears the exposure from the entitlement position.`,
      confidence: confidenceOf('low', confidenceReasons),
      evidence,
    },
  ];
};

const dependencyRiskActions = (exception: Exception): readonly NextAction[] => {
  const activityIds = activityIdsOf(exception);
  const evidence = [...assessmentEvidenceOf(exception), ...eventEvidenceOf(exception)];
  const confidenceReasons: readonly NextActionConfidenceReason[] = ['single-assessment-basis'];
  return [
    {
      command: {
        commandName: UPDATE_ACTIVITY_COMMAND,
        payload: { activityIds: [...activityIds] },
      },
      scope: exception.scope,
      title: 'Resequence the impacted activity chain',
      rationale: `Slipped activities gate ${exception.affected.filter((ref) => ref.entityKind === 'activity').length} downstream activities through recorded dependencies; resequencing (duration or logic changes through the schedule command surface) is the direct structural remedy.`,
      confidence: confidenceOf('medium', confidenceReasons),
      evidence,
    },
  ];
};

const evidenceGapActions = (exception: Exception): readonly NextAction[] => {
  const changeEventId = changeEventIdOf(exception);
  const evidence = [...assessmentEvidenceOf(exception), ...eventEvidenceOf(exception)];
  const confidenceReasons: readonly NextActionConfidenceReason[] = [
    'single-assessment-basis',
    'assessment-confidence-degraded',
  ];
  return [
    {
      command: {
        commandName: LINK_CHANGE_REFERENCES_COMMAND,
        payload: changeEventId === null ? {} : { changeEventId },
      },
      scope: exception.scope,
      title: 'Link the missing evidence to the change event',
      rationale: `The producing impact assessment carries low confidence; attaching the missing document evidence (revisions, references) to the change event lets the next assessment compute from complete inputs.`,
      confidence: confidenceOf('high', confidenceReasons),
      evidence,
    },
  ];
};

// ---------------------------------------------------------------------------
// THE suggestion mapping (pure, total over the kind vocabulary).
// ---------------------------------------------------------------------------

/**
 * THE suggested next actions of one exception: the deterministic per-kind
 * mapping into typed command references the OFF-017 action gateway
 * resolves, each carrying the evidence justifying the suggestion and a
 * deterministic A4 confidence. SUGGESTIONS ONLY — this function has no
 * execution path and the package has no execution surface at all.
 */
export function suggestNextActions(exception: Exception): readonly NextAction[] {
  switch (exception.kind) {
    case 'schedule-slip':
      return scheduleSlipActions(exception);
    case 'cost-overrun':
      return costOverrunActions(exception);
    case 'entitlement-exposure':
      return entitlementExposureActions(exception);
    case 'dependency-risk':
      return dependencyRiskActions(exception);
    case 'evidence-gap':
      return evidenceGapActions(exception);
  }
}
