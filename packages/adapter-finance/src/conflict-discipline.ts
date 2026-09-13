// Office adapter-finance — the explicit conflict discipline (OFF-024).
//
// Financial state is MATERIAL commercial state: the frozen architecture
// forbids destructive automatic conflict resolution for it (no
// last-write-wins, ever). This module owns the finance-typed conflict
// records that discipline produces:
//
//   - a FinancialConflict carries BOTH sides — the provider side (the full
//     SourceRef INCLUDING the provider version, plus the disputed amount in
//     minor units) and the canonical side (the office EntityRef, its
//     aggregate version, plus its recorded amount) — for the three closed
//     reasons: 'amount-mismatch' (the reconciliation surface detected a
//     per-reference balance difference), 'concurrent-edit' (provider and
//     canonical both moved since the last synchronized point — recorded
//     alongside the SDK's engine-level Conflict), and 'reference-remap' (a
//     provider coordinate re-pointed at a different canonical id — the
//     mapping store's typed collision escalated to a first-class record);
//   - conflict ids are DERIVED deterministically from both sides (tenant,
//     reason, source ref, canonical ref/version, both amounts): re-detecting
//     the same divergence yields the same id, and appending it again is an
//     idempotent no-op; if either side moves, that is a NEW divergence pair
//     and a new record;
//   - records land in the 'detected' state and STAY there: NO detection path
//     resolves anything (structural — detection always composes state
//     'detected' with a null resolution);
//   - resolution is an EXPLICIT typed command: resolveFinancialConflict
//     requires a closed strategy plus the idempotency keys of the canonical
//     commands that performed the reconciliation (at least one, no
//     duplicates). Resolving an already-resolved conflict identically is an
//     idempotent replay; resolving it differently is a typed
//     invariant-violation. There is no other resolution path — the package's
//     public surface pins exactly one.
import { createHash } from 'node:crypto';
import {
  parseActor,
  parseEntityRef,
  parseFail,
  parseIdempotencyKey,
  parseOk,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  EntityRef,
  IdempotencyKey,
  ParseResult,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, ok, parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { parseSourceRef, sourceRefKeyOf } from '@office/adapters-sdk';
import type { SourceCoordinate, SourceRef } from '@office/adapters-sdk';
import type { FinanceDiscrepancy, FinanceReconciliationReport } from './reconciliation';
import {
  describeValue,
  isPlainObject,
  parseValueArray,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';

declare const financialConflictIdBrand: unique symbol;

/** Deterministic identity of one financial conflict: office-fincfl-v1-<opaque>. */
export type FinancialConflictId = string & {
  readonly [financialConflictIdBrand]: 'FinancialConflictId';
};

/** Grammar description used in parse failures. */
export const FINANCIAL_CONFLICT_ID_GRAMMAR =
  'office-fincfl-v1-<opaque: 16..64 lowercase alphanumeric> (derived deterministically from both sides, amounts included)';

/** The closed reason vocabulary of financial conflicts. */
export type FinancialConflictReason = 'amount-mismatch' | 'concurrent-edit' | 'reference-remap';

/** The provider side of a financial conflict: the source ref and its amount. */
export interface FinancialConflictProviderSide {
  /** The provider object's full identity at the observed version. */
  readonly source: SourceRef;
  /** The provider's amount in minor units (null when the dispute is not about an amount). */
  readonly amountMinor: number | null;
}

/** The canonical side of a financial conflict: the entity, its amount, its version. */
export interface FinancialConflictCanonicalSide {
  /** The office entity the provider source maps to. */
  readonly canonical: EntityRef;
  /** The canonical recorded amount in minor units (null when not recorded / not the dispute). */
  readonly amountMinor: number | null;
  /** The canonical aggregate version at detection. */
  readonly canonicalVersion: AggregateVersion;
}

/** The closed resolution-strategy vocabulary. */
export type FinancialConflictResolutionStrategy =
  | 'adopt-provider-value'
  | 'retain-canonical-value'
  | 'manual-merge';

/** The explicit resolution: strategy, actor, time, and the typed commands. */
export interface FinancialConflictResolution {
  readonly kind: 'financial-conflict-resolution';
  /** How the divergence was reconciled (closed vocabulary). */
  readonly strategy: FinancialConflictResolutionStrategy;
  /** The actor that explicitly resolved the conflict. */
  readonly resolvedBy: Actor;
  /** When the resolution was recorded (injected clock). */
  readonly resolvedAt: Timestamp;
  /**
   * Idempotency keys of the canonical commands that performed the
   * reconciliation — at least one, no duplicates. Resolution IS those typed
   * commands; a resolution without its command trail is typed-rejected.
   */
  readonly resolutionCommandKeys: readonly IdempotencyKey[];
}

/** Lifecycle state of a financial conflict record. */
export type FinancialConflictState = 'detected' | 'resolved';

/** The explicit finance-typed divergence record: both sides + resolution state. */
export interface FinancialConflict {
  readonly kind: 'financial-conflict';
  /** Deterministic identity (derived from both sides — see financialConflictIdOf). */
  readonly conflictId: FinancialConflictId;
  /** Owning tenant (freeze A12). */
  readonly tenantId: TenantId;
  /** Which closed reason produced the record. */
  readonly reason: FinancialConflictReason;
  /** The provider side (the full SourceRef plus the disputed amount). */
  readonly provider: FinancialConflictProviderSide;
  /** The canonical side (the office entity, amount, and aggregate version). */
  readonly canonical: FinancialConflictCanonicalSide;
  /** For reference-remap conflicts: the canonical id the remap attempted; else null. */
  readonly attemptedCanonical: EntityRef | null;
  /** When the divergence was detected (injected clock of the detecting surface). */
  readonly detectedAt: Timestamp;
  /** The adapter actor whose surface detected the divergence. */
  readonly detectedBy: Actor;
  /** Lifecycle state: records land 'detected' and are resolved only explicitly. */
  readonly state: FinancialConflictState;
  /** The resolution, exactly when state === 'resolved' (else null). */
  readonly resolution: FinancialConflictResolution | null;
}

/** Shape description used in parse failures. */
export const FINANCIAL_CONFLICT_RESOLUTION_GRAMMAR =
  "FinancialConflictResolution: { kind: 'financial-conflict-resolution', strategy: 'adopt-provider-value' | 'retain-canonical-value' | 'manual-merge', resolvedBy, resolvedAt, resolutionCommandKeys: IdempotencyKey[] (>= 1, no duplicates) }";

/** Shape description used in parse failures. */
export const FINANCIAL_CONFLICT_GRAMMAR =
  'FinancialConflict: { kind, conflictId, tenantId, reason, provider: { source, amountMinor }, canonical: { canonical, amountMinor, canonicalVersion }, attemptedCanonical, detectedAt, detectedBy, state, resolution }';

const FINANCIAL_CONFLICT_RESOLUTION_KEYS = [
  'kind',
  'strategy',
  'resolvedBy',
  'resolvedAt',
  'resolutionCommandKeys',
] as const;
const FINANCIAL_CONFLICT_KEYS = [
  'kind',
  'conflictId',
  'tenantId',
  'reason',
  'provider',
  'canonical',
  'attemptedCanonical',
  'detectedAt',
  'detectedBy',
  'state',
  'resolution',
] as const;

const FINANCIAL_CONFLICT_ID_PREFIX = 'office-fincfl-v1-';
const FINANCIAL_CONFLICT_ID_PATTERN = /^[0-9a-z]{16,64}$/;
const DERIVED_OPAQUE_LENGTH = 32;
const AMOUNT_BOUND = 1_000_000_000_000;

/** Parse an untrusted value as a FinancialConflictId (total, fail-closed). */
export function parseFinancialConflictId(raw: unknown): ParseResult<FinancialConflictId> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(FINANCIAL_CONFLICT_ID_PREFIX) ||
    !FINANCIAL_CONFLICT_ID_PATTERN.test(raw.slice(FINANCIAL_CONFLICT_ID_PREFIX.length))
  ) {
    return parseFail('invalid-value', '', FINANCIAL_CONFLICT_ID_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as FinancialConflictId);
}

/** Type guard for structurally valid FinancialConflictId values. */
export function isFinancialConflictId(raw: unknown): raw is FinancialConflictId {
  return parseFinancialConflictId(raw).ok;
}

/** Compose a FinancialConflictId from a validated literal (trusted path). */
export function financialConflictId(raw: string): FinancialConflictId {
  const parsed = parseFinancialConflictId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid financial conflict id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/**
 * Both sides of one financial divergence — the derivation input of a
 * financial conflict id. Identical sides derive identical ids (re-detection
 * is idempotent); a moved amount, version, or canonical binding on either
 * side derives a NEW id (a conflict pins the exact pair it detected).
 */
export interface FinancialConflictSides {
  readonly tenantId: TenantId;
  readonly reason: FinancialConflictReason;
  readonly provider: FinancialConflictProviderSide;
  readonly canonical: FinancialConflictCanonicalSide;
  readonly attemptedCanonical: EntityRef | null;
}

/**
 * Derive the financial conflict id of a divergence pair (deterministic,
 * pure): the first 32 hex characters of sha256 over the canonical JSON of
 * [tenant, reason, source ref key, canonical kind/id/version, provider
 * amount, canonical amount, attempted canonical id].
 */
export function financialConflictIdOf(sides: FinancialConflictSides): FinancialConflictId {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        sides.tenantId,
        sides.reason,
        sourceRefKeyOf(sides.provider.source),
        sides.canonical.canonical.entityKind,
        sides.canonical.canonical.entityId,
        sides.canonical.canonicalVersion,
        sides.provider.amountMinor,
        sides.canonical.amountMinor,
        sides.attemptedCanonical === null
          ? null
          : `${sides.attemptedCanonical.entityKind}|${sides.attemptedCanonical.entityId}`,
      ]),
      'utf8',
    )
    .digest('hex')
    .slice(0, DERIVED_OPAQUE_LENGTH);
  return financialConflictId(`${FINANCIAL_CONFLICT_ID_PREFIX}${digest}`);
}

// ---- fail-closed parsing (the presented-record boundary) --------------------

/** Parse an untrusted value as a FinancialConflictResolution (strict keys). */
export function parseFinancialConflictResolution(
  raw: unknown,
): ParseResult<FinancialConflictResolution> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', FINANCIAL_CONFLICT_RESOLUTION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    FINANCIAL_CONFLICT_RESOLUTION_KEYS,
    '',
    FINANCIAL_CONFLICT_RESOLUTION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['financial-conflict-resolution']);
  if (!kind.ok) return kind;
  const strategy = requireLiteral(raw, 'strategy', '', [
    'adopt-provider-value',
    'retain-canonical-value',
    'manual-merge',
  ]);
  if (!strategy.ok) return strategy;
  const resolvedBy = requireFieldWith(raw, 'resolvedBy', '', parseActor);
  if (!resolvedBy.ok) return resolvedBy;
  const resolvedAt = requireFieldWith(raw, 'resolvedAt', '', parseTimestamp);
  if (!resolvedAt.ok) return resolvedAt;
  const resolutionCommandKeys = parseValueArray(
    raw['resolutionCommandKeys'],
    'resolutionCommandKeys',
    parseIdempotencyKey,
    'array of distinct canonical command idempotency keys proving the reconciliation (>= 1)',
  );
  if (!resolutionCommandKeys.ok) return resolutionCommandKeys;
  if (resolutionCommandKeys.value.length < 1) {
    return parseFail(
      'invalid-value',
      'resolutionCommandKeys',
      'at least one command idempotency key (a resolution without its command trail is rejected)',
      'empty array',
    );
  }
  return parseOk({
    kind: 'financial-conflict-resolution',
    strategy: strategy.value as FinancialConflictResolutionStrategy,
    resolvedBy: resolvedBy.value,
    resolvedAt: resolvedAt.value,
    resolutionCommandKeys: resolutionCommandKeys.value,
  } satisfies FinancialConflictResolution);
}

/** Type guard for structurally valid FinancialConflictResolution values. */
export function isFinancialConflictResolution(
  raw: unknown,
): raw is FinancialConflictResolution {
  return parseFinancialConflictResolution(raw).ok;
}

/** Parse an untrusted value as a FinancialConflict (total, fail-closed, strict keys). */
export function parseFinancialConflict(raw: unknown): ParseResult<FinancialConflict> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', FINANCIAL_CONFLICT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, FINANCIAL_CONFLICT_KEYS, '', FINANCIAL_CONFLICT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['financial-conflict']);
  if (!kind.ok) return kind;
  const conflictId = requireFieldWith(raw, 'conflictId', '', parseFinancialConflictId);
  if (!conflictId.ok) return conflictId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const reason = requireLiteral(raw, 'reason', '', [
    'amount-mismatch',
    'concurrent-edit',
    'reference-remap',
  ]);
  if (!reason.ok) return reason;
  const provider = parseProviderSide(raw['provider']);
  if (!provider.ok) return provider;
  const canonical = parseCanonicalSide(raw['canonical']);
  if (!canonical.ok) return canonical;
  const attemptedCanonical = requireNullableFieldWith(raw, 'attemptedCanonical', '', parseEntityRef);
  if (!attemptedCanonical.ok) return attemptedCanonical;
  const detectedAt = requireFieldWith(raw, 'detectedAt', '', parseTimestamp);
  if (!detectedAt.ok) return detectedAt;
  const detectedBy = requireFieldWith(raw, 'detectedBy', '', parseActor);
  if (!detectedBy.ok) return detectedBy;
  const state = requireLiteral(raw, 'state', '', ['detected', 'resolved']);
  if (!state.ok) return state;
  const resolution = requireNullableFieldWith(
    raw,
    'resolution',
    '',
    parseFinancialConflictResolution,
  );
  if (!resolution.ok) return resolution;
  if ((state.value === 'resolved') !== (resolution.value !== null)) {
    return parseFail(
      'invalid-value',
      'resolution',
      'present exactly when state is resolved (null otherwise)',
      `state '${state.value}' with resolution ${resolution.value === null ? 'null' : 'present'}`,
    );
  }
  return parseOk({
    kind: 'financial-conflict',
    conflictId: conflictId.value,
    tenantId: tenantId.value,
    reason: reason.value as FinancialConflictReason,
    provider: provider.value,
    canonical: canonical.value,
    attemptedCanonical: attemptedCanonical.value,
    detectedAt: detectedAt.value,
    detectedBy: detectedBy.value,
    state: state.value as FinancialConflictState,
    resolution: resolution.value,
  } satisfies FinancialConflict);
}

/** Type guard for structurally valid FinancialConflict values. */
export function isFinancialConflict(raw: unknown): raw is FinancialConflict {
  return parseFinancialConflict(raw).ok;
}

const parseProviderSide = (raw: unknown): ParseResult<FinancialConflictProviderSide> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'a provider side object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['source', 'amountMinor'], '', 'provider side { source, amountMinor }');
  if (unknownKey) return unknownKey;
  const source = requireFieldWith(raw, 'source', '', parseSourceRef);
  if (!source.ok) return source;
  const amount = requireNullableFieldWith(raw, 'amountMinor', '', parseBoundedAmount);
  if (!amount.ok) return amount;
  return parseOk({ source: source.value, amountMinor: amount.value });
};

const parseCanonicalSide = (raw: unknown): ParseResult<FinancialConflictCanonicalSide> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'a canonical side object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    ['canonical', 'amountMinor', 'canonicalVersion'],
    '',
    'canonical side { canonical, amountMinor, canonicalVersion }',
  );
  if (unknownKey) return unknownKey;
  const canonical = requireFieldWith(raw, 'canonical', '', parseEntityRef);
  if (!canonical.ok) return canonical;
  const amount = requireNullableFieldWith(raw, 'amountMinor', '', parseBoundedAmount);
  if (!amount.ok) return amount;
  const canonicalVersion = requireFieldWith(raw, 'canonicalVersion', '', parseAggregateVersion);
  if (!canonicalVersion.ok) return canonicalVersion;
  return parseOk({
    canonical: canonical.value,
    amountMinor: amount.value,
    canonicalVersion: canonicalVersion.value,
  });
};

const parseBoundedAmount = (raw: unknown): ParseResult<number> => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > AMOUNT_BOUND) {
    return parseFail(
      'invalid-value',
      '',
      `an integer amount in 0..${AMOUNT_BOUND} minor units`,
      String(raw),
    );
  }
  return parseOk(raw);
};

// ---- the detectors (detection never resolves) -------------------------------

/** Compose the DETECTED record of one divergence pair (trusted path). */
const detectedRecord = (parts: {
  readonly tenantId: TenantId;
  readonly reason: FinancialConflictReason;
  readonly provider: FinancialConflictProviderSide;
  readonly canonical: FinancialConflictCanonicalSide;
  readonly attemptedCanonical: EntityRef | null;
  readonly detectedAt: Timestamp;
  readonly detectedBy: Actor;
}): FinancialConflict => ({
  kind: 'financial-conflict',
  conflictId: financialConflictIdOf(parts),
  tenantId: parts.tenantId,
  reason: parts.reason,
  provider: parts.provider,
  canonical: parts.canonical,
  attemptedCanonical: parts.attemptedCanonical,
  detectedAt: parts.detectedAt,
  detectedBy: parts.detectedBy,
  state: 'detected',
  resolution: null,
});

/**
 * Build the DETECTED financial conflict of one amount-mismatch discrepancy
 * from a reconciliation report (both sides with their amounts — the provider
 * amount and the canonical recorded amount, null recorded amounts included).
 */
export function detectedAmountMismatchConflict(parts: {
  readonly discrepancy: FinanceDiscrepancy;
  readonly detectedAt: Timestamp;
  readonly detectedBy: Actor;
}): Result<FinancialConflict, DomainError> {
  const discrepancy = parts.discrepancy;
  if (discrepancy.discrepancyKind !== 'amount-mismatch') {
    return fail(
      domainError(
        'invariant-violation',
        `an amount-mismatch conflict is built from an amount-mismatch discrepancy, received '${discrepancy.discrepancyKind}' — the other discrepancy kinds are not financial conflicts`,
        [
          {
            code: 'conflict-reason-mismatch',
            message: discrepancy.discrepancyKind,
            path: 'discrepancyKind',
          },
        ],
        { scope: { kind: 'tenant', tenantId: discrepancy.tenantId } },
      ),
    );
  }
  const provider = discrepancy.provider;
  const canonical = discrepancy.canonical;
  if (provider === null || canonical === null) {
    // An amount-mismatch discrepancy always carries both sides by
    // construction (reconcileFinanceBalances); a malformed one is a module
    // defect surfaced as a typed invariant-violation.
    return fail(
      domainError(
        'invariant-violation',
        'an amount-mismatch discrepancy must carry both sides (provider and canonical facts)',
        [{ code: 'conflict-sides-missing', message: 'amount-mismatch', path: 'discrepancy' }],
        { scope: { kind: 'tenant', tenantId: discrepancy.tenantId } },
      ),
    );
  }
  return ok(
    detectedRecord({
      tenantId: discrepancy.tenantId,
      reason: 'amount-mismatch',
      provider: { source: provider.source, amountMinor: provider.amountMinor },
      canonical: {
        canonical: canonical.canonical,
        amountMinor: canonical.recordedAmountMinor,
        canonicalVersion: canonical.canonicalVersion,
      },
      attemptedCanonical: null,
      detectedAt: parts.detectedAt,
      detectedBy: parts.detectedBy,
    }),
  );
}

/**
 * Build the DETECTED financial conflict of a concurrent edit: the provider
 * moved a source to a new version while the canonical aggregate moved
 * independently since the last synchronized point (both sides' versions are
 * the record; the amounts are null unless the caller observed them).
 */
export function detectedConcurrentEditConflict(parts: {
  readonly tenantId: TenantId;
  readonly source: SourceRef;
  readonly canonical: EntityRef;
  readonly canonicalVersion: AggregateVersion;
  readonly providerAmountMinor: number | null;
  readonly canonicalAmountMinor: number | null;
  readonly detectedAt: Timestamp;
  readonly detectedBy: Actor;
}): FinancialConflict {
  return detectedRecord({
    tenantId: parts.tenantId,
    reason: 'concurrent-edit',
    provider: { source: parts.source, amountMinor: parts.providerAmountMinor },
    canonical: {
      canonical: parts.canonical,
      amountMinor: parts.canonicalAmountMinor,
      canonicalVersion: parts.canonicalVersion,
    },
    attemptedCanonical: null,
    detectedAt: parts.detectedAt,
    detectedBy: parts.detectedBy,
  });
}

/**
 * Build the DETECTED financial conflict of a reference remap attempt: a
 * provider coordinate already bound to one canonical id was re-pointed at a
 * different id (`attemptedCanonical`) — the mapping store's typed collision
 * escalated to a first-class record. The original binding is NEVER
 * overwritten.
 */
export function detectedReferenceRemapConflict(parts: {
  readonly tenantId: TenantId;
  readonly source: SourceRef;
  readonly existingCanonical: EntityRef;
  readonly existingCanonicalVersion: AggregateVersion;
  readonly attemptedCanonical: EntityRef;
  readonly detectedAt: Timestamp;
  readonly detectedBy: Actor;
}): FinancialConflict {
  return detectedRecord({
    tenantId: parts.tenantId,
    reason: 'reference-remap',
    provider: { source: parts.source, amountMinor: null },
    canonical: {
      canonical: parts.existingCanonical,
      amountMinor: null,
      canonicalVersion: parts.existingCanonicalVersion,
    },
    attemptedCanonical: parts.attemptedCanonical,
    detectedAt: parts.detectedAt,
    detectedBy: parts.detectedBy,
  });
}

/**
 * The explicit financial conflicts of one reconciliation report's
 * amount-mismatch discrepancies (deterministic, in report order).
 */
export function amountMismatchConflictsOf(
  report: FinanceReconciliationReport,
  parts: {
    readonly detectedAt: Timestamp;
    readonly detectedBy: Actor;
  },
): readonly FinancialConflict[] {
  const conflicts: FinancialConflict[] = [];
  for (const discrepancy of report.discrepancies) {
    if (discrepancy.discrepancyKind !== 'amount-mismatch') continue;
    const detected = detectedAmountMismatchConflict({
      discrepancy,
      detectedAt: parts.detectedAt,
      detectedBy: parts.detectedBy,
    });
    // The report's discrepancies are validated inputs — a failure here is a
    // module defect, and detectedAmountMismatchConflict cannot fail for the
    // kind we just checked.
    if (detected.ok) conflicts.push(detected.value);
  }
  return conflicts;
}

// ---- the store port + the explicit resolution path --------------------------

/**
 * Storage port for financial conflicts. Implementations MUST key by tenant
 * (A12 — foreign tenants' conflicts are invisible, no existence oracle) and
 * MUST keep append idempotent per divergence pair.
 */
export interface FinancialConflictStore {
  /**
   * Append a detected conflict. Appending the SAME divergence pair again is
   * an idempotent no-op returning the existing record; appending a different
   * pair under an existing id is a typed invariant-violation.
   */
  append(conflict: FinancialConflict): Promise<Result<FinancialConflict, DomainError>>;
  /** The tenant's conflict by id, or null when absent (tenant-scoped). */
  findById(
    tenantId: TenantId,
    conflictId: FinancialConflictId,
  ): Promise<FinancialConflict | null>;
  /** The tenant's conflicts for one provider coordinate, insertion order. */
  listBySource(
    tenantId: TenantId,
    coordinate: SourceCoordinate,
  ): Promise<readonly FinancialConflict[]>;
  /** Persist an explicitly resolved record (see resolveFinancialConflict). */
  recordResolution(resolved: FinancialConflict): Promise<Result<FinancialConflict, DomainError>>;
}

/** Deterministic in-memory FinancialConflictStore (the package's test fixture). */
export function createInMemoryFinancialConflictStore(): FinancialConflictStore {
  const byId = new Map<string, FinancialConflict>();
  const bySource = new Map<string, FinancialConflict[]>();
  const sourceKey = (tenantId: TenantId, coordinate: SourceCoordinate): string =>
    `${tenantId}|${coordinate.adapterKind}|${coordinate.systemId}|${coordinate.objectType}|${coordinate.objectId}`;
  const index = (conflict: FinancialConflict): void => {
    const key = sourceKey(conflict.tenantId, conflict.provider.source);
    const list = bySource.get(key) ?? [];
    const withoutThisId = list.filter((entry) => entry.conflictId !== conflict.conflictId);
    bySource.set(key, [...withoutThisId, conflict]);
  };
  return {
    async append(conflict) {
      const existing = byId.get(conflict.conflictId);
      if (existing !== undefined) {
        if (sameSides(existing, conflict)) return ok(existing);
        return fail(
          domainError(
            'invariant-violation',
            `financial conflict id ${conflict.conflictId} already records a different divergence pair — ids are derived from both sides, amounts included`,
            [
              {
                code: 'financial-conflict-id-collision',
                message: conflict.conflictId,
                path: 'conflictId',
              },
            ],
            { scope: { kind: 'tenant', tenantId: conflict.tenantId } },
          ),
        );
      }
      byId.set(conflict.conflictId, conflict);
      index(conflict);
      return ok(conflict);
    },
    async findById(tenantId, conflictId) {
      const found = byId.get(conflictId);
      return found !== undefined && found.tenantId === tenantId ? found : null;
    },
    async listBySource(tenantId, coordinate) {
      return [...(bySource.get(sourceKey(tenantId, coordinate)) ?? [])];
    },
    async recordResolution(resolved) {
      const existing = byId.get(resolved.conflictId);
      if (existing === undefined || !sameSides(existing, resolved)) {
        return fail(
          domainError(
            'not-found',
            `financial conflict ${resolved.conflictId} is not recorded for this divergence pair — resolution cites a detected conflict, never invents one`,
            [
              {
                code: 'financial-conflict-not-found',
                message: resolved.conflictId,
                path: 'conflictId',
              },
            ],
            { scope: { kind: 'tenant', tenantId: resolved.tenantId } },
          ),
        );
      }
      if (existing.state === 'resolved') {
        if (
          existing.resolution !== null &&
          resolved.resolution !== null &&
          sameResolution(existing.resolution, resolved.resolution)
        ) {
          return ok(existing); // idempotent replay
        }
        return fail(alreadyResolved(existing));
      }
      byId.set(resolved.conflictId, resolved);
      index(resolved);
      return ok(resolved);
    },
  };
}

/**
 * Resolve a financial conflict EXPLICITLY — the ONLY resolution path (there
 * is no other: detection always lands 'detected', and no exported function
 * composes a resolved record but this one). The strategy must come from the
 * closed vocabulary, the resolution must cite the idempotency keys of the
 * canonical commands that performed the reconciliation (at least one, no
 * duplicates — typed rejections otherwise), and the actual reconciliation
 * happens through those canonical commands BEFORE the resolution is
 * recorded: the keys are its evidence. Resolving an already-resolved
 * conflict IDENTICALLY is an idempotent replay; resolving it differently is
 * a typed invariant-violation. NEVER automatic: no strategy is chosen by the
 * engine, the store, or the reconciliation.
 */
export async function resolveFinancialConflict(parts: {
  readonly store: FinancialConflictStore;
  readonly conflict: FinancialConflict;
  readonly strategy: FinancialConflictResolutionStrategy;
  readonly resolvedBy: Actor;
  readonly resolutionCommandKeys: readonly IdempotencyKey[];
  readonly now: Timestamp;
}): Promise<Result<FinancialConflict, DomainError>> {
  const resolutionInput = {
    kind: 'financial-conflict-resolution',
    strategy: parts.strategy,
    resolvedBy: parts.resolvedBy,
    resolvedAt: parts.now,
    resolutionCommandKeys: parts.resolutionCommandKeys,
  } satisfies FinancialConflictResolution;
  const parsed = parseFinancialConflictResolution(resolutionInput);
  if (!parsed.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `invalid financial conflict resolution: ${parsed.error.code} at '${parsed.error.path}' (${parsed.error.expected}; received ${parsed.error.received})`,
        [
          {
            code: `financial-conflict-resolution-${parsed.error.code}`,
            message: parsed.error.received,
            path: parsed.error.path === '' ? null : parsed.error.path,
          },
        ],
        { scope: { kind: 'tenant', tenantId: parts.conflict.tenantId } },
      ),
    );
  }
  if (parts.conflict.state === 'resolved') {
    const existing = parts.conflict.resolution;
    if (existing !== null && sameResolution(existing, parsed.value)) {
      return ok(parts.conflict); // idempotent replay of the identical resolution
    }
    return fail(alreadyResolved(parts.conflict));
  }
  const resolved: FinancialConflict = {
    ...parts.conflict,
    state: 'resolved',
    resolution: parsed.value,
  };
  return parts.store.recordResolution(resolved);
}

// ---- local comparison helpers ------------------------------------------------

/** The exact parts of a conflict its id was derived from (identity check). */
const sidesOf = (conflict: FinancialConflict): FinancialConflictSides => ({
  tenantId: conflict.tenantId,
  reason: conflict.reason,
  provider: conflict.provider,
  canonical: conflict.canonical,
  attemptedCanonical: conflict.attemptedCanonical,
});

/** Do two records describe the same divergence pair (id derivation input)? */
const sameSides = (a: FinancialConflict, b: FinancialConflict): boolean =>
  financialConflictIdOf(sidesOf(a)) === financialConflictIdOf(sidesOf(b)) &&
  a.tenantId === b.tenantId &&
  a.reason === b.reason &&
  sourceRefKeyOf(a.provider.source) === sourceRefKeyOf(b.provider.source) &&
  a.provider.amountMinor === b.provider.amountMinor &&
  a.canonical.canonical.entityKind === b.canonical.canonical.entityKind &&
  a.canonical.canonical.entityId === b.canonical.canonical.entityId &&
  a.canonical.amountMinor === b.canonical.amountMinor &&
  a.canonical.canonicalVersion === b.canonical.canonicalVersion &&
  a.attemptedCanonical?.entityId === b.attemptedCanonical?.entityId;

/** Do two resolutions carry the same explicit decision (idempotent replay)? */
const sameResolution = (a: FinancialConflictResolution, b: FinancialConflictResolution): boolean =>
  a.strategy === b.strategy &&
  JSON.stringify(a.resolvedBy) === JSON.stringify(b.resolvedBy) &&
  a.resolutionCommandKeys.length === b.resolutionCommandKeys.length &&
  a.resolutionCommandKeys.every((key, index) => key === b.resolutionCommandKeys[index]);

const alreadyResolved = (conflict: FinancialConflict): DomainError =>
  domainError(
    'invariant-violation',
    `financial conflict ${conflict.conflictId} is already resolved (${conflict.resolution?.strategy ?? 'unknown'} strategy) — a material commercial conflict is resolved exactly once`,
    [
      {
        code: 'financial-conflict-already-resolved',
        message: conflict.conflictId,
        path: 'state',
      },
    ],
    { scope: { kind: 'tenant', tenantId: conflict.tenantId } },
  );
