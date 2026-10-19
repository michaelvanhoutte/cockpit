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

import { unplacedText } from '../../../../scripts/lib/e2e-record.mjs';
import { chainText } from '../model.js';
import { adviceFor } from './advice.js';

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

const percent = (value) => `${Math.round(value * 100)}%`;

/** `of` as the count a figure was made from, with its share where it has one: "of 145 · 32%". */
function countOfCell(count, of, { withShare = true, verdict = null } = {}) {
  if (count === null) return noDataCell;
  return `<td class="num"><span class="fig${verdict ? ` ${verdict}` : ''}">${count}</span><span class="of">of ${of}${withShare ? ` &middot; ${percent(count / of)}` : ''}</span></td>`;
}

/** A bar's threshold as the Bar column words it. */
function barText(bar) {
  if (bar.id === 'misses') return 'any miss';
  if (bar.id === 'most-selected') return `${percent(bar.threshold)}, over at least ${bar.minOver}`;
  return `${percent(bar.threshold)} of pull requests that ran`;
}

function figuresTable(model) {
  const windows = model.windows;
  const { bars } = model;
  const barOf = (id) => bars.items.find((each) => each.id === id);

  // A figure is coloured only in the window the verdicts are read on; the others show it plain.
  const verdictIn = (window, bar) => (bar && window.days === bars.windowDays ? bar.verdict : null);
  const row = (label, note, bar, cell, barCell = '&mdash;') => {
    const barClass = bar ? bar.verdict : 'nobar';
    const barNote = bar && bar.verdict === 'unread' ? `${barCell} &middot; unread` : barCell;
    return `<tr class="${barClass}"><th scope="row">${label}${note ? `<span class="rownote">${note}</span>` : ''}</th>${windows.map((window) => cell(window, verdictIn(window, bar))).join('')}<td class="bar">${barNote}</td></tr>`;
  };
  const plain = (value, verdict) => `<td class="num"><span class="fig${verdict ? ` ${verdict}` : ''}">${value}</span></td>`;

  const rows = [
    row('Pull requests merged', '', null, (window) => (window.pulls === 0 ? noDataCell : plain(window.pulls)), `at least ${bars.minPulls} before a bar is read`),
    row('Misses', 'a test file or E2E spec that failed on main and was not run on the pull request that merged it', barOf('misses'), (window, verdict) => (window.misses === null ? noDataCell : plain(window.misses, verdict)), barText(barOf('misses'))),
    row('Test forced to run everything', 'of the pull requests that ran a Test job at all: every package ran in full, so selection saved nothing', barOf('test-forced-full'), (window, verdict) =>
      window.forcedFull === null ? noDataCell : countOfCell(window.forcedFull.count, window.forcedFull.of, { verdict }),
    barText(barOf('test-forced-full'))),
    row('E2E forced to run every spec', 'of the pull requests whose E2E job left a record: every spec ran, so selection saved nothing', barOf('e2e-forced-full'), (window, verdict) =>
      window.e2e.forcedFull === null ? noDataCell : countOfCell(window.e2e.forcedFull.count, window.e2e.forcedFull.of, { verdict }),
    barText(barOf('e2e-forced-full'))),
    row('A test selected on nearly every pull request', 'the most-selected test file or spec, over the pull requests that could have skipped it', barOf('most-selected'), (window, verdict) =>
      window.mostSelected === null
        ? noDataCell
        : `<td class="num"><span class="fig${verdict ? ` ${verdict}` : ''}">${percent(window.mostSelected.share)}</span><span class="of">${window.mostSelected.selected} of ${window.mostSelected.of}</span></td>`,
    barText(barOf('most-selected'))),
    row('Test files a typical pull request ran', 'the median, over pull requests that used selection at all', null, (window) => (window.typicalFiles === null ? noDataCell : plain(days(window.typicalFiles)))),
    row('E2E specs a typical pull request ran', 'the median, over pull requests that used selection at all', null, (window) => (window.e2e.typicalSpecs === null ? noDataCell : plain(days(window.e2e.typicalSpecs)))),
    row('Test job duration', 'pull request vs. main&rsquo;s own run of the merge, both medians', null, (window) =>
      window.duration.pr === null && window.duration.main === null
        ? noDataCell
        : `<td class="num"><span class="fig">${humanMs(window.duration.pr)}</span><span class="of">main ${humanMs(window.duration.main)}</span></td>`,
    ),
    row('Documentation-only pull requests', 'skipped the Test job entirely', null, (window) => (window.docsOnly === null ? noDataCell : countOfCell(window.docsOnly.count, window.docsOnly.of, { withShare: false }))),
  ].join('');

  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th></th>${windows.map((window) => `<th class="num">${esc(windowHeading(window))}</th>`).join('')}<th>Bar</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

/** The sentence under a crossed bar's name: the cause where the model names one. */
function crossedLine(bar) {
  const pct = bar.value === null ? '' : percent(bar.value);
  if (bar.id === 'misses') {
    return `<b>${plural(bar.count, 'miss', 'misses')}</b> &mdash; a test that failed on main after its pull request skipped it. Any miss crosses.`;
  }
  if (bar.id === 'most-selected') {
    return `<b>${esc(bar.path)} selected on ${pct} of the ${plural(bar.of, 'pull request')} that could have skipped it</b> &mdash; bar ${percent(bar.threshold)}, over at least ${bar.minOver}.`;
  }
  const head = `<b>${esc(bar.name)} on ${bar.count} of ${plural(bar.of, 'pull request')} (${pct})</b> &mdash; bar ${percent(bar.threshold)}.`;
  if (!bar.cause) return head;
  const wholly = bar.cause.count / bar.count >= 0.9;
  return `${head} ${wholly ? 'One rule does it' : 'Mostly'}${wholly ? ':' : ''} <i>${esc(bar.cause.rule)}</i>, ${bar.cause.count} of ${wholly ? 'those' : 'the'} ${bar.count}.`;
}

/** Why a bar could not be read, for the strip's foot. */
function unreadReason(bar, bars) {
  return bar.unread === 'window'
    ? `the window holds ${plural(bars.pulls, 'merged pull request')}, and a bar needs ${bars.minPulls}`
    : bar.id === 'most-selected'
      ? `no test file or spec had ${bar.minOver} pull requests that could have skipped it`
      : 'the window cannot give the figure';
}

/**
 * The verdict, first thing on the page: each crossed bar with its figure,
 * threshold and leading rule, or a green line when none is crossed. A bar that
 * could not be read is named in the foot — never counted as within.
 */
function verdictStrip(model) {
  const { bars } = model;
  const crossed = bars.items.filter((bar) => bar.verdict === 'crossed');
  const unread = bars.items.filter((bar) => bar.verdict === 'unread');
  const windowName = `${bars.windowDays}-day window`;

  let state = '';
  let heading;
  if (crossed.length > 0) heading = `${crossed.length} ${crossed.length === 1 ? 'bar' : 'bars'} crossed in the ${windowName}`;
  else if (unread.length === bars.items.length) {
    state = ' unread';
    heading = `No bar could be read in the ${windowName}`;
  } else {
    state = ' ok';
    heading = `No bar crossed in the ${windowName}`;
  }

  const foot = [];
  const filed = crossed.filter((bar) => bar.alarmIssue);
  if (filed.length > 0) {
    const links = filed.map((bar) => `<a href="https://github.com/${esc(model.repo)}/issues/${bar.alarmIssue}">#${bar.alarmIssue} ${esc(bar.name)}</a>`);
    foot.push(`Filed as ${links.length > 1 ? `${links.slice(0, -1).join(', ')} and ${links.at(-1)}` : links[0]}. Each is updated nightly while its bar stays crossed, and closed by a person.`);
  }
  if (unread.length > 0) {
    foot.push(`Unread: ${unread.map((bar) => `${esc(bar.name)} (${unreadReason(bar, bars)})`).join('; ')}.`);
  }
  if (bars.partial) foot.push(`The window is only ${coveredDays(bars.actualDays)} of its ${bars.windowDays} days covered.`);

  return `<div class="verdict${state}">
    <h2><span class="dot"></span>${heading}</h2>
    ${crossed.length > 0 ? `<ul>${crossed.map((bar) => `<li>${crossedLine(bar)}</li>`).join('')}</ul>` : ''}
    ${foot.length > 0 ? `<div class="filed">${foot.join(' ')}</div>` : ''}
  </div>`;
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
  const e2eNoRecord = model.pulls.filter((pull) => pull.e2e.status === 'no-record').length;

  return `<div class="note"><b>What this does and does not measure</b><ul>
    ${period}
    <li><b>A pull request is read from its own last Test run</b>, and misses are read against <code>main</code>&rsquo;s own run of its merge &mdash; never a second guess at what should have run.</li>
    <li><b>${plural(model.pulls.length, 'merged pull request')} read: ${ran} ran a Test job, ${docsOnly} were documentation only, ${noRecord} carry no record.</b> A pull request with no record is counted in neither direction below: there is no telling what it would have done.</li>
    <li><b>The E2E job is read the same way, from its own record.</b> ${plural(e2eNoRecord, 'pull request')} carry${e2eNoRecord === 1 ? 's' : ''} none &mdash; merged before E2E recorded anything, or its artifact expired &mdash; and are counted in neither direction for E2E.</li>
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
    <thead><tr><th>Pull request</th><th class="path">Test or spec</th><th>Level</th><th>Reason</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

/** One path a rule caught: the path, how many pull requests it forced, and which. */
function pathRow(path) {
  const which = `<details><summary>${plural(path.pulls.length, 'pull request')}</summary><ul class="filelist">${path.pulls
    .map((pull) => `<li><a href="${esc(pull.url)}" target="_blank" rel="noopener">#${esc(pull.number)}</a> ${esc(pull.title)}</li>`)
    .join('')}</ul></details>`;
  return `<tr class="pathrow"><td class="path">${esc(path.path)}</td><td class="num"><span class="fig">${path.count}</span></td><td>${which}</td></tr>`;
}

/** A row per rule above its paths: every pull request the rule forced counted once, the rule's own advice, and the paths it caught folded below, worst first. */
function ruleRows(rule) {
  const named = rule.paths.filter((path) => path.path !== null);
  const advice = esc(adviceFor(rule.tier, rule.rule));
  const head = `<tr class="rule ${rule.verdict}">
    <td>${rule.tier}</td>
    <td class="rulename">${esc(rule.rule)}<span class="advice">${advice}</span></td>
    <td class="num"><span class="fig">${rule.count}</span><span class="of">of ${rule.of} &middot; ${percent(rule.share)}</span></td>
  </tr>`;
  if (named.length === 0) return head;
  return `${head}<tr><td colspan="3" class="nested"><details class="paths"><summary>${plural(named.length, 'path')}, worst first</summary><table>${named.map(pathRow).join('')}</table></details></td></tr>`;
}

function forcedFullSection(model) {
  if (model.forcedFullRules.length === 0) return '<div class="card"><p class="empty">Nothing forced a full run in this period.</p></div>';
  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th>Job</th><th>Rule</th><th class="num">Pull requests</th></tr></thead>
    <tbody>${model.forcedFullRules.map(ruleRows).join('')}</tbody>
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

/** The E2E half of a pull request's drill-down: the tier's mode and reason, then each spec file with its result and why it ran. */
function e2eDetails(e2e) {
  if (e2e.status === 'docs-only') return '<p class="rownote">E2E skipped: documentation only.</p>';
  if (e2e.status === 'no-record') return '<p class="rownote">E2E: no record.</p>';
  const [tier] = e2e.packages;
  if (!tier || tier.report === 'none') return '<p class="rownote">E2E: the run left no report, so which specs ran is not recorded.</p>';

  const rows = tier.files
    .map((file) => {
      const why = file.status === 'not run' ? '' : tier.mode === 'full' ? 'every spec ran' : chainText(file.selectedBy);
      return `<tr><td class="path">${esc(file.path)}</td><td>${esc(file.status)}</td><td>${esc(why)}</td></tr>`;
    })
    .join('');
  const reason = tier.reason ? ` &middot; ${esc(tier.reason.rule)}${tier.reason.path ? ` (<span class="path">${esc(tier.reason.path)}</span>)` : ''}` : '';
  const unplaced = unplacedText(tier.unplaced ?? []).map((text) => `<p class="rownote">${esc(text)}</p>`).join('');
  return `<p class="rownote">E2E: ${plural(e2e.filesRun, 'spec')} of ${e2e.filesTotal} run &middot; ${esc(tier.mode)}${reason}</p>${unplaced}
    <table class="pkgtable"><thead><tr><th>Spec</th><th>Result</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function e2eSummary(e2e) {
  if (e2e.status === 'ran') return `E2E ${e2e.filesRun} of ${plural(e2e.filesTotal, 'spec')} run`;
  return e2e.status === 'docs-only' ? 'E2E skipped' : 'E2E no record';
}

function pullTags(pull) {
  const tags = [];
  if (pull.status === 'docs-only') tags.push('<span class="tag docsonly">docs only</span>');
  if (pull.status === 'no-record') tags.push('<span class="tag norecord">no record</span>');
  if (pull.misses.length > 0) tags.push(`<span class="tag miss">${plural(pull.misses.length, 'miss')}</span>`);
  if (pull.status === 'ran' && pull.ranEverything) tags.push('<span class="tag forced">forced full</span>');
  if (pull.e2e.status === 'ran' && pull.e2e.ranEverything) tags.push('<span class="tag forced">E2E forced full</span>');
  return tags.join('');
}

function pullRow(pull) {
  const header = `<div class="who"><a href="${esc(pull.url)}" target="_blank" rel="noopener"><b>#${esc(pull.number)}</b> ${esc(pull.title)}</a></div>
    <div class="when">merged ${esc(stamp(pull.mergedAt))} ${pullTags(pull)}</div>`;

  if (pull.status === 'docs-only') return `<div class="pullrow">${header}<p class="summary">Skipped: documentation only.</p></div>`;
  if (pull.status === 'no-record') return `<div class="pullrow">${header}<p class="summary">No record: its Test job&rsquo;s artifact is missing or expired.</p></div>`;

  const packageCount = pull.packages.length;
  return `<div class="pullrow">${header}
    <p class="summary">${plural(packageCount, 'package')} &middot; ${plural(pull.filesRun, 'test file')} run &middot; ${e2eSummary(pull.e2e)}</p>
    <details>
      <summary>Changed files, packages and tests</summary>
      ${changedFilesList(pull.changedFiles)}
      ${packagesTable(pull.packages)}
      ${testFilesLists(pull)}
      ${e2eDetails(pull.e2e)}
    </details>
  </div>`;
}

function pullsSection(model) {
  if (model.pulls.length === 0) return '<div class="card"><p class="empty">No merged pull requests in this period.</p></div>';
  return `<div class="card">${model.pulls.map(pullRow).join('')}</div>`;
}

/**
 * @param {object} model the model buildModel produced
 * @param {{ explorerHref?: string, stabilityHref?: string, cycleTimeHref?: string }} [options]
 * @returns {string} a complete HTML document
 */
export function renderHtml(model, { explorerHref = '../', stabilityHref = '../stability/', cycleTimeHref = '../cycle-time/' } = {}) {
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
      What CI's Test and E2E jobs selected and why, read across pull requests: whether a skipped test later
      failed on <code>main</code>, which paths keep forcing full runs, and which tests are selected
      on nearly every pull request. Each pull request is read from its own last run.
    </p>
    <div class="runmeta">
      <span>generated <b>${esc(stamp(model.generatedAt))}</b></span>
      ${commitUrl ? `<span>commit <a href="${esc(commitUrl)}" target="_blank" rel="noopener"><b>${esc(model.commit.slice(0, 7))}</b></a></span>` : ''}
      <span>pull requests read <b>${model.coverage.pulls}</b></span>
      <span>covering <b>${coveredDays(model.coverage.actualDays)} ${coveredDays(model.coverage.actualDays) === '1' ? 'day' : 'days'}</b></span>
      <span><a href="${esc(explorerHref)}"><b>Test explorer &rarr;</b></a></span>
      <span><a href="${esc(stabilityHref)}"><b>CI stability &rarr;</b></a></span>
      <span><a href="${esc(cycleTimeHref)}"><b>Cycle time &rarr;</b></a></span>
    </div>
  </header>

  ${verdictStrip(model)}

  ${limits(model)}

  <h2>Is selection working?</h2>
  <p class="sectionnote">Each figure carries its bar and the counts it was made from, because "none" and a genuine zero are different claims. A red figure is over its bar in the ${model.bars.windowDays}-day window.</p>
  ${figuresTable(model)}

  <h2>Misses</h2>
  <p class="sectionnote">A test that failed on <code>main</code> after its pull request skipped it. What to do: widen the import chain the missing file should have been reached through, or add the edge Vitest's own graph does not see.</p>
  ${missesSection(model)}

  <h2>What forced a full run</h2>
  <p class="sectionnote">A rule first, with every pull request it forced counted once, then the paths it caught. The bar is read against the rule, because one rule spread over a hundred new files is one cause. The advice is the rule&rsquo;s own.</p>
  ${forcedFullSection(model)}

  <h2>Tests selected most often</h2>
  <p class="sectionnote">Selected on nearly every pull request that could have picked it. What to do: if the chain beside it is wider than what actually depends on the file, narrowing it is what would shrink this.</p>
  ${mostSelectedSection(model)}

  <h2>Pull requests</h2>
  <p class="sectionnote">Newest first. Open one for its changed files, each package's mode and reason, which test files ran and why, and the same for its E2E specs.</p>
  ${pullsSection(model)}

  <footer>
    Generated by <code>tools/selection</code> from the pull request and Actions APIs and each Test job's
    own selection record (<code>scripts/lib/test-record.mjs</code>, and <code>scripts/lib/e2e-record.mjs</code> for E2E).
    <a href="${esc(explorerHref)}">Test explorer</a>
  </footer>

</div>
</body>
</html>
`;
}
