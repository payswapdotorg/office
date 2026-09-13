// Office adapter-model — the Adapter implementation (OFF-022).
//
// The Autodesk-class model adapter over the OFF-020 SDK's Adapter contract:
// the declared object-kind surfaces (model, model-version, element,
// element-classification → the canonical models-area kinds, authorized
// through authz's declared 'models.write' capability at sync time), the
// connection lifecycle (typed values, no sockets — the real adapter's I/O
// happens against these contracts in the runtime wiring), and the sync
// surface (one page of one object-kind stream per call, tenant-stamped
// snapshots + the continuation token/checkpoint).
//
// The adapter pulls from an injected ModelProviderStore (the provider-data
// port below): in production the runtime wires the real provider client's
// data into it; in tests the deterministic in-memory fixture
// (provider-fixture.ts) does. NO I/O of any kind happens in this module —
// no sockets, no clock (observedAt comes from the request's injected now),
// no randomness (versions are the provider's own, handed through the port).
import { providerSnapshot } from '@office/adapters-sdk';
import type {
  Adapter,
  AdapterCapabilities,
  AdapterConnection,
  AdapterDisconnected,
  AdapterHealth,
  AdapterKind,
  ProviderObjectKind,
  ProviderObjectStatus,
  ProviderSnapshot,
  ProviderSystemId,
  SyncRequest,
  SyncResult,
} from '@office/adapters-sdk';
import { providerObjectId, providerObjectKind, providerVersion, sourceRef, syncCursorToken } from '@office/adapters-sdk';
import type { AdapterJsonObject } from '@office/adapters-sdk';
import type { Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { MODEL_ADAPTER_CAPABILITIES, MODEL_ADAPTER_KIND, MODEL_SYSTEM_ID } from './vocabulary';

/**
 * One provider object as the model adapter's data port hands it over: the
 * provider's own identity (object type + object id + version), the display
 * name, the lifecycle status ('deleted' is the tombstone state — never a
 * removal), the provider's own last-modified instant, and the payload data
 * (the open-keyed extension bag).
 */
export interface ModelProviderObject {
  readonly objectId: string;
  readonly objectType: ProviderObjectKind;
  readonly version: string;
  readonly displayName: string;
  readonly status: 'active' | 'deleted';
  readonly data: AdapterJsonObject;
  readonly updatedAt: Timestamp | null;
}

/**
 * The injected provider-data port the Adapter implementation pulls from.
 * Implementations keep objects in provider stream order (insertion order,
 * tombstones included) and version them monotonically per object; the
 * deterministic in-memory implementation lives in provider-fixture.ts.
 */
export interface ModelProviderStore {
  /** The provider's objects, in insertion order (tombstones included). */
  readonly objects: readonly ModelProviderObject[];
  /** Insert one object (throws on duplicate id — the trusted fixture path). */
  putObject(input: {
    readonly objectId: string;
    readonly objectType: ProviderObjectKind;
    readonly displayName: string;
    readonly data?: AdapterJsonObject;
    readonly updatedAt?: Timestamp | null;
  }): ModelProviderObject;
  /** Mutate one object; bumps its version deterministically. */
  updateObject(
    objectId: string,
    patch: {
      readonly displayName?: string;
      readonly data?: AdapterJsonObject;
      readonly updatedAt?: Timestamp | null;
    },
  ): ModelProviderObject;
  /** Tombstone one object; bumps its version deterministically (never removes). */
  deleteObject(objectId: string, updatedAt?: Timestamp | null): ModelProviderObject;
}

/**
 * Create the model Adapter implementation over one injected provider store.
 * The adapter family kind and provider system default to this package's
 * fixture identity ('model-cde' / 'model-instance-01') and may be overridden
 * for other provider systems of the same family.
 */
export function createModelAdapter(parts: {
  readonly store: ModelProviderStore;
  readonly kind?: AdapterKind;
  readonly systemId?: ProviderSystemId;
  readonly capabilities?: AdapterCapabilities;
}): Adapter {
  const kind = parts.kind ?? MODEL_ADAPTER_KIND;
  const systemId = parts.systemId ?? MODEL_SYSTEM_ID;
  const capabilities = parts.capabilities ?? MODEL_ADAPTER_CAPABILITIES;

  return {
    kind,
    capabilities,
    async connect(request): Promise<Result<AdapterConnection, DomainError>> {
      if (request.systemId !== systemId) {
        return fail(
          domainError(
            'invariant-violation',
            `the model provider serves system '${systemId}', not '${request.systemId}'`,
            [{ code: 'provider-system-mismatch', message: request.systemId, path: 'systemId' }],
          ),
        );
      }
      return ok({
        kind: 'adapter-connection',
        systemId: request.systemId,
        establishedAt: request.now,
      } satisfies AdapterConnection);
    },
    async healthCheck(request): Promise<Result<AdapterHealth, DomainError>> {
      return ok({
        kind: 'adapter-health',
        status: 'healthy',
        checkedAt: request.now,
        detail: null,
      } satisfies AdapterHealth);
    },
    async disconnect(request): Promise<Result<AdapterDisconnected, DomainError>> {
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
            `the model provider serves system '${systemId}', not '${request.systemId}'`,
            [{ code: 'provider-system-mismatch', message: request.systemId, path: 'systemId' }],
          ),
        );
      }
      const stream = parts.store.objects.filter(
        (entry) => entry.objectType === request.objectKind,
      );
      const start = request.cursor === null ? 0 : Number(request.cursor.token);
      if (!Number.isInteger(start) || start < 0 || start > stream.length) {
        return fail(
          domainError(
            'invariant-violation',
            `the model provider cannot resume from token '${request.cursor?.token ?? '<null>'}'`,
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
      const snapshots: ProviderSnapshot[] = page.map((entry) =>
        providerSnapshot({
          tenantId: request.tenantId,
          source: sourceRef({
            adapterKind: kind,
            systemId,
            objectType: providerObjectKind(entry.objectType),
            objectId: providerObjectId(entry.objectId),
            version: providerVersion(entry.version),
          }),
          displayName: entry.displayName,
          objectStatus: entry.status as ProviderObjectStatus,
          providerUpdatedAt: entry.updatedAt,
          observedAt: request.now,
          extension: entry.data,
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
