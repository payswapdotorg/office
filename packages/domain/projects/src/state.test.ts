import { describe, expect, it } from 'vitest';
import { formatProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  PROJECT_INVARIANTS,
  archiveProjectState,
  createProjectState,
  updateProjectState,
} from './state';
import type { ProjectState } from './state';

// OFF-007 project domain — aggregate state, invariants, and pure lifecycle
// transitions. Everything is deterministic: fixed canonical ids, fixed
// timestamps, no I/O.

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-12T11:30:00.000Z'));

const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});

const ownScope: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID };

const baseState = (): ProjectState =>
  unwrap(
    createProjectState(
      { projectId: PROJECT_ID, name: 'Riverside Tower', now: NOW_1 },
      TENANT_A,
    ),
  );

describe('project state creation', () => {
  it('creates an active project owning its own project scope at version 1', () => {
    const state = baseState();
    expect(state.entityKind).toBe('project');
    expect(state.entityId).toBe(PROJECT_ID);
    // A project IS its own second boundary: the owning scope points at the
    // aggregate itself (freeze A12).
    expect(state.scope).toStrictEqual(ownScope);
    expect(state.version).toBe(INITIAL_AGGREGATE_VERSION);
    expect(state.name).toBe('Riverside Tower');
    expect(state.status).toBe('active');
    expect(state.archivedAt).toBeNull();
    expect(state.createdAt).toBe(NOW_1);
    expect(state.updatedAt).toBe(NOW_1);
    expect(state.extensionMetadata).toStrictEqual({});
  });

  it('keeps the given extension metadata', () => {
    const state = unwrap(
      createProjectState(
        {
          projectId: PROJECT_ID,
          name: 'Riverside Tower',
          extensionMetadata: { code: 'RT-01' },
          now: NOW_1,
        },
        TENANT_A,
      ),
    );
    expect(state.extensionMetadata).toStrictEqual({ code: 'RT-01' });
  });
});

describe('project state invariants', () => {
  it('rejects an empty name', () => {
    const result = createProjectState(
      { projectId: PROJECT_ID, name: '', now: NOW_1 },
      TENANT_A,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('project-name-nonempty');
  });

  it('rejects a name longer than 200 characters', () => {
    const result = createProjectState(
      { projectId: PROJECT_ID, name: 'x'.repeat(201), now: NOW_1 },
      TENANT_A,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('project-name-nonempty');
  });

  it('rejects an archived status without a timestamp (invariant pairing)', () => {
    const state: ProjectState = {
      ...baseState(),
      status: 'archived',
      archivedAt: null,
    };
    expect(
      PROJECT_INVARIANTS.find((invariant) => invariant.name === 'project-archive-timestamp-pairs-with-status')
        ?.holds(state),
    ).toBe(false);
  });

  it('rejects a foreign project scope (a project owns exactly its own scope, A12)', () => {
    const state: ProjectState = {
      ...baseState(),
      scope: {
        kind: 'project',
        tenantId: TENANT_A,
        projectId: formatProjectId({ version: 'v1', opaque: '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7' }),
      },
    };
    expect(
      PROJECT_INVARIANTS.find((invariant) => invariant.name === 'project-owns-its-project-scope')
        ?.holds(state),
    ).toBe(false);
  });

  it('rejects a tenant scope (a project is project-bound)', () => {
    const state: ProjectState = {
      ...baseState(),
      scope: { kind: 'tenant', tenantId: TENANT_A },
    };
    expect(
      PROJECT_INVARIANTS.find((invariant) => invariant.name === 'project-owns-its-project-scope')
        ?.holds(state),
    ).toBe(false);
  });
});

describe('project update transition', () => {
  it('applies a rename with version + 1 and a fresh updatedAt', () => {
    const next = unwrap(updateProjectState(baseState(), { name: 'Riverside Tower II' }, NOW_2));
    expect(next.name).toBe('Riverside Tower II');
    expect(next.version).toBe(2);
    expect(next.updatedAt).toBe(NOW_2);
    expect(next.status).toBe('active');
    expect(next.scope).toStrictEqual(ownScope);
  });

  it('replaces extension metadata when supplied', () => {
    const next = unwrap(
      updateProjectState(baseState(), { extensionMetadata: { phase: 'design' } }, NOW_2),
    );
    expect(next.extensionMetadata).toStrictEqual({ phase: 'design' });
    expect(next.name).toBe('Riverside Tower');
  });

  it('rejects updates of an archived project (immutable lifecycle)', () => {
    const archived = unwrap(archiveProjectState(baseState(), NOW_2));
    const result = updateProjectState(archived, { name: 'Late rename' }, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('project-update-requires-active');
    }
  });
});

describe('project archive transition', () => {
  it('archives an active project: status, timestamp, version + 1', () => {
    const next = unwrap(archiveProjectState(baseState(), NOW_2));
    expect(next.status).toBe('archived');
    expect(next.archivedAt).toBe(NOW_2);
    expect(next.updatedAt).toBe(NOW_2);
    expect(next.version).toBe(2);
    expect(next.scope).toStrictEqual(ownScope);
  });

  it('rejects archiving an already archived project (one-way)', () => {
    const archived = unwrap(archiveProjectState(baseState(), NOW_2));
    const result = archiveProjectState(archived, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('project-archive-requires-active');
    }
  });
});

describe('typed failure surface', () => {
  it('transitions return DomainError values, never throw', () => {
    const archived = unwrap(archiveProjectState(baseState(), NOW_2));
    const failure = archiveProjectState(archived, NOW_2);
    if (!failure.ok) {
      const error: DomainError = failure.error;
      expect(error.kind).toBe('domain-error');
      expect(error.code).toBe('invariant-violation');
    } else {
      throw new Error('expected a typed failure');
    }
  });
});
