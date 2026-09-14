// Office handoff verification — the mutation probes (OFF-040).
//
// Every rule in tests/handoff/artifacts.ts fails closed. This file PROVES it
// per the OFF-039 conformance-gate precedent: "a rule that cannot be shown
// to fail is not a gate". Each verification family gets at least one
// synthetic violating world — an IN-MEMORY mutation of the real artifact
// text (or a stubbed filesystem oracle); no file is ever written — whose
// violations must name the family, the artifact file, and the exact
// expectation. Each family also carries a healthy control: the unmutated
// real world stays silent. The pure algorithm helpers get direct table
// probes (blocked/ready transitions, dependency-order violations, stalls
// through the injected outputs-present leg, cycle peeling).
import { describe, expect, it } from 'vitest';
import {
  checkCompletionReplay,
  checkDependencyGraph,
  checkIndependenceTest,
  checkOwnership,
  checkReadyQueue,
  checkSetupInstructions,
  cycleNodes,
  loadRealArtifacts,
  parseExecutionArtifacts,
  realFs,
  readyQueue,
  replayCompletion,
  renderViolations,
} from './artifacts';
import type {
  CompletionEntry,
  FsOracle,
  HandoffViolation,
  WorkItem,
} from './artifacts';

const world = loadRealArtifacts();
const parsed = parseExecutionArtifacts(world);

/** Rendered violation text (the fail-closed report a successor sees). */
const rendered = (violations: readonly HandoffViolation[]): string =>
  renderViolations(violations);

/** Whether any violation's expectation carries the needle. */
const namesViolation = (
  violations: readonly HandoffViolation[],
  needle: string,
): boolean => violations.some((violation) => violation.expectation.includes(needle));

/** A minimal well-formed work item for the pure algorithm probes. */
const mkItem = (id: string, dependsOn: readonly string[]): WorkItem => ({
  id,
  title: `probe item ${id}`,
  ownerBoundary: `probe boundary ${id}`,
  dependsOn,
  dependencyProse: '',
  produces: 'the probe surface',
  acceptance: 'the probe acceptance',
});

/** A minimal well-formed completion entry for the replay probes. */
const mkEntry = (id: string): CompletionEntry => ({
  id,
  title: `probe entry ${id}`,
  date: '2026-01-01',
  mergeLine: 'probe merge line',
  pr: 1,
  mergeSha: 'probe0000000000000000000000000000000000000000',
  producedLine: 'probe produced line',
});

describe('mutation probes — family 1: the verified dependency graph', () => {
  it('HEALTHY: the checker stays silent on the unmutated real artifacts', () => {
    expect(rendered(checkDependencyGraph(world))).toBe('');
  });

  it('MUTATION: a duplicated backlog item fails closed as "appears more than once"', () => {
    const start = world.workItems.indexOf('### OFF-002 ');
    const end = world.workItems.indexOf('### OFF-003 ');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = world.workItems.slice(start, end);
    const duplicated = world.workItems.slice(0, end) + block + world.workItems.slice(end);
    const violations = checkDependencyGraph({ ...world, workItems: duplicated });
    expect(namesViolation(violations, 'work item OFF-002 appears more than once')).toBe(true);
    expect(namesViolation(violations, 'expected exactly 40 work items, parsed 41')).toBe(true);
  });

  it('MUTATION: a dependency on a nonexistent item fails closed naming both ids', () => {
    const mutated = world.workItems.replace('Depends on: OFF-001', 'Depends on: OFF-999');
    const violations = checkDependencyGraph({ ...world, workItems: mutated });
    expect(
      namesViolation(violations, 'work item OFF-002 depends on OFF-999, which does not exist'),
    ).toBe(true);
    expect(
      namesViolation(
        violations,
        'DAG summary edge OFF-001 -> OFF-002 is not a declared dependency',
      ),
    ).toBe(true);
  });

  it('MUTATION: cycleNodes fails closed on a cyclic graph and peels the healthy chain', () => {
    expect(
      cycleNodes(['OFF-A', 'OFF-B'], [
        { from: 'OFF-A', to: 'OFF-B' },
        { from: 'OFF-B', to: 'OFF-A' },
      ]),
    ).toEqual(['OFF-A', 'OFF-B']);
    expect(
      cycleNodes(['OFF-A', 'OFF-B', 'OFF-C'], [
        { from: 'OFF-A', to: 'OFF-B' },
        { from: 'OFF-B', to: 'OFF-C' },
      ]),
    ).toEqual([]);
  });
});

describe('mutation probes — family 2: the computable ready queue', () => {
  it('HEALTHY: the checker stays silent on the unmutated real artifacts', () => {
    expect(rendered(checkReadyQueue(world, realFs))).toBe('');
  });

  it('TABLE: the ready-state algorithm blocks on dependencies and on missing outputs', () => {
    const a = mkItem('OFF-A', []);
    const b = mkItem('OFF-B', ['OFF-A']);
    expect(readyQueue([a, b], new Set<string>(), () => true)).toEqual(['OFF-A']);
    expect(readyQueue([a, b], new Set(['OFF-A']), () => true)).toEqual(['OFF-B']);
    expect(readyQueue([a, b], new Set(['OFF-A', 'OFF-B']), () => true)).toEqual([]);
    expect(readyQueue([a, b], new Set<string>(), () => false)).toEqual([]);
  });

  it('MUTATION: a Status line that disagrees with the recorded entries fails closed', () => {
    // State-robust: whatever the tracker's current "N/NN items done" grammar
    // says, decrementing N must disagree with the recorded completion entries.
    const recorded = world.implementationStatus.match(/(\d+)\/(\d+) items done/);
    expect(recorded).not.toBeNull();
    const doneCount = recorded?.[1] ?? '0';
    const totalCount = recorded?.[2] ?? '0';
    const mutated = world.implementationStatus.replace(
      `${doneCount}/${totalCount} items done`,
      `${Number.parseInt(doneCount, 10) - 1}/${totalCount} items done`,
    );
    const violations = checkReadyQueue({ ...world, implementationStatus: mutated }, realFs);
    expect(
      namesViolation(
        violations,
        `the Status line says ${Number.parseInt(doneCount, 10) - 1} items done but ${Number.parseInt(doneCount, 10)} completion entries`,
      ),
    ).toBe(true);
  });

  it('MUTATION: a recorded ready queue that disagrees with the computed one fails closed', () => {
    // State-robust: injecting a ghost item into the recorded queue section
    // must disagree with the computed queue in every tracker state.
    const mutated = world.implementationStatus.replace(
      '## Current ready queue',
      '## Current ready queue\n\n- `OFF-099` Ghost item',
    );
    const violations = checkReadyQueue({ ...world, implementationStatus: mutated }, realFs);
    expect(
      namesViolation(violations, 'the recorded ready queue [OFF-099] disagrees with the computed ready queue'),
    ).toBe(true);
  });

  it('MUTATION: a DONE item whose dependency is not DONE is a recorded-reality disagreement', () => {
    // State-robust: re-pointing the first item's dependency at a nonexistent
    // id leaves a DONE item depending on something not DONE in every state.
    const mutated = world.workItems.replace('Depends on: OFF-001', 'Depends on: OFF-099');
    const violations = checkReadyQueue({ ...world, workItems: mutated }, realFs);
    expect(
      namesViolation(
        violations,
        'recorded-reality disagreement: DONE item OFF-002 depends on OFF-099, which is not DONE',
      ),
    ).toBe(true);
  });
});

describe('mutation probes — family 3: the completion replay', () => {
  it('HEALTHY: the checker stays silent on the unmutated real artifacts', () => {
    expect(rendered(checkCompletionReplay(world, realFs))).toBe('');
  });

  it('TABLE: a valid order replays clean with a monotone frontier', () => {
    // Entries are passed in the tracker's newest-first document order; the
    // replay reverses them into the completion order OFF-A -> OFF-B -> OFF-C.
    const a = mkItem('OFF-A', []);
    const b = mkItem('OFF-B', ['OFF-A']);
    const c = mkItem('OFF-C', ['OFF-B']);
    const replay = replayCompletion(
      [a, b, c],
      [mkEntry('OFF-C'), mkEntry('OFF-B'), mkEntry('OFF-A')],
      () => true,
    );
    expect(replay.violations).toEqual([]);
    expect(replay.order).toEqual(['OFF-A', 'OFF-B', 'OFF-C']);
    expect([...replay.frontierHistory]).toEqual([1, 1]);
  });

  it('MUTATION: completing an item before its dependency is a named order violation', () => {
    const a = mkItem('OFF-A', []);
    const b = mkItem('OFF-B', ['OFF-A']);
    const c = mkItem('OFF-C', ['OFF-B']);
    // Newest-first document order [OFF-C, OFF-A, OFF-B] reverses into the
    // completion order OFF-B (position 1) -> OFF-A (position 2) -> OFF-C.
    const replay = replayCompletion(
      [a, b, c],
      [mkEntry('OFF-C'), mkEntry('OFF-A'), mkEntry('OFF-B')],
      () => true,
    );
    expect(
      namesViolation(
        replay.violations,
        'dependency-order violation: OFF-B completed at position 1 before its dependency OFF-A (position 2)',
      ),
    ).toBe(true);
  });

  it('MUTATION: a missing declared output stalls the replay and fails closed', () => {
    const a = mkItem('OFF-A', []);
    const b = mkItem('OFF-B', ['OFF-A']);
    const c = mkItem('OFF-C', ['OFF-B']);
    const replay = replayCompletion(
      [a, b, c],
      [mkEntry('OFF-C'), mkEntry('OFF-B'), mkEntry('OFF-A')],
      (id) => id !== 'OFF-C',
    );
    expect(
      namesViolation(
        replay.violations,
        'execution stalled: after 2 completions no remaining work item was ready while 1 were still not DONE',
      ),
    ).toBe(true);
  });
});

describe('mutation probes — family 4: unambiguous ownership', () => {
  it('HEALTHY: the checker stays silent on the unmutated real artifacts', () => {
    expect(rendered(checkOwnership(world, realFs))).toBe('');
  });

  it('MUTATION: two items claiming one owner boundary fail closed naming both', () => {
    const boundaryOf = (id: string): string => {
      const item = parsed.items.find((candidate) => candidate.id === id);
      if (item === undefined) throw new Error(`probe fixture is missing ${id}`);
      return item.ownerBoundary;
    };
    const mutated = world.workItems.replace(
      `Owner boundary: ${boundaryOf('OFF-003')}`,
      `Owner boundary: ${boundaryOf('OFF-002')}`,
    );
    const violations = checkOwnership({ ...world, workItems: mutated }, realFs);
    expect(
      namesViolation(violations, 'ambiguous ownership: OFF-002 and OFF-003 both claim'),
    ).toBe(true);
  });

  it('MUTATION: an unclaimed workspace manifest fails closed naming the path', () => {
    const ghostFs: FsOracle = {
      exists: realFs.exists,
      read: realFs.read,
      manifests: () => [
        ...realFs.manifests(),
        { path: 'packages/ghost', name: '@office/ghost' },
      ],
    };
    const violations = checkOwnership(world, ghostFs);
    expect(
      namesViolation(
        violations,
        'workspace manifest packages/ghost (@office/ghost) is claimed by no work item',
      ),
    ).toBe(true);
  });

  it('MUTATION: stripping the post-freeze Produced claim fails closed naming the deployment manifests unclaimed', () => {
    const mutated = world.implementationStatus.replace(
      /^- Produced: `apps\/host` \(the browser host over @office\/web.*$/m,
      '- Produced: (probe: claim stripped)',
    );
    const violations = checkOwnership({ ...world, implementationStatus: mutated }, realFs);
    expect(
      namesViolation(violations, 'is claimed by no work item\u0027s Produced line'),
    ).toBe(true);
    expect(namesViolation(violations, 'apps/host (@office/host)')).toBe(true);
    expect(namesViolation(violations, 'packages/host-gateway (@office/host-gateway)')).toBe(true);
    expect(
      namesViolation(
        violations,
        'post-freeze entry OFF-DEPLOY has a Produced line naming no primary package/app path',
      ),
    ).toBe(true);
  });

  it('MUTATION: a post-freeze claim colliding with a frozen footprint fails closed naming both', () => {
    const mutated = world.implementationStatus.replace(
      /^- Produced: `apps\/host` \(the browser host over @office\/web.*$/m,
      '- Produced: `packages/contracts` (probe: colliding claim)',
    );
    const violations = checkOwnership({ ...world, implementationStatus: mutated }, realFs);
    expect(
      namesViolation(
        violations,
        'ambiguous ownership: OFF-002 and the post-freeze entry OFF-DEPLOY both claim the primary footprint packages/contracts',
      ),
    ).toBe(true);
  });

  it('MUTATION: a malformed post-freeze heading fails closed naming the grammar', () => {
    const mutated = world.implementationStatus.replace(
      /^### OFF-DEPLOY Production deployment orchestration — DONE \(2026-09-14\)$/m,
      '### OFF-DEPLOY Production deployment orchestration (in flight)',
    );
    const violations = checkOwnership({ ...world, implementationStatus: mutated }, realFs);
    expect(
      namesViolation(
        violations,
        'post-freeze heading not in the "### OFF-DEPLOY <title> — DONE (YYYY-MM-DD)" grammar',
      ),
    ).toBe(true);
    // The malformed record cannot claim its manifests: both must surface as
    // unclaimed (fail-closed — a broken record never silently no-ops).
    expect(namesViolation(violations, 'apps/host (@office/host)')).toBe(true);
    expect(namesViolation(violations, 'packages/host-gateway (@office/host-gateway)')).toBe(true);
  });
});

describe('mutation probes — family 5: reproducible setup instructions', () => {
  it('HEALTHY: the checker stays silent on the unmutated real artifacts', () => {
    expect(rendered(checkSetupInstructions(world))).toBe('');
  });

  it('MUTATION: a missing root gate script fails closed naming the script', () => {
    const pkg = JSON.parse(world.packageJson) as Record<string, unknown>;
    const scripts = { ...(pkg['scripts'] as Record<string, unknown>) };
    delete scripts['lint'];
    const mutated = JSON.stringify({ ...pkg, scripts }, null, 2);
    const violations = checkSetupInstructions({ ...world, packageJson: mutated });
    expect(namesViolation(violations, 'the root "lint" script is missing')).toBe(true);
  });

  it('MUTATION: the successor map dropping a gate command fails closed', () => {
    const mutated = world.handoffReadme.replaceAll('pnpm lint', 'pnpm check');
    const violations = checkSetupInstructions({ ...world, handoffReadme: mutated });
    expect(
      namesViolation(violations, 'the setup bootstrap is missing the "pnpm lint" command'),
    ).toBe(true);
  });

  it('MUTATION: renaming the required conformance gate step fails closed', () => {
    const mutated = world.ciYaml.replace(
      'name: Architecture conformance gate (OFF-039)',
      'name: Architecture tests (legacy)',
    );
    const violations = checkSetupInstructions({ ...world, ciYaml: mutated });
    expect(
      namesViolation(
        violations,
        'the required step "Architecture conformance gate (OFF-039)" is missing or renamed',
      ),
    ).toBe(true);
  });

  it('MUTATION: an advisory (continue-on-error) gate step fails closed', () => {
    const mutated = world.ciYaml.replace(
      'run: pnpm test:architecture',
      'run: pnpm test:architecture\n        continue-on-error: true',
    );
    const violations = checkSetupInstructions({ ...world, ciYaml: mutated });
    expect(
      namesViolation(violations, 'no CI step may set continue-on-error'),
    ).toBe(true);
  });
});

describe('mutation probes — family 6: the independence-test answers', () => {
  it('HEALTHY: the checker stays silent on the unmutated real artifacts', () => {
    expect(rendered(checkIndependenceTest(world, realFs))).toBe('');
  });

  it('MUTATION: reverting the terminal Status line fails closed', () => {
    const mutated = world.techLeadHandoff.replace(
      /^Status: .+$/m,
      'Status: AUDITED FOR TAKEOVER — architecture and execution controls verified; production implementation is intentionally not started.',
    );
    const violations = checkIndependenceTest({ ...world, techLeadHandoff: mutated }, realFs);
    expect(
      namesViolation(
        violations,
        'the top Status line has not been brought to the terminal truth',
      ),
    ).toBe(true);
  });

  it('MUTATION: deleting a frozen independence question fails closed naming it', () => {
    const mutated = world.techLeadHandoff.replace('\n- the product mission;', '\n');
    const violations = checkIndependenceTest({ ...world, techLeadHandoff: mutated }, realFs);
    expect(
      namesViolation(
        violations,
        'the frozen independence-test question list no longer carries "the product mission"',
      ),
    ).toBe(true);
  });

  it('MUTATION: an extra question with no artifact-anchor mapping fails closed', () => {
    const mutated = world.techLeadHandoff.replace(
      '\n- the product mission;',
      '\n- the product mission;\n- the hidden conversation context;',
    );
    const violations = checkIndependenceTest({ ...world, techLeadHandoff: mutated }, realFs);
    expect(
      namesViolation(
        violations,
        'independence-test question "the hidden conversation context" has no artifact-anchor mapping',
      ),
    ).toBe(true);
  });

  it('MUTATION: a missing anchor file fails closed naming the question', () => {
    const anchorlessFs: Pick<FsOracle, 'exists' | 'read'> = {
      exists: (path) => path !== 'docs/execution/DEPENDENCY_GRAPH.md' && realFs.exists(path),
      read: realFs.read,
    };
    const violations = checkIndependenceTest(world, anchorlessFs);
    expect(violations.some((violation) => violation.expectation.includes('the anchor answering') && violation.expectation.includes('is missing'))).toBe(true);
    expect(violations.some((violation) => violation.file === 'docs/execution/DEPENDENCY_GRAPH.md')).toBe(true);
  });
});

describe('fail-closed loader probes', () => {
  it('reading a missing artifact file throws naming the exact path', () => {
    expect(() => realFs.read('docs/execution/NOPE.md')).toThrowError(
      /missing artifact file: docs\/execution\/NOPE\.md/,
    );
  });

  it('HEALTHY: the manifest census is non-empty, sorted, and confined to the workspace globs', () => {
    const manifests = realFs.manifests();
    expect(manifests.length).toBeGreaterThan(10);
    expect([...manifests]).toEqual(
      [...manifests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    );
    for (const manifest of manifests) {
      expect(
        manifest.path.startsWith('packages/') || manifest.path.startsWith('apps/'),
        manifest.path,
      ).toBe(true);
    }
  });
});
