// Office agent runtime — the local vocabulary (OFF-018).
//
// The runtime's OWN closed vocabularies (the agent-run lifecycle, the tool
// kinds of the typed tool registry, the agent audit-event names) plus the
// branded identities the runtime stamps on every run. Everything parses
// fail-closed (total parsers, strict keys) exactly like the landed packages.
//
// The AgentRunId grammar is deliberately CAUSATION-COMPATIBLE (opaque
// printable ASCII, 8..128, no whitespace): a run id doubles as the causation
// id of the run's own lifecycle audit events (the run causes its own trail),
// the same way the action gateway derives its audit causation from the
// command's idempotency key.
import { parseOk } from '@office/contracts';
import type { EventName, ParseResult, Timestamp } from '@office/contracts';
import { parseEventName } from '@office/contracts';
import { parseStringLike } from './parse';
import type { StringRule } from './parse';

// ----- the branded run identity ------------------------------------------------------------

declare const agentRunIdBrand: unique symbol;

/** Grammar description used in parse failures. */
export const AGENT_RUN_ID_GRAMMAR =
  'agent run id: opaque printable-ASCII token of 8..128 characters (no whitespace)';

/**
 * The identity of one agent run: an opaque, causation-compatible token minted
 * by the runtime's INJECTED id supplier (never from a clock or randomness —
 * the determinism rule). Doubles as the causation id of the run's lifecycle
 * audit events.
 */
export type AgentRunId = string & { readonly [agentRunIdBrand]: 'AgentRunId' };

const AGENT_RUN_ID_RULE: StringRule = {
  min: 8,
  max: 128,
  pattern: /^[\x21-\x7e]{8,128}$/,
  description: AGENT_RUN_ID_GRAMMAR,
};

/** Parse an untrusted value as an AgentRunId (total, fail-closed). */
export function parseAgentRunId(raw: unknown): ParseResult<AgentRunId> {
  const result = parseStringLike(raw, AGENT_RUN_ID_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as AgentRunId);
}

/** Type guard for structurally valid AgentRunId values. */
export function isAgentRunId(raw: unknown): raw is AgentRunId {
  return parseAgentRunId(raw).ok;
}

// ----- the run lifecycle --------------------------------------------------------------------

/**
 * The lifecycle of one agent run. A run starts 'running'; a routed
 * approval-required proposal parks it in 'awaiting-approval' (it completes
 * ONLY on the approval's resolution); a fully processed run ends 'executed'
 * (at least one proposal executed, none awaiting) or 'denied' (every proposal
 * denied, none awaiting). Runs that fail typed before completion return the
 * failure — they never carry a terminal status.
 */
export type AgentRunStatus = 'running' | 'awaiting-approval' | 'executed' | 'denied';

/** Every run status, in lifecycle order. */
export const AGENT_RUN_STATUSES: readonly AgentRunStatus[] = [
  'running',
  'awaiting-approval',
  'executed',
  'denied',
] as const;

/** Grammar description used in parse failures. */
export const AGENT_RUN_STATUS_GRAMMAR =
  "agent run status 'running' | 'awaiting-approval' | 'executed' | 'denied'";

// ----- the tool vocabulary -------------------------------------------------------------------

/**
 * The two tool kinds of the typed tool registry (freeze A8): 'read' tools
 * retrieve evidence (relationship traversals, margin assessments, memory
 * lookups — they never mutate anything); 'propose-action' tools produce typed
 * action PROPOSALS for the gateway (they never execute anything themselves —
 * the proposals are handed to executeAction by the runtime, the only
 * execution path).
 */
export type ToolKind = 'read' | 'propose-action';

/** Every tool kind, in vocabulary order. */
export const TOOL_KINDS: readonly ToolKind[] = ['read', 'propose-action'] as const;

/** Grammar description used in parse failures. */
export const TOOL_KIND_GRAMMAR = "tool kind 'read' | 'propose-action'";

/** Grammar description used in parse failures. */
export const TOOL_NAME_GRAMMAR = 'tool name: lowercase kebab-case (3..64)';

const TOOL_NAME_RULE: StringRule = {
  min: 3,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,63}$/,
  description: TOOL_NAME_GRAMMAR,
};

declare const toolNameBrand: unique symbol;

/** The registered name of one tool of the typed tool registry. */
export type ToolName = string & { readonly [toolNameBrand]: 'ToolName' };

/** Parse an untrusted value as a ToolName (total, fail-closed). */
export function parseToolName(raw: unknown): ParseResult<ToolName> {
  const result = parseStringLike(raw, TOOL_NAME_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as ToolName);
}

/** Type guard for structurally valid ToolName values. */
export function isToolName(raw: unknown): raw is ToolName {
  return parseToolName(raw).ok;
}

// ----- the agent audit-event names -----------------------------------------------------------

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid agent event name literal: ${name}`);
  }
  return parsed.value;
};

/** Event name of the run-started record (the run began; its trail opens). */
export const AGENT_RUN_STARTED_EVENT: EventName = eventNameOf('agents.agentRunStarted');
/** Event name of the evidence-gathered record (the run grounded on evidence). */
export const AGENT_EVIDENCE_GATHERED_EVENT: EventName = eventNameOf(
  'agents.agentEvidenceGathered',
);
/** Event name of the action-proposed record (one typed proposal validated). */
export const AGENT_ACTION_PROPOSED_EVENT: EventName = eventNameOf('agents.agentActionProposed');
/** Event name of the gateway-decision record (the gateway's decision, verbatim). */
export const AGENT_GATEWAY_DECISION_EVENT: EventName = eventNameOf(
  'agents.agentGatewayDecisionRecorded',
);
/** Event name of the run-completed record (the run reached a terminal state). */
export const AGENT_RUN_COMPLETED_EVENT: EventName = eventNameOf('agents.agentRunCompleted');

/** Every event name this module emits, in lifecycle order. */
export const AGENT_EVENT_NAMES: readonly EventName[] = [
  AGENT_RUN_STARTED_EVENT,
  AGENT_EVIDENCE_GATHERED_EVENT,
  AGENT_ACTION_PROPOSED_EVENT,
  AGENT_GATEWAY_DECISION_EVENT,
  AGENT_RUN_COMPLETED_EVENT,
] as const;

// ----- shared field rules ---------------------------------------------------------------------

/** Grammar description used in parse failures. */
export const AGENT_GOAL_GRAMMAR = 'agent goal: 1..2000 characters';

/** The string rule of a run's goal (the objective the agent run pursues). */
export const GOAL_RULE: StringRule = { min: 1, max: 2000, description: AGENT_GOAL_GRAMMAR };

/** Grammar description used in parse failures. */
export const AGENT_RATIONALE_GRAMMAR = 'proposal rationale: 1..2000 characters';

/** The string rule of a proposal's rationale (the A4 reasoning summary). */
export const RATIONALE_RULE: StringRule = {
  min: 1,
  max: 2000,
  description: AGENT_RATIONALE_GRAMMAR,
};

/**
 * The deterministic evidence-reference token rule of this package (matches the
 * action gateway's EvidenceReference grammar: opaque printable ASCII, no
 * whitespace): every evidence item carries one.
 */
export const EVIDENCE_REF_RULE: StringRule = {
  min: 1,
  max: 128,
  pattern: /^[\x21-\x7e]{1,128}$/,
  description: 'evidence reference: opaque printable-ASCII token of 1..128 characters',
} as const;

/** The shape of the (injected) clock this package's types reference. */
export type Clock = () => Timestamp;
