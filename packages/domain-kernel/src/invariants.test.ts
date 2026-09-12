import { describe, expect, it } from 'vitest';
import { formatTenantId, parseTenantId } from '@office/contracts';
import type { ParseResult, Scope, TenantId } from '@office/contracts';
import { checkInvariants, defineInvariant } from './index';
import type { DomainError, Invariant } from './index';

// OFF-003 domain kernel — invariant helper tests. Deterministic: fixed
// states, pure predicates.

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const tenantA: TenantId = unwrap(
  parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_A_OPAQUE })),
);
const scope: Scope = { kind: 'tenant', tenantId: tenantA };

interface ChecklistState {
  readonly itemCount: number;
  readonly doneCount: number;
}

const DONE_WITHIN_ITEMS: Invariant<ChecklistState> = defineInvariant(
  'done-count-within-item-count',
  'done count never exceeds item count',
  (state) => state.doneCount <= state.itemCount,
);

const NON_NEGATIVE_COUNTS: Invariant<ChecklistState> = defineInvariant(
  'counts-non-negative',
  'counts are never negative',
  (state) => state.itemCount >= 0 && state.doneCount >= 0,
);

describe('invariant declaration (trusted path)', () => {
  it('declares invariants as data with a pure predicate', () => {
    expect(DONE_WITHIN_ITEMS.name).toBe('done-count-within-item-count');
    expect(DONE_WITHIN_ITEMS.statement).toBe('done count never exceeds item count');
    expect(DONE_WITHIN_ITEMS.holds({ itemCount: 3, doneCount: 2 })).toBe(true);
    expect(DONE_WITHIN_ITEMS.holds({ itemCount: 3, doneCount: 4 })).toBe(false);
  });

  it('throws loud TypeErrors for malformed declarations', () => {
    expect(() => defineInvariant('NotKebab', 'x', () => true)).toThrow(TypeError);
    expect(() => defineInvariant('has__double', 'x', () => true)).toThrow(TypeError);
    expect(() => defineInvariant('ok-name', '', () => true)).toThrow(TypeError);
    expect(() => defineInvariant('ok-name', 'statement', undefined as never)).toThrow(
      TypeError,
    );
  });
});

describe('invariant checking (result-style, never bare throws)', () => {
  it('passes the state through when every invariant holds', () => {
    const state: ChecklistState = { itemCount: 3, doneCount: 3 };
    const result = checkInvariants(state, [DONE_WITHIN_ITEMS, NON_NEGATIVE_COUNTS]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(state);
  });

  it('returns a typed invariant-violation carrying the invariant name', () => {
    const result = checkInvariants(
      { itemCount: 3, doneCount: 4 },
      [NON_NEGATIVE_COUNTS, DONE_WITHIN_ITEMS],
      { scope },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error: DomainError = result.error;
      expect(error.kind).toBe('domain-error');
      expect(error.code).toBe('invariant-violation');
      expect(error.message).toBe(
        "invariant 'done-count-within-item-count' violated: done count never exceeds item count",
      );
      expect(error.details).toStrictEqual([
        {
          code: 'done-count-within-item-count',
          message: 'done count never exceeds item count',
          path: null,
        },
      ]);
      expect(error.scope).toStrictEqual(scope);
      expect(error.correlationId).toBeNull();
    }
  });

  it('reports the FIRST violated invariant in declaration order (deterministic)', () => {
    // Both invariants fail for this state, so declaration order decides.
    const state: ChecklistState = { itemCount: -1, doneCount: 0 };
    const result = checkInvariants(state, [NON_NEGATIVE_COUNTS, DONE_WITHIN_ITEMS]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('counts-non-negative');
    }
    const reordered = checkInvariants(state, [DONE_WITHIN_ITEMS, NON_NEGATIVE_COUNTS]);
    expect(reordered.ok).toBe(false);
    if (!reordered.ok) {
      expect(reordered.error.details[0]?.code).toBe('done-count-within-item-count');
    }
  });

  it('accepts an empty invariant list (nothing to hold)', () => {
    const state: ChecklistState = { itemCount: 0, doneCount: 99 };
    expect(checkInvariants(state, []).ok).toBe(true);
  });

  it('is deterministic: same state, same invariants, same outcome', () => {
    const state: ChecklistState = { itemCount: 1, doneCount: 5 };
    const first = checkInvariants(state, [DONE_WITHIN_ITEMS]);
    const second = checkInvariants(state, [DONE_WITHIN_ITEMS]);
    expect(first).toStrictEqual(second);
  });
});
