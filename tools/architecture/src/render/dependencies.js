/**
 * The Dependencies matrix, computed from the model as an HTML table: a row per
 * area importing, a column per area imported, in the description file's order.
 * A cell holds the number of files in the row's area importing the column's.
 * The page has no script, so the table is built here.
 */

import { esc } from './svg.js';

const KIND_CLASS = { downward: 'dn', upward: 'up', mutual: 'cyc', muted: 'env' };
const KIND_TEXT = { downward: 'a layer below', upward: 'a layer above', mutual: 'each importing the other', muted: 'an area everything reads' };

const count = (n, one) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : `${one}s`}`;

/** "accounts with auth, connectors and mcp; auth with connectors" - each area once, with the later areas it is mutual with. */
export function mutualSummary(dependencies) {
  const nameOf = new Map(dependencies.areas.map((each) => [each.path, each.name]));
  if (dependencies.mutualPairs.length === 0) return 'No two areas import each other.';
  const grouped = new Map();
  for (const [a, b] of dependencies.mutualPairs) grouped.set(a, [...(grouped.get(a) ?? []), nameOf.get(b)]);
  const list = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
  const parts = [...grouped].map(([area, names]) => `<code>${esc(nameOf.get(area))}</code> with ${list(names.map((each) => `<code>${esc(each)}</code>`))}`);
  return `${count(dependencies.mutualPairs.length, 'pair')} of areas import each other: ${parts.join('; ')}.`;
}

export function renderDependencies(model) {
  const { dependencies } = model;
  const { areas, cells } = dependencies;
  const cell = new Map(cells.map((each) => [`${each.from}\0${each.to}`, each]));

  const head = `<tr><th></th>${areas.map((each) => `<th class="col" scope="col"><span>${esc(each.name)}</span></th>`).join('')}</tr>`;
  const rows = areas.map((row) => {
    const label = `<th class="row" scope="row" title="${esc(row.path)}">${esc(row.name)} <span class="lines">${row.lines.toLocaleString('en-GB')}</span></th>`;
    const tds = areas.map((column) => {
      if (row.path === column.path) return '<td class="self"></td>';
      const found = cell.get(`${row.path}\0${column.path}`);
      if (!found) return '<td class="empty"></td>';
      const title = `${row.name} imports ${column.name} in ${count(found.files, 'file')} (${KIND_TEXT[found.kind]})`;
      return `<td class="${KIND_CLASS[found.kind]}" title="${esc(title)}">${found.files}</td>`;
    });
    return `<tr>${label}${tds.join('')}</tr>`;
  });
  return `<table class="dsm" aria-label="Dependency matrix: the files of the row's area importing the column's area">
${head}
${rows.join('\n')}
</table>`;
}
