import { describe, expect, it } from 'vitest';
import { parseEntityId, parseEntityKind, parseTimestamp } from '@office/contracts';
import type { AdapterCommandInput } from '@office/adapters-sdk';
import {
  providerObjectKind,
  providerObjectId,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
} from '@office/adapters-sdk';
import {
  CHANGE_EVENT_OBJECT_KIND,
  CONSTRUCTION_ADAPTER_KIND,
  CONSTRUCTION_SYSTEM_ID,
  DOCUMENT_OBJECT_KIND,
  OBSERVATION_OBJECT_KIND,
  RFI_OBJECT_KIND,
} from './vocabulary';
import {
  createConstructionTranslator,
  parseChangeEventProviderData,
  parseDocumentProviderData,
  parseObservationProviderData,
  parseRfiProviderData,
} from './mapping';
import {
  CONTRACT_ID,
  EVIDENCE_DOCUMENT_ID,
  EVIDENCE_REVISION_ID,
  PROJECT_ID,
  TENANT_A,
  USER_ID,
  NOW_1,
  entity,
  unwrap,
  version,
} from './test-support';

// OFF-021 — the object mapping translation: one provider observation (the
// AdapterCommandInput the SDK engines compose) becomes a typed canonical
// command proposal whose payload mirrors the LANDED domain payload shapes
// (documents.registerDocument/attachRevision/archiveDocument,
// field.raiseIssue/commentOnIssue/resolveIssue,
// contracts.raiseChangeEvent/linkChangeReferences,
// field.captureFieldEvent/attachFieldEventEvidence/resolveFieldEvent).
// Everything is fail-closed and deterministic: malformed provider data and
// unmapped transitions are typed failures, and the same input always yields
// the identical proposal.

const translator = createConstructionTranslator();

const input = (parts: {
  readonly objectType:
    | typeof DOCUMENT_OBJECT_KIND
    | typeof RFI_OBJECT_KIND
    | typeof CHANGE_EVENT_OBJECT_KIND
    | typeof OBSERVATION_OBJECT_KIND;
  readonly objectId: string;
  readonly version: string;
  readonly changeKind: AdapterCommandInput['changeKind'];
  readonly data: Record<string, unknown>;
  readonly canonical?: { readonly entityKind: string; readonly entityId: string } | null;
  readonly canonicalVersion?: number | null;
  readonly displayName?: string | null;
}): AdapterCommandInput => ({
  origin: 'sync',
  tenantId: TENANT_A,
  source: sourceRef({
    adapterKind: CONSTRUCTION_ADAPTER_KIND,
    systemId: CONSTRUCTION_SYSTEM_ID,
    objectType: parts.objectType,
    objectId: providerObjectId(parts.objectId),
    version: providerVersion(parts.version),
  }),
  canonical:
    parts.canonical === undefined || parts.canonical === null
      ? null
      : {
          entityKind: unwrap(parseEntityKind(parts.canonical.entityKind)),
          entityId: unwrap(parseEntityId(parts.canonical.entityId)),
        },
  canonicalVersion:
    parts.canonicalVersion === undefined || parts.canonicalVersion === null
      ? null
      : version(parts.canonicalVersion),
  changeKind: parts.changeKind,
  displayName: parts.displayName === undefined ? 'Display name' : parts.displayName,
  // The test helper's loose record is the translator's untrusted input.
  data: parts.data as AdapterCommandInput['data'],
});

const DOCUMENT_DATA = {
  title: 'Structural drawing package',
  projectId: PROJECT_ID,
  discipline: 'structural',
  revision: { revisionId: 'rev-3', contentBase64: 'UEsDBBQABgAGAAA=' },
};

const RFI_DATA = {
  title: 'Cladding penetration detail',
  projectId: PROJECT_ID,
  question: 'Which detail governs the roof penetration at grid C4?',
  category: 'design-coordination',
  severity: 'high',
  raisedBy: USER_ID,
  raisedAt: NOW_1,
};

const CHANGE_EVENT_DATA = {
  title: 'Additional facade cleaning scope',
  contractRef: CONTRACT_ID,
  changeType: 'addition',
  costImpacts: [{ budgetId: null, costItemId: entity(7) }],
  scheduleImpactActivityIds: [entity(8)],
};

const OBSERVATION_DATA = {
  summary: 'Missing vapor barrier at north wall',
  category: 'quality',
  location: 'Level 3, grid B2',
  observedAt: NOW_1,
  observedBy: USER_ID,
  evidence: [{ documentId: EVIDENCE_DOCUMENT_ID, revisionId: EVIDENCE_REVISION_ID }],
};

describe('construction command translation (OFF-021)', () => {
  // ---- documents -----------------------------------------------------------
  it('proposes documents.registerDocument for a created document', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: DOCUMENT_OBJECT_KIND,
        objectId: 'doc-1',
        version: 'v1',
        changeKind: 'created',
        data: DOCUMENT_DATA,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('documents.registerDocument');
    expect(proposal.value.payload).toStrictEqual({
      projectId: PROJECT_ID,
      title: 'Display name',
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(
          sourceRef({
            adapterKind: CONSTRUCTION_ADAPTER_KIND,
            systemId: CONSTRUCTION_SYSTEM_ID,
            objectType: DOCUMENT_OBJECT_KIND,
            objectId: providerObjectId('doc-1'),
            version: providerVersion('v1'),
          }),
        ),
        providerData: DOCUMENT_DATA,
      },
    });
  });

  it('proposes documents.attachRevision for an updated document (current revision content)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: DOCUMENT_OBJECT_KIND,
        objectId: 'doc-1',
        version: 'v2',
        changeKind: 'updated',
        data: DOCUMENT_DATA,
        canonical: { entityKind: 'document', entityId: entity(1) },
        canonicalVersion: 1,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('documents.attachRevision');
    expect(proposal.value.payload).toMatchObject({
      projectId: PROJECT_ID,
      documentId: entity(1),
      expectedVersion: 1,
      contentBase64: 'UEsDBBQABgAGAAA=',
    });
  });

  it('proposes documents.archiveDocument for a deleted document', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: DOCUMENT_OBJECT_KIND,
        objectId: 'doc-1',
        version: 'v3',
        changeKind: 'deleted',
        data: DOCUMENT_DATA,
        canonical: { entityKind: 'document', entityId: entity(1) },
        canonicalVersion: 2,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('documents.archiveDocument');
    expect(proposal.value.payload).toStrictEqual({
      projectId: PROJECT_ID,
      documentId: entity(1),
      expectedVersion: 2,
    });
  });

  // ---- RFIs ----------------------------------------------------------------
  it('proposes field.raiseIssue for a created RFI (question as description)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: RFI_OBJECT_KIND,
        objectId: 'rfi-17',
        version: 'v1',
        changeKind: 'created',
        data: RFI_DATA,
        displayName: null,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('field.raiseIssue');
    expect(proposal.value.payload).toStrictEqual({
      title: 'Cladding penetration detail',
      description: 'Which detail governs the roof penetration at grid C4?',
      category: 'design-coordination',
      severity: 'high',
      reportedAt: NOW_1,
      reportedBy: USER_ID,
    });
  });

  it('proposes field.commentOnIssue for an updated RFI (deterministic body)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: RFI_OBJECT_KIND,
        objectId: 'rfi-17',
        version: 'v2',
        changeKind: 'updated',
        data: { ...RFI_DATA, question: 'Updated: confirm the sealant specification.' },
        canonical: { entityKind: 'field-issue', entityId: entity(2) },
        canonicalVersion: 1,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('field.commentOnIssue');
    expect(proposal.value.payload).toStrictEqual({
      issueId: entity(2),
      expectedVersion: 1,
      body: 'CDE RFI rfi-17 updated to revision v2: Updated: confirm the sealant specification.',
    });
  });

  it('proposes field.resolveIssue for a closed RFI', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: RFI_OBJECT_KIND,
        objectId: 'rfi-17',
        version: 'v3',
        changeKind: 'deleted',
        data: RFI_DATA,
        canonical: { entityKind: 'field-issue', entityId: entity(2) },
        canonicalVersion: 3,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('field.resolveIssue');
    expect(proposal.value.payload).toStrictEqual({
      issueId: entity(2),
      expectedVersion: 3,
      resolutionNote: 'RFI rfi-17 closed in the CDE at revision v3',
    });
  });

  // ---- change events ---------------------------------------------------------
  it('proposes contracts.raiseChangeEvent for a created change event (with impact links)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: CHANGE_EVENT_OBJECT_KIND,
        objectId: 'ce-9',
        version: 'v1',
        changeKind: 'created',
        data: CHANGE_EVENT_DATA,
        displayName: null,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('contracts.raiseChangeEvent');
    expect(proposal.value.payload).toStrictEqual({
      contractId: CONTRACT_ID,
      title: 'Additional facade cleaning scope',
      changeType: 'addition',
      costImpactLinks: [{ budgetId: null, costItemId: entity(7) }],
      scheduleImpactActivityIds: [entity(8)],
    });
  });

  it('proposes contracts.linkChangeReferences for an updated change event (the latest links)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: CHANGE_EVENT_OBJECT_KIND,
        objectId: 'ce-9',
        version: 'v2',
        changeKind: 'updated',
        data: {
          ...CHANGE_EVENT_DATA,
          costImpacts: [{ budgetId: null, costItemId: entity(7) }, { budgetId: entity(9), costItemId: null }],
          scheduleImpactActivityIds: [entity(8), entity(10)],
        },
        canonical: { entityKind: 'change-event', entityId: entity(3) },
        canonicalVersion: 1,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('contracts.linkChangeReferences');
    expect(proposal.value.payload).toStrictEqual({
      changeEventId: entity(3),
      expectedVersion: 1,
      costImpactLinks: [{ budgetId: entity(9), costItemId: null }],
      scheduleImpactActivityIds: [entity(10)],
    });
  });

  it('FAILS CLOSED on a withdrawn change event (no landed command withdraws one)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: CHANGE_EVENT_OBJECT_KIND,
        objectId: 'ce-9',
        version: 'v3',
        changeKind: 'deleted',
        data: CHANGE_EVENT_DATA,
        canonical: { entityKind: 'change-event', entityId: entity(3) },
        canonicalVersion: 1,
      }),
    );
    expect(proposal.ok).toBe(false);
    if (proposal.ok) return;
    expect(proposal.error.code).toBe('invariant-violation');
    expect(proposal.error.details[0]?.code).toBe('provider-transition-unmapped');
    expect(proposal.error.message).toContain('append-only');
  });

  it('fails closed on an updated change event with no new links', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: CHANGE_EVENT_OBJECT_KIND,
        objectId: 'ce-9',
        version: 'v2',
        changeKind: 'updated',
        data: { ...CHANGE_EVENT_DATA, costImpacts: [], scheduleImpactActivityIds: [] },
        canonical: { entityKind: 'change-event', entityId: entity(3) },
        canonicalVersion: 1,
      }),
    );
    expect(proposal.ok).toBe(false);
    if (proposal.ok) return;
    expect(proposal.error.details[0]?.code).toBe('provider-update-without-links');
  });

  // ---- observations ----------------------------------------------------------
  it('proposes field.captureFieldEvent for a created observation', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: OBSERVATION_OBJECT_KIND,
        objectId: 'obs-4',
        version: 'v1',
        changeKind: 'created',
        data: { ...OBSERVATION_DATA, detail: 'Barrier absent over 3 m.' },
        displayName: null,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('field.captureFieldEvent');
    expect(proposal.value.payload).toStrictEqual({
      category: 'quality',
      summary: 'Missing vapor barrier at north wall',
      detail: 'Barrier absent over 3 m.',
      location: 'Level 3, grid B2',
      observedAt: NOW_1,
      observedBy: USER_ID,
    });
  });

  it('proposes field.attachFieldEventEvidence for an updated observation (latest evidence)', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: OBSERVATION_OBJECT_KIND,
        objectId: 'obs-4',
        version: 'v2',
        changeKind: 'updated',
        data: {
          ...OBSERVATION_DATA,
          evidence: [
            { documentId: EVIDENCE_DOCUMENT_ID, revisionId: EVIDENCE_REVISION_ID },
            { documentId: entity(11), revisionId: entity(12) },
          ],
        },
        canonical: { entityKind: 'field-event', entityId: entity(4) },
        canonicalVersion: 1,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('field.attachFieldEventEvidence');
    expect(proposal.value.payload).toStrictEqual({
      fieldEventId: entity(4),
      expectedVersion: 1,
      evidence: [{ entityKind: 'document', entityId: entity(11), revisionId: entity(12) }],
    });
  });

  it('fails closed on an updated observation with no evidence to attach', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: OBSERVATION_OBJECT_KIND,
        objectId: 'obs-4',
        version: 'v2',
        changeKind: 'updated',
        data: { ...OBSERVATION_DATA, evidence: [] },
        canonical: { entityKind: 'field-event', entityId: entity(4) },
        canonicalVersion: 1,
      }),
    );
    expect(proposal.ok).toBe(false);
    if (proposal.ok) return;
    expect(proposal.error.details[0]?.code).toBe('provider-update-without-evidence');
  });

  it('proposes field.resolveFieldEvent for a voided observation', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: OBSERVATION_OBJECT_KIND,
        objectId: 'obs-4',
        version: 'v3',
        changeKind: 'deleted',
        data: OBSERVATION_DATA,
        canonical: { entityKind: 'field-event', entityId: entity(4) },
        canonicalVersion: 2,
      }),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.commandName).toBe('field.resolveFieldEvent');
    expect(proposal.value.payload).toStrictEqual({
      fieldEventId: entity(4),
      expectedVersion: 2,
      resolutionNote: 'Observation obs-4 voided in the CDE at revision v3',
    });
  });

  // ---- the shared discipline -------------------------------------------------
  it('requires a resolved canonical target for updates and deletions', () => {
    for (const changeKind of ['updated', 'deleted'] as const) {
      const proposal = translator.proposeCommand(
        input({
          objectType: RFI_OBJECT_KIND,
          objectId: 'rfi-17',
          version: 'v2',
          changeKind,
          data: RFI_DATA,
          canonical: null,
        }),
      );
      expect(proposal.ok).toBe(false);
      if (proposal.ok) return;
      expect(proposal.error.details[0]?.code).toBe('canonical-target-required');
    }
  });

  it('fails closed on malformed provider data (typed, with field paths)', () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['document', { ...DOCUMENT_DATA, projectId: 'not-an-office-id' }, 'projectId'],
      ['document', { ...DOCUMENT_DATA, revision: { revisionId: '', contentBase64: 'x' } }, 'revision.revisionId'],
      ['rfi', { ...RFI_DATA, severity: 'urgent' }, 'severity'],
      ['rfi', { ...RFI_DATA, raisedAt: 'yesterday' }, 'raisedAt'],
      ['change-event', { ...CHANGE_EVENT_DATA, changeType: 'rework' }, 'changeType'],
      ['change-event', { ...CHANGE_EVENT_DATA, costImpacts: 'none' }, 'costImpacts'],
      ['observation', { ...OBSERVATION_DATA, observedBy: 'user-7' }, 'observedBy'],
      ['observation', { ...OBSERVATION_DATA, evidence: [{ documentId: 'doc', revisionId: 'r' }] }, 'evidence[0].documentId'],
      ['observation', { ...OBSERVATION_DATA, detail: '' }, 'detail'],
      ['observation', { ...OBSERVATION_DATA, quantity: { value: -1, unit: 'm2' } }, 'quantity.value'],
    ];
    for (const [name, data, path] of cases) {
      const objectType =
        name === 'document'
          ? DOCUMENT_OBJECT_KIND
          : name === 'rfi'
            ? RFI_OBJECT_KIND
            : name === 'change-event'
              ? CHANGE_EVENT_OBJECT_KIND
              : OBSERVATION_OBJECT_KIND;
      const proposal = translator.proposeCommand(
        input({ objectType, objectId: `x-${name}`, version: 'v1', changeKind: 'created', data }),
      );
      expect(proposal.ok, `${name} at ${path}`).toBe(false);
      if (proposal.ok) continue;
      expect(proposal.error.code, `${name} at ${path}`).toBe('invariant-violation');
      expect(proposal.error.details[0]?.code, `${name} at ${path}`).toMatch(/^provider-data-/);
      expect(proposal.error.details[0]?.path, `${name} at ${path}`).toBe(path);
    }
  });

  it('fails closed on undeclared object kinds', () => {
    const proposal = translator.proposeCommand(
      input({
        objectType: providerObjectKind('inspection'),
        objectId: 'insp-1',
        version: 'v1',
        changeKind: 'created',
        data: {},
      }),
    );
    expect(proposal.ok).toBe(false);
    if (proposal.ok) return;
    expect(proposal.error.details[0]?.code).toBe('object-kind-not-declared');
  });

  it('is deterministic: the same input yields the identical proposal', () => {
    const parts = {
      objectType: RFI_OBJECT_KIND,
      objectId: 'rfi-17',
      version: 'v2',
      changeKind: 'updated',
      data: RFI_DATA,
      canonical: { entityKind: 'field-issue', entityId: entity(2) },
      canonicalVersion: 1,
    } as const;
    const first = translator.proposeCommand(input({ ...parts }));
    const second = translator.proposeCommand(input({ ...parts }));
    expect(second).toStrictEqual(first);
  });

  it('parses each kind of provider data fail-closed (strict keys)', () => {
    expect(parseDocumentProviderData(DOCUMENT_DATA).ok).toBe(true);
    expect(parseRfiProviderData(RFI_DATA).ok).toBe(true);
    expect(parseChangeEventProviderData(CHANGE_EVENT_DATA).ok).toBe(true);
    expect(parseObservationProviderData(OBSERVATION_DATA).ok).toBe(true);
    // Unknown fields are rejected (strict shapes).
    expect(
      parseDocumentProviderData({ ...DOCUMENT_DATA, extra: 'field' }).ok,
    ).toBe(false);
    expect(parseRfiProviderData({ ...RFI_DATA, vendorField: 1 }).ok).toBe(false);
    expect(
      parseObservationProviderData({ ...OBSERVATION_DATA, unknown: null }).ok,
    ).toBe(false);
    // The parsers surface office-issued identity references as typed values.
    const rfi = parseRfiProviderData(RFI_DATA);
    expect(rfi.ok && rfi.value.raisedAt).toBe(unwrap(parseTimestamp(NOW_1)));
    const observation = parseObservationProviderData(OBSERVATION_DATA);
    expect(observation.ok && observation.value.evidence?.[0]?.documentId).toBe(
      EVIDENCE_DOCUMENT_ID,
    );
  });
});
