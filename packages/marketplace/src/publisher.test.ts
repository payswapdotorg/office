import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '@office/contracts';
import { parseAppId } from '@office/app-sdk';
import {
  isPublisher,
  isPublisherActive,
  isPublisherState,
  mayPublishApp,
  parsePublisher,
  parsePublisherState,
  registerPublisher,
  revokePublisher,
} from './publisher';
import { adminActor, operatorActor, PROGRESS_APP_ID, T0, TENANT_A, unwrap } from './test-support';

// OFF-027 marketplace — publisher registration & revocation: the
// tenant-scoped record, the terminal idempotent revocation, and the
// fail-closed parse (strict keys, state/provenance consistency).
describe('marketplace publishers (OFF-027)', () => {
  const apps = [PROGRESS_APP_ID] as const;

  const publisher = () =>
    registerPublisher({
      tenantId: TENANT_A,
      displayName: 'publisher-01',
      apps: [...apps],
      registeredAt: T0,
      registeredBy: adminActor(),
    });

  it('registers an active publisher with a derived id and no revocation fields', () => {
    const record = publisher();
    expect(record.kind).toBe('marketplace-publisher');
    expect(record.state).toBe('active');
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.displayName).toBe('publisher-01');
    expect(record.apps).toEqual([PROGRESS_APP_ID]);
    expect(record.revokedAt).toBeNull();
    expect(record.revokedBy).toBeNull();
    expect(record.publisherId.startsWith('office-pub-v1-')).toBe(true);
  });

  it('re-registering the same logical key derives the same publisher id', () => {
    expect(publisher().publisherId).toBe(publisher().publisherId);
  });

  it('revokes terminally and idempotently, preserving the original provenance', () => {
    const record = publisher();
    const revoked = revokePublisher(record, {
      at: unwrap(parseTimestamp('2026-09-12T11:00:00.000Z')),
      by: operatorActor(),
    });
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokedAt).toBe('2026-09-12T11:00:00.000Z');
    expect(revoked.revokedBy).toEqual(operatorActor());
    const again = revokePublisher(revoked, {
      at: unwrap(parseTimestamp('2026-09-12T12:00:00.000Z')),
      by: adminActor(),
    });
    expect(again).toBe(revoked);
    expect(again.revokedAt).toBe('2026-09-12T11:00:00.000Z');
    expect(again.revokedBy).toEqual(operatorActor());
  });

  it('isPublisherActive / mayPublishApp gate on state and the declared app set', () => {
    const record = publisher();
    expect(isPublisherActive(record)).toBe(true);
    expect(mayPublishApp(record, PROGRESS_APP_ID)).toBe(true);
    const other = unwrap(parseAppId('timesheet-logger'));
    expect(mayPublishApp(record, other)).toBe(false);
    const revoked = revokePublisher(record, {
      at: T0,
      by: operatorActor(),
    });
    expect(isPublisherActive(revoked)).toBe(false);
    expect(mayPublishApp(revoked, PROGRESS_APP_ID)).toBe(false);
  });

  it('parses a publisher record round-trip and rejects malformed ones', () => {
    const record = publisher();
    expect(unwrap(parsePublisher(record))).toEqual(record);
    expect(isPublisher(record)).toBe(true);
    expect(parsePublisher({ ...record, extra: 1 }).ok).toBe(false);
    expect(parsePublisher({ ...record, displayName: '' }).ok).toBe(false);
    expect(parsePublisher({ ...record, state: 'banned' }).ok).toBe(false);
    expect(parsePublisher({ ...record, tenantId: 'tenant-a' }).ok).toBe(false);
    expect(parsePublisher({ ...record, apps: [] }).ok).toBe(false);
    expect(parsePublisher({ ...record, apps: [PROGRESS_APP_ID, PROGRESS_APP_ID] }).ok).toBe(false);
    expect(parsePublisher(null).ok).toBe(false);
    expect(parsePublisher('publisher').ok).toBe(false);
  });

  it('rejects state/provenance inconsistencies fail-closed', () => {
    const record = publisher();
    const revoked = revokePublisher(record, { at: T0, by: operatorActor() });
    // active record carrying revocation provenance
    expect(parsePublisher({ ...record, revokedAt: T0, revokedBy: operatorActor() }).ok).toBe(false);
    // revoked record missing revocation provenance
    const { revokedAt: _at, revokedBy: _by, ...stripped } = revoked;
    void _at;
    void _by;
    expect(parsePublisher({ ...stripped, revokedAt: null, revokedBy: null }).ok).toBe(false);
  });

  it('parses publisher states fail-closed', () => {
    expect(unwrap(parsePublisherState('active'))).toBe('active');
    expect(unwrap(parsePublisherState('revoked'))).toBe('revoked');
    expect(isPublisherState('pending')).toBe(false);
    expect(parsePublisherState('pending').ok).toBe(false);
    expect(parsePublisherState(1).ok).toBe(false);
  });

  it('registerPublisher throws loudly on an invalid logical key', () => {
    expect(() =>
      registerPublisher({
        tenantId: TENANT_A,
        displayName: '',
        apps: [...apps],
        registeredAt: T0,
        registeredBy: adminActor(),
      }),
    ).toThrow(TypeError);
    expect(() =>
      registerPublisher({
        tenantId: TENANT_A,
        displayName: 'publisher-01',
        apps: [],
        registeredAt: T0,
        registeredBy: adminActor(),
      }),
    ).toThrow(TypeError);
  });
});
