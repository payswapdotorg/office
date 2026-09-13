// Office web application shell — the shell session (OFF-030).
//
// ONE typed session record (tenant, project, actor) that EVERY surface of
// the shell resolves through (freeze A12: the web client is a VIEW of ONE
// project state — never a second source of truth). The session is pure
// typed data: the tenant/project scope, the acting user, the deny-by-default
// policy, and the capabilities granted to the actor for the session. It
// never touches a store, never constructs a gateway, and performs no I/O.
//
// Cross-tenant/cross-project access is NOT decided here — the session is an
// identity, not an oracle: every surface resolves it against the seeded
// world's public read surfaces, where a foreign tenant's row is a typed
// not-found and a same-tenant/foreign-project row is a typed unauthorized
// (freeze A12, both directions, no existence oracle).
import { authorizationContext, capability, definePolicy } from '@office/authz';
import type { Capability, Policy, ResourceScope } from '@office/authz';
import {
  isEntityId,
  isProjectId,
  isTenantId,
  parseActor,
  parseEntityId,
  parseEntityRef,
  parseProjectId,
  parseScope,
  parseTenantId,
} from '@office/contracts';
import type {
  EntityId,
  EntityRef,
  IdentifiedActor,
  ProjectId,
  ProjectScope,
  TenantId,
} from '@office/contracts';

/**
 * The capability set the shell's standard project operator holds: the area
 * READ capabilities (the workspace's projections, the control tower's
 * exception query, the sync grant's read gate) plus the area WRITE
 * capabilities the seeded project's command paths exercise (field capture,
 * workflow approvals, cost recording). The closed vocabulary is
 * @office/authz's; every name below is declared there.
 */
export const SESSION_OPERATOR_CAPABILITIES: readonly Capability[] = [
  capability('projects.read'),
  capability('projects.write'),
  capability('organization.read'),
  capability('documents.read'),
  capability('documents.write'),
  capability('work.read'),
  capability('work.write'),
  capability('schedule.read'),
  capability('schedule.write'),
  capability('cost.read'),
  capability('cost.write'),
  capability('contracts.read'),
  capability('contracts.write'),
  capability('workflows.write'),
];

/**
 * The session's static, data-driven deny-by-default policy: one allow rule
 * per granted capability, reads and writes both. Explicit denials still win
 * and a missing rule still denies (the evaluator's contract, not a bypass).
 */
export const sessionOperatorPolicy = (): Policy =>
  definePolicy([
    {
      effect: 'allow',
      capabilities: ['projects.read', 'projects.write'],
      actions: ['read', 'write'],
    },
    { effect: 'allow', capabilities: ['organization.read'], actions: ['read'] },
    {
      effect: 'allow',
      capabilities: ['documents.read', 'documents.write'],
      actions: ['read', 'write'],
    },
    { effect: 'allow', capabilities: ['work.read', 'work.write'], actions: ['read', 'write'] },
    {
      effect: 'allow',
      capabilities: ['schedule.read', 'schedule.write'],
      actions: ['read', 'write'],
    },
    { effect: 'allow', capabilities: ['cost.read', 'cost.write'], actions: ['read', 'write'] },
    {
      effect: 'allow',
      capabilities: ['contracts.read', 'contracts.write'],
      actions: ['read', 'write'],
    },
    { effect: 'allow', capabilities: ['workflows.write'], actions: ['read', 'write'] },
  ]);

/** The fail-closed session input (raw strings — parsed here, never trusted). */
export interface WebSessionInput {
  /** The tenant the session operates in (canonical TenantId grammar). */
  readonly tenantId: string;
  /** THE project the session operates on (canonical ProjectId grammar). */
  readonly projectId: string;
  /** The acting user's canonical entity id. */
  readonly actorId: string;
}

/** The typed shell session every surface resolves through. */
export interface WebSession {
  readonly kind: 'web-session';
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The ONE project state this session views (freeze A12). */
  readonly scope: ProjectScope;
  /** The acting user (provenance on every command this session issues). */
  readonly actor: IdentifiedActor;
  /** The session's deny-by-default policy. */
  readonly policy: Policy;
  /** The capabilities granted to the actor for this session. */
  readonly capabilities: readonly Capability[];
}

/** Why a session input was rejected (displayable, typed — never a throw). */
export type WebSessionRejection =
  | { readonly code: 'invalid-tenant-id'; readonly received: string }
  | { readonly code: 'invalid-project-id'; readonly received: string }
  | { readonly code: 'invalid-actor'; readonly received: string };

/**
 * Create the shell session (total, fail-closed): every identity is parsed
 * through the canonical contracts grammars; a malformed identity is a typed
 * rejection, never a silent default and never a throw.
 */
export function createWebSession(input: WebSessionInput): Result<WebSession, WebSessionRejection> {
  if (!isTenantId(input.tenantId)) {
    return fail({ code: 'invalid-tenant-id', received: input.tenantId });
  }
  if (!isProjectId(input.projectId)) {
    return fail({ code: 'invalid-project-id', received: input.projectId });
  }
  if (!isEntityId(input.actorId)) {
    return fail({ code: 'invalid-actor', received: input.actorId });
  }
  const tenantId = parseTenantId(input.tenantId);
  if (!tenantId.ok) return fail({ code: 'invalid-tenant-id', received: input.tenantId });
  const projectId = parseProjectId(input.projectId);
  if (!projectId.ok) return fail({ code: 'invalid-project-id', received: input.projectId });
  const actor = parseActor({ kind: 'user', actorId: input.actorId });
  if (!actor.ok) return fail({ code: 'invalid-actor', received: input.actorId });
  if (actor.value.kind === 'system') {
    // Unreachable by construction (parsed as kind 'user'); keeps the session's
    // actor type honestly narrowed to the identified actor.
    return fail({ code: 'invalid-actor', received: input.actorId });
  }
  const scope = parseScope({
    kind: 'project',
    tenantId: tenantId.value,
    projectId: projectId.value,
  });
  if (!scope.ok) return fail({ code: 'invalid-project-id', received: input.projectId });
  return ok({
    kind: 'web-session',
    tenantId: tenantId.value,
    projectId: projectId.value,
    scope: scope.value as ProjectScope,
    actor: actor.value,
    policy: sessionOperatorPolicy(),
    capabilities: [...SESSION_OPERATOR_CAPABILITIES],
  });
}

/** The session's authorization context (the shape every read surface takes). */
export const sessionContextOf = (session: WebSession) =>
  authorizationContext({
    actor: session.actor,
    scope: session.scope,
    capabilities: session.capabilities as readonly string[],
  });

// ---------------------------------------------------------------------------
// The session-scoped identity helpers the shell's surfaces share.
// ---------------------------------------------------------------------------

/** Parse an acting user's canonical entity id (total, fail-closed). */
export const sessionActorIdOf = (input: string): Result<EntityId, WebSessionRejection> => {
  const actorId = parseEntityId(input);
  if (!actorId.ok) return fail({ code: 'invalid-actor', received: input });
  return ok(actorId.value);
};

/**
 * Compose ONE canonical EntityRef from a trusted entity-kind literal and an
 * already-validated canonical id — the trusted path every shell surface
 * builds its typed command targets with (a wiring error here is a LOUD
 * TypeError, never a silent fallback).
 */
export const entityRefOf = (entityKind: string, entityId: EntityId): EntityRef => {
  const ref = parseEntityRef({ entityKind, entityId });
  if (!ref.ok) {
    throw new TypeError(
      `shell wiring error (entity ref '${entityKind}'): ${JSON.stringify(ref.error)}`,
    );
  }
  return ref.value;
};

/**
 * Structural A12 gate for view-model resolution: does the session's scope
 * cover the addressed resource scope? Pure — used by the shell's surfaces as
 * the FIRST check so a foreign tenant's or foreign project's row is never
 * even projected (the domain surfaces below re-check anyway; defense in
 * depth).
 */
export const sessionCoversScope = (
  session: WebSession,
  resourceScope: Pick<ResourceScope['scope'], 'tenantId' | 'kind'> & {
    projectId?: unknown;
  },
): boolean => {
  if (resourceScope.tenantId !== session.tenantId) return false;
  if (resourceScope.kind !== 'project') return true;
  return resourceScope.projectId === session.projectId;
};

// The typed Result pair this module's fail-closed parser returns (the
// kernel's Result is reused by every other module; this tiny local pair
// keeps the session's typed rejections displayable without error objects).
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });
