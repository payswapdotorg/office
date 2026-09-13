// Office intelligence — the revenue recovery engine's vocabulary (OFF-033).
//
// The typed vocabulary of the recovery engine: the emitted
// recovery-candidate-detected event name, the closed RECOVERY KIND
// vocabulary (the candidate change/claim conditions the engine detects —
// nothing else can be a candidate), the closed SEVERITY scale (the typed
// severity levels, deterministically computed — never a float, never a
// guess), the caller-supplied scan/candidate identity grammar, and the area
// read capabilities a recovery scan or read must hold. Every literal
// mirrors the landed intelligence peers' conventions (the margin engine's
// 'intelligence.marginAssessed', the memory engine's
// 'intelligence.outcomeRecorded', the exception engine's
// 'intelligence.exceptionDetected' — the intelligence package family's
// event grammar '<area>.<camelCaseFact>').
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

const describeToken = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  return typeof raw;
};

// ---------------------------------------------------------------------------
// The emitted recovery event (A3/A4): every detected candidate emits
// exactly one DomainEventEnvelope through the RecoveryEventSink port
// (mirroring the landed peers' EventSink shape), so the recovery engine's
// feed behaves like any other derived stream. Downstream consumers
// (OFF-037 integration, OFF-040 analytics) consume recovery-candidate
// events like any other domain event.
// ---------------------------------------------------------------------------

/** Event name of the recovery-candidate-detected event. */
export const RECOVERY_DETECTED_EVENT: EventName = eventNameLiteral(
  'intelligence.recoveryCandidateDetected',
);

// ---------------------------------------------------------------------------
// The recovery kind vocabulary — the closed set of candidate change/claim
// conditions the revenue recovery engine detects. The detection rules are
// PURE typed computation over the contracts model + the intelligence
// peers' outputs: no AI, no heuristics, no floats.
// ---------------------------------------------------------------------------

/** Every recovery kind, in canonical order. */
export const RECOVERY_KINDS = [
  'constructive-change',
  'entitlement-rebalance',
  'delay-impact',
] as const;

/** One recovery kind (the closed candidate-detection vocabulary). */
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

/** Grammar description used in parse failures. */
export const RECOVERY_KIND_GRAMMAR =
  "recovery kind: one of 'constructive-change', 'entitlement-rebalance', 'delay-impact'";

/** Parse an untrusted value as a RecoveryKind (total, fail-closed). */
export function parseRecoveryKind(raw: unknown): ParseResult<RecoveryKind> {
  if (
    typeof raw === 'string' &&
    (RECOVERY_KINDS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as RecoveryKind);
  }
  return parseFail('invalid-value', '', RECOVERY_KIND_GRAMMAR, describeToken(raw));
}

/** Type guard for canonical RecoveryKind values. */
export function isRecoveryKind(raw: unknown): raw is RecoveryKind {
  return parseRecoveryKind(raw).ok;
}

// ---------------------------------------------------------------------------
// The severity scale — a typed four-level scale, deterministically computed
// from the typed thresholds of the detection rules and calibrated by the
// memory engine's benchmark facts (never a float, never a black box).
// Mirrors the exception engine's typed scale exactly.
// ---------------------------------------------------------------------------

/** Every severity level, in canonical ascending order. */
export const SEVERITY_LEVELS = [
  'minor',
  'moderate',
  'major',
  'critical',
] as const;

/** One severity level of the typed scale (deterministically computed). */
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/** Grammar description used in parse failures. */
export const SEVERITY_LEVEL_GRAMMAR =
  "severity level: one of 'minor', 'moderate', 'major', 'critical'";

/** Parse an untrusted value as a SeverityLevel (total, fail-closed). */
export function parseSeverityLevel(raw: unknown): ParseResult<SeverityLevel> {
  if (
    typeof raw === 'string' &&
    (SEVERITY_LEVELS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as SeverityLevel);
  }
  return parseFail('invalid-value', '', SEVERITY_LEVEL_GRAMMAR, describeToken(raw));
}

/** Type guard for canonical SeverityLevel values. */
export function isSeverityLevel(raw: unknown): raw is SeverityLevel {
  return parseSeverityLevel(raw).ok;
}

// ---------------------------------------------------------------------------
// The scan/candidate identity grammar (the injected deterministic tokens —
// no clock, no randomness: the caller supplies the scan identity and the
// engine derives every candidate id from it).
// ---------------------------------------------------------------------------

/** Grammar description used in parse failures. */
export const CANDIDATE_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

/** Grammar description of the scan identity (the injected id supplier). */
export const RECOVERY_SCAN_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

const ID_TOKEN_PATTERN = /^[\x21-\x7e]{8,128}$/;

declare const candidateIdBrand: unique symbol;

/** Identity of one detected recovery candidate (deterministically derived per scan). */
export type CandidateId = string & {
  readonly [candidateIdBrand]: 'CandidateId';
};

/** Parse an untrusted value as a CandidateId (total, fail-closed). */
export function parseCandidateId(raw: unknown): ParseResult<CandidateId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', CANDIDATE_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as CandidateId);
}

/** Type guard for canonical CandidateId values. */
export function isCandidateId(raw: unknown): raw is CandidateId {
  return parseCandidateId(raw).ok;
}

declare const recoveryScanIdBrand: unique symbol;

/** Caller-supplied identity of one detection scan (deterministic token). */
export type RecoveryScanId = string & {
  readonly [recoveryScanIdBrand]: 'RecoveryScanId';
};

/** Parse an untrusted value as a RecoveryScanId (total, fail-closed). */
export function parseRecoveryScanId(raw: unknown): ParseResult<RecoveryScanId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', RECOVERY_SCAN_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as RecoveryScanId);
}

/** Type guard for canonical RecoveryScanId values. */
export function isRecoveryScanId(raw: unknown): raw is RecoveryScanId {
  return parseRecoveryScanId(raw).ok;
}

// ---------------------------------------------------------------------------
// Recovery scan/read access capabilities. A recovery candidate spans the
// same three bounded contexts the assessments it consumes span (the
// contract/commercial position, the cost position, the schedule position —
// the memory facts it calibrates against are read under the same three),
// so the deny-by-default access check requires all three area read
// capabilities BEFORE any input is read or any candidate served — mirroring
// the exception engine's capability gate exactly.
// ---------------------------------------------------------------------------

/** The area read capabilities every recovery scan/read must hold. */
export const RECOVERY_REQUIRED_CAPABILITIES: readonly Capability[] = [
  capability('contracts.read'),
  capability('cost.read'),
  capability('schedule.read'),
];

/** The area read capability names, in canonical order (error messages). */
export const RECOVERY_REQUIRED_CAPABILITY_NAMES: readonly string[] = [
  'contracts.read',
  'cost.read',
  'schedule.read',
];
