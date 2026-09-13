// OFF-017 acceptance — the gateway's own audit trail: the closed event
// vocabulary, the DomainEventEnvelope discipline (freeze A3 — actor from the
// proposal, source 'system', causation from the proposal's idempotency key,
// correlation carried over, subject entity refs, schema version), the A4
// provenance fields, and THE EventSink port's in-memory/failing
// implementations.
import { describe, expect, it } from 'vitest';
import {
  parseCommandName,
  parseDomainEventEnvelope,
  parseEntityId,
  parseEventName,
  parseTimestamp,
} from '@office/contracts';
import {
  CORRELATION_ID,
  FAKE_EXECUTOR,
  SUBJECT_ID,
  envelope,
  subjectRef,
  unwrap,
} from './test-support';
import {
  ACTION_DECISIONS,
  ACTION_DENIED_EVENT,
  ACTION_DUPLICATE_OBSERVED_EVENT,
  ACTION_EVENT_NAMES,
  ACTION_EXECUTED_EVENT,
  ACTION_ROUTED_TO_APPROVAL_EVENT,
  actionEventEnvelope,
  auditPayloadBaseOf,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  withApprovalOnPayload,
} from './audit-events';
import type { ActionAuditPayload } from './audit-events';
import { proposal } from './test-support';

describe('the action event vocabulary (freeze A3)', () => {
  it('declares exactly the four decision events', () => {
    expect(ACTION_EVENT_NAMES).toEqual([
      ACTION_EXECUTED_EVENT,
      ACTION_ROUTED_TO_APPROVAL_EVENT,
      ACTION_DENIED_EVENT,
      ACTION_DUPLICATE_OBSERVED_EVENT,
    ]);
    expect(ACTION_EVENT_NAMES.map((name) => String(name))).toEqual([
      'actions.actionExecuted',
      'actions.actionRoutedToApproval',
      'actions.actionDenied',
      'actions.actionDuplicateObserved',
    ]);
  });

  it('every event name satisfies the canonical grammar', () => {
    for (const name of ACTION_EVENT_NAMES) {
      expect(parseEventName(name).ok).toBe(true);
    }
  });

  it('declares the decision vocabulary in order', () => {
    expect(ACTION_DECISIONS).toEqual([
      'executed',
      'routed-to-approval',
      'denied',
      'duplicate-observed',
    ]);
  });
});

describe('actionEventEnvelope (the A3/A4 envelope discipline)', () => {
  const command = envelope(
    { note: 'R-1' },
    unwrap(parseCommandName('field.recordProgress')),
    { key: 'audit-key-0001' },
  );
  const prop = proposal(command, {
    subject: subjectRef(),
    evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
    confidence: 'high',
  });

  const payload: ActionAuditPayload = auditPayloadBaseOf({
    proposal: prop,
    commandName: command.commandName,
    actionClass: 'reversible',
    decision: 'executed',
    requiredCapabilities: ['work.write'],
    policyRef: 'policy/field-progress@2',
    compensatingCommand: 'field.correctProgress',
  });

  const event = actionEventEnvelope({
    command,
    eventName: ACTION_EXECUTED_EVENT,
    payload,
    subject: prop.subject,
    occurredAt: unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
  });

  it('produces a contract-valid DomainEventEnvelope (self-validation)', () => {
    expect(parseDomainEventEnvelope(event).ok).toBe(true);
  });

  it('carries the proposal actor and scope, source system', () => {
    expect(event.actor).toEqual(command.actor);
    expect(event.scope).toEqual(command.scope);
    expect(event.source).toBe('system');
  });

  it('takes causation from the proposal (idempotency key) and carries correlation over', () => {
    expect(event.causality.causationId).toBe(command.idempotencyKey);
    expect(event.causality.correlationId).toBe(CORRELATION_ID);
  });

  it('carries the subject as before/after entity refs, or null when absent', () => {
    expect(event.entityRefs).toEqual({
      before: { entityKind: 'budget-revision', entityId: SUBJECT_ID },
      after: { entityKind: 'budget-revision', entityId: SUBJECT_ID },
    });
    const subjectless = actionEventEnvelope({
      command,
      eventName: ACTION_DENIED_EVENT,
      payload,
      subject: null,
      occurredAt: unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
    });
    expect(subjectless.entityRefs).toEqual({ before: null, after: null });
  });

  it('carries the declared gate and the proposal A4 provenance in the payload', () => {
    expect(event.payload).toEqual({
      commandName: 'field.recordProgress',
      actionClass: 'reversible',
      decision: 'executed',
      actorKind: 'user',
      actorId: command.actor.kind === 'system' ? null : command.actor.actorId,
      replayed: false,
      denialCode: null,
      requiredCapabilities: ['work.write'],
      policyRef: 'policy/field-progress@2',
      confidence: 'high',
      evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
      approval: null,
      approvalStatus: null,
      decidedBy: null,
      decidedAt: null,
      compensatingCommand: 'field.correctProgress',
    });
  });

  it('attaches approval provenance through withApprovalOnPayload', () => {
    const withApproval = withApprovalOnPayload(
      payload,
      {
        instanceId: unwrap(parseEntityId('office-ent-v1-0000000000000001')),
        approvalKey: 'action',
      },
      'approved',
      'office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4',
      unwrap(parseTimestamp('2026-09-12T10:16:05.000Z')),
    );
    expect(withApproval.approval).toEqual({
      instanceId: 'office-ent-v1-0000000000000001',
      approvalKey: 'action',
    });
    expect(withApproval.approvalStatus).toBe('approved');
    expect(withApproval.decidedBy).toBe(
      'office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4',
    );
    expect(withApproval.decidedAt).toBe('2026-09-12T10:16:05.000Z');
  });

  it('rejects an idempotency key that is not a causation id loudly', () => {
    const shortKeyCommand = { ...command, idempotencyKey: 'tiny' } as typeof command;
    expect(() =>
      actionEventEnvelope({
        command: shortKeyCommand,
        eventName: ACTION_DENIED_EVENT,
        payload,
        subject: null,
        occurredAt: unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
      }),
    ).toThrow(TypeError);
  });
});

describe('the in-memory EventSink (the port reference implementation)', () => {
  it('records appends with the caller executor, in order', async () => {
    const sink = createInMemoryEventSink();
    const command = envelope(
      {},
      unwrap(parseCommandName('cost.listCostItems')),
      { key: 'sink-key-0001' },
    );
    const event = actionEventEnvelope({
      command,
      eventName: ACTION_DUPLICATE_OBSERVED_EVENT,
      payload: auditPayloadBaseOf({
        proposal: proposal(command, {}),
        commandName: command.commandName,
        actionClass: 'read',
        decision: 'duplicate-observed',
        requiredCapabilities: ['cost.read'],
        policyRef: 'policy/cost-queries@1',
        compensatingCommand: null,
      }),
      subject: null,
      occurredAt: unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
    });
    const appended = await sink.appendEvents(FAKE_EXECUTOR, [event]);
    expect(appended.ok).toBe(true);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.executor).toBe(FAKE_EXECUTOR);
    expect(sink.events).toEqual([event]);
  });

  it('flattens events across appends', async () => {
    const sink = createInMemoryEventSink();
    const command = envelope(
      {},
      unwrap(parseCommandName('cost.listCostItems')),
      { key: 'sink-key-0002' },
    );
    for (const eventName of [ACTION_EXECUTED_EVENT, ACTION_DENIED_EVENT]) {
      const event = actionEventEnvelope({
        command,
        eventName,
        payload: auditPayloadBaseOf({
          proposal: proposal(command, {}),
          commandName: command.commandName,
          actionClass: 'read',
          decision: 'executed',
          requiredCapabilities: ['cost.read'],
          policyRef: 'policy/cost-queries@1',
          compensatingCommand: null,
        }),
        subject: null,
        occurredAt: unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
      });
      await sink.appendEvents(FAKE_EXECUTOR, [event]);
    }
    expect(sink.events).toHaveLength(2);
  });
});

describe('failingEventSink (the failure-path fixture)', () => {
  it('fails with the typed event-sink failure', async () => {
    const sink = failingEventSink('ledger unavailable');
    const appended = await sink.appendEvents(FAKE_EXECUTOR, []);
    expect(appended.ok).toBe(false);
    if (!appended.ok) {
      expect(appended.error.code).toBe('invariant-violation');
      expect(appended.error.details[0]?.code).toBe('event-sink-rejected');
    }
  });

  it('builds the typed failure directly', () => {
    const error = eventSinkFailure('nope');
    expect(error.code).toBe('invariant-violation');
    expect(error.message).toContain('nope');
  });
});
