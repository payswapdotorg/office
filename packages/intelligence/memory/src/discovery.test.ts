import { describe, expect, it } from 'vitest';
import { MEMORY_ENGINE } from './model';

// Discovery probe (OFF-015 attempt 2): confirms the root vitest config's
// `packages/intelligence/*/src/**/*.test.ts` glob picks this package's suite
// up through `pnpm test`. Kept trivial on purpose — the real acceptance
// coverage lives in the focused suite files.
describe('test discovery probe (OFF-015)', () => {
  it('discovers the memory suite through the root vitest config', () => {
    expect(MEMORY_ENGINE).toBe('intelligence-memory');
  });
});
