/**
 * The bundle gate (docs/architecture.md, "Performance budgets"): the JavaScript
 * a cold open has to fetch stays under 200KB compressed, and so does any one
 * chunk fetched later.
 *
 * **Two lines, not one.** Charging a lazy chunk to the entry would make
 * splitting pointless - the editor behind the Item's form is 135KB compressed
 * and never on the cold-open path, and a single combined budget would be
 * failing today with nothing wrong. What makes a chunk lazy is exactly what
 * keeps it off that path: nothing the entry document references reaches it.
 *
 * Pure on purpose, so the arithmetic is tested by `node --test` with no build
 * and no install (the Scripts job in .github/workflows/ci.yml).
 */

export const BUDGET_BYTES = 200 * 1024;

/**
 * Which built files a cold open fetches: the ones the entry document names,
 * plus everything they pull in.
 *
 * Read out of the HTML rather than out of Rollup's metadata, because the HTML
 * is what the browser obeys. Vite writes the entry as a `<script type=module>`
 * and each of its static imports as a `<link rel=modulepreload>`; a chunk
 * reached only through `import()` appears in neither.
 */
export function referencedByTheDocument(html) {
  const named = new Set();
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    named.add(reference.replace(/^.*\//, ''));
  }
  return named;
}

/**
 * What each budget is spending, and what is over.
 *
 * @param {{ file: string, bytes: number }[]} assets every built JavaScript file, compressed
 * @param {Set<string>} referenced what {@link referencedByTheDocument} found
 * @param {number} budget the cap each line is measured against
 */
export function whatTheBundleCosts(assets, referenced, budget = BUDGET_BYTES) {
  const initial = assets.filter(({ file }) => referenced.has(file));
  const lazy = assets.filter(({ file }) => !referenced.has(file));
  const initialBytes = initial.reduce((total, { bytes }) => total + bytes, 0);

  const over = [];
  if (initialBytes > budget) {
    over.push({ what: 'the initial bundle', bytes: initialBytes, budget });
  }
  for (const chunk of lazy) {
    if (chunk.bytes > budget) over.push({ what: chunk.file, bytes: chunk.bytes, budget });
  }

  return { initial, initialBytes, lazy, over, budget };
}

/** The report, as the build job prints it. */
export function asALine({ file, bytes }) {
  return `${(bytes / 1024).toFixed(1).padStart(7)}KB  ${file}`;
}
