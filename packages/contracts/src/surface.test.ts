import { describe, expect, it } from 'vitest';
import * as contracts from './index';

// OFF-002 contracts — public surface tests. The runtime (value) surface is
// pinned exactly; type-only exports are exercised by the typed imports used
// across this suite and enforced by `pnpm typecheck`.

const EXPECTED_VALUE_EXPORTS = [
  // parse plumbing
  'parseOk',
  'parseFail',
  // identity
  'KNOWN_ID_VERSIONS',
  'formatEntityId',
  'formatTenantId',
  'formatProjectId',
  'parseEntityId',
  'parseTenantId',
  'parseProjectId',
  'parseEntityKind',
  'isEntityId',
  'isTenantId',
  'isProjectId',
  'isEntityKind',
  // scope
  'parseScope',
  'isScope',
  // actor
  'parseActor',
  'isActor',
  // time
  'parseTimestamp',
  'isTimestamp',
  'formatTimestamp',
  // versioning
  'KNOWN_SCHEMA_VERSIONS',
  'CURRENT_SCHEMA_VERSION',
  'parseSchemaVersion',
  'isKnownSchemaVersion',
  // pagination
  'parsePage',
  'parsePageCursor',
  'isPage',
  'isPageCursor',
  // events
  'parseEventName',
  'isEventName',
  'parseCorrelationId',
  'isCorrelationId',
  'parseCausationId',
  'isCausationId',
  'parseCausality',
  'isCausality',
  'parseEntityRef',
  'isEntityRef',
  'parseEntityRefs',
  'isEntityRefs',
  'parseDomainEventEnvelope',
  'isDomainEventEnvelope',
  // commands
  'parseCommandName',
  'isCommandName',
  'parseIdempotencyKey',
  'isIdempotencyKey',
  'parseCommandEnvelope',
  'isCommandEnvelope',
  // errors
  'parseApiError',
  'isApiError',
];

describe('public surface (index)', () => {
  it('exports exactly the documented value surface', () => {
    expect(Object.keys(contracts).sort()).toEqual([...EXPECTED_VALUE_EXPORTS].sort());
  });

  it('re-exports the schema version constants', () => {
    expect(contracts.CURRENT_SCHEMA_VERSION).toBe('1.0.0');
    expect(contracts.KNOWN_SCHEMA_VERSIONS).toStrictEqual(['1.0.0']);
    expect(contracts.KNOWN_ID_VERSIONS).toStrictEqual(['v1']);
  });
});
