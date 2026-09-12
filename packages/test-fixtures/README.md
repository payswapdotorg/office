# @office/test-fixtures

Deterministic test fixtures shared across the Office workspace.

## Status (OFF-001)

Currently holds the deliberately trivial smoke fixture (`src/smoke.test.ts`)
that proves the root vitest setup (`vitest.config.ts` at the repository root)
discovers and runs tests that live inside workspace packages. Run it from the
repository root:

```sh
pnpm test
```

Future work items will add reusable fixtures here (for example: fake provider
payloads for adapter suites, deterministic traversal graphs, seeded
construction scenarios) instead of duplicating them inside individual
packages.

## Fixture rules

- Fixtures must be **deterministic**: no wall-clock time, no network, no
  database dependence.
- Fixtures carry no business logic; they are data and builders only.
