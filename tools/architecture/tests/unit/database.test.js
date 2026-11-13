import { describe, expect, it } from 'vitest';

import { buildDatabase } from '../../src/database.js';
import { codeNaming, column, schema } from '../support/schema.js';

/** The two databases of the support schema as the model builds them, after `change` has edited the file and with `code` as the source read. */
const built = (code = codeNaming, change = () => {}) => {
  const file = schema();
  change(file);
  const [register, store] = buildDatabase({ file: 'apps/api/database-schema.json', text: JSON.stringify(file) }, code).databases;
  return { register, store };
};
const source = (...files) => [{ path: 'apps/api/src/x', package: false, role: 'core', files: files.map(([file, text]) => ({ file, text })) }];
const tableOf = (database, name) => database.tables.find((each) => each.name === name);
const columnOf = (database, table, name) => tableOf(database, table).columns.find((each) => each.name === name);
const indexOf = (database, table, name) => tableOf(database, table).indexes.find((each) => each.name === name);

describe('Databases', () => {
  describe('a table, column or index no longer used is marked with why, and nothing in use is', () => {
    it.each([
      { situation: 'a column the schema writes down: its written reason', of: ({ store }) => columnOf(store, 'items', 'status').unused, marked: /^Written on every insert, read nowhere\.$/ },
      { situation: 'a column the schema writes down that no code names either: its written reason', code: source(['apps/api/src/uses.ts', 'items workspaces tenants']), of: ({ store }) => columnOf(store, 'items', 'status').unused, marked: /^Written on every insert, read nowhere\.$/ },
      { situation: 'a table the schema writes down: its written reason', of: ({ store }) => tableOf(store, 'retired_rules').unused, marked: /^Nothing reads it\.$/ },
      { situation: 'a register table no query is written against: no query is written against it', of: ({ register }) => tableOf(register, 'old_items').unused, marked: /^No query is written against it/ },
      {
        situation: 'a register column no query is written against: no query is written against it',
        change: (file) => file.databases[0].tables[0].columns.push(column('legacy', { queriedAs: null })),
        of: ({ register }) => columnOf(register, 'tenants', 'legacy').unused,
        marked: /^No query is written against it/,
      },
      { situation: 'a column no code names, by its SQL name or the name queries use: no code names it', of: ({ store }) => columnOf(store, 'items', 'forgotten_at').unused, marked: /^No code outside the databases’ schema files names it\.$/ },
      { situation: 'a column code names only by its SQL name: not marked', code: source(['apps/api/src/uses.ts', 'items workspaces tenants forgotten_at']), of: ({ store }) => columnOf(store, 'items', 'forgotten_at').unused, marked: null },
      { situation: 'a column code names only by the name queries use: not marked', code: source(['apps/api/src/uses.ts', 'items workspaces tenants forgottenAt']), of: ({ store }) => columnOf(store, 'items', 'forgotten_at').unused, marked: null },
      { situation: 'a table named only in the schema’s own files: no code names it', of: ({ store }) => tableOf(store, 'hidden_things').unused, marked: /^No code outside the databases’ schema files names it\.$/ },
      { situation: 'a column named only in comments: no code names it', code: source(['apps/api/src/uses.ts', 'items workspaces tenants\n  // forgotten_at is gone\n/* forgottenAt,\n   too */']), of: ({ store }) => columnOf(store, 'items', 'forgotten_at').unused, marked: /^No code outside/ },
      { situation: 'a column named after a `//` inside a string on its line: not marked', code: source(['apps/api/src/uses.ts', "items workspaces tenants\nconst at = 'https://x'; forgotten_at"]), of: ({ store }) => columnOf(store, 'items', 'forgotten_at').unused, marked: null },
      { situation: 'a store column named only in the register’s schema files: no code names it', code: source(['apps/api/src/uses.ts', 'items workspaces tenants'], ['apps/api/src/db/schema.ts', 'forgotten_at forgottenAt']), of: ({ store }) => columnOf(store, 'items', 'forgotten_at').unused, marked: /^No code outside/ },
      { situation: 'a table named only in a folder of the schema’s own files: no code names it', code: source(['apps/api/migrations/0001.sql', 'tenants workspaces items']), of: ({ register }) => tableOf(register, 'tenants').unused, marked: /^No code outside/ },
      { situation: 'an index covering a column no longer used: it covers that column', of: ({ store }) => indexOf(store, 'items', 'items_workspace_status').unused, marked: /^Covers status, which is no longer used\.$/ },
      {
        situation: 'an index covering a column no longer used, in descending order: it covers that column',
        change: (file) => file.databases[1].tables[1].indexes.push({ name: 'items_by_status', unique: false, columns: ['status DESC'] }),
        of: ({ store }) => indexOf(store, 'items', 'items_by_status').unused,
        marked: /^Covers status, which is no longer used\.$/,
      },
      {
        situation: 'an index covering two columns no longer used: it covers both',
        change: (file) => file.databases[1].tables[1].indexes.push({ name: 'items_unused', unique: false, columns: ['status', 'forgotten_at'] }),
        of: ({ store }) => indexOf(store, 'items', 'items_unused').unused,
        marked: /^Covers status, forgotten_at, which are no longer used\.$/,
      },
      { situation: 'a column of a table already marked: not again', of: ({ store }) => columnOf(store, 'retired_rules', 'rules').unused, marked: null },
      { situation: 'a column of a register table already marked: not again', of: ({ register }) => columnOf(register, 'old_items', 'tenant_id').unused, marked: null },
      { situation: 'a table code names: not marked', of: ({ store }) => tableOf(store, 'items').unused, marked: null },
      { situation: 'a table a query is written against and code names: not marked', of: ({ register }) => tableOf(register, 'tenants').unused, marked: null },
      { situation: 'a column code names by the name queries use: not marked', of: ({ store }) => columnOf(store, 'items', 'workspace_id').unused, marked: null },
      { situation: 'an index on columns in use: not marked', of: ({ store }) => indexOf(store, 'items', 'items_live_id').unused, marked: null },
    ])('$situation', ({ code, change, of, marked }) => {
      const actual = of(built(code, change));
      if (marked === null) expect(actual).toBeNull();
      else expect(actual).toMatch(marked);
    });

    it('counts what is no longer used in each database, for the heading to say', () => {
      const { register, store } = built();
      expect([register.counts.unusedTables, register.counts.unusedColumns, register.counts.unusedIndexes]).toEqual([1, 0, 0]);
      expect([store.counts.unusedTables, store.counts.unusedColumns, store.counts.unusedIndexes]).toEqual([2, 2, 1]);
    });
  });
});
