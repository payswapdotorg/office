# Office Dependency Graph

This is the execution control plane. A work item is READY only when every declared dependency is DONE and its outputs are verified.

## Readiness

- Bootstrap: only `OFF-001`.
- After `OFF-001`: only `OFF-002`.
- After `OFF-002`: only `OFF-003`.
- After `OFF-003`: `OFF-004` and `OFF-006` may run concurrently; `OFF-005` waits for its prerequisites.
- After `OFF-004` + `OFF-006`: `OFF-007` becomes eligible.
- After the required Phase 2 foundations: prefer three disjoint domain workers from `OFF-008` through `OFF-012` according to the exact dependency fields in `WORK_ITEMS.md`.
- Later readiness is always calculated from exact predecessor completion. There are no implicit governance lanes.

## DAG summary

```text
001 -> 002 -> 003
003 -> 004 -> 005
003 -> 006
004+006 -> 007
005+007+006+004 -> 008,009,010,011,012
008+009+010+011+012+005 -> 013
013+010+011+012 -> 014
007+010+011+013+014 -> 015
005+006+013 -> 016
003+005+006+016 -> 017
013+014+015+016+017 -> 018
013+014+015+016 -> 019
002+005+006+007+010+011 -> 020
020 -> 021,022,023,024,025
025+017+006 -> 026 -> 027
005+006+013 -> 028 -> 029 -> 031
002+025+028+029 -> 032
012+014+018+019 -> 033
011+014+015+018 -> 034
020+025+027+015 -> 035
004+005+006+017+026+029 -> 036
021+022+023+024+030+033+034 -> 037
036+037 -> 038 -> 039 -> 040
```

## Parallelization rules

At most three workers may be active concurrently.

Prefer workers with:
- separate ownership boundaries;
- no shared unfinished contract;
- no dependency on another active worker's branch;
- independently reviewable tests.

Good examples include `OFF-004` + `OFF-006`, then `OFF-008` + `OFF-009` + `OFF-010`, and after the adapter SDK, three separate provider adapter items such as `OFF-021` + `OFF-022` + `OFF-023`.

## Conflict rules

1. One worker owns a canonical contract at a time.
2. Workers touch only their declared bounded-context paths plus focused tests/docs.
3. Cross-context changes require an explicit contract item or Tech Lead decision.
4. No opportunistic refactors.
5. Provider adapters cannot change canonical domain semantics directly.
6. Merge order follows the DAG, not PR arrival order.
7. Never combine multiple OFF IDs into one implementation branch/PR.
