// Office intelligence — the stack analysis engine's vocabulary (OFF-035).
//
// The typed vocabulary of the software-stack replacement analysis engine:
// the emitted replacement-assessed event name, the closed ASSESSMENT KIND
// vocabulary (the two measurement directions — by external system and by
// installed app), the closed SUGGESTION KIND vocabulary (the typed
// suggestion records the engine exits with — suggestion-only, never a
// command), the caller-supplied scan/assessment identity grammar, the
// authorization resource kinds of the measured subjects, and the area read
// capabilities a stack scan or read must hold. Every literal mirrors the
// landed intelligence peers' conventions (the memory engine's
// 'intelligence.outcomeRecorded', the exception engine's
// 'intelligence.exceptionDetected', the revenue engine's
// 'intelligence.recoveryCandidateDetected' — the intelligence package
// family's event grammar '<area>.<camelCaseFact>').
import { parseEntityKind, parseEventName, parseFail, parseOk } from '@office/contracts';
import type { EntityKind, EventName, ParseResult } from '@office/contracts';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';

const eventNameLiteral = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid event name literal: ${name}`);
  }
  return parsed.value;
};

const entityKindLiteral = (kind: string): EntityKind => {
  const parsed = parseEntityKind(kind);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind literal: ${kind}`);
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
// The emitted stack analysis event (A3/A4): every assessed subject (each
// observed external system, each installed app) emits exactly one
// DomainEventEnvelope through the StackEventSink port (mirroring the landed
// peers' EventSink shape), so the stack analysis feed behaves like any
// other derived stream. Downstream consumers (OFF-038 release gates,
// OFF-040 analytics) consume replacement-assessed events like any other
// domain event.
// ---------------------------------------------------------------------------

/** Event name of the replacement-assessed stack analysis event. */
export const STACK_ASSESSED_EVENT: EventName = eventNameLiteral(
  'intelligence.replacementAssessed',
);

// ---------------------------------------------------------------------------
// The assessment kind vocabulary — the closed set of measurement
// directions. 'external-system' measures an observed external system's
// replacement potential (the fraction of its observed capability surface
// already covered by the tenant's installed apps); 'installed-app' measures
// an installed app's overlap with the external-system portfolio (the
// fraction of its declared capability surface the external systems also
// provide). Nothing else can be assessed.
// ---------------------------------------------------------------------------

/** Every assessment kind, in canonical order. */
export const ASSESSMENT_KINDS = ['external-system', 'installed-app'] as const;

/** One assessment kind (the closed measurement-direction vocabulary). */
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];

/** Grammar description used in parse failures. */
export const ASSESSMENT_KIND_GRAMMAR =
  "assessment kind: one of 'external-system', 'installed-app'";

/** Parse an untrusted value as an AssessmentKind (total, fail-closed). */
export function parseAssessmentKind(raw: unknown): ParseResult<AssessmentKind> {
  if (
    typeof raw === 'string' &&
    (ASSESSMENT_KINDS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as AssessmentKind);
  }
  return parseFail('invalid-value', '', ASSESSMENT_KIND_GRAMMAR, describeToken(raw));
}

/** Type guard for canonical AssessmentKind values. */
export function isAssessmentKind(raw: unknown): raw is AssessmentKind {
  return parseAssessmentKind(raw).ok;
}

// ---------------------------------------------------------------------------
// The suggestion kind vocabulary — the closed set of typed suggestion
// records an assessment can exit with. Suggestions are DATA ONLY (no
// command references, no command construction, no state mutation): they
// name the deterministic posture derived from the assessment's own score
// composition. 'consolidate' — the overlap is complete; 'extend-coverage'
// — the overlap is partial (close the typed gaps first); 'maintain' —
// there is no overlap (no replacement basis).
// ---------------------------------------------------------------------------

/** Every suggestion kind, in canonical order. */
export const SUGGESTION_KINDS = [
  'consolidate',
  'extend-coverage',
  'maintain',
] as const;

/** One suggestion kind (the closed suggestion-posture vocabulary). */
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

/** Grammar description used in parse failures. */
export const SUGGESTION_KIND_GRAMMAR =
  "suggestion kind: one of 'consolidate', 'extend-coverage', 'maintain'";

/** Parse an untrusted value as a SuggestionKind (total, fail-closed). */
export function parseSuggestionKind(raw: unknown): ParseResult<SuggestionKind> {
  if (
    typeof raw === 'string' &&
    (SUGGESTION_KINDS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as SuggestionKind);
  }
  return parseFail('invalid-value', '', SUGGESTION_KIND_GRAMMAR, describeToken(raw));
}

/** Type guard for canonical SuggestionKind values. */
export function isSuggestionKind(raw: unknown): raw is SuggestionKind {
  return parseSuggestionKind(raw).ok;
}

// ---------------------------------------------------------------------------
// The scan/assessment identity grammar (the injected deterministic tokens —
// no clock, no randomness: the caller supplies the scan identity and the
// engine derives every assessment id from it, `<scanId>#<ordinal>` in the
// canonical emission order).
// ---------------------------------------------------------------------------

/** Grammar description used in parse failures. */
export const ASSESSMENT_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

/** Grammar description of the scan identity (the injected id supplier). */
export const STACK_SCAN_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

const ID_TOKEN_PATTERN = /^[\x21-\x7e]{8,128}$/;

declare const assessmentIdBrand: unique symbol;

/** Identity of one replacement assessment (deterministically derived per scan). */
export type AssessmentId = string & {
  readonly [assessmentIdBrand]: 'AssessmentId';
};

/** Parse an untrusted value as an AssessmentId (total, fail-closed). */
export function parseAssessmentId(raw: unknown): ParseResult<AssessmentId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', ASSESSMENT_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as AssessmentId);
}

/** Type guard for canonical AssessmentId values. */
export function isAssessmentId(raw: unknown): raw is AssessmentId {
  return parseAssessmentId(raw).ok;
}

declare const stackScanIdBrand: unique symbol;

/** Caller-supplied identity of one stack analysis scan (deterministic token). */
export type StackScanId = string & {
  readonly [stackScanIdBrand]: 'StackScanId';
};

/**
 * The separator between the scan identity and the derived ordinal in every
 * assessment id (`<scanId>#<ordinal>`).
 */
export const ASSESSMENT_ID_SEPARATOR = '#';

/** The zero-padded width of the derived ordinal suffix of an assessment id. */
export const ASSESSMENT_ORDINAL_WIDTH = 4;

/** Parse an untrusted value as a StackScanId (total, fail-closed). */
export function parseStackScanId(raw: unknown): ParseResult<StackScanId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', STACK_SCAN_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as StackScanId);
}

/** Type guard for canonical StackScanId values. */
export function isStackScanId(raw: unknown): raw is StackScanId {
  return parseStackScanId(raw).ok;
}

// ---------------------------------------------------------------------------
// The authorization resource kinds of the measured subjects. EntityKind is
// the contracts' OPEN kebab-case grammar (unlike the CLOSED capability
// vocabulary); these constants pin the kinds the stack analysis addresses
// resources by, mirroring the landed surfaces they name: 'app-installation'
// is the app-runtime AppInstallation record kind (the marketplace
// installation links reference exactly those identities), and
// 'external-system' / 'app-entitlement' / 'benchmark' name the remaining
// measured/referenced records. No provider vocabulary anywhere.
// ---------------------------------------------------------------------------

/** The authorization resource kind of one observed external system. */
export const EXTERNAL_SYSTEM_KIND: EntityKind = entityKindLiteral('external-system');

/** The authorization resource kind of one installed app installation. */
export const APP_INSTALLATION_KIND: EntityKind = entityKindLiteral('app-installation');

/** The authorization resource kind of one tenant app entitlement. */
export const APP_ENTITLEMENT_KIND: EntityKind = entityKindLiteral('app-entitlement');

/** The authorization resource kind of one computed memory benchmark. */
export const BENCHMARK_KIND: EntityKind = entityKindLiteral('benchmark');

/** The authorization resource kind of one completed project (outcomes). */
export const PROJECT_KIND: EntityKind = entityKindLiteral('project');

// ---------------------------------------------------------------------------
// Stack scan/read access capabilities. A stack analysis scan reads the
// marketplace/app surface of the scanned tenant (the releases, entitlements,
// and installation links — the apps.read area) AND the intelligence memory
// facts that form the observed-performance basis (the memory engine's own
// read gate spans contracts.read + cost.read + schedule.read — the three
// bounded contexts an outcome record spans), so the deny-by-default access
// check requires all four area read capabilities BEFORE any input is read
// or any assessment served.
// ---------------------------------------------------------------------------

/** The area read capabilities every stack scan/read must hold. */
export const STACK_REQUIRED_CAPABILITIES: readonly Capability[] = [
  capability('apps.read'),
  capability('contracts.read'),
  capability('cost.read'),
  capability('schedule.read'),
];

/** The area read capability names, in canonical order (error messages). */
export const STACK_REQUIRED_CAPABILITY_NAMES: readonly string[] = [
  'apps.read',
  'contracts.read',
  'cost.read',
  'schedule.read',
];
