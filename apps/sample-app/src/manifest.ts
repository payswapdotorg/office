// @office-sample/app — the manifest of the reference marketplace app (OFF-025).
//
// This is the ENTIRE app: a typed AppManifest composed through the trusted
// @office/app-sdk builder. It declares what the app is allowed to do (two
// explicit, versioned A9 permission declarations), which typed domain command
// it offers to serve (one reversible command binding with a SYMBOLIC handler
// contract — the app runtime resolves the id to installed handler code at
// execution time, behind the action gateway), and which canonical domain
// event it reacts to (one event subscription with a typed entity-kind
// filter). No code, no credentials, no provider vocabulary, no wildcards —
// the host renders its surfaces and executes its commands; the app never
// touches canonical state directly (freeze A7/A8).
//
// The import graph is the point: ONLY @office/app-sdk and @office/contracts.
// No domain, intelligence, sync, adapters, agents, or client-sync packages —
// boundary.test.ts proves it.
import { parseCommandName, parseEntityKind, parseEventName } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import {
  appHandlerId,
  appManifest,
  appId,
  appVersion,
  capability,
  parsePermissionVersion,
} from '@office/app-sdk';

/**
 * Unwrap a successful ParseResult — the trusted-path composition idiom for
 * constant vocabulary values: a typo throws loud at module load, never
 * silently coerces.
 */
const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`invalid app vocabulary value: ${JSON.stringify(result.error)}`);
};

/**
 * The Field Progress Tracker app manifest — the complete declaration a
 * marketplace catalogs (OFF-027) and an app runtime instantiates
 * tenant-scoped (OFF-026). Deterministic plain data: compose-once, export
 * everywhere.
 */
export const FIELD_PROGRESS_TRACKER = appManifest({
  appId: appId('field-progress-tracker'),
  manifestVersion: appVersion('1.4.0'),
  title: 'Field Progress Tracker',
  description:
    'Records daily field progress against the plan and reacts to progress events.',
  // A9: explicit, versioned, revocable — exactly the capabilities the binding
  // below requires (work.write is the recordProgress action's requirement;
  // work.read is the read surface the subscription summarizes). Project
  // scope, never a wildcard.
  permissions: [
    {
      kind: 'app-permission',
      capability: capability('work.read'),
      scopeKind: 'project',
      version: unwrap(parsePermissionVersion(1)),
    },
    {
      kind: 'app-permission',
      capability: capability('work.write'),
      scopeKind: 'project',
      version: unwrap(parsePermissionVersion(1)),
    },
  ],
  // One command binding: the app offers to serve the reversible
  // field.recordProgress command through its symbolic handler contract.
  // The handler id is a stable slug the app runtime resolves to installed
  // handler code — the manifest never carries the code itself.
  bindings: [
    {
      kind: 'command-binding',
      commandName: unwrap(parseCommandName('field.recordProgress')),
      handler: {
        kind: 'app-handler',
        handlerId: appHandlerId('record-progress-handler'),
        title: 'Record progress',
        description:
          'Records one field progress observation through the action gateway.',
      },
      actionClass: 'reversible',
    },
  ],
  // One event subscription: every work.progressRecorded occurrence whose
  // entity reference is a field-report, delivered within the installation's
  // scope. The filter is a typed value — never a predicate, never a wildcard.
  subscriptions: [
    {
      kind: 'event-subscription',
      eventName: unwrap(parseEventName('work.progressRecorded')),
      filter: {
        kind: 'entity-kind',
        entityKind: unwrap(parseEntityKind('field-report')),
      },
    },
  ],
  // No UI extensions and no app-contract dependencies yet — the minimal
  // surface this reference app needs. Both stay explicit (empty arrays),
  // never omitted.
  uiExtensions: [],
  dependencies: [],
});
