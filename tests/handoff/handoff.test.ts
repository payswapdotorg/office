import { describe, expect, it } from 'vitest';
import {
  EXPECTED_ITEM_IDS,
  QUESTION_ANCHORS,
  checkCompletionReplay,
  checkDependencyGraph,
  checkIndependenceTest,
  checkOwnership,
  checkReadyQueue,
  checkSetupInstructions,
  loadRealArtifacts,
  parseDagSummary,
  parseExecutionArtifacts,
  parseIndependenceQuestions,
  parseWaves,
  producedFootprints,
  readyQueue,
  realFs,
  replayCompletion,
  renderViolations,
  sectionText,
} from './artifacts';

// OFF-040 — the real-artifact verification suite: every test feeds the pure
// checkers of artifacts.ts with the ACTUAL repository artifacts (loaded once,
// fail-closed). Every assertion is state-agnostic by design: the suite stays
// green both while the final item is in flight (39/40 recorded) and at the
// terminal state the Tech Lead records after the merge (40/40 recorded) — the
// ready-queue family asserts the EQUIVALENCE (queue empty ⟺ backlog complete),
// never one side of it. `pnpm test` sweeps this file through the root vitest
// glob `tests/**/*.test.ts`; the focused run is
// `pnpm exec vitest run tests/handoff`.

const world = loadRealArtifacts();
const parsed = parseExecutionArtifacts(world);
const items = parsed.items;
const entries = parsed.entries;
const byId = new Map(items.map((item) => [item.id, item]));

const outputsPresent = (): boolean => realFs.exists('package.json');

describe('the verified dependency graph (OFF-040 family 1)', () => {
  it('parses the 40-item backlog exactly once each, acyclic, with the DAG summary consistent', () => {
    const violations = checkDependencyGraph(world);
    expect(renderViolations(violations), renderViolations(violations)).toBe('');
  });

  it('holds every one of the 40 items exactly once with existing dependency references', () => {
    expect(items.map((item) => item.id).sort()).toEqual([...EXPECTED_ITEM_IDS].sort());
    for (const item of items) {
      for (const dependency of item.dependsOn) {
        expect(byId.has(dependency), `${item.id} dependency ${dependency}`).toBe(true);
      }
    }
  });

  it('proves the DAG summary never contradicts the edge authority (WORK_ITEMS.md)', () => {
    const workEdges = new Set<string>();
    for (const item of items) {
      for (const dependency of item.dependsOn) workEdges.add(`${dependency}->${item.id}`);
    }
    const summary = parseDagSummary(world.dependencyGraph);
    expect(summary.problems).toEqual([]);
    expect(summary.nodes).toEqual([...EXPECTED_ITEM_IDS].sort());
    expect(workEdges.size).toBe(145);
    expect(summary.edges.length).toBe(111);
    for (const edge of summary.edges) {
      expect(workEdges.has(`${edge.from}->${edge.to}`), `summary edge ${edge.from}->${edge.to}`).toBe(true);
    }
  });
});

describe('the computable ready queue (OFF-040 family 2)', () => {
  it('computes the queue from artifacts alone and agrees with the recorded tracker', () => {
    const violations = checkReadyQueue(world, realFs);
    expect(renderViolations(violations), renderViolations(violations)).toBe('');
  });

  it('holds the terminal equivalence: the queue is empty exactly when the backlog is complete', () => {
    const done = new Set(entries.map((entry) => entry.id));
    const computed = readyQueue(items, done, outputsPresent);
    expect(computed.length === 0).toBe(entries.length === items.length);
  });

  it('proves the terminal truth: with all 40 items DONE the ready queue is EMPTY', () => {
    const allDone = new Set(items.map((item) => item.id));
    expect(readyQueue(items, allDone, () => true)).toEqual([]);
    expect(readyQueue(items, allDone, outputsPresent)).toEqual([]);
  });

  it('keeps every DONE item dependency-closed (recorded reality agrees with the graph)', () => {
    const done = new Set(entries.map((entry) => entry.id));
    for (const entry of entries) {
      const item = byId.get(entry.id);
      if (item === undefined) continue;
      for (const dependency of item.dependsOn) {
        expect(done.has(dependency), `${entry.id} depends on ${dependency}`).toBe(true);
      }
    }
  });
});

describe('the completion replay (OFF-040 family 3)', () => {
  it('replays zero dependency-order violations across every recorded merge and never stalls', () => {
    const violations = checkCompletionReplay(world, realFs);
    expect(renderViolations(violations), renderViolations(violations)).toBe('');
  });

  it('records a ready frontier that offered at least three simultaneous choices', () => {
    const replay = replayCompletion(items, entries, outputsPresent);
    const max = Math.max(...replay.frontierHistory);
    expect(max, `frontier history: ${replay.frontierHistory.join(',')}`).toBeGreaterThanOrEqual(3);
  });

  it('proves every documented three-worker wave was simultaneously ready in the replay', () => {
    const graphWaves = parseWaves(sectionText(world.dependencyGraph, '## Parallelization rules'));
    const handoffWaves = parseWaves(sectionText(world.techLeadHandoff, '## Three-worker scheduling rule'));
    expect(graphWaves.map((wave) => wave.join('+')).sort()).toEqual(
      handoffWaves.map((wave) => wave.join('+')).sort(),
    );
    expect(graphWaves.length).toBeGreaterThanOrEqual(3);
    const replay = replayCompletion(items, entries, outputsPresent);
    for (const wave of graphWaves) {
      const simultaneous = replay.frontierHistory.some((_, prefixIndex) => {
        const done = new Set(replay.order.slice(0, prefixIndex + 1));
        return wave.every(
          (id) =>
            !done.has(id) &&
            (byId.get(id)?.dependsOn.every((dependency) => done.has(dependency)) ?? false),
        );
      });
      expect(simultaneous, `wave [${wave.join(' + ')}] simultaneously ready`).toBe(true);
    }
  });

  it('carries merge evidence (a PR number or a commit sha) for every completion entry', () => {
    for (const entry of entries) {
      expect(entry.pr !== undefined || entry.mergeSha !== undefined, `${entry.id} merge evidence`).toBe(true);
    }
  });
});

describe('unambiguous ownership (OFF-040 family 4)', () => {
  it('proves one owner boundary per item, distinct footprints, and every manifest claimed', () => {
    const violations = checkOwnership(world, realFs);
    expect(renderViolations(violations), renderViolations(violations)).toBe('');
  });

  it('claims every workspace manifest exactly once besides the documented shared exception', () => {
    const manifests = realFs.manifests();
    expect(manifests.length).toBe(40);
    expect(new Set(manifests.map((manifest) => manifest.name)).size).toBe(40);
    const manifestNames = new Map(manifests.map((manifest) => [manifest.name, manifest.path]));
    const claimed = new Map<string, string>();
    for (const entry of entries) {
      for (const footprint of producedFootprints(entry.producedLine, manifestNames).footprints) {
        expect(claimed.has(footprint), `${footprint} claimed twice`).toBe(false);
        claimed.set(footprint, entry.id);
      }
    }
    const unclaimed = manifests
      .map((manifest) => manifest.path)
      .filter((path) => !claimed.has(path) && path !== 'packages/test-fixtures');
    expect(unclaimed).toEqual([]);
  });

  it('keeps all 40 owner boundaries pairwise distinct', () => {
    const boundaries = items.map((item) => item.ownerBoundary);
    expect(new Set(boundaries).size).toBe(40);
  });
});

describe('reproducible setup instructions (OFF-040 family 5)', () => {
  it('documents the bootstrap and wires the same four gates in README, package.json, and CI', () => {
    const violations = checkSetupInstructions(world);
    expect(renderViolations(violations), renderViolations(violations)).toBe('');
  });

  it('names the identical gate commands in the successor map, the scripts, and the CI steps', () => {
    const gates = ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm test:architecture'];
    const scripts = JSON.parse(world.packageJson) as { scripts: Record<string, string> };
    const ciRuns = world.ciYaml.split('\n').map((line) => line.trim());
    for (const gate of gates) {
      expect(world.handoffReadme.includes(gate), `README ${gate}`).toBe(true);
      expect(typeof scripts.scripts[gate.replace('pnpm ', '')], `script ${gate}`).toBe('string');
      expect(ciRuns.includes(`run: ${gate}`), `CI ${gate}`).toBe(true);
    }
  });
});

describe('the independence-test answers (OFF-040 family 6)', () => {
  it('answers every independence question from repository artifacts alone', () => {
    const violations = checkIndependenceTest(world, realFs);
    expect(renderViolations(violations), renderViolations(violations)).toBe('');
  });

  it('parses exactly the eleven frozen questions from the handoff document', () => {
    const questions = parseIndependenceQuestions(world.techLeadHandoff);
    expect([...questions].sort()).toEqual(Object.keys(QUESTION_ANCHORS).sort());
    expect(questions.length).toBe(11);
  });
});

describe('the suite discipline (OFF-040)', () => {
  it('loads every consumed artifact non-vacuously (fail-closed on any missing file)', () => {
    for (const [name, text] of Object.entries(world)) {
      expect(text.length, `${name} loaded`).toBeGreaterThan(0);
    }
  });

  it('reverses the newest-first document order into the completion order (OFF-001 first)', () => {
    const order = [...entries].reverse().map((entry) => entry.id);
    expect(order[0]).toBe('OFF-001');
    expect(new Set(order).size).toBe(order.length);
  });
});
