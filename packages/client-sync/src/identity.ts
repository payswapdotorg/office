// Office client-sync — offline operation identity (OFF-029, freeze A9).
//
// THE deterministic offline operation id rule: a mutation captured while
// disconnected carries a CLIENT-GENERATED id composed deterministically from
// the capturing client's canonical id, the client's LOCAL sequence number
// (the queue position the capture took), and the command's canonical
// FINGERPRINT — sha256 over `client|sequence|fingerprint`, rendered in the
// @office/sync OperationId grammar (office-op-v1-<opaque>).
//
// Determinism properties (the acceptance surface):
// - same client + same local sequence + same command → the SAME id (an
//   idempotent re-derivation, e.g. a queue rebuild, never mints a second
//   identity for one logical mutation);
// - a different payload (or command name/scope/actor) → a different
//   fingerprint → a DIFFERENT id (a genuinely new mutation);
// - a different client or a different local sequence → a different id.
//
// The command fingerprint mirrors the domain kernel's commandFingerprint
// identity rule byte-for-byte (commandName, schemaVersion, scope, actor,
// payload as canonical JSON with recursively sorted keys) — that function
// takes a whole CommandEnvelope, while the offline id must be derived
// BEFORE the envelope exists (the envelope's idempotency key IS the derived
// id), so this module composes the same logical identity from parts.
import { createHash } from 'node:crypto';
import { parseFail, parseOk } from '@office/contracts';
import type {
  Actor,
  CommandName,
  EntityId,
  ParseResult,
  ProjectScope,
  SchemaVersion,
} from '@office/contracts';
import type { CommandFingerprint } from '@office/domain-kernel';
import { formatOperationId } from '@office/sync';
import type { OperationId } from '@office/sync';
import { describeValue } from './parse';

declare const localSequenceBrand: unique symbol;

/**
 * The client's local capture sequence: dense, 1-based, one per queue entry
 * (the queue assigns it; the drain replays in this order).
 */
export type LocalSequence = number & { readonly [localSequenceBrand]: 'LocalSequence' };

/** Grammar description used in parse failures. */
export const LOCAL_SEQUENCE_GRAMMAR =
  'integer local sequence in 1..9007199254740991 (dense 1-based queue order)';

/** The upper bound of local sequences (Number.MAX_SAFE_INTEGER). */
export const MAX_LOCAL_SEQUENCE = Number.MAX_SAFE_INTEGER;

/** Parse an untrusted value as a LocalSequence (total, fail-closed). */
export function parseLocalSequence(raw: unknown): ParseResult<LocalSequence> {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > MAX_LOCAL_SEQUENCE
  ) {
    return parseFail('invalid-value', '', LOCAL_SEQUENCE_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as LocalSequence);
}

/** Type guard for structurally valid LocalSequence values. */
export function isLocalSequence(raw: unknown): raw is LocalSequence {
  return parseLocalSequence(raw).ok;
}

/** The logical key an offline operation id is derived from. */
export interface OfflineOperationKey {
  /** The capturing client's canonical identity. */
  readonly clientId: EntityId;
  /** The capture's local sequence position in the client's queue. */
  readonly localSequence: LocalSequence;
  /** The captured command's canonical fingerprint (see offlineCommandFingerprint). */
  readonly fingerprint: CommandFingerprint;
}

/**
 * Derive the offline operation id of an operation key (deterministic, pure):
 * sha256 over `client|sequence|fingerprint`, rendered as an @office/sync
 * OperationId. This is the A9 offline-deterministic-id rule — the same
 * logical capture always derives the same id, so a replayed queue drain
 * after a partial failure is idempotent BY OPERATION ID (the id also becomes
 * the replayed command's idempotency key: freeze A8 — replays never
 * duplicate effects).
 */
export function offlineOperationIdOf(key: OfflineOperationKey): OperationId {
  return formatOperationId(
    `office-op-v1-${createHash('sha256')
      .update(
        [key.clientId, String(key.localSequence), key.fingerprint].join('|'),
        'utf8',
      )
      .digest('hex')
      .slice(0, 32)}`,
  );
}

/** The command parts an offline fingerprint is composed from. */
export interface OfflineCommandIdentity {
  readonly commandName: CommandName;
  readonly schemaVersion: SchemaVersion;
  readonly scope: ProjectScope;
  readonly actor: Actor;
  readonly payload: Record<string, unknown>;
}

/**
 * Canonical JSON: object keys sorted recursively, arrays in order, JSON
 * scalars verbatim — the same rule as the domain kernel's command
 * fingerprints and @office/sync's operation digests. Throws TypeError for
 * values JSON cannot represent: a loud programming error, never a silent
 * fingerprint collision.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON cannot serialize non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalJson(item)))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot serialize ${typeof value}`);
};

/**
 * Compose the canonical fingerprint of an offline command's LOGICAL identity
 * (deterministic, pure): canonical JSON of commandName, schemaVersion,
 * scope, actor, and payload — the domain kernel's commandFingerprint rule
 * (retry metadata — issuedAt, causality, the idempotency key itself — is
 * deliberately excluded, so an honest client retry of the same logical
 * command fingerprints identically).
 */
export function offlineCommandFingerprint(
  identity: OfflineCommandIdentity,
): CommandFingerprint {
  return canonicalJson({
    commandName: identity.commandName,
    schemaVersion: identity.schemaVersion,
    scope: identity.scope,
    actor: identity.actor,
    payload: identity.payload,
  }) as CommandFingerprint;
}
