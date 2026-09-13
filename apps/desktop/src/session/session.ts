// Office desktop client protocol/reference shell — the desktop session (OFF-032).
//
// ONE typed desktop-session record (tenant, project, acting desktop user)
// that EVERY surface of the desktop shell resolves through (freeze A12: ONE
// project state, all clients share it — the desktop is a CLIENT of the same
// protocol, a VIEW of that state, never a second source of truth). The
// session is pure typed data: the tenant/project scope, the acting user, the
// deny-by-default policy, and the capabilities granted for the session. It
// never touches a store, never constructs a gateway, and performs no I/O.
//
// Cross-tenant/cross-project access is NOT decided here — the session is an
// identity, not an oracle: every surface resolves it against the seeded
// world's public read surfaces (and the sync engine's own session-scope
// gate), where a foreign tenant's row is a typed not-found and a
// same-tenant/foreign-project row is a typed unauthorized (freeze A12, both
// directions, no existence oracle).
//
// Mirrors the landed @office/web and @office/field-client session discipline
// (the structural templates — mirrored, never imported: apps do not import apps).
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
 * The capability set the desktop shell's standard desktop operator holds:
 * the slice-read capability (the A9 subscription's read gate + the project
 * reads), the organization read (the workspace header), and the schedule +
 * cost domain read/write pairs (the workspace's schedule/cost sections and
 * the shell's typed command surface). The closed vocabulary is @office/authz's;
 * every name below is declared there.
 */
export const SESSION_DESKTOP_CAPABILITIES: readonly Capability[] = [
  capability('projects.read'),
  capability('organization.read'),
  capability('schedule.read'),
  capability('schedule.write'),
  capability('cost.read'),
  capability('cost.write'),
];

/**
 * The session's static, data-driven deny-by-default policy: one allow rule
 * per granted capability pair, reads and writes both. Explicit denials still
 * win and a missing rule still denies (the evaluator's contract, not a
 * bypass).
 */
export const desktopSessionPolicy = (): Policy =>
  definePolicy([
    { effect: 'allow', capabilities: ['projects.read'], actions: ['read'] },
    { effect: 'allow', capabilities: ['organization.read'], actions: ['read'] },
    { effect: 'allow', capabilities: ['schedule.read', 'schedule.write'], actions: ['read', 'write'] },
    { effect: 'allow', capabilities: ['cost.read', 'cost.write'], actions: ['read', 'write'] },
  ]);

/** The fail-closed session input (raw strings — parsed here, never trusted). */
export interface DesktopSessionInput {
  /** The tenant the desktop user operates in (canonical TenantId grammar). */
  readonly tenantId: string;
  /** THE project the desktop user operates on (canonical ProjectId grammar). */
  readonly projectId: string;
  /** The acting desktop user's canonical entity id. */
  readonly actorId: string;
}

/** The typed desktop session every surface resolves through. */
export interface DesktopSession {
  readonly kind: 'desktop-session';
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  /** The ONE project state this session views (freeze A12). */
  readonly scope: ProjectScope;
  /** The acting desktop user (provenance on every command this session issues). */
  readonly actor: IdentifiedActor;
  /** The session's deny-by-default policy. */
  readonly policy: Policy;
  /** The capabilities granted to the actor for this session. */
  readonly capabilities: readonly Capability[];
}

/** Why a session input was rejected (displayable, typed — never a throw). */
export type DesktopSessionRejection =
  | { readonly code: 'invalid-tenant-id'; readonly received: string }
  | { readonly code: 'invalid-project-id'; readonly received: string }
  | { readonly code: 'invalid-actor'; readonly received: string };

/**
 * Create the desktop session (total, fail-closed): every identity is parsed
 * through the canonical contracts grammars; a malformed identity is a typed
 * rejection, never a silent default and never a throw.
 */
export function createDesktopSession(
  input: DesktopSessionInput,
): Result<DesktopSession, DesktopSessionRejection> {
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
    kind: 'desktop-session',
    tenantId: tenantId.value,
    projectId: projectId.value,
    scope: scope.value as ProjectScope,
    actor: actor.value,
    policy: desktopSessionPolicy(),
    capabilities: [...SESSION_DESKTOP_CAPABILITIES],
  });
}

/** The session's authorization context (the shape every read surface takes). */
export const sessionContextOf = (session: DesktopSession) =>
  authorizationContext({
    actor: session.actor,
    scope: session.scope,
    capabilities: session.capabilities as readonly string[],
  });

// ---------------------------------------------------------------------------
// The session-scoped identity helpers the desktop shell's surfaces share.
// ---------------------------------------------------------------------------

/** Parse an acting desktop user's canonical entity id (total, fail-closed). */
export const sessionActorIdOf = (input: string): Result<EntityId, DesktopSessionRejection> => {
  const actorId = parseEntityId(input);
  if (!actorId.ok) return fail({ code: 'invalid-actor', received: input });
  return ok(actorId.value);
};

/**
 * Compose ONE canonical EntityRef from a trusted entity-kind literal (one of
 * the shared domain packages' exported kind constants) and an
 * already-validated canonical id — the trusted path every desktop surface
 * builds its typed command targets with (a wiring error here is a LOUD
 * TypeError, never a silent fallback; the entity-kind vocabulary itself
 * always arrives from the shared domain packages, never a local string).
 */
export const entityRefOf = (entityKind: string, entityId: EntityId): EntityRef => {
  const ref = parseEntityRef({ entityKind, entityId });
  if (!ref.ok) {
    throw new TypeError(
      `desktop shell wiring error (entity ref '${entityKind}'): ${JSON.stringify(ref.error)}`,
    );
  }
  return ref.value;
};

/**
 * Structural A12 gate for view-model resolution: does the session's scope
 * cover the addressed resource scope? Pure — used by the desktop shell's
 * surfaces as the FIRST check so a foreign tenant's or foreign project's
 * row is never even projected (the domain surfaces below re-check anyway;
 * defense in depth).
 */
export const sessionCoversScope = (
  session: DesktopSession,
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
