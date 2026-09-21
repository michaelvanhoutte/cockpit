/**
 * The renderer: the model in, a single self-contained HTML file out. Imports
 * model.js, strips.js and scatter.js and nothing else — never github.js, the same split the
 * stability report and the test explorer keep — and draws what it is handed:
 * every measurement on the page is the model's. What it adds is layout, and the
 * sums of columns it is showing.
 *
 * One file that opens from disk: the styles are inline, there is no script, and
 * the only addresses in it are links a reader follows (a pull request, a commit)
 * and never something the page fetches.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AWAY_MS, CHECK_KINDS, LONG_ROUND_MS, REVIEW_CHECKS, kindOf } from '../model.js';
import { layoutScatter, radiusFor } from './scatter.js';
import { fitTo, partsOf, scaleFor } from './strips.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const KINDS = CHECK_KINDS;
const KIND_LABEL = { checks: 'Tests and checks', 'code-review': 'Code review', 'security-review': 'Security review' };

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

/** Days covered, said as "under 0.1" rather than as the zero that would read as a measurement of nothing. */
const coveredDays = (value) => (value < 0.05 ? 'under 0.1' : days(value));
const coveredPhrase = (value) => `${coveredDays(value)} ${value === 1 ? 'day' : 'days'}`;

function windowHeading(window) {
  const name = `${window.days} ${window.days === 1 ? 'day' : 'days'}`;
  return window.partial ? `${name} (only ${coveredDays(window.actualDays)} covered)` : name;
}

/** "No data" is a claim about the window, and is never drawn as the zero a count would be. */
const noData = '<span class="fig none">no data</span>';
const noDataCell = `<td class="num">${noData}</td>`;

/** A figure's median and p90 beside what it was made from. */
function durationCell(figure, unit = 'round') {
  if (!figure) return noDataCell;
  // A figure with one item per pull request has a second count that would only repeat the first.
  const counts = unit === 'pull request' ? plural(figure.pulls, unit) : `${plural(figure.count, unit)}, ${plural(figure.pulls, 'pull request')}`;
  return `<td class="num"><span class="fig">${humanMs(figure.median)}</span><span class="of">p90 ${humanMs(figure.p90)} &middot; ${counts}</span></td>`;
}

/** Rounds to merge are a count, so a median of them is not a duration. */
function roundsCell(perPull) {
  if (!perPull) return noDataCell;
  const number = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return `<td class="num"><span class="fig">${number(perPull.median)}</span><span class="of">p90 ${number(perPull.p90)} &middot; ${plural(perPull.pulls, 'pull request')}</span></td>`;
}

function countCell(count, of, unit) {
  // A count of nothing out of nothing is not a zero, it is no rounds to count.
  if (of === 0) return noDataCell;
  return `<td class="num"><span class="fig">${count}</span><span class="of">of ${plural(of, unit)}</span></td>`;
}

function figuresTable(model) {
  const windows = model.windows;
  const row = (label, note, cell) =>
    `<tr><th scope="row">${label}${note ? `<span class="rownote">${note}</span>` : ''}</th>${windows.map((window) => cell(window)).join('')}</tr>`;

  const rows = [
    row('Pull requests merged', 'with a session record: coding and local review are only over these', (window) =>
      window.pulls.total === 0
        ? noDataCell
        : `<td class="num"><span class="fig">${window.pulls.total}</span><span class="of">${window.pulls.withRecord} with a record</span></td>`,
    ),
    row('Start to merge', 'from the session&rsquo;s start where recorded, else the first commit', (window) => durationCell(window.parts.total, 'pull request')),
    row('Rounds to merge', 'a round is a push and the checks that ran on it', (window) => roundsCell(window.rounds?.perPull ?? null)),
    row('Wait per round', 'a push to the last check finishing', (window) => durationCell(window.parts.round)),
    row(`Rounds past ${LONG_ROUND_MS / 60_000} minutes`, 'a round longer than that', (window) =>
      window.rounds ? countCell(window.rounds.overTenMinutes, window.rounds.count, 'round') : noDataCell,
    ),
    row('Red rounds', 'a check ended failed on that push', (window) =>
      window.rounds ? countCell(window.rounds.red, window.rounds.count, 'round') : noDataCell,
    ),
    row('Flukes', 'a failure re-run to a pass on the same commit', (window) =>
      window.flukes
        ? `<td class="num"><span class="fig">${window.flukes.count}</span><span class="of">in ${plural(window.flukes.pulls, 'pull request')} &middot; cost ${humanMs(window.flukes.ms)}</span></td>`
        : noDataCell,
    ),
    row('Before the first push', 'coding: only where the pull request has a record', (window) => durationCell(window.parts.beforeFirstPush, 'pull request')),
    row('Fixing between rounds', 'from a round finishing to the next push', (window) => durationCell(window.parts.fixing, 'gap')),
    row('Waiting to merge', 'the last round finishing to the merge', (window) => durationCell(window.parts.waitingToMerge, 'pull request')),
    row('Local review', 'before the first push; only where the pull request has a record', (window) => durationCell(window.localReviews.ms, 'pull request')),
  ].join('');

  return `<div class="card"><div class="tablewrap"><table>
    <thead><tr><th></th>${windows.map((window) => `<th class="num">${esc(windowHeading(window))}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function harnessCards(model) {
  return `<div class="cards">${model.windows
    .map((window) => {
      const heading = `<h3>${esc(windowHeading(window))}</h3>`;
      if (!window.harness) return `<div class="card pad">${heading}<p class="empty">${noData}</p></div>`;

      const totalMs = KINDS.reduce((total, kind) => total + window.harness.kinds[kind].ms, 0);
      const rows = KINDS.map((kind) => {
        const each = window.harness.kinds[kind];
        const share = totalMs > 0 ? (each.ms / totalMs) * 100 : 0;
        return `<tr>
          <th scope="row"><span class="swatch ${kind}"></span>${KIND_LABEL[kind]}</th>
          <td class="num"><span class="fig">${humanMs(each.ms)}</span><span class="bar"><span class="fill ${kind}" style="width:${share.toFixed(1)}%"></span></span></td>
          <td class="num">${each.runs}</td>
          <td class="num">${each.last} <span class="of">of ${plural(window.harness.rounds, 'round')}</span></td>
        </tr>`;
      }).join('');

      return `<div class="card pad">${heading}<div class="tablewrap"><table>
        <thead><tr><th></th><th class="num">Held rounds for</th><th class="num">Runs</th><th class="num">Last to finish</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>`;
    })
    .join('')}</div>`;
}

/**
 * What a reader who took the page's totals for the whole would get wrong, each said
 * in its own sentence and always — a page that only warned when something was
 * unusual would read as complete on the days nothing was.
 */
function limits(model) {
  const { coverage } = model;
  const covered = coveredPhrase(coverage.actualDays);
  const range = `From ${esc(day(coverage.coveredSince))} to ${esc(day(coverage.until))}.`;

  let period;
  if (coverage.partial) {
    const reason = coverage.truncated
      ? 'the fetch stopped at its pull request budget before it reached the start of the period'
      : `${esc(model.branch)} has no history that far back`;
    period = `<li class="warn"><b>This covers ${covered}, not ${days(coverage.requestedDays)}</b> &mdash; ${reason}. ${range} Every figure below is over what was fetched, and a column says so in its own heading.</li>`;
  } else {
    period = `<li><b>This covers ${covered}.</b> ${range}</li>`;
  }

  const recorded = model.pulls.filter((pull) => pull.recorded).length;
  const records =
    model.pulls.length === 0
      ? '<li><b>No merged pull requests</b> in this period, so there is nothing to draw.</li>'
      : `<li><b>${recorded} of ${plural(model.pulls.length, 'merged pull request')} carry a session record.</b> Coding before the first push and local-review time exist only for those; for the rest the strip says <em>not recorded</em> and never draws them as nothing.</li>`;

  const unreadable = coverage.failed.length
    ? `<li class="warn"><b>${plural(coverage.failed.length, 'pull request')} could not be read</b> and ${coverage.failed.length === 1 ? 'is' : 'are'} left out: ${coverage.failed.map((each) => `#${esc(each.number)}`).join(', ')}.</li>`
    : '';

  return `<div class="note"><b>What this does and does not measure</b><ul>
    ${period}
    <li><b>Time before the session&rsquo;s start is not measured.</b> A strip begins at the session&rsquo;s start where the pull request carries a session record, and at its first commit where it does not; deciding what to build, and any earlier attempt, are in neither.</li>
    <li><b>Only merged pull requests count.</b> One closed without merging, or still open, is in no figure and no strip.</li>
    ${records}
    ${unreadable}
  </ul></div>`;
}

/** What a round says about itself, in words, for the title on its segment and the list under its strip. */
function roundText(round, index) {
  const parts = [`Round ${index}`, humanMs(round.ms), `pushed ${stamp(round.pushedAt)}`];
  if (round.last) parts.push(`held by ${round.last}`);
  if (round.red) parts.push(`RED: ${round.failed.join(', ')} failed`);
  if (round.flukes.length) parts.push(`FLUKE: ${round.flukes.map((fluke) => `${fluke.name} failed and passed on re-run, +${humanMs(fluke.ms)}`).join('; ')}`);
  if (round.unrecognised.length) parts.push(`unrecognised: ${round.unrecognised.map((each) => `${each.name} (${each.conclusion})`).join(', ')}`);
  return parts.join(' · ');
}

const PART_TITLE = {
  coding: (part, pull) =>
    pull.recorded ? `Coding before the first push · ${humanMs(part.ms)}` : `From the first commit to the first push · ${humanMs(part.ms)} · no session record, so any coding before the first commit is not recorded`,
  fixing: (part) => `Fixing before the next push · ${humanMs(part.ms)}`,
  wait: (part) => `Waiting to merge · ${humanMs(part.ms)}`,
  away: (part) => `Away for ${humanMs(part.ms)} · a gap of over ${humanMs(AWAY_MS)} is drawn off the time scale`,
};

function segment(part, pull) {
  if (part.type === 'away') return `<span class="seg away" title="${esc(PART_TITLE.away(part))}"><span class="sr">away ${esc(humanMs(part.ms))}</span></span>`;

  const grow = `flex:${Math.max(1, Math.round(part.ms / 1000))} 1 0`;
  if (part.type === 'round') {
    const held = kindOf(part.round.last ?? '');
    const marks =
      (part.round.red ? '<i class="mark red" aria-hidden="true">✕</i>' : '') + (part.round.flukes.length ? '<i class="mark fluke" aria-hidden="true">↻</i>' : '');
    return `<span class="seg round ${held}${part.round.red ? ' red' : ''}${part.cut ? ' cut' : ''}" style="${grow}" title="${esc(roundText(part.round, part.index))}">${marks}</span>`;
  }

  const unrecorded = part.type === 'coding' && !pull.recorded ? ' unrecorded' : '';
  return `<span class="seg ${part.type}${unrecorded}${part.cut ? ' cut' : ''}" style="${grow}" title="${esc(PART_TITLE[part.type](part, pull))}"></span>`;
}

function strip(pull, fitted, scaleMs) {
  if (pull.rounds.length === 0) return '<div class="track"><span class="trackempty">no check ran on it</span></div>';
  const filler = fitted.shownMs < scaleMs ? `<span class="fill-space" style="flex:${Math.round((scaleMs - fitted.shownMs) / 1000)} 1 0"></span>` : '';
  const cap = fitted.clipped ? '<span class="clipmark" aria-hidden="true">&#9656;</span>' : '';
  return `<div class="track">${fitted.parts.map((part) => segment(part, pull)).join('')}${filler}${cap}</div>`;
}

function stripRow(pull, parts, scaleMs) {
  const fitted = fitTo(parts, scaleMs);
  const reds = pull.rounds.filter((round) => round.red).length;
  const flukes = pull.flukes.length;
  const tags = [
    pull.recorded
      ? ''
      : '<span class="tag unrecorded" title="No session record on this pull request, so its coding and local review are not measured and its strip starts at the first commit">not recorded</span>',
    reds ? `<span class="tag red">${reds} red</span>` : '',
    flukes ? `<span class="tag fluke">${plural(flukes, 'fluke')}</span>` : '',
    fitted.clipped ? `<span class="tag clip">clipped</span>` : '',
  ].join('');

  const clipNote = fitted.clipped
    ? `<p class="clipnote">Clipped: ${humanMs(fitted.clipped.totalMs)} on the scale in all (time away is not counted), the first ${humanMs(fitted.clipped.shownMs)} shown. The strip ends at the edge of the scale, not at the merge.</p>`
    : '';
  const detail = pull.rounds.length
    ? `<details><summary>${plural(pull.rounds.length, 'round')}${reds ? `, ${reds} red` : ''} &middot; ${humanMs(pull.totalMs)} to merge</summary><ol class="roundlist">${pull.rounds
        .map((round, position) => `<li>${esc(roundText(round, position + 1))}</li>`)
        .join('')}</ol>${pull.notes.length ? `<p class="clipnote">${esc(pull.notes.join(' '))}</p>` : ''}</details>`
    : '';

  return `<div class="pullrow">
    <div class="who">
      <a href="${esc(pull.url)}" target="_blank" rel="noopener"><b>#${esc(pull.number)}</b> ${esc(pull.title)}</a>
      <div class="when">merged ${esc(stamp(pull.mergedAt))} ${tags}</div>
    </div>
    <div class="strip">${strip(pull, fitted, scaleMs)}<span class="sr">${esc(humanMs(pull.totalMs))} to merge, ${plural(pull.rounds.length, 'round')}</span>${clipNote}${detail}</div>
  </div>`;
}

function legend() {
  const item = (cls, text) => `<span class="key"><span class="swatch ${cls}"></span>${text}</span>`;
  return `<div class="legend">
    ${item('coding', 'coding before the first push')}
    ${item('checks', 'a round held by tests and checks')}
    ${item('code-review', 'held by code review')}
    ${item('security-review', 'held by security review')}
    ${item('fixing', 'fixing between rounds')}
    ${item('wait', 'waiting to merge')}
    ${item('away', `away (over ${humanMs(AWAY_MS)}, off the scale)`)}
    <span class="key"><i class="mark red" aria-hidden="true">✕</i>red round</span>
    <span class="key"><i class="mark fluke" aria-hidden="true">↻</i>fluke: failed, passed on re-run</span>
    ${item('unrecorded', 'not recorded: no session record, so its strip starts at the first commit')}
  </div>`;
}

function strips(model) {
  if (model.pulls.length === 0) return '<div class="card"><p class="empty">No merged pull requests in this period.</p></div>';
  const allParts = model.pulls.map(partsOf);
  const scaleMs = scaleFor(allParts);
  const scaleNote = `<p class="sectionnote">Every strip is on one scale, up to ${humanMs(scaleMs)}. Time away is not on it. Hover a part for what it was; open a row for its rounds in words.</p>`;
  return `${scaleNote}${legend()}<div class="card">${model.pulls.map((pull, index) => stripRow(pull, allParts[index], scaleMs)).join('')}</div>`;
}

/** A ratio to the precision it can be read at: two places below one, one below ten. */
const ratioText = (value) => `${value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : Math.round(value)}×`;

/** Axis ticks are whole minutes, and the axis title says so. */
const minuteTick = (ms) => String(Math.round(ms / 60_000));

/** What a dot says when it is hovered or focused: the pull request, then its figures. */
function dotTitle(dot) {
  const parts = [
    `#${dot.number} ${dot.title}`,
    `coding and fixing ${humanMs(dot.codingMs)}`,
    `in the harness ${humanMs(dot.harnessMs)}`,
    dot.ratio === null ? 'no coding time, so no ratio' : `ratio ${ratioText(dot.ratio)}`,
    plural(dot.rounds, 'round'),
  ];
  if (dot.off) parts.push('beyond the scale, so drawn on its edge');
  return parts.join(' · ');
}

const PLOT = { left: 48, top: 16, size: 380 };
const VIEW = { width: PLOT.left + PLOT.size + 24, height: PLOT.top + PLOT.size + 44 };

function scatterSvg(layout) {
  const px = (fraction) => (PLOT.left + fraction * PLOT.size).toFixed(1);
  const py = (fraction) => (PLOT.top + (1 - fraction) * PLOT.size).toFixed(1);

  const grid = layout.ticks
    .map((ms) => {
      const fraction = ms / layout.scaleMs;
      return `<line class="grid" x1="${px(fraction)}" y1="${py(0)}" x2="${px(fraction)}" y2="${py(1)}"/><line class="grid" x1="${px(0)}" y1="${py(fraction)}" x2="${px(1)}" y2="${py(fraction)}"/>
      <text class="tick" x="${px(fraction)}" y="${PLOT.top + PLOT.size + 16}" text-anchor="middle">${minuteTick(ms)}</text><text class="tick" x="${PLOT.left - 8}" y="${(Number(py(fraction)) + 4).toFixed(1)}" text-anchor="end">${minuteTick(ms)}</text>`;
    })
    .join('');

  const median = layout.median
    ? `<line class="medianline" x1="${px(0)}" y1="${py(0)}" x2="${px(layout.median.x)}" y2="${py(layout.median.y)}"/>`
    : '';

  const dots = layout.dots
    .map((dot) => {
      const r = radiusFor(dot.rounds);
      const cx = px(dot.x);
      const cy = py(dot.y);
      const nearRight = dot.x > 0.85;
      const label = dot.labelled
        ? `<text class="dotlabel" x="${(Number(cx) + (nearRight ? -(r + 4) : r + 4)).toFixed(1)}" y="${(Number(cy) + 4).toFixed(1)}" text-anchor="${nearRight ? 'end' : 'start'}">#${esc(dot.number)}</text>`
        : '';
      // The link is the hit target: a pointer only has to be near, and a keyboard reaches it.
      return `<a href="${esc(dot.url)}" target="_blank" rel="noopener"><title>${esc(dotTitle(dot))}</title><circle class="hit" cx="${cx}" cy="${cy}" r="${Math.max(12, r + 6)}"/><circle class="dot${dot.off ? ' off' : ''}" cx="${cx}" cy="${cy}" r="${r}"/>${label}</a>`;
    })
    .join('');

  return `<svg class="scatter" viewBox="0 0 ${VIEW.width} ${VIEW.height}" role="img" aria-label="Scatter of minutes coding and fixing against minutes in the harness, one dot per pull request. The same figures are in the table below it.">
    ${grid}
    <line class="axis" x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(0)}"/><line class="axis" x1="${px(0)}" y1="${py(0)}" x2="${px(0)}" y2="${py(1)}"/>
    <line class="equalline" x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}"/>
    ${median}
    ${dots}
    <text class="axistitle" x="${px(0.5)}" y="${VIEW.height - 6}" text-anchor="middle">Minutes coding and fixing</text>
    <text class="axistitle" transform="translate(12 ${py(0.5)}) rotate(-90)" text-anchor="middle">Minutes in the harness</text>
  </svg>`;
}

/**
 * Coding against the harness, over the widest window. Each dot is a pull request with
 * a session record, so one without is left out and counted rather than drawn at a
 * guess, and a window with no dot is no data rather than an empty chart.
 */
function balance(model) {
  const window = model.windows.reduce((widest, each) => (!widest || each.days > widest.days ? each : widest), null);
  if (!window) return '';

  const { dots, ratio, noChecks } = window.balance;
  const heading = `<h3>${esc(windowHeading(window))}</h3>`;
  const leftOut = [
    window.pulls.withoutRecord === 0
      ? window.pulls.total === 0
        ? ''
        : 'Every merged pull request in this window carries a session record.'
      : `${plural(window.pulls.withoutRecord, 'merged pull request')} in this window ${window.pulls.withoutRecord === 1 ? 'carries' : 'carry'} no session record and ${window.pulls.withoutRecord === 1 ? 'is' : 'are'} not on the chart.`,
    noChecks ? `${plural(noChecks, 'pull request')} with a record had no check run on ${noChecks === 1 ? 'it' : 'them'}, so ${noChecks === 1 ? 'has' : 'have'} no harness time to place.` : '',
  ]
    .filter(Boolean)
    .map((sentence) => `<p class="clipnote">${sentence}</p>`)
    .join('');

  if (dots.length === 0) return `<div class="card pad">${heading}<p class="empty">${noData}</p>${leftOut}</div>`;

  const layout = layoutScatter(dots, ratio?.median ?? null);
  const off = layout.dots.filter((dot) => dot.off).length;
  const medianNote = ratio
    ? `<p class="fact"><b>Median ratio ${ratioText(ratio.median)}</b> over ${plural(ratio.pulls, 'pull request')}${
        ratio.pulls === 1 ? ': that one pull request&rsquo;s own ratio, so it says nothing about the rest' : ''
      }.</p>`
    : '<p class="fact"><b>No median ratio:</b> no pull request here has any coding time to divide by.</p>';

  const legend = `<div class="legend stacked">
    <span class="key"><svg class="keyline" viewBox="0 0 24 8" aria-hidden="true"><line class="equalline" x1="0" y1="4" x2="24" y2="4"/></svg>the harness took as long as the coding</span>
    <span class="key"><svg class="keyline" viewBox="0 0 24 8" aria-hidden="true"><line class="medianline" x1="0" y1="4" x2="24" y2="4"/></svg>this window&rsquo;s median ratio</span>
    <span class="key"><svg class="keyline" viewBox="0 0 34 14" aria-hidden="true"><circle class="dot" cx="7" cy="7" r="${radiusFor(1)}"/><circle class="dot" cx="24" cy="7" r="${radiusFor(5)}"/></svg>dot size: 1 round, and 5</span>
    <span class="key"><svg class="keyline" viewBox="0 0 14 14" aria-hidden="true"><circle class="dot off" cx="7" cy="7" r="5"/></svg>hollow on the edge: off the chart</span>
  </div>`;

  const rows = layout.dots
    .map(
      (dot) => `<tr>
        <td class="pr"><a href="${esc(dot.url)}" target="_blank" rel="noopener">#${esc(dot.number)}</a> <span class="title">${esc(dot.title)}</span></td>
        <td class="num dur">${humanMs(dot.codingMs)}</td>
        <td class="num dur">${humanMs(dot.harnessMs)}</td>
        <td class="num dur">${dot.ratio === null ? '&mdash;' : ratioText(dot.ratio)}</td>
        <td class="num">${dot.rounds}</td>
        <td>${dot.off ? '<span class="tag">off the chart</span>' : ''}</td>
      </tr>`,
    )
    .join('');

  return `<div class="card pad">${heading}
    <div class="balance">
      <div class="chart">${scatterSvg(layout)}</div>
      <div class="chartside">
        ${legend}
        ${medianNote}
        <p class="clipnote">Scale to ${humanMs(layout.scaleMs)} on both axes${off ? `; ${plural(off, 'dot')} beyond it, drawn hollow on the edge` : ''}. The three furthest above the dashed line are named. Hover or focus a dot for its figures; it opens the pull request.</p>
        ${leftOut}
      </div>
    </div>
    <details><summary>The figures behind the dots</summary><div class="tablewrap"><table>
      <thead><tr><th>Pull request</th><th class="num">Coding and fixing</th><th class="num">In the harness</th><th class="num">Ratio</th><th class="num">Rounds</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></details>
  </div>`;
}

const reviewCells = (pull, kind) => {
  const review = pull.reviews[kind];
  return review.runs === 0
    ? '<td class="num dur">&mdash;</td><td class="num dur">&mdash;</td><td class="num dur">&mdash;</td>'
    : `<td class="num">${review.runs}</td><td class="num dur">${humanMs(review.ms)}</td><td class="num dur">${humanMs(review.heldMs)}</td>`;
};

const localReviewCell = (pull) => {
  if (!pull.recorded) return '<td class="num dur"><span class="tag unrecorded">not recorded</span></td>';
  if (!pull.localReviews) return '<td class="num dur">none marked</td>';
  return `<td class="num dur">${plural(pull.localReviews.count, 'review')}, ${humanMs(pull.localReviews.ms)}</td>`;
};

function numbersTable(model) {
  if (model.pulls.length === 0) return '<div class="card"><p class="empty">No merged pull requests in this period.</p></div>';

  const sum = (pick) => model.pulls.reduce((total, pull) => total + pick(pull), 0);
  const reviewTotal = (kind) => `<td class="num">${sum((pull) => pull.reviews[kind].runs)}</td><td class="num dur">${humanMs(sum((pull) => pull.reviews[kind].ms))}</td><td class="num dur">${humanMs(sum((pull) => pull.reviews[kind].heldMs))}</td>`;

  const body = model.pulls
    .map(
      (pull) => `<tr>
        <td class="pr"><a href="${esc(pull.url)}" target="_blank" rel="noopener">#${esc(pull.number)}</a> <span class="title">${esc(pull.title)}</span></td>
        <td class="num"><span class="add">+${pull.size.additions}</span> <span class="del">&minus;${pull.size.deletions}</span></td>
        <td class="num">${pull.rounds.length}</td>
        <td class="num">${pull.rounds.filter((round) => round.red).length}</td>
        ${Object.keys(REVIEW_CHECKS)
          .map((kind) => reviewCells(pull, kind))
          .join('')}
        ${localReviewCell(pull)}
      </tr>`,
    )
    .join('');

  return `<div class="card"><div class="tablewrap"><table class="numbers">
    <thead>
      <tr class="group"><th></th><th></th><th></th><th></th><th colspan="3" class="num">Code review</th><th colspan="3" class="num">Security review</th><th></th></tr>
      <tr><th>Pull request</th><th class="num">Lines</th><th class="num">Rounds</th><th class="num">Red</th>
        <th class="num">Runs</th><th class="num">Total time</th><th class="num">Held anyone up</th>
        <th class="num">Runs</th><th class="num">Total time</th><th class="num">Held anyone up</th>
        <th class="num">Local review</th></tr>
    </thead>
    <tbody>${body}</tbody>
    <tfoot><tr>
      <td>${plural(model.pulls.length, 'pull request')}</td>
      <td class="num"><span class="add">+${sum((pull) => pull.size.additions)}</span> <span class="del">&minus;${sum((pull) => pull.size.deletions)}</span></td>
      <td class="num">${sum((pull) => pull.rounds.length)}</td>
      <td class="num">${sum((pull) => pull.rounds.filter((round) => round.red).length)}</td>
      ${reviewTotal('code-review')}${reviewTotal('security-review')}
      <td></td>
    </tr></tfoot>
  </table></div></div>`;
}

/**
 * @param {object} model the model buildModel produced
 * @returns {string} a complete HTML document
 */
export function renderHtml(model) {
  const styles = readFileSync(path.join(here, 'styles.css'), 'utf8');
  const commitUrl = model.commit ? `https://github.com/${model.repo}/commit/${model.commit}` : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Cockpit Lead Time</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <p class="eyebrow">Cockpit &middot; ${esc(model.branch)}</p>
    <h1>Where a change spends its time</h1>
    <p class="standfirst">
      How long each merged pull request was written against how long it waited on the harness,
      how many rounds it took, and which check held each one. Read the box below before the
      totals: it says what they leave out.
    </p>
    <div class="runmeta">
      <span>generated <b>${esc(stamp(model.generatedAt))}</b></span>
      ${commitUrl ? `<span>commit <a href="${esc(commitUrl)}" target="_blank" rel="noopener"><b>${esc(model.commit.slice(0, 7))}</b></a></span>` : ''}
      <span>merged pull requests read <b>${model.coverage.pulls}</b></span>
      <span>covering <b>${coveredPhrase(model.coverage.actualDays)}</b></span>
      <!-- The other two pages of the published site, assembled by ci.yml's
           Publish job; they resolve there and nowhere else. -->
      <span><a href="../"><b>Test explorer &rarr;</b></a></span>
      <span><a href="../stability/"><b>CI stability &rarr;</b></a></span>
    </div>
  </header>

  ${limits(model)}

  <h2>The figures</h2>
  <p class="sectionnote">Each carries the counts it was made from, because a median over four rounds and one over four hundred are different claims.</p>
  ${figuresTable(model)}

  <h2>Where the harness minutes go</h2>
  <p class="sectionnote">The time each kind of check held a round: from the moment the one before it finished, so two running together are counted once and the last to finish is the one charged. Runs are the times it ran; a review that finished before the tests held nobody up.</p>
  ${harnessCards(model)}

  <h2>Coding against the harness</h2>
  <p class="sectionnote">Minutes spent writing and fixing against minutes spent in the harness, the rounds plus local review. Every pull request pays a fixed harness cost, so a small change sits above the dashed line whatever it did; read the minutes beside the ratio. No line is drawn as healthy, since there is no accepted benchmark for this ratio: the reference is the window&rsquo;s own median.</p>
  ${balance(model)}

  <h2>Each pull request, start to merge</h2>
  ${strips(model)}

  <h2>The numbers behind it</h2>
  <p class="sectionnote">Over every merged pull request read, not one window. A review&rsquo;s total time is the time it ran; the time it held anyone up is only the part of a round it was the one still running. The two differ because reviews run beside the tests.</p>
  ${numbersTable(model)}

  <footer>
    Generated by <code>tools/lead-time</code> from the pull request and Actions APIs and each pull request&rsquo;s session record.
  </footer>

</div>
</body>
</html>
`;
}
