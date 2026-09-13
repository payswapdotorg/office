// Office action gateway — the ActionDescriptor registry (OFF-017).
//
// The registry of KNOWN actions: the gateway consults it FIRST for every
// proposal (classification is fail-closed — an unregistered command is
// prohibited by default). The in-memory implementation below is the
// deterministic reference; a persistence-backed implementation can satisfy the
// same port later (the descriptors are static, versioned policy data — the
// owning runtime loads them from configuration, never from client input).
//
// Construction is fail-closed on the trusted path: descriptors must be
// structurally valid (parseActionDescriptor's class rules) and command names
// unique — a duplicate registration is a loud TypeError, never a silent
// override of one action's policy by another's.
import type { CommandName } from '@office/contracts';
import type { ActionDescriptor } from './descriptor';

/**
 * The registry port: resolves the known action behind a command name, or null
 * when the command is unknown (prohibited by default, classification.ts).
 */
export interface ActionRegistry {
  /** The registered descriptor of the command name, or null when unknown. */
  find(commandName: CommandName): ActionDescriptor | null;
  /** Every registered descriptor, in registration order. */
  descriptors(): readonly ActionDescriptor[];
}

/**
 * Create the in-memory ActionDescriptor registry. Descriptors must already be
 * validated values (see defineActionDescriptor); registration validates
 * uniqueness of command names — a duplicate is a loud TypeError, never a
 * silent policy override.
 */
export function createInMemoryActionRegistry(
  descriptors: readonly ActionDescriptor[],
): ActionRegistry {
  const byName = new Map<string, ActionDescriptor>();
  const ordered: ActionDescriptor[] = [];
  for (const descriptor of descriptors) {
    const name = descriptor.commandName as string;
    if (byName.has(name)) {
      throw new TypeError(`duplicate action descriptor for command '${name}'`);
    }
    byName.set(name, descriptor);
    ordered.push(descriptor);
  }
  return {
    find: (commandName) => byName.get(commandName as string) ?? null,
    descriptors: () => [...ordered],
  };
}
