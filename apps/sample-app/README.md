# @office-sample/app

The **reference marketplace app** for the Office App SDK (**OFF-025**). It is
the proof of the SDK's acceptance boundary: a marketplace app compiles against
**only** `@office/app-sdk` + `@office/contracts` — its import graph contains
no domain, intelligence, sync, adapters, agents, or client-sync packages —
and it ships a **typed `AppManifest`**, never executable core code.

## What it is

The whole app is [`src/manifest.ts`](src/manifest.ts): the *Field Progress
Tracker* manifest, composed through the SDK's trusted `appManifest()` builder —

- **Permissions (A9)** — two explicit, versioned, project-scoped capability
  declarations (`work.read`, `work.write`) from the closed `@office/authz`
  vocabulary. No wildcards are expressible.
- **One command binding** — the app offers to serve the reversible
  `field.recordProgress` command through a **symbolic handler contract**
  (`record-progress-handler`): the app runtime (OFF-026) resolves the slug to
  installed handler code at execution time, behind the action gateway. The
  manifest carries no code, no paths, no URLs.
- **One event subscription** — the canonical `work.progressRecorded` event
  with a typed `{ kind: 'entity-kind', entityKind: 'field-report' }` filter.
  Delivery is installation-scoped and at-least-once.

No UI extensions and no app-contract dependencies yet — both stay explicit
(empty arrays), never omitted.

## The boundary test

[`src/boundary.test.ts`](src/boundary.test.ts) enforces the acceptance:

1. `package.json` declares exactly `@office/app-sdk` + `@office/contracts`
   (no other dependencies of any kind);
2. every application source file imports only those two packages (belt and
   braces: no other `@office/*` package appears anywhere in the app source);
3. the manifest round-trips the SDK's fail-closed parse unchanged and its
   command/event/entity-kind references round-trip the canonical
   `@office/contracts` parses.

## Running the checks

The app is a source package with no build step and no scripts of its own
(the same convention as the packages). The root toolchain covers it:

```bash
pnpm install
pnpm lint
pnpm typecheck   # root tsconfig spans apps/**/*.ts
pnpm test        # root vitest includes apps/*/src/**/*.test.ts
```
