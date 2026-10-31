import { describe, expect, it } from 'vitest';

import { buildDatabase } from '../../src/database.js';
import { renderDatabase } from '../../src/render/database.js';
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

/** Draws the support schema's database `key` after `change` has edited the file. */
const drawn = (key, change, code) => {
  const { register, store } = built(code, change);
  return renderDatabase({ database: { databases: [register, store] } }, key);
};
/** A database of the given tables alone, drawn. */
const drawnTables = (tables) => {
  const named = tables.flatMap((each) => [each.name, ...each.columns.map((one) => one.name)]).join(' ');
  return drawn('account-store', (file) => { file.databases[1].tables = tables; }, source(['apps/api/src/uses.ts', named]));
};
const table = (name, pointsAt = []) => ({
  name,
  strict: true,
  queriedAs: name,
  columns: [column('id', { required: true, primaryKey: 1, queriedAs: 'id' }), ...pointsAt.map((parent) => column(`${parent}_id`, { references: { table: parent, column: 'id', onDelete: 'CASCADE' } }))],
  indexes: [],
});

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

  describe('each database is a diagram of its own, kept visibly apart', () => {
    it('draws the register as one frame, saying it is one for every account', () => {
      const svg = drawn('register');
      expect(svg.match(/<rect class="db-frame shared"/g)).toHaveLength(1);
      expect(svg).not.toContain('db-frame back');
      expect(svg).toContain('>D1, one for every account</text>');
    });

    it('draws the account store as a stack of frames, saying it is one for each account', () => {
      const svg = drawn('account-store');
      expect(svg.match(/<rect class="db-frame back"/g)).toHaveLength(2);
      expect(svg.match(/<rect class="db-frame"/g)).toHaveLength(1);
      expect(svg).not.toContain('db-frame shared');
      expect(svg).toContain('>Durable Object, one for each account</text>');
    });

    it('draws only its own database’s tables, and gives its arrow a name no other diagram on the page shares', () => {
      const register = drawn('register');
      const store = drawn('account-store');
      expect(boxesOf(register).map((each) => each.name).sort()).toEqual(['old_items', 'tenants']);
      expect(boxesOf(store).map((each) => each.name).sort()).toEqual(['hidden_things', 'items', 'retired_rules', 'workspaces']);
      expect(register).toContain('<marker id="db-arrow-register"');
      expect(register).toContain('marker-end="url(#db-arrow-register)"');
      expect(store).toContain('<marker id="db-arrow-account-store"');
      expect(store).toContain('marker-end="url(#db-arrow-account-store)"');
    });

    it('says plainly that the commit has no schema file to draw from, rather than drawing nothing', () => {
      const svg = renderDatabase({ database: null }, 'register');
      expect(svg).toContain('This commit has no schema file to draw this database from.');
    });
  });

  describe('a diagram draws every table with its columns and indexes, and a line from a column to the table it points at', () => {
    it.each([
      { situation: 'a key column: key, type, required', expected: ['id', 'key · text · required'] },
      { situation: 'a required column: type, required', expected: ['workspace_id', 'text · required'] },
      { situation: 'an optional column: its type alone', expected: ['forgotten_at', 'text'] },
    ])('$situation', ({ expected }) => {
      expect(columnRows(drawn('account-store'))).toContainEqual(expected);
    });

    it('says "any" for a column with no declared type', () => {
      const svg = drawn('register', (file) => file.databases[0].tables[0].columns.push(column('payload', { type: null })));
      expect(columnRows(svg)).toContainEqual(['payload', 'any']);
    });

    it('lists every table’s every column', () => {
      const store = built().store;
      const svg = drawn('account-store');
      expect(columnRows(svg).map(([name]) => name).sort()).toEqual(store.tables.flatMap((each) => each.columns.map((one) => one.name)).sort());
    });

    it.each([
      { situation: 'an index: its name, and its columns', lines: ['items_workspace_status', '(workspace_id, status)'] },
      { situation: 'a unique index with a condition: unique, its columns and the condition', lines: ['unique items_live_id', '(id) where deleted_at IS NULL'] },
    ])('$situation', ({ lines }) => {
      expect(indexLines(drawn('account-store'))).toEqual(expect.arrayContaining(lines));
    });

    it('wraps an index’s long condition inside its table box without losing a word', () => {
      const where = 'deleted_at IS NULL AND forgotten_at IS NULL AND workspace_id IS NOT NULL AND status = 1';
      const svg = drawn('account-store', (file) => file.databases[1].tables[1].indexes.push({ name: 'items_long', unique: false, columns: ['id'], where }));
      const lines = indexLines(svg);
      const body = lines.slice(lines.indexOf('items_long') + 1); // the last index drawn, so its lines are the last
      expect(body.length).toBeGreaterThan(1);
      expect(body.join(' ')).toBe(`(id) where ${where}`);
    });

    it.each([
      { situation: 'a column pointing at another table, saying what happens on delete', key: 'register', title: 'old_items.tenant_id points at tenants.id (on delete no action)' },
      { situation: 'a column pointing at another table, with the other action on delete', key: 'account-store', title: 'items.workspace_id points at workspaces.id (on delete restrict)' },
    ])('draws $situation', ({ key, title }) => {
      const edges = edgesOf(drawn(key));
      expect(edges.map((each) => each.title)).toEqual([title]);
    });

    it('starts a line at the column and ends it at the table the column points at', () => {
      const svg = drawn('account-store');
      const [edge] = edgesOf(svg);
      const [child, parent] = ['items', 'workspaces'].map((name) => boxesOf(svg).find((each) => each.name === name));
      const [, sx, sy] = edge.d.match(/^M (\S+) (\S+) /);
      const [ex, ey] = edge.d.match(/(\S+) (\S+)$/).slice(1).map(Number);
      expect([Number(sx) === child.x || Number(sx) === child.x + child.width, Number(sy) > child.y && Number(sy) < child.y + child.height]).toEqual([true, true]);
      expect([ex > parent.x && ex < parent.x + parent.width, ey]).toEqual([true, parent.y + parent.height + 2]);
    });

    it('stands a table below every table it points at', () => {
      const svg = drawnTables([table('c', ['a', 'b']), table('b', ['a']), table('d', ['c']), table('a')]);
      const box = Object.fromEntries(boxesOf(svg).map((each) => [each.name, each]));
      for (const [child, parents] of Object.entries({ b: ['a'], c: ['a', 'b'], d: ['c'] })) {
        for (const parent of parents) expect(box[child].y).toBeGreaterThan(box[parent].y + box[parent].height);
      }
      expect(edgesOf(svg)).toHaveLength(4);
    });

    it('loops a column pointing at its own table back to it', () => {
      const folders = { ...table('folders'), columns: [column('id', { required: true, primaryKey: 1, queriedAs: 'id' }), column('parent_id', { references: { table: 'folders', column: 'id', onDelete: 'SET NULL' } })] };
      const svg = drawnTables([folders]);
      const edges = edgesOf(svg);
      expect(edges.map((each) => each.title)).toEqual(['folders.parent_id points at folders.id (on delete set null)']);
      const [, startX, endX] = edges[0].d.match(/^M (\S+) \S+ h 24 V \S+ H (\S+)$/);
      const [box] = boxesOf(svg);
      expect([Number(startX), Number(endX)]).toEqual([box.x + box.width, box.x + box.width]);
    });

    it('wraps more tables in a row than fit onto a further row, without two boxes overlapping', () => {
      const children = Array.from({ length: 9 }, (_, at) => table(`child_${at}`, ['root']));
      const svg = drawnTables([table('root'), ...children]);
      const boxes = boxesOf(svg);
      const rows = [...new Set(boxes.filter((each) => each.name.startsWith('child_')).map((each) => each.y))].sort((a, b) => a - b);
      expect(rows).toHaveLength(2);
      expect(boxes.filter((each) => each.y === rows[0])).toHaveLength(7);
      expect(boxes.filter((each) => each.y === rows[1])).toHaveLength(2);
      expect(Math.min(...boxes.filter((each) => each.y === rows[1]).map((each) => each.x))).toBe(Math.min(...boxes.filter((each) => each.y === rows[0]).map((each) => each.x)));
      expect(overlapping(boxes)).toEqual([]);
      expect(edgesOf(svg)).toHaveLength(9);
    });

    it('draws tables pointing at each other in a cycle, each with its lines', () => {
      const svg = drawnTables([table('root'), table('m', ['root', 't']), table('t', ['m']), table('n', ['root'])]);
      expect(boxesOf(svg).map((each) => each.name).sort()).toEqual(['m', 'n', 'root', 't']);
      expect(edgesOf(svg)).toHaveLength(4);
      expect(overlapping(boxesOf(svg))).toEqual([]);
    });

    it('draws a database with no tables as its frame, saying 0 tables, with nothing missing or off the frame', () => {
      const svg = drawn('account-store', (file) => { file.databases[1].tables = []; });
      expect(svg).toContain('>0 tables, 0 columns, 0 indexes</text>');
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
      expect(boxesOf(svg)).toEqual([]);
      expect(overflowing(svg)).toEqual([]);
    });

    it('keeps a small database’s own heading inside its frame', () => {
      expect(overflowing(drawn('register'))).toEqual([]);
    });

    it('stands a table pointing at nothing, and pointed at by nothing, at the foot of its database', () => {
      const svg = drawnTables([table('b', ['a']), table('loose_one'), table('a'), table('loose_two')]);
      const box = Object.fromEntries(boxesOf(svg).map((each) => [each.name, each]));
      const linkedBottom = Math.max(box.a.y + box.a.height, box.b.y + box.b.height);
      expect(box.loose_one.y).toBeGreaterThan(linkedBottom);
      expect(box.loose_two.y).toBe(box.loose_one.y);
      expect(svg).toContain('>Pointing at no table, and no table pointing at them</text>');
    });

    it('has no foot to stand at when every table is linked', () => {
      expect(drawnTables([table('b', ['a']), table('a')])).not.toContain('Pointing at no table');
    });

    it('draws no line for a column pointing at a table the database does not have, and stands its table at the foot', () => {
      const svg = drawnTables([table('orphan', ['elsewhere'])]);
      expect(edgesOf(svg)).toEqual([]);
      expect(boxesOf(svg).map((each) => each.name)).toEqual(['orphan']);
      expect(svg).toContain('Pointing at no table');
    });
  });

  describe('what is no longer used is drawn red and struck through, with why on hover', () => {
    const svg = drawn('account-store');

    it('marks a table: a dashed red box, its name struck through, the words "no longer used", and its reason as the tooltip', () => {
      expect(svg).toMatch(/<g><title>No longer used\. Nothing reads it\.<\/title>\s*<rect class="ghost"/);
      expect(svg).toMatch(/<text class="t-h gone" [^>]*>retired_rules<\/text>/);
      expect(svg.match(/<text class="t-red"/g)).toHaveLength(2);
    });

    it('marks a column: its name and its type struck through, its reason as the tooltip', () => {
      expect(svg).toMatch(/<g><title>No longer used\. Written on every insert, read nowhere\.<\/title><text class="db-c gone" [^>]*>status<\/text><text class="db-t gone" [^>]*>text · required<\/text><\/g>/);
    });

    it('marks an index: its name struck through, its reason as the tooltip', () => {
      expect(svg).toMatch(/<g><title>No longer used\. Covers status, which is no longer used\.<\/title><text class="db-i head gone" [^>]*>items_workspace_status<\/text><\/g>/);
    });

    it('marks all of it and nothing else, and counts it in the heading', () => {
      const tips = [...svg.matchAll(/<title>No longer used\. ([^<]*)<\/title>/g)].map((each) => each[1]).sort();
      expect(tips).toEqual([
        'Covers status, which is no longer used.', // an index has a tooltip on each of its two lines
        'Covers status, which is no longer used.',
        'No code outside the databases’ schema files names it.',
        'No code outside the databases’ schema files names it.',
        'Nothing reads it.',
        'Written on every insert, read nowhere.',
      ]);
      const struck = [...svg.matchAll(/<text class="(?:t-h|db-c|db-i)[^"]*\bgone\b[^"]*"[^>]*>([^<]*)</g)].map((each) => each[1]);
      expect(struck.sort()).toEqual(['(workspace_id, status)', 'forgotten_at', 'hidden_things', 'items_workspace_status', 'retired_rules', 'status']);
      expect(svg).toContain('no longer used: 2 tables, 2 columns, 1 index</text>');
    });

    it('marks nothing in a database that uses everything', () => {
      const clean = drawnTables([table('b', ['a']), table('a')]);
      expect(clean).not.toMatch(/gone|ghost|No longer used|no longer used/);
    });
  });
});

/** Each table's box, in the order drawn: its name and where it stands. */
function boxesOf(svg) {
  const names = [...svg.matchAll(/<text class="t-h(?: gone)?" [^>]*>([^<]*)<\/text>/g)].map((each) => each[1]);
  const rects = [...svg.matchAll(/<rect class="(?:box|ghost)" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
  return rects.map((each, at) => ({ name: names[at], x: Number(each[1]), y: Number(each[2]), width: Number(each[3]), height: Number(each[4]) }));
}
const overlapping = (boxes) => boxes.flatMap((a, at) => boxes.slice(at + 1).filter((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).map((b) => `${a.name} / ${b.name}`));
const edgesOf = (svg) => [...svg.matchAll(/<path class="edge" d="([^"]*)" marker-end="[^"]*"><title>([^<]*)<\/title><\/path>/g)].map((each) => ({ d: each[1], title: each[2] }));
const columnRows = (svg) => [...svg.matchAll(/<text class="db-c[^"]*" [^>]*>([^<]*)<\/text><text class="db-t[^"]*" [^>]*>([^<]*)<\/text>/g)].map((each) => [each[1], each[2]]);
const indexLines = (svg) => [...svg.matchAll(/<text class="db-i[^"]*" [^>]*>([^<]*)<\/text>/g)].map((each) => each[1]);

/** The frame's own heading lines that run past its right or bottom edge, at an estimate of a character's width that errs wide. */
function overflowing(svg) {
  const frames = [...svg.matchAll(/<rect class="db-frame[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
  const [x, y, width, height] = frames.at(-1).slice(1).map(Number); // the front frame is drawn last
  return [...svg.matchAll(/<text class="(t-w|t-i|t-m)" x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/g)]
    .filter(([, , , textY]) => Number(textY) <= y + 76) // the heading's three lines, not a label between the tables
    .filter(([, cls, textX, textY, text]) => Number(textX) + text.length * (cls === 't-w' ? 8.4 : 6.5) > x + width || Number(textY) > y + height)
    .map((each) => each[4]);
}
