import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PersistenceFailure } from './failure';
import {
  DEFAULT_MIGRATIONS_DIR,
  MIGRATION_FILE_PATTERN,
  parseMigrationFileName,
  readMigrationFiles,
} from './migrator';

// OFF-004 migration-file contract (filesystem only; the applying migrator is
// proven against a real PostgreSQL in integration.test.ts):
//   * filenames follow <NNNN>_<snake_name>.sql, versions unique + strictly
//     ascending, every file in the directory is a migration (fail closed);
//   * the package's own migrations directory satisfies the contract;
//   * checksums are stable sha256 digests of the file text.

const fixtureDirs: string[] = [];

const withFixtureDir = async (
  files: Readonly<Record<string, string>>,
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'office-migrator-'));
  for (const [fileName, text] of Object.entries(files)) {
    await writeFile(join(dir, fileName), text, 'utf8');
  }
  fixtureDirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseMigrationFileName', () => {
  it('accepts canonical migration filenames', () => {
    expect(parseMigrationFileName('0001_tenants.sql')).toStrictEqual({
      version: 1,
      name: 'tenants',
    });
    expect(parseMigrationFileName('0002_project_settings.sql')).toStrictEqual({
      version: 2,
      name: 'project_settings',
    });
    expect(parseMigrationFileName('9999_x9.sql')).toStrictEqual({ version: 9999, name: 'x9' });
  });

  it('rejects non-migration filenames with a typed validation failure', () => {
    for (const fileName of [
      'tenants.sql',
      '0001-Tenants.sql',
      '0001_.sql',
      '0001_Tenants.sql',
      '00001_tenants.sql',
      '1_tenants.sql',
      '0001_tenants.SQL',
      '0001_tenants.sql.bak',
      '.hidden.sql',
    ]) {
      expect(() => parseMigrationFileName(fileName), fileName).toThrow(PersistenceFailure);
    }
  });

  it('the file pattern and the parser agree on the grammar', () => {
    expect(MIGRATION_FILE_PATTERN.test('0001_tenants.sql')).toBe(true);
    expect(MIGRATION_FILE_PATTERN.test('tenants.sql')).toBe(false);
    expect(MIGRATION_FILE_PATTERN.test('0001_tenants.sql.bak')).toBe(false);
  });
});

describe('readMigrationFiles', () => {
  it('reads the package migrations directory in application order with stable checksums', async () => {
    const files = await readMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    expect(files.map((file) => file.version)).toStrictEqual([1, 2]);
    expect(files.map((file) => file.name)).toStrictEqual(['tenants', 'projects']);
    for (const file of files) {
      expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(file.text.length).toBeGreaterThan(0);
    }
    const reread = await readMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    expect(reread).toStrictEqual(files);
  });

  it('sorts fixture migrations by version regardless of creation order', async () => {
    const dir = await withFixtureDir({
      '0002_second.sql': 'CREATE TABLE second (id INT);',
      '0001_first.sql': 'CREATE TABLE first (id INT);',
    });
    const files = await readMigrationFiles(dir);
    expect(files.map((file) => file.fileName)).toStrictEqual(['0001_first.sql', '0002_second.sql']);
  });

  it('rejects duplicate versions (unique, strictly ascending)', async () => {
    const dir = await withFixtureDir({
      '0001_alpha.sql': 'CREATE TABLE alpha (id INT);',
      '0001_beta.sql': 'CREATE TABLE beta (id INT);',
    });
    await expect(readMigrationFiles(dir)).rejects.toBeInstanceOf(PersistenceFailure);
  });

  it('rejects unknown files in the migrations directory (fail closed, never silently skipped)', async () => {
    const dir = await withFixtureDir({
      '0001_alpha.sql': 'CREATE TABLE alpha (id INT);',
      'notes.txt': 'not a migration',
    });
    await expect(readMigrationFiles(dir)).rejects.toBeInstanceOf(PersistenceFailure);
  });

  it('rejects a missing migrations directory', async () => {
    await expect(readMigrationFiles(join(tmpdir(), 'office-migrator-does-not-exist'))).rejects.toBeInstanceOf(
      PersistenceFailure,
    );
  });

  it('ignores dotfiles (editor/OS noise), applying only real migrations', async () => {
    const dir = await withFixtureDir({
      '0001_alpha.sql': 'CREATE TABLE alpha (id INT);',
      '.DS_Store': 'noise',
    });
    const files = await readMigrationFiles(dir);
    expect(files.map((file) => file.fileName)).toStrictEqual(['0001_alpha.sql']);
  });
});

describe('DEFAULT_MIGRATIONS_DIR', () => {
  it('points at the package migrations directory (relative to src/)', () => {
    expect(DEFAULT_MIGRATIONS_DIR.replaceAll('\\', '/')).toMatch(/packages\/persistence\/migrations$/);
  });
});

describe('checksum immutability semantics (composition level)', () => {
  it('changes to a file change its checksum — the tamper signal for applied migrations', async () => {
    const dirA = await withFixtureDir({ '0001_alpha.sql': 'CREATE TABLE alpha (id INT);' });
    const dirB = await withFixtureDir({ '0001_alpha.sql': 'CREATE TABLE alpha (id INT, note TEXT);' });
    const [fileA] = await readMigrationFiles(dirA);
    const [fileB] = await readMigrationFiles(dirB);
    expect(fileA?.checksum).toBeDefined();
    expect(fileB?.checksum).toBeDefined();
    expect(fileA?.checksum).not.toBe(fileB?.checksum);
  });
});
