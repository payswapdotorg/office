# @office/intelligence-stack-analysis

Office software-stack replacement analysis (OFF-035) — the intelligence
layer's customer software-portfolio analytics engine: workflow COVERAGE and
REPLACEMENT-POTENTIAL measurements BY EXTERNAL SYSTEM (the adapters-sdk's
provider-neutral observed-system vocabulary: which adapter family observes
which provider system, and which object-kind sync surfaces it declares) and
BY INSTALLED APP (the app-sdk's manifest vocabulary resolved through the
marketplace's release/entitlement/installation-link records: what is
actually installed per tenant).

THE discipline: every replacement score is DERIVED from the observed
workflows/capabilities — never an arbitrary manual score. The score is the
exact rational `coveredCapabilities / observedSurfaceCapabilities`, computed
by COUNTING the assessment's own typed coverage lists (themselves derived
from the referenced records — the adapter's declared object-kind surfaces;
the pinned manifest's permission declarations), and the composition is
EXPOSED on every assessment (the formula constant, the exact value, and
both counts), so any consumer can recompute the score BY HAND from the
referenced records alone. There is NO score input anywhere in the package's
surface: the scan inputs carry records only, and the fail-closed
strict-keys validation makes a manual score fed anywhere a typed
unknown-field rejection (`src/golden.test.ts` proves both directions).
Assessments are PROJECTIONS (freeze A2/A7): suggestion-only typed data
records — there is structurally no path that uninstalls an app, revokes an
entitlement, issues a command, or mutates canonical state of any kind.
Deterministic throughout: injected scan identity + clock, canonical
iteration orders (run-twice byte-identical, shuffled inputs irrelevant), A12
authorization before scans and queries in both directions, and typed audit
envelopes (A3) emitted through an injected sink.

## Dependencies (the dependency rule)

Workspace dependencies only — exactly seven, mirroring the landed
intelligence packages:

- `@office/adapters-sdk` — the provider-neutral observed-system vocabulary:
  `AdapterKind`/`ProviderSystemId`/`AdapterCapabilities` (the declared
  object-kind → capability surfaces — re-parsed fail-closed through the
  SDK's own grammar; the engine NEVER imports an adapter implementation);
- `@office/app-sdk` — the `AppManifest`/`PermissionSpec` vocabulary (the
  declared app surfaces: permissions, command bindings, event
  subscriptions);
- `@office/marketplace` — the `AppRelease`/`Entitlement`/`InstallationLink`
  records (what is actually installed per tenant, re-parsed fail-closed
  through the marketplace's own parsers);
- `@office/intelligence-memory` — the `OutcomeRecord`/`Benchmark` facts (the
  observed-performance basis, referenced ids only) + the exact-`Rational`
  shape every derived score is;
- `@office/contracts` — envelope + entity/identity contracts + parse helpers;
- `@office/domain-kernel` — `Result`/`DomainError` + deterministic idioms;
- `@office/authz` — deny-by-default authorization (stack scans and reads
  are permissioned) + the closed capability vocabulary and its canonical
  order.

No external dependencies of ANY kind; no domain package at all, no
sync/client-sync/adapter-implementations (adapter-construction/model/
schedule/finance are OFF LIMITS — the SDK's neutral vocabulary only), no
agents/actions/app-runtime/persistence/security/workflows imports, no
AI/LLM/network dependency anywhere (`src/boundary.test.ts` proves it by
scanning the package).

## Public surface (src/index.ts — the whole surface)

Later Office modules (OFF-038 release gates, OFF-040 analytics) consume the
package only through its root entry point:

- **vocabulary** — `STACK_ASSESSED_EVENT`
  (`intelligence.replacementAssessed`), the closed `ASSESSMENT_KINDS`
  vocabulary (external-system / installed-app — the two measurement
  directions) + parse/is helpers, the closed `SUGGESTION_KINDS` vocabulary
  (consolidate / extend-coverage / maintain) + parse/is helpers, the
  `ASSESSMENT_ID`/`STACK_SCAN_ID` grammars + parse/is helpers, the
  authorization resource-kind constants, and `STACK_REQUIRED_CAPABILITIES`
  (apps.read + contracts.read + cost.read + schedule.read — the four area
  read capabilities a stack scan spans).
- **model** — `StackEvidence` (the discriminated A4 evidence chain over
  external systems, installation links, releases, entitlements, outcomes,
  benchmarks — deduplicated, canonically ordered), `PerformanceBasis` (the
  referenced memory record ids), `REPLACEMENT_FORMULA` +
  `ReplacementScore` (THE exposed composition: formula + exact rational +
  both counts), `ReplacementSuggestion` (the typed suggestion-only exit),
  the canonical comparators, `STACK_ENGINE`.
- **coverage** — `StackScanInputs`/`ObservedExternalSystem` (records ONLY),
  `validateStackScanInputs` (the fail-closed gate: strict keys, re-parse
  through the owning packages' parsers, duplicate identities, cross-reference
  resolution), `measureStackCoverage` (THE deterministic workflow coverage
  measurement), and the typed coverage records:
  `ExternalSystemCoverage` (surface/covered/gaps — every capability
  evidenced by its declaring object kinds and covering installations) and
  `InstalledAppCoverage` (surface/overlapping/unique — every capability
  evidenced by its permission specs and providing systems, plus the observed
  command/subscription workflow surfaces).
- **replacement** — `ReplacementAssessment` (THE typed assessment record:
  coverage + derived score + typed suggestion + complete evidence chain +
  observed-performance basis + provenance), `assessStackReplacement` (THE
  deterministic scan), `StackAnalysisResult`, `StackConsumedCounts` (the
  non-silent skip tallies), `compareAssessments`.
- **authorization** — `StackAuthorization`, `checkStackCapabilities`,
  `checkStackScopeCovers`, `checkStackPolicy`, the resource helpers
  (`stackResource`/`observedSystemResource`/`installationLinkResource`),
  `queryReplacementAssessments`, `queryReplacementAssessmentById`,
  `stackAssessmentNotFound`, `stackInputScopeFailure`.
- **audit** — `replacementAssessedEnvelope`, `emitReplacementAssessed`, the
  `StackEventSink` port (+ `StackSinkExecutor`, the in-memory and failing
  sinks), `STACK_ASSESSED_PAYLOAD_GRAMMAR`.

`src/test-support.ts` and `src/scenarios.ts` are package-INTERNAL (the
deterministic typed factories + the golden seeded portfolio) — not part of
the surface.

## The two measurement directions

| kind | subject | observed surface | covered means | score |
| --- | --- | --- | --- | --- |
| `external-system` | one observed provider system | the capability set its adapter's declared object-kind surfaces span (the adapters-sdk vocabulary) | an installed app's manifest declares the same capability | fraction of the system's observed workflow surface the tenant's installed apps already cover |
| `installed-app` | one installed app (link → release → entitlement) | the capability set its pinned release's manifest permissions declare (the app-sdk vocabulary) | an external system's observed surface also spans the capability | fraction of the app's declared surface the external-system portfolio also provides |

The measured installed-app portfolio is the installation links in state
`linked` whose referenced entitlements are ACTIVE; severed links and
revoked-entitlement links are skipped AND counted in the scan's consumed
provenance (never silent). Releases are catalog records
(publisher-tenant-scoped by design) resolved THROUGH the tenant's own
links — the A12 gate applies to the tenant-owned link, not the catalog
record it pins.

## THE derived replacement score (exposed, recomputable, never manual)

```
replacementScore = coveredCapabilities / observedSurfaceCapabilities
```

- an EXACT RATIONAL (the memory engine's `Rational` shape — no floats, no
  rounding), reduced;
- `null` exactly when the subject's observed surface is empty (a
  declared-capability-less app — the ratio is undefined, never invented);
- computed by COUNTING the assessment's own typed coverage lists — there is
  no other score source in the package: no weights, no thresholds, no
  manual tuning, and the score-derivation module contains no numeric
  tuning literals (the structural test proves it);
- EXPOSED on every assessment AND in every emitted event payload: the
  formula constant, the exact numerator/denominator, and both counts — the
  golden acceptance recomputes every score BY HAND from the referenced
  input records alone and they match.

The typed suggestion is DERIVED from the same composition (the engine's
ONLY exit): complete overlap → `consolidate`; partial → `extend-coverage`
(close the typed gaps first); none (or an empty surface) → `maintain` —
each with machine-readable reasons (`coverage-complete`,
`coverage-partial:<counts>`, `coverage-none`, …).

## Scan semantics (determinism, A12, policy)

`assessStackReplacement(inputs, authorization, parts)` runs in a FIXED gate
order:

1. the CAPABILITY gate — apps.read AND contracts.read AND cost.read AND
   schedule.read BEFORE any input is read (the poisoned-input probe proves
   the ordering);
2. fail-closed INPUT validation — strict keys everywhere (an unknown field
   — a manual score, for instance — is a typed rejection), every observed
   system's declared capabilities re-parsed through the adapters-sdk's own
   grammar, every marketplace record re-parsed through the marketplace's
   own parsers, duplicate identities typed-rejected, every link's
   release/entitlement references RESOLVED (a link whose release or
   entitlement is not supplied, or whose pinned release does not match its
   app/version, is a typed rejection — never a silent skip);
3. STRUCTURAL scope coverage of every tenant-owned input (freeze A12) —
   typed rejections naming the input path, in BOTH directions, never
   revealing the foreign scope;
4. the POLICY gate — policy-denied SUBJECT records (observed systems,
   installation links) are EXCLUDED from the measured portfolio
   (invisible, tallied in the consumed counts, never errors);
5. the coverage measurement + the assessment derivation, in canonical
   emission order (systems first, then apps — the closed vocabulary's
   order) with scan-derived ids (`<scanId>#<ordinal>`).

The same inputs + authorization + scan identity ALWAYS produce the
byte-identical analysis (run-twice + shuffled-input determinism are the
acceptance tests; every iteration order is canonical, so the input arrays'
orders never matter). The consumed tallies record the whole scan shape —
supplied, measured, and skipped counts — so no skip is ever silent.

## Evidence chains (A4 — every claim resolves)

Every assessment's evidence chain is the deduplicated, canonically ordered
set of discriminated references that PRODUCED its claims: the assessed
subject itself (the observed external system, or the installation link +
its release + its entitlement), every covering app installation (or every
providing external system), and — where applicable — the observed-
performance basis (every referenced `OutcomeRecord` and `Benchmark` id of
the scanned tenant, carried as evidence references only, never re-derived
numbers). The golden tests prove resolution END TO END: every reference
resolves to a golden input record.

## THE suggestion-only discipline (no uninstall, no revoke, no command)

Adopting a suggestion is explicit downstream human/host action through the
landed marketplace lifecycle commands — never this engine. The assessment's
typed suggestion carries NO command references, NO command payloads, and NO
executable surface of any kind (the golden serialization probe proves it),
and the structural proof (`src/boundary.test.ts` + the golden scans) proves
by scanning and counting that no command envelope is ever constructed, no
dispatch/execute/commit surface exists anywhere, no uninstall/revoke/issue/
mutation export exists anywhere in the public surface, and the audit
module's only write path is the injected sink port.

## Authorization (A12, before scans and queries)

Stack scans and reads are permissioned, deny-by-default, enforced BEFORE
any input is read or any record is served (`src/authorization.test.ts` +
`src/replacement.test.ts` prove the ordering with poisoned probes): (1) the
capability gate — apps.read AND contracts.read AND cost.read AND
schedule.read; (2) structural scope coverage — cross-scope scan INPUTS are
typed-rejected (they are the caller's own wiring error), while a foreign
assessment is INVISIBLE to queries: a typed not-found IDENTICAL to an
absent one (no existence oracle, both directions); (3) the policy gate —
explicit deny wins, first allow grants, otherwise deny; denied assessments
are excluded from set queries, never silently served.

## Stack analysis events (the derived stream)

Every assessed subject emits exactly ONE
`intelligence.replacementAssessed` `DomainEventEnvelope` through the
`StackEventSink` port (`appendEvents(executor, events)` inside the caller's
transaction — the landed EventSink shape, mirrored from the intelligence
peers). The event takes CALLER-SUPPLIED causality (A3: the correlation +
causation ids of the chain the scan belongs to), is sourced `system`
(machine-generated intelligence — never `domain`, never an adapter), is
acted by the scan's requesting actor, points the entity refs at the
assessed canonical subject when it is one (an installed app's installation
identity; an external system is not a canonical entity), and carries the
JSON-safe assessment summary — INCLUDING the exposed score composition
(the formula + the exact rational + both counts), the covered/uncovered
capability lists, the typed suggestion, and every evidence id — data only,
never an execution.

## What OFF-038/OFF-040 consume

OFF-038 (app release gates) consumes the coverage measurement through this
package's root entry point: an app release's workflow-coverage footprint
(the `InstalledAppCoverage` surface of the tenant's measured portfolio —
the declared capability surface with its evidencing permission specs and
the observed command/subscription workflow surfaces) and the replacement
assessments' exposed score composition as the gate's observed basis.
OFF-040 (analytics) consumes the same typed records + the
`intelligence.replacementAssessed` stream as an analytics feed (the
evidence ids + the exposed composition make every assessment attributable
end to end), through the permissioned reads
`queryReplacementAssessments`/`queryReplacementAssessmentById`.

## Test wiring

The suite is discovered by the ROOT vitest config
(`packages/intelligence/*/src/**/*.test.ts` — widened with OFF-013; no
config change was needed for this work item):

```
pnpm test                                                   # the whole repo suite
pnpm exec vitest run packages/intelligence/stack-analysis   # this package only
```

`src/boundary.test.ts` (the seven-dep import self-gate: the no-AI/
no-network/no-forbidden-import scan, the structural no-command/no-mutation
proof, the audit module's single write path, THE no-manual-score surface
scan), `src/coverage.test.ts` (the fail-closed input validation: strict
keys, re-parse, duplicates, cross-reference resolution; the deterministic
coverage measurement: typed+evidenced records, canonical orders, provider
lists as sets), `src/replacement.test.ts` (gate ordering, A12 rejections
both directions, the measured-portfolio rule with tallied skips, policy
exclusion, the derived suggestion postures including the undefined
empty-surface ratio, the scan-derived identity discipline, the evidence
chain composition, the closed vocabulary grammars),
`src/authorization.test.ts` (the three layers, A12 both directions over
the queries, the no-existence-oracle not-found, policy exclusion),
`src/audit.test.ts` (the envelope shape + the JSON-safe payload with the
exposed score composition + the sink port + the failure propagation), and
`src/golden.test.ts` (THE named acceptance — the golden seeded portfolio:
the over-covered system, the gap system, and the partial-coverage
candidate, with every score recomputed BY HAND from the referenced
records, the structural no-manual-score proof, evidence chains resolving
end to end, run-twice + shuffled determinism, the suggestion-only
discipline, and the audit envelopes through an injected sink) make up the
suite. Everything is deterministic: fixed ids, fixed clock, fixed
correlation/causation tokens — no `Date.now`, no `Math.random`, no
environment.
