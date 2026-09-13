// OFF-026 app-runtime — the composed runtime engine acceptance suite.
//
// createAppRuntime over the in-memory store: the audited install flow (the
// installation record + the manifest's permission grants + the namespace
// entries + the on-install hook, all-or-nothing), the audited lifecycle
// transitions (install → active → suspended → revoked / uninstalled with
// their hook invocations), THE engine-level acceptance (a suspended
// installation receives no commands and no events; re-activation restores
// dispatch; revocation is one-way), the fan-out delivery, the A9 grant
// lifecycle through the engine, the all-or-nothing sink-failure abort, and
// A11 (a successful dispatch mutates nothing in the runtime's own store —
// the canonical effect travelled through the gateway only).
import { describe, expect, it } from 'vitest';
import { actionDescriptorSource } from '@office/app-sdk';
import type { PermissionId } from '@office/app-sdk';
import { createInMemoryActionRegistry } from '@office/actions';
import type { ActionGateway } from '@office/actions';
import { createAppRuntime } from './runtime';
import type { AppRuntimeDeps } from './runtime';
import {
  APP_ACTIVATED_EVENT,
  APP_COMMAND_DISPATCHED_EVENT,
  APP_COMMAND_REJECTED_EVENT,
  APP_EVENT_DELIVERED_EVENT,
  APP_EVENT_REJECTED_EVENT,
  APP_INSTALLED_EVENT,
  APP_REVOKED_EVENT,
  APP_SUSPENDED_EVENT,
  APP_UNINSTALLED_EVENT,
  failingAppEventSink,
} from './audit-events';
import type { AppRuntimeAuditPayload, InMemoryAppEventSink } from './audit-events';
import type { EventName } from '@office/contracts';
import {
  CANONICAL_DESCRIPTORS,
  CORRELATION_ID,
  FAKE_EXECUTOR,
  INSTALLATION,
  INSTALLATION_C,
  SAMPLE_MANIFEST,
  TENANT_A,
  TENANT_B,
  T0,
  adminActor,
  allowAllPolicy,
  commandEnvelopeOf,
  eventEnvelopeOf,
  expectFail,
  expectOk,
  makeAppRuntimeHarness,
  operatorActor,
  sampleHooks,
  workWritePermissionId,
} from './test-support';
import type { AppRuntimeHarness } from './test-support';

/** The audit payloads of one runtime event name, in order. */
const auditEventsOf = (sink: InMemoryAppEventSink, name: EventName): AppRuntimeAuditPayload[] =>
  sink.events
    .filter((event) => event.eventName === name)
    .map((event) => event.payload as AppRuntimeAuditPayload);

/** Install + activate the sample app for tenant A (the base engine flow). */
const activeInstallationFlow = async (harness: AppRuntimeHarness) => {
  const installed = expectOk(
    await harness.runtime.install({
      manifest: SAMPLE_MANIFEST,
      tenantId: TENANT_A,
      hooks: sampleHooks(),
      installedBy: adminActor(),
      correlationId: CORRELATION_ID,
    }),
  );
  const installationId = installed.installation.installationId;
  expectOk(
    await harness.runtime.activate({ installationId, correlationId: CORRELATION_ID }),
  );
  return { installed, installationId };
};

/** The fully-authorized recordProgress dispatch request. */
const dispatchRequest = (installationId: typeof INSTALLATION) => ({
  installationId,
  command: commandEnvelopeOf({ installationId, commandName: 'field.recordProgress' }),
  evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
  confidence: 'medium' as const,
});

describe('the audited install flow (all-or-nothing)', () => {
  it('creates the installation, the grants, the namespace, and the on-install hook', async () => {
    const harness = makeAppRuntimeHarness();
    const { installed, installationId } = await activeInstallationFlow(harness);
    // The install record itself is the 'installing' snapshot; the store
    // holds the activated record.
    expect(installed.installation.state).toBe('installing');
    expect(harness.store.installations.find(installationId)?.state).toBe('active');
    expect(installed.installation.tenantId).toBe(TENANT_A);
    expect(installed.installation.appId).toBe(SAMPLE_MANIFEST.appId);
    expect(installed.installation.manifestVersion).toBe(SAMPLE_MANIFEST.manifestVersion);
    // The manifest's two declared permissions became deterministic grants.
    expect(installed.permissions.map((grant) => grant.spec.capability)).toStrictEqual([
      'work.read',
      'work.write',
    ]);
    // The manifest's binding and subscription registered under the namespace.
    expect(installed.commands.map((entry) => entry.commandName)).toStrictEqual([
      'field.recordProgress',
    ]);
    expect(installed.events.map((entry) => entry.eventName)).toStrictEqual([
      'work.progressRecorded',
    ]);
    // The on-install hook was invoked (symbolically — a descriptor record).
    expect(installed.invokedHooks.map((invocation) => invocation.hook)).toStrictEqual([
      'on-install',
    ]);
    // The store holds exactly what the record says.
    expect(harness.store.installations.find(installationId)?.state).toBe('active');
    expect(harness.store.permissions.ofInstallation(installationId)).toHaveLength(2);
    expect(harness.store.namespace.commandsOf(installationId)).toHaveLength(1);
    expect(harness.store.namespace.eventsOf(installationId)).toHaveLength(1);
    // The audit trail: installed then activated, in order.
    expect(auditEventsOf(harness.appSink, APP_INSTALLED_EVENT)).toHaveLength(1);
    expect(auditEventsOf(harness.appSink, APP_ACTIVATED_EVENT)).toHaveLength(1);
    expect(harness.appSink.events.map((event) => event.eventName)).toStrictEqual([
      APP_INSTALLED_EVENT,
      APP_ACTIVATED_EVENT,
    ]);
  });

  it('typed-rejects re-installing an existing installation id (new identity required)', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const again = await harness.runtime.install({
      manifest: SAMPLE_MANIFEST,
      tenantId: TENANT_A,
      installationId,
      installedBy: adminActor(),
      correlationId: CORRELATION_ID,
    });
    expect(expectFail(again).details[0]?.code).toBe('installation-exists');
  });

  it('aborts all-or-nothing when the audit sink fails (nothing is stored)', async () => {
    const neverGateway: ActionGateway = {
      executeAction: async () => {
        throw new Error('the gateway must never be reached in this test');
      },
    };
    const deps: AppRuntimeDeps = {
      gateway: neverGateway,
      actions: actionDescriptorSource(createInMemoryActionRegistry([...CANONICAL_DESCRIPTORS])),
      sink: failingAppEventSink('audit unavailable'),
      executor: FAKE_EXECUTOR,
      policy: allowAllPolicy,
      now: () => T0,
      newDeliveryId: () => INSTALLATION_C,
      newInstallationId: () => INSTALLATION,
    };
    const runtime = createAppRuntime(deps);
    const failed = await runtime.install({
      manifest: SAMPLE_MANIFEST,
      tenantId: TENANT_A,
      installedBy: adminActor(),
      correlationId: CORRELATION_ID,
    });
    const failure = expectFail(failed);
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('app-event-sink-rejected');
    // The store stayed untouched — no installation, no grants, no namespace.
    expect(runtime.store.installations.installations()).toStrictEqual([]);
    expect(runtime.store.permissions.ofInstallation(INSTALLATION)).toStrictEqual([]);
    expect(runtime.store.namespace.commandsOf(INSTALLATION)).toStrictEqual([]);
  });

  it('is deterministic: two identically-built engines install the same identity', async () => {
    const first = makeAppRuntimeHarness();
    const second = makeAppRuntimeHarness();
    const a = expectOk(
      await first.runtime.install({
        manifest: SAMPLE_MANIFEST,
        tenantId: TENANT_A,
        installedBy: adminActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    const b = expectOk(
      await second.runtime.install({
        manifest: SAMPLE_MANIFEST,
        tenantId: TENANT_A,
        installedBy: adminActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expect(a.installation).toStrictEqual(b.installation);
    expect(a.permissions).toStrictEqual(b.permissions);
  });
});

describe('the audited lifecycle transitions (engine level)', () => {
  it('install → active → suspended → revoked, each audited with its hook', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const suspended = expectOk(
      await harness.runtime.suspend({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expect(suspended.installation.state).toBe('suspended');
    expect(suspended.invokedHooks.map((invocation) => invocation.hook)).toStrictEqual(['on-suspend']);
    const revoked = expectOk(
      await harness.runtime.revoke({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expect(revoked.installation.state).toBe('revoked');
    expect(revoked.invokedHooks.map((invocation) => invocation.hook)).toStrictEqual(['on-revoke']);
    // The suspension snapshot cleared on revocation; the store followed.
    expect(revoked.installation.suspendedAt).toBeNull();
    expect(harness.store.installations.find(installationId)?.state).toBe('revoked');
    // The audit trail carries the transitions with their hook invocations.
    const suspendedAudit = auditEventsOf(harness.appSink, APP_SUSPENDED_EVENT);
    expect(suspendedAudit).toHaveLength(1);
    expect(suspendedAudit[0]?.invokedHooks).toStrictEqual([{ hook: 'on-suspend', handlerId: 'suspend-hook' }]);
    const revokedAudit = auditEventsOf(harness.appSink, APP_REVOKED_EVENT);
    expect(revokedAudit).toHaveLength(1);
    expect(revokedAudit[0]?.invokedHooks).toStrictEqual([{ hook: 'on-revoke', handlerId: 'revoke-hook' }]);
  });

  it('uninstalls (terminal, no hook) and audits the uninstall', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const uninstalled = expectOk(
      await harness.runtime.uninstall({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expect(uninstalled.installation.state).toBe('uninstalled');
    expect(uninstalled.invokedHooks).toStrictEqual([]);
    expect(auditEventsOf(harness.appSink, APP_UNINSTALLED_EVENT)).toHaveLength(1);
  });

  it('typed-rejects transitions of unknown installations and missing operators', async () => {
    const harness = makeAppRuntimeHarness();
    const unknown = await harness.runtime.suspend({
      installationId: INSTALLATION,
      by: operatorActor(),
      correlationId: CORRELATION_ID,
    });
    expect(expectFail(unknown).details[0]?.code).toBe('unknown-installation');
    const { installationId } = await activeInstallationFlow(harness);
    const noOperator = await harness.runtime.suspend({
      installationId,
      correlationId: CORRELATION_ID,
    });
    expect(expectFail(noOperator).details[0]?.code).toBe('operator-required');
  });

  it('the lifecycle never touches the gateway (A8 counting at the engine level)', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    expectOk(
      await harness.runtime.suspend({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expectOk(
      await harness.runtime.activate({ installationId, correlationId: CORRELATION_ID }),
    );
    expectOk(
      await harness.runtime.revoke({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
  });
});

describe('THE engine-level acceptance — suspension, re-activation, revocation', () => {
  it('dispatches a fully-authorized command through the gateway exactly once', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const record = expectOk(await harness.runtime.dispatchCommand(dispatchRequest(installationId)));
    expect(record.outcome.decision).toBe('executed');
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(1);
    expect(auditEventsOf(harness.appSink, APP_COMMAND_DISPATCHED_EVENT)).toHaveLength(1);
  });

  it('a SUSPENDED installation receives no commands and no events (audited)', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    expectOk(
      await harness.runtime.suspend({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    const command = await harness.runtime.dispatchCommand(dispatchRequest(installationId));
    expect(expectFail(command).details[0]?.code).toBe('installation-suspended');
    const event = await harness.runtime.dispatchEvent({
      installationId,
      event: eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    });
    expect(expectFail(event).details[0]?.code).toBe('installation-suspended');
    // The audit trail records BOTH suspension rejections with their reasons.
    const rejectedCommands = auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT);
    expect(rejectedCommands).toHaveLength(1);
    expect(rejectedCommands[0]?.reason).toBe('installation-suspended');
    const rejectedEvents = auditEventsOf(harness.appSink, APP_EVENT_REJECTED_EVENT);
    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0]?.reason).toBe('installation-suspended');
    // Nothing reached the gateway.
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
  });

  it('re-activation restores dispatch on both paths', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    expectOk(
      await harness.runtime.suspend({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expectOk(await harness.runtime.activate({ installationId, correlationId: CORRELATION_ID }));
    expectOk(await harness.runtime.dispatchCommand(dispatchRequest(installationId)));
    expectOk(
      await harness.runtime.dispatchEvent({
        installationId,
        event: eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
      }),
    );
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(1);
    expect(auditEventsOf(harness.appSink, APP_EVENT_DELIVERED_EVENT)).toHaveLength(1);
  });

  it('revocation is permanent: no dispatch, no re-activation, at the engine level', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    expectOk(
      await harness.runtime.revoke({
        installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    const command = await harness.runtime.dispatchCommand(dispatchRequest(installationId));
    expect(expectFail(command).details[0]?.code).toBe('installation-revoked');
    const reactivation = await harness.runtime.activate({
      installationId,
      correlationId: CORRELATION_ID,
    });
    expect(expectFail(reactivation).details[0]?.code).toBe('revocation-terminal');
    expect(harness.store.installations.find(installationId)?.state).toBe('revoked');
    expect(harness.countedGateway.calls.count).toBe(0);
  });

  it('typed-rejects dispatch for unknown installations and unregistered commands', async () => {
    const harness = makeAppRuntimeHarness();
    const unknown = await harness.runtime.dispatchCommand(dispatchRequest(INSTALLATION));
    expect(expectFail(unknown).details[0]?.code).toBe('unknown-installation');
    const { installationId } = await activeInstallationFlow(harness);
    const unregistered = await harness.runtime.dispatchCommand({
      installationId,
      command: commandEnvelopeOf({ installationId, commandName: 'cost.listCostItems' }),
      evidence: [],
      confidence: 'low',
    });
    expect(expectFail(unregistered).details[0]?.code).toBe('unknown-binding');
    const unknownEvent = await harness.runtime.dispatchEvent({
      installationId,
      event: eventEnvelopeOf({ eventName: 'cost.costItemRecorded' }),
    });
    expect(expectFail(unknownEvent).details[0]?.code).toBe('unknown-subscription');
  });

  it('enforces A12 at the engine level: a cross-tenant command never dispatches', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const result = await harness.runtime.dispatchCommand({
      installationId,
      command: commandEnvelopeOf({
        installationId,
        commandName: 'field.recordProgress',
        scope: { kind: 'tenant', tenantId: TENANT_B },
      }),
      evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
      confidence: 'medium',
    });
    expect(expectFail(result).details[0]?.code).toBe('cross-tenant-scope');
    expect(harness.countedGateway.calls.count).toBe(0);
  });
});

describe('the fan-out delivery (dispatchEventToSubscribers)', () => {
  it('delivers to every subscribed installation, each with its typed outcome', async () => {
    const harness = makeAppRuntimeHarness();
    // Two installations of the sample app in tenant A.
    const first = expectOk(
      await harness.runtime.install({
        manifest: SAMPLE_MANIFEST,
        tenantId: TENANT_A,
        installedBy: adminActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    const second = expectOk(
      await harness.runtime.install({
        manifest: SAMPLE_MANIFEST,
        tenantId: TENANT_A,
        installedBy: adminActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    expectOk(
      await harness.runtime.activate({
        installationId: first.installation.installationId,
        correlationId: CORRELATION_ID,
      }),
    );
    expectOk(
      await harness.runtime.activate({
        installationId: second.installation.installationId,
        correlationId: CORRELATION_ID,
      }),
    );
    // Suspend the second: the fan-out must skip it (typed rejection).
    expectOk(
      await harness.runtime.suspend({
        installationId: second.installation.installationId,
        by: operatorActor(),
        correlationId: CORRELATION_ID,
      }),
    );
    const outcomes = await harness.runtime.dispatchEventToSubscribers(
      eventEnvelopeOf({ eventName: 'work.progressRecorded', entityKind: 'field-report' }),
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.ok).toBe(true);
    const suspendedOutcome = outcomes[1];
    expect(suspendedOutcome?.ok).toBe(false);
    if (suspendedOutcome !== undefined && !suspendedOutcome.ok) {
      expect(suspendedOutcome.error.details[0]?.code).toBe('installation-suspended');
    }
    // One delivery record, one audited rejection, no gateway call.
    expect(auditEventsOf(harness.appSink, APP_EVENT_DELIVERED_EVENT)).toHaveLength(1);
    expect(auditEventsOf(harness.appSink, APP_EVENT_REJECTED_EVENT)).toHaveLength(1);
    expect(harness.countedGateway.calls.count).toBe(0);
  });

  it('returns an empty outcome list for an event nobody subscribes to', async () => {
    const harness = makeAppRuntimeHarness();
    const outcomes = await harness.runtime.dispatchEventToSubscribers(
      eventEnvelopeOf({ eventName: 'cost.costItemRecorded' }),
    );
    expect(outcomes).toStrictEqual([]);
  });
});

describe('the A9 grant lifecycle through the engine', () => {
  it('revoking a grant denies subsequent command dispatch (typed, before the gateway)', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const permissionId = workWritePermissionId(installationId) as PermissionId;
    const revoked = expectOk(
      await harness.runtime.revokePermission({
        installationId,
        permissionId,
        revokedBy: operatorActor(),
      }),
    );
    expect(revoked.state).toBe('revoked');
    const dispatch = await harness.runtime.dispatchCommand(dispatchRequest(installationId));
    expect(expectFail(dispatch).details[0]?.code).toBe('capability-revoked');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.handlerInvocations.count).toBe(0);
    expect(auditEventsOf(harness.appSink, APP_COMMAND_REJECTED_EVENT)[0]?.reason).toBe(
      'capability-revoked',
    );
  });

  it('typed-rejects revoking an unknown permission or one of an unknown installation', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const unknown = await harness.runtime.revokePermission({
      installationId,
      permissionId: workWritePermissionId(INSTALLATION) as PermissionId,
      revokedBy: operatorActor(),
    });
    expect(expectFail(unknown).details[0]?.code).toBe('unknown-permission');
    const foreign = await harness.runtime.revokePermission({
      installationId: INSTALLATION,
      permissionId: workWritePermissionId(installationId) as PermissionId,
      revokedBy: operatorActor(),
    });
    expect(expectFail(foreign).details[0]?.code).toBe('unknown-installation');
  });
});

describe('A11 — the runtime composes the canonical graph only', () => {
  it('a successful dispatch mutates nothing in the runtime\u2019s own store', async () => {
    const harness = makeAppRuntimeHarness();
    const { installationId } = await activeInstallationFlow(harness);
    const installationsBefore = harness.store.installations.installations();
    const permissionsBefore = harness.store.permissions.ofInstallation(installationId);
    const commandsBefore = harness.store.namespace.commandsOf(installationId);
    expectOk(await harness.runtime.dispatchCommand(dispatchRequest(installationId)));
    // The canonical effect travelled through the gateway (one call, one
    // handler invocation); the runtime's own bookkeeping is untouched.
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations.count).toBe(1);
    expect(harness.store.installations.installations()).toStrictEqual(installationsBefore);
    expect(harness.store.permissions.ofInstallation(installationId)).toStrictEqual(permissionsBefore);
    expect(harness.store.namespace.commandsOf(installationId)).toStrictEqual(commandsBefore);
    // ...and the store holds ONLY runtime records: the installation snapshot,
    // the grants, the namespace entries — never a canonical project entity.
    const activeRecord = harness.store.installations.find(installationId);
    expect(harness.store.installations.installations()).toStrictEqual([activeRecord]);
    expect(activeRecord?.kind).toBe('app-installation');
    expect(activeRecord?.state).toBe('active');
  });
});
