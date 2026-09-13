# @office/intelligence-revenue

Office contractual revenue recovery engine (OFF-033) — the intelligence
layer's recovery detector: evidence-backed detection of CANDIDATE change
orders and claims (revenue recovery opportunities) over the contracts
domain model and the intelligence peers' outputs, deterministic STABLE
seeded prioritization with EXPOSED score composition, and SUGGESTED next
actions only — there is structurally no path that asserts a contractual
claim, issues a command, or mutates canonical state.

THE discipline: candidates are PROJECTIONS of the contracts model + the
peers' outputs (freeze A2/A7) — `@office/domain-contracts`' typed read
surface (contract/change-event/change-order/claim-reference states), the
margin engine's `ImpactAssessment` values (the economic basis — CITED
producing numbers, never re-derived), and the memory engine's outcome
records and benchmark facts (the historical basis) go in, the typed
`CandidateRecovery` set comes out. Detection and ranking are PURE typed
computation: no AI/LLM/network of any kind, no clock, no randomness (the
scan identity and clock are injected), no floats (every priority score is
an exact rational attributed to named source records, events, assessments,
outcomes, and benchmarks — freeze A4). The engine NEVER asserts: it
PROPOSES typed `ProposedNextAction` records that the OFF-017 action
gateway resolves when a human/agent/app proposes them, and assertion
without an explicit policy decision is a typed rejection (freeze A8).

## Dependencies (the dependency rule)

Workspace dependencies only — exactly seven, mirroring the landed
intelligence packages:

- `@office/domain-contracts` — the canonical contracts/change model, the
  engine's typed READ surface (type-only: the engine never calls the
  domain transitions — only the internal golden fixtures build fixture
  states through the domain package's own pure state constructors);
- `@office/intelligence-margin` — the `ImpactAssessment` values (the
  economic basis every rule cites) + `AssessmentId`/`CurrencyCode`;
- `@office/intelligence-memory` — the `OutcomeRecord`/`Benchmark` facts
  (the historical basis) + the exact-`Rational` shape;
- `@office/agents` — the `EvidenceSet` TYPE discipline (type-only: every
  candidate carries a complete, qualified agents-typed evidence set);
- `@office/contracts` — `DomainEventEnvelope`, `EntityRef`, `CommandName`,
  parse helpers;
- `@office/domain-kernel` — `Result`/`DomainError` + deterministic idioms;
- `@office/authz` — deny-by-default authorization (recovery scans and
  reads are permissioned).

No external dependencies of ANY kind; no other domain package
(schedule/cost/field/organization/projects/documents), no
sync/client-sync/adapters/app-sdk/app-runtime/marketplace/security/
persistence/actions/events imports, no AI/LLM/network dependency anywhere
(`src/boundary.test.ts` proves it by scanning the package).

## Public surface (src/index.ts — the whole surface)

Later Office modules (OFF-037 end-to-end integration, OFF-040 analytics)
consume the package only through its root entry point:

- **vocabulary** — `RECOVERY_DETECTED_EVENT`
  (`intelligence.recoveryCandidateDetected`), the closed `RECOVERY_KINDS`
  vocabulary (constructive-change / entitlement-rebalance / delay-impact)
  + parse/is helpers, the typed `SEVERITY_LEVELS` scale + parse/is
  helpers, the `CANDIDATE_ID`/`RECOVERY_SCAN_ID` grammars + parse/is
  helpers, `RECOVERY_REQUIRED_CAPABILITIES` (contracts.read + cost.read +
  schedule.read — the three bounded contexts a recovery scan spans).
- **model** — `CandidateRecovery`'s claim parts: the evidence chain
  sources (`RecoveryRecordSource`/`RecoveryEventSource`/
  `RecoveryAssessmentSource`/`RecoveryOutcomeSource`/
  `RecoveryBenchmarkSource`) + the canonical evidence order, the local
  exact-`Rational` arithmetic (add/multiply/min/compare/reduce — every
  priority score is an integer-numerator/positive-integer-denominator
  pair), `RecoverySeverity` (+ machine-readable reasons),
  `RecoveryEconomicBasis` (+ the typed citation vocabulary + THE
  PRODUCING ASSESSMENT IDS), `RecoveryHistoricalBasis` (+ benchmark
  facts), `PriorityWeights` (+ `DEFAULT_PRIORITY_WEIGHTS`,
  `PRIORITY_FORMULA`, `severityRankOf`), `PriorityScore` (+ the
  attributable severity and economic `ScoreComponent`s),
  `ProposedNextAction` (+ confidence + `ActionCommandReference` +
  `RecoveryPolicyDecision`, the three suggested command constants), the
  entity-kind constants, `compareReferencedRecords`.
- **candidates** — `CandidateRecovery` (THE candidate record),
  `RankedCandidate`, `DetectionProvenance`, `RecoveryPrimarySource`,
  `CANDIDATE_SCHEMA_VERSION`, `RECOVERY_ENGINE`, `compareCandidates`.
- **detection** — `detectRecoveryCandidates` (THE deterministic detection
  pass) + `RecoveryScanInputs`/`ScanParts`, the typed threshold tables
  (`CONSTRUCTIVE_SHARE_THRESHOLDS`, `ENTITLEMENT_SHARE_THRESHOLDS`,
  `DELAY_IMPACT_THRESHOLDS_DAYS`, `DELAY_IMPACT_MIN_DAYS`,
  `REBALANCE_MIN_APPROVAL_RATE`, `REBALANCE_DIVERGENCE_APPROVAL_RATE`),
  and `qualifyRecoveryEvidenceSet` (THE A4 gate).
- **prioritization** — `rankRecoveryCandidates` (THE deterministic seeded
  prioritization) + `compareRankedPriority`.
- **proposal** — `proposeNextActions` (SUGGESTIONS ONLY) +
  `assertRecoveryClaim` (THE policy-gated assertion — a typed rejection
  without an explicit policy decision, a ProposedNextAction record with
  one).
- **authorization** — `RecoveryAuthorization`,
  `checkRecoveryCapabilities`, `checkRecoveryScopeCovers`,
  `checkRecoveryPolicy`, `recoveryResource`, `recoveryCandidateNotFound`,
  `queryRecoveryCandidates`, `queryRecoveryCandidateById`, `RecoveryQuery`.
- **audit** — `recoveryCandidateDetectedEnvelope`,
  `emitRecoveryCandidateDetected`, the `RecoveryEventSink` port (+
  `RecoverySinkExecutor`, the in-memory and failing sinks),
  `RECOVERY_DETECTED_PAYLOAD_GRAMMAR`.

`src/test-support.ts` and `src/scenarios.ts` are package-INTERNAL (the
deterministic typed factories + the golden seeded recovery scenarios) —
not part of the surface.

## The recovery vocabulary

Three closed kinds — the candidate change/claim conditions the engine
detects (nothing else can be a candidate):

| kind | fires when | money at stake |
| --- | --- | --- |
| `constructive-change` | work is performed and recorded against a proposed change event with NO change order claiming it | the assessment's cited `budgetRevisionDeltaMinor` |
| `entitlement-rebalance` | a documented, valued change order is rejected while the benchmarked approval climate is favorable (mean approval rate >= 1/2) | the rejected order's submitted value |
| `delay-impact` | an unconverted program delay (>= 1 day) with no claiming order | null (severity ranks it) |

Severity is the typed four-level scale (`minor`/`moderate`/`major`/
`critical`), computed from each rule's typed share/day thresholds and
calibrated by the memory benchmarks: a slip beyond the benchmarked p90
schedule-variance escalates one level
(`benchmark-beyond-percentile90`); a rejection in a climate whose mean
approval rate is >= 9/10 escalates one level
(`benchmark-approval-rate-divergence`). Every level carries its
deterministic machine-readable reasons — never an opaque score. A claim
reference pinning any order of the change event suppresses every rule on
it (the idempotence guard: a pinned position is not a candidate).

## Scan semantics (determinism, A12, policy)

`detectRecoveryCandidates(inputs, authorization, parts)` runs the three
rules over (the contracts-domain records + assessments + outcomes +
benchmarks) in a FIXED gate order:

1. the CAPABILITY gate — the requesting context must hold contracts.read
   AND cost.read AND schedule.read BEFORE any input is read (the
   poisoned-scope probe proves the ordering);
2. duplicate input identities are typed invariant violations (an input set
   is a set);
3. STRUCTURAL scope coverage of every input (freeze A12) — contracts
   records, change events/orders, claim references, assessments,
   outcomes, and benchmarks outside the caller's execution scope are
   typed-rejected BEFORE any detection, in both directions, and the
   rejection never reveals the foreign scope;
4. the POLICY gate — records the caller's policy denies are EXCLUDED
   (invisible, never errors; explicit deny wins, deny by default);
5. the three detection rules, each a pure function of ONE admitted
   assessment (+ its canonical change event/order records + the
   historical basis), emitting at most one candidate per (rule,
   assessment) with its FULL evidence chain;
6. every emitted candidate's EvidenceSet must qualify (the agents
   discipline — an empty or out-of-scope set is a typed rejection, never
   a silently-propagated candidate).

Candidate ids are DERIVED from the injected scan identity
(`<scanId>#<ordinal>` in the canonical emission order: rule order, then
canonical assessment order) — deterministic without any id supplier beyond
the scan token itself. The same inputs + authorization + scan identity
ALWAYS produce the byte-identical candidate set (run-twice +
shuffled-input determinism are the acceptance tests; every iteration
order is canonical, so the input array orders never matter).

## Rank semantics (stability + exposed composition)

`rankRecoveryCandidates(candidates, weights?)` composes the priority score
over EXACT RATIONALS with the composition EXPOSED on every ranked
candidate:

```
priority = severityWeight x severityRank(level) + economicWeight x min(1, recoveryValue / economicScale)
```

- `severityRank` is the typed scale as an exact rational (minor 1/4,
  moderate 1/2, major 3/4, critical 1/1);
- the economic exposure is the CITED money at stake over the
  caller-supplied SEED scale (`economicScale`), bounded at 1 — kinds that
  carry no money (delay impact) contribute exactly 0 and rank on severity
  alone, never on invented numbers;
- the default seed is severity 1/2, economic 1/2, scale 10,000,000 minor
  units.

Every ranked candidate carries both attributable components — the
weights, the ranked level, the exact rank, the exposure, the amount +
currency + typed citation + THE PRODUCING ASSESSMENT IDS, and both
contributions — so the score is recomputable by hand from the model alone
(no black boxes). The ordering is a TOTAL ORDER: total score desc →
severity level desc → economic amount desc (null last) → kind asc →
first referenced record asc → candidate id asc — so it is stable by
construction: the same set yields the identical order under every run and
every input permutation. Cross-currency sets are typed-rejected (no FX
invention — rank per currency or supply converted assessments); duplicate
candidate ids are typed-rejected; invalid seeds (negative weights, weights
summing to zero, non-positive scale) are typed-rejected fail-closed.

## Evidence chains (A4 — every claim resolves)

Every candidate's evidence chain is the deduplicated, canonically ordered
set of discriminated source references that PRODUCED its claims: the
producing `ImpactAssessment` id, the `contracts.changeEventRaised` event
it assessed, the canonical contracts-domain records it was detected over
(change event + owning contract + rejected change order), the driver
events behind every cost/schedule/entitlement delta (cost item recorded,
budget revised, activity updated, progress recorded, order submitted,
order rejected), the memory outcome records behind every historical
expectation, and the calibration benchmark when a benchmark escalated or
gated the severity. The golden tests prove resolution END TO END: every
record reference resolves to a golden input record, every event reference
resolves to a ledger event id of the producing assessment's own evidence,
every assessment/outcome/benchmark reference resolves to the scan inputs —
and the primary source anchor (the A3 causation id of the emitted event)
is the producing `changeEventRaised` event's ledger id, with the source's
correlation id carried over. Every candidate ALSO carries the complete,
qualified agents-typed `EvidenceSet` (the assessment item + one item per
historical outcome, each with its retrieval provenance) — the empty or
out-of-scope set is a typed rejection.

## THE suggestion-only discipline (no automatic contractual assertion)

`proposeNextActions(candidate)` maps each kind deterministically into
typed command references over the OFF-017 gateway's own command
vocabulary (the engine invents no command names): constructive changes
suggest `contracts.submitChangeOrder` + `contracts.linkChangeReferences`;
entitlement rebalances suggest the re-submission
(`contracts.submitChangeOrder`, low confidence + human-decision-required)
+ `contracts.referenceClaim` once a re-submitted order executes; delay
impacts suggest the claiming order + the schedule-evidence link. Every
suggestion carries its scope, its deterministic rationale, a typed
confidence (level + machine-readable reasons derivable from the
candidate's own evidence chain), and the justifying evidence subset. The
payload carries ONLY deterministic reference fields (entity ids) —
aggregate versions, actors, idempotency keys, and approvals are supplied
by the PROPOSING caller at proposal time.

`assertRecoveryClaim(candidate, decision)` is the ONLY assertion-shaped
surface, and it is structurally a proposal producer: WITHOUT an explicit
`RecoveryPolicyDecision` the assertion is a typed rejection (freeze A8:
contractual actions are approval-required); WITH one it still only
PROPOSES — the exit is a typed `ProposedNextAction` record carrying the
authorizing decision (A4: who decided, when, and why) so the gateway and
the audit trail can verify the approval chain. This package has NO
execution path: the structural no-auto-assertion proof
(`src/boundary.test.ts` + `src/proposal.test.ts`) proves by scanning and
counting that no command envelope is ever constructed, no
dispatch/execute/commit surface exists anywhere, and the audit module's
only write path is the injected sink port.

## Authorization (A12, before scans and queries)

Recovery scans and reads are permissioned, deny-by-default, enforced
BEFORE any input is read or any record is served (`src/authorization.test.ts`
+ `src/detection.test.ts` prove the ordering with poisoned probes): (1)
the capability gate — contracts.read AND cost.read AND schedule.read; (2)
structural scope coverage — cross-scope scan INPUTS are typed-rejected
(they are the caller's own wiring error), while a foreign candidate is
INVISIBLE to queries: a typed not-found IDENTICAL to an absent one (no
existence oracle, both directions); (3) the policy gate — explicit deny
wins, first allow grants, otherwise deny; denied records are excluded from
set queries, never silently served.

## Recovery events (the derived stream)

Every detected candidate emits exactly ONE
`intelligence.recoveryCandidateDetected` `DomainEventEnvelope` through the
`RecoveryEventSink` port (`appendEvents(executor, events)` inside the
caller's transaction — the landed EventSink shape, mirrored from the
intelligence peers). The event is CAUSED BY the candidate's primary
producing event (A3: the `contracts.changeEventRaised` ledger id, with the
source's correlation id carried over), is sourced `system` (machine-
generated intelligence — never `domain`, never an adapter), and carries
the JSON-safe recovery summary: the candidate's kind, severity, economic
basis (with its producing assessment ids), every evidence id (split by
record/event/assessment/outcome/benchmark), the evidence-set reference
tokens, and the proposed next actions' command references — data only,
never an execution.

## What OFF-037/OFF-040 consume

OFF-037 (the end-to-end construction reference scenario) consumes the
engine through this package's root entry point: `detectRecoveryCandidates`
over the integrated contracts model + the margin/memory projections, the
ranked candidate set through `rankRecoveryCandidates`, the permissioned
reads through `queryRecoveryCandidates`/`queryRecoveryCandidateById`, the
derived stream through `emitRecoveryCandidateDetected` + the sink port,
and the suggestion surface through `proposeNextActions` (the integration
proposes the typed commands through the OFF-017 action gateway — the
engine never does). OFF-040 (analytics) consumes the same typed records +
the `intelligence.recoveryCandidateDetected` stream as an analytics feed
(the evidence ids + the exposed score composition make every candidate
attributable end to end).

## Test wiring

The suite is discovered by the ROOT vitest config
(`packages/intelligence/*/src/**/*.test.ts` — widened with OFF-013; no
config change was needed for this work item):

```
pnpm test                                            # the whole repo suite
pnpm exec vitest run packages/intelligence/revenue    # this package only
```

`src/boundary.test.ts` (the no-AI/no-network/no-forbidden-import gate +
the type-only agents/domain-contracts disciplines + the structural
no-auto-assertion proof), `src/vocabulary.test.ts` +
`src/candidates.test.ts` (fail-closed parsing + the
exact-rational/evidence/model contracts), `src/detection.test.ts` (gate
ordering, A12 rejections both directions, policy exclusion, the typed
threshold tables, the A4 evidence-set qualification gate),
`src/prioritization.test.ts` (exposed composition recomputed by hand,
total order, run + shuffle stability, fail-closed rejections),
`src/authorization.test.ts` (A12 both directions over the queries, the
no-existence-oracle not-found, policy exclusion),
`src/proposal.test.ts` (typed suggestions, THE policy-gated assertion, the
structural no-auto-assertion proof), `src/audit.test.ts` (the envelope
shape + the sink port + the failure propagation), and `src/golden.test.ts`
(THE named acceptance — the golden seeded recovery portfolio: one
candidate per golden scenario with evidence chains resolving end-to-end,
the stable ranked order across runs and shuffles, the suggestion-only
discipline, and the audit envelopes through an injected sink) make up the
suite. Everything is deterministic: fixed ids, fixed clock, fixed
correlation/causation tokens — no `Date.now`, no `Math.random`, no
environment.
