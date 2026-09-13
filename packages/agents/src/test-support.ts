// Office agent runtime — deterministic test support (OFF-018).
//
// The shared fixtures of the package's acceptance suites, mirroring the
// landed packages' test idioms (actions/workflows/intelligence): fixed
// tenants/projects/actors, an injected auto-ticking clock + canonical-id and
// run-id suppliers (no wall clock, no randomness), the REAL action gateway
// wired through counting handlers + the in-memory approval authority +
// in-memory idempotency registry (wrapped in a COUNTING gateway so the
// suites prove gateway-mediated execution by invocation counting), the REAL
// relationship index folded from ledger-shaped events through
// @office/intelligence-relationships' own in-memory event source and
// projection, the deterministic built-in evidence tools over that index and
// over recorded assessment/memory artifacts, the fixture-scripted mock model
// behind the model-proposing tool, and typed Result assertion helpers.
//
// Package-internal (NOT re-exported from index.ts): test files import it
// through the relative path only.
import {
  parseCommandEnvelope,
  parseCorrelationId,
  parseDomainEventEnvelope,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  CommandEnvelope,
  DomainEventEnvelope,
  EntityRef,
  ProjectId,
  Scope,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  createInMemoryActionHandlers,
  createInMemoryActionRegistry,
  createInMemoryApprovalAuthority,
  createInMemoryEventSink,
  createActionGateway,
  defineActionDescriptor,
} from '@office/actions';
import type {
  ActionAuthorization,
  ActionDescriptor,
  ActionGateway,
  EventSink as GatewayEventSink,
  InMemoryApprovalAuthority,
} from '@office/actions';
import {
  createInMemoryIdempotencyRegistry,
  domainError,
  ok,
} from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import {
  createInMemoryEventSource,
  projectRelationships,
} from '@office/intelligence-relationships';
import type { RelationshipIndex } from '@office/intelligence-relationships';
import { parseAssessmentId } from '@office/intelligence-margin';
import { parseLessonId, parseOutcomeId } from '@office/intelligence-memory';
import {
  createAssessmentEvidenceTool,
  createInMemoryToolRegistry,
  createMemoryEvidenceTool,
  createModelProposingTool,
  createRelationshipTraversalTool,
} from './tools';
import type { AssessmentEvidenceRecord, MemoryLessonEvidenceRecord, MemoryOutcomeEvidenceRecord, Tool } from './tools';
import { createScriptedModel } from './model';
import type { ModelScriptEntry, ScriptedModel } from './model';
import { createAgentRuntime, parseAgentRunInput } from './run';
import type { AgentRunInput, EvidenceRetrievalStep } from './run';
import { createInMemoryAgentEventSink } from './execution-records';
import type { AgentEventSink } from './execution-records';
import type { AgentRunId } from './vocabulary';

/** Unwrap a successful parse Result (fails loud in tests). */
export const unwrap = <T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

/** Unwrap a successful Result (fails loud in tests). */
export const expectOk = <T>(result: Result<T, DomainError>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

/** Expect a typed failure and return its error (fails loud on success). */
export const expectFail = <T>(result: Result<T, DomainError>): DomainError => {
  if (!result.ok) return result.error;
  throw new Error(`expected a typed failure, got: ${JSON.stringify(result.value)}`);
};

// ----- fixed identities ----------------------------------------------------------------------

export const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
export const TENANT_B = unwrap(parseTenantId('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'));
export const PROJECT_1 = unwrap(parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
export const PROJECT_2 = unwrap(parseProjectId('office-prj-v1-2b3c4d5e6f708192a3b4c5d6e7f8a9b'));

export const AGENT_ID = unwrap(parseEntityId('office-ent-v1-a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
export const USER_ID = unwrap(parseEntityId('office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1'));
export const MANAGER_ID = unwrap(parseEntityId('office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4'));

/** The ledger-fixture entity identities (the evidence graph's nodes). */
export const CHANGE_EVENT_1 = unwrap(parseEntityId('office-ent-v1-c1a2b3c4d5e6f708192a3b4c5d6e7f8a'));
export const REVISION_1 = unwrap(parseEntityId('office-ent-v1-d2b3c4d5e6f708192a3b4c5d6e7f8a9'));
export const BUDGET_REVISION_1 = unwrap(parseEntityId('office-ent-v1-e3c4d5e6f708192a3b4c5d6e7f8a9b'));
export const DOCUMENT_1 = unwrap(parseEntityId('office-ent-v1-f4d5e6f708192a3b4c5d6e7f8a9b2c'));

/** The run's agent actor (kind 'agent' — the A4 source identity). */
export const AGENT_ACTOR: Actor = { kind: 'agent', actorId: AGENT_ID };

export const CORRELATION_ID = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));

export const projectScopeOf = (
  projectId: ProjectId,
  tenantId: TenantId = TENANT_A,
): Scope => ({
  kind: 'project',
  tenantId,
  projectId,
});

export const tenantScopeOf = (tenantId: TenantId): Scope => ({
  kind: 'tenant',
  tenantId,
});

// ----- deterministic clock / id suppliers ------------------------------------------------------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);
const tsAt = (offsetSeconds: number): Timestamp =>
  unwrap(parseTimestamp(new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString()));

export const T0 = tsAt(0);
export const T1 = tsAt(7);
export const T2 = tsAt(14);
export const T3 = tsAt(21);

export const FAKE_EXECUTOR: SqlExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

// ----- the canonical action-descriptor vocabulary ----------------------------------------------

const ALL_ACTOR_KINDS: readonly Actor['kind'][] = ['user', 'agent', 'app', 'adapter', 'system'];

/** Read-class fixture: a pure query over cost items. */
export const LIST_COST_ITEMS = defineActionDescriptor({
  commandName: 'cost.listCostItems',
  title: 'List cost items',
  description: 'Query the cost items of a project (read class).',
  actionClass: 'read',
  actorKinds: [...ALL_ACTOR_KINDS],
  requiredCapabilities: ['cost.read'],
  policyRef: 'policy/cost-queries@1',
  evidenceRequirements: [],
  requiredConfidence: 'low',
  resourceKind: 'cost-item',
  compensatingCommand: null,
  approval: null,
});

/** Reversible-class fixture: a field progress record with an evidence slot. */
export const RECORD_PROGRESS = defineActionDescriptor({
  commandName: 'field.recordProgress',
  title: 'Record field progress',
  description: 'Record a field progress observation (reversible class).',
  actionClass: 'reversible',
  actorKinds: [...ALL_ACTOR_KINDS],
  requiredCapabilities: ['work.write'],
  policyRef: 'policy/field-progress@2',
  evidenceRequirements: [
    { slot: 'observation', description: 'The field observation backing the progress record.' },
  ],
  requiredConfidence: 'medium',
  resourceKind: 'field-report',
  compensatingCommand: 'field.correctProgress',
  approval: null,
});

/** Reversible-class fixture restricted to human actors (the actor-kind gate). */
export const SUBMIT_DAILY_LOG = defineActionDescriptor({
  commandName: 'documents.submitDailyLog',
  title: 'Submit the daily log',
  description: 'Submit a daily log entry (human actors only).',
  actionClass: 'reversible',
  actorKinds: ['user'],
  requiredCapabilities: ['documents.write'],
  policyRef: 'policy/daily-logs@1',
  evidenceRequirements: [],
  requiredConfidence: 'medium',
  resourceKind: 'daily-log',
  compensatingCommand: 'documents.correctDailyLog',
  approval: null,
});

/** Approval-required fixture: a budget revision commit (A4 evidence + approval). */
export const COMMIT_BUDGET_REVISION = defineActionDescriptor({
  commandName: 'cost.commitBudgetRevision',
  title: 'Commit a budget revision',
  description: 'Commit a budget revision (approval-required class).',
  actionClass: 'approval-required',
  actorKinds: [...ALL_ACTOR_KINDS],
  requiredCapabilities: ['cost.write'],
  policyRef: 'policy/budget-revisions@2',
  evidenceRequirements: [
    { slot: 'justification', description: 'The written justification of the revision.' },
    { slot: 'margin-assessment', description: 'The margin impact assessment behind it.' },
  ],
  requiredConfidence: 'high',
  resourceKind: 'budget-revision',
  compensatingCommand: 'cost.revertBudgetRevision',
  approval: {
    definitionKey: 'action-approval',
    approvalKey: 'action',
    requiredCapability: 'cost.write',
    policyRef: 'policy/budget-revisions@2',
  },
});

/** Prohibited fixture: a destructive ledger purge (never executed). */
export const PURGE_COST_LEDGER = defineActionDescriptor({
  commandName: 'cost.purgeCostLedger',
  title: 'Purge the cost ledger',
  description: 'Destructive purge (prohibited class — never executed).',
  actionClass: 'prohibited',
  actorKinds: [],
  requiredCapabilities: [],
  policyRef: 'policy/destructive@0',
  evidenceRequirements: [],
  requiredConfidence: 'low',
  resourceKind: 'cost-item',
  compensatingCommand: null,
  approval: null,
});

/** The canonical descriptor set of the acceptance suites, in order. */
export const CANONICAL_DESCRIPTORS: readonly ActionDescriptor[] = [
  LIST_COST_ITEMS,
  RECORD_PROGRESS,
  SUBMIT_DAILY_LOG,
  COMMIT_BUDGET_REVISION,
  PURGE_COST_LEDGER,
];

// ----- counting handlers (the invocation proofs) -----------------------------------------------

/** A typed invariant-violation for handler-failure tests. */
export const handlerFailure = (): DomainError =>
  domainError(
    'invariant-violation',
    'the handler rejected the command (test fixture)',
    [{ code: 'handler-rejected', message: 'test fixture failure', path: null }],
  );

// ----- the relationship index (REAL ledger-shaped fold) -----------------------------------------

const kindOf = (name: string) => unwrap(parseEntityKind(name));

const changeEventRef = (): EntityRef => ({
  entityKind: kindOf('change-event'),
  entityId: CHANGE_EVENT_1,
});
const revisionRef = (): EntityRef => ({ entityKind: kindOf('revision'), entityId: REVISION_1 });
const budgetRevisionRef = (): EntityRef => ({
  entityKind: kindOf('budget-revision'),
  entityId: BUDGET_REVISION_1,
});
export const documentRef = (): EntityRef => ({
  entityKind: kindOf('document'),
  entityId: DOCUMENT_1,
});

let ledgerKeyTick = 0;
const nextLedgerKey = (): string => `led-${String(++ledgerKeyTick).padStart(5, '0')}`;

const ledgerEnvelope = (
  eventName: string,
  payload: Record<string, unknown>,
  entityRefs: { before: EntityRef | null; after: EntityRef | null },
): DomainEventEnvelope =>
  unwrap(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName,
      scope: projectScopeOf(PROJECT_1),
      actor: { kind: 'user', actorId: USER_ID },
      source: 'domain',
      causality: { correlationId: CORRELATION_ID, causationId: nextLedgerKey() },
      schemaVersion: '1.0.0',
      occurredAt: T0,
      entityRefs,
      payload,
    }),
  );

/**
 * Fold the fixture relationship index through the REAL intelligence
 * projection: two ledger-shaped 'documents.evidenceReferenced' events build
 * the evidence graph — (change-event) evidenced-by (revision) and
 * (budget-revision) evidenced-by (revision) — so a traversal from the change
 * event reaches the revision and the budget revision deterministically.
 */
export const buildRelationshipIndex = async (): Promise<RelationshipIndex> => {
  const source = createInMemoryEventSource();
  await source.append(
    ledgerEnvelope(
      'documents.evidenceReferenced',
      {
        revisionId: REVISION_1,
        documentId: DOCUMENT_1,
        evidencedEntityKind: 'change-event',
        evidencedEntityId: CHANGE_EVENT_1,
      },
      { before: null, after: revisionRef() },
    ),
    documentRef(),
  );
  await source.append(
    ledgerEnvelope(
      'documents.evidenceReferenced',
      {
        revisionId: REVISION_1,
        documentId: DOCUMENT_1,
        evidencedEntityKind: 'budget-revision',
        evidencedEntityId: BUDGET_REVISION_1,
      },
      { before: null, after: budgetRevisionRef() },
    ),
    documentRef(),
  );
  return unwrap(projectRelationships(source.events));
};

// ----- the recorded intelligence artifacts (evidence sources) ------------------------------------

export const ASSESSMENT_1 = unwrap(parseAssessmentId('asm-budget-revision-0001'));
export const ASSESSMENT_FOREIGN = unwrap(parseAssessmentId('asm-foreign-tenant-0002'));
export const OUTCOME_1 = unwrap(parseOutcomeId('outcome-project-one-0001'));
export const OUTCOME_2 = unwrap(parseOutcomeId('outcome-project-two-0002'));
export const LESSON_1 = unwrap(parseLessonId('lesson-contract-protect-0001'));

/** The recorded margin assessments the assessment tool serves (tenant A). */
export const assessmentRecords = (): readonly AssessmentEvidenceRecord[] => [
  {
    assessmentId: ASSESSMENT_1,
    scope: projectScopeOf(PROJECT_1),
    sourceEventId: CHANGE_EVENT_1,
    assessedAt: T1,
    confidence: 'high',
  },
  {
    // A tenant-B assessment: invisible to tenant-A runs (no existence
    // oracle — indistinguishable from an absent one).
    assessmentId: ASSESSMENT_FOREIGN,
    scope: projectScopeOf(PROJECT_2, TENANT_B),
    sourceEventId: CHANGE_EVENT_1,
    assessedAt: T1,
    confidence: 'high',
  },
];

/** The recorded memory outcomes the memory tool serves. */
export const memoryOutcomeRecords = (): readonly MemoryOutcomeEvidenceRecord[] => [
  {
    outcomeId: OUTCOME_1,
    scope: projectScopeOf(PROJECT_1),
    projectId: PROJECT_1,
    recordedAt: T2,
    confidence: 'high',
  },
  {
    outcomeId: OUTCOME_2,
    scope: projectScopeOf(PROJECT_2, TENANT_B),
    projectId: PROJECT_2,
    recordedAt: T2,
    confidence: 'high',
  },
];

/** The recorded memory lessons the memory tool serves. */
export const memoryLessonRecords = (): readonly MemoryLessonEvidenceRecord[] => [
  {
    lessonId: LESSON_1,
    scope: projectScopeOf(PROJECT_1),
    capturedAt: T3,
    confidence: 'medium',
  },
];

// ----- the fixture-scripted model (the deterministic mock) --------------------------------------

export const GOAL_COMMIT_BUDGET =
  'Commit the justified budget revision grounding on the revision evidence and the margin assessment.';
export const GOAL_RECORD_PROGRESS =
  'Record the field progress observation grounding on the change event evidence.';
export const GOAL_LIST_COST_ITEMS = 'List the cost items of project one.';
export const GOAL_SUBMIT_DAILY_LOG = 'Submit the daily log for project one.';
export const GOAL_PURGE_LEDGER = 'Purge the cost ledger.';
export const GOAL_UNEVIDENCED_COMMIT =
  'Commit the budget revision without grounding on any evidence.';

let keyTick = 0;
export const nextKey = (): string => `agt-${String(++keyTick).padStart(5, '0')}`;

/**
 * Reset the module-level fixture counters (ledger keys + command keys): every
 * harness build starts from the same fixture state, so two harnesses built
 * the same way produce byte-identical runs — the run-twice determinism proof
 * rests on it.
 */
const resetFixtureCounters = (): void => {
  ledgerKeyTick = 0;
  keyTick = 0;
};

/** Build a validated command envelope (deterministic keys, the agent actor). */
export const envelope = (
  payload: unknown,
  commandName: string,
  options: {
    readonly scope?: Scope;
    readonly key?: string;
    readonly actor?: Actor;
    readonly causationId?: string | null;
  } = {},
): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: options.scope ?? projectScopeOf(PROJECT_1),
      actor: options.actor ?? AGENT_ACTOR,
      idempotencyKey: options.key ?? nextKey(),
      causality: {
        correlationId: CORRELATION_ID,
        causationId: options.causationId ?? null,
      },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

/** The evidence-reference tokens the fixture graph produces. */
export const REVISION_EVIDENCE_REF = `revision:${REVISION_1}`;
export const CHANGE_EVENT_EVIDENCE_REF = `change-event:${CHANGE_EVENT_1}`;
export const BUDGET_REVISION_EVIDENCE_REF = `budget-revision:${BUDGET_REVISION_1}`;

/** The approval-ready budget-revision proposal draft (fully evidenced). */
export const budgetRevisionDraft = (options: { readonly key?: string } = {}) => ({
  command: envelope(
    { revisionId: BUDGET_REVISION_1, amount: 50000 },
    'cost.commitBudgetRevision',
    { key: options.key ?? nextKey() },
  ),
  subject: budgetRevisionRef(),
  evidence: [
    { slot: 'justification', ref: REVISION_EVIDENCE_REF },
    { slot: 'margin-assessment', ref: ASSESSMENT_1 },
  ],
  confidence: 'high',
  rationale:
    'The change event is evidenced by the document revision and the margin impact assessment is within policy.',
  resourceScope: null,
});

/** The reversible field-progress proposal draft (observation evidence). */
export const progressDraft = (options: { readonly key?: string } = {}) => ({
  command: envelope(
    { note: 'foundation poured', percent: 40 },
    'field.recordProgress',
    { key: options.key ?? nextKey() },
  ),
  subject: changeEventRef(),
  evidence: [{ slot: 'observation', ref: CHANGE_EVENT_EVIDENCE_REF }],
  confidence: 'medium',
  rationale: 'The field progress observation is grounded on the captured change event.',
  resourceScope: null,
});

/** The read-class cost-items query draft (no evidence needed). */
export const listCostItemsDraft = () => ({
  command: envelope({ filter: 'all' }, 'cost.listCostItems'),
  subject: null,
  evidence: [],
  confidence: 'low',
  rationale: 'A pure read of the cost items for the current scope.',
  resourceScope: null,
});

/** The human-only daily-log draft (the agent actor-kind denial fixture). */
export const dailyLogDraft = () => ({
  command: envelope({ entry: 'day 12' }, 'documents.submitDailyLog'),
  subject: null,
  evidence: [],
  confidence: 'medium',
  rationale: 'A daily log submission attempt by an agent actor.',
  resourceScope: null,
});

/** The prohibited purge draft (never executed by the gateway). */
export const purgeDraft = () => ({
  command: envelope({ scope: 'all' }, 'cost.purgeCostLedger'),
  subject: null,
  evidence: [],
  confidence: 'low',
  rationale: 'A destructive purge attempt (prohibited class).',
  resourceScope: null,
});

/** The unevidenced budget-revision draft (THE pre-gateway rejection fixture). */
export const unevidencedBudgetRevisionDraft = () => ({
  command: envelope({ revisionId: BUDGET_REVISION_1, amount: 50000 }, 'cost.commitBudgetRevision'),
  subject: budgetRevisionRef(),
  evidence: [],
  confidence: 'high',
  rationale: 'A consequential proposal carrying no evidence references.',
  resourceScope: null,
});

/** The unbacked-evidence budget-revision draft (cites unknown refs). */
export const unbackedBudgetRevisionDraft = () => ({
  command: envelope({ revisionId: BUDGET_REVISION_1, amount: 50000 }, 'cost.commitBudgetRevision'),
  subject: budgetRevisionRef(),
  evidence: [
    { slot: 'justification', ref: 'revision:office-ent-v1-unknown0000000000000000000000000' },
    { slot: 'margin-assessment', ref: ASSESSMENT_1 },
  ],
  confidence: 'high',
  rationale: 'A consequential proposal citing evidence the run never retrieved.',
  resourceScope: null,
});

/** The canonical model scripts of the acceptance suites. */
export const canonicalScripts = (): readonly ModelScriptEntry[] => [
  { goal: GOAL_COMMIT_BUDGET, drafts: [budgetRevisionDraft()] },
  { goal: GOAL_RECORD_PROGRESS, drafts: [progressDraft()] },
  { goal: GOAL_LIST_COST_ITEMS, drafts: [listCostItemsDraft()] },
  { goal: GOAL_SUBMIT_DAILY_LOG, drafts: [dailyLogDraft()] },
  { goal: GOAL_PURGE_LEDGER, drafts: [purgeDraft()] },
  { goal: GOAL_UNEVIDENCED_COMMIT, drafts: [unevidencedBudgetRevisionDraft()] },
];

// ----- the run-input fixtures --------------------------------------------------------------------

/** The standard evidence retrieval plan (traversal + assessment + memory). */
export const standardRetrievalPlan = (): readonly EvidenceRetrievalStep[] => [
  {
    tool: 'relationship-traversal',
    query: {
      kind: 'relationship-traversal',
      query: { start: changeEventRef(), maxDepth: 2 },
    },
  },
  { tool: 'margin-assessment', query: { kind: 'margin-assessment', assessmentId: ASSESSMENT_1 } },
  { tool: 'memory-lookup', query: { kind: 'memory-outcomes', projectId: PROJECT_1 } },
];

/** Build a validated agent run input around a goal. */
export const runInput = (
  goal: string,
  options: {
    readonly scope?: Scope;
    readonly actor?: Actor;
    readonly retrievalPlan?: readonly EvidenceRetrievalStep[];
    readonly proposingTool?: string;
    readonly correlationId?: string;
  } = {},
): AgentRunInput =>
  unwrap(
    parseAgentRunInput({
      goal,
      scope: options.scope ?? projectScopeOf(PROJECT_1),
      actor: options.actor ?? AGENT_ACTOR,
      contextRefs: [changeEventRef()],
      retrievalPlan: options.retrievalPlan ?? standardRetrievalPlan(),
      proposingTool: options.proposingTool ?? 'model-proposer',
      correlationId: options.correlationId ?? CORRELATION_ID,
    }),
  );

// ----- authorization fixtures --------------------------------------------------------------------

export const allowAllPolicy: Policy = definePolicy([
  { effect: 'allow', actions: ['read', 'write'] },
]);
export const denyWritePolicy: Policy = definePolicy([
  { effect: 'deny', actions: ['write'] },
  { effect: 'allow', actions: ['read', 'write'] },
]);

/** Compose an ActionAuthorization from capabilities + policy. */
export const grantOf = (
  capabilities: readonly string[],
  policy: Policy = allowAllPolicy,
): ActionAuthorization => ({ policy, capabilities });

/**
 * The full agent grant: the gateway's canonical capabilities plus every
 * intelligence read capability the evidence tools gate on.
 */
export const fullGrant: ActionAuthorization = grantOf([
  'cost.read',
  'cost.write',
  'work.write',
  'documents.write',
  'documents.read',
  'contracts.read',
  'schedule.read',
]);

/** Missing cost.write (the capability-state fixture). */
export const missingCostWriteGrant: ActionAuthorization = grantOf([
  'cost.read',
  'work.write',
  'documents.write',
  'documents.read',
  'contracts.read',
  'schedule.read',
]);

/** No capabilities at all (the deny-by-default fixture). */
export const noCapabilitiesGrant: ActionAuthorization = grantOf([]);

// ----- THE deterministic agent harness -----------------------------------------------------------

/** The counting gateway: records every executeAction call (THE proof). */
export interface CountingGateway {
  readonly gateway: ActionGateway;
  readonly calls: { count: number; keys: string[] };
}

export interface AgentHarness {
  readonly runtime: ReturnType<typeof createAgentRuntime>;
  readonly model: ScriptedModel;
  readonly tools: ReturnType<typeof createInMemoryToolRegistry>;
  readonly countedGateway: CountingGateway;
  readonly handlerInvocations: Record<string, { count: number }>;
  readonly agentSink: AgentEventSink;
  readonly gatewaySink: GatewayEventSink;
  readonly approvalAuthority: InMemoryApprovalAuthority;
  readonly ids: { issued: number; runs: number };
  /** Jump the injected clock to `offsetSeconds` from the harness epoch. */
  readonly setClock: (offsetSeconds: number) => void;
}

/**
 * Build the deterministic agent harness: the REAL action gateway (counting
 * handlers, in-memory approval authority + idempotency registry, the
 * gateway's own audit sink) wrapped in a COUNTING gateway; the REAL
 * relationship index folded from ledger-shaped events; the three built-in
 * read tools plus the model-proposing tool (the fixture-scripted mock model
 * behind it); the agent runtime with an auto-ticking injected clock and
 * sequential run-id/entity-id suppliers — everything fresh and every fixture
 * counter reset, so two harnesses built the same way produce byte-identical
 * runs.
 */
export const makeAgentHarness = async (options: {
  readonly scripts?: readonly ModelScriptEntry[];
  readonly agentSink?: AgentEventSink;
  readonly gatewaySink?: GatewayEventSink;
  /** The READ tools of the registry (the proposer is always registered). */
  readonly readTools?: readonly Tool[];
} = {}): Promise<AgentHarness> => {
  resetFixtureCounters();
  const index = await buildRelationshipIndex();
  let clockTick = 0;
  const now = (): Timestamp => tsAt(clockTick++ * 7);
  const ids = { issued: 0, runs: 0 };

  const model = createScriptedModel({
    modelId: 'mock-model-fixture-v1',
    scripts: options.scripts ?? canonicalScripts(),
  });
  const proposingTool = createModelProposingTool({ model });
  const defaultReadTools: readonly Tool[] = [
    createRelationshipTraversalTool({ index, now }),
    createAssessmentEvidenceTool({ assessments: assessmentRecords(), now }),
    createMemoryEvidenceTool({
      outcomes: memoryOutcomeRecords(),
      lessons: memoryLessonRecords(),
      now,
    }),
  ];
  const tools = createInMemoryToolRegistry([
    ...(options.readTools ?? defaultReadTools),
    proposingTool,
  ]);

  const registry = createInMemoryActionRegistry(CANONICAL_DESCRIPTORS);
  const handlerInvocations: Record<string, { count: number }> = {};
  const handlerMap: Record<
    string,
    (command: CommandEnvelope) => Promise<Result<unknown, DomainError>>
  > = {};
  for (const descriptor of CANONICAL_DESCRIPTORS) {
    const name = descriptor.commandName as string;
    const counter = { count: 0 };
    handlerInvocations[name] = counter;
    handlerMap[name] = async (command) => {
      counter.count += 1;
      return ok({ handled: name, payload: command.payload });
    };
  }
  const handlers = createInMemoryActionHandlers(handlerMap);
  const gatewaySink = options.gatewaySink ?? createInMemoryEventSink();
  const approvalAuthority = createInMemoryApprovalAuthority();
  const gateway = createActionGateway({
    registry,
    handlers,
    idempotencyRegistry: createInMemoryIdempotencyRegistry(),
    eventSink: gatewaySink,
    approvalAuthority,
    now,
    newEntityId: () => {
      ids.issued += 1;
      return unwrap(parseEntityId(`office-ent-v1-${String(ids.issued).padStart(16, '0')}`));
    },
    executor: FAKE_EXECUTOR,
  });

  const calls = { count: 0, keys: [] as string[] };
  const countedGateway: CountingGateway = {
    calls,
    gateway: {
      executeAction: async (proposal, authorization) => {
        calls.count += 1;
        calls.keys.push(proposal.command.idempotencyKey as string);
        return gateway.executeAction(proposal, authorization);
      },
    },
  };

  const agentSink = options.agentSink ?? createInMemoryAgentEventSink();
  const runtime = createAgentRuntime({
    tools,
    model,
    gateway: countedGateway.gateway,
    registry,
    eventSink: agentSink,
    now,
    newRunId: () => {
      ids.runs += 1;
      return `run-${String(ids.runs).padStart(4, '0')}` as AgentRunId;
    },
    executor: FAKE_EXECUTOR,
  });

  return {
    runtime,
    model,
    tools,
    countedGateway,
    handlerInvocations,
    agentSink,
    gatewaySink,
    approvalAuthority,
    ids,
    setClock: (offsetSeconds: number) => {
      clockTick = Math.floor(offsetSeconds / 7);
    },
  };
};
