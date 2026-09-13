// Office adapter-construction — the construction/CDE vocabulary (OFF-021).
//
// THE reference construction adapter's identity surface, in strictly GENERIC
// vocabulary (freeze A6 + the plan's provider-vocabulary rule): the adapter
// family is 'construction-cde' (a construction common-data-environment
// family), the fixture system is 'cde-instance-01', and the provider object
// kinds are the generic construction object family — document, rfi,
// change-event, observation. No real vendor name appears anywhere in this
// package (the boundary test enforces the ban); swapping this adapter for a
// concrete vendor integration means a sibling package owning the real wire
// formats and names, over the SAME @office/adapters-sdk contract.
//
// The OBJECT MAPPING TABLE is this package's heart (the A6/A11 discipline):
// for each provider object kind, the canonical entity kind it translates
// into, the authz capability the sync authorizes through (deny-by-default,
// declared vocabulary), and the LANDED canonical command names proposed for
// created/updated/deleted observations. The adapter NEVER invents canonical
// semantics: every command name below exists in a merged domain package, and
// the one provider transition with no landed canonical command (a withdrawn
// change event — the contracts domain models change events as append-only)
// maps to NOTHING and fails closed in the translator rather than improvising
// a semantic that does not exist.
//
// Construction of typed literals goes through the landed total parsers on the
// trusted path (parseEntityKind/parseCommandName throw loud TypeErrors on
// invalid literals — the fake-provider idiom), and the capabilities
// declaration is validated through the SDK's own fail-closed parser so the
// table and the AdapterCapabilities value can never drift apart.
import { parseCommandName, parseEntityKind } from '@office/contracts';
import type { CommandName, EntityKind } from '@office/contracts';
import {
  adapterKind,
  parseAdapterCapabilities,
  parseAdapterObjectCapability,
  providerObjectKind,
  providerSystemId,
} from '@office/adapters-sdk';
import type {
  AdapterCapabilities,
  AdapterKind,
  AdapterObjectCapability,
  ProviderObjectKind,
  ProviderSystemId,
} from '@office/adapters-sdk';

// The authz Capability type, reached through the SDK's re-exported contract
// surface (AdapterObjectCapability['capability']) — this package imports
// exactly @office/adapters-sdk, @office/contracts, and @office/domain-kernel,
// never @office/authz directly (the boundary test enforces it).
type Capability = AdapterObjectCapability['capability'];

/** The construction/CDE adapter family kind (generic vocabulary, no vendor). */
export const CONSTRUCTION_ADAPTER_KIND: AdapterKind = adapterKind('construction-cde');

/** The provider system the reference fixture syncs against. */
export const CONSTRUCTION_SYSTEM_ID: ProviderSystemId = providerSystemId('cde-instance-01');

/** Provider object kind: a controlled document (with revision history). */
export const DOCUMENT_OBJECT_KIND: ProviderObjectKind = providerObjectKind('document');
/** Provider object kind: a request for information (RFI). */
export const RFI_OBJECT_KIND: ProviderObjectKind = providerObjectKind('rfi');
/** Provider object kind: a proposed change event on a contract. */
export const CHANGE_EVENT_OBJECT_KIND: ProviderObjectKind = providerObjectKind('change-event');
/** Provider object kind: a field observation (daily-report style capture). */
export const OBSERVATION_OBJECT_KIND: ProviderObjectKind = providerObjectKind('observation');

/** All object kinds the construction adapter declares, in declaration order. */
export const CONSTRUCTION_OBJECT_KINDS: readonly ProviderObjectKind[] = [
  DOCUMENT_OBJECT_KIND,
  RFI_OBJECT_KIND,
  CHANGE_EVENT_OBJECT_KIND,
  OBSERVATION_OBJECT_KIND,
];

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

/** Canonical kind of a controlled document (landed documents domain). */
export const DOCUMENT_CANONICAL_KIND: EntityKind = trustedEntityKind('document');
/** Canonical kind of an RFI (landed field domain: the issue aggregate). */
export const RFI_CANONICAL_KIND: EntityKind = trustedEntityKind('field-issue');
/** Canonical kind of a change event (landed contracts domain). */
export const CHANGE_EVENT_CANONICAL_KIND: EntityKind = trustedEntityKind('change-event');
/** Canonical kind of an observation (landed field domain: the event aggregate). */
export const OBSERVATION_CANONICAL_KIND: EntityKind = trustedEntityKind('field-event');

// ---- the landed canonical command vocabulary this adapter proposes --------
// documents domain: documents.registerDocument / attachRevision / archiveDocument
export const DOCUMENT_CREATE_COMMAND: CommandName = trustedCommandName(
  'documents.registerDocument',
);
export const DOCUMENT_UPDATE_COMMAND: CommandName = trustedCommandName(
  'documents.attachRevision',
);
export const DOCUMENT_DELETE_COMMAND: CommandName = trustedCommandName(
  'documents.archiveDocument',
);
// field domain (issue aggregate): field.raiseIssue / commentOnIssue / resolveIssue
export const RFI_CREATE_COMMAND: CommandName = trustedCommandName('field.raiseIssue');
export const RFI_UPDATE_COMMAND: CommandName = trustedCommandName('field.commentOnIssue');
export const RFI_DELETE_COMMAND: CommandName = trustedCommandName('field.resolveIssue');
// contracts domain (change events): contracts.raiseChangeEvent / linkChangeReferences
export const CHANGE_EVENT_CREATE_COMMAND: CommandName = trustedCommandName(
  'contracts.raiseChangeEvent',
);
export const CHANGE_EVENT_UPDATE_COMMAND: CommandName = trustedCommandName(
  'contracts.linkChangeReferences',
);
// field domain (event aggregate): field.captureFieldEvent / attachFieldEventEvidence /
// resolveFieldEvent
export const OBSERVATION_CREATE_COMMAND: CommandName = trustedCommandName(
  'field.captureFieldEvent',
);
export const OBSERVATION_UPDATE_COMMAND: CommandName = trustedCommandName(
  'field.attachFieldEventEvidence',
);
export const OBSERVATION_DELETE_COMMAND: CommandName = trustedCommandName(
  'field.resolveFieldEvent',
);

/**
 * One declared object-kind surface: the provider object kind, the canonical
 * entity kind it maps into, the capability the sync authorizes through, and
 * the landed canonical commands proposed for each change kind. `deleteCommand`
 * is null when NO landed canonical command expresses the provider's deletion
 * semantics — the translator then fails closed (never invents semantics).
 */
export interface ConstructionObjectMapping {
  readonly objectKind: ProviderObjectKind;
  readonly canonicalKind: EntityKind;
  readonly capability: Capability;
  readonly createCommand: CommandName;
  readonly updateCommand: CommandName;
  readonly deleteCommand: CommandName | null;
}

/**
 * THE object mapping table (A6: external systems are adapters; A11: they sync
 * INTO the canonical graph — everything below maps to LANDED canonical
 * commands). The withdrawn-change-event gap is the single documented null
 * deletion mapping. Capability literals are validated through the SDK's
 * fail-closed parser (which enforces the authz declared vocabulary), so an
 * undeclared capability is a loud module defect, never a silent drift.
 */
const RAW_CONSTRUCTION_OBJECT_MAPPINGS = [
  {
    objectKind: DOCUMENT_OBJECT_KIND,
    canonicalKind: DOCUMENT_CANONICAL_KIND,
    capability: 'documents.write',
    createCommand: DOCUMENT_CREATE_COMMAND,
    updateCommand: DOCUMENT_UPDATE_COMMAND,
    deleteCommand: DOCUMENT_DELETE_COMMAND,
  },
  {
    objectKind: RFI_OBJECT_KIND,
    canonicalKind: RFI_CANONICAL_KIND,
    capability: 'work.write',
    createCommand: RFI_CREATE_COMMAND,
    updateCommand: RFI_UPDATE_COMMAND,
    deleteCommand: RFI_DELETE_COMMAND,
  },
  {
    objectKind: CHANGE_EVENT_OBJECT_KIND,
    canonicalKind: CHANGE_EVENT_CANONICAL_KIND,
    capability: 'contracts.write',
    createCommand: CHANGE_EVENT_CREATE_COMMAND,
    updateCommand: CHANGE_EVENT_UPDATE_COMMAND,
    deleteCommand: null, // no landed canonical command withdraws a change event
  },
  {
    objectKind: OBSERVATION_OBJECT_KIND,
    canonicalKind: OBSERVATION_CANONICAL_KIND,
    capability: 'work.write',
    createCommand: OBSERVATION_CREATE_COMMAND,
    updateCommand: OBSERVATION_UPDATE_COMMAND,
    deleteCommand: OBSERVATION_DELETE_COMMAND,
  },
] as const;

export const CONSTRUCTION_OBJECT_MAPPINGS: readonly ConstructionObjectMapping[] =
  RAW_CONSTRUCTION_OBJECT_MAPPINGS.map((raw) => {
    const parsed = parseAdapterObjectCapability({
      objectKind: raw.objectKind,
      canonicalKind: raw.canonicalKind,
      capability: raw.capability,
    });
    if (!parsed.ok) {
      throw new TypeError(
        `invalid construction object mapping for '${raw.objectKind}': ${JSON.stringify(parsed.error)}`,
      );
    }
    return {
      objectKind: parsed.value.objectKind,
      canonicalKind: parsed.value.canonicalKind,
      capability: parsed.value.capability,
      createCommand: raw.createCommand,
      updateCommand: raw.updateCommand,
      deleteCommand: raw.deleteCommand,
    } satisfies ConstructionObjectMapping;
  });

/**
 * The AdapterCapabilities value the adapter declares — composed FROM the
 * mapping table and validated through the SDK's own fail-closed parser (the
 * parser re-validates object-kind grammar, canonical-kind grammar, and the
 * authz declared-capability vocabulary), so the table and the declared
 * capabilities can never drift apart. A violation is a module defect (loud
 * TypeError on the trusted path).
 */
export const CONSTRUCTION_CAPABILITIES: AdapterCapabilities = (() => {
  const parsed = parseAdapterCapabilities({
    objectKinds: CONSTRUCTION_OBJECT_MAPPINGS.map((mapping) => ({
      objectKind: mapping.objectKind,
      canonicalKind: mapping.canonicalKind,
      capability: mapping.capability,
    })),
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid construction capabilities: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
})();

/** The capability names the adapter actor must hold (policy/test wiring). */
export const CONSTRUCTION_CAPABILITY_NAMES: readonly Capability[] =
  CONSTRUCTION_OBJECT_MAPPINGS.map((mapping) => mapping.capability);

/**
 * The declared mapping of one provider object kind, or a typed
 * invariant-violation when the adapter does not declare that kind (fail
 * closed — an undeclared kind is never silently translated).
 */
export function constructionObjectMappingOf(
  objectKind: ProviderObjectKind,
): ConstructionObjectMapping | null {
  return (
    CONSTRUCTION_OBJECT_MAPPINGS.find((mapping) => mapping.objectKind === objectKind) ?? null
  );
}
