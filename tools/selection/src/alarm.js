/**
 * The alarm, decided: what the nightly job files, edits and comments on, from
 * the model's bars and the repository's alarm issues. Pure - no I/O and no
 * clock of its own (the night is the model's `generatedAt`) - so every rule is
 * a test over plain objects; issues.js is the only file that reaches GitHub.
 *
 * **One alarm per crossed bar**, found again by the marker line in its body.
 *
 *   - crossed, no open alarm      -> file one (linking the newest closed one, if any)
 *   - crossed, an open alarm      -> replace its body with the night's figures, keeping when it first crossed
 *   - crossed, several open       -> edit the newest; the older ones get one comment naming it
 *   - within, an open alarm       -> one comment saying so; the issue stays open
 *   - unread                      -> nothing: no reading is no news
 *
 * Nothing is closed or reopened: a person closes an alarm, and a bar that
 * crosses after that gets a new issue.
 */

import { adviceFor } from './render/advice.js';

export const ALARM_LABEL = 'selection-alarm';

const DAY_MS = 86_400_000;
const MAX_LISTED = 10;
const WORST_PATHS = 3;

/** The tier whose rules a forced-full bar is read against, in `forcedFullRules`' own words. */
const TIER_OF = { 'e2e-forced-full': 'E2E', 'test-forced-full': 'Vitest' };

const MARKER = /<!--\s*selection-alarm bar=([\w-]+) first=(\d{4}-\d{2}-\d{2}) last=(\d{4}-\d{2}-\d{2})\s*-->/;
const WITHIN = /<!--\s*selection-alarm-within bar=([\w-]+) since=(\d{4}-\d{2}-\d{2})\s*-->/;
const DUPLICATE = /<!--\s*selection-alarm-duplicate of=(\d+)\s*-->/;

/** The line that makes an issue findable as this bar's alarm, and remembers when it first and last crossed. */
const markerLine = (bar, first, last) => `<!-- selection-alarm bar=${bar} first=${first} last=${last} -->`;

/** `{ bar, first, last }` from an alarm's body, or null for an issue that carries no marker. */
export function parseMarker(body) {
  const match = String(body ?? '').match(MARKER);
  return match ? { bar: match[1], first: match[2], last: match[3] } : null;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const percent = (value) => `${Math.round(value * 100)}%`;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The newest open alarm per bar, as the number the page links. An alarm
 * closed by a person is no longer the bar's alarm; the next crossing files a
 * new one.
 *
 * @param {{ number: number, state: string, body: string }[]} alarms
 * @returns {Map<string, number>}
 */
export function openAlarmNumbers(alarms) {
  const byBar = new Map();
  for (const alarm of alarms) {
    const marker = alarm.state === 'open' ? parseMarker(alarm.body) : null;
    if (marker && !(byBar.get(marker.bar) > alarm.number)) byBar.set(marker.bar, alarm.number);
  }
  return byBar;
}

/** A bar's figure in one clause: what it was and what it is read against. */
function figureText(bar) {
  if (bar.id === 'misses') return `${plural(bar.count, 'miss', 'misses')}, bar: any miss`;
  if (bar.id === 'most-selected') {
    return `\`${bar.path}\` selected on ${bar.count} of ${bar.of} pull requests that could have skipped it (${percent(bar.value)}), bar ${percent(bar.threshold)}, over at least ${bar.minOver}`;
  }
  return `${bar.name}: ${bar.count} of ${bar.of} pull requests (${percent(bar.value)}), bar ${percent(bar.threshold)}`;
}

function titleOf(bar) {
  if (bar.id === 'misses') return `Selection: ${plural(bar.count, 'miss', 'misses')} in the ${bar.windowDays}-day window`;
  if (bar.id === 'most-selected') return `Selection: ${bar.path} selected on ${percent(bar.value)} of the pull requests that could have skipped it`;
  return `Selection: ${bar.name} on ${percent(bar.value)} of pull requests`;
}

/** The misses inside the bar's window, one line per file and pull request, capped. */
function missLines(model) {
  const since = Date.parse(model.generatedAt) - model.bars.windowDays * DAY_MS;
  const inWindow = model.misses.filter((miss) => {
    const merged = Date.parse(miss.pull.mergedAt);
    return Number.isFinite(merged) && merged >= since;
  });
  const lines = inWindow.slice(0, MAX_LISTED).map((miss) => `  - \`${miss.path}\` (${miss.level}${miss.reason ? `, ${miss.reason}` : ''}), missed on #${miss.pull.number} ${miss.pull.title}`);
  if (inWindow.length > MAX_LISTED) lines.push(`  - ... ${inWindow.length - MAX_LISTED} more`);
  return lines;
}

function causeLines(model, bar) {
  if (bar.id === 'misses') return ['- **Missed files**', ...missLines(model)];
  if (bar.id === 'most-selected') return [`- **Cause** \`${bar.path}\` is the test file or spec selected most often in the window.`];

  const tier = TIER_OF[bar.id];
  if (!bar.cause) return ['- **Cause** no single rule leads: the pull requests that ran everything were forced by different ones.'];
  const rule = model.forcedFullRules.find((row) => row.tier === tier && row.rule === bar.cause.rule);
  const worst = (rule?.paths ?? []).slice(0, WORST_PATHS).map((each) => `\`${each.path}\` (${each.count})`);
  return [
    `- **Cause** the leading rule, "${bar.cause.rule}", forced ${bar.cause.count} of the ${bar.count}.${worst.length > 0 ? ` Worst paths: ${worst.join(', ')}.` : ''}`,
    `- **The rule's advice** ${adviceFor(tier, bar.cause.rule)}`,
  ];
}

/** Where the page lives, from the repository's own name. */
const pageUrl = (repo) => {
  const [owner, name] = String(repo).split('/');
  return `https://${owner}.github.io/${name}/selection/`;
};

function bodyOf({ model, bar, first, closed }) {
  const night = day(Date.parse(model.generatedAt));
  const since = day(Date.parse(model.generatedAt) - bar.windowDays * DAY_MS);
  const covered = model.bars.partial ? ` (only ${Math.round(model.bars.actualDays * 10) / 10} of ${bar.windowDays} days covered)` : '';
  return [
    markerLine(bar.id, first, night),
    '',
    `- **Bar crossed** ${figureText(bar)}, window ${since} to ${night}${covered}.`,
    ...causeLines(model, bar),
    `- **First crossed** ${first}.`,
    `- **Last updated** ${night} by the nightly Selection job; the figures above are that night's.`,
    `- **Read it at** ${pageUrl(model.repo)}`,
    ...(closed ? [`- **Follows** #${closed.number}, closed: this bar crossed again after it.`] : []),
    '',
    'Filed by the nightly Selection job. It is a pointer, not a brief: scope it before building.',
    '',
  ].join('\n');
}

/** Whether this open alarm already carries the comment saying its bar is within, for the recovery that is current: one newer than the last night the bar was crossed. */
function saidWithin(alarm, marker) {
  return alarm.comments.some((comment) => {
    const within = String(comment).match(WITHIN);
    return within && within[1] === marker.bar && within[2] > marker.last;
  });
}

const namedAsDuplicate = (alarm, of) => alarm.comments.some((comment) => Number(String(comment).match(DUPLICATE)?.[1]) === of);

/**
 * @typedef {{ number: number, state: 'open' | 'closed', body: string, comments: string[] }} Alarm
 * @typedef {{ kind: 'create', bar: string, title: string, body: string }
 *   | { kind: 'edit', bar: string, number: number, title: string, body: string }
 *   | { kind: 'comment', bar: string, number: number, body: string }} Action
 *
 * `alarms` are the repository's `selection-alarm` issues in every state, with
 * the comments of the open ones; `model` is the night's. What to do is
 * returned in the order it should be done.
 *
 * @param {{ model: object, alarms: Alarm[] }} input
 * @returns {Action[]}
 */
export function decideAlarms({ model, alarms }) {
  const night = day(Date.parse(model.generatedAt));
  const actions = [];

  for (const item of model.bars.items) {
    const bar = { ...item, windowDays: model.bars.windowDays };
    const mine = alarms.map((alarm) => ({ alarm, marker: parseMarker(alarm.body) })).filter(({ marker }) => marker?.bar === bar.id);
    const newestFirst = (a, b) => b.alarm.number - a.alarm.number;
    const open = mine.filter(({ alarm }) => alarm.state === 'open').sort(newestFirst);
    const closed = mine.filter(({ alarm }) => alarm.state === 'closed').sort(newestFirst);

    if (bar.verdict === 'crossed') {
      if (open.length === 0) {
        actions.push({ kind: 'create', bar: bar.id, title: titleOf(bar), body: bodyOf({ model, bar, first: night, closed: closed[0]?.alarm ?? null }) });
        continue;
      }
      const [current, ...older] = open;
      actions.push({ kind: 'edit', bar: bar.id, number: current.alarm.number, title: titleOf(bar), body: bodyOf({ model, bar, first: current.marker.first }) });
      for (const { alarm } of older) {
        if (namedAsDuplicate(alarm, current.alarm.number)) continue;
        actions.push({
          kind: 'comment',
          bar: bar.id,
          number: alarm.number,
          body: `<!-- selection-alarm-duplicate of=${current.alarm.number} -->\nAnother open alarm, #${current.alarm.number}, carries this bar, and the nightly job updates that one. This one can be closed as a duplicate.`,
        });
      }
    } else if (bar.verdict === 'within') {
      for (const { alarm, marker } of open) {
        if (saidWithin(alarm, marker)) continue;
        actions.push({
          kind: 'comment',
          bar: bar.id,
          number: alarm.number,
          body: `<!-- selection-alarm-within bar=${bar.id} since=${night} -->\nThe bar is within since the night of ${night}: ${figureText(bar)}. Left open for a person to close; the nightly job closes nothing.`,
        });
      }
    }
  }
  return actions;
}
