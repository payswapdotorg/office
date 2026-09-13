// Office marketplace — THE typed audit ledger (OFF-027).
//
// Every lifecycle transition the marketplace performs lands here as one
// immutable, typed audit record: publisher registered/revoked, release
// published, entitlement granted/revoked, installation linked/unlinked,
// update staged/applied/rolled back. The record carries the full provenance
// the acceptance demands — WHO (the acting Actor), WHAT (the closed
// transition vocabulary + the closed JSON-safe detail shape), WHEN (the
// injected clock's instant), WHERE (the owning tenant) — and its identity is
// DERIVED deterministically from (transition, subject, instant), so two
// identical runs of the same lifecycle scenario produce byte-identical
// ledgers.
//
// This is the marketplace's OWN ledger, deliberately NOT the canonical
// events ledger: the marketplace never issues canonical events (freeze
// A11 — marketplace metadata is never canonical project state). Records go
// to an INJECTED sink; a failing append aborts the surrounding operation —
// no audit, no committed effect (the app-runtime sink convention).
import { parseActor, parseFail, parseOk, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { auditRecordIdOf, parseAuditRecordId } from './identity';
import type { AuditRecordId } from './identity';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireString,
  unknownKeyFailure,
  parseArrayWith,
} from './parse';

// ----- the transition vocabulary -----------------------------------------------------------

/**
 * Every auditable marketplace lifecycle transition (closed vocabulary, in
 * lifecycle order): the golden scenario publish → entitle → install-link →
 * update (stage + apply) → rollback → uninstall → publisher revoke exercises
 * all ten.
 */
export type MarketplaceTransition =
  | 'publisher-registered'
  | 'publisher-revoked'
  | 'release-published'
  | 'entitlement-granted'
  | 'entitlement-revoked'
  | 'installation-linked'
  | 'update-staged'
  | 'update-applied'
  | 'update-rolled-back'
  | 'installation-unlinked';

/** Every transition, in vocabulary order. */
export const MARKETPLACE_TRANSITIONS: readonly MarketplaceTransition[] = [
  'publisher-registered',
  'publisher-revoked',
  'release-published',
  'entitlement-granted',
  'entitlement-revoked',
  'installation-linked',
  'update-staged',
  'update-applied',
  'update-rolled-back',
  'installation-unlinked',
] as const;

/** Grammar description used in parse failures. */
export const MARKETPLACE_TRANSITION_GRAMMAR =
  "MarketplaceTransition: one of the ten auditable marketplace lifecycle transitions (publisher-registered, publisher-revoked, release-published, entitlement-granted, entitlement-revoked, installation-linked, update-staged, update-applied, update-rolled-back, installation-unlinked)";

// ----- the audit detail --------------------------------------------------------------------

/**
 * The closed, JSON-safe detail of an audit record: the subject identities
 * the transition touched (null when the transition does not involve them)
 * and the version move / permission-delta summary an update review needs.
 * Capability summaries render as '<capability>@<scope-kind>'.
 */
export interface MarketplaceAuditDetail {
  /** The app the transition concerns, or null. */
  readonly appId: string | null;
  /** The manifest version published/installed-from/installed-to, or null. */
  readonly manifestVersion: string | null;
  /** The release id published/installed, or null. */
  readonly releaseId: string | null;
  /** The publisher id registered/revoked/publishing, or null. */
  readonly publisherId: string | null;
  /** The entitlement id granted/revoked/founding the installation, or null. */
  readonly entitlementId: string | null;
  /** The canonical installation id linked, or null. */
  readonly installationId: string | null;
  /** The installation-link id, or null. */
  readonly linkId: string | null;
  /** The update id staged/applied/rolled back, or null. */
  readonly updateId: string | null;
  /** The version an update/rollback moved FROM, or null. */
  readonly fromVersion: string | null;
  /** The version an update/rollback moved TO, or null. */
  readonly toVersion: string | null;
  /** Added capability summaries of the reviewed permission delta. */
  readonly addedCapabilities: readonly string[];
  /** Removed capability summaries of the reviewed permission delta. */
  readonly removedCapabilities: readonly string[];
  /** The fresh grant confirmations an applied update accepted. */
  readonly confirmations: readonly string[];
}

/** Grammar description used in parse failures. */
export const MARKETPLACE_AUDIT_DETAIL_GRAMMAR =
  'MarketplaceAuditDetail: { appId, manifestVersion, releaseId, publisherId, entitlementId, installationId, linkId, updateId, fromVersion, toVersion, addedCapabilities, removedCapabilities, confirmations } — string-or-null subject fields plus string arrays';

const AUDIT_DETAIL_KEYS = [
  'appId',
  'manifestVersion',
  'releaseId',
  'publisherId',
  'entitlementId',
  'installationId',
  'linkId',
  'updateId',
  'fromVersion',
  'toVersion',
  'addedCapabilities',
  'removedCapabilities',
  'confirmations',
] as const;

const NULLABLE_STRING_FIELDS = [
  'appId',
  'manifestVersion',
  'releaseId',
  'publisherId',
  'entitlementId',
  'installationId',
  'linkId',
  'updateId',
  'fromVersion',
  'toVersion',
] as const;

const STRING_LIST_FIELDS = [
  'addedCapabilities',
  'removedCapabilities',
  'confirmations',
] as const;

/** Parse an untrusted value as a MarketplaceAuditDetail (total, fail-closed). */
export function parseMarketplaceAuditDetail(
  raw: unknown,
): ParseResult<MarketplaceAuditDetail> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', MARKETPLACE_AUDIT_DETAIL_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, AUDIT_DETAIL_KEYS, '', MARKETPLACE_AUDIT_DETAIL_GRAMMAR);
  if (unknownKey) return unknownKey;
  const fields: Record<string, string | null> = {};
  for (const field of NULLABLE_STRING_FIELDS) {
    const value = raw[field];
    if (value === undefined) {
      return parseFail('missing-field', field, MARKETPLACE_AUDIT_DETAIL_GRAMMAR, 'undefined');
    }
    if (value !== null && typeof value !== 'string') {
      return parseFail('invalid-type', field, 'string or null', describeValue(value));
    }
    fields[field] = value;
  }
  const lists: Record<string, readonly string[]> = {};
  for (const field of STRING_LIST_FIELDS) {
    const parsed = parseArrayWith(
      raw[field],
      field,
      (item: unknown) =>
        typeof item === 'string'
          ? parseOk(item)
          : parseFail('invalid-type', '', 'string', describeValue(item)),
      MARKETPLACE_AUDIT_DETAIL_GRAMMAR,
    );
    if (!parsed.ok) return parsed;
    lists[field] = parsed.value;
  }
  return parseOk({
    appId: fields['appId'] ?? null,
    manifestVersion: fields['manifestVersion'] ?? null,
    releaseId: fields['releaseId'] ?? null,
    publisherId: fields['publisherId'] ?? null,
    entitlementId: fields['entitlementId'] ?? null,
    installationId: fields['installationId'] ?? null,
    linkId: fields['linkId'] ?? null,
    updateId: fields['updateId'] ?? null,
    fromVersion: fields['fromVersion'] ?? null,
    toVersion: fields['toVersion'] ?? null,
    addedCapabilities: lists['addedCapabilities'] ?? [],
    removedCapabilities: lists['removedCapabilities'] ?? [],
    confirmations: lists['confirmations'] ?? [],
  } satisfies MarketplaceAuditDetail);
}

// ----- the audit record --------------------------------------------------------------------

/** Grammar description used in parse failures. */
export const MARKETPLACE_AUDIT_RECORD_GRAMMAR =
  "MarketplaceAuditRecord: { kind: 'marketplace-audit-record', recordId, transition, tenantId, at, by, subject, detail }";

const AUDIT_RECORD_KEYS = [
  'kind',
  'recordId',
  'transition',
  'tenantId',
  'at',
  'by',
  'subject',
  'detail',
] as const;

/**
 * One immutable, typed audit-ledger record: the transition (closed
 * vocabulary), the owning tenant, the acting actor (WHO), the instant from
 * the injected clock (WHEN), the primary subject id, and the closed
 * JSON-safe detail (WHAT). The record id is derived deterministically from
 * (transition, subject, at) — see identity.ts.
 */
export interface MarketplaceAuditRecord {
  readonly kind: 'marketplace-audit-record';
  /** The derived, deterministic audit record identity. */
  readonly recordId: AuditRecordId;
  /** The lifecycle transition (closed vocabulary). */
  readonly transition: MarketplaceTransition;
  /** The tenant whose marketplace records the transition touched. */
  readonly tenantId: TenantId;
  /** The acting actor (provenance: WHO). */
  readonly by: Actor;
  /** The audited instant from the injected clock (provenance: WHEN). */
  readonly at: Timestamp;
  /** The primary subject id of the transition (a marketplace record id). */
  readonly subject: string;
  /** The closed, JSON-safe detail of the transition (provenance: WHAT). */
  readonly detail: MarketplaceAuditDetail;
}

/** Parse an untrusted value as a MarketplaceAuditRecord (total, fail-closed). */
export function parseMarketplaceAuditRecord(
  raw: unknown,
): ParseResult<MarketplaceAuditRecord> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', MARKETPLACE_AUDIT_RECORD_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, AUDIT_RECORD_KEYS, '', MARKETPLACE_AUDIT_RECORD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['marketplace-audit-record']);
  if (!kind.ok) return kind;
  const recordId = requireFieldWith(raw, 'recordId', '', parseAuditRecordId);
  if (!recordId.ok) return recordId;
  const transition = requireLiteral(raw, 'transition', '', [
    ...(MARKETPLACE_TRANSITIONS as readonly string[]),
  ]);
  if (!transition.ok) return transition;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const at = requireFieldWith(raw, 'at', '', parseTimestamp);
  if (!at.ok) return at;
  const by = requireFieldWith(raw, 'by', '', parseActor);
  if (!by.ok) return by;
  const subject = requireString(raw, 'subject', '', {
    min: 1,
    max: 128,
    description: 'the primary subject id of the transition',
  });
  if (!subject.ok) return subject;
  const detail = requireFieldWith(raw, 'detail', '', parseMarketplaceAuditDetail);
  if (!detail.ok) return detail;
  return parseOk({
    kind: 'marketplace-audit-record',
    recordId: recordId.value,
    transition: transition.value as MarketplaceTransition,
    tenantId: tenantId.value,
    at: at.value,
    by: by.value,
    subject: subject.value,
    detail: detail.value,
  } satisfies MarketplaceAuditRecord);
}

/** Type guard for structurally valid MarketplaceAuditRecord values. */
export function isMarketplaceAuditRecord(raw: unknown): raw is MarketplaceAuditRecord {
  return parseMarketplaceAuditRecord(raw).ok;
}

/**
 * Compose an audit record from trusted parts (trusted path; loud TypeError
 * on an invalid part): derives the deterministic record id from
 * (transition, subject, at) and validates the whole record through the
 * fail-closed parse.
 */
export function marketplaceAuditRecord(parts: {
  readonly transition: MarketplaceTransition;
  readonly tenantId: TenantId;
  readonly at: Timestamp;
  readonly by: Actor;
  readonly subject: string;
  readonly detail: MarketplaceAuditDetail;
}): MarketplaceAuditRecord {
  const record: MarketplaceAuditRecord = {
    kind: 'marketplace-audit-record',
    recordId: auditRecordIdOf({
      transition: parts.transition,
      subject: parts.subject,
      at: parts.at,
    }),
    transition: parts.transition,
    tenantId: parts.tenantId,
    at: parts.at,
    by: parts.by,
    subject: parts.subject,
    detail: parts.detail,
  };
  const parsed = parseMarketplaceAuditRecord(record);
  if (!parsed.ok) {
    throw new TypeError(`invalid marketplace audit record: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** The empty audit detail (transitions with no subject specifics). */
export const EMPTY_AUDIT_DETAIL: MarketplaceAuditDetail = {
  appId: null,
  manifestVersion: null,
  releaseId: null,
  publisherId: null,
  entitlementId: null,
  installationId: null,
  linkId: null,
  updateId: null,
  fromVersion: null,
  toVersion: null,
  addedCapabilities: [],
  removedCapabilities: [],
  confirmations: [],
};

// ----- THE audit sink port -----------------------------------------------------------------

/**
 * THE marketplace audit sink port: where every lifecycle transition record
 * lands. Injected (the real implementation writes wherever the platform
 * keeps its marketplace ledger; the in-memory reference below is the
 * deterministic test stand-in). A failing append MUST abort the surrounding
 * operation — the engine appends BEFORE committing any state change, so a
 * partially-applied transition can never commit (no audit, no effect).
 */
export interface MarketplaceAuditSink {
  append(record: MarketplaceAuditRecord): Result<true, DomainError>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedMarketplaceAppend {
  readonly record: MarketplaceAuditRecord;
}

/** The in-memory marketplace audit sink (deterministic reference). */
export interface InMemoryMarketplaceAuditSink extends MarketplaceAuditSink {
  /** Every appended record, in append order. */
  records(): readonly MarketplaceAuditRecord[];
  /** The records of one transition, in append order. */
  byTransition(transition: MarketplaceTransition): readonly MarketplaceAuditRecord[];
}

/**
 * Create the in-memory audit sink: appends in order, pure reads back.
 * Deterministic: no clock, no randomness — the records carry their own
 * provenance.
 */
export function createInMemoryMarketplaceAuditSink(): InMemoryMarketplaceAuditSink {
  const appended: MarketplaceAuditRecord[] = [];
  const sink: InMemoryMarketplaceAuditSink = {
    append: (record) => {
      appended.push(record);
      return ok(true);
    },
    records: () => [...appended],
    byTransition: (transition) =>
      appended.filter((record) => record.transition === transition),
  };
  return sink;
}

/** The typed failure every failing-sink append returns. */
export const auditSinkFailure = (reason: string): DomainError =>
  domainError('invariant-violation', `the marketplace audit sink rejected the append: ${reason}`, [
    { code: 'audit-sink-failure', message: reason, path: null },
  ]);

/**
 * Create the always-failing audit sink (the abort discipline fixture): every
 * append fails with the typed audit-sink failure, proving operations abort
 * with NO committed state change.
 */
export function failingMarketplaceAuditSink(reason = 'the fixture sink fails every append') {
  const sink: MarketplaceAuditSink = {
    append: () => fail(auditSinkFailure(reason)),
  };
  return sink;
}

/** The JSON-safe projection of an audit record (ledger serialization). */
export const auditRecordToJson = (record: MarketplaceAuditRecord): unknown => ({
  kind: record.kind,
  recordId: record.recordId,
  transition: record.transition,
  tenantId: record.tenantId,
  at: record.at,
  by: record.by,
  subject: record.subject,
  detail: record.detail,
});
