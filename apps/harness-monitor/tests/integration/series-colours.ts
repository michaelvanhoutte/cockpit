/** The colours a Monitor page draws its series in, read off the markup the way the stylesheet will paint it. */

export const slot = (n: number) => `var(--series-${n})`;
export const GREY = 'var(--series-grey)';
export const RED = 'var(--over)';

const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&rsquo;/g, '’');

/** A panel of the page, by the heading that names it. */
export const panelOf = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';

/** Every swatch in `markup` with the name beside it, in the order drawn: a legend row, a key or a column head. */
export const swatches = (markup: string): [name: string, colour: string][] =>
  [...markup.matchAll(/<i [^>]*style="background:([^"]*)"[^>]*><\/i>(?:<span class="name">)?([^<]*)/g)].map(([, colour, name]) => [decode(name!).trim(), colour!]);

/** Every coloured segment of the bars in `markup`, left to right: what it is called, where the bar says, and its colour. */
export const segments = (markup: string): [name: string, colour: string][] =>
  [...markup.matchAll(/<div style="[^"]*background:([^";]*)"(?: title="([^"]*)")?><\/div>/g)].map(([, colour, title]) => [decode(title ?? ''), colour!]);

/** The colours of a list of swatches or segments, in order. */
export const coloursOf = (list: [string, string][]) => list.map(([, colour]) => colour);
