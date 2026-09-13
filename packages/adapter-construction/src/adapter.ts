// Office adapter-construction — the Adapter implementation (OFF-021).
//
// A complete Adapter over the @office/adapters-sdk contract, driven entirely
// by an injected construction provider store (provider-fixture.ts — swapped
// for a real CDE client by the runtime, never by the translation seams):
//
//   - CAPABILITIES: the four declared object-kind surfaces (document →
//     canonical 'document', rfi → 'field-issue', change-event →
//     'change-event', observation → 'field-event'), each with the authz
//     capability the engines authorize through (deny-by-default);
//   - LIFECYCLE: connect/healthCheck/disconnect as TYPED STATE TRANSITIONS —
//     the adapter tracks the connections it established (reference
//     identity), an unknown connection is a typed not-found, a disconnected
//     connection is never usable again, and the health surface observes the
//     provider's degraded mode (the fixture's degrade/recover dial);
//   - SYNC: one page of one object-kind stream — positional replay safety:
//     the continuation token is the position AFTER the last delivered item,
//     so restarting from a checkpointed cursor re-delivers NOTHING (the
//     second, idempotent layer is the SDK's SourceRef-derived command keys).
//
// No I/O, no clock, no randomness: every timestamp comes from the request's
// injected clock, every failure is a typed Result value.
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type {
  Adapter,
  AdapterCapabilities,
  AdapterConnection,
  AdapterDisconnected,
  AdapterHealth,
  ProviderSystemId,
  SyncRequest,
  SyncResult,
} from '@office/adapters-sdk';
import { providerVersion, syncCursorToken } from '@office/adapters-sdk';
import { CONSTRUCTION_ADAPTER_KIND, CONSTRUCTION_CAPABILITIES, CONSTRUCTION_SYSTEM_ID } from './vocabulary';
import type { ConstructionProviderStore } from './provider-fixture';
import { constructionSnapshotOf } from './snapshot-translation';

/** What the adapter is constructed from: the injected provider data source. */
export interface ConstructionAdapterParts {
  /** The provider store the adapter reads (the fixture, or a real client's read surface). */
  readonly store: ConstructionProviderStore;
  /** The provider system this adapter serves (defaults to the fixture's). */
  readonly systemId?: ProviderSystemId;
}

/** Create the construction/CDE Adapter over one injected provider store. */
export function createConstructionAdapter(parts: ConstructionAdapterParts): Adapter {
  const systemId = parts.systemId ?? CONSTRUCTION_SYSTEM_ID;
  const store = parts.store;
  // The connections this adapter established (typed lifecycle state). A
  // connection is a VALUE (never a socket): tracked by reference identity —
  // health checks and disconnects on anything else are typed not-found.
  const connections = new Set<AdapterConnection>();

  const unknownConnection = (): DomainError =>
    domainError(
      'not-found',
      `no construction adapter connection to system '${systemId}' matches the presented connection — connect first`,
      [
        {
          code: 'adapter-connection-unknown',
          message: systemId,
          path: 'connection',
        },
      ],
      { scope: null },
    );

  return {
    kind: CONSTRUCTION_ADAPTER_KIND,
    capabilities: CONSTRUCTION_CAPABILITIES satisfies AdapterCapabilities,

    async connect(request) {
      if (request.systemId !== systemId) {
        return fail(
          domainError(
            'invariant-violation',
            `construction provider serves system '${systemId}', not '${request.systemId}'`,
            [
              {
                code: 'provider-system-mismatch',
                message: request.systemId,
                path: 'systemId',
              },
            ],
          ),
        );
      }
      const connection: AdapterConnection = {
        kind: 'adapter-connection',
        systemId: request.systemId,
        establishedAt: request.now,
      };
      connections.add(connection);
      return ok(connection);
    },

    async healthCheck(request) {
      if (!connections.has(request.connection)) {
        return fail(unknownConnection());
      }
      const degradedDetail = store.degradedDetail();
      return ok({
        kind: 'adapter-health',
        status: degradedDetail === null ? 'healthy' : 'degraded',
        checkedAt: request.now,
        detail: degradedDetail,
      } satisfies AdapterHealth);
    },

    async disconnect(request) {
      if (!connections.has(request.connection)) {
        return fail(unknownConnection());
      }
      connections.delete(request.connection);
      return ok({
        kind: 'adapter-disconnected',
        disconnectedAt: request.now,
      } satisfies AdapterDisconnected);
    },

    async sync(request: SyncRequest): Promise<Result<SyncResult, DomainError>> {
      if (request.systemId !== systemId) {
        return fail(
          domainError(
            'invariant-violation',
            `construction provider serves system '${systemId}', not '${request.systemId}'`,
            [
              {
                code: 'provider-system-mismatch',
                message: request.systemId,
                path: 'systemId',
              },
            ],
          ),
        );
      }
      const stream = store.objects.filter(
        (entry) => entry.objectType === request.objectKind,
      );
      const start = request.cursor === null ? 0 : Number(request.cursor.token);
      if (!Number.isInteger(start) || start < 0 || start > stream.length) {
        return fail(
          domainError(
            'invariant-violation',
            `construction provider cannot resume object kind '${request.objectKind}' from token '${request.cursor?.token ?? '<null>'}'`,
            [
              {
                code: 'provider-token-invalid',
                message: String(request.cursor?.token),
                path: 'cursor.token',
              },
            ],
          ),
        );
      }
      const page = stream.slice(start, start + request.limit);
      const snapshots = page.map((object) =>
        constructionSnapshotOf({
          object,
          tenantId: request.tenantId,
          now: request.now,
          systemId,
        }),
      );
      const nextIndex = start + page.length;
      const lastObject = page.at(-1);
      return ok({
        kind: 'sync-result',
        snapshots,
        nextCursorToken:
          nextIndex < stream.length ? syncCursorToken(String(nextIndex)) : null,
        checkpoint: {
          itemsObserved: nextIndex,
          lastProviderVersion:
            lastObject === undefined ? null : providerVersion(lastObject.version),
        },
        hasMore: nextIndex < stream.length,
      } satisfies SyncResult);
    },
  };
}
