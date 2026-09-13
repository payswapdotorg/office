import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope } from '@office/contracts';
import type { CommandEnvelope } from '@office/contracts';
import { coordinateOf, sourceCorrelationId, syncIdempotencyKey } from '@office/adapters-sdk';
import type { AdapterJsonObject } from '@office/adapters-sdk';
import * as construction from './index';
import {
  CONTRACT_ID,
  NOW_1,
  PROJECT_ID,
  TENANT_A,
  USER_ID,
  constructionAuthorization,
  engine,
  entity,
  unwrap,
  version,
} from './test-support';

// OFF-021 adapter-construction — package boundary self-gate. These checks
// mirror the work item's acceptance boundary — "no provider types in core":
// @office/adapter-construction declares exactly three workspace dependencies
// (@office/adapters-sdk, @office/contracts, @office/domain-kernel), imports
// nothing else outside the package outside of tests (node builtins allowed —
// crypto digests only in sources), NEVER imports a domain, intelligence,
// sync, actions, workflows, agents, app-sdk, app-runtime, client-sync,
// persistence, events, or authz package, imports nothing under apps/*,
// carries NO provider/vendor vocabulary (strictly generic construction-CDE
// names — 'construction-cde' over document/rfi/change-event/observation
// objects), and performs NO I/O of its own (ports only: no fs, no net, no
// process spawning, no database env, no SQL, no migrations — and no wall
// clock or randomness anywhere: injected clock/id suppliers only).
//
// THE runtime proof at the bottom: the canonical graph is touched ONLY
// through typed command proposals — a full initial ingest over the fixture
// leaves the canonical-state stand-in (owned by the TEST, standing in for
// the runtime's graph) completely untouched, while every artifact that
// would move canonical state is a typed CommandEnvelope over the LANDED
// canonical command vocabulary with SourceRef-derived idempotency keys.
// Deterministic: filesystem reads only.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(packageRoot, 'src');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const listFiles = (dir: string, suffix: string): string[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .sort();

/** Strip line and block comments so only real import/export syntax is scanned. */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const importSpecifiers = (text: string): string[] => {
  const specifiers: string[] = [];
  // Only import/export statement clauses: a bare `from '...'` can also occur
  // inside string literals (error messages), which are not imports. The
  // clause must belong to a statement that begins with the import/export
  // keyword and terminates with `;`.
  const pattern = /\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]\s*;/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

// This package's own canonical name, assembled so the string-literal scans
// cannot match the test's own source.
const ownPackageName = ['@office', '/adapter-construction'].join('');
// The three workspace dependencies the boundary allows (THE rule: the
// Adapter contract + the shared contracts/kernel vocabulary — never a
// domain/intelligence/app package).
const allowedOfficePackages = [
  ['@office', '/adapters-sdk'].join(''),
  ['@office', '/contracts'].join(''),
  ['@office', '/domain-ke', 'rnel'].join(''),
] as const;
// Every OTHER @office/* package is a forbidden import for this adapter: the
// merged domain packages own the canonical semantics, the intelligence/
// actions/workflows/agents/sync packages own the reasoning and execution
// fabric, and the app/client packages own the product surfaces. Adapters
// translate — they do not reach into any of it.
const forbiddenOfficePackages = [
  ['@office', '/domain'].join(''),
  ['@office', '/intelligence'].join(''),
  ['@office', '/sync'].join(''),
  ['@office', '/actions'].join(''),
  ['@office', '/workflows'].join(''),
  ['@office', '/agents'].join(''),
  ['@office', '/app-sdk'].join(''),
  ['@office', '/app-runtime'].join(''),
  ['@office', '/client-sync'].join(''),
  ['@office', '/persistence'].join(''),
  ['@office', '/test-fixtures'].join(''),
  ['@office', '/events'].join(''),
  ['@office', '/authz'].join(''),
];
// The environment variable name persistence wiring would need, assembled so
// the pure-ports scan cannot match the test's own source.
const databaseUrlLiteral = ['DATABASE', '_URL'].join('');

// Provider/vendor vocabulary is assembled from fragments so this scan can
// never match its own source (the acceptance gate forbids those names
// anywhere in this package — the reference fixture uses strictly generic
// construction-CDE vocabulary; a real vendor integration is a sibling
// package owning the real names, over the SAME SDK contract).
const providerVocabulary = new RegExp(
  `\\b(${[
    'pro' + 'core',
    'auto' + 'desk',
    'prim' + 'avera',
    'e' + 'rp',
    'ms' + '-project',
    'p' + '6',
  ].join('|')})\\b`,
  'i',
);

// Node builtins the package's own source may touch: crypto digests only
// (pure sha256 derivations for the webhook signature/checksum conventions).
// Tests may additionally use the fs/path/url builtins this boundary scan
// itself needs.
const SOURCE_NODE_MODULES = new Set(['node:crypto']);
const TEST_NODE_MODULES = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url']);

// The I/O-free determinism scan. Sources: no wall clock, no randomness, no
// Date construction at all. Tests: no wall clock and no randomness either
// (fixtures must be fixed constants).
const wallClockPattern = /(?:Date\s*\.\s*now|Math\s*\.\s*random)/;
const dateConstructionPattern = /new\s+Date\s*\(/;
// Network/process surface scan for sources (imports are covered separately):
// no fetch calls, no process environment, no CommonJS require.
const networkIoPattern = /\bfetch\s*\(|process\s*\.\s*env|\brequire\s*\(/;

const isTestFile = (file: string): boolean => file.endsWith('.test.ts');

describe('adapter-construction package boundary (OFF-021)', () => {
  it('carries the canonical adapter-construction package identity (0.1.0, private, ESM)', () => {
    const pkg = readPackageJson();
    expect(pkg['name']).toBe(ownPackageName);
    expect(pkg['version']).toBe('0.1.0');
    expect(pkg['private']).toBe(true);
    expect(pkg['type']).toBe('module');
    expect(pkg['sideEffects']).toBe(false);
  });

  it('declares exactly the allowed workspace dependencies: adapters-sdk, contracts, domain-kernel', () => {
    const pkg = readPackageJson();
    expect(pkg['dependencies']).toStrictEqual({
      '@office/adapters-sdk': 'workspace:^',
      '@office/contracts': 'workspace:^',
      '@office/domain-kernel': 'workspace:^',
    });
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });

  it('imports only allowed modules outside the package (node builtins + the three office packages)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const isTest = isTestFile(file);
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        const allowed =
          specifier.startsWith('.') ||
          (specifier.startsWith('node:')
            ? isTest
              ? TEST_NODE_MODULES.has(specifier)
              : SOURCE_NODE_MODULES.has(specifier)
            : false) ||
          (allowedOfficePackages as readonly string[]).includes(specifier) ||
          (isTest && specifier === 'vitest');
        if (!allowed) {
          violations.push(`${file}: '${specifier}'`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('never imports a core, intelligence, app, or persistence package, or anything under apps/*', () => {
    const offenders: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      for (const specifier of importSpecifiers(text)) {
        // Any @office/* workspace package beyond the three declared
        // dependencies is a boundary violation.
        if (
          specifier.startsWith('@office/') &&
          !(allowedOfficePackages as readonly string[]).includes(specifier)
        ) {
          offenders.push(`${file}: '${specifier}'`);
        }
        if (specifier.startsWith('apps/') || specifier.includes('/apps/')) {
          offenders.push(`${file}: '${specifier}'`);
        }
      }
      // Quoted string-literal references count too (dynamic imports,
      // error messages, fixtures): the forbidden packages must not even be
      // NAMED inside this adapter.
      for (const forbidden of forbiddenOfficePackages) {
        if (text.includes(`'${forbidden}'`) || text.includes(`"${forbidden}"`)) {
          offenders.push(`${file} (string literal reference '${forbidden}')`);
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('contains no provider/vendor vocabulary in any source or test file', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      if (providerVocabulary.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toStrictEqual([]);
    // The generic vocabulary the package DOES declare (the reference
    // fixture's identity surface — no vendor names).
    expect(construction.CONSTRUCTION_ADAPTER_KIND).toBe('construction-cde');
    expect(construction.CONSTRUCTION_SYSTEM_ID).toBe('cde-instance-01');
    expect(construction.CONSTRUCTION_OBJECT_KINDS).toStrictEqual([
      'document',
      'rfi',
      'change-event',
      'observation',
    ]);
  });

  it('is PURE PORTS: no persistence, no SQL, no network, no database wiring, no migrations', () => {
    expect(existsSync(join(packageRoot, 'migrations'))).toBe(false);
    for (const file of listFiles(srcDir, '.ts')) {
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      expect(text.includes(databaseUrlLiteral), file).toBe(false);
      expect(/SELECT\s|INSERT\s|UPDATE\s+\w+\s+SET|CREATE\s+TABLE/i.test(text), file).toBe(false);
      if (!isTestFile(file)) {
        expect(networkIoPattern.test(text), `${file} (network or process surface)`).toBe(false);
      }
    }
    for (const file of listFiles(packageRoot, '.sql')) {
      throw new Error(`unexpected SQL file in a pure-ports package: ${file}`);
    }
  });

  it('is deterministic everywhere: no wall clock, no randomness (sources: no Date at all)', () => {
    const violations: string[] = [];
    for (const file of listFiles(srcDir, '.ts')) {
      const isTest = isTestFile(file);
      const text = stripComments(readFileSync(join(srcDir, file), 'utf8'));
      if (wallClockPattern.test(text)) {
        violations.push(`${file} (wall clock or randomness)`);
      }
      if (!isTest && dateConstructionPattern.test(text)) {
        violations.push(`${file} (Date construction in source)`);
      }
    }
    expect(violations).toStrictEqual([]);
  });

  it('ships a source entry point with no build output and no internal-surface leak', () => {
    const pkg = readPackageJson();
    expect(pkg['main']).toBe('./src/index.ts');
    expect(pkg['types']).toBe('./src/index.ts');
    expect(existsSync(join(srcDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist'))).toBe(false);
    expect(existsSync(join(packageRoot, 'build'))).toBe(false);
    // The package-internal parse plumbing and the test wiring are
    // deliberately NOT re-exported through the public surface.
    const index = readFileSync(join(srcDir, 'index.ts'), 'utf8');
    expect(index.includes("from './parse'")).toBe(false);
    expect(index.includes("from './test-support'")).toBe(false);
  });

  it('keeps the required adapter modules present', () => {
    for (const required of [
      'vocabulary.ts',
      'parse.ts',
      'provider-fixture.ts',
      'snapshot-translation.ts',
      'mapping.ts',
      'adapter.ts',
      'sync.ts',
      'webhook-ingest.ts',
      'test-support.ts',
      'index.ts',
    ]) {
      expect(existsSync(join(srcDir, required)), required).toBe(true);
    }
  });

  it('exposes exactly the documented public surface from src/index.ts', () => {
    // Everything OFF-037 (the integration fabric) and the SDK engines can
    // consume — nothing else: the public surface carries no store, no
    // repository, no SQL, and no canonical write primitive of any kind.
    expect(Object.keys(construction).sort()).toStrictEqual([
      'CDE_TRANSLATION_CHECKSUM_HEADER',
      'CDE_WEBHOOK_SIGNATURE_HEADER',
      'CHANGE_EVENT_CANONICAL_KIND',
      'CHANGE_EVENT_CREATE_COMMAND',
      'CHANGE_EVENT_OBJECT_KIND',
      'CHANGE_EVENT_UPDATE_COMMAND',
      'CONSTRUCTION_ADAPTER_KIND',
      'CONSTRUCTION_CAPABILITIES',
      'CONSTRUCTION_CAPABILITY_NAMES',
      'CONSTRUCTION_OBJECT_KINDS',
      'CONSTRUCTION_OBJECT_MAPPINGS',
      'CONSTRUCTION_SYSTEM_ID',
      'DOCUMENT_CANONICAL_KIND',
      'DOCUMENT_CREATE_COMMAND',
      'DOCUMENT_DELETE_COMMAND',
      'DOCUMENT_OBJECT_KIND',
      'DOCUMENT_UPDATE_COMMAND',
      'OBSERVATION_CANONICAL_KIND',
      'OBSERVATION_CREATE_COMMAND',
      'OBSERVATION_DELETE_COMMAND',
      'OBSERVATION_OBJECT_KIND',
      'OBSERVATION_UPDATE_COMMAND',
      'RFI_CANONICAL_KIND',
      'RFI_CREATE_COMMAND',
      'RFI_DELETE_COMMAND',
      'RFI_OBJECT_KIND',
      'RFI_UPDATE_COMMAND',
      'cdeTranslationChecksum',
      'cdeWebhookSignature',
      'constructionObjectMappingOf',
      'constructionObjectViewOf',
      'constructionSnapshotOf',
      'createCdeTranslationVerifier',
      'createCdeWebhookVerifier',
      'createConstructionAdapter',
      'createConstructionProviderStore',
      'createConstructionTranslator',
      'ingestCdeWebhook',
      'parseChangeEventProviderData',
      'parseDocumentProviderData',
      'parseObservationProviderData',
      'parseRfiProviderData',
      'runConstructionSync',
      'translateCdeWebhookBody',
    ]);
  });

  it('touches the canonical graph ONLY through typed command proposals (THE runtime proof)', async () => {
    // One object of each declared kind, over the public surface only.
    const store = construction.createConstructionProviderStore();
    store.putDocument({
      objectId: 'doc-1',
      title: 'Structural drawing package',
      projectId: PROJECT_ID,
      discipline: 'structural',
      revision: { revisionId: 'rev-1', contentBase64: 'UEsDBBQABgAGAAA=' },
      updatedAt: NOW_1,
    });
    store.putRfi({
      objectId: 'rfi-1',
      title: 'Cladding penetration detail',
      question: 'Which detail governs the roof penetration at grid C4?',
      category: 'design-coordination',
      severity: 'high',
      projectId: PROJECT_ID,
      raisedBy: USER_ID,
      raisedAt: NOW_1,
      updatedAt: NOW_1,
    });
    store.putChangeEvent({
      objectId: 'ce-1',
      title: 'Additional facade cleaning scope',
      changeType: 'addition',
      contractRef: CONTRACT_ID,
      costImpacts: [{ budgetId: null, costItemId: entity(201) }],
      updatedAt: NOW_1,
    });
    store.putObservation({
      objectId: 'obs-1',
      category: 'quality',
      summary: 'Missing vapor barrier at north wall',
      location: 'Level 3, grid B2',
      observedAt: NOW_1,
      observedBy: USER_ID,
      updatedAt: NOW_1,
    });

    const { deps, versions } = engine({ now: NOW_1 });
    const report = unwrap(
      await construction.runConstructionSync(
        {
          authorization: constructionAuthorization(),
          adapter: construction.createConstructionAdapter({ store }),
          translator: construction.createConstructionTranslator(),
          systemId: construction.CONSTRUCTION_SYSTEM_ID,
          limit: 10,
        },
        deps,
      ),
    );

    // The engines' bookkeeping (mappings, cursors) is the SDK's own; the
    // CANONICAL graph stand-in — the version table only the TEST writes,
    // standing in for the runtime's execution — is completely untouched by
    // the whole ingest: without an executor, no canonical state exists.
    expect(versions.size).toBe(0);

    // Every artifact that would move canonical state is a typed command
    // proposal over the LANDED canonical command vocabulary.
    const landedCommands = new Set<string>([
      construction.DOCUMENT_CREATE_COMMAND,
      construction.DOCUMENT_UPDATE_COMMAND,
      construction.DOCUMENT_DELETE_COMMAND,
      construction.RFI_CREATE_COMMAND,
      construction.RFI_UPDATE_COMMAND,
      construction.RFI_DELETE_COMMAND,
      construction.CHANGE_EVENT_CREATE_COMMAND,
      construction.CHANGE_EVENT_UPDATE_COMMAND,
      construction.OBSERVATION_CREATE_COMMAND,
      construction.OBSERVATION_UPDATE_COMMAND,
      construction.OBSERVATION_DELETE_COMMAND,
    ]);
    const commands: CommandEnvelope<AdapterJsonObject>[] = report.streams.flatMap(
      (stream) => stream.commands,
    );
    expect(commands).toHaveLength(4);
    expect(commands.map((command) => command.commandName)).toStrictEqual([
      construction.DOCUMENT_CREATE_COMMAND,
      construction.RFI_CREATE_COMMAND,
      construction.CHANGE_EVENT_CREATE_COMMAND,
      construction.OBSERVATION_CREATE_COMMAND,
    ]);
    for (const stream of report.streams) {
      for (const application of stream.applications) {
        const command = application.command;
        if (command === null) continue;
        // A typed CommandEnvelope that round-trips the contracts parser…
        expect(command.kind).toBe('command');
        expect(landedCommands.has(command.commandName)).toBe(true);
        expect(parseCommandEnvelope(command).ok).toBe(true);
        // …issued by the ADAPTER actor inside the tenant scope…
        expect(command.actor.kind).toBe('adapter');
        expect(command.scope).toStrictEqual({ kind: 'tenant', tenantId: TENANT_A });
        // …keyed by the SourceRef-derived idempotency key (one command per
        // provider object version, shared with the webhook path)…
        expect(command.idempotencyKey).toBe(syncIdempotencyKey(application.snapshot.source));
        // …and causally chained to the provider object's lifecycle (a sync
        // snapshot is a chain ROOT, never a caused message).
        expect(command.causality.causationId).toBeNull();
        expect(command.causality.correlationId).toBe(
          sourceCorrelationId(coordinateOf(application.snapshot.source)),
        );
      }
    }

    // The graph moves ONLY when the runtime executes a proposal — the test
    // stands in for the Action Gateway here (A8/A11: adapters propose).
    versions.set(entity(1), version(1));
    expect(versions.size).toBe(1);
  });
});
