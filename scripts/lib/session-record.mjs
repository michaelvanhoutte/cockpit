//
// What a session did, written down as it happens, and kept on the pull request
// it opens ("Record what a session did, on the pull request it opens", issue
// 514). GitHub sees a change from its first commit, and a session commits just
// before it pushes, so coding time and the local reviews leave no trace there.
//
// Two halves, both pure: the record - an ordered list of phase marks, each
// stamped from the clock - and the block that carries it inside a pull request
// body, replaced in place however often the body is rewritten. The file and
// stdin/stdout around them are `scripts/session-record.mjs`.
//
// **The time comes from the clock, never from the caller.** `markPhase` takes
// no time argument, and a time-shaped word after a phase is refused as extra
// input, so a session cannot back-date or invent a boundary.
//
// **A body with one marker and not the other is refused, not repaired.** With
// half a block there is no telling whether the text after the surviving
// marker is the old block or the session's own prose, and guessing means
// deleting prose.
//

/** Where a phase boundary is marked, in the order a session reaches them. */
export const PHASES = ['start', 'scoped', 'built', 'review-start', 'review-end', 'pushed'];

/**
 * The file a branch's record is kept in, beside the others in the worktree's git directory. Keyed by branch as well as by worktree, because a parent issue starts each child on a fresh branch in the same worktree and a second child must not inherit the first one's marks.
 */
export function recordFileName(branch) {
  return `cockpit-session-record.${encodeURIComponent(branch).replaceAll('%', '_')}.jsonl`;
}

/** The browser pass's two boundaries. Kept apart from `PHASES`, which a report reads as the phases a record can miss. */
export const BROWSER_PHASES = ['browser-start', 'browser-end'];

const MARKS = [...PHASES, ...BROWSER_PHASES];

/** The two phases that name which local review, and at what level, they bound. */
const REVIEW_PHASES = ['review-start', 'review-end'];

export const REVIEW_KINDS = ['code-review', 'security-review'];
export const REVIEW_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const BLOCK_START = '<!-- session-record:start -->';
export const BLOCK_END = '<!-- session-record:end -->';

const HEADING = '### Session record';

const list = (words) => words.map((word) => `\`${word}\``).join(', ');

/**
 * One mark, from the words after `mark` on the command line. A `review-end` may end with how many findings the review reported; a record without one still reads, its count unknown. Throws, naming what it does know, for a phase it does not, a review without its kind and level, a count that is not a whole number, or any word left over - which is where a time would arrive.
 */
export function parseMark(words) {
  const [phase, ...rest] = words;
  if (!MARKS.includes(phase)) {
    throw new Error(`${phase === undefined ? 'No phase given' : `Unknown phase ${JSON.stringify(phase)}`}. The phases are ${list(MARKS)}.`);
  }
  if (!REVIEW_PHASES.includes(phase)) {
    if (rest.length > 0) throw new Error(`${phase} takes nothing after it, and the time comes from the clock - got ${JSON.stringify(rest.join(' '))}.`);
    return { phase };
  }
  const [kind, level, ...more] = rest;
  const counted = phase === 'review-end';
  const [count, ...extra] = counted ? more : [undefined, ...more];
  if (!REVIEW_KINDS.includes(kind)) throw new Error(`${phase} needs the review's kind next: ${list(REVIEW_KINDS)}.`);
  if (!REVIEW_LEVELS.includes(level)) throw new Error(`${phase} ${kind} needs the review's level next: ${list(REVIEW_LEVELS)}.`);
  if (count !== undefined && !/^(0|[1-9]\d*)$/.test(count)) throw new Error(`${phase} ${kind} ${level} takes the number of findings the review reported as a whole number, 0 or more - got ${JSON.stringify(count)}.`);
  if (extra.length > 0) throw new Error(`${phase} takes only a kind and a level${counted ? ' and a finding count' : ''}, and the time comes from the clock - got ${JSON.stringify(extra.join(' '))} after them.`);
  return { phase, kind, level, ...(count === undefined ? {} : { count: Number(count) }) };
}

const time = (text) => (typeof text === 'string' ? Date.parse(text) : Number.NaN);

/** A test run: `{ run: 'test', scopes, start, end }`, written by the runner itself when it finishes. A mark has a `phase`; a run never does. */
export const isRun = (entry) => entry.run !== undefined;

const wellFormed = (entry) =>
  entry !== null &&
  typeof entry === 'object' &&
  !Array.isArray(entry) &&
  (!isRun(entry) ||
    (entry.run === 'test' && Array.isArray(entry.scopes) && entry.scopes.length > 0 && entry.scopes.every((scope) => typeof scope === 'string' && scope !== '') && time(entry.start) <= time(entry.end)));

/**
 * The record as one line per entry, `[]` for text with none - the shape kept on disk. A line that cannot be read (a torn write, a half-written run) is skipped and handed to `onUnreadable`, so one bad line never blocks the body's refresh; by default it is named on stderr.
 */
export function parseRecord(text, onUnreadable = (line) => console.error(`Skipped an unreadable line in the session record: ${line.slice(0, 120)}`)) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = undefined;
    }
    if (wellFormed(entry)) entries.push(entry);
    else onUnreadable(line);
  }
  return entries;
}

export function serialiseRecord(entries) {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

/**
 * The record with one more mark on the end, stamped by `now` - the real clock unless a test hands another. A phase marked again adds an entry rather than replacing one, so two review rounds keep both.
 */
export function markPhase(entries, words, now = () => new Date()) {
  return [...entries, { ...parseMark(words), at: now().toISOString() }];
}

/**
 * One mark as the line the block carries: `- <time> <phase>[ <kind> <level>]`. A review's count rides on its level as `<level>:<count>`, so a reader that knows only four words per line still sees the same phase, kind and level word.
 */
function line({ at, phase, kind, level, count }) {
  return `- ${at} ${[phase, kind, level === undefined ? undefined : count === undefined ? level : `${level}:${count}`].filter(Boolean).join(' ')}`;
}

/** Runs that overlap, or touch, as one interval naming every scope in them - a workspace run's packages in parallel count once. Runs one after the other stay apart, the same suite twice in a row included. */
export function mergeRuns(runs) {
  const merged = [];
  for (const run of [...runs].sort((a, b) => time(a.start) - time(b.start))) {
    const last = merged.at(-1);
    if (last && time(run.start) <= time(last.end)) merged[merged.length - 1] = join(last, run);
    else merged.push({ ...run });
  }
  return merged;
}

/** Two runs as one: the earliest start, the latest end, every scope. */
function join(a, b) {
  return {
    run: 'test',
    scopes: [...new Set([...a.scopes, ...b.scopes])].sort(),
    start: time(b.start) < time(a.start) ? b.start : a.start,
    end: time(b.end) > time(a.end) ? b.end : a.end,
  };
}

/** What the block carries of its runs: one line each, a scope's whitespace and commas made `_` so the line stays three words. */
const runLine = ({ start, end, scopes }) => `- test-run ${start}/${end} ${scopes.map((scope) => scope.replace(/[\s,]/g, '_')).join(',')}`;

/** About 16 KB of a pull request body's 65,536 characters. */
export const BLOCK_BUDGET = 16_000;

/**
 * The block for a record, or `null` where nothing has been recorded - a session that skipped every marker leaves no block, which a report reads as "not recorded". Test runs are merged where they overlap; past `budget` characters the two closest together are merged again, and again, so a long session loses detail rather than runs.
 */
export function renderBlock(entries, budget = BLOCK_BUDGET) {
  if (entries.length === 0) return null;
  const marks = entries.filter((entry) => !isRun(entry));
  let runs = mergeRuns(entries.filter(isRun));
  const build = () => [BLOCK_START, HEADING, '', ...marks.map(line), ...runs.map(runLine), BLOCK_END].join('\n');
  let block = build();
  while (block.length > budget && runs.length > 1) {
    let closest = 0;
    for (let i = 1; i < runs.length - 1; i += 1) {
      if (time(runs[i + 1].start) - time(runs[i].end) < time(runs[closest + 1].start) - time(runs[closest].end)) closest = i;
    }
    runs = [...runs.slice(0, closest), join(runs[closest], runs[closest + 1]), ...runs.slice(closest + 2)];
    block = build();
  }
  return block;
}

/** The test runs a block carries, for a report to read: `[]` where a body has none. Throws where the markers are not a pair. */
export function readRuns(body) {
  const span = blockSpan(body);
  if (span === null) return [];
  return body
    .slice(span.start, span.end)
    .split(/\r?\n/)
    .map((text) => /^- test-run (\S+)\/(\S+) (\S+)$/.exec(text))
    .filter(Boolean)
    .map(([, start, end, scopes]) => ({ run: 'test', scopes: scopes.split(','), start, end }));
}

/** The marks a block carries, for a report to read: `[]` where a body has none. Throws where the markers are not a pair. */
export function readBlock(body) {
  const span = blockSpan(body);
  if (span === null) return [];
  return body
    .slice(span.start, span.end)
    .split(/\r?\n/)
    .map((text) => /^- (\S+) (\S+)(?: (\S+) (\S+))?$/.exec(text))
    .filter(Boolean)
    .map(([, at, phase, kind, level]) => {
      const [word, count] = level === undefined ? [] : level.split(':');
      return { at, phase, ...(kind ? { kind, level: word } : {}), ...(count !== undefined && /^\d+$/.test(count) ? { count: Number(count) } : {}) };
    });
}

/** Where the block sits in a body, `null` where it has none. Throws where exactly one marker is there, or they appear out of order or more than once. */
function blockSpan(body) {
  const starts = occurrences(body, BLOCK_START);
  const ends = occurrences(body, BLOCK_END);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) {
    const missing = starts.length === 0 ? BLOCK_START : ends.length === 0 ? BLOCK_END : null;
    throw new Error(
      missing
        ? `The pull request body has ${missing === BLOCK_START ? BLOCK_END : BLOCK_START} but not ${missing}, so there is no telling what to replace.`
        : `The pull request body has ${starts.length} of ${BLOCK_START} and ${ends.length} of ${BLOCK_END}; there should be one of each, so there is no telling what to replace.`,
    );
  }
  if (ends[0] < starts[0]) throw new Error(`The pull request body has ${BLOCK_END} before ${BLOCK_START}, so there is no telling what to replace.`);
  return { start: starts[0], end: ends[0] + BLOCK_END.length };
}

function occurrences(text, needle) {
  const found = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/**
 * The body with `block` in it: replaced where the body already has one, with the text around it untouched, and added after the existing text where it has none. Applying it twice gives what applying it once does. Where there is no block to place, the body comes back as it was.
 */
export function applyBlock(body, block) {
  if (block === null) return body;
  const span = blockSpan(body);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const text = block.replaceAll('\n', eol);
  if (span !== null) return body.slice(0, span.start) + text + body.slice(span.end);
  const existing = body.trimEnd();
  return existing === '' ? `${text}${eol}` : `${existing}${eol}${eol}${text}${eol}`;
}
