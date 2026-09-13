# @office/workflows

Workflow and approval engine for PaySwap Office (**OFF-016**).

`@office/workflows` is the pure-domain engine that turns business processes
into **versioned, immutable workflow definitions** executed by a
**deterministic state machine**: instances pin the exact definition version
they started from, tasks live a typed lifecycle with bounded retries and SLA
escalation measured against an injected clock, approval steps are gated by
required capabilities checked through the deny-by-default policy evaluator
(no bypass path — denials are audited), and every mutation emits typed audit
events through the EventSink port. The package depends only on
`@office/contracts`, `@office/domain-kernel`, `@office/authz`,
`@office/persistence` (the `SqlExecutor` type of the EventSink port), and
`@office/events` (the ledger-backed sink adapter) — no SQL, no migrations, no
repository layer, no external dependencies (dependency rule: pure domain, no
domain-to-domain imports; the EventSink port is mirrored in shape).

## What is here

| Area | Exports |
| --- | --- |
| Definition | `WorkflowModel` (+ state/transition/task/approval/retry/escalation types, the closed condition vocabulary), `parseWorkflowModel` and per-shape parsers, `retryBackoffSeconds`, the bound constants (`MAX_SLA_MINUTES`, `MAX_RETRY_ATTEMPTS`, …) |
| State | `WorkflowDefinitionState` / `WorkflowInstanceState` (+ `TaskState`, `ApprovalState`, statuses, invariants), the definition lifecycle (create/update/publish, `nextDefinitionVersionOf`), the deterministic machine (`transitionWorkflowInstanceState`, `conditionHolds`), the task/approval lifecycles, `escalateWorkflowInstanceState`, the pure timestamp arithmetic |
| Store | `WorkflowStore`, `createInMemoryWorkflowStore` — the pure-domain aggregate keeper (A12 visibility by construction) |
| Events | `EventSink` (the port), `InMemoryEventSink` / `createInMemoryEventSink`, `failingEventSink`, the eighteen `WORKFLOW_*_EVENT` name constants, `workflowEventEnvelope`, the payload builders, `createdRefs` / `updatedRefs` / `unchangedRefs` |
| Ledger sink | `createLedgerEventSink` (+ `LedgerEventSinkOptions`) — the transactional `appendEvent` + `enqueueOutbox` implementation of the port |
| Commands | `WorkflowCommands` (definition/instance/task/approval groups), `createWorkflowCommands`, `WorkflowCommandDeps`, `WorkflowCommandAuthorization`, `WorkflowCommandOutcome`, the fifteen `*_COMMAND` name constants (+ payload types and their fail-closed parsers) |

`src/index.ts` is the whole public surface; later Office modules
(OFF-017 action gateway, OFF-018 agent runtime, OFF-019 control tower, …)
import only from the package root. Anything not re-exported there is
package-internal and may change without notice.

## Definitions: versioned, immutable once published

A workflow definition is a fully validated `WorkflowModel`: a closed table of
states (`initial` / `normal` / `success` / `failure`), transitions guarded by
a closed condition vocabulary (`always`, `task-outcome`, `approval-decision`,
`all-tasks-settled`) and optionally requiring capabilities, tasks with typed
assignment (actor kinds + roles) and SLA minutes, approval steps carrying
their required capability + policy reference, a bounded retry policy, and
escalation rules. Parsing is total and fail-closed (strict keys, closed
tables, bound checks) — an invalid model never becomes a definition.

The lifecycle is one-way: definitions are created in `draft` (model
replacement allowed), and **publishing freezes them** — a published
definition has no update path (typed invariant-violation). **A definition
change is a NEW version row** of the same key; instances pin the exact
definition row (id, key, version) they started from and keep executing it
even after a newer version is published.

## Instances: the deterministic machine

`createWorkflowInstanceState` instantiates the pinned model: the machine
starts in the definition's initial state, tasks start `created` (attempt 0),
approvals start `pending`; only PUBLISHED definitions can start instances.
`transitionWorkflowInstanceState` executes one declared transition with the
frozen order **guard evaluation → capability check → state transition → task
lifecycle update** (leaving a state settles its still-open tasks as
`skipped`). It is pure: same definition + same instance state + same granted
capabilities + same injected `now` → the same resulting state, always. Every
failure is typed and leaves the machine untouched; the machine can never
enter an undefined state (targets are declared states by validation,
re-checked at execution as defense in depth). Reaching a `success` /
`failure` state completes / fails the instance terminally — terminal
instances never change.

## Tasks: typed lifecycle, bounded retries

`created → assigned → in-progress → completed | skipped | failed`. The SLA
deadline is pure timestamp arithmetic from the injected `now`
(`assignedAt + slaMinutes`). `failWorkflowTaskState` records the failure of
an attempt: while attempts remain under the definition's `maxAttempts` the
task stays retryable with a deterministic backoff gate
(`retryNotBefore = failure instant + backoff(attempts)`); when the attempts
are spent the task reaches the typed terminal outcome `exhausted` — no retry
path exists. `retryWorkflowTaskState` re-opens the task only after the gate
has elapsed (injected clock, never wall clock).

## Approvals: capability-gated, no bypass path

An approval step carries its required capability and policy reference ON the
aggregate, so every reader can verify what should have been held.
`submitWorkflowApprovalState` moves `pending → submitted`; the DECISION
(approve / reject) is reachable only through the command layer's gate: the
actor must hold the approval's required capability AND the deny-by-default
policy must allow the decision. The gate runs **before** the idempotency
registry, so a denial is never recorded — the same key re-runs the gate, and
even a previously recorded success cannot be replayed by an unauthorized
actor. Denials are audited as audit-only `workflows.approvalDenied` events
(same aggregate on both sides of `entityRefs`) recording the denial code,
the attempted decision, the required capability, and the policy reference.

## SLA escalation

`escalateWorkflowInstanceState` is a pure sweep against the injected clock: a
task escalates exactly when `now >= dueAt` (millisecond precision), it is
still open, it has not escalated before (one-shot), and the pinned definition
carries a rule for it (task key or `*`). Escalation REASSIGNS per the
definition rule — the machine never invents an assignee — and is audited per
escalated task. When nothing escalates the instance is returned unchanged
(no version bump, no event).

## Commands and the EventSink port

`createWorkflowCommands` wires the pure transitions into the command
pipeline: fail-closed payload parsing → project-scope requirement (A12) →
deny-by-default authorization → idempotency (same (scope, key) replays the
recorded outcome; failures are never recorded) → load → optimistic
concurrency (stale version → typed conflict) → invariant-checked pure
transition → EventSink append + store commit (a sink failure aborts the
mutation). `now` and `newOpaqueId` are injected suppliers — deterministic in
tests, wall clock / randomness in production wiring.

The `EventSink` port is minimal: `appendEvents(executor, events)` writes the
audit events inside the caller's open transaction. The in-memory sink
records appends (tests); `createLedgerEventSink` implements the port
transactionally over `@office/events` (`appendEvent` + `enqueueOutbox`).

## Source package — no build step

This package ships TypeScript source and is never compiled: the repository is
typecheck-gated (`pnpm typecheck` at the root spans `packages/**/*.ts`) and
the root vitest configuration runs the co-located tests. `main`, `types`, and
`exports` point directly at `src/index.ts`; workspace consumers declare
`"@office/workflows": "workspace:*"` and import only from the package root.

## How tests run

`pnpm test` at the repo root runs the four co-located suites
(`definition.test.ts`, `state.test.ts`, `events.test.ts`,
`commands.test.ts` — 190 tests). All tests are deterministic: fixed
identities and envelopes, an injected clock (`setClock` / `setNow`), an
auto-ticking sequential id supplier, the in-memory store/sink/idempotency
registry wired through the REAL command service, and loud fixture guards —
no wall clock, no randomness, no I/O, no `DATABASE_URL`.

## Explicitly out of scope

SQL schemas, migrations, repositories, and any persistence wiring beyond the
shipped in-memory store and the ledger-backed EventSink adapter; provider
vocabulary; domain-to-domain imports; wall-clock reads or randomness in
logic. The runtime (later Office modules) owns the wiring.
