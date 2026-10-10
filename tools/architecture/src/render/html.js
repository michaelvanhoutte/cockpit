/**
 * The renderer: the model in, a single self-contained HTML file out. Imports
 * nothing from the reading side. One file that opens from disk: the styles
 * are inline, there is no script, and the only addresses in it are links a
 * reader follows.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderChanges } from './changes.js';
import { renderContext } from './context.js';
import { renderDependencies, cycleSummary, orderNote } from './dependencies.js';
import { renderDiagram } from './diagram.js';
import { renderModules } from './modules.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const day = (iso) => iso.slice(0, 10);

/** The report's commit line, shared by every page so none words it again. */
function commitLine({ commit, repo }) {
  if (!commit) return '<span>commit <b>not known</b></span>';
  return repo
    ? `<span>commit <a href="${esc(`https://github.com/${repo}/commit/${commit}`)}" target="_blank" rel="noopener"><b>${esc(commit.slice(0, 7))}</b></a></span>`
    : `<span>commit <b>${esc(commit.slice(0, 7))}</b></span>`;
}

/** The pages beside the report, one per diagram: the file each is written to, and the diagram it holds. */
export const DIAGRAM_PAGES = {
  context: { file: 'context.html', title: 'Context', render: renderContext },
  modules: { file: 'modules.html', title: 'Modules', render: renderModules },
  deployment: { file: 'deployment.html', title: 'Deployment', render: renderDiagram },
};

/** A diagram on the report: the whole drawing is a link to its own page, in a new tab. */
const opener = (key, svg) => `<a class="open" href="${DIAGRAM_PAGES[key].file}" target="_blank" rel="noopener">${svg}</a>`;
const openLink = (key) => `<a class="openfull" href="${DIAGRAM_PAGES[key].file}" target="_blank" rel="noopener">Open full size &rarr;</a>`;

/** The drawing at the size it was drawn: the width and height its own viewBox gives. */
function atNaturalSize(svg) {
  const match = svg.match(/^<svg viewBox="0 0 ([\d.]+) ([\d.]+)" style="[^"]*"/);
  if (!match) throw new Error('a diagram did not start with a sized <svg>');
  return svg.replace(match[0], `<svg viewBox="0 0 ${match[1]} ${match[2]}" style="width:${match[1]}px;height:${match[2]}px"`);
}

/**
 * One page per diagram, each its diagram at natural size in a box that scrolls
 * both ways, with the report's styles and its commit line.
 * @returns {Record<string, string>} the file name to the complete HTML document
 */
export function renderDiagramPages(model) {
  const styles = readFileSync(path.join(here, 'styles.css'), 'utf8');
  const { date } = model.drawnFrom;
  return Object.fromEntries(
    Object.values(DIAGRAM_PAGES).map(({ file, title, render }) => [
      file,
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Cockpit Architecture &middot; ${title}</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap wide">
  <header class="masthead">
    <p class="eyebrow">Cockpit &middot; architecture</p>
    <h1>${title}</h1>
    <div class="runmeta">
      ${commitLine(model.drawnFrom)}
      <span>commit dated <b>${date ? esc(day(date)) : 'not known'}</b></span>
      <span><a href="index.html"><b>&larr; Back to the report</b></a></span>
    </div>
  </header>
  <div class="diagram full">
    ${atNaturalSize(render(model))}
  </div>
</div>
</body>
</html>
`,
    ]),
  );
}

/**
 * @param {ReturnType<import('../model.js').buildModel>} model
 * @param {{ explorerHref?: string, stabilityHref?: string, leadTimeHref?: string, selectionHref?: string, comparison?: object }} [options] `comparison` is what compare.js answered; without one the section says there is nothing to compare
 * @returns {string} a complete HTML document
 */
export function renderHtml(model, { explorerHref = '../', stabilityHref = '../stability/', leadTimeHref = '../lead-time/', selectionHref = '../selection/', comparison = { state: 'unavailable', reason: 'no earlier report was given to compare against' } } = {}) {
  const styles = readFileSync(path.join(here, 'styles.css'), 'utf8');
  const { date } = model.drawnFrom;
  const commitCell = commitLine(model.drawnFrom);
  const { environments, workflows } = model.deployment;
  const { counts, connectors } = model.modules;
  const fileCount = counts.connectorFilesInCore;
  const mutedAreas = model.dependencies.areas.filter((each) => each.muted);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Cockpit Architecture</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <p class="eyebrow">Cockpit &middot; architecture</p>
    <h1>Architecture</h1>
    <p class="standfirst">
      How Cockpit is built, drawn from the repository alone: who and what it talks to, the areas the code is made of
      and what in them breaks the agreed boundaries, and where it runs.
    </p>
    <div class="runmeta">
      ${commitCell}
      <span>commit dated <b>${date ? esc(day(date)) : 'not known'}</b></span>
      <span>${plural(counts.areas, 'area')}</span>
      <span>${plural(environments.length, 'environment')}</span>
      <span>${plural(workflows.length, 'workflow')}</span>
      <span><a href="${esc(explorerHref)}"><b>Test explorer &rarr;</b></a></span>
      <span><a href="${esc(stabilityHref)}"><b>CI stability &rarr;</b></a></span>
      <span><a href="${esc(leadTimeHref)}"><b>Lead time &rarr;</b></a></span>
      <span><a href="${esc(selectionHref)}"><b>Selection &rarr;</b></a></span>
    </div>
    <nav class="views" aria-label="Views"><a href="#changes">What changed</a><a href="#context">Context</a><a href="#modules">Modules</a><a href="#deps">Dependencies</a><a href="#deployment">Deployment</a></nav>
  </header>

  <section id="changes">
  <h2>What changed</h2>
  ${renderChanges(comparison)}
  </section>

  <section id="context">
  <h2>Context ${openLink('context')}</h2>
  <p class="sectionnote">Who uses Cockpit and the outside services it depends on, as <code>tools/architecture/description.yml</code> declares them.</p>
  <div class="diagram">
    ${opener('context', renderContext(model))}
  </div>
  </section>

  <section id="modules">
  <h2>Modules ${openLink('modules')}</h2>
  <p class="sectionnote">Every area of the web app, the API and the packages, each on the row below everything that imports it, and a box per connector the description file declares. Only the shortest chain of imports is drawn, each arrow labelled with the files that make it. The marks are shown and nothing fails on them.</p>
  <div class="legend">
    <span><i class="ln"></i>Imports an area below</span>
    <span><i class="ln up"></i>An import back up the chain, closing a cycle, with its files; a tie where both halves are the same size</span>
    <span><i class="ln core"></i>Connector code living in the core: move it into the connector${fileCount ? ` (${plural(fileCount, 'file')})` : ''}</span>
    <span><i class="sw d-red"></i>A connector with no package of its own, or whose package is gone${connectors.length ? ` (${connectors.filter((each) => !each.package || each.package.state === 'gone').length} of ${connectors.length})` : ''}</span>
    <span><i class="sw d-red"></i>A connector package importing beyond the SDK${counts.connectorBreaches ? ` (${counts.connectorBreaches})` : ''}</span>
    <span><i class="sw d-amber"></i>Undescribed${counts.undescribed ? ` (${counts.undescribed})` : ''}</span>
    <span><i class="sw d-red"></i>Gone: described, not on disk${counts.gone ? ` (${counts.gone})` : ''}</span>
    <span><i class="sw d-green"></i>Connector package importing only the SDK</span>
    <span><i class="sw d-worker"></i>Released together, in one deploy</span>
  </div>
  <div class="diagram">
    ${opener('modules', renderModules(model))}
  </div>
  </section>

  <section id="deps">
  <h2>Dependencies</h2>
  <p class="sectionnote">Each cell counts the files in the row's area importing the column's area, in dependency-chain order: each area stands above what it imports. The number beside a row is that area's source lines, tests excluded.</p>
  <div class="legend">
    <span><i class="sw d-down"></i>Imports an area below</span>
    <span><i class="sw d-up"></i>Imports an area above, against the order</span>
    <span><i class="sw d-part"></i>The other half of a cycle</span>${mutedAreas.length ? `
    <span><i class="sw d-muted"></i>Muted: everything reads ${mutedAreas.map((each) => `<code>${esc(each.name)}</code>`).join(', ')}</span>` : ''}
  </div>
  <p class="sectionnote">${orderNote(model.dependencies)}</p>
  <div class="diagram">
    ${renderDependencies(model)}
  </div>
  <p class="sectionnote">${cycleSummary(model.dependencies)}</p>
  </section>

  <section id="deployment">
  <h2>Deployment ${openLink('deployment')}</h2>
  <p class="sectionnote">Highlighted workflows deploy; the arrow goes to the environment they deploy. Each environment lists what it binds, under its own names; <em>inherited</em> marks a setting taken from the top of the Worker config.</p>
  <div class="diagram">
    ${opener('deployment', renderDiagram(model))}
  </div>
  </section>

  <footer>
    Generated by <code>tools/architecture</code> from <code>apps/api/wrangler.jsonc</code>, <code>.github/workflows/</code>, the folders of the web app, the API and the packages, and <code>tools/architecture/description.yml</code>.
    The model is published beside this page as <a href="model.json">model.json</a>.
  </footer>

</div>
</body>
</html>
`;
}
