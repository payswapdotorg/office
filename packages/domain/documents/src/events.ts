// Office documents domain — audit events + the EventSink port (OFF-008).
//
// Freeze A3: every consequential domain mutation emits an immutable domain
// event carrying event name, tenant/project scope, actor, source, correlation
// and causation ids, schema version, occurred-at, and before/after entity
// references. This module defines the documents/evidence event vocabulary and
// the builder that turns a command envelope + the mutation result into a
// DomainEventEnvelope. Event names and payloads:
//
//  * documents.documentRegistered   — a document aggregate was created;
//  * documents.documentArchived     — the one-way lifecycle transition;
//  * documents.revisionAttached     — the chain ROOT revision was attached
//                                      (before = null, after = the revision);
//  * documents.revisionSuperseded   — a successor revision was appended
//                                      (before = the superseded revision,
//                                      after = the successor);
//  * documents.evidenceReferenced   — an immutable evidence reference was
//                                      created pinning (entity, document,
//                                      revision) (before = null, after = the
//                                      reference).
//
// The EventSink PORT (mirrored byte-for-byte in shape from the identity
// domain packages of OFF-007, so any transactional implementation satisfies
// both structurally): command handlers hand their envelope(s) to an injected
// sink TOGETHER with the staged state mutations, inside the SAME unit of work
// — the sink receives the unit's SqlExecutor so a real implementation (the
// OFF-005 event ledger, wired by the runtime) writes the ledger rows in the
// surrounding transaction and the whole mutation is atomic. This package
// ships an in-memory sink for tests plus the failing sink for failure paths.
// The two domain packages stay independent (no domain-to-domain imports,
// dependency rule).
import {
  CURRENT_SCHEMA_VERSION,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEventName,
} from '@office/contracts';
import type {
  CommandEnvelope,
  Causality,
  DomainEventEnvelope,
  EntityId,
  EntityKind,
  EntityRef,
  EntityRefs,
  EventName,
  ProjectId,
  Scope,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { RevisionHash, StorageKey } from './storage';
import type { DocumentStatus } from './state';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid documents event name literal: ${name}`);
  }
  return parsed.value;
};

/** Event name of the document-registered lifecycle event (A3 audit). */
export const DOCUMENT_REGISTERED_EVENT: EventName = eventNameOf(
  'documents.documentRegistered',
);
/** Event name of the document-archived lifecycle event (A3 audit). */
export const DOCUMENT_ARCHIVED_EVENT: EventName = eventNameOf(
  'documents.documentArchived',
);
/** Event name of the revision-attached event (the chain root, A3 audit). */
export const REVISION_ATTACHED_EVENT: EventName = eventNameOf(
  'documents.revisionAttached',
);
/** Event name of the revision-superseded event (A3 audit). */
export const REVISION_SUPERSEDED_EVENT: EventName = eventNameOf(
  'documents.revisionSuperseded',
);
/** Event name of the evidence-referenced event (A3/A4 audit). */
export const EVIDENCE_REFERENCED_EVENT: EventName = eventNameOf(
  'documents.evidenceReferenced',
);

/** Audit payload of `documents.documentRegistered`. */
export interface DocumentRegisteredPayload {
  readonly documentId: EntityId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: DocumentStatus;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `documents.documentArchived`. */
export interface DocumentArchivedPayload {
  readonly documentId: EntityId;
  readonly status: DocumentStatus;
  readonly archivedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Shared content-addressing fields of the revision events. */
interface RevisionContentFields {
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
  readonly contentHash: RevisionHash;
  readonly storageKey: StorageKey;
  readonly byteSize: number;
  /** Document aggregate version AFTER the mutation. */
  readonly version: number;
}

/** Audit payload of `documents.revisionAttached`. */
export interface RevisionAttachedPayload extends RevisionContentFields {
  /** The attached revision is the chain root: it supersedes nothing. */
  readonly supersedes: null;
  readonly attachedAt: Timestamp;
}

/** Audit payload of `documents.revisionSuperseded`. */
export interface RevisionSupersededPayload extends RevisionContentFields {
  /** The prior revision THIS revision supersedes (forward link). */
  readonly supersedes: EntityId;
  readonly supersededAt: Timestamp;
}

/** Audit payload of `documents.evidenceReferenced`. */
export interface EvidenceReferencedPayload {
  readonly evidenceReferenceId: EntityId;
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
  readonly evidencedEntityKind: EntityKind;
  readonly evidencedEntityId: EntityId;
  readonly referencedAt: Timestamp;
}

/** Union of every documents-domain audit payload. */
export type DocumentsEventPayload =
  | DocumentRegisteredPayload
  | DocumentArchivedPayload
  | RevisionAttachedPayload
  | RevisionSupersededPayload
  | EvidenceReferencedPayload;

/**
 * Derive the event causality from the command envelope (the OFF-005 ledger
 * convention): the correlation id of the causal chain is carried over; the
 * causation id of the resulting event is the COMMAND's idempotency key — the
 * id of the message that caused this mutation. Trusted path: the envelope was
 * already validated (the idempotency-key grammar is exactly the causation-id
 * grammar), so a parse failure here is a loud TypeError, never a silent drop.
 */
const causalityOf = (command: CommandEnvelope<unknown>): Causality => {
  const causationId = parseCausationId(command.idempotencyKey);
  if (!causationId.ok) {
    throw new TypeError(
      `command idempotency key is not a valid causation id: ${command.idempotencyKey}`,
    );
  }
  return {
    correlationId: command.causality.correlationId,
    causationId: causationId.value,
  };
};

/**
 * Build one documents-domain event envelope (trusted path; self-checked
 * through the contracts parser so an emitted event can never be invalid):
 * source is 'domain' by definition, scope is the owning document's project
 * scope, actor and causal chain come from the command, occurredAt from the
 * injected clock, and entityRefs carry before/after per transition kind
 * (creation events: before null; supersession: before = superseded, after =
 * successor; lifecycle: before = after = the aggregate).
 */
export function documentsEventEnvelope(
  parts: {
    readonly command: CommandEnvelope<unknown>;
    readonly eventName: EventName;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly entityRefs: EntityRefs;
    readonly payload: DocumentsEventPayload;
  },
): DomainEventEnvelope<DocumentsEventPayload> {
  const envelope = {
    kind: 'event',
    eventName: parts.eventName,
    scope: parts.scope,
    actor: parts.command.actor,
    source: 'domain',
    causality: causalityOf(parts.command),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: parts.occurredAt,
    entityRefs: parts.entityRefs,
    payload: parts.payload,
  } as const satisfies DomainEventEnvelope;
  const checked = parseDomainEventEnvelope(envelope);
  if (!checked.ok) {
    throw new TypeError(
      `documents event envelope failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<DocumentsEventPayload>;
}

/** Entity reference of a canonical entity by kind and id (before/after refs, A3). */
export const entityRefOf = (entityKind: EntityKind, entityId: EntityId): EntityRef => ({
  entityKind,
  entityId,
});

/**
 * THE EventSink port (minimal, by design — mirrored from the identity domain
 * packages): append audit events using the caller's open transaction
 * executor, so a real implementation writes them atomically with the mutation
 * that produced them. The in-memory sink below records instead of writing;
 * the OFF-005 ledger implements this port in the runtime.
 */
export interface EventSink {
  /**
   * Append `events` inside the transaction of `executor`. A failure result
   * MUST abort the surrounding mutation (handlers roll the unit of work
   * back), so a partially-applied mutation can never commit.
   */
  appendEvents(
    executor: SqlExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedEventAppend {
  /** The executor the sink was handed (the open transaction in handlers). */
  readonly executor: SqlExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory EventSink: records appends instead of writing (tests). */
export interface InMemoryEventSink extends EventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedEventAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory EventSink for deterministic tests. */
export function createInMemoryEventSink(): InMemoryEventSink {
  const appends: RecordedEventAppend[] = [];
  return {
    appends,
    get events(): readonly DomainEventEnvelope[] {
      return appends.flatMap((append) => append.events);
    },
    appendEvents: async (executor, events) => {
      appends.push({ executor, events: [...events] });
      return ok(true);
    },
  };
}

/** Build a typed sink failure (for tests and wiring guards). */
export const eventSinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `event sink rejected the append: ${reason}`,
    [{ code: 'event-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingEventSink = (reason: string): EventSink => ({
  appendEvents: async () => fail(eventSinkFailure(reason)),
});
