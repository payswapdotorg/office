// Office agent runtime — execution records: the agent's OWN audit trail (OFF-018).
//
// Every agent run emits immutable DomainEventEnvelopes through the
// AgentEventSink port — the agent's OWN audit trail, distinct from (and in
// addition to) the action gateway's own audit events for every proposal the
// run submits:
//
//   agents.agentRunStarted            — the run began (goal, actor, tools);
//   agents.agentEvidenceGathered      — the run grounded on its evidence
//                                        (every item with its retrieval);
//   agents.agentActionProposed        — one typed proposal validated
//                                        (command, evidence refs, confidence,
//                                        rationale);
//   agents.agentGatewayDecisionRecorded — the gateway's decision, verbatim
//                                        (executed / routed-to-approval /
//                                        denied, replayed, approval state);
//   agents.agentRunCompleted          — the run reached a terminal state
//                                        (only after approval resolution when
//                                        a proposal routed).
//
// Causality (A3): the run's lifecycle events are caused by the run id (the
// run causes its own trail); the proposal/decision events are caused by the
// proposal's idempotency key (the same convention the gateway's own audit
// events use). The correlation id of the run's input flows through every
// event. The actor of every event is the run's AGENT actor (kind 'agent',
// actorId — the A4 source identity); the source is 'system' (the runtime is
// platform execution machinery acting on the agent's behalf — the same
// convention the gateway's audit events use).
//
// THE AgentEventSink PORT mirrors the landed packages' EventSink shape
// byte-for-byte in structure (appendEvents(executor, events) inside the
// CALLER's transaction): a real implementation (the OFF-005 event ledger
// wired by the runtime) writes the agent's audit trail atomically with the
// action's effects. An append failure aborts the surrounding run phase typed.
import {
  CURRENT_SCHEMA_VERSION,
  parseCausationId,
  parseDomainEventEnvelope,
} from '@office/contracts';
import type {
  Actor,
  ActorKind,
  CausationId,
  CorrelationId,
  DomainEventEnvelope,
  EntityRef,
  EntityRefs,
  EventName,
  Scope,
  Timestamp,
} from '@office/contracts';
import { parseEventName, parseFail, parseOk, parseTimestamp } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { ActionDecision } from '@office/actions';
import {
  AGENT_EVIDENCE_GATHERED_EVENT,
  AGENT_RUN_COMPLETED_EVENT,
  AGENT_RUN_STARTED_EVENT,
} from './vocabulary';
import type { AgentRunStatus } from './vocabulary';
import { describeValue, isPlainObject, requireFieldWith, requireString, unknownKeyFailure } from './parse';
import type { StringRule } from './parse';

// ----- the audit payload vocabulary ------------------------------------------------------------

/** Every agent-run audit decision kind, in vocabulary order. */
export type AgentAuditDecision = 'executed' | 'routed-to-approval' | 'denied';

/** Every agent-run audit decision kind, in vocabulary order. */
export const AGENT_AUDIT_DECISIONS: readonly AgentAuditDecision[] = [
  'executed',
  'routed-to-approval',
  'denied',
] as const;

const RUN_ID_PATTERN = /^[\x21-\x7e]{8,128}$/;

const RUN_ID_RULE: StringRule = {
  min: 8,
  max: 128,
  pattern: RUN_ID_PATTERN,
  description: 'agent run id: opaque printable-ASCII token (no whitespace)',
};

const GOAL_RULE: StringRule = { min: 1, max: 2000, description: 'agent goal' };

const TOOL_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,63}$/;

const TOOL_NAME_RULE: StringRule = {
  min: 3,
  max: 64,
  pattern: TOOL_NAME_PATTERN,
  description: 'tool name: lowercase kebab-case (3..64)',
};

/** The payload of the run-started audit event. */
export interface AgentRunStartedPayload {
  readonly runId: string;
  readonly goal: string;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly modelId: string;
  readonly tools: readonly string[];
  readonly correlationId: string;
}

const RUN_STARTED_KEYS = [
  'runId',
  'goal',
  'actorKind',
  'actorId',
  'modelId',
  'tools',
  'correlationId',
] as const;

const RUN_STARTED_GRAMMAR =
  'AgentRunStartedPayload: { runId, goal, actorKind, actorId, modelId, tools: string[], correlationId }';

/** Parse an untrusted value as an AgentRunStartedPayload (fail-closed). */
export function parseRunStartedPayload(raw: unknown): ParseResult<AgentRunStartedPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RUN_STARTED_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RUN_STARTED_KEYS, '', RUN_STARTED_GRAMMAR);
  if (unknownKey) return unknownKey;
  const runId = requireString(raw, 'runId', '', RUN_ID_RULE);
  if (!runId.ok) return runId;
  const goal = requireString(raw, 'goal', '', GOAL_RULE);
  if (!goal.ok) return goal;
  const actorKind = raw['actorKind'];
  if (typeof actorKind !== 'string' || !['user', 'agent', 'app', 'adapter', 'system'].includes(actorKind)) {
    return parseFail('invalid-value', 'actorKind', "actor kind ('user' | 'agent' | 'app' | 'adapter' | 'system')", describeValue(actorKind));
  }
  const actorIdRaw = raw['actorId'];
  if (actorIdRaw !== undefined && actorIdRaw !== null && typeof actorIdRaw !== 'string') {
    return parseFail('invalid-type', 'actorId', 'canonical actor id or null', describeValue(actorIdRaw));
  }
  const modelId = requireString(raw, 'modelId', '', { min: 1, max: 200, description: 'model source identity' });
  if (!modelId.ok) return modelId;
  const toolsRaw = raw['tools'];
  if (!Array.isArray(toolsRaw)) {
    return parseFail('invalid-type', 'tools', 'array of tool names', describeValue(toolsRaw));
  }
  const tools: string[] = [];
  for (const [index, tool] of toolsRaw.entries()) {
    if (typeof tool !== 'string' || !TOOL_NAME_PATTERN.test(tool)) {
      return parseFail('invalid-value', `tools[${index}]`, TOOL_NAME_RULE.description, describeValue(tool));
    }
    tools.push(tool);
  }
  const correlationId = requireString(raw, 'correlationId', '', {
    min: 8,
    max: 128,
    pattern: /^[\x21-\x7e]{8,128}$/,
    description: 'correlation id: opaque printable-ASCII token (no whitespace)',
  });
  if (!correlationId.ok) return correlationId;
  return parseOk(
    {
      runId: runId.value,
      goal: goal.value,
      actorKind: actorKind as ActorKind,
      actorId: actorIdRaw === undefined ? null : (actorIdRaw as string | null),
      modelId: modelId.value,
      tools,
      correlationId: correlationId.value,
    } satisfies AgentRunStartedPayload,
  );
}

/** One evidence-item summary of the evidence-gathered payload. */
export interface EvidenceItemSummary {
  readonly kind: string;
  readonly ref: string;
  readonly tool: string;
  readonly retrievedAt: Timestamp;
}

/** The payload of the evidence-gathered audit event. */
export interface AgentEvidenceGatheredPayload {
  readonly runId: string;
  readonly items: readonly EvidenceItemSummary[];
}

const EVIDENCE_GATHERED_KEYS = ['runId', 'items'] as const;
const EVIDENCE_GATHERED_GRAMMAR =
  'AgentEvidenceGatheredPayload: { runId, items: { kind, ref, tool, retrievedAt }[] }';

/** Parse an untrusted value as an AgentEvidenceGatheredPayload (fail-closed). */
export function parseEvidenceGatheredPayload(
  raw: unknown,
): ParseResult<AgentEvidenceGatheredPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_GATHERED_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, EVIDENCE_GATHERED_KEYS, '', EVIDENCE_GATHERED_GRAMMAR);
  if (unknownKey) return unknownKey;
  const runId = requireString(raw, 'runId', '', RUN_ID_RULE);
  if (!runId.ok) return runId;
  const itemsRaw = raw['items'];
  if (!Array.isArray(itemsRaw)) {
    return parseFail('invalid-type', 'items', 'array of evidence item summaries', describeValue(itemsRaw));
  }
  const items: EvidenceItemSummary[] = [];
  for (const [index, element] of itemsRaw.entries()) {
    const elementPath = `items[${index}]`;
    if (!isPlainObject(element)) {
      return parseFail('invalid-type', elementPath, 'evidence item summary', describeValue(element));
    }
    const kind = requireString(element, 'kind', elementPath, {
      min: 1,
      max: 64,
      pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
      description: 'evidence item kind (kebab)',
    });
    if (!kind.ok) return kind;
    const ref = requireString(element, 'ref', elementPath, {
      min: 1,
      max: 128,
      pattern: /^[\x21-\x7e]{1,128}$/,
      description: 'evidence reference: opaque printable-ASCII token (1..128)',
    });
    if (!ref.ok) return ref;
    const tool = requireString(element, 'tool', elementPath, TOOL_NAME_RULE);
    if (!tool.ok) return tool;
    const retrievedAt = requireFieldWith(element, 'retrievedAt', elementPath, parseTimestamp);
    if (!retrievedAt.ok) return retrievedAt;
    items.push({ kind: kind.value, ref: ref.value, tool: tool.value, retrievedAt: retrievedAt.value });
  }
  return parseOk({ runId: runId.value, items } satisfies AgentEvidenceGatheredPayload);
}

/** The payload of the action-proposed audit event. */
export interface AgentActionProposedPayload {
  readonly runId: string;
  readonly commandName: string;
  readonly idempotencyKey: string;
  readonly confidence: string;
  readonly rationale: string;
  readonly evidence: readonly { readonly slot: string; readonly ref: string }[];
}

const ACTION_PROPOSED_KEYS = [
  'runId',
  'commandName',
  'idempotencyKey',
  'confidence',
  'rationale',
  'evidence',
] as const;

const ACTION_PROPOSED_GRAMMAR =
  'AgentActionProposedPayload: { runId, commandName, idempotencyKey, confidence, rationale, evidence: { slot, ref }[] }';

/** Parse an untrusted value as an AgentActionProposedPayload (fail-closed). */
export function parseActionProposedPayload(
  raw: unknown,
): ParseResult<AgentActionProposedPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ACTION_PROPOSED_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ACTION_PROPOSED_KEYS, '', ACTION_PROPOSED_GRAMMAR);
  if (unknownKey) return unknownKey;
  const runId = requireString(raw, 'runId', '', RUN_ID_RULE);
  if (!runId.ok) return runId;
  const commandName = requireString(raw, 'commandName', '', {
    min: 3,
    max: 200,
    pattern: /^[a-z][a-zA-Z0-9]{0,31}(\.[a-z][a-zA-Z0-9]{0,31}){1,5}$/,
    description: 'command name (2..6 dot-separated segments)',
  });
  if (!commandName.ok) return commandName;
  const idempotencyKey = requireString(raw, 'idempotencyKey', '', {
    min: 8,
    max: 128,
    pattern: /^[\x21-\x7e]{8,128}$/,
    description: 'idempotency key: opaque printable-ASCII token (8..128)',
  });
  if (!idempotencyKey.ok) return idempotencyKey;
  const confidence = raw['confidence'];
  if (typeof confidence !== 'string' || !['low', 'medium', 'high', 'certain'].includes(confidence)) {
    return parseFail('invalid-value', 'confidence', "confidence 'low' | 'medium' | 'high' | 'certain'", describeValue(confidence));
  }
  const rationale = requireString(raw, 'rationale', '', {
    min: 1,
    max: 2000,
    description: 'proposal rationale (1..2000 characters)',
  });
  if (!rationale.ok) return rationale;
  const evidenceRaw = raw['evidence'];
  if (!Array.isArray(evidenceRaw)) {
    return parseFail('invalid-type', 'evidence', 'array of evidence references', describeValue(evidenceRaw));
  }
  const evidence: { slot: string; ref: string }[] = [];
  for (const [index, element] of evidenceRaw.entries()) {
    const elementPath = `evidence[${index}]`;
    if (!isPlainObject(element)) {
      return parseFail('invalid-type', elementPath, 'evidence reference { slot, ref }', describeValue(element));
    }
    const slot = requireString(element, 'slot', elementPath, {
      min: 1,
      max: 64,
      pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
      description: 'evidence slot (kebab, 1..64)',
    });
    if (!slot.ok) return slot;
    const ref = requireString(element, 'ref', elementPath, {
      min: 1,
      max: 128,
      pattern: /^[\x21-\x7e]{1,128}$/,
      description: 'evidence reference: opaque printable-ASCII token (1..128)',
    });
    if (!ref.ok) return ref;
    evidence.push({ slot: slot.value, ref: ref.value });
  }
  return parseOk(
    {
      runId: runId.value,
      commandName: commandName.value,
      idempotencyKey: idempotencyKey.value,
      confidence,
      rationale: rationale.value,
      evidence,
    } satisfies AgentActionProposedPayload,
  );
}

/** The payload of the gateway-decision-recorded audit event (verbatim). */
export interface AgentGatewayDecisionPayload {
  readonly runId: string;
  readonly commandName: string;
  readonly idempotencyKey: string;
  readonly decision: AgentAuditDecision;
  readonly replayed: boolean;
  readonly approval: { readonly instanceId: string; readonly approvalKey: string } | null;
  readonly approvalStatus: string | null;
  readonly denialCode: string | null;
}

const GATEWAY_DECISION_KEYS = [
  'runId',
  'commandName',
  'idempotencyKey',
  'decision',
  'replayed',
  'approval',
  'approvalStatus',
  'denialCode',
] as const;

const GATEWAY_DECISION_GRAMMAR =
  "AgentGatewayDecisionPayload: { runId, commandName, idempotencyKey, decision: 'executed' | 'routed-to-approval' | 'denied', replayed, approval?, approvalStatus?, denialCode? }";

/** Parse an untrusted value as an AgentGatewayDecisionPayload (fail-closed). */
export function parseGatewayDecisionPayload(
  raw: unknown,
): ParseResult<AgentGatewayDecisionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', GATEWAY_DECISION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, GATEWAY_DECISION_KEYS, '', GATEWAY_DECISION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const runId = requireString(raw, 'runId', '', RUN_ID_RULE);
  if (!runId.ok) return runId;
  const commandName = requireString(raw, 'commandName', '', {
    min: 3,
    max: 200,
    pattern: /^[a-z][a-zA-Z0-9]{0,31}(\.[a-z][a-zA-Z0-9]{0,31}){1,5}$/,
    description: 'command name (2..6 dot-separated segments)',
  });
  if (!commandName.ok) return commandName;
  const idempotencyKey = requireString(raw, 'idempotencyKey', '', {
    min: 8,
    max: 128,
    pattern: /^[\x21-\x7e]{8,128}$/,
    description: 'idempotency key: opaque printable-ASCII token (8..128)',
  });
  if (!idempotencyKey.ok) return idempotencyKey;
  const decision = raw['decision'];
  if (typeof decision !== 'string' || !(AGENT_AUDIT_DECISIONS as readonly string[]).includes(decision)) {
    return parseFail('invalid-value', 'decision', "decision 'executed' | 'routed-to-approval' | 'denied'", describeValue(decision));
  }
  const replayed = raw['replayed'];
  if (typeof replayed !== 'boolean') {
    return parseFail('invalid-type', 'replayed', 'boolean', describeValue(replayed));
  }
  const approvalRaw = raw['approval'];
  let approval: { instanceId: string; approvalKey: string } | null = null;
  if (approvalRaw !== undefined && approvalRaw !== null) {
    if (!isPlainObject(approvalRaw)) {
      return parseFail('invalid-type', 'approval', 'approval reference { instanceId, approvalKey } or null', describeValue(approvalRaw));
    }
    const instanceId = requireString(approvalRaw, 'instanceId', 'approval', {
      min: 16,
      max: 64,
      pattern: /^office-(ent|tnt|prj)-v1-[0-9a-z]{16,64}$/,
      description: 'canonical EntityId',
    });
    if (!instanceId.ok) return instanceId;
    const approvalKey = requireString(approvalRaw, 'approvalKey', 'approval', {
      min: 1,
      max: 64,
      pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
      description: 'approval key (kebab, 1..64)',
    });
    if (!approvalKey.ok) return approvalKey;
    approval = { instanceId: instanceId.value, approvalKey: approvalKey.value };
  }
  const approvalStatusRaw = raw['approvalStatus'];
  if (approvalStatusRaw !== undefined && approvalStatusRaw !== null && typeof approvalStatusRaw !== 'string') {
    return parseFail('invalid-type', 'approvalStatus', 'approval status or null', describeValue(approvalStatusRaw));
  }
  const denialCodeRaw = raw['denialCode'];
  if (denialCodeRaw !== undefined && denialCodeRaw !== null && typeof denialCodeRaw !== 'string') {
    return parseFail('invalid-type', 'denialCode', 'denial code or null', describeValue(denialCodeRaw));
  }
  return parseOk(
    {
      runId: runId.value,
      commandName: commandName.value,
      idempotencyKey: idempotencyKey.value,
      decision: decision as AgentAuditDecision,
      replayed,
      approval,
      approvalStatus: approvalStatusRaw === undefined ? null : (approvalStatusRaw as string | null),
      denialCode: denialCodeRaw === undefined ? null : (denialCodeRaw as string | null),
    } satisfies AgentGatewayDecisionPayload,
  );
}

/** The payload of the run-completed audit event. */
export interface AgentRunCompletedPayload {
  readonly runId: string;
  readonly status: AgentRunStatus;
  readonly executedCount: number;
  readonly routedCount: number;
  readonly deniedCount: number;
  readonly pendingApprovals: readonly { readonly instanceId: string; readonly approvalKey: string }[];
}

const RUN_COMPLETED_KEYS = [
  'runId',
  'status',
  'executedCount',
  'routedCount',
  'deniedCount',
  'pendingApprovals',
] as const;

const RUN_COMPLETED_GRAMMAR =
  "AgentRunCompletedPayload: { runId, status: 'running' | 'awaiting-approval' | 'executed' | 'denied', executedCount, routedCount, deniedCount, pendingApprovals: { instanceId, approvalKey }[] }";

/** Parse an untrusted value as an AgentRunCompletedPayload (fail-closed). */
export function parseRunCompletedPayload(raw: unknown): ParseResult<AgentRunCompletedPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RUN_COMPLETED_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RUN_COMPLETED_KEYS, '', RUN_COMPLETED_GRAMMAR);
  if (unknownKey) return unknownKey;
  const runId = requireString(raw, 'runId', '', RUN_ID_RULE);
  if (!runId.ok) return runId;
  const status = raw['status'];
  if (typeof status !== 'string' || !['running', 'awaiting-approval', 'executed', 'denied'].includes(status)) {
    return parseFail('invalid-value', 'status', "agent run status 'running' | 'awaiting-approval' | 'executed' | 'denied'", describeValue(status));
  }
  const counts: Record<'executedCount' | 'routedCount' | 'deniedCount', number | undefined> = {
    executedCount: undefined,
    routedCount: undefined,
    deniedCount: undefined,
  };
  for (const field of ['executedCount', 'routedCount', 'deniedCount'] as const) {
    const value = raw[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return parseFail('invalid-value', field, 'non-negative integer', describeValue(value));
    }
    counts[field] = value;
  }
  const pendingRaw = raw['pendingApprovals'];
  if (!Array.isArray(pendingRaw)) {
    return parseFail('invalid-type', 'pendingApprovals', 'array of approval references', describeValue(pendingRaw));
  }
  const pendingApprovals: { instanceId: string; approvalKey: string }[] = [];
  for (const [index, element] of pendingRaw.entries()) {
    const elementPath = `pendingApprovals[${index}]`;
    if (!isPlainObject(element)) {
      return parseFail('invalid-type', elementPath, 'approval reference { instanceId, approvalKey }', describeValue(element));
    }
    const instanceId = requireString(element, 'instanceId', elementPath, {
      min: 16,
      max: 64,
      pattern: /^office-(ent|tnt|prj)-v1-[0-9a-z]{16,64}$/,
      description: 'canonical EntityId',
    });
    if (!instanceId.ok) return instanceId;
    const approvalKey = requireString(element, 'approvalKey', elementPath, {
      min: 1,
      max: 64,
      pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
      description: 'approval key (kebab, 1..64)',
    });
    if (!approvalKey.ok) return approvalKey;
    pendingApprovals.push({ instanceId: instanceId.value, approvalKey: approvalKey.value });
  }
  return parseOk(
    {
      runId: runId.value,
      status: status as AgentRunStatus,
      executedCount: counts.executedCount ?? 0,
      routedCount: counts.routedCount ?? 0,
      deniedCount: counts.deniedCount ?? 0,
      pendingApprovals,
    } satisfies AgentRunCompletedPayload,
  );
}

// ----- the envelope builder ---------------------------------------------------------------------

/**
 * The causation id of an agent audit event: the run id for lifecycle events,
 * or the proposal command's idempotency key for proposal/decision events (the
 * contracts causation convention — the gateway's own audit events do the
 * same). Idempotency keys satisfy the CausationId grammar by construction;
 * this re-validates fail-closed as defense in depth (a loud TypeError, never
 * a silent envelope corruption).
 */
const causationIdOf = (token: string): CausationId => {
  const parsed = parseCausationId(token);
  if (!parsed.ok) {
    throw new TypeError(`agent audit causation token '${token}' is not a valid causation id`);
  }
  return parsed.value;
};

/** Inputs of the agent audit envelope builder. */
export interface AgentAuditEventInputs<P> {
  /** The event name of the record (one of AGENT_EVENT_NAMES). */
  readonly eventName: EventName;
  /** The scope of the run (every event carries it). */
  readonly scope: Scope;
  /** The run's agent actor (the A4 source identity of the trail). */
  readonly actor: Actor;
  /** The correlation id of the run's input, carried through every event. */
  readonly correlationId: CorrelationId;
  /** The causation token: the run id (lifecycle) or the command key. */
  readonly causationToken: string;
  /** The occurred-at instant (the run's injected now). */
  readonly occurredAt: Timestamp;
  /** The entity refs (the proposal's subject when applicable, else null). */
  readonly subject: EntityRef | null;
  /** The audit payload of the record. */
  readonly payload: P;
}

/**
 * Build one agent audit event as a DomainEventEnvelope (source 'system' —
 * the runtime is platform execution machinery acting on the agent actor's
 * behalf) and validate it against the canonical contract: a builder that
 * cannot produce a contract-valid envelope is a loud programming error, never
 * a silent malformed audit trail.
 */
export function agentEventEnvelope<P extends Record<string, unknown>>(
  inputs: AgentAuditEventInputs<P>,
): DomainEventEnvelope<P> {
  const entityRefs: EntityRefs = {
    before: inputs.subject,
    after: inputs.subject,
  };
  const envelope = {
    kind: 'event',
    eventName: inputs.eventName,
    scope: inputs.scope,
    actor: inputs.actor,
    source: 'system',
    causality: {
      correlationId: inputs.correlationId,
      causationId: causationIdOf(inputs.causationToken),
    },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: inputs.occurredAt,
    entityRefs,
    payload: inputs.payload,
  } as const satisfies DomainEventEnvelope;
  const checked = parseDomainEventEnvelope(envelope);
  if (!checked.ok) {
    throw new TypeError(
      `agent audit event failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<P>;
}

/** The run-lifecycle event names, for the builder's callers. */
export const AGENT_LIFECYCLE_EVENTS: readonly EventName[] = [
  AGENT_RUN_STARTED_EVENT,
  AGENT_EVIDENCE_GATHERED_EVENT,
  AGENT_RUN_COMPLETED_EVENT,
] as const;

/** Validate an event-name literal against the contracts grammar (internal). */
export const agentEventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid agent event name literal: ${name}`);
  }
  return parsed.value;
};

// ----- THE AgentEventSink port (mirrors the landed packages byte-for-byte) ---------------------

/**
 * THE AgentEventSink port (minimal, by design): append agent-run audit events
 * using the caller's open transaction executor, so a real implementation (the
 * OFF-005 event ledger wired by the runtime) writes them atomically with the
 * action's effects. A failure result MUST abort the surrounding run phase
 * (the runtime fails typed — no partial audit trail is ever left behind).
 */
export interface AgentEventSink {
  appendEvents(
    executor: SqlExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedAgentAppend {
  /** The executor the sink was handed (the open transaction in handlers). */
  readonly executor: SqlExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory AgentEventSink: records appends instead of writing (tests). */
export interface InMemoryAgentEventSink extends AgentEventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedAgentAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory AgentEventSink for deterministic tests. */
export function createInMemoryAgentEventSink(): InMemoryAgentEventSink {
  const appends: RecordedAgentAppend[] = [];
  return {
    appends,
    get events(): readonly DomainEventEnvelope[] {
      return appends.flatMap((append) => append.events);
    },
    appendEvents: async (executor, events) => {
      appends.push({ executor, events: [...events] });
      return ok(true);
    },
  };
}

/** Build a typed agent-sink failure (for tests and wiring guards). */
export const agentSinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `agent event sink rejected the append: ${reason}`,
    [{ code: 'agent-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingAgentEventSink = (reason: string): AgentEventSink => ({
  appendEvents: async () => fail(agentSinkFailure(reason)),
});

/** Decision-name mapping from the gateway's vocabulary to the audit vocabulary. */
export const auditDecisionOf = (decision: ActionDecision | 'denied'): AgentAuditDecision =>
  decision === 'duplicate-observed' ? 'executed' : (decision as AgentAuditDecision);
