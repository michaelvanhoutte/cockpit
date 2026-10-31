import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { accountTables } from '../../../src/accounts/backup.js';
import * as storeSchema from '../../../src/accounts/schema.js';
import * as registerSchema from '../../../src/db/schema.js';
import { inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, because the schema drawn has to be the one a real store
 * and a real register end up with once every change and migration has run,
 * not the one the TypeScript describes: the tables are created by hand-written
 * SQL in changes.ts and migrations/, which nothing else compares.
 *
 * The file this writes is what the architecture page draws its Databases
 * diagrams from (tools/architecture, "Databases"), and is checked in so the
 * nightly run reads it without a Workers runtime. A change to the schema fails
 * here until the file is written again:
 *
 *   pnpm --filter @cockpit/api exec vitest run tests/integration/db/schema-file.test.ts -u
 */

const SCHEMA_FILE = '../../../database-schema.json';

type Row = Record<string, unknown>;
type All = (query: string, ...params: unknown[]) => Promise<Row[]>;
type Marks = typeof storeSchema.NO_LONGER_USED;

/** Each table a schema file defines, by its SQL name: the name it is exported as, and each column's property. */
function definitions(schema: Record<string, unknown>) {
  const tables = new Map<string, { exportedAs: string; properties: Map<string, string> }>();
  for (const [exportedAs, value] of Object.entries(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const properties = new Map(Object.entries(getTableColumns(value)).map(([property, column]) => [column.name, property]));
    tables.set(getTableName(value), { exportedAs, properties });
  }
  return tables;
}

/**
 * Every table in `names` as the database holds it: its columns, what each
 * points at and its indexes (not the primary key's own, which the columns
 * already say), with the names queries use and what `marks` writes down.
 */
async function readTables(all: All, names: readonly string[], schema: Record<string, unknown>, marks: Marks) {
  const defined = definitions(schema);
  const tables = [];
  for (const name of [...names].sort()) {
    const [listed] = await all(`SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?`, name);
    const columns = await all(`SELECT name, type, "notnull" AS not_null, dflt_value, pk FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid`, name);
    const links = await all(`SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list(?)`, name);
    const indexes = [];
    for (const index of await all(`SELECT name, "unique", origin FROM pragma_index_list(?) ORDER BY name`, name)) {
      if (index.origin === 'pk') continue;
      const parts = await all(`SELECT name, "desc" FROM pragma_index_xinfo(?) WHERE "key" = 1 ORDER BY seqno`, index.name);
      const [created] = await all(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, index.name);
      const where = typeof created?.sql === 'string' ? /\bWHERE\b([\s\S]*)$/i.exec(created.sql)?.[1]?.trim() : undefined;
      indexes.push({
        name: index.name,
        unique: index.unique === 1,
        columns: parts.map((part) => `${part.name ?? '(expression)'}${part.desc === 1 ? ' DESC' : ''}`),
        ...(where ? { where } : {}),
      });
    }
    const definition = defined.get(name);
    const mark = marks[name];
    tables.push({
      name,
      strict: listed?.strict === 1,
      queriedAs: definition?.exportedAs ?? null,
      ...(typeof mark === 'string' ? { noLongerUsed: mark } : {}),
      columns: columns.map((column) => {
        const link = links.find((each) => each.from === column.name);
        const columnMark = typeof mark === 'object' ? mark[String(column.name)] : undefined;
        return {
          name: column.name,
          type: column.type || null,
          required: column.not_null === 1,
          default: column.dflt_value ?? null,
          primaryKey: Number(column.pk) || null,
          references: link ? { table: link.table, column: link.to ?? null, onDelete: link.on_delete } : null,
          queriedAs: definition?.properties.get(String(column.name)) ?? null,
          ...(columnMark ? { noLongerUsed: columnMark } : {}),
        };
      }),
      indexes,
    });
  }
  return tables;
}

async function readBoth() {
  const store = await inTheStore((sql) => {
    const all: All = async (query, ...params) => sql.exec(query, ...params).toArray() as Row[];
    return readTables(all, accountTables(sql), storeSchema, storeSchema.NO_LONGER_USED);
  });
  const d1: All = async (query, ...params) => (await env.DB.prepare(query).bind(...params).all<Row>()).results;
  // The register's own tables: not SQLite's, the runtime's (a leading underscore) or Wrangler's migration ledger.
  const names = await d1(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'd1_migrations'`,
  );
  const register = await readTables(d1, names.map((row) => String(row.name)), registerSchema, {});
  return { store, register };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Accounts', () => {
  describe('the schema the architecture page draws is the one the register and an account’s store end up with', () => {
    it('matches the schema file, table for table, column for column and index for index', async () => {
      const { store, register } = await readBoth();
      const file = {
        $comment: 'Written by apps/api/tests/integration/db/schema-file.test.ts from a real register and a real account store; never edited by hand.',
        databases: [
          { key: 'register', name: 'Register', kind: 'D1', oneFor: 'every account', definedIn: ['apps/api/migrations/', 'apps/api/src/db/schema.ts'], tables: register },
          { key: 'account-store', name: 'Account store', kind: 'Durable Object', oneFor: 'each account', definedIn: ['apps/api/src/accounts/changes.ts', 'apps/api/src/accounts/schema.ts'], tables: store },
        ],
      };
      await expect(JSON.stringify(file, null, 2) + '\n').toMatchFileSnapshot(
        SCHEMA_FILE,
        'The schema changed: write apps/api/database-schema.json again with `pnpm --filter @cockpit/api exec vitest run tests/integration/db/schema-file.test.ts -u` and commit it.',
      );
    });
  });

  describe('what the schema writes down as no longer used is still in an account’s store', () => {
    it('names only tables and columns the store has', async () => {
      const { store } = await readBoth();
      const held = new Set(store.flatMap((table) => [table.name, ...table.columns.map((column) => `${table.name}.${column.name}`)]));
      const written = Object.entries(storeSchema.NO_LONGER_USED).flatMap(([table, mark]) =>
        typeof mark === 'string' ? [table] : Object.keys(mark).map((column) => `${table}.${column}`),
      );
      expect(written.filter((name) => !held.has(name))).toEqual([]);
    });
  });
});
