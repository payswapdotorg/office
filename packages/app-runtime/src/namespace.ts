// Office app-runtime — the per-installation app command/event namespace (OFF-026).
//
// THE typed namespacing of commands and events per installation: an
// installation registers its manifest's command bindings and event
// subscriptions under namespace entries that bind the (installation,
// command name) / (installation, event name) pair to the app identity —
// dispatch resolves bindings through these entries, and event fan-out
// resolves subscriptions by event name through them.
//
// Each entry carries a DERIVED, deterministic namespace identity (the same
// sha256 derivation convention the app-sdk permission ids use): the same
// (installation, command) or (installation, event) key always maps to the
// same identity, so registering the same key twice is a TYPED collision
// (the registry rejects it — never a silent override of one app binding by
// another). Two installations never collide: the installation id is part of
// the derivation key.
//
// Determinism: pure derivation, no clock, no randomness, no I/O beyond the
// node crypto digest.
import { createHash } from 'node:crypto';
import {
  parseCommandName,
  parseEntityId,
  parseEventName,
  parseFail,
  parseOk,
} from '@office/contracts';
import type { CommandName, EntityId, EventName, ParseResult } from '@office/contracts';
import { parseAppId, parseCommandBinding, parseEventSubscription } from '@office/app-sdk';
import type { AppId, CommandBinding, EventSubscription } from '@office/app-sdk';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  unknownKeyFailure,
} from './parse';

declare const appCommandNamespaceIdBrand: unique symbol;
declare const appEventNamespaceIdBrand: unique symbol;

/**
 * Namespaced app-command identity: office-ncmd-v1-<opaque> (derived from
 * the installation id + command name — deterministic).
 */
export type AppCommandNamespaceId = string & {
  readonly [appCommandNamespaceIdBrand]: 'AppCommandNamespaceId';
};

/**
 * Namespaced app-subscription identity: office-nsub-v1-<opaque> (derived
 * from the installation id + event name — deterministic).
 */
export type AppEventNamespaceId = string & {
  readonly [appEventNamespaceIdBrand]: 'AppEventNamespaceId';
};

/** Grammar description used in parse failures. */
export const APP_COMMAND_NAMESPACE_GRAMMAR =
  "AppCommandNamespaceEntry: { kind: 'app-command-namespace', installationId, appId, commandName, binding } — binding.commandName must equal commandName";

/** Grammar description used in parse failures. */
export const APP_EVENT_NAMESPACE_GRAMMAR =
  "AppEventNamespaceEntry: { kind: 'app-event-namespace', installationId, appId, eventName, subscription } — subscription.eventName must equal eventName";

/** Grammar description used in parse failures. */
export const APP_COMMAND_NAMESPACE_ID_GRAMMAR =
  'office-ncmd-v1-<opaque: 16..64 lowercase alphanumeric> (derived from the installation id + command name)';

/** Grammar description used in parse failures. */
export const APP_EVENT_NAMESPACE_ID_GRAMMAR =
  'office-nsub-v1-<opaque: 16..64 lowercase alphanumeric> (derived from the installation id + event name)';

const APP_COMMAND_NAMESPACE_KEYS = ['kind', 'installationId', 'appId', 'commandName', 'binding'] as const;
const APP_EVENT_NAMESPACE_KEYS = ['kind', 'installationId', 'appId', 'eventName', 'subscription'] as const;

const COMMAND_ID_PREFIX = 'office-ncmd-v1-';
const EVENT_ID_PREFIX = 'office-nsub-v1-';
const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;
const DERIVED_OPAQUE_LENGTH = 32;

/** The sha256-derived opaque part of a namespace identity. */
const derivedOpaque = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, DERIVED_OPAQUE_LENGTH);

/**
 * One command binding registered under an installation's namespace: the
 * typed record that binds (installation, command name) to the app identity
 * and the binding the runtime dispatches through.
 */
export interface AppCommandNamespaceEntry {
  readonly kind: 'app-command-namespace';
  /** The installation whose namespace this entry belongs to. */
  readonly installationId: EntityId;
  /** The installed app (the binding's owner). */
  readonly appId: AppId;
  /** The namespaced command name (must equal binding.commandName). */
  readonly commandName: CommandName;
  /** The manifest's command binding being registered. */
  readonly binding: CommandBinding;
}

/**
 * One event subscription registered under an installation's namespace: the
 * typed record event fan-out resolves by event name.
 */
export interface AppEventNamespaceEntry {
  readonly kind: 'app-event-namespace';
  /** The installation whose namespace this entry belongs to. */
  readonly installationId: EntityId;
  /** The installed app (the subscription's owner). */
  readonly appId: AppId;
  /** The namespaced event name (must equal subscription.eventName). */
  readonly eventName: EventName;
  /** The manifest's event subscription being registered. */
  readonly subscription: EventSubscription;
}

/**
 * Parse an untrusted value as an AppCommandNamespaceEntry (total,
 * fail-closed, strict keys). Cross-field consistency is enforced: the
 * binding's command name MUST equal the entry's commandName (a namespace
 * entry never aliases one command to another).
 */
export function parseAppCommandNamespaceEntry(
  raw: unknown,
): ParseResult<AppCommandNamespaceEntry> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APP_COMMAND_NAMESPACE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    APP_COMMAND_NAMESPACE_KEYS,
    '',
    APP_COMMAND_NAMESPACE_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-command-namespace']);
  if (!kind.ok) return kind;
  const installationId = requireFieldWith(raw, 'installationId', '', parseEntityId);
  if (!installationId.ok) return installationId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const commandName = requireFieldWith(raw, 'commandName', '', parseCommandName);
  if (!commandName.ok) return commandName;
  const binding = requireFieldWith(raw, 'binding', '', parseCommandBinding);
  if (!binding.ok) return binding;
  if (binding.value.commandName !== commandName.value) {
    return parseFail(
      'invalid-value',
      'binding.commandName',
      'the binding\'s command name must equal the entry\'s commandName (a namespace entry never aliases one command to another)',
      `entry '${commandName.value}', binding '${binding.value.commandName}'`,
    );
  }
  return parseOk(
    {
      kind: 'app-command-namespace',
      installationId: installationId.value,
      appId: appId.value,
      commandName: commandName.value,
      binding: binding.value,
    } satisfies AppCommandNamespaceEntry,
  );
}

/** Type guard for structurally valid AppCommandNamespaceEntry values. */
export function isAppCommandNamespaceEntry(raw: unknown): raw is AppCommandNamespaceEntry {
  return parseAppCommandNamespaceEntry(raw).ok;
}

/**
 * Parse an untrusted value as an AppEventNamespaceEntry (total, fail-closed,
 * strict keys). Cross-field consistency is enforced: the subscription's
 * event name MUST equal the entry's event name.
 */
export function parseAppEventNamespaceEntry(raw: unknown): ParseResult<AppEventNamespaceEntry> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APP_EVENT_NAMESPACE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APP_EVENT_NAMESPACE_KEYS, '', APP_EVENT_NAMESPACE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-event-namespace']);
  if (!kind.ok) return kind;
  const installationId = requireFieldWith(raw, 'installationId', '', parseEntityId);
  if (!installationId.ok) return installationId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const eventName = requireFieldWith(raw, 'eventName', '', parseEventName);
  if (!eventName.ok) return eventName;
  const subscription = requireFieldWith(raw, 'subscription', '', parseEventSubscription);
  if (!subscription.ok) return subscription;
  if (subscription.value.eventName !== eventName.value) {
    return parseFail(
      'invalid-value',
      'subscription.eventName',
      'the subscription\'s event name must equal the entry\'s eventName (a namespace entry never aliases one event to another)',
      `entry '${eventName.value}', subscription '${subscription.value.eventName}'`,
    );
  }
  return parseOk(
    {
      kind: 'app-event-namespace',
      installationId: installationId.value,
      appId: appId.value,
      eventName: eventName.value,
      subscription: subscription.value,
    } satisfies AppEventNamespaceEntry,
  );
}

/** Type guard for structurally valid AppEventNamespaceEntry values. */
export function isAppEventNamespaceEntry(raw: unknown): raw is AppEventNamespaceEntry {
  return parseAppEventNamespaceEntry(raw).ok;
}

/** Parse an untrusted value as an AppCommandNamespaceId (total, fail-closed). */
export function parseAppCommandNamespaceId(raw: unknown): ParseResult<AppCommandNamespaceId> {
  if (typeof raw !== 'string' || !raw.startsWith(COMMAND_ID_PREFIX)) {
    return parseFail('invalid-value', '', APP_COMMAND_NAMESPACE_ID_GRAMMAR, describeValue(raw));
  }
  const opaque = raw.slice(COMMAND_ID_PREFIX.length);
  if (!OPAQUE_PATTERN.test(opaque)) {
    return parseFail('invalid-value', '', APP_COMMAND_NAMESPACE_ID_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as AppCommandNamespaceId);
}

/** Type guard for structurally valid AppCommandNamespaceId values. */
export function isAppCommandNamespaceId(raw: unknown): raw is AppCommandNamespaceId {
  return parseAppCommandNamespaceId(raw).ok;
}

/** Parse an untrusted value as an AppEventNamespaceId (total, fail-closed). */
export function parseAppEventNamespaceId(raw: unknown): ParseResult<AppEventNamespaceId> {
  if (typeof raw !== 'string' || !raw.startsWith(EVENT_ID_PREFIX)) {
    return parseFail('invalid-value', '', APP_EVENT_NAMESPACE_ID_GRAMMAR, describeValue(raw));
  }
  const opaque = raw.slice(EVENT_ID_PREFIX.length);
  if (!OPAQUE_PATTERN.test(opaque)) {
    return parseFail('invalid-value', '', APP_EVENT_NAMESPACE_ID_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as AppEventNamespaceId);
}

/** Type guard for structurally valid AppEventNamespaceId values. */
export function isAppEventNamespaceId(raw: unknown): raw is AppEventNamespaceId {
  return parseAppEventNamespaceId(raw).ok;
}

/** Compose an AppCommandNamespaceId (trusted path; loud TypeError). */
export function formatAppCommandNamespaceId(raw: string): AppCommandNamespaceId {
  const parsed = parseAppCommandNamespaceId(raw);
  if (!parsed.ok) throw new TypeError(`invalid app command namespace id: ${describeValue(raw)}`);
  return parsed.value;
}

/** Compose an AppEventNamespaceId (trusted path; loud TypeError). */
export function formatAppEventNamespaceId(raw: string): AppEventNamespaceId {
  const parsed = parseAppEventNamespaceId(raw);
  if (!parsed.ok) throw new TypeError(`invalid app event namespace id: ${describeValue(raw)}`);
  return parsed.value;
}

/** Derive the deterministic command namespace id of (installation, command). */
export function appCommandNamespaceIdOf(key: {
  readonly installationId: EntityId;
  readonly commandName: CommandName;
}): AppCommandNamespaceId {
  return formatAppCommandNamespaceId(
    `${COMMAND_ID_PREFIX}${derivedOpaque('app-command', key.installationId, key.commandName)}`,
  );
}

/** Derive the deterministic event namespace id of (installation, event). */
export function appEventNamespaceIdOf(key: {
  readonly installationId: EntityId;
  readonly eventName: EventName;
}): AppEventNamespaceId {
  return formatAppEventNamespaceId(
    `${EVENT_ID_PREFIX}${derivedOpaque('app-event', key.installationId, key.eventName)}`,
  );
}

/** The derived namespace identities of an entry (pure projection). */
export const namespaceIdOf = (
  entry: AppCommandNamespaceEntry | AppEventNamespaceEntry,
): AppCommandNamespaceId | AppEventNamespaceId =>
  entry.kind === 'app-command-namespace'
    ? appCommandNamespaceIdOf(entry)
    : appEventNamespaceIdOf(entry);
