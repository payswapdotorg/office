// Office agent runtime — the EvidenceSet model (OFF-018).
//
// Freeze A4: every consequential machine-generated recommendation must carry
// EVIDENCE. The agent runtime grounds every run on a typed, REFERENCED
// evidence bundle — the EvidenceSet — where each item is one retrieved
// artifact (a relationship-traversal entity, a ledger event, a margin
// assessment, a memory outcome, a memory lesson) carrying:
//   - its kind (which intelligence surface produced it);
//   - its opaque evidence-reference token (the SAME grammar the action
//     gateway's EvidenceReference carries — the token flows into the
//     proposal and the gateway's own audit trail unchanged);
//   - the entity it is about, when the artifact is entity-typed;
//   - the scope it belongs to (the A12 structural check's input);
//   - its own A4 confidence;
//   - its RETRIEVAL PROVENANCE: which read tool produced it, through which
//     typed query, at which (injected-clock) instant.
//
// The typed query shapes consume the intelligence packages' OWN contracts:
// the relationship traversal query parses through
// @office/intelligence-relationships' parseTraversalQuery and the margin
// assessment identity through @office/intelligence-margin's
// parseAssessmentId (the memory surfaces select by project/scope here; their
// typed outcome/lesson identities surface in the memory-evidence tool's
// records — tools.ts). Fail-closed, strict keys, everywhere.
//
// THE structural rule (the named acceptance): a consequential recommendation
// (reversible / approval-required class) REQUIRES a QUALIFIED, non-empty
// EvidenceSet — qualifyEvidenceSet() is the typed gate the runtime calls
// BEFORE the gateway: empty sets and out-of-scope items are typed rejections,
// never silently-propagated proposals.
import {
  parseEntityRef,
  parseFail,
  parseOk,
  parseProjectId,
  parseScope,
  parseTimestamp,
} from '@office/contracts';
import type { EntityRef, ParseResult, ProjectId, Scope, Timestamp } from '@office/contracts';
import { checkScopeCoversResource, resourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { parseConfidenceLevel } from '@office/actions';
import type { ConfidenceLevel } from '@office/actions';
import {
  EVIDENCE_REFERENCE_KIND,
  parseTraversalQuery,
} from '@office/intelligence-relationships';
import type { TraversalQuery } from '@office/intelligence-relationships';
import { parseAssessmentId } from '@office/intelligence-margin';
import type { AssessmentId } from '@office/intelligence-margin';
import {
  describeValue,
  isPlainObject,
  optionalNullableFieldWith,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import { EVIDENCE_REF_RULE } from './vocabulary';

// ----- the typed retrieval queries -----------------------------------------------------------

/**
 * One typed evidence-retrieval query: which intelligence surface the evidence
 * comes from and the query that produced it. The runtime routes each query to
 * the read tool responsible for its kind (see tools.ts).
 */
export type EvidenceQuery =
  /** A relationship-graph traversal (the evidence is the reachable subgraph). */
  | { readonly kind: 'relationship-traversal'; readonly query: TraversalQuery }
  /** One recorded margin impact assessment, by its typed identity. */
  | { readonly kind: 'margin-assessment'; readonly assessmentId: AssessmentId }
  /** Recorded memory outcomes (one project's, or the whole covered scope). */
  | { readonly kind: 'memory-outcomes'; readonly projectId: ProjectId | null }
  /** Recorded memory lessons of the covered scope. */
  | { readonly kind: 'memory-lessons' };

/** Every evidence-query kind, in vocabulary order. */
export const EVIDENCE_QUERY_KINDS: readonly EvidenceQuery['kind'][] = [
  'relationship-traversal',
  'margin-assessment',
  'memory-outcomes',
  'memory-lessons',
] as const;

/** Grammar description used in parse failures. */
export const EVIDENCE_QUERY_GRAMMAR =
  "EvidenceQuery: { kind: 'relationship-traversal', query: TraversalQuery } | { kind: 'margin-assessment', assessmentId } | { kind: 'memory-outcomes', projectId? } | { kind: 'memory-lessons' }";

/** Parse an untrusted value as an EvidenceQuery (total, fail-closed). */
export function parseEvidenceQuery(raw: unknown): ParseResult<EvidenceQuery> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_QUERY_GRAMMAR, describeValue(raw));
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string') {
    return parseFail('invalid-type', 'kind', EVIDENCE_QUERY_GRAMMAR, describeValue(kind));
  }
  switch (kind) {
    case 'relationship-traversal': {
      const unknownKey = unknownKeyFailure(raw, ['kind', 'query'], '', EVIDENCE_QUERY_GRAMMAR);
      if (unknownKey) return unknownKey;
      const query = requireFieldWith(raw, 'query', '', parseTraversalQuery);
      if (!query.ok) return query;
      return parseOk({ kind, query: query.value } satisfies EvidenceQuery);
    }
    case 'margin-assessment': {
      const unknownKey = unknownKeyFailure(
        raw,
        ['kind', 'assessmentId'],
        '',
        EVIDENCE_QUERY_GRAMMAR,
      );
      if (unknownKey) return unknownKey;
      const assessmentId = requireFieldWith(raw, 'assessmentId', '', parseAssessmentId);
      if (!assessmentId.ok) return assessmentId;
      return parseOk({ kind, assessmentId: assessmentId.value } satisfies EvidenceQuery);
    }
    case 'memory-outcomes': {
      const unknownKey = unknownKeyFailure(
        raw,
        ['kind', 'projectId'],
        '',
        EVIDENCE_QUERY_GRAMMAR,
      );
      if (unknownKey) return unknownKey;
      const projectId = optionalNullableFieldWith(raw, 'projectId', '', parseProjectId);
      if (!projectId.ok) return projectId;
      return parseOk({ kind, projectId: projectId.value } satisfies EvidenceQuery);
    }
    case 'memory-lessons': {
      const unknownKey = unknownKeyFailure(raw, ['kind'], '', EVIDENCE_QUERY_GRAMMAR);
      if (unknownKey) return unknownKey;
      return parseOk({ kind } satisfies EvidenceQuery);
    }
    default:
      return parseFail('invalid-value', 'kind', EVIDENCE_QUERY_GRAMMAR, describeValue(kind));
  }
}

/** Type guard for structurally valid EvidenceQuery values. */
export function isEvidenceQuery(raw: unknown): raw is EvidenceQuery {
  return parseEvidenceQuery(raw).ok;
}

// ----- the evidence items ---------------------------------------------------------------------

/** The kind of artifact one evidence item references. */
export type EvidenceItemKind =
  | 'entity'
  | 'ledger-event'
  | 'margin-assessment'
  | 'memory-outcome'
  | 'memory-lesson';

/** Every evidence-item kind, in vocabulary order. */
export const EVIDENCE_ITEM_KINDS: readonly EvidenceItemKind[] = [
  'entity',
  'ledger-event',
  'margin-assessment',
  'memory-outcome',
  'memory-lesson',
] as const;

/** Grammar description used in parse failures. */
export const EVIDENCE_ITEM_KIND_GRAMMAR =
  "evidence item kind 'entity' | 'ledger-event' | 'margin-assessment' | 'memory-outcome' | 'memory-lesson'";

/**
 * The retrieval provenance of one evidence item (freeze A4): which read tool
 * produced it, through which typed query, at which injected-clock instant.
 */
export interface EvidenceRetrieval {
  /** The registered name of the read tool that produced the item. */
  readonly tool: string;
  /** The typed query the tool ran (which traversal/assessment/lookup). */
  readonly query: EvidenceQuery;
  /** When the item was retrieved (the run's injected clock). */
  readonly retrievedAt: Timestamp;
}

const EVIDENCE_ITEM_KEYS = [
  'kind',
  'ref',
  'entity',
  'scope',
  'confidence',
  'retrieval',
] as const;

const EVIDENCE_ITEM_GRAMMAR =
  'EvidenceItem: { kind, ref: opaque token, entity?: EntityRef | null, scope, confidence, retrieval: { tool, query, retrievedAt } }';

/**
 * One referenced evidence artifact of an EvidenceSet. See the module header
 * for the field-by-field contract; the `ref` token satisfies the action
 * gateway's EvidenceReference grammar so it flows into proposals and the
 * gateway's audit trail unchanged.
 */
export interface EvidenceItem {
  /** Which intelligence surface produced the artifact. */
  readonly kind: EvidenceItemKind;
  /** The opaque evidence-reference token (gateway EvidenceReference grammar). */
  readonly ref: string;
  /** The entity the artifact is about, or null when it is not entity-typed. */
  readonly entity: EntityRef | null;
  /** The scope the artifact belongs to (the A12 structural check's input). */
  readonly scope: Scope;
  /** The artifact's own A4 confidence level. */
  readonly confidence: ConfidenceLevel;
  /** The retrieval provenance (which tool/query produced it, and when). */
  readonly retrieval: EvidenceRetrieval;
}

const EVIDENCE_RETRIEVAL_KEYS = ['tool', 'query', 'retrievedAt'] as const;
const EVIDENCE_RETRIEVAL_GRAMMAR =
  'EvidenceRetrieval: { tool: tool name, query: EvidenceQuery, retrievedAt: Timestamp }';

/** Parse an untrusted value as an EvidenceRetrieval (total, fail-closed). */
export function parseEvidenceRetrieval(raw: unknown): ParseResult<EvidenceRetrieval> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_RETRIEVAL_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    EVIDENCE_RETRIEVAL_KEYS,
    '',
    EVIDENCE_RETRIEVAL_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const tool = requireString(raw, 'tool', '', {
    min: 3,
    max: 64,
    pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,63}$/,
    description: 'tool name: lowercase kebab-case (3..64)',
  });
  if (!tool.ok) return tool;
  const query = requireFieldWith(raw, 'query', '', parseEvidenceQuery);
  if (!query.ok) return query;
  const retrievedAt = requireFieldWith(raw, 'retrievedAt', '', parseTimestamp);
  if (!retrievedAt.ok) return retrievedAt;
  return parseOk(
    {
      tool: tool.value,
      query: query.value,
      retrievedAt: retrievedAt.value,
    } satisfies EvidenceRetrieval,
  );
}

/** Parse an untrusted value as an EvidenceItem (total, fail-closed, strict keys). */
export function parseEvidenceItem(raw: unknown): ParseResult<EvidenceItem> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_ITEM_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, EVIDENCE_ITEM_KEYS, '', EVIDENCE_ITEM_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireFieldWith(raw, 'kind', '', (value) => {
    if (typeof value !== 'string' || !(EVIDENCE_ITEM_KINDS as readonly string[]).includes(value)) {
      return parseFail('invalid-value', '', EVIDENCE_ITEM_KIND_GRAMMAR, describeValue(value));
    }
    return parseOk(value as EvidenceItemKind);
  });
  if (!kind.ok) return kind;
  const ref = requireString(raw, 'ref', '', EVIDENCE_REF_RULE);
  if (!ref.ok) return ref;
  const entity = optionalNullableFieldWith(raw, 'entity', '', parseEntityRef);
  if (!entity.ok) return entity;
  const scope = requireFieldWith(raw, 'scope', '', parseScope);
  if (!scope.ok) return scope;
  const confidence = requireFieldWith(raw, 'confidence', '', parseConfidenceLevel);
  if (!confidence.ok) return confidence;
  const retrieval = requireFieldWith(raw, 'retrieval', '', parseEvidenceRetrieval);
  if (!retrieval.ok) return retrieval;
  return parseOk(
    {
      kind: kind.value,
      ref: ref.value,
      entity: entity.value,
      scope: scope.value,
      confidence: confidence.value,
      retrieval: retrieval.value,
    } satisfies EvidenceItem,
  );
}

/** Type guard for structurally valid EvidenceItem values. */
export function isEvidenceItem(raw: unknown): raw is EvidenceItem {
  return parseEvidenceItem(raw).ok;
}

// ----- the evidence set ------------------------------------------------------------------------

/**
 * The typed, referenced evidence bundle one agent run grounded on. Parsing
 * allows the EMPTY set (a read-only run may ground on nothing); the QUALITY
 * gate (qualifyEvidenceSet) is what consequential proposals must pass —
 * non-empty and entirely in-scope.
 */
export interface EvidenceSet {
  readonly items: readonly EvidenceItem[];
}

const EVIDENCE_SET_KEYS = ['items'] as const;
const EVIDENCE_SET_GRAMMAR = 'EvidenceSet: { items: EvidenceItem[] }';

/** Parse an untrusted value as an EvidenceSet (total, fail-closed, strict keys). */
export function parseEvidenceSet(raw: unknown): ParseResult<EvidenceSet> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVIDENCE_SET_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, EVIDENCE_SET_KEYS, '', EVIDENCE_SET_GRAMMAR);
  if (unknownKey) return unknownKey;
  if (!Array.isArray(raw['items'])) {
    return parseFail('invalid-type', 'items', 'array of evidence items', describeValue(raw['items']));
  }
  const items: EvidenceItem[] = [];
  for (const [index, element] of (raw['items'] as unknown[]).entries()) {
    const parsed = parseEvidenceItem(element);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        `items[${index}]${parsed.error.path === '' ? '' : `.${parsed.error.path}`}`,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    items.push(parsed.value);
  }
  const refs = items.map((item) => item.ref);
  const duplicates = refs.filter((ref, index) => refs.indexOf(ref) !== index);
  if (duplicates.length > 0) {
    return parseFail(
      'invalid-value',
      'items',
      'evidence items with distinct reference tokens (no duplicate refs)',
      `duplicate ref(s): ${duplicates.join(', ')}`,
    );
  }
  return parseOk({ items } satisfies EvidenceSet);
}

/** Type guard for structurally valid EvidenceSet values. */
export function isEvidenceSet(raw: unknown): raw is EvidenceSet {
  return parseEvidenceSet(raw).ok;
}

/**
 * Compose a validated EvidenceSet (trusted path): validates the input with
 * the same fail-closed checks as parseEvidenceSet and throws a loud TypeError
 * instead of returning the failure.
 */
export function evidenceSet(items: readonly EvidenceItem[]): EvidenceSet {
  const result = parseEvidenceSet({ items });
  if (!result.ok) {
    throw new TypeError(
      `invalid evidence set: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}

/** The opaque reference tokens of a set, in order (the proposal-facing refs). */
export const evidenceReferencesOf = (set: EvidenceSet): readonly string[] =>
  set.items.map((item) => item.ref);

/** The items of a set whose reference token equals `ref` (the backing items). */
export const backingItemsOf = (set: EvidenceSet, ref: string): readonly EvidenceItem[] =>
  set.items.filter((item) => item.ref === ref);

// ----- THE qualification gate -------------------------------------------------------------------

/**
 * THE structural evidence gate of the named acceptance (freeze A4): is this
 * EvidenceSet QUALIFIED to ground a consequential recommendation? A qualified
 * set is non-empty AND entirely covered by the run's scope (structural A12:
 * every item's scope passes the same checkScopeCoversResource every module
 * uses — cross-tenant/cross-project items are typed rejections, never
 * silently-dropped or silently-trusted evidence).
 */
export function qualifyEvidenceSet(
  set: EvidenceSet,
  runScope: Scope,
  context?: DomainErrorContext,
): Result<true, DomainError> {
  if (set.items.length === 0) {
    return fail(
      domainError(
        'invariant-violation',
        'a consequential agent recommendation requires a non-empty evidence set (freeze A4)',
        [
          {
            code: 'empty-evidence-set',
            message: 'the run grounded on no evidence; consequential proposals are typed-rejected',
            path: 'evidence',
          },
        ],
        context,
      ),
    );
  }
  for (const item of set.items) {
    const covered = checkScopeCoversResource(
      runScope,
      resourceScope({
        scope: item.scope,
        resourceKind: item.entity === null ? EVIDENCE_REFERENCE_KIND : item.entity.entityKind,
        resourceId: item.entity === null ? null : item.entity.entityId,
        ownerId: null,
      }),
      context,
    );
    if (!covered.ok) {
      return fail(
        domainError(
          'unauthorized',
          `evidence item '${item.ref}' (${item.kind}) retrieved by tool '${item.retrieval.tool}' is outside the agent run's scope and cannot ground a consequential recommendation (freeze A12/A4)`,
          [
            {
              code: 'evidence-scope-violation',
              message: `evidence scope ${
                item.scope.kind === 'project'
                  ? `project ${item.scope.projectId}`
                  : `tenant ${item.scope.tenantId}`
              } outside the run scope`,
              path: 'evidence',
            },
          ],
          context ?? { scope: runScope },
        ),
      );
    }
  }
  return ok(true);
}
