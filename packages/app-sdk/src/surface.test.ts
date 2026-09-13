import { describe, expect, it } from 'vitest';
import * as appSdk from './index';

// OFF-025 app-sdk — public surface tests. The runtime (value) surface is
// pinned exactly; type-only exports are exercised by the typed imports used
// across this suite and enforced by `pnpm typecheck`.

const EXPECTED_VALUE_EXPORTS = [
  // identity & versioning
  'APP_HANDLER_ID_GRAMMAR',
  'APP_ID_GRAMMAR',
  'APP_VERSION_GRAMMAR',
  'PERMISSION_ID_GRAMMAR',
  'PERMISSION_VERSION_GRAMMAR',
  'VERSION_RANGE_GRAMMAR',
  'VIEW_ID_GRAMMAR',
  'appId',
  'appHandlerId',
  'appVersion',
  'compareAppVersions',
  'formatPermissionId',
  'isAppHandlerId',
  'isAppId',
  'isAppVersion',
  'isPermissionId',
  'isPermissionVersion',
  'isVersionRange',
  'isViewId',
  'parseAppHandlerId',
  'parseAppId',
  'parseAppVersion',
  'parsePermissionId',
  'parsePermissionVersion',
  'parseVersionRange',
  'parseViewId',
  'permissionIdOf',
  'satisfiesVersion',
  'versionRange',
  'viewId',
  // permissions (the A9 lifecycle)
  'PERMISSION_GRAMMAR',
  'PERMISSION_SCOPE_KIND_GRAMMAR',
  'PERMISSION_SPEC_GRAMMAR',
  'grantPermission',
  'isPermission',
  'isPermissionActive',
  'isPermissionScopeKind',
  'isPermissionSpec',
  'parsePermission',
  'parsePermissionScopeKind',
  'parsePermissionSpec',
  'revokePermission',
  'upgradePermission',
  // command bindings
  'APP_HANDLER_GRAMMAR',
  'BINDABLE_ACTION_CLASSES',
  'COMMAND_BINDING_GRAMMAR',
  'isAppHandler',
  'isCommandBinding',
  'parseAppHandler',
  'parseCommandBinding',
  // event subscriptions
  'EVENT_SUBSCRIPTION_FILTER_GRAMMAR',
  'EVENT_SUBSCRIPTION_GRAMMAR',
  'isEventSubscription',
  'isEventSubscriptionFilter',
  'parseEventSubscription',
  'parseEventSubscriptionFilter',
  // the extension UI contract
  'EXTENSION_POINT_GRAMMAR',
  'EXTENSION_POINTS',
  'UI_EXTENSION_GRAMMAR',
  'VIEW_DESCRIPTOR_GRAMMAR',
  'VIEW_ELEMENT_GRAMMAR',
  'VIEW_MAX_ELEMENTS',
  'isExtensionPointId',
  'isUiExtension',
  'isViewDescriptor',
  'isViewElement',
  'parseExtensionPointId',
  'parseUiExtension',
  'parseViewDescriptor',
  // the manifest model
  'APP_DEPENDENCY_GRAMMAR',
  'APP_MANIFEST_GRAMMAR',
  'appManifest',
  'isAppDependency',
  'isAppManifest',
  'parseAppDependency',
  'parseAppManifest',
  // cross-reference validation
  'actionDescriptorSource',
  'reviewAppManifest',
  'validateAppManifest',
  // the in-memory registry
  'createInMemoryAppRegistry',
  // the closed capability vocabulary (authz re-export)
  'CAPABILITIES',
  'capability',
  'isCapability',
  'parseCapability',
];

describe('public surface (index)', () => {
  it('exports exactly the documented value surface', () => {
    expect(Object.keys(appSdk).sort()).toEqual([...EXPECTED_VALUE_EXPORTS].sort());
  });

  it('re-exports the closed capability and action-class vocabularies', () => {
    expect(appSdk.CAPABILITIES).toContain('work.read');
    expect(appSdk.CAPABILITIES).toContain('work.write');
    expect(appSdk.capability('work.write')).toBe('work.write');
    expect(appSdk.BINDABLE_ACTION_CLASSES).toStrictEqual([
      'read',
      'reversible',
      'approval-required',
    ]);
    expect(appSdk.EXTENSION_POINTS.length).toBeGreaterThan(0);
  });
});
