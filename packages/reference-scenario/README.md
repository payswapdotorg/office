# @office/reference-scenario

Office end-to-end construction reference scenario (OFF-037) — **THE
deterministic integration-acceptance artifact**: the golden chain that wires
the LANDED packages into one model-change -> quantity/cost -> schedule-impact
-> change-evidence -> approval -> execution composition over a seeded
in-memory construction world, and proves the work item's two named
invariants — (1) every linked projection agrees on the causal IDs, and (2) no
duplicate canonical records appear, including under replay. The release gates
(OFF-038/039/040) run this suite as their end-to-end fixture.

## THE chain (the eight steps the driver runs)

```
 0a  FINANCE INGRESS       the finance adapter proposes the commercial baseline
      │                    (budget + cost item + commitment + invoice) — executed
      │                    through domain-cost's typed command path
 0b  SCHEDULE FIRST PASS   the schedule adapter proposes the whole network
      │                    (schedule + activities + dependencies + baseline)
 0c  CONSTRUCTION INGRESS  the construction adapter records the change-event /
      │                    document provider mappings (the approval subject)
 1   MODEL INGRESS         the model adapter's wall-element quantity mutation ->
      │                    models.recordElementChange -> the ledger event (ORIGIN)
 2   COST IMPACT           cost.recordCostItem over the budget (caused by 1)
 3   SCHEDULE UPDATE       schedule.updateActivity over the structure activity
      │                    (the adapter's second pass, caused by 1)
 4   EVIDENCE PACKET       the agents-typed EvidenceSet: 5 references (the three
      │                    chain events + change event + document)
 5   APPROVAL              workflows: definition -> instance -> review transition
      │                    -> submit -> DECIDE -> approve-change transition
 6   EXECUTION             cost.amendCommitment applies the approved change order
      │                    (the commitment's amendment line set cites the change)
 7   OBSERVERS             procurement + revenue detection surfaces over the
                         EXECUTED world (their evidence cites the chain's records)
```

**Invariant #1 (causal-ID agreement)** is proven at every arrow: the
`causalWalk` proof walks event -> command -> aggregate -> projection ->
evidence end to end and asserts every hop's causal ids resolve into the SAME
chain (the model event, the cost command, the schedule update, the approval
pair, the execution), that the evidence packet's references resolve to those
same events, that the approval note embeds the packet verbatim, and that the
procurement recommendations' evidence cites the world's own records.

**Invariant #2 (no duplicate canonical records)** is proven three ways:
canonical aggregate counting (every aggregate exactly once — one budget, one
commitment with its append-only amendment line-set chain, one invoice, one
schedule; the ledger's event-id Set has full length with dense
per-aggregate sequences); REPLAY (`replayNotifications` re-delivers the same
adapter notifications -> ZERO new canonical records, ledger and journal
lengths unchanged); and RUN-TWICE (two runs over fresh equal parts produce
byte-identical ledgers and command journals).

## Public surface (src/index.ts — the whole surface)

- `seedWorld` / `sessionCoversScope` / `costOpaqueId` — the seeded
  deterministic world (ONE tenant, ONE organization, ONE project, the four
  domain command services + the workflows surface, ONE audit recorder, ONE
  append-only ledger, the command journal, the A12 session/read gates);
- `createAdapterRig` / `proposalsOf` / `CHAIN_PROVIDER_IDS` — the
  four-adapter fixture rig (model / schedule / finance / construction) over
  the shared mapping graph, with the positional canonical-id discipline
  documented in `src/scenario/adapters.ts`;
- `runReferenceScenario(parts)` — THE chain driver (the typed `ScenarioRun`
  record with one step record per chain step);
- `replayNotifications(run)` / `causalWalk(run)` — the two named proofs.

`src/scenario/**` is the composition; the three suites are package-internal.

## Consumed packages (exactly sixteen, all `workspace:^`)

| package | role in the chain |
| --- | --- |
| `@office/adapter-model` | the model ingress (element mutation -> canonical event proposal) |
| `@office/adapter-schedule` | the schedule ingress (network first pass + activity update) |
| `@office/adapter-finance` | the finance ingress (the commercial baseline fixtures) |
| `@office/adapter-construction` | the construction ingress (change event / document mappings) |
| `@office/domain-cost` | the cost impact + execution command paths (budget, cost items, commitment amendment) |
| `@office/domain-schedule` | the schedule impact command path (activities, dependencies, baseline) |
| `@office/domain-projects` | the seeded project aggregate + its command surface |
| `@office/domain-organization` | the seeded organization aggregate + its command surface |
| `@office/workflows` | the approval route (definition, instance machine, approvals) |
| `@office/agents` | the `EvidenceSet` discipline of the change-evidence packet |
| `@office/events` | the ledger record shape + deterministic event identity + causation ids |
| `@office/contracts` | command envelopes, scopes, actors, parse helpers |
| `@office/domain-kernel` | `Result`/`DomainError`, idempotency registry, deterministic idioms |
| `@office/authz` | capabilities, policies, authorization contexts |
| `@office/intelligence-procurement` | the procurement detection surface (observer over the executed world) |
| `@office/intelligence-revenue` | the recovery detection surface (observer; zero candidates by design) |

No external dependencies; no `@office/persistence` (not even type-only), no
sync/client-sync/app-runtime/marketplace/security/app-sdk/adapters-sdk/
test-fixtures, no app imports (the optional `@office/web` shell import was
dropped in favor of the domain read surfaces + the ledger — documented per
the brief). `src/boundary.test.ts` proves all of it by scanning the package.

## Deterministic discipline

The clock and the canonical-id opaque supplier are INJECTED (`parts.now`,
`parts.newOpaqueId`) — no wall clock, no randomness, no counters shared
between runs: the same parts always produce the byte-identical world + ledger
(the run-twice proof). The finance fixture's canonical references follow the
cost service's positional opaque-id issuance (`costOpaqueId`; the per-LINE id
sequence is documented in `src/scenario/adapters.ts`), so the adapters'
proposed commands and the executed aggregates agree on identity by
construction. Generic fixture vocabulary only (`building-01`-style elements,
`vendor-01`, `activity-1100`).

## Host-seam conversions (the composition's documented seams)

- Schedule provider dates (`YYYY-MM-DD`) -> RFC 3339 UTC instants (the
  domain commands require instants).
- Provider link-type casing (`fs`) -> canonical CPM vocabulary (`FS`).
- Capability dedup: the finance fixture maps one capability per object kind
  (several kinds share `cost.write`) -> the distinct capability set.
- Link-coordinate bindings: the model fixture's linked activity/document
  resolve through the SHARED mapping graph (provider coordinates re-bound to
  the executed canonical aggregates; engine-minted placeholder ids re-bound
  to the executed dependency/baseline ids).

## What OFF-038/039/040 consume

The release gates consume this package ONLY through `src/index.ts`:
`runReferenceScenario` is their end-to-end fixture (the deterministic
construction world + the executed change), `replayNotifications` +
`causalWalk` are their invariant re-assertions, and the suite itself
(smoke + golden + a12 + boundary) is the pre-merge acceptance they run
before shipping.

## Tests

| suite | tests | proves |
| --- | --- | --- |
| `src/smoke.test.ts` | 1 | the chain runs end to end (incl. replay=0, walk>5) |
| `src/golden.test.ts` | 7 | THE two named invariants + every step's record + the displayable-rejection discipline |
| `src/a12-scope.test.ts` | 4 | foreign sessions typed-rejected both directions with zero ledger effects; the seeded control executes |
| `src/boundary.test.ts` | 12 | the sixteen-dependency boundary, forbidden imports, vocabulary + determinism scans, the source entry point |

Run them with the repo-root `pnpm test` (the workspace vitest glob covers
`packages/*/src/**/*.test.ts`).
