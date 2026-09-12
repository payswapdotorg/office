// Office canonical contracts — commands (OFF-002).
//
// CommandEnvelope: the typed, tenant-scoped, idempotent command carrier
// every Office module and every external actor (agents, apps, adapters,
// offline clients) uses to request a domain mutation (freeze A8/A11).
//
// Idempotency rule (freeze A8 / ADR-005): EVERY command carries an
// idempotency key; replays of the same command must not duplicate financial
// or contractual effects. The envelope carries and validates the key —
// deduplication itself is enforced by the domain kernel and action gateway
// (OFF-003, OFF-017), never here.
//
// Commands are pure requests: validation, policy, and execution semantics
// live downstream (cross-view mutation flow, ARCHITECTURE_FREEZE.md).
import {
  describeValue,
  isPlainObject,
  parseFail,
  parseOk,
  parseStringLike,
  requireFieldWith,
  requireLiteral,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import type { ParseResult } from './parse';
import { parseScope } from './scope';
import type { Scope } from './scope';
import { parseActor } from './actor';
import type { Actor } from './actor';
import { parseTimestamp } from './time';
import type { Timestamp } from './time';
import { parseSchemaVersion } from './version';
import type { SchemaVersion } from './version';
import { parseCausality } from './events';
import type { Causality } from './events';

declare const commandNameBrand: unique symbol;
declare const idempotencyKeyBrand: unique symbol;

/** Canonical command name, e.g. 'projects.createProject'. */
export type CommandName = string & { readonly [commandNameBrand]: 'CommandName' };
/** Client-issued idempotency key (A8/ADR-005): replays must not duplicate effects. */
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: 'IdempotencyKey' };

/** Grammar description used in parse failures. */
export const COMMAND_NAME_GRAMMAR =
  "2..6 dot-separated segments, each starting lowercase then alphanumeric, e.g. 'projects.createProject'";

/** Grammar description used in parse failures. */
export const IDEMPOTENCY_KEY_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

const COMMAND_NAME_RULE: StringRule = {
  min: 3,
  max: 200,
  pattern: /^[a-z][a-zA-Z0-9]{0,31}(\.[a-z][a-zA-Z0-9]{0,31}){1,5}$/,
  description: COMMAND_NAME_GRAMMAR,
};

const IDEMPOTENCY_KEY_RULE: StringRule = {
  min: 8,
  max: 128,
  pattern: /^[\x21-\x7e]{8,128}$/,
  description: IDEMPOTENCY_KEY_GRAMMAR,
};

/** Parse an untrusted value as a CommandName (total, fail-closed). */
export function parseCommandName(raw: unknown): ParseResult<CommandName> {
  const result = parseStringLike(raw, COMMAND_NAME_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as CommandName);
}

/** Type guard for structurally valid CommandName values. */
export function isCommandName(raw: unknown): raw is CommandName {
  return parseCommandName(raw).ok;
}

/** Parse an untrusted value as an IdempotencyKey (total, fail-closed). */
export function parseIdempotencyKey(raw: unknown): ParseResult<IdempotencyKey> {
  const result = parseStringLike(raw, IDEMPOTENCY_KEY_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as IdempotencyKey);
}

/** Type guard for structurally valid IdempotencyKey values. */
export function isIdempotencyKey(raw: unknown): raw is IdempotencyKey {
  return parseIdempotencyKey(raw).ok;
}

/** Shape description used in parse failures. */
export const COMMAND_ENVELOPE_GRAMMAR =
  'CommandEnvelope: { kind, commandName, scope, actor, idempotencyKey, causality, issuedAt, schemaVersion, payload }';

const COMMAND_ENVELOPE_KEYS = [
  'kind',
  'commandName',
  'scope',
  'actor',
  'idempotencyKey',
  'causality',
  'issuedAt',
  'schemaVersion',
  'payload',
] as const;

/**
 * Typed command request envelope. The payload is domain-typed data;
 * contracts validate presence and object shape only — command semantics are
 * validated by the owning domain module (OFF-003+).
 */
export interface CommandEnvelope<P = unknown> {
  readonly kind: 'command';
  readonly commandName: CommandName;
  readonly scope: Scope;
  readonly actor: Actor;
  readonly idempotencyKey: IdempotencyKey;
  readonly causality: Causality;
  readonly issuedAt: Timestamp;
  readonly schemaVersion: SchemaVersion;
  readonly payload: P;
}

/**
 * Parse an untrusted value as a CommandEnvelope (total, fail-closed, strict
 * keys). The idempotency key is REQUIRED (A8/ADR-005): missing or malformed
 * keys fail closed. Unknown schema versions fail with code
 * 'unknown-schema-version'.
 */
export function parseCommandEnvelope(raw: unknown): ParseResult<CommandEnvelope> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', COMMAND_ENVELOPE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, COMMAND_ENVELOPE_KEYS, '', COMMAND_ENVELOPE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['command']);
  if (!kind.ok) return kind;
  const commandName = requireFieldWith(raw, 'commandName', '', parseCommandName);
  if (!commandName.ok) return commandName;
  const scope = requireFieldWith(raw, 'scope', '', parseScope);
  if (!scope.ok) return scope;
  const actor = requireFieldWith(raw, 'actor', '', parseActor);
  if (!actor.ok) return actor;
  const idempotencyKey = requireFieldWith(raw, 'idempotencyKey', '', parseIdempotencyKey);
  if (!idempotencyKey.ok) return idempotencyKey;
  const causality = requireFieldWith(raw, 'causality', '', parseCausality);
  if (!causality.ok) return causality;
  const issuedAt = requireFieldWith(raw, 'issuedAt', '', parseTimestamp);
  if (!issuedAt.ok) return issuedAt;
  const schemaVersion = requireFieldWith(raw, 'schemaVersion', '', parseSchemaVersion);
  if (!schemaVersion.ok) return schemaVersion;
  const payload = raw['payload'];
  if (payload === undefined) {
    return parseFail('missing-field', 'payload', 'a JSON object (domain-validated downstream)', 'undefined');
  }
  if (!isPlainObject(payload)) {
    return parseFail('invalid-type', 'payload', 'a JSON object (domain-validated downstream)', describeValue(payload));
  }
  return parseOk(
    {
      kind: 'command',
      commandName: commandName.value,
      scope: scope.value,
      actor: actor.value,
      idempotencyKey: idempotencyKey.value,
      causality: causality.value,
      issuedAt: issuedAt.value,
      schemaVersion: schemaVersion.value,
      payload,
    } satisfies CommandEnvelope,
  );
}

/** Type guard for structurally valid CommandEnvelope values. */
export function isCommandEnvelope(raw: unknown): raw is CommandEnvelope {
  return parseCommandEnvelope(raw).ok;
}
