# Office Implementation Status

Status: production implementation STARTED — 36/40 items done (through OFF-034 and OFF-032; PRs #44/#45). Remaining 4 — the serial tail: OFF-037 (ALL dependencies ✅ — dispatching now) → OFF-038 (036✅+037) → OFF-039 → OFF-040. Station verify (fresh-checkout gates on the pushed branch + post-merge main) remains the merge authority. Post-merge main: 267 files / 3506 tests, all five gates rc=0.

## Completed work items

### OFF-034 Procurement optimization engine — DONE (2026-09-13)

- Merge: squash-merged via PR #44 as `21ff189` on `main`.
- Worker: local subagent (2 attempts; attempt 1 lost to an infrastructure timeout after writing ~8K lines; attempt 2 ran the gates — ZERO real source defects, the only fix was one test-side unused-import lint error — wrote the missing boundary self-gate (17 tests) + README, committed d909130, pushed).
- Acceptance evidence (station-verified on the pushed branch by the Tech Lead): install 0; lint 0; typecheck 0; `pnpm test` **3480/3480** (264 files; procurement: 7 files, 122 tests incl. golden 28 + boundary 17); architecture 5/5.
- Acceptance gates proven: THE golden sourcing portfolio — vendor switch / order splitting / lead-time-driven timing shift — each produces exactly one typed ProcurementRecommendation whose historical basis resolves to referenced OutcomeRecord/benchmark facts and whose projected economic impact resolves to referenced ImpactAssessment values recomputed BY HAND; evidence chains resolve end to end; stable ranking across runs and shuffles; suggestion-only (commitment without an explicit policy decision is a typed rejection; with one the exit is still a ProposedNextAction record — the exact mirror of revenue's assertRecoveryClaim, pinned by the boundary self-gate); A12 both directions with the no-existence-oracle not-found; A3 audit envelopes.
- Produced `@office/intelligence-procurement`. For OFF-037 integration + OFF-040 analytics consumption. **Completes every intelligence dependency of OFF-037.**
- Review gates: ownership exact (packages/intelligence/procurement/** + lockfile); seven-dep boundary; no network/LLM/SQL; frozen docs untouched.

### OFF-032 Desktop client protocol/reference shell — DONE (2026-09-13)

- Merge: squash-merged via PR #45 as `c60b841` on `main` (GitHub auto-resolved the additive lockfile importer blocks).
- Worker: local subagent (2 attempts; attempt 1 left ~3.9K lines uncommitted; attempt 2 completed ALL deliverables — index.ts, golden-scenario/a12-scope/boundary suites, README — committed 5fd3c58 and pushed, then died to a context deadline BEFORE reporting; state recorded by the Tech Lead via direct inspection per the AGENTS.md evidence rule, the OFF-036 precedent).
- Acceptance evidence (station-verified on the pushed branch by the Tech Lead): install 0; lint 0; typecheck 0; `pnpm test` **3384/3384** (260 files; apps/desktop: 3 suites — golden 6 + a12 + boundary 25); architecture 5/5.
- Acceptance gates proven: THE same-protocol proof — the reference desktop host over the SAME seeded project: reads (workspace view models over the subscribed slice), writes (typed command path → canonical world reflects them), offline capture → reconnect → exactly-once drain, conflict state displayed with the typed explicit resolution as the only protected exit; PLUS the cross-client convergence proof (a web-style client AND the desktop host over ONE shared server world converge on the identical reconciled state); run-twice identical view models; A12 typed-rejected both directions; the structural no-platform-specific-domain-model boundary (eleven-dep import discipline; no persistence even type-only; no Electron/node runtime/DOM vocabulary).
- Produced `@office/desktop-shell`. For OFF-037 integration consumption (the third client composition).
- Review gates: ownership exact (apps/desktop/** + lockfile); frozen docs untouched; no root config changes.

### OFF-031 Field/offline web client — DONE (2026-09-13)

- Merge: squash-merged via PR #43 as `0c510cb` on `main`.
- Worker: local subagent (2 attempts; attempt 1 lost to an infrastructure timeout after writing ~4.2K lines of apps/field; attempt 2 ran the never-run gates, fixed TWO real inherited source defects — the SQL-backed identity repositories replaced with the apps/web-mirrored in-memory twins, and the conflict resolution view re-projected from the engine's live queue — completed the 13-test boundary self-gate + README).
- Acceptance evidence (worker-reported, station-verified gates): install 0; lint 0; typecheck 0; `pnpm test` **3238 tests / 251 files** (apps/field contributes 3 files / 23 tests: golden 4 + a12 6 + boundary 13); architecture 5/5.
- Acceptance gates proven: THE golden offline scenario — two clients over one seeded field world → DISCONNECT → three offline captures (open/protected/open: queued, counted, displayable) → server-side divergence → RECONNECT + SYNCHRONIZE (exactly-once drain; the PROTECTED capture parked with structurally no auto-resolution; the OPEN resolution superseded deterministically) → both conflicts displayed with both sides + provenance + disposition → the typed EXPLICIT resolution re-enters the queue and applies exactly once → queue empty, board/field-event views reflect the reconciled state; run-twice byte-identity; A12 typed-rejected both directions with zero effects; A3 sync audit trail.
- Produced `@office/field-client`. For OFF-032 (structural template) + OFF-037 consumption.
- Review gates: ownership exact (apps/field/** + lockfile); ten-dep boundary self-gate; zero direct database access; no DOM/browser/service-worker vocabulary; frozen docs untouched.

### OFF-035 Software-stack replacement analysis — DONE (2026-09-13)

- Merge: squash-merged via PR #42 as `fe388f4` on `main`.
- Worker: local subagent (2 attempts; attempt 1 lost to an infrastructure timeout after writing ~4.3K lines; attempt 2 ran the gates, fixed ONE real source defect — measureStackCoverage could emit duplicate provider references when a manifest declares one capability at two scope kinds or an adapter maps two object kinds to one capability; provider lists are now sets — wrote the five missing suites (coverage/replacement/authorization/audit/boundary = 99 of 120 tests) + README).
- Acceptance evidence (worker-reported, station-verified gates): install 0; lint 0; typecheck 0; `pnpm test` **3335 tests / 254 files** (intelligence-stack-analysis: 6 files, 120 tests); architecture 5/5.
- Acceptance gates proven: THE named acceptance — golden fixtures (over-covered / gap / partial-coverage external systems + two installed-app directions) produce typed ReplacementAssessment records whose scores are COMPUTED from observed coverage composition, recomputed BY HAND in the test and matching; the structural no-manual-score proof (a fed manual score is a typed unknown-field rejection at every input level); suggestion-only holds structurally; A12 both directions with the no-existence-oracle not-found; run-twice + shuffled byte-identical; A3 audit envelopes through the injected sink; seven-dep boundary self-gate.
- Produced `@office/intelligence-stack-analysis`. For OFF-038 (app release gates) + OFF-040 (analytics) consumption.
- Review gates: ownership exact (packages/intelligence/stack-analysis/** + lockfile); no network/LLM/SQL; frozen docs untouched.

### OFF-033 Revenue recovery engine — DONE (2026-09-13)

- Merge: direct local merge `d20e3c6` on `main` (GitHub PR/merge API degraded; station-verified rebased branch dd2fe25 — all five gates rc=0, 248 files / 3215 tests; the pre-rebase push-CI run 34748202403 on f68aaca was green; the rebased push-CI run 34748840251 hit an Actions startup_failure — platform-side).
- Worker: local subagent (2 attempts; attempt 1 lost to an infrastructure timeout after writing the full package; attempt 2 completed the seven missing test files + README and fixed one real source defect — the constructive-change rule's historical-basis outcomes were input-order sensitive, now canonically ordered by outcomeId).
- Acceptance gates proven: THE golden cases (constructive-change / entitlement-rebalance / delay-impact) produce typed CandidateRecovery records with evidence chains resolving end-to-end to producing records/events/assessments/outcomes/benchmarks; the structural no-auto-assertion proof (counting/scan — no command construction, no state mutation); assertion-without-policy is a typed rejection (ProposedNextAction suggestions only); stable prioritization across runs AND shuffles with recomputable composition; A12 both directions; typed audit envelopes; run-twice identical.
- Produced `@office/intelligence-revenue`. For OFF-037 integration + OFF-040 consumption.
- Review gates: ownership exact (packages/intelligence/revenue/** + lockfile); seven-dep boundary test; no network/LLM/SQL; secrets scan clean.

### OFF-030 Web application shell — DONE (2026-09-13)

- Merge: PR #41 (merge commit `49dbe5f` — the squash-merge API returned persistent 5xx during a platform degradation window; landed via local --no-ff merge of the CI-double-green branch b7d770b, GitHub auto-marked the PR merged). Re-issue of PR #40 (closed unmerged by an API hiccup during branch cleanup).
- Worker: local subagent (3 attempts; attempts 1-2 lost to infrastructure timeouts after writing ~4K lines; attempt 3 ran the never-run gates, fixed 3 real inherited source defects + a probed A12 command gate, closed the missing acceptance surface — A12 suite, 13-test structural boundary self-gate, README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **3088/3088** (23 new in @office/web); architecture 5/5.
- Acceptance gates proven: THE golden scenario — a seeded project operated END-TO-END through the shell (workspace load → field observation recorded → workflow approval submitted → cost position re-projected → control-tower exception impact updated → evidence navigation walks the full causality chain to the originating command); run-twice identity; A12 both directions (incl. an empirically-probed foreign-session command gate fix in the data plane); structural zero-database boundary (no @office/persistence import — not even type-only; no SQL; no gateway construction; no DOM/browser APIs).
- Produced `@office/web`: the typed view-model shell (session/world/stream plane, workspace/commands/control-tower/evidence view models). For OFF-031/032/037 consumption.
- Review gates: ownership exact + ONE documented deviation (Tech-Lead reviewed): tests/architecture/workspace.test.ts placeholder guard flipped — the OFF-001 guard "until OFF-030" expired by this very item (11-line minimal flip); no root config changes; secrets scan clean.

### OFF-027 Marketplace catalog/lifecycle — DONE (2026-09-13)

- Merge: PR #39 squash-merged as `5877ab1` on `main`.
- Worker: local subagent (2 attempts; attempt 1 lost to a context deadline after writing the full package; attempt 2 ran the never-run gates — the inherited source had zero behavioral defects, all fixes were test-side/import-wiring — and wrote the five missing suites: lifecycle (THE acceptance), update, installation-link, engine, boundary + README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2964/2964** (108 new in @office/marketplace across 10 suites); architecture 5/5.
- Acceptance gates proven: THE lifecycle golden scenario (publish → entitle → install-link → permission-delta update requiring review → rollback → uninstall → publisher revoke) — every transition in the typed audit ledger with injected-clock/deterministic-id provenance; canonical-state fingerprint IDENTICAL before/after all 11 operations with zero engine invocations of the canonical port; run-twice byte-identical ledgers; A12 both directions; all revocation gates; five-dep boundary self-gate (app-runtime type-only in logic modules).
- Produced `@office/marketplace`. For OFF-035 + OFF-038 release gates consumption. Phase 5 fully complete.
- Review gates: ownership exact (packages/marketplace/** + lockfile); no network I/O; no secrets; frozen docs untouched.

### OFF-036 Security/audit hardening — DONE (2026-09-13)

- Merge: PR #37 squash-merged as `e394786` on `main` (rebased onto post-023 main; lockfile merged cleanly, frozen-install consistency re-verified, PR head force-with-lease updated).
- Worker: local subagent (attempt 1 wrote the full package + pushed 7d6ea30; the report was lost to a session interruption — verified by direct Tech-Lead inspection instead of a worker report, per the evidence rule).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2748/2748**; architecture 5/5.
- Acceptance gates proven: the conformance harness drives the REAL action gateway (`createActionGateway`) and the REAL app runtime (`createAppRuntime`) — tenant isolation A12 both directions, deny-by-default authorization matrices, audit-completeness counting (every consequential mutation → envelope), revocation (suspended/revoked installations receive nothing); access reviews derived deterministically from audit trails; sensitive-action alert evaluation run-twice deterministic; retention rules data+evaluation only (ledger immutable — no deletion). Boundary test: six workspace deps exactly.
- Produced `@office/security`. For OFF-038 release gates + OFF-040 consumption.
- Review gates: ownership exact (packages/security/** + lockfile); no network I/O; no secrets; frozen docs untouched.

### OFF-024 ERP/finance adapter — DONE (2026-09-13)

- Merge: PR #38 squash-merged as `c113fd2` on `main`.
- Worker: local subagent (2 attempts; attempt 1 lost to a session interruption after writing 19 files; attempt 2 completed the suite — THE acceptance fixture, boundary self-gate, README — and fixed what the never-run gates exposed: one real source defect (reconciliation join-map typing) + 32 test-side errors).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2957/2957** (101 new in @office/adapter-finance across 9 suites); architecture 5/5.
- Acceptance gates proven: THE non-duplication + version-mapping acceptance end-to-end (same invoice version through sync + re-sync + duplicate webhook → exactly ONE counted canonical proposal; version bump → one update; same canonical ids; cursor restart → nothing re-processed); reconciliation deterministic with typed discrepancy kinds carrying both sides; amount-mismatch → explicit Conflict (both sides) with the structural no-auto-resolution proof; boundary (three-dep self-gate).
- Produced `@office/adapter-finance` — ALL FOUR provider adapters complete (construction/model/schedule/finance).
- Review gates: ownership exact (packages/adapter-finance/** + lockfile); no network I/O; generic vocabulary (erp-finance); no secrets; frozen docs untouched.

### OFF-023 Primavera-class schedule adapter — DONE (2026-09-13)

- Merge: PR #36 squash-merged as `3c45067` on `main`.
- Worker: local subagent (2 attempts; attempt 2 completed the suite — THE acceptance fixture, sync/boundary/adapter tests, README — and fixed the inherited defects the first gate run exposed: two small inherited-source fixes, both error-surface improvements).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2753/2753** (108 new in @office/adapter-schedule across 9 suites); architecture 5/5.
- Acceptance gates proven: THE provider activity update → canonical schedule event → downstream impact notification flow (end-to-end in schedule-flow.test.ts — the notification references the source event id with causation/correlation/provenance traceability); the three typed conflict rules through the sync driver (concurrent activity-date change, dependency-cycle introduction quarantined, re-baselining against a protected baseline quarantined — no auto-resolution); baseline immutability (provider baseline updates → NEW canonical baseline records); replay-safe sync with positional cursors; run-twice determinism.
- Produced `@office/adapter-schedule`. For OFF-037 consumption (all four adapter deps now complete: construction/model/schedule/finance).
- Review gates: ownership exact (packages/adapter-schedule/** + lockfile); no network I/O; generic vocabulary (schedule-pm); no secrets; frozen docs untouched.

### OFF-022 Autodesk/Model adapter contract — DONE (2026-09-13)

- Merge: PR #35 squash-merged as `6095956` on `main` (one parallel-lockfile recovery: rebased onto post-026/021 main, lockfile regenerated, gates re-run green at 7869f16, PR head force-with-lease updated).
- Worker: local subagent (3 attempts; attempt 3 cleared 62 test-layer typecheck errors against the real SDK signatures — zero source defects).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2436/2436** (114 new in @office/adapter-model across 8 suites); architecture 5/5.
- Acceptance gates proven: THE model element mutation → canonical event → affected relationship notification flow (end-to-end fixture; the notification record references the source event id — full traceability); model/version/element reference mappings (A10: deterministic, remapping → explicit conflicts; immutable model versions); replay-safe sync; boundary test (adapters-sdk + contracts + domain-kernel + intelligence-relationships vocabulary constants/projection types only — documented deviation at contract level).
- Produced `@office/adapter-model`. For OFF-037 consumption.
- Review gates: ownership exact; no network I/O; generic vocabulary (model-cde); no secrets; frozen docs untouched.

### OFF-021 Procore-class construction adapter — DONE (2026-09-13)

- Merge: PR #34 squash-merged as `95a8b45` on `main`.
- Worker: local subagent (2 attempts + Tech-Lead gates finish; the full contract-test suite was written by attempt 2).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2398/2398** (new suite incl. THE contract-test round-trip); architecture 5/5.
- Acceptance gates proven: THE ingest/update/source-mapping/replay round-trip on the fixture (initial ingest → snapshots + mappings + command proposals; update → proposal + cursor advance; source mapping deterministic with cross-tenant lookups typed-rejected; replay idempotent + cursor restart safe + divergence → explicit Conflicts); no provider types in core (boundary test: imports ONLY adapters-sdk + contracts + domain-kernel); A10/A11 discipline.
- Produced `@office/adapter-construction` (the reference construction/CDE adapter). For OFF-037 consumption.
- Review gates: ownership exact; no network I/O; generic vocabulary (construction-cde); no secrets; frozen docs untouched.

### OFF-026 App runtime/sandbox boundary — DONE (2026-09-13)

- Merge: PR #33 squash-merged as `8bdd1d3` on `main`.
- Worker: local subagent (2 attempts; attempt 2 completed the acceptance suite — 128 new tests — fixed inherited defects, wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2455/2455** (133 new in @office/app-runtime across 8 suites); architecture 5/5.
- Acceptance gates proven: app CANNOT access undeclared capability or another tenant (typed rejection BEFORE the gateway with handler-invocation counting; the 15-cell lifecycle×grant matrix shows exactly one dispatching cell; A12 both directions); suspended app receives NO commands/events (both paths typed-rejected + audited; reversible by re-activation; one-way revocation); A8 gateway-mediated only (boundary self-scan); typed namespace with collision rejection; lifecycle hooks as descriptor records.
- Produced `@office/app-runtime`: AppInstallation, permission enforcement, namespace, hooks, dispatch engines. For OFF-027 marketplace + OFF-030/031/035 consumption.
- Review gates: ownership exact; @office/persistence type-only (port convention, boundary-test enforced); no provider vocabulary; no secrets; frozen docs untouched.

### OFF-025 App SDK and manifest — DONE (2026-09-13)

- Merge: PR #32 squash-merged as `9e57843` on `main` (one parallel-lockfile-conflict recovery: rebased onto post-018/019 main, lockfile regenerated, gates re-run green at b81f481, PR head force-with-lease updated — the Tech Lead's own branch, standard rebase update).
- Worker: local subagent (2 attempts; attempt 2 fixed inherited parse-combinator defects + a VersionRange round-trip crash, wrote the sample app + the SDK README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2100/2100** (105 new in @office/app-sdk + 5 sample-app boundary tests); architecture 5/5.
- Acceptance gates proven: invalid permissions/dependencies typed-rejected (full malformed-manifest matrix: bad capability, wildcard permission, unknown extension point, undeclared dependency, bad version); the sample app compiles against ONLY @office/app-sdk + @office/contracts (import graph proven by the boundary suite); A9 permission records explicit/versioned/revocable.
- Produced `@office/app-sdk` + `apps/sample-app`: the AppManifest contract, A9 Permission lifecycle, command bindings, event subscriptions, the extension UI contract, fail-closed validation. For OFF-026 app runtime + OFF-035 marketplace consumption.
- Review gates: ownership exact (packages/app-sdk/** + apps/sample-app/** + lockfile); no provider vocabulary; no secrets; frozen docs untouched.

### OFF-019 Exception/control-tower engine — DONE (2026-09-13)

- Merge: PR #31 squash-merged as `c063169` on `main`.
- Worker: local subagent (2 attempts; attempt 2 fixed three inherited scenario defects (change-event aggregate shape, entitlement contract rebalance, rational reduction) and wrote the 115-test suite + README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2105/2105** (115 new in @office/intelligence-exceptions across 9 suites); architecture 5/5.
- Acceptance gates proven: seeded golden scenarios produce STABLE priority ordering (identical across runs AND shuffled input orderings) with evidence chains resolving to producing source ids; exposed priority composition (severity + economic weights attributable to referenced assessment ids); suggestions-only NextActions (structurally no execution path); A12 both directions with authorization before scans; no AI/LLM/network (boundary test).
- Produced `@office/intelligence-exceptions`: the Exception model, deterministic scan engine, stable ranking, NextAction contract, exception events. For OFF-030/033/035 consumption.
- Review gates: ownership exact; intelligence peers + contracts/domain-kernel/authz only; no provider vocabulary; secrets scan clean.

### OFF-018 Agent runtime — DONE (2026-09-13)

- Merge: PR #30 squash-merged as `1032bc2` on `main`.
- Worker: local subagent (attempt 1 wrote all source; attempt 2 wrote the 7-file test suite; the Tech Lead finished: 13 branded-literal test defects + 1 lint + README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **2097/2097** (94 new in @office/agents); architecture 5/5.
- Acceptance gates proven: an agent CANNOT mutate state except through OFF-017 (handler-invocation counting + boundary self-scan; no other write path exists); every consequential recommendation carries evidence (empty/unqualified EvidenceSet → typed rejection BEFORE the gateway call; executed proposals carry evidence refs into the audit trail); deterministic fixture-scripted mock model (run-twice identical); approval handoff (parked → explicit resolution re-enters the gateway, executes once; denied closes without mutation); A12 + deny-by-default actor-kind matrix; A3 audit envelopes.
- Produced `@office/agents`: AgentRun, EvidenceSet, the Tool registry, ProposedAction, resolveApproval, execution records, the ModelPort + deterministic mock. For OFF-026/030/033/036 consumption.
- Review gates: ownership exact; deps @office/actions + intelligence peers + contracts/domain-kernel/authz (+persistence type-only); NO domain/adapters/workflows/sync imports; no LLM/network; no provider vocabulary; secrets scan clean.

### OFF-029 Offline sync protocol — DONE (2026-09-13)

- Merge: PR #29 squash-merged as `d57f2e8` on `main`.
- Worker: local subagent (3 attempts; attempt 3 wrote the five missing suites — replay/conflict/engine/audit/boundary — fixed the counting-command-path occurredAt defect breaking slice append-stability, wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1753/1753** (59 new in @office/client-sync across 8 suites); architecture 5/5.
- Acceptance gates proven: offline mutations replay ONCE (handler counting; interrupted mid-drain → resumed → still exactly once; crash-gap resume; revoked-grant + deny-writes replay denials); protected conflicts REQUIRE explicit resolution — STRUCTURALLY no auto-resolution path (the replay engine cannot apply a protected conflict without an explicit resolution command; resolution re-enters the queue and applies once; idempotent/differing re-resolution typed-distinct); THE offline two-client convergence (A offline queues while B mutates online; reconnect → catchup + replay + conflict surfacing → identical state); deterministic operation ids; A12 session scope gate; audit envelopes through the EventSink port.
- Produced `@office/client-sync`: LocalQueue, replay protocol, causal/version tokens, conflict surfacing, the composed SyncEngine — all consuming @office/sync's foundation. For OFF-030/031/032 consumption.
- Review gates: ownership exact; no network I/O; no domain/intelligence/adapters/workflows/actions imports; no provider vocabulary; secrets scan clean.

### OFF-017 Action gateway — DONE (2026-09-13)

- Merge: PR #28 squash-merged as `c0feed3` on `main`.
- Worker: local subagent (3 attempts; attempt 3 closed the coverage gap — the exported workflows-backed ApprovalAuthority adapter had zero tests; new suite drives it through the REAL workflow engine + REAL gateway).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1808/1808** (114 new in @office/actions across 8 suites); architecture 5/5.
- Acceptance gates proven: direct unauthorized writes fail (typed denial BEFORE handler invocation, counting-proven; no actor kind bypasses; A12); duplicate action keys → the ORIGINAL result, handler exactly once, duplicate-observed audit; approval-required actions NEVER execute without workflow completion (force-execute typed-rejected); fail-closed classification (unknown → prohibited; prohibited never reach the handler); A4 evidence/confidence enforcement (missing → typed rejection; approved carry refs).
- Produced `@office/actions`: ActionDescriptor registry, the four-class classification, executeAction() — the A8 chokepoint — idempotency, evidence enforcement, audit events, the workflows-backed approval routing. For OFF-026/030/031/033/034/036 consumption.
- Review gates: ownership exact; no domain/intelligence/adapters/sync imports; no provider vocabulary; secrets scan clean.

### OFF-015 Enterprise memory and benchmarking — DONE (2026-09-13)

- Merge: PR #27 squash-merged as `95aa3c4` on `main`.
- Worker: local subagent (3 attempts; attempt 3 fixed 16 inherited typecheck defects + 2 lint + 2 broken tests, hardened the lesson parser, completed the 123-test suite + README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1817/1817** (123 new in @office/intelligence-memory across 10 suites); architecture 5/5.
- Acceptance gates proven: THE named acceptance — queried outcomes → DETERMINISTIC benchmark facts (run-twice byte-identical; values carry producing outcome ids); NO opaque AI in core storage (boundary test asserts no AI/LLM/network imports, fragment-assembled patterns); projections never become canonical truth (tamper-with-memory never propagates — rebuild discards tampering; the event stream is the only source); similarity with EXPOSED score composition; A12 both directions with authorization BEFORE queries (poisoned-store probe); EventSink port envelopes round-trip; outcome immutability.
- Produced `@office/intelligence-memory`: OutcomeRecord, Benchmarks, Lessons, typed similarity, the rebuildable-projection discipline. For OFF-018/019/034/035 consumption.
- Review gates: ownership exact; intelligence peers + contracts/domain-kernel/authz/events only; no provider vocabulary; secrets scan clean.

### OFF-028 Realtime subscription protocol — DONE (2026-09-13)

- Merge: PR #26 squash-merged as `a969137` on `main`.
- Worker: local subagent (2 attempts; attempt 2 fixed 22 inherited test-layer typecheck errors + 3 lint + one real source defect (conflict.ts resolution-idempotency compared parsed Actor objects by reference) + two buggy test expectations, then closed the critical coverage gap by writing the broker acceptance suite).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1448/1448** (86 new in @office/sync incl. 11 broker acceptance tests); architecture 5/5.
- Acceptance gates proven: THE two-client convergence gate (both clients receive the same event at the same sequence; independent catchup + resubscribe → identical state); exactly-once per subscription (cursor resume: no duplicates, no gaps); A9 grant revocation (typed clean stop, no partial/corrupt events, authorization proven BEFORE any slice read via a read-counting source); A12 both directions; explicit ConflictRecords with both sides + deterministic ordering, no destructive auto-resolution; run-twice determinism.
- Produced `@office/sync`: versioned subscription contracts, A9 SubscriptionGrants, ProjectSlice streams, typed protocol messages, deterministic operation IDs, the in-memory SubscriptionBroker. NO transport I/O (protocol only — the app layer wires transports). Documented ledger read-surface gap for OFF-029: @office/events exposes only per-aggregate reads; a project-scoped ordered read is needed when the real ledger is wired.
- Review gates: ownership exact; no network I/O; no domain/intelligence/adapters/workflows imports; no provider vocabulary; secrets scan clean.

### OFF-016 Workflow/approval engine — DONE (2026-09-13)

- Merge: PR #25 squash-merged as `0ae4203` on `main`.
- Worker: local subagent (3 attempts; attempt 3 fixed all 39 inherited test-layer typecheck errors + 4 lint + 8 first-run runtime failures against the real source signatures — zero source defects surfaced — and wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1552/1552** (190 new in @office/workflows); architecture 5/5.
- Acceptance gates proven: deterministic state transitions (same definition + state + command → same resulting state + same events; undefined states unreachable); approval-required actions CANNOT bypass policy (typed denial without capability; policy denial blocks transition; audit event records denial; no path advances approval without authorization incl. idempotency/retry paths); bounded retries (typed terminal exhaustion, idempotent attempts); SLA escalation (fires exactly at the injected clock, reassigns per definition, auditable); definition immutability + instance version pinning; A12 both directions; optimistic concurrency.
- Produced `@office/workflows`: versioned immutable WorkflowDefinitions, WorkflowInstance state machine, capability-gated approvals, retries/escalation, EventSink port + ledger adapter. For OFF-017 Action Gateway + OFF-025/026/030/031/036 consumption.
- Review gates: ownership exact; no domain/intelligence/adapters imports; no wall-clock/randomness in logic; no provider vocabulary; secrets scan clean.

### OFF-014 Margin and impact engine — DONE (2026-09-13)

- Merge: PR #24 squash-merged as `4aa56d2` on `main`.
- Worker: local subagent (2 attempts; attempt 2 wrote the 56-test acceptance suite + README, fixed 4 stale golden constants inherited from attempt 1 (fixtures had never been executed) + lint/typecheck defects).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1418/1418** (56 new in @office/intelligence-margin); architecture 5/5.
- Acceptance gates proven: golden construction scenarios (cost/schedule/entitlement/margin) with exact SOURCE EVENT IDS per number — mutating/removing a source event changes the assessment (traceability real); determinism (run-twice + shuffled chain-preserving inputs + fold rebuild); A4 provenance (evidence refs, source identity, injected timestamps, confidence, policy context); authorization BEFORE calculation; A12 no-existence-oracle.
- Produced `@office/intelligence-margin`: ImpactAssessment, deterministic calculateImpact, golden scenarios, assessment events through the EventSink port. For OFF-015/018/019/033/034 consumption.
- Review gates: ownership exact (packages/intelligence/margin/** + lockfile); @office/intelligence-relationships the sole intelligence peer; NO domain-package imports; no provider vocabulary; secrets scan clean.

### OFF-020 Adapter SDK — DONE (2026-09-12)

- Merge: PR #23 squash-merged as `afb4d86` on `main`.
- Worker: local subagent (attempt 1 wrote all source; attempt 2 wrote all 13 test files + README and died at the gates phase; the Tech Lead finished: fixed 13 branded-literal test defects, ran the gates, committed, pushed).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1331/1331** (245 new in @office/adapters-sdk across 13 suites); architecture 5/5.
- Acceptance gates proven: fake-provider ROUND-TRIP (sync out with snapshots + cursor advance; webhook in with normalized envelope + SourceRef resolution; conflict detection explicit with both sides; replay idempotent no-op) WITHOUT importing any core provider code; deterministic mapping (same provider object → same canonical id; second object → existing canonical id = explicit conflict, never silent overwrite); cursor replay-safety (restart re-processes nothing checkpointed; foreign stream/tenant cursor typed-rejected); NO destructive auto-resolution (conflicts land in detected state; resolution is an explicit command with audit refs); A12 isolation on mapping records.
- Produced `@office/adapters-sdk`: the provider-neutral Adapter contract, SourceRef identity mapping (A10: provider ids never primary keys), SyncCursor, Conflict, ProviderSnapshot, webhook normalization (signature verifier port), the fake-provider fixture. For OFF-021/022/023/024 consumption.
- Review gates: ownership exact (packages/adapters-sdk/** + lockfile); ports only — NO I/O anywhere; no provider vocabulary (generic fake-crm/fake-pm kinds); no domain-package imports; secrets scan clean.

### OFF-013 Cross-domain relationship engine — DONE (2026-09-12)

- Merge: PR #22 squash-merged as `c990300` on `main`.
- Worker: local subagent (2 attempts; attempt 2 wrote the 31-test acceptance suite + README, fixed 6 inherited defects, wired root test discovery with the additive OFF-007-pattern widening for packages/intelligence/* — required for workspace linking).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1230/1230** (31 new in @office/intelligence-relationships); architecture 5/5.
- Acceptance gates proven: deterministic traversal for the key construction causal chains (golden fixtures: schedule dependency chain; change event evidencedBy revision + impacting cost/schedule; field-issue → change order → activity covered transitively with a documented envelope-gap note — no data invented); projection determinism + A7 rebuildability (same stream twice → identical index; rebuilt from scratch → identical index); authorization AT TRAVERSAL TIME (A12 both directions, no existence oracle, no leakage through the graph); per-edge provenance (producing event id) + causal-chain reconstruction through command causation; unknown event names skipped deterministically.
- Produced `@office/intelligence-relationships`: the affects/dependsOn/evidencedBy/impacts/derivesFrom index, TraversalQuery, causal-chain queries. For OFF-014/015/016/018/019 consumption.
- Review gates: ownership exact (packages/intelligence/relationships/** + lockfile + the two documented additive root-config widenings); consumes event SHAPES via @office/events/@office/contracts only — no domain-package imports; no provider vocabulary; secrets scan clean.

### OFF-012 Contracts/change model — DONE (2026-09-12)

- Merge: PR #21 squash-merged as `5970e9f` on `main` (supersedes #20, auto-closed by a premature head-branch deletion during the parallel-lockfile-conflict recovery — the branch was rebased onto post-OFF-011 main, lockfile regenerated, gates re-run green locally at 7009b43).
- Worker: local subagent (2 attempts; attempt 2 audited the inherited ~9.1K-line tree, fixed 4 inherited test defects + one 6-line source defect (parse.ts bracket-path convention `field[2]`), wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1074/1074** (113 new in @office/domain-contracts across 7 suites); architecture 5/5.
- Acceptance gates proven: change events link to scope/evidence/cost/schedule via TYPED EntityId/EntityRef links only — no copied entity data, no domain-to-domain imports; links immutable once recorded; change-order lifecycle submitted → approved/rejected → executed explicit/auditable/one-way (executing supersedes the originating change event's proposed state; rejected never mutate scope); contract lifecycle with one-way archive + deny-by-default authorization + A12 both directions; deterministic full-stream replay (identical states AND event streams); optimistic concurrency typed conflicts.
- Produced `@office/domain-contracts`: contract/scope-obligation/change-event/change-order/claim-reference model; the typed-link discipline for OFF-013/OFF-014 consumption.
- Review gates: ownership exact; no domain-to-domain imports; no provider vocabulary; secrets scan clean.

### OFF-011 Cost/budget/commitment model — DONE (2026-09-12)

- Merge: PR #19 squash-merged as `e8723de` on `main`.
- Worker: local subagent (2 attempts; attempt 2 fixed 6 inherited defect clusters incl. a semantic ledger-sink owning-root resolution bug (commitment events now stream under the commitment aggregate), wrote the 125-test acceptance suite + README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **1086/1086** (125 new in @office/domain-cost across 7 suites); architecture 5/5.
- Acceptance gates proven: budget revisions immutable (prior revision byte-identical after supersession; balances computed from the current revision); atomic balance updates (optimistic concurrency typed conflicts, zero partial state on failing-sink abort); immutable commercial event history (full-stream replay → identical states AND event streams); A12 both directions; deny-by-default incl. the stronger projects.write revision gate; committed-vs-budget and invoiced-vs-committed balances as deterministic pure functions (computed, never stored-and-drifted).
- Produced `@office/domain-cost`: budget/cost-item/commitment/invoice/payment-reference model with cost-impact interfaces for OFF-014.
- Review gates: ownership exact; no domain-to-domain imports; no provider vocabulary; secrets scan clean.

### OFF-009 Work/field model — DONE (2026-09-12)

- Merge: PR #18 squash-merged as `744e88e` on `main`.
- Worker: local subagent (3 attempts; attempt 3 rebased the inherited ~10K-line uncommitted tree onto the merged 008/010 main, fixed 15 typecheck + 2 lint defects in inherited tests, wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **961/961** (160 new in @office/domain-field across 8 suites); architecture 5/5.
- Acceptance gates proven: offline-style capture with client-supplied idempotency key + client-observed timestamp (same-key replay = exactly-once, no duplicate aggregate/event; different payload same key = typed idempotency-conflict); deny-by-default authorization incl. cross-tenant/cross-project (A12); failing-sink atomicity; in-memory projection rebuilt from events answering per-project reads (projection≡aggregate-state equivalence).
- Produced `@office/domain-field`: field events, daily logs, issues, inspections; the offline-capture/replay contract; the read-model projection; EventSink port + ledger-backed adapter (@office/events appendEvent+enqueueOutbox, same transaction).
- Review gates: ownership exact (packages/domain/field/** + lockfile additive importer); @office/persistence imported for the port's SqlExecutor type only (same pattern as 007/008); no domain-to-domain imports; no provider vocabulary; secrets scan clean.

### OFF-010 Schedule/program-of-work model — DONE (2026-09-12)

- Merge: PR #17 squash-merged as `c6e77c5` on `main`.
- Worker: local subagent (2 attempts; attempt 2 audited the inherited ~4.7K-line source, fixed one latent parser defect test-first — absent-vs-explicit-null change fields no longer clear pinned dates/parent — and wrote the full 149-test acceptance suite).
- Acceptance evidence (station-verified fresh checkout): install 0; lint 0; typecheck 0; `pnpm test` **696/696** (149 new in @office/domain-schedule); architecture 5/5.
- Acceptance gates proven: dependency validation (cycle/self/missing/duplicate typed rejections); baseline protection (always-forbidden mutation guards, snapshots bit-identical under progress/edits, DISTINCT stronger baseline capability for re-baseline); progress updates as events; deterministic CPM forecast (run-twice + shuffled-inputs determinism; FS/SS/FF/SF + lag semantics); deterministic end-to-end replay → identical states AND event streams.
- Produced `@office/domain-schedule`: the canonical provider-independent schedule contract (activities, dependencies, milestones, baselines, progress, forecast + variance); EventSink port + ledger-backed adapter.
- Review gates: ownership exact; no domain-to-domain imports; NO provider vocabulary (fragment-assembled p6/ms-project asserted absent by the boundary test); secrets scan clean.

### OFF-008 Documents and evidence model — DONE (2026-09-12)

- Merge: PR #16 squash-merged as `2fc035e` on `main`.
- Worker: local subagent (2 attempts; attempt 2 finished the inherited ~5.6K-line tree: fixed 2 lint + 21 typecheck defects + 6 buggy tests, added the two missing acceptance proofs, wrote the README).
- Acceptance evidence (station-verified fresh checkout): install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **652/652** (105 new in @office/domain-documents); architecture 5/5.
- Acceptance gates proven: revision supersession chain (R1→R2→R3 explicit chain, full history readable, R1 byte-identical after supersession); revisions immutable (re-attach same revision id with different content → typed conflict + rollback); evidence references immutable + auditable (pin entity+document+revision; creation emits envelope with scope/actor/causation); ObjectStorage port content-addressed with in-memory implementation (A6: no provider adapter).
- Produced `@office/domain-documents`: document/revision/evidence aggregates; ObjectStorage port; EventSink port mirroring OFF-007's shape exactly. For OFF-012/013/016 consumption.
- Review gates: ownership exact (packages/domain/documents/** + lockfile new importer, workspace links only); @office/persistence for the port's SqlExecutor type only; no domain-to-domain imports; no @office/events import (port mirroring suffices at this layer); no provider vocabulary; secrets scan clean.

### OFF-007 Enterprise/project identity model — DONE (2026-09-12)

- Merge: PR #15 squash-merged as `cbc0346` on `main`.
- Worker: local subagent (2 attempts: attempt 1 completed the organization package, attempt 2 audited + fixed inherited defects and built the projects package). The chat.z.ai replay channel was down (backend outage: http-500 on chat GETs, capacity wall on creates) — the Tech Lead switched the item to a local worker rather than lose deadline time, and retired the replay session cleanly.
- Acceptance evidence (station-verified at a fresh checkout of off-007 @ 9e24d1c): pnpm install --frozen-lockfile 0; lint 0; typecheck 0; `pnpm test` **547/547** (141 new: 68 organization + 73 projects, incl. **48 real-PostgreSQL integration tests** on the embedded harness); architecture 5/5.
- CI evidence: both check-runs `success` on `9e24d1c` (push + pull_request).
- Acceptance gates proven: create/update/archive lifecycle WITH authorization (granted-with-capability vs typed denial regression tests incl. cross-tenant A12; denied commands never open a transaction); audit events through the EventSink port with scope/actor/source 'domain'/correlation+causation from the command envelope/before-after EntityRefs; deterministic canonical IDs (injected supplier sequence → same ids; parse via contracts); optimistic concurrency (stale version → typed conflict, state unchanged); repository integration tests prove tenant scope isolation for the new tables (no existence oracle).
- Produced `@office/domain-organization` + `@office/domain-projects` (packages/domain/*): the canonical enterprise/project identity aggregates, the established domain-package pattern (state/parse/events/commands/index + repositories), the minimal EventSink port (`appendEvents(executor, events): Promise<Result<true, DomainError>>` + in-memory/failing sinks) that OFF-005's ledger implements at app wiring time, migrations 0100_organizations.sql + 0101_projects_lifecycle.sql (pure additive ALTER on 0002's projects table; co-located under packages/domain/*/migrations per the OFF-005 convention).
- Review gates: ownership exact (packages/domain/** + lockfile + the two PRE-APPROVED additive root-config widenings: pnpm-workspace.yaml `packages/domain/*` glob + vitest include glob); no packages/events imports (dependency graph respected — 007 depends on 004+006 only); no new external dependencies; no provider vocabulary; secrets scan clean; frozen docs untouched; 0001/0002 + packages/persistence/src untouched.

### OFF-005 Event ledger and transactional outbox — DONE (2026-09-12)

- Merge: PR #14 squash-merged as `7a45cf7` on `main`.
- Acceptance evidence: lint 0; typecheck 0; `pnpm test` **406/406** (66 new in @office/events incl. **45 integration tests on real PostgreSQL**); architecture 5/5; clean tree (packages/events/** + lockfile only).
- CI evidence: both check-runs `success` on `9f16483` (push + pull_request, same four gates with postgres service).
- Acceptance gates proven: mutation + event + outbox commit atomically (a failure after the state write discards ALL three — no partial anything); duplicate delivery harmless (consumer-cursor no-op replay); deterministic dense strictly-monotonic per-aggregate sequences (race-safe under concurrent appends); causation/correlation propagation (command → event → chained events, chain roots null); outbox dispatch exactly-once-per-row under duplicate processing; ledger immutability enforced AT THE DATABASE LEVEL (UPDATE/DELETE rejected); tenant isolation with no existence oracle (A12).
- Produced `@office/events`: appendEvent (caller-supplied transaction — never opens its own), enqueueOutbox (same-transaction), consumeIdempotently (durable cursor), readEventById/readAggregateEvents/causedByCommand/causedByEvent, outbox fetch/mark/failure-retry lifecycle, migrations co-located at packages/events/migrations/ (0003 event ledger, 0004 outbox + cursors) composed via EVENTS_MIGRATIONS_DIR + the persistence migrator. For OFF-007+/OFF-013/OFF-016 consumption.
- Review gates: ownership exact (packages/events/** + pnpm-lock.yaml); no new external dependencies (3 workspace deps only: contracts/domain-kernel/persistence); no provider vocabulary; secrets scan clean. Worker session `off-005` (chat.z.ai agents tab, GLM-5.3/Full-Stack); verified independently by the Tech Lead at a fresh checkout.

### OFF-004 Database foundation — DONE (2026-09-12)

- Merge: PR #13 squash-merged as `b99baad` on `main`.
- Acceptance evidence: lint 0; typecheck 0; `pnpm test` **340/340** (69 in @office/persistence incl. **39 integration tests on real PostgreSQL 17.10**); architecture 5/5; clean tree.
- CI evidence: runs `34689969917` (push) + `34690069250` (pull_request) both `success` on `177d806`, with the postgres:17 service container + DATABASE_URL.
- Acceptance gates proven: migration from empty database (transactional, ordered, recorded); tenant scope isolation by construction (scopedSql binds tenant_id; project second boundary; cross-tenant rows unreachable — typed not-found/unauthorized); transactional rollback leaves no partial writes (cooperative tx.rollback(value) for typed DomainError failures).
- Produced `@office/persistence`: TransactionRunner/Transaction (the atomic mutation+outbox seam for OFF-005), SqlExecutor repository seam, scopedSql, migrator + forward-only SQL migrations (0001 tenants, 0002 projects), Tenants/Projects repositories with optimistic-concurrency WHERE-version guards, fail-closed row decoding, PersistenceFailure-only driver errors. Harness: embedded-postgres (local) / DATABASE_URL (CI) with scratch-DB isolation.
- Review gates: ownership exact (packages/persistence/** + lockfile + named root-file additions only: package.json devDeps + onlyBuiltDependencies, pnpm-workspace.yaml allowBuilds, ci.yml postgres service); no Prisma/ORM (boundary test asserts); no provider vocabulary; secrets scan clean.

### OFF-006 Authorization and policy kernel — DONE (2026-09-12)

- Merge: PR #12 squash-merged as `ad8aafc` on `main`.
- Acceptance evidence: lint 0; typecheck 0; `pnpm test` **271/271** (105 new in @office/authz); architecture 5/5; clean tree (16 package files + lockfile; ZERO new external deps).
- CI evidence: runs `34688707330` (push) + `34688888218` (pull_request) both `success` on `fe59625`.
- Acceptance gate proven: denied cross-tenant AND cross-project reads and writes under regression tests — **structural A12 isolation runs BEFORE any rule matching, so no policy can ever allow them**; deny-by-default (no-allow-rule), explicit-deny wins; denials carry the request scope only.
- Produced `@office/authz`: AuthorizationContext (uniform user/agent/app/adapter/system), ResourceScope, closed Capability vocabulary (fail-closed parsing), role→capability primitives, declarative Policy + pure authorize() evaluator with audit ruleIndex. Designed for OFF-017/OFF-026 consumption.

### OFF-003 Domain kernel and invariants — DONE (2026-09-12)

- Merge: PR #11 squash-merged as `4e9913c` on `main`.
- Acceptance evidence: clean `pnpm install` (incl. fresh-clone frozen-lockfile check); lint 0; typecheck 0; `pnpm test` **166/166** (75 new in domain-kernel); architecture 5/5; clean tree (19 package files + lockfile).
- CI evidence: runs `34686984934` (push) + `34687263462` (pull_request) both `success` on `9140d6a`.
- All four kernel invariants proven end-to-end: tenant isolation (A12 backstop), optimistic concurrency (typed conflict, never silent overwrite), idempotency (fingerprint registry, harmless replay vs typed conflict), invariant enforcement (state unchanged on violation).
- Produced `@office/domain-kernel`: AggregateVersion, ConcurrencyToken/checkConcurrency, Aggregate/checkScopeCovers, DomainError taxonomy + toApiError bridge, Invariant/checkInvariants, CommandFingerprint/IdempotencyRegistry/withIdempotency, CommandHandler with injected clock/id suppliers. Imports ONLY @office/contracts (boundary self-gate).

### OFF-002 Canonical contract package — DONE (2026-09-12)

- Merge: PR #10 squash-merged as `f7831b2` on `main`.
- Acceptance evidence: clean `pnpm install`; `pnpm lint` 0; `pnpm typecheck` 0; `pnpm test` **91/91** across 14 files; `pnpm test:architecture` 5/5; clean tree (26 package files + lockfile only).
- CI evidence: runs `34685707874` (push) + `34685807444` (pull_request) both `success` on `1938cfd`.
- Produced surface: `@office/contracts` — branded opaque IDs (EntityId/TenantId/ProjectId), Scope (A12), Actor, CommandEnvelope with mandatory idempotency key, DomainEventEnvelope per A3 (causality, before/after refs), Page, ApiError, fail-closed SchemaVersion. Boundary self-gate proves zero dependencies, no imports outside the package, no provider vocabulary.
- Review gates: ownership exact; frozen docs untouched; secrets scan clean. Worker session `off-002` (chat.z.ai agents tab); verified independently by the Tech Lead.

### OFF-001 Repository/toolchain bootstrap — DONE (2026-09-12)

- Merge: PR #9 squash-merged as `65a79e2` on `main`.
- Acceptance evidence: clean `pnpm install`; `pnpm lint` exit 0; `pnpm typecheck` exit 0; `pnpm test` 7/7 passed; `pnpm test:architecture` 5/5 passed; working tree clean (exactly the 19 declared files).
- CI evidence: GitHub Actions runs `34682400695` (push) and `34683445975` (pull_request) both completed `success` on `535f1cf` (Node 22 + pnpm 12.4.1, frozen lockfile, same four gates).
- Review gates: frozen `docs/` untouched; no runtime/provider dependencies (toolchain only); no secrets in tracked files; `apps/web` placeholder enforced by `tests/architecture/workspace.test.ts`.
- Worker session `off-001c` (chat.z.ai agents tab, GLM-5.3/Full-Stack); verification reproduced independently by the Tech Lead per the `AGENTS.md` evidence rule.

## Current ready queue

- `OFF-037` End-to-end construction reference scenario (`packages/reference-scenario`; depends 021✅ + 022✅ + 023✅ + 024✅ + 030✅ + 033✅ + 034✅ — ALL LANDED) — IN FLIGHT (worker dispatched; brief at office-ops/prompts/off-037.md).
- Then the serial tail: OFF-038 production readiness (036✅ + 037) → OFF-039 architecture conformance gate → OFF-040 successor handoff verification.

## Phase tracker issues

- Phase 0–1: #1
- Phase 2: #2
- Phase 3: #3
- Phase 4: #4
- Phase 5: #5
- Phase 6: #6
- Phase 7: #7
- Phase 8: #8

## State meanings

`READY` = all declared prerequisites merged and verified.
`IN_PROGRESS` = assigned to a worker.
`BLOCKED` = prerequisite/contract problem; no implementation guessing.
`DONE` = acceptance checks + architecture conformance + review passed.

## Authority

`docs/architecture/*` freezes architecture.
`docs/execution/WORK_ITEMS.md` defines atomic scope.
`docs/execution/DEPENDENCY_GRAPH.md` defines readiness.
`docs/execution/DEFINITION_OF_DONE.md` defines completion.
`docs/execution/TECH_LEAD_HANDOFF.md` defines orchestration.
