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

import { dayStartsBetween, formatClock, formatClockMinutes, formatDate, formatDateTime, formatDayMonth, belgianDay } from '../../../../scripts/lib/belgian-time.mjs';
import { AWAY_MS, LOCAL_REVIEW_KINDS, LOCAL_RUN_KINDS } from '../model.js';
import { layoutScatter, PLOT_SIZE } from './scatter.js';
import { axisFor, fitTo, partsOf, scaleFor } from './strips.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every kind of time a strip or a panel draws, and which side it is on: `local` is
 * work on the developer's machine and `ci` is the harness's. One colour family each
 * (styles.css), so a later local kind joins here and in the stylesheet and nowhere
 * else. Waiting to merge and time away are in neither group.
 */
const KIND_GROUPS = [
  { id: 'local', label: 'Local' },
  { id: 'ci', label: 'CI' },
];
const KIND = {
  coding: { group: 'local', label: 'Coding before the first push', key: 'coding before the first push' },
  fixing: { group: 'local', label: 'Fixing between rounds', key: 'fixing between rounds' },
  'local-code-review': { group: 'local', label: 'Local code review', key: 'code review' },
  'local-security-review': { group: 'local', label: 'Local security review', key: 'security review' },
  'local-test': { group: 'local', label: 'Local test run', key: 'test run' },
  'local-browser': { group: 'local', label: 'Browser pass', key: 'browser pass' },
  checks: { group: 'ci', label: 'Tests and checks', key: 'held by tests and checks' },
};
const KIND_LABEL = Object.fromEntries(Object.entries(KIND).map(([id, kind]) => [id, kind.label]));

/** The class a local slice of this kind (a review, `test` or `browser`) is drawn and keyed with. */
const reviewClass = (kind) => `local-${kind}`;
/** Bottom to top in a panel's bar: CI first, then each local review, then test runs and the browser pass. */
const LANES = ['checks', ...LOCAL_REVIEW_KINDS.map(reviewClass), ...LOCAL_RUN_KINDS.map(reviewClass)];
/** A pull request's minutes in one panel lane, or `null` where the lane reads not recorded. */
function laneMs(pull, lane) {
  if (lane === 'checks') return pull.harness.kinds.checks.ms;
  return pull.harness.local?.[lane.replace(/^local-/, '')]?.ms ?? null;
}

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

/** Every moment on the page is Belgian time in Belgian format, whoever reads it (scripts/lib/belgian-time.mjs); the model file keeps ISO UTC. */
const stamp = formatDateTime;
/** A job's own start and stop are to the second, which the minute a push is stamped to cannot tell apart. */
const clock = formatClock;
const day = formatDate;
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
      : `<li><b>${recorded} of ${plural(model.pulls.length, 'merged pull request')} carry a session record.</b> Coding before the first push, local-review time, test runs and the browser pass exist only for those; for the rest the strip says <em>not recorded</em> and never draws them as nothing.</li>`;

  const unreadable = coverage.failed.length
    ? `<li class="warn"><b>${plural(coverage.failed.length, 'pull request')} could not be read</b> and ${coverage.failed.length === 1 ? 'is' : 'are'} left out: ${coverage.failed.map((each) => `#${esc(each.number)}`).join(', ')}.</li>`
    : '';

  const landings = model.pulls.filter((pull) => pull.landing).length;
  const branches = model.pulls.some((pull) => pull.base !== model.branch)
    ? `<li><b>Pull requests into a feature branch are read as well</b>, each marked with its base${landings ? `; ${plural(landings, 'feature branch landing')} (a feature branch into ${esc(model.branch)}) ${landings === 1 ? 'is' : 'are'} shown but in no figure, since ${landings === 1 ? 'its' : 'their'} units are counted already` : ''}.</li>`
    : '';

  return `<div class="note"><b>What this does and does not measure</b><ul>
    ${period}
    ${branches}
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

/** What a round says about itself, in words, for the title on its segment and its detail under the axis. */
function roundText(round, index) {
  const parts = [`CI Round ${index}`, humanMs(round.ms), `pushed ${stamp(round.pushedAt)}`];
  if (round.held.length) parts.push(`held by ${heldBy(round)}`);
  if (round.red) parts.push(`RED: ${round.failed.join(', ')} failed`);
  if (round.flukes.length) parts.push(`FLUKE: ${round.flukes.map((fluke) => `${fluke.name} failed and passed on re-run, +${humanMs(fluke.ms)}`).join('; ')}`);
  if (round.unrecognised.length) parts.push(`unrecognised: ${round.unrecognised.map((each) => `${each.name} (${each.conclusion})`).join(', ')}`);
  if (!Array.isArray(round.lanes)) parts.push('lanes not recorded: its job list could not be read, or no job of it ran on a runner, so it is drawn as one block');
  return parts.join(' · ');
}

/**
 * Which round a job ran in, said under the job: the round's name and when it was pushed. What held the round is left
 * out, since beneath one job it would read as that job's story; it is in the round's own detail.
 */
const roundContext = (round, index) => `CI Round ${index} · pushed ${stamp(round.pushedAt)}`;

const OUTCOME_WORD = { pass: 'passed', fail: 'failed', cancelled: 'cancelled', running: 'still running', other: 'neither passed nor failed', unknown: 'ended in a conclusion not recognised' };

/** What a job lane says of itself: when it started and stopped (Belgian time, to the second), the wait for a runner before it, and how it ended. */
function laneText(lane) {
  const own = lane.shard !== undefined ? `${lane.name} · shard ${lane.shard} of ${lane.family}` : lane.fanIn ? `${lane.name} · fan-in of the ${lane.family} shards` : lane.name;
  return [
    own,
    `${lane.startedAt ? `started ${clock(lane.startedAt)}` : 'start not recorded'}${lane.endedAt ? `, stopped ${clock(lane.endedAt)}` : ', not stopped'}`,
    `ran ${humanMs(lane.ms)}`,
    lane.queuedMs === null ? 'wait for a runner not recorded' : `waited ${humanMs(lane.queuedMs)} for a runner${lane.leadMs < lane.queuedMs ? ' (the part before the round began is not drawn)' : ''}`,
    OUTCOME_WORD[lane.outcome] ?? lane.outcome,
    lane.rerun ? `re-run (attempt ${lane.attempt})` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** What one check held a round for, in words, for the title on its own slice of the round. */
function heldText(held) {
  return `${KIND_LABEL.checks} (${held.name}) · held it ${humanMs(held.ms)}${held.rerun ? ' · re-run' : ''}`;
}

/** A local slice in words: its kind, level (a review) and duration, and the scope of a test run. */
function sliceText(slice) {
  return [
    KIND_LABEL[reviewClass(slice.kind)],
    slice.level,
    humanMs(slice.sliceMs ?? slice.ms),
    slice.scopes ? slice.scopes.join(', ') : null,
    slice.endedTogether ? 'ended together with the other review, so its own length is not recorded' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const PART_TITLE = {
  coding: (part, pull) =>
    pull.recorded ? `Coding before the first push · ${humanMs(part.ms)}` : `From the first commit to the first push · ${humanMs(part.ms)} · no session record, so any coding before the first commit is not recorded`,
  fixing: (part) => `Fixing before the next push · ${humanMs(part.ms)}`,
  wait: (part) => `Waiting to merge · ${humanMs(part.ms)}`,
  away: (part) => `Away for ${humanMs(part.ms)} · a gap of over ${humanMs(AWAY_MS)} is drawn off the time scale`,
};

/**
 * The elements of one pull request's zoomed strip the reader can pick. Each gets a radio laid over it on the
 * strip, and the page carries a detail for it under the axis that the styles show while the radio is checked, so
 * there is no script. The radios share a name, so the pull request holds one pick. Radios that say the same (a
 * round's background and its two names, a job's lead and its lane) show one detail, written once, which keeps
 * the page near the size it was before it could be picked from. The closed strip has none: it only zooms.
 */
function picker(pull) {
  const number = esc(pull.number);
  const name = `pick-${number}`;
  const details = new Map();
  let radios = 0;
  return {
    /** The details this pull request has, each with the ids of the radios that show it. */
    details: () => [...details.values()],
    /** A radio for an element that reads `label`, joined to the detail `detailHtml`, which is added if no radio has shown it yet. Ids are short, since there is one for every element on the page. */
    add(label, detailHtml) {
      radios += 1;
      const id = `r${number}-${radios}`;
      const detail = details.get(detailHtml) ?? { id: `d${number}-${radios}`, html: detailHtml, radios: [] };
      detail.radios.push(id);
      details.set(detailHtml, detail);
      return `<input type="radio" class="pick" name="${name}" id="${id}" aria-label="${esc(label)}">`;
    },
  };
}

/** A detail: the first piece of what the element says as its heading, the rest as the line under it, then any extra markup. */
function detailOf(text, extra = '') {
  const [head, ...rest] = text.split(' · ');
  return `<p class="dhead">${esc(head)}</p>${rest.length ? `<p class="dline">${esc(rest.join(' · '))}</p>` : ''}${extra}`;
}

/** The box under the axis: the summary line and what to click until something is picked, then the detail of the pick. */
function detailBox(pick, summary) {
  const shown = pick
    .details()
    .map((detail) => `<div class="detail" id="${detail.id}">${detail.html}</div>`)
    .join('');
  return `<div class="detailbox"><p class="hint">${summary} &middot; click a phase, a CI job or a local run on the strip to read it here.</p>${shown}</div>`;
}

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
  return shown.map((held) => `<span class="piece checks" style="flex:${growOf(held.ms)} 1 0" title="${esc(heldText(held))}"></span>`).join('');
}

/**
 * Where a part sits in its strip: at its own time and its own length of the scale, never pushed by a
 * neighbour. `--span` is the track less its breaks, so the time on the scale fills what is left; a
 * break is `--break` wide (styles.css), its stripes inset 2px either side.
 */
function placeStyle(part, scaleMs) {
  const left = `calc(var(--span) * ${(part.startMs / scaleMs).toFixed(5)} + var(--break) * ${part.breaksBefore}${part.type === 'away' ? ' + 2px' : ''})`;
  return part.type === 'away' ? `left:${left}` : `left:${left};width:calc(var(--span) * ${(part.ms / scaleMs).toFixed(5)})`;
}

/** The lanes of a parallel stretch or a round that fall inside it, once it is cut at the scale's edge. */
const visibleLanes = (part) => (part.lanes ?? []).filter((lane) => lane.offsetMs - (lane.leadMs ?? 0) < part.ms);

/**
 * A round's jobs, each at its own start and stop inside the round, its wait for a runner a lead before
 * it in the same row. Positions are shares of the round's own width, so they stay true wherever the round is placed.
 * On a zoomed strip (`pick`) each lane and lead carries the radio that picks its job.
 */
function laneSpans(part, pick) {
  const share = (ms) => (part.ms > 0 ? (ms / part.ms) * 100 : 0).toFixed(3);
  const { round, index } = part;
  return visibleLanes(part)
    .map((lane) => {
      const title = esc(laneText(lane));
      const top = `top:${lane.row * 100}%`;
      const radio = () => (pick ? pick.add(laneText(lane), detailOf(laneText(lane), `<p class="dctx">in ${esc(roundContext(round, index))}</p>`)) : '');
      const lead = lane.leadMs > 0 ? `<span class="lane lead" style="left:${share(lane.offsetMs - lane.leadMs)}%;width:${share(Math.min(lane.leadMs, part.ms - (lane.offsetMs - lane.leadMs)))}%;${top}" title="${title}">${radio()}</span>` : '';
      if (lane.offsetMs >= part.ms) return lead;
      const classes = ['lane', 'job', lane.outcome === 'fail' ? 'failed' : '', lane.rerun ? 'rerun' : '', lane.outcome === 'running' ? 'running' : ''].filter(Boolean).join(' ');
      return `${lead}<span class="${classes}" style="left:${share(lane.offsetMs)}%;width:${share(Math.min(lane.ms, part.ms - lane.offsetMs))}%;${top}" title="${title}">${radio()}</span>`;
    })
    .join('');
}

/** A part of a strip. On a zoomed strip (`pick`) each element in it, and the part itself, carries the radio that picks it. */
function segment(part, pull, scaleMs, pick = null) {
  const place = placeStyle(part, scaleMs);
  const radio = (text, extra = '') => (pick ? pick.add(text, detailOf(text, extra)) : '');
  if (part.type === 'away') return `<span class="seg away" style="${place}" title="${esc(PART_TITLE.away(part))}"><span class="sr">away ${esc(humanMs(part.ms))}</span>${radio(PART_TITLE.away(part))}</span>`;

  if (part.type === 'round') {
    const { round, index } = part;
    const marked = [round.red ? '<i class="mark red" aria-hidden="true">✕</i>' : '', round.flukes.length ? '<i class="mark fluke" aria-hidden="true">↻</i>' : ''].filter(Boolean);
    // Every job its own lane where they are recorded; the block, split by what held the round, where they are not.
    const drawn = part.lanes ? laneSpans(part, pick) : roundPieces(round, part.cut ? part.ms : undefined);
    // The round's own detail is its line with every job's line beneath it. Its background and both of its names pick it.
    const roundRadio = () => radio(roundText(round, index), jobList(round));
    // Named by the width it has on screen, which only the browser knows: the long form, the short, or only its mark (styles `roundLabelRules`).
    const label = `<span class="roundlabel" aria-hidden="true">${marked.join('')}<span class="cilong">CI Round ${index}${roundRadio()}</span><span class="cishort">CI ${index}${roundRadio()}</span></span>`;
    const size = `d${Math.min(3, String(index).length)} m${marked.length}`;
    return `<span class="seg round${part.lanes ? ' withlanes' : ''}${round.red ? ' red' : ''} ${size}${part.cut ? ' cut' : ''}" style="${place}" title="${esc(roundText(round, index))}">${roundRadio()}${drawn}${label}</span>`;
  }

  if (part.type === 'review' || part.type === 'test' || part.type === 'browser') {
    return `<span class="seg ${part.type === 'review' ? 'review' : 'local'} ${reviewClass(part.kind)}${part.cut ? ' cut' : ''}" style="${place}" title="${esc(sliceText(part))}">${radio(sliceText(part))}</span>`;
  }

  // Local work in parallel: the longest piece stays on the strip's line and the others stack off it, each where its own work sits in the stretch. The line shows the coding or fixing where no piece of it runs.
  if (part.type === 'parallel') {
    const lanesHtml = visibleLanes(part)
      .map((lane) => {
        const left = (lane.offsetMs / part.ms) * 100;
        const width = (Math.min(lane.ms, part.ms - lane.offsetMs) / part.ms) * 100;
        return `<span class="lane ${reviewClass(lane.kind)}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;top:${lane.row * 100}%" title="${esc(sliceText(lane))}">${radio(sliceText(lane))}</span>`;
      })
      .join('');
    return `<span class="seg parallel ${part.base}${part.cut ? ' cut' : ''}" style="${place}">${radio(`${PART_TITLE[part.base](part, pull)} around the local work`)}${lanesHtml}</span>`;
  }

  const unrecorded = part.type === 'coding' && !pull.recorded ? ' unrecorded' : '';
  return `<span class="seg ${part.type}${unrecorded}${part.cut ? ' cut' : ''}" style="${place}" title="${esc(PART_TITLE[part.type](part, pull))}">${radio(PART_TITLE[part.type](part, pull))}</span>`;
}

/** A strip's track, its parts placed against `scaleMs`; the shared scale in a row, and the pull request's own when zoomed (`pick`, whose radios it carries). */
function track(pull, fitted, scaleMs, pick = null) {
  const scale = Math.max(1, scaleMs);
  const cap = fitted.clipped ? '<span class="clipmark" aria-hidden="true">&#9656;</span>' : '';
  // The track makes room above and below for the stack of lanes standing off its line.
  const rows = fitted.parts.filter((part) => part.type === 'parallel' || part.type === 'round').flatMap((part) => visibleLanes(part).map((lane) => lane.row));
  const above = Math.max(0, ...rows.map((row) => -row));
  const below = Math.max(0, ...rows);
  const vars = [`--span:${spanOf(fitted)}`, above + below > 0 ? `--above:${above};--below:${below}` : ''].filter(Boolean).join(';');
  return `<span class="track${above + below > 0 ? ' stacked' : ''}" style="${vars}">${fitted.parts.map((part) => segment(part, pull, scale, pick)).join('')}${cap}</span>`;
}

/** The track's width less its breaks: what the time on the scale is drawn across. */
const spanOf = (fitted) => (fitted.breaks ? `calc(100% - var(--break) * ${fitted.breaks})` : '100%');

/** A clock time on the axis in Belgian time: the hour and minute, with the day too where it is not the strip's first. */
function clockLabel(atMs, startedAt) {
  return belgianDay(atMs) === belgianDay(startedAt) ? formatClockMinutes(atMs) : `${formatDayMonth(atMs)} ${formatClockMinutes(atMs)}`;
}

/** The zoomed strip's axis, in the clock time of the pull request, from its start to its merge. Time away has none of its own. */
function axis(pull, zoomed) {
  const startedAt = Date.parse(pull.rounds[0].pushedAt) - pull.beforeFirstPushMs;
  const scale = Math.max(1, zoomed.shownMs);
  const ticks = axisFor(startedAt, zoomed)
    .map((tick) => `<span class="clocktick ${tick.align}" style="left:calc(var(--span) * ${(tick.startMs / scale).toFixed(5)} + var(--break) * ${tick.breaksBefore})">${clockLabel(tick.atMs, startedAt)}</span>`)
    .join('');
  // A span, as the label it sits in holds phrasing content only; the styles make it a block.
  return `<span class="clockaxis" style="--span:${spanOf(zoomed)}" title="Clock time in Belgian time. Click to close">${ticks}</span>`;
}

/** Under a round's line in its detail, one line per job with when it started and stopped, so the times can be read without hovering. */
function jobList(round) {
  if (!Array.isArray(round.lanes) || round.lanes.length === 0) return '';
  return `<ul class="joblist">${round.lanes.map((lane) => `<li>${esc(laneText(lane))}</li>`).join('')}</ul>`;
}

/**
 * The strip in a row: on the shared scale, and when clicked the same pull request zoomed on its own axis above
 * the box where the element picked on it is read. Its picker goes to `pickers`, which the page's styles are written from.
 */
function strip(pull, parts, fitted, scaleMs, summary, notes, pickers) {
  if (pull.rounds.length === 0) return '<span class="track"><span class="trackempty">no check ran on it</span></span>';
  const id = `zoom-${esc(pull.number)}`;
  const zoomed = fitTo(parts, Infinity);
  const pick = picker(pull);
  pickers.push(pick);
  const zoomedTrack = track(pull, zoomed, zoomed.shownMs, pick);
  // A checkbox the strip is the label of: a click toggles it and the page's styles show the other form, with no script.
  // In the zoomed form the axis closes it, and so do the empty rows around the line; an element picked under the pointer does not.
  return `<input type="checkbox" class="zoomtoggle" id="${id}" aria-label="Zoom in on #${esc(pull.number)}">
      <label class="striphit whenclosed" for="${id}" title="Click to zoom in on this pull request">${track(pull, fitted, scaleMs)}</label>
      <div class="zoomed">
        <label class="striphit" for="${id}">${zoomedTrack}</label>
        <label class="axishit" for="${id}">${axis(pull, zoomed)}</label>
        ${detailBox(pick, summary)}${notes}
      </div>`;
}

function stripRow(pull, parts, scaleMs, trunk, pickers) {
  const fitted = fitTo(parts, scaleMs);
  const reds = pull.rounds.filter((round) => round.red).length;
  const flukes = pull.flukes.length;
  const tags = [
    pull.landing
      ? `<span class="tag landing" title="A feature branch landing: ${esc(pull.head)} into ${esc(pull.base)}. Its units were each a pull request into the branch and are counted there, so this one is in no average, median or chart">feature branch landing</span>`
      : '',
    // The trunk is the report's own and needs no mark; any other base is named.
    !pull.landing && pull.base !== trunk ? `<span class="tag base" title="Merged into ${esc(pull.base)}, not ${esc(trunk)}">into ${esc(pull.base)}</span>` : '',
    pull.recorded
      ? ''
      : '<span class="tag unrecorded" title="No session record on this pull request, so its coding, local reviews, test runs and browser pass are not measured and its strip starts at the first commit">not recorded</span>',
    reds ? `<span class="tag red">${reds} red</span>` : '',
    flukes ? `<span class="tag fluke">${plural(flukes, 'fluke')}</span>` : '',
    fitted.clipped ? `<span class="tag clip">clipped</span>` : '',
  ].join('');

  const clipNote = fitted.clipped
    ? `<p class="clipnote whenclosed">Clipped: ${humanMs(fitted.clipped.totalMs)} on the scale in all (time away is not counted), the first ${humanMs(fitted.clipped.shownMs)} shown. The strip ends at the edge of the scale, not at the merge. Click it to see all of it.</p>`
    : '';
  const summary = `${plural(pull.rounds.length, 'CI Round')}${reds ? `, ${reds} red` : ''} &middot; ${humanMs(pull.totalMs)} to merge`;
  const notes = pull.notes.length ? `<p class="clipnote">${esc(pull.notes.join(' '))}</p>` : '';
  // Under a closed strip only the summary line and the notes: the elements are read once it is zoomed.
  const underClosed = pull.rounds.length ? `<p class="clipnote whenclosed">${summary}</p>${notes ? `<div class="whenclosed">${notes}</div>` : ''}` : '';

  return `<div class="pullrow">
    <div class="who">
      <a href="${esc(pull.url)}" target="_blank" rel="noopener"><b>#${esc(pull.number)}</b> ${esc(pull.title)}</a>
      <div class="when">merged ${esc(stamp(pull.mergedAt))} ${tags}</div>
    </div>
    <div class="strip">${strip(pull, parts, fitted, scaleMs, summary, notes, pickers)}<span class="sr">${esc(humanMs(pull.totalMs))} to merge, ${plural(pull.rounds.length, 'CI Round')}</span>${clipNote}${underClosed}</div>
  </div>`;
}

const swatch = (cls, text) => `<span class="key"><span class="swatch ${cls}"></span>${text}</span>`;

/** The kinds in `ids`, each under its own group's heading, so a reader sees which side of the line it is on before reading what it is. */
function groupedKeys(ids, text) {
  return KIND_GROUPS.map((group) => ({ group, ids: ids.filter((id) => KIND[id].group === group.id) }))
    .filter(({ ids: own }) => own.length > 0)
    .map(
      ({ group, ids: own }) =>
        `<div class="keygroup ${group.id}"><span class="keyhead">${group.label}</span>${own.map((id) => swatch(id, esc(text(id)))).join('')}</div>`,
    )
    .join('');
}

function legend() {
  const text = (id) => (id.startsWith('local-') ? `${KIND[id].key} (local, at the time it ran)` : KIND[id].key);
  return `<div class="legend grouped">
    <p class="ciround"><b>CI Round</b>: a push, until the last check on it finishes; a red one failed and was pushed again. Each job of a round is a lane from its own start to its own stop, so jobs that ran together sit in rows above one another.</p>
    ${groupedKeys(['coding', 'fixing', 'local-code-review', 'local-security-review', 'local-test', 'local-browser', 'checks'], text)}
    <div class="keygroup">
      ${swatch('lead', 'a job waiting for a runner, before its lane')}
      ${swatch('rerun', 're-run of a job')}
      ${swatch('wait', 'waiting to merge')}
      ${swatch('away', `away (over ${humanMs(AWAY_MS)}, off the scale)`)}
      <span class="key"><i class="mark red" aria-hidden="true">✕</i>red round</span>
      <span class="key"><i class="mark fluke" aria-hidden="true">↻</i>fluke: failed, passed on re-run</span>
      ${swatch('unrecorded', 'not recorded: no session record, so its strip starts at the first commit')}
    </div>
  </div>`;
}

/** The strips of every pull request, each picker its zoomed form needs collected in `pickers`. */
function strips(model, pickers) {
  if (model.pulls.length === 0) return '<div class="card"><p class="empty">No merged pull requests in this period.</p></div>';
  const allParts = model.pulls.map(partsOf);
  const scaleMs = scaleFor(allParts);
  const scaleNote = `<p class="sectionnote">Every strip is on one scale, up to ${humanMs(scaleMs)}, and every part sits at its own time and length on it; one too short to see is drawn a little wider, over what follows it. Time away is not on it. A CI Round is drawn as the jobs that ran in it, each a lane from its own start to its own stop with its wait for a runner as a dotted lead before it, so jobs that ran at the same time are in rows one above another and a job that waited on another starts where that one ended; hover a lane for when it started and stopped (Belgian time, to the second). A round whose jobs were not read is one block, split into the checks that held it, and says so on hover. A CI Round is named on the strip as far as its width allows. Click a strip to open that pull request on its own scale, uncut, with a clock-time axis (Belgian time); there, hover an element to outline it and click it to read it under the axis, and click the axis, or the empty rows above and below the line, to close it. A local review, test run or browser pass is cut out of the coding or fixing it sat in, at the time it ran; where several run in parallel, the longest stays on the line and the others stack above it, then below, and the minutes they share are counted once. Work on the developer&rsquo;s machine is drawn in greens and teals, CI in blue.</p>`;
  return `${scaleNote}${legend()}<div class="card">${model.pulls.map((pull, index) => stripRow(pull, allParts[index], scaleMs, model.branch, pickers)).join('')}</div>`;
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
    `${plural(dot.lines, 'line')} changed`,
  ];
  if (dot.off) parts.push('beyond the scale, so drawn on its edge');
  return parts.join(' · ');
}

const PLOT = { left: 48, top: 16, size: PLOT_SIZE };
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

  // Larger dots first, so a small one is never hidden under a large one; a tie keeps its place.
  const dots = [...layout.dots]
    .sort((a, b) => b.lines - a.lines)
    .map((dot) => {
      const r = dot.radius;
      // The link is the hit target: a pointer only has to be near, and a keyboard reaches it.
      return `<a href="${esc(dot.url)}" target="_blank" rel="noopener"><title>${esc(dotTitle(dot))}</title><circle class="hit" cx="${px(dot.x)}" cy="${py(dot.y)}" r="${Math.max(12, r + 6)}"/><circle class="dot step${dot.step}${dot.off ? ' off' : ''}" cx="${px(dot.x)}" cy="${py(dot.y)}" r="${r.toFixed(1)}"/></a>`;
    })
    .join('');

  // The labels are their own layer, after every dot, so no later dot paints over one; a dot whose label found no free place has none and is named by its hover and the table.
  // A label is only ink: the dot's own link names it to a screen reader and takes the pointer through it, so a label over a neighbour never hides that neighbour's hover.
  const labels = layout.dots
    .filter((dot) => dot.label)
    .map((dot) => `<text class="dotlabel" x="${(PLOT.left + dot.label.x).toFixed(1)}" y="${(PLOT.top + dot.label.y).toFixed(1)}" text-anchor="${dot.label.anchor}">#${esc(dot.number)}</text>`)
    .join('');

  return `<svg class="scatter" viewBox="0 0 ${VIEW.width} ${VIEW.height}" role="img" aria-label="Scatter of minutes coding and fixing against minutes in the harness, one dot per pull request. The same figures are in the table below it.">
    ${grid}
    <line class="axis" x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(0)}"/><line class="axis" x1="${px(0)}" y1="${py(0)}" x2="${px(0)}" y2="${py(1)}"/>
    <line class="equalline" x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}"/>
    ${median}
    ${dots}
    <g class="dotlabels" aria-hidden="true">${labels}</g>
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

  // Sample dots on this window's own scale, each labelled in lines; five swatches for the shade, 1 round to 5 or more.
  const sizeKey = layout.sizeKey
    .map((sample) => `<svg class="sample" viewBox="0 0 ${sample.radius * 2 + 4} 30" width="${sample.radius * 2 + 4}" height="30" aria-hidden="true"><circle class="keydot" cx="${sample.radius + 2}" cy="15" r="${sample.radius}"/></svg><span class="samplelabel">${plural(sample.lines, 'line')}</span>`)
    .join('');
  const shadeKey = [1, 2, 3, 4, 5]
    .map((step) => `<svg class="sample" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle class="keydot step${step}" cx="7" cy="7" r="5"/></svg><span class="samplelabel">${step === 5 ? '5+' : step}</span>`)
    .join('');

  const legend = `<div class="legend stacked">
    <span class="key"><svg class="keyline" viewBox="0 0 24 8" aria-hidden="true"><line class="equalline" x1="0" y1="4" x2="24" y2="4"/></svg>the harness took as long as the coding</span>
    <span class="key"><svg class="keyline" viewBox="0 0 24 8" aria-hidden="true"><line class="medianline" x1="0" y1="4" x2="24" y2="4"/></svg>this window&rsquo;s median ratio</span>
    <span class="key sizekey">${sizeKey}dot size: lines changed</span>
    <span class="key shadekey">${shadeKey}dot shade: CI rounds</span>
    <span class="key"><svg class="keyline" viewBox="0 0 14 14" aria-hidden="true"><circle class="keydot off" cx="7" cy="7" r="5"/></svg>hollow on the edge: off the chart</span>
  </div>`;

  const rows = layout.dots
    .map(
      (dot) => `<tr>
        <td class="pr"><a href="${esc(dot.url)}" target="_blank" rel="noopener">#${esc(dot.number)}</a> <span class="title">${esc(dot.title)}</span></td>
        <td class="num dur">${humanMs(dot.codingMs)}</td>
        <td class="num dur">${humanMs(dot.harnessMs)}</td>
        <td class="num dur">${dot.ratio === null ? '&mdash;' : ratioText(dot.ratio)}</td>
        <td class="num">${dot.rounds}</td>
        <td class="num">${dot.lines}</td>
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
        <p class="clipnote">Scale to ${humanMs(layout.scaleMs)} on both axes${off ? `; ${plural(off, 'dot')} beyond it, drawn hollow on the edge` : ''}. The three furthest above the dashed line are named where their labels fit. Hover or focus a dot for its figures; it opens the pull request.</p>
        ${leftOut}
      </div>
    </div>
    <details><summary>The figures behind the dots</summary><div class="tablewrap"><table>
      <thead><tr><th>Pull request</th><th class="num">Coding and fixing</th><th class="num">In the harness</th><th class="num">Ratio</th><th class="num">Rounds</th><th class="num">Lines changed</th><th></th></tr></thead>
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
 * Belgian midnight of every day the read pull requests span, for the shared x-axis —
 * never before `t0` itself: the first midnight at or after it can still be days
 * away where every pull request merged inside one day, and a tick from before the
 * scale's own start would sit far off it, not merely near its edge.
 */
function evoDayTicks(t0, t1) {
  const ticks = dayStartsBetween(t0, t1);
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
    .map((t) => `<text class="etick" x="${px(t).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(formatDayMonth(t))}</text>`)
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
      // A lane the record has nothing of is said on the bar as not recorded, rather
      // than left missing to read as zero.
      const unrecorded = LANES.filter((lane) => laneMs(pull, lane) === null).map((lane) => `\n${KIND_LABEL[lane]}: not recorded`).join('');
      return LANES.map((kind) => {
        const ms = laneMs(pull, kind);
        if (ms === null || ms <= 0) return '';
        const h = plotH * (Math.min(ms, maxY) / maxY);
        const rect = `<rect class="evobar ${kind}" x="${(cx - barW / 2).toFixed(1)}" y="${(y - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(`${evoTitle(pull)}\n${KIND_LABEL[kind]}: ${humanMs(ms)}${unrecorded}`)}</title></rect>`;
        y -= h;
        return rect;
      }).join('');
    })
    .join('');
  const { svg: axis } = evoValueAxis(t0, t1, maxY, plotH, (v) => `${minuteTick(v)}m`);
  return evoPanel(pulls, t0, t1, maxLines, plotH, axis, bars);
}

/** One value per pull request, as a bar — used for cycle time, rounds and the red-round rate. `maxY` is shared across every zoom tab, like `evoHarness`'s. */
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
    harnessMaxY: Math.max(60_000, ...pulls.map((pull) => LANES.reduce((sum, lane) => sum + (laneMs(pull, lane) ?? 0), 0))),
    cycleMaxY: Math.max(60_000, ...pulls.map((pull) => pull.totalMs)),
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

  const legend = `<div class="legend grouped">${groupedKeys(LANES, (id) => KIND_LABEL[id])}</div>
    <p class="sectionnote">A pull request with no session record has no local lanes; hover its bar and it says <em>not recorded</em>, which is not zero.</p>`;

  const rounds = (pull) => pull.rounds.length;
  const redShare = (pull) => (pull.rounds.length ? pull.rounds.filter((round) => round.red).length / pull.rounds.length : 0);

  return `<div class="card pad">
    <h3>Where the harness minutes go</h3>
    ${legend}
    ${evoHarness(sorted, t0, t1, scales.maxLines, scales.harnessMaxY)}
    <h3>Start to merge</h3>
    ${evoBar(sorted, t0, t1, scales.maxLines, {
      cls: 'cycle',
      maxY: scales.cycleMaxY,
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
  // A feature branch landing repeats work its units already plotted, so it is not a point here.
  const measured = model.pulls.filter((pull) => !pull.landing);
  const pullsFor = (preset) =>
    preset.id === 'all' ? measured : measured.filter((pull) => Date.parse(pull.mergedAt) >= now - Number(preset.id) * 86_400_000);
  const scales = evoScales(measured);

  const inputs = EVO_ZOOM.map(
    (preset, index) =>
      `<input type="radio" name="evozoom" id="evozoom-${preset.id}" class="tabradio"${index === 0 ? ' checked' : ''}><label for="evozoom-${preset.id}" class="tablabel">${esc(preset.label)}</label>`,
  ).join('');
  const panels = EVO_ZOOM.map((preset) => `<div class="tabpanel" id="evopanel-${preset.id}">${evolution(pullsFor(preset), scales)}</div>`).join('');
  return `<div class="tabs">${inputs}${panels}</div>`;
}

/**
 * The widths, in the em of a round's own 11px type, at which a CI Round has room for its short
 * name ("CI 1") and its long one ("CI Round 1"). Each is for one digit and no mark, and grows by
 * `PER_DIGIT` for every digit more in the number and `PER_MARK` for every mark beside the name.
 */
const LABEL_FITS = { short: 2.6, long: 6, perDigit: 0.6, perMark: 1.9 };

/**
 * What the stylesheet cannot say for itself, written out for the rounds this page has:
 * - which label a CI Round shows at the width it has, closed or zoomed, as container queries on the round (below the short form's width it shows only its mark, or nothing);
 * - which detail a strip shows, one rule per detail naming every radio that shows it, scoped to the strip the radios are in so a pull request with the same rounds is left alone.
 * @param {{ id: string, radios: string[] }[]} details every detail on the page
 */
function generatedStyles(details) {
  const em = (value) => `${Math.round(value * 10) / 10}em`;
  const labelRules = [];
  for (let digits = 1; digits <= 3; digits += 1) {
    for (let marks = 0; marks <= 2; marks += 1) {
      const own = `.seg.round.d${digits}.m${marks}`;
      const extra = LABEL_FITS.perDigit * (digits - 1) + LABEL_FITS.perMark * marks;
      labelRules.push(
        `@container (min-width: ${em(LABEL_FITS.short + extra)}) { ${own} .cishort { display: inline; } }`,
        `@container (min-width: ${em(LABEL_FITS.long + extra)}) { ${own} .cishort { display: none; } ${own} .cilong { display: inline; } }`,
      );
    }
  }
  const picked = (radios) => (radios.length === 1 ? `#${radios[0]}` : `:is(${radios.map((radio) => `#${radio}`).join(', ')})`);
  const shown = details.map((detail) => `.strip:has(${picked(detail.radios)}:checked) #${detail.id} { display: block; }`);
  return `${labelRules.join('\n')}\n${shown.join('\n')}`;
}

/**
 * @param {object} model the model buildModel produced
 * @returns {string} a complete HTML document
 */
export function renderHtml(model) {
  // The strips come first: the styles name the radios and details they write.
  const pickers = [];
  const stripsHtml = strips(model, pickers);
  const styles = `${readFileSync(path.join(here, 'styles.css'), 'utf8')}\n${generatedStyles(pickers.flatMap((pick) => pick.details()))}`;
  const commitUrl = model.commit ? `https://github.com/${model.repo}/commit/${model.commit}` : null;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Cockpit Cycle Time</title>
<style>${styles}</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <p class="eyebrow">Cockpit &middot; ${esc(model.branch)}</p>
    <h1>Cycle time</h1>
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
  <p class="sectionnote">Minutes spent writing and fixing against minutes spent in the harness, the rounds plus local review, test runs and the browser pass. A dot&rsquo;s size is the lines its pull request changed (additions plus deletions, the figure the Evolution size lane uses) and its shade is its CI rounds, blue for one round to red for five or more. Every pull request pays a fixed harness cost, so a small change sits above the dashed line whatever it did; read the minutes beside the ratio. No line is drawn as healthy, since there is no accepted benchmark for this ratio: the reference is the window&rsquo;s own median.</p>
  ${balance(model)}

  <h2>Each pull request, start to merge</h2>
  ${stripsHtml}

  <footer>
    Generated by <code>tools/cycle-time</code> from the pull request and Actions APIs and each pull request&rsquo;s session record.
  </footer>

</div>
</body>
</html>
`;
}
