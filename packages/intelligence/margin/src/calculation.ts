// Office intelligence — the deterministic impact calculation (OFF-014).
//
// calculateImpact() is THE pure, deterministic function: the folded
// commercial facts + the authorization-filtered relationship subgraph of
// the source change event + the injected assessment identity/clock go in,
// one versioned ImpactAssessment comes out. Same inputs → the
// byte-identical assessment, every run (run-twice + shuffled-inputs
// determinism are the acceptance tests); no clock, no randomness, no
// environment.
//
// The calculation order is part of the contract:
//   1. the CAPABILITY gate (deny-by-default: a request missing one of the
//      three area read capabilities never reads an input, never computes);
//   2. the SOURCE lookup + structural A12 scope coverage (a foreign source
//      event is a typed not-found IDENTICAL to an absent one — no
//      existence oracle) and the cross-scope INPUT rejection (A12);
//   3. the POLICY gate over the assessed change event as the resource;
//   4. only then: cost / schedule / entitlement / margin, every number
//      carrying the source event ids that produced it (A4 traceability).
//
// The schedule deltas use a LOCAL deterministic CPM forward pass (see
// forwardPass below) over calendar-free integer day offsets — the same
// semantics the landed schedule forecast engine owns (packages/domain/
// schedule is imported NEVER; the link/duration/progress SHAPES arrive as
// typed facts folded from the recorded event payloads). The pre-change
// network is the facts AS OF the source change event's ledger position;
// the current network is the facts at the end of the stream — the delta is
// the change's forecast consequence, derived purely from ledger order.
import { fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type {
  EntityId,
  EntityKind,
  EventName,
  Scope,
  Timestamp,
} from '@office/contracts';
import type { LedgerEventId } from '@office/events';
import type {
  ActivityFact,
  ChangeEventFact,
  ChangeOrderFact,
  CommercialFacts,
} from './facts';
import {
  checkAssessmentCapabilities,
  checkAssessmentPolicy,
  checkAssessmentScopeCovers,
  crossScopeInputRejection,
  sourceEventNotFound,
} from './authorization';
import type { AssessmentAuthorization } from './authorization';
import type { AssessmentId } from './vocabulary';
import { ASSESSMENT_REQUIRED_CAPABILITY_NAMES } from './vocabulary';
import {
  ASSESSMENT_ENGINE,
  ASSESSMENT_SCHEMA_VERSION,
  ACTIVITY_KIND,
  BUDGET_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  COST_ITEM_KIND,
  canonicalEvidence,
} from './model';
import type {
  ActivityForecastDelta,
  AssessmentConfidence,
  AssessmentConfidenceReason,
  AssessmentPolicyContext,
  ChangeEventSource,
  ChangeOrderEntitlement,
  CostImpact,
  EntitlementPosition,
  ImpactAssessment,
  ImpactInputs,
  ImpactQuery,
  MarginLayer,
  MarginPosition,
  ScheduleImpact,
  SourceEventReference,
} from './model';

/** The injected identity/clock of one assessment run (never wall time). */
export interface AssessmentParts {
  /** The caller-supplied deterministic assessment identity. */
  readonly assessmentId: AssessmentId;
  /** When the assessment is produced (injected clock). */
  readonly assessedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Local deterministic CPM forward pass (calendar-free day offsets).
// ---------------------------------------------------------------------------

/** One activity of the network to forecast. */
interface NetworkActivity {
  readonly activityId: EntityId;
  readonly duration: number;
}

/** One typed dependency link of the network to forecast. */
interface NetworkLink {
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: 'FS' | 'SS' | 'FF' | 'SF';
  readonly lagDays: number;
}

/** The deterministic forward-pass forecast of one network snapshot. */
interface NetworkForecast {
  /** Early-start day offsets, keyed by activity id. */
  readonly earlyStart: ReadonlyMap<EntityId, number>;
  /** Early-finish day offsets, keyed by activity id. */
  readonly earlyFinish: ReadonlyMap<EntityId, number>;
  /** Project duration: the maximum early finish (0 for an empty network). */
  readonly projectDuration: number;
}

/**
 * The deterministic CPM forward pass: topological order (Kahn's algorithm,
 * smallest-id tie-break — no clock, no randomness), then one pass
 * computing every activity's early start/finish day offsets from its
 * predecessors' constraints:
 *
 *   FS: successor.ES ≥ predecessor.EF + lag
 *   SS: successor.ES ≥ predecessor.ES + lag
 *   FF: successor.EF ≥ predecessor.EF + lag → successor.ES ≥ … − duration
 *   SF: successor.EF ≥ predecessor.ES + lag → successor.ES ≥ … − duration
 *
 * A dependency cycle fails closed (typed invariant-violation) — the landed
 * schedule domain rejects cycles at write time, so a cyclic fold input is
 * corruption, never a schedule to guess about.
 */
function forwardPass(
  activities: readonly NetworkActivity[],
  links: readonly NetworkLink[],
): Result<NetworkForecast, DomainError> {
  const present = new Set<string>(activities.map((activity) => activity.activityId));
  for (const link of links) {
    if (!present.has(link.predecessorId) || !present.has(link.successorId)) {
      return fail(
        invariantViolation({
          name: 'schedule-network-consistent',
          statement: `a dependency references an activity absent from the network snapshot (predecessor ${link.predecessorId}, successor ${link.successorId})`,
        }),
      );
    }
  }

  const durationOf = new Map<string, number>(
    activities.map((activity) => [activity.activityId, activity.duration] as const),
  );
  const successorsOf = new Map<string, EntityId[]>();
  const remaining = new Map<string, number>();
  for (const activity of activities) {
    successorsOf.set(activity.activityId, []);
    remaining.set(activity.activityId, 0);
  }
  for (const link of links) {
    const list = successorsOf.get(link.predecessorId);
    if (list !== undefined) list.push(link.successorId);
    const count = remaining.get(link.successorId);
    if (count !== undefined) remaining.set(link.successorId, count + 1);
  }

  // Kahn's queue, smallest-id first (the deterministic tie-break).
  const ready: EntityId[] = activities
    .filter((activity) => (remaining.get(activity.activityId) ?? 0) === 0)
    .map((activity) => activity.activityId)
    .sort();
  const order: EntityId[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    order.push(current);
    for (const successor of successorsOf.get(current) ?? []) {
      const count = remaining.get(successor);
      if (count === undefined) continue;
      const next = count - 1;
      remaining.set(successor, next);
      if (next === 0) ready.push(successor);
    }
    ready.sort();
  }
  if (order.length !== present.size) {
    return fail(
      invariantViolation({
        name: 'schedule-network-acyclic',
        statement:
          'the dependency network of the recorded schedule facts contains a cycle',
      }),
    );
  }

  const linksOf = new Map<string, NetworkLink[]>();
  for (const link of links) {
    const list = linksOf.get(link.successorId);
    if (list === undefined) {
      linksOf.set(link.successorId, [link]);
    } else {
      list.push(link);
    }
  }

  const earlyStart = new Map<EntityId, number>();
  const earlyFinish = new Map<EntityId, number>();
  for (const id of order) {
    const duration = durationOf.get(id) ?? 0;
    let start = 0;
    for (const link of linksOf.get(id) ?? []) {
      const predecessorFinish = earlyFinish.get(link.predecessorId) ?? 0;
      const predecessorStart = earlyStart.get(link.predecessorId) ?? 0;
      let bound: number;
      switch (link.linkType) {
        case 'FS':
          bound = predecessorFinish + link.lagDays;
          break;
        case 'SS':
          bound = predecessorStart + link.lagDays;
          break;
        case 'FF':
          bound = predecessorFinish + link.lagDays - duration;
          break;
        case 'SF':
          bound = predecessorStart + link.lagDays - duration;
          break;
      }
      if (bound > start) start = bound;
    }
    earlyStart.set(id, start);
    earlyFinish.set(id, start + duration);
  }

  let projectDuration = 0;
  for (const finish of earlyFinish.values()) {
    if (finish > projectDuration) projectDuration = finish;
  }
  return ok({ earlyStart, earlyFinish, projectDuration });
}

// ---------------------------------------------------------------------------
// Network snapshots from the facts (the deterministic before/after split).
// ---------------------------------------------------------------------------

interface NetworkSnapshot {
  readonly activities: readonly NetworkActivity[];
  readonly links: readonly NetworkLink[];
}

/**
 * The network snapshot as of a ledger position (exclusive bound; null =
 * the whole stream — the current state). The forecast duration follows
 * the remaining-work model: the latest recorded remaining duration when
 * progress exists, the planned duration otherwise (completed activities
 * contribute zero).
 */
const snapshotAsOf = (
  facts: CommercialFacts,
  beforePosition: number | null,
): NetworkSnapshot => {
  const activities: NetworkActivity[] = [];
  for (const activity of facts.activities) {
    const assertions =
      beforePosition === null
        ? activity.durationAssertions
        : activity.durationAssertions.filter(
            (assertion) => assertion.source.position < beforePosition,
          );
    const planned = assertions[assertions.length - 1];
    if (planned === undefined) continue; // not yet added at this position
    let duration = planned.plannedDuration;
    const progress =
      activity.latestProgress !== null &&
      (beforePosition === null || activity.latestProgress.source.position < beforePosition)
        ? activity.latestProgress
        : null;
    if (progress !== null) {
      duration = progress.remainingDuration;
    }
    activities.push({ activityId: activity.activityId, duration });
  }
  const links: NetworkLink[] = [];
  for (const dependency of facts.dependencies) {
    const addedBefore =
      beforePosition === null || dependency.source.position < beforePosition;
    const removedBefore =
      dependency.removed &&
      dependency.removedSource !== null &&
      (beforePosition === null || dependency.removedSource.position < beforePosition);
    if (!addedBefore || removedBefore) continue;
    links.push({
      predecessorId: dependency.predecessorId,
      successorId: dependency.successorId,
      linkType: dependency.linkType,
      lagDays: dependency.lagDays,
    });
  }
  return { activities, links };
};

// ---------------------------------------------------------------------------
// Helpers over the subgraph (the relationship engine's traversal output).
// ---------------------------------------------------------------------------

const sameRef = (entity: { readonly entityKind: string; readonly entityId: EntityId },
  kind: string,
  id: EntityId,
): boolean => entity.entityKind === kind && entity.entityId === id;

/**
 * The entities the change event IMPACTS, by kind, from the subgraph's
 * 'impacts' edges (authorization-visible only): budgets, cost items,
 * activities — each list in canonical id order (deterministic).
 */
const impactedEntitiesOf = (
  subgraph: ImpactInputs['subgraph'],
  changeEventId: EntityId,
): {
  readonly budgets: readonly EntityId[];
  readonly costItems: readonly EntityId[];
  readonly activities: readonly EntityId[];
} => {
  const budgets = new Set<EntityId>();
  const costItems = new Set<EntityId>();
  const activities = new Set<EntityId>();
  for (const edge of subgraph.edges) {
    if (edge.kind !== 'impacts') continue;
    if (!sameRef(edge.from, CHANGE_EVENT_KIND, changeEventId)) continue;
    if (edge.to.entityKind === BUDGET_KIND) budgets.add(edge.to.entityId);
    else if (edge.to.entityKind === COST_ITEM_KIND) costItems.add(edge.to.entityId);
    else if (edge.to.entityKind === ACTIVITY_KIND) activities.add(edge.to.entityId);
  }
  const idsOf = (ids: ReadonlySet<EntityId>): readonly EntityId[] => [...ids].sort();
  return { budgets: idsOf(budgets), costItems: idsOf(costItems), activities: idsOf(activities) };
};

/**
 * The change orders DERIVED from the change event, from the subgraph's
 * 'derives-from' edges (authorization-visible only), canonical order.
 */
const derivedChangeOrderIdsOf = (
  subgraph: ImpactInputs['subgraph'],
  changeEventId: EntityId,
): readonly EntityId[] => {
  const orders = new Set<EntityId>();
  for (const edge of subgraph.edges) {
    if (edge.kind !== 'derives-from') continue;
    if (!sameRef(edge.to, CHANGE_EVENT_KIND, changeEventId)) continue;
    if (edge.from.entityKind === CHANGE_ORDER_KIND) {
      orders.add(edge.from.entityId);
    }
  }
  return [...orders].sort();
};

// ---------------------------------------------------------------------------
// Source references (the traceability spine of every number).
// ---------------------------------------------------------------------------

const referenceOf = (source: {
  readonly eventId: LedgerEventId;
  readonly eventName: EventName;
  readonly occurredAt: Timestamp;
}): SourceEventReference => ({
  eventId: source.eventId,
  eventName: source.eventName,
  occurredAt: source.occurredAt,
});

// ---------------------------------------------------------------------------
// THE calculation pieces.
// ---------------------------------------------------------------------------

const inputsConsistentFailure = (statement: string): DomainError =>
  invariantViolation({
    name: 'assessment-inputs-consistent',
    statement,
  });

const currencyConsistentFailure = (statement: string): DomainError =>
  invariantViolation({
    name: 'assessment-currency-consistent',
    statement,
  });

interface ScopeCheck {
  readonly scope: Scope;
  readonly entityKind: EntityKind;
  readonly entityId: EntityId;
}

/**
 * Every input fact's scope must be covered by the caller's execution scope
 * (freeze A12): a mixed-scope or foreign-scope input is typed-rejected
 * BEFORE any calculation — cross-tenant inputs never compute, and the
 * rejection never reveals the foreign scope's identity.
 */
function checkInputScopes(
  facts: CommercialFacts,
  subgraph: ImpactInputs['subgraph'],
  authorization: AssessmentAuthorization,
): Result<true, DomainError> {
  const checks: readonly ScopeCheck[] = [
    ...facts.contracts.map((fact) => ({
      scope: fact.source.scope, entityKind: 'contract' as EntityKind, entityId: fact.contractId,
    })),
    ...facts.changeEvents.map((fact) => ({
      scope: fact.source.scope, entityKind: CHANGE_EVENT_KIND, entityId: fact.changeEventId,
    })),
    ...facts.changeOrders.map((fact) => ({
      scope: fact.submissionSource.scope, entityKind: 'change-order' as EntityKind, entityId: fact.changeOrderId,
    })),
    ...facts.claimReferences.map((fact) => ({
      scope: fact.source.scope, entityKind: 'claim-reference' as EntityKind, entityId: fact.claimReferenceId,
    })),
    ...facts.budgets.map((fact) => ({
      scope: fact.source.scope, entityKind: 'budget' as EntityKind, entityId: fact.budgetId,
    })),
    ...facts.costItems.map((fact) => ({
      scope: fact.source.scope, entityKind: 'cost-item' as EntityKind, entityId: fact.costItemId,
    })),
    ...facts.budgetRevisions.map((fact) => ({
      scope: fact.source.scope, entityKind: 'budget-revision' as EntityKind, entityId: fact.revisionId,
    })),
    ...facts.commitments.map((fact) => ({
      scope: fact.source.scope, entityKind: 'commitment' as EntityKind, entityId: fact.commitmentId,
    })),
    ...facts.activities.map((fact) => ({
      scope: fact.source.scope, entityKind: ACTIVITY_KIND, entityId: fact.activityId,
    })),
    ...facts.dependencies.map((fact) => ({
      scope: fact.source.scope, entityKind: 'dependency' as EntityKind, entityId: fact.dependencyId,
    })),
    ...facts.baselines.map((fact) => ({
      scope: fact.source.scope, entityKind: 'baseline' as EntityKind, entityId: fact.baselineId,
    })),
    ...subgraph.edges.map((edge) => ({
      scope: edge.scope, entityKind: edge.from.entityKind, entityId: edge.from.entityId,
    })),
    ...subgraph.nodes.map((node) => ({
      scope: node.scope, entityKind: node.entity.entityKind, entityId: node.entity.entityId,
    })),
  ];
  for (const check of checks) {
    const covered = checkAssessmentScopeCovers(authorization, check);
    if (!covered.ok) {
      return fail(crossScopeInputRejection(authorization));
    }
  }
  return ok(true);
}

/**
 * The cost impact: the budget-side response to the change — the cost items
 * recorded AFTER the source change event on the impacted budgets (the
 * re-budgeting the change drove), each carrying its producing event, plus
 * the budget revisions that anchored the response.
 */
const costImpactOf = (
  facts: CommercialFacts,
  source: ChangeEventFact,
  impactedBudgets: readonly EntityId[],
): CostImpact => {
  const itemDeltas: CostImpact['itemDeltas'][number][] = [];
  const revisionAnchors: CostImpact['revisionAnchors'][number][] = [];
  for (const budgetId of impactedBudgets) {
    for (const item of facts.costItemsOf(budgetId)) {
      if (item.source.position > source.source.position) {
        itemDeltas.push({
          budgetId,
          costItemId: item.costItemId,
          amountMinor: item.amountMinor,
          source: referenceOf(item.source),
        });
      }
    }
    for (const revision of facts.budgetRevisionsOf(budgetId)) {
      if (revision.source.position > source.source.position) {
        revisionAnchors.push({
          budgetId,
          revisionId: revision.revisionId,
          source: referenceOf(revision.source),
        });
      }
    }
  }
  itemDeltas.sort((left, right) => {
    if (left.budgetId !== right.budgetId) return left.budgetId < right.budgetId ? -1 : 1;
    return left.costItemId < right.costItemId ? -1 : 1;
  });
  revisionAnchors.sort((left, right) => {
    if (left.budgetId !== right.budgetId) return left.budgetId < right.budgetId ? -1 : 1;
    return left.revisionId < right.revisionId ? -1 : 1;
  });
  return {
    budgetRevisionDeltaMinor: itemDeltas.reduce((sum, delta) => sum + delta.amountMinor, 0),
    itemDeltas,
    revisionAnchors,
    evidence: canonicalEvidence([
      ...itemDeltas.map((delta) => delta.source),
      ...revisionAnchors.map((anchor) => anchor.source),
    ]),
  };
};

/**
 * The schedule impact: the forecast deltas over the recorded network. The
 * pre-change network is the facts as of the source event's ledger position;
 * the current network is the whole stream; each impacted activity's delta
 * carries the post-change schedule assertions that touched it, and the
 * project duration delta carries all of them.
 */
const scheduleImpactOf = (
  facts: CommercialFacts,
  source: ChangeEventFact,
  impactedActivities: readonly EntityId[],
): Result<ScheduleImpact, DomainError> => {
  const sourcePosition = source.source.position;
  const pre = snapshotAsOf(facts, sourcePosition);
  const current = snapshotAsOf(facts, null);
  const preForecast = forwardPass(pre.activities, pre.links);
  if (!preForecast.ok) return preForecast;
  const currentForecast = forwardPass(current.activities, current.links);
  if (!currentForecast.ok) return currentForecast;

  const activityFacts = new Map<string, ActivityFact>(
    facts.activities.map((activity) => [activity.activityId, activity] as const),
  );
  const impactedScheduleIds = new Set<string>();
  for (const activityId of impactedActivities) {
    const fact = activityFacts.get(activityId);
    if (fact !== undefined) impactedScheduleIds.add(fact.scheduleId);
  }

  // The post-change schedule assertions (the delta drivers), per activity:
  // duration updates, progress records, and dependency add/removals that
  // touch the activity directly (upstream propagation is implied by the
  // network the pass walks — the drivers name the assertions, not the path).
  const driversOf = new Map<string, SourceEventReference[]>();
  const allDrivers: SourceEventReference[] = [];
  for (const activity of facts.activities) {
    const drivers: SourceEventReference[] = [];
    for (const assertion of activity.durationAssertions) {
      if (assertion.source.position > sourcePosition) {
        drivers.push(referenceOf(assertion.source));
      }
    }
    if (
      activity.latestProgress !== null &&
      activity.latestProgress.source.position > sourcePosition
    ) {
      drivers.push(referenceOf(activity.latestProgress.source));
    }
    for (const dependency of facts.dependencies) {
      const touches =
        dependency.predecessorId === activity.activityId ||
        dependency.successorId === activity.activityId;
      if (!touches) continue;
      if (dependency.source.position > sourcePosition) {
        drivers.push(referenceOf(dependency.source));
      }
      if (
        dependency.removed &&
        dependency.removedSource !== null &&
        dependency.removedSource.position > sourcePosition
      ) {
        drivers.push(referenceOf(dependency.removedSource));
      }
    }
    const unique = canonicalEvidence(drivers);
    if (unique.length > 0) {
      driversOf.set(activity.activityId, [...unique]);
      allDrivers.push(...unique);
    }
  }

  const activityDeltas: ActivityForecastDelta[] = [];
  for (const activityId of impactedActivities) {
    const fact = activityFacts.get(activityId);
    if (fact === undefined) continue;
    const currentStart = currentForecast.value.earlyStart.get(activityId) ?? 0;
    const currentFinish = currentForecast.value.earlyFinish.get(activityId) ?? 0;
    const preStart = preForecast.value.earlyStart.get(activityId) ?? 0;
    const preFinish = preForecast.value.earlyFinish.get(activityId) ?? 0;
    activityDeltas.push({
      activityId,
      code: fact.code,
      earlyStartDelta: currentStart - preStart,
      earlyFinishDelta: currentFinish - preFinish,
      drivers: driversOf.get(activityId) ?? [],
    });
  }
  activityDeltas.sort((left, right) => (left.activityId < right.activityId ? -1 : 1));

  const basisAnchors = facts.baselines
    .filter((baseline) => impactedScheduleIds.has(baseline.scheduleId))
    .map((baseline) => referenceOf(baseline.source))
    .sort((left, right) => (left.eventId < right.eventId ? -1 : 1));

  const drivers = canonicalEvidence(allDrivers);
  return ok({
    activityDeltas,
    projectDurationDelta:
      currentForecast.value.projectDuration - preForecast.value.projectDuration,
    preProjectDuration: preForecast.value.projectDuration,
    currentProjectDuration: currentForecast.value.projectDuration,
    drivers,
    basisAnchors,
    evidence: canonicalEvidence([...drivers, ...basisAnchors]),
  });
};

/**
 * The entitlement impact: the position of the change orders derived from
 * the change event — each order's value, its latest decision, and the
 * claims referenced against it — with the approved/rejected/pending totals.
 */
const entitlementOf = (
  facts: CommercialFacts,
  derivedOrderIds: readonly EntityId[],
): Result<EntitlementPosition, DomainError> => {
  const orders: ChangeOrderEntitlement[] = [];
  for (const changeOrderId of derivedOrderIds) {
    const fact = facts.changeOrderOf(changeOrderId);
    if (fact === null) {
      return fail(
        inputsConsistentFailure(
          `the subgraph derives change order ${changeOrderId} but the folded facts carry no submission for it (the subgraph and the facts must come from the same ledger stream)`,
        ),
      );
    }
    const claims = facts
      .claimReferencesOf(changeOrderId)
      .map((claim) => ({
        claimReferenceId: claim.claimReferenceId,
        claimEntityKind: claim.claimEntityKind,
        claimEntityId: claim.claimEntityId,
        documentId: claim.documentId,
        revisionId: claim.revisionId,
        source: referenceOf(claim.source),
      }))
      .sort((left, right) => (left.claimReferenceId < right.claimReferenceId ? -1 : 1));
    orders.push({
      changeOrderId,
      valueMinor: fact.valueMinor,
      currency: fact.currency,
      status: fact.status,
      submissionSource: referenceOf(fact.submissionSource),
      decisionSource: fact.decisionSource === null ? null : referenceOf(fact.decisionSource),
      claims,
    });
  }

  const valueOf = (statuses: readonly ChangeOrderFact['status'][]): number =>
    orders
      .filter((order) => statuses.includes(order.status) && order.valueMinor !== null)
      .reduce((sum, order) => sum + (order.valueMinor ?? 0), 0);
  const approvedValueMinor = valueOf(['approved', 'executed']);
  const rejectedValueMinor = valueOf(['rejected']);
  const pendingValueMinor = valueOf(['submitted']);

  let status: EntitlementPosition['status'];
  if (orders.length === 0) {
    status = 'none';
  } else if (orders.some((order) => order.status === 'submitted')) {
    status = approvedValueMinor > 0 ? 'entitled-with-exposure' : 'pending';
  } else if (approvedValueMinor > 0) {
    status = 'entitled';
  } else {
    status = 'rejected';
  }

  return ok({
    status,
    orders,
    approvedValueMinor,
    rejectedValueMinor,
    pendingValueMinor,
    evidence: canonicalEvidence([
      ...orders.map((order) => order.submissionSource),
      ...orders.flatMap((order) =>
        order.decisionSource === null ? [] : [order.decisionSource],
      ),
      ...orders.flatMap((order) => order.claims.map((claim) => claim.source)),
    ]),
  });
};

/**
 * The margin position: contracted value vs committed cost vs projected
 * cost over the source contract and the impacted budgets — every layer
 * carrying the evidence references that produced its amount. Contracted
 * value grows by approved/executed order values (construction semantics:
 * an approved change order amends the contract); committed cost is the
 * impacted budgets' latest commitment amounts; budgeted cost is the basis
 * of record (the current revision's item set); projected cost is committed
 * + the post-change working additions + the undecided order exposure.
 */
const marginPositionOf = (
  facts: CommercialFacts,
  source: ChangeEventFact,
  impactedBudgets: readonly EntityId[],
  entitlement: EntitlementPosition,
  costImpact: CostImpact,
): Result<MarginPosition, DomainError> => {
  const contract = facts.contracts.find((fact) => fact.contractId === source.contractId);
  if (contract === undefined) {
    return fail(
      inputsConsistentFailure(
        `change event ${source.changeEventId} was raised against contract ${source.contractId}, but the folded facts carry no creation of that contract`,
      ),
    );
  }

  // Currency consistency (fail-closed): every money layer of the position
  // must share the contract's currency.
  for (const budgetId of impactedBudgets) {
    const budget = facts.budgets.find((fact) => fact.budgetId === budgetId);
    if (budget === undefined) {
      return fail(
        inputsConsistentFailure(
          `the change event impacts budget ${budgetId}, but the folded facts carry no creation of that budget`,
        ),
      );
    }
    if (budget.currency !== contract.currency) {
      return fail(
        currencyConsistentFailure(
          `contract ${contract.contractId} is denominated in ${contract.currency} but budget ${budget.budgetId} is denominated in ${budget.currency}`,
        ),
      );
    }
  }
  for (const order of entitlement.orders) {
    if (
      order.valueMinor !== null &&
      order.currency !== null &&
      order.currency !== contract.currency
    ) {
      return fail(
        currencyConsistentFailure(
          `change order ${order.changeOrderId} is denominated in ${order.currency} but contract ${contract.contractId} is denominated in ${contract.currency}`,
        ),
      );
    }
  }

  const contractedValue: MarginLayer = {
    amountMinor:
      contract.valueMinor +
      entitlement.orders
        .filter((order) => order.status === 'approved' || order.status === 'executed')
        .reduce((sum, order) => sum + (order.valueMinor ?? 0), 0),
    evidence: canonicalEvidence([
      referenceOf(contract.source),
      ...entitlement.orders
        .filter((order) => order.status === 'approved' || order.status === 'executed')
        .flatMap((order) => [
          order.submissionSource,
          ...(order.decisionSource === null ? [] : [order.decisionSource]),
        ]),
    ]),
  };

  const committedEvidence: SourceEventReference[] = [];
  let committedAmount = 0;
  for (const budgetId of impactedBudgets) {
    for (const commitment of facts.commitmentsOf(budgetId)) {
      committedAmount += commitment.committedAmountMinor;
      committedEvidence.push(referenceOf(commitment.source));
    }
  }
  const committedCost: MarginLayer = {
    amountMinor: committedAmount,
    evidence: canonicalEvidence(committedEvidence),
  };

  // Budgeted cost — the basis of record: the CURRENT revision's item set
  // (items recorded before the latest revision — the exact snapshot the
  // revision anchored; all items when no revision has landed), mirroring
  // the cost domain's current-revision balance basis.
  const budgetedEvidence: SourceEventReference[] = [];
  let budgetedAmount = 0;
  for (const budgetId of impactedBudgets) {
    const revisions = facts.budgetRevisionsOf(budgetId);
    const latest = revisions.length > 0 ? revisions[revisions.length - 1] : undefined;
    const anchorPosition =
      latest === undefined ? Number.POSITIVE_INFINITY : latest.source.position;
    if (latest !== undefined) budgetedEvidence.push(referenceOf(latest.source));
    for (const item of facts.costItemsOf(budgetId)) {
      if (item.source.position < anchorPosition) {
        budgetedAmount += item.amountMinor;
        budgetedEvidence.push(referenceOf(item.source));
      }
    }
  }
  const budgetedCost: MarginLayer = {
    amountMinor: budgetedAmount,
    evidence: canonicalEvidence(budgetedEvidence),
  };

  const projectedCost: MarginLayer = {
    amountMinor:
      committedCost.amountMinor +
      costImpact.budgetRevisionDeltaMinor +
      entitlement.pendingValueMinor,
    evidence: canonicalEvidence([
      ...committedCost.evidence,
      ...costImpact.evidence,
      ...entitlement.orders
        .filter((order) => order.status === 'submitted')
        .map((order) => order.submissionSource),
    ]),
  };

  return ok({
    contractedValue,
    committedCost,
    budgetedCost,
    projectedCost,
    marginMinor: contractedValue.amountMinor - projectedCost.amountMinor,
    marginOverCommittedMinor: contractedValue.amountMinor - committedCost.amountMinor,
    currency: contract.currency,
  });
};

/**
 * The deterministic confidence (A4): derived from data-completeness
 * signals only — an isolated change event (no relationships at all) is
 * low; undecided orders, unanchored budget revisions, or impacted
// activities without post-change schedule assertions cap at medium;
 * complete inputs are high. Stable machine-readable reason codes.
 */
const confidenceOf = (
  subgraphEdgeCount: number,
  costImpact: CostImpact,
  impactedActivities: readonly EntityId[],
  scheduleImpact: ScheduleImpact,
  entitlement: EntitlementPosition,
): AssessmentConfidence => {
  const reasons: AssessmentConfidenceReason[] = [];
  if (subgraphEdgeCount === 0) reasons.push('isolated-change-event');
  if (entitlement.orders.some((order) => order.status === 'submitted')) {
    reasons.push('undecided-change-order');
  }
  if (costImpact.itemDeltas.length > 0 && costImpact.revisionAnchors.length === 0) {
    reasons.push('unanchored-budget-revision');
  }
  const anyUnchangedActivity = impactedActivities.some((activityId) => {
    const delta = scheduleImpact.activityDeltas.find(
      (candidate) => candidate.activityId === activityId,
    );
    return delta === undefined || delta.drivers.length === 0;
  });
  if (anyUnchangedActivity) reasons.push('unchanged-impacted-activity');
  if (reasons.length === 0) reasons.push('complete-inputs');
  const level = reasons.includes('isolated-change-event')
    ? 'low'
    : reasons.includes('complete-inputs')
      ? 'high'
      : 'medium';
  return { level, reasons };
};

/**
 * THE impact calculation: a pure, deterministic function from the folded
 * commercial facts + the authorization-filtered relationship subgraph of
 * the source change event to ONE versioned ImpactAssessment. Authorization
 * is checked BEFORE calculation (a denied request never computes); every
 * impact number carries the source event ids that produced it (A4).
 */
export function calculateImpact(
  query: ImpactQuery,
  inputs: ImpactInputs,
  authorization: AssessmentAuthorization,
  parts: AssessmentParts,
): Result<ImpactAssessment, DomainError> {
  // 1. Capability gate — deny-by-default, before ANY input is read.
  const capabilities = checkAssessmentCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  // 2. Source lookup + structural A12 scope coverage (no existence oracle:
  //    a foreign source event is indistinguishable from an absent one).
  const source = inputs.facts.changeEventByLedgerId(query.sourceEventId);
  if (source === null) {
    return fail(sourceEventNotFound(query.sourceEventId, authorization));
  }
  const sourceScope = checkAssessmentScopeCovers(authorization, {
    scope: source.source.scope,
    entityKind: CHANGE_EVENT_KIND,
    entityId: source.changeEventId,
  });
  if (!sourceScope.ok) {
    return fail(sourceEventNotFound(query.sourceEventId, authorization));
  }

  // 3. Cross-scope input rejection (A12): mixed-scope inputs never compute.
  const inputScopes = checkInputScopes(inputs.facts, inputs.subgraph, authorization);
  if (!inputScopes.ok) return inputScopes;

  // 4. Policy gate over the assessed change event (deny-by-default).
  const policy = checkAssessmentPolicy(authorization, {
    scope: source.source.scope,
    changeEventId: source.changeEventId,
  });
  if (!policy.ok) return policy;

  // 5. The calculation itself — every number carries its source events.
  const impacted = impactedEntitiesOf(inputs.subgraph, source.changeEventId);
  const derivedOrderIds = derivedChangeOrderIdsOf(inputs.subgraph, source.changeEventId);

  const costImpact = costImpactOf(inputs.facts, source, impacted.budgets);
  const scheduleImpact = scheduleImpactOf(inputs.facts, source, impacted.activities);
  if (!scheduleImpact.ok) return scheduleImpact;
  const entitlement = entitlementOf(inputs.facts, derivedOrderIds);
  if (!entitlement.ok) return entitlement;
  const marginPosition = marginPositionOf(
    inputs.facts,
    source,
    impacted.budgets,
    entitlement.value,
    costImpact,
  );
  if (!marginPosition.ok) return marginPosition;

  const sourceSummary: ChangeEventSource = {
    eventId: source.source.eventId,
    changeEventId: source.changeEventId,
    contractId: source.contractId,
    title: source.title,
    changeType: source.changeType,
    evidenceLinks: source.evidenceLinks.map((link) => ({
      documentId: link.documentId,
      revisionId: link.revisionId,
    })),
    scope: source.source.scope,
    actor: authorization.context.actor,
    occurredAt: source.source.occurredAt,
    correlationId: source.source.correlationId,
  };

  const confidence = confidenceOf(
    inputs.subgraph.edges.length,
    costImpact,
    impacted.activities,
    scheduleImpact.value,
    entitlement.value,
  );

  const policyContext: AssessmentPolicyContext = {
    capabilities: [...authorization.context.capabilities].sort(),
    requiredCapabilities: [...ASSESSMENT_REQUIRED_CAPABILITY_NAMES],
    policyRuleCount: authorization.policy.rules.length,
    decision: 'allow',
  };

  const evidence = canonicalEvidence([
    referenceOf(source.source),
    ...costImpact.evidence,
    ...scheduleImpact.value.evidence,
    ...entitlement.value.evidence,
    ...marginPosition.value.contractedValue.evidence,
    ...marginPosition.value.committedCost.evidence,
    ...marginPosition.value.budgetedCost.evidence,
    ...marginPosition.value.projectedCost.evidence,
  ]);

  return ok({
    assessmentId: parts.assessmentId,
    assessmentVersion: ASSESSMENT_SCHEMA_VERSION,
    engine: ASSESSMENT_ENGINE,
    assessedAt: parts.assessedAt,
    actor: authorization.context.actor,
    scope: source.source.scope,
    query: { sourceEventId: query.sourceEventId },
    source: sourceSummary,
    consumed: {
      projectedEventCount: inputs.facts.derivation.projectedEventCount,
      subgraphNodeCount: inputs.subgraph.nodes.length,
      subgraphEdgeCount: inputs.subgraph.edges.length,
    },
    costImpact,
    scheduleImpact: scheduleImpact.value,
    entitlementImpact: entitlement.value,
    marginPosition: marginPosition.value,
    confidence,
    policyContext,
    evidence,
  } satisfies ImpactAssessment);
}
