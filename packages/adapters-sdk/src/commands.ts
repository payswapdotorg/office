// Office adapters-sdk — the canonical command translation seam (OFF-020).
//
// Adapters NEVER write the graph (freeze A8/A11): they translate provider
// observations into TYPED COMMANDS the Action Gateway / application layer
// executes. This module defines that seam:
//
//   - AdapterCommandInput — what an engine hands an adapter's translator:
//     the origin (sync page or webhook), the tenant, the SourceRef, the
//     resolved (or freshly issued) canonical EntityRef, the observed
//     canonical version, the change kind (created/updated/deleted), and the
//     provider payload data;
//   - AdapterCommandTranslator — the adapter-implemented port proposing the
//     canonical command name + payload for one input;
//   - adapterCommandEnvelope — the SDK's deterministic envelope composer:
//     scope/actor from the adapter authorization context, idempotency key
//     derived from the SourceRef (one command per provider object version,
//     shared across the sync and webhook paths), causality tying the whole
//     provider object lifecycle into one correlation chain, issuedAt from
//     the injected clock, and the current schema version. The output is a
//     contracts CommandEnvelope — parseable by parseCommandEnvelope by
//     construction (the engines prove it on every proposal).
import {
  CURRENT_SCHEMA_VERSION,
  isCommandName,
  parseCausationId,
  parseCommandEnvelope,
} from '@office/contracts';
import type {
  CausationId,
  CommandEnvelope,
  CommandName,
  EntityId,
  EntityRef,
  TenantId,
  Timestamp,
} from '@office/contracts';
import type { AuthorizationContext } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import type { AdapterJsonObject } from './json';
import { isPlainObject } from './parse';
import { coordinateOf, sourceCorrelationId, syncIdempotencyKey } from './source-ref';
import type { SourceRef } from './source-ref';

/** What changed on the provider object, normalized across the intake paths. */
export type AdapterChangeKind = 'created' | 'updated' | 'deleted';

/** Which intake path produced a translation request. */
export type AdapterCommandOrigin = 'sync' | 'webhook';

/** The injected clock: the canonical 'now' of each engine run. */
export type EngineClock = () => Timestamp;

/** The injected office-issued canonical id supplier (never a provider id). */
export type CanonicalIdSupplier = () => EntityId;

/**
 * The canonical-state lookup port (the runtime owns the graph): the current
 * aggregate version of one canonical entity within a tenant, or null when
 * the entity is not present canonically.
 */
export type CanonicalVersionLookup = (
  tenantId: TenantId,
  canonical: EntityRef,
) => Promise<Result<AggregateVersion | null, DomainError>>;

/** What an engine hands an adapter's translator for one provider observation. */
export interface AdapterCommandInput {
  /** The intake path that produced this observation. */
  readonly origin: AdapterCommandOrigin;
  /** The tenant whose engine run produced this observation. */
  readonly tenantId: TenantId;
  /** The provider object's full identity at this version. */
  readonly source: SourceRef;
  /** The canonical entity the source maps to (null only pre-mapping). */
  readonly canonical: EntityRef | null;
  /** The canonical aggregate version observed at this intake, or null. */
  readonly canonicalVersion: AggregateVersion | null;
  /** What changed (created/updated/deleted — normalized vocabulary). */
  readonly changeKind: AdapterChangeKind;
  /** The provider object's display name when the path carries one. */
  readonly displayName: string | null;
  /** The provider's payload data for this observation (extension bag). */
  readonly data: AdapterJsonObject;
}

/** The adapter's proposal: the canonical command name + typed payload. */
export interface AdapterCommandProposal {
  /** The canonical command to execute, e.g. 'organization.createOrganization'. */
  readonly commandName: CommandName;
  /** The command payload — a JSON object the owning domain validates. */
  readonly payload: AdapterJsonObject;
}

/**
 * The adapter-implemented translation port: propose the canonical command
 * for one provider observation. Typed Result — a translation failure is a
 * value, and a failed proposal never produces a command envelope.
 */
export interface AdapterCommandTranslator {
  proposeCommand(input: AdapterCommandInput): Result<AdapterCommandProposal, DomainError>;
}

/** The deterministic envelope-composer inputs. */
export interface AdapterCommandEnvelopeParts {
  readonly proposal: AdapterCommandProposal;
  /** The adapter authorization context the engine executes under. */
  readonly context: AuthorizationContext;
  readonly source: SourceRef;
  /**
   * The message that caused this command: the webhook's deduplication key on
   * the webhook path; null on the sync path (a provider snapshot is a chain
   * root, not a prior message).
   */
  readonly causationId: CausationId | null;
  /** The injected clock's instant recorded as issuedAt. */
  readonly now: Timestamp;
}

/** Validate a proposal on the trusted path (loud, never coercing). */
const validateProposal = (proposal: AdapterCommandProposal): void => {
  if (!isCommandName(proposal.commandName)) {
    throw new TypeError(`invalid command name: ${String(proposal.commandName)}`);
  }
  if (!isPlainObject(proposal.payload)) {
    throw new TypeError('command payload must be a JSON object');
  }
};

/**
 * Compose the typed CommandEnvelope of one adapter proposal (deterministic):
 * kind 'command', the proposal's name and payload, scope + actor from the
 * adapter context, the SourceRef-derived idempotency key, causality tying
 * the provider object's whole lifecycle into one correlation chain, issuedAt
 * from the injected clock, and the current schema version.
 */
export function adapterCommandEnvelope(
  parts: AdapterCommandEnvelopeParts,
): CommandEnvelope<AdapterJsonObject> {
  validateProposal(parts.proposal);
  return {
    kind: 'command',
    commandName: parts.proposal.commandName,
    scope: parts.context.scope,
    actor: parts.context.actor,
    idempotencyKey: syncIdempotencyKey(parts.source),
    causality: {
      correlationId: sourceCorrelationId(coordinateOf(parts.source)),
      causationId: parts.causationId,
    },
    issuedAt: parts.now,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    payload: parts.proposal.payload,
  };
}

/** Re-brand an already-validated webhook dedup token as a CausationId. */
export function causationIdOfWebhook(token: string): CausationId {
  const parsed = parseCausationId(token);
  if (!parsed.ok) {
    throw new TypeError(`token is not a valid causation id: ${token}`);
  }
  return parsed.value;
}

/** Typed guard used by translators that require a resolved canonical target. */
export function requireCanonicalTarget(
  input: AdapterCommandInput,
): Result<EntityRef, DomainError> {
  if (input.canonical !== null) return ok(input.canonical);
  return fail(
    domainError(
      'invariant-violation',
      `translation for change kind '${input.changeKind}' requires a resolved canonical target — the engine did not provide one`,
      [{ code: 'canonical-target-required', message: input.changeKind, path: 'canonical' }],
      { scope: { kind: 'tenant', tenantId: input.tenantId } },
    ),
  );
}

/**
 * Prove a composed adapter command envelope round-trips the contracts
 * parser (the engines' defensive check on every proposal): a composed
 * envelope that does not parse is a typed invariant-violation, never a
 * silently-malformed command handed to the Action Gateway.
 */
export function checkCommandEnvelopeRoundTrip(
  command: CommandEnvelope<AdapterJsonObject>,
  tenantId: TenantId,
): Result<true, DomainError> {
  const roundTrip = parseCommandEnvelope(command);
  if (roundTrip.ok) return ok(true);
  return fail(
    domainError(
      'invariant-violation',
      `adapter command envelope did not round-trip the contracts parser: ${roundTrip.error.code} at '${roundTrip.error.path}'`,
      [
        {
          code: 'command-envelope-invalid',
          message: roundTrip.error.received,
          path: roundTrip.error.path,
        },
      ],
      { scope: { kind: 'tenant', tenantId } },
    ),
  );
}
