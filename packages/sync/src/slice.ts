// Office sync — project slices & the slice read port (OFF-028, freeze A12).
//
// A ProjectSlice is the per-project ordered event stream a client syncs
// against: every project-scope ledger event of one project, in ONE
// deterministic total order, with dense 1-based positions. It is the
// projection basis for client synchronization (freeze A7/A12: all clients
// share ONE project state; a slice is the same state's event history, never
// a per-client copy).
//
// DETERMINISTIC ORDERING RULE (the whole protocol's ordering backbone): a
// slice orders events by (occurredAt ASC, eventId ASC). occurredAt is the
// envelope's canonical UTC instant; the eventId tiebreak (the ledger's
// sha256-derived opaque id) makes the order TOTAL and deterministic even
// when distinct aggregates' events share an instant — the same set of
// ledger events ALWAYS yields the same slice, regardless of append timing,
// read timing, or input order (proven by test, including the run-twice
// identity).
//
// The READ PORT: ProjectSliceSource is the ledger READ surface the protocol
// projects from (this package NEVER writes the ledger — freeze A3:
// consumers project, they do not mutate history). Implementations are
// scope-responsible exactly like the ledger reads of @office/events: an
// event outside the reading scope is simply not present (A12, no existence
// oracle). The runtime wires the real ledger behind this port later
// (`WHERE tenant_id = $1 AND project_id = $2 ORDER BY occurred_at ASC,
// event_id ASC` over event_ledger, paginated by position window); this
// package ships the deterministic IN-MEMORY source for tests, which mirrors
// the ledger's identity semantics exactly (dense per-(tenant, aggregate)
// sequences; deterministic ledger event ids derived the same way appendEvent
// derives them — ledgerEventIdOf), so the same append sequence reproduces
// identical ids and identical reads.
import { isDomainEventEnvelope, isEntityRef, parseFail, parseOk, parseScope } from '@office/contracts';
import type { DomainEventEnvelope, EntityRef, ParseResult, ProjectScope, Scope } from '@office/contracts';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { ledgerEventIdOf, parseLedgerEventId, parseLedgerSequence } from '@office/events';
import type { LedgerEvent, LedgerSequence } from '@office/events';
import { CURRENT_PROTOCOL_VERSION } from './version';
import type { ProtocolVersion } from './version';
import { parseSubscriptionId } from './identity';
import type { SubscriptionId } from './identity';
import { describeValue, isPlainObject, requireFieldWith, requireLiteral, unknownKeyFailure } from './parse';

declare const slicePositionBrand: unique symbol;

/**
 * Dense 1-based position of one event within a project slice (the cursor
 * basis). Position 0 is the BEFORE-FIRST basis: a cursor at 0 resumes from
 * the very beginning of the slice.
 */
export type SlicePosition = number & { readonly [slicePositionBrand]: 'SlicePosition' };

/** Grammar description used in parse failures. */
export const SLICE_POSITION_GRAMMAR = `integer position >= 0 (0 = before first event; event positions are dense 1..n)`;

/** Upper bound of one slice read (the port's page size). */
export const MAX_SLICE_READ_LIMIT = 10_000;

/** One event at one position of a project slice. */
export interface SliceEntry {
  /** The ledger event (envelope + ledger-assigned identity and sequence). */
  readonly event: LedgerEvent;
  /** The event's dense position within the slice (1-based). */
  readonly position: SlicePosition;
}

/** The per-project ordered event stream (the client sync projection basis). */
export interface ProjectSlice {
  readonly kind: 'project-slice';
  /** The project whose events the slice carries (freeze A12). */
  readonly scope: ProjectScope;
  /** The protocol version the slice was materialized under. */
  readonly protocolVersion: ProtocolVersion;
  /** The slice's events in deterministic order, positions dense 1..n. */
  readonly entries: readonly SliceEntry[];
}

/** Shape description used in parse failures. */
export const SLICE_CURSOR_GRAMMAR =
  "SliceCursor: { kind: 'slice-cursor', subscriptionId, position }";

const SLICE_CURSOR_KEYS = ['kind', 'subscriptionId', 'position'] as const;

/** The resume position of one subscription in its project slice. */
export interface SliceCursor {
  readonly kind: 'slice-cursor';
  /** The subscription this cursor belongs to (checked on every resume). */
  readonly subscriptionId: SubscriptionId;
  /** The position the subscription has consumed through (0 = beginning). */
  readonly position: SlicePosition;
}

/** Parse an untrusted value as a SlicePosition (total, fail-closed). */
export function parseSlicePosition(raw: unknown): ParseResult<SlicePosition> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER) {
    return parseFail('invalid-value', '', SLICE_POSITION_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as SlicePosition);
}

/** Type guard for structurally valid SlicePosition values. */
export function isSlicePosition(raw: unknown): raw is SlicePosition {
  return parseSlicePosition(raw).ok;
}

/** Parse an untrusted value as a SliceCursor (total, fail-closed, strict keys). */
export function parseSliceCursor(raw: unknown): ParseResult<SliceCursor> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SLICE_CURSOR_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SLICE_CURSOR_KEYS, '', SLICE_CURSOR_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['slice-cursor']);
  if (!kind.ok) return kind;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const position = requireFieldWith(raw, 'position', '', parseSlicePosition);
  if (!position.ok) return position;
  return parseOk(
    {
      kind: 'slice-cursor',
      subscriptionId: subscriptionId.value,
      position: position.value,
    } satisfies SliceCursor,
  );
}

/** Type guard for structurally valid SliceCursor values. */
export function isSliceCursor(raw: unknown): raw is SliceCursor {
  return parseSliceCursor(raw).ok;
}

/** Compose a SliceCursor from validated parts (trusted path; loud TypeError). */
export function sliceCursor(parts: {
  readonly subscriptionId: SubscriptionId;
  readonly position: SlicePosition;
}): SliceCursor {
  const parsed = parseSliceCursor({ ...parts, kind: 'slice-cursor' });
  if (!parsed.ok) {
    throw new TypeError(`invalid slice cursor: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Typed cursor-membership check: a cursor presented on a resume must belong
 * to the SAME subscription (typed invariant-violation otherwise) — a cursor
 * never silently resumes a subscription it does not belong to (mirrors the
 * adapters-sdk checkCursorStream convention).
 */
export function checkCursorSubscription(
  cursor: SliceCursor,
  subscriptionId: SubscriptionId,
): Result<true, DomainError> {
  if (cursor.subscriptionId !== subscriptionId) {
    return fail(
      domainError(
        'invariant-violation',
        `slice cursor of subscription ${cursor.subscriptionId} cannot resume subscription ${subscriptionId} — cursors are subscription-scoped`,
        [
          {
            code: 'cursor-subscription-mismatch',
            message: `${cursor.subscriptionId} vs ${subscriptionId}`,
            path: 'subscriptionId',
          },
        ],
      ),
    );
  }
  return ok(true);
}

/**
 * Parse an untrusted value into a LedgerEvent shape (total, fail-closed,
 * strict keys). The @office/events public surface exposes the ledger
 * identity parses (event id, sequence) and the envelope parses through
 * @office/contracts, so this is the composed fail-closed boundary the
 * protocol's message parses share.
 */
export function parseLedgerEvent(raw: unknown): ParseResult<LedgerEvent> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'LedgerEvent: { eventId, sequence, aggregate, envelope }', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['eventId', 'sequence', 'aggregate', 'envelope'], '', 'LedgerEvent');
  if (unknownKey) return unknownKey;
  const eventId = requireFieldWith(raw, 'eventId', '', parseLedgerEventId);
  if (!eventId.ok) return eventId;
  const sequence = requireFieldWith(raw, 'sequence', '', parseLedgerSequence);
  if (!sequence.ok) return sequence;
  const aggregateRaw = raw['aggregate'];
  if (!isEntityRef(aggregateRaw)) {
    return parseFail('invalid-type', 'aggregate', 'EntityRef: { entityKind, entityId }', describeValue(aggregateRaw));
  }
  const envelopeRaw = raw['envelope'];
  if (!isDomainEventEnvelope(envelopeRaw)) {
    return parseFail('invalid-type', 'envelope', 'a structurally valid DomainEventEnvelope (freeze A3)', describeValue(envelopeRaw));
  }
  return parseOk({
    eventId: eventId.value,
    sequence: sequence.value,
    aggregate: aggregateRaw,
    envelope: envelopeRaw,
  } satisfies LedgerEvent);
}

/** Type guard for structurally valid LedgerEvent values. */
export function isLedgerEvent(raw: unknown): raw is LedgerEvent {
  return parseLedgerEvent(raw).ok;
}

/**
 * Order a set of ledger events into slice entries (pure, deterministic):
 * (occurredAt ASC, eventId ASC) with dense 1-based positions. The same input
 * SET always produces the identical entry list regardless of input order.
 */
export function orderSliceEntries(events: readonly LedgerEvent[]): readonly SliceEntry[] {
  const ordered = [...events].sort((left, right) => {
    const leftAt: string = left.envelope.occurredAt;
    const rightAt: string = right.envelope.occurredAt;
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
    if (left.eventId !== right.eventId) return left.eventId < right.eventId ? -1 : 1;
    return 0;
  });
  return ordered.map((event, index) => ({ event, position: (index + 1) as SlicePosition }));
}

/** Is this ledger event part of the project slice of `scope`? (A12 filter) */
export const eventInSliceScope = (event: LedgerEvent, scope: ProjectScope): boolean => {
  const eventScope: Scope = event.envelope.scope;
  return (
    eventScope.kind === 'project' &&
    eventScope.tenantId === scope.tenantId &&
    eventScope.projectId === scope.projectId
  );
};

/**
 * Materialize a project slice from a set of ledger events (pure,
 * deterministic): the project-scope events of `scope`, ordered by the slice
 * ordering rule, positions dense 1..n. Events of other tenants/projects
 * (or tenant-scope events) are simply not part of this slice — invisible,
 * never an error (A12, no existence oracle).
 */
export function buildProjectSlice(
  scope: ProjectScope,
  protocolVersion: ProtocolVersion,
  events: readonly LedgerEvent[],
): ProjectSlice {
  const scoped = events.filter((event) => eventInSliceScope(event, scope));
  return {
    kind: 'project-slice',
    scope,
    protocolVersion,
    entries: orderSliceEntries(scoped),
  };
}

/** The entries of a slice strictly after `position` (resume window). */
export function sliceEntriesAfter(
  slice: ProjectSlice,
  position: SlicePosition,
): readonly SliceEntry[] {
  return slice.entries.filter((entry) => entry.position > position);
}

/** The last position of a slice (0 when the slice is empty). */
export function headPositionOf(slice: ProjectSlice): SlicePosition {
  return slice.entries.length === 0
    ? (0 as SlicePosition)
    : slice.entries[slice.entries.length - 1]!.position;
}

/**
 * Verify that a read's entries are CONTIGUOUS after `after` (dense
 * positions, no gaps): entry[i].position === after + i + 1. A discontinuous
 * read is a typed invariant-violation — silently skipping missing events
 * would starve client state forever (fail closed instead, mirroring the
 * events consumer-cursor gap rule).
 */
export function checkSliceContinuity(
  entries: readonly SliceEntry[],
  after: SlicePosition,
): Result<true, DomainError> {
  for (const [index, entry] of entries.entries()) {
    if (entry.position !== after + index + 1) {
      return fail(
        invariantViolation(
          {
            name: 'slice-continuity',
            statement: `slice read after position ${after} is discontinuous: entry ${index} carries position ${entry.position}, expected ${after + index + 1}`,
          },
        ),
      );
    }
  }
  return ok(true);
}

/**
 * The ledger READ surface the subscription protocol projects from: one
 * resumable window of one project's slice. Entries MUST be contiguous after
 * `after` (positions after+1 .. after+limit at most), in the deterministic
 * slice order, and scope-responsible (events outside the scope are not
 * present). The broker re-checks continuity fail-closed on every read.
 *
 * The runtime wires the real ledger behind this port (a paginated project
 * read over event_ledger ordered by occurred_at, event_id — see README for
 * the reported read-surface gap); this package ships the in-memory source.
 */
export interface ProjectSliceSource {
  readSlice(input: {
    readonly scope: ProjectScope;
    readonly after: SlicePosition;
    readonly limit: number;
  }): Promise<Result<readonly SliceEntry[], DomainError>>;
}

/**
 * The deterministic in-memory slice source for tests: append events in any
 * order and read them back as project slices with the SAME identity
 * semantics as the OFF-005 ledger (dense per-(tenant, aggregate) sequences;
 * deterministic ledger event ids derived from the ledger key). No clock, no
 * randomness — the same append sequence always produces identical reads.
 */
export interface InMemorySliceSource extends ProjectSliceSource {
  /**
   * Append one envelope to the source's ledger-shaped stream. Mirrors
   * appendEvent's boundary checks (fail-closed envelope + aggregate
   * validation) but writes only memory — the real ledger is never touched.
   */
  append(
    envelope: DomainEventEnvelope,
    aggregate: EntityRef,
  ): Promise<Result<LedgerEvent, DomainError>>;
  /** Every appended event, in append order. */
  readonly events: readonly LedgerEvent[];
}

/** Create an empty in-memory slice source (deterministic, pure memory). */
export function createInMemorySliceSource(): InMemorySliceSource {
  const events: LedgerEvent[] = [];
  const counters = new Map<string, number>();

  const sequenceKey = (envelope: DomainEventEnvelope, aggregate: EntityRef): string =>
    `${envelope.scope.tenantId}|${aggregate.entityKind}|${aggregate.entityId}`;

  return {
    get events(): readonly LedgerEvent[] {
      return [...events];
    },
    append: async (envelope, aggregate) => {
      if (!isDomainEventEnvelope(envelope)) {
        return fail(
          invariantViolation(
            {
              name: 'event-envelope-valid',
              statement: 'append requires a structurally valid DomainEventEnvelope',
            },
          ),
        );
      }
      if (!isEntityRef(aggregate)) {
        return fail(
          invariantViolation(
            {
              name: 'aggregate-ref-valid',
              statement: 'append requires a structurally valid aggregate EntityRef',
            },
          ),
        );
      }
      const key = sequenceKey(envelope, aggregate);
      const sequence = (counters.get(key) ?? 0) + 1;
      counters.set(key, sequence);
      const event: LedgerEvent = {
        eventId: ledgerEventIdOf({
          tenantId: envelope.scope.tenantId,
          aggregate,
          sequence: sequence as LedgerSequence,
        }),
        sequence: sequence as LedgerSequence,
        aggregate,
        envelope,
      };
      events.push(event);
      return ok(event);
    },
    readSlice: async ({ scope, after, limit }) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SLICE_READ_LIMIT) {
        return fail(
          invariantViolation(
            {
              name: 'slice-read-limit',
              statement: `slice read limit must be an integer in 1..${MAX_SLICE_READ_LIMIT}`,
            },
          ),
        );
      }
      if (!isSlicePosition(after)) {
        return fail(
          invariantViolation(
            {
              name: 'slice-read-after',
              statement: `slice read position must be ${SLICE_POSITION_GRAMMAR}`,
            },
          ),
        );
      }
      const scoped = events.filter((event) => eventInSliceScope(event, scope));
      const slice = buildProjectSlice(scope, CURRENT_PROTOCOL_VERSION, scoped);
      const window = sliceEntriesAfter(slice, after).slice(0, limit);
      return ok(window);
    },
  };
}

/** Parse an untrusted value as a ProjectScope (fail-closed scope narrow). */
export function parseProjectScope(raw: unknown): ParseResult<ProjectScope> {
  const parsed = parseScope(raw);
  if (!parsed.ok) return parsed;
  if (parsed.value.kind !== 'project') {
    return parseFail(
      'invalid-value',
      '',
      "ProjectScope: { kind: 'project', tenantId, projectId }",
      describeValue(raw),
    );
  }
  return parseOk(parsed.value);
}

/** Type guard for structurally valid ProjectScope values. */
export function isProjectScope(raw: unknown): raw is ProjectScope {
  return parseProjectScope(raw).ok;
}
