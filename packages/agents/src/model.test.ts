// OFF-018 — the deterministic mock model port: the run-twice determinism
// proof rests on the scripted model being a pure lookup table (the same input
// always produces the byte-identical drafts) with a LOUD, typed fail-closed
// miss (an unscripted goal invents nothing). The port itself is an injected
// seam — no LLM, no network, no clock, no randomness anywhere in it.
import { describe, expect, it } from 'vitest';
import { createScriptedModel } from './model';
import type { ModelScriptEntry } from './model';
import { parseEvidenceItem } from './evidence';
import {
  PROJECT_1,
  T0,
  canonicalScripts,
  expectFail,
  expectOk,
  progressDraft,
  projectScopeOf,
  unwrap,
} from './test-support';
import { GOAL_COMMIT_BUDGET, GOAL_RECORD_PROGRESS } from './test-support';

const modelOf = (scripts: readonly ModelScriptEntry[]) =>
  createScriptedModel({ modelId: 'mock-model-fixture-v1', scripts });

/** One structurally valid evidence item (the model's input shape). */
const evidenceItemOf = (ref: string) =>
  unwrap(
    parseEvidenceItem({
      kind: 'entity',
      ref,
      entity: null,
      scope: projectScopeOf(PROJECT_1),
      confidence: 'high',
      retrieval: {
        tool: 'relationship-traversal',
        query: { kind: 'memory-lessons' },
        retrievedAt: T0,
      },
    }),
  );

describe('the fixture-scripted mock model (deterministic by construction)', () => {
  it('replays byte-identical drafts for identical inputs (the run-twice foundation)', async () => {
    const model = modelOf(canonicalScripts());
    const input = {
      goal: GOAL_COMMIT_BUDGET,
      evidence: [evidenceItemOf('change-event:e-1'), evidenceItemOf('revision:e-2')],
    };
    const first = expectOk(await model.propose(input));
    const second = expectOk(await model.propose(input));
    expect(JSON.stringify(second)).toStrictEqual(JSON.stringify(first));
    expect(first).toHaveLength(1);
    expect(first[0]?.command.commandName).toBe('cost.commitBudgetRevision');
  });

  it('introspects its own invocations (goals + evidence counts, in order)', async () => {
    const model = modelOf(canonicalScripts());
    await model.propose({ goal: GOAL_COMMIT_BUDGET, evidence: [] });
    await model.propose({
      goal: GOAL_RECORD_PROGRESS,
      evidence: [evidenceItemOf('a'), evidenceItemOf('b'), evidenceItemOf('c')],
    });
    expect(model.invocations.count).toBe(2);
    expect(model.invocations.goals).toStrictEqual([GOAL_COMMIT_BUDGET, GOAL_RECORD_PROGRESS]);
    expect(model.invocations.evidenceCounts).toStrictEqual([0, 3]);
  });

  it('answers an unscripted goal with a TYPED fail-closed rejection (the mock invents nothing)', async () => {
    const model = modelOf(canonicalScripts());
    const result = await model.propose({ goal: 'an unscripted objective', evidence: [] });
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('scripted-model-no-entry');
    expect(error.message).toContain('fail-closed');
  });

  it('rejects duplicate script goals loudly at construction time', () => {
    const scripts: readonly ModelScriptEntry[] = [
      { goal: GOAL_RECORD_PROGRESS, drafts: [progressDraft()] },
      { goal: GOAL_RECORD_PROGRESS, drafts: [progressDraft()] },
    ];
    expect(() => modelOf(scripts)).toThrow(TypeError);
    expect(() => modelOf(scripts)).toThrow(/duplicate scripted-model entry/);
  });

  it('carries its model source identity (freeze A4 — recorded on every run)', () => {
    expect(modelOf(canonicalScripts()).modelId).toBe('mock-model-fixture-v1');
  });
});
