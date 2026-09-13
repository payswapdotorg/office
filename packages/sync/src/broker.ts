// Office sync — the in-memory subscription broker (OFF-028).
//
// The test broker that implements the subscription protocol's stream
// semantics over a ProjectSliceSource port. NO transport of any kind (no
// websocket, no socket.io, no network I/O — the app layer wires a transport
// against these typed messages later); NO writes to the event ledger (the
// broker only READS the slice source).
//
// Authorization model (A9 + A12, deny-by-default, checked BEFORE any event
// is delivered):
//
//   subscribe()      grant lookup (typed not-found) → structural scope
//                    coverage (checkScopeCoversResource: cross-tenant and
//                    cross-project are typed 'unauthorized', both
//                    directions, no existence oracle) → grant state
//                    (revoked grants typed-deny new subscribes) → the
//                    projects.read capability → the caller-supplied policy
//                    through authorize() → grant-version and protocol-
//                    version pins → ONLY THEN the first slice read.
//
//   publish()        the A9 grant is RE-CHECKED at every stream read: a
//                    revoked grant stops its live streams with the typed
//                    grant-revoked message and nothing else — whole
//                    messages only, never a partial or corrupt event
//                    mid-delivery (messages are atomic values).
//
//   resubscribe()    exactly-once cursor resume: entries are delivered
//                    strictly AFTER the presented cursor position, the read
//                    window is contiguous (continuity verified fail-closed),
//                    and the source's deterministic slice order makes the
//                    delivered sequence identical on every replay — no
//                    duplicates, no gaps.
//
// Determinism: fan-out iterates subscriptions in insertion order; every
// delivered position, cursor, and message derives from the slice's
// deterministic order — the same published stream and the same
// subscriptions always produce the identical delivered sequences (run-twice
// proven by test). No clock, no randomness: timestamps arrive as injected
// `now` parameters.
import type { Actor, EntityId, ProjectScope, Timestamp } from '@office/contracts';
import { parseEntityKind } from '@office/contracts';
import type { EntityKind } from '@office/contracts';
import { authorize, checkScopeCoversResource, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy, ResourceScope } from '@office/authz';
import { capability } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import { subscriptionGrantIdOf } from './identity';
import type { SubscriptionGrantId, SubscriptionId } from './identity';
import { grantSubscription, isGrantActive, revokeGrant, upgradeGrantProtocol } from './grant';
import type { GrantVersion, SubscriptionGrant } from './grant';
import {
  MAX_SLICE_READ_LIMIT,
  checkSliceContinuity,
  eventInSliceScope,
  isLedgerEvent,
  sliceCursor,
} from './slice';
import type { ProjectSliceSource, SliceCursor, SliceEntry, SlicePosition } from './slice';
import { filterSliceEntries } from './subscription';
import type { Subscription } from './subscription';
import { CURRENT_PROTOCOL_VERSION } from './version';
import type { ProtocolVersion } from './version';
import type { ConflictRecord } from './conflict';
import type {
  EventDeliveredMessage,
  GrantRevokedMessage,
  SliceCatchupMessage,
  StreamMessage,
} from './messages';

/** The read capability every subscription grant must confer (A9 layer 2). */
export const SUBSCRIPTION_READ_CAPABILITY = capability('projects.read');

/** The resource kind of a subscribed project slice (trusted-path constant). */
const PROJECT_KIND: EntityKind = (() => {
  const parsed = parseEntityKind('project');
  if (!parsed.ok) {
    throw new TypeError(`the 'project' entity kind does not parse: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
})();

/** The live handle of one subscription's stream (a view over broker state). */
export interface LiveSubscription {
  /** The subscription contract the stream serves. */
  readonly subscription: Subscription;
  /** The last DELIVERED slice position (the client's resume cursor basis). */
  readonly position: SlicePosition;
  /** Is the stream still active (not stopped)? */
  readonly active: boolean;
  /** Every message delivered so far, in delivery order (deterministic). */
  received(): readonly StreamMessage[];
  /** The client's current resume cursor (null before any delivery). */
  cursor(): SliceCursor | null;
}

/**
 * The in-memory subscription broker: grant lifecycle + subscribe/publish/
 * revoke/resubscribe over a project-slice source. Insertion order is the
 * deterministic fan-out order.
 */
export interface SubscriptionBroker {
  /** Explicitly issue an A9 grant (deterministic id from tenant+subscriber+serial). */
  issueGrant(parts: {
    readonly subscriberId: EntityId;
    readonly context: AuthorizationContext;
    readonly grantedBy: Actor;
    readonly now: Timestamp;
    readonly serial: number;
    readonly protocolVersion?: ProtocolVersion;
  }): Result<SubscriptionGrant, DomainError>;
  /** Explicitly upgrade a grant's pinned protocol version (see grant.ts). */
  upgradeGrant(
    grantId: SubscriptionGrantId,
    parts: { readonly protocolVersion: ProtocolVersion; readonly now: Timestamp },
  ): Result<SubscriptionGrant, DomainError>;
  /** Revoke a grant: live streams stop clean, new subscribes are typed-denied. */
  revoke(
    grantId: SubscriptionGrantId,
    parts: { readonly revokedBy: Actor; readonly now: Timestamp },
  ): Result<SubscriptionGrant, DomainError>;
  /** Join a slice stream (grant check → stream start; see the header order). */
  subscribe(subscription: Subscription): Promise<Result<LiveSubscription, DomainError>>;
  /** Resume a stream from a cursor (exactly-once: no duplicates, no gaps). */
  resubscribe(
    subscriptionId: SubscriptionId,
    cursor: SliceCursor,
  ): Promise<Result<LiveSubscription, DomainError>>;
  /** Fan one appended ledger event out to every matching live subscription. */
  publish(event: LedgerEvent): Promise<Result<readonly SubscriptionId[], DomainError>>;
  /** Surface a conflict record on every matching live subscription. */
  notifyConflict(conflict: ConflictRecord): Promise<Result<readonly SubscriptionId[], DomainError>>;
  /** The grant as recorded, or null (test/debug accessor). */
  grantOf(grantId: SubscriptionGrantId): SubscriptionGrant | null;
  /** The live subscription as recorded, or null (test/debug accessor). */
  liveSubscription(subscriptionId: SubscriptionId): LiveSubscription | null;
}

/** Internal mutable state of one live subscription. */
interface SubscriptionState {
  readonly subscription: Subscription;
  active: boolean;
  readPosition: SlicePosition;
  deliveredPosition: SlicePosition;
  messages: StreamMessage[];
}

const grantLookupFailure = (grantId: SubscriptionGrantId): DomainError =>
  domainError(
    'not-found',
    `subscription grant ${grantId} not found`,
    [{ code: 'subscription-grant-not-found', message: grantId, path: 'grantId' }],
  );

const missingCapabilityFailure = (grant: SubscriptionGrant): DomainError =>
  domainError(
    'forbidden',
    `subscription grant ${grant.grantId} does not confer the '${SUBSCRIPTION_READ_CAPABILITY}' capability`,
    [
      {
        code: 'missing-read-capability',
        message: `subscribing to a project slice requires '${SUBSCRIPTION_READ_CAPABILITY}'`,
        path: null,
      },
    ],
    { scope: grant.context.scope },
  );

const staleGrantVersionFailure = (
  grant: SubscriptionGrant,
  grantVersion: GrantVersion,
): DomainError =>
  domainError(
    'invariant-violation',
    `subscription was composed against grant version ${grantVersion} but grant ${grant.grantId} is at version ${grant.version} — recompose against the upgraded grant`,
    [
      {
        code: 'stale-grant-version',
        message: `${grantVersion} vs ${grant.version}`,
        path: 'grantVersion',
      },
    ],
    { scope: grant.context.scope },
  );

const grantProtocolMismatchFailure = (grant: SubscriptionGrant): DomainError =>
  domainError(
    'invariant-violation',
    `subscription protocol version does not match grant ${grant.grantId} (pinned ${grant.protocolVersion})`,
    [{ code: 'grant-protocol-mismatch', message: grant.protocolVersion, path: 'protocolVersion' }],
    { scope: grant.context.scope },
  );

const revokedGrantFailure = (grant: SubscriptionGrant): DomainError =>
  domainError(
    'forbidden',
    `subscription grant ${grant.grantId} is revoked — new subscriptions are denied`,
    [{ code: 'grant-revoked', message: grant.grantId, path: 'grantId' }],
    { scope: { kind: 'tenant', tenantId: grant.tenantId } },
  );

/**
 * The deny-by-default authorization sequence every stream START runs
 * (subscribe and resubscribe), in order: grant state → structural scope
 * coverage (A12) → read capability (A9) → policy rules. NOTHING is read or
 * delivered before this sequence passes.
 */
const authorizeStreamStart = (
  grant: SubscriptionGrant,
  subscription: Subscription,
  policy: Policy,
): Result<true, DomainError> => {
  if (!isGrantActive(grant)) {
    return fail(revokedGrantFailure(grant));
  }
  const resource: ResourceScope = resourceScope({
    scope: subscription.filter.scope,
    resourceKind: PROJECT_KIND,
    resourceId: subscription.filter.scope.projectId,
    ownerId: null,
  });
  // 1. Structural isolation (freeze A12) — before any capability or rule.
  const coverage = checkScopeCoversResource(grant.context.scope, resource);
  if (!coverage.ok) return coverage;
  // 2. The read capability every slice subscription confers.
  if (!grant.context.capabilities.includes(SUBSCRIPTION_READ_CAPABILITY)) {
    return fail(missingCapabilityFailure(grant));
  }
  // 3. Policy rules — explicit deny wins; first allow grants; default deny.
  const decision = authorize(policy, grant.context, resource, 'read');
  if (!decision.ok) return fail(decision.error);
  return ok(true);
};

/**
 * Create the in-memory subscription broker. The source is the ledger READ
 * port (never written); the policy is the caller's static, data-driven
 * deny-by-default policy evaluated at every stream start.
 */
export function createSubscriptionBroker(parts: {
  readonly policy: Policy;
  readonly source: ProjectSliceSource;
}): SubscriptionBroker {
  const grants = new Map<string, SubscriptionGrant>();
  const streams = new Map<string, SubscriptionState>();

  const handleOf = (state: SubscriptionState): LiveSubscription => ({
    get subscription(): Subscription {
      return state.subscription;
    },
    get position(): SlicePosition {
      return state.deliveredPosition;
    },
    get active(): boolean {
      return state.active;
    },
    received: () => [...state.messages],
    cursor: () =>
      state.deliveredPosition === 0 && state.messages.length === 0
        ? null
        : sliceCursor({
            subscriptionId: state.subscription.subscriptionId,
            position: state.deliveredPosition,
          }),
  });

  /** Read the delivery window after `after`, continuity-verified fail-closed. */
  const readWindow = async (
    scope: ProjectScope,
    after: SlicePosition,
  ): Promise<Result<readonly SliceEntry[], DomainError>> => {
    const read = await parts.source.readSlice({ scope, after, limit: MAX_SLICE_READ_LIMIT });
    if (!read.ok) return read;
    const continuity = checkSliceContinuity(read.value, after);
    if (!continuity.ok) return continuity;
    return read;
  };

  /** Enqueue the bulk catchup of a delivered window (slice order). */
  const deliverCatchup = (
    state: SubscriptionState,
    entries: readonly SliceEntry[],
  ): void => {
    if (entries.length === 0) return;
    const last = entries[entries.length - 1]!;
    const message: SliceCatchupMessage = {
      kind: 'slice-catchup',
      subscriptionId: state.subscription.subscriptionId,
      protocolVersion: state.subscription.protocolVersion,
      entries: entries.map((entry) => ({ event: entry.event, position: entry.position })),
      cursor: sliceCursor({
        subscriptionId: state.subscription.subscriptionId,
        position: last.position,
      }),
    };
    state.messages.push(message);
    state.deliveredPosition = last.position;
  };

  /** Enqueue one live event delivery. */
  const deliverEvent = (state: SubscriptionState, entry: SliceEntry): void => {
    const message: EventDeliveredMessage = {
      kind: 'event-delivered',
      subscriptionId: state.subscription.subscriptionId,
      protocolVersion: state.subscription.protocolVersion,
      event: entry.event,
      position: entry.position,
      cursor: sliceCursor({
        subscriptionId: state.subscription.subscriptionId,
        position: entry.position,
      }),
    };
    state.messages.push(message);
    state.deliveredPosition = entry.position;
  };

  /** Stop a live stream cleanly: the typed grant-revoked message, then inactive. */
  const stopWithGrantRevoked = (state: SubscriptionState, grant: SubscriptionGrant): void => {
    if (!state.active) return;
    const message: GrantRevokedMessage = {
      kind: 'grant-revoked',
      subscriptionId: state.subscription.subscriptionId,
      grantId: grant.grantId,
      revokedAt: grant.revokedAt ?? grant.grantedAt,
    };
    state.messages.push(message);
    state.active = false;
  };

  return {
    issueGrant: ({ subscriberId, context, grantedBy, now, serial, protocolVersion }) => {
      const grant = grantSubscription({
        grantId: subscriptionGrantIdOf({
          tenantId: context.scope.tenantId,
          subscriberId,
          serial,
        }),
        tenantId: context.scope.tenantId,
        subscriberId,
        context,
        protocolVersion: protocolVersion ?? CURRENT_PROTOCOL_VERSION,
        grantedAt: now,
        grantedBy,
      });
      grants.set(grant.grantId, grant);
      return ok(grant);
    },
    upgradeGrant: (grantId, { protocolVersion, now }) => {
      const grant = grants.get(grantId);
      if (grant === undefined) {
        return fail(grantLookupFailure(grantId));
      }
      const upgraded = upgradeGrantProtocol(grant, { protocolVersion, now });
      if (!upgraded.ok) return upgraded;
      grants.set(grantId, upgraded.value);
      return upgraded;
    },
    revoke: (grantId, { revokedBy, now }) => {
      const grant = grants.get(grantId);
      if (grant === undefined) {
        return fail(grantLookupFailure(grantId));
      }
      const revoked = revokeGrant(grant, { revokedBy, now });
      if (!revoked.ok) return revoked;
      grants.set(grantId, revoked.value);
      // Clean stop of every live stream the grant backs (insertion order).
      for (const state of streams.values()) {
        if (state.subscription.grantId === grantId) {
          stopWithGrantRevoked(state, revoked.value);
        }
      }
      return revoked;
    },
    subscribe: async (sub) => {
      const grant = grants.get(sub.grantId);
      if (grant === undefined) {
        return fail(grantLookupFailure(sub.grantId));
      }
      if (streams.has(sub.subscriptionId)) {
        return fail(
          domainError(
            'invariant-violation',
            `subscription ${sub.subscriptionId} is already known to this broker — use resubscribe to resume it`,
            [{ code: 'subscription-already-active', message: sub.subscriptionId, path: 'subscriptionId' }],
          ),
        );
      }
      const authorization = authorizeStreamStart(grant, sub, parts.policy);
      if (!authorization.ok) return fail(authorization.error);
      if (sub.grantVersion !== grant.version) {
        return fail(staleGrantVersionFailure(grant, sub.grantVersion));
      }
      if (sub.protocolVersion !== grant.protocolVersion) {
        return fail(grantProtocolMismatchFailure(grant));
      }
      const state: SubscriptionState = {
        subscription: sub,
        active: true,
        readPosition: sub.cursor?.position ?? (0 as SlicePosition),
        deliveredPosition: sub.cursor?.position ?? (0 as SlicePosition),
        messages: [],
      };
      // The initial catchup: the delivered window from the resume basis.
      const window = await readWindow(sub.filter.scope, state.readPosition);
      if (!window.ok) return fail(window.error);
      const lastRead = window.value[window.value.length - 1];
      if (lastRead !== undefined) {
        state.readPosition = lastRead.position;
      }
      const delivered = filterSliceEntries(window.value, sub.filter);
      deliverCatchup(state, delivered);
      if (delivered.length === 0) {
        // Nothing to deliver yet: acknowledge the resume basis with an
        // empty catchup carrying the basis cursor.
        state.messages.push({
          kind: 'slice-catchup',
          subscriptionId: sub.subscriptionId,
          protocolVersion: sub.protocolVersion,
          entries: [],
          cursor: sliceCursor({
            subscriptionId: sub.subscriptionId,
            position: state.deliveredPosition,
          }),
        });
      }
      streams.set(sub.subscriptionId, state);
      return ok(handleOf(state));
    },
    resubscribe: async (subscriptionId, cursor) => {
      const state = streams.get(subscriptionId);
      if (state === undefined) {
        return fail(
          domainError(
            'not-found',
            `subscription ${subscriptionId} not found`,
            [{ code: 'subscription-not-found', message: subscriptionId, path: 'subscriptionId' }],
          ),
        );
      }
      if (cursor.subscriptionId !== subscriptionId) {
        return fail(
          domainError(
            'invariant-violation',
            `slice cursor of subscription ${cursor.subscriptionId} cannot resume subscription ${subscriptionId} — cursors are subscription-scoped`,
            [
              {
                code: 'cursor-subscription-mismatch',
                message: `${cursor.subscriptionId} vs ${subscriptionId}`,
                path: 'subscriptionId',
              },
            ],
          ),
        );
      }
      const grant = grants.get(state.subscription.grantId);
      if (grant === undefined) {
        return fail(grantLookupFailure(state.subscription.grantId));
      }
      const authorization = authorizeStreamStart(grant, state.subscription, parts.policy);
      if (!authorization.ok) return fail(authorization.error);
      if (state.subscription.grantVersion !== grant.version) {
        return fail(staleGrantVersionFailure(grant, state.subscription.grantVersion));
      }
      // A cursor beyond the head would silently accept fabricated progress.
      const full = await readWindow(state.subscription.filter.scope, 0 as SlicePosition);
      if (!full.ok) return fail(full.error);
      const head = full.value[full.value.length - 1]?.position ?? (0 as SlicePosition);
      if (cursor.position > head) {
        return fail(
          domainError(
            'invariant-violation',
            `resume cursor position ${cursor.position} is beyond the slice head ${head}`,
            [{ code: 'cursor-beyond-head', message: `${cursor.position} vs ${head}`, path: 'cursor.position' }],
          ),
        );
      }
      // Exactly-once resume: deliver strictly after the presented cursor.
      state.active = true;
      state.readPosition = cursor.position;
      state.deliveredPosition = cursor.position;
      const window = await readWindow(state.subscription.filter.scope, cursor.position);
      if (!window.ok) return fail(window.error);
      const lastRead = window.value[window.value.length - 1];
      if (lastRead !== undefined) {
        state.readPosition = lastRead.position;
      }
      const delivered = filterSliceEntries(window.value, state.subscription.filter);
      deliverCatchup(state, delivered);
      if (delivered.length === 0) {
        state.messages.push({
          kind: 'slice-catchup',
          subscriptionId,
          protocolVersion: state.subscription.protocolVersion,
          entries: [],
          cursor: sliceCursor({ subscriptionId, position: cursor.position }),
        });
      }
      return ok(handleOf(state));
    },
    publish: async (event) => {
      if (!isLedgerEvent(event)) {
        return fail(
          domainError(
            'invariant-violation',
            'publish requires a structurally valid LedgerEvent (the broker never writes the ledger)',
            [{ code: 'event-valid', message: 'publish input failed the fail-closed ledger event parse', path: null }],
          ),
        );
      }
      const deliveredTo: SubscriptionId[] = [];
      for (const state of streams.values()) {
        if (!state.active) continue;
        if (!eventInSliceScope(event, state.subscription.filter.scope)) continue;
        // A9: the grant is re-checked at EVERY stream read — a revoked grant
        // stops the stream typed-cleanly BEFORE anything is read.
        const grant = grants.get(state.subscription.grantId);
        if (grant === undefined) {
          return fail(grantLookupFailure(state.subscription.grantId));
        }
        if (!isGrantActive(grant)) {
          stopWithGrantRevoked(state, grant);
          continue;
        }
        const window = await readWindow(state.subscription.filter.scope, state.readPosition);
        if (!window.ok) return fail(window.error);
        const lastRead = window.value[window.value.length - 1];
        if (lastRead !== undefined) {
          state.readPosition = lastRead.position;
        }
        const delivered = filterSliceEntries(window.value, state.subscription.filter);
        if (delivered.length === 1) {
          deliverEvent(state, delivered[0]!);
          deliveredTo.push(state.subscription.subscriptionId);
        } else if (delivered.length > 1) {
          deliverCatchup(state, delivered);
          deliveredTo.push(state.subscription.subscriptionId);
        }
      }
      return ok(deliveredTo);
    },
    notifyConflict: async (conflict) => {
      const deliveredTo: SubscriptionId[] = [];
      for (const state of streams.values()) {
        if (!state.active) continue;
        const scope = state.subscription.filter.scope;
        if (
          conflict.tenantId !== scope.tenantId ||
          conflict.projectId !== scope.projectId
        ) {
          continue;
        }
        const grant = grants.get(state.subscription.grantId);
        if (grant === undefined) {
          return fail(grantLookupFailure(state.subscription.grantId));
        }
        if (!isGrantActive(grant)) {
          stopWithGrantRevoked(state, grant);
          continue;
        }
        state.messages.push({
          kind: 'conflict-notified',
          subscriptionId: state.subscription.subscriptionId,
          conflict,
        });
        deliveredTo.push(state.subscription.subscriptionId);
      }
      return ok(deliveredTo);
    },
    grantOf: (grantId) => grants.get(grantId) ?? null,
    liveSubscription: (subscriptionId) => {
      const state = streams.get(subscriptionId);
      return state === undefined ? null : handleOf(state);
    },
  };
}
