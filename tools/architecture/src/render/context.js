/**
 * The Context diagram, computed from the model: the people the description
 * file declares on the left, the outside services on the right, Cockpit between
 * them with a line to each. Rows are as tall as what they say needs, so a longer
 * detail or one more person adds height and nothing overlaps.
 */

import { esc, SANS, wrap } from './svg.js';

const WIDTH = 1000;
const SIDE = 260;
const LEFT = 30;
const RIGHT = WIDTH - 30 - SIDE;
const CENTRE = { x: 380, width: 240 };
const TOP = 40;
const GAP = 24;
const LINE = 18;

/** A box for each entry, stacked down one side; the wrapped detail sets its height. */
function stack(entries) {
  let y = TOP;
  return entries.map((entry) => {
    const detail = wrap(entry.detail, SIDE - 28, SANS);
    const height = 38 + detail.length * LINE;
    const box = { entry, detail, y, height };
    y += height + GAP;
    return box;
  });
}

export function renderContext(model) {
  const { cockpit, people, services } = model.context;
  const left = stack(people);
  const right = stack(services);
  const columnBottom = (boxes) => (boxes.length ? boxes[boxes.length - 1].y + boxes[boxes.length - 1].height : TOP + 100);

  const summary = wrap(cockpit.summary, CENTRE.width - 40);
  const centreHeight = Math.max(110, 70 + summary.length * LINE + (cockpit.runs ? 30 : 0));
  const bottom = Math.max(columnBottom(left), columnBottom(right), TOP + centreHeight);
  const centreTop = TOP + (bottom - TOP - centreHeight) / 2;

  // Each line meets Cockpit's edge at its own height, spread down the edge.
  const meet = (index, count) => centreTop + 24 + ((centreHeight - 48) * (index + 0.5)) / Math.max(count, 1);
  const parts = [
    ...left.map((box, index) => `<line class="link" x1="${LEFT + SIDE}" y1="${box.y + box.height / 2}" x2="${CENTRE.x}" y2="${meet(index, left.length)}"/>`),
    ...right.map((box, index) => `<line class="link" x1="${RIGHT}" y1="${box.y + box.height / 2}" x2="${CENTRE.x + CENTRE.width}" y2="${meet(index, right.length)}"/>`),
    `<rect class="cockpit" x="${CENTRE.x}" y="${centreTop}" width="${CENTRE.width}" height="${centreHeight}" rx="6"/>`,
    `<text class="t-w" x="${CENTRE.x + 20}" y="${centreTop + 30}">${esc(cockpit.name)}</text>`,
    ...summary.map((line, index) => `<text class="t-i" x="${CENTRE.x + 20}" y="${centreTop + 56 + index * LINE}">${esc(line)}</text>`),
    cockpit.runs ? `<text class="t-m" x="${CENTRE.x + 20}" y="${centreTop + 56 + summary.length * LINE + 8}">${esc(cockpit.runs)}</text>` : '',
  ];
  const draw = (boxes, x, kind) =>
    boxes.flatMap(({ entry, detail, y, height }) => [
      `<rect class="${kind}" x="${x}" y="${y}" width="${SIDE}" height="${height}" rx="5"/>`,
      `<text class="t-h" x="${x + 14}" y="${y + 26}">${esc(entry.name)}</text>`,
      ...detail.map((line, index) => `<text class="t-m" x="${x + 14}" y="${y + 46 + index * LINE}">${esc(line)}</text>`),
    ]);
  parts.push(...draw(left, LEFT, 'box'), ...draw(right, RIGHT, 'ext'));

  const height = Math.ceil(bottom + 30);
  const label = `Context diagram: ${people.map((each) => each.name).join(', ') || 'no people'} on the left, ${cockpit.name} in the middle, ${services.map((each) => each.name).join(', ') || 'no outside services'} on the right.`;
  return `<svg viewBox="0 0 ${WIDTH} ${height}" style="min-width:760px" role="img" aria-label="${esc(label)}">
  ${parts.filter(Boolean).join('\n  ')}
</svg>`;
}
