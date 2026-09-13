import { describe, expect, it } from 'vitest';
import { providerObjectKind } from '@office/adapters-sdk';
import {
  CHANGE_EVENT_CANONICAL_KIND,
  CHANGE_EVENT_CREATE_COMMAND,
  CHANGE_EVENT_OBJECT_KIND,
  CHANGE_EVENT_UPDATE_COMMAND,
  CONSTRUCTION_ADAPTER_KIND,
  CONSTRUCTION_CAPABILITIES,
  CONSTRUCTION_CAPABILITY_NAMES,
  CONSTRUCTION_OBJECT_KINDS,
  CONSTRUCTION_OBJECT_MAPPINGS,
  CONSTRUCTION_SYSTEM_ID,
  DOCUMENT_CANONICAL_KIND,
  DOCUMENT_CREATE_COMMAND,
  DOCUMENT_DELETE_COMMAND,
  DOCUMENT_OBJECT_KIND,
  DOCUMENT_UPDATE_COMMAND,
  OBSERVATION_CANONICAL_KIND,
  OBSERVATION_CREATE_COMMAND,
  OBSERVATION_DELETE_COMMAND,
  OBSERVATION_OBJECT_KIND,
  OBSERVATION_UPDATE_COMMAND,
  RFI_CANONICAL_KIND,
  RFI_CREATE_COMMAND,
  RFI_DELETE_COMMAND,
  RFI_OBJECT_KIND,
  RFI_UPDATE_COMMAND,
  constructionObjectMappingOf,
} from './vocabulary';

// OFF-021 — the construction/CDE vocabulary: strictly generic provider names
// (no vendor anywhere — the boundary test enforces the ban), canonical kinds
// and command names drawn from the LANDED domain vocabulary, capabilities
// from the authz declared vocabulary, and an object mapping table whose
// declared capabilities value is validated through the SDK's own parser.

describe('construction vocabulary (OFF-021)', () => {
  it('uses generic provider vocabulary only', () => {
    expect(CONSTRUCTION_ADAPTER_KIND).toBe('construction-cde');
    expect(CONSTRUCTION_SYSTEM_ID).toBe('cde-instance-01');
    expect(CONSTRUCTION_OBJECT_KINDS).toStrictEqual([
      'document',
      'rfi',
      'change-event',
      'observation',
    ]);
  });

  it('maps every object kind into the landed canonical kinds', () => {
    expect(DOCUMENT_CANONICAL_KIND).toBe('document');
    expect(RFI_CANONICAL_KIND).toBe('field-issue');
    expect(CHANGE_EVENT_CANONICAL_KIND).toBe('change-event');
    expect(OBSERVATION_CANONICAL_KIND).toBe('field-event');
  });

  it('proposes only LANDED canonical command names', () => {
    expect(DOCUMENT_CREATE_COMMAND).toBe('documents.registerDocument');
    expect(DOCUMENT_UPDATE_COMMAND).toBe('documents.attachRevision');
    expect(DOCUMENT_DELETE_COMMAND).toBe('documents.archiveDocument');
    expect(RFI_CREATE_COMMAND).toBe('field.raiseIssue');
    expect(RFI_UPDATE_COMMAND).toBe('field.commentOnIssue');
    expect(RFI_DELETE_COMMAND).toBe('field.resolveIssue');
    expect(CHANGE_EVENT_CREATE_COMMAND).toBe('contracts.raiseChangeEvent');
    expect(CHANGE_EVENT_UPDATE_COMMAND).toBe('contracts.linkChangeReferences');
    expect(OBSERVATION_CREATE_COMMAND).toBe('field.captureFieldEvent');
    expect(OBSERVATION_UPDATE_COMMAND).toBe('field.attachFieldEventEvidence');
    expect(OBSERVATION_DELETE_COMMAND).toBe('field.resolveFieldEvent');
  });

  it('declares four unique object-kind surfaces with declared-vocabulary capabilities', () => {
    expect(CONSTRUCTION_OBJECT_MAPPINGS).toHaveLength(4);
    const kinds = CONSTRUCTION_OBJECT_MAPPINGS.map((mapping) => mapping.objectKind);
    expect(new Set(kinds).size).toBe(4);
    // Every capability literal is from the authz declared vocabulary — the
    // table's construction validates each surface through the SDK's
    // parseAdapterObjectCapability (which fail-closes on undeclared
    // capabilities), so an undeclared name would throw at module load.
    expect(CONSTRUCTION_CAPABILITY_NAMES).toStrictEqual([
      'documents.write',
      'work.write',
      'contracts.write',
      'work.write',
    ]);
  });

  it('composes a parser-valid AdapterCapabilities declaration from the table', () => {
    // The SDK's own fail-closed parser validates the declaration (grammar +
    // declared capability vocabulary + unique object kinds).
    expect(CONSTRUCTION_CAPABILITIES.objectKinds).toStrictEqual(
      CONSTRUCTION_OBJECT_MAPPINGS.map((mapping) => ({
        objectKind: mapping.objectKind,
        canonicalKind: mapping.canonicalKind,
        capability: mapping.capability,
      })),
    );
  });

  it('resolves declared object kinds and fails closed on undeclared ones', () => {
    expect(constructionObjectMappingOf(DOCUMENT_OBJECT_KIND)?.createCommand).toBe(
      DOCUMENT_CREATE_COMMAND,
    );
    expect(constructionObjectMappingOf(RFI_OBJECT_KIND)?.canonicalKind).toBe('field-issue');
    expect(constructionObjectMappingOf(CHANGE_EVENT_OBJECT_KIND)?.deleteCommand).toBeNull();
    expect(constructionObjectMappingOf(OBSERVATION_OBJECT_KIND)?.deleteCommand).toBe(
      OBSERVATION_DELETE_COMMAND,
    );
    expect(constructionObjectMappingOf(providerObjectKind('inspection'))).toBeNull();
  });

  it('documents the single unmapped provider transition (the withdrawn change event)', () => {
    // A10/A11 discipline: the table never invents canonical semantics. The
    // canonical contracts domain models change events as append-only, so the
    // withdrawn-change-event deletion maps to NOTHING (null) — the translator
    // fails closed rather than improvising a command.
    const changeEvent = CONSTRUCTION_OBJECT_MAPPINGS.find(
      (mapping) => mapping.objectKind === CHANGE_EVENT_OBJECT_KIND,
    );
    expect(changeEvent?.deleteCommand).toBeNull();
    const mapped = CONSTRUCTION_OBJECT_MAPPINGS.filter(
      (mapping) => mapping.deleteCommand !== null,
    );
    expect(mapped).toHaveLength(3);
  });
});
