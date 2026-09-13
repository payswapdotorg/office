// Office security — the in-memory audit ledger (OFF-036).
//
// THE read model of every conformance check, access review, alert
// evaluation, and retention projection: an append-only, deterministic,
// in-memory ledger of DomainEventEnvelopes shaped after @office/events'
// ledger (the OFF-005 grammar): every appended event is re-validated
// fail-closed against the canonical contract (garbage never gets stored),
// gets a dense per-(tenant, aggregate) sequence and a DETERMINISTIC derived
// ledger event id (the @office/events ledgerEventIdOf derivation — the same
// append sequence always reproduces identical ids).
//
// Immutability (freeze A3): the ledger surface offers append + read views
// ONLY — there is no update, no delete, no truncation anywhere in this
// module. Retention (retention/) computes what WOULD expire as pure data;
// deletion itself belongs to the runtime, never to this package.
//
// A12: every read view is scope-filtered — a query under tenant A's scope
// never sees tenant B's events; a project-scoped query sees its own
// project's events plus tenant-wide audit events (the same coverage
// semantics @office/authz's checkScopeCoversResource enforces), never a
// foreign project's.
//
// Determinism: no clock, no randomness, no I/O — pure bookkeeping over
// validated envelopes with derived identities and insertion order.
import { createHash } from 'node:crypto';
import { parseEventName, parseDomainEventEnvelope, parseEntityId, parseEntityKind } from '@office/contracts';
import type {
  CausationId,
  DomainEventEnvelope,
  EntityRef,
  EventName,
  Scope,
  TenantId,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { ledgerEventIdOf } from '@office/events';
import type { LedgerEventId, LedgerSequence } from '@office/events';

// ----- the audit event-class vocabulary ------------------------------------------------------

/**
 * The platform audit-trail event classes: the first segment of the canonical
 * event name for every envelope the platform's own decision surfaces emit —
 * the action gateway ('actions.*'), the app runtime ('apps.*'), agent runs
 * ('agents.*' — consumed through the @office/contracts envelope grammar
 * only), and sync conflict records ('sync.*', same grammar-only rule).
 */
export const AUDIT_EVENT_CLASSES = ['actions', 'apps', 'agents', 'sync'] as const;

/** One platform audit-trail event class (the event-name area). */
export type AuditEventClass = (typeof AUDIT_EVENT_CLASSES)[number];

/** Shape description used in parse failures. */
export const AUDIT_EVENT_CLASS_GRAMMAR =
  "'actions' | 'apps' | 'agents' | 'sync' (the platform audit-trail event-name areas)";

/**
 * The audit event class of a canonical event name (its first dot-separated
 * segment), or null when the name does not belong to a platform audit area
 * (e.g. a domain event such as 'projects.projectCreated').
 */
export const auditEventClassOf = (eventName: EventName | string): AuditEventClass | null => {
  // Fail-closed: an unparseable name has no audit class (tests may hand raw
  // strings; the canonical path hands branded EventNames).
  if (typeof eventName === 'string') {
    const parsed = parseEventName(eventName);
    if (!parsed.ok) return null;
  }
  const area = (eventName as string).split('.')[0] ?? '';
  return (AUDIT_EVENT_CLASSES as readonly string[]).includes(area)
    ? (area as AuditEventClass)
    : null;
};

/**
 * The synthetic aggregate of an audit envelope bound to no entity (both
 * entity refs null — e.g. every app-runtime decision event): the audit
 * STREAM of its event class. Derived deterministically (sha256 over the
 * class name), so the same class always maps to the same stream identity
 * and replay reproduces identical ledger keys.
 */
const auditStreamOf = (eventClass: AuditEventClass): EntityRef => {
  const opaque = createHash('sha256').update(`audit-stream|${eventClass}`, 'utf8')
    .digest('hex').slice(0, 32);
  const parsed = parseEntityId(`office-ent-v1-${opaque}`);
  if (!parsed.ok) {
    throw new TypeError(`derived audit stream id is not a valid EntityId: ${parsed.error.code}`);
  }
  const kind = parseEntityKind('audit-trail');
  if (!kind.ok) {
    throw new TypeError(`derived audit stream kind is not a valid EntityKind: ${kind.error.code}`);
  }
  return { entityKind: kind.value, entityId: parsed.value };
};

/** The aggregate a ledger row belongs to (the entity it records a decision about). */
const aggregateOf = (envelope: DomainEventEnvelope, eventClass: AuditEventClass): EntityRef =>
  envelope.entityRefs.after ?? envelope.entityRefs.before ?? auditStreamOf(eventClass);

// ----- the in-memory audit ledger -------------------------------------------------------------

/** One audit ledger row: the ledger-assigned identity + the immutable envelope. */
export interface AuditLedgerEvent {
  /** Deterministic ledger-assigned id (the @office/events derivation). */
  readonly eventId: LedgerEventId;
  /** Dense per-(tenant, aggregate) position; strictly monotonic. */
  readonly sequence: LedgerSequence;
  /** The aggregate this audit event belongs to. */
  readonly aggregate: EntityRef;
  /** The immutable envelope exactly as appended (scope, actor, causality, payload). */
  readonly envelope: DomainEventEnvelope;
}

/**
 * The append-only in-memory audit ledger. Append + read views ONLY (freeze
 * A3: the ledger is immutable — there is no mutation surface of any kind).
 */
export interface InMemoryAuditLedger {
  /** Append one validated envelope (fail-closed: contract-invalid input is typed-rejected). */
  append(envelope: DomainEventEnvelope): Result<AuditLedgerEvent, DomainError>;
  /** Every recorded event, in append order (a defensive copy). */
  events(): readonly AuditLedgerEvent[];
  /** Every event visible under the query scope (A12; a defensive copy). */
  eventsInScope(scope: Scope): readonly AuditLedgerEvent[];
  /** Every event of one tenant, in append order (a defensive copy). */
  eventsOfTenant(tenantId: TenantId): readonly AuditLedgerEvent[];
  /** Every event whose causation id equals the given one (command-caused lookups). */
  byCausation(causationId: CausationId): readonly AuditLedgerEvent[];
  /** How many events are recorded. */
  size(): number;
}

/** Is a tenant-wide event visible from a project scope? Yes (A12 coverage semantics). */
const visibleInScope = (event: AuditLedgerEvent, scope: Scope): boolean => {
  const eventScope = event.envelope.scope;
  if (eventScope.tenantId !== scope.tenantId) return false;
  if (scope.kind === 'tenant') return true;
  // Project-scoped queries see their own project's events plus tenant-wide
  // audit events — never a foreign project's.
  if (eventScope.kind === 'project') {
    return eventScope.projectId === scope.projectId;
  }
  return true;
};

/**
 * Create the deterministic in-memory audit ledger. Two ledgers fed the same
 * append sequence hold byte-identical rows (derived ids, dense sequences,
 * insertion order) — the determinism every downstream security model relies
 * on.
 */
export function createInMemoryAuditLedger(): InMemoryAuditLedger {
  const ordered: AuditLedgerEvent[] = [];
  const byId = new Map<string, AuditLedgerEvent>();
  const sequences = new Map<string, number>();

  return {
    append: (envelope) => {
      // Fail-closed boundary on the wide world: the ledger only ever stores
      // contract-valid envelopes (the ledger is the system of record for the
      // audit trail — garbage never gets stored).
      const checked = parseDomainEventEnvelope(envelope);
      if (!checked.ok) {
        return fail(
          domainError(
            'invariant-violation',
            `the audit envelope does not satisfy the canonical contract: ${checked.error.code} at '${checked.error.path}'`,
            [
              {
                code: 'audit-envelope-invalid',
                message: `${checked.error.code}: expected ${checked.error.expected}`,
                path: checked.error.path,
              },
            ],
            { scope: envelope.scope ?? null, correlationId: null },
          ),
        );
      }
      const validated = checked.value;
      const eventClass = auditEventClassOf(validated.eventName);
      if (eventClass === null) {
        // The security ledger records AUDIT events; a non-audit event name is
        // a wiring defect at this boundary, typed-rejected fail-closed.
        return fail(
          domainError(
            'invariant-violation',
            `event '${validated.eventName}' does not belong to a platform audit class (${AUDIT_EVENT_CLASSES.join(', ')}) — the security ledger records audit trails only`,
            [
              {
                code: 'audit-event-class-unknown',
                message: validated.eventName,
                path: 'eventName',
              },
            ],
            { scope: validated.scope, correlationId: validated.causality.correlationId },
          ),
        );
      }
      const aggregate = aggregateOf(validated, eventClass);
      const sequenceKey = `${validated.scope.tenantId}|${aggregate.entityKind}|${aggregate.entityId}`;
      const next = (sequences.get(sequenceKey) ?? 0) + 1;
      const eventId = ledgerEventIdOf({
        tenantId: validated.scope.tenantId,
        aggregate,
        sequence: next as LedgerSequence,
      });
      if (byId.has(eventId)) {
        // Unreachable behind the dense per-aggregate sequence assignment; kept
        // total for safety (mirrors the ledger's unique constraints).
        return fail(
          domainError(
            'invariant-violation',
            `audit ledger event id already exists: ${eventId}`,
            [{ code: 'audit-event-id-already-exists', message: eventId, path: 'eventId' }],
            { scope: validated.scope, correlationId: validated.causality.correlationId },
          ),
        );
      }
      sequences.set(sequenceKey, next);
      const event: AuditLedgerEvent = {
        eventId,
        sequence: next as LedgerSequence,
        aggregate,
        envelope: validated,
      };
      ordered.push(event);
      byId.set(eventId, event);
      return ok(event);
    },

    events: () => [...ordered],

    eventsInScope: (scope) => ordered.filter((event) => visibleInScope(event, scope)),

    eventsOfTenant: (tenantId) =>
      ordered.filter((event) => event.envelope.scope.tenantId === tenantId),

    byCausation: (causationId) =>
      ordered.filter((event) => event.envelope.causality.causationId === causationId),

    size: () => ordered.length,
  };
}
