/**
 * The Modules diagram, computed from the model: a lane per layer (the web app,
 * the API, the packages), a box per area on the row below everything that
 * imports it, and an arrow for each import of the shortest chain, weighted and
 * labelled by its file count. An import back up the chain is a red arrow with
 * its count, marked a tie where the order could not say which half of the
 * cycle is wrong.
 *
 * One more lane holds a box per connector the description file declares: solid
 * when its package exists, dashed red when it has none or the package is gone.
 * A dashed red line runs from a connector to each core area holding files built
 * for it, labelled with how many. An outline per Worker the Worker config
 * deploys surrounds every lane, since everything in it is released together; a
 * part released on its own is a box outside it.
 *
 * Every size is derived from what the model holds: a box wraps its name and
 * grows with its lines, a row is as tall as its tallest box, and a lane as
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
/** The room an outline takes beyond what it surrounds, and the line its title needs above it. */
const OUT_PAD = 12;
const OUT_HEAD = 26;
const PART_GAP = 28;
/** Files listed under a mark before "+N more": the model holds them all. */
const SHOWN = 3;

const UNDESCRIBED_TITLE = 'Not in the description file';
const CONNECTORS_TITLE = 'Connectors';

const files = (n) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'file' : 'files'}`;

/** The lines a box says, each with the dot (or none) it starts with. */
function linesOf(area, lineCount, width) {
  const text = width - 44;
  const lines = [];
  const say = (kind, dot, words, perChar = SANS) => wrap(words, text, perChar).forEach((line, index) => lines.push({ kind, dot: index === 0 ? dot : null, text: line }));
  const listed = (list) => {
    list.slice(0, SHOWN).forEach((file) => wrap(file, text - 8, MONO * 0.9).forEach((line, index) => lines.push({ kind: 't-m', dot: null, indent: index === 0 ? 0 : 8, text: line })));
    if (list.length > SHOWN) lines.push({ kind: 't-m', dot: null, text: `+${list.length - SHOWN} more` });
  };

  if (lineCount !== null) lines.push({ kind: 't-m', dot: null, text: `${lineCount.toLocaleString('en-GB')} lines` });
  if (area.state === 'gone') say('t-red', 'd-red', 'Gone: the description file describes it, but it is not on disk');
  if (area.state === 'undescribed') say('t-amber', 'd-amber', 'Undescribed: not in the description file');
  const byImport = new Map();
  for (const breach of area.breaches) byImport.set(breach.import, [...(byImport.get(breach.import) ?? []), breach.file]);
  for (const [specifier, importers] of byImport) {
    say('t-red', 'd-red', `Imports ${specifier}`);
    listed(importers);
  }
  if (area.role === 'connector' && area.state !== 'gone' && area.breaches.length === 0) say('t-i', 'd-green', 'Imports only the connector SDK');
  return lines;
}

/** The lines a connector's box says: its package, what is wrong with it, and how much of it lives in the core. */
function connectorLinesOf(connector, packageArea, lineCount, width) {
  const text = width - 44;
  const lines = [];
  const say = (kind, dot, words) => wrap(words, text, SANS).forEach((line, index) => lines.push({ kind, dot: index === 0 ? dot : null, text: line }));
  if (!connector.package) say('t-red', 'd-red', 'No package of its own');
  else if (connector.package.state === 'gone') say('t-red', 'd-red', `Package gone: ${connector.package.path} is not on disk`);
  else lines.push(...linesOf(packageArea ?? { state: 'described', breaches: [], role: 'connector' }, lineCount, width));
  const inCore = connector.inCore.reduce((total, here) => total + here.files.length, 0);
  if (inCore > 0) say('t-red', 'd-red', `${files(inCore)} in the core`);
  return lines;
}

/** The outline: red for a breach or a missing folder, amber for an undescribed one, green for a clean connector. */
function outlineOf(area) {
  if (area.state === 'gone') return 'ghost';
  if (area.breaches.length > 0) return 'breach';
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
const strokeFor = (n) => (1 + Math.log2(Math.max(n, 1)) * 0.55).toFixed(2);

export function renderModules(model) {
  const { layers, connectors = [], releasedOnItsOwn: parts = [], workers = [] } = model.modules;
  const lineCounts = new Map(model.dependencies.areas.map((each) => [each.path, each.lines]));
  const areaAt = new Map(layers.flatMap((layer) => layer.areas).map((each) => [each.path, each]));
  const allAreas = [...areaAt.values()];
  // A package a source names is drawn as that connector's box, not a second time as an area.
  const claimed = new Map(connectors.filter((each) => each.package).map((each) => [each.package.path, each]));
  const { rows, down, up } = layoutModules({ paths: allAreas.map((each) => each.path), cells: model.dependencies.cells, undecidedPairs: model.dependencies.undecidedPairs });

  // ---- boxes: wrapped name, lines, height
  const boxes = new Map();
  const sized = (box, lines, name) => {
    box.lines = lines;
    box.nameLines = wrap(name, BOX_WIDTH - 28, MONO);
    box.width = BOX_WIDTH;
    box.height = 16 + box.nameLines.length * LINE + 6 + Math.max(lines.length, 1) * LINE + 12;
    return box;
  };
  for (const area of allAreas) {
    if (claimed.has(area.path)) continue;
    boxes.set(area.path, sized({ kind: 'area', area, row: rows.get(area.path) ?? 0 }, linesOf(area, lineCounts.get(area.path) ?? null, BOX_WIDTH), area.name ?? area.path));
  }
  const connectorLane = [];
  const usedRows = new Set();
  for (const connector of connectors.filter((each) => each.package && rows.has(each.package.path))) usedRows.add(rows.get(connector.package.path));
  for (const connector of connectors) {
    const packageArea = connector.package ? areaAt.get(connector.package.path) : null;
    const lines = connectorLinesOf(connector, packageArea, lineCounts.get(connector.package?.path) ?? null, BOX_WIDTH);
    let row = connector.package ? rows.get(connector.package.path) : undefined;
    if (row === undefined) {
      row = 0;
      while (usedRows.has(row)) row += 1;
      usedRows.add(row);
    }
    const pseudo = packageArea ?? { state: 'gone', breaches: [], role: 'connector' };
    const box = sized({ kind: 'connector', connector, area: { ...pseudo, path: connector.package?.path ?? `connector:${connector.id}`, name: connector.name, description: connector.package ? `${connector.name}, in ${connector.package.path}` : `${connector.name} has no package of its own` }, row, outline: connector.package?.state === 'present' ? outlineOf(packageArea ?? { state: 'described', breaches: [], role: 'connector' }) : 'ghost' }, lines, connector.name);
    boxes.set(`connector:${connector.id}`, box);
    if (connector.package) boxes.set(connector.package.path, box);
    connectorLane.push(box);
  }
  const drawn = [...new Set(boxes.values())];

  const rowCount = Math.max(0, ...drawn.map((each) => each.row)) + 1;
  const rowHeight = Array.from({ length: rowCount }, (_, row) => Math.max(0, ...drawn.filter((each) => each.row === row).map((each) => each.height)));

  const frames = [];
  for (const layer of layers.filter((each) => !each.undescribed)) frames.push({ title: layer.title, note: layer.note, boxes: layer.areas.filter((each) => !claimed.has(each.path)).map((each) => boxes.get(each.path)) });
  if (connectorLane.length > 0) frames.push({ title: CONNECTORS_TITLE, note: 'One box per source the description file declares', boxes: connectorLane });
  for (const layer of layers.filter((each) => each.undescribed)) frames.push({ title: UNDESCRIBED_TITLE, note: layer.note, boxes: layer.areas.filter((each) => !claimed.has(each.path)).map((each) => boxes.get(each.path)) });
  const lanes = frames.filter((each) => each.boxes.length > 0);

  // ---- vertical: the outlines, then the rows inside them
  const workerCount = workers.length;
  const laneTop = PAD + OUT_HEAD * workerCount;
  const rowTop = [];
  let y = laneTop + HEADER + LANE_PAD;
  for (const height of rowHeight) {
    rowTop.push(y);
    y += height + ROW_GAP;
  }
  const bottom = y - ROW_GAP + LANE_PAD;

  // ---- lanes: as wide as their fullest row; boxes of a row centred in it
  let x = PAD + OUT_PAD * workerCount;
  const laneFrames = lanes.map((lane) => {
    const perRow = Array.from({ length: rowCount }, (_, row) => lane.boxes.filter((each) => each.row === row));
    const widest = Math.max(1, ...perRow.map((each) => each.length));
    const width = 2 * LANE_PAD + widest * BOX_WIDTH + (widest - 1) * BOX_GAP;
    perRow.forEach((inRow, row) => {
      const span = inRow.length * BOX_WIDTH + (inRow.length - 1) * BOX_GAP;
      inRow.forEach((box, at) => {
        box.x = x + (width - span) / 2 + at * (BOX_WIDTH + BOX_GAP);
        box.y = rowTop[row];
      });
    });
    const frame = { lane, x, width };
    x += width + LANE_GAP;
    return frame;
  });
  for (const box of drawn) {
    box.cx = box.x + box.width / 2;
    box.cy = box.y + box.height / 2;
  }
  const lanesRight = x - LANE_GAP;
  const outerRight = lanesRight + OUT_PAD * workerCount;

  // ---- parts released on their own, beside the outline
  const partWidth = BOX_WIDTH;
  const partBoxes = [];
  let partY = laneTop;
  for (const part of parts) {
    const textLines = wrap(part.description, partWidth - 28, SANS);
    const nameLines = wrap(part.name, partWidth - 28, MONO);
    const gone = part.state === 'gone';
    const height = 16 + LINE + nameLines.length * LINE + 6 + (textLines.length + (gone ? 1 : 0)) * LINE + 12;
    partBoxes.push({ part, x: outerRight + PART_GAP, y: partY, width: partWidth, height, textLines, nameLines, gone });
    partY += height + 20;
  }
  const width = Math.max((partBoxes.length > 0 ? outerRight + PART_GAP + partWidth : outerRight) + PAD, 2 * PAD + 200);
  const height = Math.ceil(Math.max(bottom + OUT_PAD * workerCount, partY - 20) + PAD);

  const svg = [];
  // ---- outlines: outermost first, each holding the next
  workers.forEach((worker, index) => {
    const inset = workerCount - index;
    const ox = PAD + OUT_PAD * index;
    const oy = PAD + OUT_HEAD * index;
    svg.push(
      `<rect class="wline" data-worker="${esc(worker.name)}" x="${ox}" y="${oy}" width="${lanesRight + OUT_PAD * inset - ox}" height="${bottom + OUT_PAD * inset - oy}" rx="8"><title>${esc(`Deployed as ${worker.environments.join(', ')}`)}</title></rect>`,
      `<text class="t-w" x="${ox + 12}" y="${oy + 18}">${esc(`One release: the Worker ${worker.name}`)}</text>`,
    );
  });
  for (const { lane, x: laneX, width: laneWidth } of laneFrames) {
    svg.push(
      `<rect class="soft" x="${laneX}" y="${laneTop}" width="${laneWidth}" height="${bottom - laneTop}" rx="6">${lane.note ? `<title>${esc(lane.note)}</title>` : ''}</rect>`,
      `<text class="t-h" x="${laneX + LANE_PAD}" y="${laneTop + 26}">${esc(lane.title)}</text>`,
    );
  }

  // ---- lines under the boxes, their labels over them
  const labels = [];
  const nameOf = (box) => box.area.name ?? box.area.path;
  const arrowsFor = (list, isUp) =>
    list.forEach((each) => {
      const from = boxes.get(each.from);
      const to = boxes.get(each.to);
      const [sx, sy] = leaving(from, to.cx, to.cy);
      const [ex, ey] = leaving(to, from.cx, from.cy);
      const label = `${countOf(each.files)}${each.tie ? ' (tie)' : ''}`;
      const named = `${nameOf(from)} imports ${nameOf(to)} in ${countOf(each.files)} ${each.files === 1 ? 'file' : 'files'}${each.tie ? ', the same as the import the other way' : ''}`;
      if (!isUp) {
        svg.push(`<line class="edge" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke-width="${strokeFor(each.files)}" marker-end="url(#mod-arrow)"><title>${esc(named)}</title></line>`);
        labels.push({ x: (sx + ex) / 2 + 6, y: (sy + ey) / 2 - 3, text: label, kind: '' });
        return;
      }
      const dx = ex - sx;
      const dy = ey - sy;
      const length = Math.hypot(dx, dy) || 1;
      const cx = (sx + ex) / 2 - (dy / length) * 28;
      const cy = (sy + ey) / 2 + (dx / length) * 28;
      svg.push(`<path class="edge-up" d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" marker-end="url(#mod-arrow-up)"><title>${esc(named)}</title></path>`);
      labels.push({ x: cx + 6, y: cy, text: label, kind: ' up' });
    });
  arrowsFor(down, false);
  arrowsFor(up, true);

  // A connector's code living in the core: one dashed red line to each area holding some.
  // Each runs out of the box's left edge, up or down the gutter beside its lane, along the gap above the
  // target's row and down into the target, so it crosses no box on the way.
  const gutter = (laneFrames.find((each) => each.lane.title === CONNECTORS_TITLE)?.x ?? lanesRight) - LANE_GAP / 2;
  const arrivals = new Map();
  let route = 0;
  for (const connector of connectors) {
    const from = boxes.get(`connector:${connector.id}`);
    connector.inCore.forEach((here, index) => {
      const to = boxes.get(here.area);
      if (!to) return;
      const at = arrivals.get(here.area) ?? 0;
      arrivals.set(here.area, at + 1);
      const sy = Math.min(from.y + from.height - 10, from.cy - 10 + index * 10);
      const gx = gutter + ((route % 5) - 2) * 3;
      // Above the first row there is only the lane's title to clear, so the lines sit closer together there.
      const channel = to.row === 0 ? to.y - 12 + ((route % 4) - 1.5) * 3 : to.y - ROW_GAP / 2 + ((route % 6) - 2.5) * 5;
      const dropX = Math.min(to.x + to.width - 14, to.x + 96 + at * 48);
      route += 1;
      svg.push(`<path class="edge-core" data-connector="${esc(connector.id)}" data-area="${esc(here.area)}" d="M${from.x},${sy.toFixed(1)} H${gx} V${channel.toFixed(1)} H${dropX} V${to.y}" marker-end="url(#mod-arrow-up)"><title>${esc(`${connector.name} code in ${nameOf(to)}: ${here.files.join(', ')}`)}</title></path>`);
      labels.push({ x: dropX + 8, y: channel - 4, text: files(here.files.length), kind: ' up' });
    });
  }

  // A connector's package to the part of it released on its own.
  for (const part of partBoxes) {
    const owner = connectors.find((each) => each.package && part.part.path.startsWith(`${each.package.path}/`));
    const from = owner && boxes.get(`connector:${owner.id}`);
    if (!from) continue;
    const to = { ...part, cx: part.x + part.width / 2, cy: part.y + part.height / 2 };
    const [sx, sy] = leaving(from, to.cx, to.cy);
    const [ex, ey] = leaving(to, from.cx, from.cy);
    svg.push(`<line class="edge-part" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"><title>${esc(`${part.part.name} is part of ${owner.name}'s package`)}</title></line>`);
  }

  // ---- boxes
  for (const box of drawn) {
    const { x: bx, y: by, width: bw, height: bh } = box;
    const attribute = box.kind === 'connector' ? `data-connector="${esc(box.connector.id)}"` : `data-area="${esc(box.area.path)}"`;
    const klass = box.kind === 'connector' ? box.outline : outlineOf(box.area);
    svg.push(`<rect class="${klass}" ${attribute} x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5">${box.area.description ? `<title>${esc(box.area.description)}</title>` : ''}</rect>`);
    box.nameLines.forEach((line, index) => svg.push(`<text class="t-h" x="${bx + 14}" y="${by + 26 + index * LINE}">${esc(line)}</text>`));
    const bodyTop = by + 16 + box.nameLines.length * LINE + 6 + 12;
    box.lines.forEach((line, index) => {
      const baseline = bodyTop + index * LINE;
      if (line.dot) svg.push(`<circle class="${line.dot}" cx="${bx + 18}" cy="${baseline - 4}" r="4"/>`);
      svg.push(`<text class="${line.kind}" x="${bx + (line.dot ? 30 : 14) + (line.indent ?? 0)}" y="${baseline}">${esc(line.text)}</text>`);
    });
  }
  for (const box of partBoxes) {
    svg.push(`<rect class="${box.gone ? 'ghost' : 'part'}" data-part="${esc(box.part.path)}" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="5"><title>${esc(box.part.path)}</title></rect>`);
    svg.push(`<text class="t-hl" x="${box.x + 14}" y="${box.y + 24}">Released on its own</text>`);
    box.nameLines.forEach((line, index) => svg.push(`<text class="t-h" x="${box.x + 14}" y="${box.y + 24 + LINE + index * LINE}">${esc(line)}</text>`));
    const bodyTop = box.y + 24 + LINE + box.nameLines.length * LINE + 4;
    box.textLines.forEach((line, index) => svg.push(`<text class="t-m" x="${box.x + 14}" y="${bodyTop + index * LINE}">${esc(line)}</text>`));
    if (box.gone) svg.push(`<text class="t-red" x="${box.x + 14}" y="${bodyTop + box.textLines.length * LINE}">Gone: not on disk</text>`);
  }
  for (const label of labels) svg.push(`<text class="e-lbl${label.kind}" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}">${esc(label.text)}</text>`);

  const named = lanes.map((lane) => `${lane.title} (${lane.boxes.length})`).join(', ');
  const released = workers.length > 0 ? ` Released together as ${workers.map((each) => `the Worker ${each.name}`).join(' and ')}${parts.length > 0 ? `; released on their own: ${parts.map((each) => each.name).join(', ')}` : ''}.` : '';
  const label = `Module map of Cockpit, each area below everything that imports it: ${named}. ${down.length} imports drawn, ${up.length} pointing back up.${released}`;
  return `<svg viewBox="0 0 ${Math.ceil(width)} ${height}" style="min-width:${Math.min(Math.ceil(width), 900)}px" role="img" aria-label="${esc(label)}">
  <defs>
    <marker id="mod-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="mh" d="M0,0 L10,5 L0,10 z"/></marker>
    <marker id="mod-arrow-up" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="mh-up" d="M0,0 L10,5 L0,10 z"/></marker>
  </defs>
  ${svg.join('\n  ')}
</svg>`;
}
