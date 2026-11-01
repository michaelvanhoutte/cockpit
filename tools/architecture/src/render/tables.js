/**
 * The table diagrams: each database on two pages, its tables left to right with a line from each pointing
 * column's row to the exact row it points at. Relations keeps the rows that matter to the lines; All columns
 * holds every column and each table's indexes. The model in, self-contained HTML files out.
 *
 * A table stands one column right of the deepest table it points at, so every line runs out of the table's
 * left edge into the right edge of the row it points at. A pointer that skips a column would cross tables, so
 * it is drawn only while either end is hovered; its row says where it points either way.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commitLineOf, linkPaths, linksFor } from './links.js';
import { LOGICAL_FILE, servicesOf } from './logical.js';
import { crumbTrail, switchNav, trailOf } from './shell.js';
import { esc } from './svg.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const uniq = (list) => [...new Set(list)];
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
/** The text cut to  characters, ending in an ellipsis where it was cut. */
const fitted = (text, room) => (text.length > room ? `${text.slice(0, room - 1)}…` : text);
const css = (name) => name.replace(/[^a-z0-9_]/gi, '');

/** The two pages of a database: Relations, then All columns. */
export const tableFiles = (key) => ({ relations: `db-${key}.html`, columns: `db-${key}-columns.html` });

/**
 * One database's tables as an SVG, and the CSS that makes hovering a table show its lines and fade the rest.
 * @param {{ name: string, tables: object[] }} database
 * @param {{ keysOnly: boolean, columnsHref: string, links: ReturnType<typeof linksFor> }} options `keysOnly` keeps the rows that are a key, point somewhere or are pointed at
 * @returns {{ svg: string, focus: string }}
 */
export function renderErd(database, { keysOnly, columnsHref, links }) {
  const tables = database.tables;
  const byName = new Map(tables.map((table) => [table.name, table]));
  const target = (column) => column.references.column ?? 'id';
  const refs = (table) => table.columns.filter((column) => column.references && byName.has(column.references.table) && column.references.table !== table.name);
  const parentsOf = (table) => uniq(refs(table).map((column) => column.references.table));
  const childrenOf = (table) => tables.filter((other) => parentsOf(other).includes(table.name));
  const pointedAt = new Set(tables.flatMap((table) => refs(table).map((column) => `${column.references.table}.${target(column)}`)));
  const linked = tables.filter((table) => parentsOf(table).length || childrenOf(table).length);
  const alone = tables.filter((table) => !linked.includes(table));

  // A table's column is one more than the deepest table it points at; a pointer back to a table still being walked counts for nothing, so a cycle leaves no empty column.
  const depth = new Map();
  const depthOf = (table, walking = new Set()) => {
    if (depth.has(table.name)) return depth.get(table.name);
    if (walking.has(table.name)) return -1;
    walking.add(table.name);
    const deepest = parentsOf(table).reduce((most, name) => Math.max(most, depthOf(byName.get(name), walking) + 1), 0);
    walking.delete(table.name);
    depth.set(table.name, deepest);
    return deepest;
  };
  linked.forEach((table) => depthOf(table));

  const CHAR = 6.9, LINE = 18, HEAD = 30, PAD = 10, GAPX = 150, GAPY = 20;
  const shown = (table) => table.columns.filter((column) => !keysOnly || column.primaryKey || column.references || pointedAt.has(`${table.name}.${column.name}`));
  const pointer = (column) => (column.references ? `→ ${column.references.table}.${target(column)}` : '');
  const rest = (column) => [column.primaryKey ? 'key' : null, (column.type ?? 'any').toLowerCase(), !keysOnly && column.required && !column.primaryKey ? 'required' : null].filter(Boolean).join(' · ');
  const width = Math.ceil(Math.max(250, ...tables.flatMap((table) => shown(table).map((column) => (column.name.length + pointer(column).length + rest(column).length + 4) * CHAR + 2 * PAD))));
  const indexText = (index) => `${index.unique ? 'unique ' : ''}${index.name} (${index.columns.join(', ')})${index.where ? ` where ${index.where}` : ''}`;
  const heightOf = (table) => {
    const more = table.columns.length - shown(table).length;
    return HEAD + shown(table).length * LINE + (more ? LINE : 0) + (!keysOnly && table.indexes.length ? 12 + table.indexes.length * 15 : 0) + 8;
  };

  const box = new Map();
  const stacks = [];
  for (const table of linked) (stacks[depth.get(table.name)] ??= []).push(table);
  let bottom = 30;
  stacks.forEach((list, column) => {
    const x = 30 + column * (width + GAPX);
    const centre = (table) => mean(parentsOf(table).filter((name) => box.has(name)).map((name) => box.get(name).y + box.get(name).h / 2));
    const ordered = column === 0
      ? [...list].sort((a, b) => childrenOf(b).length - childrenOf(a).length || a.name.localeCompare(b.name))
      : [...list].sort((a, b) => centre(a) - centre(b) || a.name.localeCompare(b.name));
    let y = 30;
    for (const table of ordered) {
      box.set(table.name, { t: table, x, y, h: heightOf(table) });
      y += heightOf(table) + GAPY;
    }
    bottom = Math.max(bottom, y);
  });

  // Tables with no relations sit together at the bottom.
  const aloneTop = bottom + 30;
  const perRow = Math.max(3, stacks.length);
  let right = 30 + Math.max(1, stacks.length) * (width + GAPX) - GAPX;
  if (alone.length) {
    let rowTop = aloneTop + 26, rowH = 0;
    [...alone].sort((a, b) => a.name.localeCompare(b.name)).forEach((table, index) => {
      if (index && index % perRow === 0) {
        rowTop += rowH + GAPY;
        rowH = 0;
      }
      const x = 30 + (index % perRow) * (width + 40);
      box.set(table.name, { t: table, x, y: rowTop, h: heightOf(table) });
      rowH = Math.max(rowH, heightOf(table));
      right = Math.max(right, x + width);
    });
    bottom = rowTop + rowH + 20;
  }

  const rowY = (placed, name) => {
    const index = shown(placed.t).findIndex((column) => column.name === name);
    return placed.y + (index < 0 ? HEAD / 2 : HEAD + index * LINE + LINE / 2);
  };
  const near = [];
  const far = [];
  for (const table of linked) {
    const placed = box.get(table.name);
    for (const column of refs(table)) {
      const into = box.get(column.references.table);
      const [x1, y1, x2, y2] = [placed.x, rowY(placed, column.name), into.x + width, rowY(into, target(column))];
      const bend = Math.max(50, (x1 - x2) / 2);
      const d = `M${x1},${y1} C${x1 - bend},${y1} ${x2 + bend},${y2} ${x2},${y2}`;
      const title = `${table.name}.${column.name} points at ${column.references.table}.${target(column)}${column.references.inferred ? ' (inferred from the column name)' : ''}${column.references.onDelete ? ` (on delete ${column.references.onDelete.toLowerCase()})` : ''}`;
      const skips = Math.abs(depth.get(table.name) - depth.get(into.t.name)) > 1;
      (skips ? far : near).push(`<path class="rl lf-${css(table.name)} lt-${css(into.t.name)}${skips ? ' far' : ''}" d="${d}" marker-end="url(#erd-a)" marker-start="url(#erd-o)"><title>${esc(title)}</title></path>`);
    }
  }

  const tip = (reason) => (reason ? `<title>${esc(`No longer used. ${reason}`)}</title>` : '');
  const boxes = [];
  for (const { t, x, y, h } of box.values()) {
    const href = t.at ? links.url(t.at.file, { line: t.at.line }) : null;
    const rows = shown(t);
    const name = `<text class="t-h${t.unused ? ' gone' : ''}" x="${x + PAD}" y="${y + 17}">${esc(t.name)}${href ? '<tspan class="nc-gh" dx="6">↗</tspan>' : ''}</text>`;
    const parts = [
      `<g class="tb tbl-${css(t.name)}">${tip(t.unused)}<rect class="${t.unused ? 'ghost' : 'box'}" x="${x}" y="${y}" width="${width}" height="${h}" rx="5"/><rect class="soft" x="${x}" y="${y}" width="${width}" height="${HEAD - 6}" rx="5"/>`
        + (href ? `<a class="code" href="${esc(href)}" target="_blank" rel="noopener"><title>${esc(`Where it is defined, on GitHub: ${t.at.file}:${t.at.line}`)}</title>${name}</a>` : name),
    ];
    if (t.unused) parts.push(`<text class="t-red" x="${x + width - PAD}" y="${y + 17}" text-anchor="end">no longer used</text>`);
    rows.forEach((column, index) => {
      const cy = y + HEAD + index * LINE + 12;
      const gone = column.unused ? ' gone' : '';
      parts.push(`<g>${tip(column.unused)}<text class="db-c${gone}${column.primaryKey ? ' pk' : ''}" x="${x + PAD}" y="${cy}">${esc(column.name)}</text><text class="db-t${gone}" x="${x + width - PAD}" y="${cy}" text-anchor="end">${column.references ? `<tspan class="fk">${esc(pointer(column))}</tspan>  ` : ''}${esc(rest(column))}</text></g>`);
    });
    const more = t.columns.length - rows.length;
    if (more) parts.push(`<a href="${esc(columnsHref)}"><text class="db-more" x="${x + PAD}" y="${y + HEAD + rows.length * LINE + 12}">+ ${plural(more, 'more column')}</text></a>`);
    if (!keysOnly && t.indexes.length) {
      const iy = y + HEAD + rows.length * LINE + (more ? LINE : 0) + 4;
      parts.push(`<line class="db-sep" x1="${x}" y1="${iy}" x2="${x + width}" y2="${iy}"/>`);
      t.indexes.forEach((index, row) => {
        parts.push(`<g>${tip(index.unused)}<text class="db-i${index.unused ? ' gone' : ''}" x="${x + PAD}" y="${iy + 16 + row * 15}">${esc(fitted(indexText(index), Math.floor((width - 2 * PAD) / 6.2)))}<title>${esc(indexText(index))}</title></text></g>`);
      });
    }
    parts.push('</g>');
    boxes.push(parts.join(''));
  }

  // Hovering a table shows its own lines, far ones included, and fades the tables it has nothing to do with.
  const focus = linked.map((table) => {
    const s = css(table.name);
    const kin = uniq([table.name, ...parentsOf(table), ...childrenOf(table).map((other) => other.name)]).map(css);
    return `svg.erd:has(.tbl-${s}:hover) .rl:not(.lf-${s}):not(.lt-${s}) { opacity: .05; }
svg.erd:has(.tbl-${s}:hover) .rl.lf-${s}, svg.erd:has(.tbl-${s}:hover) .rl.lt-${s} { opacity: 1; stroke: var(--accent); stroke-width: 2; }
svg.erd:has(.tbl-${s}:hover) .tb${kin.map((each) => `:not(.tbl-${each})`).join('')} { opacity: .3; }`;
  }).join('\n');

  const height = bottom + 20;
  const svg = `<svg class="erd" width="${right + 30}" height="${height}" viewBox="0 0 ${right + 30} ${height}" role="img" aria-label="${esc(database.name)}: its tables and what points at what">
<defs><marker id="erd-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mh" d="M0,0 L10,5 L0,10 z"/></marker><marker id="erd-o" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6"><circle class="erd-o" cx="5" cy="5" r="3.5"/></marker></defs>
${near.join('\n')}
${boxes.join('\n')}
${alone.length ? `<text class="t-m" x="30" y="${aloneTop + 14}">Pointing at no table, and no table pointing at them</text>` : ''}
${far.join('\n')}
</svg>`;
  return { svg, focus };
}

/** What a database's page says about where its pointers come from. */
function sourceOf(database, links) {
  const file = links.file(database.file);
  if (database.key === 'register') return `One database every account shares. Read from ${file}.`;
  if (database.key === 'account-store') return `One database inside each account's Durable Object, all alike. Read from ${file}.`;
  const example = database.tables.flatMap((table) => table.columns.filter((column) => column.references?.inferred).map((column) => `<code>${esc(table.name)}.${esc(column.name)}</code> and <code>${esc(column.references.table)}</code>`))[0];
  const declared = database.tables.reduce((n, table) => n + table.columns.filter((column) => column.references && !column.references.inferred && column.references.table !== table.name && database.tables.some((other) => other.name === column.references.table)).length, 0);
  const inferredWord = !database.inferred ? '' : `${plural(database.inferred, 'pointer')} here ${database.inferred === 1 ? 'is' : 'are'} inferred: a column named like the key of another table of the same family, such as ${example}.`;
  const pointers = declared
    ? `its SQL declares ${plural(declared, 'foreign key')}${database.inferred ? `, and the ${inferredWord}` : '.'}`
    : database.inferred
      ? `its SQL declares no foreign key, so the ${inferredWord}`
      : 'its SQL declares no foreign key, and no column is named like the key of another table of the same family, so no pointer is drawn.';
  return `Read from ${file}, which the Monitor's own tests write from the database once every migration has run. ${pointers[0].toUpperCase()}${pointers.slice(1)}`;
}

const LEGEND = (example) => `<div class="legend"><span><i class="ln"></i>A column pointing at another table's column: from its row to that row</span><span><code class="fk-k">${esc(example)}</code> written on every pointing row, whether or not its line is drawn</span><span><i class="ln" style="border-top-color:var(--red)"></i>Struck through in red: no longer used</span></div><p class="sectionnote">Hover a table to see all its lines, including those that skip a column and are otherwise not drawn, and to fade the tables it has nothing to do with. Click a table's name (↗) to open where it is defined, on GitHub.</p>`;

/**
 * The trail to a database's pages: the services page, the service whose design opens it from a store (and the layer
 * page that holds the store, where it has one), then the database. A database no design opens hangs off the services page.
 */
function crumbsOf(model, database, files) {
  for (const service of servicesOf(model)) {
    for (const layer of service.logical.layers) {
      if (!layer.items.flat().some((chip) => chip.href === files.relations)) continue;
      return [...trailOf(model), [service.name, service.file ?? LOGICAL_FILE], ...(layer.href ? [[layer.title, layer.href]] : []), [database.name]];
    }
  }
  return [...trailOf(model), [database.name]];
}

/** @returns {string} a complete HTML document */
function page({ title, crumbs, tabs, standfirst, body, focus, drawnFrom, links }) {
  const styles = `${readFileSync(path.join(here, 'styles.css'), 'utf8')}${readFileSync(path.join(here, 'tables.css'), 'utf8')}${focus}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Cockpit Architecture &middot; ${esc(title)}</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap wide">
<header class="masthead"><p class="crumbs">${crumbTrail(crumbs)}</p><h1>${esc(title)}</h1>${switchNav(tabs)}<p class="standfirst">${linkPaths(standfirst, links)}</p>
<div class="runmeta">${commitLineOf(drawnFrom, links)}</div></header>
${body}
</div>
</body>
</html>
`;
}

/**
 * Two pages for each database the model holds tables for.
 * @returns {Record<string, string>} the file name to the complete HTML document; empty when the model has no tables
 */
export function renderTablePages(model) {
  const links = linksFor(model.drawnFrom);
  const pages = {};
  for (const database of model.tables?.databases ?? []) {
    const files = tableFiles(database.key);
    const { counts } = database;
    const tabs = (on) => [['Relations', files.relations, on === 'Relations'], ['All columns', files.columns, on === 'All columns']];
    const facts = `${esc(database.kind)}, one for ${esc(database.oneFor)}: ${plural(counts.tables, 'table')}, ${plural(counts.columns, 'column')}, ${plural(counts.indexes, 'index', 'indexes')}.`;
    const source = sourceOf(database, links);
    const example = database.tables.flatMap((table) => table.columns.filter((column) => column.references)).map((column) => `→ ${column.references.table}.${column.references.column ?? 'id'}`)[0] ?? '→ items.id';
    const relations = renderErd(database, { keysOnly: true, columnsHref: files.columns, links });
    const columns = renderErd(database, { keysOnly: false, columnsHref: files.columns, links });
    const common = { title: database.name, crumbs: crumbsOf(model, database, files), drawnFrom: model.drawnFrom, links };
    pages[files.relations] = page({ ...common, tabs: tabs('Relations'), standfirst: `${facts} ${source} This tab keeps only the rows that are a key, point somewhere, or are pointed at.`, focus: relations.focus, body: `${LEGEND(example)}<div class="diagram full">${relations.svg}</div>` });
    pages[files.columns] = page({ ...common, tabs: tabs('All columns'), standfirst: `${facts} ${source} Every column with its type, and each table's indexes.`, focus: columns.focus, body: `${LEGEND(example)}<div class="diagram full">${columns.svg}</div>` });
  }
  return pages;
}
