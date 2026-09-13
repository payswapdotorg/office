# @office/intelligence-memory

Office enterprise memory and benchmarking (OFF-015) — the historical-learning
module of the intelligence layer: deterministic outcome capture, PURE
benchmark facts computed from queried outcome sets, reusable lessons, typed
project-similarity contracts, and the rebuildable memory-store projection.

THE discipline: memory is a PROJECTION derived from recorded events +
assessments — it NEVER becomes canonical truth (freeze A2/A7) and NEVER
introduces an opaque AI dependency in core storage. Similarity is
DETERMINISTIC typed computation over typed feature vectors: no embeddings,
no models, no network, no clock, no randomness — every derived number is an
exact rational attributed to named source events and assessments (A4).

## Dependencies (the dependency rule)

Workspace dependencies only — exactly six, mirroring the landed intelligence
packages:

- `@office/intelligence-relationships` — the authorization-filtered
  traversal subgraphs the similarity feature vectors consume;
- `@office/intelligence-margin` — the `ImpactAssessment` values and the
  deterministic commercial-facts fold the outcome derivation consumes;
- `@office/contracts` — `DomainEventEnvelope`, `EntityId`/`EntityRef`,
  `Scope`, parse helpers;
- `@office/domain-kernel` — `Result`/`DomainError` + deterministic idioms;
- `@office/authz` — deny-by-default authorization contexts (memory reads
  are permissioned);
- `@office/events` — the ledger READ surface + `LedgerEventId` identity
  (this package NEVER writes the ledger: memory events are emitted through
  the mirrored `MemoryEventSink` port inside the caller's transaction).

No external dependencies of ANY kind; no domain/adapters/workflows/sync
packages; no AI/LLM/embedding/network dependency anywhere
(`src/boundary.test.ts` proves it by scanning the package).

## Public surface (src/index.ts — the whole surface)

Later Office modules (OFF-018 agent runtime, OFF-019 control tower,
OFF-034/035 chips) consume the package only through its root entry point:

- **vocabulary** — `OUTCOME_RECORDED_EVENT`, `BENCHMARK_COMPUTED_EVENT`,
  `LESSON_CAPTURED_EVENT`, `RECOGNIZED_MEMORY_EVENT_NAMES`, the
  OUTCOME/BENCHMARK/LESSON id grammars + parse/is helpers,
  `MEMORY_REQUIRED_CAPABILITIES` (contracts.read + cost.read +
  schedule.read — the three bounded contexts a memory record spans).
- **model** — the exact-`Rational` arithmetic (every benchmark statistic and
  similarity score is an integer-numerator/positive-integer-denominator
  pair — no floats anywhere), `OutcomeRecord` (+ every outcome sub-model),
  `Benchmark`, `Lesson`, `ProjectFeatureVector` + similarity query types,
  `OutcomeQuery`/`LessonQuery` parse helpers, evidence comparators, schema
  versions, `MEMORY_ENGINE`.
- **outcome** — `deriveOutcome` (THE deterministic outcome capture) +
  `OutcomeInputs`/`OutcomeIdentity`.
- **benchmark** — `computeBenchmarks` (THE pure outcome-set function) +
  `BenchmarkParts`.
- **lesson** — `captureLesson` (THE deterministic lesson capture) +
  `lessonAppliesToArea`.
- **similarity** — `projectFeatureVector`, `rankSimilarProjects`,
  `DEFAULT_SIMILARITY_WEIGHTS`, `DEFAULT_SIMILARITY_LIMIT`.
- **store** — `projectMemory` (THE deterministic, rebuildable fold) +
  `MemoryStore`/`MemoryDerivation`.
- **authorization** — `MemoryAuthorization`, `checkMemoryCapabilities`,
  `checkMemoryScopeCovers`, `checkMemoryPolicy`, `memoryResource`,
  `memoryOutcomeNotFound`, `queryOutcomes`, `queryLessons`.
- **events** — `outcomeRecordedEnvelope`, `benchmarkComputedEnvelope`,
  `lessonCapturedEnvelope` (+ emit conveniences), payload
  builders/parsers, the `MemoryEventSink` port + in-memory/failing sinks.

`src/test-support.ts` is package-INTERNAL (deterministic envelope factories
+ the golden completed-project scenarios) — not part of the surface.

## Outcome semantics (a fact of history)

`deriveOutcome(inputs, identity)` derives ONE completed project's recorded
outcome from the recorded commercial facts (the margin engine's fold of the
ledger stream) plus that project's margin assessments. The derivation is a
PURE function of its typed inputs: the assessments are consumed in a
canonical `(assessedAt, assessmentId)` order, so the input array's order
never matters, and every derived number carries its SOURCE
event/assessment references (A4): schedule variance cites the boundary
assessments; the cost margin position cites the latest-per-contract
assessments + the recorded `contracts.contractCreated` events; entitlement
outcomes cite the submission + decision events; change pressure cites the
raised change events. Fail-closed: a non-project scope, an empty assessment
set, or a cross-scope assessment input (A12) is a typed rejection BEFORE any
derivation. An outcome is immutable once recorded — the store fold accepts
exactly one outcome per project and treats at-least-once redelivery of the
same event as a deterministic no-op.

## Benchmark semantics (the named acceptance)

`computeBenchmarks(outcomes, parts)` is a PURE function of an outcome set:
per-metric aggregate statistics (min/max/mean/median/percentile90 as exact
rationals — BigInt accumulation, fail-closed conversion) plus per-metric
percentile positions, over the four metric kinds (schedule-variance-days,
margin-ratio, entitlement-approval-rate, change-event-count). The same
outcome set ALWAYS produces the identical benchmark (run-twice determinism;
shuffled input order is irrelevant), and EVERY value carries the outcome ids
that produced it — per metric: an outcome that lacks a metric (e.g. a
zero-contracted-value outcome has no margin ratio) never enters that
value's producing ids. A different outcome set produces a DIFFERENT
benchmark fact, never a mutation of the old one; a recorded snapshot whose
values do not equal the pure recomputation over exactly its named outcome
ids is a typed invariant violation at fold time (stored benchmarks never
drift from the outcome set). A benchmark spans ONE tenant (A12).

## Lesson semantics (data, never silent behavior)

`captureLesson(content, identity)` builds ONE reusable record — a
human-authored or machine-derived statement of what a completed project
taught — with bounded title/statement, at least one applicability tag (a
closed area vocabulary + bounded values), typed links (entity refs, paired
document/revision evidence, optional motivating ledger event), and
provenance (who/what derived it and from which outcomes: a 'derived' lesson
names its outcomes, a 'human' lesson names none). Tags, links, and
derived-from ids are canonically ordered. Lessons are DATA: the store
serves them; nothing in this package branches on lesson content — applying
a lesson is explicit downstream code.

## Similarity semantics (exposed composition, no black boxes)

`projectFeatureVector({ outcome, subgraph? })` derives one project's typed
feature vector from its recorded outcome (+ optionally its
authorization-filtered relationship subgraph, whose edge/node density
becomes the 'relationship-density' feature). Features the outcome lacks are
absent — never invented. `rankSimilarProjects(subject, candidates, query)`
ranks candidates deterministically (score descending, then project id
ascending; the candidate array's order never matters). Every candidate
carries its EXPOSED score composition: one attributable component per
SHARED feature — both compared values, the carried weight, and the exact
per-feature similarity `max(|a|,|b|) / (max(|a|,|b|) + |a−b|)` — plus the
exact total score `Σ(weight × similarity) / Σweight` and the attributed
skips (`missingKinds`) for features present on only one side. Weights are
validated fail-closed (declared kinds only, integers 1..100, at most one
per kind).

## The rebuildable-projection discipline (A2/A7)

`projectMemory(events)` folds the recorded memory events
(`intelligence.outcomeRecorded` / `intelligence.benchmarkComputed` /
`intelligence.lessonCaptured`) into the memory store: the served outcomes,
lessons, and benchmark snapshots, in canonical id order, with read-only
lookup helpers and the fold's own derivation audit trail (what was
projected, what was recognized, what was skipped + tallied). THE
discipline, test-proven in `src/store.test.ts`:

- **the store is a pure function of its input events** — folding the same
  stream twice yields the identical store;
- **tampering never propagates into a rebuild** — editing the served
  content (a margin number, a benchmark's producing ids) lands in the
  projection, but folding the same events from scratch yields the pristine
  store again: the event stream is the only source;
- **projections never become canonical truth** — every served record
  carries its derivation provenance (engine, schema version, recorded-at,
  actor, scope, evidence spine);
- **unknown event names are skipped and tallied** deterministically (every
  domain event and margin assessment event riding the stream is a
  DERIVATION input, not a store input); a RECOGNIZED event name with a
  malformed payload fails closed;
- **immutable facts** — one outcome per project, idempotent redelivery,
  conflicting re-record typed-rejected; benchmark snapshots that drifted
  from their outcome set typed-rejected at fold time.

## Authorization (A12, before queries)

Memory reads are permissioned, deny-by-default, enforced BEFORE any store
access (`src/authorization.test.ts` proves the ordering with a
poisoned-store probe): (1) the capability gate — the requesting context
must hold contracts.read AND cost.read AND schedule.read; (2) structural
scope coverage — every served record must live inside the caller's
tenant/project scope, and a foreign project's outcome is a typed not-found
IDENTICAL to an absent one (no existence oracle, both directions); (3) the
policy gate — explicit deny wins, first allow grants, otherwise deny.
Denied records are excluded from set queries, never silently served.

## Memory events (the derived stream)

Every recorded outcome, computed benchmark snapshot, and captured lesson
emits exactly ONE `DomainEventEnvelope` through the `MemoryEventSink` port
(`appendEvents(executor, events)` inside the caller's transaction — the
landed EventSink shape). The outcome event is CAUSED BY the terminal
assessed change event (A3 causality, correlation carried over) with its
entity ref pointing at the completed project; the benchmark and lesson
envelopes take caller-supplied causality. The payloads are JSON-safe and
round-trip through the fail-closed parsers back into the EXACT typed
records — the fold's rebuild path.

## Test wiring

The suite is discovered by the ROOT vitest config
(`packages/intelligence/*/src/**/*.test.ts` — widened with OFF-013; no
config change was needed for this work item):

```
pnpm test                                   # the whole repo suite
pnpm exec vitest run packages/intelligence/memory   # this package only
```

`src/boundary.test.ts` (the no-opaque-AI gate), `src/outcome.test.ts` +
`src/benchmark.test.ts` (the named acceptance), `src/store.test.ts` (the
rebuild/tamper discipline), `src/similarity.test.ts` (the exposed score
composition), `src/authorization.test.ts` (A12 both directions, gates
before queries), `src/events.test.ts` (the sink port + payload
round-trips), `src/lesson.test.ts`, `src/model.test.ts`, and
`src/discovery.test.ts`. The golden completed-project scenarios in
`src/test-support.ts` run through the REAL landed engines
(ledger-shaped streams → relationship traversal → margin facts +
assessments) with a fixed clock, fixed ids, and fixed correlation tokens —
no `Date.now`, no `Math.random`, no environment.
