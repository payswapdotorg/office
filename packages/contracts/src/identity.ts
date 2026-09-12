// Office canonical contracts — identity (OFF-002).
//
// Branded opaque canonical IDs: EntityId, TenantId, ProjectId, plus the
// EntityKind vocabulary used by event entity references. Canonical IDs are
// Office-issued, self-describing, versioned strings; provider-shaped strings
// (numeric provider keys, dashed UUIDs, provider handles) are never valid
// canonical IDs — freeze anti-pattern: "no provider-specific IDs as
// canonical primary keys".
//
// Type model (A1 — the enterprise graph contains tenant and project
// entities): EntityId is the supertype — any Office-issued canonical id.
// TenantId and ProjectId are branded subtypes with their own kind codes,
// assignable to EntityId but not to each other, so an entity reference can
// carry a project id without a second, duplicate identifier.
//
// The parse/format/is triple per ID type:
// - `parse` is the total, fail-closed boundary for untrusted values;
// - `format` composes validated parts on the trusted construction path
//   (throws TypeError on invalid parts — a loud programming error, never a
//   silent fallback);
// - `is` is a boolean type guard.
//
// Deterministic ID generation belongs to later work items (OFF-003 domain
// kernel, OFF-007 project identity); this module only defines the grammar.
import {
  describeValue,
  parseFail,
  parseOk,
  parseStringLike,
  type StringRule,
} from './parse';
import type { ParseResult } from './parse';

declare const entityIdBrand: unique symbol;
declare const tenantBrand: unique symbol;
declare const projectBrand: unique symbol;
declare const entityKindBrand: unique symbol;

/**
 * Opaque canonical identifier for any Office entity, including tenants and
 * projects. Grammar: office-<ent|tnt|prj>-<idVersion>-<opaque>.
 */
export type EntityId = string & { readonly [entityIdBrand]: 'EntityId' };
/** Opaque canonical tenant identifier (A12 scope key); also a valid EntityId. */
export type TenantId = EntityId & { readonly [tenantBrand]: 'TenantId' };
/** Opaque canonical project identifier (A12 scope key); also a valid EntityId. */
export type ProjectId = EntityId & { readonly [projectBrand]: 'ProjectId' };
/** Canonical entity kind label, e.g. 'project', 'document', 'change-order'. */
export type EntityKind = string & { readonly [entityKindBrand]: 'EntityKind' };

/** ID format versions understood by this contract release. */
export const KNOWN_ID_VERSIONS = ['v1'] as const;

/** ID format version carried inside every canonical ID string. */
export type IdVersion = (typeof KNOWN_ID_VERSIONS)[number];

/** Validated parts of a canonical ID. */
export interface IdParts {
  readonly version: IdVersion;
  readonly opaque: string;
}

/** Grammar of a canonical ID string. */
export const ID_GRAMMAR =
  'office-<ent|tnt|prj>-<idVersion>-<opaque: 16..64 lowercase alphanumeric> (ent: generic entity, tnt: tenant, prj: project)';

/** Kind codes accepted by parseEntityId (the EntityId supertype). */
export const ENTITY_ID_KIND_CODES = ['ent', 'tnt', 'prj'] as const;

const OPAQUE_RULE: StringRule = {
  min: 16,
  max: 64,
  pattern: /^[0-9a-z]{16,64}$/,
  description: 'lowercase alphanumeric opaque id part',
};

const ENTITY_KIND_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case entity kind (no leading/trailing/double dashes)',
};

type IdKindCode = 'ent' | 'tnt' | 'prj';

/**
 * Validate an untrusted value as a canonical ID string. When `expectedCode`
 * is given, only that kind code is accepted (TenantId/ProjectId); otherwise
 * any EntityId kind code is accepted. Fails closed with 'unknown-id-version'
 * when the ID format version is not known.
 */
const validateId = (
  raw: unknown,
  expectedCode: IdKindCode | undefined,
): ParseResult<string> => {
  const grammar =
    expectedCode === undefined
      ? ID_GRAMMAR
      : `${ID_GRAMMAR} (kind code '${expectedCode}')`;
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', grammar, describeValue(raw));
  }
  const parts = raw.split('-');
  if (parts.length !== 4) {
    return parseFail('invalid-value', '', grammar, describeValue(raw));
  }
  const prefix = parts[0];
  const code = parts[1];
  const version = parts[2];
  const opaque = parts[3];
  const codeAccepted =
    expectedCode !== undefined
      ? code === expectedCode
      : code !== undefined && (ENTITY_ID_KIND_CODES as readonly string[]).includes(code);
  if (prefix !== 'office' || !codeAccepted) {
    return parseFail('invalid-value', '', grammar, describeValue(raw));
  }
  if (version === undefined || !(KNOWN_ID_VERSIONS as readonly string[]).includes(version)) {
    return parseFail(
      'unknown-id-version',
      '',
      `id version one of: ${KNOWN_ID_VERSIONS.join(', ')}`,
      describeValue(version),
    );
  }
  const opaqueCheck = parseStringLike(opaque, OPAQUE_RULE);
  if (!opaqueCheck.ok) return opaqueCheck;
  return parseOk(raw);
};

/** Compose a canonical ID string from validated parts (trusted path). */
function formatId(kindCode: IdKindCode, parts: IdParts): string {
  if (!(KNOWN_ID_VERSIONS as readonly string[]).includes(parts.version)) {
    throw new TypeError(`unknown id version: ${String(parts.version)}`);
  }
  if (parts.opaque.length < OPAQUE_RULE.min || parts.opaque.length > OPAQUE_RULE.max) {
    throw new TypeError(`invalid opaque id part length: ${parts.opaque.length}`);
  }
  if (OPAQUE_RULE.pattern !== undefined && !OPAQUE_RULE.pattern.test(parts.opaque)) {
    throw new TypeError(`invalid opaque id part: ${parts.opaque}`);
  }
  return `office-${kindCode}-${parts.version}-${parts.opaque}`;
}

/**
 * Parse an untrusted value as an EntityId (total, fail-closed). Accepts all
 * EntityId kind codes (ent/tnt/prj) — tenants and projects are entities.
 */
export function parseEntityId(raw: unknown): ParseResult<EntityId> {
  const result = validateId(raw, undefined);
  if (!result.ok) return result;
  return parseOk(result.value as EntityId);
}

/** Type guard for structurally valid EntityId values. */
export function isEntityId(raw: unknown): raw is EntityId {
  return validateId(raw, undefined).ok;
}

/** Compose a generic canonical EntityId from validated parts (trusted path). */
export function formatEntityId(parts: IdParts): EntityId {
  return formatId('ent', parts) as EntityId;
}

/** Parse an untrusted value as a TenantId (total, fail-closed; kind code 'tnt' only). */
export function parseTenantId(raw: unknown): ParseResult<TenantId> {
  const result = validateId(raw, 'tnt');
  if (!result.ok) return result;
  return parseOk(result.value as TenantId);
}

/** Type guard for structurally valid TenantId values. */
export function isTenantId(raw: unknown): raw is TenantId {
  return validateId(raw, 'tnt').ok;
}

/** Compose a canonical TenantId from validated parts (trusted path). */
export function formatTenantId(parts: IdParts): TenantId {
  return formatId('tnt', parts) as TenantId;
}

/** Parse an untrusted value as a ProjectId (total, fail-closed; kind code 'prj' only). */
export function parseProjectId(raw: unknown): ParseResult<ProjectId> {
  const result = validateId(raw, 'prj');
  if (!result.ok) return result;
  return parseOk(result.value as ProjectId);
}

/** Type guard for structurally valid ProjectId values. */
export function isProjectId(raw: unknown): raw is ProjectId {
  return validateId(raw, 'prj').ok;
}

/** Compose a canonical ProjectId from validated parts (trusted path). */
export function formatProjectId(parts: IdParts): ProjectId {
  return formatId('prj', parts) as ProjectId;
}

/** Parse an untrusted value as an EntityKind (total, fail-closed). */
export function parseEntityKind(raw: unknown): ParseResult<EntityKind> {
  const result = parseStringLike(raw, ENTITY_KIND_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as EntityKind);
}

/** Type guard for structurally valid EntityKind values. */
export function isEntityKind(raw: unknown): raw is EntityKind {
  return parseStringLike(raw, ENTITY_KIND_RULE).ok;
}
