// Office contracts/change domain — aggregate states, invariants, transitions (OFF-012).
//
// THE canonical contracts & change model of the Construction Project Graph
// (freeze A1): the commercial spine that binds change to scope, evidence,
// cost and schedule through TYPED CROSS-ENTITY LINKS — ids and refs ONLY,
// never copies of the referenced entities' data (the acceptance heart).
//
//  * ContractState — the PROJECT-scoped Contract aggregate root (the second
//    authorization boundary, freeze A12): contract metadata (title, parties
//    as typed person/company EntityId links, contract value as a canonical
//    minor-unit Money value, a forward-only execution status vocabulary) and
//    an explicit one-way lifecycle (active → archived, mirroring the identity
//    modules' archive: never a delete). The root owns its scope
//    decomposition — the immutable ScopeObligation rows inside it — so the
//    whole commercial baseline is ONE consistency unit guarded by optimistic
//    concurrency (recording an obligation bumps the root's version exactly
//    once, like attaching a revision bumps the documents head).
//
//  * ScopeObligationState — an IMMUTABLE row of record inside the contract
//    root: create-only, never updated, never deleted. Contracted scope never
//    edits itself — scope CHANGE flows exclusively through change events and
//    change orders (below), which is exactly why every change is auditable.
//    Its aggregate version is pinned to the initial version by an invariant:
//    the immutability is structural, not conventional. It is REFERENCED by
//    change events by canonical id — never copied.
//
//  * ChangeEventState — its OWN aggregate (proposed → superseded): a
//    proposed change to contracted scope. It carries typed LINKS to:
//    affected scope obligations (ids validated against the owning contract
//    of THIS package), entitlement evidence (document id + document revision
//    id — typed link, no documents-package import), cost impact
//    (budget/cost-item EntityIds — typed link, no cost-package import), and
//    schedule impact (activity EntityIds — typed link, no schedule-package
//    import). The links are ids and refs ONLY: no title, hash, storage key,
//    amount or date of any referenced entity is ever duplicated here, and
//    links are immutable once recorded — existing link entries are never
//    repointed or edited (the two always-failing guards below encode that
//    absence as typed invariant-violations); new links may only be APPENDED
//    while the change event is still proposed.
//
//  * ChangeOrderState — its OWN aggregate: the executed/approved change
//    lifecycle (submitted → approved/rejected → executed), explicit,
//    auditable, and strictly one-way. Executing an approved change order
//    SUPERSEDES its originating change event's proposed state (the
//    supersession is recorded ON the change event, pointing forward to the
//    executing order); a rejected order never mutates contracted scope.
//
//  * ClaimReferenceState — an IMMUTABLE pin binding one claim entity (a
//    typed EntityKind + EntityId link to an entity owned elsewhere) to ONE
//    SPECIFIC document revision AND one executed change order, inside the
//    owning contract's scope. Create-only, never repointed — duplicate
//    natural keys are typed conflicts, exactly like evidence references.
//
// State invariants are declarative (kernel Invariant<S>) and checked on every
// state a constructor/transition produces; lifecycle preconditions are
// checked by the pure transition functions below — both layers return typed
// invariant-violation DomainErrors, never bare throws. This module is PURE
// DOMAIN: no SQL, no repository, no wall clock, no randomness — `now` and
// canonical ids are injected by the caller.
import { isEntityId, isEntityKind } from '@office/contracts';
import type { EntityId, EntityKind, Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import type { Aggregate, AggregateVersion, DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { fail, invariantViolation } from '@office/domain-kernel';
import type { CostImpactLink, EvidenceLink, Money, PartyLink, QuantityValue } from './parse';
import { kindLiteral } from './parse';

// ----- entity kinds -------------------------------------------------------------

/** Canonical entity kind of the Contract aggregate root. */
export const CONTRACT_KIND: EntityKind = kindLiteral('contract');
/** Canonical entity kind of an immutable scope obligation inside the root. */
export const SCOPE_OBLIGATION_KIND: EntityKind = kindLiteral('scope-obligation');
/** Canonical entity kind of the ChangeEvent aggregate. */
export const CHANGE_EVENT_KIND: EntityKind = kindLiteral('change-event');
/** Canonical entity kind of the ChangeOrder aggregate. */
export const CHANGE_ORDER_KIND: EntityKind = kindLiteral('change-order');
/** Canonical entity kind of an immutable claim reference. */
export const CLAIM_REFERENCE_KIND: EntityKind = kindLiteral('claim-reference');

// ----- vocabulary ---------------------------------------------------------------

/**
 * The forward-only contract execution status vocabulary: 'draft' (not yet
 * signed by the parties) → 'executed' (signed and in force) → 'closed'
 * (completed or terminated). Execution status only ever moves FORWARD —
 * rewinding a commercial state is a typed invariant-violation.
 */
export type ContractExecutionStatus = 'draft' | 'executed' | 'closed';

/** All contract execution statuses, in canonical (forward) order. */
export const CONTRACT_EXECUTION_STATUSES: readonly ContractExecutionStatus[] = [
  'draft',
  'executed',
  'closed',
];

/** The contract lifecycle status. `archived` is terminal (one-way). */
export type ContractLifecycleStatus = 'active' | 'archived';

/** All contract lifecycle statuses, in canonical order. */
export const CONTRACT_LIFECYCLE_STATUSES: readonly ContractLifecycleStatus[] = [
  'active',
  'archived',
];

/**
 * The closed change-type vocabulary: what a change event does to contracted
 * scope — 'addition' (new obligations), 'modification' (changed
 * quantities/scope), 'deletion' (removed scope).
 */
export type ChangeType = 'addition' | 'modification' | 'deletion';

/** All change types, in canonical order. */
export const CHANGE_TYPES: readonly ChangeType[] = ['addition', 'modification', 'deletion'];

/** The change-event status: 'proposed' until a change order supersedes it. */
export type ChangeEventStatus = 'proposed' | 'superseded';

/** All change-event statuses, in canonical order. */
export const CHANGE_EVENT_STATUSES: readonly ChangeEventStatus[] = ['proposed', 'superseded'];

/**
 * The change-order status: 'submitted' → 'approved' | 'rejected' (one-way),
 * 'approved' → 'executed' (one-way). 'rejected' and 'executed' are terminal.
 */
export type ChangeOrderStatus = 'submitted' | 'approved' | 'rejected' | 'executed';

/** All change-order statuses, in canonical order. */
export const CHANGE_ORDER_STATUSES: readonly ChangeOrderStatus[] = [
  'submitted',
  'approved',
  'rejected',
  'executed',
];

const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2_000;
const REASON_MAX_LENGTH = 500;
const CODE_MAX_LENGTH = 64;
const UNIT_MAX_LENGTH = 32;

// ----- the Contract aggregate root ------------------------------------------------

/**
 * THE Contract aggregate state: the commercial baseline of one project-side
 * contract. `scope` is always the contract's own project scope
 * ({ kind: 'project', tenantId, projectId }). The root embeds its immutable
 * scope decomposition: every mutation of the root (update/archive) or of its
 * obligations (record) bumps the ROOT's version — optimistic concurrency
 * guards the commercial baseline as a whole.
 */
export interface ContractState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** Contract display title (1..200 characters). */
  readonly title: string;
  /** The commissioning party: a typed person/company EntityId link (never copied). */
  readonly owner: PartyLink;
  /** The engaged party: a typed person/company EntityId link (never copied). */
  readonly contractor: PartyLink;
  /** The contracted value: canonical minor-unit money (amount >= 0). */
  readonly contractValue: Money;
  /** Forward-only execution status: draft → executed → closed. */
  readonly executionStatus: ContractExecutionStatus;
  /** Lifecycle status; `archived` is terminal (one-way, never a delete). */
  readonly lifecycleStatus: ContractLifecycleStatus;
  /** When the contract was archived; null while active. */
  readonly archivedAt: Timestamp | null;
  /** Immutable scope obligations keyed by canonical entity id. */
  readonly obligations: Readonly<Record<string, ScopeObligationState>>;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Scope-obligation reference integrity + vocabulary, shared by the invariants. */
const obligationErrors = (
  obligations: Readonly<Record<string, ScopeObligationState>>,
): { readonly name: string; readonly statement: string }[] => {
  const violations: { readonly name: string; readonly statement: string }[] = [];
  const codes = new Set<string>();
  for (const obligation of Object.values(obligations)) {
    if (codes.has(obligation.code)) {
      violations.push({
        name: 'contract-obligation-codes-unique',
        statement: `obligation code '${obligation.code}' is used more than once`,
      });
    }
    codes.add(obligation.code);
    if (obligation.version !== INITIAL_AGGREGATE_VERSION) {
      violations.push({
        name: 'contract-obligations-are-immutable',
        statement: `obligation ${obligation.entityId} carries version ${String(obligation.version)}: an obligation is a create-only row of record pinned to the initial version`,
      });
    }
  }
  return violations;
};

/**
 * Declarative invariants over any ContractState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const CONTRACT_INVARIANTS = [
  defineInvariant<ContractState>(
    'contract-title-nonempty',
    'a contract title is 1..200 characters',
    (state) => state.title.length >= 1 && state.title.length <= TITLE_MAX_LENGTH,
  ),
  defineInvariant<ContractState>(
    'contract-is-project-scoped',
    'a contract is owned by exactly one project (project scope; the second authorization boundary)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<ContractState>(
    'contract-version-is-monotonic',
    'a contract version is a positive integer (starts at 1, +1 per mutation of the root or its obligations)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
  defineInvariant<ContractState>(
    'contract-parties-are-canonical-typed-links',
    'both contract parties are typed person/company links carrying canonical EntityIds',
    (state) =>
      isEntityKind(state.owner.entityKind) &&
      isEntityId(state.owner.entityId) &&
      isEntityKind(state.contractor.entityKind) &&
      isEntityId(state.contractor.entityId),
  ),
  defineInvariant<ContractState>(
    'contract-value-is-canonical-money',
    'the contract value is a canonical minor-unit money value with a non-negative amount',
    (state) =>
      Number.isInteger(state.contractValue.amount) &&
      state.contractValue.amount >= 0 &&
      state.contractValue.currency.length === 3,
  ),
  defineInvariant<ContractState>(
    'contract-execution-status-vocabulary',
    "the execution status is 'draft', 'executed' or 'closed'",
    (state) =>
      (CONTRACT_EXECUTION_STATUSES as readonly string[]).includes(state.executionStatus),
  ),
  defineInvariant<ContractState>(
    'contract-lifecycle-status-vocabulary',
    "the lifecycle status is 'active' or 'archived'",
    (state) =>
      (CONTRACT_LIFECYCLE_STATUSES as readonly string[]).includes(state.lifecycleStatus),
  ),
  defineInvariant<ContractState>(
    'contract-archive-timestamp-pairs-with-lifecycle',
    "archivedAt is null exactly while lifecycleStatus is 'active' (archive is explicit and timestamped)",
    (state) =>
      (state.lifecycleStatus === 'active' && state.archivedAt === null) ||
      (state.lifecycleStatus === 'archived' && state.archivedAt !== null),
  ),
  defineInvariant<ContractState>(
    'contract-obligations-are-immutable-unique-rows',
    'every scope obligation is a create-only row of record (version pinned to the initial version) with a unique code, bounded quantity and unit, and its own canonical id',
    (state) => {
      const violations = obligationErrors(state.obligations);
      if (violations.length > 0) return false;
      return Object.values(state.obligations).every(
        (obligation) =>
          isEntityId(obligation.entityId) &&
          obligation.code.length >= 1 &&
          obligation.code.length <= CODE_MAX_LENGTH &&
          obligation.description.length >= 1 &&
          obligation.description.length <= DESCRIPTION_MAX_LENGTH &&
          obligation.quantity.length >= 1 &&
          obligation.quantity.length <= 16 &&
          obligation.unit.length >= 1 &&
          obligation.unit.length <= UNIT_MAX_LENGTH,
      );
    },
  ),
] as const;

// ----- the immutable scope obligation row ------------------------------------------

/**
 * One contracted scope obligation: an immutable row of record inside the
 * contract root (create-only, never updated, never deleted — contracted
 * scope never edits itself; change flows through change events/orders).
 * `scope` and `version` mirror the owning contract's; the version is pinned
 * to the initial version by the root's invariant. Change events reference
 * obligations by canonical id — the row is never copied into them.
 */
export interface ScopeObligationState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The contract this obligation belongs to. */
  readonly contractId: EntityId;
  /** Unique obligation code within the contract (1..64 characters). */
  readonly code: string;
  /** What is owed (1..2000 characters). */
  readonly description: string;
  /** The contracted quantity: canonical decimal string (never a float). */
  readonly quantity: QuantityValue;
  /** The unit of measure (1..32 characters), e.g. 'm3', 'tonne', 'each'. */
  readonly unit: string;
  readonly createdAt: Timestamp;
}

// ----- the ChangeEvent aggregate ---------------------------------------------------

/**
 * THE ChangeEvent aggregate state: a proposed change to contracted scope.
 * Its OWN aggregate (own id, version, and optimistic-concurrency token).
 * The four link families below are TYPED LINKS — canonical ids and refs
 * ONLY. No data of any referenced entity (obligation descriptions, document
 * titles or hashes, cost amounts, schedule dates) is ever duplicated here,
 * and each family is immutable once recorded: existing entries are never
 * repointed or edited; new entries can only be APPENDED while the event is
 * still 'proposed' (see linkChangeReferencesState and the two always-failing
 * guards below).
 */
export interface ChangeEventState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The contract whose scope this change addresses. */
  readonly contractId: EntityId;
  /** What is changing, in one line (1..200 characters). */
  readonly title: string;
  /** The closed change-type vocabulary: addition | modification | deletion. */
  readonly changeType: ChangeType;
  /** 'proposed' until an executed change order supersedes it; one-way. */
  readonly status: ChangeEventStatus;
  /** When the proposed state was superseded; null while proposed. */
  readonly supersededAt: Timestamp | null;
  /** The change order whose execution superseded the proposed state; null while proposed. */
  readonly supersededByChangeOrderId: EntityId | null;
  /** Affected scope obligations: canonical ids of THIS contract's obligations (validated, never copied). */
  readonly affectedObligationIds: readonly EntityId[];
  /** Entitlement evidence: typed links to specific document revisions (ids only, never copied). */
  readonly evidenceLinks: readonly EvidenceLink[];
  /** Cost impact: typed budget/cost-item EntityId links (ids only, never copied). */
  readonly costImpactLinks: readonly CostImpactLink[];
  /** Schedule impact: typed activity EntityId links (ids only, never copied). */
  readonly scheduleImpactActivityIds: readonly EntityId[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Cross-entity link reference integrity of one change event (no duplicates). */
const changeEventLinkErrors = (
  state: ChangeEventState,
): { readonly name: string; readonly statement: string }[] => {
  const violations: { readonly name: string; readonly statement: string }[] = [];
  const obligationIds = new Set<string>();
  for (const obligationId of state.affectedObligationIds) {
    if (obligationIds.has(obligationId)) {
      violations.push({
        name: 'change-event-obligation-links-unique',
        statement: `obligation link ${obligationId} appears more than once`,
      });
    }
    obligationIds.add(obligationId);
  }
  const evidenceKeys = new Set<string>();
  for (const link of state.evidenceLinks) {
    const key = `${link.documentId}|${link.revisionId}`;
    if (evidenceKeys.has(key)) {
      violations.push({
        name: 'change-event-evidence-links-unique',
        statement: `evidence link to revision ${link.revisionId} of document ${link.documentId} appears more than once`,
      });
    }
    evidenceKeys.add(key);
  }
  const costKeys = new Set<string>();
  for (const link of state.costImpactLinks) {
    const key = `${link.budgetId ?? '-'}|${link.costItemId ?? '-'}`;
    if (costKeys.has(key)) {
      violations.push({
        name: 'change-event-cost-links-unique',
        statement: `cost impact link { budget: ${String(link.budgetId)}, cost item: ${String(link.costItemId)} } appears more than once`,
      });
    }
    costKeys.add(key);
  }
  const activityIds = new Set<string>();
  for (const activityId of state.scheduleImpactActivityIds) {
    if (activityIds.has(activityId)) {
      violations.push({
        name: 'change-event-activity-links-unique',
        statement: `schedule impact link ${activityId} appears more than once`,
      });
    }
    activityIds.add(activityId);
  }
  return violations;
};

/**
 * Declarative invariants over any ChangeEventState, in declaration order.
 * The link invariants ARE the acceptance boundary: every link family
 * consists of canonical ids only, contains no duplicates, and — with the
 * always-failing guards below — is structurally immutable.
 */
export const CHANGE_EVENT_INVARIANTS = [
  defineInvariant<ChangeEventState>(
    'change-event-title-nonempty',
    'a change event title is 1..200 characters',
    (state) => state.title.length >= 1 && state.title.length <= TITLE_MAX_LENGTH,
  ),
  defineInvariant<ChangeEventState>(
    'change-event-is-project-scoped',
    'a change event is owned by exactly one project (project scope; the second authorization boundary)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<ChangeEventState>(
    'change-event-version-is-monotonic',
    'a change event version is a positive integer (starts at 1, +1 per appended links/supersession)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
  defineInvariant<ChangeEventState>(
    'change-event-binds-a-canonical-contract',
    'a change event names the canonical contract whose scope it addresses',
    (state) => isEntityId(state.contractId),
  ),
  defineInvariant<ChangeEventState>(
    'change-event-change-type-vocabulary',
    "the change type is 'addition', 'modification' or 'deletion'",
    (state) => (CHANGE_TYPES as readonly string[]).includes(state.changeType),
  ),
  defineInvariant<ChangeEventState>(
    'change-event-status-vocabulary',
    "the change event status is 'proposed' or 'superseded'",
    (state) => (CHANGE_EVENT_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<ChangeEventState>(
    'change-event-supersession-pairs-with-status',
    "supersededAt and supersededByChangeOrderId are null exactly while status is 'proposed' (supersession is explicit and one-way)",
    (state) =>
      (state.status === 'proposed' &&
        state.supersededAt === null &&
        state.supersededByChangeOrderId === null) ||
      (state.status === 'superseded' &&
        state.supersededAt !== null &&
        state.supersededByChangeOrderId !== null),
  ),
  defineInvariant<ChangeEventState>(
    'change-event-obligation-links-are-canonical-and-unique',
    'affected scope obligations are canonical EntityIds, unique, and never the empty string',
    (state) =>
      state.affectedObligationIds.every((id) => isEntityId(id)) &&
      changeEventLinkErrors(state).length === 0,
  ),
  defineInvariant<ChangeEventState>(
    'change-event-evidence-links-are-canonical-and-unique',
    'every evidence link binds canonical document and revision EntityIds, uniquely',
    (state) =>
      state.evidenceLinks.every(
        (link) => isEntityId(link.documentId) && isEntityId(link.revisionId),
      ) && changeEventLinkErrors(state).length === 0,
  ),
  defineInvariant<ChangeEventState>(
    'change-event-cost-links-are-canonical-and-unique',
    'every cost impact link binds at least one canonical budget/cost-item EntityId, uniquely',
    (state) =>
      state.costImpactLinks.every(
        (link) => (link.budgetId === null || isEntityId(link.budgetId)) && (link.costItemId === null || isEntityId(link.costItemId)) && (link.budgetId !== null || link.costItemId !== null),
      ) && changeEventLinkErrors(state).length === 0,
  ),
  defineInvariant<ChangeEventState>(
    'change-event-activity-links-are-canonical-and-unique',
    'schedule impact activities are canonical EntityIds, unique',
    (state) =>
      state.scheduleImpactActivityIds.every((id) => isEntityId(id)) &&
      changeEventLinkErrors(state).length === 0,
  ),
] as const;

// ----- the ChangeOrder aggregate ---------------------------------------------------

/**
 * THE ChangeOrder aggregate state: the executed/approved change lifecycle.
 * Its OWN aggregate (own id, version, and optimistic-concurrency token).
 * The lifecycle is explicit, auditable, and strictly one-way:
 * submitted → approved → executed, or submitted → rejected; 'rejected' and
 * 'executed' are terminal. Executing an approved order SUPERSEDES the
 * originating change event's proposed state (see the supersession
 * transition on the change event); a rejected order never mutates scope.
 */
export interface ChangeOrderState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The contract this change order belongs to. */
  readonly contractId: EntityId;
  /** The originating change event whose proposed state this order supersedes on execution. */
  readonly changeEventId: EntityId;
  /** What is being ordered, in one line (1..200 characters). */
  readonly title: string;
  /**
   * The ordered commercial impact: canonical minor-unit money (signed — a
   * decrease is negative), or null when the order carries no value change.
   */
  readonly changeValue: Money | null;
  /** submitted → approved/rejected → executed; rejected and executed are terminal. */
  readonly status: ChangeOrderStatus;
  /** When the order was decided (approved or rejected); null while submitted. */
  readonly decidedAt: Timestamp | null;
  /** The recorded decision reason (approval/rejection), or null. */
  readonly decisionReason: string | null;
  /** When an approved order was executed; null until execution. */
  readonly executedAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * Declarative invariants over any ChangeOrderState, in declaration order:
 * the one-way lifecycle machine (submitted → approved/rejected → executed)
 * is encoded structurally — the status/timestamp pairing can only hold for
 * a legal history, so an illegal jump can never produce a valid state.
 */
export const CHANGE_ORDER_INVARIANTS = [
  defineInvariant<ChangeOrderState>(
    'change-order-title-nonempty',
    'a change order title is 1..200 characters',
    (state) => state.title.length >= 1 && state.title.length <= TITLE_MAX_LENGTH,
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-is-project-scoped',
    'a change order is owned by exactly one project (project scope; the second authorization boundary)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-version-is-monotonic',
    'a change order version is a positive integer (starts at 1, +1 per lifecycle transition)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-binds-canonical-contract-and-change-event',
    'a change order names the canonical contract it belongs to and the canonical change event it originates from',
    (state) => isEntityId(state.contractId) && isEntityId(state.changeEventId),
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-value-is-canonical-money',
    'the ordered value impact is null or a canonical minor-unit money value',
    (state) =>
      state.changeValue === null ||
      (Number.isInteger(state.changeValue.amount) && state.changeValue.currency.length === 3),
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-status-vocabulary',
    "the change order status is 'submitted', 'approved', 'rejected' or 'executed'",
    (state) => (CHANGE_ORDER_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-decision-timestamp-pairs-with-status',
    "decidedAt is null exactly while status is 'submitted' (approval/rejection is explicit and timestamped); decisionReason is null while submitted",
    (state) =>
      (state.status === 'submitted' && state.decidedAt === null && state.decisionReason === null) ||
      ((state.status === 'approved' || state.status === 'rejected') &&
        state.decidedAt !== null) ||
      (state.status === 'executed' && state.decidedAt !== null),
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-execution-timestamp-pairs-with-status',
    "executedAt is null exactly while status is not 'executed' (execution is explicit and timestamped)",
    (state) =>
      (state.status === 'executed' && state.executedAt !== null) ||
      (state.status !== 'executed' && state.executedAt === null),
  ),
  defineInvariant<ChangeOrderState>(
    'change-order-decision-reason-bounded',
    'a decision reason is at most 500 characters',
    (state) => state.decisionReason === null || state.decisionReason.length <= REASON_MAX_LENGTH,
  ),
] as const;

// ----- the immutable claim reference row -------------------------------------------

/**
 * An immutable claim reference: one claim entity (a typed EntityKind +
 * EntityId link to an entity owned elsewhere — claims are not modeled in
 * this package) pinned to ONE SPECIFIC document revision AND one EXECUTED
 * change order, inside the owning contract's scope. Create-only, never
 * repointed, never edited — there is no transition that touches an existing
 * reference; its version is pinned to the initial version by an invariant.
 * The natural key is (claim entity, change order, document, revision), so a
 * second attempt to pin the same quadruple is a typed conflict.
 */
export interface ClaimReferenceState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The contract owning the referenced change order (the commercial stream key). */
  readonly contractId: EntityId;
  /** The evidenced claim's canonical kind (the claim entity lives elsewhere). */
  readonly claimEntityKind: EntityKind;
  /** The evidenced claim's canonical id. */
  readonly claimEntityId: EntityId;
  /** The EXECUTED change order the claim is asserted against (this package, validated). */
  readonly changeOrderId: EntityId;
  /** The document whose revision is pinned (typed link, never copied). */
  readonly documentId: EntityId;
  /** The SPECIFIC pinned document revision (never just "the document"). */
  readonly revisionId: EntityId;
  readonly createdAt: Timestamp;
}

/**
 * Declarative invariants over any ClaimReferenceState, in declaration order:
 * a claim reference binds canonical ids, lives in the owning contract's
 * project scope, and is create-only (version pinned to the initial version).
 */
export const CLAIM_REFERENCE_INVARIANTS = [
  defineInvariant<ClaimReferenceState>(
    'claim-reference-binds-a-canonical-claim',
    'a claim reference names the evidenced claim by canonical kind and id',
    (state) => isEntityKind(state.claimEntityKind) && isEntityId(state.claimEntityId),
  ),
  defineInvariant<ClaimReferenceState>(
    'claim-reference-binds-canonical-change-order-and-evidence',
    'a claim reference names the canonical contract, change order AND document revision it pins',
    (state) =>
      isEntityId(state.contractId) &&
      isEntityId(state.changeOrderId) &&
      isEntityId(state.documentId) &&
      isEntityId(state.revisionId),
  ),
  defineInvariant<ClaimReferenceState>(
    'claim-reference-is-project-scoped',
    'a claim reference is owned by its contract project scope (project scope, never tenant scope)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<ClaimReferenceState>(
    'claim-reference-version-is-create-only-initial',
    'a claim reference is immutable: its aggregate version is pinned to the initial version (create-only, never repointed or edited)',
    (state) => state.version === INITIAL_AGGREGATE_VERSION,
  ),
] as const;

// ----- shared helpers --------------------------------------------------------------

const values = <T>(record: Readonly<Record<string, T>>): T[] => Object.values(record);

/** Is the execution-status move `from` → `to` forward (or a legal no-move)? */
const executionStatusMovesForward = (
  from: ContractExecutionStatus,
  to: ContractExecutionStatus,
): boolean =>
  CONTRACT_EXECUTION_STATUSES.indexOf(to) > CONTRACT_EXECUTION_STATUSES.indexOf(from);

// ----- contract constructors & transitions (pure) ----------------------------------

/** Parts of a newly created contract (the canonical id is issued inside the handler). */
export interface NewContract {
  readonly contractId: EntityId;
  readonly title: string;
  readonly owner: PartyLink;
  readonly contractor: PartyLink;
  readonly contractValue: Money;
  readonly executionStatus?: ContractExecutionStatus;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly created contract (trusted path — the
 * payload was validated fail-closed upstream). The scope MUST be project
 * scope; the invariant list enforces it. A new contract starts ACTIVE with
 * an empty scope decomposition.
 */
export function createContractState(
  input: NewContract,
  scope: Scope,
  context?: DomainErrorContext,
): Result<ContractState, DomainError> {
  const state: ContractState = {
    entityKind: CONTRACT_KIND,
    entityId: input.contractId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    title: input.title,
    owner: input.owner,
    contractor: input.contractor,
    contractValue: input.contractValue,
    executionStatus: input.executionStatus ?? 'draft',
    lifecycleStatus: 'active',
    archivedAt: null,
    obligations: {},
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(state, CONTRACT_INVARIANTS, context);
}

/** Changeable fields of a contract (at least one must be present). */
export interface ContractChanges {
  readonly title?: string;
  readonly owner?: PartyLink;
  readonly contractor?: PartyLink;
  readonly contractValue?: Money;
  readonly executionStatus?: ContractExecutionStatus;
}

/**
 * Pure transition: update the contract's metadata. The execution status only
 * ever moves FORWARD in the vocabulary (draft → executed → closed) — a
 * backward move or a rewind is a typed invariant-violation, as is updating
 * an archived contract (archive is terminal). The input state is untouched
 * on failure.
 */
export function updateContractState(
  current: ContractState,
  changes: ContractChanges,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ContractState, DomainError> {
  if (current.lifecycleStatus === 'archived') {
    return fail(
      invariantViolation(
        {
          name: 'contract-archive-is-terminal',
          statement: `contract ${current.entityId} is archived and can no longer be updated`,
        },
        context,
      ),
    );
  }
  if (
    changes.executionStatus !== undefined &&
    changes.executionStatus !== current.executionStatus &&
    !executionStatusMovesForward(current.executionStatus, changes.executionStatus)
  ) {
    return fail(
      invariantViolation(
        {
          name: 'contract-execution-status-moves-forward',
          statement: `contract execution status cannot move backward from '${current.executionStatus}' to '${changes.executionStatus}'`,
        },
        context,
      ),
    );
  }
  const next: ContractState = {
    ...current,
    title: changes.title ?? current.title,
    owner: changes.owner ?? current.owner,
    contractor: changes.contractor ?? current.contractor,
    contractValue: changes.contractValue ?? current.contractValue,
    executionStatus: changes.executionStatus ?? current.executionStatus,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, CONTRACT_INVARIANTS, context);
}

/**
 * Pure transition: archive the contract — the explicit ONE-WAY lifecycle
 * event (mirroring the identity modules' archive; never a delete). Archiving
 * an already-archived contract is a typed invariant-violation. The input
 * state is untouched on failure.
 */
export function archiveContractState(
  current: ContractState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ContractState, DomainError> {
  if (current.lifecycleStatus === 'archived') {
    return fail(
      invariantViolation(
        {
          name: 'contract-archive-is-terminal',
          statement: `contract ${current.entityId} is already archived (archive is one-way)`,
        },
        context,
      ),
    );
  }
  const next: ContractState = {
    ...current,
    lifecycleStatus: 'archived',
    archivedAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, CONTRACT_INVARIANTS, context);
}

/** Parts of a newly recorded scope obligation (the canonical id is issued inside the handler). */
export interface NewScopeObligation {
  readonly obligationId: EntityId;
  readonly code: string;
  readonly description: string;
  readonly quantity: QuantityValue;
  readonly unit: string;
  readonly now: Timestamp;
}

/**
 * Pure transition: record one scope obligation into the contract's scope
 * decomposition. Obligations are immutable rows of record: recording APPENDS
 * (bumping the root's version exactly once — the commercial baseline is one
 * consistency unit) and duplicate codes are typed invariant-violations.
 * Recording into an archived contract is rejected typed. The input state is
 * untouched on failure.
 */
export function recordObligationState(
  current: ContractState,
  input: NewScopeObligation,
  context?: DomainErrorContext,
): Result<ContractState, DomainError> {
  if (current.lifecycleStatus === 'archived') {
    return fail(
      invariantViolation(
        {
          name: 'contract-archive-is-terminal',
          statement: `contract ${current.entityId} is archived: its scope decomposition can no longer grow`,
        },
        context,
      ),
    );
  }
  for (const obligation of values(current.obligations)) {
    if (obligation.code === input.code) {
      return fail(
        invariantViolation(
          {
            name: 'contract-obligation-codes-unique',
            statement: `obligation code '${input.code}' is already used by obligation ${obligation.entityId} of contract ${current.entityId}`,
          },
          context,
        ),
      );
    }
  }
  const obligation: ScopeObligationState = {
    entityKind: SCOPE_OBLIGATION_KIND,
    entityId: input.obligationId,
    scope: current.scope,
    version: INITIAL_AGGREGATE_VERSION,
    contractId: current.entityId,
    code: input.code,
    description: input.description,
    quantity: input.quantity,
    unit: input.unit,
    createdAt: input.now,
  };
  const next: ContractState = {
    ...current,
    obligations: { ...current.obligations, [input.obligationId]: obligation },
    version: nextAggregateVersion(current.version),
    updatedAt: input.now,
  };
  return checkInvariants(next, CONTRACT_INVARIANTS, context);
}

// ----- change event constructors & transitions (pure) ------------------------------

/** The typed link set of a change event (every family ids/refs only). */
export interface ChangeEventLinks {
  readonly affectedObligationIds?: readonly EntityId[];
  readonly evidenceLinks?: readonly EvidenceLink[];
  readonly costImpactLinks?: readonly CostImpactLink[];
  readonly scheduleImpactActivityIds?: readonly EntityId[];
}

/** Parts of a newly raised change event (the canonical id is issued inside the handler). */
export interface NewChangeEvent {
  readonly changeEventId: EntityId;
  readonly title: string;
  readonly changeType: ChangeType;
  readonly links: ChangeEventLinks;
  readonly now: Timestamp;
}

/** Reject duplicate entries inside one link family (fail-closed, typed). */
const duplicateLinkFailure = (
  changeEventId: EntityId,
  family: string,
  entry: string,
  context?: DomainErrorContext,
): DomainError =>
  invariantViolation(
    {
      name: 'change-event-links-unique',
      statement: `change event ${changeEventId} already links ${family} ${entry}: links are immutable once recorded and never duplicated`,
    },
    context,
  );

/**
 * Pure constructor: build the initial state of a newly raised change event
 * (trusted path — the payload was validated fail-closed upstream; the
 * handler validates affected obligation ids against the owning contract).
 * The link families must not contain duplicates: a duplicate inside a fresh
 * link set is a wiring error, rejected typed. The new event is 'proposed'.
 */
export function createChangeEventState(
  input: NewChangeEvent,
  scope: Scope,
  contractId: EntityId,
  context?: DomainErrorContext,
): Result<ChangeEventState, DomainError> {
  const affectedObligationIds = [...(input.links.affectedObligationIds ?? [])];
  if (new Set(affectedObligationIds).size !== affectedObligationIds.length) {
    return fail(
      duplicateLinkFailure(input.changeEventId, 'scope obligation', '(duplicate entry)', context),
    );
  }
  const evidenceLinks = [...(input.links.evidenceLinks ?? [])];
  const evidenceKeys = new Set(evidenceLinks.map((link) => `${link.documentId}|${link.revisionId}`));
  if (evidenceKeys.size !== evidenceLinks.length) {
    return fail(
      duplicateLinkFailure(input.changeEventId, 'evidence', '(duplicate entry)', context),
    );
  }
  const costImpactLinks = [...(input.links.costImpactLinks ?? [])];
  const costKeys = new Set(
    costImpactLinks.map((link) => `${link.budgetId ?? '-'}|${link.costItemId ?? '-'}`),
  );
  if (costKeys.size !== costImpactLinks.length) {
    return fail(duplicateLinkFailure(input.changeEventId, 'cost impact', '(duplicate entry)', context));
  }
  const scheduleImpactActivityIds = [...(input.links.scheduleImpactActivityIds ?? [])];
  if (new Set(scheduleImpactActivityIds).size !== scheduleImpactActivityIds.length) {
    return fail(duplicateLinkFailure(input.changeEventId, 'schedule impact', '(duplicate entry)', context));
  }
  const state: ChangeEventState = {
    entityKind: CHANGE_EVENT_KIND,
    entityId: input.changeEventId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    contractId,
    title: input.title,
    changeType: input.changeType,
    status: 'proposed',
    supersededAt: null,
    supersededByChangeOrderId: null,
    affectedObligationIds,
    evidenceLinks,
    costImpactLinks,
    scheduleImpactActivityIds,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(state, CHANGE_EVENT_INVARIANTS, context);
}

/**
 * Pure transition: APPEND additional typed links to a change event. The only
 * mutation links ever undergo: new entries may join the link set while the
 * event is still 'proposed' — an existing entry is NEVER repointed, edited,
 * or removed. Appending a duplicate (any family) is a typed
 * invariant-violation, as is appending to a superseded event. The input
 * state is untouched on failure.
 */
export function linkChangeReferencesState(
  current: ChangeEventState,
  additions: ChangeEventLinks,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ChangeEventState, DomainError> {
  if (current.status === 'superseded') {
    return fail(
      invariantViolation(
        {
          name: 'change-event-superseded-links-frozen',
          statement: `change event ${current.entityId} is superseded: its link set is frozen`,
        },
        context,
      ),
    );
  }
  let next: ChangeEventState = current;
  for (const obligationId of additions.affectedObligationIds ?? []) {
    if (current.affectedObligationIds.includes(obligationId)) {
      return fail(
        duplicateLinkFailure(current.entityId, 'scope obligation', String(obligationId), context),
      );
    }
    next = { ...next, affectedObligationIds: [...next.affectedObligationIds, obligationId] };
  }
  for (const link of additions.evidenceLinks ?? []) {
    if (
      current.evidenceLinks.some(
        (existing) =>
          existing.documentId === link.documentId && existing.revisionId === link.revisionId,
      )
    ) {
      return fail(
        duplicateLinkFailure(
          current.entityId,
          'evidence',
          `revision ${String(link.revisionId)} of document ${String(link.documentId)}`,
          context,
        ),
      );
    }
    next = { ...next, evidenceLinks: [...next.evidenceLinks, link] };
  }
  for (const link of additions.costImpactLinks ?? []) {
    if (
      current.costImpactLinks.some(
        (existing) =>
          existing.budgetId === link.budgetId && existing.costItemId === link.costItemId,
      )
    ) {
      return fail(
        duplicateLinkFailure(
          current.entityId,
          'cost impact',
          `{ budget: ${String(link.budgetId)}, cost item: ${String(link.costItemId)} }`,
          context,
        ),
      );
    }
    next = { ...next, costImpactLinks: [...next.costImpactLinks, link] };
  }
  for (const activityId of additions.scheduleImpactActivityIds ?? []) {
    if (current.scheduleImpactActivityIds.includes(activityId)) {
      return fail(
        duplicateLinkFailure(current.entityId, 'schedule impact', String(activityId), context),
      );
    }
    next = { ...next, scheduleImpactActivityIds: [...next.scheduleImpactActivityIds, activityId] };
  }
  const updated: ChangeEventState = {
    ...next,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(updated, CHANGE_EVENT_INVARIANTS, context);
}

/**
 * Guard (acceptance: links are immutable once recorded): replacing a change
 * event's link set. There is no such transition — the guard exists so the
 * absence is ENCODED as an always-failing typed invariant-violation (the
 * same discipline the schedule package applies to baseline edits).
 */
export function replaceChangeLinksState(
  current: ChangeEventState,
  _links: ChangeEventLinks,
  context?: DomainErrorContext,
): Result<ChangeEventState, DomainError> {
  return fail(
    invariantViolation(
      {
        name: 'change-event-links-are-immutable',
        statement: `the link set of change event ${current.entityId} is immutable once recorded: links can only be appended while proposed, never replaced`,
      },
      context,
    ),
  );
}

/**
 * Guard (acceptance: links are immutable once recorded): removing or
 * repointing recorded links. There is no such transition — always a typed
 * invariant-violation.
 */
export function removeChangeLinksState(
  current: ChangeEventState,
  context?: DomainErrorContext,
): Result<ChangeEventState, DomainError> {
  return fail(
    invariantViolation(
      {
        name: 'change-event-links-are-immutable',
        statement: `the link set of change event ${current.entityId} is immutable once recorded: recorded links are never removed or repointed`,
      },
      context,
    ),
  );
}

/**
 * Pure transition: SUPERSEDE the change event's proposed state — performed
 * exclusively by executing its originating change order (the handler calls
 * this inside the execution unit). One-way: superseding an already
 * superseded event is a typed invariant-violation, as is superseding an
 * event whose proposed state is already gone. The input state is untouched
 * on failure.
 */
export function supersedeChangeEventState(
  current: ChangeEventState,
  changeOrderId: EntityId,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ChangeEventState, DomainError> {
  if (current.status === 'superseded') {
    return fail(
      invariantViolation(
        {
          name: 'change-event-supersession-is-one-way',
          statement: `change event ${current.entityId} is already superseded (by change order ${String(current.supersededByChangeOrderId)})`,
        },
        context,
      ),
    );
  }
  const next: ChangeEventState = {
    ...current,
    status: 'superseded',
    supersededAt: now,
    supersededByChangeOrderId: changeOrderId,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, CHANGE_EVENT_INVARIANTS, context);
}

// ----- change order constructors & transitions (pure) ------------------------------

/** Parts of a newly submitted change order (the canonical id is issued inside the handler). */
export interface NewChangeOrder {
  readonly changeOrderId: EntityId;
  readonly title: string;
  readonly changeValue?: Money | null;
  readonly now: Timestamp;
}

/**
 * Pure constructor: build the initial state of a newly submitted change
 * order (trusted path — the payload was validated fail-closed upstream; the
 * handler binds it to its originating change event). A new order is
 * 'submitted' — awaiting decision.
 */
export function createChangeOrderState(
  input: NewChangeOrder,
  scope: Scope,
  contractId: EntityId,
  changeEventId: EntityId,
  context?: DomainErrorContext,
): Result<ChangeOrderState, DomainError> {
  const state: ChangeOrderState = {
    entityKind: CHANGE_ORDER_KIND,
    entityId: input.changeOrderId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    contractId,
    changeEventId,
    title: input.title,
    changeValue: input.changeValue ?? null,
    status: 'submitted',
    decidedAt: null,
    decisionReason: null,
    executedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(state, CHANGE_ORDER_INVARIANTS, context);
}

/** The shared one-way lifecycle gate of the change order transitions. */
const changeOrderTransition = (
  current: ChangeOrderState,
  expected: ChangeOrderStatus,
  next: Partial<ChangeOrderState>,
  now: Timestamp,
  statement: string,
  context?: DomainErrorContext,
): Result<ChangeOrderState, DomainError> => {
  if (current.status !== expected) {
    return fail(
      invariantViolation(
        {
          name: 'change-order-lifecycle-is-one-way',
          statement,
        },
        context,
      ),
    );
  }
  const updated: ChangeOrderState = {
    ...current,
    ...next,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(updated, CHANGE_ORDER_INVARIANTS, context);
};

/**
 * Pure transition: APPROVE a submitted change order (one-way). Approving an
 * already-decided (approved/rejected/executed) order is a typed
 * invariant-violation. The input state is untouched on failure.
 */
export function approveChangeOrderState(
  current: ChangeOrderState,
  reason: string | null,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ChangeOrderState, DomainError> {
  return changeOrderTransition(
    current,
    'submitted',
    { status: 'approved', decidedAt: now, decisionReason: reason },
    now,
    `change order ${current.entityId} cannot be approved from status '${current.status}' (the lifecycle is submitted -> approved/rejected -> executed, one-way)`,
    context,
  );
}

/**
 * Pure transition: REJECT a submitted change order (one-way, terminal). A
 * rejected order never mutates contracted scope — there is no transition out
 * of 'rejected'. The input state is untouched on failure.
 */
export function rejectChangeOrderState(
  current: ChangeOrderState,
  reason: string | null,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ChangeOrderState, DomainError> {
  return changeOrderTransition(
    current,
    'submitted',
    { status: 'rejected', decidedAt: now, decisionReason: reason },
    now,
    `change order ${current.entityId} cannot be rejected from status '${current.status}' (the lifecycle is submitted -> approved/rejected -> executed, one-way)`,
    context,
  );
}

/**
 * Pure transition: EXECUTE an approved change order (one-way, terminal).
 * Executing a submitted (undecided) or already-terminal order is a typed
 * invariant-violation. The SUPERSESSION of the originating change event's
 * proposed state is a separate transition the handler performs inside the
 * SAME unit of work (see supersedeChangeEventState). The input state is
 * untouched on failure.
 */
export function executeChangeOrderState(
  current: ChangeOrderState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ChangeOrderState, DomainError> {
  return changeOrderTransition(
    current,
    'approved',
    { status: 'executed', executedAt: now },
    now,
    `change order ${current.entityId} cannot be executed from status '${current.status}' (only an approved order executes, one-way)`,
    context,
  );
}

// ----- claim reference constructor (pure) ------------------------------------------

/** Parts of a newly recorded claim reference (the canonical id is issued inside the handler). */
export interface NewClaimReference {
  readonly claimReferenceId: EntityId;
  readonly claimEntityKind: EntityKind;
  readonly claimEntityId: EntityId;
  readonly changeOrderId: EntityId;
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
  readonly now: Timestamp;
}

/**
 * Pure constructor: build the state of a newly recorded claim reference
 * (trusted path — the payload was validated fail-closed upstream; the
 * handler validates the change order and derives the scope and owning
 * contract). The reference is an immutable row of record: create-only,
 * never repointed.
 */
export function createClaimReferenceState(
  input: NewClaimReference,
  scope: Scope,
  contractId: EntityId,
  context?: DomainErrorContext,
): Result<ClaimReferenceState, DomainError> {
  const state: ClaimReferenceState = {
    entityKind: CLAIM_REFERENCE_KIND,
    entityId: input.claimReferenceId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    contractId,
    claimEntityKind: input.claimEntityKind,
    claimEntityId: input.claimEntityId,
    changeOrderId: input.changeOrderId,
    documentId: input.documentId,
    revisionId: input.revisionId,
    createdAt: input.now,
  };
  return checkInvariants(state, CLAIM_REFERENCE_INVARIANTS, context);
}
