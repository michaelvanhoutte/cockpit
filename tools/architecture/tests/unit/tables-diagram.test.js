import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { linksFor } from '../../src/render/links.js';
import { renderErd, renderTablePages, tableFiles } from '../../src/render/tables.js';
import { buildTables } from '../../src/tables.js';
import { column, monitorSchemaFile } from '../support/schema.js';

const links = linksFor({ repo: 'o/r', commit: 'abc1234def5678' });
const key = (name) => column(name, { required: true, primaryKey: 1 });
const points = (name, table, to = 'id') => column(name, { references: { table, column: to, onDelete: 'NO ACTION' } });
const table = (name, columns, extra = {}) => ({ name, strict: false, unused: null, at: null, columns: columns.map((each) => ({ unused: null, ...each })), indexes: [], ...extra });
const draw = (tables, keysOnly = true) => renderErd({ name: 'Fixture', tables }, { keysOnly, columnsHref: 'cols.html', links });

/** Each table's left edge, from its box. */
const leftOf = (svg, name) => Number(new RegExp(`<g class="tb tbl-${name}">.*?<rect class="[a-z]+" x="(\\d+)"`).exec(svg)[1]);
const paths = (svg) => [...svg.matchAll(/<path class="rl ([^"]*)" d="([^"]*)"/g)].map(([, classes, d]) => ({ classes, d }));

describe('Table diagram', () => {
  describe('a table stands one column right of the deepest table it points at, and a pointer is a line from its row to the row it points at', () => {
    it('stands a table one column from the table it points at, with one line', () => {
      const { svg } = draw([table('workspaces', [key('id')]), table('items', [key('id'), points('workspace_id', 'workspaces')])]);
      expect(leftOf(svg, 'items') - leftOf(svg, 'workspaces')).toBeGreaterThan(0);
      expect(paths(svg)).toHaveLength(1);
      expect(paths(svg)[0].classes).toBe('lf-items lt-workspaces');
    });

    it('draws a line from the pointing column’s row out of the left edge to the row pointed at, at the right edge', () => {
      const { svg } = draw([table('workspaces', [key('id'), column('name')]), table('items', [key('id'), column('title'), points('workspace_id', 'workspaces')])], false);
      const baseline = (name, left) => Number(new RegExp(`<text class="db-c[^"]*" x="${left + 10}" y="(\\d+)">${name}</text>`).exec(svg)[1]);
      const [x1, y1, , , , , x2, y2] = paths(svg)[0].d.match(/-?[\d.]+/g).map(Number);
      expect(x1).toBe(leftOf(svg, 'items'));
      const width = Number(/<g class="tb tbl-workspaces">.*?width="(\d+)"/.exec(svg)[1]);
      expect(x2).toBe(leftOf(svg, 'workspaces') + width);
      expect(y1).toBe(baseline('workspace_id', leftOf(svg, 'items')) - 3);
      expect(y2).toBe(baseline('id', leftOf(svg, 'workspaces')) - 3);
    });

    it('leaves no empty column when two tables point at each other', () => {
      const { svg } = draw([table('a', [key('id'), points('b_id', 'b')]), table('b', [key('id'), points('a_id', 'a')])]);
      expect(Math.min(leftOf(svg, 'a'), leftOf(svg, 'b'))).toBe(30);
    });

    it('keeps the lines that skip a column from catching the pointer', () => {
      expect(readFileSync(new URL('../../src/render/tables.css', import.meta.url), 'utf8')).toMatch(/\.rl\.far \{[^}]*pointer-events: none/);
    });

    it('writes “→ table.column” on every pointing row', () => {
      const { svg } = draw([table('workspaces', [key('id')]), table('items', [key('id'), points('workspace_id', 'workspaces')])]);
      expect(svg).toContain('<tspan class="fk">→ workspaces.id</tspan>');
    });

    it('stands a table right of the deeper of two tables it points at', () => {
      const { svg } = draw([
        table('tenants', [key('id')]),
        table('workspaces', [key('id'), points('tenant_id', 'tenants')]),
        table('items', [key('id'), points('tenant_id', 'tenants'), points('workspace_id', 'workspaces')]),
      ]);
      expect(leftOf(svg, 'items')).toBeGreaterThan(leftOf(svg, 'workspaces'));
      expect(leftOf(svg, 'workspaces')).toBeGreaterThan(leftOf(svg, 'tenants'));
    });

    it('draws a pointer that skips a column, but shows it only while either end is hovered', () => {
      const { svg, focus } = draw([
        table('tenants', [key('id')]),
        table('workspaces', [key('id'), points('tenant_id', 'tenants')]),
        table('items', [key('id'), points('tenant_id', 'tenants'), points('workspace_id', 'workspaces')]),
      ]);
      const skipping = paths(svg).filter((each) => each.classes.includes(' far'));
      expect(skipping.map((each) => each.classes)).toEqual(['lf-items lt-tenants far']);
      expect(svg).toContain('<tspan class="fk">→ tenants.id</tspan>');
      expect(focus).toContain('svg.erd:has(.tbl-items:hover) .rl.lf-items, svg.erd:has(.tbl-items:hover) .rl.lt-items { opacity: 1;');
      expect(focus).toContain('svg.erd:has(.tbl-tenants:hover) .rl.lf-tenants, svg.erd:has(.tbl-tenants:hover) .rl.lt-tenants { opacity: 1;');
    });

    it('fades the tables a hovered table has nothing to do with', () => {
      const { focus } = draw([table('a', [key('id')]), table('b', [points('a_id', 'a')]), table('c', [key('id')]), table('d', [points('c_id', 'c')])]);
      expect(focus).toContain('svg.erd:has(.tbl-a:hover) .tb:not(.tbl-a):not(.tbl-b) { opacity: .3; }');
    });

    it('draws two tables pointing at each other, both once', () => {
      const { svg } = draw([table('a', [key('id'), points('b_id', 'b')]), table('b', [key('id'), points('a_id', 'a')])]);
      expect(svg.match(/<g class="tb /g)).toHaveLength(2);
      expect(paths(svg)).toHaveLength(2);
    });

    it('sets a table with no relations in the group at the bottom', () => {
      const { svg } = draw([table('workspaces', [key('id')]), table('items', [points('workspace_id', 'workspaces')]), table('settings', [key('name')])]);
      const label = Number(/<text class="t-m" x="30" y="(\d+)">Pointing at no table/.exec(svg)[1]);
      const top = (name) => Number(new RegExp(`<g class="tb tbl-${name}">.*?<rect class="[a-z]+" x="\\d+" y="(\\d+)"`).exec(svg)[1]);
      expect(top('settings')).toBeGreaterThan(label);
      expect(top('settings')).toBeGreaterThan(top('items'));
      expect(top('settings')).toBeGreaterThan(top('workspaces'));
    });
  });

  describe('Relations keeps the rows that matter to the lines, All columns every column with its type, whether it is required and the indexes', () => {
    const wide = () => [
      table('workspaces', [key('id')]),
      table('items', [key('id'), points('workspace_id', 'workspaces'), ...Array.from({ length: 38 }, (_, index) => column(`field_${index}`, { required: index === 0 })) , column('title', { required: true })]),
    ];

    it('shows a table of 40 columns as its key and pointer, with “+ 38 more columns” linking to All columns', () => {
      const { svg } = draw(wide());
      expect(svg).toContain('<a href="cols.html"><text class="db-more"');
      expect(svg).toContain('+ 39 more columns</text>');
      expect(svg).not.toContain('>field_0<');
    });

    it('shows every column on All columns, with its type and whether it is required', () => {
      const { svg } = draw(wide(), false);
      expect(svg).toContain('>field_37<');
      expect(svg).toContain('text · required</text>');
      expect(svg).not.toContain('db-more');
    });

    it('lists an index with its condition on All columns, and not on Relations', () => {
      const indexed = [table('items', [key('id'), column('deleted_at')], { indexes: [{ name: 'items_live_id', unique: true, columns: ['id'], where: 'deleted_at IS NULL', unused: null }] })];
      expect(draw(indexed, false).svg).toContain('unique items_live_id (id) where deleted_at IS NULL');
      expect(draw(indexed).svg).not.toContain('items_live_id');
    });

    it('ends an index too long for its box in an ellipsis, with the whole of it as a tooltip', () => {
      const long = 'x'.repeat(80);
      const { svg } = draw([table('items', [key('id')], { indexes: [{ name: 'items_wide', unique: false, columns: [long], unused: null }] })], false);
      expect(svg).toContain('…<title>');
      expect(svg).toContain(`<title>items_wide (${long})</title>`);
    });
  });

  describe('what is no longer used is struck through in red, with why', () => {
    it('strikes through a table marked no longer used and gives the reason as its tooltip', () => {
      const { svg } = draw([table('retired_rules', [column('rules', { unused: 'Nothing reads it.' })], { unused: 'Nothing reads it.' })], false);
      expect(svg).toContain('class="ghost"');
      expect(svg).toContain('<text class="t-h gone"');
      expect(svg).toContain('>no longer used</text>');
      expect(svg).toContain('<title>No longer used. Nothing reads it.</title>');
    });

    it('strikes through a column marked no longer used', () => {
      const { svg } = draw([table('items', [key('id'), column('status', { unused: 'Read nowhere.' })])], false);
      expect(svg).toContain('<text class="db-c gone"');
    });
  });

  describe('a table’s name opens the line that defines it on GitHub, at the commit drawn from', () => {
    it('links the name to the file and line', () => {
      const { svg } = draw([table('tenants', [key('id')], { at: { file: 'apps/api/src/db/schema.ts', line: 12 } })]);
      expect(svg).toContain('href="https://github.com/o/r/blob/abc1234def5678/apps/api/src/db/schema.ts#L12"');
      expect(svg).toContain('<tspan class="nc-gh" dx="6">↗</tspan>');
    });

    it('links nothing where the page does not know its repository and commit', () => {
      const { svg } = renderErd({ name: 'Fixture', tables: [table('tenants', [key('id')], { at: { file: 'apps/api/src/db/schema.ts', line: 12 } })] }, { keysOnly: true, columnsHref: 'c.html', links: linksFor({ repo: null, commit: null }) });
      expect(svg).not.toContain('↗');
      expect(svg).not.toContain('href="https');
    });
  });

  describe('each database is two pages that say where the pointers come from', () => {
    const model = () => ({
      drawnFrom: { commit: 'abc1234def5678', date: null, repo: 'o/r' },
      tables: buildTables(null, monitorSchemaFile(), []),
    });

    it('writes a Relations page and an All columns page, each the other’s second tab', () => {
      const pages = renderTablePages(model());
      const files = tableFiles('harness-monitor');
      expect(Object.keys(pages)).toEqual([files.relations, files.columns]);
      expect(pages[files.relations]).toContain('<span class="on">Relations</span><a href="db-harness-monitor-columns.html">All columns</a>');
      expect(pages[files.columns]).toContain('<a href="db-harness-monitor.html">Relations</a><span class="on">All columns</span>');
    });

    it('says the Monitor’s pointers are inferred, naming one', () => {
      const page = renderTablePages(model())[tableFiles('harness-monitor').relations];
      expect(page).toContain('Its SQL declares no foreign key, so the 1 pointer here is inferred');
      expect(page).toContain('<code>stability_jobs.run_id</code> and <code>stability_runs</code>');
    });

    it('says no pointer is drawn where none is inferred', () => {
      const file = monitorSchemaFile({ databases: [{ ...JSON.parse(monitorSchemaFile().text).databases[0], tables: [{ name: 'alone', strict: false, columns: [column('id')], indexes: [] }] }] });
      const page = renderTablePages({ drawnFrom: model().drawnFrom, tables: buildTables(null, file, []) })[tableFiles('harness-monitor').relations];
      expect(page).toContain('no pointer is drawn');
    });

    it('writes nothing for a model with no tables', () => {
      expect(renderTablePages({ drawnFrom: model().drawnFrom, tables: null })).toEqual({});
    });
  });
});
