// OFF-026 app-runtime — THE dispatch acceptance suite (the sandbox boundary).
//
// THE two named acceptances of the work item, proven by gateway/handler
// invocation counting over the REAL action gateway (the counting wrapper
// records every executeAction call; the counting handler records every
// handler invocation):
//
//   1. An app cannot access an undeclared capability or another tenant —
//      command dispatch with an undeclared capability is typed-rejected
//      BEFORE the gateway (zero gateway calls, zero handler invocations);
//      cross-tenant dispatch is typed-rejected in BOTH directions (A12);
//      the systematic lifecycle-state × grant-state matrix proves no path
//      bypasses the grant check (exactly ONE cell reaches the gateway).
//
//   2. A suspended app receives NO commands and NO events — both paths
//      typed-rejected with the suspension reason AUDITED; re-activation
//      restores dispatch; revocation is permanent (typed).
//
// Plus the A8 counting proof (lifecycle operations and event delivery never
// touch the gateway), the remaining pre-gateway gates (binding, actor,
// classification, envelope parse), the gateway's verbatim decision record
// (executed / routed-to-approval / denied), and the event-side re-checks.
import { describe, expect, it } from 'vitest';
import { parseCapability } from '@office/authz';
import {
  grantPermission,
  parseCommandBinding,
  parseEventSubscription,
  revokePermission,
} from '@office/app-sdk';
import type { CommandBinding, EventSubscription, Permission, PermissionSpec } from '@office/app-sdk';
import type { CommandEnvelope, EventName, Scope } from '@office/contracts';
import { parseEntityKind } from '@office/contracts';
import { appCommandDispatch, appEventDispatch, matchEventSubscription } from './dispatch';
import type { AppCommandDispatchInput } from './dispatch';
import {
  APP_COMMAND_DISPATCHED_EVENT,
  APP_COMMAND_REJECTED_EVENT,
  APP_EVENT_DELIVERED_EVENT,
  APP_EVENT_REJECTED_EVENT,
} from './audit-events';
import type { AppRuntimeAuditPayload, InMemoryAppEventSink } from './audit-events';
import {
  activateInstallation,
  installInstallation,
  revokeInstallation,
  suspendInstallation,
  uninstallInstallation,
} from './installation';
import type { AppInstallation, AppLifecycleState } from './installation';
import { APP_LIFECYCLE_STATES } from './installation';
import {
  INSTALLATION,
  INSTALLATION_B,
  INSTALLATION_C,
  SAMPLE_COMMAND,
  SAMPLE_MANIFEST,
  TENANT_A,
  TENANT_B,
  T0,
  adminActor,
  appActorOf,
  commandEnvelopeOf,
  denyWritePolicy,
  eventEnvelopeOf,
  expectFail,
  expectOk,
  makeAppDispatchHarness,
  operatorActor,
  otherAppActor,
  samplePermissionsFor,
  unwrap,
} from './test-support';

const binding = (): CommandBinding =>
  unwrap(parseCommandBinding(SAMPLE_MANIFEST.bindings[0] as CommandBinding));
const subscription = (): EventSubscription =>
  unwrap(parseEventSubscription(SAMPLE_MANIFEST.subscriptions[0] as EventSubscription));

/** The A4 provenance a fully-authorized recordProgress dispatch carries. */
const dispatchInput = (command: CommandEnvelope): AppCommandDispatchInput => ({
  command,
  evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
  confidence: 'medium',
});

/** Installations of the sample app in tenant A, one per lifecycle state. */
const installationsByState = (): Record<AppLifecycleState, AppInstallation> => {
  const installing = installInstallation({
    installationId: INSTALLATION,
    tenantId: TENANT_A,
    appId: SAMPLE_MANIFEST.appId,
    manifestVersion: SAMPLE_MANIFEST.manifestVersion,
    hooks: [],
    installedAt: T0,
    installedBy: adminActor(),
  });
  const active = expectOk(activateInstallation(installing, { at: T0 })).installation;
  return {
    installing,
    active,
    suspended: expectOk(suspendInstallation(active, { by: operatorActor(), at: T0 })).installation,
    revoked: expectOk(revokeInstallation(active, { by: operatorActor(), at: T0 })).installation,
    uninstalled: expectOk(uninstallInstallation(active, { by: operatorActor(), at: T0 }))
      .installation,
  };
};

/** The grant fixtures of one state: live / work.write-revoked / none. */
type GrantState = 'live' | 'revoked' | 'none';
const grantsByState = (installation: AppInstallation): Record<GrantState, readonly Permission[]> => {
  const live = samplePermissionsFor(installation);
  const revoked = live.map((grant) =>
    grant.spec.capability === 'work.write'
      ? expectOk(revokePermission(grant, { revokedBy: operatorActor(), now: T0 }))
      : grant,
  );
  return { live, revoked, none: [] };
};

/** The audit payloads of one runtime event name, in order. */
const auditEventsOf = (sink: InMemoryAppEventSink, name: EventName): AppRuntimeAuditPayload[] =>
  sink.events
    .filter((event) => event.eventName === name)
    .map((event) => event.payload as AppRuntimeAuditPayload);

// ----- THE named acceptance #1: undeclared capability / another tenant ---------------------

describe('THE acceptance — an app cannot access an undeclared capability (A9)', () => {
  it('typed-rejects BEFORE the gateway when the capability was never granted', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      grantsByState(installation).none,
      binding(),
      dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('capability-not-granted');
    // THE proof: the gateway (and its handler) were never reached.
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
    // The rejection is audited with its reason.
    const rejected = auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe('capability-not-granted');
    expect(rejected[0]?.decision).toBe('command-rejected');
  });

  it('typed-rejects BEFORE the gateway when the grant was REVOKED', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      grantsByState(installation).revoked,
      binding(),
      dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('capability-revoked');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
    expect(auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT)[0]?.reason).toBe(
      'capability-revoked',
    );
  });

  it('typed-rejects a foreign installation\u2019s grant even for a declared capability', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const foreign = samplePermissionsFor({ ...installation, installationId: INSTALLATION_B });
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      foreign,
      binding(),
      dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('permission-foreign');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
    expect(auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT)[0]?.reason).toBe(
      'permission-foreign',
    );
  });

  it('THE systematic matrix: lifecycle state \u00d7 grant state — one cell dispatches', async () => {
    const harness = makeAppDispatchHarness();
    const states = installationsByState();
    const lifecycleOutcome: Record<AppLifecycleState, string | null> = {
      installing: 'installation-installing',
      active: null,
      suspended: 'installation-suspended',
      revoked: 'installation-revoked',
      uninstalled: 'installation-uninstalled',
    };
    const grantOutcome: Record<GrantState, string | null> = {
      live: null,
      revoked: 'capability-revoked',
      none: 'capability-not-granted',
    };
    let dispatches = 0;
    let rejections = 0;
    for (const state of APP_LIFECYCLE_STATES) {
      const installation = states[state];
      for (const grantState of ['live', 'revoked', 'none'] as const) {
        const result = await appCommandDispatch(
          harness.deps,
          installation,
          grantsByState(installation)[grantState],
          binding(),
          dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
        );
        const cell = `${state}/${grantState}`;
        // The lifecycle gate runs FIRST: a non-active installation never
        // dispatches, whatever its grants; an active installation is then
        // gated by its live grants.
        const expectedReason = lifecycleOutcome[state] ?? grantOutcome[grantState];
        if (expectedReason === null) {
          dispatches += 1;
          expect(result.ok, cell).toBe(true);
        } else {
          rejections += 1;
          expect(result.ok, cell).toBe(false);
          if (!result.ok) {
            expect(result.error.details[0]?.code, cell).toBe(expectedReason);
          }
        }
      }
    }
    expect(dispatches).toBe(1);
    expect(rejections).toBe(14);
    // THE counting proof: exactly one gateway call and one handler invocation
    // across the whole 15-cell matrix — no path bypassed the grant check.
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(1);
    // Every rejection is audited with its typed reason.
    const rejected = auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT);
    expect(rejected).toHaveLength(14);
    expect(rejected.filter((payload) => payload.reason === 'installation-suspended')).toHaveLength(
      3,
    );
    expect(auditEventsOf(harness.appSink, APP_COMMAND_DISPATCHED_EVENT)).toHaveLength(1);
  });
});

describe('THE acceptance — an app cannot access another tenant (A12, both directions)', () => {
  const tenantBInstallation = (): AppInstallation =>
    expectOk(
      activateInstallation(
        installInstallation({
          installationId: INSTALLATION_B,
          tenantId: TENANT_B,
          appId: SAMPLE_MANIFEST.appId,
          manifestVersion: SAMPLE_MANIFEST.manifestVersion,
          hooks: [],
          installedAt: T0,
          installedBy: adminActor(),
        }),
        { at: T0 },
      ),
    ).installation;

  it('typed-rejects a tenant-A installation dispatching into tenant B\u2019s scope', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      binding(),
      dispatchInput(
        commandEnvelopeOf({
          commandName: 'field.recordProgress',
          scope: { kind: 'tenant', tenantId: TENANT_B } satisfies Scope,
        }),
      ),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('unauthorized');
    expect(failure.details[0]?.code).toBe('cross-tenant-scope');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
    expect(auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT)[0]?.reason).toBe(
      'cross-tenant-scope',
    );
  });

  it('typed-rejects a tenant-B installation dispatching into tenant A\u2019s scope', async () => {
    const harness = makeAppDispatchHarness();
    const installation = tenantBInstallation();
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      binding(),
      dispatchInput(
        commandEnvelopeOf({
          installationId: INSTALLATION_B,
          commandName: 'field.recordProgress',
          scope: { kind: 'tenant', tenantId: TENANT_A } satisfies Scope,
        }),
      ),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('unauthorized');
    expect(failure.details[0]?.code).toBe('cross-tenant-scope');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
  });

  it('typed-rejects a cross-tenant RESOURCE scope even when the command scope matches', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      binding(),
      {
        ...dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
        resourceScope: { kind: 'tenant', tenantId: TENANT_B } satisfies Scope,
      },
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('unauthorized');
    expect(failure.details[0]?.code).toBe('cross-tenant-scope');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
  });

  it('typed-rejects delivering another tenant\u2019s events to a tenant-A installation', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const result = await appEventDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      subscription(),
      eventEnvelopeOf({
        eventName: 'work.progressRecorded',
        scope: { kind: 'tenant', tenantId: TENANT_B } satisfies Scope,
        entityKind: 'field-report',
      }),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('unauthorized');
    expect(failure.details[0]?.code).toBe('cross-tenant-scope');
    expect(auditEventsOf(harness.appSink, APP_EVENT_REJECTED_EVENT)[0]?.reason).toBe(
      'cross-tenant-scope',
    );
  });

  it('typed-rejects delivering tenant-A events to a tenant-B installation', async () => {
    const harness = makeAppDispatchHarness();
    const installation = tenantBInstallation();
    const result = await appEventDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      subscription(),
      eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    );
    const failure = expectFail(result);
    expect(failure.details[0]?.code).toBe('cross-tenant-scope');
  });
});

// ----- THE named acceptance #2: a suspended app receives NOTHING ----------------------------

describe('THE acceptance — a suspended app receives NO commands and NO events', () => {
  it('typed-rejects a command to a suspended installation (forbidden, audited)', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().suspended;
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      binding(),
      dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('installation-suspended');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
    // THE audit trail records the suspension rejection.
    const rejected = auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe('installation-suspended');
    expect(rejected[0]?.installationState).toBe('suspended');
    expect(rejected[0]?.decision).toBe('command-rejected');
    expect(rejected[0]?.commandName).toBe('field.recordProgress');
  });

  it('typed-rejects an event to a suspended installation (forbidden, audited)', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().suspended;
    const result = await appEventDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      subscription(),
      eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('installation-suspended');
    const rejected = auditEventsOf(harness.appSink, APP_EVENT_REJECTED_EVENT);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe('installation-suspended');
    expect(rejected[0]?.installationState).toBe('suspended');
    expect(auditEventsOf(harness.appSink, APP_EVENT_DELIVERED_EVENT)).toHaveLength(0);
  });

  it('re-activation RESTORES dispatch on both paths', async () => {
    const harness = makeAppDispatchHarness();
    const suspended = installationsByState().suspended;
    const reactivated = expectOk(activateInstallation(suspended, { at: T0 })).installation;
    expect(reactivated.state).toBe('active');
    const command = await appCommandDispatch(
      harness.deps,
      reactivated,
      samplePermissionsFor(reactivated),
      binding(),
      dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
    );
    expect(command.ok).toBe(true);
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(1);
    const delivered = await appEventDispatch(
      harness.deps,
      reactivated,
      samplePermissionsFor(reactivated),
      subscription(),
      eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    );
    expect(delivered.ok).toBe(true);
    expect(auditEventsOf(harness.appSink, APP_EVENT_DELIVERED_EVENT)).toHaveLength(1);
  });

  it('revocation is PERMANENT: a revoked installation never dispatches again', async () => {
    const harness = makeAppDispatchHarness();
    const revoked = installationsByState().revoked;
    const command = await appCommandDispatch(
      harness.deps,
      revoked,
      samplePermissionsFor(revoked),
      binding(),
      dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
    );
    expect(expectFail(command).details[0]?.code).toBe('installation-revoked');
    const event = await appEventDispatch(
      harness.deps,
      revoked,
      samplePermissionsFor(revoked),
      subscription(),
      eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    );
    expect(expectFail(event).details[0]?.code).toBe('installation-revoked');
    // Re-activating a revoked installation is typed-rejected (one-way).
    const reactivation = activateInstallation(revoked, { at: T0 });
    expect(expectFail(reactivation).details[0]?.code).toBe('revocation-terminal');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
  });
});

// ----- the remaining pre-gateway gates ------------------------------------------------------

describe('the remaining pre-gateway gates (typed, counted)', () => {
  it('typed-rejects an envelope that fails the canonical contract (fail-closed parse)', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const valid = commandEnvelopeOf({ commandName: 'field.recordProgress' });
    const invalid = { ...valid, idempotencyKey: 'not a valid key!' } as CommandEnvelope;
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      binding(),
      dispatchInput(invalid),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('invalid-envelope');
    expect(harness.countedGateway.calls.count).toBe(0);
  });

  it('typed-rejects a dispatch that does not serve the binding\u2019s command', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      binding(),
      dispatchInput(commandEnvelopeOf({ commandName: 'cost.listCostItems' })),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('binding-command-mismatch');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT)[0]?.reason).toBe(
      'binding-command-mismatch',
    );
  });

  it('typed-rejects a spoofed actor (another installation\u2019s app actor, or a user)', async () => {
    for (const actor of [otherAppActor(), adminActor()]) {
      const harness = makeAppDispatchHarness();
      const installation = installationsByState().active;
      const result = await appCommandDispatch(
        harness.deps,
        installation,
        samplePermissionsFor(installation),
        binding(),
        dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress', actor })),
      );
      const failure = expectFail(result);
      expect(failure.code).toBe('forbidden');
      expect(failure.details[0]?.code).toBe('actor-not-installation');
      expect(harness.countedGateway.calls.count).toBe(0);
      expect(harness.handlerInvocations.count).toBe(0);
    }
  });

  it('typed-rejects an unclassified command (unknown to the action descriptor source)', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const unknownBinding = unwrap(
      parseCommandBinding({
        kind: 'command-binding',
        commandName: 'field.unknownCommand',
        handler: {
          kind: 'app-handler',
          handlerId: 'unknown-handler',
          title: 'Unknown',
          description: null,
        },
        actionClass: 'reversible',
      }),
    );
    const result = await appCommandDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      unknownBinding,
      dispatchInput(commandEnvelopeOf({ commandName: 'field.unknownCommand' })),
    );
    const failure = expectFail(result);
    expect(failure.code).toBe('not-found');
    expect(failure.details[0]?.code).toBe('unknown-command');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT)[0]?.reason).toBe(
      'unknown-command',
    );
  });
});

// ----- A8: the counting proof over the whole lifecycle --------------------------------------

describe('A8 — every mutation is gateway-mediated (counting)', () => {
  it('lifecycle transitions and event delivery never call the gateway; a command does', async () => {
    const harness = makeAppDispatchHarness();
    const installing = installInstallation({
      installationId: INSTALLATION,
      tenantId: TENANT_A,
      appId: SAMPLE_MANIFEST.appId,
      manifestVersion: SAMPLE_MANIFEST.manifestVersion,
      hooks: [],
      installedAt: T0,
      installedBy: adminActor(),
    });
    // A full audited lifecycle: install → activate → suspend → re-activate →
    // revoke → (terminal). None of these touch the gateway.
    const active = expectOk(activateInstallation(installing, { at: T0 })).installation;
    const suspended = expectOk(suspendInstallation(active, { by: operatorActor(), at: T0 }))
      .installation;
    const reactivated = expectOk(activateInstallation(suspended, { at: T0 })).installation;
    expectOk(revokeInstallation(reactivated, { by: operatorActor(), at: T0 }));
    // Event delivery produces a typed record, not a mutation.
    expectOk(
      await appEventDispatch(
        harness.deps,
        reactivated,
        samplePermissionsFor(reactivated),
        subscription(),
        eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
      ),
    );
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
    // THE one mutation path: a fully-authorized command dispatch.
    expectOk(
      await appCommandDispatch(
        harness.deps,
        reactivated,
        samplePermissionsFor(reactivated),
        binding(),
        dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
      ),
    );
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(1);
  });
});

// ----- the successful dispatch + the verbatim gateway decision -------------------------------

describe('the successful command dispatch (record + audit)', () => {
  it('reaches the gateway exactly once and records its decision verbatim', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const command = commandEnvelopeOf({ commandName: 'field.recordProgress' });
    const record = expectOk(
      await appCommandDispatch(
        harness.deps,
        installation,
        samplePermissionsFor(installation),
        binding(),
        dispatchInput(command),
      ),
    );
    expect(record.kind).toBe('app-command-dispatch');
    expect(record.installationId).toBe(INSTALLATION);
    expect(record.appId).toBe(SAMPLE_MANIFEST.appId);
    expect(record.commandName).toBe(SAMPLE_COMMAND);
    expect(record.handlerId).toBe('record-progress-handler');
    expect(record.idempotencyKey).toBe(command.idempotencyKey);
    expect(record.outcome.decision).toBe('executed');
    if (record.outcome.decision === 'executed') {
      expect(record.outcome.replayed).toBe(false);
      expect(record.outcome.value).toStrictEqual({
        recorded: true,
        observedPercent: 37,
        idempotencyKey: command.idempotencyKey,
      });
    }
    // The proposal the gateway received carries the installation's actor.
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.countedGateway.calls.commands[0]?.actor).toStrictEqual(
      appActorOf(INSTALLATION),
    );
    expect(harness.handlerInvocations.count).toBe(1);
    // The audit trail records the dispatch.
    const dispatched = auditEventsOf(harness.appSink, APP_COMMAND_DISPATCHED_EVENT);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.decision).toBe('command-dispatched');
    expect(dispatched[0]?.commandName).toBe('field.recordProgress');
    expect(dispatched[0]?.handlerId).toBe('record-progress-handler');
    expect(dispatched[0]?.reason).toBeNull();
  });

  it('records a gateway DENIAL verbatim (the host policy still applies behind the grants)', async () => {
    const harness = makeAppDispatchHarness({ policy: denyWritePolicy });
    const installation = installationsByState().active;
    const record = expectOk(
      await appCommandDispatch(
        harness.deps,
        installation,
        samplePermissionsFor(installation),
        binding(),
        dispatchInput(commandEnvelopeOf({ commandName: 'field.recordProgress' })),
      ),
    );
    // The pre-gateway gates passed (live grants, right tenant, active
    // installation) — the GATEWAY itself denied the write-class action.
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(0);
    expect(record.outcome.decision).toBe('denied');
    if (record.outcome.decision === 'denied') {
      expect(record.outcome.denial.code).toBe('forbidden');
    }
    // A denied dispatch is still a dispatch decision, audited as such.
    expect(auditEventsOf(harness.appSink, APP_COMMAND_DISPATCHED_EVENT)).toHaveLength(1);
  });

  it('records an approval ROUTING verbatim (the approval-required class never executes)', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    // The sample app does not declare cost.write; grant it explicitly so the
    // dispatch reaches the gateway and is routed into the approval engine.
    const costWriteSpec: PermissionSpec = {
      ...(samplePermissionsFor(installation)[1] as Permission).spec,
      capability: unwrap(parseCapability('cost.write')),
    };
    const costWriteGrant = grantPermission({
      tenantId: TENANT_A,
      installationId: INSTALLATION,
      appId: SAMPLE_MANIFEST.appId,
      spec: costWriteSpec,
      grantedAt: T0,
      grantedBy: adminActor(),
    });
    const commitBinding = unwrap(
      parseCommandBinding({
        kind: 'command-binding',
        commandName: 'cost.commitBudgetRevision',
        handler: {
          kind: 'app-handler',
          handlerId: 'commit-budget-handler',
          title: 'Commit budget revision',
          description: null,
        },
        actionClass: 'approval-required',
      }),
    );
    const record = expectOk(
      await appCommandDispatch(
        harness.deps,
        installation,
        [costWriteGrant],
        commitBinding,
        {
          command: commandEnvelopeOf({ commandName: 'cost.commitBudgetRevision' }),
          subject: {
            entityKind: unwrap(parseEntityKind('budget-revision')),
            entityId: INSTALLATION_C,
          },
          evidence: [
            { slot: 'justification', ref: 'just-0001' },
            { slot: 'margin-assessment', ref: 'margin-0001' },
          ],
          confidence: 'high',
        },
      ),
    );
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(0);
    expect(record.outcome.decision).toBe('routed-to-approval');
    if (record.outcome.decision === 'routed-to-approval') {
      expect(record.outcome.approval).toBeDefined();
    }
    expect(auditEventsOf(harness.appSink, APP_COMMAND_DISPATCHED_EVENT)).toHaveLength(1);
  });
});

// ----- the event path (typed delivery records + re-checks) ----------------------------------

describe('the event delivery path', () => {
  it('delivers a matching event and records the typed delivery record', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const event = eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' });
    const delivery = expectOk(
      await appEventDispatch(
        harness.deps,
        installation,
        samplePermissionsFor(installation),
        subscription(),
        event,
      ),
    );
    expect(delivery.kind).toBe('app-event-delivery');
    expect(delivery.installationId).toBe(INSTALLATION);
    expect(delivery.appId).toBe(SAMPLE_MANIFEST.appId);
    expect(delivery.eventName).toBe(event.eventName);
    expect(delivery.filter).toStrictEqual({ kind: 'entity-kind', entityKind: 'field-report' });
    expect(delivery.eventOccurredAt).toBe(event.occurredAt);
    expect(delivery.correlationId).toBe(event.causality.correlationId);
    expect(harness.countedGateway.calls.count).toBe(0);
    const delivered = auditEventsOf(harness.appSink, APP_EVENT_DELIVERED_EVENT);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.decision).toBe('event-delivered');
    expect(delivered[0]?.deliveryId).toBe(delivery.deliveryId);
  });

  it('typed-rejects an event the subscription did not declare (mismatch)', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const otherSubscription = unwrap(
      parseEventSubscription({
        kind: 'event-subscription',
        eventName: 'cost.costItemRecorded',
        filter: { kind: 'all' },
      }),
    );
    const result = await appEventDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      otherSubscription,
      eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    );
    expect(expectFail(result).details[0]?.code).toBe('subscription-mismatch');
    expect(auditEventsOf(harness.appSink, APP_EVENT_REJECTED_EVENT)[0]?.reason).toBe(
      'subscription-mismatch',
    );
  });

  it('typed-rejects when the typed filter does not match the occurrence', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const filtered = unwrap(
      parseEventSubscription({
        kind: 'event-subscription',
        eventName: 'work.progressRecorded',
        filter: { kind: 'entity-kind', entityKind: 'daily-log' },
      }),
    );
    const result = await appEventDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      filtered,
      eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    );
    expect(expectFail(result).details[0]?.code).toBe('filter-not-matched');
    expect(auditEventsOf(harness.appSink, APP_EVENT_REJECTED_EVENT)[0]?.reason).toBe(
      'filter-not-matched',
    );
  });

  it('typed-rejects events of areas with no declared read capability (fail-closed)', async () => {
    const harness = makeAppDispatchHarness();
    const installation = installationsByState().active;
    const internal = unwrap(
      parseEventSubscription({
        kind: 'event-subscription',
        eventName: 'actions.actionExecuted',
        filter: { kind: 'all' },
      }),
    );
    const result = await appEventDispatch(
      harness.deps,
      installation,
      samplePermissionsFor(installation),
      internal,
      eventEnvelopeOf({ eventName: 'actions.actionExecuted' }),
    );
    expect(expectFail(result).details[0]?.code).toBe('event-area-capability-unknown');
    expect(auditEventsOf(harness.appSink, APP_EVENT_REJECTED_EVENT)[0]?.reason).toBe(
      'event-area-capability-unknown',
    );
  });

  it('re-checks the grants at delivery: revoked and missing read capabilities deny', async () => {
    const event = eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' });
    const installation = installationsByState().active;
    const revokedRead = samplePermissionsFor(installation).map((grant) =>
      grant.spec.capability === 'work.read'
        ? expectOk(revokePermission(grant, { revokedBy: operatorActor(), now: T0 }))
        : grant,
    );
    const revokedHarness = makeAppDispatchHarness();
    const revoked = await appEventDispatch(
      revokedHarness.deps,
      installation,
      revokedRead,
      subscription(),
      event,
    );
    expect(expectFail(revoked).details[0]?.code).toBe('capability-revoked');
    expect(auditEventsOf(revokedHarness.appSink, APP_EVENT_REJECTED_EVENT)[0]?.reason).toBe(
      'capability-revoked',
    );
    const noneHarness = makeAppDispatchHarness();
    const none = await appEventDispatch(noneHarness.deps, installation, [], subscription(), event);
    expect(expectFail(none).details[0]?.code).toBe('capability-not-granted');
  });

  it('matchEventSubscription: all matches everything; entity-kind matches the occurrence', () => {
    const all = unwrap(
      parseEventSubscription({
        kind: 'event-subscription',
        eventName: 'work.progressRecorded',
        filter: { kind: 'all' },
      }),
    );
    const byKind = unwrap(
      parseEventSubscription({
        kind: 'event-subscription',
        eventName: 'work.progressRecorded',
        filter: { kind: 'entity-kind', entityKind: 'field-report' },
      }),
    );
    const withEntity = eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' });
    const withoutEntity = eventEnvelopeOf({ eventName: 'work.progressRecorded' });
    expect(matchEventSubscription(all, withEntity)).toBe(true);
    expect(matchEventSubscription(all, withoutEntity)).toBe(true);
    expect(matchEventSubscription(byKind, withEntity)).toBe(true);
    expect(matchEventSubscription(byKind, withoutEntity)).toBe(false);
  });
});
