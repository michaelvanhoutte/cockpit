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

import { AWAY_MS, CHECK_KINDS, kindOf } from '../model.js';
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

/**
 * Every check that held the round, in the order it did, each named once even
 * where a re-run repeats it — "held by Test, then claude-review", never just
 * the last of the two. Naming only `round.last` here would say in words the
 * same thing the strip used to say in colour, and be just as misleading for a
 * round several checks handed off between.
 */
function heldBy(round) {
  const names = [];
  for (const held of round.held) if (names[names.length - 1] !== held.name) names.push(held.name);
  return names.join(', then ');
}

/** What a round says about itself, in words, for the title on its segment and the list under its strip. */
function roundText(round, index) {
  const parts = [`Round ${index}`, humanMs(round.ms), `pushed ${stamp(round.pushedAt)}`];
  if (round.held.length) parts.push(`held by ${heldBy(round)}`);
  if (round.red) parts.push(`RED: ${round.failed.join(', ')} failed`);
  if (round.flukes.length) parts.push(`FLUKE: ${round.flukes.map((fluke) => `${fluke.name} failed and passed on re-run, +${humanMs(fluke.ms)}`).join('; ')}`);
  if (round.unrecognised.length) parts.push(`unrecognised: ${round.unrecognised.map((each) => `${each.name} (${each.conclusion})`).join(', ')}`);
  return parts.join(' · ');
}

/** What one check held a round for, in words, for the title on its own slice of the round. */
function heldText(held) {
  return `${KIND_LABEL[kindOf(held.name)]} (${held.name}) · held it ${humanMs(held.ms)}${held.rerun ? ' · re-run' : ''}`;
}

const PART_TITLE = {
  coding: (part, pull) =>
    pull.recorded ? `Coding before the first push · ${humanMs(part.ms)}` : `From the first commit to the first push · ${humanMs(part.ms)} · no session record, so any coding before the first commit is not recorded`,
  fixing: (part) => `Fixing before the next push · ${humanMs(part.ms)}`,
  wait: (part) => `Waiting to merge · ${humanMs(part.ms)}`,
  away: (part) => `Away for ${humanMs(part.ms)} · a gap of over ${humanMs(AWAY_MS)} is drawn off the time scale`,
};

/** The CSS flex-grow for a duration: proportional to its seconds, floored at 1 so nothing vanishes to zero width. */
const growOf = (ms) => Math.max(1, Math.round(ms / 1000));

/**
 * A round drawn as the checks that actually held it, in the order they finished —
 * never as one colour for the whole span. A round often outlasts any one check:
 * the tests can hold it for most of its length and a review only the tail, and a
 * single colour over the full width would read as the tail's check holding all of
 * it. Each piece is sized to the share of the round it actually held, so a piece
 * of the same colour beside another of the same colour reads as one stretch,
 * which is correct — the round genuinely was held by that kind without a seam.
 *
 * `visibleMs`, when the round itself was clipped to the scale's edge, is how much
 * of it is actually shown: the pieces are trimmed to that budget the same way
 * `fitTo` trims the parts around it, rather than drawn at their real, full-round
 * proportions squeezed into less room — which would show a check's colour past
 * the point its slice was actually cut off.
 */
function roundPieces(round, visibleMs = round.ms) {
  const shown = [];
  if (visibleMs >= round.ms) {
    shown.push(...round.held);
  } else {
    let used = 0;
    for (const held of round.held) {
      const room = visibleMs - used;
      if (room <= 0) break;
      shown.push(held.ms > room ? { ...held, ms: room } : held);
      used += Math.min(held.ms, room);
    }
  }
  return shown.map((held) => `<span class="piece ${kindOf(held.name)}" style="flex:${growOf(held.ms)} 1 0" title="${esc(heldText(held))}"></span>`).join('');
}

function segment(part, pull) {
  if (part.type === 'away') return `<span class="seg away" title="${esc(PART_TITLE.away(part))}"><span class="sr">away ${esc(humanMs(part.ms))}</span></span>`;

  const grow = `flex:${growOf(part.ms)} 1 0`;
  if (part.type === 'round') {
    const marks =
      (part.round.red ? '<i class="mark red" aria-hidden="true">✕</i>' : '') + (part.round.flukes.length ? '<i class="mark fluke" aria-hidden="true">↻</i>' : '');
    const pieces = roundPieces(part.round, part.cut ? part.ms : undefined);
    return `<span class="seg round${part.round.red ? ' red' : ''}${part.cut ? ' cut' : ''}" style="${grow}" title="${esc(roundText(part.round, part.index))}">${pieces}${marks}</span>`;
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
    ${item('checks', 'held by tests and checks')}
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
  const scaleNote = `<p class="sectionnote">Every strip is on one scale, up to ${humanMs(scaleMs)}. Time away is not on it. A round is split into the checks that held it, in the order they finished — hover a slice for which one and how long; open a row for its rounds in words.</p>`;
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

/**
 * The evolution panels: every merged pull request in the zoomed range, positioned
 * on the x-axis by when it actually merged (never by index — a quiet week must
 * look quieter), each panel its own y-scale since minutes, a count and a
 * percentage do not share one. Every panel also carries a size lane of its own:
 * a dot per pull request, sized by its lines changed, in its own row below the
 * bars rather than drawn over them — stacked atop the bars themselves, a size
 * dot reads fine on a quiet day and becomes an illegible blob on a busy one,
 * since it is fighting the bar's own colour for the same pixels.
 */
const EVO = { width: 900, left: 52, right: 12, top: 10 };
const EVO_LANE = { height: 26, gap: 10 };

/** A pull request's size-dot radius in the lane: 2 to 9px, so the smallest change is still a mark and the largest cannot swallow its neighbours. `maxLines` is always at least 1 — see `evoScales`. */
function evoRadius(lines, maxLines) {
  return 2 + 7 * Math.sqrt(Math.max(0, lines) / maxLines);
}

/**
 * Midnight UTC of every day the read pull requests span, for the shared x-axis —
 * never before `t0` itself: the first midnight at or after it can still be days
 * away where every pull request merged inside one day, and a tick from before the
 * scale's own start would sit far off it, not merely near its edge.
 */
function evoDayTicks(t0, t1) {
  const start = new Date(t0);
  start.setUTCHours(0, 0, 0, 0);
  const ticks = [];
  for (let t = start.getTime(); t <= t1; t += 86_400_000) if (t >= t0) ticks.push(t);
  return ticks.length ? ticks : [t0];
}

/** The plot's x scale (by time), shared by every panel and its lane alike. */
function evoPx(t0, t1) {
  const span = Math.max(1, t1 - t0);
  const plotW = EVO.width - EVO.left - EVO.right;
  return { px: (t) => EVO.left + ((t - t0) / span) * plotW, plotW };
}

/** The bar plot's own axis and gridlines: the y-scale and the box, but not the shared day ticks. */
function evoValueAxis(t0, t1, maxY, plotH, yFormat) {
  const { plotW } = evoPx(t0, t1);
  const py = (v) => EVO.top + plotH - (Math.min(v, maxY) / maxY) * plotH;
  let out = `<line class="eaxis" x1="${EVO.left}" y1="${EVO.top}" x2="${EVO.left}" y2="${EVO.top + plotH}"/><line class="eaxis" x1="${EVO.left}" y1="${EVO.top + plotH}" x2="${EVO.left + plotW}" y2="${EVO.top + plotH}"/>`;
  for (let i = 0; i <= 3; i += 1) {
    const y = py((maxY / 3) * i);
    out += `<line class="egrid" x1="${EVO.left}" y1="${y.toFixed(1)}" x2="${EVO.left + plotW}" y2="${y.toFixed(1)}"/><text class="etick" x="${(EVO.left - 6).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(yFormat((maxY / 3) * i))}</text>`;
  }
  return { svg: out, py };
}

/** The day labels shared by a panel's bars and its lane, drawn once at the very bottom. */
function evoDayAxis(t0, t1, y) {
  const { px } = evoPx(t0, t1);
  return evoDayTicks(t0, t1)
    .map((t) => `<text class="etick" x="${px(t).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(day(new Date(t).toISOString()).slice(5))}</text>`)
    .join('');
}

/** The size lane: one dot per pull request, in its own row so it never competes with a bar's own colour for the same pixels. */
function evoSizeLane(pulls, t0, t1, maxLines, top) {
  const { px, plotW } = evoPx(t0, t1);
  const laneY = top + EVO_LANE.height / 2;
  const dots = pulls
    .map((pull) => {
      const lines = pull.size.additions + pull.size.deletions;
      return `<circle class="evodot" cx="${px(Date.parse(pull.mergedAt)).toFixed(1)}" cy="${laneY.toFixed(1)}" r="${evoRadius(lines, maxLines).toFixed(1)}"><title>${esc(evoTitle(pull))} · ${plural(lines, 'line')} changed</title></circle>`;
    })
    .join('');
  return `<line class="elanesep" x1="${EVO.left}" y1="${top.toFixed(1)}" x2="${EVO.left + plotW}" y2="${top.toFixed(1)}"/><text class="etick" x="${(EVO.left - 6).toFixed(1)}" y="${(laneY + 3.5).toFixed(1)}" text-anchor="end">size</text>${dots}`;
}

/** A panel's full height: its bars, the size lane below them, and the day labels under that. */
function evoHeight(plotH) {
  return EVO.top + plotH + EVO_LANE.gap + EVO_LANE.height + 20;
}

const evoTitle = (pull) => `#${pull.number} ${pull.title}`;

/** The tail every panel shares: the size lane below the bars, the day labels under that, and the svg wrapper around all of it. */
function evoPanel(pulls, t0, t1, maxLines, plotH, axisSvg, barsSvg) {
  const laneTop = EVO.top + plotH + EVO_LANE.gap;
  return `<svg viewBox="0 0 ${EVO.width} ${evoHeight(plotH)}" class="evochart">${axisSvg}${barsSvg}${evoSizeLane(pulls, t0, t1, maxLines, laneTop)}${evoDayAxis(t0, t1, laneTop + EVO_LANE.height + 14)}</svg>`;
}

/** Where the harness minutes go, stacked by kind, one bar per pull request. `maxY` is shared across every zoom tab — see `evoScales` — so the same pull request draws at the same height whichever tab is open. */
function evoHarness(pulls, t0, t1, maxLines, maxY) {
  const { px, plotW } = evoPx(t0, t1);
  const plotH = 150;
  const barW = Math.max(1.5, Math.min(6, plotW / pulls.length - 1));
  const bars = pulls
    .map((pull) => {
      const cx = px(Date.parse(pull.mergedAt));
      let y = EVO.top + plotH;
      return KINDS.map((kind) => {
        const ms = pull.harness.kinds[kind].ms;
        if (ms <= 0) return '';
        const h = plotH * (Math.min(ms, maxY) / maxY);
        const rect = `<rect class="evobar ${kind}" x="${(cx - barW / 2).toFixed(1)}" y="${(y - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(`${evoTitle(pull)}\n${KIND_LABEL[kind]}: ${humanMs(ms)}`)}</title></rect>`;
        y -= h;
        return rect;
      }).join('');
    })
    .join('');
  const { svg: axis } = evoValueAxis(t0, t1, maxY, plotH, (v) => `${minuteTick(v)}m`);
  return evoPanel(pulls, t0, t1, maxLines, plotH, axis, bars);
}

/** One value per pull request, as a bar — used for lead time, rounds and the red-round rate. `maxY` is shared across every zoom tab, like `evoHarness`'s. */
function evoBar(pulls, t0, t1, maxLines, { cls, maxY, yFormat, valueOf, titleOf }) {
  const { px, plotW } = evoPx(t0, t1);
  const plotH = 100;
  const barW = Math.max(1.5, Math.min(6, plotW / pulls.length - 1));
  const { svg: axis, py } = evoValueAxis(t0, t1, maxY, plotH, yFormat);
  const bars = pulls
    .map((pull) => {
      const value = valueOf(pull);
      if (value <= 0) return '';
      const cx = px(Date.parse(pull.mergedAt));
      const y = py(value);
      return `<rect class="evobar ${cls}" x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(EVO.top + plotH - y).toFixed(1)}"><title>${esc(titleOf(pull, value))}</title></rect>`;
    })
    .join('');
  return evoPanel(pulls, t0, t1, maxLines, plotH, axis, bars);
}

/**
 * The scales every zoom tab shares, from every pull request read — never from just
 * the pulls a narrower tab shows. Without this, the same pull request would draw
 * at a different bar height and dot size depending on which tab happened to be
 * open, since each tab's own subset would set its own maximum.
 */
function evoScales(pulls) {
  return {
    maxLines: Math.max(1, ...pulls.map((pull) => pull.size.additions + pull.size.deletions)),
    harnessMaxY: Math.max(60_000, ...pulls.map((pull) => KINDS.reduce((sum, kind) => sum + pull.harness.kinds[kind].ms, 0))),
    leadMaxY: Math.max(60_000, ...pulls.map((pull) => pull.totalMs)),
    roundsMaxY: Math.max(1, ...pulls.map((pull) => pull.rounds.length)),
  };
}

/**
 * Where the harness minutes go, how long a pull request took start to merge, how
 * many rounds it took and how many ran red — one point per merged pull request in
 * range, not one per window, so a trend is something to see rather than two
 * snapshots to compare by eye.
 */
function evolution(pulls, scales) {
  const sorted = [...pulls].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  if (sorted.length < 2) return '<div class="card pad"><p class="empty">Not enough merged pull requests in this period to show a trend.</p></div>';

  const t0 = Date.parse(sorted[0].mergedAt);
  const t1 = Date.parse(sorted[sorted.length - 1].mergedAt);
  // GitHub's merge times are to the second, so more than one pull request merging in the
  // same second is a batch or a merge queue, not a coincidence — and leaves no span to plot.
  if (t1 === t0) return '<div class="card pad"><p class="empty">Every pull request in this period merged at the same moment, so there is no span of time to plot.</p></div>';

  const legend = `<div class="legend">${KINDS.map((kind) => `<span class="key"><span class="swatch ${kind}"></span>${KIND_LABEL[kind]}</span>`).join('')}</div>`;

  const rounds = (pull) => pull.rounds.length;
  const redShare = (pull) => (pull.rounds.length ? pull.rounds.filter((round) => round.red).length / pull.rounds.length : 0);

  return `<div class="card pad">
    <h3>Where the harness minutes go</h3>
    ${legend}
    ${evoHarness(sorted, t0, t1, scales.maxLines, scales.harnessMaxY)}
    <h3>Start to merge</h3>
    ${evoBar(sorted, t0, t1, scales.maxLines, {
      cls: 'lead',
      maxY: scales.leadMaxY,
      yFormat: (v) => `${minuteTick(v)}m`,
      valueOf: (pull) => pull.totalMs,
      titleOf: (pull, v) => `${evoTitle(pull)} · ${humanMs(v)} to merge`,
    })}
    <h3>Rounds to merge</h3>
    ${evoBar(sorted, t0, t1, scales.maxLines, {
      cls: 'rounds',
      maxY: scales.roundsMaxY,
      yFormat: (v) => String(Math.round(v)),
      valueOf: rounds,
      titleOf: (pull, v) => `${evoTitle(pull)} · ${plural(v, 'round')}`,
    })}
    <h3>Red rounds</h3>
    ${evoBar(sorted, t0, t1, scales.maxLines, {
      cls: 'red',
      maxY: 1,
      yFormat: (v) => `${Math.round(v * 100)}%`,
      valueOf: redShare,
      titleOf: (pull, v) => `${evoTitle(pull)} · ${Math.round(v * 100)}% of its rounds red`,
    })}
  </div>`;
}

/**
 * How far back a zoom preset reaches, from the model's own `generatedAt` — never
 * `Date.now()`, so the page renders the same way whenever it is opened. Each id
 * here is also a literal selector in styles.css's `.tabs` rules
 * (`#evozoom-<id>:checked ~ #evopanel-<id>`) — change one and change the other,
 * since nothing else ties them together.
 */
const EVO_ZOOM = [
  { id: 'all', label: 'All' },
  { id: '7', label: 'Last 7 days' },
  { id: '3', label: 'Last 3 days' },
];

/**
 * The zoom tabs around `evolution`: one pre-rendered panel per preset, switched by
 * plain radio buttons and a CSS sibling selector — no script, so the page keeps
 * needing nothing but itself. Every preset's data is already on the page either
 * way; the tabs only change which of it is shown. Every preset shares one set of
 * scales (`evoScales`, over every pull request read) rather than each computing
 * its own, so a pull request's bars and dot are the same size in every tab.
 */
function evolutionZoomTabs(model) {
  const now = Date.parse(model.generatedAt);
  const pullsFor = (preset) =>
    preset.id === 'all' ? model.pulls : model.pulls.filter((pull) => Date.parse(pull.mergedAt) >= now - Number(preset.id) * 86_400_000);
  const scales = evoScales(model.pulls);

  const inputs = EVO_ZOOM.map(
    (preset, index) =>
      `<input type="radio" name="evozoom" id="evozoom-${preset.id}" class="tabradio"${index === 0 ? ' checked' : ''}><label for="evozoom-${preset.id}" class="tablabel">${esc(preset.label)}</label>`,
  ).join('');
  const panels = EVO_ZOOM.map((preset) => `<div class="tabpanel" id="evopanel-${preset.id}">${evolution(pullsFor(preset), scales)}</div>`).join('');
  return `<div class="tabs">${inputs}${panels}</div>`;
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
      <!-- The other three pages of the published site, assembled by ci.yml's
           Publish job; they resolve there and nowhere else. -->
      <span><a href="../"><b>Test explorer &rarr;</b></a></span>
      <span><a href="../stability/"><b>CI stability &rarr;</b></a></span>
      <span><a href="../selection/"><b>Test selection &rarr;</b></a></span>
    </div>
  </header>

  ${limits(model)}

  <h2>Evolution</h2>
  <p class="sectionnote">One point per merged pull request read, not one window, positioned by when it merged &mdash; so a trend is something to see rather than a pair of snapshots to compare by eye. Each panel's own size lane carries the pull request's lines changed. Zoom in with the tabs below; every day's data is already on this page, so nothing is fetched to do it.</p>
  ${evolutionZoomTabs(model)}

  <h2>Coding against the harness</h2>
  <p class="sectionnote">Minutes spent writing and fixing against minutes spent in the harness, the rounds plus local review. Every pull request pays a fixed harness cost, so a small change sits above the dashed line whatever it did; read the minutes beside the ratio. No line is drawn as healthy, since there is no accepted benchmark for this ratio: the reference is the window&rsquo;s own median.</p>
  ${balance(model)}

  <h2>Each pull request, start to merge</h2>
  ${strips(model)}

  <footer>
    Generated by <code>tools/lead-time</code> from the pull request and Actions APIs and each pull request&rsquo;s session record.
  </footer>

</div>
</body>
</html>
`;
}
