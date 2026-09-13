// Office intelligence — package-internal test support (OFF-019).
//
// NOT part of the public surface: deterministic factories for the command
// and event envelopes the golden control-tower scenario streams need,
// mirroring the landed intelligence peers' test-support idioms exactly
// (the domain packages cannot be imported, so their envelope-builder
// behavior is reproduced through the canonical contracts: commands parse
// through parseCommandEnvelope, events self-check through
// parseDomainEventEnvelope, and event causality is derived through the
// REAL @office/events conventions — causedByCommand / causedByEvent).
// Fixed clock, fixed ids, fixed correlation/causation tokens: no Date.now,
// no Math.random, no environment.
import {
  CURRENT_SCHEMA_VERSION,
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseDomainEventEnvelope,
  parseIdempotencyKey,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  Causality,
  CommandEnvelope,
  DomainEventEnvelope,
  EntityId,
  EntityRef,
  IdempotencyKey,
  Scope,
  Timestamp,
} from '@office/contracts';
import { causedByCommand, causedByEvent } from '@office/events';
import type { LedgerEvent } from '@office/events';
import { createInMemoryEventSource } from '@office/intelligence-relationships';
import type { InMemoryEventSource } from '@office/intelligence-relationships';
import { authorizationContext, definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import { parseAssessmentId } from '@office/intelligence-margin';
import type { AssessmentId } from '@office/intelligence-margin';
import { parseScanId } from './vocabulary';
import type { ScanId } from './vocabulary';
import type { ExceptionAuthorization } from './authorization';

/** Unwrap a typed Result (failures are test bugs — loud, never silent). */
export const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

/** The fixed test clock (deterministic — replayed streams replay exactly). */
export const T0: Timestamp = unwrap(parseTimestamp('2026-09-12T08:00:00.000Z'));
export const T1: Timestamp = unwrap(parseTimestamp('2026-09-13T09:30:00.000Z'));
export const T2: Timestamp = unwrap(parseTimestamp('2026-09-14T11:45:00.000Z'));
export const T3: Timestamp = unwrap(parseTimestamp('2026-09-15T14:15:00.000Z'));
export const T4: Timestamp = unwrap(parseTimestamp('2026-09-16T16:45:00.000Z'));
export const T5: Timestamp = unwrap(parseTimestamp('2026-09-17T10:00:00.000Z'));

/** The fixed assessment clock (the injected `assessedAt` of every golden). */
export const ASSESSED_AT: Timestamp = unwrap(parseTimestamp('2026-09-18T09:00:00.000Z'));

/** The fixed detection clock (the injected `detectedAt` of every golden scan). */
export const DETECTED_AT: Timestamp = unwrap(parseTimestamp('2026-09-19T09:00:00.000Z'));

/** Two tenants (A12 isolation tests run in BOTH directions). */
export const TENANT_A = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
export const TENANT_B = formatTenantId({
  version: 'v1',
  opaque: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
});

/** Two projects of tenant A (the project second boundary). */
export const PROJECT_1 = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
export const PROJECT_2 = formatProjectId({
  version: 'v1',
  opaque: 'a9f8e7d6c5b4a39281706f5e4d3c2b10',
});

/** The fixed acting user (a canonical actor, not a provider identity). */
export const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
export const USER_ACTOR: Actor = { kind: 'user', actorId: ACTOR_ID };

export const projectOneScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_1,
});

export const projectTwoScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_2,
});

export const tenantBScope = (): Scope => ({
  kind: 'tenant',
  tenantId: TENANT_B,
});

/** Deterministic entity ids: <prefix><n> padded to the 16-char opaque minimum. */
export const testId = (prefix: string, n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

/** Deterministic idempotency keys (the causation tokens of command roots). */
export const testKey = (n: number): IdempotencyKey =>
  unwrap(parseIdempotencyKey(`test-key-${String(n).padStart(4, '0')}`));

/** Deterministic correlation ids (one per causal chain). */
export const testCorrelationId = (n: number): string => `corr-${String(n).padStart(8, '0')}`;

/** Deterministic assessment identities (the injected tokens of the goldens). */
export const testAssessmentId = (n: number): AssessmentId =>
  unwrap(parseAssessmentId(`assessment-${String(n).padStart(4, '0')}`));

/** Deterministic scan identities (the injected tokens of the golden scans). */
export const testScanId = (n: number): ScanId =>
  unwrap(parseScanId(`scan-${String(n).padStart(4, '0')}`));

/**
 * Build one canonical CommandEnvelope (trusted path, self-checked through
 * the contracts parser — same discipline as the domain builders).
 */
export const testCommand = (parts: {
  readonly commandName: string;
  readonly scope: Scope;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly issuedAt: Timestamp;
}): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName: parts.commandName,
      scope: parts.scope,
      actor: USER_ACTOR,
      idempotencyKey: parts.idempotencyKey,
      causality: {
        correlationId: parts.correlationId,
        causationId: null,
      },
      issuedAt: parts.issuedAt,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {},
    }),
  );

/**
 * Build one canonical DomainEventEnvelope (trusted path, self-checked
 * through the contracts parser so an emitted test event can never be
 * invalid — mirroring the domain packages' envelope builders).
 */
export const testEventEnvelope = (parts: {
  readonly eventName: string;
  readonly scope: Scope;
  readonly causality: Causality;
  readonly occurredAt: Timestamp;
  readonly payload: Record<string, unknown>;
}): DomainEventEnvelope =>
  unwrap(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName: parts.eventName,
      scope: parts.scope,
      actor: USER_ACTOR,
      source: 'domain',
      causality: parts.causality,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      occurredAt: parts.occurredAt,
      entityRefs: { before: null, after: null },
      payload: parts.payload,
    }),
  );

/** Create the shared in-memory ledger-shaped event source (tests). */
export const newEventSource = (): InMemoryEventSource => createInMemoryEventSource();

/**
 * Append one ledger-shaped event to the in-memory source, deriving its
 * causality from a COMMAND (the OFF-005 convention: correlation carried
 * over, causation id = the command's idempotency key).
 */
export const appendCommandEvent = async (
  source: InMemoryEventSource,
  parts: {
    readonly command: CommandEnvelope;
    readonly eventName: string;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly aggregate: EntityRef;
    readonly payload: Record<string, unknown>;
  },
): Promise<LedgerEvent> =>
  unwrap(
    await source.append(
      testEventEnvelope({
        eventName: parts.eventName,
        scope: parts.scope,
        causality: causedByCommand(parts.command),
        occurredAt: parts.occurredAt,
        payload: parts.payload,
      }),
      parts.aggregate,
    ),
  );

/**
 * Append one ledger-shaped event caused by a PRIOR EVENT (the reaction
 * convention: correlation carried over, causation id = the prior event's
 * ledger id).
 */
export const appendReactionEvent = async (
  source: InMemoryEventSource,
  parts: {
    readonly causedBy: LedgerEvent;
    readonly eventName: string;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly aggregate: EntityRef;
    readonly payload: Record<string, unknown>;
  },
): Promise<LedgerEvent> =>
  unwrap(
    await source.append(
      testEventEnvelope({
        eventName: parts.eventName,
        scope: parts.scope,
        causality: causedByEvent(parts.causedBy),
        occurredAt: parts.occurredAt,
        payload: parts.payload,
      }),
      parts.aggregate,
    ),
  );

// ---------------------------------------------------------------------------
// Exception-authorization factories (deterministic, deny-by-default probes).
// ---------------------------------------------------------------------------

/** Every area read capability an exception scan/read requires. */
export const ALL_EXCEPTION_CAPABILITIES: readonly string[] = [
  'organization.read',
  'projects.read',
  'documents.read',
  'work.read',
  'schedule.read',
  'cost.read',
  'contracts.read',
];

/** The allow-all-reads policy: every read within the caller's covered scope. */
export const ALLOW_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'allow', actions: ['read'] },
]);

/** The explicit-deny-every-read policy (explicit deny wins over any allow). */
export const DENY_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'deny', actions: ['read'] },
]);

/** The empty policy — no rules at all (deny-by-default, 'no-allow-rule'). */
export const EMPTY_POLICY: Policy = definePolicy([]);

/**
 * An exception authorization for the fixed test user: the given scope, the
 * given capabilities (default: every area read), and the given policy
 * (default: allow-all-reads). Capability/policy combos are the A12 and
 * capability-missing probes of the exception tests.
 */
export const exceptionAuthorizationOf = (
  scope: Scope,
  parts: {
    readonly capabilities?: readonly string[];
    readonly policy?: Policy;
  } = {},
): ExceptionAuthorization => ({
  policy: parts.policy ?? ALLOW_ALL_READS_POLICY,
  context: authorizationContext({
    actor: USER_ACTOR,
    scope,
    capabilities: parts.capabilities ?? ALL_EXCEPTION_CAPABILITIES,
  }),
});

/** The project-one reader every golden scenario scans under. */
export const projectOneReader = (): ExceptionAuthorization =>
  exceptionAuthorizationOf(projectOneScope());
