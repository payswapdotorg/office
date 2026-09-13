// Office web application shell — evidence navigation (OFF-030).
//
// THE ledger-event walkers over @office/events' vocabulary + the domain
// packages' event records: the session's project slice is browsable as
// EVIDENCE — the aggregate streams (@office/events' dense per-aggregate
// sequences), the @office/contracts event-name vocabulary (the domain
// segment of every EventName), and the A3 causality/correlation chains
// that make every view-model claim traceable back to the originating
// command (freeze A3/A4: correlationId ties one causal chain together;
// causationId references the causing message — a command's idempotency key
// or a prior event's ledger id, null for chain roots).
//
// Navigation state is typed and deterministic WITHOUT a router: an immutable
// page stack with push/back semantics; every push is resolved fail-closed
// against the world's public read surfaces (the ledger stream + the command
// journal) and the session's scope — an unknown, malformed, or OUT-OF-SCOPE
// address is a typed navigation rejection (freeze A12: a foreign tenant's or
// foreign project's event is invisible, never an existence oracle).
//
// The walkers are pure projections of the append-only stream (A7): the same
// world + session always produce byte-identical views, run-twice. This
// module performs no I/O, reads no clock, mutates nothing, and constructs
// no gateway.
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  parseCausationId,
  parseCorrelationId,
  parseEntityId,
  parseEntityKind,
} from '@office/contracts';
import type { CausationId, Timestamp } from '@office/contracts';
import { parseLedgerEventId } from '@office/events';
import type { LedgerEvent } from '@office/events';
import type { CommandJournalEntry, SeededWorld } from '../session/world';
import type { WebSession } from '../session/session';
import { sessionCoversScope } from '../session/session';

// ---------------------------------------------------------------------------
// The evidence view models (JSON-safe, deterministic).
// ---------------------------------------------------------------------------

/** One ledger event as displayable evidence (the domain event record). */
export interface EvidenceEventView {
  readonly eventId: string;
  readonly eventName: string;
  /** The ledger's dense per-aggregate position (the @office/events vocabulary). */
  readonly sequence: number;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly occurredAt: Timestamp;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  /** How the event's causation id resolves inside this world. */
  readonly causation:
    | { readonly kind: 'event'; readonly referenceId: string }
    | { readonly kind: 'command'; readonly referenceId: string }
    | { readonly kind: 'root' }
    | { readonly kind: 'unresolved-causation'; readonly referenceId: string };
  /** The domain event's JSON payload, verbatim (domain-validated at append). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The ledger browser's landing view: the slice summarized by vocabulary. */
export interface EvidenceOverviewView {
  readonly kind: 'evidence-overview';
  readonly eventCount: number;
  readonly aggregateCount: number;
  /** Event counts grouped by the event-name vocabulary's domain segment. */
  readonly domains: readonly { readonly domain: string; readonly eventCount: number }[];
  /** The slice's aggregate streams, deterministically ordered. */
  readonly aggregates: readonly {
    readonly entityKind: string;
    readonly entityId: string;
    readonly eventCount: number;
    readonly firstEventId: string;
    readonly lastEventId: string;
  }[];
}

/** One aggregate's event history (its evidence stream, append order). */
export interface AggregateHistoryView {
  readonly kind: 'evidence-aggregate';
  readonly entityKind: string;
  readonly entityId: string;
  readonly eventCount: number;
  readonly events: readonly EvidenceEventView[];
}

/** One executed command's dispatch record (the world's command journal). */
export interface EvidenceCommandView {
  readonly kind: 'evidence-command';
  readonly commandName: string;
  readonly idempotencyKey: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly issuedAt: Timestamp;
  readonly correlationId: string;
  readonly outcome: 'executed' | 'rejected';
  readonly rejectionCode: string | null;
  readonly eventId: string | null;
  readonly eventName: string | null;
}

/**
 * The A3 causality chain of one event, walked BACKWARDS to the originating
 * command: entry[i] was caused by entry[i+1]; the last entry is the chain's
 * origin (the originating command, the root event, or an unresolved
 * out-of-scope reference).
 */
export interface CausalityChainView {
  readonly kind: 'evidence-causality';
  readonly eventId: string;
  readonly correlationId: string;
  readonly depth: number;
  readonly entries: readonly (
    | { readonly kind: 'event'; readonly event: EvidenceEventView }
    | { readonly kind: 'command'; readonly command: EvidenceCommandView }
    | { readonly kind: 'unresolved-causation'; readonly referenceId: string }
  )[];
}

/** The A3 correlation chain: every event of one causal chain, in order. */
export interface CorrelationChainView {
  readonly kind: 'evidence-correlation';
  readonly correlationId: string;
  readonly eventCount: number;
  readonly events: readonly EvidenceEventView[];
}

/** The rendered view of one evidence page (discriminated on `page`). */
export type EvidencePageView =
  | { readonly page: 'evidence-overview'; readonly overview: EvidenceOverviewView }
  | { readonly page: 'evidence-aggregate'; readonly aggregate: AggregateHistoryView }
  | { readonly page: 'evidence-event'; readonly event: EvidenceEventView }
  | { readonly page: 'evidence-causality'; readonly chain: CausalityChainView }
  | { readonly page: 'evidence-correlation'; readonly correlation: CorrelationChainView }
  | { readonly page: 'evidence-command'; readonly command: EvidenceCommandView };

// ---------------------------------------------------------------------------
// The session-scoped walkers (pure, deterministic, A12-filtered).
// ---------------------------------------------------------------------------

/** Every ledger event the session may see (A12: invisible rows are absent). */
const scopedEvents = (world: SeededWorld, session: WebSession): readonly LedgerEvent[] =>
  world.ledgerEvents.filter((event) => sessionCoversScope(session, event.envelope.scope));

/** The session-visible command journal entry of one idempotency key, if any. */
const visibleJournalEntryOf = (
  world: SeededWorld,
  session: WebSession,
  idempotencyKey: string,
): CommandJournalEntry | undefined =>
  world.commandJournal.find(
    (entry) =>
      entry.idempotencyKey === idempotencyKey &&
      entry.outcome === 'executed' &&
      entry.eventId !== null &&
      world.ledgerEvents.some(
        (event) =>
          event.eventId === entry.eventId &&
          sessionCoversScope(session, event.envelope.scope),
      ),
  );

/** How one causation id resolves inside the world (the A3 convention). */
const causationOf = (
  world: SeededWorld,
  session: WebSession,
  causationId: CausationId | null,
): EvidenceEventView['causation'] => {
  if (causationId === null) return { kind: 'root' };
  // CausationIds, ledger event ids, and command idempotency keys share one
  // opaque printable grammar (the A3 convention) — compare as plain strings.
  const reference: string = causationId;
  const event = world.ledgerEvents.find((candidate) => candidate.eventId === reference);
  if (event !== undefined) {
    return sessionCoversScope(session, event.envelope.scope)
      ? { kind: 'event', referenceId: causationId }
      : { kind: 'unresolved-causation', referenceId: causationId };
  }
  const command = world.commandJournal.find((entry) => entry.idempotencyKey === reference);
  if (command !== undefined) return { kind: 'command', referenceId: causationId };
  return { kind: 'unresolved-causation', referenceId: causationId };
};

/** Project one ledger event into its displayable evidence view (pure). */
const evidenceEventViewOf = (world: SeededWorld, session: WebSession, event: LedgerEvent): EvidenceEventView => ({
  eventId: event.eventId,
  eventName: event.envelope.eventName,
  sequence: event.sequence,
  aggregateKind: event.aggregate.entityKind,
  aggregateId: event.aggregate.entityId,
  occurredAt: event.envelope.occurredAt,
  actorKind: event.envelope.actor.kind,
  actorId: event.envelope.actor.kind === 'system' ? null : event.envelope.actor.actorId,
  correlationId: event.envelope.causality.correlationId,
  causationId: event.envelope.causality.causationId,
  causation: causationOf(world, session, event.envelope.causality.causationId),
  payload: event.envelope.payload as Readonly<Record<string, unknown>>,
});

/** Project one command journal entry into its displayable view (pure). */
const evidenceCommandViewOf = (entry: CommandJournalEntry): EvidenceCommandView => ({
  kind: 'evidence-command',
  commandName: entry.commandName,
  idempotencyKey: entry.idempotencyKey,
  actorKind: entry.actor.kind,
  actorId: entry.actor.kind === 'system' ? null : entry.actor.actorId,
  issuedAt: entry.issuedAt,
  correlationId: entry.correlationId,
  outcome: entry.outcome,
  rejectionCode: entry.rejectionCode,
  eventId: entry.eventId,
  eventName: entry.eventName,
});

const aggregateKeyOf = (event: LedgerEvent): string =>
  `${event.aggregate.entityKind}|${event.aggregate.entityId}`;

/** THE overview: the slice's aggregate streams + vocabulary-domain counts. */
export function evidenceOverview(
  world: SeededWorld,
  session: WebSession,
): EvidenceOverviewView {
  const events = scopedEvents(world, session);
  const byAggregate = new Map<string, LedgerEvent[]>();
  const byDomain = new Map<string, number>();
  for (const event of events) {
    const aggregate = byAggregate.get(aggregateKeyOf(event));
    if (aggregate === undefined) byAggregate.set(aggregateKeyOf(event), [event]);
    else aggregate.push(event);
    const domain = event.envelope.eventName.split('.')[0] ?? '';
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
  }
  const aggregates = [...byAggregate.entries()]
    .map(([key, aggregateEvents]) => ({
      entityKind: aggregateEvents[0]?.aggregate.entityKind ?? key.split('|')[0] ?? '',
      entityId: aggregateEvents[0]?.aggregate.entityId ?? key.split('|')[1] ?? '',
      eventCount: aggregateEvents.length,
      firstEventId: aggregateEvents[0]?.eventId ?? '',
      lastEventId: aggregateEvents[aggregateEvents.length - 1]?.eventId ?? '',
    }))
    .sort((left, right) =>
      left.entityKind !== right.entityKind
        ? left.entityKind < right.entityKind
          ? -1
          : 1
        : left.entityId < right.entityId
          ? -1
          : 1,
    );
  const domains = [...byDomain.entries()]
    .map(([domain, eventCount]) => ({ domain, eventCount }))
    .sort((left, right) => (left.domain < right.domain ? -1 : 1));
  return {
    kind: 'evidence-overview',
    eventCount: events.length,
    aggregateCount: aggregates.length,
    domains,
    aggregates,
  };
}

/** One aggregate's evidence stream (append order), typed not-found otherwise. */
export function aggregateHistory(
  world: SeededWorld,
  session: WebSession,
  entityKind: string,
  entityId: string,
): Result<AggregateHistoryView, DomainError> {
  const kind = parseEntityKind(entityKind);
  if (!kind.ok) return invalidEvidenceAddress('invalid-aggregate-kind', entityKind);
  const id = parseEntityId(entityId);
  if (!id.ok) return invalidEvidenceAddress('invalid-aggregate-id', entityId);
  const events = scopedEvents(world, session).filter(
    (event) =>
      event.aggregate.entityKind === kind.value && event.aggregate.entityId === id.value,
  );
  if (events.length === 0) {
    return notVisible(
      `aggregate ${entityKind} ${entityId} has no events visible to this session`,
      entityKind,
      entityId,
    );
  }
  return {
    ok: true,
    value: {
      kind: 'evidence-aggregate',
      entityKind,
      entityId,
      eventCount: events.length,
      events: events.map((event) => evidenceEventViewOf(world, session, event)),
    },
  };
}

/** One ledger event's evidence view, typed not-found if invisible/unknown. */
export function evidenceEventOf(
  world: SeededWorld,
  session: WebSession,
  eventId: string,
): Result<EvidenceEventView, DomainError> {
  const id = parseLedgerEventId(eventId);
  if (!id.ok) return invalidEvidenceAddress('invalid-event-id', eventId);
  const event = scopedEvents(world, session).find(
    (candidate) => candidate.eventId === id.value,
  );
  if (event === undefined) {
    return notVisible(`ledger event ${eventId} is not visible to this session`, 'event', eventId);
  }
  return { ok: true, value: evidenceEventViewOf(world, session, event) };
}

/** The maximum walked chain depth (a cycle is a wiring violation, fail loud). */
const MAX_CAUSALITY_DEPTH = 64;

/**
 * THE causality chain of one event, walked BACKWARDS through the A3
 * convention: every event links to its causing message — another ledger
 * event (same world) or the ORIGINATING COMMAND (a journal idempotency
 * key); a null causation id is the chain's root. Out-of-scope or unknown
 * references terminate the walk as typed 'unresolved-causation' entries
 * (never an existence oracle).
 */
export function causalityChainOf(
  world: SeededWorld,
  session: WebSession,
  eventId: string,
): Result<CausalityChainView, DomainError> {
  const start = evidenceEventOf(world, session, eventId);
  if (!start.ok) return start;
  const entries: CausalityChainView['entries'][number][] = [
    { kind: 'event', event: start.value },
  ];
  let causationId: string | null = start.value.causationId;
  let correlationId = start.value.correlationId;
  for (let depth = 1; depth <= MAX_CAUSALITY_DEPTH; depth += 1) {
    if (causationId === null) break;
    const event = world.ledgerEvents.find((candidate) => candidate.eventId === causationId);
    if (event !== undefined && sessionCoversScope(session, event.envelope.scope)) {
      const view = evidenceEventViewOf(world, session, event);
      entries.push({ kind: 'event', event: view });
      correlationId = view.correlationId;
      causationId = view.causationId;
      continue;
    }
    const command = visibleJournalEntryOf(world, session, causationId);
    if (command !== undefined) {
      entries.push({ kind: 'command', command: evidenceCommandViewOf(command) });
      correlationId = command.correlationId;
      causationId = null;
      continue;
    }
    entries.push({ kind: 'unresolved-causation', referenceId: causationId });
    causationId = null;
  }
  if (causationId !== null) {
    return {
      ok: false,
      error: domainError(
        'invariant-violation',
        `the causality chain of event ${eventId} exceeds ${MAX_CAUSALITY_DEPTH} entries — a causality cycle is a wiring violation`,
        [{ code: 'causality-chain-too-deep', message: eventId, path: null }],
        { scope: session.scope, correlationId: null },
      ),
    };
  }
  return {
    ok: true,
    value: {
      kind: 'evidence-causality',
      eventId,
      correlationId,
      depth: entries.length,
      entries,
    },
  };
}

/** The correlation chain: every visible event of one causal chain. */
export function correlationChainOf(
  world: SeededWorld,
  session: WebSession,
  correlationId: string,
): Result<CorrelationChainView, DomainError> {
  const id = parseCorrelationId(correlationId);
  if (!id.ok) return invalidEvidenceAddress('invalid-correlation-id', correlationId);
  const events = scopedEvents(world, session).filter(
    (event) => event.envelope.causality.correlationId === id.value,
  );
  if (events.length === 0) {
    return notVisible(
      `correlation chain ${correlationId} has no events visible to this session`,
      'correlation',
      correlationId,
    );
  }
  return {
    ok: true,
    value: {
      kind: 'evidence-correlation',
      correlationId,
      eventCount: events.length,
      events: events.map((event) => evidenceEventViewOf(world, session, event)),
    },
  };
}

/** One executed command's dispatch record, typed not-found otherwise. */
export function evidenceCommandOf(
  world: SeededWorld,
  session: WebSession,
  idempotencyKey: string,
): Result<EvidenceCommandView, DomainError> {
  const key = parseCausationId(idempotencyKey);
  if (!key.ok) return invalidEvidenceAddress('invalid-idempotency-key', idempotencyKey);
  const entry = visibleJournalEntryOf(world, session, idempotencyKey);
  if (entry === undefined) {
    return notVisible(
      `command ${idempotencyKey} is not an executed command visible to this session`,
      'command',
      idempotencyKey,
    );
  }
  return { ok: true, value: evidenceCommandViewOf(entry) };
}

// ---------------------------------------------------------------------------
// The typed navigation state (page/back semantics WITHOUT a router).
// ---------------------------------------------------------------------------

/** One addressable evidence page (the typed navigation vocabulary). */
export type EvidencePage =
  | { readonly page: 'evidence-overview' }
  | { readonly page: 'evidence-aggregate'; readonly entityKind: string; readonly entityId: string }
  | { readonly page: 'evidence-event'; readonly eventId: string }
  | { readonly page: 'evidence-causality'; readonly eventId: string }
  | { readonly page: 'evidence-correlation'; readonly correlationId: string }
  | { readonly page: 'evidence-command'; readonly idempotencyKey: string };

/** The immutable navigation state: a page stack (root first, current last). */
export interface EvidenceNavigation {
  readonly stack: readonly EvidencePage[];
}

/** Why a navigation step was typed-rejected (displayable, never a throw). */
export interface EvidenceNavigationRejection {
  readonly code: string;
  readonly message: string;
  readonly details: readonly { readonly code: string; readonly message: string; readonly path: string | null }[];
}

/** Open the evidence navigation at its root (the ledger overview). */
export const openEvidenceNavigation = (): EvidenceNavigation => ({
  stack: [{ page: 'evidence-overview' }],
});

/** The navigation's current page (the stack's top). */
export const currentEvidencePage = (navigation: EvidenceNavigation): EvidencePage =>
  navigation.stack[navigation.stack.length - 1] ?? { page: 'evidence-overview' };

/**
 * Push one page: the page's address is resolved fail-closed against the
 * world's public read surfaces FIRST (an unknown, malformed, or out-of-scope
 * address is a typed navigation rejection — A12, never an existence
 * oracle), and only a resolvable page enters the stack.
 */
export function pushEvidencePage(
  world: SeededWorld,
  session: WebSession,
  navigation: EvidenceNavigation,
  page: EvidencePage,
): Result<EvidenceNavigation, EvidenceNavigationRejection> {
  const resolved = resolveEvidencePage(world, session, page);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, value: { stack: [...navigation.stack, page] } };
}

/** Pop one page (typed 'navigation-at-root' rejection at the stack's root). */
export function backEvidencePage(
  navigation: EvidenceNavigation,
): Result<EvidenceNavigation, EvidenceNavigationRejection> {
  if (navigation.stack.length <= 1) {
    return {
      ok: false,
      error: {
        code: 'navigation-at-root',
        message: 'already at the root page — there is no page to go back to',
        details: [],
      },
    };
  }
  return { ok: true, value: { stack: navigation.stack.slice(0, -1) } };
}

/** Render the current page's view model (total for validated pages). */
export function evidencePageView(
  world: SeededWorld,
  session: WebSession,
  navigation: EvidenceNavigation,
): Result<EvidencePageView, EvidenceNavigationRejection> {
  const page = currentEvidencePage(navigation);
  const resolved = resolveEvidencePage(world, session, page);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, value: resolved.value };
}

/** Resolve + render one page's view (the push/evidence boundary). */
function resolveEvidencePage(
  world: SeededWorld,
  session: WebSession,
  page: EvidencePage,
): Result<EvidencePageView, EvidenceNavigationRejection> {
  switch (page.page) {
    case 'evidence-overview':
      return { ok: true, value: { page: 'evidence-overview', overview: evidenceOverview(world, session) } };
    case 'evidence-aggregate': {
      const aggregate = aggregateHistory(world, session, page.entityKind, page.entityId);
      return aggregate.ok
        ? { ok: true, value: { page: 'evidence-aggregate', aggregate: aggregate.value } }
        : { ok: false, error: rejectionOf(aggregate.error) };
    }
    case 'evidence-event': {
      const event = evidenceEventOf(world, session, page.eventId);
      return event.ok
        ? { ok: true, value: { page: 'evidence-event', event: event.value } }
        : { ok: false, error: rejectionOf(event.error) };
    }
    case 'evidence-causality': {
      const chain = causalityChainOf(world, session, page.eventId);
      return chain.ok
        ? { ok: true, value: { page: 'evidence-causality', chain: chain.value } }
        : { ok: false, error: rejectionOf(chain.error) };
    }
    case 'evidence-correlation': {
      const correlation = correlationChainOf(world, session, page.correlationId);
      return correlation.ok
        ? { ok: true, value: { page: 'evidence-correlation', correlation: correlation.value } }
        : { ok: false, error: rejectionOf(correlation.error) };
    }
    case 'evidence-command': {
      const command = evidenceCommandOf(world, session, page.idempotencyKey);
      return command.ok
        ? { ok: true, value: { page: 'evidence-command', command: command.value } }
        : { ok: false, error: rejectionOf(command.error) };
    }
  }
}

// ---------------------------------------------------------------------------
// Typed-rejection translators (displayable, never throws).
// ---------------------------------------------------------------------------

const invalidEvidenceAddress = (code: string, received: string): Result<never, DomainError> => ({
  ok: false,
  error: domainError(
    'invariant-violation',
    `invalid evidence address (${code}): '${received}'`,
    [{ code, message: received, path: null }],
    { scope: null, correlationId: null },
  ),
});

const notVisible = (
  message: string,
  entityKind: string,
  entityId: string,
): Result<never, DomainError> => ({
  ok: false,
  error: domainError(
    'not-found',
    message,
    [{ code: 'evidence-not-visible', message: `${entityKind} ${entityId}`, path: null }],
    { scope: null, correlationId: null },
  ),
});

/** Project a walker's DomainError into a displayable navigation rejection. */
const rejectionOf = (error: DomainError): EvidenceNavigationRejection => ({
  code: error.code,
  message: error.message,
  details: error.details.map((detail) => ({
    code: detail.code,
    message: detail.message,
    path: detail.path,
  })),
});
