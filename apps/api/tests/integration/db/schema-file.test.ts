import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { accountTables } from '../../../src/accounts/backup.js';
import * as storeSchema from '../../../src/accounts/schema.js';
import * as registerSchema from '../../../src/db/schema.js';
import { inTheStore, seedRegister, startFromEmpty } from '../seed.js';

type Row = Record<string, unknown>;
type All = (query: string, ...params: unknown[]) => Promise<Row[]>;
type Marks = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

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

async function describeTables(all: All, names: readonly string[], schema: Record<string, unknown>, marks: Marks) {
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

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('probe', () => {
  it('writes a file snapshot', async () => {
    const store = await inTheStore((sql) => {
      const all: All = async (query, ...params) => sql.exec(query, ...params).toArray() as Row[];
      return describeTables(all, accountTables(sql), storeSchema, storeSchema.NO_LONGER_USED);
    });
    const d1: All = async (query, ...params) => (await env.DB.prepare(query).bind(...params).all<Row>()).results;
    const registerNames = (await d1(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'd1_migrations'`)).map((row) => String(row.name));
    const register = await describeTables(d1, registerNames, registerSchema, {});
    const file = {
      $comment: 'Written by apps/api/tests/integration/db/schema-file.test.ts from a real store and a real register; regenerate with `pnpm --filter @cockpit/api exec vitest run tests/integration/db/schema-file.test.ts -u`.',
      databases: [
        { key: 'register', name: 'Register', kind: 'D1', oneFor: 'every account', definedIn: ['apps/api/migrations/', 'apps/api/src/db/schema.ts'], tables: register },
        { key: 'account-store', name: 'Account store', kind: 'Durable Object', oneFor: 'each account', definedIn: ['apps/api/src/accounts/changes.ts', 'apps/api/src/accounts/schema.ts'], tables: store },
      ],
    };
    await expect(JSON.stringify(file, null, 2) + '\n').toMatchFileSnapshot('../../../database-schema.json');
  });
});
