// Office domain kernel — aggregate identity & versioning (OFF-003).
//
// Every canonical aggregate (OFF-007+) carries: a canonical entity identity
// (EntityRef from contracts: kind + opaque id), its owning tenant/project
// Scope (freeze A12 — every persisted entity is tenant-scoped, project scope
// where bound), and a monotonic AggregateVersion starting at 1. Mutations
// are guarded by optimistic concurrency: the caller presents the
// ConcurrencyToken it read with the state; a stale version is a typed
// concurrency-conflict and is NEVER silently overwritten (freeze
// anti-pattern: no last-write-wins for material state).
//
// Versioning rules:
// - versions are integers in 1..MAX_SAFE_INTEGER, monotonic per aggregate;
// - a mutation applies only when the expected version equals the actual
//   version; on success the committed version is nextAggregateVersion(actual);
// - presenting a token for a DIFFERENT aggregate than the one loaded is a
//   programming error on the trusted path — a loud TypeError, not a domain
//   failure.
//
// Tenant/project scope coverage (A12): checkScopeCovers is the domain-level
// backstop proving a command's scope may act on an aggregate's state.
// Persistence (OFF-004) must additionally scope every query by tenant so
// foreign aggregates never load in the first place; authorization policy
// (OFF-006) refines who may do what within a permitted scope.
import { parseEntityId, parseEntityKind, parseFail, parseOk } from '@office/contracts';
import type { EntityId, EntityKind, ParseResult, Scope } from '@office/contracts';
import { fail, ok } from './result';
import type { Result } from './result';
import {
  concurrencyConflict,
  projectScopeViolation,
  tenantScopeViolation,
} from './errors';
import type { DomainError, DomainErrorContext } from './errors';

declare const aggregateVersionBrand: unique symbol;

/** Monotonic version of a single aggregate; starts at 1, increments by 1. */
export type AggregateVersion = number & {
  readonly [aggregateVersionBrand]: 'AggregateVersion';
};

/** Version a newly created aggregate starts at. */
export const INITIAL_AGGREGATE_VERSION = 1 as AggregateVersion;

/** Largest representable AggregateVersion. */
export const MAX_AGGREGATE_VERSION = Number.MAX_SAFE_INTEGER as AggregateVersion;

/** Grammar description used in parse failures. */
export const AGGREGATE_VERSION_GRAMMAR = `integer version in 1..${Number.MAX_SAFE_INTEGER} (monotonic, starts at 1)`;

/**
 * Minimal kernel view of an aggregate: canonical identity, owning scope
 * (A12), and current version. Domain modules (OFF-007+) extend this with
 * their own state; the kernel's checks only rely on these fields.
 */
export interface Aggregate {
  readonly entityKind: EntityKind;
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
}

/**
 * Optimistic-concurrency token: the aggregate identity plus the version the
 * caller read. Presented back on mutation; a stale version is a typed
 * concurrency-conflict, never a silent overwrite.
 */
export interface ConcurrencyToken {
  readonly kind: 'concurrency-token';
  readonly entityKind: EntityKind;
  readonly entityId: EntityId;
  readonly version: AggregateVersion;
}

/** Grammar description used in parse failures. */
export const CONCURRENCY_TOKEN_GRAMMAR =
  "ConcurrencyToken: { kind: 'concurrency-token', entityKind, entityId, version }";

const CONCURRENCY_TOKEN_KEYS = [
  'kind',
  'entityKind',
  'entityId',
  'version',
] as const;

const describeValue = (raw: unknown): string => {
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

const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Parse an untrusted value as an AggregateVersion (total, fail-closed). */
export function parseAggregateVersion(raw: unknown): ParseResult<AggregateVersion> {
  if (typeof raw !== 'number') {
    return parseFail('invalid-type', '', AGGREGATE_VERSION_GRAMMAR, describeValue(raw));
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > Number.MAX_SAFE_INTEGER) {
    return parseFail('invalid-value', '', AGGREGATE_VERSION_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as AggregateVersion);
}

/** Type guard for structurally valid AggregateVersion values. */
export function isAggregateVersion(raw: unknown): raw is AggregateVersion {
  return parseAggregateVersion(raw).ok;
}

/**
 * The next version of an aggregate after a committed mutation (trusted
 * path). Throws TypeError for an invalid version or at the representable
 * ceiling — loud, never silent.
 */
export function nextAggregateVersion(version: AggregateVersion): AggregateVersion {
  if (!isAggregateVersion(version)) {
    throw new TypeError(`invalid aggregate version: ${String(version)}`);
  }
  if (version >= MAX_AGGREGATE_VERSION) {
    throw new TypeError(
      `aggregate version exhausted at ${String(MAX_AGGREGATE_VERSION)}`,
    );
  }
  return (version + 1) as AggregateVersion;
}

/**
 * Require a field of a plain object by delegating to its sub-parser, with
 * 'missing-field' for absent fields (probe pattern mirrors the contracts
 * package's internal helper) and sub-parser failures nested under the
 * field name.
 */
const requireField = <T>(
  raw: Record<string, unknown>,
  field: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T> => {
  const value = raw[field];
  if (value === undefined) {
    const probe = parseValue(value);
    const expected = probe.ok ? 'a required field' : probe.error.expected;
    return parseFail('missing-field', field, expected, 'undefined');
  }
  const result = parseValue(value);
  if (!result.ok) {
    return parseFail(result.error.code, field, result.error.expected, result.error.received);
  }
  return result;
};

/** Parse an untrusted value as a ConcurrencyToken (total, fail-closed, strict keys). */
export function parseConcurrencyToken(raw: unknown): ParseResult<ConcurrencyToken> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONCURRENCY_TOKEN_GRAMMAR, describeValue(raw));
  }
  for (const key of Object.keys(raw)) {
    if (!(CONCURRENCY_TOKEN_KEYS as readonly string[]).includes(key)) {
      return parseFail(
        'unknown-field',
        key,
        CONCURRENCY_TOKEN_GRAMMAR,
        `unexpected key "${key}"`,
      );
    }
  }
  const kind = raw['kind'];
  if (kind === undefined) {
    return parseFail('missing-field', 'kind', "'concurrency-token'", 'undefined');
  }
  if (kind !== 'concurrency-token') {
    return parseFail(
      'invalid-value',
      'kind',
      "'concurrency-token'",
      describeValue(kind),
    );
  }
  const entityKind = requireField(raw, 'entityKind', parseEntityKind);
  if (!entityKind.ok) return entityKind;
  const entityId = requireField(raw, 'entityId', parseEntityId);
  if (!entityId.ok) return entityId;
  const version = requireField(raw, 'version', parseAggregateVersion);
  if (!version.ok) return version;
  return parseOk({
    kind: 'concurrency-token',
    entityKind: entityKind.value,
    entityId: entityId.value,
    version: version.value,
  } satisfies ConcurrencyToken);
}

/** Type guard for structurally valid ConcurrencyToken values. */
export function isConcurrencyToken(raw: unknown): raw is ConcurrencyToken {
  return parseConcurrencyToken(raw).ok;
}

/**
 * Derive the optimistic-concurrency token of an aggregate (trusted path).
 * Throws TypeError when the aggregate's version is not a valid
 * AggregateVersion.
 */
export function concurrencyTokenOf(aggregate: Aggregate): ConcurrencyToken {
  if (!isAggregateVersion(aggregate.version)) {
    throw new TypeError(`invalid aggregate version: ${String(aggregate.version)}`);
  }
  return {
    kind: 'concurrency-token',
    entityKind: aggregate.entityKind,
    entityId: aggregate.entityId,
    version: aggregate.version,
  };
}

/**
 * Optimistic-concurrency check (freeze: never silently overwrite). The
 * mutation may apply only when `expected` (the token the caller read)
 * matches `actual` (the token of the loaded aggregate). Any version
 * mismatch — stale or otherwise — is a typed concurrency-conflict
 * DomainError; the caller retries with a refreshed token.
 *
 * Presenting a token for a different aggregate than the one loaded is a
 * programming error on the trusted path: a loud TypeError.
 */
export function checkConcurrency(
  expected: ConcurrencyToken,
  actual: ConcurrencyToken,
  context?: DomainErrorContext,
): Result<true, DomainError> {
  if (
    expected.entityKind !== actual.entityKind ||
    expected.entityId !== actual.entityId
  ) {
    throw new TypeError(
      `concurrency token does not address the loaded aggregate: expected ${expected.entityKind} ${expected.entityId}, actual ${actual.entityKind} ${actual.entityId}`,
    );
  }
  if (expected.version === actual.version) {
    return ok(true);
  }
  return fail(
    concurrencyConflict(
      {
        entityKind: actual.entityKind,
        entityId: actual.entityId,
        expectedVersion: expected.version,
        actualVersion: actual.version,
      },
      context,
    ),
  );
}

/**
 * Tenant/project scope coverage (freeze A12): may a command executing under
 * `commandScope` act on an aggregate owned by `aggregateScope`?
 *
 * - different tenant → typed unauthorized (tenant-scope-violation);
 * - project-scoped command on a project-scoped aggregate of the same tenant
 *   but a different project → typed unauthorized (project-scope-violation);
 * - a project-scoped command MAY act on a tenant-wide aggregate of the same
 *   tenant (referencing tenant-level entities from project scope is legal);
 * - same tenant, matching projects → covered.
 *
 * This is the domain-level backstop; OFF-004 must scope queries by tenant
 * and OFF-006 layers capability policy on top.
 */
export function checkScopeCovers(
  commandScope: Scope,
  aggregateScope: Scope,
  context?: DomainErrorContext,
): Result<true, DomainError> {
  if (commandScope.tenantId !== aggregateScope.tenantId) {
    return fail(
      tenantScopeViolation(
        {
          commandTenantId: commandScope.tenantId,
          aggregateTenantId: aggregateScope.tenantId,
        },
        context,
      ),
    );
  }
  if (
    commandScope.kind === 'project' &&
    aggregateScope.kind === 'project' &&
    commandScope.projectId !== aggregateScope.projectId
  ) {
    return fail(
      projectScopeViolation(
        {
          commandProjectId: commandScope.projectId,
          aggregateProjectId: aggregateScope.projectId,
        },
        context,
      ),
    );
  }
  return ok(true);
}
