// Office app-sdk — command bindings (OFF-025).
//
// A command binding is how a marketplace app OFFERS to serve a typed domain
// command: the canonical command name (validated against the OFF-017 action
// vocabulary by validation.ts — unknown commands and class mismatches are
// typed-rejected), the app's handler CONTRACT, and the action class the app
// requires the command to be.
//
// The handler contract is a stable SYMBOLIC id (AppHandlerId) plus
// human-readable metadata — the app runtime (OFF-026) resolves the id to
// the handler code installed with the app at execution time, BEHIND the
// action gateway. A manifest NEVER carries executable code, file paths, or
// network references (freeze A8: apps, like agents, never write canonical
// state directly — they act only through the gateway).
//
// The binding's declared action class must be one of the three executable
// classes ('read' | 'reversible' | 'approval-required'); binding a
// 'prohibited' action is rejected at parse time — prohibited commands are
// never executed for anyone, apps doubly so.
import { parseCommandName, parseFail, parseOk } from '@office/contracts';
import type { CommandName, ParseResult } from '@office/contracts';
import type { ActionClass } from '@office/actions';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireString,
  unknownKeyFailure,
} from './parse';
import { parseAppHandlerId } from './identity';
import type { AppHandlerId } from './identity';

/**
 * The action classes a binding may declare — the executable subset of the
 * freeze-A8 four-class vocabulary ('prohibited' is not bindable).
 */
export const BINDABLE_ACTION_CLASSES: readonly ActionClass[] = [
  'read',
  'reversible',
  'approval-required',
] as const;

/** Grammar description used in parse failures. */
export const COMMAND_BINDING_GRAMMAR =
  "CommandBinding: { kind: 'command-binding', commandName, handler, actionClass: 'read' | 'reversible' | 'approval-required' } — the class must match the action descriptor's class at validation time";

/** Grammar description used in parse failures. */
export const APP_HANDLER_GRAMMAR =
  "AppHandler: { kind: 'app-handler', handlerId, title, description? } — a symbolic handler contract, never code";

const COMMAND_BINDING_KEYS = ['kind', 'commandName', 'handler', 'actionClass'] as const;
const APP_HANDLER_KEYS = ['kind', 'handlerId', 'title', 'description'] as const;

const TITLE_RULE = { min: 1, max: 200, description: 'handler title' } as const;
const DESCRIPTION_RULE = { min: 1, max: 2000, description: 'handler description' } as const;

/**
 * The app's handler contract: a stable symbolic id the app runtime binds to
 * installed handler code at execution time. The manifest carries the
 * CONTRACT (id + documentation), never the code.
 */
export interface AppHandler {
  readonly kind: 'app-handler';
  /** Stable symbolic handler id (resolved by the app runtime, OFF-026). */
  readonly handlerId: AppHandlerId;
  /** Human-readable title (1..200 characters). */
  readonly title: string;
  /** Human-readable description, or null. */
  readonly description: string | null;
}

/** Parse an untrusted value as an AppHandler (total, fail-closed, strict keys). */
export function parseAppHandler(raw: unknown): ParseResult<AppHandler> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APP_HANDLER_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APP_HANDLER_KEYS, '', APP_HANDLER_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-handler']);
  if (!kind.ok) return kind;
  const handlerId = requireFieldWith(raw, 'handlerId', '', parseAppHandlerId);
  if (!handlerId.ok) return handlerId;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const description = raw['description'];
  if (description === undefined || description === null) {
    return parseOk(
      { kind: 'app-handler', handlerId: handlerId.value, title: title.value, description: null } satisfies AppHandler,
    );
  }
  if (typeof description !== 'string') {
    return parseFail('invalid-type', 'description', DESCRIPTION_RULE.description, describeValue(description));
  }
  if (description.length < DESCRIPTION_RULE.min || description.length > DESCRIPTION_RULE.max) {
    return parseFail('invalid-value', 'description', DESCRIPTION_RULE.description, `string of length ${description.length}`);
  }
  return parseOk(
    {
      kind: 'app-handler',
      handlerId: handlerId.value,
      title: title.value,
      description,
    } satisfies AppHandler,
  );
}

/** Type guard for structurally valid AppHandler values. */
export function isAppHandler(raw: unknown): raw is AppHandler {
  return parseAppHandler(raw).ok;
}

/**
 * One command binding of an app manifest: the typed domain command the app
 * offers to handle, its handler contract, and the required action class.
 * validation.ts checks the command against the real ActionDescriptor: the
 * command must be KNOWN and the declared class must MATCH the descriptor's.
 */
export interface CommandBinding {
  readonly kind: 'command-binding';
  /** The typed domain command this binding serves (must be a known action). */
  readonly commandName: CommandName;
  /** The app's handler contract for the command (symbolic — never code). */
  readonly handler: AppHandler;
  /** The required action class; must match the action descriptor's class. */
  readonly actionClass: Exclude<ActionClass, 'prohibited'>;
}

/**
 * Parse an untrusted value as a CommandBinding (total, fail-closed, strict
 * keys). 'prohibited' is rejected here: prohibited commands are never
 * executed for anyone — an app cannot bind one.
 */
export function parseCommandBinding(raw: unknown): ParseResult<CommandBinding> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', COMMAND_BINDING_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, COMMAND_BINDING_KEYS, '', COMMAND_BINDING_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['command-binding']);
  if (!kind.ok) return kind;
  const commandName = requireFieldWith(raw, 'commandName', '', parseCommandName);
  if (!commandName.ok) return commandName;
  const handler = requireFieldWith(raw, 'handler', '', parseAppHandler);
  if (!handler.ok) return handler;
  const actionClass = requireFieldWith(raw, 'actionClass', '', parseBindableActionClass);
  if (!actionClass.ok) return actionClass;
  return parseOk(
    {
      kind: 'command-binding',
      commandName: commandName.value,
      handler: handler.value,
      actionClass: actionClass.value,
    } satisfies CommandBinding,
  );
}

/** Type guard for structurally valid CommandBinding values. */
export function isCommandBinding(raw: unknown): raw is CommandBinding {
  return parseCommandBinding(raw).ok;
}

/** Parse a bindable action class (the executable subset; 'prohibited' fails). */
function parseBindableActionClass(raw: unknown): ParseResult<Exclude<ActionClass, 'prohibited'>> {
  const expected = "'read' | 'reversible' | 'approval-required' (an app cannot bind a prohibited action)";
  if (typeof raw !== 'string' || !(BINDABLE_ACTION_CLASSES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', expected, describeValue(raw));
  }
  return parseOk(raw as Exclude<ActionClass, 'prohibited'>);
}
