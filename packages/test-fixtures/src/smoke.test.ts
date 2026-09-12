import { describe, expect, it } from 'vitest';

// OFF-001 smoke fixture: proves the root vitest configuration discovers and
// runs tests that live inside workspace packages. Kept deliberately trivial —
// real fixtures arrive with the work items that need them.
describe('@office/test-fixtures smoke', () => {
  it('executes under the root vitest configuration', () => {
    expect(2 + 2).toBe(4);
  });

  it('compiles as strict TypeScript', () => {
    const values: readonly number[] = [1, 2, 3];
    const total = values.reduce((sum, value) => sum + value, 0);
    expect(total).toBe(6);
  });
});
