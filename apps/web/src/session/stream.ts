// Office web application shell — the session's data plane (OFF-030).
//
// The ONLINE session stream over @office/sync + @office/client-sync: the
// shell session joins ONE project slice's stream through an explicit A9
// subscription grant, and every command the session issues flows through
// @office/client-sync's ONLINE submission path (the connected twin of the
// offline queue): the deterministic operation id becomes the command's
// idempotency key, the mutation is authorized (grant → capability → policy,
// deny-by-default, A12 re-checked), executed through the world's typed
// command path (the LANDED domain command services), journaled, and its
// ledger event is fanned out on the live stream — so the session's views
// re-derive from the SAME events the server appended (ONE project state,
// all clients share it — freeze A12).
//
// This module is pure composition over the landed packages' public
// surfaces: it constructs NO gateway, performs NO I/O, reads NO clock (the
// `now` of every submission is injected by the caller), and holds no state
// the ledger does not already carry (the engine's consumed-events view is
// the client's own cursor discipline, not a second source of truth).
import type { Capability } from '@office/authz';
import { parseOperationKind } from '@office/sync';
import { CURRENT_PROTOCOL_VERSION } from '@office/sync';
import { createInMemoryOperationRegistry } from '@office/sync';
import { subscription, subscriptionFilter, subscriptionIdOf } from '@office/sync';
import type { Subscription } from '@office/sync';
import { createInMemoryConflictLog, createInMemoryOperationJournal, createInMemorySyncEventSink } from '@office/client-sync';
import { createSyncEngine } from '@office/client-sync';
import type { SyncEngine, SyncAuditSinkExecutor, TypedCommandPath } from '@office/client-sync';
import type { CommandName, CorrelationId, EntityRef, Timestamp } from '@office/contracts';
import { parseCorrelationId } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import type { SeededWorld } from './world';
import type { WebSession } from './session';
import { sessionContextOf, sessionCoversScope } from './session';

/** The structural executor the sync audit sink appends with (opaque handle). */
const syncAuditExecutor: SyncAuditSinkExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

/**
 * One mutation the shell session submits through its online data plane:
 * the typed command reference (name + JSON payload), the canonical entity
 * the mutation addresses, the domain-owned operation kind, and the write
 * capability the replay must be granted (A9/A12 — authorization holds on
 * every submission, never just the first).
 */
export interface WebCommandRequest {
  readonly commandName: CommandName;
  readonly payload: Record<string, unknown>;
  /** The canonical entity the mutation addresses (the A12 target). */
  readonly target: EntityRef;
  /** The domain-owned operation kind (kebab-case, e.g. 'capture-field-observation'). */
  readonly operationKind: string;
  /** The write capability the submission requires (declared, closed vocabulary). */
  readonly requiredCapability: Capability;
}

/** Why a submission request was rejected before any effect (displayable). */
export type WebCommandRequestRejection =
  | { readonly code: 'invalid-operation-kind'; readonly received: string };

/** The shell's online session data plane (one client's sync session). */
export interface WebDataPlane {
  readonly kind: 'web-data-plane';
  /** The session's subscription contract. */
  readonly subscription: Subscription;
  /** The composed in-memory sync engine (one client's session). */
  readonly engine: SyncEngine;
  /** Submit one mutation through the online path (typed Results, never throws). */
  submit(
    request: WebCommandRequest,
    now: Timestamp,
  ): Promise<
    Result<
      {
        readonly operationId: string;
        readonly eventId: string;
        readonly eventName: string;
        readonly replayed: boolean;
      },
      DomainError | WebCommandRequestRejection
    >
  >;
  /** Consume this session's unread live deliveries (cursor-disciplined). */
  consume(): Result<readonly LedgerEvent[], DomainError>;
  /** Every event this session has consumed, in consumption order. */
  readonly consumedEvents: readonly LedgerEvent[];
}

/**
 * Open the session's data plane: issue the A9 grant, compose the
 * subscription, wire @office/client-sync's engine over the world's broker +
 * slice + typed command path, and subscribe (the initial catchup is consumed
 * — the session's causal-token basis). Deterministic: the grant serial, the
 * subscription ordinal, and the injected `now` are caller-supplied.
 */
export async function openWebDataPlane(
  world: SeededWorld,
  session: WebSession,
  parts: { readonly now: () => Timestamp; readonly serial?: number; readonly ordinal?: number },
): Promise<WebDataPlane> {
  const serial = parts.serial ?? 1;
  const ordinal = parts.ordinal ?? 1;
  const grant = world.broker.issueGrant({
    subscriberId: session.actor.actorId,
    context: sessionContextOf(session),
    grantedBy: session.actor,
    now: parts.now(),
    serial,
  });
  if (!grant.ok) {
    throw new TypeError(`data plane wiring error (grant): ${grant.error.message}`);
  }
  const subscriptionId = subscriptionIdOf({
    tenantId: session.tenantId,
    projectId: session.projectId,
    subscriberId: session.actor.actorId,
    ordinal,
  });
  const contract: Subscription = subscription({
    subscriptionId,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    filter: subscriptionFilter({ scope: session.scope }),
    grantId: grant.value.grantId,
    grantVersion: grant.value.version,
  });

  // The typed command path: the world's own generic execution (the LANDED
  // domain command services), returning the ledger event the command
  // appended — exactly the port @office/client-sync drains through.
  const commandPath: TypedCommandPath = {
    execute: async (command, _context) => {
      const executed = await world.execute(command);
      if (!executed.ok) return { ok: false, error: executed.error };
      return {
        ok: true,
        value: { event: executed.value.event, replayed: executed.value.replayed },
      };
    },
  };

  const engine = createSyncEngine({
    broker: world.broker,
    slice: world.slice,
    registry: createInMemoryOperationRegistry(),
    commandPath,
    journal: createInMemoryOperationJournal(),
    conflicts: createInMemoryConflictLog(),
    policy: session.policy,
    audit: { sink: createInMemorySyncEventSink(), executor: syncAuditExecutor },
    clientId: session.actor.actorId,
    subscription: contract,
    grantId: grant.value.grantId,
    scope: session.scope,
  });

  const subscribed = await engine.subscribe();
  if (!subscribed.ok) {
    throw new TypeError(`data plane wiring error (subscribe): ${subscribed.error.message}`);
  }

  return {
    kind: 'web-data-plane',
    subscription: contract,
    engine,
    submit: async (request, now) => {
      // A12 FIRST: the session must resolve against THIS world's project
      // scope before any command is composed — a foreign tenant's or a
      // foreign project's session is a typed unauthorized rejection (a
      // displayable view model, never an effect, never a throw).
      if (!sessionCoversScope(session, world.scope)) {
        return {
          ok: false,
          error: domainError(
            'unauthorized',
            `the session's scope does not cover this world's project state (session project ${session.projectId})`,
            [
              {
                code: 'session-scope-uncovered',
                message: `tenant ${session.tenantId} project ${session.projectId}`,
                path: null,
              },
            ],
            { scope: session.scope, correlationId: null },
          ),
        };
      }
      const operationKind = parseOperationKind(request.operationKind);
      if (!operationKind.ok) {
        return { ok: false, error: { code: 'invalid-operation-kind', received: request.operationKind } };
      }
      const submitted = await engine.submitOnline(
        {
          commandName: request.commandName,
          scope: session.scope,
          actor: session.actor,
          correlationId: WEB_SESSION_CORRELATION,
          payload: request.payload,
          target: request.target,
          operationKind: operationKind.value,
          requiredCapability: request.requiredCapability,
        },
        now,
      );
      if (!submitted.ok) return { ok: false, error: submitted.error };
      return {
        ok: true,
        value: {
          operationId: submitted.value.operation.operationId,
          eventId: submitted.value.event.eventId,
          eventName: submitted.value.event.envelope.eventName,
          replayed: submitted.value.replayed,
        },
      };
    },
    consume: () => engine.consumeLive(),
    get consumedEvents(): readonly LedgerEvent[] {
      return engine.consumedEvents;
    },
  };
}

/**
 * The session's causal-chain correlation id (fixed literal, deterministic —
 * parsed once through the canonical grammar; a wiring typo is a LOUD error).
 */
const WEB_SESSION_CORRELATION: CorrelationId = (() => {
  const parsed = parseCorrelationId('web-shell-corr-0001');
  if (!parsed.ok) {
    throw new TypeError(`shell wiring error (session correlation): ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
})();
