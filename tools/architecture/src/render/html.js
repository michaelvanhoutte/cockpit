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
import { renderDependencies, mutualSummary } from './dependencies.js';
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

/** What the red dot means, with the sources the description file declares and how many cards carry it. */
const sourceMarkLegend = (counts, sources) =>
  `Core area naming ${sources.map((each) => each.name).join(', ') || 'a source'}, or a connector importing beyond the SDK${counts.coreNamingASource + counts.connectorBreaches ? ` (${counts.coreNamingASource + counts.connectorBreaches} areas)` : ''}`;

const day = (iso) => iso.slice(0, 10);

/**
 * @param {ReturnType<import('../model.js').buildModel>} model
 * @param {{ explorerHref?: string, stabilityHref?: string, leadTimeHref?: string, selectionHref?: string, comparison?: object }} [options] `comparison` is what compare.js answered; without one the section says there is nothing to compare
 * @returns {string} a complete HTML document
 */
export function renderHtml(model, { explorerHref = '../', stabilityHref = '../stability/', leadTimeHref = '../lead-time/', selectionHref = '../selection/', comparison = { state: 'unavailable', reason: 'no earlier report was given to compare against' } } = {}) {
  const styles = readFileSync(path.join(here, 'styles.css'), 'utf8');
  const { commit, date, repo } = model.drawnFrom;
  const commitCell = !commit
    ? '<span>commit <b>not known</b></span>'
    : repo
      ? `<span>commit <a href="${esc(`https://github.com/${repo}/commit/${commit}`)}" target="_blank" rel="noopener"><b>${esc(commit.slice(0, 7))}</b></a></span>`
      : `<span>commit <b>${esc(commit.slice(0, 7))}</b></span>`;
  const { environments, workflows } = model.deployment;
  const { counts, sources } = model.modules;
  const mutedAreas = model.dependencies.areas.filter((each) => each.muted);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  <h2>Context</h2>
  <p class="sectionnote">Who uses Cockpit and the outside services it depends on, as <code>tools/architecture/description.yml</code> declares them.</p>
  <div class="diagram">
    ${renderContext(model)}
  </div>
  </section>

  <section id="modules">
  <h2>Modules</h2>
  <p class="sectionnote">Every area of the web app, the API and the packages, as the description file words them. The marks are shown and nothing fails on them.</p>
  <div class="legend">
    <span><i class="sw d-red"></i>${esc(sourceMarkLegend(counts, sources))}</span>
    <span><i class="sw d-amber"></i>Undescribed${counts.undescribed ? ` (${counts.undescribed})` : ''}</span>
    <span><i class="sw d-red"></i>Gone: described, not on disk${counts.gone ? ` (${counts.gone})` : ''}</span>
    <span><i class="sw d-green"></i>Connector package importing only the SDK</span>
  </div>
  <div class="diagram">
    ${renderModules(model)}
  </div>
  </section>

  <section id="deps">
  <h2>Dependencies</h2>
  <p class="sectionnote">Each cell counts the files in the row's area importing the column's area, in the layer order of the description file. The number beside a row is that area's source lines, tests excluded.</p>
  <div class="legend">
    <span><i class="sw d-down"></i>Depends on a layer below</span>
    <span><i class="sw d-up"></i>Depends on a layer above</span>
    <span><i class="sw d-red"></i>Two areas depending on each other</span>${mutedAreas.length ? `
    <span><i class="sw d-muted"></i>Muted: everything reads ${mutedAreas.map((each) => `<code>${esc(each.name)}</code>`).join(', ')}</span>` : ''}
  </div>
  <div class="diagram">
    ${renderDependencies(model)}
  </div>
  <p class="sectionnote">${mutualSummary(model.dependencies)}</p>
  </section>

  <section id="deployment">
  <h2>Deployment</h2>
  <p class="sectionnote">Highlighted workflows deploy; the arrow goes to the environment they deploy. Each environment lists what it binds, under its own names; <em>inherited</em> marks a setting taken from the top of the Worker config.</p>
  <div class="diagram">
    ${renderDiagram(model)}
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
