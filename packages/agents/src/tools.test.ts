// OFF-018 — the typed tool registry + the four deterministic built-in tools.
// THE A8 tool contract under test: 'read' tools RETRIEVE evidence (pure
// referenced data, no execution surface); the 'propose-action' tool PRODUCES
// validated proposals through the injected ModelPort (never executes them —
// the only execution path is the runtime handing proposals to the gateway).
// The A12 discipline of the read tools: out-of-scope artifacts are INVISIBLE
// (typed not-found with no existence oracle for the by-id tools; silently
// excluded for the list queries), and every capability gate fails typed.
import { describe, expect, it } from 'vitest';
import { parseEntityKind } from '@office/contracts';
import { ok } from '@office/domain-kernel';
import {
  createAssessmentEvidenceTool,
  createInMemoryToolRegistry,
  createMemoryEvidenceTool,
  createModelProposingTool,
  createRelationshipTraversalTool,
  defineToolDescriptor,
  isEvidenceTool,
  isProposingTool,
  toolAuthorizationOf,
} from './tools';
import type { EvidenceTool, Tool } from './tools';
import { createScriptedModel } from './model';
import {
  AGENT_ACTOR,
  ASSESSMENT_1,
  ASSESSMENT_FOREIGN,
  BUDGET_REVISION_EVIDENCE_REF,
  CHANGE_EVENT_1,
  GOAL_COMMIT_BUDGET,
  LESSON_1,
  OUTCOME_1,
  PROJECT_1,
  PROJECT_2,
  REVISION_EVIDENCE_REF,
  T1,
  TENANT_B,
  assessmentRecords,
  budgetRevisionDraft,
  buildRelationshipIndex,
  envelope,
  expectFail,
  expectOk,
  fullGrant,
  grantOf,
  memoryLessonRecords,
  memoryOutcomeRecords,
  projectScopeOf,
  tenantScopeOf,
  unwrap,
} from './test-support';

const changeEventRef = () => ({
  entityKind: unwrap(parseEntityKind('change-event')),
  entityId: CHANGE_EVENT_1,
});

/** The run-style authorization the read tools retrieve under. */
const authorizationOf = (scope = projectScopeOf(PROJECT_1), grant = fullGrant) =>
  toolAuthorizationOf(grant, { actor: AGENT_ACTOR, scope });

// ----- the registry -------------------------------------------------------------------------------

/** A minimal well-formed read tool for registry semantics tests. */
const stubReadTool = (name: string): EvidenceTool => ({
  descriptor: defineToolDescriptor({ name, kind: 'read', title: `Stub ${name}` }),
  retrieve: async () => ok([]),
});

describe('createInMemoryToolRegistry (fail-closed construction)', () => {
  it('resolves registered tools by name and returns null for unknown names', () => {
    const registry = createInMemoryToolRegistry([stubReadTool('stub-reader')]);
    const resolved = registry.resolve('stub-reader');
    expect(resolved?.descriptor.name).toBe('stub-reader');
    expect(registry.resolve('no-such-tool')).toBeNull();
    expect(registry.descriptors()).toHaveLength(1);
    expect(registry.descriptors()[0]?.kind).toBe('read');
  });

  it('rejects duplicate registrations loudly', () => {
    expect(() =>
      createInMemoryToolRegistry([stubReadTool('stub-reader'), stubReadTool('stub-reader')]),
    ).toThrow(/duplicate tool registration/);
  });

  it('rejects a read descriptor behind the proposing port (kind dictates the port)', () => {
    const miswired = {
      descriptor: defineToolDescriptor({ name: 'miswired', kind: 'read', title: 'Miswired' }),
      propose: async () => ok([]),
    } as unknown as Tool;
    expect(() => createInMemoryToolRegistry([miswired])).toThrow(
      /declares kind 'read' but does not implement the evidence-tool port/,
    );
  });

  it('rejects a propose-action descriptor behind the evidence port', () => {
    const miswired = {
      descriptor: defineToolDescriptor({
        name: 'miswired',
        kind: 'propose-action',
        title: 'Miswired',
      }),
      retrieve: async () => ok([]),
    } as unknown as Tool;
    expect(() => createInMemoryToolRegistry([miswired])).toThrow(
      /declares kind 'propose-action' but does not implement the proposing-tool port/,
    );
  });

  it('rejects a tool implementing both ports (exactly one kind)', () => {
    const both = {
      descriptor: defineToolDescriptor({ name: 'both-ports', kind: 'read', title: 'Both' }),
      retrieve: async () => ok([]),
      propose: async () => ok([]),
    } as unknown as Tool;
    expect(() => createInMemoryToolRegistry([both])).toThrow(/implements both ports/);
  });

  it('rejects a tool implementing NEITHER port (a read descriptor must front the evidence port)', () => {
    const neither = {
      descriptor: defineToolDescriptor({ name: 'no-port', kind: 'read', title: 'Neither' }),
    } as unknown as Tool;
    expect(() => createInMemoryToolRegistry([neither])).toThrow(
      /declares kind 'read' but does not implement the evidence-tool port/,
    );
  });
});

// ----- the relationship-traversal tool (REAL intelligence traversal) -------------------------------

describe('the relationship-traversal evidence tool', () => {
  it('retrieves the authorization-filtered subgraph as referenced evidence items', async () => {
    const index = await buildRelationshipIndex();
    const tool = createRelationshipTraversalTool({ index, now: () => T1 });
    expect(tool.descriptor.kind).toBe('read');
    expect(isEvidenceTool(tool)).toBe(true);
    const query = {
      kind: 'relationship-traversal',
      query: { start: changeEventRef(), maxDepth: 2 },
    } as const;
    const items = expectOk(await tool.retrieve(query, authorizationOf()));
    // The subgraph reaches depth 2: change-event → revision → budget-revision
    // (the revision is evidenced-by AND evidences both ends).
    expect(items.map((item) => item.ref)).toStrictEqual([
      `change-event:${CHANGE_EVENT_1}`,
      REVISION_EVIDENCE_REF,
      BUDGET_REVISION_EVIDENCE_REF,
    ]);
    for (const item of items) {
      expect(item.kind).toBe('entity');
      expect(item.scope).toStrictEqual(projectScopeOf(PROJECT_1));
      expect(item.confidence).toBe('high');
      expect(item.retrieval.tool).toBe('relationship-traversal');
      expect(item.retrieval.query).toStrictEqual(query);
      expect(item.retrieval.retrievedAt).toBe(T1);
    }
  });

  it('answers a mismatched query kind with a typed tool-query-mismatch failure', async () => {
    const index = await buildRelationshipIndex();
    const tool = createRelationshipTraversalTool({ index, now: () => T1 });
    const result = await tool.retrieve({ kind: 'memory-lessons' }, authorizationOf());
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('tool-query-mismatch');
  });

  it('surfaces the traversal engine’s own typed not-found for a cross-scope start (no oracle)', async () => {
    const index = await buildRelationshipIndex();
    const tool = createRelationshipTraversalTool({ index, now: () => T1 });
    const result = await tool.retrieve(
      {
        kind: 'relationship-traversal',
        query: { start: changeEventRef(), maxDepth: 2 },
      },
      authorizationOf(tenantScopeOf(TENANT_B)),
    );
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('entity-not-found');
  });
});

// ----- the assessment-evidence tool (recorded margin assessments) -----------------------------------

describe('the assessment-evidence tool', () => {
  it('retrieves a recorded assessment by its typed identity with full provenance', async () => {
    const tool = createAssessmentEvidenceTool({
      assessments: assessmentRecords(),
      now: () => T1,
    });
    expect(tool.descriptor.kind).toBe('read');
    const query = { kind: 'margin-assessment', assessmentId: ASSESSMENT_1 } as const;
    const items = expectOk(await tool.retrieve(query, authorizationOf()));
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.kind).toBe('margin-assessment');
    expect(item?.ref).toBe(ASSESSMENT_1);
    expect(item?.entity).toStrictEqual(changeEventRef());
    expect(item?.scope).toStrictEqual(projectScopeOf(PROJECT_1));
    expect(item?.confidence).toBe('high');
    expect(item?.retrieval.tool).toBe('margin-assessment');
    expect(item?.retrieval.query).toStrictEqual(query);
    expect(item?.retrieval.retrievedAt).toBe(T1);
  });

  it('rejects the FOREIGN-tenant assessment typed not-found (identical to an absent one)', async () => {
    // ASSESSMENT_FOREIGN is recorded — but under tenant B: retrieving it from
    // a tenant-A authorization is typed not-found, never a leak (no oracle).
    const tool = createAssessmentEvidenceTool({
      assessments: assessmentRecords(),
      now: () => T1,
    });
    const result = await tool.retrieve(
      { kind: 'margin-assessment', assessmentId: ASSESSMENT_FOREIGN },
      authorizationOf(),
    );
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('evidence-not-found');
  });

  it('fails typed forbidden when the margin capabilities are missing (deny-by-default)', async () => {
    const tool = createAssessmentEvidenceTool({
      assessments: assessmentRecords(),
      now: () => T1,
    });
    const result = await tool.retrieve(
      { kind: 'margin-assessment', assessmentId: ASSESSMENT_1 },
      authorizationOf(projectScopeOf(PROJECT_1), grantOf(['cost.read'])),
    );
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('missing-required-capability');
  });

  it('answers a mismatched query kind with the typed tool-query-mismatch failure', async () => {
    const tool = createAssessmentEvidenceTool({
      assessments: assessmentRecords(),
      now: () => T1,
    });
    const result = await tool.retrieve({ kind: 'memory-lessons' }, authorizationOf());
    expect(result.ok).toBe(false);
    expect(expectFail(result).details[0]?.code).toBe('tool-query-mismatch');
  });
});

// ----- the memory-evidence tool (recorded outcomes and lessons) --------------------------------------

describe('the memory-evidence tool', () => {
  const toolOf = () =>
    createMemoryEvidenceTool({
      outcomes: memoryOutcomeRecords(),
      lessons: memoryLessonRecords(),
      now: () => T1,
    });

  it('lists only the outcomes visible to the requesting scope (foreign ones invisible)', async () => {
    const tool = toolOf();
    expect(tool.descriptor.kind).toBe('read');
    const items = expectOk(
      await tool.retrieve({ kind: 'memory-outcomes', projectId: null }, authorizationOf()),
    );
    // OUTCOME_2 lives under tenant B: invisible to the tenant-A authorization.
    expect(items.map((item) => item.ref)).toStrictEqual([OUTCOME_1]);
    expect(items[0]?.kind).toBe('memory-outcome');
    expect(items[0]?.scope).toStrictEqual(projectScopeOf(PROJECT_1));
    expect(items[0]?.retrieval.tool).toBe('memory-lookup');
  });

  it('filters memory outcomes by the queried project id', async () => {
    const items = expectOk(
      await toolOf().retrieve(
        { kind: 'memory-outcomes', projectId: PROJECT_2 },
        authorizationOf(),
      ),
    );
    expect(items).toStrictEqual([]);
  });

  it('retrieves recorded lessons with their captured provenance', async () => {
    const items = expectOk(await toolOf().retrieve({ kind: 'memory-lessons' }, authorizationOf()));
    expect(items.map((item) => item.ref)).toStrictEqual([LESSON_1]);
    expect(items[0]?.kind).toBe('memory-lesson');
    expect(items[0]?.entity).toBeNull();
    expect(items[0]?.confidence).toBe('medium');
  });

  it('fails typed forbidden when the memory capabilities are missing', async () => {
    const result = await toolOf().retrieve(
      { kind: 'memory-lessons' },
      authorizationOf(projectScopeOf(PROJECT_1), grantOf([])),
    );
    expect(result.ok).toBe(false);
    expect(expectFail(result).details[0]?.code).toBe('missing-required-capability');
  });
});

// ----- the model-proposing tool (the injected ModelPort behind a typed descriptor) ------------------

describe('the model-proposing tool (proposals, never executions)', () => {
  const toolOf = (drafts: readonly unknown[]) =>
    createModelProposingTool({
      model: createScriptedModel({
        modelId: 'mock-model-fixture-v1',
        scripts: [{ goal: GOAL_COMMIT_BUDGET, drafts: drafts as never }],
      }),
    });

  it('converts the model’s drafts into VALIDATED proposals (fail-closed, byte-faithful refs)', async () => {
    const tool = toolOf([budgetRevisionDraft()]);
    expect(tool.descriptor.kind).toBe('propose-action');
    expect(isProposingTool(tool)).toBe(true);
    const proposals = expectOk(await tool.propose({ goal: GOAL_COMMIT_BUDGET, evidence: [] }));
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal?.command.commandName).toBe('cost.commitBudgetRevision');
    expect(proposal?.confidence).toBe('high');
    expect(proposal?.evidence.map((reference) => reference.ref)).toStrictEqual([
      REVISION_EVIDENCE_REF,
      ASSESSMENT_1,
    ]);
    expect(proposal?.approval).toBeNull();
  });

  it('rejects an INVALID draft typed (invalid-model-proposal), never a coerced proposal', async () => {
    const invalidDraft = { ...budgetRevisionDraft(), confidence: 'ultra' };
    const tool = toolOf([invalidDraft]);
    const result = await tool.propose({ goal: GOAL_COMMIT_BUDGET, evidence: [] });
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('invalid-model-proposal');
    expect(error.message).toContain('mock-model-fixture-v1');
  });

  it('passes the model port’s own typed failures through unchanged', async () => {
    const tool = toolOf([]);
    const result = await tool.propose({ goal: 'an unscripted goal', evidence: [] });
    expect(result.ok).toBe(false);
    expect(expectFail(result).details[0]?.code).toBe('scripted-model-no-entry');
  });
});

// ----- the ports are injected (structural) -----------------------------------------------------------

describe('the tool ports are injected ports (no execution surface of their own)', () => {
  it('the evidence-tool port exposes ONLY retrieval (a read tool cannot mutate)', async () => {
    const index = await buildRelationshipIndex();
    const tool: EvidenceTool = createRelationshipTraversalTool({ index, now: () => T1 });
    expect(Object.keys(tool)).toStrictEqual(['descriptor', 'retrieve']);
    // The registry never holds handlers, stores, gateways, or executors.
    const registry = createInMemoryToolRegistry([tool]);
    expect(Object.keys(registry)).toStrictEqual(['resolve', 'descriptors']);
  });

  it('the fixture envelopes satisfy the command grammar the ports consume (agent actor)', () => {
    const command = envelope({ note: 'fixture' }, 'field.recordProgress');
    expect(command.actor.kind).toBe('agent');
    expect(command.idempotencyKey).toMatch(/^agt-\d{5}$/);
  });
});
