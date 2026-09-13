# @office/intelligence-procurement

Office procurement optimization engine (OFF-034) — the intelligence layer's
vendor/procurement optimizer: typed price / delivery / vendor-performance /
risk comparison contracts over the cost domain's canonical
commitment/invoice model and the intelligence peers' outputs, with
evidence-backed recommendations that ALWAYS carry their historical basis
(referenced outcome/benchmark facts) and their projected economic impact
(referenced assessment values with the composition exposed and
hand-recomputable), deterministic STABLE seeded ranking with EXPOSED
exact-rational score composition, and SUGGESTED next actions only — there
is structurally no path that issues a command, mutates canonical state, or
auto-commits a procurement decision.

THE discipline: recommendations are PROJECTIONS of the cost model + the
peers' outputs (freeze A2/A7) — `@office/domain-cost`'s typed READ surface
(the canonical commitment/invoice model, consumed through its derived reads
only — never its transitions or commands), the margin engine's
`ImpactAssessment` values (the projected economic impact basis — CITED
producing numbers, never re-derived), and the memory engine's outcome
records and benchmark facts (the historical basis) go in, the typed
`ProcurementRecommendation` set comes out. Comparison and ranking are PURE
typed computation: no AI/LLM/network of any kind, no clock, no randomness
(the scan identity and clock are injected), no floats (every preference
score is an exact rational attributed to named source records, events,
assessments, outcomes, and benchmarks — freeze A4), and NO manual scores
(anywhere a rating appears it DERIVES from referenced records). The engine
NEVER commits: it PROPOSES typed `ProposedNextAction` records that the
OFF-017 action gateway resolves when a human/agent/app proposes them, and
commitment without an explicit policy decision is a typed rejection
(freeze A8).

## Dependencies (the dependency rule)

Workspace dependencies only — exactly seven, mirroring the landed
intelligence packages:

- `@office/domain-cost` — the canonical commitment/invoice model, the
  engine's typed READ surface (derived reads `budgetBasisOf` /
  `committedAmountMinorOf` / `currentLineSetOf` + the typed limits — never
  a command, transition, store, or sink; only the internal golden fixtures
  build fixture states through the domain package's own pure state
  constructors);
- `@office/intelligence-margin` — the `ImpactAssessment` values (the
  projected economic impact basis every recommendation cites — referenced,
  never re-derived) + `AssessmentId`/`CurrencyCode`;
- `@office/intelligence-memory` — the `OutcomeRecord`/`Benchmark` facts
  (the historical basis the vendor-performance ratings and the timing
  calibration derive from) + the exact-`Rational` shape;
- `@office/agents` — the `EvidenceSet` TYPE discipline (type-only: every
  recommendation carries a complete, qualified agents-typed evidence set);
- `@office/contracts` — `DomainEventEnvelope`, `EntityRef`, `CommandName`,
  parse helpers;
- `@office/domain-kernel` — `Result`/`DomainError` + deterministic idioms;
- `@office/authz` — deny-by-default authorization (procurement scans and
  reads are permissioned).

No external dependencies of ANY kind; no other domain package
(contracts/schedule/field/organization/projects/documents), no
sync/client-sync/adapters/app-sdk/app-runtime/marketplace/security/
persistence/actions/events imports, no AI/LLM/network dependency anywhere
(`src/boundary.test.ts` proves it by scanning the package).

## Public surface (src/index.ts — the whole surface)

Later Office modules (OFF-037 end-to-end integration, OFF-040 analytics)
consume the package only through its root entry point:

- **vocabulary** — `PROCUREMENT_RECOMMENDATION_PROPOSED_EVENT`
  (`intelligence.procurementProposed`), the closed `PROCUREMENT_KINDS`
  vocabulary (vendor-switch / order-splitting / timing-shift) + parse/is
  helpers, the typed `VENDOR_PERFORMANCE_LEVELS` scale (unrated /
  underperforming / acceptable / strong) + parse/is helpers, the
  `VENDOR_KEY`/`PROCUREMENT_SCAN_ID`/`ALTERNATIVE_ID`/`RECOMMENDATION_ID`/
  `COMPARISON_ID` grammars + parse/is helpers, `parseAlternativeOutcomeIds`,
  `PROCUREMENT_REQUIRED_CAPABILITIES` (contracts.read + cost.read +
  schedule.read — the three bounded contexts a procurement scan spans).
- **model** — the evidence chain sources (`ProcurementRecordSource`/
  `ProcurementEventSource`/`ProcurementAssessmentSource`/
  `ProcurementOutcomeSource`/`ProcurementBenchmarkSource`) + the canonical
  evidence order, the local exact-`Rational` arithmetic
  (add/multiply/min/compare/reduce — every preference score is an
  integer-numerator/positive-integer-denominator pair),
  `PriceComparison`/`DeliveryComparison` (the normalized comparable amount
  + the lead-time gain), `VendorPerformanceRating` (+ machine-readable
  reasons + THE REFERENCED OUTCOME IDS), `ProcurementRiskFactor` (+ the
  closed four-kind risk vocabulary), `ProcurementEconomicImpact` (+ the
  typed `EconomicCitation`/`EconomicComponentRole` vocabulary + the
  exposed component composition), `ProcurementHistoricalBasis` (+ benchmark
  facts), `PreferenceWeights` (+ `DEFAULT_PREFERENCE_WEIGHTS`,
  `PREFERENCE_FORMULA`, `PREFERENCE_WEIGHTS_GRAMMAR`), `PreferenceScore`
  (+ the attributable economic and delivery `ScoreComponent`s),
  `ProposedNextAction` (+ confidence + `ActionCommandReference` +
  `ProcurementPolicyDecision`, the three suggested command constants), the
  entity-kind constants, `compareReferencedRecords`.
- **comparison** — `ProcurementAlternative` (+ the fail-closed
  `parseProcurementAlternative` — the honest input path exactly as a host
  would supply quotes), `normalizedAmountMinorOf`, the typed comparison
  limits (`LEAD_TIME_DAYS_MAX`, `PERFORMANCE_STRONG_SHARE` 2/3,
  `PERFORMANCE_ACCEPTABLE_SHARE` 1/3), `vendorPerformanceOf` (THE
  outcome-derived rating), `ProcurementNeed` + `procurementNeedsOf` (the
  incumbent position a comparison measures), `VendorComparison`
  (+ `VendorComparisonRow`/`VendorComparisonRowRisk` — THE four-dimension
  comparison contract), `COMPARISON_SCHEMA_VERSION`, `PROCUREMENT_ENGINE`,
  `buildVendorComparison`.
- **recommendation** — `ProcurementRecommendation` (THE record),
  `SelectedAlternative`, `DetectionProvenance`, `ProcurementPrimarySource`,
  `RECOMMENDATION_SCHEMA_VERSION`, `detectProcurementRecommendations` (THE
  deterministic detection pass) + `ProcurementScanInputs`/`ScanParts`, the
  typed threshold tables (`SWITCH_MIN_SAVING_SHARE` 1/40,
  `TIMING_MIN_LEAD_GAIN_DAYS` 10, `TIMING_MIN_ASSESSED_DELAY_DAYS` 1), and
  `qualifyProcurementEvidenceSet` (THE A4 gate).
- **ranking** — `rankProcurementRecommendations` (THE deterministic seeded
  prioritization) + `compareRankedPreference` + `leadGainDaysOf`.
- **proposal** — `proposeNextActions` (SUGGESTIONS ONLY) +
  `commitProcurementDecision` (THE policy-gated commitment — a typed
  rejection without an explicit policy decision, a ProposedNextAction
  record with one).
- **authorization** — `ProcurementAuthorization`,
  `checkProcurementCapabilities`, `checkProcurementScopeCovers`,
  `checkProcurementPolicy`, `procurementResource`,
  `procurementRecommendationNotFound`, `queryProcurementRecommendations`,
  `queryProcurementRecommendationById`, `ProcurementQuery`.
- **audit** — `procurementRecommendationProposedEnvelope`,
  `emitProcurementRecommendationProposed`, the `ProcurementEventSink` port
  (+ `ProcurementSinkExecutor`, the in-memory and failing sinks),
  `PROCUREMENT_PROPOSED_PAYLOAD_GRAMMAR`.

`src/test-support.ts` and `src/scenarios.ts` are package-INTERNAL (the
deterministic typed factories + the golden seeded procurement scenarios) —
not part of the surface.

## The procurement vocabulary

Three closed kinds — the optimization conditions the engine detects
(nothing else can be a recommendation):

| kind | fires when | threshold |
| --- | --- | --- |
| `vendor-switch` | a challenger quote undercuts the incumbent path by a material share | saving share >= `SWITCH_MIN_SAVING_SHARE` 1/40 (below it the switch is noise) |
| `order-splitting` | a multi-vendor composition covers the need's scope for less than the incumbent path | must undercut the incumbent path AND span more than one vendor (a same-vendor accumulation is not a split) |
| `timing-shift` | a faster quote pays a price premium yet still undercuts the incumbent path while avoiding an assessed program delay | lead-time gain >= `TIMING_MIN_LEAD_GAIN_DAYS` 10 days AND assessed schedule-impact delta >= `TIMING_MIN_ASSESSED_DELAY_DAYS` 1 day |

A price-driven challenger is ALWAYS a vendor switch, never a timing shift
(the kind precedence rule).

## The comparison contracts (four dimensions, every row)

`buildVendorComparison` compares every admitted need's quoted alternatives
against the incumbent position on FOUR typed dimensions, each row carrying
its own derivation basis:

- **price** — the normalized comparable amount (the exact quantity ×
  unit-rate extension, normalized through the cost domain's own typed
  limits — `normalizedAmountMinorOf`);
- **delivery** — the quoted lead time against the incumbent vendor's OWN
  current re-quote lead time, with the signed `leadGainDays`;
- **vendor-performance** — the rating DERIVED from the vendor's referenced
  memory outcome records: the on-time share (schedule variance <= 0 days)
  of the completed-project history, mapped through the exposed thresholds
  (share >= 2/3 `strong`, >= 1/3 `acceptable`, else `underperforming`, no
  referenced outcomes `unrated`) — the rating cites exactly the outcome ids
  it derived from, never a manual score;
- **risk** — the typed risk factors of the selection, drawn from the
  closed four-kind vocabulary (`single-source-concentration`,
  `price-above-budget-basis`, `underperforming-vendor-history`,
  `no-vendor-history`), each carrying its deterministic derivation basis
  (the referenced vendor, the referenced budget basis, the referenced
  history).

## Scan semantics (determinism, A12, policy)

`detectProcurementRecommendations(inputs, authorization, parts)` runs the
three rules over (the cost-domain records + quoted alternatives +
assessments + outcomes + benchmarks) in a FIXED gate order:

1. the CAPABILITY gate — the requesting context must hold contracts.read
   AND cost.read AND schedule.read BEFORE any input is read (the
   poisoned-input probe proves the ordering);
2. duplicate input identities are typed invariant violations (an input set
   is a set);
3. STRUCTURAL scope coverage of every input (freeze A12) — budgets,
   commitments, alternatives, assessments, outcomes, and benchmarks outside
   the caller's execution scope are typed-rejected BEFORE any comparison,
   in both directions, and the rejection never reveals the foreign scope;
4. the POLICY gate — records the caller's policy denies are EXCLUDED
   (invisible, never errors; explicit deny wins, deny by default);
5. the structural wiring — an alternative naming an unknown incumbent
   commitment, quoting a currency the addressed budget does not carry,
   referencing a vendor-history outcome outside the input set, or a need
   carrying more than one incumbent vendor re-quote is a typed fail-closed
   rejection (never a silent drop);
6. the three detection rules over the canonical need order, each emitting
   at most one recommendation per (rule, need) with its FULL evidence
   chain, and every emitted recommendation's EvidenceSet must qualify (the
   agents discipline — an empty or out-of-scope set is a typed rejection).

Comparison and recommendation ids are DERIVED from the injected scan
identity (`<scanId>#c<ordinal>` for comparisons, `<scanId>#<ordinal>` for
recommendations, in the canonical emission order: need order, then rule
order) — deterministic without any id supplier beyond the scan token
itself. The same inputs + authorization + scan identity ALWAYS produce the
byte-identical recommendation set (run-twice + shuffled-input determinism
are the acceptance tests; every iteration order is canonical, so the input
array orders never matter).

## Rank semantics (stability + exposed composition)

`rankProcurementRecommendations(recommendations, weights?)` composes the
preference score over EXACT RATIONALS with the composition EXPOSED on
every ranked recommendation:

```
preference = economicWeight x min(1, |projectedDelta| / economicScale) + deliveryWeight x min(1, leadGainDays / deliveryScaleDays)
```

- the economic exposure is the recommendation's OWN projected delta over
  the caller-supplied SEED scale (`economicScale`), bounded at 1;
- the delivery exposure is the lead-time gain over the seed
  `deliveryScale` (days), bounded at 1;
- the default seed is economic 1/2, delivery 1/2, scale 10,000,000 minor
  units / 30 days.

Every ranked recommendation carries both attributable components — the
weights, both exposures, and both contributions — so the score is
recomputable by hand from the model alone (no black boxes). The ordering
is a TOTAL ORDER: total score desc → |projected delta| desc → lead-time
gain desc → kind asc (vendor-switch, order-splitting, timing-shift) →
first referenced record asc → recommendation id asc — so it is stable by
construction: the same set yields the identical order under every run and
every input permutation. Cross-currency sets are typed-rejected (no FX
invention — rank per currency or supply converted assessments); duplicate
recommendation ids are typed-rejected; invalid seeds (negative weights,
weights summing to zero, non-positive scales) are typed-rejected
fail-closed.

## Evidence chains (A4 — every claim resolves)

Every recommendation's evidence chain is the deduplicated, canonically
ordered set of discriminated source references that PRODUCED its claims:
the producing `ImpactAssessment` id, the `contracts.changeEventRaised`
event it assessed, the canonical cost-domain records it was detected over
(incumbent commitment + budget of record + basis cost item), the driver
evidence behind every cited number, the memory outcome records behind
every vendor-performance rating, and the calibration benchmark when a
benchmark gated the timing rule. The golden tests prove resolution END TO
END: every record reference resolves to a golden input record, every event
reference resolves to a ledger event id of the producing assessment's own
evidence, every assessment/outcome/benchmark reference resolves to the
scan inputs — and the primary source anchor (the A3 causation id of the
emitted event) is the producing `changeEventRaised` event's ledger id,
with the source's correlation id carried over. Every recommendation ALSO
carries the complete, qualified agents-typed `EvidenceSet` (the assessment
item + one item per historical outcome, each with its retrieval
provenance) — the empty or out-of-scope set is a typed rejection.

## THE historical basis + projected economic impact discipline

Every recommendation carries BOTH, always referenced — never invented:

- the **historical basis** (`ProcurementHistoricalBasis`) — the referenced
  memory outcome records behind the selection's vendor-performance ratings
  (each rating cites exactly the outcome ids it derived from) and the
  cited benchmark facts when a benchmark gated or calibrated the rule
  (completed-project history — referenced facts, never re-derived
  statistics);
- the **projected economic impact** (`ProcurementEconomicImpact`) — the
  projected committed-cost delta of adopting the recommended fulfillment
  against the incumbent path, composed of typed CITED components (the
  incumbent commitment's current amount released, the producing
  assessment's own budget-revision delta adjusted, and each selected
  alternative's normalized price engaged — the typed
  `commitment-current-amount` / `assessment-cost-impact-budget-revision-delta`
  / `alternative-normalized-price` citation vocabulary). The composition
  is EXPOSED and hand-recomputable: `sum(components) === projectedDeltaMinor`,
  and every assessment-cited component's amount equals the referenced
  assessment's OWN recorded value (referenced, never re-derived).

**The derived-rating discipline**: anywhere a rating appears — the
vendor-performance level, the risk factors, the preference score — it
DERIVES from referenced records with its basis exposed (the on-time share
as an exact rational over the referenced outcomes, the derivation reasons,
the attributable score components). There is no manual-score input
anywhere in the package's surface.

## THE suggestion-only discipline (no automatic procurement commitment)

`proposeNextActions(recommendation)` maps each kind deterministically into
typed command references over the OFF-017 gateway's own command
vocabulary (the engine invents no command names — the cost domain's
`cost.amendCommitment` / `cost.createCommitment` / `cost.closeCommitment`
names are derived once through `@office/contracts`' public
`parseCommandName` over the frozen literals): vendor switches suggest
re-baselining the incumbent then placing the switched commitment; order
splits suggest re-baselining the retained share then placing the split part
commitment; timing shifts suggest placing the early order (low confidence
+ human-decision-required — it is a human-approved spending decision) then
re-baselining the incumbent off the late path. Every suggestion carries
its scope, its deterministic rationale, a typed confidence (level +
machine-readable reasons derivable from the recommendation's own evidence
chain), and the justifying evidence subset. The payload carries ONLY
deterministic reference fields (entity ids) — aggregate versions, actors,
idempotency keys, and approvals are supplied by the PROPOSING caller at
proposal time.

`commitProcurementDecision(recommendation, decision)` is the ONLY
commitment-shaped surface, and it is structurally a proposal producer:
WITHOUT an explicit `ProcurementPolicyDecision` the commitment is a typed
rejection (freeze A8: procurement actions are approval-required); WITH one
it still only PROPOSES — the exit is a typed `ProposedNextAction` record
carrying the authorizing decision (A4: who decided, when, and why) so the
gateway and the audit trail can verify the approval chain. This package
has NO execution path: the structural no-auto-commitment proof
(`src/boundary.test.ts` + `src/golden.test.ts`) proves by scanning and
counting that no command envelope is ever constructed, no
dispatch/execute/commit surface exists anywhere, no mutation-shaped export
exists beyond the policy-gated commitment above, and the audit module's
only write path is the injected sink port.

## Authorization (A12, before scans and queries)

Procurement scans and reads are permissioned, deny-by-default, enforced
BEFORE any input is read or any record is served
(`src/authorization.test.ts` + `src/recommendation.test.ts` prove the
ordering with poisoned probes): (1) the capability gate —
contracts.read AND cost.read AND schedule.read; (2) structural scope
coverage — cross-scope scan INPUTS are typed-rejected (they are the
caller's own wiring error), while a foreign recommendation is INVISIBLE to
queries: a typed not-found IDENTICAL to an absent one (no existence
oracle, both directions); (3) the policy gate — explicit deny wins, first
allow grants, otherwise deny; denied records are excluded from set
queries, never silently served.

## Procurement events (the derived stream)

Every detected recommendation emits exactly ONE
`intelligence.procurementProposed` `DomainEventEnvelope` through the
`ProcurementEventSink` port (`appendEvents(executor, events)` inside the
caller's transaction — the landed EventSink shape, mirrored from the
intelligence peers). The event is CAUSED BY the recommendation's primary
producing event (A3: the `contracts.changeEventRaised` ledger id, with the
source's correlation id carried over), is sourced `system`
(machine-generated intelligence — never `domain`, never an adapter), and
carries the JSON-safe recommendation summary: the kind, the selected
alternatives with their normalized prices, the referenced canonical
records, the projected impact with its exposed component composition, the
evidence ids split by source kind, the evidence-set reference tokens, and
the proposed next actions' command references — data only, never an
execution.

## What OFF-037/OFF-040 consume

OFF-037 (the end-to-end construction reference scenario) consumes the
engine through this package's root entry point:
`detectProcurementRecommendations` over the integrated cost model + the
margin/memory projections, the ranked recommendation set through
`rankProcurementRecommendations`, the permissioned reads through
`queryProcurementRecommendations`/`queryProcurementRecommendationById`,
the derived stream through `emitProcurementRecommendationProposed` + the
sink port, and the suggestion surface through `proposeNextActions` (the
integration proposes the typed commands through the OFF-017 action
gateway — the engine never does). OFF-040 (analytics) consumes the same
typed records + the `intelligence.procurementProposed` stream as an
analytics feed (the evidence ids + the exposed score composition make
every recommendation attributable end to end).

## Test wiring

The suite is discovered by the ROOT vitest config
(`packages/intelligence/*/src/**/*.test.ts` — widened with OFF-013; no
config change was needed for this work item):

```
pnpm test                                              # the whole repo suite
pnpm exec vitest run packages/intelligence/procurement # this package only
```

`src/boundary.test.ts` (the no-AI/no-network/no-forbidden-import gate +
the type-only agents discipline + the domain-cost READ-surface-only
discipline + the structural no-auto-commitment proof + the
no-mutation-shaped-export proof), `src/comparison.test.ts` (fail-closed
alternative parsing, the four-dimension comparison contracts, the
outcome-derived vendor-performance rating, the typed limits),
`src/recommendation.test.ts` (gate ordering, A12 rejections both
directions, policy exclusion, the fail-closed structural wiring, the three
rules with their pinned thresholds, the A4 evidence-set qualification
gate), `src/ranking.test.ts` (exposed composition recomputed by hand,
total order, run + shuffle stability, fail-closed rejections),
`src/authorization.test.ts` (A12 both directions over the queries, the
no-existence-oracle not-found, policy exclusion), `src/audit.test.ts`
(the envelope shape + the sink port + the failure propagation), and
`src/golden.test.ts` (THE named acceptance — the golden seeded sourcing
portfolio: one typed recommendation per golden scenario with the
historical basis resolving to referenced outcome/benchmark facts and the
projected economic impact resolving to referenced assessment values with
the composition recomputed BY HAND, evidence chains resolving end-to-end,
the stable ranked order across runs and shuffles, the suggestion-only
discipline, and the audit envelopes through an injected sink) make up the
suite. Everything is deterministic: fixed ids, fixed clock, fixed
correlation/causation tokens — no `Date.now`, no `Math.random`, no
environment.
