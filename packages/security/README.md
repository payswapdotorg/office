# @office/security — Security/audit hardening (OFF-036)

The cross-cutting security and audit hardening package of the Office
construction OS: the security conformance suite (proving tenant isolation,
authorization boundaries, audit completeness, and revocation across the REAL
gateway and app-runtime), access-review derivation, sensitive-action alert
rules, and retention policy contracts.

## The conformance suite (the acceptance heart)

Drives the REAL `@office/actions` gateway and the REAL `@office/app-runtime`
(in-memory wiring) through deterministic golden scenarios:

- **Tenant isolation (A12)** — cross-tenant attempts typed-rejected with no
  side effects, both directions, across gateway commands and app dispatch.
- **Authorization boundaries** — deny-by-default matrices across actor kinds;
  no actor-kind bypass; handler-invocation counting proves rejection happens
  BEFORE execution.
- **Audit completeness (A3)** — every consequential mutation produces its
  audit envelope; completeness counting across gateway decisions, app
  dispatches, agent runs, and sync conflicts; duplicates surface as failures.
- **Revocation (A9)** — suspended/revoked installations receive nothing.

## Public surface

| Export | Purpose |
| --- | --- |
| `createInMemoryAuditLedger`, `auditEventClassOf` | The audit-trail ledger + the four platform audit classes (actions/apps/agents/sync) |
| `makeConformanceHarness`, `driveTenantIsolationProbes`, `driveConsequentialMutations` | The conformance drivers over the real gateway/app-runtime |
| `evaluateTenantIsolation`, `evaluateAuthorizationBoundaries`, `evaluateAuditCompleteness`, `evaluateRevocation` | The deterministic conformance evaluations |
| `reviewSubjectAccess` | AccessReview derivation from the audit trail (A7: derived, deterministic; A12-scoped) |
| `parseSensitiveActionAlertRule`, alert evaluation | Typed rule descriptors + deterministic evaluation over the audit stream |
| `defineRetentionRuleSet`, retention evaluation | Typed retention contracts — pure data + evaluation (the ledger is immutable; rules are applied by the runtime, never deletion here) |
| `composeSecurityAuditReport` | The typed conformance report over a scenario |

## Determinism

All logic reads injected clock/id suppliers — no `Date.now`, no
`Math.random`. The same audit stream produces identical reviews, alerts, and
reports (run-twice tests).

## Tests

`pnpm test` at the repo root runs the suite (packages/security/src/**):
the conformance suites, access-review derivation (including the
no-evidence sole-finding semantics), alert-rule grammar (strict kebab-case),
retention invariants (every audit class covered — the immutable-audit-trail
rule), and the boundary self-scan.
