/**
 * The Database diagram: one band per database, each table a box listing its
 * columns and indexes, a line from a column to the table it points at. A table
 * sits on the row below every table it points at; tables that point at
 * nothing and that nothing points at stand together at the foot of their
 * database. What is no longer used is struck through in red, with why as its
 * tooltip.
 */

import { esc, wrap } from './svg.js';

const CHAR = 6.9; // 11.5px monospace, erring wide like the estimates in svg.js
const LINE = 17;
const HEAD = 30;
const PAD = 10;
const GAP_X = 70;
const GAP_Y = 80;
const PER_LINE = 7;
const LEFT = 30;

const typeOf = (column) => [column.primaryKey ? 'key' : null, (column.type ?? 'any').toLowerCase(), column.required ? 'required' : null].filter(Boolean).join(' · ');

/** Each table's box: its width, its lines, and its height from them. */
function measure(table, width) {
  const indexLines = table.indexes.flatMap((index) => {
    const head = `${index.unique ? 'unique ' : ''}${index.name}`;
    const body = `(${index.columns.join(', ')})${index.where ? ` where ${index.where}` : ''}`;
    return [{ index, text: head, first: true }, ...wrap(body, width - 2 * PAD - 10, CHAR).map((text) => ({ index, text, first: false }))];
  });
  const height = HEAD + table.columns.length * LINE + (indexLines.length ? 14 + indexLines.length * 15 : 0) + 10;
  return { table, width, height, indexLines };
}

/** Rows by the references: a table one below the deepest table it points at; the unlinked last. */
function rank(tables) {
  const byName = new Map(tables.map((each) => [each.name, each]));
  const parents = (table) => [...new Set(table.columns.map((c) => c.references?.table).filter((name) => name && name !== table.name && byName.has(name)))];
  const pointedAt = new Set(tables.flatMap(parents));
  const rows = new Map();
  const depth = (table, walking = new Set()) => {
    if (rows.has(table.name)) return rows.get(table.name);
    if (walking.has(table.name)) return 0;
    walking.add(table.name);
    const row = parents(table).reduce((deepest, name) => Math.max(deepest, depth(byName.get(name), walking) + 1), 0);
    walking.delete(table.name);
    rows.set(table.name, row);
    return row;
  };
  const linked = tables.filter((each) => parents(each).length > 0 || pointedAt.has(each.name));
  for (const table of linked) depth(table);
  const bands = [];
  for (const table of linked) (bands[rows.get(table.name)] ??= []).push(table);
  const alone = tables.filter((each) => !linked.includes(each));
  return { bands: bands.filter(Boolean), alone, parents };
}

/** One database's tables drawn from `top` down at `LEFT`: its boxes and the lines between them. */
function drawTables(database, top, LEFT) {
  const longest = Math.max(...database.tables.flatMap((t) => t.columns.map((c) => c.name.length + typeOf(c).length)), 30);
  const width = Math.ceil(Math.max(250, longest * CHAR + 2 * PAD + 24));
  const { bands, alone, parents } = rank(database.tables);
  const placed = new Map();
  const parts = [];
  let y = top;
  let right = LEFT;

  const lay = (tables, label) => {
    if (label) {
      parts.push(`<text class="t-m" x="${LEFT}" y="${y + 4}">${esc(label)}</text>`);
      y += 20;
    }
    for (let start = 0; start < tables.length; start += PER_LINE) {
      const line = tables.slice(start, start + PER_LINE).map((table) => measure(table, width));
      line.forEach((box, index) => {
        box.x = LEFT + index * (width + GAP_X);
        box.y = y;
        placed.set(box.table.name, box);
        right = Math.max(right, box.x + width);
      });
      y += Math.max(...line.map((box) => box.height)) + GAP_Y;
    }
  };

  // Each band ordered under the tables it points at, so the lines run as straight as they can.
  const centre = (box) => box.x + box.width / 2;
  bands.forEach((band, index) => {
    const ordered = index === 0
      ? [...band].sort((a, b) => countChildren(database.tables, b) - countChildren(database.tables, a) || a.name.localeCompare(b.name))
      : [...band].sort((a, b) => mean(parents(a).map((name) => centre(placed.get(name)))) - mean(parents(b).map((name) => centre(placed.get(name)))) || a.name.localeCompare(b.name));
    lay(ordered);
  });
  if (alone.length) lay([...alone].sort((a, b) => a.name.localeCompare(b.name)), 'Pointing at no table, and no table pointing at them');

  // Lines first, under the boxes.
  const arrivals = new Map();
  for (const box of placed.values()) {
    box.table.columns.forEach((column, row) => {
      const target = column.references && placed.get(column.references.table);
      if (!target) return;
      const sy = box.y + HEAD + row * LINE + LINE / 2 - 4;
      const title = `${box.table.name}.${column.name} points at ${column.references.table}${column.references.column ? `.${column.references.column}` : ''}${column.references.onDelete ? ` (on delete ${column.references.onDelete.toLowerCase()})` : ''}`;
      if (target === box) {
        const x = box.x + box.width;
        parts.push(`<path class="edge" d="M ${x} ${sy} h 24 V ${box.y + 12} H ${x}" marker-end="url(#db-arrow)"><title>${esc(title)}</title></path>`);
        return;
      }
      const leftward = centre(target) < centre(box);
      const sx = leftward ? box.x : box.x + box.width;
      const count = arrivals.get(target.table.name) ?? 0;
      arrivals.set(target.table.name, count + 1);
      const ex = target.x + 20 + ((count * 23) % (target.width - 40));
      const ey = target.y + target.height;
      const out = leftward ? -26 : 26;
      parts.push(`<path class="edge" d="M ${sx} ${sy} C ${sx + out * 2} ${sy}, ${ex} ${ey + 60}, ${ex} ${ey + 2}" marker-end="url(#db-arrow)"><title>${esc(title)}</title></path>`);
    });
  }

  for (const box of placed.values()) parts.push(...drawBox(box));
  return { parts, bottom: y - GAP_Y + 20, right };
}

const countChildren = (tables, table) => tables.filter((each) => each.columns.some((c) => c.references?.table === table.name && each !== table)).length;
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function drawBox({ table, x, y, width, height, indexLines }) {
  const parts = [];
  const tip = (reason) => (reason ? `<title>${esc(`No longer used. ${reason}`)}</title>` : '');
  parts.push(`<g>${tip(table.unused)}`);
  parts.push(`<rect class="${table.unused ? 'ghost' : 'box'}" x="${x}" y="${y}" width="${width}" height="${height}" rx="5"/>`);
  parts.push(`<rect class="soft" x="${x}" y="${y}" width="${width}" height="${HEAD - 6}" rx="5"/>`);
  parts.push(`<text class="t-h${table.unused ? ' gone' : ''}" x="${x + PAD}" y="${y + 17}">${esc(table.name)}</text>`);
  if (table.unused) parts.push(`<text class="t-red" x="${x + width - PAD}" y="${y + 17}" text-anchor="end">no longer used</text>`);
  table.columns.forEach((column, row) => {
    const cy = y + HEAD + row * LINE + 8;
    const cls = column.unused ? ' gone' : '';
    parts.push(`<g>${tip(column.unused)}<text class="db-c${cls}" x="${x + PAD}" y="${cy}">${esc(column.name)}</text><text class="db-t${cls}" x="${x + width - PAD}" y="${cy}" text-anchor="end">${esc(typeOf(column))}</text></g>`);
  });
  if (indexLines.length) {
    const iy = y + HEAD + table.columns.length * LINE;
    parts.push(`<line class="db-sep" x1="${x}" y1="${iy}" x2="${x + width}" y2="${iy}"/>`);
    indexLines.forEach(({ index, text, first }, row) => {
      parts.push(`<g>${tip(index.unused)}<text class="db-i${first ? ' head' : ''}${index.unused ? ' gone' : ''}" x="${x + PAD + (first ? 0 : 10)}" y="${iy + 18 + row * 15}">${esc(text)}</text></g>`);
    });
  }
  parts.push('</g>');
  return parts;
}

const plural = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`;

/**
 * One database as its own diagram, inside a frame that says which kind it is:
 * the register is one database every account shares, drawn as one frame; an
 * account's store is one database per account, drawn as a stack of frames.
 */
export function renderDatabase(model, key) {
  const database = model.database?.databases.find((each) => each.key === key);
  if (!database) return '<svg viewBox="0 0 600 60" style="min-width:600px" role="img" aria-label="No schema to draw"><text class="t-m" x="20" y="34">This commit has no schema file to draw this database from.</text></svg>';
  const perAccount = database.oneFor === 'each account';
  const frame = { x: 20, y: 20 };
  const drawn = drawTables(database, frame.y + 90, frame.x + 30);
  const width = drawn.right + 30 - frame.x;
  const height = drawn.bottom + 20 - frame.y;
  const { counts } = database;
  const unused = [counts.unusedTables && plural(counts.unusedTables, 'table'), counts.unusedColumns && plural(counts.unusedColumns, 'column'), counts.unusedIndexes && plural(counts.unusedIndexes, 'index')].filter(Boolean).join(', ');
  const stack = perAccount ? [16, 8].map((offset) => `<rect class="db-frame back" x="${frame.x + offset}" y="${frame.y + offset}" width="${width}" height="${height}" rx="10"/>`) : [];
  const parts = [
    ...stack,
    `<rect class="db-frame${perAccount ? '' : ' shared'}" x="${frame.x}" y="${frame.y}" width="${width}" height="${height}" rx="10"/>`,
    `<text class="t-w" x="${frame.x + 30}" y="${frame.y + 36}">${esc(database.name)}</text>`,
    `<text class="t-i" x="${frame.x + 30}" y="${frame.y + 58}">${esc(`${database.kind}, one for ${database.oneFor}`)}</text>`,
    `<text class="t-m" x="${frame.x + 30}" y="${frame.y + 76}">${esc(`${plural(counts.tables, 'table')}, ${plural(counts.columns, 'column')}, ${plural(counts.indexes, 'index')}${unused ? ` · no longer used: ${unused}` : ''}`)}</text>`,
    ...drawn.parts,
  ];
  const label = `${database.name}: ${database.kind}, one for ${database.oneFor}, ${plural(counts.tables, 'table')}${unused ? `, no longer used: ${unused}` : ''}.`;
  return `<svg viewBox="0 0 ${Math.ceil(frame.x + width + (perAccount ? 36 : 20))} ${Math.ceil(frame.y + height + (perAccount ? 36 : 20))}" style="min-width:760px" role="img" aria-label="${esc(label)}">
  <defs><marker id="db-arrow-${esc(key)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mh" d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>
  ${parts.join('\n  ').replaceAll('url(#db-arrow)', `url(#db-arrow-${esc(key)})`)}
</svg>`;
}
