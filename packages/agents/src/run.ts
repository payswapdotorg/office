// Office agent runtime — the AgentRun model + the runtime (OFF-018).
//
// THE canonical 'agent action' flow (ARCHITECTURE_FREEZE.md), implemented as
// one recorded, evidence-grounded agent run:
//
//   1. Agent retrieves authorized evidence and context   — the EVIDENCE
//      phase: the run's typed retrieval plan runs through the read tools of
//      the typed tool registry under the run's authorization; every item is
//      scope-checked (A12) and carries its retrieval provenance;
//   2. Agent proposes a typed command                    — the PROPOSAL
//      phase: the injected ModelPort (behind the proposing tool) turns the
//      goal + evidence into validated ProposedActions;
//   3. Action gateway checks permissions, policy,
//      confidence/evidence requirements, idempotency    — the GATEWAY phase:
//      EVERY proposal goes through executeAction() — the ONLY path to
//      canonical mutation (freeze A8); the runtime records the gateway's
//      decision VERBATIM;
//   4. If approval is required, an approval task is
//      created                                            — the approval
//      handoff: a routed proposal parks the run in 'awaiting-approval' with
//      the approval reference linked; the run completes ONLY on resolution
//      (resolveApproval re-enters the gateway with the approval evidence);
//   5. Approved command executes transactionally;
//   6. Event ledger records execution and causal links   — the agent's OWN
//      audit trail through the AgentEventSink port (execution-records.ts).
//
// THE named acceptance (freeze A4), enforced BEFORE the gateway call: a
// consequential proposal (reversible / approval-required class) with an
// empty or unqualified EvidenceSet, or with evidence references the run's
// evidence does not back, is a TYPED REJECTION — executeAction() is never
// reached (proven by gateway/handler invocation counting in the tests).
//
// Determinism: the clock and the run-id supplier are injected; identical
// harnesses produce byte-identical runs (no Date.now/Math.random anywhere).
import { parseActor, parseCorrelationId, parseEntityRef, parseFail, parseOk, parseScope } from '@office/contracts';
import type { Actor, CorrelationId, EntityRef, ParseResult, Scope, Timestamp } from '@office/contracts';
import { checkScopeCoversResource, resourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { classifyAction } from '@office/actions';
import type {
  ActionAuthorization,
  ActionGateway,
  ActionResult,
  ActionRegistry,
  ApprovalReference,
} from '@office/actions';
import type { SqlExecutor } from '@office/persistence';
import { EVIDENCE_REFERENCE_KIND } from '@office/intelligence-relationships';
import type { EvidenceItem, EvidenceQuery, EvidenceSet } from './evidence';
import { parseEvidenceQuery, parseEvidenceSet, qualifyEvidenceSet } from './evidence';
import type { Tool, ToolRegistry } from './tools';
import { isEvidenceTool, isProposingTool, toolAuthorizationOf } from './tools';
import type { ToolKind } from './vocabulary';
import { GOAL_RULE } from './vocabulary';
import type { AgentRunId, AgentRunStatus } from './vocabulary';
import type { ModelPort } from './model';
import type { ProposedAction } from './proposals';
import { proposedAction, toGatewayProposal } from './proposals';
import {
  AGENT_ACTION_PROPOSED_EVENT,
  AGENT_EVIDENCE_GATHERED_EVENT,
  AGENT_GATEWAY_DECISION_EVENT,
  AGENT_RUN_COMPLETED_EVENT,
  AGENT_RUN_STARTED_EVENT,
} from './vocabulary';
import type { AgentEventSink } from './execution-records';
import { agentEventEnvelope } from './execution-records';
import { describeValue, isPlainObject, requireFieldWith, requireString, unknownKeyFailure } from './parse';

// ----- the run input ----------------------------------------------------------------------------

/**
 * One retrieval step of the run's evidence plan: the read tool that runs and
 * the typed query it runs (the retrieval provenance of every item it
 * produces).
 */
export interface EvidenceRetrievalStep {
  /** The registered name of the read tool (kind 'read'). */
  readonly tool: string;
  /** The typed evidence query the tool runs. */
  readonly query: EvidenceQuery;
}

/**
 * The input of one agent run: the goal, the tenant/project scope the run is
 * confined to (A12), the AGENT actor (kind 'agent' with actorId — the A4
 * source identity), the context entity references, the typed evidence
 * retrieval plan, the proposing tool, and the correlation id that flows
 * through the run's whole audit trail (A3).
 */
export interface AgentRunInput {
  /** The objective the run pursues (1..2000 characters). */
  readonly goal: string;
  /** The tenant or project scope the run is confined to (A12). */
  readonly scope: Scope;
  /** The agent actor performing the run (kind 'agent', with actorId). */
  readonly actor: Actor;
  /** The context entity references of the goal. */
  readonly contextRefs: readonly EntityRef[];
  /** The typed evidence retrieval plan (read tools + typed queries). */
  readonly retrievalPlan: readonly EvidenceRetrievalStep[];
  /** The registered name of the action-proposing tool (kind 'propose-action'). */
  readonly proposingTool: string;
  /** The correlation id carried through the run's audit trail (A3). */
  readonly correlationId: CorrelationId;
}

const AGENT_RUN_INPUT_KEYS = [
  'goal',
  'scope',
  'actor',
  'contextRefs',
  'retrievalPlan',
  'proposingTool',
  'correlationId',
] as const;

const AGENT_RUN_INPUT_GRAMMAR =
  'AgentRunInput: { goal, scope, actor (kind agent), contextRefs: EntityRef[], retrievalPlan: { tool, query }[], proposingTool, correlationId }';

const TOOL_NAME_RULE = {
  min: 3,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,63}$/,
  description: 'tool name: lowercase kebab-case (3..64)',
} as const;

/** Parse an untrusted value as an AgentRunInput (total, fail-closed, strict keys). */
export function parseAgentRunInput(raw: unknown): ParseResult<AgentRunInput> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', AGENT_RUN_INPUT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, AGENT_RUN_INPUT_KEYS, '', AGENT_RUN_INPUT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const goal = requireString(raw, 'goal', '', GOAL_RULE);
  if (!goal.ok) return goal;
  const scope = requireFieldWith(raw, 'scope', '', parseScope);
  if (!scope.ok) return scope;
  const actor = requireFieldWith(raw, 'actor', '', parseActor);
  if (!actor.ok) return actor;
  if (actor.value.kind !== 'agent') {
    return parseFail(
      'invalid-value',
      'actor.kind',
      "actor kind 'agent' (an agent run is performed by an agent actor with an actorId)",
      `actor kind '${actor.value.kind}'`,
    );
  }
  const contextRefsRaw = raw['contextRefs'];
  if (!Array.isArray(contextRefsRaw)) {
    return parseFail('invalid-type', 'contextRefs', 'array of EntityRef', describeValue(contextRefsRaw));
  }
  const contextRefs: EntityRef[] = [];
  for (const [index, element] of contextRefsRaw.entries()) {
    const parsed = parseEntityRef(element);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        `contextRefs[${index}]${parsed.error.path === '' ? '' : `.${parsed.error.path}`}`,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    contextRefs.push(parsed.value);
  }
  const retrievalPlanRaw = raw['retrievalPlan'];
  if (!Array.isArray(retrievalPlanRaw)) {
    return parseFail('invalid-type', 'retrievalPlan', 'array of { tool, query }', describeValue(retrievalPlanRaw));
  }
  const retrievalPlan: EvidenceRetrievalStep[] = [];
  for (const [index, element] of retrievalPlanRaw.entries()) {
    if (!isPlainObject(element)) {
      return parseFail('invalid-type', `retrievalPlan[${index}]`, 'evidence retrieval step { tool, query }', describeValue(element));
    }
    const stepUnknownKey = unknownKeyFailure(
      element,
      ['tool', 'query'],
      `retrievalPlan[${index}]`,
      'evidence retrieval step { tool, query }',
    );
    if (stepUnknownKey) return stepUnknownKey;
    const tool = requireString(element, 'tool', `retrievalPlan[${index}]`, TOOL_NAME_RULE);
    if (!tool.ok) return tool;
    const query = requireFieldWith(element, 'query', `retrievalPlan[${index}]`, parseEvidenceQuery);
    if (!query.ok) return query;
    retrievalPlan.push({ tool: tool.value, query: query.value });
  }
  const proposingTool = requireString(raw, 'proposingTool', '', TOOL_NAME_RULE);
  if (!proposingTool.ok) return proposingTool;
  const correlationId = requireFieldWith(raw, 'correlationId', '', parseCorrelationId);
  if (!correlationId.ok) return correlationId;
  return parseOk(
    {
      goal: goal.value,
      scope: scope.value,
      actor: actor.value,
      contextRefs,
      retrievalPlan,
      proposingTool: proposingTool.value,
      correlationId: correlationId.value,
    } satisfies AgentRunInput,
  );
}

/** Type guard for structurally valid AgentRunInput values. */
export function isAgentRunInput(raw: unknown): raw is AgentRunInput {
  return parseAgentRunInput(raw).ok;
}

// ----- the run record ---------------------------------------------------------------------------

/**
 * One recorded tool invocation of the run: which tool (and kind), which typed
 * query (null for the proposing tool), how much it produced, and when (the
 * run's injected clock).
 */
export interface ToolInvocationRecord {
  /** The invoked tool's registered name. */
  readonly tool: string;
  /** The tool's kind ('read' for retrieval, 'propose-action' for proposing). */
  readonly kind: ToolKind;
  /** The typed query the tool ran, or null for the proposing tool. */
  readonly query: EvidenceQuery | null;
  /** How many evidence items a read tool returned (0 for the proposing tool). */
  readonly itemCount: number;
  /** How many proposals the proposing tool returned (0 for read tools). */
  readonly proposalCount: number;
  /** When the tool was invoked (the run's injected clock). */
  readonly invokedAt: Timestamp;
}

/** One validated proposal the run submitted, with its proposal instant. */
export interface ProposedActionRecord {
  /** The validated proposal (command + A4 provenance + rationale). */
  readonly proposal: ProposedAction;
  /** When the proposal was validated (the run's injected clock). */
  readonly proposedAt: Timestamp;
}

/**
 * One gateway decision, recorded VERBATIM: the successful ActionResult
 * exactly as executeAction() returned it (executed / routed-to-approval,
 * replayed, approval reference), or the typed DomainError denial exactly as
 * the gateway emitted it. The runtime never interprets, filters, or retries
 * a decision — it records.
 */
export type GatewayDecision =
  | { readonly outcome: ActionResult }
  | { readonly denial: DomainError };

/** One gateway call the run made (initial submission or approval re-entry). */
export interface GatewayDecisionRecord {
  /** The proposed command's name. */
  readonly commandName: string;
  /** The proposed command's idempotency key (correlates re-entries). */
  readonly idempotencyKey: string;
  /** When the gateway decided (the run's injected clock). */
  readonly at: Timestamp;
  /** The decision, verbatim. */
  readonly decision: GatewayDecision;
}

/**
 * The versioned record of one agent run (freeze A4 — the full provenance):
 * the input (goal + context refs + plan), the model's source identity, the
 * start/completion instants, the lifecycle status, the evidence set the run
 * grounded on, every tool invocation, every validated proposal, every
 * gateway decision (verbatim, append-only — approval re-entries append), the
 * pending approval references while awaiting, and the run's policy context.
 */
export interface AgentRunRecord {
  /** The run's identity (injected supplier; doubles as the audit causation). */
  readonly runId: AgentRunId;
  /** The run's input, verbatim. */
  readonly input: AgentRunInput;
  /** The model's source identity (the injected ModelPort's modelId). */
  readonly modelId: string;
  /** When the run started (the injected clock). */
  readonly startedAt: Timestamp;
  /** When the run reached a terminal state, or null while awaiting approval. */
  readonly completedAt: Timestamp | null;
  /** The run's lifecycle status. */
  readonly status: AgentRunStatus;
  /** The evidence set the run grounded on. */
  readonly evidence: EvidenceSet;
  /** Every tool invocation, in run order. */
  readonly toolInvocations: readonly ToolInvocationRecord[];
  /** Every validated proposal, in run order. */
  readonly proposals: readonly ProposedActionRecord[];
  /** Every gateway decision, in call order (append-only). */
  readonly gatewayDecisions: readonly GatewayDecisionRecord[];
  /** The unresolved approval references while the run awaits approval. */
  readonly pendingApprovals: readonly ApprovalReference[];
  /** The run's policy context (the authorization every proposal carried). */
  readonly authorization: ActionAuthorization;
}

// ----- the runtime --------------------------------------------------------------------------------

/** Wiring dependencies of the agent runtime. */
export interface AgentRuntimeDeps {
  /** The typed tool registry (read tools + the proposing tool). */
  readonly tools: ToolRegistry;
  /** The injected model port (deterministic mock — never a real model). */
  readonly model: ModelPort;
  /** THE action gateway: executeAction is the ONLY mutation path (freeze A8). */
  readonly gateway: ActionGateway;
  /** The action registry (fail-closed classification of proposed commands). */
  readonly registry: ActionRegistry;
  /** The agent's own audit-event sink. */
  readonly eventSink: AgentEventSink;
  /** Injected clock: the canonical 'now' of every run instant. */
  readonly now: () => Timestamp;
  /** Injected run-id supplier (deterministic — never clock/random derived). */
  readonly newRunId: () => AgentRunId;
  /** The executor (transaction handle) the sink appends with. */
  readonly executor: SqlExecutor;
}

/** The resolution of one pending approval of an agent run. */
export interface ApprovalResolution {
  /** The approval reference the gateway routed to. */
  readonly approval: ApprovalReference;
  /** The approval's decision: 'approved' executes; 'rejected' denies. */
  readonly decided: 'approved' | 'rejected';
}

/** THE agent runtime: runAgentGoal + the approval-resolution continuation. */
export interface AgentRuntime {
  /**
   * Run one agent goal end-to-end: evidence phase (typed retrieval plan
   * through the read tools), proposal phase (the injected model behind the
   * proposing tool), gateway phase (every proposal through executeAction,
   * decisions recorded verbatim). Fails typed on input/tool/evidence/audit
   * defects and on unevidenced consequential proposals (BEFORE the gateway);
   * returns the parked record while an approval is pending.
   */
  runAgentGoal(
    input: AgentRunInput,
    authorization: ActionAuthorization,
  ): Promise<Result<AgentRunRecord, DomainError>>;
  /**
   * Resolve one pending approval of a run: re-enter the gateway with the
   * approval evidence (approved → executes; rejected → typed denial), record
   * the decision verbatim, and complete the run when nothing is pending.
   */
  resolveApproval(
    run: AgentRunRecord,
    resolution: ApprovalResolution,
    authorization: ActionAuthorization,
  ): Promise<Result<AgentRunRecord, DomainError>>;
}

/** Create the agent runtime (the orchestrator behind the run records). */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const contextOf = (input: { readonly scope: Scope; readonly correlationId: CorrelationId }): DomainErrorContext => ({
    scope: input.scope,
    correlationId: input.correlationId,
  });

  /** Append agent audit events through the sink (typed failure passthrough). */
  const audit = async (
    events: readonly Parameters<typeof agentEventEnvelope>[0][],
  ): Promise<Result<true, DomainError>> =>
    deps.eventSink.appendEvents(
      deps.executor,
      events.map((inputs) => agentEventEnvelope(inputs)),
    );

  /** The typed fail-closed tool resolution. */
  const resolveToolOr = (toolName: string, input: AgentRunInput): Result<Tool, DomainError> => {
    const tool = deps.tools.resolve(toolName);
    if (tool === null) {
      return fail(
        domainError(
          'invariant-violation',
          `agent run tool '${toolName}' is not registered in the tool registry (fail-closed: unregistered tools are never silently skipped)`,
          [
            {
              code: 'tool-not-registered',
              message: `no tool registered under '${toolName}'`,
              path: 'tools',
            },
          ],
          contextOf(input),
        ),
      );
    }
    return ok(tool);
  };

  /** The typed fail-closed tool-kind check. */
  const checkToolKind = (
    tool: Tool,
    expectedKind: ToolKind,
    input: AgentRunInput,
  ): Result<true, DomainError> => {
    if (tool.descriptor.kind !== expectedKind) {
      return fail(
        domainError(
          'invariant-violation',
          `tool '${tool.descriptor.name}' is a '${tool.descriptor.kind}' tool; this step needs a '${expectedKind}' tool`,
          [
            {
              code: 'tool-kind-mismatch',
              message: `expected kind '${expectedKind}', found '${tool.descriptor.kind}'`,
              path: 'tools',
            },
          ],
          contextOf(input),
        ),
      );
    }
    return ok(true);
  };

  /** Is a proposal's action class consequential (evidence REQUIRED)? */
  const isConsequentialClass = (actionClass: string): boolean =>
    actionClass === 'reversible' || actionClass === 'approval-required';

  /**
   * THE pre-gateway evidence gate (the named acceptance): a consequential
   * proposal needs a QUALIFIED, non-empty EvidenceSet, non-empty evidence
   * references, and every reference backed by the set. Typed rejection —
   * executeAction() is never reached.
   */
  const checkProposalEvidence = (
    proposal: ProposedAction,
    evidence: EvidenceSet,
    input: AgentRunInput,
  ): Result<true, DomainError> => {
    const classification = classifyAction(deps.registry, proposal.command.commandName);
    if (!isConsequentialClass(classification.actionClass)) {
      // Read-class proposals carry no canonical mutation; prohibited/unknown
      // commands are the gateway's own fail-closed denials. The agent-side
      // evidence rule binds CONSEQUENTIAL recommendations only.
      return ok(true);
    }
    const qualified = qualifyEvidenceSet(evidence, input.scope, contextOf(input));
    if (!qualified.ok) return qualified;
    if (proposal.evidence.length === 0) {
      return fail(
        domainError(
          'invariant-violation',
          `consequential proposal '${proposal.command.commandName}' carries no evidence references (freeze A4: every consequential recommendation carries evidence)`,
          [
            {
              code: 'proposal-without-evidence',
              message: `proposal of '${proposal.command.commandName}' carries an empty evidence list`,
              path: 'evidence',
            },
          ],
          contextOf(input),
        ),
      );
    }
    const backingRefs = new Set(evidence.items.map((item) => item.ref));
    const unbacked = proposal.evidence.filter((reference) => !backingRefs.has(reference.ref));
    if (unbacked.length > 0) {
      return fail(
        domainError(
          'invariant-violation',
          `consequential proposal '${proposal.command.commandName}' cites evidence reference(s) [${unbacked
            .map((reference) => reference.ref)
            .join(', ')}] the run's evidence set does not back (freeze A4: proposals ground on retrieved evidence only)`,
          [
            {
              code: 'proposal-evidence-unbacked',
              message: `unbacked ref(s): [${unbacked.map((reference) => reference.ref).join(', ')}]`,
              path: 'evidence',
            },
          ],
          contextOf(input),
        ),
      );
    }
    return ok(true);
  };

  /** The scope check every gathered evidence item must pass (A12). */
  const checkEvidenceItemScope = (
    item: EvidenceItem,
    input: AgentRunInput,
  ): Result<true, DomainError> =>
    checkScopeCoversResource(
      input.scope,
      resourceScope({
        scope: item.scope,
        resourceKind: item.entity === null ? EVIDENCE_REFERENCE_KIND : item.entity.entityKind,
        resourceId: item.entity === null ? null : item.entity.entityId,
        ownerId: null,
      }),
      contextOf(input),
    );

  /** Recompute the pending approvals + terminal status from the decisions. */
  const statusOf = (
    proposals: readonly ProposedActionRecord[],
    decisions: readonly GatewayDecisionRecord[],
  ): { readonly status: AgentRunStatus; readonly pending: readonly ApprovalReference[] } => {
    // The LATEST decision per proposal (by idempotency key) is authoritative.
    const latest = new Map<string, GatewayDecision>();
    for (const record of decisions) {
      latest.set(record.idempotencyKey as string, record.decision);
    }
    const pending: ApprovalReference[] = [];
    let executed = 0;
    for (const proposal of proposals) {
      const decision = latest.get(proposal.proposal.command.idempotencyKey as string);
      if (decision === undefined) continue;
      if ('outcome' in decision && decision.outcome.decision === 'routed-to-approval') {
        pending.push(decision.outcome.approval);
      } else if ('outcome' in decision && decision.outcome.decision === 'executed') {
        executed += 1;
      }
    }
    if (pending.length > 0) {
      return { status: 'awaiting-approval', pending };
    }
    // A run that proposed nothing completed vacuously: every (zero)
    // proposals executed, nothing was denied.
    return { status: executed > 0 || proposals.length === 0 ? 'executed' : 'denied', pending };
  };

  /** Emit the run-completed audit event (terminal states only). */
  const auditRunCompleted = async (
    record: AgentRunRecord,
    counts: { readonly executed: number; readonly routed: number; readonly denied: number },
  ): Promise<Result<true, DomainError>> => {
    const input = record.input;
    return audit([
      {
        eventName: AGENT_RUN_COMPLETED_EVENT,
        scope: input.scope,
        actor: input.actor,
        correlationId: input.correlationId,
        causationToken: record.runId,
        occurredAt: deps.now(),
        subject: null,
        payload: {
          runId: record.runId,
          status: record.status,
          executedCount: counts.executed,
          routedCount: counts.routed,
          deniedCount: counts.denied,
          pendingApprovals: record.pendingApprovals.map((approval) => ({
            instanceId: approval.instanceId,
            approvalKey: approval.approvalKey,
          })),
        },
      },
    ]);
  };

  return {
    runAgentGoal: async (rawInput, authorization) => {
      // 0. INPUT — fail-closed validation of the whole run input.
      const parsedInput = parseAgentRunInput(rawInput);
      if (!parsedInput.ok) {
        return fail(
          domainError(
            'invariant-violation',
            `invalid agent run input: ${parsedInput.error.code} at '${
              parsedInput.error.path === '' ? '<root>' : parsedInput.error.path
            }' — expected ${parsedInput.error.expected}, received ${parsedInput.error.received}`,
            [
              {
                code: parsedInput.error.code,
                message: `agent run input rejected: ${parsedInput.error.received}`,
                path: parsedInput.error.path,
              },
            ],
          ),
        );
      }
      const input = parsedInput.value;
      const context = contextOf(input);

      const runId = deps.newRunId();
      const startedAt = deps.now();

      // Resolve the proposing tool up front (fail-closed, before any phase).
      const proposingTool = resolveToolOr(input.proposingTool, input);
      if (!proposingTool.ok) return proposingTool;
      const proposingKind = checkToolKind(proposingTool.value, 'propose-action', input);
      if (!proposingKind.ok) return proposingKind;

      // 1. RUN STARTED — the audit trail opens with the run's identity.
      const started = await audit([
        {
          eventName: AGENT_RUN_STARTED_EVENT,
          scope: input.scope,
          actor: input.actor,
          correlationId: input.correlationId,
          causationToken: runId,
          occurredAt: startedAt,
          subject: null,
          payload: {
            runId,
            goal: input.goal,
            actorKind: input.actor.kind,
            actorId: input.actor.kind === 'system' ? null : input.actor.actorId,
            modelId: deps.model.modelId,
            tools: [
              ...input.retrievalPlan.map((step) => step.tool),
              input.proposingTool,
            ],
            correlationId: input.correlationId,
          },
        },
      ]);
      if (!started.ok) return started;

      // 2. EVIDENCE PHASE — the typed retrieval plan through the read tools.
      const toolAuthorization = toolAuthorizationOf(authorization, {
        actor: input.actor,
        scope: input.scope,
      });
      const items: EvidenceItem[] = [];
      const toolInvocations: ToolInvocationRecord[] = [];
      for (const step of input.retrievalPlan) {
        const tool = resolveToolOr(step.tool, input);
        if (!tool.ok) return tool;
        const kind = checkToolKind(tool.value, 'read', input);
        if (!kind.ok) return kind;
        const reading = tool.value;
        if (!isEvidenceTool(reading)) {
          return fail(
            domainError(
              'invariant-violation',
              `tool '${step.tool}' does not implement the evidence-tool port (internal wiring defect)`,
              [
                {
                  code: 'tool-kind-mismatch',
                  message: 'expected the evidence-tool port',
                  path: 'tools',
                },
              ],
              context,
            ),
          );
        }
        const retrieved = await reading.retrieve(step.query, toolAuthorization);
        if (!retrieved.ok) return retrieved;
        for (const item of retrieved.value) {
          const scoped = checkEvidenceItemScope(item, input);
          if (!scoped.ok) {
            // Fail-closed: an out-of-scope evidence item is a tool defect —
            // the run never grounds on it (freeze A12/A4).
            return fail(
              domainError(
                'unauthorized',
                `agent run evidence item '${item.ref}' (${item.kind}) retrieved by tool '${step.tool}' is outside the run's scope (freeze A12)`,
                [
                  {
                    code: 'evidence-scope-violation',
                    message: `evidence scope ${
                      item.scope.kind === 'project'
                        ? `project ${item.scope.projectId}`
                        : `tenant ${item.scope.tenantId}`
                    } outside the run scope`,
                    path: 'evidence',
                  },
                ],
                context,
              ),
            );
          }
          items.push(item);
        }
        toolInvocations.push({
          tool: step.tool,
          kind: 'read',
          query: step.query,
          itemCount: retrieved.value.length,
          proposalCount: 0,
          invokedAt: deps.now(),
        });
      }
      const gathered = parseEvidenceSet({ items });
      if (!gathered.ok) {
        return fail(
          domainError(
            'invariant-violation',
            `the gathered evidence does not form a valid evidence set: ${gathered.error.code} at '${
              gathered.error.path === '' ? '<root>' : gathered.error.path
            }'`,
            [
              {
                code: gathered.error.code,
                message: gathered.error.received,
                path: gathered.error.path,
              },
            ],
            context,
          ),
        );
      }
      const evidence = gathered.value;

      const evidenceAudited = await audit([
        {
          eventName: AGENT_EVIDENCE_GATHERED_EVENT,
          scope: input.scope,
          actor: input.actor,
          correlationId: input.correlationId,
          causationToken: runId,
          occurredAt: deps.now(),
          subject: null,
          payload: {
            runId,
            items: evidence.items.map((item) => ({
              kind: item.kind,
              ref: item.ref,
              tool: item.retrieval.tool,
              retrievedAt: item.retrieval.retrievedAt,
            })),
          },
        },
      ]);
      if (!evidenceAudited.ok) return evidenceAudited;

      // 3. PROPOSAL PHASE — the injected model behind the proposing tool.
      const proposing = proposingTool.value;
      if (!isProposingTool(proposing)) {
        return fail(
          domainError(
            'invariant-violation',
            `tool '${input.proposingTool}' does not implement the proposing-tool port (internal wiring defect)`,
            [
              {
                code: 'tool-kind-mismatch',
                message: 'expected the proposing port',
                path: 'tools',
              },
            ],
            context,
          ),
        );
      }
      const proposed = await proposing.propose({
        goal: input.goal,
        evidence: evidence.items,
      });
      if (!proposed.ok) return proposed;
      toolInvocations.push({
        tool: input.proposingTool,
        kind: 'propose-action',
        query: null,
        itemCount: 0,
        proposalCount: proposed.value.length,
        invokedAt: deps.now(),
      });

      // THE pre-gateway evidence gate + the proposal audit records.
      const proposals: ProposedActionRecord[] = [];
      for (const action of proposed.value) {
        const evidenceOk = checkProposalEvidence(action, evidence, input);
        if (!evidenceOk.ok) return evidenceOk;
        proposals.push({ proposal: action, proposedAt: deps.now() });
      }
      const proposedAudited = await audit(
        proposals.map((record) => ({
          eventName: AGENT_ACTION_PROPOSED_EVENT,
          scope: input.scope,
          actor: input.actor,
          correlationId: input.correlationId,
          causationToken: record.proposal.command.idempotencyKey,
          occurredAt: record.proposedAt,
          subject: record.proposal.subject,
          payload: {
            runId,
            commandName: record.proposal.command.commandName,
            idempotencyKey: record.proposal.command.idempotencyKey,
            confidence: record.proposal.confidence,
            rationale: record.proposal.rationale,
            evidence: record.proposal.evidence.map((reference) => ({
              slot: reference.slot,
              ref: reference.ref,
            })),
          },
        })),
      );
      if (!proposedAudited.ok) return proposedAudited;

      // 4. GATEWAY PHASE — every proposal through executeAction(), recorded
      //    verbatim. This is the ONLY mutation path (freeze A8).
      const decisions: GatewayDecisionRecord[] = [];
      for (const record of proposals) {
        const decided = await deps.gateway.executeAction(
          toGatewayProposal(record.proposal),
          authorization,
        );
        decisions.push({
          commandName: record.proposal.command.commandName,
          idempotencyKey: record.proposal.command.idempotencyKey,
          at: deps.now(),
          decision: decided.ok ? { outcome: decided.value } : { denial: decided.error },
        });
      }
      const decisionsAudited = await audit(
        decisions.map((record) => ({
          eventName: AGENT_GATEWAY_DECISION_EVENT,
          scope: input.scope,
          actor: input.actor,
          correlationId: input.correlationId,
          causationToken: record.idempotencyKey,
          occurredAt: record.at,
          subject:
            proposals.find(
              (candidate) => candidate.proposal.command.idempotencyKey === record.idempotencyKey,
            )?.proposal.subject ?? null,
          payload: {
            runId,
            commandName: record.commandName,
            idempotencyKey: record.idempotencyKey,
            decision:
              'outcome' in record.decision ? record.decision.outcome.decision : 'denied',
            replayed: 'outcome' in record.decision ? record.decision.outcome.replayed : false,
            approval:
              'outcome' in record.decision && record.decision.outcome.decision === 'routed-to-approval'
                ? {
                    instanceId: record.decision.outcome.approval.instanceId,
                    approvalKey: record.decision.outcome.approval.approvalKey,
                  }
                : null,
            approvalStatus:
              'outcome' in record.decision && record.decision.outcome.decision === 'routed-to-approval'
                ? 'pending'
                : null,
            denialCode:
              'denial' in record.decision ? (record.decision.denial.details[0]?.code ?? 'denied') : null,
          },
        })),
      );
      if (!decisionsAudited.ok) return decisionsAudited;

      // 5. COMPLETION — parked while an approval is pending; terminal else.
      const { status, pending } = statusOf(proposals, decisions);
      const completedAt = status === 'awaiting-approval' ? null : deps.now();
      const runRecord: AgentRunRecord = {
        runId,
        input,
        modelId: deps.model.modelId,
        startedAt,
        completedAt,
        status,
        evidence,
        toolInvocations,
        proposals,
        gatewayDecisions: decisions,
        pendingApprovals: pending,
        authorization,
      };
      if (status === 'awaiting-approval') {
        // The run completes ONLY on resolution: no completion event yet.
        return ok(runRecord);
      }
      const executedCount = decisions.filter(
        (record) => 'outcome' in record.decision && record.decision.outcome.decision === 'executed',
      ).length;
      const routedCount = decisions.filter(
        (record) =>
          'outcome' in record.decision && record.decision.outcome.decision === 'routed-to-approval',
      ).length;
      const completed = await auditRunCompleted(runRecord, {
        executed: executedCount,
        routed: routedCount,
        denied: decisions.length - executedCount - routedCount,
      });
      if (!completed.ok) return completed;
      return ok(runRecord);
    },

    resolveApproval: async (run, resolution, authorization) => {
      const input = run.input;
      const context = contextOf(input);
      if (run.status !== 'awaiting-approval') {
        return fail(
          domainError(
            'invariant-violation',
            `agent run ${run.runId} is '${run.status}', not 'awaiting-approval' — there is no approval to resolve`,
            [
              {
                code: 'run-not-awaiting-approval',
                message: `run status '${run.status}'`,
                path: 'status',
              },
            ],
            context,
          ),
        );
      }
      // Find the routed proposal this approval belongs to.
      const pendingRecord = run.gatewayDecisions.find(
        (record) =>
          'outcome' in record.decision &&
          record.decision.outcome.decision === 'routed-to-approval' &&
          record.decision.outcome.approval.instanceId === resolution.approval.instanceId &&
          record.decision.outcome.approval.approvalKey === resolution.approval.approvalKey,
      );
      if (pendingRecord === undefined || !('outcome' in pendingRecord.decision)) {
        return fail(
          domainError(
            'not-found',
            `agent run ${run.runId} has no pending approval ${resolution.approval.instanceId}/${resolution.approval.approvalKey}`,
            [
              {
                code: 'approval-not-pending',
                message: `approval ${resolution.approval.instanceId}/${resolution.approval.approvalKey} is not pending on this run`,
                path: 'approval',
              },
            ],
            context,
          ),
        );
      }
      const proposalRecord = run.proposals.find(
        (candidate) => candidate.proposal.command.idempotencyKey === pendingRecord.idempotencyKey,
      );
      if (proposalRecord === undefined) {
        return fail(
          domainError(
            'invariant-violation',
            `agent run ${run.runId} records a routed decision without its proposal (internal defect)`,
            [
              {
                code: 'routed-decision-without-proposal',
                message: `idempotency key ${pendingRecord.idempotencyKey}`,
                path: 'proposals',
              },
            ],
            context,
          ),
        );
      }

      // Re-enter the gateway WITH the approval evidence: approved executes
      // (the gateway re-verifies through the authority); rejected denies.
      const reProposal = proposedAction({
        command: proposalRecord.proposal.command,
        subject: proposalRecord.proposal.subject,
        evidence: proposalRecord.proposal.evidence.map((reference) => ({
          slot: reference.slot,
          ref: reference.ref,
        })),
        confidence: proposalRecord.proposal.confidence,
        rationale: proposalRecord.proposal.rationale,
        resourceScope: proposalRecord.proposal.resourceScope,
        approval: {
          instanceId: resolution.approval.instanceId,
          approvalKey: resolution.approval.approvalKey,
        },
      });
      const decided = await deps.gateway.executeAction(toGatewayProposal(reProposal), authorization);
      const decisionRecord: GatewayDecisionRecord = {
        commandName: proposalRecord.proposal.command.commandName,
        idempotencyKey: proposalRecord.proposal.command.idempotencyKey,
        at: deps.now(),
        decision: decided.ok ? { outcome: decided.value } : { denial: decided.error },
      };
      const reEntryAudited = await audit([
        {
          eventName: AGENT_GATEWAY_DECISION_EVENT,
          scope: input.scope,
          actor: input.actor,
          correlationId: input.correlationId,
          causationToken: decisionRecord.idempotencyKey,
          occurredAt: decisionRecord.at,
          subject: proposalRecord.proposal.subject,
          payload: {
            runId: run.runId,
            commandName: decisionRecord.commandName,
            idempotencyKey: decisionRecord.idempotencyKey,
            decision:
              'outcome' in decisionRecord.decision ? decisionRecord.decision.outcome.decision : 'denied',
            replayed: 'outcome' in decisionRecord.decision ? decisionRecord.decision.outcome.replayed : false,
            approval:
              'outcome' in decisionRecord.decision && decisionRecord.decision.outcome.decision === 'routed-to-approval'
                ? {
                    instanceId: decisionRecord.decision.outcome.approval.instanceId,
                    approvalKey: decisionRecord.decision.outcome.approval.approvalKey,
                  }
                : {
                    instanceId: resolution.approval.instanceId,
                    approvalKey: resolution.approval.approvalKey,
                  },
            approvalStatus: resolution.decided,
            denialCode:
              'denial' in decisionRecord.decision
                ? (decisionRecord.decision.denial.details[0]?.code ?? 'denied')
                : null,
          },
        },
      ]);
      if (!reEntryAudited.ok) return reEntryAudited;

      const decisions = [...run.gatewayDecisions, decisionRecord];
      const { status, pending } = statusOf(run.proposals, decisions);
      const completedAt = status === 'awaiting-approval' ? run.completedAt : decisionRecord.at;
      const updated: AgentRunRecord = {
        ...run,
        status,
        completedAt,
        gatewayDecisions: decisions,
        pendingApprovals: pending,
        authorization,
      };
      if (status === 'awaiting-approval') {
        // Other approvals are still pending: the run still does not complete.
        return ok(updated);
      }
      const executedCount = decisions.filter(
        (record) => 'outcome' in record.decision && record.decision.outcome.decision === 'executed',
      ).length;
      const routedCount = decisions.filter(
        (record) =>
          'outcome' in record.decision && record.decision.outcome.decision === 'routed-to-approval',
      ).length;
      const completed = await auditRunCompleted(updated, {
        executed: executedCount,
        routed: routedCount,
        denied: decisions.length - executedCount - routedCount,
      });
      if (!completed.ok) return completed;
      return ok(updated);
    },
  };
}
