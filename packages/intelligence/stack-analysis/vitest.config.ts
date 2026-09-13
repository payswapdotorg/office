import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// OFF-035 LOCAL vitest config — a standalone single-package runner.
//
// The workspace-glob widening landed with OFF-013 already covers this
// package: pnpm-workspace.yaml lists `packages/intelligence/*` and the root
// vitest include lists `packages/intelligence/*/src/**/*.test.ts` — so
// `pnpm install` links this package's workspace dependencies and the root
// `pnpm test` discovers and runs this suite through the root config (NO
// config change was needed for this work item).
//
// This file remains a harmless convenience runner for iterating on this
// package alone (it resolves the seven workspace dependencies to their
// source entry points — exactly what the pnpm workspace links resolve to):
//
//   pnpm exec vitest run -c packages/intelligence/stack-analysis/vitest.config.ts
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@office/contracts': here('../../../contracts/src/index.ts'),
      '@office/domain-kernel': here('../../../domain-kernel/src/index.ts'),
      '@office/authz': here('../../../authz/src/index.ts'),
      '@office/adapters-sdk': here('../../../adapters-sdk/src/index.ts'),
      '@office/app-sdk': here('../../../app-sdk/src/index.ts'),
      '@office/marketplace': here('../../../marketplace/src/index.ts'),
      '@office/intelligence-memory': here('../memory/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
