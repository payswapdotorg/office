import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, Timestamp } from '@office/contracts';
import {
  assertMappingTenant,
  coordinateOf,
  providerObjectId,
  providerObjectKind,
  providerVersion,
  runSync,
  sourceRef,
  sourceRefKeyOf,
  syncStream,
} from '@office/adapters-sdk';
import type {
  AdapterJsonObject,
  ProviderObjectKind,
  SyncOutcome,
} from '@office/adapters-sdk';
import { CONSTRUCTION_ADAPTER_KIND, CONSTRUCTION_SYSTEM_ID, DOCUMENT_OBJECT_KIND } from './vocabulary';
import { createConstructionProviderStore } from './provider-fixture';
import type { ConstructionProviderStore } from './provider-fixture';
import { createConstructionAdapter } from './adapter';
import { createConstructionTranslator } from './mapping';
import { runConstructionSync } from './sync';
import type { ConstructionSyncReport } from './sync';
import {
  CONTRACT_ID,
  NOW_1,
  NOW_2,
  NOW_3,
  NOW_4,
  NOW_5,
  PROJECT_ID,
  TENANT_A,
  TENANT_B,
  USER_ID,
  constructionAuthorization,
  engine,
  entity,
  unwrap,
  version,
} from './test-support';

// OFF-021 — THE named acceptance: the construction/CDE fixture round-trips
// through the @office/adapters-sdk contract end to end, WITHOUT importing any
// core provider code (only adapters-sdk / contracts / domain-kernel):
//
//   1. INITIAL INGEST — objects → snapshots → mappings + command proposals;
//   2. UPDATE         — a new provider version → an update proposal + cursor
//                       advance (plus appended objects picked up incrementally);
//   3. SOURCE MAPPING — re-sync resolves the SAME canonical ids determin-
//                       istically; cross-tenant mapping lookups are typed-
//                       rejected (A12: no existence oracle);
//   4. REPLAY         — the same SourceRef+version is an idempotent no-op; a
//                       cursor restart re-processes NOTHING (the positional
//                       layer re-delivers only the un-checkpointed tail, and
//                       the SourceRef-derived command keys no-op it);
//   5. DELETION       — a provider tombstone → the archive proposal;
//   6. DIVERGENCE     — both sides moved → explicit Conflict records carrying
//                       BOTH sides (no command, no auto-resolution);
//   7. DETERMINISM    — the whole scenario re-run with fresh stores and the
//                       same injected clock/id suppliers → identical
//                       mappings, cursors, conflicts, and proposals.
//
// The scenario is driven through the package's own public surfaces
// (runConstructionSync over createConstructionAdapter +
// createConstructionTranslator) against the deterministic provider fixture.
// The only direct store surgery is the canonical version table — the
// stand-in for the runtime's command execution (the graph adapters never
// touch); phase 6 additionally drives the SDK's runSync with cursor null,
// the runtime's full-re-scan entry, so a divergence at an already-consumed
// stream position is observable.

// ---- fixed provider-side instants and revision payloads (never a clock) ----
const PROV_T1: Timestamp = unwrap(parseTimestamp('2026-09-10T08:00:00.000Z'));
const PROV_T2: Timestamp = unwrap(parseTimestamp('2026-09-11T08:30:00.000Z'));
const PROV_T4: Timestamp = unwrap(parseTimestamp('2026-09-13T08:00:00.000Z'));
const PROV_T5: Timestamp = unwrap(parseTimestamp('2026-09-14T08:00:00.000Z'));

const CONTENT_A = 'UEsDBBQABgAGAAA=';
const CONTENT_A2 = 'U3RydWN0dXJhbCBkcmF3aW5nIHYy';
const CONTENT_B = 'SGVsbG8gQ0RFIGRvYyAy';
const CONTENT_C = 'TUVQIGNvb3JkaW5hdGlvbiBzZXQ=';
const CONTENT_C2 = 'TUVQIGNvb3JkaW5hdGlvbiBzZXQgdjI=';
const CONTENT_D = 'RmFjYWRlIHBsYW4gdiAy';
const CONTENT_E = 'QWRkZW5kdW0gZHJhaW5hZ2U=';

const RFI_QUESTION_V1 = 'Which detail governs the roof penetration at grid C4?';
const RFI_QUESTION_V2 = 'Updated: confirm the sealant specification for grid C4.';

const DOC_3_VIEW_V2 = {
  title: 'MEP coordination set',
  projectId: PROJECT_ID,
  discipline: 'mechanical',
  revision: { revisionId: 'rev-5', contentBase64: CONTENT_C2 },
};

const DOC_1_VIEW_V1 = {
  title: 'Structural drawing package',
  projectId: PROJECT_ID,
  discipline: 'structural',
  revision: { revisionId: 'rev-1', contentBase64: CONTENT_A },
};

/** Every provider object the scenario tracks, in stream order. */
const ALL_OBJECTS: readonly (readonly [string, string])[] = [
  ['document', 'doc-1'],
  ['document', 'doc-2'],
  ['document', 'doc-3'],
  ['document', 'doc-4'],
  ['document', 'doc-5'],
  ['rfi', 'rfi-1'],
  ['change-event', 'ce-1'],
  ['observation', 'obs-1'],
];

const sourceOf = (objectType: string, objectId: string, objectVersion: string) =>
  sourceRef({
    adapterKind: CONSTRUCTION_ADAPTER_KIND,
    systemId: CONSTRUCTION_SYSTEM_ID,
    objectType: providerObjectKind(objectType),
    objectId: providerObjectId(objectId),
    version: providerVersion(objectVersion),
  });

const DOC_STREAM = syncStream({
  tenantId: TENANT_A,
  adapterKind: CONSTRUCTION_ADAPTER_KIND,
  systemId: CONSTRUCTION_SYSTEM_ID,
  objectKind: DOCUMENT_OBJECT_KIND,
});

/** Seed the fixture with one full construction scene (three documents, one of each other kind). */
const seedProvider = (store: ConstructionProviderStore): void => {
  store.putDocument({
    objectId: 'doc-1',
    title: 'Structural drawing package',
    projectId: PROJECT_ID,
    discipline: 'structural',
    revision: { revisionId: 'rev-1', contentBase64: CONTENT_A },
    updatedAt: PROV_T1,
  });
  store.putDocument({
    objectId: 'doc-2',
    title: 'Facade cleaning plan',
    projectId: PROJECT_ID,
    discipline: 'architectural',
    revision: { revisionId: 'rev-2', contentBase64: CONTENT_B },
    updatedAt: PROV_T1,
  });
  store.putDocument({
    objectId: 'doc-3',
    title: 'MEP coordination set',
    projectId: PROJECT_ID,
    discipline: 'mechanical',
    revision: { revisionId: 'rev-4', contentBase64: CONTENT_C },
    updatedAt: PROV_T1,
  });
  store.putRfi({
    objectId: 'rfi-1',
    title: 'Cladding penetration detail',
    question: RFI_QUESTION_V1,
    category: 'design-coordination',
    severity: 'high',
    projectId: PROJECT_ID,
    raisedBy: USER_ID,
    raisedAt: PROV_T1,
    updatedAt: PROV_T1,
  });
  store.putChangeEvent({
    objectId: 'ce-1',
    title: 'Additional facade cleaning scope',
    changeType: 'addition',
    contractRef: CONTRACT_ID,
    costImpacts: [{ budgetId: null, costItemId: entity(101) }],
    updatedAt: PROV_T1,
  });
  store.putObservation({
    objectId: 'obs-1',
    category: 'quality',
    summary: 'Missing vapor barrier at north wall',
    detail: 'Barrier absent over 3 m of parapet.',
    location: 'Level 3, grid B2',
    observedAt: PROV_T1,
    observedBy: USER_ID,
    quantity: { value: 40, unit: 'm2' },
    evidence: [{ documentId: entity(107), revisionId: entity(108) }],
    updatedAt: PROV_T1,
  });
};

/**
 * The full round-trip scenario, as a pure function of injected state. Every
 * phase advances the injected clock to its fixed instant; the canonical
 * version table is stepped only where the runtime would have executed the
 * proposed commands (creates are executed; updates stay pending in the
 * gateway queue unless the phase needs them landed).
 */
const scenario = async () => {
  const store = createConstructionProviderStore();
  seedProvider(store);
  const { deps, versions, advanceClockTo } = engine({ now: NOW_1 });
  const adapter = createConstructionAdapter({ store });
  const translator = createConstructionTranslator();
  const authorization = constructionAuthorization();
  const commands: CommandEnvelope<AdapterJsonObject>[] = [];

  const run = async (now: Timestamp): Promise<ConstructionSyncReport> => {
    advanceClockTo(now);
    const report = unwrap(
      await runConstructionSync(
        {
          authorization,
          adapter,
          translator,
          systemId: CONSTRUCTION_SYSTEM_ID,
          limit: 2,
        },
        deps,
      ),
    );
    for (const stream of report.streams) commands.push(...stream.commands);
    return report;
  };

  // The runtime's full-re-scan entry: the SDK engine page over the whole
  // stream (cursor null) — how a divergence at an already-consumed position
  // is observed positionally.
  const fullRescan = async (now: Timestamp, objectKind: ProviderObjectKind): Promise<SyncOutcome> => {
    advanceClockTo(now);
    const outcome = unwrap(
      await runSync(
        {
          authorization,
          adapter,
          translator,
          systemId: CONSTRUCTION_SYSTEM_ID,
          objectKind,
          cursor: null,
          limit: 10,
        },
        deps,
      ),
    );
    for (const application of outcome.applications) {
      if (application.command !== null) commands.push(application.command);
    }
    return outcome;
  };

  const mappingSummaries = async () => {
    const summaries: { objectId: string; canonicalId: string; providerVersion: string }[] = [];
    for (const [objectType, objectId] of ALL_OBJECTS) {
      const mapping = await deps.mappings.findByCoordinate(
        TENANT_A,
        coordinateOf(sourceOf(objectType, objectId, 'v1')),
      );
      summaries.push({
        objectId,
        canonicalId: mapping?.canonical.entityId ?? '<unmapped>',
        providerVersion: mapping?.providerVersion ?? '<unmapped>',
      });
    }
    return summaries;
  };

  const commandByName = (list: readonly CommandEnvelope<AdapterJsonObject>[], name: string) =>
    list.find((command) => command.commandName === name) ?? null;

  // ---- 1. INITIAL INGEST: every stream paged to exhaustion ----------------
  const ingest = await run(NOW_1);
  const ingestDocumentCursor = await deps.cursors.load(DOC_STREAM);
  // The create commands executed canonically: all six aggregates at v1.
  for (let n = 1; n <= 6; n += 1) {
    versions.set(entity(n), version(1));
  }
  const mappingsAfterIngest = await mappingSummaries();

  // ---- 2. UPDATE: new provider versions + appended objects -----------------
  store.updateDocument('doc-3', {
    revision: { revisionId: 'rev-5', contentBase64: CONTENT_C2 },
    updatedAt: PROV_T2,
  });
  store.putDocument({
    objectId: 'doc-4',
    title: 'Slab edge formwork details',
    projectId: PROJECT_ID,
    discipline: 'structural',
    revision: { revisionId: 'rev-6', contentBase64: CONTENT_D },
    updatedAt: PROV_T2,
  });
  store.putDocument({
    objectId: 'doc-5',
    title: 'Storm drainage layout',
    projectId: PROJECT_ID,
    discipline: 'civil',
    revision: { revisionId: 'rev-7', contentBase64: CONTENT_E },
    updatedAt: PROV_T2,
  });
  store.updateRfi('rfi-1', { question: RFI_QUESTION_V2, updatedAt: PROV_T2 });
  store.updateChangeEvent('ce-1', {
    appendCostImpacts: [{ budgetId: entity(102), costItemId: null }],
    appendScheduleImpactActivityIds: [entity(104)],
    updatedAt: PROV_T2,
  });
  store.updateObservation('obs-1', {
    appendEvidence: [{ documentId: entity(105), revisionId: entity(106) }],
    updatedAt: PROV_T2,
  });
  const update = await run(NOW_2);
  const updateDocumentCursor = await deps.cursors.load(DOC_STREAM);
  // The two new documents' create commands executed canonically (at v1).
  versions.set(entity(7), version(1));
  versions.set(entity(8), version(1));
  const mappingsAfterUpdate = await mappingSummaries();

  // ---- 3. SOURCE MAPPING: re-sync with no provider changes -----------------
  const rescan = await run(NOW_3);
  const mappingsAfterRescan = await mappingSummaries();

  // Cross-tenant probes (A12): a foreign tenant's mapping is invisible…
  const doc1Coordinate = coordinateOf(sourceOf('document', 'doc-1', 'v1'));
  const foreignLookup = await deps.mappings.findByCoordinate(TENANT_B, doc1Coordinate);
  // …and a presented foreign-tenant mapping record is typed-rejected.
  const doc1Mapping = await deps.mappings.findByCoordinate(TENANT_A, doc1Coordinate);
  const foreignAssert =
    doc1Mapping !== null ? assertMappingTenant(doc1Mapping, TENANT_B) : null;

  // ---- 4. REPLAY: cursor restart with a quiet provider ---------------------
  const restart = await run(NOW_4);

  // ---- 5. DELETION: a provider tombstone → the archive proposal -----------
  store.deleteDocument('doc-5', PROV_T4);
  const deletion = await run(NOW_4);

  // ---- 6. DIVERGENCE: both sides moved → explicit conflicts ----------------
  // The provider edits doc-1 (an already-consumed position)…
  store.updateDocument('doc-1', {
    revision: { revisionId: 'rev-1b', contentBase64: CONTENT_A2 },
    updatedAt: PROV_T5,
  });
  // …while an office-side edit lands on the same aggregate in the same window.
  versions.set(entity(1), version(2));
  const divergence = await fullRescan(NOW_5, DOCUMENT_OBJECT_KIND);
  const reDetection = await fullRescan(NOW_5, DOCUMENT_OBJECT_KIND);
  const conflicts = await deps.conflicts.listBySource(TENANT_A, doc1Coordinate);

  // ---- the deterministic world-state snapshot ------------------------------
  return {
    ingest: {
      streamKinds: ingest.streams.map((stream) => stream.objectKind),
      outcomes: ingest.streams.map((stream) => stream.applications.map((a) => a.outcome)),
      commandNames: ingest.streams.flatMap((stream) => stream.commands.map((c) => c.commandName)),
      documentCursor: ingestDocumentCursor,
      documentRuns: ingest.streams[0]?.runs.length ?? 0,
      registerDocumentPayload: commandByName(ingest.streams[0]?.commands ?? [], 'documents.registerDocument')
        ?.payload ?? null,
      raiseIssuePayload: commandByName(ingest.streams[1]?.commands ?? [], 'field.raiseIssue')?.payload ?? null,
      raiseChangeEventPayload:
        commandByName(ingest.streams[2]?.commands ?? [], 'contracts.raiseChangeEvent')?.payload ?? null,
      captureFieldEventPayload:
        commandByName(ingest.streams[3]?.commands ?? [], 'field.captureFieldEvent')?.payload ?? null,
    },
    update: {
      outcomes: update.streams.map((stream) => stream.applications.map((a) => a.outcome)),
      commandNames: update.streams.flatMap((stream) => stream.commands.map((c) => c.commandName)),
      documentCursor: updateDocumentCursor,
      attachRevisionPayload: commandByName(update.streams[0]?.commands ?? [], 'documents.attachRevision')
        ?.payload ?? null,
      commentOnIssuePayload: commandByName(update.streams[1]?.commands ?? [], 'field.commentOnIssue')
        ?.payload ?? null,
      linkChangeReferencesPayload:
        commandByName(update.streams[2]?.commands ?? [], 'contracts.linkChangeReferences')?.payload ?? null,
      attachFieldEventEvidencePayload:
        commandByName(update.streams[3]?.commands ?? [], 'field.attachFieldEventEvidence')?.payload ?? null,
    },
    rescan: {
      outcomes: rescan.streams.map((stream) => stream.applications.map((a) => a.outcome)),
      commandNames: rescan.streams.flatMap((stream) => stream.commands.map((c) => c.commandName)),
    },
    restart: {
      outcomes: restart.streams.map((stream) => stream.applications.map((a) => a.outcome)),
      commandNames: restart.streams.flatMap((stream) => stream.commands.map((c) => c.commandName)),
    },
    deletion: {
      outcomes: deletion.streams.map((stream) => stream.applications.map((a) => a.outcome)),
      commandNames: deletion.streams.flatMap((stream) => stream.commands.map((c) => c.commandName)),
      archiveDocumentPayload: commandByName(deletion.streams[0]?.commands ?? [], 'documents.archiveDocument')
        ?.payload ?? null,
    },
    divergence: {
      outcomes: divergence.applications.map((application) => application.outcome),
      conflicts: divergence.conflicts,
      reDetectedConflicts: reDetection.conflicts,
      conflictCount: conflicts.length,
    },
    foreignLookup,
    foreignAssert,
    mappingsAfterIngest,
    mappingsAfterUpdate,
    mappingsAfterRescan,
    // The determinism comparables (full values, not summaries):
    commands,
    conflictRecords: conflicts,
    finalCursor: await deps.cursors.load(DOC_STREAM),
  };
};

describe('construction contract round-trip (THE OFF-021 acceptance)', () => {
  it('ingests: objects → snapshots → mappings + command proposals', async () => {
    const world = await scenario();

    // Every declared stream synced, in declaration order, each paged to
    // exhaustion (the document stream took two pages at limit 2).
    expect(world.ingest.streamKinds).toStrictEqual(['document', 'rfi', 'change-event', 'observation']);
    expect(world.ingest.outcomes).toStrictEqual([
      ['mapped-created', 'mapped-created', 'mapped-created'],
      ['mapped-created'],
      ['mapped-created'],
      ['mapped-created'],
    ]);
    expect(world.ingest.documentRuns).toBe(2);

    // Every create proposal is a LANDED canonical command of the mapped kind.
    expect(world.ingest.commandNames).toStrictEqual([
      'documents.registerDocument',
      'documents.registerDocument',
      'documents.registerDocument',
      'field.raiseIssue',
      'contracts.raiseChangeEvent',
      'field.captureFieldEvent',
    ]);

    // Representative payloads (the mapping-table semantics, end to end):
    expect(world.ingest.registerDocumentPayload).toStrictEqual({
      projectId: PROJECT_ID,
      title: 'Structural drawing package',
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(sourceOf('document', 'doc-1', 'v1')),
        providerData: DOC_1_VIEW_V1,
      },
    });
    expect(world.ingest.raiseIssuePayload).toStrictEqual({
      title: 'Cladding penetration detail',
      description: RFI_QUESTION_V1,
      category: 'design-coordination',
      severity: 'high',
      reportedAt: PROV_T1,
      reportedBy: USER_ID,
    });
    expect(world.ingest.raiseChangeEventPayload).toStrictEqual({
      contractId: CONTRACT_ID,
      title: 'Additional facade cleaning scope',
      changeType: 'addition',
      costImpactLinks: [{ budgetId: null, costItemId: entity(101) }],
    });
    expect(world.ingest.captureFieldEventPayload).toStrictEqual({
      category: 'quality',
      summary: 'Missing vapor barrier at north wall',
      detail: 'Barrier absent over 3 m of parapet.',
      location: 'Level 3, grid B2',
      observedAt: PROV_T1,
      observedBy: USER_ID,
      quantity: { value: 40, unit: 'm2' },
    });

    // Mappings recorded against OFFICE-ISSUED canonical ids (A10: provider
    // ids are never primary keys), in deterministic issuance order.
    expect(world.mappingsAfterIngest).toStrictEqual([
      { objectId: 'doc-1', canonicalId: entity(1), providerVersion: 'v1' },
      { objectId: 'doc-2', canonicalId: entity(2), providerVersion: 'v1' },
      { objectId: 'doc-3', canonicalId: entity(3), providerVersion: 'v1' },
      { objectId: 'doc-4', canonicalId: '<unmapped>', providerVersion: '<unmapped>' },
      { objectId: 'doc-5', canonicalId: '<unmapped>', providerVersion: '<unmapped>' },
      { objectId: 'rfi-1', canonicalId: entity(4), providerVersion: 'v1' },
      { objectId: 'ce-1', canonicalId: entity(5), providerVersion: 'v1' },
      { objectId: 'obs-1', canonicalId: entity(6), providerVersion: 'v1' },
    ]);

    // The cursor checkpointed the first document page: token '2' (the
    // position after the last delivered item), two items observed.
    expect(world.ingest.documentCursor).toMatchObject({
      token: '2',
      checkpoint: { itemsObserved: 2, lastProviderVersion: 'v1' },
    });
  });

  it('updates: a new provider version → an update proposal + cursor advance', async () => {
    const world = await scenario();

    // The document stream resumed from token '2' and observed: doc-3 at its
    // new version (applied-update), the two appended documents (created)…
    expect(world.update.outcomes[0]).toStrictEqual([
      'applied-update',
      'mapped-created',
      'mapped-created',
    ]);
    // …while the single-object streams re-scanned their mutations.
    expect(world.update.outcomes[1]).toStrictEqual(['applied-update']);
    expect(world.update.outcomes[2]).toStrictEqual(['applied-update']);
    expect(world.update.outcomes[3]).toStrictEqual(['applied-update']);

    expect(world.update.commandNames).toStrictEqual([
      'documents.attachRevision',
      'documents.registerDocument',
      'documents.registerDocument',
      'field.commentOnIssue',
      'contracts.linkChangeReferences',
      'field.attachFieldEventEvidence',
    ]);

    // The update proposals carry the canonical target (from the mapping, not
    // the provider), the observed canonical version, and the provider's
    // current payload at the new version.
    expect(world.update.attachRevisionPayload).toStrictEqual({
      projectId: PROJECT_ID,
      documentId: entity(3),
      expectedVersion: 1,
      contentBase64: CONTENT_C2,
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(sourceOf('document', 'doc-3', 'v2')),
        providerData: DOC_3_VIEW_V2,
      },
    });
    expect(world.update.commentOnIssuePayload).toStrictEqual({
      issueId: entity(4),
      expectedVersion: 1,
      body: `CDE RFI rfi-1 updated to revision v2: ${RFI_QUESTION_V2}`,
    });
    expect(world.update.linkChangeReferencesPayload).toStrictEqual({
      changeEventId: entity(5),
      expectedVersion: 1,
      costImpactLinks: [{ budgetId: entity(102), costItemId: null }],
      scheduleImpactActivityIds: [entity(104)],
    });
    expect(world.update.attachFieldEventEvidencePayload).toStrictEqual({
      fieldEventId: entity(6),
      expectedVersion: 1,
      evidence: [{ entityKind: 'document', entityId: entity(105), revisionId: entity(106) }],
    });

    // The stream's persisted cursor ADVANCED with the update page: '2' → '4'
    // (the position after doc-3@v2 and the appended doc-4).
    expect(world.update.documentCursor).toMatchObject({
      token: '4',
      checkpoint: { itemsObserved: 4 },
    });

    // The mapping bookkeeping followed the provider versions, ids unchanged.
    expect(world.mappingsAfterUpdate).toStrictEqual([
      { objectId: 'doc-1', canonicalId: entity(1), providerVersion: 'v1' },
      { objectId: 'doc-2', canonicalId: entity(2), providerVersion: 'v1' },
      { objectId: 'doc-3', canonicalId: entity(3), providerVersion: 'v2' },
      { objectId: 'doc-4', canonicalId: entity(7), providerVersion: 'v1' },
      { objectId: 'doc-5', canonicalId: entity(8), providerVersion: 'v1' },
      { objectId: 'rfi-1', canonicalId: entity(4), providerVersion: 'v2' },
      { objectId: 'ce-1', canonicalId: entity(5), providerVersion: 'v2' },
      { objectId: 'obs-1', canonicalId: entity(6), providerVersion: 'v2' },
    ]);
  });

  it('maps sources: re-sync resolves the SAME canonical ids; cross-tenant lookups typed-rejected', async () => {
    const world = await scenario();

    // A re-sync with a quiet provider proposes NOTHING…
    expect(world.rescan.outcomes).toStrictEqual([
      ['replay-no-op'],
      ['replay-no-op'],
      ['replay-no-op'],
      ['replay-no-op'],
    ]);
    expect(world.rescan.commandNames).toStrictEqual([]);

    // …and resolves the SAME canonical ids deterministically (nothing
    // re-mapped, no second id ever issued for a known source).
    expect(world.mappingsAfterRescan).toStrictEqual(world.mappingsAfterUpdate);
    for (const summary of world.mappingsAfterRescan) {
      // A10: every canonical id is office-issued through the injected
      // supplier — never a provider object id.
      expect(summary.canonicalId).toMatch(/^office-ent-v1-ent\d{13}$/);
    }

    // A12: the same coordinate under a foreign tenant is indistinguishable
    // from absence (no existence oracle)…
    expect(world.foreignLookup).toBeNull();
    // …and a presented cross-tenant mapping record is a typed unauthorized.
    expect(world.foreignAssert?.ok).toBe(false);
    if (world.foreignAssert?.ok === false) {
      expect(world.foreignAssert.error.code).toBe('unauthorized');
      expect(world.foreignAssert.error.details[0]?.code).toBe('tenant-scope-violation');
    }
  });

  it('replays: same SourceRef+version → idempotent no-op; cursor restart → nothing re-processed', async () => {
    const world = await scenario();

    // A cursor restart over a quiet provider re-processes NOTHING: the
    // positional layer re-delivers only the un-checkpointed tail (doc-5),
    // and every re-delivery is an idempotent no-op — no duplicate mapping,
    // no duplicate command, nothing advanced.
    expect(world.restart.outcomes).toStrictEqual([
      ['replay-no-op'],
      ['replay-no-op'],
      ['replay-no-op'],
      ['replay-no-op'],
    ]);
    expect(world.restart.commandNames).toStrictEqual([]);
  });

  it('deletes: a provider tombstone → the archive proposal', async () => {
    const world = await scenario();

    expect(world.deletion.outcomes[0]).toStrictEqual(['applied-deletion']);
    expect(world.deletion.commandNames).toStrictEqual(['documents.archiveDocument']);
    expect(world.deletion.archiveDocumentPayload).toStrictEqual({
      projectId: PROJECT_ID,
      documentId: entity(8),
      expectedVersion: 1,
    });
  });

  it('diverges: both sides moved → explicit Conflict records with both sides', async () => {
    const world = await scenario();

    // The full re-scan observes the divergence at doc-1 as an explicit
    // conflict — no command proposed for it — while every quiet object
    // replays idempotently.
    expect(world.divergence.outcomes).toStrictEqual([
      'conflict-detected',
      'replay-no-op',
      'replay-no-op',
      'replay-no-op',
      'replay-no-op',
    ]);

    // The record carries BOTH sides: the provider SourceRef (version
    // included) and the canonical EntityRef + aggregate version at detection.
    expect(world.divergence.conflicts).toHaveLength(1);
    expect(world.divergence.conflicts[0]).toMatchObject({
      kind: 'source-conflict',
      tenantId: TENANT_A,
      source: {
        adapterKind: 'construction-cde',
        systemId: 'cde-instance-01',
        objectType: 'document',
        objectId: 'doc-1',
        version: 'v2',
      },
      canonical: { entityKind: 'document', entityId: entity(1) },
      canonicalVersion: 2,
      state: 'detected',
      resolution: null,
    });

    // Re-detection of the SAME divergence appends nothing (idempotent — the
    // conflict id derives from both sides) and the store holds exactly one.
    expect(world.divergence.reDetectedConflicts).toStrictEqual(world.divergence.conflicts);
    expect(world.divergence.conflictCount).toBe(1);
  });

  it('is deterministic: same fixture + same cursors → identical proposals (run twice)', async () => {
    const first = await scenario();
    const second = await scenario();

    // Every observable of the whole round-trip — every proposed command
    // envelope (name, payload, idempotency key, causality, issuedAt), the
    // persisted cursor, and the conflicts — is identical across runs.
    expect(second.commands).toStrictEqual(first.commands);
    expect(second.finalCursor).toStrictEqual(first.finalCursor);
    expect(second.conflictRecords).toStrictEqual(first.conflictRecords);
    expect(second.mappingsAfterUpdate).toStrictEqual(first.mappingsAfterUpdate);

    // 13 proposals across the whole round-trip: six creates (ingest), one
    // update + two creates (catch-up), three updates (re-scanned streams),
    // one archive (tombstone) — the re-scan, the restart, the divergence,
    // and every replay proposed none.
    expect(first.commands).toHaveLength(13);
  });
});
