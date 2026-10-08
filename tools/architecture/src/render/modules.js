/**
 * The Modules diagram, computed from the model: a lane per layer (the web app,
 * the API, the packages), a box per area on the row below everything that
 * imports it, and an arrow for each import of the shortest chain, weighted and
 * labelled by its file count. An import back up the chain is a red arrow with
 * its count, marked a tie where the order could not say which half of the
 * cycle is wrong.
 *
 * Every size is derived from what the model holds: a box wraps its name and
 * grows with its marks, a row is as tall as its tallest box, and a lane as
 * wide as its fullest row, so no two boxes can meet however many areas a row
 * holds or however long a name is.
 *
 * A box's outline says what is wrong with it, if anything; its lines say why.
 */

import { layoutModules } from '../layout.js';
import { esc, MONO, SANS, wrap } from './svg.js';

const PAD = 16;
const LANE_PAD = 16;
const LANE_GAP = 24;
const BOX_WIDTH = 240;
const BOX_GAP = 20;
const ROW_GAP = 72;
const LINE = 18;
const HEADER = 40;
/** Files listed under a mark before "+N more": the model holds them all. */
const SHOWN = 3;

const UNDESCRIBED_TITLE = 'Not in the description file';

/** The lines a box says, each with the dot (or none) it starts with. */
function linesOf(area, lineCount, width) {
  const text = width - 44;
  const lines = [];
  const say = (kind, dot, words, perChar = SANS) => wrap(words, text, perChar).forEach((line, index) => lines.push({ kind, dot: index === 0 ? dot : null, text: line }));
  const files = (list) => {
    list.slice(0, SHOWN).forEach((file) => wrap(file, text - 8, MONO * 0.9).forEach((line, index) => lines.push({ kind: 't-m', dot: null, indent: index === 0 ? 0 : 8, text: line })));
    if (list.length > SHOWN) lines.push({ kind: 't-m', dot: null, text: `+${list.length - SHOWN} more` });
  };

  if (lineCount !== null) lines.push({ kind: 't-m', dot: null, text: `${lineCount.toLocaleString('en-GB')} lines` });
  if (area.state === 'gone') say('t-red', 'd-red', 'Gone: the description file describes it, but it is not on disk');
  if (area.state === 'undescribed') say('t-amber', 'd-amber', 'Undescribed: not in the description file');
  for (const source of area.sources) {
    say('t-red', 'd-red', `Names ${source.name} in ${source.files.length === 1 ? '1 file' : `${source.files.length} files`}`);
    files(source.files);
  }
  const byImport = new Map();
  for (const breach of area.breaches) byImport.set(breach.import, [...(byImport.get(breach.import) ?? []), breach.file]);
  for (const [specifier, importers] of byImport) {
    say('t-red', 'd-red', `Imports ${specifier}`);
    files(importers);
  }
  if (area.role === 'connector' && area.state !== 'gone' && area.breaches.length === 0) say('t-i', 'd-green', 'Imports only the connector SDK');
  return lines;
}

/** The outline: red for a breach or a missing folder, amber for an undescribed one, green for a clean connector. */
function outlineOf(area) {
  if (area.state === 'gone') return 'ghost';
  if (area.sources.length > 0 || area.breaches.length > 0) return 'breach';
  if (area.state === 'undescribed') return 'undescribed';
  if (area.role === 'connector') return 'clean';
  return 'box';
}

/** Where the segment from the centre of `box` towards (tx, ty) leaves it. */
function leaving(box, tx, ty) {
  const dx = tx - box.cx;
  const dy = ty - box.cy;
  let t = 1;
  for (const [p, q] of [[-dx, box.cx - box.x], [dx, box.x + box.width - box.cx], [-dy, box.cy - box.y], [dy, box.y + box.height - box.cy]]) if (p > 0) t = Math.min(t, q / p);
  return [box.cx + dx * t, box.cy + dy * t];
}

const countOf = (n) => n.toLocaleString('en-GB');
const strokeFor = (files) => (1 + Math.log2(Math.max(files, 1)) * 0.55).toFixed(2);

export function renderModules(model) {
  const { layers } = model.modules;
  const lineCounts = new Map(model.dependencies.areas.map((each) => [each.path, each.lines]));
  const lanes = layers.filter((layer) => layer.areas.length > 0);
  const allAreas = lanes.flatMap((layer) => layer.areas);
  const { rows, down, up } = layoutModules({ paths: allAreas.map((each) => each.path), cells: model.dependencies.cells, undecidedPairs: model.dependencies.undecidedPairs });

  // ---- boxes: wrapped name, marks, height
  const boxes = new Map();
  for (const area of allAreas) {
    const lines = linesOf(area, lineCounts.get(area.path) ?? null, BOX_WIDTH);
    const nameLines = wrap(area.name ?? area.path, BOX_WIDTH - 28, MONO);
    boxes.set(area.path, { area, lines, nameLines, row: rows.get(area.path) ?? 0, width: BOX_WIDTH, height: 16 + nameLines.length * LINE + 6 + Math.max(lines.length, 1) * LINE + 12 });
  }
  const rowCount = Math.max(0, ...[...boxes.values()].map((each) => each.row)) + 1;
  const rowHeight = Array.from({ length: rowCount }, (_, row) => Math.max(0, ...[...boxes.values()].filter((each) => each.row === row).map((each) => each.height)));
  const rowTop = [];
  let y = PAD + HEADER + LANE_PAD;
  for (const height of rowHeight) {
    rowTop.push(y);
    y += height + ROW_GAP;
  }
  const bottom = y - ROW_GAP + LANE_PAD;

  // ---- lanes: as wide as their fullest row; boxes of a row centred in it
  const laneBoxes = lanes.map((layer) => layer.areas.map((each) => boxes.get(each.path)));
  let x = PAD;
  const laneFrames = lanes.map((layer, index) => {
    const perRow = Array.from({ length: rowCount }, (_, row) => laneBoxes[index].filter((each) => each.row === row));
    const widest = Math.max(1, ...perRow.map((each) => each.length));
    const width = 2 * LANE_PAD + widest * BOX_WIDTH + (widest - 1) * BOX_GAP;
    perRow.forEach((inRow, row) => {
      const span = inRow.length * BOX_WIDTH + (inRow.length - 1) * BOX_GAP;
      inRow.forEach((box, at) => {
        box.x = x + (width - span) / 2 + at * (BOX_WIDTH + BOX_GAP);
        box.y = rowTop[row];
      });
    });
    const frame = { layer, x, width };
    x += width + LANE_GAP;
    return frame;
  });
  for (const box of boxes.values()) {
    box.cx = box.x + box.width / 2;
    box.cy = box.y + box.height / 2;
  }
  const width = Math.max(x - LANE_GAP + PAD, 2 * PAD + 200);

  const parts = [];
  for (const { layer, x: laneX, width: laneWidth } of laneFrames) {
    const title = layer.title ?? UNDESCRIBED_TITLE;
    parts.push(
      `<rect class="soft" x="${laneX}" y="${PAD}" width="${laneWidth}" height="${bottom - PAD}" rx="6">${layer.note ? `<title>${esc(layer.note)}</title>` : ''}</rect>`,
      `<text class="t-h" x="${laneX + LANE_PAD}" y="${PAD + 26}">${esc(title)}</text>`,
    );
  }

  // ---- arrows under the boxes, their labels over them
  const labels = [];
  const arrowsFor = (list, up_) =>
    list.forEach((each) => {
      const from = boxes.get(each.from);
      const to = boxes.get(each.to);
      const [sx, sy] = leaving(from, to.cx, to.cy);
      const [ex, ey] = leaving(to, from.cx, from.cy);
      const label = `${countOf(each.files)}${each.tie ? ' (tie)' : ''}`;
      const named = `${from.area.name ?? from.area.path} imports ${to.area.name ?? to.area.path} in ${countOf(each.files)} ${each.files === 1 ? 'file' : 'files'}${each.tie ? ', the same as the import the other way' : ''}`;
      if (!up_) {
        parts.push(`<line class="edge" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke-width="${strokeFor(each.files)}" marker-end="url(#mod-arrow)"><title>${esc(named)}</title></line>`);
        labels.push({ x: (sx + ex) / 2 + 6, y: (sy + ey) / 2 - 3, text: label, kind: '' });
        return;
      }
      const dx = ex - sx;
      const dy = ey - sy;
      const length = Math.hypot(dx, dy) || 1;
      const cx = (sx + ex) / 2 - (dy / length) * 28;
      const cy = (sy + ey) / 2 + (dx / length) * 28;
      parts.push(`<path class="edge-up" d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" marker-end="url(#mod-arrow-up)"><title>${esc(named)}</title></path>`);
      labels.push({ x: cx + 6, y: cy, text: label, kind: ' up' });
    });
  arrowsFor(down, false);
  arrowsFor(up, true);

  // ---- boxes
  for (const { area, lines, nameLines, x: bx, y: by, width: bw, height: bh } of boxes.values()) {
    parts.push(`<rect class="${outlineOf(area)}" data-area="${esc(area.path)}" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5">${area.description ? `<title>${esc(area.description)}</title>` : ''}</rect>`);
    nameLines.forEach((line, index) => parts.push(`<text class="t-h" x="${bx + 14}" y="${by + 26 + index * LINE}">${esc(line)}</text>`));
    const bodyTop = by + 16 + nameLines.length * LINE + 6 + 12;
    lines.forEach((line, index) => {
      const baseline = bodyTop + index * LINE;
      if (line.dot) parts.push(`<circle class="${line.dot}" cx="${bx + 18}" cy="${baseline - 4}" r="4"/>`);
      parts.push(`<text class="${line.kind}" x="${bx + (line.dot ? 30 : 14) + (line.indent ?? 0)}" y="${baseline}">${esc(line.text)}</text>`);
    });
  }
  for (const label of labels) parts.push(`<text class="e-lbl${label.kind}" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}">${esc(label.text)}</text>`);

  const height = Math.ceil(bottom + PAD);
  const named = lanes.map((layer) => `${layer.title ?? UNDESCRIBED_TITLE} (${layer.areas.length})`).join(', ');
  const label = `Module map of Cockpit, each area below everything that imports it: ${named}. ${down.length} imports drawn, ${up.length} pointing back up.`;
  return `<svg viewBox="0 0 ${Math.ceil(width)} ${height}" style="min-width:${Math.min(Math.ceil(width), 900)}px" role="img" aria-label="${esc(label)}">
  <defs>
    <marker id="mod-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="mh" d="M0,0 L10,5 L0,10 z"/></marker>
    <marker id="mod-arrow-up" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="mh-up" d="M0,0 L10,5 L0,10 z"/></marker>
  </defs>
  ${parts.join('\n  ')}
</svg>`;
}
