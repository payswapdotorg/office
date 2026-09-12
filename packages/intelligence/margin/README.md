# @office/intelligence-margin

The commercial **margin and impact engine** (OFF-014): deterministic
cost / schedule / entitlement / margin impact calculations that consume the
relationship engine's authorization-filtered traversals plus the commercial
facts folded from the landed domain packages' recorded event envelopes.
Every assessment is a versioned `ImpactAssessment` carrying the exact
**source event ids** that produced every number (freeze A4
evidence/provenance) — traceability is real, not decorative: mutating or
removing a source event changes the assessment.

The engine is a **read-side intelligence projection, never a second source
of truth** (freeze A2/A7): the facts fold is derived from the event ledger,
rebuildable at any time, and holds ids/refs/integer money/durations only —
never entity data. This package never writes the ledger; assessments are
emitted through a mirrored `AssessmentEventSink` port inside the caller's
transaction.

## Dependencies (the dependency rule)

Workspace dependencies only — `@office/intelligence-relationships` (the ONE
intelligence peer: the relationship index + traversal subgraphs the
calculations consume), `@office/contracts` (envelope + identity contracts +
parse helpers), `@office/domain-kernel` (`Result`/`DomainError`),
`@office/authz` (deny-by-default assessment access + structural scope
isolation), and `@office/events` (the ledger READ surface + deterministic
ledger event id derivation). The domain packages (organization/projects/
documents/field/schedule/cost/contracts) are **never imported**: their event
*shapes* are consumed through typed facts folded from `@office/contracts`
envelope payloads. Two documented local structural types mirror otherwise
unimportable shapes — `CurrencyCode`/money minor units (the domain value
object's shape) and `AssessmentSinkExecutor` (the persistence `SqlExecutor`
query surface the sink port hands over). No external dependencies.

## Public surface (src/index.ts — the whole surface)

- **model** — `ImpactAssessment` (the versioned claim), `ImpactQuery`
  (+ fail-closed `parseImpactQuery`), `ImpactInputs` (facts + subgraph),
  `SourceEventReference`, `ChangeEventSource`, `CostImpact`/`CostItemDelta`,
  `ScheduleImpact`/`ActivityForecastDelta`, `EntitlementPosition`/
  `ChangeOrderEntitlement`, `MarginPosition`/`MarginLayer`,
  `AssessmentConfidence` (+ levels/reasons), `AssessmentPolicyContext`,
  `ASSESSMENT_SCHEMA_VERSION`, `ASSESSMENT_ENGINE`,
  `canonicalEvidence`/`compareSourceEventReferences`, `parseCurrencyCode`,
  and the entity-kind constants the impact links reference.
- **facts** — `projectCommercialFacts(events)`: the deterministic,
  rebuildable commercial fold, plus every fact type
  (`CommercialFacts`, `ChangeEventFact`, `ChangeOrderFact`, `CommitmentFact`,
  `ActivityFact`, `DependencyFact`, …), each carrying its producing event.
- **calculation** — `calculateImpact(query, inputs, authorization, parts)`:
  THE pure, deterministic function; `AssessmentParts` (the injected
  assessment identity + clock).
- **authorization** — `AssessmentAuthorization`, the three gates
  (`checkAssessmentCapabilities`, `checkAssessmentScopeCovers`,
  `checkAssessmentPolicy`) and the typed rejections
  (`crossScopeInputRejection`, `sourceEventNotFound`).
- **events** — `marginAssessmentEnvelope(assessment)`,
  `emitMarginAssessment(sink, executor, assessment)`, the
  `AssessmentEventSink` port (+ in-memory test sink), `MARGIN_ASSESSED_EVENT`.

`src/test-support.ts` and `src/scenarios.ts` are package-internal test
modules (deterministic envelope factories and the golden fixtures).

## The calculation contract

`calculateImpact` is a pure function of its inputs — same inputs → the
byte-identical assessment (run-twice and shuffled-inputs determinism are the
acceptance tests); no clock, no randomness, no environment; the assessment
identity and `assessedAt` are injected by the caller. The order of operations
is part of the contract:

1. **Capability gate** (deny-by-default): an assessment spans three bounded
   contexts at once, so the requesting context must hold `contracts.read`
   AND `cost.read` AND `schedule.read` *before a single input is read*. A
   missing capability is a typed `forbidden` naming exactly what is missing.
2. **Source lookup + structural A12 scope coverage**: the assessed
   `contracts.changeEventRaised` ledger event is looked up in the folded
   facts; a foreign-scope source is a typed `not-found` **identical** to an
   absent one (no existence oracle).
3. **Cross-scope input rejection**: every input fact's and subgraph node's
   scope must be covered by the caller's execution scope — mixed-scope
   inputs are typed-rejected before any calculation (the caller's own wiring
   error, never a probe).
4. **Policy gate** over the assessed change event as the resource (explicit
   deny wins; first allow grants; otherwise deny).
5. **The calculation** — cost, schedule, entitlement, margin, confidence —
   every number carrying its source event ids.

The **cost impact** is the budget-side response to the change: cost items
recorded *after* the source change event on the impacted budgets (the
subgraph's `impacts` edges), each delta carrying its `cost.costItemRecorded`
event, plus the anchoring `cost.budgetRevised` events. The **schedule
impact** is the forecast delta over the recorded network: a local
deterministic CPM forward pass (topological order, smallest-id tie-break;
cycles fail closed) over calendar-free integer day offsets, computed twice —
as of the source change event's ledger position (pre) and at the end of the
stream (current) — with each impacted activity's delta carrying the
post-change assertions (duration updates, progress records, dependency
add/remove) that touched it, plus the recorded baselines as the forecast
basis anchors. The **entitlement impact** is the position of the change
orders derived from the change event (the subgraph's `derives-from` edges):
each order's value, latest decision, and referenced claims. The **margin
position** aggregates contracted value (contract + approved/executed order
values), committed cost (the impacted budgets' latest commitment
assertions), budgeted cost (the current revision's item set), and projected
cost (committed + post-change budget additions + pending order exposure),
with evidence references at **every layer**.

**A4 provenance** rides on every assessment: evidence references (the
complete deduplicated, canonically ordered source event set), source
identity (the engine name + the assessed change event's own ledger id,
entity, scope, correlation), injected timestamps (`assessedAt` from the
caller — never wall time), the deterministic confidence (derived from
data-completeness reason codes: `isolated-change-event`, …,
`complete-inputs`), and the policy context (capabilities held/required, the
caller's policy digest, the allow decision).

## Source-event traceability (the named acceptance)

Every number of an assessment is produced by exactly the source events its
`SourceEventReference`s name: item deltas cite their `cost.costItemRecorded`
event, revision anchors their `cost.budgetRevised` event, entitlement
positions their submission/decision events, schedule deltas their
`activityUpdated`/`progressRecorded`/dependency events, and every margin
layer its full evidence set. The assessment's top-level `evidence` is the
deduplicated union. Mutating a source event's payload changes the numbers;
removing the event removes the number *and* its evidence id — the tests
prove both directions for every golden scenario.

## Assessment events (A3/A4 downstream)

Each assessment emits exactly one `intelligence.marginAssessed`
`DomainEventEnvelope` through the `AssessmentEventSink` port
(`appendEvents(executor, events)` inside the caller's transaction — the
mirrored landed domain EventSink shape; a failure aborts the surrounding
write). The envelope is **caused by** the source change event (causation id
= its ledger id, correlation carried over), produced under the `system`
source by the requesting actor, with the entity refs pointing at the
assessed change event and a JSON-safe payload summary (every number keeping
its source event ids) that OFF-015 (memory) and OFF-018 (recommendations)
consume like any other domain event.

## The golden scenarios (src/scenarios.ts)

Four deterministic fixtures, each appending a ledger-shaped stream with
fixed ids/clock/correlation tokens and returning the named ledger events the
traceability assertions cite:

| scenario    | stream | proves |
| ----------- | ------ | ----- |
| **cost**        | contract (12.5M) → budget + cost item (10.2M) + commitment (8M) → change event impacting the budget/item → post-change revision + item (1.5M) → change order (4.5M) submitted and approved | the budget-revision delta → margin chain; dropping the approval flips the position to pending (negative margin); mutating/removing the item moves the numbers and the evidence |
| **schedule**    | schedule with A1(5)→A2(4)→A3(3) (FS, lag 0/2), baseline, contract, change event impacting A2+A3 → post-change duration update (A2→7) and progress (A3: 50%, remaining 2) | forecast deltas via the recorded network (project 14→16 days; A2 +3 EF, A3 +3 ES/+2 EF); dropping either driver shrinks the delta and drops the confidence to medium |
| **entitlement** | evidence document + revision (skipped by the fold), contract, change event, three orders (approved 4.5M / rejected 2M / pending 1M) and a claim reference against the approved one | the entitled-with-exposure position with per-order decision sources and claim evidence; removing the rejection moves its value to pending |
| **margin**      | the cost scenario's layers plus a second commitment (0.5M), an amendment (6M→7.5M), and an invoice the fold skips deterministically | contracted − committed − budgeted − projected with evidence at every layer; dropping the amendment changes the committed layer's amount *and* its evidence ids |

## Test wiring

The suite lives in `src/*.test.ts` (scenarios, determinism, authorization,
assessment-events, facts, model) and runs under the **root** `pnpm test`
like every workspace package: `pnpm-workspace.yaml` lists
`packages/intelligence/*` and the root `vitest.config.ts` includes
`packages/intelligence/*/src/**/*.test.ts` (the additive widening OFF-013
landed). A local `vitest.config.ts` remains as a standalone single-package
runner:

```
pnpm exec vitest run -c packages/intelligence/margin/vitest.config.ts
```

The tests are deterministic (fixed clock, fixed ids, fixed
correlation/causation tokens, injected assessment identity/clock — no
`Date.now`, no `Math.random`) and prove the acceptance gates: the four
golden scenarios with exact source event ids (mutated/removed variants
change the assessment), run-twice and shuffled-inputs determinism (reversed
subgraph arrays; the same events re-appended in a different chain-preserving
order), A12 (missing-capability/policy denials before any calculation —
proven against inputs whose calculation would fail closed; foreign source
events indistinguishable from absent ones; cross-scope inputs
typed-rejected without leaking the foreign identity), and the assessment
event envelope/sink port shape.
