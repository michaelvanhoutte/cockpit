/**
 * The table diagrams' model: each database's tables with what points at what, and where each table is defined.
 * Pure: the built Databases view, the Harness Monitor's schema file and the text of the files that define the
 * tables in, nothing touched.
 *
 * The register's and the account store's tables are the Databases view's, with the line that defines each. The
 * Monitor's come from its own schema file, which its integration test writes from the real database; its SQL
 * declares no foreign key, so a pointer is inferred where a column bears the name of the single-column key of
 * another table of the same family (`stability_jobs.run_id` and `stability_runs`, keyed by `run_id`). A family
 * is the part of a table's name before its first underscore. Nothing in the Monitor is marked no longer used:
 * its schema file records no queries to compare against.
 */

import { ReadError } from './errors.js';

export const MONITOR_SCHEMA_FILE = 'apps/harness-monitor/database-schema.json';

const family = (name) => name.split('_')[0];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every column of a table that is its whole primary key, by name; none for a key of several columns. */
const singleKey = (table) => {
  const keys = table.columns.filter((column) => column.primaryKey);
  return keys.length === 1 ? keys[0].name : null;
};

/** The Monitor's tables with a pointer where a column is named like another table's key; one the file already declares is kept. */
export function inferPointers(tables) {
  let inferred = 0;
  const drawn = tables.map((table) => {
    const own = singleKey(table);
    const columns = table.columns.map((column) => {
      if (column.references || column.name === own) return column;
      const target = tables.find((other) => other !== table && family(other.name) === family(table.name) && singleKey(other) === column.name);
      if (!target) return column;
      inferred += 1;
      return { ...column, references: { table: target.name, column: column.name, onDelete: null, inferred: true } };
    });
    return { ...table, columns };
  });
  return { tables: drawn, inferred };
}

/**
 * Where a table is defined: its Drizzle `sqliteTable` or `CREATE TABLE` in the database's TypeScript files, the
 * schema's own first; else the last migration that creates it or renames into it, since a table rebuilt by a
 * later migration has a first `CREATE` that is stale.
 * @param {string[]} definedIn the files and folders (ending in a slash) the database says it is defined in
 * @param {{ file: string, text: string }[]} sources the text of those files, and of the files in those folders
 */
export function definitionOf(definedIn, sources, name) {
  const lineAt = (text, index) => text.slice(0, index).split('\n').length;
  const quoted = escapeRegExp(name);
  const rule = new RegExp(`sqliteTable\\(\\s*['"\`]${quoted}['"\`]|CREATE TABLE(?: IF NOT EXISTS)?\\s+[\`"]?${quoted}[\`"]?\\s*\\(|RENAME TO\\s+[\`"]?${quoted}\\b`, 'i');
  const named = definedIn.filter((each) => !each.endsWith('/'));
  const folders = definedIn.filter((each) => each.endsWith('/'));
  const typescript = named.filter((file) => /\.ts$/.test(file)).sort((a, b) => Number(/schema/.test(b)) - Number(/schema/.test(a)));
  for (const file of typescript) {
    const text = sources.find((each) => each.file === file)?.text;
    const match = text?.match(rule);
    if (match) return { file, line: lineAt(text, match.index) };
  }
  let found = null;
  const migrations = sources.filter((each) => /\.sql$/.test(each.file) && folders.some((folder) => each.file.startsWith(folder))).sort((a, b) => a.file.localeCompare(b.file));
  for (const { file, text } of migrations) {
    const match = text.match(rule);
    if (match) found = { file, line: lineAt(text, match.index) };
  }
  return found;
}

function countsOf(tables) {
  return {
    tables: tables.length,
    columns: tables.reduce((sum, each) => sum + each.columns.length, 0),
    indexes: tables.reduce((sum, each) => sum + each.indexes.length, 0),
    unusedTables: tables.filter((each) => each.unused).length,
    unusedColumns: tables.reduce((sum, each) => sum + each.columns.filter((column) => column.unused).length, 0),
    unusedIndexes: tables.reduce((sum, each) => sum + each.indexes.filter((index) => index.unused).length, 0),
  };
}

/** The Monitor's database from its schema file, or null for an earlier commit that has none. */
function monitorOf(schema, sources) {
  if (schema === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(schema.text);
  } catch {
    throw new ReadError(schema.file, 'is not valid JSON');
  }
  const database = parsed?.databases?.[0];
  if (!Array.isArray(parsed?.databases) || !database || !Array.isArray(database.tables)) throw new ReadError(schema.file, 'holds no `databases` list');
  if (!database.tables.every((table) => table && Array.isArray(table.columns) && Array.isArray(table.indexes))) throw new ReadError(schema.file, 'holds a table without `columns` and `indexes` lists');
  const definedIn = database.definedIn ?? [];
  const { tables, inferred } = inferPointers(database.tables.map((table) => ({
    name: table.name,
    strict: table.strict,
    unused: null,
    columns: table.columns.map((column) => ({ ...column, unused: null })),
    indexes: table.indexes.map((index) => ({ ...index, unused: null })),
  })));
  const placed = tables.map((table) => ({ ...table, at: definitionOf(definedIn, sources, table.name) }));
  return { key: database.key, name: database.name, kind: database.kind, oneFor: database.oneFor, definedIn, file: schema.file, inferred, tables: placed, counts: countsOf(placed) };
}

/**
 * @param {object|null} database the Databases view's model: the register and the account store
 * @param {{ file: string, text: string } | null} monitorSchema
 * @param {{ file: string, text: string }[]} sources the files the databases are defined in
 * @returns {{ databases: object[] } | null} null when there is no schema to draw
 */
export function buildTables(database, monitorSchema, sources) {
  const cockpit = (database?.databases ?? []).map((each) => ({
    ...each,
    file: database.file,
    inferred: 0,
    tables: each.tables.map((table) => ({ ...table, at: definitionOf(each.definedIn, sources, table.name) })),
  }));
  const monitor = monitorOf(monitorSchema, sources);
  const databases = [...cockpit, ...(monitor ? [monitor] : [])];
  return databases.length ? { databases } : null;
}
