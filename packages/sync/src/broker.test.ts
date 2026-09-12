import { describe, expect, it } from 'vitest';
import { createSubscriptionBroker } from './broker';
import type { SubscriptionBroker } from './broker';
import { createInMemorySliceSource, sliceCursor } from './slice';
import type { InMemorySliceSource, ProjectSliceSource, SlicePosition } from './slice';
import { subscription, subscriptionFilter } from './subscription';
import type { Subscription } from './subscription';
import { subscriptionIdOf, operationIdOf } from './identity';
import { clientOperation, createInMemoryOperationRegistry, operationDigestOf } from './operations';
import type { ClientOperation } from './operations';
import { detectConflict } from './conflict';
import { parseStreamMessage } from './messages';
import type { StreamMessage } from './messages';
import { CURRENT_PROTOCOL_VERSION } from './version';
import type { LedgerEvent } from '@office/events';
import type { ProjectScope } from '@office/contracts';
import {
  ACTOR_A,
  ACTOR_ADMIN,
  ACTOR_B,
  CLIENT_A,
  CLIENT_B,
  NOW_1,
  NOW_2,
  NOW_3,
  PROJECT_1,
  SCOPE_1,
  SCOPE_2,
  SCOPE_TENANT_B,
  TENANT_A,
  TENANT_B,
  allowReadsPolicy,
  denyReadsPolicy,
  emptyPolicy,
  entityIdOf,
  entityKindOf,
  eventEnvelope,
  grantVersionOf,
  noCapabilityContext,
  operationKindOf,
  readerContext,
  slicePositionOf,
  unwrap,
} from './test-support';

// OFF-028 — the in-memory subscription broker: the acceptance surface of the
// realtime subscription protocol. These suites prove the protocol's stream
// semantics END TO END over the deterministic in-memory slice source:
//
// - the GOLDEN CONVERGENCE test: two clients observing the same mutation
//   without divergent state — one live, one late-joining via catchup — both
//   receive the same event at the same sequence with consistent cursors, and
//   after independent catchup + resubscribe both hold IDENTICAL state, folded
//   purely from their own delivered streams (never from shared memory);
// - exactly-once cursor resume: no duplicates, no gaps, contiguity verified;
// - A9 revocation: clean typed stops, denied re-subscribes, no partial events;
// - A12: cross-tenant/cross-project typed-rejected both directions, with
//   authorization proven BEFORE any slice read or event delivery;
// - explicit conflict fan-out over the two-client concurrent-op scenario;
// - determinism: the run-twice identity of the whole delivered sequences.
//
// Everything is a fixed constant (injected instants, fixed identities): no
// clock, no randomness — replaying this file is byte-identical.

const PROGRESS = entityKindOf('progress-update');

/** Append one progress event to the source (deterministic, fixed instants). */
const appendProgress = async (
  source: InMemorySliceSource,
  parts: {
    readonly occurredAt: string;
    readonly opaque: string;
    readonly scope?: ProjectScope;
    readonly percent?: number;
  },
): Promise<LedgerEvent> =>
  unwrap(
    await source.append(
      eventEnvelope({
        eventName: 'schedule.progressRecorded',
        scope: parts.scope ?? SCOPE_1,
        actor: ACTOR_A,
        occurredAt: parts.occurredAt,
        correlationId: 'corr-0f1e2d3c4b5a',
        payload: { percent: parts.percent ?? 40 },
      }),
      { entityKind: PROGRESS, entityId: entityIdOf(parts.opaque) },
    ),
  );

/**
 * A read-counting wrapper around the slice source: proves the broker performs
 * NO slice read (and so delivers nothing) before authorization passes.
 */
const countingSource = (
  inner: InMemorySliceSource,
): { readonly source: ProjectSliceSource; readonly reads: () => number } => {
  let readCount = 0;
  const source: ProjectSliceSource = {
    readSlice: async (input) => {
      readCount += 1;
      return inner.readSlice(input);
    },
  };
  return { source, reads: () => readCount };
};

/** The permissive-baseline broker over a fresh deterministic source. */
const freshBroker = (): { broker: SubscriptionBroker; source: InMemorySliceSource } => {
  const source = createInMemorySliceSource();
  return { broker: createSubscriptionBroker({ policy: allowReadsPolicy(), source }), source };
};

/** Issue the standard reader grant of `subscriber` under the tenant scope. */
const issueReaderGrant = (
  broker: SubscriptionBroker,
  subscriberId: typeof CLIENT_A,
  actor: typeof ACTOR_A,
): ReturnType<SubscriptionBroker['issueGrant']> =>
  broker.issueGrant({
    subscriberId,
    context: readerContext(actor, { kind: 'tenant', tenantId: TENANT_A }),
    grantedBy: ACTOR_ADMIN,
    now: NOW_1,
    serial: 1,
  });

/** Compose the standard full-slice subscription of `subscriber` (ordinal 1). */
const sliceSubscription = (subscriberId: typeof CLIENT_A, grantId: Subscription['grantId']): Subscription =>
  subscription({
    subscriptionId: subscriptionIdOf({
      tenantId: TENANT_A,
      projectId: PROJECT_1,
      subscriberId,
      ordinal: 1,
    }),
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    filter: subscriptionFilter({ scope: SCOPE_1 }),
    grantId,
    grantVersion: grantVersionOf(1),
  });

/** The client-side state folded from one client's delivered stream ONLY. */
const projectedState = (messages: readonly StreamMessage[]): {
  readonly applied: readonly { readonly eventId: string; readonly position: number }[];
  readonly cursorPosition: number;
} => {
  const applied: { eventId: string; position: number }[] = [];
  let cursorPosition = 0;
  for (const message of messages) {
    // Every delivered message must be protocol-valid (typed, whole, parseable).
    const parsed = unwrap(parseStreamMessage(message));
    if (parsed.kind === 'event-delivered') {
      applied.push({ eventId: parsed.event.eventId, position: parsed.position });
      cursorPosition = parsed.cursor.position;
    } else if (parsed.kind === 'slice-catchup') {
      for (const entry of parsed.entries) {
        applied.push({ eventId: entry.event.eventId, position: entry.position });
      }
      cursorPosition = parsed.cursor.position;
    }
  }
  return { applied, cursorPosition };
};

/** Every message of a stream parses through the fail-closed protocol parse. */
const allMessagesParse = (messages: readonly StreamMessage[]): boolean =>
  messages.every((message) => parseStreamMessage(message).ok);

describe('THE golden convergence test (two clients, one mutation, no divergence)', () => {
  it('delivers the same event at the same sequence to both clients, and converges after independent catchup + resubscribe', async () => {
    const { broker, source } = freshBroker();
    const grantA = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    const grantB = unwrap(issueReaderGrant(broker, CLIENT_B, ACTOR_B));
    const subA = sliceSubscription(CLIENT_A, grantA.grantId);
    const subB = sliceSubscription(CLIENT_B, grantB.grantId);

    // Client A is live from the beginning (the slice starts empty).
    const liveA = unwrap(await broker.subscribe(subA));
    expect(liveA.active).toBe(true);
    // The empty slice is acknowledged with a catchup carrying the basis
    // cursor at position 0 (the before-first resume basis).
    expect(liveA.cursor()?.position).toBe(0);

    // THE mutation: one progress event appended and published.
    const mutation = await appendProgress(source, {
      occurredAt: '2026-09-12T10:15:31.000Z',
      opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9',
      percent: 42,
    });
    const deliveredTo = unwrap(await broker.publish(mutation));
    expect(deliveredTo).toEqual([subA.subscriptionId]);

    // Client A received it LIVE: same event, same ledger sequence, position 1.
    const aLive = liveA.received().at(-1);
    expect(aLive?.kind).toBe('event-delivered');
    if (aLive?.kind === 'event-delivered') {
      expect(aLive.event.eventId).toBe(mutation.eventId);
      expect(aLive.event.sequence).toBe(mutation.sequence);
      expect(aLive.position).toBe(1);
      expect(aLive.cursor.position).toBe(1);
      expect(aLive.cursor.subscriptionId).toBe(subA.subscriptionId);
    }
    expect(liveA.cursor()?.position).toBe(1);

    // Client B joins LATER and catches up from the beginning of the slice.
    const liveB = unwrap(await broker.subscribe(subB));
    const bCatchup = liveB.received().at(-1);
    expect(bCatchup?.kind).toBe('slice-catchup');
    if (bCatchup?.kind === 'slice-catchup') {
      expect(bCatchup.entries).toHaveLength(1);
      const entry = bCatchup.entries[0]!;
      // The SAME event, at the SAME intrinsic slice position and sequence.
      expect(entry.event.eventId).toBe(mutation.eventId);
      expect(entry.event.sequence).toBe(mutation.sequence);
      expect(entry.position).toBe(1);
      expect(bCatchup.cursor.position).toBe(1);
    }
    expect(liveB.cursor()?.position).toBe(1);
    // Consistent cursors: both clients' resume bases agree.
    expect(liveA.cursor()?.position).toBe(liveB.cursor()?.position);

    // A second mutation reaches both clients live.
    const second = await appendProgress(source, {
      occurredAt: '2026-09-12T10:16:31.000Z',
      opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
      percent: 55,
    });
    const deliveredSecond = unwrap(await broker.publish(second));
    expect(new Set(deliveredSecond)).toEqual(new Set([subA.subscriptionId, subB.subscriptionId]));
    expect(liveA.cursor()?.position).toBe(2);
    expect(liveB.cursor()?.position).toBe(2);

    // Independent catchup + resubscribe from each client's OWN cursor.
    const resumedA = unwrap(await broker.resubscribe(subA.subscriptionId, liveA.cursor()!));
    const resumedB = unwrap(await broker.resubscribe(subB.subscriptionId, liveB.cursor()!));
    expect(resumedA.active).toBe(true);
    expect(resumedB.active).toBe(true);
    expect(resumedA.cursor()?.position).toBe(2);
    expect(resumedB.cursor()?.position).toBe(2);

    // CONVERGENCE, proven from the streams (never from shared memory): the
    // state each client folds from its OWN delivered messages is identical.
    const stateA = projectedState(liveA.received());
    const stateB = projectedState(liveB.received());
    expect(stateA).toEqual(stateB);
    expect(stateA.applied.map((entry) => entry.eventId)).toEqual([mutation.eventId, second.eventId]);
    expect(stateA.applied.map((entry) => entry.position)).toEqual([1, 2]);
    expect(stateA.cursorPosition).toBe(2);
    // Both full streams are protocol-valid, end to end.
    expect(allMessagesParse(liveA.received())).toBe(true);
    expect(allMessagesParse(liveB.received())).toBe(true);
  });
});

describe('exactly-once per subscription (cursor resume: no duplicates, no gaps)', () => {
  it('resubscribing from the latest cursor re-delivers NOTHING (no duplicates)', async () => {
    const { broker, source } = freshBroker();
    const grant = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    const sub = sliceSubscription(CLIENT_A, grant.grantId);
    for (const [index, opaque] of ['a1b2c3d4e5f60718293a4b5c6d7e8f9', 'b2c3d4e5f60718293a4b5c6d7e8f9a1', 'c3d4e5f60718293a4b5c6d7e8f9a1b2'].entries()) {
      await appendProgress(source, {
        occurredAt: `2026-09-12T10:1${5 + index}:31.000Z`,
        opaque,
      });
    }
    const live = unwrap(await broker.subscribe(sub));
    expect(live.cursor()?.position).toBe(3); // the initial catchup consumed 1..3
    const fourth = await appendProgress(source, {
      occurredAt: '2026-09-12T10:19:31.000Z',
      opaque: 'd4e5f60718293a4b5c6d7e8f9a1b2c3',
    });
    unwrap(await broker.publish(fourth));
    expect(live.cursor()?.position).toBe(4);
    const before = live.received().length;

    // Crash + reconnect: the client presents its LAST CONFIRMED cursor.
    unwrap(await broker.resubscribe(sub.subscriptionId, live.cursor()!));
    const after = live.received();
    expect(after.length).toBe(before + 1); // only the empty incremental catchup
    const last = after.at(-1);
    expect(last?.kind).toBe('slice-catchup');
    if (last?.kind === 'slice-catchup') {
      expect(last.entries).toEqual([]); // nothing re-delivered
      expect(last.cursor.position).toBe(4);
    }
    // No duplicate event-delivered anywhere in the stream history.
    const deliveredEvents = after
      .filter((message) => message.kind === 'event-delivered')
      .map((message) => (message as { readonly event: LedgerEvent }).event.eventId);
    expect(new Set(deliveredEvents).size).toBe(deliveredEvents.length);
    expect(allMessagesParse(after)).toBe(true);
  });

  it('resubscribing from a STALE cursor replays exactly the missing contiguous window (no gaps)', async () => {
    const { broker, source } = freshBroker();
    const grant = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    const sub = sliceSubscription(CLIENT_A, grant.grantId);
    const events: LedgerEvent[] = [];
    for (const [index, opaque] of ['a1b2c3d4e5f60718293a4b5c6d7e8f9', 'b2c3d4e5f60718293a4b5c6d7e8f9a1', 'c3d4e5f60718293a4b5c6d7e8f9a1b2', 'd4e5f60718293a4b5c6d7e8f9a1b2c3'].entries()) {
      events.push(
        await appendProgress(source, {
          occurredAt: `2026-09-12T10:1${5 + index}:31.000Z`,
          opaque,
        }),
      );
    }
    const live = unwrap(await broker.subscribe(sub));
    expect(live.cursor()?.position).toBe(4);

    // The client only confirmed through position 2 (an at-least-once replay):
    // the resume window must be EXACTLY positions 3..4 — contiguous, strictly
    // after the presented cursor, nothing the cursor already confirmed.
    const resumed = unwrap(
      await broker.resubscribe(sub.subscriptionId, sliceCursor({ subscriptionId: sub.subscriptionId, position: slicePositionOf(2) })),
    );
    expect(resumed.cursor()?.position).toBe(4);
    const catchup = live.received().at(-1);
    expect(catchup?.kind).toBe('slice-catchup');
    if (catchup?.kind === 'slice-catchup') {
      expect(catchup.entries.map((entry) => entry.position)).toEqual([3, 4]);
      expect(catchup.entries.map((entry) => entry.event.eventId)).toEqual([
        events[2]!.eventId,
        events[3]!.eventId,
      ]);
      // Sequence continuity: first entry is cursor+1, each next is +1.
      expect(catchup.entries[0]!.position).toBe(3);
      for (const [index, entry] of catchup.entries.entries()) {
        expect(entry.position).toBe(3 + index);
      }
      expect(catchup.cursor.position).toBe(4);
    }
    // And the window never re-delivers what the cursor confirmed (1..2).
    if (catchup?.kind === 'slice-catchup') {
      for (const entry of catchup.entries) {
        expect(entry.position).toBeGreaterThan(2);
      }
    }
    expect(allMessagesParse(live.received())).toBe(true);
  });

  it('rejects foreign cursors and cursors beyond the slice head typed', async () => {
    const { broker, source } = freshBroker();
    const grant = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    const sub = sliceSubscription(CLIENT_A, grant.grantId);
    await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    unwrap(await broker.subscribe(sub));

    // A cursor of ANOTHER subscription never resumes this one.
    const foreign = sliceCursor({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_B, ordinal: 1 }),
      position: slicePositionOf(0),
    });
    const mismatch = await broker.resubscribe(sub.subscriptionId, foreign);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe('invariant-violation');
      expect(mismatch.error.details[0]?.code).toBe('cursor-subscription-mismatch');
    }
    // A fabricated cursor beyond the head is typed-rejected (never accepted).
    const beyond = await broker.resubscribe(
      sub.subscriptionId,
      sliceCursor({ subscriptionId: sub.subscriptionId, position: slicePositionOf(99) }),
    );
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) {
      expect(beyond.error.code).toBe('invariant-violation');
      expect(beyond.error.details[0]?.code).toBe('cursor-beyond-head');
    }
  });
});

describe('A9 revocation (clean typed stops, denied re-subscribes, no partial events)', () => {
  it('stops live streams with the typed grant-revoked message and denies new subscribes', async () => {
    const { broker, source } = freshBroker();
    const grantA = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    const grantB = unwrap(issueReaderGrant(broker, CLIENT_B, ACTOR_B));
    const subA = sliceSubscription(CLIENT_A, grantA.grantId);
    const subB = sliceSubscription(CLIENT_B, grantB.grantId);
    const liveA = unwrap(await broker.subscribe(subA));
    const liveB = unwrap(await broker.subscribe(subB));
    const first = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    unwrap(await broker.publish(first));
    const messagesBeforeRevocation = liveA.received().length;

    // Revoke A's grant: its live stream stops CLEAN, B's is untouched.
    const revoked = unwrap(broker.revoke(grantA.grantId, { revokedBy: ACTOR_ADMIN, now: NOW_3 }));
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokedAt).toBe(NOW_3);
    expect(liveA.active).toBe(false);
    expect(liveB.active).toBe(true);
    const stop = liveA.received().at(-1);
    expect(stop?.kind).toBe('grant-revoked');
    if (stop?.kind === 'grant-revoked') {
      expect(stop.subscriptionId).toBe(subA.subscriptionId);
      expect(stop.grantId).toBe(grantA.grantId);
      expect(stop.revokedAt).toBe(NOW_3);
      expect(unwrap(parseStreamMessage(stop))).toEqual(stop);
    }

    // No partial or corrupt events: every message of the stopped stream (the
    // whole history, including the pre-revocation delivery) parses clean.
    expect(allMessagesParse(liveA.received())).toBe(true);
    expect(liveA.received().length).toBe(messagesBeforeRevocation + 1); // only the stop
    // The pre-revocation event delivery is intact and untouched.
    const kept = liveA.received()[liveA.received().length - 2];
    expect(kept?.kind).toBe('event-delivered');
    if (kept?.kind === 'event-delivered') {
      expect(kept.event.eventId).toBe(first.eventId);
    }

    // Publishing after revocation delivers NOTHING to the stopped stream —
    // and B still receives everything.
    const second = await appendProgress(source, { occurredAt: '2026-09-12T10:16:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1' });
    const delivered = unwrap(await broker.publish(second));
    expect(delivered).toEqual([subB.subscriptionId]);
    expect(liveA.received().length).toBe(messagesBeforeRevocation + 1); // unchanged
    expect(liveB.received().at(-1)?.kind).toBe('event-delivered');

    // New subscribes against the revoked grant are typed-DENIED.
    const rejoin = subscription({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 2 }),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      filter: subscriptionFilter({ scope: SCOPE_1 }),
      grantId: grantA.grantId,
      grantVersion: grantVersionOf(1),
    });
    const denied = await broker.subscribe(rejoin);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('forbidden');
      expect(denied.error.details[0]?.code).toBe('grant-revoked');
    }
    // The denied rejoin never created a stream.
    expect(broker.liveSubscription(rejoin.subscriptionId)).toBeNull();
    // Resuming the stopped stream is typed-denied too.
    const deniedResume = await broker.resubscribe(subA.subscriptionId, liveA.cursor()!);
    expect(deniedResume.ok).toBe(false);
    if (!deniedResume.ok) {
      expect(deniedResume.error.code).toBe('forbidden');
      expect(deniedResume.error.details[0]?.code).toBe('grant-revoked');
    }
  });
});

describe('A12 structural isolation (typed-rejected both directions, authorization BEFORE delivery)', () => {
  it('rejects cross-tenant subscriptions typed, in BOTH directions, with no stream created', async () => {
    const { broker, source } = freshBroker();
    // Events exist in BOTH tenants' slices — a denied subscribe must deliver
    // none of them (no existence oracle: the denial is structural).
    await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9', scope: SCOPE_1 });
    await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1', scope: SCOPE_TENANT_B });

    // Direction 1: tenant A's grant against tenant B's slice.
    const grantA = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    const intoTenantB = subscription({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_B, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 1 }),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      filter: subscriptionFilter({ scope: SCOPE_TENANT_B }),
      grantId: grantA.grantId,
      grantVersion: grantVersionOf(1),
    });
    const denied1 = await broker.subscribe(intoTenantB);
    expect(denied1.ok).toBe(false);
    if (!denied1.ok) {
      expect(denied1.error.code).toBe('unauthorized');
      expect(denied1.error.details[0]?.code).toBe('tenant-scope-violation');
    }
    expect(broker.liveSubscription(intoTenantB.subscriptionId)).toBeNull();

    // Direction 2: tenant B's grant against tenant A's slice.
    const grantB = unwrap(
      broker.issueGrant({
        subscriberId: CLIENT_B,
        context: readerContext(ACTOR_B, { kind: 'tenant', tenantId: TENANT_B }),
        grantedBy: ACTOR_ADMIN,
        now: NOW_1,
        serial: 1,
      }),
    );
    const intoTenantA = subscription({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_B, ordinal: 1 }),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      filter: subscriptionFilter({ scope: SCOPE_1 }),
      grantId: grantB.grantId,
      grantVersion: grantVersionOf(1),
    });
    const denied2 = await broker.subscribe(intoTenantA);
    expect(denied2.ok).toBe(false);
    if (!denied2.ok) {
      expect(denied2.error.code).toBe('unauthorized');
      expect(denied2.error.details[0]?.code).toBe('tenant-scope-violation');
    }
    expect(broker.liveSubscription(intoTenantA.subscriptionId)).toBeNull();
  });

  it('rejects cross-project subscriptions of the same tenant typed', async () => {
    const { broker } = freshBroker();
    // A grant scoped to project 1 cannot subscribe to project 2's slice.
    const grant = unwrap(
      broker.issueGrant({
        subscriberId: CLIENT_A,
        context: readerContext(ACTOR_A, SCOPE_1),
        grantedBy: ACTOR_ADMIN,
        now: NOW_1,
        serial: 1,
      }),
    );
    const crossProject = subscription({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 1 }),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      filter: subscriptionFilter({ scope: SCOPE_2 }),
      grantId: grant.grantId,
      grantVersion: grantVersionOf(1),
    });
    const denied = await broker.subscribe(crossProject);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('unauthorized');
      expect(denied.error.details[0]?.code).toBe('project-scope-violation');
    }
    expect(broker.liveSubscription(crossProject.subscriptionId)).toBeNull();
  });

  it('checks authorization BEFORE any slice read or event delivery (deny-by-default layers)', async () => {
    const inner = createInMemorySliceSource();
    const { source, reads } = countingSource(inner);
    // The slice is NOT empty: a premature read could leak existence/delivery.
    await appendProgress(inner, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    expect(reads()).toBe(0);

    // Layer 3 (policy): no allow rule → typed forbidden, ZERO slice reads.
    const empty = createSubscriptionBroker({ policy: emptyPolicy(), source });
    const grantEmpty = unwrap(issueReaderGrant(empty, CLIENT_A, ACTOR_A));
    const noRule = await empty.subscribe(sliceSubscription(CLIENT_A, grantEmpty.grantId));
    expect(noRule.ok).toBe(false);
    if (!noRule.ok) {
      expect(noRule.error.code).toBe('forbidden');
      expect(noRule.error.details[0]?.code).toBe('no-allow-rule');
    }
    expect(reads()).toBe(0);

    // Layer 3 (policy): explicit deny rule → typed forbidden, ZERO reads.
    const denying = createSubscriptionBroker({ policy: denyReadsPolicy(), source });
    const grantDeny = unwrap(issueReaderGrant(denying, CLIENT_A, ACTOR_A));
    const explicit = await denying.subscribe(sliceSubscription(CLIENT_A, grantDeny.grantId));
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) {
      expect(explicit.error.code).toBe('forbidden');
      expect(explicit.error.details[0]?.code).toBe('explicit-deny');
    }
    expect(reads()).toBe(0);

    // Layer 2 (capability): a grant without the slice read capability → typed
    // forbidden, ZERO reads.
    const incapable = createSubscriptionBroker({ policy: allowReadsPolicy(), source });
    const grantNoCap = unwrap(
      incapable.issueGrant({
        subscriberId: CLIENT_A,
        context: noCapabilityContext(ACTOR_A, { kind: 'tenant', tenantId: TENANT_A }),
        grantedBy: ACTOR_ADMIN,
        now: NOW_1,
        serial: 1,
      }),
    );
    const noCapability = await incapable.subscribe(sliceSubscription(CLIENT_A, grantNoCap.grantId));
    expect(noCapability.ok).toBe(false);
    if (!noCapability.ok) {
      expect(noCapability.error.code).toBe('forbidden');
      expect(noCapability.error.details[0]?.code).toBe('missing-read-capability');
    }
    expect(reads()).toBe(0);

    // The authorized path reads and delivers only AFTER the checks pass.
    const allowed = createSubscriptionBroker({ policy: allowReadsPolicy(), source });
    const grantOk = unwrap(issueReaderGrant(allowed, CLIENT_A, ACTOR_A));
    const live = unwrap(await allowed.subscribe(sliceSubscription(CLIENT_A, grantOk.grantId)));
    expect(reads()).toBeGreaterThan(0);
    expect(live.received().at(-1)?.kind).toBe('slice-catchup');
  });
});

describe('conflict fan-out over the two-client concurrent-op scenario', () => {
  it('surfaces the explicit ConflictRecord (both sides) on the matching live streams only', async () => {
    const { broker, source } = freshBroker();
    const grantA = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    const grantB = unwrap(issueReaderGrant(broker, CLIENT_B, ACTOR_B));
    const grantC = unwrap(
      broker.issueGrant({
        subscriberId: CLIENT_A,
        context: readerContext(ACTOR_A, { kind: 'tenant', tenantId: TENANT_A }),
        grantedBy: ACTOR_ADMIN,
        now: NOW_1,
        serial: 2,
      }),
    );
    const subA = sliceSubscription(CLIENT_A, grantA.grantId);
    const subB = sliceSubscription(CLIENT_B, grantB.grantId);
    // A third subscription on ANOTHER project of the same tenant: the conflict
    // of project 1 must NOT surface there.
    const subC = subscription({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 2 }),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      filter: subscriptionFilter({ scope: SCOPE_2 }),
      grantId: grantC.grantId,
      grantVersion: grantVersionOf(1),
    });
    const liveA = unwrap(await broker.subscribe(subA));
    const liveB = unwrap(await broker.subscribe(subB));
    const liveC = unwrap(await broker.subscribe(subC));
    const shared = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    unwrap(await broker.publish(shared));
    // Both clients have observed the SAME position (the concurrency basis).
    expect(liveA.cursor()?.position).toBe(1);
    expect(liveB.cursor()?.position).toBe(1);

    // Each client composes a concurrent operation at its observed cursor.
    const operationOf = (subscriberId: typeof CLIENT_A, sub: Subscription, percent: number): ClientOperation => {
      const position: SlicePosition = slicePositionOf(1);
      return clientOperation({
        operationId: operationIdOf({ subscriptionId: sub.subscriptionId, position, operationKind: 'record-progress' }),
        subscriptionId: sub.subscriptionId,
        position,
        operationKind: operationKindOf('record-progress'),
        actor: { kind: 'user', actorId: subscriberId },
        scope: SCOPE_1,
        target: { entityKind: PROGRESS, entityId: CLIENT_A },
        payloadDigest: operationDigestOf({ percent }),
      });
    };

    const opA = operationOf(CLIENT_A, subA, 40);
    const opB = operationOf(CLIENT_B, subB, 60);
    expect(opA.operationId).not.toBe(opB.operationId);

    // The deterministic operation id makes an honest retry a typed duplicate.
    const registry = createInMemoryOperationRegistry();
    expect(unwrap(await registry.register(opA))).toEqual({ status: 'recorded' });
    expect(unwrap(await registry.register(opA))).toEqual({ status: 'duplicate' });
    expect(unwrap(await registry.register(opB))).toEqual({ status: 'recorded' });

    // The divergence is detected EXPLICITLY (both sides, deterministic order).
    const conflict = unwrap(detectConflict({ operations: [opA, opB], detectedAt: NOW_2, detectedBy: ACTOR_ADMIN }));
    expect(conflict.state).toBe('detected');
    expect(conflict.resolution).toBeNull();
    expect(new Set([conflict.first.operationId, conflict.second.operationId])).toEqual(
      new Set([opA.operationId, opB.operationId]),
    );

    // Fan-out: both contested clients are notified; the other project is not.
    const notified = unwrap(await broker.notifyConflict(conflict));
    expect(new Set(notified)).toEqual(new Set([subA.subscriptionId, subB.subscriptionId]));
    const aNotified = liveA.received().at(-1);
    expect(aNotified?.kind).toBe('conflict-notified');
    if (aNotified?.kind === 'conflict-notified') {
      expect(aNotified.conflict).toEqual(conflict);
      expect(unwrap(parseStreamMessage(aNotified))).toEqual(aNotified);
    }
    const bNotified = liveB.received().at(-1);
    expect(bNotified?.kind).toBe('conflict-notified');
    if (bNotified?.kind === 'conflict-notified') {
      expect(bNotified.conflict.conflictId).toBe(conflict.conflictId);
    }
    // The other-project subscription received nothing from this conflict.
    expect(liveC.received().every((message) => message.kind !== 'conflict-notified')).toBe(true);
    expect(allMessagesParse(liveA.received())).toBe(true);
  });
});

describe('determinism (run-twice: identical delivered sequences)', () => {
  it('replays the whole scenario into the identical delivered sequences', async () => {
    const runScenario = async () => {
      const { broker, source } = freshBroker();
      const grantA = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
      const grantB = unwrap(issueReaderGrant(broker, CLIENT_B, ACTOR_B));
      const subA = sliceSubscription(CLIENT_A, grantA.grantId);
      const subB = sliceSubscription(CLIENT_B, grantB.grantId);
      const liveA = unwrap(await broker.subscribe(subA));
      const first = await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
      unwrap(await broker.publish(first));
      const liveB = unwrap(await broker.subscribe(subB));
      const second = await appendProgress(source, { occurredAt: '2026-09-12T10:16:31.000Z', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1' });
      unwrap(await broker.publish(second));
      unwrap(await broker.resubscribe(subA.subscriptionId, liveA.cursor()!));
      unwrap(await broker.resubscribe(subB.subscriptionId, liveB.cursor()!));
      const opA = clientOperation({
        operationId: operationIdOf({ subscriptionId: subA.subscriptionId, position: 2, operationKind: 'record-progress' }),
        subscriptionId: subA.subscriptionId,
        position: slicePositionOf(2),
        operationKind: operationKindOf('record-progress'),
        actor: ACTOR_A,
        scope: SCOPE_1,
        target: { entityKind: PROGRESS, entityId: CLIENT_A },
        payloadDigest: operationDigestOf({ percent: 40 }),
      });
      const opB = clientOperation({
        operationId: operationIdOf({ subscriptionId: subB.subscriptionId, position: 2, operationKind: 'record-progress' }),
        subscriptionId: subB.subscriptionId,
        position: slicePositionOf(2),
        operationKind: operationKindOf('record-progress'),
        actor: ACTOR_B,
        scope: SCOPE_1,
        target: { entityKind: PROGRESS, entityId: CLIENT_A },
        payloadDigest: operationDigestOf({ percent: 60 }),
      });
      const conflict = unwrap(detectConflict({ operations: [opA, opB], detectedAt: NOW_3, detectedBy: ACTOR_ADMIN }));
      unwrap(await broker.notifyConflict(conflict));
      unwrap(broker.revoke(grantA.grantId, { revokedBy: ACTOR_ADMIN, now: NOW_3 }));
      const third = await appendProgress(source, { occurredAt: '2026-09-12T10:17:31.000Z', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2' });
      unwrap(await broker.publish(third));
      return {
        a: liveA.received(),
        b: liveB.received(),
      };
    };
    const firstRun = await runScenario();
    const secondRun = await runScenario();
    // THE run-twice identity: same published stream + same subscriptions →
    // the identical delivered sequences, client by client, message by message.
    expect(firstRun.a).toEqual(secondRun.a);
    expect(firstRun.b).toEqual(secondRun.b);
    expect(allMessagesParse(firstRun.a)).toBe(true);
    expect(allMessagesParse(firstRun.b)).toBe(true);
  });
});

describe('versioned subscription pins (grant lifecycle + protocol version)', () => {
  it('typed-rejects stale grant versions and protocol mismatches, and accepts the recomposed upgrade', async () => {
    const { broker, source } = freshBroker();
    const grant = unwrap(issueReaderGrant(broker, CLIENT_A, ACTOR_A));
    await appendProgress(source, { occurredAt: '2026-09-12T10:15:31.000Z', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    const sub = sliceSubscription(CLIENT_A, grant.grantId);
    const live = unwrap(await broker.subscribe(sub));

    // A subscription pinning a protocol version the grant does not pin is
    // typed-rejected (the stream speaks exactly the grant's version).
    const mismatched = subscription({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 3 }),
      protocolVersion: '1.1.0',
      filter: subscriptionFilter({ scope: SCOPE_1 }),
      grantId: grant.grantId,
      grantVersion: grantVersionOf(1),
    });
    const mismatch = await broker.subscribe(mismatched);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe('invariant-violation');
      expect(mismatch.error.details[0]?.code).toBe('grant-protocol-mismatch');
    }

    // Explicit upgrade: the grant pins 1.1.0, lifecycle version 2.
    const upgraded = unwrap(broker.upgradeGrant(grant.grantId, { protocolVersion: '1.1.0', now: NOW_2 }));
    expect(upgraded.state).toBe('versioned');
    expect(upgraded.version).toBe(2);

    // The OLD subscription (pinned grant version 1) is stale: typed-rejected
    // on resubscribe — the client recomposes against the upgraded grant.
    const stale = await broker.resubscribe(sub.subscriptionId, live.cursor()!);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('invariant-violation');
      expect(stale.error.details[0]?.code).toBe('stale-grant-version');
    }

    // The RECOMPOSED subscription (grant version 2, protocol 1.1.0) joins.
    const recomposed = subscription({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 2 }),
      protocolVersion: '1.1.0',
      filter: subscriptionFilter({ scope: SCOPE_1 }),
      grantId: grant.grantId,
      grantVersion: grantVersionOf(2),
    });
    const rejoined = unwrap(await broker.subscribe(recomposed));
    expect(rejoined.active).toBe(true);
    // The recomposed stream speaks 1.1.0 and caught up the same slice.
    const catchup = rejoined.received().at(-1);
    expect(catchup?.kind).toBe('slice-catchup');
    if (catchup?.kind === 'slice-catchup') {
      expect(catchup.protocolVersion).toBe('1.1.0');
      expect(catchup.entries).toHaveLength(1);
    }
  });
});
