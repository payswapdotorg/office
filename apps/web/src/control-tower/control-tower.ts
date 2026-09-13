// Office web application shell — the control-tower surface (OFF-030).
//
// THE view model over @office/intelligence-exceptions' portfolio exception
// set: the ledger stream is folded into the commercial facts
// (@office/intelligence-margin's deterministic, rebuildable fold), projected
// into the relationship index (@office/intelligence-relationships), each
// raised change event is assessed (the margin engine's pure calculateImpact
// over its authorization-filtered traversal subgraph), the assessment set is
// scanned (detectExceptions — THE deterministic detection pass), ranked
// (rankExceptions — the exposed priority composition), and every exception's
// suggested next actions are displayed as SUGGESTIONS ONLY (suggestNextActions
// — typed command references, never executed here).
//
// The control tower NEVER mutates anything and holds no state of its own:
// every scan recomputes from the ledger (A2/A7 — run-twice identical, the
// same scan identity produces the same exception set), and authorization is
// the exceptions package's own deny-by-default gate (capability → scope →
// policy, before any input is read).
import type { Timestamp } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEventId } from '@office/events';
import { projectCommercialFacts } from '@office/intelligence-margin';
import { calculateImpact } from '@office/intelligence-margin';
import { parseAssessmentId } from '@office/intelligence-margin';
import type { BudgetFact, ImpactAssessment } from '@office/intelligence-margin';
import {
  DEFAULT_PRIORITY_WEIGHTS,
  detectExceptions,
  parseScanId,
  rankExceptions,
  suggestNextActions,
} from '@office/intelligence-exceptions';
import type { Exception, PriorityWeights, RankedException } from '@office/intelligence-exceptions';
import { projectRelationships, traverseRelationships } from '@office/intelligence-relationships';
import type { TraversalSubgraph } from '@office/intelligence-relationships';
import type { SeededWorld } from '../session/world';
import type { WebSession } from '../session/session';
import { entityRefOf, sessionContextOf } from '../session/session';

// ---------------------------------------------------------------------------
// The control-tower view model (JSON-safe, deterministic).
// ---------------------------------------------------------------------------

/** One evidence-chain entry of an exception (A4 — every claim is chained). */
export interface ExceptionEvidenceView {
  readonly kind: 'assessment' | 'event' | 'benchmark';
  /** The ledger event id (event entries) or the assessment id (assessment entries). */
  readonly referenceId: string;
  readonly eventName: string | null;
  readonly occurredAt: Timestamp | null;
}

/** One SUGGESTED next action (a typed command reference — never executed). */
export interface SuggestedActionView {
  readonly commandName: string;
  readonly title: string;
  readonly rationale: string;
  readonly confidenceLevel: string;
  readonly confidenceReasons: readonly string[];
  /** The deterministic reference payload (ids only — no actors/keys/versions). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** One ranked exception of the portfolio set. */
export interface ExceptionItemView {
  readonly exceptionId: string;
  readonly rank: number;
  readonly kind: string;
  readonly title: string;
  readonly severityLevel: string;
  readonly severityReasons: readonly string[];
  /** The priority score's exposed composition (recomputable by hand). */
  readonly priorityScore: { readonly severity: string; readonly economic: string; readonly total: string };
  readonly economicImpact: { readonly amountMinor: number | null; readonly currency: string | null };
  readonly affectedEntities: readonly { readonly entityKind: string; readonly entityId: string }[];
  readonly evidence: readonly ExceptionEvidenceView[];
  readonly suggestedActions: readonly SuggestedActionView[];
}

/** THE control-tower view model. */
export interface ControlTowerView {
  readonly kind: 'control-tower';
  readonly scanId: string;
  readonly detectedAt: Timestamp;
  readonly exceptionCount: number;
  readonly items: readonly ExceptionItemView[];
}

// ---------------------------------------------------------------------------
// The scan composition (pure, deterministic — the documented pipeline).
// ---------------------------------------------------------------------------

/** The deterministic scan identity supplier parts (injected, never wall time). */
export interface ControlTowerScanParts {
  readonly scanId: string;
  readonly detectedAt: Timestamp;
  /** The deterministic assessment identity sequence (one per change event). */
  readonly assessmentIds: readonly string[];
}

/**
 * Compose THE control-tower view: fold → project → assess → detect → rank →
 * suggest. The scan identity and clock are injected (determinism); the
 * exception set is the portfolio's ranked order; every item carries its full
 * evidence chain and SUGGESTIONS ONLY next actions.
 */
export function controlTowerView(
  world: SeededWorld,
  session: WebSession,
  parts: ControlTowerScanParts,
): Result<ControlTowerView, DomainError> {
  const scanId = parseScanId(parts.scanId);
  if (!scanId.ok) {
    return {
      ok: false,
      error: domainError(
        'invariant-violation',
        `invalid control-tower scan id '${parts.scanId}'`,
        [{ code: 'invalid-scan-id', message: parts.scanId, path: 'scanId' }],
        { scope: session.scope, correlationId: null },
      ),
    };
  }

  // 1. The commercial facts fold (deterministic, rebuildable — A7).
  const facts = projectCommercialFacts(world.ledgerEvents);
  if (!facts.ok) return facts;

  // 2. The relationship index over the same stream (A7).
  const index = projectRelationships(world.ledgerEvents);
  if (!index.ok) return index;

  // 3. One assessment per raised change event visible to the session: the
  //    authorization-filtered traversal subgraph of the change event, then
  //    the margin engine's pure calculation over facts + subgraph.
  const authorization = { policy: session.policy, context: sessionContextOf(session) };
  const subgraphs: TraversalSubgraph[] = [];
  const assessments: ImpactAssessment[] = [];
  let assessmentOrdinal = 0;
  for (const changeEvent of facts.value.changeEvents) {
    if (changeEvent.source.scope.tenantId !== session.tenantId) continue;
    if (
      changeEvent.source.scope.kind === 'project' &&
      changeEvent.source.scope.projectId !== session.projectId
    ) {
      continue;
    }
    const traversal = traverseRelationships(
      index.value,
      {
        start: entityRefOf('change-event', changeEvent.changeEventId),
        maxDepth: 3,
      },
      authorization,
    );
    if (!traversal.ok) return traversal;
    subgraphs.push(traversal.value);

    const assessmentIdentity =
      parts.assessmentIds[assessmentOrdinal] ?? `assessment-${assessmentOrdinal + 1}`;
    const assessmentId = parseAssessmentId(assessmentIdentity);
    if (!assessmentId.ok) {
      return {
        ok: false,
        error: domainError(
          'invariant-violation',
          `invalid assessment id '${assessmentIdentity}'`,
          [{ code: 'invalid-assessment-id', message: assessmentIdentity, path: 'assessmentIds' }],
          { scope: session.scope, correlationId: null },
        ),
      };
    }
    const assessed = calculateImpact(
      { sourceEventId: changeEvent.source.eventId as LedgerEventId },
      { facts: facts.value, subgraph: traversal.value },
      authorization,
      { assessmentId: assessmentId.value, assessedAt: parts.detectedAt },
    );
    if (!assessed.ok) return assessed;
    assessments.push(assessed.value);
    assessmentOrdinal += 1;
  }

  // 4. THE deterministic detection pass + the seeded prioritization. The
  //    ranking seed scale's currency is derived ONLY when the session has a
  //    visible portfolio (a session that sees no change events sees an EMPTY
  //    exception set — A12: invisible rows are absent, never an oracle).
  const detected = detectExceptions(
    { assessments, subgraphs, benchmarks: [] },
    authorization,
    { scanId: scanId.value, detectedAt: parts.detectedAt },
  );
  if (!detected.ok) return detected;
  const weights: Result<PriorityWeights, DomainError> =
    assessments.length === 0
      ? { ok: true, value: DEFAULT_PRIORITY_WEIGHTS }
      : seedWeightsOf(session, facts.value.budgets);
  if (!weights.ok) return weights;
  const ranked = rankExceptions(detected.value, weights.value);
  if (!ranked.ok) return ranked;

  // 5. The view model: ranked items, evidence chains, SUGGESTIONS ONLY.
  const items: ExceptionItemView[] = ranked.value.map(exceptionItemViewOf);
  return {
    ok: true,
    value: {
      kind: 'control-tower',
      scanId: scanId.value,
      detectedAt: parts.detectedAt,
      exceptionCount: items.length,
      items,
    },
  };
}

// ---------------------------------------------------------------------------
// The ranking seed (the portfolio's own currency, fail-closed).
// ---------------------------------------------------------------------------

/**
 * The ranking seed weights in the portfolio's OWN currency: the default
 * weights' severity/economic composition and scale amount, re-seeded in the
 * session-visible budget facts' single currency. Fail-closed: no visible
 * budget, or a mixed-currency portfolio, is a typed invariant violation —
 * the shell never invents an FX conversion (cross-currency prioritization is
 * the exceptions package's own typed rejection).
 */
const seedWeightsOf = (
  session: WebSession,
  budgets: readonly BudgetFact[],
): Result<PriorityWeights, DomainError> => {
  const visible = budgets.filter(
    (budget) =>
      budget.source.scope.tenantId === session.tenantId &&
      (budget.source.scope.kind !== 'project' ||
        budget.source.scope.projectId === session.projectId),
  );
  const currency = visible[0]?.currency;
  if (currency === undefined) {
    return {
      ok: false,
      error: domainError(
        'invariant-violation',
        'the control tower found no budget visible to this session — the ranking seed currency is unresolvable',
        [{ code: 'seed-currency-unresolvable', message: 'no visible budget facts', path: 'economicScale.currency' }],
        { scope: session.scope, correlationId: null },
      ),
    };
  }
  for (const budget of visible) {
    if (budget.currency !== currency) {
      return {
        ok: false,
        error: domainError(
          'invariant-violation',
          `the visible portfolio is mixed-currency (${currency} vs ${budget.currency}) — rank per currency or supply converted assessments`,
          [
            {
              code: 'seed-currency-mixed',
              message: `${budget.budgetId} is ${budget.currency}`,
              path: 'economicScale.currency',
            },
          ],
          { scope: session.scope, correlationId: null },
        ),
      };
    }
  }
  return {
    ok: true,
    value: {
      severityWeight: DEFAULT_PRIORITY_WEIGHTS.severityWeight,
      economicWeight: DEFAULT_PRIORITY_WEIGHTS.economicWeight,
      economicScale: {
        amountMinor: DEFAULT_PRIORITY_WEIGHTS.economicScale.amountMinor,
        currency,
      },
    },
  };
};

/** Project one ranked exception into its displayable view item (pure). */
const exceptionItemViewOf = (ranked: RankedException): ExceptionItemView => {
  const exception: Exception = ranked.exception;
  return {
    exceptionId: exception.exceptionId,
    rank: ranked.rank,
    kind: exception.kind,
    title: exception.title,
    severityLevel: exception.severity.level,
    severityReasons: [...exception.severity.reasons],
    priorityScore: {
      severity: rationalTextOf(ranked.score.severity.contribution),
      economic: rationalTextOf(ranked.score.economic.contribution),
      total: rationalTextOf(ranked.score.total),
    },
    economicImpact: {
      amountMinor: exception.economicImpact.amountMinor,
      currency: exception.economicImpact.currency,
    },
    affectedEntities: exception.affected.map((ref) => ({
      entityKind: ref.entityKind,
      entityId: ref.entityId,
    })),
    evidence: exception.evidence.map((entry) =>
      entry.kind === 'event'
        ? {
            kind: 'event' as const,
            referenceId: entry.eventId,
            eventName: entry.eventName as string,
            occurredAt: entry.occurredAt,
          }
        : entry.kind === 'assessment'
          ? {
              kind: 'assessment' as const,
              referenceId: entry.assessmentId,
              eventName: null,
              occurredAt: entry.assessedAt,
            }
          : {
              kind: 'benchmark' as const,
              referenceId: entry.benchmarkId,
              eventName: null,
              occurredAt: entry.computedAt,
            },
    ),
    suggestedActions: suggestNextActions(exception).map((action) => ({
      commandName: action.command.commandName,
      title: action.title,
      rationale: action.rationale,
      confidenceLevel: action.confidence.level,
      confidenceReasons: [...action.confidence.reasons],
      payload: { ...action.command.payload },
    })),
  };
};

/** Render one exact rational as deterministic text (e.g. '13/20'). */
const rationalTextOf = (value: { readonly numerator: number; readonly denominator: number }): string =>
  `${value.numerator}/${value.denominator}`;
