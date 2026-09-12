# @office/authz

Authorization and policy kernel for PaySwap Office (**OFF-006**) — the
deny-by-default evaluator every read/write path authorizes through: the
declared capability vocabulary, role→capability primitives, the
service-to-service `AuthorizationContext`, `ResourceScope`, and the pure,
data-driven `authorize()` policy evaluator.

The package depends on exactly two things: **`@office/contracts`** and
**`@office/domain-kernel`** (workspace dependencies). No persistence, no
event ledger, no outbox, no I/O, no clock or randomness — verified by
`src/boundary.test.ts`.

## What is here

| Area | Exports |
| --- | --- |
| Capability | `Capability` (+ `CapabilityName`), `Action`, `CAPABILITIES`, `capability()`, `capabilityAction()`, `parseCapability`, `isCapability` |
| Roles | `Role`, `RoleDefinition`, `ROLE_DEFINITIONS`, `defineRole`, `parseRole`, `isRole`, `roleCapabilities`, `expandRoles` |
| Resource scope | `ResourceScope`, `resourceScope`, `parseResourceScope`, `isResourceScope`, `checkScopeCoversResource` |
| Context | `AuthorizationContext`, `authorizationContext`, `parseAuthorizationContext`, `isAuthorizationContext` |
| Policy | `Policy`, `PolicyRule`, `PolicyEffect`, `AuthorizationDecision`, `definePolicy`, `definePolicyRule`, `parsePolicy`, `parsePolicyRule`, `isPolicy`, `isPolicyRule`, `authorize` |

`src/index.ts` is the whole public surface; import only from the package
root. `Scope`, `Actor`, `EntityId`/`EntityKind` and the `Result`/
`DomainError` taxonomy come from `@office/contracts` /
`@office/domain-kernel` — this package re-exports nothing.

## The evaluation pipeline (never silently allows)

`authorize(policy, context, resource, action)` is a pure function of its
inputs — policies are static values (ordered declarative rules), evaluation
holds no global state, and the same inputs always produce the same outputs:

1. **Structural isolation (freeze A12)** — the context scope must cover the
   resource scope. Cross-tenant access, and cross-project access within a
   tenant, are typed `unauthorized` denials with detail code
   `tenant-scope-violation` / `project-scope-violation`, produced BEFORE any
   rule is consulted — no policy rule can ever allow them. A project-scoped
   request may still reach tenant-wide resources of the same tenant, and a
   tenant-scoped request covers all of its tenant's resources.
2. **Explicit deny** — any matching `deny` rule wins immediately: typed
   `forbidden` with detail code `explicit-deny`.
3. **Allow** — the first matching `allow` rule grants access; the
   `AuthorizationDecision` carries the rule index for audit trails.
4. **Default deny** — no matching allow rule: typed `forbidden` with detail
   code `no-allow-rule`.

`unauthorized` vs `forbidden` (this package owns the kernel taxonomy's
refinement): scope denials are `unauthorized` — the request's scope does not
cover the target; policy denials are `forbidden` — the actor is identified
but no rule grants the access. Reads and writes are distinct actions
(`'read' | 'write'`), and the capability vocabulary encodes the same split
structurally (`projects.read` ≠ `projects.write`).

Rule matching is conjunctive: every present field must match
(`actorKinds`, `actorIds`, `capabilities` — all-of, `resourceKinds`,
`actions`, `ownedByActor`); omitted fields match anything. `actorIds` and
`ownedByActor` rules never match the id-less system actor. Denials carry the
request scope (never the foreign resource's) plus the supplied correlation
id.

## Capability vocabulary

Declared, closed, typed: `'<area>.<read|write>'` over the canonical
bounded-context resource areas (organization, people, projects, documents,
models, work, schedule, cost, procurement, contracts, quality, workflows,
apps). `parseCapability` is fail-closed — grammar violations AND
well-formed-but-undeclared names are both rejected — so an unknown
capability can never enter a context, role definition, or policy rule
through a parse boundary. Extending the vocabulary is an authz-owner change
(this package); capability strings arriving from app manifests (OFF-025) or
agent grants (OFF-018) must pass `parseCapability` first.

## Roles

`ROLE_DEFINITIONS` maps the declared roles (`tenant-admin`,
`project-manager`, `cost-manager`, `scheduler`, `field-engineer`, `viewer`)
onto capability sets. `parseRole` fails closed on undeclared names;
`expandRoles` unions grants deterministically in vocabulary order
(overlapping grants collapse). Roles are the human-assignment vocabulary —
they are resolved into capabilities when an `AuthorizationContext` is
built and play no part in evaluation itself.

## Service-to-service authorization

Apps, agents, and adapters authorize through the SAME evaluator with the
SAME `AuthorizationContext` shape — `{ actor, scope, capabilities }` —
carrying their own actor kinds: an app installation its manifest-declared
capabilities (A7), an agent run its granted set (A8), an adapter its granted
integration set (A5). There is no special-cased service path; the only
actor-kind awareness lives in policy rules (`actorKinds` matching).
Structural tenant/project isolation applies identically to every actor
kind.

## Result style

Expected authorization failures are values, never exceptions: `authorize`
and `checkScopeCoversResource` return `Result<T, DomainError>` from
`@office/domain-kernel`, so callers branch on `ok` and transport surfaces
translate via the kernel's `toApiError`. Untrusted inputs parse through
`ParseResult` (contracts' typed `ContractParseError`); throwing is reserved
for loud `TypeError`s on the trusted construction path (`capability()`,
`defineRole`, `resourceScope()`, `authorizationContext()`,
`definePolicyRule`) — same convention as the contracts `parse`/`format`
pair.

## Source package — no build step

Ships TypeScript source; the repository is typecheck-gated at the root
(`pnpm typecheck` spans `packages/**/*.ts`) and the root vitest config runs
the co-located deterministic tests (`pnpm test` — no DB, no I/O, no clock,
no randomness). Consumers declare:

```json
{ "dependencies": { "@office/authz": "workspace:^" } }
```

## Explicitly out of scope

- Action classification (read / reversible write / approval-required /
  prohibited) and idempotent execution — OFF-017 action gateway.
- App manifests, installation lifecycle, suspend/revoke — OFF-025/OFF-026.
- Role/tenant administration commands and their persistence — OFF-004 and
  the identity domains (OFF-007+).
- Workflow approval state machines — OFF-016.
- Provider vocabulary of any kind — adapters (OFF-020+) only.
