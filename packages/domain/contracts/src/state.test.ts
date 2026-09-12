import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseEntityKind,
  parseTimestamp,
} from '@office/contracts';
import type { EntityId, EntityKind, ParseResult, Scope, Timestamp } from '@office/contracts';
import { checkInvariants } from '@office/domain-kernel';
import { parseMoney, parseQuantityValue } from './parse';
import type { Money, QuantityValue } from './parse';
import {
  CLAIM_REFERENCE_INVARIANTS,
  archiveContractState,
  approveChangeOrderState,
  createChangeEventState,
  createChangeOrderState,
  createClaimReferenceState,
  createContractState,
  executeChangeOrderState,
  linkChangeReferencesState,
  recordObligationState,
  rejectChangeOrderState,
  removeChangeLinksState,
  replaceChangeLinksState,
  supersedeChangeEventState,
  updateContractState,
} from './state';
import type { ContractState } from './state';

// OFF-012 contracts/change domain — the pure-state acceptance suite: the
// contract lifecycle (forward-only execution status, one-way archive), the
// immutable scope-obligation rows, the change event's typed cross-entity
// link model (append-only, never repointed — the always-failing guards),
// the one-way change-order lifecycle (submitted -> approved/rejected ->
// executed; execution supersedes the originating change event), and the
// immutable claim reference rows. All transitions are pure: failures never
// mutate the input state (deep-compared to prove it).

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const unwrapResult = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

/** Deterministic branded money literal (issued through the fail-closed parser). */
const money = (amount: number, currency: string): Money =>
  unwrapResult(parseMoney({ amount, currency }));

/** Deterministic branded quantity literal (issued through the parser). */
const qty = (value: string): QuantityValue => unwrapResult(parseQuantityValue(value));

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const LATER: Timestamp = unwrap(parseTimestamp('2026-10-01T08:00:00.000Z'));

const PROJECT_SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };

const idOf = (opaque: string): EntityId => formatEntityId({ version: 'v1', opaque });

const CONTRACT_ID = idOf('aa1b2c3d4e5f60718293a4b5c6d7e8f0');
const OBLIGATION_ID = idOf('bb2c3d4e5f60718293a4b5c6d7e8f0a1');
const OBLIGATION_ID_2 = idOf('bb2c3d4e5f60718293a4b5c6d7e8f0a2');
const CHANGE_EVENT_ID = idOf('cc3d4e5f60718293a4b5c6d7e8f0a1b2');
const CHANGE_ORDER_ID = idOf('dd4e5f60718293a4b5c6d7e8f0a1b2c3');
const CLAIM_REFERENCE_ID = idOf('ee5f60718293a4b5c6d7e8f0a1b2c3d4');
const PERSON_ID = idOf('ff60718293a4b5c6d7e8f0a1b2c3d4e5');
const COMPANY_ID = idOf('0f60718293a4b5c6d7e8f0a1b2c3d4e6');
const DOCUMENT_ID = idOf('1f60718293a4b5c6d7e8f0a1b2c3d4e7');
const REVISION_ID = idOf('2f60718293a4b5c6d7e8f0a1b2c3d4e8');
const REVISION_ID_2 = idOf('3f60718293a4b5c6d7e8f0a1b2c3d4e9');
const BUDGET_ID = idOf('4f60718293a4b5c6d7e8f0a1b2c3d4f0');
const COST_ITEM_ID = idOf('5f60718293a4b5c6d7e8f0a1b2c3d4f1');
const COST_ITEM_ID_2 = idOf('6f60718293a4b5c6d7e8f0a1b2c3d4f2');
const ACTIVITY_ID = idOf('7f60718293a4b5c6d7e8f0a1b2c3d4f3');
const ACTIVITY_ID_2 = idOf('8f60718293a4b5c6d7e8f0a1b2c3d4f4');
const CLAIM_ID = idOf('9f60718293a4b5c6d7e8f0a1b2c3d4f5');

const OWNER = { entityKind: 'person' as const, entityId: PERSON_ID };
const CONTRACTOR = { entityKind: 'company' as const, entityId: COMPANY_ID };
const CONTRACT_VALUE = money(12_500_000, 'USD');

const contractBase = (): ContractState =>
  unwrapResult(
    createContractState(
      {
        contractId: CONTRACT_ID,
        title: 'Riverside design-build contract',
        owner: OWNER,
        contractor: CONTRACTOR,
        contractValue: CONTRACT_VALUE,
        now: NOW,
      },
      PROJECT_SCOPE,
    ),
  );

const withObligation = (): ContractState =>
  unwrapResult(
    recordObligationState(
      contractBase(),
      {
        obligationId: OBLIGATION_ID,
        code: 'EARTHWORKS',
        description: 'Excavation and grading of the north platform',
        quantity: qty('1250.5'),
        unit: 'm3',
        now: NOW,
      },
    ),
  );

describe('contract state (create/update/archive)', () => {
  it('creates a project-scoped, active, draft contract with an empty scope decomposition', () => {
    const state = contractBase();
    expect(state.entityId).toBe(CONTRACT_ID);
    expect(state.scope).toStrictEqual(PROJECT_SCOPE);
    expect(state.version).toBe(1);
    expect(state.lifecycleStatus).toBe('active');
    expect(state.archivedAt).toBeNull();
    expect(state.executionStatus).toBe('draft');
    expect(state.contractValue).toStrictEqual(CONTRACT_VALUE);
    expect(state.owner).toStrictEqual(OWNER);
    expect(state.contractor).toStrictEqual(CONTRACTOR);
    expect(state.obligations).toStrictEqual({});
  });

  it('rejects a tenant-scoped contract state (the second authorization boundary)', () => {
    const result = createContractState(
      {
        contractId: CONTRACT_ID,
        title: 'Riverside design-build contract',
        owner: OWNER,
        contractor: CONTRACTOR,
        contractValue: CONTRACT_VALUE,
        now: NOW,
      },
      { kind: 'tenant', tenantId: TENANT_A },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('contract-is-project-scoped');
    }
  });

  it('updates metadata and bumps the version exactly once per mutation', () => {
    const updated = unwrapResult(
      updateContractState(
        contractBase(),
        { title: 'Riverside design-build contract (amended)', contractValue: money(13_000_000, 'EUR') },
        LATER,
      ),
    );
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Riverside design-build contract (amended)');
    expect(updated.contractValue.currency).toBe('EUR');
    expect(updated.updatedAt).toBe(LATER);
    expect(updated.obligations).toStrictEqual({});
  });

  it('moves the execution status forward only — a rewind is a typed invariant-violation', () => {
    const executed = unwrapResult(
      updateContractState(contractBase(), { executionStatus: 'executed' }, LATER),
    );
    expect(executed.executionStatus).toBe('executed');
    const closed = unwrapResult(
      updateContractState(executed, { executionStatus: 'closed' }, LATER),
    );
    expect(closed.executionStatus).toBe('closed');
    const rewind = updateContractState(closed, { executionStatus: 'draft' }, LATER);
    expect(rewind.ok).toBe(false);
    if (!rewind.ok) {
      expect(rewind.error.code).toBe('invariant-violation');
      expect(rewind.error.details[0]?.code).toBe('contract-execution-status-moves-forward');
    }
    expect(closed.executionStatus).toBe('closed');
  });

  it('archives one-way and timestamped; a second archive is a typed invariant-violation', () => {
    const archived = unwrapResult(archiveContractState(contractBase(), LATER));
    expect(archived.lifecycleStatus).toBe('archived');
    expect(archived.archivedAt).toBe(LATER);
    expect(archived.version).toBe(2);
    const again = archiveContractState(archived, LATER);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('invariant-violation');
      expect(again.error.details[0]?.code).toBe('contract-archive-is-terminal');
    }
  });

  it('an archived contract rejects updates and further scope recording (terminal lifecycle)', () => {
    const archived = unwrapResult(archiveContractState(contractBase(), LATER));
    const update = updateContractState(archived, { title: 'x' }, LATER);
    expect(update.ok).toBe(false);
    if (!update.ok) {
      expect(update.error.details[0]?.code).toBe('contract-archive-is-terminal');
    }
    const record = recordObligationState(archived, {
      obligationId: OBLIGATION_ID,
      code: 'PLUMBING',
      description: 'Full plumbing rough-in',
      quantity: qty('1'),
      unit: 'lot',
      now: LATER,
    });
    expect(record.ok).toBe(false);
    if (!record.ok) {
      expect(record.error.details[0]?.code).toBe('contract-archive-is-terminal');
    }
  });
});

describe('scope obligation rows (immutable inside the contract root)', () => {
  it('records an obligation, bumping the root version exactly once', () => {
    const state = withObligation();
    expect(state.version).toBe(2);
    const obligation = state.obligations[OBLIGATION_ID];
    expect(obligation).toBeDefined();
    expect(obligation?.code).toBe('EARTHWORKS');
    expect(obligation?.quantity).toBe('1250.5');
    expect(obligation?.contractId).toBe(CONTRACT_ID);
    expect(obligation?.version).toBe(1);
  });

  it('rejects duplicate obligation codes with the input state untouched', () => {
    const base = withObligation();
    const duplicate = recordObligationState(base, {
      obligationId: OBLIGATION_ID_2,
      code: 'EARTHWORKS',
      description: 'A second excavation scope',
      quantity: qty('10'),
      unit: 'm3',
      now: LATER,
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe('invariant-violation');
      expect(duplicate.error.details[0]?.code).toBe('contract-obligation-codes-unique');
    }
    expect(base.obligations[OBLIGATION_ID_2]).toBeUndefined();
    expect(base.version).toBe(2);
  });

  it('an obligation row is a create-only row of record: no mutating transition exists', () => {
    // The state module exposes exactly one obligation transition
    // (recordObligationState, appends-only). This is the structural
    // immutability proof: there is no update/delete obligation function, and
    // re-recording the same id under a different code is a duplicate-id
    // state (the handler/store rejects it; the row itself never changes).
    const state = withObligation();
    const before = state.obligations[OBLIGATION_ID];
    expect(before).toBeDefined();
    // Deep-compare proves the recorded row is untouched by later mutations.
    const after = unwrapResult(
      recordObligationState(state, {
        obligationId: OBLIGATION_ID_2,
        code: 'STRUCTURE',
        description: 'Structural steel erection',
        quantity: qty('88.25'),
        unit: 'tonne',
        now: LATER,
      }),
    );
    expect(after.obligations[OBLIGATION_ID]).toStrictEqual(before);
  });
});

describe('change event state (typed cross-entity links)', () => {
  const raiseBase = () =>
    unwrapResult(
      createChangeEventState(
        {
          changeEventId: CHANGE_EVENT_ID,
          title: 'North platform additional excavation',
          changeType: 'modification',
          links: {
            affectedObligationIds: [OBLIGATION_ID],
            evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
            costImpactLinks: [{ budgetId: BUDGET_ID, costItemId: COST_ITEM_ID }],
            scheduleImpactActivityIds: [ACTIVITY_ID],
          },
          now: NOW,
        },
        PROJECT_SCOPE,
        CONTRACT_ID,
      ),
    );

  it('carries the four typed link families as ids and refs ONLY — never copied entity data', () => {
    const state = raiseBase();
    expect(state.status).toBe('proposed');
    expect(state.supersededAt).toBeNull();
    expect(state.supersededByChangeOrderId).toBeNull();
    expect(state.affectedObligationIds).toStrictEqual([OBLIGATION_ID]);
    expect(state.evidenceLinks).toStrictEqual([
      { documentId: DOCUMENT_ID, revisionId: REVISION_ID },
    ]);
    expect(state.costImpactLinks).toStrictEqual([
      { budgetId: BUDGET_ID, costItemId: COST_ITEM_ID },
    ]);
    expect(state.scheduleImpactActivityIds).toStrictEqual([ACTIVITY_ID]);
    // The acceptance heart, structurally: the serialized state contains the
    // canonical ids and NOTHING ELSE of the referenced entities — no
    // obligation code/description/quantity/unit, no document metadata, no
    // cost amounts, no schedule data can even appear (there is no field for
    // them to appear in).
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('EARTHWORKS');
    expect(serialized).not.toContain('quantity');
    expect(serialized).not.toContain('title_hash');
    expect(serialized).toContain(String(OBLIGATION_ID));
  });

  it('rejects duplicate link entries inside a fresh link set (typed invariant-violation)', () => {
    const result = createChangeEventState(
      {
        changeEventId: CHANGE_EVENT_ID,
        title: 'Duplicate links',
        changeType: 'addition',
        links: {
          affectedObligationIds: [OBLIGATION_ID, OBLIGATION_ID],
        },
        now: NOW,
      },
      PROJECT_SCOPE,
      CONTRACT_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('change-event-links-unique');
    }
  });

  it('appends new links while proposed (the ONLY link mutation), bumping the version', () => {
    const base = raiseBase();
    const linked = unwrapResult(
      linkChangeReferencesState(
        base,
        {
          affectedObligationIds: [OBLIGATION_ID_2],
          evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID_2 }],
          costImpactLinks: [{ budgetId: null, costItemId: COST_ITEM_ID_2 }],
          scheduleImpactActivityIds: [ACTIVITY_ID_2],
        },
        LATER,
      ),
    );
    expect(linked.version).toBe(2);
    expect(linked.affectedObligationIds).toStrictEqual([OBLIGATION_ID, OBLIGATION_ID_2]);
    expect(linked.evidenceLinks).toStrictEqual([
      { documentId: DOCUMENT_ID, revisionId: REVISION_ID },
      { documentId: DOCUMENT_ID, revisionId: REVISION_ID_2 },
    ]);
    expect(linked.costImpactLinks).toStrictEqual([
      { budgetId: BUDGET_ID, costItemId: COST_ITEM_ID },
      { budgetId: null, costItemId: COST_ITEM_ID_2 },
    ]);
    expect(linked.scheduleImpactActivityIds).toStrictEqual([ACTIVITY_ID, ACTIVITY_ID_2]);
    // The previously recorded entries are untouched (order preserved).
    expect(linked.evidenceLinks[0]).toStrictEqual(base.evidenceLinks[0]);
  });

  it('rejects appending a duplicate link with the input state untouched', () => {
    const base = raiseBase();
    const duplicate = linkChangeReferencesState(
      base,
      { evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }] },
      LATER,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe('invariant-violation');
      expect(duplicate.error.details[0]?.code).toBe('change-event-links-unique');
    }
    expect(base.evidenceLinks).toHaveLength(1);
    expect(base.version).toBe(1);
  });

  it('the replace/remove guards ALWAYS fail typed: recorded links are immutable', () => {
    const base = raiseBase();
    const replace = replaceChangeLinksState(base, { affectedObligationIds: [OBLIGATION_ID_2] });
    expect(replace.ok).toBe(false);
    if (!replace.ok) {
      expect(replace.error.code).toBe('invariant-violation');
      expect(replace.error.details[0]?.code).toBe('change-event-links-are-immutable');
    }
    const remove = removeChangeLinksState(base);
    expect(remove.ok).toBe(false);
    if (!remove.ok) {
      expect(remove.error.code).toBe('invariant-violation');
      expect(remove.error.details[0]?.code).toBe('change-event-links-are-immutable');
    }
    expect(base.affectedObligationIds).toStrictEqual([OBLIGATION_ID]);
  });

  it('supersession is one-way and records the executing change order', () => {
    const base = raiseBase();
    const superseded = unwrapResult(
      supersedeChangeEventState(base, CHANGE_ORDER_ID, LATER),
    );
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededAt).toBe(LATER);
    expect(superseded.supersededByChangeOrderId).toBe(CHANGE_ORDER_ID);
    expect(superseded.version).toBe(2);
    const again = supersedeChangeEventState(superseded, CHANGE_ORDER_ID, LATER);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.details[0]?.code).toBe('change-event-supersession-is-one-way');
    }
    // Links freeze at supersession: appending is now a typed rejection.
    const frozen = linkChangeReferencesState(
      superseded,
      { scheduleImpactActivityIds: [ACTIVITY_ID_2] },
      LATER,
    );
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) {
      expect(frozen.error.details[0]?.code).toBe('change-event-superseded-links-frozen');
    }
  });
});

describe('change order state (one-way lifecycle)', () => {
  const orderBase = () =>
    unwrapResult(
      createChangeOrderState(
        {
          changeOrderId: CHANGE_ORDER_ID,
          title: 'CO 01 — north platform additional excavation',
          changeValue: money(250_000, 'USD'),
          now: NOW,
        },
        PROJECT_SCOPE,
        CONTRACT_ID,
        CHANGE_EVENT_ID,
      ),
    );

  it('submits with status submitted and a null decision/execution', () => {
    const order = orderBase();
    expect(order.status).toBe('submitted');
    expect(order.changeEventId).toBe(CHANGE_EVENT_ID);
    expect(order.contractId).toBe(CONTRACT_ID);
    expect(order.changeValue).toStrictEqual({ amount: 250_000, currency: 'USD' });
    expect(order.decidedAt).toBeNull();
    expect(order.executedAt).toBeNull();
  });

  it('approves a submitted order one-way (decidedAt pairs with the decision)', () => {
    const approved = unwrapResult(approveChangeOrderState(orderBase(), 'Verified against field evidence', LATER));
    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).toBe(LATER);
    expect(approved.decisionReason).toBe('Verified against field evidence');
    expect(approved.executedAt).toBeNull();
    expect(approved.version).toBe(2);
    const again = approveChangeOrderState(approved, null, LATER);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.details[0]?.code).toBe('change-order-lifecycle-is-one-way');
    }
  });

  it('rejects a submitted order one-way and terminally (no transition exists out)', () => {
    const rejected = unwrapResult(rejectChangeOrderState(orderBase(), 'Priced above the entitled scope', LATER));
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedAt).toBe(LATER);
    expect(rejected.executedAt).toBeNull();
    const approveAfterReject = approveChangeOrderState(rejected, null, LATER);
    expect(approveAfterReject.ok).toBe(false);
    const executeAfterReject = executeChangeOrderState(rejected, LATER);
    expect(executeAfterReject.ok).toBe(false);
    if (!executeAfterReject.ok) {
      expect(executeAfterReject.error.details[0]?.code).toBe('change-order-lifecycle-is-one-way');
    }
  });

  it('executes an approved order one-way (executedAt pairs with execution)', () => {
    const approved = unwrapResult(approveChangeOrderState(orderBase(), null, LATER));
    const executed = unwrapResult(executeChangeOrderState(approved, LATER));
    expect(executed.status).toBe('executed');
    expect(executed.executedAt).toBe(LATER);
    expect(executed.version).toBe(3);
    const again = executeChangeOrderState(executed, LATER);
    expect(again.ok).toBe(false);
  });

  it('executing a SUBMITTED (undecided) order is a typed invariant-violation', () => {
    const result = executeChangeOrderState(orderBase(), LATER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('change-order-lifecycle-is-one-way');
    }
  });
});

describe('claim reference state (immutable pin)', () => {
  const CLAIM_KIND: EntityKind = unwrap(parseEntityKind('claim'));

  const referenceBase = () =>
    unwrapResult(
      createClaimReferenceState(
        {
          claimReferenceId: CLAIM_REFERENCE_ID,
          claimEntityKind: CLAIM_KIND,
          claimEntityId: CLAIM_ID,
          changeOrderId: CHANGE_ORDER_ID,
          documentId: DOCUMENT_ID,
          revisionId: REVISION_ID,
          now: NOW,
        },
        PROJECT_SCOPE,
        CONTRACT_ID,
      ),
    );

  it('binds the claim, the executed change order, and one specific document revision', () => {
    const reference = referenceBase();
    expect(reference.claimEntityId).toBe(CLAIM_ID);
    expect(reference.changeOrderId).toBe(CHANGE_ORDER_ID);
    expect(reference.documentId).toBe(DOCUMENT_ID);
    expect(reference.revisionId).toBe(REVISION_ID);
    expect(reference.version).toBe(1);
    expect(reference.contractId).toBe(CONTRACT_ID);
  });

  it('is create-only: the version is pinned to the initial version by invariant', () => {
    // A hand-built state with an advanced version fails the invariant list.
    const reference = referenceBase();
    const mutated = { ...reference, version: 2 } as typeof reference;
    const checked = checkInvariants(mutated, CLAIM_REFERENCE_INVARIANTS);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error.details[0]?.code).toBe(
        'claim-reference-version-is-create-only-initial',
      );
    }
  });
});
