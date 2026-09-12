// Office canonical contracts — actor (OFF-002).
//
// The actor is the provenance identity carried by every command and event
// envelope (freeze A3, ADR-005). Actor kinds are Office-canonical vocabulary:
// user (human), agent (AI agent run), app (marketplace app installation),
// adapter (external-system integration), system (platform background job).
// Provider identities never appear here — adapters own provider credentials
// and map them to canonical actors (A5, ADR-004).
import {
  describeValue,
  isPlainObject,
  parseFail,
  parseOk,
  requireFieldWith,
  unknownKeyFailure,
} from './parse';
import type { ParseResult } from './parse';
import { parseEntityId } from './identity';
import type { EntityId } from './identity';

/** Actor kinds that must carry a canonical actor id. */
export type IdentifiedActorKind = 'user' | 'agent' | 'app' | 'adapter';

/** An actor identified by a canonical EntityId (user/agent/app/adapter). */
export interface IdentifiedActor {
  readonly kind: IdentifiedActorKind;
  readonly actorId: EntityId;
}

/** A platform background job actor (no actor id by definition). */
export interface SystemActor {
  readonly kind: 'system';
}

/** Actor provenance of a command or event, discriminated on `kind`. */
export type Actor = IdentifiedActor | SystemActor;

/** All actor kinds. */
export type ActorKind = IdentifiedActorKind | 'system';

/** Shape description used in parse failures. */
export const ACTOR_GRAMMAR =
  "{ kind: 'user' | 'agent' | 'app' | 'adapter', actorId } | { kind: 'system' }";

const IDENTIFIED_ACTOR_KEYS = ['kind', 'actorId'] as const;
const SYSTEM_ACTOR_KEYS = ['kind'] as const;

/**
 * Parse an untrusted value as an Actor (total, fail-closed, strict keys).
 * Every non-system actor must carry a valid canonical EntityId; the system
 * actor must not carry any other field.
 */
export function parseActor(raw: unknown): ParseResult<Actor> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ACTOR_GRAMMAR, describeValue(raw));
  }
  const kind = raw['kind'];
  if (kind === undefined) {
    return parseFail('missing-field', 'kind', ACTOR_GRAMMAR, 'undefined');
  }
  if (kind === 'system') {
    const unknownKey = unknownKeyFailure(raw, SYSTEM_ACTOR_KEYS, '', ACTOR_GRAMMAR);
    if (unknownKey) return unknownKey;
    return parseOk({ kind: 'system' } satisfies SystemActor);
  }
  if (kind === 'user' || kind === 'agent' || kind === 'app' || kind === 'adapter') {
    const unknownKey = unknownKeyFailure(raw, IDENTIFIED_ACTOR_KEYS, '', ACTOR_GRAMMAR);
    if (unknownKey) return unknownKey;
    const actorId = requireFieldWith(raw, 'actorId', '', parseEntityId);
    if (!actorId.ok) return actorId;
    return parseOk({ kind, actorId: actorId.value } satisfies IdentifiedActor);
  }
  return parseFail('invalid-value', 'kind', ACTOR_GRAMMAR, describeValue(kind));
}

/** Type guard for structurally valid Actor values. */
export function isActor(raw: unknown): raw is Actor {
  return parseActor(raw).ok;
}
