/**
 * The Database view's model: the schema file the API's tests write from a real
 * store and a real register in, each table with its columns and indexes and
 * what in them is no longer used out. Pure: the file's text and the source
 * files already read for the Modules view in, nothing touched.
 *
 * Something is no longer used, in this order of evidence:
 *
 * | Evidence | Said as |
 * |---|---|
 * | the list in the store's schema (`NO_LONGER_USED`) writes it down | its own reason |
 * | the schema queries are written against does not define it | no query is written against it |
 * | no source file outside either database's schema files names it, by its SQL name or the name queries use, comments aside | no code names it |
 * | an index covering a column that is no longer used | it covers that column |
 *
 * A column of a table that is no longer used is not marked again, and nor is
 * an index of one.
 */

import { ReadError } from './errors.js';

export const SCHEMA_FILE = 'apps/api/database-schema.json';

const NO_QUERY = 'No query is written against it: the schema queries use does not define it.';
const NO_CODE = 'No code outside the databases’ schema files names it.';

/**
 * Every identifier in the source files outside any database's schema files, as
 * one set to look a name up in. Block comments and whole-line comments are
 * left out, since a comment naming a column is not a use of it; a `//` after
 * code on the same line is kept, as it may be inside a string.
 */
function namedInCode(candidates, schemaFiles) {
  const schemaFile = (file) => schemaFiles.some((each) => (each.endsWith('/') ? file.startsWith(each) : file === each));
  const names = new Set();
  for (const area of candidates) {
    for (const { file, text } of area.files) {
      if (text === null || schemaFile(file)) continue;
      const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      for (const word of code.match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(word);
    }
  }
  return names;
}

function unusedBecause(entry, named) {
  if (typeof entry.noLongerUsed === 'string') return entry.noLongerUsed;
  if (!entry.queriedAs) return NO_QUERY;
  if (!named.has(entry.name) && !named.has(entry.queriedAs)) return NO_CODE;
  return null;
}

/**
 * @param {{ file: string, text: string } | null} schema the schema file, or null for an earlier commit that has none
 * @param {object[]} candidates the areas found on disk, each with its files' text
 */
export function buildDatabase(schema, candidates) {
  if (schema === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(schema.text);
  } catch {
    throw new ReadError(schema.file, 'is not valid JSON');
  }
  if (!Array.isArray(parsed?.databases)) throw new ReadError(schema.file, 'holds no `databases` list');

  // One database's schema files name the other's columns too (`created_at`, `name`), so none of them counts as a use.
  const named = namedInCode(candidates, parsed.databases.flatMap((database) => database.definedIn ?? []));
  const databases = parsed.databases.map((database) => {
    const tables = database.tables.map((table) => {
      const unused = unusedBecause(table, named);
      const columns = table.columns.map((column) => ({ ...column, unused: unused ? null : unusedBecause(column, named) }));
      const unusedColumns = new Set(columns.filter((each) => each.unused).map((each) => each.name));
      const indexes = table.indexes.map((index) => {
        const covers = index.columns.map((each) => each.replace(/ DESC$/, '')).filter((each) => unusedColumns.has(each));
        return { ...index, unused: covers.length ? `Covers ${covers.join(', ')}, which ${covers.length === 1 ? 'is' : 'are'} no longer used.` : null };
      });
      return { name: table.name, strict: table.strict, unused, columns, indexes };
    });
    return {
      key: database.key,
      name: database.name,
      kind: database.kind,
      oneFor: database.oneFor,
      definedIn: database.definedIn ?? [],
      tables,
      counts: {
        tables: tables.length,
        columns: tables.reduce((sum, each) => sum + each.columns.length, 0),
        indexes: tables.reduce((sum, each) => sum + each.indexes.length, 0),
        unusedTables: tables.filter((each) => each.unused).length,
        unusedColumns: tables.reduce((sum, each) => sum + each.columns.filter((column) => column.unused).length, 0),
        unusedIndexes: tables.reduce((sum, each) => sum + each.indexes.filter((index) => index.unused).length, 0),
      },
    };
  });
  return { file: schema.file, databases };
}
