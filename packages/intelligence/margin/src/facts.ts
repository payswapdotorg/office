// Office intelligence — the deterministic commercial facts fold (OFF-014).
//
// projectCommercialFacts() folds a ledger event stream — the landed domain
// packages' events, read through the ledger READ surface — into the typed
// commercial facts the impact calculations consume. It is the margin
// engine's PROJECTION (freeze A2/A7): derived, rebuildable, replaceable —
// never a second source of truth. It holds ids, refs, integer money and
// durations ONLY, never entity data, and every fact carries the producing
// event (ledger id + name + occurred-at + stream position + scope), which
// is what makes every assessment number traceable to its source events.
//
// DETERMINISTIC BY CONSTRUCTION: events are consumed in ledger order, every
// fold rule is a keyed update (per-entity latest-assertion-wins in stream
// order, append-only histories for ordered assertions), and every output
// collection is canonically sorted — no clock, no randomness, no
// environment. The same stream always folds to byte-identical facts;
// rebuilding from scratch is the same function.
//
// Event-name recognition: exactly RECOGNIZED_COMMERCIAL_EVENT_NAMES.
// Unknown event names are SKIPPED deterministically (fail-open for future
// packages, tallied in the derivation metadata — never a crash, never a
// silent data invention). A RECOGNIZED event name with a malformed payload
// is a typed invariant-violation instead: the ledger's payloads were
// domain-validated at append time, so corruption fails closed.
//
// The fold is scope-blind (it derives what the envelopes assert, exactly
// like the relationship projection); the authorization boundary is enforced
// at assessment time (calculation.ts) — never baked into a projection.
import { isEntityId, isEntityKind, isTimestamp } from '@office/contracts';
import type {
  EntityId,
  EntityKind,
  EventName,
  Scope,
  Timestamp,
} from '@office/contracts';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { isRecognizedCommercialEventName } from './vocabulary';
import { parseCurrencyCode } from './model';
import type { CurrencyCode } from './model';

// ---------------------------------------------------------------------------
// Fail-closed payload field readers (typed errors carry the event name and
// field path; payloads arrive as `unknown` exactly like the ledger rows —
// the same reader idiom the relationship projection uses).
// ---------------------------------------------------------------------------

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const payloadFailure = (
  eventName: EventName,
  field: string,
  expected: string,
  received: unknown,
): DomainError =>
  domainError(
    'invariant-violation',
    `commercial facts cannot consume the payload of '${eventName}': field '${field}' is not ${expected}`,
    [
      {
        code: 'commercial-payload-valid',
        message: `expected ${expected} at '${field}', received ${JSON.stringify(received)}`,
        path: `${eventName}.${field}`,
      },
    ],
  );

const entityIdField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<EntityId, DomainError> => {
  const raw = payload[field];
  if (!isEntityId(raw)) {
    return fail(payloadFailure(eventName, field, 'a canonical EntityId', raw));
  }
  return ok(raw);
};

const nullableEntityIdField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<EntityId | null, DomainError> => {
  const raw = payload[field];
  if (raw === null) return ok(null);
  if (!isEntityId(raw)) {
    return fail(payloadFailure(eventName, field, 'a canonical EntityId or null', raw));
  }
  return ok(raw);
};

const entityIdArrayField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<readonly EntityId[], DomainError> => {
  const raw = payload[field];
  if (!Array.isArray(raw)) {
    return fail(payloadFailure(eventName, field, 'an array of canonical EntityId values', raw));
  }
  const ids: EntityId[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isEntityId(entry)) {
      return fail(payloadFailure(eventName, `${field}[${index}]`, 'a canonical EntityId', entry));
    }
    ids.push(entry);
  }
  return ok(ids);
};

const stringField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<string, DomainError> => {
  const raw = payload[field];
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(payloadFailure(eventName, field, 'a non-empty string', raw));
  }
  return ok(raw);
};

const integerField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): Result<number, DomainError> => {
  const raw = payload[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    return fail(
      payloadFailure(eventName, field, `an integer ${min}..${max}`, raw),
    );
  }
  return ok(raw);
};

const timestampField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<Timestamp, DomainError> => {
  const raw = payload[field];
  if (!isTimestamp(raw)) {
    return fail(payloadFailure(eventName, field, 'a canonical Timestamp', raw));
  }
  return ok(raw);
};

/** The money value object of the contracts domain (mirrored locally). */
interface MoneyPayload {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

const moneyField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<MoneyPayload, DomainError> => {
  const raw = payload[field];
  if (!isRecord(raw)) {
    return fail(payloadFailure(eventName, field, 'a money object { amount, currency }', raw));
  }
  const amount = raw['amount'];
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return fail(
      payloadFailure(eventName, `${field}.amount`, 'a positive integer (minor units)', amount),
    );
  }
  const currency = parseCurrencyCode(raw['currency']);
  if (!currency.ok) {
    return fail(
      payloadFailure(eventName, `${field}.currency`, 'an uppercase 3-letter currency code', raw['currency']),
    );
  }
  return ok({ amount, currency: currency.value });
};

const nullableMoneyField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<MoneyPayload | null, DomainError> => {
  const raw = payload[field];
  if (raw === null) return ok(null);
  return moneyField(eventName, payload, field);
};

/** One evidence link of a change-event payload (ids only). */
interface EvidenceLinkPayload {
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
}

const evidenceLinksField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<readonly EvidenceLinkPayload[], DomainError> => {
  const raw = payload[field];
  if (!Array.isArray(raw)) {
    return fail(payloadFailure(eventName, field, 'an array of evidence links', raw));
  }
  const links: EvidenceLinkPayload[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(payloadFailure(eventName, `${field}[${index}]`, 'an evidence link object', entry));
    }
    const documentId = entityIdField(eventName, entry, 'documentId');
    if (!documentId.ok) return documentId;
    const revisionId = entityIdField(eventName, entry, 'revisionId');
    if (!revisionId.ok) return revisionId;
    links.push({ documentId: documentId.value, revisionId: revisionId.value });
  }
  return ok(links);
};

/** One cost impact link of a change-event payload (ids only). */
interface CostImpactLinkPayload {
  readonly budgetId: EntityId | null;
  readonly costItemId: EntityId | null;
}

const costImpactLinksField = (
  eventName: EventName,
  payload: Record<string, unknown>,
  field: string,
): Result<readonly CostImpactLinkPayload[], DomainError> => {
  const raw = payload[field];
  if (!Array.isArray(raw)) {
    return fail(payloadFailure(eventName, field, 'an array of cost impact links', raw));
  }
  const links: CostImpactLinkPayload[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(payloadFailure(eventName, `${field}[${index}]`, 'a cost impact link object', entry));
    }
    const budgetId = nullableEntityIdField(eventName, entry, 'budgetId');
    if (!budgetId.ok) return budgetId;
    const costItemId = nullableEntityIdField(eventName, entry, 'costItemId');
    if (!costItemId.ok) return costItemId;
    links.push({ budgetId: budgetId.value, costItemId: costItemId.value });
  }
  return ok(links);
};

// ---------------------------------------------------------------------------
// The fact model (all internal to this package; exposed through index.ts).
// ---------------------------------------------------------------------------

/**
 * The producing event of one fact — the traceability spine: ledger id,
 * name, occurred-at, dense stream position (used for the deterministic
 * before/after split of schedule deltas), the scope the event asserted,
 * and the causal chain the event belongs to (A3/A4).
 */
export interface FactSource {
  readonly eventId: LedgerEventId;
  readonly eventName: EventName;
  readonly occurredAt: Timestamp;
  readonly position: number;
  readonly scope: Scope;
  readonly correlationId: string;
}

/** One recorded contract of the contracts domain. */
export interface ContractFact {
  readonly contractId: EntityId;
  readonly title: string;
  readonly valueMinor: number;
  readonly currency: CurrencyCode;
  readonly source: FactSource;
}

/** One raised change event with its full recorded link set (ids only). */
export interface ChangeEventFact {
  readonly changeEventId: EntityId;
  readonly contractId: EntityId;
  readonly title: string;
  readonly changeType: string;
  readonly affectedObligationIds: readonly EntityId[];
  readonly evidenceLinks: readonly EvidenceLinkPayload[];
  readonly costImpactLinks: readonly CostImpactLinkPayload[];
  readonly scheduleImpactActivityIds: readonly EntityId[];
  readonly source: FactSource;
}

/** One change order derived from a change event, with its decision state. */
export interface ChangeOrderFact {
  readonly changeOrderId: EntityId;
  readonly changeEventId: EntityId;
  readonly title: string;
  readonly valueMinor: number | null;
  readonly currency: CurrencyCode | null;
  /** The latest recorded status (decided events supersede 'submitted'). */
  readonly status: 'submitted' | 'approved' | 'rejected' | 'executed';
  readonly submissionSource: FactSource;
  readonly decisionSource: FactSource | null;
}

/** One claim referenced against a change order. */
export interface ClaimReferenceFact {
  readonly claimReferenceId: EntityId;
  readonly claimEntityKind: EntityKind;
  readonly claimEntityId: EntityId;
  readonly changeOrderId: EntityId;
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
  readonly source: FactSource;
}

/** One recorded budget (the currency owner of its money layers). */
export interface BudgetFact {
  readonly budgetId: EntityId;
  readonly currency: CurrencyCode;
  readonly source: FactSource;
}

/** One recorded cost item (an append-only working-set assertion). */
export interface CostItemFact {
  readonly costItemId: EntityId;
  readonly budgetId: EntityId;
  readonly amountMinor: number;
  readonly source: FactSource;
}

/** One immutable budget revision (the basis-of-record anchor). */
export interface BudgetRevisionFact {
  readonly revisionId: EntityId;
  readonly budgetId: EntityId;
  readonly sequence: number;
  readonly supersedes: EntityId | null;
  readonly source: FactSource;
}

/** One commitment with its current (latest-asserted) committed amount. */
export interface CommitmentFact {
  readonly commitmentId: EntityId;
  readonly budgetId: EntityId;
  readonly committedAmountMinor: number;
  /** The event that asserted the current amount (created or latest amended). */
  readonly source: FactSource;
}

/** One planned-duration assertion of one activity (append-only history). */
export interface DurationAssertion {
  readonly plannedDuration: number;
  readonly source: FactSource;
}

/** The latest recorded progress of one activity (the remaining-work model). */
export interface ProgressFact {
  readonly activityId: EntityId;
  readonly percentComplete: number;
  readonly remainingDuration: number;
  readonly source: FactSource;
}

/** One activity with its ordered duration history + latest progress. */
export interface ActivityFact {
  readonly activityId: EntityId;
  readonly scheduleId: EntityId;
  readonly code: string;
  readonly durationAssertions: readonly DurationAssertion[];
  readonly latestProgress: ProgressFact | null;
  readonly source: FactSource;
}

/** One dependency link (removed facts carry removed = true). */
export interface DependencyFact {
  readonly dependencyId: EntityId;
  readonly scheduleId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: 'FS' | 'SS' | 'FF' | 'SF';
  readonly lagDays: number;
  readonly source: FactSource;
  readonly removed: boolean;
  readonly removedSource: FactSource | null;
}

/** One immutable schedule baseline (the forecast basis anchor). */
export interface BaselineFact {
  readonly baselineId: EntityId;
  readonly scheduleId: EntityId;
  readonly sequence: number;
  readonly source: FactSource;
}

/** One event-name tally of the derivation metadata. */
export interface CommercialEventNameTally {
  readonly eventName: EventName;
  readonly count: number;
}

/** How the facts were derived — the fold's own audit trail. */
export interface CommercialDerivation {
  readonly projectedEventCount: number;
  readonly contractCount: number;
  readonly changeEventCount: number;
  readonly changeOrderCount: number;
  readonly claimReferenceCount: number;
  readonly budgetCount: number;
  readonly costItemCount: number;
  readonly budgetRevisionCount: number;
  readonly commitmentCount: number;
  readonly activityCount: number;
  readonly dependencyCount: number;
  readonly baselineCount: number;
  readonly recognizedEventNames: readonly CommercialEventNameTally[];
  readonly skippedEventNames: readonly CommercialEventNameTally[];
}

/**
 * THE commercial facts: the deterministic, rebuildable projection of the
 * money/duration/link facts the impact calculations consume. Collections
 * are canonically sorted (by entity id; ordered histories preserve ledger
 * order); the lookup helpers mirror the relationship index's shape.
 */
export interface CommercialFacts {
  readonly derivation: CommercialDerivation;
  readonly contracts: readonly ContractFact[];
  readonly changeEvents: readonly ChangeEventFact[];
  readonly changeOrders: readonly ChangeOrderFact[];
  readonly claimReferences: readonly ClaimReferenceFact[];
  readonly budgets: readonly BudgetFact[];
  readonly costItems: readonly CostItemFact[];
  readonly budgetRevisions: readonly BudgetRevisionFact[];
  readonly commitments: readonly CommitmentFact[];
  readonly activities: readonly ActivityFact[];
  readonly dependencies: readonly DependencyFact[];
  readonly baselines: readonly BaselineFact[];
  /** The change event fact a ledger event id produced, or null. */
  changeEventByLedgerId(eventId: LedgerEventId): ChangeEventFact | null;
  /** The change order fact of one change order id, or null. */
  changeOrderOf(changeOrderId: EntityId): ChangeOrderFact | null;
  /** Every cost item recorded against one budget, canonical order. */
  costItemsOf(budgetId: EntityId): readonly CostItemFact[];
  /** Every budget revision of one budget, canonical (sequence) order. */
  budgetRevisionsOf(budgetId: EntityId): readonly BudgetRevisionFact[];
  /** Every commitment against one budget, canonical order. */
  commitmentsOf(budgetId: EntityId): readonly CommitmentFact[];
  /** Every claim referenced against one change order, canonical order. */
  claimReferencesOf(changeOrderId: EntityId): readonly ClaimReferenceFact[];
}

// ---------------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------------

const sourceOf = (event: LedgerEvent, position: number): FactSource => ({
  eventId: event.eventId,
  eventName: event.envelope.eventName,
  occurredAt: event.envelope.occurredAt,
  position,
  scope: event.envelope.scope,
  correlationId: event.envelope.causality.correlationId,
});

interface FoldState {
  readonly contracts: Map<string, ContractFact>;
  readonly changeEvents: Map<string, ChangeEventFact>;
  readonly changeEventsByLedgerId: Map<string, ChangeEventFact>;
  readonly changeOrders: Map<string, ChangeOrderFact>;
  readonly claimReferences: Map<string, ClaimReferenceFact>;
  readonly budgets: Map<string, BudgetFact>;
  readonly costItems: Map<string, CostItemFact>;
  readonly budgetRevisions: Map<string, BudgetRevisionFact>;
  readonly commitments: Map<string, CommitmentFact>;
  readonly activities: Map<string, ActivityFact>;
  readonly dependencies: Map<string, DependencyFact>;
  readonly baselines: Map<string, BaselineFact>;
  readonly recognized: Map<string, number>;
  readonly skipped: Map<string, number>;
  projectedEventCount: number;
}

const duplicateContractFailure = (contractId: EntityId): DomainError =>
  invariantViolation(
    {
      name: 'contract-created-once',
      statement: `contract ${contractId} was created more than once in the projected stream`,
    },
  );

const applyEvent = (state: FoldState, event: LedgerEvent, position: number): Result<true, DomainError> => {
  const name = event.envelope.eventName;
  const payload = event.envelope.payload;
  const asRecord = isRecord(payload) ? payload : {};
  const source = sourceOf(event, position);

  switch (name) {
    case 'contracts.contractCreated': {
      const contractId = entityIdField(name, asRecord, 'contractId');
      if (!contractId.ok) return contractId;
      if (state.contracts.has(contractId.value)) {
        return fail(duplicateContractFailure(contractId.value));
      }
      const title = stringField(name, asRecord, 'title');
      if (!title.ok) return title;
      const contractValue = moneyField(name, asRecord, 'contractValue');
      if (!contractValue.ok) return contractValue;
      state.contracts.set(contractId.value, {
        contractId: contractId.value,
        title: title.value,
        valueMinor: contractValue.value.amount,
        currency: contractValue.value.currency,
        source,
      });
      return ok(true);
    }
    case 'contracts.changeEventRaised': {
      const contractId = entityIdField(name, asRecord, 'contractId');
      if (!contractId.ok) return contractId;
      const changeEventId = entityIdField(name, asRecord, 'changeEventId');
      if (!changeEventId.ok) return changeEventId;
      const title = stringField(name, asRecord, 'title');
      if (!title.ok) return title;
      const changeType = stringField(name, asRecord, 'changeType');
      if (!changeType.ok) return changeType;
      const affectedObligationIds = entityIdArrayField(name, asRecord, 'affectedObligationIds');
      if (!affectedObligationIds.ok) return affectedObligationIds;
      const evidenceLinks = evidenceLinksField(name, asRecord, 'evidenceLinks');
      if (!evidenceLinks.ok) return evidenceLinks;
      const costImpactLinks = costImpactLinksField(name, asRecord, 'costImpactLinks');
      if (!costImpactLinks.ok) return costImpactLinks;
      const scheduleImpactActivityIds = entityIdArrayField(name, asRecord, 'scheduleImpactActivityIds');
      if (!scheduleImpactActivityIds.ok) return scheduleImpactActivityIds;
      const fact: ChangeEventFact = {
        changeEventId: changeEventId.value,
        contractId: contractId.value,
        title: title.value,
        changeType: changeType.value,
        affectedObligationIds: affectedObligationIds.value,
        evidenceLinks: evidenceLinks.value,
        costImpactLinks: costImpactLinks.value,
        scheduleImpactActivityIds: scheduleImpactActivityIds.value,
        source,
      };
      state.changeEvents.set(changeEventId.value, fact);
      state.changeEventsByLedgerId.set(event.eventId, fact);
      return ok(true);
    }
    case 'contracts.changeOrderSubmitted': {
      const contractId = entityIdField(name, asRecord, 'contractId');
      if (!contractId.ok) return contractId;
      const changeOrderId = entityIdField(name, asRecord, 'changeOrderId');
      if (!changeOrderId.ok) return changeOrderId;
      const changeEventId = entityIdField(name, asRecord, 'changeEventId');
      if (!changeEventId.ok) return changeEventId;
      const title = stringField(name, asRecord, 'title');
      if (!title.ok) return title;
      const changeValue = nullableMoneyField(name, asRecord, 'changeValue');
      if (!changeValue.ok) return changeValue;
      state.changeOrders.set(changeOrderId.value, {
        changeOrderId: changeOrderId.value,
        changeEventId: changeEventId.value,
        title: title.value,
        valueMinor: changeValue.value === null ? null : changeValue.value.amount,
        currency: changeValue.value === null ? null : changeValue.value.currency,
        status: 'submitted',
        submissionSource: source,
        decisionSource: null,
      });
      return ok(true);
    }
    case 'contracts.changeOrderApproved':
    case 'contracts.changeOrderRejected':
    case 'contracts.changeOrderExecuted': {
      const changeOrderId = entityIdField(name, asRecord, 'changeOrderId');
      if (!changeOrderId.ok) return changeOrderId;
      const existing = state.changeOrders.get(changeOrderId.value);
      if (existing === undefined) {
        return fail(
          invariantViolation(
            {
              name: 'change-order-submitted-before-decision',
              statement: `a change-order decision event arrived before the submission of change order ${changeOrderId.value}`,
            },
          ),
        );
      }
      // Approved/rejected payloads carry decidedAt; the executed payload
      // carries executedAt — same field role, the owning domain's spelling.
      const decidedAt = timestampField(
        name,
        asRecord,
        name === 'contracts.changeOrderExecuted' ? 'executedAt' : 'decidedAt',
      );
      if (!decidedAt.ok) return decidedAt;
      if (decidedAt.value < existing.submissionSource.occurredAt) {
        return fail(
          invariantViolation(
            {
              name: 'change-order-decision-after-submission',
              statement: `the decision of change order ${changeOrderId.value} predates its submission`,
            },
          ),
        );
      }
      const status: ChangeOrderFact['status'] =
        name === 'contracts.changeOrderApproved'
          ? 'approved'
          : name === 'contracts.changeOrderRejected'
            ? 'rejected'
            : 'executed';
      state.changeOrders.set(changeOrderId.value, {
        ...existing,
        status,
        decisionSource: source,
      });
      return ok(true);
    }
    case 'contracts.claimReferenced': {
      const claimReferenceId = entityIdField(name, asRecord, 'claimReferenceId');
      if (!claimReferenceId.ok) return claimReferenceId;
      const claimEntityKind = asRecord['claimEntityKind'];
      if (!isEntityKind(claimEntityKind)) {
        return fail(payloadFailure(name, 'claimEntityKind', 'a canonical EntityKind', claimEntityKind));
      }
      const claimEntityId = entityIdField(name, asRecord, 'claimEntityId');
      if (!claimEntityId.ok) return claimEntityId;
      const changeOrderId = entityIdField(name, asRecord, 'changeOrderId');
      if (!changeOrderId.ok) return changeOrderId;
      const documentId = entityIdField(name, asRecord, 'documentId');
      if (!documentId.ok) return documentId;
      const revisionId = entityIdField(name, asRecord, 'revisionId');
      if (!revisionId.ok) return revisionId;
      state.claimReferences.set(claimReferenceId.value, {
        claimReferenceId: claimReferenceId.value,
        claimEntityKind,
        claimEntityId: claimEntityId.value,
        changeOrderId: changeOrderId.value,
        documentId: documentId.value,
        revisionId: revisionId.value,
        source,
      });
      return ok(true);
    }
    case 'cost.budgetCreated': {
      const budgetId = entityIdField(name, asRecord, 'budgetId');
      if (!budgetId.ok) return budgetId;
      const currency = parseCurrencyCode(asRecord['currency']);
      if (!currency.ok) {
        return fail(payloadFailure(name, 'currency', 'an uppercase 3-letter currency code', asRecord['currency']));
      }
      state.budgets.set(budgetId.value, {
        budgetId: budgetId.value,
        currency: currency.value,
        source,
      });
      return ok(true);
    }
    case 'cost.costItemRecorded': {
      const budgetId = entityIdField(name, asRecord, 'budgetId');
      if (!budgetId.ok) return budgetId;
      const costItemId = entityIdField(name, asRecord, 'costItemId');
      if (!costItemId.ok) return costItemId;
      const amountMinor = integerField(name, asRecord, 'amountMinor', 1, Number.MAX_SAFE_INTEGER);
      if (!amountMinor.ok) return amountMinor;
      state.costItems.set(`${budgetId.value}\u0000${costItemId.value}`, {
        costItemId: costItemId.value,
        budgetId: budgetId.value,
        amountMinor: amountMinor.value,
        source,
      });
      return ok(true);
    }
    case 'cost.budgetRevised': {
      const budgetId = entityIdField(name, asRecord, 'budgetId');
      if (!budgetId.ok) return budgetId;
      const revisionId = entityIdField(name, asRecord, 'revisionId');
      if (!revisionId.ok) return revisionId;
      const sequence = integerField(name, asRecord, 'sequence', 1, Number.MAX_SAFE_INTEGER);
      if (!sequence.ok) return sequence;
      const supersedes = nullableEntityIdField(name, asRecord, 'supersedes');
      if (!supersedes.ok) return supersedes;
      state.budgetRevisions.set(revisionId.value, {
        revisionId: revisionId.value,
        budgetId: budgetId.value,
        sequence: sequence.value,
        supersedes: supersedes.value,
        source,
      });
      return ok(true);
    }
    case 'cost.commitmentCreated':
    case 'cost.commitmentAmended': {
      const commitmentId = entityIdField(name, asRecord, 'commitmentId');
      if (!commitmentId.ok) return commitmentId;
      const committedAmountMinor = integerField(name, asRecord, 'committedAmountMinor', 1, Number.MAX_SAFE_INTEGER);
      if (!committedAmountMinor.ok) return committedAmountMinor;
      if (name === 'cost.commitmentCreated') {
        const budgetId = entityIdField(name, asRecord, 'budgetId');
        if (!budgetId.ok) return budgetId;
        state.commitments.set(commitmentId.value, {
          commitmentId: commitmentId.value,
          budgetId: budgetId.value,
          committedAmountMinor: committedAmountMinor.value,
          source,
        });
        return ok(true);
      }
      const existing = state.commitments.get(commitmentId.value);
      if (existing === undefined) {
        return fail(
          invariantViolation(
            {
              name: 'commitment-created-before-amendment',
              statement: `a commitment amendment arrived before the creation of commitment ${commitmentId.value}`,
            },
          ),
        );
      }
      // Latest assertion wins — the stream order is the ledger order, so
      // the current committed amount is deterministic.
      state.commitments.set(commitmentId.value, {
        ...existing,
        committedAmountMinor: committedAmountMinor.value,
        source,
      });
      return ok(true);
    }
    case 'schedule.activityAdded': {
      const scheduleId = entityIdField(name, asRecord, 'scheduleId');
      if (!scheduleId.ok) return scheduleId;
      const activityId = entityIdField(name, asRecord, 'activityId');
      if (!activityId.ok) return activityId;
      const code = stringField(name, asRecord, 'code');
      if (!code.ok) return code;
      const plannedDuration = integerField(name, asRecord, 'plannedDuration', 1, 3650);
      if (!plannedDuration.ok) return plannedDuration;
      state.activities.set(activityId.value, {
        activityId: activityId.value,
        scheduleId: scheduleId.value,
        code: code.value,
        durationAssertions: [{ plannedDuration: plannedDuration.value, source }],
        latestProgress: null,
        source,
      });
      return ok(true);
    }
    case 'schedule.activityUpdated': {
      const activityId = entityIdField(name, asRecord, 'activityId');
      if (!activityId.ok) return activityId;
      const code = stringField(name, asRecord, 'code');
      if (!code.ok) return code;
      const plannedDuration = integerField(name, asRecord, 'plannedDuration', 1, 3650);
      if (!plannedDuration.ok) return plannedDuration;
      const existing = state.activities.get(activityId.value);
      if (existing === undefined) {
        return fail(
          invariantViolation(
            {
              name: 'activity-added-before-update',
              statement: `an activity update arrived before the addition of activity ${activityId.value}`,
            },
          ),
        );
      }
      state.activities.set(activityId.value, {
        ...existing,
        code: code.value,
        durationAssertions: [
          ...existing.durationAssertions,
          { plannedDuration: plannedDuration.value, source },
        ],
      });
      return ok(true);
    }
    case 'schedule.dependencyAdded': {
      const scheduleId = entityIdField(name, asRecord, 'scheduleId');
      if (!scheduleId.ok) return scheduleId;
      const dependencyId = entityIdField(name, asRecord, 'dependencyId');
      if (!dependencyId.ok) return dependencyId;
      const predecessorId = entityIdField(name, asRecord, 'predecessorId');
      if (!predecessorId.ok) return predecessorId;
      const successorId = entityIdField(name, asRecord, 'successorId');
      if (!successorId.ok) return successorId;
      const linkTypeRaw = asRecord['linkType'];
      if (
        linkTypeRaw !== 'FS' &&
        linkTypeRaw !== 'SS' &&
        linkTypeRaw !== 'FF' &&
        linkTypeRaw !== 'SF'
      ) {
        return fail(payloadFailure(name, 'linkType', "'FS' | 'SS' | 'FF' | 'SF'", linkTypeRaw));
      }
      const lagDays = integerField(name, asRecord, 'lagDays', -3650, 3650);
      if (!lagDays.ok) return lagDays;
      state.dependencies.set(dependencyId.value, {
        dependencyId: dependencyId.value,
        scheduleId: scheduleId.value,
        predecessorId: predecessorId.value,
        successorId: successorId.value,
        linkType: linkTypeRaw,
        lagDays: lagDays.value,
        source,
        removed: false,
        removedSource: null,
      });
      return ok(true);
    }
    case 'schedule.dependencyRemoved': {
      const dependencyId = entityIdField(name, asRecord, 'dependencyId');
      if (!dependencyId.ok) return dependencyId;
      const existing = state.dependencies.get(dependencyId.value);
      if (existing === undefined) {
        return fail(
          invariantViolation(
            {
              name: 'dependency-added-before-removal',
              statement: `a dependency removal arrived before the addition of dependency ${dependencyId.value}`,
            },
          ),
        );
      }
      state.dependencies.set(dependencyId.value, {
        ...existing,
        removed: true,
        removedSource: source,
      });
      return ok(true);
    }
    case 'schedule.baselineSet': {
      const scheduleId = entityIdField(name, asRecord, 'scheduleId');
      if (!scheduleId.ok) return scheduleId;
      const baselineId = entityIdField(name, asRecord, 'baselineId');
      if (!baselineId.ok) return baselineId;
      const sequence = integerField(name, asRecord, 'sequence', 1, Number.MAX_SAFE_INTEGER);
      if (!sequence.ok) return sequence;
      state.baselines.set(baselineId.value, {
        baselineId: baselineId.value,
        scheduleId: scheduleId.value,
        sequence: sequence.value,
        source,
      });
      return ok(true);
    }
    case 'schedule.progressRecorded': {
      const activityId = entityIdField(name, asRecord, 'activityId');
      if (!activityId.ok) return activityId;
      const percentComplete = integerField(name, asRecord, 'percentComplete', 0, 100);
      if (!percentComplete.ok) return percentComplete;
      const remainingDuration = integerField(name, asRecord, 'remainingDuration', 0, 3650);
      if (!remainingDuration.ok) return remainingDuration;
      const existing = state.activities.get(activityId.value);
      if (existing === undefined) {
        return fail(
          invariantViolation(
            {
              name: 'activity-added-before-progress',
              statement: `a progress record arrived before the addition of activity ${activityId.value}`,
            },
          ),
        );
      }
      state.activities.set(activityId.value, {
        ...existing,
        latestProgress: {
          activityId: activityId.value,
          percentComplete: percentComplete.value,
          remainingDuration: remainingDuration.value,
          source,
        },
      });
      return ok(true);
    }
    default:
      // scheduleCreated carries no commercial fact beyond its aggregate
      // node — recognized and tallied, no fact extracted.
      return ok(true);
  }
};

const talliesOf = (counts: Map<string, number>): readonly CommercialEventNameTally[] =>
  [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([eventName, count]) => ({ eventName: eventName as EventName, count }));

/** Canonically sort entity facts by their canonical id (string order). */
const sortedById = <T>(entities: readonly T[], idOf: (entity: T) => string): readonly T[] =>
  [...entities].sort((left, right) => {
    const leftId = idOf(left);
    const rightId = idOf(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });

/**
 * Project a ledger event stream into the commercial facts — THE
 * deterministic, rebuildable fold (A2/A7). Consuming the same stream twice
 * yields identical facts; rebuilding from scratch is this same function.
 * Fails closed (typed invariant-violation) on a recognized event name with
 * a malformed payload; skips unknown event names deterministically.
 */
export function projectCommercialFacts(
  events: readonly LedgerEvent[],
): Result<CommercialFacts, DomainError> {
  const state: FoldState = {
    contracts: new Map(),
    changeEvents: new Map(),
    changeEventsByLedgerId: new Map(),
    changeOrders: new Map(),
    claimReferences: new Map(),
    budgets: new Map(),
    costItems: new Map(),
    budgetRevisions: new Map(),
    commitments: new Map(),
    activities: new Map(),
    dependencies: new Map(),
    baselines: new Map(),
    recognized: new Map(),
    skipped: new Map(),
    projectedEventCount: 0,
  };

  for (const [position, event] of events.entries()) {
    state.projectedEventCount += 1;
    const name = event.envelope.eventName as string;
    if (!isRecognizedCommercialEventName(event.envelope.eventName)) {
      state.skipped.set(name, (state.skipped.get(name) ?? 0) + 1);
      continue;
    }
    state.recognized.set(name, (state.recognized.get(name) ?? 0) + 1);
    const applied = applyEvent(state, event, position);
    if (!applied.ok) return applied;
  }

  const contracts = sortedById([...state.contracts.values()], (fact) => fact.contractId);
  const changeEvents = sortedById([...state.changeEvents.values()], (fact) => fact.changeEventId);
  const changeOrders = sortedById([...state.changeOrders.values()], (fact) => fact.changeOrderId);
  const claimReferences = sortedById(
    [...state.claimReferences.values()],
    (fact) => fact.claimReferenceId,
  );
  const budgets = sortedById([...state.budgets.values()], (fact) => fact.budgetId);
  const costItems = [...state.costItems.values()].sort((left, right) => {
    if (left.budgetId !== right.budgetId) {
      return left.budgetId < right.budgetId ? -1 : 1;
    }
    if (left.costItemId !== right.costItemId) {
      return left.costItemId < right.costItemId ? -1 : 1;
    }
    return 0;
  });
  const budgetRevisions = [...state.budgetRevisions.values()].sort((left, right) => {
    if (left.budgetId !== right.budgetId) {
      return left.budgetId < right.budgetId ? -1 : 1;
    }
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return 0;
  });
  const commitments = sortedById([...state.commitments.values()], (fact) => fact.commitmentId);
  const activities = sortedById([...state.activities.values()], (fact) => fact.activityId);
  const dependencies = sortedById([...state.dependencies.values()], (fact) => fact.dependencyId);
  const baselines = [...state.baselines.values()].sort((left, right) => {
    if (left.scheduleId !== right.scheduleId) {
      return left.scheduleId < right.scheduleId ? -1 : 1;
    }
    return left.sequence - right.sequence;
  });

  const facts: CommercialFacts = {
    derivation: {
      projectedEventCount: state.projectedEventCount,
      contractCount: contracts.length,
      changeEventCount: changeEvents.length,
      changeOrderCount: changeOrders.length,
      claimReferenceCount: claimReferences.length,
      budgetCount: budgets.length,
      costItemCount: costItems.length,
      budgetRevisionCount: budgetRevisions.length,
      commitmentCount: commitments.length,
      activityCount: activities.length,
      dependencyCount: dependencies.length,
      baselineCount: baselines.length,
      recognizedEventNames: talliesOf(state.recognized),
      skippedEventNames: talliesOf(state.skipped),
    },
    contracts,
    changeEvents,
    changeOrders,
    claimReferences,
    budgets,
    costItems,
    budgetRevisions,
    commitments,
    activities,
    dependencies,
    baselines,
    changeEventByLedgerId: (eventId) => state.changeEventsByLedgerId.get(eventId) ?? null,
    changeOrderOf: (changeOrderId) => state.changeOrders.get(changeOrderId) ?? null,
    costItemsOf: (budgetId) =>
      costItems.filter((item) => item.budgetId === budgetId),
    budgetRevisionsOf: (budgetId) =>
      budgetRevisions.filter((revision) => revision.budgetId === budgetId),
    commitmentsOf: (budgetId) =>
      commitments.filter((commitment) => commitment.budgetId === budgetId),
    claimReferencesOf: (changeOrderId) =>
      claimReferences.filter((claim) => claim.changeOrderId === changeOrderId),
  };
  return ok(facts);
}
