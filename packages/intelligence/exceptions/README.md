# @office/intelligence-exceptions

Office exception and control-tower engine (OFF-019) — the portfolio control
tower of the intelligence layer: deterministic detection of ACTIONABLE
portfolio exceptions over the intelligence peers' outputs, STABLE seeded
prioritization with EXPOSED score composition, evidence-chained severity and
economic impact, and SUGGESTED next actions only.

THE discipline: exceptions are PROJECTIONS of the peers' outputs (freeze
A2/A7) — the margin engine's `ImpactAssessment` values, the relationship
engine's authorization-filtered traversal subgraphs, and the memory engine's
benchmark facts go in, the portfolio exception set comes out. Detection and
ranking are PURE typed computation: no AI/LLM/network of any kind, no clock,
no randomness (the scan identity and clock are injected), no floats (every
score is an exact rational attributed to named source events, assessments,
and benchmarks — freeze A4). The control tower NEVER executes anything: it
suggests typed command references that the OFF-017 action gateway resolves
when a human/agent/app proposes them.

## Dependencies (the dependency rule)

Workspace dependencies only — exactly seven, mirroring the landed
intelligence packages:

- `@office/intelligence-relationships` — the authorization-filtered
  traversal subgraphs the dependency-risk rule computes over;
- `@office/intelligence-margin` — the `ImpactAssessment` values (the economic
  numbers every rule computes over) + `AssessmentId`/`CurrencyCode`;
- `@office/intelligence-memory` — the benchmark facts that calibrate
  severity + the exact-`Rational` shape;
- `@office/contracts` — `DomainEventEnvelope`, `EntityRef`, `CommandName`,
  parse helpers;
- `@office/domain-kernel` — `Result`/`DomainError` + deterministic idioms;
- `@office/authz` — deny-by-default authorization (exception scans and
  reads are permissioned);
- `@office/events` — `LedgerEventId` identity (the read surface; this
  package never writes the ledger — exception events are emitted through
  the mirrored `ExceptionEventSink` port inside the caller's transaction).

No external dependencies of ANY kind; no domain/adapters/workflows/sync/
actions/client-sync/agents packages; no AI/LLM/network dependency anywhere
(`src/boundary.test.ts` proves it by scanning the package).

## Public surface (src/index.ts — the whole surface)

Later Office modules (OFF-030 views, OFF-033 agent runtime, OFF-035 chips)
consume the package only through its root entry point:

- **vocabulary** — `EXCEPTION_DETECTED_EVENT`
  (`intelligence.exceptionDetected`), the closed `EXCEPTION_KINDS` vocabulary
  + parse/is helpers, the typed `SEVERITY_LEVELS` scale + parse/is helpers,
  the `EXCEPTION_ID`/`SCAN_ID` grammars + parse/is helpers,
  `EXCEPTION_REQUIRED_CAPABILITIES` (contracts.read + cost.read +
  schedule.read — the three bounded contexts an exception spans).
- **model** — `Exception` (kind, affected entity refs, typed severity with
  machine-readable reasons, economic impact with its producing assessment
  ids, the full evidence chain, detection provenance, primary source),
  evidence sources (`ExceptionEventSource`/`ExceptionAssessmentSource`/
  `ExceptionBenchmarkSource`) + the canonical evidence order, the local
  exact-`Rational` arithmetic (add/multiply/min/compare/reduce — every
  priority score is an integer-numerator/positive-integer-denominator pair),
  `PriorityWeights` (+ `DEFAULT_PRIORITY_WEIGHTS`, `PRIORITY_FORMULA`,
  `severityRankOf`), `PriorityScore` (+ the attributable severity and
  economic `ScoreComponent`s), `RankedException`, `NextAction`
  (+ confidence + `ActionCommandReference`, the eight suggested command
  constants), `EXCEPTION_SCHEMA_VERSION`, `EXCEPTIONS_ENGINE`.
- **scan** — `detectExceptions` (THE deterministic detection pass) +
  `ExceptionScanInputs`/`ScanParts` and the typed threshold tables
  (`SCHEDULE_SLIP_THRESHOLDS_DAYS`, `ECONOMIC_SHARE_THRESHOLDS`,
  `DEPENDENCY_THRESHOLDS_COUNT`, `SCHEDULE_SLIP_MIN_DAYS`).
- **rank** — `rankExceptions` (THE deterministic seeded prioritization) +
  `compareRankedPriority`.
- **next-actions** — `suggestNextActions` (SUGGESTIONS ONLY — the package
  has no execution surface at all).
- **authorization** — `ExceptionAuthorization`,
  `checkExceptionCapabilities`, `checkExceptionScopeCovers`,
  `checkExceptionPolicy`, `exceptionResource`, `exceptionNotFound`,
  `queryExceptions`, `queryExceptionById`.
- **events** — `exceptionDetectedEnvelope`, `emitExceptionDetected`, the
  `ExceptionEventSink` port (+ `ExceptionSinkExecutor`, the in-memory and
  failing sinks), `EXCEPTION_DETECTED_PAYLOAD_GRAMMAR`.

`src/test-support.ts` and `src/scenarios.ts` are package-INTERNAL (the
deterministic envelope factories + the golden seeded control-tower
scenarios) — not part of the surface.

## The exception vocabulary

Five closed kinds — the actionable portfolio conditions the control tower
detects (nothing else can be an exception):

| kind | fires when | money at stake |
| --- | --- | --- |
| `schedule-slip` | an assessment's forecast moves the program by ≥ 1 day | null (severity ranks it) |
| `cost-overrun` | projected or committed cost exceeds the contracted value | the overrun delta |
| `entitlement-exposure` | submitted-but-undecided change order value is pending | the pending value |
| `dependency-risk` | a slipped activity gates downstream work through recorded dependencies | null |
| `evidence-gap` | the producing assessment itself carries low confidence | null |

Severity is the typed four-level scale (`minor`/`moderate`/`major`/
`critical`), computed from the rule's typed thresholds and calibrated by the
memory benchmarks: a schedule slip beyond the benchmarked p90
schedule-variance-days escalates one level (`benchmark-beyond-percentile90`);
a margin ratio below the benchmarked minimum escalates one level
(`benchmark-below-minimum`). Every level carries its deterministic
machine-readable reasons — never an opaque score.

## Scan semantics (determinism, A12, policy)

`detectExceptions(inputs, authorization, parts)` runs the five rules over
(assessments + subgraphs + benchmarks) in a FIXED gate order:

1. the CAPABILITY gate — the requesting context must hold contracts.read
   AND cost.read AND schedule.read BEFORE any input is read (the
   poisoned-input probe proves the ordering);
2. STRUCTURAL scope coverage of every input (freeze A12) — assessments,
   subgraph nodes, and benchmarks outside the caller's scope are
   typed-rejected BEFORE any detection, in both directions, and the
   rejection never reveals the foreign scope;
3. the POLICY gate — assessments and benchmarks the caller's policy denies
   are EXCLUDED (invisible, never errors; explicit deny wins, deny by
   default);
4. the five detection rules, each a pure function of one admitted
   assessment (+ its matched subgraph + the calibration benchmarks),
   emitting at most one exception per (rule, assessment) with its FULL
   evidence chain.

Exception ids are DERIVED from the injected scan identity
(`<scanId>#<ordinal>` in the canonical emission order: rule order, then
canonical assessment order) — deterministic without any id supplier beyond
the scan token itself. The same inputs + authorization + scan identity
ALWAYS produce the byte-identical exception set (run-twice + shuffled-input
determinism are the acceptance tests; the input array orders never matter
because every iteration order is canonical). Duplicate assessment ids are a
typed invariant violation (an input set is a set).

## Rank semantics (the named acceptance — stability + exposed composition)

`rankExceptions(exceptions, weights?)` composes the priority score over
EXACT RATIONALS with the composition EXPOSED on every ranked exception:

```
priority = severityWeight x severityRank(level) + economicWeight x min(1, economicImpact / economicScale)
```

- `severityRank` is the typed scale as an exact rational (minor 1/4,
  moderate 1/2, major 3/4, critical 1/1);
- the economic exposure is the money at stake over the caller-supplied SEED
  scale (`economicScale`), bounded at 1 — moneyless kinds contribute exactly
  0 and rank on severity alone, never on invented numbers;
- the default seed is severity 1/2, economic 1/2, scale 10,000,000 minor
  units (the reference amount of the portfolio being ranked).

Every ranked exception carries both attributable components — the weights,
the ranked level, the exact rank, the exposure, the amount + currency + THE
PRODUCING ASSESSMENT IDS, and both contributions — so the score is
recomputable by hand from the model alone (no black boxes). The ordering is
a TOTAL ORDER: total score desc → severity level desc → economic amount desc
(null last) → kind asc → first affected entity asc → exception id asc — so
it is stable by construction: the same set yields the identical order under
every run and every input permutation. Cross-currency sets are
typed-rejected (no FX invention — rank per currency or supply converted
assessments); duplicate exception ids are typed-rejected; invalid seeds
(negative weights, weights summing to zero, non-positive scale) are
typed-rejected fail-closed.

## Evidence chains (A4 — every claim resolves)

Every exception's evidence chain is the deduplicated, canonically ordered
set of discriminated source references that PRODUCED its claims: the
`contracts.changeEventRaised` event the assessment assessed, the producing
`ImpactAssessment` id, the driver events behind every schedule delta and
margin layer, the submission/decision events behind every entitlement
order, the `depends-on` provenance events behind every gated dependency,
and the calibration benchmark id when a benchmark escalated the severity.
The golden tests prove resolution end to end: every event reference resolves
to a ledger event id of the producing scenario's stream, every assessment
reference resolves to the scan's input assessment ids, every benchmark
reference resolves to the scan's benchmark input — and the primary source
anchor (the A3 causation id of the emitted event) is the producing
`changeEventRaised` event's ledger id.

## NextActions (SUGGESTIONS ONLY)

`suggestNextActions(exception)` maps each kind deterministically into typed
command references over the OFF-017 gateway's own command vocabulary (the
engine invents no command names): schedule slips suggest
`schedule.recordProgress` + `schedule.setBaseline`; cost overruns suggest
`cost.reviseBudget` + `contracts.submitChangeOrder`; entitlement exposure
surfaces BOTH decisions (`contracts.approveChangeOrder` +
`contracts.rejectChangeOrder` — the control tower never decides);
dependency risk suggests `schedule.updateActivity`; evidence gaps suggest
`contracts.linkChangeReferences`. Every suggestion carries its scope, its
deterministic rationale, a typed confidence (level + machine-readable
reasons derivable from the exception's own evidence chain), and the
justifying evidence subset. The payload carries ONLY deterministic
reference fields (entity ids) — aggregate versions, actors, idempotency
keys, and approvals are supplied by the PROPOSING caller at proposal time.
This package has NO execution path: the boundary test proves structurally
that no dispatch/execute surface exists anywhere in the engine.

## Authorization (A12, before scans and queries)

Exception scans and reads are permissioned, deny-by-default, enforced
BEFORE any input is read or any record is served (`src/authorization.test.ts`
+ `src/scan.test.ts` prove the ordering with poisoned probes): (1) the
capability gate — contracts.read AND cost.read AND schedule.read; (2)
structural scope coverage — cross-scope scan INPUTS are typed-rejected
(they are the caller's own wiring error), while a foreign exception is
INVISIBLE to queries: a typed not-found IDENTICAL to an absent one (no
existence oracle, both directions); (3) the policy gate — explicit deny
wins, first allow grants, otherwise deny; denied records are excluded from
set queries, never silently served.

## Exception events (the derived stream)

Every detected exception emits exactly ONE `intelligence.exceptionDetected`
`DomainEventEnvelope` through the `ExceptionEventSink` port
(`appendEvents(executor, events)` inside the caller's transaction — the
landed EventSink shape). The event is CAUSED BY the exception's primary
producing event (A3: the `contracts.changeEventRaised` ledger id, with the
source's correlation id carried over), is sourced `system` (machine-
generated intelligence — never `domain`, never an adapter), and carries the
JSON-safe control-tower summary: the exception's kind, severity, economic
impact, every evidence id (split by event/assessment/benchmark), and the
suggested next actions' command references — data only, never an execution.

## Test wiring

The suite is discovered by the ROOT vitest config
(`packages/intelligence/*/src/**/*.test.ts` — widened with OFF-013; no
config change was needed for this work item):

```
pnpm test                                            # the whole repo suite
pnpm exec vitest run packages/intelligence/exceptions   # this package only
```

`src/boundary.test.ts` (the no-AI/no-network/no-forbidden-import gate),
`src/vocabulary.test.ts` + `src/model.test.ts` (fail-closed parsing +
the exact-rational/evidence/model contracts), `src/scan.test.ts`
(gate ordering, A12 rejections, policy exclusion, determinism, injected
identity), `src/rank.test.ts` (exposed composition, total order,
permutation stability, fail-closed rejections), `src/golden.test.ts` (THE
named acceptance — the golden seeded portfolio's stable ordering + evidence
resolution), `src/authorization.test.ts` (A12 both directions, poisoned-set
probes, policy), `src/next-actions.test.ts` (typed suggestions, no
execution surface), and `src/exception-events.test.ts` (the envelope shape +
the sink port) make up the suite. Everything is deterministic: fixed ids,
fixed clock, fixed correlation/causation tokens — no `Date.now`, no
`Math.random`, no environment.
