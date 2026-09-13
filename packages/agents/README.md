# @office/agents — Agent runtime (OFF-018)

The evidence-grounded agent runtime of the Office construction OS: typed agent
runs over an injected tool registry and a deterministic mock model harness,
whose ONLY mutation path is the `@office/actions` gateway (freeze A8), whose
consequential recommendations REQUIRE a grounded `EvidenceSet` (freeze A4),
and whose every decision lands in an auditable execution record.

## The A8 contract (the acceptance heart)

- **Gateway-mediated mutations only.** An agent run proposes typed actions
  (`ProposedAction`) and hands them to `executeAction()` from
  `@office/actions`. There is no other write path: the package imports no
  persistence, no domain packages, and no store of canonical state. Tests
  prove it by counting handler invocations through the gateway and by a
  boundary self-scan of the import graph.
- **Evidence before consequence.** Proposing an approval-required or
  reversible action with an empty/unqualified `EvidenceSet` is a typed
  rejection raised BEFORE the gateway is called. Executed proposals carry
  their evidence references into the audit trail.
- **Approval handoff.** When the gateway routes a proposal to approval, the
  run parks with the linked `ApprovalReference`; it completes only after an
  explicit approved resolution re-enters the gateway (denied decisions close
  the run without mutation).

## Public surface

| Export | Purpose |
| --- | --- |
| `AgentRunInput`, `runAgentGoal` | The run entrypoint: goal + context refs + actor + policy → recorded run |
| `AgentRunRecord` | The versioned record: input, evidence set, tool invocations, proposals, outcome, provenance |
| `EvidenceSet`, `evidenceSet()`, `parseEvidenceSet` | The typed evidence bundle; every item carries retrieval provenance |
| `Tool` registry types | Read-only tools (relationship traversal, margin assessment, memory lookup) vs the model-proposer tool |
| `ProposedAction` | Command envelope + evidence refs + confidence + rationale |
| `resolveApproval` | Approval resolution handoff (re-enters the gateway; executes exactly once) |
| `agentEventEnvelope` + payload parsers | A3 audit envelopes: run started, evidence gathered, action proposed, gateway decision, run completed |
| `ModelPort` + deterministic mock | The injected model harness — the runtime NEVER calls a real model |
| `createAgentEventSink`, `failingAgentEventSink` | In-memory + failure-path EventSink implementations |

## Determinism

All logic reads the injected clock and id suppliers — no `Date.now`, no
`Math.random`. The mock model is fixture-scripted: replaying the same goal +
evidence produces byte-identical runs (run-twice tests).

## Tests

`pnpm test` at the repo root runs the suite (packages/agents/src/*.test.ts):
the gateway-mediated mutation acceptance, evidence-required recommendations,
deterministic replay, the actor-kind deny-by-default matrix, approval
handoff (including force-execute rejection), audit envelope round-trips, and
the boundary self-scan.
