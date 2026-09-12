// Office sync — package-internal test support (OFF-028).
//
// NOT part of the public surface: deterministic factories for the fixed
// tenants, projects, actors, instants, envelopes, policies, and
// authorization contexts the protocol's test suites need. Everything is a
// fixed constant — no Date.now, no Math.random, no environment — so every
// suite (and the run-twice determinism proofs) replays byte-identically.
import {
  CURRENT_SCHEMA_VERSION,
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseDomainEventEnvelope,
  parseEntityKind,
  parseEventName,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  DomainEventEnvelope,
  EntityId,
  EntityKind,
  EventName,
  ProjectId,
  ProjectScope,
  Scope,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { authorizationContext, definePolicy } from '@office/authz';
import type { AuthorizationContext, Policy } from '@office/authz';
import type { GrantVersion } from './grant';
import type { OperationKind } from './operations';
import type { SlicePosition } from './slice';

/** Unwrap a typed Result (failures are test bugs — loud, never silent). */
export const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

// ---- Fixed canonical identities (deterministic, opaque 32-hex parts). ----

export const TENANT_A: TenantId = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
export const TENANT_B: TenantId = formatTenantId({
  version: 'v1',
  opaque: 'f9e8d7c6b5a493827160504f3e2d1c0b',
});
export const PROJECT_1: ProjectId = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
export const PROJECT_2: ProjectId = formatProjectId({
  version: 'v1',
  opaque: '2b3c4d5e6f708192a3b4c5d6e7f8a9b',
});
export const CLIENT_A: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
export const CLIENT_B: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
export const ADMIN: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2',
});
export const FIELD_SUPERVISOR: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'd4e5f60718293a4b5c6d7e8f9a1b2c3',
});

export const ACTOR_A: Actor = { kind: 'user', actorId: CLIENT_A };
export const ACTOR_B: Actor = { kind: 'user', actorId: CLIENT_B };
export const ACTOR_ADMIN: Actor = { kind: 'user', actorId: ADMIN };
export const ACTOR_SYSTEM: Actor = { kind: 'system' };

// ---- Fixed instants (the injected clock of every suite). ----

export const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
export const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-12T10:16:00.000Z'));
export const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-12T11:00:00.000Z'));
export const NOW_4: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
export const NOW_5: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));

// ---- Fixed scopes. ----

export const SCOPE_1: ProjectScope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 };
export const SCOPE_2: ProjectScope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_2 };
export const SCOPE_TENANT_B: ProjectScope = { kind: 'project', tenantId: TENANT_B, projectId: PROJECT_1 };
export const SCOPE_TENANT_A_WIDE: Scope = { kind: 'tenant', tenantId: TENANT_A };

// ---- Deterministic kind/id factories (fail-closed self-checked). ----

/** A fixed canonical EntityKind (trusted path: the constant must parse). */
export const entityKindOf = (kind: string): EntityKind => unwrap(parseEntityKind(kind));

/** A fixed canonical EventName (trusted path: the constant must parse). */
export const eventNameOf = (name: string): EventName => unwrap(parseEventName(name));

/** A fixed canonical EntityId from a 32-hex opaque part. */
export const entityIdOf = (opaque: string): EntityId =>
  formatEntityId({ version: 'v1', opaque });

/** Trusted test cast: a hand-verified slice position constant. */
export const slicePositionOf = (n: number): SlicePosition => n as SlicePosition;

/** Trusted test cast: a hand-verified grant lifecycle version constant. */
export const grantVersionOf = (n: number): GrantVersion => n as GrantVersion;

/** Trusted test cast: a hand-verified kebab-case operation kind constant. */
export const operationKindOf = (kind: string): OperationKind => kind as OperationKind;

/**
 * Build one domain event envelope (fail-closed self-checked through
 * parseDomainEventEnvelope, exactly like the landed domain packages emit).
 */
export const eventEnvelope = (parts: {
  readonly eventName: string;
  readonly scope: Scope;
  readonly actor: Actor;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly payload?: Record<string, unknown>;
}): DomainEventEnvelope<Record<string, unknown>> =>
  unwrap(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName: unwrap(parseEventName(parts.eventName)),
      scope: parts.scope,
      actor: parts.actor,
      source: 'domain',
      causality: {
        correlationId: parts.correlationId,
        causationId: parts.causationId ?? null,
      },
      schemaVersion: CURRENT_SCHEMA_VERSION,
      occurredAt: parts.occurredAt,
      entityRefs: { before: null, after: null },
      payload: parts.payload ?? {},
    }),
    // The parse boundary guarantees a plain-object payload; the generic
    // parameter is narrowed on the trusted path exactly like the domain
    // packages' event emitters (see their events.ts).
  ) as DomainEventEnvelope<Record<string, unknown>>;

// ---- Fixed policies (the caller-supplied deny-by-default evaluators). ----

/** A policy that allows every read (the permissive baseline). */
export const allowReadsPolicy = (): Policy => definePolicy([{ effect: 'allow', actions: ['read'] }]);

/** A policy with no rules at all (deny-by-default: no allow rule). */
export const emptyPolicy = (): Policy => definePolicy([]);

/** A policy with an explicit read deny. */
export const denyReadsPolicy = (): Policy => definePolicy([{ effect: 'deny', actions: ['read'] }]);

/** A policy that allows reads only for one specific actor. */
export const actorScopedReadPolicy = (actorId: EntityId): Policy =>
  definePolicy([{ effect: 'allow', actorIds: [actorId], actions: ['read'] }]);

// ---- Fixed authorization contexts (WHO may subscribe). ----

/** A context holding exactly the slice read capability. */
export const readerContext = (actor: Actor, scope: Scope): AuthorizationContext =>
  authorizationContext({ actor, scope, capabilities: ['projects.read'] });

/** A context holding NO capability (fails the A9 layer-2 check). */
export const noCapabilityContext = (actor: Actor, scope: Scope): AuthorizationContext =>
  authorizationContext({ actor, scope, capabilities: ['organization.read'] });
