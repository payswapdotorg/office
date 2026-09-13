// OFF-018 — the EvidenceSet model + THE qualification gate (freeze A4): every
// consequential machine-generated recommendation must carry QUALIFIED,
// non-empty, in-scope evidence. Empty sets and out-of-scope items are typed
// rejections, never silently-propagated proposals. Parsing is total and
// fail-closed everywhere (strict keys, closed vocabularies, dotted paths).
import { parseEntityId, parseEntityKind } from '@office/contracts';
import type { EntityId, EntityKind } from '@office/contracts';
import { describe, expect, it } from 'vitest';
import {
  backingItemsOf,
  evidenceReferencesOf,
  evidenceSet,
  isEvidenceSet,
  parseEvidenceItem,
  parseEvidenceQuery,
  parseEvidenceSet,
  qualifyEvidenceSet,
} from './evidence';
import type { EvidenceItem, EvidenceQuery } from './evidence';
import {
  ASSESSMENT_1,
  PROJECT_1,
  PROJECT_2,
  TENANT_A,
  TENANT_B,
  T0,
  expectFail,
  projectScopeOf,
  tenantScopeOf,
  unwrap,
} from './test-support';

/** Fixture helper: a branded EntityKind from a known-good literal. */
const entityKindOf = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity kind: ${raw}`);
  return parsed.value;
};

/** Fixture helper: a branded EntityId from a known-good literal. */
const entityIdOf = (raw: string): EntityId => {
  const parsed = parseEntityId(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity id: ${raw}`);
  return parsed.value;
};


const CHANGE_EVENT_REF = 'change-event:office-ent-v1-c1a2b3c4d5e6f708192a3b4c5d6e7f8a';

/** One structurally valid evidence item about the fixture change event. */
const itemOf = (overrides: Record<string, unknown> = {}): EvidenceItem =>
  unwrap(
    parseEvidenceItem({
      kind: 'entity',
      ref: CHANGE_EVENT_REF,
      entity: {
        entityKind: 'change-event',
        entityId: 'office-ent-v1-c1a2b3c4d5e6f708192a3b4c5d6e7f8a',
      },
      scope: projectScopeOf(PROJECT_1),
      confidence: 'high',
      retrieval: {
        tool: 'relationship-traversal',
        query: { kind: 'memory-lessons' },
        retrievedAt: T0,
      },
      ...overrides,
    }),
  );

// ----- fail-closed parsing ----------------------------------------------------------------------

describe('parseEvidenceQuery (total, fail-closed, strict keys)', () => {
  it('accepts every query kind of the closed vocabulary', () => {
    const queries: EvidenceQuery[] = [
      {
        kind: 'relationship-traversal',
        query: {
          start: {
            entityKind: entityKindOf('change-event'),
            entityId: entityIdOf('office-ent-v1-c1a2b3c4d5e6f708192a3b4c5d6e7f8a'),
          },
          maxDepth: 2,
        },
      },
      { kind: 'margin-assessment', assessmentId: ASSESSMENT_1 },
      { kind: 'memory-outcomes', projectId: PROJECT_1 },
      { kind: 'memory-lessons' },
    ];
    for (const query of queries) {
      expect(unwrap(parseEvidenceQuery(query))).toStrictEqual(query);
    }
  });

  it('rejects an unknown kind and unknown keys (nothing is silently dropped)', () => {
    expect(parseEvidenceQuery({ kind: 'web-search' }).ok).toBe(false);
    const extra = parseEvidenceQuery({ kind: 'memory-lessons', extra: 1 });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.error.code).toBe('unknown-field');
      expect(extra.error.path).toBe('extra');
    }
  });

  it('rejects a malformed nested traversal query at the nested path', () => {
    const result = parseEvidenceQuery({ kind: 'relationship-traversal', query: { maxDepth: 2 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-type');
      expect(result.error.path).toBe('query.start');
    }
  });
});

describe('parseEvidenceItem / parseEvidenceSet (strict keys, referenced tokens)', () => {
  it('round-trips a valid item and rejects unknown keys and bad refs', () => {
    expect(unwrap(parseEvidenceItem(itemOf()))).toStrictEqual(itemOf());
    const extraKey = parseEvidenceItem({ ...itemOf(), extra: true });
    expect(extraKey.ok).toBe(false);
    if (!extraKey.ok) expect(extraKey.error.code).toBe('unknown-field');
    // The ref token grammar matches the gateway's EvidenceReference grammar.
    const spaced = parseEvidenceItem({ ...itemOf(), ref: 'has space' });
    expect(spaced.ok).toBe(false);
    if (!spaced.ok) {
      expect(spaced.error.code).toBe('invalid-value');
      expect(spaced.error.path).toBe('ref');
    }
  });

  it('parses an evidence set and rejects duplicate reference tokens', () => {
    const set = unwrap(parseEvidenceSet({ items: [itemOf()] }));
    expect(set.items).toHaveLength(1);
    expect(isEvidenceSet({ items: [itemOf()] })).toBe(true);
    const duplicate = parseEvidenceSet({ items: [itemOf(), itemOf()] });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe('invalid-value');
      expect(duplicate.error.received).toContain('duplicate ref');
    }
  });

  it('allows the empty set at PARSE time (read-only runs) and reports element paths', () => {
    expect(unwrap(parseEvidenceSet({ items: [] })).items).toStrictEqual([]);
    const badElement = parseEvidenceSet({ items: [itemOf(), { kind: 'nope' }] });
    expect(badElement.ok).toBe(false);
    if (!badElement.ok) {
      expect(badElement.error.code).toBe('invalid-value');
      expect(badElement.error.path).toBe('items[1].kind');
    }
    // The trusted builder throws loud on the same defect.
    expect(() => evidenceSet([{ ...itemOf(), kind: 'nope' as never }])).toThrow(TypeError);
  });

  it('exposes the proposal-facing refs and the backing items', () => {
    const set = unwrap(parseEvidenceSet({ items: [itemOf()] }));
    expect(evidenceReferencesOf(set)).toStrictEqual([CHANGE_EVENT_REF]);
    expect(backingItemsOf(set, CHANGE_EVENT_REF)).toHaveLength(1);
    expect(backingItemsOf(set, 'absent-ref')).toStrictEqual([]);
  });
});

// ----- THE qualification gate (freeze A4) ---------------------------------------------------------

describe('qualifyEvidenceSet — THE consequential-recommendation gate', () => {
  it('accepts a non-empty, entirely in-scope set', () => {
    const set = unwrap(parseEvidenceSet({ items: [itemOf()] }));
    expect(qualifyEvidenceSet(set, projectScopeOf(PROJECT_1)).ok).toBe(true);
    // A tenant-wide run covers every project of its tenant.
    expect(qualifyEvidenceSet(set, tenantScopeOf(TENANT_A)).ok).toBe(true);
  });

  it('rejects the EMPTY set typed (empty-evidence-set)', () => {
    const set = unwrap(parseEvidenceSet({ items: [] }));
    const result = qualifyEvidenceSet(set, projectScopeOf(PROJECT_1));
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('empty-evidence-set');
    expect(error.message).toContain('non-empty evidence set');
  });

  it('rejects a CROSS-TENANT item typed (evidence-scope-violation, freeze A12)', () => {
    const foreign = itemOf({ scope: projectScopeOf(PROJECT_2, TENANT_B) });
    const set = unwrap(parseEvidenceSet({ items: [foreign] }));
    const result = qualifyEvidenceSet(set, projectScopeOf(PROJECT_1, TENANT_A));
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('evidence-scope-violation');
    expect(error.message).toContain(CHANGE_EVENT_REF);
  });

  it('rejects a CROSS-PROJECT item of the same tenant typed (project isolation)', () => {
    const otherProject = itemOf({ scope: projectScopeOf(PROJECT_2, TENANT_A) });
    const set = unwrap(parseEvidenceSet({ items: [otherProject] }));
    expect(qualifyEvidenceSet(set, projectScopeOf(PROJECT_1, TENANT_A)).ok).toBe(false);
    // The same item is covered by its own project scope.
    expect(qualifyEvidenceSet(set, projectScopeOf(PROJECT_2, TENANT_A)).ok).toBe(true);
  });

  it('rejects when ANY single item is out of scope (the set is qualified wholly)', () => {
    const set = unwrap(
      parseEvidenceSet({
        items: [itemOf(), itemOf({ ref: 'other:ref', scope: tenantScopeOf(TENANT_B) })],
      }),
    );
    expect(qualifyEvidenceSet(set, projectScopeOf(PROJECT_1)).ok).toBe(false);
  });
});
