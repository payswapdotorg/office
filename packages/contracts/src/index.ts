// Office canonical contracts — public surface (OFF-002).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-003 domain-kernel and everything after) consume the package only
// through its root entry point, never through deeper paths. Anything not
// re-exported here is package-internal and may change without notice.
//
// Keep this surface minimal and stable: extending it requires the contracts
// owner or Tech Lead approval (dependency rule — contracts are the
// innermost shared kernel and import nothing).
//
// Surface summary:
// - parse plumbing: ParseResult / ContractParseError (fail-closed parsing)
// - identity:       EntityId, TenantId, ProjectId, EntityKind (+ IdParts)
// - scope:          Scope = TenantScope | ProjectScope (A12)
// - actor:          Actor (user/agent/app/adapter/system)
// - time:           Timestamp (canonical UTC RFC 3339)
// - versioning:     SchemaVersion, KNOWN/CURRENT_SCHEMA_VERSION (fail-closed)
// - pagination:     Page<T>, PageCursor
// - events:         DomainEventEnvelope, Causality, EventName, EventSource,
//                   CorrelationId, CausationId, EntityRef(s) (A3)
// - commands:       CommandEnvelope, CommandName, IdempotencyKey (A8/ADR-005)
// - errors:         ApiError, ApiErrorCode, ApiErrorDetail

// Fail-closed parse plumbing.
export { parseFail, parseOk } from './parse';
export type {
  ContractParseError,
  ContractParseErrorCode,
  ParseResult,
} from './parse';

// Branded opaque canonical IDs and entity kinds.
export {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  isEntityId,
  isEntityKind,
  isProjectId,
  isTenantId,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
} from './identity';
export type {
  EntityId,
  EntityKind,
  IdParts,
  IdVersion,
  ProjectId,
  TenantId,
} from './identity';
export { KNOWN_ID_VERSIONS } from './identity';

// Tenant/project scope (freeze A12).
export { isScope, parseScope } from './scope';
export type { ProjectScope, Scope, TenantScope } from './scope';

// Actor provenance (freeze A3, ADR-005).
export { isActor, parseActor } from './actor';
export type {
  Actor,
  ActorKind,
  IdentifiedActor,
  IdentifiedActorKind,
  SystemActor,
} from './actor';

// Canonical UTC timestamps.
export { formatTimestamp, isTimestamp, parseTimestamp } from './time';
export type { Timestamp } from './time';

// Fail-closed schema versioning.
export {
  CURRENT_SCHEMA_VERSION,
  isKnownSchemaVersion,
  KNOWN_SCHEMA_VERSIONS,
  parseSchemaVersion,
} from './version';
export type { SchemaVersion, SemverString } from './version';

// Pagination envelope.
export { isPage, isPageCursor, parsePage, parsePageCursor } from './pagination';
export type { Page, PageCursor } from './pagination';

// Domain event envelope + causality (freeze A3).
export {
  isCausality,
  isCausationId,
  isCorrelationId,
  isDomainEventEnvelope,
  isEntityRef,
  isEntityRefs,
  isEventName,
  parseCausality,
  parseCausationId,
  parseCorrelationId,
  parseDomainEventEnvelope,
  parseEntityRef,
  parseEntityRefs,
  parseEventName,
} from './events';
export type {
  Causality,
  CausationId,
  CorrelationId,
  DomainEventEnvelope,
  EntityRef,
  EntityRefs,
  EventName,
  EventSource,
} from './events';

// Command envelope (freeze A8 / ADR-005 idempotency).
export {
  isCommandEnvelope,
  isCommandName,
  isIdempotencyKey,
  parseCommandEnvelope,
  parseCommandName,
  parseIdempotencyKey,
} from './commands';
export type { CommandEnvelope, CommandName, IdempotencyKey } from './commands';

// API error envelope.
export { isApiError, parseApiError } from './errors';
export type { ApiError, ApiErrorCode, ApiErrorDetail } from './errors';
