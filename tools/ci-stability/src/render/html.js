/**
 * The renderer: Model in, a single self-contained HTML file out. Imports
 * model.js and nothing else — never github.js, which is the same split the test
 * explorer keeps between its analyze and render halves.
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

/** A rate, its counts, and the colour that lets a column be scanned rather than read. */
function rateCell(tally) {
  if (!tally) return '<td class="num"><span class="rate none">&mdash;</span></td>';
  if (tally.rate === null) {
    return `<td class="num"><span class="rate none">no data</span><span class="of">0 finished</span></td>`;
  }
  // Floored, not rounded, and 100% reserved for a rate that really is 1: at ten
  // thousand runs, rounding would print "100%" beside the counts 9999/10000.
  // The whole page is rates that never flatter, and this was the one arithmetic
  // path that could.
  const pct = tally.rate === 1 ? 100 : Math.floor(tally.rate * 1000) / 10;
  const band = tally.rate >= 0.99 ? 'good' : tally.rate >= 0.9 ? 'mid' : 'poor';
  return `<td class="num"><span class="rate ${band}">${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%</span><span class="of">${tally.pass}/${tally.completed}</span></td>`;
}

function humanMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Every timestamp on the page is UTC, and says so — the reader is not. */
const stamp = (iso) => `${iso.slice(0, 16).replace('T', ' ')}Z`;

/**
 * What a rate left out, named rather than merely subtracted. One column, from
 * the first window — which is why the header names that window rather than
 * saying "the rate": with two rate columns beside it, an unlabelled count would
 * be read against whichever one the eye was on.
 */
function excludedCell(tally) {
  if (!tally) return '<td class="excluded">&mdash;</td>';
  const parts = [];
  if (tally.cancelled) parts.push(`${tally.cancelled} cancelled`);
  if (tally.running) parts.push(`${tally.running} running`);
  if (tally.skipped) parts.push(`${tally.skipped} skipped`);
  if (tally.other) parts.push(`${tally.other} other`);
  if (tally.unknown) parts.push(`${tally.unknown} unrecognised`);
  return `<td class="excluded">${parts.length ? esc(parts.join(', ')) : '&mdash;'}</td>`;
}

/**
 * The windows arrive as separate pictures of the same thing; a reader wants
 * them side by side. Joined on the name, which is the only identity a workflow
 * or a job has — see model.js on what that costs across a rename.
 */
function mergeWindows(model) {
  const order = [];
  const seen = new Set();
  for (const window of model.windows) {
    for (const workflow of window.workflows) {
      if (seen.has(workflow.name)) continue;
      seen.add(workflow.name);
      order.push(workflow.name);
    }
  }

  return order.map((name) => {
    const perWindow = model.windows.map((window) =>
      window.workflows.find((workflow) => workflow.name === name),
    );
    const jobOrder = [];
    const jobsSeen = new Set();
    for (const workflow of perWindow) {
      for (const job of workflow?.jobs ?? []) {
        if (jobsSeen.has(job.name)) continue;
        jobsSeen.add(job.name);
        jobOrder.push(job.name);
      }
    }

    return {
      name,
      cells: perWindow.map((workflow) => workflow?.tally ?? null),
      jobs: jobOrder.map((jobName) => {
        const jobPerWindow = perWindow.map((workflow) =>
          workflow?.jobs.find((job) => job.name === jobName),
        );
        // Durations come from the widest window that has any, for the bigger
        // sample: how long a job takes changes far more slowly than whether it
        // passes.
        const durations = [...jobPerWindow].reverse().find((job) => job?.durations)?.durations;
        return {
          name: jobName,
          cells: jobPerWindow.map((job) => job?.tally ?? null),
          durations: durations ?? null,
        };
      }),
    };
  });
}

function windowHeading(window) {
  if (!window.partial) return `${window.days} days`;
  const actual = Math.max(1, Math.round(window.actualDays));
  return `${window.days} days (only ${actual} available)`;
}

function coverageNote(model) {
  const { coverage } = model;
  if (!coverage.partial) return '';
  const actual = coverage.actualDays === null ? 0 : Math.round(coverage.actualDays);
  const reason = coverage.truncated
    ? `the fetch stopped at its ${coverage.runs}-run budget before reaching the end of the window`
    : `${model.branch} has no history that far back`;
  return `<div class="note warn"><b>This covers ${actual} days, not ${coverage.requestedDays}</b> &mdash; ${esc(reason)}. Every number below is over what was actually fetched, and a column says so in its own heading.</div>`;
}

function anomaliesNote(model) {
  if (model.anomalies.length === 0) return '';
  return `<div class="note warn"><b>Not counted, because this report does not recognise them</b><ul>${model.anomalies
    .map((anomaly) => `<li>${esc(anomaly.detail)}</li>`)
    .join('')}</ul></div>`;
}

function reliabilityTable(model) {
  const merged = mergeWindows(model);
  if (merged.length === 0) {
    return '<div class="card"><p class="empty">No runs in the window.</p></div>';
  }

  const rows = merged
    .map((workflow) => {
      const workflowRow = `<tr class="workflow"><td>${esc(workflow.name)}</td>${workflow.cells
        .map(rateCell)
        .join('')}<td class="dur"></td><td class="dur"></td>${excludedCell(workflow.cells[0])}</tr>`;

      const jobRows = workflow.jobs
        .map(
          (job) =>
            `<tr><td class="jobname">${esc(job.name)}</td>${job.cells
              .map(rateCell)
              .join('')}<td class="num dur">${humanMs(job.durations?.median ?? null)}</td><td class="num dur">${humanMs(
              job.durations?.p90 ?? null,
            )}</td>${excludedCell(job.cells[0])}</tr>`,
        )
        .join('');

      return workflowRow + jobRows;
    })
    .join('');

  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr>
      <th>Workflow and job</th>
      ${model.windows.map((window) => `<th class="num">${esc(windowHeading(window))}</th>`).join('')}
      <th class="num">Median</th>
      <th class="num">p90</th>
      <th>Left out of ${esc(windowHeading(model.windows[0]))}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function redWindowsSection(model) {
  if (model.redWindows.length === 0) {
    return `<div class="card"><p class="empty">${esc(model.branch)} has not been red in this window.</p></div>`;
  }
  return `<div class="card">${model.redWindows
    .map(
      (window) => `<div class="redwindow${window.ongoing ? ' open' : ''}">
        <span class="len">${window.ongoing ? 'red now, for ' : ''}${esc(humanMs(window.ms))}</span>
        <span class="detail">${esc(window.workflow)} &middot; ${window.commits} commit${
          window.commits === 1 ? '' : 's'
        } &middot; from <a href="${esc(window.fromUrl)}" target="_blank" rel="noopener">${esc(
          stamp(window.from),
        )}</a>${
          window.untilUrl
            ? ` to <a href="${esc(window.untilUrl)}" target="_blank" rel="noopener">${esc(
                stamp(window.until),
              )}</a>`
            : ''
        }</span>
      </div>`,
    )
    .join('')}</div>`;
}

function failuresSection(model) {
  if (model.recentFailures.length === 0) {
    return '<div class="card"><p class="empty">No failures in the window.</p></div>';
  }
  return `<div class="card">${model.recentFailures
    .map(
      (failure) => `<div class="failure">
        <a href="${esc(failure.url)}" target="_blank" rel="noopener">${esc(failure.workflow)}</a>
        <span class="when">&middot; ${esc(stamp(failure.createdAt))}</span>
        <span class="sha">&middot; ${esc(failure.headSha.slice(0, 7))}</span>
        ${
          failure.jobs.length
            ? `<div>${failure.jobs
                .map(
                  (job) =>
                    `<a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(job.name)}</a>${
                      job.failedStep ? ` <span class="step">${esc(job.failedStep)}</span>` : ''
                    }`,
                )
                .join(' &middot; ')}</div>`
            : '<div class="step">no failing job recorded</div>'
        }
      </div>`,
    )
    .join('')}</div>`;
}

/**
 * @param {object} model the model buildModel produced
 * @param {{ explorerHref?: string }} [options] where the test explorer sits relative to this
 *   page. The two are published together, so the default is the directory above.
 * @returns {string} a complete HTML document
 */
export function renderHtml(model, { explorerHref = '../' } = {}) {
  const styles = readFileSync(path.join(here, 'styles.css'), 'utf8');
  const commitUrl = model.commit
    ? `https://github.com/${model.repo}/commit/${model.commit}`
    : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cockpit CI Stability</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <p class="eyebrow">Cockpit &middot; ${esc(model.branch)}</p>
    <h1>How reliable each check on ${esc(model.branch)} is</h1>
    <p class="standfirst">
      Pass rates count only the runs that finished. A cancelled run is not a failed one &mdash;
      <code>cancel-in-progress</code> cancels about a quarter of this branch's jobs, and folding those
      into failures would report the browser tier far worse than it is. Everything left out is still
      counted, in the last column. Worst first, so the row that needs attention is the top one.
    </p>
    <div class="runmeta">
      <span>generated <b>${esc(model.generatedAt.slice(0, 16).replace('T', ' '))}Z</b></span>
      ${
        commitUrl
          ? `<span>commit <a href="${esc(commitUrl)}" target="_blank" rel="noopener"><b>${esc(
              model.commit.slice(0, 7),
            )}</b></a></span>`
          : ''
      }
      <span>runs read <b>${model.coverage.runs}</b></span>
      <span>covering <b>${
        model.coverage.actualDays === null ? '0' : Math.round(model.coverage.actualDays)
      } days</b></span>
      ${
        model.coverage.ignoredRuns
          ? `<span>Dependabot updates ignored <b>${model.coverage.ignoredRuns}</b></span>`
          : ''
      }
      <span><a href="${esc(explorerHref)}"><b>Test explorer &rarr;</b></a></span>
    </div>
  </header>

  ${coverageNote(model)}
  ${anomaliesNote(model)}

  <h2>Reliability</h2>
  <p class="sectionnote">Every percentage carries the counts it was computed from, because a rate over eleven runs and one over four hundred are different claims.</p>
  ${reliabilityTable(model)}

  <h2>How long ${esc(model.branch)} stayed red</h2>
  <p class="sectionnote">
    Over all ${
      model.coverage.actualDays === null ? 0 : Math.round(model.coverage.actualDays)
    } days read, not the windows above. From a failing run to the next passing one; consecutive
    failures are one stretch, and a cancelled run in between neither opens nor closes one.
  </p>
  ${redWindowsSection(model)}

  <h2>Recent failures</h2>
  <p class="sectionnote">The last ${model.recentFailures.length} across the same ${
    model.coverage.actualDays === null ? 0 : Math.round(model.coverage.actualDays)
  } days: the failing job and the step it died on, linked to the run.</p>
  ${failuresSection(model)}

  <footer>
    Generated by <code>tools/ci-stability</code> from the GitHub Actions API. What it deliberately does not
    answer &mdash; which <em>test</em> is unreliable, and any number called flakiness &mdash; and why, is in
    <code>docs/ci-stability-options.md</code>. &middot; <a href="${esc(explorerHref)}">Test explorer</a>
  </footer>

</div>
</body>
</html>
`;
}
