// Office intelligence — the outcome derivation (OFF-015).
//
// deriveOutcome() derives ONE completed project's recorded outcome from the
// recorded events (through the margin engine's deterministic commercial
// facts fold) plus the margin engine's ImpactAssessment values — the
// evidence-referenced numbers that make every outcome fact traceable. The
// derivation is a PURE function of its typed inputs: no clock, no
// randomness, no environment, and the assessments are consumed in a
// canonical (assessedAt, assessmentId) order, so the input array's order
// never matters (shuffled inputs derive the identical outcome).
//
// THE projection discipline (A2/A7): an OutcomeRecord is DERIVED state —
// it carries derivation provenance (every source event + assessment
// reference) and is structurally incapable of being canonical truth; the
// store that serves it is rebuildable from the recorded events alone.
import type { Actor, EntityId, Scope, Timestamp } from '@office/contracts';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type {
  CommercialFacts,
  ImpactAssessment,
} from '@office/intelligence-margin';
import type { OutcomeId } from './vocabulary';
import {
  MEMORY_ENGINE,
  OUTCOME_SCHEMA_VERSION,
  RATIONAL_ONE,
  canonicalOutcomeEvidence,
  compareAssessmentSources,
  reduceRational,
} from './model';
import type {
  ChangePressureOutcome,
  ContractMarginPosition,
  EntitlementOrderOutcome,
  EntitlementOrderStatus,
  EntitlementOutcome,
  MarginOutcome,
  OutcomeAssessmentSource,
  OutcomeEventSource,
  OutcomeEvidence,
  OutcomeRecord,
  Rational,
  ScheduleOutcome,
} from './model';

// ---------------------------------------------------------------------------
// The typed inputs + identity of one outcome derivation.
// ---------------------------------------------------------------------------

/**
 * The typed inputs of one outcome derivation: the commercial facts folded
 * from the project's recorded events (projectCommercialFacts of
 * @office/intelligence-margin) and the margin engine's assessment values
 * for the same project (calculateImpact outputs — every one
 * evidence-referenced).
 */
export interface OutcomeInputs {
  /** The folded commercial facts of the completed project. */
  readonly facts: CommercialFacts;
  /** The margin assessments recorded for the completed project. */
  readonly assessments: readonly ImpactAssessment[];
}

/** The injected identity/clock of one outcome recording (never wall time). */
export interface OutcomeIdentity {
  /** The caller-supplied deterministic outcome identity. */
  readonly outcomeId: OutcomeId;
  /** When the outcome is recorded (injected clock). */
  readonly recordedAt: Timestamp;
  /** The actor the outcome is recorded for (A4 source identity). */
  readonly actor: Actor;
  /** The project scope the outcome is recorded under (A12). */
  readonly scope: Scope;
}

// ---------------------------------------------------------------------------
// Fail-closed derivation errors.
// ---------------------------------------------------------------------------

const outcomeScopeFailure = (): DomainError =>
  invariantViolation({
    name: 'outcome-scope-project',
    statement:
      'an outcome is recorded under a PROJECT scope (the completed project it records); tenant or other scopes are typed-rejected',
  });

const outcomeAssessmentFailure = (): DomainError =>
  invariantViolation({
    name: 'outcome-assessment-required',
    statement:
      'an outcome requires at least one margin assessment: the recorded facts of history are the assessments the project closed under',
  });

const outcomeCurrencyFailure = (currencies: readonly string[]): DomainError =>
  domainError(
    'invariant-violation',
    `an outcome carries a single margin currency: the assessments span ${currencies.join(', ')}`,
    [
      {
        code: 'outcome-currency-consistent',
        message: `currencies: ${currencies.join(', ')}`,
        path: null,
      },
    ],
  );

const crossScopeInputRejection = (scope: Scope): DomainError =>
  domainError(
    'unauthorized',
    'outcome derivation inputs carry assessments outside the outcome\u2019s scope: cross-scope inputs are typed-rejected before any derivation (freeze A12)',
    [
      {
        code: 'outcome-input-scope',
        message: 'cross-scope assessment inputs are typed-rejected (freeze A12)',
        path: null,
      },
    ],
    { scope },
  );

// ---------------------------------------------------------------------------
// Deterministic derivation helpers.
// ---------------------------------------------------------------------------

const assessmentSourceOf = (assessment: ImpactAssessment): OutcomeAssessmentSource => ({
  kind: 'assessment',
  assessmentId: assessment.assessmentId,
  assessedAt: assessment.assessedAt,
  sourceEventId: assessment.query.sourceEventId,
  correlationId: assessment.source.correlationId,
  changeEventId: assessment.source.changeEventId,
  contractId: assessment.source.contractId,
});

const contractMarginPositionOf = (
  assessment: ImpactAssessment,
): ContractMarginPosition => {
  const contracted = assessment.marginPosition.contractedValue.amountMinor;
  return {
    contractId: assessment.source.contractId,
    assessmentId: assessment.assessmentId,
    currency: assessment.marginPosition.currency,
    contractedValueMinor: contracted,
    committedCostMinor: assessment.marginPosition.committedCost.amountMinor,
    projectedCostMinor: assessment.marginPosition.projectedCost.amountMinor,
    marginMinor: assessment.marginPosition.marginMinor,
    marginRatio:
      contracted === 0
        ? null
        : reduceRational({
            numerator: assessment.marginPosition.marginMinor,
            denominator: contracted,
          }),
  };
};

const compareByContractId = (
  left: ContractMarginPosition,
  right: ContractMarginPosition,
): number =>
  left.contractId < right.contractId ? -1 : left.contractId > right.contractId ? 1 : 0;

const compareByChangeOrderId = (
  left: EntitlementOrderOutcome,
  right: EntitlementOrderOutcome,
): number =>
  left.changeOrderId < right.changeOrderId
    ? -1
    : left.changeOrderId > right.changeOrderId
      ? 1
      : 0;

const compareEventSourcesById = (
  left: OutcomeEventSource,
  right: OutcomeEventSource,
): number => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0);

const dedupeEventSources = (
  sources: readonly OutcomeEventSource[],
): readonly OutcomeEventSource[] => {
  const byId = new Map<string, OutcomeEventSource>();
  for (const source of sources) {
    if (!byId.has(source.eventId)) {
      byId.set(source.eventId, source);
    }
  }
  return [...byId.values()].sort(compareEventSourcesById);
};

/** The folded state of one change order across the assessments. */
interface FoldedOrder {
  readonly order: EntitlementOrderOutcome;
  readonly submissionSource: OutcomeEventSource;
  readonly decisionSource: OutcomeEventSource | null;
}

const eventSourceFromReference = (
  reference: { readonly eventId: string; readonly eventName: string; readonly occurredAt: Timestamp },
): OutcomeEventSource => ({
  kind: 'event',
  eventId: reference.eventId as OutcomeEventSource['eventId'],
  eventName: reference.eventName as OutcomeEventSource['eventName'],
  occurredAt: reference.occurredAt,
});

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

// ---------------------------------------------------------------------------
// THE derivation.
// ---------------------------------------------------------------------------

/**
 * Derive ONE completed project's outcome record — THE deterministic
 * outcome-capture function. Consumes the recorded commercial facts + the
 * margin assessments and produces the schedule variance, the cost margin
 * position, the entitlement outcomes, and the change pressure, each
 * carrying its SOURCE EVENT/ASSESSMENT references (A4 provenance).
 *
 * Derivation rules (all deterministic, all latest-assertion-wins in the
 * canonical (assessedAt, assessmentId) order — the input array order never
 * matters):
 * - schedule: baseline = the FIRST assessment's pre-change project
 *   duration; final = the LAST assessment's current project duration;
 *   variance = final − baseline. Sources: the boundary assessments.
 * - margin: the LATEST assessment per contract is that contract's final
 *   position; the project totals are the sums; marginRatio = margin /
 *   contracted (exact rational; null when the contracted value is 0).
 *   Sources: the latest-per-contract assessments + the recorded
 *   `contracts.contractCreated` events.
 * - entitlement: every change order's FINAL status is its latest recorded
 *   decision across the assessments (a decided order never regresses to
 *   pending); the totals + approval rate are computed over the final order
 *   set. Sources: the submission + decision events the assessments cited.
 * - change pressure: counts from the folded commercial facts; sources: the
 *   `contracts.changeEventRaised` events.
 */
export function deriveOutcome(
  inputs: OutcomeInputs,
  identity: OutcomeIdentity,
): Result<OutcomeRecord, DomainError> {
  // 1. The outcome scope must be a project scope (the completed project).
  if (identity.scope.kind !== 'project') {
    return fail(outcomeScopeFailure());
  }
  const projectId: EntityId = identity.scope.projectId;

  // 2. At least one assessment (the commercial close-out position).
  if (inputs.assessments.length === 0) {
    return fail(outcomeAssessmentFailure());
  }

  // 3. A12 input discipline: every assessment must live inside the
  //    outcome's scope — cross-scope inputs never derive.
  for (const assessment of inputs.assessments) {
    const assessmentScope = assessment.scope;
    if (
      assessmentScope.kind !== 'project' ||
      assessmentScope.tenantId !== identity.scope.tenantId ||
      assessmentScope.projectId !== projectId
    ) {
      return fail(crossScopeInputRejection(identity.scope));
    }
  }

  // 4. Single margin currency across the assessments.
  const currencies = new Set<string>(
    inputs.assessments.map((assessment) => assessment.marginPosition.currency),
  );
  if (currencies.size > 1) {
    return fail(outcomeCurrencyFailure([...currencies].sort()));
  }

  // Canonical assessment order — the derivation's only ordering input.
  const assessments = [...inputs.assessments].sort((left, right) =>
    compareAssessmentSources(assessmentSourceOf(left), assessmentSourceOf(right)),
  );
  const assessmentSources = assessments.map(assessmentSourceOf);

  // ----- schedule outcome --------------------------------------------------
  const first = assessments[0];
  const last = assessments[assessments.length - 1];
  const firstSource = assessmentSources[0];
  const lastSource = assessmentSources[assessmentSources.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    firstSource === undefined ||
    lastSource === undefined
  ) {
    return fail(outcomeAssessmentFailure());
  }
  const scheduleSources =
    assessments.length === 1 ? [firstSource] : [firstSource, lastSource];
  const schedule: ScheduleOutcome = {
    baselineDurationDays: first.scheduleImpact.preProjectDuration,
    finalDurationDays: last.scheduleImpact.currentProjectDuration,
    varianceDays:
      last.scheduleImpact.currentProjectDuration - first.scheduleImpact.preProjectDuration,
    sources: scheduleSources,
  };

  // ----- margin outcome (latest assessment per contract) -------------------
  const latestByContract = new Map<string, ImpactAssessment>();
  for (const assessment of assessments) {
    latestByContract.set(assessment.source.contractId, assessment);
  }
  const perContract = [...latestByContract.values()]
    .map((assessment) => contractMarginPositionOf(assessment))
    .sort(compareByContractId);
  const marginSources = [...latestByContract.values()]
    .map((assessment) => assessmentSourceOf(assessment))
    .sort(compareAssessmentSources);
  const contractEventSources: readonly OutcomeEventSource[] = dedupeEventSources(
    inputs.facts.contracts.map((contract) => ({
      kind: 'event' as const,
      eventId: contract.source.eventId,
      eventName: contract.source.eventName,
      occurredAt: contract.source.occurredAt,
    })),
  );
  const contractedValueMinor = sum(perContract.map((position) => position.contractedValueMinor));
  const marginMinor = sum(perContract.map((position) => position.marginMinor));
  const marginRatio: Rational | null =
    contractedValueMinor === 0
      ? null
      : reduceRational({ numerator: marginMinor, denominator: contractedValueMinor });
  const margin: MarginOutcome = {
    currency: last.marginPosition.currency,
    originalContractedValueMinor: sum(
      inputs.facts.contracts.map((contract) => contract.valueMinor),
    ),
    contractedValueMinor,
    committedCostMinor: sum(perContract.map((position) => position.committedCostMinor)),
    projectedCostMinor: sum(perContract.map((position) => position.projectedCostMinor)),
    marginMinor,
    marginRatio,
    perContract,
    sources: marginSources,
    eventSources: contractEventSources,
  };

  // ----- entitlement outcome (final status per change order) ---------------
  const ordersById = new Map<string, FoldedOrder>();
  for (const assessment of assessments) {
    for (const order of assessment.entitlementImpact.orders) {
      const submission = eventSourceFromReference(order.submissionSource);
      const decision =
        order.decisionSource === null
          ? null
          : eventSourceFromReference(order.decisionSource);
      const existing = ordersById.get(order.changeOrderId);
      if (existing === undefined) {
        ordersById.set(order.changeOrderId, {
          order: {
            changeOrderId: order.changeOrderId,
            valueMinor: order.valueMinor,
            status: order.status,
            submissionEventId: order.submissionSource.eventId,
            decisionEventId: order.decisionSource === null ? null : order.decisionSource.eventId,
          },
          submissionSource: submission,
          decisionSource: decision,
        });
        continue;
      }
      // A decided order never regresses to pending: only assertions that
      // carry a decision supersede an earlier decided state.
      if (order.decisionSource !== null) {
        ordersById.set(order.changeOrderId, {
          order: {
            changeOrderId: order.changeOrderId,
            valueMinor: order.valueMinor ?? existing.order.valueMinor,
            status: order.status,
            submissionEventId: order.submissionSource.eventId,
            decisionEventId: order.decisionSource.eventId,
          },
          submissionSource: submission,
          decisionSource: decision,
        });
      }
    }
  }
  const foldedOrders = [...ordersById.values()].sort((left, right) =>
    compareByChangeOrderId(left.order, right.order),
  );
  const orders = foldedOrders.map((folded) => folded.order);
  const statusCount = (status: EntitlementOrderStatus): number =>
    orders.filter((order) => order.status === status).length;
  const statusValue = (status: EntitlementOrderStatus): number =>
    sum(
      orders
        .filter((order) => order.status === status)
        .map((order) => order.valueMinor ?? 0),
    );
  const resolvedCount = statusCount('approved') + statusCount('executed');
  const approvalRate: Rational =
    orders.length === 0
      ? RATIONAL_ONE
      : reduceRational({ numerator: resolvedCount, denominator: orders.length });
  const entitlement: EntitlementOutcome = {
    approvedCount: statusCount('approved'),
    executedCount: statusCount('executed'),
    rejectedCount: statusCount('rejected'),
    pendingCount: statusCount('submitted'),
    approvedValueMinor: statusValue('approved') + statusValue('executed'),
    rejectedValueMinor: statusValue('rejected'),
    pendingValueMinor: statusValue('submitted'),
    approvalRate,
    orders,
    eventSources: dedupeEventSources([
      ...foldedOrders.map((folded) => folded.submissionSource),
      ...foldedOrders
        .map((folded) => folded.decisionSource)
        .filter((source): source is OutcomeEventSource => source !== null),
    ]),
  };

  // ----- change pressure outcome (counts from the recorded events) ---------
  const changeEventSources: readonly OutcomeEventSource[] = dedupeEventSources(
    inputs.facts.changeEvents.map((changeEvent) => ({
      kind: 'event' as const,
      eventId: changeEvent.source.eventId,
      eventName: changeEvent.source.eventName,
      occurredAt: changeEvent.source.occurredAt,
    })),
  );
  const changePressure: ChangePressureOutcome = {
    changeEventCount: inputs.facts.changeEvents.length,
    changeOrderCount: inputs.facts.changeOrders.length,
    contractCount: inputs.facts.contracts.length,
    eventSources: changeEventSources,
  };

  // ----- the record (A4: full evidence spine) -------------------------------
  const evidence: readonly OutcomeEvidence[] = canonicalOutcomeEvidence([
    ...assessmentSources,
    ...margin.eventSources,
    ...entitlement.eventSources,
    ...changePressure.eventSources,
  ]);

  return ok({
    outcomeId: identity.outcomeId,
    outcomeVersion: OUTCOME_SCHEMA_VERSION,
    engine: MEMORY_ENGINE,
    recordedAt: identity.recordedAt,
    actor: identity.actor,
    scope: identity.scope,
    projectId,
    schedule,
    margin,
    entitlement,
    changePressure,
    consumed: {
      projectedEventCount: inputs.facts.derivation.projectedEventCount,
      assessmentCount: assessments.length,
    },
    evidence,
  } satisfies OutcomeRecord);
}
