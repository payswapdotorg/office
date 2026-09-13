// Office intelligence — the margin engine's commercial vocabulary (OFF-014).
//
// The typed vocabulary of the impact engine: the ledger event names whose
// payloads carry COMMERCIAL FACTS (the money/duration/link fields the impact
// calculations consume), the change-event names an assessment may take as
// its subject, the emitted assessment event name, and the area read
// capabilities an assessment request must hold. Every literal mirrors the
// landed domain packages' own declared vocabularies (packages/domain/*/
// src/events.ts) — the engine invents no names; it consumes the recorded
// event SHAPES through the @office/contracts envelope only (the domain
// packages are never imported — the dependency rule).
import { parseEventName, parseFail, parseOk } from '@office/contracts';
import type { EventName, ParseResult } from '@office/contracts';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';

const eventNameLiteral = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid event name literal: ${name}`);
  }
  return parsed.value;
};

// ---------------------------------------------------------------------------
// The ledger event names whose payloads the commercial fold consumes. The
// fold recognizes exactly these names; unknown event names are SKIPPED
// deterministically (fail-open for future packages, tallied in the
// derivation metadata — never a crash, never a silent data invention), and
// a recognized name with a malformed payload fails closed instead.
// ---------------------------------------------------------------------------

/** The assessment subject: a raised contracts change event. */
export const CHANGE_EVENT_RAISED_EVENT: EventName = eventNameLiteral('contracts.changeEventRaised');

/** Every ledger event name the commercial fold recognizes. */
export const RECOGNIZED_COMMERCIAL_EVENT_NAMES: readonly EventName[] = [
  // Contracts & change events (the commercial aggregate).
  eventNameLiteral('contracts.contractCreated'),
  CHANGE_EVENT_RAISED_EVENT,
  eventNameLiteral('contracts.changeOrderSubmitted'),
  eventNameLiteral('contracts.changeOrderApproved'),
  eventNameLiteral('contracts.changeOrderRejected'),
  eventNameLiteral('contracts.changeOrderExecuted'),
  eventNameLiteral('contracts.claimReferenced'),
  // Cost, budget & commitments (the money layers).
  eventNameLiteral('cost.budgetCreated'),
  eventNameLiteral('cost.costItemRecorded'),
  eventNameLiteral('cost.budgetRevised'),
  eventNameLiteral('cost.commitmentCreated'),
  eventNameLiteral('cost.commitmentAmended'),
  // Schedule & program of work (the forecast network).
  eventNameLiteral('schedule.scheduleCreated'),
  eventNameLiteral('schedule.activityAdded'),
  eventNameLiteral('schedule.activityUpdated'),
  eventNameLiteral('schedule.dependencyAdded'),
  eventNameLiteral('schedule.dependencyRemoved'),
  eventNameLiteral('schedule.baselineSet'),
  eventNameLiteral('schedule.progressRecorded'),
];

const recognizedEventNameSet = new Set<string>(RECOGNIZED_COMMERCIAL_EVENT_NAMES);

/** Is this event name one the commercial fold recognizes (vs. skips)? */
export function isRecognizedCommercialEventName(name: EventName): boolean {
  return recognizedEventNameSet.has(name);
}

// ---------------------------------------------------------------------------
// The emitted assessment event (A3/A4): every assessment emits exactly one
// DomainEventEnvelope downstream consumers (OFF-015 memory, OFF-018
// recommendations) consume like any other domain event. The name declares
// its owning area ('intelligence') — the bounded context 14 surface.
// ---------------------------------------------------------------------------

/** Event name of the assessment-emitted audit event. */
export const MARGIN_ASSESSED_EVENT: EventName = eventNameLiteral('intelligence.marginAssessed');

/** Grammar description used in parse failures. */
export const ASSESSMENT_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

declare const assessmentIdBrand: unique symbol;

/** Caller-supplied identity of one assessment run (deterministic token). */
export type AssessmentId = string & {
  readonly [assessmentIdBrand]: 'AssessmentId';
};

/** Parse an untrusted value as an AssessmentId (total, fail-closed). */
export function parseAssessmentId(raw: unknown): ParseResult<AssessmentId> {
  if (typeof raw !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(raw)) {
    return parseFail('invalid-value', '', ASSESSMENT_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as AssessmentId);
}

/** Type guard for canonical AssessmentId values. */
export function isAssessmentId(raw: unknown): raw is AssessmentId {
  return parseAssessmentId(raw).ok;
}

const describeToken = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  return typeof raw;
};

// ---------------------------------------------------------------------------
// Assessment access capabilities. An impact assessment spans three bounded
// contexts at once (the contract/commercial position, the cost position,
// the schedule position), so the deny-by-default access check requires all
// three area read capabilities BEFORE any calculation runs — a request that
// cannot read one of the three areas never computes a single number.
// ---------------------------------------------------------------------------

/** The area read capabilities every assessment request must hold. */
export const ASSESSMENT_REQUIRED_CAPABILITIES: readonly Capability[] = [
  capability('contracts.read'),
  capability('cost.read'),
  capability('schedule.read'),
];

/** The area read capability names, in canonical order (error messages). */
export const ASSESSMENT_REQUIRED_CAPABILITY_NAMES: readonly string[] = [
  'contracts.read',
  'cost.read',
  'schedule.read',
];
