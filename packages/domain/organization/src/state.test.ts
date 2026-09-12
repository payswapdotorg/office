import { describe, expect, it } from 'vitest';
import { formatEntityId, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  ORGANIZATION_INVARIANTS,
  archiveOrganizationState,
  createOrganizationState,
  updateOrganizationState,
} from './state';
import type { OrganizationState } from './state';

// OFF-007 organization domain — aggregate state, invariants, and pure
// lifecycle transitions. Everything is deterministic: fixed canonical ids,
// fixed timestamps, no I/O.

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-12T11:30:00.000Z'));

const ORGANIZATION_ID = formatEntityId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});

const scopeTenant: Scope = { kind: 'tenant', tenantId: TENANT_A };

const baseState = (): OrganizationState =>
  unwrap(
    createOrganizationState(
      { organizationId: ORGANIZATION_ID, name: 'BuildCo', now: NOW_1 },
      scopeTenant,
    ),
  );

describe('organization state creation', () => {
  it('creates an active, tenant-scoped organization at version 1', () => {
    const state = baseState();
    expect(state.entityKind).toBe('organization');
    expect(state.entityId).toBe(ORGANIZATION_ID);
    expect(state.scope).toStrictEqual(scopeTenant);
    expect(state.version).toBe(INITIAL_AGGREGATE_VERSION);
    expect(state.name).toBe('BuildCo');
    expect(state.status).toBe('active');
    expect(state.archivedAt).toBeNull();
    expect(state.createdAt).toBe(NOW_1);
    expect(state.updatedAt).toBe(NOW_1);
    expect(state.extensionMetadata).toStrictEqual({});
  });

  it('keeps the given extension metadata', () => {
    const state = unwrap(
      createOrganizationState(
        {
          organizationId: ORGANIZATION_ID,
          name: 'BuildCo',
          extensionMetadata: { source: 'onboarding' },
          now: NOW_1,
        },
        scopeTenant,
      ),
    );
    expect(state.extensionMetadata).toStrictEqual({ source: 'onboarding' });
  });
});

describe('organization state invariants', () => {
  it('rejects an empty name', () => {
    const result = createOrganizationState(
      { organizationId: ORGANIZATION_ID, name: '', now: NOW_1 },
      scopeTenant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('organization-name-nonempty');
  });

  it('rejects a name longer than 200 characters', () => {
    const result = createOrganizationState(
      { organizationId: ORGANIZATION_ID, name: 'x'.repeat(201), now: NOW_1 },
      scopeTenant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('organization-name-nonempty');
  });

  it('rejects an archived status without a timestamp (invariant pairing)', () => {
    const state: OrganizationState = {
      ...baseState(),
      status: 'archived',
      archivedAt: null,
    };
    expect(
      ORGANIZATION_INVARIANTS.find((invariant) => invariant.name === 'organization-archive-timestamp-pairs-with-status')
        ?.holds(state),
    ).toBe(false);
  });

  it('rejects a project scope (organizations are tenant-level)', () => {
    const state: OrganizationState = {
      ...baseState(),
      scope: {
        kind: 'project',
        tenantId: TENANT_A,
        projectId: unwrap(
          parseProjectId('office-prj-v1-4f9d2c81a7e34b5d90c1f2e3a4b5c6d7'),
        ),
      },
    };
    expect(
      ORGANIZATION_INVARIANTS.find((invariant) => invariant.name === 'organization-is-tenant-scoped')
        ?.holds(state),
    ).toBe(false);
  });
});

describe('organization update transition', () => {
  it('applies a rename with version + 1 and a fresh updatedAt', () => {
    const next = unwrap(updateOrganizationState(baseState(), { name: 'BuildCo Group' }, NOW_2));
    expect(next.name).toBe('BuildCo Group');
    expect(next.version).toBe(2);
    expect(next.updatedAt).toBe(NOW_2);
    expect(next.status).toBe('active');
  });

  it('replaces extension metadata when supplied', () => {
    const next = unwrap(
      updateOrganizationState(baseState(), { extensionMetadata: { tier: 'enterprise' } }, NOW_2),
    );
    expect(next.extensionMetadata).toStrictEqual({ tier: 'enterprise' });
    expect(next.name).toBe('BuildCo');
  });

  it('rejects updates of an archived organization (immutable lifecycle)', () => {
    const archived = unwrap(archiveOrganizationState(baseState(), NOW_2));
    const result = updateOrganizationState(archived, { name: 'Late rename' }, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('organization-update-requires-active');
    }
  });
});

describe('organization archive transition', () => {
  it('archives an active organization: status, timestamp, version + 1', () => {
    const next = unwrap(archiveOrganizationState(baseState(), NOW_2));
    expect(next.status).toBe('archived');
    expect(next.archivedAt).toBe(NOW_2);
    expect(next.updatedAt).toBe(NOW_2);
    expect(next.version).toBe(2);
  });

  it('rejects archiving an already archived organization (one-way)', () => {
    const archived = unwrap(archiveOrganizationState(baseState(), NOW_2));
    const result = archiveOrganizationState(archived, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('organization-archive-requires-active');
    }
  });
});

describe('typed failure surface', () => {
  it('transitions return DomainError values, never throw', () => {
    const archived = unwrap(archiveOrganizationState(baseState(), NOW_2));
    const failure = archiveOrganizationState(archived, NOW_2);
    if (!failure.ok) {
      const error: DomainError = failure.error;
      expect(error.kind).toBe('domain-error');
      expect(error.code).toBe('invariant-violation');
    } else {
      throw new Error('expected a typed failure');
    }
  });
});
