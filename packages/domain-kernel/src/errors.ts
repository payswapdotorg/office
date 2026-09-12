// Office domain kernel — domain error model (OFF-003).
//
// DomainError is the kernel's typed failure vocabulary: the value carried on
// the failure channel of Result (see result.ts). Expected domain failures
// are values, never exceptions — handlers return them, tests assert them,
// and transport surfaces translate them.
//
// The taxonomy is aligned with the @office/contracts ApiError vocabulary
// where sensible (DOMAIN_ERROR_TO_API_ERROR_CODE gives the 1:1 mapping used
// by toApiError); the kernel never constructs an ApiError on its own —
// toApiError is the single, explicit bridge. Authorization enforcement
// (which of unauthorized/forbidden applies to a given caller) is refined by
// OFF-006; the kernel only emits the vocabulary.
//
// `scope` and `correlationId` are null exactly when the failing operation
// could not establish them — same convention as ApiError. Cross-tenant
// violations carry the command's scope (not the foreign tenant's), and
// whether a transport surface hides existence behind not_found is an
// OFF-006/API decision, not a kernel one.
import type {
  ApiError,
  ApiErrorCode,
  CorrelationId,
  EntityId,
  EntityKind,
  IdempotencyKey,
  ProjectId,
  Scope,
  TenantId,
} from '@office/contracts';

/** The kernel's typed domain failure codes. */
export type DomainErrorCode =
  /** A requested mutation would violate a domain invariant of the target aggregate. */
  | 'invariant-violation'
  /** The presented optimistic-concurrency version is stale (never silently overwritten). */
  | 'concurrency-conflict'
  /** The addressed aggregate/entity does not exist (in the accessible scope). */
  | 'not-found'
  /** The operation's scope does not cover the target — e.g. cross-tenant access (freeze A12). */
  | 'unauthorized'
  /** The actor is identified but lacks the required capability (refined by OFF-006). */
  | 'forbidden'
  /** An idempotency key was reused for a different command (freeze A8 / ADR-005). */
  | 'idempotency-conflict';

/** All domain error codes, in taxonomy order. */
export const DOMAIN_ERROR_CODES: readonly DomainErrorCode[] = [
  'invariant-violation',
  'concurrency-conflict',
  'not-found',
  'unauthorized',
  'forbidden',
  'idempotency-conflict',
] as const;

/** Mapping of each domain error code onto the contracts ApiError vocabulary. */
export const DOMAIN_ERROR_TO_API_ERROR_CODE: Readonly<
  Record<DomainErrorCode, ApiErrorCode>
> = {
  'invariant-violation': 'validation_failed',
  'concurrency-conflict': 'conflict',
  'not-found': 'not_found',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  'idempotency-conflict': 'conflict',
};

/** One structured, machine-readable domain error detail. */
export interface DomainErrorDetail {
  /** Stable machine-readable detail code, e.g. 'tenant-scope-violation'. */
  readonly code: string;
  /** Human-readable explanation safe to display. */
  readonly message: string;
  /** Dotted path to the offending part, or null when not applicable. */
  readonly path: string | null;
}

/**
 * Optional context a failing operation can attach: the tenant/project scope
 * and correlation id it was executing under. Omitted fields default to null.
 */
export interface DomainErrorContext {
  readonly scope?: Scope | null;
  readonly correlationId?: CorrelationId | null;
}

/** Typed, machine-readable domain failure — the Result error channel value. */
export interface DomainError {
  readonly kind: 'domain-error';
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly scope: Scope | null;
  readonly correlationId: CorrelationId | null;
  readonly details: readonly DomainErrorDetail[];
}

const requireStringPart = (part: unknown, what: string): string => {
  if (typeof part !== 'string' || part.length === 0) {
    throw new TypeError(`domain error ${what} must be a non-empty string`);
  }
  return part;
};

const resolveContext = (
  context?: DomainErrorContext,
): { scope: Scope | null; correlationId: CorrelationId | null } => ({
  scope: context?.scope ?? null,
  correlationId: context?.correlationId ?? null,
});

/** Build a DomainError from validated parts (trusted path). */
export function domainError(
  code: DomainErrorCode,
  message: string,
  details: readonly DomainErrorDetail[],
  context?: DomainErrorContext,
): DomainError {
  if (!(DOMAIN_ERROR_CODES as readonly string[]).includes(code)) {
    throw new TypeError(`unknown domain error code: ${String(code)}`);
  }
  const resolved = resolveContext(context);
  return {
    kind: 'domain-error',
    code,
    message: requireStringPart(message, 'message'),
    scope: resolved.scope,
    correlationId: resolved.correlationId,
    details: [...details],
  };
}

/** An invariant of the target aggregate would be violated by the mutation. */
export function invariantViolation(
  parts: { readonly name: string; readonly statement: string },
  context?: DomainErrorContext,
): DomainError {
  const name = requireStringPart(parts.name, 'invariant name');
  const statement = requireStringPart(parts.statement, 'invariant statement');
  return domainError(
    'invariant-violation',
    `invariant '${name}' violated: ${statement}`,
    [{ code: name, message: statement, path: null }],
    context,
  );
}

/** Stale optimistic-concurrency version — the mutation never applies. */
export function concurrencyConflict(
  parts: {
    readonly entityKind: EntityKind;
    readonly entityId: EntityId;
    readonly expectedVersion: number;
    readonly actualVersion: number;
  },
  context?: DomainErrorContext,
): DomainError {
  const entityKind = requireStringPart(parts.entityKind, 'entityKind');
  const entityId = requireStringPart(parts.entityId, 'entityId');
  return domainError(
    'concurrency-conflict',
    `stale version for ${entityKind} ${entityId}: expected version ${parts.expectedVersion}, actual version ${parts.actualVersion}`,
    [
      {
        code: 'stale-aggregate-version',
        message: `expected version ${parts.expectedVersion}, actual version ${parts.actualVersion}`,
        path: 'version',
      },
    ],
    context,
  );
}

/** The addressed aggregate/entity does not exist in the accessible scope. */
export function entityNotFound(
  parts: { readonly entityKind: EntityKind; readonly entityId: EntityId },
  context?: DomainErrorContext,
): DomainError {
  const entityKind = requireStringPart(parts.entityKind, 'entityKind');
  const entityId = requireStringPart(parts.entityId, 'entityId');
  return domainError(
    'not-found',
    `${entityKind} ${entityId} not found`,
    [{ code: 'entity-not-found', message: `${entityKind} ${entityId}`, path: null }],
    context,
  );
}

/** Cross-tenant access attempt — prohibited unless mediated by the control plane (A12). */
export function tenantScopeViolation(
  parts: {
    readonly commandTenantId: TenantId;
    readonly aggregateTenantId: TenantId;
  },
  context?: DomainErrorContext,
): DomainError {
  const commandTenantId = requireStringPart(parts.commandTenantId, 'commandTenantId');
  const aggregateTenantId = requireStringPart(parts.aggregateTenantId, 'aggregateTenantId');
  return domainError(
    'unauthorized',
    `command tenant ${commandTenantId} cannot act on an aggregate owned by tenant ${aggregateTenantId}`,
    [
      {
        code: 'tenant-scope-violation',
        message: `command tenant ${commandTenantId}, aggregate tenant ${aggregateTenantId}`,
        path: null,
      },
    ],
    context,
  );
}

/** A project-scoped command addressed an aggregate bound to a different project (A12). */
export function projectScopeViolation(
  parts: {
    readonly commandProjectId: ProjectId;
    readonly aggregateProjectId: ProjectId;
  },
  context?: DomainErrorContext,
): DomainError {
  const commandProjectId = requireStringPart(parts.commandProjectId, 'commandProjectId');
  const aggregateProjectId = requireStringPart(parts.aggregateProjectId, 'aggregateProjectId');
  return domainError(
    'unauthorized',
    `command project ${commandProjectId} cannot act on an aggregate bound to project ${aggregateProjectId}`,
    [
      {
        code: 'project-scope-violation',
        message: `command project ${commandProjectId}, aggregate project ${aggregateProjectId}`,
        path: null,
      },
    ],
    context,
  );
}

/** An idempotency key was reused for a different command (A8 / ADR-005). */
export function idempotencyConflict(
  parts: { readonly idempotencyKey: IdempotencyKey },
  context?: DomainErrorContext,
): DomainError {
  const idempotencyKey = requireStringPart(parts.idempotencyKey, 'idempotencyKey');
  return domainError(
    'idempotency-conflict',
    `idempotency key ${idempotencyKey} was already recorded for a different command`,
    [{ code: 'idempotency-key-reuse', message: idempotencyKey, path: 'idempotencyKey' }],
    context,
  );
}

/**
 * Translate a DomainError into the contracts ApiError envelope for API
 * surfaces. Concurrency conflicts are retryable (refresh the version and
 * retry); every other domain failure is a stable, non-retryable outcome.
 */
export function toApiError(error: DomainError): ApiError {
  return {
    kind: 'error',
    code: DOMAIN_ERROR_TO_API_ERROR_CODE[error.code],
    message: error.message,
    retryable: error.code === 'concurrency-conflict',
    scope: error.scope,
    correlationId: error.correlationId,
    details: [...error.details],
  };
}
