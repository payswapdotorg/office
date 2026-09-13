// Office app-runtime — declared lifecycle hooks (OFF-026).
//
// The lifecycle hook CONTRACT of a tenant-scoped app installation (freeze A7:
// apps declare "...and lifecycle hooks"). A hook is a DECLARED DESCRIPTOR
// RECORD — the same symbolic AppHandler contract a command binding carries
// (a stable handler id plus human-readable metadata) — that the HOST
// resolves to its own installed handler code and invokes when the runtime
// performs the corresponding lifecycle transition. The runtime NEVER
// executes app code of any kind: it emits typed LifecycleHookInvocation
// records (which installation, which hook, which symbolic handler, when) and
// audits them on its event trail; what the host does with the invocation is
// the host's concern.
//
// The closed hook vocabulary — one per lifecycle transition:
//   on-install  → installation created (state 'installing')
//   on-activate → installation activated (state 'active', incl. re-activation)
//   on-suspend  → installation suspended (state 'suspended')
//   on-revoke   → installation revoked (terminal state 'revoked')
//
// Every record is plain JSON data (fail-closed strict keys, closed
// vocabulary, at most one hook per name). Deterministic: no clock, no
// randomness — invocation instants come from the injected clock.
import { parseEntityId, parseFail, parseOk, parseTimestamp } from '@office/contracts';
import type { EntityId, ParseResult, Timestamp } from '@office/contracts';
import { parseAppHandler, parseAppHandlerId } from '@office/app-sdk';
import type { AppHandler, AppHandlerId } from '@office/app-sdk';
import {
  describeValue,
  isPlainObject,
  parseArrayWith,
  requireFieldWith,
  requireLiteral,
  unknownKeyFailure,
} from './parse';

const LIFECYCLE_HOOK_NAMES = [
  'on-install',
  'on-activate',
  'on-suspend',
  'on-revoke',
] as const;

/** The name of one declared lifecycle hook (closed vocabulary). */
export type LifecycleHookName = (typeof LIFECYCLE_HOOK_NAMES)[number];

/**
 * The closed lifecycle-hook vocabulary: one hook name per lifecycle
 * transition. Uninstall declares NO hook (the installation record simply
 * reaches its terminal 'uninstalled' state — removal, not app behavior).
 */
export const LIFECYCLE_HOOKS: readonly LifecycleHookName[] = LIFECYCLE_HOOK_NAMES;

/** Grammar description used in parse failures. */
export const LIFECYCLE_HOOK_GRAMMAR =
  "AppLifecycleHook: { kind: 'app-lifecycle-hook', hook: 'on-install' | 'on-activate' | 'on-suspend' | 'on-revoke', handler: AppHandler } — a declared descriptor record, never code";

/** Grammar description used in parse failures. */
export const LIFECYCLE_HOOK_INVOCATION_GRAMMAR =
  "LifecycleHookInvocation: { kind: 'app-lifecycle-hook-invocation', installationId, hook, handlerId, occurredAt } — the typed record the host executes";

const LIFECYCLE_HOOK_KEYS = ['kind', 'hook', 'handler'] as const;
const LIFECYCLE_HOOK_INVOCATION_KEYS = [
  'kind',
  'installationId',
  'hook',
  'handlerId',
  'occurredAt',
] as const;

/**
 * One DECLARED lifecycle hook of an app installation: which transition it
 * hooks, and the symbolic handler contract the host resolves to its own
 * installed handler code. Deliberately the same AppHandler shape a command
 * binding carries — the manifest world has exactly one handler-contract
 * vocabulary.
 */
export interface AppLifecycleHook {
  readonly kind: 'app-lifecycle-hook';
  /** The lifecycle transition this hook observes (closed vocabulary). */
  readonly hook: LifecycleHookName;
  /** The symbolic handler contract the host binds to installed code. */
  readonly handler: AppHandler;
}

/**
 * The typed record of one hook the HOST must invoke: produced by the
 * lifecycle transitions (installation.ts) at the instant the transition
 * happened, carried on the audit trail, and handed to the host — never
 * executed by the runtime itself.
 */
export interface LifecycleHookInvocation {
  readonly kind: 'app-lifecycle-hook-invocation';
  /** The installation whose lifecycle transition produced this invocation. */
  readonly installationId: EntityId;
  /** The lifecycle hook being invoked (closed vocabulary). */
  readonly hook: LifecycleHookName;
  /** The symbolic handler id the HOST resolves to installed handler code. */
  readonly handlerId: AppHandlerId;
  /** When the transition happened (injected clock — never wall time). */
  readonly occurredAt: Timestamp;
}

/**
 * Parse an untrusted value as one AppLifecycleHook (total, fail-closed,
 * strict keys). The hook name must be one of the closed vocabulary; the
 * handler must parse as the symbolic AppHandler contract.
 */
export function parseAppLifecycleHook(raw: unknown): ParseResult<AppLifecycleHook> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', LIFECYCLE_HOOK_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, LIFECYCLE_HOOK_KEYS, '', LIFECYCLE_HOOK_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-lifecycle-hook']);
  if (!kind.ok) return kind;
  const hook = requireLiteral(raw, 'hook', '', LIFECYCLE_HOOKS);
  if (!hook.ok) return hook;
  const handler = requireFieldWith(raw, 'handler', '', parseAppHandler);
  if (!handler.ok) return handler;
  return parseOk(
    {
      kind: 'app-lifecycle-hook',
      hook: hook.value as LifecycleHookName,
      handler: handler.value,
    } satisfies AppLifecycleHook,
  );
}

/** Type guard for structurally valid AppLifecycleHook values. */
export function isAppLifecycleHook(raw: unknown): raw is AppLifecycleHook {
  return parseAppLifecycleHook(raw).ok;
}

/**
 * Parse an untrusted list of declared lifecycle hooks (total, fail-closed).
 * At most ONE hook per name — duplicates are typed-rejected, never silently
 * merged (the host would not know which handler to invoke).
 */
export function parseAppLifecycleHooks(raw: unknown): ParseResult<readonly AppLifecycleHook[]> {
  const parsed = parseArrayWith(raw, 'hooks', parseAppLifecycleHook, LIFECYCLE_HOOK_GRAMMAR);
  if (!parsed.ok) return parsed;
  const seen = new Set<string>();
  for (const [index, hook] of parsed.value.entries()) {
    if (seen.has(hook.hook)) {
      return parseFail(
        'invalid-value',
        `hooks[${index}]`,
        'at most one declared hook per lifecycle hook name',
        `duplicate hook '${hook.hook}'`,
      );
    }
    seen.add(hook.hook);
  }
  return parseOk(parsed.value);
}

/**
 * Compose the declared lifecycle hooks from trusted inputs (trusted path;
 * loud TypeError): one entry per transition the app declares a hook for,
 * validated by the same fail-closed parse. Absent transitions simply have
 * no hook — the transitions still happen, they just emit no invocation.
 */
export function appLifecycleHooks(
  parts: Partial<Record<LifecycleHookName, AppHandler>>,
): readonly AppLifecycleHook[] {
  const hooks: AppLifecycleHook[] = [];
  for (const hook of LIFECYCLE_HOOKS) {
    const handler = parts[hook];
    if (handler === undefined) continue;
    const parsed = parseAppLifecycleHook({ kind: 'app-lifecycle-hook', hook, handler });
    if (!parsed.ok) {
      throw new TypeError(
        `invalid lifecycle hook '${hook}': ${parsed.error.code} at '${
          parsed.error.path === '' ? '<root>' : parsed.error.path
        }' — expected ${parsed.error.expected}, received ${parsed.error.received}`,
      );
    }
    hooks.push(parsed.value);
  }
  return hooks;
}

/**
 * Parse an untrusted value as a LifecycleHookInvocation (total, fail-closed,
 * strict keys).
 */
export function parseLifecycleHookInvocation(raw: unknown): ParseResult<LifecycleHookInvocation> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', LIFECYCLE_HOOK_INVOCATION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    LIFECYCLE_HOOK_INVOCATION_KEYS,
    '',
    LIFECYCLE_HOOK_INVOCATION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-lifecycle-hook-invocation']);
  if (!kind.ok) return kind;
  const installationId = requireFieldWith(raw, 'installationId', '', parseEntityId);
  if (!installationId.ok) return installationId;
  const hook = requireLiteral(raw, 'hook', '', LIFECYCLE_HOOKS);
  if (!hook.ok) return hook;
  const handlerId = requireFieldWith(raw, 'handlerId', '', parseAppHandlerId);
  if (!handlerId.ok) return handlerId;
  const occurredAt = requireFieldWith(raw, 'occurredAt', '', parseTimestamp);
  if (!occurredAt.ok) return occurredAt;
  return parseOk(
    {
      kind: 'app-lifecycle-hook-invocation',
      installationId: installationId.value,
      hook: hook.value as LifecycleHookName,
      handlerId: handlerId.value,
      occurredAt: occurredAt.value,
    } satisfies LifecycleHookInvocation,
  );
}

/** Type guard for structurally valid LifecycleHookInvocation values. */
export function isLifecycleHookInvocation(raw: unknown): raw is LifecycleHookInvocation {
  return parseLifecycleHookInvocation(raw).ok;
}

/**
 * Compose the typed invocation record for one transition of one
 * installation (trusted path; loud TypeError). When the installation
 * declares no hook for the transition, returns null — nothing to invoke.
 */
export function lifecycleHookInvocationOf(
  installation: {
    readonly installationId: EntityId;
    readonly hooks: readonly AppLifecycleHook[];
  },
  hook: LifecycleHookName,
  occurredAt: Timestamp,
): LifecycleHookInvocation | null {
  const declared = installation.hooks.find((candidate) => candidate.hook === hook);
  if (declared === undefined) return null;
  const parsed = parseLifecycleHookInvocation({
    kind: 'app-lifecycle-hook-invocation',
    installationId: installation.installationId,
    hook,
    handlerId: declared.handler.handlerId,
    occurredAt,
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid lifecycle hook invocation: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}
