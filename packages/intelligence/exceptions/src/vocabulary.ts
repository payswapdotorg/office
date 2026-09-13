// Office intelligence — the control tower's vocabulary (OFF-019).
//
// The typed vocabulary of the exception engine: the closed EXCEPTION KIND
// vocabulary (what the control tower can detect), the closed SEVERITY scale
// (the typed severity levels, deterministically computed — never a float,
// never a guess), the emitted exception event name, the caller-supplied
// scan/exception identity grammar, and the area read capabilities an
// exception scan or read must hold. Every literal mirrors the landed
// intelligence peers' conventions (the margin engine's
// 'intelligence.marginAssessed', the memory engine's
// 'intelligence.outcomeRecorded' — the bounded-context 14/13 surface; the
// control tower carries the same intelligence package family's event
// grammar '<area>.<camelCaseFact>').
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
// The emitted exception event (A3/A4): every detected exception emits
// exactly one DomainEventEnvelope through the ExceptionEventSink port
// (mirroring the landed peers' EventSink shape), so the control tower's
// feed behaves like any other derived stream. Downstream consumers
// (OFF-030 views, OFF-033 agent runtime, OFF-035 chips) consume exception
// events like any other domain event.
// ---------------------------------------------------------------------------

/** Event name of the exception-detected control-tower event. */
export const EXCEPTION_DETECTED_EVENT: EventName = eventNameLiteral(
  'intelligence.exceptionDetected',
);

// ---------------------------------------------------------------------------
// The exception kind vocabulary — the closed set of actionable portfolio
// exceptions the control tower detects. The detection rules are PURE typed
// computation over the peers' outputs (assessments/subgraphs/benchmarks):
// no AI, no heuristics, no floats.
// ---------------------------------------------------------------------------

/** Every exception kind, in canonical order. */
export const EXCEPTION_KINDS = [
  'schedule-slip',
  'cost-overrun',
  'entitlement-exposure',
  'dependency-risk',
  'evidence-gap',
] as const;

/** One exception kind (the closed detection vocabulary). */
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** Grammar description used in parse failures. */
export const EXCEPTION_KIND_GRAMMAR =
  "exception kind: one of 'schedule-slip', 'cost-overrun', 'entitlement-exposure', 'dependency-risk', 'evidence-gap'";

/** Parse an untrusted value as an ExceptionKind (total, fail-closed). */
export function parseExceptionKind(raw: unknown): ParseResult<ExceptionKind> {
  if (
    typeof raw === 'string' &&
    (EXCEPTION_KINDS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as ExceptionKind);
  }
  return parseFail('invalid-value', '', EXCEPTION_KIND_GRAMMAR, describeToken(raw));
}

/** Type guard for canonical ExceptionKind values. */
export function isExceptionKind(raw: unknown): raw is ExceptionKind {
  return parseExceptionKind(raw).ok;
}

// ---------------------------------------------------------------------------
// The severity scale — a typed four-level scale, deterministically computed
// from the typed thresholds of the scan rules and calibrated by the memory
// engine's benchmark facts (never a float, never a black box).
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
// The scan/exception identity grammar (the injected deterministic tokens —
// no clock, no randomness: the caller supplies the scan identity and the
// engine derives every exception id from it).
// ---------------------------------------------------------------------------

/** Grammar description used in parse failures. */
export const EXCEPTION_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

/** Grammar description of the scan identity (the injected id supplier). */
export const SCAN_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

const ID_TOKEN_PATTERN = /^[\x21-\x7e]{8,128}$/;

declare const exceptionIdBrand: unique symbol;

/** Identity of one detected exception (deterministically derived per scan). */
export type ExceptionId = string & {
  readonly [exceptionIdBrand]: 'ExceptionId';
};

/** Parse an untrusted value as an ExceptionId (total, fail-closed). */
export function parseExceptionId(raw: unknown): ParseResult<ExceptionId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', EXCEPTION_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as ExceptionId);
}

/** Type guard for canonical ExceptionId values. */
export function isExceptionId(raw: unknown): raw is ExceptionId {
  return parseExceptionId(raw).ok;
}

declare const scanIdBrand: unique symbol;

/** Caller-supplied identity of one detection scan (deterministic token). */
export type ScanId = string & {
  readonly [scanIdBrand]: 'ScanId';
};

/** Parse an untrusted value as a ScanId (total, fail-closed). */
export function parseScanId(raw: unknown): ParseResult<ScanId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', SCAN_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as ScanId);
}

/** Type guard for canonical ScanId values. */
export function isScanId(raw: unknown): raw is ScanId {
  return parseScanId(raw).ok;
}

// ---------------------------------------------------------------------------
// Exception scan/read access capabilities. An exception spans the same
// three bounded contexts the assessments it consumes span (the
// contract/commercial position, the cost position, the schedule position —
// the memory benchmarks it calibrates against are read under the same
// three), so the deny-by-default access check requires all three area read
// capabilities BEFORE any input is read or any exception served.
// ---------------------------------------------------------------------------

/** The area read capabilities every exception scan/read must hold. */
export const EXCEPTION_REQUIRED_CAPABILITIES: readonly Capability[] = [
  capability('contracts.read'),
  capability('cost.read'),
  capability('schedule.read'),
];

/** The area read capability names, in canonical order (error messages). */
export const EXCEPTION_REQUIRED_CAPABILITY_NAMES: readonly string[] = [
  'contracts.read',
  'cost.read',
  'schedule.read',
];
