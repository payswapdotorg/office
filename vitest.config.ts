import { defineConfig } from 'vitest/config';

// Office root vitest config (OFF-001).
// `pnpm test` runs every workspace test; `pnpm test:architecture` passes the
// `tests/architecture` path filter to limit this same config to the
// architecture convention suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
    ],
  },
});
