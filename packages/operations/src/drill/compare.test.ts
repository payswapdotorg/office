import { describe, expect, it } from 'vitest';
import { compareBackups } from '../index';
import type { BackupTableDump, DatabaseBackup } from '../index';

// OFF-038 — the typed comparison behind the drill's verification step,
// proven pure and in memory: equal content compares identical; a lost row,
// a changed row, a missing table, and an extra table each compare
// non-identical with a readable difference line. Deterministic by
// construction — no clock, no randomness, no I/O.

const table = (
  name: string,
  rows: readonly string[],
  columns: readonly string[] = ['id'],
): BackupTableDump => ({
  schema: 'public',
  table: name,
  columns,
  primaryKey: columns,
  rowCount: rows.length,
  insertStatements: rows,
});

const backup = (tables: readonly BackupTableDump[]): DatabaseBackup => {
  const script = ['BEGIN;', ...tables.flatMap((entry) => [...entry.insertStatements]), 'COMMIT;']
    .map((line) => `${line}\n`)
    .join('');
  return {
    kind: 'database-backup',
    tables,
    statementCount: tables.reduce((sum, entry) => sum + entry.insertStatements.length, 0),
    script,
    checksum: `sha256-of:${tables.map((entry) => entry.insertStatements.join('|')).join('#')}`,
  };
};

const SOURCE = backup([
  table('tenants', ["INSERT INTO \"public\".\"tenants\" (\"id\") VALUES ('a');"]),
  table('projects', [
    "INSERT INTO \"public\".\"projects\" (\"id\") VALUES ('p1');",
    "INSERT INTO \"public\".\"projects\" (\"id\") VALUES ('p2');",
  ]),
]);

describe('the typed database comparison (the drill\'s verification basis)', () => {
  it('compares identical dumps as identical with no differences', () => {
    const comparison = compareBackups(SOURCE, backup([...SOURCE.tables]));
    expect(comparison.identical).toBe(true);
    expect(comparison.differences).toEqual([]);
    expect(comparison.missingTables).toEqual([]);
    expect(comparison.extraTables).toEqual([]);
    expect(comparison.tables.map((verdict) => verdict.table)).toEqual([
      'public.projects',
      'public.tenants',
    ]);
    for (const verdict of comparison.tables) {
      expect(verdict.identical).toBe(true);
      expect(verdict.sourceRows).toBe(verdict.targetRows);
    }
  });

  it('is deterministic: the same inputs always produce the same report', () => {
    const target = backup([...SOURCE.tables]);
    expect(JSON.stringify(compareBackups(SOURCE, target))).toBe(
      JSON.stringify(compareBackups(SOURCE, target)),
    );
  });

  it('detects a lost row (and reports the first differing row index)', () => {
    const degraded = backup([
      table('tenants', ["INSERT INTO \"public\".\"tenants\" (\"id\") VALUES ('a');"]),
      table('projects', ["INSERT INTO \"public\".\"projects\" (\"id\") VALUES ('p1');"]),
    ]);
    const comparison = compareBackups(SOURCE, degraded);
    expect(comparison.identical).toBe(false);
    expect(comparison.differences).toHaveLength(1);
    expect(comparison.differences[0]).toContain('public.projects differs');
    expect(comparison.tables.find((verdict) => verdict.table === 'public.projects')).toMatchObject({
      identical: false,
      sourceRows: 2,
      targetRows: 1,
    });
  });

  it('detects a changed row even at equal row counts', () => {
    const mutated = backup([
      table('tenants', ["INSERT INTO \"public\".\"tenants\" (\"id\") VALUES ('b');"]),
      table('projects', [
        "INSERT INTO \"public\".\"projects\" (\"id\") VALUES ('p1');",
        "INSERT INTO \"public\".\"projects\" (\"id\") VALUES ('p2');",
      ]),
    ]);
    const comparison = compareBackups(SOURCE, mutated);
    expect(comparison.identical).toBe(false);
    expect(comparison.differences[0]).toContain('first differing row index 0');
  });

  it('detects missing and extra tables and still compares the shared ones', () => {
    const reshaped = backup([
      table('tenants', ["INSERT INTO \"public\".\"tenants\" (\"id\") VALUES ('a');"]),
      table('events', ["INSERT INTO \"public\".\"events\" (\"id\") VALUES ('e1');"]),
    ]);
    const comparison = compareBackups(SOURCE, reshaped);
    expect(comparison.identical).toBe(false);
    expect(comparison.missingTables).toEqual(['public.projects']);
    expect(comparison.extraTables).toEqual(['public.events']);
    expect(comparison.differences).toEqual([
      'tables missing from the restored database: public.projects',
      'tables unexpected in the restored database: public.events',
    ]);
    expect(comparison.tables.find((verdict) => verdict.table === 'public.tenants')?.identical).toBe(
      true,
    );
  });

  it('flags differing checksums even when every compared table agrees', () => {
    const sameTablesDifferentScript = backup([...SOURCE.tables]);
    const comparison = compareBackups(
      { ...SOURCE, checksum: 'different' },
      sameTablesDifferentScript,
    );
    expect(comparison.identical).toBe(false);
    expect(comparison.differences).toEqual([
      'dump checksums differ while all compared tables agree',
    ]);
    expect(comparison.sourceChecksum).toBe('different');
    expect(comparison.targetChecksum).toBe(sameTablesDifferentScript.checksum);
  });
});
