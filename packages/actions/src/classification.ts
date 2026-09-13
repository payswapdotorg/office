// Office action gateway — action classification (OFF-017).
//
// THE four-class vocabulary of freeze A8 (the AI execution boundary):
// - 'read'              — a query; no canonical mutation; authorizes as a read;
// - 'reversible'        — a write compensated by a declared compensating
//                         action; executes at the gateway against the injected
//                         handler once every gate passes;
// - 'approval-required' — a write that may ONLY execute after the routed
//                         workflow approval completes; the gateway routes it
//                         into the approval engine and NEVER executes it
//                         directly;
// - 'prohibited'        — never executed; rejected at the gateway with typed
//                         errors.
//
// Classification is FAIL-CLOSED: an unknown command — one no registered
// ActionDescriptor names — is prohibited BY DEFAULT. Nothing about an unknown
// action is trusted: it never reaches authorization for execution, never
// reaches a handler, and is denied with a typed error + audit event.
//
// The class also selects the authz action of the authorization step: reads
// authorize as 'read', every write class as 'write' (prohibited actions are
// rejected before authorization — they never reach it, by construction).
import type { CommandName } from '@office/contracts';
import type { Action } from '@office/authz';
import type { ActionClass, ActionDescriptor } from './descriptor';
import type { ActionRegistry } from './registry';

/**
 * The fail-closed classification of one command name: the class, the
 * descriptor behind it, and whether the command is KNOWN at all. Unknown
 * commands classify as 'prohibited' with a null descriptor — prohibited by
 * default.
 */
export interface ActionClassification {
  /** The class the command falls into. */
  readonly actionClass: ActionClass;
  /** The registered descriptor, or null when the command is unknown. */
  readonly descriptor: ActionDescriptor | null;
  /** False exactly when no registered descriptor names the command. */
  readonly known: boolean;
}

/**
 * Classify a command name against a registry (pure, fail-closed): a known
 * command takes its descriptor's declared class; an UNKNOWN command is
 * prohibited by default — the classification carries no descriptor and the
 * gateway rejects it before anything else.
 */
export function classifyAction(
  registry: ActionRegistry,
  commandName: CommandName,
): ActionClassification {
  const descriptor = registry.find(commandName);
  if (descriptor === null) {
    return { actionClass: 'prohibited', descriptor: null, known: false };
  }
  return { actionClass: descriptor.actionClass, descriptor, known: true };
}

/**
 * The authz action a class authorizes as: reads authorize as 'read'; the
 * write classes as 'write'. (Prohibited actions never reach authorization —
 * the gateway rejects them at classification.)
 */
export function authorizationActionOf(actionClass: ActionClass): Action {
  return actionClass === 'read' ? 'read' : 'write';
}
