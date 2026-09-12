// Office intelligence — the relationship model (OFF-013).
//
// A Relationship is ONE typed directed edge between two canonical entities:
// kind + from (subject) + to (object), plus the DERIVATION PROVENANCE of the
// edge — the ledger event that asserted it (event id, event name, aggregate
// stream, sequence) and that event's causality (correlation id + causation
// id), which is what causal-chain queries walk backward through. Every
// returned edge carries its producing event id: relationships are derived,
// never stored opinion.
//
// The RelationshipIndex is the projection's whole state: the canonical edge
// list, the entity nodes encountered (with their observed owning scope for
// traversal-time authorization), and derivation metadata. It contains no
// clock, no randomness, no environment: the same event stream projects to a
// byte-identical index (freeze A2/A7 — derived, rebuildable, replaceable).
import { parseEntityKind, parseEntityRef, parseFail, parseOk } from '@office/contracts';
import type {
  Actor,
  CausationId,
  CorrelationId,
  EntityKind,
  EntityRef,
  EventName,
  ParseResult,
  Scope,
  Timestamp,
} from '@office/contracts';
import type { LedgerEventId, LedgerSequence } from '@office/events';
import { parseRelationshipKind } from './vocabulary';
import type { RelationshipKind } from './vocabulary';

/** The producing event of one relationship edge (its derivation provenance). */
export interface RelationshipProvenance {
  /** Ledger id of the event that asserted this edge (deterministic, A9-friendly). */
  readonly eventId: LedgerEventId;
  /** Event name of the asserting event, e.g. 'contracts.changeEventRaised'. */
  readonly eventName: EventName;
  /** The aggregate stream the asserting event belongs to. */
  readonly aggregate: EntityRef;
  /** Dense per-(tenant, aggregate) position of the asserting event. */
  readonly sequence: LedgerSequence;
  /** Correlation id of the asserting event's causal chain. */
  readonly correlationId: CorrelationId;
  /** Causation id of the asserting event (its command key or prior event id; null at chain roots). */
  readonly causationId: CausationId | null;
  /** Occurred-at time of the asserting event. */
  readonly occurredAt: Timestamp;
  /** Actor of the asserting event. */
  readonly actor: Actor;
}

/** One typed directed edge between canonical entities, with its provenance. */
export interface Relationship {
  /** The relationship kind (the five-kind canonical vocabulary). */
  readonly kind: RelationshipKind;
  /** The subject entity of the edge. */
  readonly from: EntityRef;
  /** The object entity of the edge. */
  readonly to: EntityRef;
  /** The scope of the event that asserted the edge (the edge's owning scope). */
  readonly scope: Scope;
  /** The derivation provenance: the event that produced this edge. */
  readonly provenance: RelationshipProvenance;
}

/** One entity node of the index, with its observed owning scope. */
export interface EntityNode {
  /** The canonical entity. */
  readonly entity: EntityRef;
  /** Owning tenant/project scope observed from the last event that mentioned the entity. */
  readonly scope: Scope;
}

/** One event-name tally of the derivation metadata. */
export interface EventNameTally {
  readonly eventName: EventName;
  readonly count: number;
}

/** How the index was derived — the projection's own audit trail. */
export interface DerivationMetadata {
  /** Total ledger events the projection consumed. */
  readonly projectedEventCount: number;
  /** How many distinct entities the index tracks. */
  readonly entityCount: number;
  /** How many relationships the index carries. */
  readonly relationshipCount: number;
  /** Recognized event names with their counts (canonical order). */
  readonly recognizedEventNames: readonly EventNameTally[];
  /** Unknown event names skipped deterministically, with their counts (canonical order). */
  readonly skippedEventNames: readonly EventNameTally[];
}

/** Canonical entity-reference order: kind, then id. */
export const compareEntityRef = (left: EntityRef, right: EntityRef): number => {
  if (left.entityKind !== right.entityKind) {
    return left.entityKind < right.entityKind ? -1 : 1;
  }
  if (left.entityId !== right.entityId) {
    return left.entityId < right.entityId ? -1 : 1;
  }
  return 0;
};

/** Canonical relationship order: kind, from, to, producing event id. */
export const compareRelationship = (left: Relationship, right: Relationship): number => {
  if (left.kind !== right.kind) {
    return left.kind < right.kind ? -1 : 1;
  }
  const from = compareEntityRef(left.from, right.from);
  if (from !== 0) return from;
  const to = compareEntityRef(left.to, right.to);
  if (to !== 0) return to;
  if (left.provenance.eventId !== right.provenance.eventId) {
    return left.provenance.eventId < right.provenance.eventId ? -1 : 1;
  }
  return 0;
};

/** Canonical entity-node order: entity kind, then id. */
export const compareEntityNode = (left: EntityNode, right: EntityNode): number =>
  compareEntityRef(left.entity, right.entity);

/** The canonical relationship index — a derived, rebuildable projection. */
export interface RelationshipIndex {
  /** Every relationship edge, in canonical order. */
  readonly relationships: readonly Relationship[];
  /** Every tracked entity node (edge endpoints + recognized aggregates), in canonical order. */
  readonly entities: readonly EntityNode[];
  /** The projection's derivation metadata. */
  readonly derivation: DerivationMetadata;
  /** All relationships incident to one entity (both directions), in canonical order. */
  relationshipsOf(entity: EntityRef): readonly Relationship[];
  /** The tracked node of one entity, or null when the index has never seen it. */
  entityNodeOf(entity: EntityRef): EntityNode | null;
}

// ---------------------------------------------------------------------------
// Traversal queries.
// ---------------------------------------------------------------------------

/** Which edge directions a traversal follows from each reached node. */
export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

/** The default traversal direction when the query omits one. */
export const DEFAULT_TRAVERSAL_DIRECTION: TraversalDirection = 'both';

/** Upper bound of the traversal depth limit (fail-closed parse bound). */
export const MAX_TRAVERSAL_DEPTH = 16;

/** The direction a traversal expands along each relationship edge. */
const TRAVERSAL_DIRECTIONS: readonly TraversalDirection[] = [
  'outgoing',
  'incoming',
  'both',
];

/**
 * A traversal query: the start entity, an optional relationship-vocabulary
 * filter, a depth limit, an optional entity-kind filter, and the edge
 * direction to follow (default 'both').
 */
export interface TraversalQuery {
  /** The entity the traversal starts from. */
  readonly start: EntityRef;
  /** Relationship kinds to traverse (default: all five kinds). */
  readonly relationshipKinds?: readonly RelationshipKind[];
  /** Maximum edge steps from the start (1..MAX_TRAVERSAL_DEPTH). */
  readonly maxDepth: number;
  /** Entity kinds of the nodes the subgraph may contain (default: every kind). */
  readonly entityKinds?: readonly EntityKind[];
  /** Edge direction followed from each node (default 'both'). */
  readonly direction?: TraversalDirection;
}

/** Shape description used in parse failures. */
export const TRAVERSAL_QUERY_GRAMMAR =
  "TraversalQuery: { start: EntityRef, relationshipKinds?: RelationshipKind[], maxDepth: 1..16, entityKinds?: EntityKind[], direction?: 'outgoing' | 'incoming' | 'both' }";

const TRAVERSAL_QUERY_KEYS = [
  'start',
  'relationshipKinds',
  'maxDepth',
  'entityKinds',
  'direction',
] as const;

const describeValue = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  if (typeof raw === 'number' || typeof raw === 'boolean') return `${typeof raw} ${String(raw)}`;
  return typeof raw;
};

const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const parseStringArray = (
  raw: unknown,
  field: string,
  parseItem: (item: unknown) => ParseResult<string>,
): ParseResult<readonly string[]> => {
  if (!Array.isArray(raw)) {
    return parseFail('invalid-type', field, 'array', describeValue(raw));
  }
  const items: string[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = parseItem(item);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        `${field}[${index}]`,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    if (items.includes(parsed.value)) {
      return parseFail('invalid-value', `${field}[${index}]`, 'no duplicates', describeValue(item));
    }
    items.push(parsed.value);
  }
  return parseOk(items);
};

/** Parse an untrusted value as a TraversalQuery (total, fail-closed, strict keys). */
export function parseTraversalQuery(raw: unknown): ParseResult<TraversalQuery> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', TRAVERSAL_QUERY_GRAMMAR, describeValue(raw));
  }
  const knownKeys = new Set<string>(TRAVERSAL_QUERY_KEYS);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      // The contracts taxonomy's strict-keys code: a field unknown to the
      // TraversalQuery shape is present.
      return parseFail('unknown-field', key, TRAVERSAL_QUERY_GRAMMAR, 'present');
    }
  }
  const start = parseEntityRef(raw['start']);
  if (!start.ok) {
    return parseFail(start.error.code, 'start', start.error.expected, start.error.received);
  }
  const relationshipKindsRaw = raw['relationshipKinds'];
  let relationshipKinds: readonly RelationshipKind[] | undefined;
  if (relationshipKindsRaw !== undefined) {
    const kinds = parseStringArray(relationshipKindsRaw, 'relationshipKinds', (item) =>
      parseRelationshipKind(item),
    );
    if (!kinds.ok) {
      return parseFail(kinds.error.code, kinds.error.path, kinds.error.expected, kinds.error.received);
    }
    relationshipKinds = kinds.value as readonly RelationshipKind[];
  }
  const maxDepthRaw = raw['maxDepth'];
  if (typeof maxDepthRaw !== 'number' || !Number.isInteger(maxDepthRaw)) {
    return parseFail('invalid-type', 'maxDepth', `integer 1..${MAX_TRAVERSAL_DEPTH}`, describeValue(maxDepthRaw));
  }
  if (maxDepthRaw < 1 || maxDepthRaw > MAX_TRAVERSAL_DEPTH) {
    return parseFail('invalid-value', 'maxDepth', `integer 1..${MAX_TRAVERSAL_DEPTH}`, String(maxDepthRaw));
  }
  const entityKindsRaw = raw['entityKinds'];
  let entityKinds: readonly EntityKind[] | undefined;
  if (entityKindsRaw !== undefined) {
    const kinds = parseStringArray(entityKindsRaw, 'entityKinds', (item) => parseEntityKind(item));
    if (!kinds.ok) {
      return parseFail(kinds.error.code, kinds.error.path, kinds.error.expected, kinds.error.received);
    }
    entityKinds = kinds.value as readonly EntityKind[];
  }
  const directionRaw = raw['direction'];
  let direction: TraversalDirection | undefined;
  if (directionRaw !== undefined) {
    if (typeof directionRaw !== 'string' || !(TRAVERSAL_DIRECTIONS as readonly string[]).includes(directionRaw)) {
      return parseFail(
        'invalid-value',
        'direction',
        "'outgoing' | 'incoming' | 'both'",
        describeValue(directionRaw),
      );
    }
    direction = directionRaw as TraversalDirection;
  }
  const query: {
    start: EntityRef;
    relationshipKinds?: readonly RelationshipKind[];
    maxDepth: number;
    entityKinds?: readonly EntityKind[];
    direction?: TraversalDirection;
  } = { start: start.value, maxDepth: maxDepthRaw };
  if (relationshipKinds !== undefined) query.relationshipKinds = relationshipKinds;
  if (entityKinds !== undefined) query.entityKinds = entityKinds;
  if (direction !== undefined) query.direction = direction;
  return parseOk(query satisfies TraversalQuery);
}

/** Type guard for structurally valid TraversalQuery values. */
export function isTraversalQuery(raw: unknown): raw is TraversalQuery {
  return parseTraversalQuery(raw).ok;
}

// ---------------------------------------------------------------------------
// Traversal results.
// ---------------------------------------------------------------------------

/** One reachable, authorization-visible node of a traversal subgraph. */
export interface TraversalNode {
  /** The reached entity. */
  readonly entity: EntityRef;
  /** The node's observed owning scope (from the index). */
  readonly scope: Scope;
  /** Smallest edge-step count from the start to this node (start = 0). */
  readonly depth: number;
}

/** The authorization-filtered reachable subgraph of one traversal. */
export interface TraversalSubgraph {
  /** The query the subgraph answers. */
  readonly query: TraversalQuery;
  /** The start entity (depth 0, always visible). */
  readonly start: EntityRef;
  /** Every visible reached node (start included), in canonical (depth, kind, id) order. */
  readonly nodes: readonly TraversalNode[];
  /** Every traversed edge (both endpoints visible), in canonical order. */
  readonly edges: readonly Relationship[];
  /** The deepest visible node depth (0 when only the start is visible). */
  readonly depthReached: number;
}

// ---------------------------------------------------------------------------
// Causal chains.
// ---------------------------------------------------------------------------

/** One step of a reconstructed causal chain: the causing command. */
export interface CommandCausationStep {
  readonly kind: 'command';
  /** The command's idempotency key — the causation token of the ledger convention. */
  readonly idempotencyKey: CausationId;
  /** The causal chain the command belongs to. */
  readonly correlationId: CorrelationId;
}

/** One step of a reconstructed causal chain: a ledger event. */
export interface EventCausationStep {
  readonly kind: 'event';
  /** The event's ledger id. */
  readonly eventId: LedgerEventId;
  /** The event's name. */
  readonly eventName: EventName;
  /** The aggregate stream the event belongs to. */
  readonly aggregate: EntityRef;
  /** Dense per-(tenant, aggregate) position of the event. */
  readonly sequence: LedgerSequence;
  /** The event's actor. */
  readonly actor: Actor;
  /** The event's occurred-at time. */
  readonly occurredAt: Timestamp;
  /** The causal chain the event belongs to. */
  readonly correlationId: CorrelationId;
  /** The event's causation id (the preceding step, or null at chain roots). */
  readonly causationId: CausationId | null;
}

/** A step of a causal chain: the causing command or one ledger event. */
export type CausalChainStep = CommandCausationStep | EventCausationStep;

/**
 * The reconstructed causal chain of ONE relationship: the chain of commands
 * and events that produced it, ordered root-first — ending with the event
 * that asserted the edge (the edge's provenance).
 */
export interface RelationshipCausalChain {
  /** The relationship the chain explains. */
  readonly relationship: Relationship;
  /** The chain steps, root (command or root event) first, producing event last. */
  readonly steps: readonly CausalChainStep[];
}

/** The causal chains behind one entity's current (visible) relationships. */
export interface EntityCausalChains {
  /** The entity the chains belong to. */
  readonly entity: EntityRef;
  /** One reconstructed chain per visible incident relationship, in canonical relationship order. */
  readonly chains: readonly RelationshipCausalChain[];
}
