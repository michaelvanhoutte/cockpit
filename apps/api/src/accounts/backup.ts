import type { SqlStorage, SqlStorageValue } from '@cloudflare/workers-types';

/**
 * Reading one account's store out, whole, for a backup.
 *
 * **Nothing here brings the account up to date, and that is the point.** Every
 * other way into a store applies the outstanding changes first (`store.ts`), so
 * backing up every account would wake and migrate all of them at once - turning
 * a read into the riskiest write the system has, on every account, at a moment
 * nobody chose. Reading a store as it stands keeps a backup read-only, and the
 * change list it records is what says which shape the rows are in, so a restore
 * knows where to start replaying from.
 *
 * **A backup is one moment rather than a smear.** Everything below is
 * synchronous and there is no `await` between the first table and the last, so
 * a Durable Object - single-threaded, one request at a time - cannot let a
 * change land halfway through. That property is free here and would be gone the
 * moment this paged across requests, which is why it does not.
 */

/** What one account's store holds, as it stands. */
export interface AccountBackup {
  /**
   * Which changes this store had applied when it was read - the shape its rows
   * are in, and what a restore starts replaying from.
   *
   * **A set, not an order**, sorted by name only so that backing the same
   * account up twice produces the same file. The ledger cannot say what order
   * they ran in: it records a name and a timestamp, several changes apply
   * inside the same millisecond, and the names do not sort into the order they
   * are applied in anyway - `0009-item-workspace-decided` runs before
   * `0009-item-texts` and sorts after it. Nothing needs the order from here,
   * because a restore replays the code's own change list filtered to this set,
   * which is ordered by construction.
   */
  changesApplied: string[];
  /** Every table the store holds, by name, each with all of its rows. */
  tables: Record<string, Row[]>;
}

/**
 * SQLite hands back exactly four kinds of value, one of which is an
 * `ArrayBuffer` - which JSON has no way to write and a backup would therefore
 * lose. Nothing can produce one here: every table is STRICT with `text` and
 * `integer` columns only (architecture, "The database is the second lock"), and
 * STRICT is precisely the guarantee that a blob cannot be stored in either. So
 * a row round-trips through JSON exactly, and it is the schema that makes that
 * true rather than luck - a `blob` column added later would break it, and would
 * have to bring its own encoding.
 */
export type Row = Record<string, SqlStorageValue>;

/** A row found in a store that says it belongs somewhere else. */
export interface ForeignRow {
  table: string;
  /** What the row says its account is, which is not the one holding it. */
  tenantId: SqlStorageValue;
}

/**
 * The store's own bookkeeping, which is not the account's data and is recorded
 * separately as `changesApplied`.
 */
const CHANGE_LEDGER = 'account_changes';

/**
 * The column every row of an account's data carries, naming whose it is
 * (architecture, "One store per account, and `tenant_id` stays"). It is the
 * row's provenance, and a backup is exactly the moment that matters: rows leave
 * the store here, and this is the only thing on them that says where they came
 * from.
 */
const ACCOUNT_COLUMN = 'tenant_id';

/**
 * Reads every table the store holds rather than a list written down here, so a
 * table added later is in the backup without anybody remembering to add it. A
 * list would go stale silently, and the failure - a restore that quietly drops
 * a table nobody updated this file for - would not show up until somebody
 * needed the backup.
 *
 * **Tables whose names begin with an underscore are the runtime's, not the
 * account's**, and are skipped along with SQLite's own. `_cf_` is Cloudflare's
 * prefix and `__miniflare_do_name` is one miniflare keeps locally - which is
 * the reason the rule is the underscore rather than a list of prefixes: the
 * miniflare table exists only under `pnpm dev`, so no test could have found it
 * and a list would have been written from whatever the tests happened to see.
 * Every table an account's changes create is a plain name.
 */
export function readStoreAsItStands(sql: SqlStorage): AccountBackup {
  const tables: Record<string, Row[]> = {};
  for (const name of tableNames(sql)) {
    if (name === CHANGE_LEDGER) continue;
    tables[name] = rowsOf(sql, name);
  }
  return { changesApplied: changesApplied(sql), tables };
}

/**
 * Which rows in a backup say they belong to another account.
 *
 * Always none, in an account that has only ever been reached the ordinary way -
 * which is what makes it worth checking rather than assuming. `tenant_id` is
 * the second lock, and a lock nothing ever tries is one nobody would notice had
 * broken; the one moment it can be tried against a whole store at once is here.
 */
export function foreignRows(backup: AccountBackup, accountName: string): ForeignRow[] {
  const foreign: ForeignRow[] = [];
  for (const [table, rows] of Object.entries(backup.tables)) {
    for (const row of rows) {
      // A row with no such column carries no claim about whose it is, so there
      // is nothing here to disagree with.
      //
      // `continue` rather than `break`, though every row of a SQLite table has
      // the same columns and the first one therefore settles it: this is the
      // lock that catches what cannot happen, so resting it on something else
      // that cannot happen is the wrong way round for one word.
      if (!(ACCOUNT_COLUMN in row)) continue;
      if (row[ACCOUNT_COLUMN] !== accountName) {
        foreign.push({ table, tenantId: row[ACCOUNT_COLUMN] });
      }
    }
  }
  return foreign;
}

/**
 * Says what is wrong in the words somebody reading the command's output needs.
 *
 * **A table and a count per table, not a clause per row.** This becomes an HTTP
 * response body built in the Worker's memory, and a store that has somehow
 * accumulated foreign rows has no upper bound on how many - so a row-by-row
 * message would be megabytes to say one thing. Which tables, whose the rows
 * are, and how many, is the whole of what anybody acts on.
 */
export function describeForeignRows(foreign: readonly ForeignRow[], accountName: string): string {
  const perTable = new Map<string, { count: number; tenants: Set<string> }>();
  for (const row of foreign) {
    const seen = perTable.get(row.table) ?? { count: 0, tenants: new Set<string>() };
    seen.count += 1;
    seen.tenants.add(JSON.stringify(row.tenantId));
    perTable.set(row.table, seen);
  }
  const named = [...perTable.entries()]
    .map(
      ([table, seen]) =>
        `${table} holds ${seen.count} row${seen.count === 1 ? '' : 's'} belonging to ${[
          ...seen.tenants,
        ].join(', ')}`,
    )
    .join('; ');
  return `account ${accountName} was not backed up: ${named}`;
}

function tableNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .toArray()
    .map((row) => row.name);
}

function rowsOf(sql: SqlStorage, table: string): Row[] {
  // The table name cannot be bound - SQLite binds values, never identifiers -
  // so it is quoted instead. It came from `sqlite_master` rather than from
  // anything a caller sent, so there is nothing here to inject; the quoting is
  // what keeps that true if the source of the name ever changes.
  return sql.exec<Row>(`SELECT * FROM "${table.replace(/"/g, '""')}"`).toArray();
}

/**
 * Empty for a store nobody has ever opened, which has no ledger yet because
 * nothing has run to create one. That is a real state rather than an error: an
 * account exists in the register from the moment it is added and its store is
 * not created until somebody first touches it, so a backup taken in between
 * holds an account with nothing in it.
 *
 * Ordered by name for a file that does not change between two backups of an
 * unchanged account, and for no other reason - see `changesApplied` on
 * `AccountBackup` for why the order carries no meaning.
 */
function changesApplied(sql: SqlStorage): string[] {
  const hasLedger = sql
    .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, CHANGE_LEDGER)
    .toArray();
  if (hasLedger.length === 0) return [];
  return sql
    .exec<{ name: string }>(`SELECT name FROM ${CHANGE_LEDGER} ORDER BY name`)
    .toArray()
    .map((row) => row.name);
}
