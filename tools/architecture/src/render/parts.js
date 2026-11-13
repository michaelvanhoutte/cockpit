/**
 * The page of a service whose box in Cockpit's diagram is opened to show its parts: the parts, the dotted box of what
 * it talks to beneath them, a legend, and a table of its lines. The lines between its parts are found by name, which
 * the page says, since a common word used as a name can draw a line that is not there.
 */

import { esc } from './svg.js';

/** A design is drawn this way when one of its layers is a box opened to show its parts. */
export const isOpened = (logical) => logical.layers.some((layer) => layer.kind === 'service');

/** What a line inside a layer does, in a word: a store is reached by a marker, and a design that finds its lines by name says its parts use each other. */
export const verbOf = (line, logical) => (line.kind === 'store' ? line.how.join(', ') || 'uses' : logical.findLines ? 'uses' : 'imports');

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const partsLegend = (name) => `<div class="legend"><span><i class="ln" style="border-top-width:2px"></i>Inside ${esc(name)}: one part uses another, found in the code</span><span><i class="ln" style="border-top-color:var(--accent);border-top-style:dashed"></i>Leaving ${esc(name)}: how it talks to what it calls, found in its code</span></div>`;

/** Every line of the design, inside the box and leaving it, with the files that make it each linked at its line. */
export function partsLines(logical, { nameOf }, links) {
  const rows = [
    ...logical.within.map((each) => ({ from: each.from, to: each.to, how: verbOf(each, logical), files: each.files, at: each.at, state: 'found' })),
    ...logical.callers.map((each) => ({ from: each.from, to: each.to, how: each.addresses.length ? `${each.addresses.join(', ')} · ${each.how}` : each.how, files: each.files, at: each.at, state: each.status })),
  ];
  const files = (row) => (row.state === 'found' ? `<details class="files"><summary>${plural(row.files.length, 'file')}</summary>${links.files(row.files, row.at, '')}</details>` : row.state === 'notFound' ? '<span class="bad">not found in the code</span>' : '<span class="dim">declared</span>');
  return `<div class="scroll"><table class="flows"><tr><th>From</th><th>To</th><th>How</th><th>Files</th></tr>${rows.map((row) => `<tr><td>${esc(nameOf(row.from))}</td><td>${esc(nameOf(row.to))}</td><td>${esc(row.how)}</td><td>${files(row)}</td></tr>`).join('')}</table></div>`;
}

export const LINES_NOTE = 'A line between two parts is found by name: a part uses another when one of its files names a class or function that the other\'s files define. Names in comments are left out, and a part naming its own class draws nothing. A common word used as a name can draw a line that is not there.';
