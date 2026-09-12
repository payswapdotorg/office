import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseEntityId,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, CommandName, ParseResult, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  APPROVE_CHANGE_ORDER_COMMAND,
  ARCHIVE_CONTRACT_COMMAND,
  CREATE_CONTRACT_COMMAND,
  EXECUTE_CHANGE_ORDER_COMMAND,
  LINK_CHANGE_REFERENCES_COMMAND,
  RAISE_CHANGE_EVENT_COMMAND,
  RECORD_SCOPE_OBLIGATION_COMMAND,
  REFERENCE_CLAIM_COMMAND,
  REJECT_CHANGE_ORDER_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  UPDATE_CONTRACT_COMMAND,
  createContractsCommands,
} from './commands';
import type { ContractsCommandDeps, ContractsCommands } from './commands';
import { createInMemoryEventSink, failingEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryContractsStore } from './store';
import type { InMemoryContractsStore } from './store';
import type { ContractState } from './state';

// OFF-012 contracts/change domain — the command-path acceptance suite:
// fail-closed parsing through the handler (typed invalid-command-payload),
// deny-by-default authorization (capability required; explicit deny;
// undeclared capability; denied commands never open a transaction), the
// create-scope rules (tenant scope requires the project; project-scope
// mismatch is a typed unauthorized), A12 isolation both directions
// (cross-tenant typed not-found with state/events unchanged; cross-project
// typed unauthorized), optimistic concurrency (stale version → typed
// concurrency-conflict with the aggregate unchanged), one-way lifecycles
// through the command path, the cross-entity link gate (unknown obligation
// links rejected typed; evidence/cost/schedule links accepted as typed ids),
// and the failing-sink abort.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
const TENANT_B = formatTenantId({ version: 'v1', opaque: 'aa1b2c3d4e5f60718293a4b5c6d7e8f1' });
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const PROJECT_ID_2 = formatProjectId({
  version: 'v1',
  opaque: '2a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const PROJECT_SCOPE: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };
const TENANT_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_A };

const idOf = (opaque: string) => formatEntityId({ version: 'v1', opaque });

const PERSON_ID = idOf('ff60718293a4b5c6d7e8f0a1b2c3d4e5');
const COMPANY_ID = idOf('0f60718293a4b5c6d7e8f0a1b2c3d4e6');
const FOREIGN_CONTRACT_ID = idOf('9960718293a4b5c6d7e8f0a1b2c3d4e0');
const FOREIGN_CHANGE_ORDER_ID = idOf('9960718293a4b5c6d7e8f0a1b2c3d4e2');
const DOCUMENT_ID = idOf('1f60718293a4b5c6d7e8f0a1b2c3d4e7');
const REVISION_ID = idOf('2f60718293a4b5c6d7e8f0a1b2c3d4e8');
const BUDGET_ID = idOf('4f60718293a4b5c6d7e8f0a1b2c3d4f0');
const COST_ITEM_ID = idOf('5f60718293a4b5c6d7e8f0a1b2c3d4f1');
const ACTIVITY_ID = idOf('7f60718293a4b5c6d7e8f0a1b2c3d4f3');
const CLAIM_ID = idOf('9f60718293a4b5c6d7e8f0a1b2c3d4f5');

// Kind-scoped policy: contracts.write over the contracts-domain entity kinds.
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
const NO_CAPABILITY = { policy: POLICY, capabilities: [] };

interface Harness {
  readonly store: InMemoryContractsStore;
  readonly sink: InMemoryEventSink;
  readonly commands: ContractsCommands;
}

const makeHarness = (): Harness => {
  const store = createInMemoryContractsStore();
  const theSink = createInMemoryEventSink();
  let issued = 0;
  const deps: ContractsCommandDeps = {
    store,
    eventSink: theSink,
    now: () => NOW,
    newOpaqueId: () => {
      issued += 1;
      return `a${String(issued).padStart(15, '0')}`;
    },
  };
  return { store, sink: theSink, commands: createContractsCommands(deps) };
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

const mustSucceed = <T, E>(
  result: { ok: true; value: T } | { ok: false; error: E },
  what: string,
): T => {
  if (!result.ok) {
    throw new Error(`${what} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

const createContract = async (harness: Harness): Promise<ContractState> =>
  mustSucceed(
    await harness.commands.createContract(
      envelope(
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

const recordObligation = async (
  harness: Harness,
  contract: ContractState,
  code: string,
): Promise<ContractState> =>
  mustSucceed(
    await harness.commands.recordScopeObligation(
      envelope(
        {
          contractId: contract.entityId,
          expectedVersion: contract.version,
          code,
          description: `Scope of ${code}`,
          quantity: '100',
          unit: 'm3',
        },
        RECORD_SCOPE_OBLIGATION_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    ),
    `recordScopeObligation ${code}`,
  );

describe('command-name guard (trusted path, loud)', () => {
  it('a handler rejects a foreign command name with a TypeError', async () => {
    const harness = makeHarness();
    // The handlers are async: the guard's TypeError surfaces as a rejected
    // promise (never as a silent success — and never an unhandled rejection).
    await expect(
      harness.commands.updateContract(
        envelope({ contractId: FOREIGN_CONTRACT_ID, expectedVersion: 1 }, CREATE_CONTRACT_COMMAND),
        COMMERCIAL_MANAGER,
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe('fail-closed payload parsing through the handler', () => {
  it('a malformed payload is a typed invariant-violation naming the offending path', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createContract(
      envelope(
        {
          title: 'Riverside design-build contract',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 1.5, currency: 'USD' },
        },
        CREATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
    }
    expect(harness.store.contracts).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(0);
  });

  it('unknown payload keys and wrong types are rejected before any transaction', async () => {
    const harness = makeHarness();
    const withExtra = await harness.commands.createContract(
      envelope(
        {
          title: 'x',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 1, currency: 'USD' },
          currency: 'EUR',
        },
        CREATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(withExtra.ok).toBe(false);
    expect(harness.store.transactionCount).toBe(0);
  });
});

describe('deny-by-default authorization', () => {
  it('succeeds WITH the contracts.write capability', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    expect(contract.entityId).toBe(unwrap(parseEntityId(contract.entityId)));
    expect(harness.sink.events).toHaveLength(1);
  });

  it('denies WITHOUT the capability (typed forbidden) and never opens a transaction', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createContract(
      envelope(
        {
          title: 'Riverside design-build contract',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 12_500_000, currency: 'USD' },
        },
        CREATE_CONTRACT_COMMAND,
      ),
      NO_CAPABILITY,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
    expect(harness.store.transactionCount).toBe(0);
    expect(harness.store.contracts).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(0);
  });

  it('an explicit deny rule wins over the allow rule (typed forbidden)', async () => {
    const denyPolicy: Policy = definePolicy([
      {
        effect: 'deny',
        actions: ['write'],
        resourceKinds: ['contract', 'scope-obligation', 'change-event', 'change-order', 'claim-reference'],
      },
      {
        effect: 'allow',
        capabilities: ['contracts.write'],
        actions: ['write'],
        resourceKinds: ['contract', 'scope-obligation', 'change-event', 'change-order', 'claim-reference'],
      },
    ]);
    const harness = makeHarness();
    const result = await harness.commands.createContract(
      envelope(
        {
          title: 'Riverside design-build contract',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 12_500_000, currency: 'USD' },
        },
        CREATE_CONTRACT_COMMAND,
      ),
      { policy: denyPolicy, capabilities: ['contracts.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
  });

  it('an undeclared capability string is rejected by the authorization context (fail-closed)', async () => {
    // authorizationContext parses the capability list: an undeclared name
    // makes the context construction itself a loud TypeError on the trusted
    // path — the vocabulary is closed at @office/authz, and the command
    // never opens a transaction.
    const undeclared = { policy: POLICY, capabilities: ['contracts.superuser'] };
    const harness = makeHarness();
    await expect(
      harness.commands.createContract(
        envelope(
          {
            title: 'x',
            owner: { entityKind: 'person', entityId: PERSON_ID },
            contractor: { entityKind: 'company', entityId: COMPANY_ID },
            contractValue: { amount: 1, currency: 'USD' },
          },
          CREATE_CONTRACT_COMMAND,
        ),
        undeclared,
      ),
    ).rejects.toThrow(TypeError);
    expect(harness.store.transactionCount).toBe(0);
  });
});

describe('create-scope rules (the second authorization boundary)', () => {
  it('a tenant-scoped create MUST name the project (typed invariant-violation)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createContract(
      envelope(
        {
          title: 'Riverside design-build contract',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 12_500_000, currency: 'USD' },
        },
        CREATE_CONTRACT_COMMAND,
        TENANT_SCOPE,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
    }
    expect(harness.store.transactionCount).toBe(0);
  });

  it('a project-scoped create naming ANOTHER project is a typed unauthorized project-scope-violation', async () => {
    const harness = makeHarness();
    const result = await harness.commands.createContract(
      envelope(
        {
          title: 'Riverside design-build contract',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 12_500_000, currency: 'USD' },
          projectId: PROJECT_ID_2,
        },
        CREATE_CONTRACT_COMMAND,
        PROJECT_SCOPE,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-violation');
    }
    expect(harness.store.transactionCount).toBe(0);
  });
});

describe('A12 tenant isolation (both directions, no existence oracle)', () => {
  it('a cross-tenant update of a visible-to-A contract is a typed not-found with nothing mutated', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const foreign: Scope = { kind: 'tenant', tenantId: TENANT_B };
    const result = await harness.commands.updateContract(
      envelope(
        { contractId: contract.entityId, expectedVersion: 1, title: 'Hostile takeover' },
        UPDATE_CONTRACT_COMMAND,
        foreign,
      ),
      { policy: POLICY, capabilities: ['contracts.write'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
    }
    expect(harness.store.contracts[0]?.title).toBe('Riverside design-build contract');
    expect(harness.sink.events).toHaveLength(1);
  });

  it('a cross-tenant raiseChangeEvent / submitChangeOrder / referenceClaim is equally invisible', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const foreign: Scope = { kind: 'tenant', tenantId: TENANT_B };
    const raise = await harness.commands.raiseChangeEvent(
      envelope(
        {
          contractId: contract.entityId,
          title: 'Foreign change',
          changeType: 'addition',
        },
        RAISE_CHANGE_EVENT_COMMAND,
        foreign,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(raise.ok).toBe(false);
    if (!raise.ok) expect(raise.error.code).toBe('not-found');
    const claim = await harness.commands.referenceClaim(
      envelope(
        {
          claimEntityKind: 'claim',
          claimEntityId: CLAIM_ID,
          changeOrderId: FOREIGN_CHANGE_ORDER_ID,
          documentId: DOCUMENT_ID,
          revisionId: REVISION_ID,
        },
        REFERENCE_CLAIM_COMMAND,
        foreign,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.error.code).toBe('not-found');
    expect(harness.store.changeEvents).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(1);
  });

  it('a cross-project project-scoped command is a typed not-found (A: project 2 cannot see project 1)', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const otherProject: Scope = {
      kind: 'project',
      tenantId: TENANT_A,
      projectId: PROJECT_ID_2,
    };
    const result = await harness.commands.updateContract(
      envelope(
        { contractId: contract.entityId, expectedVersion: 1, title: 'Wrong project' },
        UPDATE_CONTRACT_COMMAND,
        otherProject,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
    }
    expect(harness.store.contracts[0]?.version).toBe(1);
    expect(harness.sink.events).toHaveLength(1);
  });
});

describe('optimistic concurrency (never silently overwritten)', () => {
  it('a stale expected version is a typed concurrency-conflict with the aggregate unchanged', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const v1 = mustSucceed(
      await harness.commands.updateContract(
        envelope(
          { contractId: contract.entityId, expectedVersion: 1, title: 'Amended once' },
          UPDATE_CONTRACT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'updateContract v1',
    );
    expect(v1.version).toBe(2);
    const stale = await harness.commands.updateContract(
      envelope(
        { contractId: contract.entityId, expectedVersion: 1, title: 'Amended from stale' },
        UPDATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('concurrency-conflict');
    }
    expect(harness.store.contracts[0]?.title).toBe('Amended once');
    expect(harness.store.contracts[0]?.version).toBe(2);
    expect(harness.sink.events).toHaveLength(2);
  });

  it('a stale change-event version on linkChangeReferences is equally typed', async () => {
    const harness = makeHarness();
    const contract = await recordObligation(harness, await createContract(harness), 'EARTHWORKS');
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          {
            contractId: contract.entityId,
            title: 'North platform additional excavation',
            changeType: 'modification',
            affectedObligationIds: [
              unwrap(parseEntityId(Object.keys(contract.obligations)[0] ?? '')),
            ],
          },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const linked = mustSucceed(
      await harness.commands.linkChangeReferences(
        envelope(
          {
            changeEventId: changeEvent.entityId,
            expectedVersion: 1,
            evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
          },
          LINK_CHANGE_REFERENCES_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'linkChangeReferences',
    );
    expect(linked.version).toBe(2);
    const stale = await harness.commands.linkChangeReferences(
      envelope(
        {
          changeEventId: changeEvent.entityId,
          expectedVersion: 1,
          evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
        },
        LINK_CHANGE_REFERENCES_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('concurrency-conflict');
    }
    expect(harness.store.changeEvents[0]?.evidenceLinks).toHaveLength(1);
  });
});

describe('the cross-entity link gate through the command path', () => {
  const harnessWithChangeEvent = async () => {
    const harness = makeHarness();
    const contract = await recordObligation(harness, await createContract(harness), 'EARTHWORKS');
    const obligationId = Object.keys(contract.obligations)[0];
    if (obligationId === undefined) throw new Error('obligation missing');
    return { harness, contract, obligationId: unwrap(parseEntityId(obligationId)) };
  };

  it('rejects an obligation link naming an obligation that does not exist in the contract', async () => {
    const { harness } = await harnessWithChangeEvent();
    const contract = harness.store.contracts[0];
    if (contract === undefined) throw new Error('contract missing');
    const result = await harness.commands.raiseChangeEvent(
      envelope(
        {
          contractId: contract.entityId,
          title: 'Bogus link',
          changeType: 'modification',
          affectedObligationIds: [FOREIGN_CONTRACT_ID],
        },
        RAISE_CHANGE_EVENT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('change-event-obligation-links-validated');
    }
    expect(harness.store.changeEvents).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(2);
  });

  it('accepts evidence, cost and schedule links as typed ids WITHOUT consulting any foreign store', async () => {
    const { harness, contract, obligationId } = await harnessWithChangeEvent();
    const result = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          {
            contractId: contract.entityId,
            title: 'North platform additional excavation',
            changeType: 'modification',
            affectedObligationIds: [obligationId],
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
    // Links are ids/refs ONLY: the referenced entities' data never appears.
    expect(result.evidenceLinks).toStrictEqual([
      { documentId: DOCUMENT_ID, revisionId: REVISION_ID },
    ]);
    expect(result.costImpactLinks).toStrictEqual([
      { budgetId: BUDGET_ID, costItemId: COST_ITEM_ID },
    ]);
    expect(result.scheduleImpactActivityIds).toStrictEqual([ACTIVITY_ID]);
    expect(result.affectedObligationIds).toStrictEqual([obligationId]);
  });

  it('appending a duplicate link through the command path is a typed invariant-violation', async () => {
    const { harness, contract, obligationId } = await harnessWithChangeEvent();
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          {
            contractId: contract.entityId,
            title: 'North platform additional excavation',
            changeType: 'modification',
            affectedObligationIds: [obligationId],
            evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
          },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const duplicate = await harness.commands.linkChangeReferences(
      envelope(
        {
          changeEventId: changeEvent.entityId,
          expectedVersion: changeEvent.version,
          evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
        },
        LINK_CHANGE_REFERENCES_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe('invariant-violation');
      expect(duplicate.error.details[0]?.code).toBe('change-event-links-unique');
    }
    expect(harness.store.changeEvents[0]?.evidenceLinks).toHaveLength(1);
    expect(harness.store.changeEvents[0]?.version).toBe(1);
  });
});

describe('the one-way lifecycles through the command path', () => {
  it('archive is one-way: a second archive is a typed invariant-violation', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const archived = mustSucceed(
      await harness.commands.archiveContract(
        envelope(
          { contractId: contract.entityId, expectedVersion: contract.version },
          ARCHIVE_CONTRACT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'archiveContract',
    );
    expect(archived.lifecycleStatus).toBe('archived');
    const again = await harness.commands.archiveContract(
      envelope(
        { contractId: contract.entityId, expectedVersion: archived.version },
        ARCHIVE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.details[0]?.code).toBe('contract-archive-is-terminal');
    }
    expect(harness.store.contracts[0]?.version).toBe(2);
  });

  it('an archived contract rejects updates, obligation recording and change-event raising', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const archived = mustSucceed(
      await harness.commands.archiveContract(
        envelope(
          { contractId: contract.entityId, expectedVersion: contract.version },
          ARCHIVE_CONTRACT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'archiveContract',
    );
    const update = await harness.commands.updateContract(
      envelope(
        { contractId: archived.entityId, expectedVersion: archived.version, title: 'x' },
        UPDATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.error.details[0]?.code).toBe('contract-archive-is-terminal');
    const raise = await harness.commands.raiseChangeEvent(
      envelope(
        { contractId: archived.entityId, title: 'Late change', changeType: 'addition' },
        RAISE_CHANGE_EVENT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(raise.ok).toBe(false);
    if (!raise.ok) expect(raise.error.details[0]?.code).toBe('contract-archive-is-terminal');
    expect(harness.store.changeEvents).toHaveLength(0);
  });

  it('the execution status moves forward only through updates', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const executed = mustSucceed(
      await harness.commands.updateContract(
        envelope(
          { contractId: contract.entityId, expectedVersion: contract.version, executionStatus: 'executed' },
          UPDATE_CONTRACT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'execute status',
    );
    const rewind = await harness.commands.updateContract(
      envelope(
        { contractId: executed.entityId, expectedVersion: executed.version, executionStatus: 'draft' },
        UPDATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(rewind.ok).toBe(false);
    if (!rewind.ok) {
      expect(rewind.error.details[0]?.code).toBe('contract-execution-status-moves-forward');
    }
    expect(harness.store.contracts[0]?.executionStatus).toBe('executed');
  });
});

describe('the change-order lifecycle through the command path', () => {
  it('submitted -> approved -> executed works and executing SUPERSEDES the change event', async () => {
    const harness = makeHarness();
    const contract = await recordObligation(harness, await createContract(harness), 'EARTHWORKS');
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          {
            contractId: contract.entityId,
            title: 'North platform additional excavation',
            changeType: 'modification',
          },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const order = mustSucceed(
      await harness.commands.submitChangeOrder(
        envelope(
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
    expect(order.status).toBe('submitted');
    const approved = mustSucceed(
      await harness.commands.approveChangeOrder(
        envelope(
          { changeOrderId: order.entityId, expectedVersion: order.version, reason: 'Verified' },
          APPROVE_CHANGE_ORDER_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'approveChangeOrder',
    );
    expect(approved.status).toBe('approved');
    const executed = mustSucceed(
      await harness.commands.executeChangeOrder(
        envelope(
          { changeOrderId: order.entityId, expectedVersion: approved.version },
          EXECUTE_CHANGE_ORDER_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'executeChangeOrder',
    );
    expect(executed.status).toBe('executed');
    // The supersession: the change event's proposed state is gone, the
    // executing order is recorded on it, and its version advanced once.
    const supersededEvent = harness.store.changeEvents[0];
    expect(supersededEvent?.status).toBe('superseded');
    expect(supersededEvent?.supersededByChangeOrderId).toBe(order.entityId);
    expect(supersededEvent?.version).toBe(2);
    // The contract and its obligations are UNTOUCHED by the execution: the
    // scope baseline is immutable rows + the superseded proposed change.
    expect(harness.store.contracts[0]?.version).toBe(2);
    expect(Object.keys(harness.store.contracts[0]?.obligations ?? {})).toHaveLength(1);
    // The executed envelope carries the causation id of ITS command.
    const executedEvent = harness.sink.events[harness.sink.events.length - 1];
    expect(executedEvent?.eventName).toBe('contracts.changeOrderExecuted');
  });

  it('executing a SUBMITTED order is typed-rejected (no decision bypass)', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          { contractId: contract.entityId, title: 'Undecided change', changeType: 'addition' },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const order = mustSucceed(
      await harness.commands.submitChangeOrder(
        envelope({ changeEventId: changeEvent.entityId, title: 'CO 02' }, SUBMIT_CHANGE_ORDER_COMMAND),
        COMMERCIAL_MANAGER,
      ),
      'submitChangeOrder',
    );
    const result = await harness.commands.executeChangeOrder(
      envelope(
        { changeOrderId: order.entityId, expectedVersion: order.version },
        EXECUTE_CHANGE_ORDER_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('change-order-lifecycle-is-one-way');
    }
    expect(harness.store.changeOrders[0]?.status).toBe('submitted');
    expect(harness.store.changeEvents[0]?.status).toBe('proposed');
  });

  it('a REJECTED order never mutates contracted scope and admits no further transition', async () => {
    const harness = makeHarness();
    const contract = await recordObligation(harness, await createContract(harness), 'EARTHWORKS');
    const before = JSON.stringify(harness.store.contracts[0]);
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          { contractId: contract.entityId, title: 'Rejected change', changeType: 'deletion' },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const order = mustSucceed(
      await harness.commands.submitChangeOrder(
        envelope(
          { changeEventId: changeEvent.entityId, title: 'CO 03', changeValue: null },
          SUBMIT_CHANGE_ORDER_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'submitChangeOrder',
    );
    const rejected = mustSucceed(
      await harness.commands.rejectChangeOrder(
        envelope(
          { changeOrderId: order.entityId, expectedVersion: order.version, reason: 'Out of scope' },
          REJECT_CHANGE_ORDER_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'rejectChangeOrder',
    );
    expect(rejected.status).toBe('rejected');
    // The rejected order mutated nothing but itself: the contract state is
    // byte-identical to before the order was even submitted.
    expect(JSON.stringify(harness.store.contracts[0])).toBe(before);
    // No transition exists out of 'rejected'.
    const approve = await harness.commands.approveChangeOrder(
      envelope(
        { changeOrderId: order.entityId, expectedVersion: rejected.version },
        APPROVE_CHANGE_ORDER_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(approve.ok).toBe(false);
    const execute = await harness.commands.executeChangeOrder(
      envelope(
        { changeOrderId: order.entityId, expectedVersion: rejected.version },
        EXECUTE_CHANGE_ORDER_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(execute.ok).toBe(false);
    if (!execute.ok) {
      expect(execute.error.details[0]?.code).toBe('change-order-lifecycle-is-one-way');
    }
    // The originating change event stays PROPOSED (its change never happened).
    expect(harness.store.changeEvents[0]?.status).toBe('proposed');
  });

  it('a superseded change event cannot originate a new change order', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          { contractId: contract.entityId, title: 'Executed change', changeType: 'modification' },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const order = mustSucceed(
      await harness.commands.submitChangeOrder(
        envelope({ changeEventId: changeEvent.entityId, title: 'CO 04' }, SUBMIT_CHANGE_ORDER_COMMAND),
        COMMERCIAL_MANAGER,
      ),
      'submitChangeOrder',
    );
    const approved = mustSucceed(
      await harness.commands.approveChangeOrder(
        envelope({ changeOrderId: order.entityId, expectedVersion: order.version }, APPROVE_CHANGE_ORDER_COMMAND),
        COMMERCIAL_MANAGER,
      ),
      'approveChangeOrder',
    );
    mustSucceed(
      await harness.commands.executeChangeOrder(
        envelope(
          { changeOrderId: order.entityId, expectedVersion: approved.version },
          EXECUTE_CHANGE_ORDER_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'executeChangeOrder',
    );
    const secondOrder = await harness.commands.submitChangeOrder(
      envelope({ changeEventId: changeEvent.entityId, title: 'CO 05' }, SUBMIT_CHANGE_ORDER_COMMAND),
      COMMERCIAL_MANAGER,
    );
    expect(secondOrder.ok).toBe(false);
    if (!secondOrder.ok) {
      expect(secondOrder.error.details[0]?.code).toBe('change-event-superseded');
    }
    expect(harness.store.changeOrders).toHaveLength(1);
  });
});

describe('claim references through the command path', () => {
  const executedOrderHarness = async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          { contractId: contract.entityId, title: 'Executed change', changeType: 'modification' },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const order = mustSucceed(
      await harness.commands.submitChangeOrder(
        envelope({ changeEventId: changeEvent.entityId, title: 'CO 06' }, SUBMIT_CHANGE_ORDER_COMMAND),
        COMMERCIAL_MANAGER,
      ),
      'submitChangeOrder',
    );
    const approved = mustSucceed(
      await harness.commands.approveChangeOrder(
        envelope({ changeOrderId: order.entityId, expectedVersion: order.version }, APPROVE_CHANGE_ORDER_COMMAND),
        COMMERCIAL_MANAGER,
      ),
      'approveChangeOrder',
    );
    const executed = mustSucceed(
      await harness.commands.executeChangeOrder(
        envelope(
          { changeOrderId: order.entityId, expectedVersion: approved.version },
          EXECUTE_CHANGE_ORDER_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'executeChangeOrder',
    );
    return { harness, executed };
  };

  it('pins a claim to evidence + an EXECUTED change order (immutable)', async () => {
    const { harness, executed } = await executedOrderHarness();
    const reference = mustSucceed(
      await harness.commands.referenceClaim(
        envelope(
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
    expect(reference.claimEntityId).toBe(CLAIM_ID);
    expect(reference.changeOrderId).toBe(executed.entityId);
    expect(reference.version).toBe(1);
    expect(harness.sink.events[harness.sink.events.length - 1]?.eventName).toBe(
      'contracts.claimReferenced',
    );
  });

  it('rejects a claim reference against a NON-executed change order (typed)', async () => {
    const harness = makeHarness();
    const contract = await createContract(harness);
    const changeEvent = mustSucceed(
      await harness.commands.raiseChangeEvent(
        envelope(
          { contractId: contract.entityId, title: 'Pending change', changeType: 'addition' },
          RAISE_CHANGE_EVENT_COMMAND,
        ),
        COMMERCIAL_MANAGER,
      ),
      'raiseChangeEvent',
    );
    const order = mustSucceed(
      await harness.commands.submitChangeOrder(
        envelope({ changeEventId: changeEvent.entityId, title: 'CO 07' }, SUBMIT_CHANGE_ORDER_COMMAND),
        COMMERCIAL_MANAGER,
      ),
      'submitChangeOrder',
    );
    const result = await harness.commands.referenceClaim(
      envelope(
        {
          claimEntityKind: 'claim',
          claimEntityId: CLAIM_ID,
          changeOrderId: order.entityId,
          documentId: DOCUMENT_ID,
          revisionId: REVISION_ID,
        },
        REFERENCE_CLAIM_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe(
        'claim-reference-requires-executed-change-order',
      );
    }
    expect(harness.store.claimReferences).toHaveLength(0);
  });

  it('a duplicate natural key (same claim, order, document, revision) is a typed conflict', async () => {
    const { harness, executed } = await executedOrderHarness();
    const payload = {
      claimEntityKind: 'claim',
      claimEntityId: CLAIM_ID,
      changeOrderId: executed.entityId,
      documentId: DOCUMENT_ID,
      revisionId: REVISION_ID,
    };
    mustSucceed(
      await harness.commands.referenceClaim(envelope(payload, REFERENCE_CLAIM_COMMAND), COMMERCIAL_MANAGER),
      'referenceClaim',
    );
    const duplicate = await harness.commands.referenceClaim(
      envelope(payload, REFERENCE_CLAIM_COMMAND),
      COMMERCIAL_MANAGER,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.details[0]?.code).toBe('claim-reference-already-exists');
    }
    expect(harness.store.claimReferences).toHaveLength(1);
  });
});

describe('the failing EventSink aborts the whole mutation', () => {
  it('a create whose sink fails leaves NO state and NO event behind', async () => {
    const store = createInMemoryContractsStore();
    let issued = 0;
    const commands = createContractsCommands({
      store,
      eventSink: failingEventSink('the ledger rejected the append'),
      now: () => NOW,
      newOpaqueId: () => {
        issued += 1;
        return `a${String(issued).padStart(15, '0')}`;
      },
    });
    const result = await commands.createContract(
      envelope(
        {
          title: 'Riverside design-build contract',
          owner: { entityKind: 'person', entityId: PERSON_ID },
          contractor: { entityKind: 'company', entityId: COMPANY_ID },
          contractValue: { amount: 12_500_000, currency: 'USD' },
        },
        CREATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    expect(store.contracts).toHaveLength(0);
  });

  it('a mutation whose sink fails leaves the aggregate UNCHANGED', async () => {
    const store = createInMemoryContractsStore();
    let issued = 0;
    const deps = (eventSink: unknown): ContractsCommandDeps => ({
      store,
      eventSink: eventSink as ContractsCommandDeps['eventSink'],
      now: () => NOW,
      newOpaqueId: () => {
        issued += 1;
        return `a${String(issued).padStart(15, '0')}`;
      },
    });
    const good = createContractsCommands(deps(createInMemoryEventSink()));
    const contract = mustSucceed(
      await good.createContract(
        envelope(
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
    const failing = createContractsCommands(deps(failingEventSink('the ledger rejected the append')));
    const result = await failing.updateContract(
      envelope(
        { contractId: contract.entityId, expectedVersion: 1, title: 'Never lands' },
        UPDATE_CONTRACT_COMMAND,
      ),
      COMMERCIAL_MANAGER,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('event sink rejected the append');
    }
    expect(store.contracts[0]?.title).toBe('Riverside design-build contract');
    expect(store.contracts[0]?.version).toBe(1);
  });
});
