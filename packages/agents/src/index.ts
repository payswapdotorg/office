// Office agent runtime — public surface (OFF-018).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-026 app runtime, OFF-030 web API, OFF-033/034 sync/field surfaces,
// OFF-036 release gate) consume the package only through this root entry
// point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package imports exactly eight workspace dependencies — @office/actions
// (THE gateway: executeAction, the ActionDescriptor registry, the
// classification/evidence/approval/proposal vocabularies),
// @office/intelligence-relationships (the REAL traversal behind the traversal
// evidence tool), @office/intelligence-margin + @office/intelligence-memory
// (the typed assessment/outcome/lesson evidence identities their own parsers
// validate), @office/contracts (envelopes, Actor — the 'agent' actor kind —
// parse helpers), @office/domain-kernel (Result/DomainError),
// @office/authz (deny-by-default scope coverage), and @office/persistence
// (the SqlExecutor TYPE of the AgentEventSink port signature — type-only).
// No external dependencies; no LLM/network call of ANY kind (the model is an
// injected deterministic MOCK port).
//
// Surface summary:
// - vocabulary:        AgentRunId (+ grammar/parse/is), AgentRunStatus
//                      (+ AGENT_RUN_STATUSES), ToolKind (+ TOOL_KINDS),
//                      ToolName (+ grammar/parse/is), the five AGENT_* event
//                      name constants + AGENT_EVENT_NAMES, the shared field
//                      rules/grammars
// - evidence:          EvidenceQuery (+ kinds/parse/is), EvidenceItem,
//                      EvidenceItemKind, EvidenceRetrieval, EvidenceSet
//                      (+ parse/is/builder), evidenceReferencesOf,
//                      backingItemsOf, qualifyEvidenceSet (THE A4 gate)
// - tools:             ToolDescriptor (+ parse/is/define), ToolKind ports
//                      (EvidenceTool / ProposingTool / Tool + type guards),
//                      ToolAuthorization + toolAuthorizationOf,
//                      createInMemoryToolRegistry, the four deterministic
//                      built-in tool factories (relationship traversal,
//                      assessment evidence, memory evidence, model proposing)
// - model:             ModelPort, ProposingInput, ModelProposalDraft,
//                      ModelScriptEntry, createScriptedModel (the
//                      deterministic fixture-scripted mock)
// - proposals:         ProposedAction (+ parse/is/builder), toGatewayProposal
// - run:               AgentRunInput (+ parse/is), EvidenceRetrievalStep,
//                      AgentRunRecord, ToolInvocationRecord,
//                      ProposedActionRecord, GatewayDecision(Record),
//                      AgentRuntimeDeps, ApprovalResolution, AgentRuntime,
//                      createAgentRuntime
// - execution records: the five AGENT_* audit event names, the audit payload
//                      types + parsers, agentEventEnvelope,
//                      THE AgentEventSink port,
//                      createInMemoryAgentEventSink, failingAgentEventSink,
//                      agentSinkFailure
export {
  AGENT_EVENT_NAMES,
  AGENT_EVIDENCE_GATHERED_EVENT,
  AGENT_GATEWAY_DECISION_EVENT,
  AGENT_RUN_COMPLETED_EVENT,
  AGENT_RUN_STARTED_EVENT,
  AGENT_ACTION_PROPOSED_EVENT,
  AGENT_RUN_ID_GRAMMAR,
  AGENT_RUN_STATUSES,
  AGENT_RUN_STATUS_GRAMMAR,
  AGENT_GOAL_GRAMMAR,
  AGENT_RATIONALE_GRAMMAR,
  TOOL_KINDS,
  TOOL_KIND_GRAMMAR,
  TOOL_NAME_GRAMMAR,
  isAgentRunId,
  isToolName,
  parseAgentRunId,
  parseToolName,
} from './vocabulary';
export type { AgentRunId, AgentRunStatus, Clock, ToolKind, ToolName } from './vocabulary';

// The EvidenceSet model (freeze A4 — the typed, referenced evidence bundle).
export {
  EVIDENCE_ITEM_KINDS,
  EVIDENCE_ITEM_KIND_GRAMMAR,
  EVIDENCE_QUERY_KINDS,
  EVIDENCE_QUERY_GRAMMAR,
  backingItemsOf,
  evidenceReferencesOf,
  evidenceSet,
  isEvidenceItem,
  isEvidenceQuery,
  isEvidenceSet,
  parseEvidenceItem,
  parseEvidenceQuery,
  parseEvidenceRetrieval,
  parseEvidenceSet,
  qualifyEvidenceSet,
} from './evidence';
export type {
  EvidenceItem,
  EvidenceItemKind,
  EvidenceQuery,
  EvidenceRetrieval,
  EvidenceSet,
} from './evidence';

// The typed tool registry + the deterministic built-in tools.
export {
  createAssessmentEvidenceTool,
  createInMemoryToolRegistry,
  createMemoryEvidenceTool,
  createModelProposingTool,
  createRelationshipTraversalTool,
  defineToolDescriptor,
  isEvidenceTool,
  isProposingTool,
  isToolDescriptor,
  parseToolDescriptor,
  toolAuthorizationOf,
} from './tools';
export type {
  AssessmentEvidenceRecord,
  AssessmentEvidenceToolOptions,
  EvidenceTool,
  MemoryEvidenceToolOptions,
  MemoryLessonEvidenceRecord,
  MemoryOutcomeEvidenceRecord,
  ModelProposingToolOptions,
  ProposingTool,
  RelationshipTraversalToolOptions,
  Tool,
  ToolAuthorization,
  ToolDescriptor,
  ToolRegistry,
} from './tools';

// THE model port + the deterministic fixture-scripted mock.
export { createScriptedModel } from './model';
export type { ModelPort, ModelProposalDraft, ModelScriptEntry, ProposingInput, ScriptedModel } from './model';

// The typed action proposal handed to the gateway.
export {
  isProposedAction,
  parseProposedAction,
  proposedAction,
  toGatewayProposal,
} from './proposals';
export type { ProposedAction } from './proposals';

// THE agent runtime (runAgentGoal + the approval-resolution continuation).
export {
  createAgentRuntime,
  isAgentRunInput,
  parseAgentRunInput,
} from './run';
export type {
  AgentRuntime,
  AgentRuntimeDeps,
  AgentRunInput,
  AgentRunRecord,
  ApprovalResolution,
  EvidenceRetrievalStep,
  GatewayDecision,
  GatewayDecisionRecord,
  ProposedActionRecord,
  ToolInvocationRecord,
} from './run';

// The agent's own audit trail + THE AgentEventSink port.
export {
  AGENT_AUDIT_DECISIONS,
  agentEventEnvelope,
  agentEventNameOf,
  agentSinkFailure,
  auditDecisionOf,
  createInMemoryAgentEventSink,
  failingAgentEventSink,
  parseActionProposedPayload,
  parseEvidenceGatheredPayload,
  parseGatewayDecisionPayload,
  parseRunCompletedPayload,
  parseRunStartedPayload,
} from './execution-records';
export type {
  AgentActionProposedPayload,
  AgentAuditDecision,
  AgentEventSink,
  AgentEvidenceGatheredPayload,
  AgentGatewayDecisionPayload,
  AgentRunCompletedPayload,
  AgentRunStartedPayload,
  EvidenceItemSummary,
  InMemoryAgentEventSink,
  RecordedAgentAppend,
} from './execution-records';
