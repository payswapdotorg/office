// Office action gateway — A4 evidence & confidence vocabulary (OFF-017).
//
// Freeze A4: every consequential machine-generated claim, recommendation, or
// action proposal must carry EVIDENCE REFERENCES, source identity, timestamps,
// CONFIDENCE, policy context, and execution state — AI output without
// provenance is not project truth. The action gateway enforces the two
// proposal-side halves of that rule before any execution:
//
// - an ActionDescriptor DECLARES its evidence requirement slots (which named
//   evidence references a proposal must carry) and its minimum confidence
//   level (see descriptor.ts);
// - an ActionProposal CARRIES the evidence references filling those slots and
//   its confidence level (see proposal.ts);
// - executeAction() rejects typed any proposal that does not meet the
//   declared requirements, and carries the supplied references into the
//   gateway's audit events (audit-events.ts) — the provenance survives the
//   decision trail.
//
// Evidence references are opaque provenance tokens (ledger event ids, document
// ids, analysis ids…): the gateway checks PRESENCE per declared slot and
// records them; resolving a reference to its underlying artifact is the
// evidence-owning module's concern, never the gateway's.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import {
  describeValue,
  isPlainObject,
  parseLiteralOf,
  parseValueArrayWith,
  requireString,
  unknownKeyFailure,
  type StringRule,
} from './parse';

// ----- evidence requirement slots (descriptor side) -------------------------------------

/** Grammar description used in parse failures. */
export const EVIDENCE_SLOT_GRAMMAR = 'evidence slot: lowercase kebab-case (1..64)';

const SLOT_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: EVIDENCE_SLOT_GRAMMAR,
};

/**
 * One declared evidence requirement of an action (freeze A4): a named slot a
 * proposal of that action MUST fill with an evidence reference.
 */
export interface EvidenceRequirement {
  /** Named slot, e.g. 'justification', 'margin-assessment', 'approval'. */
  readonly slot: string;
  /** What the slot demands, for humans (1..500 characters). */
  readonly description: string;
}

const EVIDENCE_REQUIREMENT_KEYS = ['slot', 'description'] as const;
const EVIDENCE_REQUIREMENT_GRAMMAR =
  'EvidenceRequirement: { slot: kebab (1..64), description: string (1..500) }';

/** Parse an untrusted value as an EvidenceRequirement (total, fail-closed). */
export function parseEvidenceRequirement(raw: unknown): ParseResult<EvidenceRequirement> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_REQUIREMENT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    EVIDENCE_REQUIREMENT_KEYS,
    '',
    EVIDENCE_REQUIREMENT_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const slot = requireString(raw, 'slot', '', SLOT_RULE);
  if (!slot.ok) return slot;
  const description = requireString(raw, 'description', '', {
    min: 1,
    max: 500,
    description: 'human-readable requirement description',
  });
  if (!description.ok) return description;
  return parseOk({ slot: slot.value, description: description.value } satisfies EvidenceRequirement);
}

/** Parse an evidence-requirement list: non-empty elements, unique slots. */
export function parseEvidenceRequirements(
  raw: unknown,
  field: string,
): ParseResult<readonly EvidenceRequirement[]> {
  const parsed = parseValueArrayWith(
    raw,
    field,
    parseEvidenceRequirement,
    'evidence requirements { slot, description }',
  );
  if (!parsed.ok) return parsed;
  const slots = parsed.value.map((requirement) => requirement.slot);
  const duplicates = slots.filter((slot, index) => slots.indexOf(slot) !== index);
  if (duplicates.length > 0) {
    return parseFail(
      'invalid-value',
      field,
      'evidence requirement slots with no duplicates',
      `duplicate slot(s): ${duplicates.join(', ')}`,
    );
  }
  return parseOk(parsed.value);
}

// ----- evidence references (proposal side) ----------------------------------------------

/** Grammar description used in parse failures. */
export const EVIDENCE_REF_GRAMMAR =
  'evidence reference: opaque printable-ASCII token of 1..128 characters (no whitespace)';

const REF_RULE: StringRule = {
  min: 1,
  max: 128,
  pattern: /^[\x21-\x7e]{1,128}$/,
  description: EVIDENCE_REF_GRAMMAR,
};

/**
 * One evidence reference carried by a proposal (freeze A4): the opaque
 * provenance token filling a declared slot — a ledger event id, a document
 * id, an analysis id, an approval reference.
 */
export interface EvidenceReference {
  /** The declared slot this reference fills. */
  readonly slot: string;
  /** The opaque provenance token. */
  readonly ref: string;
}

const EVIDENCE_REFERENCE_KEYS = ['slot', 'ref'] as const;
const EVIDENCE_REFERENCE_GRAMMAR =
  'EvidenceReference: { slot: kebab (1..64), ref: opaque printable-ASCII token (1..128) }';

/** Parse an untrusted value as an EvidenceReference (total, fail-closed). */
export function parseEvidenceReference(raw: unknown): ParseResult<EvidenceReference> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_REFERENCE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    EVIDENCE_REFERENCE_KEYS,
    '',
    EVIDENCE_REFERENCE_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const slot = requireString(raw, 'slot', '', SLOT_RULE);
  if (!slot.ok) return slot;
  const ref = requireString(raw, 'ref', '', REF_RULE);
  if (!ref.ok) return ref;
  return parseOk({ slot: slot.value, ref: ref.value } satisfies EvidenceReference);
}

/** Parse an evidence-reference list: non-empty elements, unique slots. */
export function parseEvidenceReferences(
  raw: unknown,
  field: string,
): ParseResult<readonly EvidenceReference[]> {
  const parsed = parseValueArrayWith(
    raw,
    field,
    parseEvidenceReference,
    'evidence references { slot, ref }',
  );
  if (!parsed.ok) return parsed;
  const slots = parsed.value.map((reference) => reference.slot);
  const duplicates = slots.filter((slot, index) => slots.indexOf(slot) !== index);
  if (duplicates.length > 0) {
    return parseFail(
      'invalid-value',
      field,
      'evidence references filling distinct slots (no duplicate slots)',
      `duplicate slot(s): ${duplicates.join(', ')}`,
    );
  }
  return parseOk(parsed.value);
}

/** The slots carried by a reference list, in order (presence lookup helper). */
export const evidenceSlotsOf = (references: readonly EvidenceReference[]): readonly string[] =>
  references.map((reference) => reference.slot);

// ----- confidence (freeze A4) -------------------------------------------------------------

/**
 * The proposal confidence vocabulary, in increasing order (freeze A4):
 * machine actors carry the confidence of the analysis behind the proposal
 * ('low' … 'high'); 'certain' is the floor a human- or system-initiated
 * proposal carries — it is not a model estimate. The order is total and
 * deterministic; descriptors declare the minimum they accept.
 */
export type ConfidenceLevel = 'low' | 'medium' | 'high' | 'certain';

/** Every confidence level, in increasing order. */
export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = [
  'low',
  'medium',
  'high',
  'certain',
] as const;

const parseConfidenceLiteral = parseLiteralOf(
  CONFIDENCE_LEVELS,
  'confidence levels in increasing order: low < medium < high < certain',
);

/** Grammar description used in parse failures. */
export const CONFIDENCE_GRAMMAR =
  "confidence level 'low' | 'medium' | 'high' | 'certain' (increasing order)";

/** Parse an untrusted value as a ConfidenceLevel (total, fail-closed). */
export function parseConfidenceLevel(raw: unknown): ParseResult<ConfidenceLevel> {
  return parseConfidenceLiteral(raw);
}

/** Type guard for declared ConfidenceLevel values. */
export function isConfidenceLevel(raw: unknown): raw is ConfidenceLevel {
  return parseConfidenceLevel(raw).ok;
}

/** The deterministic rank of a confidence level (higher = more confident). */
export const confidenceRank = (level: ConfidenceLevel): number =>
  CONFIDENCE_LEVELS.indexOf(level);

/** Does `candidate` meet the declared `minimum` confidence? (total order) */
export const meetsConfidence = (candidate: ConfidenceLevel, minimum: ConfidenceLevel): boolean =>
  confidenceRank(candidate) >= confidenceRank(minimum);

/** Compose a validated ConfidenceLevel (trusted path; loud TypeError). */
export function confidenceLevel(name: string): ConfidenceLevel {
  const parsed = parseConfidenceLevel(name);
  if (!parsed.ok) {
    throw new TypeError(`unknown confidence level: ${String(name)}`);
  }
  return parsed.value;
}
