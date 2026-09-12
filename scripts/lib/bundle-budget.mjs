/**
 * The bundle gate (docs/architecture.md, "Performance budgets"): the JavaScript
 * a cold open has to fetch stays under 200KB compressed, and so does any one
 * file fetched separately.
 *
 * **Two lines, not one.** Charging a lazy chunk to the entry would make
 * splitting pointless - the editor behind the Item's form is 135KB compressed
 * and never on the cold-open path, and a single combined budget would be
 * failing today with nothing wrong. What makes a chunk lazy is exactly what
 * keeps it off that path: nothing the entry document references reaches it.
 *
 * **Everything built is on one line or the other, and nothing is unmeasured.**
 * The service worker and its registration script are emitted beside `assets/`
 * rather than inside it, and `registerSW.js` is referenced by the entry
 * document - so a gate that read only `assets/` left a file the cold open
 * fetches out of the sum it exists to hold.
 *
 * Pure but for one directory walk, so all of it is tested by `node --test` with
 * no build and no install (the Scripts step of `checks` in .github/workflows/ci.yml).
 */

import { readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

export const BUDGET_BYTES = 200 * 1024;

/**
 * Every JavaScript file a build emitted, wherever it put it, named by its path
 * below the build directory.
 *
 * The whole tree rather than `assets/`: Vite's PWA plugin writes `sw.js`,
 * `workbox-*.js` and `registerSW.js` beside it, and the entry document
 * references the last of those - so reading only `assets/` left a file every
 * cold open fetches out of the sum this exists to hold.
 */
export function javascriptIn(build, within = build) {
  const found = [];
  for (const entry of readdirSync(within, { withFileTypes: true })) {
    const path = join(within, entry.name);
    if (entry.isDirectory()) found.push(...javascriptIn(build, path));
    else if (entry.name.endsWith('.js')) found.push(relative(build, path).split(sep).join(posix.sep));
  }
  return found.sort();
}

/**
 * Which built files a cold open fetches: the ones the entry document names,
 * plus everything they pull in.
 *
 * Read out of the HTML rather than out of Rollup's metadata, because the HTML
 * is what the browser obeys. Vite writes the entry as a `<script type=module>`
 * and each of its static imports as a `<link rel=modulepreload>`; a chunk
 * reached only through `import()` appears in neither.
 *
 * Kept as the path below the build directory rather than as a bare filename,
 * so two files that differ only by folder are two files here as well.
 */
export function referencedByTheDocument(html) {
  const named = new Set();
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    named.add(reference.replace(/^\.?\//, ''));
  }
  return named;
}

/**
 * What each budget is spending, and what is over.
 *
 * @param {{ file: string, bytes: number }[]} assets every built JavaScript file, compressed,
 *   named by its path below the build directory
 * @param {Set<string>} referenced what {@link referencedByTheDocument} found
 * @param {number} budget the cap each line is measured against
 */
export function whatTheBundleCosts(assets, referenced, budget = BUDGET_BYTES) {
  const initial = assets.filter(({ file }) => referenced.has(file));
  const separate = assets.filter(({ file }) => !referenced.has(file));
  const initialBytes = initial.reduce((total, { bytes }) => total + bytes, 0);

  const over = [];
  if (initialBytes > budget) {
    over.push({ what: 'the initial bundle', bytes: initialBytes, budget });
  }
  for (const chunk of separate) {
    if (chunk.bytes > budget) over.push({ what: chunk.file, bytes: chunk.bytes, budget });
  }

  return { initial, initialBytes, separate, over, budget };
}

/** The report, as the build job prints it. */
export function asALine({ file, bytes }) {
  return `${(bytes / 1024).toFixed(1).padStart(7)}KB  ${file}`;
}
