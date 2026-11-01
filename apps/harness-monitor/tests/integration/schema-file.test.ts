import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * Integration level, because the schema drawn has to be the one the database ends up with once every
 * migration has run, not the one any single migration describes: tables are rebuilt and renamed, and only
 * real D1 shows what is left.
 *
 * The file this writes is what the architecture page draws the Harness Monitor's tables from
 * (tools/architecture, "Databases"), and is checked in so the nightly run reads it without a Workers
 * runtime. A migration that changes the schema fails here until the file is written again:
 *
 *   pnpm --filter @harness-monitor/worker exec vitest run tests/integration/schema-file.test.ts -u
 *
 * The file records no foreign keys the SQL does not declare, and this SQL declares none; the architecture
 * script infers them from column names.
 */

const SCHEMA_FILE = '../../database-schema.json';

type Row = Record<string, unknown>;
const all = async (query: string, ...params: unknown[]): Promise<Row[]> => (await env.DB.prepare(query).bind(...params).all<Row>()).results;

/** Every table the Monitor owns, as the database holds it: its columns, what each points at and its indexes (not the primary key's own, which the columns already say). */
async function readTables() {
  // Not SQLite's, the runtime's (a leading underscore) or Wrangler's migration ledger.
  const names = await all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name`,
  );
  const tables = [];
  for (const { name } of names) {
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
    tables.push({
      name,
      strict: listed?.strict === 1,
      columns: columns.map((column) => {
        const link = links.find((each) => each.from === column.name);
        return {
          name: column.name,
          type: column.type || null,
          required: column.not_null === 1,
          default: column.dflt_value ?? null,
          primaryKey: Number(column.pk) || null,
          references: link ? { table: link.table, column: link.to ?? null, onDelete: link.on_delete } : null,
        };
      }),
      indexes,
    });
  }
  return tables;
}

describe('Harness Monitor', () => {
  describe('the schema file the architecture page draws its tables from is the one the database ends up with', () => {
    it('matches the schema file, table for table, column for column and index for index', async () => {
      const file = {
        $comment: 'Written by apps/harness-monitor/tests/integration/schema-file.test.ts from a real database once every migration has run; never edited by hand.',
        databases: [
          { key: 'harness-monitor', name: 'Harness Monitor', kind: 'D1', oneFor: 'the Harness Monitor', definedIn: ['apps/harness-monitor/migrations/'], tables: await readTables() },
        ],
      };
      await expect(JSON.stringify(file, null, 2) + '\n').toMatchFileSnapshot(
        SCHEMA_FILE,
        'The schema changed: write apps/harness-monitor/database-schema.json again with `pnpm --filter @harness-monitor/worker exec vitest run tests/integration/schema-file.test.ts -u` and commit it.',
      );
    });
  });
});
