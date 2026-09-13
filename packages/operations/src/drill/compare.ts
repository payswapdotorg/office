// Office operations — THE typed content comparison (OFF-038).
//
// The restore drill's verification step. The comparison basis is the
// deterministic backup itself: BOTH sides are dumped through the same
// {@link createDatabaseBackup} function, so equal content always produces
// byte-identical scripts and the comparison reduces to a typed structural
// walk over the two dump records — same table set, then per-table row
// equality (the INSERT statement arrays, which are order-deterministic by
// construction). Pure: no database access here beyond the two optional
// dumping helpers.
import type { SqlExecutor } from '@office/persistence';
import type { DatabaseBackup, BackupTableDump } from './backup';
import { createDatabaseBackup } from './backup';

/** One table's comparison verdict. */
export interface TableComparison {
  /** Schema-qualified table name. */
  readonly table: string;
  /** Whether the table's row content is identical on both sides. */
  readonly identical: boolean;
  /** Rows dumped from the source side. */
  readonly sourceRows: number;
  /** Rows dumped from the target side. */
  readonly targetRows: number;
}

/** THE typed comparison of two database dumps. */
export interface DatabaseComparison {
  readonly kind: 'database-comparison';
  /** True iff same table set and every table's rows are identical. */
  readonly identical: boolean;
  /** Per-table verdicts, in source dump order. */
  readonly tables: readonly TableComparison[];
  /** Tables present in the source dump but absent from the target. */
  readonly missingTables: readonly string[];
  /** Tables present in the target dump but absent from the source. */
  readonly extraTables: readonly string[];
  /** sha256 checksum of the source dump's script. */
  readonly sourceChecksum: string;
  /** sha256 checksum of the target dump's script. */
  readonly targetChecksum: string;
  /** Human-readable difference lines (empty when identical). */
  readonly differences: readonly string[];
}

const qualifiedName = (entry: BackupTableDump): string => `${entry.schema}.${entry.table}`;

/**
 * THE comparison: two dumps through the same deterministic backup function,
 * compared table-set first, then per-table row content. Pure and total.
 */
export function compareBackups(source: DatabaseBackup, target: DatabaseBackup): DatabaseComparison {
  const sourceByName = new Map(source.tables.map((entry) => [qualifiedName(entry), entry]));
  const targetByName = new Map(target.tables.map((entry) => [qualifiedName(entry), entry]));
  const missingTables = [...sourceByName.keys()]
    .filter((name) => !targetByName.has(name))
    .sort();
  const extraTables = [...targetByName.keys()]
    .filter((name) => !sourceByName.has(name))
    .sort();

  const differences: string[] = [];
  if (missingTables.length > 0) {
    differences.push(`tables missing from the restored database: ${missingTables.join(', ')}`);
  }
  if (extraTables.length > 0) {
    differences.push(`tables unexpected in the restored database: ${extraTables.join(', ')}`);
  }

  const tables: TableComparison[] = [];
  for (const name of [...sourceByName.keys()].sort()) {
    const sourceTable = sourceByName.get(name);
    const targetTable = targetByName.get(name);
    if (sourceTable === undefined || targetTable === undefined) continue;
    const statementsIdentical =
      sourceTable.insertStatements.length === targetTable.insertStatements.length &&
      sourceTable.insertStatements.every(
        (statement, index) => statement === targetTable.insertStatements[index],
      );
    if (!statementsIdentical) {
      const firstDifferenceIndex = sourceTable.insertStatements.findIndex(
        (statement, index) => statement !== targetTable.insertStatements[index],
      );
      differences.push(
        `table ${name} differs (first differing row index ${firstDifferenceIndex}; ` +
          `source rows ${sourceTable.rowCount}, restored rows ${targetTable.rowCount})`,
      );
    }
    tables.push({
      table: name,
      identical: statementsIdentical,
      sourceRows: sourceTable.rowCount,
      targetRows: targetTable.rowCount,
    });
  }

  if (source.checksum !== target.checksum && differences.length === 0) {
    differences.push('dump checksums differ while all compared tables agree');
  }

  return {
    kind: 'database-comparison',
    identical: differences.length === 0,
    tables,
    missingTables,
    extraTables,
    sourceChecksum: source.checksum,
    targetChecksum: target.checksum,
    differences,
  };
}

/** Dump two live databases through the same backup function and compare. */
export async function compareDatabaseContents(
  source: SqlExecutor,
  target: SqlExecutor,
): Promise<DatabaseComparison> {
  const [sourceBackup, targetBackup] = await Promise.all([
    createDatabaseBackup(source),
    createDatabaseBackup(target),
  ]);
  return compareBackups(sourceBackup, targetBackup);
}
