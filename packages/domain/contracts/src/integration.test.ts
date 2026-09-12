import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseEntityId,
  parseEntityKind,
  parseTimestamp,
} from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  APPROVE_CHANGE_ORDER_COMMAND,
  CREATE_CONTRACT_COMMAND,
  EXECUTE_CHANGE_ORDER_COMMAND,
  LINK_CHANGE_REFERENCES_COMMAND,
  RAISE_CHANGE_EVENT_COMMAND,
  RECORD_SCOPE_OBLIGATION_COMMAND,
  REFERENCE_CLAIM_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  createContractsCommands,
} from './commands';
import type { ContractsCommandDeps, ContractsCommands } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryContractsStore } from './store';
import type { InMemoryContractsStore } from './store';


// OFF-012 contracts/change domain — the full in-memory acceptance suite: the
// whole commercial lifecycle through the command service (create contract ->
// record obligations -> raise a change event with its typed link set ->
// append links -> submit/approve/execute the change order -> supersede the
// change event -> pin the claim reference), one audit event per mutation
// (scope, actor, source 'domain', correlation/causation propagated from the
// command envelope, before/after entity refs), the link-no-copy acceptance
// (links are ids/refs only — referenced entities' data NEVER appears), the
// deterministic end-to-end replay (identical command sequence on two fresh
// harnesses -> identical states AND identical event streams), and the
// deterministic canonical ids (same supplier sequence -> same ids). No I/O,
// fixed clock and id suppliers.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const mustSucceed = <T, E>(
  result: { ok: true; value: T } | { ok: false; error: E },
  what: string,
): T => {
  if (!result.ok) {
    throw new Error(`${what} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const PROJECT_SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };

const POLICY: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['contracts.write'],
    actions: ['write'],
    resourceKinds: [
      'contract',
      'scope-obligation',
      'change-event',
      'change-order',
      'claim-reference',
    ],
  },
]);
const COMMERCIAL_MANAGER = { policy: POLICY, capabilities: ['contracts.write'] };

const idOf = (opaque: string) => formatEntityId({ version: 'v1', opaque });

/** Trusted-path claim-kind literal (the claim entity lives elsewhere). */
const CLAIM_KIND = unwrap(parseEntityKind('claim'));

// Referenced entities of OTHER domains, with data that must NEVER leak into
// the change event's state (the link-no-copy acceptance).
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

// Data of the referenced entities (would be copied by a BAD implementation):
const OBLIGATION_CODE = 'EARTHWORKS';
const OBLIGATION_DESCRIPTION = 'Excavation and grading of the north platform';
const OBLIGATION_QUANTITY = '1250.5';
const OBLIGATION_UNIT = 'm3';
const DOCUMENT_TITLE = 'Site condition photos — north platform';
const COST_ITEM_NAME = 'Excavator fleet standby cost';
const BUDGET_LINE_NAME = 'Siteworks budget line 4B';
const ACTIVITY_NAME = 'Earthworks — north platform';

interface Harness {
  readonly store: InMemoryContractsStore;
  readonly sink: InMemoryEventSink;
  readonly commands: ContractsCommands;
  /** Deterministic per-harness command-envelope factory (own idempotency-key
   * sequence: two fresh harnesses replay the IDENTICAL command sequence —
   * same keys, same causation ids, hence identical event streams). */
  readonly envelope: (
    payload: unknown,
    commandName: CommandName,
    scope?: Scope,
  ) => CommandEnvelope<unknown>;
}

const makeHarness = (): Harness => {
  const store = createInMemoryContractsStore();
  const sink = createInMemoryEventSink();
  let issued = 0;
  const deps: ContractsCommandDeps = {
    store,
    eventSink: sink,
    now: () => NOW,
    newOpaqueId: () => {
      issued += 1;
      return `a${String(issued).padStart(15, '0')}`;
    },
  };
  let envelopeCounter = 0;
  const envelope = (
    payload: unknown,
    commandName: CommandName,
    scope: Scope = PROJECT_SCOPE,
  ): CommandEnvelope<unknown> => {
    envelopeCounter += 1;
    return unwrap(
      parseCommandEnvelope({
        kind: 'command',
        commandName,
        scope,
        actor: { kind: 'user', actorId: ACTOR_ID },
        idempotencyKey: `idem-${String(envelopeCounter).padStart(12, '0')}`,
        causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
        issuedAt: '2026-09-12T10:15:30.000Z',
        schemaVersion: '1.0.0',
        payload,
      }),
    );
  };
  return { store, sink, commands: createContractsCommands(deps), envelope };
};

/**
 * THE canonical commercial lifecycle, as one deterministic command sequence:
 * create -> 2 obligations -> raise (with the full typed link set) -> append
 * links -> submit -> approve -> execute (superseding the change event) ->
 * claim reference. Returns the FINAL committed states (re-read through the
 * scope-guarded store) plus the ids the sequence produced.
 */
const runLifecycle = async (harness: Harness) => {
  const contract = mustSucceed(
    await harness.commands.createContract(
      harness.envelope(
        {
          title: 'Riverside design-build contract',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 12_500_000, currency: 'USD' },
        },
        CREATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    'createContract',
  );
  let version = contract.version;

  const recordObligation = async (code: string, description: string, quantity: string) => {
    const state = mustSucceed(
      await harness.commands.recordScopeObligation(
        harness.envelope(
          {
            contractId: contract.entityId,
            expectedVersion: version,
            code,
            description,
            quantity,
            unit: OBLIGATION_UNIT,
          },
          RECORD_SCOPE_OBLIGATION_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      `recordScopeObligation ${code}`,
    );
    version = state.version;
    return state;
  };

  const withObligations = await recordObligation(OBLIGATION_CODE, OBLIGATION_DESCRIPTION, OBLIGATION_QUANTITY);
  await recordObligation('STRUCTURE', 'Structural steel erection', '88.25');
  const obligationIds = Object.keys(withObligations.obligations).map((id) =>
    unwrap(parseEntityId(id)),
  );
  const earthworksId = obligationIds[0];
  if (earthworksId === undefined) throw new Error('earthworks obligation missing');

  const changeEvent = mustSucceed(
    await harness.commands.raiseChangeEvent(
      harness.envelope(
        {
          contractId: contract.entityId,
          title: 'North platform additional excavation',
          changeType: 'modification',
          affectedObligationIds: [earthworksId],
          evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
          costImpactLinks: [{ budgetId: BUDGET_ID, costItemId: COST_ITEM_ID }],
          scheduleImpactActivityIds: [ACTIVITY_ID],
        },
        RAISE_CHANGE_EVENT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    'raiseChangeEvent',
  );

  const linked = mustSucceed(
    await harness.commands.linkChangeReferences(
      harness.envelope(
        {
          changeEventId: changeEvent.entityId,
          expectedVersion: changeEvent.version,
          evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID_2 }],
          costImpactLinks: [{ budgetId: null, costItemId: COST_ITEM_ID_2 }],
          scheduleImpactActivityIds: [ACTIVITY_ID_2],
        },
        LINK_CHANGE_REFERENCES_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    'linkChangeReferences',
  );

  const order = mustSucceed(
    await harness.commands.submitChangeOrder(
      harness.envelope(
        {
          changeEventId: changeEvent.entityId,
          title: 'CO 01 — north platform additional excavation',
          changeValue: { amount: 250_000, currency: 'USD' },
        },
        SUBMIT_CHANGE_ORDER_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    'submitChangeOrder',
  );

  const approved = mustSucceed(
    await harness.commands.approveChangeOrder(
      harness.envelope(
        { changeOrderId: order.entityId, expectedVersion: order.version, reason: 'Verified against field evidence' },
        APPROVE_CHANGE_ORDER_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    'approveChangeOrder',
  );

  const executed = mustSucceed(
    await harness.commands.executeChangeOrder(
      harness.envelope(
        { changeOrderId: order.entityId, expectedVersion: approved.version },
        EXECUTE_CHANGE_ORDER_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    'executeChangeOrder',
  );

  const claimReference = mustSucceed(
    await harness.commands.referenceClaim(
      harness.envelope(
        {
          claimEntityKind: 'claim',
          claimEntityId: CLAIM_ID,
          changeOrderId: executed.entityId,
          documentId: DOCUMENT_ID,
          revisionId: REVISION_ID,
        },
        REFERENCE_CLAIM_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    'referenceClaim',
  );

  // The FINAL committed states, re-read through the scope-guarded store:
  // the contract after both obligations, the change event after the appended
  // links AND the supersession, the order after execution.
  const finalContract = mustSucceed(
    await harness.store.loadContract(PROJECT_SCOPE, contract.entityId),
    'loadContract',
  );
  const finalChangeEvent = mustSucceed(
    await harness.store.loadChangeEvent(PROJECT_SCOPE, linked.entityId),
    'loadChangeEvent',
  );
  const finalOrder = mustSucceed(
    await harness.store.loadChangeOrder(PROJECT_SCOPE, executed.entityId),
    'loadChangeOrder',
  );

  return {
    contract: finalContract,
    changeEvent: finalChangeEvent,
    order: finalOrder,
    claimReference,
    obligationIds,
  };
};

describe('the full commercial lifecycle (one audit event per mutation)', () => {
  it('executes create -> obligations -> raise -> link -> submit -> approve -> execute -> claim', async () => {
    const harness = makeHarness();
    const { contract, changeEvent, order, claimReference } = await runLifecycle(harness);

    // Contract: version advanced once per root mutation (create + 2
    // obligations) — the change event/order/claim are separate aggregates.
    expect(harness.store.contracts).toHaveLength(1);
    expect(contract.version).toBe(3);
    expect(Object.keys(contract.obligations)).toHaveLength(2);

    // Change event: proposed -> superseded, with the appended link set.
    expect(harness.store.changeEvents).toHaveLength(1);
    expect(changeEvent.status).toBe('superseded');
    expect(changeEvent.supersededByChangeOrderId).toBe(order.entityId);
    expect(changeEvent.version).toBe(3);
    expect(changeEvent.evidenceLinks).toHaveLength(2);
    expect(changeEvent.costImpactLinks).toHaveLength(2);
    expect(changeEvent.scheduleImpactActivityIds).toStrictEqual([ACTIVITY_ID, ACTIVITY_ID_2]);

    // Change order: the full one-way lifecycle landed.
    expect(order.status).toBe('executed');
    expect(order.version).toBe(3);

    // Claim reference: the immutable pin landed.
    expect(claimReference.claimEntityId).toBe(CLAIM_ID);

    // Exactly one audit event per mutation: 9 mutations, 9 events.
    expect(harness.sink.events).toHaveLength(9);
    const names = harness.sink.events.map((event) => event.eventName);
    expect(names).toStrictEqual([
      'contracts.contractCreated',
      'contracts.obligationRecorded',
      'contracts.obligationRecorded',
      'contracts.changeEventRaised',
      'contracts.changeEventLinked',
      'contracts.changeOrderSubmitted',
      'contracts.changeOrderApproved',
      'contracts.changeOrderExecuted',
      'contracts.claimReferenced',
    ]);
  });

  it('every envelope carries scope, actor, source domain, correlation, causation = command key', async () => {
    const harness = makeHarness();
    await runLifecycle(harness);
    const events = harness.sink.events;
    // The harness's own envelope counter advanced during the sequence: the
    // i-th command's idempotency key is the causation id of the i-th event.
    for (const [index, event] of events.entries()) {
      expect(event.scope).toStrictEqual(PROJECT_SCOPE);
      expect(event.actor).toStrictEqual({ kind: 'user', actorId: ACTOR_ID });
      expect(event.source).toBe('domain');
      expect(event.causality.correlationId).toBe('corr-0f1e2d3c4b5a');
      expect(event.causality.causationId).toBe(
        `idem-${String(index + 1).padStart(12, '0')}`,
      );
      expect(event.occurredAt).toBe(NOW);
      // Every payload carries the owning contractId (the ledger stream key).
      const payload = event.payload as { readonly contractId: string };
      expect(payload.contractId).toBe(harness.store.contracts[0]?.entityId);
    }
  });

  it('the executed envelope records the supersession of the originating change event', async () => {
    const harness = makeHarness();
    const { order } = await runLifecycle(harness);
    const executedEvent = harness.sink.events.find(
      (event) => event.eventName === 'contracts.changeOrderExecuted',
    );
    expect(executedEvent).toBeDefined();
    const payload = executedEvent?.payload as {
      changeEventId: string;
      changeEventStatus: string;
      changeEventVersion: number;
      status: string;
    };
    expect(payload.status).toBe('executed');
    expect(payload.changeEventId).toBe(harness.store.changeEvents[0]?.entityId);
    expect(payload.changeEventStatus).toBe('superseded');
    expect(payload.changeEventVersion).toBe(3);
    // Before/after refs address the change order aggregate.
    expect(executedEvent?.entityRefs.before?.entityKind).toBe('change-order');
    expect(executedEvent?.entityRefs.after?.entityId).toBe(order.entityId);
  });
});

describe('THE link-no-copy acceptance (change events bind by typed links only)', () => {
  it('the change event state contains ONLY ids and refs — no referenced entity data', async () => {
    const harness = makeHarness();
    const { changeEvent } = await runLifecycle(harness);
    const serialized = JSON.stringify(changeEvent);

    // The four typed link families are present as canonical ids/refs.
    expect(changeEvent.affectedObligationIds).toHaveLength(1);
    expect(changeEvent.evidenceLinks).toStrictEqual([
      { documentId: DOCUMENT_ID, revisionId: REVISION_ID },
      { documentId: DOCUMENT_ID, revisionId: REVISION_ID_2 },
    ]);
    expect(changeEvent.costImpactLinks).toStrictEqual([
      { budgetId: BUDGET_ID, costItemId: COST_ITEM_ID },
      { budgetId: null, costItemId: COST_ITEM_ID_2 },
    ]);
    expect(changeEvent.scheduleImpactActivityIds).toStrictEqual([ACTIVITY_ID, ACTIVITY_ID_2]);

    // NONE of the referenced entities' data is duplicated into the state:
    // obligation code/description/quantity/unit, document title, cost item
    // names, budget line names, activity names — all absent.
    expect(serialized).not.toContain(OBLIGATION_CODE);
    expect(serialized).not.toContain(OBLIGATION_DESCRIPTION);
    expect(serialized).not.toContain(OBLIGATION_QUANTITY);
    expect(serialized).not.toContain(OBLIGATION_UNIT);
    expect(serialized).not.toContain(DOCUMENT_TITLE);
    expect(serialized).not.toContain(COST_ITEM_NAME);
    expect(serialized).not.toContain(BUDGET_LINE_NAME);
    expect(serialized).not.toContain(ACTIVITY_NAME);

    // The only strings present are canonical ids, the title, the change type
    // and the status vocabulary.
    expect(serialized).toContain(String(DOCUMENT_ID));
    expect(serialized).toContain(String(REVISION_ID));
    expect(serialized).toContain(String(BUDGET_ID));
    expect(serialized).toContain(String(ACTIVITY_ID));
  });

  it('the change-event-raised AUDIT EVENT payload carries the same ids/refs only', async () => {
    const harness = makeHarness();
    await runLifecycle(harness);
    const raisedEvent = harness.sink.events.find(
      (event) => event.eventName === 'contracts.changeEventRaised',
    );
    expect(raisedEvent).toBeDefined();
    const payload = JSON.stringify(raisedEvent?.payload);
    expect(payload).not.toContain(OBLIGATION_CODE);
    expect(payload).not.toContain(DOCUMENT_TITLE);
    expect(payload).not.toContain(COST_ITEM_NAME);
    expect(payload).not.toContain(ACTIVITY_NAME);
  });

  it('links are immutable once recorded: no command repoints or edits a recorded link', async () => {
    const harness = makeHarness();
    const { changeEvent } = await runLifecycle(harness);
    // The commands surface exposes exactly one link mutation
    // (linkChangeReferences — append-only). After supersession even appends
    // are typed-rejected: the recorded set is frozen forever.
    const frozen = await harness.commands.linkChangeReferences(
      harness.envelope(
        {
          changeEventId: changeEvent.entityId,
          expectedVersion: changeEvent.version,
          evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
        },
        LINK_CHANGE_REFERENCES_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    // A duplicate AND frozen — both typed failures; either way the state is
    // unchanged, which is the assertion that matters.
    expect(frozen.ok).toBe(false);
    expect(harness.store.changeEvents[0]?.evidenceLinks).toHaveLength(2);
    expect(harness.store.changeEvents[0]?.version).toBe(3);
  });

  it('the claim reference state carries ids/refs only — no claim or document data', async () => {
    const harness = makeHarness();
    const { claimReference } = await runLifecycle(harness);
    const serialized = JSON.stringify(claimReference);
    expect(serialized).not.toContain('claim title');
    expect(serialized).not.toContain(DOCUMENT_TITLE);
    expect(serialized).toContain(String(CLAIM_ID));
    expect(serialized).toContain(String(REVISION_ID));
  });
});

describe('the immutable commercial event history (deterministic replay)', () => {
  it('replaying the identical command sequence reconstructs the exact final state', async () => {
    const first = makeHarness();
    const second = makeHarness();

    const firstRun = await runLifecycle(first);
    const secondRun = await runLifecycle(second);

    // Identical supplier sequences => identical canonical ids: the two runs
    // issued the same number of commands and produced the same ids.
    expect(secondRun.contract.entityId).toBe(firstRun.contract.entityId);
    expect(secondRun.changeEvent.entityId).toBe(firstRun.changeEvent.entityId);
    expect(secondRun.order.entityId).toBe(firstRun.order.entityId);
    expect(secondRun.claimReference.entityId).toBe(firstRun.claimReference.entityId);

    // Identical STATES (the deterministic end-to-end replay).
    expect(secondRun.contract).toStrictEqual(firstRun.contract);
    expect(secondRun.changeEvent).toStrictEqual(firstRun.changeEvent);
    expect(secondRun.order).toStrictEqual(firstRun.order);
    expect(secondRun.claimReference).toStrictEqual(firstRun.claimReference);
    expect(second.store.contracts).toStrictEqual(first.store.contracts);
    expect(second.store.changeEvents).toStrictEqual(first.store.changeEvents);
    expect(second.store.changeOrders).toStrictEqual(first.store.changeOrders);
    expect(second.store.claimReferences).toStrictEqual(first.store.claimReferences);

    // Identical EVENT STREAMS: the full commercial history replays exactly
    // (same idempotency-key sequences => same causation ids => same envelopes).
    expect(second.sink.events).toStrictEqual(first.sink.events);
    expect(first.sink.events).toHaveLength(9);
  });

  it('deterministic ids: same supplier sequence composes the same canonical ids (parse via contracts)', async () => {
    const first = makeHarness();
    const second = makeHarness();
    const runOne = await runLifecycle(first);
    const runTwo = await runLifecycle(second);
    for (const id of [
      runOne.contract.entityId,
      runOne.changeEvent.entityId,
      runOne.order.entityId,
      runOne.claimReference.entityId,
    ]) {
      // Every issued id parses with the contracts parser by construction.
      const parsed = parseEntityId(id);
      expect(parsed.ok).toBe(true);
    }
    expect(parseEntityId(runTwo.contract.entityId)).toStrictEqual(
      parseEntityId(runOne.contract.entityId),
    );
  });
});

describe('the whole-suite read model (scope-guarded store reads)', () => {
  it('lists the change history of a contract, invisible to a foreign tenant', async () => {
    const harness = makeHarness();
    const { contract } = await runLifecycle(harness);
    const changeEvents = mustSucceed(
      await harness.store.listChangeEventsOfContract(PROJECT_SCOPE, contract.entityId),
      'listChangeEventsOfContract',
    );
    expect(changeEvents).toHaveLength(1);
    const changeOrders = mustSucceed(
      await harness.store.listChangeOrdersOfContract(PROJECT_SCOPE, contract.entityId),
      'listChangeOrdersOfContract',
    );
    expect(changeOrders).toHaveLength(1);
    const foreign: Scope = { kind: 'tenant', tenantId: formatTenantId({ version: 'v1', opaque: 'aa1b2c3d4e5f60718293a4b5c6d7e8f1' }) };
    const invisible = await harness.store.listChangeEventsOfContract(foreign, contract.entityId);
    expect(invisible.ok).toBe(false);
    if (!invisible.ok) expect(invisible.error.code).toBe('not-found');
  });

  it('finds the claim reference by target and lists a claim entitlement trail', async () => {
    const harness = makeHarness();
    const { order } = await runLifecycle(harness);
    const reference = mustSucceed(
      await harness.store.findClaimReferenceByTarget(
        PROJECT_SCOPE,
        { entityKind: CLAIM_KIND, entityId: CLAIM_ID },
        order.entityId,
        DOCUMENT_ID,
        REVISION_ID,
      ),
      'findClaimReferenceByTarget',
    );
    expect(reference.claimEntityId).toBe(CLAIM_ID);
    const trail = mustSucceed(
      await harness.store.listClaimReferencesOfClaim(PROJECT_SCOPE, {
        entityKind: CLAIM_KIND,
        entityId: CLAIM_ID,
      }),
      'listClaimReferencesOfClaim',
    );
    expect(trail).toHaveLength(1);
    expect(trail[0]?.changeOrderId).toBe(order.entityId);
  });
});
