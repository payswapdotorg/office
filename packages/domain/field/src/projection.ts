// Office field domain — the project read model (OFF-009).
//
// An in-memory projection REBUILT FROM THE EMITTED EVENT ENVELOPES (freeze
// A2/A6: projections are replaceable derived views, never the canonical write
// authority): apply() consumes one DomainEventEnvelope at a time — in ledger
// order at the runtime, in sink order in tests — and the per-project query
// surface answers the three reads the work item names:
//
//   * recent field events of a project (newest capture first);
//   * the project's currently OPEN issues;
//   * the project's recorded inspection outcomes (with their findings).
//
// The projection reads ONLY the envelopes: every field it needs is parsed
// fail-closed out of the event payloads, which is exactly what proves the
// event shapes are SUFFICIENT to answer the reads (the acceptance test
// compares the projection's answers with the aggregate states in the store).
// It is NOT a persistence layer and carries no authorization surface — the
// app layer authorizes reads (A12) before querying.
//
// Determinism (kernel rule): no clock, no randomness, no I/O — the arrival
// order of the applied envelopes is the only ordering input (the ledger's
// sequence order in production; client-observed timestamps are payload data
// and are never used for ordering).
import type {
  DomainEventEnvelope,
  EntityId,
  EventName,
  ProjectId,
  Timestamp,
} from '@office/contracts';
import { parseEntityId, parseTimestamp } from '@office/contracts';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  DAILY_LOG_DAY_CLOSED_EVENT,
  DAILY_LOG_ENTRY_APPENDED_EVENT,
  FIELD_EVENT_CAPTURED_EVENT,
  FIELD_EVENT_EVIDENCE_ATTACHED_EVENT,
  FIELD_EVENT_RESOLVED_EVENT,
  INSPECTION_CONDUCTED_EVENT,
  INSPECTION_OUTCOMED_EVENT,
  INSPECTION_SCHEDULED_EVENT,
  ISSUE_ASSIGNED_EVENT,
  ISSUE_COMMENTED_EVENT,
  ISSUE_RAISED_EVENT,
  ISSUE_REOPENED_EVENT,
  ISSUE_RESOLVED_EVENT,
} from './events';
import type { IssueSeverity, InspectionOutcome } from './state';
import { FIELD_EVENT_NAMES } from './events';
import { isPlainObject, parseLiteralOf, requireFieldWith, requireString } from './parse';

/** The projection's view of one field event (recent-events read). */
export interface FieldEventSummary {
  readonly fieldEventId: EntityId;
  readonly category: string;
  readonly summary: string;
  readonly location: string;
  readonly observedAt: Timestamp;
  readonly observedBy: EntityId;
  readonly status: 'open' | 'resolved';
}

/** The projection's view of one currently-open issue (open-issues read). */
export interface OpenIssueRecord {
  readonly issueId: EntityId;
  readonly title: string;
  readonly category: string;
  readonly severity: IssueSeverity;
  readonly assignee: EntityId | null;
}

/** The projection's view of one recorded inspection outcome. */
export interface InspectionOutcomeRecord {
  readonly inspectionId: EntityId;
  readonly title: string;
  readonly outcome: InspectionOutcome;
  readonly findings: readonly EntityId[];
}

/** Fail-closed view of a foreign event name (the projection's vocabulary is closed). */
const unknownEventName = (eventName: EventName): DomainError =>
  domainError(
    'invariant-violation',
    `the field read model consumes the field domain's event vocabulary; '${eventName}' is not one of them`,
    [{ code: 'unknown-field-event', message: eventName, path: 'eventName' }],
  );

/** Fail-closed view of a non-project-scoped event (field events are project-bound). */
const nonProjectScope = (): DomainError =>
  domainError(
    'invariant-violation',
    "the field read model consumes project-scoped events; a tenant-scoped envelope is not a field domain event",
    [{ code: 'read-model-requires-project-scope', message: 'tenant', path: 'scope' }],
  );

// The projection's internal, MUTABLE fold state (the public records below are
// derived read-only views of it).
interface MutableFieldEventSummary {
  fieldEventId: EntityId;
  category: string;
  summary: string;
  location: string;
  observedAt: Timestamp;
  observedBy: EntityId;
  status: 'open' | 'resolved';
}

interface MutableOpenIssue {
  issueId: EntityId;
  title: string;
  category: string;
  severity: IssueSeverity;
  assignee: EntityId | null;
  open: boolean;
}

interface MutableInspection {
  title: string;
  outcome: InspectionOutcome | null;
  findings: readonly EntityId[];
}

const parseStatus = parseLiteralOf(['open', 'resolved'] as const, 'issue/field-event status');
const parseSeverity = parseLiteralOf(
  ['low', 'medium', 'high', 'critical'] as const,
  'issue severity',
);
const parseOutcome = parseLiteralOf(['passed', 'failed', 'partial'] as const, 'inspection outcome');

/** Fail-closed view of a payload field the projection needs but cannot read. */
const unreadablePayload = (eventName: EventName, field: string): DomainError =>
  domainError(
    'invariant-violation',
    `the payload of '${eventName}' does not carry a readable '${field}' — the event shape is insufficient for the read model`,
    [{ code: 'read-model-payload-field', message: field, path: `payload.${field}` }],
  );

/** Read one required string field of an event payload (fail-closed). */
const payloadString = (
  payload: Record<string, unknown>,
  eventName: EventName,
  field: string,
): Result<string, DomainError> => {
  const parsed = requireString(payload, field, '', { min: 1, max: 4000, description: field });
  if (!parsed.ok) return fail(unreadablePayload(eventName, field));
  return ok(parsed.value);
};

/** Read one required canonical id field of an event payload (fail-closed). */
const payloadEntityId = (
  payload: Record<string, unknown>,
  eventName: EventName,
  field: string,
): Result<EntityId, DomainError> => {
  const parsed = requireFieldWith(payload, field, '', parseEntityId);
  if (!parsed.ok) return fail(unreadablePayload(eventName, field));
  return ok(parsed.value);
};

/** Read one required timestamp field of an event payload (fail-closed). */
const payloadTimestamp = (
  payload: Record<string, unknown>,
  eventName: EventName,
  field: string,
): Result<Timestamp, DomainError> => {
  const parsed = requireFieldWith(payload, field, '', parseTimestamp);
  if (!parsed.ok) return fail(unreadablePayload(eventName, field));
  return ok(parsed.value);
};

/**
 * The project read model: apply() the emitted envelopes (ledger order), then
 * query per project. One instance may serve many projects; the queries are
 * per-project by construction (A12's second boundary at the read surface).
 */
export interface ProjectReadModel {
  /**
   * Fold one emitted event envelope into the model (fail-closed: unknown
   * event names and non-project scopes are typed invariant-violations — the
   * projection's inputs are this domain's own events).
   */
  apply(envelope: DomainEventEnvelope): Result<true, DomainError>;
  /** The project's recent field events, newest capture first. */
  recentFieldEvents(projectId: ProjectId, limit: number): readonly FieldEventSummary[];
  /** The project's currently-open issues, in raise order. */
  openIssues(projectId: ProjectId): readonly OpenIssueRecord[];
  /** The project's recorded inspection outcomes, in schedule order. */
  inspectionOutcomes(projectId: ProjectId): readonly InspectionOutcomeRecord[];
}

/** Create an empty project read model. */
export function createProjectReadModel(): ProjectReadModel {
  const fieldEventsByProject = new Map<ProjectId, MutableFieldEventSummary[]>();
  const issuesByProject = new Map<ProjectId, Map<EntityId, MutableOpenIssue>>();
  const inspectionsByProject = new Map<ProjectId, Map<EntityId, MutableInspection>>();

  const fieldEventsOf = (projectId: ProjectId): MutableFieldEventSummary[] => {
    const existing = fieldEventsByProject.get(projectId);
    if (existing !== undefined) return existing;
    const created: MutableFieldEventSummary[] = [];
    fieldEventsByProject.set(projectId, created);
    return created;
  };
  const issuesOf = (projectId: ProjectId): Map<EntityId, MutableOpenIssue> => {
    const existing = issuesByProject.get(projectId);
    if (existing !== undefined) return existing;
    const created = new Map<EntityId, MutableOpenIssue>();
    issuesByProject.set(projectId, created);
    return created;
  };
  const inspectionsOf = (projectId: ProjectId): Map<EntityId, MutableInspection> => {
    const existing = inspectionsByProject.get(projectId);
    if (existing !== undefined) return existing;
    const created = new Map<EntityId, MutableInspection>();
    inspectionsByProject.set(projectId, created);
    return created;
  };

  return {
    apply: (envelope) => {
      if (envelope.scope.kind !== 'project') return fail(nonProjectScope());
      if (!(FIELD_EVENT_NAMES as readonly string[]).includes(envelope.eventName)) {
        return fail(unknownEventName(envelope.eventName));
      }
      const projectId = envelope.scope.projectId;
      if (!isPlainObject(envelope.payload)) {
        return fail(unreadablePayload(envelope.eventName, '<root>'));
      }
      const payload = envelope.payload;

      switch (envelope.eventName) {
        case FIELD_EVENT_CAPTURED_EVENT: {
          const fieldEventId = payloadEntityId(payload, envelope.eventName, 'fieldEventId');
          if (!fieldEventId.ok) return fieldEventId;
          const category = payloadString(payload, envelope.eventName, 'category');
          if (!category.ok) return category;
          const summary = payloadString(payload, envelope.eventName, 'summary');
          if (!summary.ok) return summary;
          const location = payloadString(payload, envelope.eventName, 'location');
          if (!location.ok) return location;
          const observedAt = payloadTimestamp(payload, envelope.eventName, 'observedAt');
          if (!observedAt.ok) return observedAt;
          const observedBy = payloadEntityId(payload, envelope.eventName, 'observedBy');
          if (!observedBy.ok) return observedBy;
          fieldEventsOf(projectId).push({
            fieldEventId: fieldEventId.value,
            category: category.value,
            summary: summary.value,
            location: location.value,
            observedAt: observedAt.value,
            observedBy: observedBy.value,
            status: 'open',
          });
          return ok(true);
        }
        case FIELD_EVENT_RESOLVED_EVENT: {
          const fieldEventId = payloadEntityId(payload, envelope.eventName, 'fieldEventId');
          if (!fieldEventId.ok) return fieldEventId;
          const status = requireFieldWith(payload, 'status', '', parseStatus);
          if (!status.ok) return fail(unreadablePayload(envelope.eventName, 'status'));
          const summary = fieldEventsOf(projectId).find(
            (candidate) => candidate.fieldEventId === fieldEventId.value,
          );
          if (summary === undefined) {
            return fail(
              invariantViolation(
                {
                  name: 'read-model-resolves-field-event',
                  statement: `field event ${fieldEventId.value} resolved before it was captured (events must be applied in ledger order)`,
                },
              ),
            );
          }
          summary.status = status.value;
          return ok(true);
        }
        case ISSUE_RAISED_EVENT: {
          const issueId = payloadEntityId(payload, envelope.eventName, 'issueId');
          if (!issueId.ok) return issueId;
          const title = payloadString(payload, envelope.eventName, 'title');
          if (!title.ok) return title;
          const category = payloadString(payload, envelope.eventName, 'category');
          if (!category.ok) return category;
          const severity = requireFieldWith(payload, 'severity', '', parseSeverity);
          if (!severity.ok) return fail(unreadablePayload(envelope.eventName, 'severity'));
          issuesOf(projectId).set(issueId.value, {
            issueId: issueId.value,
            title: title.value,
            category: category.value,
            severity: severity.value,
            assignee: null,
            open: true,
          });
          return ok(true);
        }
        case ISSUE_ASSIGNED_EVENT: {
          const issueId = payloadEntityId(payload, envelope.eventName, 'issueId');
          if (!issueId.ok) return issueId;
          const assignee = payloadEntityId(payload, envelope.eventName, 'assignee');
          if (!assignee.ok) return assignee;
          const record = issuesOf(projectId).get(issueId.value);
          if (record === undefined) {
            return fail(
              invariantViolation(
                {
                  name: 'read-model-resolves-issue',
                  statement: `issue ${issueId.value} assigned before it was raised (events must be applied in ledger order)`,
                },
              ),
            );
          }
          record.assignee = assignee.value;
          return ok(true);
        }
        case ISSUE_RESOLVED_EVENT: {
          const issueId = payloadEntityId(payload, envelope.eventName, 'issueId');
          if (!issueId.ok) return issueId;
          const record = issuesOf(projectId).get(issueId.value);
          if (record === undefined) {
            return fail(
              invariantViolation(
                {
                  name: 'read-model-resolves-issue',
                  statement: `issue ${issueId.value} resolved before it was raised (events must be applied in ledger order)`,
                },
              ),
            );
          }
          record.open = false;
          return ok(true);
        }
        case ISSUE_REOPENED_EVENT: {
          const issueId = payloadEntityId(payload, envelope.eventName, 'issueId');
          if (!issueId.ok) return issueId;
          const record = issuesOf(projectId).get(issueId.value);
          if (record === undefined) {
            return fail(
              invariantViolation(
                {
                  name: 'read-model-resolves-issue',
                  statement: `issue ${issueId.value} reopened before it was raised (events must be applied in ledger order)`,
                },
              ),
            );
          }
          record.open = true;
          return ok(true);
        }
        case INSPECTION_SCHEDULED_EVENT: {
          const inspectionId = payloadEntityId(payload, envelope.eventName, 'inspectionId');
          if (!inspectionId.ok) return inspectionId;
          const title = payloadString(payload, envelope.eventName, 'title');
          if (!title.ok) return title;
          inspectionsOf(projectId).set(inspectionId.value, {
            title: title.value,
            outcome: null,
            findings: [],
          });
          return ok(true);
        }
        case INSPECTION_OUTCOMED_EVENT: {
          const inspectionId = payloadEntityId(payload, envelope.eventName, 'inspectionId');
          if (!inspectionId.ok) return inspectionId;
          const outcome = requireFieldWith(payload, 'status', '', parseOutcome);
          if (!outcome.ok) return fail(unreadablePayload(envelope.eventName, 'status'));
          const record = inspectionsOf(projectId).get(inspectionId.value);
          if (record === undefined) {
            return fail(
              invariantViolation(
                {
                  name: 'read-model-resolves-inspection',
                  statement: `inspection ${inspectionId.value} outcomed before it was scheduled (events must be applied in ledger order)`,
                },
              ),
            );
          }
          const findingsRaw = payload['findings'];
          const findings: EntityId[] = [];
          if (Array.isArray(findingsRaw)) {
            for (const element of findingsRaw) {
              if (!isPlainObject(element)) {
                return fail(unreadablePayload(envelope.eventName, 'findings'));
              }
              const issueId = payloadEntityId(element, envelope.eventName, 'issueId');
              if (!issueId.ok) return issueId;
              findings.push(issueId.value);
            }
          }
          record.outcome = outcome.value;
          record.findings = findings;
          return ok(true);
        }
        case FIELD_EVENT_EVIDENCE_ATTACHED_EVENT:
        case DAILY_LOG_ENTRY_APPENDED_EVENT:
        case DAILY_LOG_DAY_CLOSED_EVENT:
        case ISSUE_COMMENTED_EVENT:
        case INSPECTION_CONDUCTED_EVENT:
          // Events the three read queries do not derive state from (they are
          // still validated as vocabulary members above).
          return ok(true);
        default:
          // Unreachable after the vocabulary check above; kept fail-closed.
          return fail(unknownEventName(envelope.eventName));
      }
    },

    recentFieldEvents: (projectId, limit) => {
      const captures = fieldEventsByProject.get(projectId) ?? [];
      const bounded = Math.max(0, Math.floor(limit));
      return [...captures]
        .slice(-bounded)
        .reverse()
        .map((capture) => ({ ...capture }));
    },

    openIssues: (projectId) =>
      [...(issuesByProject.get(projectId)?.values() ?? [])]
        .filter((record) => record.open)
        .map((record) => ({
          issueId: record.issueId,
          title: record.title,
          category: record.category,
          severity: record.severity,
          assignee: record.assignee,
        })),

    inspectionOutcomes: (projectId) =>
      [...(inspectionsByProject.get(projectId)?.entries() ?? [])]
        .filter(([, record]) => record.outcome !== null)
        .map(([inspectionId, record]) => ({
          inspectionId,
          title: record.title,
          outcome: record.outcome as InspectionOutcome,
          findings: record.findings,
        })),
  };
}
