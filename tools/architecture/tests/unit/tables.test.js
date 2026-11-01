import { describe, expect, it } from 'vitest';

import { ReadError } from '../../src/errors.js';
import { buildTables, definitionOf, inferPointers } from '../../src/tables.js';
import { column, monitorSchemaFile } from '../support/schema.js';

const table = (name, columns) => ({ name, strict: false, unused: null, columns, indexes: [] });
const key = (name, primaryKey = 1) => column(name, { required: true, primaryKey });
const pointers = (tables) => tables.flatMap((each) => each.columns.filter((one) => one.references).map((one) => `${each.name}.${one.name}>${one.references.table}.${one.references.column}`));

describe('Tables', () => {
  describe('the Monitor’s pointers are inferred from column names, since its SQL declares none', () => {
    it('points a column at the table of its family keyed by a column of that name', () => {
      const { tables, inferred } = inferPointers([table('stability_runs', [key('run_id')]), table('stability_jobs', [key('run_id'), key('job_index', 2)])]);
      expect(pointers(tables)).toEqual(['stability_jobs.run_id>stability_runs.run_id']);
      expect(inferred).toBe(1);
      expect(tables[1].columns[0].references).toEqual({ table: 'stability_runs', column: 'run_id', onDelete: null, inferred: true });
    });

    it('points nothing at a table of another family, however alike the names', () => {
      const { tables, inferred } = inferPointers([table('stability_runs', [key('run_id')]), table('usage_requests', [key('request_id'), column('run_id')])]);
      expect(pointers(tables)).toEqual([]);
      expect(inferred).toBe(0);
    });

    it.each([
      { situation: 'the key has two columns', target: table('ci_attempts', [key('run_id'), key('attempt', 2)]) },
      { situation: 'the named column is not the key', target: table('ci_runs', [key('id'), column('run_id')]) },
    ])('points nothing at a table when $situation', ({ target }) => {
      const { tables } = inferPointers([target, table('ci_jobs', [key('job'), column('run_id')])]);
      expect(pointers(tables)).toEqual([]);
    });

    it('leaves a table’s own single-column key alone, since it names the table and points at none', () => {
      const { tables } = inferPointers([table('claude_calls', [key('id')]), table('claude_call_place', [key('id')])]);
      expect(pointers(tables)).toEqual([]);
    });

    it('keeps a pointer the file already declares', () => {
      const declared = column('run_id', { references: { table: 'elsewhere', column: 'id', onDelete: 'CASCADE' } });
      const { tables, inferred } = inferPointers([table('stability_runs', [key('run_id')]), table('stability_jobs', [declared])]);
      expect(tables[1].columns[0].references.table).toBe('elsewhere');
      expect(inferred).toBe(0);
    });
  });

  describe('a table’s name opens the line that defines it', () => {
    const typescript = { file: 'apps/api/src/db/schema.ts', text: "import x from 'y';\n\nexport const tenants = sqliteTable('tenants', {\n  id: text('id'),\n});\n" };
    const changes = { file: 'apps/api/src/accounts/changes.ts', text: "const a = 1;\nconst b = `CREATE TABLE items (\n  id TEXT\n)`;\n" };
    const migrate = (number, text) => ({ file: `apps/harness-monitor/migrations/${number}.sql`, text });

    it('finds a Register table’s Drizzle definition at its line', () => {
      expect(definitionOf(['apps/api/migrations/', 'apps/api/src/db/schema.ts'], [typescript], 'tenants')).toEqual({ file: 'apps/api/src/db/schema.ts', line: 3 });
    });

    it('finds an Account store table’s definition at its line', () => {
      expect(definitionOf(['apps/api/src/accounts/changes.ts'], [changes], 'items')).toEqual({ file: 'apps/api/src/accounts/changes.ts', line: 2 });
    });

    it('finds the last migration that creates a Monitor table or renames into it', () => {
      const sources = [
        migrate('0001', 'CREATE TABLE jobs (a TEXT);\n'),
        migrate('0002', 'CREATE TABLE jobs_new (a TEXT, b TEXT);\nINSERT INTO jobs_new SELECT a, a FROM jobs;\nDROP TABLE jobs;\nALTER TABLE jobs_new RENAME TO jobs;\n'),
        migrate('0003', 'CREATE TABLE other (a TEXT);\n'),
      ];
      expect(definitionOf(['apps/harness-monitor/migrations/'], sources, 'jobs')).toEqual({ file: 'apps/harness-monitor/migrations/0002.sql', line: 4 });
    });

    it('finds nothing for a table no file creates', () => {
      expect(definitionOf(['apps/harness-monitor/migrations/'], [migrate('0001', 'CREATE TABLE jobs (a TEXT);\n')], 'gone')).toBeNull();
    });
  });

  describe('the Monitor’s database is read from its own schema file', () => {
    const built = (file = monitorSchemaFile()) => buildTables(null, file, []).databases[0];

    it('holds the tables as the file does, with pointers inferred and nothing marked no longer used', () => {
      const monitor = built();
      expect(monitor.key).toBe('harness-monitor');
      expect(monitor.inferred).toBe(1);
      expect(pointers(monitor.tables)).toEqual(['stability_jobs.run_id>stability_runs.run_id']);
      expect(monitor.counts).toMatchObject({ tables: 3, unusedTables: 0, unusedColumns: 0, unusedIndexes: 0 });
    });

    it('draws no Monitor for an earlier commit that has no schema file', () => {
      expect(buildTables(null, null, [])).toBeNull();
    });

    it.each([
      { situation: 'is not JSON', text: '{ "databases": [' },
      { situation: 'holds no list of databases', text: JSON.stringify({ tables: [] }) },
      { situation: 'holds a database with no tables', text: JSON.stringify({ databases: [{ key: 'x' }] }) },
      { situation: 'holds a table without indexes', text: JSON.stringify({ databases: [{ key: 'x', tables: [{ name: 't', columns: [] }] }] }) },
    ])('refuses a schema file that $situation', ({ text }) => {
      expect(() => built({ file: 'apps/harness-monitor/database-schema.json', text })).toThrow(ReadError);
    });

  });
});
