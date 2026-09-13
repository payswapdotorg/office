// Office app-sdk — cross-reference manifest validation (OFF-025).
//
// The second, SEMANTIC validation step on top of the structural parse
// (manifest.ts): a structurally valid manifest is checked against the REAL
// platform vocabularies it references:
//
// - every command binding resolves against the OFF-017 action registry —
//   an UNKNOWN command is typed-rejected (the gateway classifies unknown
//   commands as prohibited by default, so a binding to one could never
//   execute), and the binding's declared action class must MATCH the
//   descriptor's class;
// - every capability the bound action REQUIRES must be DECLARED in the
//   manifest's permissions (A9: explicit — an app cannot bind an action
//   whose capability requirements it never asked for);
// - every UI action element references a DECLARED command binding (the
//   host renders the button only for a binding the manifest carries);
// - every app dependency resolves against the app catalog — an unknown
//   app, or a range no published contract version satisfies, is
//   typed-rejected.
//
// The action registry and the app catalog enter as INJECTED PORTS (the
// minimal structural shape this SDK needs): @office/actions' ActionRegistry
// satisfies the action port structurally (find(commandName) returns the
// descriptor, which carries commandName/actionClass/requiredCapabilities),
// so the real registry plugs in directly — see validation.test.ts, which
// validates bindings against real ActionDescriptors. The ports keep this
// module pure and keep @office/actions a TYPE-ONLY dependency of the SDK:
// an importing app's runtime graph stays contracts/authz/domain-kernel.
//
// Total and deterministic: no throws, no clock, no randomness — the same
// manifest and deps always produce the same typed result.
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorDetail, Result } from '@office/domain-kernel';
import type { CommandName, ParseResult } from '@office/contracts';
import type { Capability } from '@office/authz';
import type { ActionClass } from '@office/actions';
import type { AppId, AppVersion } from './identity';
import { satisfiesVersion } from './identity';
import { parseAppManifest } from './manifest';
import type { AppManifest } from './manifest';

/**
 * The minimal structural view of a known action the SDK validates against:
 * the OFF-017 ActionDescriptor subset a manifest binding references
 * (commandName, actionClass, requiredCapabilities).
 */
export interface KnownAction {
  readonly commandName: CommandName;
  readonly actionClass: ActionClass;
  readonly requiredCapabilities: readonly Capability[];
}

/**
 * The action-descriptor source port: resolves the known action behind a
 * command name, or null when the command is unknown. @office/actions'
 * ActionRegistry satisfies this structurally (its descriptors carry exactly
 * these fields), so `actionDescriptorSource(realRegistry)` adapts it.
 */
export interface ActionDescriptorSource {
  find(commandName: CommandName): KnownAction | null;
}

/**
 * The app-catalog source port: the published contract versions of an app,
 * or null when the app is unknown to the catalog (distinguishing "unknown
 * app" from "known app with no versions"). The marketplace (OFF-027) owns
 * the real catalog; the in-memory registry (registry.ts) satisfies this
 * structurally.
 */
export interface AppCatalogSource {
  versions(appId: AppId): readonly AppVersion[] | null;
}

/** The injected vocabularies cross-reference validation runs against. */
export interface AppValidationDeps {
  /** The known actions (command bindings resolve against this). */
  readonly actions: ActionDescriptorSource;
  /** The published app contracts (dependencies resolve against this). */
  readonly apps: AppCatalogSource;
}

/**
 * Adapt an action registry to the SDK's action-descriptor source port.
 * Accepts the structural `{ find }` shape — @office/actions'
 * ActionRegistry plugs in directly (proven by validation.test.ts against
 * real ActionDescriptors).
 */
export function actionDescriptorSource(
  registry: { readonly find: (commandName: CommandName) => KnownAction | null },
): ActionDescriptorSource {
  return { find: (commandName) => registry.find(commandName) };
}

/** Build the typed validation failure (one stable detail code + path). */
const validationFailure = (
  code: Parameters<typeof domainError>[0],
  message: string,
  detail: DomainErrorDetail,
): Result<never, DomainError> => fail(domainError(code, message, [detail]));

/**
 * Validate a structurally parsed AppManifest against the real action and
 * app vocabularies (total, fail-closed, deterministic). Success returns the
 * manifest unchanged — validation never mutates or repairs anything.
 */
export function validateAppManifest(
  manifest: AppManifest,
  deps: AppValidationDeps,
): Result<AppManifest, DomainError> {
  // --- command bindings: known, class-matched, capability-declared ---
  const declared = new Set<string>();
  for (const permission of manifest.permissions) {
    declared.add(permission.capability);
  }
  for (const [index, binding] of manifest.bindings.entries()) {
    const action = deps.actions.find(binding.commandName);
    if (action === null) {
      return validationFailure(
        'not-found',
        `binding '${binding.commandName}' references an unknown action — no registered ActionDescriptor names that command`,
        {
          code: 'unknown-command',
          message: binding.commandName,
          path: `bindings[${index}].commandName`,
        },
      );
    }
    if (binding.actionClass !== action.actionClass) {
      return validationFailure(
        'invariant-violation',
        `binding '${binding.commandName}' declares action class '${binding.actionClass}' but the action descriptor classifies it as '${action.actionClass}'`,
        {
          code: 'action-class-mismatch',
          message: `${binding.actionClass} vs ${action.actionClass}`,
          path: `bindings[${index}].actionClass`,
        },
      );
    }
    for (const required of action.requiredCapabilities) {
      if (!declared.has(required)) {
        return validationFailure(
          'forbidden',
          `binding '${binding.commandName}' requires capability '${required}' that the manifest does not declare`,
          {
            code: 'undeclared-required-capability',
            message: required,
            path: `bindings[${index}].commandName`,
          },
        );
      }
    }
  }

  // --- UI action elements: reference declared bindings ---
  const boundCommands = new Set<string>(
    manifest.bindings.map((binding) => binding.commandName),
  );
  for (const [extensionIndex, extension] of manifest.uiExtensions.entries()) {
    for (const [elementIndex, element] of extension.view.elements.entries()) {
      if (element.kind !== 'action') continue;
      if (!boundCommands.has(element.commandName)) {
        return validationFailure(
          'invariant-violation',
          `view '${extension.view.viewId}' action references command '${element.commandName}' that the manifest does not bind`,
          {
            code: 'undeclared-binding-action',
            message: element.commandName,
            path: `uiExtensions[${extensionIndex}].view.elements[${elementIndex}].commandName`,
          },
        );
      }
    }
  }

  // --- app dependencies: known apps, satisfiable ranges ---
  for (const [index, dependency] of manifest.dependencies.entries()) {
    const published = deps.apps.versions(dependency.appId);
    if (published === null) {
      return validationFailure(
        'not-found',
        `dependency '${dependency.appId}' references an app unknown to the catalog`,
        {
          code: 'unknown-dependency-app',
          message: dependency.appId,
          path: `dependencies[${index}].appId`,
        },
      );
    }
    const satisfied = published.some((version) =>
      satisfiesVersion(dependency.versionRange, version),
    );
    if (!satisfied) {
      return validationFailure(
        'not-found',
        `dependency '${dependency.appId}' range is satisfied by no published contract version`,
        {
          code: 'dependency-version-unsatisfied',
          message: `${dependency.appId} has [${published.join(', ')}]`,
          path: `dependencies[${index}].versionRange`,
        },
      );
    }
  }

  return ok(manifest);
}

/**
 * The total result of a full manifest review: the structural parse failure
 * (typed ContractParseError) OR the cross-reference validation failure
 * (typed DomainError) OR the validated manifest.
 */
export type ManifestReview = ParseResult<AppManifest> | Result<AppManifest, DomainError>;

/**
 * Review an UNTRUSTED manifest end to end (total, fail-closed): the
 * structural parse first, then — only on a parsed manifest — the
 * cross-reference validation. The marketplace intake (OFF-027) and the app
 * runtime (OFF-026) call this single entry point; malformed manifests of
 * every kind come back typed-rejected, never thrown, never repaired.
 */
export function reviewAppManifest(raw: unknown, deps: AppValidationDeps): ManifestReview {
  const parse = parseAppManifest(raw);
  if (!parse.ok) return parse;
  return validateAppManifest(parse.value, deps);
}
