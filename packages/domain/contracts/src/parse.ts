// Office contracts/change domain — package-internal parse helpers (OFF-012).
//
// Fail-closed payload parsing for the domain's command payloads, mirroring
// the conventions of the sibling domain modules (total parsers returning
// ParseResult, strict keys, dotted error paths, short received-value
// descriptions). NOT exported from the package root as a module: only the
// command/state modules of this package use these helpers; the payload
// shapes and the value objects below are re-exported as typed values.
//
// Contracts-domain value objects defined here (all fail-closed, branded):
//  * Money — the canonical decimal representation for commercial amounts:
//    an integer number of MINOR UNITS (cents) plus an ISO-4217-style
//    3-letter currency code. @office/contracts exposes no money type, so
//    this package owns a LOCAL branded minor-unit type and documents it for
//    a future contracts-package addition (do NOT modify @office/contracts).
//    Minor units keep commercial arithmetic in exact integers — no floats.
//  * QuantityValue — a canonical decimal STRING (no host float), e.g.
//    '12', '0.5', '133.750': contracted quantities carry up to three
//    fractional digits and are never arithmetic operands at this layer.
//  * PartyLink — a typed person/company EntityId link (contract parties).
//  * EvidenceLink — { documentId, revisionId }: the typed immutable link to
//    ONE SPECIFIC document revision (entity id + document revision id —
//    typed link, NO import of the documents package, no copied data).
//  * CostImpactLink — { budgetId | null, costItemId | null }: the typed link
//    to a budget or cost item owned by the cost domain (ids only).
import { parseEntityId, parseEntityKind, parseFail, parseOk } from '@office/contracts';
import type { EntityId, EntityKind, ParseResult } from '@office/contracts';

// ----- shared helper vocabulary (mirrors the sibling domain modules) --------------

/** Narrow unknown to a plain JSON object (not null, not an array). */
export const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Short, safe description of an unknown value for error messages. */
export const describeValue = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  switch (typeof raw) {
    case 'string':
      return `string ${JSON.stringify(raw.length > 32 ? `${raw.slice(0, 32)}…` : raw)}`;
    case 'number':
      return `number ${String(raw)}`;
    case 'boolean':
      return `boolean ${String(raw)}`;
    case 'object':
      return Array.isArray(raw) ? `array (length ${raw.length})` : 'object';
    default:
      return typeof raw;
  }
};

/** A string value rule: length bounds, optional grammar pattern, description. */
export interface StringRule {
  readonly min: number;
  readonly max: number;
  readonly pattern?: RegExp;
  readonly description: string;
}

/** An integer value rule: inclusive bounds and description. */
export interface IntegerRule {
  readonly min: number;
  readonly max: number;
  readonly description: string;
}

const describeStringRule = (rule: StringRule): string =>
  `${rule.description} (${rule.min}..${rule.max} characters)`;

const describeIntegerRule = (rule: IntegerRule): string =>
  `${rule.description} (integer ${rule.min}..${rule.max})`;

/** Path of `field` inside the value at `path` ('' = the root). */
export const fieldPath = (path: string, field: string): string =>
  path === '' ? field : `${path}.${field}`;

/**
 * Join a path prefix and a relative sub-path into one dotted path. An index
 * bracket attaches directly (the contracts convention: 'items[2]', never
 * 'items.[2]' — same as the sibling domain modules).
 */
export const joinPath = (prefix: string, sub: string): string => {
  if (sub === '') return prefix;
  if (sub.startsWith('[')) return `${prefix}${sub}`;
  return `${prefix}.${sub}`;
};

/**
 * Repath a nested parse result: sub-parsers report paths relative to their
 * own root; composition prefixes the parent field name.
 */
export const nest = <T>(
  result: ParseResult<T>,
  path: string,
  field: string,
): ParseResult<T> => {
  if (result.ok) return result;
  return parseFail(
    result.error.code,
    joinPath(fieldPath(path, field), result.error.path),
    result.error.expected,
    result.error.received,
  );
};

/** First key of `raw` outside `allowed`, or null when the keys match exactly. */
export const firstUnknownKey = (
  raw: Record<string, unknown>,
  allowed: readonly string[],
): string | null => {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
};

/**
 * Fail-closed unknown-key check. Payload shapes are strict: a field the shape
 * does not know is an error, never silently dropped.
 */
export const unknownKeyFailure = (
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  grammar: string,
): ParseResult<never> | null => {
  const key = firstUnknownKey(raw, allowed);
  if (key === null) return null;
  return parseFail(
    'unknown-field',
    fieldPath(path, key),
    grammar,
    `unexpected key "${key}"`,
  );
};

/** Check a string value against a StringRule at `path`. */
const checkString = (
  value: unknown,
  rule: StringRule,
  path: string,
): ParseResult<string> => {
  const expected = describeStringRule(rule);
  if (typeof value !== 'string') {
    return parseFail('invalid-type', path, expected, describeValue(value));
  }
  if (value.length < rule.min || value.length > rule.max) {
    return parseFail('invalid-value', path, expected, `string of length ${value.length}`);
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    return parseFail('invalid-value', path, expected, describeValue(value));
  }
  return parseOk(value);
};

/** Parse a standalone string value against a StringRule. */
export const parseStringLike = (raw: unknown, rule: StringRule): ParseResult<string> =>
  checkString(raw, rule, '');

/** Check an integer value against an IntegerRule at `path`. */
const checkInteger = (
  value: unknown,
  rule: IntegerRule,
  path: string,
): ParseResult<number> => {
  const expected = describeIntegerRule(rule);
  if (typeof value !== 'number') {
    return parseFail('invalid-type', path, expected, describeValue(value));
  }
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
    return parseFail('invalid-value', path, expected, describeValue(value));
  }
  return parseOk(value);
};

/** Parse a standalone integer value against an IntegerRule. */
export const parseIntegerLike = (raw: unknown, rule: IntegerRule): ParseResult<number> =>
  checkInteger(raw, rule, '');

/** Require a string field of an object; fails closed on missing/type/grammar. */
export const requireString = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
  rule: StringRule,
): ParseResult<string> => {
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), describeStringRule(rule), 'undefined');
  }
  return checkString(value, rule, fieldPath(path, field));
};

/** Require an integer field of an object; fails closed on missing/type/range. */
export const requireInteger = (
  raw: Record<string, unknown>,
  field: string,
  path: string,
  rule: IntegerRule,
): ParseResult<number> => {
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), describeIntegerRule(rule), 'undefined');
  }
  return checkInteger(value, rule, fieldPath(path, field));
};

/**
 * Require a field by delegating to its sub-parser. An absent field fails with
 * 'missing-field'; a present field is validated with error paths nested under
 * the field name.
 */
export const requireFieldWith = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T> => {
  const value = raw[field];
  if (value === undefined) {
    const probe = parseValue(value);
    const expected = probe.ok ? 'a required field' : probe.error.expected;
    return parseFail('missing-field', fieldPath(path, field), expected, 'undefined');
  }
  return nest(parseValue(value), path, field);
};

/**
 * Parse an optional field: absent yields `undefined`; present delegates to the
 * sub-parser (fail-closed — an explicit null is NOT absent).
 */
export const optionalFieldWith = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | undefined> => {
  const value = raw[field];
  if (value === undefined) return parseOk(undefined);
  return nest(parseValue(value), path, field);
};

/**
 * Parse an optional-or-nullable field: absent or null yields null; any other
 * value delegates to the sub-parser.
 */
export const optionalNullableFieldWith = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | null> => {
  const value = raw[field];
  if (value === undefined || value === null) return parseOk(null);
  return nest(parseValue(value), path, field);
};

/**
 * Require an array field whose every element parses through `parseItem`
 * (fail-closed on non-arrays; element failures report paths like
 * '<field>[2]').
 */
export const requireArrayOf = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseItem: (value: unknown) => ParseResult<T>,
): ParseResult<readonly T[]> => {
  const value = raw[field];
  if (value === undefined) {
    return parseFail('missing-field', fieldPath(path, field), 'an array', 'undefined');
  }
  return nest(parseArrayWith(value, parseItem), path, field);
};

/**
 * Parse an optional array field: absent yields `undefined`; present parses as
 * an array through `parseItem` (fail-closed on non-arrays).
 */
export const optionalArrayOf = <T>(
  raw: Record<string, unknown>,
  field: string,
  path: string,
  parseItem: (value: unknown) => ParseResult<T>,
): ParseResult<readonly T[] | undefined> => {
  const value = raw[field];
  if (value === undefined) return parseOk(undefined);
  return nest(parseArrayWith(value, parseItem), path, field);
};

/** Parse an array value whose every element parses through `parseItem`. */
export const parseArrayWith = <T>(
  raw: unknown,
  parseItem: (value: unknown) => ParseResult<T>,
): ParseResult<readonly T[]> => {
  if (!Array.isArray(raw)) {
    return parseFail('invalid-type', '', 'an array', describeValue(raw));
  }
  const items: T[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = parseItem(item);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        `[${index}]${parsed.error.path === '' ? '' : `.${parsed.error.path}`}`,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    items.push(parsed.value);
  }
  return parseOk(items);
};

// ----- Money: canonical minor-unit commercial value --------------------------------

declare const minorUnitsBrand: unique symbol;
declare const currencyCodeBrand: unique symbol;

/**
 * An amount of money in integer MINOR UNITS (e.g. cents): the canonical
 * decimal representation of commercial amounts in this package. Signed — a
 * change order's value impact may decrease the contract value.
 */
export type MinorUnits = number & { readonly [minorUnitsBrand]: 'MinorUnits' };

/** An ISO-4217-style currency code: exactly three uppercase letters. */
export type CurrencyCode = string & { readonly [currencyCodeBrand]: 'CurrencyCode' };

/** A canonical money value: integer minor units + currency code. */
export interface Money {
  readonly amount: MinorUnits;
  readonly currency: CurrencyCode;
}

/** Grammar description used in parse failures. */
export const MINOR_UNITS_GRAMMAR =
  'integer amount of minor units (cents) in -1000000000000000..1000000000000000';

/** Grammar description used in parse failures. */
export const CURRENCY_CODE_GRAMMAR = 'currency code: exactly three uppercase letters (ISO 4217)';

/** Grammar description used in parse failures. */
export const MONEY_GRAMMAR = 'Money: { amount: MinorUnits, currency: CurrencyCode }';

const MINOR_UNITS_RULE: IntegerRule = {
  min: -1_000_000_000_000_000,
  max: 1_000_000_000_000_000,
  description: 'integer amount of minor units (cents)',
};

const CURRENCY_CODE_RULE: StringRule = {
  min: 3,
  max: 3,
  pattern: /^[A-Z]{3}$/,
  description: 'currency code (three uppercase letters)',
};

const MONEY_KEYS = ['amount', 'currency'] as const;

/** Parse an untrusted value as a MinorUnits amount (total, fail-closed). */
export function parseMinorUnits(raw: unknown): ParseResult<MinorUnits> {
  const result = parseIntegerLike(raw, MINOR_UNITS_RULE);
  if (!result.ok) {
    return parseFail(result.error.code, '', MINOR_UNITS_GRAMMAR, result.error.received);
  }
  return parseOk(result.value as MinorUnits);
}

/** Parse an untrusted value as a CurrencyCode (total, fail-closed). */
export function parseCurrencyCode(raw: unknown): ParseResult<CurrencyCode> {
  const result = parseStringLike(raw, CURRENCY_CODE_RULE);
  if (!result.ok) {
    return parseFail(result.error.code, '', CURRENCY_CODE_GRAMMAR, result.error.received);
  }
  return parseOk(result.value as CurrencyCode);
}

/** Parse an untrusted value as a Money value (total, fail-closed, strict keys). */
export function parseMoney(raw: unknown): ParseResult<Money> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', MONEY_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, MONEY_KEYS, '', MONEY_GRAMMAR);
  if (unknownKey) return unknownKey;
  const amount = requireFieldWith(raw, 'amount', '', parseMinorUnits);
  if (!amount.ok) return amount;
  const currency = requireFieldWith(raw, 'currency', '', parseCurrencyCode);
  if (!currency.ok) return currency;
  return parseOk({ amount: amount.value, currency: currency.value } satisfies Money);
}

// ----- QuantityValue: canonical decimal-string quantity ----------------------------

declare const quantityValueBrand: unique symbol;

/**
 * A contracted quantity as a CANONICAL DECIMAL STRING (never a host float):
 * up to 12 integer digits, up to 3 fractional digits, no leading zeros
 * (except the lone '0'), e.g. '12', '0.5', '133.750'.
 */
export type QuantityValue = string & { readonly [quantityValueBrand]: 'QuantityValue' };

/** Grammar description used in parse failures. */
export const QUANTITY_VALUE_GRAMMAR =
  "canonical decimal string: 0..12 integer digits without leading zeros, optional '.' plus 1..3 fractional digits, e.g. '12', '0.5', '133.750'";

const QUANTITY_VALUE_RULE: StringRule = {
  min: 1,
  max: 16,
  pattern: /^(0|[1-9]\d{0,11})(\.\d{1,3})?$/,
  description: 'canonical decimal quantity string',
};

/** Parse an untrusted value as a QuantityValue (total, fail-closed). */
export function parseQuantityValue(raw: unknown): ParseResult<QuantityValue> {
  const result = parseStringLike(raw, QUANTITY_VALUE_RULE);
  if (!result.ok) {
    return parseFail(result.error.code, '', QUANTITY_VALUE_GRAMMAR, result.error.received);
  }
  return parseOk(result.value as QuantityValue);
}

// ----- typed cross-entity link value objects ----------------------------------------

/** The closed party-kind vocabulary of a contract party link. */
export type PartyKind = 'person' | 'company';

/** All party kinds, in canonical order. */
export const PARTY_KINDS: readonly PartyKind[] = ['person', 'company'];

/** Shape description used in parse failures. */
export const PARTY_LINK_GRAMMAR = "PartyLink: { entityKind: 'person' | 'company', entityId: EntityId }";

const PARTY_LINK_KEYS = ['entityKind', 'entityId'] as const;

/** Parse one literal of the closed party-kind vocabulary (total, fail-closed). */
export const parsePartyKind = (raw: unknown): ParseResult<PartyKind> => {
  const grammar = "party kind: one of 'person', 'company'";
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', grammar, describeValue(raw));
  }
  switch (raw) {
    case 'person':
    case 'company':
      return parseOk(raw);
    default:
      return parseFail('invalid-value', '', grammar, describeValue(raw));
  }
};

/**
 * A typed contract-party link: a person or company referenced by canonical
 * EntityKind + EntityId — an identity-domain entity referenced by LINK, never
 * copied (no name/email data enters this package).
 */
export interface PartyLink {
  readonly entityKind: PartyKind;
  readonly entityId: EntityId;
}

/** Parse an untrusted value as a PartyLink (total, fail-closed, strict keys). */
export function parsePartyLink(raw: unknown): ParseResult<PartyLink> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PARTY_LINK_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PARTY_LINK_KEYS, '', PARTY_LINK_GRAMMAR);
  if (unknownKey) return unknownKey;
  const entityKind = requireFieldWith(raw, 'entityKind', '', parsePartyKind);
  if (!entityKind.ok) return entityKind;
  const entityId = requireFieldWith(raw, 'entityId', '', parseEntityId);
  if (!entityId.ok) return entityId;
  return parseOk({ entityKind: entityKind.value, entityId: entityId.value } satisfies PartyLink);
}

/** Shape description used in parse failures. */
export const EVIDENCE_LINK_GRAMMAR =
  'EvidenceLink: { documentId: EntityId, revisionId: EntityId } — a typed link to ONE SPECIFIC document revision (documents-domain entities referenced by id, never copied)';

const EVIDENCE_LINK_KEYS = ['documentId', 'revisionId'] as const;

/**
 * A typed ENTITLEMENT evidence link: a document referenced by canonical id
 * PLUS the specific document revision pinned by that link (entity id +
 * document revision id). The documents package is NOT imported and NONE of
 * the referenced entities' data (titles, hashes, storage keys) is copied —
 * the link is ids only, immutable once recorded.
 */
export interface EvidenceLink {
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
}

/** Parse an untrusted value as an EvidenceLink (total, fail-closed, strict keys). */
export function parseEvidenceLink(raw: unknown): ParseResult<EvidenceLink> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_LINK_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, EVIDENCE_LINK_KEYS, '', EVIDENCE_LINK_GRAMMAR);
  if (unknownKey) return unknownKey;
  const documentId = requireFieldWith(raw, 'documentId', '', parseEntityId);
  if (!documentId.ok) return documentId;
  const revisionId = requireFieldWith(raw, 'revisionId', '', parseEntityId);
  if (!revisionId.ok) return revisionId;
  return parseOk({ documentId: documentId.value, revisionId: revisionId.value } satisfies EvidenceLink);
}

/** Shape description used in parse failures. */
export const COST_IMPACT_LINK_GRAMMAR =
  'CostImpactLink: { budgetId: EntityId | null, costItemId: EntityId | null } — at least one non-null (cost-domain entities referenced by id, never copied)';

const COST_IMPACT_LINK_KEYS = ['budgetId', 'costItemId'] as const;

/**
 * A typed cost-impact link: a budget and/or cost item referenced by canonical
 * EntityId (the cost domain is NOT imported; its data is never copied — the
 * link is ids only, immutable once recorded). At least one of the two ids is
 * required: a link referencing nothing is a wiring error.
 */
export interface CostImpactLink {
  readonly budgetId: EntityId | null;
  readonly costItemId: EntityId | null;
}

/** Parse an untrusted value as a CostImpactLink (total, fail-closed, strict keys). */
export function parseCostImpactLink(raw: unknown): ParseResult<CostImpactLink> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', COST_IMPACT_LINK_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, COST_IMPACT_LINK_KEYS, '', COST_IMPACT_LINK_GRAMMAR);
  if (unknownKey) return unknownKey;
  const budgetId = optionalNullableFieldWith(raw, 'budgetId', '', parseEntityId);
  if (!budgetId.ok) return budgetId;
  const costItemId = optionalNullableFieldWith(raw, 'costItemId', '', parseEntityId);
  if (!costItemId.ok) return costItemId;
  if (budgetId.value === null && costItemId.value === null) {
    return parseFail(
      'invalid-value',
      '',
      COST_IMPACT_LINK_GRAMMAR,
      'both budgetId and costItemId are null — a cost impact link must reference at least one cost entity',
    );
  }
  return parseOk({ budgetId: budgetId.value, costItemId: costItemId.value } satisfies CostImpactLink);
}

// ----- vocabulary literals (trusted-path, self-checked) -----------------------------

/**
 * Parse a trusted-path entity-kind literal (module initialization): a
 * violation means this module is malformed — loud TypeError, never silent.
 */
export const kindLiteral = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    throw new TypeError(
      `invalid contracts-domain entity kind literal: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
};
