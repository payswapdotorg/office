// Office adapters-sdk — provider-side identity vocabulary (OFF-020).
//
// The branded string types naming the provider side of the identity seam:
// which ADAPTER family translates an object, which provider SYSTEM it lives
// in, the provider's OBJECT TYPE, the provider's OBJECT ID, and the
// provider's VERSION/etag of that object. These values name PROVIDER
// identity only — they are never canonical primary keys (freeze
// anti-pattern) and never enter canonical actor fields: the mapping record
// (mapping.ts) binds them to office-issued EntityIds.
//
// The vocabulary is open by design: real adapter families (the OFF-021+
// packages) declare their own kinds; this SDK and its fake fixture use only
// generic names ('fake-crm' style). Every type follows the contracts
// convention: a total fail-closed `parse` for untrusted values, an `is` type
// guard, and a trusted builder that throws a loud TypeError instead of
// coercing.
//
// ProviderVersion is REQUIRED and never null: unversioned external
// synchronization is a frozen anti-pattern. An adapter whose provider has no
// native version/etag MUST derive one deterministically from the payload
// (e.g. a content digest) — that is the adapter's job, not the SDK's.
import { parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { checkString, describeValue, type StringRule } from './parse';

declare const adapterKindBrand: unique symbol;
declare const providerSystemIdBrand: unique symbol;
declare const providerObjectKindBrand: unique symbol;
declare const providerObjectIdBrand: unique symbol;
declare const providerVersionBrand: unique symbol;

/** Adapter family kind, e.g. 'fake-crm' — the OFF-021+ packages own real names. */
export type AdapterKind = string & { readonly [adapterKindBrand]: 'AdapterKind' };
/** Identity of one connected provider system (the provider-side account/instance). */
export type ProviderSystemId = string & {
  readonly [providerSystemIdBrand]: 'ProviderSystemId';
};
/** The provider's own object type name, e.g. 'contact' (generic vocabulary). */
export type ProviderObjectKind = string & {
  readonly [providerObjectKindBrand]: 'ProviderObjectKind';
};
/** The provider's own opaque object identifier (never a canonical primary key). */
export type ProviderObjectId = string & {
  readonly [providerObjectIdBrand]: 'ProviderObjectId';
};
/** The provider's version/etag of one object — required, never null (no unversioned sync). */
export type ProviderVersion = string & {
  readonly [providerVersionBrand]: 'ProviderVersion';
};

/** Grammar description used in parse failures. */
export const ADAPTER_KIND_GRAMMAR =
  'lowercase kebab-case adapter kind of 2..64 characters, e.g. fake-crm (declared by the adapter package)';

/** Grammar description used in parse failures. */
export const PROVIDER_SYSTEM_ID_GRAMMAR =
  'opaque printable-ASCII token of 1..128 characters (no whitespace) naming one connected provider system';

/** Grammar description used in parse failures. */
export const PROVIDER_OBJECT_KIND_GRAMMAR =
  'lowercase kebab-case provider object kind of 1..64 characters (no leading/trailing/double dashes)';

/** Grammar description used in parse failures. */
export const PROVIDER_OBJECT_ID_GRAMMAR =
  'opaque printable-ASCII token of 1..128 characters (no whitespace) — the provider object id';

/** Grammar description used in parse failures. */
export const PROVIDER_VERSION_GRAMMAR =
  'opaque printable-ASCII token of 1..128 characters (no whitespace) — the provider version/etag (derive one from payload content when the provider has none)';

const ADAPTER_KIND_RULE: StringRule = {
  min: 2,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,63}$/,
  description: ADAPTER_KIND_GRAMMAR,
};

const KEBAB_KIND_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: PROVIDER_OBJECT_KIND_GRAMMAR,
};

const OPAQUE_TOKEN_RULE: StringRule = {
  min: 1,
  max: 128,
  pattern: /^[\x21-\x7e]+$/,
  description: 'opaque printable-ASCII token (no whitespace)',
};

/** Parse an untrusted value as an AdapterKind (total, fail-closed). */
export function parseAdapterKind(raw: unknown): ParseResult<AdapterKind> {
  const result = checkString(raw, ADAPTER_KIND_RULE, '');
  if (!result.ok) return result;
  return parseOk(result.value as AdapterKind);
}

/** Type guard for structurally valid AdapterKind values. */
export function isAdapterKind(raw: unknown): raw is AdapterKind {
  return parseAdapterKind(raw).ok;
}

/** Compose an AdapterKind from a validated literal (trusted path; loud TypeError). */
export function adapterKind(raw: string): AdapterKind {
  const parsed = parseAdapterKind(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid adapter kind: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Parse an untrusted value as a ProviderSystemId (total, fail-closed). */
export function parseProviderSystemId(raw: unknown): ParseResult<ProviderSystemId> {
  const result = checkString(raw, OPAQUE_TOKEN_RULE, '');
  if (!result.ok) return result;
  return parseOk(result.value as ProviderSystemId);
}

/** Type guard for structurally valid ProviderSystemId values. */
export function isProviderSystemId(raw: unknown): raw is ProviderSystemId {
  return parseProviderSystemId(raw).ok;
}

/** Compose a ProviderSystemId from a validated literal (trusted path). */
export function providerSystemId(raw: string): ProviderSystemId {
  const parsed = parseProviderSystemId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid provider system id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Parse an untrusted value as a ProviderObjectKind (total, fail-closed). */
export function parseProviderObjectKind(raw: unknown): ParseResult<ProviderObjectKind> {
  const result = checkString(raw, KEBAB_KIND_RULE, '');
  if (!result.ok) return result;
  return parseOk(result.value as ProviderObjectKind);
}

/** Type guard for structurally valid ProviderObjectKind values. */
export function isProviderObjectKind(raw: unknown): raw is ProviderObjectKind {
  return parseProviderObjectKind(raw).ok;
}

/** Compose a ProviderObjectKind from a validated literal (trusted path). */
export function providerObjectKind(raw: string): ProviderObjectKind {
  const parsed = parseProviderObjectKind(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid provider object kind: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Parse an untrusted value as a ProviderObjectId (total, fail-closed). */
export function parseProviderObjectId(raw: unknown): ParseResult<ProviderObjectId> {
  const result = checkString(raw, OPAQUE_TOKEN_RULE, '');
  if (!result.ok) return result;
  return parseOk(result.value as ProviderObjectId);
}

/** Type guard for structurally valid ProviderObjectId values. */
export function isProviderObjectId(raw: unknown): raw is ProviderObjectId {
  return parseProviderObjectId(raw).ok;
}

/** Compose a ProviderObjectId from a validated literal (trusted path). */
export function providerObjectId(raw: string): ProviderObjectId {
  const parsed = parseProviderObjectId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid provider object id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Parse an untrusted value as a ProviderVersion (total, fail-closed). */
export function parseProviderVersion(raw: unknown): ParseResult<ProviderVersion> {
  const result = checkString(raw, OPAQUE_TOKEN_RULE, '');
  if (!result.ok) return result;
  return parseOk(result.value as ProviderVersion);
}

/** Type guard for structurally valid ProviderVersion values. */
export function isProviderVersion(raw: unknown): raw is ProviderVersion {
  return parseProviderVersion(raw).ok;
}

/** Compose a ProviderVersion from a validated literal (trusted path). */
export function providerVersion(raw: string): ProviderVersion {
  const parsed = parseProviderVersion(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid provider version: ${describeValue(raw)}`);
  }
  return parsed.value;
}
