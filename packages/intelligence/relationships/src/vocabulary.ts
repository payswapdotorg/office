// Office intelligence — cross-domain relationship vocabulary (OFF-013).
//
// The typed vocabulary of the relationship engine: the five canonical
// relationship kinds (freeze A7 — the derived relationship graph is a
// PROJECTION, never canonical truth) and the entity kinds the projection
// encounters in the landed domain packages' event envelopes. Both are LOCAL
// typed vocabularies, mirroring how each domain package declares its own —
// the engine DERIVES entity instances from event payloads, never hardcodes
// them.
//
// Relationship kind semantics (the derivation grammar of the index):
// - affects:      the subject materially influences the object's state
//                 (a commitment affects its budget; an invoice affects its
//                 commitment; a progress update affects its activity).
// - depends-on:   the subject cannot start or complete without the object
//                 (a successor activity depends on its predecessor; a
//                 milestone depends on its bound activity).
// - evidenced-by: the subject's status or claims are supported by the
//                 object, an evidence document revision (a change event
//                 evidenced by a revision; a field event evidenced by a
//                 linked entity; a claim evidenced by a revision).
// - impacts:      the subject is a CHANGE whose consequence lands on the
//                 object (a change event impacting a budget, cost item, or
//                 activity).
// - derives-from: the subject was produced or derived from the object
//                 (a revision derives from its document or prior revision;
//                 a baseline from the schedule or the baseline it supersedes;
//                 a change order from its change event; a claim from the
//                 change order it is referenced against).
import { parseEntityKind, parseEventName, parseFail, parseOk } from '@office/contracts';
import type { EntityKind, EventName, ParseResult } from '@office/contracts';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';

declare const relationshipKindBrand: unique symbol;

/** The five canonical relationship kinds of the relationship index. */
export type RelationshipKind =
  | 'affects'
  | 'depends-on'
  | 'evidenced-by'
  | 'impacts'
  | 'derives-from'
  | (string & { readonly [relationshipKindBrand]: 'RelationshipKind' });

/** All relationship kinds, in canonical order. */
export const RELATIONSHIP_KINDS = [
  'affects',
  'depends-on',
  'evidenced-by',
  'impacts',
  'derives-from',
] as const;

/** Grammar description used in parse failures. */
export const RELATIONSHIP_KIND_GRAMMAR =
  "'affects' | 'depends-on' | 'evidenced-by' | 'impacts' | 'derives-from'";

/** Parse an untrusted value as a RelationshipKind (total, fail-closed). */
export function parseRelationshipKind(raw: unknown): ParseResult<RelationshipKind> {
  if (
    typeof raw !== 'string' ||
    !(RELATIONSHIP_KINDS as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', RELATIONSHIP_KIND_GRAMMAR, describeKind(raw));
  }
  return parseOk(raw as RelationshipKind);
}

/** Type guard for canonical RelationshipKind values. */
export function isRelationshipKind(raw: unknown): raw is RelationshipKind {
  return parseRelationshipKind(raw).ok;
}

const describeKind = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  return typeof raw;
};

// ---------------------------------------------------------------------------
// Local entity-kind vocabulary — the kinds the landed domain packages
// declare for the entities that appear as relationship endpoints (or as
// aggregates of recognized events). Each literal mirrors the owning domain
// package's own declared kind (packages/domain/*/src/state.ts); the engine
// never invents kinds.
// ---------------------------------------------------------------------------

const kindLiteral = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind literal: ${literal}`);
  }
  return parsed.value;
};

// Organization & people (packages/domain/organization).
export const ORGANIZATION_KIND: EntityKind = kindLiteral('organization');
// Projects (packages/domain/projects).
export const PROJECT_KIND: EntityKind = kindLiteral('project');
// Documents & evidence (packages/domain/documents).
export const DOCUMENT_KIND: EntityKind = kindLiteral('document');
export const REVISION_KIND: EntityKind = kindLiteral('revision');
export const EVIDENCE_REFERENCE_KIND: EntityKind = kindLiteral('evidence-reference');
// Work & field operations (packages/domain/field).
export const FIELD_EVENT_KIND: EntityKind = kindLiteral('field-event');
export const DAILY_LOG_KIND: EntityKind = kindLiteral('daily-log');
export const FIELD_ISSUE_KIND: EntityKind = kindLiteral('field-issue');
export const INSPECTION_KIND: EntityKind = kindLiteral('inspection');
// Schedule & program of work (packages/domain/schedule).
export const SCHEDULE_KIND: EntityKind = kindLiteral('schedule');
export const ACTIVITY_KIND: EntityKind = kindLiteral('activity');
export const DEPENDENCY_KIND: EntityKind = kindLiteral('dependency');
export const MILESTONE_KIND: EntityKind = kindLiteral('milestone');
export const BASELINE_KIND: EntityKind = kindLiteral('baseline');
export const PROGRESS_UPDATE_KIND: EntityKind = kindLiteral('progress-update');
// Cost, budget & commitments (packages/domain/cost).
export const BUDGET_KIND: EntityKind = kindLiteral('budget');
export const COST_ITEM_KIND: EntityKind = kindLiteral('cost-item');
export const BUDGET_REVISION_KIND: EntityKind = kindLiteral('budget-revision');
export const COMMITMENT_KIND: EntityKind = kindLiteral('commitment');
export const COMMITMENT_LINE_KIND: EntityKind = kindLiteral('commitment-line');
export const COMMITMENT_AMENDMENT_KIND: EntityKind = kindLiteral('commitment-amendment');
export const INVOICE_KIND: EntityKind = kindLiteral('invoice');
export const INVOICE_LINE_KIND: EntityKind = kindLiteral('invoice-line');
export const PAYMENT_REFERENCE_KIND: EntityKind = kindLiteral('payment-reference');
// Contracts & change events (packages/domain/contracts).
export const CONTRACT_KIND: EntityKind = kindLiteral('contract');
export const SCOPE_OBLIGATION_KIND: EntityKind = kindLiteral('scope-obligation');
export const CHANGE_EVENT_KIND: EntityKind = kindLiteral('change-event');
export const CHANGE_ORDER_KIND: EntityKind = kindLiteral('change-order');
export const CLAIM_REFERENCE_KIND: EntityKind = kindLiteral('claim-reference');

/** Every entity kind the engine knows, in canonical declaration order. */
export const KNOWN_ENTITY_KINDS: readonly EntityKind[] = [
  ORGANIZATION_KIND,
  PROJECT_KIND,
  DOCUMENT_KIND,
  REVISION_KIND,
  EVIDENCE_REFERENCE_KIND,
  FIELD_EVENT_KIND,
  DAILY_LOG_KIND,
  FIELD_ISSUE_KIND,
  INSPECTION_KIND,
  SCHEDULE_KIND,
  ACTIVITY_KIND,
  DEPENDENCY_KIND,
  MILESTONE_KIND,
  BASELINE_KIND,
  PROGRESS_UPDATE_KIND,
  BUDGET_KIND,
  COST_ITEM_KIND,
  BUDGET_REVISION_KIND,
  COMMITMENT_KIND,
  COMMITMENT_LINE_KIND,
  COMMITMENT_AMENDMENT_KIND,
  INVOICE_KIND,
  INVOICE_LINE_KIND,
  PAYMENT_REFERENCE_KIND,
  CONTRACT_KIND,
  SCOPE_OBLIGATION_KIND,
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CLAIM_REFERENCE_KIND,
];

// ---------------------------------------------------------------------------
// Entity kind -> read capability area. Traversal-time authorization requires
// the caller's context to hold the READ capability of every traversed
// node's area (deny-by-default: a kind outside this vocabulary has NO
// determinable area, so no capability can ever grant it — the node is
// invisible). The area mirrors the capability areas the domain packages'
// commands gate on (organization/projects/documents/work/schedule/cost/
// contracts — the authz declared vocabulary).
// ---------------------------------------------------------------------------

const KIND_READ_CAPABILITIES: Readonly<Record<string, Capability>> = {
  organization: capability('organization.read'),
  project: capability('projects.read'),
  document: capability('documents.read'),
  revision: capability('documents.read'),
  'evidence-reference': capability('documents.read'),
  'field-event': capability('work.read'),
  'daily-log': capability('work.read'),
  'field-issue': capability('work.read'),
  inspection: capability('work.read'),
  schedule: capability('schedule.read'),
  activity: capability('schedule.read'),
  dependency: capability('schedule.read'),
  milestone: capability('schedule.read'),
  baseline: capability('schedule.read'),
  'progress-update': capability('schedule.read'),
  budget: capability('cost.read'),
  'cost-item': capability('cost.read'),
  'budget-revision': capability('cost.read'),
  commitment: capability('cost.read'),
  'commitment-line': capability('cost.read'),
  'commitment-amendment': capability('cost.read'),
  invoice: capability('cost.read'),
  'invoice-line': capability('cost.read'),
  'payment-reference': capability('cost.read'),
  contract: capability('contracts.read'),
  'scope-obligation': capability('contracts.read'),
  'change-event': capability('contracts.read'),
  'change-order': capability('contracts.read'),
  'claim-reference': capability('contracts.read'),
};

/**
 * The declared read capability of the entity kind's bounded-context area, or
 * null when the kind is outside the engine's vocabulary (the caller can
 * never be granted a capability for an unknown area — deny-by-default).
 */
export function readCapabilityOfKind(kind: EntityKind): Capability | null {
  return KIND_READ_CAPABILITIES[kind] ?? null;
}

// ---------------------------------------------------------------------------
// Recognized event names — the landed domain packages' event vocabularies
// (read from packages/domain/*/src/events.ts). The projection recognizes
// exactly these names; unknown event names are SKIPPED deterministically
// (fail-open for future packages, tallied in the derivation metadata —
// never a crash, never a silent data invention).
// ---------------------------------------------------------------------------

const eventNameLiteral = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid event name literal: ${name}`);
  }
  return parsed.value;
};

/** Every landed domain event name the projection recognizes. */
export const RECOGNIZED_EVENT_NAMES: readonly EventName[] = [
  // Organization lifecycle (no relationship edges; aggregate nodes only).
  eventNameLiteral('organization.organizationCreated'),
  eventNameLiteral('organization.organizationUpdated'),
  eventNameLiteral('organization.organizationArchived'),
  // Project lifecycle (no relationship edges; aggregate nodes only).
  eventNameLiteral('projects.projectCreated'),
  eventNameLiteral('projects.projectUpdated'),
  eventNameLiteral('projects.projectArchived'),
  // Documents & evidence.
  eventNameLiteral('documents.documentRegistered'),
  eventNameLiteral('documents.documentArchived'),
  eventNameLiteral('documents.revisionAttached'),
  eventNameLiteral('documents.revisionSuperseded'),
  eventNameLiteral('documents.evidenceReferenced'),
  // Work & field operations.
  eventNameLiteral('field.fieldEventCaptured'),
  eventNameLiteral('field.fieldEventEvidenceAttached'),
  eventNameLiteral('field.fieldEventResolved'),
  eventNameLiteral('field.dailyLogEntryAppended'),
  eventNameLiteral('field.dailyLogDayClosed'),
  eventNameLiteral('field.issueRaised'),
  eventNameLiteral('field.issueAssigned'),
  eventNameLiteral('field.issueCommented'),
  eventNameLiteral('field.issueResolved'),
  eventNameLiteral('field.issueReopened'),
  eventNameLiteral('field.inspectionScheduled'),
  eventNameLiteral('field.inspectionConducted'),
  eventNameLiteral('field.inspectionOutcomed'),
  // Schedule & program of work.
  eventNameLiteral('schedule.scheduleCreated'),
  eventNameLiteral('schedule.activityAdded'),
  eventNameLiteral('schedule.activityUpdated'),
  eventNameLiteral('schedule.dependencyAdded'),
  eventNameLiteral('schedule.dependencyRemoved'),
  eventNameLiteral('schedule.milestoneAdded'),
  eventNameLiteral('schedule.baselineSet'),
  eventNameLiteral('schedule.progressRecorded'),
  // Cost, budget & commitments.
  eventNameLiteral('cost.budgetCreated'),
  eventNameLiteral('cost.costItemRecorded'),
  eventNameLiteral('cost.budgetRevised'),
  eventNameLiteral('cost.commitmentCreated'),
  eventNameLiteral('cost.commitmentAmended'),
  eventNameLiteral('cost.commitmentClosed'),
  eventNameLiteral('cost.invoiceRecorded'),
  eventNameLiteral('cost.paymentReferenced'),
  // Contracts & change events.
  eventNameLiteral('contracts.contractCreated'),
  eventNameLiteral('contracts.contractUpdated'),
  eventNameLiteral('contracts.contractArchived'),
  eventNameLiteral('contracts.obligationRecorded'),
  eventNameLiteral('contracts.changeEventRaised'),
  eventNameLiteral('contracts.changeEventLinked'),
  eventNameLiteral('contracts.changeOrderSubmitted'),
  eventNameLiteral('contracts.changeOrderApproved'),
  eventNameLiteral('contracts.changeOrderRejected'),
  eventNameLiteral('contracts.changeOrderExecuted'),
  eventNameLiteral('contracts.claimReferenced'),
];

const recognizedEventNameSet = new Set<string>(RECOGNIZED_EVENT_NAMES);

/** Is this event name one the projection recognizes (vs. skips)? */
export function isRecognizedEventName(name: EventName): boolean {
  return recognizedEventNameSet.has(name);
}
