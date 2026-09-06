import type { SqlStorage } from '@cloudflare/workers-types';
import { inBatchesOf } from '../domain/statements.js';
import type { AccountBackup, Row } from './backup.js';

/**
 * Putting one account's store back from a backup.
 *
 * The mirror of `backup.ts`, and the half that destroys something: what was in
 * the store before is gone. Everything here is therefore written to be run
 * inside one `transactionSync` (`store.ts`), so a restore that fails partway
 * leaves the account exactly as it was rather than as a mixture of two states.
 *
 * **Order is derived from the schema, never written down.** Both halves of the
 * work need one - rows cannot be inserted before the rows they point at, and a
 * table cannot be dropped while something still points at it, `ON DELETE
 * RESTRICT` being what the architecture chose throughout ("The database is the
 * second lock"). That order is the foreign keys, and SQLite already knows them,
 * so asking is both shorter than a list and immune to the failure a list has:
 * going stale the day a table is added, and doing it silently.
 */

/** A row of a table, and the account it must belong to. */
const ACCOUNT_COLUMN = 'tenant_id';

/**
 * The account's tables, parents before children.
 *
 * Insert in this order and every row's references already exist; drop in the
 * reverse and nothing is ever dropped while something points at it.
 *
 * A cycle cannot happen in this schema and is refused rather than ignored: the
 * alternative is silently picking an order that does not work, which surfaces
 * as a foreign-key failure halfway through a restore.
 */
export function tablesParentsFirst(sql: SqlStorage, tables: readonly string[]): string[] {
  const wanted = new Set(tables);
  const parentsOf = new Map<string, string[]>();
  for (const table of tables) {
    const parents = sql
      .exec<{ table: string }>(`PRAGMA foreign_key_list("${quoted(table)}")`)
      .toArray()
      .map((row) => row.table)
      // A table pointing at itself imposes no order between tables, and a
      // parent outside the backup is not ours to wait for.
      .filter((parent) => parent !== table && wanted.has(parent));
    parentsOf.set(table, [...new Set(parents)]);
  }

  const ordered: string[] = [];
  const done = new Set<string>();
  const onTheWay = new Set<string>();

  const visit = (table: string): void => {
    if (done.has(table)) return;
    if (onTheWay.has(table)) {
      throw new Error(`the account's tables point at each other in a circle, through ${table}`);
    }
    onTheWay.add(table);
    for (const parent of parentsOf.get(table) ?? []) visit(parent);
    onTheWay.delete(table);
    done.add(table);
    ordered.push(table);
  };

  // Sorted first, so two stores with the same tables always give the same
  // order - a restore that fails is then reproducible rather than dependent on
  // the order `sqlite_master` happened to answer in.
  for (const table of [...tables].sort()) visit(table);
  return ordered;
}

/**
 * Empties the store of the account's own tables.
 *
 * Dropped rather than emptied, because the backup carries the shape as well as
 * the rows: the change list is replayed afterwards and creates each table as it
 * stood when the backup was taken. Emptying would keep whatever shape is there
 * now and quietly restore old rows into a new schema.
 */
export function dropAccountTables(sql: SqlStorage, parentsFirst: readonly string[]): void {
  for (const table of [...parentsFirst].reverse()) {
    sql.exec(`DROP TABLE IF EXISTS "${quoted(table)}"`);
  }
}

/**
 * Empties every table of its rows, keeping the tables themselves.
 *
 * Needed because replaying the change list does two things at once: it creates
 * the tables *and* puts an account's starting data in them - the three
 * workspaces every account begins with, and the standard types. A backup
 * already holds those rows, so inserting on top of them collides on the primary
 * key. Emptying afterwards is what makes a restore say "be exactly this"
 * instead of "be this, plus whatever a new account starts with".
 *
 * Children first, so nothing is deleted while a row still points at it.
 */
export function deleteAllRows(sql: SqlStorage, parentsFirst: readonly string[]): void {
  for (const table of [...parentsFirst].reverse()) {
    sql.exec(`DELETE FROM "${quoted(table)}"`);
  }
}

/**
 * Writes a backup's rows into the store, in an order the foreign keys accept.
 *
 * **Every insert is batched.** A store's SQLite binds at most 100 values per
 * statement, so one insert per table would work until an account had enough
 * rows and then fail - the shape the architecture forbids under "No statement's
 * parameter count grows with the data". `inBatchesOf` is the same arithmetic
 * the command handlers use.
 */
export function writeRows(sql: SqlStorage, backup: AccountBackup, order: readonly string[]): void {
  for (const table of order) {
    const rows = backup.tables[table] ?? [];
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]!);
    if (columns.length === 0) continue;
    sameShapeThroughout(table, rows, columns);
    const columnList = columns.map((column) => `"${quoted(column)}"`).join(', ');

    for (const batch of inBatchesOf(rows, columns.length)) {
      const values = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
      const params = batch.flatMap((row) => columns.map((column) => row[column] ?? null));
      sql.exec(`INSERT INTO "${quoted(table)}" (${columnList}) VALUES ${values}`, ...params);
    }
  }
}

/**
 * That every row of a table carries the same columns, which is what lets the
 * first one settle the insert for all of them.
 *
 * **Refused rather than filled in.** A backup is a file on somebody's disk and
 * may have been edited or merged by hand - that is what the format is for - so
 * rows disagreeing about their columns is a real state rather than an
 * impossible one. Taking the first row's list and reading the rest through it
 * writes NULL for a column a later row lacks and silently drops one it has
 * gained, and both land as a restore that reports success having lost data.
 * Which is the one thing a backup exists to prevent.
 */
function sameShapeThroughout(table: string, rows: readonly Row[], columns: readonly string[]): void {
  const expected = [...columns].sort().join(',');
  for (const [at, row] of rows.entries()) {
    const found = Object.keys(row).sort().join(',');
    if (found !== expected) {
      throw new Error(
        `the backup's ${table} rows do not all carry the same columns: row ${at + 1} has ` +
          `${found || 'none'} where the first has ${expected}`,
      );
    }
  }
}

/**
 * **The lock on the way in is `foreignRows` from `backup.ts`, unchanged.**
 *
 * It used to be written again here, which is how it was first built: the same
 * loop over the same shape, under a second name. That is the wrong shape for
 * this particular check - it is the second lock the architecture leans on, it
 * is turned in two directions, and two copies of it drift in exactly the way
 * nobody notices, because each direction is exercised by different tests. One
 * function, two sentences (`describeForeignRows` on the way out,
 * `describeForeignRowsInBackup` on the way in).
 *
 * The direction guarded here is the one that matters more. A backup is a file,
 * so what reaches this point has been on somebody's disk and may have been
 * edited; without the check, restoring one account's file into another's store
 * writes rows carrying a name that store's own queries never match, leaving an
 * account that reads as empty while holding somebody else's data.
 */

/** Whether the store already holds any of the account's own rows. */
export function storeHoldsAnything(sql: SqlStorage, tables: readonly string[]): boolean {
  for (const table of tables) {
    const [first] = sql.exec(`SELECT 1 FROM "${quoted(table)}" LIMIT 1`).toArray();
    if (first) return true;
  }
  return false;
}

/**
 * A name from `sqlite_master` or from a backup's own keys, made safe to put in
 * a statement - identifiers cannot be bound, only values can.
 */
function quoted(name: string): string {
  return name.replace(/"/g, '""');
}
