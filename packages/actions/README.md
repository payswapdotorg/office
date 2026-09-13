# @office/actions

Office action gateway for PaySwap Office (**OFF-017**).

`@office/actions` is **THE typed command execution chokepoint** of freeze A8
(the AI execution boundary): humans, agents, apps, and adapters NEVER write
canonical state directly — every consequential action is proposed as a typed
`ActionProposal` and decided by `executeAction()`, which runs the full
decision pipeline (fail-closed classification → actor-kind gate → required
capabilities → deny-by-default policy with structural A12 isolation → A4
evidence → A4 confidence → idempotency) BEFORE any execution, routes
approval-required actions into the workflow/approval engine, executes
read/reversible actions only against INJECTED typed command handlers, and
audits every decision as an immutable `DomainEventEnvelope` through the
EventSink port. The package depends only on `@office/contracts`,
`@office/domain-kernel`, `@office/authz`, `@office/persistence` (the
`SqlExecutor` type of the EventSink port), and `@office/workflows` (the
approval engine the approval-required class routes into, through the adapter
in `workflow-approval.ts`) — no SQL, no migrations, no repositories, no
external dependencies, no domain package imports (the gateway is generic
over typed commands; domain handlers are INJECTED — dependency rule).

## What is here

| Area | Exports |
| --- | --- |
| Classification | `ActionClass` / `ACTION_CLASSES` (the four-class vocabulary), `parseActionClass` / `isActionClass`, `classifyAction` (fail-closed: unknown → prohibited by default), `authorizationActionOf` |
| Descriptor | `ActionDescriptor` (the registry entry of a known action), `parseActionDescriptor` / `isActionDescriptor` with the structural class rules, `defineActionDescriptor` (trusted path) |
| Evidence | `EvidenceRequirement` / `EvidenceReference` (+ parsers/lists), `ConfidenceLevel` / `CONFIDENCE_LEVELS`, `confidenceRank`, `meetsConfidence` |
| Approval | `ApprovalRouting` (+ parser), `ApprovalReference` (+ parser), `ApprovalStatus` / `ApprovalRecord`, `ApprovalRoutingRequest`, **`ApprovalAuthority`** (the port), `approvalRoutingKeyOf`, `createInMemoryApprovalAuthority` (deterministic stub), the typed routing-mismatch / already-decided failures |
| Registry | `ActionRegistry`, `createInMemoryActionRegistry` — known-action resolution (duplicate registration is a loud `TypeError`) |
| Proposal | `ActionProposal` (+ `parseActionProposal` / `isActionProposal`, the `actionProposal` trusted builder), `ActionAuthorization` |
| Audit events | the four `ACTION_*_EVENT` name constants, `ACTION_EVENT_NAMES`, `ActionDecision` / `ACTION_DECISIONS`, `ActionAuditPayload`, `actionEventEnvelope`, `auditPayloadBaseOf` / `withApprovalOnPayload`, **`EventSink`** (the port), `InMemoryEventSink` / `createInMemoryEventSink`, `failingEventSink` |
| Handlers | `ActionCommandHandler`, `ActionHandlers`, `createInMemoryActionHandlers` — the injected typed command handler port |
| Gateway | **`createActionGateway`** → `executeAction` (the chokepoint), `ActionGateway` / `ActionGatewayDeps`, `ActionResult`, `RecordedActionOutcome` |
| Workflow seam | `createWorkflowApprovalAuthority` (+ `WorkflowApprovalAuthorityDeps`) — the `@office/workflows`-backed `ApprovalAuthority` adapter |

`src/index.ts` is the whole public surface; later Office modules (OFF-018
agent runtime, OFF-025/026 app surfaces, OFF-030/031 API clients, …) import
only from the package root. Anything not re-exported there is
package-internal and may change without notice.

## The A8 chokepoint contract

Freeze A8: **no machine actor (and no human surface) mutates canonical state
outside `executeAction()`**. The gateway is deny-by-default at every step and
fail-closed on everything it does not know:

1. **Classify** — the command name resolves against the
   `ActionRegistry`. An UNKNOWN command is **prohibited by default**: typed
   rejection + `actions.actionDenied` audit event before anything else runs.
2. **Prohibited rejection** — a `prohibited` action never executes, for any
   actor, under any policy or grant.
3. **Authorization (no actor kind bypasses)** — three gates in order:
   the descriptor's actor-kind requirement; the descriptor's required
   capabilities (the proposing actor must hold them ALL); then the
   caller-supplied deny-by-default policy through the SAME
   `@office/authz` `authorize()` evaluator every module uses — structural A12
   isolation first (cross-tenant / cross-project resources are typed
   `unauthorized` no rule can allow), then explicit deny, allow, default deny.
4. **A4 evidence** — every evidence slot the descriptor declares must be
   filled by an opaque evidence reference on the proposal.
5. **A4 confidence** — the proposal's confidence must meet the descriptor's
   declared minimum (`low < medium < high < certain`).
6. **Idempotency** — the `(scope, idempotency key)` pair is looked up BEFORE
   any execution (see below).
7. **Routing by class** — `read` / `reversible` execute against the injected
   handler; `approval-required` routes into the approval engine (see below).

Only SUCCESSFUL executions (and successful approval routings) are recorded in
the idempotency registry — a failed execution stays retryable under the same
key. A declared action with no registered handler is a typed wiring failure,
never a silent no-op. An audit append failure aborts the action: no
idempotency record, no committed effect.

## The ActionDescriptor and the four classes

A descriptor is static, versioned policy data loaded by the owning runtime
(never from client input). Parsing is total, fail-closed, strict-keyed, and
enforces **structural class rules** (the class dictates what the rest of the
descriptor may declare — an invalid descriptor never enters a registry):

- `read` — a query; read capabilities only; no compensating command, no
  approval routing; authorizes as `read`.
- `reversible` — a write compensated by a declared `compensatingCommand`
  (REQUIRED); at least one `.write` capability; executes at the gateway once
  every gate passes.
- `approval-required` — a write that may ONLY execute after its routed
  workflow approval completes; `approval` routing REQUIRED (and forbidden for
  every other class); at least one `.write` capability.
- `prohibited` — never executed; binds NO actor kind (empty `actorKinds`),
  may declare no capabilities.

## executeAction semantics

`createActionGateway(deps)` wires the registry, handlers, idempotency
registry, EventSink, ApprovalAuthority, injected clock and id suppliers, and
the transaction executor. `executeAction(proposal, authorization)` returns a
typed `Result`:

- `{ decision: 'executed', replayed, value }` — the handler ran (or a prior
  recorded outcome was replayed);
- `{ decision: 'routed-to-approval', replayed, approval }` — the
  approval-required action awaits its workflow approval;
- every denial is a typed `DomainError` (`forbidden` for authorization /
  policy / approval-state rejections, `invariant-violation` for A4 evidence /
  confidence gaps and wiring defects, `idempotency-conflict` for key reuse)
  emitted AFTER its `actions.actionDenied` audit event.

## Idempotency: duplicate keys never duplicate effects

A same-fingerprint replay of a recorded key returns the ORIGINAL outcome —
the handler is NOT invoked again — and emits an
`actions.actionDuplicateObserved` audit event. The same key re-used for a
different command (different fingerprint) is a typed
`idempotency-conflict`. Denials are never recorded, so a denied key re-runs
the gates; handler-level domain failures pass through unrecorded, so the key
stays retryable.

## Approval routing: never executed without the completed approval

An `approval-required` action routes INTO the workflow engine through the
injected `ApprovalAuthority` (`createWorkflowApprovalAuthority` in
production, `createInMemoryApprovalAuthority` in tests) and returns the
pending state. The action executes ONLY when the proposal re-enters carrying
the approval reference AND the authority reports that approval decided
`approved`; a pending, submitted, or rejected approval, or a foreign
reference, is a typed rejection — there is NO path from `executeAction()` to
the handler for an approval-required action whose approval has not
completed. The routing itself is idempotent: the engine-side key is the
deterministic `approvalRoutingKeyOf(actionKey)` derivation, so re-routing
re-opens the SAME approval instance. The adapter never creates workflow
definitions (publishing them is a capability-gated workflow-operator
concern) and never decides approvals (deciding is the engine's
capability-gated command surface, driven by human approvers).

## A4 evidence and confidence enforcement

The gateway enforces the proposal-side halves of freeze A4 before any
execution: descriptors DECLARE their evidence slots and minimum confidence;
proposals CARRY the evidence references and confidence. A proposal missing a
declared slot or below the declared minimum is a typed rejection — and the
supplied references and confidence ride into the audit events of the
executions (and denials) they back, so the provenance survives the decision
trail.

## Source package — no build step

This package ships TypeScript source and is never compiled: the repository
is typecheck-gated (`pnpm typecheck` at the root spans `packages/**/*.ts`)
and the root vitest configuration runs the co-located tests. `main`,
`types`, and `exports` point directly at `src/index.ts`; workspace consumers
declare `"@office/actions": "workspace:*"` and import only from the package
root.

## How tests run

`pnpm test` at the repo root runs the eight co-located suites
(`descriptor`, `classification`, `proposal`, `handlers`, `registry`,
`audit-events`, `gateway`, `workflow-approval` — 114 tests). All tests are
deterministic: fixed identities and envelopes, an injected auto-ticking
clock and sequential id suppliers, the in-memory registry / handlers / sink /
idempotency registry / approval authority wired through the REAL gateway,
counting handlers for the handler-invocation proofs, and — for the workflow
seam suite — the REAL `@office/workflows` engine (in-memory store, commands,
sink) driven through the adapter. No wall clock, no randomness, no I/O, no
`DATABASE_URL`.

## Explicitly out of scope

SQL schemas, migrations, repositories, and any persistence wiring beyond the
shipped in-memory implementations; executing actions outside the gateway
function; provider vocabulary; domain-package imports; wall-clock reads or
randomness in logic. The runtime (later Office modules) owns the wiring of
real sinks, stores, and handlers.
