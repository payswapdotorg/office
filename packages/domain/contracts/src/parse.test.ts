import { describe, expect, it } from 'vitest';
import { formatEntityId, formatProjectId } from '@office/contracts';
import {
  parseApproveChangeOrderPayload,
  parseArchiveContractPayload,
  parseCreateContractPayload,
  parseExecuteChangeOrderPayload,
  parseLinkChangeReferencesPayload,
  parseRaiseChangeEventPayload,
  parseRecordScopeObligationPayload,
  parseReferenceClaimPayload,
  parseRejectChangeOrderPayload,
  parseSubmitChangeOrderPayload,
  parseUpdateContractPayload,
} from './commands';
import {
  parseCostImpactLink,
  parseCurrencyCode,
  parseEvidenceLink,
  parseMinorUnits,
  parseMoney,
  parsePartyLink,
  parseQuantityValue,
} from './parse';

// OFF-012 contracts/change domain — the fail-closed payload-parsing suite:
// every command payload parser rejects wrong types, missing fields, unknown
// keys, vocabulary violations and malformed links with typed ParseErrors;
// the commercial value objects (minor-unit money, canonical decimal
// quantities, party/evidence/cost links) parse exactly their grammar.

const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const CONTRACT_ID = formatEntityId({
  version: 'v1',
  opaque: 'aa1b2c3d4e5f60718293a4b5c6d7e8f0',
});
const OBLIGATION_ID = formatEntityId({
  version: 'v1',
  opaque: 'bb2c3d4e5f60718293a4b5c6d7e8f0a1',
});
const CHANGE_EVENT_ID = formatEntityId({
  version: 'v1',
  opaque: 'cc3d4e5f60718293a4b5c6d7e8f0a1b2',
});
const CHANGE_ORDER_ID = formatEntityId({
  version: 'v1',
  opaque: 'dd4e5f60718293a4b5c6d7e8f0a1b2c3',
});
const PERSON_ID = formatEntityId({
  version: 'v1',
  opaque: 'ff60718293a4b5c6d7e8f0a1b2c3d4e5',
});
const COMPANY_ID = formatEntityId({
  version: 'v1',
  opaque: '0f60718293a4b5c6d7e8f0a1b2c3d4e6',
});
const DOCUMENT_ID = formatEntityId({
  version: 'v1',
  opaque: '1f60718293a4b5c6d7e8f0a1b2c3d4e7',
});
const REVISION_ID = formatEntityId({
  version: 'v1',
  opaque: '2f60718293a4b5c6d7e8f0a1b2c3d4e8',
});
const BUDGET_ID = formatEntityId({
  version: 'v1',
  opaque: '4f60718293a4b5c6d7e8f0a1b2c3d4f0',
});
const COST_ITEM_ID = formatEntityId({
  version: 'v1',
  opaque: '5f60718293a4b5c6d7e8f0a1b2c3d4f1',
});
const ACTIVITY_ID = formatEntityId({
  version: 'v1',
  opaque: '7f60718293a4b5c6d7e8f0a1b2c3d4f3',
});

const createPayload = () => ({
  title: 'Riverside design-build contract',
  owner: { entityKind: 'company', entityId: PERSON_ID },
  contractor: { entityKind: 'company', entityId: COMPANY_ID },
  contractValue: { amount: 12_500_000, currency: 'USD' },
  projectId: PROJECT_ID,
});

describe('commercial value objects (fail-closed)', () => {
  it('parses canonical minor-unit money values', () => {
    expect(parseMoney({ amount: 1250, currency: 'EUR' })).toStrictEqual({
      ok: true,
      value: { amount: 1250, currency: 'EUR' },
    });
    expect(parseMoney({ amount: -250, currency: 'USD' })?.ok).toBe(true);
  });

  it('rejects float amounts, unknown currencies, extra keys and non-objects', () => {
    expect(parseMoney({ amount: 12.5, currency: 'USD' }).ok).toBe(false);
    expect(parseMoney({ amount: 1250, currency: 'usd' }).ok).toBe(false);
    expect(parseMoney({ amount: 1250, currency: 'USDD' }).ok).toBe(false);
    expect(parseMoney({ amount: 1250, currency: 'USD', note: 'x' }).ok).toBe(false);
    expect(parseMoney('1250 USD').ok).toBe(false);
    expect(parseMoney({ amount: 1250 }).ok).toBe(false);
  });

  it('bounds minor units to exact integers in the safe commercial range', () => {
    expect(parseMinorUnits(1_000_000_000_000_000).ok).toBe(true);
    expect(parseMinorUnits(1_000_000_000_000_001).ok).toBe(false);
    expect(parseMinorUnits(-1_000_000_000_000_001).ok).toBe(false);
    expect(parseMinorUnits('100').ok).toBe(false);
  });

  it('parses canonical currency codes only (three uppercase letters)', () => {
    expect(parseCurrencyCode('USD').ok).toBe(true);
    expect(parseCurrencyCode('usd').ok).toBe(false);
    expect(parseCurrencyCode('US').ok).toBe(false);
    expect(parseCurrencyCode('USDE').ok).toBe(false);
  });

  it('parses canonical decimal quantities only (no floats, no leading zeros, max 3 fractions)', () => {
    expect(parseQuantityValue('12').ok).toBe(true);
    expect(parseQuantityValue('0.5').ok).toBe(true);
    expect(parseQuantityValue('133.750').ok).toBe(true);
    expect(parseQuantityValue('012').ok).toBe(false);
    expect(parseQuantityValue('1.2345').ok).toBe(false);
    expect(parseQuantityValue('12,5').ok).toBe(false);
    expect(parseQuantityValue(12.5).ok).toBe(false);
    expect(parseQuantityValue('-5').ok).toBe(false);
  });

  it('parses party links with the closed person/company vocabulary only', () => {
    expect(parsePartyLink({ entityKind: 'person', entityId: PERSON_ID }).ok).toBe(true);
    expect(parsePartyLink({ entityKind: 'company', entityId: COMPANY_ID }).ok).toBe(true);
    expect(parsePartyLink({ entityKind: 'org', entityId: COMPANY_ID }).ok).toBe(false);
    expect(parsePartyLink({ entityKind: 'person', entityId: 'not-an-id' }).ok).toBe(false);
    expect(parsePartyLink({ entityKind: 'person' }).ok).toBe(false);
  });

  it('parses evidence links binding a document AND a specific revision', () => {
    expect(parseEvidenceLink({ documentId: DOCUMENT_ID, revisionId: REVISION_ID }).ok).toBe(true);
    expect(parseEvidenceLink({ documentId: DOCUMENT_ID }).ok).toBe(false);
    expect(parseEvidenceLink({ revisionId: REVISION_ID, extra: 1 }).ok).toBe(false);
    expect(parseEvidenceLink([DOCUMENT_ID, REVISION_ID]).ok).toBe(false);
  });

  it('parses cost impact links requiring at least one of budget or cost item', () => {
    expect(parseCostImpactLink({ budgetId: BUDGET_ID, costItemId: null }).ok).toBe(true);
    expect(parseCostImpactLink({ budgetId: null, costItemId: COST_ITEM_ID }).ok).toBe(true);
    expect(parseCostImpactLink({ budgetId: BUDGET_ID, costItemId: COST_ITEM_ID }).ok).toBe(true);
    expect(parseCostImpactLink({ budgetId: null, costItemId: null }).ok).toBe(false);
    expect(parseCostImpactLink({}).ok).toBe(false);
    expect(parseCostImpactLink({ budgetId: 'x', costItemId: null }).ok).toBe(false);
  });
});

describe('parseCreateContractPayload (fail-closed, strict keys)', () => {
  it('parses a complete payload and defaults nothing silently', () => {
    const result = parseCreateContractPayload(createPayload());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe('Riverside design-build contract');
      expect(result.value.contractValue).toStrictEqual({ amount: 12_500_000, currency: 'USD' });
      expect(result.value.projectId).toBe(PROJECT_ID);
    }
  });

  it('rejects non-objects, unknown keys, and each missing/malformed field', () => {
    expect(parseCreateContractPayload(null).ok).toBe(false);
    expect(parseCreateContractPayload([]).ok).toBe(false);
    expect(parseCreateContractPayload({ ...createPayload(), extra: true }).ok).toBe(false);
    expect(parseCreateContractPayload({ ...createPayload(), title: '' }).ok).toBe(false);
    expect(parseCreateContractPayload({ ...createPayload(), title: 7 }).ok).toBe(false);
    expect(
      parseCreateContractPayload({ ...createPayload(), contractValue: { amount: 1.5, currency: 'USD' } })
        .ok,
    ).toBe(false);
    expect(
      parseCreateContractPayload({ ...createPayload(), executionStatus: 'signed' }).ok,
    ).toBe(false);
    const { owner, ...withoutOwner } = createPayload();
    expect(owner).toBeDefined();
    expect(parseCreateContractPayload(withoutOwner).ok).toBe(false);
  });

  it('rejects malformed project ids and party links at their nested paths', () => {
    const badProject = parseCreateContractPayload({ ...createPayload(), projectId: 'prj-x' });
    expect(badProject.ok).toBe(false);
    if (!badProject.ok) expect(badProject.error.path).toBe('projectId');
    const badOwner = parseCreateContractPayload({
      ...createPayload(),
      owner: { entityKind: 'person', entityId: 'nope' },
    });
    expect(badOwner.ok).toBe(false);
    if (!badOwner.ok) expect(badOwner.error.path).toBe('owner.entityId');
  });
});

describe('parseUpdateContractPayload (fail-closed, strict keys)', () => {
  const updatePayload = () => ({
    contractId: CONTRACT_ID,
    expectedVersion: 2,
    title: 'Amended title',
  });

  it('parses change fields and requires at least one', () => {
    const result = parseUpdateContractPayload(updatePayload());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.changes.title).toBe('Amended title');
    const empty = parseUpdateContractPayload({ contractId: CONTRACT_ID, expectedVersion: 2 });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('invalid-value');
  });

  it('rejects stale-version shapes, unknown keys, and malformed statuses', () => {
    expect(parseUpdateContractPayload({ ...updatePayload(), expectedVersion: 0 }).ok).toBe(false);
    expect(parseUpdateContractPayload({ ...updatePayload(), unknown: 1 }).ok).toBe(false);
    expect(
      parseUpdateContractPayload({ ...updatePayload(), executionStatus: 'void' }).ok,
    ).toBe(false);
    expect(parseUpdateContractPayload({ ...updatePayload(), contractId: 'x' }).ok).toBe(false);
  });
});

describe('parseArchiveContractPayload (fail-closed, strict keys)', () => {
  it('parses the id + expected version, and rejects everything else', () => {
    expect(parseArchiveContractPayload({ contractId: CONTRACT_ID, expectedVersion: 3 }).ok).toBe(
      true,
    );
    expect(parseArchiveContractPayload({ contractId: CONTRACT_ID }).ok).toBe(false);
    expect(parseArchiveContractPayload({ contractId: CONTRACT_ID, expectedVersion: 3, why: 1 }).ok)
      .toBe(false);
    expect(parseArchiveContractPayload('archive').ok).toBe(false);
  });
});

describe('parseRecordScopeObligationPayload (fail-closed, strict keys)', () => {
  const obligationPayload = () => ({
    contractId: CONTRACT_ID,
    expectedVersion: 1,
    code: 'EARTHWORKS',
    description: 'Excavation and grading of the north platform',
    quantity: '1250.5',
    unit: 'm3',
  });

  it('parses a complete obligation payload', () => {
    const result = parseRecordScopeObligationPayload(obligationPayload());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.quantity).toBe('1250.5');
      expect(result.value.unit).toBe('m3');
    }
  });

  it('rejects float quantities, bad codes/units, and unknown keys', () => {
    expect(parseRecordScopeObligationPayload({ ...obligationPayload(), quantity: 1250.5 }).ok).toBe(
      false,
    );
    expect(parseRecordScopeObligationPayload({ ...obligationPayload(), quantity: '1.2345' }).ok)
      .toBe(false);
    expect(parseRecordScopeObligationPayload({ ...obligationPayload(), code: '-bad' }).ok).toBe(
      false,
    );
    expect(parseRecordScopeObligationPayload({ ...obligationPayload(), unit: '' }).ok).toBe(false);
    expect(parseRecordScopeObligationPayload({ ...obligationPayload(), note: 'x' }).ok).toBe(false);
    expect(parseRecordScopeObligationPayload({ ...obligationPayload(), description: '' }).ok).toBe(
      false,
    );
  });
});

describe('parseRaiseChangeEventPayload (fail-closed, strict keys)', () => {
  const raisePayload = () => ({
    contractId: CONTRACT_ID,
    title: 'North platform additional excavation',
    changeType: 'modification',
    affectedObligationIds: [OBLIGATION_ID],
    evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
    costImpactLinks: [{ budgetId: BUDGET_ID, costItemId: null }],
    scheduleImpactActivityIds: [ACTIVITY_ID],
  });

  it('parses a complete typed-link payload (ids and refs only)', () => {
    const result = parseRaiseChangeEventPayload(raisePayload());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.affectedObligationIds).toStrictEqual([OBLIGATION_ID]);
      expect(result.value.evidenceLinks).toStrictEqual([
        { documentId: DOCUMENT_ID, revisionId: REVISION_ID },
      ]);
      expect(result.value.costImpactLinks).toStrictEqual([
        { budgetId: BUDGET_ID, costItemId: null },
      ]);
      expect(result.value.scheduleImpactActivityIds).toStrictEqual([ACTIVITY_ID]);
    }
  });

  it('rejects a non-array link family, malformed link entries, and vocabulary violations', () => {
    expect(parseRaiseChangeEventPayload({ ...raisePayload(), changeType: 'adjustment' }).ok).toBe(
      false,
    );
    expect(parseRaiseChangeEventPayload({ ...raisePayload(), affectedObligationIds: 'all' }).ok)
      .toBe(false);
    expect(
      parseRaiseChangeEventPayload({ ...raisePayload(), evidenceLinks: [{ documentId: DOCUMENT_ID }] })
        .ok,
    ).toBe(false);
    expect(
      parseRaiseChangeEventPayload({ ...raisePayload(), evidenceLinks: [{ documentId: 'x', revisionId: REVISION_ID }] })
        .ok,
    ).toBe(false);
    expect(
      parseRaiseChangeEventPayload({
        ...raisePayload(),
        costImpactLinks: [{ budgetId: null, costItemId: null }],
      }).ok,
    ).toBe(false);
    expect(
      parseRaiseChangeEventPayload({ ...raisePayload(), scheduleImpactActivityIds: [ACTIVITY_ID, 'bad'] })
        .ok,
    ).toBe(false);
    expect(parseRaiseChangeEventPayload({ ...raisePayload(), surprise: true }).ok).toBe(false);
  });

  it('reports nested element failures with indexed paths', () => {
    const result = parseRaiseChangeEventPayload({
      ...raisePayload(),
      evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }, { documentId: 4 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toContain('evidenceLinks[1]');
  });
});

describe('parseLinkChangeReferencesPayload (fail-closed, strict keys)', () => {
  it('parses appended links and requires at least one new link', () => {
    const result = parseLinkChangeReferencesPayload({
      changeEventId: CHANGE_EVENT_ID,
      expectedVersion: 1,
      evidenceLinks: [{ documentId: DOCUMENT_ID, revisionId: REVISION_ID }],
    });
    expect(result.ok).toBe(true);
    const empty = parseLinkChangeReferencesPayload({
      changeEventId: CHANGE_EVENT_ID,
      expectedVersion: 1,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('invalid-value');
    const emptyArrays = parseLinkChangeReferencesPayload({
      changeEventId: CHANGE_EVENT_ID,
      expectedVersion: 1,
      evidenceLinks: [],
    });
    expect(emptyArrays.ok).toBe(false);
  });

  it('rejects malformed ids and unknown keys', () => {
    expect(
      parseLinkChangeReferencesPayload({ changeEventId: 'nope', expectedVersion: 1 }).ok,
    ).toBe(false);
    expect(
      parseLinkChangeReferencesPayload({ changeEventId: CHANGE_EVENT_ID, expectedVersion: 0 }).ok,
    ).toBe(false);
    expect(
      parseLinkChangeReferencesPayload({
        changeEventId: CHANGE_EVENT_ID,
        expectedVersion: 1,
        removeEvidence: true,
      }).ok,
    ).toBe(false);
  });
});

describe('parseSubmitChangeOrderPayload (fail-closed, strict keys)', () => {
  it('parses a submitted order with an optional signed value impact', () => {
    const result = parseSubmitChangeOrderPayload({
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO 01 — additional excavation',
      changeValue: { amount: -250_000, currency: 'USD' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.changeValue?.amount).toBe(-250_000);
    const noValue = parseSubmitChangeOrderPayload({
      changeEventId: CHANGE_EVENT_ID,
      title: 'CO 01 — additional excavation',
    });
    expect(noValue.ok).toBe(true);
  });

  it('rejects malformed money values, missing titles, and unknown keys', () => {
    expect(
      parseSubmitChangeOrderPayload({
        changeEventId: CHANGE_EVENT_ID,
        title: 'CO 01',
        changeValue: { amount: 1.5, currency: 'USD' },
      }).ok,
    ).toBe(false);
    expect(parseSubmitChangeOrderPayload({ changeEventId: CHANGE_EVENT_ID }).ok).toBe(false);
    expect(
      parseSubmitChangeOrderPayload({ changeEventId: CHANGE_EVENT_ID, title: 'CO 01', note: 1 }).ok,
    ).toBe(false);
    expect(
      parseSubmitChangeOrderPayload({ changeEventId: CHANGE_EVENT_ID, title: '', }).ok,
    ).toBe(false);
  });
});

describe('parse{Approve,Reject,Execute}ChangeOrderPayload (fail-closed, strict keys)', () => {
  it('approves/rejects with optional bounded reasons', () => {
    expect(
      parseApproveChangeOrderPayload({ changeOrderId: CHANGE_ORDER_ID, expectedVersion: 1 }).ok,
    ).toBe(true);
    expect(
      parseApproveChangeOrderPayload({
        changeOrderId: CHANGE_ORDER_ID,
        expectedVersion: 1,
        reason: 'Verified against field evidence',
      }).ok,
    ).toBe(true);
    expect(
      parseRejectChangeOrderPayload({ changeOrderId: CHANGE_ORDER_ID, expectedVersion: 1 }).ok,
    ).toBe(true);
    expect(
      parseApproveChangeOrderPayload({ changeOrderId: 'x', expectedVersion: 1 }).ok,
    ).toBe(false);
    expect(
      parseApproveChangeOrderPayload({ changeOrderId: CHANGE_ORDER_ID, expectedVersion: 1, extra: 0 })
        .ok,
    ).toBe(false);
    expect(
      parseRejectChangeOrderPayload({ changeOrderId: CHANGE_ORDER_ID, expectedVersion: -1 }).ok,
    ).toBe(false);
  });

  it('executes with the id + expected version only', () => {
    expect(
      parseExecuteChangeOrderPayload({ changeOrderId: CHANGE_ORDER_ID, expectedVersion: 2 }).ok,
    ).toBe(true);
    expect(parseExecuteChangeOrderPayload({ changeOrderId: CHANGE_ORDER_ID }).ok).toBe(false);
    expect(
      parseExecuteChangeOrderPayload({ changeOrderId: CHANGE_ORDER_ID, expectedVersion: 2, when: 1 })
        .ok,
    ).toBe(false);
  });
});

describe('parseReferenceClaimPayload (fail-closed, strict keys)', () => {
  it('parses the claim kind + id and the change order + evidence pins', () => {
    const result = parseReferenceClaimPayload({
      claimEntityKind: 'claim',
      claimEntityId: formatEntityId({ version: 'v1', opaque: '9f60718293a4b5c6d7e8f0a1b2c3d4f5' }),
      changeOrderId: CHANGE_ORDER_ID,
      documentId: DOCUMENT_ID,
      revisionId: REVISION_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.claimEntityKind).toBe('claim');
  });

  it('rejects malformed kinds/ids and unknown keys', () => {
    expect(
      parseReferenceClaimPayload({
        claimEntityKind: 'Claim',
        claimEntityId: formatEntityId({ version: 'v1', opaque: '9f60718293a4b5c6d7e8f0a1b2c3d4f5' }),
        changeOrderId: CHANGE_ORDER_ID,
        documentId: DOCUMENT_ID,
        revisionId: REVISION_ID,
      }).ok,
    ).toBe(false);
    expect(
      parseReferenceClaimPayload({
        claimEntityKind: 'claim',
        claimEntityId: 'nope',
        changeOrderId: CHANGE_ORDER_ID,
        documentId: DOCUMENT_ID,
        revisionId: REVISION_ID,
      }).ok,
    ).toBe(false);
    expect(
      parseReferenceClaimPayload({
        claimEntityKind: 'claim',
        claimEntityId: formatEntityId({ version: 'v1', opaque: '9f60718293a4b5c6d7e8f0a1b2c3d4f5' }),
        changeOrderId: CHANGE_ORDER_ID,
        documentId: DOCUMENT_ID,
        extra: 1,
      }).ok,
    ).toBe(false);
  });
});
