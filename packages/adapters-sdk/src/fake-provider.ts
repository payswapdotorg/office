// Office adapters-sdk — the fake provider fixture (OFF-020).
//
// A COMPLETE in-test provider implementing the Adapter contract and the
// command-translator port with strictly GENERIC vocabulary ('fake-crm' over
// 'contact' objects mapping into the landed canonical 'organization'
// vocabulary) — no real provider names anywhere; the OFF-021+ adapter
// packages own those. The fake proves the SDK's acceptance: provider objects
// round-trip through the adapter contract (sync out, webhook in, conflict
// detection, replay) WITHOUT importing any core provider code.
//
// The fake is an in-memory, deterministic provider:
//   - objects live in insertion order; versions bump monotonically per
//     object ('v1', 'v2', …); deletions are tombstones, never removals;
//   - sync pages slice the object stream after the cursor token (positional
//     replay safety — nothing checkpointed is re-delivered);
//   - webhooks are emitted with a deterministic signature header the
//     matching fake verifier checks (an injected PORT, like production).
import { createHash } from 'node:crypto';
import { parseCommandName, parseEntityKind } from '@office/contracts';
import type { CommandName, EntityKind, Timestamp } from '@office/contracts';
import { domainError, fail, INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';
import { providerSnapshot } from './snapshot';
import type { ProviderObjectStatus, ProviderSnapshot } from './snapshot';
import { sourceRef } from './source-ref';
import { sourceRefKeyOf } from './source-ref';
import type { RawWebhook, WebhookSignatureVerifier } from './webhook';
import type {
  AdapterCommandInput,
  AdapterCommandProposal,
  AdapterCommandTranslator,
} from './commands';
import { requireCanonicalTarget } from './commands';
import type {
  Adapter,
  AdapterCapabilities,
  AdapterConnection,
  AdapterDisconnected,
  AdapterHealth,
  SyncRequest,
  SyncResult,
} from './adapter';
import {
  adapterKind,
  providerObjectKind,
  providerObjectId,
  providerSystemId,
  providerVersion,
} from './identity';
import type { AdapterKind, ProviderObjectKind, ProviderSystemId } from './identity';
import { syncCursorToken } from './cursor';
import type { AdapterJsonObject, AdapterJsonValue } from './json';
import type { LedgerEventId } from '@office/events';
import { parseLedgerEventId } from '@office/events';

/** The fake adapter family kind (generic vocabulary — no real provider names). */
export const FAKE_ADAPTER_KIND: AdapterKind = adapterKind('fake-crm');

/** The fake provider system the fixture syncs against. */
export const FAKE_SYSTEM_ID: ProviderSystemId = providerSystemId('fake-instance-01');

/** The fake provider's object kind. */
export const FAKE_OBJECT_KIND: ProviderObjectKind = providerObjectKind('contact');

const trustedEntityKind = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical kind literal: ${raw}`);
  }
  return parsed.value;
};

const trustedCommandName = (raw: string): CommandName => {
  const parsed = parseCommandName(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical command name literal: ${raw}`);
  }
  return parsed.value;
};

/** The canonical kind the fake's objects map into (landed organization domain). */
export const FAKE_CANONICAL_KIND: EntityKind = trustedEntityKind('organization');

/** The canonical command the fake proposes for provider creations. */
export const FAKE_CREATE_COMMAND: CommandName = trustedCommandName(
  'organization.createOrganization',
);

/** The canonical command the fake proposes for provider updates. */
export const FAKE_UPDATE_COMMAND: CommandName = trustedCommandName(
  'organization.updateOrganization',
);

/** The canonical command the fake proposes for provider deletions. */
export const FAKE_ARCHIVE_COMMAND: CommandName = trustedCommandName(
  'organization.archiveOrganization',
);

/** The capability the fake requires to sync its object kind. */
export const FAKE_SYNC_CAPABILITY: Capability = capability('organization.write');

/** One fake provider object (a tombstone on deletion, never removed). */
export interface FakeProviderObject {
  readonly objectId: string;
  readonly objectType: ProviderObjectKind;
  readonly version: string;
  readonly displayName: string;
  readonly status: 'active' | 'deleted';
  readonly data: AdapterJsonObject;
  readonly updatedAt: Timestamp | null;
}

/** Deterministic signature of a fake webhook body (test-only convention). */
export const fakeWebhookSignature = (body: AdapterJsonValue): string =>
  `sha256=${createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')}`;

/** The header the fake signature is carried in. */
export const FAKE_WEBHOOK_SIGNATURE_HEADER = 'x-fake-signature';

/**
 * The fake signature verifier (the injected PORT's test double): accepts a
 * webhook exactly when its signature header matches the deterministic
 * signature of the parsed body; anything else is a typed unauthorized.
 */
export function createFakeWebhookVerifier(): WebhookSignatureVerifier {
  return {
    verify(input) {
      const provided = input.headers[FAKE_WEBHOOK_SIGNATURE_HEADER];
      const expected = fakeWebhookSignature(input.body);
      if (provided === expected) return ok(true);
      // No tenant context exists at the verifier port — the denial's scope is
      // null and the engine's context supplies scope upstream.
      return fail(
        domainError(
          'unauthorized',
          `webhook signature verification failed for adapter '${input.adapterKind}' system '${input.systemId}'`,
          [{ code: 'webhook-signature-invalid', message: 'header mismatch', path: null }],
        ),
      );
    },
  };
}

/** The fake provider fixture: adapter + translator + deterministic object store. */
export interface FakeProvider {
  /** The Adapter-contract implementation (hand this to the engines). */
  readonly adapter: Adapter;
  /** The command-translator implementation (hand this to the engines). */
  readonly translator: AdapterCommandTranslator;
  /** The provider's objects, in insertion order (tombstones included). */
  readonly objects: readonly FakeProviderObject[];
  /** Insert one object (throws on duplicate id — the trusted fixture path). */
  putObject(input: {
    readonly objectId: string;
    readonly displayName: string;
    readonly data?: AdapterJsonObject;
    readonly updatedAt?: Timestamp | null;
  }): FakeProviderObject;
  /** Mutate one object; bumps its version deterministically. */
  updateObject(
    objectId: string,
    patch: {
      readonly displayName?: string;
      readonly data?: AdapterJsonObject;
      readonly updatedAt?: Timestamp | null;
    },
  ): FakeProviderObject;
  /** Tombstone one object; bumps its version deterministically. */
  deleteObject(objectId: string, updatedAt?: Timestamp | null): FakeProviderObject;
  /** Emit the raw webhook for one object's current state. */
  emitWebhook(eventKind: 'created' | 'updated' | 'deleted', objectId: string): RawWebhook;
}

/** Create the fake provider (deterministic — no clock, no randomness inside). */
export function createFakeProvider(parts?: {
  readonly kind?: AdapterKind;
  readonly systemId?: ProviderSystemId;
}): FakeProvider {
  const kind = parts?.kind ?? FAKE_ADAPTER_KIND;
  const systemId = parts?.systemId ?? FAKE_SYSTEM_ID;
  const objects: FakeProviderObject[] = [];
  const versions = new Map<string, number>();

  const nextVersion = (objectId: string): string => {
    const next = (versions.get(objectId) ?? 0) + 1;
    versions.set(objectId, next);
    return providerVersion(`v${next}`);
  };

  const findObject = (objectId: string): FakeProviderObject => {
    const found = objects.find((entry) => entry.objectId === objectId);
    if (found === undefined) {
      throw new TypeError(`fake provider has no object '${objectId}'`);
    }
    return found;
  };

  const capabilities: AdapterCapabilities = {
    objectKinds: [
      {
        objectKind: FAKE_OBJECT_KIND,
        canonicalKind: FAKE_CANONICAL_KIND,
        capability: FAKE_SYNC_CAPABILITY,
      },
    ],
  };

  const adapter: Adapter = {
    kind,
    capabilities,
    async connect(request) {
      if (request.systemId !== systemId) {
        return fail(
          domainError(
            'invariant-violation',
            `fake provider serves system '${systemId}', not '${request.systemId}'`,
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
    async healthCheck(request) {
      return ok({
        kind: 'adapter-health',
        status: 'healthy',
        checkedAt: request.now,
        detail: null,
      } satisfies AdapterHealth);
    },
    async disconnect(request) {
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
            `fake provider serves system '${systemId}', not '${request.systemId}'`,
            [{ code: 'provider-system-mismatch', message: request.systemId, path: 'systemId' }],
          ),
        );
      }
      const stream = objects.filter((entry) => entry.objectType === request.objectKind);
      const start = request.cursor === null ? 0 : Number(request.cursor.token);
      if (!Number.isInteger(start) || start < 0 || start > stream.length) {
        return fail(
          domainError(
            'invariant-violation',
            `fake provider cannot resume from token '${request.cursor?.token ?? '<null>'}'`,
            [{ code: 'provider-token-invalid', message: String(request.cursor?.token), path: 'cursor.token' }],
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
            objectType: entry.objectType,
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
          lastProviderVersion: lastObject === undefined ? null : providerVersion(lastObject.version),
        },
        hasMore: nextIndex < stream.length,
      } satisfies SyncResult);
    },
  };

  const translator: AdapterCommandTranslator = {
    proposeCommand(input: AdapterCommandInput): Result<AdapterCommandProposal, DomainError> {
      if (input.changeKind === 'created') {
        const name = input.displayName ?? `contact-${input.source.objectId}`;
        return ok({
          commandName: FAKE_CREATE_COMMAND,
          payload: {
            name,
            extensionMetadata: {
              sourceKey: sourceRefKeyOf(input.source),
              providerData: input.data,
            },
          },
        });
      }
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      if (input.changeKind === 'updated') {
        const name = input.displayName ?? `contact-${input.source.objectId}`;
        return ok({
          commandName: FAKE_UPDATE_COMMAND,
          payload: {
            organizationId: canonical.value.entityId,
            expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
            changes: { name },
          },
        });
      }
      return ok({
        commandName: FAKE_ARCHIVE_COMMAND,
        payload: {
          organizationId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
        },
      });
    },
  };

  return {
    adapter,
    translator,
    get objects() {
      return [...objects];
    },
    putObject(input) {
      if (objects.some((entry) => entry.objectId === input.objectId)) {
        throw new TypeError(`fake provider already has object '${input.objectId}'`);
      }
      const object: FakeProviderObject = {
        objectId: input.objectId,
        objectType: FAKE_OBJECT_KIND,
        version: `v${(versions.get(input.objectId) ?? 0) + 1}`,
        displayName: input.displayName,
        status: 'active',
        data: input.data ?? {},
        updatedAt: input.updatedAt ?? null,
      };
      versions.set(input.objectId, 1);
      objects.push(object);
      return object;
    },
    updateObject(objectId, patch) {
      const current = findObject(objectId);
      const updated: FakeProviderObject = {
        ...current,
        displayName: patch.displayName ?? current.displayName,
        data: patch.data ?? current.data,
        updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : current.updatedAt,
        version: nextVersion(objectId),
      };
      objects[objects.indexOf(current)] = updated;
      return updated;
    },
    deleteObject(objectId, updatedAt) {
      const current = findObject(objectId);
      const deleted: FakeProviderObject = {
        ...current,
        status: 'deleted',
        updatedAt: updatedAt ?? current.updatedAt,
        version: nextVersion(objectId),
      };
      objects[objects.indexOf(current)] = deleted;
      return deleted;
    },
    emitWebhook(eventKind, objectId) {
      const object = findObject(objectId);
      const body = {
        kind: 'provider-webhook-body',
        eventKind,
        objectType: object.objectType,
        objectId: object.objectId,
        version: object.version,
        occurredAt: object.updatedAt,
        data: object.data,
      };
      return {
        kind: 'raw-webhook',
        adapterKind: kind,
        systemId,
        headers: { [FAKE_WEBHOOK_SIGNATURE_HEADER]: fakeWebhookSignature(body) },
        body,
      };
    },
  };
}

/** Parse one ledger event id for fake resolution-audit refs (test helper). */
export const fakeAuditEventRef = (raw: string): LedgerEventId => {
  const parsed = parseLedgerEventId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid fake audit event ref: ${raw}`);
  }
  return parsed.value;
};
