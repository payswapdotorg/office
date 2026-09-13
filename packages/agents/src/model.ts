// Office agent runtime — the model port + the deterministic mock (OFF-018).
//
// THE ModelPort is the single seam where a real model would sit: goal +
// gathered evidence → typed action proposals. The runtime NEVER calls a real
// model — the port is INJECTED, and the only implementation this package
// ships is the deterministic fixture-scripted mock below: the same input
// always produces the byte-identical proposal drafts (no clock, no
// randomness, no network — the run-twice determinism proof rests on it).
//
// The mock's script is DATA, not behavior: a table of (goal → drafts). An
// input goal with no script entry is a typed fail-closed rejection (a loud
// wiring failure), never a silent default — the scripted model invents
// nothing. Every draft carries the A4 essentials: the typed command envelope,
// the evidence references it grounds on, the confidence, and the rationale.
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { CommandEnvelope, EntityRef, Scope } from '@office/contracts';
import type { EvidenceItem } from './evidence';

/** The input of one model proposal: the goal + the gathered evidence. */
export interface ProposingInput {
  /** The objective the agent run pursues (the run's goal, verbatim). */
  readonly goal: string;
  /** The evidence the run grounded on (the qualified bundle, verbatim). */
  readonly evidence: readonly EvidenceItem[];
}

/**
 * One proposal draft a model emits: the typed command envelope plus the A4
 * provenance a validated ProposedAction needs. Drafts are validated into
 * ProposedAction values fail-closed (proposals.ts) — an invalid draft is a
 * typed rejection, never a silently-coerced proposal.
 */
export interface ModelProposalDraft {
  /** The typed command being proposed (actor, scope, idempotency key, causality). */
  readonly command: CommandEnvelope;
  /** The entity the action is about, or null. */
  readonly subject?: EntityRef | null;
  /** The A4 evidence references the draft grounds on ({ slot, ref }). */
  readonly evidence?: readonly { readonly slot: string; readonly ref: string }[];
  /** The draft's A4 confidence level ('low' | 'medium' | 'high' | 'certain'). */
  readonly confidence: string;
  /** The draft's reasoning summary (1..2000 characters). */
  readonly rationale: string;
  /** The target resource's owning scope when known, or null. */
  readonly resourceScope?: Scope | null;
}

/**
 * THE model port (the injected seam): propose typed actions for a goal
 * grounded on evidence. Deterministic by contract — identical inputs produce
 * identical proposals (the runtime's determinism proofs rest on it).
 */
export interface ModelPort {
  /** The model's source identity (freeze A4 — recorded on every run). */
  readonly modelId: string;
  /** Propose action drafts for the goal grounded on the evidence. */
  propose(input: ProposingInput): Promise<Result<readonly ModelProposalDraft[], DomainError>>;
}

// ----- the deterministic fixture-scripted mock -------------------------------------------------

/** One script entry: the exact goal it answers and the drafts it returns. */
export interface ModelScriptEntry {
  /** The goal this entry answers (exact string match, no invention). */
  readonly goal: string;
  /** The drafts returned for that goal, in order. */
  readonly drafts: readonly ModelProposalDraft[];
}

/** The test-facing surface of the scripted model (invocation introspection). */
export interface ScriptedModel extends ModelPort {
  /** How many propose() calls reached this model, with their inputs. */
  readonly invocations: {
    readonly count: number;
    readonly goals: readonly string[];
    readonly evidenceCounts: readonly number[];
  };
}

/**
 * Create the deterministic fixture-scripted mock model: the goal is looked up
 * in the script table (exact match); a miss is a typed fail-closed rejection
 * ('scripted-model-no-entry') — the mock invents nothing. Duplicate script
 * goals are a loud construction-time TypeError. Identical inputs always
 * produce the byte-identical drafts.
 */
export function createScriptedModel(options: {
  readonly modelId: string;
  readonly scripts: readonly ModelScriptEntry[];
}): ScriptedModel {
  const byGoal = new Map<string, readonly ModelProposalDraft[]>();
  for (const entry of options.scripts) {
    if (byGoal.has(entry.goal)) {
      throw new TypeError(`duplicate scripted-model entry for goal '${entry.goal}'`);
    }
    byGoal.set(entry.goal, entry.drafts);
  }
  const goals: string[] = [];
  const evidenceCounts: number[] = [];
  return {
    modelId: options.modelId,
    invocations: {
      get count(): number {
        return goals.length;
      },
      get goals(): readonly string[] {
        return [...goals];
      },
      get evidenceCounts(): readonly number[] {
        return [...evidenceCounts];
      },
    },
    propose: async (input) => {
      goals.push(input.goal);
      evidenceCounts.push(input.evidence.length);
      const drafts = byGoal.get(input.goal);
      if (drafts === undefined) {
        return fail(
          domainError(
            'invariant-violation',
            `the scripted model '${options.modelId}' has no script entry for the requested goal (fail-closed: the mock invents nothing)`,
            [
              {
                code: 'scripted-model-no-entry',
                message: `no scripted drafts for goal of length ${input.goal.length}`,
                path: 'goal',
              },
            ],
          ),
        );
      }
      return ok(drafts);
    },
  };
}
