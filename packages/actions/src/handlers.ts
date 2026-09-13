// Office action gateway — the injected typed command handler port (OFF-017).
//
// The gateway NEVER touches a store: every executed action (read or
// reversible write) runs against an INJECTED typed command handler resolved
// by command name — the domain module's own CommandHandler (the
// @office/domain-kernel contract: an already-validated CommandEnvelope plus a
// transaction-bound execution context, returning a typed Result). The gateway
// hands the handler the caller's transaction executor, the injected clock,
// and the injected canonical-id supplier; the handler's own domain events,
// persistence, and invariants stay entirely inside the domain module.
//
// A declared action without a registered handler is a WIRING DEFECT and
// fails closed at execution time with a typed invariant-violation — the
// gateway never silently no-ops an action it just authorized.
import { parseCommandName } from '@office/contracts';
import type { CommandName } from '@office/contracts';
import type { CommandHandler } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';

/**
 * The handler of one action as the gateway invokes it: the domain kernel's
 * typed CommandHandler bound to the caller's SqlExecutor transaction.
 */
export type ActionCommandHandler = CommandHandler<unknown, SqlExecutor, unknown>;

/**
 * The injected handler port: resolves the typed command handler behind a
 * command name, or null when none is registered (a typed wiring failure at
 * execution time — never a silent no-op).
 */
export interface ActionHandlers {
  resolve(commandName: CommandName): ActionCommandHandler | null;
}

/**
 * Create the in-memory handler registry from a plain map of command name to
 * handler. Keys are validated fail-closed on the trusted path (a malformed
 * command-name key is a loud TypeError); a non-function entry likewise.
 */
export function createInMemoryActionHandlers(
  handlers: Readonly<Record<string, ActionCommandHandler>>,
): ActionHandlers {
  const byName = new Map<string, ActionCommandHandler>();
  for (const [name, handler] of Object.entries(handlers)) {
    const parsed = parseCommandName(name);
    if (!parsed.ok) {
      throw new TypeError(`invalid action handler command name: ${String(name)}`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`action handler for '${name}' is not a function`);
    }
    byName.set(parsed.value as string, handler);
  }
  return {
    resolve: (commandName) => byName.get(commandName as string) ?? null,
  };
}
