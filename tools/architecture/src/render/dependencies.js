/**
 * The Dependencies matrix, computed from the model as an HTML table: a row per
 * area importing, a column per area imported, in the description file's order.
 * A cell holds the number of files in the row's area importing the column's.
 * The page has no script, so the table is built here.
 */

import { esc } from './svg.js';

const KIND_CLASS = { downward: 'dn', upward: 'up', partner: 'dn part', muted: 'env' };
const KIND_TEXT = {
  downward: 'an area below',
  upward: 'an area above, against the order',
  partner: 'an area below, the other half of a cycle',
  muted: 'an area everything reads',
};

const count = (n, one) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : `${one}s`}`;
const list = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** "accounts with auth, connectors and mcp; auth with connectors" - each area once, with the lower areas it is in a cycle with. */
export function cycleSummary(dependencies) {
  const nameOf = new Map(dependencies.areas.map((each) => [each.path, each.name]));
  if (dependencies.cyclePairs.length === 0) return 'No two areas import each other.';
  const grouped = new Map();
  for (const [a, b] of dependencies.cyclePairs) grouped.set(a, [...(grouped.get(a) ?? []), nameOf.get(b)]);
  const parts = [...grouped].map(([area, names]) => `<code>${esc(nameOf.get(area))}</code> with ${list(names.map((each) => `<code>${esc(each)}</code>`))}`);
  return `${count(dependencies.cyclePairs.length, 'pair')} of areas import each other: ${parts.join('; ')}. In each, the import back up is red and the other is outlined.`;
}

/** The order's method in words, and the pairs it could not decide. */
export function orderNote(dependencies) {
  const { method, areas, limit, upwardFiles } = dependencies.order;
  const nameOf = new Map(dependencies.areas.map((each) => [each.path, each.name]));
  const how =
    method === 'exact'
      ? `The order is exact: every order of the ${areas} areas was weighed, up to ${limit}.`
      : `The order is approximate: ${areas} areas are more than the ${limit} an exact search weighs, so it is a greedy order improved by moving one area at a time.`;
  const left = `${count(upwardFiles, 'import file')} point${upwardFiles === 1 ? 's' : ''} up.`;
  const undecided = dependencies.undecidedPairs.map(([a, b]) => `<code>${esc(nameOf.get(a))}</code> and <code>${esc(nameOf.get(b))}</code>`);
  const tie = undecided.length ? ` The order could not decide ${list(undecided)}: each imports the other in the same number of files, so which half is red is arbitrary until a pin in the description file says.` : '';
  return `${how} ${left}${tie}`;
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
