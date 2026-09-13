import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { providerObjectId, providerVersion, sourceRef, sourceCoordinate } from '@office/adapters-sdk';
import type { SourceRef } from '@office/adapters-sdk';
import { parseEntityKind } from '@office/contracts';
import type { EntityRef } from '@office/contracts';
import { createErpProviderStore } from './provider-fixture';
import { reconcileFinanceBalances } from './reconciliation';
import type { FinanceDiscrepancy, FinanceReconciliationReport } from './reconciliation';
import { FINANCE_ADAPTER_KIND, FINANCE_SYSTEM_ID, INVOICE_OBJECT_KIND } from './vocabulary';
import {
  amountMismatchConflictsOf,
  createInMemoryFinancialConflictStore,
  detectedAmountMismatchConflict,
  detectedConcurrentEditConflict,
  detectedReferenceRemapConflict,
  financialConflictIdOf,
  isFinancialConflict,
  isFinancialConflictId,
  isFinancialConflictResolution,
  parseFinancialConflict,
  parseFinancialConflictId,
  parseFinancialConflictResolution,
  resolveFinancialConflict,
} from './conflict-discipline';
import type { FinancialConflict } from './conflict-discipline';
import * as finance from './index';
import { invoiceBalanceFactsOf } from './test-support';
import {
  COMMITMENT_REF_ID,
  NOW_1,
  NOW_2,
  NOW_3,
  TENANT_A,
  TENANT_B,
  commandKey,
  entity,
  financeAuthorization,
  unwrap,
  version,
} from './test-support';

// OFF-024 — THE explicit conflict discipline: financial state is MATERIAL
// commercial state, so an amount mismatch (or a concurrent edit, or a
// reference remap attempt) produces an explicit FinancialConflict record
// carrying BOTH sides — the provider side (the full SourceRef INCLUDING the
// provider version, plus the disputed amount) and the canonical side (the
// office entity, its aggregate version, and its recorded amount). Detection
// NEVER resolves anything (structural: every detector composes state
// 'detected' with a null resolution, and the ONLY composition site of state
// 'resolved' in the module is resolveFinancialConflict — the explicit typed
// command path, with the closed strategy vocabulary and the idempotency keys
// of the canonical commands that performed the reconciliation as its
// evidence).

const DETECTED_BY = financeAuthorization().context.actor;
const RESOLVED_BY = { kind: 'user', actorId: entity(61) } as const;

const invoiceSource = (objectId: string, objectVersion: string): SourceRef =>
  sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectType: INVOICE_OBJECT_KIND,
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

const invoiceRef = (n: number): EntityRef => ({
  entityKind: unwrap(parseEntityKind('invoice')),
  entityId: entity(n),
});

/** The amount-mismatch scenario: the ERP says 312_500, canonical recorded 250_000. */
const amountMismatchDiscrepancy = (): FinanceDiscrepancy => {
  const store = createErpProviderStore();
  store.putInvoice({
    objectId: 'inv-2',
    number: 'INV-2026-0302',
    description: 'Earthworks invoice 2',
    currency: 'EUR',
    commitmentRef: COMMITMENT_REF_ID,
    issuedOn: NOW_1,
    dueOn: NOW_2,
    lines: [{ description: 'Phase one earthworks (revised)', amountMinor: 312_500 }],
    updatedAt: NOW_1,
  });
  const report = unwrap(
    reconcileFinanceBalances({
      tenantId: TENANT_A,
      asOf: NOW_2,
      provider: invoiceBalanceFactsOf(store),
      canonical: [
        {
          canonical: invoiceRef(2),
          source: invoiceSource('inv-2', 'v1'),
          recordedAmountMinor: 250_000,
          canonicalVersion: version(1),
        },
      ],
    }),
  );
  expect(report.counts.amountMismatch).toBe(1);
  const discrepancy = report.discrepancies[0];
  if (discrepancy === undefined) {
    throw new Error('expected exactly one amount-mismatch discrepancy');
  }
  return discrepancy;
};

describe('financial conflict discipline (OFF-024)', () => {
  it('THE amount mismatch → an explicit FinancialConflict carrying BOTH sides', () => {
    const discrepancy = amountMismatchDiscrepancy();
    const detected = unwrap(
      detectedAmountMismatchConflict({
        discrepancy,
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    expect(detected.kind).toBe('financial-conflict');
    expect(detected.reason).toBe('amount-mismatch');
    // The provider side: the full source ref INCLUDING the version + amount.
    expect(detected.provider).toStrictEqual({
      source: invoiceSource('inv-2', 'v1'),
      amountMinor: 312_500,
    });
    // The canonical side: the office entity + its recorded amount + version.
    expect(detected.canonical).toStrictEqual({
      canonical: invoiceRef(2),
      amountMinor: 250_000,
      canonicalVersion: 1,
    });
    expect(detected.tenantId).toBe(TENANT_A);
    expect(detected.attemptedCanonical).toBeNull();
    expect(detected.detectedAt).toBe(NOW_3);
    expect(detected.detectedBy).toStrictEqual(DETECTED_BY);
    // Detection NEVER resolves: detected state, null resolution.
    expect(detected.state).toBe('detected');
    expect(detected.resolution).toBeNull();
    // The id is deterministic and derived from both sides (amounts included).
    expect(detected.conflictId).toBe(
      financialConflictIdOf({
        tenantId: TENANT_A,
        reason: 'amount-mismatch',
        provider: { source: invoiceSource('inv-2', 'v1'), amountMinor: 312_500 },
        canonical: { canonical: invoiceRef(2), amountMinor: 250_000, canonicalVersion: version(1) },
        attemptedCanonical: null,
      }),
    );
    expect(isFinancialConflictId(detected.conflictId)).toBe(true);
    expect(detected.conflictId).toMatch(/^office-fincfl-v1-[0-9a-z]{32}$/);
  });

  it('projects every amount-mismatch discrepancy of a report (report order, deterministic)', () => {
    const discrepancy = amountMismatchDiscrepancy();
    const report = {
      kind: 'finance-reconciliation-report',
      tenantId: TENANT_A,
      reconciledAt: NOW_2,
      comparisons: [],
      discrepancies: [discrepancy, discrepancy],
      officeNative: [],
      counts: {
        providerReferences: 1,
        canonicalReferences: 1,
        officeNative: 0,
        matched: 0,
        discrepancies: 2,
        missingCanonical: 0,
        missingProvider: 0,
        amountMismatch: 2,
        versionDivergence: 0,
      },
    } satisfies FinanceReconciliationReport;
    const conflicts = amountMismatchConflictsOf(report, {
      detectedAt: NOW_3,
      detectedBy: DETECTED_BY,
    });
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]?.conflictId).toBe(conflicts[1]?.conflictId);
    expect(conflicts.map((conflict) => conflict.reason)).toStrictEqual([
      'amount-mismatch',
      'amount-mismatch',
    ]);
    // Deterministic: the same report → the identical conflicts.
    expect(
      amountMismatchConflictsOf(report, { detectedAt: NOW_3, detectedBy: DETECTED_BY }),
    ).toStrictEqual(conflicts);
  });

  it('fails closed on discrepancies that are not amount mismatches (or miss sides)', () => {
    const mismatch = amountMismatchDiscrepancy();
    const rejected = detectedAmountMismatchConflict({
      discrepancy: { ...mismatch, discrepancyKind: 'version-divergence' },
      detectedAt: NOW_3,
      detectedBy: DETECTED_BY,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.details[0]?.code).toBe('conflict-reason-mismatch');

    const missingSides = detectedAmountMismatchConflict({
      discrepancy: { ...mismatch, canonical: null },
      detectedAt: NOW_3,
      detectedBy: DETECTED_BY,
    });
    expect(missingSides.ok).toBe(false);
    if (missingSides.ok) return;
    expect(missingSides.error.details[0]?.code).toBe('conflict-sides-missing');
  });

  it('derives conflict ids deterministically: a moved side is a NEW divergence pair', () => {
    const sides = {
      tenantId: TENANT_A,
      reason: 'amount-mismatch' as const,
      provider: { source: invoiceSource('inv-2', 'v1'), amountMinor: 312_500 },
      canonical: { canonical: invoiceRef(2), amountMinor: 250_000, canonicalVersion: version(1) },
      attemptedCanonical: null,
    };
    expect(financialConflictIdOf(sides)).toBe(financialConflictIdOf(sides));
    // The provider amount moved → a new pair → a new id.
    expect(
      financialConflictIdOf({
        ...sides,
        provider: { ...sides.provider, amountMinor: 350_000 },
      }),
    ).not.toBe(financialConflictIdOf(sides));
    // The canonical version moved → a new pair → a new id.
    expect(
      financialConflictIdOf({
        ...sides,
        canonical: { ...sides.canonical, canonicalVersion: version(2) },
      }),
    ).not.toBe(financialConflictIdOf(sides));
    // A different reason → a new id.
    expect(financialConflictIdOf({ ...sides, reason: 'concurrent-edit' })).not.toBe(
      financialConflictIdOf(sides),
    );
  });

  it('records concurrent edits and reference remaps as detected conflicts (both sides)', () => {
    const concurrent = detectedConcurrentEditConflict({
      tenantId: TENANT_A,
      source: invoiceSource('inv-2', 'v3'),
      canonical: invoiceRef(2),
      canonicalVersion: version(4),
      providerAmountMinor: 312_500,
      canonicalAmountMinor: 250_000,
      detectedAt: NOW_3,
      detectedBy: DETECTED_BY,
    });
    expect(concurrent.reason).toBe('concurrent-edit');
    expect(concurrent.provider.source.version).toBe('v3');
    expect(concurrent.provider.amountMinor).toBe(312_500);
    expect(concurrent.canonical.canonicalVersion).toBe(4);
    expect(concurrent.state).toBe('detected');
    expect(concurrent.resolution).toBeNull();

    const remap = detectedReferenceRemapConflict({
      tenantId: TENANT_A,
      source: invoiceSource('inv-2', 'v1'),
      existingCanonical: invoiceRef(2),
      existingCanonicalVersion: version(1),
      attemptedCanonical: invoiceRef(7),
      detectedAt: NOW_3,
      detectedBy: DETECTED_BY,
    });
    expect(remap.reason).toBe('reference-remap');
    expect(remap.canonical.canonical.entityId).toBe(entity(2));
    expect(remap.attemptedCanonical).toStrictEqual(invoiceRef(7));
    expect(remap.provider.amountMinor).toBeNull();
    expect(remap.canonical.amountMinor).toBeNull();
    expect(remap.state).toBe('detected');
    expect(remap.resolution).toBeNull();
  });

  it('appends idempotently; a different pair under an existing id is a typed collision', async () => {
    const store = createInMemoryFinancialConflictStore();
    const detected = unwrap(
      detectedAmountMismatchConflict({
        discrepancy: amountMismatchDiscrepancy(),
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    const first = unwrap(await store.append(detected));
    expect(first).toStrictEqual(detected);
    // The SAME divergence pair again: an idempotent no-op.
    const again = unwrap(await store.append(detected));
    expect(again).toStrictEqual(detected);

    // A moved side is a NEW divergence pair: it derives a NEW id (amounts are
    // derivation input — proven by the id-derivation test), so it appends as
    // its own record and never touches the original.
    const moved = unwrap(
      detectedAmountMismatchConflict({
        discrepancy: {
          ...amountMismatchDiscrepancy(),
          provider: { source: invoiceSource('inv-2', 'v1'), amountMinor: 350_000 },
        },
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    expect(moved.conflictId).not.toBe(detected.conflictId);
    unwrap(await store.append(moved));
    expect(await store.findById(TENANT_A, detected.conflictId)).toStrictEqual(detected);

    // A DIFFERENT pair pinned under an EXISTING id is a typed collision: ids
    // are derived from both sides (amounts included), so a record whose id
    // does not match its sides can only be a mis-attributed one — the store
    // refuses it loudly, never overwrites the recorded pair.
    const misattributed: FinancialConflict = {
      ...detected,
      provider: { source: invoiceSource('inv-2', 'v1'), amountMinor: 350_000 },
    };
    const collision = await store.append(misattributed);
    expect(collision.ok).toBe(false);
    if (collision.ok) return;
    expect(collision.error.code).toBe('invariant-violation');
    expect(collision.error.details[0]?.code).toBe('financial-conflict-id-collision');

    // Tenant-scoped lookups (A12): a foreign tenant sees absence.
    const conflictCoordinate = sourceCoordinate({
      adapterKind: FINANCE_ADAPTER_KIND,
      systemId: FINANCE_SYSTEM_ID,
      objectType: INVOICE_OBJECT_KIND,
      objectId: providerObjectId('inv-2'),
    });
    // Tenant-scoped lookups (A12): a foreign tenant sees absence; the owning
    // tenant sees both divergence pairs for the source, in insertion order.
    expect(await store.findById(TENANT_B, detected.conflictId)).toBeNull();
    expect(await store.listBySource(TENANT_B, conflictCoordinate)).toStrictEqual([]);
    expect(await store.listBySource(TENANT_A, conflictCoordinate)).toStrictEqual([
      detected,
      moved,
    ]);
  });

  it('resolves a conflict EXPLICITLY (the only path), citing its command trail', async () => {
    const store = createInMemoryFinancialConflictStore();
    const detected = unwrap(
      detectedAmountMismatchConflict({
        discrepancy: amountMismatchDiscrepancy(),
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    unwrap(await store.append(detected));

    const resolved = unwrap(
      await resolveFinancialConflict({
        store,
        conflict: detected,
        strategy: 'adopt-provider-value',
        resolvedBy: RESOLVED_BY,
        resolutionCommandKeys: [commandKey(1), commandKey(2)],
        now: NOW_3,
      }),
    );
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolution).toStrictEqual({
      kind: 'financial-conflict-resolution',
      strategy: 'adopt-provider-value',
      resolvedBy: RESOLVED_BY,
      resolvedAt: NOW_3,
      resolutionCommandKeys: [commandKey(1), commandKey(2)],
    });
    // The resolved record still carries BOTH sides — resolution is state,
    // never an overwrite of the divergence evidence.
    expect(resolved.provider.amountMinor).toBe(312_500);
    expect(resolved.canonical.amountMinor).toBe(250_000);
    // The store now returns the resolved record.
    expect(await store.findById(TENANT_A, detected.conflictId)).toStrictEqual(resolved);

    // An IDENTICAL resolution replayed: idempotent.
    const replay = unwrap(
      await resolveFinancialConflict({
        store,
        conflict: resolved,
        strategy: 'adopt-provider-value',
        resolvedBy: RESOLVED_BY,
        resolutionCommandKeys: [commandKey(1), commandKey(2)],
        now: NOW_3,
      }),
    );
    expect(replay).toStrictEqual(resolved);
  });

  it('typed-rejects invalid resolutions (no trail, duplicates, conflicting re-resolution)', async () => {
    const store = createInMemoryFinancialConflictStore();
    const detected = unwrap(
      detectedAmountMismatchConflict({
        discrepancy: amountMismatchDiscrepancy(),
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    unwrap(await store.append(detected));

    // A resolution WITHOUT its command trail is typed-rejected.
    const noTrail = await resolveFinancialConflict({
      store,
      conflict: detected,
      strategy: 'retain-canonical-value',
      resolvedBy: RESOLVED_BY,
      resolutionCommandKeys: [],
      now: NOW_3,
    });
    expect(noTrail.ok).toBe(false);
    if (noTrail.ok) return;
    expect(noTrail.error.details[0]?.code).toMatch(/^financial-conflict-resolution-/);

    // Duplicate command keys are typed-rejected (a closed set).
    const duplicated = await resolveFinancialConflict({
      store,
      conflict: detected,
      strategy: 'manual-merge',
      resolvedBy: RESOLVED_BY,
      resolutionCommandKeys: [commandKey(1), commandKey(1)],
      now: NOW_3,
    });
    expect(duplicated.ok).toBe(false);

    // Resolve, then re-resolve DIFFERENTLY: a material commercial conflict is
    // resolved exactly once.
    unwrap(
      await resolveFinancialConflict({
        store,
        conflict: detected,
        strategy: 'adopt-provider-value',
        resolvedBy: RESOLVED_BY,
        resolutionCommandKeys: [commandKey(1)],
        now: NOW_3,
      }),
    );
    const reResolved = await resolveFinancialConflict({
      store,
      conflict: detected,
      strategy: 'retain-canonical-value',
      resolvedBy: RESOLVED_BY,
      resolutionCommandKeys: [commandKey(3)],
      now: NOW_3,
    });
    expect(reResolved.ok).toBe(false);
    if (reResolved.ok) return;
    expect(reResolved.error.details[0]?.code).toBe('financial-conflict-already-resolved');
  });

  it('typed-rejects a resolution citing a conflict that was never recorded', async () => {
    const store = createInMemoryFinancialConflictStore();
    const detected = unwrap(
      detectedAmountMismatchConflict({
        discrepancy: amountMismatchDiscrepancy(),
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    // Never appended: a resolution cites a DETECTED conflict, never invents one.
    const unrecorded = await resolveFinancialConflict({
      store,
      conflict: detected,
      strategy: 'adopt-provider-value',
      resolvedBy: RESOLVED_BY,
      resolutionCommandKeys: [commandKey(1)],
      now: NOW_3,
    });
    expect(unrecorded.ok).toBe(false);
    if (unrecorded.ok) return;
    expect(unrecorded.error.code).toBe('not-found');
    expect(unrecorded.error.details[0]?.code).toBe('financial-conflict-not-found');
  });

  it('NO AUTO-RESOLUTION exists (structural): detectors never resolve; exactly one resolution composer', async () => {
    // 1. Behavioral: EVERY detector output lands 'detected' with a null
    //    resolution — no detection path resolves anything.
    const detected = unwrap(
      detectedAmountMismatchConflict({
        discrepancy: amountMismatchDiscrepancy(),
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    const concurrent = detectedConcurrentEditConflict({
      tenantId: TENANT_A,
      source: invoiceSource('inv-2', 'v3'),
      canonical: invoiceRef(2),
      canonicalVersion: version(4),
      providerAmountMinor: null,
      canonicalAmountMinor: null,
      detectedAt: NOW_3,
      detectedBy: DETECTED_BY,
    });
    const remap = detectedReferenceRemapConflict({
      tenantId: TENANT_A,
      source: invoiceSource('inv-2', 'v1'),
      existingCanonical: invoiceRef(2),
      existingCanonicalVersion: version(1),
      attemptedCanonical: invoiceRef(7),
      detectedAt: NOW_3,
      detectedBy: DETECTED_BY,
    });
    for (const conflict of [detected, concurrent, remap]) {
      expect(conflict.state).toBe('detected');
      expect(conflict.resolution).toBeNull();
    }

    // 2. Structural (source): the ONLY composition site of state 'resolved'
    //    in conflict-discipline.ts lives inside resolveFinancialConflict —
    //    the explicit typed command path. Comments are stripped first.
    const moduleFile = resolve(dirname(fileURLToPath(import.meta.url)), 'conflict-discipline.ts');
    expect(existsSync(moduleFile)).toBe(true);
    const source = readFileSync(moduleFile, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const compositions = [...source.matchAll(/state:\s*'resolved'/g)];
    expect(compositions).toHaveLength(1);
    const resolveStart = source.indexOf('export async function resolveFinancialConflict');
    const compositionIndex = source.indexOf("state: 'resolved'");
    expect(compositionIndex).toBeGreaterThan(resolveStart);

    // 3. Surface: the public surface exposes exactly ONE resolution entry
    //    point for financial CONFLICTS (resolveFinanceReference is the A10
    //    mapping lookup, a different concern), and NO auto/winner/merge/last
    //    write vocabulary anywhere. FINANCIAL_CONFLICT_RESOLUTION_GRAMMAR is
    //    parse-failure documentation data, not an entry point.
    const surface = Object.keys(finance);
    expect(
      surface.filter((key) => /^resolve/i.test(key) && /conflict/i.test(key)),
    ).toStrictEqual(['resolveFinancialConflict']);
    expect(surface.filter((key) => /auto|winner|lastwrite/i.test(key))).toStrictEqual([]);
    const resolutionSurface = surface
      .filter((key) => /conflict/i.test(key) && /resol/i.test(key))
      .sort();
    expect(resolutionSurface).toStrictEqual([
      'FINANCIAL_CONFLICT_RESOLUTION_GRAMMAR',
      'isFinancialConflictResolution',
      'parseFinancialConflictResolution',
      'resolveFinancialConflict',
    ]);
  });

  it('round-trips records through the fail-closed parsers (strict keys, state discipline)', () => {
    const detected = unwrap(
      detectedAmountMismatchConflict({
        discrepancy: amountMismatchDiscrepancy(),
        detectedAt: NOW_3,
        detectedBy: DETECTED_BY,
      }),
    );
    expect(isFinancialConflict(detected)).toBe(true);
    expect(parseFinancialConflict(detected).ok).toBe(true);

    const resolved: FinancialConflict = {
      ...detected,
      state: 'resolved',
      resolution: {
        kind: 'financial-conflict-resolution',
        strategy: 'adopt-provider-value',
        resolvedBy: RESOLVED_BY,
        resolvedAt: NOW_3,
        resolutionCommandKeys: [commandKey(1)],
      },
    };
    expect(parseFinancialConflict(resolved).ok).toBe(true);
    expect(isFinancialConflictResolution(resolved.resolution)).toBe(true);
    expect(parseFinancialConflictResolution(resolved.resolution).ok).toBe(true);

    // The state/resolution consistency discipline, typed-rejected:
    expect(
      parseFinancialConflict({ ...detected, resolution: resolved.resolution }).ok,
    ).toBe(false); // 'detected' with a resolution
    expect(parseFinancialConflict({ ...resolved, resolution: null }).ok).toBe(false); // 'resolved' without one
    expect(parseFinancialConflict({ ...detected, memo: 'x' }).ok).toBe(false); // unknown key
    expect(parseFinancialConflictId('not-a-conflict-id').ok).toBe(false);
    expect(isFinancialConflictId('office-fincfl-v1-SHORT')).toBe(false);
  });
});
