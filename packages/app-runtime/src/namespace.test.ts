// OFF-026 app-runtime — the per-installation app command/event namespace suite.
//
// THE typed namespacing: (installation, command) and (installation, event)
// keys map to DERIVED deterministic namespace identities — the same key
// always derives the same id, two installations never collide, and
// registering the same key twice is a TYPED collision (never a silent
// override of one app binding by another). Fail-closed parse over the
// entries (strict keys, cross-field consistency: the binding's command name
// must equal the entry's, the subscription's event name must equal the
// entry's) and the namespace-id grammar.
import { describe, expect, it } from 'vitest';
import { parseCommandBinding, parseEventSubscription } from '@office/app-sdk';
import type { AppId, CommandBinding, EventSubscription } from '@office/app-sdk';
import { parseCommandName, parseEventName } from '@office/contracts';
import type { CommandName, EventName } from '@office/contracts';
import {
  appCommandNamespaceIdOf,
  appEventNamespaceIdOf,
  formatAppCommandNamespaceId,
  formatAppEventNamespaceId,
  isAppCommandNamespaceEntry,
  isAppCommandNamespaceId,
  isAppEventNamespaceEntry,
  isAppEventNamespaceId,
  namespaceIdOf,
  parseAppCommandNamespaceEntry,
  parseAppCommandNamespaceId,
  parseAppEventNamespaceEntry,
  parseAppEventNamespaceId,
} from './namespace';
import type { AppCommandNamespaceEntry, AppEventNamespaceEntry } from './namespace';
import { createInMemoryAppRuntimeStore } from './registry';
import { INSTALLATION, INSTALLATION_B, SAMPLE_MANIFEST, expectFail, unwrap } from './test-support';

const commandNameOf = (name: string): CommandName => unwrap(parseCommandName(name));
const eventNameOf = (name: string): EventName => unwrap(parseEventName(name));

const bindingOf = (commandName: string): CommandBinding =>
  unwrap(
    parseCommandBinding({
      kind: 'command-binding',
      commandName,
      handler: {
        kind: 'app-handler',
        handlerId: 'record-progress-handler',
        title: 'Record progress',
        description: null,
      },
      actionClass: 'reversible',
    }),
  );

const subscriptionOf = (eventName: string): EventSubscription =>
  unwrap(
    parseEventSubscription({
      kind: 'event-subscription',
      eventName,
      filter: { kind: 'entity-kind', entityKind: 'field-report' },
    }),
  );

const commandEntry = (
  installationId: typeof INSTALLATION = INSTALLATION,
  commandName = 'field.recordProgress',
): AppCommandNamespaceEntry => ({
  kind: 'app-command-namespace',
  installationId,
  appId: SAMPLE_MANIFEST.appId,
  commandName: commandNameOf(commandName),
  binding: bindingOf(commandName),
});

const eventEntry = (
  installationId: typeof INSTALLATION = INSTALLATION,
  eventName = 'work.progressRecorded',
): AppEventNamespaceEntry => ({
  kind: 'app-event-namespace',
  installationId,
  appId: SAMPLE_MANIFEST.appId,
  eventName: eventNameOf(eventName),
  subscription: subscriptionOf(eventName),
});

describe('the derived namespace identities (deterministic, installation-scoped)', () => {
  it('derives the same id for the same (installation, command) key — always', () => {
    const first = appCommandNamespaceIdOf({
      installationId: INSTALLATION,
      commandName: commandNameOf('field.recordProgress'),
    });
    const again = appCommandNamespaceIdOf({
      installationId: INSTALLATION,
      commandName: commandNameOf('field.recordProgress'),
    });
    expect(first).toBe(again);
    expect(first.startsWith('office-ncmd-v1-')).toBe(true);
    expect(isAppCommandNamespaceId(first)).toBe(true);
    expect(parseAppCommandNamespaceId(first).ok).toBe(true);
  });

  it('derives the same id for the same (installation, event) key — always', () => {
    const first = appEventNamespaceIdOf({
      installationId: INSTALLATION,
      eventName: eventNameOf('work.progressRecorded'),
    });
    expect(first).toBe(
      appEventNamespaceIdOf({ installationId: INSTALLATION, eventName: eventNameOf('work.progressRecorded') }),
    );
    expect(first.startsWith('office-nsub-v1-')).toBe(true);
    expect(isAppEventNamespaceId(first)).toBe(true);
    expect(parseAppEventNamespaceId(first).ok).toBe(true);
  });

  it('separates installations, commands, and events (no cross-key collisions)', () => {
    const a = appCommandNamespaceIdOf({
      installationId: INSTALLATION,
      commandName: commandNameOf('field.recordProgress'),
    });
    const b = appCommandNamespaceIdOf({
      installationId: INSTALLATION_B,
      commandName: commandNameOf('field.recordProgress'),
    });
    const otherCommand = appCommandNamespaceIdOf({
      installationId: INSTALLATION,
      commandName: commandNameOf('cost.listCostItems'),
    });
    const event = appEventNamespaceIdOf({
      installationId: INSTALLATION,
      eventName: eventNameOf('work.progressRecorded'),
    });
    expect(new Set([a, b, otherCommand, event]).size).toBe(4);
    // Two installations registering the SAME command name stay distinct —
    // the installation id is part of the derivation key.
    expect(a).not.toBe(b);
  });

  it('projects the derived identity of an entry (namespaceIdOf)', () => {
    expect(namespaceIdOf(commandEntry())).toBe(
      appCommandNamespaceIdOf({
        installationId: INSTALLATION,
        commandName: commandNameOf('field.recordProgress'),
      }),
    );
    expect(namespaceIdOf(eventEntry())).toBe(
      appEventNamespaceIdOf({
        installationId: INSTALLATION,
        eventName: eventNameOf('work.progressRecorded'),
      }),
    );
  });
});

describe('namespace id parse (fail-closed)', () => {
  it('rejects wrong prefixes, bad opaque parts, and non-strings', () => {
    for (const raw of [
      'office-nsub-v1-0123456789abcdef0123456789abcdef',
      'office-ncmd-v1-SHORT',
      'office-ncmd-v1-UPPERCASE0123456789abcdef0123456',
      'office-ncmd-v1-',
      '',
      null,
      42,
    ]) {
      expect(parseAppCommandNamespaceId(raw).ok, String(raw)).toBe(false);
      expect(isAppCommandNamespaceId(raw), String(raw)).toBe(false);
    }
    for (const raw of ['office-ncmd-v1-0123456789abcdef0123456789abcdef', 'office-nsub-v1-x']) {
      expect(parseAppEventNamespaceId(raw).ok, String(raw)).toBe(false);
    }
  });

  it('accepts the full legal opaque length range', () => {
    const short = `office-ncmd-v1-${'a'.repeat(16)}`;
    const long = `office-nsub-v1-${'0'.repeat(64)}`;
    expect(parseAppCommandNamespaceId(short).ok).toBe(true);
    expect(parseAppEventNamespaceId(long).ok).toBe(true);
  });

  it('format builders validate loudly (trusted path TypeErrors)', () => {
    expect(formatAppCommandNamespaceId('office-ncmd-v1-0123456789abcdef')).toBe(
      'office-ncmd-v1-0123456789abcdef',
    );
    expect(formatAppEventNamespaceId('office-nsub-v1-0123456789abcdef')).toBe(
      'office-nsub-v1-0123456789abcdef',
    );
    expect(() => formatAppCommandNamespaceId('nope')).toThrow(TypeError);
    expect(() => formatAppEventNamespaceId('office-nsub-v1-!')).toThrow(TypeError);
  });
});

describe('namespace entry parse (fail-closed, strict keys, cross-field)', () => {
  it('round-trips valid command and event entries', () => {
    const command = commandEntry();
    const parsedCommand = parseAppCommandNamespaceEntry(command);
    expect(parsedCommand.ok).toBe(true);
    if (parsedCommand.ok) expect(parsedCommand.value).toStrictEqual(command);
    expect(isAppCommandNamespaceEntry(command)).toBe(true);

    const event = eventEntry();
    const parsedEvent = parseAppEventNamespaceEntry(event);
    expect(parsedEvent.ok).toBe(true);
    if (parsedEvent.ok) expect(parsedEvent.value).toStrictEqual(event);
    expect(isAppEventNamespaceEntry(event)).toBe(true);
  });

  it('rejects non-objects, wrong kinds, unknown keys, and malformed fields', () => {
    for (const raw of [null, 7, 'entry', []]) {
      expect(parseAppCommandNamespaceEntry(raw).ok).toBe(false);
      expect(parseAppEventNamespaceEntry(raw).ok).toBe(false);
    }
    expect(parseAppCommandNamespaceEntry({ ...commandEntry(), kind: 'command-namespace' }).ok).toBe(
      false,
    );
    const unknownKey = parseAppCommandNamespaceEntry({ ...commandEntry(), extra: 1 });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe('unknown-field');
    expect(parseAppEventNamespaceEntry({ ...eventEntry(), installationId: 'not-an-id' }).ok).toBe(
      false,
    );
    expect(parseAppEventNamespaceEntry({ ...eventEntry(), appId: 'NOT A SLUG' as AppId }).ok).toBe(
      false,
    );
  });

  it('rejects cross-field aliasing (binding.commandName / subscription.eventName mismatch)', () => {
    const aliasedCommand = parseAppCommandNamespaceEntry({
      ...commandEntry(),
      commandName: commandNameOf('cost.listCostItems'),
    });
    expect(aliasedCommand.ok).toBe(false);
    if (!aliasedCommand.ok) {
      expect(aliasedCommand.error.code).toBe('invalid-value');
      expect(aliasedCommand.error.path).toBe('binding.commandName');
    }
    const aliasedEvent = parseAppEventNamespaceEntry({
      ...eventEntry(),
      eventName: eventNameOf('work.somethingElse'),
    });
    expect(aliasedEvent.ok).toBe(false);
    if (!aliasedEvent.ok) expect(aliasedEvent.error.path).toBe('subscription.eventName');
  });
});

describe('THE registry: collisions are typed-rejected, never silently overridden', () => {
  it('typed-rejects registering the same (installation, command) key twice', () => {
    const store = createInMemoryAppRuntimeStore();
    const entry = commandEntry();
    expect(store.namespace.registerCommand(entry)).toStrictEqual({ ok: true, value: entry });
    const collision = expectFail(store.namespace.registerCommand(commandEntry()));
    expect(collision.code).toBe('concurrency-conflict');
    expect(collision.details[0]?.code).toBe('namespace-command-collision');
    // The original entry survives untouched.
    expect(store.namespace.findCommand(INSTALLATION, entry.commandName)).toStrictEqual(entry);
  });

  it('typed-rejects registering the same (installation, event) key twice', () => {
    const store = createInMemoryAppRuntimeStore();
    const entry = eventEntry();
    expect(store.namespace.registerEvent(entry)).toStrictEqual({ ok: true, value: entry });
    const collision = expectFail(store.namespace.registerEvent(eventEntry()));
    expect(collision.code).toBe('concurrency-conflict');
    expect(collision.details[0]?.code).toBe('namespace-event-collision');
    expect(store.namespace.findEvent(INSTALLATION, entry.eventName)).toStrictEqual(entry);
  });

  it('different installations register the same command/event names WITHOUT collision', () => {
    const store = createInMemoryAppRuntimeStore();
    expect(store.namespace.registerCommand(commandEntry(INSTALLATION)).ok).toBe(true);
    expect(store.namespace.registerCommand(commandEntry(INSTALLATION_B)).ok).toBe(true);
    expect(store.namespace.registerEvent(eventEntry(INSTALLATION)).ok).toBe(true);
    expect(store.namespace.registerEvent(eventEntry(INSTALLATION_B)).ok).toBe(true);
    expect(store.namespace.commandsOf(INSTALLATION)).toHaveLength(1);
    expect(store.namespace.commandsOf(INSTALLATION_B)).toHaveLength(1);
    expect(store.namespace.eventsOf(INSTALLATION)).toHaveLength(1);
    expect(store.namespace.eventsOf(INSTALLATION_B)).toHaveLength(1);
  });

  it('looks entries up by key and resolves the fan-out by event name', () => {
    const store = createInMemoryAppRuntimeStore();
    const a = commandEntry(INSTALLATION, 'field.recordProgress');
    const b = commandEntry(INSTALLATION, 'cost.listCostItems');
    const eventA = eventEntry(INSTALLATION);
    const eventB = eventEntry(INSTALLATION_B);
    expect(store.namespace.registerCommand(a).ok).toBe(true);
    expect(store.namespace.registerCommand(b).ok).toBe(true);
    expect(store.namespace.registerEvent(eventA).ok).toBe(true);
    expect(store.namespace.registerEvent(eventB).ok).toBe(true);
    expect(store.namespace.findCommand(INSTALLATION, a.commandName)).toStrictEqual(a);
    expect(store.namespace.findCommand(INSTALLATION, commandNameOf('field.unknownCommand'))).toBeNull();
    expect(store.namespace.findEvent(INSTALLATION_B, eventB.eventName)).toStrictEqual(eventB);
    // INSTALLATION did not subscribe to a different event name.
    expect(store.namespace.findEvent(INSTALLATION, eventNameOf('cost.costItemRecorded'))).toBeNull();
    // The fan-out lookup returns every installation subscribed to the name,
    // in registration order.
    expect(store.namespace.subscriptionsByEvent(eventA.eventName)).toStrictEqual([eventA, eventB]);
    expect(store.namespace.commandsOf(INSTALLATION)).toStrictEqual([a, b]);
  });

  it('the namespace is pure bookkeeping: plain JSON records, no canonical entities (A11)', () => {
    const store = createInMemoryAppRuntimeStore();
    const entry = commandEntry();
    expect(store.namespace.registerCommand(entry).ok).toBe(true);
    // The entry stays a plain JSON record; the store holds bindings and
    // subscriptions only — never project state.
    expect(JSON.parse(JSON.stringify(entry))).toStrictEqual(entry);
    expect(store.installations.installations()).toStrictEqual([]);
    expect(store.permissions.ofInstallation(INSTALLATION)).toStrictEqual([]);
  });
});
