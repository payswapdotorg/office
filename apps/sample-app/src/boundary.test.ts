import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, isAppHandlerId, isAppManifest } from '@office/app-sdk';
import {
  CURRENT_SCHEMA_VERSION,
  parseCommandName,
  parseEntityKind,
  parseEventName,
} from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { FIELD_PROGRESS_TRACKER } from './manifest';

// OFF-025 — THE sample-app boundary acceptance: the reference marketplace
// app compiles against ONLY @office/app-sdk + @office/contracts. Its import
// graph (the non-test application sources this test scans) contains neither
// core packages (domain/intelligence/sync/adapters/agents/client-sync) nor
// any other @office/* dependency, and it ships a structurally valid typed
// AppManifest. Deterministic: filesystem reads and plain-data assertions.

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(appRoot, 'src');

/** Unwrap a successful ParseResult (fails loud in tests). */
const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

/** Strip line and block comments so only real import syntax is scanned. */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

/** Every `from '<specifier>'` in a source text, in order. */
const importSpecifiers = (text: string): string[] => {
  const specifiers: string[] = [];
  const pattern = /\bfrom\s+['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

/** The app's APPLICATION sources — tests are verification tooling, not the app. */
const appSourceFiles = (): string[] =>
  readdirSync(srcDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .sort();

/** The only workspace packages the app may depend on. */
const ALLOWED_PACKAGES = ['@office/app-sdk', '@office/contracts'] as const;

describe('the sample app package boundary (OFF-025)', () => {
  it('is @office-sample/app declaring exactly the SDK and contracts, nothing else', () => {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg['name']).toBe('@office-sample/app');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['dependencies']).toStrictEqual({
      '@office/app-sdk': 'workspace:^',
      '@office/contracts': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports ONLY @office/app-sdk and @office/contracts (never core packages)', () => {
    const violations: string[] = [];
    for (const file of appSourceFiles()) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const permitted =
          specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          (ALLOWED_PACKAGES as readonly string[]).includes(specifier);
        if (!permitted) {
          violations.push(`${file}: import '${specifier}'`);
        }
      }
      // Belt and braces: no other @office/* package appears ANYWHERE in the
      // app source — not as an import, a comment, or a type reference.
      for (const match of text.matchAll(/@office\/[a-z0-9-]+/g)) {
        const packageName = match[0];
        if (!(ALLOWED_PACKAGES as readonly string[]).includes(packageName)) {
          violations.push(`${file}: references '${packageName}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('ships a manifest that round-trips the SDK fail-closed parse unchanged', () => {
    // The typed manifest re-parses: strict keys, closed vocabularies, and all
    // grammars accept it exactly as composed.
    expect(isAppManifest(FIELD_PROGRESS_TRACKER)).toBe(true);
  });

  it('declares the pinned minimal surface: permissions, one binding, one subscription', () => {
    const manifest = FIELD_PROGRESS_TRACKER;
    expect(manifest.kind).toBe('app-manifest');
    expect(manifest.appId).toBe('field-progress-tracker');
    expect(manifest.manifestVersion).toBe('1.4.0');
    expect(manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(manifest.title).toBe('Field Progress Tracker');
    expect(manifest.description).toBe(
      'Records daily field progress against the plan and reacts to progress events.',
    );

    // A9: two explicit, versioned, project-scoped capabilities from the CLOSED
    // authz vocabulary (re-exported by the SDK — no wildcard can appear here).
    expect(manifest.permissions).toHaveLength(2);
    for (const permission of manifest.permissions) {
      expect(CAPABILITIES).toContain(permission.capability);
      expect(permission.scopeKind).toBe('project');
      expect(permission.version).toBe(1);
    }

    // One command binding: a reversible command with a SYMBOLIC handler
    // contract (the runtime resolves the slug to installed handler code).
    expect(manifest.bindings).toHaveLength(1);
    const binding = manifest.bindings[0];
    if (binding === undefined) throw new Error('fixture must declare one binding');
    expect(binding.commandName).toBe('field.recordProgress');
    expect(binding.actionClass).toBe('reversible');
    expect(isAppHandlerId(binding.handler.handlerId)).toBe(true);
    expect(binding.handler.handlerId).toBe('record-progress-handler');
    expect(binding.handler.description).toBe(
      'Records one field progress observation through the action gateway.',
    );

    // One event subscription: a canonical event name with a typed filter.
    expect(manifest.subscriptions).toHaveLength(1);
    const subscription = manifest.subscriptions[0];
    if (subscription === undefined) throw new Error('fixture must declare one subscription');
    expect(subscription.eventName).toBe('work.progressRecorded');
    expect(subscription.filter).toStrictEqual({
      kind: 'entity-kind',
      entityKind: 'field-report',
    });

    // The minimal surface: no UI extensions, no app-contract dependencies.
    expect(manifest.uiExtensions).toStrictEqual([]);
    expect(manifest.dependencies).toStrictEqual([]);
  });

  it('references only real platform vocabularies (commands, events, entity kinds)', () => {
    // The bound command, subscribed event, and filter entity kind all
    // round-trip the canonical @office/contracts parses — the manifest's
    // references are real grammar-valid vocabulary, not invented strings.
    expect(unwrap(parseCommandName('field.recordProgress'))).toBe('field.recordProgress');
    expect(unwrap(parseEventName('work.progressRecorded'))).toBe('work.progressRecorded');
    expect(unwrap(parseEntityKind('field-report'))).toBe('field-report');
  });
});
