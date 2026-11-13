/**
 * The Logical page: Cockpit's design drawn as nested layers, with the code's own lines laid over it. The model
 * in, one self-contained HTML file out; it reads nothing from the checkout.
 *
 * Lines are `ok` (the design draws it and the code has it, one per pair of layers), `bad` (the code has it and
 * the design does not: chip to chip, numbered, routed around what it skips), `miss` (the design draws it and no
 * file does) or `decl` (how a caller talks, declared). Every GitHub link opens the code at the commit the page
 * was drawn from, so a line number still means what it did; without a repository and a commit there are none.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { accTable, devData, dialog } from './deviations.js';
import { linksFor, linkPaths, commitLineOf } from './links.js';
import { isOpened, LINES_NOTE, verbOf, partsLegend, partsLines } from './parts.js';
import { crumbTrail, prose, switchNav, trailOf } from './shell.js';
import { esc, firstLine, wrap } from './svg.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const LOGICAL_FILE = 'service-cockpit.html';

/** The Deployment tab of a service's page: the same name with -deployment before the extension. */
export const deploymentFile = (file) => file.replace(/\.html$/, '-deployment.html');

/** The Design tab of a service's page: the same name with -design before the extension. */
export const designFile = (file) => file.replace(/\.html$/, '-design.html');

/** The switch between a service's tabs: Design, Logical and, for a service that deploys, Deployment. */
export const serviceTabs = (model, service, on) => {
  const file = service.file ?? LOGICAL_FILE;
  const deployed = model.deployments?.some((each) => each.service === (service.id ?? 'cockpit'));
  return switchNav([['Design', designFile(file), on === 'Design'], ['Logical', file, on === 'Logical'], ...(deployed ? [['Deployment', deploymentFile(file), on === 'Deployment']] : [])]);
};

/** Every service with a page, Cockpit first, each in one shape: `{ id, name, intro, file, logical }`. */
export const servicesOf = (model) => [...(model.logical ? [{ id: 'cockpit', name: 'Cockpit', intro: '', file: LOGICAL_FILE, logical: model.logical }] : []), ...(model.services ?? [])];

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** How a caller talks, as its line says it: the addresses its code calls, when it is read for them, then how. */
const callLabel = (caller) => (caller.addresses.length ? `${caller.addresses.join(', ')} · ${caller.how}` : caller.how);

/** A component opens its code on GitHub: its folder. It is marked ↗ and its name stays dark, since a blue name means a page one level down. */
function codeLinked(chip, body, right, top, links) {
  const tip = [chip.name, chip.sub].filter(Boolean).join(' - ');
  // A component of file-name patterns opens the first of its files, and its tooltip lists the rest.
  const matched = chip.matched ?? [];
  const where = chip.folders[0] ?? matched[0];
  const href = where ? links.url(where, { folder: chip.folders.length > 0 }) : null;
  if (!href) return `${body}<title>${esc(chip.tip || tip)}</title>`;
  const more = chip.folders.length > 1 ? ` (also ${chip.folders.slice(1).join(', ')})` : matched.length > 1 ? `, the first of ${matched.length} files:\n${matched.join('\n')}` : '';
  return `<a class="code" href="${esc(href)}" target="_blank" rel="noopener">${body}<text class="nc-gh" x="${right - 7}" y="${top + 15}" text-anchor="end">↗</text><title>${esc(`${tip}
Open on GitHub: ${where}${more}`)}</title></a>`;
}

/**
 * Rows of layer boxes, each holding chips, and a column of outside services on the right.
 * @param {{ label: string, rows: object[][], side?: object, sideRow?: number, lines: object[], laneStart?: number, gap?: number, channel?: number }} spec
 */
export function renderNested(spec, links) {
  const X0 = 120, MW = 1000, GAP = spec.gap ?? 20, CHIP_H = 46, HEAD = 34, CH = spec.channel ?? 108;
  const SX = X0 + MW + 90, SW = 200;
  const rect = new Map();
  const rowY = [], rowB = [];
  let y = 24;
  spec.rows.forEach((row, r) => {
    const avail = MW - GAP * (row.length - 1);
    let x = X0, rowH = 0;
    rowY[r] = y;
    for (const box of row) {
      const bw = avail * (box.frac ?? 1 / row.length);
      box.items.forEach((list, s) => {
        const n = list.length;
        const cw = Math.min(box.chipW ?? 168, (bw - 24 - (n - 1) * 10) / n);
        const total = n * cw + (n - 1) * 10;
        list.forEach((chip, i) => rect.set(chip.id, { x: x + (bw - total) / 2 + i * (cw + 10), y: y + HEAD + s * (CHIP_H + (box.subGap ?? 12)), w: cw, h: CHIP_H, row: r, box: box.id, chip }));
      });
      const gap = box.subGap ?? 12;
      const bh = HEAD + box.items.length * (CHIP_H + gap) - gap + 14;
      rect.set(box.id, { x, y, w: bw, h: bh, row: r, isBox: true, box: box.id, spec: box });
      rowH = Math.max(rowH, bh);
      x += bw + GAP;
    }
    for (const box of row) rect.get(box.id).h = rowH;
    rowB[r] = y + rowH;
    y += rowH + CH;
  });
  let height = y + 10;
  if (spec.side) {
    const sy = rowY[spec.sideRow ?? 1];
    const chips = spec.side.items.flat();
    chips.forEach((chip, i) => rect.set(chip.id, { x: SX + 12, y: sy + HEAD + i * (CHIP_H + 10), w: SW - 24, h: CHIP_H, row: 'side', box: spec.side.id, chip }));
    const sh = HEAD + chips.length * (CHIP_H + 10) + 2;
    rect.set(spec.side.id, { x: SX, y: sy, w: SW, h: sh, row: 'side', isBox: true, box: spec.side.id, spec: spec.side });
    height = Math.max(height, sy + sh + 30);
  }
  const cx = (R) => R.x + R.w / 2;
  const chanTop = (c) => rowB[c];

  // Plan every line: which sides it leaves and enters by, and which channels and gutters it uses.
  const lines = spec.lines.filter((l) => rect.has(l.from) && rect.has(l.to));
  const plans = lines.map((l) => {
    const A = rect.get(l.from), B = rect.get(l.to);
    if (l.route === 'within') return { l, A, B, type: 'within' };
    if (A.row === B.row) return { l, A, B, type: 'same' };
    if (B.row === 'side') {
      const top = Math.max(A.y, B.y), bot = Math.min(A.y + A.h, B.y + B.h);
      if (A.isBox && A.x + A.w >= X0 + MW - 1 && bot - top > 12) return { l, A, B, type: 'horiz', y: (top + bot) / 2 };
      return { l, A, B, type: 'sideg', out: 'bottom', c1: A.row };
    }
    const down = B.row > A.row;
    const out = down ? 'bottom' : 'top', inn = down ? 'top' : 'bottom';
    if (Math.abs(B.row - A.row) === 1) return { l, A, B, type: 'chan', out, inn, c: Math.min(A.row, B.row) };
    return { l, A, B, type: 'gutter', out, inn, c1: down ? A.row : A.row - 1, c2: down ? B.row - 1 : B.row, left: (cx(A) + cx(B)) / 2 < X0 + MW / 2 };
  });
  // Spread the ends of a chip's lines along its edge, ordered by where they go.
  const ends = new Map();
  const end = (id, side, p, other) => { const k = `${id}:${side}`; (ends.get(k) ?? ends.set(k, []).get(k)).push({ p, other }); };
  for (const p of plans) {
    if (p.out) end(p.l.from, p.out, p, cx(p.B));
    if (p.inn) end(p.l.to, p.inn, p, cx(p.A));
  }
  const xAt = (id, side, p) => {
    const R = rect.get(id);
    if (R.isBox) {
      const O = id === p.l.from ? p.B : p.A;
      const lo = Math.max(R.x, O.x), hi = Math.min(R.x + R.w, O.x + O.w);
      return hi > lo ? (lo + hi) / 2 : cx(R);
    }
    const list = ends.get(`${id}:${side}`).sort((a, b) => a.other - b.other);
    const i = list.findIndex((e) => e.p === p), n = list.length;
    return cx(R) + (i - (n - 1) / 2) * Math.min(12, R.w / (n + 1));
  };
  const lanes = new Map();
  const lane = (key) => { const k = lanes.get(key) ?? 0; lanes.set(key, k + 1); return k; };
  const laneY = (c) => chanTop(c) + (spec.laneStart ?? 20) + lane(`c${c}`) * 8;
  const gutX = (left) => (left ? X0 - 20 - lane('gl') * 10 : X0 + MW + 18 + lane('gr') * 10);

  const drawn = [];
  for (const p of plans) {
    const { l, A, B } = p;
    let d, start, mid;
    if (p.type === 'within') {
      // Inside one box: straight between facing edges, above, below or beside.
      const [x1, y1, x2, y2] = B.y + B.h <= A.y ? [cx(A), A.y, cx(B), B.y + B.h] : B.y >= A.y + A.h ? [cx(A), A.y + A.h, cx(B), B.y] : B.x > A.x ? [A.x + A.w, A.y + A.h / 2, B.x, B.y + B.h / 2] : [A.x, A.y + A.h / 2, B.x + B.w, B.y + B.h / 2];
      d = `M${x1},${y1} L${x2},${y2}`;
      start = [x1, y1 - 10];
    } else if (p.type === 'same') {
      const rightward = cx(B) > cx(A);
      const yy = (Math.max(A.y, B.y) + Math.min(A.y + A.h, B.y + B.h)) / 2;
      const [x1, x2] = rightward ? [A.x + A.w, B.x] : [A.x, B.x + B.w];
      d = `M${x1},${yy} L${x2},${yy}`;
      mid = [(x1 + x2) / 2, yy - 8];
      start = [x1 + (rightward ? 10 : -10), yy];
    } else if (p.type === 'horiz') {
      d = `M${A.x + A.w},${p.y} L${B.x},${p.y}`;
      mid = [(A.x + A.w + B.x) / 2, p.y - 8];
      start = [A.x + A.w + 10, p.y];
    } else {
      const ex = xAt(l.from, p.out, p);
      const ey = p.out === 'bottom' ? A.y + A.h : A.y;
      start = [ex, ey + (p.out === 'bottom' ? 11 : -11)];
      if (p.type === 'sideg') {
        const ly = laneY(p.c1), gx = gutX(false), ty = B.y + B.h / 2;
        d = `M${ex},${ey} V${ly} H${gx} V${ty} H${B.x}`;
      } else {
        const nx = xAt(l.to, p.inn, p);
        const ny = p.inn === 'top' ? B.y : B.y + B.h;
        if (p.type === 'chan') {
          if (Math.abs(ex - nx) < 1) {
            d = `M${ex},${ey} V${ny}`;
            mid = [ex + 6, (ey + ny) / 2 + 4];
          } else {
            const ly = laneY(p.c);
            d = `M${ex},${ey} V${ly} H${nx} V${ny}`;
          }
        } else {
          const l1 = laneY(p.c1), gx = gutX(p.left), l2 = laneY(p.c2);
          d = `M${ex},${ey} V${l1} H${gx} V${l2} H${nx} V${ny}`;
        }
      }
    }
    drawn.push({ ...p, d, start, mid });
  }

  const parts = [`<defs>${['ok', 'bad', 'acc', 'decl', 'miss', 'rule'].map((c) => `<marker id="n-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="nm-${c}"/></marker>`).join('')}</defs>`];
  // The boxes, behind everything.
  for (const [id, R] of rect) {
    if (!R.isBox) continue;
    const box = R.spec;
    const note = box.note ? `<text class="nb-n" x="${R.x + R.w - 12}" y="${R.y + 22}" text-anchor="end">${esc(box.note)}</text>` : '';
    // A box that is a page of its own opens it, and its title is blue: a page one level down.
    const title = box.href ? `<a href="${esc(box.href)}"><text class="nb-t link" x="${R.x + 12}" y="${R.y + 22}">${esc(box.title)} →</text></a>` : `<text class="nb-t" x="${R.x + 12}" y="${R.y + 22}">${esc(box.title)}</text>`;
    // A count of what is off the design in the box, a link to where those lines are listed.
    let badge = '';
    if (box.badge) {
      const w = box.badge.text.length * 6.4 + 16;
      badge = `<a href="${esc(box.badge.href)}"><rect class="nb-badge" x="${R.x + R.w - 12 - w}" y="${R.y + 8}" width="${w}" height="19" rx="9.5"/><text class="nb-badge-t" x="${R.x + R.w - 12 - w / 2}" y="${R.y + 21.5}" text-anchor="middle">${esc(box.badge.text)}</text></a>`;
    }
    parts.push(`<g class="nbox b-${id}"><rect class="nb nb-${box.kind ?? 'layer'}" x="${R.x}" y="${R.y}" width="${R.w}" height="${R.h}" rx="10"/>${title}${note}${badge}</g>`);
  }
  // Declared callers' labels sit under the caller, one line per line it draws.
  const declBy = new Map();
  for (const p of drawn) if (p.l.declared && p.l.label && p.type !== 'same' && p.type !== 'horiz') (declBy.get(p.l.from) ?? declBy.set(p.l.from, []).get(p.l.from)).push(p);
  const order = { ok: 0, miss: 1, decl: 2, acc: 3, bad: 4, rule: 5 };
  for (const p of [...drawn].sort((a, b) => order[a.l.kind] - order[b.l.kind])) {
    const { l } = p;
    const cls = `nl nl-${l.kind} f-${l.from} t-${l.to} fb-${p.A.box} tb-${p.B.box}`;
    const line = `<path class="${cls}" d="${p.d}" marker-end="url(#n-${l.kind})"><title>${esc(l.title ?? '')}</title></path>`;
    if (l.kind === 'bad' || l.kind === 'acc' || l.kind === 'rule') {
      // A deviation's circle opens it: what it breaks, its files, and a prompt to scope the fix. A rule's jumps to its card on the Design tab.
      parts.push(`<a href="${l.href}" data-dev="${l.id}" class="nl-a"><path class="nl-hit" d="${p.d}"/>${line}<circle class="nl-num nl-num-${l.kind} f-${l.from} t-${l.to}" cx="${p.start[0]}" cy="${p.start[1]}" r="8"/><text class="nl-num-t f-${l.from} t-${l.to}" x="${p.start[0]}" y="${p.start[1] + 3.5}" text-anchor="middle">${l.n}</text><title>${esc(l.title ?? '')}</title></a>`);
    } else parts.push(line);
    if (l.label && p.mid && !(l.declared && declBy.has(l.from))) {
      const anchor = p.type === 'chan' ? 'start' : 'middle';
      parts.push(`<text class="nl-l nl-l-${l.kind} f-${l.from} t-${l.to}" x="${p.mid[0]}" y="${p.mid[1]}" text-anchor="${anchor}">${esc(l.label)}</text>`);
    }
  }
  for (const [id, list] of declBy) {
    const R = rect.get(id);
    const text = list.length > 1 ? list.map((p) => `→ ${p.l.toName}: ${p.l.label}`) : [list[0].l.label];
    const out = text.flatMap((t) => wrap(t, R.w + 14, 5.4));
    out.forEach((t, i) => parts.push(`<text class="nl-l nl-l-decl f-${id}" x="${cx(R)}" y="${R.y + R.h + 13 + i * 11.5}" text-anchor="middle">${esc(t)}</text>`));
  }
  // The chips, on top.
  for (const [id, R] of rect) {
    if (R.isBox) continue;
    let { chip } = R;
    const cls = { component: 'nc', client: 'nc-cl', store: 'nc-st', outside: 'nc-ext' }[chip.kind];
    const name = firstLine(chip.name, R.w - 12, 6.9);
    const sub = firstLine(chip.sub ?? '', R.w - 12, 5.6);
    // A cut name or description ends in an ellipsis, and its full text is the tooltip.
    if (name.cut || sub.cut) chip = { ...chip, tip: [[chip.name, chip.sub].filter(Boolean).join(' - '), chip.tip || (chip.href ? `Open ${chip.name}` : '')].filter(Boolean).join('\n') };
    // A store or an outside service that is a page of its own opens it, and its name is blue: a page one level down.
    const body = `<rect class="${cls}" x="${R.x}" y="${R.y}" width="${R.w}" height="${R.h}" rx="${chip.kind === 'client' ? 14 : 6}"/><text class="nc-t${chip.href ? ' t-link' : ''}" x="${R.x + 8}" y="${R.y + 19}">${esc(name.text)}</text><text class="nc-s" x="${R.x + 8}" y="${R.y + 35}">${esc(sub.text)}</text>`;
    parts.push(`<g class="node n-${id}">${chip.href ? `<a href="${esc(chip.href)}">${body}<title>${esc(chip.tip || `Open ${chip.name}`)}</title></a>` : codeLinked(chip, body, R.x + R.w, R.y, links)}</g>`);
  }
  const W = spec.side ? SX + SW + 20 : X0 + MW + 60;
  const fade = (sel, keep) => `svg.nested:has(${sel}:hover) .nl:not(${keep}), svg.nested:has(${sel}:hover) .nl-l:not(${keep}), svg.nested:has(${sel}:hover) .nl-num:not(${keep}), svg.nested:has(${sel}:hover) .nl-num-t:not(${keep}) { opacity: .07; }`;
  const focus = [...rect].map(([id, R]) => (R.isBox ? fade(`.b-${id} > rect`, `.fb-${id}, .tb-${id}`) : fade(`.n-${id}`, `.f-${id}, .t-${id}`))).join('\n');
  return { svg: `<svg class="nested" viewBox="0 0 ${W} ${height}" style="min-width:1000px" role="img" aria-label="${esc(spec.label)}">${parts.join('\n')}</svg>`, focus };
}

// ---- the page, from the model

/** The design's rows of boxes, the column beside them, and every line to draw, from the model's logical section. */
export function specOf(logical, links) {
  const boxId = (layerId) => `L-${layerId}`;
  const layerById = new Map(logical.layers.map((layer) => [layer.id, layer]));
  const chipById = new Map(logical.layers.flatMap((layer) => layer.items.flat().map((chip) => [chip.id, { ...chip, layer: layer.id }])));
  const nameOf = (id) => chipById.get(id)?.name ?? id;
  const boxOf = (layer) => {
    const inside = logical.inside[layer.id];
    return { id: boxId(layer.id), title: layer.title, kind: layer.kind, href: layer.href ?? undefined, chipW: layer.chipW ?? undefined, subGap: layer.subGap ?? undefined, frac: layer.share ?? undefined, note: layer.note || (inside && !layer.drawInside ? `${plural(inside, 'line')} inside, not drawn` : ''), items: layer.items };
  };
  const rowNumbers = [...new Set(logical.layers.filter((layer) => layer.alignedWith === null).map((layer) => layer.row))].sort((a, b) => a - b);
  const rows = rowNumbers.map((row) => logical.layers.filter((layer) => layer.alignedWith === null && layer.row === row).map(boxOf));
  const sideLayer = logical.layers.find((layer) => layer.alignedWith !== null);
  const sideRow = sideLayer ? rows.findIndex((row) => row.some((box) => box.id === boxId(sideLayer.alignedWith))) : 0;

  const files = (list) => list.join('\n');
  const lines = [
    ...logical.ok.map((g) => ({ from: boxId(g.a), to: boxId(g.b), kind: 'ok', label: `${g.kinds.join(', ')} · ${plural(g.files.length, 'file')}`, title: `${layerById.get(g.a).title} → ${layerById.get(g.b).title}: in the design, and in the code\n${files(g.files)}` })),
    ...logical.miss.map(({ a, b }) => ({ from: boxId(a), to: boxId(b), kind: 'miss', label: 'in the design, not in the code', title: `${layerById.get(a).title} → ${layerById.get(b).title}: the design draws it; no file does it` })),
    ...logical.callers.map((c) => ({ from: c.from, to: c.to, declared: true, kind: c.status === 'notFound' ? 'miss' : 'decl', label: callLabel(c), toName: nameOf(c.to), title: `${c.from} → ${c.to}: ${callLabel(c)}${c.status === 'notFound' ? ' (not found in the code)' : c.addresses.length ? `\nFound in ${c.files.join(', ')}` : ''}` })),
    ...logical.within.map((w) => ({ from: w.from, to: w.to, kind: 'ok', route: 'within', title: `${nameOf(w.from)} → ${nameOf(w.to)}: ${verbOf(w, logical)}, ${plural(w.files.length, 'file')}${logical.findLines ? `\n${files(w.files)}` : ''}` })),
    ...logical.accepted.map((e) => ({ from: e.from, to: e.to, kind: 'acc', n: '✓', id: e.id, href: `#${e.id}`, title: `Accepted: ${e.accepted.reason}\n${files(e.files)}` })),
    ...logical.bad.map((e) => ({ from: e.from, to: e.to, kind: 'bad', n: e.n, id: e.id, href: `#${e.id}`, title: `${e.n}. ${e.why}${e.partly ? `\nAccepted for ${e.partly.files.join(', ')}; new: ${e.newFiles.join(', ')}` : ''}\n${files(e.files)}\nClick to copy a /scoping prompt` })),
  ];
  return { rows, side: sideLayer ? boxOf(sideLayer) : undefined, sideRow, lines, nameOf, layerById, chipById, logical, links };
}

export const NLEGEND = `<div class="legend">
<span><i class="ln" style="border-top-width:2px"></i>In the design and in the code: one line per pair of layers</span>
<span><i class="ln up"></i>In the code, not in the design: numbered, drawn around what it skips</span>
<span><i class="ln" style="border-top-color:var(--ink-3)"></i>Off the design, but accepted with a reason: marked ✓</span>
<span><i class="ln" style="border-top-style:dotted"></i>In the design, not in the code</span>
<span><i class="ln" style="border-top-color:var(--accent);border-top-style:dashed"></i>How a caller talks to it: declared</span>
</div><p class="sectionnote">Hover a box or a component to see only its lines. Click a red or ✓ circle for its files and a prompt to scope it, a layer's title for its modules, a store for its tables, and a component marked ↗ for its code on GitHub. Every file listed below opens on GitHub at the line that makes the line in the diagram.</p>`;

function offTable(logical, { nameOf, layerById }, links) {
  if (!logical.bad.length) return '<p class="ok">None: every line in the code is one the design draws, or one accepted with a reason.</p>';
  const cell = (id, layerId) => `${esc(nameOf(id))}<br><span class="dim">${esc(layerById.get(layerId).title)}</span>`;
  return `<div class="scroll"><table class="flows"><tr><th></th><th>From</th><th>To</th><th>What it breaks</th><th>Files</th><th></th></tr>${logical.bad.map((e) => `<tr class="bad" id="${e.id}"><td><span class="num">${e.n}</span></td><td>${cell(e.from, e.a)}</td><td>${cell(e.to, e.b)}</td><td>${esc(e.why)}${e.kind === 'store' || e.how.length ? ` <span class="dim">(${esc(e.how.join(', ') || 'imports it')})</span>` : ''}${e.partly ? `<br><span class="dim">Accepted for ${esc(e.partly.files.map((file) => file.split('/').pop()).join(', '))}, not for ${esc(e.newFiles.map((file) => file.split('/').pop()).join(', '))}, which ${e.newFiles.length === 1 ? 'is' : 'are'} new.</span>` : ''}</td><td>${links.files(e.files, e.at)}</td><td><button class="copy" data-dev="${e.id}">Scope a fix</button></td></tr>`).join('')}</table></div>`;
}

function missTable(logical, { nameOf, layerById }) {
  const rows = [
    ...logical.miss.map((m) => `<tr><td>${esc(layerById.get(m.a).title)}</td><td>${esc(layerById.get(m.b).title)}</td><td>the design draws it; no file does it</td></tr>`),
    ...logical.callers.filter((c) => c.status === 'notFound').map((c) => `<tr><td>${esc(nameOf(c.from))}</td><td>${esc(nameOf(c.to))}</td><td>declared as <i>${esc(c.how)}</i>; not found in its code</td></tr>`),
  ];
  return rows.length ? `<div class="scroll"><table class="flows"><tr><th>From</th><th>To</th><th></th></tr>${rows.join('')}</table></div>` : '<p class="ok">None: every line the design draws has code behind it.</p>';
}

function callerTable(logical, { nameOf }, links) {
  const looked = (c) => (c.status === 'elsewhere' ? '<span class="dim">its code is not in this repository</span>' : c.status === 'found' ? `<details class="files"><summary>found, ${plural(c.files.length, 'file')}</summary>${links.files(c.files, c.at, '')}</details>` : '<span class="bad">not found</span>');
  return `<div class="scroll"><table class="flows"><tr><th>Caller</th><th>To</th><th>How</th><th>Looked for in the code</th></tr>${logical.callers.map((c) => `<tr><td>${esc(nameOf(c.from))}</td><td>${esc(nameOf(c.to))}</td><td>${esc(c.how)}</td><td>${looked(c)}</td></tr>`).join('')}</table></div>`;
}

/** A folder the design does not place, a component naming a folder that is gone, or a folder in two components: the page says so. */
function placementProblems(logical) {
  const { unplaced, gone, doubled } = logical.placement;
  const items = [
    ...unplaced.map((folder) => `<code>${esc(folder)}</code> is in no component`),
    ...gone.map((each) => `<code class="gone">${esc(each.folder)}</code>, named by ${esc(each.components.join(', '))}, is not in the code`),
    ...doubled.map((each) => `<code>${esc(each.folder)}</code> is in two components: ${esc(each.components.join(', '))}`),
  ];
  return items.length ? `<p class="bad">The design does not match the code's folders:</p><ul>${items.map((each) => `<li>${each}</li>`).join('')}</ul>` : '';
}

/** @returns {string} a complete HTML document: Cockpit's design with the code's lines laid over it */
export function renderLogicalPage(model, service = {}) {
  const logical = service.logical ?? model.logical;
  const name = service.name ?? 'Cockpit';
  const { drawnFrom } = model;
  const links = linksFor(drawnFrom);
  const spec = { ...specOf(logical, links), service: name };
  const styles = `${readFileSync(path.join(here, 'styles.css'), 'utf8')}${readFileSync(path.join(here, 'logical.css'), 'utf8')}`;
  const drawing = renderNested({ label: `${name}: the design, with the code laid over it`, rows: spec.rows, side: spec.side, sideRow: spec.sideRow, lines: spec.lines, laneStart: 34 }, links);

  const count = logical.bad.length;
  const readByAll = logical.noLine.filter((each) => each.readByEveryone).map((each) => {
    const label = each.name.includes('/') && links.known ? `<a class="gh" href="${esc(links.url(each.folder, { folder: true }))}" target="_blank" rel="noopener"><code>${esc(each.name)}</code></a>` : `<code>${esc(each.name)}</code>`;
    return `${label}${each.note ? `, ${esc(each.note)},` : ''}`;
  });
  const standfirst = `${service.intro ? `${prose(service.intro)} ` : ''}The layers it is meant to have, drawn clean, with every line ${service.intro ? 'its' : 'the'} code really has laid over them. <b class="bad">${plural(count, 'line')}</b> in the code ${count === 1 ? 'is' : 'are'} not in the design.${readByAll.length ? ` ${readByAll.join(' and ')} ${readByAll.length === 1 ? 'is' : 'are'} read by nearly everything and drawn as no line.` : ''}`;
  // Cockpit's page always shows the sections for acceptances and callers; another service's shows them once it has something to say.
  const rulesFile = 'docs/architecture.yml';
  const own = service.logical !== undefined && service.id !== 'cockpit';
  const acceptances = !own || logical.accepted.length > 0 || logical.stale.length > 0
    ? `<h2 id="acc">Accepted, with a reason</h2><p class="sectionnote">Grey on the diagram. Accepted for the files named; the same line from any other file is red again. Written by hand in ${links.file(rulesFile)}, the rules file.</p>${accTable(logical, spec, links)}`
    : '';
  const callers = !own || logical.callers.some((caller) => caller.status !== 'elsewhere')
    ? `<h2>How each caller talks to it</h2>${callerTable(logical, spec, links)}`
    : '';
  const commitLine = commitLineOf(drawnFrom, links);
  // A service whose box is opened inside Cockpit's diagram: its parts, what it talks to, and its lines.
  const opened = isOpened(logical);
  const switcher = serviceTabs(model, service, 'Logical');
  const trail = crumbTrail([...trailOf(model), ...(opened ? [['Cockpit', designFile(LOGICAL_FILE)]] : []), [name]]);
  const body = opened
    ? `${placementProblems(logical)}${partsLegend(name)}<div class="diagram">${drawing.svg}</div>
<h2>Its lines</h2><p class="sectionnote">${esc(LINES_NOTE)} Every file listed opens on GitHub at the line that makes the line in the diagram.</p>${partsLines(logical, spec, links)}`
    : `${placementProblems(logical)}${NLEGEND}<div class="diagram">${drawing.svg}</div>
<h2 id="off">In the code, not in the design</h2><p class="sectionnote">The numbers match the red lines. Click a red circle, or Scope a fix, for a prompt to paste into Claude Code.</p>${offTable(logical, spec, links)}
${acceptances}
<h2>In the design, not in the code</h2>${missTable(logical, spec)}
${callers}
${dialog(devData({ ...spec, commit: drawnFrom.commit }))}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(name)} Architecture &middot; Cockpit</title>
<style>${styles}${drawing.focus}</style>
</head>
<body>
<div class="wrap wide">
<header class="masthead"><p class="crumbs">${trail}</p><h1>${esc(name)}</h1>${switcher}<p class="standfirst">${linkPaths(opened ? prose(service.intro ?? '') : standfirst, links)}</p>
<div class="runmeta">${commitLine}</div></header>
${linkPaths(body, links)}
</div>
</body>
</html>
`;
}
