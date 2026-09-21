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

/** The two phases that name which local review, and at what level, they bound. */
const REVIEW_PHASES = ['review-start', 'review-end'];

export const REVIEW_KINDS = ['code-review', 'security-review'];
export const REVIEW_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const BLOCK_START = '<!-- session-record:start -->';
export const BLOCK_END = '<!-- session-record:end -->';

const HEADING = '### Session record';

const list = (words) => words.map((word) => `\`${word}\``).join(', ');

/**
 * One mark, from the words after `mark` on the command line. Throws, naming what it does know, for a phase it does not, a review without its kind and level, or any word left over - which is where a time would arrive.
 */
export function parseMark(words) {
  const [phase, ...rest] = words;
  if (!PHASES.includes(phase)) {
    throw new Error(`${phase === undefined ? 'No phase given' : `Unknown phase ${JSON.stringify(phase)}`}. The phases are ${list(PHASES)}.`);
  }
  if (!REVIEW_PHASES.includes(phase)) {
    if (rest.length > 0) throw new Error(`${phase} takes nothing after it, and the time comes from the clock - got ${JSON.stringify(rest.join(' '))}.`);
    return { phase };
  }
  const [kind, level, ...extra] = rest;
  if (!REVIEW_KINDS.includes(kind)) throw new Error(`${phase} needs the review's kind next: ${list(REVIEW_KINDS)}.`);
  if (!REVIEW_LEVELS.includes(level)) throw new Error(`${phase} ${kind} needs the review's level next: ${list(REVIEW_LEVELS)}.`);
  if (extra.length > 0) throw new Error(`${phase} takes only a kind and a level, and the time comes from the clock - got ${JSON.stringify(extra.join(' '))} after them.`);
  return { phase, kind, level };
}

/** The record as one line per mark, `[]` for text with none - the shape kept on disk. */
export function parseRecord(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
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

/** One mark as the line the block carries: `- <time> <phase>[ <kind> <level>]`. */
function line({ at, phase, kind, level }) {
  return `- ${at} ${[phase, kind, level].filter(Boolean).join(' ')}`;
}

/** The block for a record, or `null` where nothing has been marked - a session that skipped every marker leaves no block, which a report reads as "not recorded". */
export function renderBlock(entries) {
  if (entries.length === 0) return null;
  return [BLOCK_START, HEADING, '', ...entries.map(line), BLOCK_END].join('\n');
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
    .map(([, at, phase, kind, level]) => ({ at, phase, ...(kind ? { kind, level } : {}) }));
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
