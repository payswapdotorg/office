import { describe, expect, it } from 'vitest';
import { ok } from '@office/domain-kernel';
import { coordinateOf, providerObjectId, providerVersion, sourceRef, syncCursorToken } from '@office/adapters-sdk';
import type { Adapter, SyncResult } from '@office/adapters-sdk';
import { createFinanceTranslator, resolveFinanceReference } from './mappings';
import { createInMemoryProviderVersionLedger, runFinanceSync } from './sync';
import { createErpProviderStore } from './provider-fixture';
import { createFinanceAdapter } from './adapter';
import {
  ACCOUNT_OBJECT_KIND,
  FINANCE_ADAPTER_KIND,
  FINANCE_SYSTEM_ID,
  INVOICE_OBJECT_KIND,
} from './vocabulary';
import {
  BUDGET_REF_ID,
  COMMITMENT_REF_ID,
  COST_ITEM_REF_ID,
  INVOICE_REF_ID,
  NOW_1,
  NOW_2,
  PROJECT_ID,
  TENANT_A,
  TENANT_B,
  commandKey,
  entity,
  engine,
  financeAuthorization,
  unwrap,
  version,
} from './test-support';

// OFF-024 — THE named acceptance: SOURCE VERSION MAPPING + NON-DUPLICATING
// financial synchronization. The same provider object version NEVER proposes
// a canonical command twice — whatever path it arrives through (a sync
// re-delivery, a cursor restart, an at-least-once webhook redelivery — the
// webhook suite proves that path) — and EVERY duplicate attempt is counted
// and typed-deduplicated. Version bumps DO propose updates; the mapping table
// resolves the same canonical ids deterministically; and the whole engine is
// deterministic (same fixture + same injected clock/id suppliers → identical
// reports).

/** The source ref of one fixture invoice at one version. */
const sourceOf = (objectId: string, objectVersion: string) =>
  sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectType: INVOICE_OBJECT_KIND,
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

/** The source ref of one fixture account at one version. */
const sourceOfAccount = (objectId: string, objectVersion: string) =>
  sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectType: ACCOUNT_OBJECT_KIND,
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

/** One invoice stream of N invoices against one commitment. */
const invoiceStore = (count: number) => {
  const store = createErpProviderStore();
  for (let n = 1; n <= count; n += 1) {
    store.putInvoice({
      objectId: `inv-${n}`,
      number: `INV-2026-0${300 + n}`,
      description: `Earthworks invoice ${n}`,
      currency: 'EUR',
      commitmentRef: COMMITMENT_REF_ID,
      issuedOn: NOW_1,
      dueOn: NOW_2,
      lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
      updatedAt: NOW_1,
    });
  }
  return store;
};

/** The full reference chain: account → cost code → commitment → invoice → payment. */
const referenceChainStore = () => {
  const store = createErpProviderStore();
  store.putAccount({
    objectId: 'acc-1',
    code: '5010',
    name: 'Earthworks costs',
    currency: 'EUR',
    projectRef: PROJECT_ID,
    updatedAt: NOW_1,
  });
  store.putCostCode({
    objectId: 'cc-1',
    code: '0310',
    description: 'Bulk excavation',
    unit: 'm3',
    budgetRef: BUDGET_REF_ID,
    quantityMilli: 1_500,
    unitRateMinor: 2_400,
    updatedAt: NOW_1,
  });
  store.putCommitment({
    objectId: 'po-1',
    number: 'PO-2026-014',
    commitmentKind: 'purchase-order',
    description: 'Phase one earthworks package',
    currency: 'EUR',
    budgetRef: BUDGET_REF_ID,
    lines: [
      { costItemRef: COST_ITEM_REF_ID, description: 'Bulk excavation', amountMinor: 3_600_000 },
    ],
    updatedAt: NOW_1,
  });
  store.putInvoice({
    objectId: 'inv-1',
    number: 'INV-2026-0301',
    description: 'Earthworks invoice 1',
    currency: 'EUR',
    commitmentRef: COMMITMENT_REF_ID,
    issuedOn: NOW_1,
    dueOn: NOW_2,
    lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
    updatedAt: NOW_1,
  });
  store.putPayment({
    objectId: 'pay-1',
    invoiceRef: INVOICE_REF_ID,
    reference: 'TRC-8841',
    amountMinor: 250_000,
    paidAt: NOW_2,
    updatedAt: NOW_1,
  });
  return store;
};

describe('finance source-version-mapped non-duplicating sync (OFF-024, THE acceptance)', () => {
  it('THE acceptance: the same invoice version synced twice (and again) → exactly ONE canonical proposal, every duplicate counted', async () => {
    const store = invoiceStore(1);
    const { deps, ledger } = engine({ now: NOW_1 });
    const request = {
      authorization: financeAuthorization(),
      adapter: createFinanceAdapter({ store }),
      translator: createFinanceTranslator(),
      systemId: FINANCE_SYSTEM_ID,
      objectKinds: [INVOICE_OBJECT_KIND],
      limit: 10,
    };

    // 1. The first sync proposes exactly ONE canonical command for inv-1@v1.
    const first = unwrap(await runFinanceSync(request, deps));
    expect(first.kind).toBe('finance-sync-report');
    expect(first.counts).toStrictEqual({
      snapshotsObserved: 1,
      proposals: 1,
      mappedCreated: 1,
      appliedUpdates: 0,
      appliedDeletions: 0,
      duplicateDeduplicated: 0,
      replayNoOps: 0,
      canonicalAhead: 0,
      conflictsDetected: 0,
      orphanDeletionsSkipped: 0,
    });
    expect(first.commands).toHaveLength(1);
    const command = first.commands[0];
    expect(command?.commandName).toBe('cost.recordInvoice');
    const proposalKey = command?.idempotencyKey;

    // 2. THE same version synced AGAIN: a counted typed no-op — no second
    //    proposal, ever.
    const second = unwrap(await runFinanceSync(request, deps));
    expect(second.counts.proposals).toBe(0);
    expect(second.counts.duplicateDeduplicated).toBe(1);
    expect(second.counts.snapshotsObserved).toBe(1);
    expect(second.commands).toStrictEqual([]);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0]?.kind).toBe('duplicate-version-observation');
    expect(second.duplicates[0]?.reason).toBe('ledger');
    expect(second.duplicates[0]?.snapshot.source.objectId).toBe('inv-1');
    expect(second.duplicates[0]?.snapshot.source.version).toBe('v1');

    // 3. And AGAIN: a third duplicate attempt — counted, still no proposal.
    const third = unwrap(await runFinanceSync(request, deps));
    expect(third.counts.proposals).toBe(0);
    expect(third.counts.duplicateDeduplicated).toBe(1);

    // 4. THE counting + exactly-one proof: ONE ledger entry for the source
    //    version, observed three times, carrying the ONE proposal key; across
    //    ALL three runs exactly one command with that key exists.
    const entries = await ledger.listByCoordinate(
      TENANT_A,
      coordinateOf(sourceOf('inv-1', 'v1')),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.observationCount).toBe(3);
    expect(entries[0]?.proposalKey).toBe(proposalKey);
    const everyCommand = [...first.commands, ...second.commands, ...third.commands];
    expect(everyCommand.filter((c) => c.idempotencyKey === proposalKey)).toHaveLength(1);
  });

  it('THE mapping table resolves the SAME canonical ids deterministically across re-syncs', async () => {
    const store = invoiceStore(3);
    const { deps } = engine({ now: NOW_1 });
    const request = {
      authorization: financeAuthorization(),
      adapter: createFinanceAdapter({ store }),
      translator: createFinanceTranslator(),
      systemId: FINANCE_SYSTEM_ID,
      objectKinds: [INVOICE_OBJECT_KIND],
      limit: 10,
    };
    const first = unwrap(await runFinanceSync(request, deps));
    expect(first.counts.mappedCreated).toBe(3);

    // The ids the first run issued (deterministic supplier order).
    const resolveAll = () =>
      Promise.all(
        ['inv-1', 'inv-2', 'inv-3'].map((objectId) =>
          resolveFinanceReference({
            mappings: deps.mappings,
            tenantId: TENANT_A,
            coordinate: coordinateOf(sourceOf(objectId, 'v1')),
          }),
        ),
      );
    expect((await resolveAll()).map((entry) => unwrap(entry).entityId)).toStrictEqual([
      entity(1),
      entity(2),
      entity(3),
    ]);

    // Two full re-syncs later, the mapping table resolves the SAME canonical
    // ids — never a second id, never a re-issue.
    unwrap(await runFinanceSync(request, deps));
    unwrap(await runFinanceSync(request, deps));
    expect((await resolveAll()).map((entry) => unwrap(entry).entityId)).toStrictEqual([
      entity(1),
      entity(2),
      entity(3),
    ]);
  });

  it('version bumps → update proposals; the bumped version then never proposes twice', async () => {
    const store = createErpProviderStore();
    store.putAccount({
      objectId: 'acc-1',
      code: '5010',
      name: 'Earthworks costs',
      currency: 'EUR',
      projectRef: PROJECT_ID,
      updatedAt: NOW_1,
    });
    const world = engine({ now: NOW_1 });
    const request = {
      authorization: financeAuthorization(),
      adapter: createFinanceAdapter({ store }),
      translator: createFinanceTranslator(),
      systemId: FINANCE_SYSTEM_ID,
      objectKinds: [ACCOUNT_OBJECT_KIND],
      limit: 10,
    };
    const initial = unwrap(await runFinanceSync(request, world.deps));
    expect(initial.counts.mappedCreated).toBe(1);
    expect(initial.commands[0]?.commandName).toBe('cost.createBudget');

    // The create command executed canonically (the budget aggregate is at
    // v1, quiet at the synchronized point)…
    world.versions.set(entity(1), version(1));

    // …then the provider bumps the account to v2 (a rename).
    world.advanceClockTo(NOW_2);
    store.renameAccount('acc-1', { name: 'Earthworks costs (renamed)', updatedAt: NOW_2 });
    const update = unwrap(await runFinanceSync(request, world.deps));
    expect(update.counts.appliedUpdates).toBe(1);
    expect(update.counts.proposals).toBe(1);
    expect(update.commands).toHaveLength(1);
    expect(update.commands[0]?.commandName).toBe('cost.reviseBudget');
    expect(update.commands[0]?.payload).toMatchObject({
      budgetId: entity(1),
      expectedVersion: 1,
    });
    const updateKey = update.commands[0]?.idempotencyKey;
    expect(updateKey).not.toBe(initial.commands[0]?.idempotencyKey);

    // The bumped version re-delivered: a counted typed no-op — the update
    // proposes exactly once per source version too. The ledger holds the
    // version HISTORY of the coordinate (v1 proposed the create, v2 the
    // update), each version exactly once, with v2 observed twice (the update
    // + its replay) and still carrying the ONE update key.
    const replay = unwrap(await runFinanceSync(request, world.deps));
    expect(replay.counts.proposals).toBe(0);
    expect(replay.counts.duplicateDeduplicated).toBe(1);
    const entries = await world.ledger.listByCoordinate(
      TENANT_A,
      coordinateOf(sourceOfAccount('acc-1', 'v2')),
    );
    expect(entries.map((entry) => entry.version)).toStrictEqual(['v1', 'v2']);
    const v2Entry = await world.ledger.find(
      TENANT_A,
      coordinateOf(sourceOfAccount('acc-1', 'v2')),
      providerVersion('v2'),
    );
    if (v2Entry === null) {
      throw new Error('expected the ledger to hold the acc-1 v2 entry');
    }
    expect(v2Entry.proposalKey).toBe(updateKey);
    expect(v2Entry.observationCount).toBe(2);
  });

  it('cursor restart re-processes nothing: the un-checkpointed tail deduplicates with zero commands', async () => {
    const store = invoiceStore(3);
    const world = engine({ now: NOW_1 });
    const request = {
      authorization: financeAuthorization(),
      adapter: createFinanceAdapter({ store }),
      translator: createFinanceTranslator(),
      systemId: FINANCE_SYSTEM_ID,
      objectKinds: [INVOICE_OBJECT_KIND],
      limit: 2,
    };
    // 3 invoices paged at 2/page: page 1 checkpoints at position 2, page 2
    // delivers the tail and exhausts the stream.
    const initial = unwrap(await runFinanceSync(request, world.deps));
    expect(initial.counts.mappedCreated).toBe(3);
    expect(initial.counts.duplicateDeduplicated).toBe(0);
    expect(initial.commands).toHaveLength(3);
    expect(initial.streams[0]?.runs).toHaveLength(2);

    // A restart from the persisted cursor (the runtime's crash-recovery
    // point): the un-checkpointed tail (inv-3) comes back — and the version
    // ledger turns it into a counted typed no-op. Nothing re-processes into
    // a command.
    const restart = unwrap(await runFinanceSync(request, world.deps));
    expect(restart.counts.proposals).toBe(0);
    expect(restart.counts.duplicateDeduplicated).toBe(1);
    expect(restart.counts.snapshotsObserved).toBe(1);
    expect(restart.commands).toStrictEqual([]);
    expect(restart.streams[0]?.applications).toStrictEqual([]);
    expect(restart.duplicates[0]?.snapshot.source.objectId).toBe('inv-3');

    // A SECOND restart: still nothing (the ledger entry persists).
    const restartAgain = unwrap(await runFinanceSync(request, world.deps));
    expect(restartAgain.commands).toStrictEqual([]);
    expect(restartAgain.counts.duplicateDeduplicated).toBe(1);
  });

  it('counts an intra-page duplicate (a hostile page re-delivering one version twice)', async () => {
    const store = invoiceStore(2);
    const world = engine({ now: NOW_1 });
    const base = createFinanceAdapter({ store });
    // A hostile Adapter: the first snapshot of every page comes back TWICE
    // (structurally equal, distinct values — an at-least-once provider).
    const duplicating: Adapter = {
      kind: base.kind,
      capabilities: base.capabilities,
      connect: (request) => base.connect(request),
      healthCheck: (request) => base.healthCheck(request),
      disconnect: (request) => base.disconnect(request),
      async sync(request) {
        const pulled = await base.sync(request);
        if (!pulled.ok) return pulled;
        const [head, ...tail] = pulled.value.snapshots;
        const doubled =
          head === undefined ? [] : [{ ...head, source: { ...head.source } }, head];
        return ok({
          ...pulled.value,
          snapshots: [...doubled, ...tail],
        } satisfies SyncResult);
      },
    };
    const report = unwrap(
      await runFinanceSync(
        {
          authorization: financeAuthorization(),
          adapter: duplicating,
          translator: createFinanceTranslator(),
          systemId: FINANCE_SYSTEM_ID,
          objectKinds: [INVOICE_OBJECT_KIND],
          limit: 10,
        },
        world.deps,
      ),
    );
    // The FIRST occurrence was applied (one create proposal); the SECOND was
    // tallied as an intra-page duplicate — typed-deduplicated, counted.
    expect(report.counts.mappedCreated).toBe(2);
    expect(report.counts.proposals).toBe(2);
    expect(report.counts.duplicateDeduplicated).toBe(1);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]?.reason).toBe('intra-page');
    expect(report.duplicates[0]?.snapshot.source.objectId).toBe('inv-1');
    // The ledger entry for inv-1@v1 counts BOTH observations.
    const entries = await world.ledger.listByCoordinate(
      TENANT_A,
      coordinateOf(sourceOf('inv-1', 'v1')),
    );
    expect(entries[0]?.observationCount).toBe(2);
  });

  it('records a BOTH-sides-moved divergence as an explicit conflict (both sides, no command)', async () => {
    const store = invoiceStore(1);
    const world = engine({ now: NOW_1 });
    const request = {
      authorization: financeAuthorization(),
      adapter: createFinanceAdapter({ store }),
      translator: createFinanceTranslator(),
      systemId: FINANCE_SYSTEM_ID,
      objectKinds: [INVOICE_OBJECT_KIND],
      limit: 10,
    };
    unwrap(await runFinanceSync(request, world.deps));
    // An office-side edit lands on the invoice aggregate (canonical moved)…
    world.versions.set(entity(1), version(2));
    // …and the ERP revises the same invoice (provider moved) — the fixture's
    // divergence scenario.
    world.advanceClockTo(NOW_2);
    store.reviseInvoice('inv-1', {
      lines: [{ description: 'Phase one earthworks (revised)', amountMinor: 312_500 }],
      updatedAt: NOW_2,
    });
    const divergent = unwrap(await runFinanceSync(request, world.deps));
    expect(divergent.counts.conflictsDetected).toBe(1);
    expect(divergent.counts.proposals).toBe(0);
    expect(divergent.commands).toStrictEqual([]);
    expect(divergent.conflicts).toHaveLength(1);
    expect(divergent.conflicts[0]).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'erp-finance',
        systemId: 'erp-instance-01',
        objectType: 'invoice',
        objectId: 'inv-1',
        version: 'v2',
      },
      canonical: { entityKind: 'invoice', entityId: entity(1) },
      canonicalVersion: 2,
      state: 'detected',
      resolution: null,
    });
    // The conflict version proposed NOTHING (proposalKey null): re-detection
    // is idempotent by construction (the same derived conflict id).
    const conflictId = divergent.conflicts[0]?.conflictId;
    const reRun = unwrap(await runFinanceSync(request, world.deps));
    expect(reRun.counts.conflictsDetected).toBe(1);
    expect(reRun.conflicts[0]?.conflictId).toBe(conflictId);
    expect(reRun.commands).toStrictEqual([]);
  });

  it('syncs every declared stream in the finance family order (references before commercial)', async () => {
    const store = referenceChainStore();
    const world = engine({ now: NOW_1 });
    const request = {
      authorization: financeAuthorization(),
      adapter: createFinanceAdapter({ store }),
      translator: createFinanceTranslator(),
      systemId: FINANCE_SYSTEM_ID,
      limit: 10,
    };
    const report = unwrap(await runFinanceSync(request, world.deps));
    expect(report.streams.map((stream) => stream.objectKind)).toStrictEqual([
      'account',
      'cost-code',
      'commitment',
      'invoice',
      'payment',
    ]);
    expect(report.counts).toStrictEqual({
      snapshotsObserved: 5,
      proposals: 5,
      mappedCreated: 5,
      appliedUpdates: 0,
      appliedDeletions: 0,
      duplicateDeduplicated: 0,
      replayNoOps: 0,
      canonicalAhead: 0,
      conflictsDetected: 0,
      orphanDeletionsSkipped: 0,
    });
    expect(report.commands.map((command) => command.commandName)).toStrictEqual([
      'cost.createBudget',
      'cost.recordCostItem',
      'cost.createCommitment',
      'cost.recordInvoice',
      'cost.referencePayment',
    ]);
    // The full re-run deduplicates all five source versions at once.
    const reRun = unwrap(await runFinanceSync(request, world.deps));
    expect(reRun.counts.duplicateDeduplicated).toBe(5);
    expect(reRun.counts.proposals).toBe(0);
    expect(reRun.commands).toStrictEqual([]);
  });

  it('is deterministic: same fixture + same injected clock/ids → identical reports (run twice)', async () => {
    const runWorld = () => {
      const store = referenceChainStore();
      const world = engine({ now: NOW_1 });
      return runFinanceSync(
        {
          authorization: financeAuthorization(),
          adapter: createFinanceAdapter({ store }),
          translator: createFinanceTranslator(),
          systemId: FINANCE_SYSTEM_ID,
          limit: 2,
        },
        world.deps,
      );
    };
    const first = unwrap(await runWorld());
    const second = unwrap(await runWorld());
    expect(first).toStrictEqual(second);
  });

  it('fails closed on a provider that never exhausts (the per-stream page bound)', async () => {
    const store = invoiceStore(1);
    const base = createFinanceAdapter({ store });
    let position = 0;
    const stuck: Adapter = {
      kind: base.kind,
      capabilities: base.capabilities,
      connect: (request) => base.connect(request),
      healthCheck: (request) => base.healthCheck(request),
      disconnect: (request) => base.disconnect(request),
      async sync() {
        position += 1;
        return ok({
          kind: 'sync-result',
          snapshots: [],
          nextCursorToken: syncCursorToken(String(position)),
          checkpoint: { itemsObserved: position, lastProviderVersion: providerVersion('v1') },
          hasMore: true,
        } satisfies SyncResult);
      },
    };
    const world = engine({ now: NOW_1 });
    const exhausted = await runFinanceSync(
      {
        authorization: financeAuthorization(),
        adapter: stuck,
        translator: createFinanceTranslator(),
        systemId: FINANCE_SYSTEM_ID,
        objectKinds: [INVOICE_OBJECT_KIND],
        limit: 10,
      },
      world.deps,
    );
    expect(exhausted.ok).toBe(false);
    if (exhausted.ok) return;
    expect(exhausted.error.code).toBe('invariant-violation');
    expect(exhausted.error.details[0]?.code).toBe('finance-sync-page-limit');
  });

  it("propagates the SDK engine's typed limit validation", async () => {
    const store = invoiceStore(1);
    const world = engine({ now: NOW_1 });
    const invalid = await runFinanceSync(
      {
        authorization: financeAuthorization(),
        adapter: createFinanceAdapter({ store }),
        translator: createFinanceTranslator(),
        systemId: FINANCE_SYSTEM_ID,
        objectKinds: [INVOICE_OBJECT_KIND],
        limit: 0,
      },
      world.deps,
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.details[0]?.code).toBe('sync-limit-invalid');
  });
});

// ---- THE version ledger unit discipline -------------------------------------

describe('the provider version ledger (OFF-024)', () => {
  it('upgrades a null proposal key to the recorded one and counts re-observations', async () => {
    const ledger = createInMemoryProviderVersionLedger();
    const coordinate = coordinateOf(sourceOf('inv-9', 'v1'));
    // A conflict/no-op observation records NO proposal key…
    const first = unwrap(
      await ledger.observe({
        tenantId: TENANT_A,
        coordinate,
        version: providerVersion('v1'),
        proposalKey: null,
        observedAt: NOW_1,
      }),
    );
    expect(first.proposalKey).toBeNull();
    expect(first.observationCount).toBe(1);
    // …and a later observation upgrades it (never reverts).
    const second = unwrap(
      await ledger.observe({
        tenantId: TENANT_A,
        coordinate,
        version: providerVersion('v1'),
        proposalKey: commandKey(1),
        observedAt: NOW_2,
      }),
    );
    expect(second.proposalKey).toBe(commandKey(1));
    expect(second.observationCount).toBe(2);
    expect(second.firstObservedAt).toBe(NOW_1);
    expect(second.lastObservedAt).toBe(NOW_2);
    // A null re-observation never reverts the recorded key.
    const third = unwrap(
      await ledger.observe({
        tenantId: TENANT_A,
        coordinate,
        version: providerVersion('v1'),
        proposalKey: null,
        observedAt: NOW_2,
      }),
    );
    expect(third.proposalKey).toBe(commandKey(1));
    expect(third.observationCount).toBe(3);
  });

  it('typed-rejects a divergent proposal key for the same source version (determinism guard)', async () => {
    const ledger = createInMemoryProviderVersionLedger();
    const coordinate = coordinateOf(sourceOf('inv-9', 'v1'));
    unwrap(
      await ledger.observe({
        tenantId: TENANT_A,
        coordinate,
        version: providerVersion('v1'),
        proposalKey: commandKey(1),
        observedAt: NOW_1,
      }),
    );
    const divergent = await ledger.observe({
      tenantId: TENANT_A,
      coordinate,
      version: providerVersion('v1'),
      proposalKey: commandKey(2),
      observedAt: NOW_2,
    });
    expect(divergent.ok).toBe(false);
    if (divergent.ok) return;
    expect(divergent.error.code).toBe('invariant-violation');
    expect(divergent.error.details[0]?.code).toBe('version-ledger-key-divergence');
  });

  it('scopes ledger entries by tenant (A12: a foreign tenant sees absence)', async () => {
    const ledger = createInMemoryProviderVersionLedger();
    const coordinate = coordinateOf(sourceOf('inv-9', 'v1'));
    unwrap(
      await ledger.observe({
        tenantId: TENANT_A,
        coordinate,
        version: providerVersion('v1'),
        proposalKey: commandKey(1),
        observedAt: NOW_1,
      }),
    );
    expect(await ledger.find(TENANT_B, coordinate, providerVersion('v1'))).toBeNull();
    expect(await ledger.listByCoordinate(TENANT_B, coordinate)).toStrictEqual([]);
  });
});
