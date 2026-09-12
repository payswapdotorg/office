import { describe, expect, it } from 'vitest';
import {
  eventMatchesFilter,
  filterSliceEntries,
  isSubscription,
  isSubscriptionFilter,
  parseSubscription,
  parseSubscriptionFilter,
  subscription,
  subscriptionFilter,
} from './subscription';
import { subscriptionGrantIdOf, subscriptionIdOf } from './identity';
import { grantSubscription } from './grant';
import { buildProjectSlice, createInMemorySliceSource, sliceCursor } from './slice';
import { CURRENT_PROTOCOL_VERSION } from './version';
import {
  ACTOR_A,
  ACTOR_ADMIN,
  CLIENT_A,
  NOW_1,
  PROJECT_1,
  SCOPE_1,
  SCOPE_2,
  SCOPE_TENANT_B,
  TENANT_A,
  entityKindOf,
  entityIdOf,
  eventNameOf,
  eventEnvelope,
  grantVersionOf,
  slicePositionOf,
  unwrap,
} from './test-support';

// OFF-028 — the versioned subscription contract: pinned protocol version,
// typed filter (tenant+project scope + optional entity-kind/event-name
// filters), subscription-scoped cursor, and the A9 grant pin. Fail-closed
// parse boundary; filter matching is pure and deterministic (A12: events of
// another tenant/project never match, in either direction).

const subId = () => subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 1 });
const grantId = () => subscriptionGrantIdOf({ tenantId: TENANT_A, subscriberId: CLIENT_A, serial: 1 });

const issuedGrant = () =>
  grantSubscription({
    grantId: grantId(),
    tenantId: TENANT_A,
    subscriberId: CLIENT_A,
    context: {
      actor: ACTOR_A,
      scope: { kind: 'tenant', tenantId: TENANT_A },
      capabilities: [],
    },
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    grantedAt: NOW_1,
    grantedBy: ACTOR_ADMIN,
  });

const fullFilter = () => subscriptionFilter({ scope: SCOPE_1 });

const baseSubscription = () =>
  subscription({
    subscriptionId: subId(),
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    filter: fullFilter(),
    grantId: issuedGrant().grantId,
    grantVersion: grantVersionOf(1),
  });

describe('subscription filter (typed, fail-closed)', () => {
  it('composes and round-trips the unfiltered form (null kind/name filters)', () => {
    const filter = fullFilter();
    expect(filter.entityKinds).toBeNull();
    expect(filter.eventNames).toBeNull();
    expect(unwrap(parseSubscriptionFilter(filter))).toEqual(filter);
    expect(isSubscriptionFilter(filter)).toBe(true);
  });

  it('composes and round-trips optional entity-kind and event-name filters', () => {
    const filter = subscriptionFilter({
      scope: SCOPE_1,
      entityKinds: [entityKindOf('progress-update'), entityKindOf('field-issue')],
      eventNames: [eventNameOf('schedule.progressRecorded')],
    });
    expect(filter.entityKinds).toHaveLength(2);
    expect(unwrap(parseSubscriptionFilter(filter))).toEqual(filter);
  });

  it('rejects duplicate and empty filter arrays fail-closed', () => {
    expect(
      parseSubscriptionFilter({ scope: SCOPE_1, entityKinds: ['progress-update', 'progress-update'], eventNames: null }).ok,
    ).toBe(false);
    expect(parseSubscriptionFilter({ scope: SCOPE_1, entityKinds: [], eventNames: null }).ok).toBe(false);
    expect(parseSubscriptionFilter({ scope: SCOPE_1, entityKinds: null, eventNames: [] }).ok).toBe(false);
    expect(parseSubscriptionFilter({ scope: SCOPE_1, entityKinds: null, eventNames: ['a.b', 'a.b'] }).ok).toBe(false);
  });

  it('rejects tenant-scope filters and unknown fields (a slice is project-scoped)', () => {
    expect(parseSubscriptionFilter({ scope: { kind: 'tenant', tenantId: TENANT_A }, entityKinds: null, eventNames: null }).ok).toBe(false);
    expect(parseSubscriptionFilter({ scope: SCOPE_1, entityKinds: null, eventNames: null, extra: true }).ok).toBe(false);
    expect(parseSubscriptionFilter(null).ok).toBe(false);
  });
});

describe('subscription contract (versioned, grant-backed)', () => {
  it('composes and round-trips the base subscription', () => {
    const sub = baseSubscription();
    expect(sub.cursor).toBeNull();
    expect(sub.protocolVersion).toBe(CURRENT_PROTOCOL_VERSION);
    expect(unwrap(parseSubscription(sub))).toEqual(sub);
    expect(isSubscription(sub)).toBe(true);
  });

  it('composes a cursor-resumed subscription and round-trips it', () => {
    const cursor = sliceCursor({ subscriptionId: subId(), position: slicePositionOf(3) });
    const sub = subscription({
      subscriptionId: subId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      filter: fullFilter(),
      cursor,
      grantId: issuedGrant().grantId,
      grantVersion: grantVersionOf(1),
    });
    expect(sub.cursor).toEqual(cursor);
    expect(unwrap(parseSubscription(sub))).toEqual(sub);
  });

  it('rejects a cursor of ANOTHER subscription fail-closed', () => {
    const foreign = sliceCursor({
      subscriptionId: subscriptionIdOf({ tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 2 }),
      position: slicePositionOf(1),
    });
    const failed = parseSubscription({
      kind: 'subscription',
      subscriptionId: subId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      filter: fullFilter(),
      cursor: foreign,
      grantId: grantId(),
      grantVersion: 1,
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invalid-value');
      expect(failed.error.path).toBe('cursor');
    }
  });

  it('rejects unknown protocol versions and strict-key violations fail-closed', () => {
    const sub = baseSubscription() as unknown as Record<string, unknown>;
    expect(parseSubscription({ ...sub, protocolVersion: '2.0.0' }).ok).toBe(false);
    expect(parseSubscription({ ...sub, extra: 1 }).ok).toBe(false);
    expect(parseSubscription({ ...sub, grantVersion: 0 }).ok).toBe(false);
    expect(parseSubscription({ ...sub, grantId: 'office-grt-v1-short' }).ok).toBe(false);
    expect(parseSubscription('subscription').ok).toBe(false);
  });
});

describe('filter matching (pure, A12)', () => {
  it('matches a same-scope event and never a cross-tenant/cross-project/tenant-scope one', async () => {
    const source = createInMemorySliceSource();
    const aggregate = { entityKind: entityKindOf('progress-update'), entityId: CLIENT_A };
    const sameScope = unwrap(
      await source.append(
        eventEnvelope({
          eventName: 'schedule.progressRecorded',
          scope: SCOPE_1,
          actor: ACTOR_A,
          occurredAt: '2026-09-12T10:15:31.000Z',
          correlationId: 'corr-0f1e2d3c4b5a',
        }),
        aggregate,
      ),
    );
    const crossTenant = unwrap(
      await source.append(
        eventEnvelope({
          eventName: 'schedule.progressRecorded',
          scope: SCOPE_TENANT_B,
          actor: ACTOR_A,
          occurredAt: '2026-09-12T10:15:31.000Z',
          correlationId: 'corr-0f1e2d3c4b5a',
        }),
        aggregate,
      ),
    );
    const crossProject = unwrap(
      await source.append(
        eventEnvelope({
          eventName: 'schedule.progressRecorded',
          scope: SCOPE_2,
          actor: ACTOR_A,
          occurredAt: '2026-09-12T10:15:31.000Z',
          correlationId: 'corr-0f1e2d3c4b5a',
        }),
        aggregate,
      ),
    );
    const filter = fullFilter();
    expect(eventMatchesFilter(sameScope, filter)).toBe(true);
    expect(eventMatchesFilter(crossTenant, filter)).toBe(false);
    expect(eventMatchesFilter(crossProject, filter)).toBe(false);
    // An event of the same tenant but tenant-wide scope is not in ANY slice.
    const tenantWide = unwrap(
      await source.append(
        eventEnvelope({
          eventName: 'schedule.progressRecorded',
          scope: { kind: 'tenant', tenantId: TENANT_A },
          actor: ACTOR_A,
          occurredAt: '2026-09-12T10:15:31.000Z',
          correlationId: 'corr-0f1e2d3c4b5a',
        }),
        aggregate,
      ),
    );
    expect(eventMatchesFilter(tenantWide, filter)).toBe(false);
  });

  it('applies optional entity-kind and event-name filters on top of the scope', async () => {
    const source = createInMemorySliceSource();
    const aggregate = (kind: string, opaque: string) => ({
      entityKind: entityKindOf(kind),
      entityId: entityIdOf(opaque),
    });
    const append = async (name: string, kind: string, opaque: string) =>
      unwrap(
        await source.append(
          eventEnvelope({
            eventName: name,
            scope: SCOPE_1,
            actor: ACTOR_A,
            occurredAt: '2026-09-12T10:15:31.000Z',
            correlationId: 'corr-0f1e2d3c4b5a',
          }),
          aggregate(kind, opaque),
        ),
      );
    const matching = await append('schedule.progressRecorded', 'progress-update', 'a1b2c3d4e5f60718293a4b5c6d7e8f9');
    const otherKind = await append('schedule.progressRecorded', 'field-issue', 'b2c3d4e5f60718293a4b5c6d7e8f9a1');
    const otherName = await append('schedule.baselineSet', 'progress-update', 'c3d4e5f60718293a4b5c6d7e8f9a1b2');
    const kindFilter = subscriptionFilter({ scope: SCOPE_1, entityKinds: [entityKindOf('progress-update')] });
    const nameFilter = subscriptionFilter({ scope: SCOPE_1, eventNames: [eventNameOf('schedule.progressRecorded')] });
    expect(eventMatchesFilter(matching, kindFilter)).toBe(true);
    expect(eventMatchesFilter(otherKind, kindFilter)).toBe(false);
    expect(eventMatchesFilter(matching, nameFilter)).toBe(true);
    expect(eventMatchesFilter(otherName, nameFilter)).toBe(false);
    const slice = buildProjectSlice(SCOPE_1, CURRENT_PROTOCOL_VERSION, source.events);
    expect(filterSliceEntries(slice.entries, kindFilter).map((entry) => entry.event.eventId)).toEqual([
      matching.eventId,
      otherName.eventId,
    ]);
  });
});
