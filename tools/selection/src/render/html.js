/**
 * The renderer: the model in, a single self-contained HTML file out. Imports
 * model.js's `chainText` and nothing else — never github.js, the same split
 * the other three reports keep. Every measurement on the page is the model's;
 * what this adds is layout and the words around it.
 *
 * One file that opens from disk: the styles are inline, there is no script,
 * and the only addresses in it are links a reader follows.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chainText } from '../model.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

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
const day = (iso) => iso.slice(0, 10);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const days = (value) => (Number.isInteger(value) ? String(value) : (Math.round(value * 10) / 10).toString());
const coveredDays = (value) => (value < 0.05 ? 'under 0.1' : days(value));

function windowHeading(window) {
  const name = `${window.days} ${window.days === 1 ? 'day' : 'days'}`;
  return window.partial ? `${name} (only ${coveredDays(window.actualDays)} covered)` : name;
}

const noData = '<span class="fig none">none</span>';
const noDataCell = `<td class="num">${noData}</td>`;

function countOfCell(count, of) {
  if (count === null) return noDataCell;
  return `<td class="num"><span class="fig">${count}</span><span class="of">of ${plural(of, 'pull request')}</span></td>`;
}

function figuresTable(model) {
  const windows = model.windows;
  const row = (label, note, cell) =>
    `<tr><th scope="row">${label}${note ? `<span class="rownote">${note}</span>` : ''}</th>${windows.map((window) => cell(window)).join('')}</tr>`;

  const rows = [
    row('Pull requests merged', '', (window) => (window.pulls === 0 ? noDataCell : `<td class="num"><span class="fig">${window.pulls}</span></td>`)),
    row('Misses', 'a test that failed on main and was not run on the pull request that merged it', (window) =>
      window.misses === null ? noDataCell : `<td class="num"><span class="fig${window.misses === 0 ? ' none' : ''}">${window.misses}</span></td>`,
    ),
    row('Forced to run everything', 'of the pull requests that ran a Test job at all: every package ran in full, so selection saved nothing', (window) =>
      window.forcedFull === null ? noDataCell : countOfCell(window.forcedFull.count, window.forcedFull.of),
    ),
    row('Test files a typical pull request ran', 'the median, over pull requests that used selection at all', (window) =>
      window.typicalFiles === null ? noDataCell : `<td class="num"><span class="fig">${days(window.typicalFiles)}</span></td>`,
    ),
    row('Test job duration', 'pull request vs. main&rsquo;s own run of the merge, both medians', (window) =>
      window.duration.pr === null && window.duration.main === null
        ? noDataCell
        : `<td class="num"><span class="fig">${humanMs(window.duration.pr)}</span><span class="of">main ${humanMs(window.duration.main)}</span></td>`,
    ),
    row('Documentation-only pull requests', 'skipped the Test job entirely', (window) => (window.docsOnly === null ? noDataCell : countOfCell(window.docsOnly.count, window.docsOnly.of))),
  ].join('');

  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th></th>${windows.map((window) => `<th class="num">${esc(windowHeading(window))}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

/**
 * What a reader who took the page's totals for the whole would get wrong,
 * said always and not only when something is unusual.
 */
function limits(model) {
  const { coverage } = model;
  const covered = coveredDays(coverage.actualDays);
  const range = `From ${esc(day(coverage.coveredSince))} to ${esc(day(coverage.until))}.`;

  let period;
  if (coverage.partial) {
    const reason = coverage.truncated ? 'the fetch stopped at its pull request budget before it reached the start of the period' : `${esc(model.branch)} has no history that far back`;
    period = `<li class="warn"><b>This covers ${covered} ${covered === '1' ? 'day' : 'days'}, not ${days(coverage.requestedDays)}</b> &mdash; ${reason}. ${range}</li>`;
  } else {
    period = `<li><b>This covers ${covered} ${covered === '1' ? 'day' : 'days'}.</b> ${range}</li>`;
  }

  const ran = model.pulls.filter((pull) => pull.status === 'ran').length;
  const docsOnly = model.pulls.filter((pull) => pull.status === 'docs-only').length;
  const noRecord = model.pulls.filter((pull) => pull.status === 'no-record').length;

  return `<div class="note"><b>What this does and does not measure</b><ul>
    ${period}
    <li><b>A pull request is read from its own last Test run</b>, and misses are read against <code>main</code>&rsquo;s own run of its merge &mdash; never a second guess at what should have run.</li>
    <li><b>${plural(model.pulls.length, 'merged pull request')} read: ${ran} ran a Test job, ${docsOnly} were documentation only, ${noRecord} carry no record.</b> A pull request with no record is counted in neither direction below: there is no telling what it would have done.</li>
    <li><b>Any GitHub API failure fails the whole run</b>, rather than publishing a page with a pull request quietly missing from it.</li>
  </ul></div>`;
}

function missesSection(model) {
  if (model.misses.length === 0) return '<div class="card"><p class="empty">No misses in this period.</p></div>';
  const rows = model.misses
    .map(
      (miss) => `<tr>
        <td><a href="${esc(miss.pull.url)}" target="_blank" rel="noopener">#${esc(miss.pull.number)}</a> ${esc(miss.pull.title)}</td>
        <td class="path">${esc(miss.path)}</td>
        <td>${esc(miss.level)}</td>
        <td>${miss.reason === 'docs only' ? '<span class="tag docsonly">docs only</span>' : 'not run'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th>Pull request</th><th class="path">Test</th><th>Level</th><th>Reason</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function forcedFullSection(model) {
  if (model.forcedFull.length === 0) return '<div class="card"><p class="empty">Nothing forced a full run in this period.</p></div>';
  const rows = model.forcedFull
    .map(
      (row) => `<tr>
        <td>${esc(row.rule)}</td>
        <td class="path">${row.path ? esc(row.path) : '&mdash;'}</td>
        <td class="num"><span class="fig">${row.count}</span></td>
        <td><details><summary>${plural(row.pulls.length, 'pull request')}</summary><ul class="filelist">${row.pulls
          .map((pull) => `<li><a href="${esc(pull.url)}" target="_blank" rel="noopener">#${esc(pull.number)}</a> ${esc(pull.title)}</li>`)
          .join('')}</ul></details></td>
      </tr>`,
    )
    .join('');
  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th>Rule</th><th class="path">Path</th><th class="num">Pull requests</th><th>Which</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function mostSelectedSection(model) {
  if (model.mostSelected.length === 0) return '<div class="card"><p class="empty">No test file was selected in this period.</p></div>';
  const rows = model.mostSelected
    .map(
      (row) => `<tr>
        <td class="path">${esc(row.path)}</td>
        <td>${esc(row.level)}</td>
        <td class="num"><span class="fig">${row.selectedPulls}</span><span class="of">of ${plural(row.selectingPulls, 'pull request')}</span></td>
        <td class="num">${row.fullRunPulls}</td>
        <td class="path">${row.mostCommonChain ? esc(row.mostCommonChain) : '&mdash;'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th class="path">Test</th><th>Level</th><th class="num">Selected</th><th class="num">Full runs</th><th class="path">Most common chain</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function changedFilesList(files) {
  if (files.length === 0) return '<p class="empty">No changed files recorded.</p>';
  return `<ul class="filelist">${files.map((file) => `<li${file.ignored ? ' class="ignored"' : ''}>${esc(file.path)}${file.ignored ? ' (ignored)' : ''}</li>`).join('')}</ul>`;
}

function packagesTable(packages) {
  if (packages.length === 0) return '';
  const rows = packages
    .map(
      (pkg) => `<tr>
        <td>${esc(pkg.name)}</td>
        <td>${esc(pkg.mode)}</td>
        <td>${pkg.reason ? `${esc(pkg.reason.rule)}${pkg.reason.path ? ` (<span class="path">${esc(pkg.reason.path)}</span>)` : ''}` : '&mdash;'}</td>
        <td>${pkg.report === 'none' ? '<span class="tag norecord">no report</span>' : ''}</td>
      </tr>`,
    )
    .join('');
  return `<table class="pkgtable"><thead><tr><th>Package</th><th>Mode</th><th>Reason</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** `chainText`, but without repeating the file's own path — the list item it decorates already names it. `selectionChain` (scripts/lib/test-record.mjs) always starts a chain at the test file itself, so the first hop is the one to drop. Unescaped, like `chainText`; the caller escapes it. */
function chainSuffix(selectedBy) {
  if (!selectedBy || selectedBy.kind !== 'chain') return chainText(selectedBy);
  const rest = selectedBy.chain.slice(1);
  return rest.length ? `via ${rest.join(' → ')}` : chainText(selectedBy);
}

function testFilesLists(pull) {
  const missPaths = new Set(pull.misses.map((miss) => miss.path));
  const ran = [];
  const notRun = [];
  for (const pkg of pull.packages) {
    for (const file of pkg.files) {
      const entry = { ...file, pkg: pkg.name, mode: pkg.mode };
      if (file.status === 'not run') notRun.push(entry);
      else ran.push(entry);
    }
  }

  const ranItems = ran
    .map(
      (file) => `<li${file.status === 'failed' ? ' class="failed"' : ''}>${esc(file.path)}${file.status === 'failed' ? ' (failed)' : ''}<span class="chain">${file.mode === 'full' ? 'its package ran in full' : esc(chainSuffix(file.selectedBy))}</span></li>`,
    )
    .join('');
  const notRunItems = notRun.map((file) => `<li${missPaths.has(file.path) ? ' class="failed"' : ''}>${esc(file.path)}${missPaths.has(file.path) ? ' (miss: failed on main)' : ''}</li>`).join('');

  return `
    <p class="rownote">${plural(ran.length, 'test file')} run</p>
    <ul class="filelist">${ranItems}</ul>
    <details><summary>${plural(notRun.length, 'test file')} not run</summary><ul class="filelist">${notRunItems || '<li>&mdash;</li>'}</ul></details>
  `;
}

function pullTags(pull) {
  const tags = [];
  if (pull.status === 'docs-only') tags.push('<span class="tag docsonly">docs only</span>');
  if (pull.status === 'no-record') tags.push('<span class="tag norecord">no record</span>');
  if (pull.misses.length > 0) tags.push(`<span class="tag miss">${plural(pull.misses.length, 'miss')}</span>`);
  if (pull.status === 'ran' && pull.ranEverything) tags.push('<span class="tag forced">forced full</span>');
  return tags.join('');
}

function pullRow(pull) {
  const header = `<div class="who"><a href="${esc(pull.url)}" target="_blank" rel="noopener"><b>#${esc(pull.number)}</b> ${esc(pull.title)}</a></div>
    <div class="when">merged ${esc(stamp(pull.mergedAt))} ${pullTags(pull)}</div>`;

  if (pull.status === 'docs-only') return `<div class="pullrow">${header}<p class="summary">Skipped: documentation only.</p></div>`;
  if (pull.status === 'no-record') return `<div class="pullrow">${header}<p class="summary">No record: its Test job&rsquo;s artifact is missing or expired.</p></div>`;

  const packageCount = pull.packages.length;
  return `<div class="pullrow">${header}
    <p class="summary">${plural(packageCount, 'package')} &middot; ${plural(pull.filesRun, 'test file')} run</p>
    <details>
      <summary>Changed files, packages and tests</summary>
      ${changedFilesList(pull.changedFiles)}
      ${packagesTable(pull.packages)}
      ${testFilesLists(pull)}
    </details>
  </div>`;
}

function pullsSection(model) {
  if (model.pulls.length === 0) return '<div class="card"><p class="empty">No merged pull requests in this period.</p></div>';
  return `<div class="card">${model.pulls.map(pullRow).join('')}</div>`;
}

/**
 * @param {object} model the model buildModel produced
 * @param {{ explorerHref?: string, stabilityHref?: string, leadTimeHref?: string }} [options]
 * @returns {string} a complete HTML document
 */
export function renderHtml(model, { explorerHref = '../', stabilityHref = '../stability/', leadTimeHref = '../lead-time/' } = {}) {
  const styles = readFileSync(path.join(here, 'styles.css'), 'utf8');
  const commitUrl = model.commit ? `https://github.com/${model.repo}/commit/${model.commit}` : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cockpit Test Selection</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <p class="eyebrow">Cockpit &middot; ${esc(model.branch)}</p>
    <h1>Is test selection working?</h1>
    <p class="standfirst">
      What CI's Test job selected and why, read across pull requests: whether a skipped test later
      failed on <code>main</code>, which paths keep forcing full runs, and which tests are selected
      on nearly every pull request. Each pull request is read from its own last Test run.
    </p>
    <div class="runmeta">
      <span>generated <b>${esc(stamp(model.generatedAt))}</b></span>
      ${commitUrl ? `<span>commit <a href="${esc(commitUrl)}" target="_blank" rel="noopener"><b>${esc(model.commit.slice(0, 7))}</b></a></span>` : ''}
      <span>pull requests read <b>${model.coverage.pulls}</b></span>
      <span>covering <b>${coveredDays(model.coverage.actualDays)} ${coveredDays(model.coverage.actualDays) === '1' ? 'day' : 'days'}</b></span>
      <span><a href="${esc(explorerHref)}"><b>Test explorer &rarr;</b></a></span>
      <span><a href="${esc(stabilityHref)}"><b>CI stability &rarr;</b></a></span>
      <span><a href="${esc(leadTimeHref)}"><b>Lead time &rarr;</b></a></span>
    </div>
  </header>

  ${limits(model)}

  <h2>Is selection working?</h2>
  <p class="sectionnote">Each carries the counts it was made from, because "none" and a genuine zero are different claims.</p>
  ${figuresTable(model)}

  <h2>Misses</h2>
  <p class="sectionnote">A test that failed on <code>main</code> after its pull request skipped it. What to do: widen the import chain the missing file should have been reached through, or add the edge Vitest's own graph does not see.</p>
  ${missesSection(model)}

  <h2>What forced a full run</h2>
  <p class="sectionnote">Every package ran when one of these paths changed. What to do: move the path under a package's own directory, or narrow the rule that catches it, so a change there stops paying for every package's suite.</p>
  ${forcedFullSection(model)}

  <h2>Tests selected most often</h2>
  <p class="sectionnote">Selected on nearly every pull request that could have picked it. What to do: if the chain beside it is wider than what actually depends on the file, narrowing it is what would shrink this.</p>
  ${mostSelectedSection(model)}

  <h2>Pull requests</h2>
  <p class="sectionnote">Newest first. Open one for its changed files, each package's mode and reason, and which test files ran and why.</p>
  ${pullsSection(model)}

  <footer>
    Generated by <code>tools/selection</code> from the pull request and Actions APIs and each Test job's
    own selection record (<code>scripts/lib/test-record.mjs</code>).
    <a href="${esc(explorerHref)}">Test explorer</a>
  </footer>

</div>
</body>
</html>
`;
}
