/**
 * The Modules diagram, computed from the model: a band per layer, a card per
 * area in a grid inside it. A card is as tall as its wording and marks need
 * and a row of cards as tall as its tallest, so nothing is placed by hand and
 * nothing can overlap however many areas or marks there are.
 *
 * A card's outline says what is wrong with it, if anything; its lines say why.
 */

import { esc, MONO, SANS, wrap } from './svg.js';

const WIDTH = 1200;
const PAD = 16;
const BAND_PAD = 16;
const GAP = 16;
const LINE = 18;
const MAX_COLUMNS = 4;
/** Files listed under a mark before "+N more": the model holds them all. */
const SHOWN = 3;

const UNDESCRIBED_TITLE = 'Not in the description file';
const UNDESCRIBED_NOTE = 'Areas on disk that tools/architecture/description.yml does not mention yet.';

/** The lines a card says, each with the dot (or none) it starts with. */
function linesOf(area, width) {
  const text = width - 44;
  const lines = [];
  const say = (kind, dot, words, perChar = SANS) => wrap(words, text, perChar).forEach((line, index) => lines.push({ kind, dot: index === 0 ? dot : null, text: line }));
  const files = (list) => {
    list.slice(0, SHOWN).forEach((file) => wrap(file, text - 8, MONO * 0.9).forEach((line, index) => lines.push({ kind: 't-m', dot: null, indent: index === 0 ? 0 : 8, text: line })));
    if (list.length > SHOWN) lines.push({ kind: 't-m', dot: null, text: `+${list.length - SHOWN} more` });
  };

  if (area.state === 'gone') say('t-red', 'd-red', 'Gone: the description file describes it, but it is not on disk');
  if (area.state === 'undescribed') say('t-amber', 'd-amber', 'Undescribed: not in the description file');
  if (area.description) say('t-i', null, area.description);
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

export function renderModules(model) {
  const { layers } = model.modules;
  const innerWidth = WIDTH - 2 * (PAD + BAND_PAD);
  const parts = [];
  let y = PAD;

  for (const layer of layers) {
    const title = layer.title ?? UNDESCRIBED_TITLE;
    const note = layer.title === null ? UNDESCRIBED_NOTE : layer.note;
    const columns = MAX_COLUMNS;
    const cardWidth = (innerWidth - (columns - 1) * GAP) / columns;
    const noteLines = note ? wrap(note, innerWidth, SANS) : [];

    const cards = layer.areas.map((area) => {
      const lines = linesOf(area, cardWidth);
      const titleLines = wrap(area.path, cardWidth - 28, MONO);
      return { area, lines, titleLines, height: 16 + titleLines.length * LINE + 8 + Math.max(lines.length, 1) * LINE + 12 };
    });
    const rows = [];
    for (let i = 0; i < cards.length; i += columns) rows.push(cards.slice(i, i + columns));

    const headerHeight = 38 + noteLines.length * LINE;
    const bandHeight = BAND_PAD + headerHeight + rows.reduce((sum, row) => sum + Math.max(...row.map((each) => each.height)) + GAP, 0) - (rows.length ? GAP : 0) + BAND_PAD;
    parts.push(
      `<rect class="soft" x="${PAD}" y="${y}" width="${WIDTH - 2 * PAD}" height="${bandHeight}" rx="6"/>`,
      `<text class="t-h" x="${PAD + BAND_PAD}" y="${y + BAND_PAD + 14}">${esc(title)}</text>`,
      ...noteLines.map((line, index) => `<text class="t-m" x="${PAD + BAND_PAD}" y="${y + BAND_PAD + 36 + index * LINE}">${esc(line)}</text>`),
    );

    let rowTop = y + BAND_PAD + headerHeight;
    for (const row of rows) {
      const rowHeight = Math.max(...row.map((each) => each.height));
      row.forEach((card, column) => {
        const x = PAD + BAND_PAD + column * (cardWidth + GAP);
        parts.push(`<rect class="${outlineOf(card.area)}" x="${x}" y="${rowTop}" width="${cardWidth}" height="${rowHeight}" rx="5"/>`);
        card.titleLines.forEach((line, index) => parts.push(`<text class="t-h" x="${x + 14}" y="${rowTop + 26 + index * LINE}">${esc(line)}</text>`));
        const bodyTop = rowTop + 16 + card.titleLines.length * LINE + 8 + 12;
        card.lines.forEach((line, index) => {
          const baseline = bodyTop + index * LINE;
          if (line.dot) parts.push(`<circle class="${line.dot}" cx="${x + 18}" cy="${baseline - 4}" r="4"/>`);
          parts.push(`<text class="${line.kind}" x="${x + (line.dot ? 30 : 14) + (line.indent ?? 0)}" y="${baseline}">${esc(line.text)}</text>`);
        });
      });
      rowTop += rowHeight + GAP;
    }
    y += bandHeight + GAP;
  }

  const height = Math.ceil(y - GAP + PAD);
  const label = `Module map of Cockpit: ${layers.map((layer) => `${layer.title ?? UNDESCRIBED_TITLE} (${layer.areas.length})`).join(', ')}.`;
  return `<svg viewBox="0 0 ${WIDTH} ${height}" style="min-width:900px" role="img" aria-label="${esc(label)}">
  ${parts.join('\n  ')}
</svg>`;
}
