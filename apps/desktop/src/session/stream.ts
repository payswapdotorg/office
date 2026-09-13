// Office desktop client protocol/reference shell — the session's data plane
// (OFF-032).
//
// The desktop session's data plane over @office/sync + @office/client-sync —
// THE SAME client contracts the web and field shells consume: the session
// joins ONE project slice's stream through an explicit A9 subscription
// grant, and the plane wires @office/client-sync's SyncEngine over the
// SEEDED WORLD's SHARED server-side parts (the broker, the slice source, the
// operation registry, the applied-operation journal, the conflict log, the
// sync audit sink, and the world's typed command path). Two planes over one
// world is the desktop-host/web-style-client convergence composition, exactly
// like the landed engine tests' two-client world and the field client's
// office twin.
//
// THE offline discipline lives in the engine (never here): captures taken
// while DISCONNECTED land in the bounded LocalQueue with client-generated
// deterministic operation ids and causal/version tokens; reconnection drives
// the engine's exactly-once drain (catchup → replay → conflict surfacing);
// the ONLY exit from a protected conflict is the typed explicit resolution
// command, whose reconciled mutation re-enters the queue discipline. This
// module is pure composition over the landed packages' public surfaces: it
// constructs NO gateway, performs NO I/O, reads NO clock (the `now` of every
// submission is injected by the caller), and holds no state the ledger does
// not already carry (the engine's consumed-events view is the client's own
// cursor discipline, not a second source of truth).
//
// Mirrors the landed @office/web and @office/field-client data-plane
// disciplines (the structural templates — mirrored, never imported: apps do
// not import apps).
import type { Capability } from '@office/authz';
import { parseOperationKind } from '@office/sync';
import { CURRENT_PROTOCOL_VERSION } from '@office/sync';
import { subscription, subscriptionFilter, subscriptionIdOf } from '@office/sync';
import type { Subscription } from '@office/sync';
import { createSyncEngine } from '@office/client-sync';
import type {
  ConflictResolutionCommand,
  ConflictResolutionReport,
  ProtectionClass,
  QueueEntry,
  ReconnectReport,
  SyncEngine,
  SyncAuditSinkExecutor,
  TypedCommandPath,
} from '@office/client-sync';
import type { CommandName, CorrelationId, EntityRef, ProjectScope, Timestamp } from '@office/contracts';
import { parseCorrelationId } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import type { SeededDesktopWorld } from './world';
import type { DesktopSession } from './session';
import { sessionContextOf, sessionCoversScope } from './session';

/** The structural executor the sync audit sink appends with (opaque handle). */
const syncAuditExecutor: SyncAuditSinkExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

/**
 * One desktop mutation the session submits through its data plane: the typed
 * command reference (name + JSON payload), the canonical entity the mutation
 * addresses (the A12 target + the divergence check's subject), the
 * domain-owned operation kind, the write capability the replay must be
 * granted (A9/A12 — authorization holds on every submission, never just the
 * first), and the domain-declared PROTECTION CLASS (the queue's divergence
 * gate: 'protected' mutations park for explicit resolution, 'open' mutations
 * may be superseded deterministically — freeze A9).
 */
export interface DesktopMutationRequest {
  readonly commandName: CommandName;
  readonly payload: Record<string, unknown>;
  /** The canonical entity the mutation addresses (the A12 target). */
  readonly target: EntityRef;
  /** The domain-owned operation kind (kebab-case, e.g. 'record-cost-item'). */
  readonly operationKind: string;
  /** The write capability the submission requires (declared, closed vocabulary). */
  readonly requiredCapability: Capability;
  /** The domain-declared protection class (queued captures only — freeze A9). */
  readonly protection: ProtectionClass;
}

/** Why a mutation request was rejected before any effect (displayable). */
export type DesktopMutationRequestRejection =
  | { readonly code: 'invalid-operation-kind'; readonly received: string };

/** The desktop session's data plane (one client's sync session). */
export interface DesktopDataPlane {
  readonly kind: 'desktop-data-plane';
  /** The session's subscription contract. */
  readonly subscription: Subscription;
  /** The composed in-memory sync engine (one client's offline session). */
  readonly engine: SyncEngine;
  /** The world's project scope this plane was wired over (the A12 gate). */
  readonly worldScope: ProjectScope;
  /**
   * Submit one mutation through the ONLINE path (the connected twin — the
   * web-style client's mutations and the reference host's online writes).
   * Typed Results, never throws.
   */
  submit(
    request: DesktopMutationRequest,
    now: Timestamp,
  ): Promise<
    Result<
      {
        readonly operationId: string;
        readonly eventId: string;
        readonly eventName: string;
        readonly replayed: boolean;
      },
      DomainError | DesktopMutationRequestRejection
    >
  >;
  /**
   * Capture one mutation while DISCONNECTED (typed-rejected while
   * connected — the online path is submit). The injected `now` becomes the
   * capture's CLIENT-OBSERVED instant (payload data, never ordering
   * authority). Typed Results, never throws.
   */
  capture(
    request: DesktopMutationRequest,
    now: Timestamp,
  ): Result<QueueEntry, DomainError | DesktopMutationRequestRejection>;
  /** Reconnect: catchup + the exactly-once queue drain + conflict surfacing. */
  reconnect(now: Timestamp): Promise<Result<ReconnectReport, DomainError>>;
  /** Resolve a surfaced conflict explicitly (the ONLY protected exit). */
  resolveConflict(
    command: ConflictResolutionCommand,
    now: Timestamp,
  ): Promise<Result<ConflictResolutionReport, DomainError>>;
  /** Consume this session's unread live deliveries (cursor-disciplined). */
  consume(): Result<readonly LedgerEvent[], DomainError>;
  /** Every event this session has consumed, in consumption order (its own view). */
  readonly consumedEvents: readonly LedgerEvent[];
}

/**
 * Open the desktop session's data plane: issue the A9 grant, compose the
 * subscription, wire @office/client-sync's engine over the world's SHARED
 * server-side sync parts + typed command path, and subscribe (the initial
 * catchup is consumed — the session's causal-token basis). Deterministic:
 * the grant serial, the subscription ordinal, and the injected `now` are
 * caller-supplied.
 */
export async function openDesktopDataPlane(
  world: SeededDesktopWorld,
  session: DesktopSession,
  parts: { readonly now: () => Timestamp; readonly serial?: number; readonly ordinal?: number },
): Promise<DesktopDataPlane> {
  const serial = parts.serial ?? 1;
  const ordinal = parts.ordinal ?? 1;
  const grant = world.sync.broker.issueGrant({
    subscriberId: session.actor.actorId,
    context: sessionContextOf(session),
    grantedBy: session.actor,
    now: parts.now(),
    serial,
  });
  if (!grant.ok) {
    throw new TypeError(`desktop data plane wiring error (grant): ${grant.error.message}`);
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
    broker: world.sync.broker,
    slice: world.sync.slice,
    registry: world.sync.registry,
    commandPath,
    journal: world.sync.journal,
    conflicts: world.sync.conflicts,
    policy: session.policy,
    audit: { sink: world.sync.audit.sink, executor: syncAuditExecutor },
    clientId: session.actor.actorId,
    subscription: contract,
    grantId: grant.value.grantId,
    scope: session.scope,
  });

  const subscribed = await engine.subscribe();
  if (!subscribed.ok) {
    throw new TypeError(`desktop data plane wiring error (subscribe): ${subscribed.error.message}`);
  }

  /**
   * A12 FIRST: the session must resolve against THIS world's project scope
   * before any command is composed — a foreign tenant's or a foreign
   * project's session is a typed unauthorized rejection (a displayable view
   * model, never an effect, never a throw).
   */
  const scopeGate = (): Result<true, DomainError> => {
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
    return { ok: true, value: true };
  };

  return {
    kind: 'desktop-data-plane',
    subscription: contract,
    engine,
    worldScope: world.scope,
    submit: async (request, now) => {
      const gate = scopeGate();
      if (!gate.ok) return { ok: false, error: gate.error };
      const operationKind = parseOperationKind(request.operationKind);
      if (!operationKind.ok) {
        return { ok: false, error: { code: 'invalid-operation-kind', received: request.operationKind } };
      }
      const submitted = await engine.submitOnline(
        {
          commandName: request.commandName,
          scope: session.scope,
          actor: session.actor,
          correlationId: DESKTOP_SESSION_CORRELATION,
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
    capture: (request, now) => {
      const gate = scopeGate();
      if (!gate.ok) return { ok: false, error: gate.error };
      const operationKind = parseOperationKind(request.operationKind);
      if (!operationKind.ok) {
        return { ok: false, error: { code: 'invalid-operation-kind', received: request.operationKind } };
      }
      return engine.captureOffline({
        commandName: request.commandName,
        scope: session.scope,
        actor: session.actor,
        correlationId: DESKTOP_SESSION_CORRELATION,
        issuedAt: now,
        payload: request.payload,
        target: request.target,
        operationKind: operationKind.value,
        protection: request.protection,
        requiredCapability: request.requiredCapability,
      });
    },
    reconnect: (now) => engine.reconnect(now),
    resolveConflict: (command, now) => engine.resolveConflict(command, now),
    consume: () => engine.consumeLive(),
    get consumedEvents(): readonly LedgerEvent[] {
      return engine.consumedEvents;
    },
  };
}

/**
 * The session's causal-chain correlation id (fixed literal, deterministic —
 * parsed once through the canonical grammar; a wiring typo is a LOUD error).
 * Exported because the conflict-resolution surface composes the reconciled
 * mutation's causality onto the SAME session chain (A3).
 */
export const DESKTOP_SESSION_CORRELATION: CorrelationId = (() => {
  const parsed = parseCorrelationId('desktop-shell-corr-0001');
  if (!parsed.ok) {
    throw new TypeError(
      `desktop shell wiring error (session correlation): ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
})();
