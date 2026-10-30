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
 * | the schema file writes it down | its own reason |
 * | the schema queries are written against does not define it | no query is written against it |
 * | no source file outside the schema's own files names it, by its SQL name or the name queries use | no code names it |
 * | an index on a column, or a table, that is no longer used | it covers that column |
 */

import { ReadError } from './errors.js';

export const SCHEMA_FILE = 'apps/api/database-schema.json';

const NO_QUERY = 'No query is written against it: the schema queries use does not define it.';
const NO_CODE = 'No code outside the schema’s own files names it.';

/** Every identifier in the source files outside the schema's own, as one set to look a name up in. */
function namedInCode(candidates, definedIn) {
  const ownFile = (file) => definedIn.some((each) => (each.endsWith('/') ? file.startsWith(each) : file === each));
  const names = new Set();
  for (const area of candidates) {
    for (const { file, text } of area.files) {
      if (text === null || ownFile(file)) continue;
      for (const word of text.match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(word);
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

  const databases = parsed.databases.map((database) => {
    const named = namedInCode(candidates, database.definedIn ?? []);
    const tables = database.tables.map((table) => {
      const unused = unusedBecause(table, named);
      const columns = table.columns.map((column) => ({ ...column, unused: unused ? null : unusedBecause(column, named) }));
      const unusedColumns = new Map(columns.filter((each) => each.unused).map((each) => [each.name, each.unused]));
      const indexes = table.indexes.map((index) => {
        const covers = index.columns.map((each) => each.replace(/ DESC$/, '')).filter((each) => unusedColumns.has(each));
        return { ...index, unused: unused ? null : covers.length ? `Covers ${covers.join(', ')}, which ${covers.length === 1 ? 'is' : 'are'} no longer used.` : null };
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
