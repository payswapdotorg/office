// Office adapter-finance — the reconciliation interfaces (OFF-024).
//
// THE comparison surface between the provider's financial state and the
// canonical state: a PURE, DETERMINISTIC projection from two TYPED summaries
// — the provider's per-reference balance facts (provider amount observed at
// a source version) and the canonical per-reference balance facts (canonical
// entity + recorded amount + the last-synchronized source version) — into a
// typed reconciliation report of per-reference balance comparisons and typed
// discrepancy records. Same provider data + same canonical summaries → the
// IDENTICAL report, whatever the input order (the join key is the source
// coordinate; the output order is the coordinate key's canonical order).
//
// The canonical side arrives as TYPED SUMMARIES ONLY: this package never
// imports a domain package (the canonical cost domain is NOT imported) — the
// runtime (OFF-037) composes the canonical facts from the canonical state it
// owns, and the reconciliation consumes exactly what it is handed. The
// provider side composes from the adapter's own observations (the fixture or
// a real ERP client's read surface).
//
// The closed discrepancy vocabulary (every record carries BOTH sides —
// present or absent — and the SourceRefs):
//   missing-canonical  the provider reports a reference with no canonical
//                      record bound to it;
//   missing-provider   a mapped canonical record whose provider reference
//                      the provider no longer reports;
//   amount-mismatch    both sides present, the provider amount differs from
//                      the canonical recorded amount (MATERIAL commercial
//                      state — the conflict-discipline module turns these
//                      into explicit FinancialConflict records, never an
//                      automatic resolution);
//   version-divergence both sides present with equal amounts, but the
//                      provider version moved past the version the canonical
//                      side last synchronized.
//
// A canonical fact with NO source reference is office-native state (created
// in office, never provider-mapped): it is counted and reported, but it is
// not a discrepancy — the provider is not the source of truth for entities
// it never held.
import { domainError, fail, ok, parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import { isPlainObject } from './parse';
import { coordinateOf, sourceCoordinateKeyOf } from '@office/adapters-sdk';
import type { SourceCoordinate, SourceRef } from '@office/adapters-sdk';

/** The provider's observation of one financial reference's balance. */
export interface ProviderBalanceFact {
  /** The provider object's full identity at the observed version. */
  readonly source: SourceRef;
  /** The provider's current amount for the reference, in integer minor units. */
  readonly amountMinor: number;
}

/** The canonical record of one mapped financial reference's balance. */
export interface CanonicalBalanceFact {
  /** The office entity the provider reference maps to. */
  readonly canonical: EntityRef;
  /**
   * The last-synchronized source identity of the mapping (the coordinate at
   * the provider version whose proposal the canonical side recorded), or
   * null when the entity is office-native (never provider-mapped).
   */
  readonly source: SourceRef | null;
  /** The canonical recorded amount in integer minor units, or null when not recorded. */
  readonly recordedAmountMinor: number | null;
  /** The canonical aggregate version at which the amount was recorded. */
  readonly canonicalVersion: AggregateVersion;
}

/** The closed discrepancy-kind vocabulary. */
export type FinanceDiscrepancyKind =
  | 'missing-canonical'
  | 'missing-provider'
  | 'amount-mismatch'
  | 'version-divergence';

/** One typed reconciliation discrepancy — both sides, present or absent. */
export interface FinanceDiscrepancy {
  readonly kind: 'finance-discrepancy';
  /** Which comparison failed (the closed vocabulary above). */
  readonly discrepancyKind: FinanceDiscrepancyKind;
  /** Owning tenant (freeze A12). */
  readonly tenantId: TenantId;
  /** The provider side of the comparison (null on missing-provider). */
  readonly provider: ProviderBalanceFact | null;
  /** The canonical side of the comparison (null on missing-canonical). */
  readonly canonical: CanonicalBalanceFact | null;
  /** What the canonical side expected, quoted for the audit surface. */
  readonly expected: string;
  /** What the provider side presented, quoted for the audit surface. */
  readonly received: string;
  /** When the reconciliation observed the discrepancy (injected clock). */
  readonly detectedAt: Timestamp;
}

/** One per-reference balance comparison — both sides, present or absent. */
export interface BalanceComparison {
  readonly kind: 'balance-comparison';
  /** The join key: the provider coordinate the comparison is about. */
  readonly coordinate: SourceCoordinate;
  /** The provider side (null when the provider no longer reports it). */
  readonly provider: ProviderBalanceFact | null;
  /** The canonical side (null when no canonical record is bound). */
  readonly canonical: CanonicalBalanceFact | null;
  /** Whether the sides agree (amount AND synchronized version). */
  readonly status: 'matched' | 'discrepant';
}

/** Summary counts of one reconciliation report. */
export interface FinanceReconciliationCounts {
  /** Provider references the report compared. */
  readonly providerReferences: number;
  /** Mapped canonical references the report compared. */
  readonly canonicalReferences: number;
  /** Office-native canonical facts (no provider source — counted, never discrepant). */
  readonly officeNative: number;
  /** Comparisons in agreement. */
  readonly matched: number;
  readonly discrepancies: number;
  readonly missingCanonical: number;
  readonly missingProvider: number;
  readonly amountMismatch: number;
  readonly versionDivergence: number;
}

/** The whole deterministic reconciliation report. */
export interface FinanceReconciliationReport {
  readonly kind: 'finance-reconciliation-report';
  /** Owning tenant (freeze A12). */
  readonly tenantId: TenantId;
  /** When the reconciliation ran (injected clock). */
  readonly reconciledAt: Timestamp;
  /** Every per-reference comparison, in canonical coordinate-key order. */
  readonly comparisons: readonly BalanceComparison[];
  /** Every typed discrepancy, in the same canonical order. */
  readonly discrepancies: readonly FinanceDiscrepancy[];
  /** Office-native canonical facts (deterministic canonical-id order). */
  readonly officeNative: readonly CanonicalBalanceFact[];
  /** The summary counts. */
  readonly counts: FinanceReconciliationCounts;
}

const AMOUNT_BOUND = 1_000_000_000_000;

/** Fail-closed validation of one provider balance fact (untrusted input). */
const checkProviderFact = (raw: unknown, index: number): Result<ProviderBalanceFact, DomainError> => {
  if (!isPlainObject(raw)) {
    return fail(factFailure('invalid-type', `provider[${index}]`, 'a provider balance fact object', typeof raw));
  }
  const source = raw['source'];
  const amountMinor = raw['amountMinor'];
  if (
    typeof source !== 'object' ||
    source === null ||
    typeof (source as Record<string, unknown>)['version'] !== 'string'
  ) {
    return fail(
      factFailure('invalid-type', `provider[${index}].source`, 'a SourceRef', typeof source),
    );
  }
  if (
    typeof amountMinor !== 'number' ||
    !Number.isInteger(amountMinor) ||
    amountMinor < 0 ||
    amountMinor > AMOUNT_BOUND
  ) {
    return fail(
      factFailure(
        'invalid-value',
        `provider[${index}].amountMinor`,
        `an integer amount in 0..${AMOUNT_BOUND} minor units`,
        String(amountMinor),
      ),
    );
  }
  // The source ref is re-validated through the SDK's trusted shape by the
  // coordinate derivation below (a malformed ref fails there, loudly).
  return ok({ source: source as SourceRef, amountMinor });
};

/** Fail-closed validation of one canonical balance fact (untrusted input). */
const checkCanonicalFact = (
  raw: unknown,
  index: number,
): Result<CanonicalBalanceFact, DomainError> => {
  if (!isPlainObject(raw)) {
    return fail(
      factFailure('invalid-type', `canonical[${index}]`, 'a canonical balance fact object', typeof raw),
    );
  }
  const canonical = raw['canonical'];
  if (
    typeof canonical !== 'object' ||
    canonical === null ||
    typeof (canonical as Record<string, unknown>)['entityKind'] !== 'string' ||
    typeof (canonical as Record<string, unknown>)['entityId'] !== 'string'
  ) {
    return fail(
      factFailure('invalid-type', `canonical[${index}].canonical`, 'an EntityRef', typeof canonical),
    );
  }
  const source = raw['source'];
  if (source !== null && (typeof source !== 'object' || source === null)) {
    return fail(
      factFailure('invalid-type', `canonical[${index}].source`, 'a SourceRef or null', typeof source),
    );
  }
  const recordedAmountMinor = raw['recordedAmountMinor'];
  if (recordedAmountMinor !== null && typeof recordedAmountMinor !== 'number') {
    return fail(
      factFailure(
        'invalid-type',
        `canonical[${index}].recordedAmountMinor`,
        'an integer amount in minor units or null',
        typeof recordedAmountMinor,
      ),
    );
  }
  if (
    typeof recordedAmountMinor === 'number' &&
    (!Number.isInteger(recordedAmountMinor) ||
      recordedAmountMinor < 0 ||
      recordedAmountMinor > AMOUNT_BOUND)
  ) {
    return fail(
      factFailure(
        'invalid-value',
        `canonical[${index}].recordedAmountMinor`,
        `an integer amount in 0..${AMOUNT_BOUND} minor units`,
        String(recordedAmountMinor),
      ),
    );
  }
  const canonicalVersion = raw['canonicalVersion'];
  const version = parseAggregateVersion(canonicalVersion);
  if (!version.ok) {
    return fail(
      factFailure(
        'invalid-value',
        `canonical[${index}].canonicalVersion`,
        'a positive integer aggregate version',
        String(canonicalVersion),
      ),
    );
  }
  return ok({
    canonical: canonical as EntityRef,
    source: source as SourceRef | null,
    recordedAmountMinor,
    canonicalVersion: version.value,
  });
};

const factFailure = (
  code: string,
  path: string,
  expected: string,
  received: string,
): DomainError =>
  domainError(
    'invariant-violation',
    `financial reconciliation input failed fail-closed parsing: ${code} at '${path}' (expected ${expected})`,
    [{ code: `reconciliation-input-${code}`, message: received, path }],
  );

/**
 * Reconcile the provider's financial balances against the canonical records
 * (PURE, DETERMINISTIC): join the two typed summaries on the source
 * coordinate, compare the amounts and the synchronized versions, and project
 * the per-reference comparisons + typed discrepancies. Input order never
 * matters: the comparisons and discrepancies come out in canonical
 * coordinate-key order, and office-native canonical facts in canonical-id
 * order. Duplicate facts for one coordinate on either side are typed
 * invariant-violations (ambiguous input, never a silent pick).
 */
/**
 * A mapped canonical fact: the join map inside reconcileFinanceBalances only
 * ever holds facts whose source is present (office-native facts never enter
 * it), so the canonical side of every joined comparison carries its
 * last-synchronized SourceRef by construction.
 */
type MappedCanonicalFact = CanonicalBalanceFact & { readonly source: SourceRef };

export function reconcileFinanceBalances(parts: {
  readonly tenantId: TenantId;
  /** The injected clock's instant recorded as reconciledAt/detectedAt. */
  readonly asOf: Timestamp;
  readonly provider: readonly unknown[];
  readonly canonical: readonly unknown[];
}): Result<FinanceReconciliationReport, DomainError> {
  const providerFacts = new Map<string, ProviderBalanceFact>();
  for (const [index, raw] of parts.provider.entries()) {
    const fact = checkProviderFact(raw, index);
    if (!fact.ok) return fact;
    const key = sourceCoordinateKeyOf(coordinateOf(fact.value.source));
    if (providerFacts.has(key)) {
      return fail(
        domainError(
          'invariant-violation',
          `duplicate provider balance fact for source coordinate ${key} — the reconciliation input is ambiguous`,
          [
            {
              code: 'reconciliation-input-duplicate',
              message: key,
              path: `provider[${index}]`,
            },
          ],
          { scope: { kind: 'tenant', tenantId: parts.tenantId } },
        ),
      );
    }
    providerFacts.set(key, fact.value);
  }

  const canonicalFacts = new Map<string, MappedCanonicalFact>();
  const officeNative: CanonicalBalanceFact[] = [];
  for (const [index, raw] of parts.canonical.entries()) {
    const fact = checkCanonicalFact(raw, index);
    if (!fact.ok) return fact;
    if (fact.value.source === null) {
      officeNative.push(fact.value);
      continue;
    }
    const key = sourceCoordinateKeyOf(coordinateOf(fact.value.source));
    if (canonicalFacts.has(key)) {
      return fail(
        domainError(
          'invariant-violation',
          `duplicate canonical balance fact for source coordinate ${key} — the reconciliation input is ambiguous`,
          [
            {
              code: 'reconciliation-input-duplicate',
              message: key,
              path: `canonical[${index}]`,
            },
          ],
          { scope: { kind: 'tenant', tenantId: parts.tenantId } },
        ),
      );
    }
    canonicalFacts.set(key, { ...fact.value, source: fact.value.source });
  }

  const coordinates = [...new Set([...providerFacts.keys(), ...canonicalFacts.keys()])].sort();
  const comparisons: BalanceComparison[] = [];
  const discrepancies: FinanceDiscrepancy[] = [];
  const counts = {
    providerReferences: providerFacts.size,
    canonicalReferences: canonicalFacts.size,
    officeNative: officeNative.length,
    matched: 0,
    discrepancies: 0,
    missingCanonical: 0,
    missingProvider: 0,
    amountMismatch: 0,
    versionDivergence: 0,
  };

  for (const key of coordinates) {
    const provider = providerFacts.get(key) ?? null;
    const canonical = canonicalFacts.get(key) ?? null;
    // canonicalFacts only holds mapped facts (office-native went to the
    // separate list), so the coordinate always exists on at least one side.
    const coordinate = provider !== null
      ? coordinateOf(provider.source)
      : coordinateOf((canonical as { readonly source: SourceRef }).source);
    if (provider !== null && canonical === null) {
      counts.missingCanonical += 1;
      counts.discrepancies += 1;
      comparisons.push({
        kind: 'balance-comparison',
        coordinate,
        provider,
        canonical: null,
        status: 'discrepant',
      });
      discrepancies.push({
        kind: 'finance-discrepancy',
        discrepancyKind: 'missing-canonical',
        tenantId: parts.tenantId,
        provider,
        canonical: null,
        expected: 'a canonical record bound to the provider reference',
        received: 'absent',
        detectedAt: parts.asOf,
      });
      continue;
    }

    if (provider === null && canonical !== null) {
      counts.missingProvider += 1;
      counts.discrepancies += 1;
      comparisons.push({
        kind: 'balance-comparison',
        coordinate,
        provider: null,
        canonical,
        status: 'discrepant',
      });
      discrepancies.push({
        kind: 'finance-discrepancy',
        discrepancyKind: 'missing-provider',
        tenantId: parts.tenantId,
        provider: null,
        canonical,
        expected: 'a provider reference for the canonical record',
        received: 'absent',
        detectedAt: parts.asOf,
      });
      continue;
    }

    // Both sides present: compare the amounts, then the versions.
    if (provider !== null && canonical !== null) {
      const canonicalSource = canonical.source;
      const amountsMatch =
        canonical.recordedAmountMinor !== null &&
        canonical.recordedAmountMinor === provider.amountMinor;
      if (!amountsMatch) {
        counts.amountMismatch += 1;
        counts.discrepancies += 1;
        comparisons.push({
          kind: 'balance-comparison',
          coordinate,
          provider,
          canonical,
          status: 'discrepant',
        });
        discrepancies.push({
          kind: 'finance-discrepancy',
          discrepancyKind: 'amount-mismatch',
          tenantId: parts.tenantId,
          provider,
          canonical,
          expected: `canonical recorded amount ${
            canonical.recordedAmountMinor === null
              ? 'not recorded'
              : `${canonical.recordedAmountMinor} minor units`
          }`,
          received: `provider amount ${provider.amountMinor} minor units`,
          detectedAt: parts.asOf,
        });
        continue;
      }

      if (provider.source.version !== canonicalSource.version) {
        counts.versionDivergence += 1;
        counts.discrepancies += 1;
        comparisons.push({
          kind: 'balance-comparison',
          coordinate,
          provider,
          canonical,
          status: 'discrepant',
        });
        discrepancies.push({
          kind: 'finance-discrepancy',
          discrepancyKind: 'version-divergence',
          tenantId: parts.tenantId,
          provider,
          canonical,
          expected: `canonical synchronized at provider version ${canonicalSource.version}`,
          received: `provider version ${provider.source.version}`,
          detectedAt: parts.asOf,
        });
        continue;
      }

      counts.matched += 1;
      comparisons.push({
        kind: 'balance-comparison',
        coordinate,
        provider,
        canonical,
        status: 'matched',
      });
    }
  }

  officeNative.sort((a, b) =>
    `${a.canonical.entityKind}|${a.canonical.entityId}`.localeCompare(
      `${b.canonical.entityKind}|${b.canonical.entityId}`,
    ),
  );

  return ok({
    kind: 'finance-reconciliation-report',
    tenantId: parts.tenantId,
    reconciledAt: parts.asOf,
    comparisons,
    discrepancies,
    officeNative,
    counts,
  } satisfies FinanceReconciliationReport);
}

