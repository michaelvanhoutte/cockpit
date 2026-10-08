/**
 * The renderer: the model in, a single self-contained HTML file out. Imports
 * nothing from the reading side. One file that opens from disk: the styles
 * are inline, there is no script, and the only addresses in it are links a
 * reader follows.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The cell for a value that may be absent. */
const cell = (value) => (value ? `<code>${esc(value)}</code>` : '<span class="none">-</span>');

function resourceTable(environment) {
  if (environment.resources.length === 0) return '<div class="empty">Binds nothing.</div>';
  const rows = environment.resources
    .map(
      (each) => `<tr>
        <th scope="row">${esc(each.kind)}</th>
        <td>${cell(each.binding)}</td>
        <td>${cell(each.name)}${each.inherited ? '<span class="tag inherited">inherited</span>' : ''}</td>
      </tr>`,
    )
    .join('');
  return `<div class="tablewrap"><table>
    <thead><tr><th>Kind</th><th>Binding</th><th>Name</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function environmentCard(environment) {
  const deployers = environment.deployedBy.length
    ? `deployed by ${environment.deployedBy.map((file) => `<a href="#wf-${esc(file)}"><code>${esc(file)}</code></a>`).join(', ')}`
    : environment.kind === 'local development'
      ? 'run on a developer machine, never deployed'
      : 'no workflow deploys it';
  return `<section class="card env" id="env-${esc(environment.name)}">
    <div class="envhead">
      <h3>${esc(environment.kind === 'environment' ? environment.name : environment.kind)}</h3>
      <span class="worker">${environment.worker ? `Worker <code>${esc(environment.worker)}</code>` : ''}</span>
    </div>
    <p class="deployer">${deployers}</p>
    ${resourceTable(environment)}
  </section>`;
}

function startsText(workflow) {
  return workflow.starts
    .map((start) => `${esc(start.text)}${start.inputs?.length ? ` <span class="of">with ${start.inputs.map((each) => `<code>${esc(each)}</code>`).join(', ')}</span>` : ''}`)
    .join('<br>');
}

function deploysText(workflow) {
  if (workflow.deploys.length === 0) return '<span class="none">nothing</span>';
  return workflow.deploys
    .map(
      (each) =>
        `<a class="pill" href="#env-${esc(each.environment)}">&rarr; ${esc(each.environment)}</a>${each.declared ? '' : '<span class="tag warn">not in the Worker config</span>'}`,
    )
    .join(' ');
}

function workflowTable(model) {
  const rows = model.deployment.workflows
    .map(
      (workflow) => `<tr id="wf-${esc(workflow.file)}">
        <th scope="row">${esc(workflow.name)}<span class="rownote"><code>${esc(workflow.file)}</code></span></th>
        <td>${startsText(workflow)}</td>
        <td>${deploysText(workflow)}</td>
      </tr>`,
    )
    .join('');
  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th>Workflow</th><th>Started</th><th>Deploys</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

const day = (iso) => iso.slice(0, 10);

/**
 * @param {ReturnType<import('../model.js').buildModel>} model
 * @param {{ explorerHref?: string, stabilityHref?: string, leadTimeHref?: string, selectionHref?: string }} [options]
 * @returns {string} a complete HTML document
 */
export function renderHtml(model, { explorerHref = '../', stabilityHref = '../stability/', leadTimeHref = '../lead-time/', selectionHref = '../selection/' } = {}) {
  const styles = readFileSync(path.join(here, 'styles.css'), 'utf8');
  const { commit, date, repo } = model.drawnFrom;
  const commitCell = !commit
    ? '<span>commit <b>not known</b></span>'
    : repo
      ? `<span>commit <a href="${esc(`https://github.com/${repo}/commit/${commit}`)}" target="_blank" rel="noopener"><b>${esc(commit.slice(0, 7))}</b></a></span>`
      : `<span>commit <b>${esc(commit.slice(0, 7))}</b></span>`;
  const { environments, workflows } = model.deployment;

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
    <h1>Deployment</h1>
    <p class="standfirst">
      Where Cockpit runs: each environment the Worker config declares with every resource it binds, and each
      workflow with what starts it and which environment it deploys. Drawn from the repository alone.
    </p>
    <div class="runmeta">
      ${commitCell}
      <span>commit dated <b>${date ? esc(day(date)) : 'not known'}</b></span>
      <span>${plural(environments.length, 'environment')}</span>
      <span>${plural(workflows.length, 'workflow')}</span>
      <span><a href="${esc(explorerHref)}"><b>Test explorer &rarr;</b></a></span>
      <span><a href="${esc(stabilityHref)}"><b>CI stability &rarr;</b></a></span>
      <span><a href="${esc(leadTimeHref)}"><b>Lead time &rarr;</b></a></span>
      <span><a href="${esc(selectionHref)}"><b>Selection &rarr;</b></a></span>
    </div>
  </header>

  <h2>Environments</h2>
  <p class="sectionnote">Production is the top level of the Worker config. A binding an environment does not declare is one it does not have; settings such as the cron are inherited from the top level and marked so.</p>
  <div class="envs">${environments.map(environmentCard).join('')}</div>

  <h2>Workflows</h2>
  <p class="sectionnote">Every file in <code>.github/workflows/</code>, with what starts it and the environment it deploys, if any.</p>
  ${workflowTable(model)}

  <footer>
    Generated by <code>tools/architecture</code> from <code>apps/api/wrangler.jsonc</code> and <code>.github/workflows/</code>.
    The model is published beside this page as <a href="model.json">model.json</a>.
  </footer>

</div>
</body>
</html>
`;
}
