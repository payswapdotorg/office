# ADR-005: Evidence-Grounded Agent Execution

Status: Accepted / Frozen

## Decision

Agents operate through a typed Action Gateway. They cannot mutate the database directly and cannot invent canonical facts.

Every agent run has:

- agent identity/version
- tenant/project scope
- authorized context/evidence set
- model/provider metadata
- prompt/policy version
- proposed commands
- tool calls
- confidence/evaluation signals
- approval state
- execution result
- emitted domain event IDs

## Action classes

### Read

No state mutation. Examples: search documents, inspect schedule, calculate exposure.

### Reversible write

Mutation with an explicit inverse or safe correction path. Examples: create draft task, add note, draft notification.

### Approval-required write

Commercial, contractual, financial, schedule-baseline, permission, destructive, or externally consequential changes. The default is explicit approval.

### Prohibited

Direct database writes, credential extraction, cross-tenant reads, permission escalation, silent deletion of canonical evidence, or disabling audit/history.

## Evidence contract

A consequential recommendation must cite the canonical objects/events that support it. A proposed action must expose the causal chain where available.

Example:

```text
Drawing revision 48
 -> model elements changed
 -> quantity delta
 -> BOQ delta
 -> affected schedule activities
 -> contract scope comparison
 -> potential change event
```

## Human control

Approval requests show proposed effect, affected objects, evidence, confidence, and rollback/compensation strategy. Policies can grant bounded automation to low-risk action classes.

## Idempotency

Every external/agent command carries an idempotency key. Replays of the same command cannot duplicate financial or contractual effects.

## Evaluation

Agent actions have deterministic policy tests and domain-level regression tests. AI quality evaluation is additive; it cannot replace domain invariant tests.
