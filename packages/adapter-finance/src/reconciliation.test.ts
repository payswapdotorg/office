import { describe, expect, it } from 'vitest';
import { providerObjectId, providerVersion, sourceRef } from '@office/adapters-sdk';
import type { SourceRef } from '@office/adapters-sdk';
import { parseEntityKind } from '@office/contracts';
import type { EntityId } from '@office/contracts';
import { createErpProviderStore } from './provider-fixture';
import type { ErpProviderStore } from './provider-fixture';
import { reconcileFinanceBalances } from './reconciliation';
import type {
  CanonicalBalanceFact,
  FinanceReconciliationReport,
  ProviderBalanceFact,
} from './reconciliation';
import { FINANCE_ADAPTER_KIND, FINANCE_SYSTEM_ID, INVOICE_OBJECT_KIND } from './vocabulary';
import { invoiceBalanceFactsOf } from './test-support';
import {
  COMMITMENT_REF_ID,
  NOW_1,
  NOW_2,
  TENANT_A,
  entity,
  unwrap,
  version,
} from './test-support';

// OFF-024 — the reconciliation interfaces: the PURE deterministic comparison
// surface between the provider's financial state and the canonical state.
// The canonical side arrives as TYPED SUMMARIES ONLY (no domain package is
// imported); the provider side composes from the adapter's own observations
// over the fixture. Same provider data + same canonical summaries → the
// IDENTICAL report, whatever the input order; the closed discrepancy
// vocabulary (missing-canonical / missing-provider / amount-mismatch /
// version-divergence) always carries BOTH sides, present or absent.

const INVOICE_ENTITY_KIND = unwrap(parseEntityKind('invoice'));

const canonicalFact = (parts: {
  readonly entityId: EntityId;
  readonly source: SourceRef | null;
  readonly recordedAmountMinor: number | null;
  readonly canonicalVersion: number;
}): CanonicalBalanceFact => ({
  canonical: { entityKind: INVOICE_ENTITY_KIND, entityId: parts.entityId },
  source: parts.source,
  recordedAmountMinor: parts.recordedAmountMinor,
  canonicalVersion: version(parts.canonicalVersion),
});

const invoiceSource = (objectId: string, objectVersion: string): SourceRef =>
  sourceRef({
    adapterKind: FINANCE_ADAPTER_KIND,
    systemId: FINANCE_SYSTEM_ID,
    objectType: INVOICE_OBJECT_KIND,
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

/** The divergence-scenario fixture: matched, amount-mismatch, version-divergence, missing-canonical. */
const scenarioStore = (): ErpProviderStore => {
  const store = createErpProviderStore();
  const put = (objectId: string, amountMinor: number): void => {
    store.putInvoice({
      objectId,
      number: `INV-2026-${objectId.toUpperCase()}`,
      description: `Earthworks invoice ${objectId}`,
      currency: 'EUR',
      commitmentRef: COMMITMENT_REF_ID,
      issuedOn: NOW_1,
      dueOn: NOW_2,
      lines: [{ description: 'Phase one earthworks', amountMinor }],
      updatedAt: NOW_1,
    });
  };
  put('inv-1', 250_000); // matched with the canonical record
  put('inv-2', 312_500); // the ERP revised the amount; canonical still records 250_000
  put('inv-3', 180_000); // same amount, but the ERP bumped the version to v2
  store.reviseInvoice('inv-3', {
    lines: [{ description: 'Phase one earthworks', amountMinor: 180_000 }],
    updatedAt: NOW_2,
  });
  put('inv-4', 90_000); // never bound canonically
  return store;
};

/** The canonical summaries the runtime (OFF-037) would compose. */
const canonicalFacts = (): readonly unknown[] => [
  // inv-1: synchronized at v1, canonical records the same amount → matched.
  canonicalFact({
    entityId: entity(1),
    source: invoiceSource('inv-1', 'v1'),
    recordedAmountMinor: 250_000,
    canonicalVersion: 1,
  }),
  // inv-2: synchronized at v1; canonical records 250_000, the ERP says 312_500.
  canonicalFact({
    entityId: entity(2),
    source: invoiceSource('inv-2', 'v1'),
    recordedAmountMinor: 250_000,
    canonicalVersion: 1,
  }),
  // inv-3: canonical synchronized at v1; the ERP moved to v2 (same amount).
  canonicalFact({
    entityId: entity(3),
    source: invoiceSource('inv-3', 'v1'),
    recordedAmountMinor: 180_000,
    canonicalVersion: 1,
  }),
  // inv-5: a mapped canonical record whose provider reference the ERP no
  // longer reports.
  canonicalFact({
    entityId: entity(5),
    source: invoiceSource('inv-5', 'v1'),
    recordedAmountMinor: 60_000,
    canonicalVersion: 1,
  }),
  // An office-native canonical record (created in office, never mapped).
  canonicalFact({
    entityId: entity(6),
    source: null,
    recordedAmountMinor: 42_000,
    canonicalVersion: 3,
  }),
];

const reconcile = () =>
  unwrap(
    reconcileFinanceBalances({
      tenantId: TENANT_A,
      asOf: NOW_2,
      provider: invoiceBalanceFactsOf(scenarioStore()),
      canonical: canonicalFacts(),
    }),
  );

describe('financial reconciliation interfaces (OFF-024)', () => {
  it('projects a deterministic report over the fixture data (run twice → identical)', () => {
    const first = reconcile();
    const second = reconcile();
    expect(first.kind).toBe('finance-reconciliation-report');
    expect(first).toStrictEqual(second);
    expect(first.tenantId).toBe(TENANT_A);
    expect(first.reconciledAt).toBe(NOW_2);
  });

  it('is order-independent: shuffled inputs produce the identical report', () => {
    const provider = invoiceBalanceFactsOf(scenarioStore());
    const canonical = canonicalFacts();
    const report = reconcile();
    const shuffled = unwrap(
      reconcileFinanceBalances({
        tenantId: TENANT_A,
        asOf: NOW_2,
        provider: [...provider].reverse(),
        canonical: [...canonical].reverse(),
      }),
    );
    expect(shuffled).toStrictEqual(report);
    // The comparisons come out in canonical coordinate-key order.
    expect(shuffled.comparisons.map((comparison) => comparison.coordinate.objectId)).toStrictEqual([
      'inv-1',
      'inv-2',
      'inv-3',
      'inv-4',
      'inv-5',
    ]);
  });

  it('types every discrepancy kind with BOTH sides recorded (the closed vocabulary)', () => {
    const report = reconcile();
    const byCoordinate = new Map(
      report.comparisons.map((comparison) => [String(comparison.coordinate.objectId), comparison]),
    );
    const discrepanciesByKind = new Map(
      report.discrepancies.map((discrepancy) => [
        discrepancy.discrepancyKind,
        discrepancy,
      ]),
    );

    // matched: inv-1 — both sides, equal amounts AND synchronized version.
    const matched = byCoordinate.get('inv-1');
    expect(matched?.status).toBe('matched');
    expect(matched?.provider?.amountMinor).toBe(250_000);
    expect(matched?.canonical?.recordedAmountMinor).toBe(250_000);

    // amount-mismatch: inv-2 — both sides with their amounts.
    const mismatch = discrepanciesByKind.get('amount-mismatch');
    expect(mismatch?.provider?.source.objectId).toBe('inv-2');
    expect(mismatch?.provider?.amountMinor).toBe(312_500);
    expect(mismatch?.canonical?.canonical.entityId).toBe(entity(2));
    expect(mismatch?.canonical?.recordedAmountMinor).toBe(250_000);
    expect(mismatch?.canonical?.canonicalVersion).toBe(1);
    expect(mismatch?.expected).toBe('canonical recorded amount 250000 minor units');
    expect(mismatch?.received).toBe('provider amount 312500 minor units');
    expect(mismatch?.detectedAt).toBe(NOW_2);

    // version-divergence: inv-3 — both sides, equal amounts, moved version.
    const divergence = discrepanciesByKind.get('version-divergence');
    expect(divergence?.provider?.source.version).toBe('v2');
    expect(divergence?.canonical?.source?.version).toBe('v1');
    expect(divergence?.canonical?.recordedAmountMinor).toBe(180_000);
    expect(divergence?.expected).toBe('canonical synchronized at provider version v1');
    expect(divergence?.received).toBe('provider version v2');

    // missing-canonical: inv-4 — the provider side present, canonical absent.
    const missingCanonical = discrepanciesByKind.get('missing-canonical');
    expect(missingCanonical?.provider?.source.objectId).toBe('inv-4');
    expect(missingCanonical?.provider?.amountMinor).toBe(90_000);
    expect(missingCanonical?.canonical).toBeNull();
    expect(missingCanonical?.expected).toBe('a canonical record bound to the provider reference');
    expect(missingCanonical?.received).toBe('absent');

    // missing-provider: inv-5 — the canonical side present, provider absent.
    const missingProvider = discrepanciesByKind.get('missing-provider');
    expect(missingProvider?.provider).toBeNull();
    expect(missingProvider?.canonical?.canonical.entityId).toBe(entity(5));
    expect(missingProvider?.canonical?.source?.objectId).toBe('inv-5');
    expect(missingProvider?.expected).toBe('a provider reference for the canonical record');
    expect(missingProvider?.received).toBe('absent');

    // Both sides recorded in every comparison, matched or discrepant.
    for (const comparison of report.comparisons) {
      expect(
        comparison.provider !== null || comparison.canonical !== null,
      ).toBe(true);
    }
    expect(byCoordinate.get('inv-2')?.status).toBe('discrepant');
    expect(byCoordinate.get('inv-3')?.status).toBe('discrepant');
    expect(byCoordinate.get('inv-4')?.status).toBe('discrepant');
    expect(byCoordinate.get('inv-5')?.status).toBe('discrepant');
  });

  it('counts every path (and office-native facts are counted, never discrepant)', () => {
    const report = reconcile();
    expect(report.counts).toStrictEqual({
      providerReferences: 4,
      canonicalReferences: 4,
      officeNative: 1,
      matched: 1,
      discrepancies: 4,
      missingCanonical: 1,
      missingProvider: 1,
      amountMismatch: 1,
      versionDivergence: 1,
    });
    expect(report.officeNative).toHaveLength(1);
    expect(report.officeNative[0]?.canonical.entityId).toBe(entity(6));
    expect(report.officeNative[0]?.source).toBeNull();
    // An office-native fact never lands in the discrepancy list.
    expect(
      report.discrepancies.some((discrepancy) =>
        discrepancy.canonical?.canonical.entityId === entity(6),
      ),
    ).toBe(false);
  });

  it('treats a null canonical recorded amount as an amount mismatch (not recorded ≠ matched)', () => {
    const report = unwrap(
      reconcileFinanceBalances({
        tenantId: TENANT_A,
        asOf: NOW_2,
        provider: invoiceBalanceFactsOf(scenarioStore()).filter(
          (fact) => fact.source.objectId === 'inv-1',
        ),
        canonical: [
          canonicalFact({
            entityId: entity(1),
            source: invoiceSource('inv-1', 'v1'),
            recordedAmountMinor: null,
            canonicalVersion: 1,
          }),
        ],
      }),
    );
    expect(report.counts.amountMismatch).toBe(1);
    expect(report.discrepancies[0]?.expected).toBe('canonical recorded amount not recorded');
  });

  it('fails closed on ambiguous or malformed inputs (typed, with paths)', () => {
    const provider = invoiceBalanceFactsOf(scenarioStore());
    const canonical = canonicalFacts();
    const cases: readonly [string, ReturnType<typeof reconcileFinanceBalances>][] = [
      [
        'a duplicate provider fact',
        reconcileFinanceBalances({
          tenantId: TENANT_A,
          asOf: NOW_2,
          provider: [...provider, provider[0] as ProviderBalanceFact],
          canonical,
        }),
      ],
      [
        'a duplicate canonical fact',
        reconcileFinanceBalances({
          tenantId: TENANT_A,
          asOf: NOW_2,
          provider,
          canonical: [...canonical, canonical[0]],
        }),
      ],
      [
        'a non-integer provider amount',
        reconcileFinanceBalances({
          tenantId: TENANT_A,
          asOf: NOW_2,
          provider: [{ source: invoiceSource('inv-1', 'v1'), amountMinor: 1.5 }],
          canonical: [],
        }),
      ],
      [
        'a non-object provider fact',
        reconcileFinanceBalances({
          tenantId: TENANT_A,
          asOf: NOW_2,
          provider: ['nope'],
          canonical: [],
        }),
      ],
      [
        'an invalid canonical aggregate version',
        reconcileFinanceBalances({
          tenantId: TENANT_A,
          asOf: NOW_2,
          provider: [],
          canonical: [
            {
              canonical: { entityKind: 'invoice', entityId: entity(1) },
              source: invoiceSource('inv-1', 'v1'),
              recordedAmountMinor: 250_000,
              canonicalVersion: 0,
            },
          ],
        }),
      ],
    ];
    for (const [label, result] of cases) {
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, label).toBe('invariant-violation');
      expect(result.error.details[0]?.code, label).toMatch(/^reconciliation-input-/);
    }
  });

  it('round-trips a matched comparison as the report data OFF-037 consumes', () => {
    const report: FinanceReconciliationReport = reconcile();
    // The report is pure data: comparisons, discrepancies, office-native
    // facts, counts — no store handles, no I/O, nothing but typed values.
    expect(report.comparisons.every((comparison) => comparison.kind === 'balance-comparison')).toBe(
      true,
    );
    expect(
      report.discrepancies.every((discrepancy) => discrepancy.kind === 'finance-discrepancy'),
    ).toBe(true);
    expect(report.comparisons).toHaveLength(5);
    expect(report.discrepancies).toHaveLength(4);
  });
});
