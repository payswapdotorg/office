// Office agent runtime — the typed tool registry (OFF-018).
//
// THE tool contract of the AI execution boundary (freeze A8): every tool the
// runtime may invoke is a TYPED, INJECTED PORT resolved through a registry —
// there are exactly two kinds:
//
//   - 'read' tools retrieve EVIDENCE (relationship traversals, margin
//     assessments, memory lookups). Their port signature returns evidence
//     items — pure referenced data. A read tool CANNOT mutate: it has no
//     execution surface at all (structural — the type has no write path).
//
//   - 'propose-action' tools produce typed action PROPOSALS (the injected
//     ModelPort behind a typed descriptor). Their port signature returns
//     ProposedAction values — proposals, never executions. The ONLY path from
//     a proposal to canonical state is the runtime handing it to the OFF-017
//     gateway's executeAction() (run.ts); no tool ever holds a gateway, a
//     handler, a store, or an executor.
//
// The package ships four deterministic built-in factories so the registry has
// a real reference wiring: the relationship-traversal tool (REAL
// @office/intelligence-relationships traversal over an injected index), the
// assessment-evidence tool and the memory-evidence tool (typed read ports
// over RECORDED intelligence artifacts — the engines computed them upstream;
// the runtime retrieves references, it never re-derives intelligence), and
// the model-proposing tool (the injected ModelPort behind a typed
// 'propose-action' descriptor). All four are deterministic: injected clocks,
// no network, no LLM.
import { parseOk, parseFail } from '@office/contracts';
import type { EntityId, EntityKind, ParseResult, Scope, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import {
  authorizationContext,
  checkScopeCoversResource,
  resourceScope,
} from '@office/authz';
import type { AuthorizationContext, Policy } from '@office/authz';
import type { ActionAuthorization, ConfidenceLevel } from '@office/actions';
import { traverseRelationships } from '@office/intelligence-relationships';
import type { RelationshipIndex } from '@office/intelligence-relationships';
import { ASSESSMENT_REQUIRED_CAPABILITY_NAMES } from '@office/intelligence-margin';
import type { AssessmentId } from '@office/intelligence-margin';
import { MEMORY_REQUIRED_CAPABILITY_NAMES } from '@office/intelligence-memory';
import type { LessonId, OutcomeId } from '@office/intelligence-memory';
import type { EvidenceItem, EvidenceQuery } from './evidence';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import { parseToolName } from './vocabulary';
import type { ToolKind, ToolName } from './vocabulary';
import type { ModelPort, ProposingInput } from './model';
import type { ProposedAction } from './proposals';
import { proposedAction } from './proposals';

// ----- the tool descriptors -------------------------------------------------------------------

/**
 * The typed descriptor of one registered tool: its name, its kind (which
 * port shape backs it), and its human-facing documentation. Structural rule:
 * the kind dictates the port — a 'read' descriptor must front an evidence
 * tool, a 'propose-action' descriptor must front a proposing tool (the
 * registry enforces this at construction, fail-closed).
 */
export interface ToolDescriptor {
  /** The registered tool name (kebab-case; resolves in the registry). */
  readonly name: ToolName;
  /** The tool kind: 'read' (evidence retrieval) or 'propose-action'. */
  readonly kind: ToolKind;
  /** Human-readable title (1..200 characters). */
  readonly title: string;
  /** Human-readable description, or null. */
  readonly description: string | null;
}

const TOOL_DESCRIPTOR_KEYS = ['name', 'kind', 'title', 'description'] as const;

const TOOL_KIND_LITERALS: readonly ToolKind[] = ['read', 'propose-action'];

const TOOL_DESCRIPTOR_GRAMMAR =
  "ToolDescriptor: { name: kebab (3..64), kind: 'read' | 'propose-action', title: string (1..200), description?: string (1..2000) | null }";

/** Parse an untrusted value as a ToolDescriptor (total, fail-closed, strict keys). */
export function parseToolDescriptor(raw: unknown): ParseResult<ToolDescriptor> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', TOOL_DESCRIPTOR_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, TOOL_DESCRIPTOR_KEYS, '', TOOL_DESCRIPTOR_GRAMMAR);
  if (unknownKey) return unknownKey;
  const name = requireFieldWith(raw, 'name', '', parseToolName);
  if (!name.ok) return name;
  const kindRaw = raw['kind'];
  if (kindRaw === undefined) {
    return parseFail('missing-field', 'kind', TOOL_DESCRIPTOR_GRAMMAR, 'undefined');
  }
  if (typeof kindRaw !== 'string' || !(TOOL_KIND_LITERALS as readonly string[]).includes(kindRaw)) {
    return parseFail('invalid-value', 'kind', TOOL_DESCRIPTOR_GRAMMAR, describeValue(kindRaw));
  }
  const kind = kindRaw as ToolKind;
  const title = requireString(raw, 'title', '', { min: 1, max: 200, description: 'tool title' });
  if (!title.ok) return title;
  const descriptionRaw = raw['description'];
  if (descriptionRaw === undefined || descriptionRaw === null) {
    return parseOk({ name: name.value, kind, title: title.value, description: null } satisfies ToolDescriptor);
  }
  if (typeof descriptionRaw !== 'string' || descriptionRaw.length < 1 || descriptionRaw.length > 2000) {
    return parseFail('invalid-value', 'description', 'tool description: string (1..2000) or null', describeValue(descriptionRaw));
  }
  return parseOk(
    { name: name.value, kind, title: title.value, description: descriptionRaw } satisfies ToolDescriptor,
  );
}

/** Type guard for structurally valid ToolDescriptor values. */
export function isToolDescriptor(raw: unknown): raw is ToolDescriptor {
  return parseToolDescriptor(raw).ok;
}

/**
 * Compose a validated ToolDescriptor (trusted path): validates the input with
 * the same fail-closed checks as parseToolDescriptor and throws a loud
 * TypeError instead of returning the failure.
 */
export function defineToolDescriptor(raw: unknown): ToolDescriptor {
  const result = parseToolDescriptor(raw);
  if (!result.ok) {
    throw new TypeError(
      `invalid tool descriptor: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}

// ----- the tool ports --------------------------------------------------------------------------

/**
 * The authorization a read tool retrieves evidence under: the run's
 * deny-by-default policy plus the request authorization context (the agent
 * actor, the run scope, the granted capabilities) — the same shapes the
 * intelligence surfaces' own authorization checks take.
 */
export interface ToolAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

/**
 * Compose a ToolAuthorization from the gateway-style authorization inputs the
 * runtime holds (policy + capabilities) plus the run's actor and scope.
 */
export const toolAuthorizationOf = (
  authorization: ActionAuthorization,
  parts: { readonly actor: Parameters<typeof authorizationContext>[0]['actor']; readonly scope: Parameters<typeof authorizationContext>[0]['scope'] },
): ToolAuthorization => ({
  policy: authorization.policy,
  context: authorizationContext({
    actor: parts.actor,
    scope: parts.scope,
    capabilities: authorization.capabilities,
  }),
});

/**
 * THE read-tool port: retrieve evidence through one typed query, under the
 * run's authorization. Pure retrieval — the return type is referenced data,
 * and the port has NO execution surface (freeze A8: no tool writes canonical
 * state directly; this type cannot).
 */
export interface EvidenceTool {
  /** The tool's descriptor (kind 'read' — enforced by the registry). */
  readonly descriptor: ToolDescriptor;
  /** Retrieve the evidence the typed query selects (fail-closed, scoped). */
  retrieve(
    query: EvidenceQuery,
    authorization: ToolAuthorization,
  ): Promise<Result<readonly EvidenceItem[], DomainError>>;
}

/**
 * THE action-proposing tool port: produce typed action proposals from the
 * goal and the gathered evidence (the injected ModelPort behind a typed
 * descriptor). The port RETURNS proposals — it never executes them; the only
 * execution path is the runtime handing proposals to the gateway (run.ts).
 */
export interface ProposingTool {
  /** The tool's descriptor (kind 'propose-action' — enforced by the registry). */
  readonly descriptor: ToolDescriptor;
  /** Propose actions for the goal grounded on the evidence (fail-closed). */
  propose(input: ProposingInput): Promise<Result<readonly ProposedAction[], DomainError>>;
}

/** One registered tool: an evidence tool or a proposing tool. */
export type Tool = EvidenceTool | ProposingTool;

/** Type guard: is this tool an evidence (read) tool? */
export function isEvidenceTool(tool: Tool): tool is EvidenceTool {
  return tool.descriptor.kind === 'read';
}

/** Type guard: is this tool an action-proposing tool? */
export function isProposingTool(tool: Tool): tool is ProposingTool {
  return tool.descriptor.kind === 'propose-action';
}

// ----- the registry -----------------------------------------------------------------------------

/**
 * The typed tool registry: resolves tools by name. Unknown names resolve to
 * null — the runtime treats that as a typed fail-closed wiring failure
 * (an unregistered tool is never silently skipped).
 */
export interface ToolRegistry {
  /** The tool registered under `toolName`, or null when unknown. */
  resolve(toolName: string): Tool | null;
  /** Every registered descriptor, in registration order. */
  descriptors(): readonly ToolDescriptor[];
}

/**
 * Create the in-memory tool registry. Construction is fail-closed on the
 * trusted path: every descriptor must be structurally valid, every tool name
 * unique, and every port's shape must match its descriptor's kind (a 'read'
 * descriptor behind a proposing port — or the reverse — is a loud TypeError,
 * never a silently-mistyped tool).
 */
export function createInMemoryToolRegistry(tools: readonly Tool[]): ToolRegistry {
  const byName = new Map<string, Tool>();
  const ordered: Tool[] = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') {
      throw new TypeError('tool registry entries must be tool objects');
    }
    const descriptor = tool.descriptor;
    const checked = parseToolDescriptor(descriptor);
    if (!checked.ok) {
      throw new TypeError(
        `invalid tool descriptor for tool '${String(descriptor?.name)}': ${checked.error.code} at '${
          checked.error.path === '' ? '<root>' : checked.error.path
        }'`,
      );
    }
    const isEvidenceTool = 'retrieve' in tool && typeof tool.retrieve === 'function';
    const isProposingTool = 'propose' in tool && typeof tool.propose === 'function';
    if (checked.value.kind === 'read' && !isEvidenceTool) {
      throw new TypeError(
        `tool '${checked.value.name}' declares kind 'read' but does not implement the evidence-tool port`,
      );
    }
    if (checked.value.kind === 'propose-action' && !isProposingTool) {
      throw new TypeError(
        `tool '${checked.value.name}' declares kind 'propose-action' but does not implement the proposing-tool port`,
      );
    }
    if (isEvidenceTool && isProposingTool) {
      throw new TypeError(
        `tool '${checked.value.name}' implements both ports; a tool is exactly one kind`,
      );
    }
    if (!isEvidenceTool && !isProposingTool) {
      throw new TypeError(
        `tool '${checked.value.name}' implements neither tool port`,
      );
    }
    const name = checked.value.name as string;
    if (byName.has(name)) {
      throw new TypeError(`duplicate tool registration for name '${name}'`);
    }
    byName.set(name, tool);
    ordered.push(tool);
  }
  return {
    resolve: (toolName) => byName.get(toolName) ?? null,
    descriptors: () => ordered.map((tool) => tool.descriptor),
  };
}

// ----- the shared failure vocabulary of the built-in tools --------------------------------------

const toolQueryMismatch = (
  tool: string,
  expected: EvidenceQuery['kind'],
  received: EvidenceQuery['kind'],
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `evidence tool '${tool}' answers '${expected}' queries but received a '${received}' query`,
    [
      {
        code: 'tool-query-mismatch',
        message: `expected query kind '${expected}', received '${received}'`,
        path: 'query',
      },
    ],
    context,
  );

const missingCapabilities = (
  tool: string,
  required: readonly string[],
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'forbidden',
    `evidence tool '${tool}' requires capabilities [${required.join(', ')}] which the requesting agent does not hold`,
    [
      {
        code: 'missing-required-capability',
        message: `missing [${required.join(', ')}]`,
        path: null,
      },
    ],
    context,
  );

const checkToolCapabilities = (
  tool: string,
  required: readonly string[],
  authorization: ToolAuthorization,
): Result<true, DomainError> => {
  const held = authorization.context.capabilities as readonly string[];
  const missing = required.filter((name) => !held.includes(name));
  if (missing.length > 0) {
    return fail(missingCapabilities(tool, missing, { scope: authorization.context.scope }));
  }
  return ok(true);
};

const evidenceNotFound = (
  tool: string,
  kind: string,
  ref: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'not-found',
    `evidence tool '${tool}' has no ${kind} '${ref}' visible to this request`,
    [
      {
        code: 'evidence-not-found',
        message: `${kind} '${ref}' is absent from the tool's covered scope`,
        path: null,
      },
    ],
    context,
  );

// ----- the relationship-traversal tool (REAL intelligence traversal) ----------------------------

/** Options of createRelationshipTraversalTool. */
export interface RelationshipTraversalToolOptions {
  /** The tool's registered name (default 'relationship-traversal'). */
  readonly name?: string;
  /** The tool's title (default derived from the name). */
  readonly title?: string;
  /** The tool's description, or null. */
  readonly description?: string | null;
  /** The projected relationship index the traversal runs over (injected). */
  readonly index: RelationshipIndex;
  /** The injected clock stamping retrieval instants. */
  readonly now: () => Timestamp;
  /** The A4 confidence of traversal-retrieved facts (default 'high'). */
  readonly confidence?: ConfidenceLevel;
}

const TRAVERSAL_REF_SEPARATOR = ':';

/**
 * Create the relationship-traversal evidence tool: the REAL
 * @office/intelligence-relationships traversal (authorization-filtered,
 * deterministic, A12-invisible for out-of-scope nodes) over the injected
 * index. Every reachable node of the subgraph becomes one evidence item
 * (kind 'entity', ref '<entityKind>:<entityId>', the node's scope) carrying
 * the traversal query as its retrieval provenance. A cross-scope START node
 * is the engine's own typed not-found (no existence oracle); a capability or
 * policy denial is its typed forbidden error — both propagate unchanged.
 */
export function createRelationshipTraversalTool(
  options: RelationshipTraversalToolOptions,
): EvidenceTool {
  const name = options.name ?? 'relationship-traversal';
  const descriptor = defineToolDescriptor({
    name,
    kind: 'read',
    title: options.title ?? 'Relationship traversal evidence',
    description:
      options.description ??
      'Retrieves the authorization-filtered relationship subgraph reachable from a start entity (@office/intelligence-relationships traversal).',
  });
  const confidence = options.confidence ?? 'high';
  return {
    descriptor,
    retrieve: async (query, authorization) => {
      if (query.kind !== 'relationship-traversal') {
        return fail(
          toolQueryMismatch(name, 'relationship-traversal', query.kind, {
            scope: authorization.context.scope,
          }),
        );
      }
      const traversed = traverseRelationships(
        options.index,
        query.query,
        { policy: authorization.policy, context: authorization.context },
      );
      if (!traversed.ok) return traversed;
      const retrievedAt = options.now();
      const items: EvidenceItem[] = traversed.value.nodes.map((node) => ({
        kind: 'entity',
        ref: `${node.entity.entityKind}${TRAVERSAL_REF_SEPARATOR}${node.entity.entityId}`,
        entity: node.entity,
        scope: node.scope,
        confidence,
        retrieval: { tool: name, query, retrievedAt },
      }));
      return ok(items);
    },
  };
}

// ----- the assessment-evidence tool (recorded margin assessments) -------------------------------

/**
 * One RECORDED margin impact assessment summarized for evidence retrieval:
 * the margin engine (@office/intelligence-margin) computed it upstream; the
 * runtime retrieves its typed reference, scope, and source change event — it
 * never re-derives intelligence (A7: projections are inputs, not truth).
 */
export interface AssessmentEvidenceRecord {
  /** The assessment's typed identity (the margin package's own grammar). */
  readonly assessmentId: AssessmentId;
  /** The scope the assessment was produced under. */
  readonly scope: Scope;
  /** The assessed source change event's canonical entity id. */
  readonly sourceEventId: EntityId;
  /** When the assessment was produced (the margin engine's injected clock). */
  readonly assessedAt: Timestamp;
  /** The assessment's own A4 confidence. */
  readonly confidence: ConfidenceLevel;
}

/** Options of createAssessmentEvidenceTool. */
export interface AssessmentEvidenceToolOptions {
  /** The tool's registered name (default 'margin-assessment'). */
  readonly name?: string;
  /** The tool's title (default derived from the name). */
  readonly title?: string;
  /** The tool's description, or null. */
  readonly description?: string | null;
  /** The recorded assessments, in stable (engine) order (injected). */
  readonly assessments: readonly AssessmentEvidenceRecord[];
  /** The injected clock stamping retrieval instants. */
  readonly now: () => Timestamp;
}

/**
 * Create the assessment-evidence tool: a typed read port over RECORDED margin
 * impact assessments. Retrieves one assessment by its typed identity —
 * fail-closed on the margin package's own capability requirements, with NO
 * existence oracle: an assessment outside the requesting scope is
 * typed-rejected exactly like an absent one (identical not-found).
 */
export function createAssessmentEvidenceTool(
  options: AssessmentEvidenceToolOptions,
): EvidenceTool {
  const name = options.name ?? 'margin-assessment';
  const descriptor = defineToolDescriptor({
    name,
    kind: 'read',
    title: options.title ?? 'Margin assessment evidence',
    description:
      options.description ??
      'Retrieves one recorded margin impact assessment by its typed identity (@office/intelligence-margin assessment reference).',
  });
  const byId = new Map<string, AssessmentEvidenceRecord>(
    options.assessments.map((assessment) => [assessment.assessmentId as string, assessment]),
  );
  return {
    descriptor,
    retrieve: async (query, authorization) => {
      if (query.kind !== 'margin-assessment') {
        return fail(
          toolQueryMismatch(name, 'margin-assessment', query.kind, {
            scope: authorization.context.scope,
          }),
        );
      }
      const capabilities = checkToolCapabilities(
        name,
        ASSESSMENT_REQUIRED_CAPABILITY_NAMES,
        authorization,
      );
      if (!capabilities.ok) return capabilities;
      const assessment = byId.get(query.assessmentId as string);
      const context: DomainErrorContext = { scope: authorization.context.scope };
      if (assessment === undefined) {
        return fail(evidenceNotFound(name, 'margin assessment', query.assessmentId, context));
      }
      const covered = scopeCoversEntity(
        authorization.context.scope,
        assessment.scope,
        CHANGE_EVENT_ENTITY_KIND,
        assessment.sourceEventId,
        context,
      );
      if (!covered.ok) {
        // No existence oracle: a foreign assessment is indistinguishable
        // from an absent one.
        return fail(evidenceNotFound(name, 'margin assessment', query.assessmentId, context));
      }
      return ok([
        {
          kind: 'margin-assessment',
          ref: assessment.assessmentId,
          entity: {
            entityKind: CHANGE_EVENT_ENTITY_KIND,
            entityId: assessment.sourceEventId,
          },
          scope: assessment.scope,
          confidence: assessment.confidence,
          retrieval: { tool: name, query, retrievedAt: options.now() },
        } satisfies EvidenceItem,
      ]);
    },
  };
}

// ----- the memory-evidence tool (recorded outcomes and lessons) ----------------------------------

/**
 * One RECORDED memory outcome summarized for evidence retrieval: the memory
 * engine (@office/intelligence-memory) derived it upstream; the runtime
 * retrieves its typed reference and scope.
 */
export interface MemoryOutcomeEvidenceRecord {
  /** The outcome's typed identity (the memory package's own grammar). */
  readonly outcomeId: OutcomeId;
  /** The scope the outcome was recorded under. */
  readonly scope: Scope;
  /** The completed project the outcome is about. */
  readonly projectId: EntityId;
  /** When the outcome was recorded (the memory engine's injected clock). */
  readonly recordedAt: Timestamp;
  /** The outcome's own A4 confidence. */
  readonly confidence: ConfidenceLevel;
}

/**
 * One RECORDED memory lesson summarized for evidence retrieval (the memory
 * engine's own typed lesson identity).
 */
export interface MemoryLessonEvidenceRecord {
  /** The lesson's typed identity (the memory package's own grammar). */
  readonly lessonId: LessonId;
  /** The scope the lesson was captured under. */
  readonly scope: Scope;
  /** When the lesson was captured (the memory engine's injected clock). */
  readonly capturedAt: Timestamp;
  /** The lesson's own A4 confidence. */
  readonly confidence: ConfidenceLevel;
}

/** Options of createMemoryEvidenceTool. */
export interface MemoryEvidenceToolOptions {
  /** The tool's registered name (default 'memory-lookup'). */
  readonly name?: string;
  /** The tool's title (default derived from the name). */
  readonly title?: string;
  /** The tool's description, or null. */
  readonly description?: string | null;
  /** The recorded outcomes, in stable order (injected). */
  readonly outcomes: readonly MemoryOutcomeEvidenceRecord[];
  /** The recorded lessons, in stable order (injected). */
  readonly lessons: readonly MemoryLessonEvidenceRecord[];
  /** The injected clock stamping retrieval instants. */
  readonly now: () => Timestamp;
}

/**
 * Create the memory-evidence tool: a typed read port over RECORDED memory
 * outcomes and lessons. Fail-closed on the memory package's own capability
 * requirements; out-of-scope records are INVISIBLE (excluded from the
 * result — the same no-oracle discipline the memory engine's permissioned
 * queries apply), never errors, never leaks.
 */
export function createMemoryEvidenceTool(options: MemoryEvidenceToolOptions): EvidenceTool {
  const name = options.name ?? 'memory-lookup';
  const descriptor = defineToolDescriptor({
    name,
    kind: 'read',
    title: options.title ?? 'Memory lookup evidence',
    description:
      options.description ??
      'Retrieves recorded memory outcomes and lessons by typed identity (@office/intelligence-memory references).',
  });
  const contextOf = (authorization: ToolAuthorization): DomainErrorContext => ({
    scope: authorization.context.scope,
  });
  return {
    descriptor,
    retrieve: async (query, authorization) => {
      if (query.kind !== 'memory-outcomes' && query.kind !== 'memory-lessons') {
        return fail(
          toolQueryMismatch(name, 'memory-outcomes', query.kind, {
            scope: authorization.context.scope,
          }),
        );
      }
      const capabilities = checkToolCapabilities(
        name,
        MEMORY_REQUIRED_CAPABILITY_NAMES,
        authorization,
      );
      if (!capabilities.ok) return capabilities;
      const retrievedAt = options.now();
      if (query.kind === 'memory-outcomes') {
        const visible = options.outcomes.filter((outcome) => {
          if (query.projectId !== null && outcome.projectId !== query.projectId) {
            return false;
          }
          return (
            scopeCoversEntity(
              authorization.context.scope,
              outcome.scope,
              PROJECT_ENTITY_KIND,
              outcome.projectId,
              contextOf(authorization),
            ).ok
          );
        });
        return ok(
          visible.map((outcome) => ({
            kind: 'memory-outcome',
            ref: outcome.outcomeId,
            entity: { entityKind: PROJECT_ENTITY_KIND, entityId: outcome.projectId },
            scope: outcome.scope,
            confidence: outcome.confidence,
            retrieval: { tool: name, query, retrievedAt },
          })) satisfies readonly EvidenceItem[],
        );
      }
      const visible = options.lessons.filter((lesson) =>
        scopeCoversEntity(
          authorization.context.scope,
          lesson.scope,
          EVIDENCE_ITEM_ENTITY_KIND,
          null,
          contextOf(authorization),
        ).ok,
      );
      return ok(
        visible.map((lesson) => ({
          kind: 'memory-lesson',
          ref: lesson.lessonId,
          entity: null,
          scope: lesson.scope,
          confidence: lesson.confidence,
          retrieval: { tool: name, query, retrievedAt },
        })) satisfies readonly EvidenceItem[],
      );
    },
  };
}

// ----- the model-proposing tool (the injected ModelPort behind a typed descriptor) --------------

/** Options of createModelProposingTool. */
export interface ModelProposingToolOptions {
  /** The tool's registered name (default 'model-proposer'). */
  readonly name?: string;
  /** The tool's title (default derived from the name). */
  readonly title?: string;
  /** The tool's description, or null. */
  readonly description?: string | null;
  /** The injected model port (deterministic mock in tests — never a real LLM). */
  readonly model: ModelPort;
}

/**
 * Create the action-proposing tool: the injected ModelPort behind a typed
 * 'propose-action' descriptor. The tool converts the model's drafts into
 * VALIDATED ProposedAction values (fail-closed: an invalid draft is a typed
 * rejection, never a silently-coerced proposal) — and nothing else: the
 * proposals are returned to the runtime, which alone hands them to the
 * gateway. This tool has no execution surface (freeze A8).
 */
export function createModelProposingTool(options: ModelProposingToolOptions): ProposingTool {
  const name = options.name ?? 'model-proposer';
  const descriptor = defineToolDescriptor({
    name,
    kind: 'propose-action',
    title: options.title ?? 'Model action proposer',
    description:
      options.description ??
      'Produces typed action proposals from the goal and gathered evidence through the injected model port (deterministic mock; never a real model call).',
  });
  return {
    descriptor,
    propose: async (input: ProposingInput) => {
      const proposed = await options.model.propose(input);
      if (!proposed.ok) return proposed;
      const actions: ProposedAction[] = [];
      for (const [index, draft] of proposed.value.entries()) {
        try {
          actions.push(
            proposedAction({
              command: draft.command,
              subject: draft.subject ?? null,
              evidence: draft.evidence ?? [],
              confidence: draft.confidence,
              rationale: draft.rationale,
              resourceScope: draft.resourceScope ?? null,
            }),
          );
        } catch (error) {
          return fail(
            domainError(
              'invariant-violation',
              `model '${options.model.modelId}' produced an invalid proposal draft at index ${index}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              [
                {
                  code: 'invalid-model-proposal',
                  message: `draft ${index} failed validation`,
                  path: `proposals[${index}]`,
                },
              ],
              undefined,
            ),
          );
        }
      }
      return ok(actions);
    },
  };
}

const CHANGE_EVENT_ENTITY_KIND = 'change-event' as EntityKind;
const PROJECT_ENTITY_KIND = 'project' as EntityKind;
const EVIDENCE_ITEM_ENTITY_KIND = 'evidence-reference' as EntityKind;

// ----- the shared scope-coverage helper of the read tools ----------------------------------------

const scopeCoversEntity = (
  requestScope: Scope,
  resourceScopeValue: Scope,
  entityKind: EntityKind,
  entityId: EntityId | null,
  context?: DomainErrorContext,
): Result<true, DomainError> =>
  checkScopeCoversResource(
    requestScope,
    resourceScope({
      scope: resourceScopeValue,
      resourceKind: entityKind,
      resourceId: entityId,
      ownerId: null,
    }),
    context,
  );
