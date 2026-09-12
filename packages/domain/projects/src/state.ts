// Office project domain — aggregate state, invariants, transitions (OFF-007).
//
// The Project aggregate of the canonical enterprise graph (freeze A1): a
// tenant-scoped, project-bound working unit — THE second authorization
// boundary of the whole system (freeze A12). It extends the domain kernel's
// Aggregate (canonical identity, owning scope, monotonic version) with the
// fields this module owns. Two structural differences from the sibling
// Organization aggregate:
//
//   * the canonical id is a ProjectId (kind code 'prj'), composed through
//     the contracts format helper exactly like every Office-issued id;
//   * the owning scope is PROJECT scope pointing at the aggregate ITSELF:
//     { kind: 'project', tenantId, projectId = entityId }. A project is its
//     own second boundary — every other project-bound entity of the graph
//     will reference it. The scope is checked by an invariant below, so a
//     project state can never claim a foreign project scope.
//
// The lifecycle is EXPLICIT and one-way: active -> archived; archive is a
// recorded lifecycle transition (status + archived_at + an audit event),
// never a delete and never a silent flag (the row-level CHECK of migration
// 0101 keeps the pair consistent in the database itself).
//
// State invariants are declarative (kernel Invariant<S>) and checked on every
// NEXT state before it commits; lifecycle preconditions (update/archive
// require 'active') are checked by the pure transition functions below — both
// layers return typed invariant-violation DomainErrors, never bare throws.
import { parseEntityKind } from '@office/contracts';
import type { EntityKind, ProjectId, Scope, TenantId, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import type { Aggregate, AggregateVersion, DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { fail, invariantViolation } from '@office/domain-kernel';

/** Lifecycle status of a project. `archived` is terminal (one-way). */
export type ProjectStatus = 'active' | 'archived';

/** All project lifecycle statuses, in canonical order. */
export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'active',
  'archived',
];

const parsedKind = parseEntityKind('project');
if (!parsedKind.ok) {
  // Trusted-path literal: a violation means this module is malformed.
  throw new TypeError(
    `invalid project entity kind literal: ${JSON.stringify(parsedKind.error)}`,
  );
}

/** Canonical entity kind of the Project aggregate. */
export const PROJECT_KIND: EntityKind = parsedKind.value;

/**
 * The Project aggregate state. `scope` is always the project's OWN project
 * scope (freeze A1/A12): { kind: 'project', tenantId, projectId = entityId }.
 * A tenant-scoped command may address any project of its tenant; a
 * project-scoped command may address exactly its own project — the second
 * boundary.
 */
export interface ProjectState extends Aggregate {
  readonly entityId: ProjectId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** Non-empty display name (1..200 characters). */
  readonly name: string;
  /** Lifecycle status; `archived` is terminal. */
  readonly status: ProjectStatus;
  /** When the project was archived; null while active. */
  readonly archivedAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** Extension metadata (A2: JSONB reserved for extension metadata only). */
  readonly extensionMetadata: Readonly<Record<string, unknown>>;
}

const NAME_MAX_LENGTH = 200;

/**
 * Declarative invariants over any ProjectState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const PROJECT_INVARIANTS = [
  defineInvariant<ProjectState>(
    'project-name-nonempty',
    'a project name is 1..200 characters',
    (state) => state.name.length >= 1 && state.name.length <= NAME_MAX_LENGTH,
  ),
  defineInvariant<ProjectState>(
    'project-status-vocabulary',
    "a project status is 'active' or 'archived'",
    (state) => (PROJECT_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<ProjectState>(
    'project-archive-timestamp-pairs-with-status',
    "archivedAt is null exactly while status is 'active' (archive is explicit and timestamped)",
    (state) =>
      (state.status === 'active' && state.archivedAt === null) ||
      (state.status === 'archived' && state.archivedAt !== null),
  ),
  defineInvariant<ProjectState>(
    'project-owns-its-project-scope',
    'a project is owned by its own project scope: { kind: "project", tenantId, projectId = entityId } (the second boundary, A12)',
    (state) =>
      state.scope.kind === 'project' &&
      state.scope.projectId === state.entityId,
  ),
  defineInvariant<ProjectState>(
    'project-version-is-monotonic',
    'a project version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/** Parts of a newly created project (the canonical id is issued inside the handler). */
export interface NewProject {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
  readonly now: Timestamp;
}

/** Field changes for an update; at least one field must be present. */
export interface ProjectChanges {
  readonly name?: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

/**
 * Build the initial state of a newly created project (trusted path — the
 * payload was validated fail-closed upstream). The owning scope is derived
 * from the creating tenant: the project's OWN project scope. Returns the
 * state checked against every invariant.
 */
export function createProjectState(
  input: NewProject,
  tenantId: TenantId,
  context?: DomainErrorContext,
): Result<ProjectState, DomainError> {
  const state: ProjectState = {
    entityKind: PROJECT_KIND,
    entityId: input.projectId,
    scope: { kind: 'project', tenantId, projectId: input.projectId },
    version: INITIAL_AGGREGATE_VERSION,
    name: input.name,
    status: 'active',
    archivedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
    extensionMetadata: input.extensionMetadata ?? {},
  };
  return checkInvariants(state, PROJECT_INVARIANTS, context);
}

/**
 * Pure transition: update an ACTIVE project (rename and/or replace extension
 * metadata). Archived projects are immutable — the transition is a typed
 * invariant-violation, never a silent no-op. On success the next state
 * carries version + 1 and the given `now` as updatedAt.
 */
export function updateProjectState(
  current: ProjectState,
  changes: ProjectChanges,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ProjectState, DomainError> {
  if (current.status !== 'active') {
    return fail(
      invariantViolation(
        {
          name: 'project-update-requires-active',
          statement: `project ${current.entityId} is '${current.status}'; only an active project accepts update mutations`,
        },
        context,
      ),
    );
  }
  const next: ProjectState = {
    ...current,
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.extensionMetadata !== undefined
      ? { extensionMetadata: changes.extensionMetadata }
      : {}),
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, PROJECT_INVARIANTS, context);
}

/**
 * Pure transition: archive an ACTIVE project — the explicit, one-way
 * lifecycle event (freeze: archive is never a delete and never silent). The
 * next state carries status 'archived', archivedAt = now, version + 1.
 */
export function archiveProjectState(
  current: ProjectState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<ProjectState, DomainError> {
  if (current.status !== 'active') {
    return fail(
      invariantViolation(
        {
          name: 'project-archive-requires-active',
          statement: `project ${current.entityId} is already '${current.status}'; archive is a one-way transition from 'active'`,
        },
        context,
      ),
    );
  }
  const next: ProjectState = {
    ...current,
    status: 'archived',
    archivedAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, PROJECT_INVARIANTS, context);
}
