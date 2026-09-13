// OFF-026 app-runtime — the audit-event vocabulary + THE AppEventSink port suite.
//
// The runtime's OWN audit trail: the nine APP_*_EVENT names, the closed
// decision vocabulary, the envelope builder (a contract-valid
// DomainEventEnvelope every time — source 'system', tenant scope, the
// installation's 'app' actor, full A4 causality), the command-causation
// convention, and THE AppEventSink port (appendEvents(executor, events) with
// the caller's transaction executor — the in-memory sink records appends,
// the failing sink fails typed, and a sink failure aborts the caller).
import { describe, expect, it } from 'vitest';
import { parseDomainEventEnvelope } from '@office/contracts';
import {
  APP_ACTIVATED_EVENT,
  APP_COMMAND_DISPATCHED_EVENT,
  APP_COMMAND_REJECTED_EVENT,
  APP_EVENT_DELIVERED_EVENT,
  APP_EVENT_REJECTED_EVENT,
  APP_INSTALLED_EVENT,
  APP_REVOKED_EVENT,
  APP_RUNTIME_DECISIONS,
  APP_RUNTIME_EVENT_NAMES,
  APP_SUSPENDED_EVENT,
  APP_UNINSTALLED_EVENT,
  appRuntimeEventEnvelope,
  appSinkFailure,
  commandCausationIdOf,
  createInMemoryAppEventSink,
  failingAppEventSink,
} from './audit-events';
import type { AppRuntimeAuditPayload } from './audit-events';
import {
  CORRELATION_ID,
  FAKE_EXECUTOR,
  INSTALLATION,
  SAMPLE_MANIFEST,
  TENANT_A,
  T0,
  appActorOf,
  commandEnvelopeOf,
  expectFail,
  expectOk,
} from './test-support';

const payload = (): AppRuntimeAuditPayload => ({
  installationId: INSTALLATION,
  appId: SAMPLE_MANIFEST.appId,
  tenantId: TENANT_A,
  installationState: 'active',
  decision: 'command-dispatched',
  commandName: 'field.recordProgress',
  handlerId: 'record-progress-handler',
  idempotencyKey: 'idem-00000001',
  eventName: null,
  reason: null,
  deliveryId: null,
  invokedHooks: [],
});

describe('the audit-event vocabulary (closed)', () => {
  it('is exactly the nine runtime event names, in order', () => {
    expect(APP_RUNTIME_EVENT_NAMES).toStrictEqual([
      'apps.appInstalled',
      'apps.appActivated',
      'apps.appSuspended',
      'apps.appRevoked',
      'apps.appUninstalled',
      'apps.appCommandDispatched',
      'apps.appCommandRejected',
      'apps.appEventDelivered',
      'apps.appEventRejected',
    ]);
    expect(APP_INSTALLED_EVENT).toBe('apps.appInstalled');
    expect(APP_ACTIVATED_EVENT).toBe('apps.appActivated');
    expect(APP_SUSPENDED_EVENT).toBe('apps.appSuspended');
    expect(APP_REVOKED_EVENT).toBe('apps.appRevoked');
    expect(APP_UNINSTALLED_EVENT).toBe('apps.appUninstalled');
    expect(APP_COMMAND_DISPATCHED_EVENT).toBe('apps.appCommandDispatched');
    expect(APP_COMMAND_REJECTED_EVENT).toBe('apps.appCommandRejected');
    expect(APP_EVENT_DELIVERED_EVENT).toBe('apps.appEventDelivered');
    expect(APP_EVENT_REJECTED_EVENT).toBe('apps.appEventRejected');
  });

  it('is exactly the nine runtime decisions, in order', () => {
    expect(APP_RUNTIME_DECISIONS).toStrictEqual([
      'installed',
      'activated',
      'suspended',
      'revoked',
      'uninstalled',
      'command-dispatched',
      'command-rejected',
      'event-delivered',
      'event-rejected',
    ]);
  });
});

describe('appRuntimeEventEnvelope (the builder)', () => {
  it('produces a contract-valid DomainEventEnvelope every time', () => {
    const envelope = appRuntimeEventEnvelope({
      eventName: APP_COMMAND_DISPATCHED_EVENT,
      payload: payload(),
      actor: appActorOf(INSTALLATION),
      tenantId: TENANT_A,
      correlationId: CORRELATION_ID,
      causationId: null,
      occurredAt: T0,
    });
    // The envelope satisfies the canonical contract (fail-closed parse).
    expect(parseDomainEventEnvelope(envelope).ok).toBe(true);
    expect(envelope.kind).toBe('event');
    expect(envelope.eventName).toBe('apps.appCommandDispatched');
    // The runtime is platform execution machinery: source 'system', the
    // installation's tenant scope, the installation's 'app' actor.
    expect(envelope.source).toBe('system');
    expect(envelope.scope).toStrictEqual({ kind: 'tenant', tenantId: TENANT_A });
    expect(envelope.actor).toStrictEqual(appActorOf(INSTALLATION));
    expect(envelope.causality).toStrictEqual({
      correlationId: CORRELATION_ID,
      causationId: null,
    });
    expect(envelope.occurredAt).toBe(T0);
    expect(envelope.payload).toStrictEqual(payload());
  });

  it('carries full A4 causality when the audited decision was caused', () => {
    // A chained audit decision: caused by a dispatched command — its
    // causation id is the command's idempotency key (the convention).
    const causedBy = commandCausationIdOf(
      commandEnvelopeOf({ commandName: 'field.recordProgress' }),
    );
    const envelope = appRuntimeEventEnvelope({
      eventName: APP_SUSPENDED_EVENT,
      payload: { ...payload(), decision: 'suspended', invokedHooks: [{ hook: 'on-suspend', handlerId: 'suspend-hook' }] },
      actor: appActorOf(INSTALLATION),
      tenantId: TENANT_A,
      correlationId: CORRELATION_ID,
      causationId: causedBy,
      occurredAt: T0,
    });
    expect(envelope.causality.causationId).toBe(causedBy);
    expect(envelope.causality.correlationId).toBe(CORRELATION_ID);
    expect(envelope.payload.invokedHooks).toStrictEqual([
      { hook: 'on-suspend', handlerId: 'suspend-hook' },
    ]);
  });

  it('is deterministic: the same inputs build the byte-identical envelope', () => {
    const build = () =>
      appRuntimeEventEnvelope({
        eventName: APP_EVENT_DELIVERED_EVENT,
        payload: payload(),
        actor: appActorOf(INSTALLATION),
        tenantId: TENANT_A,
        correlationId: CORRELATION_ID,
        causationId: null,
        occurredAt: T0,
      });
    expect(build()).toStrictEqual(build());
  });
});

describe('commandCausationIdOf (the command-caused audit convention)', () => {
  it('derives the causation id from the command\u2019s idempotency key', () => {
    const command = commandEnvelopeOf({ commandName: 'field.recordProgress' });
    expect(commandCausationIdOf(command)).toBe(command.idempotencyKey);
  });

  it('throws loudly on an idempotency key outside the causation grammar', () => {
    const valid = commandEnvelopeOf({ commandName: 'field.recordProgress' });
    const invalid = { ...valid, idempotencyKey: 'NOT A CAUSATION ID!' } as typeof valid;
    expect(() => commandCausationIdOf(invalid)).toThrow(TypeError);
  });
});

describe('THE AppEventSink port', () => {
  it('the in-memory sink records appends with the caller\u2019s executor, in order', async () => {
    const sink = createInMemoryAppEventSink();
    const first = appRuntimeEventEnvelope({
      eventName: APP_INSTALLED_EVENT,
      payload: payload(),
      actor: appActorOf(INSTALLATION),
      tenantId: TENANT_A,
      correlationId: CORRELATION_ID,
      causationId: null,
      occurredAt: T0,
    });
    const second = appRuntimeEventEnvelope({
      eventName: APP_ACTIVATED_EVENT,
      payload: { ...payload(), decision: 'activated' },
      actor: appActorOf(INSTALLATION),
      tenantId: TENANT_A,
      correlationId: CORRELATION_ID,
      causationId: null,
      occurredAt: T0,
    });
    expectOk(await sink.appendEvents(FAKE_EXECUTOR, [first]));
    expectOk(await sink.appendEvents(FAKE_EXECUTOR, [second, first]));
    expect(sink.appends).toHaveLength(2);
    expect(sink.appends[0]?.executor).toBe(FAKE_EXECUTOR);
    expect(sink.appends[0]?.events).toStrictEqual([first]);
    expect(sink.events).toStrictEqual([first, second, first]);
  });

  it('the failing sink fails typed with the built error', async () => {
    const sink = failingAppEventSink('audit unavailable');
    const failure = expectFail(
      await sink.appendEvents(FAKE_EXECUTOR, [
        appRuntimeEventEnvelope({
          eventName: APP_INSTALLED_EVENT,
          payload: payload(),
          actor: appActorOf(INSTALLATION),
          tenantId: TENANT_A,
          correlationId: CORRELATION_ID,
          causationId: null,
          occurredAt: T0,
        }),
      ]),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('app-event-sink-rejected');
    expect(failure.message).toContain('audit unavailable');
  });

  it('appSinkFailure builds the typed sink failure deterministically', () => {
    const failure = appSinkFailure('reason-here', {
      scope: { kind: 'tenant', tenantId: TENANT_A },
    });
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.message).toBe('reason-here');
    expect(failure.scope).toStrictEqual({ kind: 'tenant', tenantId: TENANT_A });
    expect(appSinkFailure('reason-here')).toStrictEqual(appSinkFailure('reason-here'));
  });
});
