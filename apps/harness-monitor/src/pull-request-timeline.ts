/**
 * A pull request's timeline on its page: the strip the static page draws for each pull request
 * (tools/cycle-time/src/render/html.js), ported with the same markup, controls and wording, in the
 * Monitor's own palette and date module. The layout it draws is src/pull-request-strip.ts.
 *
 * Zooming the strip and reading an element are CSS only, so they make no request: the strip is the
 * label of a checkbox that shows its zoomed form, and each element of the zoomed form carries a radio
 * laid over it whose checked state shows its detail under the axis. Every class starts `tl-`, since
 * the Monitor's other pages already use `track`, `key`, `legend` and `swatch` for other things.
 */

import { belgianDay, formatClock, formatClockMinutes, formatDateTime, formatDayMonth } from './belgium';
import { esc } from './look';
import {
  AWAY_MS,
  axisFor,
  fitTo,
  partsOf,
  scaleFor,
  type Fitted,
  type LocalLane,
  type PlacedLane,
  type PlacedPart,
  type SliceKind,
  type StripPull,
  type StripRound,
} from './pull-request-strip';
import type { TimelineLane } from './cycle-time';

/** What a lane or a slice says of its place in a row, whichever kind it is. */
type AnyLane = { offsetMs: number; ms: number; leadMs?: number; row: number };

/**
 * Every kind of time a strip draws, and which side it is on: `local` is work on the developer's machine and `ci`
 * is the harness's. One colour each (STYLE below), so a later local kind joins here and in the stylesheet.
 */
const KIND_GROUPS = [
  { id: 'local', label: 'Local' },
  { id: 'ci', label: 'CI' },
] as const;
const KIND = {
  coding: { group: 'local', label: 'Coding before the first push', key: 'coding before the first push' },
  fixing: { group: 'local', label: 'Fixing between rounds', key: 'fixing between rounds' },
  'code-review': { group: 'local', label: 'Local code review', key: 'code review' },
  'security-review': { group: 'local', label: 'Local security review', key: 'security review' },
  test: { group: 'local', label: 'Local test run', key: 'test run' },
  browser: { group: 'local', label: 'Browser pass', key: 'browser pass' },
  checks: { group: 'ci', label: 'Tests and checks', key: 'held by tests and checks' },
} as const;
type Kind = keyof typeof KIND;

/** A duration as the static page words it: seconds under a minute, minutes and seconds under an hour, else hours and minutes. */
export function humanMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Every moment is Belgian time in Belgian format (src/belgium.ts). */
const stamp = (iso: string) => formatDateTime(Date.parse(iso));
/** A job's own start and stop are to the second, which the minute a push is stamped to cannot tell apart. */
const clock = (iso: string) => formatClock(Date.parse(iso));

/**
 * Every check that held the round, in the order it did, each named once even where a re-run repeats it:
 * "held by Test, then claude-review", never just the last of the two.
 */
function heldBy(round: StripRound): string {
  const names: string[] = [];
  for (const held of round.held) if (names[names.length - 1] !== held.name) names.push(held.name);
  return names.join(', then ');
}

/** What a round says about itself, in words, for the title on its segment and its detail under the axis. */
function roundText(round: StripRound, index: number): string {
  const parts = [`CI Round ${index}`, humanMs(round.ms), `pushed ${stamp(round.pushedAt)}`];
  if (round.held.length) parts.push(`held by ${heldBy(round)}`);
  if (round.red) parts.push(`RED: ${round.failed.join(', ')} failed`);
  if (round.flukes.length) parts.push(`FLUKE: ${round.flukes.map((fluke) => `${fluke.name} failed and passed on re-run, +${humanMs(fluke.ms)}`).join('; ')}`);
  if (!Array.isArray(round.lanes)) parts.push('lanes not recorded: its job list could not be read, or no job of it ran on a runner, so it is drawn as one block');
  return parts.join(' · ');
}

/** Which round a job ran in, said under the job: the round's name and when it was pushed. What held the round is left out, since beneath one job it would read as that job's story. */
const roundContext = (round: StripRound, index: number) => `CI Round ${index} · pushed ${stamp(round.pushedAt)}`;

const OUTCOME_WORD: Record<string, string> = { pass: 'passed', fail: 'failed', cancelled: 'cancelled', skipped: 'skipped', running: 'still running', other: 'neither passed nor failed', unknown: 'ended in a conclusion not recognised' };

/** What a job lane says of itself: when it started and stopped (Belgian time, to the second), the wait for a runner before it, and how it ended. */
function laneText(lane: TimelineLane): string {
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
const heldText = (held: StripRound['held'][number]) => `${KIND.checks.label} (${held.name}) · held it ${humanMs(held.ms)}${held.rerun ? ' · re-run' : ''}`;

/** A local slice in words: its kind, level (a review) and duration, and the scope of a test run. */
function sliceText(slice: { kind: SliceKind; level?: string; scopes?: string[]; endedTogether?: true; sliceMs?: number; ms?: number }): string {
  return [
    KIND[slice.kind].label,
    slice.level,
    humanMs(slice.sliceMs ?? slice.ms ?? 0),
    slice.scopes ? slice.scopes.join(', ') : null,
    slice.endedTogether ? 'ended together with the other review, so its own length is not recorded' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const PART_TITLE = {
  coding: (part: PlacedPart, pull: StripPull) =>
    pull.recorded ? `Coding before the first push · ${humanMs(part.ms)}` : `From the first commit to the first push · ${humanMs(part.ms)} · no session record, so any coding before the first commit is not recorded`,
  fixing: (part: PlacedPart) => `Fixing before the next push · ${humanMs(part.ms)}`,
  wait: (part: PlacedPart) => `Waiting to merge · ${humanMs(part.ms)}`,
  away: (part: PlacedPart) => `Away for ${humanMs(part.ms)} · a gap of over ${humanMs(AWAY_MS)} is drawn off the time scale`,
};

/**
 * The elements of the zoomed strip the reader can pick. Each gets a radio laid over it on the strip, and the page
 * carries a detail for it under the axis that the styles show while the radio is checked, so there is no script.
 * The radios share a name, so the strip holds one pick. Radios that say the same (a round's background and its
 * two names, a job's lead and its lane) show one detail, written once. The closed strip has none: it only zooms.
 */
interface Picker {
  details(): { id: string; html: string; radios: string[] }[];
  add(label: string, detailHtml: string): string;
}

function picker(number: number): Picker {
  const name = `pick-${number}`;
  const details = new Map<string, { id: string; html: string; radios: string[] }>();
  let radios = 0;
  return {
    details: () => [...details.values()],
    add(label, detailHtml) {
      radios += 1;
      const id = `r${number}-${radios}`;
      const detail = details.get(detailHtml) ?? { id: `d${number}-${radios}`, html: detailHtml, radios: [] };
      detail.radios.push(id);
      details.set(detailHtml, detail);
      return `<input type="radio" class="tl-pick" name="${name}" id="${id}" aria-label="${esc(label)}">`;
    },
  };
}

/** A detail: the first piece of what the element says as its heading, the rest as the line under it, then any extra markup. */
function detailOf(text: string, extra = ''): string {
  const [head, ...rest] = text.split(' · ');
  return `<p class="tl-dhead">${esc(head!)}</p>${rest.length ? `<p class="tl-dline">${esc(rest.join(' · '))}</p>` : ''}${extra}`;
}

/** The box under the axis: the summary line and what to click until something is picked, then the detail of the pick. */
function detailBox(pick: Picker, summary: string): string {
  const shown = pick
    .details()
    .map((detail) => `<div class="tl-detail" id="${detail.id}">${detail.html}</div>`)
    .join('');
  return `<div class="tl-detailbox"><p class="tl-hint">${summary} &middot; click a phase, a CI job or a local run on the strip to read it here.</p>${shown}</div>`;
}

/** The CSS flex-grow for a duration: proportional to its seconds, floored at 1 so nothing vanishes to zero width. */
const growOf = (ms: number) => Math.max(1, Math.round(ms / 1000));

/**
 * A round drawn as the checks that actually held it, in the order they finished, never as one colour for the whole
 * span. Each piece is sized to the share of the round it held, so a piece of the same colour beside another of the
 * same colour reads as one stretch. `visibleMs`, when the round itself was clipped to the scale's edge, is how much
 * of it is shown: the pieces are trimmed to that budget the same way `fitTo` trims the parts around it.
 */
function roundPieces(round: StripRound, visibleMs = round.ms): string {
  const shown: StripRound['held'] = [];
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
  return shown.map((held) => `<span class="tl-piece" style="flex:${growOf(held.ms)} 1 0" title="${esc(heldText(held))}"></span>`).join('');
}

/**
 * Where a part sits in its strip: at its own time and its own length of the scale, never pushed by a neighbour.
 * `--span` is the track less its breaks, so the time on the scale fills what is left; a break is `--tl-break` wide,
 * its stripes inset 2px either side.
 */
function placeStyle(part: PlacedPart, scaleMs: number): string {
  const left = `calc(var(--span) * ${(part.startMs / scaleMs).toFixed(5)} + var(--tl-break) * ${part.breaksBefore}${part.type === 'away' ? ' + 2px' : ''})`;
  return part.type === 'away' ? `left:${left}` : `left:${left};width:calc(var(--span) * ${(part.ms / scaleMs).toFixed(5)})`;
}

/** The lanes of a parallel stretch or a round that fall inside it, once it is cut at the scale's edge. */
const visibleLanes = <T extends AnyLane>(part: { ms: number; lanes?: T[] | null }): T[] => (part.lanes ?? []).filter((lane) => lane.offsetMs - (lane.leadMs ?? 0) < part.ms);

/**
 * A round's jobs, each at its own start and stop inside the round, its wait for a runner a lead before it in the same
 * row. Positions are shares of the round's own width, so they stay true wherever the round is placed. On the zoomed
 * strip (`pick`) each lane and lead carries the radio that picks its job.
 */
function laneSpans(part: PlacedPart, pick: Picker | null): string {
  const share = (ms: number) => (part.ms > 0 ? (ms / part.ms) * 100 : 0).toFixed(3);
  const round = part.round!;
  const index = part.index!;
  return visibleLanes(part as { ms: number; lanes: PlacedLane[] })
    .map((lane) => {
      const title = esc(laneText(lane));
      const top = `top:${lane.row * 100}%`;
      const radio = () => (pick ? pick.add(laneText(lane), detailOf(laneText(lane), `<p class="tl-dctx">in ${esc(roundContext(round, index))}</p>`)) : '');
      const lead = lane.leadMs > 0 ? `<span class="tl-lane tl-lead" style="left:${share(lane.offsetMs - lane.leadMs)}%;width:${share(Math.min(lane.leadMs, part.ms - (lane.offsetMs - lane.leadMs)))}%;${top}" title="${title}">${radio()}</span>` : '';
      if (lane.offsetMs >= part.ms) return lead;
      const classes = ['tl-lane', 'tl-job', lane.outcome === 'fail' ? 'failed' : '', lane.rerun ? 'rerun' : '', lane.outcome === 'running' ? 'running' : ''].filter(Boolean).join(' ');
      return `${lead}<span class="${classes}" style="left:${share(lane.offsetMs)}%;width:${share(Math.min(lane.ms, part.ms - lane.offsetMs))}%;${top}" title="${title}">${radio()}</span>`;
    })
    .join('');
}

/** A part of the strip. On the zoomed strip (`pick`) each element in it, and the part itself, carries the radio that picks it. */
function segment(part: PlacedPart, pull: StripPull, scaleMs: number, pick: Picker | null): string {
  const place = placeStyle(part, scaleMs);
  const radio = (text: string, extra = '') => (pick ? pick.add(text, detailOf(text, extra)) : '');
  const cut = part.cut ? ' cut' : '';
  if (part.type === 'away') return `<span class="tl-seg away" style="${place}" title="${esc(PART_TITLE.away(part))}"><span class="sr-only">away ${esc(humanMs(part.ms))}</span>${radio(PART_TITLE.away(part))}</span>`;

  if (part.type === 'round') {
    const round = part.round!;
    const index = part.index!;
    const marked = [round.red ? '<i class="tl-mark red" aria-hidden="true">✕</i>' : '', round.flukes.length ? '<i class="tl-mark fluke" aria-hidden="true">↻</i>' : ''].filter(Boolean);
    // Every job its own lane where they are recorded; the block, split by what held the round, where they are not.
    const drawn = part.lanes ? laneSpans(part, pick) : roundPieces(round, part.cut ? part.ms : undefined);
    // The round's own detail is its line with every job's line beneath it. Its background and both of its names pick it.
    const roundRadio = () => radio(roundText(round, index), jobList(round));
    // Named by the width it has on screen, which only the browser knows: the long form, the short, or only its mark.
    const label = `<span class="tl-roundlabel" aria-hidden="true">${marked.join('')}<span class="tl-cilong">CI Round ${index}${roundRadio()}</span><span class="tl-cishort">CI ${index}${roundRadio()}</span></span>`;
    const size = `d${Math.min(3, String(index).length)} m${marked.length}`;
    return `<span class="tl-seg round${part.lanes ? ' withlanes' : ''}${round.red ? ' red' : ''} ${size}${cut}" style="${place}" title="${esc(roundText(round, index))}">${roundRadio()}${drawn}${label}</span>`;
  }

  if (part.type === 'review' || part.type === 'test' || part.type === 'browser') {
    return `<span class="tl-seg local ${part.kind}${cut}" style="${place}" title="${esc(sliceText(part as { kind: SliceKind; sliceMs?: number }))}">${radio(sliceText(part as { kind: SliceKind; sliceMs?: number }))}</span>`;
  }

  // Local work in parallel: packed into rows, the busiest on the strip's line, the others stacked off it, each where its own work sits in the stretch. The line shows the coding or fixing where no piece of it runs.
  if (part.type === 'parallel') {
    const lanesHtml = visibleLanes(part as { ms: number; lanes: LocalLane[] })
      .map((lane) => {
        const left = (lane.offsetMs / part.ms) * 100;
        const width = (Math.min(lane.ms, part.ms - lane.offsetMs) / part.ms) * 100;
        return `<span class="tl-lane ${lane.kind}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;top:${lane.row * 100}%" title="${esc(sliceText(lane))}">${radio(sliceText(lane))}</span>`;
      })
      .join('');
    return `<span class="tl-seg parallel ${part.base}${cut}" style="${place}">${radio(`${PART_TITLE[part.base!](part, pull)} around the local work`)}${lanesHtml}</span>`;
  }

  const unrecorded = part.type === 'coding' && !pull.recorded ? ' unrecorded' : '';
  return `<span class="tl-seg ${part.type}${unrecorded}${cut}" style="${place}" title="${esc(PART_TITLE[part.type](part, pull))}">${radio(PART_TITLE[part.type](part, pull))}</span>`;
}

/** The track's width less its breaks: what the time on the scale is drawn across. */
const spanOf = (fitted: Fitted) => (fitted.breaks ? `calc(100% - var(--tl-break) * ${fitted.breaks})` : '100%');

/** The strip's track, its parts placed against `scaleMs`; the shared scale closed, and the pull request's own when zoomed (`pick`, whose radios it carries). */
function track(pull: StripPull, fitted: Fitted, scaleMs: number, pick: Picker | null = null): string {
  const scale = Math.max(1, scaleMs);
  const cap = fitted.clipped ? '<span class="tl-clipmark" aria-hidden="true">&#9656;</span>' : '';
  // The track makes room above and below for the stack of lanes standing off its line.
  const rows = fitted.parts.filter((part) => part.type === 'parallel' || part.type === 'round').flatMap((part) => visibleLanes(part as { ms: number; lanes: AnyLane[] }).map((lane) => lane.row));
  const above = Math.max(0, ...rows.map((row) => -row));
  const below = Math.max(0, ...rows);
  const vars = [`--span:${spanOf(fitted)}`, above + below > 0 ? `--above:${above};--below:${below}` : ''].filter(Boolean).join(';');
  return `<span class="tl-track${above + below > 0 ? ' stacked' : ''}" style="${vars}">${fitted.parts.map((part) => segment(part, pull, scale, pick)).join('')}${cap}</span>`;
}

/** A clock time on the axis in Belgian time: the hour and minute, with the day too where it is not the strip's first. */
function clockLabel(atMs: number, startedAt: number): string {
  return belgianDay(atMs) === belgianDay(startedAt) ? formatClockMinutes(atMs) : `${formatDayMonth(atMs)} ${formatClockMinutes(atMs)}`;
}

/** The zoomed strip's axis, in the clock time of the pull request, from its start to its merge. Time away has none of its own. */
function axis(pull: StripPull, zoomed: Fitted): string {
  const startedAt = Date.parse(pull.rounds[0]!.pushedAt) - pull.beforeFirstPushMs;
  const scale = Math.max(1, zoomed.shownMs);
  const ticks = axisFor(startedAt, zoomed)
    .map((tick) => `<span class="tl-clocktick ${tick.align}" style="left:calc(var(--span) * ${(tick.startMs / scale).toFixed(5)} + var(--tl-break) * ${tick.breaksBefore})">${clockLabel(tick.atMs, startedAt)}</span>`)
    .join('');
  // A span, as the label it sits in holds phrasing content only; the styles make it a block.
  return `<span class="tl-clockaxis" style="--span:${spanOf(zoomed)}" title="Clock time in Belgian time. Click to close">${ticks}</span>`;
}

/** Under a round's line in its detail, one line per job with when it started and stopped, so the times can be read without hovering. */
function jobList(round: StripRound): string {
  if (!Array.isArray(round.lanes) || round.lanes.length === 0) return '';
  return `<ul class="tl-joblist">${round.lanes.map((lane) => `<li>${esc(laneText(lane))}</li>`).join('')}</ul>`;
}

/**
 * The strip: on the pull request's scale, and when clicked the same pull request zoomed on its own axis above the box
 * where the element picked on it is read. Its picker goes to `pickers`, which the page's styles are written from.
 */
function strip(pull: StripPull, parts: ReturnType<typeof partsOf>, fitted: Fitted, scaleMs: number, summary: string, notes: string, pickers: Picker[]): string {
  if (pull.rounds.length === 0) return '<span class="tl-track"><span class="tl-trackempty">no check ran on it</span></span>';
  const id = `zoom-${pull.number}`;
  const zoomed = fitTo(parts, Infinity);
  const pick = picker(pull.number);
  pickers.push(pick);
  const zoomedTrack = track(pull, zoomed, zoomed.shownMs, pick);
  // A checkbox the strip is the label of: a click toggles it and the page's styles show the other form, with no script.
  // In the zoomed form the axis closes it, and so do the empty rows around the line; an element picked under the pointer does not.
  return `<input type="checkbox" class="tl-zoomtoggle" id="${id}" aria-label="Zoom in on #${pull.number}">
      <label class="tl-striphit whenclosed" for="${id}" title="Click to zoom in on this pull request">${track(pull, fitted, scaleMs)}</label>
      <div class="tl-zoomed">
        <label class="tl-striphit" for="${id}">${zoomedTrack}</label>
        <label class="tl-axishit" for="${id}">${axis(pull, zoomed)}</label>
        ${detailBox(pick, summary)}${notes}
      </div>`;
}

const swatch = (cls: string, text: string) => `<span class="tl-key"><span class="tl-swatch ${cls}"></span>${text}</span>`;

/** The kinds in `ids`, each under its own group's heading, so a reader sees which side of the line it is on before reading what it is. */
function groupedKeys(ids: Kind[], text: (id: Kind) => string): string {
  return KIND_GROUPS.map((group) => ({ group, ids: ids.filter((id) => KIND[id].group === group.id) }))
    .filter(({ ids: own }) => own.length > 0)
    .map(({ group, ids: own }) => `<div class="tl-keygroup ${group.id}"><span class="tl-keyhead">${group.label}</span>${own.map((id) => swatch(id, esc(text(id)))).join('')}</div>`)
    .join('');
}

function legend(): string {
  const text = (id: Kind) => (['code-review', 'security-review', 'test', 'browser'].includes(id) ? `${KIND[id].key} (local, at the time it ran)` : KIND[id].key);
  return `<div class="tl-legend">
    <p class="tl-ciround"><b>CI Round</b>: a push, until the last check on it finishes; a red one failed and was pushed again. Each job of a round is a lane from its own start to its own stop, so jobs that ran together sit in rows above one another.</p>
    ${groupedKeys(['coding', 'fixing', 'code-review', 'security-review', 'test', 'browser', 'checks'], text)}
    <div class="tl-keygroup">
      ${swatch('lead', 'a job waiting for a runner, before its lane')}
      ${swatch('rerun', 're-run of a job')}
      ${swatch('wait', 'waiting to merge')}
      ${swatch('away', `away (over ${humanMs(AWAY_MS)}, off the scale)`)}
      <span class="tl-key"><i class="tl-mark red" aria-hidden="true">✕</i>red round</span>
      <span class="tl-key"><i class="tl-mark fluke" aria-hidden="true">↻</i>fluke: failed, passed on re-run</span>
      ${swatch('unrecorded', 'not recorded: no session record, so its strip starts at the first commit')}
    </div>
  </div>`;
}

/** What the strip is drawn to and how to read it, as the static page words it. */
const scaleNote = (scaleMs: number) =>
  `<p class="tl-sectionnote">The strip is drawn to a scale of up to ${humanMs(scaleMs)}, and every part sits at its own time and length on it; one too short to see is drawn a little wider, over what follows it. Time away is not on it. A CI Round is drawn as the jobs that ran in it, each a lane from its own start to its own stop with its wait for a runner as a dotted lead before it, so jobs that ran at the same time are in rows one above another and a job that waited on another starts where that one ended; hover a lane for when it started and stopped (Belgian time, to the second). A round whose jobs were not read is one block, split into the checks that held it, and says so on hover. A CI Round is named on the strip as far as its width allows. Click the strip to open the pull request on its own scale, uncut, with a clock-time axis (Belgian time); there, hover an element to outline it and click it to read it under the axis, and click the axis, or the empty rows above and below the line, to close it. A local review, test run or browser pass is cut out of the coding or fixing it sat in, at the time it ran; where several run at once they take as few rows as ever run together, each taking the free row that ended last, the busiest row on the line and the others above it, then below, and the minutes they share are counted once. CI is drawn in blue and each kind of local work in a colour of its own, as the key shows.</p>`;

/** The strip's own head: what the pull request is marked with, and its strip with the notes and summary under it. */
function stripRow(pull: StripPull, parts: ReturnType<typeof partsOf>, scaleMs: number, pickers: Picker[], base: { name: string; trunk: boolean; landing: boolean; head: string | null }): string {
  const fitted = fitTo(parts, scaleMs);
  const reds = pull.rounds.filter((round) => round.red).length;
  const flukes = pull.rounds.reduce((total, round) => total + round.flukes.length, 0);
  const tags = [
    base.landing
      ? `<span class="tl-tag landing" title="A feature branch landing: ${esc(base.head ?? '')} into ${esc(base.name)}. Its units were each a pull request into the branch and are counted there, so this one is in no average, median or chart">feature branch landing</span>`
      : '',
    // The trunk is the report's own and needs no mark; any other base is named.
    !base.landing && !base.trunk ? `<span class="tl-tag base" title="Merged into ${esc(base.name)}, not main">into ${esc(base.name)}</span>` : '',
    pull.recorded
      ? ''
      : '<span class="tl-tag unrecorded" title="No session record on this pull request, so its coding, local reviews, test runs and browser pass are not measured and its strip starts at the first commit">not recorded</span>',
    reds ? `<span class="tl-tag red">${reds} red</span>` : '',
    flukes ? `<span class="tl-tag fluke">${plural(flukes, 'fluke')}</span>` : '',
    fitted.clipped ? '<span class="tl-tag clip">clipped</span>' : '',
  ].join('');

  const clipNote = fitted.clipped
    ? `<p class="tl-clipnote whenclosed">Clipped: ${humanMs(fitted.clipped.totalMs)} on the scale in all (time away is not counted), the first ${humanMs(fitted.clipped.shownMs)} shown. The strip ends at the edge of the scale, not at the merge. Click it to see all of it.</p>`
    : '';
  const summary = `${plural(pull.rounds.length, 'CI Round')}${reds ? `, ${reds} red` : ''} &middot; ${humanMs(pull.totalMs)} to merge`;
  const notes = pull.notes.length ? `<p class="tl-clipnote">${esc(pull.notes.join(' '))}</p>` : '';
  // Under a closed strip only the summary line and the notes: the elements are read once it is zoomed.
  const underClosed = pull.rounds.length ? `<p class="tl-clipnote whenclosed">${summary}</p>${notes ? `<div class="whenclosed">${notes}</div>` : ''}` : '';

  return `${tags ? `<div class="tl-when">${tags}</div>` : ''}
    <div class="tl-strip">${strip(pull, parts, fitted, scaleMs, summary, notes, pickers)}<span class="sr-only">${esc(humanMs(pull.totalMs))} to merge, ${plural(pull.rounds.length, 'CI Round')}</span>${clipNote}${underClosed}</div>`;
}

/**
 * The widths, in the em of a round's own 11px type, at which a CI Round has room for its short name ("CI 1") and its
 * long one ("CI Round 1"). Each is for one digit and no mark, and grows by `perDigit` for every digit more in the
 * number and `perMark` for every mark beside the name.
 */
const LABEL_FITS = { short: 2.6, long: 6, perDigit: 0.6, perMark: 1.9 };

/**
 * What the stylesheet cannot say for itself, written out for the rounds this page has:
 * - which label a CI Round shows at the width it has, closed or zoomed, as container queries on the round;
 * - which detail the strip shows, one rule per detail naming every radio that shows it.
 */
function generatedStyles(details: { id: string; radios: string[] }[]): string {
  const em = (value: number) => `${Math.round(value * 10) / 10}em`;
  const labelRules: string[] = [];
  for (let digits = 1; digits <= 3; digits += 1) {
    for (let marks = 0; marks <= 2; marks += 1) {
      const own = `.tl-seg.round.d${digits}.m${marks}`;
      const extra = LABEL_FITS.perDigit * (digits - 1) + LABEL_FITS.perMark * marks;
      labelRules.push(
        `@container (min-width: ${em(LABEL_FITS.short + extra)}) { ${own} .tl-cishort { display: inline; } }`,
        `@container (min-width: ${em(LABEL_FITS.long + extra)}) { ${own} .tl-cishort { display: none; } ${own} .tl-cilong { display: inline; } }`,
      );
    }
  }
  const picked = (radios: string[]) => (radios.length === 1 ? `#${radios[0]}` : `:is(${radios.map((radio) => `#${radio}`).join(', ')})`);
  const shown = details.map((detail) => `.tl-strip:has(${picked(detail.radios)}:checked) #${detail.id} { display: block; }`);
  return `${labelRules.join('\n')}\n${shown.join('\n')}`;
}

/**
 * The strip's stylesheet, in the Monitor's tokens: CI is the blue series, each kind of local work a series colour of its
 * own, red is the page's `--over` and only for what failed. The dark values come with the tokens.
 */
export const TIMELINE_STYLE = `
.tl{--tl-break:30px;--tl-checks:var(--series-6);--tl-on-checks:#0b1220;--tl-coding:var(--series-1);--tl-fixing:color-mix(in srgb,var(--series-1) 50%,var(--well));--tl-code-review:var(--series-4);--tl-security-review:var(--series-3);--tl-test:var(--series-2);--tl-browser:var(--series-5);--tl-wait:color-mix(in srgb,var(--series-grey) 45%,var(--well));--tl-line:color-mix(in srgb,var(--shade) 8%,transparent)}
.tl-sectionnote{font-size:13px;color:var(--ink-faint);max-width:800px}
.tl-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;background:var(--tl-fixing)}
.tl-swatch.coding{background:var(--tl-coding)}.tl-swatch.fixing{background:var(--tl-fixing)}.tl-swatch.checks{background:var(--tl-checks)}
.tl-swatch.code-review{background:var(--tl-code-review)}.tl-swatch.security-review{background:var(--tl-security-review)}.tl-swatch.test{background:var(--tl-test)}.tl-swatch.browser{background:var(--tl-browser)}
.tl-swatch.wait{background:var(--tl-wait)}
.tl-swatch.lead{background:repeating-linear-gradient(90deg,var(--tl-checks) 0 2px,transparent 2px 5px)}
.tl-swatch.rerun{background:var(--tl-checks) repeating-linear-gradient(135deg,transparent 0 3px,rgb(255 255 255 / .45) 3px 5px)}
.tl-swatch.away{background:transparent;border:1px dashed var(--ink-faint)}
.tl-swatch.unrecorded{background:repeating-linear-gradient(135deg,var(--tl-coding) 0 2px,transparent 2px 4px);border:1px solid var(--tl-coding)}
.tl-legend{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ink)}
.tl-key{display:inline-flex;align-items:center}
.tl-keygroup{display:flex;flex-wrap:wrap;align-items:center;gap:4px 18px}
.tl-keyhead{min-width:44px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint)}
.tl-ciround{margin:0;color:var(--ink)}.tl-ciround b{color:var(--ink-strong)}
.tl-when{font-size:12px;color:var(--ink-faint)}
.tl-strip{min-width:0;position:relative}
/* A track is a line of time: each part is placed at its own start and length of it (inline left and width), so none is pushed by another and none is padded. */
.tl-track{display:block;height:22px;background:var(--tl-line);border-radius:4px;position:relative;overflow-x:clip}
/* The track clips only sideways, so a stack of lanes can stand above and below it; its ends are rounded here instead. */
.tl-track>.tl-seg:first-child{border-radius:4px 0 0 4px}
.tl-trackempty{display:block;color:var(--ink-faint);font-size:12px;line-height:22px;padding:0 8px}
/* A part too short to see is drawn at 3px, over the one after it, which still starts at its own time. */
.tl-seg{display:block;min-width:3px;position:absolute;top:0;height:100%}
.tl-seg.local,.tl-seg.parallel,.tl-seg.round{z-index:1}
.tl-track.stacked{margin-top:calc(var(--above) * 22px);margin-bottom:calc(var(--below) * 22px)}
/* Click the strip to zoom in on it, click it again to close: the strip is the label of a checkbox, so no script. */
.tl-zoomtoggle{position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;margin:0}
.tl-striphit{display:block;cursor:zoom-in;user-select:none;border-radius:4px}
.tl-zoomtoggle:focus-visible~.tl-striphit,.tl-striphit:hover{outline:1px solid var(--ink-faint);outline-offset:2px}
.tl-zoomed{display:none}
.tl-zoomtoggle:checked~.tl-zoomed{display:block}
.tl-zoomtoggle:checked~.whenclosed{display:none}
/* The zoomed strip's clock-time axis: the same line of time as the strip above it, ticks at clock times. */
.tl-clockaxis{display:block;position:relative;height:18px;margin-bottom:4px;border-top:1px solid var(--ink-faint);font-size:11px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.tl-clocktick{position:absolute;top:0;padding-top:3px;white-space:nowrap;transform:translateX(-50%)}
.tl-clocktick::before{content:'';position:absolute;top:-4px;left:50%;height:4px;border-left:1px solid var(--ink-faint)}
.tl-clocktick.start{transform:none}.tl-clocktick.start::before{left:0}
.tl-clocktick.end{transform:translateX(-100%)}.tl-clocktick.end::before{left:100%}
.tl-seg.coding{background:var(--tl-coding)}.tl-seg.fixing{background:var(--tl-fixing)}.tl-seg.wait{background:var(--tl-wait)}
/* A round is not one colour: it is the checks that held it, each its own slice, in the order they finished. */
.tl-seg.round{display:flex;align-items:stretch;container-type:inline-size;font-size:11px}
/* A CI Round is named on the strip by the width it has: "CI Round 1", then "CI 1", then only its mark. Which one shows is decided by container queries written out per page. */
.tl-roundlabel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:3px;white-space:nowrap;pointer-events:none;font-weight:600;line-height:1;color:var(--tl-on-checks)}
.tl-cilong,.tl-cishort{display:none}
.tl-seg.round:hover{outline:2px solid var(--ink-strong);outline-offset:-2px;z-index:2}
.tl-piece{display:block;height:100%;min-width:1px;background:var(--tl-checks)}
.tl-seg.local.code-review{background:var(--tl-code-review)}.tl-seg.local.security-review{background:var(--tl-security-review)}.tl-seg.local.test{background:var(--tl-test)}.tl-seg.local.browser{background:var(--tl-browser)}
.tl-seg.parallel.coding{background:var(--tl-coding)}.tl-seg.parallel.fixing{background:var(--tl-fixing)}
.tl-lane{position:absolute;height:100%;min-width:3px}
.tl-lane.code-review{background:var(--tl-code-review)}.tl-lane.security-review{background:var(--tl-security-review)}.tl-lane.test{background:var(--tl-test)}.tl-lane.browser{background:var(--tl-browser)}
/* A round's jobs: a lane per job from its own start to its own stop, its wait for a runner a dotted lead before it. A failed job is ringed, a re-run hatched. */
.tl-lane.tl-job{background:var(--tl-checks)}
.tl-lane.tl-job.failed{box-shadow:inset 0 0 0 2px var(--over)}
.tl-lane.tl-job.rerun{background-image:repeating-linear-gradient(135deg,transparent 0 3px,rgb(255 255 255 / .45) 3px 5px)}
.tl-lane.tl-job.running{opacity:.7}
.tl-lane.tl-lead{background:repeating-linear-gradient(90deg,var(--tl-checks) 0 2px,transparent 2px 5px);opacity:.55}
/* A hairline in the well's colour along the top of every job lane and lead, so stacked rows read as separate bars; a border on the lane, which is border-box, so its width and time do not move. */
.tl-seg.round .tl-lane.tl-job,.tl-seg.round .tl-lane.tl-lead{border-top:1px solid var(--well)}
.tl-seg.round.withlanes .tl-cilong,.tl-seg.round.withlanes .tl-cishort{background:var(--surface);color:var(--ink-strong);padding:0 3px;border-radius:3px}
.tl-joblist{margin:4px 0 0 12px;padding:0;list-style:none;color:var(--ink-faint);font-size:11.5px}
.tl-joblist li{margin:1px 0;padding:0}
/* Picking an element of the zoomed strip. A radio lies over each element (a lane's over its round's, the round's name chip's over both), so a click checks the one under the pointer and never the strip's zoom label around them; the detail whose radio is checked shows under the axis. */
.tl-pick{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1;appearance:none}
.tl-seg.round>.tl-pick{z-index:0}
.tl-lane>.tl-pick{z-index:2}
.tl-roundlabel .tl-pick{z-index:3;pointer-events:auto}
.tl-cilong,.tl-cishort{position:relative}
.tl-zoomed .tl-striphit{cursor:zoom-out;display:flow-root}
.tl-zoomed .tl-striphit:hover{outline:none}
.tl-axishit{display:block;cursor:zoom-out}
.tl-axishit:hover .tl-clockaxis{color:var(--ink-strong);border-top-color:var(--ink-strong)}
/* Hover outlines the element under the pointer and nothing around it: not the round or the parallel stretch a lane is in, nor the round a name chip is on. */
.tl-zoomed .tl-seg:hover,.tl-zoomed .tl-lane:hover{outline:2px solid var(--ink-strong);outline-offset:-2px;z-index:2}
.tl-zoomed .tl-seg.round:hover:has(.tl-lane:hover),.tl-zoomed .tl-seg.parallel:hover:has(.tl-lane:hover){outline:none}
.tl-zoomed .tl-roundlabel:has(.tl-pick:hover) .tl-cilong,.tl-zoomed .tl-roundlabel:has(.tl-pick:hover) .tl-cishort{outline:2px solid var(--ink-strong)}
.tl-zoomed .tl-seg.round:has(.tl-roundlabel .tl-pick:hover){outline:none}
/* The picked element keeps an accent outline while its detail shows; a keyboard focus is a dashed one. */
.tl-zoomed .tl-seg:has(>.tl-pick:checked),.tl-zoomed .tl-lane:has(>.tl-pick:checked){outline:2px solid var(--accent);outline-offset:-2px;z-index:2}
.tl-zoomed .tl-roundlabel:has(.tl-pick:checked) .tl-cilong,.tl-zoomed .tl-roundlabel:has(.tl-pick:checked) .tl-cishort{outline:2px solid var(--accent)}
.tl-zoomed .tl-seg:has(>.tl-pick:focus-visible),.tl-zoomed .tl-lane:has(>.tl-pick:focus-visible),.tl-zoomed .tl-cilong:has(>.tl-pick:focus-visible),.tl-zoomed .tl-cishort:has(>.tl-pick:focus-visible){outline:2px dashed var(--accent);outline-offset:1px}
/* The box under the axis: the summary line and a hint until something is picked, then the detail of the pick. */
.tl-detailbox{margin-top:6px;padding:8px 12px;border:1px solid var(--tl-line);border-left:3px solid var(--accent);border-radius:4px;font-size:12px;color:var(--ink);background:var(--surface)}
.tl-hint{margin:0;color:var(--ink-faint)}
.tl-strip:has(.tl-pick:checked) .tl-hint{display:none}
.tl-detail{display:none}
.tl-dhead{margin:0;color:var(--ink-strong);font-weight:600}
.tl-dline{margin:2px 0 0}
.tl-dctx{margin:4px 0 0;color:var(--ink-faint)}
/* Hatched, so that "not recorded" is a different thing from a coloured stretch, and from nothing. */
.tl-seg.unrecorded{background:repeating-linear-gradient(135deg,var(--tl-coding) 0 3px,transparent 3px 6px);outline:1px solid var(--tl-coding);outline-offset:-1px}
.tl-seg.away{width:calc(var(--tl-break) - 4px);background:repeating-linear-gradient(90deg,transparent 0 3px,var(--ink-faint) 3px 4px);opacity:.7}
.tl-seg.red{box-shadow:inset 0 0 0 2px var(--over)}
.tl-clipmark{position:absolute;z-index:3;top:0;right:0;height:100%;padding:0 5px;color:#fff;background:var(--over);font-size:12px;line-height:22px}
.tl-mark{font-style:normal;font-size:11px;line-height:1;font-weight:700;padding:1px 3px;border-radius:3px;white-space:nowrap;flex:none}
.tl-mark.red{background:var(--over);color:#fff}
.tl-mark.fluke{background:var(--due-soft);color:var(--due-ink);box-shadow:inset 0 0 0 1px var(--due)}
.tl-key .tl-mark{margin-right:6px}
.tl-tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:9px;margin-right:4px;border:1px solid color-mix(in srgb,var(--shade) 18%,transparent);color:var(--ink)}
.tl-tag.red{color:var(--over-ink);border-color:var(--over)}
.tl-tag.fluke{color:var(--due-ink);border-color:var(--due)}
.tl-tag.unrecorded{border-style:dashed;border-color:var(--ink-faint)}
.tl-tag.base{color:var(--ink-strong);border-color:var(--accent)}
.tl-tag.landing{color:var(--ink-strong);border-style:dotted}
.tl-tag.clip{color:var(--ink-strong);border-color:var(--over)}
.tl-clipnote{margin:4px 0 0;font-size:12px;color:var(--ink-faint)}
@media (max-width:640px){.tl{--tl-break:20px}}
`;

/** What a pull request's page needs of its base branch to mark it as the static page does. */
export interface Base {
  name: string;
  trunk: boolean;
  landing: boolean;
  head: string | null;
}

/** The timeline section's body and the stylesheet it needs, written from the rounds this strip has. */
export function renderTimeline(pull: StripPull, base: Base): { html: string; style: string } {
  const parts = partsOf(pull);
  const scaleMs = scaleFor([parts]);
  const pickers: Picker[] = [];
  const row = stripRow(pull, parts, scaleMs, pickers, base);
  return {
    html: `${scaleNote(scaleMs)}${legend()}<div class="tl-row">${row}</div>`,
    style: `${TIMELINE_STYLE}\n${generatedStyles(pickers.flatMap((pick) => pick.details()))}`,
  };
}
