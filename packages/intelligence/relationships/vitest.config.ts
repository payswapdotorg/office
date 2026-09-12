import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// OFF-013 LOCAL vitest config — a standalone single-package runner.
//
// The workspace-glob gap this file was originally written for is CLOSED on
// this branch: pnpm-workspace.yaml now lists `packages/intelligence/*` (the
// same additive widening OFF-007 received for `packages/domain/*`), and the
// root vitest include lists `packages/intelligence/*/src/**/*.test.ts` —
// so `pnpm install` links this package's workspace dependencies and the
// root `pnpm test` discovers and runs this suite through the root config.
//
// This file remains a harmless convenience runner for iterating on this
// package alone (it resolves the four workspace dependencies to their
// source entry points — exactly what the pnpm workspace links resolve to):
//
//   pnpm exec vitest run -c packages/intelligence/relationships/vitest.config.ts
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@office/contracts': here('../../../contracts/src/index.ts'),
      '@office/domain-kernel': here('../../../domain-kernel/src/index.ts'),
      '@office/authz': here('../../../authz/src/index.ts'),
      '@office/events': here('../../../events/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
