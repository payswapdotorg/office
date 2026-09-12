# @office/intelligence-relationships

The canonical **cross-domain relationship engine** (OFF-013): a deterministic,
rebuildable read **projection** that indexes `affects` / `depends-on` /
`evidenced-by` / `impacts` / `derives-from` relationships between canonical
entities — derived from the landed domain packages' event envelopes — with
traversal queries that enforce authorization **at traversal time** and
causal-chain queries that reconstruct the command/event chain that produced
each relationship.

The relationship graph is a **projection, never a second source of truth**
(freeze A2/A7): it is derived from the event ledger, holds no entity data
(only ids/refs), and can be dropped and rebuilt from the same event stream at
any time. This package never writes the ledger — it reads it through a port.

## Dependencies (the dependency rule)

Workspace dependencies only — `@office/contracts` (envelope + identity
contracts), `@office/domain-kernel` (`Result`/`DomainError`),
`@office/authz` (`authorize` + structural scope isolation), and
`@office/events` (the ledger READ surface + deterministic ledger event id
derivation). The domain packages (organization/projects/documents/field/
schedule/cost/contracts) are **never imported**: their event *shapes* are
consumed through `@office/contracts` envelope types only — the relationship
engine is a projection, not a domain peer. No external dependencies.

## The relationship vocabulary

Five canonical directed-edge kinds, each carrying its derivation provenance
(the ledger event that asserted it):

| kind          | semantics |
| ------------- | --------- |
| `affects`     | the subject materially influences the object's state (a commitment affects its budget; an invoice affects its commitment; a progress update affects its activity) |
| `depends-on`  | the subject cannot start or complete without the object (a successor activity depends on its predecessor; a milestone on its bound activity) |
| `evidenced-by`| the subject's status or claims are supported by an evidence document revision (a change event evidenced by a revision; a field event by a linked entity; a claim by a revision) |
| `impacts`     | the subject is a CHANGE whose consequence lands on the object (a change event impacting a budget, cost item, or activity) |
| `derives-from`| the subject was produced from the object (a revision from its document or prior revision; a baseline from the schedule; a change order from its change event; a claim from its change order) |

`src/vocabulary.ts` also declares the local typed **entity-kind** vocabulary
(the landed packages' declared kinds) and the **recognized event names**
(exactly the landed domain packages' event vocabularies). Kinds map to their
bounded-context area read capability (`cost.read` for budget nodes,
`schedule.read` for activity nodes, …); a kind outside the vocabulary has no
determinable area, so no capability can ever grant it — deny-by-default.

## Projection semantics + rebuildability

`projectRelationships(events)` (src/projection.ts) folds a ledger event
stream — read through the `RelationshipEventSource` port (src/source.ts) —
into the relationship index. **Deterministic by construction**: events are
consumed in ledger order, edge identity is `(kind, from, to)`, the fold keeps
the most recent asserting event's provenance per edge and honors explicit
removals (`schedule.dependencyRemoved`), and every output collection is
canonically sorted. No clock, no randomness, no environment: the same event
stream always projects to a byte-identical index, and rebuilding from scratch
is the same function (A7).

Event-name recognition: exactly the landed vocabularies. **Unknown event
names are skipped deterministically** — fail-open for future packages,
tallied in the index's derivation metadata, never a crash and never a silent
data invention. A *recognized* event name with a malformed payload is a typed
`invariant-violation` instead: the ledger's payloads were domain-validated at
append time, so corruption fails closed rather than guessing.

Derivation rules (ids and refs only): `documents.revisionAttached`/
`revisionSuperseded` → `(revision) derives-from (document[, prior revision])`;
`documents.evidenceReferenced` → `(entity) evidenced-by (revision)`;
`field.fieldEventCaptured`/`fieldEventEvidenceAttached` → `(field event)
evidenced-by (each evidence link entity)`; `schedule.activityAdded` →
`(activity) derives-from (parent)`; `schedule.dependencyAdded`/`Removed` →
`(successor) depends-on (predecessor)` added/removed; `schedule.milestoneAdded`
→ `(milestone) depends-on (bound activity)`; `schedule.baselineSet` →
`(baseline) derives-from (schedule[, superseded baseline])`;
`schedule.progressRecorded` → `(progress update) affects (activity)`;
`cost.costItemRecorded` → `(cost item) derives-from (budget)`;
`cost.budgetRevised` → `(budget revision) derives-from (budget[, prior
revision])`; `cost.commitmentCreated` → `(commitment) affects (budget)`;
`cost.commitmentAmended` → `(amendment) derives-from (commitment)`;
`cost.invoiceRecorded` → `(invoice) affects (commitment)`;
`cost.paymentReferenced` → `(payment reference) affects (invoice, commitment)`;
`contracts.changeEventRaised`/`changeEventLinked` → `(change event) affects
(obligations), evidenced-by (revisions), impacts (budgets, cost items,
activities)`; `contracts.changeOrderSubmitted` → `(change order) derives-from
(change event)`; `contracts.claimReferenced` → `(claim) evidenced-by
(revision) and derives-from (change order)`. Lifecycle/audit events with no
cross-entity links contribute their aggregate node only.

## Traversal + the authorization contract

`traverseRelationships(index, query, authorization)` (src/traversal.ts)
answers a `TraversalQuery` — start entity, optional relationship-kind filter,
depth limit (1..16), optional entity-kind filter, edge direction
(`outgoing`/`incoming`/`both`) — with the reachable subgraph (nodes with
smallest-depth, canonically ordered, plus the traversed edges).

Authorization is enforced **at traversal time, never baked into the stored
index** (src/authorization.ts): the projection is scope-blind, and every
candidate node passes `checkNodeReadable` — (1) structural scope coverage
(freeze A12: cross-tenant/cross-project is a typed denial no rule can
override), (2) the entity kind's area read capability (deny-by-default,
including unknown kinds), (3) the caller's policy through `authorize()`
(explicit deny wins; first allow grants; otherwise deny). An unreadable node
is **invisible**: absent from the subgraph, its edges dropped, paths through
it nonexistent — the graph is never an existence oracle, in either direction.
The start node is special-cased: a scope-uncovered start is a typed
`not-found` (identical to reading a foreign ledger row and to querying a
nonexistent entity), a capability/policy denial of the start is the typed
`forbidden` error — so "no relationships" is never conflated with "not
visible".

## Causal-chain queries

`causalChainOfRelationship(relationship, source, authorization)` and
`causalChainsOf(index, source, entity, authorization)` (src/causality.ts)
reconstruct the chain of commands and events that produced a relationship
(or an entity's current relationships), walking **backward** from each edge's
provenance event through the ledger's causality convention: an event's
causation id is the causing command's idempotency key (the chain root) or the
ledger id of a prior event (keep walking). Chains are root-first, end with
the edge's producing event, and every step is authorization-filtered — an
unreadable or absent causing event terminates the chain without leaking its
existence.

## Test wiring

The suite lives in `src/*.test.ts` (projection, traversal, authorization,
causality) and runs under the **root** `pnpm test` like every workspace
package: `pnpm-workspace.yaml` lists `packages/intelligence/*` and the root
`vitest.config.ts` includes `packages/intelligence/*/src/**/*.test.ts` (the
same additive widening OFF-007 applied to `packages/domain/*`). A local
`vitest.config.ts` remains as a standalone single-package runner:

```
pnpm exec vitest run -c packages/intelligence/relationships/vitest.config.ts
```

The tests are deterministic (fixed clock, fixed ids, fixed
correlation/causation tokens, injected suppliers — no `Date.now`, no
`Math.random`) and prove the acceptance gates: golden-fixture traversals for
the named construction causal chains (schedule dependency chain; change event
evidenced-by a revision and impacting cost + schedule; field event
evidenced-by its document), same-stream-twice and rebuild-from-scratch
identity, traversal-time typed denials and scope-filtered subgraphs, A12
cross-tenant/cross-project invisibility in both directions with no existence
oracle, per-edge producing-event provenance, and full causal-chain
reconstruction through command causation.

## Known envelope gap (reported)

No landed field-package event carries activity references, so the acceptance
example "a field issue affecting an activity" has **no envelope source**: the
engine derives it from no data rather than inventing it. The field evidence
coverage that IS derivable (a captured field event evidenced-by its linked
document) is indexed and golden-tested; the transitive field-issue → change
order → change event → activity path is covered by the change-event golden.
Closing the gap needs a field-domain event carrying activity references.
