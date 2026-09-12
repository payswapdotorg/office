// Office canonical contracts — pagination (OFF-002).
//
// Page<T>: the pagination envelope returned by read models and query
// contracts. Cursor-based and provider-neutral: nextCursor is an opaque
// token issued by the read model (null after the final page). A page
// carries no scope of its own — tenant and project scoping is enforced by
// the scoped query path that produced it (freeze A12; OFF-004 scoped query
// helpers), not duplicated into every page.
import {
  describeValue,
  isPlainObject,
  joinPath,
  nest,
  parseFail,
  parseOk,
  parseStringLike,
  requireLiteral,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import type { ParseResult } from './parse';

declare const pageCursorBrand: unique symbol;

/** Opaque pagination cursor token issued by a read model. */
export type PageCursor = string & { readonly [pageCursorBrand]: 'PageCursor' };

/**
 * One page of results. `items` are the read model's typed rows; `nextCursor`
 * is null exactly when there are no further pages.
 */
export interface Page<T> {
  readonly kind: 'page';
  readonly items: readonly T[];
  readonly nextCursor: PageCursor | null;
}

/** Shape description used in parse failures. */
export const PAGE_GRAMMAR =
  "{ kind: 'page', items: T[], nextCursor: PageCursor | null }";

/** Grammar description used in parse failures. */
export const PAGE_CURSOR_GRAMMAR =
  'opaque printable-ASCII token of 1..512 characters (no whitespace)';

const PAGE_CURSOR_RULE: StringRule = {
  min: 1,
  max: 512,
  pattern: /^[\x21-\x7e]{1,512}$/,
  description: PAGE_CURSOR_GRAMMAR,
};

const PAGE_KEYS = ['kind', 'items', 'nextCursor'] as const;

/** Parse an untrusted value as a PageCursor (total, fail-closed). */
export function parsePageCursor(raw: unknown): ParseResult<PageCursor> {
  const result = parseStringLike(raw, PAGE_CURSOR_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as PageCursor);
}

/** Type guard for structurally valid PageCursor values. */
export function isPageCursor(raw: unknown): raw is PageCursor {
  return parsePageCursor(raw).ok;
}

/**
 * Parse an untrusted value as a Page with item validation (total,
 * fail-closed, strict keys). Each item is validated by `parseItem`; item
 * failures report paths like 'items[2]'.
 */
export function parsePage<T>(
  raw: unknown,
  parseItem: (item: unknown) => ParseResult<T>,
): ParseResult<Page<T>>;
/** Parse an untrusted value as a Page of unvalidated items (structure only). */
export function parsePage(raw: unknown): ParseResult<Page<unknown>>;
export function parsePage<T>(
  raw: unknown,
  parseItem?: (item: unknown) => ParseResult<T>,
): ParseResult<Page<T>> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PAGE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PAGE_KEYS, '', PAGE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['page']);
  if (!kind.ok) return kind;
  const itemsRaw = raw['items'];
  if (itemsRaw === undefined) {
    return parseFail('missing-field', 'items', 'array', 'undefined');
  }
  if (!Array.isArray(itemsRaw)) {
    return parseFail('invalid-type', 'items', 'array', describeValue(itemsRaw));
  }
  const items: T[] = [];
  for (const [index, item] of itemsRaw.entries()) {
    if (parseItem !== undefined) {
      const parsed = parseItem(item);
      if (!parsed.ok) {
        return parseFail(
          parsed.error.code,
          joinPath(`items[${index}]`, parsed.error.path),
          parsed.error.expected,
          parsed.error.received,
        );
      }
      items.push(parsed.value);
    } else {
      items.push(item as T);
    }
  }
  const nextCursorRaw = raw['nextCursor'];
  if (nextCursorRaw === undefined) {
    return parseFail('missing-field', 'nextCursor', 'PageCursor | null', 'undefined');
  }
  if (nextCursorRaw === null) {
    return parseOk({ kind: 'page', items, nextCursor: null } satisfies Page<T>);
  }
  const nextCursor = nest(parsePageCursor(nextCursorRaw), '', 'nextCursor');
  if (!nextCursor.ok) return nextCursor;
  return parseOk({ kind: 'page', items, nextCursor: nextCursor.value } satisfies Page<T>);
}

/** Type guard for structurally valid Page values (structure only). */
export function isPage(raw: unknown): raw is Page<unknown> {
  return parsePage(raw).ok;
}
