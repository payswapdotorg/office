import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  isPage,
  isPageCursor,
  parseEntityRef,
  parsePage,
  parsePageCursor,
} from './index';
import type { Page, ParseResult } from './index';

// OFF-002 contracts — pagination tests. Deterministic: fixed ids and cursors.

const OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const roundTrip = (value: unknown, parse: (raw: unknown) => ParseResult<unknown>): void => {
  const parsed = parse(JSON.parse(JSON.stringify(value)) as unknown);
  if (!parsed.ok) {
    throw new Error(`round-trip parse failed: ${JSON.stringify(parsed.error)}`);
  }
  expect(parsed.value).toStrictEqual(value);
};

const entityRef = unwrap(
  parseEntityRef({
    entityKind: 'project',
    entityId: formatProjectId({ version: 'v1', opaque: OPAQUE }),
  }),
);

const lastPage: Page<typeof entityRef> = {
  kind: 'page',
  items: [entityRef],
  nextCursor: null,
};

const midPage: Page<typeof entityRef> = {
  kind: 'page',
  items: [entityRef, entityRef],
  nextCursor: unwrap(parsePageCursor('bWFya2VyLXRva2Vu')),
};

describe('pagination envelope', () => {
  it('round-trips a final page through JSON with item validation', () => {
    roundTrip(lastPage, (raw) => parsePage(raw, parseEntityRef));
  });

  it('round-trips a middle page with a cursor', () => {
    roundTrip(midPage, (raw) => parsePage(raw, parseEntityRef));
  });

  it('round-trips pages without item validation (structure only)', () => {
    roundTrip(lastPage, parsePage);
    roundTrip(midPage, parsePage);
  });

  it('parses empty pages', () => {
    const page = unwrap(parsePage({ kind: 'page', items: [], nextCursor: null }));
    expect(page.items).toStrictEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('type-guards pages and cursors', () => {
    expect(isPage({ kind: 'page', items: [], nextCursor: null })).toBe(true);
    expect(isPage({ items: [] })).toBe(false);
    expect(isPageCursor('tok-1234')).toBe(true);
    expect(isPageCursor('')).toBe(false);
    expect(isPageCursor('has space')).toBe(false);
    expect(isPageCursor(42)).toBe(false);
  });

  it('rejects malformed page shapes', () => {
    const malformed = [
      42,
      null,
      'page',
      {},
      { kind: 'page' },
      { kind: 'page', items: {}, nextCursor: null },
      { kind: 'list', items: [], nextCursor: null },
      { kind: 'page', items: [], nextCursor: 'with space' },
      { kind: 'page', items: [] },
      { kind: 'page', items: [], nextCursor: null, total: 5 },
    ];
    for (const candidate of malformed) {
      expect(parsePage(candidate).ok, `candidate: ${JSON.stringify(candidate)}`).toBe(false);
    }
  });

  it('reports item validation failures at items[i] paths', () => {
    const result = parsePage(
      {
        kind: 'page',
        items: [
          { entityKind: 'project', entityId: formatEntityId({ version: 'v1', opaque: OPAQUE }) },
          { entityKind: 'project' },
        ],
        nextCursor: null,
      },
      parseEntityRef,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing-field');
      expect(result.error.path).toBe('items[1].entityId');
    }
  });

  it('parses cursors standalone', () => {
    expect(unwrap(parsePageCursor('tok-1234'))).toBe('tok-1234');
    expect(parsePageCursor(42).ok).toBe(false);
    expect(parsePageCursor('x'.repeat(513)).ok).toBe(false);
  });
});
