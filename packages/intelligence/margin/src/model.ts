// Office intelligence — the impact assessment model (OFF-014).
//
// An ImpactAssessment is ONE deterministic, versioned machine-generated
// claim about the commercial consequence of a source change event: the
// calculated cost/schedule/entitlement impacts, the aggregated margin
// position (contracted value vs committed cost vs projected cost), and —
// the named acceptance — the exact SOURCE EVENT IDS that produced every
// number (freeze A4: every consequential machine-generated claim carries
// evidence references, source identity, timestamps, confidence, and policy
// context).
//
// The model contains no clock, no randomness, no environment, and no
// entity data beyond ids/refs and the commercial numbers the ledger
// payloads assert: calculateImpact() is a PURE function of its inputs
// (the folded commercial facts + the authorization-filtered relationship
// subgraph + the injected assessment identity/clock), so the same inputs
// always produce the byte-identical assessment.
import { parseEntityKind, parseFail, parseOk } from '@office/contracts';
import type {
  Actor,
  EntityId,
  EntityKind,
  EventName,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import { parseLedgerEventId } from '@office/events';
import type { LedgerEventId } from '@office/events';
import type { TraversalSubgraph } from '@office/intelligence-relationships';
import type { AssessmentId } from './vocabulary';
import type { CommercialFacts } from './facts';

// ---------------------------------------------------------------------------
// Local structural money (documented deviation): the domain packages'
// Money value object ({ amount: MinorUnits, currency: CurrencyCode }) is
// owned by packages/domain/contracts, which this engine must not import
// (the dependency rule forbids domain-package imports). The commercial
// numbers of the recorded event payloads are integer MINOR UNITS plus an
// ISO-4217-style uppercase currency code — this local structural type
// mirrors exactly that shape. Amounts are exact integers; the engine never
// rounds.
// ---------------------------------------------------------------------------

/** The grammar of the money currency code (mirrors the domain value object). */
export const CURRENCY_CODE_GRAMMAR = 'ISO-4217-style uppercase currency code (3 letters)';

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

declare const currencyCodeBrand: unique symbol;

/** Currency code of the commercial money layers (local structural mirror). */
export type CurrencyCode = string & { readonly [currencyCodeBrand]: 'CurrencyCode' };

/** Parse an untrusted value as a CurrencyCode (total, fail-closed). */
export function parseCurrencyCode(raw: unknown): ParseResult<CurrencyCode> {
  if (typeof raw !== 'string' || !CURRENCY_CODE_PATTERN.test(raw)) {
    return parseFail(
      'invalid-value',
      '',
      CURRENCY_CODE_GRAMMAR,
      raw === null || raw === undefined
        ? String(raw)
        : typeof raw === 'string'
          ? `string ${JSON.stringify(raw)}`
          : typeof raw,
    );
  }
  return parseOk(raw as CurrencyCode);
}

// ---------------------------------------------------------------------------
// Source event references — the traceability spine of every number.
// ---------------------------------------------------------------------------

/** Reference to the ledger event that produced one number or fact. */
export interface SourceEventReference {
  /** The ledger id of the producing event (deterministic, A9-friendly). */
  readonly eventId: LedgerEventId;
  /** The producing event's name, e.g. 'cost.costItemRecorded'. */
  readonly eventName: EventName;
  /** The producing event's occurred-at time. */
  readonly occurredAt: Timestamp;
}

/** Canonical source-reference order: event name, then ledger event id. */
export const compareSourceEventReferences = (
  left: SourceEventReference,
  right: SourceEventReference,
): number => {
  if (left.eventName !== right.eventName) {
    return left.eventName < right.eventName ? -1 : 1;
  }
  if (left.eventId !== right.eventId) {
    return left.eventId < right.eventId ? -1 : 1;
  }
  return 0;
};

/** Deduplicate and canonically order source references (by event id). */
export const canonicalEvidence = (
  references: readonly SourceEventReference[],
): readonly SourceEventReference[] => {
  const byEventId = new Map<string, SourceEventReference>();
  for (const reference of references) {
    if (!byEventId.has(reference.eventId)) {
      byEventId.set(reference.eventId, reference);
    }
  }
  return [...byEventId.values()].sort(compareSourceEventReferences);
};

// ---------------------------------------------------------------------------
// The assessment query + inputs.
// ---------------------------------------------------------------------------

/** Shape description used in parse failures. */
export const IMPACT_QUERY_GRAMMAR =
  "ImpactQuery: { sourceEventId: LedgerEventId (the contracts.changeEventRaised ledger event the assessment assesses) }";

const IMPACT_QUERY_KEYS = ['sourceEventId'] as const;

/** What to assess: the ledger event id of the source change event. */
export interface ImpactQuery {
  /** Ledger id of the `contracts.changeEventRaised` event under assessment. */
  readonly sourceEventId: LedgerEventId;
}

const describeValue = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  if (typeof raw === 'number' || typeof raw === 'boolean') return `${typeof raw} ${String(raw)}`;
  return typeof raw;
};

const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Parse an untrusted value as an ImpactQuery (total, fail-closed, strict keys). */
export function parseImpactQuery(raw: unknown): ParseResult<ImpactQuery> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', IMPACT_QUERY_GRAMMAR, describeValue(raw));
  }
  const knownKeys = new Set<string>(IMPACT_QUERY_KEYS);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      return parseFail('unknown-field', key, IMPACT_QUERY_GRAMMAR, 'present');
    }
  }
  const sourceEventId = parseLedgerEventId(raw['sourceEventId']);
  if (!sourceEventId.ok) {
    return parseFail(
      sourceEventId.error.code,
      'sourceEventId',
      sourceEventId.error.expected,
      sourceEventId.error.received,
    );
  }
  return parseOk({ sourceEventId: sourceEventId.value } satisfies ImpactQuery);
}

/** Type guard for structurally valid ImpactQuery values. */
export function isImpactQuery(raw: unknown): raw is ImpactQuery {
  return parseImpactQuery(raw).ok;
}

/** The typed inputs of one impact calculation. */
export interface ImpactInputs {
  /**
   * The commercial facts folded from the visible ledger stream
   * (projectCommercialFacts) — every fact carries its producing event.
   */
  readonly facts: CommercialFacts;
  /**
   * The authorization-filtered relationship subgraph around the source
   * change event (traverseRelationships of @office/intelligence-relationships).
   */
  readonly subgraph: TraversalSubgraph;
}

// ---------------------------------------------------------------------------
// The calculated impacts. Every amount is integer minor units of the
// assessment's single currency; every number carries the source event
// references that produced it (THE traceability acceptance).
// ---------------------------------------------------------------------------

/** One cost-item delta of the budget revision response to the change. */
export interface CostItemDelta {
  /** The budget the item was recorded against. */
  readonly budgetId: EntityId;
  /** The recorded cost item. */
  readonly costItemId: EntityId;
  /** The item's recorded amount (integer minor units). */
  readonly amountMinor: number;
  /** The costItemRecorded event that produced this number. */
  readonly source: SourceEventReference;
}

/** The cost impact: the budget-side response to the source change event. */
export interface CostImpact {
  /** Total budget revision delta: cost items recorded after the change. */
  readonly budgetRevisionDeltaMinor: number;
  /** Each contributing item delta, in canonical (budget, item) order. */
  readonly itemDeltas: readonly CostItemDelta[];
  /** The budget revisions that anchored the response, in canonical order. */
  readonly revisionAnchors: readonly {
    readonly budgetId: EntityId;
    readonly revisionId: EntityId;
    readonly source: SourceEventReference;
  }[];
  /** Every source event id behind every cost number, canonical order. */
  readonly evidence: readonly SourceEventReference[];
}

/** One impacted activity's forecast delta (calendar-free day offsets). */
export interface ActivityForecastDelta {
  /** The impacted activity. */
  readonly activityId: EntityId;
  /** The activity's code (schedule identity, not canonical id). */
  readonly code: string;
  /** Forecast early-start delta: current − pre-change (day offsets). */
  readonly earlyStartDelta: number;
  /** Forecast early-finish delta: current − pre-change (day offsets). */
  readonly earlyFinishDelta: number;
  /** The post-change schedule assertions that touched this activity. */
  readonly drivers: readonly SourceEventReference[];
}

/** The schedule impact: forecast deltas over the recorded network. */
export interface ScheduleImpact {
  /** Each impacted activity's forecast delta, in canonical activity order. */
  readonly activityDeltas: readonly ActivityForecastDelta[];
  /** Project duration delta: current − pre-change (day offsets). */
  readonly projectDurationDelta: number;
  /** The pre-change project duration (the forecast basis). */
  readonly preProjectDuration: number;
  /** The current project duration. */
  readonly currentProjectDuration: number;
  /** Every post-change schedule assertion that moved the network. */
  readonly drivers: readonly SourceEventReference[];
  /** The recorded baselines anchoring the forecast basis (evidence only). */
  readonly basisAnchors: readonly SourceEventReference[];
  /** Every source event id behind every schedule number, canonical order. */
  readonly evidence: readonly SourceEventReference[];
}

/** The entitlement position of one change order derived from the change. */
export interface ChangeOrderEntitlement {
  /** The change order. */
  readonly changeOrderId: EntityId;
  /** The order's submitted value (null when the order carried none). */
  readonly valueMinor: number | null;
  /** The order's currency (null when the order carried no value). */
  readonly currency: CurrencyCode | null;
  /** The order's latest recorded status. */
  readonly status: 'submitted' | 'approved' | 'rejected' | 'executed';
  /** The changeOrderSubmitted event that produced the value. */
  readonly submissionSource: SourceEventReference;
  /** The decision event (approved/rejected/executed), or null while pending. */
  readonly decisionSource: SourceEventReference | null;
  /** The claims referenced against this order, in canonical order. */
  readonly claims: readonly {
    readonly claimReferenceId: EntityId;
    readonly claimEntityKind: EntityKind;
    readonly claimEntityId: EntityId;
    readonly documentId: EntityId;
    readonly revisionId: EntityId;
    readonly source: SourceEventReference;
  }[];
}

/** The aggregate entitlement position. */
export interface EntitlementPosition {
  /** The standing of the position (derived, deterministic). */
  readonly status: 'none' | 'pending' | 'entitled' | 'entitled-with-exposure' | 'rejected';
  /** Each derived change order's position, in canonical order. */
  readonly orders: readonly ChangeOrderEntitlement[];
  /** Total value of approved + executed orders (integer minor units). */
  readonly approvedValueMinor: number;
  /** Total value of rejected orders (integer minor units). */
  readonly rejectedValueMinor: number;
  /** Total value of submitted-but-undecided orders (integer minor units). */
  readonly pendingValueMinor: number;
  /** Every source event id behind every entitlement number, canonical order. */
  readonly evidence: readonly SourceEventReference[];
}

/** One margin layer: an amount plus the evidence that produced it. */
export interface MarginLayer {
  /** The layer's amount (integer minor units). */
  readonly amountMinor: number;
  /** The source events behind the layer's amount, canonical order. */
  readonly evidence: readonly SourceEventReference[];
}

/** The aggregated margin position of the source contract + impacted budgets. */
export interface MarginPosition {
  /** Contracted value: contract value + approved/executed order values. */
  readonly contractedValue: MarginLayer;
  /** Committed cost: latest committed amounts of the impacted budgets. */
  readonly committedCost: MarginLayer;
  /** Budgeted cost (basis of record): the current revision's item set. */
  readonly budgetedCost: MarginLayer;
  /** Projected cost: committed + post-change budget additions + pending orders. */
  readonly projectedCost: MarginLayer;
  /** Margin over projected cost: contracted − projected. */
  readonly marginMinor: number;
  /** Margin over committed cost: contracted − committed. */
  readonly marginOverCommittedMinor: number;
  /** The single currency of every layer. */
  readonly currency: CurrencyCode;
}

// ---------------------------------------------------------------------------
// A4 provenance: confidence + policy context.
// ---------------------------------------------------------------------------

/** The deterministic confidence level of the assessment. */
export type AssessmentConfidenceLevel = 'low' | 'medium' | 'high';

/** Why the confidence level is what it is (stable machine-readable codes). */
export type AssessmentConfidenceReason =
  | 'isolated-change-event'
  | 'undecided-change-order'
  | 'unanchored-budget-revision'
  | 'unchanged-impacted-activity'
  | 'complete-inputs';

/** The deterministic confidence assessment (A4). */
export interface AssessmentConfidence {
  readonly level: AssessmentConfidenceLevel;
  readonly reasons: readonly AssessmentConfidenceReason[];
}

/** The policy context the assessment was produced under (A4). */
export interface AssessmentPolicyContext {
  /** The capabilities the requesting context held (canonical order). */
  readonly capabilities: readonly string[];
  /** The area read capabilities the assessment requires (canonical order). */
  readonly requiredCapabilities: readonly string[];
  /** The caller's static policy: its rule count (the policy digest). */
  readonly policyRuleCount: number;
  /** The authorization decision that admitted the assessment. */
  readonly decision: 'allow';
}

// ---------------------------------------------------------------------------
// THE assessment model.
// ---------------------------------------------------------------------------

/** The schema version of the ImpactAssessment model (bump on shape change). */
export const ASSESSMENT_SCHEMA_VERSION = 1;

/** The source identity of the assessing engine (A4 'source identity'). */
export const ASSESSMENT_ENGINE = 'intelligence-margin';

/** The summary of the assessment's subject change event. */
export interface ChangeEventSource {
  /** The ledger event id of the assessed `contracts.changeEventRaised` event. */
  readonly eventId: LedgerEventId;
  /** The change event entity. */
  readonly changeEventId: EntityId;
  /** The owning contract. */
  readonly contractId: EntityId;
  /** The change event's title. */
  readonly title: string;
  /** The change event's type. */
  readonly changeType: string;
  /** The change event's evidence links (document revisions). */
  readonly evidenceLinks: readonly {
    readonly documentId: EntityId;
    readonly revisionId: EntityId;
  }[];
  /** The scope the change event was raised under. */
  readonly scope: Scope;
  /** The actor that raised the change event. */
  readonly actor: Actor;
  /** The change event's occurred-at time. */
  readonly occurredAt: Timestamp;
  /** The change event's correlation id. */
  readonly correlationId: string;
}

/**
 * THE impact assessment: a deterministic, versioned machine-generated claim.
 * Carries the calculated impacts, the margin position, confidence + policy
 * context (A4), the consumed inputs' shape, and the complete evidence set —
 * every source event id that produced any number, in canonical order.
 */
export interface ImpactAssessment {
  /** The caller-supplied assessment identity (deterministic token). */
  readonly assessmentId: AssessmentId;
  /** The model schema version of this assessment. */
  readonly assessmentVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  /** The source identity of the assessing engine (A4). */
  readonly engine: typeof ASSESSMENT_ENGINE;
  /** When the assessment was produced (injected clock — never wall time). */
  readonly assessedAt: Timestamp;
  /** The actor the assessment was produced for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the assessment was produced under. */
  readonly scope: Scope;
  /** The query the assessment answers. */
  readonly query: ImpactQuery;
  /** The subject change event summary. */
  readonly source: ChangeEventSource;
  /** The consumed inputs' shape (facts + subgraph). */
  readonly consumed: {
    readonly projectedEventCount: number;
    readonly subgraphNodeCount: number;
    readonly subgraphEdgeCount: number;
  };
  /** The cost impact. */
  readonly costImpact: CostImpact;
  /** The schedule impact. */
  readonly scheduleImpact: ScheduleImpact;
  /** The entitlement impact. */
  readonly entitlementImpact: EntitlementPosition;
  /** The aggregated margin position. */
  readonly marginPosition: MarginPosition;
  /** The deterministic confidence (A4). */
  readonly confidence: AssessmentConfidence;
  /** The policy context the assessment was produced under (A4). */
  readonly policyContext: AssessmentPolicyContext;
  /**
   * THE traceability acceptance: every source event id that produced any
   * number of this assessment, deduplicated and in canonical order.
   */
  readonly evidence: readonly SourceEventReference[];
}

// ---------------------------------------------------------------------------
// Entity kind constants the assessment vocabulary references (the kinds
// of the entities the impact links point at — mirroring the landed
// packages' declared kinds exactly, the same local-vocabulary idiom the
// relationship engine uses).
// ---------------------------------------------------------------------------

const kindLiteral = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind literal: ${literal}`);
  }
  return parsed.value;
};

export const CONTRACT_KIND: EntityKind = kindLiteral('contract');
export const BUDGET_KIND: EntityKind = kindLiteral('budget');
export const COST_ITEM_KIND: EntityKind = kindLiteral('cost-item');
export const BUDGET_REVISION_KIND: EntityKind = kindLiteral('budget-revision');
export const COMMITMENT_KIND: EntityKind = kindLiteral('commitment');
export const ACTIVITY_KIND: EntityKind = kindLiteral('activity');
export const DEPENDENCY_KIND: EntityKind = kindLiteral('dependency');
export const BASELINE_KIND: EntityKind = kindLiteral('baseline');
export const CHANGE_EVENT_KIND: EntityKind = kindLiteral('change-event');
export const CHANGE_ORDER_KIND: EntityKind = kindLiteral('change-order');
export const CLAIM_REFERENCE_KIND: EntityKind = kindLiteral('claim-reference');
