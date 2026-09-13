// Office successor handoff verification — THE machine-verified successor
// independence test (OFF-040).
//
// This module holds the fail-closed parsers and the six verification-family
// checkers that prove, from repository artifacts ALONE (zero conversation
// context), that:
//
//   1. the dependency graph is verified   — WORK_ITEMS.md `Depends on` fields
//      and DEPENDENCY_GRAPH.md's DAG summary encode a consistent, acyclic,
//      complete 40-item graph;
//   2. the ready queue is computable      — the ready-state algorithm of
//      WORK_ITEMS.md applied to the DONE set parsed from
//      IMPLEMENTATION_STATUS.md, with its terminal truth (all 40 DONE ⇒ the
//      queue is EMPTY and the backlog is complete);
//   3. the completion replay is live      — reverse document order of the
//      completion entries is the completion order; every item was READY when
//      it completed (zero dependency-order violations), the execution never
//      stalled, and the ready frontier offered ≥ 3 simultaneous choices;
//   4. ownership is unambiguous           — one Owner boundary per item, all
//      boundaries distinct, every completed item's declared outputs present,
//      no primary footprint claimed twice, every workspace manifest claimed;
//   5. setup is reproducible              — the successor map documents the
//      bootstrap and the toolchain pins, and package.json / ci.yml /
//      vitest.config.ts wire exactly the same four gates;
//   6. the independence test is answered  — every question in
//      TECH_LEAD_HANDOFF.md's "Successor independence test" list has an
//      existing, non-vacuous artifact anchor, and the successor-facing
//      status sections carry the terminal truth.
//
// Every checker is a PURE function over a text map plus an injected
// filesystem oracle (exists / read / manifest census), so mutation probes in
// mutation.test.ts feed synthetic in-memory worlds and prove each family
// actually fails closed. The real-repo tests in handoff.test.ts feed the same
// checkers through loadRealArtifacts() + realFs. Deterministic discipline:
// no clock, no randomness, sorted walks; a missing artifact, section, or
// unparseable line is a VIOLATION naming the file and the expectation —
// never a skip.
//
// Authority reading (documented in tests/handoff/README.md): WORK_ITEMS.md's
// exact `Depends on` fields are the edge authority — DEPENDENCY_GRAPH.md
// itself says readiness is calculated "according to the exact dependency
// fields in WORK_ITEMS.md" — and its "DAG summary" is a stage-level
// compression. The suite therefore proves the summary never CONTRADICTS the
// authority (every summary edge is a true dependency edge, same direction),
// covers all 40 items, and round-trips textually through the parser.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** One fail-closed finding of a verification family (a failure, never a skip). */
export interface HandoffViolation {
  /** The verification family's stable name (see tests/handoff/README.md). */
  readonly family: string;
  /** The artifact file the expectation is about (repo-relative POSIX path). */
  readonly file: string;
  /** What was expected and what was found. */
  readonly expectation: string;
}

/** One work item parsed from docs/execution/WORK_ITEMS.md. */
export interface WorkItem {
  /** Full 'OFF-XXX' id. */
  readonly id: string;
  readonly title: string;
  readonly ownerBoundary: string;
  /** 'OFF-XXX' dependency ids (the exact `Depends on` fields). */
  readonly dependsOn: readonly string[];
  /** Non-id prose inside the Depends on field, when grammar allows it. */
  readonly dependencyProse: string;
  readonly produces: string;
  readonly acceptance: string;
}

/** One completion entry parsed from docs/execution/IMPLEMENTATION_STATUS.md. */
export interface CompletionEntry {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly mergeLine: string | undefined;
  readonly pr: number | undefined;
  readonly mergeSha: string | undefined;
  readonly producedLine: string | undefined;
}

/** The repository artifacts every checker consumes (raw text). */
export interface HandoffArtifacts {
  readonly workItems: string;
  readonly dependencyGraph: string;
  readonly implementationStatus: string;
  readonly definitionOfDone: string;
  readonly techLeadHandoff: string;
  readonly rootReadme: string;
  readonly handoffReadme: string;
  readonly packageJson: string;
  readonly ciYaml: string;
  readonly vitestConfig: string;
}

/** The injected filesystem oracle (real tree, or a synthetic probe world). */
export interface FsOracle {
  exists(path: string): boolean;
  /** Fail-closed read: throws naming the missing path. */
  read(path: string): string;
  /** Every workspace package manifest (path + name), sorted by path. */
  manifests(): readonly ManifestEntry[];
}

export interface ManifestEntry {
  readonly path: string;
  readonly name: string;
}

/** One parsed DAG-summary line (segment groups in original token order). */
interface DagSummaryLine {
  readonly raw: string;
  /** Segment token groups, in order. */
  readonly segments: readonly (readonly string[])[];
  /** Per-segment intra-group separator (aligned with `segments` by index). */
  readonly separators: readonly ('+' | ',' | undefined)[];
}

/** The repository root (this suite lives at <root>/tests/handoff). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Shared constants (the terminal 40-item universe — see README extension notes).
// ---------------------------------------------------------------------------

/** OFF-001 through OFF-040: the frozen backlog universe. */
export const EXPECTED_ITEM_IDS: readonly string[] = Array.from(
  { length: 40 },
  (_, index): string => `OFF-${String(index + 1).padStart(3, '0')}`,
);

/**
 * Workspace manifests no work item claims as its primary footprint: shared
 * test infrastructure created inside a landed item's harness work, documented
 * in tests/handoff/README.md. Everything else must be claimed exactly once.
 */
export const UNCLAIMED_MANIFEST_EXCEPTIONS: readonly string[] = [
  'packages/test-fixtures',
];

/** The one documented `Depends on` token carrying governance prose. */
const DEPENDENCY_PROSE_EXCEPTION: readonly string[] = [
  'OFF-039',
  'OFF-038 and all predecessor contracts',
];

/** The four root gate commands (README bootstrap, package.json, ci.yml). */
const GATE_SCRIPTS: readonly string[] = [
  'lint',
  'typecheck',
  'test',
  'test:architecture',
];

/** The vitest include globs that keep new tests from being silently unrun. */
const VITEST_GLOBS: readonly string[] = [
  'tests/**/*.test.ts',
  'packages/*/src/**/*.test.ts',
  'packages/domain/*/src/**/*.test.ts',
  'packages/intelligence/*/src/**/*.test.ts',
  'apps/*/src/**/*.test.ts',
];

// ---------------------------------------------------------------------------
// Small text helpers (all deterministic, all fail-closed by contract).
// ---------------------------------------------------------------------------

const firstMatch = (text: string, pattern: RegExp): string | undefined => {
  const match = text.match(pattern);
  if (match === null || match[1] === undefined) return undefined;
  return match[1];
};

/** The text of a markdown section: after the heading line, until the next
 * heading of the same or higher level (a `##` section owns its `###`
 * subsections — e.g. IMPLEMENTATION_STATUS.md's "## Completed work items"
 * owns every `### OFF-XXX — DONE` entry). Undefined when the heading is
 * absent. */
export const sectionText = (text: string, heading: string): string | undefined => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const level = heading.match(/^#+/)?.[0]?.length ?? 0;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    const headingMatch = line.trim().match(/^(#+)\s/);
    if (
      headingMatch !== null &&
      headingMatch[1] !== undefined &&
      (level === 0 || headingMatch[1].length <= level)
    ) {
      break;
    }
    body.push(line);
  }
  return body.join('\n');
};

/** Every 'OFF-XXX' id mentioned in a text, deduplicated, first-seen order. */
const offIdsIn = (text: string): readonly string[] => {
  const ids: string[] = [];
  for (const match of text.matchAll(/OFF-(\d{3})/g)) {
    const digits = match[1];
    if (digits === undefined) continue;
    const id = `OFF-${digits}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
};

/** Render violations for assertion messages (sorted, one per line). */
export const renderViolations = (violations: readonly HandoffViolation[]): string =>
  violations
    .map((violation) => `${violation.family} | ${violation.file} | ${violation.expectation}`)
    .sort()
    .join('\n');

// ---------------------------------------------------------------------------
// The shared execution-artifact parse (WORK_ITEMS.md + IMPLEMENTATION_STATUS.md).
// ---------------------------------------------------------------------------

/** The four grammar fields every WORK_ITEMS.md item block must carry exactly once. */
const fieldNames = ['Owner boundary', 'Depends on', 'Produces', 'Acceptance'] as const;

export interface ParsedExecution {
  readonly items: readonly WorkItem[];
  readonly entries: readonly CompletionEntry[];
  /** Grammar problems: malformed fields/headings — fail every markdown family. */
  readonly problems: readonly HandoffViolation[];
}

const WORK_ITEMS_FILE = 'docs/execution/WORK_ITEMS.md';
const STATUS_FILE = 'docs/execution/IMPLEMENTATION_STATUS.md';

export function parseExecutionArtifacts(
  world: Pick<HandoffArtifacts, 'workItems' | 'implementationStatus'>,
): ParsedExecution {
  const problems: HandoffViolation[] = [];

  // --- WORK_ITEMS.md ------------------------------------------------------
  const items: WorkItem[] = [];
  let current: {
    id: string;
    title: string;
    fields: Map<string, string[]>;
  } | undefined;
  for (const rawLine of world.workItems.split('\n')) {
    const itemHeading = rawLine.match(/^### (OFF-\d{3}) (.+)$/);
    if (itemHeading !== null) {
      if (current !== undefined) {
        const finalized = finalizeItem(current, problems);
        if (finalized !== undefined) items.push(finalized);
      }
      const id = itemHeading[1];
      const title = itemHeading[2];
      if (id === undefined || title === undefined) {
        problems.push({
          family: 'artifact-parse',
          file: WORK_ITEMS_FILE,
          expectation: `unparseable work-item heading: "${rawLine}"`,
        });
        current = undefined;
        continue;
      }
      current = { id, title, fields: new Map() };
      continue;
    }
    if (rawLine.trim().startsWith('#')) {
      if (current !== undefined) {
        const finalized = finalizeItem(current, problems);
        if (finalized !== undefined) items.push(finalized);
        current = undefined;
      }
      continue;
    }
    if (current === undefined) continue;
    const field = rawLine.match(/^(Owner boundary|Depends on|Produces|Acceptance): (.+)$/);
    if (field === null) continue;
    const name = field[1];
    const value = field[2];
    if (name === undefined || value === undefined) continue;
    const bucket = current.fields.get(name);
    if (bucket === undefined) current.fields.set(name, [value]);
    else bucket.push(value);
  }
  if (current !== undefined) {
    const finalized = finalizeItem(current, problems);
    if (finalized !== undefined) items.push(finalized);
  }

  // --- IMPLEMENTATION_STATUS.md -------------------------------------------
  const entries: CompletionEntry[] = [];
  const statusLines = world.implementationStatus.split('\n');
  let entry: {
    id: string;
    title: string;
    date: string;
    merge: string[];
    produced: string[];
  } | undefined;
  const finishEntry = (): void => {
    if (entry === undefined) return;
    const mergeLine = entry.merge[0];
    const producedLine = entry.produced[0];
    if (entry.merge.length !== 1) {
      problems.push({
        family: 'artifact-parse',
        file: STATUS_FILE,
        expectation: `completion entry ${entry.id} must carry exactly one "- Merge:" line (found ${entry.merge.length}) with merge evidence (PR number or commit sha)`,
      });
    }
    if (entry.produced.length > 1) {
      problems.push({
        family: 'artifact-parse',
        file: STATUS_FILE,
        expectation: `completion entry ${entry.id} carries ${entry.produced.length} "- Produced" lines (exactly one allowed)`,
      });
    }
    if (mergeLine !== undefined) {
      const pr = firstMatch(mergeLine, /PR #(\d+)/);
      const sha = firstMatch(mergeLine, /`([0-9a-f]{7,40})`/);
      if (pr === undefined && sha === undefined) {
        problems.push({
          family: 'artifact-parse',
          file: STATUS_FILE,
          expectation: `completion entry ${entry.id} has a "- Merge:" line without merge evidence (no PR number, no commit sha): "${mergeLine}"`,
        });
      }
      entries.push({
        id: entry.id,
        title: entry.title,
        date: entry.date,
        mergeLine,
        pr: pr === undefined ? undefined : Number.parseInt(pr, 10),
        mergeSha: sha,
        producedLine,
      });
    }
    entry = undefined;
  };
  for (const rawLine of statusLines) {
    const doneHeading = rawLine.match(/^### (OFF-\d{3}) (.+?) — DONE \((\d{4}-\d{2}-\d{2})\)$/);
    if (doneHeading !== null) {
      finishEntry();
      const id = doneHeading[1];
      const title = doneHeading[2];
      const date = doneHeading[3];
      if (id === undefined || title === undefined || date === undefined) {
        problems.push({
          family: 'artifact-parse',
          file: STATUS_FILE,
          expectation: `unparseable completion heading: "${rawLine}"`,
        });
        continue;
      }
      entry = { id, title, date, merge: [], produced: [] };
      continue;
    }
    const anyItemHeading = rawLine.match(/^### (OFF-\d{3})/);
    if (anyItemHeading !== null) {
      finishEntry();
      problems.push({
        family: 'artifact-parse',
        file: STATUS_FILE,
        expectation: `completion heading not in the "### OFF-XXX <title> — DONE (YYYY-MM-DD)" grammar: "${rawLine.trim()}"`,
      });
      continue;
    }
    if (rawLine.trim().startsWith('#')) {
      finishEntry();
      continue;
    }
    if (entry === undefined) continue;
    const merge = rawLine.match(/^- Merge: (.+)$/);
    if (merge !== null && merge[1] !== undefined) entry.merge.push(merge[1]);
    const produced = rawLine.match(/^- Produced\b.*$/);
    if (produced !== null) entry.produced.push(rawLine);
  }
  finishEntry();

  return { items, entries, problems };
}

/** Validate one parsed item block's field multiplicities + dependency grammar. */
function finalizeItem(
  block: { id: string; title: string; fields: Map<string, string[]> },
  problems: HandoffViolation[],
): WorkItem | undefined {
  for (const name of fieldNames) {
    const values = block.fields.get(name);
    if (values === undefined || values.length === 0) {
      problems.push({
        family: 'artifact-parse',
        file: WORK_ITEMS_FILE,
        expectation: `work item ${block.id} is missing its "${name}:" line`,
      });
    } else if (values.length > 1) {
      problems.push({
        family: 'artifact-parse',
        file: WORK_ITEMS_FILE,
        expectation: `work item ${block.id} carries ${values.length} "${name}:" lines (exactly one allowed)`,
      });
    }
  }
  const dependsOnRaw = block.fields.get('Depends on')?.[0] ?? '';
  const dependsOn: string[] = [];
  let prose = '';
  if (dependsOnRaw.trim() === 'none') {
    // The documented empty dependency form.
  } else {
    for (const token of dependsOnRaw.split(',')) {
      const trimmed = token.trim();
      const idMatch = trimmed.match(/^(OFF-\d{3})(.*)$/);
      if (idMatch === null || idMatch[1] === undefined) {
        problems.push({
          family: 'artifact-parse',
          file: WORK_ITEMS_FILE,
          expectation: `work item ${block.id} has an unparseable dependency token "${trimmed}" (expected OFF-XXX)`,
        });
        continue;
      }
      const id = idMatch[1];
      const remainder = (idMatch[2] ?? '').trim();
      const isDocumentedProse =
        block.id === DEPENDENCY_PROSE_EXCEPTION[0] && trimmed === DEPENDENCY_PROSE_EXCEPTION[1];
      if (remainder !== '' && !isDocumentedProse) {
        problems.push({
          family: 'artifact-parse',
          file: WORK_ITEMS_FILE,
          expectation: `work item ${block.id} has unexpected prose in its Depends on token "${trimmed}"`,
        });
      }
      if (isDocumentedProse) prose = remainder;
      dependsOn.push(id);
    }
  }
  return {
    id: block.id,
    title: block.title,
    ownerBoundary: block.fields.get('Owner boundary')?.[0] ?? '',
    dependsOn,
    dependencyProse: prose,
    produces: block.fields.get('Produces')?.[0] ?? '',
    acceptance: block.fields.get('Acceptance')?.[0] ?? '',
  };
}

// ---------------------------------------------------------------------------
// The ready-state algorithm (WORK_ITEMS.md's own definition) + replay helpers.
// ---------------------------------------------------------------------------

/**
 * A work item is READY iff every item named in its `Depends on` field is DONE
 * and its declared outputs are present and verified (the outputs-present leg
 * is injected so probes can fake it). Sorted by item id — deterministic.
 */
export function readyQueue(
  items: readonly WorkItem[],
  done: ReadonlySet<string>,
  outputsPresent: (id: string) => boolean,
): readonly string[] {
  return items
    .filter(
      (item) =>
        !done.has(item.id) &&
        item.dependsOn.every((dependency) => done.has(dependency)) &&
        outputsPresent(item.id),
    )
    .map((item) => item.id)
    .sort();
}

/** Kahn topological peel; returns the leftover nodes when the graph cycles. */
export function cycleNodes(
  nodes: readonly string[],
  edges: readonly { from: string; to: string }[],
): readonly string[] {
  const indegree = new Map<string, number>(nodes.map((node) => [node, 0]));
  const outbound = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    const from = outbound.get(edge.from);
    const toCount = indegree.get(edge.to);
    if (from === undefined || toCount === undefined) continue;
    from.push(edge.to);
    indegree.set(edge.to, toCount + 1);
  }
  const ready = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
  const peeled: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift();
    if (node === undefined) break;
    peeled.push(node);
    for (const next of outbound.get(node) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  return nodes.filter((node) => !peeled.includes(node)).sort();
}

/**
 * Replay the completion order (reverse document order of the completion
 * entries). Returns per-item violations, the stall check, and the frontier
 * history (ready-count after each prefix).
 */
export function replayCompletion(
  items: readonly WorkItem[],
  entries: readonly CompletionEntry[],
  outputsPresent: (id: string) => boolean,
): {
  readonly violations: readonly HandoffViolation[];
  readonly order: readonly string[];
  readonly frontierHistory: readonly number[];
} {
  const violations: HandoffViolation[] = [];
  const order = [...entries].reverse().map((entry) => entry.id);
  const position = new Map(order.map((id, index) => [id, index]));
  const byId = new Map(items.map((item) => [item.id, item]));

  for (let index = 0; index < order.length; index += 1) {
    const id = order[index];
    if (id === undefined) continue;
    const item = byId.get(id);
    if (item === undefined) continue;
    for (const dependency of item.dependsOn) {
      const dependencyPosition = position.get(dependency);
      if (dependencyPosition === undefined || dependencyPosition >= index) {
        violations.push({
          family: 'completion-replay',
          file: STATUS_FILE,
          expectation: `dependency-order violation: ${id} completed at position ${index + 1} before its dependency ${dependency} (${dependencyPosition === undefined ? 'never completed' : `position ${dependencyPosition + 1}`})`,
        });
      }
    }
  }

  const frontierHistory: number[] = [];
  for (let prefix = 1; prefix < items.length; prefix += 1) {
    const done = new Set(order.slice(0, Math.min(prefix, order.length)));
    const ready = readyQueue(items, done, outputsPresent);
    frontierHistory.push(ready.length);
    if (ready.length === 0) {
      violations.push({
        family: 'completion-replay',
        file: STATUS_FILE,
        expectation: `execution stalled: after ${prefix} completions no remaining work item was ready while ${items.length - prefix} were still not DONE`,
      });
    }
  }
  return { violations, order, frontierHistory };
}

// ---------------------------------------------------------------------------
// The DAG-summary parser (DEPENDENCY_GRAPH.md).
// ---------------------------------------------------------------------------

export interface DagSummary {
  readonly lines: readonly DagSummaryLine[];
  readonly edges: readonly { from: string; to: string }[];
  readonly nodes: readonly string[];
  readonly problems: readonly HandoffViolation[];
}

const DEPENDENCY_GRAPH_FILE = 'docs/execution/DEPENDENCY_GRAPH.md';

export function parseDagSummary(text: string): DagSummary {
  const problems: HandoffViolation[] = [];
  const blockMatch = text.match(/## DAG summary\s*```text\n([\s\S]*?)```/);
  if (blockMatch === null || blockMatch[1] === undefined) {
    return {
      lines: [],
      edges: [],
      nodes: [],
      problems: [
        {
          family: 'dependency-graph',
          file: DEPENDENCY_GRAPH_FILE,
          expectation: 'the "## DAG summary" section with its ```text fenced block is missing or malformed',
        },
      ],
    };
  }
  const lines: DagSummaryLine[] = [];
  const edges: { from: string; to: string }[] = [];
  const nodes = new Set<string>();
  for (const raw of blockMatch[1].split('\n')) {
    if (raw.trim() === '') continue;
    const segments = raw.split(' -> ');
    if (segments.length < 2) {
      problems.push({
        family: 'dependency-graph',
        file: DEPENDENCY_GRAPH_FILE,
        expectation: `unparseable DAG summary line (no " -> " chain): "${raw}"`,
      });
      continue;
    }
    const parsedSegments: string[][] = [];
    const separators: ('+' | ',' | undefined)[] = [];
    let ok = true;
    for (const segment of segments) {
      const separator: '+' | ',' | undefined = segment.includes('+')
        ? '+'
        : segment.includes(',')
          ? ','
          : undefined;
      const tokens = separator === undefined ? [segment] : segment.split(separator);
      for (const token of tokens) {
        if (!/^\d{3}$/.test(token)) {
          problems.push({
            family: 'dependency-graph',
            file: DEPENDENCY_GRAPH_FILE,
            expectation: `unparseable DAG summary token "${token}" (expected a three-digit item number) in line "${raw}"`,
          });
          ok = false;
        }
      }
      parsedSegments.push(tokens);
      separators.push(separator);
    }
    if (!ok) continue;
    // Round-trip: the parsed structure must re-render the line byte-exactly.
    const rendered = parsedSegments
      .map((tokens, index) => tokens.join(separators[index] ?? ''))
      .join(' -> ');
    if (rendered !== raw) {
      problems.push({
        family: 'dependency-graph',
        file: DEPENDENCY_GRAPH_FILE,
        expectation: `DAG summary line does not round-trip through the parser: "${raw}" vs "${rendered}"`,
      });
    }
    for (const token of parsedSegments.flat()) nodes.add(`OFF-${token}`);
    for (let index = 0; index + 1 < parsedSegments.length; index += 1) {
      const sources = parsedSegments[index];
      const targets = parsedSegments[index + 1];
      if (sources === undefined || targets === undefined) continue;
      for (const source of sources) {
        for (const target of targets) {
          edges.push({ from: `OFF-${source}`, to: `OFF-${target}` });
        }
      }
    }
    lines.push({ raw, segments: parsedSegments, separators });
  }
  return { lines, edges, nodes: [...nodes].sort(), problems };
}

/** Waves (parallelization groups) parsed from a doc section's `OFF-XXX` + `OFF-XXX` runs. */
export const parseWaves = (section: string | undefined): readonly (readonly string[])[] => {
  if (section === undefined) return [];
  const waves: string[][] = [];
  for (const match of section.matchAll(/`OFF-\d{3}`(?: \+ `OFF-\d{3}`)+/g)) {
    const ids = [...match[0].matchAll(/OFF-\d{3}/g)].map((idMatch) => idMatch[0]);
    if (ids.length >= 2) waves.push(ids);
  }
  return waves;
};

// ---------------------------------------------------------------------------
// Family 1 — the verified dependency graph.
// ---------------------------------------------------------------------------

export function checkDependencyGraph(
  world: Pick<HandoffArtifacts, 'workItems' | 'dependencyGraph' | 'implementationStatus'>,
): readonly HandoffViolation[] {
  const violations: HandoffViolation[] = [];
  const parsed = parseExecutionArtifacts(world);
  violations.push(...parsed.problems);
  const { items } = parsed;

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      violations.push({
        family: 'dependency-graph',
        file: WORK_ITEMS_FILE,
        expectation: `work item ${item.id} appears more than once`,
      });
    }
    seen.add(item.id);
  }
  if (items.length !== EXPECTED_ITEM_IDS.length) {
    violations.push({
      family: 'dependency-graph',
      file: WORK_ITEMS_FILE,
      expectation: `expected exactly ${EXPECTED_ITEM_IDS.length} work items, parsed ${items.length}`,
    });
  }
  for (const expected of EXPECTED_ITEM_IDS) {
    if (!seen.has(expected)) {
      violations.push({
        family: 'dependency-graph',
        file: WORK_ITEMS_FILE,
        expectation: `work item ${expected} is missing from the backlog`,
      });
    }
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const workEdges: { from: string; to: string }[] = [];
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) {
        violations.push({
          family: 'dependency-graph',
          file: WORK_ITEMS_FILE,
          expectation: `work item ${item.id} depends on ${dependency}, which does not exist in the backlog`,
        });
        continue;
      }
      workEdges.push({ from: dependency, to: item.id });
    }
  }
  const workEdgeKeys = new Set(workEdges.map((edge) => `${edge.from}->${edge.to}`));
  const cyclic = cycleNodes(
    items.map((item) => item.id),
    workEdges,
  );
  if (cyclic.length > 0) {
    violations.push({
      family: 'dependency-graph',
      file: WORK_ITEMS_FILE,
      expectation: `the dependency graph is cyclic (nodes inside a cycle: ${cyclic.join(', ')})`,
    });
  }

  const summary = parseDagSummary(world.dependencyGraph);
  violations.push(...summary.problems);
  for (const edge of summary.edges) {
    if (!workEdgeKeys.has(`${edge.from}->${edge.to}`)) {
      violations.push({
        family: 'dependency-graph',
        file: DEPENDENCY_GRAPH_FILE,
        expectation: `DAG summary edge ${edge.from} -> ${edge.to} is not a declared dependency in WORK_ITEMS.md (same direction required)`,
      });
    }
  }
  for (const expected of EXPECTED_ITEM_IDS) {
    if (!summary.nodes.includes(expected)) {
      violations.push({
        family: 'dependency-graph',
        file: DEPENDENCY_GRAPH_FILE,
        expectation: `work item ${expected} never appears in the DAG summary block`,
      });
    }
  }
  const summaryCyclic = cycleNodes(summary.nodes, summary.edges);
  if (summaryCyclic.length > 0) {
    violations.push({
      family: 'dependency-graph',
      file: DEPENDENCY_GRAPH_FILE,
      expectation: `the DAG summary graph is cyclic (nodes inside a cycle: ${summaryCyclic.join(', ')})`,
    });
  }
  if (!world.dependencyGraph.includes('exact dependency fields in')) {
    violations.push({
      family: 'dependency-graph',
      file: DEPENDENCY_GRAPH_FILE,
      expectation: 'the readiness authority declaration ("the exact dependency fields in WORK_ITEMS.md") is missing',
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Family 2 — the computable ready queue and its terminal state.
// ---------------------------------------------------------------------------

export function checkReadyQueue(
  world: Pick<HandoffArtifacts, 'workItems' | 'implementationStatus'>,
  fs: Pick<FsOracle, 'exists'>,
): readonly HandoffViolation[] {
  const violations: HandoffViolation[] = [];
  const parsed = parseExecutionArtifacts(world);
  violations.push(...parsed.problems);
  const { items, entries } = parsed;
  const byId = new Map(items.map((item) => [item.id, item]));

  const algorithmSection = sectionText(world.workItems, '## Ready-state algorithm');
  if (algorithmSection === undefined) {
    violations.push({
      family: 'ready-queue',
      file: WORK_ITEMS_FILE,
      expectation: 'the "## Ready-state algorithm" section (the algorithm definition) is missing',
    });
  } else {
    for (const token of ['READY iff every item named in its', 'no implicit readiness lanes']) {
      if (!algorithmSection.includes(token)) {
        violations.push({
          family: 'ready-queue',
          file: WORK_ITEMS_FILE,
          expectation: `the ready-state algorithm definition is missing its "${token}" clause`,
        });
      }
    }
  }

  const doneIds = entries.map((entry) => entry.id);
  const doneSet = new Set(doneIds);
  const duplicates = doneIds.filter((id, index) => doneIds.indexOf(id) !== index);
  for (const duplicate of new Set(duplicates)) {
    violations.push({
      family: 'ready-queue',
      file: STATUS_FILE,
      expectation: `completion entry ${duplicate} is recorded more than once`,
    });
  }
  for (const entry of entries) {
    if (!byId.has(entry.id)) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: `completion entry ${entry.id} references a work item that does not exist in WORK_ITEMS.md`,
      });
    }
  }

  // Recorded reality must agree with the dependency parse: every DONE item's
  // dependencies must themselves be DONE (a violation here is a real
  // dependency-order defect in the history — report it, never hide it).
  for (const entry of entries) {
    const item = byId.get(entry.id);
    if (item === undefined) continue;
    for (const dependency of item.dependsOn) {
      if (!doneSet.has(dependency)) {
        violations.push({
          family: 'ready-queue',
          file: STATUS_FILE,
          expectation: `recorded-reality disagreement: DONE item ${entry.id} depends on ${dependency}, which is not DONE`,
        });
      }
    }
  }

  // The status line must agree with the parsed completion entries.
  const statusLine = firstMatch(world.implementationStatus, /^Status: (.+)$/m);
  if (statusLine === undefined) {
    violations.push({
      family: 'ready-queue',
      file: STATUS_FILE,
      expectation: 'the top "Status:" line is missing',
    });
  } else {
    const doneCount = firstMatch(statusLine, /(\d+)\/(\d+) items done/);
    if (doneCount === undefined) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: 'the Status line lacks the "N/NN items done" grammar the tracker has always used',
      });
    } else {
      const denominator = statusLine.match(/(\d+)\/(\d+) items done/);
      const recordedDone = Number.parseInt(doneCount, 10);
      const recordedTotal = denominator?.[2] === undefined ? undefined : Number.parseInt(denominator[2], 10);
      if (recordedDone !== entries.length) {
        violations.push({
          family: 'ready-queue',
          file: STATUS_FILE,
          expectation: `the Status line says ${doneCount} items done but ${entries.length} completion entries are recorded`,
        });
      }
      if (recordedTotal !== undefined && recordedTotal !== items.length) {
        violations.push({
          family: 'ready-queue',
          file: STATUS_FILE,
          expectation: `the Status line counts a ${recordedTotal}-item backlog but WORK_ITEMS.md declares ${items.length}`,
        });
      }
    }
    const through = firstMatch(statusLine, /through OFF-(\d{3})/);
    const newest = entries[0]?.id;
    if (through === undefined || `OFF-${through}` !== newest) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: `the Status line's "through OFF-XXX" phrase must name the newest completion entry (${newest ?? 'none'})`,
      });
    }
    const remaining = firstMatch(statusLine, /Remaining (\d+)/);
    const expectedRemaining = items.length - entries.length;
    if (entries.length < items.length && remaining === undefined) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: 'the Status line lacks the "Remaining N:" grammar while items are still open',
      });
    }
    if (remaining !== undefined && Number.parseInt(remaining, 10) !== expectedRemaining) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: `the Status line says ${remaining} remaining but ${expectedRemaining} items are not DONE`,
      });
    }
  }

  // Completion dates are newest-first down the document: non-increasing.
  for (let index = 1; index < entries.length; index += 1) {
    const older = entries[index];
    const newer = entries[index - 1];
    if (older === undefined || newer === undefined) continue;
    if (older.date > newer.date) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: `completion dates must be non-increasing down the document (newest-first): ${newer.id} (${newer.date}) is above ${older.id} (${older.date})`,
      });
    }
  }

  // The recorded ready-queue section must agree with the computed queue.
  const queueSection = sectionText(world.implementationStatus, '## Current ready queue');
  if (queueSection === undefined) {
    violations.push({
      family: 'ready-queue',
      file: STATUS_FILE,
      expectation: 'the "## Current ready queue" section is missing',
    });
  } else {
    const outputsPresent = (id: string): boolean => {
      const item = byId.get(id);
      return item === undefined || item.produces.trim() === '' || fs.exists('package.json');
    };
    const computed = readyQueue(items, doneSet, outputsPresent);
    const recorded = offIdsIn(queueSection).filter((id) => !doneSet.has(id)).sort();
    if (computed.join(',') !== recorded.join(',')) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: `the recorded ready queue [${recorded.join(', ')}] disagrees with the computed ready queue [${computed.join(', ')}]`,
      });
    }
    // The terminal equivalence: the queue is empty exactly when the backlog
    // is complete (holds in every recorded state of this tracker).
    if (computed.length === 0 !== (entries.length === items.length)) {
      violations.push({
        family: 'ready-queue',
        file: STATUS_FILE,
        expectation: `terminal-state equivalence broken: ready queue is ${computed.length === 0 ? 'empty' : `non-empty (${computed.join(', ')})`} while ${entries.length}/${items.length} items are DONE`,
      });
    }
  }

  // The terminal truth, computed purely: all items DONE ⇒ the queue is EMPTY.
  const allDone = new Set(items.map((item) => item.id));
  if (readyQueue(items, allDone, () => true).length !== 0) {
    violations.push({
      family: 'ready-queue',
      file: WORK_ITEMS_FILE,
      expectation: 'the terminal computation failed: with all items DONE the ready queue must be EMPTY',
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Family 3 — the completion replay (liveness proof).
// ---------------------------------------------------------------------------

export function checkCompletionReplay(
  world: Pick<HandoffArtifacts, 'workItems' | 'implementationStatus' | 'dependencyGraph' | 'techLeadHandoff'>,
  fs: Pick<FsOracle, 'exists'>,
): readonly HandoffViolation[] {
  const violations: HandoffViolation[] = [];
  const parsed = parseExecutionArtifacts(world);
  violations.push(...parsed.problems);
  const { items, entries } = parsed;
  const byId = new Map(items.map((item) => [item.id, item]));

  const outputsPresent = (id: string): boolean => {
    const item = byId.get(id);
    return item === undefined || item.produces.trim() === '' || fs.exists('package.json');
  };
  const replay = replayCompletion(items, entries, outputsPresent);
  violations.push(...replay.violations);

  const maxFrontier = replay.frontierHistory.length === 0
    ? 0
    : Math.max(...replay.frontierHistory);
  if (maxFrontier < 3) {
    violations.push({
      family: 'completion-replay',
      file: STATUS_FILE,
      expectation: `the ready frontier never offered three simultaneous choices (max ${maxFrontier}) — the documented three-worker waves would have been impossible`,
    });
  }

  // The waves both governance docs name must have been simultaneously ready.
  const graphWaves = parseWaves(sectionText(world.dependencyGraph, '## Parallelization rules'));
  const handoffWaves = parseWaves(sectionText(world.techLeadHandoff, '## Three-worker scheduling rule'));
  if (graphWaves.length === 0) {
    violations.push({
      family: 'completion-replay',
      file: DEPENDENCY_GRAPH_FILE,
      expectation: 'the "## Parallelization rules" section names no `OFF-XXX` + `OFF-XXX` wave',
    });
  }
  if (handoffWaves.length === 0) {
    violations.push({
      family: 'completion-replay',
      file: 'docs/execution/TECH_LEAD_HANDOFF.md',
      expectation: 'the "## Three-worker scheduling rule" section names no `OFF-XXX` + `OFF-XXX` wave',
    });
  }
  const key = (wave: readonly string[]): string => wave.join(',');
  const graphKeys = new Set(graphWaves.map(key));
  const handoffKeys = new Set(handoffWaves.map(key));
  if (graphKeys.size !== handoffKeys.size || [...graphKeys].some((k) => !handoffKeys.has(k))) {
    violations.push({
      family: 'completion-replay',
      file: DEPENDENCY_GRAPH_FILE,
      expectation: `the parallelization waves named by DEPENDENCY_GRAPH.md [${[...graphKeys].sort().join(' / ')}] and TECH_LEAD_HANDOFF.md [${[...handoffKeys].sort().join(' / ')}] disagree`,
    });
  }
  for (const wave of graphWaves) {
    for (const id of wave) {
      if (!byId.has(id)) {
        violations.push({
          family: 'completion-replay',
          file: DEPENDENCY_GRAPH_FILE,
          expectation: `parallelization wave [${wave.join(' + ')}] names ${id}, which does not exist`,
        });
      }
    }
    const simultaneous = replay.frontierHistory.some((_, prefixIndex) => {
      const done = new Set(replay.order.slice(0, prefixIndex + 1));
      return wave.every(
        (id) =>
          !done.has(id) &&
          (byId.get(id)?.dependsOn.every((dependency) => done.has(dependency)) ?? false),
      );
    });
    if (!simultaneous) {
      violations.push({
        family: 'completion-replay',
        file: STATUS_FILE,
        expectation: `the documented wave [${wave.join(' + ')}] was never simultaneously ready in the completion replay`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Family 4 — unambiguous ownership.
// ---------------------------------------------------------------------------

/** Parse the primary footprints a completion entry's Produced line declares. */
export function producedFootprints(
  producedLine: string | undefined,
  manifestNames: ReadonlyMap<string, string>,
): { footprints: readonly string[]; unmapped: readonly string[] } {
  if (producedLine === undefined) return { footprints: [], unmapped: [] };
  const footprints: string[] = [];
  const unmapped: string[] = [];
  for (const match of producedLine.matchAll(/`([^`]+)`/g)) {
    const token = match[1];
    if (token === undefined) continue;
    if (token.startsWith('@')) {
      const path = manifestNames.get(token);
      if (path === undefined) unmapped.push(token);
      else footprints.push(path);
    } else if (/^(packages|apps|tests)\/[a-z0-9-]+$/.test(token.replace(/\*\*$/, ''))) {
      footprints.push(token.replace(/\*\*$/, ''));
    }
  }
  // The conformance-suite form: "the conformance suite at tests/architecture/**".
  for (const match of producedLine.matchAll(/\bsuite at (tests\/[a-z0-9-]+)/g)) {
    const path = match[1];
    if (path !== undefined && !footprints.includes(path)) footprints.push(path);
  }
  return { footprints: [...new Set(footprints)], unmapped };
}

export function checkOwnership(
  world: Pick<HandoffArtifacts, 'workItems' | 'implementationStatus' | 'handoffReadme'>,
  fs: FsOracle,
): readonly HandoffViolation[] {
  const violations: HandoffViolation[] = [];
  const parsed = parseExecutionArtifacts(world);
  violations.push(...parsed.problems);
  const { items, entries } = parsed;
  const byId = new Map(items.map((item) => [item.id, item]));

  // Exactly one Owner boundary per item (grammar) + pairwise distinct.
  const boundaries = new Map<string, string>();
  for (const item of items) {
    if (item.ownerBoundary.trim() === '') continue;
    const claimed = boundaries.get(item.ownerBoundary);
    if (claimed !== undefined) {
      violations.push({
        family: 'ownership',
        file: WORK_ITEMS_FILE,
        expectation: `ambiguous ownership: ${claimed} and ${item.id} both claim the owner boundary "${item.ownerBoundary}"`,
      });
    } else {
      boundaries.set(item.ownerBoundary, item.id);
    }
  }

  const manifests = fs.manifests();
  const manifestNames = new Map(manifests.map((manifest) => [manifest.name, manifest.path]));
  const claimedBy = new Map<string, string>();
  for (const entry of entries) {
    const { footprints, unmapped } = producedFootprints(entry.producedLine, manifestNames);
    for (const name of unmapped) {
      violations.push({
        family: 'ownership',
        file: STATUS_FILE,
        expectation: `completion entry ${entry.id} declares produced package "${name}", which no workspace manifest carries`,
      });
    }
    if (entry.id !== 'OFF-001' && footprints.length === 0) {
      violations.push({
        family: 'ownership',
        file: STATUS_FILE,
        expectation: `completion entry ${entry.id} has a Produced line naming no primary package/app/suite path (OFF-001 — the toolchain bootstrap — is the only entry allowed to produce the repository itself)`,
      });
    }
    for (const footprint of footprints) {
      if (!fs.exists(footprint)) {
        violations.push({
          family: 'ownership',
          file: STATUS_FILE,
          expectation: `completion entry ${entry.id} declares produced path ${footprint}, which does not exist in the repository`,
        });
      }
      const other = claimedBy.get(footprint);
      if (other !== undefined) {
        violations.push({
          family: 'ownership',
          file: STATUS_FILE,
          expectation: `ambiguous ownership: ${other} and ${entry.id} both claim the primary footprint ${footprint}`,
        });
      } else {
        claimedBy.set(footprint, entry.id);
      }
    }
    // Where the Owner boundary is a path, the produced footprint must match it.
    const item = byId.get(entry.id);
    if (item !== undefined) {
      for (const match of item.ownerBoundary.matchAll(/`(packages|apps)\/[a-z0-9/-]+`/g)) {
        const boundaryPath = (match[0] ?? '').replace(/`/g, '');
        if (!footprints.includes(boundaryPath)) {
          violations.push({
            family: 'ownership',
            file: WORK_ITEMS_FILE,
            expectation: `${entry.id}'s owner boundary names ${boundaryPath} but its Produced line does not declare that footprint`,
          });
        }
      }
    }
  }

  // Every workspace manifest is some item's declared output, or the one
  // documented shared-infrastructure exception.
  for (const manifest of manifests) {
    if (claimedBy.has(manifest.path)) continue;
    if (UNCLAIMED_MANIFEST_EXCEPTIONS.includes(manifest.path)) continue;
    violations.push({
      family: 'ownership',
      file: STATUS_FILE,
      expectation: `workspace manifest ${manifest.path} (${manifest.name}) is claimed by no work item's Produced line — unambiguous ownership requires every package/app to be owned`,
    });
  }

  // The successor's ownership table in tests/handoff/README.md must agree.
  const tableRows = parseOwnershipTable(world.handoffReadme);
  if (tableRows === undefined) {
    violations.push({
      family: 'ownership',
      file: 'tests/handoff/README.md',
      expectation: 'the ownership table (under "## The ownership table") is missing',
    });
  } else {
    const rowIds = tableRows.map((row) => row.id).sort();
    const itemIdsSorted = items.map((item) => item.id).sort();
    if (rowIds.join(',') !== itemIdsSorted.join(',')) {
      violations.push({
        family: 'ownership',
        file: 'tests/handoff/README.md',
        expectation: `the ownership table must list each work item exactly once (rows: ${rowIds.length}, items: ${items.length})`,
      });
    }
    for (const row of tableRows) {
      const item = byId.get(row.id);
      if (item === undefined) continue;
      if (row.boundary !== item.ownerBoundary) {
        violations.push({
          family: 'ownership',
          file: 'tests/handoff/README.md',
          expectation: `the ownership table row for ${row.id} must quote the owner boundary verbatim ("${item.ownerBoundary}", found "${row.boundary}")`,
        });
      }
      const entry = entries.find((candidate) => candidate.id === row.id);
      for (const match of row.footprintCell.matchAll(/`([^`]+)`/g)) {
        const path = (match[1] ?? '').replace(/\*\*$/, '');
        if (path === '' || path.startsWith('@')) continue;
        if (!fs.exists(path)) {
          violations.push({
            family: 'ownership',
            file: 'tests/handoff/README.md',
            expectation: `the ownership table row for ${row.id} names ${path}, which does not exist`,
          });
          continue;
        }
        if (entry !== undefined) {
          const { footprints } = producedFootprints(entry.producedLine, manifestNames);
          if (footprints.length > 0 && !footprints.includes(path)) {
            violations.push({
              family: 'ownership',
              file: 'tests/handoff/README.md',
              expectation: `the ownership table row for ${row.id} names ${path}, which its completion entry's Produced line does not declare`,
            });
          }
        }
      }
    }
  }
  return violations;
}

/** Parse the successor map's ownership table rows (id | boundary | footprint). */
export function parseOwnershipTable(
  readme: string,
): readonly { id: string; boundary: string; footprintCell: string }[] | undefined {
  const section = sectionText(readme, '## The ownership table');
  if (section === undefined) return undefined;
  const rows: { id: string; boundary: string; footprintCell: string }[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (line.replace(/[^-]/g, '') === '') continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // ['', id, boundary, footprint, ''] — the leading/trailing empties from split.
    const id = cells[1];
    const boundary = cells[2];
    const footprintCell = cells.slice(3, -1).join(' | ');
    if (id === undefined || boundary === undefined) continue;
    if (!/^OFF-\d{3}$/.test(id)) continue;
    rows.push({ id, boundary, footprintCell });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Family 5 — reproducible setup instructions.
// ---------------------------------------------------------------------------

export function checkSetupInstructions(
  world: Pick<HandoffArtifacts, 'handoffReadme' | 'packageJson' | 'ciYaml' | 'vitestConfig' | 'rootReadme'>,
): readonly HandoffViolation[] {
  const violations: HandoffViolation[] = [];
  const readmeFile = 'tests/handoff/README.md';

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(world.packageJson) as Record<string, unknown>;
  } catch {
    violations.push({
      family: 'setup-instructions',
      file: 'package.json',
      expectation: 'package.json is not parseable JSON',
    });
    return violations;
  }
  const scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>;
  for (const script of GATE_SCRIPTS) {
    if (typeof scripts[script] !== 'string') {
      violations.push({
        family: 'setup-instructions',
        file: 'package.json',
        expectation: `the root "${script}" script is missing`,
      });
    }
  }
  const packageManager = typeof pkg['packageManager'] === 'string' ? pkg['packageManager'] : '';
  const pinMatch = packageManager.match(/^pnpm@(\d+\.\d+\.\d+)$/);
  if (pinMatch === null) {
    violations.push({
      family: 'setup-instructions',
      file: 'package.json',
      expectation: `the packageManager pin must be pnpm@<semver> (found "${packageManager}")`,
    });
  }
  const engines = (pkg['engines'] ?? {}) as Record<string, unknown>;
  const nodeEngine = typeof engines['node'] === 'string' ? engines['node'] : '';
  const nodeMajor = firstMatch(nodeEngine, /^>=(\d+)$/);

  // The successor map documents the bootstrap: clone, install, the four gates,
  // and the toolchain pins — cross-checked against package.json's own pins.
  const bootstrapTokens: readonly string[] = [
    'git clone',
    'pnpm install',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'pnpm test:architecture',
  ];
  for (const token of bootstrapTokens) {
    if (!world.handoffReadme.includes(token)) {
      violations.push({
        family: 'setup-instructions',
        file: readmeFile,
        expectation: `the setup bootstrap is missing the "${token}" command`,
      });
    }
  }
  if (pinMatch !== null && pinMatch[1] !== undefined && !world.handoffReadme.includes(pinMatch[1])) {
    violations.push({
      family: 'setup-instructions',
      file: readmeFile,
      expectation: `the setup bootstrap does not document the pinned pnpm version ${pinMatch[1]}`,
    });
  }
  if (nodeMajor !== undefined && !new RegExp(`Node(\\.js)?[^\\n]{0,20}${nodeMajor}`).test(world.handoffReadme)) {
    violations.push({
      family: 'setup-instructions',
      file: readmeFile,
      expectation: `the setup bootstrap does not document the Node ${nodeMajor} requirement (engines pin)`,
    });
  }

  // ci.yml runs the same gates as required steps.
  const ciLines = world.ciYaml.split('\n').map((line) => line.trim());
  if (!ciLines.includes('run: pnpm install --frozen-lockfile')) {
    violations.push({
      family: 'setup-instructions',
      file: '.github/workflows/ci.yml',
      expectation: 'CI must install with "pnpm install --frozen-lockfile" (the reproducible lockfile)',
    });
  }
  for (const script of GATE_SCRIPTS) {
    if (!ciLines.includes(`run: pnpm ${script}`)) {
      violations.push({
        family: 'setup-instructions',
        file: '.github/workflows/ci.yml',
        expectation: `CI must run the root gate script as a required step ("run: pnpm ${script}")`,
      });
    }
  }
  // The distinctly named required conformance step (OFF-039) — matched in the
  // trimmed-line form YAML actually writes for a step ("- name: ...", with
  // the list marker trimmed away or not).
  const gateStepIndex = ciLines.findIndex(
    (line) => line === 'name: Architecture conformance gate (OFF-039)' || line === '- name: Architecture conformance gate (OFF-039)',
  );
  if (gateStepIndex === -1) {
    violations.push({
      family: 'setup-instructions',
      file: '.github/workflows/ci.yml',
      expectation: 'the required step "Architecture conformance gate (OFF-039)" is missing or renamed',
    });
  } else if (!ciLines.slice(gateStepIndex + 1, gateStepIndex + 5).includes('run: pnpm test:architecture')) {
    violations.push({
      family: 'setup-instructions',
      file: '.github/workflows/ci.yml',
      expectation: 'the "Architecture conformance gate (OFF-039)" step must run "pnpm test:architecture"',
    });
  }
  // No step may SET continue-on-error (comments explaining the discipline
  // are legitimate prose; a step that sets the key is an advisory gate).
  if (ciLines.some((line) => /^-?\s*continue-on-error\s*:/i.test(line))) {
    violations.push({
      family: 'setup-instructions',
      file: '.github/workflows/ci.yml',
      expectation: 'no CI step may set continue-on-error (the gates are required, never advisory)',
    });
  }
  if (nodeMajor !== undefined && !ciLines.includes(`node-version: ${nodeMajor}`)) {
    violations.push({
      family: 'setup-instructions',
      file: '.github/workflows/ci.yml',
      expectation: `CI must set up Node ${nodeMajor} (the engines pin)`,
    });
  }
  if (!world.ciYaml.includes('pnpm/action-setup')) {
    violations.push({
      family: 'setup-instructions',
      file: '.github/workflows/ci.yml',
      expectation: 'CI must install pnpm through pnpm/action-setup (version read from the packageManager pin)',
    });
  }
  for (const trigger of ['- push', '- pull_request']) {
    if (!ciLines.includes(trigger)) {
      violations.push({
        family: 'setup-instructions',
        file: '.github/workflows/ci.yml',
        expectation: `CI must trigger on ${trigger.replace('- ', '')} (the gates run on every push and pull request)`,
      });
    }
  }

  // The vitest include globs keep a fresh engineer's new tests from being
  // silently unrun.
  for (const glob of VITEST_GLOBS) {
    if (!world.vitestConfig.includes(`'${glob}'`)) {
      violations.push({
        family: 'setup-instructions',
        file: 'vitest.config.ts',
        expectation: `the vitest include must cover '${glob}'`,
      });
    }
  }

  // The root README still carries the successor entry point and the mission.
  for (const token of [
    '## Successor Tech Lead Entry Point',
    'docs/execution/TECH_LEAD_HANDOFF.md',
    'AI-native Construction Enterprise & Project Operating System',
  ]) {
    if (!world.rootReadme.includes(token)) {
      violations.push({
        family: 'setup-instructions',
        file: 'README.md',
        expectation: `the root README must keep its successor entry point vocabulary ("${token}")`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Family 6 — the independence-test answers + the terminal status sections.
// ---------------------------------------------------------------------------

/** One artifact anchor answering one independence-test question. */
export interface QuestionAnchor {
  readonly file: string;
  readonly section?: string;
  readonly vocabulary: readonly string[];
}

export const QUESTION_ANCHORS: Readonly<Record<string, readonly QuestionAnchor[]>> = {
  'the product mission': [
    {
      file: 'README.md',
      vocabulary: [
        'AI-native Construction Enterprise & Project Operating System',
        'canonical construction project and enterprise operating layer',
      ],
    },
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '## Mission', vocabulary: ['canonical construction graph'] },
    { file: 'docs/execution/TECH_LEAD_HANDOFF.md', section: '## Mission', vocabulary: ['sole authoritative implementation context'] },
  ],
  'canonical truth and bounded contexts': [
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '## Core bounded contexts', vocabulary: ['Identity & Tenancy', 'Marketplace & App Lifecycle'] },
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '### A2. Transactional authority', vocabulary: ['transactional source of truth', 'canonical write authority'] },
    { file: 'docs/architecture/ADR-001-canonical-construction-graph.md', section: '## Decision', vocabulary: ['canonical Construction Enterprise Graph'] },
  ],
  'coexistence strategy for specialist systems': [
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '### A5. Specialist system coexistence', vocabulary: ['integrated through adapters', 'system-of-record authorities'] },
    { file: 'docs/architecture/ADR-004-system-adapters.md', section: '## Decision', vocabulary: ['stable Adapter SDK', 'canonical interfaces'] },
  ],
  'marketplace model': [
    { file: 'docs/architecture/ADR-003-app-marketplace.md', section: '## Decision', vocabulary: ['app marketplace', 'versioned extension package'] },
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '### A7. Marketplace', vocabulary: ['tenant-scoped app installation', 'capabilities, permissions'] },
  ],
  'same-project/many-view contract': [
    { file: 'docs/architecture/ADR-002-multi-view-project-model.md', section: '## Decision', vocabulary: ['projections/views over the same canonical project state'] },
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '### A6. Multi-view project state', vocabulary: ['views/extensions over the same project graph'] },
  ],
  'AI execution boundary': [
    { file: 'docs/architecture/ADR-005-agent-execution-safety.md', section: '## Decision', vocabulary: ['typed Action Gateway', 'cannot mutate the database directly'] },
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '### A8. AI execution boundary', vocabulary: ['never write arbitrary database state'] },
  ],
  'offline conflict policy': [
    { file: 'docs/architecture/ARCHITECTURE_FREEZE.md', section: '### A9. Offline-first field edge', vocabulary: ['cannot silently last-write-wins', 'later synchronized'] },
    { file: 'docs/execution/TECH_LEAD_HANDOFF.md', section: '## Non-negotiable architecture', vocabulary: ['surfaced for resolution'] },
  ],
  'current READY queue': [
    { file: 'docs/execution/IMPLEMENTATION_STATUS.md', section: '## Current ready queue', vocabulary: ['READY'] },
    { file: 'docs/execution/DEPENDENCY_GRAPH.md', section: '## Readiness', vocabulary: ['exact predecessor completion'] },
    { file: 'docs/execution/WORK_ITEMS.md', section: '## Ready-state algorithm', vocabulary: ['READY iff every item named in its'] },
  ],
  'worker ownership rules': [
    { file: 'docs/execution/WORK_ITEMS.md', section: '## Worker operating rule', vocabulary: ['At most 3 implementation workers'] },
    { file: 'AGENTS.md', section: '## Worker protocol', vocabulary: ['identify its work-item ID'] },
    { file: 'docs/execution/TECH_LEAD_HANDOFF.md', section: '## Worker dispatch contract', vocabulary: ['Allowed ownership:'] },
  ],
  'completion evidence': [
    { file: 'docs/execution/IMPLEMENTATION_STATUS.md', section: '## Completed work items', vocabulary: ['Merge:'] },
    { file: 'docs/execution/DEFINITION_OF_DONE.md', vocabulary: ['DONE only if every applicable gate'] },
  ],
  'how to propose an architecture change': [
    { file: 'docs/execution/TECH_LEAD_HANDOFF.md', section: '## Architecture-change protocol', vocabulary: ['ADR revision', 'explicitly accepted and committed'] },
    { file: 'AGENTS.md', section: '## Hard constraints', vocabulary: ['Never change a frozen ADR inside a feature PR'] },
  ],
};

const HANDOFF_FILE = 'docs/execution/TECH_LEAD_HANDOFF.md';

/** The independence-test questions, parsed from the (frozen) handoff section. */
export function parseIndependenceQuestions(handoff: string): readonly string[] {
  const section = sectionText(handoff, '## Successor independence test');
  if (section === undefined) return [];
  const questions: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const question = line.slice(2).replace(/[;.]+$/, '').trim();
    if (question !== '') questions.push(question);
  }
  return questions;
}

export function checkIndependenceTest(
  world: Pick<HandoffArtifacts, 'techLeadHandoff' | 'handoffReadme'>,
  fs: Pick<FsOracle, 'exists' | 'read'>,
): readonly HandoffViolation[] {
  const violations: HandoffViolation[] = [];
  const questions = parseIndependenceQuestions(world.techLeadHandoff);

  if (questions.length === 0) {
    violations.push({
      family: 'independence-test',
      file: HANDOFF_FILE,
      expectation: 'the "## Successor independence test" question list is missing or empty',
    });
  }
  for (const question of questions) {
    if (QUESTION_ANCHORS[question] === undefined) {
      violations.push({
        family: 'independence-test',
        file: HANDOFF_FILE,
        expectation: `independence-test question "${question}" has no artifact-anchor mapping — repair the repository artifacts`,
      });
    }
  }
  for (const known of Object.keys(QUESTION_ANCHORS)) {
    if (!questions.includes(known)) {
      violations.push({
        family: 'independence-test',
        file: HANDOFF_FILE,
        expectation: `the frozen independence-test question list no longer carries "${known}"`,
      });
    }
  }

  for (const [question, anchors] of Object.entries(QUESTION_ANCHORS)) {
    for (const anchor of anchors) {
      if (!fs.exists(anchor.file)) {
        violations.push({
          family: 'independence-test',
          file: anchor.file,
          expectation: `the anchor answering "${question}" is missing`,
        });
        continue;
      }
      const text = fs.read(anchor.file);
      let scope = text;
      if (anchor.section !== undefined) {
        const section = sectionText(text, anchor.section);
        if (section === undefined) {
          violations.push({
            family: 'independence-test',
            file: anchor.file,
            expectation: `the section "${anchor.section}" answering "${question}" is missing`,
          });
          continue;
        }
        scope = section;
      }
      for (const token of anchor.vocabulary) {
        if (!scope.includes(token)) {
          violations.push({
            family: 'independence-test',
            file: anchor.file,
            expectation: `the anchor answering "${question}" is vacuous: "${anchor.section ?? anchor.file}" does not carry "${token}"`,
          });
        }
      }
    }
  }

  // The three successor-facing status sections carry the terminal truth.
  const statusLine = firstMatch(world.techLeadHandoff, /^Status: (.+)$/m) ?? '';
  for (const token of ['40/40', 'ready queue is EMPTY', 'tests/handoff']) {
    if (!statusLine.includes(token)) {
      violations.push({
        family: 'independence-test',
        file: HANDOFF_FILE,
        expectation: `the top Status line has not been brought to the terminal truth (missing "${token}")`,
      });
    }
  }
  const reality = sectionText(world.techLeadHandoff, '## Important reality check') ?? '';
  for (const token of ['all 40 work items', 'IMPLEMENTATION_STATUS.md', 'merge PRs', 'pnpm test', 'exit 0', 'DEFINITION_OF_DONE.md']) {
    if (!reality.includes(token)) {
      violations.push({
        family: 'independence-test',
        file: HANDOFF_FILE,
        expectation: `the "## Important reality check" section is not the completion truth (missing "${token}")`,
      });
    }
  }
  const authoritative = sectionText(world.techLeadHandoff, '## Current authoritative status') ?? '';
  for (const token of [
    'COMPLETE',
    '40/40',
    'ready queue is EMPTY',
    'NEW work items',
    'AGENTS.md',
    'docs/execution/DEFINITION_OF_DONE.md',
    'docs/execution/DEPENDENCY_GRAPH.md',
    'IMPLEMENTATION_STATUS.md',
  ]) {
    if (!authoritative.includes(token)) {
      violations.push({
        family: 'independence-test',
        file: HANDOFF_FILE,
        expectation: `the "## Current authoritative status" section is not the terminal state (missing "${token}")`,
      });
    }
  }
  // The frozen sections around the status sections stay intact.
  for (const heading of [
    '## Mission',
    '## Non-negotiable architecture',
    '## Worker dispatch contract',
    '## Architecture-change protocol',
    '## Successor independence test',
  ]) {
    if (sectionText(world.techLeadHandoff, heading) === undefined) {
      violations.push({
        family: 'independence-test',
        file: HANDOFF_FILE,
        expectation: `the frozen section "${heading}" is missing from the handoff document`,
      });
    }
  }
  if (
    !world.techLeadHandoff.includes(
      'If any answer requires hidden conversation context, repair the repository artifacts before feature implementation continues.',
    )
  ) {
    violations.push({
      family: 'independence-test',
      file: HANDOFF_FILE,
      expectation: 'the independence-test closing rule (the repair directive) is missing',
    });
  }

  // The successor map's answer table points where the answers live.
  const mapRows = parseAnswerMap(world.handoffReadme);
  if (mapRows === undefined) {
    violations.push({
      family: 'independence-test',
      file: 'tests/handoff/README.md',
      expectation: 'the independence-answer map (under "## The independence-test answers") is missing',
    });
  } else {
    const mapped = mapRows.map((row) => row.question).sort();
    const expected = Object.keys(QUESTION_ANCHORS).sort();
    if (mapped.join('\u0000') !== expected.join('\u0000')) {
      violations.push({
        family: 'independence-test',
        file: 'tests/handoff/README.md',
        expectation: `the independence-answer map must carry exactly one row per independence-test question (${mapped.length} rows vs ${expected.length} questions)`,
      });
    }
    for (const row of mapRows) {
      const anchors = QUESTION_ANCHORS[row.question];
      if (anchors === undefined) continue;
      const anchorFiles = anchors.map((anchor) => anchor.file);
      const paths = [...row.anchorsCell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
      if (!paths.some((path) => anchorFiles.includes(path))) {
        violations.push({
          family: 'independence-test',
          file: 'tests/handoff/README.md',
          expectation: `the answer-map row for "${row.question}" names no verified anchor file (expected one of: ${anchorFiles.join(', ')})`,
        });
      }
      for (const path of paths) {
        if (path !== '' && !fs.exists(path)) {
          violations.push({
            family: 'independence-test',
            file: 'tests/handoff/README.md',
            expectation: `the answer-map row for "${row.question}" names ${path}, which does not exist`,
          });
        }
      }
    }
  }
  return violations;
}

/** Parse the successor map's answer table rows (question | anchors). */
export function parseAnswerMap(
  readme: string,
): readonly { question: string; anchorsCell: string }[] | undefined {
  const section = sectionText(readme, '## The independence-test answers');
  if (section === undefined) return undefined;
  const rows: { question: string; anchorsCell: string }[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (line.replace(/[^-]/g, '') === '') continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const question = cells[1];
    const anchorsCell = cells.slice(2, -1).join(' | ');
    if (question === undefined) continue;
    rows.push({ question, anchorsCell });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The real-tree loader (fail-closed: every missing file is a named failure).
// ---------------------------------------------------------------------------

export const realFs: FsOracle = {
  exists: (path) => existsSync(join(repoRoot, path)),
  read: (path) => {
    const full = join(repoRoot, path);
    if (!existsSync(full)) {
      throw new Error(`tests/handoff: missing artifact file: ${path}`);
    }
    return readFileSync(full, 'utf8');
  },
  manifests: () => {
    const entries: ManifestEntry[] = [];
    const walk = (dir: string, depth: number): void => {
      let dirents;
      try {
        dirents = readdirSync(join(repoRoot, dir), { withFileTypes: true });
      } catch (error) {
        throw new Error(`tests/handoff: unreadable directory ${dir}: ${String(error)}`);
      }
      for (const dirent of [...dirents].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!dirent.isDirectory()) continue;
        const path = `${dir}/${dirent.name}`;
        if (existsSync(join(repoRoot, path, 'package.json'))) {
          const manifest = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8')) as {
            name?: unknown;
          };
          if (typeof manifest.name !== 'string') {
            throw new Error(`tests/handoff: manifest without a name: ${path}/package.json`);
          }
          entries.push({ path, name: manifest.name });
        }
        if (depth > 0 && (dirent.name === 'domain' || dirent.name === 'intelligence')) {
          walk(path, depth - 1);
        }
      }
    };
    walk('packages', 1);
    walk('apps', 0);
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  },
};

const ARTIFACT_FILES = [
  'docs/execution/WORK_ITEMS.md',
  'docs/execution/DEPENDENCY_GRAPH.md',
  'docs/execution/IMPLEMENTATION_STATUS.md',
  'docs/execution/DEFINITION_OF_DONE.md',
  'docs/execution/TECH_LEAD_HANDOFF.md',
  'README.md',
  'tests/handoff/README.md',
  'package.json',
  '.github/workflows/ci.yml',
  'vitest.config.ts',
] as const;

let cachedWorld: HandoffArtifacts | undefined;

/** Load every consumed artifact from the real tree (memoized, fail-closed). */
export function loadRealArtifacts(): HandoffArtifacts {
  if (cachedWorld !== undefined) return cachedWorld;
  const texts = ARTIFACT_FILES.map((path) => realFs.read(path));
  const [
    workItems,
    dependencyGraph,
    implementationStatus,
    definitionOfDone,
    techLeadHandoff,
    rootReadme,
    handoffReadme,
    packageJson,
    ciYaml,
    vitestConfig,
  ] = texts;
  if (
    workItems === undefined ||
    dependencyGraph === undefined ||
    implementationStatus === undefined ||
    definitionOfDone === undefined ||
    techLeadHandoff === undefined ||
    rootReadme === undefined ||
    handoffReadme === undefined ||
    packageJson === undefined ||
    ciYaml === undefined ||
    vitestConfig === undefined
  ) {
    throw new Error('tests/handoff: artifact loader failed (missing file above)');
  }
  cachedWorld = {
    workItems,
    dependencyGraph,
    implementationStatus,
    definitionOfDone,
    techLeadHandoff,
    rootReadme,
    handoffReadme,
    packageJson,
    ciYaml,
    vitestConfig,
  };
  return cachedWorld;
}
