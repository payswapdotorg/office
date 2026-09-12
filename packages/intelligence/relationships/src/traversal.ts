// Office intelligence — authorization-filtered traversal (OFF-013).
//
// traverseRelationships() answers a TraversalQuery with the reachable
// subgraph of the relationship index, filtering EVERY candidate node
// through checkNodeReadable at traversal time (deny-by-default; structural
// A12 isolation first). A node the caller may not read is INVISIBLE: it is
// absent from the subgraph, its edges are dropped, and paths through it do
// not exist — the graph is never an existence oracle, in either direction
// (a caller in tenant A learns nothing about tenant B's nodes, and vice
// versa). The START node is special-cased: a scope-uncovered start is a
// typed not-found (identical to reading a foreign ledger row), and a
// capability/policy denial of the start is the typed forbidden error — so
// "no relationships" is never conflated with "not visible".
//
// Deterministic: breadth-first expansion over canonically ordered edge
// lists, deduplicated nodes (smallest depth wins) and edges, and canonically
// sorted output — the same index + query + authorization always produce the
// byte-identical subgraph.
import { entityNotFound, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { EntityRef } from '@office/contracts';
import type {
  Relationship,
  RelationshipIndex,
  TraversalNode,
  TraversalQuery,
  TraversalSubgraph,
} from './model';
import { compareRelationship, DEFAULT_TRAVERSAL_DIRECTION } from './model';
import { checkNodeReadable } from './authorization';
import type { TraversalAuthorization } from './authorization';

const nodeKey = (entity: EntityRef): string => `${entity.entityKind}|${entity.entityId}`;

const compareTraversalNode = (left: TraversalNode, right: TraversalNode): number => {
  if (left.depth !== right.depth) return left.depth - right.depth;
  if (left.entity.entityKind !== right.entity.entityKind) {
    return left.entity.entityKind < right.entity.entityKind ? -1 : 1;
  }
  if (left.entity.entityId !== right.entity.entityId) {
    return left.entity.entityId < right.entity.entityId ? -1 : 1;
  }
  return 0;
};

/**
 * Traverse the relationship index from the query's start entity and return
 * the authorization-filtered reachable subgraph. The start entity is
 * included when the caller can read it; every further node must match the
 * optional entity-kind filter AND pass checkNodeReadable; expansion stops
 * at maxDepth edges from the start. Non-matching or unreadable nodes are
 * not traversed through — the subgraph contains only what the caller may
 * see, and nothing about what it may not.
 */
export function traverseRelationships(
  index: RelationshipIndex,
  query: TraversalQuery,
  authorization: TraversalAuthorization,
): Result<TraversalSubgraph, DomainError> {
  const startNode = index.entityNodeOf(query.start);
  if (startNode === null) {
    return fail(
      entityNotFound(
        { entityKind: query.start.entityKind, entityId: query.start.entityId },
        { scope: authorization.context.scope },
      ),
    );
  }
  const startCheck = checkNodeReadable(authorization, startNode);
  if (!startCheck.ok) {
    if (startCheck.error.code === 'unauthorized') {
      // No existence oracle: a start outside the caller's scope is simply
      // not found — identical to reading a foreign ledger event row.
      return fail(
        entityNotFound(
          { entityKind: query.start.entityKind, entityId: query.start.entityId },
          { scope: authorization.context.scope },
        ),
      );
    }
    return fail(startCheck.error);
  }

  const kindFilter =
    query.relationshipKinds === undefined ? null : new Set<string>(query.relationshipKinds);
  const entityKindFilter =
    query.entityKinds === undefined ? null : new Set<string>(query.entityKinds);
  const direction = query.direction ?? DEFAULT_TRAVERSAL_DIRECTION;

  const depthOf = new Map<string, number>();
  const nodes: TraversalNode[] = [
    { entity: startNode.entity, scope: startNode.scope, depth: 0 },
  ];
  depthOf.set(nodeKey(startNode.entity), 0);
  const queue: EntityRef[] = [startNode.entity];
  const includedEdges = new Map<string, Relationship>();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) continue;
    const currentDepth = depthOf.get(nodeKey(current)) ?? 0;
    if (currentDepth >= query.maxDepth) continue;

    for (const edge of index.relationshipsOf(current)) {
      if (kindFilter !== null && !kindFilter.has(edge.kind)) continue;
      const followsOutgoing = edge.from.entityId === current.entityId;
      const followsIncoming = edge.to.entityId === current.entityId;
      let target: EntityRef;
      if (followsOutgoing && direction !== 'incoming') {
        target = edge.to;
      } else if (followsIncoming && direction !== 'outgoing') {
        target = edge.from;
      } else {
        continue;
      }
      if (entityKindFilter !== null && !entityKindFilter.has(target.entityKind)) continue;
      const targetNode = index.entityNodeOf(target);
      if (targetNode === null) continue;
      if (!checkNodeReadable(authorization, targetNode).ok) continue; // invisible
      includedEdges.set(
        `${edge.kind}\u0000${nodeKey(edge.from)}\u0000${nodeKey(edge.to)}`,
        edge,
      );
      const targetKey = nodeKey(target);
      if (!depthOf.has(targetKey)) {
        depthOf.set(targetKey, currentDepth + 1);
        nodes.push({ entity: targetNode.entity, scope: targetNode.scope, depth: currentDepth + 1 });
        queue.push(target);
      }
    }
  }

  const edges = [...includedEdges.values()].sort(compareRelationship);
  const sortedNodes = [...nodes].sort(compareTraversalNode);
  const depthReached = sortedNodes.reduce(
    (deepest, node) => Math.max(deepest, node.depth),
    0,
  );
  return ok({
    query,
    start: query.start,
    nodes: sortedNodes,
    edges,
    depthReached,
  } satisfies TraversalSubgraph);
}
