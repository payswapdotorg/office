import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// OFF-015 LOCAL vitest config — a standalone single-package runner.
//
// The workspace-glob widening landed with OFF-013 already covers this
// package: pnpm-workspace.yaml lists `packages/intelligence/*` and the root
// vitest include lists `packages/intelligence/*/src/**/*.test.ts` — so
// `pnpm install` links this package's workspace dependencies and the root
// `pnpm test` discovers and runs this suite through the root config (NO
// config change was needed for this work item).
//
// This file remains a harmless convenience runner for iterating on this
// package alone (it resolves the six workspace dependencies to their source
// entry points — exactly what the pnpm workspace links resolve to):
//
//   pnpm exec vitest run -c packages/intelligence/memory/vitest.config.ts
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@office/contracts': here('../../../contracts/src/index.ts'),
      '@office/domain-kernel': here('../../../domain-kernel/src/index.ts'),
      '@office/authz': here('../../../authz/src/index.ts'),
      '@office/events': here('../../../events/src/index.ts'),
      '@office/intelligence-relationships': here('../relationships/src/index.ts'),
      '@office/intelligence-margin': here('../margin/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
