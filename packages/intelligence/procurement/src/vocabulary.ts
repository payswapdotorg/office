// Office intelligence — the procurement optimization engine's vocabulary
// (OFF-034).
//
// The typed vocabulary of the procurement engine: the emitted
// procurement-recommendation-proposed event name, the closed RECOMMENDATION
// KIND vocabulary (the optimization conditions the engine detects — nothing
// else can be a recommendation), the closed VENDOR PERFORMANCE scale (the
// typed rating levels, deterministically derived from referenced outcome
// records — never a float, never a manual score), the generic vendor-key
// grammar ('vendor-01'-style tokens — no real vendor names, no provider
// vocabulary), the caller-supplied scan/alternative/recommendation identity
// grammars, and the area read capabilities a procurement scan or read must
// hold. Every literal mirrors the landed intelligence peers' conventions
// (the margin engine's 'intelligence.marginAssessed', the memory engine's
// 'intelligence.outcomeRecorded', the exception engine's
// 'intelligence.exceptionDetected', the revenue engine's
// 'intelligence.recoveryCandidateDetected' — the intelligence package
// family's event grammar '<area>.<camelCaseFact>').
import { parseEventName, parseFail, parseOk } from '@office/contracts';
import type { EventName, ParseResult } from '@office/contracts';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';
import { parseOutcomeId } from '@office/intelligence-memory';
import type { OutcomeId } from '@office/intelligence-memory';

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
// The emitted procurement event (A3/A4): every detected recommendation emits
// exactly one DomainEventEnvelope through the ProcurementEventSink port
// (mirroring the landed peers' EventSink shape), so the procurement engine's
// feed behaves like any other derived stream. Downstream consumers (OFF-037
// integration, OFF-040 analytics) consume procurement-recommendation events
// like any other domain event. The fact name states the discipline: the
// engine only ever PROPOSES.
// ---------------------------------------------------------------------------

/** Event name of the procurement-recommendation-proposed event. */
export const PROCUREMENT_RECOMMENDATION_PROPOSED_EVENT: EventName = eventNameLiteral(
  'intelligence.procurementProposed',
);

// ---------------------------------------------------------------------------
// The recommendation kind vocabulary — the closed set of procurement
// optimization conditions the engine detects. The detection rules are PURE
// typed computation over the cost domain's derived read surface + the
// intelligence peers' outputs: no AI, no heuristics, no floats, no manual
// scores.
// ---------------------------------------------------------------------------

/** Every recommendation kind, in canonical order. */
export const PROCUREMENT_KINDS = [
  'vendor-switch',
  'order-splitting',
  'timing-shift',
] as const;

/** One recommendation kind (the closed procurement-optimization vocabulary). */
export type ProcurementKind = (typeof PROCUREMENT_KINDS)[number];

/** Grammar description used in parse failures. */
export const PROCUREMENT_KIND_GRAMMAR =
  "procurement kind: one of 'vendor-switch', 'order-splitting', 'timing-shift'";

/** Parse an untrusted value as a ProcurementKind (total, fail-closed). */
export function parseProcurementKind(raw: unknown): ParseResult<ProcurementKind> {
  if (
    typeof raw === 'string' &&
    (PROCUREMENT_KINDS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as ProcurementKind);
  }
  return parseFail('invalid-value', '', PROCUREMENT_KIND_GRAMMAR, describeToken(raw));
}

/** Type guard for canonical ProcurementKind values. */
export function isProcurementKind(raw: unknown): raw is ProcurementKind {
  return parseProcurementKind(raw).ok;
}

// ---------------------------------------------------------------------------
// The vendor performance scale — a typed four-level scale derived ONLY from
// referenced memory outcome records (the vendor's completed-project
// history): the on-time share of the referenced outcomes. Never a float,
// never a manual score, never invented history.
// ---------------------------------------------------------------------------

/** Every vendor performance level, in canonical ascending order. */
export const VENDOR_PERFORMANCE_LEVELS = [
  'unrated',
  'underperforming',
  'acceptable',
  'strong',
] as const;

/** One vendor performance level of the typed scale. */
export type VendorPerformanceLevel = (typeof VENDOR_PERFORMANCE_LEVELS)[number];

/** Grammar description used in parse failures. */
export const VENDOR_PERFORMANCE_GRAMMAR =
  "vendor performance level: one of 'unrated', 'underperforming', 'acceptable', 'strong'";

/** Parse an untrusted value as a VendorPerformanceLevel (total, fail-closed). */
export function parseVendorPerformanceLevel(
  raw: unknown,
): ParseResult<VendorPerformanceLevel> {
  if (
    typeof raw === 'string' &&
    (VENDOR_PERFORMANCE_LEVELS as readonly string[]).includes(raw)
  ) {
    return parseOk(raw as VendorPerformanceLevel);
  }
  return parseFail('invalid-value', '', VENDOR_PERFORMANCE_GRAMMAR, describeToken(raw));
}

/** Type guard for canonical VendorPerformanceLevel values. */
export function isVendorPerformanceLevel(raw: unknown): raw is VendorPerformanceLevel {
  return parseVendorPerformanceLevel(raw).ok;
}

// ---------------------------------------------------------------------------
// The generic vendor-key grammar — 'vendor-01'-style tokens only. The
// engine's vocabulary is generic fixture vocabulary: no real vendor names,
// no provider vocabulary (the commercial contract is Office-canonical and
// provider-independent, freeze A5).
// ---------------------------------------------------------------------------

/** Grammar description of the generic vendor key. */
export const VENDOR_KEY_GRAMMAR =
  "generic vendor key: 'vendor-' followed by 2..8 digits (e.g. 'vendor-01') — no real vendor names";

const VENDOR_KEY_PATTERN = /^vendor-[0-9]{2,8}$/;

declare const vendorKeyBrand: unique symbol;

/** The generic identity of one fulfillment vendor (a closed fixture token). */
export type VendorKey = string & {
  readonly [vendorKeyBrand]: 'VendorKey';
};

/** Parse an untrusted value as a VendorKey (total, fail-closed). */
export function parseVendorKey(raw: unknown): ParseResult<VendorKey> {
  if (typeof raw !== 'string' || !VENDOR_KEY_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', VENDOR_KEY_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as VendorKey);
}

/** Type guard for canonical VendorKey values. */
export function isVendorKey(raw: unknown): raw is VendorKey {
  return parseVendorKey(raw).ok;
}

// ---------------------------------------------------------------------------
// The scan/alternative/recommendation/comparison identity grammars (the
// injected deterministic tokens — no clock, no randomness: the caller
// supplies the scan identity and the engine derives every recommendation
// and comparison id from it).
// ---------------------------------------------------------------------------

/** Grammar description used in parse failures (opaque tokens). */
export const ID_TOKEN_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

/** Grammar description of the scan identity (the injected id supplier). */
export const PROCUREMENT_SCAN_ID_GRAMMAR = ID_TOKEN_GRAMMAR;

/** Grammar description of one quoted alternative's identity. */
export const ALTERNATIVE_ID_GRAMMAR = ID_TOKEN_GRAMMAR;

/** Grammar description of one recommendation's identity. */
export const RECOMMENDATION_ID_GRAMMAR = ID_TOKEN_GRAMMAR;

/** Grammar description of one vendor comparison's identity. */
export const COMPARISON_ID_GRAMMAR = ID_TOKEN_GRAMMAR;

const ID_TOKEN_PATTERN = /^[\x21-\x7e]{8,128}$/;

declare const procurementScanIdBrand: unique symbol;

/** Caller-supplied identity of one procurement scan (deterministic token). */
export type ProcurementScanId = string & {
  readonly [procurementScanIdBrand]: 'ProcurementScanId';
};

/** Parse an untrusted value as a ProcurementScanId (total, fail-closed). */
export function parseProcurementScanId(raw: unknown): ParseResult<ProcurementScanId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', PROCUREMENT_SCAN_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as ProcurementScanId);
}

/** Type guard for canonical ProcurementScanId values. */
export function isProcurementScanId(raw: unknown): raw is ProcurementScanId {
  return parseProcurementScanId(raw).ok;
}

declare const alternativeIdBrand: unique symbol;

/** Caller-supplied identity of one quoted fulfillment alternative. */
export type AlternativeId = string & {
  readonly [alternativeIdBrand]: 'AlternativeId';
};

/** Parse an untrusted value as an AlternativeId (total, fail-closed). */
export function parseAlternativeId(raw: unknown): ParseResult<AlternativeId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', ALTERNATIVE_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as AlternativeId);
}

/** Type guard for canonical AlternativeId values. */
export function isAlternativeId(raw: unknown): raw is AlternativeId {
  return parseAlternativeId(raw).ok;
}

declare const recommendationIdBrand: unique symbol;

/** Identity of one detected procurement recommendation (derived per scan). */
export type RecommendationId = string & {
  readonly [recommendationIdBrand]: 'RecommendationId';
};

/** Parse an untrusted value as a RecommendationId (total, fail-closed). */
export function parseRecommendationId(raw: unknown): ParseResult<RecommendationId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', RECOMMENDATION_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as RecommendationId);
}

/** Type guard for canonical RecommendationId values. */
export function isRecommendationId(raw: unknown): raw is RecommendationId {
  return parseRecommendationId(raw).ok;
}

declare const comparisonIdBrand: unique symbol;

/** Identity of one vendor comparison (derived per scan). */
export type ComparisonId = string & {
  readonly [comparisonIdBrand]: 'ComparisonId';
};

/** Parse an untrusted value as a ComparisonId (total, fail-closed). */
export function parseComparisonId(raw: unknown): ParseResult<ComparisonId> {
  if (typeof raw !== 'string' || !ID_TOKEN_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', COMPARISON_ID_GRAMMAR, describeToken(raw));
  }
  return parseOk(raw as ComparisonId);
}

/** Type guard for canonical ComparisonId values. */
export function isComparisonId(raw: unknown): raw is ComparisonId {
  return parseComparisonId(raw).ok;
}

// ---------------------------------------------------------------------------
// Procurement scan/read access capabilities. A procurement comparison spans
// the same three bounded contexts the assessments it consumes span (the
// contract/commercial position, the cost position, the schedule position —
// the memory facts it calibrates against are read under the same three), so
// the deny-by-default access check requires all three area read capabilities
// BEFORE any input is read or any recommendation served — mirroring the
// landed intelligence peers' capability gates exactly.
// ---------------------------------------------------------------------------

/** The area read capabilities every procurement scan/read must hold. */
export const PROCUREMENT_REQUIRED_CAPABILITIES: readonly Capability[] = [
  capability('contracts.read'),
  capability('cost.read'),
  capability('schedule.read'),
];

/** The area read capability names, in canonical order (error messages). */
export const PROCUREMENT_REQUIRED_CAPABILITY_NAMES: readonly string[] = [
  'contracts.read',
  'cost.read',
  'schedule.read',
];

// ---------------------------------------------------------------------------
// The alternative input's outcome references — the vendor's completed-
// project history, referenced through the memory engine's own typed
// identity (fail-closed: an unknown outcome id is a typed rejection at scan
// time, never a silently-dropped rating input).
// ---------------------------------------------------------------------------

/** Parse one outcome reference of an alternative (total, fail-closed). */
export function parseAlternativeOutcomeIds(
  raw: readonly unknown[],
): ParseResult<readonly OutcomeId[]> {
  const outcomeIds: OutcomeId[] = [];
  for (const [index, element] of raw.entries()) {
    const parsed = parseOutcomeId(element);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        `outcomeIds[${String(index)}]`,
        'outcome id of the vendor\u2019s referenced completed-project history',
        describeToken(element),
      );
    }
    outcomeIds.push(parsed.value);
  }
  return parseOk(outcomeIds);
}
