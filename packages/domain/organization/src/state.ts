// Office organization domain — aggregate state, invariants, transitions (OFF-007).
//
// The Organization aggregate of the canonical enterprise graph (freeze A1):
// a tenant-scoped named enterprise unit (a construction company, a business
// unit, a client organization). It extends the domain kernel's Aggregate
// (canonical identity, owning scope, monotonic version) with the fields this
// module owns. The lifecycle is EXPLICIT and one-way: active -> archived;
// archive is a recorded lifecycle transition (status + archived_at + an audit
// event), never a delete and never a silent flag.
//
// State invariants are declarative (kernel Invariant<S>) and checked on every
// NEXT state before it commits; lifecycle preconditions (update/archive
// require 'active') are checked by the pure transition functions below — both
// layers return typed invariant-violation DomainErrors, never bare throws.
import { parseEntityKind } from '@office/contracts';
import type { EntityId, EntityKind, Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import type { Aggregate, AggregateVersion, DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { fail, invariantViolation } from '@office/domain-kernel';

/** Lifecycle status of an organization. `archived` is terminal (one-way). */
export type OrganizationStatus = 'active' | 'archived';

/** All organization lifecycle statuses, in canonical order. */
export const ORGANIZATION_STATUSES: readonly OrganizationStatus[] = [
  'active',
  'archived',
];

const parsedKind = parseEntityKind('organization');
if (!parsedKind.ok) {
  // Trusted-path literal: a violation means this module is malformed.
  throw new TypeError(
    `invalid organization entity kind literal: ${JSON.stringify(parsedKind.error)}`,
  );
}

/** Canonical entity kind of the Organization aggregate. */
export const ORGANIZATION_KIND: EntityKind = parsedKind.value;

/**
 * The Organization aggregate state. `scope` is always tenant scope (freeze
 * A1/A12: organizations are tenant-level entities; a project-scoped command
 * may reference them, but they are never bound to a single project).
 */
export interface OrganizationState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** Non-empty display name (1..200 characters). */
  readonly name: string;
  /** Lifecycle status; `archived` is terminal. */
  readonly status: OrganizationStatus;
  /** When the organization was archived; null while active. */
  readonly archivedAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** Extension metadata (A2: JSONB reserved for extension metadata only). */
  readonly extensionMetadata: Readonly<Record<string, unknown>>;
}

const NAME_MAX_LENGTH = 200;

/**
 * Declarative invariants over any OrganizationState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const ORGANIZATION_INVARIANTS = [
  defineInvariant<OrganizationState>(
    'organization-name-nonempty',
    'an organization name is 1..200 characters',
    (state) => state.name.length >= 1 && state.name.length <= NAME_MAX_LENGTH,
  ),
  defineInvariant<OrganizationState>(
    'organization-status-vocabulary',
    "an organization status is 'active' or 'archived'",
    (state) => (ORGANIZATION_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<OrganizationState>(
    'organization-archive-timestamp-pairs-with-status',
    "archivedAt is null exactly while status is 'active' (archive is explicit and timestamped)",
    (state) =>
      (state.status === 'active' && state.archivedAt === null) ||
      (state.status === 'archived' && state.archivedAt !== null),
  ),
  defineInvariant<OrganizationState>(
    'organization-is-tenant-scoped',
    'an organization is owned by exactly one tenant (tenant scope, never project scope)',
    (state) => state.scope.kind === 'tenant',
  ),
  defineInvariant<OrganizationState>(
    'organization-version-is-monotonic',
    'an organization version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/** Parts of a newly created organization (the canonical id is issued inside the handler). */
export interface NewOrganization {
  readonly organizationId: EntityId;
  readonly name: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
  readonly now: Timestamp;
}

/** Field changes for an update; at least one field must be present. */
export interface OrganizationChanges {
  readonly name?: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

/**
 * Build the initial state of a newly created organization (trusted path —
 * the payload was validated fail-closed upstream). Returns the state checked
 * against every invariant.
 */
export function createOrganizationState(
  input: NewOrganization,
  scope: Scope,
  context?: DomainErrorContext,
): Result<OrganizationState, DomainError> {
  const state: OrganizationState = {
    entityKind: ORGANIZATION_KIND,
    entityId: input.organizationId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    name: input.name,
    status: 'active',
    archivedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
    extensionMetadata: input.extensionMetadata ?? {},
  };
  return checkInvariants(state, ORGANIZATION_INVARIANTS, context);
}

/**
 * Pure transition: update an ACTIVE organization (rename and/or replace
 * extension metadata). Archived organizations are immutable — the transition
 * is a typed invariant-violation, never a silent no-op. On success the next
 * state carries version + 1 and the given `now` as updatedAt.
 */
export function updateOrganizationState(
  current: OrganizationState,
  changes: OrganizationChanges,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<OrganizationState, DomainError> {
  if (current.status !== 'active') {
    return fail(
      invariantViolation(
        {
          name: 'organization-update-requires-active',
          statement: `organization ${current.entityId} is '${current.status}'; only an active organization accepts update mutations`,
        },
        context,
      ),
    );
  }
  const next: OrganizationState = {
    ...current,
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.extensionMetadata !== undefined
      ? { extensionMetadata: changes.extensionMetadata }
      : {}),
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, ORGANIZATION_INVARIANTS, context);
}

/**
 * Pure transition: archive an ACTIVE organization — the explicit, one-way
 * lifecycle event (freeze: archive is never a delete and never silent). The
 * next state carries status 'archived', archivedAt = now, version + 1.
 */
export function archiveOrganizationState(
  current: OrganizationState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<OrganizationState, DomainError> {
  if (current.status !== 'active') {
    return fail(
      invariantViolation(
        {
          name: 'organization-archive-requires-active',
          statement: `organization ${current.entityId} is already '${current.status}'; archive is a one-way transition from 'active'`,
        },
        context,
      ),
    );
  }
  const next: OrganizationState = {
    ...current,
    status: 'archived',
    archivedAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, ORGANIZATION_INVARIANTS, context);
}
