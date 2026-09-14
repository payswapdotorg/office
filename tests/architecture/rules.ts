// Office architecture conformance gate — THE shared rule table + scan helpers
// (OFF-039).
//
// This module is the single source of truth for the five frozen-architecture
// conformance checks (`pnpm test:architecture` runs them on every push and
// pull request as the required CI gate step):
//
//   1. forbidden imports    — the global cross-package import-boundary scan
//   2. provider leakage     — the repo-wide real-vendor-name vocabulary scan
//   3. direct agent DB      — the agents/intelligence persistence/SQL ban
//   4. unscoped queries     — the static A12 discipline on the exported
//                             persistence-facing query surface
//   5. app permission drift — the client capability baselines vs the closed
//                             capability registry
//
// Every check is a PURE function over a `readonly RepoFile[]` map (path +
// text), so the mutation probes in conformance.test.ts can feed synthetic
// violating inputs and prove each rule actually fails. The real-repo tests
// feed the same checkers through `loadRepoTree()`: ONE deterministic pass
// over the tree (sorted walks, shared file reads, memoized) — no clock, no
// randomness, no filesystem-ordering assumptions. Everything fails closed:
// a missing or unreadable file is a FAILURE, never a skip.
//
// The rules are derived from the ACTUAL landed surfaces: each package's
// allowed-dependency set comes from its OWN package.json dependencies block,
// the tenant-scope carrier discipline from packages/persistence +
// packages/events, the capability registry from packages/authz. The freeze
// citations and the sanctioned exceptions for every rule are documented in
// tests/architecture/README.md (the rulebook).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The file map every check consumes.
// ---------------------------------------------------------------------------

/** One source file of the scanned tree: repo-relative POSIX path + raw text. */
export interface RepoFile {
  readonly path: string;
  readonly text: string;
}

/** One named conformance violation (the fail-closed report of a check). */
export interface Violation {
  /** The violated rule's stable name (see tests/architecture/README.md). */
  readonly rule: string;
  /** The offending file, as a repo-relative POSIX path. */
  readonly file: string;
  /** What was found and why it violates the rule. */
  readonly detail: string;
}

/** The repository root (this suite lives at <root>/tests/architecture). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cachedTree: readonly RepoFile[] | undefined;

/**
 * ONE deterministic pass over the tree: every `.ts` and `.tsx` file and
 * every `package.json` under `packages/`, `apps/`, and `tests/`, read once,
 * sorted by path. Directory walks skip `node_modules`/`dist`/`build`/
 * `coverage` and never follow symlinks (pnpm links packages there).
 * Fail-closed: an unreadable directory or file THROWS (the gate fails, never
 * skips). Memoized: every check shares the same pass. The `.tsx` coverage
 * (OFF-DEPLOY) exists because the browser host's JSX modules are gated like
 * every other source; the checks whose domains carry no `.tsx` (agent DB
 * access, scoped queries, app permissions) keep their `.ts`-only filters by
 * design — noted at each filter.
 */
export function loadRepoTree(): readonly RepoFile[] {
  if (cachedTree !== undefined) return cachedTree;
  const files: RepoFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`architecture gate: cannot read directory ${dir}: ${String(error)}`);
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === 'coverage'
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name === 'package.json')
      ) {
        let text: string;
        try {
          text = readFileSync(full, 'utf8');
        } catch (error) {
          throw new Error(`architecture gate: cannot read file ${full}: ${String(error)}`);
        }
        files.push({ path: relative(repoRoot, full).split('\\').join('/'), text });
      }
    }
  };
  for (const root of ['packages', 'apps', 'tests']) {
    walk(join(repoRoot, root));
  }
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  cachedTree = sorted;
  return sorted;
}

// ---------------------------------------------------------------------------
// Shared text helpers (the landed boundary-test conventions, globalized).
// ---------------------------------------------------------------------------

/** Strip line and block comments so scans see only real syntax. */
export const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

/**
 * Every import/export specifier of a text: the statement-clause form
 * (`import ... from '...';` / `export ... from '...';` — the landed pattern
 * that cannot match `from '...'` inside string literals) plus bare dynamic
 * `import('...')`.
 */
export const importSpecifiers = (text: string): readonly string[] => {
  const specifiers: string[] = [];
  const statement = /\b(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]\s*;/g;
  for (const match of text.matchAll(statement)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(dynamic)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
};

/** The import clauses targeting one specifier, e.g. `type { SqlExecutor }`. */
export const importClausesFor = (text: string, specifier: string): readonly string[] => {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\bimport\\s+([^;]*?)\\s+from\\s+['"]${escaped}['"]`, 'g');
  const clauses: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const clause = match[1];
    if (clause !== undefined) clauses.push(clause.trim());
  }
  return clauses;
};

/** The base package name of a specifier (`@office/x/sub` -> `@office/x`). */
const basePackageName = (specifier: string): string =>
  specifier.startsWith('@') ? (specifier.split('/').slice(0, 2).join('/') ?? specifier) : specifier;

/** Balance an open/close bracket pair starting at `startIdx` (the open char). */
const balancedEnd = (text: string, startIdx: number, open: string, close: string): number => {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

// ---------------------------------------------------------------------------
// Package discovery (from the file map itself — future packages are covered).
// ---------------------------------------------------------------------------

export interface PackageInfo {
  /** Repo-relative POSIX directory, e.g. `packages/agents`. */
  readonly dir: string;
  /** The declared package name, e.g. `@office/agents`. */
  readonly name: string;
  /** Every declared dependency name (the package's OWN package.json). */
  readonly dependencies: readonly string[];
}

/**
 * Every package manifest under `packages/` or `apps/`, sorted by directory.
 * Unreadable manifests are reported as violations (fail closed), never
 * skipped.
 */
export function discoverPackages(files: readonly RepoFile[]): {
  readonly packages: readonly PackageInfo[];
  readonly violations: readonly Violation[];
} {
  const packages: PackageInfo[] = [];
  const violations: Violation[] = [];
  for (const file of files) {
    if (!file.path.endsWith('package.json')) continue;
    if (!file.path.startsWith('packages/') && !file.path.startsWith('apps/')) continue;
    const dir = file.path.slice(0, file.path.length - '/package.json'.length);
    try {
      const parsed: unknown = JSON.parse(file.text);
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { name?: unknown }).name !== 'string') {
        violations.push({
          rule: 'package-manifest-unreadable',
          file: file.path,
          detail: 'manifest has no string "name"',
        });
        continue;
      }
      const dependencies: string[] = [];
      const deps = (parsed as { dependencies?: unknown }).dependencies;
      if (deps !== undefined) {
        if (typeof deps !== 'object' || deps === null) {
          violations.push({
            rule: 'package-manifest-unreadable',
            file: file.path,
            detail: '"dependencies" is not an object',
          });
          continue;
        }
        for (const name of Object.keys(deps)) dependencies.push(name);
      }
      packages.push({
        dir,
        name: (parsed as { name: string }).name,
        dependencies: [...dependencies].sort(),
      });
    } catch (error) {
      violations.push({
        rule: 'package-manifest-unreadable',
        file: file.path,
        detail: `unparsable JSON: ${String(error)}`,
      });
    }
  }
  packages.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { packages, violations };
}

/** The owning package of a source file: the longest manifest-dir prefix. */
const owningPackage = (
  packages: readonly PackageInfo[],
  path: string,
): PackageInfo | undefined => {
  let owner: PackageInfo | undefined;
  for (const pkg of packages) {
    if (path.startsWith(`${pkg.dir}/`)) {
      if (owner === undefined || pkg.dir.length > owner.dir.length) owner = pkg;
    }
  }
  return owner;
};

// ---------------------------------------------------------------------------
// Check 1 — forbidden imports (the global import-boundary scan).
// ---------------------------------------------------------------------------

/**
 * THE frozen layering rules (the freeze's dependency rule + the landed
 * structural disciplines the per-package boundary tests encode individually,
 * now asserted globally from this one table). A layering rule forbids an
 * import EVEN IF the dependency is declared — the layering is architectural,
 * not managerial.
 */
export const LAYERING_RULES: readonly {
  readonly rule: string;
  readonly description: string;
  readonly appliesTo: (pkg: PackageInfo) => boolean;
  readonly forbids: readonly RegExp[];
}[] = [
  {
    rule: 'domain-never-imports-adapters',
    description:
      "freeze dependency rule — core domain modules depend only inward on shared kernel contracts; adapters map INTO canonical contracts, never the reverse (A5)",
    appliesTo: (pkg) => pkg.dir.startsWith('packages/domain/'),
    forbids: [/^@office\/adapters(-sdk)?(\/|$)/, /^@office\/adapter-/],
  },
  {
    rule: 'clients-never-import-persistence',
    description:
      'the landed clients are structurally database-free views over the canonical graph (A6/A12) — no @office/persistence import, not even type-only',
    appliesTo: (pkg) => pkg.dir.startsWith('apps/'),
    forbids: [/^@office\/persistence(\/|$)/],
  },
  {
    rule: 'adapters-never-import-adapters',
    description:
      'freeze dependency rule — provider-specific code depends on application/domain contracts, never on another provider-specific implementation',
    appliesTo: (pkg) => pkg.name.startsWith('@office/adapter-'),
    forbids: [/^@office\/adapter-/],
  },
];

/**
 * Sanctioned non-declared imports (the documented root-devDependency harness
 * seam): `embedded-postgres` is a ROOT devDependency of the workspace,
 * imported dynamically by the persistence integration-test harness so
 * production imports never load it (packages/persistence/src/testing.ts).
 */
const SANCTIONED_DYNAMIC_IMPORTS: readonly { readonly specifier: string; readonly file: string }[] =
  [{ specifier: 'embedded-postgres', file: 'packages/persistence/src/testing.ts' }];

/**
 * Check 1: the global cross-package import-boundary scan over every
 * `packages/*` and `apps/*` source file — `.ts` AND `.tsx` (OFF-DEPLOY: the
 * browser host's JSX modules are gated like every other source). Allowed
 * forms: relative imports, `node:` builtins, the package's OWN declared
 * dependencies (from its package.json dependencies block), `vitest` in
 * `*.test.ts` files only, and the enumerated sanctioned dynamic imports.
 * Declared imports must still satisfy the frozen layering rules. Everything
 * else fails closed with the offending file + import + violated rule.
 */
export function checkForbiddenImports(files: readonly RepoFile[]): readonly Violation[] {
  const { packages, violations } = discoverPackages(files);
  const violationsOut: Violation[] = [...violations];
  for (const file of files) {
    if (!file.path.endsWith('.ts') && !file.path.endsWith('.tsx')) continue;
    if (!file.path.startsWith('packages/') && !file.path.startsWith('apps/')) continue;
    if (!file.path.includes('/src/')) continue;
    const pkg = owningPackage(packages, file.path);
    if (pkg === undefined) {
      violationsOut.push({
        rule: 'orphan-source-file',
        file: file.path,
        detail: 'source file with no owning package manifest (package.json) — a package directory is missing its manifest',
      });
      continue;
    }
    const isTest = file.path.endsWith('.test.ts');
    const text = stripComments(file.text);
    for (const specifier of importSpecifiers(text)) {
      const layeringViolation = LAYERING_RULES.find(
        (rule) =>
          rule.appliesTo(pkg) &&
          rule.forbids.some((pattern) => pattern.test(specifier)) &&
          !(rule.rule === 'adapters-never-import-adapters' && specifier === pkg.name),
      );
      if (specifier.startsWith('.') || specifier.startsWith('node:')) {
        if (layeringViolation !== undefined) {
          violationsOut.push({
            rule: layeringViolation.rule,
            file: file.path,
            detail: `'${specifier}' — ${layeringViolation.description}`,
          });
        }
        continue;
      }
      if (specifier === 'vitest') {
        if (!isTest) {
          violationsOut.push({
            rule: 'test-runner-import-outside-test',
            file: file.path,
            detail: "'vitest' is importable in *.test.ts files only",
          });
        }
        continue;
      }
      if (pkg.dependencies.includes(basePackageName(specifier))) {
        if (layeringViolation !== undefined) {
          violationsOut.push({
            rule: layeringViolation.rule,
            file: file.path,
            detail: `'${specifier}' is declared but layering forbids it — ${layeringViolation.description}`,
          });
        }
        continue;
      }
      if (
        SANCTIONED_DYNAMIC_IMPORTS.some(
          (sanctioned) => sanctioned.specifier === specifier && sanctioned.file === file.path,
        )
      ) {
        continue;
      }
      violationsOut.push({
        rule: specifier.startsWith('@office/') ? 'undeclared-workspace-dependency' : 'external-import',
        file: file.path,
        detail: `'${specifier}' is not a relative import, node: builtin, test-runner import, or a dependency declared in ${pkg.dir}/package.json${layeringViolation !== undefined ? ` (and violates ${layeringViolation.rule})` : ''}`,
      });
    }
  }
  return violationsOut;
}

// ---------------------------------------------------------------------------
// Check 2 — provider leakage (the repo-wide real-vendor-name vocabulary scan).
// ---------------------------------------------------------------------------

/**
 * THE forbidden provider/vendor/cloud vocabulary: the real proper-noun names
 * the landed per-package boundary tests ban, assembled from fragments so this
 * scan's own source never contains a literal name (the vocabulary rule —
 * real provider names appear ONLY here, as the scan inputs, exactly as the
 * landed boundary tests already do).
 *
 * Deliberately NOT forbidden repo-wide (documented in README.md): the generic
 * words `provider`/`vendor` (the landed SDK surface vocabulary — adapters-sdk
 * ProviderObjectKind/ProviderSystemId, the procurement vendor domain), `erp`
 * (the finance adapter family's generic category, e.g. 'erp-finance'), and
 * `oracle` (collides with the security-testing term "existence oracle").
 * Those stay banned inside the packages whose own boundary tests carry them.
 */
const FORBIDDEN_PROVIDER_NAMES: readonly string[] = [
  'pro' + 'core',
  'auto' + 'desk',
  'prim' + 'avera',
  'ms' + '-project',
  'p' + '6',
  'sa' + 'ge',
  'view' + 'point',
  's' + 'ap',
  'net' + 'suite',
  'quick' + 'books',
  'xe' + 'ro',
  'dyn' + 'amics',
  'work' + 'day',
  'in' + 'for',
];

/** The assembled forbidden-name pattern (word boundaries, case-insensitive). */
export const providerNamePattern = new RegExp(
  `\\b(${FORBIDDEN_PROVIDER_NAMES.join('|')})\\b`,
  'gi',
);

/**
 * Sanctioned exceptions (explicitly enumerated, README-documented):
 * - this suite's own files (the scan inputs + the mutation probes);
 * - the three landed intelligence boundary scanners that carry 'sage' /
 *   'viewpoint' as their own fragment-array scan inputs;
 * - the adapter families' fixture-vocabulary homes (vocabulary.ts /
 *   provider-fixture.ts), where a future concrete-vendor fixture sibling
 *   would carry its sanctioned names.
 */
const PROVIDER_LEAKAGE_EXCEPTIONS: readonly RegExp[] = [
  /^tests\/architecture\//,
  /^packages\/intelligence\/(procurement|revenue|stack-analysis)\/src\/boundary\.test\.ts$/,
  /^packages\/adapter-(construction|finance|model|schedule)\/src\/(vocabulary|provider-fixture)\.ts$/,
];

/**
 * Check 2: the repo-wide vocabulary scan for real provider/vendor/cloud
 * names across every source file in the map (comment-stripped) — `.ts` AND
 * `.tsx` (OFF-DEPLOY: JSX modules leak vendor names exactly as reliably as
 * TypeScript modules). Any occurrence outside the sanctioned exceptions
 * fails closed naming the file and the leaked name.
 */
export function checkProviderLeakage(files: readonly RepoFile[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.ts') && !file.path.endsWith('.tsx')) continue;
    if (PROVIDER_LEAKAGE_EXCEPTIONS.some((exception) => exception.test(file.path))) continue;
    const text = stripComments(file.text);
    const found = new Set<string>();
    for (const match of text.matchAll(providerNamePattern)) {
      const name = match[1];
      if (name !== undefined) found.add(name.toLowerCase());
    }
    if (found.size > 0) {
      violations.push({
        rule: 'provider-name-leakage',
        file: file.path,
        detail: `real provider/vendor name(s) in source: ${[...found].sort().join(', ')} — generic vocabulary only (freeze A5 + the provider-vocabulary rule)`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check 3 — direct agent DB access (the agents/intelligence family ban).
// ---------------------------------------------------------------------------

/** The agent families: packages/agents + every packages/intelligence/* (glob-discovered). */
const isAgentFamilyFile = (path: string): boolean =>
  path.startsWith('packages/agents/src/') ||
  (path.startsWith('packages/intelligence/') && path.includes('/src/'));

/** SQL/direct-store vocabulary (the landed agents boundary-test pattern). */
const SQL_SURFACE_PATTERN =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bCREATE\s+TABLE\b|\bSELECT\b[^;]*\bFROM\b|\bnew\s+(?:Pool|Client)\b|\bPgPool\b/i;

/**
 * Check 3: agents and intelligence NEVER touch the database directly (freeze
 * A8 + the frozen anti-pattern "No AI direct SQL writes"):
 * - no VALUE import of @office/persistence anywhere in the family (the
 *   type-only `SqlExecutor` port signature is the sanctioned inert seam in
 *   packages/agents; the intelligence families mirror the port locally and
 *   import nothing from persistence at all);
 * - no import of the `pg` driver in any form;
 * - no SQL surface in any non-test module: no SQL statement vocabulary, no
 *   `.query(` call site, no Pool/Client construction.
 */
export function checkAgentDbAccess(files: readonly RepoFile[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    // `.ts` only by design: the agent/intelligence families carry no `.tsx`
    // (the browser host is the only JSX surface — check 1 gates its imports).
    if (!file.path.endsWith('.ts')) continue;
    if (!isAgentFamilyFile(file.path)) continue;
    const text = stripComments(file.text);
    for (const clause of importClausesFor(text, '@office/persistence')) {
      if (!clause.startsWith('type')) {
        violations.push({
          rule: 'agent-persistence-value-import',
          file: file.path,
          detail: `value import of @office/persistence ('${clause}') — agents never touch the database directly (freeze A8); the SqlExecutor port signature is type-only`,
        });
      } else if (!file.path.startsWith('packages/agents/src/')) {
        violations.push({
          rule: 'agent-persistence-import',
          file: file.path,
          detail:
            "import of @office/persistence outside packages/agents — the intelligence families mirror the SqlExecutor port locally and import nothing from persistence",
        });
      }
    }
    for (const specifier of importSpecifiers(text)) {
      if (specifier === 'pg' || specifier === 'node:pg') {
        violations.push({
          rule: 'agent-sql-driver-import',
          file: file.path,
          detail: `'${specifier}' — no SQL driver import in the agents/intelligence families`,
        });
      }
    }
    if (!file.path.endsWith('.test.ts')) {
      if (SQL_SURFACE_PATTERN.test(text) || text.includes('.query(')) {
        violations.push({
          rule: 'agent-sql-surface',
          file: file.path,
          detail:
            'SQL surface in a non-test agent/intelligence module (SQL statements, .query( call, or Pool/Client construction) — no direct database access',
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check 4 — unscoped queries (the static A12 discipline).
// ---------------------------------------------------------------------------

/**
 * The platform control-plane exception files (README-documented): migrations
 * (DDL + schema_migrations bookkeeping, advisory-locked, no tenant data), the
 * integration-test harness (creates/drops the isolated scratch DATABASE),
 * and the operations restore drill (the whole-database operator tooling —
 * the platform-level control plane the freeze's A12 names as the mediated
 * cross-tenant capability). Everything else in a persistence-facing package
 * must flow tenant scope.
 */
const SCOPED_QUERY_EXCEPTIONS: readonly string[] = [
  'packages/persistence/src/migrator.ts',
  'packages/persistence/src/testing.ts',
  'packages/operations/src/drill/backup.ts',
  'packages/operations/src/drill/restore.ts',
];

/** Direct tenant-scope parameter types (the typed scope discipline). */
const DIRECT_SCOPE_TYPES: readonly string[] = ['Scope', 'TenantId'];
/** Field types that carry tenant scope inside an input interface. */
const CARRIER_FIELD_TYPES: readonly string[] = ['Scope', 'TenantId', 'DomainEventEnvelope'];

interface InterfaceInfo {
  readonly name: string;
  readonly body: string;
}

/** Every interface declaration (exported or not) in a text, by name. */
const interfacesOf = (text: string): readonly InterfaceInfo[] => {
  const interfaces: InterfaceInfo[] = [];
  const pattern = /\binterface\s+(\w+)(?:<[^>]*>)?\s*\{/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    const open = match.index !== undefined ? text.indexOf('{', match.index) : -1;
    if (name === undefined || open < 0) continue;
    const close = balancedEnd(text, open, '{', '}');
    if (close < 0) continue;
    interfaces.push({ name, body: text.slice(open + 1, close) });
  }
  return interfaces;
};

/**
 * Does the interface named `typeName` (resolved in the global interface map)
 * carry tenant scope: a `scope: Scope` / `tenantId: TenantId` /
 * `envelope: DomainEventEnvelope` field, or a field typed as another carrier
 * interface (recursive, cycle-safe)?
 */
const isCarrierInterface = (
  typeName: string,
  globalInterfaces: ReadonlyMap<string, InterfaceInfo>,
  visited: ReadonlySet<string>,
): boolean => {
  if (DIRECT_SCOPE_TYPES.includes(typeName)) return true;
  if (visited.has(typeName)) return false;
  const info = globalInterfaces.get(typeName);
  if (info === undefined) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(typeName);
  const fieldPattern = /(\w+)\s*\??\s*:\s*([^;\n]+)[;\n]/g;
  for (const field of info.body.matchAll(fieldPattern)) {
    const fieldType = (field[2] ?? '').trim().replace(/<.*>$/, '').trim();
    if (CARRIER_FIELD_TYPES.includes(fieldType)) return true;
    if (fieldType.length > 0 && isCarrierInterface(fieldType, globalInterfaces, nextVisited)) {
      return true;
    }
  }
  return false;
};

/** Split a parameter list on top-level commas. */
const splitParams = (paramsText: string): readonly string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of paramsText) {
    if (char === '(' || char === '[' || char === '{' || char === '<') depth++;
    else if (char === ')' || char === ']' || char === '}' || char === '>') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
};

/** Does a parameter list flow tenant scope (direct param or carrier input)? */
const paramsCarryTenantScope = (
  paramsText: string,
  globalInterfaces: ReadonlyMap<string, InterfaceInfo>,
): boolean => {
  for (const part of splitParams(paramsText)) {
    const cleaned = part.split('=')[0] ?? part;
    const colon = cleaned.indexOf(':');
    if (colon < 0) continue;
    const type = cleaned
      .slice(colon + 1)
      .trim()
      .replace(/<.*>$/, '')
      .trim();
    if (type.length > 0 && isCarrierInterface(type, globalInterfaces, new Set())) return true;
  }
  return false;
};

/**
 * Check 4: the static form of A12 on the persistence-facing data surfaces —
 * every package declaring @office/persistence in dependencies (plus
 * packages/persistence itself, THE database surface). The exported query
 * surface must flow tenant scope:
 * - every method of every exported `*Repository` interface declares a
 *   tenant-scoping parameter (`scope: Scope`, `tenantId: TenantId`, or an
 *   input whose interface carries one of those / the A3 envelope);
 * - every exported function declaration whose body executes `.query(` does
 *   the same (the events discipline: scope directly, or through the
 *   validated envelope the row's scope columns come from).
 * The enumerated control-plane files are the sanctioned exceptions.
 */
export function checkScopedQueries(files: readonly RepoFile[]): readonly Violation[] {
  const { packages, violations } = discoverPackages(files);
  const violationsOut: Violation[] = [...violations];
  const persistenceFacing = [
    'packages/persistence',
    ...packages
      .filter((pkg) => pkg.dependencies.includes('@office/persistence'))
      .map((pkg) => pkg.dir),
  ].sort();
  const globalInterfaces = new Map<string, InterfaceInfo>();
  for (const file of files) {
    // `.ts` only by design: the persistence-facing packages carry no `.tsx`
    // (SQL-executing exports are TypeScript surfaces; the host's JSX modules
    // hold no SQL by the boundary discipline check 1 enforces).
    if (!file.path.endsWith('.ts')) continue;
    for (const info of interfacesOf(file.text)) {
      if (!globalInterfaces.has(info.name)) globalInterfaces.set(info.name, info);
    }
  }
  for (const file of files) {
    if (!file.path.endsWith('.ts') || file.path.endsWith('.test.ts')) continue;
    const pkg = persistenceFacing.find((dir) => file.path.startsWith(`${dir}/`));
    if (pkg === undefined) continue;
    if (!file.path.includes('/src/')) continue;
    if (SCOPED_QUERY_EXCEPTIONS.includes(file.path)) continue;
    const text = file.text;

    // Exported *Repository interfaces: every method carries tenant scope.
    const interfacePattern = /export\s+interface\s+(\w*Repository)\s*\{/g;
    for (const match of text.matchAll(interfacePattern)) {
      const name = match[1];
      const open = match.index !== undefined ? text.indexOf('{', match.index) : -1;
      if (name === undefined || open < 0) continue;
      const close = balancedEnd(text, open, '{', '}');
      if (close < 0) continue;
      const body = text.slice(open + 1, close);
      const methodPattern = /(\w+)\s*\(/g;
      for (const method of body.matchAll(methodPattern)) {
        const methodName = method[1];
        const parenOpen = method.index !== undefined ? body.indexOf('(', method.index) : -1;
        if (methodName === undefined || parenOpen < 0) continue;
        const parenClose = balancedEnd(body, parenOpen, '(', ')');
        if (parenClose < 0) continue;
        const after = body.slice(parenClose + 1, parenClose + 12);
        if (!/^\s*:/.test(after)) continue; // not a method signature
        const paramsText = body.slice(parenOpen + 1, parenClose);
        if (!paramsCarryTenantScope(paramsText, globalInterfaces)) {
          violationsOut.push({
            rule: 'unscoped-repository-method',
            file: file.path,
            detail: `${name}.${methodName}(${paramsText.replace(/\s+/g, ' ').trim()}) — every repository method must flow tenant scope (a scope: Scope / tenantId: TenantId parameter or a carrier input), freeze A12`,
          });
        }
      }
    }

    // Exported function declarations that execute .query( in their body.
    const functionPattern = /export\s+(?:async\s+)?function\s+(\w+)(?:<[^>]*>)?\s*\(/g;
    for (const match of text.matchAll(functionPattern)) {
      const name = match[1];
      const parenOpen = match.index !== undefined ? text.indexOf('(', match.index) : -1;
      if (name === undefined || parenOpen < 0) continue;
      const parenClose = balancedEnd(text, parenOpen, '(', ')');
      if (parenClose < 0) continue;
      const bodyOpen = text.indexOf('{', parenClose);
      if (bodyOpen < 0) continue;
      const bodyClose = balancedEnd(text, bodyOpen, '{', '}');
      if (bodyClose < 0) continue;
      const body = text.slice(bodyOpen, bodyClose + 1);
      if (!body.includes('.query(')) continue;
      const paramsText = text.slice(parenOpen + 1, parenClose);
      if (!paramsCarryTenantScope(paramsText, globalInterfaces)) {
        violationsOut.push({
          rule: 'unscoped-query-export',
          file: file.path,
          detail: `${name}(${paramsText.replace(/\s+/g, ' ').trim()}) executes SQL without a tenant-scope parameter (scope: Scope / tenantId: TenantId directly, or an input carrying the validated envelope) — there is no unscoped entry point, freeze A12`,
        });
      }
    }
  }
  return violationsOut;
}

// ---------------------------------------------------------------------------
// Check 5 — app permission drift (client baselines vs the closed registry).
// ---------------------------------------------------------------------------

/** The three permission-declaring clients (the landed view shells). */
export const CONFORMANCE_CLIENTS: readonly string[] = ['web', 'field', 'desktop'];

/** The canonical closed capability registry file (@office/authz, OFF-006). */
export const CAPABILITY_REGISTRY_FILE = 'packages/authz/src/capability.ts';

/**
 * Extract the declared capability registry: the DECLARED_CAPABILITY_NAMES
 * array of packages/authz/src/capability.ts (the closed vocabulary every
 * permission declaration must draw from — the same registry the OFF-036
 * access-review surface audits declared baselines against). Fail closed:
 * a missing or unparseable registry is reported, never skipped.
 */
export function extractCapabilityRegistry(
  files: readonly RepoFile[],
): { readonly names: readonly string[]; readonly violations: readonly Violation[] } {
  const violations: Violation[] = [];
  const registryFile = files.find((file) => file.path === CAPABILITY_REGISTRY_FILE);
  if (registryFile === undefined) {
    return {
      names: [],
      violations: [
        {
          rule: 'capability-registry-missing',
          file: CAPABILITY_REGISTRY_FILE,
          detail: 'the canonical capability registry file is missing from the tree',
        },
      ],
    };
  }
  const match = registryFile.text.match(/const DECLARED_CAPABILITY_NAMES = \[([\s\S]*?)\] as const/);
  if (match === null || match[1] === undefined) {
    return {
      names: [],
      violations: [
        {
          rule: 'capability-registry-unparseable',
          file: CAPABILITY_REGISTRY_FILE,
          detail: 'the DECLARED_CAPABILITY_NAMES array could not be extracted',
        },
      ],
    };
  }
  const names: string[] = [];
  for (const literal of match[1].matchAll(/'([^']+)'/g)) {
    const name = literal[1];
    if (name !== undefined) names.push(name);
  }
  if (names.length === 0) {
    violations.push({
      rule: 'capability-registry-unparseable',
      file: CAPABILITY_REGISTRY_FILE,
      detail: 'the DECLARED_CAPABILITY_NAMES array is empty',
    });
  }
  return { names: [...names].sort(), violations };
}

/**
 * Check 5: the three clients' declared app permissions must exactly match the
 * canonical closed registry:
 * - every capability name a client declares (every `capability('...')`
 *   literal and every name in a `capabilities: [...]` policy array across its
 *   source) must be a member of the registry — no undeclared permission;
 * - the registry itself declares BOTH halves of every area — no missing one;
 * - each client's session module's declared capability set and its
 *   deny-by-default policy capability set are EXACTLY equal — the baseline
 *   the OFF-036 access-review surface audits cannot drift between what the
 *   client grants and what it allows. Drift fails closed naming both sides.
 */
export function checkAppPermissions(files: readonly RepoFile[]): readonly Violation[] {
  const violations: Violation[] = [];
  const { names: registry, violations: registryViolations } = extractCapabilityRegistry(files);
  violations.push(...registryViolations);
  const registrySet = new Set(registry);

  // Registry completeness: every area carries both halves.
  const areas = new Map<string, Set<string>>();
  for (const name of registry) {
    const [area, half] = name.split('.');
    if (area === undefined || half === undefined) continue;
    if (!areas.has(area)) areas.set(area, new Set());
    areas.get(area)?.add(half);
  }
  for (const [area, halves] of [...areas.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const half of ['read', 'write']) {
      if (!halves.has(half)) {
        violations.push({
          rule: 'registry-area-half-missing',
          file: CAPABILITY_REGISTRY_FILE,
          detail: `area '${area}' is missing its '${half}' half — every declared area carries both (the registry's own invariant)`,
        });
      }
    }
  }

  for (const client of CONFORMANCE_CLIENTS) {
    // `.ts` only by design: the three landed clients are pure view-model
    // packages with no `.tsx`; the browser host (apps/host) is NOT a client
    // in this check's sense — it owns no capability surface of its own, it
    // drives the composed session through the gateway.
    const clientSrc = files.filter(
      (file) => file.path.startsWith(`apps/${client}/src/`) && file.path.endsWith('.ts'),
    );
    if (clientSrc.length === 0) {
      violations.push({
        rule: 'client-source-missing',
        file: `apps/${client}/src`,
        detail: `the ${client} client's source tree is missing — every client declares its app permissions`,
      });
      continue;
    }

    // Membership: every declared permission is in the canonical registry.
    for (const file of clientSrc) {
      const text = stripComments(file.text);
      for (const call of text.matchAll(/\bcapability\(\s*'([^']+)'\s*\)/g)) {
        const name = call[1];
        if (name !== undefined && !registrySet.has(name)) {
          violations.push({
            rule: 'undeclared-client-permission',
            file: file.path,
            detail: `capability('${name}') is not declared in the canonical registry (${CAPABILITY_REGISTRY_FILE}) — no undeclared permission`,
          });
        }
      }
      for (const array of text.matchAll(/capabilities:\s*\[([^\]]*)\]/g)) {
        const contents = array[1] ?? '';
        for (const literal of contents.matchAll(/'([^']+)'/g)) {
          const name = literal[1];
          if (name !== undefined && !registrySet.has(name)) {
            violations.push({
              rule: 'undeclared-client-permission',
              file: file.path,
              detail: `policy capability '${name}' is not declared in the canonical registry (${CAPABILITY_REGISTRY_FILE}) — no undeclared permission`,
            });
          }
        }
      }
    }

    // Session baseline exact-match: declared set == policy set.
    const sessionFile = files.find((file) => file.path === `apps/${client}/src/session/session.ts`);
    if (sessionFile === undefined) {
      violations.push({
        rule: 'client-session-missing',
        file: `apps/${client}/src/session/session.ts`,
        detail: `the ${client} client's session module is missing — the permission baseline lives there`,
      });
      continue;
    }
    const session = stripComments(sessionFile.text);
    const declaredPattern = /export const (SESSION_\w+)\s*:\s*readonly Capability\[\]\s*=\s*\[([\s\S]*?)\]/g;
    const declared: string[] = [];
    let declaredConsts = 0;
    for (const match of session.matchAll(declaredPattern)) {
      declaredConsts++;
      const contents = match[2] ?? '';
      for (const call of contents.matchAll(/capability\('([^']+)'\)/g)) {
        const name = call[1];
        if (name !== undefined) declared.push(name);
      }
    }
    const policyMatch = session.match(/definePolicy\(\[([\s\S]*?)\]\)/);
    const policyNames: string[] = [];
    if (policyMatch !== null && policyMatch[1] !== undefined) {
      for (const array of policyMatch[1].matchAll(/capabilities:\s*\[([^\]]*)\]/g)) {
        const contents = array[1] ?? '';
        for (const literal of contents.matchAll(/'([^']+)'/g)) {
          const name = literal[1];
          if (name !== undefined) policyNames.push(name);
        }
      }
    }
    if (declaredConsts !== 1 || policyMatch === null) {
      violations.push({
        rule: 'session-baseline-unparseable',
        file: sessionFile.path,
        detail: `expected exactly one exported SESSION_*_CAPABILITIES const and one definePolicy call (found ${declaredConsts} const(s), ${policyMatch === null ? 'no' : 'one'} policy) — the baseline must be statically analyzable`,
      });
      continue;
    }
    const declaredSet = new Set(declared);
    const policySet = new Set(policyNames);
    const grantedNotAllowed = [...declaredSet].filter((name) => !policySet.has(name)).sort();
    const allowedNotGranted = [...policySet].filter((name) => !declaredSet.has(name)).sort();
    if (grantedNotAllowed.length > 0 || allowedNotGranted.length > 0) {
      violations.push({
        rule: 'permission-baseline-drift',
        file: sessionFile.path,
        detail: `the declared capability baseline and the policy baseline drifted — granted by the session but not allowed by the policy: [${grantedNotAllowed.join(', ')}]; allowed by the policy but not granted by the session: [${allowedNotGranted.join(', ')}]`,
      });
    }
  }
  return violations;
}
