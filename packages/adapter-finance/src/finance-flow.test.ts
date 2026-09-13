import { describe, expect, it } from 'vitest';
import {
  coordinateOf,
  providerObjectId,
  providerVersion,
  sourceCorrelationId,
  sourceRef,
  syncIdempotencyKey,
} from '@office/adapters-sdk';
import type { Adapter } from '@office/adapters-sdk';
import { parseEntityKind } from '@office/contracts';
import type { EntityRef } from '@office/contracts';
import {
  ACCOUNT_OBJECT_KIND,
  COMMITMENT_OBJECT_KIND,
  COST_CODE_OBJECT_KIND,
  FINANCE_ADAPTER_KIND,
  FINANCE_SYSTEM_ID,
  INVOICE_OBJECT_KIND,
  PAYMENT_OBJECT_KIND,
} from './vocabulary';
import { createErpProviderStore } from './provider-fixture';
import { createFinanceAdapter } from './adapter';
import { createFinanceTranslator, resolveFinanceReference } from './mappings';
import { runFinanceSync } from './sync';
import { reconcileFinanceBalances } from './reconciliation';
import type { FinanceReconciliationReport } from './reconciliation';
import {
  amountMismatchConflictsOf,
  createInMemoryFinancialConflictStore,
  resolveFinancialConflict,
} from './conflict-discipline';
import type { FinancialConflict } from './conflict-discipline';
import { createErpWebhookVerifier, ingestErpWebhook } from './webhook-ingest';
import type { ErpWebhookOutcome } from './webhook-ingest';
import {
  BUDGET_REF_ID,
  COMMITMENT_REF_ID,
  COST_ITEM_REF_ID,
  INVOICE_REF_ID,
  NOW_1,
  NOW_2,
  NOW_3,
  NOW_4,
  PROJECT_ID,
  TENANT_A,
  entity,
  engine,
  financeAuthorization,
  invoiceBalanceFactsOf,
  unwrap,
  version,
} from './test-support';

// OFF-024 — THE end-to-end finance acceptance: SOURCE VERSION MAPPING +
// NON-DUPLICATING financial synchronization over the full financial reference
// chain (account → cost code → commitment → invoice → payment).
//
// The scenario walks one deterministic ERP↔office world through the whole
// commercial lifecycle:
//
//   1. the seeded provider chain syncs in the finance family order — five
//      canonical create proposals (one per source version), each keyed by the
//      SDK's SourceRef-derived idempotency key;
//   2. the SAME versions come back — a full re-sync AND a duplicate webhook
//      delivery of the same invoice version — and exactly ONE canonical
//      proposal exists for that version across ALL paths, with every
//      duplicate attempt counted and typed-deduplicated;
//   3. a provider version bump proposes exactly ONE update; its re-delivery
//      through both paths never proposes twice;
//   4. the mapping table resolves the SAME office-issued canonical ids
//      deterministically across re-syncs (A10: provider ids are never
//      primary keys — the mapping IS the binding);
//   5. a cursor restart re-processes nothing into commands (the positional
//      token plus the version ledger);
//   6. a both-sides-moved divergence is an explicit conflict, never a silent
//      last-write-wins — and the reconciliation surface projects the amount
//      mismatch into typed discrepancy records carrying BOTH sides, which
//      become explicit FinancialConflict records resolved ONLY through the
//      explicit typed command path.
//
// The whole scenario is a pure function of the injected state (fixed clock
// instants, sequential office-issued id supplier, deterministic fixture
// mutations): run-twice → identical reports, commands, conflicts, and
// reconciliations.

/** The provider object kinds of the reference chain, by family name. */
const OBJECT_KINDS = {
  account: ACCOUNT_OBJECT_KIND,
  'cost-code': COST_CODE_OBJECT_KIND,
  commitment: COMMITMENT_OBJECT_KIND,
  invoice: INVOICE_OBJECT_KIND,
  payment: PAYMENT_OBJECT_KIND,
} as const;

/** The source ref of one fixture object at one version. */
const sourceOf = (
  objectType: keyof typeof OBJECT_KINDS,
  objectId: string,
  objectVersion: string,
) =>
  sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectType: OBJECT_KINDS[objectType],
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

const invoiceRef = (n: number): EntityRef => ({
  entityKind: unwrap(parseEntityKind('invoice')),
  entityId: entity(n),
});

/**
 * THE end-to-end scenario, as a pure function of injected state. Every phase
 * runs against the same world; the fixed clock advances once per phase.
 */
const scenario = async () => {
  // ---- the world -----------------------------------------------------------
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

  const world = engine({ now: NOW_1 });
  const adapter: Adapter = createFinanceAdapter({ store });
  const translator = createFinanceTranslator();
  const authorization = financeAuthorization();
  const runAllStreams = (limit = 10) =>
    runFinanceSync({ authorization, adapter, translator, systemId: FINANCE_SYSTEM_ID, limit }, world.deps);
  const runInvoiceStream = () =>
    runFinanceSync(
      {
        authorization,
        adapter,
        translator,
        systemId: FINANCE_SYSTEM_ID,
        objectKinds: [INVOICE_OBJECT_KIND],
        limit: 10,
      },
      world.deps,
    );
  const ingest = (eventKind: 'created' | 'updated' | 'deleted', objectId: string) =>
    ingestErpWebhook({
      authorization,
      adapter,
      translator,
      verifier: createErpWebhookVerifier(),
      deps: world.deps,
      raw: store.emitWebhook(eventKind, objectId),
    });

  // ---- 1. the first sync: the whole chain, in the finance family order ----
  const first = unwrap(await runAllStreams());
  const createCommands = [...first.commands];

  // The host executes the five creates (the runtime's Action Gateway; the
  // canonical aggregates land at v1). Entity ids follow the injected
  // supplier's deterministic order: account 1, cost code 2, commitment 3,
  // invoice 4, payment 5.
  for (const n of [1, 2, 3, 4, 5]) {
    world.versions.set(entity(n), version(1));
  }

  // ---- 2. THE non-duplication: same versions through BOTH paths -----------
  const reSync = unwrap(await runAllStreams());
  const duplicateWebhook: ErpWebhookOutcome = unwrap(await ingest('created', 'inv-1'));

  // ---- 3. the version bump: exactly one update proposal --------------------
  world.advanceClockTo(NOW_2);
  store.renameAccount('acc-1', { name: 'Earthworks costs (renamed)', updatedAt: NOW_2 });
  const update = unwrap(await runAllStreams());
  const updateCommands = [...update.commands];
  // The host executes the budget revision (the account's canonical v2).
  world.versions.set(entity(1), version(2));
  // The bumped version re-delivered through the webhook path: deduplicated.
  const updateWebhook: ErpWebhookOutcome = unwrap(await ingest('updated', 'acc-1'));

  // ---- 4. the mapping table resolves the same canonical ids ---------------
  const resolveAll = () =>
    Promise.all(
      (
        [
          ['account', 'acc-1'],
          ['cost-code', 'cc-1'],
          ['commitment', 'po-1'],
          ['invoice', 'inv-1'],
          ['payment', 'pay-1'],
        ] as const
      ).map(([objectType, objectId]) =>
        resolveFinanceReference({
          mappings: world.deps.mappings,
          tenantId: TENANT_A,
          coordinate: coordinateOf(sourceOf(objectType, objectId, 'v1')),
        }),
      ),
    );
  const resolvedIds = (await resolveAll()).map((entry) => unwrap(entry).entityId);

  // ---- 5. the divergence: BOTH sides moved (material commercial state) ----
  // An office-side edit lands on the invoice aggregate (canonical → v2)…
  world.advanceClockTo(NOW_3);
  world.versions.set(entity(4), version(2));
  // …and the ERP revises the same invoice (provider → v2, amount 312_500).
  store.reviseInvoice('inv-1', {
    lines: [{ description: 'Phase one earthworks (revised)', amountMinor: 312_500 }],
    updatedAt: NOW_3,
  });
  const divergent = unwrap(await runInvoiceStream());
  const reDetected = unwrap(await runInvoiceStream());

  // ---- 6. the reconciliation + the explicit financial conflict -------------
  // The canonical summaries the runtime (OFF-037) composes from the canonical
  // state it owns: the invoice recorded 250_000 at the last synchronized
  // source (inv-1@v1) and its aggregate has since moved to v2.
  const canonicalSummaries = [
    {
      canonical: invoiceRef(4),
      source: sourceOf('invoice', 'inv-1', 'v1'),
      recordedAmountMinor: 250_000,
      canonicalVersion: version(2),
    },
  ];
  const reconcileNow = (): FinanceReconciliationReport =>
    unwrap(
      reconcileFinanceBalances({
        tenantId: TENANT_A,
        asOf: NOW_4,
        provider: invoiceBalanceFactsOf(store),
        canonical: canonicalSummaries,
      }),
    );
  const reconciliation = reconcileNow();
  const financialConflicts = amountMismatchConflictsOf(reconciliation, {
    detectedAt: NOW_4,
    detectedBy: authorization.context.actor,
  });
  const conflictStore = createInMemoryFinancialConflictStore();
  for (const conflict of financialConflicts) {
    unwrap(await conflictStore.append(conflict));
  }
  // Re-detection (the identical report) re-appends the SAME records: the
  // derived ids make the append idempotent — no auto-resolution happened.
  const reconciliationAgain = reconcileNow();
  const financialConflictsAgain = amountMismatchConflictsOf(reconciliationAgain, {
    detectedAt: NOW_4,
    detectedBy: authorization.context.actor,
  });
  for (const conflict of financialConflictsAgain) {
    unwrap(await conflictStore.append(conflict));
  }
  const detectedConflict: FinancialConflict = financialConflicts[0] as FinancialConflict;
  // The store at this point — BEFORE any resolution — holds the detected
  // record (detection never resolves: the snapshot the discipline test
  // asserts against).
  const detectedStored = await conflictStore.findById(TENANT_A, detectedConflict.conflictId);

  // ---- 7. the ONLY resolution path: the explicit typed command ------------
  // The reconciliation commands executed canonically first (their keys are
  // the resolution's evidence), THEN the conflict is resolved explicitly.
  const resolved = unwrap(
    await resolveFinancialConflict({
      store: conflictStore,
      conflict: detectedConflict,
      strategy: 'adopt-provider-value',
      resolvedBy: { kind: 'user', actorId: entity(61) },
      resolutionCommandKeys: [syncIdempotencyKey(sourceOf('invoice', 'inv-1', 'v2'))],
      now: NOW_4,
    }),
  );
  const reResolvedDifferently = await resolveFinancialConflict({
    store: conflictStore,
    conflict: detectedConflict,
    strategy: 'retain-canonical-value',
    resolvedBy: { kind: 'user', actorId: entity(61) },
    resolutionCommandKeys: [syncIdempotencyKey(sourceOf('invoice', 'inv-1', 'v1'))],
    now: NOW_4,
  });

  return {
    world,
    first,
    reSync,
    duplicateWebhook,
    update,
    updateWebhook,
    updateCommands,
    resolvedIds,
    resolveAll,
    divergent,
    reDetected,
    reconciliation,
    reconciliationAgain,
    financialConflicts,
    conflictStore,
    detectedConflict,
    detectedStored,
    resolved,
    reResolvedDifferently,
    createCommands,
  };
};

/** THE cursor-restart sub-scenario: three invoices paged two at a time. */
const restartScenario = async () => {
  const store = createErpProviderStore();
  for (const n of [1, 2, 3]) {
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
  const world = engine({ now: NOW_1 });
  const request = {
    authorization: financeAuthorization(),
    adapter: createFinanceAdapter({ store }),
    translator: createFinanceTranslator(),
    systemId: FINANCE_SYSTEM_ID,
    objectKinds: [INVOICE_OBJECT_KIND],
    limit: 2,
  };
  const initial = unwrap(await runFinanceSync(request, world.deps));
  // The exhausted run's persisted cursor checkpoints at position 2 (the final
  // page carries no continuation token): a restart re-delivers only the
  // un-checkpointed tail — and the version ledger turns it into a counted
  // typed no-op. Nothing re-processes into a command.
  const restart = unwrap(await runFinanceSync(request, world.deps));
  const restartAgain = unwrap(await runFinanceSync(request, world.deps));
  return { initial, restart, restartAgain };
};

describe('finance flow (OFF-024 — THE end-to-end acceptance)', () => {
  it('THE non-duplication: the same invoice version through sync, re-sync, AND duplicate webhook → exactly ONE canonical proposal (counted)', async () => {
    const flow = await scenario();

    // ---- the first sync: the whole chain, five creates, family order ------
    expect(flow.first.kind).toBe('finance-sync-report');
    expect(flow.first.streams.map((stream) => stream.objectKind)).toStrictEqual([
      'account',
      'cost-code',
      'commitment',
      'invoice',
      'payment',
    ]);
    expect(flow.first.counts).toStrictEqual({
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
    expect(flow.first.commands.map((command) => command.commandName)).toStrictEqual([
      'cost.createBudget',
      'cost.recordCostItem',
      'cost.createCommitment',
      'cost.recordInvoice',
      'cost.referencePayment',
    ]);
    // Every proposal is keyed by the SourceRef-derived idempotency key of the
    // EXACT provider object version it was proposed from.
    const invoiceCreateKey = syncIdempotencyKey(sourceOf('invoice', 'inv-1', 'v1'));
    expect(flow.first.commands[3]?.idempotencyKey).toBe(invoiceCreateKey);
    expect(flow.first.commands[3]?.commandName).toBe('cost.recordInvoice');
    expect(flow.first.commands[3]?.payload).toMatchObject({
      commitmentId: COMMITMENT_REF_ID,
      lines: [{ description: 'Phase one earthworks', amountMinor: 250_000 }],
    });
    // A10 + traceability: the proposal's causal chain ties it to the exact
    // provider object — the correlation id is the invoice's derived source
    // correlation id, shared by every command the invoice will ever propose.
    expect(flow.first.commands[3]?.causality.correlationId).toBe(
      sourceCorrelationId(coordinateOf(sourceOf('invoice', 'inv-1', 'v1'))),
    );

    // ---- the SAME versions through a full re-sync: counted typed no-ops ---
    expect(flow.reSync.counts.proposals).toBe(0);
    expect(flow.reSync.counts.duplicateDeduplicated).toBe(5);
    expect(flow.reSync.counts.snapshotsObserved).toBe(5);
    expect(flow.reSync.commands).toStrictEqual([]);
    expect(flow.reSync.duplicates.map((duplicate) => duplicate.reason)).toStrictEqual([
      'ledger',
      'ledger',
      'ledger',
      'ledger',
      'ledger',
    ]);

    // ---- the SAME invoice version through a DUPLICATE WEBHOOK delivery ----
    expect(flow.duplicateWebhook.outcome).toBe('duplicate-version-deduplicated');
    expect(flow.duplicateWebhook.command).toBeNull();
    expect(flow.duplicateWebhook.envelope).toBeNull();
    expect(flow.duplicateWebhook.duplicateEntry?.proposalKey).toBe(invoiceCreateKey);

    // ---- THE exactly-one proof (counted): across ALL paths, exactly ONE
    // command exists for the inv-1@v1 source version; its ledger entry counts
    // every observation (first sync + re-sync + the update run's invoice
    // re-scan + the webhook redelivery) and still carries the ONE key.
    const everyCommand = [
      ...flow.first.commands,
      ...flow.reSync.commands,
      ...flow.update.commands,
      flow.duplicateWebhook.command,
      flow.updateWebhook.command,
    ].filter((command): command is NonNullable<typeof command> => command !== null);
    expect(everyCommand.filter((command) => command.idempotencyKey === invoiceCreateKey)).toHaveLength(
      1,
    );
    const invoiceEntry = await flow.world.ledger.find(
      TENANT_A,
      coordinateOf(sourceOf('invoice', 'inv-1', 'v1')),
      providerVersion('v1'),
    );
    expect(invoiceEntry?.observationCount).toBe(4);
    expect(invoiceEntry?.proposalKey).toBe(invoiceCreateKey);
  });

  it('version bump → exactly ONE update proposal; re-delivery through BOTH paths never proposes twice', async () => {
    const flow = await scenario();

    expect(flow.update.counts.appliedUpdates).toBe(1);
    expect(flow.update.counts.proposals).toBe(1);
    expect(flow.update.counts.duplicateDeduplicated).toBe(4);
    expect(flow.update.commands).toHaveLength(1);
    const updateCommand = flow.update.commands[0];
    expect(updateCommand?.commandName).toBe('cost.reviseBudget');
    // A10: the office-issued budget id from the mapping table, the version the
    // canonical aggregate was at — never the provider's id or version.
    expect(updateCommand?.payload).toMatchObject({
      budgetId: entity(1),
      expectedVersion: 1,
    });
    const updateKey = syncIdempotencyKey(sourceOf('account', 'acc-1', 'v2'));
    expect(updateCommand?.idempotencyKey).toBe(updateKey);
    expect(updateKey).not.toBe(syncIdempotencyKey(sourceOf('account', 'acc-1', 'v1')));

    // The bumped version through the webhook path: a counted typed no-op —
    // one proposal per source version, across BOTH intake paths.
    expect(flow.updateWebhook.outcome).toBe('duplicate-version-deduplicated');
    expect(flow.updateWebhook.command).toBeNull();
    expect(flow.updateWebhook.duplicateEntry?.proposalKey).toBe(updateKey);
    expect(flow.updateWebhook.duplicateEntry?.observationCount).toBe(2);

    // Exactly one proposal exists for the bumped version, across all paths.
    const everyCommand = [
      ...flow.first.commands,
      ...flow.reSync.commands,
      ...flow.update.commands,
      flow.duplicateWebhook.command,
      flow.updateWebhook.command,
    ].filter((command): command is NonNullable<typeof command> => command !== null);
    expect(everyCommand.filter((command) => command.idempotencyKey === updateKey)).toHaveLength(1);
  });

  it('THE mapping table resolves the SAME canonical ids deterministically across re-syncs', async () => {
    const flow = await scenario();
    // The office-issued ids, in the injected supplier's deterministic order —
    // provider ids are never the identity (A10).
    expect(flow.resolvedIds).toStrictEqual([
      entity(1),
      entity(2),
      entity(3),
      entity(4),
      entity(5),
    ]);
    // After every re-sync and update in the scenario, the mapping table still
    // resolves exactly the same five canonical ids.
    expect((await flow.resolveAll()).map((entry) => unwrap(entry).entityId)).toStrictEqual([
      entity(1),
      entity(2),
      entity(3),
      entity(4),
      entity(5),
    ]);
  });

  it('cursor restart re-processes nothing into commands (the tail deduplicates, counted)', async () => {
    const restart = await restartScenario();
    // The initial run paged 3 invoices at 2/page to exhaustion: 3 creates.
    expect(restart.initial.counts.mappedCreated).toBe(3);
    expect(restart.initial.commands).toHaveLength(3);
    expect(restart.initial.streams[0]?.runs).toHaveLength(2);
    // The restart: the un-checkpointed tail comes back and the version ledger
    // turns it into a counted typed no-op — zero commands, zero applications.
    expect(restart.restart.counts.proposals).toBe(0);
    expect(restart.restart.counts.duplicateDeduplicated).toBe(1);
    expect(restart.restart.counts.snapshotsObserved).toBe(1);
    expect(restart.restart.commands).toStrictEqual([]);
    expect(restart.restart.streams[0]?.applications).toStrictEqual([]);
    expect(restart.restart.duplicates[0]?.snapshot.source.objectId).toBe('inv-3');
    // And AGAIN: still nothing (the ledger entry persists across restarts).
    expect(restart.restartAgain.commands).toStrictEqual([]);
    expect(restart.restartAgain.counts.duplicateDeduplicated).toBe(1);
  });

  it('the both-sides-moved divergence is an explicit conflict — never a silent last-write-wins', async () => {
    const flow = await scenario();

    expect(flow.divergent.counts.conflictsDetected).toBe(1);
    expect(flow.divergent.counts.proposals).toBe(0);
    expect(flow.divergent.commands).toStrictEqual([]);
    expect(flow.divergent.conflicts).toHaveLength(1);
    // BOTH sides recorded: the provider moved to v2, the canonical aggregate
    // sits at v2 (the office-side edit) — and NOTHING was auto-resolved.
    expect(flow.divergent.conflicts[0]).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'erp-finance',
        systemId: 'erp-instance-01',
        objectType: 'invoice',
        objectId: 'inv-1',
        version: 'v2',
      },
      canonical: { entityKind: 'invoice', entityId: entity(4) },
      canonicalVersion: 2,
      state: 'detected',
      resolution: null,
    });
    // Re-detection is idempotent: the same derived conflict id, still
    // detected, still unresolved, still no command.
    const conflictId = flow.divergent.conflicts[0]?.conflictId;
    expect(flow.reDetected.counts.conflictsDetected).toBe(1);
    expect(flow.reDetected.conflicts[0]?.conflictId).toBe(conflictId);
    expect(flow.reDetected.commands).toStrictEqual([]);
  });

  it('reconciliation: deterministic reports, typed discrepancy kinds carrying BOTH sides', async () => {
    const flow = await scenario();

    // Run-twice determinism: the pure projection over the same provider data
    // + canonical summaries → the identical report.
    expect(flow.reconciliationAgain).toStrictEqual(flow.reconciliation);
    expect(flow.reconciliation.kind).toBe('finance-reconciliation-report');
    expect(flow.reconciliation.counts).toStrictEqual({
      providerReferences: 1,
      canonicalReferences: 1,
      officeNative: 0,
      matched: 0,
      discrepancies: 1,
      missingCanonical: 0,
      missingProvider: 0,
      amountMismatch: 1,
      versionDivergence: 0,
    });

    // THE typed discrepancy carrying BOTH sides + the SourceRefs.
    expect(flow.reconciliation.discrepancies).toHaveLength(1);
    const discrepancy = flow.reconciliation.discrepancies[0];
    expect(discrepancy?.discrepancyKind).toBe('amount-mismatch');
    expect(discrepancy?.tenantId).toBe(TENANT_A);
    expect(discrepancy?.provider).toStrictEqual({
      source: sourceOf('invoice', 'inv-1', 'v2'),
      amountMinor: 312_500,
    });
    expect(discrepancy?.canonical).toStrictEqual({
      canonical: invoiceRef(4),
      source: sourceOf('invoice', 'inv-1', 'v1'),
      recordedAmountMinor: 250_000,
      canonicalVersion: 2,
    });
    expect(discrepancy?.expected).toBe('canonical recorded amount 250000 minor units');
    expect(discrepancy?.received).toBe('provider amount 312500 minor units');
    expect(discrepancy?.detectedAt).toBe(NOW_4);
    // The per-reference comparison carries both sides too.
    expect(flow.reconciliation.comparisons[0]?.status).toBe('discrepant');
    expect(flow.reconciliation.comparisons[0]?.coordinate.objectId).toBe('inv-1');
  });

  it('amount mismatch → explicit FinancialConflict records (both sides) with NO auto-resolution; the explicit typed command is the only path', async () => {
    const flow = await scenario();

    // The amount-mismatch discrepancy projects into explicit financial
    // conflict records — BOTH sides with their amounts, detected state, null
    // resolution (detection NEVER resolves).
    expect(flow.financialConflicts).toHaveLength(1);
    expect(flow.detectedConflict).toStrictEqual({
      kind: 'financial-conflict',
      conflictId: flow.detectedConflict.conflictId,
      tenantId: TENANT_A,
      reason: 'amount-mismatch',
      provider: { source: sourceOf('invoice', 'inv-1', 'v2'), amountMinor: 312_500 },
      canonical: {
        canonical: invoiceRef(4),
        amountMinor: 250_000,
        canonicalVersion: 2,
      },
      attemptedCanonical: null,
      detectedAt: NOW_4,
      detectedBy: financeAuthorization().context.actor,
      state: 'detected',
      resolution: null,
    });
    expect(flow.detectedConflict.conflictId).toMatch(/^office-fincfl-v1-[0-9a-z]{32}$/);

    // The conflict store held the DETECTED record all the way to the explicit
    // resolution: re-detection (identical report → identical derived ids)
    // appended nothing new, and no detection path resolved anything.
    expect(flow.detectedStored?.state).toBe('detected');
    expect(flow.detectedStored?.resolution).toBeNull();
    expect(flow.detectedStored).toStrictEqual(flow.detectedConflict);

    // The ONLY resolution path: the explicit typed command, citing the
    // idempotency keys of the canonical commands that performed the
    // reconciliation. The resolved record RETAINS both sides — resolution is
    // state, never an overwrite of the divergence evidence.
    expect(flow.resolved.state).toBe('resolved');
    expect(flow.resolved.provider.amountMinor).toBe(312_500);
    expect(flow.resolved.canonical.amountMinor).toBe(250_000);
    expect(flow.resolved.resolution?.strategy).toBe('adopt-provider-value');
    expect(flow.resolved.resolution?.resolutionCommandKeys).toStrictEqual([
      syncIdempotencyKey(sourceOf('invoice', 'inv-1', 'v2')),
    ]);
    expect(await flow.conflictStore.findById(TENANT_A, flow.detectedConflict.conflictId)).toBe(
      flow.resolved,
    );

    // A material commercial conflict is resolved exactly once: re-resolving
    // DIFFERENTLY is a typed invariant-violation, never a silent overwrite.
    expect(flow.reResolvedDifferently.ok).toBe(false);
  });

  it('is fully deterministic: run-twice → identical sync reports, commands, conflicts, and reconciliations', async () => {
    const first = await scenario();
    const second = await scenario();

    // The sync surface.
    expect(second.first).toStrictEqual(first.first);
    expect(second.reSync).toStrictEqual(first.reSync);
    expect(second.update).toStrictEqual(first.update);
    // THE proposals: identical commands (names, keys, payloads).
    expect(second.createCommands).toStrictEqual(first.createCommands);
    expect(second.updateCommands).toStrictEqual(first.updateCommands);
    // The webhook outcomes of the duplicate deliveries.
    expect(second.duplicateWebhook.outcome).toBe(first.duplicateWebhook.outcome);
    expect(second.duplicateWebhook.duplicateEntry?.proposalKey).toBe(
      first.duplicateWebhook.duplicateEntry?.proposalKey,
    );
    expect(second.updateWebhook.outcome).toBe(first.updateWebhook.outcome);
    // The mapping table: the same canonical ids.
    expect(second.resolvedIds).toStrictEqual(first.resolvedIds);
    // The divergence conflicts and the reconciliation projection.
    expect(second.divergent.conflicts).toStrictEqual(first.divergent.conflicts);
    expect(second.reconciliation).toStrictEqual(first.reconciliation);
    expect(second.financialConflicts).toStrictEqual(first.financialConflicts);
    // THE resolution record.
    expect(second.resolved).toStrictEqual(first.resolved);
  });
});
