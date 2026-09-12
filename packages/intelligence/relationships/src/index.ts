// Office intelligence — public surface (OFF-013).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-014 margin engine, OFF-015 enterprise memory, OFF-016 workflows,
// OFF-017 action gateway) consume the package only through its root entry
// point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package imports exactly four workspace dependencies — @office/contracts
// (envelope + entity/identity contracts), @office/domain-kernel
// (Result/DomainError), @office/authz (authorize + scope isolation for
// traversal-time filtering), and @office/events (the ledger READ surface +
// deterministic ledger event id derivation; this package never writes the
// ledger) — plus node builtins. No new external dependencies. The domain
// packages are NEVER imported: their event SHAPES are consumed through the
// @office/contracts envelope types only (the relationship engine is a
// projection, not a domain peer — the dependency rule).
//
// Surface summary:
// - vocabulary:   RelationshipKind, RELATIONSHIP_KINDS, parse/isRelationshipKind,
//                 KNOWN_ENTITY_KINDS, readCapabilityOfKind, RECOGNIZED_EVENT_NAMES,
//                 isRecognizedEventName (+ the entity kind constants)
// - model:        Relationship, RelationshipProvenance, EntityNode,
//                 EventNameTally, DerivationMetadata, RelationshipIndex,
//                 TraversalQuery (+ parse/is, MAX_TRAVERSAL_DEPTH),
//                 TraversalSubgraph, TraversalNode, CausalChainStep,
//                 RelationshipCausalChain, EntityCausalChains,
//                 compareEntityRef/compareEntityNode/compareRelationship
// - projection:   projectRelationships (the deterministic, rebuildable fold)
// - traversal:    traverseRelationships (authorization-filtered BFS)
// - causality:    causalChainOfRelationship, causalChainsOf
// - authorization: TraversalAuthorization, nodeResource, checkNodeReadable,
//                 checkEventReadable
// - source:       RelationshipEventSource (the ledger read port),
//                 createInMemoryEventSource (+ InMemoryEventSource)
//
// src/test-support.ts and src/fixtures.ts are package-INTERNAL test
// modules (deterministic envelope factories and golden fixtures) — they
// are not part of the public surface.

// Relationship kinds + the local entity-kind/event-name vocabularies.
export {
  RELATIONSHIP_KINDS,
  RELATIONSHIP_KIND_GRAMMAR,
  isRelationshipKind,
  parseRelationshipKind,
} from './vocabulary';
export type { RelationshipKind } from './vocabulary';
export {
  KNOWN_ENTITY_KINDS,
  RECOGNIZED_EVENT_NAMES,
  isRecognizedEventName,
  readCapabilityOfKind,
} from './vocabulary';
export {
  ACTIVITY_KIND,
  BASELINE_KIND,
  BUDGET_KIND,
  BUDGET_REVISION_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CLAIM_REFERENCE_KIND,
  COMMITMENT_AMENDMENT_KIND,
  COMMITMENT_KIND,
  COMMITMENT_LINE_KIND,
  CONTRACT_KIND,
  COST_ITEM_KIND,
  DAILY_LOG_KIND,
  DOCUMENT_KIND,
  EVIDENCE_REFERENCE_KIND,
  FIELD_EVENT_KIND,
  FIELD_ISSUE_KIND,
  INSPECTION_KIND,
  INVOICE_KIND,
  INVOICE_LINE_KIND,
  MILESTONE_KIND,
  ORGANIZATION_KIND,
  PAYMENT_REFERENCE_KIND,
  PROGRESS_UPDATE_KIND,
  PROJECT_KIND,
  REVISION_KIND,
  SCHEDULE_KIND,
  SCOPE_OBLIGATION_KIND,
} from './vocabulary';

// The relationship model + traversal/causal query shapes.
export {
  compareEntityNode,
  compareEntityRef,
  compareRelationship,
  isTraversalQuery,
  parseTraversalQuery,
} from './model';
export {
  DEFAULT_TRAVERSAL_DIRECTION,
  MAX_TRAVERSAL_DEPTH,
  TRAVERSAL_QUERY_GRAMMAR,
} from './model';
export type {
  CommandCausationStep,
  CausalChainStep,
  DerivationMetadata,
  EntityCausalChains,
  EntityNode,
  EventCausationStep,
  EventNameTally,
  Relationship,
  RelationshipCausalChain,
  RelationshipIndex,
  RelationshipProvenance,
  TraversalDirection,
  TraversalNode,
  TraversalQuery,
  TraversalSubgraph,
} from './model';

// The deterministic, rebuildable projection (freeze A2/A7).
export { projectRelationships } from './projection';

// Authorization-filtered traversal (freeze A12 at traversal time).
export { traverseRelationships } from './traversal';

// Causal-chain queries (provenance + causality reconstruction).
export { causalChainOfRelationship, causalChainsOf } from './causality';

// Traversal-time authorization.
export { checkEventReadable, checkNodeReadable, nodeResource } from './authorization';
export type { TraversalAuthorization } from './authorization';

// The ledger READ port + the deterministic in-memory source for tests.
export { createInMemoryEventSource } from './source';
export type { InMemoryEventSource, RelationshipEventSource } from './source';
